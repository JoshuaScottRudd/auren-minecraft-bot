// fragment: survey_book (perception node)
// purpose: The fleet's book of what is available where: one SECTOR page per scanned square, holding where its scan
//          was taken from and, per category, whether it is available. A body's look turns a page to not available
//          when the thing is gone, so nobody else is sent for it.
// invariants:
//  - Rows live in exploration_confrence_room.survey_book: `sector:<gx>,<gz>` → { stand, has, updated_at }. `has` maps a
//    category to true or false and holds only categories ever seen there; one never seen is absent and means not available.
//  - Sectors are the squares of a fixed SECTOR_SCAN.span grid. A sector no body could stand in keeps a page with
//    `stand: null`, so the frontier opens past it and nobody is sent back.
//  - Every write stamps `updated_at`; the foreman relays the book and every merge keeps the fresher row
//    (message_schema.mergeFresherRows).
//  - Each look at a sector is taken from its page's stand, so a later look replaces the whole list.
//  - THE MINE'S YIELD rides in the same book: `yield:<bot>` → { blocks, found, updated_at }, each body's own count of
//    the blocks its tunnel passes dug and the ore blocks those passes uncovered, per ore category (noteDig). Each
//    body writes only its own row, so the fleet's yield is every row's sum (digYield).
//  - So do THE TUNNELS TAGGED FOR THE SPECIALIST: `tag:<line key>` → { unit, ores, by, open, updated_at } (tagLine).
//
// Called by: sector_scan (scans and looks), custom_api/sector_finder (the escalation every finder runs),
// assessors/survey (the home sector's job), foreman_link (relay).

'use strict';

const hq = require('@kernel/corporate_headquarters');
const { SECTOR_SCAN, SURVEY_ORE_ITEM } = require('@thinking/architect_config');

const ROOM = 'exploration_confrence_room';
const CHAIR = 'survey_book';
const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

const cellOf = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

// THE GRID IS THE BASE'S: sector 0,0 is the square centred on the alpha structure's transpose origin (architect_config
// ALPHA_STRUCTURE, the laydown yard or the headframe), and every other sector counts out from it. A body reads the origin
// from its HQ; the foreman, which holds no mandate, passes the alpha's origin it has just sited.
function gridOrigin() {
    const origin = require('@utils/fragment_utils').readTransposeOrigin(require('@kernel/bot_mandate').homeBlueprint());
    if (!origin) throw new Error('[survey_book] CODING VIOLATION (Law 13): a sector was asked for before the alpha structure is sited; the grid is centred on it.');
    return origin;
}
const span = SECTOR_SCAN.span;
// The sector a position lies in, as its key `<gx>,<gz>`.
function sectorOf(pos, origin = gridOrigin()) {
    return `${Math.floor((pos.x - origin.x + span / 2) / span)},${Math.floor((pos.z - origin.z + span / 2) / span)}`;
}
// The centre of a sector's square, {x, z}.
function sectorCentre(sector, origin = gridOrigin()) {
    const [gx, gz] = sector.split(',').map(Number);
    return { x: origin.x + gx * span, z: origin.z + gz * span };
}
// The ore category an underground item comes from ('iron' for raw_iron, iron_ingot, iron_ore), or null.
function oreCategoryOf(item) { const m = SURVEY_ORE_ITEM.exec(item); return m ? m[1] : null; }

function rows() { return hq.readConfRoomFlag(ROOM, CHAIR, {}) || {}; }

