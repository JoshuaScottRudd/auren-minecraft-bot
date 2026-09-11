'use strict';
// bot_mandate.js — WHAT SPECIES THIS PROCESS IS, decided at birth and never again.
//
// THE ARCHITECT'S RULING, which is the whole specification:
//
//   "the way a bot is started from outside the terminal needs to be functionally isolated and
//    different from in game so no homesteader recieves any commands from a human. they are a
//    different species, they do whatever they want and never care about what humans want. the
//    contractor is the opposite."
//
// A CONTRACTOR IS AN OVERRIDDEN HOMESTEADER. That is the Architect's model and it is the whole file:
//
//   "there should be no anti logic. meaning guarding against a homesteader to be a contractor.
//    contractor is an overrided homesteader. thats the main difference between the two."
//
// So the two species differ by what a contractor ADDS, never by what a homesteader is prevented from
// doing. A homesteader is the base bot: it works, it answers the operator's console, it wants nothing
// from anybody. A contractor is that same bot with the human channels mounted on top — the foreman's
// ear, the order desk, the acknowledgement line.
//
// ── THE MODEL, AMENDED ONCE, ON ONE AXIS ONLY (Architect 2026-08-26) ─────────────────────────────────
// The sentence above is still true of the CHANNELS and it is why nothing here guards. It is no longer
// the whole file, because a second axis arrived: WHICH WORK A SPECIES MAY TAKE (the magnet filter, at
// the foot of this file). On that axis a contractor is not a superset — it takes strictly LESS of the
// autonomous agenda than a homesteader, in exchange for the human channels only it has.
//
//   "the homesteader is able to do everything on the job board right now. i have not added any
//    contractor jobs to the job board yet so snap whats on job board now and thats what homesteader
//    does. contractor will do less than whats on the board and ill add contractor specific jobs later."
//
// AND IT IS STILL NOT ANTI-LOGIC, for exactly the reason the channels are not. The filter is an
// ALLOWLIST read at claim time — the dispatcher asks the magnet WHICH JOBS IT ATTRACTS and chooses from
// that answer. It is not a check that refuses a job a bot reached for. A category outside a species'
// filter is not forbidden to it; it is invisible to it, the same way the foreman's ear is not locked
// against a homesteader but simply never installed. Absence again, one axis further out.
//
// NO GUARD EXISTS AND NONE IS NEEDED, and the reason is worth stating because an earlier revision of
// this file got it wrong. That revision carried an `assertMayObey` that THREW when an in-game command
// reached a homesteader. It was defending the wrong pathway: `start`, `stop` and `flush` are the
// operator's verbs and they mean exactly the same thing to both species — the operator must be able
// to run either one from the console. The difference was never which verbs a bot accepts. It is that
// a contractor additionally LISTENS to humans, and a homesteader simply has no such listener.
//
// Absence is the isolation. `mountsHumanChannels()` is false for a homesteader, so the ear is never
// installed, so there is nothing to refuse and nothing to guard. A check that refuses a message that
// cannot be constructed is anti-logic: it reads as though the door is locked when in truth there is
// no door, and it invites a future reader to relax the lock rather than notice the absence.

const {
  BOT_MODES,
  // The category vocabulary. Imported rather than restated: the magnet filter below names categories,
  // and a category name that does not exist in JOB_TYPES is a filter that silently matches nothing
  // (Law 16 — one table, and it is the Architect's, not ours).
  CATEGORY_NAMES,
} = require('@thinking/architect_config');

// COMMAND ORIGIN — where an operator verb entered the fleet. It travels with every command because
// the isolation is a question about TRANSPORT, not about the verb. `stop` is the proof: the Architect
// must still be able to end a homesteader from the console, so `stop` cannot be a forbidden word. It
// simply never reaches one from the world, because a homesteader mounts no ear for it to arrive at.
// Taken from the schema all three processes share rather than declared again here — a second copy
// of a vocabulary is the exact failure OPERATOR_VERBS' own header records: a value added to one copy
// and not the other, accepted by the sender and unknown to the receiver, dying silently in between.
const { COMMAND_ORIGIN: ORIGIN, VALID_ORIGINS, BUILDING_ROOM_SEPARATOR } = require('@overseer/message_schema');
const VALID_MODES = new Set(Object.values(BOT_MODES));

