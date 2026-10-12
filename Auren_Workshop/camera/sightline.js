// camera/sightline — the one answer to whether a viewer would see through a cell, and whether a line
// between two points is open (Law 16). Shared by camera_scout, which grades a candidate before the cut,
// and camera_gimbal, which re-asks it during the shot, so neither client owns a private copy.
//
// Takes a lookup, not a bot: the caller passes `blockAt(x, y, z) -> block | null`, so this file carries no
// mineflayer or vector-class dependency of its own.
//
// Both ends are world coordinates, not block cells — a lens position and a subject's chest, both
// continuous, measured without snapping either to a cell centre.

'use strict';

// Does this cell stop the camera's view — a different question from whether it stops a player. A null
// block reads as opaque: an unloaded chunk is unknown, never counted as clear (Law 23).
function isOpaque(b, blockers) {
  if (!b) return true;
  if (b.boundingBox !== 'empty') return true;          // leaves land here — they are full blocks
  return !!(blockers && blockers.has ? blockers.has(b.name) : blockers && blockers.indexOf(b.name) >= 0);
}

// walkLine(blockAt, from, to, blockers) -> { known, clear, blockedBy }
//
// Walks the line by hand and tests each cell by name: thin foliage (sugar cane, tall grass, ferns, vines)
// carries `boundingBox: 'empty'` with no collision shape, so it blocks the shot on screen while a raycast
// would report the line clear.
//
// Stepped at half a block, so the smallest block feature cannot be skipped. Both endpoints are skipped —
// the lens and the subject each stand in their own cell and do not obstruct themselves.
function walkLine(blockAt, from, to, blockers) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-3) return { known: true, clear: true, blockedBy: null };
  const stepN = Math.max(1, Math.ceil(len / 0.5));
  for (let i = 1; i < stepN; i++) {
    const t = i / stepN;
    const b = blockAt(from.x + dx * t, from.y + dy * t, from.z + dz * t);
    if (!b) return { known: false };                   // unloaded — do not claim a clear line
    if (isOpaque(b, blockers)) return { known: true, clear: false, blockedBy: b.name };
  }
  return { known: true, clear: true, blockedBy: null };
}

module.exports = { isOpaque, walkLine };
