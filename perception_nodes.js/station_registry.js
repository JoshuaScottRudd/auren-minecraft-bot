// station_registry.js (perception node)
// Reads and writes logistics_confrence_room.stations in corporate_headquarters.
// Each station row is keyed by voxel-then-owner ("x|y|z|owner") with { type, pos, items, owner }.
//
// registerStation REQUIRES an open window as proof that the block is real and
// is the correct type. The window type is matched against the expected block
// type before anything is saved. If verification fails, nothing is written
// and the caller (build_executor) must dig the block up — a block without a
// verified ID must not occupy a station slot (Law 16, one pathway).
//
// A CHEST IS A CHEST — there is no `role` field and no chest NUMBER, and the absence is the design.
// Chests carried 'requester' (received harvest, watched against thresholds) or 'buffer' (received
// dumpExcess overage), assigned at registration by a now-deleted `determineChestRole` reading a
// now-deleted RESOURCE_REQUIREMENTS table. Every one of those names is gone, because a REQUEST IS A
// LOGISTICS-SYSTEM-WIDE FIGURE, NEVER AN ADDRESS: the deficit that opens a `storage` stock row is
// measured across every registered chest at once, so the role never decided whether the fleet was short
// — it only decided which chest a delivery walked to, and the courier that existed to move stock from a
// buffer to a requester could by construction never fire (if a chest held the material, the deficit was
// already closed).
//
// WHAT IT COSTS TO RE-ADD, since "tag the chests by purpose" reads as an obvious improvement: the base
// carries ONE chest on its first anchor, beside the crafting table and the furnace. A two-role split
// applied to one chest gives that chest one role, and every read of the other role then finds nothing —
// so either the dump or the request silently stops working, with a full chest sitting in front of it.
//
// registerStation REQUIRES an open window as proof that the block is real and
// is the correct type. The window type is matched against the expected block
// type before anything is saved. If verification fails, nothing is written
// and the caller (build_executor) must dig the block up — a block without a
// verified ID must not occupy a station slot (Law 16, one pathway).
//
// Called by:
//   build_executor — registerStation() after placing a station
//   job_board — getStations() to render the storage census
//   craft_handler — findStation() to locate a specific station type
//   inventory_swapper — getStations() for dumpExcess's destinations; snapshotStation()

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { Vec3 } = require('vec3');

const TAG = 'station_registry';

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

// ── THE PROOF THIS FILE DEMANDS, AND THE ONE ROUTINE THAT OBTAINS IT ─────────────────────────────────
// registerStation refuses to write a row without an open window of the matching type. That precondition
// is authored here, so the routine that satisfies it lives here too — it MOVED OUT of build_executor the
// day a second caller needed it (craft_handler, registering the field table it sets down). Left where it
// was, the second caller would have grown a copy, and two definitions of "prove this block is real" is
// the Law 16 delete-test failing in the direction nobody checks: both live, both right, and a fix to one
// silently absent from the other.
//
// A RE-SENSE, NOT A ONE-SHOT READ (Invariant B). activateBlock opens a container's window ASYNCHRONOUSLY
// — under server latency the lid can lag past a single fixed sleep, so reading bot.currentWindow once
// falsely returns null, registerStation reports no_window, and a correctly-placed block is treated as a
// mis-placement. Poll for the window instead, and re-activate only when none is open yet (activateBlock
// TOGGLES — re-activating an open chest would close it).
//
// A WINDOW THAT WAS ALREADY OPEN IS NOT THIS BLOCK'S WINDOW, and returning one was a real defect rather
// than a tidiness point. The original loop read `if (!bot.currentWindow) activate(...)` and then returned
// `bot.currentWindow` — so a container left open by an earlier step was handed back as if this block had
// opened it. The type validation below then reported `window_mismatch`, the caller read that as a
// mis-placement, and a stale chest window could destroy the furnace placed after it. Closed first, so
// what comes back opened for THIS activation or nothing does.
//
// The stale-window failure is reported in `diag` rather than folded into "no_window": the two are
// different faults with different fixes, and telling them apart is the point of the diagnosis.
const WINDOW_OPEN_TRIES = 3;       // activateBlock attempts before concluding no_window
const WINDOW_POLL_STEPS = 3;       // currentWindow re-reads per attempt
const WINDOW_POLL_STEP_MS = 250;   // wait between re-reads (≈2.25s total budget)
const _sleep = ms => new Promise(res => setTimeout(res, ms));

