// seed_picker — pick wheat_seeds by punching surface grass. Law 15 sub-loop API, sibling to
// tree_feller / drop_collector; harvest_executor calls pick(bot, {quantity}) directly (no
// signal-bus entry point).
//
// Its own verb (Law 0): distinct from felling a tree and from the generic block-punch path.
// Grass is a one-hit break with a probabilistic drop (~1/8 wheat_seeds per short_grass in
// 1.21.5), so the loop is punch-many / collect-batch / recount — a different shape than "dig N of
// a block". Seeds are a farm input the idle bot gathers while its peer mines the shaft down.
//
// TOOL (subtle, load-bearing): grass must be broken with hand or any tool except shears, which
// makes grass drop the grass block itself instead of seeds — guarded by ensureBareHands. A held
// pickaxe/shovel is fine; the drop is unchanged.
//
// FAILURE (Law 15 caller abandonment): movement is goTo's domain — a goTo that gives up
// resolves arrived:false and pick() returns {success:false}; harvest_executor routes the
// soft-fail to recursive_judge (Law 13 environmental). pick() adds no movement retry of its own.
// "No grass in range" and "grass unreachable" are likewise environmental soft-fails, not throws.
//
// Returns: { success, collected, total, reason } — total is the post-pick inventory count (strictly
// rises across successful picks) so harvest_executor's readable stays unique and the judge's
// identical-outcome kill never false-fires on back-to-back picks.
//
// Success means the errand ran, not that the order filled (see MAX_GRASS_PUNCHES): spending the
// punch budget is the deliverable, so a trip that punched its fifteen and drew no seeds returns
// success and goes and dumps. `reason` classifies only a trip that could not punch: 'no_grass' |
// 'unreachable' | 'short', null on success. harvest_executor sends the futile case to idle
// instead of re-dispatching an identical gather that the judge would false-kill as a loop.

const watcher = require('@kernel/watcher');
const Vec3 = require('vec3');
// Entered through combatCheckpoint — the one process-wide 500 ms clock, shared with the dig and
// drive primitives, with an engaging/escaping bypass so combat's own arms cannot re-enter it (its
// own header holds the full contract).
const { combatCheckpoint } = require('@api/battle_stations');
const { collectNearby } = require('@api/drop_collector.js');
const { performDig } = require('@utils/movement/dig_authority');
const exploration = require('@api/exploration_api');
const { guardExternal } = require('@utils/external_library_guard');
const { claimFirst, releaseTarget } = require('@utils/target_claims');

const TAG = 'seed_picker';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const GRASS = ['short_grass', 'tall_grass', 'fern'];
const GRASS_SET = new Set(GRASS);
const REACH = 4.5;                 // melee break reach, from the eyes
const MELEE_SCAN_RADIUS = 4;       // cube half-extent for the in-reach grass scan
// The punch cap is flat and the order size does not touch it: exactly 15 grass punches regardless
// of how many seeds land, keeping one dispatch a small bounded errand instead of an open-ended
// search. Seeds are a farm input with a probabilistic drop, so "gather N" is a goal the world may
// simply decline to grant on this trip. At ~1/8 the cap yields ~2 seeds a trip — many small
// bounded trips beat one unbounded one.
const MAX_GRASS_PUNCHES = 15;

function countSeeds(bot) {
  return (bot.inventory?.items?.() || [])
    .filter(i => i && i.name === 'wheat_seeds')
    .reduce((sum, i) => sum + i.count, 0);
}

function eyeDist2(bot, p) {
  const e = bot.entity.position;
  const dx = (p.x + 0.5) - e.x, dy = (p.y + 0.5) - (e.y + 1.4), dz = (p.z + 0.5) - e.z;
  return dx * dx + dy * dy + dz * dz;
}

