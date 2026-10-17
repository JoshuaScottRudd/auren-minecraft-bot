// Law 15 API — depositItems, retrieveItems and dumpExcess handle chest interaction: select a chest,
// navigate there, open it, transfer items, snapshot contents, update station_registry, and close.
// dumpExcess reads INVENTORY_WHITELIST from job_board and dumps everything not whitelisted to keep.
// Called directly by preconstruction, build_executor, delivery_executor, supply_manager,
// furnace_executor, and any fragment that needs chest deposit/withdrawal. No signal-bus entry.
//
// Every chest is interchangeable in role; the pool is ordered by chest NUMBER (station_registry.chestNumbers).
// Nested API (Law 15): calls the locomotion API to reach chests; an unreachable chest abandons the
// caller, originating a fresh signal to recursive_judge.
// Invariants: depositItems/retrieveItems throw only on coding violations (missing bot), every other
// outcome is environmental (Law 13 + Law 15). A deposit tops an existing part stack of its item first,
// then fills the lowest-numbered chest with room, with that room claimed before the walk
// (chest_ledger.claimRoom); what does not fit goes on to the next chest. A withdrawal draws from the
// highest-numbered chest holding the item, capped at what no other body has claimed. NO LOCK AND NO
// QUEUE: any number of bodies open one chest and act in it at once, and the claims are what keep them
// apart. A body says which chest it is using before it walks (station_registry.claimSpot); that spot is
// read only to know whether a peer may be moving the chest under this body's window.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const stationRegistry = require('@perception/station_registry');
const { group_to_item, substitutes_for, furnace_chain_items } = require('@utils/fragment_utils');
// The members a token stands for when a chest is counted, filled or emptied: countInInventory's own rule (Law 16) —
// a group token is its members, and a smelted item is only itself ('stone' the block, never granite or diorite).
function _groupOf(token) {
    return (token && !furnace_chain_items.has(token) && Array.isArray(group_to_item[token])) ? group_to_item[token] : null;
}
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');

const TAG = 'inventory_swapper';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ceiling for the server to hand over a window (past it the open is a refusal), and for an opened window's
// contents to arrive and match the chest's last picture (past it the record and the world disagree, which
// is a defect, Law 13). Both are polled, never slept in full.
const CONTENTS_ARRIVAL_MS = 5000;
// The server sends its time once a second; a gap past this is a server that is not ticking.
const SERVER_HEARD_WITHIN_MS = 1500;
const WINDOW_POLL_MS = 10;   // poll rate for a window or its contents to arrive
// A peer's part take holds its whole stack in its pocket until the surplus goes back, so a stack can be out
// of the chest for a few hundred milliseconds. A withdrawal that finds none waits this long for it once.
const PEER_RETURN_MS = 500;
// Three server ticks after a stack-moving click (pick up, drop, halve, shift-click). One tick let a
// halve-and-drop pair outrun the server: the client showed the stack in the chest, the server kept it in
// the pocket, and the picture recorded a deposit that never landed.
const TRANSFER_DELAY_MS = 150;
const CLOSE_SETTLE_MS = 80;
const MAX_CLOSE_TRIES = 8;
// A window the server did not hand over is asked for again this many times. The server never refuses a
// second opener, so a missing window is lag or a moved block, never a peer.
const OPEN_TRIES = 3;
const OPEN_RETRY_MS = 250;
// Rounds of the deposit fallback: each round re-plans what did not fit, skipping the chests already tried.
const DEPOSIT_MAX_ROUNDS = 6;

// ---------------------------------------------------------------------------
// SECTION 1 — Station selection
// ---------------------------------------------------------------------------

function _parsePos(posId) {
    const [x, y, z] = posId.split('|').map(Number);
    return { x, y, z };
}

// ── THE CHESTS FILL IN NUMBER ORDER, AND A PART STACK IS TOPPED BEFORE A SLOT IS STARTED ──────────────────
// A deposit tops every part stack of its item first, lowest number first, wherever the stack sits: a stack of
// 23 in chest 2 is filled before chest 1 gets a fresh slot. What is left takes fresh slots in the
// lowest-numbered chest with room. Withdrawals draw from the highest number, so stock consolidates toward
// chest 1. Room is the chest's picture less the fresh slots other depositors have claimed
// (chest_ledger.reservedSlotsAt), so two bodies never walk to the same last slot.
function _stackSizeOf(item) {
    const def = global.bot && global.bot.registry && global.bot.registry.itemsByName && global.bot.registry.itemsByName[item];
    return (def && def.stackSize) || 64;
}

// Room for `item` at one numbered chest: the headroom inside its part stacks of the item, and its fresh
// slots after other bodies' claims and `takenSlots` this plan already spent there.
function _roomAt(chest, item, takenSlots) {
    const items = Array.isArray(chest.items) ? chest.items : [];
    const size = _stackSizeOf(item);
    const headroom = items.reduce((n, i) => n + ((i.name === item && (i.count || 0) < size) ? size - (i.count || 0) : 0), 0);
    const reserved = require('@perception/chest_ledger').reservedSlotsAt(chest.id);
    const freeSlots = Math.max(0, (chest.capacity || 27) - items.length - reserved - takenSlots);
    return { headroom, freeSlots, size };
}

// The storage chests as numbered rows, ascending, less any in `exclude`.
function _numberedChests(stations, exclude) {
    const numbers = stationRegistry.chestNumbers();
    return Object.entries(stations)
        .filter(([id, e]) => stationRegistry.isStorage(e) && numbers.has(id) && !(exclude && exclude.has(id)))
        .map(([id, e]) => ({ id, ...e, number: numbers.get(id) }))
        .sort((a, b) => a.number - b.number);
}

// _planDeposits(stations, wants {item: n}, exclude) → { rows: [{station, number, item, amount, slots}]
// ascending by number, unplaced: {item: n} } — where every unit goes, and the fresh slots each row claims.
function _planDeposits(stations, wants, exclude = null) {
    const chests = _numberedChests(stations, exclude);
    const taken = new Map();      // chest id → fresh slots this plan already uses
    const topped = new Map();     // `${id}|${item}` → part-stack headroom this plan already uses
    const rows = [];
    const unplaced = {};
    const add = (chest, item, amount, slots) => {
        const row = rows.find(r => r.station === chest.id && r.item === item);
        if (row) { row.amount += amount; row.slots += slots; return; }
        rows.push({ station: chest.id, number: chest.number, item, amount, slots });
    };
    for (const [item, want] of Object.entries(wants)) {
        let left = want;
        for (const chest of chests) {
            if (left <= 0) break;
            const k = `${chest.id}|${item}`;
            const head = _roomAt(chest, item, 0).headroom - (topped.get(k) || 0);
            if (head <= 0) continue;
            const n = Math.min(left, head);
            topped.set(k, (topped.get(k) || 0) + n);
            add(chest, item, n, 0);
            left -= n;
        }
        for (const chest of chests) {
            if (left <= 0) break;
            const room = _roomAt(chest, item, taken.get(chest.id) || 0);
            if (room.freeSlots <= 0) continue;
            const n = Math.min(left, room.freeSlots * room.size);
            const slots = Math.ceil(n / room.size);
            taken.set(chest.id, (taken.get(chest.id) || 0) + slots);
            add(chest, item, n, slots);
            left -= n;
        }
        if (left > 0) unplaced[item] = left;
    }
    rows.sort((a, b) => a.number - b.number);
    return { rows, unplaced };
}

// The members a retrieve of `item` may take: the order's own `only` list when it carries one (a furnace's
// allowed inputs), else the group's.
function _retrieveVariants(item, only) {
    return Array.isArray(only) ? only : _groupOf(item);
}

// A withdrawal takes no more than the pool holds unclaimed by other bodies (chest_ledger): the claim a cube
// trip files binds every withdrawer here, whether or not its job read the ledger. This body's own claim
// is not counted against it.
function _unclaimedFor(item, only) {
    const names = [...new Set([item, ...(_retrieveVariants(item, only) || [])])];
    return require('@perception/chest_ledger').unclaimedOf(names);
}

// Retrieve: the highest-numbered chest holding the item, whoever else is using it.
function _selectRetrieveTarget(stations, item, only = null) {
    const variants = _retrieveVariants(item, only);
    const holding = _numberedChests(stations, null).filter(c => Array.isArray(c.items)
        && c.items.some(i => i.name === item || (variants && variants.includes(i.name))));
    return holding.length ? holding[holding.length - 1] : null;
}

// No chest→chest courier: retrieveItems and depositItems/dumpExcess are the only chest movements, and
// both cross the pocket boundary — a `storage` figure is measured across every chest at once (Law 25).

// ---------------------------------------------------------------------------
// SECTION 2 — Window management
// ---------------------------------------------------------------------------

