// fragment: locomotion_judge
// purpose: The termination point of EVERY inner locomotion chain (Law 12) and the gate
//          between the sub-loop and the outer system. On a failure that ADVANCED the
//          bot (a partial path got it closer), issues a flat retry so the next A*
//          starts nearer, riding the partial-path trail toward the goal. On a
//          no-progress failure (no path found, wrong side, out of range) it abandons
//          at once — a fresh A* from the same spot only repeats the dead end.
//
// role in the sub-loop (fractal twin of recursive_judge):
//   - Every ladder rung's final baton-pass lands here, success or failure.
//   - success           → route a 'success' verdict to locomotion_dispatcher, which resolves
//                         the caller's pending API promise (the doorway "returns").
//   - failure that made
//     progress, attempts
//     remaining         → route a 'retry' verdict to locomotion_dispatcher, which dispatches
//                         a FRESH chain from current world state (never a re-entry — Law 12).
//                         A no-progress failure skips straight to FAILURE below.
//   - failure, budget
//     exhausted         → FAILURE: send a failure verdict to the dispatcher, which resolves
//                         the caller's promise with arrived=false. The caller gets control
//                         back and is responsible for picking a different target.
//
// invariants:
//  - Three flat retries: no identical-outcome analysis, no history file — a flat
//    counter carried in the payloads keeps the mini judge simple.
//  - THE JUDGE PLACES THE TRY COUNT IN THE PAYLOAD (fractal of recursive_judge tracking
//    loop counts). A retry verdict echoes back the only two facts that survive the loop —
//    the original request (verb + goal: we are NOT re-deciding where to go) and the
//    incremented attempt number. Both are non-stale by nature: they are facts about the
//    request, never world state. The judge keeps nothing in memory; verdicts are dead
//    signals whose declared termination point (Law 8) is the dispatcher.
//  - Posts verdicts to the terminal via Watcher INCLUDING the attempt number: no
//    locomotion_judge.json — escalations are already recorded by recursive_judge, a
//    judge file would be bloat and duplicate noise.
//  - Malformed arrivals (missing locomotion capsule / success flag) are coding violations
//    and throw (Law 13): a stray outer route into the sub-loop lacks the inner contract
//    and crashes loudly instead of being silently handled.
//
// PROTOTYPE STATUS (build order step 2): no rung routes here yet — the legacy navigation
// fragments still report to recursive_judge directly until they are refurbished (steps 4-6).

// ---------------------------------------------------------------------------
// SECTION 1: Dependencies
// ---------------------------------------------------------------------------
// watcher       — diagnostic logging (Law 5)
// portable_judge — the ONE loop detector (Law 16): the identical-goal guard below delegates to it
//                 rather than re-implementing a stall counter here (see SECTION 2b)
// signal_bus    — required lazily inside the handler (repo convention) to avoid the circular
//                 load signal_bus → fragment_registry → this module
// ---------------------------------------------------------------------------
const watcher = require('@kernel/watcher');
const portableJudge = require('@kernel/portable_judge');
// The bus at MODULE SCOPE, which it could not be before 2026-09-10: the load cycle through
// fragment_registry forced this require inside a function in every routing file. This is one of the
// six FORWARDING routers — it calls route() with an upstream author's own from/to rather than building
// an envelope, so it cannot use signal_utils' helpers (they stamp `from` = the caller and would rewrite
// authorship). Every other fragment now has no contact with the bus at all.
const signalBus = require('@kernel/signal_bus');

// ---------------------------------------------------------------------------
// SECTION 2: Retry budget
// ---------------------------------------------------------------------------
// MAX_RETRIES    — fresh chains granted after the first attempt fails.
// TOTAL_ATTEMPTS — first attempt + retries.
// These are INTERNAL to the judge (Law 1: no other fragment imports them). The dispatcher
// learns attempt numbers only from the verdict payloads the judge sends it.
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const TOTAL_ATTEMPTS = 1 + MAX_RETRIES;

