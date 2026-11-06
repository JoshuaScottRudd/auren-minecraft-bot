// api: flock_colors
// purpose: what color of wool the crew's building waits on, and what color its penned flock should be dyed to give it.
//          One question each: woolOwed (the request), flockTarget (the dyeing it asks for) and sourceBiomes (where a
//          dye's source grows, for the trip that gathers it).
//
// THE REQUEST IS THE BUILDING'S. A downloaded building keeps every block a sheep makes (wool, carpet, bed, banner) and
// sets it aside while the sheep producer is not ready (producer_hooks, downloaded_plan_registry): the plan's
// `material_rule.awaiting` counts them, as `sheep: <block>`. Each is turned into the wool it is made of by the recipe
// book (crafting_blueprints.json: a carpet is 2 wool for 3, a bed 3, a banner 6; a wall banner is a banner), and the
// wool and the made items the fleet already holds (inventory_lens.fleetHoldings) are taken off. No building, no plan
// loaded, or nothing set aside: nothing is owed, and the pen is shorn and dyed for nothing (request only).
//
// THE FLOCK IS DYED IN PROPORTION. flockTarget splits the pen's animals among the colors owed, by the wool each is owed
// (largest remainder), so one full shearing gives every color its share and all of them finish together. A color whose
// dye has no fleet source (architect_config.DYES ease `hard`) gets no animals: it is said, not dyed.

'use strict';

const { DYES } = require('@thinking/architect_config');

const SHAPE = /^(\w+?)_(wool|carpet|bed|banner|wall_banner)$/;

// woolPer(item) → { color, wool } the wool one `item` is made of, or null for an item that is not of the wool family.
function woolPer(block) {
  const m = SHAPE.exec(block);
  if (!m || !DYES[m[1]]) return null;
  const color = m[1];
  if (m[2] === 'wool') return { color, wool: 1 };
  const item = m[2] === 'wall_banner' ? `${color}_banner` : block;
  const recipe = require('@kernel/crafting_blueprint_registry').tryGetRecipe(item);
  const step = recipe && Array.isArray(recipe.sequence) ? recipe.sequence.find(s => s.item === item) : null;
  const wool = recipe?.ingredients?.[`${color}_wool`];
  if (!wool || !step) return null;
  return { color, wool: wool / (step.makes || 1) };
}

// woolOwed() → { color: wool } still owed, every color above 0; {} when nothing is.
function woolOwed() {
  const plans = require('@kernel/downloaded_plan_registry');
  if (!plans.isLoaded()) return {};
  const awaiting = plans.getPlan()?.material_rule?.awaiting || {};
  const held = require('@kernel/inventory_lens').fleetHoldings();
  const owed = {};
  for (const [key, count] of Object.entries(awaiting)) {
    const [producer, block] = key.split(': ');
    if (producer !== 'sheep' || !block) continue;
    const per = woolPer(block);
    if (!per) continue;
    const item = block.replace(/_wall_banner$/, '_banner');
    const still = Math.max(0, count - (held[item] || 0));
    owed[per.color] = (owed[per.color] || 0) + Math.ceil(still * per.wool);
  }
  for (const color of Object.keys(owed)) {
    owed[color] -= held[`${color}_wool`] || 0;
    if (owed[color] <= 0) delete owed[color];
  }
  return owed;
}

// flockTarget(animals, owed) → { color: animals } the pen of `animals` dyed in proportion to `owed`, among the colors
// whose dye the fleet can get; `held` lists the owed colors given none, with why.
function flockTarget(animals, owed) {
  const dyeable = Object.entries(owed).filter(([c]) => DYES[c] && DYES[c].ease !== 'hard');
  const held = Object.keys(owed).filter(c => !DYES[c] || DYES[c].ease === 'hard')
    .map(c => ({ color: c, why: DYES[c]?.why || `${c} dye is mixed from a dye with no fleet source` }));
  const total = dyeable.reduce((n, [, w]) => n + w, 0);
  const target = {};
  if (!total || animals <= 0) return { target, held };
  const shares = dyeable.map(([c, w]) => ({ c, exact: animals * w / total }));
  let given = 0;
  for (const s of shares) { target[s.c] = Math.floor(s.exact); given += target[s.c]; }
  shares.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
  for (let i = 0; given < animals && i < shares.length; i++, given++) target[shares[i].c]++;
  return { target, held };
}

// sourceBiomes(item) → the biomes a dye source grows in (DYES ease 'trip': cocoa beans in a jungle, cactus in a desert),
// or null for an item found anywhere. A gather that finds none in the loaded world explores toward them.
function sourceBiomes(item) {
  const d = Object.values(DYES).find(x => Array.isArray(x.biomes) && x.from.includes(item));
  return d ? d.biomes : null;
}

// flowersKept() → { flower: count } the flowers storage keeps for the dyes, the rest of every flower being compost
// (compost_executor.bankedCompostables). One dye dyes one animal for good, so a color is kept one flower for each
// animal of the full wool pen (pen_gate.flockOf) the building's wool asks dyed that color (flockTarget of woolOwed),
// less the dye of it already banked. A mixed dye (purple from blue and red) keeps a flower of each dye it is mixed
// from; a dye from no flower (cocoa beans, cactus, an ink sac, bone meal) keeps none. Nothing owed: no flower is kept.
function flowersKept() {
  const owed = woolOwed();
  if (!Object.keys(owed).length) return {};
  const { FARM_PENS, HERDING, DYE_STOCK } = require('@thinking/architect_config');
  const penGate = require('@api/pen_gate');
  const wool = FARM_PENS.find(p => HERDING.pens[p].wool);
  const pen = wool ? penGate.penOf(wool) : null;
  if (!pen) return {};
  const { target } = flockTarget(penGate.flockOf(penGate.penGeometry(pen)), owed);
  const kept = {};
  const keep = (color, n) => {
    for (const src of DYES[color].from) {
      if (src.endsWith('_dye')) keep(src.replace(/_dye$/, ''), n);
      else if (DYE_STOCK.flowers.includes(src)) kept[src] = (kept[src] || 0) + n;
    }
  };
  for (const [color, animals] of Object.entries(target)) {
    if (color === 'white' || animals <= 0) continue;
    const banked = require('@perception/chest_ledger').unclaimedOf([DYES[color].dye]);
    if (animals > banked) keep(color, animals - banked);
  }
  return kept;
}

module.exports = { woolOwed, flockTarget, woolPer, sourceBiomes, flowersKept };
