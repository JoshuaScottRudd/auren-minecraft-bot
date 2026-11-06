// Auren_Bot/monitoring/activity_lens.js
// --activities: every activity span the bodies reported, one row each, with its exact start and end — the seconds a
// keyframe is cut on. Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// A span is read off the bodies' own `[ACTIVITY] 📊 start|end` lines (custom_api/activity_log.js) through the same
// board the camera rig's scout seat reads live, so the lens and the live camera agree on every span by construction.
// `ended` says how a span closed: `line` (its own end line), `next_job` (the body's next claim), `restarted`,
// `timeout` (open past its kind's maxSec) or `trace_end`. Only `line` is a measured end; the others are the board's.
//
// reduceActivities(lines) is the machine reader the Cutting Room's hook curator uses on a take's archived traces.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --activities [--run=latest|N|all] [--bot=B] [--kind=K] [--all]

'use strict';

require('./lens_paths').registerAliases();
const { KINDS, createBoard } = require('@api/activity_log');
const out = require('./data_out');

const ROWS = 60;
const mmss = (sec) => `${Math.floor(sec / 3600)}h${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}m${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
// The wall clock as hh:mm:ss UTC, the time a camera file's own start is stamped in.
const clock = (iso) => (iso ? iso.slice(11, 19) : null);

// reduceActivities(lines) → spans sorted by start: { bot, kind, subject, at, startMs, endMs, startSec, endSec, secs,
// startIso, endIso, ended, why }. `lines` are trace_read lines ({ bot, raw, iso }), in any file order. Time is each
// line's own wall-clock stamp, the one clock every body and every camera file shares; `startSec` is seconds since the
// first stamped line read. A line repeated with the same bot, stamp and text is read once.
function reduceActivities(lines, { bot: botFilter = null, kind: kindFilter = null } = {}) {
  const stamped = lines.filter(l => l.bot && l.iso && (!botFilter || l.bot === botFilter))
    .map(l => ({ l, t: Date.parse(l.iso) })).filter(x => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const board = createBoard();
  const seen = new Set();
  for (const { l, t } of stamped) {
    const k = `${l.bot}|${l.iso}|${l.raw}`;
    if (seen.has(k)) continue;
    seen.add(k);
    board.feed(l.bot, l.raw, t);
    board.expire(t);
  }
  const t0 = stamped.length ? stamped[0].t : 0;
  board.finish(stamped.length ? stamped[stamped.length - 1].t : 0);
  const isoOf = t => new Date(t).toISOString();
  return board.closed()
    .filter(s => !kindFilter || s.kind === kindFilter)
    .map(s => ({
      bot: s.bot, kind: s.kind, subject: s.subject, at: s.at,
      startMs: s.start, endMs: s.end, startSec: (s.start - t0) / 1000, endSec: (s.end - t0) / 1000,
      secs: Math.round((s.end - s.start) / 100) / 10, startIso: isoOf(s.start), endIso: isoOf(s.end),
      ended: s.ended, why: s.why,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.bot.localeCompare(b.bot));
}

function runActivities({ seg = [], traceName = '?', bot: botFilter = null, kind = null, verbose = false } = {}) {
  const spans = reduceActivities(seg, { bot: botFilter, kind });
  out.kv('lens', 'activities');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);
  if (kind) out.kv('kind_filter', kind);
  out.kv('spans', spans.length);
  out.kv('measured_ends', spans.filter(s => s.ended === 'line').length);

  out.section('activities_by_kind');
  out.table(['kind', 'spans', 'bots', 'total_secs', 'longest_secs', 'measured_ends'],
    Object.keys(KINDS).map(k => {
      const xs = spans.filter(s => s.kind === k);
      return [k, xs.length, new Set(xs.map(s => s.bot)).size, Math.round(xs.reduce((a, s) => a + s.secs, 0)),
        xs.length ? Math.max(...xs.map(s => s.secs)) : null, xs.filter(s => s.ended === 'line').length];
    }));

  // Two bodies on one pen or one fight at once: the stretches where more than one span ran together.
  out.section('activities_overlapping');
  const overlaps = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length && spans[j].startSec < spans[i].endSec; j++) {
      if (spans[j].bot === spans[i].bot) continue;
      overlaps.push([mmss(spans[j].startSec), mmss(Math.min(spans[i].endSec, spans[j].endSec)),
        Math.round(Math.min(spans[i].endSec, spans[j].endSec) - spans[j].startSec),
        spans[i].bot, spans[i].kind, spans[j].bot, spans[j].kind]);
    }
  }
  out.kv('overlaps', overlaps.length);
  out.table(['from', 'to', 'secs', 'bot_a', 'kind_a', 'bot_b', 'kind_b'], verbose ? overlaps : overlaps.slice(0, ROWS));
  if (!verbose && overlaps.length > ROWS) out.kv('rows_cut', overlaps.length - ROWS);

  out.section('activities');
  const rows = verbose ? spans : spans.slice(0, ROWS);
  out.table(['start', 'end', 'secs', 'start_clock', 'end_clock', 'bot', 'kind', 'subject', 'at', 'ended', 'why'],
    rows.map(s => [mmss(s.startSec), mmss(s.endSec), s.secs, clock(s.startIso), clock(s.endIso), s.bot, s.kind, s.subject,
      s.at ? `${s.at.x},${s.at.y},${s.at.z}` : null, s.ended, s.why]));
  if (!verbose && spans.length > ROWS) out.kv('rows_cut', spans.length - ROWS);
}

module.exports = { reduceActivities, runActivities };
