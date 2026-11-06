// perception node: farming_integrity — reads the whole farm situation and hands back the verdict
// job_board dispatches on (Law 16). Composes STRUCTURE (blueprint_survey.survey), FIELD
// (farmland_site.getFarmState) and MATERIALS (pocket + registered chests) into a PHASE and readiness.
// Pure observation (Law 1). Guards on `located` so it never throws pre-lock.

'use strict';

const blueprintRegistry = require('@kernel/blueprint_registry');
const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const blueprintSurvey = require('@perception/blueprint_survey');
const { getFarmState } = require('@perception/farmland_site');
const { blueprintToRawMaterials } = require('@utils/calculators/build_material_calculator');
const { hasHomeChest, readTransposeOrigin, getBotInventory } = require('@utils/fragment_utils');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const inventoryLens = require('@kernel/inventory_lens');

const TAG = 'farming_integrity';

// ── CONFIG: the wheat-farm instances this subsystem owns ───────────────────────────────────────
// ONE plot DESIGN, N sited instances keyed by room keys (architect_config.FARM_FIELD, Invariant D). scan(bot, roomKey) returns
// one instance's verdict; scanCluster loops the field's keys (Law 16).
const { FARM_FIELD, DYE_STOCK } = require('@thinking/architect_config');
// The field row: { structure, keys, design }.
function farmField() { return FARM_FIELD; }
const { Vec3 } = require('vec3');
// Each field's stranded verdict as this body last read it with the stand in sight (room key → stranded).
const _strandedSeen = new Map();

// Smallest dirt order worth a trip — a FLOOR, never a cap: a gap larger than this is ordered in full.
const FARM_DIRT_MIN_GATHER = 15;
if (!Number.isInteger(FARM_DIRT_MIN_GATHER) || FARM_DIRT_MIN_GATHER < 1) {
    throw new Error(`CODING VIOLATION (Law 13): FARM_DIRT_MIN_GATHER must be a positive whole number of blocks, got ${FARM_DIRT_MIN_GATHER}.`);
}

let _lastScan = null;
let _caneStanding = null;   // caneStanding
let _caneOpen = null;       // caneOpen
let _fieldDirt = null;      // fieldDirt
let _firstFieldSown = false; // firstFieldSown

// Dirt for a row is funded from the bot's own pocket, not the fleet pool — funded at the cluster level,
// after seeds; what a seed-funded row is still short of becomes the farm's dirt order (assessors/farming).
const POCKET_SOIL = 'dirt';
// The blueprint token for a water cell, poured from a water bucket (farm_executor, land_prep).
const WATER = 'water';

// ── Blueprint-derived needs (each field is one fixed design → computed once per design) ──
//   SEED_NEED = seeds for a full planting. HOE_LOGS = logs a wooden_hoe costs, when none is on hand.
//   DIRT_PER_ROW = 'dirt' voxels one instance places. STRUCT_PER_ROW = its structural voxel count.
// getBuilding throws on a missing/malformed blueprint, never pricing the farm at zero (Law 13).
const _designCounts = new Map();
function designCounts(design) {
  if (!_designCounts.has(design)) _designCounts.set(design, _countDesign(design));
  return _designCounts.get(design);
}
function _countDesign(design) {
  const b = blueprintRegistry.getBuilding(design, TAG);
  const voxels = blueprintSurvey.collectAllVoxels(b);
  const external = new Set(b.external_voxel_types || []);
  const seeds  = voxels.filter(v => v.raw && v.raw[3] === 'growing').length;
  const dirt   = voxels.filter(v => v.raw && v.raw[3] === POCKET_SOIL).length;
  const struct = voxels.filter(v => v.raw && v.raw[3] !== 'air' && !external.has(v.raw[3])).length;
  // Thrown, not defaulted, for the same reason as the blueprint check above (Law 13).
  const hoeLogs = blueprintToRawMaterials({ wooden_hoe: 1 }).logs;
  if (typeof hoeLogs !== 'number' || hoeLogs <= 0) {
    throw new Error(`[${TAG}] CODING VIOLATION: the recipe walk for wooden_hoe yielded no logs `
      + `(got ${JSON.stringify(hoeLogs)}). A hoe is made of logs, so this is a malformed recipe book — `
      + 'fix the recipe rather than assuming a cost here.');
  }
  return { SEED_NEED: seeds, HOE_LOGS: hoeLogs, DIRT_PER_ROW: dirt, STRUCT_PER_ROW: struct };
}