// Every grass block whose center is within break reach of the eyes, nearest first, less the tufts a peer holds
// and the tufts this pick already swung at and failed to clear.
function grassInReach(bot, peerHeld, failedHere) {
  const feet = bot.entity.position.floored();
  const found = [];
  for (let dx = -MELEE_SCAN_RADIUS; dx <= MELEE_SCAN_RADIUS; dx++) {
    for (let dy = -MELEE_SCAN_RADIUS; dy <= MELEE_SCAN_RADIUS; dy++) {
      for (let dz = -MELEE_SCAN_RADIUS; dz <= MELEE_SCAN_RADIUS; dz++) {
        const p = new Vec3(feet.x + dx, feet.y + dy, feet.z + dz);
        const b = bot.blockAt(p);
        if (!b || !GRASS_SET.has(b.name) || peerHeld.has(grassKeyOf(p)) || failedHere.has(grassKeyOf(p))) continue;
        const d2 = eyeDist2(bot, p);
        if (d2 <= REACH * REACH) found.push({ p, d2 });
      }
    }
  }
  return found.sort((a, b) => a.d2 - b.d2).map(f => f.p);
}

// ── ONE TUFT, ONE PUNCHER ─────────────────────────────────────────────────────────────
// Seeds are a shared order — every idle bot may be out for them — so two bodies in one patch would swing at the
// same tuft. Each tuft is claimed before it is punched and released right after, through target_claims, the walk
// trees and stone columns use (Law 16). A tuft a peer holds is remembered for this pick and never re-asked.
const grassKeyOf = (p) => `grass:${p.x},${p.y},${p.z}`;

// Only shears changes the grass drop (block instead of seeds); unequip it if held. Any other
// held item breaks grass identically, so leave it — no needless swap.
async function ensureBareHands(bot) {
  const held = bot.heldItem;
  if (held && /shears/.test(held.name)) await guardExternal(TAG, 'unequip shears', () => bot.unequip('hand'));
}

