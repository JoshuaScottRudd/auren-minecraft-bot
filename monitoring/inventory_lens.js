// Auren_Bot/monitoring/inventory_lens.js
// WHERE EVERY ITEM IS, AND EVERY TIME ONE MOVED BETWEEN CONTAINERS.
//
// ── WHY THIS LENS EXISTS (Architect 2026-08-14) ──────────────────────────────────────────────────
// *"can you make a new lense for tracking inventory transfers? so at a call i want to know what
//   currently is in every inventory bots and chests and a manifest of every transfer. not from raw
//   harvest to bot inventory but anywhere else."*
//
// THE EXCLUSION IS STRUCTURAL, NOT A FILTER. A pickup off the ground never passes through
// inventory_swapper, so no line it could match is ever written — "not from raw harvest" costs this lens
// nothing to honour and cannot drift. Every transfer BETWEEN containers goes through one function
// (`_executeTransfer`), so its completion line is the whole manifest: one door in the code, one door here
// (Law 16).
//
// IT READS THE TRACE, NOT THE WORLD, AND SAYS SO ON EVERY NUMBER. "What is currently in every inventory"
// is answered as LAST KNOWN — the newest snapshot the record carries for each container, with the
// timestamp attached. The fleet writes a chest's full post-transfer contents into its own completion line
// and its pocket into every job_board sweep, so the record already holds this; reaching past it into a
// live registry file would be a second door onto the same question and the two would disagree the moment
// a bot moved (Law 25 — a number that answers a different question than the reader's is false however
// true it is). A container nobody touched shows its age rather than a stale-looking zero.
//
// WHAT IT IS FOR. The chest-system redesign (generic chests, system-wide requests, a consolidation pass)
// turns entirely on four costs nothing was totalling: time queued at a chest, the same item deposited and
// then withdrawn again, one item smeared across several stacks, and the fixed-overhead tax on tiny
// transfers. All four are computed here, so a before/after is measured rather than argued.

'use strict';

const { relativeTime } = require('./trace_read');
// THE ONE WRITER TO STDOUT (Architect 2026-09-16). Every figure below leaves as a field name and a
// value; this lens no longer owns a space, a separator or a column width.
const out = require('./data_out');

// The one completion line every container-to-container move writes (inventory_swapper._executeTransfer).
// The chest snapshot is the tail of it, which is why standing contents and the manifest come from the
// same regex rather than two.
// One line per WINDOW, carrying however many kinds that window moved — the fleet batches a dump into one
// visit (2026-08-14), so the unit here is the visit a peer queues behind, never the item kind.
const TX_RE = /(deposit|retrieve) complete — (\d+) kind\(s\), (\d+) item\(s\) \[([^\]]*)\] in ([\d.]+)s open \((\d+)ms\/item\) after ([\d.]+)s waiting to get in\. Chest (\S+): (\d+) stack\(s\) \[([^\]]*)\]/;
// CHEST_TO_CHEST_RE IS DELETED with the chest→chest courier that wrote its line. Storage is one pool
// measured across every chest, so a courier move could never change the figure it claimed to fix; the
// emitter is gone, and a lens holding a regex nothing writes reports a permanent zero as though it were
// a measurement (Law 25).
// The board's own sweep line carries the pocket. It is the only per-bot inventory the record holds.
const POCKET_RE = /pocket=\[([^\]]*)\]/;
// The queue wait, which is NOT the same number as `waiting to get in`: this one is the walk-and-wait for a
// peer to release the lock, reported only when a queue actually formed.
const QUEUE_RE = /chest (\S+) released after (\d+)s in queue/;

const SMALL_TRANSFER = 2;        // at or below this the fixed ~430ms window overhead dominates entirely

function _parseStacks(text) {
    // "oak_log x37, oak_log x3, oak_log x1" → [{name, count}], preserving the SPLIT (three entries, not
    // one sum) because stack fragmentation is one of the four costs this lens exists to measure.
    if (!text || text === 'empty') return [];
    const out = [];
    for (const part of text.split(',')) {
        const m = part.trim().match(/^(\S+) x(\d+)$/);
        if (m) out.push({ name: m[1], count: +m[2] });
    }
    return out;
}

