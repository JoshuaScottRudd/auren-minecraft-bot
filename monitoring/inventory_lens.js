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

    console.log(`trace_monitor · inventory · ${traceName} · latest run · span [${relativeTime(maxRel)}]`
        + `${botFilter ? ` · bot=${botFilter}` : ''}`);
    console.log('(context only — never flags, never wakes)\n');

    if (!chests.size && !pockets.size) {
        // The honest zero (Law 25): distinguish "nothing moved" from "nothing was recorded".
        console.log('NO CONTAINER ACTIVITY AND NO POCKET READING IN THIS RUN.');
        console.log('  Every container-to-container move goes through inventory_swapper._executeTransfer,');
        console.log('  and every job_board sweep prints the pocket — so an empty section means the fleet');
        console.log('  never opened a chest AND the board never swept, not that transfers went unlogged.');
        console.log('  Check the run actually started:  trace.ps1 --story');
        console.log('  ONE OTHER CAUSE, and check it before believing the zero: the completion line changed');
        console.log('  shape on 2026-08-14 when one window began carrying several kinds. A trace recorded');
        console.log('  BEFORE that date cannot be read by this lens and will land here looking idle.');
        return;
    }

    // ── STANDING INVENTORY ─────────────────────────────────────────────────────────────────────────
    console.log('STANDING INVENTORY — last known contents, with the age of each reading');
    console.log('  (from the record, not the live world: a container shows what it held when it was last');
    console.log('   opened or swept. An old timestamp means untouched, never empty.)\n');

    const fleetTotal = {};
    // A chest can enter this map from a QUEUE line alone — the record proves the chest exists and that
    // someone waited on it, and says nothing whatever about its contents. Rendering that as `empty` is a
    // false verdict of exactly the kind this lens is meant to kill (Law 25), so a chest with no snapshot
    // is named as unread rather than shown with a zero.
    const unread = [...chests].filter(([, c]) => c.at === null);
    for (const [id, c] of [...chests].filter(([, c]) => c.at !== null).sort((a, b) => a[0].localeCompare(b[0]))) {
        const t = _totals(c.stacks);
        for (const [n, v] of Object.entries(t)) fleetTotal[n] = (fleetTotal[n] || 0) + v;
        const body = c.stacks.length
            ? c.stacks.map(s => `${s.name} x${s.count}`).join(', ')
            : 'empty';
        // The stack count is printed beside the item total because the gap between them IS the
        // fragmentation: "41 in 3 stacks" is one chest slot's worth of goods eating three.
        const split = Object.entries(t).filter(([n]) => c.stacks.filter(s => s.name === n).length > 1);
        const frag = split.length
            ? `  ⚠ fragmented: ${split.map(([n, v]) => `${n} ${v} in ${c.stacks.filter(s => s.name === n).length} stacks`).join(', ')}`
            : '';
        console.log(`  chest ${_prettyId(id).padEnd(16)} [${relativeTime(c.at)}]  ${c.stacks.length} stack(s)  ${body}${frag}`);
    }
    for (const [id, c] of unread) {
        console.log(`  chest ${_prettyId(id).padEnd(16)} [no contents reading in this run — seen only as a `
            + `chest ${c.queues} peer(s) queued at]`);
    }
    console.log('');
    for (const [id, p] of pockets) {
        const t = _totals(p.stacks);
        for (const [n, v] of Object.entries(t)) fleetTotal[n] = (fleetTotal[n] || 0) + v;
        console.log(`  pocket ${String(id).padEnd(15)} [${relativeTime(p.at)}]  `
            + (p.stacks.length ? p.stacks.map(s => `${s.name} x${s.count}`).join(', ') : 'empty'));
    }

    // What the fleet HOLDS, regardless of which container holds it — the same figure job_board judges a
    // storage threshold against, so this line and the board's verdict are readable against each other.
    console.log('\n  FLEET-WIDE TOTAL (every chest + every pocket — the figure a storage threshold measures):');
    const sorted = Object.entries(fleetTotal).sort((a, b) => b[1] - a[1]);
    console.log('    ' + (sorted.length ? sorted.map(([n, v]) => `${n}:${v}`).join('  ') : '(nothing held)'));

    // ── TRANSFER MANIFEST ──────────────────────────────────────────────────────────────────────────
    console.log(`\nTRANSFER MANIFEST — ${manifest.length} container move(s)`);
    console.log('  (ground pickups are absent BY CONSTRUCTION: a harvest never opens a container, so it');
    console.log('   writes no line this lens could match.)\n');

    if (!manifest.length) {
        console.log('  none.\n');
    } else if (verbose) {
        for (const e of manifest) {
            const arrow = e.dir === 'deposit' ? '→' : '←';
            console.log(`  [${relativeTime(e.t)}] ${String(e.bot).padEnd(10)} ${e.dir.padEnd(8)} `
                + `${String(e.count).padStart(3)} item(s) in ${e.kinds} kind(s) ${arrow} chest ${_prettyId(e.chestId).padEnd(16)}`
                + ` wait ${e.waitSec.toFixed(1)}s · ${e.msPerItem}ms/item  [${e.moved}]`);
        }
        console.log('');
    } else {
        console.log('  (--all prints every move; per-chest and per-item rolls follow)\n');
    }

    // ── THE FOUR COSTS ─────────────────────────────────────────────────────────────────────────────
    // Each row is a cost the current chest design pays and a candidate redesign would change. They are
    // reported as measurements with their evidence, never as a verdict on the design (Law 23 — the
    // reader judges; the lens states what was sensed).
    console.log('THE FOUR COSTS — what the current chest layout actually spends\n');

    const totalWait = manifest.reduce((n, e) => n + e.waitSec, 0);
    const totalQueue = [...chests.values()].reduce((n, c) => n + c.queueSec, 0);
    const totalQueues = [...chests.values()].reduce((n, c) => n + c.queues, 0);
    // Two clocks, never added together in the headline and never added in a row either — `waiting to get
    // in` covers walk + lock acquire on EVERY move, while the queue clock counts only the moves that
    // found a peer holding the chest, and the queue wait is already inside the wait figure. Summing them
    // double-counts the worst chest, which is exactly the chest a reader is deciding about.
    console.log(`  1. CONTENTION   ${totalWait.toFixed(1)}s spent getting in to a chest across ${manifest.length} move(s)`
        + `${totalQueues ? `, of which ${totalQueue}s was ${totalQueues} lock queue(s) behind a peer` : ', no lock queue formed'}`);
    for (const [id, c] of [...chests].sort((a, b) => b[1].waitSec - a[1].waitSec)) {
        if (c.waitSec < 1) continue;
        console.log(`       chest ${_prettyId(id).padEnd(16)} ${c.waitSec.toFixed(1)}s over `
            + `${c.deposits + c.retrieves} move(s)${c.queues ? ` · of that, ${c.queueSec}s in ${c.queues} peer queue(s)` : ''}`);
    }

    // Double handling: the same item both deposited into and withdrawn out of the SAME chest. The
    // overlap is the round trip the material did not need to make — the cost a system-wide count would
    // delete outright, since the material was already inside the storage system when it was withdrawn.
    console.log('');
    let doubleTotal = 0;
    const doubleRows = [];
    for (const [id, c] of chests) {
        for (const [item, inCount] of Object.entries(c.flowIn)) {
            const outCount = c.flowOut[item] || 0;
            const overlap = Math.min(inCount, outCount);
            if (overlap > 0) { doubleTotal += overlap; doubleRows.push(`${item} ${overlap} (in ${inCount}, out ${outCount}) at ${_prettyId(id)}`); }
        }
    }
    console.log(`  2. DOUBLE HANDLING  ${doubleTotal} item(s) went INTO a chest and later back OUT of the same chest`);
    for (const r of doubleRows.sort()) console.log(`       ${r}`);
    console.log('       (measured from consecutive chest snapshots, so a deposit named `oak_log` and a');
    console.log('        withdrawal named `logs` are the same material — a name join reports zero here)');
    if (!doubleRows.length) console.log('       none — every item that entered a chest stayed in it.');

    console.log('');
    let fragChests = 0, fragWaste = 0;
    const fragRows = [];
    for (const [id, c] of chests) {
        if (c.fragPeak > 0) {
            fragChests++; fragWaste += c.fragPeak;
            fragRows.push(`chest ${_prettyId(id)} peaked at ${c.fragPeak} redundant slot(s) [${relativeTime(c.fragPeakAt)}]: ${c.fragPeakText}`);
        }
    }
    console.log(`  3. FRAGMENTATION  ${fragWaste} redundant stack slot(s) at peak across ${fragChests} chest(s)`
        + ' — one item type occupying several slots where one would hold it');
    for (const r of fragRows) console.log(`       ${r}`);
    console.log('       (PEAK, not the closing snapshot: a chest drained by the end reads zero all run');
    console.log('        while having spent the slots. A chest is 27 slots; this is what a consolidation');
    console.log('        pass would return.)');

    console.log('');
    const small = manifest.filter(e => e.count <= SMALL_TRANSFER);
    const bulk = manifest.filter(e => e.count > SMALL_TRANSFER);
    const avg = (rows) => rows.length ? Math.round(rows.reduce((n, e) => n + e.msPerItem, 0) / rows.length) : 0;
    console.log(`  4. SMALL-TRANSFER TAX  ${small.length} of ${manifest.length} move(s) carried ≤${SMALL_TRANSFER} item(s)`
        + ` at ${avg(small)}ms/item, vs ${avg(bulk)}ms/item for the ${bulk.length} larger move(s)`);
    console.log('       (the window open/close is a fixed cost, so a 1-item trip pays it in full; the ratio');
    console.log('        is what batching would recover, and it is per-move, not per-item)');

    if (!verbose) console.log('\n(--all prints the full move-by-move manifest)');
}

module.exports = { runInventory };
