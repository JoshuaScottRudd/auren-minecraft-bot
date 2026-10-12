// Auren_Bot/monitoring/trace_monitor.js
// Deterministic first-pass triage of a watcher trace — the detection half of the AI-monitor layering
// (raw trace → THIS SCRIPT → anomaly + context slice → LLM → clean problem → the operator). Read-only
// observer of transparent state (Law 6); lives outside the construct (Law 19).
//
// FLAGS: the signatures below. In --watch --exit-on-flag they are the only thing that wakes the reader.
// CONTEXT: --activity, --story, --stream=<tag> are on-demand lenses; flag nothing, invent no logging
// (Law 5/14).
//
// Usage:
//   node trace_monitor.js [traceFile] [--context=80] [--quiet]
//   node trace_monitor.js --activity [--bot=AurenBot] [traceFile]
//   node trace_monitor.js --story [--bot=AurenBot] [--all] [traceFile]
//   node trace_monitor.js --progress [--tail=10m] [traceFile]                     (progress vs looping ledger)
//   node trace_monitor.js --pathfinding [--bot=AurenBot] [traceFile]
//   node trace_monitor.js --route-cost [--bot=AurenBot] [traceFile]
//   node trace_monitor.js --jumps [--bot=AurenBot] [traceFile]
//   node trace_monitor.js --hunger [--bot=AurenBot] [traceFile]                   (exhaustion → bread/wheat)
//   node trace_monitor.js --accounting [--all] [traceFile]                       (bot-minutes, items, structures)
//   node trace_monitor.js --jobs [--bot=AurenBot] [--all] [traceFile]
//   node trace_monitor.js --milestones [--bot=AurenBot] [--deadline=10m] [traceFile]
//   node trace_monitor.js --farm [--bot=AurenBot] [--all] [traceFile]
//   node trace_monitor.js --torch [--bot=AurenBot] [--deadline=10m] [traceFile]
//   node trace_monitor.js --compost [--bot=B] [--all]
//   node trace_monitor.js --inventory [--bot=B] [--all]
//   node trace_monitor.js --walking [--bot=B] [--all]
//   node trace_monitor.js --trees [--bot=B] [--all]
//   node trace_monitor.js --steps [--bot=B] [--all]
//   node trace_monitor.js --gate [--all]
//   node trace_monitor.js --lag
//   node trace_monitor.js --outcome
//   node trace_monitor.js --engagement [--bot=AurenBot] [--all]
//   node trace_monitor.js --foreman [--bot=PlayerName] [--all]                    (--bot names a PERSON)
//   node trace_monitor.js --camera [--bot=AurenBot] [--all]
//   node trace_monitor.js --witness [--bot=AurenBot] [--all]
//   node trace_monitor.js --machine-load [--label=NAME] [--run-only]
//   node trace_monitor.js --watch [--interval=5] [--exit-on-flag[=error,halt]] [--max-minutes=15] [--stream=dispatcher] [--errors-known=N]
//   node trace_monitor.js --around=<1m1s|ISO> [--lines=25 | --window=60 | --before=..|--after=..] [--tag=T] [--bot=B]
//   node trace_monitor.js --from=<4m> --to=<7m> [--bot=B] [--tag=T] [--grep=<regex>] [--level=error] [--run=latest|N|all]
//
// Default traceFile: fleet_logs/traces/watcher_fleet.jsonl. Per-bot files (watcher_<Id>.json) work too.
// Exit codes: 0 clean · 2 flags found · 1 could not read trace.

'use strict';
require('../js_kernel/utils/developer_door').enter('monitoring/trace_monitor.js');

// The bot's @-aliases, registered off THIS file's package root. Registered at the one entry every lens
// is reached through (Law 16).
require('module-alias')(require('path').resolve(__dirname, '..'));

const fs = require('fs');
const path = require('path');

// ── Siblings this file calls ────────────────────────────────────────────────────────────────────────
//   trace_read.js               substrate — parse, read, segment, episodes.
//   report_formatting.js        summary statistic + line renderers.
//   command_line_arguments.js   flag reader.
//   chain_lenses.js             --compost.
//   build_lenses.js             --milestones, --torch.
//   farm_lens.js                --farm, and the farm block of --milestones.
//   locomotion_lenses.js        --pathfinding, --route-cost, --jumps.
//   tree_search_lens.js         --trees.
//   step_failure_lens.js        --steps.
//   planning_gate_lens.js       --gate.
//   server_lag_lens.js          --lag.
//   hunger_lens.js               --hunger: a run priced in Minecraft exhaustion, converted to bread/wheat.
//
// This file: the signatures, the per-bot digest, the wake policy, the watch, and --activity/--story/
// --progress/--around/--from over the same trace.
//
// Every lens receives the run's lines and options as ARGUMENTS, renders, and RETURNS — never reads
// process.argv, never calls process.exit. This file is the CLI.
const {
  DEFAULT_TRACE_FILE, botFromFilename, parseLine, readTrace, readCameraView, segmentRuns,
  afterMarker, relativeTime, buildEpisodes, episodeRows, EPISODE_FIELDS, PASSIVE_LINE, FOREMAN_UNITS,
} = require('./trace_read');
const { makeArgs, parseDuration } = require('./command_line_arguments');
// Every answer this CLI gives about a run goes through data_out: declared field names, copied values.
// `console.error`/`throw` are this process talking about ITSELF, not about a run.
const out = require('./data_out');
const chainLenses = require('./chain_lenses');
const buildLenses = require('./build_lenses');
const locomotionLenses = require('./locomotion_lenses');

// ── Thresholds ─────────────────────────────────────────────────────────────
const SILENCE_GAP_SEC = 120;      // no line at all from an active bot
const WARN_BURST_COUNT = 5;      // ≥ this many warns...
const WARN_BURST_WINDOW_SEC = 60; //   ...within this window
const WARN_REPEAT_COUNT = 3;     // identical warn text repeated this often
const JUDGE_REPEAT_MIN = 3;      // judge's own Contiguous: N/5 escalation
const REGRESSION_TOLERANCE = 2;   // voxels; a structure's correct-count drop tolerated as flicker

// Signatures that WAKE a watcher (--exit-on-flag → stop + hand off): error, halt, death.
const WAKE_SIGS = new Set(['error', 'halt', 'death']);

// ── CLI ──────────────────────────────────────────────────────────────────────
// Flag parsing: command_line_arguments (Law 16). This file is the one place that reads process.argv.
const { args, opt, has } = makeArgs();

// --ascii: folds emoji/box-drawing glyphs to ASCII, for a terminal that renders them as mojibake.
// Wraps stdout so it covers this file, every lens, and the bots' own trace text (Law 16).
const ASCII = has('ascii');
if (ASCII) {
  const FOLD = [
    ['⚠️', '[warn]'], ['❌', '[ERR]'], ['✅', '[ok]'], ['⛔', '[STOP]'], ['🚨', '[ALERT]'],
    ['📊', '[i]'], ['📍', '[at]'], ['🎒', '[bag]'], ['🌍', '[world]'], ['⛏', '[dig]'],
    ['🚧', '[gated]'], ['🧪', '[test]'], ['⚠', '[warn]'], ['✔', 'v'], ['✗', 'x'],
    ['▸', '>'], ['·', '.'], ['⋯', '...'], ['──', '--'], ['─', '-'], ['—', '-'], ['’', "'"],
  ];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return write(chunk, ...rest);
    let s = chunk;
    for (const [from, to] of FOLD) s = s.split(from).join(to);
    // Anything still outside ASCII is replaced with '?'.
    return write(s.replace(/[^\x00-\x7F]/g, '?'), ...rest);
  };
}

