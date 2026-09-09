// perception node: torch_integrity
// purpose: The base-lighting counterpart to building_integrity / mining_integrity / farming_integrity —
//          ONE node that reads how well-lit the headframe base is and hands job_board a single verdict
//          it gates a `light_base` job on. The auto-torch reflex lights the ground bots WALK; it cannot
//          guarantee the headframe safe zone is dark-free, because bots roam and corners go unstepped
//          (combat refurbish §1b). This node closes that gap: a deliberate sweep of the guarded square
//          that finds the surface cells still dark enough to spawn a hostile.
//
// DETECTION (Architect, 2026-07-08): sample REAL block light, don't model torch geometry. The light
//   probe proved live reads work, and reading light is the same one pathway the reflex uses (Law 16) —
//   no coverage model to drift from the world. A surface cell is "dark" when its block light is at/under
//   TORCH_LIGHT_FLOOR (the shared lighting trigger).
// SCOPE (Architect): one sample per (x,z) COLUMN at its top standable surface — where hostiles actually
//   spawn outdoors — across a SQUARE of half-extent HEADFRAME_SAFE_RADIUS around the headframe
//   build_center. Not a 3D volume (roofed interiors are a separate concern); the vertical search is
//   bounded to base_y ± SURFACE_WINDOW so a near-level base stays cheap. Water surfaces are skipped
//   (isWalkableSurface rejects them — Architect A2: don't torch across a river).
//
// Pure observation (Law 1 perception exception — action fragments may call this directly). Guards on a
// locked headframe center before scanning, so it never throws pre-home: a light_base job dispatched
// before set_buildspot is job_board's gate to prevent, not this node's to crash on.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const { isWalkableSurface, getClearance } = require('@utils/movement/terrain_predicates');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { getBotInventory } = require('@utils/fragment_utils');
const buildingIntegrity = require('@perception/building_integrity');
const miningIntegrity = require('@perception/mining_integrity');
const { HEADFRAME_SAFE_RADIUS, TORCH_LIGHT_FLOOR } = require('@thinking/architect_config');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'torch_integrity';
const R = HEADFRAME_SAFE_RADIUS;   // square half-extent (Architect: "32 block square")
// Every blueprint that owns world voxels the torch grid overlaps. A torch may never occupy a cell
// any of these claim (interior air included) — a blueprint ALWAYS overrides torch placement, so
// lighting yields (Architect 2026-07-10). The headframe comes from getFootprintCells (building_integrity);
// the shaft from mining_integrity. The union is rebuilt every scan, so a newly-placed building is honored
// the next pass with no torch-side bookkeeping (Invariant B: re-sense, never remember).
//   NOTE (2026-07-18): the phase-1 wheat field (wheat_plot_pair instances, sited by the wheat_plot_scanner)
//   is NOT yet folded into this union — the retired farmland blueprint was the only farm reference here and
//   it is gone. Wheat plots are therefore torch-unprotected for now; closing that is part of the deferred
//   farming_integrity work (dynamic-water capture + plot protection), not this cleanup.
const SURFACE_WINDOW = 12;         // vertical search bound around base_y — keeps a level base cheap
const MAX_REPORT = 64;             // cap the returned dark-cell list; overflow is LOGGED, never silent
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);   // a TRUE-air spawn cell — not water/lava (both boundingBox 'empty')

// isOpenAir: the cell a mob/torch would occupy must be genuine air, not a liquid. Water and lava both
// report boundingBox 'empty', so a boundingBox test alone would light a submerged floor (Architect A2:
// never torch across/into water). Name-gate to real air.
function isOpenAir(block) {
  return !!block && block.boundingBox === 'empty' && AIR_NAMES.has(block.name);
}

let _lastScan = null;
let _lastLoggedKey = null;

function headframeCenter() {
  const site = hq.readBuildingChair('headframe', 'set_buildspot');
  return (site && site.build_center) || null;
}

// The union of every live blueprint footprint (headframe, shaft) as world "x,y,z" keys. A
// candidate torch cell in this set is inside a blueprint and must be dropped — lighting yields.
// Each accessor returns null before its blueprint is placed, and neither throws for that state — an
// unplaced blueprint is normal, not a fault (Law 13). The two guards that used to stand here were
// therefore unreachable on the case they named, and reachable only on a real defect in either node.
function blueprintFootprintUnion() {
  const union = new Set();
  const merge = (s) => { if (s) for (const k of s) union.add(k); };
  merge(buildingIntegrity.getFootprintCells('headframe'));
  merge(miningIntegrity.getFootprintCells());
  return union;
}

// topDarkCell: at column (x,z), find the top opaque standable surface within base_y ± SURFACE_WINDOW; if
// the air cell above it is clear and its block light ≤ floor, return that spawn cell — else null.
function topDarkCell(bot, x, z, baseY) {
  for (let y = baseY + SURFACE_WINDOW; y >= baseY - SURFACE_WINDOW; y--) {
    const floor = bot.blockAt(new Vec3(x, y, z));
    if (!floor || floor.boundingBox !== 'block' || !isWalkableSurface(floor)) continue; // not a spawn surface (incl. water/hazard)
    // First solid from the top = the surface. The cell above must be true air (not a liquid covering the
    // floor — A2) with body clearance (the mob/torch occupies it).
    const stand = new Vec3(x, y + 1, z);
    if (!isOpenAir(bot.blockAt(stand))) return null;
    if (!getClearance(bot, floor, 2)) return null;
    // Refusal returns null = "not a dark cell", the same direction an unreadable column already answers.
    // It never fabricates darkness, so the executor is never sent to light a cell nobody measured; the
    // square is re-swept every pass, so a column that loads later is counted then (Invariant B).
    const light = guardExternalSync(TAG, `getBlockLight at (${stand.x},${stand.y},${stand.z})`, () => bot.world.getBlockLight(stand));
    if (!light.ok || typeof light.value !== 'number') return null;
    return light.value <= TORCH_LIGHT_FLOOR ? stand : null;
  }
  return null;
}

