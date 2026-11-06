// fragment: lock_all_buildspots (action)
// Locates every base blueprint's build site in one startup pass: one layout, every crew. All blueprints are
// surveyed before any verdict, so a miss on one is judged against the whole layout, early, before any
// blueprint is deep into a run.
//
// THE LAYOUT, IN ORDER — a crew differs only in the blueprints its CREW_PROFILE row names (architect_config):
//   1. the building, for a crew that raises one (CREW_BUILD: the castle) — siteBuilding
//   2. the home, its alpha structure — beside the building (the laydown yard), or, for a home the shaft hangs from
//      (the headframe), from where the body stands on ground the shaft descends safely through — siteHome
//   3. the waste pit beside the home — sitePit
//   4. the shallow shaft, when it stands alone rather than hanging from the home — siteShaft
//   5. the farm, in two rings — siteWheatField: the pens and the water pool flank the home, in the ring of the building
//      and the home; then the wheat fields and the cane fields in the next ring out, each crop a cluster of copies that
//      touch by their attach points and grow away from the home — siteFieldCluster
//   6. the base's lights, painted over the ground round them all — siteLights
// A support with no spot beside the structure it serves is sited beside any structure already placed, nearest first
// (siteSurfaceStructure, sitePit), so every support finds a place while the land holds one.
// All found → returned as the site for the foreman's hub to write (a verdict otherwise; a transient
// soft-fails for retry).
//
// Surveys only — the foreman is its one caller and its hub writes the locked site (Law 16).

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { locate, loadBlueprintDims, getExistingFootprints, footprintBox } = require('@action/find_buildingspot');
const { footprintExtent, turnOf } = require('@perception/blueprint_survey');   // a plot's reach, measured off the blueprint; a locked site's turn
const { BUILDER_BUILDS, ALPHA_STRUCTURE, SHAFT_HEAD, CREW_BUILD, YARD_SITING, SHAFT_SITING,
        WASTE_PIT, WASTE_PIT_SITING, WHEAT_FIELD_SITING, PEN_SITING, FARM_FIELD, FARM_PENS, BLUEPRINT_SPACING,
        BASE_BIOMES, PORTAL_MOULD, PORTAL_SITING, CREW_PROFILE, SPAWN_PROOFING, BASE_LIGHTS, WATER_CLEARANCE } = require('@thinking/architect_config');
const { fieldKeysSited } = require('@utils/calculators/wheat_critical_mass');   // the wheat and cane fields critical mass asks for
const { siteOnSurface } = require('@utils/surface_site');   // the field and the pen stand on the surface, nearest first

// Minimum gap kept between two sited blueprints, so a lock never lands on its neighbour. No cap on
// distance from the anchor — only non-overlap gates a satellite's site.
const MIN_BLUEPRINT_SPACING = BLUEPRINT_SPACING;
const { STAIRCASE_SAFETY } = require('@utils/building_site_overlays');

const TAG = 'lock_all_buildspots';

// ── A CALLER WITH NO HQ TO READ ──────────────────────────────────────────────────────────
// The foreman has no mandate, so it cannot read what is already locked (crew-scoped memory).
// `unlockedWorld` is the caller's declaration to survey as if nothing is placed yet — never inferred
// from a failed read. The body still re-surveys WITH its HQ and refuses there on any overlap (Law 25).
// A foreman continuing a base it already holds passes that base instead (`held`: room key → its set_buildspot spot), so
// the survey keeps every held structure where it stands and sites only the ones the crew gained since.

// readLockedCenter — a blueprint's already-locked transpose_origin, or null. `unlocked` is the
// declaration above; a re-run skips whatever is already locked and only fills the gaps.
function lockedSpot(roomKey, unlocked = false) {
  if (unlocked instanceof Map) return unlocked.get(roomKey) || null;
  if (unlocked) return null;
  return hq.readBuildingChair(roomKey, 'set_buildspot');
}
function readLockedCenter(roomKey, unlocked = false) {
  const spot = lockedSpot(roomKey, unlocked);
  return (spot?.transpose_origin && typeof spot.transpose_origin.x === 'number') ? spot.transpose_origin : null;
}

// layoutKeys(crew) → every room key the layout locks for a crew, in layout order; the wheat and cane fields as many as
// critical mass asks for (calculators/wheat_critical_mass, cane_critical_mass).
function layoutKeys(crew) {
  return [...new Set([CREW_BUILD[crew], ALPHA_STRUCTURE[crew], WASTE_PIT.structure, SHAFT_HEAD[crew],
    ...fieldKeysSited(crew), ...FARM_PENS, CREW_PROFILE[crew].priority.includes(PORTAL_MOULD) ? PORTAL_MOULD : null, SPAWN_PROOFING].filter(Boolean))];
}

// baseLayoutComplete — the one definition of "nothing left to lock" (Law 16), exported so job_board's
// trigger gate asks the performer instead of re-deriving its criterion.
function baseLayoutComplete() {
  return layoutKeys(require('@kernel/bot_mandate').currentMode()).every(key => !!readLockedCenter(key));
}

// boxOf(fp) → the footprint box of a chair's or a survey's { corner, width, length }.
const boxOf = (fp) => ({ minX: fp.corner.x, maxX: fp.corner.x + fp.width - 1, minZ: fp.corner.z, maxZ: fp.corner.z + fp.length - 1 });

