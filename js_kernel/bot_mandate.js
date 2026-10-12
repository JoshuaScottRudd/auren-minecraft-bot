'use strict';
// bot_mandate.js — WHAT SPECIES THIS PROCESS IS, decided at birth and never again.
// A contractor is an overridden homesteader: it differs only in what it ADDS, the human channels (the
// foreman's ear, order desk, acknowledgement line) — nothing here guards; `mountsHumanChannels()` is
// simply false for a homesteader. A second axis (the magnet filter, below) governs WHICH WORK a species
// may take: an ALLOWLIST read at claim time, where a category outside a species' filter is invisible.

const {
  BOT_MODES,
  CATEGORY_NAMES, // category vocabulary the magnet filter below names (Law 16).
} = require('@thinking/architect_config');

// Where an operator verb entered the fleet; taken from the schema all three processes share (Law 16).
const { COMMAND_ORIGIN: ORIGIN, VALID_ORIGINS, BUILDING_ROOM_SEPARATOR } = require('@foreman/message_schema');
const VALID_MODES = new Set(Object.values(BOT_MODES));
// Species that answer to nobody and hold a commons of their own, keyed by their own name.
const COMMONS_MODES = new Set([BOT_MODES.HOMESTEADER, BOT_MODES.BUILDER]);

// Read once and frozen, so a mode can never change mid-life.
let mandate = null;

// readMandate — the ONE place BOT_MODE is interpreted (Law 16). Never defaults: a missing mode is a
// fault, never a value (Law 13); an absent BOT_MODE refuses to boot.
function readMandate(env = process.env) {
  if (mandate) return mandate;

  const raw = env.BOT_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error(
      'CODING VIOLATION (Law 13): BOT_MODE is not set. Every bot is born a species and there is no ' +
      `default — start it from the terminal (stamps '${BOT_MODES.HOMESTEADER}') or from the doorman ` +
      `(stamps '${BOT_MODES.CONTRACTOR}'). A bot with no mandate does not boot.`
    );
  }

  const mode = String(raw).trim().toLowerCase();
  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `CODING VIOLATION (Law 13): BOT_MODE='${raw}' is not a species — valid: ${[...VALID_MODES].join(' | ')}.`
    );
  }

  const botId = env.BOT_ID;
  if (!botId || String(botId).trim() === '') {
    throw new Error('CODING VIOLATION (Law 13): BOT_ID is not set, so this process has no name to hold a mandate under.');
  }

  // The owner is part of the species, not a setting beside it (Law 27): a contractor belongs to the person who asked for it, a homesteader answers to nobody.
  const rawOwner = env.BOT_OWNER;
  const owner = rawOwner === undefined || rawOwner === null ? '' : String(rawOwner).trim();
  if (mode === BOT_MODES.CONTRACTOR && owner === '') {
    throw new Error(
      'CODING VIOLATION (Law 13): BOT_MODE=contractor with no BOT_OWNER. Every contractor belongs to the ' +
      'human who asked for it; an ownerless one would take orders from anybody in the world. Launch it ' +
      'with --owner=<player>.'
    );
  }
  // A homesteader or builder answers to nobody; an owner on either names a relationship nothing can honour.
  if (COMMONS_MODES.has(mode) && owner !== '') {
    throw new Error(
      `CODING VIOLATION (Law 13): BOT_MODE=${mode} with BOT_OWNER='${owner}'. A ${mode} answers ` +
      'to nobody, so it cannot belong to anyone. Either the mode or the owner is wrong.'
    );
  }
  // A player may not be named after a commons — it would collide with that species' shared shelf key.
  if (mode === BOT_MODES.CONTRACTOR && COMMONS_MODES.has(owner.toLowerCase())) {
    throw new Error(
      `CODING VIOLATION (Law 13): BOT_OWNER='${owner}' collides with the commons key '${owner.toLowerCase()}'. ` +
      'Station ownership stamps that word for shelves a whole species shares, so this crew would read ' +
      'and write the commons as if it owned it. This player cannot be given a crew under that name.'
    );
  }

  // A launch fact, frozen here so a bot cannot decide mid-life whether it was told to work.
  const autostart = String(env.BOT_AUTOSTART === undefined ? '' : env.BOT_AUTOSTART).trim() === '1';

  // A birth fact like the rest; a contractor falls back to its owner (a derivation, not a default —
  // Law 13), a homesteader has none to fall back to.
  const rawNear = env.BOT_START_NEAR;
  const nearGiven = rawNear === undefined || rawNear === null ? '' : String(rawNear).trim();
  const startNear = nearGiven || (mode === BOT_MODES.CONTRACTOR ? owner : '');

  // No `site` field: the foreman writes the site into its own memory before spawning; the body reads
  // it from the first broadcast (`start_injector`).
  mandate = Object.freeze({ botId: String(botId).trim(), mode, owner: owner || null, autostart, startNear: startNear || null });
  return mandate;
}

