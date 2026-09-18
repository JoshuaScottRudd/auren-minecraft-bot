'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/zone_flatness.js');
// tool: zone_flatness — scan saved loaded zones for building spots: how flat the ground is per biome, how much wood
// stands near it, and what it costs to TERRAFORM a village's worth of building pads level.
// No server, no client, no crew: each zone is a voxel snapshot loaded by voxel_snapshot_store, read through the fleet's
// one bulk voxel reader, and judged with site_geometry's own definition of ground.
//
// ── WHAT THE ZONES ARE, AND THE BIAS THEY CARRY ─────────────────────────────────────────────────────
// A snapshot is centred on a PERSON SPOT, and person_spot only accepts architect_config.ACCEPTABLE_BIOMES (the plains
// and forest family). So every zone is centred on that family by construction, and another biome appears only where
// it lies within ~185 blocks of one. A biome absent from this report says where the capture may stand, not what the
// seed holds.
//
// ── WHAT "GROUND" IS HERE ───────────────────────────────────────────────────────────────────────────
// The surface of a column is the topmost block that is site_geometry.isGround AND not canopy (isCanopy). isGround
// alone already passes over CLEARABLE cover (vegetation, snow, the common logs and leaves); the canopy suffix rule is
// added because a village clears trees before it builds, and a wood type CLEARABLE predates (pale_oak) would otherwise
// read its trunk top as a hill. Water, the plants that only grow in water, and ice end the surface as WATER; the scan
// then carries on down to the BED, because a pad over a pond is filled from its bed. Lava ends it as LAVA.
// The biome of a column is the biome AT its surface cell (biomes are 3D, so a cave biome can surface in an opening).
//
// ── WOOD ────────────────────────────────────────────────────────────────────────────────────────────
// LOGS = every `_log` block the downward scan passes above the ground; TRUNKS = columns whose block directly above the
// ground is a log (a 2x2 dark oak is four). Logs are the wood supply; trunks are how many trees must be felled. Wood
// is counted inside the village site plus TREE_MARGIN blocks around it, the walk a gatherer makes, clipped to the
// loaded box (a clipped count says so).
//
// ── FLATNESS AS FOUND (the ground tables) ───────────────────────────────────────────────────────────
//   STEP        — the largest height difference to a land neighbour: 0 or 1 is walkable, 2 needs a stair, 3+ is a
//                 cliff edge.
//   AREA RELIEF — highest minus lowest land within a 33x33 square around the column: plain, rolling, or mountainside.
//
// ── WHAT IT TAKES TO MAKE IT FLAT (the terraform model) ─────────────────────────────────────────────
// A village is BUILDINGS pads of BUILDING x BUILDING (the footprint of the largest blueprint in use) on a GRID x GRID
// lattice with ROAD blocks between pads, so a site is a square of GRID * (BUILDING + ROAD) blocks swept at a stride of
// 8. Each pad is levelled to ONE height h (the top of the ground the building stands on):
//   CUT  = ground above h, scraped off;  FILL = h minus the ground (or the water bed) below it, filled in.
// The pads of one site may sit at different heights, but every chosen pad lies inside one BAND of --band levels
// (highest pad minus lowest pad <= band), so the roads between them stay a few steps. For each band position the
// cheapest pad height per cell is found exactly (cut and fill from sorted column heights and prefix sums), the
// BUILDINGS cheapest cells are chosen, and the cheapest band position wins. A pad may not sit below the surface of
// water it covers (it would need draining, which this model does not price). A cell touching lava or unloaded ground
// is not a candidate. Score = blocks moved (cut + fill). Cut earth is fill material, so NET = cut - fill says whether
// a site has spare blocks or must bring them in.
// Not priced: road earthwork, the ground under the roads, trees felled (counted, not costed), flooding when a cut goes
// below a nearby water surface.
// WRONG TURN, and why this replaced it: ranking sites by plots that were ALREADY flat (9x9 slots under a range limit)
// favours whatever the world happened to generate and ignores that the fleet digs. With 17x17 buildings a flat 9x9
// says little; the question is how many blocks it takes to make the pads, and that is what is ranked.
//
// ── ONE LARGE FOOTPRINT (--footprint=WxL): a downloaded blueprint sunk to natural ground ─────────────────
// A downloaded blueprint is entered only from BELOW: the bots dig the whole footprint out horizontally, one Y layer at
// a time from the top, down to a basement under the blueprint's lowest layer, then build upward. Nothing natural is
// kept inside the footprint, so the cost of a site is what must be DUG, and its risks are what the dig opens into.
//   GROUND FLOOR h — the median ground height of the RING of natural ground --ring blocks wide around the footprint.
//     The ring is what the finished building is seen standing on, so h is read there and not inside the footprint,
//     where a hill or a hollow would move it. Every column of the ring must be loaded and at least RING_LAND of it
//     land; a lake beside the site would be the pit's wall.
//   THE PIT — every block from a footprint column's surface down to h - --below (the blueprint layers under its ground
//     floor plus the basement's height); the pit floor is the next layer down and must be solid to stand on.
// Two passes. The first reads only the surface arrays (fast, every position in both orientations): h, the dig
// estimate as if the pit were solid, the hill above h and the ring's spread, and for each of TOLERANCES the share of
// footprint and ring ground more than T levels from h. A position is LEVEL at ±T when that share is at most
// LEVEL_SHARE (a boulder or a lone house must not disqualify a plot, a hillside must). Level positions, nearest to
// level first, are packed greedily into SEPARATE PLOTS that share no footprint column; each plot goes to the second
// pass, which reads every voxel of the pit, its floor and a one-block SHELL around it
// through the fleet reader: solid blocks dug (by what they yield), cave air inside, water and lava anywhere in pit,
// floor or shell, and cave openings in the shell. A site passes only with no water and no lava in any of the three
// (an opened lake or lava pocket floods the basement the bots work in). Both passes rank by OFF LEVEL: the summed
// distance from h of every footprint column (hill above, hollow below) and every ring column — how far the site and
// its surroundings are from the ground floor the building will show.
// WRONG TURNS. (1) Picking h as the cheapest level (the pad model's choice) sinks or raises the building against its
// own surroundings, which the Architect ruled out. (2) Ranking by fewest blocks dug rewards a pit that is already
// partly empty: that ranking's best site stood over a ravine to y27, with 1,240 of its 2,173 floor cells open. The
// dig of a level site is fixed by the footprint (columns x layers), so a smaller dig mostly means a hole. (3) Counting
// positions that passed the voxel read as "spots": positions sit every 4 blocks in both orientations, so hundreds of
// them are the same few places shifted, and water/lava alone is no levelness test. The count is separate level plots.
//
// Usage (developer mode):
//   node Auren_Workshop/tools/zone_flatness.js [--snapshots=all|label,label] [--band=4] [--buildings=10] [--building=17]
//   node Auren_Workshop/tools/zone_flatness.js --footprint=41x53 [--below=7] [--ring=8] [--snapshots=...]
// Writes every table's numbers to fleet_logs/zone_flatness.json (the footprint mode to zone_flatness_footprint.json).
// Exit: 0 ran · 1 no snapshot to run on.

