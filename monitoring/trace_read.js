// Auren_Bot/monitoring/trace_read.js
// THE TRACE SUBSTRATE — read a watcher trace, split it into runs, and group its lines into job
// episodes. It may not judge: no threshold, signature or wake policy belongs here (Law 16). Judgment
// lives in trace_monitor.js, formatting in report_formatting.js, flags in command_line_arguments.js.
// Consumers pass the file path explicitly; there is no module-level TRACE_FILE.

'use strict';

const fs = require('fs');
const path = require('path');
// The trace's `12m 46s` stamp formatter, re-exported here for the tools that read episodes (Law 16).
const { relativeTime } = require('./report_formatting');

// The merged fleet stream, exported as a DEFAULT for callers to fall back to (Law 25).
const DEFAULT_TRACE_FILE = require(require('./lens_paths').bot('js_kernel/utils/record_homes')).traceFile('fleet');

// ── Line parsing ─────────────────────────────────────────────────────────────
// Two line shapes share one trace family:
//   per-bot file : [ISO] [Nm Ns] [TAG] 📊 text          (bot = filename)
//   foreman own : [ISO] [FOREMAN] text
// Level markers: ❌ error (⛔ only appears inside message text), ⚠️ warn, 📊 summary; unmarked = infra.
//
// FORWARDED_RE matches a retired third shape, `[Nm Ns] [BotId] [TAG]`, so pre-retirement traces parse.
const FORWARDED_RE = /^\[(\d+)m (\d+)s\] \[(\w+)\]/;
const PERBOT_RE = /^\[[\d\-T:.Z]+\] \[(\d+)m (\d+)s\]/;
// `[FOREMAN]` is the transport tag (who connected, what was relayed); `[FOREMAN_BRAIN]` is the ARBITER
// (planning-token grants). FOREMAN_RE matches both, or a brain line reads as silence (Law 25).
const FOREMAN_RE = /^\[([\d\-T:.Z]+)\] \[(FOREMAN(?:_BRAIN)?)\]/;

// Every unit the foreman itself writes; callers skip by membership so a new tag needs no call-site
// changes (Law 16).
const FOREMAN_UNITS = new Set(['FOREMAN', 'FOREMAN_BRAIN']);

function botFromFilename(file) {
  const m = path.basename(file).match(/^watcher_(.+)\.jsonl$/);
  return m ? m[1] : null;
}

function parseLine(raw, idx, fileBot, atMs = null) {
  // `relSec` is the writing bot's own age; `wallSec` is the run's age (see `stampFleetClock`).
  const line = { raw, idx, bot: null, relSec: null, wallSec: null, atMs, iso: null, level: 'infra' };
  let m;
  // Every persisted line is prefixed with its absolute ISO by watcher._record, captured for all shapes
  // so freshness can be measured against the wall clock.
  const lead = raw[0] === '[' ? raw.slice(1, raw.indexOf(']')) : null;
  if (lead && !Number.isNaN(Date.parse(lead))) line.iso = lead;
  if ((m = raw.match(FORWARDED_RE))) {
    line.relSec = +m[1] * 60 + +m[2];
    line.bot = m[3];
  } else if ((m = raw.match(PERBOT_RE))) {
    line.relSec = +m[1] * 60 + +m[2];
    line.bot = fileBot;
    line.iso = raw.slice(1, raw.indexOf(']'));
  } else if ((m = raw.match(FOREMAN_RE))) {
    line.bot = m[2];
    line.iso = m[1];
  }
  // Level markers prefix the [TAG]; the same emoji inside message TEXT is content, not level.
  if (/❌ \[/.test(raw) || /\] ERROR:/.test(raw)) line.level = 'error';
  else if (/⚠️ \[/.test(raw)) line.level = 'warn';
  else if (raw.includes('📊')) line.level = 'summary';
  return line;
}

// ── READING THE STORY ─────────────────────────────────────────────────────────
// Story files are JSONL, appended and never rewritten, so a crash can only tear the LAST line. A torn
// final line is dropped and announced (Law 25); a bad line elsewhere is a THROW, not a skip (Law 13).
function parseStoryFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = text.split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();   // the trailing newline every append ends with
  const story = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      story.push(JSON.parse(rows[i]));
    } catch (e) {
      if (i === rows.length - 1) {
        process.stderr.write(`⚠ ${path.basename(file)}: the final line did not parse `
          + `— read ${story.length} complete line(s), dropped the last. Any verdict below is PARTIAL.\n`);
        break;
      }
      throw new Error(`${path.basename(file)} line ${i + 1} of ${rows.length} is not a story line `
        + `(${e.message}). Only the last line of this file is allowed to be unparseable.`);
    }
  }
  return story;
}

