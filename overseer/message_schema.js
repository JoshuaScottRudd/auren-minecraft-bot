// overseer/message_schema.js
// Typed message envelope for all WebSocket communication between bots and the
// overseer. Both sides require this file so the contract stays in one place.
//
// Law 10: every message conforms to a defined schema.
// Law 7: names are plain and self-documenting.
//
// The envelope separates routing metadata (type, bot_id, timestamp) from
// payload data (the content that varies per message type).

'use strict';

const { guardExternalSync } = require('../js_kernel/utils/external_library_guard');

// Bot → Overseer:
//   'register'       — bot announces itself on first connect (payload: boardroom_chair,
//                      logistics_stations)
//   'hq_delta'       — bot sends its boardroom chair + logistics station map + fleet
//                      structure entries (partial HQ state update; payload:
//                      boardroom_chair, logistics_stations, building_conference)
//   'claim_request'  — bot wants exclusive hold on a world object ('anchor:…',
//                      'tree:…', 'cell:…' — lock the object, not the bot;
//                      payload: { key }). Arbiter flavor (a) — see the taxonomy
//                      in overseer_brain.js.
//   'claim_release'  — bot releases a key it previously claimed (payload: { key })
//   'planning_request' — bot asks for the planning token (plan-phase mutex,
//                      arbiter flavor b; no payload). Never rejected: a loser is
//                      QUEUED and receives 'planning_granted' when its turn
//                      comes. A re-request from the holder is a renewal heartbeat.
//   'planning_release' — bot has finished its plan phase (magnet claimed AND
//                      synced); the overseer promotes the next waiter (no payload)
//   'log'            — one already-formatted watcher line (summary/warn/error), forwarded so the
//                      overseer can print every bot's stream in one place tagged by bot
//                      (payload: { line }). Display only — the overseer never acts on it (Law 3).
//
// Operator → Overseer (fleet_control, headless surface):
//   'operator_command' — a console verb arriving over the socket instead of the
//                      overseer's TTY (payload: { verb: 'start' | 'stop' | 'flush' | 'wipe' | … }).
//                      Same validation, same broadcast pathway as a typed verb
//                      (Law 16: two transports, one implementation). bot_id is the
//                      operator client's label, not a bot.
//
// Overseer → Bot:
//   'registered'      — overseer acknowledges the bot
//   'hq_broadcast'    — overseer sends all other bots' boardroom chairs, the merged
//                       logistics station map, and the merged fleet structures
//                       (payload: bot_boardroom, logistics_stations, building_conference)
//   'claim_granted'   — object claim approved, bot may proceed
//   'claim_rejected'  — object claim denied, another bot holds it
//   'planning_granted' — the planning token is now this bot's; sent immediately
//                       when free, or later when the bot is promoted off the
//                       wait queue (no payload). The ONLY response to
//                       'planning_request' — there is no planning_rejected.
//   'command'         — operator console verb broadcast to every bot
//                       (payload: { verb: 'start' | 'stop' | 'flush' | 'wipe' | … })

const VALID_TYPES = new Set([
  'register',
  'hq_delta',
  'claim_request',
  'claim_release',
  'planning_request',
  'planning_release',
  'log',
  'operator_command',
  'registered',
  'hq_broadcast',
  'claim_granted',
  'claim_rejected',
  'planning_granted',
  'command',
  'command_result',
  // The in-game door's vocabulary: a verb and its verdict, a question about who is out there and whose
  // they are, and a standing requirement with its answer. Nothing else is spoken on that door — see
  // onIngameConnection for why the surface is kept this small.
  'fleet_query',
  'fleet_state',
  // A REQUEST IS NOT AN OPERATOR VERB and travels as its own type: a verb is a command delivered to
  // bodies now, a request is a fact written down that no body is told about. Both ends of it were built
  // — the desk sends it, the overseer answers it — and this table was not, so every `request`, `cancel`
  // and read-back a human spoke died at `createEnvelope` with the desk telling them the fleet does not
  // know the message. A typed contract that does not name a message in use is not a stricter contract,
  // it is a wire nothing can cross (Law 10).
  'request_command',
  'request_result',
]);