const TRACE_FILE = args.find(a => !a.startsWith('--')) || DEFAULT_TRACE_FILE;
const CONTEXT = parseInt(opt('context', '80'), 10);
const QUIET = has('quiet');
// --follow implies --watch: following IS watching with the echo filter removed.
const WATCH = has('watch') || has('follow');
// This is a post-mortem instrument: nothing reads the trace monitor while the fleet is online.
// --watch/--follow declare themselves live and pass through. Gated only when this file is the command
// being run (Law 26 — the CLI is the reader, the module is parts).
if (require.main === module) require('./post_mortem_gate').refuseIfLive(TRACE_FILE, { live: WATCH });
const WATCH_INTERVAL_SEC = parseInt(opt('interval', has('follow') ? '2' : '5'), 10);
// --exit-on-flag [=sig,sig] — end the watch the moment a wake-worthy signature fires. Bare, any of
// WAKE_SIGS may end it; with a list, only the named signatures may.
const EXIT_ON_LIST = opt('exit-on-flag', null);
const EXIT_ON_FLAG = has('exit-on-flag') || EXIT_ON_LIST !== null;
const EXIT_ON_SIGS = EXIT_ON_LIST
  ? new Set(EXIT_ON_LIST.split(',').map(x => x.trim()).filter(x => WAKE_SIGS.has(x)))
  : WAKE_SIGS;

