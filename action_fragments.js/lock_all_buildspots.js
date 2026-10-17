// fragment: lock_all_buildspots (action)
// Locates and locks every base blueprint's build site in one startup pass: the hardest-to-site
// blueprint (wheat farm — sea-level water) anchors the layout; each satellite (headframe, etc.) sites
// nearest to the anchor with no overlap. All blueprints are surveyed before any Law-13 throw, so a miss
// on one is judged against the whole layout, early, before any blueprint is deep into a run.
//
//   1. wheat_trident_scanner sites the whole phase-1 field in one penalty-free sweep — FARM_PLOT_COUNT
//      plots as tine rows. Instance 0's stand anchors the base.
//   2. Each satellite locates from the anchor via find_buildingspot, clear of every sibling's
//      MIN_BLUEPRINT_SPACING reject ring. A field short of FARM_PLOT_COUNT is not a failure.
//   3. All found → returned as the site for the foreman's hub to write (Law 13 otherwise; a transient
//      soft-fails for retry).
//
// Surveys only — the foreman is its one caller and its hub writes the locked site (Law 16).

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { locate, loadBlueprintDims, getExistingFootprints, footprintBox } = require('@action/find_buildingspot');
const { footprintExtent } = require('@perception/blueprint_survey');   // a plot's reach, measured off the blueprint
const { loadedAreaSettled, settleLine, SETTLE_MAX_MS } = require('@utils/wheat_plot_scanner');
const { scanWheatTrident, describeTrident } = require('@utils/wheat_trident_scanner');
const { FARM_BLUEPRINT_NAME, FARM_PLOT_COUNT, FARM_ROOM_KEYS, FARM_ROW_BLUEPRINTS,
        BOT_MODES, BUILDER_BUILDS, ALPHA_STRUCTURE, SHAFT_HEAD, YARD_SITING, SHAFT_SITING,
        WASTE_PIT, WASTE_PIT_SITING } = require('@thinking/architect_config');

// Minimum gap kept between two sited blueprints, so a lock never lands on its neighbour. No cap on
// distance from the anchor — only non-overlap gates a satellite's site.
const MIN_BLUEPRINT_SPACING = 8;
const { STAIRCASE_SAFETY } = require('@utils/building_site_overlays');

const TAG = 'lock_all_buildspots';

// The wait for the loaded area (loadedAreaSettled) and its report line live in wheat_plot_scanner; the
// field's own report is describeTrident.

// The canonical base-layout sequence — Law 16, the one locator. Each satellite locates from the
// anchor's center; clearance is the MIN_BLUEPRINT_SPACING gap every blueprint keeps from the others.
// requireDirtGround gates onto plantable soil; requireShaft gates onto a shaft-siting need. The wheat
// farm sites via wheat_trident_scanner instead (Law 16, one siter for the field): its penalty-free
// guarantee is cross-plot, computed together as wheat_tine_row instances, instance 0's stand the
// headframe's placement reference. Satellites fit around the farm cluster, each from a named origin.
const SATELLITES = [
  { blueprint: 'headframe', roomKey: 'headframe',
    requireShaft: true, requireDirtGround: false,
    clearance: MIN_BLUEPRINT_SPACING, anchorFrom: FARM_ROOM_KEYS[0] },
  // The contractor's house is sited here, not by a siter of its own: locate() is fed both the
  // already-locked buildings and this pass's pending ones, so a claimed site is never a candidate.
  // Anchored on the headframe (must stay below its row), not the farm bank — a human arrives at the
  // base, not the waterline. Needs flat clear ground only.
  { blueprint: 'contractor_house', roomKey: 'contractor_house',
    requireShaft: false, requireDirtGround: false,
    clearance: MIN_BLUEPRINT_SPACING, anchorFrom: 'headframe' },
];

// Named once for the three callers that reach for this row, so it cannot be misspelled into a silently
// empty search in one of them (Law 7).
const CONTRACTOR_ROOM_KEY = 'contractor_house';

// ── A CALLER WITH NO HQ TO READ ──────────────────────────────────────────────────────────
// The foreman has no mandate, so it cannot read what is already locked (owner-scoped memory).
// `unlockedWorld` is the caller's declaration to survey as if nothing is placed yet — never inferred
// from a failed read. The body still re-surveys WITH its HQ and refuses there on any overlap (Law 25).

// readLockedCenter — a blueprint's already-locked transpose_origin, or null. `unlocked` is the
// declaration above; a re-run skips whatever is already locked and only fills the gaps.
function readLockedCenter(roomKey, unlocked = false) {
  if (unlocked) return null;
  const spot = hq.readBuildingChair(roomKey, 'set_buildspot');
  return (spot?.transpose_origin && typeof spot.transpose_origin.x === 'number') ? spot.transpose_origin : null;
}

