// site_framing — where a fixed camera stands to film a structure. Given a blueprint's size and a locked
// site, it solves one camera position and names each operator criterion it could not hold, so a shortfall
// is reported and never silently absorbed (Law 25).
//
// A different verb from camera_rig.solveView, which frames a moving BOT and is clamped to
// `frame.maxShotDist`. This frames a fixed PLACE, sized from the structure itself; that ceiling does not
// apply here — distance is solved from the structure's size, not capped.
//
// ── SOLVES IN LENS COORDINATES; THE CALLER TELEPORTS FEET ──────────────────────────────────────────
// `lens` is the rendered viewpoint, `frame.eyeHeight` above the feet; `feet` is the teleport target.
// Returned as two named fields so nobody has to remember which one they are holding.
//
// ── THE FOUR CRITERIA ARE THE OPERATOR'S ────────────────────────────────────────────────────────────
// whole structure framed · above the canopy · low enough to read as 3D · filling most of the frame. They
// can conflict — clearing a tall canopy over a short structure forces a height that reads as a plan view
// — so `relaxed[]` names any criterion not fully held, with what was asked and what was delivered.
//
// ── THE DEFAULT BEARING IS A 45-DEGREE CORNER ───────────────────────────────────────────────────────
// It presents `w·cos45 + l·cos45` of the footprint on every seed regardless of how the site rotated the
// structure to fit the terrain, and shows three faces instead of two. Its silhouette is wider than a
// face-on view, so width can be the axis that sets distance.

'use strict';

const { makeVoxelReader } = require('@utils/voxel_reader');

const rad = d => (d * Math.PI) / 180;
const deg = r => (r * 180) / Math.PI;

// Blocks a camera can see straight through, so they are not canopy. `cave_air` and `void_air` are here
// because a snapshot of an unloaded or hollowed column reports them where a live world reports nothing.
const SEE_THROUGH = new Set(['air', 'cave_air', 'void_air']);

// The topmost block in a column that is not air — what would be in front of the lens, the opposite
// question from `readSurface`, which looks past leaves to find the ground a building stands on.
function canopyTopAt(reader, x, z, top, floor) {
  for (let y = top; y >= floor; y--) {
    const b = reader.blockAt(x, y, z);
    if (b && !SEE_THROUGH.has(b.name)) return y;
  }
  return floor;
}