// Exit codes: 0 clean · 1 the trace could not be read · 2 the window ran, flags raised · 3 ended early.
const EXIT_EARLY_CODE = 3;
const MAX_MINUTES = parseFloat(opt('max-minutes', has('follow') ? '10080' : '15'));
// --errors-known=N — the first N WAKING episodes are already handed off; anything after still wakes.
const ERRORS_KNOWN = parseInt(opt('errors-known', '0'), 10) || 0;
const ACTIVITY = has('activity');
const STORY = has('story');
const PROGRESS = has('progress');
const PATHFINDING = has('pathfinding');
// --walking — every walk, by the job it served and where it went, against that job's worked time.
const WALKING = has('walking');
// --trees — every tree search: the ring a tree was taken in, what the reading cost, how it ended.
const TREES = has('trees');
// --steps — every step a body planned and did not complete: what stopped it, on which move, at which cell.
const STEPS = has('steps');
// --gate — the planning gate: every entry and its exit, time inside, the line, any overlap.
const GATE = has('gate');
// --lag — every time the server fell behind, and what its main thread was doing while it did.
const LAG = has('lag');
const ROUTECOST = has('route-cost');
const JUMPS = has('jumps');
// --hunger — a run priced in food: acts (blocks broken, jumps, swims, damage), not elapsed time.
const HUNGER = has('hunger');
const MILESTONES = has('milestones');
// --torch — when the first torch was crafted, the order that asked for it, and every gate it held.
const TORCH = has('torch');
// --farm — the wheat field: rows sited, gated, laid, crop census, work done, seed trips.
const FARM = has('farm');
// --jobs — every job claimed, in order, with duration/verdict/gaps and time by job type.
const JOBS = has('jobs');
// --planning — the plan phase: thinking-fragment congestion, how long bots wait their turn.
const PLANNING = has('planning');
const PLAN_BUDGET_SEC = parseFloat(opt('budget', '0.5')) || 0.5;
// --toolkit — the run priced in bot-minutes, and the kit's share of it.
const TOOLKIT = has('toolkit');
const CENSUS  = has('census');
// --accounting — the whole run in one read: labour, material, and the four sites.
const ACCOUNTING = has('accounting');
// --warnings — every warning folded by the unit that raised it and the shape of its words.
const WARNINGS = has('warnings');
// --witness — the outside observer's own combat record.
const WITNESS = has('witness');
// --machine-load — the box's own record (GPU/CPU/RAM) while a filmed run is up.
const MACHINE_LOAD = has('machine-load');
// --narration --bot=<unit> — a unit's own words, in order. --full widens the window past the last
// `start` broadcast.
const NARRATION = has('narration');
const NARRATION_FULL = has('full');
const COMPOST = has('compost');
// --inventory — where every item IS, and every container-to-container move.
const INVENTORY = has('inventory');
// --items — the foreman's item book: taken from the world, picked back up, where it is, the waste pit.
const ITEMS = has('items');
// --engagement — the fight as a story, joined out of the three crew seats' event streams (Invariant D).
const ENGAGEMENT = has('engagement');
// --camera — the camera's own run, off its own parallel trace: vantages chosen, why cuts fired.
const CAMERA = has('camera');
// --foreman — the desk's own record: who spoke to it, what was refused. `--bot` names a PERSON here.
const FOREMAN = has('foreman');
// --deadline=<Nm|Ns> — the asker's criterion, passed to build_lenses.runMilestones/runTorchClock.
const MS_DEADLINE_SEC = (() => {
  const p = opt('deadline', null);
  if (!p) return null;
  const sec = parseDuration(p);
  if (sec === null) fail(`--deadline must look like 10m, 90s or 1m30s (got '${p}')`);
  return sec;
})();
// --tail=<Nm|Ns> — the progress tail window; default 10m.
const PROGRESS_TAIL_SEC = parseDuration(opt('tail', '10m')) ?? 600;
const BOT_FILTER = opt('bot', null);
// --stream=<tag>[,<tag>…] : in --watch, echo every NEW line carrying one of these fragment tags as it
// lands. Comma-separated, case-insensitive.
const STREAM_TAGS = (opt('stream', '') || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
// --follow : --stream with no tag list — echo every new line as it lands, one bot's console with --bot=.
const FOLLOW = has('follow');
const streamMatch = raw => FOLLOW
  ? (!BOT_FILTER || raw.includes(`[${BOT_FILTER}]`))
  : STREAM_TAGS.some(tag => raw.includes(`[${tag}]`));
const STREAMING = FOLLOW || STREAM_TAGS.length > 0;
// Query mode: any addressable-slice flag routes to runQuery (below).
const QUERY = args.some(a => /^--(around|from|to|tag|grep|level)=/.test(a));
// --last : print one greppable LASTPOST line per bot, from each bot's own watcher file.
const LASTPOST = has('last');


// ── Signatures ───────────────────────────────────────────────────────────────
// Each returns flags: { sig, bot, idx, …fields }. idx anchors the context slice. One flag per EPISODE.
// A flag carries fields, never a prose reason. `text`/`readable`/`signal` are copied verbatim from the
// bot's own line. Field names become the table's columns (data_out: lower-case, digits, underscore, dot).

// (a) Any ❌ error. Consecutive error lines from one bot collapse into one flag anchored at the first.
function sigErrors(lines) {
  const flags = [];
  let open = null;   // { bot, lastIdx, flag }
  for (const l of lines) {
    if (l.level !== 'error') continue;
    if (open && open.bot === l.bot && l.idx - open.lastIdx <= 2) {
      open.lastIdx = l.idx;
      open.flag.count++;
      continue;
    }
    // `text`: the bot's own error line, copied — what isDeathClass reads.
    const flag = { sig: 'error', bot: l.bot, idx: l.idx, count: 1, text: afterMarker(l.raw) };
    flags.push(flag);
    open = { bot: l.bot, lastIdx: l.idx, flag };
  }
  return flags;
}

// (b) The judge's own escalation: Contiguous: N/M with N ≥ JUDGE_REPEAT_MIN. A rising run for one
// bot+fragment is one episode, flag anchored at the PEAK line.
function sigJudgeRepeat(lines) {
  const RE = /Fragment: (\S+) \| Success: (\S+) \| Readable: "(.*)" \| Contiguous: (\d+)\/(\d+)/;
  const episodes = new Map();   // bot:fragment → { peak, idx, readable }
  const flags = [];
  const close = (key) => {
    const e = episodes.get(key);
    if (e && e.peak >= JUDGE_REPEAT_MIN) {
      flags.push({
        sig: 'judge-repeat', bot: e.bot, idx: e.idx,
        fragment: e.fragment, contiguous: e.peak, threshold: JUDGE_REPEAT_MIN, readable: e.readable,
      });
    }
    episodes.delete(key);
  };
  for (const l of lines) {
    const m = l.raw.match(RE);
    if (!m) continue;
    const [, fragment, , readable, nStr] = m;
    const n = +nStr;
    const key = `${l.bot}:${fragment}`;
    if (n === 1) close(key);
    const e = episodes.get(key) || { bot: l.bot, fragment, peak: 0 };
    if (n >= e.peak) { e.peak = n; e.idx = l.idx; e.readable = readable; }
    episodes.set(key, e);
  }
  for (const key of [...episodes.keys()]) close(key);
  return flags;
}

// (c) Identical warn text repeated — catches loops that never reach the judge. Normalized to the text
// after the ⚠️ so differing timestamps don't hide the repetition.
function sigWarnRepeat(lines) {
  const seen = new Map();   // bot|text → count
  const flags = [];
  for (const l of lines) {
    if (l.level !== 'warn') continue;
    const key = `${l.bot}|${afterMarker(l.raw)}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n === WARN_REPEAT_COUNT) {
      flags.push({
        sig: 'warn-repeat', bot: l.bot, idx: l.idx,
        count: n, threshold: WARN_REPEAT_COUNT, text: afterMarker(l.raw),
      });
    }
  }
  return flags;
}

// (d) Warn burst: many warns (any text) from one bot in a short window. One flag per burst.
function sigWarnBurst(lines) {
  const byBot = new Map();
  for (const l of lines) {
    if (l.level === 'warn' && l.relSec !== null) {
      if (!byBot.has(l.bot)) byBot.set(l.bot, []);
      byBot.get(l.bot).push(l);
    }
  }
  const flags = [];
  for (const [bot, warns] of byBot) {
    let suppressUntil = -1;
    for (let i = 0; i + WARN_BURST_COUNT <= warns.length; i++) {
      const first = warns[i];
      const kth = warns[i + WARN_BURST_COUNT - 1];
      if (first.relSec < suppressUntil) continue;
      if (kth.relSec - first.relSec <= WARN_BURST_WINDOW_SEC) {
        flags.push({
          sig: 'warn-burst', bot, idx: kth.idx,
          count: WARN_BURST_COUNT, window_sec: kth.relSec - first.relSec,
          threshold_count: WARN_BURST_COUNT, threshold_sec: WARN_BURST_WINDOW_SEC,
          text: afterMarker(kth.raw),
        });
        suppressUntil = kth.relSec + WARN_BURST_WINDOW_SEC;
      }
    }
  }
  return flags;
}

// (e) Silence gap: an active bot did no WORK for > SILENCE_GAP_SEC. A mid-trace gap anchors at the
// line that broke the silence; a trailing gap (bot never came back) anchors at its last line. A logged
// disconnect ends activity. PASSIVE_LINE (trace_read) excludes relay lines from counting as work.

// A finished structure stops reporting numbers: "matches the blueprint" replaces "N/285 voxels
// correct" (Law 16).
const BUILD_DONE_RE = /"([^"]+)" matches the blueprint/;
const BUILD_SCAN_RE = /voxels correct/;
const MINE_SCAN_RE = /excavate frontier/;

function sigSilence(lines) {
  const lastByBot = new Map();
  const disconnected = new Set();
  const flags = [];
  let maxRel = 0;
  for (const l of lines) {
    const dm = l.raw.match(/Bot '(\w+)' disconnected/);
    if (dm) disconnected.add(dm[1]);
    if (l.relSec === null || !l.bot || FOREMAN_UNITS.has(l.bot)) continue;
    maxRel = Math.max(maxRel, l.relSec);
    if (PASSIVE_LINE.test(l.raw)) continue;
    const prev = lastByBot.get(l.bot);
    if (prev && l.relSec - prev.relSec > SILENCE_GAP_SEC) {
      // `form`: gap (closed) vs trailing (never came back).
      flags.push({
        sig: 'silence', bot: l.bot, idx: l.idx, form: 'gap',
        gap_sec: l.relSec - prev.relSec, threshold_sec: SILENCE_GAP_SEC,
        silent_since: relativeTime(prev.relSec), silent_since_sec: prev.relSec,
      });
    }
    lastByBot.set(l.bot, l);
  }
  for (const [bot, last] of lastByBot) {
    if (disconnected.has(bot)) continue;
    if (maxRel - last.relSec > SILENCE_GAP_SEC) {
      flags.push({
        sig: 'silence', bot, idx: last.idx, form: 'trailing',
        gap_sec: maxRel - last.relSec, threshold_sec: SILENCE_GAP_SEC,
        silent_since: relativeTime(last.relSec), silent_since_sec: last.relSec,
        fleet_span_sec: maxRel,
      });
    }
  }
  return flags;
}

// (f) Integrity regression: a structure's correct-count went DOWN. Covers building ("X/Y voxels
// correct") and mining (excavate frontier correct=N).
function sigRegression(lines) {
  const BUILD_RE = /"([^"]+)" is (\d+)\/\d+ voxels correct/;
  // Keyed on the full segment identity ("staircase -35|34|6"), not just the structure name.
  const MINE_RE = /excavate frontier: (.+?) y=.*?\bcorrect=(\d+)/;
  const best = new Map();
  const flags = [];
  const check = (l, key, val) => {
    const prev = best.get(key);
    if (prev !== undefined && val < prev - REGRESSION_TOLERANCE) {
      flags.push({
        sig: 'regression', bot: l.bot, idx: l.idx,
        structure: key, from: prev, to: val, drop: prev - val, tolerance: REGRESSION_TOLERANCE,
      });
    }
    best.set(key, Math.max(prev ?? val, val));
  };
  for (const l of lines) {
    let m;
    if ((m = l.raw.match(BUILD_RE))) check(l, `build:${m[1]}`, +m[2]);
    else if ((m = l.raw.match(MINE_RE))) check(l, `mine:${m[1]}`, +m[2]);
  }
  return flags;
}

// (g) Judge halt: recursive_judge parked a bot for inspection (Law 13, default stopped). Fires on the
// halt line, once per halt. Exempt from the watch baseline (wakes at any idx).
const HALT_RE = /HALTED for inspection after killing "([^"]*)"/;
function sigJudgeHalt(lines) {
  const flags = [];
  for (const l of lines) {
    const m = l.raw.match(HALT_RE);
    if (m) flags.push({ sig: 'halt', bot: l.bot, idx: l.idx, signal: m[1] });
  }
  return flags;
}

// (h) Death: a bot died. The construct does not log its own death as an ❌ (it respawns and carries
// on), so this reads job_board's ⚠️ post instead. Deduped per corpse (DEATH_EPISODE_SEC). Exempt from
// the watch baseline like error/halt.
const DEATH_RE = /☠️ Bot is DEAD/;
const DEATH_EPISODE_SEC = 60;

// A death also emits an `error` flag (battle_stations' ☠️ DIED); isDeathClass recognizes both as one
// corpse (Law 16 — one definition, not a second copy per consumer).
const DEATH_ERROR_RE = /☠️ DIED/;
function isDeathClass(flag) {
  if (!flag) return false;
  if (flag.sig === 'death') return true;
  return flag.sig === 'error' && DEATH_ERROR_RE.test(flag.text || '');
}
function sigDeath(lines) {
  const flags = [];
  const lastPerBot = new Map();
  for (const l of lines) {
    if (!DEATH_RE.test(l.raw)) continue;
    const t = l.relSec == null ? 0 : l.relSec;
    const prev = lastPerBot.get(l.bot);
    lastPerBot.set(l.bot, t);
    if (prev !== undefined && t - prev <= DEATH_EPISODE_SEC) continue;
    flags.push({ sig: 'death', bot: l.bot, idx: l.idx, at: relativeTime(t), at_sec: t });
  }
  return flags;
}

const SIGNATURES = [sigErrors, sigJudgeRepeat, sigWarnRepeat, sigWarnBurst, sigSilence, sigRegression, sigJudgeHalt, sigDeath];

function detect(lines) {
  const flags = segmentRuns(lines).flatMap(seg => SIGNATURES.flatMap(sig => sig(seg)));
  flags.sort((a, b) => a.idx - b.idx);
  return flags;
}

// ── Digest ───────────────────────────────────────────────────────────────────
// Counts describe the LATEST run only. computeBotStats is the single source of the per-bot aggregation
// (Law 16); the dashboard consumes the same Map.
//
// Authoritative per-bot liveness: reads each bot's OWN story file (last line's own ISO stamp), ground
// truth independent of the merged trace. Reported alongside the merged view; a disagreement is
// MERGE-LAG (Law 6).
const KERNEL_DIR = args.some(a => !a.startsWith('--'))
  ? path.dirname(path.resolve(TRACE_FILE))
  : require(require('./lens_paths').bot('js_kernel/utils/record_homes')).TRACE_DIR;

// --camera/--witness/--machine-load read the camera stack's own records (workshop equipment, not bot
// material). Resolved at the moment the flag is used; absence is answered, not thrown (Law 13).
function recordingLens(name, flag) {
  const dir = require('./lens_paths').recordingLensDir();
  if (dir) return require(path.join(dir, name));
  console.error(`${flag} reads the CAMERA STACK's records, and the camera stack is not part of this `
    + `download — it lives in the workshop beside the bot. Every other flag reads this `
    + `bot's own trace and works here.`);
  process.exit(0);
}

function readBotHeartbeats() {
  const beats = new Map();
  let files = [];
  try { files = fs.readdirSync(KERNEL_DIR); } catch (_) { return beats; }
  for (const f of files) {
    const m = /^watcher_(.+)\.jsonl$/.exec(f);
    if (!m || m[1] === 'fleet') continue;
    const bot = m[1];
    try {
      // Walk BACKWARD to the newest line carrying a readable stamp. A torn final line (the process died
      // mid-append) and the infrastructure chatter that leads with no ISO are both simply skipped —
      // this is a liveness probe, so it wants the freshest STAMPED line, not the last byte in the file.
      const rows = fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8').split('\n');
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!rows[i]) continue;
        let raw;
        try { raw = JSON.parse(rows[i]); } catch (_) { continue; }
        const lead = raw[0] === '[' ? raw.slice(1, raw.indexOf(']')) : null;
        const ms = lead ? Date.parse(lead) : NaN;
        if (Number.isNaN(ms)) continue;
        beats.set(bot, { at: new Date(ms), iso: lead, ageSec: Math.max(0, Math.round((Date.now() - ms) / 1000)), story: raw });
        break;
      }
    } catch (_) { /* file mid-append; next pass reads it */ }
  }
  return beats;
}

