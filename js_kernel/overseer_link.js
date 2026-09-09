// js_kernel/overseer_link.js
// Bot-side WebSocket client for overseer communication.
//
// Four capabilities (de-confliction taxonomy lives in overseer_brain.js):
//   1. sendUpdate() — sends this bot's boardroom chair + shared logistics/
//      structure state to the overseer for broadcast. Callable from anywhere
//      (Law 15 API).
//   2. requestClaim(key) / releaseClaim(key) — arbiter flavor (a): exclusive
//      hold on a world object ('anchor:…', 'tree:…', 'cell:…' — lock the
//      object, not the bot). Resolves { granted, reason? }; can be rejected.
//   3. acquirePlanningToken() / releasePlanningToken() — arbiter flavor (b):
//      the plan-phase mutex. Never rejected; a loser parks until promoted.
//   4. forwardLog(line) — mirrors this bot's watcher stream to the overseer's
//      combined console (display only).
//
// Every granted claim is mirrored into this bot's boardroom chair
// (active_claims) so peers — and the Architect — can see what each bot has
// locked (Law 6: what a bot is working on is inspectable state, not hidden
// arbiter internals).
//
// When no overseer is configured or the connection drops, the bot falls back
// to local-only mode: requestClaim always grants, sendUpdate is a no-op.
//
// Law 16: one pathway. Connected = overseer arbitrates. Disconnected = local.

'use strict';

const WebSocket = require('ws');
const watcher = require('@kernel/watcher');
const { createEnvelope, parseEnvelope } = require('@overseer/message_schema');
const { guardExternalSync } = require('@utils/external_library_guard');

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — State
// ─────────────────────────────────────────────────────────────────────────────

let _ws = null;
let _botId = null;
let _overseerUrl = null;
let _connected = false;
let _reconnectTimer = null;

let _pendingClaim = null;
let _bodyCellTimer = null;

// Planning token (plan-phase mutex — arbiter flavor b, see overseer_brain.js
// taxonomy). Distinct from _pendingClaim: an object claim can be REJECTED and
// resolves fast; a planning acquire is never rejected — the bot parks until
// 'planning_granted' arrives, so there is no timeout on the wait.
let _pendingPlanning = null;       // resolver parked until planning_granted
let _planningRenewTimer = null;    // heartbeat while holding the token

const RECONNECT_INTERVAL_MS = 5000;
const CLAIM_TIMEOUT_MS = 10000;
// Renew at 4x the overseer's 2s TTL rate so a plan phase that yields the event
// loop (the 100ms signal-bus hop) keeps its token even if a sweep runs long.
// Capped: if release never comes (leaked chain), renewal stops and the TTL
// frees the fleet rather than deadlocking it (Law 13: default = available).
const PLANNING_RENEW_INTERVAL_MS = 500;
const PLANNING_RENEW_MAX = 20;

// Body-cell publishing (Phase 4 movement de-confliction): each bot exposes ONLY
// its body cell — peers avoid it in A* and yield at doorways. 1s cadence, but a
// write/broadcast happens only when the cell CHANGES, so a parked bot is silent.
const BODY_CELL_INTERVAL_MS = 1000;
// A cell older than this is a ghost (crashed/stalled peer) — ignore it rather
// than route around a bot that is no longer there (Law 13: default = free).
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

// Sends this bot's boardroom chair, its logistics station map, and its fleet structure
// entries to the overseer for broadcast. The chair carries the magnet + chest locks; the
// stations carry the shared registry (chests/furnaces + in-flight furnace orders); the
// building conference carries established buildspots so the fleet converges on ONE home
// (a peer adopts it instead of finding its own). All pushed together on every update so
// peers converge on one view (Law 6 transparency across processes).
function sendUpdate() {
  if (!isConnected()) return;

  const hqModule = require('@kernel/corporate_headquarters');
  const chair = hqModule.readBoardroomChair(_botId);
  if (!chair) return;

  const stations = hqModule.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
  const buildings = hqModule.readOffice('building_confrence_room') || {};
  // NO DEATH PILES ON THIS ENVELOPE any more (2026-08-12). The ledger they came from is deleted: salvage
  // is a live scan of each bot's own entity table now, and an entity table is not shareable state — a peer
  // relaying "there is an item at (x,y,z)" would be relaying a claim its recipient cannot verify and that
  // may already be false (Law 23). Every bot sees its own yard; that is the whole distribution.
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

// Asks the overseer to grant a claim key (category or object). Returns
// Promise<{ granted, reason? }>. In single-bot mode (no overseer), always
// grants immediately — claims only arbitrate between bots, and there is one.
function requestClaim(key) {
  if (!isConnected()) {
    _recordClaimInChair(key);
    return Promise.resolve({ granted: true });
  }

  if (_pendingClaim) {
    return Promise.reject(new Error('overseer_link: another claim is already pending'));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      _pendingClaim = null;
      reject(new Error('overseer_link: claim response timed out'));
    }, CLAIM_TIMEOUT_MS);

    _pendingClaim = { key, resolve, reject, timeout };   // reject is kept: a claimant-side key fault is a throw, not an answer (see 'claim_rejected')

    const envelope = createEnvelope('claim_request', _botId, { key });
    _ws.send(JSON.stringify(envelope));
    // No log on request/grant/release: the tree-reachability sweep claims-then-releases every
    // candidate to test peer-ownership, so routine bookkeeping floods the story (Law 5 noise).
    // Only a DENIAL (claim_rejected) carries diagnostic weight — that one still logs.
  });
}

