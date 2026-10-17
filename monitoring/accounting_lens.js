/*
accounting_lens.js — what the run bought, in one read: labour, material, and the four sites.

The questions it exists to answer: where did the bot-minutes go, what was gathered and of what kind, were
the fixtures placed, were the trees cleared, how far did the anchor cubes get, how deep is the mine, and
where did the stone actually come from.

── IT COMPOSES, IT DOES NOT RE-DERIVE (Law 16) ──────────────────────────────────────────────────────
Labour comes from `job_timeline_lens.reduceBotMinutes` — the bodies' own worked/idle ledger lines, a
stronger measure than summing job durations because it accounts for the time between jobs. Material comes
from `census_lens.reduceCensus`, whose end-of-run sum is the honest total. Per-job labour comes from
`reduceJobTimeline.byType`. Only the four site readings below are new here, since nothing else folds them.

── THE ONE THING THIS LENS WILL NOT DO ──────────────────────────────────────────────────────────────
It reports `stone_prospect` as a source with a zero when no pierce job ran; it never omits the row. A
source missing from the table would read as not considered, where a source present at zero reads as asked
and answered — a question the table should answer standing still, without anyone having to know the
verb's name.
*/

'use strict';

const { relativeTime, percent } = require('./report_formatting');
const { FOREMAN_UNITS } = require('./trace_read');
const { reduceBotMinutes, reduceJobTimeline } = require('./job_timeline_lens');
const { reduceCensus, COLUMN_TRIP_RE } = require('./census_lens');
const out = require('./data_out');

// 📊 build_column_executor: column 12 cube 108 layer 1 — dug 64, placed 21, failed 0[, shaft 9 placed 0 failed][, climb stopped at y71]
// One line per trip into a downloaded building. The ground is cleared by these same trips, so `dug` is
// the ground moved.
// One line per cube trip: what stood wrong on arrival, as found>wanted counts (build_column_executor.workCube).
const CUBE_FOUND_RE = /CUBE_FOUND cube=(\d+) layer=(\d+) wrong=(\S+)/;
const CUBES_FINISHED_RE = /CUBES_FINISHED done=(\d+) of=(\d+) by_layer=(\S+)/;
// The layer the castle posted cubes on, said by each body when it changes (assessors/downloaded_build noteOpenLayer).
const OPEN_LAYER_RE = /OPEN_LAYER layer=(\d+) posted=(\d+)/;
const CUBES_WAITING_ON_RE = /CUBES_WAITING_ON cubes=(\d+) cells=(\d+) cells_by=(\S+) cubes_by=(\S+)/;
const CUBE_WAITS_RE = /CUBE_WAITS cube=(\d+) layer=(\d+) column=(\d+) cells=(\d+) on=(\S+)/;
const CUBE_RE = COLUMN_TRIP_RE;

// 📊 <type> <id> settle: <stop> after 2 cycle(s) — dug 12, placed 3, 0 step(s) left
// One line per mining segment worked to a stop (anchored_repair.settle): a staircase copy or a cell.
const SETTLE_RE = /(\S+) (\S+) settle: (\w+) after (\d+) cycle\(s\) — dug (\d+), placed (\d+), (\d+) step\(s\) left/;

// 📊 excavate frontier: staircase -75|61|-99 y=59..61 … | built 3/19 shaft_center=(-84,70,-99)
const FRONTIER_RE = /staircase (-?\d+)\|(-?\d+)\|(-?\d+) y=(-?\d+)\.\.(-?\d+)/;
const SHAFT_RE    = /built (\d+)\/(\d+) shaft_center=\((-?\d+),(-?\d+),(-?\d+)\)/;

// 📊 Segment -84|70|-99 fully excavated → registered built in HQ
const SEGMENT_RE = /Segment (-?\d+\|-?\d+\|-?\d+) fully excavated/;

// 📊 trees/overgrown_survival_castle: 33 tree(s) in 41x53, 3 claimed + 0 peer(s) working → posting …
// 📊 trees/laydown_yard: 0 trunk(s) standing in 7x4 at (…), site loaded — PHASE CLOSED, permanently.
const TREES_SEEN_RE   = /trees\/(\w+): (\d+) tree\(s\) in (\d+x\d+)/;
const TREES_CLOSED_RE = /trees\/(\w+): 0 trunk\(s\) standing in (\d+x\d+).*PHASE CLOSED/;

// 📊 "laydown_yard" — 24/25 structure placed · 1 to place, 0 to dig · 59 no-work cells (31 air + 28 …)
const PLACED_RE   = /"([^"]+)" — (\d+)\/(\d+) structure placed.*?(\d+) no-work cell/;
const COMPLETE_RE = /"([^"]+)" matches the blueprint/;

// 📊 laydown_yard all_complete after 1 iteration(s): dig=0/0 place=3/3 …
const ALL_COMPLETE_RE = /(\w+) all_complete after \d+ iteration/;

// 📊 Claimed [rank] token … — dispatching to supply_manager.
const DISPATCH_RE = /dispatching to (\w+)/;

// THE FOUR VERBS THAT CAN PUT STONE IN A POCKET, named as a closed list so the table can carry a zero
// for one that never ran. `stone_prospect_executor` is the surface column pierce; `mining_manager` owns
// both the shaft descent and the cells; the cube trips and the salvage pick up whatever the site held.
const STONE_VERBS = ['mining_manager', 'stone_prospect_executor', 'build_column_executor', 'ground_salvage_executor'];

const STONE_ITEMS = new Set(['cobblestone', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'tuff']);

// 📊 Dispatching mining_executor for cell -32|14|-97 @ (-32,14,-97) — pass 1/3 on this cell, 4 pickaxes in hand.
const CELL_DISPATCH_RE = /Dispatching mining_executor for cell (\S+) @ \((-?\d+),(-?\d+),(-?\d+)\) — pass (\d+)\/\d+ on this cell, (\d+) pickaxes/;
// 📊 cell -32|14|-97 complete (diff clean) — 3 neighbour(s) registered — 3 pickaxes in hand, continuing this trip at cell …
const CELL_COMPLETE_RE = /cell (-?\d+\|-?\d+\|-?\d+) complete \(diff clean\) — (\d+) neighbour/;
const CELL_REPAIRED_RE = /cell (-?\d+\|-?\d+\|-?\d+) repaired \(diff clean\)/;
const CELL_STUCK_RE    = /cell (-?\d+\|-?\d+\|-?\d+) (?:repair )?stuck —/;
const CELL_OPEN_RE     = /cell (-?\d+\|-?\d+\|-?\d+) left open at/;
const CELL_CHAIN_RE    = /continuing this trip at cell (-?\d+\|-?\d+\|-?\d+)/;
const CELL_LAST_PICK_RE = /down to the last pickaxe/;
// 📊 underground_cell -32|14|-97 settle: clean after 2 cycle(s) — dug 61, placed 4, 0 step(s) left
const CELL_SETTLE_RE = /(\S*cell\S*) (-?\d+\|-?\d+\|-?\d+) settle: \w+ after \d+ cycle\(s\) — dug (\d+), placed (\d+)/;
// Cells sit this many blocks apart, centre to centre (mining_cell_graph CELL_SPACING); a ring is one spacing.
const CELL_SPACING = 4;

// What the run took from the world is the item book's (item_book_lens.gatheredOf): pickups of drops
// the fleet did not make. The building's own ratio is the one line the bodies still print for it.
const RATIO_RE = /ratio target iron_ingots=(\d+) cobblestone=(\d+) cobblestone_per_iron=(\d+)/;
function reduceGathered({ seg = [], bot: botFilter = null } = {}) {
  const itemBook = require('./item_book_lens');
  let target = null;
  for (const l of seg) {
    const t = RATIO_RE.exec(l.raw || '');
    if (t) target = { iron_ingots: +t[1], cobblestone: +t[2], cobblestone_per_iron: +t[3] };
  }
  return { ...itemBook.gatheredOf(itemBook.readBook(), botFilter), target };
}

