// utils/stand_reach.js — where a body stands to work a cell, and whether it reaches the cell from there.
// One standability metric (terrain_predicates.classifyFloor) and one reach metric (eye to the nearest face, as the
// server range-checks a block interaction), read off any world that answers blockAt: a body's own (bot) or the
// integrity keeper's copy (foreman/integrity_keeper_worker), so a stand is judged the same way by both (Law 16).
// anchored_repair re-exports these for the body's own callers.

'use strict';

const Vec3 = require('vec3');
const { BLOCK_REACH } = require('@utils/fragment_utils');
const { classifyFloor } = require('@utils/movement/terrain_predicates');

// EYE_FACTOR — vanilla eye height as a fraction of entity height (eye = feet + height*0.9).
const EYE_FACTOR = 0.9;
const BODY_HEIGHT = 1.8;   // a player's height, for a world with no body in it (the keeper's)

// standEye — the bot's eye position when microCentered on the stand block; every dig/place
// microCenters first, so reach measured from here is deterministic (see assertReachable).
function standEye(bot, stand) {
  return { x: stand.x + 0.5, y: stand.y + ((bot.entity && bot.entity.height) || BODY_HEIGHT) * EYE_FACTOR, z: stand.z + 0.5 };
}

// nearestFaceDist — distance from an eye point to the nearest point of the unit cube at pos,
// matching how the server range-checks a block interaction (eye to surface, not eye to center).
function nearestFaceDist(eye, pos) {
  const nx = Math.max(pos.x, Math.min(eye.x, pos.x + 1));
  const ny = Math.max(pos.y, Math.min(eye.y, pos.y + 1));
  const nz = Math.max(pos.z, Math.min(eye.z, pos.z + 1));
  return Math.sqrt((eye.x - nx) ** 2 + (eye.y - ny) ** 2 + (eye.z - nz) ** 2);
}

// reachFromStand — deterministic server-accurate reach from the microCentered stand block to a
// target voxel; the one reach metric (Law 16) shared by mining anchor-assignment and the in-loop
// reach gate below. pos may be a Vec3 or a plain {x,y,z}.
function reachFromStand(bot, stand, pos) {
  return nearestFaceDist(standEye(bot, stand), pos);
}

// resolveStandableAnchor — given a plot/anchor FLOOR cell, returns a standable stand to work
// from: the anchor's own feet if standable, else the nearest standable cell within reach.
// Returns { floor, feet, alternate } or null when nothing standable reaches the plot. Reuses
// classifyFloor and reachFromStand (Law 16 — one standability metric, one reach metric).
// opts.fallback === false restricts to the anchor's own floor or nothing, for a blueprint whose
// anchors are built by each other (a missing stand means the anchor behind hasn't laid it yet).
// opts.footprint (Set of "x,y,z") is the structure's own cells: a fallback never stands on one above the anchor's
// floor, since that cell is the structure's to clear and a body on it could not dig it.
function resolveStandableAnchor(bot, anchorFloor, opts = {}) {
  const reach = opts.reach || BLOCK_REACH;
  const af = new Vec3(anchorFloor.x, anchorFloor.y, anchorFloor.z);
  const standableAt = (fx, fy, fz) => !!classifyFloor(bot, bot.blockAt(new Vec3(fx, fy, fz)));
  const feetOf = (fx, fy, fz) => ({ x: fx, y: fy + 1, z: fz });
  // Primary: the anchor's own floor. If it is still standable nothing moved — work from it.
  if (standableAt(af.x, af.y, af.z)) {
    return { floor: { x: af.x, y: af.y, z: af.z }, feet: feetOf(af.x, af.y, af.z), alternate: false };
  }
  if (opts.fallback === false) return null;
  // Fallback: nearest standable floor in an expanding ring (±1 in Y for a stepped bank) whose
  // feet-eye still reaches the anchor cell.
  for (let r = 1; r <= 2; r++) {
    let best = null, bestD = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // ring perimeter only
        for (const dy of [0, 1, -1]) {
          const fx = af.x + dx, fy = af.y + dy, fz = af.z + dz;
          if (!standableAt(fx, fy, fz)) continue;
          if (fy > af.y && opts.footprint && opts.footprint.has(`${fx},${fy},${fz}`)) continue;
          const feet = feetOf(fx, fy, fz);
          if (reachFromStand(bot, feet, af) > reach) continue;      // must reach the plot from here
          const d = dx * dx + dz * dz + Math.abs(dy);
          if (d < bestD) { bestD = d; best = { floor: { x: fx, y: fy, z: fz }, feet, alternate: true }; }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

module.exports = { EYE_FACTOR, standEye, nearestFaceDist, reachFromStand, resolveStandableAnchor };
