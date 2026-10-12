// foreman/message_schema.js
// Typed message envelope for all WebSocket communication between bots and the
// foreman. Both sides require this file so the contract stays in one place.
//
// Law 10: every message conforms to a defined schema.
// Law 7: names are plain and self-documenting.
//
// The envelope separates routing metadata (type, bot_id, timestamp) from
// payload data (the content that varies per message type).

'use strict';

const { guardExternalSync } = require('../js_kernel/utils/external_library_guard');

// Bot → Foreman:
//   'register'          — bot announces itself on first connect (payload: boardroom_chair, logistics_stations)
//   'hq_delta'          — boardroom chair + logistics station map + fleet structure entries, a partial
//                         HQ state update (payload: boardroom_chair, logistics_stations, building_conference)
//   'claim_request'     — bot wants exclusive hold on a world object ('anchor:…', 'tree:…', 'cell:…' —
//                         locks the object, not the bot; payload: { key }). Arbiter flavor (a); taxonomy
//                         in foreman_brain.js.
//   'claim_release'     — bot releases a held key (payload: { key })
//   'planning_request'  — bot asks to enter the planning gate (plan-phase mutex, arbiter flavor b; no
//                         payload { phase: 'planning' | 'workspace', requestId }). Always answered at once: 'planning_granted', or 'planning_queued'
//                         followed by 'planning_granted' when its turn comes.
//   'planning_cancel'   — an abandoned computation leaves the queue or closes its in-flight entry: { requestId }.
//   'body_stood_down'   — the body has stopped working (it lost the world, or a signal died outside the
//                         judge) while its process is still alive: { reason }. The foreman closes its
//                         entry if it is inside the gate and takes it out of the line, as for a disconnect.
//   'planning_release'  — the EXIT TOKEN: bot has finished its plan phase (magnet claimed and synced).
//                         Payload { entry } is the entry number it was granted; the foreman closes
//                         that entry and the next in line enters.
//   'fleet_crash'       — a body is stuck past timeout_crash's limit or found an impossible state;
//                         the whole run ends (payload: { report })
//   'log'               — one formatted watcher line, forwarded so the foreman can print every bot's
//                         stream in one place, tagged by bot (payload: { line, level }). `level` names
//                         the channel — 'summary' | 'warn' | 'error' | 'context' — tallied per bot so a
//                         live supervisor can read whether the fleet has errored (handleLog,
//                         'fleet_state'). The foreman counts the field, never inspects the text (Law 3).
//   'item_book'         — a batch of this body's item moves, pickups, digs, throws and pocket readings
//                         for the fleet's one item book (payload: { entries }; foreman/item_book.js names
//                         each entry kind). No reply.
//
// Operator → Foreman (fleet_control, headless surface):
//   'operator_command'  — a console verb arriving over the socket instead of the foreman's TTY (payload:
//                         { verb: 'start' | 'stop' | 'flush' | 'wipe' | … }). Same validation, same
//                         broadcast pathway as a typed verb (Law 16). bot_id is the operator client's
//                         label, not a bot.
//
// Foreman → Bot:
//   'registered'        — foreman acknowledges the bot
//   'hq_broadcast'      — every other bot's boardroom chair, the merged logistics station map, and the
//                         merged fleet structures (payload: bot_boardroom, logistics_stations, building_conference)
//   'claim_granted'     — object claim approved, bot may proceed
//   'claim_rejected'    — object claim denied, another bot holds it
//   'planning_granted'  — the ENTRY TOKEN: this bot is inside the planning gate; sent immediately when
//                         the gate is free, or later when its turn in the line comes (payload:
//                         { entry, phase, workspace, requestId } — the number its 'planning_release' must carry,
//                         requested phase, and { availableBytes, totalBytes, headroomBytes, reservedBytes, growthBytes, cacheCells, full } or null).
//   'planning_queued'   — the token is held; this bot is in the line (payload: { ahead, holder, requestId,
//                         held_ms } — bodies served before it counting the holder, who holds the token,
//                         and for how long so far).
//   'command'           — operator console verb broadcast to every bot (payload: { verb: 'start' |
//                         'stop' | 'flush' | 'wipe' | … })

const VALID_TYPES = new Set([
  'register',
  'hq_delta',
  'claim_request',
  'claim_release',
  'planning_request',
  'planning_cancel',
  'planning_release',
  'body_stood_down',
  'fleet_crash',
  'log',
  'item_book',
  'operator_command',
  'registered',
  'hq_broadcast',
  'claim_granted',
  'claim_rejected',
  'planning_granted',
  'planning_queued',
  'command',
  'command_result',
  // The in-game door's vocabulary: a verb and its verdict, a question about who is out there and whose
  // they are, and a standing requirement with its answer — nothing else is spoken on that door
  // (onIngameConnection).
  'fleet_query',
  'fleet_state',
  // A request travels as its own type: a verb is a command delivered to bodies now, a request is a fact
  // written down that no body is told about (Law 10).
  'request_command',
  'request_result',
]);

