// fragment: spawn_protection (perception)
// purpose: the ONE answer to "may this cell be CHANGED" — the world's spawn-protected square, sensed
//          from the server rather than assumed, asked before any decision that would break or place a
//          block there.
//
// ── WHAT THE RULE ACTUALLY IS (the game's own shape, not an approximation) ────────────────────────
// A vanilla server refuses block BREAKS and block PLACEMENTS by non-op players inside a square centred
// on the WORLD SPAWN. Four properties, each of which decides something in this file:
//   · CHEBYSHEV ON X/Z: `max(|x-sx|, |z-sz|) <= radius` — a square, not a circle. A radius of 16 is a
//     33x33 footprint, not a 16-block disc, so a circular test under-protects the corners by 6 blocks.
//   · INFINITE IN Y. There is no vertical term at all: the square is a column from bedrock to sky. A
//     mine shaft sunk 60 blocks under spawn is inside it exactly as much as the grass on top.
//   · BREAK **AND** PLACE. Reading this as a mining rule leaves every build path unguarded.
//   · OVERWORLD ONLY. The other dimensions have no protected spawn.
//
// ── WHY THE FLEET NEEDS ITS OWN GATE AND CANNOT LEAN ON THE SERVER'S REFUSAL ──────────────────────
// The server refuses SILENTLY. It sends nothing the client can see — no revert, no error — and
// mineflayer's dig resolves optimistically off an AIR event it manufactures in its own world model
// (`finishDigging` -> local `_updateBlockState`; the server is never in the loop). So a refused break
// reads as a successful one at every layer above it: the bot believes it opened a hole, walks into a
// block that never left, collects nothing, and strands itself with no error anywhere in the trace.
// dig_authority's re-sense cannot catch this class either — it re-reads the same client model that
// lied, and there is no revert to land. A refusal the world will not report has to be predicted, which
// means the fleet has to hold the rule itself.
//
// ── THE GATE BINDS EVERY BOT, INCLUDING ONE THE SERVER WOULD EXEMPT (Invariant E, Law 19) ─────────
// Vanilla exempts operators, and disables the rule outright when the ops list is empty. This module
// reads NEITHER condition, deliberately: an op'd bot is gated exactly like a non-op one. Two reasons,
// and both are structural rather than a preference.
//   1. A constraint honoured only where it cannot be defeated is not a constraint (Invariant E). An
//      exemption granted by an accident of which names happen to sit in a config file is the Rogue
//      Machine error Law 19 names — the machine claiming operational rights no other agent in the
//      shared world holds.
//   2. Keying on op status would make two bots in one fleet obey different world rules, so the same
//      job would succeed or strand depending only on which bot claimed it. A fleet whose members
//      disagree about what the world permits cannot be reasoned about from its trace.
// The cost is real and accepted: an op'd bot refuses work the server would have let it do. That is the
// point — the refusal is what makes honouring the rule mean anything.
//
// ── THE WHOLE MECHANISM IS TWO THINGS, AND EVERY OTHER CHECK WAS DELETED (Law 16, Law 29) ─────────
// Architect 2026-09-15: *"prevent the spawn point from ever making it into any scan for any reason… just
// like how lava isnt a part of any pathways or decisions it can weigh against, its just not included in
// the process so nothing has to handle it. it doesent even make it past the scan."*
//
//   1. THE BODY IS NEVER INSIDE IT.
//        · foreman.js (`get`)         the desk refuses to launch a crew within PERSON_CLEAR_OF_SPAWN
//                                     (50b, Chebyshev) of world spawn; the person walks out first.
//        · death_manager.js `noHome`  a vanilla respawn with no bed lands AT world spawn, so when no base
//                                     is sited, leaving the square IS the recovery.
//        · start_injector.js          says so loudly when a run is deliberately started inside it.
//   2. ITS CELLS ARE NOT IN THE WORLD THE FLEET READS — `maskWorldReads`, below.
//
// THE LIST OF PICKERS THAT USED TO LIVE HERE IS GONE, and its deletion is the point rather than a tidy-up.
// It named twenty call sites that each had to remember the square: the melee grass cube, the log flood
// fill, the dark-cell sweep, the staircase prism, the footprint scan, the A* edge generator, and the dig
// and place authorities. Every one of them was a place the rule could be forgotten by the next fragment
// written, and two of them HAD forgotten it (the 14,000-punch seed loop of §12.3, and the staircase prism
// that sited into the square). A masked cell cannot be chosen, so none of them needs the memory: the fleet
// holds ONE rule about spawn — do not stand in it — and the world simply does not contain the rest.
//
// ── THE CENTRE IS SENSED, THE RADIUS IS DECLARED, AND NEITHER IS GUESSED ──────────────────────────
// CENTRE: the server states the world spawn in its `spawn_position` packet, so it is read off the wire
// rather than remembered (Invariant B). It is re-read every time the packet arrives, which is also how
// a `/setworldspawn` mid-run moves the square instead of leaving a stale one behind.
//
// NOT `bot.spawnPoint`. mineflayer initialises that field to (0,0,0) and overwrites it when the packet
// lands, so a read before the packet returns a well-formed falsehood indistinguishable from a real
// spawn at the origin — and worlds generated by this fleet spawn at x=0,z=0, which is precisely the
// value that would make the bug invisible (Law 13: never default a missing field; Law 26: a form check
// cannot see a falsehood). This module latches the packet itself and remembers WHETHER it arrived, so
// "not known yet" is a state a caller can be told about rather than a coordinate it silently trusts.
//
// RADIUS: no packet carries it — it is a server property the client is never told. It therefore lives
// in architect_config as a declared belief about the world, and `fleet_control` ASSERTS that same
// constant into `server.properties` at every launch. One number, one author: the launcher cannot set a
// square the bots do not know about, and the bots cannot believe in a square the launcher did not set.
//
// ── ONE QUESTION NOW, AND AN UNKNOWN CENTRE MASKS NOTHING ─────────────────────────────────────────
// `isSpawnProtected` answers "is this cell inside the square", and answers FALSE while the centre is not
// known. There used to be a second, stricter question for the verbs (`spawnProtectionVerdict`, which
// refused while the centre was unknown); it is deleted with the verb gates it served.
//
// SO AN UNKNOWN CENTRE NOW MEANS AN UNMASKED WORLD, which is the honest form of this design rather than a
// weakening of it: masking on a guess would hide real ground at (0,0) on every world whose spawn is
// elsewhere, and the fleet cannot tell the two apart before the packet lands. It is a window that does not
// occur in practice — `spawn_position` arrives during login, before the body spawns and long before any
// fragment picks a cell — and `master_core` says so at the top of the trace when it has not.
//
// In practice the strict half never fires: vanilla sends `spawn_position` during login, before the
// body is spawned, so the latch is set before any fragment runs. A login that did not produce it is a
// broken session in which no work is possible anyway — and it now says so instead of mining phantoms.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { SPAWN_PROTECTION_RADIUS } = require('@thinking/architect_config');
const { guardExternalSync } = require('@utils/external_library_guard');

