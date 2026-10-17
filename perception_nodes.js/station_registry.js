// station_registry.js (perception node)
// Reads and writes logistics_confrence_room.stations in corporate_headquarters. Each station row is
// keyed by voxel-then-owner ("x|y|z|owner") with { type, pos, items, owner }.
//
// registerStation requires an open window matching the expected block type before writing; on failure
// nothing is written, and a block without a verified ID must not occupy a station slot (Law 16). A chest
// carries no role: storage is one pool, measured across every registered chest. Each storage station has
// a NUMBER (chestNumbers) that orders the pool: deposits fill from the lowest and withdrawals draw from
// the highest, so material consolidates toward the low end.
//
// Called by: build_executor (registerStation, after placing), job_board (getStations, for the census),
// craft_handler (findStation), inventory_swapper (getStations, snapshotStation, for dumpExcess).

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { Vec3 } = require('vec3');

const TAG = 'station_registry';

// STORAGE_TYPES: the one definition of which stations hold the pool (Law 16); isStorage the one
// question. A barrel is treated identically to a chest — same window, registration, spot, and pool.
const STORAGE_TYPES = new Set(['chest', 'trapped_chest', 'barrel']);
function isStorage(entry) { return !!entry && STORAGE_TYPES.has(entry.type); }

// Maps block type → regex that the mineflayer window.type must match.
// Chest/barrel share minecraft:generic_9x3; double chests use generic_9x6.
// If a block type isn't here, it can't be registered (not a known station).
const WINDOW_TYPE_VALIDATORS = {
    chest:          /generic|chest/i,
    trapped_chest:  /generic|chest/i,
    barrel:         /generic/i,
    furnace:        /furnace/i,
    blast_furnace:  /blast_furnace/i,
    smoker:         /smoker/i,
    hopper:         /hopper/i,
    crafting_table: /crafting/i,
};

// ── PROOF OF AN OPEN WINDOW ──────────────────────────────────────────────────────────────────────────
// registerStation refuses to write a row without an open window of the matching type; openProofWindow is
// the one routine that obtains it (Law 16), polling since activateBlock opens a window asynchronously
// (Invariant B). A stale-window failure is reported in `diag` apart from `no_window`.
const WINDOW_OPEN_TRIES = 3;       // activateBlock attempts before concluding no_window
const WINDOW_POLL_STEPS = 3;       // currentWindow re-reads per attempt
const WINDOW_POLL_STEP_MS = 250;   // wait between re-reads (≈2.25s total budget)
const _sleep = ms => new Promise(res => setTimeout(res, ms));

async function openProofWindow(bot, block, diag = {}) {
    // Required lazily so perception readers (which must not depend on the movement stack) can load this file.
    const { ensureNoOpenWindow } = require('@utils/movement/dig_authority');
    const { guardExternal } = require('@utils/external_library_guard');
    // Stamped into `diag` so a caller's crash message reports the exact budget this call used (Law 25).
    diag.window_tries = WINDOW_OPEN_TRIES;
    diag.window_polls = WINDOW_POLL_STEPS;
    diag.window_poll_ms = WINDOW_POLL_STEP_MS;
    if (bot.currentWindow) {
        diag.pre_existing_window = bot.currentWindow.type || 'unknown';
        await ensureNoOpenWindow(bot, `stale window before opening ${block.name}`);
        if (bot.currentWindow) { diag.stale_window_stuck = true; return null; }
    }
    for (let attempt = 0; attempt < WINDOW_OPEN_TRIES; attempt++) {
        diag.activate_attempts = attempt + 1;
        // Success is judged by the poll below, not this call's return — a late-opening lid looks identical
        // to one that never opens. Only a thrown error is recorded here, as a distinct cause from no_window.
        const act = await guardExternal(TAG, `activateBlock ${block.name} to open its window`, () => bot.activateBlock(block));
        if (!act.ok) diag.activate_error = String(act.error && act.error.message || act.error || 'refused');
        for (let i = 0; i < WINDOW_POLL_STEPS; i++) {
            await _sleep(WINDOW_POLL_STEP_MS);
            if (bot.currentWindow) { diag.opened_on_attempt = attempt + 1; return bot.currentWindow; }
        }
    }
    return null;
}

