// fragment: lock_all_buildspots (action)
// purpose: Locate AND lock EVERY base blueprint's build site in ONE startup pass, the HARDEST-to-site
//          blueprint first as the anchor, each satellite at its NEAREST non-overlapping site from the
//          anchor — so a bad seed or a too-strict criterion surfaces EARLY, before any building is
//          attempted, instead of one blueprint at a time deep into the run. All blueprints are surveyed
//          before any Law-13 throw, so a near-miss on one can be judged against the rest of the layout.
//
// THE INVERSION: a base coheres around its hardest-to-satisfy member: water is scarce and non-negotiable,
// whereas a mine shaft and open ground are common. So the ANCHOR is the wheat farm (strictest criterion —
// a hydrated shoreline the wheat_plot_scanner must find); the headframe and tree farm are the satellites
// fitted around it. The headframe remains the conceptual town center everywhere else; here the wheat farm
// is only the geometric PLACEMENT reference.
//
// NO DISTANCE CAP: the ONLY building-to-building constraint is NON-OVERLAP. A distance-spread cap was
// removed after the overhead gate (building_site_overlays) correctly began refusing hillside/half-pond
// farm sites — a spread cap would hard-stop the WHOLE base rather than accept a distant-but-buildable
// farm, as long as it isn't inside another blueprint's boundary. Nearest-first search still keeps the
// base as tight as the terrain allows; the distance is reported for context, never gated.
//
// So this is a SURVEY-then-JUDGE, never a fail-on-first:
//   1. Site the WHOLE phase-1 wheat field in ONE wheat_plot_scanner sweep from the bot's spawn — the nearest
//      FARM_PLOT_COUNT (crop, stand) plots that are hydratable, stand-pairable, and mutually PENALTY-FREE.
//      The scanner (not find_buildingspot) sites this field because its penalty-free guarantee is cross-plot;
//      each plot locks as one wheat_plot_pair instance. Instance 0's stand is the base anchor.
//   2. Locate each non-farm satellite (headframe) from farm instance 0's stand (uncapped ring, nearest-first,
//      via find_buildingspot), clear of every sibling's MIN_BLUEPRINT_SPACING reject ring — the field's plot
//      footprints included, so the headframe never lands on a plot.
//   3. Judge the WHOLE layout at once: a satellite that finds no valid site, or the field finding ZERO plots,
//      is the failure. A field SHORT of FARM_PLOT_COUNT is NOT a failure — a partial ad-hoc field still feeds
//      the fleet; the unfilled instances idle (the one place the batch forgoes whole-or-nothing, on purpose).
//   4. All found → lock them all (set_buildspot.lock). A genuine miss → Law 13, lock NOTHING (default-stopped).
//      A transient (world still streaming: no water in the loaded area yet) soft-fails for a retry.
//
// No navigation anywhere: locomotion carves the path at build time, so a pre-lock walk would only be a
// fake reachability test. This fragment operates ON the record only; it joins no build pathway. Reuses
// the extracted engines: wheat_plot_scanner (field siting) + find_buildingspot.locate (satellite siting)
// + set_buildspot.lock (commit) — Law 16, one siter per field, one lock primitive.

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { routeToJudge } = require('@utils/signal_utils');
const { locate, loadBlueprintDims, getExistingFootprints, footprintBox } = require('@action/find_buildingspot');
const { lock } = require('@action/set_buildspot');
const { footprintExtent } = require('@perception/blueprint_survey');   // a plot's reach at its own rotation
const { scanWheatPlots, plotRotation } = require('@utils/wheat_plot_scanner');
const { MIN_BLUEPRINT_SPACING, FARM_BLUEPRINT_NAME, FARM_PLOT_COUNT, FARM_ROOM_KEYS } = require('@thinking/architect_config');

const TAG = 'lock_all_buildspots';

