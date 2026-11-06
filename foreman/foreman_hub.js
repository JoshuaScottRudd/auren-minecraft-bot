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
const { createEnvelope, parseEnvelope, mergeFresherRows, pickBuildingEntry, isBuildingTombstone, BUILDING_ROOM_SEPARATOR } = require('./message_schema');
const brain = require('./foreman_brain');
// The foreman's own hold on world status (started, reached, failed, stopping), reported in fleetState.
const foremanWorld = require('./foreman_world');

// Operator vocabulary (Law 16).
const { OPERATOR_VERBS, READ_DOOR_PORT_OFFSET, roomKeyCrew } = require('./message_schema');

// Registers @-aliases and module homes for this process root (Law 16).
require('../js_kernel/utils/node_module_homes').bootstrapModulePath();
const cameraSpots = require('../js_kernel/utils/camera_spots');
require('module-alias')(path.resolve(__dirname, '..'));

// Request rules, used as pure functions over this process's own map (Invariant D, Law 6). Required at
// load, not inside the handler, so a missing module is a startup failure (Law 13).
// The fleet's one item book: every body's moves land here (item_book says what a move is).
const itemBook = require('./item_book');
itemBook.start();

// ── ONE PROCESS WITH THE FOREMAN ──────────────────────────────────────────
// Required by foreman/foreman.js; not started on its own. PORT comes from FOREMAN_PORT, not argv.
const PORT = parseInt(process.env.FOREMAN_PORT, 10) || 3001;
const READ_DOOR_PORT = PORT + READ_DOOR_PORT_OFFSET;
// The Auren_Bot root this foreman runs from: a terminal verb naming another is a neighbour's (handleOperatorCommand).
const OWN_COPY = path.resolve(__dirname, '..');
// sameCopy(a, b) → whether two roots name one folder, compared the way the file system does (case-insensitive on Windows).
function sameCopy(a, b) {
  if (typeof a !== 'string' || !a) return false;
  const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}

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

function mergeStationsInto(incoming) {
  mergeFresherRows(mergedStations, incoming);
}

// The fleet's survey book (perception_nodes.js/survey_book): what is available in each scanned sector and
// cave, merged by the station map's rule. The world's, not a crew's: it is relayed, never saved here; each
// homesteader keeps it in its own memory and sends it again on registering.
let mergedSurvey = {};

// Merged fleet structures across all bots, first-writer-wins via pickBuildingEntry (Law 3).
let mergedBuildings = {};

// The mine's registered units, every body's merged (mining_cell_graph keeps each body's in its own memory). Read
// only by the integrity keeper, which paints every unit; never broadcast, so no body adopts another's units.
let mergedMineCells = {};
function mergeMineCellsInto(incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  for (const [id, unit] of Object.entries(incoming)) {
    if (!unit || typeof unit !== 'object' || !unit.anchor) continue;
    const had = mergedMineCells[id];
    mergedMineCells[id] = had ? { ...had, ...unit, complete: !!(had.complete || unit.complete), blocked: !!(had.blocked || unit.blocked) } : unit;
  }
}

// The integrity keeper's latest verdict per subject, sent to every body as it changes and to a body as it registers.
const keeperVerdicts = new Map();
function publishVerdict(subject, verdict) {
  keeperVerdicts.set(subject, verdict);
  for (const [id, client] of botClients) sendToBot(client.ws, 'keeper_verdict', id, { subject, verdict });
}

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

