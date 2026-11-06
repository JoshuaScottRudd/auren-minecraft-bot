// fragment: chest_housekeeping_executor (action / the fleet's chests)
// purpose: ONE PASS OF THE CHESTS' CLEAN-OUT — take out of them what is trash and what sits in more stacks than
//          it needs, throw the trash in the waste pit, and bank the rest. The deposit rule (inventory_swapper) fills a
//          part stack before it starts another, so what comes back takes the fewest slots it can.
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

// plan — every chest's slots, and the takes that free some. While more of the chests are taken than
// CHEST_HOUSEKEEPING.clean_to, one slot at a time: of every item with a slot to give, the one holding the most slots, and
// of equals the least valuable (waste_pit.valueRank). A slot is a slot, whatever count it holds. An item gives no slot its
// limit holds (waste_pit.chestLimit): its orders and one stack, so a little of everything stays. Then the part stacks of an item
// the fleet's chests hold in more part stacks than its loose count needs (a withdrawal takes the smallest stacks first,
// so the count of a chest's part stacks takes exactly those).
function plan() {
  const { CHEST_HOUSEKEEPING, SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');
  const { stands, chestLimit, valueRank } = require('@api/waste_pit');
  // Trash is taken out of a chest only for a pit that stands: before that it would be banked straight back.
  const pitStands = stands(global.bot);
  const itemsByName = require('minecraft-data')(SERVER_MINECRAFT_VERSION).itemsByName;
  const stackOf = name => (itemsByName[name] && itemsByName[name].stackSize) || 64;
  let slots = 0, used = 0;
  const fleet = new Map();      // item → { count, slots, rows: one per chest holding it }
  for (const chest of stationRegistry.findChests()) {
    const items = Array.isArray(chest.items) ? chest.items : [];
    slots += chest.capacity || 27;
    used += items.length;
    const byItem = new Map();
    for (const it of items) {
      const row = byItem.get(it.name) || { chest: chest.id, pos: chest.pos, count: 0, stacks: 0, partCount: 0, partStacks: 0 };
      row.count += it.count || 0;
      row.stacks++;
      if ((it.count || 0) < stackOf(it.name)) { row.partCount += it.count || 0; row.partStacks++; }
      byItem.set(it.name, row);
    }
    for (const [item, row] of byItem) {
      const all = fleet.get(item) || { count: 0, slots: 0, rows: [] };
      all.count += row.count;
      all.slots += row.stacks;
      all.rows.push(row);
      fleet.set(item, all);
    }
  }
  const holders = new Map([...fleet].map(([item, all]) => [item, all.slots]));

  const takes = [];
  const leaving = new Set();
  // takeOut(item, n, count) — the takes that free n of an item's slots and carry at most count of it.
  const takeOut = (item, n, count) => {
    leaving.add(item);
    for (const row of fleet.get(item).rows) {
      if (n <= 0 || count <= 0) break;
      const stacks = Math.min(row.stacks, n);
      const carried = Math.min(row.count, count, stacks * stackOf(item));
      n -= stacks;
      count -= carried;
      takes.push({ chest: row.chest, pos: row.pos, item, count: carried, stacks, why: 'trash', reason: 'chests_full' });
    }
  };
  if (pitStands) {
    let toFree = used - Math.ceil(CHEST_HOUSEKEEPING.clean_to * slots);
    const ranked = [...fleet].map(([item, all]) => {
      const limit = chestLimit(item, stackOf(item));
      const past = limit === Infinity ? 0 : all.slots - Math.ceil(limit / stackOf(item));
      return { item, all, limit, slots: all.slots, past, value: valueRank(item), taken: 0, order: Infinity };
    }).filter(r => r.past > 0);
    let order = 0;
    while (toFree > 0) {
      const open = ranked.filter(r => r.past > 0);
      if (!open.length) break;
      const r = open.sort((a, b) => b.slots - a.slots || a.value - b.value)[0];
      if (r.order === Infinity) r.order = order++;
      r.slots--; r.past--; r.taken++; toFree--;
    }
    for (const r of ranked.filter(x => x.taken > 0).sort((a, b) => a.order - b.order)) {
      // The count goes with the slots, so part stacks cannot carry the limit out with them.
      takeOut(r.item, r.taken, Math.min(r.all.count - r.limit, Math.floor(r.all.count * r.taken / r.all.slots)));
    }
  }
  // An item's part stacks are worth taking only where the fleet holds more of them than its loose count fills.
  for (const [item, all] of fleet) {
    if (leaving.has(item)) continue;
    const parts = all.rows.filter(row => row.partStacks > 0);
    const count = parts.reduce((n, row) => n + row.partCount, 0);
    const stacks = parts.reduce((n, row) => n + row.partStacks, 0);
    if (stacks <= Math.ceil(count / stackOf(item))) continue;
    for (const row of parts) {
      if (!_uncombined.has(`${row.chest}|${item}`)) takes.push({ chest: row.chest, pos: row.pos, item, count: row.partCount, stacks: row.partStacks, why: 'part_stacks' });
    }
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
  return { slots, used, share: slots ? used / slots : 0, takes, holders };
}

async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  const { CHEST_HOUSEKEEPING } = require('@thinking/architect_config');
  const { retrieveItems, dumpExcess } = require('@api/inventory_swapper');
  const { discardTrash, trashList } = require('@api/waste_pit');

  // A pocket with no slot to spare (a builder's trip leftovers) is banked first, or no take could ever fit and the
  // same empty pass repeats until recursive_judge kills it.
  if (bot.inventory.emptySlotCount() < 2) {
    const emptied = await dumpExcess(bot);
    if (emptied && emptied.abandoned) return;      // already routed
  }
  const before = plan();
  // One pocket slot stays free: a take that splits a stack needs somewhere to set it down.
  let room = Math.min(CHEST_HOUSEKEEPING.moves_per_pass, bot.inventory.emptySlotCount() - 1);
  const done = [];
  const cleanTo = Math.ceil(CHEST_HOUSEKEEPING.clean_to * before.slots);
  let freed = 0;
  for (const take of before.takes) {
    if (before.used - freed <= cleanTo) break;
    // A take of more stacks than the pocket has room for is made in part.
    if (take.stacks > room) {
      take.count = Math.floor(take.count * room / take.stacks);
      take.stacks = room;
    }
    if (take.count <= 0) continue;
    const got = await retrieveItems(bot, take.item, take.count, take.chest);
    if (got === undefined) return;                 // already abandoned to the judge (Law 15)
    room -= take.stacks;
    if (take.why === 'trash') freed += take.stacks;
    done.push(take);
    if (room <= 0) break;
  }
  if (!done.length) {
    _route(false, `nothing taken — ${before.takes.length} take(s) planned, none fits ${bot.inventory.emptySlotCount()} free pocket slot(s)`);
    return;
  }

  // What was taken as trash goes in the pit, up to what the pocket holds of it; what the pit cannot take is banked below.
  const held = name => bot.inventory.items().reduce((s, it) => s + (it.name === name ? it.count : 0), 0);
  const asked = trashList(done.filter(t => t.why === 'trash').map(t => ({ item: t.item, count: t.count, why: t.reason })));
  const toss = trashList(Object.keys(asked).map(item => ({ item, count: Math.min(asked[item], held(item)), why: asked.why[item] })).filter(r => r.count > 0));
  await discardTrash(bot, toss);

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
