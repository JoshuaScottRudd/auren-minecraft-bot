// trash — the one place that knows what a throwaway block is, what the pocket holds of it, and how it is paid for.
//
// ── WHAT TRASH IS ───────────────────────────────────────────────────────────────────────────────────────
// A block stood to be taken away again: the pillar a body climbs, the bridge it crosses, the support a
// building block is clicked onto. Trash is a PLANK. The chests hold it as logs, any species, and a cube trip
// splits its logs into planks at the yard before it leaves (makePlanks), so the trip stands planks it already
// holds. Dirt is the stand-in while the pocket holds no plank, and is passed over the moment one is there.
//
// ── WHO READS THIS ──────────────────────────────────────────────────────────────────────────────────────
// `inPocket` is the one count of a pocket's trash: the trip's preparation stocks by it (column_preparation)
// and the trip spends by it (build_column_executor). The board and the preparation ask `heldBlocks`,
// `fromBuildWood`, `shortWith` and `takeOrder` of the POOL, so the gate that posts a cube and the withdrawal
// that stocks it count the same blocks (Law 16). A cube trip asks `inHand` for each block it stands. Every
// pillar step asks `ready` before it picks a block (scaffold_movement). The waste pit asks `dirtIsSurplus`.
//
// The ORDER a pillar or bridge spends blocks in is fragment_utils' throwaway order, planks first.

'use strict';

const watcher = require('@kernel/watcher');
const { group_to_item } = require('@utils/fragment_utils');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'trash';

// One log splits into this many planks.
const PLANKS_PER_LOG = 4;
// The stand-in block while no plank and no log is held.
const STAND_IN = 'dirt';
// The chests keep STANDBY_DIRT of the stand-in on top of what the building asks, while they hold fewer than
// STANDBY_LOGS logs to make trash of.
const STANDBY_LOGS = 64;
const STANDBY_DIRT = 128;

const PLANK_NAMES = new Set(group_to_item.planks);
const LOG_NAMES = group_to_item.logs.filter(name => !name.startsWith('stripped_'));
const planksOf = log => log.replace(/_log$/, '_planks');

// isTrashBlock — is a standing block of this name something a trip may have stood as trash?
function isTrashBlock(name) {
  return PLANK_NAMES.has(name) || name === STAND_IN;
}

// The names in the order trash is spent: planks and logs of a wood the building is not made of, then the
// building's own. `buildWood` absent means no building has a claim on any species.
function woodOrder(buildWood) {
  const spare = LOG_NAMES.filter(log => !buildWood || !log.startsWith(`${buildWood}_`));
  const own = LOG_NAMES.filter(log => buildWood && log.startsWith(`${buildWood}_`));
  return { spare, own };
}

// heldBlocks(counts, buildWood) → { spare, own, dirt }: trash blocks in a {item: count} map, a log counted as
// the planks it splits into. `spare` is wood the building has no use for, `own` is the building's species.
function heldBlocks(counts, buildWood) {
  const { spare, own } = woodOrder(buildWood);
  const sum = logs => logs.reduce((n, log) => n + PLANKS_PER_LOG * (counts[log] || 0) + (counts[planksOf(log)] || 0), 0);
  return { spare: sum(spare), own: sum(own), dirt: counts[STAND_IN] || 0 };
}

// inPocket(counts, owed, buildWood) → what a pocket holds as trash, past what its holder's own work still owes
// out of it ({ item: count }). This is the one count of a pocket's trash (Law 16).
//   planks, dirt — blocks that can be stood now;   logs — logs, each still to be split;
//   ready — planks + dirt;   worth — ready plus the planks the logs would make;   past — the pocket less `owed`.
function inPocket(counts, owed, buildWood) {
  const past = { ...counts };
  for (const [item, n] of Object.entries(owed || {})) if (past[item]) past[item] = Math.max(0, past[item] - n);
  const { spare, own } = woodOrder(buildWood);
  const all = [...spare, ...own];
  const planks = all.reduce((n, log) => n + (past[planksOf(log)] || 0), 0);
  const logs = all.reduce((n, log) => n + (past[log] || 0), 0);
  const dirt = past[STAND_IN] || 0;
  return { planks, logs, dirt, ready: planks + dirt, worth: planks + dirt + PLANKS_PER_LOG * logs, past };
}

// fromBuildWood(blocks, pool, buildWood) → how many planks of the building's own wood a trash need of
// `blocks` draws, after the pool's spare wood has paid what it can. The caller adds this to the building's
// plank need, so the one material calculator prices trash with everything else.
function fromBuildWood(blocks, pool, buildWood) {
  return Math.max(0, blocks - heldBlocks(pool, buildWood).spare);
}

