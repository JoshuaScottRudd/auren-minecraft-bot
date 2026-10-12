'use strict';
// What the foreman offers a human, and what each word costs them.
// Lives outside foreman.js so `preflight` can load it without joining the server (foreman.js creates its
// mineflayer client at module scope). The load-time assertions below prove that INGAME_VERBS, the set the
// foreman accepts and enforces at the door (Law 23), is fully named on the help page.

// INGAME_VERBS is the set a human may say in-game; the foreman refuses anything else at the door (see
// runOperatorVerb), so an unlisted word here would be hidden state (Invariant C, Law 23).
const { INGAME_VERBS } = require('@foreman/message_schema');

// The number of bots a `get` hands out. Defines what a crew IS (Law 27): the smallest number that can
// share tasks and resources is two, so two is a crew.
const CREW_SIZE = 2;

// The run page sizes the builder crew; raising, cameras and startup proof read this same answer.
const BUILDER_CREW_SIZE = require('../foreman_config').builder.count;
// States how many bodies a crew is, read by the raise and by the step that proves the crew is standing
// (Law 16).
function crewSizeFor(species) { return species === 'builder' ? BUILDER_CREW_SIZE : CREW_SIZE; }

// The species word chooses who the bodies answer to, the one thing a person cannot change afterwards.
// No default is offered (Law 13): a bare `get` is corrected, never guessed — see
// `correction.getNeedsASpecies`. Read from the config that already defines the species (Law 16).
const { BOT_MODES } = require('@thinking/architect_config');
const SPECIES = Object.freeze([BOT_MODES.CONTRACTOR, BOT_MODES.HOMESTEADER]);

// The help page is a list of words, bounded by the channel: one line per second outbound, ~50-character
// client re-wrap, a ten-line chat window. No glosses in chat: what a word does is learned by saying it
// (parseRequest's corrections teach the form) or read where a paragraph fits (README, a welcome message)
// (Law 16). `wipe` is the one exception, stating its consequence up front (Law 25).
// The verbs themselves, as data, since the page is nothing but them: no per-verb gloss map, and every
// verb the fleet accepts is named on the page, checked both directions by the assertion below.
const VERBS = Object.freeze([
  // Ordered by when a person needs them: get a crew, see it, ask it for something, change your mind,
  // dismiss, forget. `teleport` sits by `where` — it answers the same question `where` points to.
  'get', 'where', 'teleport', 'request', 'cancel', 'stop', 'wipe',
]);

// helpLines() — the rendered help page: one message per line, so a reader scanning for one verb reads a
// list, not a paragraph. Shown by example (`get contractor`), not grammar notation. Capped at
// HELP_CEILING lines; the foreman prefix (`foreman help`) is taught once, at login, not repeated here.
function helpLines() {
  return [
    VERBS.join(', '),
    // `get` is the only verb incomplete on its own; shown as the two literal commands, not a
    // `get <species>` placeholder someone has to decode.
    `${SPECIES.map(s => `get ${s}`).join('  or  ')}`,
    // `wipe` is the only destructive, un-undoable word here, so its consequence is stated up front
    // (Law 25).
    `wipe erases YOUR crew's places — no undo`,
  ];
}

// The verb list, the two `get` forms, the wipe caution, and one spare line — checked at load (Law 27).
const HELP_CEILING = 4;
(function assertHelpPageHolds() {
  const lines = helpLines();
  if (lines.length > HELP_CEILING) {
    throw new Error(`[foreman_vocabulary] CODING VIOLATION (Law 13): the help page is ${lines.length} lines `
      + `and the ceiling is ${HELP_CEILING}. This page is a list of WORDS (Architect 2026-09-05: "only list `
      + 'the commands the words only") — a new line means a gloss has crept back in. Put the explanation '
      + 'where a paragraph can be read: the README, or however this world greets arrivals.');
  }
  const long = lines.filter(l => l.length > 50);
  if (long.length) {
    throw new Error(`[foreman_vocabulary] CODING VIOLATION (Law 13): ${long.length} help line(s) exceed the `
      + `~50 characters a client re-wraps at, so each becomes two visual lines: ${long.map(l => `"${l}"`).join(', ')}`);
  }
  // The guarantee that every verb the fleet accepts is named on the page, checked both directions:
  // missing from the page (works, undiscoverable) and named but refused (invites a dead word).
  const page = lines.join(' ');
  for (const verb of INGAME_VERBS) {
    if (!VERBS.includes(verb)) {
      throw new Error(`[foreman_vocabulary] CODING VIOLATION (Law 13): the foreman accepts the in-game verb `
        + `'${verb}' and the help page does not name it. It would work and nobody could find it.`);
    }
    if (!page.includes(verb)) {
      throw new Error(`[foreman_vocabulary] CODING VIOLATION (Law 13): '${verb}' is in VERBS but does not `
        + 'appear in the rendered page. The page and the list have come apart.');
    }
  }
})();

