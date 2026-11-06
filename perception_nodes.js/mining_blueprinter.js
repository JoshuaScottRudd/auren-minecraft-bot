// perception node: mining_blueprinter (staircase generation)
//
// Generates the underground mining descent as a diagonal staircase, by tiling the
// `architect_staircase_final` blueprint downward via attach points. Uses the headframe site locked in
// corporate_headquarters.json (building_confrence_room.headframe.set_buildspot). Returns the segment plan
// in memory — mining_integrity calls generateStaircase() on each scan, so the segment plan is always
// regenerated from the current blueprint set. That set is the boot snapshot held by
// @kernel/blueprint_registry, not the file on disk: an edit to building_blueprints.json applies at the
// next start, never mid-run.
//
// Attach-point tiling: every blueprint declares lettered attach points (A, B, ...) relative to its build
// center. Connection is expressed as one point meeting another — the child's point is placed on the
// parent's point. No offset arithmetic, no rotation table.
//   - Convention here: attach 'A' = inbound (top) joint, 'B' = outbound (bottom) joint.
//   - The first staircase copy's A lands on the headframe's attach A (one block below the headframe
//     transpose origin: headframe A = (0,-1,0)).
//   - Each subsequent copy's A lands on the previous copy's B, a per-copy translation of (B - A) =
//     (3,-3,0) for the current staircase; the step is derived from the attach points, so a redesigned
//     staircase derives its own step.
//   Heading is fixed east (Law 19 determinism), so tiling is pure translation: no rotation. Attach points
//   carry position only; a piece that must attach rotated needs an orientation field.
//
// Overlap-agreement rule (Law 13 / Law 16): where two copies meet, the cell under one copy's attach point
// is the same world voxel as the cell under the other's. Both sides must agree on that voxel or the
// maintenance diff oscillates (one says air, the other a block: dig, place, dig, place forever).
// Resolution: identical block, or dominant/submissive (one defines it, the other leaves it undefined).
// This module enforces it: two copies writing the same world cell with different types is a coding
// violation, and throws. It never silently picks a winner.
//
// Pure computation: no bot, no world reads, no signal bus (Law 1 perception exception — this consumes an
// already-written scan result, the same way blueprint_paster consumes set_buildspot's locked
// transpose_origin).

const blueprintRegistry = require('@kernel/blueprint_registry');
const hq = require('@kernel/corporate_headquarters');
// collectAllVoxels resolves a blueprint's voxels from anchors[].voxels (the anchor
// model, e.g. the staircase), unassigned_voxels, or a legacy voxels array. Imported (not
// forked) so mining and building segments read their voxels through the same resolver (Law 16).
const { collectAllVoxels, transposeAttachPoints } = require('@perception/building_integrity');

const HEADFRAME_BLUEPRINT = 'headframe';
const STAIRCASE_BLUEPRINT = 'architect_staircase_final';
const LANDING_BLUEPRINT = 'architect_staircase_landing';
// Attach-point letters. 'A' is the inbound/top joint every piece exposes; 'B' is the
// staircase's outbound/bottom joint that the next copy's A attaches to.
const INBOUND_ID  = 'A';
const OUTBOUND_ID = 'B';

// Coordinate-as-ID: a segment's world origin is its identity ("x|y|z"). Naturally unique,
// self-describing, survives restart. Reachability ordering falls out of Y sorting.
function makeSegmentId(origin) {
  return `${origin.x}|${origin.y}|${origin.z}`;
}

// Reachability sort: shallower segments (higher Y) must be completed first. For equal Y,
// sort by X then Z for deterministic ordering.
function comparePriority(a, b) {
  const ay = a.world_position.y, by = b.world_position.y;
  if (ay !== by) return by - ay;
  const ax = a.world_position.x, bx = b.world_position.x;
  if (ax !== bx) return ax - bx;
  return a.world_position.z - b.world_position.z;
}

function loadBuildings() {
  return blueprintRegistry.getBuildings();
}

