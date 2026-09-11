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

  console.log(`trace_monitor · pathfinding · ${traceName} · latest run · span [${relativeTime(maxRel)}]`);
  console.log('(context only — never flags, never wakes)\n');
  if (per.size === 0) {
    // Named as absent rather than reported as zero: a run with no navigation and a build that never
    // posts its census are different facts, and a "0ms" would read as the first while meaning either.
    console.log('(no [PATHFINDING] census lines in the latest run — either no navigation ran, or this trace predates the census)');
    return;
  }

  const total = blank();
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
    const share = maxRel > 0 ? (100 * s.ms / 1000 / maxRel).toFixed(1) : '?';
    console.log(`${bot}: ${s.trips} trip(s), ${s.searches} search(es), ${(s.ms / 1000).toFixed(1)}s total (${share}% of the run), ${avg}ms avg, ${s.worst}ms worst, ${s.nodes} nodes`);
    console.log(`   partial ${s.partial} (${s.searches ? Math.round(100 * s.partial / s.searches) : 0}%) · cutoff ${s.cutoff} · timedOut ${s.timedOut} · noRoute ${s.failed}`);
    console.log(`   searches per trip ${s.trips ? (s.searches / s.trips).toFixed(2) : '0'} — 1.00 means every navigation planned once and walked it`);
    // Printed only when the process had more than one searching caller. With one owner the split repeats
    // the line above it, and a reducer that pads every run with a restatement teaches the reader to skip.
    if (s.owners.size > 1) {
      const rows = [...s.owners.entries()].sort((a, b) => b[1].ms - a[1].ms)
        .map(([n, o]) => `${n} ${o.searches}× ${(o.ms / 1000).toFixed(1)}s${o.timedOut ? ` (${o.timedOut} timedOut)` : ''}`);
      console.log(`   by owner: ${rows.join(' · ')} — each owner searches under its OWN deadline; hold a row against that one, never against the total`);
    }
  }
  console.log('');
  const avgAll = total.searches ? Math.round(total.ms / total.searches) : 0;
  // Divided by bot count as well as span: the denominator is BOT-seconds, not wall-clock seconds, or two
  // bots each spending 10% would read as 20% of a clock that only ever ran once.
  const pctRun = maxRel > 0 ? (100 * total.ms / 1000 / (maxRel * per.size)).toFixed(1) : '?';
  console.log(`▸ FLEET: ${total.searches} search(es) over ${per.size} bot(s), ${(total.ms / 1000).toFixed(1)}s of search across a ${relativeTime(maxRel)} run.`);
  console.log(`▸ ${avgAll}ms average per search, ${total.worst}ms worst single search, ${pctRun}% of each bot's wall clock spent inside A*.`);
  console.log(`▸ SEARCHES PER TRIP: ${total.trips ? (total.searches / total.trips).toFixed(2) : '0'} (1.00 = plan once, walk it; higher = re-planning mid-walk).`);
  console.log(`▸ BINARY-ANSWER CHECK: ${total.cutoff} of ${total.searches} searches were CUT OFF by the node budget — only those cannot support a verdict. A partial that ran the frontier dry (${Math.max(0, total.partial - total.cutoff)}) is a proven "no route exists".`);

  if (oddTrips.length) {
    console.log('\n── EVERY TRIP BEHIND THOSE COUNTS ────────────────────────────────────────────');
    console.log('(one row per trip that reported a partial, a timeout, or no route — the sums above are these rows added up)\n');
    for (const t of oddTrips) {
      const tags = [];
      if (t.timedOut) tags.push(`timedOut ${t.timedOut}`);
      if (t.partial) tags.push(`partial ${t.partial}`);
      if (t.cutoff) tags.push(`cutoff ${t.cutoff}`);
      if (t.failed) tags.push(`noRoute ${t.failed}`);
      console.log(`  [${relativeTime(t.relSec)}] ${t.bot}: ${t.searches} search(es), ${t.ms}ms total, ${t.worst}ms worst, ${t.nodes} nodes — ${tags.join(' · ')}`);
      if (t.owners) console.log(`        by owner: ${t.owners}`);
    }
    // The arithmetic a reader would otherwise do by eye, and the reason these rows are printed at all.
    // A timeout means the search ran until its own deadline expired, so N timeouts cost at least N of
    // THAT owner's deadline — and a trip mixing owners mixes deadlines, which is why the check is stated
    // per owner. Read against a single assumed deadline it reports a contradiction that is not there.
    console.log('\n▸ TIME-vs-COUNT: a timeout costs a FULL deadline, so N timeouts by one owner must show at least N × that OWNER\'s deadline of search time.');
    console.log('  Check each owner against its own deadline. A row still under its floor means the count is inflated, not that timeouts got cheap.');
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

  console.log(`trace_monitor · jumps · ${traceName} · latest run · span [${relativeTime(maxRel)}]`);
  console.log('(context only — never flags, never wakes)\n');
  if (per.size === 0) {
    if (!fusedTrips) {
      console.log('(no fused navigator runs at all in the latest run — nothing walked far enough to fuse, so there was nothing to press jump for)');
    } else if (!fusedPrejumps) {
      console.log(`(${fusedTrips} fused trip(s), and ZERO jump presses across all of them — the ground the fleet walks is flat.`);
      console.log(' Not a defect and not a gap in this reducer: there is genuinely no diagonal-vs-axial evidence to be had');
      console.log(' until the fleet walks terrain that climbs. The mine staircase and the canopy are the candidates.)');
    } else {
      console.log(`(${fusedTrips} fused trip(s) with ${fusedPrejumps} press(es), but no bearing line — this trace predates the split; restart the fleet)`);
    }
    return;
  }

  const total = blank();
  for (const [bot, s] of per) {
    for (const k of Object.keys(total)) total[k] += s[k];
    const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '—');
    console.log(`${bot}: ${s.axial + s.oblique + s.diagonal} press(es) over ${s.trips} trip(s) — ${s.axial} axial, ${s.oblique} oblique, ${s.diagonal} diagonal`);
    console.log(`   not certified: axial ${s.lateAxial}/${s.axial} (${pct(s.lateAxial, s.axial)}) · diagonal ${s.lateDiag}/${s.diagonal} (${pct(s.lateDiag, s.diagonal)})`);
  }
  console.log('');
  const aR = total.axial ? total.lateAxial / total.axial : null;
  const dR = total.diagonal ? total.lateDiag / total.diagonal : null;
  console.log(`▸ FLEET: ${total.axial} axial, ${total.oblique} oblique, ${total.diagonal} diagonal press(es) over ${total.trips} trip(s).`);
  // Both populations need enough presses to say anything. Named as insufficient rather than printed as a
  // ratio, because a 1-of-1 rate reads as 100% and would be quoted as a finding.
  if (total.axial < 10 || total.diagonal < 10) {
    console.log(`▸ NOT YET ANSWERABLE — need ≥10 presses per bearing (have ${total.axial} axial / ${total.diagonal} diagonal). Let the fleet walk more.`);
  } else if (dR > aR + 0.15) {
    console.log(`▸ ⭐ CONVICTED: diagonal ${Math.round(dR * 100)}% not certified against axial ${Math.round(aR * 100)}%.`);
    console.log('▸ This is the predicted signature of riseAhead\'s flat 0.5 face offset. A corner is ~0.707 away, so the');
    console.log('▸ trigger believes the body is ~0.33b further out than it is and fires ~1.2 ticks late at sprint.');
  } else {
    console.log(`▸ NO BEARING-LINKED DIFFERENCE in the certified rate (diagonal ${Math.round(dR * 100)}% vs axial ${Math.round(aR * 100)}%).`);
    console.log('▸ NOT an all-clear: the verdict is computed from the suspect distance, so it cannot see an error in it.');
    console.log('▸ Read the OUTCOME split (re-jumps / stuck-at-level, per bearing) in --combat before clearing the offset.');
  }
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

