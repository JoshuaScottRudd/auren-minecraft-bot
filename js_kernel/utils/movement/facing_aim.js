// How a block whose placed STATE matters is placed from wherever the body stands. It chooses the block to
// click, the face, the cursor point, the rotation to report, whether to sneak, and whether the block must
// be used once after it lands (to open it). It never turns the head and never places; place_authority does
// both, in that order.
//
// ── WHAT THE SERVER DECIDES, AND FROM WHAT ──────────────────────────────────────────────────────────────
// A placed block's state is not in the place packet. The server derives it from what the player sends:
// the ROTATION the player last reported (yaw, and pitch for six-way blocks), WHICH FACE was clicked at WHAT
// CURSOR POINT, and whether the player is SNEAKING. Each family below names the rule it follows.
//
// ── THE SNAP: ANY STATE FROM ONE STAND (Law 19) ─────────────────────────────────────────────────────────
// A vanilla server checks that the clicked block is within reach and never checks that the look ray meets
// the clicked face. So the reported rotation is set exactly on what the rule needs, for the moment of the
// click, and the click lands on any solid neighbour face in reach, seen or not — an anchor stays one
// stand, with no extra anchors needed for facing.
//
// ── KEYS THE GAME DECIDES ITSELF ────────────────────────────────────────────────────────────────────────
// A downloaded blueprint's block state carries keys no placement sets: a stair's corner shape, a fence's
// connections, waterlogging, redstone power, a bed's occupancy. The game derives them from neighbours once
// the neighbours stand. DERIVED names them; they are dropped from what is asked and never compared. Any
// other key a family does not control is a contradiction and throws (Law 13).

'use strict';

const Vec3 = require('vec3');

const DERIVED = new Set([
  'shape', 'waterlogged', 'powered', 'occupied', 'in_wall', 'north', 'south', 'east', 'west', 'up',
  'distance', 'persistent', 'snowy', 'level', 'has_bottle_0', 'has_bottle_1', 'has_bottle_2', 'side_chain',
  'bottom', 'signal_fire', 'lit', 'attached', 'disarmed', 'triggered', 'enabled', 'extended', 'note', 'instrument',
  // `power` — the SIGNAL STRENGTH a weighted pressure plate or a redstone wire is currently putting out,
  // which is a reading of what is standing on it and not a choice anyone makes when placing it. The header
  // above already named redstone power as a key the game decides; `powered` (the boolean form) was listed
  // and `power` (the 0–15 form) was not, so a downloaded castle's heavy_weighted_pressure_plate arrived
  // carrying `power=0` and the plan's startup check reported a block family with no placement rule. There
  // is no rule to write: the plate chooses nothing.
  'power',
]);

const H = ['north', 'east', 'south', 'west'];                   // clockwise order
const VEC = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
const cw = (d) => H[(H.indexOf(d) + 1) % 4];
const ccw = (d) => H[(H.indexOf(d) + 3) % 4];
const normalOf = (d) => new Vec3(...VEC[d]);
const isH = (d) => H.includes(d);
const isSix = (d) => Object.prototype.hasOwnProperty.call(VEC, d);

// A cursor inside the clicked neighbour for a face, at a height fraction on side faces.
function cursor(normalDir, height = 0.5) {
  const n = VEC[normalDir];
  if (normalDir === 'up') return new Vec3(0.5, 1, 0.5);
  if (normalDir === 'down') return new Vec3(0.5, 0, 0.5);
  return new Vec3(n[0] === 1 ? 1 : n[0] === -1 ? 0 : 0.5, height, n[2] === 1 ? 1 : n[2] === -1 ? 0 : 0.5);
}
// Every face that gives a stair/slab/trapdoor half: the top of the block below makes bottom, the bottom of
// the block above makes top, a side face gives either by cursor height (a quarter block from the middle).
function halfFaces(half) {
  const out = [{ normal: half === 'top' ? 'down' : 'up' }];
  for (const d of H) out.push({ normal: d, cursor: cursor(d, half === 'top' ? 0.75 : 0.25) });
  return out;
}
const anyFace = () => ['up', 'down', ...H].map(normal => ({ normal }));
const look = (dir) => ({ look: dir });