// Look up a blueprint's attach point by letter. Returns its [x,y,z] relative to the
// transpose origin. A missing attach point is a coding violation -- tiling cannot proceed.
function attachPoint(building, id) {
  const list = building.attach_points || [];
  const ap = list.find(p => p.id === id);
  if (!ap || !Array.isArray(ap.position)) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: blueprint "${building.name || 'unknown'}" has no attach point "${id}".`);
  }
  return ap.position;
}

// Flat [x,y,z,type,facing?] voxels relative to the blueprint's transpose origin.
function blueprintVoxels(building) {
  const collected = collectAllVoxels(building);
  if (collected.length === 0) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: blueprint "${building.name || 'unknown'}" has no voxels (checked anchors[].voxels, unassigned_voxels, legacy voxels).`);
  }
  return collected.map(({ raw }) => raw);
}

// Translate one voxel by a world origin. Pure translation: a turned staircase is turned once, in its blueprint
// (turnedStair), before any copy is placed.
function translateVoxel(v, origin) {
  const out = [origin.x + v[0], origin.y + v[1], origin.z + v[2], v[3]];
  if (v[4]) out.push(v[4]);
  return out;
}

// placeVoxelsAt -- stamp a blueprint's voxels at a world origin (no rotation). Returns
// { voxels } in the [wx,wy,wz,type,facing?] shape the diff engine consumes. Used for
// single-piece placement (e.g. cells) that does not need attach-point tiling.
function placeVoxelsAt(building, origin) {
  return { voxels: blueprintVoxels(building).map(v => translateVoxel(v, origin)) };
}

// ----------------------------------------------------------------------------
// loadSite: read the headframe's locked site from corporate_headquarters.json
// (building_confrence_room.headframe.set_buildspot), written by the foreman's hub (foreman_hub.lockSite).
// Carries the transpose_origin find_buildingspot proved a safe diagonal staircase can descend
// from (.staircase), plus the proven-safe depth. Law 13: a missing chair or missing
// .staircase is a coding violation -- the descent cannot be generated for a site never
// proven safe and locked.
// ----------------------------------------------------------------------------
// ── WHICH SITE THE SHAFT HANGS FROM (architect_config.SHAFT_HEAD) ─────────────────────────────────────
// A homestead's shaft descends from the headframe's attach A; a builder's is its own `shallow_shaft` site,
// whose transpose_origin is the top joint directly, with no headframe attach point involved.
// Every reader of "where is the mine" asks these three, so the two shapes are one question (Law 16).
function shaftStructure() {
  return require('@thinking/architect_config').SHAFT_HEAD[require('@kernel/bot_mandate').currentMode()];
}
// shaftChair() → the locked site chair carrying the shaft, or null while none is locked.
function shaftChair() {
  const site = hq.readBuildingChair(shaftStructure(), 'set_buildspot');
  return (site?.transpose_origin && site?.staircase) ? site : null;
}
// shaftTop(site) → the world cell the first staircase copy's inbound joint lands on.
function shaftTop(site) {
  if (shaftStructure() !== HEADFRAME_BLUEPRINT) return site.transpose_origin;
  const headframe = loadBuildings()[HEADFRAME_BLUEPRINT];
  if (!headframe) throw new Error(`[mining_blueprinter] CODING VIOLATION: "${HEADFRAME_BLUEPRINT}" not found in building_blueprints.json.`);
  const a = transposeAttachPoints(headframe, site.transpose_origin)[INBOUND_ID];
  if (!a) throw new Error(`[mining_blueprinter] CODING VIOLATION: headframe has no attach point "${INBOUND_ID}".`);
  return a;
}

