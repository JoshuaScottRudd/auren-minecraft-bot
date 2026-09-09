// overseer/overseer_server.js
// WebSocket server — the overseer process that coordinates multiple bots.
//
// Two jobs:
//   1. Real-time HQ sync: receives boardroom chair updates from bots, broadcasts
//      all other bots' chairs back. Pure state relay — no interpretation.
//   2. Atomic claim arbitration: grants or rejects locked-category claims via
//      overseer_brain. Prevents two bots from claiming the same job.
//
// Launch: node overseer/overseer_server.js [port]
// Default port: 3001

'use strict';

const WebSocket = require('ws');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { createEnvelope, parseEnvelope, pickBuildingEntry } = require('./message_schema');
const brain = require('./overseer_brain');

// The operator vocabulary comes from the shared envelope contract, never a local copy (Law 16 — see
// OPERATOR_VERBS there for the silent failure a per-process copy caused).
const { OPERATOR_VERBS, INGAME_VERBS, COMMAND_ORIGIN: ORIGIN, VALID_ORIGINS, INGAME_DOOR_PORT_OFFSET,
  roomKeyOwner } = require('./message_schema');

// The species vocabulary, from the Architect's table rather than a local literal. This is the only
// thing the overseer takes from the config graph: it routes on a species and a second spelling of
// 'contractor' here would silently route in-game commands to nobody (Law 16).
const { BOT_MODES } = require('../Thinking_fragments/architect_config');

// THE @-ALIASES AND THE MODULE HOMES, registered here for the same reason every other entry point in the
// tree registers them: this is a process root, and a process root is the only place that can. The overseer
// resolved everything relatively while it needed nothing from the kernel; the request rules changed that,
// and they reach `@utils/...` and `@kernel/...` four levels down where no relative path from this file
// can help. Bare `module-alias/register` is not used because it walks up from the module's INSTALL dir and
// can land on a package.json carrying no _moduleAliases, registering nothing silently — the explicit form
// names the package.json that owns them (the reasoning preflight and fleet_revive both spell out).
//
// The module homes come from the one file that answers where packages live on this machine, so an overseer
// started BY HAND resolves the same as one started by the launcher, which passes NODE_PATH in. A process
// that only works when its parent remembered to set an environment variable fails in the hand-started case
// nobody tests (Law 16 — one resolver, asked by everyone).
require('../js_kernel/utils/node_module_homes').bootstrapModulePath();
require('module-alias')(path.resolve(__dirname, '..'));

// The request rules, taken as PURE FUNCTIONS over this process's own map — never the ledger's HQ-backed
// calls. The overseer has no corporate_headquarters and must not acquire one: it has no BOT_ID, so the
// file it opened would carry a name no bot answers to and no reader could explain (Invariant D, Law 6).
// The requirements live in memory here exactly as the station map does, and reach disk only inside the
// bots that receive the broadcast.
//
// REQUIRED AT LOAD, NOT INSIDE THE HANDLER, and that placement is what killed the fleet rather than the
// module. This process resolved no @-aliases, so the lone `@kernel/...` written inside handleRequestCommand
// resolved nowhere — and being inside a handler, the miss could not surface until a human in the world said
// the word `request`, at which point MODULE_NOT_FOUND took down the coordinator, every bot's link and the
// in-game door together, on one sentence from a stranger. A require belongs where a missing module is a
// startup failure: loud, before anything is raised, with nothing depending on it yet (Law 13 — a coding
// violation must not wait for a visitor to find it).
//
// The ledger reaches the item-name normaliser and the requestable catalogue, which is why the aliases and
// the module homes are bootstrapped above rather than this file resolving relatively as it once did. It
// does NOT reach corporate_headquarters: that require is lazy inside the ledger's own storage wrapper, so
// loading the rules here costs this process nothing and cannot give it an HQ.
const requestLedger = require('@kernel/request_ledger');

const PORT = parseInt(process.argv[2], 10) || 3001;
const INGAME_DOOR_PORT = PORT + INGAME_DOOR_PORT_OFFSET;

// Combined fleet trace: every line printed here (bot logs forwarded from both bots + the overseer's
// own events) is also persisted to one file, mirroring the console so both bots can be reviewed
// after the fact in a single place. Lives beside the per-bot watcher files, in the records room the
// watcher itself writes to — asked of `record_homes` rather than spelled, because a writer holding its
// own copy of that path is how a reader ends up reporting an empty run out of the wrong directory
// (Law 16).
// APPEND-ONLY, and holding ONLY the overseer's own lines (Architect 2026-08-12). Both properties were
// decided the day a power cut returned all three traces as pure NUL bytes at exactly the right length —
// the whole-file rewrite's data sat in the page cache while NTFS journalled only the rename. The full
// reasoning lives once, in js_kernel/watcher.js's _writeWatcherFile; this is the same writer, smaller.
// The 20000-line ring cap went with the rewrite: a ring needs to re-serialise the whole story to drop
// its head, and there is nothing to cap for — `fleet_control up` clears the story files at every run, so
// growth is bounded by one run's length (a 39-minute soak wrote 1.5 MB).
const COMBINED_LOG_FILE = require('../js_kernel/utils/record_homes').traceFile('overseer');
const COMBINED_FLUSH_MS = 1000;   // matches the bots' cadence; see watcher.js for why it is not 40
let _unwritten = [];
let _combinedWriteScheduled = false;

function persistCombined(line) {
  _unwritten.push(line);
  if (_combinedWriteScheduled) return;   // debounce bursts into one append
  _combinedWriteScheduled = true;
  const t = setTimeout(() => {
    _combinedWriteScheduled = false;
    const chunk = _unwritten;
    _unwritten = [];
    try {
      fs.appendFile(COMBINED_LOG_FILE, chunk.map(l => JSON.stringify(l)).join('\n') + '\n', (err) => {
        // Put the lines BACK on a failed append rather than dropping them — the next flush retries.
        // Unshifted, so a retry cannot re-order the story it is trying to preserve.
        if (err) _unwritten = chunk.concat(_unwritten);
      });
    } catch (_) { _unwritten = chunk.concat(_unwritten); }
  }, COMBINED_FLUSH_MS);
  if (t.unref) t.unref();
}

// Per-bot state: { bot_id: { ws, boardroom_chair, connected_at, last_sync } }
const botClients = new Map();