function posId(pos) {
    return `${Math.floor(pos.x)}|${Math.floor(pos.y)}|${Math.floor(pos.z)}`;
}

// stationKey: the row key — the voxel, then whose shelf it is (owner appended, not prepended, since
// inventory_swapper parses coordinates from the first three fields), read from this process's own
// mandate (Law 27). Two rows may point at the same voxel without collision: no row stores contents.
function stationKey(pos) {
    return `${posId(pos)}|${require('@kernel/bot_mandate').stationOwnerKey()}`;
}

function _getBotId() {
    return process.env.BOT_ID || 'default';
}

// ── THE NUMBER OF A STORAGE STATION ───────────────────────────────────────────────────────────────────
// Derived from the station's place, never stored: blueprint, then x, then z, then y. A stored number would
// be a second fact two bodies could write differently in the same instant; a derived one is the same
// answer on every body from the same map (Law 16). A chest added later takes its place in the order and
// the numbers after it shift by one, so no caller keeps a number across a re-read.
function chestNumbers() {
    const rows = findChests();
    rows.sort((a, b) => String(a.blueprint || '').localeCompare(String(b.blueprint || ''))
        || (a.pos.x - b.pos.x) || (a.pos.z - b.pos.z) || (a.pos.y - b.pos.y));
    const numbers = new Map();
    rows.forEach((r, i) => numbers.set(r.id, i + 1));
    return numbers;
}

// ── THE SPOT: WHICH CHEST A BODY IS USING, SAID BEFORE IT WALKS ───────────────────────────────────────
// Storage takes no lock. Minecraft lets any number of bodies hold one container's window and act in it at
// once (BarrelBlock.useWithoutItem has no occupancy check; ContainerOpenersCounter only counts), and the
// claims keep them apart: a withdrawal takes only stock no other body has claimed (chest_ledger.claim),
// and a deposit fills only room it claimed (chest_ledger.claimRoom). The spot is not a lock and nothing
// waits on it. It tells a body opening a window whether a peer may be moving the chest under it, which
// decides whether the window must match the chest's last picture. It rides the chair, outside the magnet,
// because a body deposits with or without a job, and a spot older than SPOT_STALE_MS is not counted, so
// a body killed mid-window leaves nothing that matters.
// A RELEASED SPOT KEEPS ITS TIMES. Whether a peer used a chest DURING a window is a question about an
// interval, and two samples of who is there now (at the open and at the close) miss a peer whose whole
// visit falls between them. So the release stamps `released_at` instead of erasing the
// spot, and spotsDuring asks whether any peer's [at, released_at] overlapped the window.
const SPOT_STALE_MS = 5 * 60 * 1000;
function claimSpot(stationId, orderType) {
    const botId = _getBotId();
    const chair = hq.readBoardroomChair(botId, {}) || {};
    chair.chest_spot = { id: stationId, dir: orderType, at: Date.now(), released_at: null };
    hq.writeBoardroomChair(botId, chair);
}
function releaseSpot(stationId) {
    const botId = _getBotId();
    const chair = hq.readBoardroomChair(botId, {}) || {};
    if (!chair.chest_spot || chair.chest_spot.id !== stationId || chair.chest_spot.released_at) return;
    chair.chest_spot = { ...chair.chest_spot, released_at: Date.now() };
    hq.writeBoardroomChair(botId, chair);
}
function _peerSpots(stationId, viewerBotId) {
    const viewer = viewerBotId || _getBotId();
    const out = [];
    for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}))) {
        const spot = chair && chair.chest_spot;
        if (botId === viewer || !spot || spot.id !== stationId) continue;
        out.push({ botId, ...spot });
    }
    return out;
}
// The peers whose spot is this station now, as [{ botId, dir }].
function spotHolders(stationId, viewerBotId) {
    const now = Date.now();
    return _peerSpots(stationId, viewerBotId)
        .filter(s => !s.released_at && now - s.at <= SPOT_STALE_MS)
        .map(s => ({ botId: s.botId, dir: s.dir }));
}
// The peers whose spot on this station overlapped [from, to] at any moment, as [{ botId, dir }].
function spotsDuring(stationId, from, to, viewerBotId) {
    const now = Date.now();
    return _peerSpots(stationId, viewerBotId)
        .filter(s => s.at <= to && (s.released_at ? s.released_at >= from : now - s.at <= SPOT_STALE_MS))
        .map(s => ({ botId: s.botId, dir: s.dir }));
}

