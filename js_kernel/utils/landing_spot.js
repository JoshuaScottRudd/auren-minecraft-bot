'use strict';
// Where the foreman lands to site a base and raise its crew: the one definition. The harness that teleports
// its stand-in player (proxy_human `--stand=biome`) and voxel_snapshot, which captures the loaded area round
// such a landing, use the same rule (Law 16).
//
// A SPOT IS EXACTLY THESE, and the list stops there:
//   · at least `landingFloor` blocks from world spawn, Chebyshev — the protected region is a SQUARE, so a
//     Euclidean test passes cells inside its corners. The caller's ring sweep starts at that radius.
//   · the surface of the column is readable (`surfaceY`, the topmost ground — `floorNearest` would let a cave
//     floor at the reference height beat grass above it);
//   · the biome at the feet settles (architect_config.settles) — the list the foreman and find_buildingspot gate on;
//   · the feet are no higher than SEA_LEVEL + LANDING_MAX_ABOVE_SEA — the foreman's crew raise refuses a landing
//     above that;
//   · a 3×3 floor centred on the feet with 2 clear above every cell, read as it stands (`evaluateOpenBox`).
//
// THE CLEARANCE IS THE PROTECTED SQUARE PLUS A BASE MARGIN: inside the square the server refuses every
// break and placement by a non-op, so a crew there makes no progress. The base is sited around the landing
// and the crew digs around it, so BASE_CLEAR_OF_SPAWN wins wherever it is the larger of the two.

const { settles, BASE_CLEAR_OF_SPAWN, SEA_LEVEL, LANDING_MAX_ABOVE_SEA } = require('@thinking/architect_config');
const { surfaceY, evaluateOpenBox, REASON } = require('@utils/site_geometry');

const BASE_MARGIN = 32;

function landingFloor(protectionRadius) { return Math.max(BASE_CLEAR_OF_SPAWN, protectionRadius + BASE_MARGIN); }

// landingSpotTest(reader, biomeAt, refY) → (x, z) => verdict, the ring sweep's predicate.
//   biomeAt(x, y, z) → biome name or null; the caller supplies the one biome read it has (biome_scanner).
function landingSpotTest(reader, biomeAt, refY) {
  return (x, z) => {
    const top = surfaceY(reader, x, z, refY);
    if (!top) return { valid: false, reason: reader.blockAt(x, refY, z) === null ? REASON.UNLOADED : REASON.NO_FLOOR };
    const biome = biomeAt(x, top.y + 1, z);
    if (!settles(biome)) return { valid: false, reason: 'wrong_biome' };
    if (top.y + 1 > SEA_LEVEL + LANDING_MAX_ABOVE_SEA) return { valid: false, reason: 'too_high' };
    const standing = evaluateOpenBox(reader, x, z, top.y, { size: 3, height: 2, occupancy: 'as-is' });
    return standing.valid ? { ...standing, biome } : standing;
  };
}

module.exports = { landingSpotTest, landingFloor, BASE_MARGIN };
