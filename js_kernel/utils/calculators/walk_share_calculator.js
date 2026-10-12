/*
walk_share_calculator.js — how much of a job's time went to walking, and how much more working that walk
has to be paid with. Computed once here because three readers ask it — the body at the end of each job,
the foreman's run verdict, and the walking lens — and three copies of the arithmetic would let one run
read as inside the limit and over it at once.
*/

'use strict';

// The most of a job's time that may go to walking, in percent. At the limit a body works one second at
// the end of a walk for every second it spent walking there and back.
const WALK_LIMIT_PCT = 50;

// The share for one stretch of time a body held work.
//   walkMs   milliseconds of it spent walking
//   heldMs   milliseconds the work was held, walking included
// Returns:
//   walk_ms, work_ms   the two halves of heldMs
//   walk_pct           walking as a percentage of heldMs; null where nothing was held
//   over               whether walk_pct is above WALK_LIMIT_PCT
//   work_owed_ms       the working time missing for this much walking to sit at the limit; 0 inside it
//   stay_factor        how many times longer the working half has to be to sit at the limit; null where
//                      there was no working half to multiply
function walkShare(walkMs, heldMs) {
    if (!(walkMs >= 0) || !(heldMs >= 0)) {
        throw new Error(`[walk_share_calculator] CODING VIOLATION (Law 13): walkShare(${walkMs}, ${heldMs}) `
            + 'needs the walking time and the held time, both in milliseconds and neither negative.');
    }
    const walk = Math.min(walkMs, heldMs);
    const work = heldMs - walk;
    const walkPct = heldMs > 0 ? (100 * walk) / heldMs : null;
    const workAtLimit = walk * (100 - WALK_LIMIT_PCT) / WALK_LIMIT_PCT;
    const over = walkPct !== null && walkPct > WALK_LIMIT_PCT;
    return {
        walk_ms: walk,
        work_ms: work,
        walk_pct: walkPct === null ? null : +walkPct.toFixed(1),
        over,
        work_owed_ms: Math.max(0, workAtLimit - work),
        stay_factor: work > 0 ? +(Math.max(workAtLimit, work) / work).toFixed(2) : null,
    };
}

// The fleet's share from each body's own clock — `[{ working_ms, walk_ms }]`. A body with no clock yet
// adds nothing to either side.
function fleetShare(clocks) {
    let walk = 0, held = 0, bodies = 0;
    for (const c of clocks || []) {
        if (!c || !(c.working_ms >= 0) || !(c.walk_ms >= 0)) continue;
        walk += c.walk_ms; held += c.working_ms; bodies++;
    }
    return { bodies, ...walkShare(walk, held) };
}

module.exports = { WALK_LIMIT_PCT, walkShare, fleetShare };
