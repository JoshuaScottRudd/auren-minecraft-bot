// module: idle_scheduler
// purpose: Idle re-check heartbeat. When the SPA chain finds no job to route, nothing else re-enters
//   the loop for this bot, so arm() schedules a one-shot timer that re-originates a fresh planning
//   signal — identical in shape to start_injector's — so the bot re-checks the board on a fixed cadence.
//
// Law 4 (one signal): the timer is armed by idle_park as its LAST act, once the idle chain has
//   already ended and the bot is parked — so no signal is live when the heartbeat fires. cancel()
//   is called at the top of every dispatcher run, so a real dispatch (or a re-fired heartbeat)
//   always clears the pending timer first; at most one is ever outstanding.

'use strict';

const { routeToJudge } = require('@utils/signal_utils');

// Set by the combat gate below, not the board read: at 1 s a detected mob stays outside the
// 4.75-block jump-trigger band that strike-and-fade opens on; at 10 s a creeper crossing at ~5 b/s
// could close the 15-block aggro edge to its 3.0-block fuse between checks. The board re-check rides
// the same heartbeat. Tune here only.
const RECHECK_MS = 1000;

// TWO CADENCES ON ONE TIMER: the 1 s body-safety check above and this 10 s board re-scan share one
// heartbeat, which keeps beating at 1 s for the body and only originates a planning signal on the 10 s
// boundary. Law 4 holds because the two branches are exclusive — a beat that does not plan re-arms
// itself; a beat that plans hands off to the chain, which re-arms via idle_park.
const BOARD_RESCAN_MS = 10000;
let _lastBoardScanAt = 0;

let _timer = null;

// Monotonic heartbeat counter: recursive_judge kills any fragment that reports the identical readable
// 5x in a row, so each fire carries a unique token. It only ever increments — resetting it in cancel()
// would zero it on every dispatcher pass and reproduce the collision cancel() guards against.
let _checkNumber = 0;

function cancel() {
  if (_timer) { require('@utils/timeout_crash').stop(_timer); _timer = null; }
}

// Schedule the next board re-check. Idempotent: clears any pending timer first so re-arming on a
// repeated idle never stacks heartbeats.
function arm() {
  cancel();
  _timer = require('@utils/timeout_crash').later('idle_scheduler', 'the next beat of an idle body: check for a threat, re-read the board when due', async () => {
    _timer = null;

    // THE IDLE LOOP'S COMBAT GATE: battleStations is awaited here like at every executor and locomotion
    // boundary, so a parked bot is checked for a threat on every heartbeat.
    //
    // Safe at this call site because the idle chain has already terminated and this timer has not yet
    // originated the next signal, so nothing owns the body. On a threat, battleStations takes over and
    // abandons this callback (Law 15); the board re-check below never fires, and the engagement's own
    // abandon originates the next signal, holding Law 4 (one signal).
    //
    // Goes through combatCheckpoint like every other caller, which paces it against the process-wide
    // clock.
    const bot = global.bot;
    if (bot && bot.entity && bot.entity.position) {
      // Unguarded: battle_stations is ours. A throw here reaches master_core's crash reporter, which
      // stops the bot and surfaces the fault (Law 13).
      const { combatCheckpoint } = require('@api/battle_stations');
      await combatCheckpoint(bot, 'idle');
    }

    // Body checked, board not due — beat again without originating anything. This branch owns no
    // signal, so it must re-arm itself or the bot is left with no timer and no owner (Law 8).
    if (Date.now() - _lastBoardScanAt < BOARD_RESCAN_MS) { arm(); return; }
    _lastBoardScanAt = Date.now();

    // No manager stamp → recursive_judge treats this as "no active task" and routes to job_board
    // for a fresh plan cycle (same entry as start_injector). The #N makes each heartbeat's readable
    // distinct so the judge's identical-outcome kill never trips on the heartbeat itself.
    routeToJudge('idle_scheduler', {
      readable: `idle_scheduler: idle re-check #${++_checkNumber} — re-planning from fresh world state`,
      idle_scheduler: { success: true },
    });
  }, RECHECK_MS);
}

// ── Idle-phase log gate — posts once every IDLE_LOG_MS, or immediately when there's a dispatch.
//
// At the 1 s heartbeat, an idle bot re-runs dispatcher → idle_park about once a second; without this
// gate both would post a line for the same pass and bury the engagement lines combat work exists to
// read.
//
// The decision is made once per pass, by the dispatcher (which owns entry into the idle phase), and
// carried to idle_park in the payload — one decision, one owner (Invariant D), routed where it can be
// read (Law 6).
//
// The state lives here because this module already owns the idle phase's other state (the heartbeat)
// and both fragments already require it.
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

// Clears the idle-phase state when a real job is dispatched, so a bot that idles, gets dispatched, and
// idles again within the same window opens a new idle phase with a visible boundary in the trace. The
// board stamp resets too, so the next idle scans at once.
function noteDispatch() { _lastIdleLogAt = 0; _idlePasses = 0; _lastBoardScanAt = 0; }

module.exports = { arm, cancel, shouldLogIdlePhase, noteDispatch, RECHECK_MS, BOARD_RESCAN_MS, IDLE_LOG_MS };