// Polls for the window instead of sleeping a fixed delay before checking (Invariant B).
// ── A WINDOW IS OPEN WHEN ITS SLOTS HAVE ARRIVED, NOT WHEN IT EXISTS ─────────────────────────────────
// mineflayer sets `bot.currentWindow` on the open packet and fills its slots on the next one, emitting
// `windowOpen` only then. Reading the window at the first moment sees an empty chest and an empty pocket,
// and the transfer moves nothing through a window the queue already paid for — so the wait is for the
// `windowOpen` event, listened for before the click so it cannot be missed.
// A chest that never opens (no window by CONTENTS_ARRIVAL_MS) is asked again (OPEN_TRIES); a window that
// opened is owed its slots within the same ceiling.
async function _openWindow(bot, pos, stationId) {
    const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) return { ok: false, reason: 'block_not_found' };
    let ready = null;
    const onOpen = (w) => { ready = w; };
    bot.once('windowOpen', onOpen);
    const clickedAt = Date.now();
    await bot.activateBlock(block);
    // Every activation is answered before another is sent: a slow server answers late, and a second
    // activation then opens the chest twice — the server closes the first window and opens a second, and
    // this body would work in the dead one. Only no answer for the whole CONTENTS_ARRIVAL_MS is a refusal,
    // and that clock runs only while the server is ticking: a server that is silent has not refused, and
    // it answers this activation when it comes back.
    const pulse = require('@kernel/server_pulse');
    let heardMs = 0;
    let polledAt = clickedAt;
    while (!ready) {
        const now = Date.now();
        if (pulse.silentMs() < SERVER_HEARD_WITHIN_MS) heardMs += now - polledAt;
        polledAt = now;
        if (heardMs >= CONTENTS_ARRIVAL_MS) break;
        await sleep(WINDOW_POLL_MS);
    }
    bot.removeListener('windowOpen', onOpen);
    if (ready) return { ok: true, window: ready, clickedAt };
    if (!bot.currentWindow) return { ok: false, reason: 'no_window' };
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): chest ${stationId} opened a window but its slots never `
        + `arrived within ${CONTENTS_ARRIVAL_MS}ms.`);
}

// ── THE LAST BODY OUT PHOTOGRAPHS THE CHEST; THE NEXT BODY IN WAITS FOR THAT PICTURE ──────────────────
// Every window closes on a snapshot of the container (snapshotStation), sent to the fleet with the spot's
// release in one update. When no peer's spot is this chest, nothing else can be moving it, so the window
// must match the newest picture: the body acts the moment it does, and a window still disagreeing after
// CONTENTS_ARRIVAL_MS means the record and the world have split (Law 13). The picture is re-read on every
// poll, since the last body's picture can arrive a moment late. With a peer's spot on the chest, the chest
// is legitimately moving under the window and the window itself is the contents.
function _tally(items) {
    const t = {};
    for (const i of items || []) t[i.name] = (t[i.name] || 0) + (i.count || 0);
    return t;
}
function _sameTally(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) return false;
    return true;
}
function _describeTally(t) {
    return Object.entries(t).map(([n, c]) => `${n} x${c}`).join(', ') || 'empty';
}
// ── EACH CHEST IS FORGIVEN ONE MISMATCH PER RUN ───────────────────────────────────────────────────────
// A run can end while a body has a chest open, before the picture or the world is saved, so the next run
// finds the two apart. A chest that opened a window is forgiven that once: the window is taken as the
// chest's contents (Invariant B) and the picture is rewritten from it.
// The foreman counts the one — its 'chest_forgiveness:' key is spent, never held — so a second mismatch
// on the same chest in the same run is the defect it always was. A body with no foreman is the whole
// fleet, and the chests it has itself been forgiven are the count.
const _forgivenHere = new Set();
async function _spendForgiveness(stationId) {
    if (_forgivenHere.has(stationId)) return false;
    const link = require('@kernel/foreman_link');
    const key = `chest_forgiveness:${stationId}`;
    const grant = await link.requestClaim(key);
    if (!grant.granted) return false;
    link.releaseClaim(key);   // out of this body's chair; the foreman keeps it spent
    _forgivenHere.add(stationId);
    return true;
}

// → { ms, forgiven }: how long the window took to match the newest picture, or that it never did and was
// forgiven. `ms` runs from `since`, the moment this body could first act on the window.
async function _awaitPicture(win, stationId, since) {
    const pictureNow = () => {
        const row = stationRegistry.getStations()[stationId];
        return (row && Array.isArray(row.items)) ? row.items : [];
    };
    let want = _tally(pictureNow());
    const arrivedAt = Date.now();
    while (!_sameTally(_tally(_snapshotItems(win)), want)) {
        want = _tally(pictureNow());
        // A peer that came to this chest after the window opened may already be moving it.
        if (stationRegistry.spotHolders(stationId).length) return { ms: Date.now() - since, forgiven: false, peer: true };
        if (Date.now() - arrivedAt >= CONTENTS_ARRIVAL_MS) {
            const seen = _snapshotItems(win);
            const apart = `picture [${_describeTally(want)}], window [${_describeTally(_tally(seen))}]`;
            if (!(await _spendForgiveness(stationId))) {
                throw new Error(`[${TAG}] CODING VIOLATION (Law 13): chest ${stationId} did not match its last `
                    + `picture within ${CONTENTS_ARRIVAL_MS}ms, and its one forgiveness for this run is already `
                    + `spent — ${apart}.`);
            }
            stationRegistry.snapshotStation(stationId, seen);
            watcher.warn(TAG, `CHEST PICTURE FORGIVEN — chest ${stationId} did not match its last picture within `
                + `${CONTENTS_ARRIVAL_MS}ms: ${apart}. The window is taken as the chest's contents and the picture `
                + `is rewritten from it. This chest's one forgiveness for this run is now spent.`);
            return { ms: Date.now() - since, forgiven: true };
        }
        await sleep(WINDOW_POLL_MS);
    }
    return { ms: Date.now() - since, forgiven: false };
}

async function _closeWindow(bot) {
    if (!bot || !bot.currentWindow) return;
    // The close request is fire-and-forget; the settle loop below is the actual measurement, reading
    // bot.currentWindow instead of trusting the call (Invariant B).
    if (typeof bot.closeWindow === 'function') {
        guardExternalSync(TAG, 'closeWindow', () => bot.closeWindow(bot.currentWindow));
    }
    // Polled at a tick rather than slept in full; the ceiling is MAX_CLOSE_TRIES × CLOSE_SETTLE_MS.
    const closeBy = Date.now() + MAX_CLOSE_TRIES * CLOSE_SETTLE_MS;
    while (bot.currentWindow && Date.now() < closeBy) await sleep(WINDOW_POLL_MS);
}

