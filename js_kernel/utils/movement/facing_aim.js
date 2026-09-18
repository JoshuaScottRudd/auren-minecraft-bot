// module: movement/facing_aim — how a block whose placed STATE matters is placed from wherever the body
// stands. It chooses the block to click, the face, the cursor point, the rotation to report, whether to
// sneak, and whether the block must be used once after it lands (to open it). It never turns the head and
// never places; place_authority does both, in that order.
//
// ── WHAT THE SERVER DECIDES, AND FROM WHAT ──────────────────────────────────────────────────────────────
// A placed block's state is not in the place packet. The server derives it from what the player sends:
// the ROTATION the player last reported (yaw, and pitch for six-way blocks), WHICH FACE was clicked at WHAT
// CURSOR POINT, and whether the player is SNEAKING. Each family below names the rule it follows. Every
// rule and every state it can give was placed and read back on a live 1.21.5 server before it was
// written here (scratchpad vol 67 §3, and the full-block matrix in the section that added this table).
//
// ── THE SNAP: ANY STATE FROM ONE STAND (Architect 2026-09-16, a ruling on Law 19) ───────────────────────
// A vanilla server checks that the clicked block is within reach and never checks that the look ray meets
// the clicked face — the fleet's corner-cheat placements have relied on that since June (anchored_repair
// header). So the reported rotation is set EXACTLY on what the rule needs, for the moment of the click,
// and the click lands on any solid neighbour face in reach, seen or not. The Architect ruled this within
// bounds: *"we can bend law 19 if the point is the bot got all the resources fairly and just wants to place
// the block it already has in the correct facing direction. its not cheating or doing anything unfair."*
// That is what lets an anchor stay one stand: no extra anchors for facing.
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
      const f = String(s.facing); const hinge = withDefault(s, 'hinge', 'left');
      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (above && above.boundingBox !== 'empty') return `the cell above (${pos.x},${pos.y + 1},${pos.z}) holds ${above.name}; a door needs it empty`;
      const full = (p) => { const bl = bot.blockAt(p); return !!bl && bl.boundingBox === 'block'; };
      const lowerDoor = (p) => { const bl = bot.blockAt(p); return !!bl && /_door$/.test(bl.name) && bl.getProperties().half === 'lower'; };
      const L = normalOf(ccw(f)); const R = normalOf(cw(f));
      const i = (full(pos.plus(L)) ? -1 : 0) + (full(pos.plus(L).offset(0, 1, 0)) ? -1 : 0) + (full(pos.plus(R)) ? 1 : 0) + (full(pos.plus(R).offset(0, 1, 0)) ? 1 : 0);
      const dl = lowerDoor(pos.plus(L)); const dr = lowerDoor(pos.plus(R));
      let forced = null;
      if (!((!dl || dr) && i <= 0)) forced = 'right';
      else if (!((!dr || dl) && i >= 0)) forced = 'left';
      if (forced && forced !== hinge) return `hinge=${hinge} cannot be set here: the blocks beside the door decide it as ${forced}`;
      return null;
    },
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
    family: 'chest', matches: n => n === 'chest' || n === 'trapped_chest', controls: ['facing', 'type'],
    options: (s, b) => {
      const f = need(s, 'facing', H, b); const type = withDefault(s, 'type', 'single');
      return anyFace().filter(o => o.normal !== 'down').map(o => ({ ...o, ...look(OPP[f]), sneak: type === 'single' }));
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
    family: 'lantern', matches: n => n === 'lantern' || n === 'soul_lantern', controls: ['hanging'],
    options: (s, b) => [{ normal: need(s, 'hanging', ['true', 'false'], b) === 'true' ? 'down' : 'up' }],
  },
  {
    family: 'axis', controls: ['axis'],
    matches: n => /_log$|_wood$|_stem$|_hyphae$/.test(n) || ['chain', 'hay_block', 'bone_block', 'basalt', 'polished_basalt', 'quartz_pillar', 'purpur_pillar', 'muddy_mangrove_roots', 'deepslate'].includes(n),
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

// requested — the keys of `state` this placement is answerable for, derived keys removed. Throws on a key
// the family cannot set.
function requested(blockName, state) {
  const fam = familyOf(blockName);
  if (!fam) {
    throw new Error(`[facing_aim] CODING VIOLATION (Law 13): a blueprint asks ${blockName} for state ${JSON.stringify(state)}, and no placement rule for ${blockName} is known. Rules exist for: ${FAMILIES.map(f => f.family).join(', ')}. Measure the family live and add its rule, or remove the state from the blueprint.`);
  }
  const out = {};
  for (const [k, v] of Object.entries(state || {})) {
    if (DERIVED.has(k)) continue;
    if (!fam.controls.includes(k)) {
      throw new Error(`[facing_aim] CODING VIOLATION (Law 13): ${blockName} asks for ${k}=${JSON.stringify(v)}, which the ${fam.family} rule does not set (it sets ${fam.controls.join(', ') || 'nothing'}; the game derives ${[...DERIVED].slice(0, 6).join(', ')}…).`);
    }
    out[k] = v;
  }
  return { fam, state: out };
}

// findAim — the click that gives `blockName` the wanted `state` at `pos`, from where the body is.
//   returns { ok:true, anchor, face, delta, yaw, pitch, sneak, use, family, state }
//        or { ok:false, reason }
// Among usable options the nearest clicked point wins, so the choice is a pure function of the world.
function findAim(bot, pos, blockName, rawState) {
  const { fam, state } = requested(blockName, rawState);
  const reach = require('@utils/fragment_utils').BLOCK_REACH;
  const isInteractable = require('@api/anchored_repair').isInteractable;
  const target = new Vec3(pos.x, pos.y, pos.z);
  const options = fam.options(state, blockName);
  const blocked = fam.check ? fam.check(bot, target, state) : null;
  if (blocked) return { ok: false, reason: `no_state_click: ${blockName} ${JSON.stringify(state)} at (${pos.x},${pos.y},${pos.z}): ${blocked}` };

  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
  let best = null;
  const seen = [];
  for (const o of options) {
    const n = normalOf(o.normal);
    const ref = bot.blockAt(target.minus(n));
    if (!ref || ref.boundingBox !== 'block' || isInteractable(ref.name)) { seen.push(`${o.normal}:${ref ? ref.name : 'unloaded'}`); continue; }
    const delta = o.cursor || cursor(o.normal);
    const point = ref.position.plus(delta);
    const dist = point.distanceTo(eye);
    if (dist > reach) { seen.push(`${o.normal}:${dist.toFixed(2)}>reach`); continue; }
    if (best && dist >= best.dist) continue;
    best = { o, ref, n, delta, point, dist };
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
    sneak: !!o.sneak, use: fam.use ? fam.use(state) : false, family: fam.family, state,
  };
}

// stateMatches — does the placed block show every property that was asked for? Read off the world.
function stateMatches(block, state) {
  if (!block || !state) return { ok: false, got: null };
  const props = block.getProperties();
  const got = Object.fromEntries(Object.keys(state).map(k => [k, props[k]]));
  return { ok: Object.entries(state).every(([k, v]) => String(props[k]) === String(v)), got };
}

module.exports = { findAim, stateMatches, familyOf, requested, DERIVED };
