/*
item_book_lens.js — the fleet's item book for a finished run (`--items`).

The foreman holds the one item book while the fleet is up (foreman/item_book.js) and writes it whole to
`fleet_logs/item_book.json` when the run ends. This lens reads that file and nothing else: it parses no
trace line, because no trace line carries a pocket.

What it answers:
  ITEM_BOOK            how much was booked, and how often the book disagreed with a pocket or a chest.
  TAKEN_FROM_WORLD     pickups of drops the fleet did not make — what the run actually gathered.
  PICKED_BACK_UP       pickups of the fleet's own items: thrown stacks, placed blocks dug back out, a
                       dead body's pile.
  WHERE_IT_IS          every item by the kind of place it ended in.
  MOVED_BY_CAUSE       every cause a pocket changed for, with its count.
  WASTE_PIT            every thrown stack: who, what, where it stopped, in the pit or not, and who
                       picked it up if anyone did.
  `--all` adds one row per thrown stack, per pocket item and per container item, and every mismatch.

pocketsOf / gatheredOf are the reducers the census, accounting and inventory lenses call for the same
facts, so a pocket is read in one place (Law 16).
*/

'use strict';

const fs = require('fs');
const path = require('path');

function bookFile() {
    return path.join(require(require('./lens_paths').bot('js_kernel/utils/record_homes')).RECORDS_DIR, 'item_book.json');
}

