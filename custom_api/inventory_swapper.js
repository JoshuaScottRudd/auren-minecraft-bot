// fragment: inventory_swapper
// purpose: Law 15 API — depositItems, retrieveItems and dumpExcess handle all
//          chest interaction: select a storage chest, navigate there, open it,
//          transfer items, snapshot contents, update station_registry, and close.
//          dumpExcess reads INVENTORY_WHITELIST from job_board and dumps everything
//          the bot is not whitelisted to keep.
//          Called directly by preconstruction, build_executor, delivery_executor,
//          supply_manager, furnace_executor, and any fragment that needs chest
//          deposit/withdrawal. No signal-bus entry.
//
// EVERY CHEST IS THE SAME CHEST. Nothing here filters by a chest role — the roles
// ('requester'/'buffer') are deleted, because a stock request is a figure measured across the whole
// chest system rather than an address (see station_registry's header). Selection is about ROOM and
// CONSOLIDATION and LOCKS, never about what a chest is "for".
//
// NESTED API (Law 15): inventory_swapper calls the locomotion API (goTo) to reach chests.
// Locomotion already owns its own abandonment clause — if it can't reach the chest it
// returns arrived=false. inventory_swapper treats unreachable chests as an environmental
// failure and abandons the caller (Law 15 caller abandonment), originating a fresh signal
// to recursive_judge.
//
// invariants:
//  - depositItems/retrieveItems only throw on coding violations (missing bot). Every other
//    outcome (no chest found, chest unreachable, open failed, zero items transferred) is
//    an environmental failure handled through caller abandonment (Law 13 + Law 15).
//  - Station selection is deterministic: deposit fills the lowest-ID chest with room,
//    retrieve picks the first chest containing the needed item.
//  - Peer-locked chests: LOCKED means wait-to-act, never invisible. getStations shows
//    a locked chest's last snapshot to every calculation (stamped `locked_by`), so
//    selection here MAY pick one — e.g. the only chest holding logs is in use — and
//    the transfer then queues: walk to the chest, wait for the holder's magnet to
//    clear (waitUntilChestFree, @utils/chest_lock_utils), re-read the fresh snapshot,
//    proceed. Unlocked chests are preferred when otherwise equivalent. Bounded by
//    LOCK_QUEUE_TIMEOUT_MS → abandonment (also covers the two-bots-waiting-on-each-
//    other deadlock: both time out, both replan from the judge).

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const stationRegistry = require('@perception/station_registry');
const { group_to_item } = require('@utils/fragment_utils');
const { waitUntilChestFree } = require('@utils/chest_lock_utils');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternalSync, withCleanup } = require('@utils/external_library_guard');

const TAG = 'inventory_swapper';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STORAGE_TYPES = new Set(['chest', 'trapped_chest', 'barrel']);
const OPEN_DELAY_MS = 250;
const TRANSFER_DELAY_MS = 160;
const CLOSE_SETTLE_MS = 80;
const MAX_CLOSE_TRIES = 8;
// INTERACTION_RANGE IS DELETED (2026-08-31). It gated a speculative "try opening from wherever you happen
// to be standing" before any walk, on the reasoning that the server's own refusal is the ground truth and
// an attempt costs nothing. The attempt is not free: when it SUCCEEDS from four blocks away it succeeds
// from a place the bot should not be using a chest from — through a wall, from outside the building — and
// the Architect ruled that out on shared-world grounds, not on reach grounds. A chest is opened from its
// blueprint anchor or not at all (see the approach in _transfer below).
// A peer's chest lock now releases when its WINDOW closes (2026-08-14), so an honest wait is seconds, not
// the job tail this was sized for. Kept at 120s rather than cut to match: the timeout's job is to catch a
// lock that is never coming back (a bot killed mid-window, released only by clearMagnet), and sizing it to
// the happy path would abandon real work to save time nothing normally spends.
const LOCK_QUEUE_TIMEOUT_MS = 120000;
const LOCK_QUEUE_POLL_MS = 1000;

// ---------------------------------------------------------------------------
// SECTION 1 — Station selection
// ---------------------------------------------------------------------------

function _parsePos(posId) {
    const [x, y, z] = posId.split('|').map(Number);
    return { x, y, z };
}

// Phase 4 Fix B: among chests with room, prefer one already holding `item`
// (or a variant) so a type stays consolidated in one chest instead of smeared
// across several. A LOCKED chest is a legal candidate (its snapshot is visible;
// use waits for release) but an unlocked equivalent wins — consolidation still
// outranks the lock, because a few seconds' queue is cheaper than smearing a
// type across chests. Coordinate order is the final tiebreak.
function _selectDepositTarget(stations, item) {
    const variants = (item && group_to_item && group_to_item[item]) || null;
    const candidates = [];
    for (const [id, entry] of Object.entries(stations)) {
        if (!entry || !STORAGE_TYPES.has(entry.type)) continue;
        const capacity = entry.capacity || 27;
        const occupied = Array.isArray(entry.items) ? entry.items.length : 0;
        if (occupied < capacity) {
            const holdsItem = Array.isArray(entry.items) && entry.items.some(i =>
                i.name === item || (variants && variants.includes(i.name))
            );
            candidates.push({ id, ...entry, holdsItem });
        }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (a.holdsItem !== b.holdsItem) return a.holdsItem ? -1 : 1;
        if (!a.locked_by !== !b.locked_by) return a.locked_by ? 1 : -1;
        const pa = _parsePos(a.id);
        const pb = _parsePos(b.id);
        return (pa.x - pb.x) || (pa.y - pb.y) || (pa.z - pb.z);
    });
    return candidates[0];
}

