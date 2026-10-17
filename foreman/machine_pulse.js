// foreman/machine_pulse.js — THE MACHINE'S DISK, ASKED WHILE THE FLEET RUNS.
//
// The server saves each player's file on its main thread, so a disk that is slow to take a write stops
// the world for as long as the write takes. Two readings say when that is happening and who is causing it:
//   DISK SLOW    every PROBE_MS one small file is written and renamed beside the run's records, timed. A
//                healthy disk takes about a millisecond. At DISK_SLOW_MS or more it is a warning line; a
//                healthy probe is silent and its worst value rides the next DISK WRITERS line.
//   DISK WRITERS every WRITERS_MS, and again after a slow probe: how many megabytes each program on the
//                machine wrote since the last reading, largest first, from the operating system's own
//                per-process counters. The counters are running totals, so a reading taken after a stall
//                still names what wrote during it. THE COUNTER IS EVERY WRITE, NOT THE DISK'S: Windows'
//                WriteTransferCount adds files, pipes between a program's own processes and the network
//                together. Discord's renderer handing frames to its own GPU process read as 50 GB here
//                while its files grew by 27 MB, so a program high in this list has not been shown to
//                write to the disk; the slow probe and the disk's own latency are the disk's readings.
// Each reading is one line in the foreman's record; the `--lag` lens reads them back after the run.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { RECORDS_DIR } = require('@utils/record_homes');
const { guardExternal } = require('@utils/external_library_guard');
const timeoutCrash = require('../js_kernel/utils/timeout_crash');

const PROBE_MS = 5000;
const WRITERS_MS = 30000;
const DISK_SLOW_MS = 100;
const WRITERS_SHOWN = 5;
const WRITER_FLOOR_MB = 1;
const MB = 1024 * 1024;

let probeTimer = null;
let writersTimer = null;
let probing = false;
let reading = false;
let last = null;          // { atMs, bytes: Map<'pid|name', number> }
let worstMs = 0;
let slowProbes = 0;
let worstSinceMs = 0;     // the slowest probe since the last DISK WRITERS line

// One running total of bytes written per process, as the operating system counts them.
function processWriteTotals() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const ask = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.WriteTransferCount)" }';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ask], { windowsHide: true, maxBuffer: 8 * MB },
      (err, stdout) => {
        if (err) { reject(err); return; }
        const totals = new Map();
        for (const line of String(stdout).split(/\r?\n/)) {
          const [pid, name, bytes] = line.trim().split('|');
          if (pid && name && Number.isFinite(+bytes)) totals.set(`${pid}|${name}`, +bytes);
        }
        resolve(totals);
      });
  });
}

async function readWriters(log, why) {
  if (reading) return;
  reading = true;
  const r = await guardExternal('machine_pulse', 'read how much each program has written to disk', processWriteTotals);
  reading = false;
  if (!r.ok) { log(`DISK WRITERS why=${why} unread=${r.reason}`); return; }
  if (!r.value) { log(`DISK WRITERS why=${why} unread=not_read_on_${process.platform}`); return; }
  const now = { atMs: Date.now(), bytes: r.value };
  if (last) {
    const sec = Math.max(1, (now.atMs - last.atMs) / 1000);
    const byName = new Map();
    let total = 0;
    for (const [key, bytes] of now.bytes) {
      const wrote = bytes - (last.bytes.get(key) || 0);
      if (!(wrote > 0)) continue;
      const name = key.split('|')[1];
      byName.set(name, (byName.get(name) || 0) + wrote);
      total += wrote;
    }
    const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).filter(([, b]) => b >= WRITER_FLOOR_MB * MB).slice(0, WRITERS_SHOWN)
      .map(([name, b]) => `${name}:${(b / MB).toFixed(1)}`).join(',');
    log(`DISK WRITERS why=${why} over_s=${sec.toFixed(0)} total_mb=${(total / MB).toFixed(1)} mb_per_s=${(total / MB / sec).toFixed(1)} `
      + `probe_worst_ms=${worstSinceMs.toFixed(0)} free_memory_mb=${Math.round(os.freemem() / MB)} top_mb=${top || 'none'}`);
    worstSinceMs = 0;
  }
  last = now;
}