// Merged logistics station map across all bots (Phase 6). A station id is a unique world
// voxel, so entries from different bots never collide except when two bots edited the SAME
// voxel — resolved last-writer-wins by the entry's `updated_at` stamp. Pure relay/merge, no
// interpretation (Law 3): the overseer never inspects station contents, only freshness.
//
// A REMOVAL RIDES IN AS AN ENTRY, never as a missing key. The loop below reads incoming keys only, so
// an absent key is no-news and this map would otherwise keep a dug-up station for the life of the run
// and reinstall it on every bot at the next broadcast — which is what it did. station_registry marks a
// removed station with `removed_at` and stamps it fresh; the overseer relays it like any other row
// (still no interpretation — it does not read the flag), and each bot's registry drops it on read.
let mergedStations = {};

// STANDING REQUESTS — what each human has asked their crew for, held here for the same reason the
// station map is: the foreman is not a bot, has no HQ of its own, and the overseer is the one process
// that sees every crew (§8.3 — the overseer owns the fact, the bot owns whether it cares).
//
// NO MERGE FUNCTION AND NO LAST-WRITER-WINS. Stations are merged because many bots observe them; a
// request has exactly ONE author — the person who spoke it — so there is nothing to reconcile. The
// overseer is the sole writer and the bots are readers, which is the whole point of moving the fact
// here rather than letting crews each keep a copy.
let standingRequests = {};

function mergeStationsInto(incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  for (const [id, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== 'object') continue;
    const cur = mergedStations[id];
    const incomingAt = entry.updated_at || 0;
    const curAt = (cur && cur.updated_at) || 0;
    if (!cur || incomingAt >= curAt) mergedStations[id] = entry;
  }
}

// Merged fleet structures (building_confrence_room entries) across all bots.
// First-writer-wins per structure via the shared pickBuildingEntry contract —
// the fleet has ONE home; a later duplicate buildspot never displaces it.
// Pure merge, no interpretation (Law 3).
let mergedBuildings = {};

function mergeBuildingsInto(incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  for (const [key, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== 'object') continue;
    mergedBuildings[key] = pickBuildingEntry(mergedBuildings[key], entry);
  }
}

// ── THE FLOOR UNDER BOTH MIRRORS (Architect 2026-09-05) ─────────────────────────────────────────────
//
// *"each player must have a permanent corpoate hq on my computer that stays forever that they control."*
//
// The two maps above are a LIVE MIRROR and were never anything else: plain `let x = {}`, empty on every
// overseer start, repopulated only by whatever bots happened to reconnect and re-send. That was survivable
// while bodies were permanent and their own files carried the memory. It stops being survivable the moment
// a visitor is handed a fresh pair of bodies, because then the only durable copy of that person's house
// lives in a file named after a bot somebody else is about to be given.
//
// `owner_memory` is the disk under these two maps and nothing more — it does not merge, decide or
// interpret (Law 3). It splits the rows that are already owner-keyed into one file per player, and hands
// them back at startup. See its header for why the overseer owns this and the bots do not.
const ownerMemory = require('./owner_memory');

// SAVED ON EVERY MERGE, DEBOUNCED INSIDE THE MODULE. Called from the two places a row can change and from
// the broadcast that knows who is live — never on a timer of its own, because a second scheduler is a
// second thing to keep alive (the same reasoning the connection audit rides the warden's cycle).
// EVERY OWNER WHO HAS EVER WIPED IN THIS PROCESS'S LIFETIME, and it is deliberately never cleared. The
// set answers one question — "may this owner's file be written empty?" — and the answer stays yes once
// they have wiped, because every later save must keep telling the truth about a player who now has
// nothing. Forgetting a name here would mean the wipe held until the next unrelated save and then quietly
// stopped holding. It is bounded by the number of distinct people who wipe between overseer restarts.
const wipedOwners = new Set();

function savePlayerMemory() {
  const chairsByOwner = {};
  for (const [id, client] of botClients) {
    // THE OWNER FILTER IS WHAT MAKES A CHAIR FILEABLE. A homesteader answers to nobody, so it has no
    // player file to belong in; only a contractor's chair carries a person's name (bot_mandate refuses
    // an ownerless contractor at boot, so a client with an owner is a contractor by construction).
    if (!client.owner || !client.boardroom_chair) continue;
    if (!chairsByOwner[client.owner]) chairsByOwner[client.owner] = {};
    chairsByOwner[client.owner][id] = client.boardroom_chair;
  }
  ownerMemory.save(mergedBuildings, mergedStations, chairsByOwner, (m) => log(m), wipedOwners);
}

// READ AT REQUIRE TIME, APPLIED AT LISTEN TIME. Reading here keeps the load beside the module that owns
// it; the `Object.assign` further down is what actually fills the two maps, and it is placed with the
// startup banner so the ordering against the first bot registration is visible in one place rather than
// implied by module order.
const _restored = ownerMemory.loadAll((m) => log(m));

// DEATH PILES ARE NO LONGER RELAYED (2026-08-12). The mirror and its LWW merge were deleted with the
// ledger that fed them: salvage is now each bot's own live scan of its own entity table, and an entity
// table is not shareable state. Relaying "there is an item at (x,y,z)" would hand a peer a claim it cannot
// verify and that may already be false (Law 23), which is the ghost-offer failure the whole swap removed.
// Kept as a note rather than a silent deletion because "why doesn't the overseer share drops" is a
// question a successor will ask, and the answer is a decision, not an omission.

function log(msg) {
  const line = `[${new Date().toISOString()}] [OVERSEER] ${msg}`;
  console.log(line);
  persistCombined(line);
}

