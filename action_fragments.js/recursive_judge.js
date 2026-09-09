// fragment: recursive_judge
// purpose: Stop infinite loops by detecting identical or oscillating fragment outcomes
// invariants:
//  - Tracks last N fragment outcomes (from + success + readable)
//  - After 3 identical contiguous outcomes: warn and route to job_board (brain refresh)
//  - After 5 identical contiguous outcomes: kill signal (engineering problem)
//  - After 3 AB oscillation pairs: kill signal (engineering problem)
//    (oscillation = two distinct signatures alternating: A→B→A→B→A→B)
//  - On kill: drops signal, logs clearly, NO routing (requires human inspection)
//
// Routing (Phase 2 — manager continuation):
//  - Signal FROM a manager → manager is done → route to job_board (skip loop detection)
//  - Signal FROM an executor with manager stamp → loop-check → route to stamped manager
//  - Signal with no stamp → loop-check → route to job_board
//  - Cognition escalation (threshold 3) overrides stamp → route to job_board
//
// WHY: Action layer is designed to complete tasks no matter what. If a fragment reports
//      the same outcome 3 times, the brain may have stale info — route to job_board
//      to refresh. If 5 identical outcomes total, it's an engineering problem
//      requiring code fixes, not a planning problem.
//
// Philosophy:
//  - Success with metrics (e.g., "mined 4 logs") shows progress variation
//  - Success without variation (e.g., "mined 0 logs" 5x) = stuck
//  - Failure repeated (e.g., "no trees found" 5x) = stuck
//  - Different readables = normal multi-step execution
//  - Brain gets ONE refresh attempt before declaring code bug
//
// Architecture:
//  - Compares: fragment name + success/fail + readable (normalized lowercase)
//  - Single responsibility: detect and stop infinite loops
//  - Managers decide task completion, not the judge
//  - No persistent history dependency (ephemeral memory only)

// ---------------------------------------------------------------------------
// SECTION 1: Dependencies and Constants
// ---------------------------------------------------------------------------
const watcher = require('@kernel/watcher');
const portableJudge = require('@kernel/portable_judge');
const sequencer = require('@kernel/signal_sequencer');

// ---------------------------------------------------------------------------
// SECTION 2: Configuration Constants
//
// COGNITION_THRESHOLD — Send to brain after 3 loops (stale plan refresh)
// KILL_THRESHOLD — Kill signal after 5 loops (engineering problem)
// MAX_HISTORY — Maximum entries to keep in ephemeral memory
// ---------------------------------------------------------------------------
const COGNITION_THRESHOLD = 3;
const KILL_THRESHOLD = 5;
const MAX_HISTORY = 20;

// eat_manager runs the same verify loop as these three (dispatch executor → judge returns here →
// re-sense → release or re-dispatch), so it must be in the set for BOTH the executor's stamp-return
// (route the eat outcome back to the manager to verify) AND the manager's release (route on to
// job_board). farm_manager is deliberately absent — it fires-and-replans through job_board, no verify hop.
const MANAGERS = new Set(['supply_manager', 'building_manager', 'mining_manager', 'eat_manager']);
// ---------------------------------------------------------------------------
// SECTION 3: History Management Functions
//
// Simple fragment outcome tracking:
//   - readHistory: Load history from ephemeral memory
//   - writeHistory: Save history to ephemeral memory (keep last MAX_HISTORY entries)
//   - addOutcome: Append new outcome and trim old entries
//   - getContiguousCount: Count identical outcomes at tail of history
//   - getOscillationCount: Count AB pair repetitions at tail of history
// ---------------------------------------------------------------------------

let ephemeralHistory = [];
function readHistory() {
  return ephemeralHistory;
}

function writeHistory(history) {
  ephemeralHistory = history.slice(-MAX_HISTORY); // Keep last N entries only
}

function addOutcome(from, success, readable) {
  const history = readHistory();
  history.push({
    from: String(from || 'unknown'),
    // undefined survives as undefined: Boolean() would fold "didn't state one" into "reported failure",
    // and the judge does not get to decide which of those a silent fragment meant.
    success: success === undefined ? undefined : Boolean(success),
    readable: String(readable || ''),
    timestamp: Date.now()
  });
  writeHistory(history);
  return history;
}

