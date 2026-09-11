# THE REMOTE HUB — this box becomes the one machine the work happens on, driven from the phone,
# the work laptop, or any browser. It runs Claude Code in SERVER MODE, which is the only mode that
# lets a REMOTE device open and close sessions on its own; every other mode mirrors one session that
# was already opened here at the keyboard.
#
# What this is NOT: remote desktop. Nothing here forwards a screen, a mouse or a keyboard. The remote
# device sends TEXT to a Claude session that is running on this machine, and that session touches this
# machine's filesystem, this machine's git checkout, this machine's node. That is the whole point —
# he instructs, the session acts here.
#
# ── WHY SERVER MODE AND NOT `--remote-control` ─────────────────────────────────────────────────────
# `claude --remote-control` and `/remote-control` both publish ONE session, the one already open in
# that terminal. Three concurrent sessions would mean three terminals opened by hand at this keyboard,
# which defeats the entire arrangement the moment he is not sitting at it. `claude remote-control`
# (no dashes) is a SERVER: it holds one process open and mints sessions ON DEMAND when a device asks
# for one, up to -Capacity. Opening and closing a session becomes a thing the phone does.
#
# ── WHY --spawn same-dir, WHICH IS NOT THE OBVIOUS CHOICE ──────────────────────────────────────────
# The alternative, `--spawn worktree`, gives every on-demand session its own git worktree so they
# cannot collide. That is the right default for most repos and the WRONG one for this one. This repo
# already solves concurrent sessions its own way, in CLAUDE.md and in Sessions/: preflight declares
# who is here and what they own, session_sync serialises every write to the trunk behind a lock, and
# the last session in has authority to resolve overlap. That machinery assumes ONE working tree that
# the sessions share. Handing each session a private worktree would not add safety on top of it — it
# would run a second, invisible isolation scheme underneath one that is already load-bearing, and the
# session_sync lock would be arbitrating between trees that never see each other's files. One
# mechanism per job (Law 16): the tree is shared, and Sessions/ is what makes that safe.
#
# ── WHY THIS SCRIPT ELEVATES ITSELF ────────────────────────────────────────────────────────────────
# A session inherits the privileges of the process that started it. Started from an ordinary shell it
# can read anything and change anything he owns, but it cannot touch a service, a firewall rule, a
# scheduled task or Program Files — and every one of those has come up in this project already (the
# firewall Block rules nobody wrote, the public server's service, the dedicated box's PATH). So the
# script relaunches itself through UAC once, and every session the server mints from then on is
# elevated with it. The UAC dialog cannot be answered from the phone, which is exactly why it is
# answered ONCE here and then made durable with -InstallStartup.
#
# Usage (from the repo root):
#   .\Auren_Workshop\scripts\start_remote_hub.ps1                      # bring the hub up
#   .\Auren_Workshop\scripts\start_remote_hub.ps1 -InstallStartup      # ...and have it do so at every logon
#   .\Auren_Workshop\scripts\start_remote_hub.ps1 -PermissionMode bypassPermissions   # never ask, just act
#   .\Auren_Workshop\scripts\start_remote_hub.ps1 -Status              # is it up? don't start anything
#   .\Auren_Workshop\scripts\start_remote_hub.ps1 -RemoveStartup       # undo -InstallStartup

param(
    # acceptEdits  — file edits land without asking; shell commands still ask, and the ask arrives on
    #                his phone and waits there until answered. The safe default.
    # bypassPermissions — nothing ever asks. Combined with the elevation above this is a session that
    #                can do anything on this box on a sentence's say-so. That is a decision he makes,
    #                not one this script makes for him, so it is a flag and not the default.
    [ValidateSet('acceptEdits', 'bypassPermissions', 'manual', 'plan', 'auto', 'dontAsk')]
    [string]$PermissionMode = 'acceptEdits',

    [int]$Capacity = 8,                 # concurrent sessions the server will mint. He runs 3; 8 is headroom.
    [string]$Prefix = 'auren-hub',      # session names become auren-hub-<something>, so the list says which box
    [switch]$InstallStartup,            # register the logon task, then continue and run the hub now
    [switch]$RemoveStartup,             # unregister the logon task and exit
    [switch]$Status,                    # report and exit; start nothing
    [switch]$NoElevate                  # internal: set on the relaunched copy so it cannot loop
)

$ErrorActionPreference = 'Stop'
$scriptPath  = $MyInvocation.MyCommand.Path
$scriptDir   = Split-Path -Parent $scriptPath
$repoRoot    = Split-Path -Parent (Split-Path -Parent $scriptDir)
$taskName    = 'AurenRemoteHub'

