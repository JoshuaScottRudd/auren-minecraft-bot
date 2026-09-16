// Auren_Bot/monitoring/locomotion_lenses.js
// THE NAVIGATOR'S OWN CENSUS LINES, reduced: what searching cost, and whether the jump trigger works on
// a diagonal approach. Both read `navigator.postSearchCensus`-family lines and nothing else.
//
// ── WHY THEY ARE ONE FILE AND WHY THEY LEFT trace_monitor (Architect 2026-08-08) ────────────────────
// One record family, one owner: every line either lens matches is emitted by the navigator once per
// trip. Neither flags, neither wakes, and neither shares a signature or threshold with the triage
// engine. The seam is combat_lens's — inputs as ARGUMENTS, render, RETURN; no process.argv, no
// process.exit (a library that exits kills its caller mid-run).
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --pathfinding|--jumps [--bot=B]

'use strict';

const { relativeTime } = require('./trace_read');
// Every line this file prints goes through data_out: field names and values, nothing else. No console.log
// survives here (Architect 2026-09-16 — a lens that cannot form a sentence cannot state a conclusion).
const out = require('./data_out');

// ── --pathfinding : what the fleet spent on searching ────────────────────────────────────────────
// Architect 2026-08-04: "calculate the time each pathfinding takes and post it for watcher tracer to
// look at". navigator posts one [PATHFINDING] line per trip (see navigator.postSearchCensus); this is
// its reducer. It exists because the answer to "how much time did pathfinding take over ten minutes"
// must be produced by the instrument, not by a reader summing lines by eye — a hand-read total dies
// with the session and cannot be reproduced (the standing read-only-through-the-monitor rule).
//
// WHAT TO READ IT FOR, and it is not the total. The total only says the search is or is not the run's
// cost centre. The number that decides an architecture question is `partial` + `noRoute`: the search
// was made provably-optimal by setting HEURISTIC_WEIGHT to 1.0, which costs expansion, and the guard
// that fails first under more expansion is the node budget — which returns a partial. So a partial rate
// climbing across runs is the measured price of that change, and it is exactly the evidence needed to
// decide whether MAX_NODES must rise. Reported per bot AND fleet-wide because a single bot in a cave
// mouth can carry a fleet average on its own.
// AND WHY EVERY NUMBER HERE IS SPLIT BY OWNER. The census this reduces is drained by the navigator but
// written by the whole process, so a trip's line carries searches other callers made — under their own,
// much shorter deadlines. A total that mixes two deadlines cannot be checked against either, which is how
// this reducer came to report a timeout count its own reported time could not pay for. Read a per-owner
// row against that owner's deadline; read the total only for "what did searching cost the run".
// `cutoff` and the owner split are both optional so this reducer still reads a trace written before
// either field existed — an old run reports them absent rather than matching nothing and reading as
// "no pathfinding happened".
const PF_RE = /A\* this trip: (\d+) search\(es\), (\d+)ms total, (\d+)ms avg, (\d+)ms worst, (\d+) nodes \| partial (\d+), (?:cutoff (\d+), )?timedOut (\d+), noRoute (\d+)(?: \| by owner: ([^.]+))?/;

