// fragment: stone_prospect_executor (action / stone acquisition)
// purpose: ONE verb (Law 0) — take a fixed run of stone out of a single surface column and seal the
//          column behind you. It is the producer supply_manager dispatches when a shortfall
//          decomposes to cobblestone, the way harvest_executor is the producer for logs.
//
// ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────────────────────
// Cobblestone used to have exactly one source in this fleet: the headframe's descent. That descent
// cannot post until a base is sited and its staircase located, so everything downstream of stone
// inherited the wait — no furnace, therefore no charcoal, therefore no torch; and the sword's stone
// tier floor meant no weapon either. A unit whose orders never include a mine had no route to any of
// it. This verb removes the coupling: stone is abundant at nearly every surface XZ, so a bot that
// needs some digs for it where it stands.
//
// ── WHY A COLUMN, AND WHY IT IS SEALED ────────────────────────────────────────────────────────────
// A 1-wide shaft dug to a fixed depth and filled on the way out is the least the world has to give up
// for the material: it is a smaller excavation than a chamber yielding the same haul, it leaves no
// unlit cavity for anything to spawn in, and — the part that decides the design — it needs NO MEMORY.
// The bot never leaves the shaft, so the way out is the cell it is standing in. A chamber-and-return
// shape has to remember where its exit was, and that remembered position must survive a dig loop, a
// preemption and a death to be worth anything (Invariant B; Law 2).
//
// ── THE THREE THINGS THAT MUST BE TRUE BEFORE THE FIRST DIG (Law 13, default stopped) ─────────────
// A pickaxe, enough sealing material, and a column that the scanner has already walked to its resting
// block. Every one of them is unrecoverable at the bottom of the shaft, which is precisely why none of
// them is checked there. Discovering a missing pickaxe nine blocks down is discovering it in the one
// place the bot cannot act on it.
//
// ── DESCENT IS BORROWED, NOT REBUILT (Law 16) ─────────────────────────────────────────────────────
// The bot sinks the shaft through locomotion, which owns the only dig-down in the fleet and hardens each
// step for itself: it refuses to dig a floor whose landing is not a safe solid, so the resting block the
// scanner verified in advance is re-verified per step by the party doing the digging (Invariant B — the
// scan is a plan, the step is a sensing). Nothing here digs. The stone arrives BECAUSE the descent passes
// through it: nine dig-downs through `stone` is nine cobblestone, so the harvest and the travel are one
// act rather than two.
//
// THE VERB IS `descendColumn`, NOT `goTo` (Architect 2026-08-31 — *"right now it does a little bit of
// both"*). This verb is vertical at both ends: the scanner proves ONE column and the ascent pillars back
// up ONE column. The middle used to be an ordinary route to the bottom cell, and a route search owes
// nothing to a column — `dig_down` and `dig_climb_down` are priced identically, so a single refused
// vertical step sent the body diagonally out of the scanned XZ, through walls nothing had checked. No
// cost can fix that: staying in a column is a constraint and a search only knows prices (Law 27).
// `descendColumn` loops the same hardened dig-down and adds exactly one rule — the body may not move in
// X or Z — so the shaft is 1-wide by construction rather than by preference.
//
// ── ONE COLUMN, ONE BOT (Invariant D) ─────────────────────────────────────────────────────────────
// A column is a world OBJECT, and two bots digging the same one is the same failure as two bots felling
// the same tree: the second arrives at a shaft already open, reads a surface that has moved under it,
// and descends into the first one's hole. So it is claimed the way a tree is — object exclusivity
// through the overseer, keyed on the column itself rather than on the bot, chosen at EXECUTION time
// from live perception because a planning token cannot name a column nothing had scanned yet.
//
// CLAIM BEFORE THE WALK, and release the moment the walk fails. Claiming after arrival is the race the
// claim exists to close — two bots both walking, both arriving, one of them holding nothing. A claimed
// column the body cannot reach is released and the next candidate tried, which is why the scanner
// returns a ranked list rather than a winner.
//
// ── SPENT-COLUMN MEMORY (the tree feller's spent-tree list, one material over) ─────────────────────
// A column the bot reached and opened but could not work — the descent stopped short of the resting
// block, or the climb never surfaced — is deterministically re-chosen on the next dispatch, because the
// scanner ranks nearest-first and a column that failed for a reason the scan cannot see is still the
// nearest. Neither judge catches it: the readable carries the column's coordinates, so every attempt
// reads as a different outcome and the identical-outcome counters never trip.
//
// THE LIST RIDES THE PAYLOAD CAPSULE, NOT A MODULE VARIABLE, and the lifetime is the point: it survives
// the manager↔judge retry loop within one job and RESETS on a fresh job_board dispatch (Law 12 — a new
// chain re-plans from current world state). A column that failed on a bad stance gets another attempt
// next job rather than being banned for the run, and nothing has to remember anything between signals.
//
// ── THE ASCENT NAMES ITS MATERIALS, AND THAT IS NOT AN OPTIMISATION ───────────────────────────────
// The fleet's canonical pillar order reaches MASONRY before SOIL, so a bot out of timber climbs out on
// the exact cobblestone it descended for and surfaces holding none of what it was sent for — a verb
// consuming its own product while still reporting success (Law 25). The filler list is therefore
// declared in config and passed explicitly; the fleet default is wrong HERE and right everywhere else,
// so the call site is where it is overridden rather than the group.

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
const overseerLink = require('@kernel/overseer_link');

