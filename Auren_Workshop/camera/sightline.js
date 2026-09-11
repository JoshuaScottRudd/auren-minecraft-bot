// camera/sightline — the ONE answer to "would a viewer see through this cell, and is this line open?"
//
// WHY IT IS ITS OWN FILE. Two clients now ask the question and they are different clients: camera_scout,
// the parked observer that grades a candidate BEFORE the cut, and camera_gimbal, which sits AT the lens and
// re-asks it twice a second DURING the shot. A second copy in the gimbal would have been four lines, and
// four lines is exactly how the two would have drifted — the blocker list grows, someone adds a case to one
// walk, and the rig starts cutting on a rule the seeker never applied. One implementation of one question
// (Law 16), and neither client owns it, so neither has to import the other.
//
// IT TAKES A LOOKUP, NOT A BOT, and that is what lets it be shared at all. Each client resolves its own
// mineflayer and its own Vec3; a module that required either would have to pick one client's copy and hand
// it to the other. So the caller passes `blockAt(x, y, z) -> block | null` and this file knows nothing about
// clients, protocols, or vector classes — it is arithmetic over a lookup.
//
// BOTH ENDS ARE WORLD COORDINATES. Not block cells: the callers hold a lens position and a subject's chest,
// both continuous. Centring a float on its cell (the +0.5-per-axis this used to do inside the scout)
// displaces the line ~0.87 blocks diagonally off the sightline it claims to measure, which at canopy
// density is a leaf's width of lie in the one measurement that exists to catch leaves.

'use strict';

// Does this cell stop the CAMERA's view? Not the same question as "does it stop a player", which is what
// boundingBox answers — sugar cane stops neither a player nor a raycast, and stops the shot completely.
// A null block is treated as OPAQUE: an unloaded chunk is unknown, and the whole failure class here is
// reading "empty because we didn't look" as "clear" (Law 23).
function isOpaque(b, blockers) {
  if (!b) return true;
  if (b.boundingBox !== 'empty') return true;          // leaves land here — they are full blocks
  return !!(blockers && blockers.has ? blockers.has(b.name) : blockers && blockers.indexOf(b.name) >= 0);
}

// walkLine(blockAt, from, to, blockers) -> { known, clear, blockedBy }
//
// WHY THIS EXISTS ALONGSIDE raycast. bot.world.raycast only stops on blocks with collision SHAPES, and
// sugar cane / tall grass / ferns / vines are all `boundingBox: 'empty'` with no shapes — a ray passes
// straight through them while they are fully opaque on screen, so a bot standing behind sugar cane is
// invisible to the eye yet every ray reports clear. A raycast MATCHER cannot fix it either, because the
// matcher runs before an intersect test that needs shapes it does not have. So the line is walked by hand
// and each cell tested BY NAME.
//
// Stepped at half a block: the smallest block feature is a full cell, so half-block steps cannot skip one,
// and at our shot distances (≤10 blocks) that is ~20 cheap lookups. Both endpoints are skipped — the lens
// sits in its own cell and the subject stands in its own, and neither obstructs itself.
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
