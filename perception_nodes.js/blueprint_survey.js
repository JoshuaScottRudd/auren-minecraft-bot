// The domain-neutral voxel-vs-world engine: given a blueprint and a locked world center, transposes
// the blueprint's voxels to world coordinates and diffs each against the actual block, emitting the
// dig/place steps that would make the world match. Knows GEOMETRY (transpose, anchors, attach points,
// footprint) and BLOCK-MATCHING (group tokens, air clearance, external cells) — nothing about what the
// structure IS; "building" and "farm" are interpretations the wrapping integrity nodes layer on top.
// One engine, one definition of the structural diff (Law 16).
//
// Ownership model: the blueprint declares its own external cells, the integrity node declares which
// blueprint it owns; neither declares the other's job (Invariant D).
//
// Pure observation (Law 1 perception exception — action fragments may call this directly).

const { Vec3 } = require('vec3');
const hq       = require('@kernel/corporate_headquarters');
const blueprintRegistry = require('@kernel/blueprint_registry');
// The building room's keys carry an owner; this strips it back to the structure name. Imported rather
// than split by hand here — one addressing rule, one place (Law 16).
const { roomKeyName } = require('@foreman/message_schema');

// Plain require: a guarded import would leave these bindings undefined on failure while preflight's
// bad-require check still sees a file that loaded fine (Law 16, Law 26).
const { group_to_item, normalizeBlockName } = require('@utils/fragment_utils');

// building_blueprints.json stores "log" (singular) as its raw token for "place any log variant";
// the canonical group elsewhere (group_to_item) is "logs" (plural). Normalize on read.
const TYPE_ALIASES = { log: 'logs' };

// Collect all voxels from a blueprint, preserving which anchor each voxel belongs to.
// Returns { raw: [x,y,z,type], anchor_index: N } objects. anchor_index = -1 for unassigned/legacy.
function collectAllVoxels(building) {
  const result = [];
  if (Array.isArray(building.anchors)) {
    for (let ai = 0; ai < building.anchors.length; ai++) {
      const a = building.anchors[ai];
      if (Array.isArray(a.voxels)) {
        for (const v of a.voxels) result.push({ raw: v, anchor_index: ai });
      }
    }
  }
  if (Array.isArray(building.unassigned_voxels)) {
    for (const v of building.unassigned_voxels) result.push({ raw: v, anchor_index: -1 });
  }
  if (result.length > 0) return result;
  if (Array.isArray(building.voxels)) {
    return building.voxels.map(v => ({ raw: v, anchor_index: -1 }));
  }
  return [];
}

function isAir(name) {
  return name === null || name === undefined || name === 'air' || name === 'cave_air' || name === 'void_air';
}

// classifyVoxel — the one definition of whether the world matches the blueprint at this cell (Law 16),
// shared by scanBuilding's dig/place diff and the navigator's protected-block filter so the two never
// drift into different opinions on the same cell. Returns a verdict only; callers decide what to do.
//
// 'unloaded' is its own verdict, not air: an unsensed chunk must not be read as a confident diff
// (Invariant B / Law 13).
function classifyVoxel(bot, x, y, z, rawExpType, externalTypes) {
  const expType = TYPE_ALIASES[rawExpType] || rawExpType;

  // A blueprint-declared external voxel is owned by a foreign subsystem, never placed or dug here — the
  // only domain-aware branch, and it carries no crop vocabulary of its own (Invariant D / Law 16).
  if (externalTypes && externalTypes.has(expType)) return { verdict: 'correct', expType, actName: null };

  // Unguarded: a bad coordinate must surface as a coding violation, not be swallowed (Law 13).
  const rawActName = bot.blockAt(new Vec3(x, y, z))?.name || null;
  if (rawActName === null) return { verdict: 'unloaded', expType, actName: null };

  const actName = normalizeBlockName ? normalizeBlockName(rawActName) : rawActName;

  if (isAir(actName)) {
    return { verdict: expType === 'air' ? 'correct' : 'missing', expType, actName };
  }
  if (expType === 'air') return { verdict: 'extraneous', expType, actName };

  if (group_to_item && group_to_item[expType]) {
    const isMember = Array.isArray(group_to_item[expType]) && group_to_item[expType].includes(actName);
    return { verdict: isMember ? 'correct' : 'group_mismatch', expType, actName };
  }
  return { verdict: actName === expType ? 'correct' : 'mismatch', expType, actName };
}