// baseLayoutComplete — the one definition of "nothing left to lock" (Law 16), exported so job_board's
// trigger gate asks the performer instead of re-deriving its criterion. Complete once instance 0 is
// locked (a short field is a legitimate end state) and every satellite carries a center.
function baseLayoutComplete() {
  // A contractor's layout is one building, asked of the mandate, not the world — a shared criterion
  // would have it report incomplete forever over a farm it will never site (Law 27).
  if (require('@kernel/bot_mandate').isContractor()) return !!readLockedCenter(CONTRACTOR_ROOM_KEY);
  // A builder's layout is its downloaded building, its alpha structure (the laydown yard), the waste pit and the mineshaft.
  if (require('@kernel/bot_mandate').isBuilder()) {
    return !!readLockedCenter(require('../foreman_config').builder.build) && !!readLockedCenter(ALPHA_STRUCTURE[BOT_MODES.BUILDER])
      && !!readLockedCenter(WASTE_PIT.structure) && !!readLockedCenter(SHAFT_HEAD[BOT_MODES.BUILDER]);
  }
  if (!readLockedCenter(FARM_ROOM_KEYS[0])) return false;
  return SATELLITES.every(s => !!readLockedCenter(s.roomKey));
}

// ── THE CONTRACTOR'S LAYOUT — ONE BUILDING, SITED FROM WHERE THE BODY STANDS ─────────────────────
// A contractor has no headframe and was fetched by a person standing wherever they chose
// (`report_to_owner` already placed the body there), so the search starts from the body. Reads the same
// SATELLITES row a homesteader's house uses (Law 16); only the origin differs.
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
    const bc = res.candidate.transpose_origin;
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

