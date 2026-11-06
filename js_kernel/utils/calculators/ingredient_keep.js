// calculator: ingredient_keep — how much of an ingredient storage keeps back before any craft may spend it.
//
// Every ingredient keeps its architect_config.INGREDIENT_KEEP row (the pen's wheat), except sugar cane while the build
// carries cane:
// THE CANE HOLD. The cane fields grow by replanting every piece cut (exponential growth), and paper spends the cane for
// good. So no paper is made, and storage keeps ALL of its cane, until every cane the build needs is available: the cane
// standing in the cane fields (farming_integrity.caneStanding, every block of every stalk) and the cane the fleet holds
// in any form (assessors/downloaded_build castleBalance, family sugar_cane: raw, and already crafted into paper or books)
// together reach the build's need, or until every cane field is planted full (farming_integrity.caneOpen): the farm
// is at its size, so a field cannot grow faster from more cane, and the cane cut past its replanting is spent as it
// comes. `reached` (standing plus held at the need) is THE LAST CUT's signal (farmland_site).
// A crew whose build carries no cane, or a body that has not read the build or the fields yet, keeps the row's number.
// REACHED STAYS REACHED: the last cut moves a stalk from standing to a pocket, which `have` does not count until it is
// banked, so the sum dips under the need while the cut is under way; a body reading that dip would replant the copy
// field with the cane it just cut. Once this body has read the need reached, it stays reached: a process runs one build.

'use strict';

let _reached = false;   // this body has read the build's cane reached

// caneHold() → { held, reached, need, have, standing, open } for the build's cane; held and reached false when there is
// nothing to hold for.
function caneHold() {
  const family = require('@thinking/assessors/downloaded_build').castleBalance()?.sugar_cane;
  const integrity = require('@perception/farming_integrity');
  const standing = integrity.caneStanding();
  const open = integrity.caneOpen();
  if (!family || !(family.need > 0) || standing === null) return { held: false, reached: false, need: family?.need || 0, have: family?.have || 0, standing, open };
  if (standing + family.have >= family.need) _reached = true;
  const reached = _reached;
  return { held: !reached && open > 0, reached, need: family.need, have: family.have, standing, open };
}

// ingredientKeep(item) → the count of `item` storage keeps back (Infinity: all of it).
function ingredientKeep(item) {
  if (item === 'sugar_cane' && caneHold().held) return Infinity;
  return require('@thinking/architect_config').INGREDIENT_KEEP[item] || 0;
}

module.exports = { ingredientKeep, caneHold };
