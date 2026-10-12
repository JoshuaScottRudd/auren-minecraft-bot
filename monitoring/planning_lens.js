// Auren_Bot/monitoring/planning_lens.js
// How busy the planning token is, and how long a body waits for its turn at it.
//
// The measurement is already on the trace, three lines from `foreman_link`, each carrying an ISO stamp
// and written by the body it describes:
//   REQUEST  `Requested planning token.`                    — the body wants to think
//   GRANT    `Planning token granted — plan phase is ours.`  — the body may think
//   RELEASE  `Released planning token.`                      — the body has stopped thinking
// WAIT is request→grant and PLAN is grant→release.
//
// Utilisation, not wait, states whether the token is the fleet's binding constraint: the token is a
// single server, so the fraction of the run during which somebody holds it is the fraction of capacity
// spent. Utilisation is measured as a union of held intervals, not a sum — a sum can exceed the run span
// once two grants overlap, which happens when the foreman's TTL frees a token that was never released. A
// union answers whether anybody was thinking at each instant, and keeps the figure at or under 100%.
//
// `budget_sec` is a supplied criterion, reported beside a count of the plans that exceeded it (Law 25);
// this lens passes no verdict of its own.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --planning [--bot=AurenBot] [--budget=0.5]

'use strict';

const { relativeTime, percent } = require('./report_formatting');
const { FOREMAN_UNITS } = require('./trace_read');
const out = require('./data_out');

// The default budget, applied so a flagless run still prints the column.
const DEFAULT_BUDGET_SEC = 0.5;

// Matches each line on its stable prefix, stopping short of the trailing clause after the em-dash.
const REQ   = /\[FOREMAN_LINK\][^]*?Requested planning token/;
const GRANT = /\[FOREMAN_LINK\][^]*?Planning token granted/;
const REL   = /\[FOREMAN_LINK\][^]*?Released planning token/;
// The foreman states the queue depth, tagged FOREMAN_BRAIN; the waiting bot's name sits inside the text,
// not the line's unit tag.
const QUEUED = /\[FOREMAN_BRAIN\][^]*?'([A-Za-z0-9_]+)' queued for planning token \((\d+) waiting\)/;

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

// reduceTokenUnion — total wall time during which ANY body held the token, as a union of intervals.
// Intervals arrive per bot and therefore unsorted overall; sorting and merging is the whole of it.
function reduceTokenUnion(intervals) {
  if (!intervals.length) return { unionMs: 0, spanMs: 0, firstMs: null, lastMs: null };
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  let unionMs = 0, curFrom = sorted[0].from, curTo = sorted[0].to;
  for (const iv of sorted.slice(1)) {
    if (iv.from <= curTo) { curTo = Math.max(curTo, iv.to); continue; }
    unionMs += curTo - curFrom;
    curFrom = iv.from; curTo = iv.to;
  }
  unionMs += curTo - curFrom;
  return { unionMs, firstMs: sorted[0].from, lastMs: Math.max(...sorted.map(i => i.to)) };
}

