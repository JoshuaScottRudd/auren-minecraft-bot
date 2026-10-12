// trash — the one place that knows what a throwaway block is, what the pocket holds of it, and how it is paid for.
//
// ── WHAT TRASH IS ───────────────────────────────────────────────────────────────────────────────────────
// A block stood to be taken away again: the pillar a body climbs, the bridge it crosses, the support a
// building block is clicked onto. Trash is a PLANK. It is carried as logs, any species, one log split into
// four planks in the pocket's own grid when the pocket holds no plank. Dirt is the stand-in while the
// pocket holds neither plank nor log, and is passed over the moment one of them is there.
//
// ── WHO READS THIS ──────────────────────────────────────────────────────────────────────────────────────
// Every pillar step asks `ready` before it picks a block (scaffold_movement). A cube trip asks `inHand` for
// each block it stands (build_column_executor). The board and the trip's preparation ask `heldBlocks`,
// `fromBuildWood` and `takeOrder`, so the gate that posts a cube and the withdrawal that stocks it count
// the same blocks (Law 16). The waste pit asks `dirtIsSurplus`.
//
// The ORDER a pillar or bridge spends blocks in is fragment_utils' throwaway order, planks first.

'use strict';

const watcher = require('@kernel/watcher');
const { group_to_item } = require('@utils/fragment_utils');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'trash';

// One log splits into this many planks.
const PLANKS_PER_LOG = 4;
// How many times one species' split is asked of the server before the next species is tried.
const SPLIT_TRIES = 3;
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

// inHand(bot, tag, buildWood, keep) → the name of a trash block the pocket holds right now, or null when it
// holds none and can make none. A held plank is named first; with none held, one log is split (Law 0: the
// split is this function's whole side effect); dirt is named only when there is neither.
// `keep` is { item: count } the caller's own work still owes out of this pocket: only what the pocket holds
// past it is trash, so a trip's planks and logs for its cube are never the block it climbs on.
async function inHand(bot, tag, buildWood, keep = {}) {
  const { spare, own } = woodOrder(buildWood);
  const count = name => bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0) - (keep[name] || 0);
  for (const log of [...spare, ...own]) if (count(planksOf(log)) > 0) return planksOf(log);
  for (const log of [...spare, ...own]) {
    if (count(log) <= 0) continue;
    const planks = planksOf(log);
    const recipe = bot.recipesFor(bot.registry.itemsByName[planks].id, null, 1, null)[0];
    if (!recipe) { watcher.warn(TAG, `No recipe splits ${log} into ${planks} in the pocket grid (asked by ${tag}).`); continue; }
    // A split the server did not carry out leaves the log where it was; it is asked again, SPLIT_TRIES in all.
    const held = name => bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0);
    for (let attempt = 1; attempt <= SPLIT_TRIES && count(log) > 0 && count(planks) <= 0; attempt++) {
      const before = held(planks);
      const split = await guardExternal(TAG, `split one ${log} into ${planks} for ${tag}`, () => bot.craft(recipe, 1, null));
      if (held(planks) > before) continue;               // the planks came; the loop test says whether any is trash
      watcher.warn(TAG, `Split of ${log} left no ${planks} in the pocket (asked by ${tag}, try ${attempt} of ${SPLIT_TRIES}): ${split.ok ? 'the craft returned and the pocket did not change' : split.reason}.`);
    }
    if (count(planks) > 0) return planks;
  }
  return count(STAND_IN) > 0 ? STAND_IN : null;
}

// ready(bot) — before a pillar step picks its block: a pocket holding logs and no plank gets one log split,
// so the step finds a plank at the head of its order.
async function ready(bot) {
  const items = bot.inventory.items();
  if (items.some(i => PLANK_NAMES.has(i.name) && i.count > 0)) return;
  if (!items.some(i => LOG_NAMES.includes(i.name) && i.count > 0)) return;
  await inHand(bot, 'pillar', null);
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

module.exports = { PLANKS_PER_LOG, STAND_IN, isTrashBlock, heldBlocks, fromBuildWood, shortWith, takeOrder, pillarNames, inHand, ready, dirtIsSurplus };