// Create normalized signature for comparison (ignore case, extra whitespace)
function outcomeSignature(outcome) {
  if (!outcome) return 'nil';
  const from = String(outcome.from || '').toLowerCase().trim();
  const success = outcome.success === undefined ? 'n/a' : String(Boolean(outcome.success));
  const readable = String(outcome.readable || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return `${from}|${success}|${readable}`;
}

function getContiguousCount(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const lastSig = outcomeSignature(history[history.length - 1]);
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (outcomeSignature(history[i]) === lastSig) count++;
    else break;
  }
  return count;
}

// Detect AB oscillation: two distinct signatures alternating at the tail.
// Contiguous detection misses multi-fragment loops because each fragment
// breaks the other's contiguous streak (A,B,A,B → contiguous = 1 always).
// This walks backward in pairs, counting how many times the tail pair repeats.
// Returns 0 if fewer than 2 complete pairs (not yet oscillation).
function getOscillationCount(history) {
  if (!Array.isArray(history) || history.length < 4) return 0;
  const sigB = outcomeSignature(history[history.length - 1]);
  const sigA = outcomeSignature(history[history.length - 2]);
  if (sigA === sigB) return 0;

  let pairs = 1;
  for (let i = history.length - 3; i >= 1; i -= 2) {
    if (outcomeSignature(history[i]) === sigB &&
        outcomeSignature(history[i - 1]) === sigA) {
      pairs++;
    } else {
      break;
    }
  }
  return pairs >= 2 ? pairs : 0;
}

// ---------------------------------------------------------------------------
// SECTION 4: Main Signal Handler (Entry Point)
//
// Routing + loop detection:
//   1. Validate signal (from, readable)
//   2. If from a manager → route to job_board (manager done, skip loop detection)
//   3. Extract success, record outcome, count contiguous identical + AB oscillation
//   4. If contiguous count === 3 → escalate to job_board (brain refresh, overrides stamp)
//   5. If contiguous count ≥ 5 → kill (engineering problem)
//   5b. If AB oscillation ≥ 3 pairs → kill (engineering problem, same as contiguous kill)
//   6. If payload.manager stamp → route to stamped manager (executor mid-job)
//   7. No stamp → route to job_board (no active task)
// ---------------------------------------------------------------------------

