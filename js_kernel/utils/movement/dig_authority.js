// The one dig route for the fleet (Law 16): raw dig verbs shared by build_executor and mining_executor.
// digBounded is not exported — performDig is the only way to dig, so every dig is re-sensed.

'use strict';

const watcher = require('@kernel/watcher');
const { isFluid } = require('@utils/gravity_utils');
const { sleep, equipBestToolForBlock, STATION_TYPES } = require('@utils/fragment_utils');
const { isAir, belowDepthFloor } = require('@utils/movement/terrain_predicates');
const { WORLD_DEPTH_FLOOR_Y } = require('@thinking/architect_config');
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

// Stations are undiggable (STATION_TYPES) except crafting_table, which drops to any tool so a wrong-tool
// break can't destroy it. isUnbreakable is exported to ask this without swinging (Law 16).
const BREAKABLE_STATIONS = new Set(['crafting_table']);
function isUnbreakable(name) { return STATION_TYPES.has(name) && !BREAKABLE_STATIONS.has(name); }

// Mineflayer leaves container windows open after chest/furnace use, which blocks the next
// bot.equip / bot.placeBlock — close it first.
async function ensureNoOpenWindow(bot, label = 'equip') {
  if (!bot || !bot.currentWindow) return;
  const w = bot.currentWindow;
  watcher.summary('dig_authority', `Closing window before ${label}: type=${w.type || 'unknown'}`);
  guardExternalSync('dig_authority', `closeWindow before ${label}`, () => {
    if (typeof bot.closeWindow === 'function') bot.closeWindow(w);
    else if (bot._client && typeof bot._client.write === 'function' && w.id != null) bot._client.write('close_window', { windowId: w.id });
  });
  let tries = 0;
  while (bot.currentWindow && tries < 8) { await sleep(80); tries++; }
}

// ── digBounded: the ONE dig authority (Law 16). Every dig in this system goes through here. ──
// mineflayer's bot.dig() has no timeout and can hang if the cell's chunk is unloaded when it resolves.
// TODO: gate on chunk presence (bot.blockAt(pos) !== null) before digging, instead of bounding the wait.
const DIG_TIMEOUT_MIN_MS = 3000;    // floor — an instant block plus server round-trip, generously
const DIG_TIMEOUT_SLACK  = 3;       // budget = expected dig time x this …
const DIG_TIMEOUT_MAX_MS = 30000;   // … clamped here; past this the chunk is gone, not the block slow
const DIG_TIMED_OUT = Symbol('dig_timed_out');

// Keeps the budget from falling below the dig's own expected time, so a slow dig is never aborted early.
const DIG_TIMEOUT_ESTIMATE_FLOOR = 1.25;

async function digBounded(bot, block, tag = 'dig_authority') {
  if (!block) return false;
  const pos = block.position;
  // A dig sent to a frozen server is applied late or not at all, so it waits for the server to tick.
  await require('@kernel/server_pulse').answering(bot);

  const timed = guardExternalSync(tag, `digTime(${block.name})`, () => bot.digTime(block));
  let expected = timed.ok ? timed.value : 0;
  if (!Number.isFinite(expected)) expected = DIG_TIMEOUT_MAX_MS;   // unbreakable-by-tool → clamp, don't hang
  const budget = Math.max(DIG_TIMEOUT_MIN_MS,
                          Math.min(DIG_TIMEOUT_MAX_MS, expected * DIG_TIMEOUT_SLACK),
                          expected * DIG_TIMEOUT_ESTIMATE_FLOOR);

  const digPromise = bot.dig(block);
  digPromise.catch(() => {});   // the abort below rejects this; never surface it as unhandled

  // bot.dig() rejects on ordinary refusals; a rejection isn't the verdict — both fall through to the same re-sense below (Invariant B).
  let timer = null;
  const raced = await guardExternal(tag, `dig ${block.name} at (${pos.x},${pos.y},${pos.z})`, () => Promise.race([
    digPromise.then(() => 'done'),
    new Promise(resolve => { timer = setTimeout(() => resolve(DIG_TIMED_OUT), budget); }),
  ]));
  clearTimeout(timer);
  if (raced.ok && raced.value !== DIG_TIMED_OUT) return true;
  if (!raced.ok) {
    const after = bot.blockAt(pos);
    return !after || after.name === 'air' || after.boundingBox === 'empty';
  }

  // Hung: abort the swing and drop mineflayer's stale per-cell listener by hand; re-sense decides the verdict (Law 13).
  guardExternalSync(tag, `stopDigging while aborting a hung dig at (${pos.x},${pos.y},${pos.z})`, () => bot.stopDigging());
  guardExternalSync(tag, `removeAllListeners while aborting a hung dig at (${pos.x},${pos.y},${pos.z})`, () => bot.removeAllListeners(`blockUpdate:${pos}`));

  const after = bot.blockAt(pos);
  const gone = !after || after.name === 'air' || after.boundingBox === 'empty';
  watcher.warn(tag, `dig_timeout ${block.name} at (${pos.x},${pos.y},${pos.z}) — no air blockUpdate in ${budget}ms (expected ${Math.round(expected)}ms). mineflayer's dig never resolved; aborted and re-sensed: block ${gone ? 'IS gone (promise stuck, work done)' : 'still standing'}.`);
  return gone;
}

