// console_window — OPEN A VISIBLE CONSOLE WINDOW. One owner of that act for the whole fleet (Law 16).
//
// THE STANDING RULE THIS SERVES (Architect 2026-09-10): *"why doesent any terminal run? im at home
// looking at the dedicated computer and nothing runs so i cant see whats going on and help at all. every
// terminal always needs to be visible."* It restates 2026-07-10 — *every fleet process runs in its OWN
// visible console window, never a detached/windowless process again* — after a windowless launcher grew
// back in a second place and made the rule true only of the processes that happened to go through the
// first one.
//
// WHY A MODULE AND NOT A FUNCTION IN THE LAUNCHER THAT NEEDED IT FIRST. Three launchers existed and each
// held a DIFFERENT HALF of what a person watching a run needs:
//
//   fleet_control.launch()  — real window, via Start-Process -PassThru.  NO log on disk: its own comment
//                             says "the live window replaces the old fleet_logs/*.log console mirror".
//   run.js launch()         — console on disk from the first byte, handed to the OS as a file
//                             descriptor.  NO WINDOW AT ALL: plain spawn with stdio redirected.
//   foreman.startBot()      — windowsHide:true, output piped into a string read once at the 3-second
//                             launch grace.  NO window and NO file; the bots' console was DISCARDED.
//
// Each was individually defensible and together they meant the dedicated machine showed nothing. The
// capability is "make a process watchable", so it gets ONE implementation and the callers keep only what
// is genuinely theirs — fleet_control its pid bookkeeping, run.js its gates, the foreman its grace window.
//
// WINDOWS AND A FILE ARE NOT THE SAME REQUIREMENT, AND ON WINDOWS THEY CONFLICT. A child's stdout goes
// EITHER to a console a person can see OR to a descriptor the parent can read — redirecting it is what
// makes it readable, and what empties the window. Teeing through a pipe buys both and costs interactive
// stdin, which `run.js` genuinely needs (the person is typed to: `foreman get` is written to it) and
// which the same file also records as the cause of a whole class of dead soaks. So the two are provided
// as two acts, and a caller that needs both takes both:
//
//   openProcess()  — the process IS the window. For anything nobody has to read back in-process.
//   followFile()   — a window that TAILS a file the process is already writing. Costs nothing from the
//                    process: it is a second reader of a file, so it cannot back a pipe up, cannot touch
//                    stdin, and closing it stops nothing (the same property that makes the public
//                    server's board safe to leave open).
//
// IT IS WINDOWS-ONLY AND SAYS SO. `Start-Process` is how a new console is obtained here; a plain spawn
// inherits the parent's console instead of getting its own, which is precisely the bug being fixed. On
// any other platform there is no window to open, so `openProcess` refuses rather than silently producing
// a windowless process and reporting success (Law 13 — default stopped, and never provide a guarantee by
// accident). `followFile` returns null there, because a missing VIEW of a run is not a reason to stop it.

'use strict';

const { spawnSync } = require('child_process');

const TAG = 'console_window';

// ── NO `external_library_guard` REQUIRE HERE, AND THAT IS DELIBERATE (2026-09-10) ───────────────────
// It was tried and reverted the same turn, on evidence. The guard requires `../watcher`, the watcher
// lazily requires `overseer_link`, and `overseer_link` requires `@kernel/watcher` BY ALIAS — so pulling
// the guard in made a `fleet_control down` print:
//
//     [watcher:SELF-FAULT] _forward: Cannot find module '@kernel/watcher'
//     Require stack: overseer_link → watcher → external_library_guard → console_window → fleet_control
//
// `fleet_control.js` is a CLI that does not register module-alias, and the guard's own header names this
// exact hazard: *"RELATIVE, NOT `@kernel/watcher`, AND IT MUST STAY RELATIVE. This module is required
// from processes that do NOT register module-alias"* — a fix it applied to itself and explicitly did not
// apply to `overseer_link`, because it is not that file's owner.
//
// THE GUARD IS NOT NEEDED, WHICH IS WHY THIS IS NOT A DODGE OF LAW 16. The one catch exists for external
// calls that THROW, and neither call here does once it is written correctly:
//   · `spawnSync` reports failure in its RETURN VALUE (`.error`, `.stderr`) rather than by throwing —
//     which is how `fleet_control.launch()` read it, untouched, for every run before this.
//   · the close is done by PowerShell's `Stop-Process … -ErrorAction SilentlyContinue`, not by
//     `process.kill`, which throws ESRCH on an already-gone pid. That pid is the ORDINARY case — a
//     person closing a window by hand is a thing they are entitled to do — and routing it through the
//     guard turned it into `⚠ close the console window at pid 1724 failed: kill ESRCH` on a healthy
//     teardown. A warning for the expected outcome is the noise Law 25 is against, not an instance of it.
// No `try` is written in this file, so there is no catch for preflight to flag and nothing is swallowed.