const fs = require('fs');
const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();
process.env.BOT_ID = process.env.BOT_ID || 'zone_flatness';

const store = require('./voxel_snapshot_store');
const { makeVoxelReader } = require('@utils/voxel_reader');
const geo = require('@utils/site_geometry');

const args = process.argv.slice(2);
const opt = (k, fallback) => { const hit = args.find(a => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : fallback; };
const intOpt = (k, fallback, min) => {
  const v = Number(opt(k, String(fallback)));
  if (!Number.isInteger(v) || v < min) throw new Error(`[zone_flatness] CODING VIOLATION: --${k}=${opt(k)} must be a whole number of at least ${min}.`);
  return v;
};
const say = m => console.log(m);
const pad = (v, n) => String(v).padEnd(n);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const kilo = n => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

const Y_TOP = 319, Y_BOTTOM = -64, H_BINS = Y_TOP - Y_BOTTOM + 1;
const LAND = 1, WATER = 2, LAVA = 3;                    // 0 = unloaded (the zero-filled array's own value)
const COVER = 0;
const WATER_SURFACE = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'ice', 'frosted_ice']);
const NO_RANGE = 255, AREA_RADIUS = 16, SITE_STRIDE = 8, TREE_MARGIN = 48, DOMINANT = 0.5, GRID = 4, KEEP_PER_ZONE = 3, KEEP_OVERALL = 10;

const BAND = intOpt('band', 4, 0);
const BUILDINGS = intOpt('buildings', 10, 1);
const BUILDING = intOpt('building', 17, 3);
const ROAD = 3;
const PITCH = BUILDING + ROAD;
const SITE = GRID * PITCH;
if (BUILDINGS > GRID * GRID) throw new Error(`[zone_flatness] CODING VIOLATION: --buildings=${BUILDINGS} does not fit a ${GRID}x${GRID} lattice of ${GRID * GRID} pads.`);