function currentMode() { return readMandate().mode; }
// currentOwner — the player this body belongs to, or null for a homesteader or builder (never missing).
function currentOwner() { return readMandate().owner; }
function isContractor() { return currentMode() === BOT_MODES.CONTRACTOR; }
function isHomesteader() { return currentMode() === BOT_MODES.HOMESTEADER; }
function isBuilder() { return currentMode() === BOT_MODES.BUILDER; }

// fearsTheNight — does darkness close outdoor work for this species? A builder does not, regardless of the world's difficulty setting.
function fearsTheNight() { return !isBuilder(); }

// beginsWorkAtBirth — does this body inject its own start signal on spawn? Asked once by master_core.
// A contractor always does, by constitution; a homesteader does only when the foreman stamped `BOT_AUTOSTART`.
function beginsWorkAtBirth() { return isContractor() || readMandate().autostart; }

// startNearPlayer — the player this body must stand beside before working, or null when unplaced (Law 13).
function startNearPlayer() { return readMandate().startNear; }

// stationOwnerKey — whose shelf this is: a contractor stamps its owner, a homesteader or builder stamps its own commons (Law 27).
function stationOwnerKey() { return ownerKeyFor(currentMode(), currentOwner()); }

// ownerKeyFor(mode, owner) — same answer as stationOwnerKey, for a caller with no mandate of its own (the foreman, checking whether a base exists); pure (Law 16: one rule, two askers).
//   a contractor → the person it belongs to
//   a homesteader or a builder → that species' commons, its own name
function ownerKeyFor(mode, owner) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`CODING VIOLATION (Law 13): ownerKeyFor needs a species, got '${mode}' — valid: ${[...VALID_MODES].join(' | ')}.`);
  }
  if (mode === BOT_MODES.CONTRACTOR) {
    if (!owner) throw new Error('CODING VIOLATION (Law 13): ownerKeyFor(contractor) needs the person it belongs to.');
    return owner;
  }
  return mode;
}

// buildingRoomKey(name) — which base a structure belongs to, derived from the mandate, never passed in (Law 27).
function buildingRoomKey(name) {
  if (!name || typeof name !== 'string') {
    throw new Error(`CODING VIOLATION (Law 13): buildingRoomKey needs a room name, got '${name}'. `
      + 'A room key with no structure in it addresses nothing.');
  }
  return `${name}${BUILDING_ROOM_SEPARATOR}${stationOwnerKey()}`;
}

// homeBlueprint — this body's home structure, read from architect_config.ALPHA_STRUCTURE (Law 16):
// headframe, contractor house, laydown yard. Required lazily since architect_config loads this file.
function homeBlueprint() { return require('@thinking/architect_config').ALPHA_STRUCTURE[currentMode()]; }

// mountsHumanChannels — asked by every in-game-facing subsystem before it installs itself; branched at
// MOUNT time, never at handle time.
function mountsHumanChannels() { return isContractor(); }

// validateOrigin — a command must say where it entered the fleet, not a permission check; rides the watcher trace (Law 25), refusing only an unstamped command (Law 13).
function validateOrigin(verb, origin) {
  if (!VALID_ORIGINS.has(origin)) {
    throw new Error(
      `CODING VIOLATION (Law 13): command '${verb}' arrived with origin='${origin}' — every command ` +
      `must declare where it entered the fleet (${[...VALID_ORIGINS].join(' | ')}). An unstamped ` +
      'command cannot be recorded truthfully.'
    );
  }
  return origin;
}

