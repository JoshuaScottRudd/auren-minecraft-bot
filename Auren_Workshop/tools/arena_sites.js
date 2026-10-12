// arena_sites — the arena's three questions, asked as a CYCLE that yields disjoint pairs.
//
//   Q1  WHERE CAN THE BOT STAND?      expanding-ring sweep from the origin → an open box.
//   Q2  WHERE CAN A MONSTER STAND?    a second sweep, anchored on that box, within a distance band →
//                                     every open box in it, not just the nearest.
//   Q3  WHICH OF THOSE CAN SEE IT?    the aggro raycast per candidate → the set splits in two.
//
// Q2 anchors on Q1's box; Q3 runs last as the only expensive question, inside the ring sweep's per-cell
// test, so a barren anchor advances the sweep instead of ending it.
//
// A pair (bot box + partner box) retires both boxes from the pool once emitted. Each emitted pair also
// carries the FULL band split — the hidden boxes are what the counter-aggro half of the bench spawns into.
//
// Terrain survives only as a LABEL (`describeSite`); it gates only when a caller declares a `ground` dial.
//
// Every part of the scan is `@utils/site_geometry` (the column read, the footprint test, the expanding
// ring), shared with find_buildingspot (Law 16); this file supplies the three questions and their cycle.
'use strict';

// Registers the construct's alias space so @kernel/blueprint_registry resolves here as it does
// everywhere else (Law 16). Idempotent, so lanista and the headless bench both boot it safely.
const paths = require('../workshop_paths');
paths.registerAliases();

const geo = require(paths.bot('js_kernel/utils/site_geometry'));
const blueprintRegistry = require('@kernel/blueprint_registry');

// The spawn box's shape, read from the blueprint registry, so the arena's footprint is retuned by
// editing the blueprint file. Also a DIAL, swappable per call — see THE TWO DIALS below.
const SPAWN_BLUEPRINT = 'spawn_box';

// ── THE TWO DIALS UNDER TEST ────────────────────────────────────────────────────────────────────────
// Two independent ways to loosen the box predicate:
//   FOOTPRINT (`blueprint`) — how much ground the box needs.
//   FLATNESS  (`flatness`)  — how level that ground must be. `span` caps total relief at 1; `stepwise`
//                             allows ±1 from the centre provided no two touching cells are 2 apart.
// Both default to the STRICT setting (Law 25 — meet the criterion before loosening it).
const DEFAULTS = {
  blueprint: SPAWN_BLUEPRINT,
  flatness: geo.FLATNESS.SPAN,
  maxStep: 1,          // one block: the height a body climbs or drops in a single move. STEPWISE only.
  maxVariance: 1,      // span: total relief cap. stepwise: how far a cell may sit from the CENTRE.
  minDistance: 10,     // lower bound of the monster spawn distance band
  maxDistance: 15,     // upper bound
  botSearchStep: 2,    // stride for Q1 — a 3-wide box, so 2 covers ground without redundant overlap
  bandStep: 1,         // stride for Q2 — every open box in the band, so this one is exhaustive
  aggroRange: 15,      // architect_config's AGGRO_RANGE; the raycast clamp is derived from it
  pairs: 1,            // how many disjoint arenas to gather in one cycle
  // Minimum gap between two arenas, beyond the footprint clearance below. Set to 0 to allow touching
  // arenas (still non-overlapping; the footprint guard is separate).
  arenaSpacing: 15,
};

// makeReader — the adapter site_geometry's seam expects: the scout takes a plain object, a mineflayer
// bot wants a Vec3. Keeping it at the caller lets the shared module carry no vec3 dependency.
const readerFromScout = scout => ({ blockAt: (x, y, z) => scout.blockAt({ x, y, z }) });