// A STRIP TRIP, ONE DESCENT: opened by a body's first `Dispatching mining_executor for cell` after a release, closed
// by its next `Releasing:`. A trip is a strip trip when a VEINS line (logged once per strip segment) falls inside it.
// line_moves counts `STRIP LINE` (the next segment of the same tunnel); the end is the `STRIP LINE END` reason, else
// the release's own reason.
const TRIP_DISPATCH_RE = /Dispatching mining_executor for cell (\S+) @/;
const TRIP_LINE_RE = /STRIP LINE (trunk|branch) (\w+) (\S+) -> (\S+)/;
const TRIP_END_RE = /STRIP LINE END (trunk|branch) (\w+) at (\S+): (.*?) — surfacing/;
const TRIP_VEINS_RE = /VEINS \S+ dug=(\d+) \| mined (.*?) \| passed (.*)$/;
const TRIP_DROPS_RE = /\[MINING_EXECUTOR\].*drop_collector: \S+ picked=(\d+)\/(\d+)/;
const TRIP_RELEASE_RE = /\[MINING_MANAGER\].*Releasing: (.*)$/;
const TRIP_REPAIR_RE = /\[MINING_MANAGER\].*cell \S+ repaired \(diff clean\)/;
function reduceStripTrips({ seg = [], bot: botFilter = null } = {}) {
  const byBot = new Map();
  const seen = new Set();
  for (const l of seg) {
    if (!l.bot || FOREMAN_UNITS.has(l.bot)) continue;
    if (botFilter && l.bot !== botFilter) continue;
    const raw = (l.raw || '').replace(/"$/, '');
    if (!/MINING_MANAGER|MINING_EXECUTOR/.test(raw)) continue;
    const key = `${l.bot}|${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byBot.has(l.bot)) byBot.set(l.bot, []);
    byBot.get(l.bot).push({ at: l.wallSec, raw });
  }
  const trips = [];
  for (const [bot, lines] of byBot) {
    lines.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    let t = null;
    for (const { at, raw } of lines) {
      let m;
      if ((m = TRIP_DISPATCH_RE.exec(raw))) {
        if (!t) t = { bot, at, start: m[1], kind: null, dir: null, cells: new Set(), moves: 0, repairs: 0, veins: 0, iron: 0, mined: {}, passed: {}, dropsPicked: 0, dropsSeen: 0, end: null, strip: false };
        t.cells.add(m[1]);
      } else if (!t) {
        continue;
      } else if ((m = TRIP_LINE_RE.exec(raw))) {
        t.strip = true; t.moves++; t.kind = t.kind || m[1]; t.dir = t.dir || m[2];
      } else if ((m = TRIP_END_RE.exec(raw))) {
        t.strip = true; t.kind = t.kind || m[1]; t.dir = t.dir || m[2]; t.end = m[4];
      } else if (TRIP_REPAIR_RE.test(raw)) {
        t.repairs++;
      } else if ((m = TRIP_VEINS_RE.exec(raw))) {
        t.strip = true; t.veins += +m[1];
        for (const pair of m[2].split(/\s+/)) { const [n, c] = pair.split('='); if (c) t.mined[n] = (t.mined[n] || 0) + +c; }
        for (const pair of m[3].split(/\s+/)) { const [n, c] = pair.split('='); if (c) t.passed[n] = (t.passed[n] || 0) + +c; }
      } else if ((m = TRIP_DROPS_RE.exec(raw))) {
        t.dropsPicked += +m[1]; t.dropsSeen += +m[2];
      } else if ((m = TRIP_RELEASE_RE.exec(raw))) {
        if (!t.end) t.end = /pickax/i.test(m[1]) ? 'pickaxes_used_up' : /pledge of iron/.test(m[1]) ? 'iron_pledge_banked' : m[1].replace(/-?\d+\|-?\d+\|-?\d+/g, '<cell>').replace(/\d+/g, 'N').slice(0, 90);
        if (t.strip) trips.push(t);
        t = null;
      }
    }
    if (t && t.strip) { t.end = t.end || 'run_ended_mid_trip'; trips.push(t); }
  }
  trips.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return trips;
}

// THE FAN, READ OFF THE RECORD. The bodies log no cell's prime, so the lens recovers it from the one fact
// selection guarantees: until a floor's first cell completes, the only cells registered on it are its
// primes (the seeds off the staircase), so every cell first dispatched on a floor before that floor's
// first completion is a prime. A cell's ring is its XZ distance to the nearest prime on its floor over
// CELL_SPACING — the key selectNextCell sorts by. `out_of_ring_starts` counts cells first dispatched while
// a cell on the same floor with a LOWER ring had been started and was not yet complete; a peer holding
// that lower cell is the expected reason, so the count is a figure to read, not a fault.
function reduceCells({ seg = [], bot: botFilter = null } = {}) {
  const cells = new Map();
  const counts = { dispatches: 0, chained: 0, surfacedLastPick: 0, repairs: 0, stuckEvents: 0, leftOpen: 0 };
  const seen = new Set();
  const cellOf = (id) => {
    if (!cells.has(id)) {
      const [x, y, z] = id.split('|').map(Number);
      cells.set(id, { id, x, y, z, firstDispatch: null, dispatches: 0, completeAt: null, completeBy: null,
        dug: 0, placed: 0, stuck: false, open: 0, bots: new Set() });
    }
    return cells.get(id);
  };
  for (const l of seg) {
    if (l.bot && FOREMAN_UNITS.has(l.bot)) continue;
    if (botFilter && l.bot && l.bot !== botFilter) continue;
    const raw = l.raw || '';
    const once = (text) => { const k = `${l.bot || '?'}|${text}`; if (seen.has(k)) return false; seen.add(k); return true; };
    let m;
    if ((m = CELL_DISPATCH_RE.exec(raw))) {
      const c = cellOf(m[1]);
      counts.dispatches++; c.dispatches++; c.bots.add(l.bot);
      if (c.firstDispatch === null || (l.wallSec != null && l.wallSec < c.firstDispatch)) c.firstDispatch = l.wallSec;
    }
    if ((m = CELL_COMPLETE_RE.exec(raw))) {
      const c = cellOf(m[1]);
      if (l.wallSec != null && (c.completeAt === null || l.wallSec < c.completeAt)) { c.completeAt = l.wallSec; c.completeBy = l.bot; }
    }
    if ((m = CELL_REPAIRED_RE.exec(raw)) && once(m[0])) counts.repairs++;
    if ((m = CELL_STUCK_RE.exec(raw)) && once(m[0])) { cellOf(m[1]).stuck = true; counts.stuckEvents++; }
    if ((m = CELL_OPEN_RE.exec(raw)) && once(m[0])) { cellOf(m[1]).open++; counts.leftOpen++; }
    if ((m = CELL_CHAIN_RE.exec(raw)) && once(`${m[0]}@${l.wallSec}`)) counts.chained++;
    if (CELL_LAST_PICK_RE.test(raw) && once(`${raw}@${l.wallSec}`)) counts.surfacedLastPick++;
    if ((m = CELL_SETTLE_RE.exec(raw)) && once(m[0])) {
      const c = cellOf(m[2]);
      c.dug += Number(m[3]); c.placed += Number(m[4]);
    }
  }

  // Primes and rings, per floor.
  const floors = new Map();
  for (const c of cells.values()) {
    if (!floors.has(c.y)) floors.set(c.y, []);
    floors.get(c.y).push(c);
  }
  const rows = [];
  let outOfRing = 0;
  for (const [y, list] of floors) {
    const firstComplete = Math.min(...list.map(c => c.completeAt ?? Infinity));
    const primes = list.filter(c => c.firstDispatch !== null && c.firstDispatch < firstComplete);
    // The fan's centre is the middle of the floor's primes — the staircase door they were seeded either
    // side of. The staircase walks sideways as it descends, so the shaft's collar is not a floor's centre.
    const cx = primes.length ? primes.reduce((s, p) => s + p.x, 0) / primes.length : null;
    const cz = primes.length ? primes.reduce((s, p) => s + p.z, 0) / primes.length : null;
    for (const c of list) {
      c.ring = primes.length
        ? +Math.min(...primes.map(p => Math.hypot(c.x - p.x, c.z - p.z) / CELL_SPACING)).toFixed(2)
        : null;
      c.prime = primes.includes(c);
      if (cx === null) { c.side = null; continue; }
      const dx = c.x - cx, dz = c.z - cz;
      const ns = dz < -1 ? 'north' : dz > 1 ? 'south' : '';
      const ew = dx < -1 ? 'west' : dx > 1 ? 'east' : '';
      c.side = [ns, ew].filter(Boolean).join('_') || 'centre';
    }
    for (const c of list) {
      if (c.firstDispatch === null || c.ring === null) continue;
      const lowerOpen = list.some(o => o !== c && o.ring !== null && o.ring < c.ring - 0.01
        && o.firstDispatch !== null && o.firstDispatch <= c.firstDispatch
        && (o.completeAt === null || o.completeAt > c.firstDispatch));
      if (lowerOpen) outOfRing++;
    }
    rows.push(...list);
  }
  rows.sort((a, b) => (a.completeAt ?? Infinity) - (b.completeAt ?? Infinity) || (a.firstDispatch ?? Infinity) - (b.firstDispatch ?? Infinity));
  return { rows, counts, outOfRing, floors: [...floors.keys()].sort((a, b) => a - b) };
}

function botMin(sec) { return sec == null ? null : +(sec / 60).toFixed(1); }

function reduceAccounting({ seg = [], bot: botFilter = null } = {}) {
  const labour  = reduceBotMinutes({ seg, bot: botFilter });
  const timeline = reduceJobTimeline({ seg, bot: botFilter });
  const census  = reduceCensus({ seg });

  // ── THE FOUR SITE READINGS ──────────────────────────────────────────────────────────────────────
  const cubes = { waitsTotal: new Map(), waitsByBot: new Map(), trips: 0, dug: 0, placed: 0, failed: 0, shaftPlaced: 0, climbStopped: 0, zeroYield: 0,
    cubeSet: new Set(), columnSet: new Set(), finished: null, byCube: new Map(), found: new Map(), foundTrips: 0, foundNone: 0, visits: [],
    openLayers: new Map() };          // layer → first fleet second any body said it was the open layer
  const settles = new Map();         // "kind stop" → { kind, stop, count, cycles, dug, placed, left }
  const segments = new Set();
  const shaft  = { built: null, total: null, centre: null, topY: null, deepY: null };
  const trees  = new Map();          // site → { box, firstSeen, lastSeen, maxSeen, closed, closedAtSec }
  const builds = new Map();          // structure → { placed, total, noWork, completeAtSec, completeBy }
  const dispatches = new Map();      // executor → count

  // ── ONE EVENT, TWO LINES — THE COUNTERS MUST NOT BELIEVE BOTH ───────────────────────────────────
  // A producing executor writes its result line with `watcher.summary`, then hands the same text to
  // `routeToJudge` as `payload.readable`, which records it again. So every terraform pass and every
  // mining lane pass appears twice in the trace, and a counter that adds both doubles the run's work.
  //
  // The key is bot + exact text, not bot + text + timestamp. The two records of one event do not always
  // carry the same stamp (the judge's lands a tick later), so including time would defeat the dedupe
  // entirely. The cost of the coarser key is that one body cutting an identical line twice with identical
  // counts is counted once; the cost of the finer one is that every number in this section is double.
  // Undercounting by a single repeat beats doubling the whole table (Law 25 — and the counted-once figure
  // is stated as such).
  const seenEvent = new Set();

  for (const l of seg) {
    if (l.bot && FOREMAN_UNITS.has(l.bot)) continue;
    if (botFilter && l.bot && l.bot !== botFilter) continue;
    const raw = l.raw || '';
    // `fresh` answers whether this exact event from this exact body has already been counted. Called only by the
    // counters that fold a PRODUCING executor's result line; the trees, builds and dispatch counters
    // below are idempotent by construction (max, earliest-wins, per-claim) and must not use it.
    const fresh = (text) => {
      const key = `${l.bot || '?'}|${text}`;
      if (seenEvent.has(key)) return false;
      seenEvent.add(key);
      return true;
    };
    let m;

    if ((m = DISPATCH_RE.exec(raw))) dispatches.set(m[1], (dispatches.get(m[1]) || 0) + 1);

    if ((m = CUBE_RE.exec(raw)) && fresh(m[0])) {
      cubes.trips++;
      cubes.columnSet.add(Number(m[1])); cubes.cubeSet.add(Number(m[2]));
      const layer = Number(m[3]);
      cubes.dug += Number(m[4]); cubes.placed += Number(m[5]); cubes.failed += Number(m[6]);
      if (m[7]) cubes.shaftPlaced += Number(m[8]);
      if (m[10]) cubes.climbStopped++;
      if (Number(m[4]) === 0 && Number(m[5]) === 0) cubes.zeroYield++;
      const cube = cubes.byCube.get(Number(m[2])) || { column: Number(m[1]), cube: Number(m[2]), layer, trips: [], bots: new Set() };
      cube.trips.push({ sec: l.wallSec ?? null, dug: Number(m[4]), placed: Number(m[5]), failed: Number(m[6]) });
      if (l.bot) cube.bots.add(l.bot);
      cubes.byCube.set(cube.cube, cube);
    }

    if ((m = CUBE_FOUND_RE.exec(raw)) && fresh(m[0])) cubes.visits.push({ sec: l.wallSec ?? 0, cube: m[1], wrong: m[3] });

    if ((m = OPEN_LAYER_RE.exec(raw)) && l.wallSec != null) {
      const at = cubes.openLayers.get(Number(m[1]));
      if (at === undefined || l.wallSec < at) cubes.openLayers.set(Number(m[1]), l.wallSec);
    }

    // Every body counts the finished cubes it can see; a body away from the site sees fewer. The fullest
    // count is the building's.
    if ((m = CUBES_FINISHED_RE.exec(raw)) && (!cubes.finished || Number(m[1]) >= cubes.finished.done)) {
      cubes.finished = { done: Number(m[1]), of: Number(m[2]),
        layers: m[3].split(',').map(p => { const [layer, n] = p.split(':'); const [d, t] = n.split('/'); return [Number(layer), Number(d), Number(t)]; }) };
    }

    // What the waiting cubes wait on: each body's last total, and each cube's last stated line per body.
    if ((m = CUBES_WAITING_ON_RE.exec(raw))) {
      cubes.waitsTotal.set(l.bot || 'fleet', { cubes: Number(m[1]), cells: Number(m[2]), cellsBy: m[3], cubesBy: m[4] });
    }
    if ((m = CUBE_WAITS_RE.exec(raw))) {
      const mine = cubes.waitsByBot.get(l.bot || 'fleet') || new Map();
      if (m[5] === 'none') mine.delete(Number(m[1]));
      else mine.set(Number(m[1]), { cube: Number(m[1]), layer: Number(m[2]), column: Number(m[3]), cells: Number(m[4]), on: m[5] });
      cubes.waitsByBot.set(l.bot || 'fleet', mine);
    }

    if ((m = SETTLE_RE.exec(raw)) && fresh(m[0])) {
      const key = `${m[1]} ${m[3]}`;
      const row = settles.get(key) || { kind: m[1], stop: m[3], count: 0, cycles: 0, dug: 0, placed: 0, left: 0 };
      row.count++; row.cycles += Number(m[4]); row.dug += Number(m[5]); row.placed += Number(m[6]); row.left += Number(m[7]);
      settles.set(key, row);
    }

    if ((m = SEGMENT_RE.exec(raw))) segments.add(m[1]);

    if ((m = FRONTIER_RE.exec(raw))) {
      const lo = Number(m[4]);
      if (shaft.deepY === null || lo < shaft.deepY) shaft.deepY = lo;
      const hi = Number(m[5]);
      if (shaft.topY === null || hi > shaft.topY) shaft.topY = hi;
    }
    if ((m = SHAFT_RE.exec(raw))) {
      const built = Number(m[1]);
      if (shaft.built === null || built > shaft.built) shaft.built = built;
      shaft.total = Number(m[2]);
      shaft.centre = `${m[3]},${m[4]},${m[5]}`;
    }

    if ((m = TREES_CLOSED_RE.exec(raw))) {
      const row = trees.get(m[1]) || { site: m[1], box: m[2], maxSeen: 0, lastSeen: null, lastSeenSec: null, closed: false, closedAtSec: null };
      row.box = m[2]; row.closed = true;
      if (row.closedAtSec === null || (l.wallSec != null && l.wallSec < row.closedAtSec)) row.closedAtSec = l.wallSec;
      trees.set(m[1], row);
    } else if ((m = TREES_SEEN_RE.exec(raw))) {
      const row = trees.get(m[1]) || { site: m[1], box: m[3], maxSeen: 0, lastSeen: null, lastSeenSec: null, closed: false, closedAtSec: null };
      const n = Number(m[2]);
      row.box = m[3];
      if (n > row.maxSeen) row.maxSeen = n;
      // THE LAST SCAN IN FLEET-CLOCK ORDER, not in file order. Twenty per-bot files concatenated are not
      // a timeline, and reading the last line of the concatenation as "the final count" is how a stale
      // sweep gets reported as the end state (this lens exists partly because that happened).
      if (l.wallSec != null && (row.lastSeenSec === null || l.wallSec > row.lastSeenSec)) {
        row.lastSeenSec = l.wallSec; row.lastSeen = n;
      }
      trees.set(m[1], row);
    }

    if ((m = PLACED_RE.exec(raw))) {
      const row = builds.get(m[1]) || { structure: m[1], placed: 0, total: null, noWork: null, completeAtSec: null, completeBy: null };
      row.placed = Math.max(row.placed, Number(m[2]));
      row.total = Number(m[3]); row.noWork = Number(m[4]);
      builds.set(m[1], row);
    }
    if ((m = COMPLETE_RE.exec(raw)) || (m = ALL_COMPLETE_RE.exec(raw))) {
      const row = builds.get(m[1]) || { structure: m[1], placed: 0, total: null, noWork: null, completeAtSec: null, completeBy: null };
      if (row.completeAtSec === null || (l.wallSec != null && l.wallSec < row.completeAtSec)) {
        row.completeAtSec = l.wallSec; row.completeBy = l.bot || null;
      }
      builds.set(m[1], row);
    }
  }

  // Per-job labour, keyed the way --jobs keys it (`rank token`), reduced to the token alone, answering
  // what the fleet spent its life on: one job posted under two ranks is one activity. --jobs keeps the
  // ranks apart and stays the place to look for that.
  const byJob = new Map();
  for (const t of timeline.byType) {
    const token = t.token.includes(' ') ? t.token.slice(t.token.indexOf(' ') + 1) : t.token;
    const row = byJob.get(token) || { job: token, claims: 0, sec: 0, complete: 0, killed: 0, unfinished: 0 };
    row.claims += t.claims; row.sec += t.totalSec;
    row.complete += t.complete; row.killed += t.killed; row.unfinished += t.unfinished;
    byJob.set(token, row);
  }

  const stoneHeld = Object.entries(census.byItem)
    .filter(([n]) => STONE_ITEMS.has(n))
    .map(([item, v]) => ({ item, total: v.pockets + v.containers }))
    .sort((a, b) => b.total - a.total);

  return {
    labour, timeline, census,
    byJob: [...byJob.values()].sort((a, b) => b.sec - a.sec),
    cubes: { ...cubes, cubeCount: cubes.cubeSet.size, columnCount: cubes.columnSet.size },
    settles: [...settles.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count),
    segments: segments.size, shaft,
    trees: [...trees.values()],
    builds: [...builds.values()],
    dispatches, stoneHeld,
    stoneTotal: stoneHeld.reduce((s, r) => s + r.total, 0),
  };
}

function runAccounting({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const r = reduceAccounting({ seg, bot: botFilter });
  const fleetSec = r.labour.fleet?.life ?? 0;
  const workedSec = r.labour.fleet?.worked ?? 0;

  out.kv('lens', 'accounting');
  out.kv('record', traceName);
  out.kv('span', relativeTime(r.census.runSec || 0));
  if (botFilter) out.kv('bot_filter', botFilter);
  out.kv('bots', r.census.bots);

  // ── LABOUR ──────────────────────────────────────────────────────────────────────────────────────
  out.section('labour');
  out.kv('fleet_bot_min', botMin(fleetSec));
  out.kv('worked_bot_min', botMin(workedSec));
  out.kv('idle_bot_min', botMin(r.labour.fleet?.idle));
  out.kv('startup_bot_min', botMin(r.labour.fleet?.startup));
  out.kv('unaccounted_bot_min', botMin(r.labour.fleet?.unaccounted));
  out.kv('occupancy', percent(workedSec, fleetSec));
  out.kv('jobs_claimed', r.timeline.jobs.length);
  out.kv('ledger_seen', r.labour.ledgerSeen);

  // ── WASTE: IDLE TIME PLUS THE TIME SPENT IN JOBS THAT FAILED ────────────────────────────────────
  // A job's outcome is the record's own: `produced` when its manager said COMPLETE or any fragment in it
  // reported Success: true; `failed` when it was killed, stuck, or a fragment reported Success: false and
  // none reported true; `no_result_stated` when the record carries neither.
  // An executor's own JOB_RESULT line rules where the job wrote one.
  const outcomeOf = (j) => j.produced === true ? 'produced' : j.produced === false ? 'failed'
    : (j.verdict?.ok === true || j.steps > 0) ? 'produced'
    : (j.fails > 0 || j.verdict?.code === 'killed' || j.verdict?.code === 'stuck') ? 'failed' : 'no_result_stated';
  const waste = new Map();
  const total = { produced: 0, failed: 0, no_result_stated: 0 };
  for (const j of r.timeline.jobs) {
    const row = waste.get(j.token) || { token: j.token, claims: 0, produced: 0, failed: 0, no_result_stated: 0, nProduced: 0, nFailed: 0, nUnstated: 0 };
    const o = outcomeOf(j);
    row.claims++; row[o] += j.durationSec || 0; total[o] += j.durationSec || 0;
    if (o === 'produced') row.nProduced++; else if (o === 'failed') row.nFailed++; else row.nUnstated++;
    waste.set(j.token, row);
  }
  const idleSec = r.labour.fleet?.idle ?? 0;
  out.section('waste');
  out.kv('fleet_bot_min', botMin(fleetSec));
  out.kv('idle_bot_min', botMin(idleSec));
  out.kv('failed_job_bot_min', botMin(total.failed));
  out.kv('waste_bot_min', botMin(idleSec + total.failed));
  out.kv('waste_pct_of_fleet', percent(idleSec + total.failed, fleetSec));
  out.kv('produced_job_bot_min', botMin(total.produced));
  out.kv('no_result_stated_bot_min', botMin(total.no_result_stated));
  out.kv('no_result_stated_pct_of_fleet', percent(total.no_result_stated, fleetSec));

  out.section('waste_by_job');
  out.table(['job', 'claims', 'produced', 'failed', 'no_result_stated', 'produced_bot_min', 'failed_bot_min', 'no_result_stated_bot_min'],
    [...waste.values()].sort((a, b) => (b.failed + b.no_result_stated) - (a.failed + a.no_result_stated)).slice(0, verbose ? Infinity : 15)
      .map(w => [w.token, w.claims, w.nProduced, w.nFailed, w.nUnstated, botMin(w.produced), botMin(w.failed), botMin(w.no_result_stated)]));

  out.section('labour_by_job');
  out.table(
    ['job', 'claims', 'bot_min', 'share_of_worked', 'complete', 'killed', 'unfinished'],
    r.byJob.map(j => [j.job, j.claims, botMin(j.sec), percent(j.sec, r.timeline.workedSec), j.complete, j.killed, j.unfinished]),
  );

  if (verbose) {
    out.section('labour_by_bot');
    out.table(
      ['bot', 'worked_bot_min', 'idle_bot_min', 'jobs', 'share_of_life'],
      r.labour.rows.map(b => [b.bot, botMin(b.workedSec), botMin(b.idleSec), b.jobs, percent(b.workedSec, b.lifeSec)]),
    );
  }

  // ── MATERIAL ────────────────────────────────────────────────────────────────────────────────────
  out.section('material_totals');
  out.kv('items_in_pockets', r.census.inPockets);
  out.kv('items_in_containers', r.census.inContainers);
  out.kv('blocks_placed_in_blueprints', r.census.blocksPlaced);
  out.kv('blocks_standing_in_scanned_blueprints', r.census.scannedPlaced);
  out.kv('blocks_placed_by_column_trips', r.census.columns.placed);
  out.kv('total_bot_authored', r.census.total);
  out.kv('per_bot_minute', workedSec > 0 ? +(r.census.total / (workedSec / 60)).toFixed(2) : 0);

  out.section('material_by_item');
  out.table(
    ['item', 'pockets', 'containers', 'total'],
    Object.entries(r.census.byItem)
      .map(([item, v]) => [item, v.pockets, v.containers, v.pockets + v.containers])
      .sort((a, b) => b[3] - a[3]),
  );

  // ── WHAT WAS TAKEN FROM THE WORLD, BEFORE ANY OF IT WAS CRAFTED, PLACED OR BANKED ────────────────
  const g = reduceGathered({ seg, bot: botFilter });
  out.section('gathered');
  out.kv('bots_reporting', g.bots);
  out.kv('items_gathered', g.total);
  out.kv('per_worked_bot_minute', workedSec > 0 ? +(g.total / (workedSec / 60)).toFixed(2) : 0);
  // The building's own ratio (its plan's material_ratio) against the gather's; one raw_iron smelts to one ingot.
  out.section('iron_to_stone');
  const iron = g.sum.raw_iron || 0, cobble = g.sum.cobblestone || 0;
  out.kv('raw_iron_gathered', iron);
  out.kv('cobblestone_gathered', cobble);
  out.kv('cobblestone_per_iron_gathered', iron ? Math.round(cobble / iron) : 'no_iron');
  out.kv('cobblestone_per_iron_target', g.target ? g.target.cobblestone_per_iron : 'not_recorded');
  out.kv('iron_ingots_building_needs', g.target ? g.target.iron_ingots : 'not_recorded');
  out.kv('cobblestone_building_needs', g.target ? g.target.cobblestone : 'not_recorded');
  // Iron held the castle up: each body's own IRON_WAIT reading (downloaded_build.noteIronWait), held until its
  // next one. stopped = no cube could be posted while a cube waited on iron.
  out.section('iron_wait');
  const waitRe = /IRON_WAIT posted=(\d+) iron_held=(\d+) stopped=(true|false)/;
  const perBot = new Map();
  for (const l of seg) {
    if (botFilter && l.bot && l.bot !== botFilter) continue;
    const m = waitRe.exec(l.raw || '');
    if (!m || l.wallSec == null) continue;
    if (!perBot.has(l.bot)) perBot.set(l.bot, []);
    perBot.get(l.bot).push({ at: l.wallSec, held: +m[2], stopped: m[3] === 'true' });
  }
  const endSec = seg.reduce((mx, l) => (l.wallSec != null && l.wallSec > mx ? l.wallSec : mx), 0);
  const heldSecs = [], stoppedSecs = [];
  let firstHeld = null, maxHeld = 0;
  for (const rows of perBot.values()) {
    rows.sort((a, b) => a.at - b.at);
    let held = 0, stopped = 0;
    rows.forEach((r, i) => {
      const until = i + 1 < rows.length ? rows[i + 1].at : endSec;
      if (r.held > 0) { held += until - r.at; if (firstHeld === null || r.at < firstHeld) firstHeld = r.at; }
      if (r.stopped) stopped += until - r.at;
      maxHeld = Math.max(maxHeld, r.held);
    });
    heldSecs.push(held); stoppedSecs.push(stopped);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  out.kv('bots_reporting', perBot.size);
  out.kv('first_cube_held_on_iron_run_sec', firstHeld === null ? 'never' : firstHeld);
  out.kv('most_cubes_held_on_iron', maxHeld);
  out.kv('cubes_held_on_iron_sec_median_bot', med(heldSecs));
  out.kv('castle_stopped_on_iron_sec_median_bot', med(stoppedSecs));
  out.kv('castle_stopped_on_iron_sec_max_bot', stoppedSecs.length ? Math.max(...stoppedSecs) : 0);
  // What the surface asked the mine for against what the mine took out: each body's own MINE_REQUEST reading
  // (assessors/mining.noteMineRequest), held until its next one.
  out.section('mine_request');
  const reqRe = /MINE_REQUEST stone_short=(\d+) seats=(\d+) open_units=(\d+) unit_yield=(\d+) asked=(\S+)/;
  const reqBot = new Map();
  const askedItems = {};
  for (const l of seg) {
    if (botFilter && l.bot && l.bot !== botFilter) continue;
    const m = reqRe.exec(l.raw || '');
    if (!m || l.wallSec == null) continue;
    if (!reqBot.has(l.bot)) reqBot.set(l.bot, []);
    reqBot.get(l.bot).push({ at: l.wallSec, short: +m[1], seats: +m[2] });
    for (const part of m[5].split(',')) { const item = part.split(':')[0]; if (item !== 'none') askedItems[item] = (askedItems[item] || 0) + 1; }
  }
  const openSecs = [], lastShort = [], lastSeats = [];
  let peakShort = 0, peakSeats = 0, firstShort = null;
  for (const rows of reqBot.values()) {
    rows.sort((a, b) => a.at - b.at);
    let openFor = 0;
    rows.forEach((r, i) => {
      if (r.seats > 0) openFor += (i + 1 < rows.length ? rows[i + 1].at : endSec) - r.at;
      peakShort = Math.max(peakShort, r.short); peakSeats = Math.max(peakSeats, r.seats);
    });
    if (firstShort === null || rows[0].at < firstShort.at) firstShort = rows[0];
    openSecs.push(openFor); lastShort.push(rows[rows.length - 1].short); lastSeats.push(rows[rows.length - 1].seats);
  }
  out.kv('bots_reporting', reqBot.size);
  out.kv('stone_short_first_asked', firstShort ? firstShort.short : 'not_recorded');
  out.kv('stone_short_peak', peakShort);
  out.kv('stone_short_at_end_median_bot', med(lastShort));
  out.kv('seats_peak', peakSeats);
  out.kv('seats_at_end_median_bot', med(lastSeats));
  out.kv('mine_open_sec_median_bot', med(openSecs));
  out.kv('cobblestone_taken_out', cobble);
  out.kv('items_on_the_pull', Object.entries(askedItems).map(([k, n]) => `${k}=${n}`).join(' ') || 'none');
  // The iron chain after the gather: raw iron loaded into furnaces, ingots taken out, and every craft whose
  // product is made of iron (furnace_executor's and craft_executor's WINDOW lines).
  out.section('iron_flow');
  const loadRe = /WINDOW furnace-load @ \S+: (\d+)x iron_ingot/;
  const collectRe = /WINDOW furnace-collect @ \S+: (\d+)x iron_ingot/;
  const ironCraftRe = /WINDOW craft ((?:iron_\w+|\w*lantern|chain|shears|shield|bucket|\w*_rail|rail|hopper|anvil|cauldron)) @.*bot\.craft OK/;
  let loaded = 0, collected = 0, firstLoad = null, firstCollect = null;
  const ironCrafts = {};
  for (const l of seg) {
    if (botFilter && l.bot && l.bot !== botFilter) continue;
    const raw = l.raw || '';
    const a = loadRe.exec(raw);
    if (a) { loaded += +a[1]; if (l.wallSec != null && (firstLoad === null || l.wallSec < firstLoad)) firstLoad = l.wallSec; }
    const b = collectRe.exec(raw);
    if (b) { collected += +b[1]; if (l.wallSec != null && (firstCollect === null || l.wallSec < firstCollect)) firstCollect = l.wallSec; }
    const c = ironCraftRe.exec(raw);
    if (c) ironCrafts[c[1]] = (ironCrafts[c[1]] || 0) + 1;
  }
  out.kv('raw_iron_loaded', loaded);
  out.kv('first_iron_load_run_sec', firstLoad === null ? 'never' : firstLoad);
  out.kv('iron_ingots_collected', collected);
  out.kv('first_ingot_collect_run_sec', firstCollect === null ? 'never' : firstCollect);
  out.kv('iron_item_crafts', Object.entries(ironCrafts).map(([k, n]) => `${k}=${n}`).join(' ') || 'none');
  // The stone-tool shelf: each time a body wanted shelf tools and found too few (shared.noteShelfShort), and
  // every pickaxe crafted, by tier.
  out.section('tool_shelf');
  const shortRe = /SHELF SHORT (\S+) on_shelf=(\d+) wanted=(\d+) took=(\S+)/;
  const craftRe = /WINDOW craft (\w+)_pickaxe @.*bot\.craft OK/;
  const shorts = [], crafted = {};
  for (const l of seg) {
    if (botFilter && l.bot && l.bot !== botFilter) continue;
    const m = shortRe.exec(l.raw || '');
    if (m) shorts.push({ bot: l.bot, at: l.wallSec, item: m[1], took: m[4] });
    const c = craftRe.exec(l.raw || '');
    if (c) crafted[c[1]] = (crafted[c[1]] || 0) + 1;
  }
  out.kv('shelf_short_events', shorts.length);
  out.kv('shelf_short_bots', new Set(shorts.map(s => s.bot)).size);
  const timed = shorts.filter(s => s.at != null).map(s => s.at);
  out.kv('shelf_short_first_run_sec', timed.length ? Math.min(...timed) : 'never');
  out.kv('shelf_short_took', Object.entries(shorts.reduce((o, s) => { o[s.took] = (o[s.took] || 0) + 1; return o; }, {})).map(([k, n]) => `${k}=${n}`).join(' ') || 'none');
  out.kv('pickaxes_crafted', Object.entries(crafted).map(([k, n]) => `${k}=${n}`).join(' ') || 'none');
  out.section('gathered_by_item');
  if (!g.rows.length) out.zero('gathered_items');
  else out.table(['item', 'gathered', 'held_at_end'], g.rows.map(([item, n]) => {
    const held = r.census.byItem[item];
    return [item, n, held ? held.pockets + held.containers : 0];
  }));

  // ── THE FOUR SITES ──────────────────────────────────────────────────────────────────────────────
  out.section('structures');
  if (!r.builds.length) out.zero('structures');
  else out.table(
    ['structure', 'struct_placed', 'struct_total', 'no_work_cells', 'complete_at', 'complete_by'],
    r.builds.map(b => [
      b.structure, b.placed, b.total, b.noWork,
      b.completeAtSec == null ? null : relativeTime(b.completeAtSec),
      b.completeBy,
    ]),
  );

  out.section('trees');
  if (!r.trees.length) out.zero('tree_sites');
  else out.table(
    // `last_seen_at` is the newest scan in fleet-clock order. A count still above zero after
    // `phase_closed_at` is the state to look at: the latch closed on one body's view while another was
    // still finding trunks, and the lens shows both timestamps instead of picking one.
    ['site', 'box', 'max_seen', 'last_seen', 'last_seen_at', 'phase_closed', 'phase_closed_at'],
    r.trees.map(t => [
      t.site, t.box, t.maxSeen, t.lastSeen,
      t.lastSeenSec == null ? null : relativeTime(t.lastSeenSec),
      t.closed,
      t.closedAtSec == null ? null : relativeTime(t.closedAtSec),
    ]),
  );

  out.section('anchor_cubes');
  // TRIPS AND CUBES ARE DIFFERENT QUESTIONS. `trips` is EVENTS — every cube a body climbed to, including a
  // cube worked twice because the first trip left something wrong. `distinct_cubes` is GROUND — how much
  // of the building has been touched at all.
  out.kv('trips', r.cubes.trips);
  out.kv('distinct_cubes', r.cubes.cubeCount);
  out.kv('distinct_columns', r.cubes.columnCount);
  out.kv('cubes_finished', r.cubes.finished ? r.cubes.finished.done : null);
  out.kv('cubes_holding_blocks', r.cubes.finished ? r.cubes.finished.of : null);
  out.kv('blocks_dug', r.cubes.dug);
  out.kv('blocks_placed', r.cubes.placed);
  out.kv('cells_failed', r.cubes.failed);
  out.kv('shaft_blocks_placed', r.cubes.shaftPlaced);
  out.kv('climbs_stopped', r.cubes.climbStopped);
  out.kv('trips_that_did_nothing', r.cubes.zeroYield);

  // The building by finished cubes, layer by layer; the stand columns are no part of any cube.
  out.section('anchor_cubes_finished_by_layer');
  if (r.cubes.finished) out.table(['layer', 'finished', 'holding_blocks'], r.cubes.finished.layers);

  // THE LAYERS IN TIME: when each layer's cube trips began and ended, and how many of its trips were made while a
  // lower layer still had a trip to come (`trips_before_lower_done`). A building raised layer by layer reads as
  // first and last minutes climbing together with that column near zero. `open_at_min` is the first minute any
  // body named the layer open.
  out.section('anchor_cube_trips_by_layer');
  const byLayer = new Map();
  for (const c of r.cubes.byCube.values()) {
    const row = byLayer.get(c.layer) || { cubes: 0, secs: [] };
    row.cubes++;
    for (const t of c.trips) if (t.sec != null) row.secs.push(t.sec);
    byLayer.set(c.layer, row);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const lastOf = new Map(layers.map(L => [L, Math.max(...byLayer.get(L).secs, -Infinity)]));
  const minute = s => (Number.isFinite(s) ? +(s / 60).toFixed(1) : null);
  out.table(['layer', 'cubes', 'trips', 'open_at_min', 'first_trip_min', 'median_trip_min', 'last_trip_min', 'trips_before_lower_done'],
    layers.map(L => {
      const secs = byLayer.get(L).secs.sort((a, b) => a - b);
      const lowerDone = Math.max(-Infinity, ...layers.filter(x => x < L).map(x => lastOf.get(x)));
      return [L, byLayer.get(L).cubes, secs.length, minute(r.cubes.openLayers.get(L)), minute(secs[0]),
        minute(secs[Math.floor(secs.length / 2)]), minute(secs[secs.length - 1]), secs.filter(s => s < lowerDone).length];
    }));

  // What the waiting cubes wait on at the end of the run, as the body that saw the most of them stated it.
  out.section('anchor_cubes_waiting_on');
  const seer = [...r.cubes.waitsTotal.entries()].sort((x, y) => y[1].cubes - x[1].cubes)[0];
  if (seer) {
    const pairs = (text) => text === 'none' ? [] : text.split(',').map(p => { const i = p.lastIndexOf('='); return [p.slice(0, i), Number(p.slice(i + 1))]; });
    const cubesBy = new Map(pairs(seer[1].cubesBy));
    out.kv('stated_by', seer[0]);
    out.kv('cubes_waiting', seer[1].cubes);
    out.kv('cells_waiting', seer[1].cells);
    out.table(['waits_on', 'cells', 'cubes_mostly'], pairs(seer[1].cellsBy).map(([k, n]) => [k, n, cubesBy.get(k) || 0]));
    out.section('anchor_cubes_waiting_each');
    out.table(['cube', 'layer', 'column', 'cells', 'on'],
      [...(r.cubes.waitsByBot.get(seer[0]) || new Map()).values()].sort((x, y) => x.layer - y.layer || y.cells - x.cells)
        .map(c => [c.cube, c.layer, c.column, c.cells, c.on]));
  }

  // Every cube worked more than once, its trips in fleet-clock order as dug.placed.failed.
  const reworked = [...r.cubes.byCube.values()].filter(c => c.trips.length > 1).sort((a, b) => b.trips.length - a.trips.length);
  out.section('anchor_cubes_worked_more_than_once');
  out.kv('cubes', reworked.length);
  out.kv('trips_on_them', reworked.reduce((n, c) => n + c.trips.length, 0));
  if (reworked.length) out.table(['column', 'cube', 'layer', 'trips', 'bots', 'dug', 'placed', 'failed', 'each_trip_dug.placed.failed'],
    reworked.map(c => {
      const t = [...c.trips].sort((a, b) => (a.sec ?? 0) - (b.sec ?? 0));
      return [c.column, c.cube, c.layer, t.length, c.bots.size, t.reduce((n, x) => n + x.dug, 0), t.reduce((n, x) => n + x.placed, 0),
        t.reduce((n, x) => n + x.failed, 0), t.map(x => `${x.dug}.${x.placed}.${x.failed}`).join(' ')];
    }));

  // What the trips found standing wrong: cells on a cube's first trip against cells on every return to it.
  // On the fleet clock, a cube's first recorded trip is the build and every later one a return.
  const nthOf = new Map();
  for (const v of [...r.cubes.visits].sort((x, y) => x.sec - y.sec)) {
    const nth = (nthOf.get(v.cube) || 0) + 1;
    nthOf.set(v.cube, nth);
    r.cubes.foundTrips++;
    if (v.wrong === 'none') { r.cubes.foundNone++; continue; }
    for (const part of v.wrong.split(',')) {
      const [pair, n] = part.split(':');
      const row = r.cubes.found.get(pair) || { pair, first: 0, later: 0, trips: 0 };
      if (nth === 1) row.first += Number(n); else row.later += Number(n);
      row.trips++;
      r.cubes.found.set(pair, row);
    }
  }
  out.section('anchor_cubes_found_wrong');
  out.kv('trips_recorded', r.cubes.foundTrips);
  out.kv('trips_found_nothing_wrong', r.cubes.foundNone);
  const found = [...r.cubes.found.values()].sort((a, b) => b.later - a.later || b.first - a.first);
  if (found.length) out.table(['found_then_wanted', 'cells_first_trip', 'cells_on_returns', 'trips'], found.map(f => [f.pair, f.first, f.later, f.trips]));

  out.section('mine');
  out.kv('shaft_centre', r.shaft.centre);
  out.kv('collar_y', r.shaft.topY);
  out.kv('deepest_y', r.shaft.deepY);
  out.kv('levels_descended', (r.shaft.topY != null && r.shaft.deepY != null) ? r.shaft.topY - r.shaft.deepY : null);
  out.kv('segments_registered_built', r.segments);
  out.kv('shaft_cells_built', r.shaft.built);
  out.kv('shaft_cells_total', r.shaft.total);

  out.section('mine_settles');
  if (!r.settles.length) out.zero('settles');
  else out.table(['kind', 'stop', 'count', 'cycles', 'blocks_dug', 'blocks_placed', 'steps_left'], r.settles.map(s => [s.kind, s.stop, s.count, s.cycles, s.dug, s.placed, s.left]));

  // ── THE CELLS, ONE BY ONE, AND THE FAN THEY MAKE ────────────────────────────────────────────────
  const cells = reduceCells({ seg, bot: botFilter });
  const done = cells.rows.filter(c => c.completeAt !== null);
  out.section('mine_cells');
  out.kv('cells_started', cells.rows.filter(c => c.firstDispatch !== null).length);
  out.kv('cells_complete', done.length);
  out.kv('cells_complete_with_digging', done.filter(c => c.dug > 0).length);
  out.kv('cells_stuck', cells.rows.filter(c => c.stuck).length);
  out.kv('cells_left_open_no_pickaxe', cells.counts.leftOpen);
  out.kv('cell_dispatches', cells.counts.dispatches);
  out.kv('cells_chained_in_one_trip', cells.counts.chained);
  out.kv('surfaced_at_last_pickaxe', cells.counts.surfacedLastPick);
  out.kv('repairs', cells.counts.repairs);
  out.kv('floors', cells.floors.join(' '));
  out.kv('primes', cells.rows.filter(c => c.prime).map(c => c.id).join(' '));
  out.kv('out_of_ring_starts', cells.outOfRing);
  out.kv('first_cell_complete_at', done.length ? relativeTime(done[0].completeAt) : null);
  out.kv('last_cell_complete_at', done.length ? relativeTime(done[done.length - 1].completeAt) : null);

  out.section('mine_cells_by_ring');
  const rings = new Map();
  for (const c of cells.rows) {
    const k = `${c.y}|${c.ring}`;
    const g = rings.get(k) || { y: c.y, ring: c.ring, started: 0, complete: 0, first: null, last: null };
    if (c.firstDispatch !== null) g.started++;
    if (c.completeAt !== null) {
      g.complete++;
      if (g.first === null || c.completeAt < g.first) g.first = c.completeAt;
      if (g.last === null || c.completeAt > g.last) g.last = c.completeAt;
    }
    rings.set(k, g);
  }
  out.table(['floor_y', 'ring', 'started', 'complete', 'first_complete_at', 'last_complete_at'],
    [...rings.values()].sort((a, b) => a.y - b.y || (a.ring ?? 99) - (b.ring ?? 99))
      .map(g => [g.y, g.ring, g.started, g.complete, g.first == null ? null : relativeTime(g.first), g.last == null ? null : relativeTime(g.last)]));

  out.section('mine_cells_by_side');
  const sides = new Map();
  for (const c of done) sides.set(`${c.y}|${c.side}`, (sides.get(`${c.y}|${c.side}`) || 0) + 1);
  out.table(['floor_y', 'side_of_fan_centre', 'complete'],
    [...sides.entries()].sort().map(([k, n]) => { const [y, s] = k.split('|'); return [Number(y), s, n]; }));

  out.section('mine_cells_in_order');
  out.table(['cell', 'floor_y', 'ring', 'side', 'prime', 'started_at', 'complete_at', 'complete_by', 'dispatches', 'dug', 'placed', 'stuck'],
    cells.rows.map(c => [c.id, c.y, c.ring, c.side, c.prime,
      c.firstDispatch == null ? null : relativeTime(c.firstDispatch),
      c.completeAt == null ? null : relativeTime(c.completeAt), c.completeBy, c.dispatches, c.dug, c.placed, c.stuck]));

  // ── THE STRIP TRIPS: WHERE EACH DESCENT STARTED, HOW FAR IT WENT ON ONE LINE, AND WHY IT CAME UP ───────
  const st = reduceStripTrips({ seg, bot: botFilter });
  out.section('strip_trips');
  const segCounts = st.map(t => t.cells.size).sort((a, b) => a - b);
  out.kv('trips', st.length);
  out.kv('segments_dug', segCounts.reduce((s, n) => s + n, 0));
  out.kv('segments_per_trip_median', segCounts.length ? segCounts[Math.floor(segCounts.length / 2)] : 0);
  out.kv('segments_per_trip_max', segCounts.length ? segCounts[segCounts.length - 1] : 0);
  out.kv('line_moves', st.reduce((s, t) => s + t.moves, 0));
  out.kv('repairs_on_the_way_in', st.reduce((s, t) => s + t.repairs, 0));
  out.kv('trips_that_left_their_line', st.filter(t => t.cells.size - 1 - t.repairs > t.moves).length);
  out.kv('veins_dug', st.reduce((s, t) => s + t.veins, 0));
  const minedAll = {}, passedAll = {};
  for (const t of st) {
    for (const [k, n] of Object.entries(t.mined)) minedAll[k] = (minedAll[k] || 0) + n;
    for (const [k, n] of Object.entries(t.passed)) passedAll[k] = (passedAll[k] || 0) + n;
  }
  out.kv('vein_ore_mined', Object.entries(minedAll).map(([k, n]) => `${k}=${n}`).join(' ') || 'none');
  out.kv('vein_ore_passed', Object.entries(passedAll).map(([k, n]) => `${k}=${n}`).join(' ') || 'none');
  out.kv('drops_picked', st.reduce((s, t) => s + t.dropsPicked, 0));
  out.kv('drops_seen', st.reduce((s, t) => s + t.dropsSeen, 0));
  out.section('strip_trip_ends');
  const ends = {};
  for (const t of st) ends[t.end] = (ends[t.end] || 0) + 1;
  out.table(['end', 'trips'], Object.entries(ends).sort((a, b) => b[1] - a[1]));
  // The waste pit (custom_api/waste_pit) and the dig's gravity reflex (dig_authority.clearFallingAbove).
  out.section('waste_pit_and_gravity_reflex');
  const tossRe = /WASTE PIT tossed (\d+) item\(s\): ([^."]*)/;
  const pitFailRe = /WASTE PIT (not reached|unusable)/;
  const reflexRe = /GRAVITY REFLEX at /, reflexNoRe = /GRAVITY REFLEX refused/, reflexDownRe = /GRAVITY REFLEX descent stopped/;
  const reflexClimbRe = /GRAVITY REFLEX at .* pillared (\d+), came back down (\d+)/;
  // THE PIT'S TIME: the walk there (each `purpose=waste_pit` leg's `held`), and the stand at the pit, from the body's
  // arrival on that walk to its `WASTE PIT tossed` line. A stand is paired only with an arrival under PIT_PAIR_MS
  // before it, so a toss whose walk line is missing is not given a stand.
  const pitWalkRe = /walk verb=\w+ category=(\S+) purpose=waste_pit leg=\w+ held=([\d.]+)s outcome=arrived/;
  const stampRe = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/;
  const PIT_PAIR_MS = 120000;
  const arrivedAt = new Map();   // bot → ms of its last arrival at the pit
  const stands = [], walkByJob = {}, sizes = [];
  let pitWalkSec = 0;
  const tossed = {}, seenPit = new Set();
  let tossEvents = 0, tossItems = 0, pitFails = 0, reflexes = 0, reflexRefused = 0, reflexClimbs = 0, climbed = 0, cameDown = 0, descentStopped = 0;
  for (const l of seg) {
    if (botFilter && l.bot && l.bot !== botFilter) continue;
    const raw = (l.raw || '').replace(/"$/, '');
    const k = `${l.bot}|${l.wallSec}|${raw}`;
    if (seenPit.has(k)) continue;
    seenPit.add(k);
    const st = stampRe.exec(raw);
    const atMs = st ? Date.parse(st[1]) : (l.wallSec != null ? l.wallSec * 1000 : null);
    let m;
    if ((m = pitWalkRe.exec(raw))) {
      pitWalkSec += +m[2];
      walkByJob[m[1]] = (walkByJob[m[1]] || 0) + +m[2];
      if (atMs !== null) arrivedAt.set(l.bot, atMs);
      continue;
    }
    if ((m = tossRe.exec(raw))) {
      const from = arrivedAt.get(l.bot);
      if (atMs !== null && from !== undefined && atMs >= from && atMs - from < PIT_PAIR_MS) stands.push((atMs - from) / 1000);
      arrivedAt.delete(l.bot);
      sizes.push(+m[1]);
      tossEvents++; tossItems += +m[1];
      for (const pair of m[2].split(/,\s*/)) { const mm = /^(\w+)x(\d+)$/.exec(pair.trim()); if (mm) tossed[mm[1]] = (tossed[mm[1]] || 0) + +mm[2]; }
    } else if (pitFailRe.test(raw)) pitFails++;
    else if (reflexRe.test(raw)) {
      reflexes++;
      const c = reflexClimbRe.exec(raw);
      if (c) { reflexClimbs++; climbed += +c[1]; cameDown += +c[2]; }
    }
    else if (reflexNoRe.test(raw)) reflexRefused++;
    else if (reflexDownRe.test(raw)) descentStopped++;
  }
  // Where each thrown stack stopped is the item book's (item_book_lens.pitOf), by entity id.
  const itemBook = require('./item_book_lens');
  const pit = itemBook.pitOf(itemBook.readBook(), botFilter);
  out.kv('pit_toss_visits', tossEvents);
  out.kv('pit_items_tossed', tossItems);
  out.kv('pit_items_by_kind', Object.entries(tossed).map(([k, n]) => `${k}=${n}`).join(' ') || 'none');
  out.kv('pit_visits_failed', pitFails);
  const sorted = [...stands].sort((a, b) => a - b);
  const at = q => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1) : null);
  out.kv('pit_walk_bot_min', +(pitWalkSec / 60).toFixed(1));
  out.kv('pit_walk_sec_per_visit', tossEvents ? +(pitWalkSec / tossEvents).toFixed(1) : null);
  out.kv('pit_stands_paired', stands.length);
  out.kv('pit_stand_bot_min', +(stands.reduce((s, v) => s + v, 0) / 60).toFixed(1));
  out.kv('pit_stand_sec_median', at(0.5));
  out.kv('pit_stand_sec_p90', at(0.9));
  out.kv('pit_stand_sec_max', sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null);
  out.kv('pit_visits_by_items', `1-4=${sizes.filter(n => n <= 4).length} 5-16=${sizes.filter(n => n > 4 && n <= 16).length} 17-64=${sizes.filter(n => n > 16 && n <= 64).length} 65+=${sizes.filter(n => n > 64).length}`);
  out.kv('pit_walk_bot_min_by_job', Object.entries(walkByJob).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([j, s]) => `${j}=${(s / 60).toFixed(1)}`).join(' ') || 'none');
  out.kv('pit_stacks_followed', pit.stacks);
  out.kv('pit_items_in_pit', pit.inPit);
  out.kv('pit_items_outside_pit', pit.outside);
  out.kv('pit_items_picked_back_up', pit.backItems);
  out.kv('gravity_reflex_takeovers', reflexes);
  out.kv('gravity_reflex_refused_digs', reflexRefused);
  out.kv('gravity_reflex_climbs', reflexClimbs);
  out.kv('gravity_reflex_blocks_climbed', climbed);
  out.kv('gravity_reflex_blocks_come_back_down', cameDown);
  out.kv('gravity_reflex_descents_stopped', descentStopped);
  out.section('strip_trips_in_order');
  out.table(['bot', 'started_at', 'start_segment', 'line', 'segments', 'line_moves', 'veins', 'drops_picked', 'end'],
    st.map(t => [t.bot, t.at == null ? null : relativeTime(t.at), t.start, t.kind ? `${t.kind} ${t.dir}` : null,
      t.cells.size, t.moves, t.veins, t.dropsPicked, t.end]));

  // ── WHERE THE STONE CAME FROM ───────────────────────────────────────────────────────────────────
  out.section('stone_held');
  out.kv('stone_blocks_total', r.stoneTotal);
  out.table(['item', 'total'], r.stoneHeld.map(s => [s.item, s.total]));

  out.section('stone_sources');
  out.table(
    ['verb', 'dispatches'],
    STONE_VERBS.map(v => [v, r.dispatches.get(v) || 0]),
  );

  out.section('executors_dispatched');
  out.table(
    ['executor', 'dispatches'],
    [...r.dispatches.entries()].sort((a, b) => b[1] - a[1]),
  );

  return r;
}

module.exports = { reduceAccounting, reduceCells, reduceGathered, runAccounting };