// performDig: the one dig authority (Law 16). Equip → look → bounded dig → re-sense; a non-throwing
// dig is not proof of removal (mineflayer resolves client-side first), so this re-senses the cell and
// returns true only if it now reads air/passable (Invariant B / Law 13). A server-refused break with no
// revert still reads as a false true here.
// opts.equip: 'best' (default) equips the best tool; 'none' leaves the hand as-is, for callers whose
// drops depend on the held item.
const LOCOMOTION_DIG_TAGS = new Set(['navigator', 'drive', 'scaffold_movement']);
const LEAF_REFLEX_TAG = 'leaf_authority';

// bobbing — the body is afloat: in water with nothing solid under its feet, or with water over its head
// cell. A body standing on a floor in water one deep is STANDING, whether that water is still or running,
// and reads false. The one test for "may this body dig": no dig is made afloat, by any caller.
function bobbing(bot) {
  const p = bot?.entity?.position;
  if (!p) return false;
  const f = p.floored();
  const wet = (b) => !!(b && isFluid(b.name));
  const feet = bot.blockAt(f), below = bot.blockAt(f.offset(0, -1, 0)), head = bot.blockAt(f.offset(0, 1, 0));
  if (wet(feet)) return wet(head) || !(below && below.boundingBox === 'block');
  return wet(below);
}

// lastSupportOf — true when the block at `pos` is the only solid block under a standing body's hitbox,
// so breaking it drops that body. The hitbox spans up to four columns; a body whose centre is over air
// is held by a neighbour's edge, and that neighbour is the block this finds.
function lastSupportOf(bot, entity, pos) {
  const p = entity?.position;
  if (!p) return false;
  const { BODY_HALF_WIDTH } = require('@utils/calculators/jump_calculator');
  const floorY = Math.floor(p.y - 0.01);             // the layer the feet rest on
  if (pos.y !== floorY || p.y - (floorY + 1) > 0.05) return false;   // not resting on that layer
  const xs = new Set([Math.floor(p.x - BODY_HALF_WIDTH), Math.floor(p.x + BODY_HALF_WIDTH)]);
  const zs = new Set([Math.floor(p.z - BODY_HALF_WIDTH), Math.floor(p.z + BODY_HALF_WIDTH)]);
  if (!xs.has(pos.x) || !zs.has(pos.z)) return false;
  const Vec3 = require('vec3');
  for (const x of xs) for (const z of zs) {
    if (x === pos.x && z === pos.z) continue;
    const b = bot.blockAt(new Vec3(x, floorY, z));
    if (b && b.boundingBox === 'block') return false;
  }
  return true;
}

// The body holding up on this block, if any: this bot or any player standing on it — a peer dropped
// into a hole it did not dig falls as hard as the digger would.
function bodyHeldBy(bot, pos) {
  if (bot?.entity?.onGround && lastSupportOf(bot, bot.entity, pos)) return 'the body';
  for (const e of Object.values(bot?.entities || {})) {
    if (!e || e === bot.entity || e.type !== 'player' || !e.position) continue;
    if (Math.abs(e.position.x - pos.x - 0.5) > 1 || Math.abs(e.position.z - pos.z - 0.5) > 1) continue;
    if (lastSupportOf(bot, e, pos)) return e.username || 'a player';
  }
  return null;
}

