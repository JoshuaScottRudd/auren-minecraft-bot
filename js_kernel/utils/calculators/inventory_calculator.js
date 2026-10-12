/*
inventory_calculator.js — how many of a token does the bot hold.

Pure and stateless. A raw invCounts[token] reads 0 for a group token ('planks', 'stairs') since
inventory holds only concrete keys, so the miss is silent and looks like an empty bag. Every planner
delegates here.
*/

'use strict';

const { group_to_item, furnace_chain_items } = require('@utils/fragment_utils');

// assertCountMap validates the shape once per object (Law 13): zero is a legal answer here, so a caller
// that hands the wrong object gets a confident "holds none", indistinguishable from an empty bag, and
// the mistake surfaces only later as a phantom reorder several layers away. A wrapper around the map
// ({ inventory: {...} }) or the raw item array (bot.inventory.items()) both index cleanly to undefined,
// which this catches.
//
// Validated once per object via a WeakSet memo, since a fresh map is built per sweep and this runs per
// stock row.
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

// The single definition of how many of a token the bot holds: a raw invCounts[token] reads 0 for a
// group token ('stairs', 'planks'), since inventory holds only concrete keys.
function countInInventory(token, invCounts, groupMap = group_to_item) {
  // A missing token throws: the group branch below would otherwise read it as holding none (Law 13).
  if (!token) throw new Error(`countInInventory: token is required, got ${JSON.stringify(token)}`);
  assertCountMap(invCounts);
  const members = !furnace_chain_items.has(token) && groupMap && groupMap[token];   // a smelted item is only itself
  return Array.isArray(members)
    ? members.reduce((sum, m) => sum + (invCounts[m] || 0), 0)
    : (invCounts[token] || 0);
}

// craftsAffordable — the same pile, counted in crafts, one variant at a time.
//
// countInInventory sums a group, which is correct for holding or placing: three planks are three planks
// whatever tree they came from. It is wrong for "can I craft this": vanilla's wooden_axe accepts the
// `#minecraft:planks` tag per slot, but prismarine-recipe expands that tag into one single-species
// recipe per species, and `bot.craft` can only ever be handed one of them — so one craft spends one
// variant, and the answer is per variant, floor-divided by what one craft costs, and summed.
function craftsAffordable(token, perCraft, invCounts, groupMap = group_to_item) {
  if (!token) throw new Error(`craftsAffordable: token is required, got ${JSON.stringify(token)}`);
  if (!Number.isFinite(perCraft) || perCraft <= 0) {
    throw new Error(`craftsAffordable: perCraft must be a positive number, got ${JSON.stringify(perCraft)} `
      + `for "${token}" — a craft's cost is what makes this question answerable, and a caller that does `
      + 'not know it is asking about holding (countInInventory), not about crafting.');
  }
  assertCountMap(invCounts);
  const members = !furnace_chain_items.has(token) && groupMap && groupMap[token];   // a smelted item is only itself
  const variants = Array.isArray(members) ? members : [token];
  let crafts = 0;
  for (const v of variants) crafts += Math.floor((invCounts[v] || 0) / perCraft);
  return crafts;
}

// heldByVariant(token, invCounts) → [{ item, count }] for every member holding stock, richest first.
// Reports the per-variant breakdown that a craftsAffordable refusal on a mixed pile needs to explain.
function heldByVariant(token, invCounts, groupMap = group_to_item) {
  if (!token) throw new Error(`heldByVariant: token is required, got ${JSON.stringify(token)}`);
  assertCountMap(invCounts);
  const members = !furnace_chain_items.has(token) && groupMap && groupMap[token];   // a smelted item is only itself
  const variants = Array.isArray(members) ? members : [token];
  return variants
    .map(item => ({ item, count: invCounts[item] || 0 }))
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  countInInventory,
  craftsAffordable,
  heldByVariant,
};