// ── THE BUILDER'S BASE: THE CASTLE, ITS LAYDOWN YARD, ITS MINESHAFT ──────────────────────────────
// Three buildings, castle first because it is hardest to place:
//   1. THE CASTLE — surveyFootprint over the whole loaded area, tightest tolerance first up to the
//      build's maxTolerance (architect_config.BUILDER_BUILDS), nearest to level within the first
//      passing tier. A plot passes only with no water, lava or unloaded ground in its pit or shell.
//   2. THE YARD — siteBeside over the same surface read: nearest spot yardGap+ from the castle,
//      floor within ±rise of its ground floor, within scrape_max/fill_max of it. yardGap keeps the
//      yard outside the castle's ring — the strip round the pit that bodies cut their stairs down
//      through — and never under YARD_SITING.min_gap. A site YARD_SITING.alert_gap+ away raises a
//      YARD ALERT warning.
//   3. THE MINESHAFT — standalone (siteShaft below): nearest mouth whose whole diagonal keeps
//      SHAFT_SITING.min_gap from both and passes the headframe's own descent hazard walk.
// A castle already locked in memory is kept.
async function runBuilderLayout(bot, dryRun, unlocked, surveyFrom, build) {
  // Which building is the caller's to say — the foreman reads it from foreman_config.builder.build and
  // has already refused an unknown name. Asked for none or an unknown one, nothing is guessed (Law 13).
  const bp = BUILDER_BUILDS[build];
  if (!bp) {
    throw new Error(`[${TAG}] CODING VIOLATION: a builder layout needs a known build — got '${build}'. `
      + `Known: ${Object.keys(BUILDER_BUILDS).join(', ')} (architect_config.BUILDER_BUILDS).`);
  }
  const report = [];
  const castleKey = bp.name;
  let castle = null;       // { center, extent, row }
  const locked = readLockedCenter(castleKey, unlocked);
  if (locked) {
    report.push(`${castleKey}: already locked at (${locked.x},${locked.y},${locked.z}) — kept.`);
    castle = { center: locked, extent: null };
  } else {
    const t0 = Date.now();
    const survey = await require('@utils/footprint_survey').surveyFootprint(bot, { w: bp.w, l: bp.l, below: bp.below, ring: bp.ring });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const tiers = survey.byTolerance.filter(t => t.tolerance <= bp.maxTolerance);
    const tier = tiers.find(t => t.passingPlots > 0);
    const tally = tiers.map(t => `±${t.tolerance}: ${t.passingPlots}/${t.plots} plot(s) pass`).join(' · ');
    if (!tier) {
      const r = survey.refused;
      report.push(`${castleKey}: ✗ NOT FOUND over ${survey.positions} position(s) in ${secs}s — ${tally}. Refused on the surface: `
        + `${r.unloaded_or_lava} unloaded or lava, ${r.water_in_footprint} water in the footprint, ${r.ring_not_land} ring not land.`);
      return finish(dryRun, report, [], [`${castleKey}: NOT FOUND — no ${bp.w}x${bp.l} plot in the loaded area is level to ±${bp.maxTolerance} with a dry pit (${tally}).`], false);
    }
    const s = tier.picks.find(p => p.passes);
    const center = { x: s.centre.x, y: s.h, z: s.centre.z };
    const extent = {
      min_dx: s.corner.x - bp.ring - center.x, max_dx: s.corner.x + s.fw - 1 + bp.ring - center.x,
      min_dz: s.corner.z - bp.ring - center.z, max_dz: s.corner.z + s.fl - 1 + bp.ring - center.z,
    };
    const candidate = {
      transpose_origin: center, staircase: null,
      footprint: { width: s.fw, length: s.fl, corner: s.corner, ground_floor_y: s.h, pit_bottom_y: s.bottom },
    };
    castle = { center, extent, footprint: candidate.footprint, surface: survey.surface,
      row: { spec: { blueprint: castleKey, roomKey: castleKey, total_voxels: bp.blocks }, candidate } };
    report.push(`${castleKey}: FOUND at (${center.x},${center.y},${center.z}) — ${s.fw}x${s.fl} from corner (${s.corner.x},${s.corner.z}), `
      + `ground floor y${s.h}, level to ±${tier.tolerance}, off-level ${s.offLevel}, pit ${s.dug} blocks dug (${s.stone} stone, ${s.dirt} dirt), `
      + `${s.caveAir} cave air; biome ${s.biome} (${Math.round(s.biomeShare * 100)}%). Survey ${secs}s, ${tally}.`);
  }

  // ── THE YARD, THEN THE MINESHAFT — each kept its own min_gap from everything sited before it ──
  const yardKey = ALPHA_STRUCTURE[BOT_MODES.BUILDER];
  const shaftKey = SHAFT_HEAD[BOT_MODES.BUILDER];
  const toLock = castle.row ? [castle.row] : [];
  // The castle's footprint and ground floor: from this pass's survey, or from the chair a resumed crew kept.
  const fp = castle.footprint || hq.readBuildingChair(castleKey, 'set_buildspot')?.footprint || null;
  if (!fp || !fp.corner || !Number.isInteger(fp.width) || !Number.isInteger(fp.ground_floor_y)) {
    return finish(dryRun, report, [], [`${yardKey}: cannot be sited — ${castleKey}'s footprint is not known (its site chair carries none).`], false);
  }
  const castleBox = { minX: fp.corner.x, maxX: fp.corner.x + fp.width - 1, minZ: fp.corner.z, maxZ: fp.corner.z + fp.length - 1 };
  const survey = require('@utils/footprint_survey');
  let surface = castle.surface || null;
  const surfaceOnce = async () => (surface = surface || await survey.readSurface(bot));
  const { building: yardBuilding } = loadBlueprintDims(yardKey);
  const yardExtent = footprintExtent(yardBuilding, 0);

  let yardBox = null;
  let yardFloor = null;
  const yardGap = Math.max(YARD_SITING.min_gap, bp.ring + 1);
  const yardLocked = readLockedCenter(yardKey, unlocked);
  if (yardLocked) {
    report.push(`${yardKey}: already locked at (${yardLocked.x},${yardLocked.y},${yardLocked.z}) — kept.`);
    yardBox = footprintBox(yardLocked.x, yardLocked.z, yardExtent, 0, yardKey);
    yardFloor = yardLocked.y;
  } else {
    const yard = await survey.siteBeside(await surfaceOnce(), {
      extent: yardExtent, avoid: castleBox, groundY: fp.ground_floor_y,
      minGap: yardGap, rise: YARD_SITING.rise, scrapeMax: YARD_SITING.scrape_max, fillMax: YARD_SITING.fill_max,
      searchTo: YARD_SITING.search_to,
    });
    if (!yard.found) {
      const r = yard.refused;
      report.push(`${yardKey}: ✗ NOT FOUND within ${yardGap}-${YARD_SITING.search_to} blocks of ${castleKey} over ${yard.candidates} position(s) — `
        + `refused: ${r.not_land} not land, ${r.trunk} on a tree trunk, ${r.too_uneven} more than ${YARD_SITING.scrape_max} over or ${YARD_SITING.fill_max} under a floor within ±${YARD_SITING.rise} of y${fp.ground_floor_y}.`);
      return finish(dryRun, report, [], [`${yardKey}: NOT FOUND beside ${castleKey} — no level, dry spot ${yardGap}+ blocks from its footprint.`], false);
    }
    report.push(`${yardKey}: FOUND at (${yard.center.x},${yard.center.y},${yard.center.z}), ${yard.gap} blocks from ${castleKey}'s footprint, `
      + `floor y${yard.floor} (castle ground y${fp.ground_floor_y}), ${yard.scrape} block(s) to cut and ${yard.fill} to fill.`);
    if (yard.gap >= YARD_SITING.alert_gap) {
      watcher.warn(TAG, `YARD ALERT: ${yardKey} sited ${yard.gap} blocks from ${castleKey}'s outer edge (alert at ${YARD_SITING.alert_gap}+, `
        + `nearest allowed ${yardGap}) at (${yard.center.x},${yard.center.y},${yard.center.z}) — no nearer spot was land, trunk-free and level `
        + `(refused nearer: ${yard.refused.not_land} not land, ${yard.refused.trunk} on a trunk, ${yard.refused.too_uneven} too uneven).`);
    }
    toLock.push({ spec: { blueprint: yardKey, roomKey: yardKey }, candidate: { transpose_origin: yard.center, staircase: null, footprint: null } });
    yardBox = footprintBox(yard.center.x, yard.center.z, yardExtent, 0, yardKey);
    yardFloor = yard.center.y;
  }

  // ── THE WASTE PIT — beside the yard, level with it, outside the castle's ring ──
  const pitKey = WASTE_PIT.structure;
  const pitExtent = footprintExtent(loadBlueprintDims(pitKey).building, 0);
  let pitBox = null;
  const pitLocked = readLockedCenter(pitKey, unlocked);
  if (pitLocked) {
    report.push(`${pitKey}: already locked at (${pitLocked.x},${pitLocked.y},${pitLocked.z}) — kept.`);
    pitBox = footprintBox(pitLocked.x, pitLocked.z, pitExtent, 0, pitKey);
  } else {
    const pit = await survey.siteBeside(await surfaceOnce(), {
      extent: pitExtent, avoid: yardBox, groundY: yardFloor,
      minGap: WASTE_PIT_SITING.min_gap, rise: WASTE_PIT_SITING.rise, scrapeMax: WASTE_PIT_SITING.scrape_max,
      fillMax: WASTE_PIT_SITING.fill_max, searchTo: WASTE_PIT_SITING.search_to,
      clearOf: [{ box: castleBox, gap: bp.ring + 1 }],
    });
    if (!pit.found) {
      const r = pit.refused;
      report.push(`${pitKey}: ✗ NOT FOUND within ${WASTE_PIT_SITING.min_gap}-${WASTE_PIT_SITING.search_to} blocks of ${yardKey} over ${pit.candidates} position(s) — `
        + `refused: ${r.not_land} not land, ${r.trunk} on a tree trunk, ${r.too_uneven} more than ${WASTE_PIT_SITING.scrape_max} over or ${WASTE_PIT_SITING.fill_max} under a floor within ±${WASTE_PIT_SITING.rise} of y${yardFloor}.`);
      return finish(dryRun, report, [], [`${pitKey}: NOT FOUND beside ${yardKey} — no level, dry spot for its pad ${WASTE_PIT_SITING.min_gap}+ blocks from its footprint and outside ${castleKey}'s ring.`], false);
    }
    report.push(`${pitKey}: FOUND at (${pit.center.x},${pit.center.y},${pit.center.z}), ${pit.gap} blocks from ${yardKey}'s footprint, `
      + `pad y${pit.floor} (yard floor y${yardFloor}), ${pit.scrape} block(s) to cut and ${pit.fill} to fill.`);
    toLock.push({ spec: { blueprint: pitKey, roomKey: pitKey }, candidate: { transpose_origin: pit.center, staircase: null, footprint: null } });
    pitBox = footprintBox(pit.center.x, pit.center.z, pitExtent, 0, pitKey);
  }

  const shaftLocked = readLockedCenter(shaftKey, unlocked);
  if (shaftLocked) {
    report.push(`${shaftKey}: already locked at (${shaftLocked.x},${shaftLocked.y},${shaftLocked.z}) — kept.`);
    return finish(dryRun, report, toLock, [], false);
  }
  const shaft = await siteShaft(bot, await surfaceOnce(), [{ key: castleKey, box: castleBox }, { key: yardKey, box: yardBox }, { key: pitKey, box: pitBox }]);
  if (!shaft.found) {
    report.push(`${shaftKey}: ✗ NOT FOUND — ${shaft.tried} mouth(s) hazard-walked of ${shaft.candidates} clear of both by ${SHAFT_SITING.min_gap}+ `
      + `(refused: ${Object.entries(shaft.refused).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}).`);
    return finish(dryRun, report, [], [`${shaftKey}: NOT FOUND — no safe diagonal descent to y${STAIRCASE_SAFETY.REQUIRED_DEPTH_Y} whose whole run keeps ${SHAFT_SITING.min_gap}+ blocks from ${castleKey} and ${yardKey}.`], false);
  }
  const st = shaft.staircase, pr = st.prism;
  report.push(`${shaftKey}: FOUND mouth at (${shaft.top.x},${shaft.top.y},${shaft.top.z}), descends east ${pr.maxX - pr.minX + 1} blocks to y${st.lowestSafeY} `
    + `(${pr.copies} flights); its whole run is ${shaft.gaps.map(g => `${g.gap} from ${g.key}`).join(', ')} (${shaft.tried} mouth(s) walked).`);
  toLock.push({
    spec: { blueprint: shaftKey, roomKey: shaftKey, total_voxels: shaft.voxels },
    candidate: {
      transpose_origin: shaft.top,
      staircase: { lowestSafeY: st.lowestSafeY, surfaceY: st.surfaceY, depthReached: st.depthReached, safeCopies: st.safeCopies, haltReason: st.haltReason || null },
      // The descent's horizontal reach, so every later siter keeps clear of the whole diagonal (rowExtent reads it).
      footprint: { width: pr.maxX - pr.minX + 1, length: pr.maxZ - pr.minZ + 1, corner: { x: pr.minX, z: pr.minZ } },
    },
  });
  return finish(dryRun, report, toLock, [], false);
}

