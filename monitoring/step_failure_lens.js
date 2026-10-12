// Auren_Bot/monitoring/step_failure_lens.js
// --steps: every step a body planned and did not complete — what stopped it, on which kind of move, at
// which cell, and what stood around that cell when it ended. Reads the navigator's `step_fail` ledger:
// one `step_failed` line per failed step, written before any recovery moves the body. Inputs as
// ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --steps [--bot=B] [--all]

'use strict';

const fs = require('fs');
const out = require('./data_out');

// The server states its own reason each time it refuses a move and puts a body back, on its console:
//   <name> moved wrongly!     <name> moved too quickly! dx,dy,dz     <name> was kicked for floating too long!
// Read from the run's server console so a set-back carries the server's word for it.
const SERVER_SAID_RE = /(\w+)(?: \(vehicle of \w+\))? (moved wrongly|moved too quickly|was kicked for floating too long)/;
function serverRefusals(botFilter) {
  const file = require('./lens_paths').bot('fleet_logs', 'console_server.log');
  if (!fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = SERVER_SAID_RE.exec(line);
    if (m && (!botFilter || m[1] === botFilter)) rows.push({ bot: m[1], said: m[2].split(/\s+/).join('_') });
  }
  return rows;
}

const STEP_RE = /step_failed edge=(\S+) from=(\S+) to=(\S+) body=(\S+) stopped_by=(\S+) gained=(-?[\d.]+) rise=(-?[\d.]+) on_ground=(\d) wall=(\d) set_back=(\d) step_ms=(\d+) to_floor=(\S+) to_feet=(\S+) to_head=(\S+) body_floor=(\S+) body_head=(\S+) body_above=(\S+) others=(\S+) held=(\S+)/;

const CELL_ROWS = 20;
const WINDOW_MIN = 5;

function reduceSteps({ seg = [], bot: botFilter = null } = {}) {
  const steps = [];
  for (const l of seg) {
    if (botFilter && l.bot !== botFilter) continue;
    const m = STEP_RE.exec(l.raw);
    if (!m) continue;
    steps.push({ bot: l.bot, wallSec: l.wallSec, edge: m[1], from: m[2], to: m[3], body: m[4], stoppedBy: m[5],
      cause: m[5].split(':')[0], gained: +m[6], rise: +m[7], onGround: m[8] === '1', wall: m[9] === '1',
      setBack: m[10] === '1', stepMs: +m[11], toFloor: m[12], toFeet: m[13], toHead: m[14],
      bodyFloor: m[15], bodyHead: m[16], bodyAbove: m[17], others: m[18], held: m[19] });
  }
  return { steps };
}

const avg = (xs) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2) : null);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const count = (xs, f) => xs.filter(f).length;

function runSteps({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const { steps } = reduceSteps({ seg, bot: botFilter });
  const tally = (keyOf, rows = steps) => {
    const by = new Map();
    for (const s of rows) by.set(keyOf(s), (by.get(keyOf(s)) || 0) + 1);
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  };

  out.kv('lens', 'steps');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);

  out.section('step_failures');
  out.kv('steps_failed', steps.length);
  out.kv('bots', new Set(steps.map(s => s.bot)).size);
  out.kv('distinct_destination_cells', new Set(steps.map(s => s.to)).size);
  out.kv('held_sec_total', +(sum(steps.map(s => s.stepMs)) / 1000).toFixed(1));
  out.kv('body_in_the_air', count(steps, s => !s.onGround));
  out.kv('another_body_at_the_cell', count(steps, s => s.others !== 'none'));
  out.kv('server_set_the_body_back', count(steps, s => s.setBack));

  // What the server itself said when it refused a move, over the whole run.
  const refused = serverRefusals(botFilter);
  out.section('server_refused_moves');
  if (refused === null) out.zero('server_console');
  else {
    out.kv('refusals', refused.length);
    const by = new Map();
    for (const r of refused) by.set(r.said, (by.get(r.said) || 0) + 1);
    out.table(['server_said', 'times', 'bots'], [...by.entries()].sort((a, b) => b[1] - a[1])
      .map(([said, n]) => [said, n, new Set(refused.filter(r => r.said === said).map(r => r.bot)).size]));
  }
  if (!steps.length) return;

  // What stopped the step, as the navigator read it off the world when the step ended.
  out.section('stopped_by');
  out.table(['stopped_by', 'steps', 'bots', 'cells', 'gained_avg', 'rise_avg', 'step_ms_avg'],
    tally(s => s.cause).map(([cause, n]) => {
      const g = steps.filter(s => s.cause === cause);
      return [cause, n, new Set(g.map(s => s.bot)).size, new Set(g.map(s => s.to)).size, avg(g.map(s => s.gained)),
        avg(g.map(s => s.rise)), Math.round(avg(g.map(s => s.stepMs)))];
    }));

  out.section('stopped_by_edge');
  out.table(['edge', 'stopped_by', 'steps'], tally(s => `${s.edge}|${s.cause}`).map(([k, n]) => [...k.split('|'), n]));

  // The cells a step failed into most, each with the readings of its last failure.
  out.section('failed_cells');
  out.table(['to', 'steps', 'bots', 'edge', 'stopped_by', 'from', 'body', 'gained', 'rise', 'wall', 'to_floor', 'to_feet', 'to_head',
    'body_floor', 'body_head', 'body_above', 'others', 'held'],
    tally(s => s.to).slice(0, verbose ? Infinity : CELL_ROWS).map(([to, n]) => {
      const g = steps.filter(s => s.to === to);
      const last = g[g.length - 1];
      return [to, n, new Set(g.map(s => s.bot)).size, last.edge, last.stoppedBy, last.from, last.body, last.gained, last.rise,
        last.wall, last.toFloor, last.toFeet, last.toHead, last.bodyFloor, last.bodyHead, last.bodyAbove, last.others, last.held];
    }));

  out.section('step_failures_by_window');
  const timed = steps.filter(s => Number.isFinite(s.wallSec));
  out.kv('steps_with_a_clock', timed.length);
  const windows = [...new Set(timed.map(s => Math.floor(s.wallSec / 60 / WINDOW_MIN)))].sort((a, b) => a - b);
  const causes = tally(s => s.cause).map(([c]) => c);
  out.table(['from_min', 'steps', ...causes],
    windows.map(w => {
      const g = timed.filter(s => Math.floor(s.wallSec / 60 / WINDOW_MIN) === w);
      return [w * WINDOW_MIN, g.length, ...causes.map(c => count(g, s => s.cause === c))];
    }));

  out.section('step_failures_by_bot');
  out.table(['bot', 'steps', 'cells', 'most_stopped_by', 'held_sec'],
    tally(s => s.bot).map(([b, n]) => {
      const g = steps.filter(s => s.bot === b);
      return [b, n, new Set(g.map(s => s.to)).size, tally(s => s.cause, g)[0][0], +(sum(g.map(s => s.stepMs)) / 1000).toFixed(1)];
    }));
}

module.exports = { reduceSteps, runSteps };