// ── Magnet-locked stations ────────────────────────────────────────────────────────────────────────────
// A station a body uses whole (a composter) is reserved to that bot's magnet. Locked is a mark, not a
// veil: peers still see it, but must wait for release before acting on it. Storage takes no lock (the
// spot above). The lock lives inside the magnet, so clearMagnet() releases every lock in one write
// (Law 8, Law 13).

// Map of station ID → holding bot, for locks held by bots OTHER than the viewer.
function _getLocksByStation(viewerBotId) {
    const boardroom = hq.getFullBoardroom({});
    const locked = new Map();
    for (const [botId, chair] of Object.entries(boardroom)) {
        if (botId === viewerBotId) continue;
        const locks = chair && chair.magnet && chair.magnet.chest_locks;
        if (Array.isArray(locks)) for (const id of locks) locked.set(id, botId);
    }
    return locked;
}

// Which peer holds a lock on this station (null when free). Locked means the contents are unknown until
// release, never absent — a reader counting stock must skip it, but a bot targeting it may queue instead.
function getLockHolder(stationId, viewerBotId) {
    if (!stationId) return null;
    const viewer = viewerBotId || _getBotId();
    const boardroom = hq.getFullBoardroom({});
    for (const [botId, chair] of Object.entries(boardroom)) {
        if (botId === viewer) continue;
        const locks = chair && chair.magnet && chair.magnet.chest_locks;
        if (Array.isArray(locks) && locks.includes(stationId)) return botId;
    }
    return null;
}

// unlockChest: drops a single lock without clearing the magnet, scoped to the chest window alone.
// clearMagnet() remains the backstop for a bot that dies or is preempted mid-window, since that is what
// stops a lock outliving the bot (Law 8).
function unlockChest(stationId, botId, reason = 'released') {
    if (!stationId) return;
    if (!botId) botId = _getBotId();
    const chair = hq.readBoardroomChair(botId, {});
    const locks = chair && chair.magnet && Array.isArray(chair.magnet.chest_locks)
        ? chair.magnet.chest_locks : null;
    if (!locks || !locks.includes(stationId)) return;
    chair.magnet.chest_locks = locks.filter(id => id !== stationId);
    hq.writeBoardroomChair(botId, chair);
    watcher.summary(TAG, `chest ${stationId} lock dropped by ${botId} (${reason}).`);
}

// acquireChestLock: lockChest, then verify exclusivity. Locks live in separate magnet chairs, so two
// simultaneous writes both succeed; a re-check after writing backs off if any rival holds the chest, and
// the caller's per-bot retry stagger keeps a double back-off from re-colliding.
function acquireChestLock(stationId, botId) {
    if (!botId) botId = _getBotId();
    if (getLockHolder(stationId, botId)) return false;   // occupied — don't even write
    lockChest(stationId, botId);
    const rival = getLockHolder(stationId, botId);
    if (!rival) return true;
    unlockChest(stationId, botId, 'arbitration back-off');
    return false;
}

// lockChest: reserves a station to a bot's magnet the moment it commits to using it. Idempotent; a no-op
// when the bot holds no magnet, since there is no job to release the lock later (Law 8).
function lockChest(stationId, botId) {
    if (!stationId) return;
    if (!botId) botId = _getBotId();
    const chair = hq.readBoardroomChair(botId, {});
    if (!chair.magnet) return;
    const locks = Array.isArray(chair.magnet.chest_locks) ? chair.magnet.chest_locks : [];
    if (locks.includes(stationId)) return;
    locks.push(stationId);
    chair.magnet.chest_locks = locks;
    hq.writeBoardroomChair(botId, chair);
    watcher.summary(TAG, `chest ${stationId} locked to bot ${botId}.`);
}

