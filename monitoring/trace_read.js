// Auren_Bot/monitoring/trace_read.js
// THE TRACE SUBSTRATE — read a watcher trace, split it into runs, and group its lines into job
// episodes. Nothing here judges, flags, or prints a verdict; every lens does that on top.
//
// ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────────────────────────
// This code lived inside trace_monitor.js and FOUR tools reached into that triage CLI to
// borrow it: footage_clipper and motion_classifier both required exactly
// `{ readTrace, segmentRuns, buildEpisodes, jobToken }` and nothing else, and dashboard took the same
// set plus three signatures. A substrate with four consumers and no home of its own is the Law 16
// smell — "I import the monitor" when what is meant is "I import the reader". Requiring a triage tool
// to get a parser also drags in its whole CLI-global block, which reads process.argv at load time.
//
// THE ONE RULE THAT KEEPS THIS FILE HONEST: it may not know what a problem is. The moment a threshold,
// a signature or a wake policy appears here, it has become a monitor with four importers instead of a
// reader, and the split has bought nothing. Judgment belongs in trace_monitor.js; formatting belongs
// in report_formatting.js; flag parsing belongs in command_line_arguments.js.
//
// Consumers pass the file path explicitly. There is no module-level TRACE_FILE, because a module that
// reads argv cannot be imported by anything that has its own flags.

'use strict';

const fs = require('fs');
const path = require('path');
// The one implementation of the trace's own `12m 46s` stamp. It is a FORMATTER, so it lives with the
// other formatters and is re-exported here for the four tools that read episodes (Law 16 — this file
// briefly carried its own copy, which is exactly the duplication the split was meant to remove).
const { relativeTime } = require('./report_formatting');

// The merged fleet stream. Exported as a DEFAULT for callers to fall back to, never read here — the
// caller owns which trace it is reading (Law 25: the asker's criterion, not the reader's).
const DEFAULT_TRACE_FILE = require(require('./lens_paths').bot('js_kernel/utils/record_homes')).traceFile('overseer');

// ── Line parsing ─────────────────────────────────────────────────────────────
// Two line shapes share one trace family:
//   per-bot file : [ISO] [Nm Ns] [TAG] 📊 text          (bot = filename)
//   overseer own : [ISO] [OVERSEER] text
// Level markers: ❌ prefixes error lines (⛔ only appears inside message text),
// ⚠️ warn, 📊 summary; an unmarked line is infrastructure chatter.
//
// FORWARDED_RE reads a THIRD shape that is no longer written: `[Nm Ns] [BotId] [TAG]`, the copy the
// overseer used to persist of every bot line. That duplication was deleted (see readFleetView) and the
// pattern is kept only so a trace recorded before the deletion still parses — delete it once no such
// file is of interest, and delete nothing else with it.
const FORWARDED_RE = /^\[(\d+)m (\d+)s\] \[(\w+)\]/;
const PERBOT_RE = /^\[[\d\-T:.Z]+\] \[(\d+)m (\d+)s\]/;
// The overseer PROCESS writes under two tags and they are deliberately different units. `[OVERSEER]` is
// the transport — who connected, what was relayed, what the operator typed. `[OVERSEER_BRAIN]` is the
// ARBITER — which bot holds the planning token, who is queued behind it, which claims were granted.
// Attributing both to one name would fold the fleet's mutex decisions into its connection log, and the
// arbiter's ledger is exactly what a stalled fleet has to be read through.
//
// FOUND BY ITS ABSENCE (2026-09-10). `overseer_brain` was given a sink into the run record that same
// hour, and its lines then landed in the trace and were invisible: this pattern matched the exact tag
// `[OVERSEER]`, so every brain line parsed to `bot: null` and `unitsIn()` skips a line with no unit. The
// census answered "OVERSEER_BRAIN posted nothing" about a record that held its lines — a lens reporting
// silence where there is content, which is the one failure mode this whole folder exists to prevent
// (Law 25). The writer and its reader are one change; shipping either alone is shipping a blind spot.
const OVERSEER_RE = /^\[([\d\-T:.Z]+)\] \[(OVERSEER(?:_BRAIN)?)\]/;

