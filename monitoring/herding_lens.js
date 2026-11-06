// Auren_Bot/monitoring/herding_lens.js
// --herding: every herd the fleet ran, one row each, from the dispatcher's claim of a herd job to herd_manager's
// line that closes it. Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// A herd is read off four lines the bodies already write:
//   - the dispatcher's `Claimed … dispatching to herd_manager` — the herd's start;
//   - `[WALK_LEDGER]` with `category=herd/herd_animal` — every walk inside it, with its ends and held time;
//   - `[HERD_EXECUTOR]`'s outcome line — the animal, the result, legs, reacquires and the executor's own seconds;
//   - `[HERD_MANAGER]`'s line — the exit (seconds waited, escaped) and the wheat banked; the herd's end.
// The executor's own seconds split the herd into three phases: BEFORE (wheat from the chest, the search for a free
// animal), HERD (out to the animal, the lead, the gate) and AFTER (out of the pen, the wheat back to the chest).
// Walk blocks are each walk's straight line from its from= to its to=, summed: the least ground covered, never the
// route walked. Steps taken inside the pen (pen_gate.stepInto) are not walks and are not in it.
//
// RUNS ARE COUNTED BY THE FOREMAN PROCESS STARTING (`Foreman WebSocket server listening`), once per fleet start. The
// trace's segments (trace_read.segmentRuns) also cut at every `start` broadcast, which falls inside a herd, so a herd's
// claim and its close can sit in different segments; the herds are read across them. Read with --run=all.
//
// THE HERD LEDGER: every job at the pen closes with one `[HERD_LEDGER] herd k=v …` line — the result, the role
// (bringer, shepherd, shearer, culler, breeder; keeper / keeper_then_bringer in the older tandem runs, herder / handoff in the
// parking-cell runs), seconds by step as the body clocked them (pen_gate.tendClock) and total_s, the flock taken in and
// whom it held for. Where a run has them, [herd_time_by_step] gives each role's average seconds per step and its
// average total, [herd_ledger] every job as written; the rows above are rebuilt from the older lines and stay for runs
// before the ledger. [herd_waits] prints every `[HERD_WAIT]` line: what a body waiting on a peer at the pen saw.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --herding [--run=latest|N|all] [--bot=B] [--all]

'use strict';

const out = require('./data_out');

const FLEET_START_RE = /\[FOREMAN\] Foreman WebSocket server listening/;
const LEDGER_RE = /\[HERD_LEDGER\].*? herd ((?:\S+=\S+ ?)+)/;
const FAULT_RE = /\[HERD_FAULT\].*? fault ((?:\S+=\S+ ?)+)/;
// assessors/ranching's census, written by a body whenever what it counts at the pen changes.
const CENSUS_RE = /\[PEN_CENSUS\].*? pen ((?:\S+=\S+ ?)+)/;
// A body waiting on a peer at the pen (pen_gate.awaitShepherd, herd_executor's shepherd and standby waits).
const WAIT_RE = /\[HERD_WAIT\].*? wait ((?:\S+=\S+ ?)+)/;
// kvRow: a `k=v k=v` machine line into `row`; '-' reads as null, a number as a number.
function kvRow(text, row) {
  for (const pair of text.trim().split(' ')) {
    const i = pair.indexOf('=');
    const v = pair.slice(i + 1);
    row[pair.slice(0, i)] = v === '-' ? null : (v !== '' && Number.isFinite(+v) ? +v : (v === 'true' ? true : v === 'false' ? false : v));
  }
  return row;
}
const CLAIM_RE = /\[DISPATCHER\].*Claimed .*? — dispatching to herd_manager/;
const WALK_RE = /\[WALK_LEDGER\].*walk verb=\S+ category=herd\/herd_animal purpose=(\S+)(?: leg=\S+)? held=([\d.]+)s outcome=(\w+)(?: from=\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\) to=\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\))?/;
const EXEC_RE = /\[HERD_EXECUTOR\][^\n]*?herd_executor: /;
const MANAGER_RE = /\[HERD_MANAGER\][^\n]*?(herd_executor: |herd_manager: )/;
const GATE_REFUSED_RE = /Claim rejected for 'gate:/;
const REACQUIRE_RE = /\[HERD_EXECUTOR\].*fell out of tempt range/;