// How much of an already-written log a follower shows before it starts waiting. A window opened after the
// interesting line was printed is a window that shows nothing, which is the failure this file exists to
// stop; 500 lines is enough to carry a bot's startup and cheap to render.
const FOLLOW_TAIL_LINES = 500;

const isWindows = () => process.platform === 'win32';

// Single-quote for PowerShell: literal, no expansion; an embedded ' doubles to ''. Every path and title
// crossing into a -Command string goes through here — a world folder or a checkout under
// "OneDrive - <organisation>" is the ordinary way an apostrophe or a space reaches this code.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// MINIMIZED IS STILL VISIBLE, BUT IT IS NOT THE DEFAULT ANY MORE (Architect 2026-09-10, superseding
// 2026-09-03). The minimized default came from *"can you place all the node powershells on one as well?
// i want a one stop shop to see all my terminals"* — twelve bots meant twelve consoles covering the
// desktop, and the thing he reads is the merged story in `fleet-console`. That reasoning holds for a
// desktop he is sitting in front of and inverts at the dedicated box, where he found a machine that
// looked idle. "Every terminal always needs to be visible" is the newer instruction and it is the
// stronger one, so NORMAL is the default and `AUREN_BOT_WINDOWS=minimized` is the way back to the quiet
// desktop.
//
// Note for anyone chasing why an override did not take: `run.js` strips every AUREN_* variable before it
// launches anything (`strangerEnv`), deliberately — a stranger's run must not inherit his configuration.
// So this env var cannot reach the fleet from a `run.js` launch, which is exactly why the DEFAULT had to
// be the thing that changed.
function resolveStyle(requested) {
  if (requested) return requested;
  const want = (process.env.AUREN_BOT_WINDOWS || 'normal').toLowerCase();
  if (want === 'minimized') return 'Minimized';
  if (want === 'hidden') return 'Minimized';  // hidden is not on offer — see the header; nearest honoured
  return 'Normal';
}

// openProcess({ exe, argv, cwd, env, style, label }) → the REAL pid of the launched process.
//
// -PassThru yields the pid of `exe` itself (node/java), not of a wrapper, which is the property that
// makes status/down/takeover able to find and hard-kill a survivor. Accurate pid tracking is what
// actually prevents orphans; the window is what makes an orphan obvious to a person.
//
// Each argv element is wrapped in embedded double-quotes: Start-Process joins -ArgumentList with spaces
// and does NOT quote the elements, so an absolute path containing a space reaches node split at the first
// space — the tracer once died on `Cannot find module 'C:\Users\...\OneDrive'` for exactly this reason.
// TWO CALLERS WANT OPPOSITE THINGS FROM A FAILED WINDOW, SO THE ANSWER IS RETURNED AND THE POLICY IS
// THEIRS. `fleet_control` must HALT — a launch with no pid has produced an untrackable process and
// recording a phantom is the orphan bug this whole file exists to prevent. A follower window must NOT
// halt — it is a view, and a run that dies because a window did not open has lost more than the window.
// Writing that as one function with a catch at each site is what preflight refuses, and it is right to:
// the fork is a DECISION and it belongs where the decision is made. So `tryOpenProcess` reports and
// `openProcess` is the strict reading of it (Law 25 — name the shortfall, and let the caller act on it).
function tryOpenProcess({ exe, argv = [], cwd, env = {}, style, label = 'process' }) {
  if (!isWindows()) {
    return {
      ok: false,
      reason: `Windows-only: a visible console is obtained with Start-Process, and this platform is `
        + `${process.platform}. Refusing rather than launching a windowless process and calling it visible.`,
    };
  }
  const argList = argv.length
    ? ` -ArgumentList @(${argv.map(a => psQuote('"' + a + '"')).join(',')})`
    : '';
  const resolved = resolveStyle(style);
  const psCmd =
    `$p = Start-Process -FilePath ${psQuote(exe)}${argList} `
    + `-WorkingDirectory ${psQuote(cwd)} -WindowStyle ${resolved} -PassThru; [Console]::Out.Write($p.Id)`;
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const pid = parseInt((res.stdout || '').trim(), 10);
  if (!Number.isInteger(pid)) {
    return {
      ok: false,
      reason: `opened no window / captured no pid: `
        + `${(res.stderr || '').trim() || (res.error && res.error.message) || 'no pid on stdout'}`,
    };
  }
  return { ok: true, pid, style: resolved };
}

// openProcess(...) → { pid, style }, or THROWS. The reading for a caller that tracks the pid it gets
// back, because for that caller a missing window is a missing process (Law 13: default stopped).
function openProcess(spec) {
  const r = tryOpenProcess(spec);
  if (!r.ok) throw new Error(`[${TAG}] openProcess(${spec && spec.label}) ${r.reason}`);
  return { pid: r.pid, style: r.style };
}

