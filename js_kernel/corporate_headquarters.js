// js_kernel/corporate_headquarters.js
// Memory-primary shared state for all action and thinking fragments (Law 6).
//
// All reads and writes go through an in-memory cache. A periodic flush writes
// the cache to disk as a human-inspectable snapshot — the file is an artifact,
// not live data. Consumers never read from disk after startup.
//
// Per-bot file path: when BOT_ID is set (multi-bot mode), each bot process
// gets its own file so two processes never collide on the same JSON.
//
// "Office" pattern: each fragment owns one top-level key (its office).
// "Conference room" pattern: shared space with named chairs per fragment.
// "Boardroom" pattern: bot_boardroom.<botId> — cross-bot state synced via overseer.

const fs = require('fs');
const path = require('path');
const { durableWrite } = require('./durable_write');
const { guardExternalSync, violation } = require('@utils/external_library_guard');

const _botId = process.env.BOT_ID || '';
// Per-bot file when BOT_ID is set: two bot processes on one host must never
// flush into the same JSON (2s debounce would silently stomp the other's state).
const HQ_PATH = path.join(
  __dirname,
  _botId ? `corporate_headquarters.${_botId}.json` : 'corporate_headquarters.json'
);

const EMPTY_HQ = { schema: 'auren.corporate_headquarters.v1' };
const FLUSH_INTERVAL_MS = 2000;

// ── A CONTRACTOR HAS NO MEMORY OF ITS OWN (Architect 2026-09-05, STANDING) ──────────────────────────
//
// *"contractor bots are stateless and dont have their own hq. they use their owners hq and that owner can
// wipe the memory. the only thing personal a bot can have is its own inventory posting."*
//
// So a contractor body keeps this cache in MEMORY — every fragment still reads and writes through it,
// unchanged — and never touches the disk at either end: it does not load a file at startup and it never
// flushes one. Its places arrive in the first `hq_broadcast` after it registers, out of the OWNER's file,
// which the overseer holds (`overseer/owner_memory.js`). The player owns that file; the bot is borrowed.
//
// WHY THE FILE HAD TO GO RATHER THAN BE CLEARED AT LAUNCH, which is what the previous round did. A file
// that is deleted on the way IN is still written throughout the tenancy and still sits on disk between
// tenancies, so it is a second durable copy of a player's places that nobody owns — and the moment the
// clear fails (a lock, a permission, a crash before launch) that copy is re-broadcast into the fleet and
// hands a previous occupant's rooms to a new person, silently undoing one of the Architect's hand
// deletions. One durable copy, owned by the person accountable for it (Law 16, Law 28). The launch-time
// delete is KEPT as a sweep for files written by earlier versions, not as the mechanism.
//
// HOMESTEADERS ARE UNCHANGED and must be: they are the Architect's own permanent fleet, they answer to
// nobody, and their memory is theirs. The asymmetry is the mandate itself.
//
// Required lazily. `bot_mandate` pulls in architect_config and message_schema, and this module is loaded
// by almost everything — a top-level require here is the shape a cycle comes from. Read once, because a
// mandate is fixed at birth and never changes (bot_mandate says so in those words).
let _ephemeral = null;
function _isEphemeral() {
  if (_ephemeral === null) {
    _ephemeral = guardExternalSync('corporate_headquarters', 'read this body\'s mandate',
      () => require('@kernel/bot_mandate').isContractor()).value === true;
  }
  return _ephemeral;
}

let _cache = null;
let _dirty = false;
let _flushTimer = null;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Cache management
// Load from disk once on first access. All subsequent reads/writes use memory.
// Periodic flush writes the cache to disk for human inspection (Law 6).
// ─────────────────────────────────────────────────────────────────────────────

