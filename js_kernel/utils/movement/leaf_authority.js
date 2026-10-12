// The fleet's one definition of what a leaf is: a phantom leaf reads as air to every predicate and is
// punched by reflex when the body reaches it; a blueprint leaf is bedrock. The body does not plan around
// leaves, price them, or ask permission to remove one — it walks as though the canopy were not there, and
// the canopy stops being there as it arrives.
//
// isPhantom is the only question this module answers about a specific cell, and the blueprint exception
// lives inside the predicate — there is no leaf-only path exported for a caller to reach past it
// (Invariant D — one owner).
//
// A leaf plays two separate roles: NEVER A FLOOR — a canopy decays under a standing body, so
// terrain_predicates.isWalkableSurface keeps every leaf out of the floors a route may land on.
// INVISIBLE AS OBSTRUCTION — a leaf in the body's path is not an obstruction. Conflating the two roles
// makes a canopy a wall.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');

const TAG = 'leaf_authority';

// THE ONE DEFINITION of a leaf block. Leaf litter, bushes and firefly_bush are not named here: the server
// already reports them with an empty bounding box, and every predicate in the fleet already passes them
// (Invariant B).
const LEAF_NAME = /(^|_)leaves$/;
function isLeaf(block) {
    return !!(block && typeof block.name === 'string' && LEAF_NAME.test(block.name));
}

// ── THE PROTECTED SET IS CACHED ─────────────────────────────────────────────────────────────────────
// `getAllProtectedBlocks` walks every locked conference room and expands each blueprint's voxel keys —
// too expensive for `getClearance`, among the most-asked questions in the fleet.
//
// The cached set is built from DECLARED voxels of blueprints that hold a locked `transpose_origin`, so it
// changes only when a building is SITED, not as blocks are placed. The one-second window can miss a
// blueprint sited within the last second; it cannot make the fleet punch an already-declared blueprint leaf.
const PROTECTED_TTL_MS = 1000;
let _protectedAt = 0;
let _protected = null;
function protectedSet(bot) {
    const now = Date.now();
    if (now - _protectedAt < PROTECTED_TTL_MS) return _protected;
    _protected = require('@perception/blueprint_survey').getAllProtectedBlocks(bot) || null;
    _protectedAt = now;
    return _protected;
}

// isPhantom — TRUE when this block is a leaf the body may treat as air and remove on contact.
// FALSE for everything else, including a leaf the fleet declared: that one is bedrock.
function isPhantom(bot, block) {
    if (!isLeaf(block)) return false;
    const p = block.position;
    if (!p) return false;
    const owned = protectedSet(bot);
    return !(owned && owned.has(`${p.x},${p.y},${p.z}`));
}

// isPhantomAt — the same question from coordinates, for a caller that has not already read the cell.
function isPhantomAt(bot, x, y, z) {
    return isPhantom(bot, bot.blockAt(new Vec3(x, y, z)));
}

// ── THE REFLEX ──────────────────────────────────────────────────────────────────────────────────────
// Takes no dispatcher, no job, no claim and no permission. It is handed the cells the body is about to
// occupy and empties them. Nothing here decides WHERE the body is going — that is the caller's, and a
// reflex that chose its own targets would be a second navigator (Invariant D).
//
// Reports what it cleared. A cell that is not a phantom is silently skipped, since the overwhelming
// majority of calls clear nothing.
async function punch(bot, cells) {
    const { performDig } = require('@utils/movement/dig_authority');
    let cleared = 0;
    for (const c of cells) {
        const b = bot.blockAt(c instanceof Vec3 ? c : new Vec3(c.x, c.y, c.z));
        if (!isPhantom(bot, b)) continue;
        if (await performDig(bot, b.position, b, TAG)) cleared++;
    }
    if (cleared) watcher.summary(TAG, `punched ${cleared} leaf block(s) out of the body's own path.`);
    return cleared;
}

// clearStance — the cells a body occupies standing at `feet`, plus the cell above its head, which a jump
// needs. Three cells, so a step that rises is as clear as one that does not.
async function clearStance(bot, feet) {
    const f = feet instanceof Vec3 ? feet : new Vec3(feet.x, feet.y, feet.z);
    return await punch(bot, [f, f.offset(0, 1, 0), f.offset(0, 2, 0)]);
}

// isLeafBlock is exported for the FLOOR question alone — `terrain_predicates.isWalkableSurface` and
// `pathfinding_utils.isLeafFloor`, which ask it of any leaf, a blueprint's included.
// Every other caller wants `isPhantom`, which carries the blueprint exception.
module.exports = { isPhantom, isPhantomAt, punch, clearStance, isLeafBlock: isLeaf, TAG };