// The mandate is read ONCE and frozen. Re-reading env per call would let a mode change mid-life,
// which is precisely what "decided at birth" forbids.
let mandate = null;

// readMandate — the ONE place BOT_MODE is interpreted (Law 16).
//
// IT NEVER DEFAULTS, and that is the point of the file rather than an incidental strictness. Law 13:
// a missing field is a fault, never a value. If this defaulted to homesteader, a doorman that forgot
// to stamp the mode would silently spawn a bot that ignores the human who asked for it — the human
// stands there talking to something built not to answer, and nothing anywhere reports a fault. If it
// defaulted to contractor, a mis-wired terminal launch would produce a bot that takes orders from
// strangers. Both defaults are a wrong answer that still runs. So: absent mode, no bot.
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

  // ── WHOSE BOT THIS IS, decided at birth alongside WHAT it is ─────────────────────────────────────
  // THE OWNER IS PART OF THE SPECIES, NOT A SETTING BESIDE IT. A contractor exists because a particular
  // person in the world asked for one, so an ownerless contractor is not under-configured — it is a
  // contradiction that would quietly become everyone's bot at the moment a second human speaks. A
  // homesteader is the exact mirror: it answers to nobody, so an owner on one names a relationship
  // nothing can honour. Both are refused here, which is what makes the pairing impossible to get wrong
  // anywhere downstream — the delivery filter never has to ask whether a bot is a legitimate ownerless
  // contractor, because no such process can boot (Law 27: constitute the fact, do not police the actor).
  const rawOwner = env.BOT_OWNER;
  const owner = rawOwner === undefined || rawOwner === null ? '' : String(rawOwner).trim();
  if (mode === BOT_MODES.CONTRACTOR && owner === '') {
    throw new Error(
      'CODING VIOLATION (Law 13): BOT_MODE=contractor with no BOT_OWNER. Every contractor belongs to the ' +
      'human who asked for it; an ownerless one would take orders from anybody in the world. Launch it ' +
      'with --owner=<player>.'
    );
  }
  if (mode === BOT_MODES.HOMESTEADER && owner !== '') {
    throw new Error(
      `CODING VIOLATION (Law 13): BOT_MODE=homesteader with BOT_OWNER='${owner}'. A homesteader answers ` +
      'to nobody, so it cannot belong to anyone. Either the mode or the owner is wrong.'
    );
  }
  // A PLAYER MAY NOT BE NAMED AFTER THE COMMONS. `stationOwnerKey` stamps a homesteader's shelves with
  // this mode's own name, so a human called the same thing would have their crew's chests indexed under
  // the key every homesteader reads — two owners silently sharing one shelf, which is the exact fault
  // the owner axis exists to make impossible. Refused here rather than at the stamp because a name is a
  // birth fact: the contradiction is knowable the moment the process is handed one.
  if (mode === BOT_MODES.CONTRACTOR && owner.toLowerCase() === BOT_MODES.HOMESTEADER) {
    throw new Error(
      `CODING VIOLATION (Law 13): BOT_OWNER='${owner}' collides with the commons key '${BOT_MODES.HOMESTEADER}'. ` +
      'Station ownership stamps that word for shelves every homesteader shares, so this crew would read ' +
      'and write the commons as if it owned it. This player cannot be given a crew under that name.'
    );
  }

  // ── WHETHER THIS BODY BEGINS WORKING THE MOMENT IT SPAWNS, settled at birth like the rest ────────
  // A LAUNCH FACT, so it is frozen here beside the species rather than read from env at the moment it
  // is consulted. Re-reading it later would let a bot's own runtime decide whether it had been told to
  // work, which is the same mid-life mutation the mode freeze exists to forbid.
  //
  // It answers ONE question — see beginsWorkAtBirth for who asks it and why a homesteader needs asking
  // at all. Only a homesteader consults this value: a contractor is born started by constitution, so
  // the flag on one says nothing the species has not already said.
  const autostart = String(env.BOT_AUTOSTART === undefined ? '' : env.BOT_AUTOSTART).trim() === '1';

  // ── WHICH PERSON THIS BODY MUST BE STANDING BESIDE BEFORE IT WORKS (Architect 2026-09-10) ────────
  // *"the system now uses a player as the starting point. both homesteader and contractors must
  // teleport to a player."*
  //
  // A BIRTH FACT LIKE THE REST, frozen here rather than read from env when consulted, for the mode
  // freeze's reason: a body that could re-read this later could decide mid-life that it had been
  // placed. `start_injector` is the one consumer — see `startNearPlayer` for the gate it feeds.
  //
  // A CONTRACTOR FALLS BACK TO ITS OWNER, and that is a DERIVATION rather than a defaulted field
  // (Law 13): the owner is by constitution the person who asked for this body, so it is the same fact
  // already in hand under another name. Requiring the desk to spell it twice would be two answers to
  // "who is this crew standing with", and they would part company the first time either was touched
  // (Law 16). A homesteader has no owner to fall back to, so an unplaced one is genuinely unplaced.
  const rawNear = env.BOT_START_NEAR;
  const nearGiven = rawNear === undefined || rawNear === null ? '' : String(rawNear).trim();
  const startNear = nearGiven || (mode === BOT_MODES.CONTRACTOR ? owner : '');

  mandate = Object.freeze({ botId: String(botId).trim(), mode, owner: owner || null, autostart, startNear: startNear || null });
  return mandate;
}