const RC_BANDS = [
  { label: '        ≤ 10', lo: 0,   hi: 10 },
  { label: '   11 –   25', lo: 10,  hi: 25 },
  { label: '   26 –   60', lo: 25,  hi: 60 },
  { label: '   61 –  150', lo: 60,  hi: 150 },
  { label: '  151 –  250', lo: 150, hi: 250 },
  { label: '       > 250', lo: 250, hi: Infinity },
];

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

  console.log(`trace_monitor · route cost · ${traceName} · latest run · span [${relativeTime(maxRel)}]`);
  console.log('(context only — never flags, never wakes)\n');
  if (!routes.length) {
    // Named as absent rather than reported as zero, for the same reason --pathfinding names it: "no
    // navigation ran" and "this trace predates the cost field" send a reader to opposite places.
    console.log('(no A* path lines in the latest run — either nothing navigated, or this trace predates the cost field)');
    return;
  }

  const complete = routes.filter(r => !r.partial);
  const sorted = complete.map(r => r.cost).sort((a, b) => a - b);
  const maxComplete = sorted.length ? sorted[sorted.length - 1] : 0;
  const widest = Math.max(...RC_BANDS.map(b => routes.filter(r => r.cost > b.lo && r.cost <= b.hi).length), 1);

  console.log(`WHAT A ROUTE COST — ${routes.length} priced route(s), ${complete.length} complete, ${routes.length - complete.length} partial:`);
  for (const b of RC_BANDS) {
    const n = routes.filter(r => r.cost > b.lo && r.cost <= b.hi).length;
    const bar = '█'.repeat(Math.round(28 * n / widest));
    console.log(`  ${b.label} : ${String(n).padStart(4)} (${String(Math.round(100 * n / routes.length)).padStart(3)}%) ${bar}`);
  }
  console.log('');
  console.log(`  p50 ${_percentile(sorted, 0.50).toFixed(1)} · p90 ${_percentile(sorted, 0.90).toFixed(1)} · p99 ${_percentile(sorted, 0.99).toFixed(1)} · max ${maxComplete.toFixed(1)}  (complete routes only)`);
  console.log('');

  // The mechanism, made visible rather than asserted: group the SAME routes by price and show what each
  // band cost to search. If expansion tracked distance this would be flat; it is not, and the shape of
  // this split is the whole argument for lowering the top tiers.
  // COMPLETE ROUTES ONLY, and leaving partials in inverts the finding rather than blurring it. A partial
  // is a search that hit its deadline mid-flood, so it carries a huge examined-count beside whatever
  // fragment of a price it had reached — which lands it in a CHEAP band and makes the cheapest band read
  // as the most expensive to search. One partial among 88 cheap routes was enough to do it here.
  console.log('WHAT EACH PRICE BAND COST TO SEARCH (places examined per route — the flood, measured; complete routes only):');
  for (const b of RC_BANDS) {
    const rs = complete.filter(r => r.cost > b.lo && r.cost <= b.hi);
    if (!rs.length) continue;
    const avgNodes = Math.round(rs.reduce((s, r) => s + r.nodes, 0) / rs.length);
    const avgSteps = Math.round(rs.reduce((s, r) => s + r.steps, 0) / rs.length);
    console.log(`  ${b.label} : ${String(avgNodes).padStart(7)} places examined on average, for a route of ${avgSteps} step(s)`);
  }
  console.log('');

  if (edges.size) {
    const line = [...edges.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join('  ');
    console.log(`EDGES THE FLEET ACTUALLY WALKED: ${line}`);
    console.log('');
  }

  // EVERY EXPENSIVE ROUTE, ONE PER LINE. The bands answer "how are prices distributed"; they cannot
  // answer "is an expensive route a long walk or a short one", because a band average over a handful of
  // routes hides exactly the split being asked about — two 5-step floods and one 400-step walk average to
  // something that describes neither. The tail is small by construction (that is the finding), so it is
  // listed rather than summarised.
  const tail = routes.filter(r => r.cost > over).sort((a, b) => b.cost - a.cost);
  console.log(`EVERY ROUTE PRICED OVER ${over} — ${tail.length} of ${routes.length} (${Math.round(100 * tail.length / routes.length)}%):`);
  if (!tail.length) {
    console.log(`  (none — no route this run priced over ${over})`);
  } else {
    console.log('   cost   steps      places      time   per step   what it was');
    for (const r of tail) {
      const perStep = r.steps ? Math.round(r.nodes / r.steps) : 0;
      // The discriminator, stated per route rather than left to the reader: places-examined per step of
      // route is high only when the search flooded for a route that goes nowhere. A genuinely long walk
      // examines many cells AND produces many steps, so its ratio stays low.
      const kind = r.partial ? 'PARTIAL — search stopped, no route proven'
        : perStep > 1000 ? 'SHORT route, huge search — priced by ONE expensive edge'
        : r.steps >= 100 ? 'LONG walk — earned its price in distance'
        : 'moderate';
      const t = r.ms == null ? '     ?' : `${String(r.ms).padStart(5)}ms`;
      console.log(`  ${String(r.cost.toFixed(0)).padStart(5)} ${String(r.steps).padStart(7)} ${String(r.nodes).padStart(11)} ${t} ${String(perStep).padStart(10)}   ${kind}`);
    }
    if (tail.some(r => r.msFromTripwire)) {
      console.log('  (times marked from the slow-nav tripwire line, matched by node count — the same search, two lines)');
    }
    if (tail.some(r => r.ms == null)) {
      console.log('  (? = this trace predates search time on the path line; a fresh run fills these in)');
    }
  }
  console.log('');

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
  console.log('DEADLINE EVIDENCE — how long the searches that SUCCEEDED actually took:');
  if (!msKnown.length) {
    console.log('  (no search times on complete routes — this trace predates ms on the path line; a fresh run fills it in)');
  } else {
    console.log(`  p50 ${_percentile(msKnown, 0.50)}ms · p90 ${_percentile(msKnown, 0.90)}ms · p99 ${_percentile(msKnown, 0.99)}ms · worst ${msKnown[msKnown.length - 1]}ms`
      + `   (over ${msKnown.length} of ${complete.length} complete route(s))`);
    console.log(`  ▸ NAV_SEARCH_DEADLINE_MS must sit clear of ${msKnown[msKnown.length - 1]}ms — that is the longest a search`);
    console.log('    took and still found a route, so anything at or below it would have cut a good plan short.');
    if (msKnown.length < complete.length) {
      console.log('    (some complete routes carry no time — an older line format; the figure is a floor, not the maximum)');
    }
  }
  console.log('');

  console.log(`▸ THE TUNING NUMBER: the most expensive COMPLETE route this run was ${maxComplete.toFixed(1)}.`);
  console.log(`▸ A tier set anywhere above ${maxComplete.toFixed(1)} preserves EVERY routing choice in this run — the order`);
  console.log('▸ (walk < dig < place < protected) is what decides a route; the magnitude only decides how long a');
  console.log('▸ detour is accepted before the expensive edge wins. Above the longest real route, it decides nothing.');
  console.log(`▸ p99 is ${_percentile(sorted, 0.99).toFixed(1)}, so ${maxComplete > _percentile(sorted, 0.99) * 2 ? 'the max is an outlier — read p99 as the working number' : 'the max and p99 agree; either serves'}.`);
  console.log('▸ ONE RUN IS ONE WORLD. This is evidence from this base at this size, not a universal constant —');
  console.log('▸ re-read it after the base grows, and treat a tier as a decision to revisit, never a settled fact.');
}

module.exports = { runPathfinding, runJumps, runRouteCost };