// THE MAGNET FILTER — WHICH WORK THIS SPECIES IS ALLOWED TO PULL OFF THE BOARD
// job_board posts everything it can see; the species question is asked once, here, at claim time, so
// every bot's picture of the board stays identical. A magnet is both a priority marker (dispatcher
// SECTION 2 writes it on claim) and this filter, the same fact: what a bot is attracted to — CATEGORIES,
// never ranks, since a rank is composed per sweep and unstable (Law 16).
// HOMESTEADER pulls the whole board. CONTRACTOR pulls local survival and its own tool kit only, going
// idle with no order by design. BUILDER pulls the homesteader's board minus busywork and `contractor`.
const MAGNET_FILTERS = Object.freeze({
  [BOT_MODES.HOMESTEADER]: Object.freeze(['preconditions', 'bot', 'blueprint', 'chest', 'busywork']),
  // Blueprint/chest requirement rows are now generated per species (Law 27); busywork stays out, idle
  // filler a hired crew must not invent for itself.
  [BOT_MODES.CONTRACTOR]:  Object.freeze(['preconditions', 'bot', 'contractor', 'blueprint', 'chest']),
  [BOT_MODES.BUILDER]:     Object.freeze(['preconditions', 'bot', 'blueprint', 'chest']),
});

// LOAD-TIME VALIDATION — three ways this table goes wrong silently, each producing an idling bot rather
// than a thrown error, so all three are checked at require time.
const KNOWN_CATEGORIES = new Set(CATEGORY_NAMES);

// 1. A species with no filter (Law 13 — a missing field is a fault, never a value).
for (const mode of Object.values(BOT_MODES)) {
  if (!MAGNET_FILTERS[mode]) {
    throw new Error(
      `CODING VIOLATION (Law 13): BOT_MODES declares species '${mode}' but MAGNET_FILTERS gives it no ` +
      'filter, so nothing can say which jobs it may claim. Every species names its categories here.'
    );
  }
}

// 2. A category name that does not exist — a typo silently loses that whole band of work.
for (const [mode, categories] of Object.entries(MAGNET_FILTERS)) {
  for (const category of categories) {
    if (!KNOWN_CATEGORIES.has(category)) {
      throw new Error(
        `CODING VIOLATION (Law 13): the '${mode}' magnet names category '${category}', which ` +
        `JOB_TYPES does not declare — valid: ${CATEGORY_NAMES.join(' | ')}.`
      );
    }
  }
}

// 3. A category no species can claim — posted forever, pulled by nobody, never named in the held-jobs
//    report since it was never held.
const CLAIMABLE_SOMEWHERE = new Set(Object.values(MAGNET_FILTERS).flat());
for (const category of CATEGORY_NAMES) {
  if (!CLAIMABLE_SOMEWHERE.has(category)) {
    throw new Error(
      `CODING VIOLATION (Law 13): JOB_TYPES declares category '${category}' but no species' ` +
      'magnet claims it, so every job ranked in it would be posted forever and taken by nobody. Add it ' +
      'to a filter in MAGNET_FILTERS, or remove the category.'
    );
  }
}

// claimableCategories — what THIS body's magnet pulls; frozen, so a caller cannot widen its own species.
function claimableCategories() { return MAGNET_FILTERS[currentMode()]; }

// magnetRefusal — the one question the dispatcher asks of a job; returns a REASON, not a boolean
// (Law 6), naming what it passed over.
// Reads `job.asker`, the band job_ranking already stamped (Law 16); not a gate in job_gates' sense: the
// answer differs per bot, not one verdict for the fleet.
function magnetRefusal(job) {
  const category = job.asker;
  if (claimableCategories().includes(category)) return null;
  return `${category} is outside the ${currentMode()} magnet`;
}

// For the banner and the watcher trace — a run must be able to say which species it is.
function describeMandate() {
  const m = readMandate();
  // The magnet is named too: the species alone does not say what the bot will DO.
  const magnet = ` · magnet: ${MAGNET_FILTERS[m.mode].join(', ')}`;
  if (m.mode === BOT_MODES.CONTRACTOR) return `${m.botId}: CONTRACTOR — answers to ${m.owner} (spawned in-game)${magnet}`;
  if (m.mode === BOT_MODES.BUILDER) return `${m.botId}: BUILDER — answers to nobody, fears no night (spawned by the foreman)${magnet}`;
  return `${m.botId}: HOMESTEADER — answers to nobody (started from the terminal)${magnet}`;
}

// Tests and the probe harness need a clean slate between simulated boots; not part of the running
// fleet's normal surface.
function _resetForTesting() { mandate = null; }

module.exports = {
  ORIGIN,
  readMandate,
  currentMode,
  currentOwner,
  buildingRoomKey,
  isContractor,
  isHomesteader,
  isBuilder,
  beginsWorkAtBirth,
  startNearPlayer,
  fearsTheNight,
  stationOwnerKey,
  ownerKeyFor,
  homeBlueprint,
  mountsHumanChannels,
  claimableCategories,
  magnetRefusal,
  validateOrigin,
  describeMandate,
  _resetForTesting,
};
