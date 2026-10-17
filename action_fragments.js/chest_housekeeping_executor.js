// fragment: chest_housekeeping_executor (action / the fleet's chests)
// purpose: ONE PASS OF HOUSEKEEPING ON THE CHESTS — take out of them what is trash and what sits in more
//          stacks than it needs, then bank it again. The trash goes to the waste pit on the way (dumpExcess
//          discards before it deposits), and the deposit rule (inventory_swapper) fills a part stack before it
//          starts another, so what comes back takes the fewest slots it can.
//
// A pass is bounded: CHEST_HOUSEKEEPING.moves_per_pass stacks at most, and no more than the pocket has free
// slots for. The chests are in use by every other body the whole time, so the job is one body, one pass,
// then the board is read again.
//
// `plan()` is the one reading of what there is to do; the assessor posts on it and this pass works from it.

'use strict';

const watcher = require('@kernel/watcher');
const stationRegistry = require('@perception/station_registry');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'chest_housekeeping_executor';

function _route(success, reason, extra = {}) {
  routeToJudge(TAG, { readable: `${TAG}: ${reason}`, [TAG]: { success, ...extra } });
}

// The part stacks a pass took and banked without freeing a slot, by chest and item: left where they are for
// the rest of this body's life.
const _uncombined = new Set();

