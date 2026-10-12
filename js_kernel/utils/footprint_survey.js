'use strict';
// footprint_survey — where a large downloaded blueprint can be sunk into natural ground, read off the
// loaded world.
//
// The model — ring-median ground floor h, the pit dug to h - below, pass 1 on surface arrays, pass 2 on
// every voxel of the pit, its floor and a one-block shell — is arithmetic this survey shares with the
// workshop bench it backs: shipped code and the bench run one implementation (Law 16).
//
// It reads only `bot.world` (getColumns / getBiome), `bot.registry`, and the fleet reader over it, so it
// runs the same on a live body and on a `voxel_snapshot_store.loadSnapshot` stand-in, with no server.
//
// Every pass is paced by `execution_yield`: each pass awaits `pace()` once per column or position,
// so it cedes the event loop every ~50 ms tick of work. A single long synchronous scan would stall the
// foreman's door, hub and keep-alive; pacing never does, at the cost of wall time. A caller may hand in
// its own `pace`; the default is a fresh throttle.

const { makeVoxelReader } = require('@utils/voxel_reader');
const { makeExecutionPacer } = require('@utils/execution_yield');
const geo = require('@utils/site_geometry');

const Y_TOP = 319, Y_BOTTOM = -64, H_BINS = Y_TOP - Y_BOTTOM + 1;
const LAND = 1, WATER = 2, LAVA = 3;                    // 0 = unloaded (the zero-filled array's own value)
const COVER = 0;
const WATER_SURFACE = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'ice', 'frosted_ice']);
const FOOT_STRIDE = 4, RING_LAND = 0.9, TOLERANCES = [1, 2, 3, 5], LEVEL_SHARE = 0.02;
const STONE_YIELD = new Set(['stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'cobblestone', 'calcite', 'smooth_basalt']);
const DIRT_YIELD = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud', 'dirt_path']);
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel']);

// ── Part 1: the surface, water bed and wood of every loaded column ─────────────────────────────────
async function readSurface(bot, pace = makeExecutionPacer()) {
  const reader = makeVoxelReader(bot, { needs: ['type'] });
  const cols = bot.world.getColumns();
  const cxs = cols.map(c => c.chunkX), czs = cols.map(c => c.chunkZ);
  const minCX = Math.min(...cxs), minCZ = Math.min(...czs);
  const x0 = minCX * 16, z0 = minCZ * 16;
  const W = (Math.max(...cxs) - minCX + 1) * 16, D = (Math.max(...czs) - minCZ + 1) * 16;
  const N = W * D;
  const kind = new Uint8Array(N), height = new Int16Array(N), bed = new Int16Array(N), biome = new Uint16Array(N), state = new Int32Array(N);
  const logs = new Uint16Array(N), trunk = new Uint8Array(N);
  const verdict = new Map(), stateName = new Map(), isLogState = new Map();
  const classify = (x, y, z, s) => {
    const b = reader.blockAt(x, y, z);
    const v = !b ? COVER : WATER_SURFACE.has(b.name) ? WATER : geo.isLava(b.name) ? LAVA
      : (geo.isGround(b) && !geo.isCanopy(b.name)) ? LAND : COVER;
    verdict.set(s, v);
    isLogState.set(s, !!b && b.name.endsWith('_log'));
    if (b) stateName.set(s, b.name);
    return v;
  };
  for (const { chunkX, chunkZ } of cols) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        await pace();
        const x = chunkX * 16 + lx, z = chunkZ * 16 + lz, i = (z - z0) * W + (x - x0);
        let prevLog = false, logCount = 0;
        for (let y = Y_TOP; y >= Y_BOTTOM; y--) {
          const s = reader.stateIdAt(x, y, z);
          if (s < 0) break;
          const v = verdict.has(s) ? verdict.get(s) : classify(x, y, z, s);
          if (kind[i] === WATER) {                       // below a water surface: look for the bed
            if (v === LAND || v === LAVA) { bed[i] = y; break; }
            continue;
          }
          if (v === COVER) {
            prevLog = isLogState.get(s);
            if (prevLog) logCount++;
            continue;
          }
          kind[i] = v; height[i] = y; state[i] = s;
          biome[i] = bot.world.getBiome({ x, y, z });
          logs[i] = logCount;
          trunk[i] = v === LAND && prevLog ? 1 : 0;
          if (v === WATER) { bed[i] = Y_BOTTOM; continue; }
          bed[i] = y;
          break;
        }
      }
    }
  }
  reader.dispose();
  const biomeName = id => bot.registry.biomes[id]?.name || `biome#${id}`;
  return { x0, z0, W, D, kind, height, bed, biome, state, stateName, logs, trunk, biomeName };
}


