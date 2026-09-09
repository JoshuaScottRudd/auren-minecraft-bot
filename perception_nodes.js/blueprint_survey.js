// perception primitive: blueprint_survey
// purpose: The domain-neutral voxel-vs-world engine. Given a blueprint + a locked world center,
//          transpose the blueprint's voxels to world coordinates and diff each against the actual
//          block, emitting the dig/place steps that would make the world match. It knows GEOMETRY
//          (transpose, anchors, attach points, footprint) and BLOCK-MATCHING (group tokens, air
//          clearance, concrete types, blueprint-declared external cells) — nothing about what the
//          structure IS. "building" and "farm" are interpretations layered on top by the integrity
//          nodes that wrap this (building_integrity, farming_integrity); this engine is agnostic.
//
// WHY split out of building_integrity (Architect 2026-07-11): once farming reuses the same scan,
//   the logic can no longer be named for one domain. So the SCAN became an API and each integrity
//   node is a thin wrapper with its own reading of the result — building aggregates craft materials
//   and never sees a field cell; farming folds in its till/plant/harvest census. One engine, one
//   definition of the structural diff (Law 16); the domains diverge only in what they DO with it.
//
// Ownership model: the blueprint declares its own cells (external_voxel_types names the voxels a
//   planting subsystem owns — crop/river/sapling), and the integrity node declares which blueprint
//   it owns (by name, in code). Neither declares the other's job (Invariant D): the owned describes
//   itself, the owner names what it owns. This engine only honors the blueprint's self-description —
//   it skips declared-external voxels and reports the rest structurally.
//
// Pure observation (Law 1 perception exception — action fragments may call this directly).

const { Vec3 } = require('vec3');
const hq       = require('@kernel/corporate_headquarters');
const blueprintRegistry = require('@kernel/blueprint_registry');
// The building room's keys carry an owner; this strips it back to the structure name. Imported rather
// than split by hand here — one addressing rule, one place (Law 16).
const { roomKeyName } = require('@overseer/message_schema');

// A PLAIN REQUIRE, BECAUSE THE GUARD DEFEATED THE ONE TEST THAT COVERS THIS. Wrapped, a failed import
// left both bindings undefined and the module carried on with silent holes in its block-name handling —
// and pass 1 of preflight, whose entire job is to catch a bad require, saw a file that loaded
// fine. A guard that hides the failure from the instrument built to find it is strictly worse than the
// failure (Law 16, Law 26 — the catch deleted the guarantee the loader provides).
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