// The executor's outcome line, in each shape it has been written in.
const PENNED_RE = /penned animal (\d+) in (\d+)s \(legs=(\d+), reacquires=(\d+)\); herder inside the shut pen at (-?\d+),(-?\d+),(-?\d+)/;
// The drop-off design's outcome: no seconds of its own (the ledger's steps carry them).
const DROPPED_RE = /dropped off a flock of \d+\/\d+ with animal (\d+) \(legs=(\d+), reacquires=(\d+)\); herder inside the pen at (-?\d+),(-?\d+),(-?\d+)/;
const FOLLOWED_RE = /animal (\d+) followed a peer into the pen \((?:(\d+)s, )?legs=(\d+)\); herder outside at (-?\d+),(-?\d+),(-?\d+)/;
const FAIL_RE = /fail (\w+) \(animal (\d+), legs=(\d+), reacquires=(\d+), (?:(\d+)s, )?herder at (-?\d+),(-?\d+),(-?\d+)\)/;
const ALREADY_RE = /animal (\d+) already penned/;
const NO_WHEAT_RE = /fail no wheat to lead with/;
// The manager's tail.
const EXIT_RE = /left the pen(?: after (\d+)s)?, (\d+) escaped/;
const EXIT_FAIL_RE = /left the pen: FAILED (\w+)/;
const BANKED_RE = /banked (\d+) wheat/;
const NOT_FOUND_RE = /herd_manager: no free (\w+) found \((\w+), (\d+) walk/;
const NO_PEN_RE = /herd_manager: this crew has no locked pen/;
const NO_CHEST_WHEAT_RE = /herd_manager: no wheat in the chests/;

// Results that leave the animal in the pen.
const INTO_PEN = new Set(['penned', 'penned_by_a_peer', 'already_penned']);

const secOf = l => (l.iso ? Date.parse(l.iso) / 1000 : null);
const clock = s => (s == null ? null : new Date(s * 1000).toISOString().slice(11, 19));
const r1 = v => (v == null ? null : +v.toFixed(1));

function parseExecutor(text) {
  let m;
  const num = v => (v === undefined ? null : +v);
  if ((m = PENNED_RE.exec(text))) return { result: 'penned', animal: +m[1], herdSec: +m[2], legs: +m[3], reacquires: +m[4], end: [+m[5], +m[6], +m[7]] };
  if ((m = DROPPED_RE.exec(text))) return { result: 'penned', animal: +m[1], herdSec: null, legs: +m[2], reacquires: +m[3], end: [+m[4], +m[5], +m[6]] };
  if ((m = FOLLOWED_RE.exec(text))) return { result: 'penned_by_a_peer', animal: +m[1], herdSec: num(m[2]), legs: +m[3], reacquires: null, end: [+m[4], +m[5], +m[6]] };
  if ((m = FAIL_RE.exec(text))) return { result: m[1], animal: +m[2], herdSec: num(m[5]), legs: +m[3], reacquires: +m[4], end: [+m[6], +m[7], +m[8]] };
  if ((m = ALREADY_RE.exec(text))) return { result: 'already_penned', animal: +m[1], herdSec: 0, legs: 0, reacquires: 0, end: null };
  if (NO_WHEAT_RE.test(text)) return { result: 'no_wheat', animal: null, herdSec: 0, legs: 0, reacquires: 0, end: null };
  return null;
}

function parseManager(text, herd) {
  let m;
  if ((m = EXIT_RE.exec(text))) { herd.exitWaitSec = m[1] === undefined ? null : +m[1]; herd.escaped = +m[2]; }
  if ((m = EXIT_FAIL_RE.exec(text))) herd.exitFault = m[1];
  if ((m = BANKED_RE.exec(text))) herd.banked = +m[1];
  if (!herd.result) {
    if ((m = NOT_FOUND_RE.exec(text))) { herd.result = `no_free_${m[1]}_${m[2]}`; herd.seekWalks = +m[3]; }
    else if (NO_PEN_RE.test(text)) herd.result = 'no_locked_pen';
    else if (NO_CHEST_WHEAT_RE.test(text)) herd.result = 'no_wheat_in_chests';
  }
}

// reduceHerding({ seg }) → { herds: [...] }, one per herd job closed by herd_manager's line, in close order.
function reduceHerding({ seg = [], bot: botFilter = null } = {}) {
  const herds = [];
  const ledger = [];
  const faults = [];
  const census = [];
  const waits = [];
  let run = 0;
  {
    const open = new Map();   // bot → herd being read
    const start = (l) => {
      const h = {
        run, bot: l.bot, claimSec: secOf(l), walks: [], execSec: null, endSec: null,
        result: null, animal: null, herdSec: null, legs: null, reacquires: null, end: null,
        exitWaitSec: null, escaped: null, exitFault: null, banked: null, seekWalks: null,
        gateRefused: 0, reacquireWarns: 0,
      };
      open.set(l.bot, h);
      return h;
    };
    for (const l of seg) {
      if (FLEET_START_RE.test(l.raw)) { run++; open.clear(); continue; }
      if (!l.bot || (botFilter && l.bot !== botFilter)) continue;
      let lm;
      if ((lm = LEDGER_RE.exec(l.raw))) { ledger.push(kvRow(lm[1], { run, bot: l.bot, atSec: secOf(l) })); continue; }
      if ((lm = FAULT_RE.exec(l.raw))) { faults.push(kvRow(lm[1], { run, bot: l.bot, atSec: secOf(l) })); continue; }
      if ((lm = CENSUS_RE.exec(l.raw))) { census.push(kvRow(lm[1], { run, bot: l.bot, atSec: secOf(l) })); continue; }
      if ((lm = WAIT_RE.exec(l.raw))) { waits.push(kvRow(lm[1], { run, bot: l.bot, atSec: secOf(l) })); continue; }
      if (CLAIM_RE.test(l.raw)) { start(l); continue; }
      const h = open.get(l.bot);
      if (!h) continue;   // lines before this bot's first herd claim in the run
      let m;
      if ((m = WALK_RE.exec(l.raw))) {
        const w = { atSec: secOf(l), purpose: m[1], sec: +m[2], outcome: m[3], from: null, to: null, blocks: null };
        if (m[4] !== undefined) {
          w.from = [+m[4], +m[5], +m[6]]; w.to = [+m[7], +m[8], +m[9]];
          w.blocks = Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1], w.to[2] - w.from[2]);
        }
        h.walks.push(w);
        continue;
      }
      if (GATE_REFUSED_RE.test(l.raw)) { h.gateRefused++; continue; }
      if (REACQUIRE_RE.test(l.raw)) { h.reacquireWarns++; continue; }
      if (EXEC_RE.test(l.raw) && !MANAGER_RE.test(l.raw)) {
        const e = parseExecutor(l.raw);
        if (e) { Object.assign(h, e); h.execSec = secOf(l); }
        continue;
      }
      if (MANAGER_RE.test(l.raw)) {
        if (!h.result) { const e = parseExecutor(l.raw); if (e) Object.assign(h, e); }
        parseManager(l.raw, h);
        h.endSec = secOf(l);
        herds.push(h);
        open.delete(l.bot);
      }
    }
  }
  return { herds: herds.map(phaseOf), ledger, faults, census, waits };
}

