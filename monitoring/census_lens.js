/*
census_lens.js — every item the fleet authored, counted once, at the end of the run.

The insight this lens is built on: a run starts with an empty world and empty bodies, so at the end,
every item that exists anywhere in the fleet was put there by the fleet. There is nothing to subtract and
no baseline to keep. Sum the pockets, the containers and the blocks standing in a blueprint, and that sum
is the run's output.

What it replaces: `--inventory`'s `material_account` measures gathered-minus-held to infer consumption,
which needs a `Felled` line for every acquisition — so a block punched off the ground, a smelt, a craft
and a drop pickup are all invisible to it, and the residual column absorbs every one of them as "gone".
This lens never infers: it counts what is there.

Double counting is the one way it could lie, and the three sources are disjoint by construction. A log in
a pocket is not in a barrel; a barrel's contents are not its own block; a placed block is out of every
inventory in the world. Nothing is summed twice because nothing can be in two of the three at once.

── WHERE THE FACTS COME FROM ─────────────────────────────────────────────────────────────────────────
  pockets  the foreman's item book (`fleet_logs/item_book.json`, read through item_book_lens) — one
           pocket per body, as the foreman held it when the run ended.
  📦  `station_registry` the station census — every registered container, barrels and furnaces alike
                         (`logContents` admits `isStorage(e) || entry.type === 'furnace'`).
  📊  `building_integrity` "<name>" — N/M structure placed.

── THE ONE THING IT CANNOT SEE ───────────────────────────────────────────────────────────────────────
A container the registry never printed after its last change reads at its last printed contents, and a
body that stopped sweeping (died, disconnected) reads at its last sweep. Both are named per row with the
timestamp the reading was taken, so a stale row is visible as stale, never silently folded into the total
(Law 25). `census_read_at` carries the spread.
*/

'use strict';

// 📦 barrel(-83|71|-120|builder) [laydown_yard]: stone_pickaxex4, torchx24
// 📦 furnace(-83|72|-120|builder) [laydown_yard] 🔒 in use by KoaBot: charcoalx7
const FULL_RE  = /📦 (\w+)\(([^)]*)\)(?:\s*\[([^\]]*)\])?(?:\s*🔒[^:]*)?: (.+?)\s*$/;

// 📦 empty: barrel(-80|71|-120|builder) [laydown_yard], barrel(-79|71|-117|builder) [laydown_yard]
// Parsed so an empty container still appears as a row. A container that holds nothing is a FACT about
// the run — twelve barrels standing empty is a different picture from twelve barrels full — and a lens
// that only listed the full ones would show the same census either way (Law 6).
const EMPTY_RE = /📦 empty: (.+?)\s*$/;
const EMPTY_ONE_RE = /(\w+)\(([^)]*)\)(?:\s*\[([^\]]*)\])?/g;

// 📊 "laydown_yard" — 52/53 structure placed · 1 to place, 0 to dig
const PLACED_RE = /"([^"]+)" — (\d+)\/(\d+) structure placed/;

// 📊 build_column_executor: column 12 cube 108 layer 1 — dug 64, placed 21, failed 0[, shaft 9 placed 0 failed][, climb stopped at y71]
// One line per trip into a downloaded building, and the one statement of it (accounting_lens reads the
// trips through this same expression). A downloaded building is raised by these trips and is never
// scanned as a whole, so its placed blocks reach the census from here.
const COLUMN_TRIP_RE = /build_column_executor: column (\d+) cube (\d+) layer (\d+) — dug (\d+), placed (\d+), failed (\d+)(, shaft (\d+) placed (\d+) failed)?(, climb stopped)?/;

function _parseContainer(text) {
    const out = {};
    for (const part of text.split(',')) {
        const m = part.trim().match(/^(.+?)x(\d+)$/);
        if (m) out[m[1].trim()] = (out[m[1].trim()] || 0) + (+m[2]);
    }
    return out;
}

const _sum = (o) => Object.values(o).reduce((n, v) => n + v, 0);