// readTrace(file) — one story file, parsed into lines; the foreman trace instead merges every per-bot
// file by ISO stamp (Law 16 / Invariant D).
function readTrace(file) {
  if (path.basename(file) === path.basename(DEFAULT_TRACE_FILE)) return readFleetView(file);
  const fileBot = botFromFilename(file);
  return parseStoryFile(file).map((raw, i) => parseLine(raw, i, fileBot));
}

// Every persisted line carries its own ISO stamp, the merge key; a line with no stamp sorts on its
// file's last seen one, so infrastructure chatter is kept in the merge.
// ── THE CAMERA IS A SECOND FLEET AND IT DOES NOT MERGE INTO THE FIRST ──────────────────────────────
// Camera processes share the watcher and filename rule (Law 6) but answer a different question at a
// different rate, so merging them would bury the fleet's story under camera work. Split by FILENAME.
const CAMERA_STREAM_RE = /^watcher_camera_.+\.jsonl$/;

// ── THE DESK IS A THIRD STREAM, KEPT OUT OF THE FLEET VIEW FOR THE SAME REASON AS THE CAMERA ────────
// `watcher_foreman.jsonl` lands in the same directory under the same rule; its lines are desk
// conversations, so it gets its own view, split by FILENAME as CAMERA_STREAM_RE is.
const FOREMAN_STREAM_RE = /^watcher_foreman\.jsonl$/;

// `view` names which stream is wanted as one token, so no flag combination can name an impossible view
// (Law 13).
const STREAM_VIEW = { FLEET: 'fleet', CAMERA: 'camera', FOREMAN: 'foreman' };

function viewOf(file) {
  if (CAMERA_STREAM_RE.test(file)) return STREAM_VIEW.CAMERA;
  if (FOREMAN_STREAM_RE.test(file)) return STREAM_VIEW.FOREMAN;
  return STREAM_VIEW.FLEET;
}

function streamFiles(dir, { view }) {
  if (!Object.values(STREAM_VIEW).includes(view)) {
    throw new Error(`[trace_read] CODING VIOLATION (Law 13): streamFiles was asked for view '${view}', which `
      + `is not one of ${Object.values(STREAM_VIEW).join(' | ')}. An unnamed view would silently return an `
      + 'empty stream, and an empty stream reads as a run that produced nothing rather than as a bad call.');
  }
  // ── AN ABSENT DIRECTORY IS A STATE OF THE WORLD, NOT A BAD CALL ───────────────────────────────────
  // An unnamed `view` is a coding violation (Law 29); a missing directory is an unrun bot, so this
  // returns [] and lets each caller word its own empty stream (Law 16).
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^watcher_.+\.jsonl$/.test(f) && !/_trace\.jsonl$/.test(f))
    .filter(f => viewOf(f) === view)
    .map(f => path.join(dir, f));
}

// mergeStreams(files) — the ISO-stamp merge both views are made of (Law 16).
function mergeStreams(files) {
  const all = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const bot = botFromFilename(f);
    let lastMs = 0;
    for (const raw of parseStoryFile(f)) {
      const lead = raw[0] === '[' ? raw.slice(1, raw.indexOf(']')) : null;
      const ms = lead ? Date.parse(lead) : NaN;
      if (!Number.isNaN(ms)) lastMs = ms;
      all.push({ raw, bot, at: lastMs });
    }
  }
  // sort() in V8 is stable, so lines sharing a millisecond keep the order their own file gave them.
  all.sort((a, b) => a.at - b.at);
  return all.map((r, i) => parseLine(r.raw, i, r.bot, r.at || null));
}