# Claude Code records workspace trust under the working directory it was given, VERBATIM. Windows
# treats c:\ and C:\ as the same place; ~/.claude.json does not, and this box already carries BOTH
# `c:/Auren_Minecraft` and `C:/Auren_Minecraft` as separate project entries. Trust accepted under one
# casing is invisible to a session started under the other, and the symptom is a trust dialog that
# reappears after it was already answered. Everything below normalises to an upper-case drive letter
# so the session that COLLECTS trust and the server that NEEDS it are keyed identically.
if ($repoRoot -match '^([a-zA-Z]):') { $repoRoot = $repoRoot.Substring(0,1).ToUpper() + $repoRoot.Substring(1) }

function Write-Head($text) { Write-Host ""; Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok  ($text) { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [warn] $text" -ForegroundColor Yellow }
function Write-Bad ($text) { Write-Host "  [STOP] $text" -ForegroundColor Red }

# ── The claude resolver ────────────────────────────────────────────────────────────────────────────
# Same reasoning as _node.ps1's Get-AurenNode: which install exists differs per machine, and a path
# that EXISTS is not a binary that RUNS (Law 25 — exercise the capability, never infer it). The native
# build under .local\bin comes first because that is what `claude install` puts down; PATH is the
# fallback for a machine that got it some other way.
function Get-AurenClaude {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\claude\claude.exe')
    )
    $onPath = Get-Command claude -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }

    foreach ($c in $candidates) {
        if (-not $c) { continue }
        if (-not (Test-Path $c)) { continue }
        try {
            $null = & $c --version 2>$null
            if ($LASTEXITCODE -eq 0) { return $c }
        } catch { }
    }
    return $null
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ── Is this workspace trusted? ─────────────────────────────────────────────────────────────────────
# SERVER MODE NEVER SHOWS THE TRUST DIALOG. It refuses at startup with "Workspace not trusted" and
# tells you to run `claude` in the directory first. That is the whole reason this check exists: the
# gate is real, but the only thing that can OPEN it is an ordinary interactive session. Discovered the
# hard way on 2026-09-09, when the launcher hit the refusal and retried it three times.
#
# The flag lives in ~/.claude.json under projects.<cwd>.hasTrustDialogAccepted. It is read with node
# rather than ConvertFrom-Json because that file legitimately carries the same path under two drive-
# letter casings, and PowerShell 5.1's parser throws outright on duplicate keys ("a dictionary that was
# converted from the string contains the duplicated keys"). JSON.parse takes last-wins and moves on.
# Returns TRUSTED / UNTRUSTED / UNKNOWN. UNKNOWN never blocks — an unreadable config is not a verdict.
function Get-WorkspaceTrust {
    param([string]$Path)
    try {
        . "$PSScriptRoot\_node.ps1"
        $node = Get-AurenNode
        if (-not $node) { return 'UNKNOWN' }
    } catch { return 'UNKNOWN' }

    # JS below uses SINGLE quotes only and no $ — PowerShell 5.1 wraps a native argument in double
    # quotes without escaping any it contains, so an embedded double quote would arrive broken.
    # The path travels by environment variable for the same reason: nothing to quote.
    $env:AUREN_TRUST_PATH = $Path
    $js = "const fs=require('fs');let out='UNKNOWN';try{const j=JSON.parse(fs.readFileSync(process.env.USERPROFILE+'/.claude.json','utf8'));const want=(process.env.AUREN_TRUST_PATH||'').replace(/\\/g,'/').toLowerCase();out='UNTRUSTED';for(const k of Object.keys(j.projects||{})){if(k.replace(/\\/g,'/').toLowerCase()===want&&j.projects[k].hasTrustDialogAccepted===true)out='TRUSTED';}}catch(e){out='UNKNOWN';}console.log(out);"
    try {
        # Compared EXACTLY, never with -match: 'TRUSTED' is a substring of 'UNTRUSTED', so a regex
        # alternation would report an untrusted workspace as trusted and send the hub straight back
        # into the refusal this function exists to prevent.
        $result = "$(& $node -e $js 2>$null | Select-Object -Last 1)".Trim()
        if ($result -eq 'TRUSTED' -or $result -eq 'UNTRUSTED') { return $result }
        return 'UNKNOWN'
    } catch { return 'UNKNOWN' }
    finally { Remove-Item Env:\AUREN_TRUST_PATH -ErrorAction SilentlyContinue }
}

# ── -Status: answer and leave ──────────────────────────────────────────────────────────────────────
if ($Status) {
    Write-Head "REMOTE HUB STATUS"
    $claude = Get-AurenClaude
    if ($claude) { Write-Ok "claude CLI: $claude ($(& $claude --version))" }
    else         { Write-Bad "claude CLI not found - run: claude install" }

    $procs = @(Get-Process claude -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) { Write-Ok  "$($procs.Count) claude process(es) running (PIDs: $($procs.Id -join ', '))" }
    else                    { Write-Warn "no claude process running - the hub is down" }

    switch (Get-WorkspaceTrust -Path $repoRoot) {
        'TRUSTED'   { Write-Ok   "workspace trusted: $repoRoot" }
        'UNTRUSTED' { Write-Warn "workspace NOT trusted: $repoRoot - server mode will refuse to start" }
        default     { Write-Warn "workspace trust state unreadable" }
    }

    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) { Write-Ok  "logon task '$taskName' registered (state: $($task.State))" }
    else       { Write-Warn "logon task not registered - run with -InstallStartup to survive a reboot" }
    Write-Host ""
    return
}

