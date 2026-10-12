// Law 15 API — depositItems, retrieveItems and dumpExcess handle chest interaction: select a chest,
// navigate there, open it, transfer items, snapshot contents, update station_registry, and close.
// dumpExcess reads INVENTORY_WHITELIST from job_board and dumps everything not whitelisted to keep.
// Called directly by preconstruction, build_executor, delivery_executor, supply_manager,
// furnace_executor, and any fragment that needs chest deposit/withdrawal. No signal-bus entry.
//
// Every chest is interchangeable — selection is by room, consolidation and locks, never by role.
// Nested API (Law 15): calls the locomotion API to reach chests; an unreachable chest abandons the
// caller, originating a fresh signal to recursive_judge.
// Invariants: depositItems/retrieveItems throw only on coding violations (missing bot), every other
// outcome is environmental (Law 13 + Law 15). Deposit fills the lowest-ID chest with room; retrieve
// picks the first chest containing the item. A locked chest is a legal candidate (unlocked preferred);
// a pick on one queues — walk there, wait for release (waitUntilChestFree), re-read the fresh
// snapshot, proceed — bounded by LOCK_QUEUE_TIMEOUT_MS.

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
const { waitUntilChestFree } = require('@utils/chest_lock_utils');
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
const WINDOW_POLL_MS = 10;   // poll rate for a wait queued behind a held lock, one server tick
// Three server ticks after a stack-moving click (pick up, drop, halve, shift-click). One tick let a
// halve-and-drop pair outrun the server: the client showed the stack in the chest, the server kept it in
// the pocket, and the picture recorded a deposit that never landed.
const TRANSFER_DELAY_MS = 150;
const CLOSE_SETTLE_MS = 80;
const MAX_CLOSE_TRIES = 8;
// Bounds a wait at a locked chest — catches a lock that is never releasing (a body killed mid-window,
// cleared only by clearMagnet).
const LOCK_QUEUE_TIMEOUT_MS = 120000;
// Poll rate for a body waiting at a locked chest, read from the in-memory boardroom (`getLockHolder`).
const LOCK_QUEUE_POLL_MS = 50;

// ---------------------------------------------------------------------------
// SECTION 1 — Station selection
// ---------------------------------------------------------------------------

function _parsePos(posId) {
    const [x, y, z] = posId.split('|').map(Number);
    return { x, y, z };
}

// ── EVERY ITEM IS SPREAD ONE STACK TO A CHEST, AND A STACK IS FILLED BEFORE ANOTHER IS STARTED ────────────
// A deposit goes first to a chest holding a stack of that item short of full, so no chest carries two part
// stacks of one item. With every stack full it goes to the chest holding the least of the item, so each chest
// gets its first stack before any gets a second: a withdrawal then finds the item in many chests and queues at
// none.
// Room for `item` in a chest's picture: a free slot, or a stack of that exact item short of full.
function _hasRoom(bot, entry, item) {
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length < (entry.capacity || 27)) return true;
    const def = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[item];
    const stackSize = (def && def.stackSize) || 64;
    return items.some(i => i.name === item && (i.count || 0) < stackSize);
}
// Units of `item` in a chest's picture; a group token (`logs`) counts every member.
function _countIn(entry, item) {
    const members = _groupOf(item);
    return (Array.isArray(entry.items) ? entry.items : [])
        .reduce((n, i) => n + ((i.name === item || (members && members.includes(i.name))) ? (i.count || 0) : 0), 0);
}

// Among chests with room: one holding a part stack of the item, then the one holding the least of it. Equal
// candidates are equal (Law 27): an unlocked one is taken over a locked one, and among the rest the pick is
// random, which is also what keeps a fleet of bodies from converging on the same empty chest.
function _selectDepositTarget(stations, item) {
    const def = global.bot && global.bot.registry && global.bot.registry.itemsByName && global.bot.registry.itemsByName[item];
    const stackSize = (def && def.stackSize) || 64;
    const candidates = [];
    for (const [id, entry] of Object.entries(stations)) {
        if (!require('@perception/station_registry').isStorage(entry)) continue;
        if (!_hasRoom(global.bot, entry, item)) continue;
        const partStack = Array.isArray(entry.items) && entry.items.some(i => i.name === item && (i.count || 0) < stackSize);
        candidates.push({ id, ...entry, partStack, held: _countIn(entry, item), draw: Math.random() });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.partStack === b.partStack ? 0 : (a.partStack ? -1 : 1))
        || (a.held - b.held)
        || ((!a.locked_by === !b.locked_by) ? 0 : (a.locked_by ? 1 : -1))
        || (a.draw - b.draw));
    return candidates[0];
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

