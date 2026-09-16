// Auren_Bot/monitoring/farm_lens.js
// HOW THE FARM WENT — the wheat field measured as closely as build_lenses measures the headframe.
//
// WHY A FILE OF ITS OWN. build_lenses keys everything by build SITE and reads one scan shape
// (`"name" — x/y structure placed`). The farm is sixteen row sites that make ONE structure, it is tended as well
// as built, and its progress lives in lines no building writes: the census, the per-row tend report, the seed
// picks. Folding it into the site map would print sixteen near-identical site blocks and still miss the crop.
// So the farm gets one reducer here, and build_lenses.runMilestones prints it after the structures — `--farm`
// prints it alone.
//
// EVERY NUMBER IS READ OFF A LINE THE FLEET WROTE; nothing is inferred from a gap. The lines, and who writes them:
//   ROWS SITED        set_buildspot        `Locked wheat_tine_row#k build site — build_center (x,y,z)`
//   GATED             job_board            `🚧 GATED <gate> (n): <why> → farm_tend#cluster [detail], …`
//   CLAIMED           dispatcher           `Claimed [band] farm/farm_tend …` / `supply/wheat_seeds` / `supply/dirt`
//   CENSUS            farming_integrity    `farm census "wheat_farm" — L/S row(s) laid of N · structure P/T placed, …`
//                                          and the `rows:` line beneath it — the farm's integrity scan
//   TENDED            farm_executor        `farm_executor: <roomKey> struct(place=,dig=) cleared= tilled= planted= …`
//   VISIT             farm_manager         `farm_manager: cluster visit serviced V plot(s) — worked=W refused=R`
//   SEEDS             seed_picker          `Seed pick done: +N wheat_seeds in P/M punch(es) …`
//   PREP              land_prep            hoe crafted/retrieved, seeds and bone meal pulled from a chest
//   BUILT             job_board            `🏁 STRUCTURE BUILT: 'wheat_farm'` (+ STANDING / UN-BUILT)
// A milestone that has not happened is printed as a BOOLEAN FIELD set false in `farm_milestones`, never
// omitted (Law 25) — the latest reading that used to ride alongside the old "NOT YET" phrase is in
// `farm_census_latest`, which prints on every run whether or not the milestone landed.
//
// Seam as build_lenses: inputs as ARGUMENTS, render through data_out, RETURN an empty array. The array
// return is kept because build_lenses.runMilestones iterates renderFarm's result; there are no longer any
// lines in it, since every field goes straight to data_out.
//
// OUTPUT IS DATA, NOT PROSE (Architect 2026-09-16). Field names and values only — no sentence is composed
// here. Values that are strings are COPIED: a gate's own `why` clause, a row key, a seed-pick outcome, a
// bot id, a structure name, a timestamp. See data_out.js for the rule and the reason.

'use strict';

const { relativeTime, PASSIVE_LINE } = require('./trace_read');
const out = require('./data_out');

