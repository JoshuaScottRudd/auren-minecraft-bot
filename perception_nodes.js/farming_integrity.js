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
// ONE plot DESIGN (FARM_BLUEPRINT), N sited instances keyed by FARM_ROOM_KEYS (architect_config,
// Invariant D). scan(bot, roomKey) returns one instance's verdict; job_board loops the keys (Law 16).
const { FARM_BLUEPRINT_NAME: FARM_BLUEPRINT, FARM_ROW_DESIGN, FARM_ROOM_KEYS } = require('@thinking/architect_config');

// Smallest dirt order worth a trip — a FLOOR, never a cap: a gap larger than this is ordered in full.
const FARM_DIRT_MIN_GATHER = 15;
if (!Number.isInteger(FARM_DIRT_MIN_GATHER) || FARM_DIRT_MIN_GATHER < 1) {
    throw new Error(`CODING VIOLATION (Law 13): FARM_DIRT_MIN_GATHER must be a positive whole number of blocks, got ${FARM_DIRT_MIN_GATHER}.`);
}

let _lastScan = null;

// Dirt for a row is funded from the bot's own pocket, not the fleet pool — funded at the cluster level,
// after seeds; what a seed-funded row is still short of becomes the farm's dirt order (assessors/farming).
const POCKET_SOIL = 'dirt';

// ── Blueprint-derived needs (the farm is one fixed design → compute once at load) ──
//   SEED_NEED = seeds for a full planting. HOE_LOGS = logs a wooden_hoe costs, when none is on hand.
//   DIRT_PER_ROW = 'dirt' voxels one instance places. STRUCT_PER_ROW = its structural voxel count.
// getBuilding throws on a missing/malformed blueprint, never pricing the farm at zero (Law 13).
const { SEED_NEED, HOE_LOGS, DIRT_PER_ROW, STRUCT_PER_ROW } = (() => {
  // FARM_ROW_DESIGN, not FARM_BLUEPRINT — the latter is the room-key prefix and resolves to no blueprint.
  // Any one of the four direction rows gives these counts; all four carry the same blocks.
  const b = blueprintRegistry.getBuilding(FARM_ROW_DESIGN, TAG);
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
})();

