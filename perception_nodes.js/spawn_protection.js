// fragment: spawn_protection (perception) — the one answer to "may this cell be changed": the server's
// spawn-protected square, sensed from the world, asked before any break or place.
//
// THE RULE: a Chebyshev square on x/z (`max(|x-sx|,|z-sz|) <= radius`) centred on world spawn, infinite
// in Y, blocking BREAK and PLACE, overworld only. The server refuses silently, so this module predicts
// the rule directly, and binds every bot, op or not (Invariant E, Law 19).
//
// THE MECHANISM (Law 16, Law 29): the body is kept out of the square (foreman.js `get`, death_manager.js
// `noHome`, start_injector.js), and its cells are removed from the world the fleet reads
// (`maskWorldReads`, below), so no picker or search elsewhere has to remember it.
//
// The centre is sensed off the `spawn_position` packet (Invariant B), not `bot.spawnPoint`, which
// defaults to (0,0,0) before the packet lands (Law 13). The radius is never sent; it is a declared
// belief in architect_config that `fleet_control` asserts into `server.properties` (Law 16).
// `isSpawnProtected` is false while the centre is unknown, so that window is an unmasked world.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { SPAWN_PROTECTION_RADIUS, SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');
const { guardExternalSync } = require('@utils/external_library_guard');

// Per-bot latch, so the headless bench's several bodies never share one. WeakMap so it dies with its bot (Law 8).
const _zones = new WeakMap();

// Version counter, so a hot reader can cache the square and know when to re-read it by one integer compare.
let _latchVersion = 0;
function latchVersion() { return _latchVersion; }

// zoneFor(bot) — this body's latch, found by walking the prototype chain, so a fast voxel view passed by
// `pathfinding_utils` (`Object.create(bot)`) still resolves to its bot's latch, which a plain `_zones.get` would miss.
function zoneFor(bot) {
  for (let o = bot; o; o = Object.getPrototypeOf(o)) {
    const z = _zones.get(o);
    if (z) return z;
  }
  return null;
}

// armSpawnProtection(bot) — latches world spawn off the server's own packet. Must be called immediately
// after createBot: `spawn_position` arrives during login, before `spawn` fires, so a listener registered
// on the `spawn` handler would never see it.
function armSpawnProtection(bot) {
  if (!bot || !bot._client) {
    throw new Error('[spawn_protection] CODING VIOLATION: armSpawnProtection called with no client to listen on.');
  }
  if (_zones.has(bot)) return;                    // idempotent — a second arm would double-count nothing but is noise
  _zones.set(bot, { known: false, sx: 0, sz: 0 });
  bot._client.on('spawn_position', (packet) => {
    // `location` through 1.21.x, `globalPos.location` (dimension unread — overworld-only) from 26.1 on.
    const loc = (packet && packet.globalPos && packet.globalPos.location) || (packet && packet.location);
    if (!loc || typeof loc.x !== 'number' || typeof loc.z !== 'number') {
      // The packet is the only source for the centre; a malformed one leaves the latch as it was (Law 13).
      watcher.warn('spawn_protection', `spawn_position carried no usable location (${JSON.stringify(loc)}) — world spawn still ${_zones.get(bot).known ? 'the previously received value' : 'UNKNOWN'}.`);
      return;
    }
    const sx = Math.floor(loc.x);
    const sz = Math.floor(loc.z);
    const prev = _zones.get(bot);
    _zones.set(bot, { known: true, sx, sz });
    _latchVersion++;
    if (!prev.known) {
      watcher.summary('spawn_protection', `World spawn received: (${sx},${sz}). ${describeSpawnProtection(bot)}`);
    } else if (prev.sx !== sx || prev.sz !== sz) {
      // A moved world spawn moves the square under work already planned against the old one.
      watcher.warn('spawn_protection', `World spawn MOVED (${prev.sx},${prev.sz}) -> (${sx},${sz}) — the protected square moved with it. ${describeSpawnProtection(bot)}`);
    }
  });
}