const LOCK_RE = /Locked (\S+) build site — build_center \(([^)]+)\)/;
const GATED_RE = /🚧 GATED (\S+) \((\d+)\): (.+)$/;
const CLAIM_RE = /Claimed \[[^\]]*\] (farm\/farm_tend|supply\/wheat_seeds|supply\/dirt)\b/;
const CENSUS_RE = /farm census "([^"]+)" — (\d+)\/(\d+) row\(s\) laid of (\d+) · structure (\d+)\/(\d+) placed, (\d+) to dig · crop cells (\d+): (\d+) growing, (\d+) mature, (\d+) tilled unsown, (\d+) untilled, (\d+) blocked/;
const ROWS_RE = /\] 📊 {2,}rows: (.+)$/;
const TEND_RE = /farm_executor: (\S+) struct\(place=(\d+),dig=(\d+)\) cleared=(\d+) tilled=(\d+) planted=(\d+) harvested=(\d+) drops=(\d+)(?: bonemealed=(\d+))?(.*)$/;
const VISIT_RE = /farm_manager: cluster visit serviced (\d+) plot\(s\) — worked=(\d+) refused=(\d+)( \[STUCK)?/;
const SEED_PICK_RE = /Seed pick done: \+(\d+) wheat_seeds in (\d+)\/(\d+) punch\(es\) \(total \d+\) — (.+)\.$/;
// ── WHERE SEEDS COME FROM, AND THE ONE THAT STOPS THEM (Architect 2026-09-16) ────────────────────────
// *"how many total seeds were gotten in the whole run"* — which this lens could not answer: it counted
// PICKING and nothing else, so a reader took the cluster line's `1 reachable` for the run's whole yield.
// That reading was wrong twice over: `reachable` is a STOCK at one instant, already net of everything the
// field had sown, and picking is not the only inflow.
//
// SEED_DROP_RE is drop_collector banking a loose seed — a real second inflow. It carries NO quantity (the
// line is bare), so it is counted as EVENTS and rendered as events; the `Spotted wheat_seeds×N` line that
// precedes it has the number, but a spot is not a pickup and pairing them would be inventing a total.
// NOT SUMMED WITH THE PICK TOTAL, deliberately: seed_picker's `+N` is an inventory delta measured across
// its own trip, so seeds its punches dropped and this collector banked are already inside that number.
// Adding them would double-count, and one confidently wrong total is what this block exists to prevent.
//
// SEED_ORDER_BLOCKED_RE is job_board refusing to post the field's seed order at all for want of a
// registered home chest. It fired 44 times in the 2026-09-16 run — the field wanted 32 seeds and no order
// was ever placed — which is a different fault from "the order was placed and went unfilled" and wants a
// different fix. Nothing surfaced it, so the seed shortage read as slow gathering.
const SEED_DROP_RE = /Picked up wheat_seeds\b/;
const SEED_ORDER_BLOCKED_RE = /farm wants (\d+) seeds but no home chest is registered/;
// How long a repeated condition must stay silent before the lens will call it CLEARED rather than merely
// quiet. Two minutes: long enough that a gap between sweeps cannot pass for a resolution, short enough that
// a condition which really did end early in a 30-minute run is named as ended.
const BLOCK_CLEARED_MARGIN_SEC = 120;
const PUNCH_FAIL_RE = /\[SEED_PICKER\] punch did not clear grass/;
// Needles into farm_executor's own tail and seed_picker's own outcome clause. Regexes rather than quoted
// phrases so a PATTERN is never indistinguishable from authored prose (Architect 2026-09-16).
const NO_SEEDS_RE = /\[no seeds\]/;
const NO_HOE_RE = /\[no hoe\]/;
const STOPPED_SHORT_RE = /^stopped short/;
const PUNCH_BUDGET_RE = /^punch budget/;
const SEED_ORDER_RE = /— (\d+) seeds ordered \((\d+) to sow, (\d+) reachable\)/;
const DIRT_ORDER_RE = /— (\d+) dirt ordered \((\d+) for the rows/;
const HOE_RE = /\[LAND_PREP\] 📊 (Crafted a wooden_hoe|Retrieved \S+ from chest)/;
const PULLED_RE = /\[LAND_PREP\] 📊 Pulled (\d+) (wheat_seeds|bone_meal) from chest/;
const BUILT_RE = /🏁 STRUCTURE BUILT: '([^']+)'/;
const STANDING_RE = /🏠 STRUCTURE STANDING AT FIRST SWEEP: '([^']+)'/;
const UNBUILT_RE = /STRUCTURE UN-BUILT: '([^']+)'/;

const FARM_JOB_IDS = ['farm_tend#cluster', 'farm_supply_dirt', 'farm_supply_seeds'];

function farmNames() {
  const cfg = require(require('./lens_paths').bot('Thinking_fragments/architect_config.js'));
  return { structure: cfg.FARM_STRUCTURE, rowPrefix: cfg.FARM_BLUEPRINT_NAME, rows: cfg.FARM_ROOM_KEYS.length, alpha: 'headframe' };
}