// ── how a building room is addressed (shared contract) ───────────────────────
// A building_confrence_room key is `<room>|<owner>` — the structure, then whose base it belongs to, so
// two owners' crews never contend for one structure slot.
//
// Suffixed, matching station_registry.stationKey: a keycard, not a check. The owner half comes from the
// writing process's own mandate (bot_mandate.buildingRoomKey), so a bot cannot form a key belonging to
// another crew (Law 27).
//
// The read is not narrowed by owner: find_buildingspot.getExistingFootprints walks every entry in the
// room and rejects overlaps against all of them, so crews still refuse to site on top of each other's
// buildings. Read everyone's, write only your own — the split station_registry runs between its raw map
// and its owner-gated `mine`.
const BUILDING_ROOM_SEPARATOR = '|';

// roomKeyName(key) → the structure half of a suffixed key (everything before the last `|`). Every
// consumer resolving a key to a blueprint goes through here: an unresolved key reaches blueprintRegistry
// whole, which throws on a name no blueprint has (Law 13).
function roomKeyName(key) {
  const s = String(key || '');
  const at = s.lastIndexOf(BUILDING_ROOM_SEPARATOR);
  return at === -1 ? s : s.slice(0, at);
}

// roomKeyOwner(key) → whose base this is, or null for a key with no owner suffix. Null is the commons,
// the same reading station_registry gives an unowned entry: it belongs to nobody in particular and no
// human's `wipe` may take it (Law 13).
function roomKeyOwner(key) {
  const s = String(key || '');
  const at = s.lastIndexOf(BUILDING_ROOM_SEPARATOR);
  return at === -1 ? null : (s.slice(at + 1) || null);
}

// ── fleet-structure merge rule (shared contract) ─────────────────────────────
// The fleet holds one of each structure PER OWNER — one home per base. A building_confrence_room
// entry is "established" once set_buildspot stamped locked_at; when two bots' entries collide
// (split-brain reconnect, crash recovery), the FIRST writer wins — freshness (stations' LWW) would let a
// later duplicate spot beat the original home. Lives in this file because bot and foreman must apply the
// IDENTICAL rule or their merged views diverge (Law 16). Deterministic on ties (Law 19): coordinate
// string.
//
// The owner in the key is what makes first-writer-wins correct: two crews belonging to two humans hold
// different keys and never collide, so the rule arbitrates only a single crew's own split-brain, where
// the earlier lock genuinely is the home.
// ── tombstones, and why a delete cannot work here ────────────────────────────
// A wiped building is replaced by a tombstone, never removed from the map: the merge loop reads INCOMING
// keys, so an absent key is no-news and the remembered entry stays. Every bot re-broadcasts its whole
// room, including rooms it only adopted from a peer, so a homesteader unrelated to a wipe still holds a
// copy of the old house and hands it back on its next update.
//
// A tombstone and a lock are two events on one key, decided by which happened later — the one place
// last-writer-wins is correct here. A wipe after a lock erases the base; a re-site after a wipe
// establishes the new one. First-writer-wins still governs lock against lock, the split-brain case above.
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

  // Tombstone against lock: later event wins. A tombstone with no readable stamp is treated as older
  // than any dated lock, never as the destructive reading (Law 13 — the safe side of an unreadable field
  // is the one that does not erase a home).
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
    const c = e?.set_buildspot?.transpose_origin || {};
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

// A Law 23 gate, so a verdict, never a throw. Everything arriving here came off a socket from another
// process, so a malformed message is a CLAIM that failed verification — the expected outcome of a gate,
// not a defect in this process (Law 16: a catch is never the expected pathway). JSON.parse is the one
// real boundary inside.
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

// OPERATOR_VERBS — the operator vocabulary, shared by fleet_control, the foreman's runOperatorVerb, and
// the bot's operator_commands (Law 16): a verb missing from any one of the three would die silently
// between them.
//
// Not in operator_commands, which owns the BEHAVIOUR: the other two are separate OS processes, and
// requiring operator_commands into the foreman would boot a bot's watcher inside the coordinator. A
// vocabulary is data and travels; the implementation stays put.
const OPERATOR_VERBS = new Set([
  'start',          // begin the autonomous planning loop
  'stop',           // stop the bots cleanly (foreman + server stay up)
  'flush',          // cold-reset corporate HQ — EVERY owner's, fleet-wide
  'wipe',           // clear ONE owner's places — their stations and their buildings, nobody else's
  'surveylayout',   // dry-run base-layout pre-flight; locks nothing
  'sentry',         // combat in isolation — the planning recursion stays off
  'move',           // one live locomotion leg to an authored cell — the test verb, no recursion
  'respawn',        // send the respawn packet to a dead body — the ONLY route in from outside the process
  'shutdown',       // end the run: bots exit, the world the foreman started is stopped and saved, the foreman exits
  'teleport',       // bring the asker to the crew's alpha anchor — the cell the bodies work and idle around
]);