// The canonical base-layout sequence (this batch is now the ONE locator — Law 16; Phase 2 retires the
// duplicated per-blueprint find-routing in building_manager/farm_manager). The ANCHOR is the wheat farm
// (strictest criterion — a hydrated shoreline), sited first from the bot's spawn wherever water permits.
// Each satellite is located from the anchor's center and must land within the spread gate. clearance =
// the overlap-reject ring each blueprint keeps from the others — the single MIN_BLUEPRINT_SPACING knob
// for every blueprint, so the base packs to a uniform minimum gap instead of the tree farm borrowing the
// 32-block combat radius and landing far out on whatever flat ground existed.
// requireDirtGround gates the tree farm onto plantable soil (grass/dirt group) so its floor is complete
// and free — at most one Y layer sliced (MAX_Y_VARIANCE), never a laid dirt slab on stone. requireShaft
// stays with the headframe — its own siting need. See THE INVERSION note in the header for WHY the wheat
// farm anchors instead of the headframe.
// The wheat farms are sited by the wheat_plot_scanner, NOT a find_buildingspot water-site sweep. The
// scanner computes the WHOLE phase-1 field — FARM_PLOT_COUNT (crop, stand) plots — in one penalty-free
// sweep from spawn, because the field's penalty-free guarantee is cross-plot and cannot be expressed as
// independent per-instance siting. It is the ONE siter for this field (Law 16): find_buildingspot's local
// per-spot fit knows neither the hydration Y-rule nor the penalty graph, so it must not also site these.
// Each plot locks as one wheat_plot_pair instance (build_center = the STAND, rotation aims the crop
// voxel); instance 0's stand is the headframe's placement reference. See THE INVERSION note for WHY the
// wheat field anchors the base (still the strictest-sited member).
// Non-farm satellites — fitted around the farm cluster, each from a named origin (the headframe hangs off
// farm instance 0's bank via anchorFrom, not the waterline it can't settle on). requireShaft is the
// headframe's own siting need; clearance is the single MIN_BLUEPRINT_SPACING gap every blueprint keeps.
const SATELLITES = [
  { blueprint: 'headframe', roomKey: 'headframe',
    requireShaft: true, requireDirtGround: false,
    clearance: MIN_BLUEPRINT_SPACING, anchorFrom: FARM_ROOM_KEYS[0] },
  // The contractor's house. SITED HERE RATHER THAN BY A SITER OF ITS OWN, and that placement is what
  // makes "outside every protected voxel" a GUARANTEE instead of a check: locate() rejects any candidate
  // overlapping a locked footprint padded by MIN_BLUEPRINT_SPACING, and this batch feeds it both the
  // already-locked buildings and this pass's pending ones — so a site inside another structure's claim is
  // not refused after the fact, it is never a candidate. A separate locate call outside the batch would
  // see the locked set but not the pending one, and two houses sited in one pass could land on each other.
  // ANCHORED ON THE HEADFRAME, not the farm bank: the house is where a body waits for a human, and the
  // human arrives at the base rather than at the waterline. SATELLITES is walked in order and an
  // anchorFrom target must be surveyed first, so this row must stay BELOW the headframe's.
  // No requireShaft and no requireDirtGround — it needs flat clear ground and nothing under or beneath it.
  { blueprint: 'contractor_house', roomKey: 'contractor_house',
    requireShaft: false, requireDirtGround: false,
    clearance: MIN_BLUEPRINT_SPACING, anchorFrom: 'headframe' },
];

// Named once because three things reach for this row — the homesteader's satellite pass, the
// contractor's one-building pass, and the completion test — and a literal repeated three times is three
// places to misspell one string into a silently empty search (Law 7).
const CONTRACTOR_ROOM_KEY = 'contractor_house';

// readLockedCenter — a blueprint's already-locked build_center, or null. Lets the batch be idempotent:
// a re-run skips whatever is already locked and only fills the gaps.
function readLockedCenter(roomKey) {
  const spot = hq.readBuildingChair(roomKey, 'set_buildspot');
  return (spot?.build_center && typeof spot.build_center.x === 'number') ? spot.build_center : null;
}

// baseLayoutComplete — the ONE definition of "this batch has nothing left to lock" (Law 16), exported so
// job_board's trigger gate asks the performer instead of re-deriving the performer's criterion. It IS the
// batch's own terminal condition, stated once: the field is sited when INSTANCE 0 is locked (section 1's
// skip test), and every satellite carries a center. A SHORT field is a legitimate end state, not a gap —
// see section 1's "falling SHORT of FARM_PLOT_COUNT is NOT a hard stop". Gating this on all
// FARM_PLOT_COUNT plots locked is the wrong turn: a field short of target then never completes, the gate
// keeps re-posting the job, the batch keeps reporting "nothing new", and a repeated-outcome judge
// eventually kills the run. The wrong turn is also making the BATCH scan until all plots lock: the
// world's shoreline may cap it below target forever, which trades this loop for a slower one that also
// burns a full sweep each pass.
function baseLayoutComplete() {
  // A CONTRACTOR'S LAYOUT IS ONE BUILDING, so its "nothing left to lock" is one question. Asked of the
  // mandate rather than of the world: the two species are not doing the same job badly, they are doing
  // different jobs, and a shared answer would mean a contractor reporting incomplete forever over a farm
  // it will never site (which re-posts the job, which reports incomplete, which is the loop Law 27 names).
  if (require('@kernel/bot_mandate').isContractor()) return !!readLockedCenter(CONTRACTOR_ROOM_KEY);
  if (!readLockedCenter(FARM_ROOM_KEYS[0])) return false;
  return SATELLITES.every(s => !!readLockedCenter(s.roomKey));
}

