<#
.SYNOPSIS
  Manual snapshot & rollback utility for Minecraft server test world(s).

.DESCRIPTION
  Creates versioned snapshots of a world folder (e.g. "Test world") and restores them on demand.
  Assumes you STOP the server before snapshot or restore (to avoid world corruption). You can
  optionally integrate a PID file to allow the script to attempt an automated stop.

.ACTIONS
  snapshot : Copy the current world folder into a timestamped (or named) snapshot directory.
  restore  : Replace the current world folder with a chosen snapshot (backing up current first).
             Bot kernel state (corporate_headquarters*.json) is LEFT INTACT so restoring a
             completed-build snapshot keeps its build-center/stations. If the snapshot is from a
             DIFFERENT world, run the 'flush' verb yourself before starting -- flush is deliberate,
             never a restore side effect.
  list     : List available snapshots for a world.
  prune    : Keep only the newest N snapshots, deleting older ones.
  trim     : Delete pre-restore safety copies beyond -KeepBackups (restore does this itself; this
             verb is for cleaning up a backlog without performing a restore).

.PARAMETERS
  -World         Name of the world folder. Default: whatever server.properties says is live —
                 pass this only to act on a world that is NOT the running one.
  -Name          Friendly snapshot name (optional). If omitted, uses timestamp yyyyMMdd_HHmmss.
  -SnapshotsDir  Root folder for snapshots (default: 'world_snapshots').
  -Zip           Compress snapshot to .zip (speeds up storage; slower restore). Not required.
  -Keep          When pruning: how many latest snapshots to retain.
  -Force         Skip confirmation prompts for restore/prune.
  -Action        One of snapshot|restore|list|prune|trim.
  -KeepBackups   Pre-restore safety copies to retain (default 3). Applied on every restore.
  -PidFile       Optional path to a server PID file (if you modify your launch script to create one).
  -AutoStart     After restore, restart server using launch command (provide -LaunchScript or -LaunchCommand).
  -LaunchScript  Relative path to a .ps1 or .bat used to start the server (mutually exclusive with -LaunchCommand).
  -LaunchCommand Direct command line to start server (string).

.EXAMPLES
  # Every call names the server folder with -Root. From Auren_Bot\, with the server in ..\MinecraftServer:

  # Create a snapshot with timestamp
  .\Auren_Workshop\scripts\world_rollback.ps1 -Root ..\MinecraftServer -Action snapshot -World 'sub_agent_01'

  # Create a named snapshot
  .\Auren_Workshop\scripts\world_rollback.ps1 -Root ..\MinecraftServer -Action snapshot -World 'sub_agent_01' -Name after_roof_build

  # List snapshots
  .\Auren_Workshop\scripts\world_rollback.ps1 -Root ..\MinecraftServer -Action list -World 'sub_agent_01'

  # Restore (will prompt)
  .\Auren_Workshop\scripts\world_rollback.ps1 -Root ..\MinecraftServer -Action restore -World 'sub_agent_01' -Name after_roof_build

  # Restore newest snapshot without prompt
  .\Auren_Workshop\scripts\world_rollback.ps1 -Root ..\MinecraftServer -Action restore -World 'sub_agent_01' -Force

  # Prune keeping last 5
  .\Auren_Workshop\scripts\world_rollback.ps1 -Root ..\MinecraftServer -Action prune -World 'sub_agent_01' -Keep 5 -Force

.NOTES
  To auto-generate a PID file, modify your server launch (example PowerShell):
     Start-Process -FilePath java -ArgumentList '-Xmx2G','-Xms1G','-jar','server.jar','--nogui' -PassThru | \ 
       ForEach-Object { $_ | Set-Content -Path server.pid }

  A graceful 'stop' command requires access to the server console (same process) or RCON.
  This script can only kill the PID if provided; for safest operation, stop manually first.
#>
param(
  [Parameter(Mandatory=$true)][ValidateSet('snapshot','restore','list','prune','trim')][string]$Action,
  # Empty = read `level-name` from server.properties. The old default was the literal 'Test world',
  # which silently became wrong the day the active level changed and would have pointed every verb at
  # a world nobody runs (Invariant B — re-sense the current state, never act on a remembered one;
  # Law 6 — server.properties is the one place that knows which world is live).
  [string]$World = '',
  # Which SERVER directory to act on — the folder holding server.properties and the world folders.
  # REQUIRED: this script ships inside the bot now, so its own folder is never a server, and a default
  # would be a guess at which world to overwrite (Law 13 — never default a field whose wrong value
  # destroys something).
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$Name,
  [string]$SnapshotsDir = 'world_snapshots',
  [switch]$Zip,
  [int]$Keep = 0,
  # How many pre-restore safety copies to retain. See Invoke-BackupRetention for why this defaults to
  # a number instead of "all" — 302 of them reached 21 GB before anyone looked.
  [int]$KeepBackups = 3,
  [switch]$Force,
  [string]$PidFile = 'server.pid',
  [switch]$AutoStart,
  [string]$LaunchScript,
  [string]$LaunchCommand
)