// Diffs the transposed voxel list against the real world; returns null when everything already matches
// (no unsensed voxels). pasted.external_types are blueprint-declared non-structural cells, owned by a
// foreign subsystem, so they are neither placed nor dug here.
async function scanBuilding(bot, pasted) {
  const pace = require('@utils/execution_yield').makeExecutionPacer();
  const expected = new Map();
  const externalTypes = pasted.external_types || new Set();
  for (const b of (pasted.voxels || [])) {
    await pace();
    const k = `${b.x},${b.y},${b.z}`;
    if (!expected.has(k)) expected.set(k, { type: b.type, anchor_index: b.anchor_index ?? -1, state: b.state || null });
  }

  let correct = 0, missing = 0, mismatched = 0, extraneous = 0, unloaded = 0;
  const placeSteps = [];
  const digSteps   = [];
  // WHERE the unsensed cells are, not just how many: an unloaded voxel emits no step, so a consumer
  // counting steps alone cannot tell "no work here" from "built" (Law 26). Coordinates travel with the
  // count so a downstream consumer can ask whether a given anchor was sensed.
  const unloadedCells = [];

  for (const [k, expRec] of expected.entries()) {
    await pace();
    const ai        = expRec.anchor_index;
    const [x, y, z] = k.split(',').map(Number);
    const { verdict, expType, actName } = classifyVoxel(bot, x, y, z, expRec.type, externalTypes);
    const isGroupToken = !!(group_to_item && group_to_item[expType]);
    // The wanted state rides on the PLACE step only, as an instruction to the placer; correctness is
    // still decided by block type alone (Law 27).
    const withState = expRec.state ? { state: expRec.state } : {};

    switch (verdict) {
      case 'correct':  correct++;  break;
      case 'unloaded':
        unloaded++;                          // emit no step — the bot never sensed this cell
        unloadedCells.push({ x, y, z, anchor_index: ai });
        break;
      case 'missing':
        missing++;
        placeSteps.push({ action: 'place', place: { x, y, z }, type: expType, anchor_index: ai, reason: 'missing', actual: actName, ...(isGroupToken ? { expected_group: expType } : {}), ...withState });
        break;
      case 'extraneous':
        extraneous++;
        digSteps.push({ action: 'dig', place: { x, y, z }, type: actName, anchor_index: ai, reason: 'should_be_air' });
        break;
      case 'group_mismatch':
        mismatched++;
        digSteps.push({ action: 'dig', place: { x, y, z }, type: actName, anchor_index: ai, reason: 'group_mismatch' });
        placeSteps.push({ action: 'place', place: { x, y, z }, type: expType, anchor_index: ai, reason: 'group_mismatch', actual: actName, expected_group: expType, ...withState });
        break;
      case 'mismatch':
        mismatched++;
        digSteps.push({ action: 'dig', place: { x, y, z }, type: actName, anchor_index: ai, reason: 'mismatch' });
        placeSteps.push({ action: 'place', place: { x, y, z }, type: expType, anchor_index: ai, reason: 'mismatch', actual: actName, ...withState });
        break;
    }
  }

  // Unloaded voxels make the scan partial — never collapse to null ("complete") off an unsensed
  // region, or a caller (all_complete) reads the build as done over terrain it never saw.
  if (placeSteps.length + digSteps.length === 0 && unloaded === 0) return null;

  const steps = [...digSteps, ...placeSteps].sort((a, b) => {
    if (a.action !== b.action) return a.action === 'dig' ? -1 : 1;
    if (a.place.y !== b.place.y) return a.place.y - b.place.y;
    if (a.place.x !== b.place.x) return a.place.x - b.place.x;
    return a.place.z - b.place.z;
  });

  const reasonCounts = {};
  for (const s of steps) reasonCounts[s.reason] = (reasonCounts[s.reason] || 0) + 1;
  const reasonParts = Object.entries(reasonCounts).sort((a, b) => a[0].localeCompare(b[0])).map(([r, c]) => `${r}:${c}`).join(', ');

  return {
    stats: {
      expected:    expected.size,
      correct, missing, mismatched, extraneous, unloaded,
      unloaded_cells: unloadedCells,
      dig_steps:   digSteps.length,
      place_steps: placeSteps.length,
      total_steps: steps.length,
    },
    summary: `expected=${expected.size} correct=${correct} missing=${missing} mismatched=${mismatched} should_be_air=${extraneous} unloaded=${unloaded} dig=${digSteps.length} place=${placeSteps.length} reasons[${reasonParts}]`,
    steps,
  };
}

