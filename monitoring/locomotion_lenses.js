// Auren_Bot/monitoring/locomotion_lenses.js
// Reduces the navigator's own census lines: what searching cost, and whether the jump trigger works on
// a diagonal approach. Both read `navigator.postSearchCensus`-family lines only — one record family, one
// owner, emitted by the navigator once per trip. Neither flags nor wakes, and neither shares a signature
// or threshold with the triage engine. Inputs as ARGUMENTS, render, RETURN; no process.argv, no
// process.exit (a library that exits kills its caller mid-run).
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --pathfinding|--jumps|--route-cost [--bot=B]

'use strict';

const { relativeTime } = require('./trace_read');
// Every line this file prints goes through data_out: field names and values, nothing else — no
// console.log.
const out = require('./data_out');

// ── --pathfinding : what the fleet spent on searching ────────────────────────────────────────────
// navigator posts one [PATHFINDING] line per trip (see navigator.postSearchCensus); this is its reducer.
//
// Partials state a shortfall; the separate timeout and memory counters identify measured causes.
// The census's cutoff counts incomplete results, including memory limits, not just node budgets.
//
// The census is drained by the navigator but written by the whole process, so a trip's line carries
// searches made by other callers under their own, shorter deadlines. Read a per-owner row against that
// owner's deadline; read the total only for what searching cost the run. `cutoff` and the owner split
// are both optional — an older trace without them reads as absent, not as zero.
const PF_RE = /A\* this trip: (\d+) search\(es\), (\d+)ms total, (\d+)ms avg, (\d+)ms worst, (\d+) nodes \| partial (\d+), (?:cutoff (\d+), )?timedOut (\d+), noRoute (\d+)(?: \| workspace wait \d+ms, active \d+ms, memoryLimited \d+)?(?: \| by owner: ([^.]+))?/;

