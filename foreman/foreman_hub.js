// foreman/foreman_hub.js
// WebSocket server — the foreman process that coordinates multiple bots.
//
// Two jobs:
//   1. Real-time HQ sync: receives boardroom chair updates from bots, broadcasts
//      all other bots' chairs back. Pure state relay — no interpretation.
//   2. Atomic claim arbitration: grants or rejects locked-category claims via
//      foreman_brain. Prevents two bots from claiming the same job.
//
// Launch: node foreman/foreman_hub.js [port]
// Default port: 3001

'use strict';

const WebSocket = require('ws');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { createEnvelope, parseEnvelope, pickBuildingEntry, isBuildingTombstone, BUILDING_ROOM_SEPARATOR } = require('./message_schema');
const brain = require('./foreman_brain');
// The foreman's own hold on world status (started, reached, failed, stopping), reported in fleetState.
const foremanWorld = require('./foreman_world');

// Operator vocabulary (Law 16).
const { OPERATOR_VERBS, INGAME_VERBS, COMMAND_ORIGIN: ORIGIN, VALID_ORIGINS, INGAME_DOOR_PORT_OFFSET,
  roomKeyOwner } = require('./message_schema');

// Species vocabulary, shared with architect_config (Law 16).
const { BOT_MODES } = require('../Thinking_fragments/architect_config');

// Registers @-aliases and module homes for this process root (Law 16).
require('../js_kernel/utils/node_module_homes').bootstrapModulePath();
require('module-alias')(path.resolve(__dirname, '..'));

// Request rules, used as pure functions over this process's own map (Invariant D, Law 6). Required at
// load, not inside the handler, so a missing module is a startup failure (Law 13).
const requestLedger = require('@kernel/request_ledger');
// The fleet's one item book: every body's moves land here (item_book says what a move is).
const itemBook = require('./item_book');
itemBook.start();

// ── ONE PROCESS WITH THE FOREMAN ──────────────────────────────────────────
// Required by foreman/foreman.js; not started on its own. PORT comes from FOREMAN_PORT, not argv.
const PORT = parseInt(process.env.FOREMAN_PORT, 10) || 3001;
const INGAME_DOOR_PORT = PORT + INGAME_DOOR_PORT_OFFSET;

// Combined fleet trace file: forwarded bot logs + the foreman's own events, for reviewing the whole
// fleet after a run. Path from record_homes (Law 16). Append-only, foreman's own lines only.
const COMBINED_LOG_FILE = require('../js_kernel/utils/record_homes').traceFile('fleet');
const { guardExternalSync } = require('@utils/external_library_guard');
const COMBINED_FLUSH_MS = 1000;   // matches the bots' cadence
let _unwritten = [];
let _combinedWriteScheduled = false;

const recordClaims = require('../js_kernel/utils/record_claims');
const READER_HOLD_RETRY_MS = 100;   // how soon an append held back by a reader of the record asks again
let _combinedInFlight = false;

function scheduleCombined(afterMs) {
  if (_combinedWriteScheduled) return;   // debounce bursts into one append
  _combinedWriteScheduled = true;
  const t = setTimeout(() => {
    _combinedWriteScheduled = false;
    if (!_unwritten.length) return;
    // ONE APPEND AT A TIME, AND NONE WHILE A READER HOLDS THE RECORD (record_claims): the lines stay
    // queued and the flush asks again.
    const claimed = !_combinedInFlight && guardExternalSync('foreman_hub', 'record_claims.beginWrite(combined trace)',
      () => recordClaims.beginWrite(COMBINED_LOG_FILE));
    if (!claimed || !claimed.ok || !claimed.value) { scheduleCombined(READER_HOLD_RETRY_MS); return; }
    _combinedInFlight = true;
    const chunk = _unwritten;
    _unwritten = [];
    const landed = () => {
      _combinedInFlight = false;
      guardExternalSync('foreman_hub', 'record_claims.endWrite(combined trace)', () => recordClaims.endWrite(COMBINED_LOG_FILE));
    };
    // `fs.appendFile` is third-party and can throw synchronously (Law 16 guard).
    const appended = guardExternalSync('foreman_hub', 'fs.appendFile(combined trace)', () => {
      fs.appendFile(COMBINED_LOG_FILE, chunk.map(l => JSON.stringify(l)).join('\n') + '\n', (err) => {
        // Failed lines go back, unshifted, for the next flush to retry.
        if (err) { _unwritten = chunk.concat(_unwritten); scheduleCombined(COMBINED_FLUSH_MS); }
        landed();
      });
    });
    if (!appended.ok) { _unwritten = chunk.concat(_unwritten); landed(); }
  }, afterMs);
  if (t.unref) t.unref();
}