function reduceFarm(seg, botFilter) {
  const names = farmNames();
  const f = {
    names, maxRel: 0,
    sited: { count: 0, keys: new Set(), first: null, last: null, by: null },
    gates: new Map(),            // gate → { posts, first, last, why }
    claims: new Map(),           // label → { n, first, by: Map(bot→n) }
    census: { first: null, latest: null, rowsLaid: [], firstPlaced: null, firstSown: null, firstMature: null, maxGrowing: 0, maxMature: 0 },
    rowsLine: null,
    tend: { visits: 0, rows: new Map(), bots: new Map(), totals: null, noSeeds: 0, noHoe: 0, refused: 0, firstTill: null, firstPlant: null, firstHarvest: null },
    cluster: { visits: 0, stuck: 0, worked: 0, refused: 0 },
    seeds: { picks: 0, gained: 0, punches: 0, outcomes: new Map(), punchFails: 0, pulled: 0, latestOrder: null,
             drops: 0, blocked: 0, blockedWant: null, blockedFirst: null, blockedLast: null },
    dirt: { latestOrder: null },
    tools: { hoeCrafted: 0, hoeRetrieved: 0, boneMealPulled: 0 },
    built: null, standing: null, unbuilt: [], alphaBuilt: null, alphaStanding: null,
  };
  const zero = () => ({ place: 0, dig: 0, cleared: 0, tilled: 0, planted: 0, harvested: 0, drops: 0, bonemealed: 0, visits: 0 });
  f.tend.totals = zero();

  // ONE CLOCK FOR THE WHOLE FLEET. A line's [Nm Ss] tag counts from its own bot's birth, so two bots' tags are two
  // clocks, and a delta between events on different bots (the headframe built by one, the first farm claim by the
  // other) came out negative. Every time here is wall-clock seconds from the first stamped line in the run.
  let baseMs = null;
  for (const l of seg) { const ms = l.iso ? Date.parse(l.iso) : NaN; if (!Number.isNaN(ms)) { baseMs = ms; break; } }
  for (const l of seg) {
    if (l.relSec == null) continue;
    if (botFilter && l.bot !== botFilter) continue;
    if (PASSIVE_LINE.test(l.raw)) continue;
    const ms = l.iso ? Date.parse(l.iso) : NaN;
    const t = (baseMs !== null && !Number.isNaN(ms)) ? Math.round((ms - baseMs) / 1000) : l.relSec;
    f.maxRel = Math.max(f.maxRel, t);
    let m;
    if ((m = l.raw.match(LOCK_RE)) && m[1].startsWith(names.rowPrefix)) {
      const s = f.sited;
      if (!s.keys.has(m[1])) { s.keys.add(m[1]); s.count++; if (s.first === null) { s.first = t; s.by = l.bot; } s.last = t; }
    } else if ((m = l.raw.match(GATED_RE))) {
      if (!FARM_JOB_IDS.some(id => m[3].includes(id))) continue;
      const g = f.gates.get(m[1]) || { posts: 0, first: null, last: null, why: null };
      g.posts++; if (g.first === null) g.first = t; g.last = t;
      // Keep the clause that names a farm job, so the reader sees WHY the farm was held, not the whole board.
      g.why = m[3].split(' · ').filter(part => FARM_JOB_IDS.some(id => part.includes(id))).join(' · ');
      f.gates.set(m[1], g);
    } else if ((m = l.raw.match(CLAIM_RE))) {
      const c = f.claims.get(m[1]) || { n: 0, first: null, firstBy: null, by: new Map() };
      c.n++; if (c.first === null) { c.first = t; c.firstBy = l.bot; }
      c.by.set(l.bot, (c.by.get(l.bot) || 0) + 1);
      f.claims.set(m[1], c);
    } else if ((m = l.raw.match(CENSUS_RE))) {
      const r = { t, bot: l.bot, laid: +m[2], sitedRows: +m[3], of: +m[4], placed: +m[5], structTotal: +m[6], digs: +m[7],
        cells: +m[8], growing: +m[9], mature: +m[10], tilledUnsown: +m[11], untilled: +m[12], blocked: +m[13] };
      const c = f.census;
      if (!c.first) c.first = r;
      const best = c.rowsLaid.length ? c.rowsLaid[c.rowsLaid.length - 1].laid : 0;
      // A row is recorded LAID the first time the census count rises past every earlier reading. Two bots scan
      // the same field, so a lower count from a later line is a stale view, not a row coming undone — that
      // event is job_board's UN-BUILT line, read separately below.
      if (r.laid > best) c.rowsLaid.push({ t, laid: r.laid, of: r.sitedRows, by: l.bot });
      if (!c.firstPlaced && r.placed > 0) c.firstPlaced = r;
      if (!c.firstSown && (r.growing + r.mature) > 0) c.firstSown = r;
      if (!c.firstMature && r.mature > 0) c.firstMature = r;
      c.maxGrowing = Math.max(c.maxGrowing, r.growing);
      c.maxMature = Math.max(c.maxMature, r.mature);
      c.latest = r;
    } else if ((m = l.raw.match(ROWS_RE)) && l.raw.includes('[FARMING_INTEGRITY]')) {
      f.rowsLine = { t, text: m[1] };
    } else if ((m = l.raw.match(TEND_RE))) {
      const add = (o) => {
        o.place += +m[2]; o.dig += +m[3]; o.cleared += +m[4]; o.tilled += +m[5]; o.planted += +m[6];
        o.harvested += +m[7]; o.drops += +m[8]; o.bonemealed += +(m[9] || 0); o.visits++;
      };
      const tend = f.tend;
      tend.visits++;
      add(tend.totals);
      if (!tend.rows.has(m[1])) tend.rows.set(m[1], zero());
      add(tend.rows.get(m[1]));
      if (!tend.bots.has(l.bot)) tend.bots.set(l.bot, zero());
      add(tend.bots.get(l.bot));
      const tail = m[10] || '';
      if (NO_SEEDS_RE.test(tail)) tend.noSeeds++;
      if (NO_HOE_RE.test(tail)) tend.noHoe++;
      for (const r of tail.matchAll(/refused x(\d+)/g)) tend.refused += +r[1];
      if (tend.firstTill === null && +m[5] > 0) tend.firstTill = { t, by: l.bot, row: m[1] };
      if (tend.firstPlant === null && +m[6] > 0) tend.firstPlant = { t, by: l.bot, row: m[1] };
      if (tend.firstHarvest === null && +m[7] > 0) tend.firstHarvest = { t, by: l.bot, row: m[1] };
    } else if ((m = l.raw.match(VISIT_RE))) {
      f.cluster.visits++; f.cluster.worked += +m[2]; f.cluster.refused += +m[3]; if (m[4]) f.cluster.stuck++;
    } else if ((m = l.raw.match(SEED_PICK_RE))) {
      const s = f.seeds;
      s.picks++; s.gained += +m[1]; s.punches += +m[2];
      // The outcome is a TOKEN, not a sentence. Two of these three used to be phrases this lens wrote
      // for a condition it recognised by prefix; they are now names for the same three branches, and the
      // needles that pick the branch are regexes like every other pattern in this file.
      const outcome = STOPPED_SHORT_RE.test(m[4]) ? 'stopped_short'
        : PUNCH_BUDGET_RE.test(m[4]) ? 'punch_budget_spent'
        : 'order_filled_early';
      s.outcomes.set(outcome, (s.outcomes.get(outcome) || 0) + 1);
    } else if (SEED_DROP_RE.test(l.raw)) {
      f.seeds.drops++;
    } else if ((m = l.raw.match(SEED_ORDER_BLOCKED_RE))) {
      f.seeds.blocked++; f.seeds.blockedWant = +m[1];
      if (f.seeds.blockedFirst === null) f.seeds.blockedFirst = t;
      f.seeds.blockedLast = t;
    } else if (PUNCH_FAIL_RE.test(l.raw)) {
      f.seeds.punchFails++;
    } else if ((m = l.raw.match(HOE_RE))) {
      if (m[1].startsWith('Crafted')) f.tools.hoeCrafted++; else f.tools.hoeRetrieved++;
    } else if ((m = l.raw.match(PULLED_RE))) {
      if (m[2] === 'wheat_seeds') f.seeds.pulled += +m[1]; else f.tools.boneMealPulled += +m[1];
    } else if ((m = l.raw.match(BUILT_RE))) {
      if (m[1] === names.structure && !f.built) f.built = { t, by: l.bot };
      if (m[1] === names.alpha && !f.alphaBuilt) f.alphaBuilt = { t, by: l.bot };
    } else if ((m = l.raw.match(STANDING_RE)) && (m[1] === names.structure || m[1] === names.alpha)) {
      if (m[1] === names.structure && !f.standing) f.standing = { t, by: l.bot };
      if (m[1] === names.alpha && !f.alphaStanding) f.alphaStanding = { t, by: l.bot };
    } else if ((m = l.raw.match(UNBUILT_RE)) && m[1] === names.structure) {
      f.unbuilt.push({ t, by: l.bot });
    }
    // The cluster line carries the live orders; read them off whichever line has them, latest wins.
    if ((m = l.raw.match(SEED_ORDER_RE))) f.seeds.latestOrder = { t, order: +m[1], toSow: +m[2], reachable: +m[3] };
    if ((m = l.raw.match(DIRT_ORDER_RE))) f.dirt.latestOrder = { t, order: +m[1], planned: +m[2] };
  }
  return f;
}

