// console_window — opens a visible console window for a fleet process; the one owner of that act (Law 16).
// openProcess() makes the process itself the window, for a caller with nothing to read back in-process.
// followFile() opens a window that tails a file the process is already writing, without touching its stdio.
// Windows-only, via `Start-Process`: `openProcess` refuses elsewhere, since a windowless process cannot
// be reported as a success (Law 13); `followFile` returns null there, since a missing view is not a
// reason to stop.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const TAG = 'console_window';

// ── EVERY CALL HAS A WAITING FORM AND A NON-BLOCKING FORM, AND THEY SHARE ONE BODY ─────────
// Each call is written once as a PLAN (the PowerShell arguments, and how to read what comes back) and run
// by either runner: `runSync` for a caller with nothing else to do (a CLI verb, an exit handler), `runAsync`
// for a long-lived process (the foreman) whose loop must keep turning while a window opens or closes.
// `…Async` names are the second form.
function runSync(args, env) {
  const r = spawnSync('powershell', args, { env, encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}
function runAsync(args, env) {
  return new Promise(resolve => {
    const child = spawn('powershell', args, { env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', error => resolve({ stdout, stderr, error }));
    child.on('close', () => resolve({ stdout, stderr, error: null }));
  });
}

// ── NO `external_library_guard` REQUIRE HERE ───────────────────────────────────────────
// Requiring it here pulls in `foreman_link`, which requires `@kernel/watcher` by alias; `fleet_control.js`
// is a CLI that does not register module-alias, so that require fails there. Neither call in this file
// throws: `spawnSync` reports failure in its return value (`.error`, `.stderr`), and the close goes
// through PowerShell's `Stop-Process … -ErrorAction SilentlyContinue`; `process.kill` would throw ESRCH
// on the ordinary case of a pid the person already closed by hand. No `try` is written in this file, so
// there is nothing for preflight to flag and nothing swallowed.

// Lines of an already-written log a follower shows before it starts waiting on new ones.
const FOLLOW_TAIL_LINES = 500;

const isWindows = () => process.platform === 'win32';

// Single-quotes a string for PowerShell: literal, no expansion; an embedded ' doubles to ''. Every path
// and title crossing into a -Command string goes through here.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Window style for a launch: NORMAL by default, so every terminal stays visible. `AUREN_BOT_WINDOWS=
// minimized` (or `hidden`, mapped to the same style — hidden is not on offer) asks for the quiet desktop.
// `run.js` strips every AUREN_* variable before launching a stranger's run, so this override reaches only
// a direct launch, never one through `run.js`.
function resolveStyle(requested) {
  if (requested) return requested;
  const want = (process.env.AUREN_BOT_WINDOWS || 'normal').toLowerCase();
  if (want === 'minimized') return 'Minimized';
  if (want === 'hidden') return 'Minimized';  // hidden is not on offer; nearest style honoured
  return 'Normal';
}

// openProcess({ exe, argv, cwd, env, style, label }) → the REAL pid of the launched process (via
// -PassThru, not a wrapper), which is what lets status/down/takeover find and hard-kill a survivor. Argv
// elements are wrapped in embedded double-quotes because Start-Process joins -ArgumentList unquoted.
// `tryOpenProcess` reports { ok, reason }; `openProcess` is the strict form that throws (Law 25).
function openPlan({ exe, argv = [], cwd, env = {}, style, label = 'process' }) {
  if (!isWindows()) {
    return {
      refused: {
        ok: false,
        reason: `Windows-only: a visible console is obtained with Start-Process, and this platform is `
          + `${process.platform}. Refusing rather than launching a windowless process and calling it visible.`,
      },
    };
  }
  const argList = argv.length
    ? ` -ArgumentList @(${argv.map(a => psQuote('"' + a + '"')).join(',')})`
    : '';
  const resolved = resolveStyle(style);
  const psCmd =
    `$p = Start-Process -FilePath ${psQuote(exe)}${argList} `
    + `-WorkingDirectory ${psQuote(cwd)} -WindowStyle ${resolved} -PassThru; [Console]::Out.Write($p.Id)`;
  return {
    args: ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    env: { ...process.env, ...env },
    read: (res) => {
      const pid = parseInt(res.stdout.trim(), 10);
      if (!Number.isInteger(pid)) {
        return {
          ok: false,
          reason: `opened no window / captured no pid: `
            + `${res.stderr.trim() || (res.error && res.error.message) || 'no pid on stdout'}`,
        };
      }
      remember(pid, label, exe);   // into the ledger at the instant it exists
      return { ok: true, pid, style: resolved };
    },
  };
}
function tryOpenProcess(spec) {
  const plan = openPlan(spec);
  return plan.refused || plan.read(runSync(plan.args, plan.env));
}
async function tryOpenProcessAsync(spec) {
  const plan = openPlan(spec);
  return plan.refused || plan.read(await runAsync(plan.args, plan.env));
}

// The throwing form: a missing window is a missing process for a caller that tracks the pid (Law 13).
function openProcess(spec) {
  const r = tryOpenProcess(spec);
  if (!r.ok) throw new Error(`[${TAG}] openProcess(${spec && spec.label}) ${r.reason}`);
  return { pid: r.pid, style: r.style };
}

// followFile({ title, logFile, style }) → { pid } of a window tailing `logFile` live, or null off Windows.
// A view only, never waited on: a failed open is reported (Law 25), not fatal. `-NoExit` is load-bearing —
// `Get-Content -Wait` only ends by being killed or erroring, and without it an error closes the window in
// the same instant it opens.
function followSpec({ title, logFile, style }) {
  // UTF-8 end to end: OutputEncoding + chcp 65001 fix console rendering, Get-Content -Encoding UTF8 fixes
  // how the log's bytes decode — both needed, or bot output (backpack glyphs etc) renders as mojibake.
  // A run empties fleet_logs/ at start, so a window left open from an earlier run may be tailing a file
  // that is gone; the read then stops quietly, and the window explains what happened, without erroring.
  const psCmd =
    `$OutputEncoding = [System.Text.Encoding]::UTF8; `
    + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `
    + `$null = & chcp 65001; `
    + `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}; `
    + `Write-Host ${psQuote(`-- ${title} -- live console · ${logFile}`)} -ForegroundColor Cyan; `
    + `Get-Content -LiteralPath ${psQuote(logFile)} -Encoding UTF8 -Wait -Tail ${FOLLOW_TAIL_LINES} -ErrorAction SilentlyContinue; `
    + `Write-Host ${psQuote('-- the log this window was following is gone: a new run clears the logs folder when it starts. Nothing is wrong; this window can be closed. --')} -ForegroundColor Yellow`;
  return {
    exe: 'powershell',
    argv: ['-NoProfile', '-NoExit', '-Command', psCmd],
    cwd: process.cwd(),
    style,
    label: `follow:${title}`,
  };
}
function followFile(spec) {
  if (!isWindows()) return null;
  return followRead(spec, tryOpenProcess(followSpec(spec)));
}
async function followFileAsync(spec) {
  if (!isWindows()) return null;
  return followRead(spec, await tryOpenProcessAsync(followSpec(spec)));
}
function followRead({ title, logFile }, r) {
  if (!r.ok) {
    // The view failed to open; name the shortfall (Law 25) and let the run proceed.
    console.error(`  [${TAG}] no window for ${title} — ${r.reason}. The console is still on disk: ${logFile}`);
    return null;
  }
  return { pid: r.pid, title, logFile };
}

// closeWindow(pid) — ends a window this module opened, best-effort, and reports whether it is gone AFTER
// the attempt. Silent on an already-gone pid (an ordinary case, closed by hand), via PowerShell rather
// than `process.kill`. Killed with the .NET handle's `Kill()` + `WaitForExit`, not `Stop-Process`/
// `Get-Process` (the latter can report an already-killed pid as alive). Ends the whole descendant tree,
// deepest-first: a window here often runs its real work as a grandchild, which Windows does not end with
// its parent (e.g. `fleet-console` → `trace.ps1` → `node trace_monitor.js`).
const CLOSE_WAIT_MS = 5000;
function closeArgs(pid) {
  return ['-NoProfile', '-NonInteractive', '-Command',
    `$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate); `
    + `$root = $all | Where-Object { $_.ProcessId -eq ${pid} }; `
    + `$tree = @(); if ($root) { $tree = @($root) }; `
    + `for ($i = 0; $i -lt $tree.Count; $i++) { `
    + `  $parent = $tree[$i]; `
    + `  $tree += @($all | Where-Object { $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate }) }; `
    + `$ids = @($tree | ForEach-Object { $_.ProcessId }); `
    + `[array]::Reverse($ids); `
    + `foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; `
    + `  if ($p) { $p.Kill(); $null = $p.WaitForExit(${CLOSE_WAIT_MS}) } }; `
    + `$left = @(@($ids) + ${pid} | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }); `
    + `if ($left.Count) { [Console]::Out.Write('alive') } else { [Console]::Out.Write('gone') }`];
}
function closeWindow(pid) {
  if (!isWindows() || !Number.isInteger(pid)) return false;
  return runSync(closeArgs(pid), process.env).stdout.trim() === 'gone';
}
async function closeWindowAsync(pid) {
  if (!isWindows() || !Number.isInteger(pid)) return false;
  return (await runAsync(closeArgs(pid), process.env)).stdout.trim() === 'gone';
}

// ── THE LEDGER: EVERY TERMINAL THIS MODULE OPENS, WRITTEN AS IT OPENS ─────────
// Lets start/down see what is still open without asking the desktop — on Windows a console opened here is
// owned by Windows Terminal, not the launched process, so there is no window title on the process to match.
// Machine-local and gitignored beside fleet_control_runtime.json: a pid means nothing on another machine.
// Each entry carries its start time so a pid later recycled by another process is not mistaken for ours
// (`fleet_control.pidAlive`'s rule); a dead entry is dropped the next time the ledger is read.
const LEDGER = path.join(__dirname, '..', '..', 'console_windows.json');
const PID_SKEW_MS = 15000;

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  const entries = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));   // written only below, whole, by rename
  return Array.isArray(entries) ? entries : [];
}
function writeLedger(entries) {
  const tmp = `${LEDGER}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, LEDGER);   // whole or not at all: a reader never meets half a file
}
function remember(pid, label, exe) {
  writeLedger([...readLedger().filter(e => e.pid !== pid),
    { pid, label, exe: path.basename(String(exe)), started_at: new Date().toISOString() }]);
}

