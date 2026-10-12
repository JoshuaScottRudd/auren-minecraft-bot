// fragment: canopy_clear_executor (action / base-canopy clearing)
// purpose: The engine of the proactive tree-clear pathway — fells wild trees standing within
//          TREE_CLEAR_RADIUS of an opted-in surface blueprint's transpose_origin, ordered closest to that
//          center, so the camera framing around the base/farm stays clear. One verb: fell one wild tree
//          inside a blueprint's clear radius (Law 0).
//
// A dedicated executor, not harvest_executor: harvest fells to satisfy a log deficiency through its
// inside-to-outside supply ladder; this fells to keep a radius clear for film regardless of log need, at
// the lowest priority. Same felling primitive (tree_feller.fell — Law 16), different trigger and scope.
//
// magnet.where carries the center because a transpose_origin is immutable once set_buildspot locks it, so
// the value copied onto the magnet at post time is still correct at run time. job_board's gate (a log
// within radius of the center) only posts this while a tree still stands in range, so the executor stops
// being dispatched once the ring is clear.
//
// One tree per dispatch: tree_feller.fell clears one whole connected tree, then routes to recursive_judge
// so the board re-plans and re-posts clear_canopy for the next tree while the gate still finds one. A
// futile pass (nothing in range reachable) concedes to idle_park instead of re-dispatching an identical
// zero-progress fell, so the lowest-priority film job never churns the judge into a stuck-loop halt (Law 13).

'use strict';

const watcher = require('@kernel/watcher');
const treeFeller = require('@api/tree_feller');
const locomotion = require('@locomotion/locomotion_dispatcher');
const portableJudge = require('@kernel/portable_judge');
const { TREE_CLEAR_RADIUS } = require('@thinking/architect_config');
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
    // The ring is the asker's, not the fleet's: the camera wants a clear ring around a base, and a
    // downloaded building wants its own footprint plus the margin a leaf can overhang it by. The radius
    // travels on the job; TREE_CLEAR_RADIUS is the default for the asker that names none — the camera,
    // whose ring IS that constant (Law 16: one verb over a number).
    const box = magnet?.box || null;
    const radius = Number.isFinite(magnet?.radius) ? magnet.radius : TREE_CLEAR_RADIUS;
    // How far out the region actually reaches, for the "am I standing in it" test below. A box states it
    // per side; a ring states it once.
    const reach = box
      ? Math.max(Math.abs(box.min_dx), box.max_dx, Math.abs(box.min_dz), box.max_dz)
      : radius;
    if (!where || typeof where.x !== 'number') {
      // The blueprint center didn't ride the magnet (base unlocked between post and dispatch) —
      // environmental/timing, not a bug. Concede to idle; the next sweep re-plans from live state.
      return _routeIdle('no blueprint center on magnet — nothing to clear');
    }

    // Fells one wild tree inside the blueprint's clear ring, worked closest-to-center first. The zone
    // uses the same square (Chebyshev radius) job_board's gate counts trees in, so the two agree on
    // what "in range" means.
    //
    // No preferWood here: this verb's goal is an empty ring, so species is meaningless to it.
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
      const trip = await locomotion.goTo({ x: where.x, y: where.y, z: where.z, leg: 'work' });
      if (!trip?.arrived) {
        return _routeIdle(`could not reach the site to clear it (${away} blocks out, reach ${reach}) — replanning`);
      }
    }

    // A SITE'S TREES ARE THE ONES ITS CENSUS COUNTED. The board holds a site's phase open on
    // shared.standingSiteTrees, which reads every log in the box at any height; the feller's own scan reads
    // the surface only. So a site job fells a trunk off that same census, nearest the centre first, and a
    // log the census counts is a log this job goes to (Law 16). A ring with no box keeps the feller's scan.
    let target = null;
    if (box) {
      const { standingSiteTrees, freeSiteTrees, inBox } = require('@thinking/assessors/shared');
      // A job's hole is ground inside its box that belongs to something else (a building's grounds
      // exclude its own footprint, whose logs may be the building). A trunk inside a column a peer
      // holds is theirs, at any height — the footprint the foreman grants the claim by.
      const hole = magnet?.hole || null;
      const free = freeSiteTrees(await standingSiteTrees(bot, where, box) || [])
        .filter(p => !(hole && inBox(hole, where, p)));
      const d = (p) => Math.max(Math.abs(p.x - center.x), Math.abs(p.z - center.z));
      target = free.sort((a, b) => d(a) - d(b))[0] || null;
      // With a hole in the box the feller's own scan could land inside it, so no census trunk is no fell.
      if (!target && hole) return _routeIdle('every trunk in the grounds is felled or held by a peer');
    }
    const result = await treeFeller.fell(bot, target, {
      canopyZone: { mode: 'inside', center, box, radius },
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

    // No clearable tree in range → concede (the gate stops posting once the ring is truly clear; a
    // transient can't-reach must not churn the judge on the lowest-priority job).
    return _routeIdle(`no clearable tree in range (${result?.reason || 'unknown'})`);
  }),
};
