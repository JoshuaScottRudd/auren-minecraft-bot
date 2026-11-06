// api: sector_finder
// purpose: THE ONE ESCALATION FOR "I CANNOT FIND THIS". Every finder in the fleet searches where the body stands
//          with its own look; when that look finds none it asks escalate(), which takes the next step of the same
//          ladder for every material, animal and block:
//            1. the book — the nearest sector whose page records the thing (survey_book.sectorsWith): the body walks
//               to that page's stand and the caller looks again from there;
//            2. the decoration locate — a whitelisted decorative dye source (architect_config DECORATION_LOCATE) no
//               page records: the foreman asks the server for the nearest of its biomes (foreman/decoration_locate),
//               the body walks there and scans the sector it arrives in; the caller looks again from there;
//            3. the frontier — anything else no page records: the body claims the next sector to be scanned, walks to
//               it, scans it whole (sector_scan.scanAndRecord: every category, not only the one sought) and reads the
//               book again: a page the scan wrote that records the thing is walked to, and the caller looks again
//               from there. Up to SECTOR_SCAN.finder_scans scans in one claim; past them the finder says that so many
//               scans could not find the thing, and the caller drops the signal.
//
// THE FRONTIER (survey_book.frontier). The foreman's body scans the home sector (sector_scan.deskScan); a sector
// opens once a sector touching it (side or corner) has a page, the innermost ring first. One body scans a sector at a
// time (its `sector:<id>` claim, @utils/target_claims), so round the home sector no more than 8 go at once, and the
// ring grows as each is scanned. The sectors are never limited; SECTOR_SCAN.backstop_rings is a backstop: a thing no
// page records with every sector inside it scanned is said as a loud error, because it most likely is on no scan
// list (architect_config SURVEY_CATEGORIES), not absent from the world.
//
// A MISS AT A BOOK STAND. When the caller asks again from the stand it was sent to, its look found none there: the
// page is looked at again from its stand (sector_scan.overlay), so what is gone turns to not available for every body,
// and the sector is passed by this body for PASS_FOR_MS. A sector whose things were all held by peers (`held`) is
// passed without the look: it is not empty.
//
// Returns from escalate():
//   { moved: 'book', sector }   the body stands at a book sector's stand: the caller looks again
//   { moved: 'locate', sector } the body stands in the located biome's sector: the caller looks again
//   { scanned: sector }         only for a caller that asks for one scan (`oneScan`, the survey): the body scanned a
//                               frontier sector, and the caller drops the signal
//   { none: true, reason }      no_category | night | no_home | frontier_held | backstop | scans_spent: the caller says so
//                               and stops
//
// Nothing here remembers where a thing stands (Invariant B): the book keeps only stands and true/false.

'use strict';

const watcher = require('@kernel/watcher');
const book = require('@perception/survey_book');
const { SECTOR_SCAN, DECORATION_LOCATE, isNightTime } = require('@thinking/architect_config');
const { withCleanup } = require('@utils/external_library_guard');

const TAG = 'sector_finder';
const ARRIVED_WITHIN = 8;     // blocks from a stand or a centre that count as standing at it
const LEG_PROGRESS = 16;      // a leg that brings the body fewer blocks nearer than this ends the walk
const STAND_SEARCH = 8;       // how far around a leg's end the walk looks for dry ground to stand on
const PASS_FOR_MS = 10 * 60 * 1000;   // how long this body passes a book sector its look missed at
const LEG_SIDE_OFFSETS = [0, -16, 16, -32, 32];   // blocks to each side of the bearing a leg's end is also sought
const LEG_SHORTEST = 16;               // the shortest a leg is cut to when its end is not yet loaded
const LEG_CLIMB_WEIGHT = 2;           // a block of rise or fall at a leg's end weighs as this many blocks off the bearing
const OCEAN_SAMPLE = 8;               // blocks between two biome readings along a survey walk's line

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// RINGS. A thing is looked for in the home sector and the rings round it up to the backstop, except those named here:
// wild cane, which plants the first cane field and nothing else (architect_config WILD_CANE), is looked for ring after
// ring with no backstop until it is found; a pen's animal is looked for only within HERDING.reach_rings, and a reach
// spent there is the herd's bound, said quietly (`reach`), never the backstop's error.
const { HERDING } = require('@thinking/architect_config');
const RINGS_FOR = Object.freeze({
  sugar_cane: Infinity,
  ...Object.fromEntries(Object.values(HERDING.pens).map(p => [p.animal, HERDING.reach_rings])),
});
const ringsOf = item => RINGS_FOR[item] ?? SECTOR_SCAN.backstop_rings;

