# camera_obs entry point - the OBS twin of trace.ps1. Its only job is to run camera_obs.js under a node the
# current machine actually has.
#
# MODULE RESOLUTION IS camera_obs.js's OWN BUSINESS. It calls `paths.registerAliases()` before its first
# third-party require (`ws`), which puts this machine's module homes on NODE_PATH through the bot's one
# resolver, js_kernel/utils/node_module_homes. This wrapper used to set NODE_PATH itself from two
# hard-coded folders - a second answer to the same question (Law 16), removed 2026-09-11.
#
# Every argument is forwarded untouched, so every form in camera_runbook.md works verbatim:
#   .\Auren_Workshop\scripts\camera_obs.ps1 configure --count=3
#   .\Auren_Workshop\scripts\camera_obs.ps1 up --count=3
#   .\Auren_Workshop\scripts\camera_obs.ps1 start
#   .\Auren_Workshop\scripts\camera_obs.ps1 status
#   .\Auren_Workshop\scripts\camera_obs.ps1 stop
#   .\Auren_Workshop\scripts\camera_obs.ps1 down
#   .\Auren_Workshop\scripts\camera_obs.ps1 probe

$cameraObs = Join-Path (Split-Path -Parent $PSScriptRoot) 'camera\camera_obs.js'

. "$PSScriptRoot\_node.ps1"   # the one node resolver (Law 16)
$node = Get-AurenNode

& $node $cameraObs @args
exit $LASTEXITCODE