function reduceCensus({ seg = [] } = {}) {
    const pockets = new Map();      // botId → { items, at, pos }
    const containers = new Map();   // id → { type, blueprint, items, at }
    const placed = new Map();       // blueprint → { placed, total, at }
    const columns = { trips: 0, placed: 0, at: null };
    // An executor's result line reaches the record twice, once as written and once inside the judge's
    // verdict, so a trip is counted on its first appearance from a body.
    const seenTrip = new Set();
    let maxRel = 0;

    for (const l of seg) {
        if (l.relSec == null) continue;
        maxRel = Math.max(maxRel, l.relSec);
        let m;

        if ((m = l.raw.match(FULL_RE))) {
            containers.set(m[2], { type: m[1], blueprint: m[3] || '', items: _parseContainer(m[4]), at: l.relSec });
        } else if ((m = l.raw.match(EMPTY_RE))) {
            let e;
            EMPTY_ONE_RE.lastIndex = 0;
            while ((e = EMPTY_ONE_RE.exec(m[1])) !== null) {
                containers.set(e[2], { type: e[1], blueprint: e[3] || '', items: {}, at: l.relSec });
            }
        } else if ((m = l.raw.match(PLACED_RE))) {
            placed.set(m[1], { placed: +m[2], total: +m[3], at: l.relSec });
        } else if ((m = l.raw.match(COLUMN_TRIP_RE))) {
            const key = `${l.bot || '?'}|${m[0]}`;
            if (!seenTrip.has(key)) {
                seenTrip.add(key);
                columns.trips++;
                columns.placed += +m[5];
                columns.at = l.relSec;
            }
        }
    }

    // Pockets are the item book's (item_book_lens.pocketsOf): each body's pocket as the foreman held it
    // when the run ended, checked against the body's own reading every 30 s.
    const itemBook = require('./item_book_lens');
    for (const [bot, items] of itemBook.pocketsOf(itemBook.readBook())) pockets.set(bot, { items, at: maxRel });

    const byItem = {};           // item → { pockets, containers }
    for (const p of pockets.values())
        for (const [n, v] of Object.entries(p.items)) {
            byItem[n] = byItem[n] || { pockets: 0, containers: 0 };
            byItem[n].pockets += v;
        }
    for (const c of containers.values())
        for (const [n, v] of Object.entries(c.items)) {
            byItem[n] = byItem[n] || { pockets: 0, containers: 0 };
            byItem[n].containers += v;
        }

    const inPockets = [...pockets.values()].reduce((n, p) => n + _sum(p.items), 0);
    const inContainers = [...containers.values()].reduce((n, c) => n + _sum(c.items), 0);
    // Two counts of a different kind, kept apart and then summed: a scanned blueprint states what STANDS
    // in it, a column trip states what that trip PLACED.
    const scannedPlaced = [...placed.values()].reduce((n, b) => n + b.placed, 0);
    const blocksPlaced = scannedPlaced + columns.placed;

    // THE SPREAD, not an average. A census whose oldest reading is nine minutes stale is a different
    // document from one taken inside the last ten seconds, and only the two ends say which this is.
    const reads = [...pockets.values(), ...containers.values()].map(x => x.at);
    const runMin = maxRel > 0 ? maxRel / 60 : 0;

    return {
        pockets, containers, placed, byItem,
        inPockets, inContainers, blocksPlaced, scannedPlaced, columns,
        total: inPockets + inContainers + blocksPlaced,
        bots: pockets.size,
        runSec: maxRel,
        runMin,
        // Bot-minutes: the denominator this project measures work in — bots running times minutes run.
        // Computed from the bodies this census actually saw, never from the roster, so a run that lost a
        // body does not flatter itself.
        botMinutes: pockets.size * runMin,
        oldestRead: reads.length ? Math.min(...reads) : null,
        newestRead: reads.length ? Math.max(...reads) : null,
    };
}