function loadSite() {
  const site = shaftChair();
  if (!site) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: building_confrence_room.${shaftStructure()}.set_buildspot has no locked transpose_origin + staircase data -- the foreman sites the shaft before generating the staircase.`);
  }
  return {
    transposeOrigin: site.transpose_origin,        // {x,y,z} -- the shaft's site origin in the world
    headAWorld:  shaftTop(site),
    turn:        siteTurn(site),
    surfaceY:    site.staircase.surfaceY,
    lowestSafeY: site.staircase.lowestSafeY,
    descent:     siteDescent(site),
  };
}

// siteDescent(site) → { lowestSafeY, route } of the whole descent a locked site carries: the shallow shaft and, where
// siting found a route, the deep shaft below it.
function siteDescent(site) {
  const deep = site.staircase.deep;
  return deep ? { lowestSafeY: deep.lowestSafeY, route: deep.route } : { lowestSafeY: site.staircase.lowestSafeY, route: [] };
}

// ── THE STAIRCASE FACES THE WAY ITS SHAFT HEAD FACES ──────────────────────────────────────────────────────
// The staircase is authored descending east. A shaft head locked with a turn (transpose_origin.turn, blueprint_survey)
// descends that many quarter turns clockwise from east, the whole staircase turned once about its transpose origin:
// voxels, facing states, anchors, attach points and light points. Every reader takes the turn from the shaft's site.
function siteTurn(site) {
  return require('@perception/blueprint_survey').turnOf(site && site.transpose_origin);
}
const turnedStairs = new Map();   // turn -> the turned staircase; the blueprint is fixed for the process
function turnedStair(turn) {
  if (turnedStairs.has(turn)) return turnedStairs.get(turn);
  const stair = loadBuildings()[STAIRCASE_BLUEPRINT];
  if (!stair) throw new Error(`[mining_blueprinter] CODING VIOLATION: "${STAIRCASE_BLUEPRINT}" not found in building_blueprints.json.`);
  const { rotateXZ, turnState, turnOf } = require('@perception/blueprint_survey');
  const t = turnOf({ turn });
  const r = (p) => { const [x, z] = rotateXZ(t, p[0], p[2]); return [x, p[1], z]; };
  const out = {
    stair, turn: t,
    voxels: blueprintVoxels(stair).map(v => { const out = [...r(v), v[3]]; if (v[4]) out.push(turnState(t, v[4])); return out; }),
    anchors: (stair.anchors || []).map(a => r(a.position)),
    attach: (id) => r(attachPoint(stair, id)),
    attachPoints: (stair.attach_points || []).map(p => ({ id: p.id, position: r(p.position), authored: p.position })),
    lights: (stair.light_points || []).map(p => ({ position: r(p.position), wall: r(p.wall) })),
  };
  turnedStairs.set(turn, out);
  return out;
}

// ── A SHAFT TURNS ON A LANDING ────────────────────────────────────────────────────────────────────────────
// turnedLanding(turn, side) → the landing piece for a flight heading `turn`, leaving to its 'right' (one quarter turn
// clockwise, as authored) or 'left' (authored mirrored in z). Attach points carry position only, so the new heading is
// stated here, beside the mirror that decides it.
const LANDING_SIDES = Object.freeze({ right: 1, left: 3 });
const turnedLandings = new Map();
function turnedLanding(turn, side) {
  if (!LANDING_SIDES[side]) throw new Error(`[mining_blueprinter] CODING VIOLATION: a landing turns 'right' or 'left', not ${JSON.stringify(side)}.`);
  const key = `${turn}|${side}`;
  if (turnedLandings.has(key)) return turnedLandings.get(key);
  const landing = loadBuildings()[LANDING_BLUEPRINT];
  if (!landing) throw new Error(`[mining_blueprinter] CODING VIOLATION: "${LANDING_BLUEPRINT}" not found in building_blueprints.json.`);
  const { rotateXZ } = require('@perception/blueprint_survey');
  const r = (p) => { const [x, z] = rotateXZ(turn, p[0], side === 'left' ? -p[2] : p[2]); return [x, p[1], z]; };
  const out = {
    voxels: blueprintVoxels(landing).map(v => [...r(v), v[3]]),
    anchors: (landing.anchors || []).map(a => r(a.position)),
    out: r(attachPoint(landing, OUTBOUND_ID)),
    heading: (turn + LANDING_SIDES[side]) % 4,
  };
  turnedLandings.set(key, out);
  return out;
}

// placePiece(origin, heading, side) → one piece of the descent at a world origin: a flight, or with `side` a landing.
// { voxels, anchors, minY, next: { origin, heading } }, in world cells, `next` being where the piece after it starts.
function placePiece(origin, heading, side = null) {
  const shape = side ? turnedLanding(heading, side) : turnedStair(heading);
  const out = side ? shape.out : shape.attach(OUTBOUND_ID);
  const voxels = shape.voxels.map(v => translateVoxel(v, origin));
  return {
    voxels,
    anchors: shape.anchors.map(p => ({ x: origin.x + p[0], y: origin.y + p[1], z: origin.z + p[2] })),
    minY: Math.min(...voxels.map(v => v[1])),
    next: { origin: { x: origin.x + out[0], y: origin.y + out[1], z: origin.z + out[2] }, heading: side ? shape.heading : heading },
  };
}

// staircaseSideAttaches: the joints a CELL hangs on — every attach point except the A/B
// tiling joints. `outward` is the across-walkway direction the cell grows: the walkway runs
// east (heading fixed), so z is across it (+z south, -z north); a purely-x attach
// would grow east/west. Cell-side geometry lives HERE (Law 16) so mining_cell_graph consumes
// ready-made {id, rel, outward} and holds no staircase-blueprint knowledge of its own.
// On a turned staircase the authored outward turns with it (`turn`, as the shaft's site carries it).
function staircaseSideAttaches(turn = 0) {
  const ts = turnedStair(turn);
  const COMPASS = ['north', 'east', 'south', 'west'];
  return ts.attachPoints.filter(p => p.id !== INBOUND_ID && p.id !== OUTBOUND_ID).map(p => {
    const a = p.authored;
    const authored = a[2] > 0 ? 'south' : a[2] < 0 ? 'north' : a[0] > 0 ? 'east' : 'west';
    return { id: p.id, rel: p.position, outward: COMPASS[(COMPASS.indexOf(authored) + ts.turn) % 4] };
  });
}

// ----------------------------------------------------------------------------
// projectStaircase: PURE tiling. Given the WORLD position of the headframe's attach A and
// the proven-safe floor (lowestSafeY), tile architect_staircase_final downward by attach
// points. No HQ read, no bot -- so find_buildingspot can call it for a CANDIDATE site
// (pre-lock, before any chair exists) and generateStaircase can call it for the LOCKED
// site. ONE tiling pathway (Law 16): the volume find_buildingspot hazard-scans is the exact
// volume this builds.
//
// Copy 0's inbound (A) lands on headAWorld; copy n+1's A lands on copy n's B, which reduces
// to a per-copy translation of (B - A). Only whole copies whose deepest voxel stays
// at/above lowestSafeY are emitted -- no partial, unproven segment. Enforces the
// overlap-agreement rule across copies (throw on disagreement, dedupe identical shared cells
// into the shallower copy).
//
// Returns:
//   segments       [{ id, type, world_position, voxel_count, anchors:[{x,y,z}], voxels, summary }]
//                  -- anchors are the staircase's anchor stand-spots transposed per copy
//                     (the anchored stationary builder needs them to pick stand spots).
//   occupiedCells  Map "x,y,z" -> type. EVERY cell the staircase defines (air + solid) =
//                  the exact prism find_buildingspot must hazard-check.
//   step           {x,y,z} the first flight's per-copy translation (B - A).
//   minVoxY        staircase's lowest voxel Y (relative). bottomY: world Y of deepest voxel.
// ----------------------------------------------------------------------------
function projectStaircase({ headAWorld, lowestSafeY, turn = 0, route = [] }) {
  if (!headAWorld || typeof headAWorld.x !== 'number' || typeof headAWorld.y !== 'number' || typeof headAWorld.z !== 'number') {
    throw new Error('[mining_blueprinter] CODING VIOLATION: projectStaircase requires headAWorld {x,y,z}.');
  }
  if (typeof lowestSafeY !== 'number') {
    throw new Error('[mining_blueprinter] CODING VIOLATION: projectStaircase requires numeric lowestSafeY.');
  }

  const ts = turnedStair(turn);
  const stairIn  = ts.attach(INBOUND_ID);  // staircase top joint  (0,0,0)
  const stairOut = ts.attach(OUTBOUND_ID); // staircase bottom joint (3,-3,0) as authored, turned with the shaft

  // Per-copy translation: place the child's inbound (A) on the parent's outbound (B).
  const step = { x: stairOut[0] - stairIn[0], y: stairOut[1] - stairIn[1], z: stairOut[2] - stairIn[2] };
  if (step.y >= 0) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: staircase attach B is not below attach A (step.y=${step.y}); the descent must go down.`);
  }

  // Anchor stand-spots (relative to transpose origin), transposed per copy below. Missing anchors
  // is a coding violation -- the anchored stationary builder needs stand spots.
  const stairAnchors = ts.anchors;
  if (stairAnchors.length === 0) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: "${STAIRCASE_BLUEPRINT}" has no anchors -- the anchored builder needs stand spots.`);
  }

  const stairVox = ts.voxels;
  const minVoxY = Math.min(...stairVox.map(v => v[1]));

  // Copy 0's inbound (A) lands on headAWorld; each piece after it starts where the last one ends. `route` names the
  // pieces that are landings: [{ at: piece index, side }]. Only whole pieces whose deepest voxel stays at/above
  // lowestSafeY are emitted. May be none (site too shallow for even one copy). projectStaircase reports that as an
  // empty result -- a legitimate DATA outcome for the candidate-scan path (find_buildingspot rejects it). The
  // locked-site path (generateStaircase) treats 0 copies as a coding violation, since find_buildingspot already
  // proved the depth before locking.
  //
  // Each piece is checked against the overlap-agreement rule. occupiedCells maps a claimed world cell to its block
  // type: a second piece claiming the same cell with a DIFFERENT type is a disagreement (oscillation) -> throw; the
  // SAME type is deduped so the cell lives in exactly one segment (the shallower piece that claimed it first).
  const landings = new Map(route.map(r => [r.at, r.side]));
  const start = { x: headAWorld.x - stairIn[0], y: headAWorld.y - stairIn[1], z: headAWorld.z - stairIn[2] };
  const occupiedCells = new Map();
  const segments = [];
  let at = { origin: start, heading: ts.turn };
  let bottom = start.y + minVoxY;
  for (let n = 0; ; n++) {
    if (n > 1024) throw new Error('[mining_blueprinter] CODING VIOLATION: staircase repeat count exceeded 1024 -- bad site depth.');
    const side = landings.get(n) || null;
    const piece = placePiece(at.origin, at.heading, side);
    if (piece.minY < lowestSafeY) break;
    bottom = piece.minY;
    const placed = [];
    for (const wv of piece.voxels) {
      const key = `${wv[0]},${wv[1]},${wv[2]}`;
      const prev = occupiedCells.get(key);
      if (prev !== undefined) {
        if (prev !== wv[3]) {
          throw new Error(`[mining_blueprinter] CODING VIOLATION (attach-point overlap): world (${key}) is "${prev}" in one staircase copy and "${wv[3]}" in another. The two disagree, which oscillates the maintenance diff (dig/place forever). Make the shared voxel identical, or leave one side undefined (dominant/submissive).`);
        }
        continue; // identical -- already claimed by a shallower copy
      }
      occupiedCells.set(key, wv[3]);
      placed.push(wv);
    }
    const id = makeSegmentId(at.origin);
    segments.push({
      id,
      type: 'staircase',
      piece: side ? 'landing' : 'flight',
      turn: at.heading,
      world_position: at.origin,
      voxel_count: placed.length,
      anchors: piece.anchors,
      summary: `staircase ${id} y=${at.origin.y}..${piece.minY}`,
      voxels: placed,
    });
    at = piece.next;
  }

  // bottomY = deepest voxel Y across all emitted copies; for an empty result, the floor the
  // first (unbuilt) copy WOULD reach -- so callers can report how shallow the site is.
  return { segments, occupiedCells, step, minVoxY, bottomY: bottom, repeatCount: segments.length };
}

// ----------------------------------------------------------------------------
// generateStaircase: LOCKED-site wrapper around projectStaircase. Reads the headframe's
// locked site from the HQ chair, resolves the headframe attach A to world, projects the
// staircase, and wraps the segments with site metadata. mining_integrity/blueprint_paster
// call this; find_buildingspot calls projectStaircase directly with a candidate site.
// ----------------------------------------------------------------------------
function generateStaircase() {
  const site = loadSite();
  // The top joint comes from shaftTop — the headframe's attach A through the shared attach-point resolver, or a
  // standalone shaft's own site — so the join has ONE definition (Law 16).
  const bc = site.transposeOrigin;
  const headAWorld = site.headAWorld;

  const { segments, step, bottomY, minVoxY } = projectStaircase({ headAWorld, turn: site.turn, ...site.descent });
  // TWO SHAFTS, ONE DESCENT: a piece of the straight run to the iron band is the shallow shaft's, every piece below it the
  // deep shaft's, which no reader digs until a material opens it (mining_integrity.setDeepOpen).
  for (const seg of segments) seg.part = seg.piece === 'flight' && seg.world_position.y + minVoxY >= site.lowestSafeY ? 'shallow' : 'deep';
  if (segments.length < 1) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: locked site (headframe A y=${headAWorld.y}, lowestSafeY=${site.lowestSafeY}) is not deep enough for one staircase copy -- find_buildingspot should have rejected it before set_buildspot locked it.`);
  }
  const totalVoxels = segments.reduce((sum, seg) => sum + seg.voxel_count, 0);

  return {
    schema: 'auren.mining_blueprinter.v2',
    generated_at: new Date().toISOString(),
    site: {
      startX: bc.x,
      startZ: bc.z,
      surfaceY: site.surfaceY,
      lowestSafeY: site.lowestSafeY,
    },
    total_voxels: totalVoxels,
    turn: site.turn,
    staircase_segments: segments,
    summary: `Generated ${segments.length} staircase copy(ies) (${totalVoxels} voxels), attach-point tiled (step ${step.x},${step.y},${step.z}) from headframe attach A (y=${headAWorld.y}) down to y=${bottomY}, within the proven-safe depth (lowestSafeY=${site.lowestSafeY}).`,
  };
}