// lockSite(rows, crew) — the one writer of a location, called by the foreman before any body exists. Each row
// becomes the two chairs `site_chairs` builds, saved to the crew's file and broadcast.
//
// ONE BASE HAS ONE SITE: a matching centre is accepted, a different centre is refused (Law 13).
//
// The crew half of the key is the species the foreman raises, joined here once with the row's plain
// structure name, as a body joins its own (`bot_mandate.buildingRoomKey`).
async function lockSite(rows, crew) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`[foreman_hub] CODING VIOLATION (Law 13): lockSite needs the rows the foreman sited, got ${JSON.stringify(rows)}.`);
  }
  if (typeof crew !== 'string' || !crew || crew.includes(BUILDING_ROOM_SEPARATOR)) {
    throw new Error(`[foreman_hub] CODING VIOLATION (Law 13): lockSite needs the crew's species, got ${JSON.stringify(crew)}.`);
  }
  const { siteChairs } = require('@kernel/site_chairs');
  const locked = [];
  const already = [];
  for (const row of rows) {
    if (typeof row.roomKey !== 'string' || !row.roomKey || row.roomKey.includes(BUILDING_ROOM_SEPARATOR)) {
      throw new Error(`[foreman_hub] CODING VIOLATION (Law 13): a site row names its plain structure ('headframe'), got roomKey ${JSON.stringify(row.roomKey)}.`);
    }
    const key = `${row.roomKey}${BUILDING_ROOM_SEPARATOR}${crew}`;
    const held = mergedBuildings[key];
    const bc = row.candidate && row.candidate.transpose_origin;
    if (held && !isBuildingTombstone(held) && held.set_buildspot && held.set_buildspot.transpose_origin) {
      const h = held.set_buildspot.transpose_origin;
      if (bc && h.x === bc.x && h.y === bc.y && h.z === bc.z) { already.push(key); continue; }
      throw new Error(`[foreman_hub] CODING VIOLATION (Law 13): '${key}' is already sited at (${h.x},${h.y},${h.z}); `
        + `the foreman asked for (${bc && bc.x},${bc && bc.y},${bc && bc.z}). One base has one site — the foreman hands an existing base back, it never surveys over it.`);
    }
    mergedBuildings[key] = siteChairs(row, 'foreman');
    locked.push(key);
  }
  log(`Sited: locked [${locked.join(', ') || 'nothing new'}]${already.length ? `, already held [${already.join(', ')}]` : ''}.`);
  saveCrewMemory();
  await crewMemory.flushNow();
  broadcastBoardroom();
  return { locked, already };
}

// ── THE FLOOR UNDER BOTH MIRRORS ─────────────────────────────────────────────
// mergedBuildings/mergedStations are a live mirror only, empty on every foreman start. `crew_memory` is
// the durable disk copy beneath them, one file per crew (Law 3).
const crewMemory = require('./crew_memory');

// Saved on every merge, debounced inside crew_memory.
// wipedCrews: every crew that has been wiped, so a later save may write its file empty.
const wipedCrews = new Set();

function saveCrewMemory() {
  crewMemory.save(mergedBuildings, mergedStations, (m) => log(m), wipedCrews);
}

// Read at require time; applied to the two maps at listen time (see the startup banner below).
const _restored = crewMemory.loadAll((m) => log(m));

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

// ── ONE BROADCAST PER BURST OF CHANGES ──
// A body's hq_delta arrives several times a second across a crew, and every broadcast carries the whole HQ to every body,
// so the deltas are gathered for BOARDROOM_BATCH_MS and sent as one broadcast. A body granted the planning gate must
// hold every peer's claim before it plans: a gathered broadcast is sent before any grant (onPlanningGrant), ahead of the
// grant on the same socket.
const BOARDROOM_BATCH_MS = 250;
let _boardroomDue = null;
function broadcastBoardroomSoon() {
  if (_boardroomDue) return;
  _boardroomDue = require('../js_kernel/utils/timeout_crash').later('foreman_hub', 'send the gathered HQ changes to every body as one broadcast', () => {
    _boardroomDue = null;
    broadcastBoardroom();
  }, BOARDROOM_BATCH_MS);
}
function flushBoardroom() {
  if (_boardroomDue) broadcastBoardroom();
}

