# npm, through the one node resolver - THE WAY TO RUN NPM IN THIS REPO.
#
#   .\Auren_Workshop\scripts\npm.ps1 --version     # which npm did it pick (run from Auren_Bot\)
#   .\Auren_Workshop\scripts\npm.ps1 install       # the bot's declared packages
#
# NPM IS NOT RESOLVED ON ITS OWN. It is the npm that ships inside the node Get-AurenNode picked -
# <node folder>\node_modules\npm\bin\npm-cli.js, run by that same node.exe. That is true of an installed
# Node (C:\Program Files\nodejs\) and of an unpacked one alike, and it is exactly how run.js runs its own
# install (Law 16: one answer to "which toolchain", so the node and the npm can never come from two
# different places).
#
# IF THAT FILE IS MISSING, the node folder lost its npm to a prune: `npm install` run INSIDE a node
# distribution folder removes node_modules\npm as extraneous unless npm is listed in that folder's own
# package.json. Repair from inside that folder with `npm install npm@<version>` using any npm that works,
# which lists it so a later prune cannot take it.
#
# ARGS FORWARD UNTOUCHED and the working directory is the caller's, because this is npm and not a wrapper
# around one command (Law 19). The manifest is chosen by cd'ing to it, as with npm anywhere else.
#
# Plain ASCII on purpose - see the note at the top of _node.ps1.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir\_node.ps1"
$node = Get-AurenNode
$npmCli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) {
    Write-Host "The node at $node carries no npm ($npmCli is missing)."
    Write-Host '  That node folder lost its npm to a prune - see the header of this script for the repair.'
    exit 1
}

Write-Host "npm: $npmCli (run by $node)" -ForegroundColor DarkGray
& $node $npmCli @args
exit $LASTEXITCODE
