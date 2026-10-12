// js_kernel/foreman_link.js
// Bot-side WebSocket client for foreman communication. Four capabilities
// (de-confliction taxonomy in foreman_brain.js):
//   1. sendUpdate() — pushes chair + shared logistics/structure state to the
//      foreman for broadcast (Law 15 API).
//   2. requestClaim(key) / releaseClaim(key) — arbiter flavor (a): exclusive
//      hold on a world object ('anchor:…', 'tree:…', 'cell:…'). Resolves
//      { granted, reason? }; can be rejected.
//   3. acquirePlanningToken() / releasePlanningToken() — arbiter flavor (b):
//      the plan-phase mutex, never rejected; a loser parks until promoted.
//   4. forwardLog(line) — mirrors the watcher stream to the foreman's
//      combined console (display only).
// Granted claims mirror into this bot's boardroom chair (active_claims) so
// peers can see what each bot has locked (Law 6), and a claim's row carries
// the box it closes to peers (closeClaimedArea). No foreman configured or
// connection dropped = local-only mode: requestClaim always grants,
// sendUpdate is a no-op (Law 16).

'use strict';

const WebSocket = require('ws');
const watcher = require('@kernel/watcher');
const { createEnvelope, parseEnvelope } = require('@foreman/message_schema');
const { guardExternalSync } = require('@utils/external_library_guard');
const timeoutCrash = require('@utils/timeout_crash');
const memoryWorkspace = require('@utils/memory_workspace');

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — State
// ─────────────────────────────────────────────────────────────────────────────

let _ws = null;
let _botId = null;
let _foremanUrl = null;
let _connected = false;
let _reconnectTimer = null;

let _pendingClaim = null;
let _bodyCellTimer = null;

// Planning token (plan-phase mutex — arbiter flavor b, foreman_brain.js
// taxonomy). Never rejected: the bot parks until 'planning_granted' arrives,
// so there is no timeout on the wait.
let _pendingPlanning = null;       // { resolve, answer } parked until planning_granted
let _planningEntry = null;         // the entry number this body is inside the planning gate on | null
let _planningPhase = null;
let _planningRequestId = 0;

const RECONNECT_INTERVAL_MS = 5000;

// Each bot publishes only its body cell so peers avoid it in A* and yield at
// doorways; broadcasts only when the cell changes, so a parked bot is silent.
const BODY_CELL_INTERVAL_MS = 1000;
// A cell older than this is treated as a ghost (crashed/stalled peer) and
// ignored, not routed around (Law 13: default = free).
const BODY_CELL_FRESH_MS = 15000;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Public API
// ─────────────────────────────────────────────────────────────────────────────

function isConnected() {
  return _connected && _ws && _ws.readyState === WebSocket.OPEN;
}

function getBotId() {
  return _botId;
}

// Sends this bot's boardroom chair (magnet + chest locks), logistics station
// registry (chests/furnaces + in-flight orders), and building conference
// (established buildspots) to the foreman for broadcast (Law 6).
function sendUpdate() {
  if (!isConnected()) return;

  const hqModule = require('@kernel/corporate_headquarters');
  const chair = hqModule.readBoardroomChair(_botId);
  if (!chair) return;

  const stations = hqModule.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
  const buildings = hqModule.readOffice('building_confrence_room') || {};
  // Salvage is a live per-bot entity-table scan, not shareable state, so no
  // death-pile field travels on this envelope (Law 23).
  const envelope = createEnvelope('hq_delta', _botId, {
    boardroom_chair: chair,
    logistics_stations: stations,
    building_conference: buildings,
  });
  _ws.send(JSON.stringify(envelope));
}

// Mirror held claims into this bot's boardroom chair so peers see what this
// bot has locked via the ordinary chair broadcast — no second sync channel.
function _recordClaimInChair(key) {
  const hqModule = require('@kernel/corporate_headquarters');
  const botId = _botId || process.env.BOT_ID || 'default';
  const chair = hqModule.readBoardroomChair(botId, {}) || {};
  if (!chair.active_claims) chair.active_claims = {};
  chair.active_claims[key] = { claimed_at: Date.now() };
  hqModule.writeBoardroomChair(botId, chair);
  sendUpdate();
}