// The peer whose next step down lands on this block, if any: the block directly beneath the layer a
// standing peer rests on, inside its hitbox's columns. A body lowering itself checks that block and
// then swings, and the block must still be there when the swing ends.
function peerLandingOn(bot, pos) {
  const { BODY_HALF_WIDTH } = require('@utils/calculators/jump_calculator');
  for (const e of Object.values(bot?.entities || {})) {
    if (!e || e === bot.entity || e.type !== 'player' || !e.position) continue;
    const p = e.position;
    const floorY = Math.floor(p.y - 0.01);
    if (pos.y !== floorY - 1 || p.y - (floorY + 1) > 0.05) continue;
    if (pos.x < Math.floor(p.x - BODY_HALF_WIDTH) || pos.x > Math.floor(p.x + BODY_HALF_WIDTH)) continue;
    if (pos.z < Math.floor(p.z - BODY_HALF_WIDTH) || pos.z > Math.floor(p.z + BODY_HALF_WIDTH)) continue;
    return e.username || 'a player';
  }
  return null;
}

// ── Gravity reflex (Law 17): a dig never drops sand or gravel into the digger's own body. ──
// fallingOntoBody — the gravity stack resting on `pos` when breaking `pos` would land it in the body's
// feet or head cells; null when it would not. The stack falls down the target's column to the first
// solid block beneath, and the body is no floor to it, so the cells it fills are landing+1 … landing+k.
// A column the hitbox spans buries the body where it stands; the column beside the body's cell is the
// passage it is opening to step into, and the stack refills it at head height as it walks in.
// `beside` marks the second case.
const GRAVITY_SCAN_DOWN = 8;
function fallingOntoBody(bot, pos) {
  const { isGravityBlock } = require('@utils/gravity_utils');
  const p = bot?.entity?.position;
  if (!p) return null;
  const { BODY_HALF_WIDTH } = require('@utils/calculators/jump_calculator');
  const spans = pos.x >= Math.floor(p.x - BODY_HALF_WIDTH) && pos.x <= Math.floor(p.x + BODY_HALF_WIDTH)
    && pos.z >= Math.floor(p.z - BODY_HALF_WIDTH) && pos.z <= Math.floor(p.z + BODY_HALF_WIDTH);
  const beside = !spans && Math.abs(pos.x - Math.floor(p.x)) + Math.abs(pos.z - Math.floor(p.z)) === 1;
  if (!spans && !beside) return null;
  const feetY = Math.floor(p.y), headY = Math.floor(p.y + 1.79);
  if (pos.y < feetY) return null;
  const stack = [];
  for (let y = pos.y + 1; ; y++) {
    const b = bot.blockAt(pos.offset(0, y - pos.y, 0));
    if (!b || !isGravityBlock(b.name)) break;
    stack.push(b);
  }
  if (!stack.length) return null;
  let landing = null;
  for (let y = pos.y - 1; y >= pos.y - GRAVITY_SCAN_DOWN; y--) {
    const b = bot.blockAt(pos.offset(0, y - pos.y, 0));
    if (b && b.boundingBox === 'block') { landing = y; break; }
  }
  if (landing === null) landing = pos.y - GRAVITY_SCAN_DOWN;
  const lo = landing + 1, hi = landing + stack.length;
  if (hi < feetY || lo > headY) return null;
  stack.beside = beside;
  return stack;
}

