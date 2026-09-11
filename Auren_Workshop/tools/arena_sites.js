// arena_sites — the arena's three questions, asked as a CYCLE that yields disjoint pairs.
//
// So the arena is TWO SPAWN BOXES AND A RAYCAST, and the unit of success is the PAIR, never one box:
//
//   Q1  WHERE CAN THE BOT STAND?      an expanding-ring sweep from the origin → an open box.
//   Q2  WHERE CAN A MONSTER STAND?    a second sweep, ANCHORED ON THAT BOX, restricted to a distance
//                                     BAND → every open box in it, not just the nearest.
//   Q3  WHICH OF THOSE CAN SEE IT?    the aggro raycast per candidate → the set splits in two.
//
// Q2 anchors on Q1's answer, so the order cannot be rearranged: a distance band is meaningless until
// there is something to measure it FROM. Q3 runs last because it is the only expensive question.
//
// ── WHY IT IS A CYCLE AND NOT A PIPELINE ───────────────────────────────────────────────────────────
// An earlier draft ran Q1→Q2→Q3 once and reported WHICH question failed. That is a pipeline, and it is
// wrong: a bot box with no reachable partner is not a failure of the terrain, it is the wrong anchor.
// The anchor is an ATTEMPT, so a barren one advances the sweep instead of ending it. Q1's real predicate
// is therefore not "is there an open box here" but "is there an ARENA here" — the box plus a partner
// plus a sightline — which is why the anchor evaluator below runs the whole of Q2 and Q3 inside
// ringScan's per-cell test.
//
// ── WHY THE PAIR IS A TUPLE AND WHY CELLS RETIRE ───────────────────────────────────────────────────
// The two boxes are only meaningful together — a bot box is not "a site", it is half of one — so they
// travel joined and retire joined. Once a pair is emitted, both its boxes are out of the pool for every
// later pair, which is what stops a later arena from being sited on top of an earlier one.
//
// ── WHY NOTHING IS SCANNED TWICE ───────────────────────────────────────────────────────────────────
// Two separate memos, and they are cacheable for two DIFFERENT reasons, which matters because a third
// thing that looks similar is not:
//
//   box(x,z,refY)  — cacheable because it is a fact about TERRAIN. The same cell is tested as a monster
//                    candidate for one anchor and as a bot anchor later; the ground did not change.
//   los(a,b)       — cacheable because it is a fact about GEOMETRY, and keyed on the UNORDERED pair: a
//                    raycast that fails one direction fails the other, so the reverse cast is never
//                    issued at all.
//   the PAIRING    — NOT cached. It depends on which cells are still available, and that shrinks every
//                    time a pair is emitted. Caching it would hand out a partner already spoken for.
//
// A barren anchor IS remembered, and soundly: commitments only ever REMOVE candidates from the pool, so
// an anchor with no partner now can never acquire one later. That monotonicity is the whole licence for
// the memo — if pairs could ever release cells back, this set would have to be cleared with them.
//
// ── THE SPLIT IS THE PRODUCT, NOT A FILTER ─────────────────────────────────────────────────────────
// Q3 returns BOTH sets. `threat_scanner` engages iff (distance ≤ AGGRO_RANGE) AND (clear raycast), so a
// bench that kept only the visible boxes could prove the bot fights and could never prove it DECLINES —
// and counter-aggro is half the design. The hidden boxes are how the other half gets tested, so each
// emitted pair carries the full split of its band, not just the partner that won.
//
// ── WHAT THIS FILE IS NOT ──────────────────────────────────────────────────────────────────────────
// It does not classify terrain to decide validity. An earlier draft did — ten terrain classes with
// threshold fractions — and it asked "what KIND of ground is this" when the real question is "can a body
// stand here, twice, with a sightline between". Terrain survives only as a LABEL (`describeSite`), so a
// sweep can be spread across mountains, rivers, caves and flat ground without terrain ever being a gate.
//
// Every part of the SCAN is `@utils/site_geometry` — the column read, the footprint test and the
// expanding ring, shared with find_buildingspot rather than copied from it. This file supplies only the
// three questions, the predicate they ask with, and the cycle that joins them.
//
'use strict';

