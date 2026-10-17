// fragment: portable_judge
// purpose: Satellite judge for recursive_judge — monitors an executor's loop
//          for stall or oscillation. On detection: routes a fresh signal to
//          recursive_judge (parent) and returns false to the caller. The caller
//          stops its loop without routing — portable_judge already routed.
//          recursive_judge decides the consequence:
//            strict  — kills the signal, clears the magnet
//            forgiving — routes to job_board for a fresh plan cycle
//          Portable judge never kills the signal itself. recursive_judge is the
//          authority. Portable judge exists because recursive_judge resets its
//          memory between signals and cannot track cross-signal patterns.
// invariants:
//  - checkpoint() called at end of each executor iteration with the exit summary string
//  - 3 consecutive identical summaries → stall (route to recursive_judge, return false)
//  - 4 alternating A-B-A-B summaries → oscillation (route to recursive_judge, return false)
//  - 8 of the same alternation → deep oscillation, for buckets exempt from the 4-wide check, so the
//    exemption stays bounded (Law 11: every loop needs a judge)
//  - done() called by executor on normal completion (clears state + forgiving retries)
//  - reset() called by recursive_judge as safety net — clears STRICT watcher state only. A forgiving
//    bucket's history and the forgiving retry counter persist across signal cycles: a forgiving loop is
//    cross-cycle (one checkpoint per plan cycle), and clearing it every cycle would keep the count stuck
//    at 1 (see reset() below)
//  - State is in-memory only — clears on process restart, on done(), or on reset()
//  - Runtime tags [Xm Ys] are stripped before comparison so timestamps don't
//    make every summary unique (which would prevent detection entirely)
// WHY: recursive_judge detects system-wide loops (same readable hitting recursive_judge
//      repeatedly). portable_judge detects executor-level stalls (same work summary
//      from the same executor across iterations). The summary string includes variable
//      counts (dig=3/3, place=2/2), so identical strings mean zero progress.
//      This is the judge role from Law 11 applied inside the executor's own loop.

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');

const STALL_THRESHOLD = 3;
const OSCILLATION_WINDOW = 4;
const FORGIVING_LIMIT = 3;

// ── DEEP OSCILLATION: THE NET UNDER THE EXEMPTION ──────────────────────────────────────────────────
// The buckets below are exempt from the 4-wide oscillation check because a short A-B-A-B is legitimate
// for them. This catches the same pattern held to twice the length, so the exemption is bounded instead
// of unlimited (Law 11: every loop needs a judge).
//
// EIGHT IS SAFE FOR EVERY EXEMPT BUCKET because all three feed this judge only on a failure, never on
// progress:
//   locomotion   — fed only by a terminal failure of the identical-goal guard; success clears it.
//                  A-B-A-B here means four exhausted goals, not four arrivals.
//   detonator    — fed inside `if (_det.planFailed)`: only when the retreat could not be planned.
//   archer_rush  — fed only on a blocked plan, a bot standing still with no counter running.
//   mob_reengage — fed only by a wave that killed nothing.
// Alternation here is alternating FAILURE. Eight is four full A-B periods, well past any of these
// buckets' legitimate progress patterns.
//
// Not generalised past a two-value alternation: A-B-C-A-B-C and longer periods catch a different shape.
//
// Non-exempt buckets never reach this check — their 4-wide test fires first — so it costs them nothing.
const DEEP_OSCILLATION_WINDOW = 8;

// The history must hold the widest pattern any check reads. Raising this does NOT change stall (reads
// the last 3) or standard oscillation (the last 4); it only stops the buffer from discarding the
// evidence the deep check needs.
const HISTORY_LIMIT = Math.max(OSCILLATION_WINDOW, DEEP_OSCILLATION_WINDOW);