// A FAILED LOAD IS A THROW, NEVER A COLD START (Law 13, Architect 2026-08-12).
//
// This used to swallow every read failure and return an empty HQ, and that single `catch (_) {}` is a
// second way to lose this file — one that needs no crash at all. The sequence: something makes the file
// unreadable for a moment (a lock, a sync client, a virus scanner, or the NUL-filled corpse a power cut
// leaves behind), the load quietly reports "no memory yet", the bot starts believing it has none, and
// two seconds later the flush timer writes that emptiness OVER the only copy. The build centre, the
// station map and every locked buildspot are gone, permanently, and nothing anywhere reported an error.
//
// So the two cases are separated, because only one of them is normal. ABSENT means a genuine first run —
// there is nothing to lose, so an empty HQ is the truth. PRESENT BUT UNREADABLE means the memory exists
// and cannot be reached, which is not a cold start; it is a stop. The bot refuses to run rather than run
// blind and overwrite what it could not read (default-stopped: prove it is safe to continue).
function _loadFromDisk() {
  // A BORROWED BODY STARTS BLANK, ALWAYS — and this is a stronger guarantee than deleting the file,
  // because it holds even if a stale file is sitting right there. See _isEphemeral above.
  if (_isEphemeral()) return { ...EMPTY_HQ };
  const read = guardExternalSync('corporate_headquarters', `read ${HQ_PATH}`, () => fs.readFileSync(HQ_PATH, 'utf-8'));
  if (!read.ok) {
    if (read.error.code === 'ENOENT') return { ...EMPTY_HQ };   // first run — nothing to lose
    throw violation('corporate_headquarters', `${HQ_PATH} exists but could not be READ (${read.error.code}: `
      + `${read.error.message}). Refusing to start with empty memory — a flush would overwrite it. `
      + `Resolve the file, then start again.`);
  }
  const raw = read.value;

  const read2 = guardExternalSync('corporate_headquarters', `parse ${HQ_PATH}`, () => JSON.parse(raw));
  if (!read2.ok) {
    throw violation('corporate_headquarters', `${HQ_PATH} is present but not parseable (${read2.reason}). `
      + `This is the fleet's persistent memory and it cannot be rebuilt from the world, so this is a `
      + `STOP, not a cold start. If the file is damaged beyond repair, DELETE it deliberately — an `
      + `absent file is a legitimate first run; an unreadable one is not.`);
  }
  const parsed = read2.value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw violation('corporate_headquarters', `${HQ_PATH} parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, `
      + `not an HQ object. Same rule as above: present-but-wrong is a stop, absent is a first run.`);
  }
  return parsed;
}

function _getCache() {
  if (!_cache) {
    _cache = _loadFromDisk();
    _logColdStart();
  }
  return _cache;
}

function _logColdStart() {
  // Lazily required, not guarded: the watcher pulls in nothing from this file, so there is no cycle for
  // a catch to absorb — and a require that genuinely fails is a broken kernel, not a reason to boot
  // silently with no record of what memory the fleet just loaded.
  const _w = require('@kernel/watcher');

  const keys = Object.keys(_cache).filter(k => k !== 'schema' && k !== 'updated_at');
  _w.summary('corporate_headquarters', `Loaded HQ into memory from ${HQ_PATH} — ${keys.length} sections: [${keys.join(', ')}]`);

  // EVERY LOCKED CENTRE, NOT 'headframe'. The room's keys carry an owner (`headframe|Architect`), so the
  // literal lookup that stood here matched nothing after the owner axis landed and the line silently
  // stopped printing — the failure mode of a hardcoded key, reported here rather than left to be noticed.
  // Loading is also exactly when a reader wants to see how many bases this file remembers.
  const rooms = _cache?.building_confrence_room || {};
  for (const [key, entry] of Object.entries(rooms)) {
    const bc = entry?.set_buildspot?.build_center;
    if (bc && typeof bc.x === 'number') {
      _w.summary('corporate_headquarters', `Build center ${key}: (${bc.x}, ${bc.y}, ${bc.z})`);
    }
  }

  const shaft = _cache?.mining_confrence_room?.shaft_center;
  if (shaft) {
    _w.summary('corporate_headquarters', `Shaft center: (${shaft.x}, ${shaft.y}, ${shaft.z})`);
  }

  const stations = _cache?.logistics_confrence_room?.stations;
  if (stations) {
    _w.summary('corporate_headquarters', `Stations loaded: ${Object.keys(stations).length} tracked`);
  }
}

function _markDirty() {
  _dirty = true;
  if (!_flushTimer) {
    _flushTimer = setTimeout(_flushToDisk, FLUSH_INTERVAL_MS);
    if (_flushTimer.unref) _flushTimer.unref();
  }
}