// shortWith(need, blocks, pool, buildWood) → { raw: count } the pool is short of, for a building need and a
// trash need of `blocks` paid together out of one pool. Spare wood pays the trash first and the building's own
// wood pays the rest as planks, priced by the building's calculator beside everything else it owes. Where
// that leaves the pool short, dirt the building does not ask for stands in for the planks; a shortfall that
// remains is returned as the calculator named it, so what gets ordered is logs.
function shortWith(need, blocks, pool, buildWood) {
  const { remainingRawInSpecies } = require('@utils/calculators/build_material_calculator');
  const planks = `${buildWood}_planks`;
  const withTrash = n => (n > 0 ? { ...need, [planks]: (need[planks] || 0) + n } : need);
  const own = fromBuildWood(blocks, pool, buildWood);
  const short = remainingRawInSpecies(withTrash(own), pool, buildWood);
  if (own === 0 || Object.keys(short).length === 0) return short;
  const spareDirt = Math.max(0, (pool[STAND_IN] || 0) - (need[STAND_IN] || 0));
  if (spareDirt === 0) return short;
  const withDirt = remainingRawInSpecies(withTrash(Math.max(0, own - spareDirt)), pool, buildWood);
  return Object.keys(withDirt).length === 0 ? withDirt : short;
}

// takeOrder(buildWood) → [[item, blocksEach]] in the order a trip draws trash from the chests: spare planks,
// spare logs, the building's own planks and logs, and the stand-in last.
function takeOrder(buildWood) {
  const { spare, own } = woodOrder(buildWood);
  return [
    ...spare.map(log => [planksOf(log), 1]),
    ...spare.map(log => [log, PLANKS_PER_LOG]),
    ...own.map(log => [planksOf(log), 1]),
    ...own.map(log => [log, PLANKS_PER_LOG]),
    [STAND_IN, 1],
  ];
}

// pillarNames(buildWood) → the block names a climb may stand under its feet, in spending order.
function pillarNames(buildWood) {
  const { spare, own } = woodOrder(buildWood);
  return [...spare.map(planksOf), ...own.map(planksOf), STAND_IN];
}

const pocketCounts = bot => {
  const counts = {};
  for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count;
  return counts;
};

// inHand(bot, buildWood, owed) → the name of a trash block the pocket holds right now, or null. Planks before
// dirt, a wood the building is not made of before its own. Nothing is made here: a cube trip's trash is split
// into planks at the yard (makePlanks) before the trip leaves.
function inHand(bot, buildWood, owed = {}) {
  const { past } = inPocket(pocketCounts(bot), owed, buildWood);
  return pillarNames(buildWood).find(name => (past[name] || 0) > 0) || null;
}

// ── TRASH THAT STAYS: THE SUPPORT OF A BLOCK THAT HANGS ─────────────────────────────────────────────────
// Trash is stood to place a block and taken back out. A block that hangs (support_plan.hangs: a lantern, a
// torch, a door) falls when its support goes, so where that support is a cell no plan owns — outside the
// building's box, a cave or a tunnel under it — the trash stood there is left standing. It is cobblestone when
// the pocket holds one past what the trip owes, as ground is put back, and the ordinary trash block otherwise.
// keptInHand(bot, buildWood, owed) → the name of that block, or null.
const KEPT_SUPPORT = 'cobblestone';
function keptInHand(bot, buildWood, owed = {}) {
  if ((pocketCounts(bot)[KEPT_SUPPORT] || 0) > (owed[KEPT_SUPPORT] || 0)) return KEPT_SUPPORT;
  return inHand(bot, buildWood, owed);
}

// ── THE SPLIT ────────────────────────────────────────────────────────────────────────────────────────────
// A pocket click is sent on this body's copy of the pocket, and the server answers with its whole copy only
// when the two differ. An answer that lands between two clicks sets this body's copy back to an earlier
// moment; a library call that reads the copy to choose its next click then skips the click that puts the
// cursor down, and the stack stays on the server's cursor where the pocket count cannot see it. So the split
// sends its own clicks, a fixed list that does not read the copy, and asks the server for the pocket
// (serverCopy) before the first click, once the logs are in the grid, and once the planks are taken.
const GRID_SLOT = 1;
const LAST_GRID_SLOT = 4;
const RESULT_SLOT = 0;
const OUTSIDE_THE_WINDOW = -999;
const SWEEP_PASSES = 3;
// How long the server's copy of the pocket is waited for.
const SERVER_COPY_MS = 5000;