function _dropClaimFromChair(key) {
  const hqModule = require('@kernel/corporate_headquarters');
  const botId = _botId || process.env.BOT_ID || 'default';
  const chair = hqModule.readBoardroomChair(botId, {}) || {};
  if (chair.active_claims && chair.active_claims[key]) {
    delete chair.active_claims[key];
    hqModule.writeBoardroomChair(botId, chair);
    sendUpdate();
  }
}

// ── A HELD CLAIM MAY CLOSE THE GROUND IT WORKS ───────────────────────────────
// closeClaimedArea states the box a held claim closes to every peer's route and dig. The box rides the
// claim's own row in the chair, so it reaches peers on the ordinary broadcast and ends with the claim
// (Law 8). `box` is { min:{x,y,z}, max:{x,y,z} }, world cells, both ends included.
function closeClaimedArea(key, box) {
  const hqModule = require('@kernel/corporate_headquarters');
  const botId = _botId || process.env.BOT_ID || 'default';
  const chair = hqModule.readBoardroomChair(botId, {}) || {};
  const row = chair.active_claims && chair.active_claims[key];
  if (!row) {
    throw new Error(`foreman_link: CODING VIOLATION (Law 13) — closeClaimedArea('${key}') was called by a body `
      + 'that does not hold that claim. The ground is closed by the claim\'s holder, after the grant.');
  }
  const cell = (c) => ({ x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) });
  row.box = { min: cell(box.min), max: cell(box.max) };
  hqModule.writeBoardroomChair(botId, chair);
  sendUpdate();
  watcher.summary('foreman_link', `Closed ${key} to peers: (${row.box.min.x},${row.box.min.y},${row.box.min.z}) to (${row.box.max.x},${row.box.max.y},${row.box.max.z}).`);
}

// Every box a working peer has closed — a perception-style read of merged chair state, the same read
// as getPeerBodyCells. A chair with no magnet holds no job, so its rows close nothing.
function getPeerClosedAreas() {
  const hqModule = require('@kernel/corporate_headquarters');
  const botId = _botId || process.env.BOT_ID || 'default';
  const out = [];
  for (const [id, chair] of Object.entries(hqModule.getFullBoardroom({}))) {
    if (id === botId || !chair || !chair.magnet) continue;
    for (const [key, row] of Object.entries(chair.active_claims || {})) {
      if (row && row.box) out.push({ botId: id, key, min: row.box.min, max: row.box.max });
    }
  }
  return out;
}

// Every claim key a working peer holds — the same merged chair read as getPeerClosedAreas.
function peerClaimKeys() {
  const hqModule = require('@kernel/corporate_headquarters');
  const botId = _botId || process.env.BOT_ID || 'default';
  const out = new Set();
  for (const [id, chair] of Object.entries(hqModule.getFullBoardroom({}))) {
    if (id === botId || !chair || !chair.magnet) continue;
    for (const key of Object.keys(chair.active_claims || {})) out.add(key);
  }
  return out;
}

// The peer area holding this cell, or null when the cell is open ground.
function peerAreaAt(x, y, z) {
  for (const a of getPeerClosedAreas()) {
    if (x >= a.min.x && x <= a.max.x && y >= a.min.y && y <= a.max.y && z >= a.min.z && z <= a.max.z) return a;
  }
  return null;
}

// ── THE PREDICATE IS CONFIGURATION, NEVER CONNECTION STATE ────────────────────
// _foremanUrl (set once at connect(), never changed) distinguishes a bot
// started alone from one whose foreman is unreachable; isConnected() cannot,
// so it never decides whether a claim grants. Asks the foreman to grant a
// claim key (category or object). Returns Promise<{ granted, reason? }>.
function requestClaim(key) {
  if (!_foremanUrl) {
    // Born alone: no arbiter exists. Still recorded in the chair so this
    // bot's own sweeps can read its holds back.
    _recordClaimInChair(key);
    return Promise.resolve({ granted: true });
  }
  if (!isConnected()) {
    // Configured with a foreman that is unreachable: the body is stopping
    // (see the `close` handler), so no new hold is granted (Law 13).
    return Promise.resolve({ granted: false, reason: 'the foreman is gone — this body is stopping and is taking no new holds' });
  }

  if (_pendingClaim) {
    return Promise.reject(new Error('foreman_link: another claim is already pending'));
  }

  return new Promise((resolve, reject) => {
    // The body's half of the two-way watch: the foreman answers a claim at once, and timeout_crash's one
    // clock is on that answer.
    const answer = timeoutCrash.watch('claim', `the foreman has not answered this body's claim on '${key}'`);

    _pendingClaim = { key, resolve, reject, answer };   // reject is kept: a claimant-side key fault is a throw, not an answer (see 'claim_rejected')

    const envelope = createEnvelope('claim_request', _botId, { key });
    _ws.send(JSON.stringify(envelope));
    // No log on request/grant/release — routine bookkeeping would flood the
    // story (Law 5); only a denial (claim_rejected) logs.
  });
}