// ---------------------------------------------------------------------------
// SECTION 2b: Identical-goal loop guard — delegated to portable_judge (Law 16)
// ---------------------------------------------------------------------------
// Every chain terminates here (Law 12), so this judge is positioned to notice a CALLER stuck
// re-issuing the exact same goTo forever. That "N identical outcomes = a loop" detection is exactly
// what portable_judge already does for the outer executors, so this judge DELEGATES to it rather
// than carrying its own counter (Law 16: one loop detector, one implementation).
//
// ONLY repeated FAILURE counts toward the stall — a successful arrival CLEARS the streak instead of
// feeding it (Law 11: the gap closing to zero is progress; a stall is the gap that STOPS shrinking,
// never a coordinate that merely repeats). The guard exists to catch a caller re-issuing a goal it
// can NEVER reach (three straight failures to the same unreachable spot); it must NOT fire on a caller
// that keeps REACHING one stand-cell across several work phases. farm_executor digs, then places, then
// places again from a single anchor — each phase re-issues the identical goTo and each ARRIVES; those
// are three successes with real work (blocks dug/placed) between them, not a spin. A caller
// that truly spins in place while its goTos succeed is still caught one layer out: its OWN executor
// bucket, whose summary encodes progress counts (dig=x place=y), stalls on identical no-progress
// summaries, and recursive_judge catches system-wide repeats.
//
// Checkpointed ONLY at the terminal verdicts (never on a mid-goTo retry — same invocation, not a
// fresh caller request). Strict: on a failure-stall portable_judge routes to recursive_judge, which
// error-logs, clears the magnet, and kills the signal; this judge returns without a verdict and the
// caller's promise is abandoned (Law 15). Replaces the old inline throw that crashed the process.
const PJ_BUCKET = 'locomotion';

// Goal identity for the guard. A coordinate request is concrete → key on the coordinate. A
// candidate-array request (e.g. surface_filter:100) has a CONSTANT ref:count descriptor across every
// scan of a dense field, so key instead on the block the ladder RESOLVED to (selected_target): two
// terminations against the SAME target are a real loop; different targets are the bot working through
// a set (patch to patch). ref:count remains only as the fallback when a chain terminated before the
// ladder ever selected a target.
function goalKey(capsule) {
  if (capsule.coordinate) {
    return `${capsule.verb}:${capsule.coordinate.x},${capsule.coordinate.y},${capsule.coordinate.z}`;
  }
  const sel = capsule.selected_target?.position;
  if (sel) return `${capsule.verb}:sel:${sel.x},${sel.y},${sel.z}`;
  return `${capsule.verb}:${capsule.candidates_ref}:${capsule.candidates_count}`;
}

