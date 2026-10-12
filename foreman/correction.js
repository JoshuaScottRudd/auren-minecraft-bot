'use strict';
// correction — Law 13's third category: the refusal path aimed at a person, as distinct from the two
// aimed at machines.
//
// Law 13 requires every failure to state exactly what caused it; its categories differ in who is told and
// what happens to the work. A CODING VIOLATION throws — it means the system produced something that
// cannot happen in a correct build. An ENVIRONMENTAL FAILURE soft-fails to the judge for a replan — it
// means the world moved. Neither fits a person: a malformed sentence typed by someone is not a defect in
// the system, and nothing in the world moved to cause it.
//
// A CORRECTION therefore (1) does not throw, (2) lets nothing cross, including a repaired or guessed
// version of the input, (3) states the true cause in the world's terms, and (4) carries the form that
// would have worked. 1-2 are the guard; 3-4 are the guide; a refusal missing either half is not a
// correction.
//
// The category is chosen by where the input came from, asked before any other test: a person's malformed
// sentence was never authored by the system, so it is a correction whatever shape it takes.
//
// ── WHY THE BOUNDARY NEEDS ITS OWN FORM (Law 26) ─────────────────────────────────────────────────────
// Everywhere else in this tree is machine talking to machine, and a mistake is stopped by throwing on bad
// form. A person is a generator instead, able to emit anything and still "complete". Law 26 puts a
// translator machine between a generator and a deterministic system: something that throws on bad form
// and checks a claim against real world-state before anything crosses.
//
// The foreman is that machine, and this file is its outward voice: a malformed sentence stopped here costs
// one reply, and the same sentence admitted into the fleet becomes a row in a ledger, a job on a board, and
// a crew walking somewhere for a reason nobody can reconstruct. Nothing unverified passes (Law 23), and
// what is refused is refused out loud.
//
// ── THIS FILE THROWS AT DEVELOPERS, NEVER AT PEOPLE ──────────────────────────────────────────────────
// A correction missing its `instead` is a refusal that teaches nothing, so building one is a coding
// violation and the constructor below throws on it. The rule this file enforces on people is gentle; the
// rule it enforces on its own callers is not.

const TAG = 'correction';

// THE PREFIX IS READ, NEVER SPELLED. Every remedy below quotes a sentence the person is meant to type
// back, so each one carries the desk's own name from its one source, `architect_config` (Law 16).
const { FOREMAN_PREFIX: PREFIX } = require('@thinking/architect_config');

// refuse({ code, said, because, instead }) → a correction. Never thrown, always returned.
//
// All three fields are required, which is Law 13's demand at this boundary:
//   · `said`    — what the person actually typed, quoted back, so they can see what was heard.
//   · `because` — the real reason, in the world's terms, naming the actual fact (never "invalid input").
//   · `instead` — the sentence that would work, so the person has a next move instead of a guess.
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

// allow(value) → the pass. Same shape both ways so a caller reads `.ok` without knowing which branch it
// is on (Law 10).
function allow(value) { return { ok: true, value }; }

// render(correction) → the chat lines, in the order a person reads them.
//
// Two lines, never more, since the desk speaks into open chat where every line is also everybody else's:
// the reason first, because it stops the mistake repeating, then the remedy, which is what they do next.
// `said` is folded into the reason line.
function render(c) {
  return [
    c.said ? `'${c.said}' — ${c.because}` : c.because,
    c.instead,
  ];
}

// ── THE NAMED CORRECTIONS ────────────────────────────────────────────────────────────────────────────
// Every refusal a person can meet is constructed here, so the category is one file a reader can audit for
// whether it actually guides (Law 6) and the desk's voice stays consistent verb by verb.

// WHAT THE REMEDY OFFERS IS AN EXAMPLE, NOT A POINTER. `request 20 logs` is a request that actually
// succeeds and fits the sentence it is in — it teaches the shape a mistyped name needs, without claiming
// to be a catalogue (Law 25).
const TRY = `try a plain name — "${PREFIX} request 20 logs".`;