function warn(msg) {
  const line = `[${new Date().toISOString()}] [OVERSEER] ⚠️ ${msg}`;
  console.warn(line);
  persistCombined(line);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Send helper
// ─────────────────────────────────────────────────────────────────────────────

function sendToBot(ws, type, botId, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    warn(`Cannot send '${type}' to '${botId}' — connection not open.`);
    return false;
  }
  const envelope = createEnvelope(type, botId, payload);
  ws.send(JSON.stringify(envelope));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Broadcast boardroom chairs
// Each bot receives every OTHER bot's chair (it owns its own).
// ─────────────────────────────────────────────────────────────────────────────

function broadcastBoardroom() {
  const allChairs = {};
  for (const [id, client] of botClients) {
    if (client.boardroom_chair) {
      allChairs[id] = client.boardroom_chair;
    }
  }

  const stationsPresent = Object.keys(mergedStations).length > 0;
  const buildingsPresent = Object.keys(mergedBuildings).length > 0;
  for (const [id, client] of botClients) {
    const chairsForBot = {};
    for (const [chairId, chair] of Object.entries(allChairs)) {
      if (chairId !== id) {
        chairsForBot[chairId] = chair;
      }
    }
    // Send the full merged station map to every bot (including entries it originated —
    // its own LWW merge keeps its fresher local copy, so re-sending is idempotent). This
    // is what lets a second bot see the first's chests, furnace orders, and cooked output.
    // Merged fleet structures ride along the same way (first-writer-wins on both sides,
    // so re-sending a bot its own entry is idempotent too).
    // THE CONNECTED ROSTER — ground truth on who is actually here, and the overseer is the only
    // party that holds it. It is sent on EVERY broadcast, not just on a disconnect event, because
    // the event cannot be relied on: killing the server window takes the overseer down with the
    // bots, so no 'close' handler ever runs anywhere, and every bot's disk keeps a chair for a peer
    // that no longer exists. A peer chair carries a magnet, and a magnet carries chest_locks — so a
    // dead bot goes on holding chests for the rest of the world's life.
    // Measured 2026-07-21: after the fleet was closed, a single-bot continue run read
    // "logs:0/50 ⚠ below 25 🔒 in use by TessaBot" with TessaBot not in the session at all.
    // Broadcasting the roster rather than a "forget X" instruction is deliberate: state is re-sensed
    // against what is true NOW (Invariant B), so it self-heals whatever the bots believed before —
    // no message can be missed, because the next broadcast restates the whole truth.
    const payload = { connected_bots: [...botClients.keys()] };
    if (Object.keys(chairsForBot).length > 0) payload.bot_boardroom = chairsForBot;
    if (stationsPresent) payload.logistics_stations = mergedStations;
    // Sent WHOLE and UNCONDITIONALLY — including when it is empty, which is the case the other keys here
    // do not have and this one does. Every broadcast restates the truth, so a bot that missed one is
    // corrected by the next rather than needing a delta it can ask for; a crew reads only its own rows out
    // of it (request_ledger.outstanding). Omitting the key when the map is empty breaks exactly that claim
    // at the one moment it matters most: mergeBroadcast writes only what it is given, so the LAST cancel —
    // the one that empties the ledger — sends a payload with no requests key at all, every crew keeps the
    // rows it already mirrored, and a withdrawn requirement is worked on forever by bots nobody can call
    // off. The empty map is a FACT the overseer authored, not an absence of news (Invariant B: the mirror
    // follows the authority, and `{}` is something the authority is saying).
    payload.standing_requests = standingRequests;
    if (buildingsPresent) payload.building_conference = mergedBuildings;
    if (Object.keys(payload).length > 0) {
      sendToBot(client.ws, 'hq_broadcast', id, payload);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Message handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleRegister(ws, msg) {
  const botId = msg.bot_id;

  if (botClients.has(botId)) {
    const existing = botClients.get(botId);
    if (existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      warn(`Bot '${botId}' already connected from another socket — rejecting duplicate.`);
      sendToBot(ws, 'registered', botId, {
        success: false,
        reason: 'bot_id already connected',
      });
      return;
    }
  }

  // THE SPECIES IS REQUIRED, NOT DEFAULTED, and the direction of the danger decides that. This value
  // is what the in-game door routes on, and the only unsafe error is a homesteader that looks like a
  // contractor — it would take a stranger's orders. An absent mode has no safe reading either: default
  // it to homesteader and every contractor the foreman fetched becomes uncommandable with nothing said,
  // default it to contractor and a mis-wired launch hands the world a bot built to ignore it. So an
  // unregistered species is a bot that does not join (Law 13, same reasoning as bot_mandate's read).
  const mode = msg.payload.mode;
  if (typeof mode !== 'string' || !mode.trim()) {
    warn(`Bot '${botId}' registered without a species — refusing. Every bot declares its mandate on register.`);
    sendToBot(ws, 'registered', botId, { success: false, reason: 'no mode declared' });
    return;
  }

  botClients.set(botId, {
    ws,
    mode: mode.trim().toLowerCase(),
    // Not validated against the species here, and deliberately: bot_mandate refuses to BOOT an
    // ownerless contractor or an owned homesteader, so a bad pairing cannot reach this line. Re-checking
    // it would be a second enforcer of a fact already made impossible, and the two would have to be kept
    // in step forever (Law 16).
    owner: typeof msg.payload.owner === 'string' && msg.payload.owner.trim() ? msg.payload.owner.trim() : null,
    boardroom_chair: msg.payload.boardroom_chair || null,
    connected_at: new Date().toISOString(),
    last_sync: null,
  });
  mergeStationsInto(msg.payload.logistics_stations);
  mergeBuildingsInto(msg.payload.building_conference);

  const declaredOwner = botClients.get(botId).owner;
  log(`Bot '${botId}' registered as ${mode.trim().toUpperCase()}${declaredOwner ? ` for ${declaredOwner}` : ''}. Total bots: ${botClients.size}`);
  sendToBot(ws, 'registered', botId, { success: true });

  broadcastBoardroom();
  savePlayerMemory();
}

function handleHqDelta(ws, msg) {
  const botId = msg.bot_id;
  const client = botClients.get(botId);

  if (!client) {
    warn(`hq_delta from unregistered bot '${botId}' — ignoring.`);
    return;
  }

  client.boardroom_chair = msg.payload.boardroom_chair || client.boardroom_chair;
  client.last_sync = new Date().toISOString();
  mergeStationsInto(msg.payload.logistics_stations);
  mergeBuildingsInto(msg.payload.building_conference);

  broadcastBoardroom();
  savePlayerMemory();
}

function handleClaimRequest(ws, msg) {
  const botId = msg.bot_id;
  const key = msg.payload.key;

  if (!botClients.has(botId)) {
    warn(`claim_request from unregistered bot '${botId}' — ignoring.`);
    return;
  }

  const result = brain.handleClaimRequest(botId, key);

  if (result.granted) {
    sendToBot(ws, 'claim_granted', botId, { key });
  } else {
    sendToBot(ws, 'claim_rejected', botId, { key, reason: result.reason, fault: result.fault });
  }
}

function handleClaimRelease(ws, msg) {
  const botId = msg.bot_id;
  const key = msg.payload.key;

  if (!botClients.has(botId)) {
    warn(`claim_release from unregistered bot '${botId}' — ignoring.`);
    return;
  }

  brain.handleClaimRelease(botId, key);
}

// Planning token transport (arbiter flavor b — see overseer_brain.js taxonomy).
// The brain decides WHO gets the token; this callback is the one pathway every
// grant (immediate, on-release promotion, TTL-expiry promotion) travels to reach
// the winning bot (Law 16). The request handler itself never replies — a queued
// bot simply waits for its 'planning_granted'.
brain.onPlanningGrant((botId) => {
  const client = botClients.get(botId);
  if (!client) return;   // winner vanished mid-grant — its disconnect cleanup frees the token
  sendToBot(client.ws, 'planning_granted', botId, {});
});

function handlePlanningRequest(ws, msg) {
  const botId = msg.bot_id;
  if (!botClients.has(botId)) {
    warn(`planning_request from unregistered bot '${botId}' — ignoring.`);
    return;
  }
  brain.requestPlanningToken(botId);
}

function handlePlanningRelease(ws, msg) {
  const botId = msg.bot_id;
  if (!botClients.has(botId)) {
    warn(`planning_release from unregistered bot '${botId}' — ignoring.`);
    return;
  }
  brain.releasePlanningToken(botId);
}

// Print a bot's forwarded log line so both bots can be watched in one place. The line already
// carries its own runtime tag + stage; we splice the bot id in right after the tag so the stream
// reads uniformly:  [0m 35s] [AurenBot] [LOCOMOTION_DISPATCHER] 📊 …  (printed raw, not via log()).
function handleLog(msg) {
  const botId = msg.bot_id;
  const line = msg.payload && msg.payload.line;
  if (typeof line !== 'string') return;
  const idx = line.indexOf('] ');
  const tagged = idx >= 0
    ? `${line.slice(0, idx + 1)} [${botId}]${line.slice(idx + 1)}`
    : `[${botId}] ${line}`;
  // PRINTED, NOT PERSISTED (Architect 2026-08-12). The overseer console is still the one place a human
  // watches the whole fleet live, so the tagged line goes to stdout — but the bot already wrote this
  // exact line to its own story file, and persisting it here stored every fleet event twice and made a
  // second source of truth for the same event (Law 16 / Invariant D). readTrace now merges the per-bot
  // files with this one by ISO stamp, so the merged view is built where it is read, not written twice.
  console.log(tagged);
}

// Relay one fleet verb to every registered bot. The overseer stays passive (Law 3): it
// validates the verb and forwards it unchanged — each bot executes locally through the same
// operator_commands pathway its own console uses (Law 16). Returns the number of bots reached.
// `only` addresses a single bot when the operator named one. Still passive (Law 3): the overseer
// makes no decision, it delivers to the address it was given. It exists because `move` walks a body
// to an authored cell — broadcasting that to a three-bot fleet would send three bots to one voxel,
// which is three occupants of one scope (Law 4). Verbs with no addressee broadcast exactly as before.
// `origin` rides along on every command because the fleet now holds TWO SPECIES and the difference
// between them is a question about TRANSPORT, not vocabulary: a homesteader must still take `exit`
// from the operator's console and must never take anything from a human in the world. The overseer
// stamps it because the overseer is the only party that KNOWS it — it can see which socket spoke —
// whereas a bot receiving the message cannot verify a claim about where the message came from
// (Law 23). Passive still (Law 3): stamping a fact it observed is not deciding anything.
//
// ── THE IN-GAME DOOR OPENS ONTO CONTRACTORS AND ONTO NOTHING ELSE ────────────────────────────────
// A human speaking in the world addresses the bots fetched for them. That is not a permission check
// bolted onto delivery — it is what the address book CONTAINS: an INGAME command is delivered to the
// contractors, and a homesteader is never one of the addresses, the same way the foreman's ear is never
// installed on one. Nothing is refused because nothing is aimed there.
//
// IT IS ROUTED HERE RATHER THAN GUARDED AT THE BOT, and that placement is the whole isolation. The
// receiving bot cannot verify a claim about where a message came from (Law 23), so a check there would
// be trusting the sender's word about the sender. The overseer is the one party that KNOWS, because it
// observed which door the socket arrived at — so the fact is used at the only place it exists.
//
// ── AND ONTO ONE PERSON'S BOTS WITHIN THAT ──────────────────────────────────────────────────────
// The world holds more than one human, so "the contractors" is not an address — each of them belongs
// to somebody. `asker` is who spoke, and an in-game verb reaches the bots that are THEIRS.
//
// THE TERMINAL IS NOT AN EXCEPTION TO THIS RULE; IT IS OUTSIDE IT. Ownership is a fact about who may
// command a bot FROM INSIDE THE WORLD, and the operator is not inside the world — he is the party that
// built it, and the console reaches every bot of either species exactly as it always has. Writing that
// as an override ("unless the asker is the Architect") would put the operator INTO the ownership model
// as its most privileged member, and a model with a member who is exempt from it is two models. The
// filter simply does not run on a terminal verb.
//
// WHY `asker` IS TRUSTED FROM THE DOOR WHEN A SPECIES CLAIM WOULD NOT BE. Each party states only what
// it alone observed, and nothing states anything about itself: the bot declares its own owner at birth
// (an environment fact it cannot rewrite), the overseer stamps the origin from which of its own
// listeners accepted the socket, and the foreman reports which player spoke — read off the authenticated
// chat packet's sender, the same wire-level fact that already keeps the console from impersonating a
// player. Three observations, three observers, none of them vouching for itself (Law 23).
//
// THE SKIPPED COUNTS ARE RETURNED, NOT DROPPED (Law 6/25). "Reached nobody", "they are homesteaders"
// and "that one is somebody else's" are three different facts, and a human told only the first goes
// looking for a broken foreman.
function broadcastCommand(verb, args = {}, only = null, origin, asker = null) {
  let sent = 0;
  let skippedSpecies = 0;
  let skippedOwner = 0;
  for (const [id, client] of botClients) {
    if (only && id !== only) continue;
    if (origin === ORIGIN.INGAME) {
      if (client.mode !== BOT_MODES.CONTRACTOR) { skippedSpecies++; continue; }
      if (!asker || client.owner !== asker) { skippedOwner++; continue; }
    }
    if (sendToBot(client.ws, 'command', id, { verb, args, origin })) sent++;
  }
  return { sent, skippedSpecies, skippedOwner };
}

// The ONE operator-verb pathway (Law 16) — every transport lands here: the TTY console (readline
// below), the headless 'operator_command' socket message (fleet_control), and — once the doorman
// lands — a human speaking inside the world.
//
// `origin` is a REQUIRED argument rather than something inferred from `source`. `source` is a human-
// readable label for the log ('console', 'socket:fleet_control') and labels drift; the isolation
// between the two species cannot rest on a string somebody might reword. Callers state the origin
// explicitly, and there is exactly one place per transport where that statement is made.
//
// IT DOES NOT DEFAULT, and the direction of the danger is why. The tempting default is TERMINAL,
// because that is what every caller wanted on the day this was written — but TERMINAL is the
// PRIVILEGED origin, the one a homesteader obeys. A doorman that forgot to stamp INGAME would have
// its commands quietly promoted to console authority and delivered to exactly the species that must
// never receive them. A default here would silently undo the isolation the rest of this design
// spends three layers building, so an unstamped verb is a fault and is refused (Law 13).
function runOperatorVerb(verb, source, args = {}, origin, asker = null) {
  // Every exit from here returns a verdict rather than falling off the end, because a caller on the
  // in-game door has a human waiting and "nothing happened" has four different causes worth telling
  // apart (Law 25). The log line stays for the operator's window; the return is for the far end.
  const nil = { sent: 0, skippedSpecies: 0, skippedOwner: 0 };
  if (!VALID_ORIGINS.has(origin)) {
    warn(`Refusing '${verb}' from ${source} — unstamped or unknown origin '${origin}'. Every operator verb must declare where it entered the fleet (${[...VALID_ORIGINS].join(' | ')}).`);
    return { ...nil, reason: 'bad_origin' };
  }
  // AN IN-GAME VERB WITH NO ASKER IS REFUSED RATHER THAN BROADCAST. The unaddressed form means "all of
  // MY bots", so an anonymous one would mean "all of everybody's" — the single most dangerous reading
  // available here, and the one a missing field would silently produce (Law 13: absent is a fault).
  if (origin === ORIGIN.INGAME && !asker) {
    warn(`Refusing '${verb}' from ${source} — it arrived from inside the world with nobody named as the asker.`);
    return { ...nil, reason: 'no_asker' };
  }
  if (!OPERATOR_VERBS.has(verb)) {
    warn(`Unknown ${source} verb '${verb}' — valid: ${[...OPERATOR_VERBS].join(' | ')}.`);
    return { ...nil, reason: 'unknown_verb' };
  }
  // ── THE IN-GAME VOCABULARY IS SMALLER THAN THE OPERATOR'S, AND THE DIFFERENCE IS ENFORCED HERE ────
  // Not in the foreman, and the placement is the whole point. The foreman is the only thing that speaks
  // on the in-game door today, so a check inside it would be the sender promising to behave — and the
  // two-listener design exists precisely because a guarantee resting on a sender's honesty is not one
  // (Law 23). This refuses on the origin the overseer OBSERVED (which of its own servers accepted the
  // socket), so no message from the world can carry a bench verb however the foreman is edited.
  //
  // WHAT IS EXCLUDED AND WHY, in one sentence each, because "the human's set is smaller" invites a
  // successor to widen it back: `move`/`surveylayout`/`respawn`/`sentry` are bench instruments whose
  // effects are invisible or unrecoverable from inside the world, and `flush` erases every owner's
  // memory — which is the operator's authority, at the operator's scope of accountability, and not a
  // player's. The player's scoped equivalent is `wipe`.
  if (origin === ORIGIN.INGAME && !INGAME_VERBS.has(verb)) {
    warn(`Refusing '${verb}' from ${asker} inside the world — it is an operator verb, not one of the `
      + `in-game vocabulary (${[...INGAME_VERBS].join(' | ')}). The terminal keeps it.`);
    return { ...nil, reason: 'not_ingame_verb' };
  }
  // ── 'wipe' IS SETTLED HERE, ABOVE THE no_bots GATE, AND IT NEEDS NO BODY AT ALL ──────────────────
  //
  // THE ASK (Architect 2026-09-05): *"a wipe needs to also stop the bots and make them exit… wiping can
  // happen if there is or isnt bots because the corporate hq is the players on permanent file instead of
  // anything requiring a live bot."*
  //
  // WHAT CHANGED UNDERNEATH THIS, and it is what makes the new shape correct rather than merely allowed.
  // A wipe used to be DELIVERED: the owner's bots ran `wipe_system` against their own memory and the
  // tombstones came back up on the next merge, so the verb needed a living body to mean anything and the
  // gate below was right to refuse without one. Contractors are now stateless — their memory dies with
  // them and never reaches a disk — so a bot's own tombstone is worth nothing the moment it stops, and
  // the ONLY durable copy is the player's file, which this process owns. The authority and the memory
  // are now in the same place, so the work belongs here.
  //
  // AND IT HAD TO MOVE HERE ANYWAY, because of the second half of his ask: a wipe now STOPS the bots. If
  // the bots were still the ones striking their rows, stopping them in the same breath would race their
  // own tombstones out of existence — the strike is written, the body dies before the delta is sent, and
  // the wipe silently does nothing. Striking centrally removes the race instead of timing it (Law 16).
  //
  // TOMBSTONES, NOT DELETES, IN BOTH ROOMS — the reasoning is `wipe_system`'s and has not changed: the
  // merge reads INCOMING keys, so a locally-absent key is no-news and any bot still holding the old row
  // hands it straight back. A homesteader that adopted a peer's room is exactly that bot. An absence
  // does not travel; a fact does.
  //
  // THE SCOPE IS THE SPEAKER (Law 27/28). In-game, the owner is the ASKER and nothing else — not the
  // owners of whichever bots happen to be connected, which is what it used to read and which is
  // meaningless when the answer is meant to be "none of them". A person's memory is theirs whether or
  // not they currently hold a crew. The terminal keeps its old reading: the operator's scope is the
  // fleet, so it strikes the owners of the bots it can see, and `flush` remains the fleet-wide verb.
  if (verb === 'wipe') {
    const owners = new Set();
    if (origin === ORIGIN.INGAME) owners.add(asker);
    else for (const [botId, c] of botClients.entries()) {
      if (args.bot && args.bot !== botId) continue;
      if (c.owner) owners.add(c.owner);
    }
    if (owners.size === 0) {
      warn(`Wipe from ${source} named nobody — no owner could be resolved, so nothing was struck.`);
      return { ...nil, reason: 'reached_nobody' };
    }

    const now = Date.now();
    let struckBuildings = 0;
    for (const [key, entry] of Object.entries(mergedBuildings)) {
      const keyOwner = roomKeyOwner(key);
      if (keyOwner === null || !owners.has(keyOwner)) continue;   // null is the commons and is never taken
      if (entry && entry.removed_at) continue;                    // already struck — do not re-stamp
      mergedBuildings[key] = { removed_at: now };
      struckBuildings++;
    }
    // THE STATION TOMBSTONE KEEPS pos/type/owner AND THE BUILDING'S KEEPS NOTHING, and that asymmetry is
    // `station_registry`'s, reproduced rather than invented: a building key already carries structure and
    // owner so a reader can place the row from the key alone, while a station row is keyed by position
    // and would be unattributable without them.
    let struckStations = 0;
    for (const [stationId, entry] of Object.entries(mergedStations)) {
      if (!entry || !owners.has(entry.owner)) continue;
      if (entry.removed_at) continue;
      mergedStations[stationId] = { pos: entry.pos, type: entry.type, owner: entry.owner, removed_at: now, updated_at: now };
      struckStations++;
    }

    for (const o of owners) wipedOwners.add(o);
    savePlayerMemory();
    ownerMemory.flushNow();
    broadcastBoardroom();

    // THE CREW GOES WITH THE MEMORY (his ask, and it is the honest lifecycle — Law 8). A bot standing in
    // the world holding a base that no longer exists is a body mid-task against a plan that was just
    // revoked; sending it away is cheaper and more truthful than teaching every fragment to notice. The
    // person says `get` and receives a fresh pair, teleported to wherever they are now — which is the
    // whole point of wiping, since the reason to wipe is that they have moved.
    let stopped = 0;
    for (const [botId, client] of botClients) {
      if (!client.owner || !owners.has(client.owner)) continue;
      if (sendToBot(client.ws, 'command', botId, { verb: 'stop', args: {}, origin })) stopped++;
    }

    log(`Wipe for ${[...owners].join(', ')}: ${struckBuildings} building room(s) and ${struckStations} station(s) `
      + `tombstoned, written to the player file(s), ${stopped} bot(s) sent away. Every other owner untouched.`);
    return { ...nil, reason: 'wiped', struckBuildings, struckStations, stopped };
  }

  if (botClients.size === 0) {
    warn(`No bots connected — '${verb}' not sent.`);
    return { ...nil, reason: 'no_bots' };
  }

  // 'flush' means "fresh server" fleet-wide: the bots wipe their own corporate_headquarters,
  // but this long-lived overseer also mirrors fleet HQ (merged stations + structures) and
  // would otherwise re-broadcast the pre-flush home straight back into the freshly-blank bots —
  // which now trips set_buildspot's Law-13 guard. Clear the mirror here so the fleet is truly
  // fresh. Done before the broadcast so a bot's immediate post-reset (empty) update can't be
  // out-raced by our own clear.
  //
  // FLUSH'S BLAST RADIUS EXCEEDS ANY ONE OWNER'S BOTS, AND THAT IS NOW CORRECT RATHER THAN TOLERATED.
  //
  // THE THIRD OPTION THIS COMMENT SAID DID NOT EXIST (2026-09-01). It used to read: an in-game flush
  // clears the whole mirror, scoping it is impossible because a station is a world voxel rather than a
  // person's property, *"there is no third option while the mirror is shared, so the honest move is to
  // let the verb do what it does and say so where a human will read it."* It was right that the verb
  // could not be scoped and wrong that admitting it was the only remaining move. The third option was to
  // stop admitting it: `flush` is no longer in INGAME_VERBS, so the in-game arm this branch used to carry
  // is unreachable and has been deleted rather than left as a warning for a case that cannot occur
  // (Law 27 — the failing case stops existing inside the thing instead of being announced at its door).
  //
  // IT IS STILL THE RIGHT VERB FOR THE TERMINAL, and for the reason it was the wrong one for the world:
  // authority is bounded by accountability, and at the console the whole fleet is one person's
  // responsibility, so a fleet-wide erase is exactly their share. A player's scoped equivalent is `wipe`.
  if (verb === 'flush') {
    mergedStations = {};
    mergedBuildings = {};
    standingRequests = {};
    log('Flush: cleared mirrored fleet HQ (stations + structures + standing requests) — bots re-sync from empty.');
  }

  const only = typeof args.bot === 'string' && args.bot ? args.bot : null;
  const { sent, skippedSpecies, skippedOwner } = broadcastCommand(verb, args, only, origin, asker);
  const out = { sent, skippedSpecies, skippedOwner };
  // Law 25: a verb that reached NOBODY is not a delivery. Say so rather than logging a 0 — and say
  // WHICH nobody. "No such bot", "that species takes no orders from you" and "that one is someone
  // else's" send a reader to three different places, and only the last is about another person.
  //
  // ORDERED MOST SPECIFIC FIRST. A bot skipped on OWNERSHIP was already a contractor, so reporting the
  // species would be true of the fleet and false about the bot the human meant (Law 25 again — the
  // reader would go and fetch a contractor they already have).
  if (sent === 0 && skippedOwner > 0) {
    warn(`'${verb}' from ${asker} reached nobody — ${skippedOwner} contractor(s) belong to someone else.`);
    return { ...out, reason: 'not_yours' };
  }
  if (sent === 0 && skippedSpecies > 0) {
    const who = only ? `'${only}' is` : `${skippedSpecies} connected bot(s) are`;
    warn(`'${verb}' from inside the world reached nobody — ${who} not a contractor. Homesteaders take no orders from a human.`);
    return { ...out, reason: 'not_a_contractor' };
  }
  if (only && sent === 0) {
    warn(`'${verb}' addressed to '${only}' — no such bot connected; nothing sent.`);
    return { ...out, reason: 'no_such_bot' };
  }
  if (sent === 0) {
    warn(`'${verb}' from ${source} reached no bot.`);
    return { ...out, reason: 'reached_nobody' };
  }
  log(`Broadcast '${verb}' to ${sent} bot(s) [${source}, origin:${origin}${asker ? `, asker:${asker}` : ''}]${only ? ` (addressed: ${only})` : ''}.`);
  return { ...out, reason: null };
}

// The headless transport. The origin is a fixed ARGUMENT here rather than a field read off the message,
// and that is the whole reason there are two listeners: each one calls this with the origin ITS door
// means, so no message can name its own authority (Law 23 — an inbound field is a claim). A sender able
// to spell `origin: 'terminal'` on the in-game door would separate the two species by nothing more than
// its own honesty.
//
// The result travels BACK on the same socket, because the far end has a human waiting for an answer.
// Delivery is not outcome and this says only what it knows — how many bots the verb reached and why it
// reached no more than that (Law 25). What those bots then DO with it is not observable from here.
function handleOperatorCommand(ws, msg, origin) {
  const verb = msg.payload && msg.payload.verb;
  const args = (msg.payload && msg.payload.args) || {};
  // `asker` is read off the payload and is meaningful ONLY on the in-game door, where the foreman is the
  // party that observed which player spoke. On the terminal door there is no asker and none is read:
  // the operator is not a participant in ownership (see broadcastCommand).
  const asker = typeof msg.payload?.asker === 'string' && msg.payload.asker.trim() ? msg.payload.asker.trim() : null;
  const result = runOperatorVerb(typeof verb === 'string' ? verb.trim() : '', `socket:${msg.bot_id}`, args, origin, asker)
    || { sent: 0, skippedSpecies: 0, skippedOwner: 0, reason: 'refused' };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(createEnvelope('command_result', 'overseer', { verb, origin, ...result })));
  }
}

// WHO IS OUT THERE, AND WHOSE — answered from the live registry rather than from the PID file.
//
// The foreman needs this for two different questions and both were being answered badly. `list` read
// fleet_control's runtime file, which records processes it once launched and reports long-dead PIDs as
// roster entries — a human was being shown the launcher's memory instead of the world. And the two-bot
// cap needs a COUNT OF WHAT THIS PERSON CURRENTLY HAS, which is exactly the kind of fact that must be
// re-sensed rather than tallied as bots are handed out: a foreman holding its own counter loses it on
// restart and drifts every time a bot dies (Invariant B).
//
// It reports the whole fleet, not the asker's share, and that is not a leak: `list` is meant to show a
// human what is standing in the world with them, which they can also see by looking. What ownership
// governs is who may COMMAND a bot, and that is decided at delivery.
// ── WHERE EACH BODY IS AND WHAT IT IS DOING, RELAYED FROM THE CHAIR IT ALREADY WRITES ────────────
// Added for the desk's `where`. NOTHING NEW IS SENSED AND NOTHING IS COMPUTED (Law 3): every bot already
// stamps `body_cell` into its own boardroom chair on an interval, and the dispatcher already stamps the
// `magnet` — the task-identity marker — into the same chair when it claims a job. Both were reaching this
// process on every hq_delta and stopping here.
//
// THE MAGNET IS THE JOB TOKEN AND IS FORWARDED, NOT SUMMARISED. Which of its fields a person is shown is
// the desk's business, not the coordinator's; picking two here would make this a second opinion about
// what a bot is doing, disagreeing with the trace the moment the magnet gains a field (Law 16).
//
// A NULL IS AN ANSWER. No magnet is a bot holding no job — genuinely idle — and no body_cell is a bot
// that has not reported a position yet. Both are facts, and the desk says so in words rather than
// printing a zero for either (Law 25 — the absence is not a failure, and inventing a figure to fill it is).
function handleFleetQuery(ws, msg) {
  const bots = [...botClients.entries()].map(([id, c]) => ({
    id,
    mode: c.mode,
    owner: c.owner,
    body_cell: (c.boardroom_chair && c.boardroom_chair.body_cell) || null,
    magnet: (c.boardroom_chair && c.boardroom_chair.magnet) || null,
  }));
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(createEnvelope('fleet_state', 'overseer', { bots })));
  }
}

