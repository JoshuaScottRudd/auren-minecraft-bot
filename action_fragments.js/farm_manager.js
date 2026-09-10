// fragment: farm_manager (action / farming)
// purpose: The routing head of the farming triad AND the owner of the cluster tend LOOP. The wheat plots
//          form one tight cluster near home; tended as independent jobs the fleet re-travelled the full
//          round trip to home for every plot. So the manager now services the WHOLE cluster in ONE
//          committed visit — the Law 11 SPA loop:
//            - Manager  = this loop: sense the cluster, pick the next plot, delegate, verify, repeat.
//            - Executor = farm_executor.tendPlot(bot, roomKey) — one plot per call (Law 15 API).
//            - Judge    = "no actionable plot left to service" — the loop's termination.
//          It reuses the established primitives (farming_integrity.scanCluster to sense, land_prep.prepare
//          to bulk-supply once, farm_executor.tendPlot to work each plot) and OWNS the single route to
//          recursive_judge at the end — the same repeated-dispatch shape that scales to small and big work
//          alike.
//
// WHY the manager loops instead of the executor: re-sensing after each executor step until no actionable
// plot remains is the Manager/Judge role (Law 11), and keeping the loop here (not inside the executor)
// keeps the executor a pure one-plot Executor. The old signal chain (manager → land_prep → farm_executor,
// one plot, then recursive_judge re-dispatches the next job) is retired: land_prep and farm_executor are
// now Law-15 APIs this manager calls directly, so control returns here after each plot with NO re-entrant
// signal (Law 12) and exactly ONE signal lives for the whole visit (Law 4). Preemption still works at plot
// boundaries: battleStations fights before each plot, and a judge STRICT-kill abandons the loop mid-await
// (Law 15) exactly as it would any executor.

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const farmingIntegrity = require('@perception/farming_integrity');
const landPrep = require('@action/land_prep');
const farmExecutor = require('@action/farm_executor');
// Entered through combatCheckpoint, never battleStations directly. One process-wide 500 ms clock, shared
// with the dig and drive primitives that carry the same gate, plus the engaging/escaping bypass so
// combat's own arms cannot re-enter it. The whole reasoning is in its header; a call a primitive already
// paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { routeToJudge } = require('@utils/signal_utils');
const { FARM_BLUEPRINT_NAME } = require('@thinking/architect_config');

const TAG = 'farm_manager';

function _release(reason) {
  watcher.summary(TAG, `Releasing: ${reason}`);
  routeToJudge(TAG, { readable: `${TAG}: ${reason}` });
}

