// fragment: column_preparation (action / downloaded-building site works)
// purpose: ONE verb — put everything one TRIP into a downloaded building needs into the pocket, finished,
//          then hand the bot to build_column_executor (Law 0). A trip is one anchor cube (and, on the
//          column's last one, the stand column's own blocks for the descent). It is preconstruction's twin for
//          the column pass: withdraw from the pool, craft what is still raw, route on.
//
// The column executor places from the pocket and nothing else: once it is under the box, the only way up
// is the column it is building, so there is no walking back to a chest halfway up. The assessor posts the
// cube only when the pool (pocket plus the build's chests) holds its material raw: logs, not stairs;
// ingots, not lanterns. Getting from a covered pool to a loaded pocket takes a withdraw and a craft.
//
// The assessor decides pool coverage with `cubeMaterials` and `remainingRawInSpecies`; this fragment asks
// exactly those two again, fresh, against the same pool chests (`buildPoolChests`) — a withdraw that
// measured differently from the gate that approved it is the claim/release loop preconstruction's header
// documents (Law 16).
//
// Finished before raw, as in preconstruction: a chest may already hold the stone, the stairs or the
// lanterns a peer made, and taking them is a craft the fleet already paid for. Only the remainder is
// taken raw and crafted here.
//
// All or nothing: a cube is entered from underneath, so a bot that runs short halfway leaves it
// part-built and the next bot pays the climb again. A pool that drained between the gate and this trip is
// a legitimate transient (Law 13, environmental): nothing is crafted, and the judge replans with the
// numbers on the readable so a shrinking shortfall never reads as a repeat.
//
// The wood is the site's: block names come through `frame.blockOf`, so an oak site asks for oak stairs.
// The craft follows the logs in hand (craft_handler picks the plank of the log it holds most of), and the
// withdraw takes the species' own logs only.

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const planRegistry = require('@kernel/downloaded_plan_registry');
const inventorySwapper = require('@api/inventory_swapper');
const { craftBatch } = require('@api/craft_handler');
const { remainingRawInSpecies, isRawMaterial, isChainOwned } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { buildPoolChests, chestItemCounts, getBotInventory, sleep } = require('@utils/fragment_utils');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');

const TAG = 'column_preparation';

// Planks and sticks are crafted LAST so a consumer (a door, a chest, a barrel) cannot eat them back below
// the column's own plank count — the order preconstruction's craft book states and for the same reason.
const BASE_INTERMEDIATES = new Set(['planks', 'stick']);

// How long a trip waits its turn at the bill desk (the foreman's `bill:` key): this many asks, this far apart.
// A body holds the key for one unawaited step, so a wait is a few peers pricing their trips ahead of it.
const BILL_DESK_TRIES = 40;
const BILL_DESK_WAIT_MS = 250;

function routeIdle(reason) {
  watcher.summary(TAG, reason);
  require('@thinking/dispatcher.js').clearMagnet();
  routeSignal(TAG, 'idle_park', { readable: `${TAG}: ${reason} → idle_park` });
}

