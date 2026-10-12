// module: ground_shave
// purpose: the one rule for taking ground off the surface, and the claim a body holds over the patch it
//          takes it from. Ground comes off a layer at a time, so ground a body has dug is still ground
//          every body can walk (Law 17).
//
// ── THE RULE ──────────────────────────────────────────────────────────────────────────────────────────
// A block is shaved when it is the open top of its column (two passable cells over it), a standable
// block lies directly under it, and none of its eight neighbours stands higher than it. Taking it
// lowers its column by one, to sit level with its neighbours or one step under them, so no column is
// ever left more than one step from the column beside it. A body works the layer its feet rest on and
// the ground above that layer, and walks on when the layer within reach is spent.
//
// ── THE CLAIM ─────────────────────────────────────────────────────────────────────────────────────────
// Ground is held by the TILE — `dirt:tx,tz`, a DIRT_TILE square of columns — taken before the walk
// through target_claims, so each patch has one digger (Invariant A). The tile stays open to every
// body's route, since shaved ground is walkable ground. A tile touching a base keep-out box is never
// offered.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { isWalkableSurface, classifyFloor } = require('@utils/movement/terrain_predicates');
const { claimFirst, releaseTarget } = require('@utils/target_claims');

const TAG = 'ground_shave';

const DIRT_TILE = 8;                 // columns per side of one claimed tile
const KEY_PREFIX = 'dirt:';
const AREA_BELOW = 4;                // how far under the holder's feet a tile is searched for ground
const AREA_ABOVE = 6;                // and how far over them
const MAX_MOVES = 6;                 // walks to fresh ground one errand may spend
const MAX_STANDS_TRIED = 3;          // stands tried per walk before the errand gives the ground up

const EIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function passable(bot, x, y, z) {
  return require('@utils/pathfinding_utils').isBlockPassable(bot.blockAt(new Vec3(x, y, z)));
}

// shaveable — the rule in the header, asked of one block.
function shaveable(bot, x, y, z) {
  if (!passable(bot, x, y + 1, z) || !passable(bot, x, y + 2, z)) return false;
  if (!isWalkableSurface(bot.blockAt(new Vec3(x, y - 1, z)))) return false;
  for (const [dx, dz] of EIGHT) {
    if (!passable(bot, x + dx, y + 1, z + dz)) return false;
  }
  return true;
}

// underABody — true when a standing player's hitbox rests on this block: this body's own, or a peer's.
function underABody(bot, x, y, z) {
  const { BODY_HALF_WIDTH } = require('@utils/calculators/jump_calculator');
  const players = Object.values(bot.entities || {}).filter(e => e && e.type === 'player' && e !== bot.entity);
  for (const e of [bot.entity, ...players]) {
    const p = e && e.position;
    if (!p || Math.floor(p.y - 0.01) !== y) continue;
    if (x >= Math.floor(p.x - BODY_HALF_WIDTH) && x <= Math.floor(p.x + BODY_HALF_WIDTH)
      && z >= Math.floor(p.z - BODY_HALF_WIDTH) && z <= Math.floor(p.z + BODY_HALF_WIDTH)) return true;
  }
  return false;
}

const tileOf = (x, z) => ({ tx: Math.floor(x / DIRT_TILE), tz: Math.floor(z / DIRT_TILE) });
const keyOfTile = (t) => `${KEY_PREFIX}${t.tx},${t.tz}`;
const cornerOf = (t) => ({ x: t.tx * DIRT_TILE, z: t.tz * DIRT_TILE });

function touchesKeepout(t, keepout) {
  const c = cornerOf(t);
  const maxX = c.x + DIRT_TILE - 1, maxZ = c.z + DIRT_TILE - 1;
  return (keepout || []).some(b => c.x <= b.maxX && maxX >= b.minX && c.z <= b.maxZ && maxZ >= b.minZ);
}

// The tiles peers hold, read from the broadcast boardroom the way the tree census reads `tree:` claims.
function peerTileKeys() {
  const hq = require('@kernel/corporate_headquarters');
  const selfId = process.env.BOT_ID || 'default';
  const keys = new Set();
  for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}) || {})) {
    if (botId === selfId || !chair || !chair.magnet) continue;
    for (const key of Object.keys(chair.active_claims || {})) {
      if (key.startsWith(KEY_PREFIX)) keys.add(key);
    }
  }
  return keys;
}

