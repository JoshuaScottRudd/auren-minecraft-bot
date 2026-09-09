// module: idle_scheduler
// purpose: Idle re-check heartbeat. When the dispatcher finds every job claimed by peers (or
//   the board empty), the SPA chain has nowhere to route and the signal terminates. Nothing else
//   re-enters the loop for this bot, so it would sit idle forever even after a peer frees a job
//   (the exact "ran out of jobs and never woke up" failure). arm() schedules a single one-shot
//   timer that re-originates a fresh planning signal — identical in shape to start_injector's —
//   so the bot re-checks the board on a fixed cadence.
//
// Law 4 (one signal): the timer is armed by idle_park as its LAST act, once the idle chain has
//   already ended and the bot is parked — so no signal is live when the heartbeat fires. cancel()
//   is called at the top of every dispatcher run, so a real dispatch (or a re-fired heartbeat)
//   always clears the pending timer first; at most one is ever outstanding.

'use strict';

const { routeToJudge } = require('@utils/signal_utils');

// The cadence is set by the COMBAT gate below, not by the board read: an idle bot was defenceless,
// and at 10 s a creeper crossing at ~5 b/s covers the whole distance from the 15-block aggro edge to
// the 3.0-block fuse between two checks. One second keeps a detected mob outside the 4.75-block
// jump-trigger band, which is what strike-and-fade opens on. The board re-check simply rides the
// same heartbeat. Tune here only.
const RECHECK_MS = 1000;

// TWO CADENCES ON ONE TIMER, and separating them is the point (Architect: "when there is no tasks then
// the bot shall wait 10 seconds before scanning again"). The 1 s above is a COMBAT number and may not be
// slowed — at 10 s a creeper crosses from the aggro edge to its fuse between two checks. The BOARD
// re-scan was only riding that timer because it was there, and re-planning a gated board once a second
// buys nothing: every gate it re-evaluates clears on a world change (dawn, a deposit, a peer finishing),
// none of which arrive at 1 Hz. It also produced the trace flood that reads exactly like a loop — a full
// sequencer/judge/board triplet every second, saying the same thing each time.
//
// So the heartbeat keeps beating at 1 s for the body, and only originates a PLANNING signal on the 10 s
// boundary. Law 4 is preserved because the two branches are exclusive: a beat that does not plan owns no
// signal, so it re-arms itself; a beat that plans hands off to the chain, which re-arms via idle_park.
const BOARD_RESCAN_MS = 10000;
let _lastBoardScanAt = 0;

let _timer = null;

// Monotonic heartbeat counter. The idle re-check is a HEARTBEAT — it is supposed to fire over and
// over — but recursive_judge kills any fragment that reports the identical readable 5× in a row.
// So each fire must carry a unique token or the judge false-positives the heartbeat as an infinite
// loop. This counter only ever increments (never reset): resetting it in cancel() would zero it on
// every dispatcher pass — cancel() runs at the top of each run — and reproduce the collision.
let _checkNumber = 0;

function cancel() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

// Schedule the next board re-check. Idempotent: clears any pending timer first so re-arming on a
// repeated idle never stacks heartbeats.
function arm() {
  cancel();
  _timer = setTimeout(async () => {
    _timer = null;

    // THE IDLE LOOP'S INLINE GATE — the one loop boundary that never had one. battleStations is
    // awaited at ~20 executor and locomotion boundaries, but nothing on the idle path ever called it,
    // so a parked bot stood at the headframe anchor while a creeper walked up to it.
    //
    // This is the SAFEST of all its call sites: the idle chain has already terminated and this timer has
    // not yet originated the next signal, so nothing owns the body. On a threat, battleStations takes
    // over and abandons this callback (Law 15) — it never returns, so the board re-check below never
    // fires. That is correct and deliberate: the engagement's own abandon originates the next signal,
    // and two would be a Law 4 violation.
    //
    // Goes through combatCheckpoint like every other caller. The pacing costs this site nothing it can
    // notice — an idle bot is by definition not inside a dig or a drive leg, so the process-wide clock
    // is always free when the heartbeat arrives — and it buys the bypass, which matters here because
    // this timer keeps running while combat holds the body.
    const bot = global.bot;
    if (bot && bot.entity && bot.entity.position) {
      // Unguarded: battle_stations is ours. The old guard reasoned that a throw here would leave the
      // bot asleep forever with no timer and no owner — but a throw out of this heartbeat reaches
      // master_core's crash reporter, which stops the bot rather than abandoning it. Absorbing it was
      // the shape that actually produced a silent bot: the gate failed, the heartbeat rescheduled, and
      // the fleet went on idling past a broken combat gate (Law 13).
      const { combatCheckpoint } = require('@api/battle_stations');
      await combatCheckpoint(bot, 'idle');
    }

    // Body checked, board not due — beat again without originating anything. This branch owns no
    // signal, so it must re-arm itself or the bot is left with no timer and no owner (Law 8).
    if (Date.now() - _lastBoardScanAt < BOARD_RESCAN_MS) { arm(); return; }
    _lastBoardScanAt = Date.now();

    const signalBus = require('@kernel/signal_bus');
    // No manager stamp → recursive_judge treats this as "no active task" and routes to job_board
    // for a fresh plan cycle (same entry as start_injector). The #N makes each heartbeat's readable
    // distinct so the judge's identical-outcome kill never trips on the heartbeat itself.
    routeToJudge(signalBus, 'idle_scheduler', {
      readable: `idle_scheduler: idle re-check #${++_checkNumber} — re-planning from fresh world state`,
      idle_scheduler: { success: true },
    });
  }, RECHECK_MS);
}

// ── Idle-phase log gate — posts once every IDLE_LOG_MS, or immediately when there's a dispatch.
//
// At the 1 s heartbeat, an idle bot re-runs dispatcher → idle_park about once a second, and BOTH post a
// line describing the same pass — the per-step noise Law 5 removed, and it would bury the engagement
// lines the combat work exists to read.
//
// The decision is made ONCE per pass, by the dispatcher (which owns entry into the idle phase), and
// carried to idle_park in the payload. That is deliberate: if each fragment kept its own rate limiter
// they would drift out of phase and the trace would show a park line with no reason line, or the
// reverse. One decision, one owner (Invariant D), routed where it can be read (Law 6).
//
// The state lives here rather than in either fragment because this module already owns the idle
// phase's other state (the heartbeat) and both fragments already require it.
const IDLE_LOG_MS = 10000;
let _lastIdleLogAt = 0;
let _idlePasses = 0;

// → { passes } when this pass may post, else null. Stamps on success, so it is an acquire, not a query.
function shouldLogIdlePhase() {
  _idlePasses++;
  const now = Date.now();
  if (now - _lastIdleLogAt < IDLE_LOG_MS) return null;
  _lastIdleLogAt = now;
  return { passes: _idlePasses };
}

// A real job was dispatched — the idle phase is over. Zeroing the stamp is the "or when there's a
// dispatch" half: without it, a bot that idles, gets dispatched, and idles again within the same 10 s
// window would open its second idle phase silently, and the trace would show no boundary between them.
// The board stamp resets for the same reason: the next idle must scan at once rather than serve out the
// remainder of a window opened before the bot had work.
function noteDispatch() { _lastIdleLogAt = 0; _idlePasses = 0; _lastBoardScanAt = 0; }

module.exports = { arm, cancel, shouldLogIdlePhase, noteDispatch, RECHECK_MS, BOARD_RESCAN_MS, IDLE_LOG_MS };
