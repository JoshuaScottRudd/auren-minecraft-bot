// machine_load_sampler — writes a record of what this MACHINE was doing while a run happened.
//
// WHY IT EXISTS. Filming scales the wrong way: the fleet is heading for five bots, each with a camera
// window, plus the Architect's eye — six 3D clients rendering at once beside a server, six bot processes
// and a recorder. The question that governs whether that is possible ("does the GPU hold, or does it
// spike") had no instrument at all, so the only available answer was somebody's impression of whether the
// windows felt smooth. An impression does not survive the session and cannot be compared against the next
// run at a different camera count. This writes the record; `monitoring/machine_load_lens.js` reads it.
//
// ── WHAT IT MEASURES, AND WHAT IT DOES NOT ────────────────────────────────────────────────────────────
// It measures MACHINE LOAD: GPU utilisation, VRAM, GPU temperature and power, CPU busy fraction, and free
// system memory. It does NOT measure frame delivery. A hitch a human sees is a late frame, and nothing
// outside the game process can see one — so a clean report here is evidence that the machine had headroom,
// never proof that no window stuttered (Law 25: the verdict states what was actually measured, and the
// asker's question was about smoothness, which is adjacent to this rather than identical to it).
//
// THE ONE EXCEPTION, AND IT IS THE USEFUL ONE: sample JITTER. Every row carries the real interval since the
// row before it. This process asks for a sample on a fixed cadence and does almost nothing else, so when a
// row lands late, something starved the whole machine for that long — not a rendering opinion but a
// scheduling fact, and the closest thing to a stall this side of the game process. The lens reports it.
//
// ── HOW IT SAMPLES, AND WHY nvidia-smi DRIVES THE CLOCK ───────────────────────────────────────────────
// nvidia-smi runs ONCE in its own loop mode and streams a line per interval; every line it emits is one
// sample, stamped and joined with a CPU/memory read taken at that instant. The alternative — a timer here
// spawning nvidia-smi per sample — puts a process launch on the critical path of the very thing being
// measured, and the launch cost is itself load. One long-lived child, one clock, no drift.
//
// NO GPU IS NOT A FAILURE. On a machine with no NVIDIA card the CPU/memory half still records, with the GPU
// fields absent rather than zeroed — a zero is a measurement and would read as an idle GPU (Law 25). The
// lens says "not measured" for those columns.
//
// ── LAW 8: IT DIES WITH THE RUN THAT RAISED IT ────────────────────────────────────────────────────────
// It is raised by the filming overlay and reaped by it, through a pid file that is the only handle: `stop`
// reads that file and kills what it names. Two independent belts, because a sampler is exactly the kind of
// quiet background process nobody notices surviving a crashed conductor — (1) `--max-minutes` self-expiry,
// so an orphan ends on its own even if nothing ever calls `stop`; (2) the pid file is deleted on the way
// out by whichever path ends the process, so a later `stop` cannot kill a pid the OS has since reissued.
//
// Usage:
//   node tools/machine_load_sampler.js run [--label=NAME] [--interval-seconds=1] [--max-minutes=180]
//   node tools/machine_load_sampler.js stop
// Read it back with:  node monitoring/trace_monitor.js --machine-load [--label=NAME]

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

// THE CONSTANT THAT STOOD HERE WAS CALLED REPO_ROOT AND HELD THE BOT ROOT. It was wrong for as long as
// it existed and nothing said so, because inside Auren_Bot the two happened to differ by a level nobody
// read (Law 7 — the name describes what it is). Both are asked of workshop_paths by their real names now.
const paths = require('../workshop_paths');
const RECORD_DIR = paths.fleetLogs('machine_load');
const PID_FILE = paths.bot('js_kernel', 'machine_load_sampler.json');

// The record's name carries the unit that writes it (Law 6), and the label separates one run's record from
// the next without either overwriting the other or needing a clock in the filename.
function recordFileFor(label) {
  return path.join(RECORD_DIR, `machine_load_${label}.jsonl`);
}

// The GPU columns, in the order nvidia-smi is asked for them. One list, used to build the query AND to read
// the reply, so a column added to one cannot go missing from the other (Law 16).
const GPU_FIELDS = [
  ['utilization.gpu', 'gpu_percent'],
  ['memory.used', 'vram_used_mb'],
  ['temperature.gpu', 'gpu_temperature_c'],
  ['power.draw', 'gpu_power_watts'],
  ['clocks.current.graphics', 'gpu_clock_mhz'],
];

// CPU busy fraction across all cores, from the deltas between two readings of the kernel's own counters.
// Deltas rather than a single reading: os.cpus() reports time accumulated since BOOT, so one reading is an
// average over days and would report a flat number no load could move.
function cpuTotals() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function cpuBusyPercent(previous, current) {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;                 // no elapsed tick to divide by — absent, never 0
  return +(100 * (1 - idleDelta / totalDelta)).toFixed(1);
}

