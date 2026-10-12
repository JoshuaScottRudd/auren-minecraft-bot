// fragment: eat_executor  (action / self-preservation)
// The EAT verb: eats off the pocket, and when the pocket is dry, withdraws food from storage first.
// Reports the ACTION outcome to recursive_judge; eat_manager rules on whether the bot is safe now by
// re-sensing after the judge hands the signal back (the executor→judge→manager loop the
// supply/mining/build managers also run).
//
// Food lives in a shared chest, not the pocket: supply_manager bakes bread from wheat into the
// headframe chest, and a hungry bot walks there, withdraws, and eats — decoupling who bakes from who
// eats. The storage withdraw (step 2 below) is the primary route; step 1 covers whatever a prior
// dump left sitting in the pocket.
//
// A missing-food storage read is two-tier against the must-eat floor (HUNGER_MUST_EAT_THRESHOLD):
// above it, a missing-food read soft-defers and the bot keeps working; at or below it, this is the
// Law 13 halt. Storage is read here first because inventory_swapper owns its own abandonment —
// asked for food no chest holds, it routes to recursive_judge itself and returns undefined (Law 15),
// so this fragment checks first, keeping that as the one signal raised (Law 4).
//
// Fullness is bot.food, re-read each loop (Invariant B), never a running tally: bot.consume() itself
// throws at 20, so the loop condition and the primitive agree on the ceiling.

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
// ── HOW MANY TO WITHDRAW IS CALCULATED, NOT A CONSTANT ──────────────────────────────────────────────
// Sizes the withdraw to the current gap to full, per food actually on the shelf — bread, apple, and
// carrot each restore a different amount, so one count cannot fit them all. The arithmetic lives in
// `food_calculator`, beside Minecraft's other item numbers (Law 16). Sizing to the current gap means
// the withdraw never carries a reserve; any surplus still dumps back on the next supply pass.

// The first edible stack in the pocket, or null (pocket dry). Any food restores hunger — a bot eats what it
// carries (bread, from the farm), no best-food ranking.
function _pocketFood(bot) {
  return bot.inventory.items().find(i => FOOD_SET.has(i.name)) || null;
}

// Total edible items across every storage chest, for deciding whether a withdraw is worth
// attempting. Sums the food group (bread, cooked meats, apples), so a bot feeds off whatever a
// prior dump left, not bread alone.
function _foodInStorage() {
  let total = 0;
  for (const count of Object.values(_larder())) total += count;
  return total;
}

// The same read, kept per-item: { bread: 4, apple: 9 }. food_calculator needs which foods are on
// offer, not just a total, since different foods close the hunger gap by different amounts.
function _larder() {
  const out = {};
  for (const entry of Object.values(stationRegistry.getStations())) {
    if (!require('@perception/station_registry').isStorage(entry)) continue;
    for (const [name, count] of Object.entries(chestItemCounts(entry))) {
      if (FOOD_SET.has(name)) out[name] = (out[name] || 0) + count;
    }
  }
  return out;
}

// hasAccessibleFood — is there anything this bot could eat right now, pocket or any storage chest.
// The one food-availability read (Law 16, off the same FOOD_SET the eat paths use), exported so
// job_board gates posting the should-eat job on it and eat_manager gates dispatching it — unless
// food is reachable, or the bot is at the must-eat floor, the bot works the farm instead.
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
    // Equip and consume as one guarded unit: a failed equip makes the consume meaningless.
    const eaten = await require('@kernel/item_book').during('eat', 'eaten', () => guardExternal(TAG, `consume ${item.name} at food ${bot.food}/20`,
      async () => { await bot.equip(item, 'hand'); await bot.consume(); }));
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
function _routeJudge(payload, success, readable) {
  payload[TAG] = { success, food: global.bot?.food, recursion_alert: true };
  payload.readable = readable;
  watcher.summary(TAG, readable);
  routeToJudge(TAG, { ...payload, readable });
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType, payload = {}) {
    if (signalType !== TAG) return;
    const bot = global.bot;

    if (!bot || typeof bot.food !== 'number') {
      throw new Error(`[${TAG}] CODING VIOLATION: dispatched with no bot/food loaded.`);
    }

    // 1) Eat what's in the pocket.
    let result = await eatUntilFull(bot);
    if (result.full) {
      return _routeJudge(payload, true, `${TAG}: ate ${result.ate} from pocket — food ${result.foodBefore}→${result.foodAfter}/20 (full)`);
    }

    // 2) Pocket dry, still hungry → withdraw food from storage if any exists, then eat again.
    const larder = _larder();
    if (Object.values(larder).some(n => n > 0)) {
      // Sized against what the chests actually hold; `short` is the remainder when they hold less
      // than the gap, reported as a number (Law 25).
      const plan = portionsFromStorage(result.foodAfter, HUNGER_FULL, larder);
      const ret = await inventorySwapper.retrieveItems(bot, 'food', plan.want);
      if (ret === undefined) return;   // chest unreachable — inventory_swapper already abandoned to the judge (Law 4/15)

      const before = result.foodAfter;
      result = await eatUntilFull(bot);
      const tail = result.full ? '(full)'
        : plan.short > 0 ? `(storage was ${plan.short} hunger point(s) short of a full meal — ate what there was)`
        : '(still hungry — storage thinning)';
      const menu = Object.entries(plan.byItem).map(([n, c]) => `${c}x ${n}`).join(', ') || 'nothing on the shelf';
      return _routeJudge(payload, result.full || result.ate > 0,
        `${TAG}: asked storage for ${menu} to close ${HUNGER_FULL - before} point(s), ate ${result.ate}`
        + ` — food ${before}→${result.foodAfter}/20 ${tail}`);
    }

    // 3) Hungry, pocket empty, no food anywhere in storage. Two-tier, and both tiers report instead of
    //    halting: at or below the must-eat floor this is the loud tier (`success:false`, a counted
    //    fault the judge can act on — Law 25, name the shortfall); above it, the quiet tier
    //    (`success:true`) covers the grow-in window while the farms produce the first loaf. job_board's
    //    should-eat gate and eat_manager's stand-down mean this executor is normally only reached with
    //    food present or at the floor; this path covers food vanishing mid-chain. Either way eat_manager
    //    re-senses and the loop re-plans; starvation is survivable in Minecraft, and death_manager owns
    //    the case where the bot does die.
    if (bot.food <= HUNGER_MUST_EAT_THRESHOLD) {
      return _routeJudge(payload, false,
        `${TAG}: STARVING (food ${bot.food}/20, at the must-eat floor ${HUNGER_MUST_EAT_THRESHOLD}) with an empty ` +
        `pocket and NO food in any storage chest. The food chain (wheat farms→wheat→bread in the shared food chest) ` +
        `has not produced anything this bot can eat. Standing down hungry rather than halting — the farm is the thing ` +
        `to look at, and the bot keeps working while it catches up.`);
    }
    return _routeJudge(payload, true,
      `${TAG}: no food reachable yet (food ${bot.food}/20, above must-eat floor ${HUNGER_MUST_EAT_THRESHOLD}) ` +
      `— deferring; bot works while the farms produce (Law 17 two-tier).`);
  }),
  // Exported with no current external caller.
  eatUntilFull,
  // Exported for the planners' should-eat gate (`assessors/hunger`, eat_manager) — the one
  // food-availability authority (Law 16).
  hasAccessibleFood,
};