// ── 1. THE BUILDING ───────────────────────────────────────────────────────────────────────────────────────────
// surveyFootprint over the whole loaded area, tightest tolerance first up to the build's maxTolerance
// (architect_config.BUILDER_BUILDS), nearest to level within the first passing tier. A plot passes only with no water,
// lava or unloaded ground in its pit or shell. A building already locked in memory is kept.
// Returns { key, box, ring, floor, surface } or { problem }.
async function siteBuilding(bot, report, toLock, unlocked, build) {
  // Which building is the caller's to say — the foreman reads it from CREW_BUILD and has already refused an
  // unknown name. Asked for an unknown one, nothing is guessed (Law 13).
  const bp = BUILDER_BUILDS[build];
  if (!bp) {
    throw new Error(`[${TAG}] CODING VIOLATION: a layout with a building needs a known build — got '${build}'. `
      + `Known: ${Object.keys(BUILDER_BUILDS).join(', ')} (architect_config.BUILDER_BUILDS).`);
  }
  const key = bp.name;
  const locked = readLockedCenter(key, unlocked);
  if (locked) {
    report.push(`${key}: already locked at (${locked.x},${locked.y},${locked.z}) — kept.`);
    // The footprint and ground floor of the chair a resumed crew kept.
    const fp = lockedSpot(key, unlocked)?.footprint || null;
    if (!fp || !fp.corner || !Number.isInteger(fp.width) || !Number.isInteger(fp.ground_floor_y)) {
      return { problem: `the base cannot be sited round ${key} — its footprint is not known (its site chair carries none).` };
    }
    return { key, box: boxOf(fp), ring: bp.ring, floor: fp.ground_floor_y, surface: null };
  }
  const t0 = Date.now();
  // The whole basement is surveyed, past the box wherever its cells hang past it.
  const planned = require('@kernel/downloaded_plan_registry').load(key);
  const over = require('@kernel/blueprint_anchor_calculator').basementOver(planned.dimensions, planned.anchor_summary.offset);
  const survey = await require('@utils/footprint_survey').surveyFootprint(bot, { w: bp.w, l: bp.l, below: bp.below, ring: bp.ring, over });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const tiers = survey.byTolerance.filter(t => t.tolerance <= bp.maxTolerance);
  const tally = tiers.map(t => `±${t.tolerance}: ${t.passingPlots}/${t.plots} plot(s) pass`).join(' · ');
  if (!tiers.some(t => t.passingPlots > 0)) {
    const r = survey.refused;
    report.push(`${key}: ✗ NOT FOUND over ${survey.positions} position(s) in ${secs}s — ${tally}. Refused on the surface: `
      + `${r.unloaded_or_lava} unloaded or lava, ${r.water_in_footprint} water in the footprint, ${r.ring_not_land} ring not land, ${r.water_near} within ${WATER_CLEARANCE} of water.`);
    return { problem: `${key}: NOT FOUND — no ${bp.w}x${bp.l} plot in the loaded area is level to ±${bp.maxTolerance} with a dry pit (${tally}).` };
  }
  // THE BASE STANDS IN OAK FOREST, OR PLAINS WHEN NO FOREST PLOT PASSES (BASE_BIOMES, in order); within one
  // biome rank the levellest tier wins. A loaded area with no passing plot in either is refused, so the landing
  // rolls again.
  let tier = null, s = null;
  for (const rank of BASE_BIOMES) {
    for (const t of tiers) {
      const pick = t.picks.find(p => p.passes && rank.has(p.biome));
      if (pick) { tier = t; s = pick; break; }
    }
    if (s) break;
  }
  if (!s) {
    const seen = [...new Set(tiers.flatMap(t => t.picks.filter(p => p.passes).map(p => p.biome)))].join(', ');
    report.push(`${key}: ✗ NOT FOUND in forest or plains — ${tally}; the passing plots stand in ${seen}.`);
    return { problem: `${key}: NOT FOUND — no passing ${bp.w}x${bp.l} plot stands in forest or plains (architect_config.BASE_BIOMES); the passing plots stand in ${seen}.` };
  }
  const center = { x: s.centre.x, y: s.h, z: s.centre.z };
  const footprint = { width: s.fw, length: s.fl, corner: s.corner, ground_floor_y: s.h, pit_bottom_y: s.bottom };
  toLock.push({ spec: { blueprint: key, roomKey: key, total_voxels: bp.blocks }, candidate: { transpose_origin: center, staircase: null, footprint } });
  report.push(`${key}: FOUND at (${center.x},${center.y},${center.z}) — ${s.fw}x${s.fl} from corner (${s.corner.x},${s.corner.z}), `
    + `ground floor y${s.h}, level to ±${tier.tolerance}, off-level ${s.offLevel}, pit ${s.dug} blocks dug (${s.stone} stone, ${s.dirt} dirt), `
    + `${s.caveAir} cave air; biome ${s.biome} (${Math.round(s.biomeShare * 100)}%). Survey ${secs}s, ${tally}.`);
  return { key, box: boxOf(footprint), ring: bp.ring, floor: s.h, surface: survey.surface };
}

// ── 2. THE HOME ───────────────────────────────────────────────────────────────────────────────────────────────
// A HOME THE SHAFT HANGS FROM (the headframe) is located by find_buildingspot from where the body stands, on ground its
// shaft descends safely through; the shaft's whole run is returned so every later site keeps clear of it.
// A HOME BESIDE THE BUILDING (the laydown yard) is sited by siteBeside over the same surface read: nearest spot yardGap+
// from the building, floor within ±rise of its ground floor, within scrape_max/fill_max of it. yardGap keeps the yard
// outside the building's ring — the strip round the pit that bodies cut their stairs down through — and never under
// YARD_SITING.min_gap. A site YARD_SITING.alert_gap+ away raises a YARD ALERT warning.
// Returns { box, floor, shaftRun? } or { problem } or { transient }.
async function siteHomeFromBody(bot, report, toLock, unlocked, surveyFrom, homeKey) {
  const spec = { blueprint: homeKey, roomKey: homeKey, requireShaft: true, requireDirtGround: false, clearance: MIN_BLUEPRINT_SPACING };
  const extent = footprintExtent(loadBlueprintDims(homeKey).building, 0);
  let home = null;   // { center, staircase }
  const locked = readLockedCenter(homeKey, unlocked);
  if (locked) {
    report.push(`${homeKey}: already locked at (${locked.x},${locked.y},${locked.z}) — kept.`);
    home = { center: locked, staircase: lockedSpot(homeKey, unlocked)?.staircase || null };
  } else {
    const res = await surveyOne(bot, spec, surveyOrigin(bot, surveyFrom), [], unlocked);
    if (res && res.reason === 'chunks_not_loaded') {
      report.push(`${homeKey}: world not loaded yet (${res.reason}) — retry.`);
      return { transient: true };
    }
    if (!res || !res.found || !res.candidate) {
      const detail = (res?.throwText || res?.warnText || res?.summaryText || '').split('\n');
      const rest = detail.slice(1).map(l => l.trim()).filter(Boolean);
      report.push(`${homeKey}: ✗ NOT FOUND (${res?.reason}).` + (rest.length ? `\n      ${rest.join('\n      ')}` : ''));
      return { problem: `${homeKey}: NOT FOUND — ${res?.reason}. ${detail[0]}` };
    }
    const bc = res.candidate.transpose_origin;
    report.push(`${homeKey}: FOUND at (${bc.x},${bc.y},${bc.z}), ${res.distFromOrigin.toFixed(1)}b from where the body stands (scan ${res.scanSecs}s).\n      ↳ WHY HERE: ${res.successSummary}`);
    toLock.push({ spec, candidate: res.candidate });
    home = { center: bc, staircase: res.candidate.staircase || null };
  }
  if (!home.staircase || !Number.isInteger(home.staircase.lowestSafeY)) {
    return { problem: `${WASTE_PIT.structure}: cannot be sited — ${homeKey}'s shaft depth is not known (its site carries no staircase).` };
  }
  return { box: footprintBox(home.center.x, home.center.z, extent, 0, homeKey), floor: home.center.y,
    shaftRun: hungShaftBox(homeKey, home.center, home.staircase.lowestSafeY) };
}

async function siteHomeBeside(report, toLock, surface, unlocked, homeKey, building) {
  const extent = footprintExtent(loadBlueprintDims(homeKey).building, 0);
  const locked = readLockedCenter(homeKey, unlocked);
  if (locked) {
    report.push(`${homeKey}: already locked at (${locked.x},${locked.y},${locked.z}) — kept.`);
    return { box: footprintBox(locked.x, locked.z, extent, 0, homeKey), floor: locked.y };
  }
  const gap = Math.max(YARD_SITING.min_gap, building.ring + 1);
  const yard = await require('@utils/footprint_survey').siteBeside(surface, {
    extent, avoid: building.box, groundY: building.floor,
    minGap: gap, rise: YARD_SITING.rise, scrapeMax: YARD_SITING.scrape_max, fillMax: YARD_SITING.fill_max,
    searchTo: YARD_SITING.search_to,
  });
  if (!yard.found) {
    const r = yard.refused;
    report.push(`${homeKey}: ✗ NOT FOUND within ${gap}-${YARD_SITING.search_to} blocks of ${building.key} over ${yard.candidates} position(s) — `
      + `refused: ${r.not_land} not land, ${r.water_near} within ${WATER_CLEARANCE} of water, ${r.trunk} on a tree trunk, ${r.too_uneven} more than ${YARD_SITING.scrape_max} over or ${YARD_SITING.fill_max} under a floor within ±${YARD_SITING.rise} of y${building.floor}.`);
    return { problem: `${homeKey}: NOT FOUND beside ${building.key} — no level, dry spot ${gap}+ blocks from its footprint.` };
  }
  report.push(`${homeKey}: FOUND at (${yard.center.x},${yard.center.y},${yard.center.z}), ${yard.gap} blocks from ${building.key}'s footprint, `
    + `floor y${yard.floor} (${building.key} ground y${building.floor}), ${yard.scrape} block(s) to cut and ${yard.fill} to fill.`);
  if (yard.gap >= YARD_SITING.alert_gap) {
    watcher.warn(TAG, `YARD ALERT: ${homeKey} sited ${yard.gap} blocks from ${building.key}'s outer edge (alert at ${YARD_SITING.alert_gap}+, `
      + `nearest allowed ${gap}) at (${yard.center.x},${yard.center.y},${yard.center.z}) — no nearer spot was land, trunk-free and level `
      + `(refused nearer: ${yard.refused.not_land} not land, ${yard.refused.water_near} near water, ${yard.refused.trunk} on a trunk, ${yard.refused.too_uneven} too uneven).`);
  }
  toLock.push({ spec: { blueprint: homeKey, roomKey: homeKey }, candidate: { transpose_origin: yard.center, staircase: null, footprint: null } });
  return { box: footprintBox(yard.center.x, yard.center.z, extent, 0, homeKey), floor: yard.center.y };
}

