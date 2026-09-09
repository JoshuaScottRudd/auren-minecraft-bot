// fragment: eat_executor  (action / self-preservation)
// purpose: The EAT verb of the eating triad. One job: get the bot fed — eat off the pocket, and if the
//          pocket is dry, pull food from storage first. It reports the ACTION outcome to recursive_judge;
//          it does NOT rule on whether the bot is safe now — that verdict is eat_manager's, made by
//          re-sensing after the judge hands this signal back (the canonical executor→judge→manager loop the
//          supply/mining/build managers run — an executor cannot verify its own work).
//
// WHY food lives in a SHARED CHEST, not the pocket: bots hold ZERO food. bread is a storage row good
// (headframe chest 1) — supply_manager bakes it from wheat and delivers it there — and a hungry bot walks
// to storage, withdraws food, and eats. A baker holding its own loaves cannot feed a peer; a chest decouples
// who-bakes from who-eats. So this executor's PRIMARY route is the storage withdraw (step 2 below), not a
// fallback: with zero-hold the pocket is normally empty, so step 1 no-ops and the meal comes straight from
// the chest.
//
// WHY a MISSING-FOOD storage read → a TWO-TIER response: the food chain (wheat farms → wheat → bread in the
// shared chest) is SUPPOSED to keep the fleet fed — but on a fresh start the crops haven't grown the first
// loaf yet, so "hungry + no food" is the NORMAL grow-in condition, not a fault. So the throw moved to the
// MUST-EAT floor (food ≤ HUNGER_MUST_EAT_THRESHOLD): only a bot that has drained all the way to empty with
// still no food has proven the chain failed — that is the Law 13 halt. Above the floor (the whole
// should-eat→must-eat runway) a missing-food read soft-defers and the bot keeps working. We read storage
// OURSELVES first because inventory_swapper OWNS its abandonment: asked to retrieve food that no chest holds
// it routes to recursive_judge and returns undefined (Law 15) — calling it blind and then throwing would
// raise a second signal on top of that one (Law 4). Check first, tier the response on the must-eat floor,
// and let the API own the reachable-but-unreachable case.
//
// FULLNESS is bot.food, re-read each loop (Invariant B), never a running tally: bot.consume() itself throws
// "Food is full" at 20, so the loop condition and the primitive agree on the ceiling. eatUntilFull was
// exported for a headless test that no longer exists (`tools/README.md`: a test is born with the work and
// dies with it). The export now has NO consumer — do not read it as load-bearing surface. The one claim
// that test carried, must-eat < eat-at < full, is owed as a load-time throw beside those constants; until it
// is written, that ordering is unguarded.

'use strict';

const watcher = require('@kernel/watcher');
const { group_to_item, chestItemCounts } = require('@utils/fragment_utils');   // single food-list source (Law 16)
const { HUNGER_FULL, HUNGER_MUST_EAT_THRESHOLD } = require('@thinking/architect_config');
const { portionsFromStorage } = require('@utils/calculators/food_calculator');
const { routeToJudge } = require('@utils/signal_utils');
const inventorySwapper = require('@api/inventory_swapper');
const { guardExternal } = require('@utils/external_library_guard');
const stationRegistry = require('@perception/station_registry');

const TAG = 'eat_executor';
const FOOD_SET = new Set(group_to_item.food);   // apple/bread/cooked_*/… — the edible group
const STORAGE_TYPES = new Set(['chest', 'trapped_chest', 'barrel']);
// ── HOW MANY TO WITHDRAW IS CALCULATED, NOT A CONSTANT ──────────────────────────────────────────────
// It sizes the withdraw to how much of each food is actually needed, pulls that from storage, and eats
// what it can if storage falls short.
//
// This was `EAT_RETRIEVE_BATCH = 3` — the right answer for BREAD and no other food. Bread restores 5, so
// three loaves cover the 14-point gap from the eat threshold to full. An apple restores 4, so the same
// three leave the bot two points short: the manager re-senses hungry (Invariant B), re-dispatches, and the
// bot pays a second walk to the chest for one apple. A carrot needs five. The constant was bread's answer
// wearing every food's name, and the arithmetic that replaces it lives in `food_calculator` — a calculator,
// beside the seven others, because the numbers are Minecraft's and belong in one place (Law 16).
//
// Small-batch remains the intent and the calculator preserves it by construction: it sizes the withdraw to
// the CURRENT GAP, so it can never ask for a carried reserve. Zero-hold is unchanged — bread left the bot
// keep-list, so any surplus dumps back on the next supply pass; this only stops the bot arriving at the
// chest with the wrong number in mind.

