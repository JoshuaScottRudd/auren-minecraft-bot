// Auren_Bot/monitoring/finder_lens.js
// --finder: what the fleet could not find where it stood, and what it did about it — every step of the one escalation
// (custom_api/sector_finder: a book sector walked to, a miss there, a frontier sector scanned, every frontier sector
// held, and the two loud errors, a thing on no scan list and the 4-ring backstop), every decoration locate and the
// walk to it (its time and how far short it ended), every sector scan written to the
// book (sector_scan), and every ink trip (custom_api/squid_hunt: the look, the entry into the water, each dive, the
// end). Inputs as ARGUMENTS, render, RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --finder [--bot=B] [--all]

'use strict';

const out = require('./data_out');

// sector_finder, one per step.
const BOOK_RE = /FINDER_BOOK item=(\S+) sector=(\S+) arrived=(\w+)/;
const MISS_RE = /FINDER_MISS item=(\S+) sector=(\S+)/;
const HELD_RE = /FINDER_FRONTIER item=(\S+) held=all open=(\d+)/;
const SCAN_RE = /FINDER_SCAN item=(\S+) sector=(\S+) ring=(\d+)/;
const NO_CAT_RE = /NO_CATEGORY item=(\S+)/;
const BACKSTOP_RE = /BACKSTOP item=(\S+) categories=(\S+)/;
// sector_finder's decoration locate and the walk test module's (action_fragments.js/test_module): the server's
// answer, then the walk to it.
const LOCATE_RE = /(?:DECORATION|TEST)_LOCATE item=(\S+) found=(\S+)(?: at=(\S+) distance=(\d+) from=(\S+))?(?: reason=(\S+))?/;
const WALK_RE = /(?:DECORATION|TEST)_WALK item=(\S+) arrived=(\w+) walked_s=(\d+) left=(\d+) at=(\S+)(?: reason=(.*))?/;
// sector_scan, one per page written.
const PAGE_RE = /SECTOR_SCAN sector=(\S+) stand=(\S+) categories=(\d+)/;
// squid_hunt, one per step of a trip.
const INK_START_RE = /INK_TRIP_START want=(\d+) have=(\d+) squid=(\S+) dist=(\S+)/;
const INK_LOOK_RE = /INK_LOOK found=(\w+) via=(\S+)/;
const INK_ENTRY_RE = /INK_ENTRY squid=(\S+) squid_at=(\S+) entry=(\S+) reached=(\w+) reason=(\S+)/;
const INK_DIVE_RE = /INK_DIVE n=(\d+) squid=(\S+) reason=(\S+) gained=(\d+) swings=(\d+) surfaced=(\S+) oxygen=(\S+) mode=(\S+)/;
const INK_END_RE = /INK_TRIP_END got=(\d+) want=(\d+) dives=(\d+) ended=(\S+) reasons=(\S+)/;
const ROWS = 40;

const mmss = (sec) => `${Math.floor(sec / 60)}m${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

function reduceFinder({ seg = [], bot: botFilter = null } = {}) {
  const steps = [], errors = [], pages = [], ink = [], locates = [];
  // A line forwarded through the judge repeats its executor's line; one per bot and exact text.
  const seen = new Set();
  for (const l of seg) {
    if (botFilter && l.bot !== botFilter) continue;
    const k = `${l.bot}|${l.relSec}|${l.raw}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const t = l.relSec, bot = l.bot;
    let m;
    if ((m = BOOK_RE.exec(l.raw))) { steps.push({ t, bot, step: m[3] === 'true' ? 'book' : 'book_short', item: m[1], sector: m[2] }); continue; }
    if ((m = MISS_RE.exec(l.raw))) { steps.push({ t, bot, step: 'miss', item: m[1], sector: m[2] }); continue; }
    if ((m = HELD_RE.exec(l.raw))) { steps.push({ t, bot, step: 'frontier_held', item: m[1], sector: `open:${m[2]}` }); continue; }
    if ((m = SCAN_RE.exec(l.raw))) { steps.push({ t, bot, step: 'scan', item: m[1], sector: m[2], ring: +m[3] }); continue; }
    if ((m = NO_CAT_RE.exec(l.raw))) { errors.push({ t, bot, error: 'NO_CATEGORY', item: m[1], detail: null }); continue; }
    if ((m = BACKSTOP_RE.exec(l.raw))) { errors.push({ t, bot, error: 'BACKSTOP', item: m[1], detail: m[2] }); continue; }
    if ((m = LOCATE_RE.exec(l.raw))) { locates.push({ t, bot, step: 'locate', item: m[1], found: m[2], at: m[3] || null, distance: m[4] ? +m[4] : null, from: m[5] || null, reason: m[6] || null }); continue; }
    if ((m = WALK_RE.exec(l.raw))) { locates.push({ t, bot, step: 'walk', item: m[1], arrived: m[2] === 'true', walked_s: +m[3], left: +m[4], at: m[5], reason: m[6] || null }); continue; }
    if ((m = PAGE_RE.exec(l.raw))) { pages.push({ t, bot, sector: m[1], stand: m[2], categories: +m[3] }); continue; }
    if ((m = INK_START_RE.exec(l.raw))) { ink.push({ t, bot, step: 'start', want: +m[1], have: +m[2], squid: m[3], dist: m[4] }); continue; }
    if ((m = INK_LOOK_RE.exec(l.raw))) { ink.push({ t, bot, step: 'look', found: m[1], via: m[2] }); continue; }
    if ((m = INK_ENTRY_RE.exec(l.raw))) { ink.push({ t, bot, step: 'entry', squid: m[1], squid_at: m[2], entry: m[3], reached: m[4], reason: m[5] }); continue; }
    if ((m = INK_DIVE_RE.exec(l.raw))) { ink.push({ t, bot, step: 'dive', n: +m[1], squid: m[2], reason: m[3], gained: +m[4], swings: +m[5], surfaced: m[6], oxygen: m[7], mode: m[8] }); continue; }
    if ((m = INK_END_RE.exec(l.raw))) { ink.push({ t, bot, step: 'end', got: +m[1], want: +m[2], dives: +m[3], ended: m[4], reasons: m[5] }); continue; }
  }
  for (const xs of [steps, errors, pages, ink, locates]) xs.sort((a, b) => a.t - b.t);
  return { steps, errors, pages, ink, locates };
}