function runPathfinding({ seg = [], traceName = '?', bot: botFilter = null } = {}) {
  const per = new Map();   // bot → totals
  const blank = () => ({ trips: 0, searches: 0, ms: 0, worst: 0, nodes: 0, partial: 0, cutoff: 0, timedOut: 0, failed: 0, owners: new Map() });
  // Every trip that reported something other than a clean result, kept as its OWN row. A sum cannot be
  // audited: this reducer reported `timedOut 7` beside a 67.8s total on 2026-08-15, and seven expiries of
  // a 20s deadline is 140s, so one of its own two numbers had to be wrong and the aggregate could not say
  // which. A total that contradicts itself is worse than no total, because it is quoted with the same
  // confidence as a true one (Law 25) — so the rows behind any non-clean total are printed with it.
  const oddTrips = [];
  let maxRel = 0;
  for (const l of seg) {
    if (l.relSec != null) maxRel = Math.max(maxRel, l.relSec);
    const m = l.raw.match(PF_RE);
    if (!m) continue;
    const bot = l.bot || '(unknown)';
    if (botFilter && bot !== botFilter) continue;
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

  // The header was a prose banner; it is now four fields. `flags`/`wakes` carry what the parenthetical
  // "(context only — never flags, never wakes)" used to assert, as booleans.
  out.kv('lens', 'pathfinding');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('flags', false);
  out.kv('wakes', false);
  if (per.size === 0) {
    // The absence is the count itself. The old line spelled out "0 [PATHFINDING] census lines in the
    // latest run"; the distinction it was protecting (no navigation vs. a build that posts no census)
    // is not this lens's to draw, so only the measured zero remains.
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
    // Printed only when the process had more than one searching caller. With one owner the split repeats
    // the row above it, and a reducer that pads every run with a restatement teaches the reader to skip.
    // The trailing note "(each owner searches under its own deadline)" is deleted — the owner name is
    // the field, and which deadline it runs under is not this lens's to say.
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
  // The old line narrated this split ("stopped at the node budget" / "ended with an empty frontier");
  // the two counts are kept as their own fields and the narration is gone.
  out.kv('partial_at_node_budget', total.cutoff);
  out.kv('partial_empty_frontier', Math.max(0, total.partial - total.cutoff));
  out.kv('timed_out', total.timedOut);
  out.kv('no_route', total.failed);

  if (oddTrips.length) {
    // One row per trip that reported a partial, a timeout, or no route. The banner and its explanation
    // of what the rows are for are deleted; so is the TIME-vs-COUNT paragraph, which was an arithmetic
    // argument about deadlines. The counts and the per-trip time it reasoned over are all still here.
    out.section('trips_with_partial_timeout_or_no_route');
    out.table(['at', 'bot', 'searches', 'total_ms', 'worst_ms', 'nodes', 'partial', 'cutoff', 'timed_out', 'no_route'],
      oddTrips.map(t => [relativeTime(t.relSec), t.bot, t.searches, t.ms, t.worst, t.nodes,
        t.partial, t.cutoff, t.timedOut, t.failed]));
    // The owner split rides in its own table rather than as a column above: the trace's own owner string
    // runs past data_out's 60-character column cap and would be silently truncated, which loses a
    // measurement. Split on the record's own separator, one copied segment per row — no re-parsing.
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
// Architect 2026-08-06: "we should have calculators jump diagonally up at the correct speed but im not
// sure if that works."
//
// WHY THIS READS THE NAVIGATOR AND NOT THE COMBAT JOURNAL, which is where the question was asked. Combat
// runs on flat ground by the base: a 25-minute soak with mobs fed in deliberately produced ONE jump press
// per bot, which answers nothing. An ordinary walk climbs constantly and goes through the SAME driveRun
// with the same prejump, so the presses were always being made — they were just summarised as a bare
// count, and a count cannot tell a working calculator from a broken one. This is that count, split.
//
// WHAT TO READ IT FOR: the `not certified` rate on DIAGONAL against the same rate on AXIAL. riseAhead
// measures a step by subtracting a flat 0.5 from the distance to the cell CENTRE — the half-width of a
// face met head-on — while a corner is ~0.707 away and the body's own half-width toward one is 0.424,
// not 0.3. At 45° the reported lead runs ~0.33 b long, about 1.2 ticks at sprint against a window only
// 5 ticks wide.
//
// AND WHY THE CERTIFIED RATE IS THE WEAKER HALF OF THE ANSWER: jumpTriggerPlan computes its own verdict
// FROM that same distance, so it cannot report an error in it (Law 26 — no grading its own paper). Swept
// across poll phase at 45° and sprint pace, 3 of 20 phases put the leading edge inside the face while the
// arc is still below the step and the plan says `clears` for all 20. So a HIGH diagonal not-certified
// rate convicts the offset; a LOW one does NOT acquit it, and this reducer says so rather than letting a
// clean number read as an all-clear. The outcome measures (re-jumps, stuck-at-level) in --combat are the
// half that can actually acquit.
const JUMPBEAR_RE = /Jump bearing: (\d+) axial, (\d+) oblique, (\d+) diagonal — axial (?:(\d+)\/(\d+) not certified[^,]*|none), diagonal (?:(\d+)\/(\d+) not certified[^.]*|none)\./;
const FUSED_RE = /fused this trip — (\d+) run\(s\) over (\d+) cell\(s\), (\d+) prejump\(s\)/;

function runJumps({ seg = [], traceName = '?', bot: botFilter = null } = {}) {
  const per = new Map();
  const blank = () => ({ trips: 0, axial: 0, oblique: 0, diagonal: 0, lateAxial: 0, lateDiag: 0 });
  let maxRel = 0;
  // Counted separately so an empty result can say WHICH emptiness it is. "No fused run happened" and
  // "fused runs happened and never climbed a step" send a reader to opposite places — the first to the
  // lookahead config, the second to the terrain — and a single "no data" line would hide both behind the
  // same words (the same reason the pathfinding reducer names absence instead of printing 0ms).
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
    // The three prose branches said WHICH emptiness this was. The three counts they were built from are
    // printed instead, and the reader draws the same distinction from them.
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
  // That used to be a NOT-YET-ANSWERABLE sentence; it is now the sample floor and a boolean against it.
  out.kv('min_presses_per_bearing', 10);
  const enough = total.axial >= 10 && total.diagonal >= 10;
  out.kv('sample_sufficient', enough);
  out.kv('axial_not_certified_pct', aR == null ? null : Math.round(aR * 100));
  out.kv('diagonal_not_certified_pct', dR == null ? null : Math.round(dR * 100));
  // The verdict survives as a value with its threshold beside it (OVER/UNDER THE DECLARED GAP was the
  // sentence; the gap and the threshold are the measurement it was made of).
  out.kv('diagonal_axial_gap_pts', (aR == null || dR == null) ? null : Math.round((dR - aR) * 100));
  out.kv('threshold_gap_pts', 15);
  out.kv('over_threshold', enough ? (dR > aR + 0.15) : null);
}

// ── --route-cost : what the fleet's routes actually PRICED, so a cost tier can be set from evidence ──
//
// THE DECISION THIS EXISTS TO SETTLE, and it is the only reason to read it. A* returns the cheapest
// route, so before it may return one costing C it must rule out every route cheaper than C — which means
// expanding every cell reachable for less than C. Expansion volume is therefore set by the PRICE of the
// winning route, never by its distance, and that is why a 2-block hop can expand 300,000 cells: the only
// way in was an edge priced 250, so everything within 250 walk-steps had to be examined and rejected
// first. A tier's real cost is not what it costs to USE — it is what it costs to REJECT.
//
// The tiers are ORDINAL: what the cost model actually encodes is walk < dig < place < protected, and any
// numbers preserving that order produce identical routing. The magnitude buys exactly one thing — how
// long a detour is accepted before the expensive edge wins — so the highest tier only needs to sit above
// the longest route the fleet would ever legitimately walk. That number is not a matter of taste and must
// not be guessed: it is a property of this world and this base, the fleet has been recording it on every
// trip, and this reducer is where it gets read out.
//
// WHY A SEPARATE VIEW FROM --pathfinding, which reads the same family: that one reduces the per-trip
// census (time, nodes, partials) and the census carries no cost field at all, so the number needed here
// is structurally absent from it. This reads the per-SEARCH path lines, where cost is printed.
//
// THE WRONG TURN: reading `cost` as a distance. A 40-step walk and a single protected dig both price ~40
// and ~250 respectively while spanning wildly different ground; the step count is printed beside it for
// exactly that reason. Cost is a PRICE, and the tier question is a question about prices.
//
// PARTIALS ARE EXCLUDED FROM THE TUNING NUMBER, deliberately. A partial's cost is what the search had
// spent when it stopped, not the price of a route to anywhere — including it would inflate the very
// number the tiers get set from, in the direction that keeps them too high (Law 25).
// `, Nms` is OPTIONAL in the initial-path pattern so this reducer still reads a trace written before the
// navigator posted its search time — an older run reports its durations as unknown rather than matching
// nothing and reading as "no navigation happened" (the same rule --pathfinding follows for `cutoff`).
const RC_INITIAL_RE = /A\* path: (\d+) step\(s\) \[([^\]]*)\], cost ([-\d.]+), (\d+) nodes(?:, (\d+)ms)?/;
const RC_REPLAN_RE  = /\breplan (\d+) step\(s\), cost ([-\d.]+), (\d+) nodes \((\d+)ms\)/;
const RC_REPLANNED_RE = /Re-planned: (\d+) step\(s\), cost ([-\d.]+), (\d+) nodes \((\d+)ms\)/;
// The tripwire is the ONLY place an older trace recorded a search duration, and it fires only above the
// slow line — so it back-fills time for exactly the searches this question is about. Matched to a route
// by node count, which is effectively unique at these magnitudes.
const RC_TRIPWIRE_RE = /Route search took (\d+)ms \((\d+) nodes\) for \((-?\d+),(-?\d+),(-?\d+)\) . \((-?\d+),(-?\d+),(-?\d+)\), hop distance (\d+) blocks/;

// The `label` field ('   11 –   25' and friends) is gone: it was a hand-padded phrase, and the bounds it
// spelled out are already the two numbers the band is made of. They print as `band_lo`/`band_hi`; the top
// band's open end is `hi: null`, which data_out renders as absent.
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
  // Back-fill durations the path line did not carry. A tripwire and its path line describe the SAME
  // search, so this reads a recorded number across two lines rather than deriving one.
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
    // The absence is the count. The old parenthetical drew a distinction between "no navigation ran" and
    // "this trace predates the cost field" — that reading is the reader's, not the lens's.
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

  // The ASCII bar is gone with the prose: it drew the same count the `routes` column carries.
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

  // The mechanism, made visible rather than asserted: group the SAME routes by price and show what each
  // band cost to search. If expansion tracked distance this would be flat; it is not, and the shape of
  // this split is the whole argument for lowering the top tiers.
  // COMPLETE ROUTES ONLY, and leaving partials in inverts the finding rather than blurring it. A partial
  // is a search that hit its deadline mid-flood, so it carries a huge examined-count beside whatever
  // fragment of a price it had reached — which lands it in a CHEAP band and makes the cheapest band read
  // as the most expensive to search. One partial among 88 cheap routes was enough to do it here.
  // The heading that said all of that in prose is deleted; the section name and the fields carry it.
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

  // EVERY EXPENSIVE ROUTE, ONE PER LINE. The bands answer "how are prices distributed"; they cannot
  // answer "is an expensive route a long walk or a short one", because a band average over a handful of
  // routes hides exactly the split being asked about — two 5-step floods and one 400-step walk average to
  // something that describes neither. The tail is small by construction (that is the finding), so it is
  // listed rather than summarised.
  const tail = routes.filter(r => r.cost > over).sort((a, b) => b.cost - a.cost);
  out.section('routes_priced_over_threshold');
  out.kv('threshold_cost', over);
  out.kv('routes_over', tail.length);
  out.kv('routes_total', routes.length);
  out.kv('pct_over', Math.round(100 * tail.length / routes.length));
  // The `what it was` column was a phrase per route ('≥1000 places/step, <100 steps', 'PARTIAL — search
  // stopped, no route proven'). It is now the two comparisons it was made of, as booleans, with both
  // thresholds printed as their own fields so the reader can check them. `ms_from_tripwire` replaces the
  // footnote about times matched by node count; an absent `ms` replaces the `?` legend.
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
  // NAV_SEARCH_DEADLINE_MS bounds how long a BODY may stand still, and its whole risk is cutting a search
  // that would have succeeded — so the only number that can size it is the worst search that DID succeed.
  // Not the worst search outright: that figure is dominated by the floods and partials the deadline exists
  // to stop, so sizing against it guarantees a deadline far larger than needed and a body frozen for the
  // difference. Reported here rather than in a second instrument because a lens that already separates
  // complete from partial routes is one field away from the answer (Law 16).
  //
  // The current setting is deliberately NOT hardcoded here for comparison. Monitoring reads a record; a
  // copy of a fleet constant in this file is a second home for one number, and it would go stale silently
  // the next time that constant moves. This prints the evidence; the constant is read where it lives.
  const msKnown = complete.map(r => r.ms).filter(v => v != null).sort((a, b) => a - b);
  // The section name is the question. The prose that framed these numbers as deadline evidence, the
  // restatement of `worst` as "longest search that returned a route", and the caveat calling the figure
  // a floor are all deleted — `routes_with_time` against `complete_routes` is that caveat, measured.
  out.section('search_ms_of_completed_routes');
  out.kv('routes_with_time', msKnown.length);
  out.kv('complete_routes', complete.length);
  if (msKnown.length) {
    out.kv('p50_ms', _percentile(msKnown, 0.50));
    out.kv('p90_ms', _percentile(msKnown, 0.90));
    out.kv('p99_ms', _percentile(msKnown, 0.99));
    out.kv('worst_ms', msKnown[msKnown.length - 1]);
  }

  // "THE TUNING NUMBER" and what it was for is deleted; the two figures and their ratio remain.
  out.section('cost_tier_evidence');
  out.kv('max_complete_cost', +maxComplete.toFixed(1));
  out.kv('p99_complete_cost', +_percentile(sorted, 0.99).toFixed(1));
  out.kv('max_over_p99', +(maxComplete / (_percentile(sorted, 0.99) || 1)).toFixed(1));
}

module.exports = { runPathfinding, runJumps, runRouteCost };