// Buckets whose loop lives INSIDE one SPA cycle (Law 15 sub-loop APIs) and cannot bookend
// themselves with done(): locomotion is checkpointed once per goTo terminal, and the caller
// never knows which goTo is its last, so there is no single point to clear at. Its identical-
// goal history must instead persist across goTos within the run and clear at the cycle boundary
// — which is exactly recursive_judge's reset(). So for these buckets, being active at reset is
// the NORMAL end-of-cycle clear, not a mid-loop interruption: reset() clears them SILENTLY.
// Executors that own their whole SPA cycle (build_executor, craft_handler) still call done()
// on completion, so a leftover of one of THOSE at reset is a real interruption and still warns.
//
// These buckets are ALSO exempt from the 4-wide oscillation check (see checkpoint()): a sub-loop API's
// readable is a bare goal coordinate with no progress signal, so alternating goals (A-B-A-B) mean a
// caller working multiple sites, not a stall. Only STALL (A-A-A, the identical goal re-requested)
// remains meaningful for them at that width. The exemption is bounded, not unlimited —
// DEEP_OSCILLATION_WINDOW catches the same alternation at twice the length for these buckets too.
//
// 'detonator' joins for the same two reasons: its loop lives inside one SPA cycle with no point to call
// done() at, and its readable is a bare goal ("no retreat from this cell"), so an alternating A-B-A-B as
// the creeper walks the bot around is a fight progressing. Only the identical-goal STALL means anything
// for it.
// 'archer_rush' joins on the same two reasons: a rush at a KITING target alternates
// close-strike-close-strike by construction, the exact A-B-A-B shape oscillation detection would
// otherwise condemn. Only the identical STALL — the same plan failure over and over while the skeleton
// keeps shooting — means anything here.
// 'mob_reengage' joins for the oscillation reason only: its readable is a mob id, so A-B-A-B is the bot
// working a crowd — two mobs trading the field is a fight progressing, and only A-A-A (the same mob
// ping-ponging in and out of range) has anything to stop it (see battle_stations' disengage judge).
// It does not need the done()/reset() exemption — it is checkpointed at a wave boundary, not inside a
// sub-loop — but shares the set because the set's only behavioural effect is the oscillation skip.
const SUBLOOP_BUCKETS = new Set(['locomotion', 'detonator', 'archer_rush', 'mob_reengage']);

// Strips the runtime tag [Xm Ys] from a summary before comparison.
// Without this, the timestamp makes every summary unique and the judge never fires.
function stripTimestamp(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/^\[\d+m \d+s\] /, '');
}

// Per-executor iteration state: { history: string[] }
// Cleared by reset() and done().
const executors = {};

// Per-executor forgiving retry counter. Tracks how many times a forgiving
// executor has been sent back for replan. NOT cleared by reset() — must
// persist across signal cycles so recursive_judge eventually kills instead
// of forgiving forever. Cleared by done() (stall resolved).
const forgivingRetries = {};

// Checks an executor's exit summary for repetition. On stall/oscillation,
// routes a fresh signal to recursive_judge and returns false. The caller
// must stop its loop without routing — portable_judge already routed.
// Returns undefined on normal (no detection).
async function checkpoint(executor, readable, mode = 'strict') {
  if (!executors[executor]) {
    // Watching starts silently; the escalation path owns the warning or error when progress stops
    // (Law 5: persist events with diagnostic value).
    executors[executor] = { history: [], mode };
  }

  const state = executors[executor];
  state.mode = mode;          // last call wins; reset() reads it to decide whose memory survives a cycle
  state.history.push(readable);

  if (state.history.length > HISTORY_LIMIT) {
    state.history.shift();
  }

  const stripped = state.history.map(stripTimestamp);

  // Stall: N identical summaries in a row (timestamps stripped)
  if (stripped.length >= STALL_THRESHOLD) {
    const recent = stripped.slice(-STALL_THRESHOLD);
    if (recent.every(h => h === recent[0])) {
      await _escalate(executor, 'stall', mode, recent[0]);
      return false;
    }
  }

  // Oscillation: alternating A-B-A-B pattern (timestamps stripped). EXEMPT for sub-loop buckets: a
  // sub-loop API's readable is a bare goal coordinate with no progress signal, so a caller working
  // multiple sites legitimately alternates goals — farm_executor at anchor A, then B, then back to A —
  // four successful arrivals, not a stall (Law 11: terminate when the gap stops shrinking, not when a
  // coordinate repeats). A genuine locomotion loop is a caller re-requesting the identical goal, still
  // caught by stall detection above.
  if (!SUBLOOP_BUCKETS.has(executor) && stripped.length >= OSCILLATION_WINDOW) {
    const w = stripped.slice(-OSCILLATION_WINDOW);
    if (w[0] === w[2] && w[1] === w[3] && w[0] !== w[1]) {
      await _escalate(executor, 'oscillation', mode, `${w[0]} ↔ ${w[1]}`);
      return false;
    }
  }

  // Deep oscillation: the SAME two-value alternation held to DEEP_OSCILLATION_WINDOW. Runs for every
  // bucket, exempt ones included. A non-exempt bucket never reaches it, since the 4-wide test above
  // fires on the same pattern first.
  if (stripped.length >= DEEP_OSCILLATION_WINDOW) {
    const w = stripped.slice(-DEEP_OSCILLATION_WINDOW);
    const [a, b] = w;
    if (a !== b && w.every((h, i) => h === (i % 2 === 0 ? a : b))) {
      await _escalate(executor, 'deep oscillation', mode,
        `${a} ↔ ${b} — ${DEEP_OSCILLATION_WINDOW / 2} full periods with no third value`);
      return false;
    }
  }
}

