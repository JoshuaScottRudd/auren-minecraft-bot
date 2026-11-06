'use strict';
// canopy_descent — A BODY STANDING ON LEAVES COMES DOWN TO SOLID GROUND.
//
// A leaf is never a floor (terrain_predicates.isWalkableSurface), so a route search started from a body
// that stands on one has no first node and every walk fails where it stands. The body takes the one way
// down there is: it breaks the loose leaves under its feet and falls, again until it stands on a block
// that is not a leaf, taking whatever fall damage the drop costs. A leaf the fleet declared in a blueprint
// is not loose (leaf_authority.isPhantom) and is never broken here.
//
// dig_authority admits the last-support dig by this module's tag alone (CANOPY_DESCENT_TAG).
//
// Returns from descend(): { onCanopy, drops, fell, hp_before, hp_after, reason }.

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { performDig, CANOPY_DESCENT_TAG } = require('@utils/movement/dig_authority');
const { isPhantom } = require('@utils/movement/leaf_authority');
const { sleep } = require('@utils/fragment_utils');

const MAX_DROPS = 24;       // leaf layers one descent may break before it gives up and says so
const LAND_MS = 3000;       // how long a fall is given to land
const LAND_POLL_MS = 50;

// The loose leaves under the body's hitbox: every floor cell its four corners rest over.
function leavesUnderfoot(bot) {
  const { BODY_HALF_WIDTH } = require('@utils/calculators/jump_calculator');
  const p = bot.entity.position;
  // The row the feet rest on: a leaf is a full block, so its top is the body's y.
  const y = Math.floor(p.y - 0.01);
  const cells = new Map();
  for (const dx of [-BODY_HALF_WIDTH, BODY_HALF_WIDTH]) {
    for (const dz of [-BODY_HALF_WIDTH, BODY_HALF_WIDTH]) {
      const c = new Vec3(Math.floor(p.x + dx), y, Math.floor(p.z + dz));
      cells.set(`${c.x},${c.y},${c.z}`, c);
    }
  }
  return [...cells.values()].map(c => bot.blockAt(c)).filter(b => b && isPhantom(bot, b));
}

// onCanopy(bot) → true when the body stands on the ground and a loose leaf is under its feet.
function onCanopy(bot) {
  return !!(bot?.entity?.onGround && leavesUnderfoot(bot).length);
}

async function landed(bot, fromY) {
  const until = Date.now() + LAND_MS;
  while (Date.now() < until) {
    await sleep(LAND_POLL_MS);
    if (bot.entity.onGround && bot.entity.position.y < fromY - 0.5) return true;
  }
  return false;
}

async function descend(bot) {
  if (!onCanopy(bot)) return { onCanopy: false, drops: 0, fell: 0 };
  const startY = bot.entity.position.y;
  const hpBefore = bot.health;
  let drops = 0;
  let reason = 'on_solid_ground';
  while (onCanopy(bot)) {
    if (drops >= MAX_DROPS) { reason = 'drop_limit'; break; }
    const y = bot.entity.position.y;
    for (const leaf of leavesUnderfoot(bot)) {
      if (!(await performDig(bot, leaf.position, leaf, CANOPY_DESCENT_TAG))) { reason = `dig_refused_at_${leaf.position.x},${leaf.position.y},${leaf.position.z}`; break; }
    }
    if (reason.startsWith('dig_refused')) break;
    drops++;
    if (!(await landed(bot, y))) { reason = 'did_not_land'; break; }
  }
  const p = bot.entity.position;
  const fell = Math.round((startY - p.y) * 10) / 10;
  watcher.warn('canopy_descent', `CANOPY_DESCENT drops=${drops} fell=${fell} hp=${hpBefore}->${bot.health} at=(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}) `
    + `floor=${bot.blockAt(p.floored().offset(0, -1, 0))?.name || 'unseen'} ended=${reason}`);
  return { onCanopy: true, drops, fell, hp_before: hpBefore, hp_after: bot.health, reason };
}

module.exports = { descend, onCanopy };
