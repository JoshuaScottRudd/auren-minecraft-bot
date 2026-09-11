// machine_load_lens — reads the machine-load record `tools/machine_load_sampler.js` writes and says
// whether the box had headroom while a run filmed.
//
// THE PAIRING RULE, ONE MORE TIME: the record is a JSONL of one row per sample, and nothing else opens it.
// A caller that wants a number out of it calls `reduceMachineLoad()`; a person asks `trace_monitor
// --machine-load`. Same record, one door, however many lenses (Law 26 — the monitor is the translator).
//
// WHAT THE VERDICT MAY AND MAY NOT SAY. The record contains machine load, not frame delivery, so this
// reports headroom and refuses to report smoothness. A GPU at 40% is evidence the card was not the limit;
// it is NOT evidence that no window hitched, because a hitch is a late frame and no counter here can see
// one (Law 25 — the asker's question was about lag spikes, and the honest answer names which half of that
// this instrument actually holds).
//
// PERCENTILES, NOT AVERAGES, AND THAT IS THE WHOLE POINT. A spike is by definition the tail: a run that
// averages 30% GPU while touching 100% four times has the exact problem being hunted, and its mean hides
// it perfectly. So every column reports p50/p95/max, and the max is the number that decides.
//
// JITTER IS THE ONE STALL SIGNAL. The sampler asks for a row on a fixed cadence and does nothing else, so a
// row that lands late means the machine starved something that was ready to run. It is reported separately
// from the load columns because it is a different KIND of evidence — a scheduling fact rather than a
// utilisation reading — and because it is the only column here that can catch a stall a GPU at 45% cannot.

const fs = require('fs');
const path = require('path');

const paths = require('../workshop_paths');
const RECORD_DIR = paths.fleetLogs('machine_load');

// ── Statistics ───────────────────────────────────────────────────────────────────────────────────────
// Absent values are DROPPED rather than counted as zero: a machine with no GPU would otherwise report a
// beautifully idle card it does not have.
function summarise(values) {
  const present = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!present.length) return null;
  const at = f => present[Math.min(present.length - 1, Math.floor(f * present.length))];
  return { samples: present.length, p50: at(0.5), p95: at(0.95), max: present[present.length - 1] };
}

function readRows(file) {
  const rows = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return rows; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // A torn final row (the sampler was killed mid-append) is SKIPPED, never patched: the throw-on-bad-form
    // half of the interface. Guessing at half a row would put an invented number into a percentile.
    try { rows.push(JSON.parse(line)); } catch (e) { /* torn row */ }
  }
  return rows;
}

function listLabels() {
  try {
    return fs.readdirSync(RECORD_DIR)
      .filter(f => f.startsWith('machine_load_') && f.endsWith('.jsonl'))
      .map(f => f.slice('machine_load_'.length, -'.jsonl'.length));
  } catch (e) { return []; }
}

// ── The machine-facing lens: returns, prints nothing, never exits ────────────────────────────────────
function reduceMachineLoad({ label } = {}) {
  const chosen = label || listLabels().sort().pop() || null;
  if (!chosen) return { found: false, label: null, reason: 'no machine-load record has been written' };
  const file = path.join(RECORD_DIR, `machine_load_${chosen}.jsonl`);
  const rows = readRows(file);
  if (!rows.length) return { found: false, label: chosen, reason: 'the record exists but holds no samples' };

  const column = key => summarise(rows.map(r => r[key]));
  const intervals = rows.map(r => r.since_previous_ms).filter(v => typeof v === 'number');
  const expected = intervals.length ? summarise(intervals).p50 : null;
  // A stall is measured against what the cadence ACTUALLY was rather than what was requested: the sampler
  // may have been asked for 1000 ms and be running at 1030, and calling that 30 ms of stall every row would
  // bury the real ones. The excess over the observed median is what a late row cost.
  const stalls = expected ? intervals.map(v => v - expected).filter(v => v > 0) : [];

  return {
    found: true,
    label: chosen,
    file,
    samples: rows.length,
    spanSeconds: rows.length > 1 ? Math.round((rows[rows.length - 1].at - rows[0].at) / 1000) : 0,
    gpuPercent: column('gpu_percent'),
    vramUsedMb: column('vram_used_mb'),
    gpuTemperatureC: column('gpu_temperature_c'),
    gpuPowerWatts: column('gpu_power_watts'),
    gpuClockMhz: column('gpu_clock_mhz'),
    cpuPercent: column('cpu_percent'),
    memoryFreeGb: column('memory_free_gb'),
    memoryTotalGb: rows[0].memory_total_gb ?? null,
    cadenceMs: expected,
    worstStallMs: stalls.length ? Math.round(Math.max(...stalls)) : 0,
    stallsOver250ms: stalls.filter(v => v > 250).length,
    stallsOver1000ms: stalls.filter(v => v > 1000).length,
  };
}

// ── The human-facing lens: renders, returns the reduction, never exits ───────────────────────────────
function runMachineLoad({ label } = {}) {
  const r = reduceMachineLoad({ label });
  if (!r.found) {
    console.log(`\nMACHINE LOAD — nothing to read (${r.reason}).`);
    const labels = listLabels();
    if (labels.length) console.log(`  records on disk: ${labels.join(', ')}`);
    else console.log(`  a filmed run writes one automatically; or: node Auren_Workshop/tools/machine_load_sampler.js run --label=NAME`);
    return r;
  }

  const line = (name, stat, unit) => {
    if (!stat) { console.log(`  ${name.padEnd(18)} not measured`); return; }
    console.log(`  ${name.padEnd(18)} p50 ${String(stat.p50).padStart(7)}${unit}` +
                `   p95 ${String(stat.p95).padStart(7)}${unit}` +
                `   max ${String(stat.max).padStart(7)}${unit}`);
  };

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`MACHINE LOAD — '${r.label}'   ${r.samples} samples over ${r.spanSeconds}s ` +
              `(every ~${r.cadenceMs ?? '?'}ms)`);
  console.log('═'.repeat(78));
  line('GPU utilisation', r.gpuPercent, '%');
  line('GPU memory', r.vramUsedMb, ' MB');
  line('GPU temperature', r.gpuTemperatureC, ' C');
  line('GPU power', r.gpuPowerWatts, ' W');
  line('GPU clock', r.gpuClockMhz, ' MHz');
  line('CPU busy', r.cpuPercent, '%');
  line('System RAM free', r.memoryFreeGb, ' GB');
  if (r.memoryTotalGb) console.log(`  ${'RAM installed'.padEnd(18)} ${r.memoryTotalGb} GB`);

  console.log('\n  STALLS — how late a sample landed when the machine was busy elsewhere');
  console.log(`  ${'worst stall'.padEnd(18)} ${r.worstStallMs} ms over the ${r.cadenceMs}ms cadence`);
  console.log(`  ${'over 250ms'.padEnd(18)} ${r.stallsOver250ms} sample(s)`);
  console.log(`  ${'over 1000ms'.padEnd(18)} ${r.stallsOver1000ms} sample(s)`);
  console.log('\n  This is machine LOAD, not frame delivery: headroom here does not prove no window hitched.');
  console.log(`  ${path.relative(paths.REPO_ROOT, r.file)}`);
  return r;
}

module.exports = { reduceMachineLoad, runMachineLoad, listLabels, RECORD_DIR };
