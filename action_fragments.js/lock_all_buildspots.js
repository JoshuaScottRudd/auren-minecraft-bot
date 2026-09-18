// fragment: lock_all_buildspots (action)
// purpose: Locate AND lock EVERY base blueprint's build site in ONE startup pass, the HARDEST-to-site
//          blueprint first as the anchor, each satellite at its NEAREST non-overlapping site from the
//          anchor — so a bad seed or a too-strict criterion surfaces EARLY, before any building is
//          attempted, instead of one blueprint at a time deep into the run. All blueprints are surveyed
//          before any Law-13 throw, so a near-miss on one can be judged against the rest of the layout.
//
// THE INVERSION: a base coheres around its hardest-to-satisfy member: water is scarce and non-negotiable,
// whereas a mine shaft and open ground are common. So the ANCHOR is the wheat farm (strictest criterion —
// sea-level water the wheat_trident_scanner must find); the headframe and tree farm are the satellites
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
//   1. Site the WHOLE phase-1 wheat field with one wheat_trident_scanner sweep of EVERY sea-level water body in
//      the loaded area — FARM_PLOT_COUNT plots as tines built out from the bank, longest first, mutually
//      PENALTY-FREE, each tine's bank block reachable on foot. The scanner (not find_buildingspot) sites this
//      field because its penalty-free guarantee is cross-plot; each tine ROW locks as one wheat_tine_row
//      instance, in anchor order. Instance 0's stand (the first tine's bank block) is the base anchor.
//   2. Locate each non-farm satellite (headframe) from farm instance 0's stand (uncapped ring, nearest-first,
//      via find_buildingspot), clear of every sibling's MIN_BLUEPRINT_SPACING reject ring — the field's plot
//      footprints included, so the headframe never lands on a plot.
//   3. Judge the WHOLE layout at once: a satellite that finds no valid site, or the field finding ZERO plots,
//      is the failure. A field SHORT of FARM_PLOT_COUNT is NOT a failure — a partial ad-hoc field still feeds
//      the fleet; the unfilled instances idle (the one place the batch forgoes whole-or-nothing, on purpose).
//   4. All found → return them as the site (the foreman's hub writes them). A genuine miss → Law 13, NOTHING returned.
//      A transient (world still streaming: no water in the loaded area yet) soft-fails for a retry.
//
// IT ONLY SURVEYS, AND THE FOREMAN IS ITS ONE CALLER (2026-09-18). The desk surveys before any body exists
// and its hub writes the answer (`foreman_hub.lockSite`); a body never runs this and never writes a site
// (*"Bots can't set their own points now"*).
//
// NO NAVIGATION HERE (2026-09-11). A walk-and-rescan lived here for one afternoon and was ruled out: *"water
// biome only, bank only, cluster only. that way it can find what it needs the first time instead of walk anc
// check again… id rather the walk be farther because it will setup its base there."* The survey waits for
// the loaded area to arrive, reads it once, and locks the biggest sea-level water clusters in it wherever
// they are; the crew walks there to build, which is the only walk a base needs. The desk says where in chat
// before the crew is fetched. This fragment joins no build pathway. Reuses the extracted engines:
// wheat_trident_scanner (field siting) + find_buildingspot.locate (satellite siting) — Law 16, one siter per
// field. The commit is the hub's (`site_chairs` builds the rows it writes).

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { locate, loadBlueprintDims, getExistingFootprints, footprintBox } = require('@action/find_buildingspot');
const { footprintExtent } = require('@perception/blueprint_survey');   // a plot's reach at its own rotation
const { plotRotation, loadedAreaSettled, settleLine, SETTLE_MAX_MS } = require('@utils/wheat_plot_scanner');
const { scanWheatTrident, describeTrident } = require('@utils/wheat_trident_scanner');
const { MIN_BLUEPRINT_SPACING, FARM_BLUEPRINT_NAME, FARM_PLOT_COUNT, FARM_ROOM_KEYS,
        BOT_MODES } = require('@thinking/architect_config');

const TAG = 'lock_all_buildspots';

// The wait for the loaded area to arrive (loadedAreaSettled) and its report line live in wheat_plot_scanner;
// the field's own report is describeTrident, beside the scan it describes.

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
// The wheat farm is sited by the wheat_trident_scanner, NOT a find_buildingspot water-site sweep. The
// scanner computes the WHOLE phase-1 field — FARM_PLOT_COUNT plots as tine rows — in one penalty-free
// sweep from the body, because the field's penalty-free guarantee is cross-plot and cannot be expressed as
// independent per-instance siting. It is the ONE siter for this field (Law 16): find_buildingspot's local
// per-spot fit knows neither the hydration rule nor the penalty graph, so it must not also site these.
// Each row locks as one wheat_tine_row instance (build_center = the row's stand, rotation aims the row
// outward); instance 0's stand is the headframe's placement reference. See THE INVERSION note for WHY the
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

