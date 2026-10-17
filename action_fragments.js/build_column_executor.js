// fragment: build_column_executor (action / downloaded-building site works)
// purpose: ONE verb — work one ANCHOR CUBE of a downloaded building from beneath: get under its column, pillar up
//          the column's stand shaft, dig every block in the cube that is not the plan's and place every block
//          that is, and come back down (Law 0). On the trip that finishes the column, the way down also
//          restores the shaft itself.
//
// ── THE ONLY WAY IN IS FROM UNDERNEATH ──────────────────────────────────────────────────────────────
// A downloaded building's box is solid to navigation once its trees are down (downloaded_plan_registry
// .closedBox): no door, no window, no opening is an entrance, and no route may pass through it. A body is
// sent to the cell directly beneath the column's stand; navigation reaches it by its own route, a stair
// from the surface and a tunnel under the box. What that leaves under the building IS the basement;
// nothing here draws one.
//
// ── ONE CUBE, THEN DOWN AND OUT ─────────────────────────────────────────────────────────────────────
// The body rises on trash filler (utils/trash) through the stand shaft, works the one cube it was given from
// the cube's stand, then digs its filler back out beneath its feet to the entry cell and leaves to bank
// what it dug. The next cube in the column is a new trip, by whoever the board gives it to.
//
// ── THE CUBE OWNS EVERY CELL IN IT, AIR INCLUDED ────────────────────────────────────────────────────
// `targetsOf` (the assessor's, so the gate and the work ask one question — Law 16) lists every cell of the cube
// inside the box except the stand shaft, each with the plan's block or null for air. A cell holding anything
// other than its target is dug; a cell with a block target is then placed. Natural ground standing where the
// building has a room is simply the wrong block in an air cell.
//
// ── THE SHAFT IS RESTORED ONCE, ON THE COLUMN'S LAST DESCENT ────────────────────────────────────────
// The stand shaft is the body's only way in and out, so its own blueprint blocks are not placed on the way up,
// which would seal the next trip out. Once every cube of the column stands as the plan asks, the descent after
// this cube places each shaft block above the body's head as it digs the filler out from under its feet, top
// down, so the block placed last is the attach face for the next.
//
// ── AN INTERRUPTED TRIP IS RESUMED, NOT REPAIRED ────────────────────────────────────────────────────
// A body that drops out mid-cube leaves filler in the shaft and a half-worked cube. The next dispatch reads both
// off the world: it climbs the existing filler, skips every cell already right, and carries on (Invariant B).

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const locomotion = require('@locomotion/locomotion_dispatcher');
const portableJudge = require('@kernel/portable_judge');
const planRegistry = require('@kernel/downloaded_plan_registry');
const { trashPath, keyOf } = require('@kernel/cube_trash_path');
const trash = require('@utils/trash');
const { repairAtAnchor, findAttachable, reachFromStand } = require('@api/anchored_repair');
const { findAim, clickCells } = require('@utils/movement/facing_aim');
const { BLOCK_REACH } = require('@utils/fragment_utils');
const { performDig } = require('@utils/movement/dig_authority');
const { performPlace } = require('@utils/movement/place_authority');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { isAir } = require('@utils/movement/terrain_predicates');
const { itemsFor } = require('@kernel/blueprint_importer');
const { combatCheckpoint } = require('@api/battle_stations');
const { collectNearby } = require('@api/drop_collector');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const { claimFirst, releaseTarget } = require('@utils/target_claims');

const TAG = 'build_column_executor';

// A CLIMB THAT FAILS ON THE SAME CUBE, TRIP AFTER TRIP, IS AN ERROR. Each failed climb spends the next of
// the foreman's once-only 'climb_stall:' keys for that cube, so the key a body is granted is the crew's count
// of failed climbs on it, whichever bodies made them. A built cube ends its count, since its keys are never
// asked for again. The body granted the STALL_LIMIT-th key raises the error. A body with no foreman is the
// whole crew, and its own count is the count.
const STALL_LIMIT = 5;
const _stallsHere = new Map();   // cube key → highest count this body was granted or saw spent
async function countClimbStall(structure, column, cube) {
  const base = `climb_stall:${structure}:${column}:${cube}`;
  const link = require('@kernel/foreman_link');
  for (let n = (_stallsHere.get(base) || 0) + 1; n <= STALL_LIMIT; n++) {
    _stallsHere.set(base, n);
    const grant = await link.requestClaim(`${base}:${n}`);
    if (!grant.granted) continue;
    link.releaseClaim(`${base}:${n}`);   // out of this body's chair; the foreman keeps it spent
    return n;
  }
  return null;   // the limit was already reached and reported
}

// A pillar step that does not rise is retried inside `pillarStep`; this bounds the whole ascent, so a
// column that cannot be climbed reports instead of looping.
const MAX_RISE_STEPS = 64;
// How many more times a refused descent is asked before the trip ends with the body where it stands.
const DESCENT_RETRIES = 3;
// What a trash path pays to stand a block in a cell, by what the cell is for. The plan's own block is work
// the cube owes anyway; trash is a block from the pocket that also comes back out; a cell whose own block
// cannot go in yet, or the cell of the very block the path serves, is trash that is dug out mid-cube as well.
// A cell of a neighbouring cube costs more than the same cell at home, so a path leaves the cube only when
// the cube itself offers nothing cheaper: the neighbour's own plan block is a final block placed early, and
// trash there is trash a peer may meet before it comes back out.
const PRICE_PLAN_BLOCK = 1;
const PRICE_NEIGHBOUR_BLOCK = 2;
const PRICE_TRASH = 3;
const PRICE_WAITING_CELL = 4;
const PRICE_OWN_CELL = 5;
const PRICE_NEIGHBOUR_TRASH = 6;
// How many cells past the cube's own faces a path may use. The stand's reach is the real bound; this
// only sizes the box the reach test is asked over.
const NEIGHBOUR_MARGIN = 2;
// How many refused places a block is given inside one cube before the trip leaves it for the next.
const PLACE_TRIES = 2;

async function routeIdle(reason) {
  watcher.summary(TAG, 'JOB_RESULT produced=false');      // the trip moved no block (accounting_lens waste)
  const verdict = await portableJudge.checkpoint(TAG, `idle: ${reason}`, 'forgiving');
  if (verdict === false) return;
  watcher.summary(TAG, reason);
  require('@thinking/dispatcher.js').clearMagnet();
  routeSignal(TAG, 'idle_park', { readable: `${TAG}: ${reason} → idle_park` });
}

// itemFor — which ITEM places this block. One answer, from the importer that already had to decide it to
// count the bill of materials (Law 16): a wall sign is placed from a sign, a double slab costs two slabs,
// a door's upper half costs nothing. An item name the server does not have comes back with a marker in
// it, so a plan the fleet cannot build is refused before it is attempted.
function itemFor(bot, block, state) {
  const mc = require('minecraft-data')(bot.version);
  const items = itemsFor(block, state, mc);
  if (!items.length) return null;                      // the other half of a two-cell piece — comes free
  const name = items[0][0];
  return name.includes(' ') ? null : name;
}