async function probe(log, warn) {
  if (probing) return;
  probing = true;
  const file = path.join(RECORDS_DIR, 'disk_probe.tmp');
  const started = process.hrtime.bigint();
  const r = await guardExternal('machine_pulse', 'time one small write to the disk', async () => {
    await fs.promises.writeFile(file, 'probe');
    await fs.promises.rename(file, `${file}.done`);
    await fs.promises.unlink(`${file}.done`);
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  probing = false;
  if (!r.ok) return;
  worstMs = Math.max(worstMs, ms);
  worstSinceMs = Math.max(worstSinceMs, ms);
  if (ms >= DISK_SLOW_MS) {
    slowProbes++;
    warn(`DISK SLOW write_ms=${ms.toFixed(0)} — a small write that takes about 1 ms on a healthy disk; the server stops for as long as its own writes take`);
    readWriters(log, 'slow');
  }
}

function start(log, warn) {
  if (probeTimer) return;
  probeTimer = timeoutCrash.every('machine_pulse', 'time one small write to the disk', () => probe(log, warn), PROBE_MS);
  writersTimer = timeoutCrash.every('machine_pulse', 'read how much each program has written to disk', () => readWriters(log, 'beat'), WRITERS_MS);
  probeTimer.unref(); writersTimer.unref();
  readWriters(log, 'start');
  startSeconds(log);
}

function stop() {
  if (probeTimer) { timeoutCrash.stop(probeTimer); probeTimer = null; }
  if (writersTimer) { timeoutCrash.stop(writersTimer); writersTimer = null; }
  if (secondsChild) { secondsChild.kill(); secondsChild = null; }
}

// ── THE MACHINE AT A LAG ────────────────────────────────────────────────────────────────────────────
// Asked when the server says it fell behind (foreman_world's SERVER LAG), at most once a LAG_EVERY_MS: the
// programs taking the most processor and the most I/O at that moment (files, pipes and network together, as
// above), memory and paging, the disk's write
// latency, queue and busy share, and every Windows event of the stretch the server was behind for plus
// LAG_EVENTS_LEAD_S before it (system warnings and errors, Windows Update, servicing, Defender). One
// `MACHINE AT LAG` line and one `MACHINE AT LAG EVENT` line per event; the `--lag` lens reads them back.
const LAG_EVERY_MS = 60000;
const LAG_EVENTS_LEAD_S = 120;
const LAG_PROGRAMS_SHOWN = 6;
const LAG_EVENTS_SHOWN = 20;
let lastLagAt = 0;

function machineAtLag(sinceSec) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const top = `Select-Object -First ${LAG_PROGRAMS_SHOWN}`;
  const ask = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' }",
    `$p | Sort-Object PercentProcessorTime -Descending | ${top} | ForEach-Object { "C|$($_.Name)|$($_.PercentProcessorTime)" }`,
    `$p | Sort-Object IODataBytesPersec -Descending | ${top} | ForEach-Object { "I|$($_.Name)|$($_.IODataBytesPersec)" }`,
    "$c = (Get-Counter -Counter '\\Memory\\Available MBytes','\\Memory\\Pages/sec','\\Memory\\% Committed Bytes In Use','\\PhysicalDisk(_Total)\\Avg. Disk sec/Write','\\PhysicalDisk(_Total)\\Current Disk Queue Length','\\PhysicalDisk(_Total)\\% Disk Time').CounterSamples",
    '$c | ForEach-Object { "K|$($_.Path.Split(\'\\\')[-1])|$($_.CookedValue)" }',
    `$since = (Get-Date).AddSeconds(-${Math.ceil(sinceSec)})`,
    "$asks = @(@{LogName='System'; StartTime=$since; Level=1,2,3}, @{LogName='System'; StartTime=$since; ProviderName='Microsoft-Windows-WindowsUpdateClient'}, @{LogName='Setup'; StartTime=$since}, @{LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=$since})",
    `foreach ($a in $asks) { Get-WinEvent -FilterHashtable $a -MaxEvents ${LAG_EVENTS_SHOWN} | ForEach-Object { "E|$($_.TimeCreated.ToString('HH:mm:ss'))|$($_.LogName)|$($_.ProviderName)|$($_.Id)|$((($_.Message -split [char]10)[0] -replace '[|]','/').Trim())" } }`,
    // Get-WinEvent reports a window with no event as an error, which would end the call with a failing code.
    'exit 0',
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ask], { windowsHide: true, maxBuffer: 8 * MB },
      (err, stdout) => { if (err) reject(err); else resolve(String(stdout).split(/\r?\n/).map(l => l.trim()).filter(Boolean)); });
  });
}