// Per-bot, not module-global: the headless bench builds several bodies in one process, and a shared
// latch would let one bot's world spawn answer another's question. WeakMap so the entry dies with the
// bot rather than outliving it (Law 8 — nothing outlives its owner).
const _zones = new WeakMap();

// THE LATCH'S VERSION, so a hot reader can hold the square as four numbers and know when to re-read them
// WITHOUT asking this module per voxel. It changes at most twice in a run (the packet, and a
// `/setworldspawn`), and an integer comparison is what makes a per-read check free — see `latchVersion`.
let _latchVersion = 0;
function latchVersion() { return _latchVersion; }

// zoneFor — the latch for this body, found through the PROTOTYPE CHAIN and not by identity alone.
//
// THE WRONG TURN THIS FIXES, because it is invisible and it shipped: a WeakMap keys on object identity,
// and this fleet legitimately hands wrapped bots to its hottest consumer. `pathfinding_utils` swaps the
// search onto a fast voxel view built with `Object.create(bot)` — a NEW object whose prototype is the
// real body, so `world`, `entity` and `inventory` still resolve while block reads go through a faster
// table. `_zones.get(view)` misses. The result is the worst shape a gate can have: the module answers
// "no protected square here" with total confidence, the route search generates dig edges straight
// through the keep-out, and the refusal lands at the swing instead — so the bot plans a route it cannot
// walk, is refused, replans the same route, and gives up. Measured on the first live drill: 240 dig
// refusals, five A* searches cut off at 5000 ms each, and a body that never left the square.
//
// Walking the chain fixes it for every wrapper, present and future, rather than for the one that was
// found — a caller cannot be required to remember to unwrap before asking, because the cost of
// forgetting is a silently disarmed gate rather than an error. Chains here are one or two links, so
// this is a couple of misses before the hit.
function zoneFor(bot) {
  for (let o = bot; o; o = Object.getPrototypeOf(o)) {
    const z = _zones.get(o);
    if (z) return z;
  }
  return null;
}