async function openProofWindow(bot, block, diag = {}) {
    // Required lazily: dig_authority reaches into fragment_utils and the movement stack, and this file is
    // loaded by perception readers that must not drag that in.
    const { ensureNoOpenWindow } = require('@utils/movement/dig_authority');
    const { guardExternal } = require('@utils/external_library_guard');
    // THE BUDGET TRAVELS IN THE DIAGNOSIS, not as three exported constants. build_executor's crash
    // message states how hard this tried before giving up, and a reader of that message is being told a
    // number they cannot check. Stamped here, the number IS the one the loop below used, so the message
    // cannot describe a budget this routine no longer has (Law 25).
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
        // The activation result is not read for SUCCESS — a lid that opens late looks identical to one that
        // never opened at the moment the call returns, so the poll below is the only thing that can answer.
        // Its FAILURE is recorded though: activateBlock throwing (out of range, no such block) is a different
        // cause from a lid that never arrives, and it used to vanish into the same `no_window`.
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

// stationKey — THE ROW KEY: the voxel, then whose shelf it is. The location is still the id; the owner
// is appended to it.
//
// THE KEY IS THE KEYCARD, and appending it is what makes that literal rather than a figure of speech.
// The owner half is read from this process's own mandate, so a bot cannot FORM an id belonging to
// another crew — not "is refused when it tries", cannot construct the string. Every write verb takes an
// id, so one unformable key closes the whole write surface at once, and nothing is left to police
// (Law 27: the failing case does not exist inside the thing).
//
// APPENDED, NEVER PREPENDED. inventory_swapper parses a row key back into coordinates by splitting on
// the separator and taking the first three parts; a suffix leaves that read intact, a prefix silently
// shifts every coordinate by one field.
//
// Two crews may now hold a row each for the SAME voxel, which is not a collision here: no row stores
// contents (they are read from the world at the moment of use), so two rows pointing at one chest
// disagree about nothing. Which crew should own a chest the other built is a question about the world,
// and there is no evidence yet that it arises.
function stationKey(pos) {
    return `${posId(pos)}|${require('@kernel/bot_mandate').stationOwnerKey()}`;
}

function _getBotId() {
    return process.env.BOT_ID || 'default';
}

// ── Phase 3: magnet-locked chests ────────────────────────────────────────────
// A chest a bot is using is reserved to that bot's magnet. Locked is a MARK,
// not a veil (Architect, 2026-07-05): peers still see the chest and its last
// snapshot — any calculation may count it — but locked means wait-to-act:
// whoever decides to USE that chest must wait for release (inventory_swapper
// queues at it), then act on the fresh post-release snapshot. A bot that does
// not need the chest is unaffected. The lock lives INSIDE the magnet (a
// station-ID list), mirroring how the dispatcher keeps two bots off the same
// job. Because the lock is a field of the magnet, clearMagnet() releases every
// lock in one write — no separate registry, no orphaned locks on completion or
// crash (Law 8, Law 13). Law 6: named, inspectable, creates no signal.

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

// Which peer holds a lock on this station (null when free). Locked means the
// contents are UNKNOWN until the holder finishes — never absent: readers that
// count stock must skip it, but a bot targeting it may queue for release
// instead of concluding the chest doesn't exist.
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

// unlockChest: drop a single lock without clearing the magnet.
//
// THE LOCK IS SCOPED TO THE CHEST WINDOW, NOT THE JOB (Architect 2026-08-14: *"yes go ahead and scop the
// lock to the chest window. instead of job. thats obvious"*). It used to be released only by clearMagnet()
// at job end, on the reasoning that one owner should hold the whole lifecycle (Law 8). Measured, that cost
// the fleet more than it protected: on the 2026-08-14 soak a bot withdrew 3 logs, walked away and built for
// ninety seconds while still holding the chest, and its peer's own line read `after 98.2s waiting to get
// in` for a transfer that then took 0.4s. 174s of a 798s run went to peer queueing on chest work that
// totals ~0.4s per visit.
//
// clearMagnet() REMAINS the backstop and is not redundant with this: a bot that dies or is preempted
// mid-window never reaches its release, and the magnet clearing is what stops that lock outliving the bot
// (Law 8 — nothing runs on invisibly past the owner that raised it).
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

// acquireChestLock: lockChest, then verify exclusivity. Locks live in separate
// magnet chairs, so two bots' simultaneous writes both succeed and neither
// fails — after writing we re-check and back off if ANY rival holds the chest.
// First-come wins, always: a rival may be mid-transfer and must never be
// preempted, and we cannot tell mid-use from a same-instant grab. A true
// double-grab makes BOTH bots back off; the caller's deterministic per-bot
// retry stagger (inventory_swapper) keeps the retry round from re-colliding.
function acquireChestLock(stationId, botId) {
    if (!botId) botId = _getBotId();
    if (getLockHolder(stationId, botId)) return false;   // occupied — don't even write
    lockChest(stationId, botId);
    const rival = getLockHolder(stationId, botId);
    if (!rival) return true;
    unlockChest(stationId, botId, 'arbitration back-off');
    return false;
}

// lockChest: reserve a station to a bot's magnet the moment it commits to using
// the chest ("as soon as the bot decides to use a chest"). Idempotent. A no-op
// when the bot holds no magnet — there is no job to own the lock, so nothing to
// release it later (would be an orphan, Law 8).
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

// registerStation: verifies an open window matches the expected block type,
// snapshots its contents, and writes the entry to corporate_headquarters.
// Optional `blueprint` parameter tags the station with its room key in
// building_confrence_room (e.g. "headframe"). A building's stations carry this
// tag so preconstruction can identify the chests that belong to the building
// being served, and so a station a POCKET set down (blueprint null) can be told
// from one a structure owns.
// Returns { ok: true, id, items } on success.
// Returns { ok: false, reason } on failure — nothing is written.
// The caller MUST have an open window (bot.currentWindow) before calling.
// ── `stance` — THE ONE CELL A BODY STANDS ON TO REACH THIS STATION ──────────────────────────────────
// Architect 2026-09-10: *"how does it work for when its in the blueprint like the headframe or the
// contract house. however that works extract as a utility and use it for both."*
//
// A BLUEPRINT STATION ALREADY HAS ONE and it is the owning anchor — authored when the blueprint was
// drawn, proven to reach every voxel in its group, the same cell on every run and from every direction
// (Law 19). A station set down in a field had none, which is why the walk-to-a-station call (then named
// `goToStationAnchor`, now `goToStationStance`) answered `no_anchor` and moved nothing: there was no
// authored cell to move TO. That is the whole of the craft regression — see `architect_bugsquashing.md`
// §11, and §12 for this fix.
//
// SO A FIELD STATION IS GIVEN THE SAME KIND OF FACT, AND IT IS NOT COMPUTED AT APPROACH TIME. He rejected
// a searched stance twice (a raycast vantage, then a radius) for the reason that a search returns
// whichever acceptable cell is cheapest from wherever the body happens to be, so the answer changes per
// approach. This is the opposite: `stance` is the cell the body WAS STANDING ON at the instant it placed
// the station, recorded once and never re-derived. It is the strongest possible evidence that the cell
// reaches the station — `canPlaceFrom` proved reach and visibility from it, and then the placement
// actually happened from it.
//
// NULL IS A REAL ANSWER, NOT A MISSING FIELD (Law 13). A row written before this existed, or a station
// somebody built by hand and the local scan happened to find, has no recorded stance. The reader must
// treat that as "no authored stance" and refuse to move, exactly as it did for every field station
// before — never as licence to guess one.
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

    // NO GUARD AGAINST OVERWRITING ANOTHER OWNER'S ROW, and its absence is the design. One was written
    // here and deleted the same day: the key carries the owner (see stationId), so the row this write
    // lands on ends with this bot's own key and cannot be anybody else's. A check for a condition the
    // key makes unformable is a redundant pathway that reads as protection while guarding nothing
    // (Law 16), and it would have to be maintained as though it did.
    const id = stationKey(pos);
    const key = require('@kernel/bot_mandate').stationOwnerKey();
    const stations = hq.readConfRoomFlag('logistics_confrence_room', 'stations', {}) || {};
    stations[id] = {
        type,
        pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        capacity,
        items,
        // owner: WHOSE SHELF THIS IS — the commons for a homesteader, the human's name for a
        // contractor. Read from this process's own mandate rather than accepted as an argument, so a
        // caller has no way to stamp a shelf for anyone else (Law 27). It is what lets one merged map
        // serve crews that must not see each other's stock: the overseer keeps one truth, and the
        // reader below can only ever form its own key.
        owner: key,
        blueprint: blueprint || null,
        // The FLOOR cell the feet rest on, matching what an anchor names, so one `goToStand` serves both
        // sources without a caller knowing which kind of station it has. `null` when nothing authored it.
        stance: stance
          ? { x: Math.floor(stance.x), y: Math.floor(stance.y), z: Math.floor(stance.z) }
          : null,
        // updated_at: the last-writer-wins key for the Phase 6 overseer merge (a station id
        // is a unique voxel, so freshest write wins). Stamped on every mutation below too.
        updated_at: Date.now(),
    };
    hq.writeConfRoomFlag('logistics_confrence_room', 'stations', stations);
    watcher.summary(TAG, `registered ${type} at (${pos.x},${pos.y},${pos.z}) id=${id} window=${windowType} items=${items.length} blueprint=${blueprint || 'none'}`);
    return { ok: true, id, items };
}