function persistCombined(line) {
  _unwritten.push(line);
  scheduleCombined(COMBINED_FLUSH_MS);
}

// Per-bot state: { bot_id: { ws, boardroom_chair, connected_at, last_sync } }
const botClients = new Map();

// Merged logistics station map across all bots, keyed by voxel, last-writer-wins by `updated_at` (Law
// 3). A removal rides in as an entry with `removed_at`, written by station_registry.
let mergedStations = {};

// Standing requests: what each human has asked their crew for. The foreman is the sole writer.
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

// Merged fleet structures across all bots, first-writer-wins via pickBuildingEntry (Law 3).
let mergedBuildings = {};

function mergeBuildingsInto(incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  for (const [key, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== 'object') continue;
    mergedBuildings[key] = pickBuildingEntry(mergedBuildings[key], entry);
  }
}

// ── A BOT CANNOT SET A POINT ──────────────────────────────────────────────────
// The foreman is the one writer of a building's location (`lockSite` below). A row that sets, moves, or
// strikes a location the foreman did not set is dropped and reported once per bot and room (Law 13).
const _refusedLocation = new Set();
function sameLocation(a, b) {
  const x = a && a.set_buildspot, y = b && b.set_buildspot;
  if (!x || !y) return false;
  const p = x.transpose_origin || {}, q = y.transpose_origin || {};
  return x.locked_at === y.locked_at && p.x === q.x && p.y === q.y && p.z === q.z;
}
function botBuildingsOnly(incoming, botId) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const kept = {};
  for (const [key, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== 'object') continue;
    const held = mergedBuildings[key];
    const heldDead = isBuildingTombstone(held);
    let why = null;
    if (isBuildingTombstone(entry)) {
      if (!heldDead) why = 'struck a building the foreman did not strike';
    } else if (entry.set_buildspot) {
      if (!held || heldDead || !sameLocation(entry, held)) why = 'set a location the foreman did not set';
    }
    if (!why) { kept[key] = entry; continue; }
    const mark = `${botId}|${key}`;
    if (!_refusedLocation.has(mark)) {
      _refusedLocation.add(mark);
      warn(`CODING VIOLATION (Law 13): bot '${botId}' ${why} ('${key}'). Only the foreman sets points — the row was dropped.`);
    }
  }
  return kept;
}

// lockSite(rows) — the one writer of a location, called by the desk before any body exists. Each row
// becomes the two chairs `site_chairs` builds, saved to the owner's file and broadcast.
//
// ONE BASE HAS ONE SITE: a matching centre is accepted, a different centre is refused (Law 13).
//
// The owner half of the key is the desk's (`bot_mandate.ownerKeyFor`), joined here once with the row's
// plain structure name (`bot_mandate.buildingRoomKey`).
async function lockSite(rows, ownerKey) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`[foreman_hub] CODING VIOLATION (Law 13): lockSite needs the rows the desk sited, got ${JSON.stringify(rows)}.`);
  }
  if (typeof ownerKey !== 'string' || !ownerKey || ownerKey.includes(BUILDING_ROOM_SEPARATOR)) {
    throw new Error(`[foreman_hub] CODING VIOLATION (Law 13): lockSite needs the crew's owner key (ownerKeyFor), got ${JSON.stringify(ownerKey)}.`);
  }
  const { siteChairs } = require('@kernel/site_chairs');
  const locked = [];
  const already = [];
  for (const row of rows) {
    if (typeof row.roomKey !== 'string' || !row.roomKey || row.roomKey.includes(BUILDING_ROOM_SEPARATOR)) {
      throw new Error(`[foreman_hub] CODING VIOLATION (Law 13): a site row names its plain structure ('headframe'), got roomKey ${JSON.stringify(row.roomKey)}.`);
    }
    const key = `${row.roomKey}${BUILDING_ROOM_SEPARATOR}${ownerKey}`;
    const held = mergedBuildings[key];
    const bc = row.candidate && row.candidate.transpose_origin;
    if (held && !isBuildingTombstone(held) && held.set_buildspot && held.set_buildspot.transpose_origin) {
      const h = held.set_buildspot.transpose_origin;
      if (bc && h.x === bc.x && h.y === bc.y && h.z === bc.z) { already.push(key); continue; }
      throw new Error(`[foreman_hub] CODING VIOLATION (Law 13): '${key}' is already sited at (${h.x},${h.y},${h.z}); `
        + `the desk asked for (${bc && bc.x},${bc && bc.y},${bc && bc.z}). One base has one site — the desk hands an existing base back, it never surveys over it.`);
    }
    mergedBuildings[key] = siteChairs(row, 'foreman');
    locked.push(key);
  }
  log(`Sited: locked [${locked.join(', ') || 'nothing new'}]${already.length ? `, already held [${already.join(', ')}]` : ''}.`);
  savePlayerMemory();
  await ownerMemory.flushNow();
  broadcastBoardroom();
  return { locked, already };
}