// siteShaft(bot, g, avoid) — the builder's standalone mineshaft: the mouth nearest the castle whose
// whole diagonal keeps SHAFT_SITING.min_gap from every box in `avoid` and passes the same hazard walk a
// headframe's does (building_site_overlays.evaluateStaircaseFrom). Mouth is a dry, trunk-free column;
// descent runs east. Candidates are hazard-walked nearest-first, stopping at the first safe one.
const SHAFT_SEARCH_BEYOND = 64;   // how far past min_gap the search reaches, measured to the castle
const SHAFT_WALK_LIMIT = 400;     // mouths hazard-walked before the search gives up and says so
async function siteShaft(bot, g, avoid) {
  const { projectStaircase } = require('@perception/mining_blueprinter');
  const { evaluateStaircaseFrom } = require('@utils/building_site_overlays');
  const { LAND } = require('@utils/footprint_survey');
  const { makeExecutionPacer } = require('@utils/execution_yield');
  const pace = makeExecutionPacer();
  const reachAt = new Map();   // mouth y -> { dx0, dx1, dz0, dz1, voxels } relative to the mouth
  const reach = (y) => {
    if (!reachAt.has(y)) {
      const proj = projectStaircase({ headAWorld: { x: 0, y, z: 0 }, lowestSafeY: STAIRCASE_SAFETY.REQUIRED_DEPTH_Y });
      let dx0 = Infinity, dx1 = -Infinity, dz0 = Infinity, dz1 = -Infinity, voxels = 0;
      for (const seg of proj.segments) {
        voxels += seg.voxel_count;
        for (const v of seg.voxels) { dx0 = Math.min(dx0, v[0]); dx1 = Math.max(dx1, v[0]); dz0 = Math.min(dz0, v[2]); dz1 = Math.max(dz1, v[2]); }
      }
      reachAt.set(y, proj.segments.length ? { dx0, dx1, dz0, dz1, voxels } : null);
    }
    return reachAt.get(y);
  };
  const gapOf = (r, b) => Math.hypot(Math.max(0, b.minX - r.maxX - 1, r.minX - b.maxX - 1), Math.max(0, b.minZ - r.maxZ - 1, r.minZ - b.maxZ - 1));
  const refused = { too_shallow: 0 };
  const cands = [];
  for (let z = g.z0; z < g.z0 + g.D; z++) {
    for (let x = g.x0; x < g.x0 + g.W; x++) {
      const i = (z - g.z0) * g.W + (x - g.x0);
      if (g.kind[i] !== LAND || g.trunk[i]) continue;
      const y = g.height[i];
      const rr = reach(y);
      if (!rr) { refused.too_shallow++; continue; }
      const box = { minX: x + rr.dx0, maxX: x + rr.dx1, minZ: z + rr.dz0, maxZ: z + rr.dz1 };
      if (box.minX < g.x0 || box.maxX >= g.x0 + g.W || box.minZ < g.z0 || box.maxZ >= g.z0 + g.D) continue;   // the run leaves the loaded area
      const gaps = avoid.map(a => ({ key: a.key, gap: Math.round(gapOf(box, a.box) * 10) / 10 }));
      if (gaps.some(q => q.gap < SHAFT_SITING.min_gap)) continue;
      if (gaps[0].gap > SHAFT_SITING.min_gap + SHAFT_SEARCH_BEYOND) continue;
      cands.push({ top: { x, y, z }, gaps, voxels: rr.voxels });
    }
  }
  cands.sort((a, b) => a.gaps[0].gap - b.gaps[0].gap || a.gaps[1].gap - b.gaps[1].gap);
  // The nearest mouth whose descent is solid ground the whole way. With none inside the walk limit, the
  // fluid-safe descent that meets the least cave is taken and said (SHAFT ALERT).
  let tried = 0;
  let leastCave = null;
  for (const c of cands) {
    if (tried >= SHAFT_WALK_LIMIT) break;
    await pace();
    tried++;
    const st = evaluateStaircaseFrom(bot, c.top, c.top.y);
    if (!st.ok) { refused[st.reason] = (refused[st.reason] || 0) + 1; continue; }
    if (st.caveAir <= STAIRCASE_SAFETY.CAVE_AIR_MAX) return { found: true, ...c, staircase: st, tried, candidates: cands.length };
    refused.cave = (refused.cave || 0) + 1;
    if (!leastCave || st.caveAir < leastCave.staircase.caveAir) leastCave = { ...c, staircase: st };
  }
  if (leastCave) {
    watcher.warn(TAG, `SHAFT ALERT: no descent within ${tried} mouth(s) is solid the whole way — the one sited at `
      + `(${leastCave.top.x},${leastCave.top.y},${leastCave.top.z}) meets ${leastCave.staircase.caveAir} cell(s) of cave air, the fewest found `
      + `(${refused.cave} mouth(s) refused for cave).`);
    return { found: true, ...leastCave, tried, candidates: cands.length };
  }
  return { found: false, refused, tried, candidates: cands.length };
}