// Diff the transposed voxel list against the real world. Returns null if everything matches (with no
// unsensed voxels). pasted.external_types is the set of blueprint-declared non-structural voxel types
// (crop/river/sapling cells) — a foreign subsystem owns them, so they are neither placed nor dug here.
// classifyVoxel — the ONE definition of "does the world match the blueprint at this cell" (Law 16).
// Extracted from scanBuilding's loop so the navigator's protected-block filter can ask the same
// question the integrity scan asks, instead of a second opinion that drifts from it. Returns a verdict
// only; the caller owns what to DO about it (scanBuilding builds dig/place steps, the protected filter
// just keeps or drops the key).
//
// 'unloaded' is its own verdict and is NOT air: bot.blockAt returns null for an unsensed chunk, and
// folding that into air fabricates a confident diff over cells the bot never looked at (Invariant B /
// Law 13 — never default a missing sensor reading).
function classifyVoxel(bot, x, y, z, rawExpType, externalTypes) {
  const expType = TYPE_ALIASES[rawExpType] || rawExpType;

  // A blueprint-declared external voxel (the farm's crop/river cells, the tree farm's sapling cells) is
  // owned by a foreign subsystem, not by this structure — never placed, never dug. The owning integrity
  // node is the sole authority on the cell's contents. This is the ONLY domain-aware branch, and it
  // carries no crop vocabulary — the blueprint names its own external types (Invariant D / Law 16).
  if (externalTypes && externalTypes.has(expType)) return { verdict: 'correct', expType, actName: null };

  // Unguarded: blockAt ANSWERS null for an unloaded column rather than throwing, and null is already the
  // 'unloaded' verdict one line down — the guard was catching nothing and could only have hidden our own
  // arithmetic producing a bad coordinate (Law 13: a coding violation must travel).
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

function scanBuilding(bot, pasted) {
  const expected = new Map();
  const externalTypes = pasted.external_types || new Set();
  for (const b of (pasted.voxels || [])) {
    const k = `${b.x},${b.y},${b.z}`;
    if (!expected.has(k)) expected.set(k, { type: b.type, anchor_index: b.anchor_index ?? -1 });
  }

  let correct = 0, missing = 0, mismatched = 0, extraneous = 0, unloaded = 0;
  const placeSteps = [];
  const digSteps   = [];
  // WHERE the unsensed cells are, not just how many (Architect 2026-08-13, the 2026-08-12 measurement
  // defect). An unloaded voxel emits no step by design — there is nothing to do about a cell nobody has
  // seen — but a consumer counting steps then reads "no work here" and cannot tell it apart from "built".
  // That is a well-formed falsehood crossing a machine boundary (Law 26): the 2026-08-12 trace reported
  // "26/167 structure placed" while both bots stood 158 blocks away and the site was bare ground. The
  // count alone cannot be attributed to an anchor, so the coordinates travel with it and every consumer
  // downstream can ask "is THIS anchor sensed" instead of inferring it from silence.
  const unloadedCells = [];

  for (const [k, expRec] of expected.entries()) {
    const ai        = expRec.anchor_index;
    const [x, y, z] = k.split(',').map(Number);
    const { verdict, expType, actName } = classifyVoxel(bot, x, y, z, expRec.type, externalTypes);
    const isGroupToken = !!(group_to_item && group_to_item[expType]);

    switch (verdict) {
      case 'correct':  correct++;  break;
      case 'unloaded':
        unloaded++;                          // emit no step — the bot never sensed this cell
        unloadedCells.push({ x, y, z, anchor_index: ai });
        break;
      case 'missing':
        missing++;
        placeSteps.push({ action: 'place', place: { x, y, z }, type: expType, anchor_index: ai, reason: 'missing', actual: actName, ...(isGroupToken ? { expected_group: expType } : {}) });
        break;
      case 'extraneous':
        extraneous++;
        digSteps.push({ action: 'dig', place: { x, y, z }, type: actName, anchor_index: ai, reason: 'should_be_air' });
        break;
      case 'group_mismatch':
        mismatched++;
        digSteps.push({ action: 'dig', place: { x, y, z }, type: actName, anchor_index: ai, reason: 'group_mismatch' });
        placeSteps.push({ action: 'place', place: { x, y, z }, type: expType, anchor_index: ai, reason: 'group_mismatch', actual: actName, expected_group: expType });
        break;
      case 'mismatch':
        mismatched++;
        digSteps.push({ action: 'dig', place: { x, y, z }, type: actName, anchor_index: ai, reason: 'mismatch' });
        placeSteps.push({ action: 'place', place: { x, y, z }, type: expType, anchor_index: ai, reason: 'mismatch', actual: actName });
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

// rotateOffsetY — rotate a horizontal (dx, dz) offset by `quarterTurns` 90° clockwise steps about the
// vertical (Y) axis. Only farmland's water-site search passes a non-zero value, so its water edge can
// face the actual riverbank whichever way the river runs; every locked-building caller passes 0 = the
// blueprint's literal facing. Y is never rotated — structures only ever spin about the vertical.
function rotateOffsetY(dx, dz, quarterTurns) {
  switch (((quarterTurns % 4) + 4) % 4) {
    case 1:  return { dx: dz,  dz: -dx };
    case 2:  return { dx: -dx, dz: -dz };
    case 3:  return { dx: -dz, dz: dx  };
    default: return { dx, dz };
  }
}

function transposeVoxel(buildCenter, blueprintCenter, v, quarterTurns = 0) {
  const r = rotateOffsetY(v[0] - blueprintCenter.x, v[2] - blueprintCenter.z, quarterTurns);
  return {
    x: buildCenter.x + r.dx,
    y: buildCenter.y + (v[1] - blueprintCenter.y),
    z: buildCenter.z + r.dz,
    type: v[3],
  };
}

// footprintExtent — the XZ ground area a blueprint actually occupies, expressed as OFFSETS from its
// build_center and already rotated by the same quarterTurns transposeVoxel applies. The one definition
// of "how far does this building reach in each compass direction" (Law 16): every caller that reserves
// ground, checks flatness, or rejects an overlap asks here rather than deriving it.
//
// WHY OFFSETS AND NOT A WIDTH: a width can only describe a footprint that is SYMMETRIC about the
// build_center, and nothing makes a blueprint symmetric — the build_center is wherever the author put
// the anchor, which for a mine head is at the shaft and for a staircase is at the top step, both off to
// one side of the mass. Reconstructing the box as `center ± floor(w/2)` silently slides it: the reach
// that lands on the far side of the origin is never checked for flatness and never reserved against a
// sibling, while an equal strip of untouched ground on the near side is checked and reserved for
// nothing. The failure is invisible because the box is still the right SIZE — it is in the wrong PLACE.
//
// Derived, never authored: `dimensions` in the blueprint file says how big the thing is, and a
// hand-written offset pair would be a second copy of a fact the voxels already carry, free to disagree
// with them after any edit in the designer.
function footprintExtent(building, quarterTurns = 0) {
  const voxels = collectAllVoxels(building);
  if (voxels.length === 0) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${building?.name || 'unknown'}" has no voxels, so it has no footprint. footprintExtent requires a blueprint with geometry.`);
  }
  const bc = building.build_center || { x: 0, y: 0, z: 0 };
  let minDX = Infinity, maxDX = -Infinity, minDZ = Infinity, maxDZ = -Infinity;
  for (const { raw } of voxels) {
    const r = rotateOffsetY(raw[0] - bc.x, raw[2] - bc.z, quarterTurns);
    if (r.dx < minDX) minDX = r.dx;
    if (r.dx > maxDX) maxDX = r.dx;
    if (r.dz < minDZ) minDZ = r.dz;
    if (r.dz > maxDZ) maxDZ = r.dz;
  }
  return {
    min_dx: minDX, max_dx: maxDX, min_dz: minDZ, max_dz: maxDZ,
    width:  maxDX - minDX + 1,
    length: maxDZ - minDZ + 1,
  };
}

// Candidate-backed voxel transpose: transposes a building's FULL voxel list to world coordinates
// against a GIVEN build center, before any set_buildspot chair exists. find_buildingspot's farmland
// overlay needs to read voxel TYPES around a candidate center to judge a site, which the chair-backed
// survey() can't do yet (no chair = no locked center). Reuses collectAllVoxels/transposeVoxel so there
// is one voxel-transpose definition (Law 16). quarterTurns rotates the whole set about the center.
function transposeVoxelsForCandidate(building, buildCenter, quarterTurns = 0) {
  if (!buildCenter || typeof buildCenter.x !== 'number') {
    throw new Error('[blueprint_survey] CODING VIOLATION: transposeVoxelsForCandidate requires a buildCenter {x,y,z}.');
  }
  const blueprintCenter = building.build_center || { x: 0, y: 0, z: 0 };
  return collectAllVoxels(building).map(({ raw, anchor_index }) => {
    const v = transposeVoxel(buildCenter, blueprintCenter, raw, quarterTurns);
    v.anchor_index = anchor_index;
    return v;
  });
}

// Transpose a blueprint's attach points to world coordinates against a GIVEN build center. Pure (no HQ
// read) so both the chair-backed resolver (getWorldAttachPoints) and candidate callers share ONE join
// definition (Law 16). Returns { A:{x,y,z}, ... } keyed by attach-point id.
function transposeAttachPoints(building, buildCenter) {
  if (!building || !Array.isArray(building.attach_points) || building.attach_points.length === 0) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${building?.name || 'unknown'}" has no attach_points array.`);
  }
  if (!buildCenter || typeof buildCenter.x !== 'number') {
    throw new Error('[blueprint_survey] CODING VIOLATION: transposeAttachPoints requires a buildCenter {x,y,z}.');
  }
  const blueprintCenter = building.build_center || { x: 0, y: 0, z: 0 };
  const out = {};
  for (const ap of building.attach_points) {
    const p = ap.position;
    out[ap.id] = {
      x: buildCenter.x + (p[0] - blueprintCenter.x),
      y: buildCenter.y + (p[1] - blueprintCenter.y),
      z: buildCenter.z + (p[2] - blueprintCenter.z),
    };
  }
  return out;
}

// Candidate-time anchor transpose (no HQ read) — the anchor twin of transposeVoxelsForCandidate, so a
// caller can locate the bot's STAND cells against a GIVEN center+rotation BEFORE a set_buildspot chair
// exists. find_buildingspot's farmland gate needs this to refuse a site whose anchor lands on water (the
// bot stands on its anchors; water there is the 47d half-pond livelock). getWorldAnchors is the chair-
// backed caller; both share this one transpose (Law 16 — same math as transposeVoxel).
function transposeAnchorsForCandidate(building, buildCenter, quarterTurns = 0) {
  if (!buildCenter || typeof buildCenter.x !== 'number') {
    throw new Error('[blueprint_survey] CODING VIOLATION: transposeAnchorsForCandidate requires a buildCenter {x,y,z}.');
  }
  if (!Array.isArray(building?.anchors) || building.anchors.length === 0) {
    throw new Error(`[blueprint_survey] CODING VIOLATION: blueprint "${building?.name || 'unknown'}" has no anchors array.`);
  }
  const blueprintCenter = building.build_center || { x: 0, y: 0, z: 0 };
  return building.anchors.map(a => {
    const pos = a.position;
    const r = rotateOffsetY(pos[0] - blueprintCenter.x, pos[2] - blueprintCenter.z, quarterTurns);
    return {
      x: buildCenter.x + r.dx,
      y: buildCenter.y + (pos[1] - blueprintCenter.y),
      z: buildCenter.z + r.dz,
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
  if (!setBuildspot?.build_center || typeof setBuildspot.build_center.x !== 'number') {
    throw new Error(`[blueprint_survey] CODING VIOLATION: No locked build_center for "${conferenceRoomKey}". set_buildspot must run before getWorldAnchors().`);
  }
  return transposeAnchorsForCandidate(building, setBuildspot.build_center, setBuildspot.rotation || 0);
}

// Chair-backed attach-point resolver: reads the locked build_center from set_buildspot's chair and
// transposes the named building's attach points to world. Mirrors getWorldAnchors.
function getWorldAttachPoints(blueprintName, conferenceRoomKey) {
  conferenceRoomKey = conferenceRoomKey || blueprintName;
  const building = blueprintRegistry.getBuilding(blueprintName, 'blueprint_survey');
  const setBuildspot = hq.readBuildingChair(conferenceRoomKey, 'set_buildspot');
  if (!setBuildspot?.build_center || typeof setBuildspot.build_center.x !== 'number') {
    throw new Error(`[blueprint_survey] CODING VIOLATION: No locked build_center for "${conferenceRoomKey}". set_buildspot must run before getWorldAttachPoints().`);
  }
  return transposeAttachPoints(building, setBuildspot.build_center);
}

// One transpose→world-key-set pathway (Law 16), two callers with opposite air policies:
//   getProtectedBlocks → SOLID voxels only (navigator's protected-block dig penalty must not touch
//                        the blueprint's own blocks).
//   getFootprintCells  → EVERY declared voxel incl. interior air (torch_integrity's overlap guard —
//                        a torch inside a blueprint's air cell is still "inside the blueprint").
// Returns null when the blueprint has no locked center yet.
// `bot` (optional) turns this from a PLAN read into a SENSED read, and that distinction is the whole
// point of it existing (Architect 2026-07-20: "for every max cost block it must be part of protected
// voxels and in the correct configuration").
//
// WITHOUT bot: every solid voxel the blueprint DECLARES — including cells that hold nothing but virgin
// terrain the bot has never touched. That is remembered intent, never re-sensed (Invariant B), and A*
// priced all of it at PROTECTED_VOXEL_DETOUR_BUDGET. The bots were therefore charged a full-budget detour to dig raw rock
// that merely happened to sit inside a future wall's footprint — which is how they sealed themselves
// out of a building they had not built yet, and why a 2-block hop cost 140,315 nodes and 31.7 seconds.
//
// WITH bot: only cells the world ALREADY MATCHES. Digging a correctly-placed furnace is still PROTECTED_VOXEL_DETOUR_BUDGET
// (it destroys finished work); digging rock that is in the way of a wall we have not built is an
// ordinary COST_HIGH dig, because it damages nothing. The verdict comes from classifyVoxel — the same
// one the integrity scan uses — so "correct" cannot mean two different things in two places (Law 16).
//
// A cell in an UNLOADED chunk stays protected: unsensed is not permission (Law 13, default stopped).
// `chair` — AN ALREADY-READ set_buildspot, handed in by a caller walking the WHOLE room.
//
// IT EXISTS BECAUSE THE ROOM KEY CARRIES AN OWNER AND THIS FUNCTION CANNOT RE-ADDRESS ONE. readBuildingChair
// forms the key for THIS process's owner, which is right for a caller naming a structure ('headframe') and
// wrong for a caller iterating every owner's rooms — it would re-prefix a key that already carries somebody
// else's name, and find nothing. The walkers below hold the entry already; passing it is both correct and
// one lookup cheaper than asking for it back (Law 16 — one addressing rule, and the walker is outside it).
function worldVoxelKeys(blueprintName, conferenceRoomKey, { includeAir, bot = null, externalTypes = null, chair = null }) {
  const building = blueprintRegistry.tryGetBuilding(blueprintName);
  const allVoxels = building ? collectAllVoxels(building) : [];
  if (!building || allVoxels.length === 0) return null;

  const setBuildspot = chair || hq.readBuildingChair(conferenceRoomKey || blueprintName, 'set_buildspot');
  if (!setBuildspot?.build_center || typeof setBuildspot.build_center.x !== 'number') return null;

  const buildCenter     = setBuildspot.build_center;
  const blueprintCenter = building.build_center || { x: 0, y: 0, z: 0 };
  const rotation        = setBuildspot.rotation || 0;

  const set = new Set();
  for (const { raw } of allVoxels) {
    const world = transposeVoxel(buildCenter, blueprintCenter, raw, rotation);
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

// getAllProtectedBlocks — every SOLID voxel of EVERY blueprint that has a locked build_center, as
// one "x,y,z" key Set. The plural twin of getProtectedBlocks(name), and the one the navigator wants.
//
// WHY plural is the only safe shape here (Architect 2026-07-15, round 36: "extend it to building and
// other types of integrities. so every build block is protected"): asking by NAME protects the
// blueprint you remembered to name and silently leaves every other build a cheap doorway. The
// navigator asked for 'headframe' and nothing else, so `farmland_alternating_rows_fence` — locked at
// (43,62,19) in the same conference room — was unprotected the whole time. A* prices digging or
// COVERING an unprotected voxel at COST_HIGH/COST_PLACE instead of PROTECTED_VOXEL_DETOUR_BUDGET, and the navigator's
// BUILD_PREFS start ['cobblestone','dirt','stone'] — which is the unexplained "10 stone, 5 dirt"
// buried in Tessa's crop slots (round 35 open item #3: farm_executor "carries dirt:96 and no stone,
// so it cannot have placed the 10 stone. Unproven mechanism"). It was never farm_executor.
//
// Enumeration is over the HQ ROOM (every LOCKED conference-room key), not the blueprint file. WHY the
// source moved (Architect 2026-07-16, per-instance farms): a blueprint can now be locked under a key that
// is NOT its file name — the 32 phase-1 wheat plots all share geometry `wheat_plot_pair` but instances 1+
// are locked under `wheat_plot_pair#1`…`wheat_plot_pair#31`. Enumerating `Object.keys(buildings)` (the old
// way) would find only the file names and leave every instanced plot UNPROTECTED — the exact "one voxel, a
// cheap doorway" hole the round-36 note below warns about, reopened by instancing. The locked-chair set IS
// the authority on what is built, so that is what we walk: each entry's `set_buildspot.build_center` proves
// it is locked, and `blueprint_paster.building_name` names the geometry to transpose (falling back to the
// key for the common key==name case). Mining's own blueprints (staircase, cell) still have no chair here
// and fall out — mining_integrity/mining_cell_graph own those, and the navigator merges all three Sets.
//
// WHY protecting EVERY build matters (Architect 2026-07-15, round 36: "extend it to building and other
// types of integrities. so every build block is protected"): asking by NAME protects the blueprint you
// remembered to name and silently leaves every other build a cheap doorway. The navigator asked for
// 'headframe' and nothing else, so `farmland_alternating_rows_fence` — locked in the same conference room —
// was unprotected the whole time. A* prices digging or COVERING an unprotected voxel at COST_HIGH/COST_PLACE
// instead of PROTECTED_VOXEL_DETOUR_BUDGET, and the navigator's BUILD_PREFS start ['cobblestone','dirt','stone'] — which was the
// unexplained "10 stone, 5 dirt" buried in Tessa's crop slots (round 35). It was never farm_executor.
function getAllProtectedBlocks(bot = null) {
  const room = hq.readOffice('building_confrence_room', {});
  const set = new Set();
  for (const [roomKey, entry] of Object.entries(room || {})) {
    const sb = entry?.set_buildspot;
    if (!sb?.build_center || typeof sb.build_center.x !== 'number') continue;   // not a locked instance
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(roomKey);   // geometry name (fallback strips the owner)
    const keys = worldVoxelKeys(blueprintName, roomKey, { includeAir: false, bot, chair: sb });
    if (keys) for (const k of keys) set.add(k);
  }
  return set.size > 0 ? set : null;
}

function getFootprintCells(blueprintName, conferenceRoomKey) {
  return worldVoxelKeys(blueprintName, conferenceRoomKey, { includeAir: true });
}

// getAllFootprintCells — every DECLARED cell, interior air included, of EVERY blueprint that has a locked
// build_center, as one "x,y,z" key Set. The plural twin of getFootprintCells, walking the same locked
// conference-room keys getAllProtectedBlocks walks (Law 16 — one authority on what is locked, and an
// instanced plot like `wheat_plot_pair#7` is reached by walking the room rather than the blueprint file).
//
// IT IS DELIBERATELY THE PLANNED SET, AND THAT IS WHAT SEPARATES IT FROM getAllProtectedBlocks(bot).
// The protected set answers "what would I destroy if I dug here" and is diffed against the world on
// purpose: pricing unbuilt terrain as protected is what once turned a 2-block hop into a 140,315-node
// search. This one answers a different question — "is this cell spoken for by a building" — and the
// answer has to be yes BEFORE the building exists, because the whole point of asking is to keep a block
// out of ground that is going to be built on later.
//
// SO IT MUST NEVER BE MERGED INTO loadProtectedBlocks. The two sets share a shape and mean opposite
// things; unioning them reinstates the pathfinding regression with no line saying it happened.
//
// The one caller today is the bootstrap crafting table's placement search (craft_handler): a table left
// standing permanently inside a footprint is a block the builder has to break before it can lay that
// voxel, which is the digging this fleet no longer does.
function getAllFootprintCells() {
  const room = hq.readOffice('building_confrence_room', {});
  const set = new Set();
  for (const [roomKey, entry] of Object.entries(room || {})) {
    const sb = entry?.set_buildspot;
    if (!sb?.build_center || typeof sb.build_center.x !== 'number') continue;   // not a locked instance
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(roomKey);   // geometry name (fallback strips the owner)
    const keys = worldVoxelKeys(blueprintName, roomKey, { includeAir: true, chair: sb });
    if (keys) for (const k of keys) set.add(k);
  }
  return set.size > 0 ? set : null;
}

// ── resolveVoxelAnchor — "which anchor owns the block at this world cell?" ────────────────────────
//
// THE STAND FOR USING A STATION, AND IT IS AUTHORED RATHER THAN SEARCHED (Architect 2026-08-31):
//   *"since all chests and furnaces operate off of blueprints … instead of the LOS logic, remove all of
//   that and instead walk the blueprint and stand at the anchor the station is placed on … the anchor is
//   a designated building point and is a pre approved location to stand and reach every block within its
//   domain so reuse it instead of making some non deterministic way to stand."*
//
// WHY A SEARCHED STANCE WAS WRONG, twice over, and both failures were watched live. A raycast vantage is
// satisfied from anywhere inside BLOCK_REACH with a clear line — across a room, through a doorway — so a
// bot reported ARRIVED without moving and then retried a chest window it could not reach, forever. The
// radius goal that replaced it for one day fixed the reach and kept the real defect: a radius admits many
// cells, the search takes whichever is cheapest from where the body happens to be, and "cheapest" from
// outside a building is a cell OUTSIDE THE WALL. That is a bot opening a chest through masonry in front of
// other players, and it is a shared-world rule this fleet does not get to break for convenience.
//
// The anchor is already the answer. It is the cell build_executor stands on to BUILD that group of voxels,
// chosen when the blueprint was authored, and its whole contract is that every voxel in its domain is
// within reach from it. Verified across the entire blueprint set the day this landed: every station voxel
// in `headframe` (anchors 0 and 3), `contractor_house` (anchor 0) and `temp_construction_chest` sits
// between 1.00 and 1.73 from its own anchor's stand cell, and no station is an unassigned voxel. So this
// is not a new stance to validate — it is the one the fleet already trusts, reused (Law 16).
//
// RETURNS the ANCHOR BLOCK, never the stand cell: the "+1 to stand on top of it" conversion has exactly
// one home and it is `locomotion.goToStand`. Two places doing that arithmetic is how they come to disagree.
//
// Null means NO blueprint claims this cell. The Architect named the one legitimate case himself — *"with
// the only exception being a temporary crafting table to boostrap the bot"* — a table a bot sets down
// beside itself and picks back up. Callers must treat null as "this station has no authored stance",
// never as permission to improvise one.
//
// Enumeration matches getAllProtectedBlocks: every LOCKED conference-room key, because a blueprint may be
// locked under a key that is not its file name (the instanced wheat plots). Keys are walked SORTED so two
// blueprints overlapping one cell resolve to the same anchor on every machine and every run (Law 19).
function resolveVoxelAnchor(pos) {
  if (!pos || typeof pos.x !== 'number') {
    throw new Error(`[blueprint_survey] CODING VIOLATION: resolveVoxelAnchor needs a {x,y,z}. Got: ${require('util').inspect(pos)}`);
  }
  const wantKey = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  const room = hq.readOffice('building_confrence_room', {});
  for (const roomKey of Object.keys(room || {}).sort()) {
    const entry = room[roomKey];
    const sb = entry?.set_buildspot;
    if (!sb?.build_center || typeof sb.build_center.x !== 'number') continue;   // not a locked instance
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(roomKey);   // geometry name (fallback strips the owner)
    const building = blueprintRegistry.tryGetBuilding(blueprintName);
    if (!building) continue;
    const allVoxels = collectAllVoxels(building);
    if (allVoxels.length === 0) continue;
    const blueprintCenter = building.build_center || { x: 0, y: 0, z: 0 };
    const rotation = sb.rotation || 0;
    for (const { raw, anchor_index } of allVoxels) {
      const world = transposeVoxel(sb.build_center, blueprintCenter, raw, rotation);
      if (`${world.x},${world.y},${world.z}` !== wantKey) continue;
      // An UNASSIGNED voxel belongs to the blueprint but to no anchor, so there is no authored stance for
      // it. Reported with the owner named rather than as a bare null, because "no blueprint has this cell"
      // and "this blueprint has it but filed it outside every anchor" are different facts and only the
      // second is a blueprint that wants editing (Law 25).
      if (anchor_index < 0) {
        return { blueprint: blueprintName, roomKey, anchorIndex: -1, anchor: null, type: world.type, reason: 'unassigned_voxel' };
      }
      const anchors = transposeAnchorsForCandidate(building, sb.build_center, rotation);
      return { blueprint: blueprintName, roomKey, anchorIndex: anchor_index, anchor: anchors[anchor_index], type: world.type };
    }
  }
  return null;
}

// survey(bot, blueprintName, conferenceRoomKey, opts) — the neutral scan. Loads the blueprint + the
// locked build_center from set_buildspot's chair, transposes every voxel to world, and diffs against
// reality. Returns the RAW structural verdict; craft-material aggregation, anchor status, and logging
// are the wrapping integrity node's concern, not this engine's.
//   { all_complete, steps, stats, summary, voxels (world), footprint, build_center, anchor_count }
function survey(bot, blueprintName, conferenceRoomKey, opts) {
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
  if (!setBuildspot?.build_center || typeof setBuildspot.build_center.x !== 'number') {
    throw new Error(`[blueprint_survey] CODING VIOLATION: No locked build_center for "${conferenceRoomKey}". set_buildspot must run before survey().`);
  }
  const buildCenter     = setBuildspot.build_center;
  const blueprintCenter = building.build_center || { x: 0, y: 0, z: 0 };
  const rotation        = setBuildspot.rotation || 0;

  const voxels = allVoxels.map(({ raw, anchor_index }) => {
    const v = transposeVoxel(buildCenter, blueprintCenter, raw, rotation);
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
  // NO CATCH (r33/F2). This used to `catch → result = null` — the SAME value scanBuilding returns as
  // its legitimate "nothing left to do" sentinel (:149). So `all_complete: result === null` below
  // reported a CRASHED SCAN AS A COMPLETED BUILDING, with steps: [] and summary "all voxels match
  // world state", and the judge acted on that verdict. Never reuse a success sentinel for an error.
  // A throw here is a coding violation, not an environmental outcome: the one genuine world condition
  // (unloaded chunks) is handled by RETURN at :149, never by throwing. So let it crash for inspection
  // (Law 13) rather than launder itself into a false completion.
  const result = scanBuilding(bot, pasted);
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
    build_center:     buildCenter,
    anchor_count:     Array.isArray(building.anchors) ? building.anchors.length : 0,
  };
}

module.exports = {
  survey,
  scanBuilding,
  classifyVoxel,   // the one definition of "does the world match the blueprint here" (mining_integrity reuses it)
  collectAllVoxels,
  isAir,
  rotateOffsetY,
  footprintExtent,   // the one definition of a blueprint's XZ reach, as offsets from its build_center
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
  resolveVoxelAnchor,
};