function runCensus({ seg = [], verbose = false } = {}) {
    const out = require('./data_out');
    const { relativeTime } = require('./report_formatting');
    const r = reduceCensus({ seg });

    out.section('census_totals');
    out.kv('bots_counted', r.bots);
    out.kv('run_min', r.runMin.toFixed(2));
    out.kv('bot_minutes', r.botMinutes.toFixed(1));
    out.kv('items_in_pockets', r.inPockets);
    out.kv('items_in_containers', r.inContainers);
    out.kv('blocks_placed_in_blueprints', r.blocksPlaced);
    out.kv('blocks_standing_in_scanned_blueprints', r.scannedPlaced);
    out.kv('blocks_placed_by_column_trips', r.columns.placed);
    out.kv('column_trips', r.columns.trips);
    out.kv('total_bot_authored', r.total);
    out.kv('per_bot_minute', r.botMinutes > 0 ? (r.total / r.botMinutes).toFixed(2) : '0.00');
    out.kv('census_read_at_oldest', r.oldestRead == null ? 'none' : relativeTime(r.oldestRead));
    out.kv('census_read_at_newest', r.newestRead == null ? 'none' : relativeTime(r.newestRead));

    out.section('census_by_item');
    const itemRows = Object.entries(r.byItem)
        .map(([n, v]) => [n, v.pockets, v.containers, v.pockets + v.containers])
        .sort((a, b) => b[3] - a[3]);
    if (!itemRows.length) out.zero('items');
    else out.table(['item', 'pockets', 'containers', 'total'], itemRows);

    out.section('census_blueprints');
    const bpRows = [...r.placed].map(([n, b]) => [n, b.placed, b.total, relativeTime(b.at)]);
    if (!bpRows.length) out.zero('blueprints');
    else out.table(['blueprint', 'placed', 'of_total', 'at'], bpRows);

    out.section('census_containers');
    const cRows = [...r.containers]
        .map(([id, c]) => [c.type, id, c.blueprint || 'none', Object.keys(c.items).length, _sum(c.items), relativeTime(c.at)])
        .sort((a, b) => b[4] - a[4]);
    if (!cRows.length) out.zero('containers');
    else out.table(['type', 'at_pos', 'blueprint', 'kinds', 'items', 'read_at'], cRows);

    if (verbose) {
        out.section('census_pockets');
        const pRows = [...r.pockets]
            .map(([id, p]) => [id, Object.keys(p.items).length, _sum(p.items), relativeTime(p.at)])
            .sort((a, b) => b[2] - a[2]);
        if (!pRows.length) out.zero('bots');
        else out.table(['bot', 'kinds', 'items', 'read_at'], pRows);

        // ── EVERY LINE OF EVERY INVENTORY, NOT A SUMMARY OF THEM ──────────────
        // The summary above and `census_by_item` both answer a different question — how much, and of
        // what — and neither can answer what is in one particular body. A per-item total hides a fleet
        // where one body holds 200 cobblestone and nineteen hold none, which reads identically to twenty
        // bodies holding ten each; those are opposite pictures of how the run went and only this table
        // tells them apart. The row count is the fidelity this exists for (Law 25).
        out.section('census_pocket_items');
        const piRows = [...r.pockets]
            .sort((a, b) => _sum(b[1].items) - _sum(a[1].items))
            .flatMap(([id, p]) => Object.entries(p.items)
                .sort((x, y) => y[1] - x[1])
                .map(([item, n]) => [id, item, n]));
        if (!piRows.length) out.zero('pocket_items');
        else out.table(['bot', 'item', 'count'], piRows);

        out.section('census_container_items');
        const ciRows = [...r.containers]
            .sort((a, b) => _sum(b[1].items) - _sum(a[1].items))
            .flatMap(([id, c]) => Object.entries(c.items)
                .sort((x, y) => y[1] - x[1])
                .map(([item, n]) => [c.type, id, item, n]));
        if (!ciRows.length) out.zero('container_items');
        else out.table(['type', 'at_pos', 'item', 'count'], ciRows);
    }
}

module.exports = { reduceCensus, runCensus, COLUMN_TRIP_RE };