// Every remaining structural place step, priced to raw materials, off the live survey diff (Law 16,
// Law 25). 'growing' is excluded — that is the seed axis, counted separately as the crop's seed — and so is
// 'water', poured from a bucket the field keeps rather than spends (WATER in scan).
function _structureMaterialsRemaining(structure) {
  const byType = {};
  const steps = Array.isArray(structure?.steps) ? structure.steps : [];
  for (const s of steps) {
    if (!s || s.action !== 'place' || !s.type || s.type === 'growing' || s.type === WATER) continue;
    byType[s.type] = (byType[s.type] || 0) + 1;
  }
  return blueprintToRawMaterials(byType);
}

// Every material question here is FLEET-WIDE (pocket + chests) — funds a TRIP, not a craft (Law 16).

// scan(bot, roomKey) → one farm instance's verdict. roomKey is the instance's conference-room key
// (defaults to instance 0). Fields job_board reads:
//   home                supply source exists
//   located             set_buildspot locked a center
//   structure_complete  structure matches (repair-aware; false until located)
//   field               getFarmState census (null until located)
//   phase               'locate' | 'build' | 'plant' | 'harvest' | 'idle'
//   materials_needed    { logs, <crop seed> } the CURRENT phase requires (blueprint-derived)
//   materials_missing   shortfall of the above after crediting the accessible pool
//   materials_ready     nothing missing → job_board may dispatch this phase
//   structure_steps     blueprint_survey structural steps (damage handling / inspectability)
async function scan(bot, roomKey, opts = {}) {
  if (!bot || !bot.blockAt) {
    throw new Error('[farming_integrity] CODING VIOLATION: bot must be initialized before scan(). Check caller.');
  }
  const field_ = farmField();
  roomKey = roomKey || field_.keys[0];
  // Each room key is its own field (the wheat field, the cane field): its counts and its crop come from the
  // geometry its chair locked, never from the row's wheat design.
  const geometry = readTransposeOrigin(roomKey) ? blueprintSurvey.geometryOf(roomKey) : field_.design;
  const { SEED_NEED, HOE_LOGS, STRUCT_PER_ROW } = designCounts(geometry);
  const crop = require('@perception/farmland_site').cropOf(geometry);

  const home = hasHomeChest();

  const center = readTransposeOrigin(roomKey);
  const located = !!center;

  // A farm row's stand is re-validated every scan (Invariant B) since dynamic water can flood it after
  // siting. No standable stand or dry lip within reach → STRANDED, non-actionable. Lazy require:
  // anchored_repair pulls in locomotion, and this node is required early by the job board.
  // THE KEEPER JUDGES THE STAND for a body with a foreman (the `fields` verdict, read off its one world). A body
  // without one judges it itself, and one whose chunks do not reach the stand does not judge it: an unloaded cell
  // reads as no floor, and every far body would call the field stranded. It keeps the verdict it last read with the
  // stand in sight, and one that never saw it reads the field as not stranded, so the body sent there judges it on arrival.
  let stranded = false;
  const kept = located ? require('@kernel/keeper_verdicts').keptEntry('fields', roomKey) : null;
  if (kept) {
    stranded = kept.stranded === true;
  } else if (located) {
    const ring = [-2, 0, 2].flatMap(dx => [-2, 0, 2].map(dz => bot.blockAt(new Vec3(center.x + dx, center.y, center.z + dz))));
    if (ring.every(Boolean)) {
      // farm_executor.tendPlot's rule: stranded when no anchor of the field has a stand off its own cells.
      const geometry = blueprintSurvey.geometryOf(roomKey);
      const fallback = blueprintRegistry.getBuilding(geometry, TAG).stand_fallback !== false;
      const footprint = blueprintSurvey.getFootprintCells(geometry, roomKey) || new Set();
      const { resolveStandableAnchor } = require('@api/anchored_repair');
      stranded = blueprintSurvey.getWorldAnchors(geometry, roomKey).every(a => resolveStandableAnchor(bot, a, { fallback, footprint }) === null);
      _strandedSeen.set(roomKey, stranded);
    } else {
      stranded = _strandedSeen.get(roomKey) === true;
    }
  }

  let structure = null, field = null;
  let structureComplete = false, structureSteps = [];
  if (located) {
    // Wraps the neutral survey directly (never building_integrity) since farming does its own material
    // gating below. Geometry is read from this instance's chair, never assumed from config (Law 25).
    structure = await blueprintSurvey.survey(bot, blueprintSurvey.geometryOf(roomKey), roomKey);
    structureComplete = structure.all_complete === true;
    structureSteps = Array.isArray(structure.steps) ? structure.steps : [];
    field = getFarmState(bot, roomKey);
  }

  // ── WATER OUT OF REACH ── A field whose only unbuilt cells are its water, with no water bucket in the crew's reach
  // and either no bucket to fill or the water search spent (sector_finder: no book sector records water and every
  // frontier sector inside the backstop is scanned), has
  // nothing to build: a visit would find the pour waiting and work nothing. Its crops are tended as a built field's
  // are, dry, and the water waits.
  const waterOnly = located && !structureComplete && structureSteps.length > 0
    && structureSteps.every(s => s.action === 'place' && s.type === WATER);
  const waterUnreachable = waterOnly && waterOutOfReach();

  // ── Phase + the material needs that phase carries ──
  // `structureRaw` prices off the live survey. `locate` prices no structure (no center, no diff yet) —
  // it gates on the two survey-invisible axes only (seeds, hoe).
  let phase, seedsNeeded = 0, structureRaw = {};
  if (!located) {
    phase = 'locate';   seedsNeeded = SEED_NEED;
  } else if (stranded) {
    phase = 'stranded'; // stand block lost to water and no dry anchor reaches it — non-actionable, no demand
  } else if (crop.tilled && field && field.growing > 0 && !field.harvestReady && inventoryLens.inChests('bone_meal') - DYE_STOCK.bone_meal > 0) {
    // ONE PLANT IN THE GROUND IS ENOUGH: the first wheat is what the crew waits on, so banked bone meal goes on a growing
    // crop ahead of the row's building and sowing, and the visit does those too (farm_executor.tendPlot). The chests' bone
    // meal past the white dye's keep (DYE_STOCK): the same figure land_prep pulls the visit's bone meal against (Law 16).
    // Counted fleet-wide, a visit was posted on the keep or a peer's pocket, came empty-handed and treated nothing, again
    // and again until recursive_judge killed it.
    phase = 'bonemeal';
  } else if (!structureComplete && !waterUnreachable) {
    // Seeds for the crop cells still unsown, not the whole field: a field planted on its first visit and left a
    // cell or two short of built asks only for those.
    phase = 'build';    seedsNeeded = field ? field.untilled + field.emptyTilled : SEED_NEED;
    structureRaw = _structureMaterialsRemaining(structure);
  } else if (field.needsPrep) {
    // Prep before harvest — both can be true at once (harvest-any harvests ripe crops for free).
    phase = 'plant';    seedsNeeded = field.untilled + field.emptyTilled;
  } else if (field.harvestReady) {
    phase = 'harvest';  // consumes nothing — never gated
  } else {
    phase = 'idle';     // mid-growth with nothing to spend on it — nothing actionable this sweep
  }

  // ── WATER ── A field's water is poured from a bucket: a pending water step needs a water bucket, or an
  // empty bucket to fill, somewhere in the fleet's reach. The bucket is the crew's own (its chest row), so
  // it gates the build rather than being priced into it.
  const waterSteps = structureSteps.filter(s => s.action === 'place' && s.type === WATER).length;
  const bucketNeeded = waterSteps > 0 && inventoryLens.reachableByFleet('water_bucket') === 0;

  // A hoe is needed to till — fold in its wood when the pool holds no hoe of any tier.
  const hoeAvailable = inventoryLens.reachableByFleet('hoe') > 0;
  const needsHoe = crop.tilled && (phase === 'locate' || phase === 'build' || phase === 'plant');
  const hoeLogs = (needsHoe && !hoeAvailable) ? HOE_LOGS : 0;

  // Hoe wood and seeds are ADDED onto the structural diff, not assigned — both can price to logs (Law 25).
  const materialsNeeded = { ...structureRaw };
  if (hoeLogs > 0)     materialsNeeded.logs = (materialsNeeded.logs || 0) + hoeLogs;
  if (seedsNeeded > 0) materialsNeeded[crop.seed] = (materialsNeeded[crop.seed] || 0) + seedsNeeded;
  if (bucketNeeded)    materialsNeeded.bucket = (materialsNeeded.bucket || 0) + 1;

  // A FIELD IS BUILT AS SOON AS ITS BUCKET IS IN REACH, NOT WHEN ITS SEEDS ARE: digging, tilling and the pour need no
  // seed, and a build or planting visit plants what seeds there are (land_prep pulls what the chests hold). The seed
  // order still stands; a planting visit is posted only with a seed in reach (scanCluster).
  const materialsMissing = {};
  for (const [tok, cnt] of Object.entries(materialsNeeded)) {
    if (tok === POCKET_SOIL) continue;                   // the pocket's to fund, at the cluster (THE DIRT BUDGET)
    if (tok === crop.seed && (phase === 'build' || phase === 'plant')) continue;
    const have = inventoryLens.reachableByFleet(tok);   // group-aware (logs variants, etc.)
    if (cnt - have > 0) materialsMissing[tok] = cnt - have;
  }
  const materialsReady = Object.keys(materialsMissing).length === 0;

  const verdict = {
    schema: 'auren.farming_integrity.v1',
    generated_at: new Date().toISOString(),
    home,
    located,
    structure_complete: structureComplete,
    structure_steps: structureSteps,
    // Placed = structural voxels less pending place steps. Null until sited (Law 25).
    structure_placed: located ? Math.max(0, STRUCT_PER_ROW - structureSteps.filter(s => s.action === 'place').length) : null,
    structure_digs_left: located ? structureSteps.filter(s => s.action === 'dig').length : null,
    water_steps: waterSteps,
    water_unreachable: waterUnreachable,
    geometry,
    seed: crop.seed,
    field,
    phase,
    stranded,
    needs_prep:    field ? field.needsPrep : false,
    harvest_ready: field ? field.harvestReady : false,
    actionable:    stranded ? false : (field ? field.actionable : false),
    hoe_available: hoeAvailable,
    materials_needed:  materialsNeeded,
    materials_missing: materialsMissing,
    materials_ready:   materialsReady,
  };
  _lastScan = verdict;

  // Post the verdict for inspectability (Law 6), keyed by roomKey so two farms never clobber one verdict.
  hq.writeBuildingChair(roomKey, TAG, {
    phase, materials_needed: materialsNeeded, materials_missing: materialsMissing,
    materials_ready: materialsReady, structure_complete: structureComplete,
    generated_at: verdict.generated_at, writer: TAG,
  });

  // scanCluster calls this per-instance across the whole field; quiet mode skips the human-facing summary
  // line (32 of them would be noise, Law 5) but keeps the chair write above (Law 6).
  if (opts.quiet) return verdict;

  // Posted every scan, not de-duped (Law 5) — headline is the phase verdict, detail is the diagnostic datum.
  const missStr = Object.entries(materialsMissing).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
  let headline;
  if (!home) {
    headline = 'no headframe chest yet — farming idle until home base exists.';
  } else if (phase === 'stranded') {
    headline = `plot STRANDED at (${center.x},${center.y},${center.z}) — locked stand not standable and no dry anchor within reach (dynamic water?); non-actionable until the water clears or it re-sites.`;
  } else if (phase === 'idle') {
    headline = field ? `field mid-growth (${field.growing}/${field.total} growing) — nothing to do.` : 'idle — sited pending first scan.';
  } else if (materialsReady) {
    headline = `phase ${phase}: materials ready — clear to dispatch.`;
  } else {
    headline = `phase ${phase}: GATED, short ${missStr} — waiting on supply.`;
  }
  watcher.summary(TAG, headline);
  if (located) {
    const structStr = structureComplete ? 'complete' : `${structureSteps.length} repair step(s)`;
    const fieldStr = field ? `field ${field.growing}/${field.total} growing, prep=${field.needsPrep}, harvest=${field.harvestReady}` : 'field —';
    watcher.summary(TAG, `  struct=${structStr} | ${fieldStr} | hoe=${hoeAvailable} | materials ${materialsReady ? 'ready' : `short ${missStr}`}`);
    // Names each structural repair cell (coord + expected + actual) — data blueprint_survey already
    // computed, no new logging invented (Law 5/14).
    if (!structureComplete && structureSteps.length) {
      const detail = structureSteps.slice(0, 6).map(s => {
        const at = `(${s.place.x},${s.place.y},${s.place.z})`;
        return s.action === 'place' ? `place ${s.type}@${at}[found ${s.actual || 'air'}]` : `dig ${s.type}@${at}[want air]`;
      }).join(' ');
      const more = structureSteps.length > 6 ? ` …+${structureSteps.length - 6}` : '';
      watcher.summary(TAG, `  repair: ${detail}${more}`);
    }
  }

  return verdict;
}

