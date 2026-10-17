// Auren_Bot/monitoring/throughput_lens.js
// --throughput: every material as a flow — how fast it came out of the world, how fast it was put into
// and taken out of the chests, what the build's cube trips drew, how much stands in the chests, and how long that standing stock
// lasts at the rate it was drawn. Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Two sources, each read through its owner (Law 16):
//   the item book (item_book_lens.readBook)   whole-run totals per item and per cause, and where every
//                                             item ended.
//   the chest line (inventory_lens.TX_RE)     one line per chest window with the chest's contents after
//                                             it, on the fleet clock, so chest stock and chest flow are
//                                             read per stretch of the run.
// The build's open order comes from the job board's `order:` line, in the bill's own tokens: a token
// may be a group (`stone`) where the chest rows name the item (`cobblestone`), so the order has its own
// table and is never joined to an item row.
//
// Placed blocks are not counted: a placed block is a crafted thing (a door is several logs), so material
// is compared where it is still material — gathered, put in, taken out. What the build drew is the
// bill column_preparation prices per cube trip, already in the tokens it withdraws (`CUBE_BILL`).
//
// Every per-minute figure is over the fleet clock (`wallSec`), never a bot's own age.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --throughput [--bucket=10] [--all]

'use strict';

const out = require('./data_out');
const { TX_RE, parseStacks } = require('./inventory_lens');
const { readBook, gatheredOf } = require('./item_book_lens');

const ORDER_RE = /"([^"]+)" window of (\d+) column\(s\), layers \d+\.\.\d+, (\d+) cube\(s\) paid — order: (.+)$/;
// Rows the by-time table keeps without --all: the items drawn from the chests most.
const TIME_ROWS_ITEMS = 8;
const BILL_RE = /CUBE_BILL column=\d+ cube=\d+ bill=(\{.*\})/;

const _sumPlaces = (holdings, kind) => {
  const sum = {};
  for (const [place, items] of Object.entries(holdings || {})) {
    if (place.split(':')[0] !== kind) continue;
    for (const [item, n] of Object.entries(items)) sum[item] = (sum[item] || 0) + n;
  }
  return sum;
};