// correctAlready — does this cell already hold its target, state and all? Null target = air. The cheap test
// that makes a resumed cube skip finished work instead of re-placing it.
function correctAlready(bot, frame, pos, v) {
  const at = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
  if (!at || !at.name) return false;
  if (!v) return isAir(at.name);
  return frame.holds(v, at);
}

// riseTo — climb the stand shaft to a feet height, standing trash (utils/trash) under the body. pillarStep digs
// the two cells over the head before each jump, so the climb goes through whatever stands in the shaft — natural
// ground below the building, trash a previous trip left — and the shaft needs no clearing of its own.
// THE CLIMB'S TRASH IS IN THE CUBE'S PRICE (assessors/downloaded_build.trashOf) and column_preparation leaves
// only with it whole, so a body with no block for its next step was stocked wrong: that stops the run (Law 13).
// ── WHAT THE TRIP STILL OWES IS NOT TRASH ───────────────────────────────────────────────────────────
// A trip carries its cube's blocks and its trash in one pocket, and where the cube is built of the wood the
// trash is made of they are the same items. `_owed` answers, off the world, what the trip's own cells still
// ask for — { item: count } — and every trash block this file takes is taken past it (utils/trash.inHand).
// The cells are the ones the yard stocked the pocket for (downloaded_build.tripCells) and the fold to items is
// the one the yard priced them with (materialsOf), so the trip and the yard count one pocket one way (Law 16).
let _owed = () => ({});
function tripOwes(bot, frame, cells) {
  const { materialsOf } = require('@thinking/assessors/downloaded_build');
  // A cell of the trip turns correct when this body places into it, which changes the pocket: the answer is
  // read off the world again whenever the pocket has changed and is the last one read until then.
  let pocketWas = null;
  let answer = {};
  _owed = () => {
    const pocketNow = bot.inventory.items().map(i => `${i.slot}:${i.type}:${i.count}`).join('|');
    if (pocketNow !== pocketWas) {
      pocketWas = pocketNow;
      answer = materialsOf(bot, frame, cells.filter(c => c.whatever || !correctAlready(bot, frame, frame.worldOf(c.b[0], c.b[1], c.b[2]), c.v)));
    }
    return answer;
  };
}
const trashInHand = (bot, wood) => trash.inHand(bot, wood, _owed());
const keptInHand = (bot, wood) => trash.keptInHand(bot, wood, _owed());
// The trip's trash as utils/trash counts it, past what the trip still owes: `ready` is what can be stood now.
const pocketOf = (bot) => { const counts = {}; for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count; return counts; };
const tripTrash = (bot, wood) => trash.inPocket(pocketOf(bot), _owed(), wood);

async function riseTo(bot, standX, standZ, feetY, wood) {
  for (let step = 0; step < MAX_RISE_STEPS; step++) {
    await combatCheckpoint(bot, 'column');
    const feet = bot.entity.position.floored();
    if (feet.y >= feetY) return { ok: feet.y === feetY, y: feet.y, reason: feet.y === feetY ? null : 'overshot' };
    if (feet.x !== standX || feet.z !== standZ) {
      // Drifted off the shaft — walk back onto it before climbing again. `exact` lands the feet on the cell
      // itself, which the reach arithmetic at every stand assumes.
      const back = await locomotion.goTo({ x: standX, y: feet.y, z: standZ, exact: true, leg: 'work' });
      if (!back?.arrived) return { ok: false, y: feet.y, reason: `drifted off the stand shaft and could not get back (${back?.reason || 'no reason given'})` };
      continue;
    }
    const block = await trashInHand(bot, wood);
    if (!block) {
      // A pocket that still holds trash logs past what the trip owes left the yard before its planks were made:
      // the climb stops here and the trip ends unbuilt, to be stocked again.
      const left = tripTrash(bot, wood);
      if (left.logs > 0) return { ok: false, y: feet.y, reason: `the trip's trash is still ${left.logs} log(s); its planks are made at the yard` };
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): no trash block in the pocket for the climb at y${feet.y} toward y${feetY} in the shaft at (${standX},${standZ}). `
        + `The cube's price carries the climb (downloaded_build.trashOf) and column_preparation gates the trip on it; a body that reaches its shaft short was priced or stocked wrong.`);
    }
    const up = await pillarStep(bot, { candidateItemNames: [block], ownShaft: true });
    if (!up.success) return { ok: false, y: bot.entity.position.floored().y, reason: `pillar stalled: ${up.reason}` };
  }
  return { ok: false, y: bot.entity.position.floored().y, reason: `did not reach ${feetY} in ${MAX_RISE_STEPS} steps` };
}

