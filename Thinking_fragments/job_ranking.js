// job_ranking — where a posted job's POSITION comes from, and the only place it comes from.
//
// A job's position is two names — which band is waiting on it, and how far from done it is (Invariant
// C). Everything that agrees on both is EQUAL, and the dispatcher picks among equals at random. A real
// dependency between jobs belongs to a GATE, which holds a job and names what it waits on; position never
// encodes a dependency.
//
// ── WHY THIS IS A MODULE AND NOT A LINE ON THE BOARD ──────────────────────────────────────────────
// An assessor declares a `job_type` and nothing about its own scheduling weight (Invariant D): it knows
// what the work IS, and only the board can know what the work is worth against everything else offered in
// the same sweep. This module answers that one question, and it is the only place that does.
//
// ── THE TWO COORDINATES ───────────────────────────────────────────────────────────────────────────
// A rank is (WHO IS WAITING, HOW FAR FROM DONE) — the four askers, and the three stages sorted backwards.
// Both are authored in architect_config's JOB_TYPES and measured here, per sweep, from the world.
//
// ── NOTHING BELOW MEASURES ANYTHING TWICE ─────────────────────────────────────────────────────────
// The stage is a read of work the sweep already did — the same walk to a job's remaining ROOTS that the
// gates already perform. Nothing is re-derived and no new sensing is added (Law 16, Law 22 gate 2). A
// future stage that needs a fact the gates do not already produce belongs on the GATE's verdict, read
// here — never a second walk.

'use strict';

const inventoryLens = require('@kernel/inventory_lens');
const {
    JOB_TYPE,
    JOB_CATEGORY_OF,
    JOB_STAGE_OF,
    CATEGORY_NAMES,
    CATEGORY_INDEX,
    PRE_BAND,
    PRE_BAND_MEMBERS,
    STAGES,
    STAGE_INDEX,
    STRUCTURE_PRIORITY,
} = require('@thinking/architect_config');

// ── SITE RANK — THE THIRD NAME, A FRACTAL OF THE FIRST ──────────────────────────────────────────────
// Within the build band, a body prefers the laydown yard, then the mineshaft, then the castle. It is the
// same mechanism as the pre-band, one level in: an authored sequence read in order, not a tiebreak,
// because the sites it orders are not equal. A site rank is a THIRD NAME, never a number, and nothing is
// composed from the three.
//
// IT PREFERS AND NEVER PREVENTS. `selectBand` falls straight through to the next site when the preferred
// one offers nothing claimable this sweep, so no body is left idle in front of work it could do (Law 27:
// a property of the job, enacted once, with no enforcer).
//
// A JOB WITH NO STRUCTURE STAMP RANKS LAST WITHIN ITS BAND. Most blueprint work names its site; work that
// does not is genuinely site-less (a standing shelf level) and yields to a named site. It is not an
// error, so it does not throw, but `Infinity` keeps it from sorting ahead of the alpha structure by
// accident of being unstamped.
function measureSiteRank(job) {
    if (!job || typeof job.structure !== 'string' || !job.structure) return Infinity;
    const order = STRUCTURE_PRIORITY[require('@kernel/bot_mandate').currentMode()] || [];
    const at = order.indexOf(job.structure);
    return at === -1 ? Infinity : at;
}