// spawnBoxShape — the blueprint's dimensions as the footprint test wants them. `h` counts the floor
// layer; `evaluateOpenBox` wants the CLEAR count measured upward from it, hence height = d.h - 1. The
// checks below are Law 13 preconditions: a malformed blueprint fails loud instead of being scanned as a
// different shape.
function spawnBoxShape(name = DEFAULTS.blueprint) {
  const b = blueprintRegistry.getBuilding(name, 'arena_sites');
  const d = b.dimensions;
  if (!d || typeof d.w !== 'number' || typeof d.h !== 'number' || typeof d.l !== 'number') {
    throw new Error(`[arena_sites] CODING VIOLATION: blueprint "${name}" has missing or invalid dimensions. Requires { w, h, l }.`);
  }
  if (d.w !== d.l) {
    throw new Error(`[arena_sites] CODING VIOLATION: blueprint "${name}" is ${d.w}x${d.l}; the spawn box must be square (the footprint test takes one size).`);
  }
  if (d.w % 2 !== 1) {
    throw new Error(`[arena_sites] CODING VIOLATION: blueprint "${name}" is ${d.w} wide; the footprint is built outward from a centre cell, so the size must be odd (an even box has no centre to drop a body at).`);
  }
  if (d.h < 2) {
    throw new Error(`[arena_sites] CODING VIOLATION: blueprint "${name}" has h=${d.h}; h counts the floor layer, so it must be at least 2 to leave one clear cell above it.`);
  }
  return { name, size: d.w, height: d.h - 1, totalHeight: d.h };
}

// resolveOpts — merges the blueprint shape in once, so no function below re-reads the registry.
function resolveOpts(opts = {}) {
  const shape = opts.shape || spawnBoxShape(opts.blueprint || DEFAULTS.blueprint);
  return { ...DEFAULTS, ...opts, boxSize: shape.size, boxHeight: shape.height, shape };
}

