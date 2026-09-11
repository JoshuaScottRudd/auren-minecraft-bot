# The ONE PowerShell resolver for the node TOOLCHAIN (Law 16) — which node, and which npm. Every .ps1
# entry point (start_fleet, trace, start_cameras, fresh_start, npm) dot-sources this and calls
# Get-AurenNode / Get-AurenNpm instead of re-typing a resolution chain. Its JS twin is fleet_control.js's
# findNode() — a PS helper cannot be called from JS (the wrappers must resolve node BEFORE any JS can
# run), so the two languages each keep one implementation, never five.
#
# Chain, both verbs: node_portable (work machine) -> node_env2 (home) -> PATH. The portable leg GLOBS
# node_portable\node-*\node.exe rather than pinning a version, so a node upgrade needs no edit here.
# The repo-local legs come FIRST so a machine that carries its own toolchain never silently borrows one
# installed elsewhere on the box — a borrowed toolchain is a dependency nobody wrote down and nobody can
# see when it moves.
#
# ── WHY A CANDIDATE IS RUN AND NOT Test-Path'd ──────────────────────────────────────────────────────
# A node distribution's npm.cmd is a STUB: it shells out to <dist>\node_modules\npm\bin\npm-cli.js. That
# directory is not part of the .cmd and can be removed independently of it — running `npm install` inside
# a distribution folder prunes node_modules\npm as EXTRANEOUS unless npm is itself a listed dependency of
# that folder's package.json. The stub survives; its payload does not. So an npm.cmd that exists is not
# an npm that runs, and an existence check hands back a file that throws MODULE_NOT_FOUND at the caller,
# several layers from anything that could explain it.
#
# The repair, when the probe rejects a distribution's own npm: add npm to that folder's package.json
# (`npm install npm@<version>` from inside it, using any npm that still works), which makes it a
# dependency a later prune cannot take. Reinstalling it WITHOUT listing it repeats the same failure at
# the next install.
#
# Node gets the same treatment for the same reason rather than because node.exe is known to break this
# way: a resolver that measures one of its two answers and assumes the other is a resolver you cannot
# read the verdict of (Law 25 — exercise the capability, never infer it from the name of one).

# Runs a candidate and reports whether it actually works. Output is swallowed; the exit code is the
# whole product. 2>$null on a native exe is deliberate here — a failing candidate's stderr is noise the
# caller must not see, because the caller is going to try the next one and succeed.
function Test-AurenBinary {
    param([string]$Path, [string[]]$ProbeArgs = @('--version'))
    if (-not $Path) { return $false }
    try {
        $null = & $Path @ProbeArgs 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# ── TWO ROOTS, AND THE SECOND ONE IS WHY THIS IS A LIST (2026-09-10) ────────────────────────────────
# This returned ONE directory, `scripts -> Auren_Workshop -> repo root`, and that sentence stopped being
# true when the workshop moved inside the bot (Architect: *"i should just ship the whole thing as one
# piece"*). The same two hops now land on `Auren_Bot/`, so `node_portable\` and `node_env2\` — which sit
# at the Architect's REPO root, one level higher — both missed, and the chain fell through to PATH. On
# this machine PATH happens to carry the portable node, so it kept working and said nothing; on the home
# workstation, whose toolchain is `node_env2\` and is deliberately NOT on PATH, the repo-local leg would
# have been skipped for the same invisible reason. A resolver that silently borrows a toolchain is the
# exact fault the header above says the repo-local legs exist to prevent.
#
# THE FIX IS TO ASK BOTH, IN ORDER, because there are honestly two answers and there always were:
#   1. the bot root      — a stranger's download has nothing above it, and this is its whole world
#   2. its parent        — the Architect's repo root, where node_portable\ and node_env2\ actually live
# Neither is a guess: each is one hop off this file, each is existence-checked, and a machine carrying
# no toolchain in either still reaches PATH last and still gets the named refusal below (Law 13). The
# bot root comes first so a download is never affected by whatever happens to sit above it.
function Get-AurenToolchainRoots {
    $botRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts -> Auren_Workshop -> Auren_Bot
    return @($botRoot, (Split-Path -Parent $botRoot))
}

function Get-AurenNode {
    $checked = @()

    foreach ($root in Get-AurenToolchainRoots) {
        $portable = Get-ChildItem -Path (Join-Path $root 'node_portable') -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
                    Select-Object -First 1
        if ($portable) {
            $checked += $portable.FullName
            if (Test-AurenBinary $portable.FullName) { return $portable.FullName }
        }

        $env2 = Join-Path $root 'node_env2\node.exe'
        if (Test-Path $env2) {
            $checked += $env2
            if (Test-AurenBinary $env2) { return $env2 }
        }
    }

    $onPath = where.exe node 2>$null | Select-Object -First 1
    if ($onPath) {
        $checked += "$onPath (PATH)"
        if (Test-AurenBinary $onPath) { return $onPath }
    }

    # Names what was tried, not just that nothing was found: "no node" sends the reader looking for a
    # missing install when the answer may be a present one that does not run (Law 25).
    Write-Host 'No working node.exe.'
    if ($checked.Count) { Write-Host ('  tried: ' + ($checked -join ', ')) }
    else { Write-Host '  nothing to try — checked node_portable, node_env2, and PATH.' }
    Write-Host '  put a portable node in node_portable\ or node_env2\, or install one on PATH.'
    exit 1
}

function Get-AurenNpm {
    $checked = @()

    foreach ($root in Get-AurenToolchainRoots) {
        $portableNpm = Get-ChildItem -Path (Join-Path $root 'node_portable') -Filter 'npm.cmd' -Recurse -ErrorAction SilentlyContinue |
                       Select-Object -First 1
        if ($portableNpm) {
            $checked += $portableNpm.FullName
            if (Test-AurenBinary $portableNpm.FullName) { return $portableNpm.FullName }
        }

        $env2Npm = Join-Path $root 'node_env2\npm.cmd'
        if (Test-Path $env2Npm) {
            $checked += $env2Npm
            if (Test-AurenBinary $env2Npm) { return $env2Npm }
        }
    }

    # .cmd preferred over the bare shell script: PowerShell can invoke the batch wrapper directly, and
    # the extensionless sibling beside it is a sh script Windows cannot run without a shell.
    $onPath = where.exe npm 2>$null
    $cmdOnPath = $onPath | Where-Object { $_ -like '*.cmd' } | Select-Object -First 1
    if (-not $cmdOnPath) { $cmdOnPath = $onPath | Select-Object -First 1 }
    if ($cmdOnPath) {
        $checked += "$cmdOnPath (PATH)"
        if (Test-AurenBinary $cmdOnPath) { return $cmdOnPath }
    }

    Write-Host 'No working npm.'
    if ($checked.Count) { Write-Host ('  tried: ' + ($checked -join ', ')) }
    else { Write-Host '  nothing to try — checked node_portable, node_env2, and PATH.' }
    Write-Host '  a distribution npm.cmd that exists but fails has lost node_modules\npm to a prune;'
    Write-Host '  repair it from inside that folder with:  npm install npm@10.9.2'
    exit 1
}