function readFleetView(foremanFile) {
  const dir = path.dirname(foremanFile);
  return mergeStreams([foremanFile, ...streamFiles(dir, { view: STREAM_VIEW.FLEET })
    .filter(f => f !== foremanFile)]);
}

// readCameraView(dir) — every camera process in one ISO-ordered view, nothing from the bots.
function readCameraView(dir) {
  return mergeStreams(streamFiles(dir || path.dirname(DEFAULT_TRACE_FILE), { view: STREAM_VIEW.CAMERA }));
}

// readForemanView(dir) — the desk's own record and nothing else (FOREMAN_STREAM_RE names its file, Law 16).
function readForemanView(dir) {
  return mergeStreams(streamFiles(dir || path.dirname(DEFAULT_TRACE_FILE), { view: STREAM_VIEW.FOREMAN }));
}


// Each 'start' re-bases the bots' relative clocks to [0m 0s]; every signature's state dies at this
// boundary.
// A run begins where its foreman's hub comes up (every start, rollback or continue, raises a new foreman)
// and again at an operator's `start` broadcast.
const RUN_BOUNDARY_RE = /\[FOREMAN\] (?:Broadcast 'start'|Foreman WebSocket server listening)/;

// ── THE FLEET CLOCK, AND WHY THE RELATIVE ONE IS NOT IT ───────────────────────
// `relSec` (`[Nm Ss]`) is the writing bot's own age; bots spawn one at a time, so it cannot share a
// column across bodies. `wallSec` is seconds since the segment's first line, one clock for every body.
// Callers name which they want at each call site (Law 25); a line with no absolute stamp keeps
// `wallSec === null`, never a placed zero (Law 13).
function stampFleetClock(seg) {
  let base = null;
  for (const l of seg) if (l.atMs && (base === null || l.atMs < base)) base = l.atMs;
  for (const l of seg) l.wallSec = (base !== null && l.atMs) ? Math.round((l.atMs - base) / 1000) : null;
  return seg;
}

function segmentRuns(lines) {
  const segments = [[]];
  for (const l of lines) {
    if (RUN_BOUNDARY_RE.test(l.raw)) segments.push([]);
    segments[segments.length - 1].push(l);
  }
  // Stamped per SEGMENT: a `start` re-bases every body's relative clock, so the fleet clock re-bases with it.
  return segments.filter(s => s.length > 0).map(stampFleetClock);
}

// ── Output helpers ───────────────────────────────────────────────────────────
function afterMarker(raw) {
  for (const mark of ['❌ ', '⚠️ ', '📊 ']) {
    const i = raw.indexOf(mark);
    if (i >= 0) return raw.slice(i + mark.length).trim();
  }
  return raw;
}


// ── Story view (context channel, never flags) ────────────────────────────────
// The bot's own narrative, one block per dispatched job: from a dispatcher Claimed to the manager's
// COMPLETE/STUCK/RELEASE. Every line already exists in the trace (Law 5/14).
const STORY_BOARD_HDR = /JOB BOARD: (\d+) job/;
// Matches both rank shapes the board has posted, `[asker/stage]` and the older `P<n>`, since old-shape
// runs are still on disk (Law 25).
const STORY_BOARD_LIST = /\[JOB_BOARD\].*?📊 ((?:\[|P\d+ ).+)$/;
const STORY_CLAIMED = /\[DISPATCHER\].*Claimed (.+?) — dispatching to (\w+)/;
const STORY_MGR_DONE = /\[(\w*MANAGER)\].*\b(COMPLETE|STUCK|RELEASE)\b/;
const STORY_MGR_PLAN = /\[(\w*MANAGER)\] 📊 (.+)$/;
// Greedy (.*) runs to the LAST quote, since a readable can embed its own quotes. Success is matched by
// `(.+?)`, non-greedy over multiple words, because recursive_judge's 'not stated' verdict is two words.
const STORY_JUDGE_FRAG = /Fragment: (\S+) \| Success: (.+?) \| Readable: "(.*)"/;
const STORY_KILL = /stopped an (?:infinite loop|AB)|CODING VIOLATION/;
// ── THE OTHER END OF A JOB ────────────────────────────────────────────────────────────────────────
// The judge routing to job_board IS the release of the seat, closing an episode for one-shot executor
// jobs that have no manager. `ok` stays null: the judge asserts the seat is free, not that work is done.
const STORY_JOB_RELEASED = /\[RECURSIVE_JUDGE\].*Routing to job_board/;

// "[bot/craft] supply/logs (need: 64)" → "supply/logs": strips both the current and the older `P<n>`
// prefix shape (Law 25).
function jobToken(claimed) {
  return claimed
    .replace(/^\[[^\]]*\]\s+/, '')
    .replace(/^P\d+\s+/, '')
    .replace(/\s*\(.*\)\s*$/, '')
    .trim();
}

