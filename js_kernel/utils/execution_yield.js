// Long computations share a process-wide time budget so nested work leaves turns for packets and timers.
// The budget follows measured scheduling delay; a quiet machine spends its full slice doing useful work.
'use strict';

const { performance } = require('perf_hooks');
const MAX_SLICE_MS = 50;
const MIN_SLICE_MS = 5;
let sliceStart = performance.now();
let schedulingDelay = 0;
let pendingYield = null;

// A macrotask hands the event loop a turn without imposing a sleep on a responsive machine.
function yieldTurn(restMs) {
  if (pendingYield) return pendingYield;
  const queuedAt = performance.now();
  pendingYield = new Promise(resolve => {
    const resume = () => {
      const now = performance.now();
      const delay = Math.max(0, now - queuedAt - restMs);
      schedulingDelay = delay > schedulingDelay ? delay : schedulingDelay * 0.8;
      sliceStart = now;
      pendingYield = null;
      resolve();
    };
    if (restMs > 0) setTimeout(resume, restMs);
    else setImmediate(resume);
  });
  return pendingYield;
}

// Call only between complete work units; ownership transitions and immediate safety checks remain indivisible.
function makeExecutionPacer(opts = {}) {
  const sliceMs = Math.max(1, opts.sliceMs ?? MAX_SLICE_MS);
  const restMs = Math.max(0, opts.restMs ?? 0);
  const bot = opts.bot || null;
  const combatEveryMs = Math.max(0, opts.combatEveryMs ?? 500);
  let lastCombatAt = performance.now();
  return function pace() {
    const budget = Math.min(sliceMs, Math.max(MIN_SLICE_MS, MAX_SLICE_MS / (1 + schedulingDelay / 10)));
    if (!pendingYield && performance.now() - sliceStart < budget) return Promise.resolve();
    return yieldTurn(restMs).then(() => {
      if (!bot || performance.now() - lastCombatAt < combatEveryMs) return;
      lastCombatAt = performance.now();
      // The body's existing checkpoint owns preemption and its shared threat-poll clock (Law 15).
      return require('@api/battle_stations').combatCheckpoint(bot, opts.source || null);
    });
  };
}

// Bulk perception composes its declared reader with the same pacer used by planning and execution.
function makeVoxelScan(bot, opts = {}) {
  const reader = require('@utils/voxel_reader').makeVoxelReader(bot, opts);
  const pace = makeExecutionPacer(opts.combatGate === false
    ? { sliceMs: opts.sliceMs, restMs: opts.restMs }
    : { sliceMs: opts.sliceMs, restMs: opts.restMs, bot, source: opts.source || 'voxel_scan' });
  return Object.assign(Object.create(reader), { pace, reader });
}

module.exports = { makeExecutionPacer, makeVoxelScan };