const path = require('path');
// The alias map is booted HERE rather than left to the entry point, because this module's dependency on
// it is not the entry point's business: reading a blueprint means going through @kernel/blueprint_registry
// (Law 16 — nothing else opens building_blueprints.json), and that registry lives in the construct's
// alias space. Registering a path map is not joining the construct: no signal bus, no watcher, no
// fragment. Doing it here means lanista and the headless bench both work without either knowing why.
//
// Booted unconditionally, and the guard that used to stand here is GONE. It read
// `try { require.resolve(...) } catch { boot() }`, because module-alias registering the SAME base twice
// resolved '@kernel/x' to '<base>/<base>/js_kernel/x' and the require died — a double boot being the
// normal case when every tool booted for itself. `workshop_paths.registerAliases()` is idempotent by
// construction, so the condition the catch existed for cannot occur, and a `try` kept past the fault it
// guarded is a swallowed error waiting for an unrelated failure (Law 13).
const paths = require('../workshop_paths');
paths.registerAliases();

const geo = require(paths.bot('js_kernel/utils/site_geometry'));
const blueprintRegistry = require('@kernel/blueprint_registry');

// The spawn box is a BLUEPRINT, not a constant. It is `underground_cell` with its walls taken off,
// carries no voxels, and is never built. Reading it here rather than hardcoding a size means the arena's
// footprint is retuned by editing the blueprint file, the same way every other siting decision in this
// codebase is retuned.
//
// It is now a DIAL rather than a constant, because the footprint is a thing under test: `spawn_spot` is
// the same box shrunk to one column. See THE TWO DIALS below.
const SPAWN_BLUEPRINT = 'spawn_box';

// ── THE TWO DIALS UNDER TEST ────────────────────────────────────────────────────────────────────────
//
// Two INDEPENDENT ways to loosen the same predicate, and they must be separable or an A/B cannot
// attribute a change to either:
//
//   FOOTPRINT (`blueprint`) — how much ground the box needs. 3×3 → 1×1 removes eight of the nine floor
//                             cells that have to agree, so it is the larger lever by far, and it is the
//                             one that gives up movement room (see the spawn_spot blueprint's note).
//   FLATNESS  (`flatness`)  — how level that ground must be. `span` caps total relief at 1; `stepwise`
//                             allows ±1 from the centre provided no two touching cells are 2 apart.
//                             Vacuous at 1×1 — one cell is trivially flat — which is exactly why the two
//                             dials are separate parameters and not one "looseness" setting.
//
// Both default to the STRICT setting. Loosening a live predicate is a deliberate design decision, not a
// side effect of building the bench that measures it (Law 25 — meet the criterion before loosening it).
// This file changes the default only through that deliberate process, never as a side effect of a survey.
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
  // Two arenas closer than aggro range are not two tests, they are one fight with four participants —
  // a mob left alive in arena 1 pulls onto arena 2's bot and the recording of both becomes unreadable.
  // Set to 0 to allow touching arenas (still non-overlapping; the footprint guard below is separate).
  arenaSpacing: 15,
};

// makeReader — the two-line adapter site_geometry's seam expects. The scout takes a plain object; a
// mineflayer bot wants a Vec3. Keeping the adapter at the caller is what lets the shared module carry
// no dependency at all, not even vec3.
const readerFromScout = scout => ({ blockAt: (x, y, z) => scout.blockAt({ x, y, z }) });

// spawnBoxShape — the blueprint's dimensions as the footprint test wants them.
//
// `h` COUNTS THE FLOOR. The blueprint describes the whole thing a body needs — one layer of ground plus
// the space over it — so h=4 means 3 clear. `evaluateOpenBox` takes the CLEAR count (it measures upward
// FROM the floor it found), hence the -1. Reading h straight through would demand four clear cells and
// quietly reject every 3-high cave in the world, which is the terrain the arena exists to reach.
//
// Both checks are Law 13 preconditions rather than defensive padding: a blueprint edited to 3×5 would be
// silently scanned as 3×3, and one edited to h=1 would be scanned as zero clear cells — in each case
// every reported arena would be a shape that was never tested.
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

