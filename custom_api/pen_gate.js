// api: pen_gate
// purpose: An animal pen as the world holds it, and the body's crossing of its gate. One owner for the pen's
//          geometry (the gate's axis, the cells on it, the interior), for the gate crossings (in behind a led
//          animal: herd_executor; in to work: enterPen; out again: leavePen) and for the tending pair's board.
//
// THE PEN RECORD. { interior: { x1, z1, x2, z2, floor_y }, gate: { x, y, z }, side_gate?: { x, y, z } }, the gate
// in the fence ring one cell outside the interior. penOf(structure) builds it from the structure's blueprint and
// its locked origin: the interior is the box strictly inside the fence ring, the gates are its fence_gate voxels.
//
// THE GATE IS CROSSED IN A STRAIGHT LINE. A fence gate reads as a full block to the route search whether it is
// open or shut, so every crossing walks cell by cell along the gate's axis (stepInto).
//
// ONE BODY AT THE GATE (holdGate): every crossing holds the gate's claim from before it opens until it is shut.
//
// LEAVING. A tender leaves with no wheat shown, so the flock is not drawn to it; the shepherd's wheat at the far fence
// holds the flock at the back of the pen, away from the doorway. It walks to the doorway, opens the gate (or finds it open), walks through
// and shuts it behind. No gate opens onto a way out (doorwayClear): an animal in the doorway, or wheat shown outside
// within tempt reach of the gate, is waited out first. The animals that left with it are counted and reported.
//
// invariants:
//  - Every gate, cell and animal is re-sensed at each step (Invariant B).
//  - A malformed pen record is a coding violation and throws (Law 13).

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { faceTarget, tapForward, clearMotion } = require('@utils/movement/motion_primitives');
const { HERDING } = require('@thinking/architect_config');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');

const TAG = 'pen_gate';
const LURE = 'wheat';
const POLL_MS = 250;
const STEP_ARRIVE = 0.35;      // flat distance at which a straight step counts as standing in its cell
const STEP_CEILING_MS = 6000;  // one gate-cell step; longer means the cell is blocked
const sleep = ms => new Promise(r => setTimeout(r, ms));
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const centre = c => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });

// penOf(structure) → the pen record of a locked structure, or null while it has no locked origin. The record names its
// structure and the one kind it holds (HERDING.pens).
function penOf(structure) {
  const spot = require('@kernel/corporate_headquarters').readBuildingChair(structure, 'set_buildspot');
  const o = spot?.transpose_origin;
  if (!o || typeof o.x !== 'number') return null;
  return penAt(structure, o);
}
// penAt(structure, origin) → the pen record of `structure` locked at `origin`. The one builder of a pen record: a body
// reads the origin from its HQ (penOf), the integrity keeper from the plans it holds (foreman/pen_keeper).
function penAt(structure, o) {
  const row = HERDING.pens[structure];
  if (!row) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): '${structure}' has no HERDING.pens row naming the animal it holds.`);
  const building = require('@kernel/blueprint_registry').getBuilding(structure, TAG);
  const bo = building.transpose_origin || { x: 0, y: 0, z: 0 };
  const ring = [], gates = [];
  for (const anchor of building.anchors || []) {
    for (const [x, y, z, token] of anchor.voxels) {
      if (token === 'fence' || token === 'fence_gate') ring.push({ x, y, z });
      if (token === 'fence_gate') gates.push({ x, y, z });
    }
  }
  if (!ring.length || !gates.length || gates.length > 2) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): '${structure}' is not a pen: ${ring.length} fence voxel(s), ${gates.length} gate(s) (one or two).`);
  }
  // A pen locked with a turn (transpose_origin.turn) stands turned: its ring and gates are placed as its voxels are.
  const at = v => require('@perception/blueprint_survey').placeOffset(o, bo, [v.x, v.y, v.z]);
  const placed = ring.map(at);
  const xs = placed.map(v => v.x), zs = placed.map(v => v.z);
  const lo = { x: Math.min(...xs) + 1, y: placed[0].y, z: Math.min(...zs) + 1 };
  const hi = { x: Math.max(...xs) - 1, z: Math.max(...zs) - 1 };
  const pen = { structure, animal: row.animal, interior: { x1: lo.x, z1: lo.z, x2: hi.x, z2: hi.z, floor_y: lo.y }, gate: at(gates[0]) };
  if (gates[1]) pen.side_gate = at(gates[1]);
  return pen;
}

// penGeometry: the gate's outward direction and the cells a crossing uses on its axis. `side_gate` is a second
// gate beside `gate` in the same side, opened and shut with it: a one-wide doorway wedges two followers arriving
// together, a two-wide one lets them through side by side. The body walks through `gate`.
function penGeometry(pen) {
  const i = pen && pen.interior, g = pen && pen.gate;
  const nums = o => !!o && Object.values(o).every(v => typeof v === 'number' && Number.isFinite(v));
  if (!nums(i) || !nums(g) || ['x1', 'z1', 'x2', 'z2', 'floor_y'].some(k => !(k in i)) || ['x', 'y', 'z'].some(k => !(k in g))) {
    throw new Error(`[${TAG}] CODING VIOLATION: pen must be { interior:{x1,z1,x2,z2,floor_y}, gate:{x,y,z} }. Got: ${JSON.stringify(pen)}`);
  }
  const alongX = g.x >= i.x1 && g.x <= i.x2, alongZ = g.z >= i.z1 && g.z <= i.z2;
  let n = null;
  if (alongX && g.z === i.z2 + 1) n = { x: 0, z: 1 };
  else if (alongX && g.z === i.z1 - 1) n = { x: 0, z: -1 };
  else if (alongZ && g.x === i.x2 + 1) n = { x: 1, z: 0 };
  else if (alongZ && g.x === i.x1 - 1) n = { x: -1, z: 0 };
  if (!n) throw new Error(`[${TAG}] CODING VIOLATION: gate (${g.x},${g.y},${g.z}) is not in the fence ring of interior ${JSON.stringify(i)}.`);
  const s = pen.side_gate || null;
  if (s && (!nums(s) || s.y !== g.y || (n.x === 0 ? s.z !== g.z || Math.abs(s.x - g.x) !== 1 || s.x < i.x1 || s.x > i.x2
    : s.x !== g.x || Math.abs(s.z - g.z) !== 1 || s.z < i.z1 || s.z > i.z2))) {
    throw new Error(`[${TAG}] CODING VIOLATION: side_gate ${JSON.stringify(s)} is not the cell beside gate (${g.x},${g.y},${g.z}) in the same side of interior ${JSON.stringify(i)}.`);
  }
  const at = k => ({ x: g.x + n.x * k, y: g.y, z: g.z + n.z * k });
  const length = n.x === 0 ? i.z2 - i.z1 + 1 : i.x2 - i.x1 + 1;
  const farK = length - 1;   // the row before the far fence: where the herder draws a wedged doorway clear
  return { structure: pen.structure, animal: pen.animal, axis: n, gates: s ? [g, s] : [g], far: farK > 1 + HERDING.deep_blocks ? at(-farK) : null, gate: g, lineup: at(HERDING.gate_approach_blocks), outer: at(1), inner: at(-1), deep: at(-1 - HERDING.deep_blocks), interior: i };
}