function _flushToDisk() {
  _flushTimer = null;
  if (!_dirty || !_cache) return;
  // NOTHING A CONTRACTOR KNOWS REACHES THIS DISK. `_dirty` is cleared rather than left standing: there is
  // no retry to arm, because nothing failed — this body simply has no file. Its places are already safe;
  // they went up to the overseer in an `hq_delta` and were written into its OWNER's file.
  if (_isEphemeral()) { _dirty = false; return; }
  _dirty = false;
  _cache.updated_at = new Date().toISOString();
  // Guarded at the fs boundary — durableWrite is a transparent wrapper whose throw IS the fs throw
  // (it catches nothing; it only cleans up its tmp file on the way out).
  //
  // Reported, not thrown: a flush failure has changed NOTHING on disk (durableWrite is all-or-nothing),
  // the memory-primary cache is still intact and still authoritative, and the next flush retries.
  // `_dirty` goes back up so the retry actually carries this cycle's changes.
  //
  // fsync'd tmp+rename — see js_kernel/durable_write.js for why a plain writeFileSync is what a power
  // cut turns into 48 KB of NUL. The 2s debounce is what makes one fsync per flush cheap.
  const flushed = guardExternalSync('corporate_headquarters', `durable replace of ${HQ_PATH}`,
    () => durableWrite(HQ_PATH, JSON.stringify(_cache, null, 2)));
  if (!flushed.ok) _dirty = true;
}

function flushNow() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_cache) { _dirty = true; _flushToDisk(); }
}

