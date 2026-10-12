// fragment: stone_prospect_executor (action / stone acquisition)
// purpose: One verb (Law 0) — take a fixed run of stone out of a single surface column and seal the
//          column behind you. It is the producer supply_manager dispatches when a shortfall decomposes
//          to cobblestone, the way harvest_executor is the producer for logs. Stone is abundant at
//          nearly every surface XZ, so any bot can dig for it where it stands, without depending on a
//          headframe or a sited base.
//
// A 1-wide shaft dug to a fixed depth and filled on the way out is the least the world has to give up
// for the material: a smaller excavation than a chamber yielding the same haul, no unlit cavity for
// anything to spawn in, and no memory — the bot never leaves the shaft, so the way out is the cell it
// is standing in (Invariant B; Law 2).
//
// Three preconditions must hold before the first dig (Law 13, default-stopped): a pickaxe, enough
// sealing material, and a column the scanner has already walked to its resting block. All three are
// unrecoverable at the bottom of the shaft, so none of them is checked there.
//
// Descent is borrowed, not rebuilt (Law 16): the bot sinks the shaft through locomotion, which owns the
// only dig-down in the fleet and re-verifies the resting block per step (Invariant B — the scan is a
// plan, the step is a sensing). Nothing here digs; the stone arrives because the descent passes through
// it, so the harvest and the travel are one act.
//
// The verb is `descendColumn`, not `goTo`: it is vertical at both ends, the scanner proves one column
// and the ascent pillars back up the same column. A route search owes a column nothing, so staying in
// it is enforced as a constraint — the body may not move in X or Z — and not left to a search's prices
// (Law 27).
//
// One column, one bot (Invariant D): a column is a world object, and two bots digging the same one
// means the second descends into the first one's hole. Claimed the way a tree is — object exclusivity
// through the foreman, keyed on the column itself, chosen at execution time from live perception since
// a planning token cannot name a column nothing had scanned yet. Claimed before the walk and released
// the moment the walk fails, so the scanner returns a ranked list, not a single winner.
//
// Spent-column memory (the tree feller's spent-tree list, one material over): a column reached and
// opened but not worked to its resting block is deterministically re-chosen on the next dispatch, since
// the scanner ranks nearest-first. The list rides the payload capsule, not a module variable: it
// survives the manager<->judge retry loop within one job and resets on a fresh job_board dispatch
// (Law 12 — a new chain re-plans from current world state).
//
// The ascent names its materials explicitly, not the fleet's default pillar order: that order reaches
// masonry before soil and would have a bot out of timber climb out on the exact cobblestone it
// descended for, consuming its own product while still reporting success (Law 25).

'use strict';

const watcher = require('@kernel/watcher');
const portableJudge = require('@kernel/portable_judge');
const locomotion = require('@locomotion/locomotion_dispatcher');
const stoneColumnScanner = require('@perception/stone_column_scanner');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { sleep, getBotInventory, group_to_item } = require('@utils/fragment_utils');
const { STONE_PROSPECT } = require('@thinking/architect_config');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const { claimFirst, releaseTarget } = require('@utils/target_claims');

const TAG = 'stone_prospect_executor';

// What the column actually yields. Mining `stone` with any pickaxe drops cobblestone — the run is
// gated on `stone` by the scanner precisely so this is the one thing a trip can produce, and the
// caller's order (cobblestone, or the `furnace_material` group the furnace recipe names) is satisfied
// by it either way.
const YIELD_ITEM = 'cobblestone';

// Keyed on the column, not the bot — the object is what is exclusive. The surface Y is in the key so a
// re-scan of the same XZ after the terrain moved is a different object, not a stale hold on this one.
function _columnKey(c) { return `stone_column:${c.x},${c.surfaceY},${c.z}`; }

// ── the shaft reserves the ground around it, not only the hole ───────────────
// Claims a 3x3 area centred on the shaft, keyed on XZ only, since it is ground being reserved: on a
// slope each neighbour sits at its own Y, so a footprint keyed with this column's surfaceY would miss
// the peer it exists to collide with. The centre keeps its full key, since that one names the object.
//
// The two key shapes share a namespace on purpose: a peer's centre key does not collide with this area
// key, so the collision that matters is area-against-area, and every shaft claims all nine of its area
// cells including its own, so two shafts within one block of each other always share at least three.
function _columnFootprint(c) {
    const keys = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) keys.push(`stone_column:${c.x + dx},${c.z + dz}`);
    }
    return keys;
}

function _fillerHeld(bot) {
    const items = bot.inventory?.items?.() || [];
    let n = 0;
    for (const it of items) {
        if (it && it.count > 0 && group_to_item.scaffold_spendable.includes(it.name)) n += it.count;
    }
    return n;
}

