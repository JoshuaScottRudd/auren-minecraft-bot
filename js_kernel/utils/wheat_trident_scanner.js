// util: wheat_trident_scanner (farm siting — THE water-built wheat field, chosen by the Architect 2026-09-15 over the
//       bank farm and the bridge island; NOT yet wired into lock_all_buildspots, which still calls wheat_plot_scanner)
// purpose: site the phase-1 wheat field as TINES built out from the bank into sea-level water, as the anchors a body
//          stands on and the cells it places from each, so the build, tend and repair all run "stand on an anchor,
//          work the cells in front of it".
//
// ── A TINE ──────────────────────────────────────────────────────────────────────────────────────────────
// Three cells wide, one piece, rooted on the bank and running straight out over the water:
//        plot  A3  plot        ← row 2
//        plot  A2  plot        ← row 1
//        plot  A1  plot        ← row 0
//              A0              ← ANCHOR PRIME: the land cell the tine starts from
// A0 is land, reachable on foot from where the scan was asked. Every other anchor is a walkway block placed into the
// water. Row k is built, tended and repaired from anchor k: stand on A(k), place A(k+1) against it, then the two
// plots of row k against A(k+1). So a tine grows one row per visit and never needs a body in the water, and a broken
// anchor is fixed from the anchor before it — which is why A0 must be land.
//
// ── THE RULES THE LAYOUT KEEPS ──────────────────────────────────────────────────────────────────────────
//   LENGTH is free. A tine is measured as far as its three-wide row stays open water, then gives back one row, so
//     the row past its tip is open water: the tip is never closed by a far bank.
//   GROWTH SPACING: inside a tine a crop neighbours only along its own column, and its two columns are two apart. No
//     cell of one tine touches a cell of another, even diagonally, so the tightest packing is water, plot, walkway,
//     plot, water. verifyNoPenalty re-derives it off the finished field.
//   HYDRATION: every plot is placed into open water with open water beside it; dryPlotCount re-derives it.
//   REACH: A0 passes the column rule with a land approach, then the fleet's own route search (pathfinding_utils.
//     computeAStar, walking only — no digging, no placing) must find a route to it from `start`. A tine whose A0
//     has no route is skipped and counted.
//
// ── WHICH TINES MAKE THE FIELD ──────────────────────────────────────────────────────────────────────────
// Longest first (nearest A0 on a tie), each taken only if it touches no tine already taken and its A0 has a route,
// until `target` plots; the last tine is cut to the rows still needed. `capacity` is every tine the view holds,
// packed the same way uncut, WITHOUT the route check (a route search per tine in view floods the reachable area
// for every prime that has none, which a live crew cannot afford).

'use strict';

const Vec3 = require('vec3');
const { makeVoxelScan } = require('@utils/voxel_scan_throttle');
const { plotColumn, usableColumn, hasLandApproach, verifyNoPenalty, DEFAULT_SEA_Y } = require('@utils/wheat_plot_scanner');
const { computeAStar } = require('@utils/pathfinding_utils');
const { FARM_PLOT_COUNT } = require('@thinking/architect_config');