// plan — every chest's slots, and the takes that free some: an item on the waste pit's list or made to order
// (all of it), and the
// part stacks of an item the fleet's chests hold in more part stacks than its loose count needs (a withdrawal
// takes the smallest stacks first, so the count of a chest's part stacks takes exactly those). Trash first,
// then the smallest part stacks: the fewest items carried per slot freed.
function plan() {
  if (!require('@thinking/requested_work').activeWorkRequirements().includes('chest_housekeeping')) {
    return { slots: 0, used: 0, share: 0, takes: [] };
  }
  const { WASTE_PIT, SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');
  const { chestKeeps, madeGoodOrdered, stands } = require('@api/waste_pit');
  // Trash is taken out of a chest only for a pit that stands: before that it would be banked straight back.
  const pitStands = stands(global.bot);
  const madeSeen = new Map();   // made-to-order thing → how many the chests read so far are keeping
  const itemsByName = require('minecraft-data')(SERVER_MINECRAFT_VERSION).itemsByName;
  const stackOf = name => (itemsByName[name] && itemsByName[name].stackSize) || 64;
  const trash = new Set(WASTE_PIT.items.filter(item => item !== 'wooden_pickaxe'));
  let slots = 0, used = 0;
  const takes = [];
  const parts = [];
  for (const chest of stationRegistry.findChests()) {
    const items = Array.isArray(chest.items) ? chest.items : [];
    slots += chest.capacity || 27;
    used += items.length;
    const byItem = new Map();
    for (const it of items) {
      const row = byItem.get(it.name) || { count: 0, stacks: 0, partCount: 0, partStacks: 0 };
      row.count += it.count || 0;
      row.stacks++;
      if ((it.count || 0) < stackOf(it.name)) { row.partCount += it.count || 0; row.partStacks++; }
      byItem.set(it.name, row);
    }
    for (const [item, row] of byItem) {
      if (trash.has(item)) {
        if (pitStands) takes.push({ chest: chest.id, pos: chest.pos, item, count: row.count, stacks: row.stacks, why: 'trash', stray: false });
      } else if (!chestKeeps(item)) {
        if (!pitStands) continue;
        // A made-to-order thing stays in the chests up to what the building still asks for; the count past it is taken.
        const kept = Math.min(row.count, Math.max(0, madeGoodOrdered(item) - (madeSeen.get(item) || 0)));
        madeSeen.set(item, (madeSeen.get(item) || 0) + kept);
        const over = row.count - kept;
        if (over > 0) takes.push({ chest: chest.id, pos: chest.pos, item, count: over, stacks: Math.min(row.stacks, Math.ceil(over / stackOf(item))), why: 'trash', stray: true });
      }
      else if (row.partStacks > 0 && !_uncombined.has(`${chest.id}|${item}`)) parts.push({ chest: chest.id, pos: chest.pos, item, count: row.partCount, stacks: row.partStacks, why: 'part_stacks' });
    }
  }
  // An item's part stacks are worth taking only where the fleet holds more of them than its loose count fills.
  const loose = new Map();
  for (const p of parts) {
    const row = loose.get(p.item) || { count: 0, stacks: 0 };
    row.count += p.count;
    row.stacks += p.stacks;
    loose.set(p.item, row);
  }
  for (const p of parts) {
    const row = loose.get(p.item);
    if (row.stacks > Math.ceil(row.count / stackOf(p.item))) takes.push(p);
  }
  // What another body has claimed stays where it is: the withdrawal door would hand over none of it.
  const ledger = require('@perception/chest_ledger');
  const free = new Map();
  for (let i = takes.length - 1; i >= 0; i--) {
    const t = takes[i];
    if (!free.has(t.item)) free.set(t.item, ledger.unclaimedOf([t.item]));
    if (free.get(t.item) < t.count) takes.splice(i, 1);
    else free.set(t.item, free.get(t.item) - t.count);
  }
  takes.sort((a, b) => (a.why === b.why ? 0 : (a.why === 'trash' ? -1 : 1)) || (a.count / a.stacks) - (b.count / b.stacks));
  return { slots, used, share: slots ? used / slots : 0, takes };
}

async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  const { CHEST_HOUSEKEEPING } = require('@thinking/architect_config');
  const { retrieveItems, dumpExcess } = require('@api/inventory_swapper');

  const before = plan();
  // One pocket slot stays free: a take that splits a stack needs somewhere to set it down.
  let room = Math.min(CHEST_HOUSEKEEPING.moves_per_pass, bot.inventory.emptySlotCount() - 1);
  const done = [];
  for (const take of before.takes) {
    // A take of single-slot items can be made in part; a take of stacks is made whole.
    if (take.count === take.stacks) take.count = take.stacks = Math.min(take.count, room);
    if (take.stacks > room || take.count <= 0) continue;
    const got = await retrieveItems(bot, take.item, take.count, take.chest);
    if (got === undefined) return;                 // already abandoned to the judge (Law 15)
    room -= take.stacks;
    done.push(take);
    if (room <= 0) break;
  }
  if (!done.length) {
    _route(false, `nothing taken — ${before.takes.length} take(s) planned, none fits ${bot.inventory.emptySlotCount()} free pocket slot(s)`);
    return;
  }

  // A chest holds a made thing only while the building still asks for it: the count past that is said.
  const stray = done.filter(t => t.stray);
  if (stray.length) watcher.summary(TAG, `MADE GOODS PAST THE BUILDING'S ORDER — taken out for the pit: ${stray.map(t => `${t.item}x${t.count}`).join(', ')}`);

  const banked = await dumpExcess(bot);
  if (banked && banked.abandoned) return;          // already routed

  const after = plan();
  if (after.used >= before.used) for (const t of done) if (t.why === 'part_stacks') _uncombined.add(`${t.chest}|${t.item}`);
  const moved = done.reduce((n, t) => n + t.stacks, 0);
  const said = `HOUSEKEEPING stacks_moved=${moved} trash_takes=${done.filter(t => t.why === 'trash').length} `
    + `part_stack_takes=${done.filter(t => t.why === 'part_stacks').length} slots_used_before=${before.used} `
    + `slots_used_after=${after.used} slots=${after.slots} takes_left=${after.takes.length}`;
  watcher.summary(TAG, said);
  _route(true, said, { moved, used_before: before.used, used_after: after.used });
}

module.exports = {
  receive: watcher.track(TAG, receive),
  plan,
};
