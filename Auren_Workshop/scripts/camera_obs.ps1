# camera_obs entry point — the OBS twin of trace.ps1 / start_fleet.ps1. Its only job is to run
# camera_obs.js under a node the current machine actually has, WITH the module path it needs.
#
# WHY THIS WRAPPER EXISTS, and why a bare `node Auren_Workshop/camera/camera_obs.js` is not enough:
# camera_obs.js requires `ws` (the obs-websocket client). Node finds modules by walking UP from the
# script's own directory, and on both machines the module tree is a SIBLING of the repo root
# (node_env2\node_modules at home, MinecraftServer\node_modules at work) — never an ancestor of
# Auren_Workshop\camera\. So the walk-up never reaches it and the bare call dies "Cannot find module 'ws'"
# on EVERY machine, not just the portable-node one. _node.ps1 resolves the interpreter but does not
# set NODE_PATH, so resolving node alone does not fix this. Both legs are put on NODE_PATH here (the
# absent one is simply ignored), which is the same both-paths treatment fleet_control.js applies.
#
# Law 16: one node-resolving entry point per tool, never a bare invocation that only starts on one
# machine. Every argument is forwarded untouched, so every form in camera_runbook.md works verbatim:
#   .\Auren_Workshop\scripts\camera_obs.ps1 configure --count=3
#   .\Auren_Workshop\scripts\camera_obs.ps1 up --count=3
#   .\Auren_Workshop\scripts\camera_obs.ps1 start
#   .\Auren_Workshop\scripts\camera_obs.ps1 status
#   .\Auren_Workshop\scripts\camera_obs.ps1 stop
#   .\Auren_Workshop\scripts\camera_obs.ps1 down
#   .\Auren_Workshop\scripts\camera_obs.ps1 probe

# THREE HOPS TO THE REPO ROOT, not two (2026-09-10): the workshop moved inside the bot, so
# scripts -> Auren_Workshop -> Auren_Bot -> repo root. `node_env2\` and `MinecraftServer\` below are the
# Architect's own equipment at the repo root and were being looked for under `Auren_Bot/`, where neither
# exists — which sets NODE_PATH to two absent directories and leaves the camera's requires to fail
# somewhere else entirely.
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$workshopDir = Split-Path -Parent $scriptDir
$botRoot     = Split-Path -Parent $workshopDir
$repoRoot    = Split-Path -Parent $botRoot
$cameraObs   = Join-Path $workshopDir 'camera\camera_obs.js'

. "$PSScriptRoot\_node.ps1"   # the one node resolver (Law 16)
$node = Get-AurenNode

# Both module trees, always. Whichever machine this is, one of them exists and the other is inert —
# naming both is what makes this file machine-agnostic instead of needing a per-machine branch.
$env:NODE_PATH = @(
    (Join-Path $repoRoot 'node_env2\node_modules'),
    (Join-Path $repoRoot 'MinecraftServer\node_modules')
) -join ';'

& $node $cameraObs @args
exit $LASTEXITCODE
