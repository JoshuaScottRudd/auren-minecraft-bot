// perception node: farming_integrity
// purpose: The farm's answer to building_integrity / mining_integrity — ONE node that reads the
//          whole farm situation and hands back a single verdict the job_board gates dispatch on,
//          the same way mining and building integrity gate their own boards. It composes,
//          it does not re-implement (Law 16):
//            - STRUCTURE (damage & repair) → blueprint_survey.survey on the farm blueprint.
//              The blueprint declares its water/crop cells external, so the survey skips them and the
//              steps describe pure structure — a broken plot resurfaces as an incomplete structure
//              exactly like a creeper hole in the headframe.
//            - FIELD (till/plant/harvest census) → farmland_site.getFarmState.
//            - MATERIALS (seeds + structure blocks + hoe) measured across the accessible pool (pocket +
//              every registered chest — the pool land_prep pulls from).
//          From those it derives the current PHASE and whether the materials that phase needs are
//          on hand, so job_board stays thin: read the verdict, post the phase's job when ready.
//
// WHY a farm-specific integrity node and not more logic bolted onto job_board: farming is a
//   self-contained triad (farm_manager → land_prep → farm_executor). Its "can we start yet?"
//   question spans several material sources (structure blocks, seeds, a hoe) across two pools, and its
//   completion is repair-aware (a damaged plot must be rebuilt). That is exactly the shape of an
//   integrity node, and keeping it beside its siblings means the board treats every kind of work
//   the same way. The numbers are blueprint-DERIVED, not configured: the seed count IS the crop-voxel
//   count and the material bill IS the remaining place-steps decomposed to raw — no second source to
//   drift (Law 16). The one tunable that lives elsewhere (the seed row floor) is a different concept
//   (fleet stock to keep) and deliberately not reused here.
//
// Pure observation (Law 1 perception exception — action fragments may call this directly). Guards
// on `located` before touching the structure/field sensors so it never throws pre-lock: a farming
// job dispatched before set_buildspot is job_board's gate to prevent, not this node's to crash on.

'use strict';

const blueprintRegistry = require('@kernel/blueprint_registry');
const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const blueprintSurvey = require('@perception/blueprint_survey');
const { getFarmState } = require('@perception/farmland_site');
const { blueprintToRawMaterials } = require('@utils/calculators/build_material_calculator');
const { hasHomeChest, readBuildCenter } = require('@utils/fragment_utils');
const inventoryLens = require('@kernel/inventory_lens');

const TAG = 'farming_integrity';

// ── CONFIG: the wheat-farm instances this subsystem owns ───────────────────────────────────────
// ONE plot DESIGN, ONE geometry (FARM_BLUEPRINT), N sited instances each under a distinct conference-room key
// (FARM_ROOM_KEYS, from architect_config — the single source, Invariant D). scan(bot, roomKey) returns ONE
// instance's verdict; job_board loops FARM_ROOM_KEYS and posts one job per instance — per-instance keys
// over duplicate-named blueprints, reusing the mining-cell instance pattern (Law 16). Grow the farm count
// by editing FARM_ROOM_KEYS in config, never here. The blueprint-derived needs below (SEED_NEED/HOE_LOGS)
// are per-DESIGN, so they are identical across instances — computed once.
const { FARM_BLUEPRINT_NAME: FARM_BLUEPRINT, FARM_ROOM_KEYS } = require('@thinking/architect_config');

let _lastScan = null;