// A killed signal parks the bot's PLANNER. It must not park the bot's BODY.
//
// ── WHY THE INERT HALT WAS WORSE THAN THE LOOP IT STOPPED ─────────────────────────────────────────
//
// The combat gate is CALLER-DRIVEN — `combatCheckpoint` is called by the fragments that run work, and by
// nothing else. So a halt that stops every fragment also removes every caller of the gate, and the body
// then stands in a hostile world with no threat check at all — not parked, a punching bag.
//
// WORSE, THE HALT DID NOT HOLD. battle_stations' death watchdog fires after a death when no gate has
// consumed the latch — guaranteed here, because there is no gate — and routes to this judge, which routes
// to job_board, which restarts the planning recursion. The sequence was: kill the signal, lose the gate,
// get murdered, get resurrected BY the murder. Two exit authorities over one body, and the watchdog cannot
// tell a deliberate park from the frozen await it was actually written for.
//
// SENTRY IS THE PARK THAT KEEPS THE EYES OPEN, and it is an EXISTING mode with an existing chain origin
// (Law 22 gate 2 — reuse, not invention): `arm()` originates the one signal the watch holds, the watch
// calls battle_stations inline on its own poll, and `inSentry()` makes the branch above refuse the
// planning recursion outright. The planner stays stopped — which is what the kill is FOR (Law 13) — while
// the body keeps answering threats. Arming AFTER the kill is legal under Law 4: the killed chain is
// already dead, so the scope is free for the watch's fresh one.
//
// WHAT A SUCCESSOR MUST NOT "FIX" — RATIFIED, not merely tolerated: a bot stuck in an infinite loop goes
// into sentry mode to defend itself until death, and stays dead on purpose because it is stuck in a loop.
//
// A bot that dies while halted-into-sentry STAYS dead, because `death_manager` is dispatched by the
// planning recursion and sentry is precisely the absence of it. Read the whole sequence as ONE designed
// outcome rather than a gap someone forgot to close: the only thing that reaches this function is a bot
// whose planner produced the same outcome KILL_THRESHOLD times running, so the mind is confirmed broken
// before the body is ever parked. Reviving it returns a KNOWN-LOOPING planner to the board, which is not
// a recovery — it is the loop resuming with a fresh corpse behind it. Death is the terminal state of a
// bot that could not think, and it is the correct one.
//
// So the two halves are deliberate and neither is a consolation for the other: it defends itself while it
// lives (the kill parks the PLANNER, and a defenceless body was the fault this replaced) and it does not
// come back when it loses (the planner is what failed, so nothing may restart it but a human).
//
// The way back in is the operator's `respawn` verb — a HUMAN reading the trace and deciding, which is the
// inspection "halt for inspection" is named after. Do not reach for job_board here to stand the body up:
// that is the resurrection-by-murder pathway above, re-entered through the front door, and it would
// silently restore the exact behaviour this design rejected.
// claimedJobLabel — the identity of the job this chain belongs to, for the kill lines.
//
// Read from the boardroom magnet rather than the payload because the payload carries the CHAIN (from, to,
// readable) and not the JOB: the dispatcher stamps job identity into the chair, and that is the only place
// this fragment can ask. MUST be called before haltForInspection, which clears the magnet — called after,
// it returns "no magnet" on every kill and reads like a correct answer (Law 25).
//
// Unguarded on purpose. readBoardroomChair answers its fallback for an absent chair and only throws on a
// coding violation in the HQ cache — a defect the kill line must NOT dress up as "magnet unreadable", which
// reads as a world condition and buries a bug at the single most-read line of a run (Law 13: prove it is
// safe to proceed; surface early and loudly).
function claimedJobLabel() {
  const magnet = require('@kernel/corporate_headquarters')
    .readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
  if (!magnet) return 'no magnet (unclaimed chain — start-up, idle, or a self-originated signal)';
  // Spelled out rather than rendered `have X/Y`: the old form put a destination count over a pocket
  // goal and read as one fraction, which conflated two different quantities into one ambiguous number.
  // This line is where a stuck job is diagnosed, so it names the container each number counted.
  const qty = magnet.hold_goal != null
    ? ` (needs ${magnet.need} more, must hold ${magnet.hold_goal}, ${magnet.at_destination ?? 0} already at destination)`
    : (magnet.batch_quantity != null ? ` (batch of ${magnet.batch_quantity})` : '');
  // The magnet's own coordinates, matching the board and claim lines a reader is following this job back
  // through. This line is where a stuck job is diagnosed, and "which asker was this serving, at what
  // distance from done" is the first question asked of one. A pre-band magnet has no stage by design, so
  // it renders as its band alone rather than as a missing field.
  const band = magnet.asker && magnet.stage ? `${magnet.asker}/${magnet.stage}` : (magnet.asker || '?');
  return `[${band}] ${magnet.type}/${magnet.what}${qty}`;
}

async function haltForInspection(fragmentName) {
  const botId = process.env.BOT_ID || 'default';
  require('@thinking/dispatcher.js').clearMagnet();

  // Call-time require, same as the `inSentry` read in handleSignal — @action/await_aggro pulls the signal
  // stack in, and a module-scope require here is the load cycle that already cost `start_injector`.
  const awaitAggro = require('@action/await_aggro');
  // Checked rather than assumed: `arm()` routes a signal and journals a mode transition, so arming a watch
  // that is already armed would put a second chain into a scope that holds exactly one (Law 4). The bench
  // reaches this function too — a sentry trial whose fragment oscillates lands right here.
  const alreadyWatching = awaitAggro.inSentry();
  if (!alreadyWatching) awaitAggro.arm();

  watcher.summary('recursive_judge',
    `⏸️ ${botId} PLANNER HALTED after killing "${fragmentName}" — the planning signal is dropped and no job ` +
    `is active (Law 13, default stopped). The body is ${alreadyWatching ? 'already holding' : 'now holding'} a ` +
    `SENTRY watch, so it still answers threats and still logs its fights: quiet below this line means no mob ` +
    `came, NOT a hang. Nothing PLANS again until an operator re-tasks it.`);
  await watcher.flush();
}

