'use strict';
// water_escape — THE EMERGENCY WAY OUT OF WATER, for a body trapped there that has proved it.
// Its one caller is the water unit (underwater_swimming: rescue, freeTrapped, ashore), which holds the body for the
// length of each move here, so no swim to air runs under an escape.
//
// Two rules can wall a body in: no dig is made afloat (dig_authority.bobbing), and no dig opens onto water
// (pathfinding_utils.opensOntoWater). A body in a flooded pocket with stone on every side therefore has no
// move at all, and every errand after that fails in place. This is the one move left to it, and the only
// one besides the leaf reflex that dig_authority lets dig afloat or onto water — it admits these digs by
// this module's tag alone (WATER_ESCAPE_TAG).
//
// ── TRAPPED, PROVED BEFORE ANYTHING IS DUG (prove) ──────────────────────────────────────────────────
//   1. in water: the body's feet cell is water, still or running;
//   2. barred from digging: bobbing — water over the head, or no floor under the feet;
//   3. stop_flow has had its turn: the navigator runs it first wherever it applies (running water round a
//      standing body) and names whether it was tried and held or did not apply;
//   4. no ordinary move reaches safety: the navigator's own search, asked for every safe cell within
//      ESCAPE_RADIUS (classifyFloorInline, A*'s one standable dry cell), finds no route — or there is no
//      such cell for it to reach.
// All four are written into the warning, so the record holds the proof beside the act.
//
// ── THE WAY OUT (escape), one move at a time, the world read again after each ───────────────────────
//   A body with no floor under it places blocks below itself until it stands (scaffold_movement's water
//   fill). Where the water is too deep for that, it first swims to the water cell nearest the shore that
//   is shallow enough, and fills there.
//   A body that stands with water over its head digs to the nearest cell where it can stand with its head
//   dry, by the FEWEST digs (planEscape): on a floor, or on water shallow enough to fill under it (often one
//   dig up through the ceiling, since water never flows upward). Between ways that dig the same, the one
//   going with the water's flow is taken, then the shorter. It ends the moment the body is no longer barred from digging: from
//   there the ordinary moves, stop_flow and water_bank_out take it the rest of the way.
// Every act is said as a WATER ESCAPE warning, never a summary.
//
// Returns from escape(): { escaped, steps, digs, reason }.

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { performDig, bobbing, WATER_ESCAPE_TAG } = require('@utils/movement/dig_authority');
const { fillWaterColumnBelow } = require('@utils/movement/scaffold_movement');
const { performPlace } = require('@utils/movement/place_authority');
const { isFluid, waterLevel } = require('@utils/gravity_utils');
const { STATION_TYPES, sleep, BLOCK_REACH } = require('@utils/fragment_utils');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');
const { MinHeap } = require('@utils/min_heap');
const {
  classifyFloorInline, isBlockPassable, isBlockSolid, isFullHeightFloor, opensOntoWater,
} = require('@utils/pathfinding_utils');

const TAG = 'water_escape';
const ESCAPE_RADIUS = 6;        // blocks round the body a safe cell is looked for and an escape dug through
const MAX_STEPS = 16;           // moves one escape may make before it gives up and says so
const MOVE_MS = 4000;           // how long one move into an opened cell is given (a body swims slowly)
const FILL_MS = 6000;           // how long the fill under a floating body is given
const SETTLE_MS = 1500;         // water spreads 1 block per 5 ticks: an opened cell floods within this, so a
                                // move is judged only after it
const DIG_COST = 1000;          // planEscape's price: a dig outweighs any number of moves...
const AGAINST_FLOW_COST = 10;   // ...and a move against the water's flow outweighs a few plain moves
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const MOVES = [...SIDES, [0, 1, 0], [0, -1, 0]];

const at = (p) => `(${p.x},${p.y},${p.z})`;
const keyOf = (p) => `${p.x},${p.y},${p.z}`;

function feetOf(bot) { return bot.entity.position.floored(); }
function inWater(bot) { const b = bot.blockAt(feetOf(bot)); return !!(b && isFluid(b.name) && b.name.includes('water')); }
function floored(bot) { const b = bot.blockAt(feetOf(bot).offset(0, -1, 0)); return !!(b && b.boundingBox === 'block'); }