// The first edible stack in the pocket, or null (pocket dry). Any food restores hunger — a bot eats what it
// carries (bread, from the farm), no best-food ranking.
function _pocketFood(bot) {
  return bot.inventory.items().find(i => FOOD_SET.has(i.name)) || null;
}

// Total edible items sitting in every storage chest — the "is there food to withdraw?" read. Sums the food
// GROUP (bread + cooked meats + apples), so a bot feeds off whatever a prior dump left, not bread alone.
function _foodInStorage() {
  let total = 0;
  for (const count of Object.values(_larder())) total += count;
  return total;
}

// The same read, kept per-item: { bread: 4, apple: 9 }. The calculator needs to know WHICH foods are on
// offer, not just how many things are edible — three apples and three loaves close different gaps. Summed
// across every storage chest for the reason _foodInStorage always was: a bot feeds off whatever a prior
// dump left, not off bread alone.
function _larder() {
  const out = {};
  for (const entry of Object.values(stationRegistry.getStations())) {
    if (!entry || !STORAGE_TYPES.has(entry.type)) continue;
    for (const [name, count] of Object.entries(chestItemCounts(entry))) {
      if (FOOD_SET.has(name)) out[name] = (out[name] || 0) + count;
    }
  }
  return out;
}

// hasAccessibleFood — is there ANYTHING this bot could eat right now (pocket OR any storage chest)? The ONE
// food-availability read (Law 16, off the same FOOD_SET the eat paths use), exported so the planners gate the
// SHOULD-EAT job on it: job_board won't POST it, and eat_manager won't DISPATCH it, unless food is reachable
// (or the bot is at the must-eat floor). Without that gate a hungry-but-unfed bot spins a survival job it
// cannot fill instead of working the farm that makes the food — which is what buys the farms the 18→0 window
// to produce.
function hasAccessibleFood(bot) {
  return !!_pocketFood(bot) || _foodInStorage() > 0;
}

// eatUntilFull(bot) → { success, foodBefore, foodAfter, ate, ranOut, full }. Success = reached full. Never
// throws on an environmental interruption (Law 13): a cancelled/interrupted consume stops the loop and
// reports what it managed — eat_manager re-senses and the loop re-plans.
async function eatUntilFull(bot) {
  bot = bot || global.bot;
  if (!bot || typeof bot.food !== 'number') {
    throw new Error('[eat_executor] CODING VIOLATION: eatUntilFull called with no bot/food loaded.');
  }

  const foodBefore = bot.food;
  let ate = 0;

  while (bot.food < HUNGER_FULL) {
    const item = _pocketFood(bot);
    if (!item) break;   // pocket dry → ranOut
    // One guarded unit rather than two, because a failed equip makes the consume meaningless — splitting
    // them would only add a branch that does the same thing.
    const eaten = await guardExternal(TAG, `consume ${item.name} at food ${bot.food}/20`,
      async () => { await bot.equip(item, 'hand'); await bot.consume(); });
    if (!eaten.ok) break;   // "food is full" (hit 20 between the check and the call) and a cancelled eat
                            // are both environmental and both end the loop with a partial result (Law 13 —
                            // the manager owns the retry via re-plan).
    ate++;
  }

  const foodAfter = bot.food;
  const full = foodAfter >= HUNGER_FULL;
  const ranOut = !full && !_pocketFood(bot);
  return { success: full, foodBefore, foodAfter, ate, ranOut, full };
}