// solveSiteCamera — one camera for one structure.
//
//   bot        a client with a loaded world (live scout, or a voxel snapshot in a bench). The canopy is
//              READ from it; nothing about the shot is decided from a remembered map (Invariant B).
//   centre     the locked site: x/z of the structure's centre, y of its GROUND FLOOR.
//   footprint  { w, l } as the structure will actually stand, after any rotation the siting chose.
//   height     the blueprint's full height in blocks.
//   below      how much of that height is underground. A basement is not framed: it cannot be seen.
//   criteria   the operator's four numbers plus the lens — see camera_configure.sites.
//
// Returns { lens, feet, yaw, pitch, distance, ... , relaxed[] }.
function solveSiteCamera(bot, { centre, footprint, height, below = 0, criteria }) {
  if (!bot || !bot.world) {
    throw new Error('[site_framing] CODING VIOLATION (Law 13): solveSiteCamera needs a client with a loaded world to read the canopy from.');
  }
  for (const [k, v] of Object.entries({ x: centre?.x, y: centre?.y, z: centre?.z, w: footprint?.w, l: footprint?.l, height })) {
    if (!Number.isFinite(v)) {
      throw new Error(`[site_framing] CODING VIOLATION (Law 13): ${k} must be a number, got ${v}.`);
    }
  }
  const { fovDeg, aspect, fill, elevationDeg, bearingDeg, canopyPad, corridorHalfWidth, scanTop, eyeHeight } = criteria;

  const hFov = 2 * deg(Math.atan(Math.tan(rad(fovDeg / 2)) * aspect));

  // What the camera must actually frame: the basement is buried and unseen, so only the height above
  // ground counts.
  const visibleHeight = height - below;
  if (visibleHeight <= 0) {
    throw new Error(`[site_framing] CODING VIOLATION (Law 13): nothing of this structure stands above ground (height ${height}, below ${below}).`);
  }
  const floorY = centre.y;
  const target = { x: centre.x, y: floorY + visibleHeight / 2, z: centre.z };

  // Unit vector FROM the structure TOWARD the camera. Bearing is a compass reading, so 0 puts the camera
  // due north of the subject; Minecraft's north is -Z.
  const az = rad(bearingDeg);
  const u = { x: -Math.sin(az), z: -Math.cos(az) };

  // The silhouette this bearing presents — the two footprint edges projected across the view direction.
  const silhouette = footprint.w * Math.abs(u.z) + footprint.l * Math.abs(u.x);

  // Distance: solved twice and the larger wins, so whichever axis would overflow the frame is the one
  // that sets it. Taking the smaller would fill the frame on one axis by cropping the other.
  const dForHeight = (visibleHeight / 2) / Math.tan(rad((fill * fovDeg) / 2));
  const dForWidth = (silhouette / 2) / Math.tan(rad((fill * hFov) / 2));
  const distance = Math.max(dForHeight, dForWidth);
  const binding = dForHeight >= dForWidth ? 'height' : 'width';

  const wantedLensY = target.y + distance * Math.tan(rad(elevationDeg));

  // ── THE CANOPY, MEASURED ALONG THE SIGHTLINE TO THE STRUCTURE'S BASE, NOT ITS CENTRE ───────────────
  // For a tree at horizontal distance d from the base, the sightline sits at
  // floorY + (lensY - floorY)·(d/distance), so the lens height that clears it is
  // floorY + (treeTop + pad - floorY)·(distance/d). The worst column wins.
  const reader = makeVoxelReader(bot, { needs: ['type'] });
  const perp = { x: -u.z, z: u.x };
  const firstSample = Math.max(2, Math.round(silhouette / 2));
  let requiredLensY = wantedLensY;
  let tallest = floorY;
  let blockedBy = null;
  try {
    for (let d = firstSample; d <= Math.ceil(distance); d++) {
      for (let o = -corridorHalfWidth; o <= corridorHalfWidth; o++) {
        const x = Math.round(centre.x + u.x * d + perp.x * o);
        const z = Math.round(centre.z + u.z * d + perp.z * o);
        const top = canopyTopAt(reader, x, z, scanTop, floorY - 20);
        if (top > tallest) tallest = top;
        const needed = floorY + ((top + canopyPad) - floorY) * (distance / d);
        if (needed > requiredLensY) { requiredLensY = needed; blockedBy = { x, z, top, distance: d }; }
      }
    }
  } finally {
    reader.dispose();
  }

  const lensY = Math.max(wantedLensY, requiredLensY);
  const lens = { x: centre.x + u.x * distance, y: lensY, z: centre.z + u.z * distance };
  const elevation = deg(Math.atan((lensY - target.y) / distance));

  // Every criterion not fully held, named with what was asked and what was delivered. An empty list
  // states that all four held (Law 25).
  const relaxed = [];
  if (elevation > elevationDeg + 0.05) {
    relaxed.push({
      criterion: 'look-down angle',
      asked: `${elevationDeg}°`,
      got: `${elevation.toFixed(1)}°`,
      because: `the canopy forced the lens ${(lensY - wantedLensY).toFixed(1)} higher`
        + (blockedBy ? ` — a block at (${blockedBy.x},${blockedBy.z}) topping out ${blockedBy.top - floorY} above the ground floor, ${blockedBy.distance} out` : ''),
    });
  }

  // The view direction, as the two angles a teleport takes. Minecraft yaw 0 faces +Z.
  const toTarget = { x: target.x - lens.x, y: target.y - lens.y, z: target.z - lens.z };
  const horiz = Math.hypot(toTarget.x, toTarget.z);

  return {
    lens,
    feet: { x: lens.x, y: lens.y - eyeHeight, z: lens.z },
    yaw: deg(Math.atan2(-toTarget.x, toTarget.z)),
    pitch: deg(Math.atan2(-toTarget.y, horiz)),
    distance,
    binding,
    silhouette,
    visibleHeight,
    fill: {
      height: (2 * deg(Math.atan((visibleHeight / 2) / distance))) / fovDeg,
      width: (2 * deg(Math.atan((silhouette / 2) / distance))) / hFov,
    },
    canopy: {
      tallestAboveFloor: tallest - floorY,
      raisedBy: lensY - wantedLensY,
      blockedBy,
    },
    // How much ground the frame holds at the subject's distance — tells whether a second nearby
    // structure already sits in this shot.
    groundWidthAtSubject: 2 * distance * Math.tan(rad(hFov / 2)),
    horizontalFovDeg: hFov,
    relaxed,
  };
}

module.exports = { solveSiteCamera };