// ── THE FLOOR UNDER BOTH MIRRORS ─────────────────────────────────────────────
// mergedBuildings/mergedStations are a live mirror only, empty on every foreman start. `owner_memory` is
// the durable disk copy beneath them, one file per player (Law 3).
const ownerMemory = require('./owner_memory');

// Saved on every merge, debounced inside owner_memory.
// wipedOwners: every owner who has wiped, so a later save may write their file empty.
const wipedOwners = new Set();

function savePlayerMemory() {
  const chairsByOwner = {};
  for (const [id, client] of botClients) {
    // Only a contractor's chair carries an owner name (bot_mandate).
    if (!client.owner || !client.boardroom_chair) continue;
    if (!chairsByOwner[client.owner]) chairsByOwner[client.owner] = {};
    chairsByOwner[client.owner][id] = client.boardroom_chair;
  }
  ownerMemory.save(mergedBuildings, mergedStations, chairsByOwner, (m) => log(m), wipedOwners);
}

// Read at require time; applied to the two maps at listen time (see the startup banner below).
const _restored = ownerMemory.loadAll((m) => log(m));

// Salvage (death piles) is not relayed: each bot scans its own entity table live (Law 23).

function log(msg) {
  const line = `[${new Date().toISOString()}] [FOREMAN] ${msg}`;
  console.log(line);
  persistCombined(line);
}

