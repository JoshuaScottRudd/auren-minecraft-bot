# dashboard entry point — the Architect's LIVE observer state. Overwrites js_kernel/dashboard.json every
# tick with trace vitals + HQ progress; he watches that file live-reload in the editor (no terminal
# rendering — ANSI panels drew inconsistently across his environments). The noisy wake-on-error path
# stays in trace.ps1 --watch (the AI dev's arm). Its only job is to run dashboard.js under a node the
# current machine actually has: bare `node` is not on PATH on every machine. Resolves node the way
# every entry point does (_node.ps1: PATH first, then the Architect's workstation file - runbook §2).
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
