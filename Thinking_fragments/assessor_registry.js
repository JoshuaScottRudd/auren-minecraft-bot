// assessor_registry — WHICH ASSESSORS EXIST, AND IN WHICH TWO ORDERS THE SWEEP USES THEM.
//
// job_board was one file holding thirteen assessments and the sweep that ran them. The assessments are
// what grows — the Architect adds jobs — and the sweep is what does not, so they are separated along
// the axis that actually moves. Every assessor is now its own file under `assessors/`, with its own
// commentary beside its own code, and this module is the manifest.
//
// WHY A MANIFEST AND NOT A DIRECTORY SCAN. `fragment_registry`'s header states the rule this follows:
// requiring every member at load means a missing or broken one crashes at boot, naming itself, instead
// of failing the first time something routes to it. A `readdirSync` would also make the two orderings
// below impossible to state, and it would silently enlist a file someone left in the folder.
//
// ── THE TWO ORDERS, WHICH ARE GENUINELY TWO (Law 18) ────────────────────────────────────────────────
// The old sweep carried both as hand-typed lists and nothing checked that they agreed. They run
// counter-directionally on purpose:
//
//   EVALUATE  stable → urgent.  The order assessments are RUN in. It matters because assessments are
//             not all independent: they read shared world state, and one of them (building) computes
//             the material shortfall that mining's pull is derived from.
//   ASSEMBLE  urgent → stable.  The order jobs are CONCATENATED in, and therefore the order equals are
//             PRINTED in — it decides nothing about what is claimed. Equals are picked at random by the
//             dispatcher, so this is where Law 18's phasing is visible to a reader rather than where a
//             tie is settled. It used to settle one; that tiebreak is deleted.
//
// Reordering EVALUATE to "match" ASSEMBLE would silently break the phasing, which is exactly why the
// old sweep carried a comment begging the reader not to. Now the two are declared apart, named for what
// each one decides, and checked against each other below.
//
// ── THE CHECKS, AND WHAT EACH ONE CATCHES ───────────────────────────────────────────────────────────
// Every fault here produces a board that is quietly missing work rather than one that throws, which is
// the failure shape this fleet is worst at reading — a job that is never posted looks exactly like a job
// whose conditions were never met. So the manifest is checked at require time, in every process.
'use strict';

const mining        = require('@thinking/assessors/mining');
const building      = require('@thinking/assessors/building');
const supply        = require('@thinking/assessors/supply');
const furnace       = require('@thinking/assessors/furnace');
const exploration   = require('@thinking/assessors/exploration');
const baseLayout    = require('@thinking/assessors/base_layout');
const woodPreference= require('@thinking/assessors/wood_preference');
const hunger        = require('@thinking/assessors/hunger');
const farming       = require('@thinking/assessors/farming');
const lighting      = require('@thinking/assessors/lighting');
const canopy        = require('@thinking/assessors/canopy');
const respawn       = require('@thinking/assessors/respawn');
const groundSalvage = require('@thinking/assessors/ground_salvage');
const contractorHouse = require('@thinking/assessors/contractor_house');

// RESPAWN IS NOT IN EITHER ORDER, and that is what it means rather than an omission. It is a GATE on the
// whole board: a dead bot posts respawn_recover and nothing else, so it does not compete with the
// assessors — it decides whether any of them run at all. Listing it among them would make it one
// assessment of thirteen, which is the reading the sweep's dead-bot short circuit exists to refuse.
// job_board calls it directly, ahead of the loop.
const GATE = respawn;

// EVALUATE — stable → urgent (Law 18). The order assessments RUN in.
// contractorHouse sits beside `building` in both orders because it answers the same question about a
// different structure. Its position among the others decides nothing about what is claimed — the band
// and the rung do that — so what it must not do is drift AWAY from `building`, where a later reader
// would stop recognising the two as one kind of work.
const EVALUATE_ORDER = [
    hunger, mining, building, contractorHouse, supply, furnace, exploration,
    baseLayout, woodPreference, farming, lighting, canopy, groundSalvage,
];