// The box memo's key carries the PREDICATE, not just the cell, so two different-option scans of the
// same ground never share a cached answer meant for the other (Law 26).
const cellKey = (x, z, refY, o) => `${x},${z}@${refY}#${o.boxSize}x${o.boxHeight}/${o.flatness}/${o.maxVariance}/${o.maxStep}`;
const pairKey = (a, b) => {
  const ka = `${a.x},${a.y},${a.z}`, kb = `${b.x},${b.y},${b.z}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;   // unordered: the reverse cast is never a second entry
};

// ── The memo ────────────────────────────────────────────────────────────────────────────────────────
// One cache per cycle: box and raycast results, plus per-call `stats`. refY is part of the box key
// because `floorNearest` resolves to the floor nearest the observer's level, so the same (x,z) answers
// differently for a surface anchor and a cave anchor.
function createSiteCache() {
  const boxes = new Map();
  const rays = new Map();
  const routes = new Map();
  const sites = new Map();
  const barren = new Set();
  const stats = { boxCalls: 0, boxHits: 0, losCalls: 0, losHits: 0, reachCalls: 0, reachHits: 0, siteCalls: 0, siteHits: 0 };

  return {
    // Terrain description, memoised by box centre (including y): the same (x,z) describes different
    // ground at a surface anchor and a cave one.
    site(reader, box) {
      const k = `${box.x},${box.y},${box.z}`;
      stats.siteCalls++;
      if (sites.has(k)) { stats.siteHits++; return sites.get(k); }
      const res = describeSite(reader, box);
      sites.set(k, res);
      return res;
    },
    box(reader, x, z, refY, o) {
      const k = cellKey(x, z, refY, o);
      stats.boxCalls++;
      if (boxes.has(k)) { stats.boxHits++; return boxes.get(k); }
      const res = geo.evaluateOpenBox(reader, x, z, refY, {
        size: o.boxSize, height: o.boxHeight,
        maxVariance: o.maxVariance, flatness: o.flatness, maxStep: o.maxStep,
      });
      boxes.set(k, res);
      return res;
    },
    los(from, to, losImpl, maxDist) {
      const k = pairKey(from, to);
      stats.losCalls++;
      if (rays.has(k)) { stats.losHits++; return rays.get(k); }
      const verdict = losImpl.check(from, to, maxDist);
      rays.set(k, verdict);
      return verdict;
    },
    // Reachability memo, keyed on the unordered pair: with `allowWorldAlteration: false` every move is
    // reversible, so A→B passable ⟺ B→A passable and the reverse search never runs.
    async reach(from, to, reachImpl) {
      const k = pairKey(from, to);
      stats.reachCalls++;
      if (routes.has(k)) { stats.reachHits++; return routes.get(k); }
      const verdict = await reachImpl.check(from, to);
      routes.set(k, verdict);
      return verdict;
    },
    markBarren: (x, z) => barren.add(`${x},${z}`),
    isBarren: (x, z) => barren.has(`${x},${z}`),
    stats: () => ({ ...stats, cachedBoxes: boxes.size, cachedRays: rays.size, cachedRoutes: routes.size, barrenAnchors: barren.size }),
  };
}

// ── Q1: can I spawn a bot here? ─────────────────────────────────────────────────────────────────────
// The nearest open box to the origin. The cycle below does not call this directly — it uses the
// stricter arena test built below.
async function findBotSpawn(reader, origin, opts = {}) {
  const o = resolveOpts(opts);
  const cache = o.cache || createSiteCache();
  const scan = await geo.ringScan(reader, {
    origin, step: o.botSearchStep, maxRadius: o.maxRadius, pace: o.pace,
  }, (x, z) => cache.box(reader, x, z, origin.y, o));

  if (!scan.found) return { found: false, scan, reason: geo.formatRejections(scan.rejections) };
  return { found: true, box: boxFrom(scan.best), distance: scan.best.distance, scan };
}

const boxFrom = m => ({
  x: m.x, z: m.z, y: m.result.spawnY, floorY: m.result.floorY,
  sky: m.result.sky, floorNames: m.result.floorNames, distance: m.distance,
});

// ── Q2: from the bot spawn, where can monsters stand? ───────────────────────────────────────────────
// Every open box in the band, not just the nearest, so a scenario can pick a bearing and reproduce the
// same fight. Anchored on the bot's box, so the authored distance band measures from the bot.
async function findOpponentSpawns(reader, botBox, opts = {}) {
  const o = resolveOpts(opts);
  const cache = o.cache || createSiteCache();
  const excluded = o.excluded;

  const scan = await geo.ringScan(reader, {
    origin: { x: botBox.x, z: botBox.z },
    step: o.bandStep,
    minRadius: o.minDistance,
    maxRadius: o.maxDistance,
    all: true,
    pace: o.pace,
    // True annulus on real distance: the ring stride yields cells whose Chebyshev radius is in range
    // but whose euclidean distance may not be, so distance is checked here explicitly.
    accept: ({ distance }) => distance >= o.minDistance && distance <= o.maxDistance,
  }, (x, z) => (excluded && excluded(x, z))
    ? { valid: false, reason: 'retired' }        // already inside an emitted pair — not re-testable
    : cache.box(reader, x, z, botBox.y, o));

  return { boxes: scan.matches.map(boxFrom), scan };
}

// ── Q3: which of those can REACH the bot, and then see it? ──────────────────────────────────────────
// Reachability gates before visibility: reachability is the criterion a pair must meet, and visibility
// only decides which half of the bench a reachable pair serves. Pillar-stepping and any move needing
// digging or placing is excluded.
//
// `reach` is injected — { check(fromFloorCell, toFloorCell) → { known, reachable, cost, steps,
// edgeTypes } } — optional; absent, the gate does not run. Cells are FLOOR cells, one below a box's `y`
// (the spawn/feet cell); the caller building the seam owns that conversion.
// `los` is injected — { check(fromCell, toCell, maxDist) → { known, clear } }, the same predicate
// threat_scanner uses (camera_scout.aggroLineOfSight / terrain_predicates.hasLineOfSight). Cast
// bot → monster, cached unordered so the reverse cast never runs.
// `unknown` is a third bucket, distinct from `hidden`: an unloaded endpoint means nobody looked, so it
// never satisfies a quota (Laws 23, 25).
//
// `wantVisible`/`wantHidden` stop the scan once each bucket has what the caller needs. Boxes are sorted
// nearest-first, so an early exit still yields the nearest visible box. `partitionByLineOfSight` is the
// same call with both quotas at Infinity (Law 16).
async function probePartners(opponents, botBox, los, opts = {}) {
  const o = resolveOpts(opts);
  const cache = o.cache || createSiteCache();
  const reach = o.reach || null;
  const wantVisible = o.wantVisible === undefined ? Infinity : o.wantVisible;
  const wantHidden = o.wantHidden === undefined ? Infinity : o.wantHidden;
  const from = { x: botBox.x, y: botBox.y, z: botBox.z };

  const visible = [], hidden = [], unknown = [], unreachable = [], unknownReach = [];
  const ordered = opponents.slice().sort((a, b) => a.distance - b.distance);
  let cast = 0, pathed = 0;

  for (const candidate of ordered) {
    if (visible.length >= wantVisible && hidden.length >= wantHidden) break;
    const to = { x: candidate.x, y: candidate.y, z: candidate.z };
    let box = candidate;

    // Gate before the cast: a box that fails it is never raycast. `pathed` is what the gate cost,
    // `cast` is what survived it.
    if (reach) {
      pathed++;
      const route = await cache.reach(from, to, reach);
      // A route that ran out of budget proved nothing, so `unknownReach` never satisfies a quota
      // (Laws 23, 25).
      if (!route.known) { unknownReach.push({ ...candidate, reach: route }); continue; }
      if (!route.reachable) { unreachable.push({ ...candidate, reach: route }); continue; }
      box = { ...candidate, reach: route };
    }

    cast++;
    const verdict = cache.los(from, to, los, o.aggroRange);
    const entry = { ...box, los: verdict };
    // `unknown` never satisfies a quota (Laws 23, 25).
    if (!verdict.known) unknown.push(entry);
    else if (verdict.clear) visible.push(entry);
    else hidden.push(entry);
  }
  return { visible, hidden, unknown, unreachable, unknownReach, cast, pathed, offered: ordered.length };
}

function partitionByLineOfSight(opponents, botBox, los, opts = {}) {
  return probePartners(opponents, botBox, los, { ...opts, wantVisible: Infinity, wantHidden: Infinity });
}

// ── The cycle ───────────────────────────────────────────────────────────────────────────────────────
// findArenaPairs — sweep bot anchors nearest-first; for each, try to complete a pair; emit it and
// retire both boxes; keep going until `pairs` arenas are found or the loaded frontier is reached.
// Re-runs the ring sweep once per pair; the re-walk is nearly free since every revisited cell is a memo
// hit, and pairs stay ordered nearest-first.
async function findArenaPairs(reader, origin, los, opts = {}) {
  const o = resolveOpts(opts);
  const cache = o.cache || createSiteCache();
  const want = o.pairs;

  const retired = [];   // committed box centres — {x, z}
  const pairs = [];
  const barrenReasons = {};

  // A cell is out if inside a retired box's footprint, or within arenaSpacing of one.
  const clearance = Math.max(o.boxSize, o.arenaSpacing);
  const isRetired = (x, z) => retired.some(r => Math.hypot(x - r.x, z - r.z) < clearance);

  // The anchor test asks whether an ARENA exists here, not merely an open box: Q2 and Q3 run inside it,
  // so a barren anchor advances the sweep instead of ending it.
  const evaluateAnchor = async (x, z) => {
    if (cache.isBarren(x, z)) return { valid: false, reason: 'barren_anchor' };
    if (isRetired(x, z)) return { valid: false, reason: 'retired' };

    const box = cache.box(reader, x, z, origin.y, o);
    if (!box.valid) return box;

    const botBox = boxFrom({ x, z, distance: Math.hypot(x - origin.x, z - origin.z), result: box });

    // ── THE GROUND GATE, SECOND AND ONLY IF DECLARED ─────────────────────────────────────────────
    // Runs only for callers that declare a `ground` dial (Law 25); terrain otherwise stays a LABEL, not
    // a gate. Runs before the opponent sweep and reach gate, so a ground rejection is cheap. A refusal
    // marks the anchor barren and returns a reason.
    let ground = null;
    if (o.ground) {
      ground = cache.site(reader, botBox);
      const bad = groundShortfall(ground, o.ground);
      if (bad) {
        cache.markBarren(x, z);
        barrenReasons.ground = (barrenReasons.ground || 0) + 1;
        // Last reason kept, not a tally — one example of what the ground dial rejected.
        barrenReasons.groundWhy = bad;
        return { valid: false, reason: 'ground', detail: bad };
      }
    }

    const opp = await findOpponentSpawns(reader, botBox, { ...o, cache, excluded: isRetired });
    if (!opp.boxes.length) {
      cache.markBarren(x, z);
      barrenReasons.no_opponent_box = (barrenReasons.no_opponent_box || 0) + 1;
      return { valid: false, reason: 'no_opponent_box' };
    }

    // One visible box is the fight, one hidden box is the decline — the full sightline requirement of a run.
    const split = await probePartners(opp.boxes, botBox, los, {
      ...o, cache, wantVisible: 1, wantHidden: o.wantHidden === undefined ? 1 : o.wantHidden,
    });
    if (!split.visible.length) {
      cache.markBarren(x, z);
      // Two buckets, counted apart: a band the reach gate refused entirely (`walled`) versus one whose
      // passable neighbours were all out of sight (`no_sightline`). Both `unreachable` and `unknownReach`
      // count toward `walled`; a budget-exhausted search lands in `unknownReach`, not `unreachable`
      // (Law 25).
      const walled = o.reach && !split.cast && (split.unreachable.length + split.unknownReach.length);
      const key = walled ? 'no_reachable_box' : 'no_sightline';
      barrenReasons[key] = (barrenReasons[key] || 0) + 1;
      return { valid: false, reason: key };
    }

    // The nearest visible box is the partner (guaranteed by the sort inside probePartners).
    return { valid: true, botBox, partner: split.visible[0], split, opponentScan: opp.scan, site: ground };
  };

  let lastScan = null;
  for (let i = 0; i < want; i++) {
    const scan = await geo.ringScan(reader, {
      origin, step: o.botSearchStep, maxRadius: o.maxRadius, pace: o.pace,
    }, evaluateAnchor);
    lastScan = scan;
    if (!scan.found) break;

    const r = scan.best.result;
    retired.push({ x: r.botBox.x, z: r.botBox.z }, { x: r.partner.x, z: r.partner.z });
    pairs.push({
      bot: r.botBox,
      opponent: r.partner,
      distance: r.partner.distance,
      los: r.partner.los,
      band: r.split,
      // What the band offered, how many were pathfound at, cast at, and thrown out by the gate.
      // `pathed` is 0 with no reach seam injected.
      probe: {
        offered: r.split.offered, pathed: r.split.pathed, cast: r.split.cast,
        unreachable: r.split.unreachable.length, unknownReach: r.split.unknownReach.length,
      },
      // Reused from the ground gate when one ran, so the column read is paid once per emitted arena.
      site: r.site || describeSite(reader, r.botBox),
      originDistance: scan.best.distance,
    });
  }

  return {
    ok: pairs.length > 0,
    pairs,
    // Law 25: a short cycle is reported as short, never as a success flag over a partial.
    complete: pairs.length === want,
    requested: want,
    detail: pairs.length === want ? null : describeShortfall(pairs.length, want, lastScan, barrenReasons),
    cache: cache.stats(),
    scan: lastScan,
  };
}

// describeShortfall — which wall the cycle hit, in the caller's terms: unusable ground, walled bands,
// or blocked sightlines.
function describeShortfall(got, want, scan, barrenReasons) {
  const parts = [`found ${got} of ${want} arena(s)`];
  if (scan) {
    parts.push(scan.bounded
      ? `sweep stopped at the caller's maxRadius (${scan.reachedRadius}b), not the loaded frontier`
      : `swept to the loaded frontier at ${scan.reachedRadius}b, ${scan.checked} anchor(s) tested`);
    parts.push(`anchor wall: ${geo.formatRejections(scan.rejections)}`);
  }
  if (barrenReasons.no_opponent_box) parts.push(`${barrenReasons.no_opponent_box} anchor(s) had an open box but no opponent box in the band`);
  if (barrenReasons.no_reachable_box) parts.push(`${barrenReasons.no_reachable_box} anchor(s) had opponent boxes but the reach gate passed none of them (no route, or none found within its search budget)`);
  if (barrenReasons.no_sightline) parts.push(`${barrenReasons.no_sightline} anchor(s) had passable opponent boxes but no clear line to any of them`);
  // Named separately: an arena the ground dial refused was a complete, valid arena the sweep passed over
  // on purpose.
  if (barrenReasons.ground) parts.push(`${barrenReasons.ground} complete arena(s) refused by the ground dial (${barrenReasons.groundWhy || 'see the dial'})`);
  return parts.join('; ');
}

