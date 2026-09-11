// bot_cost_probe — measures what ONE BOT costs this machine, in CPU and memory.
//
// WHY IT EXISTS. The public-server plan sizes a bot-host machine from a number nobody had ever taken:
// two bots per human means the fleet grows with the audience, so "how much compute does one bot need"
// decides how many people can be let in per box. Before this, the only answers available were an
// impression of Task Manager and arithmetic on a whole-machine average.
//
// ── WHY PER-PROCESS AND NOT WHOLE-MACHINE (the reason this is not machine_load_sampler) ──────────────
// `tools/machine_load_sampler.js` answers a different question — *did the box have headroom while a run
// filmed* — and answers it for the WHOLE machine over time, which is right for that question and wrong for
// this one. A whole-machine before/after delta would fold three things into one number that must be kept
// apart: the Minecraft server (which on the target architecture runs on a rented box, not the bot host),
// the overseer (one per fleet, not one per bot), and whatever the Architect happens to be doing on his own
// desktop while the probe runs. Attribution is the entire point here, so this reads per-process counters
// and reports each role separately. Neither instrument can answer the other's question; there is no
// redundant route (Law 16).
//
// ── WHY A WINDOW DELTA AND NOT A SAMPLE STREAM ───────────────────────────────────────────────────────
// The OS keeps CUMULATIVE processor time per process. Two reads that far apart therefore give the exact
// CPU-seconds consumed in between — not an estimate assembled from samples, and with no per-sample cost
// added to the very machine being measured. Memory is different: working set moves, so it is sampled
// through the window and reported as a peak as well as a mean, because a host is sized by the peak.
//
// WHAT THIS DELIBERATELY DOES NOT REPORT: peak CPU. A window delta yields the MEAN, and that is the right
// number for capacity — it is what decides how many bots fit on a box. It is the wrong number for
// smoothness: a bot that spends three seconds inside one A* search shows here as a small average, and if
// several bots burst together the host stutters in a way no mean can show (Law 25 — the verdict states
// what was measured).
//
// ── WHOSE PROCESS IS IT (two traps, both of which have already bitten) ───────────────────────────────
// The roles come from `fleet_control_runtime.json`, the fleet's own pid map (Law 16 — one source), and it
// has to be read with two corrections.
//
//   1. PID REUSE. That file keeps entries for processes that died long ago, and Windows reissues pids, so
//      a pid alone answers "does SOME process hold this number", never "is it mine" — a trap fleet_control
//      names in its own comments. Every root is confirmed by its START TIME matching what the file
//      recorded; a mismatch is reported as stale and excluded rather than silently measured as a bot.
//   2. THE RECORDED PID MAY BE A WRAPPER. Measured 2026-09-03: the server's recorded pid held 9.8 MB and
//      almost no CPU, because it is a launcher whose CHILD is the 1.2 GB JVM doing all the work. Reading
//      the recorded pid alone reported the server as costing nothing. So each role is measured as its
//      whole PROCESS TREE — the recorded process plus every descendant — which is correct for a wrapper
//      and unchanged for a role that has none.
//
// Usage:
//   node Auren_Workshop/tools/bot_cost_probe.js --seconds=180
//   node Auren_Workshop/tools/bot_cost_probe.js --seconds=180 --note="2 bots, autonomy running"

require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/bot_cost_probe.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BOT_DIR = require('../workshop_paths').BOT_ROOT;
const RUNTIME_FILE = path.join(BOT_DIR, 'fleet_control_runtime.json');

// A process is the one the runtime file meant if it started within this much of the recorded moment.
// Generous because the file is written after the spawn returns, not at the instant the OS created it.
const START_TIME_TOLERANCE_MS = 120000;