// serverCopy(bot, why) → true when the server's copy of the pocket has replaced this body's. The pocket's own
// window answers only while no chest, table or furnace window is open over it.
async function serverCopy(bot, why) {
  if (bot.currentWindow) return false;
  const asked = await guardExternal(TAG, `ask the server for the pocket (${why})`, () => new Promise((resolve, reject) => {
    const late = setTimeout(() => reject(new Error(`the server did not answer in ${SERVER_COPY_MS}ms`)), SERVER_COPY_MS);
    bot._syncWindow(bot.inventory).then(() => { clearTimeout(late); resolve(); }, (err) => { clearTimeout(late); reject(err); });
  }));
  return asked.ok;
}
const click = (bot, slot, button, mode, why) => guardExternal(TAG, `pocket click on slot ${slot} (${why})`, () => bot.clickWindow(slot, button, mode));
const craftArea = bot => {
  const cursor = bot.inventory.selectedItem;
  const grid = bot.inventory.slots.slice(RESULT_SLOT, LAST_GRID_SLOT + 1).filter(Boolean).map(i => `${i.name}x${i.count}`).join(',') || 'empty';
  return `cursor=${cursor ? `${cursor.name}x${cursor.count}` : 'empty'} craft_grid=${grid}`;
};
const craftAreaEmpty = bot => !bot.inventory.selectedItem && bot.inventory.slots.slice(RESULT_SLOT, LAST_GRID_SLOT + 1).every(i => !i);

// sweepCraftArea(bot) → true when the cursor, the grid and the result slot are empty on the server's own copy.
// Each click is followed by the server's copy, so the next one is chosen off what is there. A cursor stack
// with no empty slot to land in is dropped at the body's feet.
async function sweepCraftArea(bot) {
  if (!(await serverCopy(bot, 'before the crafting area is swept'))) return craftAreaEmpty(bot);
  for (let pass = 0; pass < SWEEP_PASSES && !craftAreaEmpty(bot); pass++) {
    if (bot.inventory.selectedItem) {
      const empty = bot.inventory.firstEmptyInventorySlot();
      await click(bot, empty === null ? OUTSIDE_THE_WINDOW : empty, 0, 0, 'put the cursor down');
      await serverCopy(bot, 'after the cursor was put down');
    }
    for (let slot = GRID_SLOT; slot <= LAST_GRID_SLOT; slot++) {
      if (!bot.inventory.slots[slot]) continue;
      await click(bot, slot, 0, 1, 'move a grid stack to the pocket');
      await serverCopy(bot, 'after a grid stack was moved');
    }
  }
  return craftAreaEmpty(bot);
}

// How many planks of one name the pocket has room for: empty slots, and the space left in its stacks.
function roomFor(bot, planks) {
  const size = bot.registry.itemsByName[planks].stackSize;
  const inStacks = bot.inventory.items().filter(i => i.name === planks).reduce((n, i) => n + (size - i.count), 0);
  return bot.inventory.emptySlotCount() * size + inStacks;
}

