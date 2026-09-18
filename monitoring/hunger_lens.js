// Auren_Bot/monitoring/hunger_lens.js
// WHAT A RUN COST THE BOT IN FOOD, and what it would take to feed that pace forever.
//
// ── THE ASK (Architect 2026-09-17) ──────────────────────────────────────────────────────────────────
// *"i want to do a hunger calculator. so make me a calculator that calculates food drain exactly by
// taking a full 30 minute watcher trace and calculate how much time is spent moving, digging and other
// things. everything should be there. then the bots always eat bread so then calculate how much bread is
// needed to sustain one bot indefinitely if it moves at that pace and how many wheat plots that would
// take. all plots are alternating rows so no penalty."*
//
// ── THE ONE THING THAT DECIDES EVERY NUMBER BELOW: HUNGER IS NOT A CLOCK ────────────────────────────
// Minecraft does not drain food over TIME. It drains food over EXHAUSTION, and exhaustion is generated
// by a fixed list of ACTS, each with a fixed price. The whole model is:
//
//     exhaustion >= 4.0  ->  subtract 4.0, and spend one point of saturation;
//                            saturation already 0  ->  spend one point of the food bar instead.
//
// So a bot that stands still for an hour loses nothing, and a bot that walks for an hour ALSO loses
// nothing — WALKING IS PRICED AT ZERO. Only sprinting is priced per metre. That is why this lens reports
// the time census the Architect asked for and then prices the run off the EVENT census beside it: the
// time census answers "where did the run go", and the event census is the only thing that answers "what
// did it cost". Printing one without the other would let a reader conclude that half a run spent walking
// is half a run spent eating, which is false by a factor of infinity.
//
// ── WHICH LINE OWNS WHICH ACT (the whitelist, and why it is a whitelist) ────────────────────────────
// `performDig` is the fleet's ONE dig authority and it writes NOTHING on a successful swing (it warns
// only on a refusal), so there is no per-dig event on the trace to count. The digs are recoverable
// anyway, because every caller folds its own count into a summary line. Each source below is named with
// the file that emits it, and the set is chosen so NO ACT IS COUNTED TWICE — the restating lines are
// listed in the second table and deliberately not summed:
//
//   COUNTED                                            EMITTER
//   `Dug down to (x,y,z).`                             navigator.digDownStep — 1 block, and it is the
//                                                      primitive the stone shafts descend through
//   `carved this trip — dig_*×N`                       navigator's carve ledger (dig_down EXCLUDED: the
//                                                      line above already owns it)
//   `<label> dig: cleared N, failed M (of K)`          anchored_repair — the shared structure digger,
//                                                      so this one line covers build AND farm structure
//   `clearing pass: cleared=N`                         build_executor
//   `Site clearing: dug N obstruction(s)`              preconstruction
//   `Dug <block>`                                      harvest_executor — 1 block
//   `Felled <log>, mined N[, clipped V veg]`           tree_feller
//   `cleared=N ... harvested=H`                        farm_executor — canopy clearing and crop breaks
//
//   RESTATED, NOT COUNTED                              WHY
//   `struct(place=P,dig=D)`                            farm_executor restating anchored_repair's digs
//   `<site> <anchor> stationary: dig=D place=P`        build_executor restating the same
//   `shaft N deep, sealed N`                           stone_prospect restating the descent as a depth
//   `Jump bearing: A axial, O oblique, D diagonal`     the same presses `prejump(s)` already carries
//
// ── WHAT THE TRACE CANNOT ANSWER, NAMED RATHER THAN ROUNDED AWAY ────────────────────────────────────
// `drive.js` digs a foot/head block when a step stalls and logs nothing at all, so those breaks are
// outside every count here. They are rare (a stall, not a route) and each is worth 0.005, so the total
// is a FLOOR by a margin far below the run's jump bill — but it is a floor, and `digs_uninstrumented`
// says so as a field.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --hunger [--bot=B]

'use strict';

const { relativeTime, FOREMAN_UNITS } = require('./trace_read');
const out = require('./data_out');
// REUSED RATHER THAN RE-DERIVED (Law 16). The moving/doing split has ONE definition in this folder and
// it is motion_classifier's; the job clock has ONE and it is job_timeline's; strikes have ONE and it is
// engagement_lens's. A second copy of any of them would drift the first time its source line changed.
const { computeSplit } = require('./motion_classifier');
const { reduceJobTimeline } = require('./job_timeline_lens');
const { reduceEngagements } = require('./engagement_lens');