// Where this body's last book walk ended, and for what, so the next ask from there counts as a miss there.
let _stand = null;
// `<categories>@<sector>` → until when this body passes that sector for those categories.
const _passed = new Map();
const passedKey = (key, sector) => `${key}@${sector}`;
const isPassed = (key, sector) => (_passed.get(passedKey(key, sector)) || 0) > Date.now();

// walkToward(bot, to) -> { arrived, reason? }: legs toward (to.x, to.z) of at most SECTOR_SCAN.leg blocks, until within
// ARRIVED_WITHIN; it stops the first time a leg brings it no nearer. A leg ends on dry ground the body can see (a leg
// whose end is not loaded yet is shortened); where
// the leg's end is water, it ends on the far bank seen along the bearing, else on the water itself, and the navigator
// swims it (legStand). goTo owns each leg's own abandonment (Law 15); this adds no retry.
// `survey`: a walk to scan a sector swims nothing it cannot see across. Ocean on the way or at its end, or water with no far
// bank in sight, ends the walk with `off_limits`. A river is crossed to the far bank it can see. The fleet has no boat.
async function walkToward(bot, to, { survey = false } = {}) {
  const locomotion = require('@locomotion/locomotion_dispatcher');
  let left = flat(to, bot.entity.position);
  while (left > ARRIVED_WITHIN) {
    if (survey) {
      const ocean = oceanOn(bot, bot.entity.position, to);
      if (ocean) return { arrived: false, off_limits: `ocean:${ocean}`, reason: `ocean on the way: ${ocean}` };
    }
    // A LEG WHOSE END IS NOT YET LOADED IS SHORTENED (halved, down to LEG_SHORTEST), so a body just arrived in the
    // world, before its view distance has streamed in, walks into the ground it can see.
    let stand = null;
    for (let step = Math.min(SECTOR_SCAN.leg, left); !stand && step >= Math.min(LEG_SHORTEST, left); step = Math.floor(step / 2)) {
      stand = legStand(bot, to, left, step);
    }
    if (!stand) return { arrived: false, reason: 'no dry ground or water to stand on toward it' };
    if (survey && stand.water) return { arrived: false, off_limits: 'water:no_far_bank', reason: 'water with no far bank in sight' };
    const went = await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, purpose: 'survey' });
    const now = flat(to, bot.entity.position);
    if (now > left - LEG_PROGRESS) return { arrived: false, reason: went.arrived ? 'a leg brought it no nearer' : (went.reason || 'leg not reached') };
    left = now;
  }
  return { arrived: true };
}

// legStand(bot, to, left, step) -> the cell a leg of `step` blocks toward `to` ends on, or null where the leg's end is
// not loaded: the flattest dry ground near the leg's end, on the bearing or to a side; else the nearest dry ground past it along the bearing, as
// far as SECTOR_SCAN.radius from the body (a river's far bank); else the water's surface at the leg's end (never lava).
function legStand(bot, to, left, step) {
  const { standNear, surfaceAt } = require('@perception/ground_line');
  const p = bot.entity.position;
  const along = d => ({ x: Math.floor(p.x + (to.x - p.x) / left * d), z: Math.floor(p.z + (to.z - p.z) / left * d) });
  const end = along(step);
  // FLAT GROUND IS PREFERRED: of the dry stands on the bearing and to each side of it (LEG_SIDE_OFFSETS), the leg
  // ends on the one whose height differs least from the body's, each block of rise or fall weighed as
  // LEG_CLIMB_WEIGHT blocks of sideways offset.
  const side = { x: -(to.z - p.z) / left, z: (to.x - p.x) / left };
  let dry = null, best = Infinity;
  for (const off of LEG_SIDE_OFFSETS) {
    const s = standNear(bot, Math.floor(end.x + side.x * off), Math.floor(end.z + side.z * off), STAND_SEARCH);
    if (!s) continue;
    const score = Math.abs(s.y - Math.floor(p.y)) * LEG_CLIMB_WEIGHT + Math.abs(off);
    if (score < best) { best = score; dry = s; }
  }
  if (dry) return dry;
  for (let d = step + STAND_SEARCH; d <= Math.min(left, SECTOR_SCAN.radius); d += STAND_SEARCH) {
    const c = along(d);
    const bank = standNear(bot, c.x, c.z, STAND_SEARCH);
    if (bank) return bank;
  }
  const surface = surfaceAt(bot, end.x, end.z);
  const isWater = surface && bot.blockAt(new (require('vec3').Vec3)(end.x, surface.y - 1, end.z))?.name === 'water';
  return isWater ? { x: end.x, y: surface.y, z: end.z, water: true } : null;
}