function reducePlanning({ seg = [], bot: botFilter = null, budgetSec = DEFAULT_BUDGET_SEC } = {}) {
  const perBot = new Map();
  const seat = (b) => {
    if (!perBot.has(b)) {
      perBot.set(b, {
        bot: b, requests: 0, grants: 0, releases: 0,
        waitMs: 0, worstWaitMs: 0, worstWaitAt: null,
        planMs: 0, worstPlanMs: 0, worstPlanAt: null,
        overBudget: 0, queued: 0,
        // The open half of each pair. A request with no grant, or a grant with no release, is a real
        // state — the run ended mid-plan, or the foreman's TTL freed the token — and is counted as time
        // spent waiting or planning.
        openReqMs: null, openGrantMs: null,
        danglingReq: 0, danglingGrant: 0,
      });
    }
    return perBot.get(b);
  };

  const intervals = [];
  const depths = new Map();          // queue depth → how many times the foreman reported it
  const planSamples = [];            // every plan duration, for the percentile row
  const waitSamples = [];
  let runFirstMs = null, runLastMs = null;

  for (const l of seg) {
    const t = l.iso ? ms(l.iso) : null;
    if (t != null) { if (runFirstMs == null || t < runFirstMs) runFirstMs = t; if (runLastMs == null || t > runLastMs) runLastMs = t; }

    // Read first: this line is tagged FOREMAN_BRAIN, carries no bot unit, and would be dropped by the
    // botFilter test below — it is the only source for the queue depth distribution.
    let m;
    if ((m = QUEUED.exec(l.raw))) {
      if (!botFilter || m[1] === botFilter) {
        depths.set(Number(m[2]), (depths.get(Number(m[2])) || 0) + 1);
        seat(m[1]).queued++;
      }
      continue;
    }

    if (!l.bot || FOREMAN_UNITS.has(l.bot)) continue;
    if (botFilter && l.bot !== botFilter) continue;
    if (t == null) continue;         // no clock on this line — it cannot contribute a duration

    if (REQ.test(l.raw)) {
      const s = seat(l.bot);
      s.requests++;
      // A second request with the first still open means the grant was never logged; counted as a
      // dangling request so the mean wait is not computed over a silently shrunk set.
      if (s.openReqMs != null) s.danglingReq++;
      s.openReqMs = t;
      continue;
    }
    if (GRANT.test(l.raw)) {
      const s = seat(l.bot);
      s.grants++;
      if (s.openReqMs != null) {
        const w = Math.max(0, t - s.openReqMs);
        s.waitMs += w; waitSamples.push(w);
        if (w > s.worstWaitMs) { s.worstWaitMs = w; s.worstWaitAt = l.relSec; }
        s.openReqMs = null;
      }
      if (s.openGrantMs != null) s.danglingGrant++;
      s.openGrantMs = t;
      continue;
    }
    if (REL.test(l.raw)) {
      const s = seat(l.bot);
      s.releases++;
      if (s.openGrantMs != null) {
        const p = Math.max(0, t - s.openGrantMs);
        s.planMs += p; planSamples.push(p);
        if (p > s.worstPlanMs) { s.worstPlanMs = p; s.worstPlanAt = l.relSec; }
        if (p > budgetSec * 1000) s.overBudget++;
        intervals.push({ from: s.openGrantMs, to: t });
        s.openGrantMs = null;
      }
    }
  }

  const rows = [...perBot.values()].sort((a, b) => b.waitMs - a.waitMs);
  const union = reduceTokenUnion(intervals);
  // The denominator is the whole run span; idle time counts toward it, so a fleet that stopped planning
  // shows as lower utilisation.
  const spanMs = (runFirstMs != null && runLastMs != null) ? runLastMs - runFirstMs : 0;

  const pct = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };

  const fleet = rows.reduce((acc, r) => ({
    requests: acc.requests + r.requests, grants: acc.grants + r.grants, releases: acc.releases + r.releases,
    waitMs: acc.waitMs + r.waitMs, planMs: acc.planMs + r.planMs,
    overBudget: acc.overBudget + r.overBudget, queued: acc.queued + r.queued,
    danglingReq: acc.danglingReq + r.danglingReq, danglingGrant: acc.danglingGrant + r.danglingGrant,
  }), { requests: 0, grants: 0, releases: 0, waitMs: 0, planMs: 0, overBudget: 0, queued: 0, danglingReq: 0, danglingGrant: 0 });

  return {
    rows, fleet, depths, spanMs, budgetSec,
    unionMs: union.unionMs,
    planSamples, waitSamples,
    planP50: pct(planSamples, 50), planP90: pct(planSamples, 90), planP99: pct(planSamples, 99),
    waitP50: pct(waitSamples, 50), waitP90: pct(waitSamples, 90), waitP99: pct(waitSamples, 99),
    // The ceiling one planning server imposes: at the median service time, this many plans per minute is
    // all the fleet can reach, however many bodies are added.
    plansPerMinCeiling: pct(planSamples, 50) > 0 ? 60000 / pct(planSamples, 50) : null,
    seen: rows.length > 0,
  };
}