// ── SECTION 1: THE EXHAUSTION MODEL ─────────────────────────────────────────────────────────────────
// Java Edition's prices, one per act. These are the RULER every number downstream is measured with, so
// each is printed as its own field beside the count it multiplies — a reader checks the arithmetic
// rather than being handed its result.
const EXH_PER_BLOCK_BROKEN = 0.005;
const EXH_PER_JUMP = 0.05;
const EXH_PER_SPRINT_JUMP = 0.2;
const EXH_PER_BLOCK_SPRINTED = 0.1;
const EXH_PER_BLOCK_SWUM = 0.01;
const EXH_PER_BLOCK_WALKED = 0;
const EXH_PER_ATTACK = 0.1;
const EXH_PER_DAMAGE_TAKEN = 0.1;
const EXH_PER_HP_REGENERATED = 6.0;
const EXH_PER_FOOD_POINT = 4.0;
const FOOD_BAR_POINTS = 20;

// ── SECTION 2: BREAD ────────────────────────────────────────────────────────────────────────────────
// Bread restores 5 hunger points and, like every food, a saturation payload of
// `2 x nutrition x saturation_modifier`. Bread's modifier is 0.6, so the payload is 6.0.
//
// SATURATION IS SPENT BEFORE THE FOOD BAR IS, so one loaf absorbs BOTH pools: 11 points, which at 4.0
// exhaustion per point is 44 exhaustion. That figure holds only when the loaf is eaten with the bar at
// or below 15 and saturation at 0 — eat at 19 and four of the five hunger points are thrown away.
// `eat_at_or_below_food` is that condition printed as a field, not an assumption buried in a constant.
const BREAD_NUTRITION = 5;
const BREAD_SATURATION_MODIFIER = 0.6;
const BREAD_SATURATION = 2 * BREAD_NUTRITION * BREAD_SATURATION_MODIFIER;
const BREAD_FOOD_POINTS = BREAD_NUTRITION + BREAD_SATURATION;
const EAT_AT_OR_BELOW_FOOD = FOOD_BAR_POINTS - BREAD_NUTRITION;
const BREAD_EXHAUSTION_ABSORBED = BREAD_FOOD_POINTS * EXH_PER_FOOD_POINT;
const WHEAT_PER_BREAD = 3;

// ── SECTION 3: WHEAT ────────────────────────────────────────────────────────────────────────────────
// Crop growth is a RANDOM TICK lottery, not a timer. Each game tick the server picks
// `randomTickSpeed` blocks at random out of every 16x16x16 section, so one plot is offered
// `3 x 20 / 4096` ticks a second. On each offer the crop advances one stage with probability
// `1 / (floor(25 / points) + 1)`, where `points` grades the farmland under and around it:
//
//     base                                1.0
//   + the block directly below, hydrated  3.0
//   + 8 neighbours, hydrated              8 x 0.75 = 6.0
//   = 10.0
//
// THE ROW PENALTY IS THE ARCHITECT'S OWN CONDITION. The game halves `points` when a crop has the same
// crop on BOTH axes (or, failing that, on a diagonal). Alternating rows break that test on one axis, so
// the divisor is 1 and the field runs at full speed — *"all plots are alternating rows so no penalty"*.
// It is a divisor rather than a hardcoded 10 so the penalised case is one field away.
const WHEAT_GROWTH_STAGES = 7;
const FARMLAND_POINTS_BASE = 1.0;
const FARMLAND_POINTS_CENTRE_HYDRATED = 3.0;
const FARMLAND_POINTS_NEIGHBOUR_HYDRATED = 0.75;
const FARMLAND_NEIGHBOURS = 8;
const ROW_PENALTY_DIVISOR = 1;
const RANDOM_TICK_SPEED = 3;
const TICKS_PER_SECOND = 20;
const SECTION_BLOCKS = 16 * 16 * 16;
// A mature wheat plant drops exactly one wheat. Its 0-3 seeds are what replants it, so a tended field
// neither consumes nor produces a seed stock at steady state and the plot's yield is the wheat alone.
const WHEAT_PER_HARVEST = 1;
const MINECRAFT_DAY_REAL_MINUTES = 20;

const growthPoints = () =>
  (FARMLAND_POINTS_BASE + FARMLAND_POINTS_CENTRE_HYDRATED
    + FARMLAND_NEIGHBOURS * FARMLAND_POINTS_NEIGHBOUR_HYDRATED) / ROW_PENALTY_DIVISOR;