// handleRequestCommand — a person's standing requirement, arriving from the desk.
//
// THE ASKER IS THE OWNER KEY, which is what makes this safe to accept from a socket: a request can only
// ever be filed against the name of the person who spoke it, so one player cannot place or withdraw
// work on another's crew. Refused outright when unnamed, for the same reason an unaddressed operator
// verb is (Law 13 — an anonymous request would be a requirement belonging to nobody).
//
// THE RULES ARE NOT RESTATED HERE. Whether an item may be asked for, whether a repeat replaces or adds,
// what a row looks like — all of it lives in request_ledger and is called, never copied, so the desk and
// the crews cannot come to disagree about what was asked (Law 16).
// crewProgress(asker) → { item: { ...measurement, measured_at, by } } for the bots this person owns, or
// {} when none of them has reported yet.
//
// PURE RELAY, NO ARITHMETIC (Law 3). Every figure here was computed inside a body by the same lens its
// own supply assessor stands down on; this picks the freshest report per item and forwards it untouched.
// The desk cannot compute these — it holds no owner key, so it cannot tell which chests belong to whom —
// and the overseer must not either: counting the merged station map here would be a second answer to
// "how much have we got", disagreeing with the crews the moment a claim is held (Law 16, Law 25).
//
// FRESHEST WINS, PER ITEM, and it is chosen per item rather than per bot because a crew's members sync
// at different moments and a whole-chair choice would discard a newer figure sitting beside an older one.
// Two bots of one crew read the same shared chests, so they do not disagree about a count — only about
// when they last looked.
//
// SILENCE IS REPORTED AS SILENCE. A row with no measurement is left absent rather than filled with a
// zero: "nothing gathered yet" and "no bot has looked yet" are different facts, and only one of them is
// news about the work (Law 25 — an invented figure is the failure, not the missing one).
function crewProgress(asker) {
  const out = {};
  for (const [botId, client] of botClients.entries()) {
    if (client.owner !== asker) continue;
    const chair = client.boardroom_chair;
    const rows = chair && Array.isArray(chair.request_progress) ? chair.request_progress : null;
    if (!rows) continue;
    const at = chair.request_progress_at || null;
    for (const row of rows) {
      if (!row || !row.item) continue;
      const held = out[row.item];
      if (held && (held.measured_at || '') >= (at || '')) continue;
      out[row.item] = { ...row, measured_at: at, by: botId };
    }
  }
  return out;
}

