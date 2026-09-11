# progress_tracker entry point — the twin of trace.ps1, for the OTHER observer. Its only job is
# to run progress_tracker.js under a node the current machine actually has: bare `node` is on PATH
# at home but not on the work machine (portable node), so `node progress_tracker.js` dies there.
# Resolves the same portable -> node_env2 -> PATH chain every entry point uses (runbook §2) and
# forwards every flag through untouched.
#   .\Auren_Workshop\scripts\progress.ps1        # corporate HQ snapshot: what the bots have completed

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workshopDir    = Split-Path -Parent $scriptDir
$tracker   = Join-Path $workshopDir 'monitoring\progress_tracker.js'

. "$PSScriptRoot\_node.ps1"   # the one node resolver (Law 16)
$node = Get-AurenNode

& $node $tracker @args
exit $LASTEXITCODE