// ── The planning gate, from the body's side (plan-phase mutex) ───────────────
// acquirePlanningToken() resolves only once this body is INSIDE the gate, holding the entry number the
// foreman issued. releasePlanningToken() sends that same number back as the exit token. A body in the
// line waits its turn with no clock of its own: the foreman watches each body that is inside. Granted
// instantly in local mode. Distinct from requestClaim/the magnet — taxonomy in foreman_brain.js.
//
// The body's one clock is timeout_crash's, on the foreman's ANSWER to a request (granted or queued).
// A grant this body is not waiting for, a grant while it is already inside, and an exit with no entry
// in hand are impossible states, and each ends the whole run through timeout_crash.

const _planningState = () => `this body: ${_pendingPlanning ? 'waiting on a request' : 'not waiting'}, `
  + `${_planningEntry === null ? 'not inside the gate' : `inside on entry #${_planningEntry}`}, foreman socket ${isConnected() ? 'open' : 'closed'}`;

// How a body ends the whole run: its own record first, then the foreman is told and ends everyone, then
// this body ends. A foreman that cannot be told sees this body's error and its departure instead.
function _registerCrashRoad() {
  timeoutCrash.onCrash((report) => {
    watcher.error('timeout_crash', report);
    if (isConnected()) {
      guardExternalSync('foreman_link', 'send fleet_crash', () => _ws.send(JSON.stringify(createEnvelope('fleet_crash', _botId, { report }))));
    }
    require('@utils/body_end').endBody('this body ended the whole run — see its timeout_crash report', { code: 1 });
  });
}

// ── STANDING DOWN: A BODY THAT HAS STOPPED WORKING LEAVES THE GATE BEFORE IT DOES ANYTHING ELSE ──────
// A body that lost the world, or whose signal died outside the judge, still has a live process and a
// live foreman socket, so the foreman would wait on it. This is the first act of such a body: one
// message, sent before any record is flushed to disk, after which this body neither asks to enter nor
// sends an exit.
let _stoodDown = false;
function standDown(reason) {
  if (_stoodDown || !_foremanUrl) return;
  _stoodDown = true;
  if (_pendingPlanning) { _pendingPlanning.answer.done(); _pendingPlanning = null; }
  _planningEntry = null;
  _planningPhase = null;
  memoryWorkspace.leave();
  if (!isConnected()) return;
  guardExternalSync('foreman_link', 'send body_stood_down', () => _ws.send(JSON.stringify(createEnvelope('body_stood_down', _botId, { reason }))));
}

function acquirePlanningToken(phase = 'planning') {
  // Same _foremanUrl split as requestClaim: alone plans freely; a foreman
  // that's gone means stopping, so the acquire never resolves (Law 4).
  if (!_foremanUrl) {
    if (memoryWorkspace.enabled()) memoryWorkspace.enter(memoryWorkspace.measureGrant());
    _planningPhase = phase;
    return Promise.resolve();
  }
  if (!isConnected() || _stoodDown) {
    return new Promise(() => {});
  }

  if (_pendingPlanning || _planningEntry !== null) {
    // Law 4 makes two concurrent plan phases impossible in a correct system, so a second acquire is a
    // coding violation (Law 13).
    timeoutCrash.crashEverything('planning_gate', 'this body asked to enter the planning gate a second time', _planningState);
    return new Promise(() => {});
  }

  return new Promise((resolve) => {
    _pendingPlanning = {
      resolve, phase, requestId: ++_planningRequestId,
      answer: timeoutCrash.watch('planning_gate', 'the foreman has not answered this body\'s request to enter (neither granted nor queued)', _planningState),
    };
    _ws.send(JSON.stringify(createEnvelope('planning_request', _botId, { phase, requestId: _planningRequestId })));
    watcher.summary('foreman_link', `Asked to enter the planning gate for ${phase}.`);
  });
}