// ── A CALLER WITH NO HQ TO READ, AND WHY THAT IS A DECLARATION RATHER THAN A FALLBACK ───────────────
// (Architect 2026-09-12, moving the siting decision to the desk.)
//
// THE BOUNDARY IS REAL AND IT IS NOT A BUG. The building conference room is keyed `<structure>|<owner>`,
// and `hq.readBuildingChair` supplies the owner half from THE CALLING PROCESS'S OWN MANDATE
// (`bot_mandate.buildingRoomKey`). The foreman has no mandate — it is a desk, not a bot, and
// `bot_mandate` throws rather than defaulting, correctly. So the desk can survey the WORLD (it has a body
// and a chunk view) but it cannot read what is already LOCKED (that is owner-scoped memory it has no
// identity in).
//
// SO THE DESK SAYS SO, and `unlockedWorld` is that sentence. It means: *survey as if nothing is placed
// yet.* It is a declaration by the caller, never inferred from a failed read — a silent fallback here
// would let a mandate bug in a real body look like an empty base and re-site a base that already exists.
//
// WHAT IT COSTS, STATED PLAINLY (Law 25). On a world that already holds buildings, the desk's dry run
// cannot see them, so it can approve a site that overlaps one. The authoritative check is unchanged and
// still runs: the BODY re-surveys from beside the same person WITH its HQ, and refuses there. The desk's
// gate is therefore early-and-usually-right rather than final, which is exactly what a door is for — it
// stops the common failure (no water, a peak, a cave) before two player slots are spent.