// ── Geometry: blueprint-relative → world coordinates ──

// A blueprint is placed exactly the way it is authored — no rotation logic exists; a facing that
// matters is a facing the operator states explicitly, never one derived by a site search.

// ── transpose_origin: the common point every voxel offset is measured from ──
// Not a centre and not a place in the world — wherever the blueprint's author put the anchor. One
// point, one subtraction (Law 7):
//
//     world cell = transpose_origin + (voxel offset - the blueprint's own origin)

function transposeVoxel(worldOrigin, blueprintOrigin, v) {
  return {
    x: worldOrigin.x + (v[0] - blueprintOrigin.x),
    y: worldOrigin.y + (v[1] - blueprintOrigin.y),
    z: worldOrigin.z + (v[2] - blueprintOrigin.z),
    type: v[3],
    ...(v[4] ? { state: { ...v[4] } } : {}),
  };
}

// footprintExtent — the XZ ground area a blueprint occupies, as OFFSETS from its transpose_origin (not
// a width: the origin is not symmetric within the footprint). The one definition of a blueprint's reach
// in each compass direction (Law 16); every caller that reserves ground, checks flatness, or rejects an
// overlap asks here. Derived from the voxels, never authored separately.
function footprintExtent(building) {
  const voxels = collectAllVoxels(building);
  if (voxels.length === 0) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${building?.name || 'unknown'}" has no voxels, so it has no footprint. footprintExtent requires a blueprint with geometry.`);
  }
  const bc = building.transpose_origin || { x: 0, y: 0, z: 0 };
  let minDX = Infinity, maxDX = -Infinity, minDZ = Infinity, maxDZ = -Infinity;
  for (const { raw } of voxels) {
    const dx = raw[0] - bc.x, dz = raw[2] - bc.z;
    if (dx < minDX) minDX = dx;
    if (dx > maxDX) maxDX = dx;
    if (dz < minDZ) minDZ = dz;
    if (dz > maxDZ) maxDZ = dz;
  }
  return {
    min_dx: minDX, max_dx: maxDX, min_dz: minDZ, max_dz: maxDZ,
    width:  maxDX - minDX + 1,
    length: maxDZ - minDZ + 1,
  };
}

// Transposes a building's full voxel list to world coordinates against a GIVEN transpose origin, before
// any set_buildspot chair exists — find_buildingspot's farmland overlay needs voxel types around a
// candidate center to judge a site. Reuses collectAllVoxels/transposeVoxel (Law 16).
function transposeVoxelsForCandidate(building, transposeOrigin) {
  if (!transposeOrigin || typeof transposeOrigin.x !== 'number') {
    throw new Error('[blueprint_survey] CODING VIOLATION: transposeVoxelsForCandidate requires a transposeOrigin {x,y,z}.');
  }
  const blueprintCenter = building.transpose_origin || { x: 0, y: 0, z: 0 };
  return collectAllVoxels(building).map(({ raw, anchor_index }) => {
    const v = transposeVoxel(transposeOrigin, blueprintCenter, raw);
    v.anchor_index = anchor_index;
    return v;
  });
}

// Transpose a blueprint's attach points to world coordinates against a GIVEN transpose origin. Pure (no HQ
// read) so both the chair-backed resolver (getWorldAttachPoints) and candidate callers share ONE join
// definition (Law 16). Returns { A:{x,y,z}, ... } keyed by attach-point id.
function transposeAttachPoints(building, transposeOrigin) {
  if (!building || !Array.isArray(building.attach_points) || building.attach_points.length === 0) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${building?.name || 'unknown'}" has no attach_points array.`);
  }
  if (!transposeOrigin || typeof transposeOrigin.x !== 'number') {
    throw new Error('[blueprint_survey] CODING VIOLATION: transposeAttachPoints requires a transposeOrigin {x,y,z}.');
  }
  const blueprintCenter = building.transpose_origin || { x: 0, y: 0, z: 0 };
  const out = {};
  for (const ap of building.attach_points) {
    const p = ap.position;
    out[ap.id] = {
      x: transposeOrigin.x + (p[0] - blueprintCenter.x),
      y: transposeOrigin.y + (p[1] - blueprintCenter.y),
      z: transposeOrigin.z + (p[2] - blueprintCenter.z),
    };
  }
  return out;
}