// ── HOW A BUILDING ROOM IS ADDRESSED (shared contract) ───────────────────────
// A building_confrence_room key is `<room>|<owner>` — the structure, then whose base it belongs to.
//
// THE OWNER USED TO BE ABSENT, AND ITS ABSENCE WAS THE DEFECT. The room was keyed by the structure alone
// on the premise that "the fleet has ONE of each structure", which was true while the fleet held one
// species answering to nobody. It stopped being true the day a contractor was born owned: two humans each
// fetch a crew, and both crews contend for the single `contractor_house` entry — one human's home silently
// becomes the other's, and neither can move it without moving both. The structure a person is ACCOUNTABLE
// for was the one piece of fleet memory carrying no record of who that person is.
//
// SUFFIXED, MATCHING station_registry.stationKey EXACTLY, and for the same reason it is a keycard rather
// than a check: the owner half is derived from the writing process's own mandate (bot_mandate.buildingRoomKey),
// so a bot cannot FORM a key belonging to another crew. The write surface closes by the shape of the key
// and there is nothing left to police (Law 27).
//
// THE READ IS NOT NARROWED BY IT, and that distinction is what preserves the property the shared room was
// protecting. find_buildingspot.getExistingFootprints walks EVERY entry in the room and rejects overlaps
// against all of them, so crews still refuse to site on top of each other's buildings — they simply no
// longer share one. Read everyone's, write only your own; the same split station_registry runs between
// its raw map and its owner-gated `mine`.
const BUILDING_ROOM_SEPARATOR = '|';

// roomKeyName(key) → the structure half: `contractor_house|Architect` → `contractor_house`.
//
// EVERY CONSUMER THAT RESOLVES A KEY TO A BLUEPRINT MUST GO THROUGH HERE. getExistingFootprints and
// getAllProtectedBlocks both resolve a room key to a blueprint name as
// `entry.blueprint_paster.building_name || key`, and that fallback hands `contractor_house|Architect` to
// blueprintRegistry, which throws on a name no blueprint has. The chair is written by set_buildspot in
// the same call as the key, so the fallback should never fire — but a fallback that is wrong when it
// fires is a trap rather than a fallback (Law 13).
function roomKeyName(key) {
  const s = String(key || '');
  const at = s.lastIndexOf(BUILDING_ROOM_SEPARATOR);
  return at === -1 ? s : s.slice(0, at);
}

// roomKeyOwner(key) → whose base this is, or null for a key written before the owner axis existed.
//
// NULL IS THE COMMONS, NOT A MISSING FIELD, and it is the identical reading station_registry gives an
// entry with no owner: the axis postdates every room written without it, so an unsuffixed key belongs to
// nobody in particular and no human's `wipe` may take it. Law 13 forbids defaulting a missing field —
// this does not default one, it reports the absence as the fact it is.
function roomKeyOwner(key) {
  const s = String(key || '');
  const at = s.lastIndexOf(BUILDING_ROOM_SEPARATOR);
  return at === -1 ? null : (s.slice(at + 1) || null);
}

// ── Fleet-structure merge rule (shared contract) ─────────────────────────────
// The fleet has ONE of each structure PER OWNER — one home per base. A building_confrence_room
// entry is "established" once set_buildspot stamped locked_at; when two bots'
// entries collide (split-brain reconnect, crash recovery), the FIRST writer
// wins — freshness (stations' LWW) would be wrong here, because a later
// duplicate spot must never beat the original home. Lives in this file because
// bot and overseer must apply the IDENTICAL rule or their merged views diverge
// (Law 16: one definition). Deterministic on ties (Law 19): coordinate string.
//
// THE OWNER IN THE KEY IS WHAT MAKES THIS RULE CORRECT AGAIN rather than merely deterministic. Two crews
// belonging to two humans no longer collide at all — they hold different keys — so first-writer-wins is
// back to arbitrating what it was written for: the same crew's own split-brain, where the earlier lock
// genuinely is the home. Before the owner axis it was silently arbitrating between two PEOPLE, and
// deciding one of them did not have a house.
// ── TOMBSTONES, AND WHY A DELETE CANNOT WORK HERE ────────────────────────────
// A wiped building is REPLACED BY A TOMBSTONE, never removed from the map, and this is the identical
// lesson mergeBroadcastStations records against its own history: *"A local delete cannot survive this
// function — the loop reads INCOMING keys, so a key that is absent is no-news and the remembered entry
// stays."* Buildings have it worse than stations. Every bot re-broadcasts its WHOLE room, including rooms
// it merely adopted from a peer, so one homesteader that never belonged to the wiping human still holds a
// copy of their old house and hands it straight back on its next update. A delete would look like it
// worked, for one broadcast interval.
//
// A TOMBSTONE AND A LOCK ARE TWO EVENTS ON ONE KEY, so they are decided by WHICH HAPPENED LATER, and that
// is the one place last-writer-wins is correct in this function. A wipe after a lock erases the base; a
// re-site after a wipe establishes the new one. First-writer-wins still governs LOCK against LOCK, which
// is the split-brain case it was written for and the case where a later duplicate must never beat the
// original home.
function isBuildingTombstone(e) {
  return !!(e && typeof e === 'object' && e.removed_at);
}

