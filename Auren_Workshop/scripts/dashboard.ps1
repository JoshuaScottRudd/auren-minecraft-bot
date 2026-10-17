# Launches the dashboard under the shared Node resolver, forwarding the requested cadence.
# The dashboard publishes live trace vitals and HQ progress for editor inspection.
#   .\Auren_Workshop\scripts\dashboard.ps1                       # overwrite dashboard.json every 2s
#   .\Auren_Workshop\scripts\dashboard.ps1 --interval=1          # faster cadence
#   .\Auren_Workshop\scripts\dashboard.ps1 --once                # write a single snapshot and exit

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workshopDir    = Split-Path -Parent $scriptDir
$dashboard = Join-Path $workshopDir 'monitoring\dashboard.js'

. "$PSScriptRoot\_node.ps1"   # the one node resolver (Law 16)
$node = Get-AurenNode

& $node $dashboard @args
exit $LASTEXITCODE