// Candidate-time anchor transpose — the anchor twin of transposeVoxelsForCandidate, so a caller can
// locate the bot's STAND cells against a GIVEN center before a set_buildspot chair exists.
// find_buildingspot's farmland gate uses this to refuse a site whose anchor lands on water.
// getWorldAnchors is the chair-backed caller; both share this transpose (Law 16).
function transposeAnchorsForCandidate(building, transposeOrigin) {
  if (!transposeOrigin || typeof transposeOrigin.x !== 'number') {
    throw new Error('[blueprint_survey] CODING VIOLATION: transposeAnchorsForCandidate requires a transposeOrigin {x,y,z}.');
  }
  if (!Array.isArray(building?.anchors) || building.anchors.length === 0) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${building?.name || 'unknown'}" has no anchors array.`);
  }
  const blueprintCenter = building.transpose_origin || { x: 0, y: 0, z: 0 };
  return building.anchors.map(a => {
    const pos = a.position;
    const r = { dx: pos[0] - blueprintCenter.x, dz: pos[2] - blueprintCenter.z };
    return {
      x: transposeOrigin.x + r.dx,
      y: transposeOrigin.y + (pos[1] - blueprintCenter.y),
      z: transposeOrigin.z + r.dz,
    };
  });
}

// Returns the blueprint's anchor positions transposed to world coordinates. Same coordinate math as
// transposeVoxel — anchors are positions without a block type. Executors use these to know where to stand.
function getWorldAnchors(blueprintName, conferenceRoomKey) {
  conferenceRoomKey = conferenceRoomKey || blueprintName;
  const building = blueprintRegistry.getBuilding(blueprintName, 'blueprint_survey');
  if (!Array.isArray(building.anchors) || building.anchors.length === 0) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: Blueprint "${blueprintName}" has no anchors array.`);
  }

  const setBuildspot = hq.readBuildingChair(conferenceRoomKey, 'set_buildspot');
  if (!setBuildspot?.transpose_origin || typeof setBuildspot.transpose_origin.x !== 'number') {
    throw new Error(`[blueprint_survey] CODING VIOLATION: No locked transpose_origin for "${conferenceRoomKey}". set_buildspot must run before getWorldAnchors().`);
  }
  return transposeAnchorsForCandidate(building, setBuildspot.transpose_origin);
}

// Chair-backed attach-point resolver: reads the locked transpose_origin from set_buildspot's chair and
// transposes the named building's attach points to world. Mirrors getWorldAnchors.
function getWorldAttachPoints(blueprintName, conferenceRoomKey) {
  conferenceRoomKey = conferenceRoomKey || blueprintName;
  const building = blueprintRegistry.getBuilding(blueprintName, 'blueprint_survey');
  const setBuildspot = hq.readBuildingChair(conferenceRoomKey, 'set_buildspot');
  if (!setBuildspot?.transpose_origin || typeof setBuildspot.transpose_origin.x !== 'number') {
    throw new Error(`[blueprint_survey] CODING VIOLATION: No locked transpose_origin for "${conferenceRoomKey}". set_buildspot must run before getWorldAttachPoints().`);
  }
  return transposeAttachPoints(building, setBuildspot.transpose_origin);
}

// One transpose→world-key-set pathway (Law 16), two callers with opposite air policies:
//   getProtectedBlocks → SOLID voxels only (navigator's dig penalty must not touch the blueprint's own
//                        blocks).
//   getFootprintCells  → EVERY declared voxel incl. interior air (torch_integrity's overlap guard).
// Returns null when the blueprint has no locked center yet.
//
// `bot` (optional) turns this from a PLAN read into a SENSED read: without it, every solid voxel the
// blueprint declares is protected, including virgin terrain never re-sensed (Invariant B); with it, only
// cells the world already matches are protected, via classifyVoxel — the same verdict the integrity scan
// uses (Law 16). An UNLOADED cell stays protected regardless (Law 13, default stopped).
//
// `chair` — an already-read set_buildspot, handed in by a caller walking the whole room, since
// readBuildingChair addresses by this process's owner and cannot re-address a room key that already
// carries a different owner.
function worldVoxelKeys(blueprintName, conferenceRoomKey, { includeAir, bot = null, externalTypes = null, chair = null }) {
  const building = blueprintRegistry.tryGetBuilding(blueprintName);
  const allVoxels = building ? collectAllVoxels(building) : [];
  if (!building || allVoxels.length === 0) return null;

  const setBuildspot = chair || hq.readBuildingChair(conferenceRoomKey || blueprintName, 'set_buildspot');
  if (!setBuildspot?.transpose_origin || typeof setBuildspot.transpose_origin.x !== 'number') return null;

  const transposeOrigin     = setBuildspot.transpose_origin;
  const blueprintCenter = building.transpose_origin || { x: 0, y: 0, z: 0 };

  const set = new Set();
  for (const { raw } of allVoxels) {
    const world = transposeVoxel(transposeOrigin, blueprintCenter, raw);
    if (!includeAir && world.type === 'air') continue;
    if (bot) {
      const { verdict } = classifyVoxel(bot, world.x, world.y, world.z, world.type, externalTypes);
      if (verdict !== 'correct' && verdict !== 'unloaded') continue;   // nothing built here to damage
    }
    set.add(`${world.x},${world.y},${world.z}`);
  }
  return set.size > 0 ? set : null;
}

function getProtectedBlocks(blueprintName, bot = null) {
  return worldVoxelKeys(blueprintName, blueprintName, { includeAir: false, bot });
}

// getAllProtectedBlocks — every SOLID voxel of EVERY blueprint with a locked transpose_origin, as one
// "x,y,z" key Set. The plural twin of getProtectedBlocks(name); asking by name only protects the
// blueprint named and leaves every other build a cheap doorway, so the navigator wants this instead.
//
// Enumerates the HQ ROOM (every LOCKED conference-room key), not the blueprint file, since a blueprint
// may be locked under an instanced key that is not its file name (e.g. `wheat_plot_pair#7`). Each
// entry's `set_buildspot.transpose_origin` proves it is locked; `blueprint_paster.building_name` names
// the geometry to transpose. Mining's own blueprints have no chair here and fall out; the navigator
// merges all three Sets.
function getAllProtectedBlocks(bot = null) {
  const room = hq.readOffice('building_confrence_room', {});
  const set = new Set();
  for (const [roomKey, entry] of Object.entries(room || {})) {
    const sb = entry?.set_buildspot;
    if (!sb?.transpose_origin || typeof sb.transpose_origin.x !== 'number') continue;   // not a locked instance
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(roomKey);   // geometry name (fallback strips the owner)
    const keys = worldVoxelKeys(blueprintName, roomKey, { includeAir: false, bot, chair: sb });
    if (keys) for (const k of keys) set.add(k);
  }
  return set.size > 0 ? set : null;
}

function getFootprintCells(blueprintName, conferenceRoomKey) {
  return worldVoxelKeys(blueprintName, conferenceRoomKey, { includeAir: true });
}

// getAllFootprintCells — every DECLARED cell, interior air included, of EVERY blueprint with a locked
// transpose_origin, as one "x,y,z" key Set. The plural twin of getFootprintCells, walking the same
// locked conference-room keys getAllProtectedBlocks walks (Law 16).
//
// Answers a different question than getAllProtectedBlocks: whether a cell is spoken for by a building —
// true even before the building exists — not whether digging there would destroy something. The two sets
// mean opposite things and are never merged.

// geometryOf — which blueprint geometry a locked instance is. The room key names the INSTANCE; the
// chair names the GEOMETRY (`wheat_plot_pair#7` is an instance key, and set_buildspot stamps which
// geometry is locked under it). For callers that hold only a key and no room-walk entry.
//
// Resolved through hq.readBuildingChair, not by indexing the room directly: the room is keyed with the
// owner suffix while callers hold the bare instance key, so a direct lookup would miss.
//
// The fallback strips the instance suffix at '#' (roomKeyName only strips the owner) to recover the
// geometry name when a chair predates the paster stamp.
function geometryOf(roomKey) {
  const stamped = hq.readBuildingChair(roomKey, 'blueprint_paster')?.building_name;
  if (stamped) return stamped;
  const bare = roomKeyName(roomKey);
  const hash = bare.indexOf('#');
  return hash === -1 ? bare : bare.slice(0, hash);
}

function getAllFootprintCells() {
  const room = hq.readOffice('building_confrence_room', {});
  const set = new Set();
  for (const [roomKey, entry] of Object.entries(room || {})) {
    const sb = entry?.set_buildspot;
    if (!sb?.transpose_origin || typeof sb.transpose_origin.x !== 'number') continue;   // not a locked instance
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(roomKey);   // geometry name (fallback strips the owner)
    const keys = worldVoxelKeys(blueprintName, roomKey, { includeAir: true, chair: sb });
    if (keys) for (const k of keys) set.add(k);
  }
  return set.size > 0 ? set : null;
}

// ── resolveVoxelAnchor — which anchor owns the block at this world cell? ──
//
// The authored stand for using a station: the anchor is the cell build_executor stands on to build that
// group of voxels, and every voxel in its domain is within reach from it (Law 16) — a reused value, never
// searched for fresh.
//
// Returns the ANCHOR BLOCK, never the stand cell; the "+1 to stand on it" conversion belongs solely to
// locomotion.goToStand. Null means no blueprint claims this cell (the one legitimate exception is a
// temporary bootstrap crafting table); callers must not improvise a stance from null.
//
// Enumeration matches getAllProtectedBlocks, walking every LOCKED conference-room key SORTED so two
// overlapping blueprints resolve to the same anchor on every run (Law 19).
function resolveVoxelAnchor(pos) {
  if (!pos || typeof pos.x !== 'number') {
    throw new Error(`[blueprint_survey] CODING VIOLATION: resolveVoxelAnchor needs a {x,y,z}. Got: ${require('util').inspect(pos)}`);
  }
  const wantKey = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  const room = hq.readOffice('building_confrence_room', {});
  for (const roomKey of Object.keys(room || {}).sort()) {
    const entry = room[roomKey];
    const sb = entry?.set_buildspot;
    if (!sb?.transpose_origin || typeof sb.transpose_origin.x !== 'number') continue;   // not a locked instance
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(roomKey);   // geometry name (fallback strips the owner)
    const building = blueprintRegistry.tryGetBuilding(blueprintName);
    if (!building) continue;
    const allVoxels = collectAllVoxels(building);
    if (allVoxels.length === 0) continue;
    const blueprintCenter = building.transpose_origin || { x: 0, y: 0, z: 0 };
    for (const { raw, anchor_index } of allVoxels) {
      const world = transposeVoxel(sb.transpose_origin, blueprintCenter, raw);
      if (`${world.x},${world.y},${world.z}` !== wantKey) continue;
      // An UNASSIGNED voxel belongs to the blueprint but no anchor; reported with the owner named, since
      // no-blueprint-here and unassigned-within-this-blueprint are different facts (Law 25).
      if (anchor_index < 0) {
        return { blueprint: blueprintName, roomKey, anchorIndex: -1, anchor: null, type: world.type, reason: 'unassigned_voxel' };
      }
      const anchors = transposeAnchorsForCandidate(building, sb.transpose_origin);
      return { blueprint: blueprintName, roomKey, anchorIndex: anchor_index, anchor: anchors[anchor_index], type: world.type };
    }
  }
  return null;
}

// ── LANES — A ONE-WAY ROUTE THROUGH A BLUEPRINT, AUTHORED ON THE BLUEPRINT ──────────────────────────
//
// A blueprint may declare `lane`: the attach point a body enters by, the attach point it leaves by, the
// `interior` box of feet cells between the two, and the `closed` boxes no route stands in (its fixtures
// and the air above them). An attach point follows the anchor convention — the block the feet rest ON.
// A blueprint with no `lane` has none, and every walk to it is a plain walk.

const inBox = (b, p) => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y
  && p.z >= b.min.z && p.z <= b.max.z;

function transposeLaneBox(building, transposeOrigin, box, what) {
  const corner = c => Array.isArray(c) && c.length === 3 && c.every(n => Number.isFinite(n));
  if (!box || !corner(box.min) || !corner(box.max) || box.min.some((n, i) => n > box.max[i])) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${building.name}" lane ${what} must be {min:[x,y,z], max:[x,y,z]} with min <= max. Got: ${JSON.stringify(box)}`);
  }
  const bc = building.transpose_origin || { x: 0, y: 0, z: 0 };
  const at = c => ({ x: transposeOrigin.x + (c[0] - bc.x), y: transposeOrigin.y + (c[1] - bc.y), z: transposeOrigin.z + (c[2] - bc.z) });
  return { min: at(box.min), max: at(box.max) };
}