function handleRequestCommand(ws, msg) {
  const { action, item, quantity, asker } = msg.payload || {};
  const answer = (payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(createEnvelope('request_result', 'overseer', payload)));
    }
  };
  if (!asker) {
    warn('In-game door: a request naming no asker was refused.');
    answer({ ok: false, reason: 'no_asker' });
    return;
  }

  const ledger = requestLedger;

  if (action === 'post') {
    const result = ledger.applyPost(standingRequests, item, quantity, asker, asker);
    if (result.ok) {
      standingRequests = result.rows;
      log(`Request: ${asker} asks for ${quantity} ${item}.`);
      answer({ ok: true, item: result.row.item, quantity: result.row.quantity, replaced: result.replaced });
    } else {
      answer({ ok: false, reason: result.reason, blockedBy: result.blockedBy || null });
    }
    return;
  }
  if (action === 'cancel') {
    const { rows, removed } = ledger.applyCancel(standingRequests, item, asker);
    standingRequests = rows;
    log(`Request: ${asker} withdrew ${item} (${removed} row(s)).`);
    answer({ ok: true, removed });
    return;
  }
  if (action === 'status') {
    answer({ ok: true, rows: ledger.rowsFor(standingRequests, asker), progress: crewProgress(asker) });
    return;
  }
  warn(`In-game door: request action '${action}' is not spoken here.`);
  answer({ ok: false, reason: `unknown_action: ${action}` });
}