// ── Blueprint-derived needs (the farm is one fixed design → compute once at load) ──
//   SEED_NEED = one seed per crop cell = the 'growing' voxel count (a full planting).
//   HOE_LOGS  = raw logs a wooden_hoe costs — the fallback wood when no hoe is on hand.
// Both track the blueprint automatically: redraw the plot and the seed gate follows.
//
// THE STRUCTURE'S OWN MATERIALS ARE NOT COMPUTED HERE, and the difference is the whole reason this block
// is short. A per-design constant can only price what the WHOLE blueprint costs, which is the right
// answer exactly once — before anything is built. The plot is repair-aware and sited dynamically, so what
// it needs is whatever the survey still has outstanding; that is _structureMaterialsRemaining's job, from
// the live diff. Two axes survive as constants because they are genuinely per-design and survey-invisible:
// seeds (the crop cells are declared external, so the survey never emits them) and the hoe (a tool, not a
// voxel). Anything the survey CAN see must be priced from the survey (Law 16 — one answer per question).
const { SEED_NEED, HOE_LOGS } = (() => {
  // tryGetBuilding answers a missing blueprint with null, which is the only condition the removed guard
  // named — everything below is arithmetic over our own registry, so a throw there is a malformed
  // blueprint and must stop the load rather than start the run on a zero seed need (Law 13).
  const fallback = { SEED_NEED: 0, HOE_LOGS: 2 };
  {
    const b = blueprintRegistry.tryGetBuilding(FARM_BLUEPRINT);
    if (!b) return fallback;
    const voxels = blueprintSurvey.collectAllVoxels(b);
    const seeds  = voxels.filter(v => v.raw && v.raw[3] === 'growing').length;
    const hoeLogs = blueprintToRawMaterials({ wooden_hoe: 1 }).logs || 2;
    return { SEED_NEED: seeds, HOE_LOGS: hoeLogs };
  }
})();

// EVERY remaining structural place step, priced to raw materials — repair-aware, so it is a full plot
// before the build or one block's worth after a break. Group tokens ('planks') decompose through the
// recipe walk exactly as concrete ones pass through it, so the cost is species-independent whatever
// variant the bot ends up placing.
//
// A NAMED SUBSET OF THE MATERIALS IS A FALSE GATE, AND IT KILLS RUNS. When the shortfall list holds only
// the materials it happens to name, while the repairer that fulfils the job requires every block in the
// remaining diff, the two disagree the moment the blueprint contains anything the list forgot. A plot
// whose one missing voxel is unlisted passes the gate as "materials ready", is dispatched, and comes back
// worked=0 material_short every cycle until the judge kills the signal. Two faults in one line: the gate
// and its fulfiller answer "can this run" from different lists (Law 16), and the verdict the gate emits
// is false measured against the criteria of the party relying on it (Law 25).
//
// THE FIX IS THE SET, NOT THE ITEM. Adding the one missing name closes today's shortfall and leaves every
// other voxel type free to reopen it the day a blueprint changes — and this blueprint changes, because the
// plot is sited dynamically against terrain rather than stamped as a fixed enclosure. The gate must price
// what the SURVEY found, never a list kept beside it.
//
// 'growing' is the one exclusion: that is the seed axis, already counted as wheat_seeds by the phase
// above, and pricing it here would report one shortfall twice under two names.
function _structureMaterialsRemaining(structure) {
  const byType = {};
  const steps = Array.isArray(structure?.steps) ? structure.steps : [];
  for (const s of steps) {
    if (!s || s.action !== 'place' || !s.type || s.type === 'growing') continue;
    byType[s.type] = (byType[s.type] || 0) + 1;
  }
  return blueprintToRawMaterials(byType);
}

// Every material question here is FLEET-WIDE (pocket + chests, land_prep's reach) because the answer
// funds a TRIP, not a craft — inventory_lens.reachableByFleet is the one door to it. The home gate is
// likewise a shared primitive (hasHomeChest in fragment_utils): Law 16, one implementation,
// not a duplicate per node.

