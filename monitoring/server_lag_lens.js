// Auren_Bot/monitoring/server_lag_lens.js
// --lag: every time the server fell behind, and what its main thread was doing while it did. Reads three
// records the server leaves in fleet_logs: its console (the `Can't keep up` line states when and by how
// much), Java's own flight record `server.jfr` (each slow file write, file sync, lock wait and collector
// pause, with the thread and the call stack that made it), and the bots' `SERVER BACK` lines (how long
// each body saw the server silent). Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// The flight record is written when the server stops and is decoded by the JDK's own `jfr print`, found
// beside the Java the fleet runs on (workstation.findJava) — the writer's own reader, never a second
// decoder of its format.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --lag [--all]

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const out = require('./data_out');
const lensPaths = require('./lens_paths');

// The server's main thread, by the name Java gives it.
const SERVER_THREAD = ['Server', 'thread'].join(String.fromCharCode(32));
const LAG_RE = /^\[(\d\d):(\d\d):(\d\d)\].*Can't keep up!.*Running (\d+)ms or (\d+) ticks behind/;
const BACK_RE = /SERVER BACK after a silence of (\d+) ms/;
const HOLD_RE = /HOLDING STILL/;
// The foreman's own readings of the machine's disk (foreman/machine_pulse.js).
const DISK_SLOW_RE = /DISK SLOW write_ms=(\d+)/;
const WRITERS_RE = /DISK WRITERS why=(\w+) over_s=(\d+) total_mb=([\d.]+) mb_per_s=([\d.]+) probe_worst_ms=(\d+) free_memory_mb=(\d+) top_mb=(\S+)/;
const EVENTS = 'jdk.FileWrite,jdk.FileForce,jdk.FileRead,jdk.JavaMonitorEnter,jdk.GarbageCollection';
// Seconds read before the stated start of a lag: the console line is printed after the server caught
// its breath, so the work that caused it began a little earlier than `behind_ms` alone reaches.
const LEAD_SEC = 2;
const ROWS = 12;

const UNIT_MS = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000 };
function ms(text) {
  const m = /([\d.]+) (ns|us|µs|ms|s|m)\b/.exec(text || '');
  return m ? +m[1] * UNIT_MS[m[2]] : 0;
}
function secOfDay(h, m, s) { return (+h) * 3600 + (+m) * 60 + (+s); }
function clock(sec) {
  const p = (n) => String(Math.floor(n)).padStart(2, '0');
  return `${p(sec / 3600)}:${p((sec % 3600) / 60)}:${p(sec % 60)}`;
}

// The flight record's events as rows: { name, at (second of day), ms, thread, file, frames[] }.
function flightEvents(jfrFile) {
  const java = require('../js_kernel/utils/workstation').findJava().exe;
  if (!java) return { unread: 'no_java_found' };
  const jfr = path.join(path.dirname(java), process.platform === 'win32' ? 'jfr.exe' : 'jfr');
  if (!fs.existsSync(jfr)) return { unread: 'no_jfr_tool_beside_java' };
  const r = spawnSync(jfr, ['print', '--events', EVENTS, '--stack-depth', '40', jfrFile],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512, windowsHide: true });
  if (r.error || r.status !== 0) return { unread: `jfr_print_exit_${r.error ? r.error.code : r.status}` };
  const rows = [];
  let ev = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const head = /^(\S+) \{$/.exec(line);
    if (head) { ev = { name: head[1].replace(/^jdk\./, ''), at: null, ms: 0, thread: null, file: null, frames: [] }; continue; }
    if (!ev) continue;
    if (line === '}') { rows.push(ev); ev = null; continue; }
    let m;
    if ((m = /^\s+startTime = (\d\d):(\d\d):(\d\d)\.(\d+)/.exec(line))) ev.at = secOfDay(m[1], m[2], m[3]) + (+`0.${m[4]}`);
    else if ((m = /^\s+(?:duration|sumOfPauses) = (.+)$/.exec(line))) ev.ms = Math.max(ev.ms, ms(m[1]));
    else if ((m = /^\s+eventThread = "([^"]+)"/.exec(line))) ev.thread = m[1];
    else if ((m = /^\s+path = "([^"]+)"/.exec(line))) ev.file = m[1];
    else if ((m = /^\s+([\w.$<>]+)\(.*\)\s+line:/.exec(line))) ev.frames.push(m[1].split('.').slice(-2).join('.'));
  }
  return { rows };
}