// getWorldLanes — every lane of every LOCKED blueprint, in world coordinates:
//   [{ blueprint, roomKey, entry, exit, interior:{min,max}, closed:[{min,max}] }]
// Walks the same locked conference-room keys resolveVoxelAnchor walks, sorted (Law 16, Law 19).
function getWorldLanes() {
  const room = hq.readOffice('building_confrence_room', {});
  const lanes = [];
  for (const roomKey of Object.keys(room || {}).sort()) {
    const entry = room[roomKey];
    const sb = entry?.set_buildspot;
    if (!sb?.transpose_origin || typeof sb.transpose_origin.x !== 'number') continue;   // not a locked instance
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(roomKey);
    const building = blueprintRegistry.tryGetBuilding(blueprintName);
    if (!building || !building.lane) continue;
    const lane = building.lane;
    const points = transposeAttachPoints(building, sb.transpose_origin);
    if (!points[lane.entry] || !points[lane.exit] || lane.entry === lane.exit) {
      throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${blueprintName}" lane names entry "${lane.entry}" and exit "${lane.exit}", which must be two different ids in its attach_points.`);
    }
    if (!Array.isArray(lane.closed)) {
      throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${blueprintName}" lane.closed must be an array of boxes.`);
    }
    const interior = transposeLaneBox(building, sb.transpose_origin, lane.interior, 'interior');
    // A mouth inside the interior would be closed to the very walk sent to it.
    for (const id of [lane.entry, lane.exit]) {
      const stand = { x: points[id].x, y: points[id].y + 1, z: points[id].z };
      if (inBox(interior, stand)) {
        throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${blueprintName}" lane attach point "${id}" stands inside the lane's own interior box.`);
      }
    }
    lanes.push({
      blueprint: blueprintName, roomKey,
      entry: points[lane.entry], exit: points[lane.exit], interior,
      closed: lane.closed.map((b, i) => transposeLaneBox(building, sb.transpose_origin, b, `closed[${i}]`)),
    });
  }
  return lanes;
}