// Routes a fresh signal to recursive_judge and returns. Portable judge is
// a satellite — it detects but does not kill. recursive_judge (parent) decides
// the consequence: strict kills the signal and clears the magnet, forgiving
// routes to job_board for replan. The caller receives `false` from checkpoint()
// and must stop its loop without routing (portable_judge already routed).
async function _escalate(executor, reason, mode, detail) {

  let effectiveMode = mode;
  if (mode === 'forgiving') {
    if (!forgivingRetries[executor]) forgivingRetries[executor] = 0;
    forgivingRetries[executor]++;
    if (forgivingRetries[executor] >= FORGIVING_LIMIT) {
      watcher.warn(executor, `Portable judge: forgiving limit (${FORGIVING_LIMIT}) reached — escalating to strict`);
      effectiveMode = 'strict';
    }
  }

  const levelFn = effectiveMode === 'strict' ? 'error' : 'warn';
  watcher[levelFn](executor, `Portable judge: ${reason} detected — routing to recursive_judge (${effectiveMode}): "${detail}"`);

  delete executors[executor];

  routeToJudge('portable_judge', {
    readable: `portable_judge: ${reason} in ${executor} — ${detail}`,
    portable_judge_verdict: { executor, mode: effectiveMode, reason },
  });

  await watcher.flush();
}

// Executor completed normally — stop watching, clear all state including
// forgiving retries (the stall resolved, counter should reset for next time).
function done(executor) {
  // Stop watching silently — the happy-path completion bookend was noise (see
  // checkpoint()). The executor posts its own result summary; a stall/oscillation
  // would have already surfaced via warn()/error().
  delete executors[executor];
  delete forgivingRetries[executor];
}

// Safety net: recursive_judge clears portable_judge watcher state when routing to job_board.
// forgivingRetries are NOT cleared — they track across signal cycles so the system eventually kills a
// persistently stalling executor.
//
// ── A FORGIVING BUCKET'S HISTORY SURVIVES THE RESET, AND WITHOUT THAT IT CANNOT COUNT AT ALL ────────
// The two modes describe loops of different WIDTHS, and only one of them fits inside the cycle this
// function ends:
//   strict    — the loop lives INSIDE one plan cycle (an executor's own dig/place/craft iteration), so
//               it checkpoints many times per cycle and a leftover at the cycle boundary really is an
//               interrupted loop. Cleared, exactly as before.
//   forgiving — the remedy IS a fresh plan cycle, so by construction the caller checkpoints ONCE per
//               cycle (a concession: this dispatch was futile, replan). Its evidence is the streak
//               ACROSS cycles and nothing else; it is not an interrupted loop, it is a ledger.
//
// Clearing a forgiving bucket here would erase the only record that can reach STALL_THRESHOLD: every
// lap of an idle-park loop passes a heartbeat signal through recursive_judge, which calls this function,
// so a once-per-cycle concession would be wiped between every two entries and the count could never
// leave 1. A judge whose memory is erased faster than it can fill is no judge (Law 11: one judge per
// loop, its memory the record; Invariant C: the record is what makes the decision recoverable), and the
// concession paths route AROUND recursive_judge on the promise that they bring this judge with them.
//
// done() is the other half and keeps the ledger honest: an executor that completes its verb clears its
// own bucket, so only concessions with no successful run between them accumulate.
function reset() {
  for (const [executor, state] of Object.entries(executors)) {
    if (state.mode === 'forgiving') continue;      // cross-cycle ledger — not this cycle's to clear
    if (!SUBLOOP_BUCKETS.has(executor)) {
      watcher.warn(executor, `Portable judge: reset by recursive_judge — was still active (interrupted)`);
    }
    delete executors[executor];
  }
}

module.exports = { checkpoint, done, reset };
