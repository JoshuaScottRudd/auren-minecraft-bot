// fragment: recursive_judge
// purpose: Detects identical or oscillating fragment outcomes and stops the loop they signal.
// invariants:
//  - Tracks last MAX_HISTORY outcomes (from + success + readable)
//  - 3 identical contiguous, or 3 AB oscillation pairs → warn/kill per the thresholds below
//  - 5 identical contiguous → kill (engineering problem, no routing, human inspection required)
//
// Routing: signal FROM a manager → job_board (skip loop detection); FROM an executor with a manager
// stamp → loop-check → that manager; unstamped → loop-check → job_board. Cognition escalation (3
// loops) overrides any stamp and also routes to job_board.
//
// Compares fragment name + success/fail + readable (normalized lowercase). Managers decide whether a
// task is done; this fragment only detects and stops loops (ephemeral memory only).

// ---------------------------------------------------------------------------
// SECTION 1: Dependencies and Constants
// ---------------------------------------------------------------------------
const watcher = require('@kernel/watcher');
const portableJudge = require('@kernel/portable_judge');
const sequencer = require('@kernel/signal_sequencer');
// One of the six FORWARDING routers: calls route() with an upstream author's own from/to, so it cannot
// use signal_utils' helpers (they stamp `from` = the caller).
const signalBus = require('@kernel/signal_bus');

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

// eat_manager runs the same verify loop as these three (dispatch → judge → re-sense → release), so it
// is in the set; farm_manager fires-and-replans through job_board with no verify hop, so it is absent.
const MANAGERS = new Set(['supply_manager', 'building_manager', 'mining_manager', 'eat_manager']);
// ---------------------------------------------------------------------------
// SECTION 3: History Management Functions
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
    // undefined means the reporter did not state a success value; kept distinct from false so the
    // judge never invents a verdict for a silent fragment (Law 13).
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

// Detects two distinct signatures alternating at the tail (A,B,A,B...), which contiguous counting
// cannot see since each fragment breaks the other's streak. Returns 0 if fewer than 2 complete pairs.
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
// ---------------------------------------------------------------------------

// A killed signal parks the bot's PLANNER only, never its BODY: haltForInspection arms the SENTRY watch
// (await_aggro), so the body keeps defending itself while the planner stays stopped. Only the operator's
// `respawn` verb re-arms the planner (Law 13).

// claimedJobLabel — the job identity for the kill lines, read from the boardroom magnet since the
// payload carries the CHAIN, not the JOB. Called before haltForInspection, which clears the magnet
// (Law 25). Unguarded: a throw here is a real HQ-cache defect, not an absent-chair fallback (Law 13).
function claimedJobLabel() {
  const magnet = require('@kernel/corporate_headquarters')
    .readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
  if (!magnet) return 'no magnet (unclaimed chain — start-up, idle, or a self-originated signal)';
  // Names the container each number counted, avoiding an ambiguous `have X/Y` fraction; goal_parts
  // mirrors the breakdown assessors/shared.supplyJob validated against the total.
  const parts = Array.isArray(magnet.goal_parts) && magnet.goal_parts.length
    ? ` = ${magnet.goal_parts.map(p => `${p.who} ${p.amount}`).join(' + ')}`
    : '';
  const qty = magnet.hold_goal != null
    ? ` (needs ${magnet.need} more, must hold ${magnet.hold_goal}${parts}, ${magnet.at_destination ?? 0} already at destination)`
    : (magnet.batch_quantity != null ? ` (batch of ${magnet.batch_quantity})` : '');
  // The magnet's own coordinates, matching the board and claim lines a reader is already following. A
  // pre-band magnet has no stage, so it renders as its band alone, not a missing field.
  const band = magnet.asker && magnet.stage ? `${magnet.asker}/${magnet.stage}` : (magnet.asker || '?');
  return `[${band}] ${magnet.type}/${magnet.what}${qty}`;
}