// Every unit written by the overseer process rather than by a bot. Callers that walk lines looking for
// BOT behaviour skip these by membership rather than by naming `'OVERSEER'`, so a third overseer-side
// tag added later is excluded by joining this set instead of by editing every call site.
const OVERSEER_UNITS = new Set(['OVERSEER', 'OVERSEER_BRAIN']);

function botFromFilename(file) {
  const m = path.basename(file).match(/^watcher_(.+)\.jsonl$/);
  return m ? m[1] : null;
}

function parseLine(raw, idx, fileBot) {
  const line = { raw, idx, bot: null, relSec: null, iso: null, level: 'infra' };
  let m;
  // Every persisted line is prefixed with its absolute ISO by watcher._record. Capture it up front
  // for ALL line shapes (forwarded lines don't otherwise get one) so the watch loop can measure
  // freshness against the wall clock — the relative [Nm Ss] tag can't detect a total freeze.
  const lead = raw[0] === '[' ? raw.slice(1, raw.indexOf(']')) : null;
  if (lead && !Number.isNaN(Date.parse(lead))) line.iso = lead;
  if ((m = raw.match(FORWARDED_RE))) {
    line.relSec = +m[1] * 60 + +m[2];
    line.bot = m[3];
  } else if ((m = raw.match(PERBOT_RE))) {
    line.relSec = +m[1] * 60 + +m[2];
    line.bot = fileBot;
    line.iso = raw.slice(1, raw.indexOf(']'));
  } else if ((m = raw.match(OVERSEER_RE))) {
    line.bot = m[2];
    line.iso = m[1];
  }
  // Level markers prefix the [TAG]; the same emoji inside message TEXT (e.g.
  // "📊 ❌ goTo failed…") is content, not level — match marker-before-tag only.
  if (/❌ \[/.test(raw) || raw.includes('] ERROR:')) line.level = 'error';
  else if (/⚠️ \[/.test(raw)) line.level = 'warn';
  else if (raw.includes('📊')) line.level = 'summary';
  return line;
}

// ── READING THE STORY ─────────────────────────────────────────────────────────
// The story files are JSONL now: one JSON-encoded line per story line, appended and never rewritten.
// The reasoning for the format lives once, at js_kernel/watcher.js's _writeWatcherFile — in short, a
// crash mid-write can truncate a whole-file JSON document into something unreadable in its entirety,
// while an append-only format can only ever lose its last, unfinished line.
//
// The old reader carried a salvage scanner that walked a half-written JSON array element by element.
// It is gone with the format that needed it: in JSONL a torn write can only damage the LAST line, and
// dropping one line is the whole recovery. What survives from it is the rule that made it worth having —
// a partial read is announced, never silent (Law 25), so no verdict downstream can mistake a cut-off run
// for a complete one.
//
// A BAD LINE IN THE MIDDLE IS A THROW, not a skip (Law 13). Only the final line can be torn by a crash;
// a broken line anywhere else means something wrote this file that should not have, and skipping it
// would silently reorder a timeline while looking healthy.
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
        process.stderr.write(`⚠ ${path.basename(file)}: the final line is torn (the process died mid-append) `
          + `— read ${story.length} complete line(s), dropped the last. Any verdict below is PARTIAL.\n`);
        break;
      }
      throw new Error(`${path.basename(file)} line ${i + 1} of ${rows.length} is not a story line `
        + `(${e.message}). Only the LAST line can be torn by a crash, so this file was written by `
        + `something that should not have touched it.`);
    }
  }
  return story;
}

// readTrace(file) — one story file, parsed into lines.
//
// THE MERGED FLEET VIEW IS BUILT HERE, NOT WRITTEN. The overseer used to persist a copy of every bot's
// line alongside its own, so every fleet event existed in two places and the merged file was a second
// source of truth for it
// (Law 16 / Invariant D). The overseer now persists only its OWN lines, and asking for the overseer
// trace merges it with every per-bot file by ISO stamp — the same view, derived where it is read.
// Callers are unchanged: they pass the overseer path, as they always did.
function readTrace(file) {
  if (path.basename(file) === path.basename(DEFAULT_TRACE_FILE)) return readFleetView(file);
  const fileBot = botFromFilename(file);
  return parseStoryFile(file).map((raw, i) => parseLine(raw, i, fileBot));
}

