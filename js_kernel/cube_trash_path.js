// cube_trash_path — the cheapest chain of cells that joins a cell needing a face to something already standing.
//
// ── A ROUTE FOR BLOCKS, AS NAVIGATION IS A ROUTE FOR FEET ───────────────────────────────────────────────
// A block goes in by clicking a face of a block already standing. A cell with nothing beside it gets a
// chain of blocks stood from the nearest standing face up to it. This module answers which cells that
// chain runs through, from the caller's field alone: it reads no world and places nothing (Law 0).
//
// ── THE FIELD IS THE WHOLE WORLD OF THE SEARCH ──────────────────────────────────────────────────────────
// The caller names every cell a block may be stood in. A chain runs through those cells only, so a caller
// that names the cells of one cube gets a chain that stays inside that cube (Law 27).
//
// ── CHEAPEST, NOT SHORTEST ──────────────────────────────────────────────────────────────────────────────
// Every cell carries the caller's price for standing a block in it, so a chain through cells that take the
// plan's own blocks beats a shorter one made of blocks that have to come back out. A field is one cube, at
// most 125 cells, so the frontier is a plain list read for its lowest entry.

'use strict';

const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const keyOf = (c) => `${c.x},${c.y},${c.z}`;

// trashPath({ starts, field, costOf, attachesNow }) → { cells, cost } or null when no chain exists.
//   starts       cells where the chain must end: a block stood in any one of them serves the caller.
//   field        Map(key → cell) of every cell a block may be stood in; every start is one of them.
//   costOf       cell → the price of standing a block there, zero or more.
//   attachesNow  cell → true when a block already standing gives that cell a face to click.
// `cells` runs in placing order: the cell that attaches now first, a start last, each beside the one before.
function trashPath({ starts, field, costOf, attachesNow }) {
  const best = new Map();                                // key → { cell, cost, from }
  const frontier = [];
  for (const cell of starts) {
    const key = keyOf(cell);
    if (!field.has(key)) {
      throw new Error(`[cube_trash_path] CODING VIOLATION (Law 13): start cell (${key}) is not a cell of the field it was searched in.`);
    }
    const node = { cell, cost: costOf(cell), from: null };
    best.set(key, node);
    frontier.push(node);
  }
  while (frontier.length) {
    let low = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].cost < frontier[low].cost) low = i;
    const node = frontier.splice(low, 1)[0];
    if (best.get(keyOf(node.cell)) !== node) continue;   // a cheaper way into this cell replaced this entry
    if (attachesNow(node.cell)) {
      const cells = [];
      for (let n = node; n; n = n.from) cells.push(n.cell);
      return { cells, cost: node.cost };
    }
    for (const [dx, dy, dz] of SIX) {
      const key = `${node.cell.x + dx},${node.cell.y + dy},${node.cell.z + dz}`;
      const cell = field.get(key);
      if (!cell) continue;
      const cost = node.cost + costOf(cell);
      const seen = best.get(key);
      if (seen && seen.cost <= cost) continue;
      const next = { cell, cost, from: node };
      best.set(key, next);
      frontier.push(next);
    }
  }
  return null;
}

module.exports = { trashPath, keyOf };