// oceanOn(bot, from, to) -> the first ocean biome read on the straight line from `from` to `to`, or null. A column not
// loaded yet reads nothing, and the next leg reads it again.
function oceanOn(bot, from, to) {
  const { getBiomeName } = require('@perception/biome_scanner');
  const len = flat(to, from);
  const y = Math.floor(from.y);
  for (let d = 0; d <= len; d += OCEAN_SAMPLE) {
    const t = len ? d / len : 0;
    const biome = getBiomeName(bot, Math.floor(from.x + (to.x - from.x) * t), y, Math.floor(from.z + (to.z - from.z) * t));
    if (biome && biome.endsWith('ocean')) return biome;
  }
  const end = getBiomeName(bot, Math.floor(to.x), y, Math.floor(to.z));
  return end && end.endsWith('ocean') ? end : null;
}

// scanOne(bot, sector) -> readable: walk to the sector's centre and scan it from as near it as the body can stand. A
// body that cannot stand anywhere in the square writes the page with no stand, so the frontier opens past it; a walk
// stopped at ocean or at water with no far bank in sight marks the sector off limits.
async function scanOne(bot, sector) {
  const walked = await walkToward(bot, book.sectorCentre(sector), { survey: true });
  if (walked.off_limits) {
    book.markOffLimits(sector, walked.off_limits);
    watcher.summary(TAG, `SECTOR_OFF_LIMITS sector=${sector} why=${walked.off_limits}`);
    return `sector ${sector}: off limits (${walked.off_limits})`;
  }
  if (book.sectorOf(bot.entity.position) !== sector) {
    book.recordSector(sector, null, []);
    return `sector ${sector}: no stand inside it (${walked.reason || 'the walk ended outside it'}) — its page has no stand`;
  }
  const scan = await require('@perception/sector_scan').scanAndRecord(bot, sector);
  return `sector ${sector} scanned from (${scan.stand.x},${scan.stand.y},${scan.stand.z}): ${scan.finds.size} categories, lava=${scan.counts.get('lava') || 0}`
    + `${walked.arrived ? '' : ` (stood short of the centre: ${walked.reason})`}`;
}

// tour(bot, rings) -> readable: one body scans the open sectors within `rings` of home one after another without going
// home between them, the innermost ring first and the nearest to where it stands next. A sector a peer holds is left to
// the peer. It ends with no sector left to it, or at the dusk stop between one sector and the next; the board offers
// what is left next morning. A threat or the night takes the body at its next step, as on any walk.
async function tour(bot, rings) {
  const home = require('@thinking/assessors/survey').home();
  const { claimFirst, releaseTarget } = require('@utils/target_claims');
  let scanned = 0;
  for (;;) {
    const dusk = require('@thinking/job_gates').duskStopClaimed();
    if (dusk) return { scanned, ended: `dusk stop (${typeof dusk === 'string' ? dusk : `${dusk.why}: ${dusk.detail}`})` };
    const open = book.frontier(home, bot.entity.position).filter(s => book.ringOf(s, home) <= rings);
    if (!open.length) return { scanned, ended: `every sector within ${rings} ring(s) has a page` };
    const claim = await claimFirst(open, { keyOf: s => `sector:${s}` });
    if (!claim || !claim.pick) return { scanned, ended: 'every open sector is being scanned by a peer' };
    const readable = await withCleanup(TAG, `release the claim on sector ${claim.pick}`, () => scanOne(bot, claim.pick), () => releaseTarget(claim.keys));
    scanned++;
    watcher.summary(TAG, `TOUR_SCAN sector=${claim.pick} ring=${book.ringOf(claim.pick, home)} scanned=${scanned} — ${readable}`);
  }
}