// One row per bot: a `posting` boolean beside its age, and `story`, the bot's own last line (Law 6).
function printLastPost() {
  const hb = readBotHeartbeats();
  out.kv('lens', 'lastpost');
  out.kv('trace_dir', KERNEL_DIR);
  out.kv('bots_with_watcher_files', hb.size);
  out.kv('posting_threshold_sec', SILENCE_GAP_SEC);
  if (!hb.size) return;
  out.section('lastpost');
  out.table(['bot', 'posting', 'age_sec', 'at', 'story'],
    [...hb.entries()].sort().map(([bot, h]) => [
      bot, h.ageSec <= SILENCE_GAP_SEC, h.ageSec, h.iso, afterMarker(h.story) || h.story,
    ]));
}

function computeBotStats(lines) {
  const segs = segmentRuns(lines);
  const bots = new Map();
  for (const l of (segs[segs.length - 1] || [])) {
    if (!l.bot || FOREMAN_UNITS.has(l.bot)) continue;
    if (!bots.has(l.bot)) bots.set(l.bot, { s: 0, w: 0, e: 0, lastRel: 0, lastIso: null, latestBuild: null, latestBuildT: 0, latestMine: null, latestMineT: 0, haltedAt: null, haltedOn: null });
    const b = bots.get(l.bot);
    if (l.level === 'summary') b.s++;
    else if (l.level === 'warn') b.w++;
    else if (l.level === 'error') b.e++;
    // last activity = last WORK line; passive merge echoes would mask a corpse
    if (l.relSec !== null && !PASSIVE_LINE.test(l.raw)) {
      b.lastRel = Math.max(b.lastRel, l.relSec);
      if (l.iso) b.lastIso = l.iso;
      // A real work line clears a stale halt (an operator re-tasked the bot).
      b.haltedAt = null;
    }
    if (BUILD_SCAN_RE.test(l.raw) || BUILD_DONE_RE.test(l.raw)) { b.latestBuild = afterMarker(l.raw); b.latestBuildT = l.relSec ?? b.latestBuildT; }
    if (MINE_SCAN_RE.test(l.raw)) { b.latestMine = afterMarker(l.raw); b.latestMineT = l.relSec ?? b.latestMineT; }
    const hm = HALT_RE.exec(l.raw);
    if (hm) { b.haltedAt = l.relSec; b.haltedOn = hm[1]; }
  }
  return bots;
}

// The digest: three tables (bot_vitals, latest_integrity_scan, absent_from_merged_trace), never prose.
function printDigest(lines) {
  const bots = computeBotStats(lines);
  const hb = readBotHeartbeats();
  // Run end = the newest work line ANY bot logged.
  let runEnd = 0;
  for (const b of bots.values()) runEnd = Math.max(runEnd, b.lastRel);

  out.kv('bots', bots.size);
  out.kv('run_end', relativeTime(runEnd));
  out.kv('run_end_sec', runEnd);
  out.kv('posting_threshold_sec', SILENCE_GAP_SEC);
  if (!bots.size && !hb.size) return;

  if (bots.size) {
    out.section('bot_vitals');
    out.table(
      ['bot', 'summaries', 'warns', 'errors', 'last_activity', 'last_activity_sec', 'halted',
        'halted_at', 'halted_on', 'inert_sec', 'own_file', 'own_file_age_sec', 'posting',
        'merge_age_sec', 'merge_lag'],
      [...bots].map(([bot, b]) => {
        const h = hb.get(bot);
        const mergeAgeSec = b.lastIso ? Math.max(0, Math.round((Date.now() - Date.parse(b.lastIso)) / 1000)) : null;
        const lag = !!h && h.ageSec <= SILENCE_GAP_SEC && mergeAgeSec !== null && mergeAgeSec > SILENCE_GAP_SEC;
        return [bot, b.s, b.w, b.e, relativeTime(b.lastRel), b.lastRel,
          b.haltedAt !== null,
          b.haltedAt !== null ? relativeTime(b.haltedAt) : null,
          b.haltedOn,
          b.haltedAt !== null ? Math.max(0, runEnd - b.haltedAt) : null,
          !!h, h ? h.ageSec : null, h ? h.ageSec <= SILENCE_GAP_SEC : null,
          mergeAgeSec, h ? lag : null];
      }));
  }

  const integrity = [];
  for (const [bot, b] of bots) {
    if (b.latestBuild) integrity.push([bot, 'build', relativeTime(b.latestBuildT), b.latestBuildT, b.latestBuild]);
    if (b.latestMine) integrity.push([bot, 'mine', relativeTime(b.latestMineT), b.latestMineT, b.latestMine]);
  }
  if (integrity.length) {
    out.section('latest_integrity_scan');
    out.table(['bot', 'kind', 'at', 'at_sec', 'text'], integrity);
  }

  const absent = [...hb].filter(([bot]) => !bots.has(bot));
  if (absent.length) {
    out.section('absent_from_merged_trace');
    out.table(['bot', 'own_file_age_sec', 'posting', 'story'],
      absent.map(([bot, h]) => [bot, h.ageSec, h.ageSec <= SILENCE_GAP_SEC, afterMarker(h.story) || h.story]));
  }
}

// The one-line status the quiet watch shows between flags: each crew bot's liveness and fault counts.
// Only the roster's bots (`architect_config.BOT_SENIORITY`). Returns rows, not a sentence (Law 16).
const WATCH_FIELDS = ['bot', 'halted', 'own_file', 'age_sec', 'posting', 'warns', 'errors',
  'last_activity_sec'];
function watchStatusRows(lines) {
  const roster = require(require('./lens_paths').bot('Thinking_fragments/architect_config.js')).BOT_SENIORITY;
  const bots = computeBotStats(lines);
  const hb = readBotHeartbeats();
  const rows = [];
  for (const [bot, b] of bots) {
    if (!(bot in roster)) continue;
    const h = hb.get(bot);
    rows.push([bot, b.haltedAt !== null, !!h, h ? h.ageSec : null,
      h ? h.ageSec <= SILENCE_GAP_SEC : null, b.w, b.e, b.lastRel]);
  }
  return rows;
}

// The TTY field: one line, field=value pairs comma-joined.
function watchStatusLine(rows, elapsedMin) {
  const cells = [`watch_min=${Math.floor(elapsedMin)}`, `bots=${rows.length}`];
  for (const r of rows) {
    WATCH_FIELDS.forEach((f, i) => { if (r[i] !== null) cells.push(`${f}=${out.value(r[i])}`); });
  }
  return cells.join(',');
}