// ── STAGE ─────────────────────────────────────────────────────────────────────────────────────────
// Three questions, asked in this order:
//
//   1. Would finishing this require going OUT for something?      → gather
//   2. Does the finished thing already exist within reach?        → build
//   3. Otherwise everything it needs is reachable                 → craft
//
// GATHER IS TESTED FIRST because it is the only one of the three that can be true alongside another. A
// job can simultaneously have some of its output banked and still be short at the leaves; asking "is any
// of it here" first would call that a build and rank a half-supplied order above a fully-supplied one.
// The trip is what decides the rung, so the trip is the first question.
//
// THE POOL IS THE FLEET'S, NOT THE BOT'S: the stage is a property of the WORK. A rank is published on ONE
// board every bot reads, so a stage measured against the assessing bot's own pocket would rank the same
// job differently depending on who swept (Law 25). Whether the material is in the right hands is a
// fulfilment question, answered by the manager that receives the job.
function measureStage(job) {
    const declared = JOB_STAGE_OF[job.job_type];
    // `null` and `undefined` are different declarations. `null` is the pre-band's authored stage-less
    // marker — architect_config enforces null only for pre-band entries at load. `undefined` means
    // measure it. Reading a present null as an absent field would send stage-less work into the walk
    // below, which throws for lacking a `what` it was never meant to carry (Law 13 — a declared field is
    // never re-interpreted; Law 10 — null is a value, not a missing key).
    if (declared === null) return null;
    if (declared !== undefined) return declared;

    // An undeclared stage is an ASSERTION that this job can be measured, and only a job carrying a recipe
    // and a quantity can be. Reaching here without them means a job type was added to JOB_TYPES with no
    // stage and its assessor builds something the walk cannot read — a coding violation (Law 13).
    if (typeof job.what !== 'string' || !Number.isFinite(job.need)) {
        throw new Error(`[job_ranking] CODING VIOLATION (Law 13): job type "${job.job_type}" declares no stage in `
            + 'JOB_TYPES, so its stage must be measured — but the job carries no `what`/`need` to measure. '
            + `Got what=${job.what} need=${job.need} (id=${job.id}). Declare a \`stage:\` on the JOB_TYPES entry.`);
    }

    const roots = inventoryLens.rootsNeededFleetWide(job.what, job.need, job.at_destination);
    if (Object.keys(roots).length > 0) return 'gather';
    if (inventoryLens.reachableByFleet(job.what) >= job.need) return 'build';
    return 'craft';
}

// ── BAND IS ALWAYS THE AUTHORED BAND ─────────────────────────────────────────────────────────────────
// A job's band never changes at runtime; nothing lifts one job's band on the strength of another's. A bot
// short of material for its own pocket is served by `materials_wanted` (walked to every node of the
// recipe, not only its roots): the producing chain reads it as demand already sized to the order that
// created it and already owned by the bot that asked.

// ── ORDERING A SWEEP ──────────────────────────────────────────────────────────────────────────────
// Stamps every posted job with the two fields that ARE its position — `asker` and `stage`. Nothing
// further is derived from them; every consumer reads the field that was decided (Law 6).
//
// `asker`, NOT `category`: a supply job already carries a `category` naming its MANAGER routing class
// ('resource' / 'crafting'), a different question with a different owner. Two meanings on one field name
// is how a consumer reads the wrong one and never finds out (Law 7).
function orderSweep(posted) {
    for (const job of posted) {
        if (JOB_TYPE[job.job_type] === undefined) {
            throw new Error('[job_ranking] CODING VIOLATION (Law 13): a posted job carries no recognised '
                + `\`job_type\` (got ${JSON.stringify(job.job_type)}, id=${job.id}). Every assessor must set `
                + '`job_type: JOB_TYPE.<key>`; the board composes the rank from it.');
        }
        // ── A PULLED JOB STANDS WHERE ITS ASKER STANDS ────────────────────────
        // A tunnel seat is a means to another order's end and has no position of its own: its band and
        // site are the asking order's (`pulled_by`, stamped by assessors/mining), and its rung is gather.
        if (job.pulled_by) {
            if (JOB_CATEGORY_OF[job.pulled_by.job_type] === undefined) {
                throw new Error('[job_ranking] CODING VIOLATION (Law 13): a pulled job names an asker with no recognised '
                    + `job_type (got ${JSON.stringify(job.pulled_by.job_type)}, id=${job.id}).`);
            }
            job.asker = JOB_CATEGORY_OF[job.pulled_by.job_type];
            job.stage = 'gather';
            job.site_rank = measureSiteRank({ structure: job.pulled_by.structure });
            continue;
        }
        job.asker = JOB_CATEGORY_OF[job.job_type];
        job.stage = measureStage(job);
        job.site_rank = measureSiteRank(job);
    }
    return posted;
}

