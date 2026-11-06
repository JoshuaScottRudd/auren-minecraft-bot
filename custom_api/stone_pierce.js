// api: stone_pierce
// purpose: The alpha structure's stone while the mine is shut (STONE_PIERCE): take a fixed run of stone out of one
//          column under the base and seal the column behind the body. Called by survey_executor for a stone_pierce
//          job (assessors/survey.stoneJobs posts one only for the alpha structure's stone).
//
// A 1-wide shaft dug to a fixed depth and filled on the way out is the least the world gives up for the material: a
// smaller excavation than a chamber yielding the same haul, no unlit cavity for anything to spawn in, and no memory —
// the body never leaves the shaft, so the way out is the cell it stands in (Invariant B; Law 2).
//
// Three preconditions hold before the first dig (Law 13, default-stopped): a pickaxe (the job is posted only to a
// body that can harvest stone), sealing material (filler_reserve, checked here), and a column the scanner walked to
// its resting block. All three are unrecoverable at the bottom of the shaft, so none is checked there.
//
// Descent is borrowed, not rebuilt (Law 16): locomotion.descendColumn owns the only straight dig-down in the fleet
// and re-verifies the resting block per step. Nothing here digs; the stone arrives because the descent passes through
// it, so the harvest and the travel are one act. The body may not move in X or Z on the way down.
//
// One column, one body (Invariant D): a column is claimed the way a tree is, through the foreman, keyed on the column
// itself, with its 3x3 ground as a footprint so two shafts never open side by side. Claimed before the walk and
// released when the walk fails, so the scanner returns a ranked list, not a single winner.
//
// The ascent names its materials (pillar_block), so a body short of timber does not climb out on the cobblestone it
// came down for while still reporting the trip a success (Law 25).
//
// A BOOTSTRAP, NOT A SOURCE: it is starter fluid for the alpha structure, so every trip ends by banking its whole haul
// in the fleet's chests, where the structure's builder reads it.

'use strict';

const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const stoneColumnScanner = require('@perception/stone_column_scanner');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { sleep, getBotInventory, group_to_item } = require('@utils/fragment_utils');
const { STONE_PIERCE } = require('@thinking/architect_config');
const { claimFirst, releaseTarget } = require('@utils/target_claims');

const TAG = 'stone_pierce';

// Mining `stone` with any pickaxe drops cobblestone; the scanner gates the run on `stone` so this is the one thing a
// trip produces, and both cobblestone and the furnace's `furnace_material` are paid by it.
const YIELD_ITEM = 'cobblestone';

// Keyed on the column; the surface Y is in the key so a re-scan after the terrain moved is a different object.
function columnKey(c) { return `stone_column:${c.x},${c.surfaceY},${c.z}`; }

// The 3x3 ground round the shaft, keyed on XZ only: on a slope each neighbour sits at its own Y, so a footprint keyed
// with this column's surfaceY would miss the peer it exists to collide with.
function columnFootprint(c) {
    const keys = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) keys.push(`stone_column:${c.x + dx},${c.z + dz}`);
    }
    return keys;
}

function fillerHeld(bot) {
    let n = 0;
    for (const it of bot.inventory?.items?.() || []) {
        if (it && it.count > 0 && group_to_item.scaffold_spendable.includes(it.name)) n += it.count;
    }
    return n;
}

// Seal the shaft from the inside, one placement per block of depth, until the body stands higher than the ground it
// opened. The height is the judge; `budget` only bounds a pathological loop, and two steps that gain nothing stop it.
async function sealAndClimb(bot, surfaceY) {
    const budget = STONE_PIERCE.stone_run + STONE_PIERCE.max_overburden + 4;
    let stalls = 0;
    for (let i = 0; i < budget; i++) {
        const before = bot.entity.position.floored().y;
        if (before > surfaceY) return { out: true, placed: i };
        const step = await pillarStep(bot, { candidateItemNames: group_to_item.pillar_block });
        await sleep(80);
        const after = bot.entity.position.floored().y;
        if (after > before) { stalls = 0; continue; }
        if (++stalls >= 2) return { out: false, placed: i, reason: step?.reason || 'no_height_gain' };
    }
    return { out: bot.entity.position.floored().y > surfaceY, placed: budget, reason: 'budget_exhausted' };
}

