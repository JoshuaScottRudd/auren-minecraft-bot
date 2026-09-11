// fragment: biome_scanner (perception)
// purpose: Survey the loaded area (server view-distance) and report the biome map as a flat, distance-sorted
//          list of PATCHES — each a contiguous region of ONE biome (a river body, a forest), carrying its
//          nearest cell (seed / shortest walk), centroid, size, and bbox. Pure perception: it reports the
//          SHAPE of the biome map and DECIDES NOTHING — every caller sorts/filters the patch list for what it
//          wants (Architect 2026-07-18: "biome_scanner should just give all the biomes, the caller decides").
// invariants:
//  - Uses bot.world.getBiome(pos) directly against the mineflayer chunk cache — no block queries, no chunk load.
//  - Samples every biome CELL (4-block step — MC 1.21.5 stores biomes at 4×4×4) across the server's view
//    distance (view-distance 10 → 160-block radius → 81×81 grid ≈ 6561 points), then flood-fills same-biome
//    neighbours into patches. The whole thing is a cache read, ~tens of ms — no throttle (see STEP note).
//  - Y is pinned to the bot's floored altitude — a 2D horizontal (SURFACE) survey, never a vertical/underground
//    column scan. Cave biomes (dripstone/lush/deep_dark) appear only if the bot itself is underground.
//  - A PATCH is the spatial unit (connected same-biome cells), NOT a centroid and NOT a single nearest point:
//    a biome appearing in two separate places yields two patches — so a caller can take the nearest BODY and
//    move to the next when it is exhausted (the wheat scanner's multi-river seeding). A centroid alone can fall
//    outside the biome (two patches average to a point between them); the per-patch nearest cell never does.
// WHY: Pure perception feeding the planner "biome X has a patch ~N blocks away at D". Short-range scanners
//      (surface_filter, district_scanner) handle navigation WITHIN a biome; this is the coarse map of WHERE the
//      bodies are — it composes with, and never duplicates, the fine per-block flood the wheat BFS runs inside
//      one body (this finds the bodies; the flood explores a body's banks).

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');

// In-memory scan result — consumers call getState() instead of reading a file.
let _lastScan = null;

// Server view-distance is 10 chunks (server.properties: view-distance=10) → 160-block radius.
// STEP is the biome SAMPLE spacing. MC 1.21.5 stores biomes at 4×4×4 NATIVE resolution (a biome cell is
// 4 blocks), so STEP=4 samples EVERY distinct biome cell in the loaded area — the finest MEANINGFUL density
// (STEP<4 just re-reads the same cell). The old STEP=16 sampled once per CHUNK, undersampling 4× per axis
// (16× fewer points): it could miss a sub-chunk biome patch or misplace the nearest sampled point by up to a
// whole chunk (Architect 2026-07-18: "at minimum double the density… scan everything in the loaded chunk").
// getBiome is a cache lookup (no block reads, no chunk load), so the native-resolution 81×81 sweep runs
// synchronously in ~24ms (measured) — well inside one tick, no voxel_scan_throttle. If a future density/host
// ever pushes it past a tick, add the throttle (its units are tiny + uniform — the ideal case).
const RADIUS = 160;
const STEP = 4;   // native biome-cell resolution (1.21.5: biomes are 4×4×4). ~6561 points across the loaded area.
const NEIGHBORS = [[STEP, 0], [-STEP, 0], [0, STEP], [0, -STEP]];   // 4-connectivity at the sample spacing

// getBiomeName — resolves bot.world.getBiome's numeric id to a stripped biome name (no 'minecraft:' prefix),
// or null if the chunk isn't loaded.
function getBiomeName(bot, x, y, z) {
  // NOT GUARDED. bot.world is prismarine's WorldSync, whose getBiome returns 0 for an unloaded column
  // rather than throwing, so the guard this call used to carry could never fire — an unloaded chunk was
  // already reaching the registry lookup below and falling out as a name, never as the catch. A boundary
  // that cannot fail is not a boundary, and one wrapped anyway teaches the next reader that this call is
  // dangerous when it is not.
  //
  // THE COLUMN IS CHECKED FIRST, and that half was missing (found 2026-09-05 by seed_scanner). Removing
  // the useless catch did not close the hole the catch was hiding: `getBiome` answering 0 for a column
  // it has never seen is indistinguishable from a real answer, and **biome id 0 in 1.21.5 is
  // `badlands`** — so every scan reported four phantom badlands patches, one at each corner of the
  // sample square where the ±160 sweep reaches past the server's 21×21 chunk window. MEASURED: 185
  // cells, byte-identical in four different worlds including a frozen_ocean/ice_spikes one where
  // badlands cannot exist, at distance 194-199b with 40-44b bboxes — pure geometry, not terrain.
  // That is Invariant B exactly: what is not sensed is not known, and a scanner that names a biome it
  // never saw hands its callers a lie with a distance attached to it. `getColumnAt` is the same
  // distinction voxel_reader's fast path draws for blocks, for the same reason.
  if (!bot.world.getColumnAt(new Vec3(x, y, z))) return null;
  const biomeId = bot.world.getBiome(new Vec3(x, y, z));
  if (biomeId == null) return null;
  const name = bot.registry?.biomes?.[biomeId]?.name || '';
  return name.replace('minecraft:', '').toLowerCase() || null;
}