# THE DOOR, FIRST - this script deletes and restores a world folder, which is the most destructive verb
# in the shipped tree. It sits below `param` only because PowerShell requires that block first.
. "$PSScriptRoot\_developer_door.ps1"
Assert-DeveloperMode 'Auren_Workshop/scripts/world_rollback.ps1'

$ErrorActionPreference = 'Stop'

function Write-Info($msg){ Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg){ Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg){ Write-Host "[ERR ] $msg" -ForegroundColor Red }

# -Root MAKES THIS THE ONE ROLLBACK IMPLEMENTATION FOR EVERY SERVER ON THE MACHINE (Law 16). A machine can
# hold several Minecraft servers — the fleet's dev world, and on the dedicated box the PUBLIC world under
# Public_server\runtime\backend — and each needs snapshots, restores and the same pre-restore safety copy.
# A second rollback per server would be a second set of retention rules, a second world-is-held guard and
# a second place for the destructive path to be wrong. Every path below resolves through $scriptRoot.
#
# IT SHIPS WITH THE BOT (moved out of MinecraftServer\ on 2026-09-11), because a run that restores a world
# calls it and a download has no MinecraftServer\ to find it in. That is why -Root has no default: this
# script's own folder is the workshop, not a server.
if (-not (Test-Path -LiteralPath (Join-Path $Root 'server.properties'))) {
  Write-Err "-Root '$Root' holds no server.properties, so it is not a server folder. Pass the folder that holds server.properties and the world folders (for example the fleet's MinecraftServer folder)."
  exit 1
}
$scriptRoot = (Resolve-Path -LiteralPath $Root).Path
function Resolve-FromScriptRoot([string]$child){ if ([System.IO.Path]::IsPathRooted($child)) { return $child } return (Join-Path -Path $scriptRoot -ChildPath $child) }

# Which world is live is Minecraft's answer, not ours — so it is READ, never restated here.
function Get-ActiveLevelName {
  $props = Join-Path -Path $scriptRoot -ChildPath 'server.properties'
  if(!(Test-Path $props)){ return $null }
  foreach($line in (Get-Content -LiteralPath $props)){
    if($line -match '^\s*level-name\s*=\s*(.+?)\s*$'){ return $Matches[1] }
  }
  return $null
}

if([string]::IsNullOrWhiteSpace($World)){
  $World = Get-ActiveLevelName
  if([string]::IsNullOrWhiteSpace($World)){
    Write-Err "No -World given and server.properties has no level-name — cannot tell which world is live."; exit 1
  }
  Write-Info "World not specified; using the live level from server.properties: '$World'"
}

# Normalize paths (relative to the script directory)
$worldPath = Join-Path -Path $scriptRoot -ChildPath $World
if(!(Test-Path $worldPath) -and $Action -ne 'restore' -and $Action -ne 'list'){
  Write-Err "World path not found: $worldPath"; exit 1
}
$snapRoot = Join-Path -Path $scriptRoot -ChildPath $SnapshotsDir
$worldSnapRoot = Join-Path $snapRoot ($World -replace '[\\/:*?"<>|]','_')
if(!(Test-Path $worldSnapRoot)){ New-Item -ItemType Directory -Path $worldSnapRoot | Out-Null }

function Get-Snapshots(){
  if(!(Test-Path $worldSnapRoot)){ return @() }
  Get-ChildItem -Path $worldSnapRoot -Directory | Sort-Object Name -Descending
}