// ── SELECTION ─────────────────────────────────────────────────────────────────────────────────────
// THE ONLY PLACE ORDER IS DECIDED. Walk the bands (bot → blueprint → chest → busywork); inside the first
// band that has any work, walk the rungs (build → craft → gather); return the first non-empty group. What
// comes back is a SET OF EQUALS, not a winner — the caller picks one of them at random.
//
// THE PRE-BAND IS WALKED BY MEMBER, NOT BY RUNG. Its work produces nothing, so it has no stage to walk,
// and its members are genuinely ordered against each other — a dead bot respawns before it eats. That is
// the same mechanism one level in (an authored sequence read in order), not a tiebreak: a tiebreak
// separates things that are equal, and these are not.
//
// EVERY FALL-THROUGH THROWS. A job whose band is not in CATEGORY_NAMES, or whose rung is not in STAGES,
// was stamped by something other than orderSweep; returning it anyway would put unrankable work at the
// head of the board and nothing would say why (Law 13 — default stopped, never a plausible position).
function selectBand(jobs) {
    if (!jobs.length) return [];
    for (const band of CATEGORY_NAMES) {
        const inBand = jobs.filter(j => j.asker === band);
        if (!inBand.length) continue;
        const rungs = band === PRE_BAND ? PRE_BAND_MEMBERS : STAGES;
        const rungOf = band === PRE_BAND ? (j => j.job_type) : (j => j.stage);
        // ── THE SITE WALK SITS BETWEEN THE BAND AND THE RUNG ──────────────────
        // SITE IS THE OUTER LOOP: all of the yard's work outranks all of the mine's, so a body that
        // cannot place a yard block still prefers to GATHER for the yard over digging the shaft. An empty
        // site group costs one `continue` and the next site is tried in the same sweep.
        //
        // The pre-band is skipped: its members are genuinely ordered against each other (a dead bot
        // respawns before it eats) and none of them names a site.
        const sites = band === PRE_BAND
            ? [null]
            : [...new Set(inBand.map(j => j.site_rank))].sort((a, b) => a - b);
        for (const site of sites) {
            const atSite = site === null ? inBand : inBand.filter(j => j.site_rank === site);
            for (const rung of rungs) {
                const atRung = atSite.filter(j => rungOf(j) === rung);
                if (atRung.length) return atRung;
            }
        }
        throw new Error('[job_ranking] CODING VIOLATION (Law 13): job(s) in band '
            + `'${band}' carry no recognised rung — got ${JSON.stringify(inBand.map(rungOf))}. `
            + 'Every posted job is stamped by orderSweep; a rung outside the authored list means it was not.');
    }
    throw new Error('[job_ranking] CODING VIOLATION (Law 13): no posted job carries a recognised `asker` — '
        + `got ${JSON.stringify([...new Set(jobs.map(j => j.asker))])}, expected one of ${CATEGORY_NAMES.join(' | ')}.`);
}

// FOR DISPLAY ONLY — the board prints in the order a reader expects to read it; selection does not consult
// this. Two jobs at the same position compare equal and Array.prototype.sort is stable, so they print in
// assemble order (Law 18's phasing, still visible) while the dispatcher still treats them as equals.
function compareForDisplay(a, b) {
    const bandGap = CATEGORY_INDEX[a.asker] - CATEGORY_INDEX[b.asker];
    if (bandGap !== 0) return bandGap;
    if (a.asker === PRE_BAND) return PRE_BAND_MEMBERS.indexOf(a.job_type) - PRE_BAND_MEMBERS.indexOf(b.job_type);
    // The site walk is part of selection, so the printed order shows it too — a reader comparing the board
    // against what was claimed must see the same three names in the same order (Law 6).
    const siteGap = (a.site_rank ?? Infinity) - (b.site_rank ?? Infinity);
    if (Number.isFinite(siteGap) && siteGap !== 0) return siteGap;
    return STAGE_INDEX[a.stage] - STAGE_INDEX[b.stage];
}

// Renders one job's position as the two names it was measured as — the only rendering there is. A reader
// asking why one job beat another needs the two answers that decided it.
function describeBand(job) {
    if (JOB_CATEGORY_OF[job.job_type] === PRE_BAND) return PRE_BAND;
    // The site is named only where there is one, so a site-less job reads exactly as it did before.
    return job.structure ? `${job.asker}/${job.structure}/${job.stage}` : `${job.asker}/${job.stage}`;
}

module.exports = {
    orderSweep,
    selectBand,
    compareForDisplay,
    // measureStage is exported for the decision bench, which asks it directly. It is NOT a second entry
    // point for the fleet: the board calls orderSweep and nothing else (Law 16).
    measureStage,
    describeBand,
};