// ── THE WHOLE LAYOUT ──────────────────────────────────────────────────────────────────────────────────────────
// `s` carries what each step stands beside and keeps clear of (see the pit and the field below): every footprint sited
// so far in `clear`, a shaft's run with `run: true` (kept clear of, never stood beside, lit over).
async function runLayout(bot, dryRun, crew, unlocked, surveyFrom, build) {
  const homeKey = ALPHA_STRUCTURE[crew];
  const shaftKey = SHAFT_HEAD[crew];
  const hangsFromHome = shaftKey === homeKey;
  const report = [];
  const toLock = [];
  let surface = null;
  const surfaceOnce = async () => (surface = surface || await require('@utils/footprint_survey').readSurface(bot));
  const s = { unlocked, homeKey, clear: [] };

  // 1. The building.
  let building = null;
  if (build) {
    building = await siteBuilding(bot, report, toLock, unlocked, build);
    if (building.problem) return finish(dryRun, report, [], [building.problem], false);
    surface = building.surface;
    s.clear.push({ key: building.key, box: building.box, ring: building.ring });
  }

  // 2. The home.
  let home;
  if (hangsFromHome) {
    home = await siteHomeFromBody(bot, report, toLock, unlocked, surveyFrom, homeKey);
  } else if (building) {
    home = await siteHomeBeside(report, toLock, await surfaceOnce(), unlocked, homeKey, building);
  } else {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): the ${crew} crew's home '${homeKey}' neither hangs its shaft nor stands beside `
      + `a building, so nothing says where it goes. A home stands from the body only when its shaft hangs from it (SHAFT_HEAD), `
      + `else beside the crew's building (CREW_BUILD).`);
  }
  if (home.transient) return finish(dryRun, report, [], [], true);
  if (home.problem) return finish(dryRun, report, [], [home.problem], false);
  s.homeBox = home.box;
  s.homeFloor = home.floor;
  if (home.shaftRun) s.clear.push({ key: `${homeKey} shaft`, box: home.shaftRun, run: true });

  // 3. The waste pit.
  const pit = await sitePit(bot, report, toLock, await surfaceOnce(), s);
  if (!pit.box) return finish(dryRun, report, [], [pit.problem], false);
  s.clear.push({ key: WASTE_PIT.structure, box: pit.box });

  // 4. The shallow shaft that stands alone.
  if (!hangsFromHome) {
    const shaft = await siteShaftOnce(bot, report, toLock, await surfaceOnce(), s, shaftKey);
    if (shaft.problem) return finish(dryRun, report, [], [shaft.problem], false);
    s.clear.push({ key: shaftKey, box: shaft.mouth }, { key: `${shaftKey} run`, box: shaft.run, run: true });
  }

  // 5. The field, the pens and the crop fields.
  const farm = await siteWheatField(report, toLock, await surfaceOnce(), s, crew);
  if (farm.problem) return finish(dryRun, report, [], [farm.problem], false);

  // The portal's mould, in the base, for a crew whose list names it.
  if (CREW_PROFILE[crew].priority.includes(PORTAL_MOULD)) {
    const mould = await siteSurfaceStructure(report, toLock, await surfaceOnce(),
      { ...s, besideKey: s.homeKey, beside: s.homeBox, clear: [...s.clear, ...farm.placed], placed: farm.placed }, PORTAL_MOULD, PORTAL_SITING);
    if (mould.problem) return finish(dryRun, report, [], [mould.problem], false);
    farm.placed.push({ key: PORTAL_MOULD, box: mould.box });
  }

  // 6. The lights, kept off every pen's lane.
  const lights = siteLights(report, toLock, surface, farm.placed, unlocked, farm.lanes);
  if (lights.problem) return finish(dryRun, report, [], [lights.problem], false);
  return finish(dryRun, report, toLock, [], false);
}

// ── 4. THE MINESHAFT THAT STANDS ALONE ─────────────────────────────────────────────────────────────────────────
// The mouth nearest the home whose whole diagonal keeps SHAFT_SITING.min_gap from every footprint sited so far
// (siteShaft below). Returns { mouth, run } — the boxes of the columns it opens at the surface and of its whole
// horizontal reach — or { problem }.
async function siteShaftOnce(bot, report, toLock, surface, s, shaftKey) {
  const locked = readLockedCenter(shaftKey, s.unlocked);
  if (locked) {
    report.push(`${shaftKey}: already locked at (${locked.x},${locked.y},${locked.z}) — kept.`);
    const st = lockedSpot(shaftKey, s.unlocked)?.staircase;
    if (!st || !Number.isInteger(st.lowestSafeY)) {
      return { problem: `${FARM_FIELD.structure}: cannot be sited — ${shaftKey}'s run is not known (its site chair carries no staircase).` };
    }
    return standaloneShaftBoxes(locked, st.lowestSafeY);
  }
  const avoid = [{ key: s.homeKey, box: s.homeBox }, ...s.clear.filter(c => !c.run).map(c => ({ key: c.key, box: c.box }))];
  const shaft = await siteShaft(bot, surface, avoid);
  if (!shaft.found) {
    report.push(`${shaftKey}: ✗ NOT FOUND — ${shaft.tried} mouth(s) hazard-walked of ${shaft.candidates} clear of every footprint by ${SHAFT_SITING.min_gap}+ `
      + `(refused: ${Object.entries(shaft.refused).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}).`);
    return { problem: `${shaftKey}: NOT FOUND — no diagonal descent free of fluid and cave to y${STAIRCASE_SAFETY.REQUIRED_DEPTH_Y}, from a dry mouth, whose whole run keeps ${SHAFT_SITING.min_gap}+ blocks from ${avoid.map(a => a.key).join(', ')}.` };
  }
  const st = shaft.staircase, pr = st.prism;
  report.push(`${shaftKey}: FOUND mouth at (${shaft.top.x},${shaft.top.y},${shaft.top.z}), descends east ${pr.maxX - pr.minX + 1} blocks, to y${st.lowestSafeY}, ${st.deep ? `deep route to y${st.deep.lowestSafeY} with ${st.deep.route.length} turn(s)` : 'NO DEEP ROUTE'} `
    + `(${pr.copies} flights); its whole run is ${shaft.gaps.map(g => `${g.gap} from ${g.key}`).join(', ')} (${shaft.tried} mouth(s) walked).`);
  toLock.push({
    spec: { blueprint: shaftKey, roomKey: shaftKey, total_voxels: shaft.voxels },
    candidate: {
      transpose_origin: shaft.top,
      staircase: { lowestSafeY: st.lowestSafeY, surfaceY: st.surfaceY, depthReached: st.depthReached, safeCopies: st.safeCopies, haltReason: st.haltReason || null, deep: st.deep },
      // The descent's horizontal reach, so every later siter keeps clear of the whole diagonal (rowExtent reads it).
      footprint: { width: pr.maxX - pr.minX + 1, length: pr.maxZ - pr.minZ + 1, corner: { x: pr.minX, z: pr.minZ } },
    },
  });
  return standaloneShaftBoxes(shaft.top, st.lowestSafeY);
}

