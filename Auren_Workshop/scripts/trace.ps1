# Launches the finished-run trace reader under the shared Node resolver and forwards every flag unchanged.
#   .\Auren_Workshop\scripts\trace.ps1                       # digest + anomalies
#   .\Auren_Workshop\scripts\trace.ps1 --story --bot=AurenBot
#   .\Auren_Workshop\scripts\trace.ps1 --around="1m 1s" --lines=50
#   .\Auren_Workshop\scripts\trace.ps1 --watch --exit-on-flag --max-minutes=60

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workshopDir    = Split-Path -Parent $scriptDir
# The workshop's parent owns the bot and its lenses, so this path resolves inside a standalone download.
$botDir    = Split-Path -Parent $workshopDir
$traceMon  = Join-Path $botDir 'monitoring\trace_monitor.js'

. "$PSScriptRoot\_node.ps1"   # the one node resolver (Law 16)
$node = Get-AurenNode

# UTF-8 decoding and rendering preserve the symbols emitted by the lens.
#   OutputEncoding  — how PowerShell DECODES the bytes node hands back
#   chcp 65001      — how the console RENDERS what it decoded
# Both are needed; either alone still produces mojibake, which is why "set the encoding" half-fixes get
# reported as not working.
#
# Scoped to this process, so it changes nothing about his shell after the window closes. For a terminal
# this script does not own — his own raw PowerShell, an SSH session — `trace_monitor.js --ascii` prints
# the same report with no characters above ASCII at all.
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$null = & chcp 65001

& $node $traceMon @args
exit $LASTEXITCODE