function broadcastBoardroom() {
  if (_boardroomDue) { require('../js_kernel/utils/timeout_crash').stop(_boardroomDue); _boardroomDue = null; }
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
    if (buildingsPresent) payload.building_conference = mergedBuildings;
    if (Object.keys(mergedSurvey).length > 0) payload.survey_book = mergedSurvey;
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
    boardroom_chair: msg.payload.boardroom_chair || null,
    connected_at: new Date().toISOString(),
    last_sync: null,
  });
  mergeStationsInto(msg.payload.logistics_stations);
  mergeFresherRows(mergedSurvey, msg.payload.survey_book);
  mergeBuildingsInto(botBuildingsOnly(msg.payload.building_conference, msg.bot_id));

  log(`Bot '${botId}' registered as ${mode.trim().toUpperCase()}. Total bots: ${botClients.size}`);
  sendToBot(ws, 'registered', botId, { success: true });
  for (const [subject, verdict] of keeperVerdicts) sendToBot(ws, 'keeper_verdict', botId, { subject, verdict });

  broadcastBoardroom();
  saveCrewMemory();
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
  mergeFresherRows(mergedSurvey, msg.payload.survey_book);
  mergeBuildingsInto(botBuildingsOnly(msg.payload.building_conference, msg.bot_id));
  mergeMineCellsInto(msg.payload.mining_cells);

  broadcastBoardroomSoon();
  saveCrewMemory();
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
  flushBoardroom();
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
  bodyLeft(botId, `it stood down: ${reason}`, reason);
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
const sentHome = new Map();       // bot_id → { verb }

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
// `only` addresses a single bot (Law 4).
function broadcastCommand(verb, args = {}, only = null) {
  let sent = 0;
  for (const [id, client] of botClients) {
    if (only && id !== only) continue;
    if (sendToBot(client.ws, 'command', id, { verb, args })) {
      sent++;
      if (verb === 'stop' || verb === 'shutdown') sentHome.set(id, { verb });
    }
  }
  return { sent };
}