// buildPatches — connected-components over the sampled grid: flood same-biome 4-neighbours (STEP apart) into
// contiguous PATCHES. Same single-link technique as the wheat scanner's plot clustering (clusterReport), one
// scale up (Law 16 — one clustering idea, not two). Each patch summarises its geometry so a caller sorts and
// picks regions without sifting the raw ~6k samples: `seed` = the nearest cell to the bot (shortest walk, and
// the flood seed for the wheat BFS), `centroid`/`bbox`/`size` = where it sits, its extent, its cell count
// (area ≈ size × STEP² blocks²). O(points): each cell is visited once. `dx,dz` keys are offsets from center.
function buildPatches(cellBiome, center) {
  const seen = new Set();
  const patches = [];
  for (const [key, biome] of cellBiome) {
    if (seen.has(key)) continue;
    seen.add(key);
    const stack = [key];
    const cells = [];
    while (stack.length) {                                  // flood this patch
      const k = stack.pop();
      const [dx, dz] = k.split(',').map(Number);
      cells.push({ dx, dz });
      for (const [ox, oz] of NEIGHBORS) {
        const nk = `${dx + ox},${dz + oz}`;
        if (!seen.has(nk) && cellBiome.get(nk) === biome) { seen.add(nk); stack.push(nk); }
      }
    }
    let best = cells[0], bestD = Infinity, sx = 0, sz = 0;
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const c of cells) {
      const d = c.dx * c.dx + c.dz * c.dz;                  // squared planar distance to the bot
      if (d < bestD) { bestD = d; best = c; }
      sx += c.dx; sz += c.dz;
      if (c.dx < minx) minx = c.dx; if (c.dx > maxx) maxx = c.dx;
      if (c.dz < minz) minz = c.dz; if (c.dz > maxz) maxz = c.dz;
    }
    const n = cells.length;
    patches.push({
      biome,
      dist: Math.round(Math.sqrt(bestD)),
      seed: { x: center.x + best.dx, y: center.y, z: center.z + best.dz },   // nearest cell → shortest walk / flood seed
      centroid: { x: Math.round(center.x + sx / n), z: Math.round(center.z + sz / n) },
      size: n,                                              // sampled cells; area ≈ size × STEP² blocks²
      bbox: { dx: maxx - minx + STEP, dz: maxz - minz + STEP },   // extent in blocks
    });
  }
  return patches;
}

function scanBiomes(bot) {
  const center = bot.entity.position.floored();
  const y = center.y;                                       // 2D survey pinned to the bot's altitude (surface)
  const cellBiome = new Map();                              // 'dx,dz' offset (STEP-aligned) → biomeName
  let pointsScanned = 0;
  const scanStart = Date.now();

  for (let dx = -RADIUS; dx <= RADIUS; dx += STEP) {
    for (let dz = -RADIUS; dz <= RADIUS; dz += STEP) {
      const biomeName = getBiomeName(bot, center.x + dx, y, center.z + dz);
      if (!biomeName) continue;
      pointsScanned++;
      cellBiome.set(`${dx},${dz}`, biomeName);
    }
  }

  const patches = buildPatches(cellBiome, center).sort((a, b) => a.dist - b.dist);   // nearest body first
  const detectedBiomes = [...new Set(patches.map(p => p.biome))];

  const output = {
    summary: {
      timestamp: new Date().toISOString(),
      center: { x: center.x, y: center.y, z: center.z },
      radius: RADIUS, step: STEP,
      pointsScanned, patchCount: patches.length, detectedBiomes,
    },
    patches,   // flat, distance-sorted; the caller filters by biome and picks (Law 0: this reports, decides nothing)
  };

  _lastScan = output;
  watcher.summary('biome_scanner', `🌍 Biome scan: ${detectedBiomes.length} biomes in ${patches.length} patches across ${pointsScanned} points (r${RADIUS}, step ${STEP}) in ${Date.now() - scanStart}ms.`);
  return output;
}

function getState() {
  return _lastScan;
}

module.exports = {
  scanBiomes,
  getState,
  // The one biome read, exported for a caller asking about ONE spot (2026-09-11: proxy_human asks "is the
  // cell a person would stand on in an acceptable biome?"), so that caller does not grow a second reader.
  getBiomeName,
};
