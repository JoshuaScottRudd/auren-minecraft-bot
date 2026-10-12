// Auren_Bot/monitoring/planning_gate_lens.js
// --gate: the planning gate over a run — every entry the foreman issued and the exit that closed it, how
// long each body was inside, how long the line was, and whether two entries were ever open at once.
// Reads the foreman brain's own lines (ENTRY #n issued, EXIT #n, in line, closed by disconnect). Inputs
// as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --gate [--all]

'use strict';

const out = require('./data_out');

// A record whose entry line names no phase holds planning entries.
const ENTRY_RE = /ENTRY #(\d+) issued to '([^']+)'(?: for (\w+))?/;
const EXIT_RE = /EXIT #(\d+) from '([^']+)' after (\d+) ms/;
const LINE_RE = /'([^']+)' in line for an entry — (\d+) ahead, '([^']+)' inside on #(\d+) for (\d+) ms/;
const DROPPED_RE = /Entry #(\d+) closed: '([^']+)' (disconnected|stood down|canceled) while inside/;
const CRASH_RE = /(STUCK FOR \d+ SECONDS|IMPOSSIBLE STATE)/;
const WORKSPACE_RE = /WORKSPACE #(\d+) bot=(\S+) phase=(\S+) growth_bytes=(\d+) available_bytes=(\d+) cache_cells=(\d+)/;

const SLOW_ROWS = 10;

function reduceGate({ seg = [] } = {}) {
  const entries = new Map();   // entry → { bot, exitBot, heldMs, closedBy }
  const waits = [];
  const workspaces = [];
  let planningOverlaps = 0, insideMost = 0, mismatched = 0, crashes = 0;
  const open = new Map();      // entry → phase, for every entry inside right now
  const seen = new Set();
  for (const l of seg) {
    const raw = l.raw || '';
    let m;
    if ((m = ENTRY_RE.exec(raw))) {
      if (seen.has(`e${m[1]}`)) continue;
      seen.add(`e${m[1]}`);
      const phase = m[3] || 'planning';
      if (phase === 'planning' && [...open.values()].includes('planning')) planningOverlaps++;
      open.set(+m[1], phase);
      insideMost = Math.max(insideMost, open.size);
      entries.set(+m[1], { bot: m[2], phase, heldMs: null, closedBy: null, wallSec: l.wallSec });
    } else if ((m = EXIT_RE.exec(raw))) {
      if (seen.has(`x${m[1]}`)) continue;
      seen.add(`x${m[1]}`);
      const e = entries.get(+m[1]);
      if (!e || e.bot !== m[2] || !open.has(+m[1])) mismatched++;
      if (e) { e.heldMs = +m[3]; e.closedBy = 'exit'; }
      open.delete(+m[1]);
    } else if ((m = DROPPED_RE.exec(raw))) {
      if (seen.has(`d${m[1]}`)) continue;
      seen.add(`d${m[1]}`);
      const e = entries.get(+m[1]);
      if (e) e.closedBy = m[3] === 'canceled' ? 'cancel' : 'disconnect';
      open.delete(+m[1]);
    } else if ((m = LINE_RE.exec(raw))) {
      waits.push({ bot: m[1], ahead: +m[2], holder: m[3], heldMs: +m[5] });
    } else if ((m = WORKSPACE_RE.exec(raw))) {
      if (seen.has(`w${m[1]}`)) continue;
      seen.add(`w${m[1]}`);
      workspaces.push({ entry: +m[1], bot: m[2], phase: m[3], growthBytes: +m[4], availableBytes: +m[5], cacheCells: +m[6] });
    } else if (CRASH_RE.test(raw)) crashes++;
  }
  return { entries: [...entries.entries()].map(([entry, e]) => ({ entry, ...e })), waits, workspaces, planningOverlaps, insideMost, mismatched, crashes };
}

const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);

function runGate({ seg = [], traceName = '?', verbose = false } = {}) {
  const r = reduceGate({ seg });
  const held = r.entries.filter(e => e.heldMs !== null).map(e => e.heldMs);
  const sorted = [...held].sort((a, b) => a - b);

  out.kv('lens', 'gate');
  out.kv('record', traceName);

  out.section('planning_gate');
  out.kv('entries_issued', r.entries.length);
  out.kv('closed_by_exit_token', r.entries.filter(e => e.closedBy === 'exit').length);
  out.kv('closed_by_disconnect', r.entries.filter(e => e.closedBy === 'disconnect').length);
  out.kv('closed_by_cancellation', r.entries.filter(e => e.closedBy === 'cancel').length);
  out.kv('still_open_at_the_end', r.entries.filter(e => e.closedBy === null).length);
  out.kv('two_planning_entries_open_at_once', r.planningOverlaps);
  out.kv('most_inside_at_once', r.insideMost);
  out.kv('exits_not_matching_their_entry', r.mismatched);
  out.kv('crash_report_lines', r.crashes);
  out.kv('bots', new Set(r.entries.map(e => e.bot)).size);
  out.section('memory_workspace');
  out.kv('grants', r.workspaces.length);
  out.kv('planning_grants', r.workspaces.filter(w => w.phase === 'planning').length);
  out.kv('execution_grants', r.workspaces.filter(w => w.phase === 'workspace').length);
  out.kv('growth_bytes_min', r.workspaces.length ? Math.min(...r.workspaces.map(w => w.growthBytes)) : null);
  out.kv('growth_bytes_max', max(r.workspaces.map(w => w.growthBytes)));
  out.kv('available_bytes_min', r.workspaces.length ? Math.min(...r.workspaces.map(w => w.availableBytes)) : null);

  out.section('time_inside');
  out.kv('inside_ms_avg', avg(held));
  out.kv('inside_ms_median', sorted.length ? sorted[Math.floor(sorted.length / 2)] : null);
  out.kv('inside_ms_max', max(held));
  out.kv('inside_over_2000_ms', held.filter(h => h > 2000).length);
  out.kv('inside_over_10000_ms', held.filter(h => h > 10000).length);
  out.kv('limit_ms', 30000);

  out.section('the_line');
  out.kv('requests_that_waited', r.waits.length);
  out.kv('ahead_max', max(r.waits.map(w => w.ahead)));
  out.kv('ahead_avg', r.waits.length ? +(r.waits.reduce((s, w) => s + w.ahead, 0) / r.waits.length).toFixed(1) : null);

  out.section('longest_inside');
  out.table(['entry', 'bot', 'inside_ms', 'closed_by', 'at_min'],
    [...r.entries].sort((a, b) => (b.heldMs || 0) - (a.heldMs || 0)).slice(0, verbose ? Infinity : SLOW_ROWS)
      .map(e => [e.entry, e.bot, e.heldMs, e.closedBy, Number.isFinite(e.wallSec) ? +(e.wallSec / 60).toFixed(1) : null]));
}

module.exports = { reduceGate, runGate };