// arm(bot) — latch the world spawn off the server's own packet.
//
// MUST BE CALLED IMMEDIATELY AFTER createBot, before login completes. `spawn_position` arrives during
// the login sequence, so a listener registered from the `spawn` handler is registered after the only
// packet it exists to catch and would never fire — the latch would read "unknown" for the whole run
// and every dig would be refused. Registering on the raw client stream is the same surface mineflayer's
// own spawn_point plugin uses; this is a peer listener on a public event, not a reach into its state.
function armSpawnProtection(bot) {
  if (!bot || !bot._client) {
    throw new Error('[spawn_protection] CODING VIOLATION: armSpawnProtection called with no client to listen on.');
  }
  if (_zones.has(bot)) return;                    // idempotent — a second arm would double-count nothing but is noise
  _zones.set(bot, { known: false, sx: 0, sz: 0 });
  bot._client.on('spawn_position', (packet) => {
    // ── THE PACKET HAS HAD TWO SHAPES FOR THIS ONE FACT, AND BOTH ARE READ (2026-09-17) ────────────
    // Through 1.21.x the coordinate sat directly on the packet as `location`. 26.1 wraps it in a
    // `globalPos` compound that also carries the dimension it belongs to — observed on the wire as
    // `{"globalPos":{"dimensionName":"minecraft:overworld","location":{"x":0,"z":0,"y":64}},"yaw":0,
    // "pitch":0}` — so the old read returns `undefined` and this handler warned that the packet carried
    // no usable location on EVERY login. That warning is accurate and the consequence is silent: an
    // unknown centre masks nothing (see the block above), so the fleet works an unmasked world and the
    // server refuses every break near spawn without saying why. It is how this was found — the first
    // 26.1 run could not place the person, because `--stand=biome` needs the centre to measure from.
    // The list below is the list of shapes the packet has had, newest first; one coordinate comes out.
    //
    // THE DIMENSION IS READ AND NOT USED, deliberately. World spawn is an overworld fact and the fleet
    // does not leave the overworld, so branching on `dimensionName` would be a rule for a case that
    // cannot arise — and inventing one is how a false constitution gets written (Law 27).
    const loc = (packet && packet.globalPos && packet.globalPos.location) || (packet && packet.location);
    if (!loc || typeof loc.x !== 'number' || typeof loc.z !== 'number') {
      // The packet is the ONLY source for the centre, so a malformed one cannot be repaired or
      // defaulted — say what arrived and leave the latch as it was (Law 13).
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
      // A moved world spawn moves the square under work already planned against the old one. Loud,
      // because a job that was legal when it was posted may not be legal when it runs.
      watcher.warn('spawn_protection', `World spawn MOVED (${prev.sx},${prev.sz}) -> (${sx},${sz}) — the protected square moved with it. ${describeSpawnProtection(bot)}`);
    }
  });
}

// worldSpawnPoint(bot) — WHERE WORLD SPAWN IS, and nothing about the protected square.
//
// THE DISTINCTION THIS EXISTS FOR, because reaching for `spawnProtectionBox` instead is the obvious
// mistake and it fails silently. That function answers "what must I avoid", and it returns null when
// `SPAWN_PROTECTION_RADIUS` is 0 — a world with protection switched OFF still has a world spawn, and it
// is still the place a crew must not be raised (a fresh crew sites its base around the asker, and the
// cluster of players arriving at spawn is the reason to stand clear whether or not the server guards the
// blocks). A caller asking "how far is this from spawn" through the box reads "no square, so no problem"
// and measures nothing at all.
//
// So: the CENTRE is a sensed world fact, the RADIUS is a declared belief about a server setting, and they
// are separate questions with separate answers (Law 26 — read the fact, and do not let a config value
// decide whether the fact gets read). Returns null only when the centre is genuinely unknown, which the
// caller must handle rather than default (Law 13 — never default a missing field; `bot.spawnPoint` reads
// (0,0,0) before the packet lands, and worlds this fleet generates spawn at x=0,z=0, so a default here
// would be a falsehood indistinguishable from the truth).
function worldSpawnPoint(bot) {
  const z = zoneFor(bot);
  if (!z || !z.known) return null;
  return { x: z.sx, z: z.sz };
}