// The rotation a standing sign or banner shows is its segment of (player yaw + 180°), 16 to a turn.
// Minecraft yaw degrees: 0 = south, 90 = west. mineflayer yaw radians: 0 = north, +π/2 = west, and
// mcDegrees = 180 − deg(mineflayer yaw). So a wanted rotation r needs mineflayer yaw −r·22.5°.
const rotationYaw = (r) => -(Number(r) * Math.PI / 8);

function need(state, key, allowed, block) {
  const v = state[key];
  if (v === undefined || !allowed.includes(String(v))) {
    throw new Error(`[facing_aim] CODING VIOLATION (Law 13): ${block} asks for ${key}=${JSON.stringify(v)}; it takes ${allowed.join(', ')}.`);
  }
  return String(v);
}
const withDefault = (state, key, def) => (state[key] === undefined ? def : String(state[key]));

// THE RULE TABLE. `options(state)` lists every way to get the state: the clicked face, the cursor, the
// look (a direction, or a raw yaw for rotations), sneak. `check` reads the world for what the options
// cannot choose (a partner chest, a door's neighbours). `use` says the block is right-clicked once after
// it lands. Families are matched on the BLOCK name the cell must show; the item is the caller's.
const FAMILIES = [
  {
    family: 'stairs', matches: n => /_stairs$/.test(n), controls: ['facing', 'half'],
    options: (s, b) => { const f = need(s, 'facing', H, b); return halfFaces(withDefault(s, 'half', 'bottom')).map(o => ({ ...o, ...look(f) })); },
  },
  {
    family: 'slab', matches: n => /_slab$/.test(n), controls: ['type'],
    options: (s, b) => halfFaces(need(s, 'type', ['bottom', 'top'], b)),
    // A slab clicked onto the open half of a single slab of its own kind joins it as a double in THAT cell
    // and leaves the wanted cell empty: the open top of a bottom slab, the open underside of a top slab,
    // and any side of a single slab of the other half (the cursor height that gives the wanted half is the
    // neighbour's open half). Those faces are not clicks for this slab.
    refuses: (ref, o, s, b) => {
      if (ref.name !== b) return false;
      const type = String(ref.getProperties().type);
      if (type === 'double') return false;
      if (o.normal === 'up') return type === 'bottom';
      if (o.normal === 'down') return type === 'top';
      return type !== String(s.type);
    },
  },
  {
    // A trapdoor clicked on a side takes the clicked face as its facing and the cursor height as its half;
    // clicked on a top or bottom face it takes the opposite of the look.
    family: 'trapdoor', matches: n => /_trapdoor$/.test(n), controls: ['facing', 'half', 'open'],
    options: (s, b) => {
      const f = need(s, 'facing', H, b); const half = withDefault(s, 'half', 'bottom');
      return [
        { normal: f, cursor: cursor(f, half === 'top' ? 0.75 : 0.25) },
        { normal: half === 'top' ? 'down' : 'up', ...look(OPP[f]) },
      ];
    },
    use: (s) => String(s.open) === 'true',
  },
  {
    family: 'door', matches: n => /_door$/.test(n) && n !== 'iron_door', controls: ['facing', 'half', 'hinge', 'open'],
    options: (s, b) => {
      const f = need(s, 'facing', H, b);
      if (withDefault(s, 'half', 'lower') !== 'lower') throw new Error(`[facing_aim] CODING VIOLATION (Law 13): ${b} half=upper is not placed; the upper half comes with the lower one.`);
      const hinge = withDefault(s, 'hinge', 'left');
      // Minecraft's hinge when neither side decides it: RIGHT when the click lands on the side of the cell
      // clockwise of the facing. Top face of the block below, cursor a quarter block off centre.
      const [j, , k] = VEC[f]; const right = hinge === 'right'; const c = new Vec3(0.5, 1, 0.5);
      if (j !== 0) c.z = (j > 0) === right ? 0.75 : 0.25; else c.x = (k < 0) === right ? 0.75 : 0.25;
      return [{ normal: 'up', cursor: c, ...look(f) }];
    },
    check: (bot, pos, s) => {
      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (above && above.boundingBox !== 'empty') return `the cell above (${pos.x},${pos.y + 1},${pos.z}) holds ${above.name}; a door needs it empty`;
      // The hinge is the game's to set, from the blocks beside the door: no hinge is refused here, and the
      // door that results stands for the plan's (standsFor below).
      return null;
    },
    // A door of the asked facing and half is the plan's door whichever side the game hung it on.
    standsFor: (got, s) => String(got.facing) === String(s.facing) && (s.half === undefined || String(got.half) === String(s.half)),
    use: (s) => String(s.open) === 'true',
  },
  {
    family: 'fence_gate', matches: n => /_fence_gate$/.test(n), controls: ['facing', 'open'],
    options: (s, b) => { const f = need(s, 'facing', H, b); return anyFace().map(o => ({ ...o, ...look(f) })); },
    use: (s) => String(s.open) === 'true',
  },
  {
    family: 'bed', matches: n => /_bed$/.test(n), controls: ['facing', 'part'],
    options: (s, b) => {
      const f = need(s, 'facing', H, b);
      if (withDefault(s, 'part', 'foot') !== 'foot') throw new Error(`[facing_aim] CODING VIOLATION (Law 13): ${b} part=head is not placed; the head comes with the foot.`);
      return [{ normal: 'up', ...look(f) }];
    },
    check: (bot, pos, s) => {
      const head = pos.plus(normalOf(String(s.facing)));
      const bl = bot.blockAt(head);
      return bl && bl.boundingBox !== 'empty' ? `the head cell (${head.x},${head.y},${head.z}) holds ${bl.name}; a bed needs it empty` : null;
    },
  },
  {
    // A chest faces away from the look. Its type: single is forced by sneaking; left/right come from a
    // single chest of the same facing already standing on the correct side (the partner flips to match).
    // The first half of a pair therefore goes down as a single; `stage` names that state, and `standsFor`
    // lets that single count as the half it will become.
    family: 'chest', matches: n => n === 'chest' || n === 'trapped_chest', controls: ['facing', 'type'],
    stage: (bot, pos, s) => {
      const type = withDefault(s, 'type', 'single');
      if (type === 'single') return s;
      const bl = bot.blockAt(pos.plus(normalOf(type === 'left' ? cw(String(s.facing)) : ccw(String(s.facing)))));
      return bl && (bl.name === 'chest' || bl.name === 'trapped_chest') ? s : { ...s, type: 'single' };
    },
    standsFor: (props, s) => props.type === 'single' && String(props.facing) === String(s.facing),
    options: (s, b) => {
      const f = need(s, 'facing', H, b); const type = withDefault(s, 'type', 'single');
      const faces = anyFace().filter(o => o.normal !== 'down').map(o => ({ ...o, ...look(OPP[f]), sneak: type === 'single' }));
      // A sneaking click on the partner's facing side pairs with it, whatever else is around the cell.
      return type === 'single' ? faces : [...faces, { normal: type === 'left' ? ccw(f) : cw(f), ...look(OPP[f]), sneak: true }];
    },
    check: (bot, pos, s) => {
      const f = String(s.facing); const type = withDefault(s, 'type', 'single');
      if (type === 'single') return null;
      const side = pos.plus(normalOf(type === 'left' ? cw(f) : ccw(f)));
      const bl = bot.blockAt(side);
      const ok = !!bl && (bl.name === 'chest' || bl.name === 'trapped_chest') && bl.getProperties().facing === f && bl.getProperties().type === 'single';
      return ok ? null : `type=${type} needs a single chest facing ${f} at (${side.x},${side.y},${side.z}) first; found ${bl ? bl.name : 'nothing'}`;
    },
  },
  {
    family: 'horizontal_opposite', controls: ['facing'],
    matches: n => ['ender_chest', 'furnace', 'smoker', 'blast_furnace', 'lectern', 'loom', 'stonecutter', 'carved_pumpkin', 'jack_o_lantern', 'beehive', 'chiseled_bookshelf'].includes(n) || /_glazed_terracotta$/.test(n),
    options: (s, b) => { const f = need(s, 'facing', H, b); return anyFace().map(o => ({ ...o, ...look(OPP[f]) })); },
  },
  {
    family: 'horizontal_look', controls: ['facing'],
    matches: n => ['campfire', 'soul_campfire'].includes(n),
    options: (s, b) => { const f = need(s, 'facing', H, b); return anyFace().map(o => ({ ...o, ...look(f) })); },
  },
  {
    family: 'anvil', matches: n => /anvil$/.test(n), controls: ['facing'],
    options: (s, b) => { const f = need(s, 'facing', H, b); return anyFace().map(o => ({ ...o, ...look(ccw(f)) })); },
  },
  {
    // Six-way: the facing is opposite the nearest direction the player looks, up and down included.
    family: 'six_opposite', matches: n => ['barrel', 'dispenser', 'dropper', 'piston', 'sticky_piston'].includes(n), controls: ['facing', 'open'],
    options: (s, b) => {
      const f = need(s, 'facing', Object.keys(VEC), b);
      if (String(s.open) === 'true') throw new Error(`[facing_aim] CODING VIOLATION (Law 13): ${b} open=true exists only while a player holds it open; ask for open=false.`);
      return anyFace().map(o => ({ ...o, ...look(OPP[f]) }));
    },
  },
  {
    // Face-attached: the clicked face decides floor, wall or ceiling. On a wall the facing is the clicked
    // face; on a floor or ceiling it is the look.
    family: 'face_attached', matches: n => /_button$/.test(n) || n === 'lever' || n === 'grindstone', controls: ['face', 'facing'],
    options: (s, b) => {
      const f = need(s, 'facing', H, b); const face = need(s, 'face', ['floor', 'wall', 'ceiling'], b);
      if (face === 'wall') return [{ normal: f }];
      return [{ normal: face === 'floor' ? 'up' : 'down', ...look(f) }];
    },
  },
  {
    // Wall-mounted: the clicked face is the facing. The item is the standing form's (torch, oak_sign, banner).
    family: 'wall_mounted', controls: ['facing'],
    matches: n => ['wall_torch', 'soul_wall_torch', 'redstone_wall_torch', 'ladder', 'tripwire_hook'].includes(n) || /_wall_sign$/.test(n) || /_wall_banner$/.test(n),
    options: (s, b) => [{ normal: need(s, 'facing', H, b) }],
  },
  {
    family: 'standing_torch', matches: n => ['torch', 'soul_torch', 'redstone_torch'].includes(n), controls: [],
    options: () => [{ normal: 'up' }],
  },
  {
    family: 'standing_rotation', matches: n => (/_sign$/.test(n) && !/_wall_sign$|_hanging_sign$/.test(n)) || (/_banner$/.test(n) && !/_wall_banner$/.test(n)), controls: ['rotation'],
    options: (s, b) => [{ normal: 'up', yaw: rotationYaw(need(s, 'rotation', Array.from({ length: 16 }, (_, i) => String(i)), b)) }],
  },
  {
    family: 'lantern', matches: n => n === 'lantern' || n === 'soul_lantern' || n === 'copper_lantern', controls: ['hanging'],
    options: (s, b) => [{ normal: need(s, 'hanging', ['true', 'false'], b) === 'true' ? 'down' : 'up' }],
  },
  {
    family: 'axis', controls: ['axis'],
    // `iron_chain` is `chain` under the 1.21.9 name; `blueprint_importer.RENAMES` maps both directions, so
    // this table lists only one name per block.
    matches: n => /_log$|_wood$|_stem$|_hyphae$/.test(n) || ['chain', 'iron_chain', 'copper_chain', 'hay_block', 'bone_block', 'basalt', 'polished_basalt', 'quartz_pillar', 'purpur_pillar', 'muddy_mangrove_roots', 'deepslate'].includes(n),
    options: (s, b) => {
      const a = need(s, 'axis', ['x', 'y', 'z'], b);
      return { x: ['east', 'west'], y: ['up', 'down'], z: ['north', 'south'] }[a].map(normal => ({ normal }));
    },
  },
  {
    family: 'end_rod', matches: n => n === 'end_rod' || n === 'lightning_rod', controls: ['facing'],
    options: (s, b) => [{ normal: need(s, 'facing', Object.keys(VEC), b) }],
  },
];