// resolveOpts — the blueprint shape merged in once, so no function below re-reads the registry and none
// of them can disagree about the box they are testing for.
function resolveOpts(opts = {}) {
  const shape = opts.shape || spawnBoxShape(opts.blueprint || DEFAULTS.blueprint);
  return { ...DEFAULTS, ...opts, boxSize: shape.size, boxHeight: shape.height, shape };
}

// The box memo's key carries the PREDICATE, not just the cell. Two arms of an A/B ask different questions
// of the same ground and get different answers, so a key of (x,z,refY) alone would serve arm B the answer
// arm A got — a silent falsehood no form check could catch (Law 26). Each arm builds its own cache, so
// this costs nothing and removes the failure mode rather than relying on callers remembering to.
const cellKey = (x, z, refY, o) => `${x},${z}@${refY}#${o.boxSize}x${o.boxHeight}/${o.flatness}/${o.maxVariance}/${o.maxStep}`;
const pairKey = (a, b) => {
  const ka = `${a.x},${a.y},${a.z}`, kb = `${b.x},${b.y},${b.z}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;   // unordered: the reverse cast is never a second entry
};

// ── The memo ────────────────────────────────────────────────────────────────────────────────────────
//
// One cache per cycle, carrying the two facts that survive a commitment (see the header for why the
// pairing itself does not). Also carries `hits`, because a sweep that reports its own reuse is how a
// successor can tell whether the cycle is actually avoiding the rescan it was built to avoid.
//
// refY is IN the box key and must stay there: `floorNearest` resolves a column to the floor nearest the
// observer's level, so the same (x,z) genuinely has different answers for a surface anchor and a cave
// anchor. Dropping refY to widen the hit rate would hand a cave query a surface floor.
function createSiteCache() {
  const boxes = new Map();
  const rays = new Map();
  const routes = new Map();
  const sites = new Map();
  const barren = new Set();
  const stats = { boxCalls: 0, boxHits: 0, losCalls: 0, losHits: 0, reachCalls: 0, reachHits: 0, siteCalls: 0, siteHits: 0 };

  return {
    // The terrain description, memoised for the box memo's exact reason: it is a fact about TERRAIN, and
    // the cycle re-walks its ring once per pair. Keyed on the box centre including y, because the same
    // (x,z) genuinely describes different ground at a surface anchor and a cave one.
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
    // The reachability memo, keyed on the UNORDERED pair for the same reason the raycast is: with only
    // world-preserving edges every move is reversible by construction (a walk back, a step back down the
    // stair it came up), so A→B passable ⟺ B→A passable and the reverse search is the same redundant
    // scan the raycast memo already avoids. That equivalence is exactly what `allowWorldAlteration:
    // false` buys — with digging on it would be FALSE (a bot digs down a cliff it cannot climb back up),
    // so this key would have to become ordered the moment anyone re-enables alteration here.
    //
    // Far more valuable than the ray memo in practice: a pathfind is orders of magnitude dearer than a
    // raycast, and the cycle re-walks its ring once per pair, so the same (anchor, candidate) tuple is
    // asked for repeatedly.
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
//
// The nearest open box to the origin, on its own. Kept as a named function because it is one of the
// three questions this file answers and a caller may want to ask only it — but note the CYCLE does
// not call this one: its anchor test is the stricter "is there an arena here", built below.
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
//
// EVERY open box in the band, not the nearest. The full set is what makes a scenario reproducible: with
// a dozen candidates the bench can pick a bearing, re-run it, and get the same fight — with only the
// nearest it gets whichever way the terrain happened to open.
//
// Anchored on the BOT'S BOX. Using the sweep origin instead would put a "12-block" opponent 12 blocks
// from where the operator was standing and some other distance from the bot, making every authored range
// in the scenario table a fiction.
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
    // The band is a true annulus on real distance, not a square ring: the stride delivers cells whose
    // Chebyshev radius is in range but whose euclidean distance is not (a corner at radius 15 is 21
    // blocks out), and the authored range must be the one the scanner measures.
    accept: ({ distance }) => distance >= o.minDistance && distance <= o.maxDistance,
  }, (x, z) => (excluded && excluded(x, z))
    ? { valid: false, reason: 'retired' }        // already inside an emitted pair — not re-testable
    : cache.box(reader, x, z, botBox.y, o));

  return { boxes: scan.matches.map(boxFrom), scan };
}