// INSIDE IS UP TO THE FENCE'S POSTS. insidePen(geo, p) → whether `p` stands within the line through the middle of the
// fence ring's cells: a fence is a thin post in the middle of its cell, so an animal pressed to it from inside stands
// in the fence's cell (a calf, 0.45 wide, reaches 0.15 past the cell's edge). Read as out of the interior's cells, every
// calf at the fence was an escape the keeper could not explain, gate shut and fence whole.
function insidePen(geo, p) {
  const i = geo.interior;
  return p.x > i.x1 - 0.5 && p.x < i.x2 + 1.5 && p.z > i.z1 - 0.5 && p.z < i.z2 + 1.5;
}

// waitFor: poll until test() holds or the time runs out; extend() may renew the deadline while the
// world is still moving toward the condition.
// A peer's word on the board ends the pause at once (corporate_headquarters.onNextChairs); the world (an animal
// following, a gate) is read every POLL_MS, since an animal says nothing. The deadline is for the peer that never
// answers: one killed, disconnected or given up.
function pause() {
  const hq = require('@kernel/corporate_headquarters');
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); hq.offNextChairs(done); resolve(); };
    const t = setTimeout(done, POLL_MS);
    hq.onNextChairs(done);
  });
}
async function waitFor(test, ms, extend) {
  let deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (test()) return true;
    await pause();
    if (extend && extend()) deadline = Math.max(deadline, Date.now() + POLL_MS * 8);
  }
  return test();
}

// stepInto: a straight walk into one cell, for the gate cell the route search cannot plan through.
async function stepInto(bot, cell) {
  const goal = centre(cell);
  const deadline = Date.now() + STEP_CEILING_MS;
  while (Date.now() < deadline) {
    if (flat(bot.entity.position, goal) < STEP_ARRIVE) { clearMotion(bot); return true; }
    await faceTarget(bot, bot.entity.position, goal, 50);
    await tapForward(bot, 120);
  }
  clearMotion(bot);
  return flat(bot.entity.position, goal) < STEP_ARRIVE;
}

async function setGate(bot, pos, open) {
  const at = new Vec3(pos.x, pos.y, pos.z);
  const block = bot.blockAt(at);
  if (!block || !/_fence_gate$/.test(block.name)) return `gate_missing_at_${pos.x}_${pos.y}_${pos.z}`;
  if (block.getProperties().open === open) return null;
  const click = await guardExternal(TAG, `activateBlock fence gate at (${pos.x},${pos.y},${pos.z})`, () => bot.activateBlock(block));
  if (!click.ok) return 'gate_click_failed';
  const moved = await waitFor(() => bot.blockAt(at)?.getProperties().open === open, 1500);
  // EVERY GATE THE BODY OPENS OR SHUTS IS SAID, with the wheat in its hands: the keeper's escape lines (pen_keeper)
  // are read against these.
  const hands = `${bot.heldItem?.name || '-'}/${bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name || '-'}`;
  watcher.summary(TAG, `GATE state=${open ? 'open' : 'shut'} gate=${pos.x},${pos.y},${pos.z} moved=${moved} hands=${hands}`);
  return moved ? null : `gate_stayed_${open ? 'shut' : 'open'}`;
}

// ── NO GATE OPENS ONTO A WAY OUT ─────────────────────────────────────────────────────────────────────
// A tempted animal walks the route to the wheat it sees, and an open gate is a route: wheat shown outside within tempt
// reach of the gate draws the penned flock out through it, and an animal standing in the doorway walks out of it.
// doorwayClear(bot, geo, cells) → { clear, animals, wheat }: the penned animals within HERDING.doorway_blocks of a gate
// cell being opened (`cells`, every gate unless named): the cell itself and the row inside it, not the gate's end of
// the pen, which a full pen always has animals in; and the bodies other than this one, outside the pen, showing wheat
// within tempt reach of the gate. The opener's own
// wheat is not counted: it is walking through.
function doorwayClear(bot, geo, cells = geo.gates) {
  const door = cells.map(centre);
  const animals = penned(bot, geo, geo.animal).filter(a => door.some(c => flat(a.position, c) <= HERDING.doorway_blocks));
  const wheat = Object.values(bot.players || {}).map(p => p.entity)
    .filter(e => e && e !== bot.entity && e.position && holdsWheat(e) && !insidePen(geo, e.position)
      && door.some(c => flat(e.position, c) <= HERDING.tempt_range + 1));
  return { clear: !animals.length && !wheat.length, animals, wheat };
}
// awaitDoorway(bot, geo, cells) → null once the gate may open, or a fault. Wheat outside is waited out up to
// HERDING.doorway_wheat_ms and fails the crossing past it; an animal in the doorway is waited out up to
// HERDING.doorway_clear_ms. Past that, a body outside does not open (nothing it can do draws the animal off the gate
// but wheat, which draws it out); a body inside opens, the animal named, since it cannot stay in the pen. Every wait
// is said ([DOORWAY]).
async function awaitDoorway(bot, geo, cells) {
  const started = Date.now();
  let seen = doorwayClear(bot, geo, cells);
  if (seen.clear) return null;
  await waitFor(() => {
    seen = doorwayClear(bot, geo, cells);
    const waited = Date.now() - started;
    return seen.clear || (!seen.wheat.length && waited >= HERDING.doorway_clear_ms) || waited >= HERDING.doorway_wheat_ms;
  }, HERDING.doorway_wheat_ms);
  const at = e => `${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}`;
  const said = `gate=${geo.gate.x},${geo.gate.y},${geo.gate.z} waited_s=${((Date.now() - started) / 1000).toFixed(1)}`
    + ` animals=${seen.animals.map(a => `${a.id}@${at(a)}`).join('/') || '-'} wheat=${seen.wheat.map(e => `${e.username || e.id}@${at(e)}`).join('/') || '-'}`;
  if (seen.clear) { watcher.summary(TAG, `DOORWAY clear ${said}`); return null; }
  if (seen.wheat.length) { watcher.warn(TAG, `DOORWAY wheat_outside ${said}: the gate stays shut while wheat outside would draw the flock out`); return 'wheat_shown_outside_the_gate'; }
  if (!insidePen(geo, bot.entity.position)) {
    watcher.warn(TAG, `DOORWAY animal_in_doorway ${said}: the gate stays shut, the body outside`);
    return 'animal_in_the_doorway';
  }
  watcher.warn(TAG, `DOORWAY animal_in_doorway ${said}: opened with it there, the body inside`);
  return null;
}