// registerStation: verifies an open window matches the expected block type, snapshots its contents, and
// writes the entry to corporate_headquarters. `blueprint` tags the station with its room key in
// building_confrence_room. Returns { ok, id, items }, or { ok: false, reason } with nothing written.
// `stance` is the cell the body stood on when it placed the station, recorded once and fixed (Law 19); a
// blueprint station carries its authored anchor cell instead, and null means no authored cell exists, so
// the reader must refuse to move (Law 13).
function registerStation(pos, type, window, blueprint, stance) {
    if (!window) {
        return { ok: false, reason: 'no_window' };
    }

    const validator = WINDOW_TYPE_VALIDATORS[type];
    if (!validator) {
        return { ok: false, reason: `unknown_station_type: ${type}` };
    }

    const windowType = window.type || '';
    if (!validator.test(windowType)) {
        watcher.warn(TAG, `window type '${windowType}' does not match expected '${type}' — rejecting registration.`);
        return { ok: false, reason: `window_mismatch: expected ${type}, got ${windowType}` };
    }

    const items = [];
    const totalSlots = window.slots ? window.slots.length : 0;
    const containerEnd = Math.max(0, totalSlots - 36);
    for (let i = 0; i < containerEnd; i++) {
        const it = window.slots[i];
        if (it) items.push({ name: it.name, count: it.count });
    }

    const capacity = (window && window.slots) ? Math.max(0, window.slots.length - 36) : 27;

    // No guard against overwriting another owner's row: the key carries the owner, so this write always
    // lands on this bot's own key and cannot land on anybody else's (Law 16).
    const id = stationKey(pos);
    const key = require('@kernel/bot_mandate').stationOwnerKey();
    const stations = hq.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    stations[id] = {
        type,
        pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        capacity,
        items,
        // owner: whose shelf this is, read from this process's own mandate so a caller cannot stamp a
        // shelf for anyone else (Law 27).
        owner: key,
        blueprint: blueprint || null,
        // The floor cell the feet rest on, matching what an anchor names; null when nothing authored it.
        stance: stance
          ? { x: Math.floor(stance.x), y: Math.floor(stance.y), z: Math.floor(stance.z) }
          : null,
        // updated_at: the last-writer-wins key for the foreman merge, stamped on every mutation below too.
        updated_at: Date.now(),
    };
    hq.writeConfRoomFlag('logistics_confrence_room', 'stations', stations);
    watcher.summary(TAG, `registered ${type} at (${pos.x},${pos.y},${pos.z}) id=${id} window=${windowType} items=${items.length} blueprint=${blueprint || 'none'}`);
    return { ok: true, id, items };
}

// ── Tombstones ────────────────────────────────────────────────────────────────────────────────────────
// A removed station stays as a row carrying `removed_at`, and every reader and mutator treats it as no
// station at all. The fleet's merge reads incoming entries only, so a locally deleted key would read to a
// peer as silence — the tombstone is an ordinary write on the same last-writer-wins key a registration
// uses (Law 16, Invariant B), and a newer registration always wins.
function _isRemoved(entry) {
    return !!(entry && entry.removed_at);
}

function snapshotStation(id, items) {
    const stations = hq.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    if (!stations[id] || _isRemoved(stations[id])) return false;
    stations[id].items = items;
    stations[id].updated_at = Date.now();   // freshen the Phase 6 merge key
    hq.writeConfRoomFlag('logistics_confrence_room', 'stations', stations);
    return true;
}

// setSmeltState / getSmeltState / clearSmeltState: the furnace's in-flight order rides on its station
// entry (Law 6), surviving a crash; job_board reads completion without opening the window, though the
// real window stays ground truth on collect (Law 13). Stamps updated_at so the load propagates via merge.
function setSmeltState(id, state) {
    const stations = hq.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    if (!stations[id] || _isRemoved(stations[id])) return false;
    stations[id].smelt = state;
    stations[id].updated_at = Date.now();
    hq.writeConfRoomFlag('logistics_confrence_room', 'stations', stations);
    return true;
}