// Consecutive DOING events with identical text fold into one "…×N".
function collapseEvents(events) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && last.kind === e.kind && last.text === e.text) last.n++;
    else out.push({ ...e, n: 1 });
  }
  return out;
}

function buildEpisodes(seg) {
  const episodes = [];
  const board = new Map();   // bot → { count, list } from its most recent board post
  const open = new Map();    // bot → episode currently accumulating
  // Absolute wall-clock bound, for footage_clipper's video-timeline projection. Advanced per line.
  let curIso = null;
  // The relative half of the same clock (Law 16).
  let curRelSec = null;
  // The fleet half (see stampFleetClock): `relSec` cannot order two bodies' episodes against each other.
  let curWallSec = null;
  const close = (bot, verdict) => {
    const ep = open.get(bot);
    if (!ep) return;
    ep.verdict = verdict;
    ep.endIso = curIso;
    ep.endRelSec = curRelSec;
    ep.endWallSec = curWallSec;
    episodes.push(ep);
    open.delete(bot);
  };
  for (const l of seg) {
    if (l.iso) curIso = l.iso;
    if (l.relSec != null) curRelSec = l.relSec;
    if (l.wallSec != null) curWallSec = l.wallSec;
    // A kill can be logged under either the bot or FOREMAN; attribute to whichever bot has an open episode.
    if (STORY_KILL.test(l.raw) && l.level === 'error') {
      const bot = l.bot && open.has(l.bot) ? l.bot : [...open.keys()][0];
      if (bot) { open.get(bot).events.push({ kind: 'err', text: afterMarker(l.raw) }); close(bot, { ok: false, code: 'killed', text: afterMarker(l.raw) }); }
      continue;
    }
    if (!l.bot || FOREMAN_UNITS.has(l.bot)) continue;
    const bot = l.bot;
    let m;
    if ((m = l.raw.match(STORY_BOARD_HDR))) { board.set(bot, { count: +m[1], list: '' }); continue; }
    if ((m = l.raw.match(STORY_BOARD_LIST))) { const b = board.get(bot) || { count: 0 }; b.list = m[1].trim(); board.set(bot, b); continue; }
    if ((m = l.raw.match(STORY_CLAIMED))) {
      if (open.has(bot)) close(bot, { ok: null, code: 'superseded', text: null });
      open.set(bot, {
        bot, idx: l.idx, relSec: l.relSec, wallSec: l.wallSec, iso: l.iso,
        endIso: null, endRelSec: null, endWallSec: null,
        board: board.get(bot) || { count: 0, list: '' },
        claimed: m[1].trim(), manager: m[2], managerPlan: null,
        events: [], verdict: null, produced: null,
      });
      continue;
    }
    const ep = open.get(bot);
    if (!ep) continue;   // pre-first-claim chatter isn't part of any job
    if (STORY_MGR_DONE.test(l.raw)) {
      // A manager can log several verbs on one line; read by priority so COMPLETE wins over RELEASE.
      close(bot, /\bCOMPLETE\b/.test(l.raw) ? { ok: true, code: 'complete', text: 'COMPLETE' }
        : /\bSTUCK\b/.test(l.raw) ? { ok: false, code: 'stuck', text: 'STUCK' }
        : { ok: null, code: 'released', text: 'released' });
      continue;
    }
    if ((m = l.raw.match(/JOB_RESULT produced=(true|false)/))) { ep.produced = m[1] === 'true'; continue; }
    if (STORY_JOB_RELEASED.test(l.raw)) { close(bot, { ok: null, code: 'released', text: 'released' }); continue; }
    if (!ep.managerPlan && (m = l.raw.match(STORY_MGR_PLAN))) { ep.managerPlan = m[2].trim(); continue; }
    if ((m = l.raw.match(STORY_JUDGE_FRAG))) {
      // Three states, not two: 'not stated' is a progress report carrying no verdict, distinct from
      // 'fail'; `frag` is carried on all three so a reader knows which fragment reported the line.
      const state = m[2] === 'true' ? 'ok' : m[2] === 'false' ? 'fail' : 'note';
      ep.events.push(state === 'fail'
      // Prefixed with the fragment's name only when the readable does not already open with it.
        ? { kind: 'fail', frag: m[1], text: m[3].startsWith(m[1] + ':') ? m[3] : `${m[1]}: ${m[3]}` }
        : { kind: state, frag: m[1], text: m[3] });
      continue;
    }
    if (l.level === 'warn') ep.events.push({ kind: 'warn', text: afterMarker(l.raw) });
    else if (l.level === 'error') ep.events.push({ kind: 'err', text: afterMarker(l.raw) });
  }
  // The record never closed these; `open_at_trace_end` names the state of the fold as a token.
  for (const bot of [...open.keys()]) close(bot, { ok: null, code: 'open_at_trace_end', text: null });
  return episodes;
}