const growthChanceDenominator = () => Math.floor(25 / growthPoints()) + 1;
const randomTicksPerPlotPerSecond = () => (RANDOM_TICK_SPEED * TICKS_PER_SECOND) / SECTION_BLOCKS;
// Expected stages x expected offers per stage (a geometric wait, so the denominator itself) / offer rate.
const secondsToMature = () =>
  (WHEAT_GROWTH_STAGES * growthChanceDenominator()) / randomTicksPerPlotPerSecond();
const wheatPerPlotPerHour = () => (3600 / secondsToMature()) * WHEAT_PER_HARVEST;

// ── SECTION 4: THE LINE WHITELIST ───────────────────────────────────────────────────────────────────
// Regex literals, one per emitter named in the header table. Anchored on the TAG wherever two emitters
// share a verb, so `[NAVIGATOR] Dug down to` and `[HARVEST_EXECUTOR] Dug grass_block` cannot collide.
const DUG_DOWN_RE = /\[NAVIGATOR\][^\n]*Dug down to \(/;
const CARVE_RE = /carved this trip — (.+)\.$/;
const CARVE_DIG_RE = /(dig_through|dig_climb_up|dig_climb_down)×(\d+)/g;
const CARVE_PLACE_RE = /(pillar|bridge)×(\d+)/g;
const ANCHOR_DIG_RE = /dig: cleared (\d+), failed (\d+) \(of (\d+)\)/;
const ANCHOR_PLACE_RE = /place: placed (\d+), failed (\d+)/;
const CLEAR_PASS_RE = /clearing pass: cleared=(\d+)/;
const SITE_CLEAR_RE = /Site clearing: dug (\d+) obstruction/;
const HARVEST_DUG_RE = /\[HARVEST_EXECUTOR\][^\n]*Dug [a-z_]+$/;
const FELLED_RE = /Felled \S+, mined (\d+)/;
const CLIPPED_RE = /clipped (\d+) veg/;
const FARM_ROW_RE = /cleared=(\d+) tilled=(\d+) planted=(\d+) harvested=(\d+)/;
const FUSED_RE = /fused this trip — (\d+) run\(s\) over (\d+) cell\(s\), (\d+) prejump\(s\)/;
const PATH_EDGES_RE = /A\* path: \d+ step\(s\) \[([^\]]*)\]/;
const HEALTH_RE = /food (\d+)\/(\d+)[^\n]*hp ([\d.]+)\/([\d.]+)/;
// The three lines that RESTATE an act already counted. Read only so the reader can see the restatement
// sitting beside the count and check that it was not summed in.
const STRUCT_RESTATE_RE = /struct\(place=(\d+),dig=(\d+)\)/;
// ANCHORED ON THE EMITTING TAG, because this one line is echoed twice more by the judge (once as the
// fragment's `Readable:` and once as its reported success), and an unanchored pattern reads a 4-shaft
// run as 12. Measured: 12 matches for 4 shafts, 147 blocks against the 49 actually descended. It is the
// only counted-or-restated line in this lens that the judge repeats, and it is here in the restated
// table precisely because `Dug down to` already owns those digs one block at a time.
const SHAFT_RESTATE_RE = /\[STONE_PROSPECT_EXECUTOR\][^\n]*shaft (\d+) deep, sealed (\d+)/;
const BEARING_RESTATE_RE = /Jump bearing: (\d+) axial, (\d+) oblique, (\d+) diagonal/;
const PILLARED_RESTATE_RE = /Pillared up to y=(-?\d+) using/;

// ── EVERY JUMP PRESS IS 0.05, AND A PILLAR STEP IS A JUMP ──────────────────────────────────────────
// A jump costs TEN TIMES what breaking a block costs, so the jump census decides this whole lens and
// `prejump(s)` alone does not carry it. `scaffold_movement.pillarStep` holds `jump` for exactly one
// crest per block it places, which makes a pillar step a jump press by construction — and the shaft
// crew climbs out of every hole it digs one placement per block of depth. Measured on this trace:
// 237 prejumps against 58 further presses from pillaring, a fifth of the bill sitting outside the
// counter the navigator publishes.
//
// `sealed N` is the climb's OWN count of placements made, so it is the ascent measured rather than the
// shaft depth planned. Tag-anchored for the judge-echo reason above.
// Reads the climb's count out of BOTH shapes it is written in — the success line's `sealed 12)` and the
// short-climb warn's `sealed 5 of 12` — because a climb that ran out of filler still pressed jump for
// every block it did place, and a pattern that only knew the happy shape would price that trip at zero.
const SEALED_RE = /\[STONE_PROSPECT_EXECUTOR\][^\n]*\bsealed (\d+)[)\s]/;
// Jump presses this lens does NOT count, because no line publishes them: `drive`'s single-step climb
// outside a fused run, `fillWaterColumnBelow` and `antiDrown` (both HOLD jump for a span rather than
// pressing it per block, so neither is even a countable act), and the combat driver's hop. The fleet
// never fought on this trace and the water reflexes fire only while submerged.
const JUMPS_UNINSTRUMENTED = 'drive_single_step,water_hold,combat_driver';