// ── TOMBSTONES: A REMOVAL IS A FACT, NOT AN ABSENCE ──────────────────────────────────────────────────
// A removed station stays in the map as a row carrying `removed_at`, and every reader and mutator below
// treats such a row as no station at all. It is not bookkeeping — it is the only form a deletion can take
// that survives the fleet's merge, and without it the deletion silently could not happen at all:
//
//   removeStation deleted the key locally. sendUpdate then shipped the map MINUS that key, and both merges
//   (overseer_server.mergeStationsInto and corporate_headquarters.mergeBroadcastStations) iterate the
//   INCOMING entries only — so an absent key is "no news", never "gone". The overseer's merged map kept the
//   dead station forever and reinstalled it on the next broadcast, on every bot, including the one that had
//   just struck it. Measured: one furnace voxel struck and restored 89 times on one bot and 53 on its
//   partner inside a single run, while the world held air at that cell throughout.
//
// The tombstone converts the removal into an ordinary write the existing last-writer-wins key already
// carries (`updated_at`), so it propagates by exactly the pathway a registration does — no second channel
// and no message type (Law 16). It is the same principle the standing-requests broadcast states about the
// empty map: what the authority authored is a fact, and only an authored fact can overwrite a memory
// (Invariant B — fresh sensing must be able to beat what a peer remembers).
//
// A tombstone never blocks a genuine re-registration: registerStation writes the row whole with a newer
// stamp and wins everywhere by the same rule. Unbounded growth is not a concern — the map is keyed by
// station voxel, and it is released at every run start like all run state.
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