# ── -RemoveStartup: undo and leave ─────────────────────────────────────────────────────────────────
if ($RemoveStartup) {
    Write-Head "REMOVING THE LOGON TASK"
    if (-not (Test-IsAdmin)) { Write-Bad "needs an elevated shell - right-click PowerShell, Run as administrator"; return }
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Ok "'$taskName' unregistered" }
    else       { Write-Warn "'$taskName' was not registered - nothing to do" }
    Write-Host ""
    return
}

# ── Elevate, once ──────────────────────────────────────────────────────────────────────────────────
# The 2026-09-09 lesson applies here and is why the arguments are built as an explicit array with the
# path quoted by hand: a quoted path folded into a -ArgumentList STRING does not survive the trip, and
# the relaunched window dies with no reader and no stderr, which looks identical to a clean exit.
# -NoExit keeps the elevated window open so its output has somewhere to go.
if (-not (Test-IsAdmin) -and -not $NoElevate) {
    Write-Head "ELEVATING - answer the Windows UAC prompt"
    Write-Host "  Every session this hub mints inherits admin from here, which is what lets it change" -ForegroundColor DarkGray
    Write-Host "  services, firewall rules and scheduled tasks on your behalf." -ForegroundColor DarkGray

    $relaunch = @(
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $scriptPath),
        '-NoElevate',
        '-PermissionMode', $PermissionMode,
        '-Capacity', $Capacity,
        '-Prefix', $Prefix
    )
    if ($InstallStartup) { $relaunch += '-InstallStartup' }

    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $relaunch
        Write-Ok "elevated window opened - the hub runs there, this window is done"
    } catch {
        Write-Bad "UAC was declined; the hub did not start"
    }
    return
}

Write-Head "AUREN REMOTE HUB"
Write-Host "  repo: $repoRoot" -ForegroundColor DarkGray

# ── Preflight: everything the docs say can silently disable Remote Control ─────────────────────────
$claude = Get-AurenClaude
if (-not $claude) {
    Write-Bad "claude CLI not found. Install the native build, then re-run this script:"
    Write-Host "         claude install" -ForegroundColor White
    return
}
Write-Ok "claude CLI: $claude ($(& $claude --version))"

if (Test-IsAdmin) { Write-Ok "running elevated - sessions minted here can act as administrator" }
else              { Write-Warn "NOT elevated - sessions will be limited to ordinary user rights" }

# These four each switch off the feature-flag evaluation Remote Control's availability rides on, and a
# fifth points the client at a host that does not serve it. They fail QUIETLY — the session starts and
# simply never appears on the phone — which is the whole reason they are checked up front rather than
# diagnosed later.
$blockers = @()
foreach ($v in 'DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_GROWTHBOOK', 'ANTHROPIC_BASE_URL') {
    $set = @('Process', 'User', 'Machine') | Where-Object { [Environment]::GetEnvironmentVariable($v, $_) }
    if ($set) { $blockers += "$v (set in: $($set -join ', '))" }
}
if ($blockers.Count -gt 0) {
    Write-Bad "these disable Remote Control - unset them and re-run:"
    $blockers | ForEach-Object { Write-Host "         $_" -ForegroundColor White }
    return
}
Write-Ok "no environment variable is blocking Remote Control"

