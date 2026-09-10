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
// Death recovery — a MANAGER because both its acts are verified by sensing rather than by trusting the
// command that caused them (spawn → is there a body; teleport → did it actually move). It delegates to no
// executor: each act is a single packet whose whole substance is the check around it.
const deathManager        = require('@action/death_manager.js');
const groundSalvageExecutor = require('@action/ground_salvage_executor.js');
// compost_executor is a LIBRARY: filling and emptying the compost bin is part of inventory swapping, so
// both its verbs happen inside one dumpExcess visit, and it has no `receive` and no signal can be routed
// to it. inventory_swapper requires it directly — same conversion land_prep and farm_executor got, and
// the same reason it carries no entry below.

// ── Executors ───────────────────────────────────────────────────────────────
const explorationExecutor = require('@action/exploration_executor.js');
const harvestExecutor     = require('@action/harvest_executor.js');
const miningExecutor      = require('@action/mining_executor.js');
const craftExecutor       = require('@action/craft_executor.js');
const preconstruction     = require('@action/preconstruction.js');
const buildExecutor       = require('@action/build_executor.js');
const deliveryExecutor    = require('@action/delivery_executor.js');
const furnaceExecutor     = require('@action/furnace_executor.js');
// find_buildingspot + set_buildspot are LIBRARIES now: their reactive `receive`s — the lazy per-blueprint
// locate route — are retired under Law 16 (one pathway), so they are no longer signal-dispatch targets
// and carry no registry entry. lock_all_buildspots requires them directly (locate/lock) as the ONE locator.
const lockAllBuildspots   = require('@action/lock_all_buildspots.js');
const setWoodPreference   = require('@action/set_wood_preference.js');
const idlePark            = require('@action/idle_park.js');
// land_prep + farm_executor are LIBRARIES now: farm_manager owns the tend loop and calls their verbs
// directly — land_prep.prepare() once, farm_executor.tendPlot() per plot (Law 15). Their signal `receive`s
// are retired, so they are no longer signal-dispatch targets and carry no registry entry — the same
// conversion find_buildingspot/set_buildspot got above.
const torchExecutor       = require('@action/torch_executor.js');
const canopyClearExecutor = require('@action/canopy_clear_executor.js');
// The producer supply_manager dispatches for a cobblestone shortfall — the stone sibling of
// harvest_executor, dispatched by material rather than by a job type of its own.
const stoneProspectExecutor = require('@action/stone_prospect_executor.js');
const eatExecutor         = require('@action/eat_executor.js');

// ── Admin ───────────────────────────────────────────────────────────────────
// start_injector is NOT registered: it has no `receive` and nothing routes to it. Its two callers —
// master_core (on the `start` operator verb) and operator_commands — call `.inject()` directly, so it is
// a LIBRARY in the same sense as compost_executor and land_prep above. It carried a registry entry from
// 2026-06 until 2026-09-10 anyway, which made it a name the bus would accept and then drop on the floor
// (Law 8, orphaned message) had anything ever routed to it.
//
// NO SECOND ASSERT WAS ADDED FOR IT, and the reasoning is the point. A check for "every entry has a
// receive" passes two of the Architect's three gates for a guard — it is necessary (this file carried a
// real violation for three months) and it is deterministic (one `typeof` over the exported map). It
// fails the third: the damage is bounded and self-announcing. The bus already warns
// `No valid receiver found for '<name>'` and the trace names the target, so the failure costs one
// look at a trace rather than a silent wrong answer. Compare the catch-shape gate, where the failure is
// an error swallowed forever with nothing written anywhere. Delete the entry; do not build the machine.
const recursiveJudge       = require('@action/recursive_judge.js');
// Live single-fragment isolation harness (manual). Registered so the bus can dispatch a
// fragment-under-test's rerouted return signal (to:'fragment_tester') back to its receive.
const fragmentTester       = require('@action/fragment_tester.js');

// ── Sentry mode: the watch ──────────────────────────────────────────────────
// Combat with the planning recursion removed — armed by the `sentry` operator verb instead of
// `start`. Registered here like any other target: it rides the real bus so it can be grafted into
// the recursion later by changing a route, not by rewriting it.
// ONE fragment: a separate sentry_judge is redundant, since recursive_judge with `test: true` already
// halts without replanning. A split scheduler/scan pair is also wrong, since waiting for aggro is one
// verb — splitting it forces the two halves to hand back and forth to perform it, which is a chain
// re-entering a fragment it had already visited, and the bus correctly refuses that. See await_aggro's
// header for the hop count.
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
  build_executor:      buildExecutor,
  lock_all_buildspots: lockAllBuildspots,
  set_wood_preference: setWoodPreference,
  idle_park:        idlePark,
  torch_executor:   torchExecutor,
  canopy_clear_executor: canopyClearExecutor,
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
// receiver — an orphaned message (Law 8), and one that only surfaces when that job type first posts, deep
// into a live run. Adding a job type is three edits (config rank, dispatcher map, this registry), and the
// third is the easy one to forget: the wiring test loads every FILE but never asks whether a routable name
// is reachable. This is that question, asked at load.
//
// It DISCOVERS rather than carries a list (`tools/README.md`): it reads the dispatcher's live map, so a
// job type added tomorrow is checked tomorrow with no edit here. That is why it earns a permanent home —
// a hand-written list of job types would be stale the day after the next one is added, and would report
// green the whole time. It rides `preflight`'s pass 1 for free, since that loads this file.
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