// ── Q3: which of those can REACH the bot, and then see it? ──────────────────────────────────────────
//
// ── THE REACHABILITY GATE, AND WHY IT RUNS FIRST ────────────────────────────────────────────────────
//
// Reachability gates before visibility, and it is the cheap order in the only sense that matters — not
// CPU (an A* costs far more than one raycast) but VALIDITY. A sightline across a ravine is a true fact
// about geometry and a false fact about an arena: the mob stands there, sees the bot, walks into the gap
// and the scenario records a fight that never happened. Reachability is the criterion the pair has to
// meet; visibility only decides which HALF of the bench a reachable pair serves. Pillar-stepping and any
// move that requires digging or placing blocks is not a normal traversal, so the reach check excludes it.
//
// `reach` is injected exactly like `los`, for the same reason and with the same shape:
//     { check(fromFloorCell, toFloorCell) → { known, reachable, cost, steps, edgeTypes } }
// It is OPTIONAL. Absent → the gate does not run and the cycle decides exactly as it did before, which
// is what lets an A/B keep a no-reachability baseline arm comparable rather than merely remembered.
//
// FLOOR CELLS, NOT FEET. The pathfinder's whole graph is indexed on the block STOOD ON while a box's
// `y` is the spawn (feet) cell, one above. The caller building the seam owns that conversion, and
// getting it wrong does not throw — it silently searches from the cell above the floor, which on open
// ground is air and yields "unreachable everywhere". Named here because it is invisible at the call site.
//
// `los` is injected — { check(fromCell, toCell, maxDist) → { known, clear } } — because it is the one
// question needing the LIVE raycast rather than block reads, and because it must be the SAME predicate
// threat_scanner uses (camera_scout.aggroLineOfSight is the observer's transcription of
// terrain_predicates.hasLineOfSight; its header records the three details that must not drift).
//
// Cast bot → monster, matching the scanner's own call exactly: it casts from the BOT's feet to the mob's
// floored position. The cast is issued ONCE per pair of cells and cached unordered, so a raycast that
// fails one direction fails the other and the reverse cast is never run.
//
// `unknown` is a third bucket and not folded into `hidden`: an unloaded endpoint means nobody looked, and
// a bench scoring "we could not tell" as "correctly hidden" would pass a scenario it never ran (Laws 23, 25).
//
// ONE CAST PER TUPLE, AND ONLY THE TUPLES THAT ARE NEEDED. It always was one cast per tuple; the cost was
// that the CYCLE generated every tuple in the band, so casting every opponent box in a large band to
// choose one partner scaled with the band's size rather than with what the caller needed. `quotas` fixes
// it at the only place it can be fixed: stop casting the moment each bucket has what the caller will
// actually use. The bench needs ONE visible box (the fight) and ONE hidden box (the decline), so the
// cycle asks for one of each and stops — usually within a handful of casts, because the boxes arrive
// nearest-first and the near ones are mostly clear.
//
// Sorting happens on the way IN, not the way out, which is what makes early exit safe: stopping after the
// first visible box then guarantees it is the NEAREST visible box, not merely the first one scanned.
//
// The full split is still reachable — pass Infinity — and `partitionByLineOfSight` is exactly that call.
// One implementation with a parameterised stopping rule, rather than a cheap scanner beside a thorough
// one that could drift apart (Law 16).
//
// Named `probePartners` rather than `probeLineOfSight` since the reachability gate joined it: the verb
// is "which of these boxes can be a partner", and sight is now one of two questions it asks.
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

    // The gate, before the cast. A box that fails it is never raycast at all, which is why the two
    // counters below are separate: `pathed` is what the gate cost, `cast` is what survived it.
    if (reach) {
      pathed++;
      const route = await cache.reach(from, to, reach);
      // Three buckets again, and for the same reason as the sightline's (Laws 23, 25): a search that ran
      // out of budget did not prove the ground impassable, it proved nothing. Neither an unreachable nor
      // an unproven box may satisfy a quota — a bench that let "we could not tell" stand in for "there is
      // an arena here" would spawn a mob that can never arrive and record the bot's silence as a decline.
      if (!route.known) { unknownReach.push({ ...candidate, reach: route }); continue; }
      if (!route.reachable) { unreachable.push({ ...candidate, reach: route }); continue; }
      box = { ...candidate, reach: route };
    }

    cast++;
    const verdict = cache.los(from, to, los, o.aggroRange);
    const entry = { ...box, los: verdict };
    // `unknown` is a third bucket and never folded into `hidden`, and it does NOT satisfy a quota: an
    // unloaded endpoint means nobody looked, and a bench that let "we could not tell" stand in for
    // "correctly hidden" would pass a scenario it never ran (Laws 23, 25).
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
//
// findArenaPairs — sweep bot anchors nearest-first; for each, try to complete a PAIR; emit it and retire
// both boxes; keep going until `pairs` arenas are found or the loaded frontier is reached.
//
// The outer loop re-runs the ring sweep once per pair rather than collecting every anchor up front. That
// looks wasteful and is the opposite: an exhaustive first pass would pay the footprint test over the
// whole loaded area before returning anything, whereas the re-walk is nearly free — every cell it
// revisits is a memo hit, and the ordering property (nearest arena first) is preserved for free.
//
// A pair is emitted with the FULL band split, not just its partner. The hidden and unknown boxes of the
// winning anchor are what the counter-aggro half of the bench spawns into (see THE SPLIT above), so
// discarding them here would leave that half with nowhere to stand.
async function findArenaPairs(reader, origin, los, opts = {}) {
  const o = resolveOpts(opts);
  const cache = o.cache || createSiteCache();
  const want = o.pairs;

  const retired = [];   // committed box centres — {x, z}
  const pairs = [];
  const barrenReasons = {};

  // A cell is out if it sits inside a retired box's footprint, or within arenaSpacing of one. The
  // footprint term is non-negotiable geometry (two boxes may not share ground); the spacing term is the
  // dial above.
  const clearance = Math.max(o.boxSize, o.arenaSpacing);
  const isRetired = (x, z) => retired.some(r => Math.hypot(x - r.x, z - r.z) < clearance);

  // The anchor test: not "is there an open box here" but "is there an ARENA here". Q2 and Q3 run inside
  // it, which is what makes a barren anchor advance the sweep instead of ending it.
  const evaluateAnchor = async (x, z) => {
    if (cache.isBarren(x, z)) return { valid: false, reason: 'barren_anchor' };
    if (isRetired(x, z)) return { valid: false, reason: 'retired' };

    const box = cache.box(reader, x, z, origin.y, o);
    if (!box.valid) return box;

    const botBox = boxFrom({ x, z, distance: Math.hypot(x - origin.x, z - origin.z), result: box });

    // ── THE GROUND GATE, SECOND AND ONLY IF DECLARED ─────────────────────────────────────────────
    //
    // Terrain was a LABEL and not a gate, which is a defence this file argued for deliberately — the
    // twin-box test decides validity, and steering the survey by ground type was how a bench came to
    // measure only the terrain it liked. It stays a label for every caller that declares no `ground`
    // dial; the gate exists for callers that need it because ground that kills the subject is not an
    // arena, it is a confound with a hit point cost (Law 25) — a beach anchor with steep relief and heavy
    // water coverage can look like open ground and still be a cliff a subject falls from before it ever
    // reaches an opponent.
    //
    // ── IT RUNS HERE, NOT AFTER THE PARTNER AND SIGHTLINE PROBES ─────────────────────────────────
    // Running the ground read after those probes looks cheaper — pay it only on anchors that already look
    // like arenas — and is the wrong conclusion, because it ignores what a REJECTION costs: every anchor
    // the ground dial turns down is one the sweep must replace, so refusing arenas at the END means paying
    // the reach gate — A* per candidate box — over the whole loaded frontier instead of the one column
    // read this gate costs.
    //
    // Ordered by COST-PER-REJECTION rather than cost-per-call: the box test is cheapest, the terrain
    // description is a fixed sample of columns, the opponent sweep and the reach gate are pathfinding. A
    // gate belongs above everything more expensive than itself, and this one now is.
    //
    // A refusal MARKS BARREN and returns a reason, so the sweep advances to the next anchor exactly as it
    // does for a walled band: an anchor is an attempt, not a final answer.
    let ground = null;
    if (o.ground) {
      ground = cache.site(reader, botBox);
      const bad = groundShortfall(ground, o.ground);
      if (bad) {
        cache.markBarren(x, z);
        barrenReasons.ground = (barrenReasons.ground || 0) + 1;
        // The LAST reason kept, not a tally per reason: the shortfall line needs one example of what the
        // dial is actually rejecting, and a histogram of ground failures would out-length the three walls
        // that matter more.
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

    // One visible box and one hidden box is the entire sightline requirement of a run: the visible one is
    // the fight, the hidden one is the decline. Asking for more would cast the whole band to store boxes
    // nothing reads.
    const split = await probePartners(opp.boxes, botBox, los, {
      ...o, cache, wantVisible: 1, wantHidden: o.wantHidden === undefined ? 1 : o.wantHidden,
    });
    if (!split.visible.length) {
      cache.markBarren(x, z);
      // Two ways to have no partner and they are different terrain, so they are counted apart: an anchor
      // whose band the gate refused entirely versus one whose passable neighbours were all out of sight.
      // The first says the anchor is on an island, the second says it is in a thicket, and a single "no
      // partner" count would let a survey of ravine country read as a survey of forest.
      //
      // BOTH gate buckets count. Testing `unreachable` alone looks right and is dead code in practice:
      // on an open surface A* proves REACHABLE cheaply and can essentially never prove UNREACHABLE (the
      // walkable region is bounded only by chunk loading), so a search that runs out of budget lands in
      // `unknownReach`, not `unreachable`. Counting only `unreachable` would report "no clear line" for
      // an anchor the gate actually refused for lack of proof — a true-sounding reason for the wrong wall
      // (Law 25). The bucket stays honest in its wording instead: refused, not proven impassable.
      const walled = o.reach && !split.cast && (split.unreachable.length + split.unknownReach.length);
      const key = walled ? 'no_reachable_box' : 'no_sightline';
      barrenReasons[key] = (barrenReasons[key] || 0) + 1;
      return { valid: false, reason: key };
    }

    // The nearest visible box is the partner, and the sort inside probePartners is what makes that
    // true after an early exit rather than merely likely.
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
      // What the probe actually did, so a reader never has to infer cost from the totals: what the band
      // offered, how many were pathfound at, how many survived to be cast at, and how many the gate threw
      // out. `pathed` is 0 with no reach seam injected, which is how the trace says the gate was off
      // rather than leaving a reader to infer it from a missing field.
      probe: {
        offered: r.split.offered, pathed: r.split.pathed, cast: r.split.cast,
        unreachable: r.split.unreachable.length, unknownReach: r.split.unknownReach.length,
      },
      // Reused from the ground gate when one ran, so the 9×9 column read is paid once per emitted arena
      // rather than twice. Without a gate declared there is nothing to reuse and it is read here.
      site: r.site || describeSite(reader, r.botBox),
      originDistance: scan.best.distance,
    });
  }

  return {
    ok: pairs.length > 0,
    pairs,
    // Law 25: a short cycle is reported as short, never as a success flag over a partial. The caller
    // asked for `want` arenas and gets the true count with the wall it hit.
    complete: pairs.length === want,
    requested: want,
    detail: pairs.length === want ? null : describeShortfall(pairs.length, want, lastScan, barrenReasons),
    cache: cache.stats(),
    scan: lastScan,
  };
}

