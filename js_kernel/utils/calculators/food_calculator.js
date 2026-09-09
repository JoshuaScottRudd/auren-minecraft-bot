// calculator: food_calculator — how many of a given food does this bot need to reach full?
//
// ── WHY A CALCULATOR AND NOT A CONSTANT ───────────────────────────────────────────────────────────────
// A fixed item count is only correct for one food. Bread restores 5 hunger, so 3 loaves cover a 14-point
// gap with one to spare. An apple restores 4, so the same three leave the bot two points short, forcing a
// re-sense and a second trip to the chest. A carrot restores 3 and needs five. A single constant is really
// one food's answer wearing every food's name — the count has to be computed per item.
//
// THE NUMBERS ARE MINECRAFT'S, NOT A TUNING CHOICE. They are the vanilla hunger-restore values, and the
// game is the only correct source for them; adjusting one is not tuning a policy, it is introducing an
// error. That is also why an unknown food falls back to the LOWEST value on the table rather than an
// average: under-estimating the restore over-estimates the count, which costs one extra item carried and
// dumped, while over-estimating leaves the bot short at the must-eat floor (Law 13 — the safe direction is
// the one that fails toward more food in hand, not less).
//
// SATURATION IS DELIBERATELY IGNORED. Vanilla food carries a second hidden bar that decides how fast the
// hunger bar drains again, and modelling it would change which food is *preferable*, never how many are
// needed to fill the bar right now. This calculator answers only the second question — the one the
// withdraw has to size — and a preference model is a design act, not an arithmetic one (Law 22 gate 2).

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

// The floor used for a food this table does not name. See the header: the safe direction is to
// UNDER-state the restore, because that OVER-states the count and fails toward more food in hand.
const UNKNOWN_FOOD_RESTORES = 1;

// hungerValue(itemName) → points one item restores. Never throws on an unknown name: this is called with
// whatever a chest happens to hold, and a food nobody listed is an environmental fact, not a coding fault.
function hungerValue(itemName) {
  const v = HUNGER_RESTORED[itemName];
  return Number.isFinite(v) && v > 0 ? v : UNKNOWN_FOOD_RESTORES;
}

// portionsToFill(currentFood, fullAt, itemName) → how many of THIS item close the gap.
//
// Rounds UP, and the extra item is the point rather than a rounding artefact: a bot that withdraws exactly
// enough to reach 19.6 has withdrawn enough to reach 19, and the manager's re-sense (Invariant B) then reads
// it as still hungry and pays another round trip to the chest. Ceiling ends the meal in one visit.
//
// Returns 0 when the bot is already at or above `fullAt` — never a negative, and never a "one anyway".
function portionsToFill(currentFood, fullAt, itemName) {
  const gap = fullAt - currentFood;
  if (!(gap > 0)) return 0;
  return Math.ceil(gap / hungerValue(itemName));
}

// portionsFromStorage(currentFood, fullAt, available) → { want, byItem } for a MIXED larder.
//
// `available` is { itemName: count } as a chest actually holds it — the caller passes what is there, never
// an assumption about what should be. Richest food first, because that is what minimises both the number
// of items carried and the number of consume calls, and because the bot cannot eat past full: a stack of
// cooked beef ahead of the apples means the apples are simply never withdrawn.
//
// `want` is capped by what EXISTS. Asking for more than the larder holds and reporting the ask as the
// requirement is the Law 25 fault this returns two fields to avoid — `want` is what will be pulled,
// `short` is the honest remainder, and the caller is told rather than left to infer it from a count that
// silently came back small ("if too low then it just eats what it can").
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
