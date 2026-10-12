/*
yield_pledge_calculator.js — how much of an order one claim represents, computed once here because the
number is subtracted from a fleet-wide total and two answers would let an order be both over- and
under-subscribed at once. A pledge is one claim's worth — what one trip honestly brings back — carried on
the claiming body's magnet, not tracked here, so it expires with the work it represents.
*/

'use strict';

// One trip's worth of any gatherable material, in blocks. The one place the size of a pledge is stated.
const PLEDGE_BLOCK = 15;

// The trip yield for `what` if a trip brings it back (`isGatherable`, the same predicate `supply_manager._dispatchGather` gates a gather on — Law 16); undefined for a crafted or smelted good.
function tripYieldFor(what) {
    return require('@utils/calculators/build_material_calculator').isGatherable(what) ? PLEDGE_BLOCK : undefined;
}

// Seats an order can hold: size over one pledge, rounded up (Law 16 — the dispatcher admits bodies by the
// same arithmetic). One seat with no pledge or a whole-order pledge; null for a per-body order (`BAND_POLICY.goal !== 'fleet'`).
function seatsFor(job) {
    if (!carriesPledge(job)) return 1;
    if (job && job.asker) {
        const { BAND_POLICY } = require('@thinking/architect_config');
        if (BAND_POLICY[job.asker] && BAND_POLICY[job.asker].goal !== 'fleet') return null;
    }
    const p = pledgeFor(job, []);   // no peers: the order's OWN size, not what is left of it
    if (!p || !(p.amount > 0)) return 1;
    return Math.max(1, Math.ceil(job.need / p.amount));
}

// Whether `job` carries a pledge, sized from a supply order's quantity — a dig, descent or sweep has no countable deliverable to size one against (`scope` covers their exclusivity).
function carriesPledge(job) {
    if (!job || !(Number.isFinite(job.need) && job.need > 0)) return false;
    // A job may state its own pledge unit — a build divides by cell (see `pledgeFor`).
    if (Number.isFinite(job.pledge_unit) && job.pledge_unit > 0) return true;
    return job.type === 'supply'
        && typeof job.what === 'string' && job.what.length > 0;
}

// What this body pledges by claiming `job` — `{ job_id, what, amount }`, capped at what peers have not already pledged, or null if it carries none.
function pledgeFor(job, pledges = []) {
    if (!carriesPledge(job)) return null;
    // The order's own unit wins if it states one (a build's cell); otherwise the world's trip yield.
    const unit = Number.isFinite(job.pledge_unit) && job.pledge_unit > 0 ? job.pledge_unit : tripYieldFor(job.what);
    // No trip yield: the claim closes the order.
    const trip = unit === undefined ? job.need : unit;
    // Capped at what peers have not already pledged.
    const open = Math.max(0, job.need - pledgedAgainst(job, pledges));
    const amount = Math.min(trip, open || job.need);
    return { job_id: job.id, what: job.what, amount };
}

// Sum of every live pledge against this order's id, matched on `job_id` so it counts toward only its own order.
function pledgedAgainst(job, pledges) {
    if (!job || !Array.isArray(pledges)) return 0;
    let total = 0;
    for (const p of pledges) {
        if (p && p.job_id === job.id && Number.isFinite(p.amount) && p.amount > 0) total += p.amount;
    }
    return total;
}

// What remains unclaimed once every peer's pledge is deducted.
function stillOpen(job, pledges) {
    if (!carriesPledge(job)) return Infinity;
    return job.need - pledgedAgainst(job, pledges);
}

// ── THE WALK CALCULATOR: HOW LONG A TRIP STAYS OUT ────────────────────────────────────────────────
// The one answer to "has this trip paid for its walk", for every trip sized by distance (Law 16). A trip
// is the job the body holds plus the walk home. Its walking is every second the body has walked on the job,
// as its own clock measured it (bot_minutes, the open span), plus the walk home; the rest of the job is
// work. The body owes work out there until walking is WALK_LIMIT_PCT of the trip or less
// (walk_share_calculator, the same limit the run is judged on). The walk home is the flat distance at the
// body's own measured pace.
//   walkBlocks        flat blocks from where the body stands to where the trip ends
//   secondsPerBlock   the body's measured pace (locomotion_dispatcher.walkPace), null while unmeasured
//   span              the job's open span off the body's clock: { at_ms, held_ms, walk_ms }
// → { walk_s, elapsed_s, walked_s, owed_s, measured } — owed_s > 0 means the trip still owes work before it
//   turns home. An unmeasured pace or a body with no job open owes nothing and says so in `measured`.
function walkOwed(walkBlocks, secondsPerBlock, span) {
    if (!Number.isFinite(walkBlocks) || walkBlocks < 0) {
        throw new Error(`[yield_pledge_calculator] CODING VIOLATION (Law 13): walkOwed(${walkBlocks}, …) needs a walk in blocks.`);
    }
    const measured = Number.isFinite(secondsPerBlock) && secondsPerBlock > 0
        && !!span && span.kind === 'working' && span.held_ms >= 0 && span.walk_ms >= 0;
    if (!measured) return { walk_s: 0, elapsed_s: 0, walked_s: 0, owed_s: 0, measured: false };
    const homeMs = walkBlocks * secondsPerBlock * 1000;
    const share = require('@utils/calculators/walk_share_calculator').walkShare(span.walk_ms + homeMs, span.held_ms + homeMs);
    return {
        walk_s: Math.round(homeMs / 1000), elapsed_s: Math.round(span.held_ms / 1000),
        walked_s: Math.round(span.walk_ms / 1000), owed_s: Math.round(share.work_owed_ms / 1000), measured: true,
    };
}

// staysOut — a trip that owes work stays out while staying pays the debt down. Read at each point the trip
// may turn home; a reading that owes as much as the one before it on the same job, or more, means the
// ground here costs more walking than work, and the trip turns home with what it has.
//   site   which turning point is asking ('pledge', 'drop_off'): each compares against its own last reading,
//          since two of them read the same moment one after the other.
const _owedOn = new Map();   // site → { at_ms, owed_s }: the job's span and what it owed when that site last read
function staysOut(span, owed, site) {
    if (!owed.measured || !(owed.owed_s > 0)) { _owedOn.delete(site); return false; }
    const last = _owedOn.get(site);
    const before = last && last.at_ms === span.at_ms ? last.owed_s : null;
    _owedOn.set(site, { at_ms: span.at_ms, owed_s: owed.owed_s });
    return before === null || owed.owed_s < before;
}

module.exports = { PLEDGE_BLOCK, tripYieldFor, carriesPledge, pledgeFor, pledgedAgainst, stillOpen, seatsFor, walkOwed, staysOut };
