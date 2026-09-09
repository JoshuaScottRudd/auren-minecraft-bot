// job_ranking — where a posted job's POSITION comes from, and the only place it comes from.
//
// THERE IS NO RANK AND NO NUMBER. A job's position is two names — which band is waiting on it, and how
// far from done it is — and nothing is composed from them. Everything that agrees on both is EQUAL, and
// the dispatcher picks among equals at random. The deleted mechanism packed the pair into an integer
// with a per-job-type tiebreak in its low digits, and the tiebreak was a running counter over the
// authored arrays: a job type's POSITION IN A FILE decided fleet scheduling, silently, and enforced real
// dependencies nothing could read (a pickaxe-less bot was kept off rock by array order alone). Every
// dependency that number was carrying is a GATE now — a gate holds a job and names what it waits on;
// an ordinal holds it and says nothing (Invariant C).
//
// ── WHY THIS IS A MODULE AND NOT A LINE IN THE BOARD ──────────────────────────────────────────────
// The board used to sort jobs by a number each assessor wrote onto its own job. That put the ranking
// decision in fourteen places and made every assessor a co-author of fleet-wide scheduling policy — so a
// job's position was decided by whichever assessor happened to build it, using a table it read directly.
// The assessor knows what the work IS; only the board can know what the work is worth against everything
// else offered in the same sweep. Splitting those is Invariant D: an assessor now declares a `job_type`
// and nothing else, and this module answers the one question the board owns.
//
// ── THE TWO COORDINATES ───────────────────────────────────────────────────────────────────────────
// A rank is (WHO IS WAITING, HOW FAR FROM DONE) — the four askers, and the three stages sorted
// backwards. Both are authored in architect_config's JOB_TYPES; both are MEASURED here, per sweep, from
// the world rather than read off a fixed table. The whole argument for the model lives beside that
// table; what lives here is why each measurement is legitimate.
//
// ── NOTHING BELOW MEASURES ANYTHING TWICE ─────────────────────────────────────────────────────────
// The stage is a read of work the sweep already did — a walk this fleet was already walking for the
// gates (a job's remaining ROOTS, what it would have to go out for). Nothing is re-derived and no new
// sensing is added, which is what keeps this a reading of an existing decision rather than a second
// scheduler beside the first (Law 16, Law 22 gate 2). If a future stage needs a fact the gates do not
// already produce, add it to the GATE's verdict and read it here — never open a second walk.

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
} = require('@thinking/architect_config');

