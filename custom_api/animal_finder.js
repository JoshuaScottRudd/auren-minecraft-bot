// api: animal_finder
// purpose: finds an animal of one kind to herd: the nearest one the body senses that stands in no pen of any kind.
//          Where the body senses none, the fleet's one escalation (sector_finder, category `animal:<kind>`): it
//          stands at a book sector recording the kind and looks again there; with no page left it scans the
//          next frontier sector and the seek ends with none (`scanned_sector`), the herd dropped.
//
// Reads the entity list fresh on every look (Invariant B); nothing here remembers where an animal was.
// Returns from seek(): { animal, walks } with the entity, or { animal: null, walks, reason, section }.

const watcher = require('@kernel/watcher');
const finder = require('@api/sector_finder');

const TAG = 'animal_finder';
const SEEK_WALK_LIMIT = 12;   // book sectors one seek may look from before it reports none found

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// Up to the fence's posts (pen_gate.insidePen): a calf pressed to the fence is the pen's, never free.
const inPen = (p, pen) => require('@api/pen_gate').insidePen(pen, p);

// inAnyPen(p, pens): `p` stands in one of `pens` or in any of the crew's pens (pen_gate.inCrewPen). An animal in
// another kind's pen is not free either: fetching it walks a herder into that pen and leads its flock out.
const inAnyPen = (p, pens) => pens.some(pen => inPen(p, pen)) || require('@api/pen_gate').inCrewPen(p);

// An animal standing in a building's or the waste pit's closed ground is one no route may reach (navigator.closedBy),
// for every body alike, so it is not offered.
const SHUT = new Set(['building', 'waste_pit']);
const shutIn = (p) => SHUT.has(require('@locomotion/navigator').closedBy({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }));

// nearestFree: the nearest sensed animal of `kind` standing in none of `pens`, not in `skip` and not in closed
// ground, by the fleet's ring search (@utils/ring_scan) outward from the body. The board asks it the same question
// the herder does.
function nearestFree(bot, kind, pens, skip) {
  return require('@utils/ring_scan').nearestEntity(bot, {
    match: (e) => e.name === kind && e.isValid !== false && !skip.has(e.id) && !inAnyPen(e.position, pens) && !shutIn(e.position),
  });
}

async function seek(bot, kind, { pens = [], skip = [] } = {}) {
  if (typeof kind !== 'string' || !kind) throw new Error(`[${TAG}] CODING VIOLATION: seek needs an animal kind. Got: ${JSON.stringify(kind)}`);
  const skipping = new Set(skip);
  let animal = nearestFree(bot, kind, pens, skipping);
  let walks = 0;
  let section = null;   // the last section walked to, so two searches that found none still say where they went
  while (!animal) {
    if (walks >= SEEK_WALK_LIMIT) {
      watcher.warn(TAG, `ANIMAL_NOT_FOUND kind=${kind} walks=${walks} reason=walk_limit section=${section}`);
      return { animal: null, walks, reason: 'walk_limit', section };
    }
    const step = await finder.escalate(bot, { item: kind, categories: finder.categoriesFor({ animal: kind }) });
    walks++;
    if (!step.moved) {
      const reason = step.reason;
      watcher.warn(TAG, `ANIMAL_NOT_FOUND kind=${kind} walks=${walks} reason=${reason} section=${section}`);
      return { animal: null, walks, reason, section };
    }
    section = step.sector;
    animal = nearestFree(bot, kind, pens, skipping);
  }
  const p = animal.position, me = bot.entity.position;
  watcher.summary(TAG, `ANIMAL_FOUND kind=${kind} id=${animal.id} at=(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}) distance=${Math.round(flat(p, me))} walks=${walks}`);
  return { animal, walks };
}

// THE STRING: stringOf(bot, kind, first, { pens, skip, blocks, max, sliceMs }) → { ids, blocks, hops }. A string tied
// from `first` (the animal seek found, the nearest) to the next free animal nearest the last one tied, and on, each hop
// measured as a walk by the route search the navigator walks with (drop_collector.priceRouteTo, walk only), until the
// next hop is longer than the string has left (`blocks`), `max` animals are tied, or no free animal is reachable from
// the last. The candidates for each hop are the HOP_CANDIDATES nearest by straight line inside what is left; the
// shortest walk among them is tied. `ids` is in tying order: nearest first, the string's far end last. The herder walks
// to the far end and back along it, so the whole string follows it home without any geometry of the pen's own.
const HOP_CANDIDATES = 3;
async function stringOf(bot, kind, first, { pens = [], skip = [], blocks, max, sliceMs }) {
  const { priceRouteTo } = require('@api/drop_collector.js');
  const tied = new Set([first.id, ...skip]);
  const ids = [first.id];
  let last = first, left = blocks, hops = 0;
  const free = e => e.name === kind && e.isValid !== false && e.position && !tied.has(e.id)
    && !inAnyPen(e.position, pens) && !shutIn(e.position);
  while (ids.length < max) {
    const from = last.position;
    const near = Object.values(bot.entities).filter(free)
      .map(e => ({ e, d: flat(e.position, from) }))
      .filter(c => c.d <= left)
      .sort((a, b) => a.d - b.d)
      .slice(0, HOP_CANDIDATES);
    let best = null;
    for (const { e } of near) {
      hops++;
      const priced = await priceRouteTo(bot, e.position, sliceMs, true, false, from);
      if (priced.reachable && priced.steps <= left && (!best || priced.steps < best.steps)) best = { e, steps: priced.steps };
    }
    if (!best) break;
    ids.push(best.e.id);
    tied.add(best.e.id);
    left -= best.steps;
    last = best.e;
  }
  const end = bot.entities[ids[ids.length - 1]]?.position;
  watcher.summary(TAG, `STRING kind=${kind} animals=${ids.length} blocks=${blocks - left} of=${blocks} hops_priced=${hops} ids=${ids.join('/')}`
    + ` end=${end ? `${Math.floor(end.x)},${Math.floor(end.y)},${Math.floor(end.z)}` : '-'}`);
  return { ids, blocks: blocks - left, hops };
}

module.exports = { seek, nearestFree, stringOf };
