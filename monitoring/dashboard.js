// Auren_Bot/monitoring/dashboard.js
// The fleet's LIVE observer state — a single JSON file (fleet_logs/traces/dashboard.json) OVERWRITTEN
// whole every tick with the current fleet picture: per-bot VITALS (summary/warning/error counts,
// liveness, last-activity) merged with HQ PROGRESS (structures done, each bot's current task, queue).
//
// Written to a plain file, not an in-terminal panel: no rendering step and no cross-environment
// rendering inconsistency, and an editor that live-reloads on each overwrite is the visible surface.
// Single writer, no concurrent readers, so a plain whole-file overwrite is safe and simple (Law 9:
// writes only its own file; Law 6: filename matches unit).
//
// Quiet runs stay quiet: a healthy fleet shows the vitals with `alerts: []`. When a trace signature
// fires (error, judge-halt, warn-burst, regression…) it is posted into the `alerts` array with its
// context slice. The per-bot `errors` count and `status:"halted"` are the at-a-glance cue; `alerts`
// carries the detail. The machine wake-arm (paging the AI dev) stays a separate
// `trace_monitor --watch --exit-on-flag` — two observers of the trace, one file with one writer (this
// tool).
//
// Builds its state by composing the two read-only observers (Law 16): trace vitals via
// trace_monitor.computeBotStats/sigJudgeHalt, HQ progress via progress_tracker.computeSnapshot. It
// invents no reading and, like both, lives outside the construct — touches no bot, no signal bus.
//
// Usage:  node dashboard.js [traceFile] [--interval=2] [--out=<path>] [--once]
//         .\Auren_Bot\Auren_Workshop\scripts\dashboard.ps1        (repo root)
//         .\Auren_Workshop\scripts\dashboard.ps1                  (a download's Auren_Bot root)
// Exit: runs until Ctrl-C (or --once: writes a single snapshot and exits 0).

'use strict';
require('../js_kernel/utils/developer_door').enter('monitoring/dashboard.js');