// scanCluster(bot) → the whole wheat field as one serviceable cluster, aggregating the separate sited
// instances into one visit. anchor = the first located plot's center; plots[] = each instance's phase
// + actionability. Reuses scan(bot, roomKey, {quiet}) — no second census (Law 16).
// materials_ready is GENEROUS: true when ANY actionable plot is ready, so a seed shortage does not
// stall the cluster. Phase BUILD is the exception, gated by the shared seed pool (THE SEED BUDGET below).
async function scanCluster(bot) {
  if (!bot || !bot.blockAt) {
    throw new Error('[farming_integrity] CODING VIOLATION: bot must be initialized before scanCluster().');
  }
  const field_ = farmField();
  const plots = [];
  let anchor = null, anyLocated = false;
  const missingAgg = {};
  const buildQueue = [];              // build plots that passed their OWN check — funded against the pool below
  for (const roomKey of field_.keys) {
    const center = readTransposeOrigin(roomKey);
    if (!center) continue;              // an unfilled instance (the field fell short of the target) — never located, idle
    anyLocated = true;
    if (!anchor) anchor = center;       // cluster anchor = the first located plot (instance 0's stand)
    // Unguarded deliberately: scan() is our code and every mineflayer call beneath it is guarded at its
    // own boundary, so anything that escapes here is a defect that must travel (Law 13, Law 25).
    const v = await scan(bot, roomKey, { quiet: true });
    // A build plot is funded below. Harvest and bonemeal spend nothing the visit cannot see; a plant plot is worth a
    // visit only with a seed in reach, or the visit tills nothing and plants nothing.
    const actionable = (v.phase === 'plant' && inventoryLens.reachableByFleet(v.seed) > 0)
      || v.phase === 'harvest' || v.phase === 'bonemeal';
    for (const [k, n] of Object.entries(v.materials_missing || {})) missingAgg[k] = (missingAgg[k] || 0) + n;
    const plot = {
      roomKey, center, phase: v.phase, actionable, materials_ready: v.materials_ready,
      // Each field sows its own crop's seed (wheat seeds, sugar cane): every seed figure below is kept per seed item.
      geometry: v.geometry, seed: v.seed, seed_need: designCounts(v.geometry).SEED_NEED, dirt_per_row: designCounts(v.geometry).DIRT_PER_ROW,
      seeds_needed: (v.materials_needed && v.materials_needed[v.seed]) || 0,
      dirt_needed: (v.materials_needed && v.materials_needed[POCKET_SOIL]) || 0,
      structure_placed: v.structure_placed, structure_digs_left: v.structure_digs_left, field: v.field,
      water_steps: v.water_steps,
    };
    // Funded below, not here — a build plot's own verdict cannot see its 31 siblings (see THE SEED BUDGET).
    if (v.phase === 'build' && v.materials_ready === true) buildQueue.push(plot);
    plots.push(plot);
  }

  // ── THE SEED BUDGET: ONE POOL, COUNTED ONCE ────────────────────────────────────────────────────
  // Spent once here, in room-key order (deterministic, Law 19): planting first, then remaining
  // seeds fund build plots one at a time; the rest stay non-actionable to re-post next cycle.
  const seedItems = [...new Set(plots.map(p => p.seed).filter(Boolean))];   // the water pool sows nothing
  const perSeed = (fn) => Object.fromEntries(seedItems.map(seed => [seed, fn(seed)]));
  const plantDemand = perSeed(seed => plots.reduce((n, p) => n + (p.seed === seed && p.phase === 'plant' ? p.seeds_needed : 0), 0));
  const seedsReachable = perSeed(seed => inventoryLens.reachableByFleet(seed));
  const seedBudget = perSeed(seed => seedsReachable[seed] - plantDemand[seed]);
  let unfundedBuilds = 0;
  // ── THE DIRT BUDGET: the pocket, after the seeds ── A seed-funded row is laid only if the pocket also
  // holds its dirt; rows go in key order, so a short pocket holds back the outer rows. `dirtGap` sizes
  // the order over every row the seeds CAN plant, so one trip covers the whole chain.
  const pocketDirt = countInInventory(POCKET_SOIL, getBotInventory());
  let dirtBudget = pocketDirt;
  let dirtShortBuilds = 0;
  const seedsForBuilding = { ...seedBudget };

  // ── ONE ROW AT A TIME, AND IT IS ALWAYS THE LOWEST UNLAID ONE ──────────────
  // A field whose rows are laid from the row behind reaches each row only through the chain.
  // The manager re-senses every iteration: lay the lowest row, the next scan hands back the one after it.
  // The chain is each farmer's own (tendCrop): the cane farmer lays the lowest unlaid cane field while the wheat farmer
  // lays the lowest unlaid wheat field, so neither crop waits on the other's fields.
  const unlaid = p => p.phase === 'build' || p.phase === 'stranded';
  const lowestUnlaid = plots.find(unlaid) || null;
  const lowestOfCrop = new Set([...new Set(plots.map(tendCrop))].map(c => plots.find(p => unlaid(p) && tendCrop(p) === c)).filter(Boolean));
  const buildable = buildQueue.filter(p => lowestOfCrop.has(p));
  const chainHeld = buildQueue.length - buildable.length;
  for (const p of buildable) {
    // seeds_needed === 0 funds unconditionally: a blueprint with no 'growing' voxel costs no seeds, and
    // a negative budget from plant demand must not veto a plot that spends nothing.
    // Seeds do not hold a build back: the plot is laid and planted with what the pool holds.
    if (p.seeds_needed > seedBudget[p.seed]) unfundedBuilds++;
    seedBudget[p.seed] -= Math.min(Math.max(seedBudget[p.seed], 0), p.seeds_needed);
    if (p.dirt_needed <= dirtBudget) { p.actionable = true; dirtBudget -= p.dirt_needed; }
    else dirtShortBuilds++;
  }
  let dirtPlanned = 0;
  const seedsLeft = { ...seedsForBuilding };
  for (const p of plots) {
    if (p.phase !== 'build' && p.phase !== 'stranded') continue;
    // A row short of seeds is laid and planted with what there is (THE SEED BUDGET above), so the visit carries those.
    const seeds = p.phase === 'build' ? p.seeds_needed : p.seed_need;
    seedsLeft[p.seed] -= Math.min(seeds, Math.max(seedsLeft[p.seed], 0));
    dirtPlanned += p.phase === 'build' ? p.dirt_needed : p.dirt_per_row;
  }
  // Pocket dirt is spent first: `dirtPlanned - pocketDirt` is the remainder, floored at
  // FARM_DIRT_MIN_GATHER; a stocked chest can serve it via supply_manager without a gather.
  const dirtGap = dirtPlanned > pocketDirt ? Math.max(FARM_DIRT_MIN_GATHER, dirtPlanned - pocketDirt) : 0;
  _fieldDirt = dirtPlanned;

  // ── THE FARM'S SEED ORDER AND ITS "BUILT" VERDICT ── Order = every seed still unsown, less what the
  // fleet reaches. Built = sited with no row left to lay; job_board's built gate reads it.
  // ONE WHEAT FIELD ORDERS FROM THE GRASS: a wheat field copy (critical mass) is never in the order. It is sown from the
  // seeds the harvests bring back past their own replanting, so the grass is punched for one field's seeds only.
  // ONE CANE FIELD ORDERS FROM THE WILD, the same way: wild cane (assessors/farming WILD CANE) is gathered for the first
  // cane field only, and every copy is planted from the cane its harvests bring back (exponential growth).
  const unbuiltRows = plots.filter(p => p.phase === 'build' || p.phase === 'stranded');
  const orders = p => !field_.copies.includes(p.roomKey);
  const seedDemand = perSeed(seed => plots.reduce((n, p) => n + (orders(p) && p.seed === seed && p.phase === 'plant' ? p.seeds_needed : 0), 0)
    + unbuiltRows.filter(orders).reduce((n, p) => n + (p.seed !== seed ? 0 : p.phase === 'build' ? p.seeds_needed : p.seed_need), 0));
  const seedGap = perSeed(seed => Math.max(0, seedDemand[seed] - seedsReachable[seed]));
  const built = anyLocated && unbuiltRows.length === 0;
  // The cane standing in every cane field, block by block (farmland_site.censusAt): the fields' half of THE CANE HOLD.
  _caneStanding = plots.reduce((n, p) => n + (p.seed === 'sugar_cane' && p.field ? p.field.standing || 0 : 0), 0);
  // The cane slots not yet planted: every slot of a cane field still to build, and the unsown slots of a built one.
  _caneOpen = plots.reduce((n, p) => n + (p.seed !== 'sugar_cane' ? 0 : unbuiltRows.includes(p) || !p.field ? p.seed_need
    : (p.field.untilled || 0) + (p.field.emptyTilled || 0)), 0);
  // THE FIRST WHEAT FIELD SOWN, once: every row of the wheat field that orders from the grass laid, with no cell untilled
  // or tilled unsown. Held from then on, so a harvest's empty cells do not reopen the compost bootstrap.
  const firstWheat = plots.filter(p => p.seed === 'wheat_seeds' && orders(p));
  if (!_firstFieldSown && firstWheat.length && firstWheat.every(p => !unbuiltRows.includes(p) && p.field
      && (p.field.untilled || 0) + (p.field.emptyTilled || 0) === 0)) {
    _firstFieldSown = true;
    watcher.summary(TAG, `FIRST_FIELD_SOWN rows=${firstWheat.length}: the compost bootstrap ends; surplus seeds feed the composter from here.`);
  }

  const actionablePlots = plots.filter(p => p.actionable);
  const anyActionable = actionablePlots.length > 0;
  const materialsReady = actionablePlots.some(p => p.materials_ready);

  // One aggregated cluster line (Law 5) with a phase breakdown; per-plot summaries stay suppressed (quiet).
  const byPhase = plots.reduce((m, p) => (m[p.phase] = (m[p.phase] || 0) + 1, m), {});
  const phaseStr = Object.entries(byPhase).map(([k, n]) => `${k}:${n}`).join(' ') || 'none';
  // The seed budget is reported wherever it bit, distinguishable from a plot with nothing to do (Law 6).
  const seedStr = (unfundedBuilds ? ` — ${unfundedBuilds} build plot(s) short of seeds, laid with what there is` : '')
    // A row held by the CHAIN and a row held by SUPPLY look identical from outside; named separately (Law 6).
    + (chainHeld ? ` — ${chainHeld} row(s) ready but held behind ${lowestUnlaid ? _rowLabel(field_, lowestUnlaid.roomKey) : 'the unlaid row'} (laid lowest-first, each stood on the one before)` : '')
    + (dirtShortBuilds ? ` — ${dirtShortBuilds} seeded row(s) waiting on pocket dirt` : '')
    // Names which number produced the order — with a floor in play, shortfall and order size differ (Law 25).
    + (dirtGap ? ` — ${dirtGap} dirt ordered (${dirtPlanned} for the rows the seeds can plant, ${pocketDirt} held`
        + (dirtGap > dirtPlanned - pocketDirt ? `, short ${dirtPlanned - pocketDirt} but floored at the ${FARM_DIRT_MIN_GATHER}-block minimum trip` : '') + ')' : '')
    + seedItems.filter(seed => seedGap[seed]).map(seed => ` — ${seedGap[seed]} ${seed} ordered (${seedDemand[seed]} to sow, ${seedsReachable[seed]} reachable)`).join('')
    + (anyLocated ? (built ? ' — farm BUILT' : ` — farm not built (${unbuiltRows.length} row(s) to lay)`) : '');
  if (!anyLocated) {
    // A species with no field returned above, so a field that has no located plot is one still to be sited.
    watcher.summary(TAG, 'cluster: no plots located yet — base-layout lock pending.');
  } else if (!anyActionable) {
    watcher.summary(TAG, `cluster: ${plots.length} plots, none actionable (${phaseStr})${seedStr || ' — nothing to tend'}.`);
  } else {
    watcher.summary(TAG, `cluster: ${plots.length} plots, ${actionablePlots.length} actionable (${phaseStr}) — materials ${materialsReady ? 'ready' : 'GATED'}${seedStr}.`);
  }
  if (anyLocated) _emitCensus(field_, plots, unbuiltRows.length);

  return {
    schema: 'auren.farming_integrity_cluster.v1',
    generated_at: new Date().toISOString(),
    anchor, located: anyLocated,
    plot_count: plots.length,
    plots, actionable_plots: actionablePlots,
    any_actionable: anyActionable,
    materials_ready: materialsReady,
    materials_missing: missingAgg,
    unfunded_builds: unfundedBuilds,
    // Rows materially ready to lay that the chain holds back this sweep, and which row they wait on.
    chain_held: chainHeld,
    lowest_unlaid: lowestUnlaid ? lowestUnlaid.roomKey : null,
    dirt_gap: dirtGap,
    dirt_short_builds: dirtShortBuilds,
    seed_gap: seedGap,
    seeds_reachable: seedsReachable,
    built,
    // Seeds one visit can sow: every plant cell waiting, plus every row the seeds reach this visit.
    seeds_for_visit: perSeed(seed => Math.max(0, plantDemand[seed]) + (seedsForBuilding[seed] - seedsLeft[seed])),
    // Water cells still to pour across the actionable plots — land_prep fills a bucket for them.
    water_steps: actionablePlots.reduce((n, p) => n + (p.water_steps || 0), 0),
  };
}