// scan(bot) → the farm verdict. Fields job_board reads:
//   home                supply source exists
//   located             set_buildspot locked a center
//   structure_complete  structure matches (repair-aware; false until located)
//   field               getFarmState census (null until located)
//   phase               'locate' | 'build' | 'plant' | 'harvest' | 'idle'
//   materials_needed    { logs, wheat_seeds } the CURRENT phase requires (blueprint-derived)
//   materials_missing   shortfall of the above after crediting the accessible pool
//   materials_ready     nothing missing → job_board may dispatch this phase
//   structure_steps     blueprint_survey structural steps (damage handling / inspectability)
// Harvest and idle need no materials, so materials_ready is trivially true for harvest (post it)
// and the phase is idle mid-growth (post nothing). Planting is seed-gated; locate/build gate on
// seeds + structure blocks + a hoe — the full build+plant pipeline cannot run without them.
// scan(bot, roomKey) → ONE farm instance's verdict. roomKey is the instance's conference-room key
// (defaults to instance 0 for single-farm callers); geometry is THIS instance's, READ from its chair by
// blueprintSurvey.geometryOf rather than named from config — the same string today, but a reading and not an
// assumption about what was locked (Law 25). FARM_BLUEPRINT below is the DESIGN, used only for the
// per-design needs (seed count, hoe cost) that any variant would share by construction.
function scan(bot, roomKey = FARM_ROOM_KEYS[0], opts = {}) {
  if (!bot || !bot.blockAt) {
    throw new Error('[farming_integrity] CODING VIOLATION: bot must be initialized before scan(). Check caller.');
  }

  const home = hasHomeChest();

  const center = readBuildCenter(roomKey);
  const located = !!center;

  // Stand-standability gate. A decomposed wheat_plot_pair's stand is a single block the bot must
  // stand ON to tend the adjacent crop. Dynamic water can flood that block AFTER siting; the bot
  // then bobs where it should stand, battle_stations yanks it to land, the manager re-dispatches,
  // and it livelocks until recursive_judge halts it. Re-validate the locked stand EVERY scan
  // (Invariant B — sited-once is not standable-forever): if neither it nor
  // any dry lip within reach can service the plot, the plot is STRANDED → non-actionable, so the manager
  // never dispatches into the loop. A reachable alternate keeps it actionable (farm_executor tends from
  // that alternate via the same resolveStandableAnchor helper, Law 16). Lazy require — anchored_repair
  // pulls in locomotion, and this perception node is required early by the job board.
  let stranded = false;
  if (located) stranded = require('@api/anchored_repair').resolveStandableAnchor(bot, center) === null;

  let structure = null, field = null;
  let structureComplete = false, structureSteps = [];
  if (located) {
    // The neutral survey returns the raw structural diff (no craft aggregation, no logging) — farming
    // does its own material gating below, so it wraps the survey directly, never building_integrity.
    // GEOMETRY IS READ, NOT ASSUMED (2026-09-11). blueprintSurvey.geometryOf returns what set_buildspot
    // actually stamped into this instance's chair. It matches the config constant today; the constant was
    // still the wrong way to get it, because surveying a plot against a geometry it was not locked under
    // projects the dirt voxel somewhere it is not and reports the cell missing forever (Law 16, Law 25).
    structure = blueprintSurvey.survey(bot, blueprintSurvey.geometryOf(roomKey), roomKey);
    structureComplete = structure.all_complete === true;
    structureSteps = Array.isArray(structure.steps) ? structure.steps : [];
    field = getFarmState(bot, roomKey);
  }

  // ── Phase + the material needs that phase carries ──
  // `structureRaw` is the BUILD phase's own answer and is priced off the live survey. `locate` prices no
  // structure at all, and that asymmetry is deliberate: the plot is sited dynamically against a waterbank,
  // so before a center is locked there is no diff to price and any whole-blueprint estimate would be a
  // guess at terrain not yet read. Locate gates on the two survey-invisible axes only (seeds, hoe) — what
  // the structure costs becomes knowable at the moment siting makes it real.
  let phase, seedsNeeded = 0, structureRaw = {};
  if (!located) {
    phase = 'locate';   seedsNeeded = SEED_NEED;
  } else if (stranded) {
    phase = 'stranded'; // stand block lost to water and no dry anchor reaches it — non-actionable, no demand
  } else if (!structureComplete) {
    phase = 'build';    seedsNeeded = SEED_NEED; structureRaw = _structureMaterialsRemaining(structure);
  } else if (field.needsPrep) {
    // Prep before harvest so seeds gate whenever any cell needs planting, even alongside ripe crops
    // the same pass harvests for free (harvest-any, so both can be true at once).
    phase = 'plant';    seedsNeeded = field.untilled + field.emptyTilled;
  } else if (field.harvestReady) {
    phase = 'harvest';  // consumes nothing — never gated
  } else if (field.growing > 0 && inventoryLens.reachableByFleet('bone_meal') > 0) {
    // ── BONE MEAL MAKES MID-GROWTH ACTIONABLE ─────────────────────────────────────────────────────
    // The APPLICATION (farm_executor.bonemealReachable) was unreachable in practice: it only ever
    // ran as a side effect of a visit made for some other reason — and the only two reasons were
    // `plant` (nothing has grown yet) and `harvest` (stage 7, which BONE_MEAL_MAX_CROP_STAGE correctly
    // refuses as waste). A field mid-growth fell to `idle`, `actionable` went false, no job posted,
    // and the bone meal sat unused. Holding the item never created the errand — this phase is that
    // pull, the same shape as every other phase here: a condition the world satisfies, not a flag
    // anyone sets.
    //
    // THE FLEET READER IS CORRECT HERE, and the pocket reader is the plausible wrong turn: the consumer
    // does apply from the hand, so gating on the pocket looks like the matching question. It is not,
    // because this phase funds a TRIP like every other one in this file — land_prep's bone-meal branch
    // pulls from the storage chest into the pocket before the tend loop runs, so chest stock is exactly
    // what makes the errand fillable. Narrowing this to the pocket would make land_prep's pull
    // unreachable: the phase could only fire when the bot already held bone meal, which is the state that
    // pull exists to create.
    phase = 'bonemeal';
  } else {
    phase = 'idle';     // mid-growth with nothing to spend on it — nothing actionable this sweep
  }

  // A hoe is needed to till (build precedes planting, plant tills) — fold in its wood when the
  // pool holds no hoe of any tier. Harvest/idle need no hoe.
  const hoeAvailable = inventoryLens.reachableByFleet('hoe') > 0;
  const needsHoe = phase === 'locate' || phase === 'build' || phase === 'plant';
  const hoeLogs = (needsHoe && !hoeAvailable) ? HOE_LOGS : 0;

  // The structural diff leads, then the two needs that are NOT voxels — the hoe's wood and the seed the
  // plot will be sown with — are added onto it rather than replacing it. Additive because a tool and a
  // structural block can price to the same raw token (a wooden hoe and a plank floor are both logs);
  // assignment would have one silently overwrite the other and under-report the shortfall (Law 25).
  const materialsNeeded = { ...structureRaw };
  if (hoeLogs > 0)     materialsNeeded.logs = (materialsNeeded.logs || 0) + hoeLogs;
  if (seedsNeeded > 0) materialsNeeded.wheat_seeds = (materialsNeeded.wheat_seeds || 0) + seedsNeeded;

  const materialsMissing = {};
  for (const [tok, cnt] of Object.entries(materialsNeeded)) {
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

  // Post the verdict for inspectability (Law 6) — its own chair beside THIS instance's build chairs
  // (keyed by roomKey so two farms never clobber one verdict).
  hq.writeBuildingChair(roomKey, TAG, {
    phase, materials_needed: materialsNeeded, materials_missing: materialsMissing,
    materials_ready: materialsReady, structure_complete: structureComplete,
    generated_at: verdict.generated_at, writer: TAG,
  });

  // scanCluster calls this per-instance across the whole 32-plot field; one summary line PER PLOT would be
  // 32 lines of noise every plan cycle (Law 5 — one aggregated line per phase of work). Quiet mode keeps
  // the per-instance chair write above (each plot stays individually inspectable, Law 6) but defers the
  // human-facing line to the cluster caller's single aggregated summary.
  if (opts.quiet) return verdict;

  // Post the verdict EVERY scan (matches building_integrity / mining_integrity). De-duping on a
  // transition key left whole plan cycles with no farming line — no way to see WHY the farm stalled
  // from the trace. Law 5: one aggregated line per phase of work, every cycle it runs. Headline =
  // the phase verdict; detail line (when sited) = the diagnostic datum so a single cycle shows where
  // the field stands and what gates it.
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
    // Name each structural repair CELL (coord + expected block + what's actually there). "1 repair
    // step" alone couldn't answer the load-bearing question when the farm repairs every harvest cycle:
    // is it the SAME cell each time — one spot being re-damaged (a bot routing across the plot, a
    // trampled floor) or a place that never satisfies (a livelock) — or SCATTERED cells (caves)? Only
    // the coordinate separates those, and the trace monitor can only show what the trace carries, so
    // the coord has to be emitted HERE, at the source. structureSteps already carries place/type/actual
    // from blueprint_survey, so this surfaces computed data, invents no logging (Law 5/14).
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

// scanCluster(bot) → the whole wheat field as ONE serviceable cluster. The 32 (FARM_PLOT_COUNT) plots
// stay SEPARATE instances — terrain-fitted, each its own locked center — but this view aggregates them
// so the manager can service the whole cluster in ONE committed visit, instead of the fleet claiming 32
// independent farm jobs and re-travelling per plot. One giant blueprint with an anchor, serviced
// individually: anchor = the first located plot's center (the approach reference); plots[] = each
// instance's phase + actionability; the manager loops the actionable ones. Reuses
// scan(bot, roomKey, {quiet}) per instance (Law 16 — no second census), so every plot's chair stays
// individually inspectable while the trace shows ONE aggregated cluster line, not 32.
//
// materials_ready is GENEROUS by design: true when ANY actionable plot is individually ready. A seed
// shortage must NOT stall the cluster — the bot works what it can (harvest is free; planting runs until
// seeds run out) and the unplanted plots stay actionable to re-post next cycle. Strict aggregate gating
// (all 32 seeds before dispatch) would freeze farming whenever partial planting was possible — the exact
// opposite of the skip-and-continue the cluster visit is built on.
// THE ONE EXCEPTION: a plot in phase BUILD is actionable only if its own materials are ready AND the
// shared seed pool still has a share left to fund it (THE SEED BUDGET, below — the per-plot half alone
// let one seed clear all 32). Generosity is right for work that can stop halfway and leave the field no
// worse; laying a plot the fleet cannot seed leaves tilled ground that needs a second visit, which is
// the two-pass farm this rule prevents.
function scanCluster(bot) {
  if (!bot || !bot.blockAt) {
    throw new Error('[farming_integrity] CODING VIOLATION: bot must be initialized before scanCluster().');
  }
  const plots = [];
  let anchor = null, anyLocated = false;
  const missingAgg = {};
  const buildQueue = [];              // build plots that passed their OWN check — funded against the pool below
  for (const roomKey of FARM_ROOM_KEYS) {
    const center = readBuildCenter(roomKey);
    if (!center) continue;              // an unfilled instance (the field fell short of the target) — never located, idle
    anyLocated = true;
    if (!anchor) anchor = center;       // cluster anchor = the first located plot (instance 0's stand)
    // Unguarded: scan() is OUR code, and every mineflayer call beneath it is guarded at its own boundary,
    // so anything that escapes here is a defect and must travel (Law 13). It was caught-and-`continue`d
    // before, which is the sharpest form of "a default is not a measurement" in this file — a skipped plot
    // leaves no gap in the aggregate, so the loop below reads an empty queue as "nothing to farm" instead
    // of "the scan never ran", and farming goes inert while the fleet reports itself healthy (Law 25).
    const v = scan(bot, roomKey, { quiet: true });
    // BUILD IS COUPLED TO PLANTING: a farm plot must not be laid unless it can also be seeded — no
    // pass that tills ground and a separate pass that plants it. scan() already folds SEED_NEED into
    // a build-phase plot's materials_needed, so the per-plot verdict was correct — the leak was HERE:
    // build was actionable unconditionally, and the cluster's generous materials_ready (ANY ready plot
    // clears the whole visit) let a harvest-ready plot greenlight a trip that then tilled seedless
    // ground. That is the two-pass farm: one visit lays the plot, a later one plants it. A build plot
    // now carries its own seeds or it is not actionable at all. plant/harvest keep the generous rule —
    // planting until the seeds run out and harvesting for free are the skip-and-continue the cluster
    // visit is built on; it is only the STRUCTURE that must not be laid on credit.
    // `bonemeal` joins plant/harvest as self-funding: like harvest it lays no new ground and opens no
    // return visit, and its one material was already proven present by the phase test itself. It is
    // deliberately NOT added to the seed budget below — bone meal spends no seeds, so a bonemeal plot
    // can never compete with a plant plot for the thing that is actually scarce.
    const actionable = v.phase === 'plant' || v.phase === 'harvest' || v.phase === 'bonemeal';
    for (const [k, n] of Object.entries(v.materials_missing || {})) missingAgg[k] = (missingAgg[k] || 0) + n;
    const plot = {
      roomKey, center, phase: v.phase, actionable, materials_ready: v.materials_ready,
      seeds_needed: (v.materials_needed && v.materials_needed.wheat_seeds) || 0,
    };
    // Funded below, not here — a build plot's own verdict cannot see its 31 siblings (see THE SEED BUDGET).
    if (v.phase === 'build' && v.materials_ready === true) buildQueue.push(plot);
    plots.push(plot);
  }

  // ── THE SEED BUDGET: ONE POOL, COUNTED ONCE ────────────────────────────────────────────────────
  // The coupling rule above closed the leak at the plot and left one open at the cluster. scan()
  // judges each plot ALONE against the SHARED pool, so with SEED_NEED = 1 a single wheat_seeds in the
  // chest makes all 32 plots individually ready — and 32 verdicts that are each true produce a
  // cluster verdict that is false: the pool cannot actually fund all of them at once.
  //
  // So the pool is spent here, once, in FARM_ROOM_KEYS order (deterministic, Law 19 — same stock, same
  // plots funded, every cycle). Planting is paid FIRST: it finishes ground already broken, while a
  // build plot opens new ground that then needs a return visit — the exact cost the coupling forbids.
  // Remaining seeds fund build plots one at a time; the rest stay non-actionable and re-post next
  // cycle when supply arrives.
  //
  // This is a BUDGET, not an all-or-nothing gate: strict aggregate gating ("all 32 before dispatch")
  // freezes the field whenever partial work is possible. Laying as many plots as the fleet can actually
  // seed keeps that generosity everywhere it was ever right and removes it only where a plot would be
  // laid on credit.
  const plantDemand = plots.reduce((n, p) => n + (p.phase === 'plant' ? p.seeds_needed : 0), 0);
  let seedBudget = inventoryLens.reachableByFleet('wheat_seeds') - plantDemand;
  let unfundedBuilds = 0;
  for (const p of buildQueue) {
    // seeds_needed === 0 funds unconditionally: a blueprint with no 'growing' voxel costs no seeds, and
    // a negative budget from plant demand must not veto a plot that spends nothing.
    if (p.seeds_needed === 0 || p.seeds_needed <= seedBudget) {
      p.actionable = true;
      seedBudget -= p.seeds_needed;
    } else unfundedBuilds++;
  }

  const actionablePlots = plots.filter(p => p.actionable);
  const anyActionable = actionablePlots.length > 0;
  const materialsReady = actionablePlots.some(p => p.materials_ready);

  // ONE aggregated cluster line (Law 5) with a phase breakdown — the 32 per-plot summaries are suppressed
  // (quiet), so the trace shows the cluster's state instead of 32 lines of it.
  const byPhase = plots.reduce((m, p) => (m[p.phase] = (m[p.phase] || 0) + 1, m), {});
  const phaseStr = Object.entries(byPhase).map(([k, n]) => `${k}:${n}`).join(' ') || 'none';
  // The seed budget is reported wherever it BIT, because a plot held back by it is otherwise
  // indistinguishable in the trace from a plot with nothing to do (Law 6) — and those two want
  // opposite responses: one is waiting on supply, the other on growth.
  const seedStr = unfundedBuilds ? ` — ${unfundedBuilds} build plot(s) unseeded, held back` : '';
  if (!anyLocated) {
    watcher.summary(TAG, 'cluster: no plots located yet — base-layout lock pending.');
  } else if (!anyActionable) {
    watcher.summary(TAG, `cluster: ${plots.length} plots, none actionable (${phaseStr})${seedStr || ' — nothing to tend'}.`);
  } else {
    watcher.summary(TAG, `cluster: ${plots.length} plots, ${actionablePlots.length} actionable (${phaseStr}) — materials ${materialsReady ? 'ready' : 'GATED'}${seedStr}.`);
  }

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
  };
}

function getState() { return _lastScan; }

module.exports = { scan, scanCluster, getState, FARM_ROOM_KEYS, FARM_BLUEPRINT, SEED_NEED, HOE_LOGS };