// categoriesFor({ blocks, animal, item }) -> the survey categories (architect_config SURVEY_CATEGORIES) a finder's
// thing is recorded under: each block it is gathered from, `animal:<kind>`, and for a thing that grows only in some
// biomes `biome:<name>` of each: a dye source's (flock_colors.sourceBiomes) and a block's (architect_config
// SOURCE_BIOMES).
function categoriesFor({ blocks = [], animal = null, item = null } = {}) {
  const { categoryOf } = require('@perception/ground_line');
  const { SOURCE_BIOMES } = require('@thinking/architect_config');
  const out = new Set();
  if (animal) out.add(`animal:${animal}`);
  for (const b of blocks) { const c = categoryOf(b); if (c) out.add(c); }
  for (const b of (item ? require('@api/flock_colors').sourceBiomes(item) : null) || []) out.add(`biome:${b}`);
  for (const b of [...blocks, ...(item ? [item] : [])]) for (const biome of SOURCE_BIOMES[b] || []) out.add(`biome:${biome}`);
  return [...out];
}

// The book's pages for any of `categories` within `rings` of home, nearest stand to `from` first, less those this body
// passes.
function bookPages(categories, key, from, rings = SECTOR_SCAN.backstop_rings) {
  const home = require('@thinking/assessors/survey').home();
  const seen = new Map();
  for (const c of categories) for (const p of book.sectorsWith(c, from)) if (!seen.has(p.sector)) seen.set(p.sector, p);
  return [...seen.values()].filter(p => !isPassed(key, p.sector) && (!home || book.ringOf(p.sector, home) <= rings))
    .sort((a, b) => flat(a.stand, from) - flat(b.stand, from));
}

// The frontier sectors within `rings` of home, in survey_book.frontier's order (innermost ring first).
function frontierInside(home, rings = SECTOR_SCAN.backstop_rings) {
  return book.frontier(home).filter(s => book.ringOf(s, home) <= rings);
}

// atStand(bot) -> true while the body stands where its last book walk ended: the caller's look there reaches as far
// as its loaded ground, unbounded by the gather reach round home.
function atStand(bot) {
  return !!(_stand && bot?.entity?.position && flat(bot.entity.position, _stand.at) <= ARRIVED_WITHIN);
}

// THE CLAIM'S SCANS. A claim (the magnet's job and the moment it was claimed) scans at most SECTOR_SCAN.finder_scans
// frontier sectors for one thing, across every escalate it calls. A body with no claim counts within one call.
let _scans = null;   // { claim, key, used }
function scansOf(key) {
  const m = require('@kernel/corporate_headquarters').readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
  const claim = m && m.job_id ? `${m.job_id}@${m.claimed_at || ''}` : null;
  if (!_scans || !claim || _scans.claim !== claim || _scans.key !== key) _scans = { claim, key, used: 0 };
  return _scans;
}