// Retrieve: first unlocked chest holding the item; when only a locked chest holds it, returns that
// one instead of reporting no source.
function _selectRetrieveTarget(stations, item, only = null) {
    const variants = _retrieveVariants(item, only);
    let lockedFallback = null;
    for (const [id, entry] of Object.entries(stations)) {
        if (!require('@perception/station_registry').isStorage(entry) || !Array.isArray(entry.items)) continue;
        const hasItem = entry.items.some(i =>
            i.name === item || (variants && variants.includes(i.name))
        );
        if (!hasItem) continue;
        if (!entry.locked_by) return { id, ...entry };
        if (!lockedFallback) lockedFallback = { id, ...entry };
    }
    return lockedFallback;
}

// No chest→chest courier: retrieveItems and depositItems/dumpExcess are the only chest movements, and
// both cross the pocket boundary — a `storage` figure is measured across every chest at once (Law 25).

// ---------------------------------------------------------------------------
// SECTION 2 — Window management
// ---------------------------------------------------------------------------

// Polls for the window instead of sleeping a fixed delay before checking (Invariant B) — the lock is
// already held, so every millisecond here is paid by the queue behind this body.
// ── A WINDOW IS OPEN WHEN ITS SLOTS HAVE ARRIVED, NOT WHEN IT EXISTS ─────────────────────────────────
// mineflayer sets `bot.currentWindow` on the open packet and fills its slots on the next one, emitting
// `windowOpen` only then. Reading the window at the first moment sees an empty chest and an empty pocket,
// and the transfer moves nothing through a window the queue already paid for — so the wait is for the
// `windowOpen` event, listened for before the click so it cannot be missed.
// A chest that never opens (no window by CONTENTS_ARRIVAL_MS) is a peer holding it and is queued for; a
// window that opened is owed its slots within the same ceiling.
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
// Every window closes on a snapshot of the container (snapshotStation), sent to the fleet with the lock's
// release in one update, so the next body reads the chest's contents before it arrives. On opening, the
// window's contents must match that picture: the body acts the moment they do, and a window still
// disagreeing after CONTENTS_ARRIVAL_MS means the record and the world have split (Law 13).
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
// chest's contents (Invariant B) and the picture is rewritten from it under the lock this body holds.
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

// → { ms, forgiven }: how long the window took to match the picture, or that it never did and was forgiven.
async function _awaitPicture(win, stationId, picture, clickedAt) {
    const want = _tally(picture);
    // The ceiling runs from the window's arrival: an open the server answered late has used none of it.
    const arrivedAt = Date.now();
    while (!_sameTally(_tally(_snapshotItems(win)), want)) {
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
            return { ms: Date.now() - clickedAt, forgiven: true };
        }
        await sleep(WINDOW_POLL_MS);
    }
    return { ms: Date.now() - clickedAt, forgiven: false };
}

