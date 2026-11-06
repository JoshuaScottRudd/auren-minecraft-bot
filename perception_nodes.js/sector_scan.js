// fragment: sector_scan (perception)
// purpose: What a body standing in a sector can see from where it stands: the survey categories open to the sky
//          (surface blocks, cliff faces, trees and plants), the biomes and the animals. The book keeps
//          only that each is there and where the body stood; the same scan run again from that stand is the
//          overlay a dispatched body uses to find the thing itself, and a miss turns the book's page.
// invariants:
//  - Open to the sky: a block above its column's ground line (growth), the ground block itself, or a block on a
//    cliff face beside a neighbour column's open air, at most SECTOR_SCAN.face_depth under its own ground line. Nothing under the ground line is seen from the surface (Law 19).
//  - Animals are every living creature the body sees in the square that is not a monster, not a villager or
//    golem, and not standing in the crew's pen: 'animal:<name>', nearest first. Monsters spawn everywhere and say
//    nothing about a sector; penned animals are counted on HQ instead (pen_gate.censusOf).
//  - A scan is one reading of the ground (ground_line).
//  - An overlay reads from the stand the book recorded, not from wherever the dispatched body stopped, so the
//    second look sees the ground the first one did.
//
// Called by: survey_executor (a sector scan, a stone trip's look), the foreman's desk (the home sector).

'use strict';

const watcher = require('@kernel/watcher');
const { SECTOR_SCAN } = require('@thinking/architect_config');
const { withArea, standNear } = require('@perception/ground_line');
const { withCleanup } = require('@utils/external_library_guard');
const book = require('@perception/survey_book');

const TAG = 'sector_scan';
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// Entity types that are creatures; 'passive' also holds villagers and traders, so it counts only as a passive mob.
const ANIMAL_TYPES = new Set(['animal', 'water_creature', 'ambient']);
function isAnimal(e) {
    if (!e || !e.position || !e.name) return false;
    const passiveMob = e.type === 'passive' && String(e.kind || '').toLowerCase() === 'passive mobs';
    return (ANIMAL_TYPES.has(e.type) || passiveMob) && !require('@perception/threat_scanner').isHostile(e);
}

// surfacePass(area, visit): calls visit(category, x, y, z) for every categorised block open to the sky in the
// area: growth above the ground line, the ground block, and cliff faces beside a neighbour column's open air.
// A block under water is never open to the sky: a wet column's line is the water itself.
async function surfacePass(area, visit) {
    for (const g of area.above) visit(g.category, g.x, g.y, g.z);
    const { at, pass, inside, groundAt, ox, oz, W, minY } = area;
    for (let x = ox; x < ox + W; x++) {
        for (let z = oz; z < oz + W; z++) {
            const g = groundAt(x, z);
            if (g < minY) continue;
            const top = at(x, g, z);
            if (top && top.category) visit(top.category, x, g, z);
            let lowest = g;
            for (const [ax, az] of SIDES) {
                if (!inside(x + ax, z + az)) continue;
                const n = groundAt(x + ax, z + az);
                if (n >= minY && n < lowest) lowest = n;
            }
            for (let y = g - 1; y > Math.max(lowest, g - 1 - SECTOR_SCAN.face_depth); y--) {
                const b = at(x, y, z);
                if (!b || !b.category || b.pass) continue;
                const open = SIDES.some(([ax, az]) => inside(x + ax, z + az)
                    && groundAt(x + ax, z + az) < y && pass(x + ax, y, z + az));
                if (open) visit(b.category, x, y, z);
            }
        }
        await area.pace();
    }
}

// openAt(lines, x, y, z) -> is this categorised block open to the sky, by surfacePass's rule one cell at a time:
// growth above the ground line, the ground block, or a cliff face beside a neighbour column's open air.
function openAt(lines, x, y, z) {
    const g = lines.groundAt(x, z);
    if (g < lines.minY) return false;
    if (y >= g) return true;
    let lowest = g;
    for (const [ax, az] of SIDES) {
        const n = lines.groundAt(x + ax, z + az);
        if (n >= lines.minY && n < lowest) lowest = n;
    }
    if (y <= Math.max(lowest, g - 1 - SECTOR_SCAN.face_depth)) return false;
    return SIDES.some(([ax, az]) => lines.groundAt(x + ax, z + az) < y && lines.pass(x + ax, y, z + az));
}

// exposedAround(bot, centre, radius, category, limit) -> up to `limit` blocks of `category` open to the sky
// within `radius` of `centre`, nearest first: the body's own look for something it will dig. Read by the fleet's
// ring search (@utils/ring_scan), so it ends on the ring that brings it to `limit`.
const EXPOSED_BAND = 48;
async function exposedAround(bot, centre, radius, category, limit) {
    const c = { x: Math.floor(centre.x), y: Math.floor(centre.y), z: Math.floor(centre.z) };
    const { categoryOf, lines: groundLines } = require('@perception/ground_line');
    const ringScan = require('@utils/ring_scan');
    const names = ringScan.namesMatching(bot, { test: (n) => categoryOf(n) === category });
    const lines = groundLines(bot);
    return withCleanup(TAG, `look for ${category} around (${c.x},${c.z})`, async () => {
        const { found } = await ringScan.nearestBlocks(bot, {
            names, center: c, reach: radius,
            band: { low: c.y - EXPOSED_BAND, high: c.y + EXPOSED_BAND },
            accept: (r, p) => openAt(lines, p.x, p.y, p.z),
            source: 'sector_scan.exposed',
        }, limit);
        return found.map(o => ({ x: o.position.x, y: o.position.y, z: o.position.z }));
    }, () => lines.dispose());
}

