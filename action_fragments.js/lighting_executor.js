// fragment: lighting_executor (action / lighting) — a LIBRARY, called by lighting_manager once per torch.
// One verb (Law 0): stand one planned wall torch on its wall (the mine's design, lighting_integrity.mineLamps, and the
// basement's, lighting_integrity.basementLamps).
//
// placeTorch(bot, placement) → { placed, reason } (Law 15 API). Environmental refusals return placed:false
// with the world's reason, and the manager carries on with the next torch; a missing bot throws (Law 13).
// placeInReach(bot, placement) → the same, from where the body stands: a basement cell's digger, with no walk.
//
// placeTorch stands beside the spot, never in it. Re-senses every cell just before the place (Invariant B). Whether
// the spot is still missing a torch is the plan's question, answered on the manager's re-read.

'use strict';

const Vec3 = require('vec3');
const { performPlace } = require('@utils/movement/place_authority');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { isWalkableSurface } = require('@utils/movement/terrain_predicates');
const { isFullHeightFloor } = require('@utils/pathfinding_utils');

const TAG = 'lighting_executor';
const AIR = new Set(['air', 'cave_air', 'void_air']);
const isAir = b => !!b && AIR.has(b.name);
const isFullSolid = b => !!b && b.boundingBox === 'block' && isFullHeightFloor(b);
const held = (bot, name) => bot.inventory.items().some(i => i.name === name);

// standBeside: a cell beside the spot's column a body can stand in, or null.
function standBeside(bot, cell) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, 1, -1]) {
      const n = new Vec3(cell.x + dx, cell.y + dy, cell.z + dz);
      if (!isAir(bot.blockAt(n)) || !isAir(bot.blockAt(n.offset(0, 1, 0)))) continue;
      const floor = bot.blockAt(n.offset(0, -1, 0));
      if (floor && floor.boundingBox === 'block' && isWalkableSurface(floor)) return n;
    }
  }
  return null;
}

function checked(bot, p, caller) {
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: ${caller} called before the bot is in the world.`);
  }
  if (p.mount !== 'wall') {
    throw new Error(`[${TAG}] CODING VIOLATION: placement mount '${p.mount}' is not 'wall'.`);
  }
}

// The place itself, on the cells as they stand now: the torch's cell empty and the block it goes on full and solid.
async function setTorch(bot, torch, onAt, changed) {
  const on = bot.blockAt(onAt);
  if (!isAir(bot.blockAt(torch)) || !isFullSolid(on)) return { placed: false, reason: changed };
  const result = await performPlace(bot, torch, on, torch.minus(on.position), 'torch', TAG);
  if (!result.ok && result.reason === 'spawn_protected') return { placed: false, reason: 'spawn-protected ground' };
  const after = bot.blockAt(torch);
  return after && /torch$/.test(after.name) ? { placed: true, reason: null } : { placed: false, reason: 'the torch did not stick' };
}

async function placeTorch(bot, p) {
  checked(bot, p, 'placeTorch');
  if (!held(bot, 'torch')) return { placed: false, reason: 'no torch in the pocket' };
  const torch = new Vec3(p.source.x, p.source.y, p.source.z);
  const onAt = new Vec3(p.attach.x, p.attach.y, p.attach.z);
  if (!isAir(bot.blockAt(torch)) || !isFullSolid(bot.blockAt(onAt))) return { placed: false, reason: 'the wall spot is no longer air by a solid block' };
  const stand = standBeside(bot, p);
  if (!stand) return { placed: false, reason: 'no cell beside the spot to stand in' };
  const nav = await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, exact: true, leg: 'work' });
  if (!nav || nav.arrived === false) return { placed: false, reason: 'the cell beside the spot could not be reached' };
  return setTorch(bot, torch, onAt, 'the wall spot changed while the body walked to it');
}

async function placeInReach(bot, p) {
  checked(bot, p, 'placeInReach');
  if (!held(bot, 'torch')) return { placed: false, reason: 'no torch in the pocket' };
  return setTorch(bot, new Vec3(p.source.x, p.source.y, p.source.z), new Vec3(p.attach.x, p.attach.y, p.attach.z), 'the wall spot is no longer air by a solid block');
}

module.exports = { placeTorch, placeInReach };