function touchesLava(bot, p) {
  for (const [dx, dy, dz] of [...MOVES]) {
    const b = bot.blockAt(p.offset(dx, dy, dz));
    if (b && b.name.includes('lava')) return true;
  }
  return false;
}

// safeCells — every floor within ESCAPE_RADIUS a body can stand on dry (classifyFloorInline), as floor Vec3s.
function safeCells(bot) {
  const f = feetOf(bot);
  const out = [];
  for (let dx = -ESCAPE_RADIUS; dx <= ESCAPE_RADIUS; dx++) {
    for (let dy = -ESCAPE_RADIUS; dy <= ESCAPE_RADIUS; dy++) {
      for (let dz = -ESCAPE_RADIUS; dz <= ESCAPE_RADIUS; dz++) {
        const floor = bot.blockAt(f.offset(dx, dy - 1, dz));
        if (floor && classifyFloorInline(bot, floor)) out.push(floor.position.clone());
      }
    }
  }
  return out;
}

// prove(bot, { stopFlow, searchTo }) → { trapped, proof, why }. stopFlow is 'tried_and_held' or
// 'not_applicable'. searchTo(goal) is the navigator's own computeAStar with the trip's options, so "no ordinary
// move" is the same search every route is planned by.
async function prove(bot, { stopFlow, searchTo }) {
  if (stopFlow !== 'tried_and_held' && stopFlow !== 'not_applicable') {
    throw new Error(`[${TAG}] CODING VIOLATION: prove() was asked before stop_flow had its turn (stopFlow=${stopFlow}).`);
  }
  const f = feetOf(bot);
  const feetBlock = bot.blockAt(f);
  if (!inWater(bot)) return { trapped: false, why: `feet in ${feetBlock ? feetBlock.name : 'unloaded'}, not water` };
  if (!bobbing(bot)) return { trapped: false, why: 'standing in shallow water — it may dig and place' };
  // No dry standing cell near it at all is itself the answer: there is nothing an ordinary move could reach.
  const safe = safeCells(bot);
  const r = safe.length ? await searchTo({ type: 'multi', positions: safe }) : null;
  if (r) return { trapped: false, why: `an ordinary route reaches safety (${r.path.length} step(s))` };
  const head = bot.blockAt(f.offset(0, 1, 0));
  const proof = `feet=${feetBlock.name}@${at(f)} head=${head ? head.name : 'unloaded'} floor=${floored(bot) ? 'solid' : 'none'}`
    + ` bobbing=true stop_flow=${stopFlow} search_to_${safe.length}_safe_cells_within_${ESCAPE_RADIUS}=no_route oxygen=${bot.oxygenLevel ?? '?'}`;
  return { trapped: true, proof };
}

// ── THE FEWEST-DIG WAY TO A CELL WHERE THE BODY STANDS WITH ITS HEAD DRY ─────────────────────────────

// A cell the escape may open: loaded, breakable, never a station, a protected voxel, a peer's closed ground,
// or a block beside lava. `closed` is the peers' closed ground (foreman_link.getPeerClosedAreas), read once per plan.
const inArea = (a, p) => p.x >= a.min.x && p.x <= a.max.x && p.y >= a.min.y && p.y <= a.max.y && p.z >= a.min.z && p.z <= a.max.z;
function openable(bot, p, protectedBlocks, closed) {
  const b = bot.blockAt(p);
  if (!b) return false;
  if (isBlockPassable(b) || isFluid(b.name)) return true;
  if (b.diggable === false || STATION_TYPES.has(b.name)) return false;
  if (protectedBlocks && protectedBlocks.has(keyOf(p))) return false;
  if (closed.some(a => inArea(a, p))) return false;
  return !touchesLava(bot, p);
}
const solidAt = (bot, p) => { const b = bot.blockAt(p); return !!b && !isBlockPassable(b) && !isFluid(b.name); };

// The head cell stays dry once open: it holds no water, and opening it lets none in.
function dryHead(bot, p) {
  const b = bot.blockAt(p);
  return !!b && !isFluid(b.name) && !opensOntoWater(bot, p.x, p.y, p.z);
}

