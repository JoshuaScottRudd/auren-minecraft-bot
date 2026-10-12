'use strict';
// stop_flow — the counterpart of the prevent-flow rule (pathfinding_utils.opensOntoWater). That rule keeps
// a dig from starting a flow; this one ends a flow already running onto a body.
//
// A body standing on a floor with running water in its own cell cannot dig beside it, so a pit the water
// runs into has no way out. Running water is fed from beside or above. stopFlow PLACES a block into the
// water cells touching the body's two cells, upper cells first — the cell over the head and the head row
// — and waits for the body's own cell to stop running. Only when that was not enough does it plug the
// feet row. It opens nothing and places no more than the flow needs.
//
// Returns { stopped, placed, reason }. A body in a water SOURCE, or with no floor under it, is swimming
// and is answered 'not_standing_in_flow'.
const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { performPlace } = require('@utils/movement/place_authority');
const { isFluid, isWaterSource } = require('@utils/gravity_utils');
const { sleep } = require('@utils/fragment_utils');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');

const TAG = 'stop_flow';
const UPPER = [[0, 2, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]];
const FEET_ROW = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const DRAIN_MS = 8000;
const DRAIN_POLL_MS = 250;

// Running water in the body's own cell, with a floor under it.
function standingInFlow(bot) {
  const feet = bot.entity.position.floored();
  const here = bot.blockAt(feet);
  const floor = bot.blockAt(feet.offset(0, -1, 0));
  return !!(here && isFluid(here.name) && !isWaterSource(bot, feet.x, feet.y, feet.z)
    && floor && floor.boundingBox === 'block');
}

async function plug(bot, feet, cells, placed, refused) {
  for (const [dx, dy, dz] of cells) {
    const pos = feet.offset(dx, dy, dz);
    const b = bot.blockAt(pos);
    if (!b || !isFluid(b.name)) continue;
    const items = bot.inventory.items();
    const item = BRIDGE_PREFS.map(name => items.find(i => i.name === name && i.count > 0)).find(Boolean) || null;
    if (!item) { refused.push(`(${pos.x},${pos.y},${pos.z}) no block to plug it with`); return; }
    let anchor = null, face = null;
    for (const [fx, fy, fz] of FACES) {
      const a = bot.blockAt(pos.offset(fx, fy, fz));
      if (a && a.boundingBox === 'block') { anchor = a; face = new Vec3(-fx, -fy, -fz); break; }
    }
    const res = await performPlace(bot, pos, anchor, face, item.name, TAG, { sneak: true });
    const after = bot.blockAt(pos);
    if (res.ok && after && after.boundingBox === 'block') placed.push(`(${pos.x},${pos.y},${pos.z}) ${item.name}`);
    else refused.push(`(${pos.x},${pos.y},${pos.z}) ${res.reason}`);
  }
}

async function drained(bot) {
  const deadline = Date.now() + DRAIN_MS;
  while (Date.now() < deadline) {
    if (!standingInFlow(bot)) return true;
    await sleep(DRAIN_POLL_MS);
  }
  return false;
}

async function stopFlow(bot) {
  if (!standingInFlow(bot)) return { stopped: false, placed: [], reason: 'not_standing_in_flow' };
  const feet = bot.entity.position.floored();
  const placed = [], refused = [];
  await plug(bot, feet, UPPER, placed, refused);
  let stopped = placed.length > 0 && await drained(bot);
  if (!stopped) {
    const before = placed.length;
    await plug(bot, feet, FEET_ROW, placed, refused);
    stopped = placed.length > before && await drained(bot);
  }
  watcher.warn(TAG,
    `STOP_FLOW at (${feet.x},${feet.y},${feet.z}) — plugged ${placed.length}: ${placed.join(', ') || 'none'}; `
    + `not plugged ${refused.length}: ${refused.join(', ') || 'none'}; own cell ${stopped ? 'no longer running' : 'still running'}.`);
  return { stopped, placed, reason: stopped ? null : (placed.length ? 'still_running' : 'nothing_plugged') };
}

module.exports = { stopFlow, standingInFlow };
