'use strict';
// foreman_vocabulary.js — WHAT THE FOREMAN OFFERS A HUMAN, and what each word costs them.
//
// SPLIT OUT OF foreman.js FOR ONE REASON: foreman.js creates its mineflayer client at module scope, so
// requiring it joins the server — which is why the load sweep excludes it, and why a load-time
// guarantee written there would never actually run. The assertions below are the whole point of this
// file, so it has to live somewhere `preflight` can open. A guarantee that only fires in production is
// not a guarantee.
//
// WHAT IS AUTHORED HERE IS THE PAGE, AND WHAT IS CHECKED IS THAT IT MATCHES THE DOOR. `INGAME_VERBS` —
// the set the OVERSEER accepts from a human, enforced there rather than here (Law 23: a guarantee resting
// on the sender's honesty is not one) — must be fully named on the page, or a verb works that nobody can
// discover. The assertion at the bottom of the vocabulary section is that check.

// ── THE HELP MAPS THE IN-GAME SET, NOT THE OPERATOR'S (Architect 2026-09-01) ──────────────────────
// *"i want to reduce the amount of commands you give to the bot so the help page is smaller."*
//
// This file used to map OPERATOR_VERBS — the OPERATOR's console vocabulary, which is what that set's own
// header says it is. So every verb the terminal gained was published to a stranger standing in the world,
// and the throw at the bottom then enforced that the two stayed identical. The throw was doing its job;
// the set it enforced against was the wrong one. Five of the seven it published were bench instruments or
// fleet-wide erasers, and cutting them took the page from fifteen lines to nine — under the ten a vanilla
// chat window shows, which is the first time the whole help has fit on one screen at once.
//
// INGAME_VERBS is the set a human may say, and it is REFUSED BY THE OVERSEER rather than merely unlisted
// here (see runOperatorVerb). An unlisted word the desk still accepts is hidden state (Invariant C), and
// the two-listener design exists because a guarantee resting on the sender's honesty is not one (Law 23).
const { INGAME_VERBS } = require('@overseer/message_schema');

// HOW MANY BOTS ARE IN A CREW — the number one `get` hands out, and the only number there is.
//
// A CONSTITUTION, NOT A CAP, and the difference is why the word changed (Law 27). It was written as a
// limit on how many bots a person could accumulate — a rule about a human's history of asking, which
// nothing but an enforcer could police. It is now a definition of what a crew IS: bots exist to share
// tasks and resources, the smallest number that can share is two, so two is what a crew means. There is
// no "no more" to enforce because there is no request that produces a third — the failing case does not
// exist inside the thing rather than being refused at its door.
//
// One is not a small crew and three is not a large one; both are a different thing wearing the name.
const CREW_SIZE = 2;

// ── WHICH SPECIES A `get` HANDS OUT, NAMED BY THE PERSON AND NEVER DEFAULTED ────────────────────────
// (Architect 2026-09-09: *"the player will have to type foreman get contractor and foreman get
// homesteader… make identical start methods."*)
//
// THE TWO ARE ONE DOOR WITH ONE WORD OF DIFFERENCE, and that is the whole ask. Both are fetched by a
// person standing in the world, both are brought to where that person stands, both begin working on
// arrival. What the word chooses is who the bodies then answer to — and because that is the one thing a
// human cannot change afterwards, it is the one thing they have to say out loud.
//
// THERE IS NO DEFAULT, deliberately (Law 13: absent is a fault, never a value). Defaulting to contractor
// would hand somebody who typed `get` a crew that obeys them when they may have wanted the opposite, and
// defaulting to homesteader would hand them two bodies that ignore every word they say next. Both are a
// wrong answer that still runs, so a bare `get` is corrected instead — see `correction.getNeedsASpecies`.
//
// Taken from the config that already defines the species rather than spelled again here: a second copy of
// a vocabulary is what `OPERATOR_VERBS`' own header records dying silently in the middle (Law 16).
const { BOT_MODES } = require('@thinking/architect_config');
const SPECIES = Object.freeze([BOT_MODES.CONTRACTOR, BOT_MODES.HOMESTEADER]);