async function handleSignal(signalType, signal) {
  if (signalType !== 'recursive_judge') {
    watcher.warn('recursive_judge', `⚠️ Ignored foreign signal type: ${signalType}`);
    return;
  }

  // Safety net (Law 8): portable_judge must be fully resolved before reaching here.
  // If it's still active, an executor was interrupted — flash and clear.
  portableJudge.reset();

  const signalBus = require('@kernel/signal_bus');
  const payload = signal || {};
  const readable = payload?.readable;
  const from = payload?.from;

  // Test-harness recursion guard (fragment_tester). A fragment under isolation test carries
  // `test: true` in its payload. Its SUCCESS output is captured by fragment_tester via a manual
  // reroute; but its FAILURE path soft-fails here like any environmental failure — and replanning
  // it would dispatch a fresh signal from world state, cascading into the real chain (a start
  // signal) and defeating the isolation. So when the test flag is set the judge HALTS: log the
  // outcome and route nothing. This is the flag's whole purpose — it must ride in the payload so
  // it survives the fragment through to here.
  //
  // ── THE ONE TEST CHAIN THAT COMES BACK ───────────────────────────────────────────────────────────
  //
  // `sentry: true` beside `test: true` means the sentry watch finished a WAVE and wants the next one. It
  // does NOT bypass this branch's purpose — it still never replans and never reaches job_board — it only
  // says where the halt is: at await_aggro, re-armed, instead of at nothing.
  //
  // Judging the sentry wave like the rest of the system is the load-bearing part, and it is why this
  // falls THROUGH rather than routing from here: the field checks, the sequencer, addOutcome and the
  // contiguous count all run on a sentry wave exactly as on a mining lap. A bench whose judge was disabled
  // would prove the fleet works while running code the fleet does not run (Law 16 — the sentry fights
  // through the fleet's own gate; it must be judged by the fleet's own judge).
  const isSentryWave = payload.test === true && payload.sentry === true;
  if (payload.test === true && !isSentryWave) {
    watcher.summary('recursive_judge',
      `🧪 Test signal from '${from || 'unknown'}' reached the judge (failure path) — halting, no replan. readable: ${readable || 'n/a'}`);
    return;
  }

  // ── NO PLANNING WHILE SENTRY IS ARMED ────────────────────────────────────────────────────────────
  //
  // The two branches above gate on FLAGS THE PAYLOAD CARRIES, which is sound only for chains that
  // originate in the watch. Combat has other doors: the locomotion layer runs its own inline gate so a
  // body does not walk past a hostile, and that call abandons to this judge carrying NO flags at all. Left
  // unguarded, that route lets battle_stations' abandonment land here as an ordinary signal, this judge
  // routes it to job_board, and the planning recursion runs a full board cycle in a bench whose entire
  // premise is that it does not (Law 16 — job_board is the planning recursion's one door, so the refusal
  // belongs at that door, not replicated at every caller that might knock).
  //
  // ASKED OF THE BOT, NOT OF THE MESSAGE, and that is the correction: sentry is a property of the
  // decision-maker's scope (Law 4), so a message-borne flag could never have covered the callers that do
  // not know they are in a trial. Required at call time like signal_bus below — await_aggro pulls the bus
  // in at module scope, so a module-scope require here is the cycle that already cost `start_injector`.
  //
  // HALT, not reroute (Law 13 — default stopped). The alternative, bouncing it back to await_aggro, would
  // re-arm a watch off a chain the watch never sent.
  const sentryMode = require('@action/await_aggro').inSentry();
  if (sentryMode && !isSentryWave) {
    watcher.summary('recursive_judge',
      `🛡️ SENTRY ARMED — '${from || 'unknown'}' reported outside the watch chain, so there is nothing to replan into: ` +
      `halting instead of routing to job_board (no planning recursion in sentry). readable: ${readable || 'n/a'}`);
    return;
  }

  // Law 13: every signal reaching recursive_judge must carry 'from' and 'readable' (Law 10
  // typed-message contract) — every fragment that routes here sets both explicitly. A signal
  // missing either can only result from a fragment that didn't follow the contract; that is a
  // coding violation, never an environmental condition, so throw rather than silently dropping
  // the signal (a silent drop would hide the bug that produced the malformed payload).
  if (!readable || typeof readable !== 'string') {
    throw new Error(`recursive_judge: signal from "${from || 'unknown'}" is missing a string 'readable' field (Law 10/13 violation)`);
  }

  if (!from || typeof from !== 'string') {
    throw new Error(`recursive_judge: signal is missing a string 'from' field — readable was "${readable}" (Law 10/13 violation)`);
  }

  // ── THE DUPLICATE-SIGNAL CHECK ───────────────────────────────────────────────────────────────────
  // This fragment is the only choke point the main loop has — every call site routes here and every lap
  // passes through exactly once — so the fleet's one guard against two live signals sits here. It is a
  // UTILITY, not a fragment: it examines the arriving payload, hands back the id to stamp on departure,
  // and throws on a mismatch. It never routes (a checker that routed would be a signal source, which is
  // the Law 3 fault that moved this off signal_bus in the first place).
  //
  // AFTER the field checks so a malformed payload throws for its own reason, and AFTER the test-flag
  // return above so an injected isolation chain never disturbs the run's count.
  //
  // `outboundId` is stamped onto all five exits below via depart(). It is the ONE field the judge
  // carries across the hop; everything else in the outbound envelope is rebuilt from scratch.
  const outboundId = sequencer.examine(payload);
  const depart = (outPayload) => {
    const stamped = sequencer.stamp(outPayload, outboundId);
    return signalBus.route(stamped.from, stamped.to, stamped);
  };

  // Portable judge delegation: child judge detected a stall/oscillation inside
  // an executor and routed here for the parent to decide the consequence.
  // Strict = kill immediately (the stall is a real engineering problem).
  // Forgiving = route to job_board for a fresh plan cycle (stall may self-resolve).
  const pjVerdict = payload?.portable_judge_verdict;
  if (pjVerdict) {
    const { executor, mode, reason } = pjVerdict;

    // NAME THE JOB, on both consequences and for the same reason the two kills below do: the reporting
    // fragment identifies the CHAIN, never the work, and a stall is diagnosed by what the bot was
    // holding when it stalled. Read BEFORE haltForInspection, which clears the magnet — read after, it
    // answers "no magnet" on every kill and reads like a correct answer (Law 25).
    //
    // It matters MOST here, and that is not obvious from the call order: a satellite escalation is the
    // one kill whose whole subject is a job the bot kept re-claiming and could never advance, so a kill
    // line naming only the executor throws away the single fact the next reader needs.
    const pjJob = claimedJobLabel();

    if (mode === 'strict') {
      watcher.error('recursive_judge',
        `⛔ PORTABLE JUDGE (STRICT): ${reason} in ${executor} — SIGNAL KILLED | job=${pjJob}`);
      watcher.summary('recursive_judge',
        `Portable judge reported ${reason} in "${executor}" (strict mode) on ${pjJob}. ` +
        `Signal killed by recursive_judge. No routing — requires human inspection.`);
      await haltForInspection(from);
      return;
    }

    watcher.warn('recursive_judge',
      `⚠️ PORTABLE JUDGE (FORGIVING): ${reason} in ${executor} on ${pjJob} — routing to job_board for replan`);
    watcher.summary('recursive_judge',
      `Portable judge reported ${reason} in "${executor}" (forgiving mode) on ${pjJob}. ` +
      `Routing to job_board for fresh evaluation — stall may resolve on retry.`);

    const forgivingPayload = {
      from: 'recursive_judge',
      to: 'job_board',
      task: 'job_board',
    };
    return depart(forgivingPayload);
  }

  // Read the reporting fragment's OWN capsule, and infer nothing when there isn't one.
  //
  // The judge's one verb is loop detection; whether an outcome was *good* is the manager's call, not
  // this fragment's (Law 0/Law 11 role split). Two ways this drifted into judging quality, both removed:
  //
  //  - It scanned EVERY capsule in the payload and took `.some(success === true)`. Executors route with
  //    `{...payload}`, so capsules ACCUMULATE down a chain — a peer's stale success could be attributed
  //    to whoever reported last. Every fragment keys its capsule by its own name (verified across the 8
  //    executors, start_injector and idle_scheduler), so `payload[from]` is the one owner of this
  //    outcome (Invariant D).
  //  - With no capsule it guessed from the prose: `readable.includes('success') || includes('pass')`.
  //    All four managers route with `{ readable }` and no capsule, so this fired on every manager
  //    outcome and got them WRONG — "supply_manager: completed logs (have 17/16)" logged as
  //    Success:false because the sentence lacked a word. A judged fact invented from substring luck is
  //    the fallback value Law 13 forbids, and it fed the loop signature.
  //
  // undefined is now a first-class answer: "the reporter did not state one." It is stable per fragment,
  // so the signature partitions exactly as before for managers (their success was already a pure
  // function of readable) — the judge just stops fabricating the field and stops logging a lie (Law 5/6).
  const success = payload[from] && typeof payload[from] === 'object' ? payload[from].success : undefined;
  const successText = success === undefined ? 'not stated' : String(success);
  const outcomeText = success === undefined ? 'an outcome' : (success ? 'success' : 'failure');

  // Add outcome to history and get updated history
  const history = addOutcome(from, success, readable);
  const contiguous = getContiguousCount(history);

  // Log current state — the judge's gap observation (Law 11): contiguous identical
  // outcomes track progress toward the loop-kill threshold.
  watcher.summary('recursive_judge',
    `Fragment: ${from} | Success: ${successText} | Readable: "${readable}" | Contiguous: ${contiguous}/${KILL_THRESHOLD}`
  );

  // Escalation at COGNITION_THRESHOLD: override any manager stamp and route
  // to job_board (brain) for a full re-evaluation to try to unstick.
  // NOT for a sentry wave, and this is the ONE judging step it skips. job_board is the planning
  // recursion's front door — a brain refresh would hand the arena bot a mining job mid-bench, which is
  // the exact coupling `test: true` exists to prevent. There is also nothing there for it: a wave has no
  // plan to refresh, only a next wave. The kill at KILL_THRESHOLD below still applies unchanged, so an
  // actually-stuck bench still halts — it just halts instead of being re-planned into the fleet.
  if (contiguous === COGNITION_THRESHOLD && !isSentryWave) {
    watcher.warn('recursive_judge', `⚠️ ${contiguous} identical outcomes — escalating to job_board for brain refresh`);
    watcher.summary('recursive_judge',
      `Loop detected after \x1b[33m3 attempts\x1b[0m from "${from}": "${readable}". ` +
      `\x1b[33mRouting to job_board\x1b[0m to re-evaluate before declaring engineering problem.`
    );

    const cognitionPayload = {
      from: 'recursive_judge',
      to: 'job_board',
      task: 'job_board',
    };

    return depart(cognitionPayload);
  }

  // Kill condition: KILL_THRESHOLD identical outcomes = engineering problem
  if (contiguous >= KILL_THRESHOLD) {
    // ── ONE ERROR LINE, AND IT NAMES THE JOB ─────────────────────────────────────────────────────────
    // This used to be six error() calls, one field each. Two faults came out of that: (a) a threshold or
    // success flag alone is a complete sentence in the error channel that means NOTHING out of context,
    // and error is the channel a reader scans first (Law 5) — six flags for one event, most unreadable
    // alone; (b) not one of the six named WHICH JOB died. The kill is the most consequential event in a
    // run, and naming only the reporting fragment forces hand-reading the surrounding lines to recover
    // which job was actually stuck — precisely the reconstruction the record exists to make unnecessary
    // (Invariant C).
    //
    // The magnet is the job's identity and it is read HERE rather than after, because haltForInspection
    // clears it — moving this read below the halt would print `job=none` on every kill and look correct.
    const jobText = claimedJobLabel();
    watcher.error('recursive_judge',
      `⛔ INFINITE LOOP DETECTED — SIGNAL KILLED | job=${jobText} | fragment=${from}`
      + ` | success=${successText} | contiguous=${contiguous}/${KILL_THRESHOLD}`
      + ` | readable="${readable}"`);
    watcher.summary('recursive_judge',
      `Recursive judge stopped an infinite loop on ${jobText}. Fragment "${from}" reported identical outcome ${contiguous} times: "${readable}". ` +
      `Brain was given a chance to refresh plan at ${COGNITION_THRESHOLD} loops but did not resolve issue. ` +
      `This is an engineering problem requiring code inspection. No signal routed.`
    );

    await haltForInspection(from);
    return;
  }

  // AB oscillation detection: two fragments alternating (A→B→A→B) evade
  // contiguous detection because neither signature repeats back-to-back.
  // Kills the signal — escalation to job_board does not help because the
  // brain re-posts the same job and the oscillation restarts immediately.
  const oscillation = getOscillationCount(history);

  if (oscillation >= COGNITION_THRESHOLD) {
    const sigA = outcomeSignature(history[history.length - 2]);
    const sigB = outcomeSignature(history[history.length - 1]);
    // One line, and it names the job — same reasoning as the contiguous kill above.
    const oscJob = claimedJobLabel();
    watcher.error('recursive_judge',
      `⛔ AB OSCILLATION DETECTED — SIGNAL KILLED | job=${oscJob} | pairs=${oscillation}`
      + ` | A="${sigA}" | B="${sigB}"`);
    watcher.summary('recursive_judge',
      `Recursive judge stopped an AB oscillation on ${oscJob}. Two fragments alternated ${oscillation} times: ` +
      `"${sigA}" ↔ "${sigB}". This is an engineering problem requiring code inspection. No signal routed.`
    );

    await haltForInspection(from);
    return;
  }

  // ── BACK TO THE SENTRY, RE-ARMED FOR THE NEXT WAVE ───────────────────────────────────────────────
  // Placed AFTER every kill check and BEFORE every job_board route, which is the whole of the design: a
  // sentry wave is judged by the same loop detector as everything else (five identical waves still halt
  // the bench for inspection) and is never handed to the planner.
  //
  // A FRESH CHAIN, not a resumed one. The arriving payload is dropped rather than spread — `{...payload}`
  // would carry the finished wave's battle capsule into the next wave, and await_aggro would arm holding
  // a result it did not earn (Law 12: the chain dies here and the judge dispatches fresh; Invariant B: the
  // next wave measures the world, never remembers the last one). `test: true` is re-set here rather than
  // inherited for the same reason — the isolation is this judge's assertion about the chain it is
  // originating, not a flag it found lying in a payload.
  if (isSentryWave) {
    watcher.summary('recursive_judge',
      `🛡️ Sentry wave from "${from}" judged: "${readable}" (contiguous ${contiguous}/${KILL_THRESHOLD}). ` +
      `Re-arming the watch for the next wave — no replan, no job_board.`);
    return depart({
      from: 'recursive_judge',
      to: 'await_aggro',
      task: 'await_aggro',
      test: true,
      readable: 'recursive_judge: wave judged — re-arming the sentry watch for the next wave',
    });
  }

  // Manager signals: route to job_board (manager is releasing the job).
  // Loop detection above still applies — if a manager sends the same
  // readable 3+ times, it gets escalated/killed like any other fragment.
  if (MANAGERS.has(from)) {
    watcher.summary('recursive_judge',
      `Manager "${from}" reporting: "${readable}". Routing to job_board for new job.`);
    const outPayload = {
      from: 'recursive_judge',
      to: 'job_board',
      task: 'job_board',
    };
    return depart(outPayload);
  }

  // Normal path: check for manager stamp in the payload.
  // If a manager stamped this signal, the executor is mid-job — route back
  // to that manager so it can dispatch the next step.
  // If no stamp, no active task — route to job_board for new job selection.
  const stampedManager = payload.manager;

  if (stampedManager && MANAGERS.has(stampedManager)) {
    watcher.summary('recursive_judge',
      `"${from}" reported ${outcomeText}: "${readable}". ` +
      `Returning to manager: ${stampedManager}.`);

    const outPayload = {
      ...payload,
      from: 'recursive_judge',
      to: stampedManager,
      task: stampedManager,
      executor: from,
    };

    return depart(outPayload);
  }

  watcher.summary('recursive_judge',
    `"${from}" reported ${outcomeText}: "${readable}". Routing to job_board.`
  );

  const outPayload = {
    from: 'recursive_judge',
    to: 'job_board',
    task: 'job_board',
  };

  return depart(outPayload);
}

// ---------------------------------------------------------------------------
// SECTION 5: Module Exports
//
// Exposes single receive function for signal bus integration.
// No legacy exports; all logic contained in handleSignal.
// ---------------------------------------------------------------------------

module.exports = {
  receive: handleSignal,
  // The loop calculation, exported so a test drives the REAL predicate instead of a hand-copy — the
  // same reason mining_cell_graph:514 exports overlapsStaircase: a hand-copied guard can only verify
  // against itself, never against the real signature, so both can appear "verified" while disagreeing.
  // This is the judge's one verb (Law 11: one judge per loop, its memory the record). capsule.success is
  // now an honest value instead of a hardcoded `true`, which is a change to what the exported functions
  // compute (the SIGNATURE), not to when the judge fires — that distinction now rests on a live run
  // finding it rather than a shifting test (`tools/README.md`); the kill threshold of 5 is still owed as
  // a load-time throw here.
  outcomeSignature, getContiguousCount, addOutcome,
};
