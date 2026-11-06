// fragment: home_stations_executor (action / the authored home's fixtures)
// purpose: ONE PASS OF REGISTERING THE HOME'S FIXTURES: walk to one anchor's stand, open every unregistered fixture that
//          anchor owns, and write each to the station registry. The anchor is the fixture's authored stand, as on every
//          other blueprint (locomotion.goToStationStance), and every fixture in its group is within reach of it.
//
// `unregistered()` is the one reading of what is left; the assessor posts on it and this pass works from it.

'use strict';

const watcher = require('@kernel/watcher');
const stationRegistry = require('@perception/station_registry');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'home_stations_executor';

function _route(success, reason, extra = {}) {
  routeToJudge(TAG, { readable: `${TAG}: ${reason}`, [TAG]: { success, ...extra } });
}

// unregistered → [{ pos:{x,y,z}, type, anchor_index, roomKey }] for each window-bearing fixture of the standing home with no
// station row, or [] while no home stands open.
function unregistered() {
  const plans = require('@kernel/downloaded_plan_registry');
  if (!plans.isLoaded() || !plans.standing()) return [];
  const name = plans.getPlan().name;
  const building = require('@kernel/blueprint_registry').tryGetBuilding(name);
  if (!building?.design_intent?.workstations) return [];
  const site = require('@kernel/corporate_headquarters').readBuildingChair(name, 'set_buildspot');
  if (!site?.transpose_origin) return [];
  const stations = stationRegistry.getStations();
  const { HOME_FIXTURES } = require('@thinking/architect_config');
  return require('@perception/blueprint_survey').transposeVoxelsForCandidate(building, site.transpose_origin)
    .filter(v => HOME_FIXTURES.includes(v.type) && !stations[stationRegistry.stationKey(v)])
    .map(v => ({ pos: { x: v.x, y: v.y, z: v.z }, type: v.type, anchor_index: v.anchor_index, roomKey: name }));
}

async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  const left = unregistered();
  if (!left.length) { _route(true, 'no fixture left to register', { registered: 0 }); return; }
  const group = left.filter(f => f.anchor_index === left[0].anchor_index);
  const nav = await require('@locomotion/locomotion_dispatcher').goToStationStance(group[0].pos);
  if (!nav.arrived) {
    _route(false, `could not reach the stand of anchor ${group[0].anchor_index}: ${nav.reason || 'no reason given'}`);
    return;
  }
  const Vec3 = require('vec3');
  let registered = 0;
  const failed = [];
  for (const f of group) {
    const block = bot.blockAt(new Vec3(f.pos.x, f.pos.y, f.pos.z));
    if (!block || block.name !== f.type) { failed.push(`${f.type}@${f.pos.x},${f.pos.y},${f.pos.z}:reads_${block?.name || 'unseen'}`); continue; }
    const diag = {};
    const win = await stationRegistry.openProofWindow(bot, block, diag);
    const result = stationRegistry.registerStation(f.pos, f.type, win, f.roomKey);
    if (win) await require('@utils/movement/dig_authority').ensureNoOpenWindow(bot, 'home station registered');
    if (result.ok) registered++;
    else failed.push(`${f.type}@${f.pos.x},${f.pos.y},${f.pos.z}:${result.reason}`);
  }
  watcher.summary(TAG, `HOME_STATIONS anchor=${group[0].anchor_index} registered=${registered} of=${group.length} left=${left.length - registered}${failed.length ? ` failed=${failed.slice(0, 6).join('|')}` : ''}`);
  _route(registered > 0, `anchor ${group[0].anchor_index}: ${registered} of ${group.length} registered`, { registered, failed: failed.length });
}

module.exports = {
  receive: watcher.track(TAG, receive),
  unregistered,
};