// ── THE HELP PAGE IS A LIST OF WORDS, AND THAT IS THE WHOLE SPECIFICATION ───────────────────────────
// Three cuts, each ordered after he read the page in the world, and the third one is the shape:
//   2026-08-31  *"foreman help is terrible… its way too wordy. nobody is going to read that."*   33 → 15
//   2026-09-01  *"i want to reduce the amount of commands… so the help page is smaller."*        15 → 11
//   2026-09-05  *"i want it more simple. 9 lines is too much. only list the commands the words
//                only."*                                                                          9 → 2
//
// THE CHANNEL IS THE CONSTRAINT AND IT IS MEASURABLE, not a matter of taste. The outbound queue sends ONE
// LINE PER SECOND — a spam-kick guarantee that cannot be relaxed — the client re-wraps at roughly 50
// characters whatever the protocol's 240 allows, and a vanilla chat window shows ten lines. Those three
// numbers multiply: an eleven-line page took eleven seconds and pushed its own first line off the screen
// before its last arrived, so the verb a person came for was reliably the one they could no longer see.
// **A help page longer than the window is not a long help page, it is a help page with a hole in it** —
// and the hole was at the top, where `get` lives.
//
// THE MISTAKE THE SECOND CUT MADE, recorded because it is the one a future editor will repeat: it counted
// ENTRIES, found each under the wrap width, and concluded the page fit. Per line that was true. In total
// it was wrong by one line and a whole window. **Measure the page, never the line.**
//
// WHY WORDS ALONE ARE ENOUGH, which is the part that looks like a loss. Every gloss answered a question
// the reader had not asked: someone opening `help` wants to know *which words exist*, and someone who
// then wants to know what a word does says it and finds out. The argument shapes are not lost either —
// `parseRequest` answers a malformed `request` with the exact form that would have worked, at the only
// moment that form is information rather than notation. **The explanation was always somewhere better;
// the page was a second copy of it in the worst place to read** (Law 16), and *elsewhere* now exists in
// the two places the video doctrine requires teaching to sit anyway: the Discord arrival message and the
// pinned arrival screen.
//
// THE ONE THING SHORTENING MAY NOT DROP, and the reason the page is two lines rather than one: a verb
// whose consequence is larger than it sounds has to say so HERE, because nowhere later is early enough
// (Law 25 — the asker can only set a criterion from what they were told). `wipe` is the only word on the
// page that destroys something, it cannot be undone, and its own name argues against itself.
// ── THE VERBS THEMSELVES, AS DATA, BECAUSE THE PAGE IS NOW NOTHING BUT THEM ─────────────────────────
// `VERB_HELP` and `VERB_HELP_CONTINUED` are DELETED (2026-09-05). They mapped each in-game verb to a
// sentence, and the two load-time throws around them enforced that the map and the vocabulary named the
// same set. Both are gone with the glosses they described: nothing rendered them any more, and dead code
// carrying a live-looking guarantee is worse than no guarantee (Law 16 — nothing stays alive that nothing
// calls).
//
// WHAT REPLACES THE GUARANTEE, and it is the same guarantee pointed at the format that now exists. The
// old throw protected *"every offered verb has a description"*. The page has no descriptions, so the
// property worth protecting became *"every verb the fleet accepts is NAMED on the page"* — and its two
// failure directions are the same two, still silent and still different:
//   a verb missing from the page → it works, and nobody can discover it.
//   a word on the page the fleet refuses → a person is invited to say something that cannot work.
const VERBS = Object.freeze([
  // ORDERED BY WHEN A PERSON NEEDS THEM: get a crew, see it, ask it for something, change your mind,
  // dismiss, forget. Alphabetical would open on `cancel`, which is nobody's first act.
  //
  // `list` IS GONE (Architect 2026-09-06: *"foreman help is now the list. so remove list."*). It printed
  // the whole requestable catalogue — every material, every family token, every raisable building — as
  // four messages over four seconds, which is a wall in a window drawn over the world, and the page it
  // sits on is now itself a list of words. What it bought was SPELLING, and the corrections already buy
  // that at the only moment it is information: a name the desk does not take comes back with the form
  // that works. See `correction.js` for what those refusals say now that there is nowhere to send anyone.
  'get', 'where', 'request', 'cancel', 'stop', 'wipe',
]);