// setGates(bot, geo, open, cells): opens or shuts `cells` (every gate of the pen unless named). A flock crossing opens
// both, so two followers pass side by side; a body crossing alone opens only the gate it walks through
// (passGate), the doorway half as wide for an animal beside it.
async function setGates(bot, geo, open, cells = geo.gates) {
  if (open && cells.some(g => bot.blockAt(new Vec3(g.x, g.y, g.z))?.getProperties().open !== true)) {
    const fault = await awaitDoorway(bot, geo, cells);
    if (fault) return fault;
  }
  for (const g of cells) {
    const fault = await setGate(bot, g, open);
    if (fault) return fault;
  }
  return null;
}

// ── THE KEEPER'S WORD ON A PEN ──────────────────────────────────────────────────────────────────────
// keptPen(structure) → what the integrity keeper holds of the pen (foreman/pen_keeper: { animal, seen, count, ids,
// gate_open, … }), or null for a body with no foreman, which senses the pen itself. A pen the keeper does not see is
// { seen: false }: unknown, never empty. The keeper is the one census of a pen: it watches every animal in and out.
function keptPen(structure) {
  const kv = require('@kernel/keeper_verdicts');
  if (!kv.required()) return null;
  const v = kv.get('pens');
  return (v && v.pens && v.pens[structure]) || { seen: false };
}

// ── EVERY WHEAT SHOWN OR PUT AWAY IS SAID ───────────────────────────────────────────────────────────
// lureLine(bot, state, why): one `LURE` line when the wheat comes into a hand or leaves it, with where the body
// stands and why, so an animal that follows the wheat out of a pen is matched to the hand that showed it.
// state: shown | away | in_hand (fed by hand).
function lureLine(bot, state, why) {
  const p = bot.entity?.position;
  const at = p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '-';
  watcher.summary('herd_lure', `LURE state=${state} why=${why} at=${at}`);
}

// The animals of `kind` the body senses in the pen, by the fleet's ring search (@utils/ring_scan) around it.
function penned(bot, geo, kind) {
  const i = geo.interior;
  const mid = { x: (i.x1 + i.x2 + 1) / 2, y: i.floor_y, z: (i.z1 + i.z2 + 1) / 2 };
  const reach = Math.hypot(i.x2 - i.x1 + 1, i.z2 - i.z1 + 1) / 2 + 1;
  return require('@utils/ring_scan').entitiesNearest(bot, {
    center: mid, reach, match: e => e.name === kind && e.isValid !== false && insidePen(geo, e.position),
  }).map(r => r.entity);
}

// ONE BODY AT THE GATE. A crossing, in or out, holds the gate's claim from before it opens until it is shut again,
// so one body never shuts the gate on another in the doorway, nor opens it while another holds the flock at it.
const gateKey = geo => `gate:${geo.gate.x},${geo.gate.y},${geo.gate.z}`;
async function tryGate(geo) {
  const { claimFirst } = require('@utils/target_claims');
  return !!(await claimFirst([geo.gate], { keyOf: () => gateKey(geo) })).pick;
}
// holdGate(bot, geo, whileWaiting) → true once this body holds the gate, false when gate_wait_ms ran out.
// whileWaiting() runs between asks (the herder keeps its animal at heel there).
const GATE_ASK_MS = 1000;
async function holdGate(bot, geo, whileWaiting) {
  const deadline = Date.now() + HERDING.gate_wait_ms;
  while (Date.now() < deadline) {
    if (await tryGate(geo)) return true;
    const asked = Date.now();
    if (whileWaiting) await whileWaiting();
    const left = GATE_ASK_MS - (Date.now() - asked);   // one ask a second, however soon whileWaiting returns
    if (left > 0) await sleep(left);
  }
  return tryGate(geo);
}
function releaseGate(geo) {
  require('@utils/target_claims').releaseTarget(gateKey(geo));
}

// ── TENDING: ONE TENDER AT THE STANDBY CELL, ONE SHEPHERD AT THE POST ───────────────────────────────
// Every piece of work on the herd that opens the gate is done by two bodies: while the gate is open every animal at
// the pen is tempted by someone. The TENDER does the work: a bringer leads a flock in (herd_executor), a shearer
// shears the penned flock (shear_executor). It holds the STANDBY cell (its `park:` claim, `herd_park` on its magnet),
// on the gate's axis HERDING.park_blocks out, and enters only once a shepherd holds the flock.
// The SHEPHERD holds the post (its `shepherd:` claim, `herd_shepherd` on its magnet). For a crossing it never enters:
// with the gate shut it sweeps the flock to the back from outside (sweepPath), the wheat shown from the gate's end of
// a long side to the far fence, and holds the flock there, opposite the gate. The gate opens only while a shepherd says
// it is holding (shepherdAt); the shepherd holds until the tender is out with the gate shut, then leaves. Work over a
// shut gate (feeding, dyeing) stands at the POST outside the middle of a long side instead. A shut gate needs nobody:
// the animals inside cannot leave.
const parkKey = geo => `park:${geo.gate.x},${geo.gate.y},${geo.gate.z}`;
const shepherdKey = geo => `shepherd:${geo.gate.x},${geo.gate.y},${geo.gate.z}`;

