// module: watcher — diagnostic logging (Law 5/6). One story file (watcher_<BotId>.json), three
// persisted levels; a normal run needs nothing else. Every old fine-grained method
// (action/signal/debug/…) was deleted or folded into these three (Law 16: one pathway).
//
// The three levels (all print AND persist to the story file, never suppressed):
//   summary() 📊 — primary channel. Accumulate over a phase, post ONE aggregated line when it
//                  completes; read only summaries and you know what ran, how long, and if it worked.
//   warn()    ⚠️ — environmental failure / retry / degraded op the system recovered from. Read these
//                  first when diagnosing.
//   error()   ❌ — critical failure; could not continue. Auto-dumps the deferred buffer first so
//                  context is never lost.
//
// Two structural helpers:
//   buffer  — per-stage context accumulated in memory (record), reaching disk ONLY if error() dumps
//             it; summary() clears it on a clean phase. Keeps per-block detail off the happy path.
//   track() — wraps a fn to record entry/exit/duration to in-memory history; never persists, never
//             swallows exceptions.
//
// Deep "HOW did it decide" visibility on a NORMAL run is the separate trace file, gated by
// ENABLE_TRACE below.

// ── Watcher configuration — all runtime toggles live here ──
// ENABLE_TRACE: master switch for the deep per-fragment trace file (watcher_<BotId>_trace.json).
// When on, every log call + buffer.record() is mirrored, grouped by fragment, so a normal run shows
// HOW each decision was made. OFF = no trace file, no tracking overhead. Either way the story log
// stays exactly three persisted levels (Law 5).
const ENABLE_TRACE = false;
const TRACE_MAX_PER_STAGE = 5000; // per-fragment ring cap so a long run can't grow the trace unbounded

// Component filtering for track()/console history (in-memory only — never the story log).
const ENABLE_ALL = false;
const ENABLED_COMPONENTS = [, 'battle_stations' ];
const HIDDEN_COMPONENTS = [];
const HIDDEN_SUBSTRINGS = [];
const ENABLE_WATCHER_LOGS = false;

// QUIET_FORWARD_STAGES: stages whose routine summary() chatter is KEPT in the bot's own story file
// (watcher_<BotId>.json — every line, fully recoverable) but NOT mirrored to the merged overseer
// stream that is the live signal-trace summary (and trace_monitor's default source). A sub-loop
// (Law 15) like the navigator runs its own Sense-Plan-Act internally — A* plans, per-step progress,
// unstick, pillar/bridge build-delivery — which are implementation detail, not signal-level events;
// on a healthy run they flood the one window the fleet is watched in and bury the decision spine
// (job posts → dispatcher picks → manager verdicts). Quieting only the FORWARD of summary() removes
// the flood while losing nothing: the per-bot file still holds it all (Law 6), and warn()/error()
// still forward so a genuine navigation failure surfaces immediately. Recover the detail on demand
// with `trace_monitor.js --bot=<Id> watcher_<Id>.json`. Architect 2026-07-12: "hide the watcher log
// for navigation, it's noisy — don't remove, just make it not part of the signal trace summary."
const QUIET_FORWARD_STAGES = new Set(['navigator']);

const fs = require('fs');
const path = require('path');
const _watcherBotId = process.env.BOT_ID || '';
// A bot process (BOT_ID set) does NOT echo its own story to its local terminal: every line is
// forwarded to the overseer, which is the single window the whole fleet is watched in. Nothing is
// lost — the per-bot story file AND the overseer forward still receive every line (Law 6); only the
// redundant local echo is dropped, so a bot window shows just its startup banner and then stays quiet
// (instantly distinguishable from the overseer's live stream). Overseer/standalone (no BOT_ID) print
// normally. This gates the three level prints + the buffer dump; it does NOT gate _forward or writes.
const SILENT_TERMINAL = !!_watcherBotId;
// .jsonl, not .json — the extension IS the durability contract (see _writeWatcherFile). One story line
// per file line, each JSON-encoded so a line may hold any character without escaping the format, and so
// a reader can drop a torn final line without losing the ones before it.
// WHERE THE RECORD LIVES IS ASKED, NEVER SPELLED (Architect 2026-08-31: the kernel holds only what a
// bot needs to RUN, and a trace nothing in the fleet reads is not that). Seven files used to hold this
// path; a reader looking in the directory the writer stopped using reports a confidently empty run.
// RELATIVE, NOT `@utils`, and that is deliberate. This module is required from processes that never
// register the alias table — a lens registers the three aliases it needs and no more, and a top-level
// alias require here made the whole monitoring side die on load with MODULE_NOT_FOUND. The wiring smoke
// test cannot see it: that harness registers every alias before loading anything, so the one caller
// shape that breaks is the one it does not reproduce. A sibling directory needs no alias to be found.
const recordHomes = require('./utils/record_homes');
const WATCHER_FILE = recordHomes.traceFile(_watcherBotId);