function runFinder({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const { steps, errors, pages, ink, locates } = reduceFinder({ seg, bot: botFilter });
  const cut = (xs) => (verbose ? xs : xs.slice(0, ROWS));
  out.kv('lens', 'finder');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);

  out.section('finder_by_item');
  const items = new Map();
  for (const s of steps) {
    const r = items.get(s.item) || { book: 0, book_short: 0, miss: 0, scan: 0, frontier_held: 0 };
    r[s.step]++;
    items.set(s.item, r);
  }
  out.table(['item', 'book_walks', 'book_short', 'misses', 'frontier_scans', 'frontier_held'],
    [...items].sort((a, b) => a[0].localeCompare(b[0])).map(([item, r]) => [item, r.book, r.book_short, r.miss, r.scan, r.frontier_held]));

  out.section('finder_errors');
  out.kv('errors', errors.length);
  out.table(['at', 'bot', 'error', 'item', 'categories'], errors.map(e => [mmss(e.t), e.bot, e.error, e.item, e.detail]));

  out.section('finder_steps');
  out.kv('steps', steps.length);
  out.table(['at', 'bot', 'step', 'item', 'sector', 'ring'], cut(steps).map(s => [mmss(s.t), s.bot, s.step, s.item, s.sector, s.ring ?? null]));
  if (!verbose && steps.length > ROWS) out.kv('rows_cut', steps.length - ROWS);

  out.section('decoration_locates');
  const asked = locates.filter(x => x.step === 'locate');
  out.kv('locates', asked.length);
  out.table(['at', 'bot', 'item', 'found', 'at_xz', 'distance', 'from', 'reason'],
    asked.map(x => [mmss(x.t), x.bot, x.item, x.found, x.at, x.distance, x.from, x.reason]));
  out.section('decoration_walks');
  out.table(['at', 'bot', 'item', 'arrived', 'walked', 'left', 'at_xz', 'reason'], locates.filter(x => x.step === 'walk')
    .map(x => [mmss(x.t), x.bot, x.item, x.arrived, mmss(x.walked_s), x.left, x.at, x.reason]));

  out.section('book_pages');
  out.kv('pages_written', pages.length);
  out.kv('sectors', new Set(pages.map(p => p.sector)).size);
  out.table(['at', 'bot', 'sector', 'stand', 'categories'], cut(pages).map(p => [mmss(p.t), p.bot, p.sector, p.stand, p.categories]));

  out.section('ink_trips');
  const ends = ink.filter(i => i.step === 'end');
  out.kv('trips', ends.length);
  out.kv('ink_got', sum(ends.map(e => e.got)));
  out.kv('dives', sum(ends.map(e => e.dives)));
  const endedBy = new Map();
  for (const e of ends) endedBy.set(e.ended, (endedBy.get(e.ended) || 0) + 1);
  out.table(['ended', 'trips'], [...endedBy].sort((a, b) => b[1] - a[1]));
  const of = (step) => cut(ink.filter(i => i.step === step));
  out.section('ink_trip_ends');
  out.table(['at', 'bot', 'got', 'want', 'dives', 'ended', 'reasons'], of('end').map(i => [mmss(i.t), i.bot, i.got, i.want, i.dives, i.ended, i.reasons]));
  out.section('ink_trip_starts');
  out.table(['at', 'bot', 'want', 'have', 'squid', 'dist'], of('start').map(i => [mmss(i.t), i.bot, i.want, i.have, i.squid, i.dist]));
  out.section('ink_looks');
  out.table(['at', 'bot', 'found', 'via'], of('look').map(i => [mmss(i.t), i.bot, i.found, i.via]));
  out.section('ink_entries');
  out.table(['at', 'bot', 'squid', 'squid_at', 'entry', 'reached', 'reason'], of('entry').map(i => [mmss(i.t), i.bot, i.squid, i.squid_at, i.entry, i.reached, i.reason]));
  out.section('ink_dives');
  out.table(['at', 'bot', 'n', 'squid', 'reason', 'gained', 'swings', 'surfaced', 'oxygen', 'mode'], of('dive').map(i => [mmss(i.t), i.bot, i.n, i.squid, i.reason, i.gained, i.swings, i.surfaced, i.oxygen, i.mode]));
}

module.exports = { reduceFinder, runFinder };