const HYDRATION_RADIUS = 4;
const AIRY = new Set(['air', 'cave_air', 'void_air']);
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEAR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// readWaterGrid — the loaded area as OPEN SEA-LEVEL WATER: a source at seaY with its two cells above clear (a crop's
// growing cell and the air over it; a walkway's body). Grid over the loaded chunks' bounding box — outside them counts
// as not water. Also labels water bodies (4-connected) and memoises the land test for an anchor prime.
async function readWaterGrid(bot0, scan, seaY) {
  const cols = bot0.world.getColumns().map(c => ({ cx: Number(c.chunkX), cz: Number(c.chunkZ) }));
  const minCx = Math.min(...cols.map(c => c.cx)), maxCx = Math.max(...cols.map(c => c.cx));
  const minCz = Math.min(...cols.map(c => c.cz)), maxCz = Math.max(...cols.map(c => c.cz));
  const gx0 = minCx * 16, gz0 = minCz * 16, GW = (maxCx - minCx + 1) * 16, GH = (maxCz - minCz + 1) * 16;
  const open = new Uint8Array(GW * GH);
  const idx = (x, z) => (x - gx0) + (z - gz0) * GW;
  const inGrid = (x, z) => x >= gx0 && z >= gz0 && x < gx0 + GW && z < gz0 + GH;
  let openCells = 0;
  for (const { cx, cz } of cols) {
    for (let dx = 0; dx < 16; dx++) for (let dz = 0; dz < 16; dz++) {
      const x = cx * 16 + dx, z = cz * 16 + dz;
      if (scan.isWaterSource(x, seaY, z) && AIRY.has(scan.blockAt(x, seaY + 1, z)?.name) && AIRY.has(scan.blockAt(x, seaY + 2, z)?.name)) {
        open[idx(x, z)] = 1; openCells++;
      }
    }
    await scan.pace();
  }
  const isOpen = (x, z) => inGrid(x, z) && open[idx(x, z)] === 1;

  const body = new Int32Array(GW * GH).fill(-1);
  const bodySizes = [];
  for (let i = 0; i < open.length; i++) {
    if (!open[i] || body[i] >= 0) continue;
    const id = bodySizes.length, stack = [i];
    body[i] = id; let n = 0;
    while (stack.length) {
      const j = stack.pop(); n++;
      const x = j % GW, z = (j - x) / GW;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (nx < 0 || nz < 0 || nx >= GW || nz >= GH) continue;
        const k = nx + nz * GW;
        if (open[k] && body[k] < 0) { body[k] = id; stack.push(k); }
      }
    }
    bodySizes.push(n);
  }

  const landMemo = new Map();
  const landOk = (x, z) => {
    const k = `${x},${z}`;
    if (!landMemo.has(k)) landMemo.set(k, usableColumn(plotColumn(scan, x, seaY, z)) && hasLandApproach(scan, x, seaY, z, () => false));
    return landMemo.get(k);
  };
  return { cols, open, idx, isOpen, openCells, body, bodySizes, GW, gx0, gz0, landOk };
}

// dryPlotCount — re-derived, not asserted (Law 25): crops with no open water left in their 9×9 once `placed` cells are built.
function dryPlotCount(field, isOpen, placed) {
  return field.filter(({ crop }) => {
    for (let dx = -HYDRATION_RADIUS; dx <= HYDRATION_RADIUS; dx++) for (let dz = -HYDRATION_RADIUS; dz <= HYDRATION_RADIUS; dz++) {
      const x = crop.x + dx, z = crop.z + dz;
      if (isOpen(x, z) && !placed.has(`${x},${z}`)) return false;
    }
    return true;
  }).length;
}

// tineRows — rows 0..rows-1 of a tine: { anchor: the walkway A(k+1), plots:[a,b] }.
function tineRows(t, rows) {
  const out = [];
  for (let k = 0; k < rows; k++) {
    const wx = t.x + t.dx * k, wz = t.z + t.dz * k;
    out.push({ anchor: { x: wx, z: wz }, plots: [{ x: wx + t.dz, z: wz + t.dx }, { x: wx - t.dz, z: wz - t.dx }] });
  }
  return out;
}