function currentMode() { return readMandate().mode; }
// currentOwner — the player this body belongs to, or null for a homesteader. Null is the ANSWER here
// rather than a missing value: readMandate refuses to produce an ownerless contractor, so no consumer
// has to tell "answers to nobody" apart from "the owner was never read".
function currentOwner() { return readMandate().owner; }
function isContractor() { return currentMode() === BOT_MODES.CONTRACTOR; }
function isHomesteader() { return currentMode() === BOT_MODES.HOMESTEADER; }

// beginsWorkAtBirth — does this body inject its own start signal on spawn, or stand there waiting to be
// told? Asked once, by master_core, at the end of the spawn sequence.
//
// A CONTRACTOR ALWAYS DOES, by constitution — being fetched is what starting means for it, and
// master_core's own header states why that gap was closed rather than policed.
//
// A HOMESTEADER DOES WHEN WHOEVER RAISED IT SAID SO, and that clause exists because of a hole found live
// on 2026-09-09. The species rule was "a homesteader waits for the operator's `start`", which is coherent
// only where the operator has something to send it with. The Architect has `fleet_control`; that is
// WORKSHOP equipment and does not ship. So in the extract the verb had exactly one remaining sender —
// typing `start` at master_core's readline — and anything raising a CREW cannot use it: those children
// share one inherited stdin, so the line lands on whichever process happens to read first. Two
// homesteaders were raised against a live server and sat at eight trace lines each — joined, registered,
// and permanently idle, because nothing in the shipped layer could reach them.
//
// THE ANSWER IS THE CONTRACTOR'S ANSWER, not a second mechanism (Law 16). The same injector fires at the
// same point in the same sequence; only the question of who asked differs. **The foreman is what asks**,
// for both species — a person walked somewhere, said `get homesteader`, and that is the decision
// arriving. So the desk stamps a fact it already knows rather than sending a verb afterwards to police
// the gap it would otherwise have opened (Law 27).
//
// A BARE `start_bot.js` HOMESTEADER STILL WAITS, and deliberately. One bot from a terminal owns that
// terminal's stdin, so `start` at the readline works and is the right shape for looking a body over
// before it does anything. What distinguishes the two is whether the DESK raised this body — it stamps
// `BOT_AUTOSTART` when it fetches one — which is why this is a launch fact and not a species one.
//
// `--work` used to be a second way to say it and was deleted on 2026-09-10 (*"law 16 the system. only
// one way to do it"*). A launcher flag that autostarted a homesteader also bypassed placement, siting a
// base wherever the world dropped the body rather than where a person was standing. The reasoning is in
// `start_bot.js` where the flag lived; nothing here changed except that only the desk now sets the field.
function beginsWorkAtBirth() { return isContractor() || readMandate().autostart; }

