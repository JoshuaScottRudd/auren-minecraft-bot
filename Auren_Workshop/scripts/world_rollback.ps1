<#
.SYNOPSIS
  Manual snapshot & rollback utility for Minecraft server test world(s).

.DESCRIPTION
  Creates versioned snapshots of a world folder (e.g. "Test world") and restores them on demand.
  Assumes you STOP the server before snapshot or restore (to avoid world corruption). You can
  optionally integrate a PID file to allow the script to attempt an automated stop.

.ACTIONS
  snapshot : Copy the current world folder into a timestamped (or named) snapshot directory.
  restore  : Replace the current world folder with a chosen snapshot. The world it replaces is deleted.
             Bot kernel state (corporate_headquarters*.json) is LEFT INTACT so restoring a
             completed-build snapshot keeps its build-center/stations. If the snapshot is from a
             DIFFERENT world, run the 'flush' verb yourself before starting -- flush is deliberate,
             never a restore side effect.
  list     : List available snapshots for a world.
  prune    : Keep only the newest N snapshots, deleting older ones.

.PARAMETERS
  -World         Name of the world folder. Default: whatever server.properties says is live —
                 pass this only to act on a world that is NOT the running one.
  -Name          Friendly snapshot name (optional). If omitted, uses timestamp yyyyMMdd_HHmmss.
  -SnapshotsDir  Root folder for snapshots (default: 'world_snapshots').
  -Zip           Compress snapshot to .zip (speeds up storage; slower restore). Not required.
  -Keep          When pruning: how many latest snapshots to retain.
  -Force         Skip confirmation prompts for restore/prune.
  -Action        One of snapshot|restore|list|prune.
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
  [Parameter(Mandatory=$true)][ValidateSet('snapshot','restore','list','prune')][string]$Action,
  # Empty selects the live level-name from server.properties, the owner of the active world (Law 6).
  [string]$World = '',
  # Which SERVER directory to act on — the folder holding server.properties and the world folders.
  # REQUIRED: this script's folder is the workshop, so a default
  # would be a guess at which world to overwrite (Law 13 — never default a field whose wrong value
  # destroys something).
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$Name,
  [string]$SnapshotsDir = 'world_snapshots',
  [switch]$Zip,
  [int]$Keep = 0,
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
# hold several Minecraft servers — the fleet's own dev world and any other world beside it — and each needs
# snapshots and restores.
# A second rollback per server would be a second world-is-held guard and
# a second place for the destructive path to be wrong. Every path below resolves through $scriptRoot.
#
# Root names the server explicitly because the script's own folder belongs to the workshop.
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

# The unary comma preserves an array return for zero, one or many snapshots, so callers can use Count.
function Get-Snapshots(){
  if(!(Test-Path $worldSnapRoot)){ return ,@() }
  return ,@(Get-ChildItem -Path $worldSnapRoot -Directory | Sort-Object Name -Descending)
}

# Deletion tests whether the exiting server has released the world and its subdirectory handles.
# The bounded wait returns false on timeout, keeping restoration stopped until deletion succeeds (Law 13).
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
    Write-Info "Removing current world folder ( $worldPath )"
    # Waits for the dying JVM to release the folder, by attempting the removal itself — see the
    # function's deletion result for evidence that directory handles are released.
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

    # Restoration preserves HQ so matching world snapshots retain their build sites and stations.
    # The explicit flush verb owns resetting HQ for a different world.
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