// surveyOne — locate one blueprint from `origin`, folding this-pass pending footprints into the overlap
// set so siblings never collide. Returns the raw locate result. Never locks.
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

// run(bot, { dryRun: true, species }) — the batch core and the one siter for a base (Law 16). Surveys
// all blueprints and judges the whole layout; writes nothing. Returns { ok, report, site, anchor } ·
// { ok:false, problems } when the ground cannot hold the layout · { ok:false, transient:true } when the
// world is not streamed in yet. The foreman is the one deciding caller, before it spawns anybody.
// `species` is passed in, not sensed — the desk has no mandate to ask (Invariant B).
// surveyOrigin(bot, surveyFrom) — the cell every search walks outward from. The desk's own post sits
// inside the spawn-protected square, which reads as bedrock (`spawn_protection.maskWorldReads`), so a
// dry run is given the person's feet as origin. Default stays the body's own position.
function surveyOrigin(bot, surveyFrom) {
  const at = surveyFrom || bot.entity.position;
  return { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
}

async function run(bot, opts = {}) {
  // The survey only looks — a caller asking this to lock is refused loudly, never quietly handed a
  // survey it thinks was committed. The foreman's hub is the one writer (`foreman_hub.lockSite`).
  if (opts.dryRun !== true) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): run() surveys and never locks — pass { dryRun: true }. `
      + "A base is locked only by the foreman's hub (foreman_hub.lockSite), with the rows this survey returns.");
  }
  const dryRun = true;
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: run() needs a body with a position. The bot must be registered before the batch runs.`);
  }
  const species = opts.species || require('@kernel/bot_mandate').currentMode();
  // Carried as an argument, not a module flag — a flag is process state two callers could share and one
  // forget to clear, silently blinding a body to its own HQ (Law 8). `origin` rides the same way.
  return _run(bot, { dryRun, species, unlocked: !!opts.unlockedWorld, surveyFrom: opts.origin || null, build: opts.build || null });
}

