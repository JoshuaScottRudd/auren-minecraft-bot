// fragment: canopy_clear_executor (action / site tree clearing)
// purpose: fells the wild trees standing on a structure's site before it is built (site_clear_trees,
//          assessors/shared.siteTreesJob), nearest the site's centre first. One verb: fell one wild tree
//          inside a site's box (Law 0).
//
// A dedicated executor, not harvest_executor: harvest fells to satisfy a log deficiency through its
// inside-to-outside supply ladder; this fells to clear a site regardless of log need. Same felling
// primitive (tree_feller.fell — Law 16), different trigger and scope.
//
// magnet.where carries the center because a transpose_origin is immutable once set_buildspot locks it, so
// the value copied onto the magnet at post time is still correct at run time. The board only posts this
// while a tree still stands in the box, so the executor stops being dispatched once the site is clear.
//
// One tree per dispatch: tree_feller.fell clears one whole connected tree, then routes to recursive_judge
// so the board re-plans and re-posts for the next tree while one stands. A futile pass (nothing in range
// reachable) concedes to idle_park instead of re-dispatching an identical zero-progress fell, so the job
// never churns the judge into a stuck-loop halt (Law 13).

'use strict';

const watcher = require('@kernel/watcher');
const treeFeller = require('@api/tree_feller');
const locomotion = require('@locomotion/locomotion_dispatcher');
const portableJudge = require('@kernel/portable_judge');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');

const TAG = 'canopy_clear_executor';

// Concede to idle instead of soft-failing to the judge (mirror harvest_executor.routeIdle). Used when a
// clear pass is futile from here (no reachable tree in range) — an identical zero-progress fell repeated
// would trip the judge's stuck-loop kill. Clearing the magnet drops the bot off the job; idle_park moves
// it clear and arms the heartbeat, and the next sweep re-posts if a tree still stands in range.
//
// Still judged: routing around recursive_judge means carrying a judge along, never doing without one
// (Law 11 — no loop without exactly one judge). Forgiving, because a fresh plan cycle is the right first
// answer to "futile from here"; the retry counter escalates to a strict kill if replanning keeps landing
// back on it. Returns without routing after an escalation — portable_judge has already routed, and a
// second signal in one scope is a Law 4 violation.
async function _routeIdle(reason) {
  const verdict = await portableJudge.checkpoint(TAG, `idle: ${reason}`, 'forgiving');
  if (verdict === false) return;
  watcher.summary(TAG, reason);
  require('@thinking/dispatcher.js').clearMagnet();
  routeSignal(TAG, 'idle_park', { readable: `${TAG}: ${reason} → idle_park` });
}

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before canopy clear ran.`);
    }

    const hq = require('@kernel/corporate_headquarters');
    const botId = process.env.BOT_ID || 'default';
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    const where = magnet?.where;
    // The box is the site's: its footprint plus the margin a leaf can overhang it by, travelling on the job.
    const box = magnet?.box || null;
    if (!box) {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): a site clear names its box (assessors/shared.siteTreesJob); this magnet carries none.`);
    }
    // How far out the region actually reaches, for the "am I standing in it" test below.
    const reach = Math.max(Math.abs(box.min_dx), box.max_dx, Math.abs(box.min_dz), box.max_dz);
    if (!where || typeof where.x !== 'number') {
      // The blueprint center didn't ride the magnet (base unlocked between post and dispatch) —
      // environmental/timing, not a bug. Concede to idle; the next sweep re-plans from live state.
      return _routeIdle('no blueprint center on magnet — nothing to clear');
    }

    // Fells one wild tree inside the site's box, worked closest-to-center first. The zone is the same box
    // the board counts trees in, so the two agree on what "in range" means.
    //
    // No preferWood here: this verb's goal is an empty site, so species is meaningless to it.
    // Supply-side felling wants one species (harvest_executor's log ladder passes the flag); clearing
    // wants the nearest trunk.
    const center = { x: where.x, z: where.z };

    // ── WALK TO THE SITE BEFORE SCANNING IT ──────────────────────────────────
    // The board's gate scans from the site centre and counts trees inside the site square.
    // tree_feller.fell scans through surface_filter, which centres on the body, and the canopyZone then
    // discards everything outside the site square. Walking into the square first makes the body's own
    // scan neighbourhood overlap the zone, so the two questions have the same answer.
    const feet = bot.entity.position.floored();
    const away = Math.max(Math.abs(feet.x - center.x), Math.abs(feet.z - center.z));
    if (away > reach) {
      // A centre inside closed ground (the waste pit's own box) is refused before any route is searched; the walk
      // aims at the first open cell on the line from the centre back toward the body.
      const { closedBy } = require('@locomotion/navigator');
      const goal = { x: where.x, y: where.y, z: where.z };
      for (let k = 1; k <= away && closedBy(goal); k++) {
        goal.x = Math.round(where.x + (feet.x - where.x) * k / away);
        goal.z = Math.round(where.z + (feet.z - where.z) * k / away);
      }
      const trip = await locomotion.goTo({ ...goal, leg: 'work' });
      if (!trip?.arrived) {
        return _routeIdle(`could not reach the site to clear it (${away} blocks out, reach ${reach}) — replanning`);
      }
    }

    // A SITE'S TREES ARE THE ONES ITS CENSUS COUNTED. The board holds a site's phase open on
    // shared.standingSiteTrees, which reads every log in the box at any height; the feller's own scan reads
    // the surface only. So a site job fells a trunk off that same census, nearest the centre first, and a
    // log the census counts is a log this job goes to (Law 16). A trunk inside a column a peer holds is
    // theirs, at any height — the footprint the foreman grants the claim by.
    const { standingSiteTrees, freeSiteTrees } = require('@thinking/assessors/shared');
    const free = freeSiteTrees(await standingSiteTrees(bot, where, box) || []);
    const d = (p) => Math.max(Math.abs(p.x - center.x), Math.abs(p.z - center.z));
    const target = free.sort((a, b) => d(a) - d(b))[0] || null;
    const result = await treeFeller.fell(bot, target, {
      canopyZone: { mode: 'inside', center, box },
      preferNear: { x: where.x, y: where.y, z: where.z },
    });

    if (result && result.success) {
      const at = result.position ? ` @${result.position.x},${result.position.y},${result.position.z}` : '';
      const readable = `${TAG}: cleared ${result.species}${at}, mined ${result.minedCount}`;
      portableJudge.done(TAG);   // a felled tree is progress — the concession ledger starts over
      watcher.summary(TAG, readable);
      const capsule = payload[TAG] || (payload[TAG] = {});
      capsule.success = true;
      capsule.readable = readable;
      payload.readable = readable;
      return routeToJudge(TAG, { ...payload, readable });
    }

    // No clearable tree in range → concede (the gate stops posting once the site is truly clear; a
    // transient can't-reach must not churn the judge on the lowest-priority job).
    return _routeIdle(`no clearable tree in range (${result?.reason || 'unknown'}) gate_log=${magnet?.gate_log || 'none'}`);
  }),
};