// startNearPlayer — the player this body must be standing beside before it begins working, or null when
// nobody placed it. Asked once, by `start_injector`, as the first act of every start.
//
// THE PAIR TO `beginsWorkAtBirth`, and the two answer different halves of one question: that one says
// WHETHER this body starts on its own, this one says WHERE it must be standing when it does. A body is
// raised by a person who walked somewhere, so the placement is the person — not a coordinate, which is
// the whole reason `get` takes no arguments (Architect 2026-09-09: *"you place them by walking
// somewhere"*).
//
// NULL IS THE ANSWER, NOT A MISSING VALUE. It means nobody named a placement, which is exactly the
// hand-launched `start_bot.js` case that `beginsWorkAtBirth`'s header describes — one body, one
// terminal, looked over before it does anything. `start_injector` starts such a body where it stands;
// what it must never do is invent a person to walk it to (Law 13).
function startNearPlayer() { return readMandate().startNear; }

// stationOwnerKey — WHOSE SHELF THIS IS, in the one form the station map indexes by: a contractor
// stamps the human it belongs to, a homesteader stamps the commons every homesteader shares.
//
// DERIVED FROM THE MANDATE, NEVER PASSED IN, and that is the whole guarantee. A caller cannot stamp a
// shelf for somebody else because there is no argument in which to say so, and a bot cannot read
// another owner's shelves because the only key it can form is its own. The restriction is not a rule
// anything enforces — it is the shape of the function (Law 27: constitute the fact, do not police the
// actor). Nothing a human says in the world reaches this value; it is fixed before the body spawns.
function stationOwnerKey() { return isContractor() ? currentOwner() : BOT_MODES.HOMESTEADER; }

// buildingRoomKey(name) — WHICH BASE THIS STRUCTURE BELONGS TO, in the one form building_confrence_room
// indexes by: the structure, then whose base it is.
//
// THE STATION KEYCARD, APPLIED TO THE ONE STORE THAT DID NOT HAVE IT. Stations and standing requests both
// carry the owner in the row key; buildings carried the structure name alone, so `contractor_house` was a
// single entry two humans' crews contended for. The person accountable for a crew could not move their
// own house, and could erase a stranger's by moving it.
//
// DERIVED FROM THE MANDATE, NEVER PASSED IN — the identical guarantee stationOwnerKey carries, and it has
// to be the identical mechanism or the two stores drift: a caller cannot address another crew's base
// because there is no argument in which to name one, so the write surface is closed by the shape of the
// function rather than by anything watching it (Law 27).
//
// A HOMESTEADER STAMPS THE COMMONS and therefore still shares one estate with every other homesteader,
// which is what a homesteader IS. The owner axis does not divide the commons; it separates the humans who
// hold one, and a homesteader holds none.
function buildingRoomKey(name) {
  if (!name || typeof name !== 'string') {
    throw new Error(`CODING VIOLATION (Law 13): buildingRoomKey needs a room name, got '${name}'. `
      + 'A room key with no structure in it addresses nothing.');
  }
  return `${name}${BUILDING_ROOM_SEPARATOR}${stationOwnerKey()}`;
}