// workCube — clear and place one anchor cube from its stand, through the SAME stationary primitive
// build_executor and mining_executor use (Law 16). Every owned cell whose world block is not its target is dug;
// every cell with a block target is then placed. repairAtAnchor runs all the digs top-down and then all the
// places bottom-up, so a cleared room is emptied before its floor and walls go in.
async function workCube(bot, frame, anchor, stand, targets) {
  const steps = [];
  let dig = 0;
  const wrong = {};                                      // "found>wanted" → cells, said once per trip below
  const wrongCells = [];                                 // where they are, said when few enough to read
  const hanging = [];                                    // blocks left out because what they hang on is not there
  const { waitsOnSupport } = require('@thinking/assessors/downloaded_build');
  for (const t of targets) {
    const pos = frame.worldOf(t.b[0], t.b[1], t.b[2]);
    if (correctAlready(bot, frame, pos, t.v)) continue;
    const at = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    const block = t.v ? frame.blockOf(t.v[3], t.v[1]) : 'air';
    // A block of the right name in the wrong state is said with the state it shows and the state asked.
    const shows = (at && t.v && at.name === block)
      ? `[${Object.entries(frame.stateOf(t.v[4]) || {}).map(([k, v]) => `${k}=${at.getProperties()[k]}/${v}`).join(' ')}]` : '';
    const pair = `${at?.name || 'unseen'}${shows}>${block}`;
    wrong[pair] = (wrong[pair] || 0) + 1;
    wrongCells.push(`${pos.x}|${pos.y}|${pos.z}`);
    if (at && at.name && !isAir(at.name)) { steps.push({ action: 'dig', place: pos, type: block }); dig++; }
    // A block that hangs on a block no cube has placed yet is left for the trip after that block stands.
    if (await waitsOnSupport(bot, frame, anchor, t)) { hanging.push(`${block}@(${pos.x},${pos.y},${pos.z})`); continue; }
    if (t.v) {
      const state = frame.stateOf(t.v[4]);
      steps.push({ action: 'place', place: pos, type: block, state, block, v: t.v, b: t.b });
    }
  }
  if (hanging.length) watcher.summary(TAG, `CUBE_HANGING_WAIT cube=${anchor.index} n=${hanging.length} blocks=${hanging.slice(0, 8).join(',')}`);
  if (!steps.length) {
    watcher.summary(TAG, `CUBE_FOUND cube=${anchor.index} layer=${anchor.layer} wrong=${hanging.length ? 'hanging_only' : 'none'}`);
    return { dug: 0, placed: 0, failed: 0 };
  }

  const ops = {
    tag: TAG,
    maxPlaceAttempts: 3,
    isOptional: () => false,
    resolveItem: (type) => {
      const name = itemFor(bot, type, null);
      if (!name) return null;
      return bot.inventory.items().some(i => i.name === name && i.count > 0) ? name : null;
    },
    digOne: async (s) => {
      const at = new Vec3(s.place.x, s.place.y, s.place.z);
      const block = bot.blockAt(at);
      // A cell already empty (gravel fell away, a peer dug it) is what the dig was for.
      if (block && block.boundingBox === 'empty' && (block.name === 'air' || block.name === 'cave_air')) return true;
      return performDig(bot, at, block, TAG);
    },
    placeOne: async (s, ev) => {
      // A block a neighbouring cube's trip placed early as its own block's face is already right.
      if (s.v && correctAlready(bot, frame, s.place, s.v)) return 'already';
      const item = itemFor(bot, s.type, s.state);
      if (!item) return 'skipped';                     // the free half of a two-cell piece
      const at = new Vec3(s.place.x, s.place.y, s.place.z);
      const opts = s.state ? { state: s.state, block: s.block } : {};
      const res = await performPlace(bot, at, ev.anchor, ev.face, item, TAG, opts);
      if (!res.ok) {
        s.failReason = res.reason || 'no reason given';
        if (s.state) watcher.summary(TAG, `STATE_PLACE_REFUSED cube=${anchor.index} ${s.type} at (${at.x},${at.y},${at.z}) cell_now=${res.after?.name || 'unseen'} — ${s.failReason}`);
        return false;
      }
      // A wrong facing is not a success wearing one (Law 25). performPlace reports the state it read back
      // separately from whether the cell filled, so the caller decides. Reported false so the next sweep
      // re-offers the cube, which re-reads the cell and replaces it.
      if (res.state && res.state.ok === false) {
        s.failReason = `shows ${JSON.stringify(res.state.got)} not ${JSON.stringify(res.state.wanted)}`;
        watcher.warn(TAG, `Placed ${s.type} at (${at.x},${at.y},${at.z}) but it ${s.failReason}.`);
        return false;
      }
      return true;
    },
  };
  const r = await repairAtAnchor(bot, { stand, steps, label: `cube ${anchor.index}` }, ops);
  // What the ordinary pass left unplaced goes up the escalation, so the trip ends with the cube standing.
  const rescued = await escalate(bot, frame, anchor, stand, steps.filter(st => st.action === 'place'), targets);
  r.place_ok += rescued.placed;
  r.place_fail = rescued.left;
  r.deferred = 0;
  // What the trip found standing wrong and how each place ended (accounting_lens CUBE_FOUND).
  watcher.summary(TAG, `CUBE_FOUND cube=${anchor.index} layer=${anchor.layer} wrong=${Object.entries(wrong).map(([k, n]) => `${k}:${n}`).join(',')} `
    + `place_ok=${r.place_ok} already=${r.already_ok} place_fail=${r.place_fail} dig_fail=${r.dig_fail} deferred=${r.deferred} skipped=${r.skipped} pocket_short=${r.pocket_short}`
    + (wrongCells.length <= 6 ? ` cells=${wrongCells.join(',')}` : ''));
  return { dug: dig - (r.dig_fail || 0), placed: r.place_ok + r.already_ok, failed: r.place_fail + r.dig_fail };
}