// ── Reading the OS ───────────────────────────────────────────────────────────────────────────────────
// Pipe-delimited lines rather than JSON: Windows PowerShell 5.1 collapses a one-element array on
// ConvertTo-Json, which would make a single-process reading parse as an object and a multi-process one as
// an array. A delimiter has no such shape.
function powershellLines(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
                      { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || typeof r.stdout !== 'string') return [];
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

function readProcesses(pids) {
  if (!pids.length) return new Map();
  const script = `$ErrorActionPreference='SilentlyContinue'
foreach ($id in @(${pids.join(',')})) {
  $p = Get-Process -Id $id
  if ($p) {
    $st = 0
    if ($p.StartTime) { $st = [long]([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }
    Write-Output "$($p.Id)|$($p.ProcessName)|$($p.TotalProcessorTime.TotalSeconds)|$($p.WorkingSet64)|$st"
  }
}`;
  const found = new Map();
  for (const line of powershellLines(script)) {
    const parts = line.split('|');
    if (parts.length !== 5) continue;
    const pid = parseInt(parts[0], 10);
    const cpuSeconds = parseFloat(parts[2]);
    const workingSet = parseFloat(parts[3]);
    const startedMs = parseFloat(parts[4]);
    if (!Number.isFinite(pid) || !Number.isFinite(cpuSeconds)) continue;
    found.set(pid, {
      pid, name: parts[1], cpuSeconds,
      workingSetMb: +(workingSet / 1048576).toFixed(1),
      startedMs: Number.isFinite(startedMs) && startedMs > 0 ? startedMs : null,
    });
  }
  return found;
}

// One enumeration of the whole process table, reduced to parent → children. Taken once: a fleet under
// measurement is not spawning new workers, and re-walking the table every sample would put the cost of a
// full WMI query onto the machine being measured.
function readChildrenByParent() {
  const byParent = new Map();
  for (const line of powershellLines(
    `$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)" }`)) {
    const [a, b] = line.split('|');
    const pid = parseInt(a, 10), ppid = parseInt(b, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid === ppid) continue;
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  return byParent;
}

// A `seen` set rather than a depth limit: pid reuse can make the parent table describe a cycle, and a walk
// that trusted it would not return.
function treeOf(rootPid, byParent) {
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  return [...seen];
}

// ── The roster under measurement ─────────────────────────────────────────────────────────────────────
// A role name ending in "Bot" is a construct; the rest are the fleet's shared machinery, and the whole
// point of separating them is that the shared machinery does NOT multiply with the player count.
function isBot(role) { return /Bot$/.test(role); }

function loadCandidates() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); }
  catch (e) { return { error: `cannot read ${path.relative(BOT_DIR, RUNTIME_FILE)}: ${e.message}`, candidates: [] }; }
  const candidates = [];
  for (const [role, entry] of Object.entries(raw)) {
    if (!entry || typeof entry.pid !== 'number') continue;
    candidates.push({ role, pid: entry.pid, recordedStartMs: Date.parse(entry.started_at) || null });
  }
  return { error: null, candidates };
}

function cpuTotals() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function padLeft(s, n) { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; }

// Sum a tree's counters out of one reading. Absent pids are skipped rather than counted as zero — a child
// that exited mid-window contributes the CPU it used before it went, and inventing a zero for it would
// understate the role (Law 25).
function sumTree(reading, pids) {
  let cpu = 0, mem = 0, present = 0;
  for (const pid of pids) {
    const seen = reading.get(pid);
    if (!seen) continue;
    cpu += seen.cpuSeconds; mem += seen.workingSetMb; present++;
  }
  return { cpu, mem, present };
}