// standAt(bot, x, z, y0): the feet cell nearest height y0 in column (x, z) with a solid floor and two passable
// cells above it, within four cells up or down; null when the column has none.
function standAt(bot, x, z, y0) {
  const { isBlockPassable, isBlockSolid } = require('@utils/pathfinding_utils');
  for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const y = y0 + dy;
    const floor = bot.blockAt(new Vec3(x, y - 1, z)), feet = bot.blockAt(new Vec3(x, y, z)), head = bot.blockAt(new Vec3(x, y + 1, z));
    if (floor && feet && head && isBlockSolid(floor) && isBlockPassable(feet) && isBlockPassable(head)) return { x, y, z };
  }
  return null;
}
// axisCell(bot, geo, k, span): the first standable cell on the gate's axis from k out, trying `span` + 1 columns;
// null if none. A COLUMN ANOTHER STRUCTURE STANDS ON IS NOT TRIED. The axis can run into a footprint sited after the
// pen (a second pen beside it), and a body standing by there is inside that fence ring and breaks out through it;
// such a column, or one beside it, is passed over and not counted.
const AXIS_REACH = 48;   // the farthest out from the gate the axis is followed
function axisCell(bot, geo, k, span) {
  const { gate: g, axis: n } = geo;
  const proofingKey = require('@kernel/bot_mandate').buildingRoomKey(require('@thinking/architect_config').SPAWN_PROOFING);
  const boxes = require('@action/find_buildingspot').getExistingFootprints(1).filter(b => b.key !== proofingKey);   // the spawn proofing is the lit ground, not a structure
  const own = boxes.find(b => g.x >= b.minX && g.x <= b.maxX && g.z >= b.minZ && g.z <= b.maxZ);
  for (let d = 0, tried = 0; tried <= span && k + d <= AXIS_REACH; d++) {
    const x = g.x + n.x * (k + d), z = g.z + n.z * (k + d);
    if (boxes.some(b => b !== own && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ)) continue;
    tried++;
    const c = standAt(bot, x, z, g.y);
    if (c) return { ...c, k: k + d };
  }
  return null;
}
// shepherdPost(bot, geo): the stand two cells outside the middle of a long side (one past its fence), on whichever
// long side has one; null when neither does.
function shepherdPost(bot, geo) {
  return longSidePosts(bot, geo)[0] || null;
}
// longSidePosts(bot, geo) → the stands outside the middle of each long side that has one, the shepherd's post first;
// the second, when there is one, is the far side's (breedRound feeds from it the animals the first side never reached).
function longSidePosts(bot, geo) {
  const { interior: i, axis: n } = geo;
  const mid = { x: Math.floor((i.x1 + i.x2) / 2), z: Math.floor((i.z1 + i.z2) / 2) };
  const sides = n.x === 0 ? [{ x: i.x2 + 2, z: mid.z }, { x: i.x1 - 2, z: mid.z }] : [{ x: mid.x, z: i.z2 + 2 }, { x: mid.x, z: i.z1 - 2 }];
  return sides.map(s => standAt(bot, s.x, s.z, geo.gate.y)).filter(Boolean);
}
// shepherdCellToward(bot, geo, post, toward): the stand on the shepherd's long side (the post's line, outside the
// fence) level with `toward` along the pen, held within the interior's length; null when that column has none.
function shepherdCellToward(bot, geo, post, toward) {
  const { interior: i, axis: n } = geo;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  const c = n.x === 0 ? { x: post.x, z: clamp(toward.z, i.z1, i.z2) } : { x: clamp(toward.x, i.x1, i.x2), z: post.z };
  return standAt(bot, c.x, c.z, post.y);
}
// THE SHEPHERD SWEEPS THE FLOCK TO THE BACK, FROM OUTSIDE, WITH THE GATE SHUT. sweepPath(bot, geo) → the stands the
// shepherd walks with its wheat shown, each in the cell against the fence: along one long side from level with the
// gate's end of the interior to the far corner, then along the far short side to the cell straight opposite the gate,
// the last stand being its post. A tempted animal follows the wheat along the inside of the fence, so the flock is
// swept the length of the pen and held against the far fence, the pen's length from the doorway: wheat at the post is
// past tempt reach of the gate (doorwayClear reads none there). Of the two long sides the one with more stands is
// walked; a column with no stand, or one another structure stands on, is passed over. null when neither side reaches
// the post.
function sweepPath(bot, geo) {
  const { interior: i, axis: n, gate: g } = geo;
  // The pen's own frame: `a` runs along its length, `c` across its width; `out` is +1 when the gate is past the high end.
  const alongX = n.x !== 0;
  const [aLo, aHi] = alongX ? [i.x1, i.x2] : [i.z1, i.z2];
  const [cLo, cHi] = alongX ? [i.z1, i.z2] : [i.x1, i.x2];
  const out = alongX ? n.x : n.z;
  const step = -out;                                   // from the gate's end toward the far end
  const gateEnd = out > 0 ? aHi : aLo, farEnd = out > 0 ? aLo : aHi;
  const farStand = farEnd + 2 * step;                  // the row against the far fence, outside it
  const opposite = alongX ? g.z : g.x;
  const at = (a, c) => (alongX ? { x: a, z: c } : { x: c, z: a });
  const proofingKey = require('@kernel/bot_mandate').buildingRoomKey(require('@thinking/architect_config').SPAWN_PROOFING);
  const boxes = require('@action/find_buildingspot').getExistingFootprints(1).filter(b => b.key !== proofingKey);
  const own = boxes.find(b => g.x >= b.minX && g.x <= b.maxX && g.z >= b.minZ && g.z <= b.maxZ);
  const foreign = p => boxes.some(b => b !== own && p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ);
  const paths = [cHi + 2, cLo - 2].map((side) => {
    const cols = [];
    for (let a = gateEnd; a !== farStand + step; a += step) cols.push(at(a, side));
    const dir = opposite > side ? 1 : -1;
    for (let c = side + dir; c !== opposite + dir; c += dir) cols.push(at(farStand, c));
    const stands = cols.filter(p => !foreign(p)).map(p => standAt(bot, p.x, p.z, g.y)).filter(Boolean);
    const end = stands[stands.length - 1];
    const reaches = !!end && (alongX ? end.x === farStand && end.z === opposite : end.z === farStand && end.x === opposite);
    return reaches ? stands : null;
  }).filter(Boolean);
  return paths.sort((p, q) => q.length - p.length)[0] || null;
}
// tendingCells(bot, geo) → { park, post, far, sweep }: the standby cell on the gate's axis, the shepherd's post outside
// the middle of a long side (work over a shut gate: feeding, dyeing), the far long side's stand (null when it has none)
// and the sweep its crossing shepherd walks (sweepPath), or null when the ground has no stand for park, post or sweep.
function tendingCells(bot, geo) {
  const park = axisCell(bot, geo, HERDING.park_blocks, 4);
  const [post, far = null] = longSidePosts(bot, geo);
  const sweep = sweepPath(bot, geo);
  return park && post && sweep ? { park, post, far, sweep } : null;
}