// laneLegs — the lane mouths a walk passes before its own goal, in order: out by the exit of a lane
// the body stands in and is leaving, then in by the entry of a lane the goal lies in. `toFeet` is null
// for a walk with no single goal cell. Returns [{ point:'exit'|'entry', blueprint, anchor }].
function laneLegs(lanes, fromFeet, toFeet) {
  const legs = [];
  for (const lane of lanes) {
    const from = inBox(lane.interior, fromFeet), to = !!toFeet && inBox(lane.interior, toFeet);
    if (from && !to) legs.unshift({ point: 'exit', blueprint: lane.blueprint, anchor: lane.exit });
    if (to && !from) legs.push({ point: 'entry', blueprint: lane.blueprint, anchor: lane.entry });
  }
  return legs;
}

// laneClosedBoxes — the lane boxes closed to one route search: every lane's `closed` boxes always, and
// its interior unless the search's goal cell lies in it. A closed box still lets a body inside it walk
// out (pathfinding_utils' closed-box rule), which is how a walk leaves by the exit.
function laneClosedBoxes(lanes, goalFeet) {
  const boxes = [];
  for (const lane of lanes) {
    boxes.push(...lane.closed);
    if (!(goalFeet && inBox(lane.interior, goalFeet))) boxes.push(lane.interior);
  }
  return boxes;
}