// The foreman's "queued" answer: the request was heard, so the watch on its answer closes.
function _onPlanningQueued(place) {
  if (_stoodDown) return;
  if (place.requestId < _planningRequestId) return;
  if (!Number.isSafeInteger(place.requestId) || place.requestId !== _pendingPlanning?.requestId) {
    throw new Error('foreman_link: queued requestId differs from the pending request');
  }
  if (!_pendingPlanning) {
    timeoutCrash.crashEverything('planning_gate', 'the foreman put this body in the planning line and it had not asked to enter', _planningState);
    return;
  }
  _pendingPlanning.answer.done();
  timeoutCrash.note('planning_gate', `in line: ${place.ahead} ahead, '${place.holder}' inside for ${place.held_ms} ms`);
  watcher.summary('foreman_link', `In line for the planning gate — ${place.ahead} ahead, ${place.holder} inside for ${place.held_ms} ms.`);
}

function _onPlanningGranted(payload) {
  // An entry issued while this body's stand-down was on its way: the foreman closes it on that message.
  if (_stoodDown) return;
  // A canceled request's grant can already be in flight; its number cannot grant the new chain ownership.
  if (payload.requestId < _planningRequestId) return;
  if (!_pendingPlanning || _planningEntry !== null) {
    timeoutCrash.crashEverything('planning_gate', `the foreman issued entry #${payload && payload.entry} to this body and it was not waiting for one`, _planningState);
    return;
  }
  const { resolve, answer, phase } = _pendingPlanning;
  if (payload.requestId !== _pendingPlanning.requestId) throw new Error('foreman_link: grant requestId differs from the pending request');
  if (payload.phase !== phase) throw new Error(`foreman_link: granted phase '${payload.phase}' differs from requested '${phase}'`);
  if (memoryWorkspace.enabled()) memoryWorkspace.enter(payload.workspace);
  answer.done();
  _pendingPlanning = null;
  _planningEntry = payload.entry;
  _planningPhase = phase;
  timeoutCrash.note('planning_gate', `entered on #${_planningEntry}`);
  watcher.summary('foreman_link', `Entered the planning gate on entry #${_planningEntry} — ${phase} workspace is ours.`);
  resolve();
}

function releasePlanningToken() {
  memoryWorkspace.leave();
  _planningPhase = null;
  if (!_foremanUrl || _stoodDown) return;
  // A closed socket means the foreman has already closed this body's entry itself
  // (foreman_brain.releaseForBot), so there is no exit left to send.
  if (!isConnected()) { _planningEntry = null; return; }
  if (_planningEntry === null) {
    timeoutCrash.crashEverything('planning_gate', 'this body reached the end of a plan phase with no entry in hand', _planningState);
    return;
  }
  const entry = _planningEntry;
  _planningEntry = null;
  timeoutCrash.note('planning_gate', `exited on #${entry}`);
  if (guardExternalSync('foreman_link', 'send planning_release', () => _ws.send(JSON.stringify(createEnvelope('planning_release', _botId, { entry })))).ok) {
    watcher.summary('foreman_link', `Left the planning gate, exit token #${entry}.`);
  }
}

// Planning and execution borrow the same exclusive gate; nested computations use their caller's grant.
async function withComputationWorkspace(work) {
  if (!memoryWorkspace.enabled() || _planningPhase !== null) return work();
  await acquirePlanningToken('workspace');
  const entry = _planningEntry;
  return require('@utils/external_library_guard').withCleanup('foreman_link', 'computation workspace', work, () => {
    if (_planningPhase === 'workspace' && _planningEntry === entry) releasePlanningToken();
  });
}

// A Law 15 handover abandons its promise, so release happens before control passes to combat or the judge.
function abandonComputationWorkspace() {
  if (_pendingPlanning) {
    const requestId = _pendingPlanning.requestId;
    _pendingPlanning.answer.done();
    _pendingPlanning = null;
    ++_planningRequestId;
    guardExternalSync('foreman_link', 'cancel queued computation workspace', () => _ws.send(JSON.stringify(createEnvelope('planning_cancel', _botId, { requestId }))));
  }
  if (_planningPhase !== null) releasePlanningToken();
}