// setSmeltState / getSmeltState / clearSmeltState (Phase 3 async furnace): the furnace's
// in-flight order rides ON its station entry (Law 6 — inspectable, and it survives a crash
// because the entry is flushed to disk). State shape: { order, qty, input, fuel, started_at,
// locked_by }. Kept beside `items` so job_board can read completion without opening the
// window; the real furnace window is still ground truth on collect (Law 13). Stamps
// updated_at so the load propagates to peers via the Phase 6 merge.
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

// Already-tombstoned returns false, and that is what stops the churn rather than merely hiding it: a
// re-stamped tombstone every sweep would keep freshening updated_at and keep the "removed" line coming.
// The caller (verifyAgainstWorld) counts this return, so a station is reported struck exactly once.
//
// The row keeps `pos`, `type` and `owner`. Not sentiment — the merge and the owner gate both key on them,
// and a tombstone that could not be attributed to an owner would be a row no reader could place.
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

// getStations: the station map as seen by `viewerBotId`. A chest another bot
// has locked is INCLUDED, stamped `locked_by: <botId>` — its last snapshot
// stays visible so any calculation can count it; the wait-to-act rule is
// enforced at the single chest-interaction pathway (inventory_swapper), not by
// hiding state here (Law 6: transparent state). Pass viewerBotId === null for
// the raw, unstamped map (internal write/registration paths). Single-bot: no
// peers, no stamps — inert.
// TOMBSTONES ARE FILTERED HERE, ahead of the owner gate and on BOTH branches including the raw one. A
// removed row is not a station belonging to nobody — it is not a station, for any reader, which is why the
// filter sits at the single door every read comes through rather than at each caller (same placement
// argument as the owner gate below). verifyAgainstWorld reads through here too, so a struck voxel is never
// re-tested against the world and the sweep stops re-reporting it.
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