const FOOTPRINT = opt('footprint', null);
const FOOT = FOOTPRINT && (() => {
  const m = /^(\d+)x(\d+)$/.exec(FOOTPRINT);
  if (!m) throw new Error(`[zone_flatness] CODING VIOLATION: --footprint=${FOOTPRINT} must be WIDTHxLENGTH in blocks, for example --footprint=41x53.`);
  return { w: Number(m[1]), l: Number(m[2]) };
})();
const BELOW = intOpt('below', 7, 0);
const RING = intOpt('ring', 8, 1);
const FOOT_STRIDE = 4, RING_LAND = 0.9, TOLERANCES = [1, 2, 3, 5], LEVEL_SHARE = 0.02, SHOWN_TOLERANCE = 2;
const STONE_YIELD = new Set(['stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'cobblestone', 'calcite', 'smooth_basalt']);
const DIRT_YIELD = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud', 'dirt_path']);
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel']);

// ── Part 1: the surface, water bed and wood of every loaded column ─────────────────────────────────
function readSurface(bot) {
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

// ── Part 2: steps and local relief ─────────────────────────────────────────────────────────────────
// step[i] — the largest height difference to a LAND neighbour (a shore is not a step). NO_RANGE for non-land.
function stepMap({ W, D, kind, height }) {
  const step = new Uint8Array(W * D).fill(NO_RANGE);
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (kind[i] !== LAND) continue;
      let m = 0;
      const look = j => { if (kind[j] === LAND) m = Math.max(m, Math.abs(height[i] - height[j])); };
      if (x > 0) look(i - 1);
      if (x < W - 1) look(i + 1);
      if (z > 0) look(i - W);
      if (z < D - 1) look(i + W);
      step[i] = Math.min(m, 254);
    }
  }
  return step;
}

// areaRelief[i] — highest minus lowest LAND within the (2R+1)^2 square around a land column, NO_RANGE for non-land.
// Separable: a row pass then a column pass for max and for min; water and unloaded cells simply contribute nothing.
function areaReliefMap({ W, D, kind, height }) {
  const R = AREA_RADIUS, N = W * D;
  const rowHi = new Int16Array(N), rowLo = new Int16Array(N);
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      let hi = -32768, lo = 32767;
      for (let xx = Math.max(0, x - R); xx <= Math.min(W - 1, x + R); xx++) {
        const j = z * W + xx;
        if (kind[j] !== LAND) continue;
        if (height[j] > hi) hi = height[j];
        if (height[j] < lo) lo = height[j];
      }
      rowHi[z * W + x] = hi; rowLo[z * W + x] = lo;
    }
  }
  const relief = new Uint8Array(N).fill(NO_RANGE);
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (kind[i] !== LAND) continue;
      let hi = -32768, lo = 32767;
      for (let zz = Math.max(0, z - R); zz <= Math.min(D - 1, z + R); zz++) {
        const j = zz * W + x;
        if (rowHi[j] > hi) hi = rowHi[j];
        if (rowLo[j] < lo) lo = rowLo[j];
      }
      relief[i] = Math.min(hi - lo, 254);
    }
  }
  return relief;
}

// A summed-area table, so any box's total is four lookups.
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

// ── Part 3: the terraform model ────────────────────────────────────────────────────────────────────
function percentileFromHist(hist, count, p, offset = 0) {
  const target = Math.max(1, Math.ceil(p * count));
  let seen = 0;
  for (let b = 0; b < hist.length; b++) { seen += hist[b]; if (seen >= target) return b + offset; }
  return hist.length - 1 + offset;
}

// padStats — one BUILDING x BUILDING pad whose min corner is (px, pz): the sorted ground (bed under water) heights and
// their prefix sums, so cut and fill at any level are two binary searches. null when any column is unloaded or lava.
function padStats(g, px, pz) {
  const n = BUILDING * BUILDING;
  const v = new Int16Array(n);
  const biomeCount = new Map();
  let k = 0, waterTop = -Infinity, waterCols = 0;
  for (let z = pz; z < pz + BUILDING; z++) {
    for (let x = px; x < px + BUILDING; x++) {
      const i = z * g.W + x;
      const kind = g.kind[i];
      if (kind === 0 || kind === LAVA) return null;
      if (kind === WATER) { waterCols++; if (g.height[i] > waterTop) waterTop = g.height[i]; }
      v[k++] = g.bed[i];
      biomeCount.set(g.biome[i], (biomeCount.get(g.biome[i]) || 0) + 1);
    }
  }
  v.sort();
  const pre = new Float64Array(n + 1);
  for (let j = 0; j < n; j++) pre[j + 1] = pre[j] + v[j];
  return { v, pre, n, waterTop, waterCols, median: v[n >> 1], biomeCount };
}

// earthwork(stats, h) → { cut, fill } levelling the pad's ground to h, or null when h is below water it covers.
function earthwork(s, h) {
  if (h < s.waterTop) return null;
  let lo = 0, hi = s.n;                                  // first index with v >= h
  while (lo < hi) { const m = (lo + hi) >> 1; if (s.v[m] < h) lo = m + 1; else hi = m; }
  const below = lo;
  lo = below; hi = s.n;                                  // first index with v > h
  while (lo < hi) { const m = (lo + hi) >> 1; if (s.v[m] <= h) lo = m + 1; else hi = m; }
  const above = lo;
  return { cut: (s.pre[s.n] - s.pre[above]) - h * (s.n - above), fill: h * below - s.pre[below] };
}