async function probe(seconds, note) {
  const cores = os.cpus().length;
  const cpuModel = os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown';

  const { error, candidates } = loadCandidates();
  if (error) { console.error(`bot_cost_probe: ${error}`); process.exit(1); }
  if (!candidates.length) { console.error('bot_cost_probe: the runtime file names no processes — is the fleet up?'); process.exit(1); }

  // ── T0: confirm identity, expand each role to its tree, take the opening counters ────────────────
  const roots = readProcesses(candidates.map(c => c.pid));
  const byParent = readChildrenByParent();
  const live = [], stale = [];
  for (const c of candidates) {
    const seen = roots.get(c.pid);
    if (!seen) { stale.push({ ...c, why: 'no process holds this pid' }); continue; }
    const drift = (seen.startedMs && c.recordedStartMs) ? Math.abs(seen.startedMs - c.recordedStartMs) : null;
    if (drift !== null && drift > START_TIME_TOLERANCE_MS) {
      stale.push({ ...c, why: `pid reused — that process started ${Math.round(drift / 60000)} min from the recorded launch` });
      continue;
    }
    live.push({ ...c, name: seen.name, pids: treeOf(c.pid, byParent), memSamples: [] });
  }
  if (!live.length) { console.error('bot_cost_probe: every pid in the runtime file is stale — nothing to measure.'); process.exit(1); }

  const allPids = [...new Set(live.flatMap(l => l.pids))];
  const opening = readProcesses(allPids);
  for (const l of live) {
    const s = sumTree(opening, l.pids);
    l.cpu0 = s.cpu;
    l.memSamples.push(s.mem);
  }

  console.log(`bot_cost_probe: measuring ${live.length} role(s), ${allPids.length} process(es), over ${seconds}s`);
  console.log(`                on ${cpuModel} (${cores} logical cores).`);
  for (const l of live) if (l.pids.length > 1) console.log(`  ${l.role}: ${l.pids.length} processes (a wrapper and its children) — summed as one role`);
  if (stale.length) for (const s of stale) console.log(`  ignored ${pad(s.role, 12)} pid ${s.pid} — ${s.why}`);
  console.log('');

  const machine0 = cpuTotals();
  const startedAt = Date.now();

  // ── Through the window: memory only, cheaply ────────────────────────────────────────────────────
  const memoryReads = Math.max(2, Math.min(12, Math.floor(seconds / 15)));
  const gap = (seconds * 1000) / memoryReads;
  for (let i = 0; i < memoryReads; i++) {
    await sleep(gap);
    const now = readProcesses(allPids);
    for (const l of live) l.memSamples.push(sumTree(now, l.pids).mem);
  }

  // ── T1: closing counters ────────────────────────────────────────────────────────────────────────
  const wallSeconds = (Date.now() - startedAt) / 1000;
  const closing = readProcesses(allPids);
  const machine1 = cpuTotals();

  const rows = [];
  for (const l of live) {
    const s = sumTree(closing, l.pids);
    if (!s.present) { rows.push({ role: l.role, pid: l.pid, died: true }); continue; }
    const cpuDelta = s.cpu - l.cpu0;
    rows.push({
      role: l.role, pid: l.pid, died: false, processes: l.pids.length,
      cpuSeconds: +cpuDelta.toFixed(2),
      coreFraction: +(100 * cpuDelta / wallSeconds).toFixed(1),      // % of ONE core
      machineFraction: +(100 * cpuDelta / wallSeconds / cores).toFixed(2),
      memMeanMb: +(l.memSamples.reduce((a, b) => a + b, 0) / l.memSamples.length).toFixed(1),
      memPeakMb: +Math.max(...l.memSamples).toFixed(1),
    });
  }

  // ── The report ──────────────────────────────────────────────────────────────────────────────────
  const machineBusy = (() => {
    const t = machine1.total - machine0.total, i = machine1.idle - machine0.idle;
    return t > 0 ? +(100 * (1 - i / t)).toFixed(1) : null;
  })();

  console.log(`window: ${wallSeconds.toFixed(1)}s   whole machine busy: ${machineBusy === null ? 'not measured' : machineBusy + '%'}${note ? '   note: ' + note : ''}`);
  console.log('');
  console.log(`${pad('role', 14)}${padLeft('procs', 6)}${padLeft('cpu-sec', 10)}${padLeft('% of 1 core', 13)}${padLeft('% of box', 10)}${padLeft('mem mean', 11)}${padLeft('mem peak', 11)}`);
  console.log('-'.repeat(75));
  for (const r of rows) {
    if (r.died) { console.log(`${pad(r.role, 14)}   process ended during the window — excluded`); continue; }
    console.log(`${pad(r.role, 14)}${padLeft(r.processes, 6)}${padLeft(r.cpuSeconds, 10)}${padLeft(r.coreFraction + '%', 13)}${padLeft(r.machineFraction + '%', 10)}${padLeft(r.memMeanMb + ' MB', 11)}${padLeft(r.memPeakMb + ' MB', 11)}`);
  }

  const bots = rows.filter(r => !r.died && isBot(r.role));
  console.log('');
  if (!bots.length) {
    console.log('No bot process was measured — the fleet may be up but idle of constructs.');
  } else {
    const coreEach = bots.reduce((a, b) => a + b.coreFraction, 0) / bots.length;
    const memEach = bots.reduce((a, b) => a + b.memPeakMb, 0) / bots.length;
    console.log(`PER BOT (mean of ${bots.length}):   ${coreEach.toFixed(1)}% of one core   ${memEach.toFixed(0)} MB peak resident`);
    console.log(`PER PAIR (one human):  ${(coreEach * 2).toFixed(1)}% of one core   ${(memEach * 2).toFixed(0)} MB peak resident`);
    console.log('');
    // Stated separately BECAUSE it does not multiply: one overseer serves the fleet, and the Minecraft
    // server is not on the bot host at all in the target architecture.
    const shared = rows.filter(r => !r.died && !isBot(r.role));
    if (shared.length) {
      console.log('Shared machinery — does NOT multiply with player count:');
      for (const s of shared) console.log(`  ${pad(s.role, 12)}${padLeft(s.coreFraction + '% of one core', 22)}${padLeft(s.memPeakMb + ' MB peak', 16)}`);
    }
  }
  console.log('');
  console.log('CPU is measured against ONE core of this CPU. Projecting onto different hardware needs the');
  console.log('single-thread performance ratio between the two chips, not the core count alone.');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (key, fallback) => {
    const hit = args.find(a => a.startsWith(`--${key}=`));
    return hit ? hit.slice(key.length + 3) : fallback;
  };
  probe(Math.max(10, parseInt(opt('seconds', '180'), 10)), opt('note', ''));
}