// Retrieve: first unlocked chest holding the item; when ONLY a locked chest
// holds it (the "25 logs are in the chest Tessa is using" case) return that one
// — the snapshot says the material exists, so waiting a few seconds beats
// reporting no-source and triggering a pointless harvest.
function _selectRetrieveTarget(stations, item) {
    const variants = (group_to_item && group_to_item[item]) || null;
    let lockedFallback = null;
    for (const [id, entry] of Object.entries(stations)) {
        if (!entry || !STORAGE_TYPES.has(entry.type) || !Array.isArray(entry.items)) continue;
        const hasItem = entry.items.some(i =>
            i.name === item || (variants && variants.includes(i.name))
        );
        if (!hasItem) continue;
        if (!entry.locked_by) return { id, ...entry };
        if (!lockedFallback) lockedFallback = { id, ...entry };
    }
    return lockedFallback;
}

// `_selectTransferSource` AND `transferBetweenChests` ARE DELETED — the chest→chest courier is gone, and
// its impossibility is the argument rather than its disuse.
//
// It moved material from a 'buffer' chest into a 'requester' chest to close a stock shortfall without
// harvesting. That made sense while a request was addressed to ONE chest. It cannot make sense now: a
// `storage` request is measured across EVERY registered chest at once, so moving a stack from chest A to
// chest B leaves the measured figure bit-for-bit identical. The courier could only ever report success
// against a deficit that had not moved — the job releases, the shortfall re-posts unchanged, and the
// fleet shuffles the same stack between two chests forever (Law 25: a signal that says `done` about a
// criterion it did not meet; Law 16: a route that cannot produce its own outcome).
//
// The Architect had already ruled the naming half of this on 2026-08-14 — *"no seperation of buffer and
// requester chest… every chest is a buffer and requester chest"* — and the role filter came off this
// selector then. What survived was the courier itself, kept alive by an address that no longer decided
// anything. Withdraw (`retrieveItems`) and deposit (`depositItems`/`dumpExcess`) are the only chest
// movements left, and both cross the pocket boundary, which is where a figure actually changes.

// ---------------------------------------------------------------------------
// SECTION 2 — Window management
// ---------------------------------------------------------------------------

async function _openWindow(bot, pos) {
    const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) return { ok: false, reason: 'block_not_found' };
    await bot.activateBlock(block);
    await sleep(OPEN_DELAY_MS);
    if (!bot.currentWindow) return { ok: false, reason: 'no_window' };
    return { ok: true, window: bot.currentWindow };
}

async function _closeWindow(bot) {
    if (!bot || !bot.currentWindow) return;
    // The close REQUEST is fire-and-forget by design — the settle loop below is the actual measurement,
    // reading bot.currentWindow rather than trusting the call (Invariant B), so a refused packet needs
    // no separate branch here.
    if (typeof bot.closeWindow === 'function') {
        guardExternalSync(TAG, 'closeWindow', () => bot.closeWindow(bot.currentWindow));
    }
    let tries = 0;
    while (bot.currentWindow && tries < MAX_CLOSE_TRIES) { await sleep(CLOSE_SETTLE_MS); tries++; }
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
// _click: promise wrapper around bot.clickWindow
// _shiftClick: move an entire stack between inventory sections (fast)
// _moveExact: pick up a stack, right-click N items onto a dest slot, put back
//
// Both deposit and retrieve check: if the stack fits within the remaining
// amount, shift-click (fast). If the stack exceeds it, use _moveExact to
// transfer only what's needed.
// ---------------------------------------------------------------------------

async function _click(bot, slot, button, mode) {
    await new Promise(res => {
        // The 150 ms timer, not the callback, is what bounds this: a click the server never answers must
        // not park the window session forever. A refused packet resolves immediately for the same reason
        // — every transfer is verified against the window's slots afterward, never against this call.
        const timer = setTimeout(res, 150);
        const sent = guardExternalSync(TAG, `clickWindow slot ${slot}`, () =>
            bot.clickWindow(slot, button, mode, () => { clearTimeout(timer); res(); }));
        if (!sent.ok) { clearTimeout(timer); res(); }
    });
}

function _findEmpty(win, start, end) {
    for (let i = start; i < end; i++) {
        if (!win.slots[i]) return i;
    }
    return -1;
}

// Phase 4 Fix A: a slot already holding `itemName` below its max stack size.
// Topping this off before opening a fresh empty slot is what consolidates
// repeated partial deposits (torch:3,3,3 → torch:9). Matches the concrete name
// only — never merges different variants (oak_log tops oak_log, not birch_log).
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

    for (let i = 0; i < count; i++) {
        await _click(bot, destSlot, 1, 0); // right-click places 1 item
        await sleep(50);
    }

    await _click(bot, sourceSlot, 0, 0);   // put remainder back
    await sleep(TRANSFER_DELAY_MS);
    const destItem = win.slots[destSlot];
    return destItem ? destItem.count : 0;
}

