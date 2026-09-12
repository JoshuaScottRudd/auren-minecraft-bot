'use strict';
// correction — LAW 13 AT THE HUMAN BOUNDARY: the third category, and the only one that fits a person.
//
// ── LAW 13'S THIRD CATEGORY ──────────────────────────────────────────────────────────────────────────
// This file implements CORRECTION, which is Law 13 and not a doctrine beside it. The law's one demand is
// that every failure states exactly what caused it; its categories differ only in who is told and what
// happens to the work. Two of them cannot be aimed at a person:
//   · A CODING VIOLATION throws. It means "this cannot happen in a correct system", and a human typing
//     `foreman request logs 20` is not a defect in anything. Throwing would kill the desk over somebody's
//     word order.
//   · An ENVIRONMENTAL FAILURE soft-fails to the judge for a replan. It means "the world moved". Nothing
//     moved here; the world is fine and the sentence was wrong, and there is nothing to replan because
//     no work was ever started.
//
// So the third category carries the same demand to a third audience. A CORRECTION (1) does not throw,
// (2) lets nothing cross — including a repaired or guessed version of the input, (3) states the true cause
// in the world's terms, and (4) carries the form that would have worked. 1-2 are the guard; 3-4 are the
// guide; a refusal missing either half is not a correction.
//
// THE CATEGORY IS CHOSEN BY WHERE THE INPUT CAME FROM, ASKED BEFORE THE OTHER TEST. A person's malformed
// sentence answers "no" to "could this happen in a correctly-written system in a normal world" — the
// system did not produce it — and is still not a bug. Asking the generator question first is what stops
// that test returning the wrong answer about input the system never authored.
//
// ── WHY THE BOUNDARY NEEDS ITS OWN FORM AT ALL (Law 26) ──────────────────────────────────────────────
// Everything else in this tree is machine talking to machine: two deterministic systems that stop a
// mistake by throwing on bad form. A person is the other category — a generator, with no throw, able to
// emit anything at all and still "complete". Law 26 says those two are never joined directly and that
// what goes between them is a TRANSLATOR MACHINE the mind builds: something that throws on bad form AND
// checks a claim against real world-state before anything crosses.
//
// THE FOREMAN IS THAT MACHINE, and this file is its outward voice. That is why the veil matters more than
// the wording: a malformed sentence stopped at the desk costs one reply, and the same sentence admitted
// into the fleet becomes a row in a ledger, a job on a board, and a crew walking somewhere for a reason
// nobody can reconstruct. Nothing unverified passes (Law 23), and what is refused is refused OUT LOUD.
//
// ── THIS FILE STILL THROWS — AT DEVELOPERS, NEVER AT PEOPLE ──────────────────────────────────────────
// A correction missing its `instead` is a refusal that teaches nothing, which is exactly the failure the
// law's third category exists to end — and it is a CODING violation, because a correct desk cannot emit
// one. So the constructor below throws on it: same law, the first category, because the party that got it
// wrong here is a machine and not a person. The rule this file enforces on humans is gentle; the rule it
// enforces on its own callers is not.

const TAG = 'correction';

// THE PREFIX IS READ, NEVER SPELLED. Every remedy below quotes a sentence the person is meant to type back,
// so each one is a second copy of the desk's own name — rename the desk and nine corrections would go on
// teaching a command that no longer works, silently, to the only people who cannot tell (Law 16: one answer
// to what this desk is called, and architect_config already holds it).
const { FOREMAN_PREFIX: PREFIX } = require('@thinking/architect_config');

// refuse({ code, said, because, instead }) → a correction. NEVER thrown, always returned.
//
// ALL THREE PARTS ARE REQUIRED and that is Law 13's demand at this boundary in one line:
//   · `said`    — what the person actually typed, quoted back, so they can see what was heard.
//   · `because` — the real reason, in the world's terms. Never "invalid input"; a reason that names the
//                 actual fact ("you already have 2 bots", "it needs string and nothing your crew does
//                 produces it") is what stops the next three attempts as well as this one.
//   · `instead` — the sentence that WOULD work. Without it a person guesses again, which is where a
//                 fuzzy matcher gets proposed as the fix for a problem that was really a missing sentence.
function refuse({ code, said, because, instead }) {
  for (const [field, value] of Object.entries({ code, because, instead })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`[${TAG}] CODING VIOLATION: a correction was built with no '${field}'. `
        + `A refusal that does not say what to do instead is not a correction, it is a wall — and the `
        + `law's whole claim here is that the desk is a guide as well as a guard. Fix the call site.`);
    }
  }
  return { ok: false, code, said: said == null ? '' : String(said), because, instead };
}