# ── The logon task ─────────────────────────────────────────────────────────────────────────────────
# Registered with RunLevel Highest, which is what makes the hub come up elevated at logon WITHOUT a
# UAC dialog — the dialog he cannot answer from a phone. It is deliberately "run only when logged on":
# the claude.ai credentials live in his user profile, so a SYSTEM task would come up unauthenticated.
if ($InstallStartup) {
    Write-Head "REGISTERING THE LOGON TASK"
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ('-NoExit -ExecutionPolicy Bypass -File "{0}" -NoElevate -PermissionMode {1} -Capacity {2} -Prefix {3}' -f $scriptPath, $PermissionMode, $Capacity, $Prefix) `
        -WorkingDirectory $repoRoot
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    # ExecutionTimeLimit 0 = never kill it. A hub with a deadline is not a hub.
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Description 'Auren remote hub - Claude Code server mode, elevated, at logon' | Out-Null
    Write-Ok "'$taskName' registered - the hub returns on its own after a reboot"
}

# ── Run the server, and keep it running ────────────────────────────────────────────────────────────
# Server mode EXITS on its own after roughly ten minutes of no network, by design. On a machine that is
# meant to be reachable from a phone at any hour, an exit like that is indistinguishable from the hub
# being switched off, and he would find out by the phone showing nothing. Hence the loop.
#
# The loop has a floor: if the process keeps dying INSTANTLY it is not a network blip, it is a refused
# consent dialog or a bad flag, and spinning on it would bury the one line of output that explains why.
Set-Location $repoRoot

# ── The trust gate, collected before it can refuse us ──────────────────────────────────────────────
# Server mode cannot open this gate; only an interactive session can. So if the workspace is not yet
# trusted, hand him one there and then, in this same pass, rather than exiting with an instruction to
# run a different command and start over.
$trust = Get-WorkspaceTrust -Path $repoRoot
if ($trust -eq 'UNTRUSTED') {
    Write-Head "WORKSPACE TRUST IS NOT YET ACCEPTED"
    Write-Host "  Server mode cannot show you the trust dialog - it refuses to start instead. Only an" -ForegroundColor DarkGray
    Write-Host "  ordinary interactive session can ask, so this opens one for you now." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  1. Choose 'Yes, I trust this folder'." -ForegroundColor Yellow
    Write-Host "  2. Then type  /exit  to close that session." -ForegroundColor Yellow
    Write-Host "  The hub starts on its own straight afterwards - you do not re-run anything." -ForegroundColor Yellow
    Write-Host ""

    & $claude

    $trust = Get-WorkspaceTrust -Path $repoRoot
    if ($trust -eq 'UNTRUSTED') {
        Write-Bad "the workspace is still not trusted, so the hub cannot start."
        Write-Host "         Run  claude  in $repoRoot and accept the dialog, then run this script again." -ForegroundColor White
        return
    }
    Write-Ok "workspace trusted"
} elseif ($trust -eq 'TRUSTED') {
    Write-Ok "workspace trusted"
} else {
    Write-Warn "could not read the trust state - continuing; server mode will say if it is missing"
}

Write-Head "STARTING SERVER MODE"
Write-Host "  permission mode : $PermissionMode"
Write-Host "  capacity        : $Capacity concurrent sessions, minted on demand from your phone or browser"
Write-Host "  spawn           : same-dir (this repo's own Sessions/ machinery arbitrates the shared tree)"
Write-Host ""
Write-Host "  First run only: accept the workspace trust dialog, then answer y to 'Enable Remote Control?'." -ForegroundColor Yellow
Write-Host "  Then open claude.ai/code or the Claude app and the hub is in your session list." -ForegroundColor Yellow
Write-Host "  Press spacebar in this window for a QR code. Ctrl+C stops the hub." -ForegroundColor DarkGray

$fastFailures = 0
while ($true) {
    $startedAt = Get-Date

    # Every flag goes AFTER `remote-control`. A global claude flag placed BEFORE the subcommand is not
    # carried into the sessions the server creates, and Claude Code refuses to start rather than run
    # them under a flag he thinks he set.
    & $claude remote-control `
        --spawn same-dir `
        --capacity $Capacity `
        --permission-mode $PermissionMode `
        --remote-control-session-name-prefix $Prefix

    $ranFor = (Get-Date) - $startedAt
    if ($ranFor.TotalSeconds -lt 20) {
        $fastFailures++
        if ($fastFailures -ge 3) {
            Write-Bad "server mode exited immediately three times - read the message above this line."
            Write-Host "         If it says the Remote Control consent was declined: re-run and answer y." -ForegroundColor White
            Write-Host "         If it says the workspace is not trusted even though the check above passed," -ForegroundColor White
            Write-Host "         trust was accepted under a different drive-letter casing. Run  claude  from" -ForegroundColor White
            Write-Host "         exactly  $repoRoot  and accept it there." -ForegroundColor White
            break
        }
        Write-Warn "exited after $([int]$ranFor.TotalSeconds)s (attempt $fastFailures of 3) - retrying"
    } else {
        $fastFailures = 0
        Write-Warn "server mode exited after $([int]$ranFor.TotalMinutes)m - restarting (usually a network drop)"
    }
    Start-Sleep -Seconds 5
}
