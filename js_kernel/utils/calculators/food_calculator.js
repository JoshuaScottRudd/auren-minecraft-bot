// calculator: food_calculator — how many of a given food does this bot need to reach full?
//
// A fixed item count is only correct for one food: bread restores 5 hunger, an apple 4, a carrot 3, so
// the count has to be computed per item.
//
// The numbers are Minecraft's vanilla hunger-restore values. An unknown food falls back to the lowest
// value on the table: under-estimating the restore over-estimates the count, and the safe direction
// fails toward more food in hand (Law 13).
//
// Saturation is left out: it decides how fast hunger drains again, not how many items fill the bar now,
// and this calculator answers only the second question (Law 22 gate 2).

'use strict';

// Vanilla hunger points restored, per item. Keys are concrete item names, matching group_to_item.food.
const HUNGER_RESTORED = {
  apple: 4,
  bread: 5,
  cooked_beef: 8,
  cooked_porkchop: 8,
  cooked_chicken: 6,
  cooked_mutton: 6,
  cooked_rabbit: 5,
  cooked_salmon: 6,
  cooked_cod: 5,
  baked_potato: 5,
  golden_apple: 4,
  beetroot: 1,
  carrot: 3,
  melon_slice: 2,
  sweet_berries: 2,
  dried_kelp: 1,
};

// Floor for a food this table does not name; under-stating the restore over-states the count, which
// fails toward more food in hand (Law 13).
const UNKNOWN_FOOD_RESTORES = 1;

// hungerValue(itemName) → points one item restores. Unknown names return UNKNOWN_FOOD_RESTORES; a chest
// may hold food nobody listed.
function hungerValue(itemName) {
  const v = HUNGER_RESTORED[itemName];
  return Number.isFinite(v) && v > 0 ? v : UNKNOWN_FOOD_RESTORES;
}

// portionsToFill(currentFood, fullAt, itemName) → how many of THIS item close the gap.
//
// Rounds up: withdrawing only enough to reach 19.6 reaches 19, and the manager's re-sense (Invariant B)
// reads that as still hungry and pays another round trip to the chest. Ceiling ends the meal in one visit.
//
// Returns 0 when the bot is already at or above `fullAt` — never a negative.
function portionsToFill(currentFood, fullAt, itemName) {
  const gap = fullAt - currentFood;
  if (!(gap > 0)) return 0;
  return Math.ceil(gap / hungerValue(itemName));
}

// portionsFromStorage(currentFood, fullAt, available) → { want, byItem, short } for a mixed larder.
//
// `available` is { itemName: count } as a chest actually holds it. Richest food first, since that
// minimises items carried and consume calls, and a stack of cooked beef ahead of the apples means the
// apples are simply never withdrawn.
//
// `want` is capped by what exists; `short` names the honest remainder still unmet (Law 25).
function portionsFromStorage(currentFood, fullAt, available = {}) {
  let gap = fullAt - currentFood;
  const byItem = {};
  let want = 0;
  if (!(gap > 0)) return { want: 0, byItem, short: 0 };

  const larder = Object.entries(available)
    .filter(([name, count]) => count > 0 && HUNGER_RESTORED[name] !== undefined)
    .sort((a, b) => hungerValue(b[0]) - hungerValue(a[0]));

  for (const [name, count] of larder) {
    if (gap <= 0) break;
    const per = hungerValue(name);
    const take = Math.min(count, Math.ceil(gap / per));
    if (take <= 0) continue;
    byItem[name] = take;
    want += take;
    gap -= take * per;
  }
  return { want, byItem, short: Math.max(gap, 0) };
}

module.exports = { hungerValue, portionsToFill, portionsFromStorage, HUNGER_RESTORED };