// ── A CUBE, ONCE STARTED, IS FINISHED ───────────────────────────────────────────────────────────────
// escalate — every block the ordinary pass left unplaced is given a face by a TRASH PATH: the cheapest chain
// of cells from something standing to the cell whose block serves the click (cube_trash_path), stood one
// block at a time from the standing end. The block then goes in, and every trash block comes back out.
//   THE CUBE FIRST   the path's field is this cube's own empty cells, plus the empty cells of the cubes
//                    beside it that the stand reaches; a neighbour's cell is priced above every cell at
//                    home, so a path leaves the cube only when a block's click lies outside it.
//   THE PLAN'S BLOCK FIRST  a path cell that is where a block of the plan belongs — this cube's or a
//                    neighbour's — takes that block when the pocket holds one to spare and a face serves
//                    it, and trash when not. The path is priced so it prefers such cells.
// This is the one answer to "how does this block get its face" (Law 16); support_plan's plan-time list is
// what the cube's price reads to carry a neighbour's block.
// What trash is and which block is spent first is utils/trash's. A block that falls off when its support
// goes (support_plan.hangs) is never stood on trash that comes back out: it is placed when its real support
// stands, and where that support is a cell no plan owns (outside the box) and nothing stands there, trash is
// stood there and STAYS — cobblestone when the pocket holds one, the trash block otherwise (utils/trash.keptInHand).
// THE TRIP'S TRASH IS IN THE CUBE'S PRICE, sized for every empty cell of the cube (downloaded_build.trashOf),
// so a path the pocket cannot pay for is a trip priced or stocked wrong, and stops the run (Law 13).
// Returns { placed, left } — left counts blocks still not standing, each said by name.
async function escalate(bot, frame, anchor, stand, places, targets) {
  const { hangs } = require('@kernel/support_plan');
  const cellOf = st => new Vec3(st.place.x, st.place.y, st.place.z);
  const standing = st => correctAlready(bot, frame, st.place, st.v);
  const held = st => { const item = itemFor(bot, st.type, st.state); return bot.inventory.items().some(i => i.name === item && i.count > 0); };
  let open = places.filter(st => itemFor(bot, st.type, st.state) && !standing(st));
  if (!open.length) return { placed: 0, left: 0 };
  const start = open.length;
  const notes = new Map(open.map(st => [st, { unserved: new Set(), tries: 0 }]));   // per block: path ends that did not serve, places refused
  const temps = [];                                       // every trash block this trip stood, in order
  const trashPlaced = {};                                 // item → times one was stood; a block stood twice counts twice
  let trashSpared = 0;                                    // cells that took the plan's own block where trash was about to go
  let trashPeak = 0;                                      // the most standing at one moment: what the pocket had to hold
  let pathsWalked = 0;                                    // trash paths stood, whole or cut short
  let pathsCut = 0;                                       // paths a cell stopped part-way, searched again from the world as it then stood
  const refused = new Set();                              // cells that would not take a block this trip: no later path runs through one
  const body = bot.entity.position.floored();
  const reachable = cell => reachFromStand(bot, stand, cell) <= BLOCK_REACH && !(cell.x === body.x && cell.z === body.z);
  const cubeCells = targets.map(t => frame.worldOf(t.b[0], t.b[1], t.b[2])).map(p => new Vec3(p.x, p.y, p.z));
  const targetAt = new Map(targets.map((t, i) => [keyOf(cubeCells[i]), t]));
  // THE CELLS BESIDE THE CUBE: every cell of the building's box within NEIGHBOUR_MARGIN of this cube that is
  // not the cube's own and not in any stand shaft (a shaft is a body's way up and is restored by its descent).
  const dims = planRegistry.dimensions();
  const origin = frame.worldOf(0, 0, 0);
  const shafts = new Set(planRegistry.columns().map(c => `${c.stand[0]},${c.stand[1]}`));
  const ownKeys = new Set(cubeCells.map(keyOf));
  const lo = cubeCells.reduce((m, c) => new Vec3(Math.min(m.x, c.x), Math.min(m.y, c.y), Math.min(m.z, c.z)), cubeCells[0]);
  const hi = cubeCells.reduce((m, c) => new Vec3(Math.max(m.x, c.x), Math.max(m.y, c.y), Math.max(m.z, c.z)), cubeCells[0]);
  const besideCells = [];
  for (let x = lo.x - NEIGHBOUR_MARGIN; x <= hi.x + NEIGHBOUR_MARGIN; x++) {
    for (let y = lo.y - NEIGHBOUR_MARGIN; y <= hi.y + NEIGHBOUR_MARGIN; y++) {
      for (let z = lo.z - NEIGHBOUR_MARGIN; z <= hi.z + NEIGHBOUR_MARGIN; z++) {
        const b = [x - origin.x, y - origin.y, z - origin.z];
        if (b[0] < 0 || b[1] < 0 || b[2] < 0 || b[0] >= dims.w || b[1] >= dims.h || b[2] >= dims.l) continue;
        const cell = new Vec3(x, y, z);
        if (ownKeys.has(keyOf(cell)) || shafts.has(`${b[0]},${b[2]}`)) continue;
        besideCells.push(cell);
      }
    }
  }
  const beside = new Set(besideCells.map(keyOf));
  // neighbourBlock — the plan's own block for a cell beside the cube when it is one a path may stand early:
  // a full, stateless block that does not hang. { v, block, item } or null (plan air, or a block trash stands in for).
  const planAt = planVoxels();
  const neighbourBlock = (cell) => {
    const v = planAt.get(`${cell.x - origin.x},${cell.y - origin.y},${cell.z - origin.z}`);
    if (!v) return null;
    const block = frame.blockOf(v[3], v[1]);
    const state = frame.stateOf(v[4]);
    if ((state && Object.keys(state).length) || hangs(block, state)) return null;
    const data = bot.registry.blocksByName[block];
    if (!data || data.boundingBox !== 'block') return null;
    const item = itemFor(bot, block, null);
    return item ? { v, block, item } : null;
  };
  // A neighbour's block is spent only out of what the pocket holds past this cube's own open blocks.
  const spare = (item) => tripTrash(bot, frame.wood).past[item] || 0;
  const neighbourPlaced = {};                             // block → neighbours' own blocks this trip stood early
  // What the pocket can stand as trash right now (utils/trash), less the planks and logs this cube's own open
  // blocks are still to be placed from.
  const trashHeld = () => tripTrash(bot, frame.wood).ready;
  const trashItem = () => trashInHand(bot, frame.wood);
  // THE PLAN'S OWN BLOCK BEFORE TRASH: a cell that is one of this cube's open blocks takes that block when a
  // face already serves it, and trash only when it does not.
  const ownerOf = cell => open.find(st => st.place.x === cell.x && st.place.y === cell.y && st.place.z === cell.z);
  // standCell — one path cell filled: 'stood', 'standing' (something is there already), or why it was not.
  // `keep` stands the support of a block that hangs, which stays (utils/trash.keptInHand): never dug back out.
  let kept = 0;                                           // supports stood to stay
  const standCell = async (cell, keep = false) => {
    const here = bot.blockAt(cell);
    if (!here || !isAir(here.name)) return 'standing';
    const owner = ownerOf(cell);
    if (owner && !hangs(owner.block, owner.state) && held(owner) && clickable(owner) && await placeFinal(owner)) { trashSpared++; return 'stood'; }
    const face = findAttachable(bot, cell);
    if (!face) return 'no_face';
    const theirs = beside.has(keyOf(cell)) ? neighbourBlock(cell) : null;
    if (theirs && spare(theirs.item) > 0) {
      const put = await performPlace(bot, cell, face.anchor, face.face, theirs.item, TAG, {});
      watcher.summary(TAG, `NEIGHBOUR_BLOCK cube=${anchor.index} ${theirs.block} at (${cell.x},${cell.y},${cell.z}) ok=${!!put.ok}${put.ok ? '' : ` reason=${put.reason}`}`);
      if (put.ok) { neighbourPlaced[theirs.block] = (neighbourPlaced[theirs.block] || 0) + 1; trashSpared++; return 'stood'; }
    }
    const item = keep ? keptInHand(bot, frame.wood) : await trashItem();
    if (!item) return 'no_trash';
    const put = await performPlace(bot, cell, face.anchor, face.face, item, TAG, {});
    if (!put.ok) return 'refused';
    if (keep) { kept++; return 'stood'; }
    temps.push(cell);
    trashPlaced[item] = (trashPlaced[item] || 0) + 1;
    trashPeak = Math.max(trashPeak, temps.length);
    return 'stood';
  };
  const clickable = st => (st.state ? findAim(bot, cellOf(st), st.block, st.state).ok : !!findAttachable(bot, cellOf(st)));
  const placeFinal = async (st) => {
    const at = cellOf(st);
    const item = itemFor(bot, st.type, st.state);
    if (!bot.inventory.items().some(i => i.name === item)) { st.failReason = `pocket holds no ${item}`; return false; }
    const face = findAttachable(bot, at);
    if (!face || !clickable(st)) {
      const aim = st.state ? findAim(bot, at, st.block, st.state) : null;
      st.failReason = 'no face to click: ' + (!face ? 'no solid block beside the cell in reach' : aim && !aim.ok ? aim.reason : 'unknown')
        + ` eye_to_cell=${reachFromStand(bot, stand, at).toFixed(2)}`;
      return false;
    }
    const res = await performPlace(bot, at, face.anchor, face.face, item, TAG, st.state ? { state: st.state, block: st.block } : {});
    if (!res.ok || (res.state && res.state.ok === false)) { st.failReason = res.reason || 'wrong state'; return false; }
    return true;
  };

  // A cell that holds this trip's own trash is opened for the block that belongs in it.
  const openOwnCell = async (st) => {
    const at = cellOf(st);
    const i = temps.findIndex(c => c.equals(at));
    if (i < 0) return true;
    if (!(await performDig(bot, at, bot.blockAt(at), TAG))) { st.failReason = 'trash in its cell would not dig'; return false; }
    temps.splice(i, 1);
    return true;
  };

  // planFor — the cheapest trash path that gives this block its face, read off the world as it stands now, or
  // why there is none. A plain block's path ends in its own cell, which takes the block itself; a state
  // block's path ends in a cell whose block serves the click that gives the state.
  const planFor = (st) => {
    const own = cellOf(st);
    // THE FIELD: this cube's cells and the cells beside it that are empty, in reach, and have refused nothing this trip.
    const field = new Map();
    for (const cell of [...cubeCells, ...besideCells]) {
      const here = bot.blockAt(cell);
      if (here && isAir(here.name) && reachable(cell) && !refused.has(keyOf(cell))) field.set(keyOf(cell), cell);
    }
    const ends = st.state ? clickCells(bot, own, st.block, st.state) : [own];
    const starts = ends.filter(cell => field.has(keyOf(cell)) && !notes.get(st).unserved.has(keyOf(cell)));
    if (!starts.length) return { why: st.state ? 'no cell that serves its click is an empty cell in reach, in this cube or beside it' : 'its cell is not an empty cell in reach' };
    const priceOf = (cell) => {
      if (cell.equals(own)) return st.state ? PRICE_OWN_CELL : 0;
      if (beside.has(keyOf(cell))) {
        const theirs = neighbourBlock(cell);
        return theirs && spare(theirs.item) > 0 ? PRICE_NEIGHBOUR_BLOCK : PRICE_NEIGHBOUR_TRASH;
      }
      const owner = ownerOf(cell);
      if (!owner) return PRICE_TRASH;
      return !owner.state && !hangs(owner.block, owner.state) && held(owner) ? PRICE_PLAN_BLOCK : PRICE_WAITING_CELL;
    };
    const path = trashPath({ starts, field, costOf: priceOf, attachesNow: cell => !!findAttachable(bot, cell) });
    if (!path) return { why: 'no chain of empty cells in reach joins it to anything standing' };
    const walk = path.cells.filter(cell => st.state || !cell.equals(own));
    const needed = walk.filter(cell => ![PRICE_PLAN_BLOCK, PRICE_NEIGHBOUR_BLOCK].includes(priceOf(cell))).length;
    const have = trashHeld();
    if (needed > have) {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): cube ${anchor.index} needs ${needed} more trash block(s) to give ${st.block} at (${own.x},${own.y},${own.z}) a face, `
        + `and the pocket holds ${have} with ${temps.length} already standing. The cube's price carries a trash block for every empty cell (downloaded_build.trashOf) and `
        + `column_preparation gates the trip on it; a body short at the cube was priced or stocked wrong.`);
    }
    return { path, walk, trash: needed };
  };

  // ROUND BY ROUND, each read fresh off the world (Invariant B): every block a face serves goes in, then the
  // cheapest trash path among the blocks still without a face is stood. Trash stays where it stands until
  // the cube is done, so a later block's path starts from it. The round bound is the loop's judge (Law 11).
  open.sort((a, b) => a.place.y - b.place.y);
  const wanted = st => !standing(st) && !hangs(st.block, st.state) && notes.get(st).tries < PLACE_TRIES;
  const maxRounds = 2 * cubeCells.length + PLACE_TRIES * open.length;
  const pace = require('@utils/execution_yield').makeExecutionPacer({ bot, source: 'column' });
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    await combatCheckpoint(bot, 'column');
    for (let grew = true; grew;) {
      grew = false;
      for (const st of open) {
        if (!wanted(st)) continue;
        // No trash is stood for a block the pocket does not hold: there is nothing to place on it.
        if (!held(st)) { st.failReason = `pocket holds no ${itemFor(bot, st.type, st.state)}`; continue; }
        if (!clickable(st)) continue;
        if (await openOwnCell(st) && await placeFinal(st)) grew = true;
        else notes.get(st).tries++;
      }
    }
    let next = null;
    for (const st of open) {
      if (!wanted(st) || !held(st) || clickable(st)) continue;
      // One block's path search is one unit of work; the body's own clock runs between two of them, so a cube
      // with every block waiting on a face does not hold the body still past the server's patience.
      await pace();
      const plan = planFor(st);
      if (!plan.path) { st.failReason = `no trash path: ${plan.why}`; continue; }
      if (!next || plan.path.cost < next.plan.path.cost) next = { st, plan };
    }
    if (!next) break;

    const { st, plan } = next;
    pathsWalked++;
    let stood = 0;
    let cut = null;
    for (const cell of plan.walk) {
      await combatCheckpoint(bot, 'column');
      const how = await standCell(cell);
      if (how === 'stood') stood++;
      else if (how !== 'standing') { cut = { cell, how }; break; }
    }
    watcher.summary(TAG, `TRASH_PATH cube=${anchor.index} for=${st.block}@(${st.place.x},${st.place.y},${st.place.z}) cells=${plan.walk.length} trash_priced=${plan.trash} `
      + `price=${plan.path.cost} stood=${stood} cut=${cut ? `${cut.how}@(${cut.cell.x},${cut.cell.y},${cut.cell.z})` : 'none'}`);
    if (cut) {
      pathsCut++;
      // A cell that stopped the path with nothing else changed is closed to later paths, so no search returns
      // the same path twice. A path cut after it stood a block is searched again from what now stands.
      if (cut.how === 'refused' || stood === 0) refused.add(keyOf(cut.cell));
      continue;
    }
    // A path stood whole whose end cell still gives the block no click: that end is not asked for again.
    if (!clickable(st)) notes.get(st).unserved.add(keyOf(plan.path.cells[plan.path.cells.length - 1]));
  }
  if (rounds >= maxRounds) watcher.warn(TAG, `TRASH_PATH cube=${anchor.index} stopped at its bound of ${maxRounds} rounds with blocks still open.`);

  // PHASE TWO — every trash block comes back out, last stood first. A cell whose standing block is the block
  // the plan asks for there is the building's, whatever it was stood as.
  let stuck = 0;
  for (const cell of temps.reverse()) {
    const here = bot.blockAt(cell);
    if (!here || !trash.isTrashBlock(here.name)) continue;
    const target = targetAt.get(keyOf(cell));
    if (target && target.v && correctAlready(bot, frame, cell, target.v)) continue;
    const theirs = beside.has(keyOf(cell)) ? neighbourBlock(cell) : null;
    if (theirs && correctAlready(bot, frame, cell, theirs.v)) continue;
    if (!(await performDig(bot, cell, here, TAG))) stuck++;
  }
  // A block that hangs goes in last, on whatever of the plan now stands beside it. Where nothing does and its
  // support is a cell no plan owns (outside the building's box), trash is stood there and stays (standCell keep).
  const { supportCells } = require('@kernel/support_plan');
  const ownedByPlan = c => c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < dims.w && c[1] < dims.h && c[2] < dims.l;
  for (const st of open) {
    if (standing(st) || !hangs(st.block, st.state)) continue;
    if (!clickable(st) && st.b) {
      for (const c of supportCells(st.b, st.block, st.state) || []) {
        if (ownedByPlan(c)) continue;
        const cell = new Vec3(origin.x + c[0], origin.y + c[1], origin.z + c[2]);
        if (!reachable(cell)) continue;
        const how = await standCell(cell, true);
        watcher.summary(TAG, `KEPT_SUPPORT cube=${anchor.index} for=${st.block}@(${st.place.x},${st.place.y},${st.place.z}) at=(${cell.x},${cell.y},${cell.z}) how=${how}`);
        if (clickable(st)) break;
      }
    }
    if (clickable(st)) await placeFinal(st);
  }

  const left = open.filter(st => !standing(st));
  watcher.summary(TAG, `CUBE_ESCALATED cube=${anchor.index} unplaced_after_pass=${start} left=${left.length} paths=${pathsWalked} paths_cut=${pathsCut} cells_refused=${refused.size} trash_stood=${temps.length} trash_stuck=${stuck} `
    + `trash_placed=${Object.values(trashPlaced).reduce((n, c) => n + c, 0)} trash_kept=${kept} trash_peak=${trashPeak} trash_spared=${trashSpared} trash_left_in_pocket=${trashHeld()} `
    + `trash_items=${Object.entries(trashPlaced).map(([item, n]) => `${item}:${n}`).join(',') || 'none'} `
    + `trash_beside=${temps.filter(cell => beside.has(keyOf(cell))).length} neighbour_blocks=${Object.entries(neighbourPlaced).map(([block, n]) => `${block}:${n}`).join(',') || 'none'}`);
  // One line per cube: the blocks left out, grouped by block and by why, with the first cell of each group.
  const groups = new Map();
  for (const st of left) {
    const why = st.failReason || 'waits on the block it hangs from';
    const key = `${st.block}|${why}`;
    const g = groups.get(key) || { block: st.block, why, n: 0, at: st.place };
    g.n++;
    groups.set(key, g);
  }
  if (groups.size) {
    watcher.warn(TAG, `CUBE_BLOCKS_NOT_STANDING cube=${anchor.index} left=${left.length}: `
      + [...groups.values()].map(g => `${g.block}x${g.n} first at (${g.at.x},${g.at.y},${g.at.z}) — ${g.why}`).join('; '));
  }
  return { placed: start - left.length, left: left.length };
}