// ONE ENTRY PER VERB, sent as separate messages rather than joined — a person scanning for one verb
// reads a list, never a paragraph.
//
// SHOWN BY EXAMPLE, NOT BY GRAMMAR. `request 20 logs` teaches the shape in the same characters
// `request <n> <item>` spends on notation a person has to decode first.
//
// NINE LINES, ONE PER VERB, NO HEADER, HARD CEILING. Nine is not a style preference — a vanilla chat
// window shows ten lines and the outbound queue sends one per second, so a tenth line pushes the first
// off the screen before the last arrives. **Adding a verb means shortening another line, not adding a
// tenth.** If the fleet ever offers a tenth in-game verb, this page has to become paged or grouped; it
// may not simply grow, because the failure is silent and looks like the help "not having" the verb the
// reader came for.
//
// THE PREFIX IS NO LONGER TAUGHT HERE, and the header that taught it is gone. It cost a line — the
// scarcest thing on this page — to state a form the reader had to already know in order to arrive:
// `help` is unreachable without saying `foreman help` first. The one reader who genuinely needs the form
// is the one who has just walked in and typed nothing, and that reader is now met by the login greeting
// (`foreman.js`, playerJoined), which says the form at the only moment it is news.
// ── CUT TO THE WORDS THEMSELVES, 2026-09-05 ─────────────────────────────────────────────────────────
// *"i want it more simple. 9 lines is too much. only list the commands the words only."*
//
// THE PAGE IS A JOG, NOT A MANUAL, and the previous nine-line form still had not accepted that. Every one
// of those lines carried a dash and a gloss — *"get — your crew of 2"* — and a gloss is an answer to a
// question the reader has not asked yet. Someone opening `help` is looking for **which word exists**;
// someone who then wants to know what the word does says it and finds out, and the desk's correction path
// answers a malformed one with the exact form that would have worked. **The explanation was already
// somewhere better; the page was a second copy of it in the worst place to read.**
//
// THE ARGUMENT SHAPES ARE GONE TOO, and that is the part worth defending because it looks like a loss.
// `request 20 logs` taught the number-then-thing form on the page. It is now taught by `parseRequest`'s
// corrections at the moment somebody gets it wrong — which is the only moment the form is information
// rather than notation, and which was already written and already better worded than the help line.
//
// ONE LINE MEANS THE WHOLE PAGE IS ALWAYS ON SCREEN, whatever else is being said in chat. Nine lines at
// one line per second could still be pushed apart by other players talking mid-page; one cannot.
function helpLines() {
  return [
    VERBS.join(', '),
    // ── THE ONE VERB THAT TAKES A WORD, SHOWN IN THE FORM THAT WORKS ────────────────────────────────
    // `get` is the only verb here that is incomplete on its own, so the list above names a word a person
    // cannot successfully say. That is the hole the page exists to close, and it is the same hole the
    // 2026-09-05 cut found at the top of the page — the verb everybody comes for being the one they
    // cannot act on. Written as the two literal commands rather than `get <species>`, because a
    // placeholder is a thing to decode and these are things to type.
    `${SPECIES.map(s => `get ${s}`).join('  or  ')}`,
    // ── THE ONE LINE THAT IS NOT A COMMAND NAME, AND WHY IT SURVIVED "WORDS ONLY" ───────────────────
    // `wipe` is the only word here that destroys something and cannot be undone, and its own name argues
    // against itself — it sounds like tidying up. Law 25: the asker can only set a criterion from what
    // they were told, so a person who says it having been shown nothing but the word has not consented to
    // what it does. Every other gloss on this page was answering an unasked question; this one is
    // answering the question *"is this safe to try?"*, which is asked of every unfamiliar word and which
    // this page would otherwise answer wrongly by silence.
    // **Flagged to him rather than assumed** — if he wants the page to be literally one line, the correct
    // replacement is a confirmation step on `wipe` itself (Law 27: constitute the safety rather than
    // warn), not simply deleting this.
    `wipe erases YOUR crew's places — no undo`,
  ];
}

