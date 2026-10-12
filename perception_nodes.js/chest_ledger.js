'use strict';
// chest_ledger — WHO HAS SPOKEN FOR THE MATERIAL THAT IS ACTUALLY IN THE BARREL.
//
// ── ONE RULE, AND EVERYTHING HERE IS A CONSEQUENCE OF IT ────────────────────────────────────────────
// A DECISION IS MADE ONLY ON MATERIAL THAT HAS BEEN DEPOSITED. Nothing in this file counts a deposit
// that is still walking. A body that needs stone the fleet has not banked yet goes and gets stone; it
// never waits on a peer's intention, and it is never handed a job whose material exists only as someone
// else's plan.
//
// ── WHAT A CLAIM IS FOR ─────────────────────────────────────────────────────────────────────────────
// Two bodies may want the same nine cobblestone. This file is what stops them both walking for it: the
// body that commits to a stack takes it with it, and every other body's count is realized stock LESS
// what is claimed. Nobody predicts anything, so nobody can be wrong about it.
//
// The claim lives on the MAGNET because a claim needs something to enforce it and something to end it,
// and the magnet is both. `dispatcher.clearMagnet` nulls the chair and broadcasts the clear to every
// peer, and it runs at job end, on idle, on a judge halt and on a kill — so a claim expires by the same
// act that ends the work. Nothing reconciles it, nothing sweeps it, and it cannot be forgotten
// separately from the job that owns it (Law 8, Invariant D). A body that dies holding stone releases it;
// so does a body that finishes, and a body that is halted for inspection.
//
// ── WHAT BREAKS WITHOUT IT ──────────────────────────────────────────────────────────────────────────
// The board and the body answer whether this material is available with different numbers, and a job posted
// against one is served against the other. The body arrives, finds nothing, releases the job, is handed
// the identical job back against the identical number, and the loop detector stops the planner. The
// claim is what makes it ONE number that both read: realized stock, less what is already spoken for.
//
// ── NOT REMEMBERED STATE (Invariant B) ──────────────────────────────────────────────────────────────
// Nothing here accumulates a balance. Every call re-reads the barrel from `station_registry` and re-reads
// every claim from the live boardroom. A claim is not a memory of something that happened — it is a
// peer's current statement of what it holds, and it vanishes with that peer's magnet.

const stationRegistry = require('@perception/station_registry');
const hq = require('@kernel/corporate_headquarters');
const watcher = require('@kernel/watcher');
const { chestItemCounts, group_to_item } = require('@utils/fragment_utils');

const TAG = 'chest_ledger';

// ── A CLAIM IS PUBLISHED, NEVER LEFT TO BE INFERRED ─────────────────────────────────────────────────
// A PEER NEVER READS THIS BODY'S CHAIR OFF DISK — it reads the copy the foreman relayed, and
// `mergeBroadcastChairs` replaces a chair wholesale. So a claim written only into local HQ is held
// NOWHERE it is actually consulted: every peer keeps pricing against stock this body is walking for, two
// bodies take the same stack, and the claim is an estimate again wearing the word "claim".
//
// Both the taking and the dropping are broadcast, and for the same reason in opposite directions — an
// unpublished claim lets peers over-take, an unpublished release makes them under-take forever. The
// magnet's own clear carries the claim away with it and broadcasts on the same pathway (Law 16).
//
// A REAL BOUNDARY — this crosses the socket to the foreman, so a failure is the network's and not ours.
// The local write already stands; the update is what tells everybody else.
function _publish() {
    require('@utils/external_library_guard')
        .guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}

function _botId() {
    return process.env.BOT_ID || 'default';
}

// Normalise a caller's {item, amount} list into a plain totals object, so two lines for the same item in
// one claim cannot disagree with each other downstream.
function _totals(list) {
    const out = {};
    if (!Array.isArray(list)) return out;
    for (const entry of list) {
        if (!entry || !entry.item) continue;
        const n = Number(entry.amount);
        if (!Number.isFinite(n) || n <= 0) continue;
        out[entry.item] = (out[entry.item] || 0) + n;
    }
    return out;
}