// ---------------------------------------------------------------------------
// SECTION 3: Main receive function (signal bus entry point)
// ---------------------------------------------------------------------------
// Expected arrival shape (the inner contract, Law 10):
//   from:       the rung that ended the chain
//   readable:   the rung's human-readable outcome line (becomes the failure description)
//   success:    boolean — did the chain deliver the bot per the verb's arrival contract
//   locomotion: { verb, coordinate | {candidates_ref,candidates_count,candidates_kind},
//                 attempt, invocation_id }
// ---------------------------------------------------------------------------
module.exports = {
  receive: watcher.track('locomotion_judge', async function (signalType, payload) {
    if (signalType !== 'locomotion_judge') return; // ignore foreign signals

    const from = payload?.from;
    const capsule = payload?.locomotion;

    // Contract validation (Law 13): every field below is written by the dispatcher at chain
    // birth or by the reporting rung. Absence means a stray or wrongly-authored route — throw.
    if (!from || typeof from !== 'string') {
      throw new Error('[locomotion_judge] CODING VIOLATION: arriving signal has no from field.');
    }
    if (!capsule || typeof capsule !== 'object' || typeof capsule.invocation_id !== 'number' || typeof capsule.attempt !== 'number' || !capsule.verb) {
      throw new Error(`[locomotion_judge] CODING VIOLATION: signal from '${from}' lacks the inner locomotion capsule (verb/attempt/invocation_id). Only ladder rungs may route here.`);
    }
    if (typeof payload.success !== 'boolean') {
      throw new Error(`[locomotion_judge] CODING VIOLATION: signal from '${from}' has no boolean success field — rungs must declare their outcome explicitly.`);
    }

    const goalText = capsule.coordinate
      ? `(${capsule.coordinate.x},${capsule.coordinate.y},${capsule.coordinate.z})`
      : `${capsule.candidates_count || 0} ${capsule.candidates_kind || 'candidate'} candidates`;
    const outcomeText = payload.readable || '(no readable provided)';


    // Goal identity for the loop guard (portable_judge, SECTION 2b). Computed once; checkpointed
    // at the terminal verdicts below — a mid-goTo retry keeps the same invocation and is NOT a
    // fresh caller request, so it must not tick the counter.
    const key = goalKey(capsule);


    // -----------------------------------------------------------------------
    // SUCCESS: verdict to the dispatcher, which resolves the caller's promise.
    // -----------------------------------------------------------------------
    if (payload.success === true) {
      // A successful arrival is the gap closing to zero — progress, so it CLEARS the identical-goal
      // streak rather than feeding it (Law 11; see SECTION 2b). This is what lets a caller hold one
      // stand-cell across several work phases (farm_executor dig→place→place at a single anchor, each
      // phase re-reaching the same spot) without being strict-killed for re-asking a spot it keeps
      // reaching. Only three straight FAILURES to close the gap (below) are the stall.
      portableJudge.done(PJ_BUCKET);
      const out = {
        from: 'locomotion_judge',
        to: 'locomotion_dispatcher',
        task: 'locomotion_dispatcher',
        readable: `locomotion_judge: verdict success attempt_${capsule.attempt}`,
        locomotion_judge: {
          verdict: 'success',
          invocation_id: capsule.invocation_id,
          attempt: capsule.attempt,
          selected_target: capsule.selected_target || null
        }
      };
      return signalBus.route(out.to, out);
    }

    // -----------------------------------------------------------------------
    // FAILURE with budget remaining: retry ONLY if the attempt made forward
    // progress. The retry's whole rationale is riding the partial-path trail
    // closer (each fresh A* starts nearer the goal) — so it pays off only when the
    // bot actually advanced this attempt ('closer_but_not_arrived'). Every other
    // failure is a deterministic geometric dead-end from this position
    // (astar_no_path, no_progress, wrong_side, out_of_range, empty_path): a fresh
    // A* from the same spot repeats it identically, so three more attempts just
    // burn the budget and spam warns. Abandon at once and let the caller replan
    // against fresh world state — a different target (Law 12/16).
    // -----------------------------------------------------------------------
    const progressed = payload.fail_reason === 'closer_but_not_arrived';
    if (progressed && capsule.attempt < TOTAL_ATTEMPTS) {
      const nextAttempt = capsule.attempt + 1;
      watcher.summary('locomotion_judge',
        `🔁 Verdict retry: ${capsule.verb} → ${goalText} failed at '${from}' on attempt ${capsule.attempt}/${TOTAL_ATTEMPTS} ("${outcomeText}") — flat retry as attempt ${nextAttempt}.`
      );
      const out = {
        from: 'locomotion_judge',
        to: 'locomotion_dispatcher',
        task: 'locomotion_dispatcher',
        readable: `locomotion_judge: verdict retry attempt_${nextAttempt}`,
        locomotion_judge: {
          verdict: 'retry',
          invocation_id: capsule.invocation_id,
          attempt: nextAttempt,
          verb: capsule.verb,
          coordinate: capsule.coordinate ?? null,
          require_los: capsule.require_los ?? false,

          required_side: capsule.required_side ?? null,
          min_y: capsule.min_y ?? null,
          exact: capsule.exact ?? false,
          candidates_ref: capsule.candidates_ref ?? null,
          candidates_count: capsule.candidates_count ?? 0,
          candidates_kind: capsule.candidates_kind ?? null
        }
      };
      return signalBus.route(out.to, out);
    }

    // -----------------------------------------------------------------------
    // BUDGET EXHAUSTED: return failure to caller.
    // -----------------------------------------------------------------------
    // Terminal failure is the ONLY thing that feeds the identical-goal guard (success clears it — see
    // SECTION 2b): three straight failures to the same unreachable goal is the stall. Strict kill via
    // recursive_judge (portable_judge already routed, so return without a verdict; promise abandoned, Law 15).
    if (await portableJudge.checkpoint(PJ_BUCKET, key, 'strict') === false) return;
    watcher.warn('locomotion_judge',
      `⛔ Verdict failure: ${capsule.verb} → ${goalText} failed ${TOTAL_ATTEMPTS} attempts, last at '${from}' ("${outcomeText}"). Returning failure to caller (invocation #${capsule.invocation_id}).`
    );
    const out = {
      from: 'locomotion_judge',
      to: 'locomotion_dispatcher',
      task: 'locomotion_dispatcher',
      readable: `locomotion_judge: verdict failure ${capsule.verb}_to_${goalText.replace(/\s+/g, '_')} after ${TOTAL_ATTEMPTS} — last: ${outcomeText}`,
      locomotion_judge: {
        verdict: 'failure',
        invocation_id: capsule.invocation_id,
        attempt: capsule.attempt,
        reason: 'give_up'
      }
    };
    return signalBus.route(out.to, out);
  }),
};