const fs = require('fs');
const path = require('path');
const paths = require('./lens_paths');
const read = require('./trace_read');
const trace = require('./trace_monitor');
const progress = require('./progress_tracker');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (n, d) => {
  const h = args.find(a => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const INTERVAL = Math.max(1, parseInt(opt('interval', '2'), 10) || 2);
const ONCE = args.includes('--once');
const TRACE_FILE = args.find(a => !a.startsWith('--'))
  || require(paths.bot('js_kernel/utils/record_homes')).traceFile('fleet');
// Written into the records room, not the kernel: the kernel holds what a bot needs to RUN, and nothing
// in the fleet reads this — it is an observer's output for a human's editor.
const OUT_FILE = opt('out', path.join(require(paths.bot('js_kernel/utils/record_homes')).TRACE_DIR, 'dashboard.json'));
const ALERT_CONTEXT = 6;   // raw trace lines kept above each posted anomaly, for context

// An elapsed span, and nothing else — the unit lives in the FIELD NAME that holds this value (`*_ago`),
// not appended to the string.
function agoShort(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

// ── Build the state object ──────────────────────────────────────────────────────
function buildState() {
  // Trace vitals (counts + halt liveness) + alerts. A missing/half-written trace just leaves them blank
  // this tick — the writer never throws and never surfaces the read error (Law 13 soft, SILENT).
  let stats = new Map();
  const halted = new Set();
  let alerts = [];
  try {
    const lines = read.readTrace(TRACE_FILE);
    stats = trace.computeBotStats(lines);
    const segs = read.segmentRuns(lines);
    const seg = segs[segs.length - 1] || [];
    for (const f of trace.sigJudgeHalt(seg)) halted.add(f.bot);
    // Posts every anomaly the trace signatures fire in the LATEST run into the JSON. The dashboard stays
    // the SINGLE writer of dashboard.json and reuses trace_monitor's detect() (Law 16) — one file, one
    // owner (Law 6/9, Invariant D). A clean run → []; the whole set is re-snapshotted each tick (no
    // stream/dedup — the file always shows the current outstanding anomalies).
    // ── A FLAG CARRIES FIELDS, NOT A `reason` SENTENCE ────────────────────────────────
    // Each signature's own fields are spread in beside sig/bot: `count`/`text` for an error,
    // `gap_sec`/`threshold_sec` for a silence, `from`/`to`/`drop`/`tolerance` for a regression. The
    // shape is the flag's, so a signature that learns a new field posts it here with no edit to this
    // file (Law 16 — trace_monitor owns what a flag says, this file only places it). `idx` stays out: it
    // is an offset into a trace parse this JSON's reader does not have.
    alerts = trace.detect(seg).map(({ idx, ...f }) => ({
      ...f,
      context: lines.slice(Math.max(0, idx - ALERT_CONTEXT), idx + 1).map(l => l.raw),
    }));
  } catch (_) { /* trace not present yet */ }

  // HQ progress (structures, doing-now, queue).
  let snap = null;
  try {
    const files = progress.loadHqFiles();
    if (files.length) snap = progress.computeSnapshot(files);
  } catch (_) { /* HQ not present yet */ }

  // Roster: prefer HQ's live boardroom (authoritative), fall back to whoever is in the trace.
  const roster = snap ? snap.bots.map(b => b.id) : [...stats.keys()];
  const doingById = {};
  if (snap) for (const b of snap.bots) doingById[b.id] = b.doing;

  const bots = roster.map(id => {
    const s = stats.get(id) || { s: 0, w: 0, e: 0, lastRel: 0 };
    const isHalted = halted.has(id);
    // `doing` is null when a bot holds no magnet.
    const doing = doingById[id] || null;
    // status = the operator's "active or not" cue: a judge-killed bot is inert; a bot with an HQ task
    // is working; otherwise alive but idle. No error TEXT — `errors` is the only error signal, a number.
    const status = isHalted ? 'halted' : (doing ? 'active' : 'idle');
    return {
      id,
      status,
      doing,
      summaries: s.s,
      warnings: s.w,
      errors: s.e,
      last_activity: read.relativeTime(s.lastRel || 0),
      halted: isHalted,
    };
  });

  return {
    updated: new Date().toISOString(),
    hq_age: snap ? agoShort(snap.updatedAt) : '—',
    alerts,
    bots,
    structures: snap
      ? {
        done: snap.structures.done,
        total: snap.structures.total,
        items: snap.structures.items.map(s => ({
          name: s.name,
          complete: s.complete,
          state: s.state,
        materials: s.materials,
        })),
      }
      : null,
    queue: snap ? { count: snap.queue.count, list: snap.queue.list ? snap.queue.list.split(' · ') : [] } : null,
    site: snap ? snap.site : [],
  };
}

// ── Write ────────────────────────────────────────────────────────────────────────
function write() {
  fs.writeFileSync(OUT_FILE, JSON.stringify(buildState(), null, 2));
}

// ── Run ─────────────────────────────────────────────────────────────────────────
if (ONCE) {
  write();
  // OPERATIONAL CHATTER GOES TO stderr. This daemon's ANSWER is dashboard.json,
  // which is already pure data; these three lines are the process telling you it is alive, and stdout is
  // reserved for the answer so nothing can smuggle a sentence onto that channel.
  console.error(`dashboard: wrote one snapshot → ${OUT_FILE}`);
  process.exit(0);
}

console.error(`dashboard → overwriting ${OUT_FILE} every ${INTERVAL}s. Open it in the editor to watch. Ctrl-C to stop.`);
process.on('SIGINT', () => { console.error('\ndashboard: stopped.'); process.exit(0); });   // Law 8: clean end

const tick = () => { write(); setTimeout(tick, INTERVAL * 1000); };
tick();