// No dropOffHaul on the way out, unlike harvest_executor: this haul sits under the cobblestone row's
// keep and is spent directly on a craft, not banked in a chest.
async function _routeResult(payload, success, readable) {
    if (success) portableJudge.done(TAG);
    const capsule = payload[TAG] || (payload[TAG] = {});
    capsule.success = success;
    capsule.readable = readable;
    payload.readable = readable;
    return routeToJudge(TAG, { ...payload });
}

// Concedes, instead of soft-failing, when the trip is futile from here: no column in range, or a
// precondition this bot cannot fix by trying again. Carries its own judge (portable_judge, forgiving),
// the same pattern harvest_executor uses, so a fresh plan cycle answers "not from here" while repeated
// concessions still escalate.
async function _routeIdle(payload, reason) {
    const verdict = await portableJudge.checkpoint(TAG, `idle: ${reason}`, 'forgiving');
    if (verdict === false) return;   // portable_judge already routed — a second signal would break Law 4
    watcher.summary(TAG, reason);
    require('@thinking/dispatcher.js').clearMagnet();
    routeSignal(TAG, 'idle_park', { readable: `${TAG}: ${reason} → idle_park` });
}

// Seal the shaft from the inside, one placement per block of depth, until the body is back above the
// surface it started from. THE JUDGE IS THE HEIGHT, not the iteration count: `budget` only bounds a
// pathological loop, while the terminator is the bot standing higher than the ground it opened. A
// step that places nothing and gains nothing twice running stops the climb — continuing would spend
// the remaining filler on the same refused cell.
async function _sealAndClimb(bot, surfaceY) {
    const budget = STONE_PROSPECT.stone_run + STONE_PROSPECT.max_overburden + 4;
    let stalls = 0;
    for (let i = 0; i < budget; i++) {
        const before = bot.entity.position.floored().y;
        if (before > surfaceY) return { out: true, placed: i };
        const step = await pillarStep(bot, { candidateItemNames: group_to_item.pillar_block });
        await sleep(80);
        const after = bot.entity.position.floored().y;
        if (after > before) { stalls = 0; continue; }
        if (++stalls >= 2) {
            return { out: false, placed: i, reason: step?.reason || 'no_height_gain' };
        }
    }
    return { out: bot.entity.position.floored().y > surfaceY, placed: budget, reason: 'budget_exhausted' };
}

