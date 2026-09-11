# npm, through the one resolver — THE WAY TO RUN NPM IN THIS REPO.
#
#   .\Auren_Workshop\scripts\npm.ps1 --version                 # which npm did it pick
#   cd Auren_Bot; ..\Auren_Workshop\scripts\npm.ps1 install    # the bot's declared packages
#   cd node_env2; ..\Auren_Workshop\scripts\npm.ps1 install    # the portable runtime's own
#
# WHY THIS EXISTS WHEN `npm` IS OFTEN ON PATH. It is on PATH on one machine and not the other, and where
# it is on PATH it may be an npm belonging to something else entirely — an unrecorded dependency on a
# directory this repo does not own and cannot see move. Same argument that put node behind Get-AurenNode:
# which toolchain runs is one answer for this machine, resolved in one place (Law 16), never guessed at
# the call site. The resolver prefers the repo's own copy, so PATH is the last resort rather than the
# default.
#
# WHY IT PRINTS WHAT IT PICKED. The chain has three legs and they are not interchangeable — a machine
# quietly running PATH's npm because its own is broken looks identical to one running its own, right up
# until the borrowed one moves (Invariant C: the decision has to be readable after the fact).
#
# ARGS FORWARD UNTOUCHED and the working directory is the caller's, because this is npm and not a
# wrapper around one command — inventing a different contract than the tool it launches is variance
# nobody asked for (Law 19). So the manifest is chosen by cd'ing to it, as with npm anywhere else.
# `--prefix` looks like the tidier answer and is not: it moves where packages are WRITTEN while
# package.json keeps being read from the current directory, so from the repo root it fails on a root
# manifest that does not exist. No flag relocates both.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir\_node.ps1"
$npm = Get-AurenNpm

Write-Host "npm: $npm" -ForegroundColor DarkGray
& $npm @args
exit $LASTEXITCODE