function pickBuildingEntry(current, incoming) {
  const lockAt = (e) => {
    const t = e?.set_buildspot?.locked_at ? Date.parse(e.set_buildspot.locked_at) : NaN;
    return Number.isNaN(t) ? Infinity : t;
  };
  if (!current) return incoming;
  if (!incoming) return current;

  // Tombstone against lock: later event wins. A tombstone with no readable stamp is treated as older than
  // any dated lock rather than defaulting to the destructive reading (Law 13 — the safe side of an
  // unreadable field is the one that does not erase a home).
  const curDead = isBuildingTombstone(current);
  const incDead = isBuildingTombstone(incoming);
  if (curDead || incDead) {
    const when = (e) => (isBuildingTombstone(e) ? (Number(e.removed_at) || 0) : lockAt(e));
    const c = when(current);
    const i = when(incoming);
    if (c === i) return curDead ? current : incoming;   // deterministic on a tie (Law 19)
    return c > i ? current : incoming;
  }

  const curAt = lockAt(current);
  const incAt = lockAt(incoming);
  if (curAt === Infinity && incAt === Infinity) return current;   // neither established — keep local
  if (curAt !== incAt) return curAt < incAt ? current : incoming;
  const key = (e) => {
    const c = e?.set_buildspot?.build_center || {};
    return `${c.x},${c.y},${c.z}`;
  };
  return key(current) <= key(incoming) ? current : incoming;
}

function createEnvelope(type, botId, payload) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`message_schema: unknown message type '${type}'`);
  }
  return {
    type,
    bot_id: botId,
    payload: payload || {},
    timestamp: new Date().toISOString(),
  };
}

// A LAW 23 GATE, AND THEREFORE A VERDICT RATHER THAN A THROW. Everything arriving here came off a
// socket from another process, so a malformed message is a CLAIM that failed verification — the
// expected outcome of a gate, not a defect in this process. Law 16 forbids a catch from being the
// expected pathway, so the rejection travels as a return value and both callers discard the message
// and name it. JSON.parse is the one real boundary inside.
// → { ok: true, msg } | { ok: false, reason }
function parseEnvelope(raw) {
  const decoded = typeof raw === 'string'
    ? guardExternalSync('message_schema', 'JSON.parse of an inbound envelope', () => JSON.parse(raw))
    : { ok: true, value: raw };
  if (!decoded.ok) return { ok: false, reason: `not valid JSON — ${decoded.reason}` };

  const msg = decoded.value;
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'message is not an object' };
  if (!VALID_TYPES.has(msg.type)) return { ok: false, reason: `unknown message type '${msg.type}'` };
  if (!msg.bot_id || typeof msg.bot_id !== 'string') return { ok: false, reason: `missing or invalid bot_id in '${msg.type}' message` };
  return { ok: true, msg };
}

// OPERATOR_VERBS — the operator vocabulary, in the file all three processes already share.
//
// It lived in THREE places (fleet_control's sendVerb, the overseer's runOperatorVerb, the bot's
// operator_commands) and a verb had to be added to all three or it died silently in the middle: the
// sender accepted it, the overseer answered 'unknown verb' to its own log, and the bot never heard.
// Law 16: one capability, one definition — centralizing the vocabulary here removes that failure mode.
//
// Here and not in operator_commands (which is the natural owner of the BEHAVIOUR) because the other
// two are separate OS processes: requiring operator_commands into the overseer would boot a bot's
// watcher inside the coordinator. A vocabulary is data and travels; the implementation stays put.
const OPERATOR_VERBS = new Set([
  'start',          // begin the autonomous planning loop
  'stop',           // stop the bots cleanly (overseer + server stay up)
  'flush',          // cold-reset corporate HQ — EVERY owner's, fleet-wide
  'wipe',           // clear ONE owner's places — their stations and their buildings, nobody else's
  'surveylayout',   // dry-run base-layout pre-flight; locks nothing
  'sentry',         // combat in isolation — the planning recursion stays off
  'move',           // one live locomotion leg to an authored cell — the test verb, no recursion
  'respawn',        // send the respawn packet to a dead body — the ONLY route in from outside the process
]);