// scan(bot) → the lighting verdict. Fields job_board reads:
//   located          headframe build_center exists (no base ⇒ nothing to guard)
//   dark_count       number of dark surface cells in the square
//   dark_cells       up to MAX_REPORT of them, nearest-to-center first (inspectability + a start point)
//   torches_have     torches in the bot's pocket
//   materials_ready  at least one torch on hand (else the job can't act)
//   truncated        dark_count exceeded MAX_REPORT (the list is a prefix, not the whole set)
function scan(bot) {
  if (!bot || !bot.blockAt) {
    throw new Error('[torch_integrity] CODING VIOLATION: bot must be initialized before scan(). Check caller.');
  }
  const center = headframeCenter();
  const located = !!(center && typeof center.x === 'number');
  const torchesHave = countInInventory('torch', getBotInventory() || {});

  if (!located) {
    _lastScan = { schema: 'auren.torch_integrity.v1', located: false, dark_count: 0, dark_cells: [], torches_have: torchesHave, materials_ready: false, truncated: false };
    _logTransition('nohome', 0, torchesHave);
    return _lastScan;
  }

  const baseY = Math.floor(center.y);
  const blocked = blueprintFootprintUnion();            // cells no torch may occupy — blueprints win
  const found = [];
  let excludedByBlueprint = 0;
  const scanStart = Date.now();                         // (R×R columns × up to 25 Y) — report the sweep cost
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const cell = topDarkCell(bot, center.x + dx, center.z + dz, baseY);
      if (!cell) continue;
      if (blocked.has(`${cell.x},${cell.y},${cell.z}`)) { excludedByBlueprint++; continue; }  // inside a blueprint — yield
      found.push({ x: cell.x, y: cell.y, z: cell.z, d2: dx * dx + dz * dz });
    }
  }
  found.sort((a, b) => a.d2 - b.d2);                    // nearest the center first — light inward-out
  const darkCount = found.length;
  const truncated = darkCount > MAX_REPORT;
  const darkCells = found.slice(0, MAX_REPORT).map(({ x, y, z }) => ({ x, y, z }));

  const verdict = {
    schema: 'auren.torch_integrity.v1',
    generated_at: new Date().toISOString(),
    located: true,
    center: { x: center.x, y: baseY, z: center.z },
    radius: R,
    dark_count: darkCount,
    dark_cells: darkCells,
    truncated,
    excluded_by_blueprint: excludedByBlueprint,   // dark cells suppressed because a blueprint owns them
    torches_have: torchesHave,
    materials_needed: darkCount > 0 ? { torch: darkCount } : {},
    materials_ready: torchesHave >= 1,
  };
  _lastScan = verdict;
  if (excludedByBlueprint > 0) {
    watcher.summary(TAG, `${excludedByBlueprint} dark cell(s) suppressed — inside a blueprint footprint (headframe/farm/shaft); lighting yields to the blueprint.`);
  }

  // Inspectability (Law 6): post the verdict beside the headframe's build chairs.
  hq.writeBuildingChair('headframe', TAG, {
    dark_count: darkCount, truncated, torches_have: torchesHave,
    materials_ready: verdict.materials_ready, generated_at: verdict.generated_at, writer: TAG,
  });

  _logTransition(darkCount === 0 ? 'lit' : (verdict.materials_ready ? 'ready' : 'gated'), darkCount, torchesHave, truncated, Date.now() - scanStart);
  return verdict;
}

// De-duped summary — base lighting changes slowly, so log only on state transition (Law 5).
// scanMs (the R×R×Y sweep cost) rides on the message, NOT the dedup key: it must not re-fire the
// line on millisecond jitter, but when a transition does log it says how long the sweep took.
function _logTransition(state, darkCount, torchesHave, truncated, scanMs = null) {
  const key = `${state}|${darkCount}|${torchesHave >= 1 ? 'stock' : 'notorch'}`;
  if (key === _lastLoggedKey) return;
  _lastLoggedKey = key;
  const t = scanMs != null ? ` (scan ${scanMs}ms)` : '';
  if (state === 'nohome') watcher.summary(TAG, 'no headframe center yet — base lighting idle until a home is locked.');
  else if (state === 'lit') watcher.summary(TAG, `base fully lit — no dark surface cells in the ${2 * R}-block square.${t}`);
  else if (state === 'ready') watcher.summary(TAG, `${darkCount} dark cell(s)${truncated ? ` (capped at ${MAX_REPORT})` : ''} — ${torchesHave} torch(es) on hand, clear to light.${t}`);
  else watcher.summary(TAG, `${darkCount} dark cell(s) but no torches on hand — GATED until a torch is stocked.${t}`);
}

function getState() { return _lastScan; }

module.exports = { scan, getState };