module.exports = {
    receive: watcher.track(TAG, async (signalType, payload = {}) => {
        if (signalType !== TAG) return;

        const bot = global.bot;
        if (!bot?.entity?.position) {
            throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the prospect ran.`);
        }

        const asked = Number(payload.quantity) > 0 ? Number(payload.quantity) : STONE_PROSPECT.stone_run;

        // The pickaxe and sealing-reserve preconditions live at the board's gates, not here:
        // `job_gates.toolGate` calls `hasPickaxe(bot)` and `job_gates.fillerGate` counts the same
        // `scaffold_spendable` set against `STONE_PROSPECT.filler_reserve`. If a prospect job reaches
        // this executor without a pickaxe or without sealing blocks, one of those gates is what to fix.

        // The remaining precondition: a column that reaches its resting block, that no peer holds, and
        // that this body can actually stand on. Ranked nearest-first by the scanner; walked in that
        // order until one of them satisfies all three.
        const { columns } = await stoneColumnScanner.scan(bot);
        if (!columns.length) {
            return _routeIdle(payload, 'no column within reach holds an uninterrupted stone run');
        }

        const capsule = payload[TAG] || (payload[TAG] = {});
        const spent = Array.isArray(capsule.failed_columns) ? capsule.failed_columns : [];

        const held0 = countInInventory(YIELD_ITEM, getBotInventory());

        // Claim-reach-release through target_claims, the one walk trees, stone columns and grass share
        // (Law 16). A column this job already proved unworkable is skipped before the claim, so a peer
        // whose approach might succeed where this body's did not is not locked out.
        const walk = await claimFirst(columns, {
            keyOf: _columnKey,
            footprintOf: _columnFootprint,
            skip: (candidate, key) => spent.includes(key),
            maxUnreachable: STONE_PROSPECT.max_approaches,
            approach: async (candidate) => {
                // Stands on top of the column before opening it; goToStand converts "this block" into
                // "the cell above it", the one place the descent can begin from.
                const approach = await locomotion.goToStand({ x: candidate.x, y: candidate.surfaceY, z: candidate.z });
                const stood = bot.entity.position.floored();
                // Arrival is re-sensed, never trusted: goTo resolves successfully at the closest
                // reachable cell when the exact one is unreachable, so `arrived` alone would let the bot
                // open a shaft at a column nothing scanned (Law 25 — a success flag is not a measurement).
                return { ok: !!approach?.arrived && stood.x === candidate.x && stood.z === candidate.z };
            },
        });
        // `columnKey` names the object — it is what `failed_columns` remembers and what the trace prints.
        // `heldKeys` is the whole 3x3 hold and is what gets released (see _columnFootprint).
        const column = walk.pick, columnKey = walk.key, heldKeys = walk.keys;
        const { peerHeld, unreachable, skipped } = walk;

        if (!column) {
            return _routeIdle(payload, `no reachable unclaimed column `
                + `(${columns.length} scanned, ${peerHeld} held by peers, ${unreachable} unreachable`
                + `${skipped ? `, ${skipped} spent this job` : ''})`);
        }

        // Sealing stock is reported, not gated on here — the gate for it is job_gates.fillerGate. A
        // trace that says what the body went down with is how a bottom-of-the-hole concession is read
        // afterwards (Law 25).
        watcher.summary(TAG, `opening column @${column.x},${column.z} — ${column.depth} deep `
            + `(${column.overburden} overburden + ${STONE_PROSPECT.stone_run} stone), sealing stock ${_fillerHeld(bot)}`
            + `${skipped ? ` — skipped ${skipped} spent` : ''}`);

        // Marked spent before the work, not after: a trip that ends without reaching either exit path —
        // a preemption, a death, a signal killed mid-descent — writes nothing on the way out, and the
        // column that swallowed it is exactly the one the next dispatch must not re-open. Cleared below
        // on the one outcome that proves the column was workable.
        capsule.failed_columns = [...spent, columnKey];

        // The descent is the harvest: every dig-down through the run drops one cobblestone, so reaching
        // the bottom cell and collecting the stone are the same act. Straight down, in this column, by
        // construction: staying in a column is a constraint a route search cannot be trusted to hold on
        // its own price.
        const descent = await locomotion.descendColumn({ x: column.x, z: column.z, toFeetY: column.standFeetY });
        await sleep(200);

        // A descent that stops short is not abandoned here: the body is in a hole either way, so the
        // climb-out below runs on every path and the short haul is reported afterwards, carrying the
        // descent's own reason.
        const bottom = bot.entity.position.floored();
        const gained = countInInventory(YIELD_ITEM, getBotInventory()) - held0;

        // Climbs out first and reports second, whatever the haul: a short haul is a supply outcome, but
        // a bot left standing in a sealed-off hole is a stranded body, and that must not wait on the
        // haul being satisfactory.
        const climb = await _sealAndClimb(bot, column.surfaceY);

        // The claim is released once the body is out and the haul is counted, on every path below
        // (Law 8 — whoever raised the lifecycle ends it). A signal killed mid-descent skips this, which
        // is what foreman_link's releaseAllClaims exists to sweep.
        if (!climb.out) {
            releaseTarget(heldKeys);
            // Environmental, not a defect: the filler ran out or a placement was refused. Reported as a
            // failure with the reason attached, not as a partial success, so the board can tell this
            // apart from a completed trip (Law 25).
            watcher.warn(TAG, `sealed ${climb.placed} of ${column.depth} and did not surface `
                + `(${climb.reason}) — bot at y=${bot.entity.position.floored().y}, took ${gained}x ${YIELD_ITEM}`);
            return _routeResult(payload, false,
                `${TAG}: took ${gained}x ${YIELD_ITEM} but did not climb out (${climb.reason})`);
        }

        if (bottom.y !== column.standFeetY) {
            watcher.warn(TAG, `descent stopped at y=${bottom.y}, wanted y=${column.standFeetY} `
                + `(${descent.reason || 'unknown'}, ${descent.dug} dig(s)) `
                + `— took ${gained}x ${YIELD_ITEM} of ${asked} asked`);
        }

        // The column gave up its run and the body is back on the surface: it was workable, so it leaves
        // the spent list. Only a full trip clears it — a short descent that still climbed out is a
        // column that cannot be worked to its resting block, which is precisely what the list is for.
        if (bottom.y === column.standFeetY) capsule.failed_columns = spent;

        releaseTarget(heldKeys);
        const readable = `${TAG}: ${gained}x ${YIELD_ITEM} from ${column.x},${column.z} `
            + `(asked ${asked}, shaft ${column.depth} deep, sealed ${climb.placed})`;
        watcher.summary(TAG, readable);
        // True against the asker's number, not this verb's own idea of a good trip (Law 25): a full run
        // that still falls short of a large order is a partial, so supply_manager can dispatch a second
        // column instead of crafting against stock that is not there.
        return _routeResult(payload, gained >= asked, readable);
    }),
};