// THE PAGE MUST FIT THE WINDOW, CHECKED AT LOAD RATHER THAN REMEMBERED. The ceiling above is a comment
// asking a future editor to count, and a rule that needs someone to count is the rule that quietly went
// to eleven last time (Law 27 — constitute the property, do not police it). This is the one place both
// halves of the page — the authored lines and the ones derived from INGAME_VERBS — are visible at once,
// so it is the only place the total can be known.
const CHAT_WINDOW_LINES = 10;
// the words, the two `get` forms, the wipe caution, and one spare — deliberately far under the window.
// RAISED FROM 3 TO 4 on 2026-09-09 when `get` began taking a species, and raised rather than quietly
// spent: the spare exists so a real page can grow, and a ceiling that is edged up without saying why is
// how this page went to eleven the first time. The line added is a COMMAND FORM, which is what this page
// is a list of — the check is still aimed at the thing it was built to catch, which is a gloss coming
// back dressed as a line.
const HELP_CEILING = 4;
(function assertHelpPageHolds() {
  const lines = helpLines();
  if (lines.length > HELP_CEILING) {
    throw new Error(`[foreman_vocabulary] CODING VIOLATION (Law 13): the help page is ${lines.length} lines `
      + `and the ceiling is ${HELP_CEILING}. This page is a list of WORDS (Architect 2026-09-05: "only list `
      + 'the commands the words only") — a new line means a gloss has crept back in. Put the explanation '
      + 'where the explanation lives: the Discord arrival message and the pinned screen.');
  }
  const long = lines.filter(l => l.length > 50);
  if (long.length) {
    throw new Error(`[foreman_vocabulary] CODING VIOLATION (Law 13): ${long.length} help line(s) exceed the `
      + `~50 characters a client re-wraps at, so each becomes two visual lines: ${long.map(l => `"${l}"`).join(', ')}`);
  }
  // EVERY VERB THE FLEET ACCEPTS IS ON THE PAGE. This is the guarantee the deleted VERB_HELP throws used
  // to carry, re-aimed at the format that replaced them. INGAME_VERBS is the set the OVERSEER enforces at
  // the door, so a verb there and not here works and is undiscoverable — the silent half.
  const page = lines.join(' ');
  for (const verb of INGAME_VERBS) {
    if (!VERBS.includes(verb)) {
      throw new Error(`[foreman_vocabulary] CODING VIOLATION (Law 13): the overseer accepts the in-game verb `
        + `'${verb}' and the help page does not name it. It would work and nobody could find it.`);
    }
    if (!page.includes(verb)) {
      throw new Error(`[foreman_vocabulary] CODING VIOLATION (Law 13): '${verb}' is in VERBS but does not `
        + 'appear in the rendered page. The page and the list have come apart.');
    }
  }
})();

// parseRequest — reads `request` and its two shapes from one word.
//
// ONE VERB DOES BOTH ASKING AND ASKING-ABOUT, decided by whether arguments follow. A separate
// `requests` for status would sit one letter from `request`, aimed at a person under no obligation to
// type carefully, and a typo would silently place an order instead of reading one. Arguments-or-not
// cannot be mistyped into the other intent (Law 26 — the smallest interface is the one with the fewest
// ways to be wrong).
//
// Returns { kind: 'status' } | { kind: 'post', quantity, item } | null for anything unreadable, so the
// caller answers with the usage line. A half-parsed order is never returned: guessing a quantity buys
// work nobody asked for, and guessing an item delivers the wrong thing (Law 13 — never default a field).
//
// The QUANTITY LEADS because that is the order a person says it in — "twenty logs", not "logs twenty".
// ── IT NO LONGER RETURNS NULL FOR "UNREADABLE" (Architect 2026-08-30) ────────────────────────────────
// Under the correction doctrine a refusal has to say what was wrong and what would have worked, and a
// bare null cannot carry either — every unreadable sentence came back as the same usage line, so a person
// who reversed the word order and a person who typed a fraction were told the identical thing. The parse
// now reports the SHAPE it saw and lets the desk build the correction that fits it.
//
// A QUANTITY IS OPTIONAL, because a building is not a countable thing: there is one headframe and the
// crew builds it once. Which of the two forms is legal for a given word is not this function's business —
// it needs the catalogue to know whether a name is a blueprint, and a parser that reached for the
// catalogue would be deciding as well as reading (Law 0). It returns what was SAID; the desk decides.
//
// → { kind:'status' }
//   { kind:'post', quantity: <number|null>, item }
//   { kind:'reversed', item, quantity }   — "request logs 20": the words are right, the order is not
//   { kind:'bad_quantity', said }         — a number was where a number goes and was not a whole count
//   { kind:'no_item' }                    — a quantity and nothing to apply it to
function parseRequest(parts) {
  if (parts.length === 1) return { kind: 'status' };

  const first = parts[1];
  const firstNum = Number(first);
  const looksNumeric = first !== '' && Number.isFinite(firstNum);

  if (looksNumeric) {
    const item = parts.slice(2).join('_').toLowerCase();
    if (!Number.isInteger(firstNum) || firstNum <= 0) return { kind: 'bad_quantity', said: first };
    if (!item) return { kind: 'no_item' };
    return { kind: 'post', quantity: firstNum, item };
  }

  // THE REVERSED FORM IS DETECTED, NOT REPAIRED. "request logs 20" is a person who knows both words and
  // put them the other way round, and telling them the order is a different service from guessing what
  // they meant — this returns the SHAPE so the desk can name it, and files nothing (Architect: "foreman
  // request logs 20 is incorrect format, format is request number item").
  const last = parts[parts.length - 1];
  const lastNum = Number(last);
  if (parts.length > 2 && last !== '' && Number.isFinite(lastNum)) {
    return { kind: 'reversed', item: parts.slice(1, -1).join('_').toLowerCase(), quantity: lastNum };
  }

  // No number anywhere: the building form, or a good whose count was forgotten. Both are legal shapes to
  // SAY, and which one this is depends on the word, which the desk resolves.
  return { kind: 'post', quantity: null, item: parts.slice(1).join('_').toLowerCase() };
}