// splitLogs(bot, log, logs, tag) → { made, reason }: up to `logs` of one species split into planks in the
// pocket grid, as many as the pocket has room for. `made` is planks counted on the server's copy; `reason` is
// null when every log asked was split.
// The split is a craft and is booked as one (item_book `craft` → `crafting`). Unnamed, its pocket change
// lands inside the item book's sticky window of the act before it, which is often the withdrawal that
// brought the logs, and the book then lays the logs and planks on that chest.
function splitLogs(bot, log, logs, tag) {
  return require('@kernel/item_book').during('craft', 'crafting', () => _splitLogs(bot, log, logs, tag));
}
async function _splitLogs(bot, log, logs, tag) {
  const planks = planksOf(log);
  const held = name => bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0);
  const state = () => `${log}=${held(log)} ${planks}=${held(planks)} ${craftArea(bot)}`;
  if (!(await serverCopy(bot, `before splitting ${log} for ${tag}`))) return { made: 0, reason: 'the server did not hand over its copy of the pocket' };
  if (!craftAreaEmpty(bot) && !(await sweepCraftArea(bot))) return { made: 0, reason: `the crafting area would not empty (${craftArea(bot)})` };
  const before = held(planks);
  const fits = Math.floor(roomFor(bot, planks) / PLANKS_PER_LOG);
  let left = Math.min(logs, held(log), fits);
  if (left <= 0) return { made: 0, reason: held(log) <= 0 ? `no ${log} in the pocket` : `no room in the pocket for ${planks}` };
  const short = left < logs ? `${left} of ${logs} ${log} split: ${fits < logs ? `the pocket has room for the planks of ${fits}` : `the pocket holds ${left}`}` : null;
  while (left > 0) {
    const stack = bot.inventory.items().filter(i => i.name === log).sort((x, y) => y.count - x.count)[0];
    if (!stack) return { made: held(planks) - before, reason: `no ${log} stack left with ${left} still to split` };
    const n = Math.min(left, stack.count);
    await click(bot, stack.slot, 0, 0, 'pick the log stack up');
    if (n === stack.count) await click(bot, GRID_SLOT, 0, 0, 'set the whole stack in the grid');
    else {
      for (let i = 0; i < n; i++) await click(bot, GRID_SLOT, 1, 0, 'set one log in the grid');
      await click(bot, stack.slot, 0, 0, 'put the rest back');
    }
    // The grid is judged on the server's copy alone; a copy that did not come is asked for once more, since
    // the body's own guess of the clicks is what a slow server leaves behind (Law 25).
    if (!(await serverCopy(bot, 'after the logs were set in the grid'))) await serverCopy(bot, 'after the logs were set in the grid, asked again');
    const set = bot.inventory.slots[GRID_SLOT];
    if (bot.inventory.selectedItem || !set || set.name !== log || set.count !== n) {
      const found = state();
      const swept = await sweepCraftArea(bot);
      watcher.warn(TAG, `SPLIT_STATE step=logs_in_grid asked=${n} found[${found}] after_sweep[${state()}] swept=${swept} (asked by ${tag})`);
      return { made: held(planks) - before, reason: `the server did not hold ${n} ${log} in the grid after the clicks` };
    }
    await click(bot, RESULT_SLOT, 0, 1, 'take every plank the grid makes');
    await serverCopy(bot, 'after the planks were taken');
    if (!craftAreaEmpty(bot)) {
      const found = state();
      const swept = await sweepCraftArea(bot);
      watcher.warn(TAG, `SPLIT_STATE step=planks_taken asked=${n} found[${found}] after_sweep[${state()}] swept=${swept} (asked by ${tag})`);
      return { made: held(planks) - before, reason: 'the grid still held wood after the planks were taken' };
    }
    left -= n;
  }
  return { made: held(planks) - before, reason: short };
}

// makePlanks(bot, buildWood, owed, blocks, tag) → { ready, made, reason }: the pocket's trash logs split until
// `blocks` trash blocks can be stood from it with no further craft. Spare wood is split before the building's
// own, and only wood past `owed`. `reason` is null when `ready` covers `blocks`.
async function makePlanks(bot, buildWood, owed, blocks, tag) {
  const { spare, own } = woodOrder(buildWood);
  let made = 0;
  let reason = null;
  for (const log of [...spare, ...own]) {
    const now = inPocket(pocketCounts(bot), owed, buildWood);
    if (now.ready >= blocks) break;
    const have = now.past[log] || 0;
    if (have <= 0) continue;
    const split = await splitLogs(bot, log, Math.min(have, Math.ceil((blocks - now.ready) / PLANKS_PER_LOG)), tag);
    made += split.made;
    if (split.reason) reason = split.reason;
  }
  const ready = inPocket(pocketCounts(bot), owed, buildWood).ready;
  return { ready, made, reason: ready >= blocks ? null : (reason || 'the pocket holds too little wood past what the trip owes') };
}

// ready(bot) — before a pillar step picks its block: a pocket holding logs and no plank gets one log split,
// so the step finds a plank at the head of its order.
async function ready(bot) {
  const items = bot.inventory.items();
  if (items.some(i => PLANK_NAMES.has(i.name) && i.count > 0)) return;
  const log = LOG_NAMES.find(name => items.some(i => i.name === name && i.count > 0));
  if (!log) return;
  const split = await splitLogs(bot, log, 1, 'pillar');
  if (split.reason) watcher.warn(TAG, `Split of ${log} for a pillar step made ${split.made} plank(s): ${split.reason}.`);
}

// dirtIsSurplus() — may a pocket's spare dirt go to the waste pit? True once the chests hold what the building
// still asks of it, plus the standby while logs are scarce. A building whose need has not been read yet
// answers false: an unread need is not a need of zero (Law 25).
function dirtIsSurplus() {
  const wanted = require('@thinking/assessors/downloaded_build').stillOrdered(STAND_IN);
  if (wanted === null) return false;
  const lens = require('@kernel/inventory_lens');
  const standby = lens.inChests('logs') >= STANDBY_LOGS ? 0 : STANDBY_DIRT;
  return lens.inChests(STAND_IN) >= wanted + standby;
}

module.exports = { PLANKS_PER_LOG, STAND_IN, isTrashBlock, heldBlocks, inPocket, fromBuildWood, shortWith, takeOrder, pillarNames, inHand, keptInHand, makePlanks, sweepCraftArea, ready, dirtIsSurplus };