// planVoxels — every block of the plan by its blueprint cell, 'x,y,z' → [x, y, z, name, state]. Read off the
// loaded plan once; the plan does not change while a run lives.
let _planVoxels = null;
function planVoxels() {
  if (_planVoxels) return _planVoxels;
  _planVoxels = new Map();
  for (const a of planRegistry.anchors()) for (const v of a.voxels) _planVoxels.set(`${v[0]},${v[1]},${v[2]}`, v);
  return _planVoxels;
}

// shaftSupport — a shaft block that must be clicked onto a particular neighbour (a trapdoor, a stair) when that
// neighbour is air: a trash block is stood in an empty cell beside it until the click that gives the wanted
// state exists, and its position is returned so the caller digs it back out once the block is placed. The
// cell below is left alone: it is the shaft's own next cell. Returns the temp position, or null.
async function shaftSupport(bot, at, block, state, wood) {
  if (!state || findAim(bot, at, block, state).ok) return null;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const cell = at.offset(dx, dy, dz);
    const here = bot.blockAt(cell);
    if (!here || !isAir(here.name)) continue;
    const face = findAttachable(bot, cell);
    if (!face) continue;
    const item = await trashInHand(bot, wood);
    if (!item) return null;
    const put = await performPlace(bot, cell, face.anchor, face.face, item, TAG, {});
    if (!put.ok) continue;
    if (findAim(bot, at, block, state).ok) {
      watcher.summary(TAG, `SHAFT SUPPORT temp ${item} at (${cell.x},${cell.y},${cell.z}) for ${block} at (${at.x},${at.y},${at.z})`);
      return cell;
    }
    await performDig(bot, cell, bot.blockAt(cell), TAG);
  }
  return null;
}