// ── THE FARM CENSUS — the farm's building_integrity scan line ───────────────────────────────────────────────
// Answers how much of the farm stands, off the same per-row scan the cluster verdict already ran
// (Law 16), every sweep (Law 5), shaped for monitoring/farm_lens.js to parse:
//   farm census "wheat_field" — L/S row(s) laid of N (the fields the crew sites) · structure P/T placed, D to dig · crop cells C: G growing, M mature, E tilled unsown, U untilled, B blocked
//     rows: #0=harvest 3/3 g2 m0 | #1=build 1/3 | …
// A row counts as LAID when its phase is past build. `#k` is the row's index in the field's room keys.
function _rowLabel(field_, roomKey) {
  const i = field_.keys.indexOf(roomKey);
  return `#${i}`;
}
function _emitCensus(field_, plots, unbuiltCount) {
  // Each plot is counted against its own design (the wheat field, the cane field).
  const structOf = (p) => designCounts(p.geometry).STRUCT_PER_ROW;
  const sum = (f) => plots.reduce((n, p) => n + (f(p) || 0), 0);
  const placed = sum(p => p.structure_placed);
  const digs = sum(p => p.structure_digs_left);
  const cell = (k) => sum(p => p.field && p.field[k]);
  watcher.summary(TAG, `farm census "${field_.structure}" — ${plots.length - unbuiltCount}/${plots.length} row(s) laid of ${require('@utils/calculators/wheat_critical_mass').fieldKeysSited(require('@kernel/bot_mandate').currentMode()).length}`
    + ` · structure ${placed}/${sum(structOf)} placed, ${digs} to dig`
    + ` · crop cells ${cell('total')}: ${cell('growing')} growing, ${cell('mature')} mature, ${cell('emptyTilled')} tilled unsown, ${cell('untilled')} untilled, ${cell('blocked')} blocked`);
  watcher.summary(TAG, `  rows: ${plots.map(p => `${_rowLabel(field_, p.roomKey)}=${p.phase} ${p.structure_placed}/${structOf(p)}`
    + (p.field ? ` g${p.field.growing} m${p.field.mature}` : '')).join(' | ')}`);
}