const blankBot = () => ({
  lines: 0, lastRel: 0,
  digs: 0, digSources: new Map(),
  jumps: 0, jumpSources: new Map(),
  cellsCrossed: 0, fusedTrips: 0, runsTaken: 0,
  swimEdgesPlanned: 0, walkEdgesPlanned: 0, pathLines: 0,
  places: 0, tilled: 0, planted: 0,
  hpSamples: 0, hpMin: null, hpLost: 0, hpRegained: 0, hpPrev: null,
  foodMin: null, foodSamples: 0,
  attacks: 0,
  restatedStructDigs: 0, restatedShaftDepth: 0, restatedBearingPresses: 0, restatedPillarLines: 0,
});

const addDig = (b, source, n) => {
  if (!n) return;
  b.digs += n;
  b.digSources.set(source, (b.digSources.get(source) || 0) + n);
};

const addJump = (b, source, n) => {
  if (!n) return;
  b.jumps += n;
  b.jumpSources.set(source, (b.jumpSources.get(source) || 0) + n);
};

// Source labels. Field-shaped identifiers, because they are printed as values in a column whose own
// field name declares what they are.
const SRC_DIG_DOWN = 'navigator_dig_down';
const SRC_CARVE = 'navigator_carve';
const SRC_ANCHOR = 'anchored_repair_struct';
const SRC_CLEAR_PASS = 'build_executor_clearing_pass';
const SRC_SITE_CLEAR = 'preconstruction_site_clearing';
const SRC_HARVEST = 'harvest_executor';
const SRC_TREE = 'tree_feller_logs';
const SRC_VEG = 'tree_feller_veg';
const SRC_FARM_CLEAR = 'farm_executor_canopy';
const SRC_FARM_CROP = 'farm_executor_harvest';
const SRC_PREJUMP = 'drive_run_prejump';
const SRC_CARVE_PILLAR = 'navigator_pillar_step';
const SRC_SHAFT_SEAL = 'stone_prospect_seal_climb';