// Splits a herd's walks into its three phases by the executor's own start (its line's time less its seconds).
function phaseOf(h) {
  const herdStart = h.execSec != null && h.herdSec != null ? h.execSec - h.herdSec : null;
  const inPhase = (lo, hi) => h.walks.filter(w => w.atSec != null && (lo == null || w.atSec > lo) && (hi == null || w.atSec <= hi));
  const before = herdStart != null ? inPhase(null, herdStart) : h.walks;
  const during = herdStart != null ? inPhase(herdStart, h.execSec) : [];
  const after = h.execSec != null ? inPhase(h.execSec, null) : [];
  const blocks = ws => ws.reduce((s, w) => s + (w.blocks || 0), 0);
  // The animal stood where the herd's first walk to open ground ended: the walk out to it. A station walk read inside
  // the herd's window is the wheat fetch ending in the same second the herd began.
  const outWalk = during.find(w => w.purpose === 'move' && w.to);
  const animalAt = outWalk ? outWalk.to : null;
  const herderAt = outWalk ? outWalk.from : null;
  const flat = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : null);
  return {
    ...h,
    jobSec: h.claimSec != null && h.endSec != null ? h.endSec - h.claimSec : null,
    beforeSec: herdStart != null && h.claimSec != null ? Math.max(0, herdStart - h.claimSec) : null,
    afterSec: h.execSec != null && h.endSec != null ? h.endSec - h.execSec : null,
    beforeBlocks: blocks(before), herdBlocks: blocks(during), afterBlocks: blocks(after),
    walkBlocks: blocks(h.walks),
    animalAt, outBlocks: flat(herderAt, animalAt), leadBlocks: flat(animalAt, h.end),
  };
}

function _byKey(herds, keyOf) {
  const by = new Map();
  for (const h of herds) {
    const k = keyOf(h);
    const g = by.get(k) || [];
    g.push(h);
    by.set(k, g);
  }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
}
const avg = (hs, f) => { const v = hs.map(f).filter(x => x != null); return v.length ? r1(v.reduce((s, x) => s + x, 0) / v.length) : null; };
const sum = (hs, f) => hs.reduce((s, h) => s + (f(h) || 0), 0);

