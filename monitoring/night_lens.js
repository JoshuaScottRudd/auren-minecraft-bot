// Auren_Bot/monitoring/night_lens.js
// --night: what the night did to the crew — every dusk stop (a claim ended at its next natural boundary), every night recall (battle_stations' inline check sending a body home
// from a job the night holds), every death and what killed it, and the bounded gathers that end a claim on their
// punch count (seed claims and forest runs, harvest_executor; seed picks, seed_picker). Inputs as ARGUMENTS,
// render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --night [--bot=B] [--all]

'use strict';

const out = require('./data_out');

// battle_stations, one per recall.
const RECALL_RE = /NIGHT_RECALL job=(\S+) why=(.*?) source=(\S+)/;
// supply_manager and survey_executor, one per claim ended at dusk on its natural boundary.
const DUSK_STOP_RE = /DUSK_STOP job=(\S+) why=(.*?) after=(\d+)/;
// battle_stations, one per death.
const DEATH_RE = /\bdeath by=(\S+) kind=\S+ final=\S+ hits=(\d+) dmg=(\d+)/;
// seed_picker, one per pick.
const PICK_RE = /Seed pick done: \+(\d+) wheat_seeds in (\d+)\/(\d+) punch\(es\)/;
// harvest_executor, one per claim ended on its count.
const SEED_CLAIM_RE = /seed claim done: picked (\d+) wheat_seeds in (\S+) punch\(es\)/;
const PUNCH_CAP_RE = /punch cap: (\d+) of (\d+) punches spent, (\d+) gathered/;
const ROWS = 40;

const mmss = (sec) => `${Math.floor(sec / 60)}m${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

function reduceNight({ seg = [], bot: botFilter = null } = {}) {
  const recalls = [], duskStops = [], deaths = [], picks = [], seedClaims = [], capped = [];
  // A line forwarded through the judge repeats its executor's line; one per bot and exact text.
  const seen = new Set();
  for (const l of seg) {
    if (botFilter && l.bot !== botFilter) continue;
    const k = `${l.bot}|${l.relSec}|${l.raw}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let m = RECALL_RE.exec(l.raw);
    if (m) { recalls.push({ t: l.relSec, bot: l.bot, job: m[1], why: m[2], source: m[3] }); continue; }
    m = DUSK_STOP_RE.exec(l.raw);
    if (m) { duskStops.push({ t: l.relSec, bot: l.bot, job: m[1], why: m[2], after: +m[3] }); continue; }
    m = DEATH_RE.exec(l.raw);
    if (m) { deaths.push({ t: l.relSec, bot: l.bot, by: m[1], hits: +m[2], dmg: +m[3] }); continue; }
    m = PICK_RE.exec(l.raw);
    if (m) { picks.push({ t: l.relSec, bot: l.bot, seeds: +m[1], punches: +m[2], cap: +m[3] }); continue; }
    m = SEED_CLAIM_RE.exec(l.raw);
    if (m) { seedClaims.push({ t: l.relSec, bot: l.bot, seeds: +m[1] }); continue; }
    m = PUNCH_CAP_RE.exec(l.raw);
    if (m) capped.push({ t: l.relSec, bot: l.bot, punches: +m[1], cap: +m[2], gathered: +m[3] });
  }
  for (const xs of [recalls, duskStops, deaths, picks, seedClaims, capped]) xs.sort((a, b) => a.t - b.t);
  return { recalls, duskStops, deaths, picks, seedClaims, capped };
}

function runNight({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const { recalls, duskStops, deaths, picks, seedClaims, capped } = reduceNight({ seg, bot: botFilter });
  out.kv('lens', 'night');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);

  out.section('night_recalls');
  out.kv('recalls', recalls.length);
  out.kv('first_recall_at', recalls.length ? mmss(recalls[0].t) : null);
  out.kv('last_recall_at', recalls.length ? mmss(recalls[recalls.length - 1].t) : null);
  const byJob = new Map();
  for (const r of recalls) byJob.set(r.job, (byJob.get(r.job) || 0) + 1);
  out.table(['job', 'recalls'], [...byJob].sort((a, b) => b[1] - a[1]));
  const rows = verbose ? recalls : recalls.slice(0, ROWS);
  out.table(['at', 'bot', 'job', 'source', 'why'], rows.map(r => [mmss(r.t), r.bot, r.job, r.source, r.why]));
  if (!verbose && recalls.length > ROWS) out.kv('rows_cut', recalls.length - ROWS);

  out.section('dusk_stops');
  out.kv('dusk_stops', duskStops.length);
  out.table(['at', 'bot', 'job', 'after_units', 'why'], duskStops.map(d => [mmss(d.t), d.bot, d.job, d.after, d.why]));

  out.section('deaths');
  out.kv('deaths', deaths.length);
  out.table(['at', 'bot', 'killed_by', 'hits_taken', 'damage'], deaths.map(d => [mmss(d.t), d.bot, d.by, d.hits, d.dmg]));

  out.section('seed_picks');
  out.kv('picks', picks.length);
  out.kv('seeds', sum(picks.map(p => p.seeds)));
  out.kv('punches', sum(picks.map(p => p.punches)));
  out.kv('most_punches_in_one_pick', picks.length ? Math.max(...picks.map(p => p.punches)) : null);
  out.kv('punch_cap', picks.length ? picks[picks.length - 1].cap : null);
  out.kv('seed_claims_ended', seedClaims.length);
  out.table(['at', 'bot', 'seeds', 'punches'], (verbose ? picks : picks.slice(0, ROWS)).map(p => [mmss(p.t), p.bot, p.seeds, p.punches]));

  out.section('punch_capped_claims');
  out.kv('claims', capped.length);
  out.table(['at', 'bot', 'punches', 'cap', 'gathered'], capped.map(c => [mmss(c.t), c.bot, c.punches, c.cap, c.gathered]));
}

module.exports = { reduceNight, runNight };
