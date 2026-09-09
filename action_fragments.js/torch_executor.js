// fragment: torch_executor (action / base-lighting)
// purpose: The engine of the lighting pathway (combat refurbish §1b) — the deliberate counterpart to
//          the ambient auto-torch reflex. Where the reflex lights the ONE cell a walking bot steps
//          toward, this executor is dispatched to walk the dark surface cells torch_integrity found in
//          the headframe safe square and place a torch at each, closing the coverage gap the roaming
//          reflex leaves in unstepped corners. One verb: light dark cells (Law 0).
//
// WHY re-scan instead of trusting the job: the dispatcher magnet copies a fixed field set, so the
// dark-cell LIST never rode the job here (job_board deliberately passed only `where`). Good — a list
// carried from post-time would be stale (Invariant B): peers and the reflex light cells between sweeps.
// The executor re-senses the dark cells live at run time, exactly as farm_executor re-derives its
// till/plant/harvest work from the field's current state.
//
// WHY stand adjacent, never on the cell: a torch occupies the air cell (standPos) attached to the top
// face of the floor below it. Standing IN standPos to place it means placing into the bot's own AABB
// (placeBlock times out — the trap farm_executor documents). So for each dark cell we path to a
// walkable NEIGHBOR and reach over, the identical geometry the reflex uses (stand on A, place on the
// floor of adjacent B).
//
// WHY suppress the reflex here: the ambient auto-torch reflex fires on forward-walk and competes for
// the main hand. During a deliberate lighting pass the executor owns the hand; it disables the reflex
// on entry and restores it through withCleanup (mirror of battle_stations suppressing it during combat),
// so two torch-placers never race the hand. The restore runs on every exit, abandon and throw included.
//
// invariants:
//  - Self-contained (Law 2): every cell re-senses floor/air/light fresh before placing; no cell assumes
//    a sibling's outcome. A cell lit by a peer between scan and reach is re-read as lit and skipped.
//  - No torches mid-loop is environmental (the torch stock ran dry — supply re-crafts): warn, stop the
//    loop, report best-effort, never throw (Law 13). One unreachable cell is skipped, not fatal.
//  - Terminates at recursive_judge with a readable that stays identical only when NOTHING changes pass
//    to pass — so a base that cannot be lit (every cell unreachable) trips the judge's stuck-loop kill.

'use strict';

const Vec3 = require('vec3');
const { performPlace } = require('@utils/movement/place_authority');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
// Entered through combatCheckpoint, never battleStations directly (Architect 2026-08-08: "remove it
// from the callers"). One process-wide 500 ms clock, shared with the dig and drive primitives that now
// carry the same gate, plus the engaging/escaping bypass so combat's own arms cannot re-enter it. The
// whole reasoning is in its header; a call a primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { isWalkableSurface, getClearance } = require('@utils/movement/terrain_predicates');
const survival = require('@locomotion/survival_instincts');
const torchIntegrity = require('@perception/torch_integrity');
const { TORCH_LIGHT_FLOOR } = require('@thinking/architect_config');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');

const TAG = 'torch_executor';
const STEP_WAIT_MS = 200;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);   // true air, not water/lava (both boundingBox 'empty')
const isOpenAir = b => !!b && b.boundingBox === 'empty' && AIR_NAMES.has(b.name);

// findStand: a walkable cardinal neighbor of standPos to place from — true-air body cell, air headroom,
// solid walkable floor under it. Returns the stand coordinate or null (cell boxed in / no footing).
function findStand(bot, standPos) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = new Vec3(standPos.x + dx, standPos.y, standPos.z + dz);
    if (!isOpenAir(bot.blockAt(n))) continue;              // no standing in water (A2) or a solid
    if (!isOpenAir(bot.blockAt(n.offset(0, 1, 0)))) continue;
    const floor = bot.blockAt(n.offset(0, -1, 0));
    if (!floor || floor.boundingBox !== 'block' || !isWalkableSurface(floor)) continue;
    return n;
  }
  return null;
}

// stillDark: re-sense the cell right before placing (Invariant B). Torch belongs only where the floor
// is still a solid cube, the air cell is still true air, and the block light is still at/under the floor.
function stillDark(bot, standPos, floorPos) {
  const floor = bot.blockAt(floorPos);
  if (!floor || floor.boundingBox !== 'block' || !isWalkableSurface(floor)) return null;
  if (!isOpenAir(bot.blockAt(standPos))) return null;      // occupied (a torch a peer placed) or a liquid
  if (!getClearance(bot, floor, 2)) return null;
  const light = guardExternalSync(TAG, `getBlockLight at (${standPos.x},${standPos.y},${standPos.z})`, () => bot.world.getBlockLight(standPos));
  if (!light.ok) return null;
  if (typeof light.value !== 'number' || light.value > TORCH_LIGHT_FLOOR) return null;
  return floor;
}