function runPathfinding({ seg = [], traceName = '?', bot: botFilter = null } = {}) {
  const per = new Map();   // bot → totals
  const blank = () => ({ trips: 0, searches: 0, ms: 0, worst: 0, nodes: 0, partial: 0, cutoff: 0, timedOut: 0, failed: 0, owners: new Map() });
  // Every trip that reported something other than a clean result, kept as its OWN row — a sum cannot be
  // audited against its parts, and a total that contradicts itself is worse than no total (Law 25).
  const oddTrips = [];
  let workspaceWaitMs = 0, activeMs = 0, memoryLimited = 0, memoryTimingLines = 0;
  let maxRel = 0;
  for (const l of seg) {
    if (l.relSec != null) maxRel = Math.max(maxRel, l.relSec);
    const m = l.raw.match(PF_RE);
    if (!m) continue;
    const bot = l.bot || '(unknown)';
    if (botFilter && bot !== botFilter) continue;
    const memory = l.raw.match(/workspace wait (\d+)ms, active (\d+)ms, memoryLimited (\d+)/);
    if (memory) { memoryTimingLines++; workspaceWaitMs += +memory[1]; activeMs += +memory[2]; memoryLimited += +memory[3]; }
    let s = per.get(bot); if (!s) { s = blank(); per.set(bot, s); }
    s.trips++; s.searches += +m[1]; s.ms += +m[2]; s.nodes += +m[5];
    if (+m[4] > s.worst) s.worst = +m[4];
    s.partial += +m[6]; s.cutoff += +(m[7] || 0); s.timedOut += +m[8]; s.failed += +m[9];
    if (m[10]) {
      for (const part of m[10].split(', ')) {
        const om = part.match(/^(\S+) (\d+)×\/(\d+)ms(?:\/(\d+) timedOut)?$/);
        if (!om) continue;
        let o = s.owners.get(om[1]); if (!o) { o = { searches: 0, ms: 0, timedOut: 0 }; s.owners.set(om[1], o); }
        o.searches += +om[2]; o.ms += +om[3]; o.timedOut += +(om[4] || 0);
      }
    }
    if (+m[6] || +m[8] || +m[9]) {
      oddTrips.push({ bot, relSec: l.relSec, searches: +m[1], ms: +m[2], worst: +m[4], nodes: +m[5],
                      partial: +m[6], cutoff: +(m[7] || 0), timedOut: +m[8], failed: +m[9],
                      owners: m[10] || null });
    }
  }

  // `flags`/`wakes` state this reducer never flags and never wakes, as booleans.
  out.kv('lens', 'pathfinding');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('flags', false);
  out.kv('wakes', false);
  out.kv('memory_timing_lines', memoryTimingLines);
  out.kv('workspace_wait_ms', memoryTimingLines ? workspaceWaitMs : null);
  out.kv('active_search_ms', memoryTimingLines ? activeMs : null);
  out.kv('memory_limited_searches', memoryTimingLines ? memoryLimited : null);
  if (per.size === 0) {
    // The absence is the count itself.
    out.zero('census_lines');
    return;
  }

  const total = blank();
  const botRows = [];
  const ownerRows = [];
  for (const [bot, s] of per) {
    // `worst` is a MAXIMUM, not a sum — summing two bots' worst searches invents a single search that
    // never ran, and it is the one number here a reader would take straight to a deadline decision.
    for (const k of Object.keys(total)) { if (k !== 'worst' && k !== 'owners') total[k] += s[k]; }
    if (s.worst > total.worst) total.worst = s.worst;
    for (const [name, o] of s.owners) {
      let t = total.owners.get(name); if (!t) { t = { searches: 0, ms: 0, timedOut: 0 }; total.owners.set(name, t); }
      t.searches += o.searches; t.ms += o.ms; t.timedOut += o.timedOut;
    }
    const avg = s.searches ? Math.round(s.ms / s.searches) : 0;
    const share = maxRel > 0 ? +(100 * s.ms / 1000 / maxRel).toFixed(1) : null;
    botRows.push([bot, s.trips, s.searches, +(s.ms / 1000).toFixed(1), share, avg, s.worst, s.nodes,
      s.partial, s.searches ? Math.round(100 * s.partial / s.searches) : 0,
      s.cutoff, s.timedOut, s.failed,
      s.trips ? +(s.searches / s.trips).toFixed(2) : 0]);
    // Printed only when the process had more than one searching caller — with one owner the split
    // repeats the row above it.
    if (s.owners.size > 1) {
      for (const [n, o] of [...s.owners.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
        ownerRows.push([bot, n, o.searches, +(o.ms / 1000).toFixed(1), o.timedOut]);
      }
    }
  }
  out.section('per_bot');
  out.table(['bot', 'trips', 'searches', 'total_s', 'pct_of_run', 'avg_ms', 'worst_ms', 'nodes',
    'partial', 'partial_pct', 'cutoff', 'timed_out', 'no_route', 'searches_per_trip'], botRows);

  if (ownerRows.length) {
    out.section('per_bot_by_search_owner');
    out.table(['bot', 'owner', 'searches', 'total_s', 'timed_out'], ownerRows);
  }

  const avgAll = total.searches ? Math.round(total.ms / total.searches) : 0;
  // Divided by bot count as well as span: the denominator is BOT-seconds, not wall-clock seconds, or two
  // bots each spending 10% would read as 20% of a clock that only ever ran once.
  const pctRun = maxRel > 0 ? +(100 * total.ms / 1000 / (maxRel * per.size)).toFixed(1) : null;
  out.section('fleet');
  out.kv('bots', per.size);
  out.kv('trips', total.trips);
  out.kv('searches', total.searches);
  out.kv('total_s', +(total.ms / 1000).toFixed(1));
  out.kv('run_span', relativeTime(maxRel));
  out.kv('avg_ms_per_search', avgAll);
  out.kv('worst_ms', total.worst);
  out.kv('pct_of_bot_wall_clock', pctRun);
  out.kv('searches_per_trip', total.trips ? +(total.searches / total.trips).toFixed(2) : 0);
  out.kv('partial', total.partial);
  out.kv('incomplete_searches', total.cutoff);
  out.kv('partial_empty_frontier', Math.max(0, total.partial - total.cutoff));
  out.kv('timed_out', total.timedOut);
  out.kv('no_route', total.failed);

  if (oddTrips.length) {
    // One row per trip that reported a partial, a timeout, or no route.
    out.section('trips_with_partial_timeout_or_no_route');
    out.table(['at', 'bot', 'searches', 'total_ms', 'worst_ms', 'nodes', 'partial', 'cutoff', 'timed_out', 'no_route'],
      oddTrips.map(t => [relativeTime(t.relSec), t.bot, t.searches, t.ms, t.worst, t.nodes,
        t.partial, t.cutoff, t.timedOut, t.failed]));
    // Its own table, not a column above: the owner string can run past data_out's 60-character column
    // cap and would be silently truncated there.
    const splits = [];
    for (const t of oddTrips) {
      if (!t.owners) continue;
      for (const part of t.owners.split(', ')) splits.push([relativeTime(t.relSec), t.bot, part]);
    }
    if (splits.length) {
      out.section('trip_search_owner_splits');
      out.table(['at', 'bot', 'owner_search'], splits);
    }
  }
}

// ── --jumps : does the jump trigger work on a DIAGONAL approach? ─────────────────────────────────
// Reduces the navigator's own jump-bearing census: presses split by axial/oblique/diagonal approach,
// and the `not certified` rate for each.
//
// riseAhead measures a step against the cell CENTRE, which understates the lead at a corner — at 45°
// the reported lead runs short by about 1.2 ticks against a 5-tick window.
//
// jumpTriggerPlan grades its own verdict from that same distance (Law 26), so a HIGH diagonal
// not-certified rate convicts the offset; a LOW one does not acquit it. The outcome measures (re-jumps,
// stuck-at-level) in --combat are what can actually acquit it.
const JUMPBEAR_RE = /Jump bearing: (\d+) axial, (\d+) oblique, (\d+) diagonal — axial (?:(\d+)\/(\d+) not certified[^,]*|none), diagonal (?:(\d+)\/(\d+) not certified[^.]*|none)\./;
const FUSED_RE = /fused this trip — (\d+) run\(s\) over (\d+) cell\(s\), (\d+) prejump\(s\)/;

function runJumps({ seg = [], traceName = '?', bot: botFilter = null } = {}) {
  const per = new Map();
  const blank = () => ({ trips: 0, axial: 0, oblique: 0, diagonal: 0, lateAxial: 0, lateDiag: 0 });
  let maxRel = 0;
  // Counted separately so an empty result can say WHICH emptiness it is: no fused run at all points to
  // the lookahead config, fused runs that never climbed a step point to the terrain.
  let fusedTrips = 0, fusedPrejumps = 0;
  for (const l of seg) {
    if (l.relSec != null) maxRel = Math.max(maxRel, l.relSec);
    const f = l.raw.match(FUSED_RE);
    if (f && (!botFilter || l.bot === botFilter)) { fusedTrips++; fusedPrejumps += +f[3]; }
    const m = l.raw.match(JUMPBEAR_RE);
    if (!m) continue;
    const bot = l.bot || '(unknown)';
    if (botFilter && bot !== botFilter) continue;
    let s = per.get(bot); if (!s) { s = blank(); per.set(bot, s); }
    s.trips++;
    s.axial += +m[1]; s.oblique += +m[2]; s.diagonal += +m[3];
    s.lateAxial += +(m[4] || 0); s.lateDiag += +(m[6] || 0);
  }

  out.kv('lens', 'jumps');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('flags', false);
  out.kv('wakes', false);
  if (per.size === 0) {
    // Prints the three counts so the reader can tell which emptiness this run had.
    out.kv('bearing_lines', 0);
    out.kv('fused_trips', fusedTrips);
    out.kv('fused_prejumps', fusedPrejumps);
    return;
  }

  const total = blank();
  const rows = [];
  for (const [bot, s] of per) {
    for (const k of Object.keys(total)) total[k] += s[k];
    const pct = (a, b) => (b ? Math.round(100 * a / b) : null);
    rows.push([bot, s.axial + s.oblique + s.diagonal, s.trips, s.axial, s.oblique, s.diagonal,
      s.lateAxial, pct(s.lateAxial, s.axial), s.lateDiag, pct(s.lateDiag, s.diagonal)]);
  }
  out.section('per_bot');
  out.table(['bot', 'presses', 'trips', 'axial', 'oblique', 'diagonal',
    'axial_not_certified', 'axial_not_certified_pct',
    'diagonal_not_certified', 'diagonal_not_certified_pct'], rows);

  const aR = total.axial ? total.lateAxial / total.axial : null;
  const dR = total.diagonal ? total.lateDiag / total.diagonal : null;
  out.section('fleet');
  out.kv('axial', total.axial);
  out.kv('oblique', total.oblique);
  out.kv('diagonal', total.diagonal);
  out.kv('trips', total.trips);
  out.kv('axial_not_certified', total.lateAxial);
  out.kv('diagonal_not_certified', total.lateDiag);
  // Both populations need enough presses before the rates mean anything: a 1-of-1 rate reads as 100%.
  // `min_presses_per_bearing` is the sample floor; `sample_sufficient` is the boolean against it.
  out.kv('min_presses_per_bearing', 10);
  const enough = total.axial >= 10 && total.diagonal >= 10;
  out.kv('sample_sufficient', enough);
  out.kv('axial_not_certified_pct', aR == null ? null : Math.round(aR * 100));
  out.kv('diagonal_not_certified_pct', dR == null ? null : Math.round(dR * 100));
  // The gap between the two rates, with its threshold printed beside it.
  out.kv('diagonal_axial_gap_pts', (aR == null || dR == null) ? null : Math.round((dR - aR) * 100));
  out.kv('threshold_gap_pts', 15);
  out.kv('over_threshold', enough ? (dR > aR + 0.15) : null);
}

// ── --route-cost : what the fleet's routes actually PRICED, so a cost tier can be set from evidence ──
//
// A* returns the cheapest route, so before it may return one costing C it must expand every cell
// reachable for less than C — expansion volume is set by the PRICE of the winning route, not its
// distance. A tier's real cost is what it costs to REJECT, not what it costs to use.
//
// The tiers are ORDINAL: any numbers preserving walk < dig < place < protected produce identical
// routing. The magnitude sets how long a detour is accepted before the expensive edge wins, so the
// highest tier only needs to sit above the longest route the fleet would legitimately walk — a property
// of this world and base that the fleet records on every trip and this reducer reads out.
//
// Reads the per-search path lines, where cost is printed; --pathfinding's per-trip census carries no
// cost field.
//
// `cost` is a PRICE, not a distance: a short walk and a single protected dig can price alike despite
// spanning very different ground, so step count is printed beside it.
//
// Partials are excluded from the tuning number: a partial's cost is what the search had spent when it
// stopped, not the price of a route to anywhere (Law 25).
// `, Nms` is OPTIONAL in the initial-path pattern so this reducer still reads a trace written before the
// navigator posted its search time — an older run reports its durations as unknown, the same rule
// --pathfinding follows for `cutoff`.
const RC_INITIAL_RE = /A\* path: (\d+) step\(s\) \[([^\]]*)\], cost ([-\d.]+), (\d+) nodes(?:, (\d+)ms)?/;
const RC_REPLAN_RE  = /\breplan (\d+) step\(s\), cost ([-\d.]+), (\d+) nodes \((\d+)ms\)/;
const RC_REPLANNED_RE = /Re-planned: (\d+) step\(s\), cost ([-\d.]+), (\d+) nodes \((\d+)ms\)/;
// The tripwire is the ONLY place an older trace recorded a search duration, and it fires only above the
// slow line — so it back-fills time for exactly the searches this question is about. Matched to a route
// by node count, which is effectively unique at these magnitudes.
const RC_TRIPWIRE_RE = /Route search took (\d+)ms \((\d+) nodes\) for \((-?\d+),(-?\d+),(-?\d+)\) . \((-?\d+),(-?\d+),(-?\d+)\), hop distance (\d+) blocks/;

