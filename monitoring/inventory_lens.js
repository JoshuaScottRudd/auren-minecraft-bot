// Auren_Bot/monitoring/inventory_lens.js
// Reports where every item is, and every transfer of one between containers.
//
// The harvest exclusion is structural: a ground pickup never passes through inventory_swapper, so no
// line here could ever match one. Every container-to-container transfer goes through one function
// (`_executeTransfer`), so its completion line is the whole manifest (Law 16).
//
// Reads the trace, never the world. Every figure is LAST KNOWN — the newest snapshot the record carries
// for each container, with its timestamp attached (Law 25: a number must answer the question asked of
// it). A container nobody touched shows its age, not a stale zero.
//
// Backs the chest-system redesign by totalling four costs: contention wait, double handling (deposited
// and withdrawn again), stack fragmentation, and the fixed toll a small transfer pays as heavily as a
// large one.

'use strict';

const { relativeTime } = require('./trace_read');
const out = require('./data_out'); // the one writer to stdout — every figure leaves as a field name and value

// The completion line every container-to-container move writes (inventory_swapper._executeTransfer);
// the chest's post-move snapshot is its tail, so standing contents and the manifest share one regex.
// One line per window, carrying however many kinds it moved — the unit is the visit, not the item kind.
const TX_RE = /(deposit|retrieve) complete — (\d+) kind\(s\), (\d+) item\(s\) \[([^\]]*)\] in ([\d.]+)s open \((\d+)ms\/item\) after ([\d.]+)s waiting to get in\. Chest (\S+): (\d+) stack\(s\) \[([^\]]*)\]/;
// The queue wait, distinct from `waiting to get in`: the walk-and-wait for a peer to release the lock,
// reported only when a queue actually formed.
const QUEUE_RE = /chest (\S+) released after (\d+)s in queue/;
// The composter's visit line (compost_executor.feedFromPocket), fed or given up, carrying the same
// "waiting to get in" clock the chest line does, so the two sum into one queue figure.
// The time from the click until the window's contents matched the chest's last picture.
const PICTURE_RE = /Contents matched the picture in (\d+)ms\./;
// The walk to the chest's stance, the travel share of the chest line's wait clock.
const WALK_RE = /Walked ([\d.]+)s of the wait\./;
// The chest timer (inventory_swapper._executeTransfer), one per window since storage dropped its lock and
// queue: walk, open (click to window), picture (window to matching the record), work (to the close), and how
// many peers were using the same chest when the window opened and closed.
const CHEST_TIMER_RE = /chest timer (deposit|retrieve) (\S+(?: #\d+)?) (\S+): walk=([\d.]+) open=([\d.]+) picture=([\d.]+) work=([\d.]+) total=([\d.]+) peers_at_open=(\d+) peers_at_close=(\d+) contended=([01]) items=(\d+)/;
const COMPOST_WAIT_RE =/compost_executor: fed (\d+) item\(s\)(.*?) after ([\d.]+)s waiting to get in\./;

// ── THE MATERIAL ACCOUNT ─────────────────────────────────────────────────────
// A felling line gives the amount that entered the system; joined against fleet_total_held it says
// where that material ended up. A harvest is not a container transfer, so it stays out of the manifest
// and feeds only the account section (Law 29).
//
// gone_consumed_or_lost cannot be split further: crafted, smelted, burned as fuel, and dropped on death
// share no common line in the record, so the four are reported as one figure instead of a guess (Law 25).
const FELLED_RE = /Felled (\w+), mined (\d+)/;
// ── THE CLAIM LEDGER ─────────────────────────────────────────────────────────
// A claim is the only thing standing between two bodies and one stack, so whether it fires is the first
// question to ask of a run. The regexes match the vocabulary the fleet currently writes (Law 25).
const CLAIM_RE = /(\S+) claimed (.+?) at (\S+) — held until its magnet clears/;
const UNCLAIM_RE = /(\S+) released its claim at (\S+) \((.*?)\)/;
// Two reasons a body declines a trip, kept as separate fields (Law 25): trips_skipped_claimed means
// claims are draining the pool faster than it fills; trips_skipped_tiny means the trip was too small to
// be worth taking.
const SKIPPED_RE = /NOT walking to the barrel: (\w+): all of it at (\S+) is claimed by other bodies \((\d+) spoken for\)/;
const TINY_RE = /NOT walking to the barrel: (\w+): only (\d+) unclaimed and I need (\d+) — too small a trip/;
// ── THE FIXED TOLL EVERY WINDOW PAYS ─────────────────────────────────────────
// open_sec covers both the transfer clicks and the fixed open/settle/close a window pays regardless of
// what it carries; separating them says whether a chest is busy doing work or busy being opened.
// fixed_toll_sec_floor is a floor, not a measurement — the trace carries no per-phase timing, so this
// multiplies the known constant by the window count.
const FIXED_TOLL_SEC = 0.43;

const BARREL_SLOTS = 27;          // a barrel's slot count; a snapshot with this many stacks is a full barrel
const SMALL_TRANSFER = 2;        // at or below this the fixed ~430ms window overhead dominates entirely

function _parseStacks(text) {
    // "oak_log x37, oak_log x3, oak_log x1" → [{name, count}], preserving the split (three entries, not
    // one sum) since fragmentation is one of the four costs this lens measures.
    if (!text || text === 'empty') return [];
    const out = [];
    for (const part of text.split(',')) {
        const m = part.trim().match(/^(\S+) x(\d+)$/);
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
    const gathered = {};          // item → total taken out of the world (the felling line)
    const claimsTaken = [];       // every claim the ledger filed (the claim system firing at all)
    const claimsReleased = [];    // every claim it dropped, with the reason
    const skipped = [];           // trips declined because a peer had already spoken for the stock
    const tiny = [];              // trips declined as too small to be worth taking
    let fellings = 0;
    let maxRel = 0;
    const composter = { waitSec: 0, visits: 0, gaveUp: 0 };
    const timers = [];            // one row per chest timer line

    const C = (id) => {
        let c = chests.get(id);
        if (!c) {
            c = { stacks: [], at: null, deposits: 0, retrieves: 0, itemsIn: 0, itemsOut: 0,
                  waitSec: 0, queueSec: 0, queues: 0, flowIn: {}, flowOut: {}, lastTotals: {},
                  fragPeak: 0, fragPeakAt: null, fragPeakText: '',
                  slotsPeak: 0, slotsPeakAt: null, fullSince: null, fullSec: 0, fullTimes: 0 };
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

            // Flow is read from consecutive snapshots, not from the transfer's own item name — a deposit
            // names `oak_log` while its matching withdrawal names the group token `logs`. The chest's
            // post-move contents are ground truth and need no group table (Law 16).
            const now = _totals(stacks);
            for (const name of new Set([...Object.keys(now), ...Object.keys(c.lastTotals)])) {
                const delta = (now[name] || 0) - (c.lastTotals[name] || 0);
                if (delta > 0) c.flowIn[name] = (c.flowIn[name] || 0) + delta;
                else if (delta < 0) c.flowOut[name] = (c.flowOut[name] || 0) - delta;
            }
            c.lastTotals = now;

            // Fragmentation is measured at its peak, never the closing snapshot — a chest drained by
            // run's end would otherwise report zero after holding fragmented stacks throughout.
            const byName = {};
            for (const s of stacks) byName[s.name] = (byName[s.name] || 0) + 1;
            const extra = Object.values(byName).reduce((n, k) => n + (k - 1), 0);
            if (extra > c.fragPeak) { c.fragPeak = extra; c.fragPeakAt = l.relSec; c.fragPeakText = stackText; }

            // Fill is read the same way: the most slots any snapshot showed, and the time between a
            // snapshot showing every slot taken and the next one showing a free slot.
            if (stacks.length > c.slotsPeak) { c.slotsPeak = stacks.length; c.slotsPeakAt = l.relSec; }
            if (stacks.length >= BARREL_SLOTS) {
                if (c.fullSince === null) { c.fullSince = l.relSec; c.fullTimes++; }
            } else if (c.fullSince !== null) { c.fullSec += l.relSec - c.fullSince; c.fullSince = null; }

            c.stacks = stacks;      // newest snapshot wins outright for STANDING contents — no merging
            c.at = l.relSec;
            c.waitSec += +waitStr;
            if (dir === 'deposit') { c.deposits++; c.itemsIn += count; }
            else                   { c.retrieves++; c.itemsOut += count; }
            const pic = l.raw.match(PICTURE_RE);
            const walk = l.raw.match(WALK_RE);
            manifest.push({ t: l.relSec, bot: l.bot, dir, count, kinds, moved: movedText, chestId,
                            openSec: +openStr, msPerItem: +msPerItem, waitSec: +waitStr,
                            pictureMs: pic ? +pic[1] : null, walkSec: walk ? +walk[1] : null });
        } else if ((m = l.raw.match(CHEST_TIMER_RE))) {
            timers.push({ dir: m[1], chest: m[3], walk: +m[4], open: +m[5], picture: +m[6], work: +m[7], total: +m[8],
                          peersOpen: +m[9], peersClose: +m[10], contended: m[11] === '1', items: +m[12] });
        } else if ((m = l.raw.match(QUEUE_RE))) {
            const c = C(m[1]); c.queues++; c.queueSec += +m[2];
        } else if ((m = l.raw.match(COMPOST_WAIT_RE))) {
            composter.visits++;
            composter.waitSec += +m[3];
            if (/gave up/.test(m[2])) composter.gaveUp++;
        } else if ((m = l.raw.match(FELLED_RE))) {
            // The felling line names the log TYPE it took, so the account is per-species and joins
            // straight onto the chest and pocket totals, which are per-species too.
            gathered[m[1]] = (gathered[m[1]] || 0) + (+m[2]);
            fellings++;
        } else if ((m = l.raw.match(CLAIM_RE))) {
            claimsTaken.push({ t: l.relSec, bot: l.bot, what: m[2], station: m[3] });
        } else if ((m = l.raw.match(UNCLAIM_RE))) {
            claimsReleased.push({ t: l.relSec, bot: l.bot, station: m[2], why: m[3] });
        } else if ((m = l.raw.match(SKIPPED_RE))) {
            skipped.push({ t: l.relSec, bot: l.bot, item: m[1], station: m[2], spoken: +m[3] });
        } else if ((m = l.raw.match(TINY_RE))) {
            tiny.push({ t: l.relSec, bot: l.bot, item: m[1], offered: +m[2], needed: +m[3] });
        }
    }
    // Pockets are the foreman's item book at the end of the run (item_book_lens.pocketsOf).
    const itemBook = require('./item_book_lens');
    for (const [id, items] of itemBook.pocketsOf(itemBook.readBook())) {
        if (botFilter && id !== botFilter) continue;
        pockets.set(id, { stacks: Object.entries(items).map(([name, count]) => ({ name, count })), at: maxRel });
    }

    // ── OUTPUT IS DATA, NOT PROSE ───────────────────────────────────────────
    // Every string below is a field name this lens declared or a value copied from the record.
    out.kv('lens', 'inventory');
    out.kv('record', traceName);
    out.kv('span', relativeTime(maxRel));
    if (botFilter) out.kv('bot_filter', botFilter);

    if (!chests.size && !pockets.size) {
        // The honest zero (Law 25).
        out.zero('chests');
        out.zero('pockets');
        out.zero('transfers');
        return;
    }

    // ── STANDING INVENTORY ───────────────────────────────────────────────────────────────────────────
    // Contents render as `name:count` pairs, the record's own pocket shape. Split stacks stay split
    // (three `oak_log` entries, not one sum) since fragmentation is one of the four costs measured below.
    const cells = (stacks) => (stacks.length ? stacks.map(s => `${s.name}:${s.count}`).join(',') : 0);

    const fleetTotal = {};
    // A chest can appear here from a QUEUE line alone, proving only that it exists and was waited on —
    // not its contents. It gets its own block with a peer count, not a false `empty` (Law 25).
    const unread = [...chests].filter(([, c]) => c.at === null);
    const chestRows = [];
    for (const [id, c] of [...chests].filter(([, c]) => c.at !== null).sort((a, b) => a[0].localeCompare(b[0]))) {
        const t = _totals(c.stacks);
        for (const [n, v] of Object.entries(t)) fleetTotal[n] = (fleetTotal[n] || 0) + v;
        // The gap between stack count and item total is the fragmentation; the last snapshot's redundant
        // slot count travels beside the peak figure in cost_fragmentation.
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

    // What the fleet holds, regardless of which container holds it — the same figure job_board judges a
    // storage threshold against.
    const sorted = Object.entries(fleetTotal).sort((a, b) => b[1] - a[1]);
    out.section('fleet_total_held');
    if (!sorted.length) out.zero('items');
    else out.table(['item', 'count'], sorted);

    // ── THE MATERIAL ACCOUNT ────────────────────────────────────────────────────────────────────────
    // Three columns of one balance, per item: what entered, what is held now, and what is neither
    // (gone_consumed_or_lost). held_now repeats the fleet_total_held figure so the row is self-contained
    // (Law 29).
    const accountRows = [];
    for (const item of Object.keys(gathered).sort()) {
        const held = fleetTotal[item] || 0;
        accountRows.push([item, gathered[item], held, gathered[item] - held]);
    }
    out.section('material_account');
    out.kv('fellings', fellings);
    if (!accountRows.length) out.zero('gathered_kinds');
    else out.table(['item', 'gathered_from_world', 'held_now', 'gone_consumed_or_lost'], accountRows);

    // ── THROUGHPUT ──────────────────────────────────────────────────────────────────────────────────
    // items_per_min is the rate a one-barrel question turns on; open_share_of_run says whether a chest
    // is saturated or merely contended, independent of queue length. Both are printed since neither
    // answers the other.
    const runMin = maxRel > 0 ? maxRel / 60 : 0;
    const thruRows = [];
    for (const [id, c] of [...chests].sort((a, b) => (b[1].itemsIn + b[1].itemsOut) - (a[1].itemsIn + a[1].itemsOut))) {
        const openSec = manifest.filter(e => e.chestId === id).reduce((n, e) => n + e.openSec, 0);
        const moved = c.itemsIn + c.itemsOut;
        thruRows.push([_prettyId(id), c.deposits, c.retrieves, c.itemsIn, c.itemsOut,
            runMin > 0 ? (moved / runMin).toFixed(1) : '0.0',
            openSec.toFixed(1),
            maxRel > 0 ? `${(100 * openSec / maxRel).toFixed(1)}%` : '0.0%']);
    }
    out.section('station_throughput');
    out.kv('run_min', runMin.toFixed(1));
    if (!thruRows.length) out.zero('stations');
    else out.table(['chest', 'deposits', 'retrieves', 'items_in', 'items_out', 'items_per_min',
        'window_open_sec', 'open_share_of_run'], thruRows);

    // ── THE CLAIM LEDGER (chest_ledger) ────────────────────────────────────────────────────────────
    // claims_taken against chest_retrieves is the health of the mechanism: a retrieval with no claim
    // behind it is a stack two bodies could have walked for. trips_skipped has no counterpart anywhere
    // else in the record — a trip not taken writes no transfer, queue, or walk line.
    out.section('claim_ledger');
    out.kv('claims_taken', claimsTaken.length);
    out.kv('claims_released', claimsReleased.length);
    out.kv('claims_still_held_at_trace_end', Math.max(0, claimsTaken.length - claimsReleased.length));
    // See SKIPPED_RE / TINY_RE — two skip reasons, two fields.
    out.kv('trips_skipped_claimed', skipped.length);
    out.kv('trips_skipped_tiny', tiny.length);
    if (verbose && claimsTaken.length) {
        out.table(['at', 'bot', 'claimed', 'station'],
            claimsTaken.map(c => [relativeTime(c.t), c.bot, c.what, c.station]));
    }
    if (verbose && skipped.length) {
        out.table(['at', 'bot', 'item', 'station', 'spoken_for'],
            skipped.map(s => [relativeTime(s.t), s.bot, s.item, s.station, s.spoken]));
    }
    if (verbose && tiny.length) {
        out.table(['at', 'bot', 'item', 'offered', 'needed'],
            tiny.map(s => [relativeTime(s.t), s.bot, s.item, s.offered, s.needed]));
    }

    // ── WINDOW COST ─────────────────────────────────────────────────────────────────────────────────
    // A duty cycle alone can't distinguish one bot holding a chest for ten minutes from four hundred
    // bots holding it a second each. windows and sec_per_window separate them; fixed_toll_sec_floor is
    // how much of the total was spent on no items at all.
    const openTotal = manifest.reduce((n, e) => n + e.openSec, 0);
    const tolls = manifest.length * FIXED_TOLL_SEC;
    out.section('window_cost');
    out.kv('windows', manifest.length);
    out.kv('open_sec_total', openTotal.toFixed(1));
    out.kv('sec_per_window_mean', manifest.length ? (openTotal / manifest.length).toFixed(2) : '0.00');
    out.kv('sec_per_window_median', manifest.length
        ? [...manifest].sort((a, b) => a.openSec - b.openSec)[Math.floor(manifest.length / 2)].openSec.toFixed(2)
        : '0.00');
    out.kv('windows_per_min', runMin > 0 ? (manifest.length / runMin).toFixed(1) : '0.0');
    out.kv('fixed_toll_sec_floor', tolls.toFixed(1));
    out.kv('fixed_toll_share_of_open', openTotal > 0 ? `${(100 * tolls / openTotal).toFixed(1)}%` : '0.0%');
    const pictured = manifest.filter(e => e.pictureMs != null).map(e => e.pictureMs).sort((a, b) => a - b);
    out.kv('windows_with_picture', pictured.length);
    out.kv('picture_match_sec_total', (pictured.reduce((n, v) => n + v, 0) / 1000).toFixed(1));
    out.kv('picture_match_ms_median', pictured.length ? pictured[Math.floor(pictured.length / 2)] : 0);
    out.kv('picture_match_ms_max', pictured.length ? pictured[pictured.length - 1] : 0);
    const byLoad = { '0': 0, '1-2': 0, '3-8': 0, '9-32': 0, '33+': 0 };
    for (const e of manifest) {
        const b = e.count === 0 ? '0' : e.count <= 2 ? '1-2' : e.count <= 8 ? '3-8' : e.count <= 32 ? '9-32' : '33+';
        byLoad[b]++;
    }
    out.table(['items_moved', 'windows'], Object.entries(byLoad).map(([k, v]) => [k, v]));

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
    // Each block is a cost the current chest layout pays. The two contention clocks stay separate
    // fields: queue wait is already counted inside the wait figure.
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

    // ── QUEUE TIME, ONE NUMBER ─────────────────────────────────────────────────────────────────────
    // Waiting is time a body stands at a station before it gets in. The walk to the chest is WALKING, not
    // waiting: it is taken out of every window's clock here and tallied with every other walk by
    // `--walking`. `chest_walk_bot_min` stays beside the wait as the chest's share of that walking.
    const botMin = (sec) => (sec / 60).toFixed(1);
    const walkTotal = manifest.reduce((n, e) => n + (e.walkSec || 0), 0);
    const chestWait = Math.max(0, totalWait - walkTotal);
    const queueTotal = [...chests.values()].reduce((n, c) => n + c.queueSec, 0);
    out.section('queue_time');
    out.kv('chest_windows', manifest.length);
    out.kv('chest_windows_with_walk', manifest.filter(e => e.walkSec != null).length);
    out.kv('chest_clock_bot_min', botMin(totalWait));
    out.kv('chest_walk_bot_min', botMin(walkTotal));
    out.kv('chest_wait_sec', chestWait.toFixed(1));
    out.kv('chest_wait_bot_min', botMin(chestWait));
    out.kv('chest_queue_bot_min', botMin(queueTotal));
    out.kv('chest_open_bot_min', botMin(manifest.reduce((n, e) => n + e.openSec, 0)));
    out.kv('composter_wait_sec', composter.waitSec.toFixed(1));
    out.kv('composter_wait_bot_min', botMin(composter.waitSec));
    out.kv('composter_visits', composter.visits);
    out.kv('composter_gave_up', composter.gaveUp);
    out.kv('total_wait_sec', (chestWait + composter.waitSec).toFixed(1));
    out.kv('total_wait_bot_min', botMin(chestWait + composter.waitSec));

    // ── CHEST TIMERS: THE NO-QUEUE VISIT, PHASE BY PHASE ────────────────────────────────────────────────
    // Read beside queue_time: `chest_wait_bot_min` above is the standing time before a body could act,
    // whatever the system; this splits it. `queue_bot_min` is 0 by construction under the no-queue system and
    // is printed so the comparison with a queued run reads off one field. A run from before the timer line
    // existed prints windows 0 here.
    const sum = (k, rows = timers) => rows.reduce((n, t) => n + t[k], 0);
    out.section('chest_timers');
    out.kv('windows', timers.length);
    out.kv('windows_contended', timers.filter(t => t.contended).length);
    out.kv('peers_at_open_max', timers.reduce((n, t) => Math.max(n, t.peersOpen), 0));
    out.kv('walk_bot_min', botMin(sum('walk')));
    out.kv('open_bot_min', botMin(sum('open')));
    out.kv('picture_bot_min', botMin(sum('picture')));
    out.kv('queue_bot_min', botMin(0));
    out.kv('standing_before_work_bot_min', botMin(sum('open') + sum('picture')));
    out.kv('work_bot_min', botMin(sum('work')));
    out.kv('visit_bot_min', botMin(sum('total')));
    out.kv('items', sum('items'));
    if (timers.length) {
        const rows = ['deposit', 'retrieve'].map(d => {
            const r = timers.filter(t => t.dir === d);
            const mean = (k) => r.length ? (sum(k, r) / r.length).toFixed(2) : '0.00';
            return [d, r.length, r.filter(t => t.contended).length, mean('walk'), mean('open'), mean('picture'), mean('work'), mean('total')];
        });
        out.table(['direction', 'windows', 'contended', 'walk_s_mean', 'open_s_mean', 'picture_s_mean', 'work_s_mean', 'total_s_mean'], rows);
    }

    // Double handling: the same item deposited into and withdrawn from the SAME chest — the round trip
    // the material did not need to make, since it was already inside storage when withdrawn.
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
    const fillRows = [];
    let everFull = 0, fullAtEnd = 0;
    for (const [id, c] of [...chests].filter(([, c]) => c.at !== null).sort((a, b) => b[1].slotsPeak - a[1].slotsPeak)) {
        const openFull = c.fullSince !== null ? maxRel - c.fullSince : 0;
        if (c.fullTimes) everFull++;
        if (c.fullSince !== null) fullAtEnd++;
        fillRows.push([_prettyId(id), c.slotsPeak, relativeTime(c.slotsPeakAt), c.fullTimes,
                       Math.round((c.fullSec + openFull) / 6) / 10, c.stacks.length]);
    }
    out.section('chest_fill');
    out.kv('barrel_slots', BARREL_SLOTS);
    out.kv('chests_read', fillRows.length);
    out.kv('chests_ever_full', everFull);
    out.kv('chests_full_at_end', fullAtEnd);
    out.table(['chest', 'slots_peak', 'peak_at', 'times_full', 'full_min', 'slots_at_end'], fillRows);

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

module.exports = { runInventory, TX_RE, parseStacks: _parseStacks };