function warn(msg) {
  const line = `[${new Date().toISOString()}] [FOREMAN] ⚠️ ${msg}`;
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
    // Station and building maps sent whole to every bot, including entries it originated (idempotent
    // merges). Connected roster sent on every broadcast — ground truth on who is here (Invariant B).
    const payload = { connected_bots: [...botClients.keys()] };
    if (Object.keys(chairsForBot).length > 0) payload.bot_boardroom = chairsForBot;
    if (stationsPresent) payload.logistics_stations = mergedStations;
    // Sent whole and unconditionally, including when empty, so a withdrawn requirement does not stick on
    // a bot's stale mirror (Invariant B).
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

  // Species is required, not defaulted: an unregistered species is a bot that does not join (Law 13).
  const mode = msg.payload.mode;
  if (typeof mode !== 'string' || !mode.trim()) {
    warn(`Bot '${botId}' registered without a species — refusing. Every bot declares its mandate on register.`);
    sendToBot(ws, 'registered', botId, { success: false, reason: 'no mode declared' });
    return;
  }

  // A reconnect clears its own departure and sent-home record (Law 25).
  departedBots.delete(botId);
  sentHome.delete(botId);
  botClients.set(botId, {
    ws,
    mode: mode.trim().toLowerCase(),
    // Owner/species pairing is not re-validated here; bot_mandate already guarantees it (Law 16).
    owner: typeof msg.payload.owner === 'string' && msg.payload.owner.trim() ? msg.payload.owner.trim() : null,
    boardroom_chair: msg.payload.boardroom_chair || null,
    connected_at: new Date().toISOString(),
    last_sync: null,
  });
  mergeStationsInto(msg.payload.logistics_stations);
  mergeBuildingsInto(botBuildingsOnly(msg.payload.building_conference, msg.bot_id));

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
  mergeBuildingsInto(botBuildingsOnly(msg.payload.building_conference, msg.bot_id));

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

// Planning token transport (Law 16): the brain decides who gets the token; this delivers the grant.
brain.onPlanningGrant((botId, entry, resource) => {
  const client = botClients.get(botId);
  if (!client) return;   // winner vanished mid-grant — its disconnect cleanup closes the entry
  sendToBot(client.ws, 'planning_granted', botId, { entry, ...resource });
});
// The other answer to a request: the body's place in the line and who holds the token.
brain.onPlanningQueued((botId, place) => {
  const client = botClients.get(botId);
  if (!client) return;   // asker vanished — its disconnect cleanup takes it out of the line
  sendToBot(client.ws, 'planning_queued', botId, place);
});

// Forwards the brain's own log lines into the same run record, tagged [FOREMAN_BRAIN].
brain.onLog(persistCombined);

function handlePlanningRequest(ws, msg) {
  const botId = msg.bot_id;
  if (!botClients.has(botId)) {
    warn(`planning_request from unregistered bot '${botId}' — ignoring.`);
    return;
  }
  brain.requestPlanningToken(botId, msg.payload && msg.payload.phase, msg.payload && msg.payload.requestId);
}

// ── ONE BODY LOST ENDS THE WHOLE RUN ─────────────────────────────────────────────────────────────
// A body leaves a run one way: the foreman sent it home, and `sentHome` holds the record of that order.
// The run continues only on that proof (Law 13). Every other departure ends the whole run here, because
// the bodies are identical and the next one reaches the same place the same way.
function bodyLeft(botId, how, said) {
  if (sentHome.has(botId)) return;
  require('../js_kernel/utils/timeout_crash').crashEverything(`bot:${botId}`, `a body left the run and the foreman had not sent it home (${how})`, said);
}

// A body that has stopped working but whose process still runs is out of the gate and out of the line
// from this message on, by the same close a disconnect makes.
function handleBodyStoodDown(ws, msg) {
  const botId = msg.bot_id;
  if (!botClients.has(botId)) return;
  const reason = (msg.payload && msg.payload.reason) || 'no reason given';
  warn(`Bot '${botId}' stood down: ${reason}.`);
  brain.releaseForBot(botId, 'stood down');
  bodyLeft(botId, 'it stood down', reason);
}

function handlePlanningRelease(ws, msg) {
  const botId = msg.bot_id;
  if (!botClients.has(botId)) {
    warn(`planning_release from unregistered bot '${botId}' — ignoring.`);
    return;
  }
  brain.releasePlanningToken(botId, msg.payload && msg.payload.entry);
}

// A body that found itself stuck, or in a state the design makes impossible, says so here; the whole
// run ends on the foreman's one crash road with the body's report carried whole.
function handleFleetCrash(ws, msg) {
  const said = (msg.payload && msg.payload.report) || 'the body sent no report';
  require('../js_kernel/utils/timeout_crash').crashEverything(`bot:${msg.bot_id}`, 'a body asked for the whole run to end', said);
}

// Prints a bot's forwarded log line, tagged with its bot id.
// ── THE LIVE FAULT TALLY ─────────────────────────────────────────────────────
// Per-bot count of forwarded log lines by level (Law 3). Missing level counts as `unlabelled` (Law 25).
// `last_error` is the bot's own line, carried verbatim.
const LOG_LEVELS = ['summary', 'warn', 'error', 'context', 'unlabelled'];
const logTally = new Map();   // bot_id → { summary, warn, error, context, unlabelled, last_error }

// ── A BOT THAT LEAVES IS REMEMBERED AS HAVING LEFT ───────────────────────────
// Departure is a fact the foreman witnessed, kept beside the roster in fleet_state, not inside it (Law 8).
const departedBots = new Map();   // bot_id → { gone_at, last_error, sent_home }

// ── A BOT SENT HOME IS NOT A CRASH ────────────────────────────────────────────────────────
// `stop`/`shutdown`/`wipe` deliveries are recorded here so a departure reads as ordered.
const sentHome = new Map();       // bot_id → { verb, origin, asker }

function _tallyFor(botId) {
  let t = logTally.get(botId);
  if (!t) {
    t = { last_error: null, last_line_at: null, last_line: null };
    for (const k of LOG_LEVELS) t[k] = 0;
    logTally.set(botId, t);
  }
  return t;
}

// A bot with no forwarded line yet reads as all-zero (registered, so silence is a measurement).
function tallyOf(botId) {
  const t = logTally.get(botId) || _tallyFor(botId);
  return { ...t };
}

// ── THE LIVE WARNING FOLD ────────────────────────────────────────────────────
// Every warning the fleet has raised this run, folded by unit and shape as it arrives, so a live fleet
// answers "what is it warning about" from the door (Law 23). `sample` is the newest line of that shape,
// the bot's own words.
const warningFold = new Map();    // `${unit}|${shape}` → { unit, shape, count, bots:Set, first_at, last_at, sample }

function _foldWarning(botId, line) {
  const { unit, shape } = require('../js_kernel/utils/warning_shape').foldLine(line);
  const key = `${unit}|${shape}`;
  const now = new Date().toISOString();
  const row = warningFold.get(key) || { unit, shape, count: 0, bots: new Set(), first_at: now, last_at: now, sample: line };
  row.count++;
  row.bots.add(botId);
  row.last_at = now;
  row.sample = line;
  warningFold.set(key, row);
}

function warningsNow() {
  return [...warningFold.values()].map(r => ({ ...r, bots: [...r.bots] }));
}

function handleLog(msg) {
  const botId = msg.bot_id;
  const line = msg.payload && msg.payload.line;
  if (typeof line !== 'string') return;
  const level = (msg.payload && msg.payload.level) || null;
  const t = _tallyFor(botId);
  t[LOG_LEVELS.includes(level) ? level : 'unlabelled']++;
  // The newest line of any level and when it arrived: a body that has gone quiet shows here.
  t.last_line_at = new Date().toISOString();
  t.last_line = line.slice(0, 240);
  if (level === 'error') t.last_error = line;
  if (level === 'warn') _foldWarning(botId, line);
  const idx = line.indexOf('] ');
  const tagged = idx >= 0
    ? `${line.slice(0, idx + 1)} [${botId}]${line.slice(idx + 1)}`
    : `[${botId}] ${line}`;
  // Printed only; the bot already wrote this line to its own story file (Law 16 / Invariant D).
  console.log(tagged);
}

// Relays one fleet verb to every registered bot (Law 3). Returns the number of bots reached.
// `only` addresses a single bot (Law 4). `origin` is stamped by the foreman, the one party that
// observed which socket spoke (Law 23). In-game commands reach only the contractors owned by the
// asker; the terminal is outside the ownership model. Skipped counts are returned, not dropped (Law
// 6/25).
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
    if (sendToBot(client.ws, 'command', id, { verb, args, origin })) {
      sent++;
      if (verb === 'stop' || verb === 'shutdown') sentHome.set(id, { verb, origin, asker });
    }
  }
  return { sent, skippedSpecies, skippedOwner };
}