// ── THE CONTRACTOR'S LAYOUT — ONE BUILDING, SITED FROM WHERE THE BODY STANDS ─────────────────────
//
// THE SAME BLUEPRINT, A DIFFERENT ORIGIN, AND THE ORIGIN IS THE WHOLE DIFFERENCE. A homesteader sites
// this house off the headframe, because at a homestead that is where a human arrives. A contractor has
// no headframe and may never see one — it was fetched by a person standing somewhere of their own
// choosing, and `report_to_owner` has already put the body on that exact cell. So the search starts from
// the body: the Architect's ruling, *"a human requesting a bot would do so at its home and the bot will
// setup the contractor house nearby."* Scanning outward from the summoning spot is what makes the house
// land at the human's home rather than at a base the contractor has no relationship to.
//
// IT REUSES THE SATELLITE ROW RATHER THAN RESTATING ITS CRITERIA. Clearance, requireShaft and
// requireDirtGround are properties of the BUILDING, not of who is siting it, so both species read the one
// row (Law 16). Only the origin is species-dependent, and only the origin is written twice.
//
// WHY IT IS NOT A NEW JOB TYPE. This runs under `base_layout_lock`, which already sits in the pre-band —
// so "the first thing it does when a human says start" is a position the ladder already holds, not a
// priority anything here has to argue for. A second job type would need a band, a rung and a magnet
// entry to say what the existing one already says.
async function runContractorLayout(bot, dryRun) {
  const spec = SATELLITES.find(s => s.roomKey === CONTRACTOR_ROOM_KEY);
  if (!spec) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): SATELLITES declares no '${CONTRACTOR_ROOM_KEY}' row, so a `
      + 'contractor has no criteria to site its own house with. The row is the shared definition of that building.');
  }

  const report = [];
  if (readLockedCenter(spec.roomKey)) {
    const c = readLockedCenter(spec.roomKey);
    report.push(`${spec.blueprint}: already locked at (${c.x},${c.y},${c.z}) — nothing to site.`);
    return finish(dryRun, report, [], [], false);
  }

  const stand = bot.entity.position;
  const origin = { x: Math.floor(stand.x), y: Math.floor(stand.y), z: Math.floor(stand.z) };
  const res = await surveyOne(bot, spec, origin, []);

  if (res && res.found && res.candidate) {
    const bc = res.candidate.build_center;
    report.push(`${spec.blueprint}: FOUND at (${bc.x},${bc.y},${bc.z}), ${res.distFromOrigin.toFixed(1)}b from where the body stands (scan ${res.scanSecs}s).\n      ↳ WHY HERE: ${res.successSummary}`);
    return finish(dryRun, report, [{ spec, candidate: res.candidate }], [], false);
  }
  if (res && res.reason === 'chunks_not_loaded') {
    report.push(`${spec.blueprint}: world not loaded yet (${res.reason}) — retry.`);
    return finish(dryRun, report, [], [], true);
  }
  const detail = res?.throwText || res?.warnText || res?.summaryText || '';
  report.push(`${spec.blueprint}: ✗ NOT FOUND (${res?.reason}).`);
  return finish(dryRun, report, [], [`${spec.blueprint}: NOT FOUND — ${res?.reason}. ${detail.split('\n')[0]}`], false);
}

// surveyOne — locate one blueprint from `origin`, folding this-pass PENDING footprints (blueprints
// surveyed earlier but not yet locked) into the overlap set so siblings never collide. Returns the raw
// locate result (found candidate + distFromOrigin, or a structured not-found). Never locks.
async function surveyOne(bot, spec, origin, pendingRaw) {
  const { building, dims } = loadBlueprintDims(spec.blueprint);
  const existing = getExistingFootprints(spec.clearance); // locked-in-HQ buildings, padded by this clearance
  for (const p of pendingRaw) {
    existing.push(footprintBox(p.center.x, p.center.z, p.extent, spec.clearance, p.roomKey));
  }
  return locate(bot, {
    blueprintName: spec.blueprint, building, dims, origin,
    requireShaft: spec.requireShaft,
    requireDirtGround: spec.requireDirtGround,
    existingFootprints: existing,
  });
}

// run(bot, { dryRun }) — the batch core. Surveys all blueprints, judges the whole layout, and (unless
// dryRun) locks them. Returns { ok, report:[lines], locked:[roomKeys] }. Throws Law 13 on a genuine
// layout failure (bad seed / too-strict criterion / satellite out of spread). A transient world-not-
// loaded miss returns { ok:false, transient:true } so the caller can soft-retry instead of hard-stopping.
async function run(bot, opts = {}) {
  const dryRun = !!opts.dryRun;
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set (no bot.entity.position). The bot must be registered before the batch runs.`);
  }

  // TWO SPECIES, TWO LAYOUTS, ONE JOB. The branch is at the top rather than woven through the sections
  // below because a contractor is not doing a reduced version of this pass — it sites no farm, hangs off
  // no headframe and has no whole-base non-overlap picture to hold. Running it through the estate path
  // with the farm skipped would leave it hunting a water body it has no use for, and hard-stopping the
  // run when the seed has none (Law 13's problems list) over a building that needs flat ground.
  if (require('@kernel/bot_mandate').isContractor()) {
    return runContractorLayout(bot, dryRun);
  }

  const report = [];
  const toLock = [];          // { spec, candidate } surveyed-and-passing, not yet locked
  const pendingRaw = [];      // { roomKey, center, extent } this-pass reservations for overlap avoidance
  const problems = [];        // human strings — any non-empty ⇒ Law 13, lock nothing
  let transient = false;      // any chunks_not_loaded ⇒ soft-retry, not a hard stop

  // ── 1. Wheat farms — the wheat_plot_scanner sites the WHOLE phase-1 field in ONE penalty-free sweep ──
  // The field's penalty-free guarantee is CROSS-plot (a crop's growth depends on the whole chosen set), so
  // it cannot be sited one instance at a time the way a self-contained structure can be — the scanner
  // computes all FARM_PLOT_COUNT plots together, from spawn (where the loaded chunk disc actually is). Each
  // returned (crop, stand) plot locks as one wheat_plot_pair instance: build_center = the STAND, footprint a
  // 2×2 covering stand+crop (so the headframe keeps clear of it), and plotRotation aims the blueprint's crop
  // voxel at the crop. Idempotent on the WHOLE field: if instance 0 is already locked the field is sited —
  // repopulate `centers` from the chairs and skip the scan (finish() would otherwise re-lock and Law-13 throw).
  const centers = {};              // roomKey → build_center, for satellites to hang off
  let anchorCenter = null;         // farm instance 0's stand (the headframe's reference)
  if (readLockedCenter(FARM_ROOM_KEYS[0])) {
    for (const key of FARM_ROOM_KEYS) { const locked = readLockedCenter(key); if (locked) centers[key] = locked; }
    anchorCenter = centers[FARM_ROOM_KEYS[0]];
    report.push(`${FARM_BLUEPRINT_NAME}: phase-1 field already locked (${Object.keys(centers).length}/${FARM_PLOT_COUNT} plots) — skipping scan.`);
  } else {
    const spawn = bot.entity.position;
    let origin = { x: Math.floor(spawn.x), y: Math.floor(spawn.y), z: Math.floor(spawn.z) };
    // Seed the shoreline scan at the river/ocean biome PATCHES (biome_scanner — biome cache, ~ms, no block
    // reads) so the water-BFS starts ON the water instead of radiating from spawn to find it, AND can jump
    // body→body — pick the closest river/ocean, and when it runs out of candidates pick another. biome_scanner
    // returns a distance-sorted patch list, so `origin` = the nearest water body (the base reference) and
    // `seeds` = ALL water patch seeds nearest-first (the scanner floods each in turn into one shared pool
    // until it has FARM_PLOT_COUNT). The scanner stays biome-agnostic (its own ring search still finds water
    // from any seed). No biome data (headless/edge) → seeds stays null, the scanner ring-searches from spawn
    // origin, the single-body path.
    let seeds = null;
    const patches = require('@perception/biome_scanner').scanBiomes(bot)?.patches || [];
    const water = patches.filter(p => /river|ocean/.test(p.biome));   // every water body, nearest-first (dist-sorted)
    if (water.length) {
      origin = { x: water[0].seed.x, y: origin.y, z: water[0].seed.z };  // base reference = nearest body's seed
      seeds = water.map(p => ({ x: p.seed.x, z: p.seed.z }));            // ordered candidates for the multi-body flood
    }
    // No guard: an unloaded world yields an empty patch list, never a throw (biome_scanner's own note), so
    // the headless/edge case already falls through to the spawn-origin ring search by way of `seeds` null.
    const scan = await scanWheatPlots(bot, { origin, target: FARM_PLOT_COUNT, seeds });
    const plots = scan.field;
    if (plots.length > 0) {
      // Lock every plot the scanner returned (its whole-field penalty-free property holds for this set —
      // it verified `penaltyFree`). Falling SHORT of FARM_PLOT_COUNT is NOT a hard stop: a partial ad-hoc
      // field still feeds the fleet, and the unfilled instances simply idle — farm_manager releases an
      // instance whose center never locked. This is the one place the farm section forgoes the
      // whole-or-nothing rule every other blueprint follows, on purpose.
      // The plot's reserved box is the PAIR's reach at the rotation this plot is locked at — measured
      // off the blueprint, not written as a 2×2 around the stand. Written by hand it names the right
      // area only when the crop happens to lie in the direction the box was guessed to extend; the
      // rotation is chosen per plot from which side the water is on, so half of them reserved the bare
      // cell opposite the crop and left the crop itself open for the headframe to land on.
      const plotBuilding = require('@kernel/blueprint_registry').getBuilding(FARM_BLUEPRINT_NAME, TAG);
      plots.forEach((p, i) => {
        const roomKey = FARM_ROOM_KEYS[i];
        const bc = { x: p.stand.x, y: p.stand.y, z: p.stand.z };
        const rotation = plotRotation(p.stand, p.crop);
        const extent = footprintExtent(plotBuilding, rotation);
        const candidate = { build_center: bc, footprint: { width: extent.width, length: extent.length }, rotation, staircase: null };
        if (!anchorCenter) anchorCenter = bc;
        centers[roomKey] = bc;
        toLock.push({ spec: { blueprint: FARM_BLUEPRINT_NAME, roomKey }, candidate });
        pendingRaw.push({ roomKey, center: bc, extent });
      });
      // A mesh is reported by its REACH (rows × longest row), not just its bbox — how far the row pattern
      // runs unbroken along one bank is the useful measure of a cluster, which a bounding box cannot show.
      const cl = scan.clusters;
      const patchLine = cl ? `\n      ↳ ${cl.count} mesh(es): ` +
        cl.clusters.map(c => `${c.size} plots in ${c.rows} row(s), longest ${c.longestRow} @${c.distFromOrigin.toFixed(0)}b from bot (${c.bbox.dx}×${c.bbox.dz})`).join(', ') +
        (cl.count > 1 ? `; meshes ${cl.interClusterMinGap.toFixed(0)}–${cl.interClusterMaxGap.toFixed(0)}b apart.` : '.') : '';
      report.push(`${FARM_BLUEPRINT_NAME}: FOUND ${plots.length}/${FARM_PLOT_COUNT} plots (scan ${(scan.elapsedMs / 1000).toFixed(1)}s, seed radius ${scan.scanRadius}, ` +
        `${scan.bodiesUsed} water ${scan.bodiesUsed === 1 ? 'body' : 'bodies'}, ` +
        `${scan.penaltyFree ? 'all penalty-free' : '⚠ PENALTY PRESENT'}, ${scan.distinctStands} stands, ${scan.waterCells} water-body cells, pool ${scan.poolSize}).\n` +
        // The density line is the one to read when a field looks wrong. `density` is plots per block of the
        // cluster's own footprint — the top siting criterion, reported as a number rather than implied.
        `      ↳ lattice axis ${scan.axis}, parity ${scan.stripeParity}, stand ${scan.standDir > 0 ? '+' : '-'} (water side); ` +
        `${scan.runsUsed} run(s) of ≥${scan.minRun} from ${scan.runsAvailable} legal (${scan.plotsAvailable} plots); ` +
        `DENSITY ${scan.density} plots/block² in ${scan.clusterArea}b² (span ${scan.clusterSpan}b), ${scan.meshCount} piece(s).\n` +
        `      ↳ instance 0 stand (${anchorCenter.x},${anchorCenter.y},${anchorCenter.z}) is the base anchor.` +
        patchLine +
        (plots.length < FARM_PLOT_COUNT ? `\n      ↳ SHORT ${FARM_PLOT_COUNT - plots.length} (idle, not a stop): no_stand=${scan.noStand}, water_locked=${scan.waterLocked}, off_stripe=${scan.offStripe} (walkway, not a reject).` : ''));
    } else if (scan.loadedFrontier && scan.waterCells === 0) {
      // No water anywhere in the LOADED area and the scan hit the streaming frontier (not maxRadius) — the
      // world around spawn is likely still streaming in. Soft-retry like the old chunks_not_loaded path,
      // rather than condemn a seed whose river hasn't loaded yet.
      transient = true;
      report.push(`${FARM_BLUEPRINT_NAME}: no water in the loaded area yet (frontier at radius ${scan.scanRadius}) — retry.`);
    } else {
      // Water was seen but no hydratable, stand-paired, penalty-free plot fit — OR the whole loaded area is
      // genuinely water-less. Either way the phase-1 field has no anchor: Law 13, lock nothing (below).
      problems.push(`${FARM_BLUEPRINT_NAME}: NOT FOUND — 0 plots in ${scan.scanRadius} rings (water sources ${scan.waterCells}, candidates ${scan.candidates}, meshes ${scan.meshCount}, no_stand ${scan.noStand}, water_locked ${scan.waterLocked}).`);
      report.push(`${FARM_BLUEPRINT_NAME}: ✗ NOT FOUND — 0 plots (water ${scan.waterCells}, candidates ${scan.candidates}). The base has no anchor.`);
    }
  }

  // Without instance 0's bank there is nowhere to hang the satellites — stop (transient soft, else Law 13).
  if (!anchorCenter) {
    return finish(dryRun, report, toLock, problems, transient);
  }

  // ── 2. Satellites (headframe) — located from their anchor origin ────────────────────────────────
  // Each satellite searches from a named origin: farm instance 0 by default, or a sibling it declares via
  // `anchorFrom`. `centers` already holds every located/locked farm bank (section 1), so a satellite can
  // hang off instance 0; SATELLITES is ordered so an anchorFrom target is always surveyed first.
  for (const spec of SATELLITES) {
    const originKey    = spec.anchorFrom || FARM_ROOM_KEYS[0];
    const originCenter = centers[originKey] || anchorCenter;   // fallback: a missing origin is already a HARD STOP upstream
    const surveyOrigin = { x: originCenter.x, y: originCenter.y, z: originCenter.z };
    const originName   = originKey === FARM_ROOM_KEYS[0] ? 'farm anchor' : originKey;

    const locked = readLockedCenter(spec.roomKey);
    if (locked) {
      centers[spec.roomKey] = locked;
      const d = Math.hypot(locked.x - originCenter.x, locked.z - originCenter.z);
      report.push(`${spec.blueprint}: already locked at (${locked.x},${locked.y},${locked.z}), ${d.toFixed(1)}b from ${originName}.`);
      // No pending push — an already-locked building is in HQ, so getExistingFootprints already reserves it.
      continue;
    }
    const res = await surveyOne(bot, spec, surveyOrigin, pendingRaw);
    if (res.found) {
      // No distance cap: the ONLY building-to-building constraint is non-overlap, enforced inside locate()
      // via the MIN_BLUEPRINT_SPACING reject ring (getExistingFootprints + this pass's pendingRaw). A found
      // satellite is by construction already clear of every sibling's boundary, so it locks wherever its
      // nearest CLEAR site is — however far. The distance is reported for context only, never a gate. See
      // architect_config MIN_BLUEPRINT_SPACING for WHY a distance-spread cap was removed (it condemned a
      // whole base the world could satisfy once the overhead gate pushed the nearest clear site past the
      // ring).
      const d = res.distFromOrigin; // distance from this satellite's own anchor origin — informational
      const bc = res.candidate.build_center;
      centers[spec.roomKey] = bc;
      report.push(`${spec.blueprint}: FOUND at (${bc.x},${bc.y},${bc.z}), ${d.toFixed(1)}b from ${originName} (scan ${res.scanSecs}s).\n      ↳ WHY HERE: ${res.successSummary}`);
      toLock.push({ spec, candidate: res.candidate });
      pendingRaw.push({ roomKey: spec.roomKey, center: bc, extent: res.extent });
    } else if (res.reason === 'chunks_not_loaded') {
      transient = true;
      report.push(`${spec.blueprint}: world not loaded yet (${res.reason}) — retry.`);
    } else {
      // Prefer warnText (the RICH multi-line post-mortem with the Wall breakdown) over the one-line
      // summaryText — the surface-exhaustion path sets throwText, but the water-site 'no_viable_spot' path
      // sets only warnText+summaryText, and summaryText is a single line, so the "full post-mortem" the
      // block below promises never appeared for a farm. That hid WHETHER a missing farm was overhead-
      // blocked hillsides vs. genuinely no water — the exact question being asked.
      const detail = res.throwText || res.warnText || res.summaryText || '';
      const detailLines = detail.split('\n');
      problems.push(`${spec.blueprint}: NOT FOUND — ${res.reason}. ${detailLines[0]}`);
      // Surface the FULL post-mortem (the Wall breakdown + dominant-reason clause) in the survey, not
      // just line 1 — Law 6: the reason must be recoverable. Truncating to [0] hid whether the miss was
      // not_dirt_ground vs too_uneven vs overlaps_existing, which is the whole point of asking "why".
      const rest = detailLines.slice(1).map(l => l.trim()).filter(Boolean);
      report.push(`${spec.blueprint}: ✗ NOT FOUND (${res.reason}).` +
        (rest.length ? `\n      ${rest.join('\n      ')}` : ''));
    }
  }

  return finish(dryRun, report, toLock, problems, transient);
}