// scanWheatTrident(bot, { origin, start, target, seaY }) → the chosen tines as anchors and build steps.
//   origin — where "nearest" is measured from; start — the FLOOR cell the route search starts on (default: origin's
//   feet − 1). Both are the person spot on a snapshot, the body on a live crew.
async function scanWheatTrident(bot0, { origin, start, target = FARM_PLOT_COUNT, seaY = DEFAULT_SEA_Y, combatGate = true } = {}) {
  if (typeof bot0?.world?.getColumns !== 'function') {
    throw new Error('[wheat_trident_scanner] CODING VIOLATION (Law 13): the scan reads the whole loaded area and this bot exposes no world.getColumns().');
  }
  if (target % 2 !== 0) throw new Error(`[wheat_trident_scanner] CODING VIOLATION: a tine row holds 2 plots, so a field of ${target} cannot be cut from rows.`);
  const t0 = Date.now();
  const scan = makeVoxelScan(bot0, { needs: ['type', 'water'], source: 'wheat_trident_scan', combatGate });
  const { cols, open, GW, gx0, gz0, isOpen, openCells, body, bodySizes, idx, landOk } = await readWaterGrid(bot0, scan, seaY);
  const from = start || { x: Math.floor(origin.x), y: Math.floor(origin.y) - 1, z: Math.floor(origin.z) };

  // ── Every tine start in view: an open cell, a direction, land behind, open water either side. ──
  const candidates = [];
  let ticks = 0;
  for (let gi = 0; gi < open.length; gi++) {
    if (!open[gi]) continue;
    const x = gx0 + (gi % GW), z = gz0 + Math.floor(gi / GW);
    for (const [dx, dz] of DIRS) {
      if ((++ticks & 1023) === 0) await scan.pace();
      if (isOpen(x - dx, z - dz) || !isOpen(x + dz, z + dx) || !isOpen(x - dz, z - dx)) continue;
      if (!landOk(x - dx, z - dz)) continue;
      let length = 0;
      for (;;) {
        const wx = x + dx * length, wz = z + dz * length;
        if (!isOpen(wx, wz) || !isOpen(wx + dz, wz + dx) || !isOpen(wx - dz, wz - dx)) break;
        length++;
      }
      length--;                                         // the row past the tip stays open water
      if (length < 1) continue;
      candidates.push({ x, z, dx, dz, length, prime: { x: x - dx, z: z - dz }, dist: Math.hypot(x - dx - origin.x, z - dz - origin.z) });
    }
  }

  // routeTo — the fleet's own route search, walking only, to anchor prime's floor. Memoised per cell.
  const routeMemo = new Map();
  const routeTo = async (p) => {
    const k = `${p.x},${p.z}`;
    if (!routeMemo.has(k)) {
      const r = await computeAStar(bot0, from, { type: 'position', pos: new Vec3(p.x, seaY, p.z) },
        { allowDig: false, allowPlace: false, combatGate, owner: 'wheat_trident_scan' });
      routeMemo.set(k, !r ? { ok: false, why: 'no first step' } : !r.partial ? { ok: true, cost: r.cost }
        : { ok: false, why: r.complete ? 'no route' : 'search cut short' });
    }
    return routeMemo.get(k);
  };

  // Longest first, but only up to what the field can use: a tine that already holds every row still needed is as
  // long as any longer one, so the nearest of those wins. Uncut capacity ranks on the whole length.
  const byLength = (need) => {
    const cap = Number.isFinite(need) ? need / 2 : Infinity;
    return candidates.slice().sort((a, b) => Math.min(b.length, cap) - Math.min(a.length, cap) || a.dist - b.dist);
  };
  const touches = (claimed, cells, own) => cells.some(c => claimed.has(`${c.x},${c.z}`) ||
    NEAR8.some(([ox, oz]) => { const k = `${c.x + ox},${c.z + oz}`; return !own.has(k) && claimed.has(k); }));
  const cellsOf = (t, rows) => tineRows(t, rows).flatMap(r => [r.anchor, ...r.plots]);

  // pack — longest first, no contact; `checkRoute` skips tines whose anchor prime has no route.
  const pack = async (need, checkRoute) => {
    const claimed = new Set(), chosen = [], noRoute = [];
    let plots = 0;
    for (const t of byLength(need)) {
      if (plots >= need) break;
      const rows = Math.min(t.length, Math.ceil((need - plots) / 2));
      const cells = cellsOf(t, rows);
      const own = new Set(cells.map(c => `${c.x},${c.z}`));
      if (touches(claimed, cells, own)) continue;
      if (checkRoute) {
        const route = await routeTo(t.prime);
        if (!route.ok) { noRoute.push({ prime: t.prime, length: t.length, why: route.why }); continue; }
        t.routeCost = route.cost;
      }
      for (const k of own) claimed.add(k);
      chosen.push({ ...t, rows });
      plots += rows * 2;
    }
    return { chosen, plots, claimed, noRoute };
  };

  const capacity = await pack(Infinity, false);
  const picked = await pack(target, true);

  const base = {
    columnsSwept: cols.length, openWaterCells: openCells, bodiesFound: bodySizes.length,
    candidates: candidates.length, longestTine: candidates.reduce((m, c) => Math.max(m, c.length), 0),
    capacityPlots: capacity.plots, capacityTines: capacity.chosen.length,
    skippedNoRoute: picked.noRoute, start: from,
  };

  const field = [], tines = [];
  for (const t of picked.chosen) {
    const rows = tineRows(t, t.rows);
    const anchors = [{ x: t.prime.x, y: seaY, z: t.prime.z }, ...rows.map(r => ({ x: r.anchor.x, y: seaY, z: r.anchor.z }))];
    const steps = rows.map((r, k) => ({
      row: k, stand: anchors[k],
      place: [anchors[k + 1], ...r.plots.map(p => ({ x: p.x, y: seaY, z: p.z }))],   // anchor first: the plots attach to it
    }));
    for (const s of steps) for (const p of s.place.slice(1)) {
      field.push({ crop: { ...p, key: `${p.x},${p.y},${p.z}` }, stand: { ...s.stand, key: `${s.stand.x},${s.stand.y},${s.stand.z}` }, row: s.row });
    }
    tines.push({ prime: anchors[0], dir: { dx: t.dx, dz: t.dz }, rows: t.rows, fullLength: t.length, anchors, steps,
      routeCost: t.routeCost, bodySize: bodySizes[body[idx(t.x, t.z)]] });
  }
  if (field.length < target) return { ...base, found: false, field, tines, elapsedMs: Date.now() - t0 };
  let spread = 0;
  for (let i = 0; i < tines.length; i++) for (let j = i + 1; j < tines.length; j++) {
    spread = Math.max(spread, Math.hypot(tines[i].prime.x - tines[j].prime.x, tines[i].prime.z - tines[j].prime.z));
  }
  return {
    ...base, found: true, field, tines,
    pieces: tines.length, spread: Math.round(spread),
    distFromOrigin: Math.min(...tines.map(t => Math.hypot(t.prime.x - origin.x, t.prime.z - origin.z))),
    blocksPlaced: tines.reduce((n, t) => n + 3 * t.rows, 0), dirtBlocks: field.length,
    anchorBlocks: tines.reduce((n, t) => n + t.rows, 0), blocksDug: 0,
    penaltyFree: verifyNoPenalty(field.map(p => p.crop)), dryPlots: dryPlotCount(field, isOpen, picked.claimed),
    elapsedMs: Date.now() - t0,
  };
}

