// fragment: sapling_plant_executor — take the banked farm saplings out to the tree farm and plant them.
//
// THE PLANTING JOB. Every body banks the farm saplings it did not plant where it felled (sapling_planter: one per
// felling, the rest carried home). While the home band is below its saturation with a cell open,
// assessors/tree_farm posts one shared `sapling_plant` chest job and `receive` below runs it: withdraw up to the row's
// `batch` of them (sapling_planter.plantingTrip), walk to the farm, plant them (sapling_planter.plantFarm), and bank
// whatever was not planted. One trip per batch.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');
const TAG = 'sapling_plant_executor';

function _route(success, reason, extra = {}) {
  routeToJudge(TAG, { readable: `${TAG}: ${reason}`, [TAG]: { success, ...extra } });
}

// retrieveItems routes its own abandon (undefined) and dropOffHaul flags one (`abandoned`); either way this returns
// without routing again (Law 4).
async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  const planter = require('@api/sapling_planter');
  const { retrieveItems, dropOffHaul } = require('@api/inventory_swapper');
  const inventoryLens = require('@kernel/inventory_lens');

  const farm = planter.zone();
  if (!farm || !farm.cells.length) { _route(false, 'the tree farm is not sited'); return; }
  const banked = Object.fromEntries(planter.farmSaplings().map(n => [n, inventoryLens.inChests(n)]));
  const trip = planter.plantingTrip(banked);
  if (!trip.length) { _route(false, 'no farm sapling is banked — a peer took the batch first'); return; }
  for (const { name, count } of trip) {
    const got = await retrieveItems(bot, name, count);
    if (got === undefined) return;
  }

  // Into the home band first: a cell's ground is read round where the body stands (sapling_planter.groundOf), so the
  // body walks to the band's open cell nearest home.
  const stand = planter.farmStand(bot, farm);
  const walk = stand ? await require('@locomotion/locomotion_dispatcher').goTo({ ...stand, leg: 'work' }) : null;
  const r = walk && walk.arrived ? await planter.plantFarm(bot)
    : { planted: 0, reason: stand ? 'could_not_reach_the_farm' : 'band_saturated_or_no_open_cell' };

  const drop = await dropOffHaul(bot);
  if (drop?.abandoned) return;
  watcher.summary(TAG, `planted ${r.planted} of ${trip.reduce((n, t) => n + t.count, 0)} taken, ${r.reason || 'all planted'}`);
  _route(r.planted > 0, r.planted > 0 ? `planted ${r.planted} farm sapling(s)` : `planted nothing — ${r.reason}`, { planted: r.planted });
}

module.exports = {
  receive: watcher.track(TAG, receive),
};