// worldSpawnPoint(bot) — where world spawn is, distinct from `spawnProtectionBox` ("what must I avoid",
// null when radius is 0): a world with the block rule off still has a spawn a crew stands clear of
// (Law 26). Null only when the centre is genuinely unknown; never defaulted (Law 13).
function worldSpawnPoint(bot) {
  const z = zoneFor(bot);
  if (!z || !z.known) return null;
  return { x: z.sx, z: z.sz };
}

// chebyshevFromWorldSpawn(bot, pos) — clearance from world spawn in the square's own metric (Chebyshev,
// not Euclidean — Law 16). Null when the centre is unknown; a number is never invented.
function chebyshevFromWorldSpawn(bot, pos) {
  const c = worldSpawnPoint(bot);
  if (!c || !pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return null;
  return Math.max(Math.abs(Math.floor(pos.x) - c.x), Math.abs(Math.floor(pos.z) - c.z));
}

// spawnProtectionBox(bot) — the square as plain numbers, or null (rule off, or centre not yet known).
// Hoisted once by a hot caller like A*; everything cooler asks isSpawnProtected directly.
function spawnProtectionBox(bot) {
  if (!(SPAWN_PROTECTION_RADIUS > 0)) return null;         // radius 0 (or absent) = the world has no such rule
  const z = zoneFor(bot);
  if (!z || !z.known) return null;
  return {
    centerX: z.sx,
    centerZ: z.sz,
    radius: SPAWN_PROTECTION_RADIUS,
    minX: z.sx - SPAWN_PROTECTION_RADIUS, maxX: z.sx + SPAWN_PROTECTION_RADIUS,
    minZ: z.sz - SPAWN_PROTECTION_RADIUS, maxZ: z.sz + SPAWN_PROTECTION_RADIUS,
  };
}

// isSpawnProtected(bot, x, z) — is this column inside the square? Bare x/z: the rule has no Y term.
// Floors both, since a position is a float and the square sits on cell lines. False while the centre is
// unknown. Allocates nothing — runs on the voxel read path inside every A* search.
function isSpawnProtected(bot, x, z) {
  if (!(SPAWN_PROTECTION_RADIUS > 0)) return false;
  const zone = zoneFor(bot);
  if (!zone || !zone.known) return false;
  const dx = Math.floor(x) - zone.sx;
  const dz = Math.floor(z) - zone.sz;
  return (dx < 0 ? -dx : dx) <= SPAWN_PROTECTION_RADIUS && (dz < 0 ? -dz : dz) <= SPAWN_PROTECTION_RADIUS;
}

// isSpawnProtectedAt(bot, pos) — the same question for callers already holding a position/Vec3.
function isSpawnProtectedAt(bot, pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return false;
  return isSpawnProtected(bot, pos.x, pos.z);
}

// ── THE MASK ── the square is not something the fleet avoids, it is something it cannot see. A masked
// cell reads as bedrock, not null (`null` means UNLOADED to every reader): bedrock is decision-complete —
// solid, undiggable, never air. Installed on the body (`bot.blockAt` has ~220 call sites fleet-wide), so
// every reader sees it. Not masked: entities, dropped items, light/biome, own position.
const MASK_BLOCK_NAME = 'bedrock';
// Extra hits requested from a block search so filtering out masked ones still meets the caller's count.
const MASK_SEARCH_HEADROOM = 24;
const _maskProtos = new Map();

// _maskProto() — the masked block, built once per version off the real registry. Version comes from
// architect_config, not `bot.version` (Law 16 — one author for both).
function _maskProto() {
  const version = SERVER_MINECRAFT_VERSION;
  let p = _maskProtos.get(version);
  if (p !== undefined) return p;
  const Block = require('prismarine-block')(version);
  const mcData = require('minecraft-data')(version);
  const entry = mcData.blocksByName[MASK_BLOCK_NAME];
  p = entry ? guardExternalSync('spawn_protection', `Block.fromStateId(${MASK_BLOCK_NAME})`, () => Block.fromStateId(entry.defaultState, 0)).value ?? null : null;
  if (!p) {
    throw new Error(`[spawn_protection] CODING VIOLATION: the mask block '${MASK_BLOCK_NAME}' does not exist in minecraft-data ${version}, so protected cells cannot be made invisible.`);
  }
  _maskProtos.set(version, p);
  return p;
}

// maskStateId(bot) — the masked block's state id, for readers that work in state ids (Law 16 — same table as maskedBlockAt).
function maskStateId(bot) {
  return _maskProto().stateId;
}

// maskedBlockAt(bot, x, y, z) — the masked block for this cell, or null when the cell is not masked.
function maskedBlockAt(bot, x, y, z) {
  if (!isSpawnProtected(bot, x, z)) return null;
  const p = _maskProto();
  const out = Object.assign(Object.create(Object.getPrototypeOf(p)), p);
  out.position = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  return out;
}

// maskWorldReads(bot) — wraps the body's block reads. Called once, beside armSpawnProtection; idempotent
// because a second call would wrap the wrapper.
function maskWorldReads(bot) {
  if (!bot || typeof bot.blockAt !== 'function') {
    throw new Error('[spawn_protection] CODING VIOLATION: maskWorldReads called with no body to mask.');
  }
  if (bot._spawnMaskInstalled) return;
  bot._spawnMaskInstalled = true;

  const realBlockAt = bot.blockAt.bind(bot);
  bot.blockAt = (point, extraInfo) => {
    if (point) {
      const m = maskedBlockAt(bot, point.x, point.y, point.z);
      if (m) return m;
    }
    return realBlockAt(point, extraInfo);
  };

  // findBlocks reads mineflayer's chunk store directly, never through blockAt, so it is wrapped too.
  // Asks for more than wanted and trims after filtering, so a scan facing the square still meets its count.
  const realFindBlocks = bot.findBlocks.bind(bot);
  bot.findBlocks = (options) => {
    const want = (options && options.count) || 1;
    const found = realFindBlocks({ ...(options || {}), count: want + MASK_SEARCH_HEADROOM });
    const kept = found.filter(p => !isSpawnProtected(bot, p.x, p.z));
    return kept.length > want ? kept.slice(0, want) : kept;
  };
  bot.findBlock = (options) => {
    const found = bot.findBlocks({ ...(options || {}), count: 1 });
    return found.length ? bot.blockAt(found[0]) : null;
  };
}

// describeSpawnProtection(bot) — one line for a log or report, so every caller prints the same sentence
// from the same numbers (Law 16).
function describeSpawnProtection(bot) {
  if (!(SPAWN_PROTECTION_RADIUS > 0)) return 'Spawn protection is OFF (radius 0) — no cell is off-limits.';
  const box = spawnProtectionBox(bot);
  if (!box) return `Spawn protection radius ${SPAWN_PROTECTION_RADIUS} is declared but the world spawn is NOT KNOWN yet — nothing is masked until the packet arrives, so the fleet is reading the real world at the world centre.`;
  const side = box.radius * 2 + 1;
  return `Spawn-protected square: centre (${box.centerX},${box.centerZ}), radius ${box.radius} -> x ${box.minX}..${box.maxX}, z ${box.minZ}..${box.maxZ} (${side}x${side}, full height). No breaking, no placing, any bot, op or not.`;
}

module.exports = {
  armSpawnProtection,
  worldSpawnPoint,
  chebyshevFromWorldSpawn,
  spawnProtectionBox,
  isSpawnProtected,
  isSpawnProtectedAt,
  maskWorldReads,
  maskedBlockAt,
  maskStateId,
  latchVersion,
  describeSpawnProtection,
};