// ── reduceHunger({ seg, bot }) — the machine-facing half. Counts, never renders. ────────────────────
function reduceHunger({ seg = [], bot: botFilter = null } = {}) {
  const per = new Map();
  let maxRel = 0;

  for (const l of seg) {
    if (l.relSec != null) maxRel = Math.max(maxRel, l.relSec);
    const bot = l.bot;
    if (!bot) continue;
    // The foreman's own units are excluded by MEMBERSHIP rather than by name, so a third foreman-side
    // tag added later is excluded by joining that set instead of by editing this line.
    if (FOREMAN_UNITS.has(bot)) continue;
    if (botFilter && bot !== botFilter) continue;
    let b = per.get(bot);
    if (!b) { b = blankBot(); per.set(bot, b); }
    b.lines++;
    if (l.relSec != null && l.relSec > b.lastRel) b.lastRel = l.relSec;
    const r = l.raw;
    let m;

    if (DUG_DOWN_RE.test(r)) addDig(b, SRC_DIG_DOWN, 1);

    if ((m = r.match(CARVE_RE))) {
      const ledger = m[1];
      let c;
      CARVE_DIG_RE.lastIndex = 0;
      while ((c = CARVE_DIG_RE.exec(ledger))) addDig(b, SRC_CARVE, +c[2]);
      CARVE_PLACE_RE.lastIndex = 0;
      while ((c = CARVE_PLACE_RE.exec(ledger))) {
        b.places += +c[2];
        // A pillar rises on a jump crest; a bridge is placed from standing ground and presses nothing.
        if (c[1] === 'pillar') addJump(b, SRC_CARVE_PILLAR, +c[2]);
      }
    }

    if ((m = r.match(ANCHOR_DIG_RE))) addDig(b, SRC_ANCHOR, +m[1]);
    if ((m = r.match(ANCHOR_PLACE_RE))) b.places += +m[1];
    if ((m = r.match(CLEAR_PASS_RE))) addDig(b, SRC_CLEAR_PASS, +m[1]);
    if ((m = r.match(SITE_CLEAR_RE))) addDig(b, SRC_SITE_CLEAR, +m[1]);
    if (HARVEST_DUG_RE.test(r)) addDig(b, SRC_HARVEST, 1);
    if ((m = r.match(FELLED_RE))) {
      addDig(b, SRC_TREE, +m[1]);
      const v = r.match(CLIPPED_RE);
      if (v) addDig(b, SRC_VEG, +v[1]);
    }
    if ((m = r.match(FARM_ROW_RE))) {
      addDig(b, SRC_FARM_CLEAR, +m[1]);
      addDig(b, SRC_FARM_CROP, +m[4]);
      b.tilled += +m[2];
      b.planted += +m[3];
    }

    if ((m = r.match(FUSED_RE))) {
      b.fusedTrips++;
      b.runsTaken += +m[1];
      b.cellsCrossed += +m[2];
      addJump(b, SRC_PREJUMP, +m[3]);
    }

    if ((m = r.match(SEALED_RE))) {
      addJump(b, SRC_SHAFT_SEAL, +m[1]);
      b.places += +m[1];
    }

    if ((m = r.match(PATH_EDGES_RE))) {
      b.pathLines++;
      for (const part of m[1].split(',')) {
        const [t, n] = part.trim().split('×');
        if (t === 'swim') b.swimEdgesPlanned += (+n || 0);
        if (t === 'walk') b.walkEdgesPlanned += (+n || 0);
      }
    }

    if ((m = r.match(HEALTH_RE))) {
      const food = +m[1];
      const hp = +m[3];
      b.foodSamples++;
      if (b.foodMin === null || food < b.foodMin) b.foodMin = food;
      b.hpSamples++;
      if (b.hpMin === null || hp < b.hpMin) b.hpMin = hp;
      if (b.hpPrev !== null) {
        if (hp < b.hpPrev) b.hpLost += b.hpPrev - hp;
        if (hp > b.hpPrev) b.hpRegained += hp - b.hpPrev;
      }
      b.hpPrev = hp;
    }

    if ((m = r.match(STRUCT_RESTATE_RE))) b.restatedStructDigs += +m[2];
    if ((m = r.match(SHAFT_RESTATE_RE))) b.restatedShaftDepth += +m[1];
    if ((m = r.match(BEARING_RESTATE_RE))) b.restatedBearingPresses += +m[1] + +m[2] + +m[3];
    if (PILLARED_RESTATE_RE.test(r)) b.restatedPillarLines++;
  }

  // ── WHICH UNITS ARE BODIES, decided by EVIDENCE rather than by a name list ──────────────────────
  // The merged view carries every unit that posted a line, including the proxy person — a unit with a
  // trace file, no body, and nothing to feed. Membership here is positive and measured: a unit qualifies
  // when the record shows it acting or reporting its own health. A name list would have to be edited
  // every time a new unit joins the fleet, and a unit forgotten on it would be priced as a starving bot.
  const withoutActs = [];
  for (const [bot, b] of [...per.entries()]) {
    const acted = b.digs || b.jumps || b.cellsCrossed || b.places || b.hpSamples;
    if (!acted) { withoutActs.push(bot); per.delete(bot); }
  }

  // Strikes come from the ONE reducer that already reads the crew seats' grammar. A fight with no
  // announcing aggro line is still a swing, so both shapes it files are summed.
  const eng = reduceEngagements({ seg, bot: botFilter });
  for (const [bot, e] of eng.bots) {
    const b = per.get(bot);
    if (!b) continue;
    b.attacks = e.fights.reduce((n, f) => n + f.strikes.length, 0);
  }

  // Price each bot's acts. Every term is kept as its own field so a reader can see which one carries
  // the total — and in a walking fleet that is never the one the time census points at.
  for (const b of per.values()) {
    b.exhDigs = b.digs * EXH_PER_BLOCK_BROKEN;
    b.exhJumps = b.jumps * EXH_PER_JUMP;
    b.exhSwim = b.swimEdgesPlanned * EXH_PER_BLOCK_SWUM;
    b.exhWalk = b.cellsCrossed * EXH_PER_BLOCK_WALKED;
    b.exhAttacks = b.attacks * EXH_PER_ATTACK;
    b.exhDamage = b.hpLost * EXH_PER_DAMAGE_TAKEN;
    b.exhRegen = b.hpRegained * EXH_PER_HP_REGENERATED;
    b.exhTotal = b.exhDigs + b.exhJumps + b.exhSwim + b.exhWalk
      + b.exhAttacks + b.exhDamage + b.exhRegen;
    b.hours = b.lastRel > 0 ? b.lastRel / 3600 : null;
    b.exhPerHour = b.hours ? b.exhTotal / b.hours : null;
    b.foodPointsPerHour = b.exhPerHour === null ? null : b.exhPerHour / EXH_PER_FOOD_POINT;
    b.breadPerHour = b.exhPerHour === null ? null : b.exhPerHour / BREAD_EXHAUSTION_ABSORBED;
    b.plots = b.breadPerHour === null ? null
      : (b.breadPerHour * WHEAT_PER_BREAD) / wheatPerPlotPerHour();
  }

  return { per, maxRel, withoutActs };
}