// ASSEMBLE — urgent → stable (Law 18). The order jobs are CONCATENATED in, which survives into the
// printed board because the display sort is stable. It breaks no ties: equals are picked at random.
const ASSEMBLE_ORDER = [
    hunger, groundSalvage, exploration, baseLayout, woodPreference, supply,
    furnace, building, contractorHouse, mining, farming, lighting, canopy,
];

// 1. THE CONTRACT. An assessor that exports the wrong shape would throw deep inside the sweep, on a
//    line that reads as the sweep's fault rather than the file's — and only when the sweep next ran.
for (const a of [GATE, ...EVALUATE_ORDER]) {
    if (!a || typeof a.name !== 'string' || !a.name) {
        throw new Error('CODING VIOLATION (Law 13): an assessor in assessor_registry exports no `name`. '
            + 'Every assessor module exports { name, assess } — the name is what the sweep reports it by.');
    }
    if (typeof a.assess !== 'function') {
        throw new Error(`CODING VIOLATION (Law 13): assessor '${a.name}' exports no \`assess\` function. `
            + 'Every assessor module exports { name, assess }.');
    }
}

// 2. ONE NAME, ONE ASSESSOR (Law 16). Two files claiming a name makes the sweep's report ambiguous and
//    hides which of the two actually posted a job.
const seen = new Set();
for (const a of [GATE, ...EVALUATE_ORDER]) {
    if (seen.has(a.name)) {
        throw new Error(`CODING VIOLATION (Law 13): two assessors both call themselves '${a.name}'.`);
    }
    seen.add(a.name);
}

// 3. THE TWO ORDERS HOLD THE SAME SET — the check that makes carrying two lists safe, and the reason
//    they may be carried at all. An assessor in EVALUATE but not ASSEMBLE is the worst outcome available
//    here: it RUNS every sweep, does its scans, computes its jobs, contributes its pull, and then its
//    jobs are silently dropped on the floor because nothing concatenates them. Nothing throws, nothing
//    is reported, and the board simply never offers that kind of work again. The reverse — in ASSEMBLE
//    but not EVALUATE — throws on the first sweep instead, which is survivable, but it is checked here
//    so that it never gets that far.
const evalNames = new Set(EVALUATE_ORDER.map(a => a.name));
const asmNames = new Set(ASSEMBLE_ORDER.map(a => a.name));
for (const a of EVALUATE_ORDER) {
    if (!asmNames.has(a.name)) {
        throw new Error(`CODING VIOLATION (Law 13): assessor '${a.name}' is in EVALUATE_ORDER but not in `
            + 'ASSEMBLE_ORDER, so it would be run every sweep and its jobs discarded without a word.');
    }
}
for (const a of ASSEMBLE_ORDER) {
    if (!evalNames.has(a.name)) {
        throw new Error(`CODING VIOLATION (Law 13): assessor '${a.name}' is in ASSEMBLE_ORDER but not in `
            + 'EVALUATE_ORDER, so the sweep would assemble a result it never produced.');
    }
}
if (ASSEMBLE_ORDER.length !== EVALUATE_ORDER.length) {
    throw new Error('CODING VIOLATION (Law 13): EVALUATE_ORDER and ASSEMBLE_ORDER differ in length, so one '
        + 'of them lists an assessor twice.');
}

// 4. THE GATE IS NOT AN ASSESSOR. If respawn were added to the orders it would post its job alongside
//    the others instead of instead of them, and a corpse would be handed mining work.
if (evalNames.has(GATE.name)) {
    throw new Error(`CODING VIOLATION (Law 13): the board gate '${GATE.name}' is also listed as an ordinary `
        + 'assessor. It runs BEFORE the others and replaces them; listing it among them would let a dead '
        + 'bot be offered work it cannot do.');
}

module.exports = { GATE, EVALUATE_ORDER, ASSEMBLE_ORDER };
