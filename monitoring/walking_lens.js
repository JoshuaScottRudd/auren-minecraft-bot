// Auren_Bot/monitoring/walking_lens.js
// --walking: every walk the fleet made, tallied by the job it was made for and by where it went, beside
// that job's worked time, so commuting and working read as two numbers per job. Reads the walk ledger —
// one `[WALK_LEDGER]` line per walk, written by locomotion_dispatcher at the walk's verdict — and the
// bot-minute ledger (reduceBotMinutes) for worked time. Inputs as ARGUMENTS, render, RETURN; no
// process.argv, no process.exit.
//
// WALK_AGAINST_WORK leads: walking as a share of time on jobs against the limit, fleet and per job, from
// the bot's own walk_share_calculator; ore trips are left out of it. ORE_PER_MINUTE follows: each ore trip
// kind's ore picked up per bot-minute held.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --walking [--bot=B] [--all]

'use strict';

const out = require('./data_out');
const { reduceBotMinutes } = require('./job_timeline_lens');
const { relativeTime } = require('./report_formatting');

const WALK_RE = /\[WALK_LEDGER\][^]*?walk verb=(\S+) category=(\S+) purpose=(\S+)(?: leg=(\S+))? held=([\d.]+)s outcome=(\w+)(?: from=\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\) to=\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\))?/;

// WHERE a walk happened is read off its ENDS: the ledger's from= and to= are where the body stood when the
// walk was asked and where it stood at the verdict. `dist` is the straight line between them — the least
// ground the walk could have covered, never the route it took.
const DIST_BANDS = [[0, 2], [2, 8], [8, 24], [24, 64], [64, Infinity]];
// A destination tile is PLACE_TILE blocks square in X/Z and PLACE_TILE_Y tall, so a walk to the mine floor
// and a walk to the shaft head above it land in different tiles.
const PLACE_TILE = 16;
const PLACE_TILE_Y = 8;
const PLACE_ROWS = 20;

function tileOf(t) {
  return `${Math.floor(t[0] / PLACE_TILE) * PLACE_TILE},${Math.floor(t[1] / PLACE_TILE_Y) * PLACE_TILE_Y},`
    + `${Math.floor(t[2] / PLACE_TILE) * PLACE_TILE}`;
}

function reduceWalking({ seg = [], bot: botFilter = null } = {}) {
  const walks = [];
  for (const l of seg) {
    if (botFilter && l.bot !== botFilter) continue;
    const m = WALK_RE.exec(l.raw);
    if (!m) continue;
    const w = { bot: l.bot, wallSec: l.wallSec, verb: m[1], category: m[2], purpose: m[3], leg: m[4] || 'travel', sec: +m[5], outcome: m[6], dist: null, from: null, to: null };
    if (m[7] !== undefined) {
      const f = [+m[7], +m[8], +m[9]], t = [+m[10], +m[11], +m[12]];
      w.dist = Math.hypot(t[0] - f[0], t[1] - f[1], t[2] - f[2]);
      w.from = f;
      w.to = t;
    }
    walks.push(w);
  }
  return { walks };
}

// Every ore trip's line: { bot, job, sec, walk, ore, items: { item: count } }.
const ORE_TRIP_RE = /ore_trip job=(\S+) held=([\d.]+)s walk=([\d.]+)s ore=(\d+) items=(\S+)/;
function reduceOreTrips({ seg = [], bot: botFilter = null } = {}) {
  const trips = [];
  for (const l of seg) {
    if (botFilter && l.bot !== botFilter) continue;
    const m = ORE_TRIP_RE.exec(l.raw);
    if (!m) continue;
    const items = {};
    if (m[5] !== 'none') for (const pair of m[5].split(',')) { const [i, n] = pair.split(':'); items[i] = +n; }
    trips.push({ bot: l.bot, job: m[1], sec: +m[2], walk: +m[3], ore: +m[4], items });
  }
  return trips;
}

// Groups ore trips by a key into { key, trips, sec, walk, ore, empty }, most ore first.
function _sumTrips(trips, keyOf) {
  const by = new Map();
  for (const t of trips) {
    const k = keyOf(t);
    const g = by.get(k) || { key: k, trips: 0, sec: 0, walk: 0, ore: 0, empty: 0 };
    g.trips++; g.sec += t.sec; g.walk += t.walk || 0; g.ore += t.ore;
    if (!(t.ore > 0)) g.empty++;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => b.ore - a.ore);
}

// Groups walks by a key into { key, walks, sec, arrived, failed, abandoned }, largest first.
function _group(walks, keyOf) {
  const by = new Map();
  for (const w of walks) {
    const k = keyOf(w);
    const g = by.get(k) || { key: k, walks: 0, sec: 0, arrived: 0, failed: 0, abandoned: 0 };
    g.walks++; g.sec += w.sec;
    if (g[w.outcome] != null) g[w.outcome]++;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => b.sec - a.sec);
}