// ── THE TRANSFER AUDIT: BOTH SIDES OF ONE WINDOW, WRITTEN DOWN ────────────────────────────────────────
// A click is applied to the window at once (mineflayer predicts it) and then sent with the slots it changed.
// The server applies it and sends back only the slots where its result differs from what the client
// reported, so an accepted click draws no packet and a refused one draws a correction (set_slot or a
// window_items resync). The audit records both sides: every click with the slot it predicted before and
// after, every packet the server sent for the window, and the pocket before the open and at the close.
// It names a window the server corrected after its picture matched (container or pocket slots), or
// whose pocket at the close did not change by what the window said moved.
// A CORRECTION IS NOT A FAULT: every transfer here is a shift-click, and mineflayer's guess of a shift-click
// is routinely wrong (see _shiftClick), so the server correcting the window is the ordinary answer to a
// wrong guess and is written on the audit line. The fault is the pocket at the close not having changed by
// what the window says moved, because that is material appearing or vanishing. The server's container is
// rebuilt from its packets alone, so it misses every slot where mineflayer guessed right; it is printed for
// reading and decides nothing.
// A CONTENDED window (a peer's spot was this chest while it was open) has the chest moving under it, so
// the window's change is two bodies' work and the pocket cannot be checked against it. The item book's
// pocket audits (every 30 s, off the body's own reading) and the container check at the next uncontended
// window are what catch material appearing or vanishing there.
// The pocket is read at the close itself, before this body can act again, so the next craft or place
// never lands inside the reading. The server's word on the window is still heard this long after the
// close, since a correction for the last click can be in flight; packets for this window id are the
// only ones counted, and no later work uses that id.
const AUDIT_POCKET_SETTLE_MS = 250;
let _activeAudit = null;
let _pendingPocketCheck = null;   // the last window's verdict, owed until the server's word has settled
function _slotDesc(it) { return it ? `${it.name}x${it.count}` : '-'; }
function _pocketTally(bot) { return _tally(bot.inventory.items()); }
function _startAudit(bot) {
    if (_pendingPocketCheck) _pendingPocketCheck();
    const Item = require('prismarine-item')(bot.registry);
    const audit = { clicks: [], packets: [], pocketBefore: _pocketTally(bot), winId: null, containerEnd: null, atOpen: null };
    const fromNotch = (n) => {
        const r = guardExternalSync(TAG, 'prismarine-item fromNotch', () => Item.fromNotch(n));
        return r.ok ? r.value : { name: `undecodable(${r.reason})`, count: 0 };
    };
    audit.onItems = (p) => audit.packets.push({ t: Date.now(), kind: 'window_items', windowId: p.windowId, stateId: p.stateId, items: (p.items || []).map(fromNotch) });
    audit.onSlot = (p) => audit.packets.push({ t: Date.now(), kind: 'set_slot', windowId: p.windowId, stateId: p.stateId, slot: p.slot, item: fromNotch(p.item) });
    audit.onOpen = (p) => audit.packets.push({ t: Date.now(), kind: 'open_window', windowId: p.windowId });
    audit.onClose = (p) => audit.packets.push({ t: Date.now(), kind: 'close_window', windowId: p.windowId });
    bot._client.on('window_items', audit.onItems);
    bot._client.on('set_slot', audit.onSlot);
    bot._client.on('open_window', audit.onOpen);
    bot._client.on('close_window', audit.onClose);
    _activeAudit = audit;
    return audit;
}
function _stopAudit(bot, audit) {
    if (audit.reported) return;   // a reported audit keeps listening until its verdict settles
    _releaseAudit(bot, audit);
}
function _releaseAudit(bot, audit) {
    bot._client.removeListener('window_items', audit.onItems);
    bot._client.removeListener('set_slot', audit.onSlot);
    bot._client.removeListener('open_window', audit.onOpen);
    bot._client.removeListener('close_window', audit.onClose);
    if (_activeAudit === audit) _activeAudit = null;
}
// The container as the server last described it: its last full window_items, then every set_slot after it.
function _serverContainer(audit) {
    let slots = null;
    for (const p of audit.packets) {
        if (p.windowId !== audit.winId) continue;
        if (p.kind === 'window_items') slots = p.items.slice(0, audit.containerEnd);
        else if (slots && p.slot >= 0 && p.slot < audit.containerEnd) slots[p.slot] = p.item;
    }
    return slots ? _tally(slots.filter(Boolean)) : null;
}
function _tallyDelta(before, after) {
    const d = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const n = (after[k] || 0) - (before[k] || 0);
        if (n) d[k] = n;
    }
    return d;
}
function _describeDelta(d) { return Object.entries(d).map(([n, c]) => `${n} ${c > 0 ? '+' : ''}${c}`).join(', ') || 'none'; }
function _reportAudit(bot, audit, stationId, orderType, picture, contendedNow) {
    const pictureTally = _tally(picture);
    const containerDelta = _tallyDelta(audit.atOpen || {}, pictureTally);
    const expectedPocket = {};
    for (const [k, n] of Object.entries(containerDelta)) expectedPocket[k] = -n;
    const pocketAtClose = _pocketTally(bot);
    const actual = {};
    for (const k of Object.keys(expectedPocket)) actual[k] = (pocketAtClose[k] || 0) - (audit.pocketBefore[k] || 0);
    const pocketAgrees = Object.keys(expectedPocket).every(k => actual[k] === expectedPocket[k]);
    const clicks = audit.clicks.map(c => `+${c.t - audit.openedAt}ms ${c.slot}/b${c.button}m${c.mode}:${c.before}→${c.after}${c.cursor !== '-' ? ` held ${c.cursor}` : ''}${c.swapped || ''}`).join(' ');
    audit.closedAt = Date.now();
    audit.reported = true;
    _activeAudit = null;
    let settled = false;
    const check = () => {
        if (settled) return;
        settled = true;
        if (_pendingPocketCheck === check) _pendingPocketCheck = null;
        _releaseAudit(bot, audit);
        const contended = contendedNow();   // asked at the verdict, not at the close (see _executeTransfer)
        const server = _serverContainer(audit);
        const winPackets = audit.packets.filter(p => p.windowId === audit.winId && (p.kind === 'window_items' || p.kind === 'set_slot'));
        const corrections = winPackets.filter(p => p.t > audit.readyAt);
        const pocketCorrections = corrections.filter(p => p.kind === 'window_items' || p.slot >= audit.containerEnd);
        const heardMs = Date.now() - audit.closedAt;
        const packets = audit.packets.map(p => p.kind === 'open_window' || p.kind === 'close_window'
            ? `+${p.t - audit.openedAt}ms ${p.kind}(w${p.windowId})`
            : p.windowId !== audit.winId ? `+${p.t - audit.openedAt}ms ${p.kind}(w${p.windowId})${p.kind === 'set_slot' ? ` slot${p.slot}=${_slotDesc(p.item)}` : ''}`
            : p.kind === 'window_items'
            ? `+${p.t - audit.openedAt}ms items#${p.stateId}[${_describeTally(_tally(p.items.slice(0, audit.containerEnd).filter(Boolean)))}]`
            : `+${p.t - audit.openedAt}ms slot${p.slot}#${p.stateId}=${_slotDesc(p.item)}`).join(' ');
        const line = `transfer audit ${orderType} ${stationId} window#${audit.winId}${contended ? ' (contended)' : ''}: `
            + `at open [${_describeTally(audit.atOpen || {})}] · picture written [${_describeTally(pictureTally)}] · `
            + `server's last word [${server ? _describeTally(server) : 'no container packet'}] · `
            + `pocket change expected [${_describeDelta(expectedPocket)}] at the close [${_describeDelta(actual)}] · picture matched at +${audit.readyAt - audit.openedAt}ms · `
            + `clicks ${audit.clicks.length} {${clicks}} · server packets ${winPackets.length}, ${corrections.length} after the picture matched `
            + `(${pocketCorrections.length} touching the pocket), heard until ${heardMs}ms after the close {${packets}}`;
        const faults = [];
        if (!contended && !pocketAgrees) faults.push('the pocket at the close did not change by what the window said moved');
        if (faults.length) watcher.warn(TAG, `TRANSFER AUDIT MISMATCH — ${faults.join(' and ')}. ${line}`);
        else watcher.summary(TAG, line);
    };
    _pendingPocketCheck = check;
    setTimeout(check, AUDIT_POCKET_SETTLE_MS);
}

function _snapshotItems(win) {
    const total = win.slots.length;
    const containerEnd = Math.max(0, total - 36);
    const items = [];
    for (let i = 0; i < containerEnd; i++) {
        const it = win.slots[i];
        if (!it) continue;
        items.push({ name: it.name, count: it.count });
    }
    return items;
}

// ---------------------------------------------------------------------------
// SECTION 3 — Item transfer
//
// ── EVERY CROSSING OF THE WINDOW IS ONE SHIFT-CLICK; EVERY SPLIT HAPPENS IN THE POCKET ───────────────────
// No lock keeps peers out of a chest, so any number of bodies click in one chest at once. The server applies
// clicks one at a time, and a shift-click is one click that moves a whole stack across in a single step, so
// nothing can come between its start and its end. A stack held on the cursor can: lifting a chest stack
// to take part of it leaves its slot empty, a peer can deposit a different item there, and putting the
// rest back swaps the two. So no chest stack is ever held on the cursor here. A part of a stack is cut in
// the POCKET, which is this body's alone (_splitInPocket), and crosses with one shift-click:
//   deposit n of a bigger stack   → split n off in the pocket, shift-click that slot into the chest
//   take n of a bigger stack      → shift-click the whole stack into the pocket, split off the surplus,
//                                   shift-click the surplus back
// Every move is measured off the pocket, never off a chest slot a peer may be moving.
//
// Law 13 here: what this body's own pocket shows is this body's doing alone. A pocket that changes by more
// than a click could move, a split that does not land, or a cursor left holding a stack at the end is a
// defect in this file and stops the run. A short move (a full chest, a stack a peer took first) is the
// world, and is reported and worked around.
// ---------------------------------------------------------------------------

// mineflayer's clickWindow(slot, button, mode) is a promise that resolves once the click is applied to the
// window; it takes no callback.
async function _click(bot, slot, button, mode) {
    const win = bot.currentWindow;
    const before = win ? _slotDesc(win.slots[slot]) : '?';
    const sentAt = Date.now();
    await guardExternal(TAG, `clickWindow slot ${slot}`, () => bot.clickWindow(slot, button, mode));
    if (_activeAudit && win) {
        const now = bot.currentWindow;
        _activeAudit.clicks.push({ t: sentAt, slot, button, mode, before, after: _slotDesc(win.slots[slot]), cursor: _slotDesc(win.selectedItem),
            swapped: now !== win ? ` window swapped w${win.id}→w${now ? now.id : 'none'}` : '' });
    }
}

function _findEmpty(win, start, end) {
    for (let i = start; i < end; i++) {
        if (!win.slots[i]) return i;
    }
    return -1;
}

// The bounds of a window: the container's slots, then the pocket's 36.
function _bounds(win) {
    const total = win.slots.length;
    return { containerEnd: Math.max(0, total - 36), total };
}

// How many of `names` the pocket holds, as the window shows it.
function _pocketCount(win, names) {
    const { containerEnd, total } = _bounds(win);
    let n = 0;
    for (let i = containerEnd; i < total; i++) {
        const it = win.slots[i];
        if (it && names.includes(it.name)) n += it.count;
    }
    return n;
}

// Waits until `ok()` holds, polled at a tick for up to `ms` — a click's result can take a server answer to
// show. → true when it held.
async function _settle(ok, ms = 1000) {
    const by = Date.now() + ms;
    while (!ok()) {
        if (Date.now() >= by) return false;
        await sleep(WINDOW_POLL_MS);
    }
    return true;
}