const r2 = (v) => (v === null || v === undefined ? null : +v.toFixed(2));
const r3 = (v) => (v === null || v === undefined ? null : +v.toFixed(3));
const r4 = (v) => (v === null || v === undefined ? null : +v.toFixed(4));

// ── runHunger(...) — the human-facing half. Renders the same reduction. ─────────────────────────────
function runHunger({ seg = [], traceName = '?', bot: botFilter = null } = {}) {
  const { per, maxRel, withoutActs } = reduceHunger({ seg, bot: botFilter });

  out.kv('lens', 'hunger');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('flags', false);
  out.kv('wakes', false);
  if (per.size === 0) {
    out.zero('bots');
    return;
  }
  out.kv('bots', [...per.keys()].join(','));
  // The units this lens dropped, printed rather than silently absent — a subset shown as the whole is a
  // false verdict with a clean exit (Law 25).
  out.kv('units_without_acts', withoutActs.length ? withoutActs.join(',') : null);

  // ── The ruler, printed before anything it measures ───────────────────────────────────────────────
  out.section('exhaustion_model');
  out.kv('exhaustion_per_block_broken', EXH_PER_BLOCK_BROKEN);
  out.kv('exhaustion_per_jump', EXH_PER_JUMP);
  out.kv('exhaustion_per_sprint_jump', EXH_PER_SPRINT_JUMP);
  out.kv('exhaustion_per_block_sprinted', EXH_PER_BLOCK_SPRINTED);
  out.kv('exhaustion_per_block_swum', EXH_PER_BLOCK_SWUM);
  out.kv('exhaustion_per_block_walked', EXH_PER_BLOCK_WALKED);
  out.kv('exhaustion_per_attack', EXH_PER_ATTACK);
  out.kv('exhaustion_per_damage_taken', EXH_PER_DAMAGE_TAKEN);
  out.kv('exhaustion_per_hp_regenerated', EXH_PER_HP_REGENERATED);
  out.kv('exhaustion_per_food_point', EXH_PER_FOOD_POINT);
  out.kv('food_bar_points', FOOD_BAR_POINTS);

  // ── Time census: the Architect's question, answered by the folder's existing definitions ─────────
  out.section('time_census');
  out.kv('source_moving_doing', 'motion_classifier.computeSplit');
  const timeRows = [];
  for (const bot of per.keys()) {
    const split = computeSplit(bot);
    if (!split) { timeRows.push([bot, null, null, null, null, null]); continue; }
    const tot = split.totMove + split.totDo;
    timeRows.push([bot, tot, split.totMove, tot ? Math.round(100 * split.totMove / tot) : null,
      split.totDo, tot ? Math.round(100 * split.totDo / tot) : null]);
  }
  out.table(['bot', 'classified_sec', 'moving_sec', 'moving_pct', 'doing_sec', 'doing_pct'], timeRows);

  out.section('time_by_job');
  out.kv('source_job_clock', 'job_timeline_lens.reduceJobTimeline');
  const jt = reduceJobTimeline({ seg, bot: botFilter });
  out.kv('jobs_claimed', jt.jobs.length);
  out.kv('worked_sec', r2(jt.workedSec));
  out.kv('span_sec', r2(jt.spanSec));
  out.table(['token', 'claims', 'total_sec', 'pct_of_worked'],
    jt.byType.slice(0, 20).map(t => [t.token, t.claims, r2(t.totalSec),
      jt.workedSec ? Math.round(100 * t.totalSec / jt.workedSec) : null]));

  // ── The event census: what the run actually did, act by act ──────────────────────────────────────
  out.section('blocks_broken_by_source');
  const digRows = [];
  for (const [bot, b] of per) {
    for (const [src, n] of [...b.digSources.entries()].sort((x, y) => y[1] - x[1])) {
      digRows.push([bot, src, n, EXH_PER_BLOCK_BROKEN, r4(n * EXH_PER_BLOCK_BROKEN)]);
    }
  }
  out.table(['bot', 'source', 'blocks', 'exhaustion_per_block', 'exhaustion'], digRows);
  out.kv('digs_uninstrumented', 'drive_stall_dig');

  out.section('jumps_by_source');
  const jumpRows = [];
  for (const [bot, b] of per) {
    for (const [src, n] of [...b.jumpSources.entries()].sort((x, y) => y[1] - x[1])) {
      jumpRows.push([bot, src, n, EXH_PER_JUMP, r4(n * EXH_PER_JUMP)]);
    }
  }
  out.table(['bot', 'source', 'jumps', 'exhaustion_per_jump', 'exhaustion'], jumpRows);
  out.kv('jumps_uninstrumented', JUMPS_UNINSTRUMENTED);

  out.section('acts_priced');
  out.table(['bot', 'act', 'count', 'exhaustion_per_act', 'exhaustion'],
    [...per.entries()].flatMap(([bot, b]) => [
      [bot, 'block_broken', b.digs, EXH_PER_BLOCK_BROKEN, r4(b.exhDigs)],
      [bot, 'jump', b.jumps, EXH_PER_JUMP, r4(b.exhJumps)],
      [bot, 'block_swum', b.swimEdgesPlanned, EXH_PER_BLOCK_SWUM, r4(b.exhSwim)],
      [bot, 'block_walked', b.cellsCrossed, EXH_PER_BLOCK_WALKED, r4(b.exhWalk)],
      [bot, 'attack', b.attacks, EXH_PER_ATTACK, r4(b.exhAttacks)],
      [bot, 'damage_taken_hp', b.hpLost, EXH_PER_DAMAGE_TAKEN, r4(b.exhDamage)],
      [bot, 'hp_regenerated', b.hpRegained, EXH_PER_HP_REGENERATED, r4(b.exhRegen)],
    ]));

  out.section('acts_free');
  out.table(['bot', 'act', 'count', 'exhaustion_per_act'],
    [...per.entries()].flatMap(([bot, b]) => [
      [bot, 'block_placed', b.places, 0],
      [bot, 'farmland_tilled', b.tilled, 0],
      [bot, 'seed_planted', b.planted, 0],
      [bot, 'fused_trip', b.fusedTrips, 0],
      [bot, 'drive_run', b.runsTaken, 0],
      [bot, 'a_star_path', b.pathLines, 0],
    ]));

  // The restating lines, shown beside the counts so the reader can confirm they were not summed in.
  out.section('restated_not_counted');
  out.table(['bot', 'line', 'value'],
    [...per.entries()].flatMap(([bot, b]) => [
      [bot, 'farm_executor_struct_dig', b.restatedStructDigs],
      [bot, 'stone_prospect_shaft_depth', b.restatedShaftDepth],
      [bot, 'jump_bearing_presses', b.restatedBearingPresses],
      [bot, 'navigator_pillared_up_lines', b.restatedPillarLines],
    ]));

  out.section('health_samples');
  out.table(['bot', 'samples', 'food_min', 'hp_min', 'hp_lost', 'hp_regained'],
    [...per.entries()].map(([bot, b]) => [bot, b.hpSamples, b.foodMin, b.hpMin, b.hpLost, b.hpRegained]));

  // ── The drain ────────────────────────────────────────────────────────────────────────────────────
  out.section('drain');
  out.table(['bot', 'run_sec', 'exhaustion_total', 'exhaustion_per_hour',
    'food_points_per_hour', 'hours_per_food_bar'],
    [...per.entries()].map(([bot, b]) => [bot, b.lastRel, r3(b.exhTotal), r2(b.exhPerHour),
      r3(b.foodPointsPerHour),
      b.foodPointsPerHour ? r2(FOOD_BAR_POINTS / b.foodPointsPerHour) : null]));

  // ── Bread ────────────────────────────────────────────────────────────────────────────────────────
  out.section('bread_model');
  out.kv('bread_nutrition', BREAD_NUTRITION);
  out.kv('bread_saturation_modifier', BREAD_SATURATION_MODIFIER);
  out.kv('bread_saturation', BREAD_SATURATION);
  out.kv('bread_food_points', BREAD_FOOD_POINTS);
  out.kv('eat_at_or_below_food', EAT_AT_OR_BELOW_FOOD);
  out.kv('bread_exhaustion_absorbed', BREAD_EXHAUSTION_ABSORBED);
  out.kv('wheat_per_bread', WHEAT_PER_BREAD);
  out.kv('minecraft_day_real_minutes', MINECRAFT_DAY_REAL_MINUTES);

  out.section('bread_demand');
  out.table(['bot', 'bread_per_hour', 'hours_per_bread', 'bread_per_minecraft_day',
    'bread_per_real_day', 'wheat_per_hour'],
    [...per.entries()].map(([bot, b]) => [bot,
      r4(b.breadPerHour),
      b.breadPerHour ? r2(1 / b.breadPerHour) : null,
      r4(b.breadPerHour === null ? null : b.breadPerHour * (MINECRAFT_DAY_REAL_MINUTES / 60)),
      r3(b.breadPerHour === null ? null : b.breadPerHour * 24),
      r3(b.breadPerHour === null ? null : b.breadPerHour * WHEAT_PER_BREAD)]));

  // ── Wheat ────────────────────────────────────────────────────────────────────────────────────────
  out.section('wheat_model');
  out.kv('growth_stages', WHEAT_GROWTH_STAGES);
  out.kv('farmland_points_base', FARMLAND_POINTS_BASE);
  out.kv('farmland_points_centre_hydrated', FARMLAND_POINTS_CENTRE_HYDRATED);
  out.kv('farmland_points_neighbour_hydrated', FARMLAND_POINTS_NEIGHBOUR_HYDRATED);
  out.kv('farmland_neighbours', FARMLAND_NEIGHBOURS);
  out.kv('row_penalty_divisor', ROW_PENALTY_DIVISOR);
  out.kv('growth_points', growthPoints());
  out.kv('growth_chance_denominator', growthChanceDenominator());
  out.kv('random_tick_speed', RANDOM_TICK_SPEED);
  out.kv('ticks_per_second', TICKS_PER_SECOND);
  out.kv('section_blocks', SECTION_BLOCKS);
  out.kv('random_ticks_per_plot_per_second', r4(randomTicksPerPlotPerSecond()));
  out.kv('seconds_to_mature', r2(secondsToMature()));
  out.kv('minutes_to_mature', r2(secondsToMature() / 60));
  out.kv('wheat_per_harvest', WHEAT_PER_HARVEST);
  out.kv('wheat_per_plot_per_hour', r3(wheatPerPlotPerHour()));
  // The two conditions the plot count is computed under, as fields rather than as a footnote. A random
  // tick only reaches a chunk the server is simulating, and a plot only yields on the pass that harvests
  // it — a field visited every other hour returns half of what this row says.
  out.kv('assumes_chunk_within_simulation_distance', true);
  out.kv('assumes_harvest_and_replant_at_maturity', true);

  out.section('plots_required');
  out.table(['bot', 'wheat_per_hour', 'plots', 'plots_rounded_up'],
    [...per.entries()].map(([bot, b]) => [bot,
      r3(b.breadPerHour === null ? null : b.breadPerHour * WHEAT_PER_BREAD),
      r3(b.plots),
      b.plots === null ? null : Math.ceil(b.plots)]));

  const bots = [...per.values()].filter(b => b.plots !== null);
  const mean = (f) => (bots.length ? bots.reduce((s, b) => s + f(b), 0) / bots.length : null);
  out.section('one_bot_at_this_pace');
  out.kv('bots_measured', bots.length);
  out.kv('exhaustion_per_hour', r2(mean(b => b.exhPerHour)));
  out.kv('food_points_per_hour', r3(mean(b => b.foodPointsPerHour)));
  out.kv('bread_per_hour', r4(mean(b => b.breadPerHour)));
  out.kv('bread_per_real_day', r3(mean(b => b.breadPerHour) * 24));
  out.kv('wheat_per_hour', r3(mean(b => b.breadPerHour) * WHEAT_PER_BREAD));
  out.kv('plots', r3(mean(b => b.plots)));
  out.kv('plots_rounded_up', Math.ceil(mean(b => b.plots)));
}

module.exports = { reduceHunger, runHunger, growthPoints, secondsToMature, wheatPerPlotPerHour };