// parseRequest — reads `request`'s two shapes, asking and asking-about, chosen by whether arguments
// follow (Law 26). Quantity leads, matching how a person says it ("twenty logs"), and is optional
// because a building is not counted. Reports what was SAID and returns the shape seen, not a guess at a
// missing field (Law 13) or a decision of its own (Law 0) — only the desk resolves which form a word takes.
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

  // The reversed form is detected, not repaired: returns the shape so the desk can name the correction
  // ("request <number> <item>").
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

// No coordinate parser here: `move` is a bench verb (sent by fleet_control over RCON to a body the
// arena director already positioned), not an in-game one — the door refuses it.

// How a status line is worded. Lives here, not foreman.js, for the same reason as the parsers:
// foreman.js cannot be opened without joining the server, so a rule inside it cannot be checked by
// preflight.

// How long ago a person asked, in words, not a timestamp (Law 24).
function describeAge(at) {
  if (!at) return 'just now';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute(s) ago`;
  return `${Math.floor(mins / 60)} hour(s) ago`;
}

// How far along one request is, from a measurement a body took. No measurement is said as "no word
// yet", not as zero: a crew that gathered nothing and a crew that hasn't reported yet are different
// facts (Law 25). A structure reports its rung (sited → pasted → built), never a computed percentage,
// since the ladder is already the owner of that fact.
function describeProgress(measurement) {
  if (!measurement) return ' — no word from your crew yet';
  if (measurement.kind === 'structure') {
    return measurement.met ? ' — built' : ` — ${measurement.stage}`;
  }
  if (measurement.met) return ` — done, ${measurement.have} on the shelf`;
  return ` — ${measurement.have} so far`;
}

// pluralForms(token) → the other ways the same word can be written, singular and plural. The only
// forgiveness the desk offers, and not a fuzzy matcher: the fleet's naming (`oak_log` vs `logs`) and
// ordinary English pluralisation disagree in both directions. It proposes spellings and decides
// nothing — every form is looked up exactly against the catalogue by the caller, so a wrong guess just
// fails the lookup, never produces a wrong item.
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

// describeCrew(bots, speakerPos) → one line for the whole crew: each body, which way and how far, what
// it is doing. Everything printed is relayed, nothing computed about the work itself (Law 3) — position
// is the body's own `body_cell`, job is the dispatcher's `magnet`; distance and bearing are the only
// computed facts, relations between a body and the person standing here. Pull-only: bots do not narrate
// job claims or idle changes into open chat, so `where` is the one channel this reaches a human through.
// One line for the whole crew, since CREW_SIZE (two) fits one message on a channel that sends one line
// per second. A bearing and a distance, not coordinates, whenever there is a person to measure against;
// depth replaces the bearing when the vertical distance dominates.
//
// Three absences, three different sentences, none of them a zero (Law 25):
//   no magnet     → the bot holds no job, said plainly.
//   no body_cell  → the bot has not published a position yet, never printed as a real place (0,0,0).
//   no speakerPos → only the bearing is unknown; coordinates go out in its place.

// Plain English per job type, one word — the vocabulary of what is physically happening, not the
// trace's job_type string. Lives here only, not duplicated in the bot process (Law 16). A type with no
// entry names itself, never going blank, so a missing entry never reads as an idle bot.
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
  clear_ground:   'clearing debris',
  wood_preference:'checking wood',
  // The downloaded building's site: `canopy` above already covers its felling phase, so these three add
  // words for what a person watching the plot would see happening at each stage.
  scrape:         'levelling ground',
  column:         'building',
  seal:           'filling in the stairs',
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
  // VERBS is exported so the page and the door can be checked against each other, not kept in step by
  // hand.
  INGAME_VERBS, VERBS, CREW_SIZE, BUILDER_CREW_SIZE, crewSizeFor, SPECIES, helpLines,
  parseRequest, parseCancel, pluralForms,
  describeAge, describeProgress, describeCrew,
};