// ── THE GROUP TOKEN ─────────────────────────────────────────────────────────────────────────────────
// A deposit sits in the barrel under its CONCRETE name (`oak_log`) and a job asks for the GROUP token
// (`logs`). Those are different keys, so arithmetic that joins two sides of the fleet by item name has
// to resolve the join here — the only place both names are in hand at once. Bidirectional, and the third
// row is a deliberate under-count:
//   asked `logs`,    told `{logs: 7}`     → 7
//   asked `logs`,    told `{oak_log: 3}`  → 3
//   asked `oak_log`, told `{logs: 7}`     → 0   (how many of the 7 are oak is not knowable here)
// The join is biased so that it over-reports a CLAIM and under-reports AVAILABILITY. Under-counting a
// claim lets a second body take material already spoken for, which is a collision; under-counting
// availability sends a body off to gather material that was sitting there, which costs one trip.
function _countToward(item, totals) {
    let n = totals[item] || 0;
    const members = group_to_item[item];
    // A group that lists its own name (`dirt`, `stone`) has that member counted once, above.
    if (Array.isArray(members)) for (const m of members) if (m !== item) n += (totals[m] || 0);
    return n;
}

// claim: this body is taking the named material out of this station.
//
// Made at the moment the job is taken, not on arrival at the barrel — a claim made on arrival tells the
// bodies behind nothing they could still act on, because they have already walked.
//
// Replaces any claim this body held at this station; it does not add to it. A body has one holding at a
// station at a time; two would mean something upstream believes it is two bodies (Law 7).
//
// A body with no magnet cannot claim. There is no job to own the claim, so nothing would ever release it
// — the same rule `lockChest` applies for the same reason (Law 8, no orphans).
function claim(stationId, take = []) {
    if (!stationId) return false;
    const botId = _botId();
    const chair = hq.readBoardroomChair(botId, {});
    if (!chair.magnet) return false;

    const takes = _totals(Array.isArray(take) ? take : []);
    if (Object.keys(takes).length === 0) return false;
    chair.magnet.bank_claim = { station: stationId, at: Date.now(), take: takes };
    hq.writeBoardroomChair(botId, chair);
    _publish();

    const parts = Object.entries(takes).map(([item, n]) => `${n} ${item}`);
    watcher.summary(TAG, `${botId} claimed ${parts.join(', ')} at ${stationId} — held until its magnet clears.`);
    return true;
}

// release: drop this body's claim once the transfer is done or abandoned.
//
// `clearMagnet` already takes the claim with it, so this is not what makes the system correct — it is
// what makes it TIMELY. A finished claim left standing keeps material spoken for until the next job is
// taken, and every peer in the meantime prices against stock that is free.
function release(stationId, reason = 'done') {
    const botId = _botId();
    const chair = hq.readBoardroomChair(botId, {});
    const held = chair && chair.magnet && chair.magnet.bank_claim;
    if (!held || (stationId && held.station !== stationId)) return;
    chair.magnet.bank_claim = null;
    hq.writeBoardroomChair(botId, chair);
    _publish();
    watcher.summary(TAG, `${botId} released its claim at ${held.station} (${reason}).`);
}

// drawn: this body took `amount` of `item` out of a chest; that much of its claim is spent.
//
// A claim says what is still in the chests for this body. Left whole after the withdrawal it would
// count the same blocks twice against every peer: once as the claim and once as stock no longer there.
// The line named for the item is spent first, then a group line the item belongs to. A claim with
// nothing left on it is dropped.
function drawn(item, amount) {
    const botId = _botId();
    const chair = hq.readBoardroomChair(botId, {});
    const held = chair && chair.magnet && chair.magnet.bank_claim;
    if (!held || !held.take || !(amount > 0)) return;
    const members = Array.isArray(group_to_item[item]) ? group_to_item[item] : [];
    const lines = Object.keys(held.take).filter(token => token === item || members.includes(token)
        || (Array.isArray(group_to_item[token]) && group_to_item[token].includes(item)));
    lines.sort((a, b) => (a === item ? -1 : 0) - (b === item ? -1 : 0));
    let left = amount;
    for (const token of lines) {
        if (left <= 0) break;
        const spend = Math.min(left, held.take[token]);
        held.take[token] -= spend;
        left -= spend;
        if (held.take[token] <= 0) delete held.take[token];
    }
    if (left === amount) return;
    if (Object.keys(held.take).length === 0) chair.magnet.bank_claim = null;
    hq.writeBoardroomChair(botId, chair);
    _publish();
}

// claimsAt: every live claim at a station. Reads the whole boardroom each call and counts nothing it
// cannot currently see — a claim exists exactly as long as the magnet carrying it does.
function claimsAt(stationId) {
    if (!stationId) return [];
    const rows = [];
    for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}))) {
        const held = chair && chair.magnet && chair.magnet.bank_claim;
        if (!held || held.station !== stationId) continue;
        rows.push({ botId, at: held.at, take: held.take || {} });
    }
    rows.sort((a, b) => (a.at - b.at) || (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0));
    return rows;
}