// A shift-click on one slot, and what it moved of `name`, read off the pocket: `out` is how many left the
// pocket (a pocket slot clicked), `in` how many arrived (a chest slot clicked).
// ── A SHIFT-CLICK IS MEASURED ON THE SERVER'S WORD, NOT MINEFLAYER'S GUESS ──────────────────────────────
// mineflayer applies its own guess of a shift-click to the window at once, and the guess is often wrong: it
// moves a whole stack into a chest with no room for it, and it passes over a chest's last empty slot that
// the server then fills. The server answers a
// wrong guess with corrected slots one tick and a round trip later, and a right guess with nothing. So
// the pocket is read only after TRANSFER_DELAY_MS with the server ticking: a server silent past
// SERVER_HEARD_WITHIN_MS (a disk stall) has not answered yet, and the reading waits until it has, up to
// SHIFT_ANSWER_MS.
// A body standing at a chest can pick up a drop while its window is open, and that changes the pocket too:
// a pocket change no click explains is a defect only when no pickup happened during the click.
const SHIFT_ANSWER_MS = 10000;
async function _shiftClick(bot, win, slot, name, direction) {
    const before = _pocketCount(win, [name]);
    const held = win.slots[slot] ? win.slots[slot].count : 0;
    let pickedUp = 0;
    const onCollect = (collector) => { if (collector === bot.entity) pickedUp++; };
    bot.on('playerCollect', onCollect);
    await _click(bot, slot, 0, 1);
    await sleep(TRANSFER_DELAY_MS);
    const pulse = require('@kernel/server_pulse');
    if (pulse.silentMs() >= SERVER_HEARD_WITHIN_MS) {
        const heard = await _settle(() => pulse.silentMs() < SERVER_HEARD_WITHIN_MS, SHIFT_ANSWER_MS);
        if (!heard) {
            watcher.warn(TAG, `shift-click of slot ${slot} (${name}): the server has been silent ${pulse.silentMs()}ms — measuring without its answer; the pocket at the close is the truth the item book keeps.`);
        }
        await sleep(TRANSFER_DELAY_MS);   // its answer to this click follows the first tick it sends
    }
    bot.removeListener('playerCollect', onCollect);
    const after = _pocketCount(win, [name]);
    const moved = direction === 'out' ? before - after : after - before;
    if (moved < 0 || (direction === 'out' && moved > held)) {
        const what = `a shift-click of slot ${slot} (${name} x${held}, ${direction === 'out' ? 'pocket to chest' : 'chest to pocket'}) `
            + `changed the pocket's ${name} from ${before} to ${after}`;
        if (pickedUp) {
            watcher.warn(TAG, `${what}, with ${pickedUp} pickup(s) during the click — counted as ${Math.max(0, Math.min(moved, held))}; the item book has the pickup.`);
            return Math.max(0, Math.min(moved, held));
        }
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): ${what}, and nothing was picked up. The pocket is this `
            + `body's alone, so one shift-click can only move that slot's stack in its own direction.`);
    }
    return moved;
}

// ── _splitInPocket: ONE POCKET SLOT HOLDING EXACTLY `k`, CUT FROM POCKET SLOT `slot` ───────────────────────
// The stack is lifted and the smaller part is dropped one at a time into an empty pocket slot, then the
// rest goes back: min(k, S−k)+2 clicks, all inside the pocket, where no peer can reach. → the slot holding
// exactly k, or -1 when the pocket has no empty slot (said by the caller).
async function _splitInPocket(bot, win, slot, k) {
    const { containerEnd, total } = _bounds(win);
    const it = win.slots[slot];
    if (!it || k <= 0 || k >= it.count) {
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): _splitInPocket asked to cut ${k} from slot ${slot} `
            + `holding ${it ? `${it.name} x${it.count}` : 'nothing'} — a split is strictly smaller than its stack.`);
    }
    const empty = _findEmpty(win, containerEnd, total);
    if (empty === -1) return -1;
    const { name, count } = it;
    const moveK = k <= count - k;           // drop k into the empty slot, or drop the S−k kept back
    const drops = moveK ? k : count - k;
    await _click(bot, slot, 0, 0);          // lift the whole pocket stack
    for (let i = 0; i < drops; i++) await _click(bot, empty, 1, 0);   // one at a time into the empty pocket slot
    await _click(bot, slot, 0, 0);          // the rest back where it was
    const at = moveK ? empty : slot;
    const landed = await _settle(() => !win.selectedItem
        && win.slots[at] && win.slots[at].name === name && win.slots[at].count === k);
    if (!landed) {
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): splitting ${k} off ${name} x${count} in the pocket `
            + `(slot ${slot} → ${empty}) left slot ${at} holding ${_slotDesc(win.slots[at])} and the cursor holding `
            + `${_slotDesc(win.selectedItem)} after 1s. The pocket is this body's alone, so the split cannot have `
            + `been disturbed by a peer.`);
    }
    return at;
}

// ── _shiftOut: EXACTLY `n` OF `name` FROM THE POCKET INTO THE CHEST ────────────────────────────────────
// Smallest pocket stack first, so part stacks leave before full ones. A stack that fits within what is left
// crosses whole; a bigger one is split first. A shift-click that moves less than its stack means the chest
// has no more room for it: that ends the move, and the caller sends the rest to the next chest. → moved.
async function _shiftOut(bot, win, name, n) {
    const { containerEnd, total } = _bounds(win);
    let moved = 0;
    for (let guard = 0; moved < n && guard < 36; guard++) {
        let slot = -1;
        for (let i = containerEnd; i < total; i++) {
            const it = win.slots[i];
            if (it && it.name === name && (slot === -1 || it.count < win.slots[slot].count)) slot = i;
        }
        if (slot === -1) break;
        const left = n - moved;
        let from = slot;
        if (win.slots[slot].count > left) {
            from = await _splitInPocket(bot, win, slot, left);
            if (from === -1) {
                watcher.warn(TAG, `deposit: no empty pocket slot to cut ${left} ${name} from a stack of `
                    + `${win.slots[slot].count} — ${moved} of ${n} moved; the rest stays in the pocket.`);
                break;
            }
        }
        const want = win.slots[from].count;
        const got = await _shiftClick(bot, win, from, name, 'out');
        moved += got;
        if (got < want) break;   // the chest is full for this item
    }
    return moved;
}

async function _transferDeposit(bot, win, item, amount) {
    const { containerEnd, total } = _bounds(win);
    const variants = _groupOf(item);
    const names = [];
    for (let i = containerEnd; i < total; i++) {
        const it = win.slots[i];
        if (it && (it.name === item || (variants && variants.includes(it.name))) && !names.includes(it.name)) names.push(it.name);
    }
    let deposited = 0;
    for (const name of names) {
        if (deposited >= amount) break;
        const want = Math.min(amount - deposited, _pocketCount(win, [name]));
        const got = await _shiftOut(bot, win, name, want);
        deposited += got;
        if (got < want) break;   // the chest is full: the rest of this kind goes to the next chest
    }
    return deposited;
}