// Route the eat outcome to the judge with the manager stamp preserved (payload.manager === 'eat_manager');
// the judge hands this back to eat_manager to VERIFY (Invariant B). Capsule keyed by own name so the judge
// reads THIS fragment's outcome, never a peer's accumulated one (Invariant D).
function _routeJudge(signalBus, payload, success, readable) {
  payload[TAG] = { success, food: global.bot?.food, recursion_alert: true };
  payload.readable = readable;
  watcher.summary(TAG, readable);
  routeToJudge(signalBus, TAG, { ...payload, readable });
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType, payload = {}) {
    if (signalType !== TAG) return;
    const signalBus = require('@kernel/signal_bus');
    const bot = global.bot;

    if (!bot || typeof bot.food !== 'number') {
      throw new Error(`[${TAG}] CODING VIOLATION: dispatched with no bot/food loaded.`);
    }

    // 1) Eat what's in the pocket.
    let result = await eatUntilFull(bot);
    if (result.full) {
      return _routeJudge(signalBus, payload, true, `${TAG}: ate ${result.ate} from pocket — food ${result.foodBefore}→${result.foodAfter}/20 (full)`);
    }

    // 2) Pocket dry, still hungry → withdraw food from storage if any exists, then eat again.
    const larder = _larder();
    if (Object.values(larder).some(n => n > 0)) {
      // Sized against what the chests ACTUALLY hold, and `short` is the honest remainder when they hold
      // less than the gap — eating what storage has is a real outcome here, not a degraded one, so it is
      // reported as a number rather than inferred from a small withdraw (Law 25).
      const plan = portionsFromStorage(result.foodAfter, HUNGER_FULL, larder);
      const ret = await inventorySwapper.retrieveItems(bot, 'food', plan.want);
      if (ret === undefined) return;   // chest unreachable — inventory_swapper already abandoned to the judge (Law 4/15)

      const before = result.foodAfter;
      result = await eatUntilFull(bot);
      const tail = result.full ? '(full)'
        : plan.short > 0 ? `(storage was ${plan.short} hunger point(s) short of a full meal — ate what there was)`
        : '(still hungry — storage thinning)';
      const menu = Object.entries(plan.byItem).map(([n, c]) => `${c}x ${n}`).join(', ') || 'nothing on the shelf';
      return _routeJudge(signalBus, payload, result.full || result.ate > 0,
        `${TAG}: asked storage for ${menu} to close ${HUNGER_FULL - before} point(s), ate ${result.ate}`
        + ` — food ${before}→${result.foodAfter}/20 ${tail}`);
    }

    // 3) Hungry, pocket empty, NO food anywhere in storage. TWO-TIER: only the MUST-EAT floor throws. Above
    //    it this is the expected grow-in window — the farms are still producing the first loaf — so
    //    soft-defer and let the bot keep working (job_board's should-eat gate and eat_manager's stand-down
    //    mean this executor is normally only reached with food present or at the floor; this path is the
    //    food-vanished-mid-chain race, handled without a halt). eat_manager re-senses and the loop re-plans.
    if (bot.food <= HUNGER_MUST_EAT_THRESHOLD) {
      throw new Error(
        `[${TAG}] CODING VIOLATION (Law 13): STARVING (food ${bot.food}/20, at the must-eat floor ` +
        `${HUNGER_MUST_EAT_THRESHOLD}) with an empty pocket and NO food in any storage chest. The food chain ` +
        `(wheat farms→wheat→bread in the shared food chest) failed to feed this bot before it emptied — a ` +
        `system fault requiring inspection, not a world condition to replan around.`
      );
    }
    return _routeJudge(signalBus, payload, true,
      `${TAG}: no food reachable yet (food ${bot.food}/20, above must-eat floor ${HUNGER_MUST_EAT_THRESHOLD}) ` +
      `— deferring; bot works while the farms produce (Law 17 two-tier).`);
  }),
  // No consumer — see the header. Kept only so removing it is a deliberate act.
  eatUntilFull,
  // Exported for the planners' should-eat gate (`assessors/hunger`, eat_manager) — ONE food-availability
  // authority (Law 16), never a second reader.
  hasAccessibleFood,
};