// standBeside — the feet cell a body digs `target` from: a standable neighbour level with the block or
// one step under it, the nearest to the body. The block's own top when no neighbour stands.
function standBeside(bot, target) {
  const from = bot.entity.position;
  let best = null;
  for (const [dx, dz] of EIGHT) {
    for (const floorY of [target.y, target.y - 1]) {
      const x = target.x + dx, z = target.z + dz;
      if (!classifyFloor(bot, bot.blockAt(new Vec3(x, floorY, z)))) continue;
      const d2 = (x + 0.5 - from.x) ** 2 + (floorY + 1 - from.y) ** 2 + (z + 0.5 - from.z) ** 2;
      if (!best || d2 < best.d2) best = { x, y: floorY + 1, z, d2 };
      break;
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : { x: target.x, y: target.y + 1, z: target.z };
}

// open — one errand's hold on the ground. `blocks` are the block names the errand takes; `keepout` is
// the base's keep-out boxes (fragment_utils.harvestKeepoutBoxes).
function open(bot, { keepout, blocks }) {
  const held = new Map();        // claim key → tile, every tile this errand holds
  const refused = new Set();     // claim keys a peer answered for during this errand
  let peers = peerTileKeys();
  let moves = 0;

  const free = (t) => {
    const key = keyOfTile(t);
    if (held.has(key)) return true;
    return !touchesKeepout(t, keepout) && !refused.has(key) && !peers.has(key);
  };

  // offers — true for a block this errand may take: shaveable, under no body, in a tile it holds or may claim.
  const offers = (pos) => free(tileOf(pos.x, pos.z))
    && shaveable(bot, pos.x, pos.y, pos.z) && !underABody(bot, pos.x, pos.y, pos.z);

  // hold — true when this body holds the tile the column stands in, claiming it when it is free.
  async function hold(x, z) {
    const t = tileOf(x, z);
    const key = keyOfTile(t);
    if (held.has(key)) return true;
    if (!free(t)) return false;
    const walk = await claimFirst([t], { keyOf: keyOfTile });
    if (!walk.pick) { refused.add(key); return false; }
    held.set(key, t);
    return true;
  }

  async function reach(target) {
    const stand = standBeside(bot, target);
    const res = await require('@locomotion/locomotion_dispatcher').goTo({ ...stand, leg: 'work' });
    return { ok: !!(res && res.arrived), reason: 'path_failed' };
  }

  // claimAndReach — takes the nearest free tile among the scan's candidates and walks to it. The tile is
  // claimed before the walk.
  async function claimAndReach(candidates) {
    const from = bot.entity.position;
    const near = (c) => (c.position.x - from.x) ** 2 + (c.position.y - from.y) ** 2 + (c.position.z - from.z) ** 2;
    const tiles = [];
    const seen = new Set();
    for (const c of [...candidates].sort((a, b) => near(a) - near(b))) {
      const t = tileOf(c.position.x, c.position.z);
      const key = keyOfTile(t);
      if (seen.has(key)) continue;
      seen.add(key);
      tiles.push({ ...t, target: c.position });
    }
    const walk = await claimFirst(tiles, { keyOf: keyOfTile, approach: (t) => reach(t.target), maxUnreachable: MAX_STANDS_TRIED });
    for (const key of walk.peerHeldKeys) refused.add(key);
    if (!walk.pick) return { ok: false, tiles: tiles.length, peerHeld: walk.peerHeld, unreachable: walk.unreachable };
    held.set(walk.key, { tx: walk.pick.tx, tz: walk.pick.tz });
    watcher.summary(TAG, `Holding ground tile ${walk.key} — this body is its one digger.`);
    return { ok: true, key: walk.key };
  }

  // The shaveable top of every column in one tile, within the search height of the body's feet.
  function shaveableIn(t, skip) {
    const c = cornerOf(t);
    const feetY = Math.floor(bot.entity.position.y);
    const found = [];
    for (let x = c.x; x < c.x + DIRT_TILE; x++) {
      for (let z = c.z; z < c.z + DIRT_TILE; z++) {
        for (let y = feetY + AREA_ABOVE; y >= feetY - AREA_BELOW; y--) {
          const b = bot.blockAt(new Vec3(x, y, z));
          if (!b || !blocks.includes(b.name)) continue;
          if (!skip.has(`${x},${y},${z}`) && shaveable(bot, x, y, z) && !underABody(bot, x, y, z)) found.push({ x, y, z });
          break;   // only the topmost such block of a column can be open
        }
      }
    }
    return found;
  }

  // moveOn — walks the body to fresh ground: the highest shaveable block in the tiles it holds, then in
  // the tiles around it. `skip` holds the "x,y,z" cells this errand already failed on. True when the
  // body stands beside fresh ground.
  async function moveOn(skip) {
    if (moves >= MAX_MOVES) return false;
    moves++;
    peers = peerTileKeys();
    const from = bot.entity.position;
    const highestThenNearest = (a, b) => (b.y - a.y)
      || (((a.x - from.x) ** 2 + (a.z - from.z) ** 2) - ((b.x - from.x) ** 2 + (b.z - from.z) ** 2));

    let found = [...held.values()].flatMap(t => shaveableIn(t, skip));
    if (!found.length) {
      const here = tileOf(Math.floor(from.x), Math.floor(from.z));
      for (const [dx, dz] of EIGHT) {
        const t = { tx: here.tx + dx, tz: here.tz + dz };
        if (held.has(keyOfTile(t)) || !free(t)) continue;
        const fresh = shaveableIn(t, skip);
        if (!fresh.length) continue;
        const c = cornerOf(t);
        if (!await hold(c.x, c.z)) continue;
        found = fresh;
        break;
      }
    }
    if (!found.length) return false;

    found.sort(highestThenNearest);
    for (const target of found.slice(0, MAX_STANDS_TRIED)) {
      if ((await reach(target)).ok) return true;
      skip.add(`${target.x},${target.y},${target.z}`);
    }
    return false;
  }

  // release — hands every tile back (Law 8).
  function release() {
    if (!held.size) return;
    releaseTarget([...held.keys()]);
    held.clear();
  }

  return { offers, hold, claimAndReach, moveOn, release, moves: () => moves };
}

module.exports = { open, shaveable, DIRT_TILE, TAG };
