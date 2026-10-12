// foreman/item_book.js
// THE FLEET'S ONE ITEM BOOK. Every body's clerk (js_kernel/item_book.js) sends its moves here and this
// process is the only holder of the totals: how many of each item sit in each place, how many moved
// for each cause, where every pickup came from, and what became of every thrown stack.
//
// ── A MOVE HAS TWO SIDES ─────────────────────────────────────────────────────────────────────────────
//   Each move takes `n` of one item out of one place and puts it in another, so the book always sums
//   to zero. The places:
//     pocket:<bot>        a body's pocket (audited against the body's own reading every 30 s)
//     container:<id>      a chest or barrel (audited against the window's contents at every transfer)
//     furnace:<id>        what was loaded into a furnace, less what was taken out
//     world               the world the fleet did not make; its negative balance is what was taken
//     placed              blocks the fleet has standing in the world
//     loose               fleet-placed blocks dug back out, on the ground until picked up
//     pit / ground        thrown stacks, by where they came to rest
//     death:<bot>         a dead body's pocket, on the ground where it died
//     crafting · eaten · planted · composter · worn_out · start · unattributed
//
// ── WHERE A PICKUP CAME FROM IS DECIDED HERE, ONCE ───────────────────────────────────────────────────
//   A drop's entity id is the server's and is the same number on every client, so a stack one body
//   threw is recognised when any body collects it. In order: a thrown stack by id · a fleet-placed
//   block by the cell the drop first appeared in · a dead body's pile by distance · else the world.

'use strict';

const fs = require('fs');
const path = require('path');
const { guardExternal, withCleanup } = require('../js_kernel/utils/external_library_guard');
const { durableWrite } = require('../js_kernel/durable_write');
const BOOK_FILE = path.join(require('../js_kernel/utils/record_homes').RECORDS_DIR, 'item_book.json');

const WRITE_MS = 15000;
const DEATH_PILE_RADIUS = 4;
const LISTED_MISMATCHES = 200;

const holdings = new Map();      // place → Map(item → n)
const flows = {};                // cause → item → n
const pickups = { world: {}, thrown: {}, unplaced: {}, death: {} };
const gatheredByBot = {};        // bot → item → n, pickups from the world only
const placedCells = new Map();   // 'x,y,z' → item
const unplaced = new Map();      // 'x,y,z' → item, a fleet-placed block dug out and not yet collected
const throws = new Map();        // entity id → the throw's row
const throwRows = [];
const deaths = [];
const audit = { pocket_checks: 0, pocket_mismatches: [], container_checks: 0, container_mismatches: [] };
const counts = { entries: 0, moves: 0, pickups: 0, digs: 0 };
const bots = new Set();           // every body the book has heard from
let _dirty = false;
let _startedAt = Date.now();

const key = c => `${c[0]},${c[1]},${c[2]}`;
const bump = (o, k, n) => { o[k] = (o[k] || 0) + n; };

function _place(name) {
  let m = holdings.get(name);
  if (!m) { m = new Map(); holdings.set(name, m); }
  return m;
}
function _move(item, n, from, to, cause) {
  if (!n) return;
  const f = _place(from), t = _place(to);
  f.set(item, (f.get(item) || 0) - n);
  t.set(item, (t.get(item) || 0) + n);
  flows[cause] = flows[cause] || {};
  bump(flows[cause], item, n);
  counts.moves++;
}
const _where = (side, bot) => side === 'pocket' ? `pocket:${bot}` : side;

// The book's figure for a place is set to what was seen there; the difference is a move against
// 'unattributed', so a correction is itself a line in the book.
function _reconcile(place, seen, list, row) {
  const held = _place(place);
  const diff = {};
  for (const item of new Set([...held.keys(), ...Object.keys(seen)])) {
    const d = (seen[item] || 0) - (held.get(item) || 0);
    if (d) diff[item] = d;
  }
  if (!Object.keys(diff).length) return;
  if (list.length < LISTED_MISMATCHES) list.push({ ...row, place, off_by: diff, at_sec: Math.round((Date.now() - _startedAt) / 1000) });
  for (const [item, d] of Object.entries(diff)) {
    if (d > 0) _move(item, d, 'unattributed', place, 'book_correction');
    else _move(item, -d, place, 'unattributed', 'book_correction');
  }
}