// THE AXIS IS KEPT WALKABLE. A herd walks the gate's axis, and its flock follows over the same ground; a column
// standing two or more above both its neighbours (a plank pillar a body left, a trunk) is a wall the flock stops at.
// clearAxis(bot, geo, kFrom, kTo) reads the stand of every axis column from kFrom to kTo (standAt), names each
// spike, and digs down to the higher neighbour's stand (feet and head cells) every spike within DIG_REACH of the
// body, sparing build voxels (navigator.loadProtectedBlocks) and fluids → { spikes, dug, out_of_reach, spared },
// spikes as `k:y` text.
const DIG_REACH = 4.5;
async function clearAxis(bot, geo, kFrom, kTo) {
  const { gate: g, axis: n } = geo;
  const col = k => ({ x: g.x + n.x * k, z: g.z + n.z * k });
  const ys = [];
  for (let k = kFrom - 1; k <= kTo + 1; k++) { const c = col(k), s = standAt(bot, c.x, c.z, g.y); ys.push({ k, ...c, y: s ? s.y : null }); }
  const out = { spikes: [], dug: 0, out_of_reach: 0, spared: 0 };
  const isProtected = require('@locomotion/navigator').loadProtectedBlocks(bot) || new Set();
  const { isBlockPassable } = require('@utils/pathfinding_utils');
  const { performDig } = require('@utils/movement/dig_authority');
  for (let i = 1; i < ys.length - 1; i++) {
    const a = ys[i - 1], c = ys[i], b = ys[i + 1];
    if (a.y === null || b.y === null) continue;
    const t = Math.max(a.y, b.y);
    if (c.y !== null && c.y < t + 2) continue;
    out.spikes.push(`${c.k}:${c.y === null ? 'none' : c.y}`);
    for (const y of [t, t + 1]) {
      const p = new Vec3(c.x, y, c.z), blk = bot.blockAt(p);
      if (!blk || isBlockPassable(blk)) continue;
      if (isProtected.has(`${p.x},${p.y},${p.z}`) || /water|lava/.test(blk.name)) { out.spared++; continue; }
      if (bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > DIG_REACH) { out.out_of_reach++; continue; }
      if (await performDig(bot, p, blk, TAG)) out.dug++;
    }
  }
  if (out.spikes.length) watcher.summary(TAG, `axis spikes ${out.spikes.join(',')}: dug ${out.dug}, out of reach ${out.out_of_reach}, spared ${out.spared}`);
  return out;
}


// A tending word is sent to the fleet the moment it is written: the chair otherwise travels only when the body moves
// (foreman_link.startBodyCellPublisher), and a shepherd standing still at its post would never be heard.
function writeMagnet(botId, fields) {
  const hq = require('@kernel/corporate_headquarters');
  const chair = hq.readBoardroomChair(botId, {}) || {};
  if (!chair.magnet) return;
  chair.magnet = { ...chair.magnet, ...fields };
  hq.writeBoardroomChair(botId, chair);
  require('@utils/external_library_guard')
    .guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}
// The two tending roles, each one claim and one magnet field.
const ROLES = { park: { key: parkKey, field: 'herd_park' }, shepherd: { key: shepherdKey, field: 'herd_shepherd' } };
async function tryRole(role, geo, botId) {
  const { claimFirst } = require('@utils/target_claims');
  const r = ROLES[role];
  const held = !!(await claimFirst([geo.gate], { keyOf: () => r.key(geo) })).pick;
  if (held) writeMagnet(botId, { [r.field]: r.key(geo) });
  return held;
}
function releaseRole(role, geo, botId) {
  const r = ROLES[role];
  // Giving a role up ends what it was for, whatever the outcome: the one place a tender's or shepherd's span closes.
  const activity = require('@api/activity_log');
  for (const kind of role === 'park' ? ['pen_crossing', 'herding', 'shearing', 'culling'] : ['shepherd']) activity.end(kind, { why: 'role_released' });
  require('@utils/target_claims').releaseTarget(r.key(geo));
  writeMagnet(botId, { [r.field]: null, herd_phase: role === 'park' ? { pen: penKey(geo), phase: 'out' } : null });
}
// rolePeer(bot, geo, selfId, role) → { id, entity } of the peer whose magnet names this pen's role, the entity null
// when this body does not sense it; null when no peer holds it.
function rolePeer(bot, geo, selfId, role) {
  const r = ROLES[role], key = r.key(geo);
  const board = require('@kernel/corporate_headquarters').getFullBoardroom({});
  const id = Object.keys(board).find(b => b !== selfId && board[b]?.magnet?.[r.field] === key);
  if (!id) return null;
  const e = bot.players?.[id]?.entity;
  return { id, entity: e && e.position ? e : null };
}
const tryPark = (geo, botId) => tryRole('park', geo, botId);
const releasePark = (geo, botId) => releaseRole('park', geo, botId);
const tryShepherd = (geo, botId) => tryRole('shepherd', geo, botId);
const releaseShepherd = (geo, botId) => releaseRole('shepherd', geo, botId);
// parkedTender: the peer holding the standby cell (the tender), or null.
const parkedTender = (bot, geo, selfId) => rolePeer(bot, geo, selfId, 'park');
// shepherdOf: the peer holding the post (the shepherd), or null.
const shepherdOf = (bot, geo, selfId) => rolePeer(bot, geo, selfId, 'shepherd');
// THE TENDING BOARD. Each body says where it is in its part on its magnet, `herd_phase` { pen, phase }, sent to the
// fleet as it is said (writeMagnet), and the other reads it (phaseOf):
//   tender    en_route (to its work: an animal to lead, the pen to shear) · near (HERDING.call_shepherd_blocks from the
//   (bringer, standby cell, or a shearer on its short walk there: the board calls the shepherd now) · standby (at the
//   shearer)  standby cell) · crossing (the gate open, going in) · working (inside: the drop-off, the shearing) · out
//             (out of the pen with the gate shut, the standby cell given up: releaseRole)
//   shepherd  en_route (to the post) · holding (at the long side, wheat shown, the penned animals checked)
// sayPhase(geo, botId, role, phase) says it and writes one line; phaseOf(geo, peerId) → that peer's phase for this
// pen, or null. CALLING_PHASES are the tender's words the board posts the shepherd job on.
const TENDER_PHASES = ['en_route', 'near', 'standby', 'crossing', 'working', 'out'];
const CALLING_PHASES = new Set(['near', 'standby']);
const PHASES = Object.freeze({ bringer: TENDER_PHASES, shearer: TENDER_PHASES, culler: TENDER_PHASES, shepherd: ['en_route', 'holding'] });
const penKey = geo => `pen:${geo.gate.x},${geo.gate.y},${geo.gate.z}`;
// The phases that begin an activity span (activity_log), placed at the gate; releaseRole ends them.
const PHASE_ACTIVITY = Object.freeze({
  'bringer:en_route': 'herding', 'bringer:crossing': 'pen_crossing', 'shearer:crossing': 'pen_crossing',
  'culler:crossing': 'pen_crossing', 'shearer:working': 'shearing', 'culler:working': 'culling', 'shepherd:holding': 'shepherd',
});
function sayPhase(geo, botId, role, phase) {
  if (!PHASES[role] || !PHASES[role].includes(phase)) throw new Error(`[${TAG}] CODING VIOLATION: no tending phase '${phase}' for role '${role}'.`);
  writeMagnet(botId, { herd_phase: { pen: penKey(geo), phase } });
  watcher.summary(TAG, `TENDING role=${role} phase=${phase} pen=${penKey(geo)}`);
  const kind = PHASE_ACTIVITY[`${role}:${phase}`];
  if (kind) require('@api/activity_log').start(kind, { at: geo.gate });
}
function phaseOf(geo, peerId) {
  const p = require('@kernel/corporate_headquarters').getFullBoardroom({})[peerId]?.magnet?.herd_phase;
  return p && p.pen === penKey(geo) ? p.phase : null;
}