function run(label, intervalSeconds, maxMinutes) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  const recordFile = recordFileFor(label);

  // Truncated, not appended: a record named for a label describes THAT run of it, and appending would
  // silently merge two runs into one series whose percentiles belong to neither.
  fs.writeFileSync(recordFile, '');
  fs.writeFileSync(PID_FILE, JSON.stringify({
    pid: process.pid, label, record: recordFile,
    interval_seconds: intervalSeconds, started_at: Date.now(),
  }, null, 2));

  const query = GPU_FIELDS.map(f => f[0]).join(',');
  const child = spawn('nvidia-smi', [
    `--query-gpu=${query}`, '--format=csv,noheader,nounits', '-l', String(intervalSeconds),
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  let previousCpu = cpuTotals();
  let previousAt = Date.now();
  let samples = 0;
  let buffer = '';

  function writeRow(gpu) {
    const at = Date.now();
    const currentCpu = cpuTotals();
    const row = {
      at,
      since_previous_ms: samples === 0 ? null : at - previousAt,
      cpu_percent: cpuBusyPercent(previousCpu, currentCpu),
      memory_free_gb: +(os.freemem() / 1073741824).toFixed(2),
      memory_total_gb: +(os.totalmem() / 1073741824).toFixed(2),
      ...gpu,
    };
    fs.appendFileSync(recordFile, JSON.stringify(row) + '\n');
    previousCpu = currentCpu;
    previousAt = at;
    samples++;
  }

  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const parts = line.trim().split(',').map(s => s.trim());
      if (parts.length !== GPU_FIELDS.length) continue;   // a header or a torn line: skipped, never defaulted
      const gpu = {};
      GPU_FIELDS.forEach(([, name], i) => {
        const value = parseFloat(parts[i]);
        // Absent rather than 0 when the driver reports something unparseable: a zero here would read as a
        // measured idle GPU, which is the one wrong answer this record must never contain (Law 25).
        if (Number.isFinite(value)) gpu[name] = value;
      });
      writeRow(gpu);
    }
  });

  // A missing or failing nvidia-smi is ENVIRONMENTAL (not every machine has an NVIDIA card), so the CPU and
  // memory half keeps recording on this file's own timer rather than the run losing its whole record.
  child.on('error', () => {
    console.log('machine_load_sampler: no nvidia-smi on this machine — recording CPU and memory only.');
    setInterval(() => writeRow({}), intervalSeconds * 1000).unref?.();
    setInterval(() => {}, 1 << 30);            // keep the process alive with no GPU stream to hold it
  });

  const finish = (why) => {
    try { child.kill(); } catch (e) { /* already gone */ }
    try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ }
    console.log(`machine_load_sampler: ${why} — ${samples} sample(s) in ${path.relative(paths.BOT_ROOT, recordFile)}`);
    process.exit(0);
  };
  process.on('SIGTERM', () => finish('stopped'));
  process.on('SIGINT', () => finish('interrupted'));
  setTimeout(() => finish(`self-expired at the ${maxMinutes}-minute ceiling`), maxMinutes * 60000).unref?.();

  console.log(`machine_load_sampler: sampling every ${intervalSeconds}s into ` +
              `${path.relative(paths.BOT_ROOT, recordFile)} (pid ${process.pid}, ceiling ${maxMinutes}m).`);
}

function stop() {
  let record = null;
  try { record = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch (e) { record = null; }
  if (!record || !record.pid) {
    console.log('machine_load_sampler: nothing on record to stop.');
    return true;
  }
  let killed = false;
  try { process.kill(record.pid, 'SIGTERM'); killed = true; }
  catch (e) { /* already gone — the pid file outlived the process */ }
  // Deleted here as well as in the sampler's own exit path: a SIGTERM'd process on Windows may not run its
  // handler, and a pid file naming a dead process is a handle on whatever the OS reissues that number to.
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ }
  console.log(killed
    ? `machine_load_sampler: stopped (pid ${record.pid}, label '${record.label}').`
    : `machine_load_sampler: pid ${record.pid} was already gone; the record it wrote is kept.`);
  return true;
}

module.exports = { recordFileFor, RECORD_DIR, PID_FILE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const verb = args.find(a => !a.startsWith('--')) || 'run';
  const opt = (key, fallback) => {
    const hit = args.find(a => a.startsWith(`--${key}=`));
    return hit ? hit.slice(key.length + 3) : fallback;
  };
  if (verb === 'stop') { stop(); }
  else if (verb === 'run') {
    run(opt('label', 'run'),
        Math.max(1, parseInt(opt('interval-seconds', '1'), 10)),
        Math.max(1, parseInt(opt('max-minutes', '180'), 10)));
  } else {
    console.error(`machine_load_sampler: '${verb}' is not a verb — use 'run' or 'stop'.`);
    process.exit(1);
  }
}