// Which part of the server's tick an event happened inside: the call the tick made that led to it.
function tickPart(frames) {
  const i = frames.indexOf('MinecraftServer.tickServer');
  if (i < 1) return frames.length ? frames[frames.length - 1] : 'unstated';
  const part = frames[i - 1];
  return (part === 'MinecraftServer.tickChildren' && i >= 2) ? frames[i - 2] : part;
}
// What kind of file: its folder and its extension, so every player file reads as one kind.
function fileKind(file) {
  if (!file) return 'none';
  const parts = file.split(/[\\/]/);
  return `${parts[parts.length - 2] || 'root'}/${path.extname(file).slice(1) || 'none'}`;
}

function _tally(rows, keyOf) {
  const by = new Map();
  for (const e of rows) {
    const k = keyOf(e);
    const g = by.get(k) || { key: k, n: 0, ms: 0, max: 0 };
    g.n++; g.ms += e.ms; g.max = Math.max(g.max, e.ms);
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => b.ms - a.ms);
}

function runLag({ seg = [], traceName = '?', verbose = false } = {}) {
  out.kv('lens', 'lag');
  out.kv('record', traceName);

  // When the server said it fell behind.
  const consoleFile = lensPaths.bot('fleet_logs', 'console_server.log');
  const lags = [];
  if (fs.existsSync(consoleFile)) {
    for (const line of fs.readFileSync(consoleFile, 'utf8').split(/\r?\n/)) {
      const m = LAG_RE.exec(line);
      if (m) lags.push({ at: secOfDay(m[1], m[2], m[3]), behindMs: +m[4], ticks: +m[5] });
    }
  }

  // What the bodies saw.
  const backs = [];
  let holds = 0;
  for (const l of seg) {
    const m = BACK_RE.exec(l.raw);
    if (m) backs.push({ bot: l.bot, ms: +m[1] });
    else if (HOLD_RE.test(l.raw)) holds++;
  }

  // THE DISK, as the foreman measured it while the fleet ran: every slow probe, and which programs wrote
  // the most between readings.
  const slow = [];
  const readings = [];
  const desk = require('./foreman_lens').readForemanTrace();
  const deskStart = desk.length ? desk[0].atMs : null;
  for (const l of desk) {
    let m = DISK_SLOW_RE.exec(l.raw);
    if (m) { slow.push(+m[1]); continue; }
    m = WRITERS_RE.exec(l.raw);
    if (m) readings.push({ wallSec: (deskStart && l.atMs) ? (l.atMs - deskStart) / 1000 : null, why: m[1], sec: +m[2], mb: +m[3], rate: +m[4], probe: +m[5], free: +m[6], top: m[7] });
  }
  out.section('disk');
  out.kv('slow_probes', slow.length);
  out.kv('slow_probe_ms_worst', slow.reduce((s, v) => Math.max(s, v), 0));
  out.kv('writer_readings', readings.length);
  out.kv('machine_mb_per_s_avg', readings.length ? +(readings.reduce((s, r) => s + r.mb, 0) / Math.max(1, readings.reduce((s, r) => s + r.sec, 0))).toFixed(1) : null);
  out.kv('machine_mb_per_s_worst', readings.reduce((s, r) => Math.max(s, r.rate), 0));
  out.kv('free_memory_mb_lowest', readings.length ? readings.reduce((s, r) => Math.min(s, r.free), Infinity) : null);
  const programs = new Map();
  for (const r of readings) {
    if (r.top === 'none') continue;
    for (const part of r.top.split(',')) {
      const i = part.lastIndexOf(':');
      const g = programs.get(part.slice(0, i)) || { key: part.slice(0, i), n: 0, ms: 0, max: 0 };
      g.n++; g.ms += +part.slice(i + 1); g.max = Math.max(g.max, +part.slice(i + 1));
      programs.set(g.key, g);
    }
  }
  out.table(['program', 'readings_in_top', 'total_mb', 'worst_reading_mb'],
    [...programs.values()].sort((a, b) => b.ms - a.ms).slice(0, ROWS).map(g => [g.key, g.n, +g.ms.toFixed(1), +g.max.toFixed(1)]));
  out.section('disk_heaviest_readings');
  out.table(['run_min', 'why', 'over_s', 'mb_per_s', 'probe_worst_ms', 'free_memory_mb', 'top_mb'],
    [...readings].sort((a, b) => (b.probe - a.probe) || (b.rate - a.rate)).slice(0, 8)
      .map(r => [r.wallSec === null ? null : +(r.wallSec / 60).toFixed(1), r.why, r.sec, r.rate, r.probe, r.free, r.top]));

  const jfrFile = lensPaths.bot('fleet_logs', 'server.jfr');
  const flight = fs.existsSync(jfrFile) ? flightEvents(jfrFile) : { unread: 'no_server_jfr' };
  const all = flight.rows || [];
  const onServer = all.filter(e => e.thread === SERVER_THREAD && e.name !== 'GarbageCollection');
  const pauses = all.filter(e => e.name === 'GarbageCollection');
  const sum = (rows) => Math.round(rows.reduce((s, e) => s + e.ms, 0));

  out.section('server_lag');
  out.kv('times_server_fell_behind', lags.length);
  out.kv('behind_ms_total', lags.reduce((s, l) => s + l.behindMs, 0));
  out.kv('behind_ms_worst', lags.reduce((s, l) => Math.max(s, l.behindMs), 0));
  out.kv('silences_seen_by_bots', backs.length);
  out.kv('silence_ms_longest', backs.reduce((s, b) => Math.max(s, b.ms), 0));
  out.kv('times_a_bot_held_still', holds);
  out.kv('flight_record', flight.unread ? flight.unread : 'read');
  if (flight.unread) return;
  out.kv('server_thread_blocked_ms', sum(onServer));
  out.kv('collector_pause_ms_total', sum(pauses));
  out.kv('collector_pause_ms_worst', Math.round(pauses.reduce((s, e) => Math.max(s, e.ms), 0)));

  // THE CAUSE, RUN-WIDE: what the server's main thread waited on, by the part of the tick that asked.
  out.section('server_thread_waits_by_cause');
  out.table(['tick_part', 'waited_on', 'file_kind', 'events', 'total_ms', 'worst_ms', 'avg_ms'],
    _tally(onServer, e => `${tickPart(e.frames)}|${e.name}|${fileKind(e.file)}`).slice(0, verbose ? Infinity : ROWS)
      .map(g => [...g.key.split('|'), g.n, Math.round(g.ms), Math.round(g.max), +(g.ms / g.n).toFixed(1)]));

  // EACH LAG: what filled the stretch the server said it was behind for.
  out.section('each_lag');
  out.table(['at', 'behind_ms', 'ticks', 'server_thread_blocked_ms', 'collector_pause_ms', 'events', 'top_tick_part', 'top_waited_on', 'top_file_kind', 'top_ms'],
    lags.map(l => {
      const from = l.at - l.behindMs / 1000 - LEAD_SEC;
      const inWin = (e) => e.at !== null && e.at >= from && e.at <= l.at;
      const mine = onServer.filter(inWin);
      const top = _tally(mine, e => `${tickPart(e.frames)}|${e.name}|${fileKind(e.file)}`)[0];
      const t = top ? top.key.split('|') : ['none', 'none', 'none'];
      return [clock(l.at), l.behindMs, l.ticks, sum(mine), sum(pauses.filter(inWin)), mine.length, t[0], t[1], t[2], top ? Math.round(top.ms) : 0];
    }));

  // WHEN the waits happened: one row per minute the server thread waited at all, so a wait on a fixed
  // beat reads as evenly spaced rows.
  out.section('server_thread_waits_by_minute');
  out.table(['minute', 'events', 'total_ms', 'worst_ms', 'top_tick_part'],
    _tally(onServer.filter(e => e.at !== null), e => clock(Math.floor(e.at / 60) * 60).slice(0, 5))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map(g => {
        const top = _tally(onServer.filter(e => e.at !== null && clock(Math.floor(e.at / 60) * 60).slice(0, 5) === g.key), e => tickPart(e.frames))[0];
        return [g.key, g.n, Math.round(g.ms), Math.round(g.max), top.key];
      }));

  if (verbose) {
    out.section('silences_by_bot');
    out.table(['bot', 'silences', 'longest_ms'],
      _tally(backs.map(b => ({ ...b, key: b.bot })), b => b.bot).map(g => [g.key, g.n, Math.round(g.max)]));
  }
}

module.exports = { runLag };
