# trace_monitor entry point — the inspection twin of start_fleet.ps1. Its only job is to run
# trace_monitor.js under a node the current machine actually has: bare `node` is not on PATH on every
# machine, so `node trace_monitor.js` can die "node not recognized". This resolves node the way every
# other entry point does (_node.ps1: PATH first, then the Architect's workstation file - runbook §2) and
# forwards every flag through untouched, so all runbook §6 queries work verbatim:
#   .\Auren_Workshop\scripts\trace.ps1                       # digest + anomalies
#   .\Auren_Workshop\scripts\trace.ps1 --story --bot=AurenBot
#   .\Auren_Workshop\scripts\trace.ps1 --around="1m 1s" --lines=50
#   .\Auren_Workshop\scripts\trace.ps1 --watch --exit-on-flag --max-minutes=60

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workshopDir    = Split-Path -Parent $scriptDir
# The lens stack moved into the bot on 2026-09-10 (Architect: troubleshooting ships, recording does
# not), and the WORKSHOP moved inside the bot in the same pass — so the parent of the workshop IS the
# bot root, and the path is joined from there. It named 'Auren_Bot\monitoring' under that parent for a
# day, which resolved to Auren_Bot\Auren_Bot\monitoring and made this entry point throw MODULE_NOT_FOUND
# on every invocation. Counting levels is what broke; the bot root is the only anchor named here, and it
# stays correct inside the extract, where no repo root exists to count to.
$botDir    = Split-Path -Parent $workshopDir
$traceMon  = Join-Path $botDir 'monitoring\trace_monitor.js'

. "$PSScriptRoot\_node.ps1"   # the one node resolver (Law 16)
$node = Get-AurenNode

# ── UTF-8 BEFORE ANYTHING PRINTS (Architect 2026-09-10) ────────────────────────────────────────────
# *"the symbols like the backpack and other signs dont work in a raw powershell. its all mojebake. so
# either remove them or make part of the dependancies something you need to install to read those items
# on the watcher trace."*
#
# IT IS NEITHER OF THOSE — NOTHING IS MISSING AND NOTHING NEEDS INSTALLING. The lens writes UTF-8 and a
# fresh Windows PowerShell console decodes its children's output with the machine's ANSI codepage (437 or
# 1252 here), so every multi-byte character arrives as two or three wrong ones. The symbols are fine, the
# console was never told what they were. Two lines fix it for everything this script runs:
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