// The one operator-verb pathway (Law 16): the console, the terminal socket, and the foreman's own body.
function runOperatorVerb(verb, source, args = {}) {
  // Every exit returns a verdict (Law 25).
  const nil = { sent: 0 };
  if (!OPERATOR_VERBS.has(verb)) {
    warn(`Unknown ${source} verb '${verb}' — valid: ${[...OPERATOR_VERBS].join(' | ')}.`);
    return { ...nil, reason: 'unknown_verb' };
  }
  // ── A NUMBERED CAMERA IS THE FOREMAN'S OWN ANSWER ──────────
  // Not delivered to any bot. The answer is a promise: it reads the server.
  if (cameraSpots.VERBS.has(verb)) {
    return cameraSpots.run(verb, args).then((r) => {
      log(`camera: ${r.said}`);
      return { ...nil, ...r };
    });
  }
  // ── 'shutdown' ENDS THE WHOLE RUN, TERMINAL ONLY ──────────
  // Not delivered to any bot: hands foremanWorld's shutdown road the reason.
  if (verb === 'shutdown') {
    const begun = foremanWorld.askShutdown(`the terminal's 'shutdown' (${source})`);
    return { ...nil, reason: begun ? 'shutting_down' : 'no_shutdown_road' };
  }
  // ── 'wipe' IS SETTLED HERE, ABOVE THE no_bots GATE, AND NEEDS NO BODY AT ALL ──────────────────
  // Struck centrally, in the same tombstone shape as station_registry, for the crew of every connected body
  // (its species, the crew half of every key it writes).
  if (verb === 'wipe') {
    const crews = new Set();
    for (const [botId, c] of botClients.entries()) {
      if (args.bot && args.bot !== botId) continue;
      crews.add(c.mode);
    }
    if (crews.size === 0) {
      warn(`Wipe from ${source} named nobody — no connected body names a crew, so nothing was struck.`);
      return { ...nil, reason: 'reached_nobody' };
    }

    const now = Date.now();
    let struckBuildings = 0;
    for (const [key, entry] of Object.entries(mergedBuildings)) {
      if (!crews.has(roomKeyCrew(key))) continue;
      if (entry && entry.removed_at) continue;                    // already struck — do not re-stamp
      mergedBuildings[key] = { removed_at: now };
      struckBuildings++;
    }
    // Station tombstones keep pos/type/owner (the row's crew); building tombstones keep nothing (station_registry's shape).
    let struckStations = 0;
    for (const [stationId, entry] of Object.entries(mergedStations)) {
      if (!entry || !crews.has(entry.owner)) continue;
      if (entry.removed_at) continue;
      mergedStations[stationId] = { pos: entry.pos, type: entry.type, owner: entry.owner, removed_at: now, updated_at: now };
      struckStations++;
    }

    for (const c of crews) wipedCrews.add(c);
    saveCrewMemory();
    const saved = crewMemory.flushNow();
    broadcastBoardroom();

    // ── THE CREW GOES WITH THE MEMORY (Law 8) ──
    // Bots whose crew was wiped are stopped and sent home.
    let stopped = 0;
    for (const [botId, client] of botClients) {
      if (!crews.has(client.mode)) continue;
      if (sendToBot(client.ws, 'command', botId, { verb: 'stop', args: {} })) {
        stopped++;
        sentHome.set(botId, { verb: 'wipe' });
      }
    }

    Promise.resolve(saved).then(() => log(`Wipe for ${[...crews].join(', ')}: ${struckBuildings} building room(s) and ${struckStations} station(s) `
      + `tombstoned, crew-file flush finished (any failed save is reported above), ${stopped} bot(s) sent away.`));
    return { ...nil, reason: 'wiped', struckBuildings, struckStations, stopped };
  }

  if (botClients.size === 0) {
    warn(`No bots connected — '${verb}' not sent.`);
    return { ...nil, reason: 'no_bots' };
  }

  // 'flush' clears the mirrored fleet HQ (stations + structures) so bots re-sync from empty. Fleet-wide
  // and not scopable.
  if (verb === 'flush') {
    mergedStations = {};
    mergedBuildings = {};
    mergedMineCells = {};
    mergedSurvey = {};
    log('Flush: cleared mirrored fleet HQ (stations + structures + survey book) — bots re-sync from empty.');
  }

  const only = typeof args.bot === 'string' && args.bot ? args.bot : null;
  const { sent } = broadcastCommand(verb, args, only);
  const out = { sent };
  // A verb that reaches nobody is not a delivery; which nobody is reported (Law 25).
  if (only && sent === 0) {
    warn(`'${verb}' addressed to '${only}' — no such bot connected; nothing sent.`);
    return { ...out, reason: 'no_such_bot' };
  }
  if (sent === 0) {
    warn(`'${verb}' from ${source} reached no bot.`);
    return { ...out, reason: 'reached_nobody' };
  }
  log(`Broadcast '${verb}' to ${sent} bot(s) [${source}]${only ? ` (addressed: ${only})` : ''}.`);
  return { ...out, reason: null };
}

// Headless transport: the terminal socket. The result travels back on the same socket (Law 25).
//
// ONE COPY'S TOOLS COMMAND ONLY ITS OWN FLEET. Several copies run fleets on one machine, each foreman on its own port,
// and a tool that guessed a port could reach a neighbour's. A terminal verb names the copy it was sent from (`copy`,
// the sender's Auren_Bot root); one from another copy, or naming none, is refused unless it says it is `deliberate`.
function handleOperatorCommand(ws, msg) {
  const p = msg.payload || {};
  const foreign = p.deliberate !== true && !sameCopy(p.copy, OWN_COPY);
  const verdict = foreign
    ? (warn(`Refusing '${p.verb}' from socket:${msg.bot_id} — sent from ${p.copy || 'a copy that did not name itself'}, `
        + `and this fleet belongs to ${OWN_COPY}. A verb for another copy's fleet says --deliberate.`),
      { sent: 0, reason: 'other_copy', copy: OWN_COPY })
    : operatorResult(p, `socket:${msg.bot_id}`);
  Promise.resolve(verdict).then((payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(createEnvelope('command_result', 'foreman', payload)));
    }
  });
}