function isPlankOrStick(item) {
  return item === 'stick' || /_planks$/.test(item) || BASE_INTERMEDIATES.has(item);
}

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before a column was prepared.`);
    }

    const botId = process.env.BOT_ID || 'default';
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    const index = magnet?.column;
    const structure = magnet?.structure;
    if (!Number.isInteger(index) || !Number.isInteger(magnet?.anchor_index) || !structure) return routeIdle('no cube on the magnet — nothing to prepare');

    const row = hq.readBuildingChair(structure, 'set_buildspot');
    const frame = planRegistry.siteFrame(row);
    if (!frame.wood) return routeIdle(`"${structure}" has no wood decided yet — the column waits on the fleet's wood preference`);

    const column = planRegistry.columns().find(c => c.column === index);
    const anchor = planRegistry.anchors()[magnet?.anchor_index];
    if (!column || !anchor || anchor.column !== index) {
      throw new Error(`[${TAG}] CODING VIOLATION: the board posted column ${index}, cube ${magnet?.anchor_index} of "${structure}", which the plan does not have as one cube of that column.`);
    }

    // The same question the assessor asked before it posted this cube (Law 16).
    const { cubeMaterials, trashOf, endsColumn } = require('@thinking/assessors/downloaded_build');
    const need = await cubeMaterials(bot, frame, column, anchor, await endsColumn(bot, frame, column, { anchor, seal: false }));
    const chests = buildPoolChests(structure);
    const lens = require('@kernel/inventory_lens');
    const trash = require('@utils/trash');

    // THE POCKET PAYS THE CUBE'S OWN BLOCKS FIRST: a held plank counts toward the cube's plank blocks, and only
    // what the pocket holds past the cube's whole need is counted as the trip's trash (STEP 5).
    const buildPocket = () => getBotInventory();

    // ── THE TRIP'S WHOLE BILL, THE CUBE AND ITS TRASH, IS PRICED BEFORE ANYTHING IS TAKEN OR MADE ────────
    // trash.shortWith is the question the board posted this cube on (Law 16), asked of the pool now and,
    // once the withdrawals are in, of the pocket alone. A craft starts only on a pocket that covers both.
    const trashNeed = trashOf(bot, frame, anchor);
    const billShort = holdings => trash.shortWith(need, trashNeed, holdings, frame.wood);
    const listOf = short => Object.entries(short).map(([raw, n]) => `${raw}:${n}`).join(', ');
    const ledger = require('@perception/chest_ledger');
    const notStaged = (why) => {
      ledger.release(null, 'cube trip not staged');
      watcher.summary(TAG, `Column ${index} of "${structure}" not staged — ${why}. Deferring to recursive_judge for restock.`);
      routeToJudge(TAG, {
        ...payload, result: 'materials_not_staged', success: false,
        readable: `${TAG}: column ${index} not staged — ${why} -> recursive_judge`,
      });
    };
    const priced = () => {
      const poolShort = billShort(lens.buildPool(structure));
      return Object.keys(poolShort).length
        ? `the pool is short ${listOf(poolShort)} for cube ${anchor.index} and its ${trashNeed} trash block(s); nothing taken` : null;
    };
    const unpaid = priced();
    if (unpaid) return notStaged(unpaid);

    // What the build's chests hold of one item that no other body has claimed (chest_ledger).
    const freeInChests = item => Math.max(0,
      chests.reduce((n, { station }) => n + countInInventory(item, chestItemCounts(station)), 0) - ledger.claimedByOthers(item));

    // ── STEP 1: what the pool already holds FINISHED is taken first ───────────────────────────────────
    let pocket = buildPocket();
    const withdrawalsFor = () => {
      const take = {};
      const stillToMake = {};
      for (const [item, count] of Object.entries(need)) {
        const gap = count - countInInventory(item, pocket);
        if (gap <= 0) continue;
        const inChests = freeInChests(item);
        const taken = Math.min(gap, inChests);
        if (taken > 0) take[item] = taken;
        if (gap - taken > 0) stillToMake[item] = count - taken;   // the raw walk nets the pocket itself
      }
      // ── STEP 2: the raw for whatever is left, in the site's wood ───────────────────────────────────
      for (const [raw, count] of Object.entries(remainingRawInSpecies(stillToMake, pocket, frame.wood))) {
        take[raw] = (take[raw] || 0) + count;
      }
      return take;
    };
    let toWithdraw = withdrawalsFor();

    // ── A WITHDRAWAL NEEDS A FREE SLOT TO LAND IN ───────────────────────────────────────────────────
    // Each kind this trip takes may need a slot of its own, so a pocket with fewer free slots than kinds is
    // banked into the pool first and the trip's withdrawals are read again off the emptied pocket.
    const freeSlots = () => bot.inventory.emptySlotCount();
    if (freeSlots() < Object.keys(toWithdraw).length) {
      watcher.summary(TAG, `Column ${index}: ${freeSlots()} free slot(s) for ${Object.keys(toWithdraw).length} kind(s) to withdraw — banking the pocket first.`);
      const banked = await inventorySwapper.dumpExcess(bot);
      if (banked && banked.abandoned) return;   // a signal is already with the judge (Law 15)
    }

    // ── ONE BODY AT A TIME READS THE CHESTS AGAINST THE CLAIMS AND FILES ITS OWN ─────────────────────────
    // The foreman grants `bill:<building>` to one body. From the grant to the release below nothing is awaited:
    // the pool is priced, every line is found, the trash is planned and the claim is published in one step,
    // so the next body granted the key reads this body's claim before it prices its own trip.
    const link = require('@kernel/foreman_link');
    const billKey = `bill:${structure}`;
    let atDesk = false;
    for (let tries = 1; tries <= BILL_DESK_TRIES && !atDesk; tries++) {
      atDesk = (await link.requestClaim(billKey)).granted;
      if (!atDesk) await sleep(BILL_DESK_WAIT_MS);
    }
    if (!atDesk) return notStaged(`the bill desk for "${structure}" was held by peers for ${BILL_DESK_TRIES * BILL_DESK_WAIT_MS} ms; nothing taken`);
    const refused = (why) => { link.releaseClaim(billKey); return notStaged(why); };
    const unpaidNow = priced();
    if (unpaidNow) return refused(unpaidNow);
    pocket = buildPocket();
    toWithdraw = withdrawalsFor();

    // ── STEP 3: EVERY LINE OF THE TRIP IS FOUND IN THE CHESTS, UNCLAIMED, BEFORE ONE IS TAKEN ────────────
    // The cube's withdrawals first, then the trash the pocket will still lack once they are in it, planned in
    // the order utils/trash draws it and out of what the withdrawals leave. A line the chests cannot hand over
    // ends the trip here, with nothing taken and nothing made.
    const lines = Object.entries(toWithdraw).filter(([item, want]) => freeInChests(item) < want)
      .map(([item, want]) => `${item} ${freeInChests(item)}/${want}`);
    if (lines.length) {
      watcher.summary(TAG, `STAGING_SHORT column=${index} cube=${anchor.index} short=${lines.join(', ')} need=${JSON.stringify(need)} to_withdraw=${JSON.stringify(toWithdraw)}`);
      return refused(`the chests hold too little unclaimed: ${lines.join(', ')}; nothing taken`);
    }
    const lackOf = short => Object.entries(short).reduce((n, [raw, k]) => n + k * (/_log$/.test(raw) ? trash.PLANKS_PER_LOG : 1), 0);
    const stocked = { ...pocket };
    for (const [item, n] of Object.entries(toWithdraw)) stocked[item] = (stocked[item] || 0) + n;
    // The plan is complete when the board's own question (billShort) finds nothing short in the pocket as it
    // will stand with the withdrawals and the planned trash in it (Law 16).
    const trashTake = {};
    const planned = () => {
      const view = { ...stocked };
      for (const [item, n] of Object.entries(trashTake)) view[item] = (view[item] || 0) + n;
      return view;
    };
    let stillShort = billShort(stocked);
    for (const [item, each] of trash.takeOrder(frame.wood)) {
      if (!Object.keys(stillShort).length) break;
      const n = Math.min(Math.ceil(lackOf(stillShort) / each), freeInChests(item) - (toWithdraw[item] || 0));
      if (n <= 0) continue;
      trashTake[item] = n;
      stillShort = billShort(planned());
    }
    if (Object.keys(stillShort).length) {
      return refused(`the chests hold too little unclaimed trash for cube ${anchor.index}: still short ${listOf(stillShort)} with ${JSON.stringify(trashTake)} planned (trip trash ${trashNeed}); nothing taken`);
    }

    // ── THE TRIP'S WHOLE BILL IS CLAIMED BEFORE THE FIRST WITHDRAWAL ────────────────────────────────────
    // Every other body's pool is the chests less this claim from here until the trip is staged or refused
    // (chest_ledger: the claim rides the magnet and is published to the fleet).
    const bill = { ...toWithdraw };
    for (const [item, n] of Object.entries(trashTake)) bill[item] = (bill[item] || 0) + n;
    const billLines = Object.entries(bill).sort((a, b) => b[1] - a[1]);
    if (billLines.length) {
      const at = ledger.stationHolding(billLines[0][0]) || (chests[0] && chests[0].id);
      ledger.claim(at, billLines.map(([item, amount]) => ({ item, amount })));
    }
    link.releaseClaim(billKey);

    // From the first withdrawal on, the pocket may hold made goods of a cube that is not built yet.
    require('@api/waste_pit').cubeTripUnbuilt();

    const short = [];
    for (const [item, want] of Object.entries(toWithdraw)) {
      const sources = [];
      let available = 0;
      for (const { id, station } of chests) {
        const n = countInInventory(item, chestItemCounts(station));
        if (n > 0) { sources.push({ id, n }); available += n; }
      }
      if (available < want) { short.push(`${item} ${available}/${want}`); continue; }
      sources.sort((a, b) => b.n - a.n);
      let remaining = want;
      for (const { id, n } of sources) {
        if (remaining <= 0) break;
        const result = await inventorySwapper.retrieveItems(bot, item, Math.min(n, remaining), id);
        if (!result) return;   // abandoned to the judge (Law 15) — this line is dead
        remaining -= (result.transferred || 0);
      }
      // The chests held it and the window moved less: the cause is the pocket, and the count of free slots says so.
      if (remaining > 0) short.push(`${item} ${want - remaining}/${want} (chests held ${available}, ${freeSlots()} free slot(s) in the pocket)`);
    }
    if (short.length) {
      const list = short.join(', ');
      watcher.warn(TAG, `CLAIMED_LINE_NOT_HANDED_OVER column=${index} cube=${anchor.index} short=${list} to_withdraw=${JSON.stringify(toWithdraw)}. The chests were read as holding it unclaimed before the claim.`);
      return notStaged(`claimed and not handed over: ${list}`);
    }
    // The cube's material is in the pocket; the claim that stays is the trash, drawn after the crafts (STEP 6).
    const trashLines = Object.entries(trashTake).sort((a, b) => b[1] - a[1]);
    if (trashLines.length) ledger.claim(ledger.stationHolding(trashLines[0][0]) || (chests[0] && chests[0].id), trashLines.map(([item, amount]) => ({ item, amount })));
    else ledger.release(null, 'cube material withdrawn');

    // ── STEP 4: craft the finished blocks, whole order or none of it ─────────────────────────────────
    // A furnace product (stone, glass, charcoal) is never crafted here: it was withdrawn finished above or
    // the pool was short of it, and the smelt that makes it belongs to assessors/furnace.
    pocket = buildPocket();
    const craftNeed = {};
    for (const [item, count] of Object.entries(need)) {
      if (isRawMaterial(item) || isChainOwned(item)) continue;
      const still = count - countInInventory(item, pocket);
      if (still > 0) craftNeed[item] = count;   // the raw walk nets the pocket itself
    }
    const craftShort = remainingRawInSpecies(craftNeed, pocket, frame.wood);
    if (Object.keys(craftShort).length) {
      const list = Object.entries(craftShort).map(([r, n]) => `${r}:${n}`).join(', ');
      watcher.warn(TAG, `Column ${index}: ingredients missing for ${Object.keys(craftNeed).join(', ')} — short ${list}. Crafting nothing.`);
      ledger.release(null, 'cube trip not staged');
      routeToJudge(TAG, {
        ...payload, result: 'materials_not_staged', success: false,
        readable: `${TAG}: column ${index} cannot craft ${Object.keys(craftNeed).join(', ')} — short ${list} -> recursive_judge`,
      });
      return;
    }
    const orders = Object.entries(craftNeed)
      .sort((a, b) => (isPlankOrStick(a[0]) ? 1 : 0) - (isPlankOrStick(b[0]) ? 1 : 0))
      .map(([item]) => ({ item, quantity: need[item] }));
    if (orders.length) {
      watcher.summary(TAG, `Column ${index} crafting book: ${orders.map(o => `${o.item} x${o.quantity}`).join(', ')}`);
      const book = await craftBatch(bot, orders, payload);
      if (!book || !book.success) return;   // abandoned to the judge (Law 15) — this line is dead
    }

    // ── STEP 5: THE POCKET IS COUNTED AGAINST THE CUBE AGAIN, AND THE DIFFERENCE IS MADE ─────────────────
    // One block of the cube is often the ingredient of another in the same book: stone bricks go into stone
    // brick stairs, planks into a chest, a wood block back into planks, stone into stone bricks. The book
    // orders each at the cube's own count, so the craft that uses a block as an ingredient leaves the cube
    // short of it. The count is read off the pocket after the craft; a furnace product or a raw block comes
    // out of the chests, a crafted one is crafted again from raw the chests hand over. Twice, since the
    // second craft can eat in turn.
    for (let recount = 1; recount <= 2; recount++) {
      pocket = buildPocket();
      const lacking = Object.entries(need).filter(([item, count]) => count > countInInventory(item, pocket));
      if (!lacking.length) break;
      watcher.summary(TAG, `STAGING_RECOUNT column=${index} cube=${anchor.index} pass=${recount} lacking=${lacking.map(([item, count]) => `${item}:${count - countInInventory(item, pocket)}`).join(',')}`);
      const again = {};
      const fromChests = {};
      for (const [item, count] of lacking) {
        if (isRawMaterial(item) || isChainOwned(item)) fromChests[item] = count - countInInventory(item, pocket);
        else again[item] = count;
      }
      for (const [raw, n] of Object.entries(remainingRawInSpecies(again, pocket, frame.wood))) fromChests[raw] = (fromChests[raw] || 0) + n;
      for (const [item, n] of Object.entries(fromChests)) {
        const take = Math.min(n, freeInChests(item));
        if (take <= 0) continue;
        const got = await inventorySwapper.retrieveItems(bot, item, take);
        if (got === undefined) return;   // already with the judge (Law 15)
      }
      const reorders = Object.keys(again)
        .sort((a, b) => (isPlankOrStick(a) ? 1 : 0) - (isPlankOrStick(b) ? 1 : 0))
        .map(item => ({ item, quantity: need[item] }));
      if (!reorders.length) continue;
      const rebook = await craftBatch(bot, reorders, payload);
      if (!rebook || !rebook.success) return;   // abandoned to the judge (Law 15) — this line is dead
    }

    // ── STEP 6: THE TRIP'S TRASH IS TAKEN, AFTER EVERY CRAFT ────────────────────────────────────────────
    // Counted on what the pocket holds past the cube's own blocks — the planks a body kept from its last trip
    // pay it first — and what is lacking is drawn in the order utils/trash states: spare wood, the building's
    // wood, dirt only where the chests hold no wood for it. STEP 3 found it in the chests and it has been claimed
    // since; a count short here is said as a warning, and the made goods are banked.
    const trashCarried = () => {
      const view = buildPocket();
      for (const [item, count] of Object.entries(need)) if (view[item]) view[item] = Math.max(0, view[item] - count);
      const held = trash.heldBlocks(view, frame.wood);
      return held.spare + held.own + held.dirt;
    };
    for (const [item, each] of trash.takeOrder(frame.wood)) {
      const lack = trashNeed - trashCarried();
      if (lack <= 0) break;
      const n = Math.min(Math.ceil(lack / each), freeInChests(item));
      if (n <= 0) continue;
      const got = await inventorySwapper.retrieveItems(bot, item, n);
      if (got === undefined) return;   // already with the judge (Law 15)
    }
    const carried = trashCarried();
    watcher.summary(TAG, `TRASH_STAGED column=${index} cube=${anchor.index} carried=${carried} needed=${trashNeed} free_slots=${freeSlots()}`);
    if (carried < trashNeed) {
      watcher.warn(TAG, `TRASH_DRAINED_DURING_CRAFT column=${index} cube=${anchor.index} carried=${carried} needed=${trashNeed} claimed=${JSON.stringify(trashTake)} crafted=${orders.length}. The made goods are banked for the next trip.`);
      return notStaged(`trash ${carried}/${trashNeed} after the craft`);
    }

    ledger.release(null, 'cube trip staged');
    watcher.summary(TAG, `Column ${index} of "${structure}" staged — routing to build_column_executor`);
    routeSignal(TAG, 'build_column_executor', { ...payload, readable: `${TAG}: column ${index} staged → build_column_executor` });
  }),
};