// The cells a move from p to q must open, in the order they are dug (the upper first).
function cutsFor(p, q) {
  if (q.y > p.y) return [q.offset(0, 1, 0)];   // up: the new head cell; the old head is the new feet
  if (q.y < p.y) return [q];                     // down: the floor stood on
  return [q.offset(0, 1, 0), q];                 // sideways: head, then feet
}

// One move's water: with the flow when the cell moved into holds water further down the run than here.
function withFlow(bot, p, q) {
  const here = waterLevel(bot, p.x, p.y, p.z), there = waterLevel(bot, q.x, q.y, q.z);
  if (q.y < p.y) return there !== null;
  return here !== null && there !== null && there > here;
}

// The body can stand at p: a full floor under it, or water under it that a fill can stand it on — a solid
// within fill reach below and a block in the pocket to fill with (escape's standUp).
function standable(bot, p, canFill) {
  const floor = bot.blockAt(p.offset(0, -1, 0));
  if (isBlockSolid(floor) && !isFluid(floor.name)) return isFullHeightFloor(floor);
  if (!canFill || !floor || !isFluid(floor.name)) return false;
  for (let d = 2; d <= Math.max(1, Math.floor(BLOCK_REACH)); d++) if (solidAt(bot, p.offset(0, -d, 0))) return true;
  return false;
}
const fillBlock = (bot) => bot.inventory.items().find(i => i.count > 0 && BRIDGE_PREFS.includes(i.name)) || null;

// THE PLAN IS ONE SYNCHRONOUS SEARCH, SO IT IS KEPT CHEAP: the open set is the shared MinHeap (a sort per pop
// grew quadratic in open water), and each cell is read from the world once per plan (`view`, handed to every
// helper as the bot). A body whose event loop stalls past the server's keep-alive is dropped as timed out.
function planEscape(realBot, protectedBlocks) {
  const cells = new Map();
  const bot = Object.create(realBot);
  bot.blockAt = (p) => {
    const k = keyOf(p);
    if (!cells.has(k)) cells.set(k, realBot.blockAt(p));
    return cells.get(k);
  };
  const closed = require('@kernel/foreman_link').getPeerClosedAreas();
  const start = feetOf(bot);
  const canFill = !!fillBlock(bot);
  const best = new Map([[keyOf(start), 0]]);
  const came = new Map();
  const open = new MinHeap();
  open.push({ p: start, f: 0 });
  while (open.size) {
    const { p, f: cost } = open.pop();
    if (cost > best.get(keyOf(p))) continue;
    const isGoal = !p.equals(start) && dryHead(bot, p.offset(0, 1, 0)) && standable(bot, p, canFill);
    if (isGoal) {
      const path = [];
      for (let k = keyOf(p); came.has(k); k = keyOf(came.get(k).from)) path.unshift(came.get(k));
      return { path, digs: Math.floor(cost / DIG_COST) };
    }
    for (const [dx, dy, dz] of MOVES) {
      const q = p.offset(dx, dy, dz);
      if (Math.max(Math.abs(q.x - start.x), Math.abs(q.y - start.y), Math.abs(q.z - start.z)) > ESCAPE_RADIUS) continue;
      const cuts = cutsFor(p, q);
      if (!cuts.every(c => openable(bot, c, protectedBlocks, closed))) continue;
      // The body lands on whatever is under the cell it moves into; a drop of more than one is no move.
      if (dy <= 0 && !solidAt(bot, q.offset(0, -1, 0)) && !isFluid((bot.blockAt(q.offset(0, -1, 0)) || {}).name)) continue;
      const digs = cuts.filter(c => solidAt(bot, c)).length;
      const c2 = cost + digs * DIG_COST + (withFlow(bot, p, q) ? 0 : AGAINST_FLOW_COST) + 1;
      const k = keyOf(q);
      if (best.has(k) && best.get(k) <= c2) continue;
      best.set(k, c2);
      came.set(k, { from: p, to: q, cuts });
      open.push({ p: q, f: c2 });
    }
  }
  return null;
}