async function _run(bot, { dryRun, species, unlocked, surveyFrom, build }) {

  // Two species, two layouts, one job. The branch sits at the top, ahead of the sections below, because
  // a contractor is not a reduced version of this pass — it sites no farm and hangs off no headframe.
  if (species === BOT_MODES.CONTRACTOR) {
    return runContractorLayout(bot, dryRun, unlocked, surveyFrom);
  }
  // A builder's layout is not this survey — its own is below (castle first, the headframe hung off it).
  if (species === BOT_MODES.BUILDER) {
    return runBuilderLayout(bot, dryRun, unlocked, surveyFrom, build);
  }

  const report = [];
  const toLock = [];          // { spec, candidate } surveyed-and-passing, not yet locked
  const pendingRaw = [];      // { roomKey, center, extent } this-pass reservations for overlap avoidance
  const problems = [];        // human strings — any non-empty ⇒ Law 13, lock nothing
  let transient = false;      // any chunks_not_loaded ⇒ soft-retry, not a hard stop

  // ── 1. Wheat farm — wheat_trident_scanner sites the whole phase-1 field in one penalty-free sweep ──
  // Cross-plot penalty-free guarantee, so FARM_PLOT_COUNT plots are computed together, as one unit, not
  // instance by instance. Each build step locks as one wheat_tine_row instance: transpose_origin = the
  // stand, footprint measured off the blueprint. Idempotent: if instance 0 is already locked,
  // repopulate `centers` from the chairs and skip the scan.
  const centers = {};              // roomKey → transpose_origin, for satellites to hang off
  let anchorCenter = null;         // farm instance 0's stand (the headframe's reference)
  if (readLockedCenter(FARM_ROOM_KEYS[0], unlocked)) {
    for (const key of FARM_ROOM_KEYS) { const locked = readLockedCenter(key, unlocked); if (locked) centers[key] = locked; }
    anchorCenter = centers[FARM_ROOM_KEYS[0]];
    report.push(`${FARM_BLUEPRINT_NAME}: phase-1 field already locked (${Object.keys(centers).length}/${FARM_ROOM_KEYS.length} rows) — skipping scan.`);
  } else {
    const origin = surveyOrigin(bot, surveyFrom);
    // Reads every sea-level water body, walking outward from `origin`; waits for the area to arrive
    // first since it reads it exactly once. An accepted tine is one the surveying body can walk to.
    const settled = await loadedAreaSettled(bot);
    report.push(settleLine(settled));
    const scan = await scanWheatTrident(bot, { origin, target: FARM_PLOT_COUNT });
    let rows = scan.tines.flatMap(t => t.steps);
    if (rows.length > 0) {
      // Locks every plot the scanner returned. Short of FARM_PLOT_COUNT is not a hard stop — a partial
      // field still feeds the fleet, and unfilled instances idle (farm_manager releases them). Each
      // plot's reserved box is measured off the blueprint the row locks as, naming the ground the crop
      // actually occupies.
      const blueprintRegistry = require('@kernel/blueprint_registry');

      // Which way a tine row reaches is a choice of blueprint: the offset between the scanner's stand
      // and crop cells names one of the four fixed row blueprints. A non-cardinal offset is a coding
      // violation — tupleLayer pairs only cardinal neighbours (Law 13).
      const blueprintFor = (row) => {
        const key = `${row.place[0].x - row.stand.x},${row.place[0].z - row.stand.z}`;
        const name = FARM_ROW_BLUEPRINTS[key];
        if (!name) {
          throw new Error(`[${TAG}] CODING VIOLATION (Law 13): the trident scan paired stand `
            + `(${row.stand.x},${row.stand.y},${row.stand.z}) with a crop at offset (${key}), which is not a unit `
            + `cardinal, so no tine row blueprint reaches it. tupleLayer pairs only cardinal neighbours.`);
        }
        return name;
      };

      if (rows.length > FARM_ROOM_KEYS.length) {
        throw new Error(`[${TAG}] CODING VIOLATION: the trident scan returned ${rows.length} rows for ${FARM_ROOM_KEYS.length} room keys — it was asked for FARM_PLOT_COUNT plots, which is exactly that many rows.`);
      }
      const byDirection = { east: 0, north: 0, west: 0, south: 0 };
      rows.forEach((row, i) => {
        const roomKey = FARM_ROOM_KEYS[i];
        const blueprint = blueprintFor(row);
        byDirection[blueprint.slice('wheat_tine_row_'.length)] += 1;
        const bc = { x: row.stand.x, y: row.stand.y, z: row.stand.z };
        // Reserved box is this row's reach, measured off the blueprint it actually locks as, so a north
        // row reserves 3x2 where an east row reserves 2x3 — the ground the crop really occupies.
        const extent = footprintExtent(blueprintRegistry.getBuilding(blueprint, TAG));
        const candidate = { transpose_origin: bc, footprint: { width: extent.width, length: extent.length }, staircase: null };
        if (!anchorCenter) anchorCenter = bc;
        centers[roomKey] = bc;
        toLock.push({ spec: { blueprint, roomKey }, candidate });
        pendingRaw.push({ roomKey, center: bc, extent });
      });
      const dirs = Object.entries(byDirection).filter(([, n]) => n > 0).map(([d, n]) => `${n} ${d}`).join(', ');
      report.push(describeTrident(scan)
        + `\n      ↳ instance 0 stand (${anchorCenter.x},${anchorCenter.y},${anchorCenter.z}) is the base anchor.`
        + `\n      ↳ rows by direction: ${dirs}.`);
    } else if (!settled.settled) {
      // The world was still arriving when it was read, so finding nothing is not yet evidence of nothing
      // there (Invariant B): soft-retry. Once the loaded area has stopped growing, an empty answer is the
      // world's answer.
      transient = true;
      report.push(describeTrident(scan),
        `${FARM_BLUEPRINT_NAME}: no plot yet, and the loaded area had not all arrived by the ${SETTLE_MAX_MS / 1000}s cap — retry.`);
    } else {
      // The whole loaded area was read and no sea-level water bank in it holds a plot — Law 13, lock
      // nothing, and say it in words the person can act on.
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
  // Each satellite searches from a named origin: farm instance 0 by default, or a sibling declared via
  // `anchorFrom`. SATELLITES is ordered so an anchorFrom target is always surveyed first.
  for (const spec of SATELLITES) {
    const originKey    = spec.anchorFrom || FARM_ROOM_KEYS[0];
    const originCenter = centers[originKey] || anchorCenter;   // fallback: a missing origin is already a HARD STOP upstream
    const satelliteOrigin = { x: originCenter.x, y: originCenter.y, z: originCenter.z };
    const originName   = originKey === FARM_ROOM_KEYS[0] ? 'farm anchor' : originKey;

    const locked = readLockedCenter(spec.roomKey, unlocked);
    if (locked) {
      centers[spec.roomKey] = locked;
      const d = Math.hypot(locked.x - originCenter.x, locked.z - originCenter.z);
      report.push(`${spec.blueprint}: already locked at (${locked.x},${locked.y},${locked.z}), ${d.toFixed(1)}b from ${originName}.`);
      // No pending push — an already-locked building is in HQ, so getExistingFootprints already reserves it.
      continue;
    }
    const res = await surveyOne(bot, spec, satelliteOrigin, pendingRaw, unlocked);
    if (res.found) {
      // No distance cap: the only building-to-building constraint is non-overlap (MIN_BLUEPRINT_SPACING
      // reject ring inside locate()), so a found satellite locks at its nearest clear site however far.
      const d = res.distFromOrigin; // distance from this satellite's own anchor origin — informational
      const bc = res.candidate.transpose_origin;
      centers[spec.roomKey] = bc;
      report.push(`${spec.blueprint}: FOUND at (${bc.x},${bc.y},${bc.z}), ${d.toFixed(1)}b from ${originName} (scan ${res.scanSecs}s).\n      ↳ WHY HERE: ${res.successSummary}`);
      toLock.push({ spec, candidate: res.candidate });
      pendingRaw.push({ roomKey: spec.roomKey, center: bc, extent: res.extent });
    } else if (res.reason === 'chunks_not_loaded') {
      transient = true;
      report.push(`${spec.blueprint}: world not loaded yet (${res.reason}) — retry.`);
    } else {
      // Prefers warnText (the rich multi-line post-mortem with the Wall breakdown) over the one-line
      // summaryText, which the water-site 'no_viable_spot' path falls back to.
      const detail = res.throwText || res.warnText || res.summaryText || '';
      const detailLines = detail.split('\n');
      problems.push(`${spec.blueprint}: NOT FOUND — ${res.reason}. ${detailLines[0]}`);
      // Surfaces the full post-mortem (the Wall breakdown + dominant-reason clause) in the survey, not
      // just line 1 — Law 6: the reason must be recoverable.
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
  const bc = candidate.transpose_origin;
  return {
    blueprint: spec.blueprint,
    roomKey: spec.roomKey,
    // A downloaded blueprint (the builder's castle) is not in the hand-authored registry site_chairs counts from,
    // so its size rides on the row. Absent for every hand-authored blueprint.
    ...(spec.total_voxels ? { total_voxels: spec.total_voxels } : {}),
    candidate: {
      transpose_origin: { x: bc.x, y: bc.y, z: bc.z },
      footprint: candidate.footprint || null,
      staircase: candidate.staircase || null,
    },
  };
}

// finish — the shared judgment tail: emit the survey report, then transient-soft / Law-13 / lock-all.
function finish(dryRun, report, toLock, problems, transient) {
  watcher.summary(TAG, `Base-layout survey:\n  ${report.join('\n  ')}`);

  // Transient outranks a "problem" verdict — an unstreamed world is not yet a trustworthy survey.
  if (transient) {
    watcher.warn(TAG, `⚠️ Base-layout survey hit unloaded chunks — world not streamed in yet. Soft-failing for retry (not a Law 13 stop).`);
    return { ok: false, transient: true, report, locked: [] };
  }

  // ── GROUND THAT CANNOT HOLD THE LAYOUT IS A VERDICT, NOT A THROW ───────────
  // Every cause here is about the world, not the code, so it is a verdict a person can act on rather
  // than a Law 13 throw. Nothing is locked, so there is never a half-placed base.
  if (problems.length > 0) {
    watcher.warn(TAG, `Base layout cannot be placed here:\n  ${problems.join('\n  ')}\n  Nothing was locked.`);
    return { ok: false, problems, report, locked: [] };
  }

  // Where the base will sit, returned, not only logged — the foreman tells the person before it
  // spawns anybody, and can only do that from a dry run. The seat is the crew's ALPHA STRUCTURE
  // (architect_config.ALPHA_STRUCTURE) — the one building a person would point at and call the base.
  const alphas = Object.values(ALPHA_STRUCTURE);
  const anchorOf = (rows) => {
    const seat = rows.find(t => alphas.includes(t.spec.roomKey)) || rows[0];
    const c = seat && seat.candidate && seat.candidate.transpose_origin;
    return c ? { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) } : null;
  };

  // The site itself, returned so the desk's hub can write it. Each row carries exactly the fields
  // `site_chairs.siteChairs` reads, and nothing else the survey computed on the way.
  watcher.summary(TAG, `Survey: all ${toLock.length} blueprint(s) would lock (nothing written here — the foreman's hub writes the site).`);
  return { ok: true, dryRun: true, report, locked: [], anchor: anchorOf(toLock), site: toLock.map(siteRow) };
}

module.exports = {
  run,
  baseLayoutComplete,
};