// readLockedCenter — a blueprint's already-locked build_center, or null. Lets the batch be idempotent:
// a re-run skips whatever is already locked and only fills the gaps. `unlocked` is the declaration above.
function readLockedCenter(roomKey, unlocked = false) {
  if (unlocked) return null;
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
  // A builder's hub is the headframe; its blueprint site joins this answer when builder siting is written.
  if (require('@kernel/bot_mandate').isBuilder()) return !!readLockedCenter('headframe');
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
async function runContractorLayout(bot, dryRun, unlocked, surveyFrom) {
  const spec = SATELLITES.find(s => s.roomKey === CONTRACTOR_ROOM_KEY);
  if (!spec) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): SATELLITES declares no '${CONTRACTOR_ROOM_KEY}' row, so a `
      + 'contractor has no criteria to site its own house with. The row is the shared definition of that building.');
  }

  const report = [];
  if (readLockedCenter(spec.roomKey, unlocked)) {
    const c = readLockedCenter(spec.roomKey, unlocked);
    report.push(`${spec.blueprint}: already locked at (${c.x},${c.y},${c.z}) — nothing to site.`);
    return finish(dryRun, report, [], [], false);
  }

  const origin = surveyOrigin(bot, surveyFrom);
  const res = await surveyOne(bot, spec, origin, [], unlocked);

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
async function surveyOne(bot, spec, origin, pendingRaw, unlocked) {
  const { building, dims } = loadBlueprintDims(spec.blueprint);
  // locked-in-HQ buildings, padded by this clearance — empty for a caller with no HQ to read, which it
  // has DECLARED (see `readLockedCenter`); the pending set below still keeps this pass's siblings apart.
  const existing = unlocked ? [] : getExistingFootprints(spec.clearance);
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

// run(bot, { dryRun: true, species }) — the batch core, and THE ONE SITER for a base (Law 16). Surveys all
// blueprints and judges the whole layout; it writes nothing.
// Returns { ok, report:[lines], site:[rows], anchor } · { ok:false, problems:[...] } when the ground cannot
// hold the layout · { ok:false, transient:true } when the world is not streamed in yet.
//
// ONE DECIDING CALLER — THE FOREMAN, BEFORE IT SPAWNS ANYBODY (Architect 2026-09-12, finished 2026-09-18).
// It asks *can a base be raised here*, refuses to launch when the answer is no (*"if foreman cant set the
// blueprints then it refuses to spawn the bots and explains that it cant"*), and otherwise hands `site` to
// every body it launches. The body used to run this same survey again and lock its own answer; now it
// records the desk's (*"its no longer a job any bots do… so the bots come in and get straight to work"*).
// `surveylayout` and a bot's `test_locklayout` also call it, and both only look.
//
// `species` IS PASSED RATHER THAN SENSED, for the desk's sake. The body branch below read
// `bot_mandate.isContractor()` — its own constitution — which is exactly right for a body and impossible
// for the desk: the foreman has no mandate (it is not a bot), and the species it needs a layout for is the
// one the person just asked for, not one it could look up about itself. So the caller states it, and a
// body states its own by asking its mandate (Invariant B — the body still re-senses, it just does it at
// the call site).
// surveyOrigin(bot, surveyFrom) — the cell every search in this pass walks outward from.
//
// THE SURVEYING BODY AND THE SURVEY ORIGIN ARE NOT THE SAME THING, and welding them was a real defect.
// The desk runs this pass dry to answer "can a base go where this PERSON stands", and it answers from its
// own post — which the server drops at world spawn, inside the spawn-protected square. Every cell in that
// square reads as bedrock (`spawn_protection.maskWorldReads`), so a route search starting there starts
// inside solid rock and gives up at step one: on 2026-09-15 that refused all 677 candidate tines and the
// desk raised no crew at all, while the person it was surveying for stood 50b clear on open ground.
//
// So the caller may name the origin, and the desk names the person's feet — which is what the `get` gate's
// own comments have always claimed the survey does, and what makes the desk's answer and the body's answer
// the same answer (Law 16): the crew is spawned beside that person and re-runs this pass from that cell.
// The default stays the body's own position, which is right for every caller that IS the body.
function surveyOrigin(bot, surveyFrom) {
  const at = surveyFrom || bot.entity.position;
  return { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
}

async function run(bot, opts = {}) {
  // THE SURVEY ONLY LOOKS (2026-09-18). Its locking tail had one caller — the body's own `lock_base_layout`
  // job — and that job is deleted: the foreman sites the base before any body exists and its hub writes the
  // answer (`foreman_hub.lockSite`). A caller still asking this to lock is wired for the old shape, and is refused
  // loudly rather than quietly handed a survey it thinks was committed.
  if (opts.dryRun !== true) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): run() surveys and never locks — pass { dryRun: true }. `
      + "A base is locked only by the foreman's hub (foreman_hub.lockSite), with the rows this survey returns.");
  }
  const dryRun = true;
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: run() needs a body with a position. The bot must be registered before the batch runs.`);
  }
  const species = opts.species || require('@kernel/bot_mandate').currentMode();
  // CARRIED AS AN ARGUMENT, NOT A MODULE FLAG. A flag would be process state two callers share, and the
  // one that forgot to clear it would silently blind a body to its own HQ (Law 8 — nothing outlives its
  // owner; here the owner is this one call). `origin` rides the same way and for the same reason.
  return _run(bot, { dryRun, species, unlocked: !!opts.unlockedWorld, surveyFrom: opts.origin || null });
}

async function _run(bot, { dryRun, species, unlocked, surveyFrom }) {

  // TWO SPECIES, TWO LAYOUTS, ONE JOB. The branch is at the top rather than woven through the sections
  // below because a contractor is not doing a reduced version of this pass — it sites no farm, hangs off
  // no headframe and has no whole-base non-overlap picture to hold. Running it through the estate path
  // with the farm skipped would leave it hunting a water body it has no use for over a building that
  // needs flat ground.
  if (species === BOT_MODES.CONTRACTOR) {
    return runContractorLayout(bot, dryRun, unlocked, surveyFrom);
  }
  // A BUILDER'S LAYOUT IS NOT THIS SURVEY. Its base is one downloaded blueprint with the headframe beside it
  // and stone near both (§29.4) — no water, no farm anchor — and it is sited by the foreman from a build plan.
  // Running it through the estate path below would hunt a shoreline for a farm the species never plants.
  // Refused rather than approximated until the builder's own siting is written (scratchpad §29.13, item 2).
  if (species === BOT_MODES.BUILDER) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): a builder's base is sited from its build plan by the foreman, `
      + 'and that siting is not written yet. This survey is the homestead\'s and the contractor\'s, and would site a '
      + 'wheat farm for a species that has none.');
  }

  const report = [];
  const toLock = [];          // { spec, candidate } surveyed-and-passing, not yet locked
  const pendingRaw = [];      // { roomKey, center, extent } this-pass reservations for overlap avoidance
  const problems = [];        // human strings — any non-empty ⇒ Law 13, lock nothing
  let transient = false;      // any chunks_not_loaded ⇒ soft-retry, not a hard stop

  // ── 1. Wheat farm — the wheat_trident_scanner sites the WHOLE phase-1 field in ONE penalty-free sweep ──
  // The field's penalty-free guarantee is CROSS-plot (a crop's growth depends on the whole chosen set), so
  // it cannot be sited one instance at a time the way a self-contained structure can be — the scanner
  // computes all FARM_PLOT_COUNT plots together, from where the body stands. Each returned build step (stand
  // on A(k), place A(k+1) and its two plots) locks as one wheat_tine_row instance: build_center = the stand
  // A(k), rotation aims the blueprint's +x at A(k+1), footprint measured off the blueprint at that rotation (so
  // the headframe keeps clear of it). Tines in order, rows outward, so instance order is anchor order.
  // Idempotent on the WHOLE field: if instance 0 is already locked the field is sited —
  // repopulate `centers` from the chairs and skip the scan (finish() would otherwise re-lock and Law-13 throw).
  const centers = {};              // roomKey → build_center, for satellites to hang off
  let anchorCenter = null;         // farm instance 0's stand (the headframe's reference)
  if (readLockedCenter(FARM_ROOM_KEYS[0], unlocked)) {
    for (const key of FARM_ROOM_KEYS) { const locked = readLockedCenter(key, unlocked); if (locked) centers[key] = locked; }
    anchorCenter = centers[FARM_ROOM_KEYS[0]];
    report.push(`${FARM_BLUEPRINT_NAME}: phase-1 field already locked (${Object.keys(centers).length}/${FARM_ROOM_KEYS.length} rows) — skipping scan.`);
  } else {
    const origin = surveyOrigin(bot, surveyFrom);
    // The scan reads every sea-level water body in the loaded area and walks outward from `origin` — and it
    // waits for that area to arrive first, because it reads it exactly once. The route check starts from the
    // same cell, so a tine the survey accepts is a tine the surveying body could actually walk to.
    const settled = await loadedAreaSettled(bot);
    report.push(settleLine(settled));
    const scan = await scanWheatTrident(bot, { origin, target: FARM_PLOT_COUNT });
    const rows = scan.tines.flatMap(t => t.steps);
    if (rows.length > 0) {
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
      // ONE GEOMETRY FOR EVERY PLOT, because the farm plane is pinned to seaY and a stand is therefore always
      // level with its crop — which is the offset the fixed blueprint already carries. (A three-geometry
      // split existed for a few hours on 2026-09-11, for a tuple allowed to straddle a bank's step; it went
      // with the step. The scanner's header holds why.)
      const plotBuilding = require('@kernel/blueprint_registry').getBuilding(FARM_BLUEPRINT_NAME, TAG);
      if (rows.length > FARM_ROOM_KEYS.length) {
        throw new Error(`[${TAG}] CODING VIOLATION: the trident scan returned ${rows.length} rows for ${FARM_ROOM_KEYS.length} room keys — it was asked for FARM_PLOT_COUNT plots, which is exactly that many rows.`);
      }
      rows.forEach((row, i) => {
        const roomKey = FARM_ROOM_KEYS[i];
        const bc = { x: row.stand.x, y: row.stand.y, z: row.stand.z };
        const rotation = plotRotation(row.stand, row.place[0]);
        const extent = footprintExtent(plotBuilding, rotation);
        const candidate = { build_center: bc, footprint: { width: extent.width, length: extent.length }, rotation, staircase: null };
        if (!anchorCenter) anchorCenter = bc;
        centers[roomKey] = bc;
        toLock.push({ spec: { blueprint: FARM_BLUEPRINT_NAME, roomKey }, candidate });
        pendingRaw.push({ roomKey, center: bc, extent });
      });
      report.push(describeTrident(scan) +
        `\n      ↳ instance 0 stand (${anchorCenter.x},${anchorCenter.y},${anchorCenter.z}) is the base anchor.`);
    } else if (!settled.settled) {
      // THE WORLD WAS STILL ARRIVING WHEN IT WAS READ, so finding nothing is not yet evidence that nothing is
      // there (Invariant B): soft-retry. Run seven is why — 23 water cells at 0m 7s, 67 of the same lake 26 s
      // later. Once the loaded area has stopped growing, an empty answer is the world's answer.
      transient = true;
      report.push(describeTrident(scan),
        `${FARM_BLUEPRINT_NAME}: no plot yet, and the loaded area had not all arrived by the ${SETTLE_MAX_MS / 1000}s cap — retry.`);
    } else {
      // THE WHOLE LOADED AREA WAS READ AND NO SEA-LEVEL WATER BANK IN IT HOLDS A PLOT. Law 13, lock nothing,
      // and say it in words the person can act on — the 2026-09-10 ruling: refuse, and tell the human there
      // is nowhere to build.
      problems.push(`${FARM_BLUEPRINT_NAME}: NOT FOUND — no sea-level water within view holds a tine reachable from here ` +
        `(${scan.bodiesFound} water ${scan.bodiesFound === 1 ? 'body' : 'bodies'}, ${scan.openWaterCells} open water cells, ` +
        `${scan.candidates} tine starts, ${scan.skippedNoRoute.length} with no walking route to their bank block). ` +
        `Stand within sight of a river, lake or the sea at sea level and ask for a crew again.`);
      report.push(describeTrident(scan),
        `${FARM_BLUEPRINT_NAME}: ✗ NOT FOUND — no sea-level water in view holds a tine. The base has no anchor.`);
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

    const locked = readLockedCenter(spec.roomKey, unlocked);
    if (locked) {
      centers[spec.roomKey] = locked;
      const d = Math.hypot(locked.x - originCenter.x, locked.z - originCenter.z);
      report.push(`${spec.blueprint}: already locked at (${locked.x},${locked.y},${locked.z}), ${d.toFixed(1)}b from ${originName}.`);
      // No pending push — an already-locked building is in HQ, so getExistingFootprints already reserves it.
      continue;
    }
    const res = await surveyOne(bot, spec, surveyOrigin, pendingRaw, unlocked);
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

// siteRow — one surveyed-and-passing structure as the desk hands it to a body: the plain room name (the
// owner half is the body's own), the blueprint, and the four candidate fields `lock` writes.
function siteRow({ spec, candidate }) {
  const bc = candidate.build_center;
  return {
    blueprint: spec.blueprint,
    roomKey: spec.roomKey,
    candidate: {
      build_center: { x: bc.x, y: bc.y, z: bc.z },
      footprint: candidate.footprint || null,
      staircase: candidate.staircase || null,
      rotation: candidate.rotation ?? 0,
    },
  };
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

  // ── GROUND THAT CANNOT HOLD THE LAYOUT IS A VERDICT, NOT A THROW (Architect 2026-09-12) ───────────
  // This was a Law 13 HARD STOP until today, and every cause it listed was the WORLD: no hydratable
  // shoreline in the loaded area, no flat ground for the headframe, a seed with nothing this fleet can
  // settle on. Its own remedy admitted it — *"or relocate the bot's start"* — which is a thing about the
  // place, not about the code. Under the amended reading of Law 13 (*"a true coding violation. meaning i
  // coded something wrong or a setting is wrong"*) that makes it environmental.
  //
  // AND THE FOREMAN IS WHY IT MATTERS NOW. The desk calls this with `dryRun` BEFORE it spawns anybody, so
  // this branch is the normal answer for a person standing somewhere unsuitable — it has to be a sentence
  // the desk can read and pass on, not an exception that kills whoever asked. Default-stopped is
  // unchanged and is the point: nothing is locked, so there is never a half-placed base.
  if (problems.length > 0) {
    watcher.warn(TAG, `Base layout cannot be placed here:\n  ${problems.join('\n  ')}\n  Nothing was locked.`);
    return { ok: false, problems, report, locked: [] };
  }

  // WHERE THE BASE WILL SIT, returned rather than only logged — the foreman tells the person before it
  // spawns anybody (*"once it does then it tells the human where the homebase will be"*), and it can only
  // do that from a dry run, which by definition has written nothing to read back. The seat is the
  // headframe for a homestead and the house for a contractor: the one building a person would point at
  // and call the base. `anchorOf` is used by both branches below so the locking path reports the same
  // cell the desk promised.
  const anchorOf = (rows) => {
    const seat = rows.find(t => t.spec.roomKey === 'headframe') || rows.find(t => t.spec.roomKey === CONTRACTOR_ROOM_KEY) || rows[0];
    const c = seat && seat.candidate && seat.candidate.build_center;
    return c ? { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) } : null;
  };

  // THE SITE ITSELF, returned so the desk's hub can WRITE IT (Architect 2026-09-18: *"Bots can't set their own
  // points now"*). Each row carries exactly the fields `site_chairs.siteChairs` reads, and nothing the survey
  // computed on the way.
  watcher.summary(TAG, `Survey: all ${toLock.length} blueprint(s) would lock (nothing written here — the foreman's hub writes the site).`);
  return { ok: true, dryRun: true, report, locked: [], anchor: anchorOf(toLock), site: toLock.map(siteRow) };
}

module.exports = {
  run,
  baseLayoutComplete,
};