// escalate(bot, { item, categories, held, oneScan }) — called when the caller's look where the body stands found none
// of `item`. `held`: the look saw it, every one held by a peer. `oneScan`: the scan is the caller's errand (the
// survey), so one frontier scan returns { scanned } as it is.
async function escalate(bot, { item, categories, held = false, oneScan = false }) {
  if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: escalate called with no live body.`);
  if (!Array.isArray(categories)) throw new Error(`[${TAG}] CODING VIOLATION: escalate needs the categories of ${item} (categoriesFor). Got: ${JSON.stringify(categories)}`);
  if (!categories.length) {
    watcher.error(TAG, `NO_CATEGORY item=${item} — no survey category records it (architect_config SURVEY_CATEGORIES), so neither the book nor a scan can say where it is; add it there`);
    return { none: true, reason: 'no_category' };
  }
  const key = [...categories].sort().join('|');

  // A MISS AT THE STAND THIS BODY WAS SENT TO: the page is looked at again (unless what was seen was all held) and
  // the sector passed.
  if (_stand && _stand.key === key && atStand(bot)) {
    const { sector } = _stand;
    _stand = null;
    _passed.set(passedKey(key, sector), Date.now() + PASS_FOR_MS);
    if (!held) await require('@perception/sector_scan').overlay(bot, sector, categories[0]);
    watcher.summary(TAG, `FINDER_MISS item=${item} sector=${sector} ${held ? 'held=true' : `page=${JSON.stringify(book.sectorPage(sector)?.has || {})}`}`);
  }

  if (isNightTime() && require('@kernel/bot_mandate').fearsTheNight()) return { none: true, reason: 'night' };

  // 1. THE BOOK.
  const fromBook = await walkToPage(bot, item, categories, key);
  if (fromBook) return fromBook;

  // 2. A DECORATION SOURCE IS LOCATED, never scanned for ring by ring (architect_config DECORATION_LOCATE).
  if (DECORATION_LOCATE[item]) return locateDecoration(bot, item, key);

  // 3. THE FRONTIER: scan, read the book again, and go on, up to the claim's scans.
  if (oneScan) return scanFrontier(bot, item, key);
  const scans = scansOf(key);
  while (scans.used < SECTOR_SCAN.finder_scans) {
    const step = await scanFrontier(bot, item, key);
    if (!step.scanned) return step;
    scans.used++;
    const page = await walkToPage(bot, item, categories, key);
    if (page) return { ...page, scans: scans.used };
  }
  watcher.warn(TAG, `SCANS_SPENT item=${item} — ${SECTOR_SCAN.finder_scans} sector scans could not find ${item}`);
  return { none: true, reason: 'scans_spent' };
}

// walkToPage(bot, item, categories, key) → { moved: 'book', sector } once the body stands at the nearest book page that
// records the thing and this body has not passed, or null when no page is left to walk to.
async function walkToPage(bot, item, categories, key) {
  for (const page of bookPages(categories, key, bot.entity.position, ringsOf(item))) {
    const walked = await walkToward(bot, page.stand);
    if (!walked.arrived) {
      _passed.set(passedKey(key, page.sector), Date.now() + PASS_FOR_MS);
      watcher.summary(TAG, `FINDER_BOOK item=${item} sector=${page.sector} arrived=false reason=${walked.reason}`);
      continue;
    }
    _stand = { sector: page.sector, at: bot.entity.position.clone(), key };
    watcher.summary(TAG, `FINDER_BOOK item=${item} sector=${page.sector} arrived=true stand=(${page.stand.x},${page.stand.y},${page.stand.z})`);
    return { moved: 'book', sector: page.sector };
  }
  return null;
}

// locateDecoration(bot, item, key) — the ladder's step for a whitelisted decorative dye source: the foreman asks the
// server where the nearest of its biomes lies, the body walks there, and the sector it arrives in is scanned into the
// book, so the next ask is answered by the book. → { moved: 'locate', sector } | { none: true, reason }.
async function locateDecoration(bot, item, key) {
  const began = Date.now();
  const from = bot.entity.position.clone();
  const answer = await require('@kernel/foreman_link').askDecorationLocate(item, from);
  if (!answer || !answer.found) {
    const reason = answer ? `locate_${answer.reason}` : 'no_foreman';
    watcher.summary(TAG, `DECORATION_LOCATE item=${item} found=none reason=${reason}`);
    return { none: true, reason };
  }
  const { biome, x, z, distance } = answer.found;
  watcher.summary(TAG, `DECORATION_LOCATE item=${item} found=${biome} at=(${x},${z}) distance=${distance} from=(${Math.floor(from.x)},${Math.floor(from.z)})`);
  const walked = await walkToward(bot, { x, z });
  const p = bot.entity.position;
  watcher.summary(TAG, `DECORATION_WALK item=${item} arrived=${walked.arrived} walked_s=${Math.round((Date.now() - began) / 1000)} `
    + `left=${Math.round(flat({ x, z }, p))} at=(${Math.floor(p.x)},${Math.floor(p.z)})${walked.arrived ? '' : ` reason=${walked.reason}`}`);
  if (!walked.arrived) return { none: true, reason: 'locate_walk_short' };
  const sector = book.sectorOf(p);
  await require('@perception/sector_scan').scanAndRecord(bot, sector);
  _stand = { sector, at: p.clone(), key };
  return { moved: 'locate', sector };
}

// scanFrontier(bot, item, key) — the ladder's second step: the next frontier sector inside the backstop is claimed,
// walked to and scanned whole. → { scanned, readable } | { none: true, reason }.
async function scanFrontier(bot, item, key) {
  const home = require('@thinking/assessors/survey').home();
  if (!home) return { none: true, reason: 'no_home' };
  const rings = ringsOf(item);
  const open = frontierInside(home, rings);
  if (!open.length && rings < SECTOR_SCAN.backstop_rings) {
    watcher.summary(TAG, `FINDER_REACH item=${item} categories=${key} — every sector within ${rings} ring(s) of home is scanned and no page records it`);
    return { none: true, reason: 'reach' };
  }
  if (!open.length) {
    watcher.error(TAG, `BACKSTOP item=${item} categories=${key} — every sector within ${SECTOR_SCAN.backstop_rings} rings of home is scanned and no page records it: it is most likely on no scan list (SURVEY_CATEGORIES), not absent`);
    return { none: true, reason: 'backstop' };
  }
  const { claimFirst, releaseTarget } = require('@utils/target_claims');
  const claim = await claimFirst(open, { keyOf: s => `sector:${s}` });
  if (!claim || !claim.pick) {
    watcher.summary(TAG, `FINDER_FRONTIER item=${item} held=all open=${open.length} — every open sector is being scanned by a peer`);
    return { none: true, reason: 'frontier_held' };
  }
  const readable = await withCleanup(TAG, `release the claim on sector ${claim.pick}`, () => scanOne(bot, claim.pick), () => releaseTarget(claim.keys));
  watcher.summary(TAG, `FINDER_SCAN item=${item} sector=${claim.pick} ring=${book.ringOf(claim.pick, home)} — ${readable}`);
  return { scanned: claim.pick, readable };
}

// densest(bot, { item, categories, min }) — for an errand that wants much of a thing (the composter's run), where it
// is thickest rather than nearest: the book page that saw the most of `categories` together (survey_book.densest),
// once that is `min` or more, the nearest stand among equals. The body walks to that page's stand and the caller
// gathers from there. No page sees `min`: the next frontier sector is scanned, as escalate's second step, so the
// errand reaches thick ground whatever the landing (scan false: the book only). A body already standing at the page
// it is sent to is not walked. A page's count is as of its last look: one picked over reads thinner once a body's
// miss there looks again (escalate's overlay).
// Returns { moved: 'book', sector, seen } | { scanned } | { none: true, reason }.
async function densest(bot, { item, categories, min, scan = true }) {
  if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: densest called with no live body.`);
  if (!Array.isArray(categories) || !categories.length || !(min > 0)) {
    throw new Error(`[${TAG}] CODING VIOLATION: densest needs the categories of ${item} and a least count. Got: ${JSON.stringify({ categories, min })}`);
  }
  const key = `dense:${[...categories].sort().join('|')}`;
  if (isNightTime() && require('@kernel/bot_mandate').fearsTheNight()) return { none: true, reason: 'night' };
  const pages = book.densest(categories, bot.entity.position).filter(p => p.seen >= min && !isPassed(key, p.sector));
  for (const page of pages) {
    const walked = flat(bot.entity.position, page.stand) <= ARRIVED_WITHIN ? { arrived: true } : await walkToward(bot, page.stand);
    if (!walked.arrived) {
      _passed.set(passedKey(key, page.sector), Date.now() + PASS_FOR_MS);
      watcher.summary(TAG, `FINDER_DENSE item=${item} sector=${page.sector} seen=${page.seen} arrived=false reason=${walked.reason}`);
      continue;
    }
    _stand = { sector: page.sector, at: bot.entity.position.clone(), key };
    watcher.summary(TAG, `FINDER_DENSE item=${item} sector=${page.sector} seen=${page.seen} min=${min} arrived=true stand=(${page.stand.x},${page.stand.y},${page.stand.z})`);
    return { moved: 'book', sector: page.sector, seen: page.seen };
  }
  watcher.summary(TAG, `FINDER_DENSE item=${item} none_at_least=${min} pages_seen=${book.densest(categories, bot.entity.position).length}${scan ? ' — scanning the frontier' : ''}`);
  return scan ? scanFrontier(bot, item, key) : { none: true, reason: 'none_dense' };
}

// exhausted(categories, item) -> true when no book page records any of `categories` and no frontier sector inside the
// item's rings (ringsOf; the backstop with no item) is left to scan: the board's question "is there anywhere left to
// look", asked without walking.
function exhausted(categories, item = null) {
  const here = global.bot?.entity?.position || { x: 0, z: 0 };
  const key = [...categories].sort().join('|');
  const rings = ringsOf(item);
  if (bookPages(categories, key, here, rings).length) return false;
  const home = require('@thinking/assessors/survey').home();
  return !!home && frontierInside(home, rings).length === 0;
}

module.exports = { escalate, densest, exhausted, categoriesFor, atStand, walkToward, scanOne, tour };