// describeShortfall — which wall the cycle hit, in the caller's terms. The three are different
// situations a bare "no arena" would fuse: unusable ground, walled bands, or blocked sightlines.
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
  // A FOURTH WALL, and it must be named or it reads as one of the other three. An arena the ground gate
  // refused was a complete, passable, visible arena — the sweep walked past it on purpose. Silently
  // folding those into "no arena anywhere" would tell an operator the world is empty when the truth is
  // that their own dial rejected it, which is the one shortfall a caller can fix by changing a number.
  if (barrenReasons.ground) parts.push(`${barrenReasons.ground} complete arena(s) refused by the ground dial (${barrenReasons.groundWhy || 'see the dial'})`);
  return parts.join('; ');
}

// ── The terrain LABEL (not a gate) ──────────────────────────────────────────────────────────────────
//
// Demoted deliberately. Terrain decides nothing about whether an arena is valid — the twin-box test does
// that — but runs still need to spread across mountains, rivers, water, caves, high ground, low ground,
// forest and flat terrain, and that spread is impossible to steer if a found arena carries no description
// of the ground it sits on.
//
// Read over a wider radius than the spawn box, because the label describes the FIGHT's ground and the
// fight covers the whole band, not the 3×3 the bot spawns in.
const LABEL = {
  SURFACE: 'surface', CAVE: 'cave', MOUNTAIN: 'mountain', FLAT: 'flat', ROLLING: 'rolling',
  HIGH_GROUND: 'high_ground', LOW_GROUND: 'low_ground', WATERSIDE: 'waterside', FOREST: 'forest',
};