// THE MOUTH IS EVERY COLUMN THE STAIRS OPEN WITHIN MOUTH_DEPTH OF THE TOP: the ground there is dug out, so no torch
// post stands on it and no structure is sited against it; the run below it is kept clear of and lit over.
const MOUTH_DEPTH = 3;
function standaloneShaftBoxes(top, lowestSafeY) {
  const { projectStaircase } = require('@perception/mining_blueprinter');
  const run = { minX: top.x, maxX: top.x, minZ: top.z, maxZ: top.z };
  const mouth = { minX: top.x, maxX: top.x, minZ: top.z, maxZ: top.z };
  // The straight run is what reaches the ground's neighbours; a turned part lies under the iron band.
  for (const seg of projectStaircase({ headAWorld: top, lowestSafeY: Math.max(lowestSafeY, STAIRCASE_SAFETY.REQUIRED_DEPTH_Y) }).segments) {
    for (const v of seg.voxels) {
      run.minX = Math.min(run.minX, v[0]); run.maxX = Math.max(run.maxX, v[0]);
      run.minZ = Math.min(run.minZ, v[2]); run.maxZ = Math.max(run.maxZ, v[2]);
      if (v[1] < top.y - MOUTH_DEPTH) continue;
      mouth.minX = Math.min(mouth.minX, v[0]); mouth.maxX = Math.max(mouth.maxX, v[0]);
      mouth.minZ = Math.min(mouth.minZ, v[2]); mouth.maxZ = Math.max(mouth.maxZ, v[2]);
    }
  }
  return { mouth, run };
}

// ── 3 AND 5. THE PIT AND THE FIELD BESIDE THE HOME ────────────────────────────────────────────────────────────────
// `s` names the home they stand beside and the footprints they keep clear of:
//   unlocked   the caller's declaration that nothing is locked yet (readLockedCenter)
//   homeKey, homeBox, homeFloor   the home structure, its footprint and its floor y
//   clear      [{ key, box, ring? }] — footprints sited before; one with a `ring` is kept no nearer than ring + 1
const clearOfAll = (clear, gap) => clear.map(c => ({ box: c.box, gap: Math.max(gap, c.ring != null ? c.ring + 1 : 0) }));
const clearNames = (clear) => clear.map(c => c.key).join(', ');

// ── THE PIT IS DRY TO ITS FLOOR ──────────────────────────────────────────────────────────────────────────
// siteBeside reads the surface, and the trench is cut below it: a pad on dry ground can sit over a pocket of water
// that fills the trench as it is dug, and a dig cannot take a fluid out (dig_authority refuses it). So every cell the
// pit leaves open at or below its pad, and each cell beside and under one, is read for water or lava before a site is
// taken; a wet site is passed over and the next nearest one read, up to PIT_DRY_TRIES of them.
const PIT_DRY_TRIES = 8;
function pitWetAt(bot, center) {
  const Vec3 = require('vec3');
  const { isFluid } = require('@utils/gravity_utils');
  const { transposeVoxelsForCandidate } = require('@perception/blueprint_survey');
  const SIDES = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  for (const v of transposeVoxelsForCandidate(loadBlueprintDims(WASTE_PIT.structure).building, center)) {
    if (v.type !== 'air' || v.y > center.y) continue;
    for (const [dx, dy, dz] of SIDES) {
      const b = bot.blockAt(new Vec3(v.x + dx, v.y + dy, v.z + dz));
      if (b && isFluid(b.name)) return { x: v.x + dx, y: v.y + dy, z: v.z + dz, name: b.name };
    }
  }
  return null;
}

// sitePit — the waste pit beside the home, level with it, WASTE_PIT_SITING.min_gap from the home and from `s.clear`,
// dry to its floor (pitWetAt). Returns { box } when sited or kept, else { problem } with the verdict a person reads.
async function sitePit(bot, report, toLock, surface, s) {
  const pitKey = WASTE_PIT.structure;
  const pitExtent = footprintExtent(loadBlueprintDims(pitKey).building, 0);
  const locked = readLockedCenter(pitKey, s.unlocked);
  if (locked) {
    report.push(`${pitKey}: already locked at (${locked.x},${locked.y},${locked.z}) — kept.`);
    return { box: footprintBox(locked.x, locked.z, pitExtent, 0, pitKey) };
  }
  const gap = WASTE_PIT_SITING.min_gap;
  const wet = [];
  let pit = null;
  for (let tries = 0; tries < PIT_DRY_TRIES; tries++) {
    pit = await require('@utils/footprint_survey').siteBeside(surface, {
      extent: pitExtent, avoid: s.homeBox, groundY: s.homeFloor,
      minGap: gap, rise: WASTE_PIT_SITING.rise, scrapeMax: WASTE_PIT_SITING.scrape_max,
      fillMax: WASTE_PIT_SITING.fill_max, searchTo: WASTE_PIT_SITING.search_to,
      clearOf: [...clearOfAll(s.clear, gap), ...wet.map(w => ({ box: w.box, gap: 1 }))],
    });
    if (!pit.found) break;
    const at = pitWetAt(bot, pit.center);
    if (!at) break;
    wet.push({ box: footprintBox(pit.center.x, pit.center.z, pitExtent, 0, pitKey), at });
    pit = { found: false, refused: pit.refused, candidates: 0 };
  }
  // Beside the home level with it, else beside any structure placed, nearest first, on its lowest column: dug, never filled.
  for (const other of (pit && pit.found) ? [] : [{ key: s.homeKey, box: s.homeBox }, ...s.clear]) {
    if (other.run) continue;
    const loose = await require('@utils/footprint_survey').siteBeside(surface, {
      extent: pitExtent, avoid: other.box, minGap: Math.max(gap, other.ring != null ? other.ring + 1 : 0),
      scrapeMax: WASTE_PIT_SITING.scrape_max, fillMax: 0, searchTo: WASTE_PIT_SITING.search_to * 2,
      clearOf: [...clearOfAll([{ key: s.homeKey, box: s.homeBox }, ...s.clear], gap), ...wet.map(w => ({ box: w.box, gap: 1 }))],
      floorOf: (hs) => Math.min(...hs),
    });
    if (!loose.found || pitWetAt(bot, loose.center)) continue;
    report.push(`${pitKey}: nothing level beside ${s.homeKey}; sited beside ${other.key} instead.`);
    pit = loose;
    break;
  }
  if (wet.length) {
    report.push(`${pitKey}: passed over ${wet.length} site(s) whose trench would open on water or lava below the pad — `
      + wet.map(w => `${w.at.name} at (${w.at.x},${w.at.y},${w.at.z})`).join(', ') + '.');
  }
  if (!pit.found) {
    const r = pit.refused;
    report.push(`${pitKey}: ✗ NOT FOUND within ${gap}-${WASTE_PIT_SITING.search_to} blocks of ${s.homeKey} over ${pit.candidates} position(s) `
      + `clear of ${clearNames(s.clear) || 'nothing else'} — refused: ${r.not_land} not land, ${r.water_near} within ${WATER_CLEARANCE} of water, ${r.trunk} on a tree trunk, ${r.too_uneven} more than ${WASTE_PIT_SITING.scrape_max} over or ${WASTE_PIT_SITING.fill_max} under a floor within ±${WASTE_PIT_SITING.rise} of y${s.homeFloor}.`);
    return { problem: `${pitKey}: NOT FOUND beside ${s.homeKey} — no level, dry spot for its pad ${gap}+ blocks from every other footprint.` };
  }
  report.push(`${pitKey}: FOUND at (${pit.center.x},${pit.center.y},${pit.center.z}), ${pit.gap} blocks from ${s.homeKey}'s footprint, `
    + `pad y${pit.floor} (${s.homeKey} floor y${s.homeFloor}), ${pit.scrape} block(s) to cut and ${pit.fill} to fill.`);
  toLock.push({ spec: { blueprint: pitKey, roomKey: pitKey }, candidate: { transpose_origin: pit.center, staircase: null, footprint: null } });
  return { box: footprintBox(pit.center.x, pit.center.z, pitExtent, 0, pitKey) };
}