function summedArea(W, D, valueAt) {
  const S = new Float64Array((W + 1) * (D + 1));
  for (let z = 0; z < D; z++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += valueAt(z * W + x);
      S[(z + 1) * (W + 1) + x + 1] = S[z * (W + 1) + x + 1] + row;
    }
  }
  return (x, z, w, d) => S[(z + d) * (W + 1) + x + w] - S[z * (W + 1) + x + w] - S[(z + d) * (W + 1) + x] + S[z * (W + 1) + x];
}


function percentileFromHist(hist, count, p, offset = 0) {
  const target = Math.max(1, Math.ceil(p * count));
  let seen = 0;
  for (let b = 0; b < hist.length; b++) { seen += hist[b]; if (seen >= target) return b + offset; }
  return hist.length - 1 + offset;
}


// ── Part 4: one large footprint ────────────────────────────────────────────────────────────────────
// Pass 1 — surface arrays only. Every min corner of the footprint-plus-ring box at FOOT_STRIDE.
async function footprintPass1(g, fw, fl, trunksIn, { ring: RING, below: BELOW }, pace = makeExecutionPacer()) {
  const tw = fw + 2 * RING, tl = fl + 2 * RING;
  const ringCols = tw * tl - fw * fl;
  const hist = new Uint32Array(H_BINS);
  const sites = [], refused = { unloaded_or_lava: 0, water_in_footprint: 0, ring_not_land: 0 };
  for (let oz = 0; oz + tl <= g.D; oz += FOOT_STRIDE) {
    for (let ox = 0; ox + tw <= g.W; ox += FOOT_STRIDE) {
      await pace();
      hist.fill(0);
      let ringLand = 0, footWater = 0, blocked = false;
      for (let z = oz; z < oz + tl && !blocked; z++) {
        for (let x = ox; x < ox + tw; x++) {
          const i = z * g.W + x, k = g.kind[i];
          if (k === 0 || k === LAVA) { blocked = true; break; }
          const inFoot = x >= ox + RING && x < ox + RING + fw && z >= oz + RING && z < oz + RING + fl;
          if (inFoot) { if (k === WATER) footWater++; continue; }
          if (k === LAND) { hist[g.height[i] - Y_BOTTOM]++; ringLand++; }
        }
      }
      if (blocked) { refused.unloaded_or_lava++; continue; }
      if (footWater) { refused.water_in_footprint++; continue; }
      if (ringLand < RING_LAND * ringCols) { refused.ring_not_land++; continue; }
      const h = percentileFromHist(hist, ringLand, 0.5, Y_BOTTOM);
      const bottom = h - BELOW;
      let ringOff = 0;
      for (let b = 0; b < H_BINS; b++) if (hist[b]) ringOff += hist[b] * Math.abs(b + Y_BOTTOM - h);
      const outside = TOLERANCES.map(t => {
        let n = 0;
        for (let b = 0; b < H_BINS; b++) if (hist[b] && Math.abs(b + Y_BOTTOM - h) > t) n += hist[b];
        return n;
      });
      let digEstimate = 0, hill = 0, hollow = 0, highest = -Infinity, lowest = Infinity;
      for (let z = oz + RING; z < oz + RING + fl; z++) {
        for (let x = ox + RING; x < ox + RING + fw; x++) {
          const s = g.height[z * g.W + x];
          digEstimate += Math.max(0, s - bottom + 1);
          hill += Math.max(0, s - h);
          hollow += Math.max(0, h - s);
          if (s > highest) highest = s;
          if (s < lowest) lowest = s;
          TOLERANCES.forEach((t, k) => { if (Math.abs(s - h) > t) outside[k]++; });
        }
      }
      const judged = fw * fl + ringLand;
      sites.push({
        ox, oz, fw, fl, h, bottom, digEstimate, hill, hollow, ringOff, offLevel: hill + hollow + ringOff, groundLow: lowest, groundHigh: highest,
        outsideShare: outside.map(n => n / judged), layersToGround: Math.max(0, highest - h), deepestHollow: Math.max(0, h - lowest),
        layersDug: Math.max(0, highest - bottom + 1),
        ringP10: percentileFromHist(hist, ringLand, 0.1, Y_BOTTOM), ringP90: percentileFromHist(hist, ringLand, 0.9, Y_BOTTOM),
        ringLandShare: ringLand / ringCols, trunksInFootprint: trunksIn(ox + RING, oz + RING, fw, fl),
      });
    }
  }
  return { sites, refused };
}