function writeRows(changed) {
    hq.writeConfRoomFlag(ROOM, CHAIR, { ...rows(), ...changed });
    const { guardExternalSync } = require('@utils/external_library_guard');
    guardExternalSync('survey_book', 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}

// The new `has` list: every category seen is true; one the page held as true and not seen now is false.
function look(before, seen) {
    const has = {};
    for (const [category, was] of Object.entries(before || {})) has[category] = was && seen.has(category) ? true : false;
    for (const category of seen) has[category] = true;
    return has;
}

// THE PAGE'S COUNT: how many of each category the scan saw (sector_scan's counts), the sector's density of it, as of
// its last look. A look writes the whole count again, so a sector picked over reads thinner the next time.
const countOf = counts => Object.fromEntries([...(counts || new Map())].filter(([, n]) => n > 0));

// recordSector(sector, stand, categories, counts, lavaAt): a scan of `sector` from `stand` (null when no body could stand in it).
// THE PAGE KEEPS WHERE ITS LAVA IS: `lava_at`, the nearest seen. A scan only reads the columns its body has loaded, so a later
// look that does not see it leaves it; only a body at the spot takes it off (closeSurfaceLava).
function recordSector(sector, stand, categories, counts, lavaAt) {
    const page = rows()[`sector:${sector}`];
    const lava_at = lavaAt ? cellOf(lavaAt) : (page && page.lava_at) || null;
    writeRows({ [`sector:${sector}`]: { stand: stand ? cellOf(stand) : null, has: look(page && page.has, new Set(categories)), count: countOf(counts), lava_at, updated_at: Date.now() } });
}

// markOffLimits(sector, why): no scan and no search goes to this sector again: open ocean, or water with no far bank in
// sight. It keeps a page with no stand, as a sector no body could stand in does, so the frontier opens past it.
function markOffLimits(sector, why) {
    const page = rows()[`sector:${sector}`];
    writeRows({ [`sector:${sector}`]: { stand: null, has: look(page && page.has, new Set()), count: {}, lava_at: null, off_limits: why, updated_at: Date.now() } });
}

// pages(sector, stand, categories, counts, lavaAt) -> fresh book rows for a first scan of `sector`, for a writer with no book
// of its own to merge into (the foreman's desk).
function pages(sector, stand, categories, counts, lavaAt) {
    return { [`sector:${sector}`]: { stand: cellOf(stand), has: look({}, new Set(categories)), count: countOf(counts), lava_at: lavaAt ? cellOf(lavaAt) : null, updated_at: Date.now() } };
}

// densest(categories, from) -> the sectors with a stand, each with `seen` (the page's count of every one of
// `categories` together), most seen first and the nearest stand to `from` among equals; a page seeing none is left out.
function densest(categories, from) {
    return Object.entries(rows())
        .filter(([k, r]) => k.startsWith('sector:') && r.stand)
        .map(([k, r]) => ({ sector: k.slice('sector:'.length), ...r, seen: categories.reduce((n, c) => n + ((r.count && r.count[c]) || 0), 0) }))
        .filter(p => p.seen > 0)
        .sort((a, b) => (b.seen - a.seen) || (dist2(a.stand, from) - dist2(b.stand, from)));
}

function sectorPage(sector) { return rows()[`sector:${sector}`] || null; }

// Sectors with a stand where `category` is available, nearest stand to `from` first.
function sectorsWith(category, from) {
    return Object.entries(rows())
        .filter(([k, r]) => k.startsWith('sector:') && r.stand && r.has[category] === true)
        .map(([k, r]) => ({ sector: k.slice('sector:'.length), ...r }))
        .sort((a, b) => dist2(a.stand, from) - dist2(b.stand, from));
}

// ringOf(sector, home): how many rings out from home's sector a sector lies (the larger of its two grid steps).
function ringOf(sector, home) {
    const [sx, sz] = sector.split(',').map(Number);
    const [hx, hz] = sectorOf(home).split(',').map(Number);
    return Math.max(Math.abs(sx - hx), Math.abs(sz - hz));
}

// frontier(home): the sectors a scan may be sent to. The scans go out like SPOKES: the home sector first (the
// foreman's body scans it), then every sector without a page that touches (side or corner) a sector with one, so a
// body that finishes a sector opens the next one out beside it without waiting for a whole ring to close. The
// innermost ring is preferred: the open sectors are ordered by ring, then by nearest centre to `from` (home unless
// a body walking a tour says where it stands, so one walker goes round a ring and does not cross home between sectors).
function frontier(home, from = home) {
    const homeSector = sectorOf(home);
    const book = rows();
    if (!book[`sector:${homeSector}`]) return [homeSector];
    const open = new Set();
    for (const k of Object.keys(book)) {
        if (!k.startsWith('sector:')) continue;
        const [sx, sz] = k.slice('sector:'.length).split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            const n = `${sx + dx},${sz + dz}`;
            if (!book[`sector:${n}`]) open.add(n);
        }
    }
    return [...open].sort((a, b) => ringOf(a, home) - ringOf(b, home) || dist2(sectorCentre(a), from) - dist2(sectorCentre(b), from));
}

