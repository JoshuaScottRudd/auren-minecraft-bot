/*
fuel_calculator.js — how much fuel a number of furnace smelts burns.

Pure and stateless: smelts in, fuel out. Owns the yield table furnace_executor sizes a batch's fuel with and
assessors/furnace sizes the charcoal row with, so the two never disagree (Law 16).
*/

'use strict';

// Smelts per unit of fuel: a coal or a charcoal cooks 8 items, a plank 1.5.
const FUEL_SMELT_YIELD = Object.freeze({ coal: 8, charcoal: 8, planks: 1.5 });

// charcoalFor(smelts) → the charcoal that cooks `smelts` items and is itself cooked on charcoal: each charcoal is
// smelted from a log and burns its own share doing so, so F charcoal covers S smelts when 8F = S + F, F = S / 7.
function charcoalFor(smelts) {
  if (!(smelts > 0)) return 0;
  return Math.ceil(smelts / (FUEL_SMELT_YIELD.charcoal - 1));
}

module.exports = { FUEL_SMELT_YIELD, charcoalFor };
