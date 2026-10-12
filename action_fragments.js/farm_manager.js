// fragment: farm_manager (action / farming)
// Routing head of the farming triad and owner of the cluster tend loop (Law 11 SPA): services the
// whole wheat cluster in one committed visit instead of one job per plot.
//   - Manager  = this loop: sense the cluster, pick the next plot, delegate, verify, repeat.
//   - Executor = farm_executor.tendPlot(bot, roomKey) — one plot per call (Law 15 API).
//   - Judge    = no actionable plot left to service — the loop's termination.
// Calls farming_integrity.scanCluster to sense and land_prep.prepare to bulk-supply once, and owns
// the single route to recursive_judge at the end.
//
// The loop lives in the manager, so re-sensing after each step stays the Manager/Judge role
// (Law 11) and the executor stays a pure one-plot unit; control returns here
// after each plot with no re-entrant signal (Law 12) and exactly one signal lives for the whole
// visit (Law 4). Preemption still works at plot boundaries: battleStations fights before each plot,
// and a judge STRICT-kill abandons the loop mid-await (Law 15) exactly as it would any executor.

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
const blueprintSurvey = require('@perception/blueprint_survey');   // geometryOf: which blueprint this instance is
const { FARM_ROOM_KEYS } = require('@thinking/architect_config');

const TAG = 'farm_manager';

function _release(reason) {
  watcher.summary(TAG, `Releasing: ${reason}`);
  routeToJudge(TAG, { readable: `${TAG}: ${reason}` });
}

// LOWEST ANCHOR FIRST. A tine row stands on the land block of the row behind it, so a row can only
// be worked once every row between it and the bank is whole — the order walking out along the tine
// passes them in anyway. FARM_ROOM_KEYS is locked in anchor order (tine by tine, bank outward), so
// the lowest key still unserviced is the next plot.
function _lowestAnchor(plots) {
  return plots.reduce((best, p) => (!best || FARM_ROOM_KEYS.indexOf(p.roomKey) < FARM_ROOM_KEYS.indexOf(best.roomKey) ? p : best), null);
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType, payload = {}) {
    if (signalType !== TAG) return;
    const bot = global.bot;

    const botId = process.env.BOT_ID || 'default';
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    if (!magnet || !magnet.what) return _release('no active magnet');

    // Senses the whole cluster once up front — decides whether to prep and whether there is anything
    // to do. Unguarded: scanCluster absorbs every environmental failure a plot scan can have, per
    // plot, and keeps going, so a throw that escapes it is a defect and must surface; a catch here
    // could only convert that defect into a quiet release that leaves the fleet looking healthy
    // (Law 13: default stopped; Law 16: catch is never the expected pathway).
    const cluster = await farmingIntegrity.scanCluster(bot);

    // job_board's assessors/farming already verifies cluster.located, cluster.any_actionable, and
    // cluster.materials_ready before posting farm_tend, so this manager does not re-ask the same
    // question. cluster is still read here because the loop below needs the plots.

    // ── PREP ONCE for the whole visit ── Pulls a hoe and seeds for every plantable plot before the
    // loop, so the bot never walks home to resupply mid-cluster. Harvest-only visits skip prep
    // (harvest consumes nothing). A prep abandon (no hoe obtainable) already routed to
    // recursive_judge (Law 15); this stops here, keeping that as the one signal for the visit (Law 4).
    // `bonemeal` plots join the same prep call — one resupply per visit — since a growing plot needs
    // its bone meal in the pocket the same way a plant plot needs its seeds there (farm_executor
    // applies from the hand, not a chest); bonemealReachable spends at most one unit per crop it
    // advances.
    //
    // The prep question is asked again against each iteration's re-sense (prepIfNeeded below), not
    // only the entry scan, since harvesting is what creates the untilled, unsown cells the next
    // iteration finds (farming_integrity orders `plant` ahead of `harvest` for that reason). The
    // latch below keeps it to one resupply per visit regardless of which iteration triggers it, set
    // before the await so an abandoning prep is not attempted twice inside one visit.
    let prepped = false;
    const prepIfNeeded = async (scan) => {
      if (prepped) return true;
      const plantablePlots = scan.actionable_plots.filter(p => p.phase === 'build' || p.phase === 'plant');
      const bonemealPlots  = scan.actionable_plots.filter(p => p.phase === 'bonemeal');
      if (plantablePlots.length === 0 && bonemealPlots.length === 0) return true;
      prepped = true;
      // Seeds are counted, not plots: a tine row sows two, and the rows further out that this visit opens as it
      // builds need theirs in the pocket before it walks out (scanCluster.seeds_for_visit).
      return landPrep.prepare(bot, { seeds: scan.seeds_for_visit, boneMeal: bonemealPlots.length });
    };
    if (!await prepIfNeeded(cluster)) return;   // land_prep abandoned to the judge — one signal already lives

    // ── THE CLUSTER TEND LOOP ── Re-senses the cluster each iteration (Invariant B), picks the
    // lowest-anchor unserviced actionable plot, services it once, and marks it serviced. The
    // `serviced` set bounds each plot to exactly one tendPlot per visit: a plot that partially
    // progressed stays 'actionable' in the re-scan and would be re-picked forever without the set,
    // and re-posts on the next cycle with it. A plot that failed outright is likewise marked
    // serviced, so one bad plot does not cost the rest of the cluster its trip.
    const serviced = new Set();
    let workedTotal = 0, refusedTotal = 0, visited = 0;
    while (true) {
      await combatCheckpoint(bot, 'farm_plot');   // combat preempts at each plot boundary (same guard the per-cell loop uses)

      // Unguarded for the same reason as the entry scan: scanCluster absorbs every per-plot
      // environmental failure itself, so an escaping throw is a defect and must surface (Law 13,
      // Law 16).
      const scan = await farmingIntegrity.scanCluster(bot);
      const remaining = scan.actionable_plots.filter(p => !serviced.has(p.roomKey));
      if (remaining.length === 0) break;

      const plot = _lowestAnchor(remaining);

      // The work the re-sense just found may be work the entry scan could not see — so the prep question is
      // asked again HERE, against this scan, and answered at most once per visit by the latch above.
      if (!await prepIfNeeded(scan)) return;   // land_prep abandoned to the judge — one signal already lives

      serviced.add(plot.roomKey);
      visited++;

      // tendPlot is a Law-15 API: environmental per-plot failure returns worked=0 with a reason
      // (skipped); a coding violation throws (Law 13) and surfaces, uncaught here. Geometry is read
      // from this plot's own chair via blueprint_survey.geometryOf, the one authority for what was
      // locked (Law 16, Law 25).
      const res = await farmExecutor.tendPlot(bot, plot.roomKey, blueprintSurvey.geometryOf(plot.roomKey));
      workedTotal += res.worked || 0;
      refusedTotal += res.refused || 0;
    }

    // ── VISIT VERDICT ── Worked something → real progress, success. Serviced plots but worked
    // nothing while the world refused every action → the cluster is stuck (sited into terrain it
    // cannot work); reports success:false so recursive_judge counts a real fault instead of reading
    // fabricated no-ops as a healthy loop. Nothing serviceable after prep → benign release.
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
