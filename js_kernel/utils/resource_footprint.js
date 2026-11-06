'use strict';
// resource_footprint.js — what one resource claim holds: the ground a body works while it takes a resource.
//
// A body taking a resource works more than the block it names: it stands beside it, digs around it, and its
// drops fall about it. So a resource claim holds a box, and while a body holds one no other body is granted
// any resource of any kind whose box touches it — not a tree beside a dirt patch, not a stone beside a tree.
// The foreman grants every resource claim by this box (foreman_brain), and a body choosing a target reads its
// peers' claims by it, so both answer "is this ground taken" the same way (Law 16).
//
// ── THE BOX ───────────────────────────────────────────────────────────────────────────────────────────
// A 5x5x5 cube centred on the objective (RESOURCE_RADIUS each way), with two shapes of their own:
//   tree:x,y,z,top   the 5x5 column around the trunk's base, from the base to the tree's top log: the feller
//                    stands beside the trunk, pillars up it, and takes the logs above.
//   dirt:tx,tz       one DIRT_TILE square of columns (ground_shave), at every height: shaving takes the ground
//                    a layer at a time wherever the surface lies inside the tile.
// Every other resource key names its objective as x,y,z and holds the cube around it.

const RESOURCE_RADIUS = 2;
const DIRT_TILE = 5;
// Every key prefix that names a resource. A key under any other prefix is an exact-block claim.
const RESOURCE_PREFIXES = ['tree:', 'dirt:', 'grass:', 'dig:'];

const isResourceKey = (key) => typeof key === 'string' && RESOURCE_PREFIXES.some(p => key.startsWith(p));

// boxOfKey(key) → { min: {x,y,z}, max: {x,y,z} } for a well-formed resource key, or null for a malformed one
// (or a key that names no resource). An unbounded height is ±Infinity.
function boxOfKey(key) {
    if (!isResourceKey(key)) return null;
    const prefix = RESOURCE_PREFIXES.find(p => key.startsWith(p));
    const n = key.slice(prefix.length).split(',').map(Number);
    if (!n.every(Number.isFinite)) return null;
    const r = RESOURCE_RADIUS;
    if (prefix === 'tree:') {
        if (n.length !== 4 || n[3] < n[1]) return null;
        const [x, y, z, top] = n;
        return { min: { x: x - r, y, z: z - r }, max: { x: x + r, y: top, z: z + r } };
    }
    if (prefix === 'dirt:') {
        if (n.length !== 2) return null;
        const [tx, tz] = n;
        return { min: { x: tx * DIRT_TILE, y: -Infinity, z: tz * DIRT_TILE }, max: { x: tx * DIRT_TILE + DIRT_TILE - 1, y: Infinity, z: tz * DIRT_TILE + DIRT_TILE - 1 } };
    }
    if (n.length !== 3) return null;
    const [x, y, z] = n;
    return { min: { x: x - r, y: y - r, z: z - r }, max: { x: x + r, y: y + r, z: z + r } };
}

// Do two boxes share a cell?
function overlaps(a, b) {
    return a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y
        && a.min.z <= b.max.z && b.min.z <= a.max.z;
}

// Does a box hold the cell `p`?
function contains(box, p) {
    return p.x >= box.min.x && p.x <= box.max.x && p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z;
}

// The boxes every working peer's resource claims hold, read off their chairs (foreman_link.peerClaimKeys).
function peerBoxes() {
    const out = [];
    for (const key of require('@kernel/foreman_link').peerClaimKeys()) {
        const box = boxOfKey(key);
        if (box) out.push({ key, box });
    }
    return out;
}

// Is the cell `p` inside ground a peer is working?
function peerHolds(p) {
    return peerBoxes().some(b => contains(b.box, p));
}

module.exports = { RESOURCE_RADIUS, DIRT_TILE, RESOURCE_PREFIXES, isResourceKey, boxOfKey, overlaps, contains, peerBoxes, peerHolds };
