// api: seed_picker
// purpose: Pick wheat_seeds by punching surface grass. Law 15 sub-loop API, sibling to
//          tree_feller / drop_collector — harvest_executor calls pick(bot, {quantity})
//          directly (no signal-bus entry point).
//
// WHY this exists as its own verb (Law 0): "punch grass for seeds" is neither felling a tree
// nor the generic cobblestone/stone punch path. Grass is a one-hit break with a PROBABILISTIC
// drop (~1/8 wheat_seeds per short_grass in 1.21.5), so the loop is punch-many / collect-batch
// / recount — a different shape than "dig N of a block". Seeds are a farm input the idle bot
// gathers while its peer mines the shaft down.
//
// TOOL (subtle, load-bearing): grass must be broken with hand or ANY tool EXCEPT shears.
// Shears makes grass drop the grass block itself, not seeds. So the only tool that breaks this
// verb is shears — guarded by ensureBareHands. A held pickaxe/shovel is fine (drop is unchanged).
//
// FAILURE (Law 15 caller abandonment): movement is goTo's domain — a goTo that gives up
// resolves arrived:false and pick() returns {success:false}; harvest_executor then routes the
// soft-fail to recursive_judge (Law 13 environmental). pick() adds NO movement retry of its own.
// "No grass in range" and "grass unreachable" are likewise environmental soft-fails, not throws.
//
// Returns: { success, collected, total, reason } — total is the post-pick inventory count (strictly
// rises across successful picks) so harvest_executor's readable stays unique and the judge's
// identical-outcome kill never false-fires on back-to-back picks.
//
// SUCCESS MEANS THE ERRAND RAN, NOT THAT THE ORDER FILLED (Architect 2026-08-13 — see MAX_GRASS_PUNCHES).
// Spending the punch budget IS the deliverable, so a trip that punched its fifteen and drew no seeds
// returns success and goes and dumps. `reason` therefore classifies only a trip that could not punch:
// 'no_grass' | 'unreachable' | 'short', null on success. harvest_executor sends the futile case to idle
// instead of re-dispatching an identical gather that the judge would false-kill as a loop.

const watcher = require('@kernel/watcher');
const Vec3 = require('vec3');
// Entered through combatCheckpoint, never battleStations directly (Architect 2026-08-08: "remove it
// from the callers"). One process-wide 500 ms clock, shared with the dig and drive primitives that now
// carry the same gate, plus the engaging/escaping bypass so combat's own arms cannot re-enter it. The
// whole reasoning is in its header; a call a primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { collectNearby } = require('@api/drop_collector.js');
const { performDig } = require('@utils/movement/dig_authority');
const exploration = require('@api/exploration_api');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'seed_picker';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const GRASS = ['short_grass', 'tall_grass', 'fern'];
const GRASS_SET = new Set(GRASS);
const REACH = 4.5;                 // melee break reach, from the eyes
const MELEE_SCAN_RADIUS = 4;       // cube half-extent for the in-reach grass scan
// ── THE PUNCH CAP IS FLAT, AND THE ORDER SIZE NO LONGER TOUCHES IT (Architect 2026-08-13) ──────────
// "not more than 15 grass block punches. doesent matter how many seeds are gathered. just punch 15
//  grass blocks and go dump whatever you get"
//
// It used to be `Math.min(quantity * 10 + 30, 400)` — a budget derived from the ~1/8 drop rate, sized so
// ONE dispatch could plausibly fill the whole order. That derivation is exactly what made the job
// unbounded in the world, and the 45-minute soak of 2026-08-13 is the receipt: a single
// `supply/wheat_seeds` job ran 12m19s (4× the next-longest job in the run), drifted the bot ~134 blocks
// from base, and it died there to a skeleton at night. The distance was never planned — the loop
// approaches a fresh patch every few punches, so a 400-punch budget is ~100 approaches of random walk.
//
// THE WRONG FIX, TRIED IN THE REPORT AND REJECTED BY HIM: cap the TRAVEL RADIUS. That treats the symptom
// and leaves the bot circling a small area for twelve minutes. The order size was never the thing worth
// protecting — seeds are a farm input with a probabilistic drop, so "gather N" is a goal the world may
// simply decline to grant on this trip, and a bot that keeps trying is one obeying a criterion nobody
// needs met today. A flat cap converts an open-ended search into a fixed, cheap errand that always ends.
//
// FIFTEEN IS HIS NUMBER, NOT A DERIVED ONE — do not "correct" it back toward the drop rate. At ~1/8 it
// yields ~2 seeds a trip, and that is the intended trade: many small bounded trips beat one unbounded one.
const MAX_GRASS_PUNCHES = 15;
const MAX_STALLS = 2;              // approaches that land with no grass in reach before conceding

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

