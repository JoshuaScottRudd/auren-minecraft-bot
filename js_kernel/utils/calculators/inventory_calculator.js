/*
inventory_calculator.js — how many of a token does the bot hold.

Pure and stateless. The GROUP problem is why this exists as one place: a raw invCounts[token] reads 0
for a group token ('planks', 'stairs') because inventory holds only concrete keys, so the miss is silent
and looks like an empty bag. Every planner delegates here rather than indexing the map itself.
*/

'use strict';

const { group_to_item } = require('@utils/fragment_utils');

// ── WHY A MALFORMED MAP THROWS RATHER THAN COUNTING ZERO (Law 13) ────────────────────────────────
//
// Zero is a LEGAL ANSWER here, and that is what makes the wrong shape dangerous. A caller that hands
// this the wrong object gets a confident "you hold none of that", which is indistinguishable from an
// empty bag — so the planner above orders what the bot is already carrying, the manager reports the
// order complete off the real pocket, and the board orders it again. The failure surfaces several
// layers away as a loop, with nothing anywhere near the mistake to point at. Reading a count out of
// the wrong object cannot happen in a correctly-written system, which is the whole test: it is a
// coding violation, so it stops here instead of being smoothed into a number.
//
// THE TWO SHAPES THAT REACH THIS BY ACCIDENT, both indexing cleanly to `undefined`:
//   - a wrapper around the map ({ inventory: {...} }) — a caller taking a context object but
//     declaring the map, which no parser or module load can see, because the name IS bound
//   - the raw item ARRAY (bot.inventory.items()) instead of the summed map
//
// VALIDATED ONCE PER OBJECT, so the guarantee is free on the hot path. Every producer builds a fresh
// map per sweep and this runs per stock row, so a full re-check on each call would walk the same
// object dozens of times to reach the same verdict. The memo is a WeakSet: it holds no object alive,
// and a mutated map cannot become malformed because appending counts keeps every value a number.
const VALIDATED = new WeakSet();

function assertCountMap(invCounts) {
  if (VALIDATED.has(invCounts)) return;
  if (invCounts === null || typeof invCounts !== 'object' || Array.isArray(invCounts)) {
    throw new Error(`countInInventory: invCounts must be a token→count object, got ${
      Array.isArray(invCounts) ? 'an array (raw items, not a summed map?)'
        : invCounts === null ? 'null' : typeof invCounts}`);
  }
  for (const [key, value] of Object.entries(invCounts)) {
    if (typeof value !== 'number') {
      throw new Error(`countInInventory: invCounts.${key} is ${typeof value}, not a count — ` +
        'this is a wrapper or the wrong object, not an inventory');
    }
  }
  VALIDATED.add(invCounts);
}

// THE single definition of "how many <token> do I hold", and every planner delegates here because a
// raw invCounts[token] reads 0 for a GROUP token ('stairs', 'planks') — inventory holds only concrete
// keys, so the miss is silent and looks like an empty inventory.
function countInInventory(token, invCounts, groupMap = group_to_item) {
  // A missing token is the caller's own bug and gets the same treatment for the same reason: the
  // group branch below would answer 0 for it, which reads as "holds none" rather than "asked wrong".
  if (!token) throw new Error(`countInInventory: token is required, got ${JSON.stringify(token)}`);
  assertCountMap(invCounts);
  const members = groupMap && groupMap[token];
  return Array.isArray(members)
    ? members.reduce((sum, m) => sum + (invCounts[m] || 0), 0)
    : (invCounts[token] || 0);
}

module.exports = {
  countInInventory,
};