// allow(value) → the pass. Same shape both ways so a caller reads `.ok` and never has to know which
// branch it is on (Law 10 — one envelope, two outcomes).
function allow(value) { return { ok: true, value }; }

// render(correction) → the chat lines, in the order a person reads them.
//
// TWO LINES, NEVER MORE. The desk speaks into open chat where every line is also everybody else's, and a
// paragraph of explanation is how a person learns to ignore the desk entirely. The reason comes first
// because it is the part that stops the mistake repeating; the remedy second because it is what they do
// next. `said` is folded into the reason rather than given its own line — quoting it back matters, a line
// of its own does not.
function render(c) {
  return [
    c.said ? `'${c.said}' — ${c.because}` : c.because,
    c.instead,
  ];
}

// ── THE NAMED CORRECTIONS ────────────────────────────────────────────────────────────────────────────
// Every refusal a person can meet is constructed HERE rather than written inline at its call site, so the
// category is one file a reader can audit for whether it actually guides (Law 6 — inspectable) and so the
// desk's voice cannot drift into a different register verb by verb. A new refusal is a function here; a
// new sentence typed into foreman.js is the shape this file exists to prevent.

// ── THERE IS NOWHERE TO SEND ANYBODY ANY MORE (2026-09-06) ───────────────────────────────────────────
// Both refusals below used to end `say "foreman list" to see every name i take.` The `list` verb is gone
// (Architect: *"foreman help is now the list. so remove list."*), and an "instead" naming a word the desk
// refuses is the worse half of the two failure directions `foreman_vocabulary`'s page assertion guards —
// a person invited to say something that cannot work.
//
// WHAT REPLACES IT IS AN EXAMPLE, NOT A POINTER. `request 20 logs` is a request that actually succeeds
// and it fits the sentence it is in. It teaches
// the SHAPE, which is what a person who mistyped a name needs; it does not claim to be a catalogue,
// because there is no longer one and a refusal that implies otherwise is a second wrong turn (Law 25).
const TRY = `try a plain name — "${PREFIX} request 20 logs".`;

// The item is not a word the desk accepts. NOT phrased as a spelling accusation: the person may have
// invented a name that was never on offer, and telling them to check their spelling sends them looking
// in the wrong place (Law 25 — the verdict has to be true about the question they asked).
const notOnTheList = (said) => refuse({
  code: 'not_on_the_list',
  said,
  because: "your crew doesn't take that name",
  instead: TRY,
});

// A real name the fleet has no route to. Names the LEAF that stopped the walk, because "no" teaches a
// person nothing and they ask for the next thing made of the same material.
const cannotObtain = (said, blockedBy) => refuse({
  code: 'cannot_obtain',
  said,
  because: `your crew can't get that — it needs ${blockedBy}, and nothing they do produces it`,
  instead: TRY,
});

// A REAL NAME THE CREW CAN ALMOST HONOUR — right material, wrong grain (Architect 2026-09-06:
// *"you cant request specific logs. so foremen request 20 logs is the only possible."*).
//
// It is deliberately NOT `cannotObtain`. That refusal names the leaf that stopped a recipe walk, and no
// walk was stopped here — the crew fells wood constantly, they simply cannot be pointed at a species,
// because the canopy chain takes whatever is most abundant where it stands. Telling this person "your
// crew can't get that" would be false about the one thing they actually wanted, and they would stop
// asking for wood entirely (Law 25 — the verdict has to be true about the question they asked).
//
// So it carries the working form instead of a diagnosis, and the working form is a word they already
// half-typed.
const askByFamily = (said, family) => refuse({
  code: 'ask_by_family',
  said,
  because: `your crew takes whichever ${family} are most abundant where they are, so they can't promise `
         + 'you one kind',
  instead: `ask for the family — "${PREFIX} request 20 ${family}".`,
});

// The words are all real and the shape is wrong. Says what was seen AND the order it wants, because
// "incorrect format" without the format is the canonical un-guiding refusal.
const wrongFormat = (said, expected) => refuse({
  code: 'wrong_format',
  said,
  because: 'i could not read that as an order',
  instead: `the form is: ${expected}`,
});

// A quantity attached to a building. The reason is the interesting half: it is not that numbers are
// banned, it is that a building is not a countable thing here.
const buildingTakesNoNumber = (said, building) => refuse({
  code: 'building_takes_no_number',
  said,
  because: `a building isn't a quantity — there is one ${building} and your crew builds it once`,
  instead: `say "${PREFIX} request ${building}" with no number.`,
});

// A good with no quantity. The mirror of the above, and it must be as specific: a person who omits the
// number is usually copying the building form they just learned.
const goodNeedsANumber = (said, item) => refuse({
  code: 'good_needs_a_number',
  said,
  because: `${item} is a material, so i need to know how many`,
  instead: `say "${PREFIX} request 20 ${item}".`,
});