// shaftProp — a shaft cell with air on every side gets a column of trash stood beside it, from the first
// height that has a face to click (the block under the feet gives one) up to the cell's own height, so the
// cell has a neighbour. Returns the trash cells bottom first, for the caller to dig out once the block is in.
async function shaftProp(bot, at, wood) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let base = null;
    for (let y = at.y; y >= at.y - 4 && base === null; y--) {
      const cell = new Vec3(at.x + dx, y, at.z + dz);
      const here = bot.blockAt(cell);
      if (!here || !isAir(here.name)) break;
      if (findAttachable(bot, cell)) base = y;
    }
    if (base === null) continue;
    const stood = [];
    for (let y = base; y <= at.y; y++) {
      const cell = new Vec3(at.x + dx, y, at.z + dz);
      const face = findAttachable(bot, cell);
      const item = face ? await trashInHand(bot, wood) : null;
      const put = item ? await performPlace(bot, cell, face.anchor, face.face, item, TAG, {}) : { ok: false };
      if (!put.ok) break;
      stood.push(cell);
    }
    if (findAttachable(bot, at)) {
      watcher.summary(TAG, `SHAFT PROP ${stood.length} trash beside (${at.x},${at.y},${at.z}) from y${base}`);
      return stood;
    }
    for (const cell of stood.reverse()) await performDig(bot, cell, bot.blockAt(cell), TAG);
  }
  return [];
}

// restoreShaft — the column's last descent, top down over the whole shaft: bring the feet two below the
// cell, dig whatever stands in it that is not its target, place the plan's block if it has one. The cell
// is always at least two above the feet, so the body is never in it, and the block placed last is the
// attach face for the next.
async function restoreShaft(bot, frame, shaft, standX, standZ, waiters = []) {
  let placed = 0, failed = 0;
  for (const t of shaft) {                             // top first (assessor's shaftTargets)
    await combatCheckpoint(bot, 'column');
    const pos = frame.worldOf(t.b[0], t.b[1], t.b[2]);
    // Every shaft cell under the feet holds the filler the body climbed on, and the descent digs it out: a
    // cell there is never standing already, whatever the filler happens to match.
    if (pos.y >= bot.entity.position.floored().y && correctAlready(bot, frame, pos, t.v)) continue;

    if (bot.entity.position.floored().y > pos.y - 2) {
      const down = await locomotion.descendColumn({ x: standX, z: standZ, toFeetY: pos.y - 2 });
      if (!down?.arrived) {
        failed++;
        watcher.warn(TAG, `Descent stalled at feet y${down?.y} heading for y${pos.y - 2} (${down?.reason || 'no reason given'}) — shaft left open.`);
        break;                                          // a stalled descent cannot be worked around from here
      }
    }
    const at = new Vec3(pos.x, pos.y, pos.z);
    const standing = bot.blockAt(at);
    if (standing && standing.name && !isAir(standing.name) && !await performDig(bot, at, standing, TAG, { ownShaft: true })) {
      failed++;
      watcher.warn(TAG, `Descent dig refused at (${at.x},${at.y},${at.z}) ${standing.name} — the shaft cell keeps what stands in it.`);
      continue;
    }
    if (!t.v) continue;                                 // an air target: clearing it was the whole job

    const block = frame.blockOf(t.v[3], t.v[1]);
    const state = frame.stateOf(t.v[4]);
    const item = itemFor(bot, block, state);
    if (!item) continue;                                // free half of a two-cell piece
    const temp = await shaftSupport(bot, at, block, state, frame.wood);
    let attach = findAttachable(bot, at, block);
    const prop = attach ? [] : await shaftProp(bot, at, frame.wood);
    if (!attach) attach = findAttachable(bot, at, block);
    if (!attach) {
      failed++;
      const around = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]].map(([dx, dy, dz]) => bot.blockAt(at.offset(dx, dy, dz))?.name || 'unseen').join(',');
      watcher.warn(TAG, `Descent place has no attach face at (${at.x},${at.y},${at.z}) ${block} — beside it (e,w,s,n,below,above): ${around}; held ${item}: ${bot.inventory.items().some(i => i.name === item)}`);
      continue;
    }
    const res = await performPlace(bot, at, attach.anchor, attach.face, item, TAG, state ? { state, block } : {});
    for (const cell of prop.reverse()) await performDig(bot, cell, bot.blockAt(cell), TAG);
    if (temp) {
      const out = await performDig(bot, temp, bot.blockAt(temp), TAG);
      watcher.summary(TAG, `SHAFT SUPPORT temp removed at (${temp.x},${temp.y},${temp.z}) ok=${!!out}`);
    }
    if (res.ok && !(res.state && res.state.ok === false)) placed++;
    else { failed++; watcher.warn(TAG, `Descent place refused at (${at.x},${at.y},${at.z}) ${block}: ${res.reason || 'wrong state'}`); continue; }
    const beside = await placeOnShaft(bot, frame, waiters, at);
    placed += beside.placed; failed += beside.failed;
  }
  return { placed, failed };
}