function getSmeltState(id) {
    const stations = hq.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    return (stations[id] && !_isRemoved(stations[id])) ? (stations[id].smelt || null) : null;
}

function clearSmeltState(id) {
    return setSmeltState(id, null);
}

// Already-tombstoned returns false, so a station is reported struck exactly once (verifyAgainstWorld
// counts the return). The row keeps `pos`, `type` and `owner`, since the merge and owner gate both key
// on them.
function removeStation(id) {
    const stations = hq.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    const entry = stations[id];
    if (!entry || _isRemoved(entry)) return false;
    const now = Date.now();
    stations[id] = {
        pos: entry.pos,
        type: entry.type,
        owner: entry.owner,
        removed_at: now,
        updated_at: now,
    };
    hq.writeConfRoomFlag('logistics_confrence_room', 'stations', stations);
    watcher.summary(TAG, `removed station id=${id}`);
    return true;
}

// getStations: the station map as seen by `viewerBotId`. A chest locked by another bot is included and
// stamped `locked_by`, since its last snapshot stays visible (Law 6); wait-to-act is enforced at the
// chest-interaction pathway, not here. Pass viewerBotId === null for the raw, unstamped map; tombstones
// are filtered on both branches, ahead of the owner gate.
function getStations(viewerBotId) {
    const raw = hq.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    const stations = {};
    for (const [id, entry] of Object.entries(raw)) {
        if (!_isRemoved(entry)) stations[id] = entry;
    }
    if (viewerBotId === null) return stations;
    const mine = _ownStations(stations);
    const lockedByOthers = _getLocksByStation(viewerBotId || _getBotId());
    if (lockedByOthers.size === 0) return mine;
    const visible = {};
    for (const [id, entry] of Object.entries(mine)) {
        // copy-on-stamp: the stored map must never carry the viewer-relative mark
        visible[id] = lockedByOthers.has(id) ? { ...entry, locked_by: lockedByOthers.get(id) } : entry;
    }
    return visible;
}

// The owner gate, and the only one: every read of the station map reaches it through getStations, so the
// filter lands here once (Law 27, Invariant D). Not the lock rule: a chest locked by a peer stays visible,
// since a peer shares your shelves; a chest belonging to another owner is simply absent. An entry with no
// `owner` is the commons — stations written before the owner axis existed have no other true value (Law 13).
function _ownStations(stations) {
    // Lazy, like the mandate read below it: a perception node must not take a load-time dependency on
    // the thinking layer, and `preflight` opens this file with no mandate in the environment.
    const { BOT_MODES } = require('@thinking/architect_config');
    const key = require('@kernel/bot_mandate').stationOwnerKey();
    const mine = {};
    for (const [id, entry] of Object.entries(stations)) {
        if (!entry) continue;
        if ((entry.owner || BOT_MODES.HOMESTEADER) === key) mine[id] = entry;
    }
    return mine;
}

function getStationTypes() {
    const stations = getStations();
    const types = new Set();
    for (const entry of Object.values(stations)) {
        if (entry && typeof entry.type === 'string') types.add(entry.type);
    }
    return types;
}

// Can a craft use this station right now: it stands, registered. No station is usable out of a pocket —
// the crew crafts at its home blueprint's table and smelts at its blueprint furnaces (Law 16).
function stationUsable(stationType) {
    return getStationTypes().has(stationType);
}

// Every station type usable right now — the same verdict as stationUsable, asked of all at once. Used by
// the dispatcher to stamp the magnet at claim time (Law 16).
function usableStationTypes() {
    return [...getStationTypes()];
}

// findStation: one station of this type, a blueprint's before a field one. A blueprint station has an
// authored stance (resolveVoxelAnchor), so a caller can walk to it from anywhere; a field station has no
// anchor by design, so a caller that cannot reach it falls through and sets down its own. Not sorted by
// distance: this file records voxels, not the body's position.
function findStation(type) {
    const stations = getStations();
    let field = null;
    for (const [id, entry] of Object.entries(stations)) {
        if (!entry || entry.type !== type) continue;
        if (entry.blueprint) return { id, ...entry };
        if (!field) field = { id, ...entry };
    }
    return field;
}