// siteWheatField — THE FARM, IN TWO RINGS. Ring one: the pens (FARM_PENS) and the water pool (FARM_FIELD.pool) flank the
// home, each beside it on the surface, clear of everything sited before (siteSurfaceStructure). Ring two: the crop fields,
// the wheat fields and then the cane fields (as many of each as critical mass asks for, fieldKeysSited), each crop one
// cluster of touching copies grown away from the home (siteFieldCluster). Returns { placed, lanes } — every structure
// sited or kept, home and field and all, as { key, box }, and every pen's lane cells (penLane) — or { problem }.
async function siteWheatField(report, toLock, surface, s, crew) {
  const placed = [{ key: s.homeKey, box: s.homeBox }, ...s.clear.filter(c => c.box && !c.run)];
  const clear = [...s.clear, { key: s.homeKey, box: s.homeBox }];
  const pens = [];   // every pen sited so far, { key, mid, out }: the next pen is held apart from each (penApart)
  const lanes = [];  // every pen's lane cells, kept clear of light posts (penLane)
  for (const penKey of FARM_PENS) {
    const pen = await siteSurfaceStructure(report, toLock, surface,
      { ...s, besideKey: s.homeKey, beside: s.homeBox, clear, placed }, penKey, PEN_SITING, pens);
    if (pen.problem) return pen;
    pens.push(pen.pen);
    lanes.push(...penLane(pen.pen));
    clear.push({ key: penKey, box: pen.box });
    placed.push({ key: penKey, box: pen.box });
  }
  const pool = await siteSurfaceStructure(report, toLock, surface,
    { ...s, besideKey: s.homeKey, beside: s.homeBox, clear, placed }, FARM_FIELD.pool, WHEAT_FIELD_SITING);
  if (pool.problem) return pool;
  clear.push({ key: FARM_FIELD.pool, box: pool.box });
  placed.push({ key: FARM_FIELD.pool, box: pool.box });

  // ── RING TWO: every crop field's middle lies farther from the home's middle than the middle of every structure in
  // ring one, beside the farthest of them. Both crops start in it; the wheat first. ──
  const mid = bx => ({ x: (bx.minX + bx.maxX) / 2, z: (bx.minZ + bx.maxZ) / 2 });
  const home = mid(s.homeBox);
  const out = bx => { const m = mid(bx); return Math.hypot(m.x - home.x, m.z - home.z); };
  const outer = placed.filter(p => p.key !== s.homeKey).reduce((far, p) => (!far || out(p.box) > out(far.box) ? p : far), null)
    || { key: s.homeKey, box: s.homeBox };
  const sited = fieldKeysSited(crew);
  const ofCrop = crop => sited.filter(k => k === crop || FARM_FIELD.copyOf[k] === crop);
  for (const crop of [FARM_FIELD.structure, FARM_FIELD.cane]) {
    const cluster = await siteFieldCluster(report, toLock, surface, s, { keys: ofCrop(crop), outer, home, clear, placed });
    if (cluster.problem) return cluster;
  }
  return { placed, lanes };
}

