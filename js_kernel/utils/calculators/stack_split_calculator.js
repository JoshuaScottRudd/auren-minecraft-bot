// Auren_Bot/js_kernel/utils/calculators/stack_split_calculator.js
// How to move exactly N items out of a stack in as few clicks as possible.
//
// Placing items one at a time scales linearly with the amount moved and stalls the bot at the
// destination for the duration; planning bulk moves first removes that scaling.
//
// The cost is click count, not latency. The mechanics offer two bulk moves:
//   left-click a stack, empty hand    → pick up ALL of it          (1 click, any size)
//   right-click a stack, empty hand   → pick up ceil(n/2)          (1 click, half)
//   left-click a destination, holding → drop the ENTIRE held stack (1 click, any size)
// A chunk of any size costs the same as a chunk of one; only placing one item at a time costs per-item,
// and this calculator's job is to shrink what is left to that path.
//
// Pure (Law 26): takes two integers and returns a plan, so it can be checked by running it — no window,
// no bot, no world. The caller owns the clicking. `preflight` loads it, so the throws below run on every
// change for free.
//
// Two strategies, both needed:
// HALVE-DOWN takes ceil(source/2) while that half still fits inside what is left to move, dropping each
//   chunk whole (2 clicks per chunk: take + drop).
// OVERSHOOT-AND-RETURN shift-clicks the WHOLE stack across (1 click) and hands back the difference.
// Neither dominates — at need=42/64 halve-down wins, at need=60/64 overshoot wins — so the calculator
// costs both in clicks and returns the cheaper.

'use strict';

// What a single right-click-to-place-one costs relative to a bulk click. Both are one clickWindow call,
// so this is 1 — the asymmetry is entirely in how many of them, never in the price of one.
const CLICK_COST = 1;

/**
 * Plan the cheapest click sequence to move exactly `need` items out of a stack holding `have`.
 *
 * Returns { strategy, chunks, singles, clicks, returns } where:
 *   strategy 'whole'     — need === have; one shift-click moves the lot.
 *   strategy 'halve'     — take each chunk in `chunks` (in order) and drop it whole, then place
 *                          `singles` items one at a time.
 *   strategy 'overshoot' — move the whole stack across, then hand `returns` items back one at a time.
 * `clicks` is the modelled cost, and it is what the two strategies were compared on.
 */
function planStackSplit(have, need) {
    if (!Number.isInteger(have) || !Number.isInteger(need)) {
        throw new Error(`CODING VIOLATION (Law 13): planStackSplit needs integers, got have=${have} need=${need}.`);
    }
    if (have <= 0 || need < 0) {
        throw new Error(`CODING VIOLATION (Law 13): planStackSplit called with have=${have} need=${need}; a stack to split from must be positive and a need cannot be negative.`);
    }
    if (need > have) {
        throw new Error(`CODING VIOLATION (Law 13): planStackSplit asked for ${need} out of a stack of ${have}. Splitting cannot invent items — the caller must clamp to what the slot holds.`);
    }

    if (need === 0)    return { strategy: 'none',  chunks: [], singles: 0, returns: 0, clicks: 0 };
    if (need === have) return { strategy: 'whole', chunks: [], singles: 0, returns: 0, clicks: 1 };

    // ── Strategy A: halve down, then singles ──
    const chunks = [];
    let remaining = need;
    let source = have;
    while (remaining > 0 && source > 0) {
        const half = Math.ceil(source / 2);
        if (half <= remaining) { chunks.push(half); remaining -= half; source -= half; continue; }
        if (source <= remaining) { chunks.push(source); remaining -= source; source = 0; continue; }
        break;   // every remaining bulk chunk overshoots — the rest goes one at a time
    }
    // 2 clicks per chunk (take it, drop it), 1 per single.
    const halveClicks = chunks.length * 2 + remaining * CLICK_COST;

    // ── Strategy B: send it all, hand back the difference ──
    // 1 shift-click out, then pick the destination stack up and return (have - need) singles, plus the
    // click that puts the held remainder back. Cheapest exactly when the need is most of the stack.
    const returns = have - need;
    const overshootClicks = 1 + 1 + returns * CLICK_COST + 1;

    if (overshootClicks < halveClicks) {
        return { strategy: 'overshoot', chunks: [], singles: 0, returns, clicks: overshootClicks };
    }
    return { strategy: 'halve', chunks, singles: remaining, returns: 0, clicks: halveClicks };
}

/**
 * What the pre-existing path would have cost for the same move, so a caller can log the saving. That
 * path picked the stack up, placed `need` items one at a time, and put the remainder back: 2 bulk
 * clicks plus one click per item.
 */
function naiveClickCost(need) {
    if (!Number.isInteger(need) || need < 0) {
        throw new Error(`CODING VIOLATION (Law 13): naiveClickCost needs a non-negative integer, got ${need}.`);
    }
    return need === 0 ? 0 : 2 + need * CLICK_COST;
}

module.exports = { planStackSplit, naiveClickCost };