// THE TENDING CLOCK. tendClock(role) → { to(step), done() → { t, total } }: every job at the pen is timed by step, and
// each change writes one `[HERD_STEP]` line: the step done and its seconds, the step begun, and the seconds since the
// job began. done() closes the last step; t holds each step's seconds summed, total the whole job's.
function tendClock(role) {
  const t = {};
  const started = Date.now();
  let cur = null, at = started;
  const s = ms => (ms / 1000).toFixed(1);
  const to = name => {
    const now = Date.now();
    if (cur) t[cur] = +((t[cur] || 0) + (now - at) / 1000).toFixed(1);
    watcher.summary('herd_step', `step role=${role} done=${cur || '-'} done_s=${cur ? s(now - at) : '-'} next=${name || 'end'} total_s=${s(now - started)}`);
    cur = name; at = now;
  };
  return { to, done: () => { to(null); return { t, total: +((Date.now() - started) / 1000).toFixed(1) }; } };
}

// THE SERVER'S WORD ON AN ANIMAL. A body sees a lamb but neither a grown animal's breeding cooldown, its love mode, nor
// whether it is shorn; the server holds all three: Age (ticks until it may breed again, below 0 a lamb), InLove (ticks
// of love mode left), Sheared (1 shorn, 0 woolly). askData(entities, tags, what) → [{ entity, <tag>: number }] for
// every animal the server answered every tag for, or null when the ask failed. One rcon session for the lot.
async function askData(entities, tags, what) {
  const withId = entities.filter(e => typeof e.uuid === 'string' && e.uuid);
  if (!withId.length) return [];
  const cmds = withId.flatMap(e => tags.map(tag => `data get entity ${e.uuid} ${tag}`));
  const r = await guardExternal(TAG, `ask the server ${what}`, () => require('@utils/rcon_link').once(cmds));
  if (!r.ok) { watcher.warn(TAG, `the server could not be asked ${what}: ${r.reason}`); return null; }
  const num = body => { const m = /entity data: (-?\d+)/.exec(body || ''); return m ? parseInt(m[1], 10) : null; };
  const out = [];
  withId.forEach((e, k) => {
    const row = { entity: e };
    tags.forEach((tag, j) => { row[tag] = num(r.value[tags.length * k + j]?.body); });
    if (tags.every(tag => row[tag] !== null)) out.push(row);
  });
  return out;
}
// askBreeding(entities) → [{ entity, age, in_love }] or null; askWool(entities) → [{ entity, woolly, color }] or null, the
// color by the server's Color tag (architect_config.WOOL_COLORS).
async function askBreeding(entities) {
  const r = await askData(entities, ['Age', 'InLove'], 'which animals can breed');
  return r && r.map(a => ({ entity: a.entity, age: a.Age, in_love: a.InLove }));
}
async function askWool(entities) {
  const { WOOL_COLORS } = require('@thinking/architect_config');
  const r = await askData(entities, ['Sheared', 'Color'], 'which animals are shorn, and their colors');
  return r && r.map(a => ({ entity: a.entity, woolly: a.Sheared === 0, color: WOOL_COLORS[a.Color] || null }));
}
// THE PEN'S SIZE. flockOf(geo) → the animals the pen holds when full: the pen row's per_cell animals on each interior
// cell, or else HERDING.grass_per_animal cells of interior for each animal.
function flockOf(geo) {
  const cells = (geo.interior.x2 - geo.interior.x1 + 1) * (geo.interior.z2 - geo.interior.z1 + 1);
  const perCell = HERDING.pens[geo.structure]?.per_cell;
  return perCell ? Math.floor(cells * perCell) : Math.floor(cells / HERDING.grass_per_animal);
}
// THE ANIMALS ON THEIR WAY IN: every animal a peer's herd ties on its string (magnet `animal_ids`, herd_manager), one
// for a peer whose magnet holds a herd job and has not yet tied its string (job_type herd_animal). Counted for one pen
// (the job's structure): each pen fills on its own.
function herdsUnderway(selfId, structure) {
  const { JOB_TYPE } = require('@thinking/architect_config');
  return Object.entries(require('@kernel/corporate_headquarters').getFullBoardroom({}))
    .filter(([id, chair]) => id !== selfId && chair?.magnet?.job_type === JOB_TYPE.herd_animal && chair.magnet.structure === structure)
    .reduce((n, [, chair]) => n + (Array.isArray(chair.magnet.animal_ids) ? chair.magnet.animal_ids.length : 1), 0);
}
// THE TENDING UNDERWAY: peers whose magnet holds a herd, shear or cull job at this pen (the job's structure), each a
// tender on its way to the standby cell or at it. One tender works a pen at a time.
function tendingUnderway(selfId, structure) {
  const { JOB_TYPE } = require('@thinking/architect_config');
  const tending = new Set([JOB_TYPE.herd_animal, JOB_TYPE.shear_animal, JOB_TYPE.cull_animal]);
  return Object.entries(require('@kernel/corporate_headquarters').getFullBoardroom({}))
    .filter(([id, chair]) => id !== selfId && tending.has(chair?.magnet?.job_type) && chair.magnet.structure === structure).length;
}

// The pen's animals by color as the server last said, and when: { woolly, byColor: { color: { penned, woolly } }, at }
// (assessors/ranching asks at most every HERDING.wool_ask_ms; shear_executor after it shears, dye_executor after it
// dyes). noteWool(geo, asked) takes askWool's answer. The memory is this body's (Invariant D).
const _wool = new Map();
function noteWool(geo, asked) {
  const byColor = {};
  for (const a of asked) {
    const c = byColor[a.color] || (byColor[a.color] = { penned: 0, woolly: 0 });
    c.penned++;
    if (a.woolly) c.woolly++;
  }
  _wool.set(penKey(geo), { woolly: asked.filter(a => a.woolly).length, byColor, at: Date.now() });
}
const woolSeen = geo => _wool.get(penKey(geo)) || null;