// siteFieldCluster — ONE CROP'S FIELDS, GROWN IN CLUSTERS BY THEIR ATTACH POINTS (the mine's staircase grows the same
// way). The first field stands in ring two: beside the outermost structure of ring one, its middle farther from the
// home's middle than that one's (siteSurfaceStructure), and starts the first cluster. Each copy after it PREFERS TO
// ATTACH to a field already sited: on a side (attach points N, S, E, W) it sets its opposite point on that field's, so
// the two touch and share their edge walkway, and it stands on that field's cluster floor so the shared cells agree. Of
// every open side of every field, only those whose new middle is farther from the home's than the field it attaches to
// are taken (at most three of the four, never back toward the home), the one nearest the home first, so a cluster grows
// outward as a block. A side whose ground fails is passed: land, dry, cut and fill within WHEAT_FIELD_SITING's attach
// bounds, and min_gap from every structure but its own cluster. A copy no side takes STARTS A NEW CLUSTER by the first
// field's rules: in ring two, beside the last field, min_gap from every footprint, on its own floor; it is said with
// every side refused and why. Adds every field to `placed` and `clear`. Returns {} or { problem }.
async function siteFieldCluster(report, toLock, surface, s, { keys, outer, home, clear, placed }) {
  if (keys.length === 0) return {};
  const away = (c, extent) => Math.hypot(c.x + (extent.min_dx + extent.max_dx) / 2 - home.x, c.z + (extent.min_dz + extent.max_dz) / 2 - home.z);
  const ring = Math.hypot((outer.box.minX + outer.box.maxX) / 2 - home.x, (outer.box.minZ + outer.box.maxZ) / 2 - home.z);
  const fields = [];   // { key, origin, box, cluster }: cluster numbers the touching group, whose floor is origin.y
  const first = await siteSurfaceStructure(report, toLock, surface,
    { ...s, besideKey: outer.key, beside: outer.box, clear, placed, admit: (c, extent) => away(c, extent) > ring }, keys[0], WHEAT_FIELD_SITING);
  if (first.problem) return first;
  const building = loadBlueprintDims(keys[0]).building;
  const extent = footprintExtent(building, 0);
  fields.push({ key: keys[0], origin: first.origin, box: first.box, cluster: 0 });
  let clusters = 1;
  const point = id => {
    const p = (building.attach_points || []).find(q => q.id === id);
    if (!p) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): field blueprint '${building.name}' has no attach point '${id}'; a field cluster attaches by N, S, E and W.`);
    return p.position;
  };
  const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const steps = Object.entries(OPPOSITE).map(([side, opp]) => ({ side, dx: point(side)[0] - point(opp)[0], dz: point(side)[2] - point(opp)[2] }));
  const others = clear.slice();   // a cluster's own fields touch one another; everything else keeps its gap
  const { siteBeside } = require('@utils/footprint_survey');
  for (const key of keys.slice(1)) {
    const locked = readLockedCenter(key, s.unlocked);
    if (locked) {
      report.push(`${key}: already locked at (${locked.x},${locked.y},${locked.z}) — kept.`);
      // A kept field joins the cluster of a field it touches by a side, else starts its own.
      const joined = fields.find(f => steps.some(st => f.origin.x + st.dx === locked.x && f.origin.z + st.dz === locked.z && f.origin.y === locked.y));
      fields.push({ key, origin: locked, box: footprintBox(locked.x, locked.z, extent, 0, key), cluster: joined ? joined.cluster : clusters++ });
      continue;
    }
    const taken = new Set(fields.map(f => `${f.origin.x},${f.origin.z}`));
    const sides = [];
    for (const f of fields) {
      for (const st of steps) {
        const c = { x: f.origin.x + st.dx, z: f.origin.z + st.dz };
        if (taken.has(`${c.x},${c.z}`) || sides.some(q => q.c.x === c.x && q.c.z === c.z)) continue;
        if (!(away(c, extent) > away(f.origin, extent))) continue;
        sides.push({ c, from: f, side: st.side, d: away(c, extent) });
      }
    }
    sides.sort((p, q) => p.d - q.d);
    let site = null;
    const refusals = [];
    for (const q of sides) {
      const found = await siteBeside(surface, {
        extent, avoid: q.from.box, minGap: 0, searchTo: 0, scrapeMax: WHEAT_FIELD_SITING.attach_scrape_max, fillMax: WHEAT_FIELD_SITING.attach_fill_max,
        floorOf: () => q.from.origin.y, overTrees: true, admit: c => c.x === q.c.x && c.z === q.c.z,
        clearOf: clearOfAll([...others, ...fields.filter(f => f.cluster !== q.from.cluster)], WHEAT_FIELD_SITING.min_gap),
      });
      if (found.found) { site = { ...found, q }; break; }
      // not_admitted counts every other position of the survey grid; the side's own reason is any other count, or none:
      // it lies within min_gap of a structure outside its cluster.
      const why = Object.entries(found.refused).filter(([k, n]) => n > 0 && k !== 'not_admitted').map(([k]) => k);
      refusals.push(`${q.side} of ${q.from.key}: ${why.length ? why.join('/') : `within ${WHEAT_FIELD_SITING.min_gap} of another structure`}`);
    }
    if (!site) {
      const last = fields[fields.length - 1];
      report.push(`${key}: no open side of the ${fields.length} field(s) before it takes it (${sides.length} side(s) farther from the home tried: ${refusals.join('; ')}); starts a new cluster beside ${last.key}.`);
      const fresh = await siteSurfaceStructure(report, toLock, surface,
        { ...s, besideKey: last.key, beside: last.box, clear: [...others, ...fields.map(f => ({ key: f.key, box: f.box }))], placed,
          admit: (c, ext) => away(c, ext) > ring }, key, WHEAT_FIELD_SITING);
      if (fresh.problem) return fresh;
      fields.push({ key, origin: fresh.origin, box: fresh.box, cluster: clusters++ });
      continue;
    }
    const origin = { x: site.center.x, y: site.center.y, z: site.center.z };
    report.push(`${key}: ATTACHED on the ${site.q.side} side of ${site.q.from.key} at (${origin.x},${origin.y},${origin.z}), floor y${site.floor}, `
      + `${site.scrape} block(s) to cut, ${site.fill} cell(s) to fill.`);
    toLock.push({ spec: { blueprint: key, roomKey: key }, candidate: { transpose_origin: origin, staircase: null, footprint: null } });
    fields.push({ key, origin, box: footprintBox(origin.x, origin.z, extent, 0, key), cluster: site.q.from.cluster });
  }
  for (const f of fields) {
    clear.push({ key: f.key, box: f.box });
    placed.push({ key: f.key, box: f.box });
  }
  return {};
}

// siteSurfaceStructure — one ground-level structure sited on the surface, nearest first (utils/surface_site), `siting.min_gap` or more from
// `s.beside` (the structure it serves) and from every box in `s.clear`. With no spot beside it, the structure is sited
// beside each structure in `s.placed` in turn (home first), the same way, out to twice the search. Returns { box, origin } with
// the structure queued in toLock (or already locked), or { problem }.
// `s.admit` (c, extent) → boolean, when given, is the caller's own rule on a transpose origin c (a cane field's ring).
// A PEN (`pens` given: the pens sited before it) MAY STAND TURNED (transpose_origin.turn) and is held apart from every
// pen before it (penApart): each of its four turns is searched, and the nearest site of any turn that passes wins,
// then the least ground moved. It returns { box, pen }, the pen as the next one is held apart from it.
async function siteSurfaceStructure(report, toLock, surface, s, key, siting, pens = null) {
  const building = loadBlueprintDims(key).building;
  const locked = readLockedCenter(key, s.unlocked);
  if (locked) {
    const extent = footprintExtent(building, turnOf(locked));
    report.push(`${key}: already locked at (${locked.x},${locked.y},${locked.z})${locked.turn ? ` turn ${locked.turn}` : ''} — kept.`);
    return { box: footprintBox(locked.x, locked.z, extent, 0, key), origin: locked, ...(pens ? { pen: penFacing(key, locked, extent) } : {}) };
  }
  const gap = siting.min_gap;
  const clearAll = [...s.clear, ...(s.placed || []).filter(p => !s.clear.some(c => c.key === p.key))];
  const refusedTurns = [];
  let site = { found: false, refused: {}, candidates: 0 };
  for (const turn of pens ? [0, 1, 2, 3] : [0]) {
    const extent = footprintExtent(building, turn);
    const facing = pens ? penFacing(key, { x: 0, y: 0, z: 0, turn }, extent) : null;
    if (pens && pens.some(a => !penApart(a.out, facing.out))) { refusedTurns.push(turn); continue; }
    const admit = pens ? (c => pens.every(a => penApart(a, { mid: { x: c.x + facing.mid.x, z: c.z + facing.mid.z }, out: facing.out })))
      : s.admit ? (c => s.admit(c, extent)) : null;
    let found = await siteOnSurface(surface, {
      extent, avoid: s.beside, minGap: gap, scrapeMax: siting.scrape_max, fillMax: siting.fill_max,
      searchTo: siting.search_to, clearOf: clearOfAll(s.clear, gap), admit,
    });
    for (const other of found.found ? [] : (s.placed || [])) {
      const loose = await siteOnSurface(surface, {
        extent, avoid: other.box, minGap: gap, scrapeMax: siting.scrape_max, fillMax: siting.fill_max,
        searchTo: siting.search_to * 2, clearOf: clearOfAll(clearAll, gap), admit,
      });
      if (!loose.found) continue;
      found = { ...loose, besideKey: other.key };
      break;
    }
    if (!found.found) {
      for (const [k, v] of Object.entries(found.refused)) site.refused[k] = (site.refused[k] || 0) + v;
      site.candidates += found.candidates;
      continue;
    }
    found = { ...found, turn, extent };
    // Beside the structure it serves beats beside another; then the nearest gap, then the least ground moved.
    const rank = q => [q.besideKey ? 1 : 0, q.gap, q.scrape + q.fill];
    const better = !site.found || (() => {
      const [a, b] = [rank(found), rank(site)];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
      return false;
    })();
    if (better) site = found;
  }
  if (site.found && site.besideKey) report.push(`${key}: no spot beside ${s.besideKey}; sited beside ${site.besideKey} instead.`);
  if (refusedTurns.length) report.push(`${key}: turn(s) ${refusedTurns.join('/')} passed over — the standby side does not face opposite a pen sited before (${PEN_SITING.apart_degrees}°).`);
  if (!site.found) {
    const r = site.refused;
    report.push(`${key}: ✗ NOT FOUND within ${gap}-${siting.search_to} blocks of ${s.besideKey} over ${site.candidates} position(s) `
      + `clear of ${clearNames(s.clear)} by ${gap}+ — refused: ${r.not_land || 0} not land, ${r.water_near || 0} within ${WATER_CLEARANCE} of water, ${r.trunk || 0} on a tree trunk, `
      + `${r.too_uneven || 0} with ground more than ${siting.scrape_max} over or ${siting.fill_max} under its middle height`
      + `${pens ? `, ${r.not_admitted || 0} not behind a pen sited before (${PEN_SITING.behind_degrees}° from its standby side)` : ''}`
      + `${s.admit ? `, ${r.not_admitted || 0} nearer the home than ${s.besideKey}` : ''}.`);
    return { problem: `${key}: NOT FOUND beside ${s.besideKey} — no dry spot within ${siting.scrape_max} layers of cut and ${siting.fill_max} of fill ${gap}+ blocks from every other footprint${pens ? ', held apart from every pen sited before' : ''}.` };
  }
  const origin = { ...site.center, ...(site.turn ? { turn: site.turn } : {}) };
  const pen = pens ? penFacing(key, origin, site.extent) : null;
  report.push(`${key}: FOUND at (${site.center.x},${site.center.y},${site.center.z}), ${site.gap} blocks from ${site.besideKey || s.besideKey}'s footprint, `
    + `floor y${site.floor} (${s.homeKey} floor y${s.homeFloor}), ${site.scrape} block(s) to cut, ${site.fill} cell(s) to fill`
    + `${pen ? `, turn ${site.turn}, standby side ${compassOf(pen.out)}` : ''}.`);
  toLock.push({ spec: { blueprint: key, roomKey: key }, candidate: { transpose_origin: origin, staircase: null, footprint: null } });
  return { box: footprintBox(site.center.x, site.center.z, site.extent, 0, key), origin, ...(pen ? { pen } : {}) };
}