// pierce(bot, asked, spent) → { gained, readable, refused?, abandoned?, spent }. `abandoned`: the bank's transfer has
// already routed to the judge, so the caller routes nothing. `spent` is the column keys this job already
// opened and could not work to its resting block; the returned list is the one the next trip of the same job reads.
// `refused` names a trip that never went down (no sealing stock, no column), so the caller can take the stone another
// way instead.
async function pierce(bot, asked, spent = []) {
    const filler = fillerHeld(bot);
    if (filler < STONE_PIERCE.filler_reserve) {
        return { gained: 0, spent, refused: `${filler}/${STONE_PIERCE.filler_reserve} spendable blocks to seal the way back up` };
    }
    const { columns } = await stoneColumnScanner.scan(bot);
    if (!columns.length) return { gained: 0, spent, refused: 'no column within reach holds an uninterrupted stone run' };

    const held0 = countInInventory(YIELD_ITEM, getBotInventory());
    const walk = await claimFirst(columns, {
        keyOf: columnKey,
        footprintOf: columnFootprint,
        skip: (candidate, key) => spent.includes(key),
        maxUnreachable: STONE_PIERCE.max_approaches,
        approach: async (candidate) => {
            // Arrival is re-sensed: goToStand resolves at the closest reachable cell when the exact one is not, and a
            // shaft opened anywhere but the scanned column is opened on no evidence (Law 25).
            const went = await locomotion.goToStand({ x: candidate.x, y: candidate.surfaceY, z: candidate.z });
            const stood = bot.entity.position.floored();
            return { ok: !!went?.arrived && stood.x === candidate.x && stood.z === candidate.z };
        },
    });
    const column = walk.pick;
    if (!column) {
        return { gained: 0, spent, refused: `no reachable unclaimed column (${columns.length} scanned, ${walk.peerHeld} held by peers, `
            + `${walk.unreachable} unreachable${walk.skipped ? `, ${walk.skipped} spent this job` : ''})` };
    }
    watcher.summary(TAG, `PIERCE_OPEN column=(${column.x},${column.z}) depth=${column.depth} overburden=${column.overburden} `
        + `run=${STONE_PIERCE.stone_run} filler=${filler}`);

    // Marked spent before the work: a trip killed mid-descent writes nothing on the way out, and the column that
    // swallowed it is the one the next trip must not re-open. Cleared below only on a full trip.
    let nextSpent = [...spent, walk.key];
    const descent = await locomotion.descendColumn({ x: column.x, z: column.z, toFeetY: column.standFeetY });
    await sleep(200);
    const bottom = bot.entity.position.floored();
    const gained = countInInventory(YIELD_ITEM, getBotInventory()) - held0;

    // Out first, whatever the haul: a short haul is a supply outcome, a body left in a hole is a stranded body.
    const climb = await sealAndClimb(bot, column.surfaceY);
    releaseTarget(walk.keys);
    if (!climb.out) {
        watcher.warn(TAG, `PIERCE_STRANDED column=(${column.x},${column.z}) sealed=${climb.placed} of ${column.depth} reason=${climb.reason} `
            + `y=${bot.entity.position.floored().y} took=${gained}`);
        return { gained, spent: nextSpent, readable: `pierce: took ${gained}x ${YIELD_ITEM} but did not climb out (${climb.reason})` };
    }
    if (bottom.y === column.standFeetY) nextSpent = spent;
    const short = bottom.y !== column.standFeetY ? `, descent stopped at y=${bottom.y} of ${column.standFeetY} (${descent?.reason || 'unknown'})` : '';
    watcher.summary(TAG, `PIERCE_DONE column=(${column.x},${column.z}) took=${gained} asked=${asked} depth=${column.depth} sealed=${climb.placed}`);
    // THE HAUL IS BANKED, WHATEVER THE POCKET'S ROW KEEPS: the pierce exists only to start the alpha structure, whose
    // pool is the chests and its builder's own pocket, never a peer's, so stone left in this pocket starts nothing.
    const banked = gained > 0 ? await require('@api/inventory_swapper').depositItems(bot, YIELD_ITEM, gained) : { transferred: 0 };
    if (banked === undefined) return { gained, spent: nextSpent, abandoned: true };
    const readable = `pierce: ${gained}x ${YIELD_ITEM} of ${asked} asked from (${column.x},${column.z}), shaft ${column.depth} deep, `
        + `sealed ${climb.placed}, banked ${banked.transferred || 0}${short}`;
    return { gained, spent: nextSpent, readable };
}

module.exports = { pierce, TAG };
