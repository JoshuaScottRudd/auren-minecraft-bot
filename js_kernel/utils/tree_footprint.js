'use strict';
// tree_footprint.js — what one tree claim holds: the column around its base, at every height.
//
// A tree key names one base block; the feller occupies the 5x5 column around it (it stands beside the
// trunk, pillars up, and mines the base out from under the logs above). The foreman grants a tree claim by
// this footprint and a body choosing a trunk reads its peers' claims by it, so both answer "is this trunk
// taken" the same way (Law 16).

const TREE_KEY_PREFIX = 'tree:';
const TREE_FOOTPRINT_RADIUS = 2;

// { x, z } of a tree key's base, or null if the key is malformed. Y is parsed only to validate the form.
function parseTreeFootprint(key) {
  const parts = key.slice(TREE_KEY_PREFIX.length).split(',');
  if (parts.length !== 3) return null;
  const [x, y, z] = parts.map(Number);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, z };
}

// Does a claim with footprint `held` take the trunk at `p`?
function inFootprint(held, p) {
  return Math.max(Math.abs(held.x - p.x), Math.abs(held.z - p.z)) <= TREE_FOOTPRINT_RADIUS;
}

module.exports = { TREE_KEY_PREFIX, TREE_FOOTPRINT_RADIUS, parseTreeFootprint, inFootprint };
