# The ONE resolver for node (Law 16). Every .ps1 entry point dot-sources this and calls Get-AurenNode.
# npm is not resolved separately: it is the npm that ships inside the node picked here (npm.ps1).
# Java and the server folder are resolved by Auren_Bot/js_kernel/utils/workstation.js, which PowerShell
# asks through `& (Get-AurenNode) ...\workstation.js java|server` - node is the one tool that has to be
# found BEFORE any JS can run, which is the only reason this file exists in a second language.
#
# ---- THE RULE (Architect 2026-09-11) ----------------------------------------------------------------
# "if run then check stranger way, if fail then architect way." Two legs, in this order:
#   1. node on PATH - what every stranger has, and the only thing their refusal ever names.
#   2. the EXACT paths in ..\Architect_workstation\workstation.json, one level above the bot - his
#      machines only. One named file is opened; nothing above the bot is searched or listed.
#
# ---- WHY A CANDIDATE IS RUN AND NOT Test-Path'd -----------------------------------------------------
# A node.exe that exists is not a node that runs, and one that runs may be too old for this bot. So each
# candidate is asked for its version and must meet `engines.node` in Auren_Bot\package.json - the bot's
# own declaration, read rather than copied (Law 25 - exercise the capability, never infer it).
#
# THIS FILE IS PLAIN ASCII ON PURPOSE. Windows PowerShell 5.1 reads a script without a byte-order mark
# as the ANSI code page, where the last byte of a UTF-8 long dash is a curly double quote - and inside a
# double-quoted string that ends the string. Measured 2026-09-11: one dash in a message broke the parse
# of the whole file, and every entry point that dot-sources it lost Get-AurenNode.

function Get-AurenNodeFloor {
    $botRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts -> Auren_Workshop -> Auren_Bot
    $declared = (Get-Content -Raw -LiteralPath (Join-Path $botRoot 'package.json') | ConvertFrom-Json).engines.node
    return [int]([regex]::Match($declared, '\d+').Value)
}

# $true when the candidate runs and reports a major version at or above the floor. 2>$null on a native
# exe is deliberate: a failing candidate's stderr is noise, because the next candidate may succeed.
function Test-AurenNode([string]$Path, [int]$Floor) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    try { $v = & $Path --version 2>$null } catch { return $false }
    if ($LASTEXITCODE -ne 0 -or -not ("$v" -match '^v(\d+)\.')) { return $false }
    return ([int]$Matches[1] -ge $Floor)
}

function Get-AurenNode {
    $botRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $aboveBot = Split-Path -Parent $botRoot
    $floor    = Get-AurenNodeFloor
    $tried    = @()

    # 1. The stranger's way.
    $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) {
        if (Test-AurenNode $onPath.Source $floor) { return $onPath.Source }
        $tried += "$($onPath.Source) (PATH: did not run, or older than $floor)"
    } else {
        $tried += 'node on PATH (none)'
    }

    # 2. The Architect's way - exact paths only.
    $manifest = Join-Path $aboveBot 'Architect_workstation\workstation.json'
    if (Test-Path -LiteralPath $manifest) {
        foreach ($rel in (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).node) {
            $exe = Join-Path $aboveBot ($rel -replace '/', '\')
            if (Test-AurenNode $exe $floor) { return $exe }
            $tried += $exe
        }
    }

    # Names what was tried, not just that nothing was found (Law 25).
    Write-Host "No Node.js $floor or newer was found."
    Write-Host ('  tried: ' + ($tried -join ', '))
    Write-Host "  Install Node.js $floor or newer from https://nodejs.org, then open a new terminal."
    exit 1
}