function routeJudge(payload, success, result, readable, metrics) {
  const signalBus = require('@kernel/signal_bus');
  const capsule = payload[TAG] || (payload[TAG] = {});
  capsule.success = success;
  capsule.result = result;
  capsule.metrics = metrics || {};
  capsule.readable = readable;
  capsule.recursion_alert = true;
  payload.readable = readable;
  routeToJudge(signalBus, TAG, { ...payload, readable });
}

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the torch executor ran.`);
    }

    // Re-scan for the freshest dark set (Invariant B). scan() reads the base center itself.
    const scan = torchIntegrity.scan(bot);
    if (!scan.located) {
      // The base unlocked between job-post and dispatch — a world/timing condition, not a bug. Abandon
      // to the judge (environmental); the next sweep re-plans from whatever state the base is in now.
      const readable = `${TAG}: fail base center gone`;
      watcher.warn(TAG, readable);
      routeJudge(payload, false, 'base_unlocated', readable, {});
      return;
    }
    const cells = scan.dark_cells || [];
    if (cells.length === 0) {
      // Nothing dark left (a peer/the reflex lit it since the sweep) — the base is safe. Success.
      const readable = `${TAG}: base already lit`;
      watcher.summary(TAG, readable);
      routeJudge(payload, true, 'already_lit', readable, { lit: 0 });
      return;
    }

    // Own the hand for the pass — suppress the ambient reflex so two torch-placers never race it.
    survival.disableReflex('autoTorch');
    let lit = 0, skipped = 0, missingTorch = false;
    // withCleanup, not a guard: nothing is caught. The reflex must come back on every exit or the bot
    // walks away permanently unable to light itself (Law 17 risk window closed).
    await withCleanup(TAG, 'torch pass reflex hold', async () => {
      for (const c of cells) {
        await combatCheckpoint(bot, 'torch');                       // combat preempts each cell (same as farm)
        const standPos = new Vec3(c.x, c.y, c.z);         // the dark air cell the torch will fill
        const floorPos = standPos.offset(0, -1, 0);       // the solid block the torch attaches atop

        const stand = findStand(bot, standPos);
        if (!stand) { skipped++; watcher.warn(TAG, `light skip (${c.x},${c.y},${c.z}) — no adjacent footing`); continue; }

        const nav = await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, exact: true });
        if (!nav || nav.arrived === false) { skipped++; watcher.warn(TAG, `light skip (${c.x},${c.y},${c.z}) — stand unreachable`); continue; }

        const floorBlock = stillDark(bot, standPos, floorPos);
        if (!floorBlock) { skipped++; continue; }         // lit / occupied / changed since scan

        // Out of torches is a DIFFERENT exit from a refused place — it ends the whole pass rather than
        // skipping one cell — so it is still asked here, before the one place route is entered.
        if (!bot.inventory.items().some(i => i.name === 'torch')) {
          missingTorch = true; watcher.warn(TAG, 'lighting stopped — out of torches mid-pass'); break;
        }
        // The one place route (Law 16) owns equip, the spawn-protection gate, the combat checkpoint, the
        // aim and the click. A cell refused for spawn protection is counted a SKIP rather than a failure:
        // it is not a fault to repair, it is ground this fleet may not light, and calling it a failed
        // place would send a reader hunting a bug.
        const torchPlace = await performPlace(bot, standPos, floorBlock, new Vec3(0, 1, 0), 'torch', TAG);
        if (!torchPlace.ok && torchPlace.reason === 'spawn_protected') { skipped++; continue; }
        // The result's ok flag is not this tally's verdict: a torch that placed and was then reverted and
        // one that never placed are the same event to this counter, and only the world tells them apart
        // (Invariant B).
        const after = bot.blockAt(standPos);
        if (after && after.name === 'torch') lit++;
        else { skipped++; watcher.warn(TAG, `light place at (${c.x},${c.y},${c.z}) did not stick`); }
      }
    }, () => { survival.enableReflex('autoTorch'); });

    // Best-effort success (Law 13 environmental): a pass lights what it can reach with the torches on
    // hand; job_board re-posts light_base next sweep while dark cells remain, and supply re-crafts
    // torches if the stock ran dry. The readable changes whenever progress is made, so recursive_judge
    // only trips its stuck-loop kill when a pass changes nothing (e.g. every remaining cell unreachable).
    const readable = `${TAG}: lit=${lit} skipped=${skipped}${missingTorch ? ' [out of torches]' : ''}`;
    watcher.summary(TAG, readable);
    routeJudge(payload, true, 'light_pass', readable, { lit, skipped });
  }),
};