// THE KEEPER'S PEN WATCH (foreman/pen_keeper), from the foreman's own stream, this run's span only: every animal in
// and out of a pen by id, with the gate and the bodies beside it named on each escape or loss, and the wolves near a
// pen. Beside it, the bodies' own LURE (wheat shown or put away, and why) and GATE (opened or shut, the hands) lines.
const KEEPER_PEN_RE = /\[PEN_KEEPER\].*?\b(PEN_STANDS|PEN_KEPT|PEN_ENTERED|PEN_RETURNED|PEN_ESCAPED|PEN_LOST|PEN_SIGHT|PEN_STRANGER|WOLF_NEAR_PEN) ((?:\S+=\S+ ?)+)/;
const LURE_RE = /\[HERD_LURE\].*? LURE ((?:\S+=\S+ ?)+)/;
const GATE_RE = /\[PEN_GATE\].*? GATE ((?:\S+=\S+ ?)+)/;
const TEMPT_RE = /\[HERD_EXECUTOR\].*? TEMPT ((?:\S+=\S+ ?)+)/;
const BREED_ROUND_RE = /\[BREED_ROUND\].*? round ((?:\S+=\S+ ?)+)/;
function runPenWatch(seg, foreman, botFilter, verbose) {
  const from = seg.reduce((lo, l) => (l.atMs && l.atMs < lo ? l.atMs : lo), seg.length ? Infinity : -Infinity);
  const events = [];
  for (const l of foreman) {
    const m = KEEPER_PEN_RE.exec(l.raw);
    if (m && (!l.atMs || l.atMs >= from)) events.push(kvRow(m[2], { event: m[1], atSec: l.wallSec ?? null, atMs: l.atMs ?? null, iso: l.atMs ? new Date(l.atMs).toISOString().slice(11, 19) : null }));
  }
  const hands = [];
  for (const l of seg) {
    if (botFilter && l.bot !== botFilter) continue;
    let m;
    if ((m = LURE_RE.exec(l.raw))) hands.push(kvRow(m[1], { kind: 'lure', bot: l.bot, iso: l.atMs ? new Date(l.atMs).toISOString().slice(11, 19) : null }));
    else if ((m = GATE_RE.exec(l.raw))) hands.push(kvRow(m[1], { kind: 'gate', bot: l.bot, iso: l.atMs ? new Date(l.atMs).toISOString().slice(11, 19) : null }));
    else if ((m = TEMPT_RE.exec(l.raw))) hands.push(kvRow(m[1], { kind: 'tempt', bot: l.bot, iso: l.atMs ? new Date(l.atMs).toISOString().slice(11, 19) : null }));
  }
  if (events.length) {
    out.section('pen_watch_counts');
    out.table(['pen', 'event', 'count'], _byKey(events, e => `${e.pen}|${e.event}`).map(([k, es]) => [...k.split('|'), es.length]));
    // WHERE A PEN'S ANIMALS CAME FROM, read off PEN_ENTERED's gate: an animal first seen inside with the gate open came
    // through it (led in); one first seen inside with the gate shut was born there, or crossed the fence (a stranger
    // reads PEN_STRANGER, an escapee coming back PEN_RETURNED). Births arrive in bursts seconds after a breed feed, so
    // [pen_births] groups shut-gate entries within BIRTH_BURST_SEC of the one before.
    const BIRTH_BURST_SEC = 30;
    const entered = events.filter(e => e.event === 'PEN_ENTERED');
    out.section('pen_sources');
    out.table(['pen', 'entered', 'gate_open_led_in', 'gate_shut_born_inside', 'returned', 'escaped', 'lost', 'last_count'],
      _byKey(entered, e => e.pen).map(([pen, es]) => {
        const of = (ev) => events.filter(e => e.pen === pen && e.event === ev).length;
        return [pen, es.length, es.filter(e => e.gate === 'open').length, es.filter(e => e.gate === 'shut').length,
          of('PEN_RETURNED'), of('PEN_ESCAPED'), of('PEN_LOST'), es[es.length - 1].count ?? null];
      }));
    const bursts = [];
    for (const e of entered.filter(x => x.gate === 'shut')) {
      const last = bursts.length ? bursts[bursts.length - 1] : null;
      if (last && last.pen === e.pen && e.atMs != null && last.toMs != null && e.atMs - last.toMs <= BIRTH_BURST_SEC * 1000) { last.n++; last.toMs = e.atMs; last.to = e.iso; last.count = e.count; }
      else bursts.push({ pen: e.pen, from: e.iso, to: e.iso, toMs: e.atMs, n: 1, count: e.count });
    }
    out.section('pen_births');
    out.table(['from', 'to', 'pen', 'born', 'penned_after'], bursts.map(b => [b.from, b.to, b.pen, b.n, b.count ?? null]));
    // EACH BREED ROUND BESIDE ITS CALVES: herd_executor's [BREED_ROUND] line (the pen as the server read it, the pairs it
    // could make, what was fed, in love after, calves expected) and the keeper's gate-shut entries in that pen within
    // ROUND_BIRTH_SEC either side of the line, which the round's own calves are.
    const ROUND_BIRTH_SEC = 60;
    const rounds = [];
    for (const l of seg) {
      if (botFilter && l.bot !== botFilter) continue;
      const m = BREED_ROUND_RE.exec(l.raw);
      if (m) rounds.push(kvRow(m[1], { bot: l.bot, atMs: l.atMs ?? null, iso: l.atMs ? new Date(l.atMs).toISOString().slice(11, 19) : null }));
    }
    const born = (r) => (r.atMs == null ? null : entered.filter(e => e.gate === 'shut' && e.pen === r.pen && e.atMs != null
      && Math.abs(e.atMs - r.atMs) <= ROUND_BIRTH_SEC * 1000).length);
    out.section('breed_rounds');
    out.table(['clock', 'bot', 'pen', 'penned', 'grown', 'young', 'ready', 'cooling', 'in_love_before', 'next_ready_s', 'waited_s',
      'pairs_possible', 'pairs_asked', 'asked_by', 'cap_half', 'cap_room', 'cap_wheat', 'fed', 'fed_a', 'fed_b', 'side_b', 'refused', 'ready_left', 'unreached', 'in_love_after', 'calves_expected', 'calves_born', 'stop'],
      rounds.map(r => [r.iso, r.bot, r.pen, r.penned, r.grown, r.young, r.ready, r.cooling, r.in_love_before, r.next_ready_s, r.waited_s,
        r.pairs_possible, r.pairs_asked, r.asked_by, r.cap_half, r.cap_room, r.cap_wheat, r.fed, r.fed_a ?? null, r.fed_b ?? null, r.side_b ?? null, r.refused, r.ready_left, r.unreached ?? null, r.in_love_after, r.calves_expected, born(r), r.stop]));
    out.section('pen_escapes');
    out.table(['clock', 'event', 'pen', 'animal', 'id', 'at', 'last_at', 'cause', 'from_gate', 'gate', 'penned_for', 'count', 'whole', 'near'],
      events.filter(e => e.event === 'PEN_ESCAPED' || e.event === 'PEN_LOST').map(e => [e.iso, e.event, e.pen, e.animal, e.id, e.at ?? null, e.last_at ?? null, e.cause ?? null,
        e.from_gate ?? null, e.gate ?? null, e.penned_for ?? null, e.count, e.whole ?? null, e.near]));
    out.section('pen_strangers');
    out.table(['clock', 'pen', 'animal', 'id', 'at', 'from_gate', 'gate', 'whole', 'in_pen', 'near'],
      events.filter(e => e.event === 'PEN_STRANGER').map(e => [e.iso, e.pen, e.animal, e.id, e.at, e.from_gate, e.gate, e.whole, e.in_pen, e.near]));
    out.section('pen_wolves');
    out.table(['clock', 'pen', 'wolf', 'at', 'from_fence', 'penned', 'gate', 'near'],
      events.filter(e => e.event === 'WOLF_NEAR_PEN').map(e => [e.iso, e.pen, e.wolf, e.at, e.from_fence, e.penned, e.gate, e.near]));
    if (verbose) {
      out.section('pen_watch');
      out.table(['clock', 'event', 'pen', 'id', 'at', 'count', 'gate', 'seen', 'near'],
        events.map(e => [e.iso, e.event, e.pen, e.id ?? null, e.at ?? null, e.count ?? null, e.gate ?? null, e.seen ?? null, e.near ?? null]));
    }
  }
  runShearsBook(seg, botFilter);
  if (hands.length) {
    out.section('herd_hands_counts');
    out.table(['kind', 'state_or_result', 'why', 'count'],
      _byKey(hands, h => `${h.kind}|${h.state ?? h.result ?? '-'}|${h.why ?? '-'}`).map(([k, hs]) => [...k.split('|'), hs.length]));
    if (verbose) {
      out.section('herd_hands');
      out.table(['clock', 'bot', 'kind', 'state', 'why', 'at', 'gate', 'hands', 'animal', 'result', 'dist'],
        hands.map(h => [h.iso, h.bot, h.kind, h.state ?? null, h.why ?? null, h.at ?? null, h.gate ?? null, h.hands ?? null, h.animal ?? null, h.result ?? null, h.dist ?? null]));
    }
  }
}