// clearFallingAbove — the takeover. Digs the stack top-down, so each block it breaks has nothing loose
// above it, then hands control back. A block past BLOCK_REACH is reached by pillaring up the body's own
// column. Returns true when the stack is gone; false refuses the caller's dig (the body's safety over
// the task). Each dig is an ordinary performDig, so every gate above still applies to it. Whatever it
// climbed it comes back down, on every exit, so the body is handed back standing where it was taken.
async function clearFallingAbove(bot, pos, stack, tag) {
  const { BLOCK_REACH } = require('@utils/fragment_utils');
  const eyeTo = b => bot.entity.position.offset(0, 1.62, 0).distanceTo(b.position.offset(0.5, 0.5, 0.5));
  // Beside the body the stack is cleared only when all of it is in reach: the body does not climb a
  // column it is not standing in, and the dig goes ahead as it always did.
  if (stack.beside && stack.some(b => eyeTo(b) > BLOCK_REACH)) return true;
  const placed = [];
  const cleared = await _digStackTopDown(bot, pos, stack, tag, eyeTo, BLOCK_REACH, placed);
  const lowered = await _descendPillar(bot, placed, tag);
  if (cleared) watcher.summary(tag, `GRAVITY REFLEX at (${pos.x},${pos.y},${pos.z}): ${stack.length} ${stack[0].name} block(s) above would have fallen ${stack.beside ? 'into the passage the body is opening' : 'on the body'} — dug top-down first${placed.length ? `, pillared ${placed.length}, came back down ${lowered}` : ''}; control returned.`);
  // A body left up its own column is not where the caller's dig was planned from, so that dig is refused.
  return cleared && lowered === placed.length;
}

// The climb-and-clear half of the reflex. Every block the body places under itself is pushed onto
// `placed`, in the order placed, for _descendPillar to take back.
async function _digStackTopDown(bot, pos, stack, tag, eyeTo, reach, placed) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const b = stack[i];
    while (eyeTo(b) > reach) {
      const above = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
      if (!above || above.boundingBox === 'block') {
        watcher.warn(tag, `GRAVITY REFLEX refused (${pos.x},${pos.y},${pos.z}) — ${b.name} at y=${b.position.y} is out of reach and ${above ? above.name : 'an unloaded cell'} caps the climb; the dig would bury the body.`);
        return false;
      }
      const step = await require('@utils/movement/scaffold_movement').pillarStep(bot);
      if (!step || !step.success) {
        watcher.warn(tag, `GRAVITY REFLEX refused (${pos.x},${pos.y},${pos.z}) — ${b.name} at y=${b.position.y} is out of reach and the pillar failed (${step ? step.reason : 'no result'}); the dig would bury the body.`);
        return false;
      }
      placed.push(step.placedPosition);
    }
    const live = bot.blockAt(b.position);
    if (!live || isAir(live.name)) continue;
    if (!(await performDig(bot, b.position, live, tag))) {
      watcher.warn(tag, `GRAVITY REFLEX refused (${pos.x},${pos.y},${pos.z}) — ${live.name} at y=${b.position.y} would not break; the dig would bury the body.`);
      return false;
    }
  }
  return true;
}

// The way back down: the blocks the reflex placed under the body, taken top-down. Each is the block the
// body stands on, so the dig lowers the body one block (lowerSelf). Returns how many came out; the
// descent ends at the first that stays, leaving the column beneath it whole for the body to stand on.
const PILLAR_DESCENT_SETTLE_MS = 250;
async function _descendPillar(bot, placed, tag) {
  let lowered = 0;
  for (let i = placed.length - 1; i >= 0; i--) {
    const b = bot.blockAt(placed[i]);
    if (b && !isAir(b.name) && !(await performDig(bot, b.position, b, tag, { lowerSelf: true }))) {
      watcher.warn(tag, `GRAVITY REFLEX descent stopped at (${b.position.x},${b.position.y},${b.position.z}) — ${b.name} would not clear; ${i + 1} pillar block(s) left standing under the body.`);
      break;
    }
    lowered++;
    await sleep(PILLAR_DESCENT_SETTLE_MS);
  }
  return lowered;
}