// The one operator-verb pathway (Law 16): console, socket, and the in-game door.
// `origin` is a required argument, stated explicitly by each transport, and never defaults (Law 13).
function runOperatorVerb(verb, source, args = {}, origin, asker = null) {
  // Every exit returns a verdict (Law 25).
  const nil = { sent: 0, skippedSpecies: 0, skippedOwner: 0 };
  if (!VALID_ORIGINS.has(origin)) {
    warn(`Refusing '${verb}' from ${source} — unstamped or unknown origin '${origin}'. Every operator verb must declare where it entered the fleet (${[...VALID_ORIGINS].join(' | ')}).`);
    return { ...nil, reason: 'bad_origin' };
  }
  // An in-game verb with no asker is refused (Law 13).
  if (origin === ORIGIN.INGAME && !asker) {
    warn(`Refusing '${verb}' from ${source} — it arrived from inside the world with nobody named as the asker.`);
    return { ...nil, reason: 'no_asker' };
  }
  if (!OPERATOR_VERBS.has(verb)) {
    warn(`Unknown ${source} verb '${verb}' — valid: ${[...OPERATOR_VERBS].join(' | ')}.`);
    return { ...nil, reason: 'unknown_verb' };
  }
  // ── THE IN-GAME VOCABULARY IS SMALLER THAN THE OPERATOR'S ────────────────────────────────────
  // Enforced by the origin the foreman observed, not at the bot (Law 23). `move`/`surveylayout`/
  // `respawn`/`sentry`/`flush` stay operator-only; the player's scoped equivalent of `flush` is `wipe`.
  if (origin === ORIGIN.INGAME && !INGAME_VERBS.has(verb)) {
    warn(`Refusing '${verb}' from ${asker} inside the world — it is an operator verb, not one of the `
      + `in-game vocabulary (${[...INGAME_VERBS].join(' | ')}). The terminal keeps it.`);
    return { ...nil, reason: 'not_ingame_verb' };
  }
  // ── 'shutdown' ENDS THE WHOLE RUN, TERMINAL ONLY ──────────
  // Not delivered to any bot: hands foremanWorld's shutdown road the reason.
  if (verb === 'shutdown') {
    const begun = foremanWorld.askShutdown(`the terminal's 'shutdown' (${source})`);
    return { ...nil, reason: begun ? 'shutting_down' : 'no_shutdown_road' };
  }
  // ── 'teleport' MOVES A PERSON, AND THE TERMINAL IS NOT ONE ───────────────────────────────────────
  // The in-game path never reaches here — the desk answers it directly. The terminal refuses it.
  if (verb === 'teleport') {
    warn(`'teleport' from ${source} has nobody to move — it brings the ASKER to the alpha anchor, so it is said inside the world by the person who wants to go there, never from the terminal.`);
    return { ...nil, reason: 'no_asker' };
  }
  // ── 'wipe' IS SETTLED HERE, ABOVE THE no_bots GATE, AND NEEDS NO BODY AT ALL ──────────────────
  // Contractors are stateless; the player's file is the only durable HQ, owned by this process (Law 16).
  // Struck centrally, in the same tombstone shape as station_registry. Scope is the speaker: in-game the
  // owner is the asker; the terminal's scope is the fleet (Law 27/28).
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
    // Station tombstones keep pos/type/owner; building tombstones keep nothing (station_registry's shape).
    let struckStations = 0;
    for (const [stationId, entry] of Object.entries(mergedStations)) {
      if (!entry || !owners.has(entry.owner)) continue;
      if (entry.removed_at) continue;
      mergedStations[stationId] = { pos: entry.pos, type: entry.type, owner: entry.owner, removed_at: now, updated_at: now };
      struckStations++;
    }

    for (const o of owners) wipedOwners.add(o);
    savePlayerMemory();
    const saved = ownerMemory.flushNow();
    broadcastBoardroom();

    // ── THE CREW GOES WITH THE MEMORY (Law 8) ──
    // Bots whose owner was wiped are stopped and sent home.
    let stopped = 0;
    for (const [botId, client] of botClients) {
      if (!client.owner || !owners.has(client.owner)) continue;
      if (sendToBot(client.ws, 'command', botId, { verb: 'stop', args: {}, origin })) {
        stopped++;
        sentHome.set(botId, { verb: 'wipe', origin, asker: client.owner });
      }
    }

    Promise.resolve(saved).then(() => log(`Wipe for ${[...owners].join(', ')}: ${struckBuildings} building room(s) and ${struckStations} station(s) `
      + `tombstoned, player-file flush finished (any failed save is reported above), ${stopped} bot(s) sent away.`));
    return { ...nil, reason: 'wiped', struckBuildings, struckStations, stopped };
  }

  if (botClients.size === 0) {
    warn(`No bots connected — '${verb}' not sent.`);
    return { ...nil, reason: 'no_bots' };
  }

  // 'flush' clears the mirrored fleet HQ (stations + structures + standing requests) so bots re-sync
  // from empty. Fleet-wide and not scopable — not in INGAME_VERBS, terminal only.
  if (verb === 'flush') {
    mergedStations = {};
    mergedBuildings = {};
    standingRequests = {};
    log('Flush: cleared mirrored fleet HQ (stations + structures + standing requests) — bots re-sync from empty.');
  }

  const only = typeof args.bot === 'string' && args.bot ? args.bot : null;
  const { sent, skippedSpecies, skippedOwner } = broadcastCommand(verb, args, only, origin, asker);
  const out = { sent, skippedSpecies, skippedOwner };
  // A verb that reaches nobody is not a delivery; which nobody is reported (Law 25).
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