// ── THE IN-GAME DOOR ─────────────────────────────────────────────────────────────────────────────
// Its own listener, and it accepts exactly ONE message type. A door that also spoke the fleet's
// internal vocabulary would be a second registration path, a second claim arbiter and a second HQ
// writer, reachable by anyone who can open a socket to it — the in-game surface would then be the
// whole protocol rather than the operator verbs. Everything else arriving here is reported and dropped:
// reported, because a silently ignored message is indistinguishable from a deaf door (Law 6).
function onIngameConnection(ws) {
  log('In-game door: a client connected.');
  ws.on('message', (raw) => {
    const parsed = parseEnvelope(raw.toString());
    if (!parsed.ok) { warn(`In-game door: bad message: ${parsed.reason}`); return; }
    const msg = parsed.msg;
    if (msg.type === 'fleet_query') { handleFleetQuery(ws, msg); return; }
    if (msg.type === 'request_command') { handleRequestCommand(ws, msg); return; }
    if (msg.type !== 'operator_command') {
      warn(`In-game door: '${msg.type}' is not spoken here — the door carries operator verbs and one roster question, nothing else. Dropped.`);
      return;
    }
    handleOperatorCommand(ws, msg, ORIGIN.INGAME);
  });
  ws.on('error', (err) => warn(`In-game door socket error: ${err.message}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Connection handling
// ─────────────────────────────────────────────────────────────────────────────

function onConnection(ws) {
  log('New WebSocket connection opened.');

  ws.on('message', (raw) => {
    const parsed = parseEnvelope(raw.toString());
    if (!parsed.ok) { warn(`Bad message: ${parsed.reason}`); return; }
    const msg = parsed.msg;

    switch (msg.type) {
      case 'register':
        handleRegister(ws, msg);
        break;
      case 'hq_delta':
        handleHqDelta(ws, msg);
        break;
      case 'claim_request':
        handleClaimRequest(ws, msg);
        break;
      case 'claim_release':
        handleClaimRelease(ws, msg);
        break;
      case 'planning_request':
        handlePlanningRequest(ws, msg);
        break;
      case 'planning_release':
        handlePlanningRelease(ws, msg);
        break;
      case 'log':
        handleLog(msg);
        break;
      case 'operator_command':
        // This listener IS the terminal door — fleet_control speaking for the operator, and the
        // operator's own console one function down. Stated here, once, per transport.
        handleOperatorCommand(ws, msg, ORIGIN.TERMINAL);
        break;
      default:
        warn(`Unexpected message type '${msg.type}' from bot '${msg.bot_id}'.`);
    }
  });

  ws.on('close', () => {
    for (const [botId, client] of botClients) {
      if (client.ws === ws) {
        log(`Bot '${botId}' disconnected.`);
        botClients.delete(botId);
        brain.releaseForBot(botId);
        broadcastBoardroom();
        // The player's file must show the crew that is ACTUALLY here. A chair is a live bot's
        // inventory, so it dies with the connection (Law 8) — the buildings and stations in the
        // same file do not, and that asymmetry is the whole point of the store. Written here
        // rather than left to the debounce because a shutdown can arrive first and freeze a
        // departed bot's inventory into the file as if the bot were still standing there.
        savePlayerMemory();
        ownerMemory.flushNow();   // not queued behind the debounce: measured at up to 40s of ghost otherwise
        break;
      }
    }
    log(`Remaining bots: ${botClients.size}`);
  });

  ws.on('error', (err) => {
    warn(`WebSocket error: ${err.message}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Server startup
// ─────────────────────────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ port: PORT });
wss.on('connection', onConnection);

// The second door. Bound to localhost EXPLICITLY, unlike the fleet port: this is the one surface that
// carries a stranger's authority, and the machine it runs on is the only place it has any business
// being reachable from. A door open to the network would let anything that can route to this host
// command the contractors without ever joining the world the foreman listens in.
const ingameDoor = new WebSocket.Server({ port: INGAME_DOOR_PORT, host: '127.0.0.1' });
ingameDoor.on('connection', onIngameConnection);

// Startup banner (bright magenta, bold) — deliberately a DIFFERENT colour from the bots' cyan banner
// so the two window types are told apart at a glance. This is the one window that carries the whole
// fleet's live log stream; the bot windows are near-silent by design.
(function overseerBanner() {
  const M = '\x1b[95m\x1b[1m', R = '\x1b[0m';
  const bar = '═'.repeat(50);
  console.log(`${M}${bar}${R}`);
  console.log(`${M}  🛰️   OVERSEER  ·  fleet log stream + command hub${R}`);
  console.log(`${M}      every bot's logs appear here, tagged [BotId]${R}`);
  console.log(`${M}${bar}${R}`);
})();

// ── THE MIRROR STARTS FULL, NOT EMPTY ───────────────────────────────────────────────────────────────
// Before this line ran, `mergedBuildings` and `mergedStations` began every overseer life as `{}` and a
// player's places existed only for as long as some bot that had built them kept reconnecting. This is the
// line that makes a player's HQ outlive the bodies — and it must run BEFORE the first bot can register,
// which is why it sits with the startup banner rather than inside an async warm-up.
Object.assign(mergedBuildings, _restored.buildings);
Object.assign(mergedStations,  _restored.stations);

log(`Overseer WebSocket server listening on ws://localhost:${PORT}`);
log(`In-game door listening on ws://127.0.0.1:${INGAME_DOOR_PORT} — verbs arriving here reach CONTRACTORS only.`);
log(`Waiting for bot connections...`);
log(`Operator console ready — type a verb + Enter to command every bot: start | exit | flush.`);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Operator console (TTY transport into runOperatorVerb — Law 16:
// the socket 'operator_command' is the other transport, same one pathway).
// The overseer stays passive (Law 3): it only validates and forwards, never decides.
// ─────────────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (input) => {
  const verb = (input || '').trim();
  if (!verb) return;
  runOperatorVerb(verb, 'console', {}, ORIGIN.TERMINAL);   // the operator's own keyboard IS the terminal
});