// homeBlueprint — WHICH STRUCTURE IS THIS BODY'S HOME, and therefore which chest is the crew's own
// pool and where its haul belongs. A homesteader's home is the estate's headframe; a contractor's is
// the house it sites for the person who hired it.
//
// A SPECIES FACT, SO IT LIVES WITH THE SPECIES. The alternative was each consumer asking `isContractor()`
// and naming a string, which is the same fact written in as many places as it is needed — and the day a
// third species exists, or either name changes, they diverge one at a time with nothing reporting it
// (Law 16). Consumers ask what home is; they never decide it.
function homeBlueprint() { return isContractor() ? 'contractor_house' : 'headframe'; }

// mountsHumanChannels — THE ONE QUESTION, asked by every in-game-facing subsystem before it installs
// itself: the foreman's ear, the order desk, the acknowledgement line.
//
// Callers branch on this at MOUNT time, never at handle time. `if (!mountsHumanChannels()) return;`
// before the listener is attached IS the difference between the species; attaching the listener and
// then dropping messages inside it would be the anti-logic this file refuses to contain.
function mountsHumanChannels() { return isContractor(); }

// validateOrigin — a command must SAY where it entered the fleet, and this checks only that.
//
// It is not a permission check and it does not consult the species. Origin is kept because it is
// true and useful: it rides the watcher trace so a run can say whether a verb came from the console
// or from a human in the world (Law 25), and it is the seam a future multi-human fleet will need to
// tell one human's request from another's. What it is NOT is a gate — nothing is refused on it.
//
// The one thing it does refuse is an UNSTAMPED command, and that is Law 13 field validation rather
// than anti-logic: a message that does not say where it came from cannot be recorded honestly, and
// inventing a plausible origin for it would put a fiction into the trace.
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

