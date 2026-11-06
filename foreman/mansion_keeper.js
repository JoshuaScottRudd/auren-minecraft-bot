// foreman/mansion_keeper.js — THE KEEPER'S WATCH OVER THE DOWNLOADED BUILDING: EVERY CUBE AND STAND SHAFT, OFF THE
// KEEPER'S OWN WORLD.
//
// A body judging the building from far off reads its cells as unloaded (assessors/downloaded_build cellState
// 'unseen'): a cube it has not seen finished reads open, and every far body offers it, prices it and counts it wrong.
// The building is home ground, so it is the keeper's to keep (integrity_keeper.js, SCOPE): this watch runs in the
// keeper's thread (integrity_keeper_worker), over the world that thread holds, and posts whether each cube and each
// stand shaft holds what the plan asks. A body asks it for any cell it has not loaded (downloaded_build.keptCube). It
// keeps the basement the same way: each column's cell (downloaded_plan_registry.basementCell) has its room open and its
// walls, floor and roof solid. The roof over a stand is the climb's to cut until the column stands: its last descent
// closes it (build_column_executor). A shaft alone cannot say so, since a shaft the plan keeps as air stands before the first climb.
//
// ── WHAT IT READS ─────────────────────────────────────────────────────────────────────────────────────
// The plan this crew builds (architect_config.CREW_BUILD), loaded in this thread (downloaded_plan_registry is one per
// thread), placed by the building's locked row (siteFrame), its cells listed by the plan's own cubeTargets and
// shaftTargets. A cell is correct by frame.holds, or air where the plan has nothing: the assessor's own test.
//
// ── THE VERDICT ───────────────────────────────────────────────────────────────────────────────────────
// Subject `mansion`: { generated_at, plan, cubes: { [anchor index]: 'ok'|'open'|'unheld' }, shafts: { [column]: … },
// cells: { [column]: … }, ok, open, unheld } — 'unheld' where any of its cells lies in a chunk this thread does not hold. A crew that builds no
// downloaded building gets the verdict with plan null.

'use strict';

const Vec3 = require('vec3');

const OPEN = new Set(['air', 'cave_air', 'void_air']);

// createMansionWatch({ mode, standIn, held, colKey, say }) → { onPlans(buildings) → [colKey], read() → verdict body }.
function createMansionWatch({ mode, standIn, held, colKey, say }) {
  const name = require('@thinking/architect_config').CREW_BUILD[mode] || null;
  const planRegistry = require('@kernel/downloaded_plan_registry');
  const { roomKeyName, isBuildingTombstone } = require('@foreman/message_schema');
  let frame = null, cubes = null, shafts = null, cells = null, siteKey = null;

  // The plan's cells placed in the world, once per siting: [{ key, cells: [{ p, v, col }] }].
  function place(targets) {
    return targets.map(t => {
      const p = frame.worldOf(t.b[0], t.b[1], t.b[2]);
      return { p: new Vec3(p.x, p.y, p.z), v: t.v, support: !!t.support, col: colKey(p.x >> 4, p.z >> 4) };
    });
  }

  function onPlans(buildings) {
    if (!name) return [];
    let site = null;
    for (const [roomKey, entry] of Object.entries(buildings || {})) {
      if (roomKeyName(roomKey) !== name || !entry || isBuildingTombstone(entry)) continue;
      if (entry.set_buildspot && entry.set_buildspot.footprint) site = entry.set_buildspot;
    }
    if (!site) { frame = null; return []; }
    const key = JSON.stringify(site.footprint);
    if (key !== siteKey) {
      planRegistry.load(name);
      frame = planRegistry.siteFrame(site);
      cubes = planRegistry.anchors().map(a => ({ key: a.index, cells: place(planRegistry.cubeTargets(a)) }));
      shafts = planRegistry.columns().map(c => ({ key: c.column, cells: place(planRegistry.shaftTargets(c)) }));
      cells = planRegistry.columns().map(c => {
        const cell = planRegistry.basementCell(c);
        const roof = new Set(cell.roof.map(b => b.join()));
        return {
          key: c.column,
          anchors: c.anchors,
          open: place(cell.open.map(b => ({ b }))),
          fill: place(cell.fill.filter(b => !roof.has(b.join())).map(b => ({ b }))),
          roof: place(cell.roof.map(b => ({ b }))),
        };
      });
      siteKey = key;
      say(`mansion: ${name} kept, ${cubes.length} cube(s), ${shafts.length} stand shaft(s) and ${cells.length} basement cell(s)`);
    }
    const cols = new Set();
    for (const group of [cubes, shafts]) for (const g of group) for (const c of g.cells) cols.add(c.col);
    for (const g of cells) for (const c of [...g.open, ...g.fill, ...g.roof]) cols.add(c.col);
    return [...cols];
  }

  // One group's state: 'unheld' when any cell is in a chunk not held, else 'ok' when every cell holds the plan.
  function stateOf(cells) {
    let ok = true;
    for (const c of cells) {
      if (!held.has(c.col)) return 'unheld';
      if (!ok) continue;
      const at = standIn.blockAt(c.p);
      if (!at || !at.name) return 'unheld';
      ok = c.v ? frame.holds(c.v, at) : (c.support ? !OPEN.has(at.name) : OPEN.has(at.name));
    }
    return ok ? 'ok' : 'open';
  }

  // One basement cell's state. A solid is anything that is not open and not a fluid; the torch a room holds is open.
  const SOFT = new Set([...OPEN, 'water', 'lava', 'torch', 'wall_torch']);
  function cellStateOf(g, columnStands) {
    const fill = columnStands ? [...g.fill, ...g.roof] : g.fill;
    let ok = true;
    for (const [list, wantOpen] of [[g.open, true], [fill, false]]) {
      for (const c of list) {
        if (!held.has(c.col)) return 'unheld';
        const at = standIn.blockAt(c.p);
        if (!at || !at.name) return 'unheld';
        if (wantOpen ? !(OPEN.has(at.name) || at.name === 'torch' || at.name === 'wall_torch') : SOFT.has(at.name)) ok = false;
      }
    }
    return ok ? 'ok' : 'open';
  }

  function read() {
    if (!frame) return { plan: null, cubes: {}, shafts: {}, cells: {}, ok: 0, open: 0, unheld: 0 };
    const out = { plan: name, cubes: {}, shafts: {}, cells: {}, ok: 0, open: 0, unheld: 0 };
    for (const g of cubes) { const s = stateOf(g.cells); out.cubes[g.key] = s; out[s]++; }
    for (const g of shafts) out.shafts[g.key] = stateOf(g.cells);
    for (const g of cells) out.cells[g.key] = cellStateOf(g, out.shafts[g.key] === 'ok' && g.anchors.every(i => out.cubes[i] === 'ok'));
    return out;
  }

  return { onPlans, read };
}

module.exports = { createMansionWatch };