// reduceThroughput → { runMin, bucketMin, materials, buckets, orderTokens, cubeTrips, cubeDraw }
//   materials  one row per item the book moved: whole-run totals and where it stands.
//   buckets    one per `bucketMin` of fleet clock: chest flow in and out per item, chest stock at the
//              stretch's end, and the last open order posted inside it.
function reduceThroughput({ seg = [], book = null, bucketMin = 10 } = {}) {
  const bucketSec = bucketMin * 60;
  const events = [];
  const cubeDraw = {};
  let cubeTrips = 0;
  let spanSec = 0;
  for (const l of seg) {
    if (l.wallSec == null) continue;
    spanSec = Math.max(spanSec, l.wallSec);
    let m;
    if ((m = l.raw.match(TX_RE))) events.push({ at: l.wallSec, chest: m[8], stacks: parseStacks(m[10]) });
    else if ((m = l.raw.match(BILL_RE))) {
      cubeTrips++;
      for (const [token, n] of Object.entries(JSON.parse(m[1]))) {
        const row = cubeDraw[token] || (cubeDraw[token] = { token, trips: 0, drawn: 0 });
        row.trips++; row.drawn += n;
      }
    } else if ((m = l.raw.match(ORDER_RE))) {
      const order = {};
      for (const part of m[4].split(',')) {
        const [token, n] = part.trim().split(':');
        if (token && n !== undefined) order[token] = +n;
      }
      events.push({ at: l.wallSec, structure: m[1], columns: +m[2], cubes: +m[3], order });
    }
  }
  events.sort((a, b) => a.at - b.at);

  const buckets = [];
  for (let i = 0; i <= Math.floor(spanSec / bucketSec); i++) buckets.push({ fromMin: i * bucketMin, flowIn: {}, flowOut: {}, stock: {}, order: null });
  const chests = new Map();
  const stockNow = () => {
    const s = {};
    for (const totals of chests.values()) for (const [item, n] of Object.entries(totals)) s[item] = (s[item] || 0) + n;
    return s;
  };
  let open = 0;
  const orderTokens = new Set();
  for (const e of events) {
    const i = Math.floor(e.at / bucketSec);
    for (; open < i; open++) buckets[open].stock = stockNow();
    if (e.order) {
      buckets[i].order = e;
      for (const token of Object.keys(e.order)) orderTokens.add(token);
      continue;
    }
    // Flow is the difference between a chest's consecutive pictures, so a draw named by its group
    // counts under the item that left.
    const before = chests.get(e.chest) || {};
    const now = {};
    for (const s of e.stacks) now[s.name] = (now[s.name] || 0) + s.count;
    for (const item of new Set([...Object.keys(now), ...Object.keys(before)])) {
      const delta = (now[item] || 0) - (before[item] || 0);
      if (delta > 0) buckets[i].flowIn[item] = (buckets[i].flowIn[item] || 0) + delta;
      else if (delta < 0) buckets[i].flowOut[item] = (buckets[i].flowOut[item] || 0) - delta;
    }
    chests.set(e.chest, now);
  }
  for (; open < buckets.length; open++) buckets[open].stock = stockNow();

  const runMin = book && book.run_sec ? book.run_sec / 60 : spanSec / 60;
  const materials = [];
  if (book) {
    const gathered = gatheredOf(book).sum;
    const flows = book.flows || {};
    const crafting = (book.holdings || {}).crafting || {};
    const inChests = _sumPlaces(book.holdings, 'container');
    const inPockets = _sumPlaces(book.holdings, 'pocket');
    const inFurnaces = _sumPlaces(book.holdings, 'furnace');
    const items = new Set([gathered, flows.deposit, flows.retrieve, flows.furnace_load, inChests]
      .flatMap(o => Object.keys(o || {})));
    for (const item of items) {
      const of = o => (o && o[item]) || 0;
      materials.push({
        item,
        gathered: of(gathered),
        madeByCrafting: Math.max(0, -of(crafting)),
        usedByCrafting: Math.max(0, of(crafting)),
        furnaceLoaded: of(flows.furnace_load),
        chestIn: of(flows.deposit),
        chestOut: of(flows.retrieve),
        inChests: of(inChests),
        inPockets: of(inPockets),
        furnaceNetIn: Math.max(0, of(inFurnaces)),
        furnaceNetOut: Math.max(0, -of(inFurnaces)),
      });
    }
  }
  return { runMin, bucketMin, materials, buckets, orderTokens: [...orderTokens], cubeTrips, cubeDraw: Object.values(cubeDraw) };
}