async function _closeWindow(bot) {
    if (!bot || !bot.currentWindow) return;
    // The close request is fire-and-forget; the settle loop below is the actual measurement, reading
    // bot.currentWindow instead of trusting the call (Invariant B).
    if (typeof bot.closeWindow === 'function') {
        guardExternalSync(TAG, 'closeWindow', () => bot.closeWindow(bot.currentWindow));
    }
    // Polled at a tick, for the reason `_openWindow` gives: the caller's `withCleanup` releases the
    // chest lock only after this returns, so every millisecond here is paid by the queue behind this
    // body. Budget is unchanged — the same MAX_CLOSE_TRIES × CLOSE_SETTLE_MS ceiling as before.
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
function _reportAudit(bot, audit, stationId, orderType, picture) {
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
        const server = _serverContainer(audit);
        const winPackets = audit.packets.filter(p => p.windowId === audit.winId && (p.kind === 'window_items' || p.kind === 'set_slot'));
        const corrections = winPackets.filter(p => p.t > audit.readyAt);
        const pocketCorrections = corrections.filter(p => p.kind === 'window_items' || p.slot >= audit.containerEnd);
        const pictureAgrees = corrections.length === 0 || (server ? _sameTally(server, pictureTally) : true);
        const heardMs = Date.now() - audit.closedAt;
        const packets = audit.packets.map(p => p.kind === 'open_window' || p.kind === 'close_window'
            ? `+${p.t - audit.openedAt}ms ${p.kind}(w${p.windowId})`
            : p.windowId !== audit.winId ? `+${p.t - audit.openedAt}ms ${p.kind}(w${p.windowId})${p.kind === 'set_slot' ? ` slot${p.slot}=${_slotDesc(p.item)}` : ''}`
            : p.kind === 'window_items'
            ? `+${p.t - audit.openedAt}ms items#${p.stateId}[${_describeTally(_tally(p.items.slice(0, audit.containerEnd).filter(Boolean)))}]`
            : `+${p.t - audit.openedAt}ms slot${p.slot}#${p.stateId}=${_slotDesc(p.item)}`).join(' ');
        const line = `transfer audit ${orderType} ${stationId} window#${audit.winId}: `
            + `at open [${_describeTally(audit.atOpen || {})}] · picture written [${_describeTally(pictureTally)}] · `
            + `server's last word [${server ? _describeTally(server) : 'no container packet'}] · `
            + `pocket change expected [${_describeDelta(expectedPocket)}] at the close [${_describeDelta(actual)}] · picture matched at +${audit.readyAt - audit.openedAt}ms · `
            + `clicks ${audit.clicks.length} {${clicks}} · server packets ${winPackets.length}, ${corrections.length} after the picture matched `
            + `(${pocketCorrections.length} touching the pocket), heard until ${heardMs}ms after the close {${packets}}`;
        const faults = [];
        if (!pictureAgrees) faults.push('the server corrected the window after it opened and the picture differs from the corrected container');
        if (pocketCorrections.length) faults.push('the server corrected the pocket after the picture matched');
        if (!pocketAgrees) faults.push('the pocket at the close did not change by what the window said moved');
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
// _click: promise wrapper around bot.clickWindow.
// _moveExact / _moveExactDeposit: pick up a stack, place count items onto dest slot(s), put remainder
// back. Deposit and retrieve both shift-click when the stack fits within the remaining amount, and
// fall back to _moveExact(Deposit) only when it exceeds it.
// ---------------------------------------------------------------------------

// mineflayer's clickWindow(slot, button, mode) is a promise that resolves once the click is applied to the
// window; it takes no callback. Every transfer is verified against the window's slots afterward, and the
// next body's picture check verifies the whole window against the server.
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

// A slot already holding `itemName` below its max stack size. Topping this off before opening a fresh
// empty slot is what consolidates repeated partial deposits (torch:3,3,3 → torch:9). Matches the
// concrete name only — never merges variants (oak_log tops oak_log, not birch_log).
function _findPartialStack(win, itemName, start, end) {
    for (let i = start; i < end; i++) {
        const it = win.slots[i];
        if (!it || it.name !== itemName) continue;
        const max = it.stackSize || 64;
        if (it.count < max) return i;
    }
    return -1;
}

async function _moveExact(bot, win, sourceSlot, count, destStart, destEnd) {
    const destSlot = _findEmpty(win, destStart, destEnd);
    if (destSlot === -1) return 0;

    await _click(bot, sourceSlot, 0, 0);   // pick up full stack
    await sleep(TRANSFER_DELAY_MS);

    for (let i = 0; i < count; i++) await _click(bot, destSlot, 1, 0);   // right-click places 1 item

    await _click(bot, sourceSlot, 0, 0);   // put remainder back
    await sleep(TRANSFER_DELAY_MS);
    const destItem = win.slots[destSlot];
    return destItem ? destItem.count : 0;
}

// Deposit variant of _moveExact. Picks up the source stack once, then pours `count` items first onto
// existing partial stacks of the same item (respecting stackSize headroom), and only spills the
// remainder into a fresh empty slot. Returns the amount actually deposited, measured off the source
// slot delta.
async function _moveExactDeposit(bot, win, sourceSlot, count, itemName, destStart, destEnd) {
    const before = win.slots[sourceSlot] ? win.slots[sourceSlot].count : 0;

    // Bulk chunks first: right-click lifts ceil(n/2) off the source, left-click on an empty dest drops
    // the whole held stack, so a chunk costs two clicks regardless of size (plan computed in
    // stack_split_calculator, checkable without a world — Law 26). Empty slots only: merging onto a
    // partial stack would leave leftover in hand and falsify the source-delta measurement below
    // (Law 25); topping off partials is what the singles loop below is for. No empty slot → the plan is
    // skipped and the original path runs.
    const { planStackSplit, naiveClickCost } = require('@utils/calculators/stack_split_calculator');
    const plan = planStackSplit(before, Math.min(count, before));
    if (plan.strategy === 'halve' && plan.chunks.length) {
        let placed = 0;
        for (const chunk of plan.chunks) {
            const destSlot = _findEmpty(win, destStart, destEnd);
            if (destSlot === -1) break;
            await _click(bot, sourceSlot, 1, 0);   // right-click source → hold ceil(source/2)
            await sleep(TRANSFER_DELAY_MS);
            await _click(bot, destSlot, 0, 0);     // left-click empty dest → drop the whole held stack
            await sleep(TRANSFER_DELAY_MS);
            placed += chunk;
        }
        if (placed > 0) {
            watcher.summary(TAG, `stack split: ${placed} of ${count} ${itemName} moved in ${plan.chunks.length} bulk chunk(s) `
                + `[${plan.chunks.join('+')}] — ${plan.clicks} click(s) against ${naiveClickCost(count)} one at a time`);
        }
    }

    // Remainder finishes one at a time, off the current slot contents.
    const stillThere = (win.slots[sourceSlot] && win.slots[sourceSlot].name === itemName) ? win.slots[sourceSlot].count : 0;
    const alreadyMoved = before - stillThere;
    if (alreadyMoved >= count || stillThere === 0) return alreadyMoved;

    await _click(bot, sourceSlot, 0, 0);   // pick up what remains of the stack
    await sleep(TRANSFER_DELAY_MS);

    let toPlace = count - alreadyMoved;
    // 1) top off existing partial stacks of the same item
    let guard = 0;
    while (toPlace > 0 && guard < 64) {
        guard++;
        const partial = _findPartialStack(win, itemName, destStart, destEnd);
        if (partial === -1) break;
        const slot = win.slots[partial];
        const room = ((slot && slot.stackSize) || 64) - (slot ? slot.count : 0);
        if (room <= 0) break;
        const n = Math.min(room, toPlace);
        for (let i = 0; i < n; i++) await _click(bot, partial, 1, 0);
        toPlace -= n;
    }
    // 2) spill remainder into a fresh empty slot
    if (toPlace > 0) {
        const destSlot = _findEmpty(win, destStart, destEnd);
        if (destSlot !== -1) {
            for (let i = 0; i < toPlace; i++) await _click(bot, destSlot, 1, 0);
        }
    }

    await _click(bot, sourceSlot, 0, 0);   // put remainder back onto source slot
    await sleep(TRANSFER_DELAY_MS);
    const after = (win.slots[sourceSlot] && win.slots[sourceSlot].name === itemName)
        ? win.slots[sourceSlot].count : 0;
    return before - after;
}

async function _transferDeposit(bot, win, item, amount) {
    const total = win.slots.length;
    const containerEnd = Math.max(0, total - 36);
    const invStart = containerEnd;
    const variants = _groupOf(item);
    let deposited = 0;

    for (let i = invStart; i < total; i++) {
        if (deposited >= amount) break;
        const it = win.slots[i];
        if (!it) continue;
        const match = (it.name === item) || (variants && variants.includes(it.name));
        if (!match) continue;

        const remaining = amount - deposited;
        let moved = 0;

        if (it.count <= remaining) {
            const countBefore = it.count;
            await _click(bot, i, 0, 1);
            await sleep(TRANSFER_DELAY_MS);
            const afterSlot = win.slots[i];
            const countAfter = (afterSlot && afterSlot.name === it.name) ? afterSlot.count : 0;
            moved = countBefore - countAfter;
            if (moved === 0) watcher.warn(TAG, `shift-click had no effect — ${it.name} still in slot ${i}`);
        } else {
            moved = await _moveExactDeposit(bot, win, i, remaining, it.name, 0, containerEnd);
        }

        deposited += moved;
    }
    return deposited;
}

async function _transferRetrieve(bot, win, item, target, only = null) {
    const total = win.slots.length;
    const containerEnd = Math.max(0, total - 36);
    const invStart = containerEnd;
    const variants = _retrieveVariants(item, only);
    let retrieved = 0;

    // THE SMALLEST STACK IS TAKEN FIRST, so a withdrawal empties a part stack before it cuts into a full one
    // and the chest is left with fewer slots taken, never more.
    const matching = [];
    for (let s = 0; s < containerEnd; s++) {
        const it = win.slots[s];
        if (it && ((it.name === item) || (variants && variants.includes(it.name)))) matching.push({ s, count: it.count });
    }
    matching.sort((a, b) => a.count - b.count || a.s - b.s);

    for (const { s } of matching) {
        if (retrieved >= target) break;
        const it = win.slots[s];
        if (!it) continue;

        const remaining = target - retrieved;
        let moved = 0;

        if (it.count <= remaining) {
            const countBefore = it.count;
            await _click(bot, s, 0, 1);
            await sleep(TRANSFER_DELAY_MS);
            const afterSlot = win.slots[s];
            const countAfter = (afterSlot && afterSlot.name === it.name) ? afterSlot.count : 0;
            moved = countBefore - countAfter;
            if (moved === 0) watcher.warn(TAG, `shift-click had no effect — ${it.name} still in slot ${s}`);
        } else {
            moved = await _moveExact(bot, win, s, remaining, invStart, total);
        }

        retrieved += moved;
    }
    return retrieved;
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

// Queue at a peer-locked chest: walk there first, then wait for the holder's magnet to clear
// (waitUntilChestFree — the one wait primitive, Law 16). Returns { ok, waited } on release,
// { ok:false, reason } for the caller to _abandon; `waited` flags that the caller's pre-call
// snapshot is stale.
async function _queueAtChest(bot, stationId, pos, orderType, deadline) {
    const holder = stationRegistry.getLockHolder(stationId);
    if (!holder) return { ok: true, waited: false };
    watcher.summary(TAG, `chest ${stationId} is in use by ${holder} — moving there to queue for release.`);
    const locomotion = require('@locomotion/locomotion_dispatcher');
    const moveResult = await locomotion.goToStationStance({ x: pos.x, y: pos.y, z: pos.z });
    if (!moveResult.arrived) {
        return { ok: false, reason: `cannot_reach_locked_${orderType}_chest_at_(${pos.x},${pos.y},${pos.z})_${moveResult.reason}` };
    }
    const wait = await waitUntilChestFree(stationId, {
        timeoutMs: deadline - Date.now(), pollMs: LOCK_QUEUE_POLL_MS,
    });
    if (!wait.released) {
        return { ok: false, reason: `timeout_queueing_for_locked_chest_${stationId}_held_by_${wait.holder || 'unknown'}` };
    }
    watcher.summary(TAG, `chest ${stationId} released after ${Math.round(wait.waitedMs / 1000)}s in queue — proceeding.`);
    return { ok: true, waited: true };
}

// Deterministic per-bot stagger for lock-retry rounds, so two bots that collide once don't re-collide
// the same way (acquireChestLock never preempts a holder, so both back off). A positional string hash
// keeps the delay fixed per bot and distinct between bots — no randomness (Law 19).
function _lockRetryStaggerMs() {
    const id = process.env.BOT_ID || 'default';
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return 100 + (h % 900);
}

// ---------------------------------------------------------------------------
// SECTION 5 — Core transfer logic (shared by both API entry points)
// ---------------------------------------------------------------------------

// ── ONE BODY HOLDS A CHEST, AND THE FOREMAN IS WHO SAYS WHICH ─────────────────────────────────────────
// The magnet's chest lock is what peers read to queue and to skip a chest's stock, but it reaches them
// only through the relay, so two bodies can each write one before seeing the other's. The foreman's
// `chest:<id>` claim is granted to one body at a time; a body holds both before it opens the window.
const _chestClaimKey = (id) => `chest:${id}`;
async function _takeChest(id) {
    if (!stationRegistry.acquireChestLock(id)) return false;
    const link = require('@kernel/foreman_link');
    const grant = await link.requestClaim(_chestClaimKey(id));
    if (grant.granted) { link.sendUpdate(); return true; }
    stationRegistry.unlockChest(id, undefined, `the foreman holds it for a peer (${grant.reason})`);
    return false;
}

// One window carries as many kinds as the caller has: `orders` is always a list of {item, amount} — a
// single move is a list of one, not a second signature (Law 16). Opening a window is a fixed cost paid
// per visit, so batching multiple kinds into one window matters.
async function _executeTransfer(bot, orderType, orders, targetStationId) {
    const stations = stationRegistry.getStations();
    let queuedForLock = false;
    if (!Array.isArray(orders) || orders.length === 0) {
        throw new Error(`[${TAG}] CODING VIOLATION: _executeTransfer needs a non-empty list of {item, amount}.`);
    }
    // Selection needs one representative kind to pick a chest by; the transfer loop uses every entry —
    // a batch is already grouped by destination, so picking the first is not an arbitrary tiebreak.
    const item = orders[0].item;

    // Stamps the start of everything before the window opens (lock acquire, stagger, queue, walk),
    // reported separately from time-in-window so queueing time and clicking time are never conflated
    // (Law 25).
    const waitStartedAt = Date.now();

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
            // Named distinctly from the selector's no-target case below — the caller's chest being gone
            // and there being no suitable chest are different facts (Law 25).
            _abandon(`station_row_gone_${targetStationId}`);
            return;
        }
        target = { id: targetStationId, ...entry };
        // Every storage chest is one pool, so a deposit named at a storage chest is placed by the pool's own
        // rule (spread materials to the least-holding chest, everything else together), read off the
        // pictures before walking; a named chest is kept only when that rule picks it.
        if (orderType === 'deposit' && stationRegistry.isStorage(entry)) {
            const pick = _selectDepositTarget(stations, item);
            if (pick && pick.id !== targetStationId) {
                watcher.summary(TAG, `deposit of ${item} named ${targetStationId}${_hasRoom(bot, entry, item) ? '' : ' (no room per its picture)'}`
                    + ` — the pool rule places it at ${pick.id}.`);
            }
            target = pick;
        }
    } else {
        // Selection sees locked chests too; the selectors prefer an unlocked equivalent, falling back
        // to a locked one only when it's the sole match.
        target = (orderType === 'deposit')
            ? _selectDepositTarget(stations, item)
            : _selectRetrieveTarget(stations, item, orders[0].only || null);
    }

    // No target: for retrieve this is the ordinary multi-bot race (a peer can empty a chest's snapshot
    // between the decision to withdraw and this selector running), so it reports a shortfall for the
    // caller to re-plan instead of escalating through `_abandon` — the shape ({success:false,
    // transferred:0}) is one `supply_manager._withdrawFromChest` (falls back to harvest) and
    // `delivery_executor` (routes a shortfall report) already handle (Law 16). Deposit still abandons:
    // nowhere to put something has no fallback (Law 13).
    if (!target) {
        if (orderType === 'retrieve') {
            watcher.summary(TAG, `no chest holds ${item} when the selector looked — a peer emptied the pool `
                + `between the decision and here; reporting a shortfall so the caller re-plans.`);
            return { success: false, order_type: orderType, item, moved: [], transferred: 0,
                     station_id: null, snapshot_items: 0 };
        }
        _abandon(`no_${orderType}_target_for_${item}`);
        return;
    }

    // Wait-to-act: the plan may count a locked chest, but acting on it requires the lock to clear —
    // queue at the chest, then act on the fresh post-release snapshot.
    const lockDeadline = Date.now() + LOCK_QUEUE_TIMEOUT_MS;
    if (target.locked_by) {
        const q = await _queueAtChest(bot, target.id, target.pos, orderType, lockDeadline);
        if (!q.ok) { _abandon(q.reason); return; }
        queuedForLock = q.waited;
        const fresh = stationRegistry.getStations()[target.id];
        if (fresh) target = { id: target.id, ...fresh };   // holder snapshots on close — refresh
    }

    // Reserves the chest to this bot's magnet so peers wait on it in turn; release is automatic when
    // the magnet clears. First-come wins — a rival winning the race between the stations read and here
    // sends this bot back to queue and retry.
    while (!(await _takeChest(target.id))) {
        if (Date.now() > lockDeadline) { _abandon(`timeout_acquiring_lock_on_chest_${target.id}`); return; }
        const q = await _queueAtChest(bot, target.id, target.pos, orderType, lockDeadline);
        if (!q.ok) { _abandon(q.reason); return; }
        queuedForLock = queuedForLock || q.waited;
        await sleep(_lockRetryStaggerMs());   // de-collide a simultaneous double-grab round
        const fresh = stationRegistry.getStations()[target.id];
        if (fresh) target = { id: target.id, ...fresh };   // holder snapshots on close — refresh
    }

    // From here the lock is held and every exit must drop it — withCleanup instead of a release before
    // each return, since this body has several exits (Law 16: only the guard's catch may swallow, so
    // this catches nothing and a throw passes straight through).
    let audit = null;   // started at the first open, stopped at the close or by the cleanup below
    return await withCleanup(TAG, `chest window on ${target.id}`, async () => {

    // A requested item not present when the lock is finally taken is environmental, not a throw — locks
    // are scoped to the window, so a peer may legitimately empty a chest between a caller's pre-check
    // and this acquire (Law 13).
    if (orderType === 'retrieve' && targetStationId && Array.isArray(target.items)) {
        const missing = orders.filter(o => {
            const variants = _retrieveVariants(o.item, o.only || null);
            return !target.items.some(i => i.name === o.item || (variants && variants.includes(i.name)));
        });
        if (missing.length === orders.length) {
            _abandon(`nothing_of_[${orders.map(o => o.item).join(',')}]_left_in_${targetStationId}`
                + `_when_the_lock_was_taken (a peer emptied it — window-scoped locks, so this is expected)`, true);
            return;
        }
        // A partial hit still proceeds — the kinds that survived are worth the window already paid for.
        if (missing.length) {
            watcher.warn(TAG, `retrieve: ${missing.map(o => o.item).join(', ')} gone from ${targetStationId} `
                + `before the lock was taken — taking the ${orders.length - missing.length} kind(s) still there.`);
            orders = orders.filter(o => !missing.includes(o));
        }
    }

    watcher.summary(TAG, `${orderType} ${orders.map(o => `${o.amount}x ${o.item}`).join(', ')} `
        + `→ ${target.type} at (${target.pos.x},${target.pos.y},${target.pos.z})`);

    // Always walks to the anchor stance, never an LOS goal — a raycast goal can be satisfied from up to
    // 4.5 blocks away, so A* would report `arrived: true` with an empty path and the open then fails at
    // the server. No speculative open before the walk either, for the same reason: succeeding from
    // wherever the body happens to stand is not a stance the bot should be using a chest from. The
    // retry loop below still waits out a chest a peer genuinely holds open.
    const locomotion = require('@locomotion/locomotion_dispatcher');
    // The walk is travel, not waiting — clocked on its own so the wait figure holds only standing time.
    const walkStartedAt = Date.now();
    const moveResult = await locomotion.goToStationStance({ x: target.pos.x, y: target.pos.y, z: target.pos.z });
    const walkMs = Date.now() - walkStartedAt;
    if (!moveResult.arrived) {
        _abandon(`cannot_reach_${orderType}_chest_at_(${target.pos.x},${target.pos.y},${target.pos.z}) — ${moveResult.reason}`);
        return;
    }

    audit = _startAudit(bot);
    let openRes = await _openWindow(bot, target.pos, target.id);

    // A chest that won't open is a chest a peer has open right now — Minecraft allows one window per
    // container and the registry lock is only advisory, so the server's refusal is the authoritative
    // in-use signal and gets the same answer as everywhere else in this file: queue and take a turn
    // (Law 16). The stagger pairs with `_queueAtChest` because the registry may not yet record the
    // holder that produced this failure, so without it two bots that collided once would re-collide on
    // the same cadence.
    while (!openRes.ok && Date.now() <= lockDeadline) {
        const q = await _queueAtChest(bot, target.id, target.pos, orderType, lockDeadline);
        if (!q.ok) { _abandon(q.reason); return; }
        await sleep(_lockRetryStaggerMs());
        openRes = await _openWindow(bot, target.pos, target.id);
    }
    if (!openRes.ok) {
        _abandon(`open_failed_after_queue: ${openRes.reason} at (${target.pos.x},${target.pos.y},${target.pos.z})`);
        return;
    }
    // The picture is read under the lock, so no peer can move it between this read and the window.
    let row = stationRegistry.getStations()[target.id];
    let pictured = (row && Array.isArray(row.items))
        ? await _awaitPicture(openRes.window, target.id, row.items, openRes.clickedAt)
        : null;
    // The transfer works in the window the server has open — the one mineflayer's clicks go to. A later
    // window for this chest replaces the first, and its contents are checked against the picture again.
    if (bot.currentWindow && bot.currentWindow !== openRes.window) {
        watcher.warn(TAG, `chest ${target.id}: the server replaced window #${openRes.window.id} with #${bot.currentWindow.id} — working in #${bot.currentWindow.id}.`);
        openRes = { ...openRes, window: bot.currentWindow };
        // Read again: a forgiven first window rewrote the picture.
        row = stationRegistry.getStations()[target.id];
        if (row && Array.isArray(row.items)) pictured = await _awaitPicture(openRes.window, target.id, row.items, openRes.clickedAt);
    }

    // Measured open→close, never around the clicks — the chest is locked for the whole window, so
    // occupancy is the cost charged to the fleet and clicking is only what fills it.
    const openedAt = Date.now();
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
    for (const order of orders) {
        // Read at the open window, after the walk and the queue: what peers claimed on the way counts.
        let amount = order.amount;
        if (orderType === 'retrieve') {
            const free = _unclaimedFor(order.item, order.only || null);
            if (free < amount) {
                watcher.summary(TAG, `retrieve of ${order.item} held to ${free} of ${amount} at the window — the rest is claimed by other bodies.`);
                amount = free;
            }
            if (amount <= 0) continue;
        }
        const got = orderType === 'deposit'
            ? await _transferDeposit(bot, openRes.window, order.item, order.amount)
            : await _transferRetrieve(bot, openRes.window, order.item, amount, order.only || null);
        transferred += got;
        if (got > 0) moved.push({ item: order.item, transferred: got });
        // What this body took is no longer in the chests for its claim to hold.
        if (got > 0 && orderType === 'retrieve') require('@perception/chest_ledger').drawn(order.item, got);
    }

    await sleep(100); // 2 server ticks — let slot updates settle before snapshot
    const snapshot = _snapshotItems(openRes.window);
    stationRegistry.snapshotStation(target.id, snapshot);

    await _closeWindow(bot);
    _reportAudit(bot, audit, target.id, orderType, snapshot);
    // The window's own contents go with the move, so the foreman checks its figure for this chest.
    await book.close(orderType, `container:${target.id}`);
    book.report({ k: 'ca', id: target.id, items: _tally(snapshot) });
    book.flush();

    const snapshotSummary = snapshot.length > 0
        ? snapshot.map(i => `${i.name} x${i.count}`).join(', ')
        : 'empty';
    const openMs = Date.now() - openedAt;
    const waitMs = openedAt - waitStartedAt;
    // One line per window, not per kind — the window is what a peer queues behind, so a per-kind line
    // would inflate the contention figure (Law 25); the kind list carries what actually moved.
    watcher.summary(TAG, `${orderType} complete — ${orders.length} kind(s), ${transferred} item(s) `
        + `[${moved.length ? moved.map(m => `${m.item} x${m.transferred}`).join(', ') : 'nothing moved'}] `
        + `in ${(openMs / 1000).toFixed(1)}s open `
        + `(${transferred > 0 ? Math.round(openMs / transferred) : openMs}ms/item) after ${(waitMs / 1000).toFixed(1)}s waiting to get in. `
        + `Chest ${target.id}: ${snapshot.length} stack(s) [${snapshotSummary}].`
        + (pictured == null ? ' No picture on record.'
            : pictured.forgiven ? ` Contents did not match the picture and were forgiven after ${pictured.ms}ms.`
            : ` Contents matched the picture in ${pictured.ms}ms.`)
        + ` Walked ${(walkMs / 1000).toFixed(1)}s of the wait.`);

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
        // clearMagnet() is still the backstop for a bot that dies mid-window; this is the ordinary
        // release.
        if (audit) _stopAudit(bot, audit);
        stationRegistry.unlockChest(target.id, undefined, 'chest window closed');
        // The picture and the release reach the fleet in one update, so the next body sees both at once;
        // the foreman's grant is dropped after it, so the next holder already has the picture.
        const link = require('@kernel/foreman_link');
        link.sendUpdate();
        link.releaseClaim(_chestClaimKey(target.id));
    });
}

// ---------------------------------------------------------------------------
// SECTION 6 — Exported API (Law 15 entry points)
// ---------------------------------------------------------------------------

async function depositItems(bot, item, amount, stationId) {
    bot = bot || global.bot;
    if (!bot) throw new Error('[inventory_swapper] CODING VIOLATION: depositItems called with no bot loaded.');
    return _executeTransfer(bot, 'deposit', [{ item, amount: amount || 64 }], stationId);
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

    // Every registered chest is a destination — no role filtering. Read once for the whole dump
    // (Invariant B): every kind is placed against one consistent snapshot of what's full and locked, so
    // two kinds can't pick the same last free slot.
    const stations = stationRegistry.getStations();
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

    const dumpResults = [];

    // One window per chest, never one per kind — items are grouped by chosen destination and moved
    // together, since each window pays the fixed open/close cost regardless of item count.
    const byChest = new Map();
    for (const [item, amount] of Object.entries(excess)) {
        // Consolidate this kind where it already sits if that chest has room, else any chest with room
        // — `_selectDepositTarget` is the fleet's one which-chest selector (Law 16).
        const targetStation = _selectDepositTarget(stations, item);
        if (!targetStation) {
            watcher.summary(TAG, 'dumpExcess: every chest is full — stopping');
            break;
        }
        if (!byChest.has(targetStation.id)) byChest.set(targetStation.id, []);
        byChest.get(targetStation.id).push({ item, amount });
    }

    // A deposit announces nothing — material counts once it's in the chest, and peers see it the moment
    // `_executeTransfer` snapshots it; the transfer itself is the announcement.
    for (const [stationId, orders] of byChest) {
        const item = orders.map(o => o.item).join('+');   // for the abandonment message only
        const result = await _executeTransfer(bot, 'deposit', orders, stationId);

        // Abandonment propagates instead of being swallowed: _executeTransfer returns undefined only
        // after already routing a fresh signal to recursive_judge (Law 15 caller abandonment), so this
        // line must stop instead of letting the caller route a second signal (Law 4: one signal).
        if (result === undefined) {
            watcher.warn(TAG, `dumpExcess: transfer of ${item} abandoned to the judge — stopping the dump and reporting it so the caller does not route again.`);
            return { dumped: dumpResults.length, items: dumpResults, abandoned: true };
        }
        // Per-kind rows, not one row per window — the caller's report and the compost row above are
        // both per-kind.
        for (const m of (result.moved || [])) dumpResults.push({ item: m.item, transferred: m.transferred });
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