// ── A WITHDRAWAL TAKES WHOLE STACKS AND HANDS THE SURPLUS BACK ────────────────────────────────────────────
// The smallest chest stack first, so a part stack empties before a full one is cut. A stack bigger than
// what is left is shift-clicked whole into the pocket and the surplus goes back through _shiftOut. A
// surplus the chest has no room to take back (a peer filled the slot in the moment between) stays in the
// pocket, and is said: it is an over-take, banked again by this body's next drop-off.
async function _transferRetrieve(bot, win, item, target, only = null) {
    const { containerEnd } = _bounds(win);
    const variants = _retrieveVariants(item, only);
    const isWanted = (it) => it && ((it.name === item) || (variants && variants.includes(it.name)));
    let retrieved = 0;
    const dry = new Set();   // chest slots a shift-click moved nothing from this window
    let waited = false;
    // An order by a group's name (logs) is capped as a group, so each member it lands as is also held to what
    // no other body has claimed by that member's own name: a take for fuel never empties another body's
    // claimed oak_wood.
    const tookOf = {};
    const memberLeft = (name) => (name === item ? Infinity
        : require('@perception/chest_ledger').memberUnclaimed(name) - (tookOf[name] || 0));

    for (let guard = 0; retrieved < target && guard < containerEnd; guard++) {
        let slot = -1;
        for (let s = 0; s < containerEnd; s++) {
            const it = win.slots[s];
            if (!dry.has(s) && isWanted(it) && memberLeft(it.name) > 0 && (slot === -1 || it.count < win.slots[slot].count)) slot = s;
        }
        if (slot === -1) {
            // None in sight: a peer's part take may be holding the stack and about to hand its surplus back,
            // often into the very slot that came back dry. Waited for once; then none is left here.
            if (waited) break;
            waited = true;
            const back = await _settle(() => win.slots.slice(0, containerEnd).some(it => isWanted(it) && memberLeft(it.name) > 0), PEER_RETURN_MS);
            if (!back) break;
            dry.clear();
            watcher.summary(TAG, `retrieve: ${item} came back into the chest while this window waited — taking it.`);
            continue;
        }
        const name = win.slots[slot].name;
        const want = Math.min(target - retrieved, memberLeft(name));
        // Taking part of a stack lands the whole stack and cuts the surplus off in the pocket, which needs
        // an empty slot for the stack and one to cut into. Without both, the surplus could not go back and
        // the withdrawal would over-take, keeping the whole stack for a take of a few. So part
        // of a stack is taken only with two empty pocket slots; otherwise the take stops short and says so.
        if (win.slots[slot].count > want) {
            let empty = 0;
            for (let i = containerEnd; i < win.slots.length; i++) if (!win.slots[i]) empty++;
            if (empty < 2) {
                watcher.warn(TAG, `retrieve: ${want} ${name} wanted from a stack of ${win.slots[slot].count}, and the pocket `
                    + `has ${empty} empty slot(s) — two are needed to cut a part off a stack, so the take stops at ${retrieved} of ${target}.`);
                break;
            }
        }
        const got = await _shiftClick(bot, win, slot, name, 'in');
        if (got === 0) {
            // A peer took this stack in the same instant, or the pocket has no room for it.
            dry.add(slot);
            if (_findEmpty(win, containerEnd, win.slots.length) === -1) {
                watcher.warn(TAG, `retrieve: the pocket has no room for ${name} — ${retrieved} of ${target} taken.`);
                break;
            }
            watcher.summary(TAG, `retrieve: chest slot ${slot} (${name}) moved nothing — a peer took it in the same instant; trying the next stack.`);
            continue;
        }
        retrieved += got;
        tookOf[name] = (tookOf[name] || 0) + got;
        if (got > want) {
            const surplus = got - want;
            const back = await _shiftOut(bot, win, name, surplus);
            retrieved -= back;
            tookOf[name] -= back;
            if (back < surplus) {
                watcher.warn(TAG, `retrieve: OVER-TAKE — ${surplus - back} ${name} beyond the ${target} asked for could `
                    + `not go back (the chest filled between the take and the return, or the pocket had no slot to cut `
                    + `the surplus into); they stay in the pocket and are banked at this body's next drop-off.`);
            }
        }
    }
    return retrieved;
}

