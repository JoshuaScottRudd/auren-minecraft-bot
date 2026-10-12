// trunk_bases — what counts as a tree, decided in exactly one place.
//
// The one definition of a tree trunk. Two callers match against it:
//   · perception_nodes.js/surface_filter — what a feller is offered as a target.
//   · Thinking_fragments/assessors/shared — what the board counts when it sizes a clearing phase.
// A board counting more trees than the feller can be offered posts work that cannot be finished, and
// sizes its capacity gate off a number no executor will ever agree with.
//
// A tree is every log that touches another, down to a single log: the logs a scan matched are gathered into
// touching groups (26 neighbours), and each group is one tree, named by its lowest log. An eight-block trunk
// with its branches is one tree; a lone log left hanging in the air is one tree too. Nothing is asked of
// what lies under it — the feller stands on the ground beneath a hanging log and pillars up to it
// (tree_feller.groundUnder). Exposure filtering is skipped here: a trunk's bottom log never looks exposed.
//
// Callers differ in how they read the world — `surface_filter` holds a cached `makeVoxelReader` over a
// whole scan, an assessor has only `bot.blockAt`. Both hand in an object with `blockAt(x, y, z)`;
// `readerForBot` below builds one over a plain bot for the callers that have nothing better.

'use strict';

const LEAF_RE = /(.*_)?leaves$/;
const LOG_RE  = /(.*_)?(log|stem|wood|hyphae)$/;

// The cheapest possible reader: a bot, addressed by loose coordinates. For a caller with no voxel reader
// of its own. Returns a block-shaped value or null, which is all `collapseToTrunkBases` asks of it.
function readerForBot(bot) {
    const Vec3 = require('vec3');
    return { blockAt: (x, y, z) => bot.blockAt(new Vec3(x, y, z)) };
}

// blocks: [{ name, position: {x,y,z} }] — every log block a scan matched, in any order.
// Returns one entry per real tree, positioned at its trunk base.
async function collapseToTrunkBases(reader, blocks) {
    const pace = require('@utils/execution_yield').makeExecutionPacer();
    const byKey = new Map();
    for (const block of blocks) {
        await pace();
        byKey.set(`${block.position.x},${block.position.y},${block.position.z}`, block);
    }
    const seen = new Set();
    const bases = [];
    for (const [start, first] of byKey) {
        if (seen.has(start)) continue;
        seen.add(start);
        let lowest = first;
        const stack = [first];
        while (stack.length) {
            await pace();
            const { x, y, z } = stack.pop().position;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
                const key = `${x + dx},${y + dy},${z + dz}`;
                const next = byKey.get(key);
                if (!next || seen.has(key)) continue;
                seen.add(key);
                if (next.position.y < lowest.position.y) lowest = next;
                stack.push(next);
            }
        }
        // The scan may have matched only part of the column: walk down to the true bottom log.
        let { x, y, z } = lowest.position;
        while (true) {
            await pace();
            const below = reader.blockAt(x, y - 1, z);
            if (below && below.name === lowest.name) y -= 1; else break;
        }
        bases.push(y === lowest.position.y ? lowest : { name: lowest.name, position: { x, y, z } });
    }
    return bases;
}

module.exports = { collapseToTrunkBases, readerForBot, LOG_RE, LEAF_RE };