// readBook() → the book, or null when this run wrote none.
function readBook() {
    const file = bookFile();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const _sum = o => Object.values(o || {}).reduce((n, v) => n + v, 0);

// pocketsOf(book) → Map(bot → { item: count }) — every body the book heard from, an empty pocket included.
function pocketsOf(book) {
    const pockets = new Map();
    if (!book) return pockets;
    for (const bot of book.bots || []) pockets.set(bot, {});
    for (const [place, items] of Object.entries(book.holdings || {})) {
        if (!place.startsWith('pocket:')) continue;
        const held = {};
        for (const [item, n] of Object.entries(items)) if (n > 0) held[item] = n;
        pockets.set(place.slice('pocket:'.length), held);
    }
    return pockets;
}

// gatheredOf(book, bot) → { bots, total, rows, sum } of pickups from the world, one body's or the fleet's.
function gatheredOf(book, botFilter = null) {
    const sum = {};
    let bots = 0;
    for (const [bot, items] of Object.entries((book && book.gathered_by_bot) || {})) {
        if (botFilter && bot !== botFilter) continue;
        bots++;
        for (const [item, n] of Object.entries(items)) sum[item] = (sum[item] || 0) + n;
    }
    const rows = Object.entries(sum).sort((a, b) => b[1] - a[1]);
    return { bots, total: rows.reduce((s, [, n]) => s + n, 0), rows, sum };
}

// The kind of place: `pocket:AurenBot` → `pocket`, `container:1|2|3|x` → `container`.
const _kind = place => place.split(':')[0];

function pitOf(book, botFilter = null) {
    const rows = ((book && book.throws) || []).filter(t => !botFilter || t.thrown_by === botFilter);
    const byKind = {}, missByKind = {};
    let inPit = 0, outside = 0, backItems = 0;
    for (const t of rows) {
        byKind[t.item] = (byKind[t.item] || 0) + t.count;
        if (t.landed_in_pit) inPit += t.count;
        else { outside += t.count; missByKind[t.item] = (missByKind[t.item] || 0) + t.count; }
        backItems += (t.picked_up_by || []).reduce((s, p) => s + p.n, 0);
    }
    return { rows, byKind, missByKind, inPit, outside, backItems, stacks: rows.length,
        stacksOutside: rows.filter(t => !t.landed_in_pit).length,
        stacksPickedUp: rows.filter(t => (t.picked_up_by || []).length).length };
}

function runItems({ bot: botFilter = null, verbose = false } = {}) {
    const out = require('./data_out');
    const pairs = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ') || 'none';
    const book = readBook();
    out.kv('lens', 'items');
    if (!book) { out.zero('item_book'); return; }
    if (botFilter) out.kv('bot_filter', botFilter);

    out.section('item_book');
    out.kv('written_at', book.written_at);
    out.kv('bots_reporting', (book.bots || []).length);
    out.kv('entries_received', book.counts.entries);
    out.kv('moves_booked', book.counts.moves);
    out.kv('pickups_booked', book.counts.pickups);
    out.kv('digs_reported', book.counts.digs);
    out.kv('pocket_checks', book.audit.pocket_checks);
    out.kv('pocket_mismatches', book.audit.pocket_mismatches.length);
    out.kv('container_checks', book.audit.container_checks);
    out.kv('container_mismatches', book.audit.container_mismatches.length);
    out.kv('fleet_placed_blocks_standing', book.placed_cells_standing);
    out.kv('dug_back_out_not_collected', book.unplaced_not_collected);

    const g = gatheredOf(book, botFilter);
    out.section('taken_from_world');
    out.kv('items', g.total);
    if (!g.rows.length) out.zero('kinds');
    else out.table(['item', 'taken_from_world'], g.rows);

    out.section('picked_back_up');
    const p = book.pickups;
    out.kv('thrown_stacks', _sum(p.thrown));
    out.kv('thrown_stacks_by_kind', pairs(p.thrown));
    out.kv('placed_blocks_dug_back_out', _sum(p.unplaced));
    out.kv('placed_blocks_by_kind', pairs(p.unplaced));
    out.kv('dead_body_piles', _sum(p.death));
    out.kv('dead_body_piles_by_kind', pairs(p.death));

    out.section('where_it_is');
    const byKind = {};
    for (const [place, items] of Object.entries(book.holdings)) {
        if (botFilter && place.startsWith('pocket:') && place !== `pocket:${botFilter}`) continue;
        const k = _kind(place);
        byKind[k] = byKind[k] || {};
        for (const [item, n] of Object.entries(items)) byKind[k][item] = (byKind[k][item] || 0) + n;
    }
    out.table(['place', 'kinds', 'items'], Object.entries(byKind)
        .map(([k, items]) => [k, Object.keys(items).length, _sum(items)]).sort((a, b) => b[2] - a[2]));

    out.section('moved_by_cause');
    out.table(['cause', 'kinds', 'items'], Object.entries(book.flows)
        .map(([c, items]) => [c, Object.keys(items).length, _sum(items)]).sort((a, b) => b[2] - a[2]));

    out.section('unattributed');
    const un = book.holdings.unattributed || {};
    out.kv('items_net', _sum(un));
    out.kv('by_kind', pairs(Object.fromEntries(Object.entries(un).map(([k, n]) => [k, Math.abs(n)]))));
    out.kv('moves_unattributed', _sum(book.flows.unattributed));
    out.kv('moves_book_correction', _sum(book.flows.book_correction));

    const pit = pitOf(book, botFilter);
    out.section('waste_pit');
    out.kv('stacks_thrown', pit.stacks);
    out.kv('items_thrown', pit.inPit + pit.outside);
    out.kv('items_thrown_by_kind', pairs(pit.byKind));
    out.kv('items_in_pit', pit.inPit);
    out.kv('items_outside_pit', pit.outside);
    out.kv('stacks_outside_pit', pit.stacksOutside);
    out.kv('items_outside_pit_by_kind', pairs(pit.missByKind));
    out.kv('stacks_picked_back_up', pit.stacksPickedUp);
    out.kv('items_picked_back_up', pit.backItems);
    const lastSeen = {};
    for (const t of pit.rows) lastSeen[t.last_seen] = (lastSeen[t.last_seen] || 0) + 1;
    out.kv('stacks_by_last_sight', pairs(lastSeen));

    const flagged = pit.rows.filter(t => !t.landed_in_pit || (t.picked_up_by || []).length);
    out.section('waste_pit_stacks_outside_or_picked_up');
    const throwRow = t => [t.at_sec, t.thrown_by, t.entity, t.item, t.count, t.came_to_rest ? t.came_to_rest.join('|') : null,
        t.landed_in_pit, t.last_seen, (t.picked_up_by || []).map(x => `${x.bot}=${x.n}`).join(' ') || 'nobody'];
    const throwFields = ['at_sec', 'thrown_by', 'entity_id', 'item', 'count', 'came_to_rest', 'in_pit', 'last_sight', 'picked_up_by'];
    if (!flagged.length) out.zero('stacks');
    else out.table(throwFields, flagged.map(throwRow));

    out.section('deaths');
    const deaths = (book.deaths || []).filter(d => !botFilter || d.bot === botFilter);
    if (!deaths.length) out.zero('deaths');
    else out.table(['at_sec', 'bot', 'at', 'items_dropped', 'items_not_picked_up'],
        deaths.map(d => [d.at_sec, d.bot, d.at ? d.at.join('|') : null, _sum(d.items), _sum(d.not_picked_up)]));

    if (verbose) {
        out.section('waste_pit_every_stack');
        if (!pit.rows.length) out.zero('stacks');
        else out.table(throwFields, pit.rows.map(throwRow));

        out.section('pocket_items');
        const pr = [...pocketsOf(book)].filter(([b]) => !botFilter || b === botFilter)
            .flatMap(([b, items]) => Object.entries(items).sort((x, y) => y[1] - x[1]).map(([item, n]) => [b, item, n]));
        if (!pr.length) out.zero('pocket_items');
        else out.table(['bot', 'item', 'count'], pr);

        out.section('place_items');
        const rows = Object.entries(book.holdings).filter(([place]) => !place.startsWith('pocket:'))
            .flatMap(([place, items]) => Object.entries(items).map(([item, n]) => [place, item, n]))
            .sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
        out.table(['place', 'item', 'count'], rows);

        out.section('moved_by_cause_and_item');
        out.table(['cause', 'item', 'count'], Object.entries(book.flows)
            .flatMap(([c, items]) => Object.entries(items).map(([item, n]) => [c, item, n])).sort((a, b) => b[2] - a[2]));

        out.section('pocket_mismatches');
        const pm = book.audit.pocket_mismatches.filter(m => !botFilter || m.bot === botFilter);
        if (!pm.length) out.zero('pocket_mismatches');
        else out.table(['at_sec', 'bot', 'off_by'], pm.map(m => [m.at_sec, m.bot, pairs(m.off_by)]));

        out.section('container_mismatches');
        const cm = book.audit.container_mismatches;
        if (!cm.length) out.zero('container_mismatches');
        else out.table(['at_sec', 'bot', 'place', 'off_by'], cm.map(m => [m.at_sec, m.bot, m.place, pairs(m.off_by)]));
    }
}

module.exports = { readBook, pocketsOf, gatheredOf, pitOf, runItems, bookFile };