// The one encoder. Both the async and the sync flush go through it, so the file can never hold two
// shapes (Law 16 — a second stringify site is the drift to watch).
function encodeStoryLines(lines) {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}
// Trace artifact — never mixed into WATCHER_FILE (Law 5: story = one file).
const TRACE_FILE = recordHomes.deepTraceFile(_watcherBotId);

// _selfFault: the watcher's ONE self-report channel (r34). The logger cannot report its own failure
// through its own levels — warn() → _record → _writeWatcherFile → fault → warn() is unbounded
// recursion — which is why every internal fault here was historically swallowed silently. The escape
// from that was already in this file and merely unnamed: _writeWatcherFile/_safeWrite/flushNow have
// always written their faults straight to console.error. This gives that channel one name (Law 16),
// so "no silent swallow" is satisfiable INSIDE the logger without the recursion.
//
// Rules: console only, never a watcher level (that is the recursion). Never gated by SILENT_TERMINAL
// — a bot process suppresses its own routine echo because the overseer forward carries it, but a
// self-fault means the forward and the file are the very things that may be broken, so this is the
// one line that must print locally regardless. stderr survives a wrecked stdout and the launcher
// captures it.
function _selfFault(where, err) {
  // The one terminal swallow in the system, and the only defensible one: if console.error itself
  // throws (closed/EPIPE stderr), there is no remaining channel to report the failure to report.
  // Anything beyond this point is unobservable by construction, not by choice.
  try {
    console.error(`[watcher:SELF-FAULT] ${where}: ${err && err.message ? err.message : String(err)}`);
  } catch (_) {}
}