// Pass 2 — every voxel of the pit (surface down to h - BELOW), its floor (one below) and the one-block shell around it.
async function footprintPass2(g, reader, site, { ring: RING }, pace = makeExecutionPacer()) {
  const cat = new Map();
  const categoryOf = (x, y, z) => {
    const s = reader.stateIdAt(x, y, z);
    if (s < 0) return 'unloaded';
    if (cat.has(s)) return cat.get(s);
    const b = reader.blockAt(x, y, z);
    const c = !b ? 'air' : WATER_SURFACE.has(b.name) ? 'water' : geo.isLava(b.name) ? 'lava'
      : !(geo.isGround(b) && !geo.isCanopy(b.name)) ? 'air'
        : STONE_YIELD.has(b.name) ? 'stone' : DIRT_YIELD.has(b.name) ? 'dirt' : FALLING.has(b.name) ? 'falling'
          : b.name.endsWith('_ore') ? 'ore' : 'other_solid';
    cat.set(s, c);
    return c;
  };
  const r = {
    dug: 0, stone: 0, dirt: 0, falling: 0, ore: 0, other_solid: 0, caveAir: 0, water: 0, lava: 0, unloaded: 0,
    floorOpen: 0, floorWater: 0, floorLava: 0, shellWater: 0, shellLava: 0, shellCave: 0,
  };
  const biomeCount = new Map();
  const fx0 = site.ox + RING, fz0 = site.oz + RING, floorY = site.bottom - 1;
  for (let z = fz0; z < fz0 + site.fl; z++) {
    for (let x = fx0; x < fx0 + site.fw; x++) {
      await pace();
      const i = z * g.W + x, wx = g.x0 + x, wz = g.z0 + z;
      biomeCount.set(g.biome[i], (biomeCount.get(g.biome[i]) || 0) + 1);
      for (let y = g.height[i]; y >= site.bottom; y--) {
        const c = categoryOf(wx, y, wz);
        if (c === 'air') r.caveAir++;
        else if (c === 'water' || c === 'lava' || c === 'unloaded') r[c]++;
        else { r.dug++; r[c]++; }
      }
      const f = categoryOf(wx, floorY, wz);
      if (f === 'water') r.floorWater++;
      else if (f === 'lava') r.floorLava++;
      else if (f === 'air' || f === 'unloaded') r.floorOpen++;
    }
  }
  for (let z = fz0 - 1; z <= fz0 + site.fl; z++) {
    for (let x = fx0 - 1; x <= fx0 + site.fw; x++) {
      if (x >= fx0 && x < fx0 + site.fw && z >= fz0 && z < fz0 + site.fl) continue;
      await pace();
      const i = z * g.W + x, wx = g.x0 + x, wz = g.z0 + z;
      for (let y = site.h + 1; y >= floorY; y--) {
        const c = categoryOf(wx, y, wz);
        if (c === 'water') r.shellWater++;
        else if (c === 'lava') r.shellLava++;
        else if (c === 'air' && y < g.height[i]) r.shellCave++;
      }
    }
  }
  const dominant = [...biomeCount.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    ...r, biome: g.biomeName(dominant[0]), biomeShare: dominant[1] / (site.fw * site.fl),
    passes: r.water + r.lava + r.floorWater + r.floorLava + r.shellWater + r.shellLava === 0 && r.unloaded === 0,
  };
}