// groundShortfall(site, dial) → a sentence naming what failed, or null if the ground passes.
//
// Reads the numbers `describeSite` already computed; it derives nothing of its own, because two places
// deciding what "51% water" means is how the label and the gate would come to disagree (Law 16). Returns
// a SENTENCE rather than a boolean so the refusal that advances the sweep can say which wall it hit —
// "three anchors refused for water" and "three refused for relief" want different fixes to the scenario.
//
// UNREADABLE TERRAIN FAILS THE GATE. `describeSite` returns `{tags, notes}` with no numbers when it could
// not read a single column, and a dial that skipped an unreadable site would site the arena on precisely
// the ground it knows least about (Law 13 — default stopped).
// IT READS `site.pct`, NEVER `site.notes`. The notes string is a rendering for a human, and a gate that
// regex'd its percentages back out would be a machine consuming a translation instead of the value —
// exactly the joint Law 26 forbids, and it would break silently the first time the sentence was reworded.
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
      // Water and canopy are read as NEIGHBOURS of the arena, never inside the spawn box — the box is
      // required dry and clear. A river arena is the bot on one bank and the monster on the other, which
      // is a better test than standing in the water and is the only shape the box test permits.
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
    // THE FRACTIONS, RETURNED AS NUMBERS BESIDE THE SENTENCE. `notes` is for a reader; `pct` is for the
    // ground gate, which must never parse the sentence to recover what this function already knows
    // (Law 26 — a machine reading a human rendering is a joint with nothing behind it).
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
  // Re-exported, not re-implemented: the `scan.rejections` tally this module hands back is geo's, so its
  // formatter travels with it. A caller that owned the phrasing itself would drift from REASON_LABELS the
  // first time a reason was added, and print a raw enum key at the exact moment someone needed the word.
  formatRejections: geo.formatRejections,
};
