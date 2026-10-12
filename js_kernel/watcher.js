// module: watcher — diagnostic logging (Law 5/6). One story file (watcher_<BotId>.json) with three
// persisted levels, all print AND persist, never suppressed (Law 16: one pathway):
//   summary() 📊 — one aggregated line per completed phase; read only summaries to know what ran,
//                  how long, and whether it worked.
//   warn()    ⚠️ — environmental failure / retry / degraded op the system recovered from.
//   error()   ❌ — unrecoverable; auto-dumps the deferred buffer first so context is never lost.
//
// buffer — per-stage context held in memory, reaching disk only if error() dumps it; summary()
//          clears it on a clean phase.
// track() — wraps a fn to record entry/exit/duration to in-memory history only.
//
// Deep "how did it decide" visibility on a normal run is the separate trace file, gated by
// ENABLE_TRACE below.

// ── Watcher configuration ──
// ENABLE_TRACE: master switch for the deep per-fragment trace file (watcher_<BotId>_trace.json),
// mirroring every log call grouped by fragment. The story log stays three persisted levels either
// way (Law 5).
const ENABLE_TRACE = false;
const TRACE_MAX_PER_STAGE = 5000; // per-fragment ring cap on the trace file

// Component filtering for track()/console history (in-memory only — never the story log).
const ENABLE_ALL = false;
const ENABLED_COMPONENTS = ['battle_stations'];
const HIDDEN_COMPONENTS = [];
const HIDDEN_SUBSTRINGS = [];
const ENABLE_WATCHER_LOGS = false;

