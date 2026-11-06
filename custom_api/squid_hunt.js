// api: squid_hunt
// purpose: one ink trip: find a squid, get into the surface water over it, and dive for its ink sacs until the order
//          is met, the dives run out, or there is no squid left to reach. One verb: bring back ink (Law 0).
//          Each dive is ink_diver.collectInk (one borrowed breath, underwater_swimming owns the return to air).
//
// THE LOOK. The nearest squid the body senses (@utils/ring_scan). None sensed: the fleet's one escalation
// (sector_finder, categories `animal:squid` and the waters squid live in, DYES black's biomes): the body stands at a
// book sector recording them and looks again; with no page left it scans the next frontier sector and the trip ends
// there (`scanned_sector`), the order back on the board.
//
// THE ENTRY. Water is entered at sea level only, open to the sky (land_prep's rule for water: a source whose top is the
// sea's surface, air over it, and the column's ground line the water itself), nearest the squid (ENTRY_REACH). An
// aquifer pool at any height lies under its column's ground, reached down a shaft no swim leaves; it is never an entry.
// The body walks there (locomotion swims a water edge) and treads water (navigator.treadWater), at most
// BREATH_WAIT_MS, until its breath is full and survival holds no notice.
//
// THE DIVES. At most MAX_DIVES. A dive the swimming owner refuses for breath or control is waited out and tried again;
// a dive that could not surface ends the trip (the body is survival's). Between dives the squid is looked for again,
// and a squid farther than ENTRY_REACH from where the body floats is walked to as a new entry.
//
// THE RECORD. Every step says itself on one line, stage `squid_hunt`, so a run's ink can be read whole:
//   INK_TRIP_START want= have= squid= dist=
//   INK_LOOK       found= via=here|book:<sector>|scanned:<sector>|<reason>
//   INK_ENTRY      squid= entry=(x,y,z) reached= reason=
//   INK_DIVE       n= squid= reason= gained= swings= surfaced= oxygen= mode=
//   INK_ASHORE     ok= reason= stand=(x,y,z) ms=
//   INK_TRIP_END   got= want= dives= ended= reasons=
// Ink counts only from the pocket (Law 25): a squid gone is never ink brought.
// EVERY TRIP ENDS ON DRY GROUND (ashore): the next job starts from land, not afloat. The swim is water_escape.ashore.

'use strict';

const watcher = require('@kernel/watcher');
const finder = require('@api/sector_finder');
const { sleep } = require('@utils/fragment_utils');

const TAG = 'squid_hunt';
const KIND = 'squid';
const MAX_DIVES = 6;
const DIVE_MS = 12000;          // the swimming owner's own ceiling for one breath
const ENTRY_REACH = 12;         // how far from the squid a surface cell may be to dive for it
const BREATH_WAIT_MS = 12000;   // how long the body waits at the entry for survival to hand it full air
const FINDER_LOOKS = 6;         // book sectors one trip looks from before it ends
const REFUSALS = new Set(['breath_not_replenished', 'survival_has_control', 'body_not_in_water']);

const ink = bot => bot.inventory.items().filter(i => i.name === 'ink_sac').reduce((n, i) => n + i.count, 0);
const at = p => `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`;
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// A squid the swim planner refused as a target (target_not_swimmable: it sits where no swim cell reaches) is passed
// over for the rest of the trip, so one squid at the surface lip cannot spend every dive. A squid with no way in (no
// open surface water within ENTRY_REACH, or no route to it) is passed for PASS_MS across trips: the next trip would
// pick the same nearest squid and fail the same way.
const PASS_MS = 600000;
const ENTRY_FAILS = 3;          // squids a trip may find no way in to before it ends
const _passed = new Map();
const passed = (e) => (_passed.get(e.id) || 0) > Date.now();
const nearestSquid = (bot, skip = new Set()) => require('@utils/ring_scan').nearestEntity(bot, { match: e => e.name === KIND && e.isValid !== false && !!e.position && !skip.has(e.id) && !passed(e) });

// The sea-level source water open to the sky nearest the squid, within ENTRY_REACH of it: where a body floats to dive.
async function entryNear(bot, squid) {
  const c = squid.position.floored();
  const surface = require('@thinking/architect_config').SEA_LEVEL - 1;
  const lines = require('@perception/ground_line').lines(bot);
  const { found } = await require('@utils/external_library_guard').withCleanup(TAG, 'look for an open-water entry', () =>
    require('@utils/ring_scan').nearestBlocks(bot, {
      names: ['water'], center: c, reach: ENTRY_REACH, band: { low: surface, high: surface },
      accept: (r, p) => r.isWaterSource(p.x, p.y, p.z) && r.blockAt(p.x, p.y + 1, p.z)?.name === 'air' && lines.groundAt(p.x, p.z) <= p.y,
      source: 'squid_hunt.entry',
    }, 1), () => lines.dispose());
  return found.length ? found[0].position : null;
}


// look(bot) → { squid, via } — the squid where the body stands, else through the finder; `squid` null with `via`
// naming why the trip cannot go on.
async function look(bot, categories, skip) {
  for (let looks = 0; looks <= FINDER_LOOKS; looks++) {
    const squid = nearestSquid(bot, skip);
    if (squid) return { squid, via: looks ? 'book' : 'here' };
    if (looks === FINDER_LOOKS) return { squid: null, via: 'look_limit' };
    const step = await finder.escalate(bot, { item: 'ink_sac', categories });
    if (!step.moved) return { squid: null, via: step.reason };
  }
  return { squid: null, via: 'look_limit' };
}