function _pickup(bot, e) {
  counts.pickups++;
  let left = e.n;
  const pocket = `pocket:${bot}`;
  const row = throws.get(e.e);
  if (row) {
    _move(e.i, left, row.landed_in_pit ? 'pit' : 'ground', pocket, 'pickup_thrown');
    bump(pickups.thrown, e.i, left);
    row.picked_up_by.push({ bot, n: left });
    return;
  }
  if (e.s) {
    for (let dx = -1; dx <= 1 && left > 0; dx++) for (let dy = -1; dy <= 1 && left > 0; dy++) for (let dz = -1; dz <= 1 && left > 0; dz++) {
      const k = key([e.s[0] + dx, e.s[1] + dy, e.s[2] + dz]);
      if (unplaced.get(k) !== e.i) continue;
      unplaced.delete(k);
      _move(e.i, 1, 'loose', pocket, 'pickup_unplaced');
      bump(pickups.unplaced, e.i, 1);
      left--;
    }
  }
  if (left > 0 && e.a) {
    for (const d of deaths) {
      if (!d.at || !(d.left[e.i] > 0)) continue;
      if (Math.max(Math.abs(d.at[0] - e.a[0]), Math.abs(d.at[1] - e.a[1]), Math.abs(d.at[2] - e.a[2])) > DEATH_PILE_RADIUS) continue;
      const take = Math.min(left, d.left[e.i]);
      d.left[e.i] -= take;
      _move(e.i, take, `death:${d.bot}`, pocket, 'pickup_death');
      bump(pickups.death, e.i, take);
      left -= take;
      if (!left) break;
    }
  }
  if (left > 0) {
    _move(e.i, left, 'world', pocket, 'pickup_world');
    bump(pickups.world, e.i, left);
    gatheredByBot[bot] = gatheredByBot[bot] || {};
    bump(gatheredByBot[bot], e.i, left);
  }
}

// record(bot, entries) — one batch from one body's clerk, in the order the body wrote it.
function record(bot, entries) {
  if (!Array.isArray(entries)) return;
  _dirty = true;
  bots.add(bot);
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    counts.entries++;
    switch (e.k) {
      case 'm': {
        _move(e.i, e.n, _where(e.f, bot), _where(e.t, bot), e.c);
        if (e.c === 'place' && e.t === 'placed' && e.cell) placedCells.set(key(e.cell), e.i);
        break;
      }
      case 'p': _pickup(bot, e); break;
      case 'd': {
        counts.digs++;
        const k = key(e.c);
        const item = placedCells.get(k);
        if (!item) break;
        placedCells.delete(k);
        unplaced.set(k, item);
        _move(item, 1, 'placed', 'loose', 'dug_back_out');
        break;
      }
      case 'th': {
        const row = { thrown_by: bot, entity: e.e, item: e.i, count: e.n, came_to_rest: e.rest || null, landed_in_pit: !!e.in_pit,
          last_seen: e.end, at_sec: Math.round((Date.now() - _startedAt) / 1000), picked_up_by: [] };
        throwRows.push(row);
        if (e.e != null) throws.set(e.e, row);
        if (!e.in_pit) _move(e.i, e.n, 'pit', 'ground', 'throw_missed_pit');
        break;
      }
      case 'al': {
        const row = throws.get(e.from);
        if (row && !throws.has(e.to)) throws.set(e.to, row);
        break;
      }
      case 'de': {
        const items = e.items || {};
        for (const [i, n] of Object.entries(items)) _move(i, n, `pocket:${bot}`, `death:${bot}`, 'death');
        deaths.push({ bot, at: e.at || null, items, left: { ...items }, at_sec: Math.round((Date.now() - _startedAt) / 1000) });
        break;
      }
      case 'au': {
        audit.pocket_checks++;
        _reconcile(`pocket:${bot}`, e.items || {}, audit.pocket_mismatches, { bot });
        break;
      }
      case 'ca': {
        audit.container_checks++;
        _reconcile(`container:${e.id}`, e.items || {}, audit.container_mismatches, { bot });
        break;
      }
      default: break;
    }
  }
}

function snapshot() {
  const places = {};
  for (const [name, m] of holdings) {
    const o = {};
    for (const [item, n] of m) if (n) o[item] = n;
    if (Object.keys(o).length) places[name] = o;
  }
  return {
    schema: 'auren.item_book.v1',
    written_at: new Date().toISOString(),
    run_sec: Math.round((Date.now() - _startedAt) / 1000),
    counts,
    bots: [...bots].sort(),
    holdings: places,
    flows,
    pickups,
    gathered_by_bot: gatheredByBot,
    throws: throwRows,
    deaths: deaths.map(d => ({ bot: d.bot, at: d.at, at_sec: d.at_sec, items: d.items, not_picked_up: d.left })),
    audit,
    placed_cells_standing: placedCells.size,
    unplaced_not_collected: unplaced.size,
  };
}

// write() — the book as one file under fleet_logs/, for the lens that reads a finished run.
let _writing = null;
function _write() {
  if (_writing) return _writing;
  if (!_dirty) return true;
  // New ledger entries remain dirty until a later snapshot includes them; the write queue stays bounded.
  _writing = withCleanup('item_book', 'write the item book', async () => {
    while (_dirty) {
      _dirty = false;
      const text = JSON.stringify(snapshot());
      const wrote = await guardExternal('item_book', 'replace item_book.json', async () => {
        await fs.promises.mkdir(path.dirname(BOOK_FILE), { recursive: true });
        await durableWrite(BOOK_FILE, text);
      });
      if (!wrote.ok) { _dirty = true; return false; }
    }
    return true;
  }, () => { _writing = null; });
  return _writing;
}

// An explicit flush includes entries that arrived during the previous writer's final continuation.
async function write() {
  do {
    if (await _write() === false) return false;
  } while (_dirty);
  return true;
}

function start() {
  _startedAt = Date.now();
  const t = require('../js_kernel/utils/timeout_crash').every('item_book', 'write the item book to disk', write, WRITE_MS);
  t.unref();
}

module.exports = { record, snapshot, write, start, BOOK_FILE };