// The server takes a swing when the eye is within the block interaction range plus one of the nearest
// point of the block (4.5 + 1 in survival). DIG_REACH sits inside that by the body's own drift between
// two position packets. eyeToBlock is that same measure: eye to the nearest point of the block's cube.
const DIG_REACH = 5.2;
function eyeToBlock(bot, pos) {
  const p = bot?.entity?.position;
  if (!p) return Infinity;
  const ex = p.x, ey = p.y + (bot.entity.eyeHeight || 1.62), ez = p.z;
  const dx = Math.max(pos.x - ex, 0, ex - (pos.x + 1));
  const dy = Math.max(pos.y - ey, 0, ey - (pos.y + 1));
  const dz = Math.max(pos.z - ez, 0, ez - (pos.z + 1));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

async function performDig(bot, pos, block, tag = 'dig_authority', opts = {}) {
  // Refuses air and liquid before swinging (water never resolves via bot.dig()). Returns false ("cell
  // not cleared"), same as every gate below, so every caller inherits this with no edit (Law 16).
  if (!block || isAir(block.name)) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — nothing to dig (air/empty).`);
    return false;
  }
  if (isFluid(block.name)) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} is liquid, not tool-breakable; caller must displace, not dig.`);
    return false;
  }
  // A block the game never breaks (bedrock, barrier) is refused before the swing.
  if (block.diggable === false) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} cannot be broken.`);
    return false;
  }
  // A dig is swung only from inside the server's own reach. The server drops a swing from farther off and
  // sends no correction, while the library has already written air into this body's copy of the world
  // (mineflayer digging: _updateBlockState(pos, 0)) — so the re-sense at the bottom would certify a block
  // that is still standing, and the body would then plan and walk through rock it believes is open.
  const reach = eyeToBlock(bot, pos);
  if (reach > DIG_REACH) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} is ${reach.toFixed(1)} blocks from the body's eye, past the ${DIG_REACH} the server accepts a swing from; the body has to stand closer.`);
    return false;
  }
  // Cells below WORLD_DEPTH_FLOOR_Y are treated as bedrock and refused. A bot already below the floor
  // may still dig, since digging is how it climbs back out.
  if (belowDepthFloor(pos.y) && !belowDepthFloor(bot?.entity?.position?.y ?? pos.y)) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — below the depth floor (y<${WORLD_DEPTH_FLOOR_Y}); that layer is treated as bedrock.`);
    return false;
  }
  // A station is never dug (isUnbreakable, above) — enforced here so nothing can route around it (Law 16/27).
  // opts.ownShaft: the caller is a column trip clearing its own stand shaft, which holds nothing but what the
  // last descent sets, so whatever stands in it comes out.
  if (isUnbreakable(block.name) && opts.ownShaft !== true) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} is a station and stations are never dug: a station is always a blueprint voxel. Whatever wanted this cell must route around it, not through it.`);
    return false;
  }
  // A dig never opens a face onto water: water beside or above the block pours into the hole and makes
  // a flow trap. The same predicate A* reads, so a route never plans a dig this refuses (Law 16).
  if (require('@utils/pathfinding_utils').opensOntoWater(bot, pos.x, pos.y, pos.z)) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} has water beside or above it, or beside the loose column that would fall when it breaks; breaking it would let the water flow.`);
    return false;
  }
  // Ground a working peer has closed is that peer's alone to dig (foreman_link.closeClaimedArea).
  const area = require('@kernel/foreman_link').peerAreaAt(pos.x, pos.y, pos.z);
  if (area) {
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} is inside the ground ${area.botId} is working (${area.key}).`);
    return false;
  }
  // A dig never takes the last block holding a body up: the body would fall into the hole. A caller
  // lowering its own body takes its own — locomotion's dig_down, and opts.lowerSelf for a body coming
  // down the column it climbed — onto a solid block directly beneath; a peer's is refused to every caller.
  const held = bodyHeldBy(bot, pos);
  if (held) {
    const lowering = held === 'the body' && (LOCOMOTION_DIG_TAGS.has(tag) || opts.lowerSelf === true);
    const landing = lowering ? bot.blockAt(pos.offset(0, -1, 0)) : null;
    if (!lowering) {
      watcher.summary(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} is the last block holding ${held} up; breaking it would drop ${held === 'the body' ? 'it' : 'them'}.`);
      return false;
    }
    if (!landing || landing.boundingBox !== 'block') {
      watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} holds the body up and ${landing ? landing.name : 'an unloaded cell'} is beneath it; the body would drop more than one block.`);
      return false;
    }
  }
  const lander = peerLandingOn(bot, pos);
  if (lander) {
    watcher.summary(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — ${block.name} is the block ${lander} lands on stepping down; breaking it would drop them two.`);
    return false;
  }
  // Spawn protection has no separate check: protected cells already read as bedrock fleet-wide
  // (spawn_protection.maskWorldReads), so they're refused above.
  //
  // NO DIG WHILE BOBBING, FOR ANY CALLER. A body afloat was not meant to be digging: a plan that put it
  // there has already failed, or something knocked it in. The signal is dropped and the brain plans again
  // from where the body is; getting out of the water is the pathfinder's work (water_exit, then
  // water_bank_out), never this primitive's.
  //
  // THE LEAF REFLEX IS THE ONE DIG MADE AFLOAT. The pathfinder reads a loose leaf as air, so a route runs
  // straight through one; the reflex takes it out of the body's way in a moment and the body is where it
  // was. Its tag names it, and it can only ever be handed a loose leaf (leaf_authority.isPhantom).
  if (tag !== LEAF_REFLEX_TAG && bobbing(bot)) {
    const at = bot.entity.position.floored();
    watcher.warn(tag, `dig refused at (${pos.x},${pos.y},${pos.z}) — the body is bobbing in water at (${at.x},${at.y},${at.z}); no dig is made afloat. Signal dropped, replanning.`);
    require('@utils/signal_utils').routeToJudge('dig_authority', { readable: `dig_authority: ${tag} asked to dig while bobbing — replanning` });
    return new Promise(() => {});
  }
  // ── combat checkpoint ──
  // Lets a threat interrupt before the equip+swing span. No-op once battle_stations already holds the
  // body; on a real threat it abandons this caller to recursive_judge (Law 15), so it is awaited.
  await require('@api/battle_stations').combatCheckpoint(bot, `dig:${tag}`);

  // Survival check before every swing: sand or gravel resting on this block that would fall into the
  // body is dug first, out of the caller's sight (Law 17), the way a body in water treads it.
  const falling = fallingOntoBody(bot, pos);
  if (falling && !(await clearFallingAbove(bot, pos, falling, tag))) return false;

  // Unguarded on purpose: equipBestToolForBlock already boundaries its own calls, so a throw here is a real defect, not one to swallow (Law 13).
  if (opts.equip !== 'none') await equipBestToolForBlock(bot, block, tag);

  // Only the aim is boundary-guarded; the verdict below comes from re-sensing, not from the dig call.
  if (!(await guardExternal(tag, `lookAt dig target (${pos.x},${pos.y},${pos.z})`, () => bot.lookAt(pos.offset(0.5, 0.5, 0.5)))).ok) return false;
  // The item book reads the pocket round the swing (a tool that breaks leaves it here) and is told the
  // cell that opened, which is how it knows a fleet-placed block came back out.
  const book = require('@kernel/item_book');
  await book.open();
  await digBounded(bot, block, tag);                 // bounded — never hang the signal on one cell
  await sleep(100);                                  // let a server-side revert (rejected break) land
  await book.close('dig', 'worn_out', undefined, false);
  const after = bot.blockAt(pos);
  if (!after || after.name === 'air' || after.boundingBox === 'empty') {
    book.report({ k: 'd', c: [pos.x, pos.y, pos.z] });
    // A block taken out of the downloaded building's box is said with who took it and from where, so a
    // built block that goes missing has a named digger. The climb's own filler is left out.
    const box = block.name === 'dirt' ? null : require('@kernel/downloaded_plan_registry').closedBox();
    if (box && pos.x >= box.min.x && pos.x <= box.max.x && pos.y >= box.min.y && pos.y <= box.max.y && pos.z >= box.min.z && pos.z <= box.max.z) {
      const me = bot.entity.position;
      watcher.summary(tag, `DUG_INSIDE_BUILD ${block.name} at (${pos.x},${pos.y},${pos.z}) body=(${Math.floor(me.x)},${Math.floor(me.y)},${Math.floor(me.z)})`);
    }
    return true;
  }
  watcher.warn(tag, `Dig did not take at (${pos.x},${pos.y},${pos.z}): ${after.name} still solid after dig — unaccepted break (out of reach / obstructed).`);
  return false;
}

module.exports = {
  ensureNoOpenWindow,
  performDig,
  bobbing,
  isUnbreakable,
};