// ─────────────────────────────────────────────────────────────────────────────
// THE MAGNET FILTER — WHICH WORK THIS SPECIES IS ALLOWED TO PULL OFF THE BOARD
// ─────────────────────────────────────────────────────────────────────────────
//
// THE BOARD IS ONE BOARD AND IT IS NOT NEGOTIABLE, because the two systems intermingle:
//
//   "because a contractor built building is protected just like a homesteader one. they both go on
//    protected voxels, along with human deeds. because theres intermingling of systems, they need
//    identical job boards and then they filter out what they can use at the mandate level, not the
//    job board level."
//
// So job_board posts EVERYTHING IT CAN SEE and never asks what species is reading it. The species
// question is asked exactly once, here, at the moment a bot reaches for a job. That placement is the
// whole design and it is worth stating why the other one is wrong: a board filtered per species is a
// DIFFERENT BOARD per species, so two bots looking at the same world would hold two different pictures
// of it, and the dedup that keeps two bots off one job (dispatcher's claimed-set) compares job ids
// across those pictures. One board, filtered at the reader, keeps every bot's picture identical and
// makes the species a property of the READER rather than of the world.
//
// A MAGNET WAS A PRIORITY MARKER AND IS NOW ALSO A FILTER. It was only ever the record of what a bot
// had claimed (dispatcher SECTION 2 writes it); the species did not enter into it. It now answers the
// question BEFORE the claim as well — which jobs this body may hold at all — and the two readings are
// the same object because they are the same fact: what this bot is attracted to.
//
// THE FILTER IS CATEGORIES, NEVER RANKS, and that is load-bearing rather than a style choice. A rank is
// COMPOSED per sweep from a measured (asker, stage) pair, so it is not stable across sweeps and not even
// unique to one kind of work — a numeric ceiling here would name a different set of jobs on two
// consecutive boards, and the species it governs would gain and lose whole bands of work with nothing
// said. A category is the authored fact the composition is built FROM, so it means the same thing on
// every board.
//
// ── THE SPECIES, AND WHAT EACH ONE'S MAGNET PULLS ────────────────────────────────────────────────
//
// HOMESTEADER — the whole board as it stands today. It runs itself in totality and answers to nobody,
//   so it needs every asker in the table: its own body, the blueprints, the shared shelf, and the
//   busywork that keeps it from standing still.
//
//   THE LIST IS WRITTEN OUT RATHER THAN DERIVED FROM CATEGORY_NAMES, and that is deliberate
//   ("snap whats on job board now and thats what homesteader does"). Deriving it would mean "whatever
//   categories exist", so the contractor-specific categories the Architect intends to add later would
//   land in the homesteader's magnet the instant they were declared — silently handing human-request
//   work to the one species built to ignore humans. A snapshot makes adding a category a decision
//   instead of an inheritance, and the completeness check below is what forces that decision to be made.
//
// CONTRACTOR — local survival and its own tool kit, and nothing above that line. It stays alive, eats,
//   takes a drop off the ground before it despawns, and keeps its own station, tools, weapon and shield
//   in order. It does not build, farm, sink the shaft, light the base, run the furnaces, fill the shared
//   shelf, or take busywork. What it does instead arrives on the human channels only it mounts, and the
//   categories carrying that work are not on the board yet.
//
//   SO A CONTRACTOR WITH A FULL KIT AND NO ORDER GOES IDLE, AND THAT IS THE INTENDED BEHAVIOUR, not a
//   gap to be closed by lending it busywork. An idle contractor is a bot standing ready for the human
//   who spawned it; a contractor that wandered off to dig a standing cell is one that is not there when
//   asked. `busywork` exists so an autonomous bot is never idle, and being never-idle is a homesteader's
//   requirement, not this species'.
//
// ── EXCLUSIVITY IS THE SHAPE OF THESE TWO LISTS, NEVER A MARK ON A JOB ───────────────────────────
// "Contractor only" and "homesteader only" are not two kinds of magnet — they are the same magnet,
// and a band named by one list and not the other. `blueprint`, `chest` and `busywork` are already
// homesteader-only by this mechanism and nothing anywhere says so; `contractor` is the mirror. The
// wrong turn is a species flag on the job type: the magnet would then be one of two filters that must
// agree, and the day they disagree the board says a job is for a species that cannot claim it (Law 16).
const MAGNET_FILTERS = Object.freeze({
  [BOT_MODES.HOMESTEADER]: Object.freeze(['preconditions', 'bot', 'blueprint', 'chest', 'busywork']),
  // BLUEPRINT AND CHEST WERE WITHHELD AND ARE NOW GRANTED, because what they gated moved. They name
  // work a HOMESTEADER starts by itself off a static table, and a contractor claiming those jobs would
  // have been doing unasked-for work on somebody's land. The requirement rows are now generated per
  // species (`requested_work`), so no assessor can produce that work for a contractor unless a person
  // asked — there is no unasked job left to refuse, and past the asking the two species build by the
  // identical ladder. Gating the claim was a rule needing an enforcer; generating the requirement
  // settles it by definition (Law 27).
  //
  // BUSYWORK STAYS OUT, and it is the one category that does not follow the same argument: it is idle
  // filler a bot invents for itself with nobody asking, which is exactly what a hired crew must not do.
  [BOT_MODES.CONTRACTOR]:  Object.freeze(['preconditions', 'bot', 'contractor', 'blueprint', 'chest']),
});

// ── LOAD-TIME VALIDATION — THE THREE WAYS THIS TABLE GOES WRONG SILENTLY ─────────────────────────────
// Every one of them produces a bot that idles instead of throwing, and an idling bot is the hardest
// fault in this fleet to read: it looks exactly like a bot with no work available. So all three are
// checked at require time, in every process, before a bot exists to be confused by them.
const KNOWN_CATEGORIES = new Set(CATEGORY_NAMES);

// 1. A SPECIES WITH NO FILTER. Law 13 — a missing field is a fault, never a value. An unfiltered species
//    would have to default to all-or-nothing, and both defaults are a wrong answer that still runs.
for (const mode of Object.values(BOT_MODES)) {
  if (!MAGNET_FILTERS[mode]) {
    throw new Error(
      `CODING VIOLATION (Law 13): BOT_MODES declares species '${mode}' but MAGNET_FILTERS gives it no ` +
      'filter, so nothing can say which jobs it may claim. Every species names its categories here.'
    );
  }
}

