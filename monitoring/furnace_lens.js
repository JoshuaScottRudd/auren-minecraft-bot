// Auren_Bot/monitoring/furnace_lens.js
// --furnace: every furnace's batches over a run. For each load: how long it cooked by the clock, how long the finished
// furnace waited for a body, and how long it then stood empty before the next load. Reads furnace_executor's own
// WINDOW lines. Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --furnace [--all]

'use strict';

const out = require('./data_out');

const LOAD_RE = /WINDOW furnace-load @ (\S+): (\d+)x (\S+) /;
const COLLECT_RE = /WINDOW furnace-collect @ (\S+): (\d+)x (\S+) /;
const TOPUP_RE = /WINDOW furnace-topup @ (\S+): (\d+)x (\S+) — (\d+) cooked, (\d+) cooking/;
const COOK_SEC = 10;
const SHOW_ROWS = 25;

const min = (sec) => (sec == null ? null : +(sec / 60).toFixed(1));

// One row per load: { furnace, order, qty, loaded, done, collected, taken, next }, in seconds on the record's wall clock.
function reduceFurnace({ seg = [] } = {}) {
  const batches = [];
  const open = new Map();
  const last = new Map();
  const firstLoad = new Map();
  const seen = new Set();
  for (const l of seg) {
    const raw = l.raw || '';
    let m;
    if ((m = LOAD_RE.exec(raw))) {
      const key = `${l.wallSec}|${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = last.get(m[1]);
      if (prev) prev.next = l.wallSec;
      const b = { furnace: m[1], order: m[3], qty: +m[2], loaded: l.wallSec, done: l.wallSec + +m[2] * COOK_SEC, collected: null, taken: 0, next: null };
      batches.push(b);
      open.set(m[1], b);
      last.set(m[1], b);
      if (!firstLoad.has(m[1])) firstLoad.set(m[1], l.wallSec);
    } else if ((m = TOPUP_RE.exec(raw))) {
      const key = `${l.wallSec}|${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = open.get(m[1]);
      if (!b) continue;
      b.qty += +m[2];
      b.topups = (b.topups || 0) + 1;
      b.done = l.wallSec + +m[5] * COOK_SEC;
    } else if ((m = COLLECT_RE.exec(raw))) {
      const key = `${l.wallSec}|${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = open.get(m[1]);
      if (!b) continue;
      b.taken += +m[2];
      if (b.collected === null) b.collected = l.wallSec;
    }
  }
  return { batches, firstLoad };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mean = (xs) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);

function stats(prefix, xs) {
  out.kv(`${prefix}_count`, xs.length);
  out.kv(`${prefix}_median_min`, min(median(xs)));
  out.kv(`${prefix}_mean_min`, min(mean(xs)));
  out.kv(`${prefix}_longest_min`, xs.length ? min(Math.max(...xs)) : null);
  out.kv(`${prefix}_total_min`, xs.length ? min(xs.reduce((n, x) => n + x, 0)) : null);
}

function runFurnace({ seg = [], traceName = '?', verbose = false } = {}) {
  const { batches, firstLoad } = reduceFurnace({ seg });
  const finished = batches.filter(b => b.collected !== null);
  const waited = finished.map(b => Math.max(0, b.collected - b.done));
  const refilled = finished.filter(b => b.next !== null).map(b => Math.max(0, b.next - b.collected));

  out.kv('lens', 'furnace');
  out.kv('record', traceName);

  out.section('batches');
  out.kv('furnaces', firstLoad.size);
  out.kv('loads', batches.length);
  out.kv('topups', batches.reduce((n, b) => n + (b.topups || 0), 0));
  out.kv('collected', finished.length);
  out.kv('never_collected', batches.length - finished.length);
  out.kv('items_loaded', batches.reduce((n, b) => n + b.qty, 0));
  out.kv('items_taken', batches.reduce((n, b) => n + b.taken, 0));

  out.section('done_until_emptied');
  stats('wait', waited);

  out.section('emptied_until_loaded_again');
  stats('cold', refilled);

  out.section('by_order');
  const orders = {};
  for (const b of batches) {
    const o = orders[b.order] || (orders[b.order] = { loads: 0, items: 0, cook: 0, wait: [], cold: [] });
    o.loads++;
    o.items += b.qty;
    o.cook += b.qty * COOK_SEC;
    if (b.collected !== null) o.wait.push(Math.max(0, b.collected - b.done));
    if (b.collected !== null && b.next !== null) o.cold.push(Math.max(0, b.next - b.collected));
  }
  out.table(['order', 'loads', 'items', 'mean_batch', 'cook_min', 'wait_median_min', 'wait_total_min', 'cold_median_min', 'cold_total_min'],
    Object.entries(orders).sort((a, b) => b[1].items - a[1].items).map(([order, o]) => [order, o.loads, o.items, +(o.items / o.loads).toFixed(1), min(o.cook),
      min(median(o.wait)), min(o.wait.reduce((n, x) => n + x, 0)), min(median(o.cold)), min(o.cold.reduce((n, x) => n + x, 0))]));

  out.section('by_furnace');
  const stations = {};
  for (const b of batches) {
    const s = stations[b.furnace] || (stations[b.furnace] = { loads: 0, cook: 0, wait: 0, cold: 0, first: b.loaded, lastSeen: b.loaded });
    s.loads++;
    s.cook += b.qty * COOK_SEC;
    if (b.collected !== null) s.wait += Math.max(0, b.collected - b.done);
    if (b.collected !== null && b.next !== null) s.cold += Math.max(0, b.next - b.collected);
    s.lastSeen = Math.max(s.lastSeen, b.next || b.collected || b.loaded);
  }
  out.table(['furnace', 'first_load_min', 'loads', 'cooking_min', 'finished_waiting_min', 'empty_min'],
    Object.entries(stations).map(([id, s]) => [id, min(s.first), s.loads, min(s.cook), min(s.wait), min(s.cold)]));

  out.section('batches_in_order');
  out.table(['furnace', 'order', 'qty', 'taken', 'loaded_min', 'done_min', 'emptied_min', 'wait_min', 'next_load_min', 'cold_min'],
    (verbose ? batches : batches.slice(0, SHOW_ROWS)).map(b => [b.furnace, b.order, b.qty, b.taken, min(b.loaded), min(b.done), min(b.collected),
      b.collected !== null ? min(Math.max(0, b.collected - b.done)) : null, min(b.next), b.collected !== null && b.next !== null ? min(Math.max(0, b.next - b.collected)) : null]));
}

module.exports = { reduceFurnace, runFurnace };