// Every warning in the latest run, deduped by bot+text with a repeat count and first-seen time.
function warningsDigest(lines) {
  const segs = segmentRuns(lines);
  const latest = segs[segs.length - 1] || [];
  const groups = new Map();   // `${bot}\u0000${text}` → { bot, text, n, firstRel }
  const order = [];
  for (const l of latest) {
    if (l.level !== 'warn' || !l.bot || FOREMAN_UNITS.has(l.bot)) continue;
    const text = afterMarker(l.raw);
    const key = `${l.bot}\u0000${text}`;
    if (!groups.has(key)) { groups.set(key, { bot: l.bot, text, n: 0, firstRel: l.relSec }); order.push(key); }
    groups.get(key).n++;
  }
  return order.map(k => groups.get(k));
}


function fail(msg) { console.error(`trace_monitor: ${msg}`); process.exit(1); }

// Every flag is a ROW: `at`/`bot`/`signature` fixed, then the union of specific keys each flag carries.
const FLAG_FIXED = ['n', 'at', 'bot', 'signature', 'idx'];
// The bot's own copied text goes last (data_out sizes columns from their widest cell).
const FLAG_TEXT_FIELDS = ['signal', 'readable', 'text'];
function flagTable(lines, flags) {
  const extra = [];
  for (const f of flags) {
    for (const k of Object.keys(f)) {
      if (k === 'sig' || k === 'bot' || k === 'idx') continue;
      if (!extra.includes(k)) extra.push(k);
    }
  }
  extra.sort((a, b) => FLAG_TEXT_FIELDS.indexOf(a) - FLAG_TEXT_FIELDS.indexOf(b));
  const fields = [...FLAG_FIXED, ...extra];
  const rows = flags.map((f, i) => {
    const at = lines[f.idx] && lines[f.idx].relSec != null ? relativeTime(lines[f.idx].relSec) : null;
    return [i + 1, at, f.bot, f.sig, f.idx, ...extra.map(k => (k in f ? f[k] : null))];
  });
  out.table(fields, rows);
}

// Each flag's slice starts no earlier than one past the last printed line, so overlapping slices never
// reprint a line.
function printFlags(lines, flags) {
  out.section('flags');
  out.kv('flags', flags.length);
  out.kv('context_lines', CONTEXT);
  flagTable(lines, flags);
  let printedThrough = -1;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const start = Math.max(0, f.idx - CONTEXT, printedThrough + 1);
    out.section('flag_context');
    out.kv('n', i + 1);
    out.kv('signature', f.sig);
    out.kv('bot', f.bot);
    if (f.idx <= printedThrough) {
      out.kv('context_shown_at', f.idx);
      continue;
    }
    if (start > 0 && start === printedThrough + 1 && i > 0) out.kv('context_continues_from', start);
    const slice = [];
    for (let j = start; j <= f.idx; j++) slice.push([j, j === f.idx, lines[j].raw]);
    out.table(['idx', 'anchor', 'line'], slice);
    printedThrough = f.idx;
  }
}

function runOnce() {
  let lines;
  try {
    lines = readTrace(TRACE_FILE);
  } catch (e) {
    console.error(`trace_monitor: cannot read trace — ${e.message}`);
    process.exit(1);
  }
  const flags = detect(lines);
  out.kv('lens', 'digest');
  out.kv('record', path.basename(TRACE_FILE));
  out.kv('lines_read', lines.length);
  printDigest(lines);

  // Full warning list: every ⚠️ in the latest run, not just the ones a signature flagged.
  const warns = warningsDigest(lines);
  out.section('warnings');
  out.kv('warnings', warns.reduce((a, w) => a + w.n, 0));
  out.kv('warnings_distinct', warns.length);
  if (warns.length) out.table(['at', 'at_sec', 'bot', 'count', 'text'],
    warns.map(w => [relativeTime(w.firstRel || 0), w.firstRel || 0, w.bot, w.n, w.text]));

  summarizeFlags(flags);
  if (flags.length === 0) process.exit(0);
  if (!QUIET) printFlags(lines, flags);
  process.exit(2);
}

// The per-signature tally, as fields and a table.
function summarizeFlags(flags) {
  const counts = new Map();
  for (const f of flags) counts.set(f.sig, (counts.get(f.sig) || 0) + 1);
  out.section('flag_counts');
  out.kv('flags', flags.length);
  out.kv('signatures_fired', counts.size);
  if (counts.size) out.table(['signature', 'count'], [...counts]);
}

// ── Activity view (context channel, never flags) ─────────────────────────────
// The decision spine, latest run only: what the board offered, which job a bot picked, how it ended.
//   JOB BOARD (options) → storage stock → Claimed (the pick) → COMPLETE/STUCK.
const ACTIVITY_PATTERNS = [
  /\[JOB_BOARD\].*JOB BOARD:/,        // "──── JOB BOARD: N job(s) ────"
  /\[JOB_BOARD\].*\bP\d+ \w+\//,       // the ranked job list (P10 supply/charcoal …)
  /\[JOB_BOARD\].*storage \w+:/,     // per-item storage stock (storage logs:25/25 ✓)
  /\[DISPATCHER\].*\bClaimed /,        // the job the bot picked
  /\[DISPATCHER\].*Magnet cleared/,    // bot went idle (board empty / killed)
  /_MANAGER\].*(COMPLETE|STUCK|RELEASE)/, // how the picked job ended
  /\[RECURSIVE_JUDGE\].*stopped an (infinite loop|AB)/, // a kill (the loud outcome)
];

function runActivity() {
  let lines;
  try {
    lines = readTrace(TRACE_FILE);
  } catch (e) {
    console.error(`trace_monitor: cannot read trace — ${e.message}`);
    process.exit(1);
  }
  const segs = segmentRuns(lines);
  const seg = segs[segs.length - 1] || [];
  const rows = seg.filter(l =>
    (!BOT_FILTER || l.bot === BOT_FILTER) &&
    ACTIVITY_PATTERNS.some(p => p.test(l.raw)));

  out.kv('lens', 'activity');
  out.kv('record', path.basename(TRACE_FILE));
  out.kv('bot_filter', BOT_FILTER);
  out.kv('run', 'latest');
  out.kv('lines_matched', rows.length);
  if (rows.length) {
    out.section('activity');
    out.list('line', rows.map(l => l.raw));
  }
  process.exit(0);
}

// ── Story view (context channel, never flags) ────────────────────────────────
// The bot's own narrative, one block per dispatched job: Claimed → COMPLETE/STUCK/RELEASE, with
// problems and verdict. Clean jobs collapse to one line; a job with any issue prints the full block.

function runStory() {
  let lines;
  try {
    lines = readTrace(TRACE_FILE);
  } catch (e) {
    console.error(`trace_monitor: cannot read trace — ${e.message}`);
    process.exit(1);
  }
  const segs = segmentRuns(lines);
  const seg = segs[segs.length - 1] || [];
  const episodes = buildEpisodes(seg).filter(ep => !BOT_FILTER || ep.bot === BOT_FILTER);

  const full = has('all');
  out.kv('lens', 'story');
  out.kv('record', path.basename(TRACE_FILE));
  out.kv('bot_filter', BOT_FILTER);
  out.kv('run', 'latest');
  out.kv('episodes', episodes.length);
  out.kv('every_episode_in_full', full);
  if (episodes.length) {
    out.section('story');
    out.table(EPISODE_FIELDS, episodes.flatMap(ep => episodeRows(ep, full)));
  }
  process.exit(0);
}

