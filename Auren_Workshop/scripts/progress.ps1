# Launches the HQ progress reader under the shared Node resolver and forwards every flag unchanged.
#   .\Auren_Workshop\scripts\progress.ps1        # corporate HQ snapshot: what the bots have completed

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workshopDir    = Split-Path -Parent $scriptDir
$tracker   = Join-Path $workshopDir 'monitoring\progress_tracker.js'

. "$PSScriptRoot\_node.ps1"   # the one node resolver (Law 16)
$node = Get-AurenNode

& $node $tracker @args
exit $LASTEXITCODE