// ── THE ONE CALL THE FOREMAN MAKES ─────────────────────────────────────────────────────────────────
// await surveyFootprint(bot, { w, l, below, ring }, pace?) → { positions, refused, byTolerance:[{ tolerance, levelPositions,
// plots, passingPlots, picks:[site] }] } where a site carries, in WORLD coordinates, `corner` (the footprint's
// min x/z), `centre`, `h` (the ground floor), `bottom`, `fw`/`fl` (its orientation), `offLevel`, and `passes`
// (no water, lava or unloaded ground in the pit, its floor or its shell). Picks are separate plots — no two share
// a footprint column — nearest to level first. The blueprint is surveyed in its own orientation only.
async function surveyFootprint(bot, { w, l, below, ring }, pace = makeExecutionPacer()) {
  for (const [k, v] of Object.entries({ w, l, below, ring })) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`[footprint_survey] CODING VIOLATION (Law 13): ${k} must be a whole number of blocks, got ${v}.`);
  }
  const g = await readSurface(bot, pace);
  const trunksIn = summedArea(g.W, g.D, i => g.trunk[i]);
  // The blueprint is surveyed in its own orientation only: `all` is sorted by offLevel and the
  // non-overlap loop below is greedy, so a turned plot a fraction more level would take the ground first
  // and suppress the as-authored plot overlapping it. The picks are a competition result, never a
  // census.
  const orientations = [[w, l]];
  const all = [], refused = { unloaded_or_lava: 0, water_in_footprint: 0, ring_not_land: 0 };
  for (const [fw, fl] of orientations) {
    const p1 = await footprintPass1(g, fw, fl, trunksIn, { ring, below }, pace);
    all.push(...p1.sites);
    for (const k of Object.keys(refused)) refused[k] += p1.refused[k];
  }
  all.sort((a, b) => a.offLevel - b.offLevel);
  const reader = makeVoxelReader(bot, { needs: ['type'] });
  const memo = new Map();
  const readSite = async s => {
    const key = `${s.ox},${s.oz},${s.fw}`;
    if (!memo.has(key)) {
      memo.set(key, {
        ...s, ...(await footprintPass2(g, reader, s, { ring }, pace)),
        corner: { x: g.x0 + s.ox + ring, z: g.z0 + s.oz + ring },
        centre: { x: g.x0 + s.ox + ring + Math.floor(s.fw / 2), z: g.z0 + s.oz + ring + Math.floor(s.fl / 2) },
      });
    }
    return memo.get(key);
  };
  const byTolerance = [];
  for (const [k, t] of TOLERANCES.entries()) {
    const level = all.filter(s => s.outsideShare[k] <= LEVEL_SHARE);
    const plots = [];
    for (const s of level) {
      const clash = plots.some(p => s.ox < p.ox + p.fw && p.ox < s.ox + s.fw && s.oz < p.oz + p.fl && p.oz < s.oz + s.fl);
      if (!clash) plots.push(s);
    }
    const read = [];
    for (const s of plots) read.push(await readSite(s));
    byTolerance.push({ tolerance: t, levelPositions: level.length, plots: read.length, passingPlots: read.filter(s => s.passes).length, picks: read });
  }
  reader.dispose();
  // `surface` goes back with the answer so a caller siting a second building beside this one reads the
  // same ground, without scanning the whole loaded area again (siteBeside).
  return { positions: all.length, refused, byTolerance, area: { x0: g.x0, z0: g.z0, W: g.W, D: g.D }, surface: g };
}