// ── Progress view (context channel, never flags) ─────────────────────────────
// Answers whether a structure is still progressing or just looping. Per structure: first → peak → last correct-count
// with the moment each was reached, and a verdict (COMPLETE / RISING / STALLED). Also tallies
// all_complete vs blocked outcomes landed after the peak, for oscillating livelock.
function runProgress() {
  let lines;
  try { lines = readTrace(TRACE_FILE); }
  catch (e) { fail(`cannot read trace — ${e.message}`); }
  const segs = segmentRuns(lines);
  const seg = segs[segs.length - 1] || [];

  const BUILD_RE = /"([^"]+)" is (\d+)\/(\d+) voxels correct/;
  const MINE_RE = /excavate frontier:.*?\bbuilt (\d+)\/(\d+) shaft_center=\(([^)]+)\)/;
  const OUTCOME_RE = /build_executor: "([^"]+)" (all_complete|blocked_remainder|blocked)/;
  const CUBES_FINISHED_RE = /CUBES_FINISHED done=(\d+) of=(\d+)/;
  const { COLUMN_TRIP_RE } = require('./census_lens');
  const seenTrip = new Set();
  let columnPlaced = 0;

  const struct = new Map();   // key → { total, first:{t,c}, peak:{t,c}, last:{t,c}, complete:0, blocked:0 }
  const note = (key, total, t, c) => {
    let s = struct.get(key);
    if (!s) { s = { total, first: { t, c }, peak: { t, c }, last: { t, c }, complete: 0, blocked: 0 }; struct.set(key, s); }
    if (c > s.peak.c) s.peak = { t, c };
    s.last = { t, c };
    s.total = total;
  };
  let maxRel = 0;
  for (const l of seg) {
    if (l.relSec == null) continue;
    if (PASSIVE_LINE.test(l.raw)) continue;
    maxRel = Math.max(maxRel, l.relSec);
    let m;
    if ((m = l.raw.match(BUILD_RE))) note(`build:${m[1]}`, +m[3], l.relSec, +m[2]);
    // A finished structure's wordless "matches the blueprint" line carries no count of its own;
    // re-noted at the full total (Law 6/13).
    else if ((m = l.raw.match(BUILD_DONE_RE))) {
      const s = struct.get(`build:${m[1]}`);
      if (s) note(`build:${m[1]}`, s.total, l.relSec, s.total);
    }
    else if ((m = l.raw.match(MINE_RE))) note(`mine:${m[3]}`, +m[2], l.relSec, +m[1]);
    // A downloaded building is raised cube by cube and never scanned whole, so it has two rows of its
    // own: the cubes counted finished, and the blocks its column trips have placed so far (a running sum
    // with no total, counted once per trip — the trip line reaches the record twice).
    else if ((m = l.raw.match(CUBES_FINISHED_RE))) note('build:anchor_cubes_finished', +m[2], l.relSec, +m[1]);
    else if ((m = l.raw.match(COLUMN_TRIP_RE))) {
      const key = `${l.bot || '?'}|${m[0]}`;
      if (!seenTrip.has(key)) { seenTrip.add(key); columnPlaced += +m[5]; note('build:column_trip_blocks_placed', null, l.relSec, columnPlaced); }
    }
    else if ((m = l.raw.match(OUTCOME_RE))) {
      const s = struct.get(`build:${m[1]}`);
      if (s && s.last.t >= s.peak.t) { if (m[2] === 'all_complete') s.complete++; else s.blocked++; }
    }
  }

  out.kv('lens', 'progress');
  out.kv('record', path.basename(TRACE_FILE));
  out.kv('run', 'latest');
  out.kv('span', relativeTime(maxRel));
  out.kv('span_sec', maxRel);
  out.kv('progress_tail_sec', PROGRESS_TAIL_SEC);
  out.kv('structures', struct.size);
  if (struct.size === 0) process.exit(0);

  let lastProgressT = 0, lastProgressKey = null;
  const rows = [];
  for (const [key, s] of struct) {
    const done = s.total != null && s.last.c >= s.total;
    const rising = s.peak.t >= maxRel - PROGRESS_TAIL_SEC;
    rows.push([key, s.total, s.first.c, relativeTime(s.first.t), s.peak.c, relativeTime(s.peak.t),
      s.last.c, relativeTime(s.last.t),
      done ? 'COMPLETE' : rising ? 'RISING' : 'STALLED',
      done || rising ? null : maxRel - s.peak.t,
      s.complete, s.blocked, !done && s.complete > 0 && s.blocked > 0]);
    if (s.peak.t > lastProgressT) { lastProgressT = s.peak.t; lastProgressKey = key; }
  }
  out.section('structure_ledger');
  out.table(['structure', 'total', 'first', 'first_at', 'peak', 'peak_at', 'last', 'last_at',
    'verdict', 'stalled_sec', 'all_complete_after_peak', 'blocked_after_peak',
    'mixed_outcomes_after_peak'], rows);

  const idle = maxRel - lastProgressT;
  out.section('net_progress');
  out.kv('last_net_new_progress', relativeTime(lastProgressT));
  out.kv('last_net_new_progress_sec', lastProgressT);
  out.kv('last_net_new_progress_structure', lastProgressKey);
  out.kv('idle', relativeTime(idle));
  out.kv('idle_sec', idle);
  out.kv('idle_percent_of_run', Math.round(100 * idle / (maxRel || 1)));
  out.kv('progress_tail_sec', PROGRESS_TAIL_SEC);
  out.kv('looping', idle > PROGRESS_TAIL_SEC);
  process.exit(0);
}

// ── Query mode (addressable slice — context channel, never flags) ──────────────
// Lines around THIS moment / tag / bot, an explicit range, or both. Every filter is ANDed.
//
//   --around=<time>   anchor; ±25 matching lines by default. time = 1m1s | "1m 1s" | 90s | 90 | ISO.
//   --lines=<N>       lines each side of the anchor (default 25).
//   --window=<sec> | --before=<sec> | --after=<sec>   a time window instead of the count.
//   --from=<time> --to=<time>   an explicit range instead of --around.
//   --tag=<T[,T…]>    only lines carrying [T], case-insensitive.
//   --bot=<Bot>       only that bot's lines.        --level=<error|warn|summary|infra>   only that level.
//   --grep=<regex>    only lines matching.   --run=<latest|N|all>   which run segment.