// followFile({ title, logFile, style }) → { pid } of a window tailing `logFile` live, or null if this
// platform has no window to open.
//
// `-NoExit` is load-bearing. `Get-Content -Wait` never returns on its own, so the only things that end it
// are being killed (intended — teardown closes the window) or ERRORING. Without -NoExit an error closes
// the window in the same instant it opens, which reproduces "nothing runs" while looking like a working
// launch. With it, the error stays on screen where a person can read it.
//
// A FOLLOWER IS NOT AUTHORITATIVE AND MUST NEVER BE WAITED ON. It is a view. The process it watches does
// not know it exists, no gate reads it, and a caller that failed to open one carries on — reporting the
// shortfall (Law 25) rather than failing a run over a missing window.
function followFile({ title, logFile, style }) {
  if (!isWindows()) return null;
  // ── UTF-8 FIRST, OR EVERY SYMBOL IN THE LOG ARRIVES AS MOJIBAKE (Architect 2026-09-10) ──────────
  // *"the symbols like the backpack and other signs dont work in a raw powershell. its all mojebake."*
  // The bots write UTF-8; a fresh PowerShell console renders with the machine's ANSI codepage, so
  // `🎒` becomes three wrong characters. THREE things are needed and each fixes a different hop:
  //   OutputEncoding + chcp 65001  — how the console renders what it is given
  //   Get-Content -Encoding UTF8   — how the FILE's bytes are decoded on the way in
  // The last one is the one that is easy to miss: with the console fixed but the read left at default,
  // the text is already mangled before it reaches the screen, so the fix looks like it did not work.
  //
  // ── THE LOG CAN VANISH UNDER IT, AND THAT IS NOT AN ERROR (2026-09-11) ──────────────────────────────
  // A new run empties fleet_logs/ whole, so a window left open from an earlier run — one stopped without
  // its teardown — is following a file that no longer exists, and PowerShell printed a red `Could not find
  // file … console_person.log` over the last thing the person said. So the read stops quietly and the
  // window says what happened instead.
  const psCmd =
    `$OutputEncoding = [System.Text.Encoding]::UTF8; `
    + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `
    + `$null = & chcp 65001; `
    + `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}; `
    + `Write-Host ${psQuote(`-- ${title} -- live console · ${logFile}`)} -ForegroundColor Cyan; `
    + `Get-Content -LiteralPath ${psQuote(logFile)} -Encoding UTF8 -Wait -Tail ${FOLLOW_TAIL_LINES} -ErrorAction SilentlyContinue; `
    + `Write-Host ${psQuote('-- the log this window was following is gone: a new run clears the logs folder when it starts. Nothing is wrong; this window can be closed. --')} -ForegroundColor Yellow`;
  const r = tryOpenProcess({
    exe: 'powershell',
    argv: ['-NoProfile', '-NoExit', '-Command', psCmd],
    cwd: process.cwd(),
    style,
    label: `follow:${title}`,
  });
  if (!r.ok) {
    // The VIEW failed to open. Say so where a person will see it and let the run proceed — the shortfall
    // is named rather than swallowed, and rather than escalated (Law 25).
    console.error(`  [${TAG}] no window for ${title} — ${r.reason}. The console is still on disk: ${logFile}`);
    return null;
  }
  return { pid: r.pid, title, logFile };
}

// closeWindow(pid) — end a window this module opened. Used for followers at teardown: a view left behind
// tailing a file the next run is about to empty is a window showing a run that no longer exists.
// Best-effort by construction, and silent on an already-gone pid, because that is the ordinary case when a
// person closed the window by hand.
// Closed through PowerShell rather than `process.kill` — see the header: an already-gone pid is the
// ordinary case, `process.kill` throws on it, and `Stop-Process -ErrorAction SilentlyContinue` does not.
// Reports whether the window is gone AFTER the attempt, which is the fact the caller wants and is true
// whether this call ended it or somebody had already closed it.
//
// KILLED ON THE PROCESS OBJECT AND CONFIRMED WITH `WaitForExit`, because the two cmdlet spellings of
// this both LIE about the outcome. Measured 2026-09-10 against three real follower windows, each shape
// asked to report the result and then checked from a separate process for the truth:
//
//     Stop-Process; Get-Process                        said=alive   actually=gone   WRONG
//     Stop-Process; Wait-Process -Timeout 5; Get-Process   said=alive   actually=gone   WRONG
//     $p = Get-Process; $p.Kill(); $p.WaitForExit(5000)    said=gone    actually=gone   ✓
//
// `Get-Process` answers from a process-table snapshot taken earlier in the same invocation, so a pid
// killed a statement ago still reads as present — and `Wait-Process` does not rescue it, because
// `Stop-Process` has already removed the pid it would have waited on. The .NET handle has neither
// problem: `WaitForExit` waits on the actual process and the check after it is true.
//
// WHAT THE WRONG VERSION COST, and why a mis-REPORT here is worth this much comment: every close
// returned false, `closeStale` filtered every pid out of its own result, and `down` printed nothing
// while actually reaping four windows. The reap was never broken. From the outside a reaper that does
// nothing and a reaper that does not say so are the same picture, and only a probe separates them.
const CLOSE_WAIT_MS = 5000;
function closeWindow(pid) {
  if (!isWindows() || !Number.isInteger(pid)) return false;
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
    + `if ($p) { $p.Kill(); $null = $p.WaitForExit(${CLOSE_WAIT_MS}) }; `
    + `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [Console]::Out.Write('alive') } `
    + `else { [Console]::Out.Write('gone') }`], { encoding: 'utf8' });
  return (res.stdout || '').trim() === 'gone';
}

// closeStale() → { closed: [pid], reason? } — end every follower window left over from a previous run.
//
// WHY THE OWNERS CANNOT BE RELIED ON TO DO IT, measured 2026-09-10. Each follower is closed by whatever
// opened it: `run.js`'s teardown closes the desk's and the person's, and the foreman's `releaseFetched`
// closes each bot's. The foreman's half does not run. `run.js` kills the desk, `child_fleet` catches that
// and SIGTERMs the foreman, and Node maps SIGTERM onto TerminateProcess on Windows — so the foreman is
// terminated without its exit handlers ever firing. Two bot windows from the 19:31 run were still on the
// desktop during the 19:39 one, tailing files the second run had already deleted.
//
// SO THE RUN THAT IS STARTING REAPS THEM, which is the stronger shape anyway: it does not depend on the
// previous fleet having died cleanly, and a fleet that froze is exactly the one that did not. This is the
// same call `down` already makes for the camera crew and for the same stated reason — a window over a
// world that is gone is not idle, it is a dead window nobody will close.
//
// MATCHED ON THE WINDOW TITLE, AND MATCHING ON THE COMMAND LINE IS THE TRAP (found by being caught in
// it, 2026-09-10).
//
// The obvious discriminator is the command line: a follower's holds `-NoExit`, `Get-Content
// -LiteralPath` and a path inside `fleet_logs`, which `followFile` writes and nothing else does. **It
// is unsafe, and the reason generalises to every text match on a command line: A SHELL THAT MERELY
// MENTIONS THE PATTERN CONTAINS THE PATTERN.** The session developing this code ran a command whose text
// discussed all three markers, so its own `powershell -Command "…"` matched its own reaper and was
// killed by it — twice, before the cause was understood. Adding a third condition did not help; the
// command that added it also mentioned the third.
//
// A WINDOW TITLE CANNOT BE MENTIONED INTO EXISTENCE. It is a property of a window rather than of text,
// and the shells that do this kind of work are `-NonInteractive` with no window and no title at all. So
// the match is: a `powershell` process whose MainWindowTitle begins `auren ` — the prefix `followFile`
// sets and the one thing about a follower that only a real follower has.
//
// CASE-SENSITIVE (`-clike`), which is load-bearing rather than fussy: PowerShell's `-like` is
// case-INSENSITIVE, and the merged `fleet-console` window is titled `AUREN FLEET — …`. That window is
// already reaped by name through `runtime.json`, and catching it here as well would make two owners of
// one teardown.
//
// A PID REGISTRY WAS THE OTHER CANDIDATE AND IS WORSE HERE: it would have to live outside `fleet_logs/`
// to survive the sweep that precedes every run, which means a file that outlives runs in a project where
// no record does (Architect 2026-08-31), and it can go stale where a live query cannot.
function closeStale() {
  if (!isWindows()) return { closed: [] };
  const query =
    `Get-Process powershell -ErrorAction SilentlyContinue | `
    + `Where-Object { $_.MainWindowTitle -clike 'auren *' } | `
    + `ForEach-Object { [Console]::Out.Write([string]$_.Id + ' ') }`;
  const found = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query],
    { encoding: 'utf8' });
  if (found.error) return { closed: [], reason: found.error.message };
  const pids = String(found.stdout || '')
    .trim().split(/\s+/).filter(Boolean).map(n => parseInt(n, 10))
    .filter(n => Number.isInteger(n) && n !== process.pid);
  const closed = pids.filter(pid => closeWindow(pid));
  return { closed };
}

module.exports = {
  openProcess, tryOpenProcess, followFile, closeWindow, closeStale, psQuote, resolveStyle,
  FOLLOW_TAIL_LINES,
};