const TAG = 'stone_prospect_executor';

// What the column actually yields. Mining `stone` with any pickaxe drops cobblestone — the run is
// gated on `stone` by the scanner precisely so this is the one thing a trip can produce, and the
// caller's order (cobblestone, or the `furnace_material` group the furnace recipe names) is satisfied
// by it either way.
const YIELD_ITEM = 'cobblestone';

// Keyed on the column, not the bot — the object is what is exclusive. The surface Y is in the key so a
// re-scan of the same XZ after the terrain moved is a different object, not a stale hold on this one.
function _columnKey(c) { return `stone_column:${c.x},${c.surfaceY},${c.z}`; }

function _fillerHeld(bot) {
    const items = bot.inventory?.items?.() || [];
    let n = 0;
    for (const it of items) {
        if (it && it.count > 0 && group_to_item.scaffold_spendable.includes(it.name)) n += it.count;
    }
    return n;
}

// NO dropOffHaul ON THE WAY OUT, unlike harvest_executor. A haul of logs is bulk headed for a chest;
// this haul is nine blocks the fleet is waiting to spend on a craft, and it sits under the
// cobblestone row's keep — banking it would walk it to a chest and then need it withdrawn again.
async function _routeResult(payload, success, readable) {
    if (success) portableJudge.done(TAG);
    const capsule = payload[TAG] || (payload[TAG] = {});
    capsule.success = success;
    capsule.readable = readable;
    payload.readable = readable;
    return routeToJudge(TAG, { ...payload });
}