// moveInto — the body into the cell it just opened: sideways it swims or walks, up it jumps (swims up),
// down it lets itself sink. True once its feet are in that cell. opts.holdUp leaves jump pressed on the
// way out, so a body that swam up stays up for the fill that follows; the caller releases it.
async function moveInto(bot, q, opts = {}) {
  const deadline = Date.now() + MOVE_MS;
  const there = () => feetOf(bot).equals(q);
  const up = q.y > feetOf(bot).y;
  await guardExternal(TAG, `look at ${at(q)}`, () => bot.lookAt(new Vec3(q.x + 0.5, q.y + 0.5, q.z + 0.5), true));
  await withCleanup(TAG, `move into ${at(q)}`, async () => {
    while (!there() && Date.now() < deadline) {
      const p = bot.entity.position;
      const flat = Math.hypot(q.x + 0.5 - p.x, q.z + 0.5 - p.z);
      bot.setControlState('forward', flat > 0.3);
      bot.setControlState('jump', up);
      await sleep(50);
    }
  }, () => { bot.setControlState('forward', false); bot.setControlState('jump', !!opts.holdUp && up); });
  return there();
}

// shallowSpot — for a body floating too deep to fill under: the water cell at its own level, reachable by
// swimming through water, with a floor within fill reach under it, nearest a dry standing cell (the shore).
function shallowSpot(bot) {
  const start = feetOf(bot);
  const safe = safeCells(bot);
  const shore = (p) => safe.reduce((d, s) => Math.min(d, Math.abs(s.x - p.x) + Math.abs(s.y + 1 - p.y) + Math.abs(s.z - p.z)), Infinity);
  const reach = Math.max(1, Math.floor(BLOCK_REACH));
  const seen = new Set([keyOf(start)]);
  const queue = [{ p: start, path: [] }];
  let best = null;
  while (queue.length) {
    const { p, path } = queue.shift();
    let floor = false;
    for (let d = 1; d <= reach && !floor; d++) floor = solidAt(bot, p.offset(0, -d, 0));
    if (floor && path.length && (!best || shore(p) < best.score)) best = { p, path, score: shore(p) };
    for (const [dx, , dz] of SIDES) {
      const q = p.offset(dx, 0, dz);
      if (seen.has(keyOf(q)) || Math.max(Math.abs(q.x - start.x), Math.abs(q.z - start.z)) > ESCAPE_RADIUS) continue;
      seen.add(keyOf(q));
      const b = bot.blockAt(q);
      if (b && isFluid(b.name) && b.name.includes('water')) queue.push({ p: q, path: [...path, q] });
    }
  }
  return best;
}

// standUp — fill the water under a floating body until it stands. The body floats over the cell under its
// feet, so that column is filled straight up from its floor, lowest water cell first; a body sitting too low
// to clear the cell it fills takes scaffold_movement's jump-and-place fill instead. A ceiling over the head
// leaves no room for that jump, which is why the straight fill comes first.
async function standUp(bot) {
  const item = fillBlock(bot);
  if (!item) return 'no_block';
  const reach = Math.max(1, Math.floor(BLOCK_REACH));
  // Jump is held through the straight fill so the body stays afloat over the cell being filled.
  await withCleanup(TAG, 'straight fill under the body', async () => {
    bot.setControlState('jump', true);
    for (let tries = 0; tries < reach && !floored(bot); tries++) {
      const f = feetOf(bot);
      let cell = null;
      for (let d = 1; d <= reach; d++) {
        const c = f.offset(0, -d, 0);
        if (solidAt(bot, c.offset(0, -1, 0)) && isFluid((bot.blockAt(c) || {}).name)) { cell = c; break; }
      }
      if (!cell || bot.entity.position.y < cell.y + 1) break;
      const res = await performPlace(bot, cell, bot.blockAt(cell.offset(0, -1, 0)), new Vec3(0, 1, 0), item.name, TAG);
      if (!res.ok) break;
    }
  }, () => bot.setControlState('jump', false));
  await sleep(SETTLE_MS);
  if (floored(bot)) return 'ready';
  return fillWaterColumnBelow(bot, item, { timeoutMs: FILL_MS });
}