// ── Planning token (plan-phase mutex) ────────────────────────────────────────
// acquirePlanningToken() resolves ONLY when this bot holds the token — a loser
// parks in the overseer's FIFO and resolves later, on promotion. Local mode
// (no overseer) grants instantly: a lone bot cannot race anyone. While held,
// a renewal heartbeat keeps the overseer's short crash-TTL from freeing a
// slow-but-alive planner. This is NOT requestClaim (object exclusivity) and
// NOT the magnet (task identity) — see the taxonomy in overseer_brain.js.

function _startPlanningRenewal() {
  _stopPlanningRenewal();
  let renewals = 0;
  _planningRenewTimer = setInterval(() => {
    if (++renewals > PLANNING_RENEW_MAX || !isConnected()) {
      _stopPlanningRenewal();   // stop feeding a leaked hold — let the TTL free it
      return;
    }
    // The heartbeat only refreshes a hold the overseer's TTL will free anyway, so a send that does not
    // land costs one interval, not correctness.
    guardExternalSync('overseer_link', 'send planning_request renewal', () => _ws.send(JSON.stringify(createEnvelope('planning_request', _botId, {}))));
  }, PLANNING_RENEW_INTERVAL_MS);
  if (_planningRenewTimer.unref) _planningRenewTimer.unref();
}

function _stopPlanningRenewal() {
  if (_planningRenewTimer) {
    clearInterval(_planningRenewTimer);
    _planningRenewTimer = null;
  }
}

function acquirePlanningToken() {
  if (!isConnected()) {
    return Promise.resolve();
  }

  if (_pendingPlanning) {
    // Law 4 makes two concurrent plan phases impossible in a correct system —
    // a second acquire is a coding violation, not a wait-your-turn (Law 13).
    return Promise.reject(new Error('overseer_link: planning token acquire already pending'));
  }

  return new Promise((resolve) => {
    _pendingPlanning = { resolve };
    _ws.send(JSON.stringify(createEnvelope('planning_request', _botId, {})));
    watcher.summary('overseer_link', 'Requested planning token.');
  });
}

function releasePlanningToken() {
  _stopPlanningRenewal();
  if (!isConnected()) return;
  // A release that does not land is freed by the overseer's TTL instead — later, but never lost.
  if (guardExternalSync('overseer_link', 'send planning_release', () => _ws.send(JSON.stringify(createEnvelope('planning_release', _botId, {})))).ok) {
    watcher.summary('overseer_link', 'Released planning token.');
  }
}