function getState() { return _lastScan; }
// caneStanding() → the cane blocks the cane fields held at this body's last cluster scan; null before any.
function caneStanding() { return _caneStanding; }
// caneOpen() → the cane field slots not yet planted at this body's last cluster scan; null before any.
function caneOpen() { return _caneOpen; }
// fieldDirt() → the dirt every unlaid row of the fields still takes, at this body's last cluster scan; null before
// any. A clean-out leaves this much in the chests (waste_pit.chestLimit).
function fieldDirt() { return _fieldDirt; }
// firstFieldSown() → true once this body's cluster scan has seen the first wheat field wholly sown; false before.
function firstFieldSown() { return _firstFieldSown; }

// waterOutOfReach() → true when no water bucket is in the crew's reach and either no bucket can be filled or the water
// search is spent: a field's pour cannot happen, and its crops are tended dry (farm_executor reads the same rule).
function waterOutOfReach() {
  return inventoryLens.reachableByFleet('water_bucket') === 0
    && (inventoryLens.reachableByFleet('bucket') === 0 || require('@api/sector_finder').exhausted(['water']));
}

// tendCrop(plot) → the crop whose farmer tends this plot: its seed, and the wheat farmer's for the water pool, which grows
// nothing (assessors/farming ONE FARMER PER CROP, farm_manager).
function tendCrop(plot) { return plot.seed || 'wheat_seeds'; }

module.exports = { scan, scanCluster, getState, caneStanding, caneOpen, fieldDirt,firstFieldSown, farmField, waterOutOfReach, tendCrop, WATER };