// The cursor ends every window empty: every click here that lifts a stack puts it down in the same call.
// A stack still held at the close is a defect in this file (Law 13), never a peer's doing.
async function _assertCursorEmpty(win, stationId) {
    if (await _settle(() => !win.selectedItem)) return;
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): the cursor still holds ${_slotDesc(win.selectedItem)} at the `
        + `close of chest ${stationId}. Every lift in the transfer section puts its stack down before it returns.`);
}

// ---------------------------------------------------------------------------
// SECTION 4 — Caller abandonment helper
// ---------------------------------------------------------------------------

// `expected` marks an ending that is part of the process (a peer got to the chest first), said as an
// ordinary line; every other ending is a warning.
function _abandon(reason, expected = false) {
    watcher[expected ? 'summary' : 'warn'](TAG, `Abandoning caller — ${reason}`);
    routeToJudge(TAG, { result: TAG, success: false, readable: `${TAG}: ${reason}` });
}

// ---------------------------------------------------------------------------
// SECTION 5 — Core transfer logic (shared by both API entry points)
// ---------------------------------------------------------------------------

// ── THE CHEST TIMER: WHERE EVERY SECOND OF A VISIT WENT ──────────────────────────────────────────────
// One line per window, splitting the visit: `walk` to the chest's stance, `open` from the click to the
// window, `picture` from the window to its contents matching the chest's record, `work` from there to the
// close. `peers_at_open` / `peers_at_close` count the bodies whose spot was this chest at those moments.
// There is no queue term because nothing waits on a peer: two bodies work one chest at once. inventory_lens
// reads it (CHEST_TIMER_RE) and sums it into one table beside the old queue figures.
const _sec = (ms) => (ms / 1000).toFixed(2);

// The pocket's tally as the open window shows it (the slots past the container's).
function _pocketInWindow(win) {
    const t = {};
    const containerEnd = Math.max(0, win.slots.length - 36);
    for (let i = containerEnd; i < win.slots.length; i++) {
        const it = win.slots[i];
        if (it) t[it.name] = (t[it.name] || 0) + it.count;
    }
    return t;
}

async function _openWithRetry(bot, target) {
    let res = await _openWindow(bot, target.pos, target.id);
    for (let tries = 1; !res.ok && tries < OPEN_TRIES; tries++) {
        await sleep(OPEN_RETRY_MS);
        res = await _openWindow(bot, target.pos, target.id);
    }
    return res;
}

// One window carries as many kinds as the caller has: `orders` is always a list of {item, amount} — a
// single move is a list of one, not a second signature (Law 16). Opening a window is a fixed cost paid
// per visit, so batching multiple kinds into one window matters. A deposit always names its chest (the
// planner in SECTION 6 chose it and claimed its room); a withdrawal may leave the choice here.
async function _executeTransfer(bot, orderType, orders, targetStationId) {
    if (!Array.isArray(orders) || orders.length === 0) {
        throw new Error(`[${TAG}] CODING VIOLATION: _executeTransfer needs a non-empty list of {item, amount}.`);
    }
    if (orderType === 'deposit' && !targetStationId) {
        throw new Error(`[${TAG}] CODING VIOLATION (Law 16): a deposit reaches the window with its chest already `
            + `chosen by _planDeposits, which also claims the room it fills. Route it through depositItems or dumpExcess.`);
    }
    const stations = stationRegistry.getStations();
    // Selection needs one representative kind to pick a chest by; the transfer loop uses every entry.
    const item = orders[0].item;
    const startedAt = Date.now();

    let target;
    if (targetStationId) {
        const entry = stations[targetStationId];
        // A caller-named station that isn't a well-formed key ('x|y|z|owner') is a coding violation, not
        // a world state — the key can only come from station_registry.stationKey, so a malformed one
        // means the caller rebuilt it from coordinates and dropped the owner half. A well-formed key
        // with no row behind it is a chest broken between plan and act (creeper, player, another crew)
        // and abandons like any other missing target below (Law 29 — one condition per branch).
        const parts = String(targetStationId).split('|');
        const wellFormed = parts.length === 4
            && parts.slice(0, 3).every(p => Number.isInteger(Number(p)))
            && parts[3].length > 0;
        if (!wellFormed) {
            throw new Error(`[${TAG}] CODING VIOLATION (Law 13): asked to ${orderType} ${item} at station `
                + `"${targetStationId}", which is not a station key. Keys are minted ONLY by `
                + `station_registry.stationKey — voxel AND owner, e.g. "25|65|-1|homesteader". A caller that `
                + `builds one from coordinates drops the owner half and can never match any row. Carry the `
                + `key from the registry instead of rebuilding it.`);
        }
        if (!entry) {
            _abandon(`station_row_gone_${targetStationId}`);
            return;
        }
        target = { id: targetStationId, ...entry };
    } else {
        target = _selectRetrieveTarget(stations, item, orders[0].only || null);
    }

    // No source for a withdrawal is the ordinary multi-bot race (a peer emptied the pool between the
    // decision and here): a shortfall the caller re-plans from — supply_manager falls back to harvest and
    // delivery_executor routes a shortfall report (Law 16).
    if (!target) {
        watcher.summary(TAG, `no chest holds ${item} when the selector looked — a peer emptied the pool `
            + `between the decision and here; reporting a shortfall so the caller re-plans.`);
        return { success: false, order_type: orderType, item, moved: [], transferred: 0,
                 station_id: null, snapshot_items: 0 };
    }

    const number = stationRegistry.chestNumbers().get(target.id) || null;
    const label = `${target.type}${number ? ` #${number}` : ''}`;
    const link = require('@kernel/foreman_link');
    // The spot is said before the walk, so every peer already knows by the time this body opens the window.
    stationRegistry.claimSpot(target.id, orderType);
    link.sendUpdate();

    let audit = null;   // started at the first open, stopped at the close or by the cleanup below
    return await withCleanup(TAG, `chest window on ${target.id}`, async () => {

    // A named withdrawal whose kinds are all gone from the chest's picture is a peer's take landing first,
    // which is environmental (Law 13).
    if (orderType === 'retrieve' && targetStationId && Array.isArray(target.items)) {
        const missing = orders.filter(o => {
            const variants = _retrieveVariants(o.item, o.only || null);
            return !target.items.some(i => i.name === o.item || (variants && variants.includes(i.name)));
        });
        if (missing.length === orders.length) {
            _abandon(`nothing_of_[${orders.map(o => o.item).join(',')}]_left_in_${targetStationId} (a peer emptied it first)`, true);
            return;
        }
        if (missing.length) {
            watcher.warn(TAG, `retrieve: ${missing.map(o => o.item).join(', ')} gone from ${targetStationId} `
                + `before this body got there — taking the ${orders.length - missing.length} kind(s) still there.`);
            orders = orders.filter(o => !missing.includes(o));
        }
    }

    watcher.summary(TAG, `${orderType} ${orders.map(o => `${o.amount}x ${o.item}`).join(', ')} `
        + `→ ${label} at (${target.pos.x},${target.pos.y},${target.pos.z})`);

    // Always walks to the anchor stance, never an LOS goal — a raycast goal can be satisfied from up to
    // 4.5 blocks away, so A* would report `arrived: true` with an empty path and the open then fails at
    // the server.
    const locomotion = require('@locomotion/locomotion_dispatcher');
    const walkStartedAt = Date.now();
    const moveResult = await locomotion.goToStationStance({ x: target.pos.x, y: target.pos.y, z: target.pos.z });
    const walkMs = Date.now() - walkStartedAt;
    if (!moveResult.arrived) {
        _abandon(`cannot_reach_${orderType}_chest_at_(${target.pos.x},${target.pos.y},${target.pos.z}) — ${moveResult.reason}`);
        return;
    }

    audit = _startAudit(bot);
    const openStartedAt = Date.now();
    let openRes = await _openWithRetry(bot, target);
    if (!openRes.ok) {
        _abandon(`open_failed: ${openRes.reason} after ${OPEN_TRIES} tries at (${target.pos.x},${target.pos.y},${target.pos.z})`);
        return;
    }
    // The transfer works in the window the server has open — the one mineflayer's clicks go to.
    if (bot.currentWindow && bot.currentWindow !== openRes.window) {
        watcher.warn(TAG, `chest ${target.id}: the server replaced window #${openRes.window.id} with #${bot.currentWindow.id} — working in #${bot.currentWindow.id}.`);
        openRes = { ...openRes, window: bot.currentWindow };
    }
    const windowAt = Date.now();
    const openMsClick = windowAt - openStartedAt;

    // With no peer on this chest the window must match the newest picture; with one, the window is the
    // contents (see _awaitPicture).
    const peersAtOpen = stationRegistry.spotHolders(target.id);
    const pictured = peersAtOpen.length ? null : await _awaitPicture(openRes.window, target.id, windowAt);

    const workStartedAt = Date.now();
    audit.winId = openRes.window.id;
    audit.containerEnd = Math.max(0, openRes.window.slots.length - 36);
    audit.atOpen = _tally(_snapshotItems(openRes.window));
    audit.openedAt = openRes.clickedAt;
    audit.readyAt = Date.now();

    // The item book reads the pocket either side of the clicks; the count is the pocket's, not the order's.
    const book = require('@kernel/item_book');
    await book.open();

    let transferred = 0;
    const moved = [];
    const spent = {};   // item → what this window took of this body's claim, published after the picture
    for (const order of orders) {
        // Read at the open window, after the walk: what peers claimed on the way counts.
        let amount = order.amount;
        if (orderType === 'retrieve') {
            let free = _unclaimedFor(order.item, order.only || null);
            // A peer's part take reads as missing stock until its surplus goes back; with a peer at this
            // chest the claim cap is read again after that moment.
            if (free < amount && stationRegistry.spotHolders(target.id).length) {
                await _settle(() => (free = _unclaimedFor(order.item, order.only || null)) >= amount, PEER_RETURN_MS);
            }
            if (free < amount) {
                watcher.summary(TAG, `retrieve of ${order.item} held to ${free} of ${amount} at the window — the rest is claimed by other bodies.`);
                amount = free;
            }
            if (amount <= 0) continue;
        }
        const pocketBefore = orderType === 'retrieve' ? _pocketInWindow(openRes.window) : null;
        const got = orderType === 'deposit'
            ? await _transferDeposit(bot, openRes.window, order.item, order.amount)
            : await _transferRetrieve(bot, openRes.window, order.item, amount, order.only || null);
        transferred += got;
        if (got > 0) moved.push({ item: order.item, transferred: got });
        // What this body took is no longer in the chests for its claim to hold, spent by the names that
        // reached the pocket: an order for `logs` that took birch spends no claim on oak. Read off the
        // pocket, because a peer may be moving the same chest slots.
        // The spend is published after the chest's new picture (below): a peer that read the claim spent and
        // the old picture would file a claim on blocks already in this pocket.
        if (got > 0 && orderType === 'retrieve') {
            const gained = _tallyDelta(pocketBefore, _pocketInWindow(openRes.window));
            for (const [name, n] of Object.entries(gained)) if (n > 0) spent[name] = (spent[name] || 0) + n;
        }
    }

    await _assertCursorEmpty(openRes.window, target.id);
    await sleep(100); // 2 server ticks — let slot updates settle before snapshot
    const snapshot = _snapshotItems(openRes.window);
    stationRegistry.snapshotStation(target.id, snapshot);
    for (const [name, n] of Object.entries(spent)) require('@perception/chest_ledger').drawn(name, n);
    const peersAtClose = stationRegistry.spotHolders(target.id);

    await _closeWindow(bot);
    const closedAt = Date.now();
    // Contended is any peer's spot overlapping this window at any moment (station_registry.spotsDuring).
    // The audit asks again when its verdict settles, by which time a peer's release has had time to arrive.
    const peersDuring = () => stationRegistry.spotsDuring(target.id, windowAt, closedAt).length;
    const contended = peersAtOpen.length > 0 || peersDuring() > 0;
    _reportAudit(bot, audit, target.id, orderType, snapshot, () => contended || peersDuring() > 0);
    // The window's own contents go with the move, so the foreman checks its figure for this chest. A
    // contended window's contents carry a peer's moves the book has not yet heard, so it is checked at the
    // next window no peer shares.
    await book.close(orderType, `container:${target.id}`);
    if (!contended) book.report({ k: 'ca', id: target.id, items: _tally(snapshot) });
    book.flush();

    const snapshotSummary = snapshot.length > 0
        ? snapshot.map(i => `${i.name} x${i.count}`).join(', ')
        : 'empty';
    const openMs = closedAt - workStartedAt;
    const waitMs = workStartedAt - startedAt;
    // One line per window, not per kind (Law 25); inventory_lens reads it (TX_RE).
    watcher.summary(TAG, `${orderType} complete — ${orders.length} kind(s), ${transferred} item(s) `
        + `[${moved.length ? moved.map(m => `${m.item} x${m.transferred}`).join(', ') : 'nothing moved'}] `
        + `in ${(openMs / 1000).toFixed(1)}s open `
        + `(${transferred > 0 ? Math.round(openMs / transferred) : openMs}ms/item) after ${(waitMs / 1000).toFixed(1)}s waiting to get in. `
        + `Chest ${target.id}: ${snapshot.length} stack(s) [${snapshotSummary}].`
        + (pictured == null ? ` Picture not checked — ${peersAtOpen.length} peer(s) using this chest.`
            : pictured.peer ? ` Picture not matched — a peer came to this chest after ${pictured.ms}ms.`
            : pictured.forgiven ? ` Contents did not match the picture and were forgiven after ${pictured.ms}ms.`
            : ` Contents matched the picture in ${pictured.ms}ms.`)
        + ` Walked ${(walkMs / 1000).toFixed(1)}s of the wait.`);
    watcher.summary(TAG, `chest timer ${orderType} ${label} ${target.id}: walk=${_sec(walkMs)} open=${_sec(openMsClick)} `
        + `picture=${_sec(workStartedAt - windowAt)} work=${_sec(openMs)} total=${_sec(closedAt - startedAt)} `
        + `peers_at_open=${peersAtOpen.length} peers_at_close=${peersAtClose.length} contended=${contended ? 1 : 0} items=${transferred} `
        + `peers_during=${peersDuring()}`);

    return {
        success: transferred > 0,
        order_type: orderType,
        item,
        moved,
        transferred,
        station_id: target.id,
        snapshot_items: snapshot.length,
    };
    }, () => {
        if (audit) _stopAudit(bot, audit);
        // The picture and the spot's release reach the fleet in one update.
        stationRegistry.releaseSpot(target.id);
        link.sendUpdate();
    });
}

// ---------------------------------------------------------------------------
// SECTION 6 — Exported API (Law 15 entry points)
// ---------------------------------------------------------------------------

// ── A DEPOSIT IS PLANNED, CLAIMED, WALKED, AND WHAT DID NOT FIT GOES TO THE NEXT CHEST ─────────────────
// _planDeposits places every unit against the chests' pictures less every peer's claimed room; that plan is
// filed as this body's deposit claim (chest_ledger.claimRoom) before the first step; the chests are visited
// in number order, each one's room released as its window closes. A chest that took less than planned
// (a peer filled it, a body without a magnet claimed nothing, a picture a moment stale) is the world: the
// next round re-plans the remainder over the chests not yet tried. → { moved, unplaced, last, abandoned }.
function _pocketWants(bot, wants) {
    const have = {};
    for (const it of bot.inventory.items()) have[it.name] = (have[it.name] || 0) + it.count;
    const out = {};
    for (const [item, n] of Object.entries(wants)) {
        const members = _groupOf(item);
        const held = members ? members.reduce((s, m) => s + (have[m] || 0), 0) : (have[item] || 0);
        const w = Math.min(n, held);
        if (w > 0) out[item] = w;
    }
    return out;
}