const EPISODE_DIRTY = new Set(['warn', 'err', 'fail']);
const DOING_CAP = 14;   // keep a pathological job from flooding the block

// `full` forces the whole block for every episode; the default selects on trouble, so `full` is how a
// reader asks the interest question instead (Law 25).
// ── IT RETURNS ROWS, AND COMPOSES NOTHING ────────────────────────────────
// `text` on every row is the bot's own line, carried verbatim; `phase` and `kind` are filterable tokens.
function episodeRows(ep, full = false) {
  const dirty = full || ep.events.some(e => EPISODE_DIRTY.has(e.kind));
  const at = relativeTime(ep.relSec);
  const rows = [];
  // `text` is LAST since it is the one unbounded cell; a ragged column at the end costs nothing.
  const push = (phase, kind, text, n) => rows.push([at, ep.bot, jobToken(ep.claimed), phase, kind, n, text]);

  if (!dirty) {
    // A job that ran clean start to finish: one row, its step count, and the judge's own verdict text.
    push('verdict', ep.verdict.code, ep.verdict.text, ep.events.filter(e => e.kind === 'ok').length);
    return rows;
  }
  push('plan', 'board', ep.board.list || null, ep.board.count);
  push('plan', 'claimed', ep.claimed, null);
  if (ep.managerPlan) push('plan', ep.manager, ep.managerPlan, null);

  const collapsed = collapseEvents(ep.events);
  for (const e of collapsed.slice(0, DOING_CAP)) push('doing', e.kind, e.text, e.n > 1 ? e.n : null);
  // The cap is a rendering limit; the number of entries it hides is reported, never a silent cut.
  if (collapsed.length > DOING_CAP) push('doing', 'not_listed', null, collapsed.length - DOING_CAP);

  push('verdict', ep.verdict.code, ep.verdict.text, null);
  return rows;
}

const EPISODE_FIELDS = ['at', 'bot', 'job_key', 'phase', 'kind', 'n', 'text'];

// ── PASSIVE_LINE — a line a bot emits while INERT, which is not a life sign ──────────────────────────
// States a fact about the trace's grammar; carries no threshold or wake policy, since callers decide
// what silence means. A killed bot still echoes foreman HQ merges and answered relay commands, so both
// would read as recent activity if not excluded. Shared by every life-sign lens (Law 16).
const PASSIVE_LINE = /Merged \d+ relayed station|Executing foreman command/;

module.exports = {
  DEFAULT_TRACE_FILE,
  FORWARDED_RE, PERBOT_RE, FOREMAN_RE, FOREMAN_UNITS, PASSIVE_LINE,
  botFromFilename, parseLine, readTrace, readCameraView, readForemanView,
  CAMERA_STREAM_RE, FOREMAN_STREAM_RE, STREAM_VIEW,
  segmentRuns,
  afterMarker, relativeTime,
  jobToken, collapseEvents, buildEpisodes, episodeRows, EPISODE_FIELDS,
};