// escape(bot, { proof, protectedBlocks }) — run only on a proof from prove().
async function escape(bot, { proof, protectedBlocks }) {
  watcher.warn(TAG, `WATER ESCAPE — TRAPPED, emergency moves begin: ${proof}`);
  let digs = 0;
  for (let step = 1; step <= MAX_STEPS; step++) {
    // Out once it may dig AND breathes: a body on a floor with water in its head cell (a source over a plant it
    // stands in) is not barred from digging, yet under water; planEscape walks it to a dry head.
    const headWet = isFluid((bot.blockAt(feetOf(bot).offset(0, 1, 0)) || {}).name);
    if ((!inWater(bot) || !bobbing(bot)) && !headWet) {
      watcher.warn(TAG, `WATER ESCAPE — out after ${step - 1} move(s) and ${digs} dig(s): feet ${at(feetOf(bot))}, no longer barred from digging.`);
      return { escaped: true, steps: step - 1, digs };
    }
    if (!floored(bot)) {
      let filled = await standUp(bot);
      if (filled === 'too_deep') {
        const spot = shallowSpot(bot);
        if (!spot) return gaveUp(step, digs, 'floating, too deep to fill and no shallower water within reach');
        watcher.warn(TAG, `WATER ESCAPE — floating too deep at ${at(feetOf(bot))}; swimming ${spot.path.length} cell(s) to ${at(spot.p)}, ${spot.score} from the shore, to fill there.`);
        for (const q of spot.path) if (!(await moveInto(bot, q))) return gaveUp(step, digs, `swim to ${at(q)} did not arrive`);
        filled = await standUp(bot);
      }
      watcher.warn(TAG, `WATER ESCAPE — fill under the body at ${at(feetOf(bot))}: ${filled}.`);
      if (filled !== 'ready') return gaveUp(step, digs, `could not stand: ${filled}`);
      continue;
    }
    const plan = planEscape(bot, protectedBlocks);
    if (!plan || !plan.path.length) return gaveUp(step, digs, `no way to a dry-headed stand within ${ESCAPE_RADIUS} blocks that may be dug`);
    const move = plan.path[0];
    watcher.warn(TAG, `WATER ESCAPE — move ${step}: ${at(move.from)} → ${at(move.to)}, digging ${move.cuts.filter(c => solidAt(bot, c)).map(c => `${bot.blockAt(c).name}@${at(c)}`).join(', ') || 'nothing'} (${plan.digs} dig(s) to a dry head, ${plan.path.length} move(s)).`);
    for (const c of move.cuts) {
      const b = bot.blockAt(c);
      if (!solidAt(bot, c)) continue;
      const opts = c.y < feetOf(bot).y ? { lowerSelf: true } : {};
      if (!(await performDig(bot, c, b, WATER_ESCAPE_TAG, opts))) return gaveUp(step, digs, `dig of ${b.name} at ${at(c)} did not take`);
      digs++;
    }
    // A body that swam up keeps jump pressed into the fill the next pass makes (a body in water left alone
    // sinks); every other move waits for the water to follow into what was opened, and is read where it settled.
    const up = move.to.y > move.from.y;
    if (!(await moveInto(bot, move.to, { holdUp: up }))) { bot.setControlState('jump', false); return gaveUp(step, digs, `move into ${at(move.to)} did not arrive`); }
    if (!up) await sleep(SETTLE_MS);
  }
  return gaveUp(MAX_STEPS, digs, `still barred from digging after ${MAX_STEPS} moves`);

  function gaveUp(step, d, reason) {
    watcher.warn(TAG, `WATER ESCAPE — FAILED at move ${step} after ${d} dig(s): ${reason}; feet ${at(feetOf(bot))}.`);
    return { escaped: false, steps: step, digs: d, reason };
  }
}

