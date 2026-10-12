/*
smelt_calculator.js — when a furnace batch is done, from the timestamp it started.

Pure and stateless. Separate from the rest of production because it is the only calculator whose input
is a CLOCK: everything else answers from inventory or geometry.
*/

'use strict';

// Per-item cook duration, in milliseconds. Vanilla is 10s for every recipe this fleet smelts; the map
// lets a future recipe with a different duration be added as one row.
const SMELT_COOK_MS = { default: 10000 };

// The furnace runs load-and-leave: a start timestamp is recorded on the furnace's HQ station entry, and
// these pure functions turn it into a done-time for a later job_board sweep to poll, without a live
// timer that a crash would lose. The furnace WINDOW is still ground truth on arrival (Law 13); this only
// decides when to arrive.

function smeltCookMsPerItem(item) {
  return (SMELT_COOK_MS && SMELT_COOK_MS[item]) || (SMELT_COOK_MS && SMELT_COOK_MS.default) || 10000;
}

// smeltCompleteAt(startedAt, item, qty) → epoch ms when the whole batch finishes,
// or null if startedAt is unparseable (caller treats null as "not started/unknown").
function smeltCompleteAt(startedAt, item, qty) {
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const n = Math.max(1, qty | 0);
  return start + smeltCookMsPerItem(item) * n;
}

// isSmeltComplete(startedAt, item, qty, now?) → true once `now` (default: real now)
// has passed the batch's computed done-time. False when startedAt is unparseable.
function isSmeltComplete(startedAt, item, qty, now) {
  const done = smeltCompleteAt(startedAt, item, qty);
  if (done == null) return false;
  const t = now != null ? new Date(now).getTime() : Date.now();
  return t >= done;
}

module.exports = {
  smeltCompleteAt,
  isSmeltComplete,
};
