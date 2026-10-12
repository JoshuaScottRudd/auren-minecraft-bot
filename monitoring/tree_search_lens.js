// Auren_Bot/monitoring/tree_search_lens.js
// --trees: every tree search the fleet made — how far out the rings had to open before a tree was
// taken, what the reading cost, and how each search ended. Reads the tree-search ledger: one
// `tree_search` line per search, written by tree_feller at the search's end. Inputs as ARGUMENTS, render,
// RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --trees [--bot=B] [--all]

'use strict';

const out = require('./data_out');

const SEARCH_RE = /search outcome=(\w+) zone=(\S+) ring=(\S+) dist=(\S+) rings=(\d+) sections=(\d+) scan_ms=(\d+) seen=(\d+) in_zone=(\d+) examined=(\d+) peer_held=(\d+) boxed=(\d+) path_failed=(\d+) spent=(\d+) search_ms=(\d+) tree=(\S+) species=(\S+)/;

const UNREACHED_RE = /unreached tree=(\S+) stand=(\S+) from=(\S+) flat=(-?\d+) rise=(-?\d+) reason=(\S+) attempts=(\S+) stand_closed_by=(\S+) ended=(\S+) moved=(\d+) held_ms=(\d+) under=(\S+) at=(\S+) above=(\S+)/;
const UNREACHED_ROWS = 20;
const VALVE_RE = /trip_size at=(\S+) item=(\S+) walk=(\d+) walk_s=(\d+) elapsed_s=(\d+) owed_s=(-?\d+) taken=(\d+) held=(\d+) free_slots=(\d+) stays_out=(\d) pace=(\S+)/;

const RING_BLOCKS = 16;     // the ring width tree_feller's search reads by (surface_filter.RING_BLOCKS)
const WINDOW_MIN = 5;        // the run is cut into windows this long, so a receding forest reads as a column
const SLOW_ROWS = 10;

function reduceTreeSearch({ seg = [], bot: botFilter = null } = {}) {
  const searches = [];
  const unreached = [];
  for (const l of seg) {
    if (botFilter && l.bot !== botFilter) continue;
    const u = UNREACHED_RE.exec(l.raw);
    if (u) {
      unreached.push({ bot: l.bot, wallSec: l.wallSec, tree: u[1], stand: u[2], from: u[3], flat: +u[4], rise: +u[5],
        reason: u[6], attempts: u[7], closedBy: u[8], ended: u[9], moved: +u[10], heldMs: +u[11],
        under: u[12], at: u[13], above: u[14] });
      continue;
    }
    const m = SEARCH_RE.exec(l.raw);
    if (!m) continue;
    searches.push({
      bot: l.bot, wallSec: l.wallSec, outcome: m[1], zone: m[2],
      ring: m[3] === '-' ? null : +m[3], dist: m[4] === '-' ? null : +m[4],
      rings: +m[5], sections: +m[6], scanMs: +m[7], seen: +m[8], inZone: +m[9], examined: +m[10],
      peerHeld: +m[11], boxed: +m[12], pathFailed: +m[13], spent: +m[14], searchMs: +m[15],
      tree: m[16], species: m[17],
    });
  }
  return { searches, unreached };
}

const avg = (xs) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1) : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const count = (xs, f) => xs.filter(f).length;