// Verdict half of the handler above.
async function operatorResult(p, source) {
  const verb = p.verb;
  const args = p.args || {};
  const result = (await runOperatorVerb(typeof verb === 'string' ? verb.trim() : '', source, args))
    || { sent: 0, reason: 'refused' };
  return { verb, ...result };
}

// Who is out there — answered from the live registry, never a PID file (Invariant B).
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
    // The books the building's stood-in cells still owe on the body's last read (downloaded_plan_registry standIns); null before.
    books_owed: (c.boardroom_chair && typeof c.boardroom_chair.books_owed === 'number') ? c.boardroom_chair.books_owed : null,
    ...tallyOf(id),
  }));
  // Departed bots ride beside the roster, never inside it (Law 8).
  const departed = [...departedBots.entries()].map(([id, d]) => ({ id, ...d, ...tallyOf(id) }));
  // Sites that already exist, read-only, so the foreman doesn't survey over an existing lock. Keyed
  // `<structure>|<crew>`; wiped rows left out.
  const buildings = {};
  for (const [key, entry] of Object.entries(mergedBuildings)) {
    if (!entry || isBuildingTombstone(entry) || !entry.set_buildspot) continue;
    buildings[key] = { set_buildspot: entry.set_buildspot, blueprint_paster: entry.blueprint_paster || null };
  }
  return { bots, departed, buildings, warnings: warningsNow(), workspace: brain.workspaceState(), world: foremanWorld.status(), run: require('./foreman_plan').progressNow() };
}

