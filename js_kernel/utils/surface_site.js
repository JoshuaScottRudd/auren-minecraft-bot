// js_kernel/utils/surface_site.js
// Sites a ground-level structure ON THE SURFACE, as near its neighbour as the gap allows: the wheat field and the sheep pen.
//
// Every site farther from home is more ground the torch network must paint, so the nearest gap wins. The ground under
// it is terraformed both ways: its floor is the middle height of the surface columns under the footprint, the
// columns above it are cut down and the columns below it are filled up, which moves the fewest blocks of any floor.
// Cuts and fills are bounded (scrapeMax, fillMax), so the floor stays in the soil layer and the grass still standing
// at floor height spreads across the cut and filled cells. Trees do not move a site: a footprint over trunks is
// accepted, and its trees are felled whole before it is built (assessors/shared siteTreeBox, SURFACE_TREE_MARGIN).
//
// middleFloor(heights) → the middle column height (the lower middle of an even count): the floor that moves the
// fewest blocks.
//
// siteOnSurface(surface, opts, pace) → footprint_survey.siteBeside with middleFloor as its floor rule. `opts` is
// siteBeside's own, without groundY and rise.
'use strict';

const { siteBeside } = require('@utils/footprint_survey');

function middleFloor(heights) {
  if (!heights.length) throw new Error('[surface_site] CODING VIOLATION (Law 13): middleFloor needs at least one column height.');
  const sorted = [...heights].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function siteOnSurface(surface, opts, pace) {
  return siteBeside(surface, { ...opts, floorOf: middleFloor, overTrees: true }, pace);
}

module.exports = { middleFloor, siteOnSurface };
