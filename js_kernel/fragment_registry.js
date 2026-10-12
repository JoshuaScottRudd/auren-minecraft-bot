/**
 * fragment: fragment_registry
 * purpose: Central manifest mapping symbolic task names -> fragment modules for dynamic signal dispatch.
 * invariants:
 *   - Keys correspond exactly to 'task' field values used in routed signals.
 *   - All required fragments are required (CommonJS) at load, ensuring early crash on missing dependency instead of
 *     deferred runtime failure mid‑invocation.
 *   - Pure data module: no side effects besides module loading.
 */

// ── Thinking layer ──────────────────────────────────────────────────────────
const jobBoard            = require('@thinking/job_board.js');
const dispatcher          = require('@thinking/dispatcher.js');

// ── Managers (load-bearing) ─────────────────────────────────────────────────
const supplyManager       = require('@action/supply_manager.js');
const buildingManager     = require('@action/building_manager.js');
const miningManager       = require('@action/mining_manager.js');
const farmManager         = require('@action/farm_manager.js');
const eatManager          = require('@action/eat_manager.js');
// Death recovery — a MANAGER: each act (spawn checked for a body, teleport checked for actual movement) is
// verified by sensing its outcome. It delegates to no executor; each act is a single packet with its check
// built in.
const deathManager        = require('@action/death_manager.js');
const groundSalvageExecutor = require('@action/ground_salvage_executor.js');

// ── Executors ───────────────────────────────────────────────────────────────
const explorationExecutor = require('@action/exploration_executor.js');
const harvestExecutor     = require('@action/harvest_executor.js');
const miningExecutor      = require('@action/mining_executor.js');
const craftExecutor       = require('@action/craft_executor.js');
const preconstruction     = require('@action/preconstruction.js');
const buildExecutor       = require('@action/build_executor.js');
const deliveryExecutor    = require('@action/delivery_executor.js');
const furnaceExecutor     = require('@action/furnace_executor.js');
const compostExecutor     = require('@action/compost_executor.js');
const chestHousekeepingExecutor = require('@action/chest_housekeeping_executor.js');
// find_buildingspot, set_buildspot and lock_all_buildspots are LIBRARIES: lock_all_buildspots calls the
// other two directly (locate/lock) as the one locator (Law 16), so none carries a `receive` and none has a
// registry entry. The foreman sites the base; `start_injector` records the handed site by calling
// `recordHandedSite` directly.
const setWoodPreference   = require('@action/set_wood_preference.js');
const idlePark            = require('@action/idle_park.js');
// land_prep and farm_executor are LIBRARIES: farm_manager owns the tend loop and calls their verbs
// directly — land_prep.prepare() once, farm_executor.tendPlot() per plot (Law 15) — so neither has a
// registry entry.
const torchExecutor       = require('@action/torch_executor.js');
const canopyClearExecutor = require('@action/canopy_clear_executor.js');
const clearGroundExecutor = require('@action/clear_ground_executor.js');
// A downloaded building's site works — ONE verb (Law 0): work one anchor cube from beneath, removing every
// wrong block and placing every right one. The ground is cleared by that same verb, so there is no scrape,
// basement or seal fragment. The felling phase has no fragment of its own; it is the canopy executor above,
// carrying the site's box.
const buildColumnExecutor     = require('@action/build_column_executor.js');
// A column's material is staged before the column is entered: withdraw, craft, then the executor above.
const columnPreparation       = require('@action/column_preparation.js');
// supply_manager dispatches this for a cobblestone shortfall — the stone sibling of harvest_executor,
// keyed by material.
const stoneProspectExecutor = require('@action/stone_prospect_executor.js');
const eatExecutor         = require('@action/eat_executor.js');

// ── Admin ───────────────────────────────────────────────────────────────────
// start_injector is NOT registered: it has no `receive` and nothing routes to it. master_core (on the
// `start` operator verb) and operator_commands call `.inject()` directly, so it is a LIBRARY like
// land_prep above.
//
// No load-time assert checks for this here: the bus already warns `No valid receiver found for '<name>'`
// and names the target in the trace, so an orphaned route (Law 8) surfaces on its own.
const recursiveJudge       = require('@action/recursive_judge.js');
// Live single-fragment isolation harness (manual). Registered so the bus can dispatch a
// fragment-under-test's rerouted return signal (to:'fragment_tester') back to its receive.
const fragmentTester       = require('@action/fragment_tester.js');

// ── Sentry mode: the watch ──────────────────────────────────────────────────
// Combat with the planning recursion removed, armed by the `sentry` operator verb instead of `start`.
// Registered like any other target so it rides the real bus. recursive_judge with `test: true` halts
// without replanning, so sentry needs no fragment of its own beyond await_aggro below.
const awaitAggro          = require('@action/await_aggro.js');

// ── Locomotion sub-loop (Law 15) ────────────────────────────────────────────
const locomotionDispatcher = require('@locomotion/locomotion_dispatcher.js');
const locomotionJudge      = require('@locomotion/locomotion_judge.js');
const navigator            = require('@locomotion/navigator.js');

module.exports = {
  // Thinking
  job_board:    jobBoard,
  dispatcher,

  // Managers
  supply_manager:   supplyManager,
  building_manager: buildingManager,
  mining_manager:   miningManager,
  farm_manager:     farmManager,
  eat_manager:      eatManager,
  death_manager:    deathManager,
  ground_salvage_executor: groundSalvageExecutor,

  // Executors
  exploration_executor: explorationExecutor,
  harvest_executor: harvestExecutor,
  mining_executor:  miningExecutor,
  craft_executor:      craftExecutor,
  preconstruction:       preconstruction,
  delivery_executor:   deliveryExecutor,
  furnace_executor:    furnaceExecutor,
  compost_executor:    compostExecutor,
  chest_housekeeping_executor: chestHousekeepingExecutor,
  build_executor:      buildExecutor,
  set_wood_preference: setWoodPreference,
  idle_park:        idlePark,
  torch_executor:   torchExecutor,
  canopy_clear_executor: canopyClearExecutor,
  clear_ground_executor: clearGroundExecutor,
  build_column_executor:     buildColumnExecutor,
  column_preparation:        columnPreparation,
  stone_prospect_executor: stoneProspectExecutor,
  eat_executor:     eatExecutor,

  // Admin
  recursive_judge:       recursiveJudge,
  fragment_tester:       fragmentTester,

  // Sentry
  await_aggro:           awaitAggro,

  // Locomotion
  locomotion_dispatcher: locomotionDispatcher,
  locomotion_judge:      locomotionJudge,
  navigator,
};

// ── Load-time completeness assert (Law 13, Law 8) ────────────────────────────
// Every name the dispatcher can route a job to must exist here, or the signal has a destination with no
// receiver — an orphaned message (Law 8) that only surfaces when that job type first posts, deep into a
// live run.
//
// It reads the dispatcher's live map to discover the check, so a job type added later is checked with no
// edit here. It rides `preflight`'s pass 1 for free, since that loads this file.
{
  const { MANAGER_MAP } = require('@thinking/dispatcher');
  const missing = Object.entries(MANAGER_MAP)
    .filter(([, fragmentName]) => !module.exports[fragmentName])
    .map(([jobType, fragmentName]) => `${jobType} → ${fragmentName}`);
  if (missing.length) {
    throw new Error(
      `[fragment_registry] CODING VIOLATION: dispatcher routes job type(s) to fragment(s) with no registry ` +
      `entry: ${missing.join(', ')}. The signal bus cannot deliver to a name that is not exported here, so ` +
      `the job would dispatch into nothing. Add the require + export above.`
    );
  }
}