// Every persisted line carries its own ISO stamp (watcher._record writes it, and the overseer's own
// lines lead with one), so the merge key needs nothing the files do not already hold. Lines without a
// readable stamp keep their position relative to their own file by sorting on the file's last seen
// stamp — dropping them would lose infrastructure chatter that a reader sometimes needs.
// ── THE CAMERA IS A SECOND FLEET AND IT DOES NOT MERGE INTO THE FIRST ──────────────────────────────
// (Architect 2026-08-22: *"everything the scout camera does needs to go on a parallel watcher trace
// besides the fleet one for the bots."*)
//
// The camera processes write `watcher_camera_*.jsonl` into the same directory as the bots, because they
// use the same watcher keyed by the same BOT_ID mechanism. That is correct — one logging stack, one
// filename rule (Law 6). What is NOT correct is merging them into the fleet view: the two streams answer
// different questions and run at different rates. A director re-solving a vantage once a second puts more
// lines into an hour than four bots do, so a merged view buries the fleet's own story in camera work, and
// every fleet lens downstream (signatures, wake policy, the digest) then measures a run it did not mean to.
//
// The split is by FILENAME rather than by a flag inside the lines because the filename is the one thing
// fixed before a single line is written — a process cannot mislabel itself into the wrong view.
const CAMERA_STREAM_RE = /^watcher_camera_.+\.jsonl$/;

// ── THE DESK IS A THIRD STREAM, AND THE SAME ARGUMENT KEEPS IT OUT OF THE FLEET VIEW ──────────────
// The foreman names itself to the watcher exactly as a camera does, so its record lands in this same
// directory under this same filename rule — which is right, and which means it would be merged into the
// fleet view by default. It must not be, for the camera's reason rather than for volume: the desk's
// record answers a different question (who spoke to it, what they were refused, what crossed) and its
// lines are conversations, not fleet decisions. Merged, every fleet lens downstream — the signatures,
// the wake policy, the digest — would be measuring a person's chat as though it were the fleet's own
// reasoning, which is a run they did not mean to measure.
//
// By FILENAME again, and for the same reason stated above: the name is fixed before a line is written,
// so no process can mislabel itself into a view it does not belong in.
const FOREMAN_STREAM_RE = /^watcher_foreman\.jsonl$/;

// `view` names which of the three streams is wanted rather than a boolean per stream, because a boolean
// per stream is a set of flags that can disagree with each other — two of them true names no view, and
// all three false silently returns nothing (Law 13: a state that cannot be asked for cannot be produced).
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
  // The two conditions in this function get opposite answers on purpose (Law 29 — one topic, one rule).
  // An unnamed `view` above is a CODING VIOLATION and throws. A missing `fleet_logs/traces` is the
  // ordinary condition of a machine that has not run the bot yet, and the honest answer is "no files".
  //
  // Found 2026-09-10 by running the shipped tree as a stranger would: `trace_monitor --camera` on a fresh
  // download threw a raw `ENOENT ... scandir` stack out of `readdirSync`, ten frames deep, at somebody
  // who had typed a flag the help text offered them. Every caller already has good wording for an empty
  // stream — `--witness` and `--machine-load` printed theirs correctly in the same test — so the fault
  // was only ever that they never got the chance to say it. Returning [] here fixes all of them at once
  // rather than adding an existence check per lens (Law 16).
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^watcher_.+\.jsonl$/.test(f) && !/_trace\.jsonl$/.test(f))
    .filter(f => viewOf(f) === view)
    .map(f => path.join(dir, f));
}

// mergeStreams(files) — the ISO-stamp merge both views are made of. One implementation (Law 16): the
// fleet view and the camera view differ only in WHICH files they are handed.
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
  // Stable by construction: sort() in V8 is stable, so lines sharing a millisecond keep the order their
  // own file gave them. Without that, two bots logging in the same tick would shuffle on every read and
  // no two runs of the same monitor would agree.
  all.sort((a, b) => a.at - b.at);
  return all.map((r, i) => parseLine(r.raw, i, r.bot));
}

function readFleetView(overseerFile) {
  const dir = path.dirname(overseerFile);
  return mergeStreams([overseerFile, ...streamFiles(dir, { view: STREAM_VIEW.FLEET })
    .filter(f => f !== overseerFile)]);
}