// parseCancel — `cancel <item>` or `cancel all`. Null when nothing was named, because a bare `cancel`
// is ambiguous between "withdraw everything" and a sentence somebody did not finish typing, and the
// destructive reading must never be the one a truncated line lands on.
function parseCancel(parts) {
  const item = parts.slice(1).join('_').toLowerCase();
  return item ? { item } : null;
}

// DELETED 2026-09-01 — `parseMove`, orphaned when `move` left the in-game vocabulary (Law 16: nothing
// stays alive that nothing calls). It read three authored coordinates off a human's sentence. `move` is a
// BENCH verb — one locomotion leg with the planning recursion off, on a body the arena director has
// already positioned over RCON — so a person in the world who said it got a bot that walked once and then
// stood there. It remains an operator verb and fleet_control still sends it; only the door stopped taking
// it. The rule it carried and the door still honours: a partially parsed coordinate is never returned,
// because walking a body somewhere nobody asked for is a wrong answer that still runs (Law 13).

// ── HOW A STATUS LINE IS WORDED ──────────────────────────────────────────────────────────────────
// These live here rather than in foreman.js for the same reason the parsers do: foreman.js cannot be
// opened by anything that is not joining the server, and the rule inside describeProgress is the one
// most likely to be quietly "corrected" back into the failure it prevents. A rule that cannot be
// exercised is a comment.

