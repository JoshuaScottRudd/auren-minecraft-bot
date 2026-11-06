// Auren_Bot/monitoring/light_lens.js
// --light: the designed torches over a run — the integrity keeper's light verdict as it changed (the spawn proofing's torches,
// the mine's and the basement cells': standing, missing, blocked or undug, unread), the bodies' shaft visit verdict, every shaft torch a
// visit went to (placed or refused and why), and the torches the mine's diggers set as they dug. Reads the keeper's
// verdict line (the foreman's own stream, one per change), lighting_integrity's line (one per change), lighting_manager's per-torch
// line and mining_executor's torch line. Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --light [--bot=B] [--all]

'use strict';

const out = require('./data_out');

// The integrity keeper's light verdict (foreman/integrity_keeper_worker.js).
const KEEPER_RE = /integrity keeper: light: base (?:(\d+)\/(\d+) standing, (\d+) missing, (\d+) blocked, (\d+) unknown|no spawn proofing sited); mine (\d+)\/(\d+) standing, (\d+) missing, (\d+) undug, (\d+) unknown(?:; basement (\d+)\/(\d+) standing, (\d+) missing, (\d+) undug, (\d+) unknown)?/;
// lighting_integrity: the mine's torches on its design and the dug shaft's missing ones a visit takes.
const VISIT_RE = /mine (\d+) torch\(es\) on its design, (\d+) of them in the dug shaft and missing/;
// lighting_manager, one per shaft torch a visit went to.
const TORCH_RE = /torch (placed|refused) paint=(\S+) mount=(\S+) cell=\((\S+)\) at=\((\S+)\)(?: part=(\S+))?(?: lights=\S+)?(?: reason=(.*))?$/;
// The mine: a torch set while digging (mining_executor).
const MINE_TORCH_RE = /torch placed at \((-?\d+,-?\d+,-?\d+)\)/;
const WINDOW_MIN = 2;          // the verdict timeline is read in windows this long
const ROWS = 40;