// THE SHEARS BOOK: both banked pairs, lent and returned (harvest_executor's leaf seat, shear_manager's shearing), every
// body's line on one clock. Each lending is a row from out to in; `peers_out` counts the other bodies holding the same
// pair's seat when it went out (the leaf seat is one body's), and a lending with no return is `still_out` — or `run_ended`
// when a fleet start came first, since a run's end takes the seat with it. A craft of a pair is a `made` row.
const SHEARS_MADE_RE = /craft book .*— shears x(\d+) ✓/;
// One capture group per line kind, in SHEARS_ACT's order (harvest_executor's three, then shear_manager's two).
const SHEARS_RE = /\bSHEARS (?:(borrowed for the leaf cut)|(returned after the leaf cut)|(the leaf pair could not be put back)|(taken from the chest for the shearing)|(put back in the chest))/;
const SHEARS_ACT = [['leaf', 'out'], ['leaf', 'in'], ['leaf', 'stuck'], ['pen', 'out'], ['pen', 'in']];
function runShearsBook(seg, botFilter) {
  const lines = [];
  for (const l of seg) {
    if (!l.atMs) continue;
    if (FLEET_START_RE.test(l.raw)) { lines.push({ atMs: l.atMs, act: 'start' }); continue; }
    const made = SHEARS_MADE_RE.exec(l.raw);
    if (made) { lines.push({ atMs: l.atMs, bot: l.bot, pair: 'made', act: 'made', count: Number(made[1]) }); continue; }
    const m = SHEARS_RE.exec(l.raw);
    if (m) { const [pair, act] = SHEARS_ACT[m.slice(1).findIndex(g => g !== undefined)]; lines.push({ atMs: l.atMs, bot: l.bot, pair, act }); }
  }
  if (!lines.some(s => s.act !== 'start')) return;
  lines.sort((a, b) => a.atMs - b.atMs);
  const open = new Map();   // pair|bot → lending row
  const lendings = [];
  for (const s of lines) {
    if (s.act === 'start') { for (const row of open.values()) row.runEnded = true; open.clear(); continue; }
    if (s.act === 'made') { lendings.push({ pair: 'made', bot: s.bot, outMs: s.atMs, inMs: null, stuck: false, peers: null, count: s.count }); continue; }
    const key = `${s.pair}|${s.bot}`;
    if (s.act === 'out') {
      const peers = [...open.keys()].filter(k => k.startsWith(`${s.pair}|`)).length;
      const row = { pair: s.pair, bot: s.bot, outMs: s.atMs, inMs: null, stuck: false, peers };
      open.set(key, row);
      lendings.push(row);
    } else if (open.has(key)) {
      const row = open.get(key);
      if (s.act === 'stuck') row.stuck = true; else { row.inMs = s.atMs; open.delete(key); }
    }
  }
  const iso = ms => (ms ? new Date(ms).toISOString().slice(11, 19) : null);
  const shown = lendings.filter(r => !botFilter || r.bot === botFilter);
  out.section('shears_book_counts');
  out.table(['pair', 'lent', 'returned', 'still_out', 'run_ended', 'stuck', 'lent_while_held'],
    ['leaf', 'pen'].map(p => { const rs = shown.filter(r => r.pair === p); return [p, rs.length, rs.filter(r => r.inMs).length, rs.filter(r => !r.inMs && !r.runEnded).length, rs.filter(r => r.runEnded).length, rs.filter(r => r.stuck).length, rs.filter(r => r.peers > 0).length]; }));
  out.kv('pairs_made', shown.filter(r => r.pair === 'made').reduce((n, r) => n + r.count, 0));
  out.section('shears_book');
  out.table(['out', 'in', 'pair', 'bot', 'held_s', 'peers_out', 'stuck'],
    shown.map(r => [iso(r.outMs), r.pair === 'made' ? 'made' : iso(r.inMs) ?? (r.runEnded ? 'run_ended' : 'still_out'), r.pair, r.bot, r.inMs ? r1((r.inMs - r.outMs) / 1000) : null, r.peers, r.stuck]));
}