async function _depositPlanned(bot, wants) {
    const ledger = require('@perception/chest_ledger');
    const tried = new Set();
    const moved = [];
    let last = null;
    let left = _pocketWants(bot, wants);
    return await withCleanup(TAG, 'deposit claim', async () => {
        for (let round = 0; round < DEPOSIT_MAX_ROUNDS && Object.keys(left).length; round++) {
            const plan = _planDeposits(stationRegistry.getStations(), left, tried);
            if (!plan.rows.length) break;
            ledger.claimRoom(plan.rows);
            const stationsInOrder = [...new Set(plan.rows.map(r => r.station))];
            if (round > 0) {
                watcher.summary(TAG, `deposit fallback round ${round + 1}: ${Object.entries(left).map(([k, v]) => `${v} ${k}`).join(', ')} `
                    + `did not fit where planned — going on to chest(s) ${stationsInOrder.map(id => `#${plan.rows.find(r => r.station === id).number}`).join(', ')}.`);
            }
            for (const stationId of stationsInOrder) {
                const orders = plan.rows.filter(r => r.station === stationId).map(r => ({ item: r.item, amount: r.amount }));
                const r = await _executeTransfer(bot, 'deposit', orders, stationId);
                ledger.releaseRoom(stationId);
                tried.add(stationId);
                if (r === undefined) return { moved, unplaced: left, last, abandoned: true };
                last = r;
                for (const m of r.moved) moved.push(m);
            }
            left = _pocketWants(bot, Object.fromEntries(Object.entries(left).map(([k, v]) => {
                const done = moved.filter(m => m.item === k).reduce((s, m) => s + m.transferred, 0);
                return [k, Math.max(0, (wants[k] || 0) - done)];
            })));
        }
        return { moved, unplaced: left, last, abandoned: false };
    }, () => ledger.releaseRoom(null));
}

// A storage chest named by the caller is a suggestion: every storage chest is one pool, and the pool's
// order decides. A non-storage station is used as named.
async function depositItems(bot, item, amount, stationId) {
    bot = bot || global.bot;
    if (!bot) throw new Error('[inventory_swapper] CODING VIOLATION: depositItems called with no bot loaded.');
    const named = stationId ? stationRegistry.getStations()[stationId] : null;
    if (named && !stationRegistry.isStorage(named)) {
        return _executeTransfer(bot, 'deposit', [{ item, amount: amount || 64 }], stationId);
    }
    const result = await _depositPlanned(bot, { [item]: amount || 64 });
    if (result.abandoned) return undefined;   // already routed to the judge (Law 15)
    const transferred = result.moved.reduce((n, m) => n + m.transferred, 0);
    if (!result.last) {
        _abandon(`no_deposit_target_for_${item} — no chest has room`);
        return undefined;
    }
    return { ...result.last, success: transferred > 0, item, moved: result.moved, transferred };
}

// A named station is one window. With none named, the withdrawal goes on to the next chest holding the
// item until the amount is met or no chest holds any — a spread material is in several places by design,
// so one chest's share is not the pool's answer. Stops at the first window that moves nothing.
const RETRIEVE_MAX_WINDOWS = 6;
// opts.only: the items this withdrawal may take (a furnace input whitelist); absent, the group decides.
async function retrieveItems(bot, item, amount, stationId, opts = {}) {
    bot = bot || global.bot;
    if (!bot) throw new Error('[inventory_swapper] CODING VIOLATION: retrieveItems called with no bot loaded.');
    const only = Array.isArray(opts.only) ? opts.only : null;
    // Asked before the walk as well as at the window: a take that is wholly claimed costs no trip.
    const asked = amount || 64;
    // A pool holding none of it is the transfer's own case below, answered there as before.
    const held = !!_selectRetrieveTarget(stationRegistry.getStations(), item, only);
    const want = held ? Math.min(asked, _unclaimedFor(item, only)) : asked;
    if (want <= 0) {
        watcher.summary(TAG, `retrieve of ${asked}x ${item} not made — every one in the chests is claimed by other bodies; reporting a shortfall so the caller re-plans.`);
        return { success: false, order_type: 'retrieve', item, moved: [], transferred: 0, station_id: stationId || null, snapshot_items: 0 };
    }
    if (want < asked) watcher.summary(TAG, `retrieve of ${item} held to ${want} of ${asked} — the rest is claimed by other bodies.`);
    if (stationId) return _executeTransfer(bot, 'retrieve', [{ item, amount: want, only }], stationId);
    let total = null;
    for (let window = 0; window < RETRIEVE_MAX_WINDOWS; window++) {
        const got = (total ? total.transferred : 0);
        const r = await _executeTransfer(bot, 'retrieve', [{ item, amount: want - got, only }], null);
        if (r === undefined) return undefined;   // abandoned to the judge (Law 15) — nothing routes again
        if (!total) total = r;
        else if (r.transferred > 0) {
            total = { ...r, transferred: total.transferred + r.transferred, moved: [...total.moved, ...r.moved], success: true };
        }
        if (r.transferred <= 0 || total.transferred >= want) break;
    }
    return total;
}

// computeExcess — the single dump-threshold math (Law 16), shared by dumpExcess and job_board's
// dump-gate so the two can never disagree on what counts as excess. Given raw inventory counts
// {name:count} and INVENTORY_WHITELIST ([{item, keep}], item may be a group token like 'logs'), returns
// {name: overAmount} for everything above its keep allowance; group tokens share one allowance across
// their concrete members, and anything no whitelist entry covers is fully excess.
//
// `wanted` — material the asker is actively working toward — is a floor on top of the whitelist rows
// (max(), not a separate branch), passed by the caller and never read from here since whose demand
// counts differs per asker (Law 25). Group tokens in `wanted` resolve to concrete items on the way in,
// since a demand speaks the recipe's vocabulary and a pocket speaks the world's.

// heldOrderDemand() → {token: count}, every material this bot's currently-held order still needs; {}
// when no supply job is held. Read fresh from the boardroom (Invariant B); one reader for one question
// (Law 16) — the dumper and the pool lens must never disagree on what's spoken for.
function heldOrderDemand() {
    // Required lazily and upward — a top-level require would close the cycle (job_board → assessors →
    // this file).
    const hq = require('@kernel/corporate_headquarters');
    const { requirementTree } = require('@utils/calculators/build_material_calculator');
    const magnet = hq.readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
    return (magnet && magnet.type === 'supply' && magnet.what && magnet.need > 0)
        ? requirementTree(magnet.what, magnet.need, {})
        : {};
}

function computeExcess(invCounts, whitelist, wanted = null) {
    const spokenFor = {};
    for (const [token, count] of Object.entries(wanted || {})) {
        const members = _groupOf(token);
        if (Array.isArray(members)) {
            let remaining = count;
            for (const member of members) {
                if (remaining <= 0) break;
                const take = Math.min(invCounts[member] || 0, remaining);
                if (take > 0) { spokenFor[member] = (spokenFor[member] || 0) + take; remaining -= take; }
            }
        } else {
            // The named item first, then its substitutes (`substitutes_for`): coal a torch order withdrew
            // in place of charcoal is spoken for by that order, or the dumper banks it straight back.
            let remaining = count;
            for (const source of [token, ...(substitutes_for[token] || [])]) {
                if (remaining <= 0) break;
                const take = source === token ? remaining : Math.min(invCounts[source] || 0, remaining);
                if (take > 0) { spokenFor[source] = (spokenFor[source] || 0) + take; remaining -= Math.min(invCounts[source] || 0, take); }
            }
        }
    }
    const keepBack = (item, over) => Math.max(0, over - (spokenFor[item] || 0));

    const handled = new Set();
    const excess = {};
    for (const entry of whitelist) {
        // A row may state the order its members are kept in (`keep_order`, a tool family best tier first);
        // a member an earlier row already settled keeps that row's answer.
        const members = entry.keep_order || group_to_item[entry.item];
        if (Array.isArray(members)) {
            let remaining = entry.dump_threshold;
            for (const member of members) {
                if (!(member in invCounts) || handled.has(member)) continue;
                handled.add(member);
                const have = invCounts[member];
                const toKeep = Math.min(have, remaining);
                remaining -= toKeep;
                const over = keepBack(member, have - toKeep);
                if (over > 0) excess[member] = over;
            }
        } else {
            handled.add(entry.item);
            const have = invCounts[entry.item] || 0;
            const over = keepBack(entry.item, have - entry.dump_threshold);
            if (over > 0) excess[entry.item] = over;
        }
    }
    for (const [item, count] of Object.entries(invCounts)) {
        if (handled.has(item)) continue;
        const over = keepBack(item, count);
        if (over > 0) excess[item] = over;
    }
    return excess;
}

// dumpExcess — pushes everything not whitelisted to keep into the fleet's chests. Reads
// INVENTORY_WHITELIST from job_board: {item, keep}, item a group token (logs, planks) or a concrete
// item; group tokens distribute keep across concrete members. Everything not covered by any whitelist
// entry is dumped entirely. Called explicitly by fragments after completing work. No double handling by
// construction: there is one pool, so depositing anywhere satisfies any request for that material.
// Compostables are banked like everything else; the compost job (assessors/compost) empties them into
// the composter in one batch.

async function dumpExcess(bot) {
    bot = bot || global.bot;
    if (!bot) throw new Error('[inventory_swapper] CODING VIOLATION: dumpExcess called with no bot loaded.');

    // Required lazily and upward — a top-level require here would close the cycle (job_board →
    // assessors → this file).
    const { INVENTORY_WHITELIST } = require('@thinking/job_board.js');
    const hq = require('@kernel/corporate_headquarters');

    // Trash goes to the waste pit before anything is banked, so no chest slot holds it; with no pit to
    // use it stays in the pocket and is banked below like the rest.
    await require('@api/waste_pit').discardTrash(bot);

    // Every registered chest is a destination — no role filtering; the planner reads one snapshot for the
    // whole dump, so two kinds can't pick the same last free slot.
    if (stationRegistry.findChests().length === 0) {
        watcher.summary(TAG, 'dumpExcess: no chest registered — nowhere to bank anything');
        // noChest tells the caller its own zero total needs no separate line — with no chest the
        // drop-off is 0 by construction.
        return { dumped: 0, items: [], noChest: true };
    }

    const invCounts = {};
    for (const it of bot.inventory.items()) {
        invCounts[it.name] = (invCounts[it.name] || 0) + it.count;
    }

    // What this bot is currently working toward (heldOrderDemand) is not surplus — a shared producer
    // (two bots at one furnace) needs the emptier to keep only its own order's share, so the rest falls
    // into a chest for the asker to withdraw. No claim held → nothing is spoken for.
    const wanted = heldOrderDemand();
    const magnet = hq.readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;

    const excess = computeExcess(invCounts, INVENTORY_WHITELIST, wanted);

    if (Object.keys(excess).length === 0) {
        const held = Object.keys(wanted).length ? ` — ${magnet.what} order still wants ${Object.entries(wanted).map(([k, v]) => `${v}x ${k}`).join(', ')}` : '';
        watcher.summary(TAG, `dumpExcess: nothing to dump — all items whitelisted or spoken for${held}`);
        return { dumped: 0, items: [] };
    }

    watcher.summary(TAG, `dumpExcess: ${Object.entries(excess).map(([k, v]) => `${k}x${v}`).join(', ')}`);

    // One window per chest, never one per kind: the planner groups every kind by the chest it goes to, so
    // each window pays the fixed open/close cost once (_depositPlanned).
    const result = await _depositPlanned(bot, excess);
    // Per-kind rows, not one row per window — the caller's report is per-kind.
    const dumpResults = result.moved.map(m => ({ item: m.item, transferred: m.transferred }));
    // Abandonment propagates instead of being swallowed: _executeTransfer returns undefined only after
    // already routing a fresh signal to recursive_judge (Law 15), so the caller must not route again (Law 4).
    if (result.abandoned) {
        watcher.warn(TAG, `dumpExcess: a deposit was abandoned to the judge — stopping the dump and reporting it so the caller does not route again.`);
        return { dumped: dumpResults.length, items: dumpResults, abandoned: true };
    }
    if (Object.keys(result.unplaced).length) {
        watcher.summary(TAG, `dumpExcess: no chest has room for ${Object.entries(result.unplaced).map(([k, v]) => `${v} ${k}`).join(', ')} — it stays in the pocket.`);
    }

    if (dumpResults.length > 0) {
        watcher.summary(TAG, `dumpExcess complete: ${dumpResults.map(r => `${r.item}x${r.transferred}`).join(', ')}`);
    }

    return { dumped: dumpResults.length, items: dumpResults };
}

// dropOffHaul — the end-of-work drop-off: dumpExcess owns WHAT is kept, this owns WHEN it's worth
// walking to a chest, plus the one carve-out both gather and craft executors need. Hangs on gather and
// craft only, never mining — a pocket is the least safe place to keep material on hard difficulty.
// No home blueprint locked yet → skip instead of fail (Law 13).

// The `bot` band (gather → craft → equip for the body's own gear) keeps its haul instead of dumping
// between gather and craft — that material never belonged to the fleet. Every other band's gathers are
// consumed by the fleet from a chest, so for those the drop-off IS the delivery. Stated as the one band
// that keeps, so a band added later dumps by omission — the safe direction (Law 16: read off the
// magnet, the one place a band is decided; no magnet → dump).
const KEEPS_ITS_HAUL = 'bot';

// A body that is still gathering stays out until its trip has paid for its walk home: the walk calculator
// (yield_pledge_calculator.walkOwed) for the distance it stands from home, at its own measured pace, against
// the walking and the working its own clock holds for the job, and only while staying pays the debt down
// (staysOut). Fewer than FREE_SLOTS_KEPT empty slots sends it home whatever is owed.
// → { stay, walk, haul, owed_s, walk_s }.
const FREE_SLOTS_KEPT = 4;
function haulFitsWalk(bot, homeOrigin) {
    const yieldPledge = require('@utils/calculators/yield_pledge_calculator');
    const { INVENTORY_WHITELIST } = require('@thinking/job_board.js');
    const counts = {};
    for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count;
    // The order's own material is part of the haul here: it is what the walk out was for.
    const haul = Object.values(computeExcess(counts, INVENTORY_WHITELIST, {})).reduce((n, v) => n + v, 0);
    const at = bot.entity.position;
    const walk = Math.round(Math.hypot(at.x - homeOrigin.x, at.z - homeOrigin.z));
    const span = require('@kernel/bot_minutes').snapshot().open_span;
    const owed = yieldPledge.walkOwed(walk, require('@locomotion/locomotion_dispatcher').walkPace(), span);
    const free = bot.inventory.emptySlotCount();
    const stay = yieldPledge.staysOut(span, owed, 'drop_off') && free >= FREE_SLOTS_KEPT;
    watcher.summary('trip_size', `trip_size at=drop_off item=haul walk=${walk} walk_s=${owed.walk_s} elapsed_s=${owed.elapsed_s} walked_s=${owed.walked_s} owed_s=${owed.owed_s} taken=0 held=${haul} free_slots=${free} stays_out=${stay ? 1 : 0} pace=${owed.measured ? 'measured' : 'unmeasured'}`);
    return { stay, walk, haul, owed_s: owed.owed_s, walk_s: owed.walk_s };
}

// opts.still_gathering — the caller's work has more to take where the body stands (a gather that
// succeeded). Only then may the drop-off be held back for a haul that fits the walk.
async function dropOffHaul(bot, opts = {}) {
    bot = bot || global.bot;
    if (!bot?.entity?.position) return { dumped: 0, items: [] };

    const hq = require('@kernel/corporate_headquarters');
    const magnet = hq.readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
    if (magnet?.asker === KEEPS_ITS_HAUL) {
        watcher.summary(TAG, `drop-off skipped — this is ${KEEPS_ITS_HAUL}-band work `
            + `(${magnet.job_type || magnet.what || 'unnamed job'}), so the haul stays in the pocket `
            + `for the craft that asked for it rather than being banked and withdrawn again.`);
        return { dumped: 0, items: [] };
    }

    const { readTransposeOrigin } = require('@utils/fragment_utils');
    // The crew's HOME is its alpha structure (bot_mandate.homeBlueprint) — a builder has no headframe.
    const home = require('@kernel/bot_mandate').homeBlueprint();
    if (!readTransposeOrigin(home)) {
        watcher.summary(TAG, `drop-off skipped — no ${home} locked yet, so there is nowhere to put a haul.`);
        return { dumped: 0, items: [] };
    }

    if (opts.still_gathering) {
        const fit = haulFitsWalk(bot, readTransposeOrigin(home));
        if (fit.stay) {
            watcher.summary(TAG, `drop-off held — ${fit.haul} item(s) in the pocket, and ${fit.owed_s}s is still owed for a ${fit.walk_s}s walk home (${fit.walk} blocks); staying out to gather.`);
            return { dumped: 0, items: [], stayed_out: true };
        }
    }

    const result = await dumpExcess(bot);
    const items = Array.isArray(result?.items) ? result.items : [];
    const moved = items.reduce((n, i) => n + (i.transferred || 0), 0);
    // Carried through to every caller: `abandoned` means a signal is already routed to the judge, so
    // the caller must return without routing again.
    if (result?.abandoned) {
        watcher.summary(TAG, `drop-off: ${moved} item(s) moved before the transfer was abandoned to the judge — caller must not route.`);
        return result;
    }
    // Reported whenever there was somewhere to put it, including zero — with no chest the zero measures
    // the missing chest, not the whitelist, and dumpExcess already said so.
    if (!result?.noChest) {
        watcher.summary(TAG, `drop-off: ${moved} item(s) across ${items.length} kind(s) into the fleet's chests.`);
    }
    return result;
}

module.exports = {
    depositItems,
    retrieveItems,
    dumpExcess,
    dropOffHaul,
    computeExcess,
    heldOrderDemand,
};