// ── Main API ─────────────────────────────────────────────────────────────────
async function pick(bot, opts = {}) {
  bot = bot || global.bot;
  if (!bot?.entity?.position) {
    throw new Error('[seed_picker] CODING VIOLATION: pick called with no bot loaded.');
  }
  const quantity = opts.quantity || 1;
  const dispatcher = require('@locomotion/locomotion_dispatcher');
  const surfaceFilter = require('@perception/surface_filter');

  const startCount = countSeeds(bot);
  const targetTotal = startCount + quantity;
  const maxPunches = MAX_GRASS_PUNCHES;
  let punches = 0;
  let concedeReason = null;       // why the search ended without meeting target (for the caller's routing)

  watcher.summary(TAG, `Picking seeds: have ${startCount}, want +${quantity}, and will stop at ${maxPunches} punches whichever comes first.`);

  const peerHeld = new Set();     // tuft keys a peer held when this pick asked — never re-asked this pick
  // Tuft keys this pick swung at without clearing — never re-picked this pick. A failed punch spends no budget
  // (only a confirmed clear is a punch), so without this set nothing about the loop moved when a tuft refused
  // and the same tuft came back as nearest forever. Each failure shrinks the in-reach set by one, so a visit
  // always ends.
  const failedHere = new Set();
  const finished = () => countSeeds(bot) >= targetTotal || punches >= maxPunches;

  // One visit: every tuft within reach of where the body stands, then the drops it left.
  const punchHere = async () => {
    while (!finished()) {
      await combatCheckpoint(bot, 'seed_pick');

      const walk = await claimFirst(grassInReach(bot, peerHeld, failedHere), { keyOf: grassKeyOf });
      for (const key of walk.peerHeldKeys) peerHeld.add(key);
      if (!walk.pick) break;
      const tuft = walk.pick;
      const block = bot.blockAt(tuft);
      if (block && GRASS_SET.has(block.name)) {
        await ensureBareHands(bot);
        const look = await guardExternal(TAG, `lookAt tuft (${tuft.x},${tuft.y},${tuft.z})`, () => bot.lookAt(tuft.offset(0.5, 0.5, 0.5)));
        if (look.ok) {
          // equip:'none' — ensureBareHands() above is load-bearing: seeds only drop from grass
          // punched bare. Letting the one dig route equip a tool here would silently kill the yield.
          // performDig reports instead of throwing; that report is the punch counter's only honest
          // source — counting an unconfirmed swing would walk the loop to maxPunches with no seeds
          // (Law 25).
          if (await performDig(bot, block.position, block, TAG, { equip: 'none' })) {
            punches++;
          } else {
            failedHere.add(walk.key);
            watcher.warn(TAG, `punch did not clear grass at (${tuft.x},${tuft.y},${tuft.z}) — not asked again this pick`);
          }
        }
        await sleep(60);
      }
      releaseTarget(walk.key);    // the tuft is punched or gone either way — its claim ends with this swing
    }
    await collectNearby(bot);
  };

  // ── THE SEARCH: ONE RING, EVERY TUFT OF IT, THEN THE NEXT ──────────────────────────────────────────
  // The grass where the body stands first. Then surface_filter's rings, 16 blocks wide, outward from there:
  // a ring's tufts are offered to the navigator whole, the body punches where it arrives, and what is left
  // of the ring is offered again until the ring is spent or cannot be reached; then the next ring. The pick
  // ends on its punch budget, its order, or the last loaded ring. A world whose every ring holds no grass
  // is walked out of once (exploration_api) and its rings read again from there.
  await punchHere();
  const filter = { type: 'object_group_or_direct', targets: GRASS };
  let seen = 0, visits = 0, unreached = 0, ringsRead = 0;
  for (let pass = 0; pass < 2 && !finished(); pass++) {
    const rings = surfaceFilter.openRings(bot, filter);
    for (let ring = await rings.next(); ring; ring = finished() ? null : await rings.next()) {
      let left = ring.objectives.filter(o => o && o.position && ['x', 'y', 'z'].every(k => typeof o.position[k] === 'number'));
      seen += left.length;
      while (left.length && !finished()) {
        surfaceFilter.offer(bot, filter, left, 'grass', `ring ${ring.index}, ${ring.inner}-${ring.outer} blocks out, ${left.length} offered`);
        const approach = await dispatcher.goTo({ candidates_ref: 'surface_filter', candidates_count: left.length, candidates_kind: 'grass' });
        // Movement gave up (its domain, Law 15): nothing left in this ring is reachable.
        if (!approach || !approach.arrived) { unreached += left.length; break; }
        visits++;
        await punchHere();
        const at = bot.entity.position;
        const before = left.length;
        left = left.filter(o => {
          const p = o.position;
          if ((p.x - at.x) ** 2 + (p.y - at.y) ** 2 + (p.z - at.z) ** 2 <= MELEE_SCAN_RADIUS * MELEE_SCAN_RADIUS) return false;
          const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
          return !!b && GRASS_SET.has(b.name);
        });
        if (left.length === before) break;
      }
    }
    ringsRead += rings.cost().rings;
    if (seen > 0 || pass > 0) break;
    watcher.summary(TAG, 'No grass in any loaded ring — asking exploration to walk me to a grass biome.');
    await exploration.seek(bot, {});
  }
  watcher.summary(TAG, `ring_search material=grass rings=${ringsRead} seen=${seen} visits=${visits} unreached=${unreached} punches=${punches} of=${maxPunches}`);
  if (!finished()) {
    if (seen === 0 && punches === 0) concedeReason = 'no_grass';
    else if (visits === 0 && punches === 0) concedeReason = 'unreachable';
  }

  await collectNearby(bot);   // final sweep of the last patch's drops
  const total = countSeeds(bot);
  const collected = total - startCount;

  // Spending the punch budget is success: the deliverable is the fifteen punches, not N seeds
  // (Law 25 — the asker owns the criterion), so a trip that punched its budget and came back with
  // nothing still succeeds and still ends at a chest (harvest_executor drops off after every
  // gather, unconditionally). Budget-spent is checked before the seed target for this reason. Only
  // a trip that could not punch at all is a real failure; a falsy result with `reason:'short'`
  // becomes `routeFail` in harvest_executor, which soft-fails to the judge and would re-dispatch
  // an identical gather — those keep their existing reasons so the futile-concede routing that
  // stops the judge false-killing an underground bot stays intact.
  const spentBudget = punches >= maxPunches;
  const gotEnough = total >= targetTotal;
  const success = spentBudget || gotEnough;
  const reason = success ? null : (concedeReason || (collected > 0 ? 'short' : 'no_grass'));
  watcher.summary(TAG, `Seed pick done: +${collected} wheat_seeds in ${punches}/${maxPunches} punch(es) (total ${total}) — `
    + `${spentBudget ? 'punch budget spent, taking the haul home' : gotEnough ? 'order filled early' : `stopped short: ${reason}`}.`);
  return { success, collected, total, reason };
}

module.exports = { pick };