# ── The pre-restore safety copies ────────────────────────────────────────────────────────────────
# THE BLOAT THIS EXISTS TO STOP, and why nobody saw it: `restore` copies the whole world to
# $snapRoot\backup_before_restore_<ts> every single time, but `list` and `prune` both read
# $worldSnapRoot — the per-world subfolder — so the ONE directory that grows without bound was the one
# directory the tool's own verbs could not see. 302 of them accumulated between 2025-08-14 and
# 2026-08-01 and reached 21 GB, against a live world of 19 MB. Nothing was broken; nothing reported it.
#
# Two fixes, and they are the same law twice: retention gives each backup a terminator so it does not
# outlive the run that raised it (Law 8), and `list` now reports them so the growth is inspectable
# rather than hidden (Invariant C / Law 6). Retention is the guarantee; the report is the catch.
#
# Deliberately NOT filed under $worldSnapRoot with the named snapshots: `restore` with no -Name takes
# $snapshots[0], the newest by name, and a backup landing in that list would make an accidental
# restore-of-a-backup the default. They stay separate and are pruned on their own clock.
function Get-PreRestoreBackups(){
  if(!(Test-Path $snapRoot)){ return @() }
  @(Get-ChildItem -Path $snapRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'backup_before_restore_*' } | Sort-Object Name -Descending)
}

function Invoke-BackupRetention([int]$Keep){
  if($Keep -lt 0){ return }
  $all = Get-PreRestoreBackups
  if($all.Count -le $Keep){ Write-Info "Pre-restore backups: $($all.Count) (retention $Keep) — nothing to trim."; return }
  $toDelete = @($all | Select-Object -Skip $Keep)
  Write-Info "Pre-restore backups: $($all.Count); retention is $Keep — trimming $($toDelete.Count) oldest."
  foreach($d in $toDelete){
    try { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop }
    catch {
      # Environmental, not a coding fault: an explorer window or a scanner can hold a folder. The
      # restore already succeeded and the next run trims again, so this warns and never aborts.
      Write-Warn "Could not trim $($d.Name): $($_.Exception.Message)"
    }
  }
}