const dur = (msv) => `${(msv / 1000).toFixed(2)}s`;

function runPlanning({ seg = [], traceName = '?', bot: botFilter = null, budgetSec = DEFAULT_BUDGET_SEC } = {}) {
  const r = reducePlanning({ seg, bot: botFilter, budgetSec });
  out.kv('lens', 'planning');
  out.kv('record', traceName);
  out.kv('bot_filter', botFilter);
  out.kv('budget_sec', budgetSec);
  if (!r.seen) { out.kv('planning_traffic', 'absent'); return r; }

  out.section('congestion');
  out.kv('run_span', relativeTime(Math.round(r.spanMs / 1000)));
  out.kv('bodies', r.rows.length);
  out.kv('plans_requested', r.fleet.requests);
  out.kv('plans_granted', r.fleet.grants);
  out.kv('plans_released', r.fleet.releases);
  out.kv('plans_queued_behind_a_peer', r.fleet.queued);
  out.kv('queued_share', percent(r.fleet.queued, r.fleet.requests));
  // The single-server occupancy. See the header: union, not sum, and over the whole run.
  out.kv('token_held_union', dur(r.unionMs));
  out.kv('token_utilisation', percent(r.unionMs, r.spanMs));
  out.kv('fleet_wait_total', dur(r.fleet.waitMs));
  out.kv('fleet_plan_total', dur(r.fleet.planMs));
  out.kv('wait_to_plan_ratio', r.fleet.planMs ? (r.fleet.waitMs / r.fleet.planMs).toFixed(2) : null);
  out.kv('plans_over_budget', r.fleet.overBudget);
  out.kv('over_budget_share', percent(r.fleet.overBudget, r.fleet.releases));
  out.kv('plans_per_min_ceiling', r.plansPerMinCeiling == null ? null : r.plansPerMinCeiling.toFixed(1));
  out.kv('plans_per_min_actual', r.spanMs ? (r.fleet.releases / (r.spanMs / 60000)).toFixed(1) : null);
  // Unpaired halves, reported so a mean is never taken silently over a smaller set.
  out.kv('requests_never_granted', r.fleet.danglingReq);
  out.kv('grants_never_released', r.fleet.danglingGrant);

  out.section('plan_duration');
  out.kv('p50', dur(r.planP50));
  out.kv('p90', dur(r.planP90));
  out.kv('p99', dur(r.planP99));
  out.section('wait_duration');
  out.kv('p50', dur(r.waitP50));
  out.kv('p90', dur(r.waitP90));
  out.kv('p99', dur(r.waitP99));

  out.section('queue_depth');
  out.table(['waiting', 'times_reported'],
    [...r.depths.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => [d, c]));

  out.section('by_bot');
  out.table(
    ['bot', 'plans', 'wait_total', 'wait_mean', 'wait_worst', 'wait_worst_at',
      'plan_total', 'plan_mean', 'plan_worst', 'plan_worst_at', 'over_budget', 'queued'],
    r.rows.map(b => [
      b.bot, b.releases,
      dur(b.waitMs), dur(b.grants ? b.waitMs / b.grants : 0), dur(b.worstWaitMs), relativeTime(b.worstWaitAt),
      dur(b.planMs), dur(b.releases ? b.planMs / b.releases : 0), dur(b.worstPlanMs), relativeTime(b.worstPlanAt),
      b.overBudget, b.queued,
    ]),
  );
  return r;
}

module.exports = { reducePlanning, runPlanning, reduceTokenUnion, DEFAULT_BUDGET_SEC };