// shepherdAt(bot, geo, selfId) → the shepherd's id once a peer holding the post says it is holding and is seen
// holding wheat; null until then. A tender opens the gate on nothing less.
function shepherdAt(bot, geo, selfId) {
  const k = rolePeer(bot, geo, selfId, 'shepherd');
  if (!k || !k.entity || !holdsWheat(k.entity)) return null;
  return phaseOf(geo, k.id) === 'holding' ? k.id : null;
}
// shepherdSeen(bot, geo, selfId) → what a tender sees of the shepherd, as k=v text: who holds the post, its word,
// whether this body senses it and whether it shows wheat. The reason a tender is still waiting is in it.
function shepherdSeen(bot, geo, selfId) {
  const k = rolePeer(bot, geo, selfId, 'shepherd');
  if (!k) return 'post_holder=- word=- seen=false wheat=false';
  return `post_holder=${k.id} word=${phaseOf(geo, k.id) || '-'} seen=${!!k.entity} wheat=${!!(k.entity && holdsWheat(k.entity))}`;
}
// awaitShepherd(bot, geo, selfId, ms, whileWaiting) → the shepherd's id once one is holding (shepherdAt), or null when
// `ms` ran out. Every HERDING.wait_say_ms it writes one `[HERD_WAIT]` line of what it sees (shepherdSeen), so a tender
// standing still says why. whileWaiting() runs between reads (a bringer keeps its wheat shown there).
async function awaitShepherd(bot, geo, selfId, ms, whileWaiting) {
  const started = Date.now();
  let saidAt = started;
  while (Date.now() - started < ms) {
    const id = shepherdAt(bot, geo, selfId);
    if (id) return id;
    if (whileWaiting) await whileWaiting();
    if (Date.now() - saidAt >= HERDING.wait_say_ms) {
      saidAt = Date.now();
      watcher.summary('herd_wait', `wait for=shepherd waited_s=${((saidAt - started) / 1000).toFixed(1)} ${shepherdSeen(bot, geo, selfId)}`);
    }
    await pause();
  }
  return shepherdAt(bot, geo, selfId);
}

// A PENNED ANIMAL IS NEVER STRUCK. pennedAnywhere(e) → whether `e` is penned in any of the crew's pens: by the
// keeper's ids for a pen it holds in sight (pen_keeper), else inside a sited pen's fence. A herder's guard hits the
// animals of another kind away from its wheat (herd_executor.shooGuard), and the neighbouring pen's flock, outside
// this pen and following the wheat through its own fence, is not one of them.
function pennedAnywhere(e) {
  const { FARM_PENS } = require('@thinking/architect_config');
  for (const structure of FARM_PENS) {
    const kept = keptPen(structure);
    if (kept && kept.seen) { if (kept.ids.includes(e.id)) return true; continue; }
    const rec = penOf(structure);
    if (rec && insidePen(penGeometry(rec), e.position)) return true;
  }
  return false;
}

// ONE KIND TO A PEN. foreignNear(bot, geo, at, reach) → the animals wheat tempts as well (HERDING.wheat_followers)
// that are not the pen's kind, outside it and penned nowhere, within `reach` of `at`: a gate opened with one at
// heel takes it in.
function foreignNear(bot, geo, at, reach) {
  return require('@utils/ring_scan').entitiesNearest(bot, {
    center: at, reach, match: e => HERDING.wheat_followers.includes(e.name) && e.name !== geo.animal && e.isValid !== false
      && !insidePen(geo, e.position) && !pennedAnywhere(e),
  }).map(r => r.entity);
}

// The animals of `kind` outside the pen within `reach` of `at`, nearest first.
function animalsNear(bot, geo, kind, at, reach) {
  return require('@utils/ring_scan').entitiesNearest(bot, {
    center: at, reach, match: e => e.name === kind && e.isValid !== false && !insidePen(geo, e.position),
  }).map(r => r.entity);
}

const holdsWheat = e => (e.equipment || []).slice(0, 2).some(it => it && it.name === LURE);
const blockedAt = c => `pen_cell_blocked_at_${c.x}_${c.y}_${c.z}`;
const onAxis = (geo, p) => (geo.axis.x === 0 ? Math.floor(p.x) === geo.gate.x : Math.floor(p.z) === geo.gate.z);

// ── THE GATE IS OPEN ONLY FOR ONE STEP THROUGH IT ───────────────────────────────────────────────────
// passGate(bot, geo, inward) → null once the body stands one cell past the gate with it shut behind, or a fault. The
// body opens the gate from the cell next to it (outer going in, inner going out), steps onto the gate cell and one cell
// past, and shuts it from there: it is never more than one block from the gate while the gate is open. A cell it
// cannot step onto shuts the gate before the fault is returned.
async function passGate(bot, geo, inward) {
  const [near, far] = inward ? [geo.outer, geo.inner] : [geo.inner, geo.outer];
  if (!(await stepInto(bot, near))) return blockedAt(near);
  const fault = await setGates(bot, geo, true, [geo.gate]);
  if (fault) return fault;
  for (const cell of [geo.gate, far]) {
    if (!(await stepInto(bot, cell))) {
      await setGates(bot, geo, false);
      return blockedAt(cell);
    }
  }
  return setGates(bot, geo, false);
}

// enterPen(bot, geo) → null once the body stands on the inner cell with the gate shut behind it, or a fault. The body
// holds the gate (holdGate) and comes from the lineup cell, straight in along the axis. For a tender that works inside
// (a shearer): the gate stays shut while it works.
async function enterPen(bot, geo) {
  if (!(await stepInto(bot, geo.lineup))) return 'lineup_cell_blocked';
  return passGate(bot, geo, true);
}

// leavePen(bot, pen, kind, { gateHeld }) → { fault, escaped, escaped_at } once the body stands outside the shut gate,
// or a fault. gateHeld: the body already holds the gate from its crossing in (herd_executor, shear_executor), so it
// leaves under that hold; the gate is given up when the body is out, or at once when it is not in the pen: a body
// outside that holds the gate opened it, so it shuts it before giving it up.
async function leavePen(bot, pen, kind, { gateHeld = false } = {}) {
  const geo = penGeometry(pen);
  if (!insidePen(geo, bot.entity.position)) {
    if (!gateHeld) return { fault: null, escaped: 0 };
    const fault = await setGates(bot, geo, false);
    releaseGate(geo);
    return { fault, escaped: 0 };
  }
  if (bot.heldItem?.name === LURE) {
    await guardExternal(TAG, 'put the wheat away before leaving the pen', () => bot.unequip('hand'));
    lureLine(bot, 'away', 'leave_pen_hand');
  }
  const offHand = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
  if (offHand?.name === LURE) {
    await guardExternal(TAG, 'take the wheat out of the off-hand before leaving the pen', () => bot.unequip('off-hand'));
    lureLine(bot, 'away', 'leave_pen');
  }
  if (bot.heldItem?.name === LURE || bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === LURE) {
    if (gateHeld) releaseGate(geo);
    return { fault: 'wheat_still_shown_at_the_gate' };
  }
  if (!gateHeld && !(await holdGate(bot, geo))) return { fault: 'gate_held_by_a_peer' };
  return withCleanup(TAG, 'release the pen gate after leaving', () => crossOut(bot, geo, kind), () => releaseGate(geo));
}