// ── ASHORE: THE SURFACE SWIM TO DRY GROUND, for any body left afloat ─────────────────────────────────
// A body the swim survival brought to air is still in water. Handed to the next job like that, its walk lets it
// sink, the survival takes it up again and discards that job, and recursive_judge kills the loop at five. The
// navigator's water_bank_out step can miss the same bank every time (a lip with no walkable landing beside the
// cell it swims from). Ashore needs no route plan: through the surface water (breadth first, within ASHORE_RADIUS)
// to the nearest cell beside a dry stand (A*'s own standable floor, classifyFloorInline) at most one block up,
// swum cell by cell with jump held, so the body stays at the surface and climbs the lip at the end.
// THE SWIM IS AT THE SURFACE, NOT AT THE FEET: a floating body's feet read one cell under the top water cell, and a
// bank flush with the water stands two above them, so a search at the feet never finds an ordinary bank.
// No block is dug or placed; a body that cannot get ashore this way is the escape's (above).
//
// ashore(bot) → { ok, reason, stand, swum }.
const ASHORE_RADIUS = 24;       // blocks round the body the surface swim looks for a bank: open water reaches past ESCAPE_RADIUS
// The body at p can rise a block to step up a lip: the cell over its head is open.
const headroom = (bot, p) => { const h = bot.blockAt(p.offset(0, 2, 0)); return !!h && isBlockPassable(h); };
const isWater = (bot, p) => { const b = bot.blockAt(p); return !!(b && isFluid(b.name) && b.name.includes('water')); };
const dryStand = (bot, s) => { const floor = bot.blockAt(s.offset(0, -1, 0)); return !!(floor && classifyFloorInline(bot, floor)); };
// THE SEARCH STARTS LOW AND RISES ONLY IF IT MUST. The first start is the surface reached through still or level water:
// at a falling column's foot the water above is the column, whose top is in the air the body came down from, so the
// foot's own pool is searched first. Failing that, each water cell straight up the column is a start in turn, swum up
// to first (a pit being filled from its rim is searched from the rim).
// A LIP IS THE LAST BANK. A stand beside a current that runs to a drop (pathfinding_utils.besideCurrentOverDrop, the
// search's own lip test) is where the current took the body from: stood back on it, the body is taken again. It is
// chosen only when no other bank is in reach, and the answer says so (lip: true).
function ashorePath(bot) {
  let start = feetOf(bot);
  const falling = (p) => (waterLevel(bot, p.x, p.y, p.z) ?? 0) >= 8;
  while (isWater(bot, start.offset(0, 1, 0)) && !falling(start.offset(0, 1, 0))) start = start.offset(0, 1, 0);
  const starts = [{ p: start, prefix: [] }];
  const climb = [];
  for (let up = start.offset(0, 1, 0); isWater(bot, up) && climb.length < ASHORE_RADIUS; up = up.offset(0, 1, 0)) {
    climb.push(up);
    starts.push({ p: up, prefix: [...climb] });
  }
  let lipWay = null;
  for (const s of starts) {
    const way = ashoreFrom(bot, s.p, s.prefix);
    if (way && way.safe) return way.safe;
    if (way && way.lip && !lipWay) lipWay = way.lip;
  }
  return lipWay;
}
function ashoreFrom(bot, start, prefix) {
  const { besideCurrentOverDrop } = require('@utils/pathfinding_utils');
  const seen = new Set([keyOf(start)]);
  const queue = [{ p: start, path: prefix }];
  let lip = null;
  while (queue.length) {
    const { p, path } = queue.shift();
    for (const [dx, , dz] of SIDES) {
      for (const dy of [0, 1]) {
        const s = p.offset(dx, dy, dz);
        if (isWater(bot, s) || !dryStand(bot, s) || (dy === 1 && !headroom(bot, p))) continue;
        if (!besideCurrentOverDrop(bot, s.x, s.y - 1, s.z)) return { safe: { stand: s, path } };
        if (!lip) lip = { stand: s, path, lip: true };
      }
      const q = p.offset(dx, 0, dz);
      if (seen.has(keyOf(q)) || Math.max(Math.abs(q.x - start.x), Math.abs(q.z - start.z)) > ASHORE_RADIUS) continue;
      seen.add(keyOf(q));
      const b = bot.blockAt(q);
      if (b && isFluid(b.name) && b.name.includes('water')) queue.push({ p: q, path: [...path, q] });
    }
  }
  return lip ? { lip } : null;
}

// The swim's breath, for a caller with a breath to spend: only a cell swum with the head under (water over it) spends
// air; across a shallow current the head is out and the body breathes. A cell straight up is swum with jump alone, a
// cell across with forward and jump against whatever current runs there (a level current is out-swum at 0.5 to 1 b/s).
const SWIM_UP_MS = 400, SWIM_ACROSS_MS = 1000;
function breathSpent(bot, way, from) {
  let ms = 0, prev = from;
  for (const q of way.path) {
    if (isWater(bot, q.offset(0, 1, 0))) ms += q.x === prev.x && q.z === prev.z ? SWIM_UP_MS : SWIM_ACROSS_MS;
    prev = q;
  }
  return ms;
}