// finish — the shared judgment tail: emit the survey report, then transient-soft / Law-13 / lock-all.
function finish(dryRun, report, toLock, problems, transient) {
  watcher.summary(TAG, `Base-layout survey:\n  ${report.join('\n  ')}`);

  // Transient outranks a "problem" verdict — if the world simply isn't streamed in, the survey is not
  // trustworthy yet, so retry rather than condemn the seed.
  if (transient) {
    watcher.warn(TAG, `⚠️ Base-layout survey hit unloaded chunks — world not streamed in yet. Soft-failing for retry (not a Law 13 stop).`);
    return { ok: false, transient: true, report, locked: [] };
  }

  if (problems.length > 0) {
    throw new Error(
      `[${TAG}] LAW 13 HARD STOP — base layout cannot be locked as a whole:\n  ${problems.join('\n  ')}\n` +
      `  Full survey:\n  ${report.join('\n  ')}\n` +
      `  Nothing was locked (default-stopped: no half-placed base). Tune the offending blueprint's ` +
      `criterion or the spread gate, or relocate the bot's start, then re-run.`
    );
  }

  if (dryRun) {
    watcher.summary(TAG, `Dry run: all ${toLock.length} blueprint(s) would lock (nothing written).`);
    return { ok: true, dryRun: true, report, locked: [] };
  }

  const locked = [];
  for (const { spec, candidate } of toLock) {
    lock(candidate, spec.blueprint, spec.roomKey);
    locked.push(spec.roomKey);
  }
  watcher.summary(TAG, `✅ Base layout locked as one unit: ${locked.length ? locked.join(', ') : 'nothing new (all already locked)'}.`);
  return { ok: true, report, locked };
}

module.exports = {
  run,
  baseLayoutComplete,
  receive: watcher.track(TAG, async function (signalType, payload) {
    if (signalType !== TAG) return; // strict contract
    const signalBus = require('@kernel/signal_bus');
    const bot = global.bot;

    const result = await run(bot, { dryRun: false });

    if (result.transient) {
      routeToJudge(signalBus, TAG, {
        ...payload,
        result: 'base_layout_pending', success: false,
        readable: `${TAG}: world not loaded yet — retry base-layout lock`,
      });
      return;
    }
    routeToJudge(signalBus, TAG, {
      ...payload,
      result: 'base_layout_locked', success: true,
      lock_all_buildspots: { locked: result.locked },
      readable: `${TAG}: base layout locked (${result.locked.join(', ') || 'all already locked'}) -> recursive_judge`,
    });
  }),
};