function reset() {
  _cache = { ...EMPTY_HQ };
  _dirty = true;
  _flushToDisk();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Office API (unchanged signatures)
// ─────────────────────────────────────────────────────────────────────────────

function readOffice(name, fallback = {}) {
  const hq = _getCache();
  return Object.prototype.hasOwnProperty.call(hq, name) ? hq[name] : fallback;
}

function writeOffice(name, data) {
  const hq = _getCache();
  hq[name] = data;
  _markDirty();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Conference room API (unchanged signatures)
// ─────────────────────────────────────────────────────────────────────────────

function readConferenceRoomChair(room, entryKey, chair, fallback = null) {
  const hq = _getCache();
  const value = hq?.[room]?.[entryKey]?.[chair];
  return value === undefined ? fallback : value;
}

function writeConferenceRoomChair(room, entryKey, chair, data) {
  const hq = _getCache();
  if (!hq[room]) hq[room] = {};
  if (!hq[room][entryKey]) hq[room][entryKey] = {};
  hq[room][entryKey][chair] = data;
  _markDirty();
}

function readConferenceRoomEntry(room, entryKey, fallback = null) {
  const hq = _getCache();
  const value = hq?.[room]?.[entryKey];
  return value === undefined ? fallback : value;
}

function readConfRoomFlag(room, chair, fallback = null) {
  const hq = _getCache();
  const value = hq?.[room]?.[chair];
  return value === undefined ? fallback : value;
}

function writeConfRoomFlag(room, chair, data) {
  const hq = _getCache();
  if (!hq[room]) hq[room] = {};
  hq[room][chair] = data;
  _markDirty();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3b — THE BUILDING ROOM, WHICH IS THE ONE ROOM WITH AN OWNER IN ITS KEY
// ─────────────────────────────────────────────────────────────────────────────
// A pair of dedicated accessors rather than thirty callers each spelling the key. Every read and write of
// a structure's chair goes through these two, so HOW a building room is addressed is written in exactly
// one place and cannot drift between the sites that write a home and the sites that look for one (Law 16).
//
// WHY THIS ROOM AND NOT THE GENERIC ACCESSOR. `readConferenceRoomChair` is a dumb store verb over any
// room; teaching it to rewrite a key for one particular room would make an identical call mean two
// different things depending on a string argument, which is the opaque behaviour Law 6 forbids. The
// building room is the one that carries an owner, so it gets the one named pair that says so.
//
// A CALLER STILL PASSES THE PLAIN STRUCTURE NAME — `headframe`, `contractor_house`, `farm_plot_2` — and
// never an owner. The owner half is supplied here from the process's own mandate (bot_mandate.buildingRoomKey),
// which is what makes it a keycard: a caller cannot address another crew's base because there is no
// argument in which to name one (Law 27).
//
// READS OF THE WHOLE ROOM DO NOT COME THROUGH HERE, AND MUST NOT. find_buildingspot's footprint rejection
// and blueprint_survey's protected-block walk read `readOffice('building_confrence_room')` raw, on purpose:
// they need EVERY owner's structures so crews refuse to site or dig on top of each other. Write your own,
// read everyone's — the same split station_registry runs between `getStations(null)` and its owner gate.
function readBuildingChair(name, chair, fallback = null) {
  const { buildingRoomKey } = require('@kernel/bot_mandate');
  return readConferenceRoomChair('building_confrence_room', buildingRoomKey(name), chair, fallback);
}

// ESTABLISHING A BUILDSPOT RAISES THE ROW FROM THE DEAD, EXPLICITLY (measured 2026-09-05).
//
// THE BUG THIS FIXES, found by doing the Architect's own workflow — wipe, then rebuild elsewhere.
// `writeConferenceRoomChair` writes a chair INTO the existing entry object, so a key that was
// tombstoned by a wipe keeps its `removed_at` when the crew sites a new base under the same key. The
// row then holds a live `set_buildspot` AND a gravestone, and `isBuildingTombstone` tests nothing but
// `removed_at` — so every reader calls the new house dead, and `pickBuildingEntry` dates the row by the
// old strike instead of the new lock, letting a stale copy from any peer beat it. Observed exactly:
// a house re-sited at (33, 62, -5) at 00:56 still carrying `removed_at` from the 00:37 wipe.
//
// ONLY `set_buildspot` CLEARS IT, and the narrowness is the point. That chair is the one that means "a
// base is established here"; `blueprint_paster` and `building_integrity` are details ABOUT a base and
// must never resurrect a row on their own — a wiped row that some incidental writer touched would come
// back to life without anybody deciding it should. One chair states the fact, so one chair reverses it
// (Law 16), and it is done here rather than in the fragment so it holds for every writer that ever
// establishes a buildspot.
function writeBuildingChair(name, chair, data) {
  const { buildingRoomKey } = require('@kernel/bot_mandate');
  const key = buildingRoomKey(name);
  if (chair === 'set_buildspot') {
    const hq = _getCache();
    const entry = hq?.building_confrence_room?.[key];
    if (entry && entry.removed_at) {
      delete entry.removed_at;
      require('@kernel/watcher').summary('corporate_headquarters',
        `${key} was struck by a wipe and is being re-established — clearing the tombstone.`);
    }
  }
  return writeConferenceRoomChair('building_confrence_room', key, chair, data);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Bot boardroom API
// Each bot owns one named chair. The overseer broadcasts other bots' chairs.
// Local planners read all chairs; only this bot writes its own.
// ─────────────────────────────────────────────────────────────────────────────

function readBoardroomChair(botId, fallback = null) {
  const hq = _getCache();
  return hq?.bot_boardroom?.[botId] ?? fallback;
}

function writeBoardroomChair(botId, data) {
  const hq = _getCache();
  if (!hq.bot_boardroom) hq.bot_boardroom = {};
  hq.bot_boardroom[botId] = data;
  _markDirty();
}

function getFullBoardroom(fallback = {}) {
  const hq = _getCache();
  return hq?.bot_boardroom ?? fallback;
}

// releaseAbsentBotMagnets(connectedBotIds, selfId) — void every magnet held by a bot that is NOT
// currently connected to the overseer. Returns the ids released (empty = nothing to do).
//
// WHY THE MAGNET IS THE RIGHT UNIT: a chest lock is not separate state — it lives INSIDE the magnet
// as `magnet.chest_locks`, precisely so that one clearMagnet() releases the job claim and every chest
// with it (station_registry's Phase-3 note: "no separate registry, no orphaned locks on completion or
// crash"). That holds for a bot that exits through its own disconnect handler. It does not hold when
// the process dies without running one — and killing the server window kills every bot AND the
// overseer at once, so no handler runs anywhere. The chair then sits on each surviving bot's DISK,
// magnet and locks intact, and is read back as gospel on the next run.
// Measured 2026-07-21: a single-bot continue run found the headframe chests "🔒 in use by
// TessaBot" with TessaBot not in the session. Locked means wait-to-act, so those chests were held by
// a ghost for the rest of the world's life.
//
// WHY IT IS DRIVEN BY THE CONNECTED ROSTER rather than a disconnect event: the event is exactly what
// a hard kill destroys, so a system that only reacts to it is protected in every case except the one
// that happens. The roster is re-sensed on every broadcast and the holder is re-checked against it
// (Invariant B: never act on remembered state — here the remembered state is "TessaBot holds this").
// A missed message cannot leak, because the next broadcast restates the whole truth.
//
// THE SELF CHAIR IS NEVER TOUCHED: this bot is by definition connected (it just received a
// broadcast), it owns its own chair (Invariant D), and its own live magnet is mid-job.
function releaseAbsentBotMagnets(connectedBotIds, selfId) {
  const hq = _getCache();
  const board = hq?.bot_boardroom;
  if (!board || !Array.isArray(connectedBotIds)) return [];
  const connected = new Set(connectedBotIds);
  const released = [];
  for (const [botId, chair] of Object.entries(board)) {
    if (botId === selfId || connected.has(botId)) continue;
    if (!chair || !chair.magnet) continue;
    chair.magnet = null;
    released.push(botId);
  }
  if (released.length) _markDirty();
  return released;
}

// Merge other bots' chairs from an overseer broadcast.
// Only writes to bot_boardroom — never touches local conference rooms or offices.
function mergeBroadcastChairs(chairs) {
  const hq = _getCache();
  if (!hq.bot_boardroom) hq.bot_boardroom = {};
  for (const [id, chair] of Object.entries(chairs)) {
    hq.bot_boardroom[id] = chair;
  }
  _markDirty();
}

// Merge the overseer's relayed station map into logistics_confrence_room.stations
// (Phase 6 multi-bot sync). A station id is a unique world voxel, so the merge is
// last-writer-wins per id keyed on the entry's `updated_at` stamp (station_registry
// stamps every write). Incoming entries only overwrite when at least as fresh, so a
// bot's own newer local edit is never clobbered by another bot's stale copy. This
// path never REMOVES an entry, and it does not need to: a removal arrives as an ordinary
// entry carrying `removed_at` (station_registry's tombstone), so it merges by the same
// freshness rule as any other write and the readers there drop it. The merge stays a pure
// add/refresh relay (Law 3: no decisions, only routing/merging state).
//
// THE PREMISE THAT STOOD HERE WAS FALSE, and it is worth naming because it is the natural one to
// re-adopt: it said deletion was handled locally by each bot dropping a dug-up station when it can
// see the empty voxel. A local delete cannot survive this function — the loop reads INCOMING keys,
// so a key that is absent is no-news and the remembered entry stays. The deleting bot then received
// its own dead station back on the next broadcast and struck it again, forever.
function mergeBroadcastStations(stations) {
  if (!stations || typeof stations !== 'object') return;
  const hq = _getCache();
  if (!hq.logistics_confrence_room) hq.logistics_confrence_room = {};
  const local = hq.logistics_confrence_room.stations || {};
  for (const [id, entry] of Object.entries(stations)) {
    if (!entry || typeof entry !== 'object') continue;
    const cur = local[id];
    const incomingAt = entry.updated_at || 0;
    const curAt = (cur && cur.updated_at) || 0;
    if (!cur || incomingAt >= curAt) local[id] = entry;
  }
  hq.logistics_confrence_room.stations = local;
  _markDirty();
}

// Merge the overseer's relayed fleet structures into building_confrence_room.
// The fleet has ONE of each structure — a bot whose room lacks the headframe
// ADOPTS the peer's established entry verbatim, so its own planner sees the
// home as set (no duplicate buildspot) and every downstream consumer (mining
// shaft site, building integrity, anchors) reads the same coordinates. The
// merge rule (first-writer-wins on locked_at) lives in message_schema so bot
// and overseer apply the identical contract (Law 16).
function mergeBroadcastBuildings(buildings) {
  if (!buildings || typeof buildings !== 'object') return;
  const { pickBuildingEntry } = require('@overseer/message_schema');
  const hq = _getCache();
  if (!hq.building_confrence_room) hq.building_confrence_room = {};
  const local = hq.building_confrence_room;
  for (const [key, entry] of Object.entries(buildings)) {
    if (!entry || typeof entry !== 'object') continue;
    local[key] = pickBuildingEntry(local[key], entry);
  }
  _markDirty();
}

module.exports = {
  HQ_PATH,
  readOffice,
  writeOffice,
  readConferenceRoomChair,
  writeConferenceRoomChair,
  readBuildingChair,
  writeBuildingChair,
  readConferenceRoomEntry,
  readConfRoomFlag,
  writeConfRoomFlag,
  readBoardroomChair,
  writeBoardroomChair,
  getFullBoardroom,
  mergeBroadcastChairs,
  releaseAbsentBotMagnets,
  mergeBroadcastStations,
  mergeBroadcastBuildings,
  flushNow,
  reset,
};