// availableAt: how much of one item this body may still take from this station.
//
// Realized contents, less every OTHER body's claim. This body's own claim is not subtracted — material
// it has already spoken for is material it may go and collect, and subtracting it would make a body
// starve itself the moment it claimed anything.
//
// FLOORED AT ZERO because a barrel cannot hold a negative count.
function availableAt(stationId, item, botId) {
    const who = botId || _botId();
    const entry = stationRegistry.getStations()[stationId];
    if (!entry) return 0;
    let n = _countToward(item, chestItemCounts(entry));
    for (const row of claimsAt(stationId)) {
        if (row.botId === who) continue;
        n -= _countToward(item, row.take);
    }
    return Math.max(0, n);
}

// claimedAt: how much of one item is spoken for at this station, by anyone. The board's subtraction —
// what the fleet holds that is NOT free for the next job.
function claimedAt(stationId, item) {
    let n = 0;
    for (const row of claimsAt(stationId)) n += _countToward(item, row.take);
    return n;
}

// ── claimedByOthers: THE SUBTRACTION ON ITS OWN, FOR A CALLER THAT COUNTS ITS OWN STATIONS ─────────
// The same arithmetic `availableAt` performs internally, offered separately so a reader that already
// has a stock figure can net the claims off it without also adopting this file's station filter.
//
// The separation matters because `availablePool` answers two questions at once — realized stock at
// every station a claim can be keyed to, less every other body's claim — for a caller that may want only
// the second. `poolStations` requires `e.pos`; the fleet's wider readers (`accessibleMaterialPool`, and
// therefore `reachableByFleet` and the chain gate) require only `isStorage`, a narrower set. A caller
// that wants claims subtracted from its own count says exactly that and nothing else.
function claimedByOthers(item, botId) {
    const who = botId || _botId();
    let n = 0;
    for (const id of poolStations()) {
        for (const row of claimsAt(id)) {
            if (row.botId === who) continue;
            n += _countToward(item, row.take);
        }
    }
    return n;
}

// ── THE POOL, WHICH IS THE UNIT THE WITHDRAW DECISION ACTUALLY USES ─────────────────────────────────
// `supply_manager` asks whether the fleet's storage holds this, and its reader sums EVERY storage station
// into one totals object. The claim-aware answer is offered in the same unit, or the two would answer
// different questions under the same name (Law 7). Written per-station and per-pool separately so the
// day a second container stands is not the day the fleet discovers the decision was keyed to one barrel.
function poolStations() {
    return Object.entries(stationRegistry.getStations())
        .filter(([, e]) => e && e.pos && stationRegistry.isStorage(e))
        .map(([id]) => id);
}

// availablePool / claimedPool: the same two questions asked of the whole pool.
//
// An ITEM and not a totals object, because the group-token join above has no representation as a
// key-value pair — a claim on `logs` against a pool holding `oak_log` cannot be written as a row. Handing
// out an object would make every downstream reader re-derive the join, and the second one to do it would
// get it wrong (Law 16 — one place resolves it).
function availablePool(item, botId) {
    let n = 0;
    for (const id of poolStations()) n += availableAt(id, item, botId);
    return n;
}

function claimedPool(item) {
    let n = 0;
    for (const id of poolStations()) n += claimedAt(id, item);
    return n;
}

// ── stationHolding: WHICH BARREL TO FILE THE CLAIM AGAINST ─────────────────────────────────────────
// A claim is keyed to a STATION (`claimsAt` filters on it), so a claim filed at the wrong barrel
// subtracts nothing anywhere a peer is looking. The withdraw decision reads `availablePool`, which sums
// every station — so the decision is fleet-wide and the claim it authorises is not, and picking the
// first station in the map is only correct when the fleet has one barrel; with several, the material can
// sit in one while the claim lands on another.
//
// THE MOST, NOT THE FIRST: the station that can actually cover the trip. A tie goes to the earlier
// station, which is arbitrary and harmless — both hold the same amount, so either claim is honoured.
// Null when nothing is free: a null station is a refusal to claim, never a claim on nothing.
function stationHolding(item, botId) {
    let best = null;
    let most = 0;
    for (const id of poolStations()) {
        const n = availableAt(id, item, botId);
        if (n > most) { most = n; best = id; }
    }
    return best;
}