async function haltForInspection(fragmentName) {
  const botId = process.env.BOT_ID || 'default';
  require('@thinking/dispatcher.js').clearMagnet();

  // Call-time require, same as the `inSentry` read in handleSignal (@action/await_aggro's own load cycle).
  const awaitAggro = require('@action/await_aggro');
  // Checked, not assumed: arm() journals a mode transition, and a scope holds exactly one chain (Law 4).
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

  const payload = signal || {};
  const readable = payload?.readable;
  const from = payload?.from;

  // fragment_tester marks an isolation-test payload with `test: true`. Its success is captured via a
  // manual reroute; its failure path reaches here and halts with no routing, so replanning never
  // cascades the isolated chain into a real one.
  //
  // `sentry: true` beside `test: true` means the sentry watch wants the next wave — it still never
  // replans, it only moves the halt to await_aggro, re-armed — and falls through so the wave is judged
  // by the same checks as any other signal (Law 16).
  const isSentryWave = payload.test === true && payload.sentry === true;
  if (payload.test === true && !isSentryWave) {
    watcher.summary('recursive_judge',
      `🧪 Test signal from '${from || 'unknown'}' reached the judge (failure path) — halting, no replan. readable: ${readable || 'n/a'}`);
    return;
  }

  // Sentry state is read from await_aggro, not trusted to a payload flag, since combat's locomotion gate
  // abandons straight here with no flags at all (Law 4). Halts without routing: job_board is the
  // planning recursion's one door (Law 16).
  const sentryMode = require('@action/await_aggro').inSentry();
  if (sentryMode && !isSentryWave) {
    watcher.summary('recursive_judge',
      `🛡️ SENTRY ARMED — '${from || 'unknown'}' reported outside the watch chain, so there is nothing to replan into: ` +
      `halting instead of routing to job_board (no planning recursion in sentry). readable: ${readable || 'n/a'}`);
    return;
  }

  // Every fragment that routes here sets 'from' and 'readable' explicitly (Law 10); a signal missing
  // either is a coding violation and throws (Law 13).
  if (!readable || typeof readable !== 'string') {
    throw new Error(`recursive_judge: signal from "${from || 'unknown'}" is missing a string 'readable' field (Law 10/13 violation)`);
  }

  if (!from || typeof from !== 'string') {
    throw new Error(`recursive_judge: signal is missing a string 'from' field — readable was "${readable}" (Law 10/13 violation)`);
  }

  // The fleet's one guard against two live signals, since every call site routes here exactly once.
  // sequencer.examine/stamp inspects the payload and hands back an id to stamp on departure — it never
  // routes (Law 3). `outboundId` is stamped onto all five exits below via depart(); the rest of the
  // outbound envelope is rebuilt fresh.
  const outboundId = sequencer.examine(payload);
  const depart = (outPayload) => {
    const stamped = sequencer.stamp(outPayload, outboundId);
    return signalBus.route(stamped.to, stamped);
  };

  // A child judge detected a stall/oscillation inside an executor and routed here for the parent to
  // decide: strict kills immediately, forgiving routes to job_board for a fresh plan cycle.
  const pjVerdict = payload?.portable_judge_verdict;
  if (pjVerdict) {
    const { executor, mode, reason } = pjVerdict;

    // Names the job on both consequences, same as the two kills below (Law 25). Read before
    // haltForInspection, which clears the magnet.
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

  // Reads the reporting fragment's own capsule (payload[from]), the one owner of the outcome — capsules
  // otherwise accumulate down a chain as executors route with `{...payload}` (Invariant D). undefined is
  // a first-class answer meaning the reporter did not state one (Law 5/6/13); whether an outcome was
  // good is the manager's call, not this fragment's (Law 0/11).
  const success = payload[from] && typeof payload[from] === 'object' ? payload[from].success : undefined;
  const successText = success === undefined ? 'not stated' : String(success);

  const history = addOutcome(from, success, readable);
  const contiguous = getContiguousCount(history);

  // The judge's gap observation (Law 11): contiguous identical outcomes track progress toward the kill.
  watcher.summary('recursive_judge',
    `Fragment: ${from} | Success: ${successText} | Readable: "${readable}" | Contiguous: ${contiguous}/${KILL_THRESHOLD}`
  );

  // At COGNITION_THRESHOLD: override any manager stamp and route to job_board for a full re-evaluation.
  // Skipped for a sentry wave, since a wave has no plan to refresh, only a next wave; the KILL_THRESHOLD
  // kill below still applies, so an actually-stuck bench still halts.
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

  if (contiguous >= KILL_THRESHOLD) {
    // One error line naming the job (Law 5, Invariant C). Read before haltForInspection, which clears
    // the magnet.
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

  // AB oscillation: two fragments alternating (A→B→A→B) evade contiguous detection. Killed, not
  // escalated: job_board reposting the same job would restart the oscillation immediately.
  const oscillation = getOscillationCount(history);

  if (oscillation >= COGNITION_THRESHOLD) {
    const sigA = outcomeSignature(history[history.length - 2]);
    const sigB = outcomeSignature(history[history.length - 1]);
    // One line naming the job, same reasoning as the contiguous kill above.
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

  // Placed after every kill check and before every job_board route, so a sentry wave is judged like any
  // other signal and never handed to the planner. Dispatches a fresh chain, not a spread payload —
  // carrying the finished capsule forward would arm await_aggro holding an unearned result (Law 12).
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

  // Manager signals release the job to job_board; loop detection above still applies to a manager.
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

  // A manager stamp means the executor is mid-job — route back to that manager; no stamp means no
  // active task — route to job_board for new job selection.
  const stampedManager = payload.manager;

  if (stampedManager && MANAGERS.has(stampedManager)) {
    // Destination only — the outcome is already on the `Fragment: … | Readable: …` line above (Law 8:
    // every message states its destination).
    watcher.summary('recursive_judge', `→ manager: ${stampedManager}`);

    const outPayload = {
      ...payload,
      from: 'recursive_judge',
      to: stampedManager,
      task: stampedManager,
      executor: from,
    };

    return depart(outPayload);
  }

  watcher.summary('recursive_judge', '→ job_board');

  const outPayload = {
    from: 'recursive_judge',
    to: 'job_board',
    task: 'job_board',
  };

  return depart(outPayload);
}

// ---------------------------------------------------------------------------
// SECTION 5: Module Exports
// ---------------------------------------------------------------------------

module.exports = {
  receive: handleSignal,
  // The loop calculation, exported so a test drives the real predicate (same reason mining_cell_graph:514
  // exports overlapsStaircase). The judge's one verb (Law 11: one judge per loop, its memory the record).
  outcomeSignature, getContiguousCount, addOutcome,
};