// Nearest grass block whose center is within break reach of the eyes, or null.
function nearestGrassInReach(bot) {
  const feet = bot.entity.position.floored();
  let best = null, bestD = REACH * REACH;
  for (let dx = -MELEE_SCAN_RADIUS; dx <= MELEE_SCAN_RADIUS; dx++) {
    for (let dy = -MELEE_SCAN_RADIUS; dy <= MELEE_SCAN_RADIUS; dy++) {
      for (let dz = -MELEE_SCAN_RADIUS; dz <= MELEE_SCAN_RADIUS; dz++) {
        const p = new Vec3(feet.x + dx, feet.y + dy, feet.z + dz);
        const b = bot.blockAt(p);
        if (!b || !GRASS_SET.has(b.name)) continue;
        const d2 = eyeDist2(bot, p);
        if (d2 <= bestD) { bestD = d2; best = p; }
      }
    }
  }
  return best;
}

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
  let stalls = 0;
  let exploredForGrass = false;   // whether we already relocated toward a grass biome this pick
  let concedeReason = null;       // why the loop broke without meeting target (for the caller's routing)

  watcher.summary(TAG, `Picking seeds: have ${startCount}, want +${quantity}, and will stop at ${maxPunches} punches whichever comes first.`);

  while (countSeeds(bot) < targetTotal && punches < maxPunches) {
    await combatCheckpoint(bot, 'seed_pick');

    const tuft = nearestGrassInReach(bot);
    if (tuft) {
      const block = bot.blockAt(tuft);
      if (block && GRASS_SET.has(block.name)) {
        await ensureBareHands(bot);
        const look = await guardExternal(TAG, `lookAt tuft (${tuft.x},${tuft.y},${tuft.z})`, () => bot.lookAt(tuft.offset(0.5, 0.5, 0.5)));
        if (look.ok) {
          // equip:'none' — ensureBareHands() above is load-bearing: seeds only drop from grass
          // punched BARE. Letting the one dig route equip a tool here would silently kill the yield.
          // performDig REPORTS rather than throws, and its report is the punch counter's only honest
          // source: counting an unconfirmed swing walks the loop to maxPunches with no seeds (Law 25).
          if (await performDig(bot, block.position, block, TAG, { equip: 'none' })) {
            punches++;
            stalls = 0;
          } else {
            watcher.warn(TAG, `punch did not clear grass at (${tuft.x},${tuft.y},${tuft.z})`);
          }
        }
        await sleep(60);
      }
      continue;
    }

    // Melee range cleared — sweep the seed drops we left, then move to the next patch.
    await collectNearby(bot);
    if (countSeeds(bot) >= targetTotal) break;

    // Unguarded: surfaceFilter is ours. `catch → break` exited the loop with the same shape a genuine
    // "no grass in reach" exit has, so a broken scanner and an exhausted field left identical evidence
    // (Law 25); the throw below depends on this scan having actually run.
    const scan = surfaceFilter.scan(bot, { type: 'object_group_or_direct', targets: GRASS });
    const candidates = (scan?.objectives || []).filter(
      o => o && o.position && ['x', 'y', 'z'].every(k => typeof o.position[k] === 'number')
    );
    if (!candidates.length) {
      // No grass anywhere the surface scan can see (it already looks at the surface from any depth).
      // Ask exploration_api to WALK us to a grass biome, then re-sense — exactly ONCE. NO retry loop:
      // if a re-scan after a real relocation still finds nothing, seek keeps re-picking the biome
      // we're in and barely moves, which can only scan→seek→scan forever. That is a broken
      // expectation (a seed gather was dispatched where grass can't be found), so Law 13 says surface
      // it — throw — rather than soft-loop it. Fix the plan, not this code.
      if (exploredForGrass) {
        throw new Error(`[${TAG}] CODING VIOLATION: no grass in range even after relocating toward a grass biome — a seed gather was dispatched where grass cannot be reached. The expectation is wrong (do not post/keep the seed job here); this must not be retried into an infinite loop.`);
      }
      exploredForGrass = true;
      watcher.summary(TAG, 'No grass in range — asking exploration to walk me to a grass biome.');
      await exploration.seek(bot, {});   // exploration_api walks us toward a grassy biome
      continue;                          // re-sense (scan) from wherever we ended up
    }

    const approach = await dispatcher.goTo({
      candidates_ref: 'surface_filter',
      candidates_count: candidates.length,
      candidates_kind: scan.summary.target
    });
    if (!approach || !approach.arrived) {
      // Movement gave up — its domain (Law 15). Concede; harvest_executor routes the soft-fail.
      watcher.warn(TAG, 'could not approach grass — abandoning to caller.');
      const collectedNow = countSeeds(bot) - startCount;
      return { success: false, collected: collectedNow, total: countSeeds(bot), reason: 'unreachable' };
    }

    // Arrived but nothing landed in reach — a couple of these in a row means the grass is
    // fenced off / on terrain we can't stand beside. Concede instead of scan↔approach forever.
    if (!nearestGrassInReach(bot) && ++stalls >= MAX_STALLS) {
      watcher.warn(TAG, `grass unreachable after ${stalls} approaches — conceding.`);
      concedeReason = 'unreachable';
      break;
    }
  }

  await collectNearby(bot);   // final sweep of the last patch's drops
  const total = countSeeds(bot);
  const collected = total - startCount;

  // ── SPENDING THE BUDGET IS SUCCESS (Architect 2026-08-13) ────────────────────────────────────────
  // "just punch 15 grass blocks and go dump whatever you get" — the asker owns the criterion (Law 25),
  // and he moved it: the deliverable is FIFTEEN PUNCHES, not N seeds. Reporting `success:false` after
  // spending the budget would be true against the OLD criterion and false against his, and it is not a
  // cosmetic difference — harvest_executor turns a falsy result with `reason:'short'` into `routeFail`,
  // which soft-fails to the judge and re-dispatches an identical gather. That loop is precisely how one
  // seed job ran 12m19s and killed a bot: capping the punches while still reporting failure would have
  // moved the unbounded loop one level up and changed nothing.
  //
  // The order is deliberate — budget-spent is checked BEFORE the seed target, so a trip that punched its
  // fifteen and came back with nothing still succeeds and still ends at a chest (harvest_executor drops
  // off after every gather, unconditionally). Only a trip that could not punch AT ALL is a real failure,
  // and those keep their existing reasons so the futile-concede routing that stops the judge false-killing
  // an underground bot is untouched.
  const spentBudget = punches >= maxPunches;
  const gotEnough = total >= targetTotal;
  const success = spentBudget || gotEnough;
  const reason = success ? null : (concedeReason || (collected > 0 ? 'short' : 'no_grass'));
  watcher.summary(TAG, `Seed pick done: +${collected} wheat_seeds in ${punches}/${maxPunches} punch(es) (total ${total}) — `
    + `${spentBudget ? 'punch budget spent, taking the haul home' : gotEnough ? 'order filled early' : `stopped short: ${reason}`}.`);
  return { success, collected, total, reason };
}

module.exports = { pick };