// A real structure that cannot be raised on its own. NOT a spelling answer — the person named a real
// building and spelled it correctly, so pointing them at the list to check their spelling sends them to the
// one place the fault is not.
//
// THE CAUSE IS ATTACHMENT, and saying so is the difference between this stopping one attempt and stopping
// the whole family of them. Most structures join another in a specific way and cannot be started from
// nothing; a person told that stops asking for the parts of things and asks for the thing.
const noPlanForThat = (said, raisable) => refuse({
  code: 'no_plan_for_that',
  said,
  because: 'that one is part of a larger build — it attaches to another structure, so it can\'t be started on its own',
  // THE REMEDY IS A SENTENCE, NOT A NAME. This one listed the raisable buildings and stopped, which reads
  // like a remedy and is not one: every other correction here ends in something the person can type, and
  // clause 4 asks for the FORM that would have worked. A bare name leaves them composing the line
  // themselves — which is where a person who has just been refused once decides to stop.
  instead: raisable.length === 1
    ? `say "${PREFIX} request ${raisable[0]}" — that is the one your crew can raise on its own.`
    : raisable.length
      ? `your crew can raise these on their own: ${raisable.join(', ')}. say "${PREFIX} request <name>", no number.`
      : `your crew cannot raise anything on its own yet — say "${PREFIX} list" for what they can fetch instead.`,
});

// The same building asked for twice while the first one is still going up. Carries the STAGE, because
// "you already asked" invites "yes, and nothing is happening" — the stage is the answer to that.
const alreadyUnderway = (said, building, stage) => refuse({
  code: 'already_underway',
  said,
  because: `your crew is already on the ${building} — it is at "${stage}"`,
  instead: `say "${PREFIX} request" on its own to watch it, or "${PREFIX} cancel ${building}" to call it off.`,
});

// Every bot the asker is allowed is already out. The named bots matter: a person with two bots they have
// forgotten about is helped by being told which ones.
const crewFull = (said, names, limit) => refuse({
  code: 'crew_full',
  said,
  because: `you already have ${names.length} of them — ${names.join(' and ')}${limit ? ` — and ${limit} is a crew` : ''}`,
  instead: `say "${PREFIX} stop" to send them home first.`,
});

// A verb aimed at bots the asker does not have. Kept here rather than inline so the ownership refusals
// read in the same voice as the request ones.
const noBotsOut = (said) => refuse({
  code: 'no_bots_out',
  said,
  because: 'you have no bots out',
  instead: `say "${PREFIX} get contractor" and I'll fetch you a crew.`,
});

// THE HOMESTEAD IS ALREADY STAFFED. The mirror of `crewFull`, and it is a separate refusal rather than a
// flag on that one because the two differ in the only part that matters: what the person does next.
// `crewFull` sends them to `stop`, which is theirs to say. Nobody can dismiss a homesteader from inside
// the world — that is what the species means, not a gap — so pointing there would be teaching a word that
// will not work (Law 25: the answer has to match the question asked).
//
// A HOMESTEAD IS THE WORLD'S, NOT A PERSON'S, which is why this counts everything rather than the
// asker's. Two homesteaders is the homestead; a second person asking for one is asking for the same
// thing, and gets told it already exists rather than given a second copy of it.
const homesteadFull = (said, names, limit) => refuse({
  code: 'homestead_full',
  said,
  because: `the homestead already has ${names.join(' and ')}${limit ? ` — and ${limit} is a crew` : ''}`,
  instead: `they answer to nobody, so say "${PREFIX} get contractor" for a crew that answers to you.`,
});

// `get` WITH NO SPECIES, OR WITH A WORD THAT IS NOT ONE. The one correction on the busiest verb, so it
// spends its whole budget on the difference a person is actually choosing between rather than on naming
// the two words again — the help page already lists the forms, and a refusal that only repeats the page
// teaches nothing the page did not (Law 13's third category: refuse AND teach).
//
// THE DIFFERENCE IS STATED AS WHO THEY OBEY, because that is the half a person cannot change afterwards
// and the half they will get wrong. Everything else about the two is identical by design — same door,
// same crew size, both brought to where you stand, both working on arrival.
const getNeedsASpecies = (said) => refuse({
  code: 'get_needs_a_species',
  said,
  because: 'I need to know who they answer to',
  instead: `"${PREFIX} get contractor" works for you — "${PREFIX} get homesteader" ignores you and builds.`,
});

module.exports = {
  refuse, allow, render,
  notOnTheList, cannotObtain, askByFamily, wrongFormat, buildingTakesNoNumber,
  goodNeedsANumber, noPlanForThat, alreadyUnderway, crewFull, noBotsOut, getNeedsASpecies,
  homesteadFull,
};