// Publish this bot's body cell (feet voxel) into its boardroom chair on a 1s
// tick. The chair broadcast is the ONLY sync channel — peers read the cell from
// their merged boardroom like any other chair state (Law 16: no second route).
function startBodyCellPublisher(bot) {
  if (_bodyCellTimer) return;
  let lastCellKey = null;
  _bodyCellTimer = setInterval(() => {
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

// Startup-only situational report: where this bot spawned, its pocket inventory, and (if any other bot
// is connected) how far the nearest one is. Called once, after a short delay so peer chairs have arrived
// over the overseer (a peer publishes its body cell within ~1s of its own spawn). Reuses the same peer
// body cells the navigator avoids — no separate position channel (Law 16).
//
// IT GOES TO THE LOG AND NOWHERE ELSE (2026-09-06, and the name changed with it — it used to be
// `announceStartupPosition` and it used to put both halves in open chat). Its reader is whoever opens
// the trace after a run, and that reader had it either way: `watcher.summary` is the record. The chat
// copy was aimed at nobody — a player who has just been handed a crew does not need its inventory
// itemised, and two bodies × two lines is four messages over four seconds in a window drawn on top of
// the world. See THE BOT DOES NOT SPEAK in Thinking_fragments/dispatcher.js for the ruling.
function recordStartupPosition(bot) {
  const pos = bot?.entity?.position;
  if (!pos) return;
  const here = `(${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`;

  // Pocket inventory snapshot at spawn, richest stack first.
  const counts = {};
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] || 0) + item.count;
  const invList = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}:${count}`)
    .join(', ') || 'empty';

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
  const inv = `Startup inventory: ${invList}.`;

  watcher.summary('overseer_link', `${where} ${inv}`);
}

// Forward one already-formatted watcher line to the overseer so it can show both bots' streams in
// one place. Must stay SILENT — no watcher calls, no throws — or a log would recurse into itself.
// No-op when there's no overseer (single-bot mode just logs to its own console as before).
// UNGUARDED, AND IT IS THE ONE SEND IN THIS FILE THAT MAY NOT BE. The guard reports by calling the
// watcher, and this function is called BY the watcher — routing it through the guard would make a
// failed log line emit a log line, on the socket that just failed. That is the same recursion the
// watcher's own boundary is exempted for, one hop out. The precondition takes the guard's place:
// isConnected() proves readyState === OPEN, which is the only thing ws.send refuses on, so a throw
// escaping here is a defect and not a dropped packet (Law 26 — the interface must not report through
// the channel it is reporting about).
function forwardLog(line) {
  if (!isConnected() || typeof line !== 'string') return;
  _ws.send(JSON.stringify(createEnvelope('log', _botId, { line })));
}

// Tells the overseer this bot is done with a key. Fire-and-forget.
function releaseClaim(key) {
  _dropClaimFromChair(key);
  if (!isConnected()) return;

  const envelope = createEnvelope('claim_release', _botId, { key });
  _ws.send(JSON.stringify(envelope));
  // routine bookkeeping — not logged (see requestClaim); only denials are worth a line.
}

// Release EVERY object claim this bot currently holds (read from its own chair mirror).
// Used when a task ends abruptly — a killed signal abandons the executor's promise mid-await
// (Law 15), so the executor's own end-of-run releaseClaim never runs and its anchor claim leaks
// for the full STALE_CLAIM_MS TTL (5 min) — long enough to starve a peer into an infinite-loop
// kill (the cascade that killed TessaBot). A cleared magnet means no active task, hence no claim
// should survive; releasing here returns the task to exactly one LIVE owner (Law 4 / Invariant D).
// Reuses releaseClaim per key — no new arbitration path (Law 16). Returns the count released.
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

function connect(overseerUrl, botId) {
  _overseerUrl = overseerUrl;
  _botId = botId;

  if (!_overseerUrl) {
    watcher.summary('overseer_link', 'No overseer URL configured — running in local-brain mode.');
    return;
  }

  watcher.summary('overseer_link', `Connecting to overseer at ${_overseerUrl} as '${_botId}'...`);
  _attemptConnect();
}

function _attemptConnect() {
  if (!_overseerUrl) return;

  const opened = guardExternalSync('overseer_link', `new WebSocket(${_overseerUrl})`, () => new WebSocket(_overseerUrl));
  if (!opened.ok) { _scheduleReconnect(); return; }
  _ws = opened.value;

  _ws.on('open', () => {
    _connected = true;
    watcher.summary('overseer_link', `Connected to overseer at ${_overseerUrl}.`);

    // Send registration with current boardroom chair
    const hqModule = require('@kernel/corporate_headquarters');
    const chair = hqModule.readBoardroomChair(_botId);
    const stations = hqModule.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    const buildings = hqModule.readOffice('building_confrence_room') || {};

    // THE SPECIES TRAVELS ON REGISTRATION because the overseer routes on it and cannot read it any
    // other way — a mandate is an environment fact of THIS process and nothing outside it can see one.
    // It is the bot's own answer about itself, which is the only kind of claim about a species that
    // can be made: the overseer is the party that OBSERVES where a command entered the fleet (which
    // door it arrived at), and the bot is the party that KNOWS what it is. Neither can supply the
    // other's half, so both are stated at the one moment they meet.
    const envelope = createEnvelope('register', _botId, {
      boardroom_chair: chair || {},
      logistics_stations: stations,
      building_conference: buildings,
      mode: require('@kernel/bot_mandate').currentMode(),
      // WHOSE it is, travelling beside WHAT it is, because the overseer routes a human's command on
      // both and can read neither any other way. Null for a homesteader is the answer, not an omission.
      owner: require('@kernel/bot_mandate').currentOwner(),
    });
    _ws.send(JSON.stringify(envelope));
  });

  _ws.on('message', (raw) => {
    const parsed = parseEnvelope(raw.toString());
    if (!parsed.ok) {
      watcher.warn('overseer_link', `Bad message from overseer, discarded: ${parsed.reason}`);
      return;
    }
    _handleMessage(parsed.msg);
  });

  _ws.on('close', () => {
    const wasConnected = _connected;
    _connected = false;
    _ws = null;

    if (wasConnected) {
      watcher.warn('overseer_link', 'Disconnected from overseer — falling back to local brain.');
    }

    if (_pendingClaim) {
      clearTimeout(_pendingClaim.timeout);
      _recordClaimInChair(_pendingClaim.key);
      _pendingClaim.resolve({ granted: true });
      _pendingClaim = null;
    }

    // A planner waiting in the overseer's queue must not hang on a dead socket —
    // disconnected = local mode = a lone bot, which always plans freely.
    _stopPlanningRenewal();
    if (_pendingPlanning) {
      const resolve = _pendingPlanning.resolve;
      _pendingPlanning = null;
      resolve();
    }

    _scheduleReconnect();
  });

  _ws.on('error', (err) => {
    watcher.warn('overseer_link', `WebSocket error: ${err.message}`);
  });
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (!_connected && _overseerUrl) {
      watcher.summary('overseer_link', 'Attempting reconnect to overseer...');
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
        watcher.summary('overseer_link', 'Registration confirmed by overseer.');
      } else {
        watcher.warn('overseer_link', `Registration rejected: ${msg.payload.reason}`);
        _connected = false;
      }
      break;

    case 'hq_broadcast': {
      const hqModule = require('@kernel/corporate_headquarters');
      // GHOST HOLDS FIRST. Any magnet on this bot's disk belonging to a bot the overseer does not
      // currently see is void — and with the magnet goes every chest_lock inside it, which is the
      // real damage (locked means wait-to-act, so a dead bot's locks stall live work forever).
      // Runs BEFORE the merge on purpose: a peer that is genuinely connected has its fresh chair in
      // this very payload and is restored a line later, so a reconnect can never be robbed of a
      // live magnet — the release only ever wins for a bot that is actually absent.
      // Warn-level and named: this is a ghost being cleaned up after an unclean shutdown, which the
      // operator should see (Law 5 — it is a degraded condition, not routine bookkeeping).
      const roster = msg.payload.connected_bots;
      if (Array.isArray(roster)) {
        const freed = hqModule.releaseAbsentBotMagnets(roster, _botId);
        if (freed.length) {
          watcher.warn('overseer_link',
            `Released stale magnet(s) held by disconnected bot(s): ${freed.join(', ')} — chest locks and job claims freed. `
            + `A magnet outliving its bot means that bot did not shut down cleanly (a killed window, not a 'down').`);
        }
      }
      const chairs = msg.payload.bot_boardroom;
      if (chairs && typeof chairs === 'object') {
        hqModule.mergeBroadcastChairs(chairs);
      }
      // Phase 6: merge the overseer's relayed station map (LWW per voxel by updated_at).
      // No log: this fires on every broadcast heartbeat, so a summary here is per-step
      // noise (Law 5), not a phase of work. The merged map is inspectable in HQ (Law 6).
      const stations = msg.payload.logistics_stations;
      if (stations && typeof stations === 'object') {
        hqModule.mergeBroadcastStations(stations);
      }
      // Fleet structures: adopt established buildspots (first-writer-wins) so this
      // bot's planner sees the fleet's ONE home instead of finding a duplicate.
      const buildings = msg.payload.building_conference;
      if (buildings && typeof buildings === 'object') {
        hqModule.mergeBroadcastBuildings(buildings);
      }
      // Standing requests: what each human has asked for. ADOPTED WHOLE rather than merged, because the
      // overseer is their sole author — a bot contributes nothing here and reconciling would invent a
      // second writer (Invariant D). A crew narrows the map to its own rows when it reads.
      const requests = msg.payload.standing_requests;
      if (requests && typeof requests === 'object') {
        require('@kernel/request_ledger').mergeBroadcast(requests);
      }
      // `death_piles` used to be merged here and is now IGNORED if an older peer still sends it — see the
      // hq_delta builder above for why the ledger was deleted rather than replaced with a shared scan.
      break;
    }

    case 'claim_granted':
      // routine bookkeeping — not logged (see requestClaim); only denials are worth a line.
      if (_pendingClaim) {
        clearTimeout(_pendingClaim.timeout);
        _recordClaimInChair(_pendingClaim.key);
        _pendingClaim.resolve({ granted: true });
        _pendingClaim = null;
      }
      break;

    case 'claim_rejected':
      watcher.summary('overseer_link', `Claim rejected for '${msg.payload.key}': ${msg.payload.reason}.`);
      if (_pendingClaim) {
        clearTimeout(_pendingClaim.timeout);
        // TWO KINDS OF REFUSAL ARRIVE ON ONE MESSAGE, and only one of them is an answer about the
        // world. A peer holding the object is an ordinary environmental outcome the caller handles by
        // trying the next candidate. `fault: 'claimant'` means the arbiter could not read the key at
        // all — an unlisted namespace or a malformed coordinate — which no retry and no world change
        // can resolve, and which the caller cannot tell apart from a busy object once it is folded
        // into a plain `granted: false` (Law 13: a coding violation throws; Law 25: "held by a peer"
        // is a false verdict when nobody holds anything). Rejected HERE rather than at each claimant
        // so every caller inherits it from the one door (Law 16). The cost of the old shape, measured:
        // an executor read every candidate as peer-held, conceded, was re-dispatched, and the loop's
        // judge halted the planner — with the actual cause visible only as a rejection line nobody
        // was reading.
        if (msg.payload.fault === 'claimant') {
          const { key, reason } = msg.payload;
          const pending = _pendingClaim;
          _pendingClaim = null;
          // REJECT THE CALLER'S PROMISE rather than throwing out of the socket handler. A throw here
          // would leave the awaiting executor holding a promise nothing will ever settle — a hang, and
          // the one outcome worse than the loop this replaces (Law 8: whoever raised the lifecycle ends
          // it). Rejected, it surfaces inside the executor's own await, where watcher.track and
          // master_core report it as the coding violation it is.
          pending.reject(new Error(`overseer_link: CODING VIOLATION (Law 13) — the overseer could not read `
            + `claim key '${key}': ${reason}. A claim key's namespace must be listed in overseer_brain's `
            + `OBJECT_KEY_PREFIXES; until it is, that object can never be claimed by anyone.`));
          break;
        }
        _pendingClaim.resolve({ granted: false, reason: msg.payload.reason });
        _pendingClaim = null;
      }
      break;

    case 'planning_granted':
      // No pending acquire = a late/duplicate grant (e.g. after a TTL round
      // trip) — ignore silently; the renewal heartbeat covers a live hold.
      if (_pendingPlanning) {
        watcher.summary('overseer_link', 'Planning token granted — plan phase is ours.');
        const resolve = _pendingPlanning.resolve;
        _pendingPlanning = null;
        _startPlanningRenewal();
        resolve();
      }
      break;

    case 'command': {
      // Operator verb relayed by the overseer. Executes through the same
      // operator_commands pathway the local console uses (Law 16).
      const verb = msg.payload.verb;
      // Forwarded unchanged from the operator; the verb's own case validates it (Law 3: this is
      // transport, it does not inspect the cargo).
      const args = msg.payload.args || {};
      // WHERE THE COMMAND ENTERED THE FLEET, carried from the overseer and NOT defaulted here.
      // The overseer is the only party that can know this truthfully — it stamps the origin from
      // WHICH SOCKET spoke, never from anything the sender claims about itself (Law 23) — so this
      // side passes the stamp through untouched and lets the mandate judge it. An `|| TERMINAL`
      // here would be this process inventing the one fact the isolation turns on, and it would
      // silently re-open the door the moment a stamp went missing upstream.
      const origin = msg.payload.origin;
      const operatorCommands = require('@kernel/operator_commands');
      if (!operatorCommands.VERBS.has(verb)) {
        watcher.warn('overseer_link', `Ignoring command with unknown verb '${verb}'.`);
        break;
      }
      watcher.summary('overseer_link', `Executing overseer command '${verb}' (origin: ${origin}).`);
      operatorCommands.execute(verb, args, origin).catch((e) => {
        watcher.error('overseer_link', `Command '${verb}' failed: ${e && e.stack ? e.stack : String(e)}`);
      });
      break;
    }

    default:
      watcher.warn('overseer_link', `Unhandled message type '${msg.type}' from overseer.`);
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
    clearInterval(_bodyCellTimer);
    _bodyCellTimer = null;
  }
  _stopPlanningRenewal();
  if (_ws) {
    _ws.close();
    _ws = null;
  }
  _connected = false;
}

module.exports = {
  connect,
  disconnect,
  isConnected,
  getBotId,
  sendUpdate,
  requestClaim,
  releaseClaim,
  releaseAllClaims,
  acquirePlanningToken,
  releasePlanningToken,
  startBodyCellPublisher,
  getPeerBodyCells,
  recordStartupPosition,
  forwardLog,
};