// ── The terrain LABEL (not a gate) ──────────────────────────────────────────────────────────────────
// Terrain decides nothing about validity — the twin-box test does — but a found arena carries this
// description so runs can be spread across mountains, rivers, caves, forest and flat ground.
const LABEL = {
  SURFACE: 'surface', CAVE: 'cave', MOUNTAIN: 'mountain', FLAT: 'flat', ROLLING: 'rolling',
  HIGH_GROUND: 'high_ground', LOW_GROUND: 'low_ground', WATERSIDE: 'waterside', FOREST: 'forest',
};

// groundShortfall(site, dial) → a sentence naming what failed, or null if the ground passes.
// Reads `site.pct`, never `site.notes` — the notes string is a rendering for a human, and the gate must
// consume the value directly (Law 26). An unreadable site fails the gate (Law 13 — default stopped).
function groundShortfall(site, dial) {
  if (!site || site.relief === undefined || !site.pct) return 'terrain unreadable';
  if (dial.maxRelief !== undefined && site.relief > dial.maxRelief) {
    return `relief Δ${site.relief} over the Δ${dial.maxRelief} ceiling`;
  }
  const caps = { water: dial.maxWaterPct, canopy: dial.maxCanopyPct, roofed: dial.maxRoofedPct };
  for (const [key, cap] of Object.entries(caps)) {
    if (cap === undefined) continue;
    const got = Math.round(site.pct[key] * 100);
    if (got > cap) return `${key} ${got}% over the ${cap}% ceiling`;
  }
  return null;
}