// The item is not a word the desk accepts. Not phrased as a spelling accusation: the person may have
// invented a name that was never on offer, and pointing them at spelling would send them looking in the
// wrong place (Law 25).
const notOnTheList = (said) => refuse({
  code: 'not_on_the_list',
  said,
  because: "your crew doesn't take that name",
  instead: TRY,
});

// A real name the fleet has no route to. Names the leaf that stopped the recipe walk, so the person can
// ask for the next thing made of the same material instead of hearing a bare no.
const cannotObtain = (said, blockedBy) => refuse({
  code: 'cannot_obtain',
  said,
  because: `your crew can't get that — it needs ${blockedBy}, and nothing they do produces it`,
  instead: TRY,
});

// A real name the crew can almost honour — right material, wrong grain: a species cannot be requested,
// only the family it belongs to.
//
// This is not `cannotObtain`: no recipe walk was stopped, and the crew fells wood constantly — it simply
// cannot be pointed at one species, because the canopy chain takes whatever is most abundant where it
// stands. It carries the working form, which is the word they already half-typed (Law 25).
const askByFamily = (said, family) => refuse({
  code: 'ask_by_family',
  said,
  because: `your crew takes whichever ${family} are most abundant where they are, so they can't promise `
         + 'you one kind',
  instead: `ask for the family — "${PREFIX} request 20 ${family}".`,
});

// The words are all real and the shape is wrong. States what was seen and the order it wants, since
// "incorrect format" without the format teaches nothing.
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

// A real structure that cannot be raised on its own. Not a spelling answer — the person named a real
// building and spelled it correctly, so pointing them at the list would send them to the one place the
// fault is not.
//
// The cause is attachment: most structures join another in a specific way and cannot be started from
// nothing. Naming that stops the whole family of attempts, not just this one.
const noPlanForThat = (said, raisable) => refuse({
  code: 'no_plan_for_that',
  said,
  because: 'that one is part of a larger build — it attaches to another structure, so it can\'t be started on its own',
  // THE REMEDY IS A SENTENCE THE PERSON CAN TYPE, NOT A BARE NAME — clause 4 asks for the form that would
  // have worked, and a bare name would leave them composing the line themselves.
  instead: raisable.length === 1
    ? `say "${PREFIX} request ${raisable[0]}" — that is the one your crew can raise on its own.`
    : raisable.length
      ? `your crew can raise these on their own: ${raisable.join(', ')}. say "${PREFIX} request <name>", no number.`
      : `your crew cannot raise anything on its own yet — say "${PREFIX} list" for what they can fetch instead.`,
});

// The same building asked for twice while the first one is still going up. Carries the stage, since a
// bare already-asked answer would leave the person wondering whether anything is happening.
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

// A verb aimed at bots the asker does not have.
const noBotsOut = (said) => refuse({
  code: 'no_bots_out',
  said,
  because: 'you have no bots out',
  instead: `say "${PREFIX} get contractor" and I'll fetch you a crew.`,
});

// THE HOMESTEAD IS ALREADY STAFFED. The mirror of `crewFull`, but a separate refusal: nobody can dismiss a
// homesteader from inside the world, so this points at getting a contractor crew instead of at `stop`
// (Law 25).
//
// A homestead belongs to the world, not to a person, so this counts every homesteader present, not just
// the asker's own — a second person asking for one is told it already exists.
const homesteadFull = (said, names, limit) => refuse({
  code: 'homestead_full',
  said,
  because: `the homestead already has ${names.join(' and ')}${limit ? ` — and ${limit} is a crew` : ''}`,
  instead: `they answer to nobody, so say "${PREFIX} get contractor" for a crew that answers to you.`,
});

// `get` with no species, or with a word that is not one — the one correction on the busiest verb, so it
// states the difference a person is actually choosing between: who the crew answers to. Everything else
// about the two is identical — same door, same crew size, both brought to where you stand.
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