function runTreeSearch({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const { searches, unreached } = reduceTreeSearch({ seg, bot: botFilter });
  const picked = searches.filter(s => s.outcome === 'picked');

  out.kv('lens', 'trees');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);

  out.section('tree_searches');
  out.kv('searches', searches.length);
  out.kv('picked', picked.length);
  out.kv('none_seen', count(searches, s => s.outcome === 'none_seen'));
  out.kv('none_in_zone', count(searches, s => s.outcome === 'none_in_zone'));
  out.kv('all_claimed', count(searches, s => s.outcome === 'all_claimed'));
  out.kv('none_reached', count(searches, s => s.outcome === 'none_reached'));
  out.kv('picked_ring_avg', avg(picked.map(s => s.ring)));
  out.kv('picked_ring_max', max(picked.map(s => s.ring)));
  out.kv('picked_dist_avg_blocks', avg(picked.map(s => s.dist)));
  out.kv('picked_dist_max_blocks', max(picked.map(s => s.dist)));

  // What reading the world cost. scan_ms is the rings alone; search_ms adds the walks to trees tried.
  out.section('tree_search_cost');
  out.kv('scan_ms_avg', avg(searches.map(s => s.scanMs)));
  out.kv('scan_ms_max', max(searches.map(s => s.scanMs)));
  out.kv('scan_ms_total', sum(searches.map(s => s.scanMs)));
  out.kv('rings_opened_avg', avg(searches.map(s => s.rings)));
  out.kv('rings_opened_max', max(searches.map(s => s.rings)));
  out.kv('sections_read_avg', avg(searches.map(s => s.sections)));
  out.kv('sections_read_max', max(searches.map(s => s.sections)));
  out.kv('search_sec_avg', avg(searches.map(s => s.searchMs / 1000)));
  out.kv('search_sec_max', max(searches.map(s => +(s.searchMs / 1000).toFixed(1))));
  out.kv('search_bot_min_total', +(sum(searches.map(s => s.searchMs)) / 60000).toFixed(1));

  // What stood between a search and its tree.
  out.section('tree_search_rejections');
  out.kv('trees_seen', sum(searches.map(s => s.seen)));
  out.kv('trees_in_zone', sum(searches.map(s => s.inZone)));
  out.kv('trees_examined', sum(searches.map(s => s.examined)));
  out.kv('peer_held', sum(searches.map(s => s.peerHeld)));
  out.kv('boxed_no_stand', sum(searches.map(s => s.boxed)));
  out.kv('path_failed', sum(searches.map(s => s.pathFailed)));
  out.kv('already_tried', sum(searches.map(s => s.spent)));
  out.kv('searches_with_a_failed_walk', count(searches, s => s.pathFailed > 0));
  out.kv('picked_first_tree_examined', count(picked, s => s.examined === 1));

  // Which ring the taken tree stood in: ring 0 is 0-16 blocks from the search's centre.
  out.section('picked_by_ring');
  const ringsUsed = [...new Set(picked.map(s => s.ring))].sort((a, b) => a - b);
  out.table(['ring', 'blocks_from', 'blocks_to', 'picked', 'scan_ms_avg', 'sections_avg', 'search_sec_avg'],
    ringsUsed.map(r => {
      const g = picked.filter(s => s.ring === r);
      return [r, r * RING_BLOCKS, (r + 1) * RING_BLOCKS, g.length, avg(g.map(s => s.scanMs)), avg(g.map(s => s.sections)),
        avg(g.map(s => s.searchMs / 1000))];
    }));

  out.section('searches_by_zone');
  const zones = [...new Set(searches.map(s => s.zone))].sort();
  out.table(['zone', 'searches', 'picked', 'none_seen', 'none_in_zone', 'all_claimed', 'none_reached', 'rings_opened_avg', 'scan_ms_avg'],
    zones.map(z => {
      const g = searches.filter(s => s.zone === z);
      return [z, g.length, count(g, s => s.outcome === 'picked'), count(g, s => s.outcome === 'none_seen'),
        count(g, s => s.outcome === 'none_in_zone'), count(g, s => s.outcome === 'all_claimed'),
        count(g, s => s.outcome === 'none_reached'), avg(g.map(s => s.rings)), avg(g.map(s => s.scanMs))];
    }));

  // The run in windows: the ring and the distance a tree was taken at, window by window.
  out.section('searches_by_window');
  const timed = searches.filter(s => Number.isFinite(s.wallSec));
  out.kv('searches_with_a_clock', timed.length);
  const windows = [...new Set(timed.map(s => Math.floor(s.wallSec / 60 / WINDOW_MIN)))].sort((a, b) => a - b);
  out.table(['from_min', 'searches', 'picked', 'picked_ring_avg', 'picked_ring_max', 'picked_dist_avg', 'none_reached', 'all_claimed',
    'none_seen', 'path_failed', 'scan_ms_avg', 'search_sec_avg'],
    windows.map(w => {
      const g = timed.filter(s => Math.floor(s.wallSec / 60 / WINDOW_MIN) === w);
      const p = g.filter(s => s.outcome === 'picked');
      return [w * WINDOW_MIN, g.length, p.length, avg(p.map(s => s.ring)), max(p.map(s => s.ring)), avg(p.map(s => s.dist)),
        count(g, s => s.outcome === 'none_reached'), count(g, s => s.outcome === 'all_claimed'),
        count(g, s => s.outcome === 'none_seen'), sum(g.map(s => s.pathFailed)), avg(g.map(s => s.scanMs)),
        avg(g.map(s => s.searchMs / 1000))];
    }));

  // The searches that took longest, whole.
  out.section('slowest_searches');
  out.table(['bot', 'at_min', 'outcome', 'zone', 'ring', 'rings', 'scan_ms', 'search_sec', 'examined', 'peer_held', 'boxed', 'path_failed'],
    [...searches].sort((a, b) => b.searchMs - a.searchMs).slice(0, SLOW_ROWS).map(s => [s.bot,
      Number.isFinite(s.wallSec) ? +(s.wallSec / 60).toFixed(1) : null, s.outcome, s.zone, s.ring, s.rings, s.scanMs,
      +(s.searchMs / 1000).toFixed(1), s.examined, s.peerHeld, s.boxed, s.pathFailed]));

  // Every walk to a tree that did not arrive, by the reason locomotion gave and by whose closed ground
  // the stand cell lay in; then tree by tree, the most-tried first.
  const tally = (keyOf) => {
    const by = new Map();
    for (const u of unreached) by.set(keyOf(u), (by.get(keyOf(u)) || 0) + 1);
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  };
  out.section('unreached_trees');
  out.kv('walks_not_arrived', unreached.length);
  out.kv('distinct_trees', new Set(unreached.map(u => u.tree)).size);
  out.kv('body_did_not_move', count(unreached, u => u.moved === 0));
  out.kv('held_sec_total', +(sum(unreached.map(u => u.heldMs)) / 1000).toFixed(1));
  out.table(['reason', 'walks'], tally(u => u.reason));
  out.table(['stand_closed_by', 'walks'], tally(u => u.closedBy));
  out.section('unreached_by_tree');
  out.table(['tree', 'stand', 'walks', 'bots', 'reason', 'stand_closed_by', 'flat_avg', 'rise', 'moved_avg', 'under', 'at', 'above'],
    tally(u => u.tree).slice(0, UNREACHED_ROWS).map(([tree, n]) => {
      const g = unreached.filter(u => u.tree === tree);
      const last = g[g.length - 1];
      return [tree, last.stand, n, new Set(g.map(u => u.bot)).size, last.reason, last.closedBy, avg(g.map(u => u.flat)), last.rise,
        avg(g.map(u => u.moved)), last.under, last.at, last.above];
    }));

  // The walk calculator's readings: each time a trip asked whether it had paid for its walk home, how far the
  // body stood from where the trip ends, what that walk costs at its pace, and how long the trip had run
  // (the `trip_size` line of supply_manager and inventory_swapper).
  const valve = [];
  for (const l of seg) {
    if (botFilter && l.bot !== botFilter) continue;
    const m = VALVE_RE.exec(l.raw);
    if (m) valve.push({ bot: l.bot, at: m[1], item: m[2], walk: +m[3], walkS: +m[4], elapsed: +m[5], owed: +m[6], taken: +m[7], held: +m[8], stayed: m[10] === '1', pace: m[11] });
  }
  const banked = valve.filter(v => !v.stayed);
  const share = v => (v.elapsed + v.walkS > 0 ? Math.round(100 * 2 * v.walkS / (v.elapsed + v.walkS)) : 0);
  out.section('trip_size');
  out.kv('readings', valve.length);
  out.kv('stayed_out_to_gather_more', valve.filter(v => v.stayed).length);
  out.kv('went_home_to_bank', banked.length);
  out.kv('pace_unmeasured_readings', valve.filter(v => v.pace !== 'measured').length);
  out.kv('walk_blocks_avg', avg(valve.map(v => v.walk)));
  out.kv('walk_home_seconds_avg', avg(valve.map(v => v.walkS)));
  out.kv('items_held_at_banking_avg', avg(banked.map(v => v.held)));
  out.kv('walking_percent_of_trip_at_banking_avg', avg(banked.filter(v => v.pace === 'measured').map(share)));
  const valveKey = (v) => `${v.at}|${v.item}`;
  out.table(['read_at', 'item', 'readings', 'walk_blocks_avg', 'walk_blocks_max', 'walk_home_seconds_avg', 'stayed_out', 'banked', 'held_at_banking_avg', 'trip_seconds_at_banking_avg', 'walking_percent_at_banking_avg'],
    [...new Set(valve.map(valveKey))].sort().map(k => {
      const g = valve.filter(v => valveKey(v) === k);
      const b = g.filter(v => !v.stayed);
      return [g[0].at, g[0].item, g.length, avg(g.map(v => v.walk)), max(g.map(v => v.walk)), avg(g.map(v => v.walkS)), g.length - b.length, b.length, avg(b.map(v => v.held)), avg(b.map(v => v.elapsed + v.walkS)), avg(b.filter(v => v.pace === 'measured').map(share))];
    }));

  if (verbose) {
    out.section('searches_by_bot');
    const bots = [...new Set(searches.map(s => s.bot))].sort();
    out.table(['bot', 'searches', 'picked', 'none_reached', 'all_claimed', 'path_failed', 'picked_ring_avg', 'search_sec_avg'],
      bots.map(b => {
        const g = searches.filter(s => s.bot === b);
        const p = g.filter(s => s.outcome === 'picked');
        return [b, g.length, p.length, count(g, s => s.outcome === 'none_reached'), count(g, s => s.outcome === 'all_claimed'),
          sum(g.map(s => s.pathFailed)), avg(p.map(s => s.ring)), avg(g.map(s => s.searchMs / 1000))];
      }));
  }
}

module.exports = { reduceTreeSearch, runTreeSearch };