function describeTrident(s) {
  const head = 'wheat trident: ';
  const why = `${s.candidates} tine starts over ${s.columnsSwept} chunks (${s.openWaterCells} open water cells in ${s.bodiesFound} bodies), ` +
    `longest ${s.longestTine}; the view packs ${s.capacityPlots} plots in ${s.capacityTines} tines uncut.`;
  const route = `${s.skippedNoRoute.length} tine(s) skipped for no route to anchor prime`;
  if (!s.found) return `${head}SHORT — ${s.field.length} plots from ${s.tines.length} tines.\n      ↳ ${why}\n      ↳ ${route}`;
  return [
    `${head}FOUND ${s.field.length} plots in ${s.pieces} tine(s) ${s.tines.map(t => `${t.rows}${t.rows < t.fullLength ? `/${t.fullLength}` : ''}`).join('+')} rows, ` +
      `nearest anchor prime ${s.distFromOrigin.toFixed(0)}b from the person, route cost ${s.tines.map(t => t.routeCost.toFixed(0)).join('+')} (scan ${(s.elapsedMs / 1000).toFixed(1)}s).`,
    `      ↳ ${why}`,
    `      ↳ ${route}.`,
    `      ↳ ${s.penaltyFree ? 'penalty-free' : '⚠ PENALTY'}, ${s.dryPlots} dry; ${s.blocksPlaced} blocks placed (${s.dirtBlocks} plots, ${s.anchorBlocks} anchors), ${s.blocksDug} dug.`,
  ].join('\n');
}

module.exports = { scanWheatTrident, describeTrident, readWaterGrid, dryPlotCount };
