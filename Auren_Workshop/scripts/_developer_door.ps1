# _developer_door.ps1 - THE DOOR, FOR THE SCRIPTS THAT ARE NOT JAVASCRIPT.
#
#   . "$PSScriptRoot\_developer_door.ps1"
#   Assert-DeveloperMode 'Auren_Workshop/scripts/<this script>.ps1'
#
# THIS FILE IS DELIBERATELY PURE ASCII, like every other script in this folder. Windows PowerShell 5.1
# reads a .ps1 with no byte-order mark as ANSI, so a UTF-8 em dash written here arrives on his screen as
# mojibake - and the one thing this file exists to do is PRINT A SENTENCE somebody can act on.
#
# ---- WHY THIS EXISTS BESIDE js_kernel/utils/developer_door.js ------------------------------------
# The rule is one rule and the STATE is one fact: the marker file `Auren_Bot/.developer_mode`, written by
# `node developer_mode.js on` and by nothing else. This file is a second READER of that one fact, in the
# one other language this project runs in, and it sits beside `_node.ps1` for exactly the same reason
# that file exists. PowerShell cannot ask a Node module a question without first solving the problem
# `_node.ps1` was written to solve, and a door that needed a toolchain resolved before it could refuse
# would be a door with a lobby (Law 16 - one owner of the ANSWER, which is the marker, not the reader).
#
# ---- WHAT IT COVERS AND WHAT IT DELIBERATELY DOES NOT (Law 29) -----------------------------------
# It covers the scripts in this folder that DO THEIR OWN WORK: `start_cameras.ps1`, which launches
# Minecraft clients, and `world_rollback.ps1`, which deletes and restores a world folder.
#
# It is NOT called by `trace.ps1`, `dashboard.ps1`, `progress.ps1` or `camera_obs.ps1`. Each of those is
# three lines that resolve node and hand the arguments to a JavaScript tool that already asks the door
# itself, so the refusal already prints and the exit code already propagates. Adding a check here would
# ask the same question twice and print the same refusal twice.
#
# It is NOT called by `_node.ps1` or `npm.ps1`. Those resolve a toolchain rather than run a tool, and
# `npm install` is the first thing anybody does with a fresh download.
#
# It is NOT called by `camera_window_titler.ps1`, which `start_cameras.ps1` launches as a child: the
# parent asked, and a child that asks again names the wrong file in its refusal.

Set-StrictMode -Version Latest

function Assert-DeveloperMode {
    param([Parameter(Mandatory = $true)][string]$Tool)

    # scripts/ -> Auren_Workshop/ -> Auren_Bot/. Computed from where this file is, so it survives a move.
    $botRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $marker  = Join-Path $botRoot '.developer_mode'
    if (Test-Path -LiteralPath $marker) { return }

    Write-Host ''
    Write-Host "  $Tool is a developer tool, and this copy is not in developer mode."
    Write-Host ''
    Write-Host '  Auren has two doors. The one you want depends on what you are doing:'
    Write-Host ''
    Write-Host '    PLAYING          node start_auren.js        then say "foreman get" in chat'
    Write-Host '    BUILDING ON IT   node developer_mode.js on     once, then every tool works'
    Write-Host ''
    Write-Host '  Developer mode turns on the workshop: the scripted runs, the benches, the combat'
    Write-Host '  arena, the cameras, and the lenses that read a run record. It changes nothing about'
    Write-Host '  how the bots play. It is a door, not a setting, and you can close it again with'
    Write-Host '  "node developer_mode.js off".'
    Write-Host ''
    exit 1
}