// THE OWNER GATE, AND THE ONLY ONE. Every read of the station map — findChests, findStation,
// getStationTypes, stationUsable, the material pool — reaches it through getStations, so the filter
// lands here once and no consumer above can forget it. Placed at the READER rather than the writer:
// the overseer keeps ONE unified map so accountability for what is true stays in one place, and a bot
// narrows it to its own shelves using the only key it can form (Law 27, Invariant D — the overseer owns
// the fact, the bot owns whether it cares).
//
// This is not the lock rule and must not be confused with it: a chest locked by a PEER stays visible and
// stamped, because a peer shares your shelves and any calculation may still count what is on them. A
// chest belonging to ANOTHER OWNER is absent, because it was never yours to count.
//
// An entry with no `owner` is the commons. Not a default filling in a missing field (Law 13 forbids
// that) — the owner axis postdates every station written without it, and no contractor could own a
// chest before contractors could own anything, so `homesteader` is that entry's true value rather than
// a guess at it. Deletable once no pre-axis map can be loaded.
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

// A station a bot may legitimately SET DOWN out of its pocket, use, and take back up. The set is the
// whole of the rule, and a furnace's absence from it is the point.
//
// WHY A TABLE AND NOT A FURNACE: a craft is instantaneous and wholly consumed by the body performing it,
// so a table set down and picked back up hands nothing to anybody and leaves nothing behind. A COOK
// outlives the visit and belongs to the FLEET — it is sized from every bot's demand, so whoever empties
// it is usually not whoever asked for the output, and the emptier has to bank a peer's share in a chest
// (output cannot go back into the furnace). A furnace on open ground has no chest coupled to it, so its
// batch is unshareable by construction. The furnace and the chest are one two-part fitting; the only
// furnace this fleet uses stands in a placed blueprint that also carries a chest.
//
// A POCKETED FURNACE IS BUILD MATERIAL, NOT A STATION, and that is the false positive this set closes:
// with no `furnace` stock row left, the only reason a bot carries one is that it is walking that block
// to a blueprint's anchor. Counting it here would tell a craft gate a furnace is usable on the strength
// of a block that is spoken for and about to be placed somewhere else entirely.
const POCKET_PLACEABLE_STATIONS = new Set(['crafting_table']);

// CAN A CRAFT USE THIS STATION RIGHT NOW — the union of both ways it can be true, in one place.
//
// TWO ROUTES, AND BOTH ARE REAL FOR A POCKET-PLACEABLE STATION: it STANDS (registered here, walk to it),
// or one is IN THE POCKET. Asking only the registry holds a bot that is carrying the answer; asking only
// the pocket sends it to craft a second table beside one already standing. For everything else the
// registry is the sole authority.
//
// WHY IT IS HERE RATHER THAN AT EITHER CALLER: the gate that decides whether a supply job may be
// offered and the fulfiller that asserts one was never offered unstationed must return the SAME verdict
// about the same world. Written twice, the fulfiller's assertion fires on jobs the gate deliberately
// let through — a crash caused by the two copies disagreeing rather than by the fault it guards. This
// module already owns the standing half, so the union belongs with it (Law 16).
//
// The inventory is passed rather than read so the caller's own freshly-sensed snapshot is the one
// measured (Invariant B) — a second read here could disagree with the pocket the caller is reasoning
// about within the same sweep.
function stationUsable(stationType, inventory) {
    if (POCKET_PLACEABLE_STATIONS.has(stationType) && (inventory?.[stationType] || 0) > 0) return true;
    return getStationTypes().has(stationType);
}

// findStation — one station of this type, A BLUEPRINT'S BEFORE A FIELD ONE.
//
// THE ORDER IS THE WHOLE FUNCTION, and it exists because a field crafting table is permanent now
// (Architect 2026-09-07: *"placing a crafting table is a permanent thing… once it builds the contractor
// house then it will prefer that one"*). Field tables accumulate, they are registered before the house
// is built, and object insertion order would hand the caller whichever one was set down first — so the
// house's own table would never be chosen while an older field table stood anywhere in the world.
//
// WHAT MAKES THE PREFERENCE REAL AND NOT COSMETIC: a `blueprint` tag means the station sits in a locked
// structure, which is what gives it an authored stance (resolveVoxelAnchor). The caller can therefore
// WALK to it from anywhere. A field station has no anchor by design, so a caller that cannot already
// reach it falls through and sets down its own — which is the "otherwise, drop again" half of the same
// ruling, and it follows from the anchor rather than needing a rule of its own.
//
// NOT SORTED BY DISTANCE, deliberately: this file records voxels, not the body's position, and a
// distance question belongs to the caller that holds the body.
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