// INGAME_VERBS — the subset a human speaking inside the world may say, a strict subset of the set above,
// asserted at load below (Law 13).
//
// Enforced by the hub, not by the desk — the only thing speaking on the in-game door today. A check
// inside the desk would be the desk promising to behave, where the two-listener design exists precisely
// because a guarantee resting on a sender's honesty is not one (Law 23). runOperatorVerb refuses a verb
// outside this set when the OBSERVED origin is INGAME — a fact about which socket accepted the
// connection, not anything the sender said about itself.
//
// `flush` is not in it; `wipe` is: `flush` empties the SHARED fleet mirror — merged stations, merged
// structures, every human's standing requests — reaching past the door's own promise ("only YOUR bots
// hear it") into work other people are accountable for, so it stays at the operator's terminal. `wipe`
// grants the same authority at the scope a player actually owns: their stations, their buildings, keyed
// by their own name.
const INGAME_VERBS = new Set([
  'stop',           // the one interrupt — they stop and leave, immediately
  'wipe',           // forget MY places, so I can move base
  // Admissible here because it does nothing to the fleet: it moves the ASKER, and only the asker — the
  // one verb in this file whose whole effect lands on the person who typed it, so there is no body to be
  // surprised by it and no state left behind.
  'teleport',       // take me to where the crew works
]);

for (const verb of INGAME_VERBS) {
  if (!OPERATOR_VERBS.has(verb)) {
    throw new Error(`message_schema: CODING VIOLATION (Law 13): INGAME_VERBS names '${verb}', which is not `
      + `an operator verb (${[...OPERATOR_VERBS].join(' | ')}). The in-game door would accept a word the `
      + 'fleet has no implementation for, and the refusal would arrive at a bot rather than at the door.');
  }
}

// COMMAND_ORIGIN — where an operator verb entered the fleet, in the same file and for the same reason as
// OPERATOR_VERBS: three OS processes must agree on it, and a vocabulary is data that travels while an
// implementation stays put.
//
// The fleet holds two species: a HOMESTEADER answers to nobody, a CONTRACTOR is built for human use, and
// the line between them cannot be drawn with a list of forbidden verbs — the same verb from the same bot
// answers differently depending only on where the words came from. So origin travels with every command.
//
// Stamped only by what the foreman OBSERVED — which socket spoke — never copied from a claim the sender
// makes about itself (Law 23). A bot receiving a command cannot verify the stamp, which is why the
// stamping happens at the one place that can.
const COMMAND_ORIGIN = Object.freeze({
  TERMINAL: 'terminal',   // the operator's own console, or fleet_control acting on their behalf
  INGAME:   'ingame',     // a human speaking inside the world, relayed by the doorman
});
const VALID_ORIGINS = new Set(Object.values(COMMAND_ORIGIN));

// ── the in-game door is a second listener, which is what makes the origin observed, not claimed ────
//
// The origin table is only worth having if the stamp is a fact. On one socket it cannot be: every client
// reaches the same listener, so the foreman would have nothing to read but a label the sender chose for
// itself, and a sender able to name its own origin can name the privileged one (Law 23: an inbound field
// is a claim, never a fact).
//
// Two listeners make it a fact with no check anywhere: the foreman stamps by which of its own servers
// accepted the connection, something it observed, never something it was told. This is the Law 26
// translator: the door is the interface a mind reaches the machine through, and the machine's guarantee
// is that the door it came through is the one it came through.
//
// An offset, not a port: the main port is an operator flag (`--port`), and a fixed second number would
// collide with a fleet moved off the default while looking like it had simply gone deaf.
const INGAME_DOOR_PORT_OFFSET = 1;

module.exports = { createEnvelope, parseEnvelope, pickBuildingEntry, isBuildingTombstone, VALID_TYPES, OPERATOR_VERBS, INGAME_VERBS, COMMAND_ORIGIN, VALID_ORIGINS, INGAME_DOOR_PORT_OFFSET, BUILDING_ROOM_SEPARATOR, roomKeyName, roomKeyOwner };