// ashore(bot, { withinMs, safeOnly }) → as above; with withinMs, a way whose swim outlasts it is not started
// (bank_beyond_breath), and with safeOnly a lip is not taken (only_a_lip_in_reach), so the caller keeps its own way down.
async function ashore(bot, { withinMs = null, safeOnly = false } = {}) {
  if (!inWater(bot)) return { ok: true, reason: 'dry', stand: null, swum: 0 };
  const way = ashorePath(bot);
  if (!way) return { ok: false, reason: `no_dry_stand_by_water_within_${ASHORE_RADIUS}`, stand: null, swum: 0 };
  if (safeOnly && way.lip) return { ok: false, reason: 'only_a_lip_in_reach', stand: way.stand, swum: 0 };
  const from = feetOf(bot);
  if (withinMs !== null && breathSpent(bot, way, from) > withinMs) return { ok: false, reason: 'bank_beyond_breath', stand: way.stand, swum: 0 };
  let swum = 0;
  const cells = [...way.path, way.stand];
  const isUp = (q, prev) => q.x === prev.x && q.z === prev.z;
  const reached = await withCleanup(TAG, 'swim ashore at the surface', async () => {
    let prev = from;
    for (let i = 0; i < cells.length; i++) {
      const q = cells[i], next = cells[i + 1];
      const deadline = Date.now() + MOVE_MS;
      // A CELL STRAIGHT UP (the climb up a column) is reached when the feet are in it: forward would only press the body
      // round the column's middle, and the horizontal test alone reads it reached before it has risen.
      // THE TOP OF THE CLIMB is where the column's feed runs over the edge: the body coming up into it is pushed back
      // over unless it is already stroking across, so on the last cell up it turns to the next cell as its feet come
      // level with the top (below that the side it turns to is the bank's own floor, never the open air).
      // THE AIM IS TAKEN AGAIN EVERY TICK: a current pushes the body off the line it set out on, and a heading held from
      // the start walks it past its cell (along a bank's edge, held up by the hitbox's edge, and off the bank's end).
      // The stand is reached in its own cell (dry ground beside it may be the lip the current pushed the body onto), ON
      // the ground and touching no water: a body whose centre has crossed onto the stand while its hitbox still floats in
      // the current is pushed off it again the moment it is let go.
      const up = isUp(q, prev), lastUp = up && next && !isUp(next, q);
      prev = q;
      let toward = q;
      while (Date.now() < deadline && bot.health > 0) {
        const p = bot.entity.position;
        const centred = Math.hypot(q.x + 0.5 - p.x, q.z + 0.5 - p.z) < 0.35;
        const atCell = up ? p.y >= q.y
          : q !== way.stand ? centred
          : (centred || feetOf(bot).equals(q)) && bot.entity.onGround && !bot.entity.isInWater && floored(bot);
        if (atCell) break;
        if (lastUp && toward === q && p.y >= q.y - 0.5) toward = next;
        await guardExternal(TAG, `look at ${at(toward)}`, () => bot.lookAt(new Vec3(toward.x + 0.5, toward.y + 1, toward.z + 0.5), true));
        bot.setControlState('forward', !up || toward !== q);
        // Out of the water over the stand the step is a walk: jump held there vaults the body past a small stand.
        bot.setControlState('jump', q !== way.stand || inWater(bot));
        await sleep(50);
      }
      if (Date.now() >= deadline) return `swim_to_${at(q)}_timed_out`;
      swum++;
    }
    return null;
  }, () => { bot.setControlState('forward', false); bot.setControlState('jump', false); });
  if (inWater(bot)) return { ok: false, reason: reached || 'still_in_water', stand: way.stand, swum };
  return { ok: true, reason: way.lip ? 'swam_out_onto_a_lip' : 'swam_out', stand: way.stand, swum };
}

module.exports = { prove, escape, planEscape, ashore };