function familyOf(name) {
  return FAMILIES.find(f => f.matches(name)) || null;
}

// unplaceableReason — why this block/state pair cannot be placed as asked, or null when it can. Gives the
// same judgment `requested` throws on, without throwing, so a caller can ask before attempting (Law 16). A
// downloaded blueprint's loader checks its whole voxel list through this at startup (Law 26).
//
// The predicate is the implementation; the throw in `requested` is one caller of it (Law 29).
function unplaceableReason(blockName, state) {
  const fam = familyOf(blockName);
  if (fam && fam.family === 'slab' && state && String(state.type) === 'double') {
    return `${blockName} asks for type="double", which one click cannot give; a double slab is built as its full block (blueprint_material_rule).`;
  }
  if (!fam) {
    return `no placement rule for ${blockName} is known (state ${JSON.stringify(state)}). Rules exist for: ${FAMILIES.map(f => f.family).join(', ')}. `
      + 'Measure the family live and add its rule, or remove the state from the blueprint.';
  }
  for (const [k, v] of Object.entries(state || {})) {
    if (DERIVED.has(k)) continue;
    if (!fam.controls.includes(k)) {
      return `${blockName} asks for ${k}=${JSON.stringify(v)}, which the ${fam.family} rule does not set `
        + `(it sets ${fam.controls.join(', ') || 'nothing'}; the game derives ${[...DERIVED].slice(0, 6).join(', ')}…).`;
    }
  }
  return null;
}