// INGAME_VERBS — the subset a human speaking inside the world may say. A STRICT SUBSET of the set above,
// asserted at load below rather than trusted.
//
// WHY THE TWO SETS ARE NOT ONE. The foreman's help page is built by mapping a verb set to help lines, and
// it mapped OPERATOR_VERBS — the OPERATOR's console vocabulary, which is what this file's parent set says
// it is. So every verb the terminal gained was automatically offered to a stranger standing in the world,
// and the foreman's own load-time throw then enforced that the two stayed identical. The throw was right;
// the set it enforced against was the wrong one. Five of the seven verbs it published were bench
// instruments — `move` is a single locomotion leg with the planner off, `surveylayout` writes its entire
// output to a trace file no player can open, `respawn` duplicates death_manager for a body whose planner
// is running, `sentry` switches the planner off with no in-game word to switch it back — and one,
// `flush`, was actively dangerous (see below).
//
// THE SET IS ENFORCED BY THE OVERSEER, NOT BY THE FOREMAN, and that is the whole reason it lives here.
// The foreman is the only thing that speaks on the in-game door today, so a check inside the foreman
// would be the foreman promising to behave — and the two-listener design exists precisely because a
// guarantee resting on a sender's honesty is not one (Law 23: an inbound field is a claim). runOperatorVerb
// refuses a verb outside this set when the origin it OBSERVED is INGAME, which is a fact about which
// socket accepted the connection rather than anything the sender said about itself.
//
// WHY `flush` IS NOT IN IT, AND `wipe` IS. Accountability sets the bound on authority, and the two verbs
// sit at two different scopes of it. `flush` empties the SHARED fleet mirror — merged stations, merged
// structures, and every human's standing requests — so one person saying it erases work that other people
// are accountable for and answer for. That reaches past the door's own promise ("only YOUR bots hear it").
// The operator's terminal keeps it, because at the terminal the whole fleet is one person's
// responsibility and the fleet-wide radius is exactly their share. `wipe` is the same authority granted
// at the scope a player actually owns: their stations, their buildings, keyed by their own name, nobody
// else's row touched.
const INGAME_VERBS = new Set([
  'stop',           // the one interrupt — they stop and leave, immediately
  'wipe',           // forget MY places, so I can move base
]);

for (const verb of INGAME_VERBS) {
  if (!OPERATOR_VERBS.has(verb)) {
    throw new Error(`message_schema: CODING VIOLATION (Law 13): INGAME_VERBS names '${verb}', which is not `
      + `an operator verb (${[...OPERATOR_VERBS].join(' | ')}). The in-game door would accept a word the `
      + 'fleet has no implementation for, and the refusal would arrive at a bot rather than at the door.');
  }
}

// COMMAND_ORIGIN — where an operator verb ENTERED the fleet, in the same file and for the same
// reason as OPERATOR_VERBS above: three separate OS processes have to agree on it, and a vocabulary
// is data that travels while an implementation stays put.
//
// It exists because the fleet now holds two species. A HOMESTEADER answers to nobody and a
// CONTRACTOR is built for human use, and the line between them cannot be drawn with a list of
// forbidden verbs — `exit` must still reach a homesteader from the operator's console and must never
// reach one from a human in the world. Same verb, same bot, different answer, and the only thing
// that separates the two cases is where the words came from. So origin travels with every command.
//
// WHO IS ALLOWED TO SAY IT: the overseer, and only from what it OBSERVED — which socket spoke. It is
// never copied from a claim the sender makes about itself, because a claim is exactly what Law 23
// says an inbound message is. A bot receiving a command cannot verify the stamp, which is the whole
// reason the stamping has to happen at the one place that can.
const COMMAND_ORIGIN = Object.freeze({
  TERMINAL: 'terminal',   // the operator's own console, or fleet_control acting on their behalf
  INGAME:   'ingame',     // a human speaking inside the world, relayed by the doorman
});
const VALID_ORIGINS = new Set(Object.values(COMMAND_ORIGIN));

// THE IN-GAME DOOR IS A SECOND LISTENER, AND THAT IS WHAT MAKES THE ORIGIN OBSERVED RATHER THAN CLAIMED.
//
// The origin table above is only worth having if the stamp is a FACT. On one socket it cannot be: every
// client reaches the same listener, so the overseer has nothing to read but a label the sender chose for
// itself — and a sender able to name its own origin can name the privileged one, leaving the two species
// separated by the honesty of whoever connected (Law 23: an inbound field is a claim, never a fact).
//
// Two listeners make it a fact with no check anywhere. The overseer stamps by WHICH OF ITS OWN SERVERS
// accepted the connection, which is something it observed rather than something it was told, and no
// message on the in-game door can carry terminal authority however it is spelled. This is the Law 26
// translator: the door is the interface a mind reaches the machine through, and the machine's guarantee
// is that the door it came through is the one it came through.
//
// AN OFFSET RATHER THAN A PORT, because the main port is an operator flag (`--port`) and a fixed second
// number would collide with a fleet moved off the default while looking like it had simply gone deaf.
const INGAME_DOOR_PORT_OFFSET = 1;

module.exports = { createEnvelope, parseEnvelope, pickBuildingEntry, isBuildingTombstone, VALID_TYPES, OPERATOR_VERBS, INGAME_VERBS, COMMAND_ORIGIN, VALID_ORIGINS, INGAME_DOOR_PORT_OFFSET, BUILDING_ROOM_SEPARATOR, roomKeyName, roomKeyOwner };