async function atLag(log, behindMs) {
  if (Date.now() - lastLagAt < LAG_EVERY_MS) return;
  lastLagAt = Date.now();
  writeSeconds(log);
  readWriters(log, 'lag');
  const r = await guardExternal('machine_pulse', 'read what the machine was doing when the server fell behind',
    () => machineAtLag(behindMs / 1000 + LAG_EVENTS_LEAD_S));
  if (!r.ok) { log(`MACHINE AT LAG behind_ms=${behindMs} unread=${r.reason}`); return; }
  if (!r.value) { log(`MACHINE AT LAG behind_ms=${behindMs} unread=not_read_on_${process.platform}`); return; }
  const cpu = [], io = [], counters = {}, seen = new Set();
  for (const line of r.value) {
    const [kind, ...rest] = line.split('|');
    if (kind === 'C') cpu.push(`${rest[0]}:${rest[1]}`);
    else if (kind === 'I') io.push(`${rest[0]}:${(+rest[1] / MB).toFixed(1)}`);
    else if (kind === 'K') counters[rest[0]] = +rest[1];
    else if (kind === 'E' && !seen.has(line)) {
      seen.add(line);
      const [at, logName, source, id, ...text] = rest;
      log(`MACHINE AT LAG EVENT at=${at} log=${logName.replace(/\s+/g, '_')} source=${source} id=${id} text=${text.join('|').slice(0, 200)}`);
    }
  }
  const n = (key, digits = 0) => (Number.isFinite(counters[key]) ? counters[key].toFixed(digits) : 'unread');
  log(`MACHINE AT LAG behind_ms=${behindMs} cpu_top_pct=${cpu.join(',') || 'none'} io_top_mb_per_s=${io.join(',') || 'none'} `
    + `available_mb=${n('available mbytes')} pages_per_s=${n('pages/sec')} commit_pct=${n('% committed bytes in use')} `
    + `disk_write_ms=${Number.isFinite(counters['avg. disk sec/write']) ? (counters['avg. disk sec/write'] * 1000).toFixed(1) : 'unread'} `
    + `disk_queue=${n('current disk queue length')} disk_busy_pct=${n('% disk time')} events=${seen.size}`);
}

// ── EVERY SECOND, KEPT FOR A MINUTE ─────────────────────────────────────────────────────────────────
// The reading at a lag is taken after the server has printed its warning, seconds after the stall, by when
// the disk has recovered. Windows' own counter reader runs beside the fleet the whole run, one row a second,
// and the last SECONDS_KEPT rows are kept; at a lag they are written out, so the stall's own seconds are in
// the record. The disk's latency is measured below the file system, the antivirus filter above it: a server
// write that is slow while the disk's own latency stays low was held above the disk.
const SECONDS_KEPT = 60;
const SECOND_COUNTERS = [
  ['disk_write_ms', '\\PhysicalDisk(_Total)\\Avg. Disk sec/Write', 1000],
  ['disk_queue', '\\PhysicalDisk(_Total)\\Current Disk Queue Length', 1],
  ['disk_busy_pct', '\\PhysicalDisk(_Total)\\% Disk Time', 1],
  ['defender_cpu_pct', '\\Process(MsMpEng)\\% Processor Time', 1],
  ['server_write_ops', '\\Process(java)\\IO Write Operations/sec', 1],
  ['server_cpu_pct', '\\Process(java)\\% Processor Time', 1],
];
let secondsChild = null;
const seconds = [];       // [{ at: 'HH:MM:SS', values: number[] }]

function startSeconds(log) {
  if (process.platform !== 'win32' || secondsChild) return;
  let buf = '';
  secondsChild = spawn('typeperf', [...SECOND_COUNTERS.map(c => c[1]), '-si', '1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  // A child outlives its parent on Windows; the reader ends with the foreman however the foreman ends.
  process.once('exit', () => { if (secondsChild) secondsChild.kill(); });
  secondsChild.on('error', (e) => { log(`MACHINE SECONDS unread=${e.code || e.message}`); secondsChild = null; });
  secondsChild.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const cells = line.split('","').map(c => c.replace(/"/g, ''));
      const at = /\d\d:\d\d:\d\d/.exec(cells[0] || '');
      if (!at || cells.length < SECOND_COUNTERS.length + 1) continue;
      seconds.push({ at: at[0], values: SECOND_COUNTERS.map((c, i) => +cells[i + 1] * c[2]) });
      if (seconds.length > SECONDS_KEPT) seconds.shift();
    }
  });
}

function writeSeconds(log) {
  for (const s of seconds) {
    log(`MACHINE AT LAG SECOND at=${s.at} ` + SECOND_COUNTERS.map((c, i) =>
      `${c[0]}=${Number.isFinite(s.values[i]) && s.values[i] >= 0 ? s.values[i].toFixed(1) : 'unread'}`).join(' '));
  }
}

// What the disk did this run, for the run's verdict.
function summary() { return { worst_write_ms: Math.round(worstMs), slow_probes: slowProbes, slow_ms: DISK_SLOW_MS }; }

module.exports = { start, stop, summary, atLag, DISK_SLOW_MS };