// Headless transport. `origin` is a fixed argument per door, never read off the message (Law 23). The
// result travels back on the same socket (Law 25).
function handleOperatorCommand(ws, msg, origin) {
  const payload = operatorResult(msg.payload || {}, `socket:${msg.bot_id}`, origin);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(createEnvelope('command_result', 'foreman', payload)));
  }
}

// Verdict half of the handler above, shared by the socket and the desk.
function operatorResult(p, source, origin) {
  const verb = p.verb;
  const args = p.args || {};
  // `asker` is meaningful only on the in-game origin; the terminal door reads none (see broadcastCommand).
  const asker = typeof p.asker === 'string' && p.asker.trim() ? p.asker.trim() : null;
  const result = runOperatorVerb(typeof verb === 'string' ? verb.trim() : '', source, args, origin, asker)
    || { sent: 0, skippedSpecies: 0, skippedOwner: 0, reason: 'refused' };
  return { verb, origin, ...result };
}

// Who is out there, and whose — answered from the live registry, never a PID file (Invariant B).
// Reports the whole fleet; ownership governs delivery, not visibility.
// ── WHERE EACH BODY IS AND WHAT IT IS DOING ────────────
// Relayed from the chair each bot already writes: `body_cell` and the dispatcher's `magnet` (Law 3,
// Law 16). Null is an answer — no magnet is idle, no body_cell is unreported (Law 25). Carries the live
// fault tally beside the roster (Law 16).
function handleFleetQuery(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(createEnvelope('fleet_state', 'foreman', fleetState())));
  }
}