// crossOut: to the inner cell, then out through the gate (passGate); no wait for the doorway to clear. A body on the gate's axis walks
// straight back along it; elsewhere in the pen it walks to the inner cell first.
async function crossOut(bot, geo, kind) {
  if (!onAxis(geo, bot.entity.position)) {
    await require('@locomotion/locomotion_dispatcher').goTo({ x: geo.inner.x, y: geo.inner.y, z: geo.inner.z, spare_builds: true, leg: 'work' });
  }
  if (!(await stepInto(bot, geo.inner))) return { fault: blockedAt(geo.inner) };
  const before = penned(bot, geo, kind).map(a => a.id);
  const fault = await passGate(bot, geo, false);
  if (fault) return { fault };
  // Out and shut, the body steps clear of the doorway before anything else is planned, so no route of its own walks
  // it back through the gate cell.
  await stepInto(bot, geo.lineup);
  // An escaped animal is one penned as the body reached the doorway and not penned once the gate shut; where it stands
  // says whether it walked out through the doorway or the box lost sight of it.
  const after = new Set(penned(bot, geo, kind).map(a => a.id));
  const out = before.filter(id => !after.has(id)).map(id => bot.entities[id]);
  const at = a => (a && a.position ? `${Math.floor(a.position.x)},${Math.floor(a.position.y)},${Math.floor(a.position.z)}` : 'unsensed');
  return { fault: null, escaped: out.length, escaped_at: out.length ? out.map(at).join('/') : null };
}

// THE PEN'S CENSUS IS ON HQ, under the pen's own building chair `pen_census` (assessors/ranching writes it when the count
// changes): how many animals it holds of its flock, their colors and woolly counts, who counted and when. It rides
// the building room's relay and is kept in every body's HQ file, so any body can ask how many are in the pen, and it
// is the only record of the penned animals: a sector scan leaves them out (sector_scan, inCrewPen).
const CENSUS_CHAIR = 'pen_census';
function writeCensus(structure, census) {
  require('@kernel/corporate_headquarters').writeBuildingChair(structure, CENSUS_CHAIR, { ...census, at: Date.now() });
}
function censusOf(structure) {
  return require('@kernel/corporate_headquarters').readBuildingChair(structure, CENSUS_CHAIR, null);
}
// THE PEN'S BREEDING CLOCK rides each body's boardroom chair, `breed_rounds` { [structure]: { at, pairs, fed } }: the
// chair is what the foreman broadcasts whole, so every body reads every peer's rounds (a building chair is kept by the
// foreman as it first locked and never carries a body's later write). breed_manager writes the round it ran;
// breedRoundOf(structure) → the latest round any body ran at the pen, with `by`, or null.
function writeBreedRound(structure, round) {
  const hq = require('@kernel/corporate_headquarters');
  const botId = process.env.BOT_ID || 'default';
  const chair = hq.readBoardroomChair(botId, {}) || {};
  // `at` is the round's first feed when it fed (the game's cooldown starts there), else now.
  chair.breed_rounds = { ...(chair.breed_rounds || {}), [structure]: { ...round, at: Number.isFinite(round.at) ? round.at : Date.now() } };
  hq.writeBoardroomChair(botId, chair);
  require('@utils/external_library_guard')
    .guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}
// THE STRANGERS A CULL COULD NOT KILL: writeStrangerMiss(structure, ids) notes them on this body's chair; strangersMissed(structure)
// → Set of the ids any body noted within HERDING.unreachable_skip_ms, which assessors/ranching leaves out of the next cull.
function writeStrangerMiss(structure, ids) {
  const hq = require('@kernel/corporate_headquarters');
  const botId = process.env.BOT_ID || 'default';
  const chair = hq.readBoardroomChair(botId, {}) || {};
  const now = Date.now();
  const pen = { ...((chair.stranger_misses || {})[structure] || {}) };
  for (const id of ids) pen[id] = now;
  chair.stranger_misses = { ...(chair.stranger_misses || {}), [structure]: pen };
  hq.writeBoardroomChair(botId, chair);
}
function strangersMissed(structure) {
  const { HERDING } = require('@thinking/architect_config');
  const out = new Set();
  for (const chair of Object.values(require('@kernel/corporate_headquarters').getFullBoardroom({}))) {
    const pen = chair?.stranger_misses?.[structure] || {};
    for (const [id, at] of Object.entries(pen)) if (Date.now() - at < HERDING.unreachable_skip_ms) out.add(Number(id));
  }
  return out;
}
function breedRoundOf(structure) {
  const board = require('@kernel/corporate_headquarters').getFullBoardroom({});
  let latest = null;
  for (const [by, chair] of Object.entries(board)) {
    const r = chair?.breed_rounds?.[structure];
    if (r && Number.isFinite(r.at) && (!latest || r.at > latest.at)) latest = { ...r, by };
  }
  return latest;
}
// inCrewPen(p) → true when `p` stands inside one of this crew's locked pens (architect_config FARM_PENS).
function inCrewPen(p) {
  return require('@thinking/architect_config').FARM_PENS
    .some(structure => { const pen = penOf(structure); return !!pen && insidePen(penGeometry(pen), p); });
}
// jobPen(botId) → { structure, pen } for the pen this body's job names (its magnet's structure), one of the crew's pens
// and locked; null otherwise. A pen job's manager works the pen its job was posted for (assessors/ranching).
function jobPen(botId) {
  const structure = require('@kernel/corporate_headquarters').readBoardroomChair(botId, {})?.magnet?.structure;
  if (!require('@thinking/architect_config').FARM_PENS.includes(structure)) return null;
  const pen = penOf(structure);
  return pen ? { structure, pen } : null;
}

module.exports = {
  writeCensus, censusOf, writeBreedRound, breedRoundOf, writeStrangerMiss, strangersMissed, inCrewPen, jobPen, passGate,
  penOf, penAt, keptPen, lureLine, penGeometry, insidePen, waitFor, stepInto, setGates, penned, holdGate, releaseGate, enterPen, leavePen,
  tendingCells, tryPark, releasePark, tryShepherd, releaseShepherd, parkedTender, shepherdOf, shepherdAt, shepherdSeen, awaitShepherd,
  sayPhase, phaseOf, tendClock, askBreeding, askWool, CALLING_PHASES, noteWool, woolSeen, flockOf, herdsUnderway, tendingUnderway,
  shepherdCellToward, sweepPath, doorwayClear, animalsNear, foreignNear, clearAxis,
};