function runWalking({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const { walks } = reduceWalking({ seg, bot: botFilter });
  const bm = reduceBotMinutes({ seg, bot: botFilter });
  const min = (sec) => +(sec / 60).toFixed(1);
  const walkSec = walks.reduce((s, w) => s + w.sec, 0);
  const pct = (a, b) => (b > 0 ? +((100 * a) / b).toFixed(1) : null);

  out.kv('lens', 'walking');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);

  // THE NUMBER, FIRST: walking as a share of time on jobs, against the limit, from the bot's own
  // calculator. `work_owed_bot_min` is the working time the walking was short by; `stay_factor` is how
  // many times longer the working half of a job has to be for its walking to sit at the limit.
  const { walkShare, WALK_LIMIT_PCT, isOreTrip } = require('../js_kernel/utils/calculators/walk_share_calculator');
  // Ore trips are judged by ore per minute (section ore_per_minute), so neither their walks nor their time count here.
  const jobTime = new Map(bm.byToken.filter(t => !isOreTrip(t.token)).map(t => [t.token, t.sec]));
  const oreTripSec = bm.byToken.filter(t => isOreTrip(t.token)).reduce((s, t) => s + t.sec, 0);
  // Travel only: a move made inside the work, once it has begun, is part of the work.
  const onJobs = walks.filter(w => jobTime.has(w.category) && w.leg === 'travel');
  const inWork = new Map(_group(walks.filter(w => w.leg === 'work'), w => w.category).map(g => [g.key, g.sec]));
  const fleetShare = walkShare(onJobs.reduce((s, w) => s + w.sec, 0) * 1000, Math.max(bm.fleet.worked - oreTripSec, onJobs.reduce((s, w) => s + w.sec, 0)) * 1000);
  out.section('walk_against_work');
  out.kv('limit_pct', WALK_LIMIT_PCT);
  out.kv('walk_pct', fleetShare.walk_pct);
  out.kv('over_limit', fleetShare.over);
  out.kv('walk_bot_min', min(fleetShare.walk_ms / 1000));
  out.kv('work_bot_min', min(fleetShare.work_ms / 1000));
  out.kv('work_owed_bot_min', min(fleetShare.work_owed_ms / 1000));
  out.kv('stay_factor', fleetShare.stay_factor);
  out.table(['job', 'walk_pct', 'over_limit', 'walk_bot_min', 'work_bot_min', 'work_owed_bot_min', 'stay_factor', 'walks', 'avg_walk_sec', 'moves_inside_work_bot_min'],
    _group(onJobs, w => w.category).map(g => {
      const s = walkShare(g.sec * 1000, Math.max(jobTime.get(g.key), g.sec) * 1000);
      return [g.key, s.walk_pct, s.over, min(s.walk_ms / 1000), min(s.work_ms / 1000), min(s.work_owed_ms / 1000), s.stay_factor,
        g.walks, +(g.sec / g.walks).toFixed(1), min(inWork.get(g.key) || 0)];
    }).sort((a, b) => b[5] - a[5]));

  // ORE PER MINUTE: each ore trip's ore picked up against the time it held the body (bot_minutes' ore_trip line),
  // by trip kind, then by trip kind and item.
  const trips = reduceOreTrips({ seg, bot: botFilter });
  const perMin = (ore, sec) => (sec > 0 ? +((60 * ore) / sec).toFixed(2) : null);
  out.section('ore_per_minute');
  out.table(['job', 'trips', 'held_bot_min', 'walk_bot_min', 'ore', 'ore_per_bot_min', 'trips_with_no_ore'],
    _sumTrips(trips, t => t.job).map(g => [g.key, g.trips, min(g.sec), min(g.walk), g.ore, perMin(g.ore, g.sec), g.empty]));
  const byItem = [];
  for (const t of trips) for (const [item, n] of Object.entries(t.items)) byItem.push({ ...t, item, ore: n });
  out.table(['job', 'item', 'ore', 'ore_per_bot_min_of_all_trips'],
    _sumTrips(byItem, t => `${t.job}|${t.item}`).map(g => {
      const [job, item] = g.key.split('|');
      const sec = trips.filter(t => t.job === job).reduce((s, t) => s + t.sec, 0);
      return [job, item, g.ore, perMin(g.ore, sec)];
    }));

  out.section('walking');
  out.kv('walks', walks.length);
  out.kv('walk_bot_min', min(walkSec));
  out.kv('fleet_bot_min', min(bm.fleet.life));
  out.kv('worked_bot_min', min(bm.fleet.worked));
  out.kv('walk_share_of_fleet_pct', pct(walkSec, bm.fleet.life));
  out.kv('walk_share_of_worked_pct', pct(walkSec, bm.fleet.worked));
  out.kv('working_not_walking_bot_min', min(Math.max(0, bm.fleet.worked - walkSec)));
  out.kv('arrived', walks.filter(w => w.outcome === 'arrived').length);
  out.kv('failed', walks.filter(w => w.outcome === 'failed').length);
  out.kv('abandoned', walks.filter(w => w.outcome === 'abandoned').length);

  // Per job: the time it spent walking against the time it held the body, so each job's commute share reads directly.
  const worked = new Map(bm.byToken.map(t => [t.token, t.sec]));
  out.section('walking_by_job');
  out.table(['job', 'walks', 'walk_bot_min', 'job_bot_min', 'walk_share_of_job_pct', 'share_of_walking_pct', 'failed'],
    _group(walks, w => w.category).map(g => [g.key, g.walks, min(g.sec), min(worked.get(g.key) || 0),
      pct(g.sec, worked.get(g.key) || 0), pct(g.sec, walkSec), g.failed + g.abandoned]));

  // Where the walks went: the station reached (station:<type>), or `move` for a walk to open ground.
  out.section('walking_by_destination');
  out.table(['destination', 'walks', 'walk_bot_min', 'share_of_walking_pct', 'avg_sec'],
    _group(walks, w => w.purpose).map(g => [g.key, g.walks, min(g.sec), pct(g.sec, walkSec), +(g.sec / g.walks).toFixed(1)]));

  // How far each walk went, straight line: many short walks are a body shuffling inside its work, a few
  // long ones are a commute.
  const located = walks.filter(w => w.dist !== null);
  const sumMin = (ws) => min(ws.reduce((s, w) => s + w.sec, 0));
  out.section('walking_by_distance');
  out.kv('walks_with_ends', located.length);
  out.table(['straight_line_blocks', 'walks', 'walk_bot_min', 'share_of_walking_pct', 'avg_sec', 'failed'],
    DIST_BANDS.map(([lo, hi]) => {
      const band = located.filter(w => w.dist >= lo && w.dist < hi);
      const sec = band.reduce((s, w) => s + w.sec, 0);
      return [hi === Infinity ? `${lo}+` : `${lo}-${hi}`, band.length, min(sec), pct(sec, walkSec),
        band.length ? +(sec / band.length).toFixed(1) : null, band.filter(w => w.outcome !== 'arrived').length];
    }));

  out.section('walking_by_job_distance');
  out.table(['job', 'walks', 'avg_blocks', 'bot_min_under_8', 'bot_min_8_to_24', 'bot_min_24_plus'],
    _group(located, w => w.category).map(g => {
      const mine = located.filter(w => w.category === g.key);
      return [g.key, g.walks, +(mine.reduce((s, w) => s + w.dist, 0) / mine.length).toFixed(1),
        sumMin(mine.filter(w => w.dist < 8)), sumMin(mine.filter(w => w.dist >= 8 && w.dist < 24)),
        sumMin(mine.filter(w => w.dist >= 24))];
    }));

  // Where the walks ENDED, by tile: the ground the fleet spends its commuting on. `tile_x_y_z` is the
  // tile's lowest corner; `top_job` is the job that spent the most walk time arriving there.
  const tiles = _group(located, w => tileOf(w.to));
  out.section('walking_by_place');
  out.kv('tiles', tiles.length);
  out.table(['tile_x_y_z', 'walks', 'walk_bot_min', 'share_of_walking_pct', 'avg_blocks', 'top_job', 'top_job_bot_min'],
    tiles.slice(0, PLACE_ROWS).map(g => {
      const here = located.filter(w => tileOf(w.to) === g.key);
      const top = _group(here, w => w.category)[0];
      return [g.key, g.walks, min(g.sec), pct(g.sec, walkSec),
        +(here.reduce((s, w) => s + w.dist, 0) / here.length).toFixed(1), top.key, min(top.sec)];
    }));

  // ONE BODY'S WALKS IN ORDER, with --bot: each walk's ends as the ledger wrote them, so where a body stood
  // before and after each walk reads down one column.
  if (botFilter) {
    out.section('walks_in_order');
    out.table(['at', 'category', 'purpose', 'leg', 'held_sec', 'outcome', 'from', 'to', 'blocks'],
      walks.map(w => [Number.isFinite(w.wallSec) ? relativeTime(w.wallSec) : null, w.category, w.purpose, w.leg, w.sec, w.outcome,
        w.from ? w.from.join(',') : null, w.to ? w.to.join(',') : null, w.dist == null ? null : +w.dist.toFixed(1)]));
  }

  if (verbose) {
    out.section('walking_by_bot');
    out.table(['bot', 'walks', 'walk_bot_min', 'share_of_walking_pct'],
      _group(walks, w => w.bot).map(g => [g.key, g.walks, min(g.sec), pct(g.sec, walkSec)]));
  }
}

module.exports = { reduceWalking, runWalking };