function fleetState() {
  const bots =[...botClients.entries()].map(([id, c]) => ({
    id,
    mode: c.mode,
    owner: c.owner,
    body_cell: (c.boardroom_chair && c.boardroom_chair.body_cell) || null,
    magnet: (c.boardroom_chair && c.boardroom_chair.magnet) || null,
    // First route search / first walk (navigator.announceFirstMove); null before then.
    first_move_at: (c.boardroom_chair && c.boardroom_chair.first_move_at) || null,
    // Bot's own liveness answer, written by job_board; null means not yet reported (Law 25).
    dead: (c.boardroom_chair && typeof c.boardroom_chair.dead === 'boolean') ? c.boardroom_chair.dead : null,
    // The body's own running clock of time on jobs and time walking for them (bot_minutes); null before its first job ends.
    work_clock: (c.boardroom_chair && c.boardroom_chair.work_clock) || null,
    // Which structures the body read as built on its last sweep (job_board); null before its first sweep.
    built: (c.boardroom_chair && c.boardroom_chair.built) || null,
    // The body's last count of finished cubes of the building it makes (downloaded_build); null before its first count.
    cubes_finished: (c.boardroom_chair && c.boardroom_chair.cubes_finished) || null,
    // The highest layer of that building the body has seen released for building (downloaded_build); null before.
    layer_released: (c.boardroom_chair && c.boardroom_chair.layer_released) || null,
    ...tallyOf(id),
  }));
  // Departed bots ride beside the roster, never inside it (Law 8).
  const departed = [...departedBots.entries()].map(([id, d]) => ({ id, ...d, ...tallyOf(id) }));
  // Sites that already exist, read-only, so the desk doesn't survey over an existing lock. Keyed
  // `<structure>|<owner>`; wiped rows left out.
  const buildings = {};
  for (const [key, entry] of Object.entries(mergedBuildings)) {
    if (!entry || isBuildingTombstone(entry) || !entry.set_buildspot) continue;
    buildings[key] = { set_buildspot: entry.set_buildspot, blueprint_paster: entry.blueprint_paster || null };
  }
  return { bots, departed, buildings, warnings: warningsNow(), workspace: brain.workspaceState(), world: foremanWorld.status(), run: require('./foreman_plan').progressNow() };
}

// handleRequestCommand — a person's standing requirement, from the desk.
// Asker is the owner key; refused when unnamed (Law 13). Rules live in request_ledger, called never
// copied (Law 16).

// crewProgress(asker) → freshest measurement per item for the bots this person owns, or {} (Law 3, Law
// 16). Silence is reported as silence, not zero (Law 25).
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
  const payload = requestResult(msg.payload || {});
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(createEnvelope('request_result', 'foreman', payload)));
  }
}

// Verdict half of the handler above, shared by the socket and the desk.
function requestResult({ action, item, quantity, asker }) {
  if (!asker) {
    warn('In-game door: a request naming no asker was refused.');
    return { ok: false, reason: 'no_asker' };
  }

  const ledger = requestLedger;

  if (action === 'post') {
    const result = ledger.applyPost(standingRequests, item, quantity, asker, asker);
    if (!result.ok) return { ok: false, reason: result.reason, blockedBy: result.blockedBy || null };
    standingRequests = result.rows;
    log(`Request: ${asker} asks for ${quantity} ${item}.`);
    return { ok: true, item: result.row.item, quantity: result.row.quantity, replaced: result.replaced };
  }
  if (action === 'cancel') {
    const { rows, removed } = ledger.applyCancel(standingRequests, item, asker);
    standingRequests = rows;
    log(`Request: ${asker} withdrew ${item} (${removed} row(s)).`);
    return { ok: true, removed };
  }
  if (action === 'status') {
    return { ok: true, rows: ledger.rowsFor(standingRequests, asker), progress: crewProgress(asker) };
  }
  warn(`In-game door: request action '${action}' is not spoken here.`);
  return { ok: false, reason: `unknown_action: ${action}` };
}

// ── THE IN-GAME DOOR ─────────────────────────────────────────────────────────────────────────────
// Its own listener, accepting operator verbs and one roster question. Anything else is reported and
// dropped (Law 6).
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
      case 'planning_cancel':
        if (botClients.has(msg.bot_id)) brain.cancelWorkspaceRequest(msg.bot_id, msg.payload && msg.payload.requestId);
        break;
      case 'planning_release':
        handlePlanningRelease(ws, msg);
        break;
      case 'body_stood_down':
        handleBodyStoodDown(ws, msg);
        break;
      case 'fleet_crash':
        handleFleetCrash(ws, msg);
        break;
      case 'log':
        handleLog(msg);
        break;
      case 'item_book':
        itemBook.record(msg.bot_id, msg.payload && msg.payload.entries);
        break;
      case 'operator_command':
        // This listener is the terminal door (fleet_control and the console).
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
        // Recorded before the delete so the tally travels with the departure.
        departedBots.set(botId, { gone_at: new Date().toISOString(), last_error: tallyOf(botId).last_error,
          sent_home: sentHome.get(botId) || null });
        botClients.delete(botId);
        brain.releaseForBot(botId);
        broadcastBoardroom();
        // The player's file must show the crew actually here; a chair dies with the connection (Law 8).
        savePlayerMemory();
        ownerMemory.flushNow();   // not queued behind the debounce
        bodyLeft(botId, 'its connection to the foreman closed', departedBots.get(botId).last_error || 'the body reported no error before it left');
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

// Both of the foreman's ports bind to this computer only: every bot it serves runs here.
const wss = new WebSocket.Server({ port: PORT, host: '127.0.0.1' });
wss.on('connection', onConnection);