// describeSite — samples a 3-block grid out to `radius` around the box, producing the terrain fractions
// used by both the LABEL tags and the ground gate. Radius is wider than the spawn box because the label
// describes the fight's ground, not just the 3×3 the bot spawns in.
function describeSite(reader, box, radius = 12) {
  const heights = [], names = {};
  let water = 0, canopy = 0, roofed = 0, cells = 0, stone = 0;

  for (let dx = -radius; dx <= radius; dx += 3) {
    for (let dz = -radius; dz <= radius; dz += 3) {
      const x = box.x + dx, z = box.z + dz;
      const f = geo.floorNearest(reader, x, z, box.y);
      if (!f) continue;
      cells++;
      heights.push(f.y);
      names[f.name] = (names[f.name] || 0) + 1;
      if (geo.isStone(f.name)) stone++;
      if (!geo.hasSkyAccess(reader, x, z, f.y + 3)) roofed++;
      // Water and canopy are read as neighbours of the arena, never inside the spawn box (the box is
      // required dry and clear).
      for (let dy = 1; dy <= 4; dy++) {
        const b = reader.blockAt(x, f.y + dy, z);
        if (!b) break;
        if (geo.isWater(b.name)) { water++; break; }
        if (geo.isCanopy(b.name)) { canopy++; break; }
      }
    }
  }
  if (!cells) return { tags: [], notes: 'terrain unreadable' };

  const min = Math.min(...heights), max = Math.max(...heights);
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  const relief = max - min;
  const tags = [];

  tags.push(roofed / cells >= 0.6 ? LABEL.CAVE : LABEL.SURFACE);
  if (relief >= 8 && stone / cells >= 0.4) tags.push(LABEL.MOUNTAIN);
  else if (relief <= 1) tags.push(LABEL.FLAT);
  else tags.push(LABEL.ROLLING);
  if (box.floorY - mean >= 2.5) tags.push(LABEL.HIGH_GROUND);
  else if (box.floorY - mean <= -2.5) tags.push(LABEL.LOW_GROUND);
  if (water / cells >= 0.15) tags.push(LABEL.WATERSIDE);
  if (canopy / cells >= 0.4) tags.push(LABEL.FOREST);

  return {
    tags,
    relief,
    // Numbers beside the sentence: `notes` is for a reader, `pct` is for the ground gate, which must
    // never parse the sentence to recover a value this function already computed (Law 26).
    pct: { water: water / cells, canopy: canopy / cells, roofed: roofed / cells, stone: stone / cells },
    notes: `relief Δ${relief} · box ${(box.floorY - mean >= 0 ? '+' : '')}${(box.floorY - mean).toFixed(1)} vs local mean · ` +
           `water ${Math.round(water / cells * 100)}% · canopy ${Math.round(canopy / cells * 100)}% · ` +
           `roofed ${Math.round(roofed / cells * 100)}% · stone ${Math.round(stone / cells * 100)}%`,
  };
}

module.exports = {
  DEFAULTS, LABEL, SPAWN_BLUEPRINT,
  readerFromScout, spawnBoxShape, createSiteCache,
  findBotSpawn, findOpponentSpawns, probePartners, partitionByLineOfSight, findArenaPairs, describeSite,
  // Re-exported, not re-implemented, so `scan.rejections` prints with geo's own phrasing (Law 16).
  formatRejections: geo.formatRejections,
};