// surfaceLava(from) -> the sectors whose page holds where lava stands open to the sky, nearest first: [{ sector, at }].
function surfaceLava(from) {
    return Object.entries(rows())
        .filter(([k, r]) => k.startsWith('sector:') && r.lava_at)
        .map(([k, r]) => ({ sector: k.slice('sector:'.length), at: r.lava_at }))
        .sort((a, b) => dist2(a.at, from) - dist2(b.at, from));
}
// closeSurfaceLava(sector): a body at the spot found no lava it can dip.
function closeSurfaceLava(sector) {
    const page = rows()[`sector:${sector}`];
    if (page) writeRows({ [`sector:${sector}`]: { ...page, lava_at: null, updated_at: Date.now() } });
}

// The crew's portal stands lit: a row, so no body is sent to cast it again.
function notePortalLit() { writeRows({ 'portal:lit': { by: process.env.BOT_ID || 'default', updated_at: Date.now() } }); }
function portalLit() { return !!rows()['portal:lit']; }

// ── THE MINE'S YIELD ─────────────────────────────────────────────────────────────────────────────────────
// noteDig(blocks, found): a tunnel pass of this body dug `blocks` and uncovered the ore blocks in `found`
// ({ category: n }, dug or passed alike: what the ground held).
function noteDig(blocks, found) {
    if (!(blocks > 0)) return;
    const key = `yield:${process.env.BOT_ID || 'default'}`;
    const was = rows()[key] || { blocks: 0, found: {} };
    const sum = { ...was.found };
    for (const [category, n] of Object.entries(found || {})) if (n > 0) sum[category] = (sum[category] || 0) + n;
    writeRows({ [key]: { blocks: was.blocks + blocks, found: sum, updated_at: Date.now() } });
}

// digYield() → { blocks, found: { category: n } }: every body's tunnel passes summed.
function digYield() {
    const out = { blocks: 0, found: {} };
    for (const [k, r] of Object.entries(rows())) {
        if (!k.startsWith('yield:') || !r) continue;
        out.blocks += r.blocks || 0;
        for (const [category, n] of Object.entries(r.found || {})) out.found[category] = (out.found[category] || 0) + n;
    }
    return out;
}

// ── THE LAVA THE TUNNELS TURNED FROM ──────────────────────────────────────────────────────────────────
// noteLava(at): a tunnel stopped for lava here (mining_cell_graph.registerCellAt), so the obsidian job knows a pool. A
// pool is one row: a stop within LAVA_SAME blocks of an open row is that row.
const LAVA_SAME = 12;
function noteLava(at) {
    const known = Object.entries(rows()).some(([k, r]) => k.startsWith('lava:') && r && r.open && Math.hypot(r.at.x - at.x, r.at.y - at.y, r.at.z - at.z) <= LAVA_SAME);
    if (known) return;
    writeRows({ [`lava:${at.x}|${at.y}|${at.z}`]: { at, by: process.env.BOT_ID || 'default', open: true, updated_at: Date.now() } });
}
function closeLava(key, why) {
    const was = rows()[key];
    if (was) writeRows({ [key]: { ...was, open: false, why, closed_by: process.env.BOT_ID || 'default', updated_at: Date.now() } });
}
// openLava(from) → the open pools, nearest first: [{ key, at }].
function openLava(from) {
    return Object.entries(rows()).filter(([k, r]) => k.startsWith('lava:') && r && r.open).map(([key, r]) => ({ key, at: r.at }))
        .sort((a, b) => (from ? dist2(a.at, from) - dist2(b.at, from) : 0));
}

// The foreman's relayed book, merged row by row; the fresher row stands.
function mergeBroadcast(incoming) {
    const book = { ...rows() };
    if (require('@foreman/message_schema').mergeFresherRows(book, incoming)) hq.writeConfRoomFlag(ROOM, CHAIR, book);
}

module.exports = {
    ROOM, CHAIR, sectorOf, sectorCentre, oreCategoryOf, rows, pages, recordSector, markOffLimits,
    sectorPage, sectorsWith, densest, frontier, ringOf, mergeBroadcast, noteDig, digYield, noteLava, closeLava, openLava, surfaceLava, closeSurfaceLava, notePortalLit, portalLit,
    gridOrigin,
};
