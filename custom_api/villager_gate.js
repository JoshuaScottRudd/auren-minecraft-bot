// api: villager_gate
// purpose: One fence gate between a villager home's breeding floor and its job floor, worked by a body standing still
//          in reach of it. The body reads every villager on every physics tick: the gate shuts for a baby closing on it
//          and for the first adult through, so one opening passes one adult.
//
// THE RECORD. { gate: {x,y,z}, breeding_side: {x,z}, stall: { gate: {x,y,z}, cell: {x,y,z} } }. breeding_side is the
// unit step from the gate toward the breeding floor. stall.cell is where the worker stands; its gate is left open
// until a worker with a profession stands there, so an empty stall is never shut.
//
// A STRAY NEEDS NO RECOVERY. An adult on the job floor walks home through an open gate at dusk: setGate(bot, gate, true).
//
// invariants:
//  - The gate and every villager are re-sensed on each tick (Invariant B).
//  - A record out of reach is a coding violation and throws (Law 13).

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { BLOCK_REACH } = require('@utils/fragment_utils');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');
const { VILLAGER_GATE } = require('@thinking/architect_config');

const TAG = 'villager_gate';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cellOf = c => new Vec3(c.x, c.y, c.z);
const centreOf = c => new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5);

function villagers(bot) { return Object.values(bot.entities).filter(e => e.name === 'villager' && e.position); }
function isBaby(e) { return e.metadata?.[VILLAGER_GATE.baby_metadata_slot] === true; }

// professionOf(e) → the villager's profession name without its namespace, or null when its data is unread.
function professionOf(e) {
  const data = Object.values(e.metadata || {}).find(v => v && typeof v === 'object' && 'villagerProfession' in v);
  if (!data) return null;
  const p = data.villagerProfession;
  return typeof p === 'string' ? p.replace('minecraft:', '') : p;
}
const employed = e => { const p = professionOf(e); return p !== null && p !== 'none' && p !== 0; };

function isOpen(bot, cell) {
  const read = guardExternalSync(TAG, 'read gate', () => bot.blockAt(cell)?.getProperties?.());
  return read.ok && !!read.value && String(read.value.open) === 'true';
}

// aim(bot, cell) — the look stays on the gate between uses, so a use only has to be sent.
function aim(bot, cell) { return guardExternal(TAG, 'aim at gate', () => bot.lookAt(centreOf(cell), true)); }

// setGate(bot, cell, open) → true once the world reads the gate as asked.
async function setGate(bot, gate, open) {
  const cell = cellOf(gate);
  if (isOpen(bot, cell) === open) return true;
  await aim(bot, cell);
  const used = await guardExternal(TAG, 'use gate', () => bot.activateBlock(bot.blockAt(cell)));
  if (!used.ok) return false;
  const by = Date.now() + VILLAGER_GATE.use_timeout_ms;
  while (isOpen(bot, cell) !== open) {
    if (Date.now() >= by) return false;
    await sleep(VILLAGER_GATE.poll_ms);
  }
  return true;
}

function assertReach(bot, record) {
  const eye = bot.entity.position.offset(0, bot.entity.height, 0);
  for (const g of [record.gate, record.stall.gate]) {
    if (eye.distanceTo(centreOf(g)) > BLOCK_REACH) {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): the gate at (${g.x},${g.y},${g.z}) is out of reach of the stand.`);
    }
  }
}

// hireOne(bot, record) → { hired, passed, baby_shuts, shut_gap, worker, reason }. Holds the gate for one adult and
// shuts the stall on it. The body stands still throughout. shut_gap is the nearest a baby stood to the gate's breeding
// face when the gate was asked to shut for one.
async function hireOne(bot, record) {
  assertReach(bot, record);
  const gate = cellOf(record.gate);
  const stallCell = cellOf(record.stall.cell);
  const centre = centreOf(gate);
  const out = { x: record.breeding_side.x, z: record.breeding_side.z };
  const along = e => (e.position.x - centre.x) * out.x + (e.position.z - centre.z) * out.z;
  const flat = e => Math.hypot(e.position.x - centre.x, e.position.z - centre.z);
  const already = new Set(villagers(bot).filter(e => along(e) < 0).map(e => e.id));
  const result = { hired: false, passed: 0, baby_shuts: 0, shut_gap: null, worker: null, reason: null };

  await setGate(bot, record.stall.gate, true);
  await aim(bot, gate);

  let done = false, using = false, usingSince = 0, passer = null;
  const use = () => {
    using = true; usingSince = Date.now();
    guardExternal(TAG, 'use gate', () => bot.activateBlock(bot.blockAt(gate))).then(() => { using = false; });
  };
  const onTick = () => {
    if (done) return;
    if (using && Date.now() - usingSince > VILLAGER_GATE.use_timeout_ms) using = false;
    const seen = villagers(bot);
    if (!passer) passer = seen.find(e => !isBaby(e) && !already.has(e.id) && along(e) < -VILLAGER_GATE.clear_of_gate) || null;
    const babies = seen.filter(e => isBaby(e) && along(e) > -0.5);
    const gap = babies.length ? Math.min(...babies.map(flat)) - 0.5 : Infinity;
    const open = isOpen(bot, gate);
    const wantOpen = !passer && gap > VILLAGER_GATE.baby_gap;
    if (open === wantOpen || using) return;
    if (!wantOpen && !passer) {
      result.baby_shuts++;
      if (result.shut_gap === null || gap < result.shut_gap) result.shut_gap = +gap.toFixed(2);
    }
    use();
  };

  const by = Date.now() + VILLAGER_GATE.hire_timeout_ms;
  await withCleanup(TAG, 'watch the gate', async () => {
    bot.on('physicsTick', onTick);
    while (Date.now() < by && !passer) await sleep(VILLAGER_GATE.poll_ms);
  }, () => { done = true; bot.removeListener('physicsTick', onTick); });

  await setGate(bot, gate, false);
  if (!passer) { result.reason = 'no_adult_came'; return result; }
  result.passed = 1;

  // The stall shuts on a worker, never on air: past the deadline it stays open and the caller is told.
  while (Date.now() < by) {
    const inStall = villagers(bot).find(e => !isBaby(e) && employed(e) && e.position.floored().x === stallCell.x && e.position.floored().z === stallCell.z);
    if (inStall) {
      await sleep(VILLAGER_GATE.stall_settle_ms);
      if (inStall.position.floored().x === stallCell.x && inStall.position.floored().z === stallCell.z) {
        result.hired = await setGate(bot, record.stall.gate, false);
        result.worker = inStall.id;
        if (!result.hired) result.reason = 'stall_gate_stuck';
        return result;
      }
    }
    await sleep(VILLAGER_GATE.poll_ms);
  }
  result.reason = 'no_worker_in_stall';
  watcher.summary(TAG, `An adult passed the gate at (${gate.x},${gate.y},${gate.z}) but no worker stood in its stall; the stall stays open.`);
  return result;
}

module.exports = { hireOne, setGate, isBaby, professionOf };