// Publishes this bot's body cell (feet voxel) into its boardroom chair on a
// 1s tick; peers read it from the merged boardroom (Law 16).
function startBodyCellPublisher(bot) {
  if (_bodyCellTimer) return;
  let lastCellKey = null;
  _bodyCellTimer = timeoutCrash.every('foreman_link', 'publish the cell this body stands in to its boardroom chair when it changes', () => {
    const pos = bot?.entity?.position;
    if (!pos) return;
    const cell = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const cellKey = `${cell.x},${cell.y},${cell.z}`;
    if (cellKey === lastCellKey) return;
    lastCellKey = cellKey;

    const hqModule = require('@kernel/corporate_headquarters');
    const botId = _botId || process.env.BOT_ID || 'default';
    const chair = hqModule.readBoardroomChair(botId, {}) || {};
    chair.body_cell = { ...cell, updated_at: Date.now() };
    hqModule.writeBoardroomChair(botId, chair);
    sendUpdate();
  }, BODY_CELL_INTERVAL_MS);
  if (_bodyCellTimer.unref) _bodyCellTimer.unref();
}

// Fresh peer body cells (other bots only) — a perception-style read of merged
// chair state. Stale cells are excluded (see BODY_CELL_FRESH_MS).
function getPeerBodyCells() {
  const hqModule = require('@kernel/corporate_headquarters');
  const botId = _botId || process.env.BOT_ID || 'default';
  const boardroom = hqModule.getFullBoardroom({});
  const out = [];
  for (const [id, chair] of Object.entries(boardroom)) {
    if (id === botId) continue;
    const c = chair?.body_cell;
    if (!c || typeof c.x !== 'number' || typeof c.y !== 'number' || typeof c.z !== 'number') continue;
    if (Date.now() - (c.updated_at || 0) > BODY_CELL_FRESH_MS) continue;
    out.push({ botId: id, x: c.x, y: c.y, z: c.z });
  }
  return out;
}

// Startup-only situational report: where this bot spawned and (if any peer
// is connected) how far the nearest one is.
// Called once after a delay so peer chairs have arrived; reuses the peer
// body cells the navigator avoids (Law 16). Logged only (Thinking_fragments/dispatcher.js).
function recordStartupPosition(bot) {
  const pos = bot?.entity?.position;
  if (!pos) return;
  const here = `(${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`;

  const peers = getPeerBodyCells();
  let where;
  if (peers.length === 0) {
    where = `Online at ${here}. No other bots connected.`;
  } else {
    let nearest = null;
    let best = Infinity;
    for (const p of peers) {
      const d = Math.sqrt((p.x - pos.x) ** 2 + (p.y - pos.y) ** 2 + (p.z - pos.z) ** 2);
      if (d < best) { best = d; nearest = p; }
    }
    where = `Online at ${here}. Nearest bot '${nearest.botId}' is ${best.toFixed(1)} blocks away at (${nearest.x}, ${nearest.y}, ${nearest.z}).`;
  }
  watcher.summary('foreman_link', where);
}

// Forwards one already-formatted watcher line to the foreman's combined
// console. Must stay silent (no watcher calls, no throws) since the watcher
// calls this function. No-op with no foreman. Left unguarded: isConnected()
// already proves readyState OPEN, the only thing ws.send refuses on (Law 26).
// `level` is the watcher's channel word ('summary'|'warn'|'error'|'context'),
// carried beside the text so the foreman can count faults without parsing it.
function forwardLog(line, level) {
  if (!isConnected() || typeof line !== 'string') return;
  _ws.send(JSON.stringify(createEnvelope('log', _botId, { line, level: level || null })));
}

// Sends a batch of this body's item-book entries (js_kernel/item_book.js). Returns whether it left, so
// the clerk keeps a batch the socket could not take.
function sendItemBook(entries) {
  if (!isConnected()) return false;
  _ws.send(JSON.stringify(createEnvelope('item_book', _botId, { entries })));
  return true;
}

// Tells the foreman this bot is done with a key. Fire-and-forget.
function releaseClaim(key) {
  _dropClaimFromChair(key);
  if (!isConnected()) return;

  const envelope = createEnvelope('claim_release', _botId, { key });
  _ws.send(JSON.stringify(envelope));
  // routine bookkeeping — not logged (see requestClaim); only denials are worth a line.
}