// Every remaining structural place step, priced to raw materials, off the live survey diff (Law 16,
// Law 25). 'growing' is excluded — that is the seed axis, counted separately as wheat_seeds.
function _structureMaterialsRemaining(structure) {
  const byType = {};
  const steps = Array.isArray(structure?.steps) ? structure.steps : [];
  for (const s of steps) {
    if (!s || s.action !== 'place' || !s.type || s.type === 'growing') continue;
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
//   materials_needed    { logs, wheat_seeds } the CURRENT phase requires (blueprint-derived)
//   materials_missing   shortfall of the above after crediting the accessible pool
//   materials_ready     nothing missing → job_board may dispatch this phase
//   structure_steps     blueprint_survey structural steps (damage handling / inspectability)
async function scan(bot, roomKey = FARM_ROOM_KEYS[0], opts = {}) {
  if (!bot || !bot.blockAt) {
    throw new Error('[farming_integrity] CODING VIOLATION: bot must be initialized before scan(). Check caller.');
  }

  const home = hasHomeChest();

  const center = readTransposeOrigin(roomKey);
  const located = !!center;

  // A farm row's stand is re-validated every scan (Invariant B) since dynamic water can flood it after
  // siting. No standable stand or dry lip within reach → STRANDED, non-actionable. Lazy require:
  // anchored_repair pulls in locomotion, and this node is required early by the job board.
  let stranded = false;
  if (located) {
    const fallback = blueprintRegistry.getBuilding(blueprintSurvey.geometryOf(roomKey), TAG).stand_fallback !== false;
    stranded = require('@api/anchored_repair').resolveStandableAnchor(bot, center, { fallback }) === null;
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

  // ── Phase + the material needs that phase carries ──
  // `structureRaw` prices off the live survey. `locate` prices no structure (no center, no diff yet) —
  // it gates on the two survey-invisible axes only (seeds, hoe).
  let phase, seedsNeeded = 0, structureRaw = {};
  if (!located) {
    phase = 'locate';   seedsNeeded = SEED_NEED;
  } else if (stranded) {
    phase = 'stranded'; // stand block lost to water and no dry anchor reaches it — non-actionable, no demand
  } else if (!structureComplete) {
    phase = 'build';    seedsNeeded = SEED_NEED; structureRaw = _structureMaterialsRemaining(structure);
  } else if (field.needsPrep) {
    // Prep before harvest — both can be true at once (harvest-any harvests ripe crops for free).
    phase = 'plant';    seedsNeeded = field.untilled + field.emptyTilled;
  } else if (field.harvestReady) {
    phase = 'harvest';  // consumes nothing — never gated
  } else if (field.growing > 0 && inventoryLens.reachableByFleet('bone_meal') > 0) {
    // Fleet-wide, not pocket-only — this phase funds the TRIP that lets land_prep pull bone meal in.
    phase = 'bonemeal';
  } else {
    phase = 'idle';     // mid-growth with nothing to spend on it — nothing actionable this sweep
  }

  // A hoe is needed to till — fold in its wood when the pool holds no hoe of any tier.
  const hoeAvailable = inventoryLens.reachableByFleet('hoe') > 0;
  const needsHoe = phase === 'locate' || phase === 'build' || phase === 'plant';
  const hoeLogs = (needsHoe && !hoeAvailable) ? HOE_LOGS : 0;

  // Hoe wood and seeds are ADDED onto the structural diff, not assigned — both can price to logs (Law 25).
  const materialsNeeded = { ...structureRaw };
  if (hoeLogs > 0)     materialsNeeded.logs = (materialsNeeded.logs || 0) + hoeLogs;
  if (seedsNeeded > 0) materialsNeeded.wheat_seeds = (materialsNeeded.wheat_seeds || 0) + seedsNeeded;

  const materialsMissing = {};
  for (const [tok, cnt] of Object.entries(materialsNeeded)) {
    if (tok === POCKET_SOIL) continue;                   // the pocket's to fund, at the cluster (THE DIRT BUDGET)
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
  const plots = [];
  let anchor = null, anyLocated = false;
  const missingAgg = {};
  const buildQueue = [];              // build plots that passed their OWN check — funded against the pool below
  for (const roomKey of FARM_ROOM_KEYS) {
    const center = readTransposeOrigin(roomKey);
    if (!center) continue;              // an unfilled instance (the field fell short of the target) — never located, idle
    anyLocated = true;
    if (!anchor) anchor = center;       // cluster anchor = the first located plot (instance 0's stand)
    // Unguarded deliberately: scan() is our code and every mineflayer call beneath it is guarded at its
    // own boundary, so anything that escapes here is a defect that must travel (Law 13, Law 25).
    const v = await scan(bot, roomKey, { quiet: true });
    // A build plot must carry its own seeds to be actionable. plant/harvest/bonemeal lay no new
    // ground, so they stay generously actionable regardless of supply.
    const actionable = v.phase === 'plant' || v.phase === 'harvest' || v.phase === 'bonemeal';
    for (const [k, n] of Object.entries(v.materials_missing || {})) missingAgg[k] = (missingAgg[k] || 0) + n;
    const plot = {
      roomKey, center, phase: v.phase, actionable, materials_ready: v.materials_ready,
      seeds_needed: (v.materials_needed && v.materials_needed.wheat_seeds) || 0,
      dirt_needed: (v.materials_needed && v.materials_needed[POCKET_SOIL]) || 0,
      structure_placed: v.structure_placed, structure_digs_left: v.structure_digs_left, field: v.field,
    };
    // Funded below, not here — a build plot's own verdict cannot see its 31 siblings (see THE SEED BUDGET).
    if (v.phase === 'build' && v.materials_ready === true) buildQueue.push(plot);
    plots.push(plot);
  }

  // ── THE SEED BUDGET: ONE POOL, COUNTED ONCE ────────────────────────────────────────────────────
  // Spent once here, in FARM_ROOM_KEYS order (deterministic, Law 19): planting first, then remaining
  // seeds fund build plots one at a time; the rest stay non-actionable to re-post next cycle.
  const plantDemand = plots.reduce((n, p) => n + (p.phase === 'plant' ? p.seeds_needed : 0), 0);
  let seedBudget = inventoryLens.reachableByFleet('wheat_seeds') - plantDemand;
  let unfundedBuilds = 0;
  // ── THE DIRT BUDGET: the pocket, after the seeds ── A seed-funded row is laid only if the pocket also
  // holds its dirt; rows go in key order, so a short pocket holds back the outer rows. `dirtGap` sizes
  // the order over every row the seeds CAN plant, so one trip covers the whole chain.
  const pocketDirt = countInInventory(POCKET_SOIL, getBotInventory());
  let dirtBudget = pocketDirt;
  let dirtShortBuilds = 0;
  const seedsForBuilding = seedBudget;

  // ── ONE ROW AT A TIME, AND IT IS ALWAYS THE LOWEST UNLAID ONE ──────────────
  // A tine row is laid by a body standing ON the row behind it, so only the chain makes a row reachable.
  // The manager re-senses every iteration: lay the lowest row, the next scan hands back the one after it.
  const lowestUnlaid = plots.find(p => p.phase === 'build' || p.phase === 'stranded') || null;
  const buildable = buildQueue.filter(p => p === lowestUnlaid);
  const chainHeld = buildQueue.length - buildable.length;
  for (const p of buildable) {
    // seeds_needed === 0 funds unconditionally: a blueprint with no 'growing' voxel costs no seeds, and
    // a negative budget from plant demand must not veto a plot that spends nothing.
    if (!(p.seeds_needed === 0 || p.seeds_needed <= seedBudget)) { unfundedBuilds++; continue; }
    seedBudget -= p.seeds_needed;
    if (p.dirt_needed <= dirtBudget) { p.actionable = true; dirtBudget -= p.dirt_needed; }
    else dirtShortBuilds++;
  }
  let dirtPlanned = 0, seedsLeft = seedsForBuilding;
  for (const p of plots) {
    if (p.phase !== 'build' && p.phase !== 'stranded') continue;
    const seeds = p.phase === 'build' ? p.seeds_needed : SEED_NEED;
    if (seeds > seedsLeft) break;
    seedsLeft -= seeds;
    dirtPlanned += p.phase === 'build' ? p.dirt_needed : DIRT_PER_ROW;
  }
  // Pocket dirt is spent first: `dirtPlanned - pocketDirt` is the remainder, floored at
  // FARM_DIRT_MIN_GATHER; a stocked chest can serve it via supply_manager without a gather.
  const dirtGap = dirtPlanned > pocketDirt ? Math.max(FARM_DIRT_MIN_GATHER, dirtPlanned - pocketDirt) : 0;

  // ── THE FARM'S SEED ORDER AND ITS "BUILT" VERDICT ── Order = every seed still unsown, less what the
  // fleet reaches. Built = sited with no row left to lay; job_board's built gate reads it.
  const unbuiltRows = plots.filter(p => p.phase === 'build' || p.phase === 'stranded');
  const seedDemand = plantDemand + unbuiltRows.reduce((n, p) => n + (p.phase === 'build' ? p.seeds_needed : SEED_NEED), 0);
  const seedsReachable = inventoryLens.reachableByFleet('wheat_seeds');
  const seedGap = Math.max(0, seedDemand - seedsReachable);
  const built = anyLocated && unbuiltRows.length === 0;

  const actionablePlots = plots.filter(p => p.actionable);
  const anyActionable = actionablePlots.length > 0;
  const materialsReady = actionablePlots.some(p => p.materials_ready);

  // One aggregated cluster line (Law 5) with a phase breakdown; per-plot summaries stay suppressed (quiet).
  const byPhase = plots.reduce((m, p) => (m[p.phase] = (m[p.phase] || 0) + 1, m), {});
  const phaseStr = Object.entries(byPhase).map(([k, n]) => `${k}:${n}`).join(' ') || 'none';
  // The seed budget is reported wherever it bit, distinguishable from a plot with nothing to do (Law 6).
  const seedStr = (unfundedBuilds ? ` — ${unfundedBuilds} build plot(s) unseeded, held back` : '')
    // A row held by the CHAIN and a row held by SUPPLY look identical from outside; named separately (Law 6).
    + (chainHeld ? ` — ${chainHeld} row(s) ready but held behind ${lowestUnlaid ? _rowLabel(lowestUnlaid.roomKey) : 'the unlaid row'} (laid lowest-first, each stood on the one before)` : '')
    + (dirtShortBuilds ? ` — ${dirtShortBuilds} seeded row(s) waiting on pocket dirt` : '')
    // Names which number produced the order — with a floor in play, shortfall and order size differ (Law 25).
    + (dirtGap ? ` — ${dirtGap} dirt ordered (${dirtPlanned} for the rows the seeds can plant, ${pocketDirt} held`
        + (dirtGap > dirtPlanned - pocketDirt ? `, short ${dirtPlanned - pocketDirt} but floored at the ${FARM_DIRT_MIN_GATHER}-block minimum trip` : '') + ')' : '')
    + (seedGap ? ` — ${seedGap} seeds ordered (${seedDemand} to sow, ${seedsReachable} reachable)` : '')
    + (anyLocated ? (built ? ' — farm BUILT' : ` — farm not built (${unbuiltRows.length} row(s) to lay)`) : '');
  if (!anyLocated) {
    // Silent for a species whose ladder has no farm at all. Reads the same table every other site
    // reads (Law 16), so a species that gains a farm starts reporting with no edit here.
    const farms = require('@thinking/requested_work').activeBuildingRequirements()
      .some(req => req.field === FARM_STRUCTURE);
    if (farms) watcher.summary(TAG, 'cluster: no plots located yet — base-layout lock pending.');
  } else if (!anyActionable) {
    watcher.summary(TAG, `cluster: ${plots.length} plots, none actionable (${phaseStr})${seedStr || ' — nothing to tend'}.`);
  } else {
    watcher.summary(TAG, `cluster: ${plots.length} plots, ${actionablePlots.length} actionable (${phaseStr}) — materials ${materialsReady ? 'ready' : 'GATED'}${seedStr}.`);
  }
  if (anyLocated) _emitCensus(plots, unbuiltRows.length);

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
    seeds_for_visit: Math.max(0, plantDemand) + (seedsForBuilding - seedsLeft),
  };
}

// ── THE FARM CENSUS — the farm's building_integrity scan line ───────────────────────────────────────────────
// Answers how much of the farm stands, off the same per-row scan the cluster verdict already ran
// (Law 16), every sweep (Law 5), shaped for monitoring/farm_lens.js to parse:
//   farm census "wheat_farm" — L/S row(s) laid of N · structure P/T placed, D to dig · crop cells C: G growing, M mature, E tilled unsown, U untilled, B blocked
//     rows: #0=harvest 3/3 g2 m0 | #1=build 1/3 | …
// A row counts as LAID when its phase is past build. `#k` is the row's index in FARM_ROOM_KEYS.
const { FARM_STRUCTURE } = require('@thinking/architect_config');
function _rowLabel(roomKey) {
  const i = FARM_ROOM_KEYS.indexOf(roomKey);
  return `#${i}`;
}
function _emitCensus(plots, unbuiltCount) {
  const sum = (f) => plots.reduce((n, p) => n + (f(p) || 0), 0);
  const placed = sum(p => p.structure_placed);
  const digs = sum(p => p.structure_digs_left);
  const cell = (k) => sum(p => p.field && p.field[k]);
  watcher.summary(TAG, `farm census "${FARM_STRUCTURE}" — ${plots.length - unbuiltCount}/${plots.length} row(s) laid of ${FARM_ROOM_KEYS.length}`
    + ` · structure ${placed}/${plots.length * STRUCT_PER_ROW} placed, ${digs} to dig`
    + ` · crop cells ${cell('total')}: ${cell('growing')} growing, ${cell('mature')} mature, ${cell('emptyTilled')} tilled unsown, ${cell('untilled')} untilled, ${cell('blocked')} blocked`);
  watcher.summary(TAG, `  rows: ${plots.map(p => `${_rowLabel(p.roomKey)}=${p.phase} ${p.structure_placed}/${STRUCT_PER_ROW}`
    + (p.field ? ` g${p.field.growing} m${p.field.mature}` : '')).join(' | ')}`);
}

function getState() { return _lastScan; }

module.exports = { scan, scanCluster, getState, FARM_ROOM_KEYS, FARM_BLUEPRINT, SEED_NEED, HOE_LOGS };