// readCameraView(dir) — the parallel stream: every camera process in one ISO-ordered view, and NOTHING
// from the bots. Takes a directory rather than a file because there is no anchor process here — the rig,
// the OBS operator and anything else that films are peers, and naming one of them the way the overseer
// anchors the fleet would make the view depend on which of them happened to run.
function readCameraView(dir) {
  return mergeStreams(streamFiles(dir || path.dirname(DEFAULT_TRACE_FILE), { view: STREAM_VIEW.CAMERA }));
}

// readForemanView(dir) — the desk's own record and nothing else. A directory rather than a file for the
// camera view's reason inverted: there is exactly one desk, but naming its file here would put the
// filename in two places (Law 16 — the regex above is the one answer to which files are the desk's).
function readForemanView(dir) {
  return mergeStreams(streamFiles(dir || path.dirname(DEFAULT_TRACE_FILE), { view: STREAM_VIEW.FOREMAN }));
}

// The overseer outlives runs, so one combined story can span several — and each
// 'start' resets the bots' relative clocks to [0m 0s]. Comparing stamps (or
// integrity baselines, or repeat counts) across that boundary manufactures
// anomalies out of history, so every signature's state dies at the boundary.
function segmentRuns(lines) {
  const segments = [[]];
  for (const l of lines) {
    if (l.raw.includes("[OVERSEER] Broadcast 'start'")) segments.push([]);
    segments[segments.length - 1].push(l);
  }
  return segments.filter(s => s.length > 0);
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
// The bot's own narrative, one block per dispatched job. A job runs from a
// dispatcher Claimed (JOB BOARD gave the options, dispatcher picked one) to the
// manager's COMPLETE/STUCK/RELEASE — everything the bot did to close that gap,
// with the problems it hit in the middle and the verdict at the end. Like
// --activity, it INVENTS no logging: every line already exists in the trace
// (Law 5/14); this is a lens that groups them into episodes. Never flags, always
// exits 0. Clean jobs (no warn/error) collapse to a single line so the ones that
// fought stand out; a job with any issue prints the full PLAN/DOING/VERDICT block.
const STORY_BOARD_HDR = /JOB BOARD: (\d+) job/;
// BOTH RANK SHAPES, for the same reason `jobToken` carries both: the board posts `[asker/stage]` today
// and posted `P<n>` before the rank became two coordinates, and runs recorded under the old shape are
// still on disk. The alternation is also what makes this line MATCH AT ALL rather than silently render
// "(not captured)" — a reducer keyed to a format the emitter has left does not fail, it goes quiet, and
// the whole board's ordering is exactly the evidence this view exists to carry (Law 25: a lens that
// reports nothing where something happened is emitting a falsehood, not an absence).
const STORY_BOARD_LIST = /\[JOB_BOARD\].*?📊 ((?:\[|P\d+ ).+)$/;
const STORY_CLAIMED = /\[DISPATCHER\].*Claimed (.+?) — dispatching to (\w+)/;
const STORY_MGR_DONE = /\[(\w*MANAGER)\].*\b(COMPLETE|STUCK|RELEASE)\b/;
const STORY_MGR_PLAN = /\[(\w*MANAGER)\] 📊 (.+)$/;
// Greedy (.*) to the LAST quote on the line — a readable can embed its own quotes
// (build_executor wraps the building name: `"headframe"`), and the judge line always
// ends `Readable: "…" | Contiguous: N/M` with no quotes after, so the last quote is the
// readable's close. A non-greedy capture stops at the first inner quote and renders the
// readable blank instead.
// SUCCESS IS NOT ALWAYS ONE WORD. recursive_judge writes 'not stated' — two words, a space in the
// middle — whenever a fragment routes without a success flag, which is every MANAGER-level report.
// (\S+) could not match it, so the whole line failed the pattern and the readable was dropped on
// the floor: 78 of 220 on take 2026-08-16 (35%), and they were the most narratable lines in the file
// (supply_manager 42, mining_manager 11, building_manager 7, battle_stations 5). The record was
// written, the reader silently skipped it, and every count downstream was short by that much — the
// Law 25 shape, sitting in the lens rather than in the bot. Lazy (.+?) stops at the first ' | ',
// which is the field separator, so a readable containing ' | ' is still unaffected: it is captured
// by group 3, which starts after the last literal separator in the pattern.
const STORY_JUDGE_FRAG = /Fragment: (\S+) \| Success: (.+?) \| Readable: "(.*)"/;
const STORY_KILL = /stopped an (?:infinite loop|AB)|CODING VIOLATION/;
// ── THE OTHER END OF A JOB ────────────────────────────────────────────────────────────────────────
// Every job needs a terminus, read rather than stamped — the judge routing to job_board IS the release
// of the seat, and the line already says so. It matters because only MANAGED jobs log a manager verdict:
// the one-shot executor jobs (furnace, dump, torch, canopy, salvage, explore, the two startup locks)
// have no manager at all, so their episode used to run on until the NEXT claim and close as "superseded".
// That silently folded the plan-cycle gap after a job into the job's own duration — fine for reading a
// story, wrong for measuring one.
//
// Matched on the ROUTE, not on any one wording, because five judge exits reach job_board (manager
// release, unstamped executor return, the contiguous-3 brain refresh, and both portable-judge modes) and
// they share only this phrase. The escalation line wraps it in ANSI colour, which is why the pattern
// anchors on the phrase alone and never on line start.
//
// `ok` STAYS NULL HERE ON PURPOSE. The judge asserts the seat is free, never that the WORK is done —
// only a manager's COMPLETE says that. Every consumer counting completed jobs reads `verdict.ok === true`,
// so promoting a released one-shot to ok:true would silently inflate that figure for all of them. The fragment's own success/failure is already in ep.events (STORY_JUDGE_FRAG
// pushes it one line earlier), so nothing is lost by leaving the seat-level verdict neutral.
const STORY_JOB_RELEASED = /\[RECURSIVE_JUDGE\].*Routing to job_board/;

// "[bot/craft] supply/logs (need: 64)" → "supply/logs": the bare job token for the terse one-liner (the
// rank prefix and the count are noise once you are reading the story).
//
// BOTH PREFIX SHAPES ARE STRIPPED, and the older one is kept deliberately rather than tidied away. The
// board used to post an authored integer (`P2`) and now posts the coordinates it composed the rank from
// (`[bot/craft]`); saved runs from before that change are still on disk and are still read by these
// lenses, so a reader that handled only the current shape would silently leave `P2 ` glued to every
// token in an old run and split one job's history into two names either side of the change. A monitor
// reads records, and records outlive the format they were written in.
function jobToken(claimed) {
  return claimed
    .replace(/^\[[^\]]*\]\s+/, '')
    .replace(/^P\d+\s+/, '')
    .replace(/\s*\(.*\)\s*$/, '')
    .trim();
}

// Consecutive DOING events with identical text fold into one "…×N" — this is what
// turns the 4× flat-retry of a deterministic A* failure into a single readable line.
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
  // Absolute wall-clock bounds, carried alongside the relative ones the renderer prints. The story
  // lens itself never needs them, but footage_clipper projects an episode onto a video timeline, and
  // only an absolute stamp can be subtracted from a recording's start — [3m 40s] is relative to a
  // run that began before the camera rolled. Advanced per line rather than captured at close(),
  // because close() is reached from four call sites (verdict, supersede, kill, trace-end).
  let curIso = null;
  // The relative half of the same clock. endIso alone cannot be rendered without re-deriving the run's
  // t0, and every consumer that wants a duration would re-derive it differently (Law 16). Carried the
  // same way curIso is, and for the same reason: close() has five call sites.
  let curRelSec = null;
  const close = (bot, verdict) => {
    const ep = open.get(bot);
    if (!ep) return;
    ep.verdict = verdict;
    ep.endIso = curIso;
    ep.endRelSec = curRelSec;
    episodes.push(ep);
    open.delete(bot);
  };
  for (const l of seg) {
    if (l.iso) curIso = l.iso;
    if (l.relSec != null) curRelSec = l.relSec;
    // A kill can be logged by the judge under either the bot or (rarely) OVERSEER;
    // attribute it to whichever bot has an open episode if the line names no bot.
    if (STORY_KILL.test(l.raw) && l.level === 'error') {
      const bot = l.bot && open.has(l.bot) ? l.bot : [...open.keys()][0];
      if (bot) { open.get(bot).events.push({ kind: 'err', text: afterMarker(l.raw) }); close(bot, { ok: false, text: 'KILLED — ' + afterMarker(l.raw) }); }
      continue;
    }
    if (!l.bot || OVERSEER_UNITS.has(l.bot)) continue;
    const bot = l.bot;
    let m;
    if ((m = l.raw.match(STORY_BOARD_HDR))) { board.set(bot, { count: +m[1], list: '' }); continue; }
    if ((m = l.raw.match(STORY_BOARD_LIST))) { const b = board.get(bot) || { count: 0 }; b.list = m[1].trim(); board.set(bot, b); continue; }
    if ((m = l.raw.match(STORY_CLAIMED))) {
      if (open.has(bot)) close(bot, { ok: null, text: 'superseded by a new job' });
      open.set(bot, {
        bot, idx: l.idx, relSec: l.relSec, iso: l.iso, endIso: null, endRelSec: null,
        board: board.get(bot) || { count: 0, list: '' },
        claimed: m[1].trim(), manager: m[2], managerPlan: null,
        events: [], verdict: null,
      });
      continue;
    }
    const ep = open.get(bot);
    if (!ep) continue;   // pre-first-claim chatter isn't part of any job
    if (STORY_MGR_DONE.test(l.raw)) {
      // A manager can log several verbs on one line ("COMPLETE | RELEASE") — the
      // job's real outcome is the strongest present, not whichever the regex lands
      // on, so read them by priority: a completed job is done even though it also
      // released its claim.
      close(bot, /\bCOMPLETE\b/.test(l.raw) ? { ok: true, text: 'COMPLETE' }
        : /\bSTUCK\b/.test(l.raw) ? { ok: false, text: 'STUCK' }
        : { ok: null, text: 'released' });
      continue;
    }
    if (STORY_JOB_RELEASED.test(l.raw)) { close(bot, { ok: null, text: 'released' }); continue; }
    if (!ep.managerPlan && (m = l.raw.match(STORY_MGR_PLAN))) { ep.managerPlan = m[2].trim(); continue; }
    if ((m = l.raw.match(STORY_JUDGE_FRAG))) {
      // THREE STATES, NOT TWO. 'not stated' is not a failure — it is a report that carried no verdict,
      // which is what a manager posts when it announces progress rather than an outcome. Folding it into
      // 'fail' (which the old ok = m[2] === 'true' did by default) would have turned 78 healthy progress
      // lines into 78 fabricated failures the moment the regex above began matching them — marking clean
      // episodes dirty and inflating the editor's 'problems' count on every card. Same distinction
      // archer_calculator draws between 'unreadable' and 'not drawing': an absent answer is its own answer.
      //
      // 'note' is deliberately absent from EPISODE_DIRTY and counted by no lens (job_timeline counts
      // ok/fail/warn/err, the cutting room counts ok as steps and warn|err|fail as problems — all four
      // filters skip it). It exists to carry the READABLE, which is the raw material narration is
      // composed from: the fragment already stated what happened with its own variables in it, and this
      // is the line that stops that statement being thrown away.
      //
      // frag is carried on all three now. The text of a 'fail' has always been prefixed with its author;
      // an 'ok' never was, so nothing downstream could say WHICH fragment reported it without
      // re-parsing the readable's own prefix — a convention, not a guarantee.
      const state = m[2] === 'true' ? 'ok' : m[2] === 'false' ? 'fail' : 'note';
      ep.events.push(state === 'fail'
      // Prefixed only when the readable does not already open with its own author. Nearly every
      // fragment writes "${TAG}: ..." by convention, so the unconditional prefix produced
      // "build_executor: build_executor: ..." — invisible while these lines were only read by a
      // developer scanning a story file, and immediately visible the moment they became the raw
      // material for a spoken sentence. The prefix stays for the fragments that do not self-name,
      // because a failure whose author is unknown is worse than one that stutters.
        ? { kind: 'fail', frag: m[1], text: m[3].startsWith(m[1] + ':') ? m[3] : `${m[1]}: ${m[3]}` }
        : { kind: state, frag: m[1], text: m[3] });
      continue;
    }
    if (l.level === 'warn') ep.events.push({ kind: 'warn', text: afterMarker(l.raw) });
    else if (l.level === 'error') ep.events.push({ kind: 'err', text: afterMarker(l.raw) });
  }
  for (const bot of [...open.keys()]) close(bot, { ok: null, text: 'still running at trace end' });
  return episodes;
}