// siteBeside(g, opts) — where a small hand-authored building goes next to a big one, off the same
// surface read. Built for the builder's laydown yard; the limits are set in architect_config.YARD_SITING.
//   extent     the small building's footprint as offsets from its transpose_origin (blueprint_survey.footprintExtent)
//   avoid      the big building's footprint box {minX,maxX,minZ,maxZ}, world cells
//   groundY    the big building's ground floor
//   minGap     the smallest distance allowed between the two footprints (Euclidean, cell edge to cell edge)
//   rise       the small building's floor may be groundY ± this
//   scrapeMax  ground standing up to this many layers over the floor is accepted (it is dug away)
//   fillMax    ground up to this many layers under the floor is accepted (it is filled)
//   searchTo   the farthest gap searched
//   clearOf    optional [{ box, gap }]: other footprints the small building also keeps `gap` from
//
// THE NEAREST GAP WINS; within one block of it, the site nearest the big building's centre (the middle of a side,
// the shortest trip on average to every part of the building), then the least ground moved. Every column under the footprint must
// be land (no water, lava, unloaded cell or tree trunk) with its surface inside [floor - fillMax, floor + scrapeMax];
// of the floors within ±rise that fit, the one with the fewest cells to fill is taken, then the fewest blocks to cut,
// then the nearest to groundY.
// Returns { found:true, center:{x,y,z}, gap, floor, scrape, fill, refused:{…} } (refused counts the nearer sites
// passed over) or { found:false, refused:{…}, candidates }.
async function siteBeside(g, { extent, avoid, groundY, minGap, rise, scrapeMax, fillMax, searchTo, clearOf = [] }, pace = makeExecutionPacer()) {
  const gapTo = (r, b) => Math.hypot(Math.max(0, b.minX - r.maxX - 1, r.minX - b.maxX - 1), Math.max(0, b.minZ - r.maxZ - 1, r.minZ - b.maxZ - 1));
  for (const [k, v] of Object.entries({ groundY, minGap, rise, scrapeMax, fillMax, searchTo })) {
    if (!Number.isInteger(v)) throw new Error(`[footprint_survey] CODING VIOLATION (Law 13): siteBeside needs a whole-number ${k}, got ${v}.`);
  }
  const floors = [0];
  for (let d = 1; d <= rise; d++) floors.push(-d, d);
  const refused = { not_land: 0, trunk: 0, too_uneven: 0 };
  const cands = [];
  for (let cz = g.z0 - extent.min_dz; cz + extent.max_dz < g.z0 + g.D; cz++) {
    for (let cx = g.x0 - extent.min_dx; cx + extent.max_dx < g.x0 + g.W; cx++) {
      const r = { minX: cx + extent.min_dx, maxX: cx + extent.max_dx, minZ: cz + extent.min_dz, maxZ: cz + extent.max_dz };
      const dx = Math.max(0, avoid.minX - r.maxX - 1, r.minX - avoid.maxX - 1);
      const dz = Math.max(0, avoid.minZ - r.maxZ - 1, r.minZ - avoid.maxZ - 1);
      const gap = Math.hypot(dx, dz);
      if (gap >= minGap && gap <= searchTo && clearOf.every(c => gapTo(r, c.box) >= c.gap)) cands.push({ cx, cz, r, gap });
    }
  }
  cands.sort((a, b) => a.gap - b.gap);
  const midX = (avoid.minX + avoid.maxX) / 2, midZ = (avoid.minZ + avoid.maxZ) / 2;
  let best = null;
  for (const c of cands) {
    if (best && c.gap > best.gap + 1) break;
    await pace();
    let ok = true, lo = Infinity, hi = -Infinity;
    const hs = [];
    for (let z = c.r.minZ; z <= c.r.maxZ && ok; z++) {
      for (let x = c.r.minX; x <= c.r.maxX; x++) {
        const i = (z - g.z0) * g.W + (x - g.x0);
        if (g.kind[i] !== LAND) { refused.not_land++; ok = false; break; }
        if (g.trunk[i]) { refused.trunk++; ok = false; break; }
        hs.push(g.height[i]); lo = Math.min(lo, g.height[i]); hi = Math.max(hi, g.height[i]);
      }
    }
    if (!ok) continue;
    // The floor that needs the fewest cells filled, then the fewest blocks cut, then the nearest to groundY:
    // a cut needs no material and a fill needs blocks the crew may not hold yet.
    const cutAt = F => hs.reduce((n, h) => n + Math.max(0, h - F), 0);
    const fillAt = F => hs.filter(h => h < F).length;
    const floor = floors.map(d => groundY + d).filter(F => lo >= F - fillMax && hi <= F + scrapeMax)
      .sort((a, b) => (fillAt(a) - fillAt(b)) || (cutAt(a) - cutAt(b)) || (Math.abs(a - groundY) - Math.abs(b - groundY)))[0];
    if (floor === undefined) { refused.too_uneven++; continue; }
    const scrape = cutAt(floor);
    const fill = fillAt(floor);
    const mid = Math.round(Math.hypot(c.cx - midX, c.cz - midZ));
    if (!best || mid < best.mid || (mid === best.mid && scrape + fill < best.scrape + best.fill)) {
      best = { gap: c.gap, mid, center: { x: c.cx, y: floor, z: c.cz }, floor, scrape, fill };
    }
  }
  if (!best) return { found: false, refused, candidates: cands.length };
  const { mid: _mid, ...site } = best;
  return { found: true, ...site, gap: Math.round(best.gap * 10) / 10, refused };
}

module.exports = {
  readSurface, summedArea, percentileFromHist, footprintPass1, footprintPass2, surveyFootprint, siteBeside,
  Y_TOP, Y_BOTTOM, H_BINS, LAND, WATER, LAVA, COVER, WATER_SURFACE, FOOT_STRIDE, RING_LAND, TOLERANCES, LEVEL_SHARE,
  STONE_YIELD, DIRT_YIELD, FALLING,
};