// ── THE REPORTING SWITCH: which sub-loops narrate a HEALTHY run ──
// ROUTINE_QUIET names sub-loops (Law 15) whose summary() is demoted to the deferred buffer on a
// healthy run: no print, no forward, no story line. warn() and error() are untouched, and error()
// dumps the buffer first, so a failure still arrives with the routine lines that led to it.
//
// Two ways to turn a stage back on, both whitelists:
//   AUREN_VERBOSE=navigator            (comma list, or `all`) — one run, nothing edited
//   add the name to VERBOSE_STAGES below                       — every run on this machine
//
// SOFT_STAGES is the prototype whitelist: a stage listed here narrates in full even when
// ROUTINE_QUIET also names it — a system with no track record has no basis to go quiet. Moving a name
// from SOFT_STAGES to ROUTINE_QUIET is how a stage graduates to quiet-by-default.
const SOFT_STAGES = new Set([
    'pathfinding',             // workspace timing and memory cutoff census is inspectable during the prototype
    'job_board_phase',          // the site-phase ladder (trees → terraform → basement) — prototype
]);
const ROUTINE_QUIET = new Set([
    'navigator',                // A* plans, per-step progress, carve/pillar/unstick — the walking sub-loop
    'pathfinding',              // navigator's own search tag (same sub-loop, second stage name)
    'locomotion_dispatcher',    // route choice and door handling
    'locomotion_judge',         // the walk's verdict on a successful trip
    'job_board_stock',          // the board's per-sweep stock deliberation (its POSTED JOBS stay loud)
]);
// Named here or in AUREN_VERBOSE, a hardened stage reports in full again for one run. Empty is the default.
const VERBOSE_STAGES = new Set(
    String(process.env.AUREN_VERBOSE || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
// A quiet stage still accumulates into its deferred buffer, so the buffer needs its own ceiling; the
// ring keeps the LAST lines, since those are the ones an error wants.
const BUFFER_MAX_PER_STAGE = 200;
function _routineQuiet(stage) {
    if (VERBOSE_STAGES.has('all')) return false;
    const s = String(stage).toLowerCase();
    if (SOFT_STAGES.has(s)) return false;          // a prototype always speaks
    return ROUTINE_QUIET.has(s) && !VERBOSE_STAGES.has(s);
}

const fs = require('fs');
const path = require('path');
const _watcherBotId = process.env.BOT_ID || '';
// A bot process (BOT_ID set) drops its own local echo of the three levels + buffer dump — the story
// file and the foreman forward still receive every line (Law 6). Foreman/standalone prints normally.
// Does not gate _forward or the file writes.
const SILENT_TERMINAL = !!_watcherBotId;
// .jsonl: one JSON-encoded story line per file line, so any character is safe and a torn final line
// can be dropped without losing the ones before it. The record's location is asked from recordHomes,
// never spelled here, so every reader agrees on where it lives.
// Relative require, not `@utils` — this module loads in processes that register no alias table.
const recordHomes = require('./utils/record_homes');
const WATCHER_FILE = recordHomes.traceFile(_watcherBotId);

// The one encoder. Both the async and the sync flush go through it, so the file can never hold two
// shapes (Law 16 — a second stringify site is the drift to watch).
function encodeStoryLines(lines) {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}
// Trace artifact — never mixed into WATCHER_FILE (Law 5: story = one file).
const TRACE_FILE = recordHomes.deepTraceFile(_watcherBotId);

// _selfFault: the watcher's one self-report channel (Law 16) — a logger cannot report its own
// failure through its own levels (warn() → _record → fault → warn() recurses), so internal faults go
// straight to console.error, unconditionally, never gated by SILENT_TERMINAL: a self-fault means the
// forward and the file may themselves be broken, so this is the one line that must print locally.
function _selfFault(where, err) {
  // The one defensible terminal swallow: if console.error itself throws, there is no remaining
  // channel left to report the failure to report.
  try {
    console.error(`[watcher:SELF-FAULT] ${where}: ${err && err.message ? err.message : String(err)}`);
  } catch (_) {}
}

// An invalid ts is a caller bug; it is self-faulted and marked loudly in-band, never thrown, since
// the watcher is passive infrastructure and must never be able to kill the run it observes
// (Law 5, Law 13).
function formatTimestamp(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    _selfFault('formatTimestamp', new Error(`CODING VIOLATION: caller passed a non-date ts: ${JSON.stringify(ts)}`));
    return `INVALID_TS(${String(ts)})`;
  }
  return d.toISOString();
}
function formatDuration(ms) {
  const s = ms / 1000;
  const m = s / 60;
  const h = m / 60;
  return `${ms}ms (${s.toFixed(3)}s | ${m.toFixed(3)}m | ${h.toFixed(3)}h)`;
}

// Runtime tag prepended to every terminal line: elapsed since this process started, re-based by
// resetRuntimeClock() when a run formally begins. Starts at module load, so a process that never
// issues the `start` verb still has a working clock — `monitoring/trace_read.parseLine` derives
// `relSec` from this tag, and every lens ordering events by it depends on it being real from the
// first line (Law 25).
let startTime = Date.now();
function runtimeTag() {
  const elapsed = Date.now() - startTime;
  const totalSec = Math.floor(elapsed / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `[${min}m ${sec}s]`;
}
function resetRuntimeClock() {
  startTime = Date.now();
}

class Watcher {
  constructor(maxLoops = 5) {
    this.enabledComponents = new Set();
    this.hiddenComponents = new Set(HIDDEN_COMPONENTS);
    this.trackAll = ENABLE_ALL;
    this.logBuffer = [];
    this.currentLoop = [];
    this.loopId = 0;
    this.maxLoops = maxLoops;

    // summaryLog: every summary/warn/error entry, uncapped — the diagnostic record written to the
    // story file.
    this.summaryLog = [];

    // Wall-clock of the last story line, in memory only — the last line's own ISO stamp answers the
    // freshness question, so nothing persists it a second time (Law 16). Null until the first line.
    this._lastStoryAt = null;

    // Named timers, in memory only — read live through the `timer` facade; each start/stop writes its
    // own story line.
    this.timers = {}; // name -> { startedAt, stoppedAt|null, meta? }

    // Serialized/throttled write state — prevents overlapping fs writes.
    this._writing = false;
    this._pending = false;
    this._lastWriteStart = 0;
    this._scheduledTimeout = null;
    // Throttles DISK writes only; _record()'s in-memory push is unthrottled, so no entry is ever
    // dropped (Law 6). An ERROR line skips the wait — _record flushes those immediately, since the
    // run about to die is the one whose last lines matter most (Law 13).
    this._MIN_WRITE_INTERVAL_MS = 1000;
    // Index into summaryLog of the first line not yet on disk; advances only on a successful append,
    // so this never runs ahead of the file.
    this._writtenThrough = 0;
    // This process's first write TRUNCATES the file; every write after that appends. A fresh run must
    // never be read as continuing the previous process's story (Invariant B) — every process that logs
    // goes through this constructor, so the guarantee holds regardless of how the process was launched.
    this._fileOpened = false;
    // Waiters resolved on the next completed write (judge awaits a stable snapshot via flush()).
    this._writeCompleteWaiters = [];

    if (ENABLE_ALL) {
      this.enableAll();
    } else {
      this.enable(...ENABLED_COMPONENTS);
    }

    // Convenience facade so callers can do watcher.timer.start('runtimer')
    this.timer = {
      start: (name = 'runtimer', meta) => this.startTimer(name, meta),
      stop: (name = 'runtimer') => this.stopTimer(name),
      get: (name = 'runtimer') => this.getTimer(name),
      all: () => this.getTimersPublic()
    };

    // Trace (ENABLE_TRACE only): stage -> rendered lines, written to TRACE_FILE. Debounced, ring-capped.
    this._trace = {};
    this._traceWriteScheduled = false;

    // Re-entry guard for _forward(): a forwarded line must never trigger another log (recursion).
    this._forwarding = false;

    // Buffer: per-stage detail; summary() clears it, error() dumps it. See the buffer section below.
    this._buffers = {};

    this.buffer = {
      open: (stage) => this._bufferOpen(stage),
      record: (stage, message) => this._bufferRecord(stage, message),
      dump: (stage) => this._bufferDump(stage),
      clear: (stage) => this._bufferClear(stage),
    };
  }

  enable(...components) {
    components.forEach(c => this.enabledComponents.add(c));
  }

  disable(...components) {
    components.forEach(c => this.enabledComponents.delete(c));
  }

  enableAll() {
    this.trackAll = true;
  }

  disableAll() {
    this.trackAll = false;
    this.enabledComponents.clear();
  }

  hide(...components) {
    components.forEach(c => this.hiddenComponents.add(c));
  }

  unhide(...components) {
    components.forEach(c => this.hiddenComponents.delete(c));
  }

  beginLoop() {
    this.currentLoop = [];
    this.loopId++;
  }

  endLoop() {
    this.logBuffer.push({ loopId: this.loopId, entries: this.currentLoop });
    if (this.logBuffer.length > this.maxLoops) this.logBuffer.shift();
    this.currentLoop = [];
  }

  printLog() {
    console.log(`\n[Watcher] Last ${this.logBuffer.length} loops:`);
    this.logBuffer.forEach(loop => {
      console.log(`  Loop ${loop.loopId}:`);
      loop.entries.forEach(entry => {
        console.log(`    - ${entry}`);
      });
    });
  }

  _shouldLog(stage, message) {
    if (typeof message !== 'string') return true;
    const hiddenMatch = HIDDEN_SUBSTRINGS.some(sub => message.includes(sub));
    return !hiddenMatch &&
      (this.trackAll || this.enabledComponents.has(stage)) &&
      !this.hiddenComponents.has(stage);
  }

  // _record: persist a printed (summary/warn/error) entry to the story file. Non-printed calls
  // no-op — there is no console-only persisted path anymore.
  _record(entry, { printed = false } = {}) {
    if (!printed) return;
    this._lastStoryAt = Date.now();
    const line = `[${formatTimestamp(this._lastStoryAt)}] ${entry}`;
    this.summaryLog.push(line);
    // An error line skips the coalescing window — the process that just logged ❌ may not survive to
    // the next tick, and its last lines are the reason to read the file at all (Law 13).
    if (/❌/.test(entry)) { this._lastWriteStart = 0; }
    this._writeWatcherFile();
  }

  // _traceRecord: append to the per-fragment trace and schedule a debounced write. Best-effort —
  // a debug artifact must NEVER throw into a caller's execution path.
  _traceRecord(stage, line) {
    if (!ENABLE_TRACE) return;
    try {
      const key = String(stage);
      const arr = this._trace[key] || (this._trace[key] = []);
      arr.push(`[${formatTimestamp(Date.now())}] ${line}`);
      if (arr.length > TRACE_MAX_PER_STAGE) arr.splice(0, arr.length - TRACE_MAX_PER_STAGE);
      this._scheduleTraceWrite();
    } catch (e) { _selfFault('_traceRecord', e); }
  }

  _scheduleTraceWrite() {
    if (this._traceWriteScheduled) return;
    this._traceWriteScheduled = true;
    const t = setTimeout(() => {
      this._traceWriteScheduled = false;
      try { this._safeWrite(TRACE_FILE, JSON.stringify(this._trace, null, 2), () => {}); }
      catch (e) { _selfFault('_scheduleTraceWrite', e); }
    }, 200);
    if (t.unref) t.unref();
  }

  // _forward: mirror one printed line to the foreman so both bots' streams are watched in one place.
  // Best-effort and re-entry-guarded — the forward path must never log (it would recurse) or throw
  // into a caller (Law 5). `level` travels as its own field, not a glyph inside the text, so a live
  // reader can ask whether the fleet has errored without parsing the sentence.
  _forward(entry, level) {
    if (this._forwarding) return;
    this._forwarding = true;
    try {
      // Relative require, like record_homes above — found in every caller shape, including processes
      // with no alias table. Outside a bot this still self-faults, correctly: there is no foreman to
      // forward to.
      const link = require('./foreman_link');
      if (link && typeof link.forwardLog === 'function') link.forwardLog(entry, level);
    } catch (e) { _selfFault('_forward', e); }
    finally { this._forwarding = false; }
  }

  // summary: post one aggregated line per phase (see header). Clears this stage's buffer so the
  // next phase's error() context starts clean.
  summary(stage, message) {
    const entry = `${runtimeTag()} [${stage.toUpperCase()}] 📊 ${message}`;
    // A ROUTINE_QUIET stage narrates nothing on the happy path: the line becomes deferred context
    // instead, without clearing the buffer, until error() dumps it or the ring drops the oldest.
    if (_routineQuiet(stage)) { this._bufferRecord(stage, message); return; }
    if (!SILENT_TERMINAL) console.log(entry);
    this.currentLoop.push(entry);
    this._record(entry, { printed: true });
    this._traceRecord(stage, entry);
    this._forward(entry, 'summary');
    this._bufferClear(stage);
  }

  error(stage, message) {
    this._bufferDump(stage);
    const entry = `${runtimeTag()} ❌ [${stage.toUpperCase()}] ERROR: ${message}`;
    if (!SILENT_TERMINAL) console.error(`\x1b[31m${entry}\x1b[0m`);
    this.currentLoop.push(entry);
    this._record(entry, { printed: true });
    this._traceRecord(stage, entry);
    this._forward(entry, 'error');
  }

  warn(stage, message) {
    const entry = `${runtimeTag()} ⚠️ [${stage.toUpperCase()}] ${message}`;
    if (!SILENT_TERMINAL) console.warn(`\x1b[33m${entry}\x1b[0m`);
    this.currentLoop.push(entry);
    this._record(entry, { printed: true });
    this._traceRecord(stage, entry);
    this._forward(entry, 'warn');
  }

  track(component, fn) {
    return (...args) => {
      const shouldLog = this._shouldLog(component, '');
      const signal = `${component}.${fn.name}()`;
      const start = Date.now();

      if (shouldLog) this.currentLoop.push(`▶️ ${signal} started`);
      if (ENABLE_TRACE) this._traceRecord(component, `${runtimeTag()} [${String(component).toUpperCase()}] ▶️ ${signal} started`);

      try {
        const result = fn(...args);
        if (shouldLog) {
          const duration = Date.now() - start;
          this.currentLoop.push(`✅ ${signal} finished in ${duration}ms`);
        }
        if (ENABLE_TRACE) this._traceRecord(component, `${runtimeTag()} [${String(component).toUpperCase()}] ✅ ${signal} finished in ${Date.now() - start}ms`);
        return result;
      } catch (e) {
        if (shouldLog) {
          this.currentLoop.push(`❌ ${signal} failed: ${e.message}`);
        }
        if (ENABLE_TRACE) this._traceRecord(component, `${runtimeTag()} [${String(component).toUpperCase()}] ❌ ${signal} failed: ${e.message}`);
        throw e;
      }
    };
  }

  // ── Buffer: deferred action-level logging ──
  // Happy path: caller records per-block detail, posts one summary(), buffer clears — nothing hits
  // disk. Error path: error() dumps the buffer to terminal first, combining similar lines so
  // context survives without N near-identical lines flooding the screen.

  _bufferOpen(stage) {
    this._buffers[stage] = [];
  }

  _bufferRecord(stage, message) {
    if (!this._buffers[stage]) this._buffers[stage] = [];
    this._buffers[stage].push({ message, timestamp: Date.now() });
    // Ring cap (BUFFER_MAX_PER_STAGE): a quiet stage's buffer is cleared by nothing on a healthy run,
    // so without this a 15-minute walk would hold every step it ever took in memory.
    if (this._buffers[stage].length > BUFFER_MAX_PER_STAGE) this._buffers[stage].shift();
    // Mirror per-block detail to the trace so a SUCCESSFUL run shows how each decision was made —
    // without promoting it to a 4th story level.
    if (ENABLE_TRACE) this._traceRecord(stage, `${runtimeTag()} [${String(stage).toUpperCase()}] ⚙️ ${message}`);
  }

  // Dump buffered lines to terminal (combining lines that differ only by coordinate tuple), then clear.
  _bufferDump(stage) {
    const entries = this._buffers[stage];
    if (!entries || entries.length === 0) return;
    const combined = this._combineBufferLines(entries);
    for (const line of combined) {
      const entry = `${runtimeTag()} [${stage.toUpperCase()}] ⚙️ ${line}`;
      if (!SILENT_TERMINAL) console.log(entry);
      this.currentLoop.push(entry);
      this._lastStoryAt = Date.now();
      this.summaryLog.push(`[${formatTimestamp(this._lastStoryAt)}] ${entry}`);
      // `context`, not `error` — the foreman counts these, and one error() dumping a dozen buffered
      // lines must not tally as a dozen failures (Law 25).
      this._forward(entry, 'context');   // error context belongs on the foreman, not just the bot's story file
    }
    this._buffers[stage] = [];
    this._writeWatcherFile();
  }

  _bufferClear(stage) {
    delete this._buffers[stage];
  }

  // Collapse consecutive lines that differ only by a coordinate tuple into one:
  //   "Dig stone at (10,70,15), (11,70,15)" instead of two lines.
  _combineBufferLines(entries) {
    if (entries.length === 0) return [];
    const COORD_RE = /\((-?\d+,-?\d+,-?\d+)\)/;
    const result = [];
    let group = { template: null, base: null, coords: [] };

    for (const { message } of entries) {
      const match = message.match(COORD_RE);
      const template = match
        ? message.replace(match[0], '{{POS}}')
        : message;

      if (template === group.template && match) {
        group.coords.push(match[0]);
      } else {
        if (group.template !== null) result.push(this._renderGroup(group));
        group = { template, base: message, coords: match ? [match[0]] : [] };
      }
    }
    if (group.template !== null) result.push(this._renderGroup(group));
    return result;
  }

  _renderGroup(group) {
    if (group.coords.length <= 1) return group.base;
    return group.base.replace(/\((-?\d+,-?\d+,-?\d+)\)/, group.coords.join(', '));
  }

  // THE RECORD IS ONLY EVER ADDED TO: every write appends, the first one of a process included, so a file
  // holds every run of its world in order. A rollback start empties fleet_logs/ before any process exists
  // (start_auren.js), and that is the one thing that deletes a line.
  // ── APPEND-ONLY WRITER ──
  // Each flush appends only the lines added since the last one — a whole-file rewrite is not durable
  // against a hard power cut (Law 13). Nothing is persisted that nothing reads: `timers` and the last
  // story timestamp are each answered from one home elsewhere (Law 16).
  //
  // `_writtenThrough` advances only when the append reports success, so a failed write leaves its
  // lines queued for the next flush instead of skipped (Law 25). summaryLog stays the single in-memory
  // truth and this is only an index into it.
  _writeWatcherFile() {
    if (this._writing) { this._pending = true; return; }
    if (this._writtenThrough >= this.summaryLog.length) { this._afterWrite(); return; }
    const since = Date.now() - this._lastWriteStart;
    if (since < this._MIN_WRITE_INTERVAL_MS) {
      if (this._scheduledTimeout) return; // write already scheduled
      const delay = this._MIN_WRITE_INTERVAL_MS - since;
      this._scheduledTimeout = setTimeout(() => {
        this._scheduledTimeout = null;
        this._writeWatcherFile();
      }, delay);
      // Unref'd so the write cadence never holds the process open past its work (Law 8) — unless a
      // flush() is awaited, in which case unref'ing would let the process exit before the promise
      // settles, stranding the caller.
      if (this._scheduledTimeout.unref && this._writeCompleteWaiters.length === 0) this._scheduledTimeout.unref();
      return;
    }
    this._writing = true;
    this._lastWriteStart = Date.now();
    try {
      const upto = this.summaryLog.length;
      const chunk = encodeStoryLines(this.summaryLog.slice(this._writtenThrough));
      if (ENABLE_WATCHER_LOGS) { console.log(`Appending ${upto - this._writtenThrough} story line(s)`); }
      // A fresh clone has no `fleet_logs/` at all — whoever writes first makes the directory.
      if (!this._fileOpened) { this._fileOpened = true; recordHomes.ensureTraceDir(); }
      fs.appendFile(WATCHER_FILE, chunk, (err) => {
        // Advance only on success, so a failed append re-sends the same lines next cycle.
        if (err) _selfFault(`_writeWatcherFile(${path.basename(WATCHER_FILE)})`, err);
        else this._writtenThrough = upto;
        this._writing = false;
        this._afterWrite();
      });
    } catch (error) {
      _selfFault('_writeWatcherFile', error);
      this._writing = false;
    }
  }

  // _afterWrite: tail of every write — start any pending write, then resolve flush() waiters.
  _afterWrite() {
    if (this._pending) {
      // A write queued mid-flight resolves waiters only after it lands, or flush() could resolve a
      // cycle too early and the caller might crash before its data is on disk.
      this._pending = false;
      this._writeWatcherFile();
      return;
    }
    const waiters = this._writeCompleteWaiters.splice(0);
    for (const resolve of waiters) {
      // Each waiter is isolated: a throwing resolve() must not strand the ones behind it, which would
      // hang the caller forever.
      try { resolve(); } catch (e) { _selfFault('_afterWrite flush waiter', e); }
    }
  }

  // flush: resolves after the next completed write — call it to await persistence before reading
  // the file back (e.g. the judge reading a stable snapshot after logging).
  flush() {
    return new Promise((resolve) => {
      this._writeCompleteWaiters.push(resolve);
      // Re-ref an already-scheduled unref'd timer, or the first awaited flush after a burst never
      // settles.
      if (this._scheduledTimeout && this._scheduledTimeout.ref) this._scheduledTimeout.ref();
      this._writeWatcherFile();
    });
  }

  // flushNow: synchronous append for process-exit handlers where async isn't an option. Appends only
  // the outstanding tail, so calling it after an async flush already landed writes nothing, never a
  // duplicate — the exit path and the timer path share one index (Law 16).
  flushNow() {
    if (this._writtenThrough >= this.summaryLog.length) return;
    const upto = this.summaryLog.length;
    try {
      if (!this._fileOpened) { this._fileOpened = true; recordHomes.ensureTraceDir(); }
      const chunk = encodeStoryLines(this.summaryLog.slice(this._writtenThrough));
      fs.appendFileSync(WATCHER_FILE, chunk);
      this._writtenThrough = upto;
    } catch (err) {
      _selfFault('flushNow', err);
    }
  }

  // -------- Timers API --------
  startTimer(name = 'runtimer', meta = {}) {
    const now = Date.now();
    this.timers[name] = { startedAt: now, stoppedAt: null, meta };
    // Called bare, like every other call site of summary() repo-wide (Law 16) — a throw here is a
    // watcher bug that must surface, not one to catch at two arbitrary spots.
    this.summary('watcher.timer', `⏱️ Started timer '${name}' at ${formatTimestamp(now)}`);
    this._writeWatcherFile();
    return this.getTimer(name);
  }

  stopTimer(name = 'runtimer') {
    const t = this.timers[name];
    if (!t) return null;
    if (t.stoppedAt) return this.getTimer(name); // already stopped
    t.stoppedAt = Date.now();
    this.summary('watcher.timer', `⏹️ Stopped timer '${name}' at ${formatTimestamp(t.stoppedAt)}`);
    this._writeWatcherFile();
    return this.getTimer(name);
  }

  getTimer(name = 'runtimer') {
    const pub = this.getTimersPublic();
    return pub[name] || null;
  }

  getTimersPublic() {
    const now = Date.now();
    const out = {};
    for (const [name, t] of Object.entries(this.timers)) {
      const running = !t.stoppedAt;
      const elapsedMs = (running ? now : t.stoppedAt) - t.startedAt;
      out[name] = {
        startedAt: formatTimestamp(t.startedAt),
        stoppedAt: t.stoppedAt ? formatTimestamp(t.stoppedAt) : null,
        running,
        elapsedMs,
        elapsed: formatDuration(elapsedMs),
        meta: t.meta || {}
      };
    }
    return out;
  }

}

const watcher = new Watcher();
watcher.resetRuntimeClock = resetRuntimeClock;
module.exports = watcher;