// stairLamps(segments) → the staircase's wall torches, each { source, attach } in world cells: the light points the
// staircase blueprint declares (light_points: the cell the torch stands in, the block it hangs on), on every
// TORCH_NETWORK.stair_every-th copy counted from the top, and on the bottom copy, so the foot of a staircase of any
// depth is lit. `segments` are projectStaircase's, top copy first.
function stairLamps(segments, turn = 0) {
  const stair = turnedStair(turn).stair;
  if (!Array.isArray(stair.light_points) || stair.light_points.length === 0) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: "${STAIRCASE_BLUEPRINT}" declares no light_points; the staircase is lit only where its blueprint says.`);
  }
  const every = require('@thinking/architect_config').TORCH_NETWORK.stair_every;
  const out = [];
  const flights = segments.filter(seg => seg.piece !== 'landing');
  flights.forEach((seg, n) => {
    if (n % every !== 0 && n !== flights.length - 1) return;
    const o = seg.world_position;
    const at = (p) => ({ x: o.x + p[0], y: o.y + p[1], z: o.z + p[2] });
    for (const p of turnedStair(seg.turn).lights) out.push({ source: at(p.position), attach: at(p.wall) });
  });
  return out;
}

if (require.main === module) {
  const result = generateStaircase();
  console.log(result.summary);
  for (const seg of result.staircase_segments) {
    console.log(`  ${seg.summary}`);
  }
}

module.exports = {
  shaftStructure, shaftChair, shaftTop, siteTurn, siteDescent,
  makeSegmentId, comparePriority, loadBuildings,
  attachPoint, blueprintVoxels, placeVoxelsAt,
  projectStaircase, placePiece, generateStaircase, staircaseSideAttaches, stairLamps,
};