function runHerding({ seg = [], foreman = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const { herds, ledger, faults, census, waits } = reduceHerding({ seg, bot: botFilter });
  out.kv('lens', 'herding');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);
  runPenWatch(seg, foreman, botFilter, verbose);
  // THE PEN, read first and whether or not a herd ran: the latest census each body wrote, then every change.
  if (census.length) {
    const latest = [..._byKey(census, c => c.bot)].map(([, cs]) => cs[cs.length - 1]).sort((a, b) => b.atSec - a.atSec);
    out.section('pen_now');
    out.table(['bot', 'at', 'structure', 'animal', 'penned', 'flock', 'free_seen', 'sections_open'],
      latest.map(c => [c.bot, clock(c.atSec), c.structure, c.animal, c.penned, c.flock, c.free_seen, c.sections_open]));
    if (verbose) {
      out.section('pen_census');
      out.table(['run', 'bot', 'at', 'penned', 'flock', 'free_seen', 'sections_open'],
        census.map(c => [c.run, c.bot, clock(c.atSec), c.penned, c.flock, c.free_seen, c.sections_open]));
    }
  }
  // The ledger and the waits are every job at the pen (a shepherd's hold, a shearing), herds or none.
  if (ledger.length) runLedger(ledger);
  if (waits.length) {
    out.section('herd_waits');
    out.table(['run', 'bot', 'at', 'for', 'waited_s', 'post_holder', 'word', 'seen', 'wheat', 'tender', 'holder'],
      waits.map(w => [w.run, w.bot, clock(w.atSec), w.for, w.waited_s ?? null, w.post_holder ?? null, w.word ?? null, w.seen ?? null, w.wheat ?? null, w.tender ?? null, w.holder ?? null]));
  }
  if (herds.length === 0) { out.zero('herds'); return 0; }

  const inPen = herds.filter(h => INTO_PEN.has(h.result));
  out.section('herding');
  out.kv('herds', herds.length);
  // Entity ids restart with the server, so an animal is a run and an id.
  out.kv('animals_into_pen', new Set(inPen.map(h => `${h.run}:${h.animal}`)).size);
  out.kv('penned_by_own_herder', herds.filter(h => h.result === 'penned').length);
  out.kv('followed_a_peer_in', herds.filter(h => h.result === 'penned_by_a_peer').length);
  out.kv('already_penned', herds.filter(h => h.result === 'already_penned').length);
  out.kv('not_into_pen', herds.length - inPen.length);
  out.kv('escaped_on_exit', sum(herds, h => h.escaped));
  out.kv('wheat_banked', sum(herds, h => h.banked));
  out.kv('herd_bot_min', r1(sum(herds, h => h.jobSec) / 60));
  out.kv('walk_blocks', Math.round(sum(herds, h => h.walkBlocks)));
  out.kv('gate_asks_refused', sum(herds, h => h.gateRefused));

  // Per run: when herding began and when the last animal went in.
  out.section('herding_by_run');
  // `animals_into_pen` counts each animal once; `herds_into_pen` counts every herd that ended with its animal in,
  // so two herds that both report one animal read as 2 against 1.
  out.table(['run', 'herds', 'herds_into_pen', 'animals_into_pen', 'first_claim', 'last_into_pen', 'span_min', 'herd_bot_min',
    'animals_per_bot_hour', 'walk_blocks', 'escaped_on_exit'],
    _byKey(herds, h => h.run).sort((a, b) => a[0] - b[0]).map(([run, hs]) => {
      const ins = hs.filter(h => INTO_PEN.has(h.result));
      const animals = new Set(ins.map(h => h.animal)).size;
      const first = Math.min(...hs.map(h => h.claimSec));
      const last = ins.length ? Math.max(...ins.map(h => h.endSec)) : null;
      const botMin = sum(hs, h => h.jobSec) / 60;
      return [run, hs.length, ins.length, animals, clock(first), clock(last), last != null ? r1((last - first) / 60) : null,
        r1(botMin), botMin > 0 ? r1((60 * animals) / botMin) : null, Math.round(sum(hs, h => h.walkBlocks)), sum(hs, h => h.escaped)];
    }));

  out.section('herding_by_result');
  out.table(['result', 'herds', 'avg_job_sec', 'avg_before_sec', 'avg_herd_sec', 'avg_after_sec', 'avg_walk_blocks', 'avg_legs', 'avg_gate_asks_refused'],
    _byKey(herds, h => h.result || 'unclosed').map(([k, hs]) => [k, hs.length, avg(hs, h => h.jobSec), avg(hs, h => h.beforeSec),
      avg(hs, h => h.herdSec), avg(hs, h => h.afterSec), avg(hs, h => h.walkBlocks), avg(hs, h => h.legs), avg(hs, h => h.gateRefused)]));

  // Every animal that went in, one row: the journey there (before + out), the lead, and back (after).
  out.section('herds_into_pen');
  out.table(['run', 'bot', 'claimed', 'animal', 'result', 'job_sec', 'before_sec', 'before_blocks', 'herd_sec', 'out_blocks',
    'lead_blocks', 'herd_walk_blocks', 'legs', 'reacquires', 'gate_asks_refused', 'after_sec', 'after_blocks', 'exit_wait_sec', 'escaped', 'banked', 'animal_at'],
    inPen.map(h => [h.run, h.bot, clock(h.claimSec), h.animal, h.result, r1(h.jobSec), r1(h.beforeSec), r1(h.beforeBlocks), h.herdSec,
      r1(h.outBlocks), r1(h.leadBlocks), r1(h.herdBlocks), h.legs, h.reacquires, h.gateRefused, r1(h.afterSec), r1(h.afterBlocks),
      h.exitWaitSec, h.escaped, h.banked, h.animalAt ? h.animalAt.join(',') : null]));

  if (faults.length) runFaults(faults);

  if (verbose) {
    out.section('herds_not_into_pen');
    out.table(['run', 'bot', 'claimed', 'animal', 'result', 'job_sec', 'herd_sec', 'herd_walk_blocks', 'legs', 'reacquires', 'gate_asks_refused', 'banked'],
      herds.filter(h => !INTO_PEN.has(h.result)).map(h => [h.run, h.bot, clock(h.claimSec), h.animal, h.result, r1(h.jobSec), h.herdSec,
        r1(h.herdBlocks), h.legs, h.reacquires, h.gateRefused, h.banked]));
    out.section('herding_by_bot');
    out.table(['bot', 'herds', 'into_pen', 'herd_bot_min', 'walk_blocks'],
      _byKey(herds, h => h.bot).map(([k, hs]) => [k, hs.length, hs.filter(h => INTO_PEN.has(h.result)).length,
        r1(sum(hs, h => h.jobSec) / 60), Math.round(sum(hs, h => h.walkBlocks))]));
  }
  return herds.length;
}