// How long ago a person asked, in words rather than a timestamp. A desk speaking to a human in epoch
// milliseconds is a machine that has forgotten who it is talking to (Law 24).
function describeAge(at) {
  if (!at) return 'just now';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute(s) ago`;
  return `${Math.floor(mins / 60)} hour(s) ago`;
}

// How far along one request is, from a measurement a body took.
//
// NO MEASUREMENT IS SAID AS "no word yet" RATHER THAN AS ZERO, and this is the load-bearing line. The
// two are different facts and only one is news about the work: a crew that has gathered nothing and a
// crew that has not yet reported both show an empty shelf, so printing "0 of 20" for the second tells a
// person their bots are idle when they may be halfway up a hill. Filling the gap with a zero is the
// invented figure Law 25 names as the failure — the absence is not the failure.
//
// A STRUCTURE REPORTS A RUNG, NEVER A PERCENTAGE. The building ladder is sited → pasted → built and
// those are the words its own records carry; a share-of-blocks number would be a second measure of a
// fact that already has an owner, and one that moves unevenly enough to read as stalled while work is
// happening.
function describeProgress(measurement) {
  if (!measurement) return ' — no word from your crew yet';
  if (measurement.kind === 'structure') {
    return measurement.met ? ' — built' : ` — ${measurement.stage}`;
  }
  if (measurement.met) return ` — done, ${measurement.have} on the shelf`;
  return ` — ${measurement.have} so far`;
}

// pluralForms(token) → the other ways the SAME word can be written, singular and plural.
//
// THE ONLY FORGIVENESS THE DESK OFFERS, and it is deliberately not a matcher (Architect 2026-08-30 — see
// foreman.js's require block for the ruling that removed one). It exists because English and the fleet's
// naming convention disagree in both directions and neither is wrong: the fleet spells one item `oak_log`
// and a family `logs`, so a person saying "log" is under-pluralised and one saying "doors" is
// over-pluralised, and both are the ordinary way to say it.
//
// IT PROPOSES SPELLINGS; IT DECIDES NOTHING. Every form it returns is looked up EXACTLY against the
// catalogue by the caller and discarded unless it is already a legal name. So a wrong guess here cannot
// produce a wrong item — it produces a word that fails the lookup and falls through to the refusal. That
// is the whole difference between this and what was removed: no scoring, no distance, no ranking of
// candidates, and therefore no reading a person has to check.
function pluralForms(token) {
  const out = new Set();
  const parts = String(token || '').split('_');
  const last = parts[parts.length - 1];
  if (!last) return [];
  const swapLast = w => [...parts.slice(0, -1), w].join('_');
  if (last.endsWith('es')) out.add(swapLast(last.slice(0, -2)));
  if (last.endsWith('s')) out.add(swapLast(last.slice(0, -1)));
  out.add(swapLast(last + 's'));
  out.delete(token);
  return [...out].filter(Boolean);
}

// ── HOW A `where` LINE IS WORDED ─────────────────────────────────────────────────────────────────
// describeCrew(bots, speakerPos) → ONE line for the whole crew: each body, which way and how far, what it
// is doing. Everything it prints was RELAYED, nothing was computed about the work (Law 3) — the position
// is the body's own `body_cell`, published on a timer into its boardroom chair, and the job is the
// dispatcher's `magnet`, the task-identity marker written when the job was claimed. The only things this
// desk computes are the distance and the bearing, and only because they are relations between a body and
// a PERSON — the person standing in front of this process, whom no bot can see.
//
// ── WHY THIS IS THE ONLY WAY A CONTRACTOR'S WORK REACHES A HUMAN (Architect 2026-09-06) ───────────
// *"when they post to their owner its way too much. it will block the players vision… reporting is off by
// default and a player should type foreman where to get a one line notification of where the bots are and
// what they are doing."*
//
// The bots used to NARRATE — a line in open chat on every job claim and every idle change, from every
// body, unasked. It was built to stop a watching human from mistaking a working bot for a broken one, and
// on one bot in a recording it did that. On a crew of two beside a player trying to play, it filled the
// chat window, which is drawn over the world: the fix for "I cannot tell what it is doing" had become
// "I cannot see". THE CHANNEL IS PULL NOW, and this function is the whole of it. `bot_voice` is deleted
// rather than defaulted quiet — a switch is a second place the answer lives, and the answer never varies.
//
// ONE LINE FOR THE CREW, NOT ONE PER BOT. The channel sends one message per second and a vanilla window
// shows ten rows, so a line per body made the answer to a two-word question arrive over two seconds in
// two places. A crew is two bodies by constitution (CREW_SIZE), so the whole crew fits one message and
// always will.
//
// A BEARING AND A DISTANCE, NOT COORDINATES, whenever there is a person to measure against. Coordinates
// are an OPERATOR's fact: nobody on a public world can teleport to one, so a player reading
// `(123,64,-45)` has to do the subtraction this desk already did to learn the one thing they asked —
// which way to walk. `87m NE` is that answer in a third of the characters. Coordinates return the moment
// the bearing cannot be computed, because then they are the only true thing left to say.
//
// DEPTH REPLACES THE BEARING WHEN DEPTH IS THE ANSWER. A bot forty blocks straight down a shaft is not
// "3m NE"; the compass point is technically true and useless, and "40m down" is the same two tokens
// spent on the fact that actually moves the person. Whichever of the two distances dominates is the one
// named — never both, because the second is then a word doing no work.
//
// THREE ABSENCES, THREE DIFFERENT SENTENCES, and none of them is a zero (Law 25 — the same rule
// describeProgress enforces for an unmeasured request):
//   no magnet     → the bot holds no job. That is genuinely idle and is said plainly.
//   no body_cell  → the bot has not published a position yet. NOT "at 0,0,0", which is a real place.
//   no speakerPos → the BEARING is unknown, and only the bearing. The foreman speaks on open chat, which
//                   is server-wide, so a person can say `where` from anywhere on the map — and the desk
//                   can only measure to a player its own body can actually see. Coordinates go out in
//                   its place; nothing is invented.

// PLAIN ENGLISH FOR THE PERSON, ONE WORD PER JOB TYPE — the vocabulary of what is physically happening,
// not the trace's. `build/contractor_house` is exactly right for a reader with the blueprint open and
// means nothing to somebody looking for their bot.
//
// IT LIVES HERE BECAUSE THIS IS THE DESK THAT ANSWERS THE QUESTION. The same map used to sit in the
// dispatcher, feeding the bot's own mouth; when the mouth went, keeping a second copy in the bot process
// would have been two vocabularies free to drift with nothing to catch it (Law 16).
//
// A TYPE WITH NO WORD NAMES ITSELF rather than going blank. An unlovely phrase beats a bot that appears
// to be doing nothing, and a missing entry must never be the reason `where` goes quiet about new work —
// which is precisely when somebody is asking.
const SHORT_JOB = Object.freeze({
  respawn:        'recovering',
  supply:         'fetching',
  build:          'building',
  mine:           'mining',
  farm:           'farming',
  health:         'eating',
  explore:        'scouting',
  furnace:        'smelting',
  ground_salvage: 'salvaging',
  light:          'lighting',
  canopy:         'clearing trees',
  base_layout:    'surveying',
  wood_preference:'checking wood',
});

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Minecraft's axes: +x is EAST, +z is SOUTH. atan2(dx, -dz) therefore reads 0 at due north and turns
// clockwise, which is the order COMPASS is written in.
function _bearing(dx, dz) {
  const octant = Math.round(Math.atan2(dx, -dz) / (Math.PI / 4));
  return COMPASS[((octant % 8) + 8) % 8];
}

function _job(magnet) {
  if (!magnet) return 'idle';
  const type = magnet.job_type || magnet.type;
  const verb = SHORT_JOB[type] || type || 'working';
  // `what` is added only when it says something the type did not — "mining" and "mining iron ore" answer
  // different questions, and the second is the one a person watching an empty chest is asking.
  const what = magnet.what && magnet.what !== type ? ` ${String(magnet.what).replace(/_/g, ' ')}` : '';
  return `${verb}${what}`;
}

function _one(bot, speakerPos) {
  const cell = bot.body_cell;
  const job = _job(bot.magnet);
  if (!cell || typeof cell.x !== 'number') return `${bot.id} no position yet, ${job}`;
  if (!speakerPos) return `${bot.id} (${cell.x},${cell.y},${cell.z}) ${job}`;

  const dx = cell.x - speakerPos.x, dy = cell.y - speakerPos.y, dz = cell.z - speakerPos.z;
  const flat = Math.hypot(dx, dz);
  // A bot standing on the person is `here`, never `0m S`. A bearing to a body you are already touching is
  // a word that carries nothing, and a number that reads as an error.
  const place = Math.round(Math.hypot(flat, dy)) === 0 ? 'here'
    : Math.abs(dy) > flat ? `${Math.round(Math.abs(dy))}m ${dy < 0 ? 'down' : 'up'}`
    : `${Math.round(flat)}m ${_bearing(dx, dz)}`;
  return `${bot.id} ${place} ${job}`;
}

function describeCrew(bots, speakerPos) {
  return bots.map(b => _one(b, speakerPos)).join(' · ');
}

module.exports = {
  // VERB_HELP and VERB_HELP_CONTINUED are gone (2026-09-05) — they described per-verb glosses the page no
  // longer renders. `VERBS` is what replaced them: the list itself, exported so the page and the door can
  // be checked against each other rather than kept in step by hand.
  INGAME_VERBS, VERBS, CREW_SIZE, SPECIES, helpLines,
  parseRequest, parseCancel, pluralForms,
  describeAge, describeProgress, describeCrew,
};