function renderFarm(f, { verbose = false } = {}) {
  const { names } = f;
  // A time that never happened is a null, which data_out prints as its ABSENT mark — never as 0m 0s, which
  // would read as "at the very start of the run".
  const at = t => (t == null ? null : relativeTime(t));
  // A negative gap is two bots' boards seeing one event at different moments (on a continued world one bot finds the
  // headframe STANDING and works the farm before the other's board writes BUILT), so no delta is printed for it.
  const since = (t, from) => (from != null && t != null && t >= from ? relativeTime(t - from) : null);

  out.kv('structure', names.structure);
  out.kv('rows_in_design', names.rows);
  out.kv('alpha_structure', names.alpha);

  // A reading taken off the FIRST census of the run is not an event of this run — on a carried world it is the state
  // the field was found in. It is carried under its own `census_found` event token, never as a `first_*` one, or a
  // standing farm reads as one built in 14s.
  const c = f.census;
  const found = r => c.first && r && r.t === c.first.t;

  // THE TIMELINE IS SORTED BY FLEET TIME, NOT PRINTED IN THE ORDER IT IS ASSEMBLED. Each event is found by its own
  // reducer field, so printing field by field put a 2m 19s claim above a 0m 14s census reading. Rows collect as
  // [t, event, detail, bot, since_prev_row_laid] and print in time order.
  //
  // `event` values are tokens, `detail` and `bot` are values read off the record. What a milestone MEANS, and
  // whether it happened at all, is no longer written here: the boolean is in farm_milestones below.
  const rows = [];
  const event = (t, name, detail = null, bot = null, gap = null) => { if (t != null) rows.push([t, name, detail, bot, gap]); };

  if (f.sited.count) {
    event(f.sited.first, 'rows_sited_first', f.sited.count, f.sited.by);
    if (f.sited.last !== f.sited.first) event(f.sited.last, 'rows_sited_last', f.sited.count, f.sited.by);
  }
  // The gate's own posts/last/why are in farm_gates; the timeline carries only when it first fired.
  for (const [gate, g] of f.gates) event(g.first, 'gated', gate);
  if (f.alphaStanding) event(f.alphaStanding.t, 'alpha_standing_at_first_sweep', names.alpha, f.alphaStanding.by);
  if (f.alphaBuilt) event(f.alphaBuilt.t, 'alpha_built', names.alpha, f.alphaBuilt.by);

  const tendClaim = f.claims.get('farm/farm_tend');
  if (tendClaim) event(tendClaim.first, 'first_farm_claim', 'farm/farm_tend', tendClaim.firstBy);

  if (c.first) event(c.first.t, 'census_found', c.first.laid, c.first.bot);
  if (c.firstPlaced && !found(c.firstPlaced)) event(c.firstPlaced.t, 'first_block_placed', c.firstPlaced.placed, c.firstPlaced.bot);

  // Every row that came in DURING the run, in order. Collapsed past eight rows unless --all, keeping the first and
  // last three, because the pace between rows is the question and the middle of a steady run repeats it.
  const laid = c.rowsLaid.filter(r => !(c.first && r.t === c.first.t));
  const shown = verbose || laid.length <= 8 ? laid : [...laid.slice(0, 3), null, ...laid.slice(-3)];
  let prev = null;
  for (const r of shown) {
    if (r === null) { event(prev.t, 'rows_omitted', laid.length - 6); prev = null; continue; }
    event(r.t, 'row_laid', r.laid, r.by, prev ? relativeTime(r.t - prev.t) : null);
    prev = r;
  }

  if (f.tend.firstTill) event(f.tend.firstTill.t, 'first_ground_tilled', f.tend.firstTill.row, f.tend.firstTill.by);
  if (c.firstSown && !found(c.firstSown)) event(c.firstSown.t, 'first_crop_in_ground', c.firstSown.growing);
  else if (!c.firstSown && f.tend.firstPlant) event(f.tend.firstPlant.t, 'first_seed_planted', f.tend.firstPlant.row, f.tend.firstPlant.by);
  if (c.firstMature && !found(c.firstMature)) event(c.firstMature.t, 'first_crop_mature', c.firstMature.mature);
  if (f.tend.firstHarvest) event(f.tend.firstHarvest.t, 'first_harvest', f.tend.firstHarvest.row, f.tend.firstHarvest.by);

  if (f.built) event(f.built.t, 'farm_built', names.structure, f.built.by);
  else if (f.standing) event(f.standing.t, 'farm_standing_at_first_sweep', names.structure, f.standing.by);
  for (const u of f.unbuilt) event(u.t, 'farm_unbuilt', names.structure, u.by);

  rows.sort((a, b) => a[0] - b[0]);   // Array.prototype.sort is stable, so same-instant events keep assembly order
  out.section('farm_timeline');
  out.table(['at', 'event', 'detail', 'bot', 'since_prev_row_laid'],
    rows.map(r => [at(r[0]), r[1], r[2], r[3], r[4]]));

  // What HAPPENED and what did not, as booleans. This replaces the NOT YET lines, each of which was a
  // sentence about an absence; an absence is `false` (Law 25 — the reading is still printed, below).
  out.section('farm_milestones');
  out.kv('rows_sited', f.sited.count > 0);
  out.kv('farm_tend_claimed', !!tendClaim);
  out.kv('block_placed', !!c.firstPlaced);
  out.kv('row_laid_this_run', laid.length > 0);
  out.kv('crop_in_ground', !!c.firstSown);
  out.kv('crop_mature', !!c.firstMature);
  out.kv('harvested', !!f.tend.firstHarvest);
  out.kv('farm_built', !!f.built);
  out.kv('standing_at_first_sweep', !!f.standing);
  out.kv('farm_unbuilt_events', f.unbuilt.length);
  out.kv('census_lines_seen', c.latest ? true : false);

  // The deltas the timeline used to carry as `⇒ 3m 2s after the headframe was built`. Same numbers, named
  // by their two endpoints instead of by a clause.
  out.section('farm_intervals');
  out.kv('claim_after_alpha_built', tendClaim && f.alphaBuilt ? since(tendClaim.first, f.alphaBuilt.t) : null);
  out.kv('built_after_alpha_built', f.built && f.alphaBuilt ? since(f.built.t, f.alphaBuilt.t) : null);
  out.kv('built_after_rows_sited', f.built ? since(f.built.t, f.sited.first) : null);

  if (f.gates.size) {
    // `why` is the board's own clause, copied verbatim — the lens never says why a gate held.
    out.section('farm_gates');
    out.table(['gate', 'posts', 'first_at', 'last_at', 'why'],
      [...f.gates].map(([gate, g]) => [gate, g.posts, at(g.first), at(g.last), g.why]));
  } else {
    out.zero('farm_gate_posts');
  }

  if (c.first) {
    out.section('farm_census_first');
    out.kv('at', at(c.first.t));
    out.kv('bot', c.first.bot);
    out.kv('rows_laid', c.first.laid);
    out.kv('rows_sited', c.first.sitedRows);
    out.kv('structure_placed', c.first.placed);
    out.kv('structure_total', c.first.structTotal);
    out.kv('growing', c.first.growing);
    out.kv('mature', c.first.mature);
  }

  if (c.latest) {
    const L = c.latest;
    out.section('farm_census_latest');
    out.kv('at', at(L.t));
    out.kv('bot', L.bot);
    out.kv('rows_laid', L.laid);
    out.kv('rows_in_design', names.rows);
    out.kv('structure_placed', L.placed);
    out.kv('structure_total', L.structTotal);
    out.kv('to_dig', L.digs);
    out.kv('crop_cells', L.cells);
    out.kv('growing', L.growing);
    out.kv('mature', L.mature);
    out.kv('tilled_unsown', L.tilledUnsown);
    out.kv('untilled', L.untilled);
    out.kv('blocked', L.blocked);
    out.kv('peak_growing_this_run', c.maxGrowing);
    out.kv('peak_mature_this_run', c.maxMature);
  }

  if (f.rowsLine) {
    // farming_integrity's own per-row cells, one value per row, copied whole.
    out.section('farm_rows_scan');
    out.kv('at', at(f.rowsLine.t));
    out.list('row', f.rowsLine.text.split(' | '));
  }

  const T = f.tend.totals;
  out.section('farm_work_done');
  out.kv('row_visits', f.tend.visits);
  out.kv('rows_visited', f.tend.rows.size);
  out.kv('placed', T.place);
  out.kv('dug', T.dig);
  out.kv('cleared', T.cleared);
  out.kv('tilled', T.tilled);
  out.kv('planted', T.planted);
  out.kv('harvested', T.harvested);
  out.kv('drops', T.drops);
  out.kv('bonemealed', T.bonemealed);
  out.kv('refused_acts', f.tend.refused);
  out.kv('visits_with_no_seeds', f.tend.noSeeds);
  out.kv('visits_with_no_hoe', f.tend.noHoe);

  if (f.tend.bots.size) {
    out.section('farm_work_by_bot');
    out.table(['bot', 'visits', 'placed', 'tilled', 'planted', 'harvested'],
      [...f.tend.bots].map(([bot, b]) => [bot, b.visits, b.place, b.tilled, b.planted, b.harvested]));
  }
  if (verbose && f.tend.rows.size) {
    out.section('farm_work_by_row');
    out.table(['row', 'visits', 'placed', 'dug', 'tilled', 'planted', 'harvested'],
      [...f.tend.rows].map(([row, r]) => [row, r.visits, r.place, r.dig, r.tilled, r.planted, r.harvested]));
  }

  out.section('farm_cluster_visits');
  out.kv('visits', f.cluster.visits);
  out.kv('worked', f.cluster.worked);
  out.kv('refused', f.cluster.refused);
  out.kv('stuck', f.cluster.stuck);

  // supply/dirt is every structure's dirt and not only the farm's — that qualification is a sentence about
  // the number and was deleted; the job id in the `job` column is what says which order it is.
  const CLAIM_KEYS = ['farm/farm_tend', 'supply/wheat_seeds', 'supply/dirt'];
  out.section('farm_jobs_claimed');
  out.table(['job', 'claims', 'first_at', 'first_by'],
    CLAIM_KEYS.map(k => {
      const x = f.claims.get(k);
      return [k, x ? x.n : 0, x ? at(x.first) : null, x ? x.firstBy : null];
    }));
  const byBot = [];
  for (const k of CLAIM_KEYS) {
    const x = f.claims.get(k);
    if (x) for (const [bot, n] of x.by) byBot.push([k, bot, n]);
  }
  if (byBot.length) {
    out.section('farm_claims_by_bot');
    out.table(['job', 'bot', 'claims'], byBot);
  }

  const S = f.seeds;
  out.section('farm_seeds');
  out.kv('pick_trips', S.picks);
  out.kv('seeds_gained', S.gained);
  out.kv('punches', S.punches);
  out.kv('punches_cleared_nothing', S.punchFails);
  out.kv('seeds_pulled_from_chest', S.pulled);
  // Events, not a quantity — the pickup line carries no number. Not added to the pick total: see
  // SEED_DROP_RE's header for why summing them would double-count. The sentence that used to say so on
  // the terminal is deleted; the field name says it is a pickup count and the comment holds the reason.
  out.kv('loose_seed_pickups', S.drops);

  if (S.outcomes.size) {
    // The outcome token is the pick line's own tail, carried through the reducer untouched.
    out.section('farm_seed_pick_outcomes');
    out.table(['outcome', 'count'], [...S.outcomes].map(([k, n]) => [k, n]));
  } else {
    out.zero('farm_seed_pick_outcomes');
  }

  // ── A COUNT WITHOUT ITS WINDOW IS A TRAP, AND THIS ONE SPRANG (Architect 2026-09-16) ──────────────
  // This printed `SEED ORDER BLOCKED 44×` and nothing else, and it was read — by the session that wrote
  // it — as "no seed order was ever placed all run". Every one of those 44 sweeps fell between 0m 0s and
  // 4m 57s, before the crew had built and registered a chest to deliver to. The window and the cleared
  // flag are what stop that misreading, so both are fields; the sentences that used to explain them
  // ("then CLEARED and never returned", "STILL BLOCKED at the end of the run", and the reason line) are
  // DELETED rather than reworded — the reader draws the conclusion from first_at, last_at and cleared.
  if (S.blocked) {
    // "Cleared" means the condition stopped recurring well before the record ends — not merely that one
    // more line followed it. The margin is what separates "it resolved" from "it happened to be quiet".
    out.section('farm_seed_order_blocked');
    out.kv('posts', S.blocked);
    out.kv('seeds_wanted', S.blockedWant);
    out.kv('first_at', at(S.blockedFirst));
    out.kv('last_at', at(S.blockedLast));
    out.kv('cleared', S.blockedLast !== null && (f.maxRel - S.blockedLast) >= BLOCK_CLEARED_MARGIN_SEC);
  } else {
    out.zero('farm_seed_order_blocked');
  }

  // ── A GAUGE, AND IT SAYS SO IN ITS FIELD NAME (Architect 2026-09-16) ──────────────────────────────
  // `reachable` is inventory_lens.reachableByFleet at ONE INSTANT — stock on hand, already net of every
  // seed the field has put in the ground. It read `1 reachable` here and was reported as "the run only
  // ever got 1 seed", when the run had gained 21 by picking and sown 30. A level and a total are different
  // kinds of number, so the field name carries which kind this is (`..._at_last_sweep`) and the old
  // parenthetical gloss plus the pointer back to the pick line are deleted.
  if (S.latestOrder) {
    out.section('farm_seed_stock');
    out.kv('last_sweep_at', at(S.latestOrder.t));
    out.kv('seeds_on_hand_at_last_sweep', S.latestOrder.reachable);
    out.kv('seeds_to_sow_at_last_sweep', S.latestOrder.toSow);
    out.kv('seeds_ordered_at_last_sweep', S.latestOrder.order);
  }

  if (f.dirt.latestOrder) {
    out.section('farm_dirt');
    out.kv('last_order_at', at(f.dirt.latestOrder.t));
    out.kv('dirt_ordered', f.dirt.latestOrder.order);
    out.kv('dirt_for_rows', f.dirt.latestOrder.planned);
  }

  out.section('farm_tools');
  out.kv('hoe_crafted', f.tools.hoeCrafted);
  out.kv('hoe_retrieved', f.tools.hoeRetrieved);
  out.kv('bone_meal_pulled', f.tools.boneMealPulled);

  // Nothing left to hand back: every field went to data_out. The empty array keeps build_lenses'
  // `for (const line of renderFarm(...))` loop valid without reaching into that file.
  return [];
}

// --farm: the farm alone. --milestones prints the same block after the structures through renderFarm.
function runFarm({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const f = reduceFarm(seg, botFilter);
  out.kv('lens', 'farm');
  out.kv('record', traceName);
  out.kv('span', relativeTime(f.maxRel));
  if (botFilter) out.kv('bot_filter', botFilter);
  // DELETED: "(context only — never flags, never wakes)". That is a claim about what this lens is for,
  // which is documentation, not a reading — it lives in the header comment above and in LENSES.md.
  renderFarm(f, { verbose });
}

module.exports = { reduceFarm, renderFarm, runFarm };
