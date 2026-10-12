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
//                still names what wrote during it.
// Each reading is one line in the foreman's record; the `--lag` lens reads them back after the run.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
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
}

function stop() {
  if (probeTimer) { timeoutCrash.stop(probeTimer); probeTimer = null; }
  if (writersTimer) { timeoutCrash.stop(writersTimer); writersTimer = null; }
}

// What the disk did this run, for the run's verdict.
function summary() { return { worst_write_ms: Math.round(worstMs), slow_probes: slowProbes, slow_ms: DISK_SLOW_MS }; }

module.exports = { start, stop, summary, DISK_SLOW_MS };