// requested — the keys of `state` this placement is answerable for, derived keys removed. Throws on a key
// the family cannot set.
function requested(blockName, state) {
  const why = unplaceableReason(blockName, state);
  if (why) throw new Error(`[facing_aim] CODING VIOLATION (Law 13): ${why}`);
  const fam = familyOf(blockName);
  const out = {};
  for (const [k, v] of Object.entries(state || {})) {
    if (DERIVED.has(k)) continue;
    out[k] = v;
  }
  return { fam, state: out };
}

// findAim — the click that gives `blockName` the wanted `state` at `pos`, from where the body is, or from the
// eye point `from` when a caller asks about a stand the body is not on yet.
//   returns { ok:true, anchor, face, delta, yaw, pitch, sneak, use, family, state }
//        or { ok:false, reason }
// Among usable options the nearest clicked point wins, so the choice is a pure function of the world.
function findAim(bot, pos, blockName, rawState, from = null) {
  const { fam, state: asked } = requested(blockName, rawState);
  const reach = require('@utils/fragment_utils').BLOCK_REACH;
  const isInteractable = require('@api/anchored_repair').isInteractable;
  const target = new Vec3(pos.x, pos.y, pos.z);
  const state = fam.stage ? fam.stage(bot, target, asked) : asked;
  const options = fam.options(state, blockName);
  const blocked = fam.check ? fam.check(bot, target, state) : null;
  if (blocked) return { ok: false, reason: `no_state_click: ${blockName} ${JSON.stringify(state)} at (${pos.x},${pos.y},${pos.z}): ${blocked}` };

  const eye = from ? new Vec3(from.x, from.y, from.z) : bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
  let best = null;
  const seen = [];
  for (const o of options) {
    const n = normalOf(o.normal);
    const ref = bot.blockAt(target.minus(n));
    // A sneaking click places against an interactable block instead of opening it, so an interactable
    // neighbour is a usable face with the click made sneaking. An option that states its own sneak (a chest's
    // single/paired choice) keeps it.
    if (!ref || ref.boundingBox !== 'block') { seen.push(`${o.normal}:${ref ? ref.name : 'unloaded'}`); continue; }
    const sneak = o.sneak !== undefined ? o.sneak : isInteractable(ref.name);
    if (isInteractable(ref.name) && !sneak) { seen.push(`${o.normal}:${ref.name}`); continue; }
    if (fam.refuses && fam.refuses(ref, o, state, blockName)) { seen.push(`${o.normal}:${ref.name} would join it`); continue; }
    const delta = o.cursor || cursor(o.normal);
    const point = ref.position.plus(delta);
    const dist = point.distanceTo(eye);
    if (dist > reach) { seen.push(`${o.normal}:${dist.toFixed(2)}>reach`); continue; }
    if (best && dist >= best.dist) continue;
    best = { o, ref, n, delta, point, dist, sneak };
  }
  if (!best) {
    return { ok: false, reason: `no_state_click: ${blockName} ${JSON.stringify(state)} at (${pos.x},${pos.y},${pos.z}) has no usable neighbour face in reach [${seen.join(' ')}]` };
  }

  const { o, point } = best;
  let yaw; let pitch;
  const toPoint = point.minus(eye);
  const pointYaw = Math.atan2(-toPoint.x, -toPoint.z);
  const pointPitch = Math.atan2(toPoint.y, Math.sqrt(toPoint.x * toPoint.x + toPoint.z * toPoint.z));
  if (o.look === 'up' || o.look === 'down') { yaw = pointYaw; pitch = o.look === 'up' ? Math.PI / 2 : -Math.PI / 2; }
  else if (o.look) { const [vx, , vz] = VEC[o.look]; yaw = Math.atan2(-vx, -vz); pitch = 0; }
  else if (o.yaw !== undefined) { yaw = o.yaw; pitch = pointPitch; }
  else { yaw = pointYaw; pitch = pointPitch; }

  return {
    ok: true, anchor: best.ref, face: best.n, delta: best.delta, yaw, pitch,
    sneak: !!best.sneak, use: fam.use ? fam.use(state) : false, family: fam.family, state,
  };
}