// Concede rather than soft-fail when the trip is FUTILE from here — no column in range, or the
// preconditions this bot cannot fix by trying again. An identical zero-progress dispatch five times
// over is what the fleet judge reads as a stuck loop, so the concession carries its own judge
// (portable_judge, forgiving) exactly as harvest_executor's does: a fresh plan cycle is the correct
// first answer to "not from here", and repeated concessions still escalate.
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

        // ── PRECONDITION 1: a pickaxe. Same predicate mining_manager gates its own dispatch on, read
        // from its one home rather than restated (Law 16) — two answers to "may this bot mine" is how
        // a board and a fulfiller disagree into a loop.
        const { hasPickaxe } = require('@action/mining_manager.js');
        const pick = hasPickaxe(bot);
        if (!pick.ok) {
            // The board's own crafting_tool row makes pickaxes, so this clears itself; conceding
            // returns the bot to a plan cycle that will do exactly that.
            return _routeIdle(payload, `no pickaxe — cannot open a stone column (${pick.reason})`);
        }

        // ── PRECONDITION 2: enough to seal the shaft with. Checked here rather than at the bottom;
        // see the header.
        const filler = _fillerHeld(bot);
        if (filler < STONE_PROSPECT.filler_reserve) {
            return _routeIdle(payload,
                `sealing material short — hold ${filler}, need ${STONE_PROSPECT.filler_reserve} before descending`);
        }

        // ── PRECONDITION 3: a column that reaches its resting block, on no blueprint, that no peer
        // holds and that this body can actually stand on. Ranked nearest-first by the scanner; walked
        // in that order until one of them is all four things.
        const { columns } = stoneColumnScanner.scan(bot);
        if (!columns.length) {
            return _routeIdle(payload, 'no column within reach holds an uninterrupted stone run');
        }

        const capsule = payload[TAG] || (payload[TAG] = {});
        const spent = Array.isArray(capsule.failed_columns) ? capsule.failed_columns : [];

        const held0 = countInInventory(YIELD_ITEM, getBotInventory());

        let column = null, columnKey = null, peerHeld = 0, unreachable = 0, skipped = 0;
        for (const candidate of columns) {
            if (unreachable >= STONE_PROSPECT.max_approaches) break;
            const key = _columnKey(candidate);
            // Skipped BEFORE the claim: claiming a column this job has already proved unworkable takes
            // it away from a peer whose approach might succeed where this body's did not.
            if (spent.includes(key)) { skipped++; continue; }
            const claim = await overseerLink.requestClaim(key);
            if (!claim?.granted) { peerHeld++; continue; }

            // Stand on top of the column before opening it. goToStand converts "this block" into "the
            // cell above it", which is the one place the descent can begin from.
            const approach = await locomotion.goToStand({ x: candidate.x, y: candidate.surfaceY, z: candidate.z });
            const stood = bot.entity.position.floored();
            // ARRIVAL IS RE-SENSED, NEVER TRUSTED: goTo resolves successfully at the CLOSEST reachable
            // cell when the exact one is not reachable, so `arrived` alone would let the bot open a
            // shaft at whatever XZ it happened to stop at — a column nothing scanned (Law 25: a success
            // flag is not a measurement).
            if (approach?.arrived && stood.x === candidate.x && stood.z === candidate.z) {
                column = candidate; columnKey = key; break;
            }
            // Claimed but not reached: free it immediately so a peer standing nearer than this body can
            // take it. Holding it until the trip ends would make one bot's bad route another's outage.
            overseerLink.releaseClaim(key);
            unreachable++;
        }

        if (!column) {
            return _routeIdle(payload, `no reachable unclaimed column `
                + `(${columns.length} scanned, ${peerHeld} held by peers, ${unreachable} unreachable`
                + `${skipped ? `, ${skipped} spent this job` : ''})`);
        }

        watcher.summary(TAG, `opening column @${column.x},${column.z} — ${column.depth} deep `
            + `(${column.overburden} overburden + ${STONE_PROSPECT.stone_run} stone), sealing stock ${filler}`
            + `${skipped ? ` — skipped ${skipped} spent` : ''}`);

        // Marked spent BEFORE the work, not after. A trip that ends without reaching either exit path —
        // a preemption, a death, a signal killed mid-descent — writes nothing on the way out, and the
        // column that swallowed it is exactly the one the next dispatch must not re-open. Cleared below
        // on the one outcome that proves the column was workable.
        capsule.failed_columns = [...spent, columnKey];

        // ── THE DESCENT IS THE HARVEST. Every dig-down through the run drops one cobblestone, so
        // reaching the bottom cell and collecting the stone are the same act.
        //
        // STRAIGHT DOWN, IN THIS COLUMN, BY CONSTRUCTION (Architect 2026-08-31: *"either its fully
        // diagonal ... or a straight vertical shaft which uses trash and planks to extract the stone.
        // right now it does a little bit of both."*). This was `goTo({…, exact: true})` — an ordinary
        // route to the bottom cell — and a route search owes nothing to a column: `dig_down` and
        // `dig_climb_down` cost the same, so the first refused vertical step sent the body diagonally out
        // of the scanned XZ, through walls the scanner never checked, into a hole the pillar-out above was
        // not sized for. Both ends of this verb are vertical by design; the middle now is too.
        const descent = await locomotion.descendColumn({ x: column.x, z: column.z, toFeetY: column.standFeetY });
        await sleep(200);

        // A descent that stops short is NOT abandoned here, and that ordering is deliberate: the body is
        // in a hole either way, so the climb-out below runs on every path and the short haul is reported
        // afterwards, by the one warn that already existed for it — which now carries the descent's own
        // reason, so a short trip reads as "the shaft stopped, and why" rather than as a thin column.
        const bottom = bot.entity.position.floored();
        const gained = countInInventory(YIELD_ITEM, getBotInventory()) - held0;

        // Climb out FIRST and report SECOND, whatever the haul. A short haul is a supply outcome; a
        // bot left standing in a sealed-off hole is a stranded body, and the second must not wait on
        // the first being satisfactory.
        const climb = await _sealAndClimb(bot, column.surfaceY);

        // The claim is released once the body is out and the haul is counted, on every path below.
        // Law 8: whoever raised the lifecycle ends it. A signal killed mid-descent skips this, which is
        // what overseer_link's releaseAllClaims exists to sweep — it is not a reason to release early.
        if (!climb.out) {
            overseerLink.releaseClaim(columnKey);
            // Environmental, not a defect: the filler ran out or a placement was refused. Reported as
            // a failure with the reason attached rather than dressed as a partial success — the board
            // must be able to tell this apart from a completed trip (Law 25).
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

        overseerLink.releaseClaim(columnKey);
        const readable = `${TAG}: ${gained}x ${YIELD_ITEM} from ${column.x},${column.z} `
            + `(asked ${asked}, shaft ${column.depth} deep, sealed ${climb.placed})`;
        watcher.summary(TAG, readable);
        // TRUE AGAINST THE ASKER'S NUMBER, not against this verb's own idea of a good trip (Law 25).
        // A full run that still falls short of a large order is a partial, and saying so is what lets
        // supply_manager dispatch a second column instead of crafting against stock that is not there.
        return _routeResult(payload, gained >= asked, readable);
    }),
};