// ── lessClaims: A POOL MAP WITH EVERY LIVE CLAIM ALREADY SPENT OUT OF IT ───────────────────────────
// The board's half of this file's one promise: realized stock, less what is already spoken for. Without
// it, an order is priced against raw chest contents, so a body could claim nine cobblestone while the
// board posts a second order against the same nine.
//
// A pool goes in and a pool comes out; this lives here, not at the caller. `availablePool` refuses to
// hand out a totals object because a claim on `logs` against a pool holding `oak_log` has no
// representation as a key-value row — a caller handed rows would have to re-derive the group join, and a
// second caller doing the same derivation risks getting it wrong. Spending the claim inside this file
// keeps the join in the one place that owns it — the caller never sees a claim at all, only a smaller
// pool.
//
// The spend itself is the calculator's `debitFromBudget`, the same group-aware subtraction the craft
// walk uses, so a claim comes off a pool exactly the way a recipe's ingredient does (Law 16).
// `exceptBot` leaves that body's own claim in the pool: what it has spoken for is what it may go and take.
function lessClaims(pool, exceptBot = null) {
    const { debitFromBudget } = require('@utils/calculators/build_material_calculator');
    const out = { ...(pool || {}) };
    for (const id of poolStations()) {
        for (const row of claimsAt(id)) {
            if (exceptBot && row.botId === exceptBot) continue;
            for (const [token, n] of Object.entries(row.take || {})) debitFromBudget(out, token, n);
        }
    }
    return out;
}

// ── unclaimedOf: WHAT A WITHDRAWAL MAY TAKE ────────────────────────────────────────────────────────
// How many of the named concrete items the whole pool holds that no OTHER body has spoken for. The
// withdrawal door (`inventory_swapper`) caps every take by this, so a claim binds a body that never read
// it. Pool-wide, because a claim is filed at one station and spends from every chest. A claim on a group
// counts in full against any of its members, the same bias as `_countToward`: a claim is over-reported.
function unclaimedOf(names, botId) {
    const who = botId || _botId();
    const want = new Set(names);
    const stations = stationRegistry.getStations();
    let stock = 0, claimed = 0;
    for (const id of poolStations()) {
        const counts = chestItemCounts(stations[id]);
        for (const name of want) stock += counts[name] || 0;
        for (const row of claimsAt(id)) {
            if (row.botId === who) continue;
            for (const [token, n] of Object.entries(row.take || {})) {
                const members = Array.isArray(group_to_item[token]) ? group_to_item[token] : [];
                if (want.has(token) || members.some(m => want.has(m))) claimed += n;
            }
        }
    }
    return Math.max(0, stock - claimed);
}

// worthTheTrip: the one question the withdraw decision asks, answered in one place so every caller asks
// it the same way (Law 16). `why` is a sentence for the trace, because a body that decides NOT to walk
// leaves no other evidence that it decided anything at all (Invariant C).
function worthTheTrip(stationId, item, wanted, botId) {
    const have = availableAt(stationId, item, botId);
    const spoken = claimedAt(stationId, item);
    if (have <= 0) {
        return {
            go: false, available: 0, claimed: spoken,
            why: spoken > 0
                ? `${item}: all of it at ${stationId} is claimed by other bodies (${spoken} spoken for)`
                : `${item}: none banked at ${stationId}`,
        };
    }
    return {
        go: true, available: have, claimed: spoken,
        why: `${item}: ${have} unclaimed at ${stationId}${spoken > 0 ? ` (${spoken} spoken for by others)` : ''}`
            + `${Number.isFinite(wanted) ? `, need ${wanted}` : ''}`,
    };
}

// report: every live claim at a station as one line, for the trace and for a lens to read back.
function report(stationId) {
    const rows = claimsAt(stationId);
    if (rows.length === 0) return `${stationId}: nothing claimed.`;
    const seats = rows.map(r => {
        const parts = Object.entries(r.take).map(([item, n]) => `${n} ${item}`);
        return `${r.botId}: ${parts.join(' ') || '(nothing)'}`;
    });
    return `${stationId}: ${rows.length} claim(s) — ${seats.join(' | ')}`;
}

module.exports = {
    claim, release, drawn, claimsAt, availableAt, claimedAt, availablePool, claimedPool, poolStations,
    stationHolding, lessClaims, claimedByOthers, unclaimedOf,
    worthTheTrip, report,
};