function runThroughput({ seg = [], traceName = '?', bucketMin = 10, verbose = false } = {}) {
  const book = readBook();
  const t = reduceThroughput({ seg, book, bucketMin });
  const rate = n => (t.runMin > 0 ? +(n / t.runMin).toFixed(2) : null);

  out.kv('lens', 'throughput');
  out.kv('record', traceName);
  out.section('throughput');
  out.kv('run_min', +t.runMin.toFixed(1));
  out.kv('bucket_min', t.bucketMin);
  out.kv('item_book', !!book);
  out.kv('materials', t.materials.length);

  // Whole-run flow per item. `made_by_crafting_net` and `used_by_crafting_net` are the item's net across
  // the crafting grid: an item both made and used shows only the difference. `furnace_net_in` is what went
  // into furnaces and did not come back out as itself; `furnace_net_out` is what furnaces gave that was
  // never loaded.
  out.section('material_flow');
  if (!t.materials.length) out.zero('materials');
  else out.table(['item', 'gathered', 'gathered_per_min', 'chest_in', 'chest_in_per_min', 'chest_out', 'chest_out_per_min', 'used_by_crafting_net', 'made_by_crafting_net', 'furnace_net_in', 'furnace_net_out', 'in_chests', 'in_pockets'],
    t.materials.slice().sort((a, b) => (b.gathered + b.chestOut) - (a.gathered + a.chestOut))
      .map(m => [m.item, m.gathered, rate(m.gathered), m.chestIn, rate(m.chestIn), m.chestOut, rate(m.chestOut), m.usedByCrafting, m.madeByCrafting, m.furnaceNetIn, m.furnaceNetOut, m.inChests, m.inPockets]));

  // What the build's cube trips drew from the chests, in the tokens the bill is withdrawn under.
  out.section('cube_draw');
  out.kv('cube_trips_billed', t.cubeTrips);
  if (!t.cubeDraw.length) out.zero('bill_tokens');
  else out.table(['token', 'trips', 'drawn', 'drawn_per_min', 'drawn_per_trip'],
    t.cubeDraw.sort((a, b) => b.drawn - a.drawn).map(c => [c.token, c.trips, c.drawn, rate(c.drawn), +(c.drawn / c.trips).toFixed(1)]));

  // Chest stock against the rate it was drawn: `cover_min` is how long the stock standing at the run's
  // end lasts at the whole-run draw rate with nothing more coming in. Least cover first; an item never
  // drawn has no cover figure.
  out.section('chest_cover');
  const drawn = t.materials.filter(m => m.chestIn || m.chestOut || m.inChests);
  if (!drawn.length) out.zero('chest_items');
  else out.table(['item', 'in_chests', 'chest_in', 'chest_out', 'chest_in_per_min', 'chest_out_per_min', 'net_per_min', 'cover_min'],
    drawn.map(m => [m.item, m.inChests, m.chestIn, m.chestOut, rate(m.chestIn), rate(m.chestOut), rate(m.chestIn - m.chestOut),
      m.chestOut > 0 ? +(m.inChests / (m.chestOut / t.runMin)).toFixed(1) : null])
      .sort((a, b) => (a[7] === null) - (b[7] === null) || a[7] - b[7]));

  // The same chest flow per stretch of the run, from the chests' own pictures. `stock_at_end` is what
  // every chest held when the stretch closed; `cover_min` is that stock at this stretch's draw rate.
  const total = {};
  for (const b of t.buckets) for (const [item, n] of Object.entries(b.flowOut)) total[item] = (total[item] || 0) + n;
  const ranked = Object.keys(total).sort((a, b) => total[b] - total[a]);
  const shown = verbose ? ranked : ranked.slice(0, TIME_ROWS_ITEMS);
  out.section('chest_flow_by_time');
  out.kv('items_drawn', ranked.length);
  out.kv('items_shown', shown.length);
  const rows = [];
  for (const item of shown) for (const b of t.buckets) {
    const o = b.flowOut[item] || 0, stock = b.stock[item] || 0;
    rows.push([item, b.fromMin, b.flowIn[item] || 0, o, stock, o > 0 ? +(stock / (o / t.bucketMin)).toFixed(1) : null]);
  }
  if (!rows.length) out.zero('chest_draws');
  else out.table(['item', 'from_min', 'chest_in', 'chest_out', 'stock_at_end', 'cover_min'], rows);

  // What the build still asked for, in the bill's own tokens: the last order posted in each stretch.
  out.section('open_order_by_time');
  const ordered = t.buckets.filter(b => b.order);
  if (!ordered.length) out.zero('orders');
  else out.table(['from_min', 'structure', 'columns_in_window', 'cubes_paid', ...t.orderTokens.map(token => `order_${token}`)],
    ordered.map(b => [b.fromMin, b.order.structure, b.order.columns, b.order.cubes, ...t.orderTokens.map(token => b.order.order[token] ?? null)]));
}

module.exports = { reduceThroughput, runThroughput };