// Bands print as `band_lo`/`band_hi`; the top band's open end is `hi: null`, which data_out renders as
// absent.
const RC_BANDS = [
  { lo: 0,   hi: 10 },
  { lo: 10,  hi: 25 },
  { lo: 25,  hi: 60 },
  { lo: 60,  hi: 150 },
  { lo: 150, hi: 250 },
  { lo: 250, hi: null },
];
// Band membership, with the top band's null upper bound read as unbounded.
const inBand = (r, b) => r.cost > b.lo && (b.hi == null || r.cost <= b.hi);

function _percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

function runRouteCost({ seg = [], traceName = '?', bot: botFilter = null, over = 60 } = {}) {
  const routes = [];          // { cost, steps, nodes, ms, partial, bot, relSec }
  const edges = new Map();    // edgeType → count
  const msByNodes = new Map();// nodesVisited → { ms, hop } from tripwire lines
  let maxRel = 0;
  for (const l of seg) {
    if (l.relSec != null) maxRel = Math.max(maxRel, l.relSec);
    if (botFilter && l.bot !== botFilter) continue;
    const r = l.raw;
    let m;
    if ((m = r.match(RC_TRIPWIRE_RE))) {
      msByNodes.set(+m[2], { ms: +m[1], hop: +m[9] });
    } else if ((m = r.match(RC_INITIAL_RE))) {
      routes.push({
        steps: +m[1], cost: +m[3], nodes: +m[4],
        ms: m[5] !== undefined ? +m[5] : null,
        partial: r.includes('(PARTIAL'), bot: l.bot || '?', relSec: l.relSec,
      });
      for (const part of m[2].split(',')) {
        const [t, n] = part.trim().split('×');
        if (t && n) edges.set(t, (edges.get(t) || 0) + (+n || 0));
      }
    } else if ((m = r.match(RC_REPLANNED_RE)) || (m = r.match(RC_REPLAN_RE))) {
      routes.push({ steps: +m[1], cost: +m[2], nodes: +m[3], ms: +m[4], partial: false, bot: l.bot || '?', relSec: l.relSec });
    }
  }
  // Back-fill durations the path line did not carry: a tripwire and its path line describe the same
  // search, so the recorded number is read across both lines.
  for (const rt of routes) {
    if (rt.ms == null && msByNodes.has(rt.nodes)) {
      const t = msByNodes.get(rt.nodes);
      rt.ms = t.ms; rt.hop = t.hop; rt.msFromTripwire = true;
    }
  }

  out.kv('lens', 'route_cost');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('flags', false);
  out.kv('wakes', false);
  if (!routes.length) {
    // The absence is the count.
    out.zero('a_star_path_lines');
    return;
  }

  const complete = routes.filter(r => !r.partial);
  const sorted = complete.map(r => r.cost).sort((a, b) => a - b);
  const maxComplete = sorted.length ? sorted[sorted.length - 1] : 0;

  out.section('routes');
  out.kv('priced', routes.length);
  out.kv('complete', complete.length);
  out.kv('partial', routes.length - complete.length);

  out.section('cost_bands');
  out.table(['band_lo', 'band_hi', 'routes', 'pct_of_routes'],
    RC_BANDS.map(b => {
      const n = routes.filter(r => inBand(r, b)).length;
      return [b.lo, b.hi, n, Math.round(100 * n / routes.length)];
    }));

  out.section('cost_percentiles_complete_routes');
  out.kv('p50', +_percentile(sorted, 0.50).toFixed(1));
  out.kv('p90', +_percentile(sorted, 0.90).toFixed(1));
  out.kv('p99', +_percentile(sorted, 0.99).toFixed(1));
  out.kv('max', +maxComplete.toFixed(1));

  // Groups the SAME routes by price and shows what each band cost to search — if expansion tracked
  // distance this would be flat.
  //
  // COMPLETE ROUTES ONLY: a partial carries a huge examined-count beside whatever fragment of a price it
  // had reached, which lands it in a cheap band and inflates that band's search cost.
  const searchRows = [];
  for (const b of RC_BANDS) {
    const rs = complete.filter(r => inBand(r, b));
    if (!rs.length) continue;
    searchRows.push([b.lo, b.hi, rs.length,
      Math.round(rs.reduce((s, r) => s + r.nodes, 0) / rs.length),
      Math.round(rs.reduce((s, r) => s + r.steps, 0) / rs.length)]);
  }
  out.section('places_examined_per_cost_band_complete_routes');
  out.table(['band_lo', 'band_hi', 'routes', 'avg_places_examined', 'avg_steps'], searchRows);

  out.section('edges_walked');
  if (!edges.size) {
    out.zero('edge_types');
  } else {
    out.table(['edge_type', 'count'], [...edges.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => [t, n]));
  }

  // EVERY EXPENSIVE ROUTE, ONE PER LINE: a band average over a handful of routes cannot show whether an
  // expensive route is a long walk or a short flood, so the tail is listed individually.
  const tail = routes.filter(r => r.cost > over).sort((a, b) => b.cost - a.cost);
  out.section('routes_priced_over_threshold');
  out.kv('threshold_cost', over);
  out.kv('routes_over', tail.length);
  out.kv('routes_total', routes.length);
  out.kv('pct_over', Math.round(100 * tail.length / routes.length));
  // Each route's two threshold comparisons print as booleans, with both thresholds as their own fields.
  // `ms_from_tripwire` marks a duration matched in by node count instead of read from the path line.
  out.kv('threshold_places_per_step', 1000);
  out.kv('threshold_steps', 100);
  out.table(['cost', 'steps', 'places', 'ms', 'places_per_step', 'partial',
    'places_per_step_over_1000', 'steps_at_least_100', 'ms_from_tripwire'],
    tail.map(r => {
      const perStep = r.steps ? Math.round(r.nodes / r.steps) : 0;
      return [Math.round(r.cost), r.steps, r.nodes, r.ms, perStep, r.partial,
        perStep > 1000, r.steps >= 100, !!r.msFromTripwire];
    }));

  // ── DEADLINE EVIDENCE ────────────────────────────────────────────────────────────────────────────
  // NAV_SEARCH_DEADLINE_MS bounds how long a body may stand still; the number that sizes it is the worst
  // search that DID succeed, not the worst search outright, which is dominated by floods and partials the
  // deadline exists to stop. A lens that already separates complete from partial routes is one field away
  // from the answer (Law 16).
  //
  // The current setting is not hardcoded here: monitoring reads a record, and this prints the evidence —
  // the constant is read where it lives.
  const msKnown = complete.map(r => r.ms).filter(v => v != null).sort((a, b) => a - b);
  // `routes_with_time` against `complete_routes` states how much of the sample this figure covers.
  out.section('search_ms_of_completed_routes');
  out.kv('routes_with_time', msKnown.length);
  out.kv('complete_routes', complete.length);
  if (msKnown.length) {
    out.kv('p50_ms', _percentile(msKnown, 0.50));
    out.kv('p90_ms', _percentile(msKnown, 0.90));
    out.kv('p99_ms', _percentile(msKnown, 0.99));
    out.kv('worst_ms', msKnown[msKnown.length - 1]);
  }

  // The two figures behind the cost-tier decision, and their ratio.
  out.section('cost_tier_evidence');
  out.kv('max_complete_cost', +maxComplete.toFixed(1));
  out.kv('p99_complete_cost', +_percentile(sorted, 0.99).toFixed(1));
  out.kv('max_over_p99', +(maxComplete / (_percentile(sorted, 0.99) || 1)).toFixed(1));
}

module.exports = { runPathfinding, runJumps, runRouteCost };