function evaluateSite(g, padMemo, ox, oz) {
  const cells = [];
  for (let gz = 0; gz < GRID; gz++) {
    for (let gx = 0; gx < GRID; gx++) {
      const px = ox + gx * PITCH + 1, pz = oz + gz * PITCH + 1;
      const key = pz * g.W + px;
      if (!padMemo.has(key)) padMemo.set(key, padStats(g, px, pz));
      const s = padMemo.get(key);
      if (s) cells.push({ px, pz, s });
    }
  }
  if (cells.length < BUILDINGS) return { ox, oz, feasible: false, why: 'lava_or_unloaded', usable: cells.length };
  const medians = cells.map(c => Math.max(c.s.median, c.s.waterTop));
  const lowest = Math.min(...medians) - BAND, highest = Math.max(...medians);
  let best = null;
  for (let L = lowest; L <= highest; L++) {
    const choice = [];
    for (const c of cells) {
      let pick = null;
      for (let h = L; h <= L + BAND; h++) {
        const e = earthwork(c.s, h);
        if (e && (!pick || e.cut + e.fill < pick.cut + pick.fill)) pick = { h, ...e };
      }
      if (pick) choice.push({ c, ...pick });
    }
    if (choice.length < BUILDINGS) continue;
    choice.sort((a, b) => (a.cut + a.fill) - (b.cut + b.fill));
    const pads = choice.slice(0, BUILDINGS);
    const moved = pads.reduce((n, p) => n + p.cut + p.fill, 0);
    if (!best || moved < best.moved) best = { moved, pads };
  }
  if (!best) return { ox, oz, feasible: false, why: 'pads_below_water', usable: cells.length };
  const pads = best.pads;
  const cut = pads.reduce((n, p) => n + p.cut, 0), fill = pads.reduce((n, p) => n + p.fill, 0);
  const levels = pads.map(p => p.h);
  const biomeCount = new Map();
  for (const p of pads) for (const [b, n] of p.c.s.biomeCount) biomeCount.set(b, (biomeCount.get(b) || 0) + n);
  const dominant = [...biomeCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const padArea = BUILDINGS * BUILDING * BUILDING;
  return {
    ox, oz, feasible: true, cut, fill, moved: cut + fill, net: cut - fill,
    levelLow: Math.min(...levels), levelHigh: Math.max(...levels),
    groundLow: Math.min(...pads.map(p => p.c.s.v[0])), groundHigh: Math.max(...pads.map(p => p.c.s.v[p.c.s.n - 1])),
    deepestCut: Math.max(0, ...pads.map(p => p.c.s.v[p.c.s.n - 1] - p.h)), deepestFill: Math.max(0, ...pads.map(p => p.h - p.c.s.v[0])),
    cutPerColumn: cut / padArea, fillPerColumn: fill / padArea,
    waterColumns: pads.reduce((n, p) => n + p.c.s.waterCols, 0),
    biome: g.biomeName(dominant[0]), biomeShare: dominant[1] / padArea,
    pads: pads.map(p => ({ x: g.x0 + p.c.px, z: g.z0 + p.c.pz, level: p.h, cut: p.cut, fill: p.fill })),
  };
}

// ── Part 4: one large footprint ────────────────────────────────────────────────────────────────────
// Pass 1 — surface arrays only. Every min corner of the footprint-plus-ring box at FOOT_STRIDE, both orientations.
function footprintPass1(g, fw, fl, trunksIn) {
  const tw = fw + 2 * RING, tl = fl + 2 * RING;
  const ringCols = tw * tl - fw * fl;
  const hist = new Uint32Array(H_BINS);
  const sites = [], refused = { unloaded_or_lava: 0, water_in_footprint: 0, ring_not_land: 0 };
  for (let oz = 0; oz + tl <= g.D; oz += FOOT_STRIDE) {
    for (let ox = 0; ox + tw <= g.W; ox += FOOT_STRIDE) {
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
function footprintPass2(g, reader, site) {
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

function surveyFootprint(g, bot, label, person) {
  const logsIn = summedArea(g.W, g.D, i => g.logs[i]);
  const trunksIn = summedArea(g.W, g.D, i => g.trunk[i]);
  const orientations = FOOT.w === FOOT.l ? [[FOOT.w, FOOT.l]] : [[FOOT.w, FOOT.l], [FOOT.l, FOOT.w]];
  const all = [], refused = { unloaded_or_lava: 0, water_in_footprint: 0, ring_not_land: 0 };
  for (const [fw, fl] of orientations) {
    const p1 = footprintPass1(g, fw, fl, trunksIn);
    all.push(...p1.sites);
    for (const k of Object.keys(refused)) refused[k] += p1.refused[k];
  }
  all.sort((a, b) => a.offLevel - b.offLevel);
  const reader = makeVoxelReader(bot, { needs: ['type'] });
  const readMemo = new Map();
  const readSite = s => {
    const key = `${s.ox},${s.oz},${s.fw}`;
    if (readMemo.has(key)) return readMemo.get(key);
    const cx = s.ox + RING + s.fw / 2, cz = s.oz + RING + s.fl / 2;
    const bx = Math.max(0, s.ox - TREE_MARGIN), bz = Math.max(0, s.oz - TREE_MARGIN);
    const bw = Math.min(g.W, s.ox + s.fw + 2 * RING + TREE_MARGIN) - bx, bd = Math.min(g.D, s.oz + s.fl + 2 * RING + TREE_MARGIN) - bz;
    const read = {
      ...s, ...footprintPass2(g, reader, s), zone: label,
      centre: { x: g.x0 + Math.floor(cx), z: g.z0 + Math.floor(cz) },
      corner: { x: g.x0 + s.ox + RING, z: g.z0 + s.oz + RING },
      fromStart: Math.round(Math.hypot(g.x0 + cx - person.x, g.z0 + cz - person.z)),
      trunksNear: trunksIn(bx, bz, bw, bd), logsNear: logsIn(bx, bz, bw, bd),
      woodBoxClipped: bw < s.fw + 2 * RING + 2 * TREE_MARGIN || bd < s.fl + 2 * RING + 2 * TREE_MARGIN,
    };
    readMemo.set(key, read);
    return read;
  };
  // Per tolerance: positions that are level enough, then SEPARATE PLOTS — greedy, nearest-to-level first, a position
  // is taken only when its footprint shares no column with a footprint already taken — then which of those pass the
  // voxel read. Greedy packing is a lower bound on how many disjoint plots the zone could hold.
  const byTolerance = TOLERANCES.map((t, k) => {
    const level = all.filter(s => s.outsideShare[k] <= LEVEL_SHARE);
    const plots = [];
    for (const s of level) {
      const clash = plots.some(p => s.ox + RING < p.ox + RING + p.fw && p.ox + RING < s.ox + RING + s.fw && s.oz + RING < p.oz + RING + p.fl && p.oz + RING < s.oz + RING + s.fl);
      if (!clash) plots.push(s);
    }
    const read = plots.map(readSite);
    return { tolerance: t, levelPositions: level.length, plots: read.length, passingPlots: read.filter(s => s.passes).length, picks: read };
  });
  reader.dispose();
  return { positions: all.length, refused, byTolerance };
}

// ── Per-biome ground ───────────────────────────────────────────────────────────────────────────────
function newBiomeRow() {
  return {
    columns: 0, land: 0, water: 0, lava: 0, steps: [0, 0, 0, 0], logs: 0, trunks: 0,
    reliefHist: new Uint32Array(NO_RANGE), heightHist: new Uint32Array(H_BINS), surface: new Map(), zones: new Set(),
  };
}
function mergeBiomeRow(into, from) {
  for (const k of ['columns', 'land', 'water', 'lava', 'logs', 'trunks']) into[k] += from[k];
  from.steps.forEach((n, i) => { into.steps[i] += n; });
  for (const k of ['reliefHist', 'heightHist']) from[k].forEach((n, i) => { into[k][i] += n; });
  for (const [n, c] of from.surface) into.surface.set(n, (into.surface.get(n) || 0) + c);
  for (const z of from.zones) into.zones.add(z);
}

// ── The survey ─────────────────────────────────────────────────────────────────────────────────────
function surveyZone(snap) {
  const t0 = Date.now();
  const bot = store.loadSnapshot(snap.name);
  const g = readSurface(bot);
  const step = stepMap(g);
  const areaRelief = areaReliefMap(g);
  const label = snap.header.label;
  const person = bot.snapshot.person;

  const zone = newBiomeRow();
  const perBiome = new Map();
  for (let i = 0; i < g.W * g.D; i++) {
    const k = g.kind[i];
    if (!k) continue;
    const name = g.biomeName(g.biome[i]);
    if (!perBiome.has(name)) perBiome.set(name, newBiomeRow());
    const surfaceName = g.stateName.get(g.state[i]);
    for (const row of [zone, perBiome.get(name)]) {
      row.columns++; row.zones.add(label);
      row.surface.set(surfaceName, (row.surface.get(surfaceName) || 0) + 1);
      row.logs += g.logs[i]; row.trunks += g.trunk[i];
      if (k === WATER) row.water++;
      if (k === LAVA) row.lava++;
      if (k === LAND) {
        row.land++;
        row.steps[Math.min(step[i], 3)]++;
        row.reliefHist[areaRelief[i]]++;
        row.heightHist[g.height[i] - Y_BOTTOM]++;
      }
    }
  }

  if (FOOT) {
    const footprint = surveyFootprint(g, bot, label, person);
    return { snap, label, g, zone, perBiome, footprint, totalMs: Date.now() - t0, person, near: bot.snapshot.near };
  }

  const logsIn = summedArea(g.W, g.D, i => g.logs[i]);
  const trunksIn = summedArea(g.W, g.D, i => g.trunk[i]);
  const padMemo = new Map();
  const sites = [], infeasible = { lava_or_unloaded: 0, pads_below_water: 0 };
  for (let oz = 0; oz + SITE <= g.D; oz += SITE_STRIDE) {
    for (let ox = 0; ox + SITE <= g.W; ox += SITE_STRIDE) {
      const s = evaluateSite(g, padMemo, ox, oz);
      if (!s.feasible) { infeasible[s.why]++; continue; }
      const bx = Math.max(0, ox - TREE_MARGIN), bz = Math.max(0, oz - TREE_MARGIN);
      const bw = Math.min(g.W, ox + SITE + TREE_MARGIN) - bx, bd = Math.min(g.D, oz + SITE + TREE_MARGIN) - bz;
      s.logs = logsIn(bx, bz, bw, bd); s.trunks = trunksIn(bx, bz, bw, bd);
      s.woodBoxClipped = bw < SITE + 2 * TREE_MARGIN || bd < SITE + 2 * TREE_MARGIN;
      s.centre = { x: g.x0 + ox + SITE / 2, z: g.z0 + oz + SITE / 2 };
      s.fromStart = Math.round(Math.hypot(s.centre.x - person.x, s.centre.z - person.z));
      s.zone = label;
      sites.push(s);
    }
  }
  sites.sort((a, b) => a.moved - b.moved);
  return { snap, label, g, zone, perBiome, sites, infeasible, totalMs: Date.now() - t0, person, near: bot.snapshot.near };
}

function nonOverlapping(sites, keep) {
  const picked = [];
  for (const s of sites) {
    if (picked.some(p => p.zone === s.zone && Math.abs(p.ox - s.ox) < SITE && Math.abs(p.oz - s.oz) < SITE)) continue;
    picked.push(s);
    if (picked.length >= keep) break;
  }
  return picked;
}

const topSurface = (row, n) => {
  const total = [...row.surface.values()].reduce((a, b) => a + b, 0);
  return [...row.surface.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${Math.round((100 * v) / total)}%`).join(', ');
};

function printGroundTable(title, rows) {
  say(`\n════ ${title} ════`);
  say(`${pad('', 24)}${pad('columns', 9)}${pad('land', 6)}${pad('water', 7)}${pad('step0', 7)}${pad('step1', 7)}${pad('step2', 7)}${pad('step3+', 8)}` +
    `${pad('area relief p50/p90', 21)}${pad('ground y p5-p95', 17)}${pad('trees/1k land', 15)}${pad('logs/1k land', 14)}surface`);
  for (const [name, r] of rows) {
    const reliefTxt = r.land ? `${percentileFromHist(r.reliefHist, r.land, 0.5)}/${percentileFromHist(r.reliefHist, r.land, 0.9)}` : '-';
    const yTxt = r.land ? `${percentileFromHist(r.heightHist, r.land, 0.05, Y_BOTTOM)}-${percentileFromHist(r.heightHist, r.land, 0.95, Y_BOTTOM)}` : '-';
    say(`${pad(name, 24)}${pad(r.columns, 9)}${pad(pct(r.land, r.columns), 6)}${pad(pct(r.water, r.columns), 7)}` +
      `${r.steps.map((n, i) => pad(pct(n, r.land), i === 3 ? 8 : 7)).join('')}${pad(reliefTxt, 21)}${pad(yTxt, 17)}` +
      `${pad(r.land ? Math.round((1000 * r.trunks) / r.land) : '-', 15)}${pad(r.land ? Math.round((1000 * r.logs) / r.land) : '-', 14)}${topSurface(r, 4)}`);
  }
}

const siteHeader = () => `${pad('zone', 7)}${pad('centre', 14)}${pad('from start', 12)}${pad('biome under pads', 26)}${pad('moved', 8)}${pad('cut', 8)}${pad('fill', 8)}` +
  `${pad('net', 9)}${pad('scrape/col', 11)}${pad('deepest cut', 13)}${pad('deepest fill', 14)}${pad('pad levels', 12)}${pad('ground y', 10)}${pad('water cols', 12)}${pad('trees', 7)}logs`;
const siteLine = s => `${pad(s.zone, 7)}${pad(`${s.centre.x},${s.centre.z}`, 14)}${pad(`${s.fromStart}b`, 12)}${pad(`${s.biome} ${Math.round(100 * s.biomeShare)}%`, 26)}` +
  `${pad(kilo(s.moved), 8)}${pad(kilo(s.cut), 8)}${pad(kilo(s.fill), 8)}${pad(`${s.net >= 0 ? '+' : '-'}${kilo(Math.abs(s.net))}`, 9)}${pad(s.cutPerColumn.toFixed(1), 11)}` +
  `${pad(s.deepestCut, 13)}${pad(s.deepestFill, 14)}${pad(`y${s.levelLow}-${s.levelHigh}`, 12)}${pad(`${s.groundLow}-${s.groundHigh}`, 10)}${pad(s.waterColumns, 12)}` +
  `${pad(s.trunks, 7)}${s.logs}${s.woodBoxClipped ? ' (wood box clipped)' : ''}`;

function reportFootprint(results) {
  const pitLayers = BELOW + 1;
  say(`\n════ ONE FOOTPRINT ${FOOT.w}x${FOOT.l} (either way round) — ground floor h = median ground of the ${RING}-wide ring; ` +
    `pit dug from each column's surface down to h-${BELOW} (${pitLayers} layers when the ground is level); floor at h-${BELOW + 1} ════`);
  for (const r of results) {
    const f = r.footprint;
    say(`${pad(r.label, 7)} ${f.positions} positions (every 4 blocks, both ways round — they overlap heavily); refused: ${f.refused.unloaded_or_lava} unloaded or lava, ` +
      `${f.refused.water_in_footprint} water in the footprint, ${f.refused.ring_not_land} ring under ${RING_LAND * 100}% land; ${(r.totalMs / 1000).toFixed(1)} s`);
  }
  say(`\n════ HOW MANY SEPARATE PLOTS — level = at least ${100 - LEVEL_SHARE * 100}% of footprint and ring ground within ±T levels of h; ` +
    `plots share no footprint column; "clean" = no water or lava in pit, floor or one-block shell ════`);
  say(`${pad('zone', 8)}${TOLERANCES.map(t => pad(`±${t}: level positions / plots / clean`, 34)).join('')}`);
  const totals = TOLERANCES.map(() => [0, 0, 0]);
  for (const r of results) {
    say(`${pad(r.label, 8)}${r.footprint.byTolerance.map((b, k) => {
      totals[k][0] += b.levelPositions; totals[k][1] += b.plots; totals[k][2] += b.passingPlots;
      return pad(`${b.levelPositions} / ${b.plots} / ${b.passingPlots}`, 34);
    }).join('')}`);
  }
  say(`${pad('all', 8)}${totals.map(([a, b, c]) => pad(`${a} / ${b} / ${c}`, 34)).join('')}`);
  const shown = TOLERANCES.indexOf(SHOWN_TOLERANCE);
  const header = `${pad('zone', 7)}${pad('size', 7)}${pad('centre', 13)}${pad('corner', 13)}${pad('from start', 11)}${pad('biome under it', 24)}${pad('h', 5)}` +
    `${pad('ring p10-p90', 13)}${pad('ground y', 10)}${pad('to ground', 10)}${pad('hollow', 7)}${pad('layers dug', 11)}${pad('off level', 10)}${pad('dug', 7)}${pad('above h', 9)}${pad('stone', 7)}${pad('dirt', 6)}${pad('falling', 8)}${pad('ore', 5)}` +
    `${pad('cave air', 9)}${pad('floor open', 11)}${pad('water p/f/s', 12)}${pad('lava p/f/s', 11)}${pad('shell cave', 11)}${pad('trees on it', 12)}trees/logs near`;
  const line = s => `${pad(s.zone, 7)}${pad(`${s.fw}x${s.fl}`, 7)}${pad(`${s.centre.x},${s.centre.z}`, 13)}${pad(`${s.corner.x},${s.corner.z}`, 13)}${pad(`${s.fromStart}b`, 11)}` +
    `${pad(`${s.biome} ${Math.round(100 * s.biomeShare)}%`, 24)}${pad(s.h, 5)}${pad(`${s.ringP10}-${s.ringP90}`, 13)}${pad(`${s.groundLow}-${s.groundHigh}`, 10)}` +
    `${pad(s.layersToGround, 10)}${pad(s.deepestHollow, 7)}${pad(s.layersDug, 11)}${pad(kilo(s.offLevel), 10)}${pad(kilo(s.dug), 7)}${pad(kilo(s.hill), 9)}${pad(kilo(s.stone), 7)}${pad(kilo(s.dirt), 6)}${pad(s.falling, 8)}${pad(s.ore, 5)}${pad(s.caveAir, 9)}${pad(s.floorOpen, 11)}` +
    `${pad(`${s.water}/${s.floorWater}/${s.shellWater}`, 12)}${pad(`${s.lava}/${s.floorLava}/${s.shellLava}`, 11)}${pad(s.shellCave, 11)}${pad(s.trunksInFootprint, 12)}` +
    `${s.trunksNear}/${s.logsNear}${s.woodBoxClipped ? ' (clipped)' : ''}`;
  const every = results.flatMap(r => r.footprint.byTolerance[shown].picks).sort((a, b) => (b.passes - a.passes) || (a.offLevel - b.offLevel));
  say(`\n════ EVERY SEPARATE PLOT LEVEL WITHIN ±${SHOWN_TOLERANCE}, clean first, nearest to level first ════`);
  say(`to ground = layers scraped off the highest column to reach h · hollow = deepest column below h · layers dug = highest column down to h-${BELOW} · ` +
    'off level = summed |ground - h| over footprint and ring · dug = solid blocks inside the pit · above h = of those, how many stand above the ground floor · water/lava p/f/s = pit/floor/shell cells');
  say(header);
  for (const s of every) say(`${line(s)}${s.passes ? '' : '  NOT CLEAN'}`);
  const out = paths.fleetLogs('zone_flatness_footprint.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    model: { footprint: FOOT, below: BELOW, ring: RING, ringLand: RING_LAND, stride: FOOT_STRIDE, tolerances: TOLERANCES, levelShare: LEVEL_SHARE, treeMargin: TREE_MARGIN },
    zones: results.map(r => ({ label: r.label, snapshot: r.snap.name, positions: r.footprint.positions, refused: r.footprint.refused, byTolerance: r.footprint.byTolerance })),
  }, null, 1));
  say(`\nwrote ${out}`);
  return 0;
}

function main() {
  const all = store.listSnapshots();
  const wanted = opt('snapshots', 'all');
  const chosen = wanted === 'all' ? all : wanted.split(',').map(w => all.find(s => s.name === w || s.header.label === w)).filter(Boolean);
  if (!chosen.length) { say(`zone_flatness: no snapshots to run (${all.length} saved). Capture with voxel_snapshot.js capture --near=X,Z.`); return 1; }

  const results = chosen.map(snap => surveyZone(snap));
  if (FOOT) return reportFootprint(results);

  say(`\n════ ZONES ════`);
  for (const r of results) {
    say(`${pad(r.label, 7)} asked near (${r.near.x},${r.near.z}), centred on (${r.person.x},${r.person.y},${r.person.z}) ${r.person.biome}; ` +
      `box x${r.g.x0}..${r.g.x0 + r.g.W - 1} z${r.g.z0}..${r.g.z0 + r.g.D - 1}; ${r.perBiome.size} biomes; ${r.sites.length} sites costed, ` +
      `${r.infeasible.lava_or_unloaded} touch unloaded or lava, ${r.infeasible.pads_below_water} would need pads under water; ${(r.totalMs / 1000).toFixed(1)} s`);
  }
  printGroundTable('ZONE GROUND (step = height change to a neighbour; area relief = high minus low within 33x33)', results.map(r => [r.label, r.zone]));

  const biomeAll = new Map();
  for (const r of results) {
    for (const [name, row] of r.perBiome) {
      if (!biomeAll.has(name)) biomeAll.set(name, newBiomeRow());
      mergeBiomeRow(biomeAll.get(name), row);
    }
  }
  const biomeRows = [...biomeAll.entries()].sort((a, b) => b[1].columns - a[1].columns);
  say(`\n${biomeAll.size} biomes on the surface across ${results.length} zones.`);
  printGroundTable('BIOME GROUND, every biome, largest first', biomeRows);

  const padArea = BUILDINGS * BUILDING * BUILDING;
  say(`\n════ TERRAFORM MODEL — ${BUILDINGS} pads of ${BUILDING}x${BUILDING} (${padArea} columns) chosen from a ${GRID}x${GRID} lattice, ${ROAD}-block roads, ` +
    `site ${SITE}x${SITE} at stride ${SITE_STRIDE}, every pad within ${BAND} levels of the others; wood counted within ${TREE_MARGIN} blocks of the site ════`);
  say('moved = cut + fill · net + = spare blocks, - = blocks to bring · scrape/col = mean levels cut per pad column · pad levels = the pads\' finished ground heights');

  const everySite = results.flatMap(r => r.sites).sort((a, b) => a.moved - b.moved);
  say(`\n════ BEST ${KEEP_OVERALL} SITES OVERALL (non-overlapping) ════`);
  say(siteHeader());
  for (const s of nonOverlapping(everySite, KEEP_OVERALL)) say(siteLine(s));

  say(`\n════ BEST ${KEEP_PER_ZONE} SITES PER ZONE, and the spread of every costed site ════`);
  for (const r of results) {
    const moved = r.sites.map(s => s.moved);
    const q = p => (moved.length ? kilo(moved[Math.floor(p * (moved.length - 1))]) : '-');
    say(`${r.label}: ${r.sites.length} sites; blocks moved best ${q(0)}, 10th pct ${q(0.1)}, median ${q(0.5)}, worst ${q(1)}`);
    say(`  ${siteHeader()}`);
    for (const s of nonOverlapping(r.sites, KEEP_PER_ZONE)) say(`  ${siteLine(s)}`);
  }

  say(`\n════ TERRAFORM BY BIOME — sites filed under the biome holding >= ${DOMINANT * 100}% of their pad columns ════`);
  say(`${pad('', 24)}${pad('sites', 7)}${pad('best moved', 12)}${pad('median moved', 14)}${pad('best scrape/col', 17)}${pad('median trees', 14)}${pad('median logs', 13)}best site`);
  const byBiome = new Map();
  for (const s of everySite) {
    const home = s.biomeShare >= DOMINANT ? s.biome : 'mixed';
    if (!byBiome.has(home)) byBiome.set(home, []);
    byBiome.get(home).push(s);
  }
  const biomeTerraform = [...byBiome.entries()].map(([home, list]) => {
    const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) / 2)];
    return { home, sites: list.length, best: list[0], medianMoved: med(list.map(s => s.moved)), medianTrees: med(list.map(s => s.trunks)), medianLogs: med(list.map(s => s.logs)) };
  }).sort((a, b) => a.best.moved - b.best.moved);
  for (const b of biomeTerraform) {
    say(`${pad(b.home, 24)}${pad(b.sites, 7)}${pad(kilo(b.best.moved), 12)}${pad(kilo(b.medianMoved), 14)}${pad(b.best.cutPerColumn.toFixed(1), 17)}` +
      `${pad(b.medianTrees, 14)}${pad(b.medianLogs, 13)}${b.best.zone} (${b.best.centre.x},${b.best.centre.z})`);
  }

  const rowJson = row => ({
    columns: row.columns, land: row.land, water: row.water, lava: row.lava, steps: row.steps, logs: row.logs, trunks: row.trunks,
    areaReliefP50: row.land ? percentileFromHist(row.reliefHist, row.land, 0.5) : null,
    areaReliefP90: row.land ? percentileFromHist(row.reliefHist, row.land, 0.9) : null,
    groundYP5: row.land ? percentileFromHist(row.heightHist, row.land, 0.05, Y_BOTTOM) : null,
    groundYP95: row.land ? percentileFromHist(row.heightHist, row.land, 0.95, Y_BOTTOM) : null,
    surface: Object.fromEntries([...row.surface.entries()].sort((a, b) => b[1] - a[1])), zones: [...row.zones],
  });
  const siteJson = s => ({ ...s });
  const out = paths.fleetLogs('zone_flatness.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    model: { buildings: BUILDINGS, building: BUILDING, road: ROAD, grid: GRID, site: SITE, stride: SITE_STRIDE, band: BAND, treeMargin: TREE_MARGIN, areaRadius: AREA_RADIUS },
    biomes: Object.fromEntries(biomeRows.map(([n, row]) => [n, rowJson(row)])),
    terraformByBiome: biomeTerraform.map(b => ({ biome: b.home, sites: b.sites, medianMoved: b.medianMoved, medianTrees: b.medianTrees, medianLogs: b.medianLogs, best: siteJson(b.best) })),
    bestOverall: nonOverlapping(everySite, KEEP_OVERALL).map(siteJson),
    zones: results.map(r => ({
      snapshot: r.snap.name, label: r.label, seed: r.snap.header.seed, near: r.near, person: r.person, box: { x0: r.g.x0, z0: r.g.z0, w: r.g.W, d: r.g.D },
      ground: rowJson(r.zone), infeasible: r.infeasible, sitesCosted: r.sites.length,
      biomes: Object.fromEntries([...r.perBiome.entries()].map(([n, row]) => [n, rowJson(row)])),
      best: nonOverlapping(r.sites, KEEP_PER_ZONE).map(siteJson),
    })),
  }, null, 1));
  say(`\nwrote ${out}`);
  return 0;
}

process.exitCode = main();