// stationAt(pos) — THE ROW FOR ONE VOXEL, or null. Asked by `locomotion.goToStationStance` for one field
// only: whether a placement stance was recorded for this station (see `registerStation`'s `stance` note).
//
// IT GOES THROUGH `getStations()` LIKE EVERY OTHER READER rather than indexing the raw map, because that
// is where the viewer filter and the tombstone filter live — a reader that reached past it would answer
// from another crew's shelf, or hand back a station that has been removed (Law 16, one pathway in).
function stationAt(pos) {
    const id = stationKey(pos);
    const stations = getStations();
    return stations[id] || null;
}

// findChests: every registered chest, as { id, ...entry }. THE one door to "where can material go or
// come from" — replaces `findStationsByRole`, whose callers all wanted a chest and had to name a role to
// get one. `findStationsByRole('buffer')` returning nothing was how a missing role tag disabled dumping
// silently; a question with no role in it cannot fail that way.
function findChests() {
    const stations = getStations();
    const results = [];
    for (const [id, entry] of Object.entries(stations)) {
        if (entry && entry.type === 'chest') results.push({ id, ...entry });
    }
    return results;
}

// `determineChestRole` IS DELETED, and nothing replaces it. It read RESOURCE_REQUIREMENTS (also deleted)
// to stamp each newly-placed chest with a role and a number. There are no roles and no numbers — see the
// header. Do not restore it to "know which chest is which": the fleet's storage is one pool and every
// consumer measures it as one.

// verifyAgainstWorld: confirm every registered station's voxel still holds the
// expected block, dropping entries the world no longer backs. A station ID is a
// world voxel, so the map must be re-sensed each sweep (Law 6/Law 13) — otherwise
// a dug-up chest keeps crediting supply. Runs off the raw map (viewerBotId=null)
// so locked chests are verified too. Three outcomes per entry:
//   right block            → keep.
//   wrong block / air       → removeStation (the chest is gone).
//   blockAt null (chunk NOT loaded) → keep — we cannot prove it's gone, and dropping
//                          every far station on unload would be a bug. Verify only what we see.
// Owned here, not in the brain (job_board): the registry mutates its own state; the
// planner only reads it.
function verifyAgainstWorld(bot) {
    if (!bot || !bot.blockAt) return;
    // OWN SHELVES ONLY, and this is a write path, which is why. Verification DELETES entries, so running
    // it on the raw map would have every bot correcting every other owner's record — the many-writers
    // fault the owner axis exists to end (Invariant D). A foreign chest that is genuinely gone is not
    // lost by skipping it: the crew that owns it is the crew that will try to use it, and the read at
    // that moment answers that the block is not a container.
    // Locked chests are still verified — a peer's lock marks an entry, it does not remove it from a
    // viewer's map, which is why dropping the raw read costs nothing here.
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
    // One aggregated warn per sweep, not one per stale station: the sweep is a single
    // phase of work, so its warnings accumulate-then-post like the summary below (Law 5).
    // Per-station warns were per-step noise that duplicated this and tripped warn-burst;
    // detail (which station, what the world now holds) is preserved in the join.
    if (removed) {
        watcher.warn(TAG, `removed ${removed} stale station(s): ${staleDetails.join('; ')}`);
    }
    if (verified || removed || unloaded) {
        watcher.summary(TAG, `stations: verified ${verified}, removed ${removed} stale, ${unloaded} unloaded (kept)`);
    }
}

// logContents: post every chest/furnace's contents to the Watcher — the station
// census. Belongs here, not the job board: the registry knows its own stations,
// so reporting what they hold is its job. A chest is named by its blueprint, not
// by a role — there are none. Locked chests are included with their last snapshot
// + a 🔒 tag (the holder refreshes on close).
// Uses the viewer-stamped map so lock tags show.
function logContents() {
    const stations = getStations();
    const emptyStations = [];
    for (const [id, entry] of Object.entries(stations)) {
        if (!entry || !entry.pos) continue;
        if (entry.type !== 'chest' && entry.type !== 'furnace') continue;
        const items = (entry.items || []).filter(it => it && it.count > 0);
        // The blueprint tag, and no role: it is the one distinction still real — a station a STRUCTURE
        // owns versus one a pocket set down — and it is what tells a reader whether a chest is part of a
        // built base or a stray.
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

module.exports = { posId, stationKey, openProofWindow, registerStation, snapshotStation, removeStation, getStations, getStationTypes, stationUsable, findStation, stationAt, findChests, lockChest, unlockChest, getLockHolder, acquireChestLock, setSmeltState, getSmeltState, clearSmeltState, verifyAgainstWorld, logContents };