// Releases every object claim this bot holds (read from its own chair
// mirror). Used when a task ends abruptly and the executor's own end-of-run
// releaseClaim never runs, so a cleared magnet always means no claim
// survives (Law 4 / Invariant D). Reuses releaseClaim per key (Law 16).
// Returns the count released.
function releaseAllClaims() {
  const hqModule = require('@kernel/corporate_headquarters');
  const botId = _botId || process.env.BOT_ID || 'default';
  const chair = hqModule.readBoardroomChair(botId, {}) || {};
  const keys = chair.active_claims ? Object.keys(chair.active_claims) : [];
  for (const key of keys) releaseClaim(key);
  return keys.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Connection management
// ─────────────────────────────────────────────────────────────────────────────

function connect(foremanUrl, botId) {
  _foremanUrl = foremanUrl;
  _registerCrashRoad();
  // The chair is kept between runs and whether the body is dead is a reading of this run: the kept
  // answer is dropped here, so the foreman hears nothing until this run's first sweep states it.
  const kept = require('@kernel/corporate_headquarters').readBoardroomChair(botId, null);
  if (kept && ('dead' in kept || 'dead_at' in kept)) {
    delete kept.dead;
    delete kept.dead_at;
    require('@kernel/corporate_headquarters').writeBoardroomChair(botId, kept);
  }
  _botId = botId;

  if (!_foremanUrl) {
    watcher.summary('foreman_link', 'No foreman URL configured — running in local-brain mode.');
    return;
  }

  watcher.summary('foreman_link', `Connecting to foreman at ${_foremanUrl} as '${_botId}'...`);
  _attemptConnect();
}

function _attemptConnect() {
  if (!_foremanUrl) return;

  const opened = guardExternalSync('foreman_link', `new WebSocket(${_foremanUrl})`, () => new WebSocket(_foremanUrl));
  if (!opened.ok) { _scheduleReconnect(); return; }
  _ws = opened.value;

  _ws.on('open', () => {
    _connected = true;
    watcher.summary('foreman_link', `Connected to foreman at ${_foremanUrl}.`);

    // Send registration with current boardroom chair
    const hqModule = require('@kernel/corporate_headquarters');
    const chair = hqModule.readBoardroomChair(_botId);
    const stations = hqModule.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    const buildings = hqModule.readOffice('building_confrence_room') || {};

    // The mandate travels on registration because it is an environment fact
    // of this process alone — the foreman cannot observe it, only read it
    // stated here (Law 23).
    const envelope = createEnvelope('register', _botId, {
      boardroom_chair: chair || {},
      logistics_stations: stations,
      building_conference: buildings,
      mode: require('@kernel/bot_mandate').currentMode(),
      // Owner travels beside mode: the foreman routes a human's command on
      // both and can read neither elsewhere. Null means homesteader.
      owner: require('@kernel/bot_mandate').currentOwner(),
    });
    _ws.send(JSON.stringify(envelope));
  });

  _ws.on('message', (raw) => {
    const parsed = parseEnvelope(raw.toString());
    if (!parsed.ok) {
      watcher.warn('foreman_link', `Bad message from foreman, discarded: ${parsed.reason}`);
      return;
    }
    _handleMessage(parsed.msg);
  });

  // ── LOSING THE FOREMAN ENDS THIS BODY ──────────────────────────────────────
  // This socket closing means the foreman PROCESS is gone (its in-world body
  // loss is handled separately, by foreman.js). A fleet with no arbiter must
  // not keep working unarbitrated, so this body stops; restart comes from
  // start_auren.js, which raises a fresh crew.
  _ws.on('close', () => {
    const wasConnected = _connected;
    _connected = false;
    _ws = null;
    if (_pendingPlanning) _pendingPlanning.answer.done();
    _planningEntry = null;

    _planningPhase = null;
    memoryWorkspace.leave();

    // A claim in flight when the socket dies is refused, with a reason: no
    // answer is invented for one nobody issued.
    if (_pendingClaim) {
      _pendingClaim.answer.done();
      const resolve = _pendingClaim.resolve;
      _pendingClaim = null;
      resolve({ granted: false, reason: 'the foreman went away while this claim was in flight — nothing was granted' });
    }
    // The parked planner is deliberately left parked: the process is ending, and resolving it would
    // start one more plan cycle on a fleet with no arbiter (Law 4).
    _pendingPlanning = null;

    if (wasConnected) {
      watcher.error('foreman_link',
        '⛔ The foreman is GONE — the socket to the fleet\'s arbiter closed. No body may hold a claim or the '
        + 'planning token without it, so this body is stopping rather than working unarbitrated. '
        + 'The whole fleet ends with the foreman; restart through start_auren.js.');

      // ── AND ONE OF US STAYS UP TO SAY SO ───────────────────────────────────
      // The foreman cannot report its own death, so one body claims witness
      // atomically (every body arrives here at once); the rest fall through
      // and end as normal. BOT_ID (stamped by crew_launch) names the window
      // the report must land in.
      const whoAmI = _botId || process.env.BOT_ID || 'default';
      const foremanGone = require('@utils/foreman_gone');
      if (foremanGone.standAsWitness(whoAmI)) {
        foremanGone.announce(whoAmI);
        require('@utils/body_end').flushRecord('the foreman is gone — this body stayed up to report it');
        foremanGone.hold();
        return;
      }

      require('@utils/body_end').endBody('the foreman is gone', { code: 1 });
      return;
    }

    _scheduleReconnect();
  });

  _ws.on('error', (err) => {
    watcher.warn('foreman_link', `WebSocket error: ${err.message}`);
  });
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (!_connected && _foremanUrl) {
      watcher.summary('foreman_link', 'Attempting reconnect to foreman...');
      _attemptConnect();
    }
  }, RECONNECT_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Incoming message handler
// ─────────────────────────────────────────────────────────────────────────────

function _handleMessage(msg) {
  switch (msg.type) {
    case 'registered':
      if (msg.payload.success) {
        watcher.summary('foreman_link', 'Registration confirmed by foreman.');
      } else {
        watcher.warn('foreman_link', `Registration rejected: ${msg.payload.reason}`);
        _connected = false;
      }
      break;

    case 'hq_broadcast': {
      const hqModule = require('@kernel/corporate_headquarters');
      // Any magnet held by a bot absent from the foreman's roster is void, taking
      // its chest_locks with it. Runs before the merge, so a genuinely
      // connected peer's fresh chair (restored below) is never robbed of a
      // live magnet. An ordinary line: a body's magnet is kept across a stop so a continue start has
      // it, and a body that leaves a run without being sent home ends that run with its own error.
      const roster = msg.payload.connected_bots;
      if (Array.isArray(roster)) {
        const freed = hqModule.releaseAbsentBotMagnets(roster, _botId);
        if (freed.length) {
          watcher.summary('foreman_link',
            `Released magnet(s) held by bot(s) not in the world: ${freed.join(', ')} — chest locks and job claims freed.`);
        }
      }
      const chairs = msg.payload.bot_boardroom;
      if (chairs && typeof chairs === 'object') {
        hqModule.mergeBroadcastChairs(chairs);
      }
      // Merges the foreman's relayed station map (LWW per voxel by updated_at).
      // No log — this fires every broadcast heartbeat (Law 5); the merged map
      // is inspectable in HQ (Law 6).
      const stations = msg.payload.logistics_stations;
      if (stations && typeof stations === 'object') {
        hqModule.mergeBroadcastStations(stations);
      }
      // Fleet structures: adopt established buildspots (first-writer-wins) so this
      // bot's planner sees the fleet's ONE home, never a duplicate.
      const buildings = msg.payload.building_conference;
      if (buildings && typeof buildings === 'object') {
        hqModule.mergeBroadcastBuildings(buildings);
      }
      // Standing requests (what each human asked for) are adopted whole, not
      // merged — the foreman is their sole author (Invariant D). A crew
      // narrows the map to its own rows when it reads.
      const requests = msg.payload.standing_requests;
      if (requests && typeof requests === 'object') {
        require('@kernel/request_ledger').mergeBroadcast(requests);
      }
      // `death_piles`, if an older peer still sends it, is ignored (see the
      // hq_delta builder above).
      _markFirstBroadcast();
      break;
    }

    case 'claim_granted':
      // routine bookkeeping — not logged (see requestClaim); only denials are worth a line.
      if (_pendingClaim) {
        _pendingClaim.answer.done();
        _recordClaimInChair(_pendingClaim.key);
        _pendingClaim.resolve({ granted: true });
        _pendingClaim = null;
      }
      break;

    case 'claim_rejected':
      watcher.summary('foreman_link', `Claim rejected for '${msg.payload.key}': ${msg.payload.reason}.`);
      if (_pendingClaim) {
        _pendingClaim.answer.done();
        // Two kinds of refusal arrive on one message: a peer holding the
        // object (ordinary — caller tries the next candidate) and
        // `fault: 'claimant'` (the arbiter could not read the key at all,
        // no retry can fix it) — rejected here, at the one door (Law 13/16).
        if (msg.payload.fault === 'claimant') {
          const { key, reason } = msg.payload;
          const pending = _pendingClaim;
          _pendingClaim = null;
          // Rejects the caller's promise; throwing out of the socket handler
          // would leave the executor hanging (Law 8).
          pending.reject(new Error(`foreman_link: CODING VIOLATION (Law 13) — the foreman could not read `
            + `claim key '${key}': ${reason}. A claim key's namespace must be listed in foreman_brain's `
            + `OBJECT_KEY_PREFIXES; until it is, that object can never be claimed by anyone.`));
          break;
        }
        _pendingClaim.resolve({ granted: false, reason: msg.payload.reason });
        _pendingClaim = null;
      }
      break;

    case 'planning_granted':
      _onPlanningGranted(msg.payload);
      break;

    case 'planning_queued':
      _onPlanningQueued(msg.payload);
      break;

    case 'command': {
      // Operator verb relayed by the foreman. Executes through the same
      // operator_commands pathway the local console uses (Law 16).
      const verb = msg.payload.verb;
      // Forwarded unchanged from the operator; the verb's own case validates it (Law 3: this is
      // transport, it does not inspect the cargo).
      const args = msg.payload.args || {};
      // Origin (where the command entered the fleet) passes through
      // untouched, never defaulted — only the foreman can state it truthfully (Law 23).
      const origin = msg.payload.origin;
      const operatorCommands = require('@kernel/operator_commands');
      if (!operatorCommands.VERBS.has(verb)) {
        watcher.warn('foreman_link', `Ignoring command with unknown verb '${verb}'.`);
        break;
      }
      watcher.summary('foreman_link', `Executing foreman command '${verb}' (origin: ${origin}).`);
      operatorCommands.execute(verb, args, origin).catch((e) => {
        watcher.error('foreman_link', `Command '${verb}' failed: ${e && e.stack ? e.stack : String(e)}`);
      });
      break;
    }

    default:
      watcher.warn('foreman_link', `Unhandled message type '${msg.type}' from foreman.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Cleanup
// ─────────────────────────────────────────────────────────────────────────────

function disconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_bodyCellTimer) {
    timeoutCrash.stop(_bodyCellTimer);
    _bodyCellTimer = null;
  }
  if (_pendingPlanning) _pendingPlanning.answer.done();
  if (_ws) {
    _ws.close();
    _ws = null;
  }
  _connected = false;
}

// ── THE FIRST BROADCAST IS WHERE A BODY LEARNS ITS BASE ────────────────────────
// The foreman writes every site into memory before spawning a body and
// broadcasts it on registration. Before the first broadcast, an empty
// building room means "not heard yet", not "no base".
let _firstBroadcastSeen = false;
const _firstBroadcastWaiters = [];
function _markFirstBroadcast() {
  if (_firstBroadcastSeen) return;
  _firstBroadcastSeen = true;
  for (const w of _firstBroadcastWaiters.splice(0)) w(true);
}
// awaitFirstBroadcast(timeoutMs) → Promise<boolean>: true once the foreman's memory has arrived, false when
// the wait ran out. Resolves at once when it already has.
function awaitFirstBroadcast(timeoutMs) {
  if (_firstBroadcastSeen) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter = (v) => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => {
      const i = _firstBroadcastWaiters.indexOf(waiter);
      if (i >= 0) _firstBroadcastWaiters.splice(i, 1);
      resolve(false);
    }, timeoutMs);
    if (t.unref) t.unref();
    _firstBroadcastWaiters.push(waiter);
  });
}

module.exports = {
  connect,
  awaitFirstBroadcast,
  disconnect,
  isConnected,
  getBotId,
  sendUpdate,
  requestClaim,
  releaseClaim,
  releaseAllClaims,
  closeClaimedArea,
  getPeerClosedAreas,
  peerClaimKeys,
  peerAreaAt,
  acquirePlanningToken,
  standDown,
  releasePlanningToken,
  withComputationWorkspace,
  abandonComputationWorkspace,
  startBodyCellPublisher,
  getPeerBodyCells,
  recordStartupPosition,
  forwardLog,
  sendItemBook,
};