// stateMatches — does the placed block show every property that was asked for? Read off the world.
function stateMatches(block, state) {
  if (!block || !state) return { ok: false, got: null };
  const props = block.getProperties();
  const got = Object.fromEntries(Object.keys(state).map(k => [k, props[k]]));
  return { ok: Object.entries(state).every(([k, v]) => String(props[k]) === String(v)), got };
}

// standsFor — does the block already stand for the wanted state: an exact match, or a staged half
// its family says will become it.
function standsFor(block, state) {
  if (stateMatches(block, state).ok) return true;
  const fam = familyOf(block.name);
  return !!(fam && fam.standsFor && fam.standsFor(block.getProperties(), state));
}

// clickCells — the cells whose solid block serves a click that gives `blockName` the wanted `state` at `pos`:
// one per option of its family, the same cells findAim reads.
function clickCells(bot, pos, blockName, rawState) {
  const { fam, state: asked } = requested(blockName, rawState);
  const target = new Vec3(pos.x, pos.y, pos.z);
  const state = fam.stage ? fam.stage(bot, target, asked) : asked;
  return fam.options(state, blockName).map(o => target.minus(normalOf(o.normal)));
}

module.exports = { findAim, clickCells, stateMatches, standsFor, familyOf, requested, unplaceableReason, DERIVED };