// ── STAGE ─────────────────────────────────────────────────────────────────────────────────────────
// Three questions, asked in this order, and the order is the definition rather than an optimisation:
//
//   1. Would finishing this require going OUT for something?      → gather
//   2. Does the finished thing already exist within reach?        → build
//   3. Otherwise everything it needs is reachable                 → craft
//
// GATHER IS TESTED FIRST because it is the only one of the three that can be true alongside another. A
// job can simultaneously have some of its output banked and still be short at the leaves; asking "is any
// of it here" first would call that a build and rank a half-supplied order above a fully-supplied one.
// The trip is what actually decides the rung, so the trip is the first question.
//
// THE POOL IS THE FLEET'S, NOT THE BOT'S, and that is what makes the stage a property of the WORK rather
// than of whoever happened to run the sweep. A rank is published on ONE board that every bot reads, so a
// stage measured against the assessing bot's pocket would rank the same job differently depending on who
// swept — the board would say something true about one body and false about the fleet it is addressing
// (Law 25). Whether the material is in the right hands is a fulfilment question and is answered by the
// manager that receives the job.
function measureStage(job) {
    const declared = JOB_STAGE_OF[job.job_type];
    // `null` and `undefined` are DIFFERENT DECLARATIONS and collapsing them is what this line prevents.
    // `null` is the pre-band's authored "this work occupies no stage" — architect_config enforces
    // null ⟺ pre-band at load, so nothing else can reach here with it. `undefined` is "measure it".
    // Reading a present `null` as an absent field sends work that produces no item into the walk below,
    // where it throws for lacking a `what` it was never supposed to have (Law 13 — a declared field is
    // never re-interpreted; Law 10 — null is a value, not a missing key).
    if (declared === null) return null;
    if (declared !== undefined) return declared;

    // An undeclared stage is a promise that this job can be measured, and only a job carrying a recipe
    // and a quantity can be. Reaching here without them means a job type was added to JOB_TYPES with no
    // stage and its assessor builds something the walk cannot read — a coding violation, and one that
    // would otherwise land as a silently mis-ranked job rather than as an error (Law 13).
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

// ── ASKER PROMOTION ─ DELETED 2026-08-27, AND ITS ABSENCE IS THE POINT ───────────────────
// `measureAskers` read the gates' `shortOf` verdicts and moved a producer job into the band of whoever
// was held waiting on it. It is gone, and nothing replaces it: a job's band is its authored band, always.
//
// IT DEFEATED THE ONE ORDER THE BAND WALK EXISTS TO ENFORCE. The bands are bot → blueprint → chest →
// busywork, which says the bot's own pocket comes first, then the building, then storage. Promotion let
// a CHEST job be lifted into the bot band on the strength of a held bot job — so storage work ran ahead
// of an unfinished structure, which is precisely the sequence the walk was authored to prevent. An
// ordering rule with a mechanism that can suspend it is two rules, and the fleet obeyed the weaker one.
//
// AND THE PROMOTED JOB WAS STILL SOMEONE ELSE'S. Promotion set the band and nothing else, so the job kept
// the producing row's SIZE and DESTINATION. A bot short of a few units for its own pocket promoted the
// chest's row for that material, ran it at the chest's much larger batch, and delivered the whole batch
// to the chest — the bot paid the full input cost, its pocket ended empty, and the job the promotion was
// meant to serve still could not be filled. Rank was transferred; quantity and ownership were not, and
// there was no field on a gate verdict for them to be transferred through (Law 10 — the contract never
// carried a quantity).
//
// THE FAILURE IT WAS BUILT AGAINST IS REAL AND IS SOLVED ELSEWHERE. A bot held short of a material with
// no stock row of its own does not need a borrowed row: the board publishes what every live order still
// wants (`materials_wanted`, walked to every node of the recipe rather than only its roots), the producing
// chain reads that record as its order, and the dumper reads it to stop banking what an order is waiting
// on. Demand is derived from the orders that exist, so it is already the right size and already owned by
// the bot that asked — the two things promotion could not transfer. A row is the wrong shape for a need
// that changes every sweep.

// ── ORDERING A SWEEP ──────────────────────────────────────────────────────────────────────────────
// Stamps every posted job with the two fields that ARE its position — `asker` and `stage`. Nothing
// further is derived from them; they are read directly wherever order matters.
//
// THE FIELDS ARE NOT DEBUG OUTPUT; THEY ARE THE POSITION. A derived number with no stated derivation is
// strictly less inspectable than the hand-authored table it replaced: under a fixed table a reader could
// at least look the number up, and under a measured one there was nowhere to look. So the board reports
// the coordinates and every consumer reads the field that was decided (Law 6).
//
// `asker` RATHER THAN `category`: a supply job already carries a `category` naming its MANAGER routing
// class ('resource' / 'crafting'), which is a different question with a different owner. Two meanings on
// one field name is how a consumer comes to read the wrong one and never find out (Law 7).
function orderSweep(posted) {
    for (const job of posted) {
        if (JOB_TYPE[job.job_type] === undefined) {
            throw new Error('[job_ranking] CODING VIOLATION (Law 13): a posted job carries no recognised '
                + `\`job_type\` (got ${JSON.stringify(job.job_type)}, id=${job.id}). Every assessor must set `
                + '`job_type: JOB_TYPE.<key>`; the board composes the rank from it.');
        }
        job.asker = JOB_CATEGORY_OF[job.job_type];
        job.stage = measureStage(job);
    }
    return posted;
}

// ── SELECTION ─────────────────────────────────────────────────────────────────────────────────────
// THE ONLY PLACE ORDER IS DECIDED, and it decides it by reading two authored lists in order rather than
// by comparing anything. Walk the bands (bot → blueprint → chest → busywork); inside the first band that
// has any work, walk the rungs (build → craft → gather); return the first non-empty group. What comes
// back is a SET OF EQUALS, not a winner — the caller picks one of them at random, because a third fact
// used to break that tie and the third fact was a line number.
//
// THE PRE-BAND IS WALKED BY MEMBER, NOT BY RUNG. Its work produces nothing, so it has no stage to walk,
// and its members are genuinely ordered rather than interchangeable — a dead bot respawns before it eats.
// That is the same mechanism one level in (an authored sequence read in order), not a tiebreak: a
// tiebreak separates things that are equal, and these are not.
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
        for (const rung of rungs) {
            const atRung = inBand.filter(j => rungOf(j) === rung);
            if (atRung.length) return atRung;
        }
        throw new Error('[job_ranking] CODING VIOLATION (Law 13): job(s) in band '
            + `'${band}' carry no recognised rung — got ${JSON.stringify(inBand.map(rungOf))}. `
            + 'Every posted job is stamped by orderSweep; a rung outside the authored list means it was not.');
    }
    throw new Error('[job_ranking] CODING VIOLATION (Law 13): no posted job carries a recognised `asker` — '
        + `got ${JSON.stringify([...new Set(jobs.map(j => j.asker))])}, expected one of ${CATEGORY_NAMES.join(' | ')}.`);
}

// FOR DISPLAY ONLY — the board prints in the order a reader expects to read it, and selection does not
// consult this. Two jobs at the same position compare equal and Array.prototype.sort is stable, so they
// print in assemble order (Law 18's phasing, still visible) while the dispatcher still treats them as
// equals. Keeping the printed order stable and the CHOSEN one random is deliberate: a board that
// reshuffled every sweep would be unreadable, and a choice that always took the top line would reinstate
// the tiebreak this file exists without.
function compareForDisplay(a, b) {
    const bandGap = CATEGORY_INDEX[a.asker] - CATEGORY_INDEX[b.asker];
    if (bandGap !== 0) return bandGap;
    if (a.asker === PRE_BAND) return PRE_BAND_MEMBERS.indexOf(a.job_type) - PRE_BAND_MEMBERS.indexOf(b.job_type);
    return STAGE_INDEX[a.stage] - STAGE_INDEX[b.stage];
}

// Renders one job's position as the two names it was measured as. There is no other rendering — the
// integer this used to stand in for is gone, and a reader asking why one job beat another needs the two
// answers that decided it.
function describeBand(job) {
    return JOB_CATEGORY_OF[job.job_type] === PRE_BAND ? PRE_BAND : `${job.asker}/${job.stage}`;
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