// startTimes(pids) → Map(pid → epoch ms) for the pids still alive. One PowerShell call for the whole ledger.
function startTimes(pids) {
  const out = new Map();
  if (!pids.length) return out;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { `
    + `[Console]::Out.WriteLine([string]$_.Id + ' ' + $_.StartTime.ToUniversalTime().ToString('o')) }`],
    { encoding: 'utf8' });
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const [pid, iso] = line.trim().split(' ');
    const ms = Date.parse(iso);
    if (pid && Number.isFinite(ms)) out.set(parseInt(pid, 10), ms);
  }
  return out;
}

// openWindows({ except }) → [{ pid, label, exe, started_at }] — every terminal this module opened that is
// still open. `except` names labels the caller EXPECTS open: run.js joins a world it did not start, so the
// server's terminal is not a reason for it to refuse. Looking also drops the dead entries.
function openWindows({ except = [] } = {}) {
  if (!isWindows()) return [];
  const all = readLedger();
  const started = startTimes(all.map(e => e.pid));
  const live = all.filter(e => started.has(e.pid) && started.get(e.pid) <= Date.parse(e.started_at) + PID_SKEW_MS);
  if (live.length !== all.length) writeLedger(live);
  return live.filter(e => !except.includes(e.label));
}

// closeWindows({ except }) → { closed, stillOpen } — closes every terminal this module opened, then reads
// what is still open off the machine, not assumed from the kills. Never closes the server here:
// a killed JVM is a world killed mid-save, so its window is reported in stillOpen if still open, not killed.
function closeWindows({ except = [] } = {}) {
  const closed = openWindows({ except }).filter(e => e.label !== 'server' && closeWindow(e.pid));
  return { closed, stillOpen: openWindows({ except }) };
}

// describeWindows(list) — the one sentence every start gate and every teardown prints (Law 16).
function describeWindows(list) {
  return list.length
    ? `${list.length} terminal(s) open — ${list.map(e => `${e.label} (${e.exe}, pid ${e.pid}, opened ${e.started_at.slice(11, 19)} UTC)`).join('; ')}`
    : 'no terminals open';
}

module.exports = {
  openProcess, tryOpenProcess, tryOpenProcessAsync, followFile, followFileAsync, closeWindow, closeWindowAsync, openWindows, closeWindows, describeWindows, psQuote, resolveStyle,
  FOLLOW_TAIL_LINES,
};