// 2. A CATEGORY NAME THAT DOES NOT EXIST. A typo matches nothing, so the species quietly loses that
//    whole band of work — and the narrower the filter, the more total the silence.
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

// 3. A CATEGORY NO SPECIES CAN CLAIM — the fault this filter INTRODUCES to the codebase, and the reason
//    this check is worth more than the other two. Before the filter, adding a category to
//    JOB_TYPES was enough to make its jobs dispatchable. Now it is not: a category absent from
//    every magnet is posted by the board forever and pulled by nobody, and the board's own held-jobs
//    report will not name it either, because it was never held — it passed every gate and simply found
//    no reader. This makes adding a category force the question "who may claim it", at require time,
//    which is the only moment the answer is cheap.
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

// claimableCategories — what THIS body's magnet pulls. Frozen at the table, so a caller cannot widen its
// own species by pushing onto the answer.
function claimableCategories() { return MAGNET_FILTERS[currentMode()]; }

// magnetRefusal — THE ONE QUESTION THE DISPATCHER ASKS OF A JOB, and it returns a REASON rather than a
// boolean for the reason job_gates states for its own gates (Law 6): a silent filter looks identical
// whether it is working or dead. The dispatcher prints what the magnet passed over, so a contractor
// sitting still can say "eleven jobs on the board, all blueprint and chest" instead of "idle".
//
// It reads `job.asker` — the band the sweep stamped on the job — rather than looking the job type up in
// the table itself. The two agree today, and the read is still the correct one: the sweep is the single
// place a band is decided (Law 16), so a consumer that re-derives it from the table is a second answer
// waiting to disagree with the first. Read what was decided, never re-decide it.
//
// A job with no `asker` is a job that never passed through job_ranking, which is a coding violation
// rather than something to filter out quietly — the throw is there rather than here, at the one place
// that stamps it.
//
// NOT A GATE IN job_gates' SENSE, and it must not move there. That module answers "may this job be
// offered to anybody right now" — a question about the WORLD (the sun is down, the station is not
// placed), asked once per sweep with one answer for the whole fleet. This asks "may THIS BODY hold it",
// a question about the READER, whose answer differs per bot looking at the same board. Folding it in
// would make the board's held-jobs report species-specific, which is the per-species board the
// intermingling ruling rules out.
function magnetRefusal(job) {
  const category = job.asker;
  if (claimableCategories().includes(category)) return null;
  return `${category} is outside the ${currentMode()} magnet`;
}

// For the banner and the watcher trace — a run must be able to say which species it is without
// forcing every reader to remember the env var's name.
function describeMandate() {
  const m = readMandate();
  // The magnet is named here too, because the species alone no longer tells a reader what the bot will
  // DO. A contractor that takes only two of the five categories and a contractor that takes all five
  // print the same first half of this line, and the difference between them is the whole of this change.
  const magnet = ` · magnet: ${MAGNET_FILTERS[m.mode].join(', ')}`;
  return m.mode === BOT_MODES.CONTRACTOR
    ? `${m.botId}: CONTRACTOR — answers to ${m.owner} (spawned in-game)${magnet}`
    : `${m.botId}: HOMESTEADER — answers to nobody (started from the terminal)${magnet}`;
}

// Tests and the probe harness need a clean slate between simulated boots. Deliberately NOT exported
// as part of the normal surface's contract: nothing in the running fleet may re-decide a species.
function _resetForTesting() { mandate = null; }

module.exports = {
  ORIGIN,
  readMandate,
  currentMode,
  currentOwner,
  buildingRoomKey,
  isContractor,
  isHomesteader,
  beginsWorkAtBirth,
  startNearPlayer,
  stationOwnerKey,
  homeBlueprint,
  mountsHumanChannels,
  claimableCategories,
  magnetRefusal,
  validateOrigin,
  describeMandate,
  _resetForTesting,
};