// stationAt(pos): the row for one voxel, or null. Goes through getStations() like every other reader, so
// the viewer filter and tombstone filter apply here too (Law 16, one pathway in).
function stationAt(pos) {
    const id = stationKey(pos);
    const stations = getStations();
    return stations[id] || null;
}

// findChests: every registered chest, as { id, ...entry } — the one door to "where can material go or
// come from".
function findChests() {
    const stations = getStations();
    const results = [];
    for (const [id, entry] of Object.entries(stations)) {
        if (isStorage(entry)) results.push({ id, ...entry });
    }
    return results;
}

// verifyAgainstWorld: confirms every registered station's voxel still holds the expected block, dropping
// entries the live world does not back (Law 6/Law 13). Right block keeps; wrong block/air removes; an
// unloaded chunk keeps, since an unproven absence must not be dropped. Owned here, not in job_board.
function verifyAgainstWorld(bot) {
    if (!bot || !bot.blockAt) return;
    // Own shelves only: verification deletes entries, so a shared map would have every bot correcting
    // every other owner's record (Invariant D). Locked chests are still verified, since a lock marks
    // without removing.
    const stations = getStations();
    let verified = 0, removed = 0, unloaded = 0;
    const staleDetails = [];
    for (const [id, entry] of Object.entries(stations)) {
        if (!entry || !entry.pos || !entry.type) continue;
        const block = bot.blockAt(new Vec3(entry.pos.x, entry.pos.y, entry.pos.z));
        if (!block) { unloaded++; continue; }
        if (block.name === entry.type) { verified++; continue; }
        staleDetails.push(`${id} expected ${entry.type}, world has "${block.name}"`);
        removeStation(id);
        removed++;
    }
    // One warn aggregates the whole sweep's stale stations: the sweep is a single phase of work, so its
    // warnings accumulate-then-post (Law 5); detail is preserved in the join.
    if (removed) {
        watcher.warn(TAG, `removed ${removed} stale station(s): ${staleDetails.join('; ')}`);
    }
    if (verified || removed || unloaded) {
        watcher.summary(TAG, `stations: verified ${verified}, removed ${removed} stale, ${unloaded} unloaded (kept)`);
    }
}

// logContents: posts every chest/furnace's contents to the Watcher as the station census, using the
// viewer-stamped map so locked chests show their last snapshot with a lock tag.
function logContents() {
    const stations = getStations();
    const emptyStations = [];
    for (const [id, entry] of Object.entries(stations)) {
        if (!entry || !entry.pos) continue;
        if (!isStorage(entry) && entry.type !== 'furnace') continue;
        const items = (entry.items || []).filter(it => it && it.count > 0);
        // The blueprint tag is the one distinction left: a structure's station versus a pocket's.
        const ownerTag = entry.blueprint ? ` [${entry.blueprint}]` : '';
        const lockTag = entry.locked_by ? ` 🔒 in use by ${entry.locked_by}` : '';
        const label = `${entry.type}(${id})${ownerTag}${lockTag}`;
        if (items.length === 0) {
            emptyStations.push(label);
        } else {
            const contents = items.map(it => `${it.name.replace('minecraft:', '')}x${it.count}`).join(', ');
            watcher.summary(TAG, `📦 ${label}: ${contents}`);
        }
    }
    if (emptyStations.length > 0) {
        watcher.summary(TAG, `📦 empty: ${emptyStations.join(', ')}`);
    }
}

module.exports = { posId, stationKey, openProofWindow, registerStation, snapshotStation, removeStation, getStations, getStationTypes, stationUsable, usableStationTypes, findStation, stationAt, findChests, chestNumbers, claimSpot, releaseSpot, spotHolders, spotsDuring, isStorage, STORAGE_TYPES, lockChest, unlockChest, getLockHolder, acquireChestLock, setSmeltState, getSmeltState, clearSmeltState, verifyAgainstWorld, logContents };