// ── THE PENS STAND APART FROM THEIR STANDBY CELLS ─────────────────────────────────────────────────────────────────
// A pen's standby cell lies out from its gate on the gate's axis (pen_gate tendingCells), and a bringer leads its flock
// in along that axis with wheat in hand. Two pens side by side with their gates on the same side share that ground, and
// each lead draws the other pen's flock. So of every two pens:
//   - their standby sides face PEN_SITING.apart_degrees (180) apart: one pen's gate east, the other's west;
//   - each stands behind the other: from a pen's middle, the other pen's middle lies PEN_SITING.behind_degrees or
//     more round from that pen's standby side.
// penFacing(key, origin, extent) → { key, mid, out }: the footprint's middle and the unit step from the gate out to
// the standby cell, for `key` locked at `origin` (its turn included).
function penFacing(key, origin, extent) {
  const { penAt, penGeometry } = require('@api/pen_gate');
  const geo = penGeometry(penAt(key, origin));
  return { key, mid: { x: origin.x + (extent.min_dx + extent.max_dx) / 2, z: origin.z + (extent.min_dz + extent.max_dz) / 2 }, out: geo.axis, gate: { x: geo.gate.x, z: geo.gate.z } };
}
// THE PEN'S LANE: the ground a herd walks and its flock follows, from the gate out along its axis past the standby cell
// (HERDING.park_blocks, and the span pen_gate.axisCell may slide it on), LANE_HALF_WIDTH to each side. A light post there
// is a build block no axis clearing may dig, standing in the flock's way. penLane(pen) → [{ x, z }].
const LANE_HALF_WIDTH = 1;
const LANE_SLIDE = 4;
function penLane(pen) {
  const { HERDING } = require('@thinking/architect_config');
  const { gate: g, out: n } = pen, side = { x: -n.z, z: n.x };
  const cells = [];
  for (let k = 1; k <= HERDING.park_blocks + LANE_SLIDE; k++) {
    for (let w = -LANE_HALF_WIDTH; w <= LANE_HALF_WIDTH; w++) cells.push({ x: g.x + n.x * k + side.x * w, z: g.z + n.z * k + side.z * w });
  }
  return cells;
}
// penApart(a, b) → true when pens a and b ({ mid, out }) keep the rule above; given two bare steps, whether the
// standby sides alone face far enough apart.
function penApart(a, b) {
  const limit = Math.cos(PEN_SITING.apart_degrees * Math.PI / 180) + 1e-9;
  const behind = Math.cos(PEN_SITING.behind_degrees * Math.PI / 180) + 1e-9;
  const cos = (u, v) => (u.x * v.x + u.z * v.z) / ((Math.hypot(u.x, u.z) * Math.hypot(v.x, v.z)) || 1);
  if (!a.mid) return cos(a, b) <= limit;
  const ab = { x: b.mid.x - a.mid.x, z: b.mid.z - a.mid.z }, ba = { x: -ab.x, z: -ab.z };
  return cos(a.out, b.out) <= limit && cos(a.out, ab) <= behind && cos(b.out, ba) <= behind;
}
const compassOf = n => (n.z < 0 ? 'north' : n.z > 0 ? 'south' : n.x > 0 ? 'east' : 'west');