// Deposit variant of _moveExact (Phase 4 Fix A). Picks up the source stack once,
// then pours `count` items first onto existing partial stacks of the same item
// (respecting stackSize headroom), and only spills the remainder into a fresh
// empty slot. Returns the amount actually deposited, measured off the source
// slot delta so a multi-slot split still reports an accurate count.
async function _moveExactDeposit(bot, win, sourceSlot, count, itemName, destStart, destEnd) {
    const before = win.slots[sourceSlot] ? win.slots[sourceSlot].count : 0;

    // BULK CHUNKS FIRST, SINGLES ONLY FOR WHAT IS LEFT (Architect 2026-08-13). A right-click on the source
    // with an empty hand lifts ceil(n/2) and a left-click on an EMPTY destination slot drops the whole held
    // stack — two clicks for any size. The old path picked the full stack up and placed the count one item
    // at a time, which is where the twenty seconds at a chest came from. The plan is arithmetic and lives
    // in its own calculator so it can be checked without a world (Law 26).
    //
    // EMPTY SLOTS ONLY for a chunk drop, deliberately: left-clicking onto an existing partial stack merges
    // up to stackSize and silently leaves the rest in hand, which would make the source-delta measurement
    // below a lie (Law 25). Topping off partials is what the singles loop is for. No empty slot → the plan
    // is skipped entirely and the original path runs, so this can never lose items by being clever.
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

    // Whatever the chunks did not cover is finished the old way, off the CURRENT slot contents.
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
        for (let i = 0; i < n; i++) { await _click(bot, partial, 1, 0); await sleep(50); }
        toPlace -= n;
    }
    // 2) spill remainder into a fresh empty slot
    if (toPlace > 0) {
        const destSlot = _findEmpty(win, destStart, destEnd);
        if (destSlot !== -1) {
            for (let i = 0; i < toPlace; i++) { await _click(bot, destSlot, 1, 0); await sleep(50); }
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
    const variants = (group_to_item && group_to_item[item]) || null;
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

async function _transferRetrieve(bot, win, item, target) {
    const total = win.slots.length;
    const containerEnd = Math.max(0, total - 36);
    const invStart = containerEnd;
    const variants = (group_to_item && group_to_item[item]) || null;
    let retrieved = 0;

    for (let s = 0; s < containerEnd; s++) {
        if (retrieved >= target) break;
        const it = win.slots[s];
        if (!it) continue;
        const match = (it.name === item) || (variants && variants.includes(it.name));
        if (!match) continue;

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

function _abandon(reason) {
    watcher.warn(TAG, `Abandoning caller — ${reason}`);
    routeToJudge(TAG, { result: TAG, success: false, readable: `${TAG}: ${reason}` });
}

// Queue in line at a peer-locked chest: walk there first (the wait happens AT
// the station, so the travel cost is paid while the peer is still working),
// then wait for the holder's magnet to clear (waitUntilChestFree — the one
// wait primitive, Law 16). Returns { ok, waited } on release, { ok:false,
// reason } for the caller to _abandon. `waited` tells the caller its pre-call
// snapshot knowledge is stale (the peer may have drained/filled the chest
// while we stood in line).
async function _queueAtChest(bot, stationId, pos, orderType, deadline) {
    const holder = stationRegistry.getLockHolder(stationId);
    if (!holder) return { ok: true, waited: false };
    watcher.summary(TAG, `chest ${stationId} is in use by ${holder} — moving there to queue for release.`);
    const locomotion = require('@locomotion/locomotion_dispatcher');
    const moveResult = await locomotion.goToStationAnchor({ x: pos.x, y: pos.y, z: pos.z });
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

// Per-bot deterministic stagger for lock-retry rounds. A simultaneous double-grab
// makes BOTH bots back off (acquireChestLock never preempts a holder), so the
// retry must not re-collide the same way. A positional string hash keeps the
// delay fixed per bot and distinct between bots — no randomness (Law 19: same
// fleet, same spacing, every run).
function _lockRetryStaggerMs() {
    const id = process.env.BOT_ID || 'default';
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return 100 + (h % 900);
}

// ---------------------------------------------------------------------------
// SECTION 5 — Core transfer logic (shared by both API entry points)
// ---------------------------------------------------------------------------

// ONE WINDOW CARRIES AS MANY KINDS AS THE CALLER HAS (Architect 2026-08-14, ranked #3 of four).
// `orders` is ALWAYS a list of {item, amount} — a single move is a list of one, not a second signature,
// because two entry shapes is how a batching path and a non-batching path drift apart (Law 16).
//
// WHAT IT COSTS TO OPEN A WINDOW AT ALL: measured on the 2026-08-14 soak, 21 of 38 moves carried two items
// or fewer at 446ms/item, against 197ms/item for the seventeen larger ones. The open/close is a fixed cost
// and a one-item trip pays it in full. The dump was the worst offender — it opened the same chest once per
// item kind, so a pocket holding dirt, a peony and a mushroom paid three windows for one visit.
async function _executeTransfer(bot, orderType, orders, targetStationId) {
    const stations = stationRegistry.getStations();
    let queuedForLock = false;
    if (!Array.isArray(orders) || orders.length === 0) {
        throw new Error(`[${TAG}] CODING VIOLATION: _executeTransfer needs a non-empty list of {item, amount}.`);
    }
    // Selection needs ONE representative kind to choose a chest by; the transfer loop uses every entry.
    // A batch is grouped by destination before it gets here, so the kinds in one call already agreed on
    // where they were going — picking the first is not an arbitrary tiebreak.
    const item = orders[0].item;

    // WHAT IT COST TO GET IN (Architect 2026-08-13: *"also add that queue timer as well. its good
    // information."*). The open→close timer added beside it showed chest work is ~0.4s and 18ms/item — so
    // his "standing at a chest for up to 20 seconds" was never the clicking. The trace already carried the
    // answer in a line nobody was totalling: `chest released after 23s in queue`. This stamps the start of
    // everything BEFORE the window opens — lock acquire, stagger, queue, walk — so the two costs are
    // reported side by side and can never again be mistaken for each other (Law 25: a number that answers
    // a different question than the reader's is a false verdict however true it is).
    const waitStartedAt = Date.now();

    let target;
    if (targetStationId) {
        const entry = stations[targetStationId];
        if (entry) target = { id: targetStationId, ...entry };
    } else {
        // Selection sees locked chests too (their snapshots are countable state);
        // the selectors prefer an unlocked equivalent and fall back to a locked
        // one only when it's the sole chest that can serve the request.
        target = (orderType === 'deposit')
            ? _selectDepositTarget(stations, item)
            : _selectRetrieveTarget(stations, item);
    }

    if (!target) {
        _abandon(`no_${orderType}_target_for_${item}`);
        return;
    }

    // Wait-to-act: the plan was allowed to count this chest while locked, but
    // ACTING on it requires the lock to clear — queue at the chest, then act on
    // the fresh post-release snapshot (never the one the plan saw).
    const lockDeadline = Date.now() + LOCK_QUEUE_TIMEOUT_MS;
    if (target.locked_by) {
        const q = await _queueAtChest(bot, target.id, target.pos, orderType, lockDeadline);
        if (!q.ok) { _abandon(q.reason); return; }
        queuedForLock = q.waited;
        const fresh = stationRegistry.getStations()[target.id];
        if (fresh) target = { id: target.id, ...fresh };   // holder snapshots on close — refresh
    }

    // Phase 3: the bot has now decided to use this chest — reserve it to its
    // magnet so peers wait on us in turn (release is automatic when the magnet
    // clears). First-come wins: if a rival got the lock between our stations
    // read and here, we queue at the chest and retry. Single-bot: inert.
    while (!stationRegistry.acquireChestLock(target.id)) {
        if (Date.now() > lockDeadline) { _abandon(`timeout_acquiring_lock_on_chest_${target.id}`); return; }
        const q = await _queueAtChest(bot, target.id, target.pos, orderType, lockDeadline);
        if (!q.ok) { _abandon(q.reason); return; }
        queuedForLock = queuedForLock || q.waited;
        await sleep(_lockRetryStaggerMs());   // de-collide a simultaneous double-grab round
        const fresh = stationRegistry.getStations()[target.id];
        if (fresh) target = { id: target.id, ...fresh };   // holder snapshots on close — refresh
    }

    // FROM HERE THE LOCK IS HELD, AND EVERY EXIT MUST DROP IT. withCleanup rather than a release before
    // each `return`: this body has seven exits and the eighth added later would be the one that leaks a
    // chest for the rest of the job. withCleanup CATCHES NOTHING — a throw passes straight through it, so
    // this is resource cleanup and not a guard (Law 16: the only catch in the fleet is the guard's).
    return await withCleanup(TAG, `chest window on ${target.id}`, async () => {

    // A REQUESTED ITEM THAT IS NOT THERE IS NOW ENVIRONMENTAL, AND THE THROW THAT USED TO GUARD IT IS GONE
    // (2026-08-14, a direct consequence of scoping the lock to the window). It read as a Law 13 coding
    // violation — a caller must pre-check the snapshot, so an absent item meant the check was skipped —
    // with one exception for having queued behind a peer. Window-scoped locks make that exception the
    // ordinary case: nothing holds a chest between a caller's pre-check and this acquire, so any peer may
    // legitimately empty it in between, with or without us queueing. Law 13's own test settles it — this
    // CAN happen in a correctly-written system in a normal world, so it soft-fails to the judge for a
    // replan. Keeping the throw would have turned routine two-bot contention into a dead fleet.
    if (orderType === 'retrieve' && targetStationId && Array.isArray(target.items)) {
        const missing = orders.filter(o => {
            const variants = (group_to_item && group_to_item[o.item]) || null;
            return !target.items.some(i => i.name === o.item || (variants && variants.includes(i.name)));
        });
        if (missing.length === orders.length) {
            _abandon(`nothing_of_[${orders.map(o => o.item).join(',')}]_left_in_${targetStationId}`
                + `_when_the_lock_was_taken (a peer emptied it — window-scoped locks, so this is expected)`);
            return;
        }
        // A partial hit still proceeds: the kinds that survived are worth the window we already paid for.
        if (missing.length) {
            watcher.warn(TAG, `retrieve: ${missing.map(o => o.item).join(', ')} gone from ${targetStationId} `
                + `before the lock was taken — taking the ${orders.length - missing.length} kind(s) still there.`);
            orders = orders.filter(o => !missing.includes(o));
        }
    }

    watcher.summary(TAG, `${orderType} ${orders.map(o => `${o.amount}x ${o.item}`).join(', ')} `
        + `→ ${target.type} at (${target.pos.x},${target.pos.y},${target.pos.z})`);

    // GO TO THE ANCHOR FIRST, ALWAYS. THIS IS THE CHEST LOOP THE ARCHITECT WATCHED (2026-08-31: *"right
    // now auren is stuck on a loop trying to use a chest that it can see but cant get to"*), and "can see
    // but can't get to" was the literal mechanism: the approach used an LOS goal, satisfied by a raycast
    // from up to 4.5 blocks away, so A* found the body ALREADY at the goal, returned an empty path, and
    // reported arrived: true without a step being taken. Control came back here, the open failed at the
    // server, and the retry loop below spun against a body that was never going to be close enough — for
    // the whole lock deadline, every time.
    //
    // THE SPECULATIVE OPEN-BEFORE-WALKING IS GONE, and deliberately. It fired whenever the body happened
    // to be inside BLOCK_REACH, which is the server's ceiling and not a stance — including from outside
    // the building, reaching a chest through the wall (*"i dont want to violate shared world rules and
    // having the bots using chests on the outside of the building through a wall breaking immersion"*).
    // A shortcut that sometimes works from a place the bot should not be standing is not an optimisation;
    // it is the non-deterministic stance wearing a different hat. And it bought nothing: the anchor walk
    // returns an empty path when the body is already on the anchor.
    //
    // The retry loop below is NOT the defect and is not weakened: a chest a peer holds open really does
    // need waiting out. What was wrong is that it was being fed an arrival that had not happened.
    const locomotion = require('@locomotion/locomotion_dispatcher');
    const moveResult = await locomotion.goToStationAnchor({ x: target.pos.x, y: target.pos.y, z: target.pos.z });
    if (!moveResult.arrived) {
        _abandon(`cannot_reach_${orderType}_chest_at_(${target.pos.x},${target.pos.y},${target.pos.z}) — ${moveResult.reason}`);
        return;
    }

    let openRes = await _openWindow(bot, target.pos);

    // A CHEST THAT WILL NOT OPEN IS A CHEST A PEER HAS OPEN RIGHT NOW (Architect 2026-08-13:
    // *"theres only one reason why it cant open a chest, thats if another bot is using it. reuse
    // inventory swapper queue waiting system to wait its turn"*). Minecraft allows one window per
    // container, and the registry lock above is ADVISORY: it stops two bots DECIDING to use a chest,
    // it cannot stop a window a peer already holds at the server. So the server's refusal is the
    // authoritative in-use signal, and the answer to in-use is the one this file already gives
    // everywhere else — queue and take your turn (Law 16: one waiting system, not a second one
    // invented here). Before this, an open failure abandoned instantly, which turned an ordinary
    // two-bots-one-chest collision into a dead job.
    //
    // AND THE CLAIM IS NOW TRUE AGAIN. It was not, between 2026-08-13 and today: with the stance
    // approximate, "cannot open" also meant "standing too far away or at an angle the server refuses",
    // and this loop faithfully waited out a peer who was not there. Standing on the authored anchor
    // removes that second cause, which is what makes the sentence above a diagnosis rather than a guess.
    //
    // THE STAGGER IS LOAD-BEARING, and _queueAtChest alone is not enough: it returns immediately when
    // the registry names no holder, which is precisely the case that produced the failure (the peer
    // has the window without our registry recording it). So the retry pairs it with the same
    // deterministic per-bot stagger the lock-acquire loop above uses — without it, two bots that
    // collided once re-collide on the same cadence until the deadline.
    while (!openRes.ok && Date.now() <= lockDeadline) {
        const q = await _queueAtChest(bot, target.id, target.pos, orderType, lockDeadline);
        if (!q.ok) { _abandon(q.reason); return; }
        await sleep(_lockRetryStaggerMs());
        openRes = await _openWindow(bot, target.pos);
    }
    if (!openRes.ok) {
        _abandon(`open_failed_after_queue: ${openRes.reason} at (${target.pos.x},${target.pos.y},${target.pos.z})`);
        return;
    }

    // HOW LONG THE CHEST WAS OPEN (Architect 2026-08-13: *"also put a timer on it and report how long the
    // chest was open for so we can track optimization"*). Measured across open→close, not around the
    // clicks: while the window is open the chest is LOCKED and every peer wanting it is queued behind this
    // number, so the occupancy is the cost to the fleet — the clicking is only what fills it.
    const openedAt = Date.now();

    let transferred = 0;
    const moved = [];
    for (const order of orders) {
        const got = orderType === 'deposit'
            ? await _transferDeposit(bot, openRes.window, order.item, order.amount)
            : await _transferRetrieve(bot, openRes.window, order.item, order.amount);
        transferred += got;
        if (got > 0) moved.push({ item: order.item, transferred: got });
    }

    await sleep(100); // 2 server ticks — let slot updates settle before snapshot
    const snapshot = _snapshotItems(openRes.window);
    stationRegistry.snapshotStation(target.id, snapshot);

    await _closeWindow(bot);

    const snapshotSummary = snapshot.length > 0
        ? snapshot.map(i => `${i.name} x${i.count}`).join(', ')
        : 'empty';
    const openMs = Date.now() - openedAt;
    const waitMs = openedAt - waitStartedAt;
    // ONE LINE PER WINDOW, never one per kind, because the window is what a peer queues behind — a
    // per-kind line would make one visit look like three and inflate the contention figure --inventory
    // reduces (Law 25). The kind list carries what actually moved.
    watcher.summary(TAG, `${orderType} complete — ${orders.length} kind(s), ${transferred} item(s) `
        + `[${moved.length ? moved.map(m => `${m.item} x${m.transferred}`).join(', ') : 'nothing moved'}] `
        + `in ${(openMs / 1000).toFixed(1)}s open `
        + `(${transferred > 0 ? Math.round(openMs / transferred) : openMs}ms/item) after ${(waitMs / 1000).toFixed(1)}s waiting to get in. `
        + `Chest ${target.id}: ${snapshot.length} stack(s) [${snapshotSummary}].`);

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
        // The magnet's clearMagnet() is still the backstop for a bot that dies mid-window; this is the
        // ordinary release, and it turns a ~90s hold into a ~0.4s one.
        stationRegistry.unlockChest(target.id, undefined, 'chest window closed');
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

async function retrieveItems(bot, item, amount, stationId) {
    bot = bot || global.bot;
    if (!bot) throw new Error('[inventory_swapper] CODING VIOLATION: retrieveItems called with no bot loaded.');
    return _executeTransfer(bot, 'retrieve', [{ item, amount: amount || 64 }], stationId);
}

// computeExcess — the single dump-threshold math (Law 16). Given raw inventory counts
// {name:count} and INVENTORY_WHITELIST ([{item, keep}], where item may be a group
// token like 'logs'), return {name: overAmount} for everything above its keep
// allowance. Group tokens share ONE allowance across their concrete members (keep
// 10 logs total, not 10 per variant); anything no whitelist entry covers is fully
// excess. Backs both dumpExcess (the actual dump) and job_board's dump-gate (does a
// dump move anything?) so the two can never disagree on what "excess" means.
// `wanted` — WHAT THE ASKER IS ACTIVELY WORKING TOWARD, AND IT OVERRIDES THE ROWS.
//
// The allowances above are authored per item, and a demand that is DERIVED cannot be expressed in them:
// there is no row for charcoal because nothing wants a standing pile of it — what wants it is whichever
// order happens to be short of it right now, and that changes every sweep. With rows as the only input,
// "no row" means "100% excess", so the fleet banked the exact material its own next craft was waiting on
// and then had to fetch it back out (Law 16 — the withdraw and the dump undoing each other is one job
// done twice, in opposite directions).
//
// AN ALLOWANCE IS A FLOOR, NEVER A CEILING, WHICH IS WHY THIS IS max() AND NOT A SEPARATE BRANCH. A row
// says "always keep this much"; a live demand says "this much is spoken for". Taking the larger keeps
// both promises, and taking either alone breaks one of them.
//
// GROUP TOKENS RESOLVE ON THE WAY IN, because a demand speaks the RECIPE's vocabulary and a pocket speaks
// the world's: an order wants `planks` and the bot is holding `oak_planks`. Matching those literally reports
// no demand for anything the fleet actually asked for, which is the failure this whole argument is about,
// one level down.
//
// PASSED BY THE CALLER, NEVER READ FROM HERE. Whose demand counts differs per asker — a bot deciding
// whether to bank a stack answers to its OWN claimed work, and a fleet-wide want would have every bot
// hoarding for orders it is not doing (Law 25: the criterion belongs to whoever is asking). Omitted, this
// behaves exactly as it did when rows were the only input, which is what `reservedByBot` still wants.
// heldOrderDemand() → { token: count } — every material THIS bot's currently-held order still needs, at
// every level of its recipe. `{}` when no supply job is held.
//
// ONE READER FOR ONE QUESTION (Law 16). Two sites need this answer and they must never differ: the dumper
// asks "may I bank this?" and the pool lens asks "does the bot layer claim this?" — opposite phrasings of
// one fact. If they diverged, a bot could refuse to dump a material while the fleet still counted it as
// free stock, and a second bot's order would open against material the first will not release: a gate
// cleared on stock its fulfiller cannot spend, which is a claim/release loop into a judge kill.
//
// READ FRESH FROM THE BOARDROOM (Invariant B) rather than passed in — a dump is a step at the end of a
// producing verb, and the job that produced the material is the one still held.
function heldOrderDemand() {
    // Lazily required and required upward on purpose — a top-level require would close the cycle
    // (job_board → assessors → this file), the same reason the whitelist is reached for this way.
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
        const members = group_to_item[token];
        if (Array.isArray(members)) {
            let remaining = count;
            for (const member of members) {
                if (remaining <= 0) break;
                const take = Math.min(invCounts[member] || 0, remaining);
                if (take > 0) { spokenFor[member] = (spokenFor[member] || 0) + take; remaining -= take; }
            }
        } else {
            spokenFor[token] = (spokenFor[token] || 0) + count;
        }
    }
    const keepBack = (item, over) => Math.max(0, over - (spokenFor[item] || 0));

    const handled = new Set();
    const excess = {};
    for (const entry of whitelist) {
        const members = group_to_item[entry.item];
        if (Array.isArray(members)) {
            let remaining = entry.dump_threshold;
            for (const member of members) {
                if (!(member in invCounts)) continue;
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

// dumpExcess: pushes everything the bot isn't whitelisted to keep into
// the fleet's chests. Reads INVENTORY_WHITELIST from job_board — each entry
// is { item, keep } where item can be a group token (logs, planks) or
// a concrete item (crafting_table). Group tokens distribute their keep
// allowance across concrete members: { item: 'logs', keep: 10 } with
// oak_log:40 + birch_log:20 keeps 10 oak_log, dumps 30 oak + 20 birch.
// Everything not covered by any whitelist entry is dumped entirely.
// Called explicitly by fragments after completing work.
// THE DOUBLE HANDLING IS GONE BY CONSTRUCTION, not by routing. The Architect's 2026-08-13 complaint —
// *"it should dump inventory to requests first then buffer with any overages. right now dump excess seems
// to place everything in buffer then the bot has to move back out of buffer into requester chest"* — was
// answered at the time by dumping into the requester chest FIRST when a requester row named the item, and
// into a buffer otherwise. That two-tier destination is deleted with the roles: there is one pool, so
// depositing anywhere IS depositing into the request, and no material can be filed in the "wrong" chest
// and need carrying to the right one. The cost he named (295 logs in, 252 straight back out on that
// soak, ~50ms per item per move) is unreachable now rather than avoided.
//
// Does any standing stock row ASK for this item — used only to decide whether a compostable is surplus
// yet. Nothing about a chest, and deliberately so: the question is whether the fleet still wants the
// material at all, which is a property of the table, never of where it would land. STOCK_THRESHOLDS is
// read, never restated (Law 16 — one source for the tables).
function _anyRowWants(item) {
    const { STOCK_THRESHOLDS } = require('@thinking/architect_config.js');
    for (const row of STOCK_THRESHOLDS) {
        if (row.deficit_below == null) continue;
        const variants = (group_to_item && group_to_item[row.item]) || null;
        if (row.item === item || (variants && variants.includes(item))) return true;
    }
    return false;
}

// `_firstWithRoom` IS DELETED. It was the second "which chest" selector, kept because the two-tier dump
// had to pick within a role-filtered list; `_selectDepositTarget` above is the only one now, and it
// answers the same question better (it consolidates a kind rather than taking whatever came first).

async function dumpExcess(bot) {
    bot = bot || global.bot;
    if (!bot) throw new Error('[inventory_swapper] CODING VIOLATION: dumpExcess called with no bot loaded.');

    // Both lazily required and required upward on purpose — a top-level require from here would close
    // the cycle (job_board → assessors → this file), the same reason inventory_lens reaches for the
    // whitelist this way.
    const { INVENTORY_WHITELIST } = require('@thinking/job_board.js');
    const hq = require('@kernel/corporate_headquarters');

    // EVERY REGISTERED CHEST IS A DESTINATION. This read `findStationsByRole('buffer')`, so a fleet whose
    // chests carried no buffer tag dumped nothing and said so in a line that read like a world fact —
    // exactly the silent failure the role deletion removes. A chest is a chest.
    //
    // READ ONCE FOR THE WHOLE DUMP (Invariant B's boundary): the destination choice below re-reads no
    // registry, so every kind in one dump is placed against one consistent picture of what is full and
    // what is locked. A per-item re-read would let two kinds pick the same last free slot.
    const stations = stationRegistry.getStations();
    if (stationRegistry.findChests().length === 0) {
        watcher.summary(TAG, 'dumpExcess: no chest registered — nowhere to bank anything');
        return { dumped: 0, items: [] };
    }

    const invCounts = {};
    for (const it of bot.inventory.items()) {
        invCounts[it.name] = (invCounts[it.name] || 0) + it.count;
    }

    // ── WHAT THIS BOT IS WORKING TOWARD IS NOT SURPLUS ───────────────────────────────────────────────
    // THIS bot's claimed job, not the fleet's demand, and the distinction is what makes a shared producer
    // work at all. Two bots share one furnace: whoever empties it is often not whoever asked for the
    // output. If the emptier kept everything the FLEET wants, it would carry another bot's charcoal
    // around indefinitely and the asker would never see it. Keeping only what its OWN order needs makes
    // the surplus fall into a chest, where the asker withdraws it — the handover is the chest, and it
    // needs no handover machinery because banking and withdrawing already exist.
    //
    // THE CLAIM IS READ FRESH FROM THE BOARDROOM (Invariant B) rather than passed in: a dump is a step at
    // the end of a producing verb, and the job that produced the material is the one still held.
    //
    // NO CLAIM → NOTHING IS SPOKEN FOR, which is the correct reading and not a missing case: a bot with no
    // job in hand is holding nothing on anyone's behalf, so the rows decide alone exactly as before.
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
    const compost = require('@action/compost_executor.js');

    // ── COMPOSTABLES GO STRAIGHT INTO THE BIN (Architect 2026-08-13) ────────────────────────────────
    //   "make dump access place items directly into the compost bin… if it cant place items into a
    //    compost bin because there is none then it just holds that material in the bot. then on the next
    //    round of dump excess that has a compost bin available, then it will place it all in the bin."
    //
    // A composter is not a station and takes no window, so it cannot be one more entry in the chest list
    // below — it is its own destination with its own verb (right-click, one item per click). What it DOES
    // share is the queue: feedFromPocket locks the block through the same primitives a chest uses, because
    // two bots right-clicking one composter on the same tick each read a level the other just moved.
    //
    // ORDER MATTERS AND THE REQUEST COMES FIRST. A compostable that a standing row still ASKS for is not
    // surplus yet — it is stock arriving late. Only what nothing asks for reaches the bin, which is the
    // whole of "anything above 32 goes to the compost bin" with no threshold written anywhere.
    //
    // THE TEST IS THE TABLE, NOT A CHEST. It used to be "does a requester chest with room want this",
    // which welded two questions together and answered both wrong when either half was missing: an
    // untagged chest or a full one made a wanted sapling look like compost. Whether the fleet wants a
    // material is a property of the stock table; where it goes is decided below, from every chest.
    //
    // NO BIN → HOLD, and this is the half that makes it work. Falling through to a chest is what the old
    // design did, and it is what created the retrieval errand this replaces: a sapling filed in a chest
    // needs a job to carry it back out, and that job spent seventeen minutes unclaimed at the bottom of
    // the board on 2026-08-13. Held material costs a pocket slot until the next dump; filed material
    // costs a bot.
    const compostable = [];
    for (const [item, amount] of Object.entries(excess)) {
        if (!compost.isCompostable(item)) continue;
        if (_anyRowWants(item)) continue;   // something still asks for it
        compostable.push({ name: item, count: amount });
        delete excess[item];
    }
    if (compostable.length > 0) {
        const fedResult = await compost.feedFromPocket(bot, compostable);
        if (fedResult.ok) {
            if (fedResult.fed > 0) dumpResults.push({ item: 'compost', transferred: fedResult.fed });
        } else {
            // Held, not lost, and named so the trace says which (Law 25): the pocket keeps the material and
            // the next dump with a reachable bin takes it. Never a fall-through to a chest.
            //
            // `composter_not_built_yet` carries its anchor because that is what makes the line self-explaining
            // to whoever reads the trace: the bin is a LATER anchor than the chests this same dump just used,
            // so early in a world a bot legitimately has a chest and no compost bin. That reason is expected
            // and self-resolving; a run where it keeps appearing after the base is finished is not.
            const why = fedResult.reason === 'composter_not_built_yet'
                ? `${fedResult.reason} (blueprint anchor ${fedResult.anchor}; chests are earlier anchors, so this is expected until the base reaches it)`
                : fedResult.reason;
            watcher.summary(TAG, `dumpExcess: holding ${compostable.reduce((n, c) => n + c.count, 0)} compostable(s) — ${why}`);
        }
    }

    // ONE WINDOW PER CHEST, NOT ONE PER KIND (Architect 2026-08-14, ranked #3). The destination is chosen
    // per item exactly as before — that decision is unchanged — and then the items that chose the SAME
    // chest are moved together. On the 2026-08-14 soak this loop opened chest (-150,65,66) once for a
    // dirt, once for a peony and once for a mushroom, three windows and three lock acquires for one visit,
    // each paying the fixed ~430ms open/close in full for a single item.
    const byChest = new Map();
    for (const [item, amount] of Object.entries(excess)) {
        // ONE POOL, SO ONE CHOICE: consolidate this kind where it already sits if that chest has room,
        // else any chest with room. `_selectDepositTarget` is the fleet's one answer to "which chest"
        // (Law 16) and already ranks consolidation over an unlocked chest over coordinate order — the
        // two-tier requester-then-buffer choice this replaced was ranking by a tag instead, which is the
        // only reason a second selector existed here at all.
        const targetStation = _selectDepositTarget(stations, item);
        if (!targetStation) {
            watcher.summary(TAG, 'dumpExcess: every chest is full — stopping');
            break;
        }
        if (!byChest.has(targetStation.id)) byChest.set(targetStation.id, []);
        byChest.get(targetStation.id).push({ item, amount });
    }

    for (const [stationId, orders] of byChest) {
        const item = orders.map(o => o.item).join('+');   // for the abandonment message only
        const result = await _executeTransfer(bot, 'deposit', orders, stationId);

        // ABANDONMENT PROPAGATES; IT IS NOT SWALLOWED. _executeTransfer returns undefined only after it
        // has ALREADY routed a fresh signal to recursive_judge (Law 15 caller abandonment), so this
        // execution line is dead and nothing downstream may route again (Law 4: one signal).
        //
        // THIS IS THE DEFECT THAT KILLED THE 2026-08-13 SOAK at 10m29s. The undefined fell through
        // `if (result && result.success)`, dumpExcess returned as though nothing had happened, and the
        // executor that called it routed a SECOND signal — two job_board sweeps, both reaching for the
        // planning token, and the loser threw `acquire already pending`. The swallow had been here since
        // the function was written; it only became reachable when the drop-off went from one call site to
        // four on 2026-08-13. retrieveItems already had this exact guard (`if (got === undefined) return`)
        // eighty lines below, which is the pattern this reuses rather than a new one (Law 22 gate 2).
        if (result === undefined) {
            watcher.warn(TAG, `dumpExcess: transfer of ${item} abandoned to the judge — stopping the dump and reporting it so the caller does not route again.`);
            return { dumped: dumpResults.length, items: dumpResults, abandoned: true };
        }
        // Per-kind rows, not one row for the window: the caller's report ("N items across K kinds") and
        // the compost row above are both per-kind, and collapsing them here would make a batched dump
        // report fewer kinds than it moved.
        for (const m of (result.moved || [])) dumpResults.push({ item: m.item, transferred: m.transferred });
    }

    if (dumpResults.length > 0) {
        watcher.summary(TAG, `dumpExcess complete: ${dumpResults.map(r => `${r.item}x${r.transferred}`).join(', ')}`);
    }

    return { dumped: dumpResults.length, items: dumpResults };
}

// dropOffHaul: the END-OF-WORK drop-off, as distinct from dumpExcess (which is the mechanism).
// dumpExcess owns WHAT is kept; this owns WHEN it is worth walking to a chest, plus the one carve-out
// and the one report both callers need. It lives here rather than in either executor because two
// executors now hang off it and a second copy of the carve-out is exactly the redundancy Law 16 refuses
// — the harvest side had it first (2026-08-06), the craft side was added 2026-08-13.
//
// WHY THE ROUND TRIP IS WORTH IT, since the Architect ruled the opposite way on 2026-07-04 and the next
// reader needs to know both rulings stand: that decision priced the trip against THROUGHPUT (a bot deep
// in the shaft surfacing to deposit one gravel) and is still correct about that, which is why this hangs
// on gather and craft only and the MINING paths are deliberately untouched. What it never weighed was
// LOSS. Measured 2026-08-06: 10 deaths, 598 items on the ground, 0 recovered, including 80 birch_log
// while the build sat gated on 5. On hard difficulty the bot dies often, so a pocket is the least safe
// place in the world to keep a material. The craft side is nearly free on top of that: a craft happens
// AT a crafting table, which stands in the base beside the chest — the walk this pays for is a few
// blocks, not a trip home.
//
// NO HEADFRAME → SKIP, not fail (the Architect's own carve-out). Before the build spot is locked there is
// nowhere to put anything, and the work that called this must still complete: an environmental absence,
// not a coding violation (Law 13).
async function dropOffHaul(bot) {
    bot = bot || global.bot;
    if (!bot?.entity?.position) return { dumped: 0, items: [] };

    const { readBuildCenter } = require('@utils/fragment_utils');
    if (!readBuildCenter('headframe')) {
        watcher.summary(TAG, 'drop-off skipped — no headframe locked yet, so there is nowhere to put a haul.');
        return { dumped: 0, items: [] };
    }

    const result = await dumpExcess(bot);
    const items = Array.isArray(result?.items) ? result.items : [];
    const moved = items.reduce((n, i) => n + (i.transferred || 0), 0);
    // Carried through to every caller: `abandoned` means a signal is already on its way to the judge, so
    // the executor that called this must return WITHOUT routing. Every call site checks it.
    if (result?.abandoned) {
        watcher.summary(TAG, `drop-off: ${moved} item(s) moved before the transfer was abandoned to the judge — caller must not route.`);
        return result;
    }
    // Reported every time, including zero: work that ended with nothing dumpable is the whitelist doing
    // its job, and a run of zeroes while the pocket is fat is the signal that it is mis-tuned.
    watcher.summary(TAG, `drop-off: ${moved} item(s) across ${items.length} kind(s) into the fleet's chests.`);
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