// No catch (r34): the old `try { new Date(ts).toISOString() } catch { return String(ts) }` laundered a
// coding violation into a plausible-looking string — a bad ts silently became file content that reads
// like a timestamp (Invariant C). Only an invalid date throws here, and every caller passes Date.now()
// or a stored epoch, so that is a caller bug. It is reported and marked LOUDLY rather than thrown:
// the watcher is passive infrastructure and must never be able to kill the run it is observing
// (Law 5). Law 13's intent is that a violation surfaces, not that this specific frame is the one to
// die — the self-fault line plus an unmistakable in-band marker surface it without that power.
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
// resetRuntimeClock() when a run formally begins.
//
// ── IT STARTS AT LOAD, AND THAT IS THE 2026-08-12 FIX (Architect: "fix the obvious issues like the
//    clock") ──────────────────────────────────────────────────────────────────────────────────────────
// It used to start as `null` and read `[0m 0s]` until something called `resetRuntimeClock()` — and the
// only caller is `start_injector`, which runs on the OPERATOR VERB `start`. Any run that never issues
// that verb has no clock at all: MEASURED on the 2026-08-12 `kiters` ladder, where every line of a
// three-wave fight — sixty seconds of it — carried the stamp `[0m 0s]`.
//
// That is not a cosmetic blemish. `monitoring/trace_read.parseLine` derives `relSec` from this tag, so
// `--from`, `--to`, `--around` and every lens that orders events by it were filtering a run whose lines
// all claimed the same instant. The engagement lens duly reported "first struck 0s later" for every mob
// in that run, and it was believable — a false measurement, not a missing one (Law 25).
//
// Module load IS process start for anything that logs, so a clock based there cannot be forgotten by a
// launch path that does not know to ask for it (Law 13: the working state is the default, and the
// verb re-bases it rather than switching it on).
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

    // summaryLog: every summary/warn/error entry — the diagnostic record written to the story file.
    // No cap; all entries kept.
    this.summaryLog = [];

    // Wall-clock of the last STORY line, used to stamp that line's ISO prefix. It was ALSO persisted as
    // a `lastStoryAt` field until 2026-08-12, so a reader could judge liveness by content freshness
    // rather than file mtime (the old 100ms refresh loop advanced mtime even through a hang, a false
    // "alive"). Append-only killed both halves of that problem: nothing rewrites the file on a timer, so
    // mtime now only moves when a line lands, and the last line's own ISO answers the freshness question
    // without a second field to keep in step (Law 16). null until the first story line.
    this._lastStoryAt = null;

    // Named timers, in memory only. They were persisted into every whole-file rewrite until 2026-08-12
    // and read by nothing outside this class; the append-only writer dropped them, and the 100ms
    // refresh loop that existed solely to keep that dead field current went with them. Callers still
    // read them live through the `timer` facade, and each start/stop already writes its own story line.
    this.timers = {}; // name -> { startedAt, stoppedAt|null, meta? }

    // Serialized/throttled write state — prevents overlapping fs writes.
    this._writing = false;
    this._pending = false;
    this._lastWriteStart = 0;
    this._scheduledTimeout = null;
    // Throttles DISK writes only; _record()'s in-memory push is unthrottled, so no entry is ever
    // dropped (Law 6: 1-for-1 with stdout).
    //
    // 1000ms, chosen by the Architect on 2026-08-12 ("slow the writing i dont know why its 40ms thats
    // wild"). 40ms was sized against Minecraft's 50ms tick back when the file was rewritten whole and a
    // reader wanted the freshest possible snapshot. Appending removes the reason: a coalesced second of
    // lines is one append of a few KB instead of twenty-five rewrites of 1.5 MB, and the only thing the
    // delay costs is up to a second of trace on a hard power cut. An ERROR line does not wait for it —
    // _record flushes those immediately, because the run that is about to die is the one whose last
    // lines matter most (Law 13: the record of a halt must outlive the halt).
    this._MIN_WRITE_INTERVAL_MS = 1000;
    // Index into summaryLog of the first line NOT yet on disk. Advances only on a reported-successful
    // append — the whole crash-safety guarantee is that this never runs ahead of the file.
    this._writtenThrough = 0;
    // ── THIS PROCESS'S FIRST WRITE OPENS THE FILE, IT DOES NOT JOIN ONE (Architect 2026-08-31) ──────
    //
    //   "remove no data accumulation. that is not allowed. thats a law violation. fresh state beats
    //    remembered. the only reason why we keep data is a post mortem of that specific run. a new run
    //    is fresh state and should always overwrite stale data."
    //
    // The append-only writer is right and is unchanged — what was missing is where the appending BEGINS.
    // Every flush appended, including the first, so a unit whose process started without a fleet-wide
    // sweep ahead of it carried on writing underneath the previous run's story. Two runs then shared one
    // file with nothing marking the seam, and every reader of that file — a person, a lens, the wake
    // watch — attributed one run's events to the other. That is remembered state presented as sensed
    // state, which is the whole of Invariant B.
    //
    // WHY HERE AND NOT AT EACH LAUNCHER. fleet_control's run-start sweep clears the directory, which is a
    // different job and still needed: it releases files belonging to units that will NOT start this run,
    // and nothing but a directory sweep can do that. What it cannot do is guarantee freshness for a unit
    // raised outside a fleet start — a foreman on its own, a camera, a probe raising a desk — and adding
    // a clear to each of those launchers would be the same guarantee installed at N sites, where the
    // N+1th ships without it and looks correct (Law 16). A process cannot start without this class, so
    // this is the one place the guarantee cannot be bypassed.
    //
    // IT IS A TRUNCATE, NOT AN UNLINK: the file is opened for writing on the first flush and appended to
    // for every one after. A unit that writes nothing never truncates anything, so a process that dies
    // before its first line leaves the prior run's record intact for exactly the post mortem it is kept
    // for — the seam moves to the first line of the new run, which is where a reader looks for it.
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
    // An error line skips the 1000ms coalescing window. The process that just logged ❌ is the one most
    // likely to stop existing before the next tick, and its last lines are the whole reason to read the
    // file at all. Everything else can wait a second (Law 13 — prove it is safe to defer, not to drop).
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

  // _forward: mirror one printed line to the overseer so both bots' streams can be watched in one
  // place (tagged by bot on the overseer side). Best-effort and re-entry-guarded — the forward path
  // must never log (it would recurse) and must never throw into a caller (Law 5: logging is passive).
  _forward(entry) {
    if (this._forwarding) return;
    this._forwarding = true;
    try {
      // Relative for the same reason as the records-home require at the top of this file: a
      // same-directory sibling is found in every caller shape, including the processes that register no
      // alias table. That makes THIS line unconditional; it does not make the forward path work outside
      // the fleet, because the module it reaches has alias requires of its own. Outside a bot the
      // forward still self-faults, and that is the correct outcome — there is no overseer to forward to.
      const link = require('./overseer_link');
      if (link && typeof link.forwardLog === 'function') link.forwardLog(entry);
    } catch (e) { _selfFault('_forward', e); }
    finally { this._forwarding = false; }
  }

  // summary: post one aggregated line per phase (see header). Clears this stage's buffer so the
  // next phase's error() context starts clean.
  summary(stage, message) {
    const entry = `${runtimeTag()} [${stage.toUpperCase()}] 📊 ${message}`;
    if (!SILENT_TERMINAL) console.log(entry);
    this.currentLoop.push(entry);
    this._record(entry, { printed: true });
    this._traceRecord(stage, entry);
    // Sub-loop chatter (QUIET_FORWARD_STAGES) is recorded to the per-bot file above but not mirrored
    // to the overseer signal-trace stream — warn()/error() still forward, so failures never hide.
    if (!QUIET_FORWARD_STAGES.has(stage)) this._forward(entry);
    this._bufferClear(stage);
  }

  error(stage, message) {
    this._bufferDump(stage);
    const entry = `${runtimeTag()} ❌ [${stage.toUpperCase()}] ERROR: ${message}`;
    if (!SILENT_TERMINAL) console.error(`\x1b[31m${entry}\x1b[0m`);
    this.currentLoop.push(entry);
    this._record(entry, { printed: true });
    this._traceRecord(stage, entry);
    this._forward(entry);
  }

  warn(stage, message) {
    const entry = `${runtimeTag()} ⚠️ [${stage.toUpperCase()}] ${message}`;
    if (!SILENT_TERMINAL) console.warn(`\x1b[33m${entry}\x1b[0m`);
    this.currentLoop.push(entry);
    this._record(entry, { printed: true });
    this._traceRecord(stage, entry);
    this._forward(entry);
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
      this._forward(entry);   // error context belongs on the overseer, not just the bot's story file
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

  // ── APPEND-ONLY WRITER (Architect 2026-08-12) ─────────────────────────────────────────────────
  //
  //   "lets go with option 1 and slow the writing i dont know why its 40ms thats wild. […] can you
  //    just scrap the whole thing and make a better system with better guards"
  //
  // WHAT THIS REPLACED AND WHY. Until today every story line rewrote the WHOLE file — ~1.5 MB, on a
  // 40 ms floor — through a tmp+rename. On 2026-08-12 the machine lost power 39 minutes into a
  // 60-minute soak and all three traces came back as pure NUL bytes at exactly the right length:
  // 1,567,301 / 1,108,505 / 1,024,696 bytes, zero of them content. That is the filesystem's crash
  // signature, not a torn write. NTFS journals METADATA, so the replay restored the rename and the
  // file size; the DATA sat unflushed in the page cache and NTFS may not hand back another file's old
  // blocks, so it returned zeros. tmp+rename was never a durability guard — it guards a READER from
  // seeing a half-written file — and it made the cut worse in one way: it swaps a file whose bytes
  // were durable for one whose bytes are not.
  //
  // The proof of the fix was in the next folder over: an append-only JSONL record came through the SAME
  // power cut with every one of its thousands of rows intact, because its bytes were written once at
  // stable offsets and flushed minutes earlier. So the story file is now append-only
  // too: each flush appends ONLY the lines added since the last one.
  //
  // WHAT WENT AWAY WITH THE REWRITE, and none of it is a loss:
  //   · `timers` was persisted on every one of those rewrites and read by NOTHING outside this class —
  //     dead payload. With it gone, the 100 ms timer-refresh loop that existed only to keep it fresh
  //     goes too, along with the false-liveness problem it caused (mtime advancing during a hang).
  //   · `lastStoryAt` had one reader, the freeze detector. Every persisted line already carries its own
  //     ISO stamp, so the last line IS the answer — one fact, one home (Law 16).
  //   · The EBUSY/EPERM rename-lock branch is deleted with the rename. A Windows reader holding the
  //     file open blocks a RENAME, never an APPEND, so the failure mode it latched on cannot occur.
  //
  // THE GUARD THAT REPLACES THEM: `_writtenThrough` only advances when the append REPORTS SUCCESS, so
  // a failed write leaves its lines queued for the next flush instead of skipping them (Law 25 — the
  // record may fall behind, it may never quietly lose a line). summaryLog stays the single in-memory
  // truth and this is an index into it, never a second copy of the data.
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
      // Unref'd so the watcher's own write cadence never holds a process open past its work (Law 8:
      // nothing runs on invisibly after the run that raised it). The exception is an AWAITED write:
      // an unref'd retry lets node drain the loop and exit with the flush() promise unsettled, so the
      // awaiting caller's continuation is discarded in silence — the "flush() that never settles"
      // _afterWrite already names as worse than a throw. Measured: recursive_judge's Law-13 halt
      // awaits flush() a few ms after its own error lines, lands in this branch every time, and
      // handleSignal simply never returned.
      if (this._scheduledTimeout.unref && this._writeCompleteWaiters.length === 0) this._scheduledTimeout.unref();
      return;
    }
    this._writing = true;
    this._lastWriteStart = Date.now();
    try {
      const upto = this.summaryLog.length;
      const chunk = encodeStoryLines(this.summaryLog.slice(this._writtenThrough));
      if (ENABLE_WATCHER_LOGS) { console.log(`Appending ${upto - this._writtenThrough} story line(s)`); }
      // The first write of the process TRUNCATES; every one after appends. `_fileOpened` is set before
      // the callback rather than inside it on purpose: a failed first write must not leave the flag down,
      // or the retry would truncate a second time and drop whatever the first attempt did land.
      const opening = !this._fileOpened;
      this._fileOpened = true;
      // The records room is made by whoever writes first — a fresh clone has no `fleet_logs/` at all.
      if (opening) recordHomes.ensureTraceDir();
      const write = opening ? fs.writeFile : fs.appendFile;
      write(WATCHER_FILE, chunk, (err) => {
        // Advance ONLY on success — see the guard note above. A failed append re-sends the same lines
        // next cycle rather than leaving a hole nobody can see.
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
      // A write was queued mid-flight; ITS snapshot holds whatever set _pending (e.g. an error
      // logged during the write). Resolve waiters only after it lands, or flush() could resolve a
      // cycle too early and the caller might crash before its data is on disk.
      this._pending = false;
      this._writeWatcherFile();
      return;
    }
    const waiters = this._writeCompleteWaiters.splice(0);
    for (const resolve of waiters) {
      // Each waiter is isolated: a throwing resolve() must not strand the waiters behind it in the
      // list, which is the one thing worse than the throw itself (a flush() that never settles hangs
      // its caller forever). Reported, never swallowed — and resolve() throwing at all is a coding
      // violation, since these are Promise resolvers this class created in flush().
      try { resolve(); } catch (e) { _selfFault('_afterWrite flush waiter', e); }
    }
  }

  // flush: resolves after the next completed write — call it to await persistence before reading
  // the file back (e.g. the judge reading a stable snapshot after logging).
  flush() {
    return new Promise((resolve) => {
      this._writeCompleteWaiters.push(resolve);
      // A throttled write may already be scheduled on an unref'd timer from before this waiter
      // existed; _writeWatcherFile returns early when one is pending, so re-ref here or the very
      // first awaited flush after a burst never settles.
      if (this._scheduledTimeout && this._scheduledTimeout.ref) this._scheduledTimeout.ref();
      this._writeWatcherFile();
    });
  }

  // flushNow: synchronous append for process-exit handlers where async isn't an option. Appends only
  // the outstanding tail, so calling it after an async flush already landed writes nothing rather than
  // duplicating the story — the exit path and the timer path share one index (Law 16).
  flushNow() {
    if (this._writtenThrough >= this.summaryLog.length) return;
    const upto = this.summaryLog.length;
    try {
      // Same rule on the exit path, and it matters most here: a process that only ever writes at exit
      // (a launcher verb, a probe's teardown) would otherwise be the one case that always appends.
      const opening = !this._fileOpened;
      this._fileOpened = true;
      if (opening) recordHomes.ensureTraceDir();
      const chunk = encodeStoryLines(this.summaryLog.slice(this._writtenThrough));
      if (opening) fs.writeFileSync(WATCHER_FILE, chunk);
      else fs.appendFileSync(WATCHER_FILE, chunk);
      this._writtenThrough = upto;
    } catch (err) {
      _selfFault('flushNow', err);
    }
  }

  // -------- Timers API --------
  startTimer(name = 'runtimer', meta = {}) {
    const now = Date.now();
    this.timers[name] = { startedAt: now, stoppedAt: null, meta };
    // Bare call (r34). This was `try { … } catch (_) {}` — but summary() is this class's own method
    // and is called bare from all 234 of its call sites repo-wide; guarding it at the only two sites
    // inside the watcher itself claimed a throw the other 232 would equally have to fear. If summary()
    // can throw, that is a watcher bug that must surface, not one to hide from at two arbitrary spots
    // (Law 16: one pathway — call it the way every caller calls it).
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