// The herd ledger as written: where the time at the pen went by step and role, the flocks, and one row per job.
// The steps of every design, so runs of any read whole: the tending design's (standby_queue, shepherd_wait, drop; the
// shepherd's walk, place, hold; the shearer's enter, shear, collect), the older tandem's (keep_before, keep,
// keeper_wait, handover, keep_after) and the parking-cell design's (park_wait, handoff, draw).
const LEDGER_PHASES = ['fetch', 'keep_before', 'seek', 'string', 'out', 'gather', 'lead', 'standby_queue', 'keep', 'breed', 'park_wait', 'handoff', 'keeper_wait',
  'shepherd_wait', 'gate_wait', 'walk', 'place', 'hold', 'enter', 'shear', 'collect', 'cross', 'handover', 'draw', 'drop', 'exit', 'keep_after', 'bank'];
const BRINGS = new Set(['herder', 'bringer', 'keeper_then_bringer']);
const HOLDS = new Set(['keeper', 'shepherd']);
// A job's seconds: its own total where it wrote one, else its steps summed.
const rowSec = r => (Number.isFinite(r.total_s) ? r.total_s : LEDGER_PHASES.reduce((t, p) => t + (r[`${p}_s`] || 0), 0));
function runLedger(ledger) {
  const IN = new Set(['penned', 'handed_off', 'penned_by_a_peer', 'already_penned']);
  out.section('herd_ledger_by_run');
  out.table(['run', 'herds', 'herders', 'handoffs', 'holds', 'shearings', 'flocks_taken_in', 'animals_taken_in', 'avg_flock', 'first_close', 'last_close', 'span_min', 'herd_bot_min', 'animals_per_bot_hour'],
    _byKey(ledger, r => r.run).sort((a, b) => a[0] - b[0]).map(([run, rs]) => {
      const herders = rs.filter(r => BRINGS.has(r.role));
      const flocks = herders.filter(r => r.result === 'penned');
      const animals = sum(flocks, r => r.flock_in);
      const botMin = sum(rs, rowSec) / 60;
      const first = Math.min(...rs.map(r => r.atSec)), last = Math.max(...rs.map(r => r.atSec));
      return [run, rs.length, herders.length, rs.filter(r => r.role === 'handoff' && r.result === 'handed_off').length,
        sum(rs, r => (r.kept_for || r.held_for ? 1 : 0) + (r.kept_before_for ? 1 : 0) + (r.kept_after_for ? 1 : 0)), rs.filter(r => r.role === 'shearer').length,
        flocks.length, animals, flocks.length ? r1(animals / flocks.length) : null, clock(first), clock(last), r1((last - first) / 60), r1(botMin), botMin > 0 ? r1((60 * animals) / botMin) : null];
    }));
  out.section('herd_time_by_phase');
  out.table(['role', 'herds', ...LEDGER_PHASES.map(p => `${p}_bot_min`), 'total_bot_min'],
    _byKey(ledger, r => r.role || 'none').map(([role, rs]) => [role, rs.length, ...LEDGER_PHASES.map(p => r1(sum(rs, r => r[`${p}_s`]) / 60)), r1(sum(rs, rowSec) / 60)]));
  // HOW LONG EACH PART TAKES: per role and result, the average seconds of every step a job of it took, and its average
  // total. Only the steps some job of the row took are filled.
  out.section('herd_time_by_step');
  out.table(['role', 'result', 'jobs', ...LEDGER_PHASES.map(p => `avg_${p}_s`), 'avg_total_s', 'min_total_s', 'max_total_s'],
    _byKey(ledger, r => `${r.role || 'none'}|${r.result}`).map(([k, rs]) => {
      const [role, result] = k.split('|');
      const totals = rs.map(rowSec);
      return [role, result, rs.length, ...LEDGER_PHASES.map(p => avg(rs, r => r[`${p}_s`] ?? null)), avg(rs, rowSec), r1(Math.min(...totals)), r1(Math.max(...totals))];
    }));
  // THE HOLDS (shepherd_manager; keep_manager in the older runs): one row per hold, with the reach check over the flock.
  out.section('herd_holds');
  out.table(['run', 'bot', 'closed', 'result', 'held_for', 'total_s', 'walk_s', 'place_s', 'hold_s', 'penned', 'in_reach', 'out_of_reach', 'swept', 'sweep_missed', 'at', 'off_cell', 'out_at'],
    ledger.filter(r => HOLDS.has(r.role)).map(r => [r.run, r.bot, clock(r.atSec), r.result, r.held_for ?? r.kept_for ?? null, r1(rowSec(r)), r.walk_s ?? null, r.place_s ?? null,
      r.hold_s ?? r.keep_s ?? null, r.penned, r.in_reach, r.out_of_reach, r.swept ?? null, r.sweep_missed ?? null, r.shepherd_at ?? r.keeper_at ?? null, r.off_cell ?? null, r.out_at]));
  // THE SHEARINGS (shear_manager): one row per shearing, with what the server said of the flock's wool.
  out.section('herd_shears');
  out.table(['run', 'bot', 'closed', 'result', 'total_s', 'shepherd_wait_s', 'shear_s', 'color', 'penned', 'woolly', 'shorn', 'wool_got', 'woolly_left', 'shepherd', 'escaped', 'exit_fault', 'banked'],
    ledger.filter(r => r.role === 'shearer').map(r => [r.run, r.bot, clock(r.atSec), r.result, r1(rowSec(r)), r.shepherd_wait_s ?? null, r.shear_s ?? null, r.color ?? null, r.penned, r.woolly, r.shorn,
      r.wool_got, r.woolly_left, r.shepherd, r.escaped, r.exit_fault, r.banked]));
  // THE CULLS (cull_manager): one row per cull of a full meat pen, with the grown animals the server named.
  out.section('herd_culls');
  out.table(['run', 'bot', 'closed', 'result', 'total_s', 'shepherd_wait_s', 'cull_s', 'animal', 'penned', 'grown', 'wanted', 'culled', 'left', 'produce_got', 'leather_got', 'drops_left', 'weapon', 'shepherd', 'escaped', 'exit_fault', 'banked'],
    ledger.filter(r => r.role === 'culler').map(r => [r.run, r.bot, clock(r.atSec), r.result, r1(rowSec(r)), r.shepherd_wait_s ?? null, r.cull_s ?? null, r.animal ?? null, r.penned, r.grown, r.wanted, r.culled,
      r.left, r.produce_got, r.leather_got ?? null, r.drops_left ?? null, r.weapon, r.shepherd, r.escaped, r.exit_fault, r.banked]));
  // THE BREEDS (breed_manager): one row per feed, with what the server said of the penned flock.
  out.section('herd_breeds');
  // A round on the clock (breed_manager) carries pairs/penned/refused; a one-pair feed in an older record carries
  // asked/ready/room/next_ready_s. Both are read; the empty cells say which kind each row is.
  out.table(['run', 'bot', 'closed', 'result', 'breed_s', 'pairs', 'penned', 'fed', 'refused', 'in_love', 'asked', 'ready', 'room', 'next_ready_s'],
    ledger.filter(r => r.role === 'breeder').map(r => [r.run, r.bot, clock(r.atSec), r.result, r.breed_s, r.pairs ?? null, r.penned ?? null, r.fed,
      r.refused ?? null, r.in_love, r.asked ?? null, r.ready ?? null, r.room ?? null, r.next_ready_s ?? null]));
  // THE DYEINGS (dye_manager): one row per dyeing, with the colors the server said before and after.
  out.section('herd_dyes');
  out.table(['run', 'bot', 'closed', 'result', 'color', 'fetch_s', 'dye_s', 'asked', 'white', 'wanted', 'dyed', 'now_color', 'banked'],
    ledger.filter(r => r.role === 'dyer').map(r => [r.run, r.bot, clock(r.atSec), r.result, r.color, r.fetch_s, r.dye_s, r.asked, r.white, r.wanted, r.dyed, r.now_color, r.banked]));
  out.section('herd_ledger');
  out.table(['run', 'bot', 'closed', 'result', 'role', 'animal', 'total_s', ...LEDGER_PHASES.map(p => `${p}_s`), 'legs', 'reacquires', 'string', 'string_blocks', 'gathered', 'flock', 'flock_in', 'missed', 'pen_count', 'passes', 'stragglers', 'stragglers_at', 'stuck', 'axis_spikes', 'axis_dug', 'off_cell', 'handed_to', 'kept_for', 'keeper', 'shepherd', 'handed_over', 'keeper_left', 'foreign', 'shooed', 'foreign_at_heel', 'foreign_penned', 'kept_before_for', 'kept_after_for', 'keep_fault', 'escaped', 'escaped_at', 'exit_fault', 'banked', 'animal_at', 'into_pen'],
    ledger.map(r => [r.run, r.bot, clock(r.atSec), r.result, r.role, r.animal, r1(rowSec(r)), ...LEDGER_PHASES.map(p => r[`${p}_s`] ?? null), r.legs, r.reacquires,
      r.string ?? null, r.string_blocks ?? null, r.gathered ?? null, r.flock, r.flock_in, r.missed, r.pen_count, r.passes, r.stragglers, r.stragglers_at, r.stuck, r.axis_spikes, r.axis_dug, r.off_cell, r.handed_to, r.kept_for, r.keeper, r.shepherd, r.handed_over, r.keeper_left, r.foreign, r.shooed, r.foreign_at_heel, r.foreign_penned, r.kept_before_for, r.kept_after_for, r.keep_fault, r.escaped, r.escaped_at, r.exit_fault, r.banked, r.animal_at, IN.has(r.result)]));
}