// A port already in use is refused in world terms, with the fix named (Law 13, Law 25).
const listenFailure = (which) => (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  The foreman cannot start: something is already using port ${err.port || PORT}`
      + ` (${which}).\n`
      + `\n  Almost always this is an foreman that is already running — a second launcher, or one left`
      + `\n  over from earlier. There is only meant to be one.\n`
      + `\n  Either use the one that is running, or close it and start again.\n`);
    process.exit(1);
  }
  throw err;
};
wss.on('error', listenFailure('the fleet port'));

// The in-game door binds to localhost only — the surface that carries a stranger's authority.
const ingameDoor = new WebSocket.Server({ port: INGAME_DOOR_PORT, host: '127.0.0.1' });
ingameDoor.on('connection', onIngameConnection);
ingameDoor.on('error', listenFailure('the in-game door'));

// Startup banner, magenta — distinct from the bots' cyan banner.
(function hubBanner() {
  const M = '\x1b[95m\x1b[1m', R = '\x1b[0m';
  const bar = '═'.repeat(50);
  console.log(`${M}${bar}${R}`);
  console.log(`${M}  🛰️   FOREMAN HUB  ·  fleet log stream + command hub${R}`);
  console.log(`${M}      every bot's logs appear here, tagged [BotId]${R}`);
  console.log(`${M}${bar}${R}`);
})();

// ── THE MIRROR STARTS FULL, NOT EMPTY ───────────────────────────────────────────────────────────────
// Restores a player's HQ before the first bot can register.
Object.assign(mergedBuildings, _restored.buildings);
Object.assign(mergedStations,  _restored.stations);

log(`Foreman WebSocket server listening on ws://127.0.0.1:${PORT}`);
log(`In-game door listening on ws://127.0.0.1:${INGAME_DOOR_PORT} — verbs arriving here reach CONTRACTORS only.`);
log(`Waiting for bot connections...`);
log(`Operator console ready — type a verb + Enter to command every bot: start | stop | flush | shutdown.`);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Operator console (TTY transport into runOperatorVerb, Law 16).
// ─────────────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (input) => {
  const verb = (input || '').trim();
  if (!verb) return;
  runOperatorVerb(verb, 'console', {}, ORIGIN.TERMINAL);   // the operator's own keyboard IS the terminal
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — The desk's entrance (the foreman lives in this process)
// ─────────────────────────────────────────────────────────────────────────────
// Calls the same three answers the socket handlers call (Law 16). Origin fixed as in-game.
// ── WHERE THE CREW LIVES, AS ONE CELL ────────────────────────────────────────
// The alpha structure's buildspot (`architect_config.ALPHA_STRUCTURE`), read from lockSite's write.
// Null when nothing is sited (Law 25).
function alphaSpot() {
  const { ALPHA_STRUCTURE } = require('../Thinking_fragments/architect_config');
  const names = new Set(Object.values(ALPHA_STRUCTURE));
  for (const [key, entry] of Object.entries(mergedBuildings)) {
    if (!names.has(key.split(BUILDING_ROOM_SEPARATOR)[0])) continue;
    if (isBuildingTombstone(entry)) continue;
    const spot = entry.set_buildspot && entry.set_buildspot.transpose_origin;
    if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y) && Number.isFinite(spot.z)) {
      return { structure: key.split(BUILDING_ROOM_SEPARATOR)[0], x: spot.x, y: spot.y, z: spot.z };
    }
  }
  return null;
}

const desk = Object.freeze({
  fleetState: () => fleetState(),
  // The item book's file, written on demand; the run's end calls it once the bodies have left.
  writeItemBook: () => itemBook.write(),
  flushMemory: () => ownerMemory.flushNow(),
  // The crew's home cell, for the one verb that takes a person to it (see alphaSpot).
  alphaSpot: () => alphaSpot(),
  operator: (payload) => operatorResult(payload || {}, 'desk', ORIGIN.INGAME),
  request: (payload) => requestResult(payload || {}),
  // The one writer of a location (see lockSite). The desk calls it after its survey, before any spawn.
  lockSite: (rows, ownerKey) => lockSite(rows, ownerKey),
  // ── THE FLEET STOPS WHEN THE RUN ENDS ──
  // `why` rides to the bodies so each records the real cause of its own stop.
  // The foreman's own start for one body: a held crew's release, the operator's staggered `start` given by the run.
  startBody: (botId) => runOperatorVerb('start', 'foreman-body', { bot: botId }, ORIGIN.TERMINAL),
  stopFleet: (why) => {
    warn(`STOPPING THE FLEET — ${why}`);
    return runOperatorVerb('stop', 'foreman-body', { why }, ORIGIN.TERMINAL);
  },
});

module.exports = { desk };
