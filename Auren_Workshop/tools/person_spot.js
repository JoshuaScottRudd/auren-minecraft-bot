'use strict';
// library: person_spot — where a PERSON may stand to ask the foreman for a crew: the one definition, shared by
// the harness that teleports its stand-in there (proxy_human `--stand=biome`) and voxel_snapshot, which captures
// the loaded area around the spot a person would ask from. Two tools placing a person by two copies of the rule
// would each measure a different world the first time one copy moved (Law 16).
//
// A SPOT IS EXACTLY THESE, and the list stops there:
//   · at least `landingFloor` blocks from world spawn, Chebyshev — the protected region is a SQUARE, so a
//     Euclidean test passes cells inside its corners. The caller's ring sweep starts at that radius.
//   · the surface of the column is readable (`surfaceY`, the topmost ground — `floorNearest` would let a cave
//     floor at the reference height beat grass above it);
//   · the biome at the feet is in ACCEPTABLE_BIOMES — the set the foreman's desk and find_buildingspot gate on;
//   · the feet are no higher than SEA_LEVEL + HUMAN_MAX_ABOVE_SEA — the desk refuses a person above that, and a
//     spot the desk then turns away measures nothing;
//   · a 3×3 floor centred on the feet with 2 clear above every cell, read as it stands (`evaluateOpenBox`).
//
// WHY THE CLEARANCE IS THE PROTECTED SQUARE PLUS A BASE: inside the square the server refuses every break and
// placement by a non-op and reports nothing, so a crew there makes no progress. The base is sited around the
// person and the crew digs around the base — measured digs reached ~16 blocks from the person — so the margin
// is that again with room over, and PERSON_CLEAR_OF_SPAWN wins wherever it is larger.

const { ACCEPTABLE_BIOMES, PERSON_CLEAR_OF_SPAWN, SEA_LEVEL, HUMAN_MAX_ABOVE_SEA } = require('@thinking/architect_config');
const { surfaceY, evaluateOpenBox, REASON } = require('@utils/site_geometry');

const BASE_MARGIN = 32;

function landingFloor(protectionRadius) { return Math.max(PERSON_CLEAR_OF_SPAWN, protectionRadius + BASE_MARGIN); }

// personSpotTest(reader, biomeAt, refY) → (x, z) => verdict, the ring sweep's predicate.
//   biomeAt(x, y, z) → biome name or null; the caller supplies the one biome read it has (biome_scanner).
function personSpotTest(reader, biomeAt, refY) {
  return (x, z) => {
    const top = surfaceY(reader, x, z, refY);
    if (!top) return { valid: false, reason: reader.blockAt(x, refY, z) === null ? REASON.UNLOADED : REASON.NO_FLOOR };
    const biome = biomeAt(x, top.y + 1, z);
    if (!ACCEPTABLE_BIOMES.has(biome)) return { valid: false, reason: 'wrong_biome' };
    if (top.y + 1 > SEA_LEVEL + HUMAN_MAX_ABOVE_SEA) return { valid: false, reason: 'too_high' };
    const standing = evaluateOpenBox(reader, x, z, top.y, { size: 3, height: 2, occupancy: 'as-is' });
    return standing.valid ? { ...standing, biome } : standing;
  };
}

module.exports = { personSpotTest, landingFloor, BASE_MARGIN };