// Every failed herd as the herder surveyed it: where the animal stood and what held it (herd_executor.faultSurvey).
// [herd_faults_by_hold] counts the faults by each thing the survey can name holding the animal; one fault can carry
// several. walls_2_high counts the sides two blocks high; three or four is a hole the animal cannot climb out of.
const FAULT_FIELDS = ['fault', 'animal', 'legs', 'reacquires', 'stuck', 'sensed', 'animal_at', 'animal_now', 'dist', 'dy', 'feet', 'floor',
  'in_water', 'walls_2_high', 'step_ups', 'drops', 'fenced', 'closed_by', 'last_nav', 'herder_at'];
function runFaults(faults) {
  out.section('herd_faults_by_hold');
  const holds = [
    ['animal_not_sensed', f => f.sensed === false],
    ['in_water', f => f.in_water === true],
    ['walls_2_high_3_plus', f => (f.walls_2_high || 0) >= 3],
    ['fenced', f => (f.fenced || 0) > 0],
    ['closed_ground', f => !!f.closed_by],
    ['herder_below_by_2_plus', f => (f.dy || 0) >= 2],
    ['herder_above_by_2_plus', f => (f.dy || 0) <= -2],
    ['nav_reason_given', f => !!f.last_nav],
  ];
  out.table(['hold', 'faults'], holds.map(([k, test]) => [k, faults.filter(test).length]));
  out.section('herd_faults_by_fault');
  out.table(['fault', 'count'], _byKey(faults, f => f.fault).map(([k, fs]) => [k, fs.length]));
  out.section('herd_faults_by_nav_reason');
  out.table(['last_nav', 'count'], _byKey(faults.filter(f => f.last_nav), f => f.last_nav).map(([k, fs]) => [k, fs.length]));
  out.section('herd_faults');
  out.table(['run', 'bot', 'at', ...FAULT_FIELDS], faults.map(f => [f.run, f.bot, clock(f.atSec), ...FAULT_FIELDS.map(k => f[k] ?? null)]));
}

module.exports = { reduceHerding, runHerding };