// siteShaft(bot, g, avoid) — the standalone shallow shaft: the mouth nearest the home (avoid[0]) whose
// whole diagonal keeps SHAFT_SITING.min_gap from every box in `avoid` and passes the one judgment every shaft takes
// (building_site_overlays.evaluateStaircaseFrom: no fluid, no cave, the whole way to the floor). The mouth is a
// trunk-free land column WATER_CLEARANCE from water, as a headframe's footprint is (footprint_survey.wetNear); only
// the opening differs: no headframe over it, and the descent runs east. Candidates are walked nearest-first, stopping
// at the first that passes.
// THE MOUTH IS NEAREST THE HOME: every ore trip walks from the home's chests to the mouth and back, so the mouth's
// own distance from the home is the walk a trip pays on the surface; the stairs below it are the same length
// wherever it stands.
const SHAFT_SEARCH_BEYOND = 64;   // how far past min_gap the search reaches, measured to the home
const SHAFT_WALK_LIMIT = 2000;    // mouths hazard-walked before the search gives up and says so
async function siteShaft(bot, g, avoid) {
  const { projectStaircase } = require('@perception/mining_blueprinter');
  const { evaluateStaircaseFrom } = require('@utils/building_site_overlays');
  const { LAND, wetNear } = require('@utils/footprint_survey');
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
  const refused = { too_shallow: 0, water_near: 0 };
  const wet = wetNear(g);
  const cands = [];
  for (let z = g.z0; z < g.z0 + g.D; z++) {
    for (let x = g.x0; x < g.x0 + g.W; x++) {
      const i = (z - g.z0) * g.W + (x - g.x0);
      if (g.kind[i] !== LAND || g.trunk[i]) continue;
      if (wet(x, x, z, z)) { refused.water_near++; continue; }
      const y = g.height[i];
      const rr = reach(y);
      if (!rr) { refused.too_shallow++; continue; }
      const box = { minX: x + rr.dx0, maxX: x + rr.dx1, minZ: z + rr.dz0, maxZ: z + rr.dz1 };
      if (box.minX < g.x0 || box.maxX >= g.x0 + g.W || box.minZ < g.z0 || box.maxZ >= g.z0 + g.D) continue;   // the run leaves the loaded area
      const gaps = avoid.map(a => ({ key: a.key, gap: Math.round(gapOf(box, a.box) * 10) / 10 }));
      if (gaps.some(q => q.gap < SHAFT_SITING.min_gap)) continue;
      if (gaps[0].gap > SHAFT_SITING.min_gap + SHAFT_SEARCH_BEYOND) continue;
      cands.push({ top: { x, y, z }, gaps, mouth: gapOf({ minX: x, maxX: x, minZ: z, maxZ: z }, avoid[0].box), voxels: rr.voxels });
    }
  }
  cands.sort((a, b) => a.mouth - b.mouth || a.gaps[0].gap - b.gaps[0].gap);
  // The nearest mouth whose descent passes; none inside the walk limit is NOT FOUND, and the landing rolls again.
  // A mouth with a route for the deep shaft is taken first; without one, the nearest that passed.
  const { route_tries } = require('@thinking/architect_config').SHAFT_TURNS;
  let tried = 0, passed = 0, nearest = null;
  for (const c of cands) {
    if (tried >= SHAFT_WALK_LIMIT) break;
    await pace();
    tried++;
    const st = evaluateStaircaseFrom(bot, c.top, c.top.y);
    if (!st.ok) { refused[st.reason] = (refused[st.reason] || 0) + 1; continue; }
    const hit = { found: true, ...c, staircase: st, tried, candidates: cands.length };
    if (st.deep) return hit;
    nearest = nearest || hit;
    if (++passed > route_tries) break;
  }
  return nearest || { found: false, refused, tried, candidates: cands.length };
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
// `species` is passed in, not sensed — the foreman has no mandate to ask (Invariant B).
// surveyOrigin(bot, surveyFrom) — the cell every search walks outward from. The foreman's own post sits
// inside the spawn-protected square, which reads as bedrock (`spawn_protection.maskWorldReads`), so a
// dry run is given the landing cell as origin. Default stays the body's own position.
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
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: run() needs a body with a position. The bot must be registered before the batch runs.`);
  }
  const species = opts.species || require('@kernel/bot_mandate').currentMode();
  // Carried as an argument, not a module flag — a flag is process state two callers could share and one
  // forget to clear, silently blinding a body to its own HQ (Law 8). `origin` rides the same way.
  const unlocked = opts.held instanceof Map ? opts.held : !!opts.unlockedWorld;
  return runLayout(bot, true, species, unlocked, opts.origin || null, opts.build || null);
}

// hungShaftBox(homeKey, center, lowestSafeY) — the horizontal reach of the staircase hung from the home's attach A
// at `center`, down to lowestSafeY: the ground a later site keeps clear of.
function hungShaftBox(homeKey, center, lowestSafeY) {
  const { transposeAttachPoints } = require('@perception/blueprint_survey');
  const { projectStaircase } = require('@perception/mining_blueprinter');
  const head = require('@kernel/blueprint_registry').getBuilding(homeKey, TAG);
  const headAWorld = transposeAttachPoints(head, center).A;
  if (!headAWorld) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): '${homeKey}' has no attach point A for its shaft to hang from.`);
  const box = { minX: headAWorld.x, maxX: headAWorld.x, minZ: headAWorld.z, maxZ: headAWorld.z };
  for (const seg of projectStaircase({ headAWorld, lowestSafeY: Math.max(lowestSafeY, STAIRCASE_SAFETY.REQUIRED_DEPTH_Y), turn: center.turn || 0 }).segments) {
    for (const v of seg.voxels) {
      box.minX = Math.min(box.minX, v[0]); box.maxX = Math.max(box.maxX, v[0]);
      box.minZ = Math.min(box.minZ, v[2]); box.maxZ = Math.max(box.maxZ, v[2]);
    }
  }
  return box;
}

// ── 6. THE LIGHTS ─────────────────────────────────────────────────────────────────────────────────────────────
// siteLights — the base's spawn proofing (SPAWN_PROOFING): torch posts painted over the ground round every structure in `placed` (base_layout.paintLights), queued with its lights on its row. A pad already locked
// is kept. No post or its stand goes on a pen's lane (`lanes`, penLane). Returns {} or { problem } when the posts leave a
// stand cell dark.
function siteLights(report, toLock, surface, placed, unlocked, lanes = []) {
  const proofingKey = SPAWN_PROOFING;
  if (readLockedCenter(proofingKey, unlocked)) {
    report.push(`${proofingKey}: already locked — kept.`);
    return {};
  }
  const t0 = Date.now();
  const paint = require('@kernel/base_layout').paintLights(surface, placed.map(p => p.box), lanes);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const r = paint.rect;
  if (paint.dark.length) {
    report.push(`${proofingKey}: ✗ ${paint.dark.length} of ${paint.stands} stand cell(s) left dark by ${paint.lights.posts.length} post(s) (limit ${BASE_LIGHTS.limit}), first (${paint.dark[0]}).`);
    return { problem: `${proofingKey}: the base's ground cannot be lit — ${paint.dark.length} stand cell(s) no post reaches.` };
  }
  report.push(`${proofingKey}: LIT ${r.maxX - r.minX + 1}x${r.maxZ - r.minZ + 1} area from (${r.minX},${r.minZ}), ${paint.stands} stand cell(s), `
    + `${paint.lights.posts.length} torch post(s) (${paint.grid} on the ${BASE_LIGHTS.every}-block grid, ${paint.added} where it left dark), in ${secs}s.`);
  toLock.push({ spec: { blueprint: proofingKey, roomKey: proofingKey }, candidate: { transpose_origin: paint.origin, staircase: null, footprint: null, lights: paint.lights } });
  return {};
}

// siteRow — one surveyed-and-passing structure as the foreman hands it to a body: the plain room name (the
// crew half is the body's own), the blueprint, and the four candidate fields `lock` writes.
function siteRow({ spec, candidate }) {
  const bc = candidate.transpose_origin;
  return {
    blueprint: spec.blueprint,
    roomKey: spec.roomKey,
    // A downloaded blueprint (the builder's castle) is not in the hand-authored registry site_chairs counts from,
    // so its size rides on the row. Absent for every hand-authored blueprint.
    ...(spec.total_voxels ? { total_voxels: spec.total_voxels } : {}),
    candidate: {
      transpose_origin: { x: bc.x, y: bc.y, z: bc.z, ...(bc.turn ? { turn: bc.turn } : {}) },
      footprint: candidate.footprint || null,
      staircase: candidate.staircase || null,
      ...(candidate.lights ? { lights: candidate.lights } : {}),
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

  // Where the base will sit, returned, not only logged — the foreman lands its crew there before it
  // spawns anybody, and can only know it from a dry run. The seat is the crew's ALPHA STRUCTURE
  // (architect_config.ALPHA_STRUCTURE) — the one building a person would point at and call the base.
  const alphas = Object.values(ALPHA_STRUCTURE);
  const anchorOf = (rows) => {
    const seat = rows.find(t => alphas.includes(t.spec.roomKey)) || rows[0];
    const c = seat && seat.candidate && seat.candidate.transpose_origin;
    return c ? { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) } : null;
  };

  // The site itself, returned so the foreman's hub can write it. Each row carries exactly the fields
  // `site_chairs.siteChairs` reads, and nothing else the survey computed on the way.
  watcher.summary(TAG, `Survey: all ${toLock.length} blueprint(s) would lock (nothing written here — the foreman's hub writes the site).`);
  return { ok: true, dryRun: true, report, locked: [], anchor: anchorOf(toLock), site: toLock.map(siteRow) };
}

module.exports = {
  run,
  baseLayoutComplete,
};