// ── THE READ DOOR ────────────────────────────────────────────────────────────────────────────────
// Its own listener, answering one roster question for the tools that read a live fleet (foreman_door.query).
// It carries no verb: a verb comes through the terminal socket. Anything else is reported and dropped (Law 6).
function onReadDoorConnection(ws) {
  ws.on('message', (raw) => {
    const parsed = parseEnvelope(raw.toString());
    if (!parsed.ok) { warn(`Read door: bad message: ${parsed.reason}`); return; }
    const msg = parsed.msg;
    if (msg.type === 'fleet_query') { handleFleetQuery(ws, msg); return; }
    warn(`Read door: '${msg.type}' is not spoken here — the door answers one roster question, nothing else. Dropped.`);
  });
  ws.on('error', (err) => warn(`Read door socket error: ${err.message}`));
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
      case 'combat_note':
        for (const [botId, client] of botClients) if (botId !== msg.bot_id) guardExternalSync('foreman_hub', 'relay combat note', () => client.ws.send(raw.toString()));
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
      // A body's ask before its planning turn takes a verdict: the foreman's own claim of where the keeper's body is
      // and where it belongs. The body checks the claim against the server (keeper_verdicts.verifyAuthority).
      case 'keeper_where': {
        if (!botClients.has(msg.bot_id)) break;
        const spot = alphaSpot();
        const { LIFT } = require('./utils/observer');
        sendToBot(ws, 'keeper_here', msg.bot_id, {
          requestId: msg.payload && msg.payload.requestId,
          ...require('./integrity_keeper').where(),
          station: spot ? { x: spot.x, y: spot.y + LIFT, z: spot.z } : null,
        });
        break;
      }
      // A body's ask for the nearest biome of a whitelisted decorative dye source, answered by the server's own locate.
      case 'decoration_locate': {
        if (!botClients.has(msg.bot_id)) break;
        const { requestId, item, biome, from } = msg.payload || {};
        const locator = require('./decoration_locate');
        (biome ? locator.locateForModule(biome, from) : locator.locate(item, from)).then((answer) => {
          log(`DECORATION_LOCATE bot=${msg.bot_id} item=${answer.item} from=(${Math.floor(from.x)},${Math.floor(from.z)}) reason=${answer.reason}`
            + (answer.found ? ` biome=${answer.found.biome} at=(${answer.found.x},${answer.found.z}) distance=${answer.found.distance}` : ''));
          sendToBot(ws, 'decoration_located', msg.bot_id, { requestId, ...answer });
        });
        break;
      }
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
        handleOperatorCommand(ws, msg);
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
        saveCrewMemory();
        crewMemory.flushNow();   // not queued behind the debounce
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

// A port already in use is refused in world terms, with the fix named (Law 13, Law 25). A foreman holds TWO ports,
// FOREMAN_PORT and the one above it (the read door). start_auren.js takes a free pair before raising the foreman
// (port_book), so this is reached when FOREMAN_PORT named a pair that is held, or a port was taken in the moment between.
const listenFailure = (which) => (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  The foreman cannot start: something is already using port ${err.port || PORT}`
      + ` (${which}).\n`
      + `\n  This foreman takes two ports: ${PORT} for the fleet and ${READ_DOOR_PORT} for the read door.`
      + `\n  Either a foreman is already running from this copy (use it, or close it and start again),`
      + `\n  or another program holds a port of this pair. Start without FOREMAN_PORT set and the start takes`
      + `\n  the first free pair itself; with FOREMAN_PORT set, name a pair that is free.\n`);
    process.exit(1);
  }
  throw err;
};
wss.on('error', listenFailure('the fleet port'));

// The read door binds to localhost only.
const readDoor = new WebSocket.Server({ port: READ_DOOR_PORT, host: '127.0.0.1' });
readDoor.on('connection', onReadDoorConnection);
readDoor.on('error', listenFailure('the read door'));

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
// Restores the crew's HQ before the first bot can register.
Object.assign(mergedBuildings, _restored.buildings);
Object.assign(mergedStations,  _restored.stations);

log(`Foreman WebSocket server listening on ws://127.0.0.1:${PORT}`);
log(`Read door listening on ws://127.0.0.1:${READ_DOOR_PORT} — it answers the fleet's state, and carries no verb.`);
log(`Waiting for bot connections...`);
log(`Operator console ready — type a verb + Enter to command every bot: start | stop | flush | shutdown.`);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Operator console (TTY transport into runOperatorVerb, Law 16).
// ─────────────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (input) => {
  const verb = (input || '').trim();
  if (!verb) return;
  const [first, number] = verb.split(/\s+/);
  if (cameraSpots.VERBS.has(first)) { runOperatorVerb(first, 'console', { number }); return; }
  runOperatorVerb(verb, 'console', {});
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — The foreman's entrance (the foreman lives in this process)
// ─────────────────────────────────────────────────────────────────────────────
// The foreman body's own reads and writes on the hub, in this process (Law 16).
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

const hub = Object.freeze({
  fleetState: () => fleetState(),
  // The item book's file, written on demand; the run's end calls it once the bodies have left.
  writeItemBook: () => itemBook.write(),
  flushMemory: () => crewMemory.flushNow(),
  // The crew's home cell, where the raised crew is put down (see alphaSpot).
  alphaSpot: () => alphaSpot(),
  // The one writer of a location (see lockSite). The foreman calls it after its survey, before any spawn.
  lockSite: (rows, crew) => lockSite(rows, crew),
  // The plans the integrity keeper compares the world against: every structure and every mine unit.
  keeperPlans: () => ({ buildings: mergedBuildings, mine_cells: mergedMineCells }),
  // A verdict from the integrity keeper, out to every body.
  publishVerdict: (subject, verdict) => publishVerdict(subject, verdict),
  // The foreman's home-sector scan (sector_scan.foremanScan), into the survey book every body receives.
  recordSurvey: (pages) => { mergeFresherRows(mergedSurvey, pages); broadcastBoardroomSoon(); },
  // ── THE FLEET STOPS WHEN THE RUN ENDS ──
  // `why` rides to the bodies so each records the real cause of its own stop.
  // The foreman's own start for one body: a held crew's release, the operator's staggered `start` given by the run.
  startBody: (botId) => runOperatorVerb('start', 'foreman-body', { bot: botId }),
  stopFleet: (why) => {
    warn(`STOPPING THE FLEET — ${why}`);
    return runOperatorVerb('stop', 'foreman-body', { why });
  },
});

module.exports = { hub };