// scanSector(bot, stand, opts) -> { stand, finds: Map(category -> nearest position), counts: Map(category -> blocks
// or animals seen) }. The counts are a sector's density of each thing: an errand that wants much of it (the
// composter's run, sector_finder.densest) goes where most was seen.
// opts.combatGate false for the foreman's desk body; opts.desk true there too: the desk scans home at siting, before any
// pen stands, and its process holds no crew mandate to find one by.
async function scanSector(bot, stand, opts = {}) {
    const at0 = { x: Math.floor(stand.x), y: Math.floor(stand.y), z: Math.floor(stand.z) };
    const finds = new Map();
    const counts = new Map();
    // Cane standing on a footprint is a cane field's to cut, and a gatherer passes it by (harvest_executor keepout), so it is
    // no wild cane on the sector's page: a page that counted it would send gatherers to cane none of them may cut.
    const { harvestKeepoutBoxes, isInsideBlueprintKeepout } = require('@utils/fragment_utils');
    const fieldBoxes = opts.foreman ? [] : harvestKeepoutBoxes(0);
    // Natural ground within the gather keep-out of the base is ground no gatherer may take (gatherBanned), so it is
    // not on the page either; an ore category is ground by its ore block.
    const { gatherBanned, isNaturalGround } = require('@utils/fragment_utils');
    const groundBanned = opts.foreman ? () => false : gatherBanned();
    const ground = (category) => isNaturalGround(category) || isNaturalGround(`${category}_ore`);
    const note = (category, x, y, z) => {
        if (category === 'sugar_cane' && isInsideBlueprintKeepout({ x, z }, fieldBoxes)) return;
        if (ground(category) && groundBanned({ x, z })) return;
        counts.set(category, (counts.get(category) || 0) + 1);
        const d2 = (x - at0.x) ** 2 + (y - at0.y) ** 2 + (z - at0.z) ** 2;
        const cur = finds.get(category);
        if (!cur || d2 < cur.d2) finds.set(category, { x, y, z, d2 });
    };
    return withArea(bot, at0, SECTOR_SCAN.radius, async (area) => {
        await surfacePass(area, note);

        // An animal in the crew's pen is the pen's, not the sector's: its count is on HQ (pen_gate.censusOf).
        const inCrewPen = opts.foreman ? () => false : require('@api/pen_gate').inCrewPen;
        for (const e of Object.values(bot.entities || {})) {
            if (!isAnimal(e) || !area.inside(Math.floor(e.position.x), Math.floor(e.position.z)) || inCrewPen(e.position)) continue;
            note(`animal:${e.name}`, Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z));
        }

        const biomeScanner = require('@perception/biome_scanner');
        biomeScanner.scanBiomes(bot);
        for (const p of biomeScanner.getState()?.patches || []) {
            const k = `biome:${p.biome}`;
            if (!finds.has(k)) finds.set(k, { x: p.seed.x, y: p.seed.y, z: p.seed.z, d2: p.dist * p.dist });
        }

        return { stand: at0, finds, counts };
    }, { combatGate: opts.combatGate });
}

// scanAndRecord(bot, sector) -> the scan of `sector` from where the body stands, written into the book.
async function scanAndRecord(bot, sector) {
    const scan = await scanSector(bot, bot.entity.position);
    book.recordSector(sector, scan.stand, [...scan.finds.keys()], scan.counts, scan.finds.get('lava'));
    watcher.summary(TAG, `SECTOR_SCAN sector=${sector} stand=${scan.stand.x},${scan.stand.y},${scan.stand.z} categories=${scan.finds.size}`);
    return scan;
}

// overlay(bot, sector, category) -> nearest position of `category` seen from the sector's recorded stand, or
// null. The look is written back, so what is no longer seen from that stand turns to not available.
async function overlay(bot, sector, category) {
    const page = book.sectorPage(sector);
    if (!page || !page.stand) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): overlay of sector ${sector}, which has no stand to look from.`);
    const scan = await scanSector(bot, page.stand);
    book.recordSector(sector, page.stand, [...scan.finds.keys()], scan.counts, scan.finds.get('lava'));
    const hit = scan.finds.get(category);
    return hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
}

// foremanScan(bot, home) -> the home sector's pages, or null when no dry ground in the home sector is loaded for this
// body. The foreman's desk runs it on its own body after siting, so the crew arrives to a book with its home page.
async function foremanScan(bot, home) {
    const sector = book.sectorOf(home, home);
    const centre = book.sectorCentre(sector, home);
    const stand = standNear(bot, Math.floor(centre.x), Math.floor(centre.z), SECTOR_SCAN.span / 2);
    if (!stand || book.sectorOf(stand, home) !== sector) return null;
    const scan = await scanSector(bot, stand, { combatGate: false, foreman: true });
    const categories = [...scan.finds.keys()];
    return { sector, stand, categories: categories.length, pages: book.pages(sector, stand, categories, scan.counts, scan.finds.get('lava')) };
}

module.exports = { scanSector, scanAndRecord, overlay, exposedAround, foremanScan };