// chebyshevFromWorldSpawn(bot, pos) — how far clear of world spawn a cell is, in the square's own metric.
//
// CHEBYSHEV AND NOT EUCLIDEAN, for the reason the header gives about the square: the protected region is
// `max(|dx|,|dz|) <= radius`, so every clearance measured against it has to use the same metric or the
// two disagree in the corners by up to 41% of the radius. Callers that gate on a distance from spawn are
// drawing a larger square around the same centre, so they measure the same way (Law 16 — one metric for
// one geometry). Returns null when the centre is unknown; a number is never invented.
function chebyshevFromWorldSpawn(bot, pos) {
  const c = worldSpawnPoint(bot);
  if (!c || !pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return null;
  return Math.max(Math.abs(Math.floor(pos.x) - c.x), Math.abs(Math.floor(pos.z) - c.z));
}

// spawnProtectionBox(bot) — the square as plain numbers, or null when there is nothing to avoid
// (rule switched off, or centre not yet known).
//
// HOISTED BY THE HOT CALLER, NOT ASKED PER CELL. The route search evaluates hundreds of thousands of
// cells in one pass, and a WeakMap lookup plus a config read per cell is pure waste against two
// subtractions. A* takes this box once per search and compares against it inline; everything cooler
// asks isSpawnProtected directly.
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

// isSpawnProtected(bot, x, z) — is this column inside the square?
//
// Takes bare X and Z rather than a block or a position: every caller that matters asks about a cell it
// has not fetched a block for (the search asks per node; a footprint scan asks per column), and there
// is no Y term to want. Floors both, because an entity position is a float and the square is drawn on
// cell lines.
//
// FALSE WHEN THE CENTRE IS UNKNOWN — see the one-question note in the header.
//
// IT ALLOCATES NOTHING, AND THAT IS NOT A MICRO-OPTIMISATION. Since the mask, this is asked on the voxel
// read path — hundreds of thousands of times inside one A* search, which runs against a 0.25s deadline.
// Written through `spawnProtectionBox` it built a six-field object per read; the first live run after the
// mask went in produced 677 route searches that ALL gave up ("no walking route to their bank block"), the
// desk refused to raise a crew, and nothing about the refusal pointed here. The old per-cell keep-out in
// pathfinding_utils carried the same warning in its own words: a module lookup per node prices a check
// into every one of them. Read the latch, compare four numbers, allocate nothing.
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

// ── THE MASK: THE SQUARE IS NOT SOMETHING THE FLEET AVOIDS, IT IS SOMETHING THE FLEET CANNOT SEE ────
//
// WHAT A MASKED CELL READS AS, AND WHY IT IS BEDROCK RATHER THAN null. `null` is this fleet's word for
// UNLOADED — an absence of knowledge (voxel_reader's header says so) — and the pathfinder, the drive
// primitives and `site_geometry` all treat it as "never sensed, do not plan here": `surfaceY` abandons a
// whole column at the first null, which would make the ground unreadable for anyone standing near the
// square. Bedrock is a DECISION-COMPLETE answer that every consumer already handles and none can act on:
// solid, so a route goes around instead of waiting on a chunk; not diggable, so the ordinary diggability
// gate refuses it with no spawn clause; never air, so nothing places into it; and it matches no scan
// target, so no picker offers it. That is the lava property he named — not a rule every caller has to
// remember, but a world that does not contain the thing.
//
// INSTALLED ON THE BODY, WHICH IS THE ONLY SEAM THAT CATCHES EVERYTHING. `voxel_reader` is the declared
// bulk-scan door, but it is not the only reader: `bot.blockAt` has ~220 direct call sites across the fleet
// and the pathfinder alone holds 40, so a filter living only in the reader would leave every one of them
// reading the real world. Wrapping the body's own read surface means no fragment can opt out, and one
// written next year inherits it without knowing the square exists.
//
// WHAT IS NOT MASKED, deliberately: entities and dropped items (collecting a drop inside the square is
// legal and the server allows it), light and biome queries, and the body's own position. This masks
// BLOCKS, which is what "no breaking, no placing" is about.
const MASK_BLOCK_NAME = 'bedrock';
// Extra hits asked of a block SEARCH so that filtering the masked ones out still leaves the caller the
// number it asked for. A scan that meets the square meets a sliver of it, so a couple of dozen covers the
// realistic case without widening every search in the fleet.
const MASK_SEARCH_HEADROOM = 24;
const _maskProtos = new Map();

// Built once per version off the real registry rather than hand-written, so the masked block is a real
// block carrying every field a consumer might read — the same discipline voxel_reader's table uses.
function _maskProto(bot) {
  const version = bot?.version || require('@thinking/architect_config').SERVER_MINECRAFT_VERSION;
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

// maskStateId(bot) — the masked block's state id, for readers that work in state ids (voxel_reader's fast
// column path). Same block, same table, so both read paths answer identically (Law 16).
function maskStateId(bot) {
  return _maskProto(bot).stateId;
}

// maskedBlockAt(bot, x, y, z) — the masked block for this cell, or null when the cell is not masked.
function maskedBlockAt(bot, x, y, z) {
  if (!isSpawnProtected(bot, x, z)) return null;
  const p = _maskProto(bot);
  const out = Object.assign(Object.create(Object.getPrototypeOf(p)), p);
  out.position = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  return out;
}

// maskWorldReads(bot) — wrap the body's block reads. Called once, beside armSpawnProtection, and idempotent
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

  // findBlocks searches mineflayer's own chunk store and never calls blockAt, so it is wrapped too. It asks
  // for MORE than the caller wanted and trims after filtering: `count` is a request for that many usable
  // hits, and answering with fewer because the nearest few were inside would make the square shrink the
  // result of every scan that happens to face it.
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

// describeSpawnProtection(bot) — one line for a log or a report. Kept here so every place that prints
// the square prints the same sentence from the same numbers (Law 16), rather than each caller
// re-deriving bounds and drifting on the corner arithmetic.
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