// enter(bot, squid) → { ok, entry, reason }: the body floats in the surface water over the squid with full air.
async function enter(bot, squid) {
  const swimming = require('@locomotion/underwater_swimming');
  const entry = await entryNear(bot, squid);
  if (!entry) return { ok: false, entry: null, reason: 'no_surface_water_near_squid' };
  const nav = await require('@locomotion/locomotion_dispatcher').goTo({ x: entry.x, y: entry.y, z: entry.z, leg: 'work' });
  if (!nav || nav.arrived === false) return { ok: false, entry, reason: `route_to_water_failed${nav?.reason ? `:${nav.reason}` : ''}` };
  const end = Date.now() + BREATH_WAIT_MS;
  const ready = () => { const s = swimming.status(bot); return s.mode === 'floating' && !s.pending && s.oxygen >= 20; };
  while (Date.now() < end) {
    if (await require('@locomotion/navigator').treadWater(bot, { until: ready, ms: end - Date.now() })) return { ok: true, entry, reason: 'floating' };
    const s = swimming.status(bot);
    if (s.mode === 'blocked') return { ok: false, entry, reason: `survival_blocked:${s.reason}` };
    await sleep(250);   // the breath override holds the body; it hands it back at full breath
  }
  return { ok: false, entry, reason: `breath_wait_${BREATH_WAIT_MS}ms:${swimming.status(bot).mode}` };
}

// huntInk(bot, want) → { got, dives, ended, reasons }.
async function huntInk(bot, want) {
  if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: huntInk called with no live body.`);
  if (!Number.isInteger(want) || want <= 0) throw new Error(`[${TAG}] CODING VIOLATION: huntInk needs a positive whole number of ink sacs. Got: ${JSON.stringify(want)}`);
  const swimming = require('@locomotion/underwater_swimming');
  const { collectInk } = require('@api/ink_diver');
  const categories = finder.categoriesFor({ animal: KIND, item: 'ink_sac' });
  const before = ink(bot);
  const got = () => ink(bot) - before;
  const reasons = [];
  const skip = new Set();
  let dives = 0, ended = null, entry = null, entryFails = 0;

  let found = await look(bot, categories, skip);
  watcher.summary(TAG, `INK_TRIP_START want=${want} have=${before} squid=${found.squid ? found.squid.id : '-'} dist=${found.squid ? Math.round(flat(found.squid.position, bot.entity.position)) : '-'}`);
  watcher.summary(TAG, `INK_LOOK found=${!!found.squid} via=${found.via}`);
  // The whole trip is one span, placed where the body stands as it sets out (activity_log).
  const activity = require('@api/activity_log');
  activity.start('squid_hunt', { at: bot.entity.position });

  while (!ended) {
    if (got() >= want) { ended = 'want_met'; break; }
    if (dives >= MAX_DIVES) { ended = 'dive_limit'; break; }
    if (!found.squid) { ended = `no_squid:${found.via}`; break; }
    const squid = found.squid;
    if (!entry || flat(squid.position, bot.entity.position) > ENTRY_REACH || swimming.status(bot).mode !== 'floating') {
      const went = await enter(bot, squid);
      entry = went.entry;
      watcher.summary(TAG, `INK_ENTRY squid=${squid.id} squid_at=${at(squid.position)} entry=${entry ? at(entry) : '-'} reached=${went.ok} reason=${went.reason}`);
      if (!went.ok) {
        reasons.push(went.reason);
        const noWayIn = went.reason === 'no_surface_water_near_squid' || went.reason.startsWith('route_to_water_failed');
        if (!noWayIn || ++entryFails >= ENTRY_FAILS) { ended = `entry_failed:${went.reason}`; break; }
        _passed.set(squid.id, Date.now() + PASS_MS);
        entry = null;
        found = await look(bot, categories, skip);
        watcher.summary(TAG, `INK_LOOK found=${!!found.squid} via=${found.via} after=${went.reason}`);
        continue;
      }
    }
    const r = await collectInk(bot, { durationMs: DIVE_MS });
    dives++;
    reasons.push(r.reason);
    const s = swimming.status(bot);
    watcher.summary(TAG, `INK_DIVE n=${dives} squid=${squid.id} reason=${r.reason} gained=${r.gained ?? 0} swings=${r.swings ?? 0} surfaced=${r.surfaced ?? '-'} oxygen=${s.oxygen ?? '?'} mode=${s.mode}`);
    if (s.mode === 'blocked' || (r.surfaced === false && !REFUSALS.has(r.reason))) { ended = `surface_failed:${s.reason || r.reason}`; break; }
    if (REFUSALS.has(r.reason)) await require('@locomotion/navigator').treadWater(bot, { until: () => false, ms: 1000 });
    if (r.reason === 'target_not_swimmable') { skip.add(squid.id); entry = null; }
    found = { squid: nearestSquid(bot, skip), via: 'here' };
    if (!found.squid) {
      found = await look(bot, categories, skip);
      watcher.summary(TAG, `INK_LOOK found=${!!found.squid} via=${found.via}`);
      entry = null;
    }
  }
  if (swimming.status(bot).mode !== 'blocked') {
    const t0 = Date.now();
    const out = await swimming.ashore(bot);
    watcher.summary(TAG, `INK_ASHORE ok=${out.ok} reason=${out.reason} stand=${out.stand ? at(out.stand) : '-'} ms=${Date.now() - t0}`);
  }
  watcher.summary(TAG, `INK_TRIP_END got=${got()} want=${want} dives=${dives} ended=${ended} reasons=${reasons.join(',') || '-'}`);
  activity.end('squid_hunt', { why: String(ended).split(':')[0] });
  return { got: got(), dives, ended, reasons };
}

module.exports = { huntInk, MAX_DIVES };