// placeOnShaft — the cube blocks that stand only against the shaft block just placed: each empty cell of
// `waiters` beside it is given its plan block, clicked onto that shaft block, from where the descent stands.
async function placeOnShaft(bot, frame, waiters, shaftCell) {
  let placed = 0, failed = 0;
  const anchor = bot.blockAt(shaftCell);
  for (const t of waiters) {
    const pos = frame.worldOf(t.b[0], t.b[1], t.b[2]);
    if (Math.abs(pos.x - shaftCell.x) + Math.abs(pos.y - shaftCell.y) + Math.abs(pos.z - shaftCell.z) !== 1) continue;
    if (correctAlready(bot, frame, pos, t.v)) continue;
    const at = new Vec3(pos.x, pos.y, pos.z);
    const here = bot.blockAt(at);
    if (!here || !isAir(here.name)) continue;
    const block = frame.blockOf(t.v[3], t.v[1]);
    const state = frame.stateOf(t.v[4]);
    const item = itemFor(bot, block, state);
    if (!item) continue;
    const res = await performPlace(bot, at, anchor, at.minus(shaftCell), item, TAG, state ? { state, block } : {});
    const ok = res.ok && !(res.state && res.state.ok === false);
    watcher.summary(TAG, `SHAFT_BESIDE ${block} at (${at.x},${at.y},${at.z}) on shaft (${shaftCell.x},${shaftCell.y},${shaftCell.z}) ok=${ok}${ok ? '' : ` — ${res.reason || 'wrong state'}`}`);
    if (ok) placed++; else failed++;
  }
  return { placed, failed };
}

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before a column pass ran.`);
    }

    const botId = process.env.BOT_ID || 'default';
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    const index = magnet?.column;
    const structure = magnet?.structure;
    if (!Number.isInteger(index) || !Number.isInteger(magnet?.anchor_index) || !structure) {
      return routeIdle('no cube on the magnet — nothing to build');
    }

    const row = hq.readBuildingChair(structure, 'set_buildspot');
    const frame = planRegistry.siteFrame(row);
    const column = planRegistry.columns().find(c => c.column === index);
    const anchor = planRegistry.anchors()[magnet.anchor_index];
    if (!column || !anchor || anchor.column !== index) {
      throw new Error(`[${TAG}] CODING VIOLATION: the board posted column ${index}, cube ${magnet.anchor_index} of "${structure}", which the plan does not have as one cube of that column.`);
    }
    const { targetsOf, shaftTargets, entryFoot, entryMouth, sealable, forgetFinished, tripCells, endsColumn } = require('@thinking/assessors/downloaded_build');
    const foot = entryFoot(frame, column);
    const standX = foot.x, standZ = foot.z;

    // To the building's one mouth at the under-level first, then under the column. Every trip from outside
    // comes down to the same cell, so one staircase serves the fleet and it stands outside the blueprint.
    // Skipped when the body already stands under the box — the last trip ended there.
    const box = planRegistry.closedBox();
    const at = bot.entity.position;
    const underBox = box && at.x >= box.min.x && at.x < box.max.x + 1 && at.z >= box.min.z && at.z < box.max.z + 1 && at.y < box.min.y;
    if (box && !underBox) {
      const mouth = entryMouth(frame);
      const reached = await locomotion.goTo({ x: mouth.x, y: mouth.y, z: mouth.z, exact: true });
      if (!reached?.arrived) {
        return routeIdle(`could not reach the building's mouth at the under-level (${mouth.x},${mouth.y},${mouth.z}) for column ${index}: ${reached?.reason || 'no reason given'}`);
      }
    }

    // UNDER THE COLUMN, at its own x,z, feet two below the box. The route is navigation's: the box is
    // closed to it, and `max_y` keeps the feet at the under-level, so the walk runs beneath the box from the
    // mouth. `exact`, because every later position in this pass is measured from the shaft.
    const entered = await locomotion.goTo({ x: standX, y: foot.y, z: standZ, exact: true, leg: 'work', max_y: foot.y });
    if (!entered?.arrived) {
      return routeIdle(`could not get under column ${index} at (${standX},${foot.y},${standZ}): ${entered?.reason || 'no reason given'}`);
    }

    const standWorld = frame.worldOf(anchor.stand[0], anchor.stand[1], anchor.stand[2]);

    // THE STAND SHAFT IS THIS BODY'S ALONE FOR THE TRIP. The filler it climbs on stands in the entry cell
    // of the under-level, so the shaft is claimed and closed to every peer's route and dig, from the
    // entry cell to the head of the stand, until the body is back down.
    const columnKey = `column:${structure}:${index}`;
    const taken = await claimFirst([column], { keyOf: () => columnKey });
    if (!taken.pick) return routeIdle(`column ${index} is held by a peer working its stand shaft`);
    require('@kernel/foreman_link').closeClaimedArea(columnKey, {
      min: { x: standX, y: foot.y, z: standZ },
      max: { x: standX, y: standWorld.y + 1, z: standZ },
    });

    // Read before the climb: the climb stands the body's filler in the shaft, and a cube that waits on the
    // shaft is told from one that does not by the shaft cell being empty.
    const sealed = new Set();
    for (const i of column.anchors) if (await sealable(bot, frame, column, i)) sealed.add(i);
    const stoodBefore = shaftTargets(column).filter(t => t.v && correctAlready(bot, frame, frame.worldOf(t.b[0], t.b[1], t.b[2]), t.v));
    // The same question column_preparation stocked this pocket on, asked of the world as the trip finds it.
    tripOwes(bot, frame, await tripCells(bot, frame, column, anchor, await endsColumn(bot, frame, column, { anchor, seal: false })));
    const rise = await riseTo(bot, standX, standZ, standWorld.y, frame.wood);
    let work = { dug: 0, placed: 0, failed: 0 };
    let shaftDone = { placed: 0, failed: 0 };
    let columnDone = false;
    if (!rise.ok) {
      // A shaft that cannot be climbed is reported where it stopped. The body still comes back down its own
      // filler below, so the next trip starts from the entry cell like every other.
      watcher.warn(TAG, `Column ${index} stopped at y${rise.y} on the way to cube ${anchor.index} (${rise.reason}).`);
      const stalls = await countClimbStall(structure, index, anchor.index);
      if (stalls === STALL_LIMIT) {
        watcher.error(TAG, `CLIMB STALLED ${STALL_LIMIT} TIMES IN A ROW — column ${index} of "${structure}" cannot reach cube ${anchor.index}: `
          + `the last climb stopped at y${rise.y} (${rise.reason}) at (${standX},${rise.y},${standZ}). The crew has failed this climb `
          + `${STALL_LIMIT} times without building the cube, so the build cannot finish on its own.`);
      }
    } else {
      work = await workCube(bot, frame, anchor, { x: standX, y: standWorld.y, z: standZ }, targetsOf(anchor));
      // EVERY OTHER CUBE OF THE COLUMN IS READ FROM HERE, AND ONE THAT DOES NOT STAND IS THIS BODY'S TO FORGET.
      // The board offers a cube off this body's memory of the finished ones; the body is now in the column and
      // reads them all. A cube found wrong is dropped from that memory, so the next sweep offers it. Where
      // digging is all it needs — a block left standing in a cell the plan keeps empty — it is dug on this trip
      // from its own stand, since no pocket has to be stocked for it.
      const all = planRegistry.anchors();
      let top = standWorld.y;
      for (const i of column.anchors) {
        if (i === anchor.index || sealed.has(i)) continue;
        const open = targetsOf(all[i]).filter(t => !correctAlready(bot, frame, frame.worldOf(t.b[0], t.b[1], t.b[2]), t.v));
        if (!open.length) continue;
        if (!forgetFinished(structure, i)) continue;     // never remembered as finished: a cube still to build, on its own trip
        watcher.summary(TAG, `CUBE_FORGOTTEN column=${index} cubes=${i} at=column open=${open.length} dig_only=${!open.some(t => t.v)}`);
        if (open.some(t => t.v)) continue;
        const other = frame.worldOf(all[i].stand[0], all[i].stand[1], all[i].stand[2]);
        const feet = bot.entity.position.floored().y;
        const there = other.y >= feet
          ? await riseTo(bot, standX, standZ, other.y, frame.wood)
          : await locomotion.descendColumn({ x: standX, z: standZ, toFeetY: other.y }).then(d => ({ ok: !!d?.arrived, reason: d?.reason }));
        if (!there.ok) { watcher.warn(TAG, `Column ${index}: could not reach cube ${i}'s stand at y${other.y} (${there.reason || 'no reason given'}).`); break; }
        top = Math.max(top, other.y);
        const extra = await workCube(bot, frame, all[i], { x: standX, y: other.y, z: standZ }, targetsOf(all[i]));
        work.dug += extra.dug; work.placed += extra.placed; work.failed += extra.failed;
      }
      // Back to the highest stand this trip reached: the descent below works each shaft cell from under it.
      if (bot.entity.position.floored().y < top) await riseTo(bot, standX, standZ, top, frame.wood);
      // The column is done when every cube in it stands — read off the world now, after this cube: a lower
      // cube a block fell into is not done, and sealing the shaft over it would strand the fix behind
      // finished work.
      // A cube whose open cells wait only on this column's shaft is finished by the descent itself (sealable):
      // its open cells are handed to the descent, which sets each one against the shaft block it waits on.
      const waiters = [];
      columnDone = work.failed === 0 && column.anchors.every(i => {
        const open = targetsOf(planRegistry.anchors()[i]).filter(t => !correctAlready(bot, frame, frame.worldOf(t.b[0], t.b[1], t.b[2]), t.v));
        if (!open.length) return true;
        if (!sealed.has(i)) return false;
        waiters.push(...open.filter(t => t.v));
        return true;
      });
      // THE DESCENT WORKS EVERY SHAFT CELL FROM TWO UNDER IT, SO IT STARTS UNDER THE HIGHEST ONE THAT IS OPEN.
      // A trip to a low cube stands far below a shaft cell that fell out higher up; the body climbs to it
      // first where its pocket holds the filler for the steps, and says so where it does not.
      if (columnDone) {
        const openShaft = shaftTargets(column).map(t => ({ t, pos: frame.worldOf(t.b[0], t.b[1], t.b[2]) }))
          .filter(c => c.t.v && !correctAlready(bot, frame, c.pos, c.t.v));
        const under = openShaft.length ? Math.max(...openShaft.map(c => c.pos.y)) - 2 : null;
        const feetY = bot.entity.position.floored().y;
        if (under !== null && under > feetY) {
          const filler = tripTrash(bot, frame.wood).ready;
          if (filler >= under - feetY) {
            const up = await riseTo(bot, standX, standZ, under, frame.wood);
            watcher.summary(TAG, `SHAFT_REACH column=${index} from_y=${feetY} to_y=${under} ok=${up.ok}${up.ok ? '' : ` reason=${up.reason}`}`);
          } else {
            watcher.summary(TAG, `SHAFT_REACH column=${index} from_y=${feetY} to_y=${under} ok=false reason=filler ${filler} of ${under - feetY}`);
          }
        }
        shaftDone = await restoreShaft(bot, frame, shaftTargets(column), standX, standZ, waiters);
      }
      // A TRIP THAT MOVED NO BLOCK LEAVES THE SHAFT AS IT FOUND IT. The climb dug every shaft cell it passed;
      // the ones that stood as the plan asks before it are set back on the way down, from the blocks the dig
      // put in the pocket.
      else if (work.dug === 0 && work.placed === 0 && stoodBefore.length) {
        const back = await restoreShaft(bot, frame, stoodBefore, standX, standZ);
        watcher.summary(TAG, `SHAFT_PUT_BACK column=${index} stood=${stoodBefore.length} placed=${back.placed} failed=${back.failed}`);
      }
    }

    // DOWN AND OUT, every trip. The filler under the feet is dug back into the pocket on the way; the body
    // lands in the entry cell under the box, which is where the next trip starts too.
    // A descent the server refused (a dig that did not land while it was moving the body) is asked again from
    // where the body now stands: a body left up in the box has no route out of it but its own shaft.
    let down = await locomotion.descendColumn({ x: standX, z: standZ, toFeetY: foot.y });
    for (let again = 1; again <= DESCENT_RETRIES && !down?.arrived; again++) {
      watcher.summary(TAG, `DESCENT_RETRY column=${index} try=${again} feet_y=${down?.y} wanted_y=${foot.y} reason=${down?.reason || 'none given'}`);
      await new Promise(res => setTimeout(res, 1000));
      down = await locomotion.descendColumn({ x: standX, z: standZ, toFeetY: foot.y });
    }
    if (!down?.arrived) watcher.warn(TAG, `Could not dig back down to the entry cell (feet y${down?.y}, wanted y${foot.y}): ${down?.reason || 'no reason given'}.`);
    releaseTarget(columnKey);
    await collectNearby(bot);

    // The shape the accounting lens reads — one line per trip, every number in it (Law 5).
    const readable = `${TAG}: column ${index} cube ${anchor.index} layer ${anchor.layer} — dug ${work.dug}, placed ${work.placed}, `
      + `failed ${work.failed}${columnDone ? `, shaft ${shaftDone.placed} placed ${shaftDone.failed} failed` : ''}`
      + `${rise.ok ? '' : `, climb stopped at y${rise.y}`}`;

    if (work.dug === 0 && work.placed === 0 && shaftDone.placed === 0) return routeIdle(`${readable} — nothing done`);

    portableJudge.done(TAG);
    watcher.summary(TAG, readable);
    watcher.summary(TAG, 'JOB_RESULT produced=true');
    const capsule = payload[TAG] || (payload[TAG] = {});
    capsule.success = rise.ok && work.failed === 0 && shaftDone.failed === 0;
    capsule.placed = work.placed;
    capsule.readable = readable;
    payload.readable = readable;

    // The trip's leftover made goods are banked for the next trip, up to what the building still asks for (waste_pit).
    const drop = await require('@api/inventory_swapper').dropOffHaul(bot);
    if (drop?.abandoned) return;
    routeToJudge(TAG, { ...payload, readable });
  }),
};