const mmss = (sec) => `${Math.floor(sec / 60)}m${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
const n = (x) => (x === undefined ? null : +x);

function reduceLight({ seg = [], foreman = [], bot: botFilter = null } = {}) {
  const keeper = [];
  const visits = [];
  const torches = [];
  const mine = [];
  // The keeper's lines are the foreman's, kept in its own stream; only those inside the segment's span are this run's.
  const from = seg.reduce((lo, l) => (l.atMs && l.atMs < lo ? l.atMs : lo), seg.length ? Infinity : -Infinity);
  const isKeeper = (raw) => KEEPER_RE.test(raw);
  const lines = [...foreman.filter(l => isKeeper(l.raw) && (!l.atMs || l.atMs >= from)), ...seg];
  for (const l of lines) {
    if (botFilter && l.bot !== botFilter && !isKeeper(l.raw)) continue;
    let m = KEEPER_RE.exec(l.raw);
    if (m) {
      keeper.push({ t: l.relSec, baseStanding: n(m[1]), baseTorches: n(m[2]), baseMissing: n(m[3]), baseBlocked: n(m[4]), baseUnknown: n(m[5]),
        mineStanding: +m[6], mineTorches: +m[7], mineMissing: +m[8], mineUndug: +m[9], mineUnknown: +m[10],
        basementStanding: n(m[11]), basementTorches: n(m[12]), basementMissing: n(m[13]), basementUndug: n(m[14]), basementUnknown: n(m[15]) });
      continue;
    }
    m = VISIT_RE.exec(l.raw);
    if (m) { visits.push({ t: l.relSec, bot: l.bot, mineDesigned: +m[1], shaftMissing: +m[2] }); continue; }
    m = TORCH_RE.exec(l.raw);
    if (m) {
      torches.push({ t: l.relSec, bot: l.bot, placed: m[1] === 'placed', paint: m[2], mount: m[3], cell: m[4], at: m[5], part: m[6] || null, reason: m[7] || null });
      continue;
    }
    m = MINE_TORCH_RE.exec(l.raw);
    if (m) mine.push({ t: l.relSec, bot: l.bot, at: m[1] });
  }
  for (const xs of [keeper, visits, torches, mine]) xs.sort((a, b) => a.t - b.t);
  return { keeper, visits, torches, mine };
}

function runLight({ seg = [], foreman = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const { keeper, visits, torches, mine } = reduceLight({ seg, foreman, bot: botFilter });
  const placed = torches.filter(x => x.placed);
  const refused = torches.filter(x => !x.placed);

  out.kv('lens', 'light');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);

  // The keeper's last verdict: the designed torches as the run left them.
  const last = keeper[keeper.length - 1] || null;
  out.section('light_now');
  out.kv('keeper_verdicts', keeper.length);
  out.kv('read_at', last ? mmss(last.t) : null);
  out.kv('base_torches_designed', last ? last.baseTorches : null);
  out.kv('base_torches_standing', last ? last.baseStanding : null);
  out.kv('base_torches_missing', last ? last.baseMissing : null);
  out.kv('base_torch_cells_blocked', last ? last.baseBlocked : null);
  out.kv('base_torches_unread', last ? last.baseUnknown : null);
  out.kv('mine_torches_designed', last ? last.mineTorches : null);
  out.kv('mine_torches_standing', last ? last.mineStanding : null);
  out.kv('mine_torches_missing', last ? last.mineMissing : null);
  out.kv('mine_torches_undug', last ? last.mineUndug : null);
  out.kv('mine_torches_unread', last ? last.mineUnknown : null);
  const lastVisit = visits[visits.length - 1] || null;
  out.kv('shaft_torches_a_visit_takes', lastVisit ? lastVisit.shaftMissing : null);
  out.kv('basement_torches_designed', last ? last.basementTorches : null);
  out.kv('basement_torches_standing', last ? last.basementStanding : null);
  out.kv('basement_torches_missing', last ? last.basementMissing : null);
  out.kv('basement_torches_undug', last ? last.basementUndug : null);
  out.kv('basement_torches_unread', last ? last.basementUnknown : null);

  // The verdict over the run, one row per window: the last verdict the keeper sent in it.
  out.section('light_by_window');
  const windows = new Map();
  for (const v of keeper) windows.set(Math.floor(v.t / (WINDOW_MIN * 60)), v);
  out.table(['from', 'base_standing', 'base_designed', 'base_missing', 'base_blocked', 'mine_standing', 'mine_designed', 'mine_missing', 'mine_undug', 'placed_in_window'],
    [...windows].sort((a, b) => a[0] - b[0]).map(([w, v]) => {
      const lo = w * WINDOW_MIN * 60, hi = lo + WINDOW_MIN * 60;
      return [mmss(lo), v.baseStanding, v.baseTorches, v.baseMissing, v.baseBlocked, v.mineStanding, v.mineTorches, v.mineMissing, v.mineUndug,
        placed.filter(x => x.t >= lo && x.t < hi).length + mine.filter(x => x.t >= lo && x.t < hi).length];
    }));

  out.section('torches');
  out.kv('visits_placed', placed.length);
  out.kv('visits_refused', refused.length);
  out.kv('mine_placed_while_digging', mine.length);
  out.kv('first_torch_at', placed.length || mine.length ? mmss([...placed, ...mine].reduce((lo, x) => Math.min(lo, x.t), Infinity)) : null);
  out.table(['bot', 'visit_placed', 'visit_refused', 'dig_placed'],
    [...new Set([...torches, ...mine].map(x => x.bot))].sort().map(b => [b, placed.filter(x => x.bot === b).length, refused.filter(x => x.bot === b).length, mine.filter(x => x.bot === b).length]));

  out.section('refusals');
  const why = new Map();
  for (const r of refused) why.set(r.reason, (why.get(r.reason) || 0) + 1);
  out.table(['reason', 'torches'], [...why].sort((a, b) => b[1] - a[1]));

  // Every shaft torch a visit went to, in order: the stand cell it was designed over and the cell the torch stands in.
  out.section('torch_list');
  const rows = verbose ? torches : torches.slice(0, ROWS);
  out.table(['at', 'bot', 'outcome', 'part', 'cell', 'torch', 'reason'],
    rows.map(x => [mmss(x.t), x.bot, x.placed ? 'placed' : 'refused', x.part || '-', x.cell, x.at, x.reason || '-']));
  if (!verbose && torches.length > ROWS) out.kv('rows_cut', torches.length - ROWS);
  if (verbose) {
    out.section('mine_torch_list');
    out.table(['at', 'bot', 'torch'], mine.map(x => [mmss(x.t), x.bot, x.at]));
  }
}

module.exports = { reduceLight, runLight };