const EPISODE_DIRTY = new Set(['warn', 'err', 'fail']);
const EVENT_GLYPH = { ok: '✅', fail: '✗', warn: '⚠', err: '⛔', note: '·' };
const VERDICT_GLYPH = v => (v.ok === true ? '✔' : v.ok === false ? '✗' : '⋯');
const DOING_CAP = 14;   // keep a pathological job from flooding the block

// `full` forces the whole block for every episode, including the clean ones the collapse hides.
// WHY THE COLLAPSE NEEDED AN OVERRIDE: it selects on TROUBLE, which is the right default for "what went
// wrong" and exactly backwards for "why was this job chosen". The board a bot was offered is only
// printed in the full block, so a run where the ranking worked perfectly shows its ordering NOWHERE —
// the evidence is suppressed precisely when it is the answer. Trouble and interest are different
// questions and the reader picks which one it is asking (Law 25 — a view that can only show failures
// must not be read as a view of the run).
function renderEpisode(ep, full = false) {
  const dirty = full || ep.events.some(e => EPISODE_DIRTY.has(e.kind));
  const okCount = ep.events.filter(e => e.kind === 'ok').length;
  if (!dirty) {
    // One line: the job worked start to finish, nothing to investigate.
    const tail = okCount ? ` (${okCount} step${okCount === 1 ? '' : 's'})` : '';
    return `${VERDICT_GLYPH(ep.verdict)} [${relativeTime(ep.relSec)}] ${ep.bot}  ${jobToken(ep.claimed)} → ${ep.verdict.text}${tail}`;
  }
  const L = [];
  L.push(`━━ ${ep.bot} ━━ [${relativeTime(ep.relSec)}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  L.push(`▸ PLAN    job board (${ep.board.count}): ${ep.board.list || '(not captured)'}`);
  L.push(`          dispatcher claimed → ${ep.claimed}`);
  if (ep.managerPlan) L.push(`          ${ep.manager} → ${ep.managerPlan}`);
  const collapsed = collapseEvents(ep.events);
  const shown = collapsed.slice(0, DOING_CAP);
  L.push('▸ DOING');
  for (const e of shown) {
    const times = e.n > 1 ? ` ×${e.n}` : '';
    L.push(`          ${EVENT_GLYPH[e.kind] || '·'} ${e.text}${times}`);
  }
  if (collapsed.length > shown.length) L.push(`          … +${collapsed.length - shown.length} more`);
  L.push(`▸ VERDICT ${VERDICT_GLYPH(ep.verdict)} ${ep.verdict.text}`);
  return L.join('\n');
}

// ── PASSIVE_LINE — a line a bot emits while INERT, which is not a life sign ──────────────────────────
// Substrate rather than judgment, which is why it may live here under this file's own rule: it states a
// fact about the trace's GRAMMAR (this shape of line is the link breathing, not work), the same category
// as afterMarker and jobToken. It carries no threshold and no wake policy — the callers that decide what
// silence MEANS keep that decision.
//
// A bot whose signal was killed still echoes overseer HQ merges forever, which is exactly the corpse the
// silence signature exists to find. The same is true of 'Executing overseer command': an operator verb
// relayed to a bot is answered by its link thread, which lives on after the bot's signal is dead — a
// halted bot can therefore keep reporting recent "last activity" off the `exit` relay alone.
//
// HOISTED HERE when the feature lenses left trace_monitor: sigSilence, computeBotStats and --progress
// kept it on one side of the cut and --milestones needed it on the other. Two copies of "what counts as
// a life sign" is exactly the drift Law 16 forbids, and it would show up as two lenses disagreeing about
// when a run ended.
const PASSIVE_LINE = /Merged \d+ relayed station|Executing overseer command/;

module.exports = {
  DEFAULT_TRACE_FILE,
  FORWARDED_RE, PERBOT_RE, OVERSEER_RE, OVERSEER_UNITS, PASSIVE_LINE,
  botFromFilename, parseLine, readTrace, readCameraView, readForemanView,
  CAMERA_STREAM_RE, FOREMAN_STREAM_RE, STREAM_VIEW,
  segmentRuns,
  afterMarker, relativeTime,
  jobToken, collapseEvents, buildEpisodes, renderEpisode,
};
