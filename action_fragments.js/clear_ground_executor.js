// fragment: clear_ground_executor — dig the leaf debris and grass tufts in one tile of a building's
// grounds, then sweep up what dropped. One verb (Law 0): clear one tile.
//
// The tile rides the magnet as `box` (offsets from `where`, the building's transpose origin) with the
// footprint as `hole`. What counts as debris is assessors/grounds.debrisIn, the same reading the board
// posted the seat off (Law 16), asked again before every dig (Invariant B). A cell that will not clear is
// refused through grounds.refuseCell, so the board stops offering it. One dispatch clears at most
// CLEAR_PER_DISPATCH cells and hands back to the judge, so a big tile is shared out across sweeps.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const portableJudge = require('@kernel/portable_judge');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { performDig } = require('@utils/movement/dig_authority');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');

const TAG = 'clear_ground_executor';
const CLEAR_PER_DISPATCH = 32;
const REACH = 4.5;   // survival dig reach from the eyes, the feller's own

function _inReach(bot, p) {
  const e = bot.entity.position;
  const dx = (p.x + 0.5) - e.x, dy = (p.y + 0.5) - (e.y + 1.6), dz = (p.z + 0.5) - e.z;
  return dx * dx + dy * dy + dz * dz <= REACH * REACH;
}

// Concede to idle, judged (the canopy executor's shape): a tile with nothing clearable left is a fresh
// plan's question, and a repeat of the same empty pass escalates to a strict kill.
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
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before clear_ground ran.`);
    }
    const hq = require('@kernel/corporate_headquarters');
    const magnet = hq.readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
    const where = magnet?.where;
    const box = magnet?.box;
    if (!where || typeof where.x !== 'number' || !box) {
      throw new Error(`[${TAG}] CODING VIOLATION: dispatched with no where/box on the magnet.`);
    }
    const hole = magnet.hole || null;
    const grounds = require('@thinking/assessors/grounds');

    let cleared = 0, refused = 0;
    while (cleared + refused < CLEAR_PER_DISPATCH) {
      const cells = await grounds.debrisIn(bot, where, box, hole);
      if (!cells || !cells.length) break;
      const feet = bot.entity.position;
      const d2 = (p) => (p.x - feet.x) ** 2 + (p.y - feet.y) ** 2 + (p.z - feet.z) ** 2;
      const p = cells.sort((a, b) => d2(a) - d2(b))[0];
      const pos = new Vec3(p.x, p.y, p.z);
      // goTo owns its own abandonment (Law 15): an unreachable cell never resolves here, and the chain
      // restarts at the judge.
      if (!_inReach(bot, p)) await locomotion.goTo({ x: p.x, y: p.y, z: p.z, require_los: true, leg: 'work' });
      const ok = _inReach(bot, p) && await performDig(bot, pos, bot.blockAt(pos), TAG);
      if (ok) cleared++;
      else { refused++; grounds.refuseCell(p); }
    }

    if (cleared === 0) return _routeIdle(`nothing clearable left in this tile (${refused} cell(s) refused)`);

    const { picked } = await require('@action/ground_salvage_executor').sweepHere(bot);
    portableJudge.done(TAG);
    const readable = `${TAG}: cleared ${cleared} debris block(s) around (${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.z)}), `
      + `${refused} refused, swept ${picked} drop(s)`;
    watcher.summary(TAG, readable);
    const capsule = payload[TAG] || (payload[TAG] = {});
    capsule.success = true;
    capsule.readable = readable;
    // Offloading ends every producing verb (the salvage seat's own order); `abandoned` means the drop-off
    // already routed to the judge.
    const drop = await require('@api/inventory_swapper').dropOffHaul(bot);
    if (drop?.abandoned) return;
    return routeToJudge(TAG, { ...payload, readable });
  }),
};
