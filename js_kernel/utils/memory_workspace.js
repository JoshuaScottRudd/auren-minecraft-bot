// Temporary computation memory belongs to one fleet gate holder; budgets follow current machine headroom.
// Budgets bound owned caches and measured JS heap growth, not physical RAM residency or vendor allocations.
'use strict';

const os = require('os');
const v8 = require('v8');
const { withCleanup } = require('./external_library_guard');
const MiB = 1024 * 1024;
let activeGrant = null;
const scopes = new Set();
const releaseCaches = new Set();

function enabled() {
  const mode = require('../../foreman_config').memoryWorkspace;
  if (!['adaptive', 'off'].includes(mode)) throw new Error(`memory_workspace: unknown mode '${mode}'`);
  return mode === 'adaptive';
}

// Leave system headroom before deriving a bounded temporary allowance; grants reserve only fleet ownership.
// reservedBytes is what the holders already inside were granted and may still grow into. `full` says the
// machine can give this allowance without pressure shrinking it, which is what lets a further holder in.
function measureGrant(reservedBytes = 0) {
  const availableBytes = os.freemem();
  const totalBytes = os.totalmem();
  const headroomBytes = Math.max(256 * MiB, Math.min(1024 * MiB, totalBytes * 0.05));
  const heapHeadroom = v8.getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed;
  const fullBytes = Math.min(totalBytes / 32, heapHeadroom / 8);
  const spareShare = (availableBytes - headroomBytes - reservedBytes) / 8;
  const growthBytes = Math.floor(Math.max(4 * MiB, Math.min(fullBytes, spareShare)));
  return { availableBytes, totalBytes, headroomBytes, reservedBytes, growthBytes, cacheCells: Math.floor(growthBytes / 1024), full: spareShare >= fullBytes };
}

function enter(grant) {
  if (!grant || !Number.isSafeInteger(grant.growthBytes) || grant.growthBytes < 4 * MiB
      || !Number.isSafeInteger(grant.totalBytes) || grant.growthBytes > grant.totalBytes
      || !Number.isSafeInteger(grant.cacheCells) || grant.cacheCells < 1) {
    throw new Error('memory_workspace: grant needs a bounded growthBytes and cacheCells');
  }
  if (activeGrant) throw new Error('memory_workspace: a second grant entered over an active grant');
  activeGrant = grant;
}

function budget() {
  const sensed = measureGrant();
  if (!activeGrant) return sensed;
  // A grant is a ceiling; pressure during its use can shrink the working allowance at safe checkpoints.
  return { ...sensed, growthBytes: Math.min(activeGrant.growthBytes, sensed.growthBytes), cacheCells: Math.min(activeGrant.cacheCells, sensed.cacheCells) };
}

// Abandoned computations never return, so their collections are cleared before their owner hands off control.
function leave() {
  for (const scope of scopes) for (const clear of scope) clear();
  scopes.clear();
  activeGrant = null;
  if (enabled()) {
    const sensed = measureGrant();
    for (const trim of releaseCaches) trim(sensed.availableBytes <= sensed.headroomBytes ? 0 : sensed.cacheCells);
  }
}

async function withTemporaryMemory(work) {
  const scope = new Set();
  scopes.add(scope);
  return withCleanup('memory_workspace', 'temporary computation collections', () => work(clear => scope.add(clear)), () => {
    for (const clear of scope) clear();
    scope.clear();
    scopes.delete(scope);
  });
}

module.exports = { enabled, measureGrant, enter, leave, budget, withTemporaryMemory, onRelease: trim => releaseCaches.add(trim) };