// survey(bot, blueprintName, conferenceRoomKey, opts) — the neutral scan. Loads the blueprint + the
// locked transpose_origin from set_buildspot's chair, transposes every voxel to world, and diffs against
// reality. Returns the RAW structural verdict; craft-material aggregation, anchor status, and logging
// are the wrapping integrity node's concern, not this engine's.
//   { all_complete, steps, stats, summary, voxels (world), footprint, transpose_origin, anchor_count }
async function survey(bot, blueprintName, conferenceRoomKey, opts) {
  conferenceRoomKey = conferenceRoomKey || blueprintName;
  if (!bot || !bot.blockAt) {
    throw new Error('[blueprint_survey] CODING VIOLATION: bot must be initialized before survey(). Check caller.');
  }
  if (!blueprintName || typeof blueprintName !== 'string') {
    throw new Error('[blueprint_survey] CODING VIOLATION: blueprintName must be a non-empty string. Check caller.');
  }

  const building = blueprintRegistry.getBuilding(blueprintName, 'blueprint_survey');
  const allVoxels = collectAllVoxels(building);
  if (allVoxels.length === 0) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: Blueprint "${blueprintName}" has no voxels (checked anchors, unassigned_voxels, and legacy voxels array).`);
  }

  const setBuildspot = hq.readBuildingChair(conferenceRoomKey, 'set_buildspot');
  if (!setBuildspot?.transpose_origin || typeof setBuildspot.transpose_origin.x !== 'number') {
    throw new Error(`[blueprint_survey] CODING VIOLATION: No locked transpose_origin for "${conferenceRoomKey}". set_buildspot must run before survey().`);
  }
  const transposeOrigin     = setBuildspot.transpose_origin;
  const blueprintCenter = building.transpose_origin || { x: 0, y: 0, z: 0 };

  const voxels = allVoxels.map(({ raw, anchor_index }) => {
    const v = transposeVoxel(transposeOrigin, blueprintCenter, raw);
    v.anchor_index = anchor_index;
    return v;
  });

  // Footprint = the world AABB over SOLID voxels (air is clearance, not structure). Callers test "is
  // the bot standing inside the build?" off this without re-deriving geometry (Law 16, single owner).
  const _footSolid = voxels.filter(v => v.type !== 'air');
  const footprint = _footSolid.length ? {
    minX: Math.min(..._footSolid.map(v => v.x)), maxX: Math.max(..._footSolid.map(v => v.x)),
    minY: Math.min(..._footSolid.map(v => v.y)), maxY: Math.max(..._footSolid.map(v => v.y)),
    minZ: Math.min(..._footSolid.map(v => v.z)), maxZ: Math.max(..._footSolid.map(v => v.z)),
  } : null;

  // Blueprint-declared non-structural voxels — scanBuilding skips them (see external_types contract).
  const externalTypes = new Set(building.external_voxel_types || []);
  const pasted = { building_name: blueprintName, voxels, voxel_count: voxels.length, external_types: externalTypes };

  const scanStart = Date.now();
  // No catch: a caught failure here would collapse to the same null scanBuilding returns for "nothing
  // left to do", reporting a crashed scan as a completed build. A throw is a coding violation, not an
  // environmental outcome — the one genuine world condition (unloaded chunks) returns, never throws
  // (Law 13).
  const result = await scanBuilding(bot, pasted);
  const scanMs = Date.now() - scanStart;

  return {
    schema:           'auren.blueprint_survey.v1',
    blueprint_name:   blueprintName,
    scan_duration_ms: scanMs,
    all_complete:     result === null,
    steps:            result ? result.steps   : [],
    stats:            result ? result.stats   : null,
    summary:          result ? result.summary : 'all voxels match world state',
    voxels,
    footprint,
    transpose_origin:     transposeOrigin,
    anchor_count:     Array.isArray(building.anchors) ? building.anchors.length : 0,
  };
}

module.exports = {
  survey,
  scanBuilding,
  classifyVoxel,   // the one definition of whether the world matches the blueprint here (mining_integrity reuses it)
  collectAllVoxels,
  isAir,
  footprintExtent,   // the one definition of a blueprint's XZ reach, as offsets from its transpose_origin
  transposeVoxel,
  transposeVoxelsForCandidate,
  transposeAnchorsForCandidate,
  transposeAttachPoints,
  getWorldAnchors,
  getWorldAttachPoints,
  getProtectedBlocks,
  getAllProtectedBlocks,
  getFootprintCells,
  getAllFootprintCells,
  geometryOf,        // the one answer to which blueprint is locked under a given instance key
  resolveVoxelAnchor,
  getWorldLanes, laneLegs, laneClosedBoxes,   // a blueprint's one-way lane: its mouths, and the boxes a route search closes for it
};