// "1m1s" | "1m 1s" | "90s" | "90" | "2m" → {relSec}; any ISO/Date-parseable string → {isoMs}.
function parseTimeToken(tok) {
  if (tok == null) return null;
  const t = String(tok).trim();
  const rel = t.match(/^(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i);
  if (rel && (rel[1] || rel[2])) return { relSec: (+(rel[1] || 0)) * 60 + (+(rel[2] || 0)) };
  if (/^\d+$/.test(t)) return { relSec: +t };            // bare number = seconds
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : { isoMs: ms };
}
function parseDurationSec(tok, dflt) {
  const p = parseTimeToken(tok);
  return p && p.relSec != null ? p.relSec : dflt;
}
function lineIsoMs(l) {
  return l.iso && !Number.isNaN(Date.parse(l.iso)) ? Date.parse(l.iso) : null;
}

function runQuery() {
  let lines;
  try { lines = readTrace(TRACE_FILE); }
  catch (e) { fail(`cannot read trace — ${e.message}`); }

  const scope = runScope(lines);

  const preds = [];
  if (BOT_FILTER) preds.push(l => l.bot === BOT_FILTER);

  const tags = (opt('tag', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (tags.length) preds.push(l => tags.some(t => l.raw.toUpperCase().includes(`[${t}]`)));

  const level = opt('level', null);
  if (level) preds.push(l => l.level === level);

  const grep = opt('grep', null);
  if (grep) { const re = new RegExp(grep, 'i'); preds.push(l => re.test(l.raw)); }

  // Filter first (bot/tag/level/grep), then slice by time/anchor.
  const filtered = scope.filter(l => preds.every(p => p(l)));
  const aroundTok = opt('around', null), fromTok = opt('from', null), toTok = opt('to', null);
  const timeWindowGiven = args.some(a => /^--(window|before|after)=/.test(a));
  // `slice`: [field, value] pairs describing how the slice was cut.
  let rows; const slice = [];

  if (aroundTok != null) {
    const a = parseTimeToken(aroundTok);
    if (!a) fail(`--around='${aroundTok}' is not a time (use 1m1s | "1m 1s" | 90s | an ISO stamp).`);
    const useIso = a.isoMs != null;
    const anchorVal = useIso ? a.isoMs : a.relSec;
    const pos = l => (useIso ? lineIsoMs(l) : l.relSec);     // this line's position on the chosen axis
    const anchorLabel = useIso ? new Date(anchorVal).toISOString() : relativeTime(anchorVal);
    slice.push(['anchor', anchorLabel], ['anchor_axis', useIso ? 'absolute' : 'relative']);

    if (timeWindowGiven) {
      const before = parseDurationSec(opt('before', opt('window', null)), 60);
      const after = parseDurationSec(opt('after', opt('window', null)), 60);
      const lo = anchorVal - before * (useIso ? 1000 : 1);
      const hi = anchorVal + after * (useIso ? 1000 : 1);
      rows = filtered.filter(l => { const v = pos(l); return v != null && v >= lo && v <= hi; });
      slice.push(['mode', 'time_window'], ['before_sec', before], ['after_sec', after]);
    } else {
      // Count window (default): N matching lines each side of the anchor line.
      const N = parseInt(opt('lines', '25'), 10);
      let idx = -1, best = Infinity;
      for (let i = 0; i < filtered.length; i++) {
        const v = pos(filtered[i]);
        if (v == null) continue;
        const d = Math.abs(v - anchorVal);
        if (d < best) { best = d; idx = i; }
      }
      slice.push(['mode', 'line_count'], ['lines_each_side', N]);
      if (idx < 0) {
        rows = [];
        slice.push(['anchor_found', false]);
      } else {
        rows = filtered.slice(Math.max(0, idx - N), Math.min(filtered.length, idx + N + 1));
        const at = filtered[idx].relSec != null ? relativeTime(filtered[idx].relSec) : filtered[idx].iso;
        slice.push(['anchor_found', true], ['anchor_match_index', idx], ['anchor_match_at', at]);
      }
    }
  } else if (fromTok != null || toTok != null) {
    const f = fromTok != null ? parseTimeToken(fromTok) : null;
    const t = toTok != null ? parseTimeToken(toTok) : null;
    if (fromTok != null && !f) fail(`--from='${fromTok}' is not a time.`);
    if (toTok != null && !t) fail(`--to='${toTok}' is not a time.`);
    const useIso = (f && f.isoMs != null) || (t && t.isoMs != null);
    if (useIso) {
      const lo = f && f.isoMs != null ? f.isoMs : -Infinity;
      const hi = t && t.isoMs != null ? t.isoMs : Infinity;
      rows = filtered.filter(l => { const m = lineIsoMs(l); return m != null && m >= lo && m <= hi; });
      slice.push(['mode', 'range'], ['range_axis', 'absolute'],
        ['range_from', fromTok], ['range_to', toTok]);
    } else {
      const lo = f ? f.relSec : -Infinity, hi = t ? t.relSec : Infinity;
      rows = filtered.filter(l => l.relSec != null && l.relSec >= lo && l.relSec <= hi);
      slice.push(['mode', 'range'], ['range_axis', 'relative'],
        ['range_from', f ? relativeTime(f.relSec) : null], ['range_from_sec', f ? f.relSec : null],
        ['range_to', t ? relativeTime(t.relSec) : null], ['range_to_sec', t ? t.relSec : null]);
    }
  } else {
    rows = filtered;
    slice.push(['mode', 'whole_run']);
  }
  // `lines_matched`: `Auren_Workshop/run.js` reads this field to decide whether the run record is clean.
  out.kv('lens', 'query');
  out.kv('record', path.basename(TRACE_FILE));
  out.kv('run', opt('run', 'latest'));
  out.kv('bot_filter', BOT_FILTER);
  out.kv('tag_filter', tags.length ? tags.join(',') : null);
  out.kv('level_filter', level);
  out.kv('grep_filter', grep);
  for (const [k, v] of slice) out.kv(k, v);
  out.kv('lines_in_run', scope.length);
  out.kv('lines_after_filters', filtered.length);
  out.kv('lines_matched', rows.length);
  if (rows.length) {
    out.section('lines');
    out.list('line', rows.map(l => l.raw));
  }
  process.exit(0);
}

// ── Watch mode ───────────────────────────────────────────────────────────────
// Re-reads the trace on a cadence and reports only flags anchored in NEW lines.
function runWatch() {
  const t0 = Date.now();
  let knownLines = null;      // null until the baseline read — history is never "new"
  let reported = new Set();   // `${sig}:${bot}:${idx}` already shown
  let flagged = false;
  out.kv('lens', 'watch');
  out.kv('record', path.basename(TRACE_FILE));
  out.kv('interval_sec', WATCH_INTERVAL_SEC);
  out.kv('max_minutes', MAX_MINUTES);
  out.kv('exit_on_flag', EXIT_ON_FLAG);
  out.kv('exit_on_signatures', [...EXIT_ON_SIGS].join(','));

  // Live status field: on a TTY, overwrites one status line each tick; off a TTY, appends once a minute.
  const TTY = !!process.stdout.isTTY;
  const endLiveLine = () => out.tickerEnd();

  let lastHeartbeat = Date.now();
  let freezeAt = null;   // newestBotMs already flagged as frozen; cleared when a newer line lands
  let streamedThrough = 0;   // idx up to which --stream lines have already been echoed (0 = none yet)
  const tick = () => {
    const elapsedMin = (Date.now() - t0) / 60000;
    if (elapsedMin >= MAX_MINUTES) {
      endLiveLine();
      out.section('watch_end');
      out.kv('elapsed_min', Math.floor(elapsedMin));
      out.kv('max_minutes', MAX_MINUTES);
      out.kv('window_served', true);
      out.kv('flagged', flagged);
      process.exit(flagged ? 2 : 0);
    }
    let lines;
    try {
      lines = readTrace(TRACE_FILE);
    } catch (_) {
      setTimeout(tick, WATCH_INTERVAL_SEC * 1000);   // mid-rename read — next tick wins
      return;
    }
    if (knownLines === null) {
      // Baseline: pre-existing warnings don't count as new. Errors/halts/deaths are exempt (WAKE_SIGS).
      knownLines = lines.length;
      streamedThrough = lines.length;
      out.kv('baseline_line', knownLines);
      if (ERRORS_KNOWN > 0) {
        const prior = detect(lines).filter(f => WAKE_SIGS.has(f.sig)).slice(0, ERRORS_KNOWN);
        const kinds = [...new Set(prior.map(f => f.sig))].join('/') || 'wake';
        for (const f of prior) reported.add(`${f.sig}:${f.bot}:${f.idx}`);
        out.kv('handed_off_episodes', prior.length);
        out.kv('handed_off_asked', ERRORS_KNOWN);
        out.kv('handed_off_signatures', kinds);
      }
    } else if (lines.length < knownLines) {
      // A shrinking story means the foreman restarted.
      out.section('trace_reset');
      out.kv('lines_before', knownLines);
      out.kv('lines_after', lines.length);
      reported = new Set();
      knownLines = 0;
      streamedThrough = 0;
    }

    // Live decision stream (watch-only): echo every NEW --stream-tagged line as it lands.
    if (STREAMING && streamedThrough < lines.length) {
      const fresh = [];
      for (let i = streamedThrough; i < lines.length; i++) {
        if (streamMatch(lines[i].raw)) fresh.push(lines[i].raw);
      }
      streamedThrough = lines.length;
      if (fresh.length) { endLiveLine(); out.list('line', fresh); }
    }
    // Whole-fleet wall-clock freeze: newest bot line's absolute time against the wall clock, read from
    // per-bot files (Law 25).
    const hb = readBotHeartbeats();
    let newestBotMs = null;
    for (const h of hb.values()) newestBotMs = Math.max(newestBotMs ?? 0, h.at.getTime());
    if (newestBotMs === null) {
      const botLines = lines.filter(l => l.bot && !FOREMAN_UNITS.has(l.bot) && l.iso);
      newestBotMs = botLines.length ? botLines.reduce((mx, l) => Math.max(mx, Date.parse(l.iso)), 0) : null;
    }
    if (newestBotMs && Date.now() - newestBotMs > SILENCE_GAP_SEC * 1000) {
      if (freezeAt !== newestBotMs) {
        freezeAt = newestBotMs;
        const lagSec = Math.round((Date.now() - newestBotMs) / 1000);
        endLiveLine();
        out.section('fleet_freeze');
        out.kv('fleet_frozen', true);
        out.kv('silence_gap_sec', lagSec);
        out.kv('silence_threshold_sec', SILENCE_GAP_SEC);
        out.kv('last_bot_line_at', new Date(newestBotMs).toISOString());
        flagged = true;
        // Rides with `error`: not one of the `detect` signatures, so it has no `sig` to match.
        if (EXIT_ON_FLAG && EXIT_ON_SIGS.has('error')) {
          out.kv('exit_for_handoff', 'fleet_freeze');
          out.kv('exit_code', EXIT_EARLY_CODE);
          process.exit(EXIT_EARLY_CODE);
        }
      }
    } else if (newestBotMs) {
      freezeAt = null;   // a fresh bot line landed — fleet is alive, re-arm
    }

    // Errors, judge-halts and deaths always wake (any idx). Every other signature stays baseline-relative.
    const news = detect(lines)
      .filter(f => f.sig === 'error' || f.sig === 'halt' || f.sig === 'death' || f.idx >= knownLines)
      .filter(f => !reported.has(`${f.sig}:${f.bot}:${f.idx}`));
    knownLines = lines.length;
    for (const f of news) reported.add(`${f.sig}:${f.bot}:${f.idx}`);
    if (news.length > 0) {
      endLiveLine();
      // --follow suppresses the flag blocks (not the flagging); `--flags` restores them.
      if (!FOLLOW || has('flags')) printFlags(lines, news);
      const wake = news.filter(f => WAKE_SIGS.has(f.sig));
      if (wake.length > 0) {
        flagged = true;
        const enders = wake.filter(f => EXIT_ON_SIGS.has(f.sig));
        if (EXIT_ON_FLAG && enders.length > 0) {
          out.kv('exit_for_handoff', [...new Set(enders.map(f => f.sig))].join(','));
          out.kv('exit_code', EXIT_EARLY_CODE);
          process.exit(EXIT_EARLY_CODE);
        }
      }
    } else {
      // Quiet: refresh the all-bots status field.
      const rows = watchStatusRows(lines);
      if (TTY) {
        out.ticker(watchStatusLine(rows, elapsedMin));
      } else if (Date.now() - lastHeartbeat >= 60000) {
        lastHeartbeat = Date.now();
        out.section('watch_quiet');
        out.kv('watch_min', Math.floor(elapsedMin));
        out.kv('bots', rows.length);
        if (rows.length) out.table(WATCH_FIELDS, rows);
      }
    }
    setTimeout(tick, WATCH_INTERVAL_SEC * 1000);
  };
  tick();
}

// The run segment `--run` names: the latest by default, the Nth counted from 1, or every run's lines (Law 16).
function runScope(lines) {
  const segs = segmentRuns(lines);
  const runSel = opt('run', 'latest');
  return runSel === 'all' ? lines
    : /^\d+$/.test(runSel) ? (segs[+runSel - 1] || [])
    : (segs[segs.length - 1] || []);
}

// Read the trace and hand back the run segment `--run` names, for every lens.
function selectedSegment() {
  return runScope(wholeTrace());
}

// The same read, unsegmented, for --narration. Naming a camera unit (BOT_FILTER starting `camera_`)
// opens the camera view instead of the fleet trace; a positional path always overrides.
const wantsCameraView = () => !args.some(a => !a.startsWith('--'))
  && !!BOT_FILTER && String(BOT_FILTER).toLowerCase().startsWith('camera_');

// What a rendered header calls the record it read (Law 24).
const traceLabel = () => (wantsCameraView() ? 'watcher_camera_*.jsonl' : path.basename(TRACE_FILE));

function wholeTrace() {
  try {
    if (wantsCameraView()) return readCameraView(path.dirname(DEFAULT_TRACE_FILE));
    return readTrace(TRACE_FILE);
  } catch (e) {
    console.error(`trace_monitor: cannot read trace — ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  // Lenses RETURN (libraries); this CLI owns the exit.
  const lensOpts = () => ({ seg: selectedSegment(), traceName: traceLabel(), bot: BOT_FILTER });
  const runLens = (fn, extra = {}) => { fn({ ...lensOpts(), ...extra }); process.exit(0); };
  const verbose = has('all');

  if (has('outcome')) { require('./run_outcome_lens').runOutcome(); process.exit(0); }
  else if (LASTPOST) { printLastPost(); process.exit(0); }
  else if (STORY) runStory();
  else if (PROGRESS) runProgress();
  else if (PATHFINDING) runLens(locomotionLenses.runPathfinding);
  else if (WALKING) runLens(require('./walking_lens').runWalking, { verbose });
  else if (TREES) runLens(require('./tree_search_lens').runTreeSearch, { verbose });
  else if (STEPS) runLens(require('./step_failure_lens').runSteps, { verbose });
  else if (GATE) runLens(require('./planning_gate_lens').runGate, { verbose });
  else if (LAG) runLens(require('./server_lag_lens').runLag, { verbose });
  else if (ROUTECOST) runLens(locomotionLenses.runRouteCost, { over: parseInt(opt('over', '60'), 10) || 60 });
  else if (JUMPS) runLens(locomotionLenses.runJumps);
  else if (HUNGER) runLens(require('./hunger_lens').runHunger);
  else if (MILESTONES) runLens(buildLenses.runMilestones, { deadlineSec: MS_DEADLINE_SEC, verbose });
  else if (TORCH) runLens(buildLenses.runTorchClock, { deadlineSec: MS_DEADLINE_SEC });
else if (FARM) runLens(require('./farm_lens').runFarm, { verbose });
  else if (JOBS) runLens(require('./job_timeline_lens').runJobTimeline, { verbose });
  else if (PLANNING) runLens(require('./planning_lens').runPlanning, { budgetSec: PLAN_BUDGET_SEC });
  else if (TOOLKIT) runLens(require('./job_timeline_lens').runToolkit, {});
  else if (CENSUS) runLens(require('./census_lens').runCensus, { verbose });
  else if (ACCOUNTING) runLens(require('./accounting_lens').runAccounting, { verbose });
  else if (WARNINGS) runLens(require('./warnings_lens').runWarnings, { verbose });
  else if (WITNESS) { recordingLens('combat_witness_lens', '--witness').runWitness({ bot: BOT_FILTER, verbose }); process.exit(0); }
  else if (CAMERA) { recordingLens('camera_lens', '--camera').runCamera({ bot: BOT_FILTER, verbose }); process.exit(0); }
  else if (FOREMAN) { require('./foreman_lens').runForeman({ bot: BOT_FILTER, verbose }); process.exit(0); }
  else if (MACHINE_LOAD) {
    const record = has('run-only') ? require('./run_outcome_lens').readOutcome() : null;
    if (has('run-only') && !record) throw new Error('machine-load --run-only requires the finished run_outcome record.');
    recordingLens('machine_load_lens', '--machine-load').runMachineLoad({
      label: opt('label', null),
      fromMs: record ? Date.parse(record.started_at) : null,
      toMs: record ? Date.parse(record.ended_at) : null,
    });
    process.exit(0);
  }
  else if (NARRATION) {
    const all = wholeTrace();
    require('./narration_lens').runNarration({
      seg: NARRATION_FULL ? all : selectedSegment(),
      allLines: all, bot: BOT_FILTER, traceName: traceLabel(),
      verbose, full: NARRATION_FULL,
    });
    process.exit(0);
  }
  else if (COMPOST) runLens(chainLenses.runCompost, { verbose });
  else if (ITEMS) { require('./item_book_lens').runItems({ bot: BOT_FILTER, verbose }); process.exit(0); }
  else if (INVENTORY) runLens(require('./inventory_lens').runInventory, { verbose });
  else if (ENGAGEMENT) runLens(require('./engagement_lens').runEngagement, { verbose });
  else if (ACTIVITY) runActivity();
  else if (WATCH) runWatch();
  else if (QUERY) runQuery();
  else runOnce();
}


// Read-only observer surface for monitoring/dashboard.js. The require.main guard above keeps this
// inert when required (Law 16).
module.exports = { detect, computeBotStats, sigJudgeHalt, SIGNATURES, WAKE_SIGS, isDeathClass };
