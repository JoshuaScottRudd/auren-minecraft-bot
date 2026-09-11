// Auren_Bot/monitoring/dashboard.js
// The Architect's LIVE observer state — a single JSON file (fleet_logs/traces/dashboard.json) that is
// OVERWRITTEN whole every tick with the current fleet picture: per-bot VITALS (📊/⚠️/❌ counts,
// liveness, last-activity) merged with HQ PROGRESS (structures done, each bot's current task, queue).
//
// WHY a file, not a terminal (Architect, 2026-07-14): a live in-terminal panel needs ANSI cursor
// control, which renders inconsistently across his environments (the "stacking wall" bug). A plain
// JSON file has no rendering at all — he keeps it open in the editor, which live-reloads on each
// overwrite, so the FILE is his visible accountability surface (his "no invisible window" rule, re-
// tuned at the table: the window is the file). Single writer, no concurrent readers, so a plain whole-
// file overwrite is safe and simple (Law 9: writes only its own file; Law 6: filename matches unit).
//
// Quiet runs stay quiet: a healthy fleet shows the vitals + `alerts: []`. When a trace signature fires
// (error, judge-halt, warn-burst, regression…) it is posted into the `alerts` array WITH its context
// slice — "errors like normal", but in the JSON instead of a scrolling terminal. The per-bot `errors`
// count and `status:"halted"` are the at-a-glance cue; `alerts` carries the detail. The machine
// wake-arm (paging the AI dev) is still a separate `trace_monitor --watch --exit-on-flag` — two
// observers of the trace, one file with one writer (this tool).
//
// It COMPOSES the two read-only observers rather than re-reading their sources (Law 16): trace vitals
// via trace_monitor.computeBotStats/sigJudgeHalt, HQ progress via progress_tracker.computeSnapshot. It
// invents no reading and, like both, lives OUTSIDE the construct — touches no bot, no signal bus.
//
// Usage:  node dashboard.js [traceFile] [--interval=2] [--out=<path>] [--once]
//         .\Auren_Bot\Auren_Workshop\scripts\dashboard.ps1        (from the Architect's repo root)
//         .\Auren_Workshop\scripts\dashboard.ps1                  (from a download's Auren_Bot root)
// Exit: runs until Ctrl-C (or --once: writes a single snapshot and exits 0).

'use strict';

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
  || require(paths.bot('js_kernel/utils/record_homes')).traceFile('overseer');
// Written into the records room, not the kernel: the kernel holds what a bot needs to RUN, and
// nothing in the fleet reads this — it is an observer's output for a human's editor (Architect
// 2026-08-31).
const OUT_FILE = opt('out', path.join(require(paths.bot('js_kernel/utils/record_homes')).TRACE_DIR, 'dashboard.json'));
const ALERT_CONTEXT = 6;   // raw trace lines kept above each posted anomaly (the "like normal" slice)

function agoShort(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
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
    // Post every anomaly the trace signatures fire in the LATEST run — "errors like normal", but into
    // the JSON instead of a terminal. The dashboard stays the SINGLE writer of dashboard.json and
    // REUSES trace_monitor's detect() (Law 16) rather than letting trace_monitor write the file too —
    // one file, one owner (Law 6/9, Invariant D). A clean run → []; the whole set is re-snapshotted
    // each tick (no stream/dedup — the file always shows the current outstanding anomalies).
    alerts = trace.detect(seg).map(f => ({
      sig: f.sig,
      bot: f.bot,
      reason: f.reason,
      context: lines.slice(Math.max(0, f.idx - ALERT_CONTEXT), f.idx + 1).map(l => l.raw),
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
    const doing = doingById[id] && doingById[id] !== 'idle' ? doingById[id] : null;
    // status = the Architect's "active or not" cue: a judge-killed bot is inert; a bot with an HQ task
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
          state: s.complete ? 'complete' : s.state,
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
  console.log(`dashboard: wrote one snapshot → ${OUT_FILE}`);
  process.exit(0);
}

console.log(`dashboard → overwriting ${OUT_FILE} every ${INTERVAL}s. Open it in the editor to watch. Ctrl-C to stop.`);
process.on('SIGINT', () => { console.log('\ndashboard: stopped.'); process.exit(0); });   // Law 8: clean end

const tick = () => { write(); setTimeout(tick, INTERVAL * 1000); };
tick();