// The nearest unserviced plot to the bot's current position — greedy in-cluster ordering so the visit walks
// the short hops between plots instead of criss-crossing. Distance is planar (x/z); the plots share
// roughly one Y band on the riverbank.
function _nearest(plots, pos) {
  let best = null, bestD = Infinity;
  for (const p of plots) {
    const d = Math.hypot(p.center.x - pos.x, p.center.z - pos.z);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType, payload = {}) {
    if (signalType !== TAG) return;
    const bot = global.bot;

    const botId = process.env.BOT_ID || 'default';
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    if (!magnet || !magnet.what) return _release('no active magnet');

    // Sense the whole cluster once up front — decides whether to prep and whether there is anything to do.
    // NOT GUARDED, AND THE GUARD'S REMOVAL IS THE POINT. scanCluster is ours, and it already absorbs every
    // environmental failure a plot scan can have, per plot, and keeps going. So a throw that escapes it is
    // a defect by elimination, and the only thing a catch here could do is convert that defect into a
    // quiet release — the bot stands down, the board replans, the log says the scan failed, and the fleet
    // runs on looking healthy. That is not a hypothetical: the inner scan was made to rethrow an unbound
    // identifier so it would surface, and this catch sat above it turning the surfaced fault straight back
    // into weather. A guard that defeats a deliberate throw one frame below it is worse than no guard
    // (Law 13: default stopped; Law 16: catch is never the expected pathway).
    const cluster = farmingIntegrity.scanCluster(bot);

    if (!cluster.located)       return _release('no farm plot located yet — base-layout lock pending');
    if (!cluster.any_actionable) return _release(`cluster idle (${cluster.plot_count} plots, none actionable)`);

    // ── PREP ONCE for the whole visit ── If any actionable plot needs building or planting, pull a hoe +
    // seeds for every plantable plot BEFORE the loop, so the bot never walks home to resupply mid-cluster
    // (the whole point). Harvest-only visits skip prep (harvest consumes nothing). A prep abandon (no hoe
    // obtainable) already routed to recursive_judge (Law 15) — stop here, never route a second signal (Law 4).
    // `bonemeal` plots join the prep call rather than getting a second one: the whole point of this block
    // is ONE resupply per visit, and a growing plot needs its bone meal in the pocket for exactly the
    // reason a plant plot needs its seeds there (farm_executor applies from the hand, not from a chest).
    // One unit per treatable plot — bonemealReachable spends at most one per crop it advances and stops
    // the moment the pocket is empty, so over-pulling a scarce item buys nothing.
    const plantablePlots = cluster.actionable_plots.filter(p => p.phase === 'build' || p.phase === 'plant');
    const bonemealPlots  = cluster.actionable_plots.filter(p => p.phase === 'bonemeal');
    if (plantablePlots.length > 0 || bonemealPlots.length > 0) {
      const prepared = await landPrep.prepare(bot, {
        seeds: plantablePlots.length, boneMeal: bonemealPlots.length,
      });
      if (!prepared) return;   // land_prep abandoned to the judge — one signal already lives
    }

    // ── THE CLUSTER TEND LOOP ── Re-sense the cluster each iteration (Invariant B), pick the NEAREST
    // unserviced actionable plot, service it once, mark it serviced. Each plot gets exactly ONE tendPlot per
    // visit: the `serviced` set is the loop's termination guarantee — a plot that partially progressed (built
    // its dirt but ran out of seeds before planting) stays 'actionable' in the re-scan, so without the set it
    // would be re-picked forever; with it that plot simply re-posts next cycle (skip-and-continue). A plot
    // that failed outright (unreachable / all-refused) is likewise marked serviced and skipped — one bad plot
    // never wastes the trip for the rest of the cluster.
    const serviced = new Set();
    let workedTotal = 0, refusedTotal = 0, visited = 0;
    while (true) {
      await combatCheckpoint(bot, 'farm_plot');   // combat preempts at each plot boundary (same guard the per-cell loop uses)

      // Unguarded for the reason the sense above it is — scanCluster absorbs every per-plot environmental
      // failure itself, so a throw escaping it is a defect, and a guard here would release the bot quietly
      // and leave the fleet looking healthy (Law 13, Law 16).
      const scan = farmingIntegrity.scanCluster(bot);
      const remaining = scan.actionable_plots.filter(p => !serviced.has(p.roomKey));
      if (remaining.length === 0) break;

      const plot = _nearest(remaining, bot.entity.position);
      serviced.add(plot.roomKey);
      visited++;

      // tendPlot is a Law-15 API: environmental per-plot failure returns worked=0 with a reason (skip it);
      // a genuine CODING VIOLATION throws (Law 13) and must surface loudly, so it is NOT caught here.
      const res = await farmExecutor.tendPlot(bot, plot.roomKey, FARM_BLUEPRINT_NAME);
      workedTotal += res.worked || 0;
      refusedTotal += res.refused || 0;
    }

    // ── VISIT VERDICT ── The anti-fabrication check, now at cluster scope (it moved up from the executor,
    // which no longer routes). Worked something → real progress, success. Serviced plots but worked NOTHING
    // while the world refused every action → the cluster is stuck (sited into terrain it cannot work);
    // report success:false so recursive_judge counts a real fault instead of reading fabricated no-ops as a
    // healthy loop and killing the bot. Nothing serviceable after prep → benign release.
    if (visited === 0) return _release('cluster had no serviceable plot after prep');
    const success = workedTotal > 0;
    const readable = `${TAG}: cluster visit serviced ${visited} plot(s) — worked=${workedTotal} refused=${refusedTotal}`
      + (success ? '' : ' [STUCK — nothing worked]');
    watcher.summary(TAG, readable);
    return routeToJudge(TAG, {
      ...payload,
      [TAG]: { success, worked: workedTotal, refused: refusedTotal, visited },
      success, readable,
    });
  }),
};