# Ensure the Minecraft server is stopped before destructive operations.
# If a PID file is present (default server.pid in this folder), try to stop that process.
# Wait until the world folder is genuinely free, not merely until the stop command RETURNED.
#
# WHY: stopping the server is asynchronous. `fleet down` sends the rcon stop, deletes server.pid and
# returns, but the JVM is still flushing region files for seconds afterwards -- and with no pid file
# left, Stop-ServerProcess has nothing to wait on and reports success immediately. The restore then
# raced the dying server and died on it twice on 2026-07-21:
#   Remove-Item : Cannot remove item ...\sub_agent_01: being used by another process
# and the fleet never came up. A fixed Start-Sleep would be a guess; this measures the actual handle.
#
# THE TEST IS THE DELETION ITSELF, and the first version of this got that wrong. It probed
# `session.lock` for an exclusive open, reasoning that this is the handle Minecraft holds all run.
# That handle does clear -- and the delete still failed, because the blocker is a handle on the
# DIRECTORY (and on subdirectories: the first occurrence named `...\sub_agent_01\stats`), which no
# amount of testing one file inside it can see. Measured 2026-07-21: the probe passed silently and the
# very next line died "Cannot remove item ...\sub_agent_01: being used by another process."
# So this asks the operating system the only question whose answer cannot be a proxy -- can this
# folder be removed RIGHT NOW -- by attempting it. Any lesser probe is an inference about a handle we
# cannot enumerate.
#
# WHY IT NEEDS TO WAIT AT ALL: stopping the server is asynchronous. `fleet down` sends the rcon stop,
# deletes server.pid and returns, but the JVM keeps flushing region files for seconds after -- and with
# no pid file left, Stop-ServerProcess has nothing to wait on and reports success immediately. A record
# test tears the fleet down and restores in the same breath, so it hits the JVM mid-exit EVERY time;
# the two runs that got away with it were ones where minutes had passed.
#
# Retrying a delete is not the catch-and-retry Law 13 forbids: that bars retrying when the outcome is
# uncertain or deterministic-zero-progress. Here the outcome is neither -- a process is exiting, so the
# blocker is transient by construction and each attempt has strictly better odds than the last. A fixed
# Start-Sleep would be the guess.
# Default stopped (Law 13): on timeout this returns false and the caller REFUSES the restore rather
# than proceeding into a half-deleted world, which is the one outcome worse than not restoring at all.
function Remove-WorldFolderWhenFree {
  param([string]$Path, [int]$TimeoutSeconds = 60)
  if(!(Test-Path $Path)){ return $true }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $announced = $false
  while($true){
    try {
      Remove-Item -Recurse -Force $Path -ErrorAction Stop
      if($announced){ Write-Info "World folder released; continuing." }
      return $true
    } catch {
      if((Get-Date) -ge $deadline){
        Write-Err "World folder still held after ${TimeoutSeconds}s: $($_.Exception.Message)"
        return $false
      }
      if(-not $announced){
        Write-Info "World folder still held by the stopping server; waiting for it to release..."
        $announced = $true
      }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Stop-ServerProcess {
  try {
    Write-Info "Ensuring server is stopped..."
    $pidPath = if ($PidFile) { Resolve-FromScriptRoot $PidFile } else { $null }
    if ($pidPath -and (Test-Path $pidPath)) {
      $pidRaw = Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
      $serverPid = 0
      if ($pidRaw -match '^\d+$') { $serverPid = [int]$pidRaw }
      if ($serverPid -gt 0) {
        $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        if ($proc) {
          Write-Warn "Server process PID $serverPid appears to be running; attempting graceful stop (Stop-Process)."
          try { Stop-Process -Id $serverPid -ErrorAction SilentlyContinue } catch {}
          Start-Sleep -Seconds 2
          $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
          if ($proc) {
            if ($Force) {
              Write-Warn "Process still running; forcing termination (Stop-Process -Force)."
              try { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue } catch {}
              Start-Sleep -Seconds 2
            } else {
              Write-Warn "Process still running. Re-run with -Force or stop the server manually, then retry."
            }
          }
        } else {
          Write-Info "No running process found for PID $serverPid."
        }
      } else {
        Write-Warn "PID file '$PidFile' did not contain a numeric PID; skipping."
      }
    } else {
      Write-Warn "PID file not found ($PidFile). Make sure the server is stopped before proceeding."
    }
  } catch {
    Write-Warn "Could not verify/stop server process: $($_.Exception.Message)"
  }
}


switch($Action){
  'snapshot' {
    $timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    if(-not $Name){ $Name = $timestamp }
    $snapDir = Join-Path $worldSnapRoot $Name
    if(Test-Path $snapDir){ Write-Err "Snapshot name already exists: $Name"; exit 1 }
    Write-Info "Creating snapshot '$Name' from world '$World'"
    Copy-Item -Path $worldPath -Destination $snapDir -Recurse -Force
    if($Zip){
      $zipPath = "$snapDir.zip"
      Write-Info "Compressing snapshot -> $(Split-Path -Leaf $zipPath)"
      Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
      [System.IO.Compression.ZipFile]::CreateFromDirectory($snapDir, $zipPath)
      Remove-Item -Recurse -Force $snapDir
      Write-Info "Snapshot stored as archive $zipPath"
    }
    Write-Info "Snapshot complete."; break
  }
  'list' {
    $snapshots = Get-Snapshots
    if($snapshots.Count -eq 0){ Write-Info "No snapshots yet for '$World' in $worldSnapRoot" }
    else {
      Write-Host "Snapshots for world '$World':" -ForegroundColor Green
      foreach($s in $snapshots){
        $label = $s.Name
        if(Test-Path (Join-Path $worldSnapRoot ($label + '.zip'))){ $label += ' (zip)' }
        Write-Host "  - $label"
      }
    }
    # Always reported, even when zero. This line is the whole reason the 21 GB could not have hidden:
    # `list` used to answer only about the per-world folder, so the one tree that grows unbounded was
    # invisible to the verb whose job is showing you what is on disk (Invariant C).
    $backups = Get-PreRestoreBackups
    $bytes = 0
    foreach($b in $backups){
      $bytes += (Get-ChildItem -LiteralPath $b.FullName -Recurse -File -ErrorAction SilentlyContinue |
                 Measure-Object -Property Length -Sum).Sum
    }
    $gb = [math]::Round($bytes / 1GB, 2)
    Write-Host "Pre-restore backups (all worlds): $($backups.Count), $gb GB — retention $KeepBackups per restore." -ForegroundColor Green
    if($backups.Count -gt $KeepBackups){
      Write-Warn "Above retention. The next restore trims automatically, or run: rollback.ps1 -Action trim"
    }
    break
  }
  'trim' {
    Invoke-BackupRetention -Keep $KeepBackups
    break
  }
  'restore' {
    Stop-ServerProcess
    $snapshots = Get-Snapshots
    if($snapshots.Count -eq 0){ Write-Err "No snapshots available to restore"; exit 1 }
    if(-not $Name){ $Name = $snapshots[0].Name; Write-Info "No name provided; using latest snapshot '$Name'" }
    $snapDir = Join-Path $worldSnapRoot $Name
    $zipPath = "$snapDir.zip"
    $isZip = $false
    if(!(Test-Path $snapDir)){
      if(Test-Path $zipPath){ $isZip = $true } else { Write-Err "Snapshot not found: $Name"; exit 1 }
    }
    if(-not $Force){
      $resp = Read-Host "Confirm restore of snapshot '$Name' to world '$World'? This overwrites current world (y/N)"
      if($resp -notin @('y','Y','yes','YES')){ Write-Info 'Restore cancelled.'; exit 0 }
    }
    $backupDir = Join-Path $snapRoot ("backup_before_restore_" + (Get-Date -Format 'yyyyMMdd_HHmmss'))
    Write-Info "Backing up current world to $backupDir"
    Copy-Item -Path $worldPath -Destination $backupDir -Recurse -Force
    # Trim AFTER the new copy exists, never before: the retention count includes the backup this
    # restore just took, so the world being replaced is inside the window and can never be the one
    # deleted to make room for itself.
    Invoke-BackupRetention -Keep $KeepBackups
    Write-Info "Removing current world folder ( $worldPath )"
    # Waits for the dying JVM to release the folder, by attempting the removal itself — see the
    # function's note for why probing session.lock instead was a proxy that passed while the real
    # handle (on the directory) was still held.
    if(-not (Remove-WorldFolderWhenFree -Path $worldPath -TimeoutSeconds 60)){
      Write-Err "Refusing to restore: world '$World' is still held by a running process. Stop the fleet and retry."
      exit 1
    }
    if($isZip){
      Write-Info "Expanding zip snapshot"
      Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
      [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $worldSnapRoot)
      Move-Item -Path $snapDir -Destination $worldPath
    } else {
      Write-Info "Restoring directory snapshot"
      Copy-Item -Path $snapDir -Destination $worldPath -Recurse -Force
    }
    Write-Info "Restore complete. World replaced with snapshot '$Name'"

    # HQ kernel state is LEFT INTACT on restore (Architect, 2026-07-03). The whole point of
    # snapshotting a completed build is to skip the ~12-minute rebuild -- but that only works if the
    # matching corporate_headquarters (build-center, staircase site, tracked chests) survives with the
    # world. Auto-deleting it here wiped that state, so bots cold-started with no build site and
    # mining_manager looped to death ("staircase site not locked") until the judge killed it.
    # A flush is now a DELIBERATE act, never a restore side effect: run the 'flush' verb yourself
    # (or delete Auren_Bot/js_kernel/corporate_headquarters*.json) only when you actually want a cold
    # start against a fresh/mismatched world. Forgetting to flush a stale HQ is recoverable; a restore
    # silently erasing the HQ you meant to keep is not.
    Write-Info "HQ kernel state left intact (build-center/stations preserved). If this snapshot is from a DIFFERENT world, run the 'flush' verb before starting so bots don't act on stale coordinates."

    if($AutoStart){
      if($LaunchScript){
  $launchPath = Resolve-FromScriptRoot $LaunchScript
  Write-Info "Starting server via script $launchPath"
  & $launchPath
      } elseif($LaunchCommand){
        Write-Info "Starting server via command: $LaunchCommand"
        Invoke-Expression $LaunchCommand
      } else {
        Write-Warn "AutoStart requested but no LaunchScript or LaunchCommand provided."
      }
    }
    break
  }
  'prune' {
    if($Keep -le 0){ Write-Err '-Keep must be > 0 for prune'; exit 1 }
    $snapshots = Get-Snapshots
    if($snapshots.Count -le $Keep){ Write-Info "Nothing to prune (have $($snapshots.Count), keeping $Keep)"; break }
    $toDelete = $snapshots | Select-Object -Skip $Keep
    if(-not $Force){
      Write-Host "Pruning will delete: " -NoNewline
      Write-Host ($toDelete.Name -join ', ')
      $resp = Read-Host "Proceed? (y/N)"
      if($resp -notin @('y','Y','yes','YES')){ Write-Info 'Prune cancelled.'; exit 0 }
    }
    foreach($d in $toDelete){
      Write-Info "Deleting snapshot folder $($d.Name)"
      Remove-Item -Recurse -Force $d.FullName
      $zip = Join-Path $worldSnapRoot ($d.Name + '.zip')
      if(Test-Path $zip){ Remove-Item -Force $zip }
    }
    Write-Info 'Prune complete.'
    break
  }
}