function _parsePocket(text) {
    if (!text) return [];
    const out = [];
    for (const part of text.split(',')) {
        const m = part.trim().match(/^(\S+):(\d+)$/);
        if (m) out.push({ name: m[1], count: +m[2] });
    }
    return out;
}

function _prettyId(id) {
    return id.includes('|') ? `(${id.split('|').join(',')})` : id;
}

function _totals(stacks) {
    const t = {};
    for (const s of stacks) t[s.name] = (t[s.name] || 0) + s.count;
    return t;
}

function runInventory({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
    const chests = new Map();     // id → { stacks, at, deposits, retrieves, itemsIn, itemsOut, waitSec, queueSec, queues }
    const pockets = new Map();    // botId → { stacks, at }
    const manifest = [];
    let maxRel = 0;

    const C = (id) => {
        let c = chests.get(id);
        if (!c) {
            c = { stacks: [], at: null, deposits: 0, retrieves: 0, itemsIn: 0, itemsOut: 0,
                  waitSec: 0, queueSec: 0, queues: 0, flowIn: {}, flowOut: {}, lastTotals: {},
                  fragPeak: 0, fragPeakAt: null, fragPeakText: '' };
            chests.set(id, c);
        }
        return c;
    };

    for (const l of seg) {
        if (l.relSec == null) continue;
        if (botFilter && l.bot !== botFilter) continue;
        maxRel = Math.max(maxRel, l.relSec);
        let m;

        if ((m = l.raw.match(TX_RE))) {
            const [, dir, kindStr, countStr, movedText, openStr, msPerItem, waitStr, chestId, , stackText] = m;
            const count = +countStr;
            const kinds = +kindStr;
            const c = C(chestId);
            const stacks = _parseStacks(stackText);

            // FLOW IS MEASURED FROM CONSECUTIVE SNAPSHOTS, NOT FROM THE TRANSFER'S OWN ITEM NAME, and
            // that is the whole reason this works. A deposit names `oak_log` and the withdrawal that takes
            // it back out names the GROUP token `logs`, so joining the two by name reports zero double
            // handling on a run that did nothing but double-handle. The chest's post-move contents are
            // ground truth in the record and need no group table — which also keeps this lens from
            // carrying a second copy of a table fragment_utils owns (Law 16).
            const now = _totals(stacks);
            for (const name of new Set([...Object.keys(now), ...Object.keys(c.lastTotals)])) {
                const delta = (now[name] || 0) - (c.lastTotals[name] || 0);
                if (delta > 0) c.flowIn[name] = (c.flowIn[name] || 0) + delta;
                else if (delta < 0) c.flowOut[name] = (c.flowOut[name] || 0) - delta;
            }
            c.lastTotals = now;

            // Fragmentation is measured at its PEAK, never from the closing snapshot. The 2026-08-14 run
            // held `oak_log x37, oak_log x3, oak_log x1` mid-run and ended with the chest drained, so the
            // final reading says zero on a run that spent three slots on one item type for ten minutes.
            const byName = {};
            for (const s of stacks) byName[s.name] = (byName[s.name] || 0) + 1;
            const extra = Object.values(byName).reduce((n, k) => n + (k - 1), 0);
            if (extra > c.fragPeak) { c.fragPeak = extra; c.fragPeakAt = l.relSec; c.fragPeakText = stackText; }

            c.stacks = stacks;      // newest snapshot wins outright for STANDING contents — no merging
            c.at = l.relSec;
            c.waitSec += +waitStr;
            if (dir === 'deposit') { c.deposits++; c.itemsIn += count; }
            else                   { c.retrieves++; c.itemsOut += count; }
            manifest.push({ t: l.relSec, bot: l.bot, dir, count, kinds, moved: movedText, chestId,
                            openSec: +openStr, msPerItem: +msPerItem, waitSec: +waitStr });
        } else if ((m = l.raw.match(QUEUE_RE))) {
            const c = C(m[1]); c.queues++; c.queueSec += +m[2];
        } else if ((m = l.raw.match(POCKET_RE))) {
            pockets.set(l.bot, { stacks: _parsePocket(m[1]), at: l.relSec });
        }
    }

    // ── OUTPUT IS DATA, NOT PROSE (Architect 2026-09-16) ───────────────────────────────────────────
    // Every string below is either a field name this lens declared or a value it COPIED out of the
    // record. What stood here and is DELETED rather than given a field name: the `(context only — never
    // flags, never wakes)` banner; the three-line note about which completion-line shape is matched; the
    // STANDING INVENTORY preamble about the record not being the live world; the BY CONSTRUCTION note
    // that ground pickups write no matchable line; the two-clock warning under contention; the name-join
    // footnote under double handling; the PEAK-not-closing footnote and the `a chest is 27 slots` aside
    // under fragmentation; the `(per-move, not per-item)` aside; the `none — every item that entered a
    // chest stayed in it` sentence; and every `--all` pointer. Each was this instrument saying what its
    // own numbers MEANT or what the reader should do next. Every NUMBER they surrounded is still printed
    // below, one field each — the metric-type labels became FIELD NAMES (`redundant_slots_peak`).
    out.kv('lens', 'inventory');
    out.kv('record', traceName);
    out.kv('span', relativeTime(maxRel));
    if (botFilter) out.kv('bot_filter', botFilter);

    if (!chests.size && !pockets.size) {
        // The honest zero (Law 25), as three counted fields instead of a paragraph about absence.
        out.zero('chests');
        out.zero('pockets');
        out.zero('transfers');
        return;
    }

    // ── STANDING INVENTORY ─────────────────────────────────────────────────────────────────────────
    // Contents render as `name:count` pairs joined by a comma — the record's own pocket shape. The SPLIT
    // is preserved (three `oak_log` entries stay three rather than summing to one) because stack
    // fragmentation is one of the four costs measured below, and `at` carries the age of the reading.
    const cells = (stacks) => (stacks.length ? stacks.map(s => `${s.name}:${s.count}`).join(',') : 0);

    const fleetTotal = {};
    // A chest can enter this map from a QUEUE line alone — the record proves the chest exists and that
    // someone waited on it, and says nothing whatever about its contents. Rendering that as `empty` is a
    // false verdict of exactly the kind this lens is meant to kill (Law 25), so a chest with no snapshot
    // goes to its own block with a peer count rather than into the contents table with a zero.
    const unread = [...chests].filter(([, c]) => c.at === null);
    const chestRows = [];
    for (const [id, c] of [...chests].filter(([, c]) => c.at !== null).sort((a, b) => a[0].localeCompare(b[0]))) {
        const t = _totals(c.stacks);
        for (const [n, v] of Object.entries(t)) fleetTotal[n] = (fleetTotal[n] || 0) + v;
        // The gap between the stack count and the item total IS the fragmentation, so the redundant slot
        // count of the LAST snapshot is carried as its own field beside the peak figure in cost 3.
        const redundantNow = Object.keys(t).reduce((n, name) => n + (c.stacks.filter(s => s.name === name).length - 1), 0);
        chestRows.push([_prettyId(id), relativeTime(c.at), c.stacks.length, redundantNow, cells(c.stacks)]);
    }
    out.section('chest_contents_last_known');
    out.table(['chest', 'at', 'stacks', 'redundant_slots_now', 'contents'], chestRows);

    if (unread.length) {
        out.section('chest_no_contents_reading');
        out.table(['chest', 'peers_queued'], unread.map(([id, c]) => [_prettyId(id), c.queues]));
    }

    const pocketRows = [];
    for (const [id, p] of pockets) {
        const t = _totals(p.stacks);
        for (const [n, v] of Object.entries(t)) fleetTotal[n] = (fleetTotal[n] || 0) + v;
        pocketRows.push([id, relativeTime(p.at), p.stacks.length, cells(p.stacks)]);
    }
    out.section('pocket_contents_last_known');
    out.table(['bot', 'at', 'stacks', 'contents'], pocketRows);

    // What the fleet HOLDS, regardless of which container holds it — the same figure job_board judges a
    // storage threshold against, so this block and the board's verdict are readable against each other.
    const sorted = Object.entries(fleetTotal).sort((a, b) => b[1] - a[1]);
    out.section('fleet_total_held');
    if (!sorted.length) out.zero('items');
    else out.table(['item', 'count'], sorted);

    // ── TRANSFER MANIFEST ──────────────────────────────────────────────────────────────────────────
    out.section('transfer_manifest');
    out.kv('moves', manifest.length);
    if (manifest.length && verbose) {
        // `moved` and the direction verb are the record's own words, copied into value cells.
        out.table(
            ['at', 'bot', 'direction', 'items', 'kinds', 'chest', 'open_sec', 'wait_sec', 'ms_per_item', 'moved'],
            manifest.map(e => [relativeTime(e.t), e.bot, e.dir, e.count, e.kinds, _prettyId(e.chestId),
                e.openSec, e.waitSec.toFixed(1), e.msPerItem, e.moved]),
        );
    }

    // ── THE FOUR COSTS ─────────────────────────────────────────────────────────────────────────────
    // Each block is a cost the current chest layout pays and a candidate redesign would change. The two
    // contention clocks stay in SEPARATE fields and are never added: the queue wait is already inside
    // the wait figure, so a sum would double-count the worst chest.
    const totalWait = manifest.reduce((n, e) => n + e.waitSec, 0);
    const totalQueue = [...chests.values()].reduce((n, c) => n + c.queueSec, 0);
    const totalQueues = [...chests.values()].reduce((n, c) => n + c.queues, 0);

    out.section('cost_contention');
    out.kv('wait_sec_total', totalWait.toFixed(1));
    out.kv('moves', manifest.length);
    out.kv('queue_sec_total', totalQueue);
    out.kv('queues', totalQueues);
    const waitRows = [];
    for (const [id, c] of [...chests].sort((a, b) => b[1].waitSec - a[1].waitSec)) {
        if (c.waitSec < 1) continue;
        waitRows.push([_prettyId(id), c.waitSec.toFixed(1), c.deposits + c.retrieves, c.queueSec, c.queues]);
    }
    out.table(['chest', 'wait_sec', 'moves', 'queue_sec', 'queues'], waitRows);

    // Double handling: the same item both deposited into and withdrawn out of the SAME chest. The
    // overlap is the round trip the material did not need to make — the cost a system-wide count would
    // delete outright, since the material was already inside the storage system when it was withdrawn.
    let doubleTotal = 0;
    const doubleRows = [];
    for (const [id, c] of chests) {
        for (const [item, inCount] of Object.entries(c.flowIn)) {
            const outCount = c.flowOut[item] || 0;
            const overlap = Math.min(inCount, outCount);
            if (overlap > 0) { doubleTotal += overlap; doubleRows.push([_prettyId(id), item, inCount, outCount, overlap]); }
        }
    }
    out.section('cost_double_handling');
    out.kv('items_double_handled', doubleTotal);
    out.table(['chest', 'item', 'items_in', 'items_out', 'overlap'], doubleRows.sort());

    let fragChests = 0, fragWaste = 0;
    const fragRows = [];
    for (const [id, c] of chests) {
        if (c.fragPeak > 0) {
            fragChests++; fragWaste += c.fragPeak;
            fragRows.push([_prettyId(id), c.fragPeak, relativeTime(c.fragPeakAt), c.fragPeakText]);
        }
    }
    out.section('cost_fragmentation');
    out.kv('redundant_slots_peak', fragWaste);
    out.kv('chests_fragmented', fragChests);
    out.table(['chest', 'redundant_slots_peak', 'at', 'stacks_at_peak'], fragRows);

    const small = manifest.filter(e => e.count <= SMALL_TRANSFER);
    const bulk = manifest.filter(e => e.count > SMALL_TRANSFER);
    const avg = (rows) => rows.length ? Math.round(rows.reduce((n, e) => n + e.msPerItem, 0) / rows.length) : 0;
    out.section('cost_small_transfer_tax');
    out.kv('small_transfer_max_items', SMALL_TRANSFER);
    out.kv('moves_small', small.length);
    out.kv('moves_bulk', bulk.length);
    out.kv('moves_total', manifest.length);
    out.kv('ms_per_item_small', avg(small));
    out.kv('ms_per_item_bulk', avg(bulk));
}

module.exports = { runInventory };
