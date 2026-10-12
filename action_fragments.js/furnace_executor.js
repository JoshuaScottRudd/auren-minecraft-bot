// fragment: furnace_executor
// The one pathway for smelting (Law 16). Two one-shot actions, chosen by the job:
//   action='load'    — walk to a registered furnace, put an order-sized batch of input + fuel in,
//                      stamp { order, qty, input, fuel, started_at } onto the furnace's station entry,
//                      and leave without waiting out the cook.
//   action='collect' — walk to a furnace whose batch the cook-time calculator marked done, take
//                      the output, clear the order, and bank the surplus.
//
// A furnace and a chest are one fitting (Law 13, asserted below): the furnace is a shared batch
// producer, so its surplus goes through the chest to reach whichever bot asked for it. A furnace
// with no registered chest anywhere in the fleet is a broken fitting and this fragment refuses to
// run.
//
// The fleet's furnace stands in a placed blueprint that also carries a chest (headframe anchor 0:
// chest, crafting table, furnace).
//
// Load-and-leave: the furnace's `smelt` state on its HQ station entry is the reservation and the
// crash-safe record. On collect the window is ground truth (Law 13): whatever is actually in the
// furnace is taken.
//
// Nested API (Law 15): calls locomotion (goTo) to reach the furnace, and inventory_swapper
// (retrieveItems) to fetch the input. Both own their own abandonment.
//
// Input is fetched from storage, never assumed held: on hard difficulty a body is transient, so
// the executor collects the input on the way, walking chest→furnace.
//
// Fuel order (Law 13): coal → charcoal → planks, never logs. selectFuel throws if a logs-only
// state reaches here.

'use strict';

const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const stationRegistry = require('@perception/station_registry');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { retrieveItems } = require('@api/inventory_swapper');
const { group_to_item: OBJECT_GROUPS } = require('@utils/fragment_utils');
const { FUEL_PREFERENCES } = require('@thinking/architect_config');

// Smelts per unit of fuel, for sizing a batch (coal 8, plank 1.5). FUEL_PREFERENCES lives in the
// config because assessors/furnace shares the array (Law 16); this yield table has no second reader.
const FUEL_SMELT_YIELD = { coal: 8, charcoal: 8, planks: 1.5 };
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'furnace_executor';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FURNACE_BOOK_SETTLE_MS = 150;   // the pocket's slots catch up with the closed window before the item book reads them

// ── A FURNACE IS LOADED ONLY FROM ITS ORDER'S WHITELIST ──
// The recipe's `inputs` list (smeltInputsFor) is every item that makes `order`; fetch and load both take
// from it, so an item that cannot become the order never enters the input slot.
function smeltInputs(order) {
  const list = require('@kernel/crafting_blueprint_registry').smeltInputsFor(order);
  if (!list) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): "${order}" is not a furnace recipe, so no input may be loaded for it.`);
  return list;
}

// The held item with the most count among `members`, or null if none held.
function _largestHeld(bot, members) {
  let best = null;
  for (const it of bot.inventory.items()) {
    if (!members.includes(it.name)) continue;
    if (!best || it.count > best.count) best = it;
  }
  return best;
}

// A fuel token (concrete name or group like 'planks') resolved to the held item with the most count.
function resolveHeldItem(bot, token) {
  return _largestHeld(bot, OBJECT_GROUPS[token] || [token]);
}

// Waits for a freshly-opened furnace window to surface `name` in its inventory slots (the same
// slots putInput/putFuel scan) — bot.openFurnace can resolve a tick before mineflayer syncs the
// window, so putInput can throw "Can't find <item> in slots [3-39]" for an item the bot holds.
// Returns { item, waitedMs } (item null if it never surfaces); waitedMs is the window-lag diagnostic.
async function awaitWindowItem(furnace, name, timeoutMs = 1000) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  for (;;) {
    const it = furnace.items().find(i => i && i.name === name);
    if (it) return { item: it, waitedMs: Date.now() - start };
    if (Date.now() >= deadline) return { item: null, waitedMs: Date.now() - start };
    await sleep(50);
  }
}

// ── THE FLEET'S FUEL IS BANKED: COAL, THEN CHARCOAL, THEN SPARE WOOD ──
// Planks burn only when the chests hold neither coal nor charcoal, and then they are split from the logs of a
// species the building is not made of. Returns { pref, log?, count } for what the chests hold, or null.
function bankedFuel() {
  const lens = require('@kernel/inventory_lens');
  for (const pref of ['coal', 'charcoal']) {
    const count = lens.inChests(pref);
    if (count > 0) return { pref, count };
  }
  const plans = require('@kernel/downloaded_plan_registry');
  const wood = plans.isLoaded() ? plans.siteWood() : null;
  if (wood) {
    const spare = OBJECT_GROUPS.logs
      .filter(name => !name.startsWith('stripped_') && !name.startsWith(`${wood}_`))
      .map(name => ({ name, count: lens.inChests(name) }))
      .filter(l => l.count > 0)
      .sort((a, b) => b.count - a.count);
    if (spare.length) return { pref: 'planks', log: spare[0].name, count: spare[0].count };
  }
  return null;
}

const PLANKS_PER_LOG = 4;
const FURNACE_SLOTS = 3;   // input, fuel, output
const yieldOf = pref => FUEL_SMELT_YIELD[pref] || (/_planks$/.test(pref) ? FUEL_SMELT_YIELD.planks : 1);

// Puts one batch's fuel in the pocket from the chests. Returns the fuel token to burn, null when the chests
// hold none (the pocket's own fuel is used), or undefined when a step already went to the judge (Law 15).
async function fetchFuel(bot, batch, payload) {
  const banked = bankedFuel();
  if (!banked) return null;
  if (!banked.log) {
    const short = Math.ceil(batch / FUEL_SMELT_YIELD[banked.pref]) - bot.inventory.items().filter(i => i.name === banked.pref).reduce((n, i) => n + i.count, 0);
    if (short <= 0) return banked.pref;
    const got = await retrieveItems(bot, banked.pref, Math.min(banked.count, short));
    return got === undefined ? undefined : banked.pref;
  }
  // Only the planks this batch burns are made, and only the logs those planks take are fetched: what the
  // pocket already holds of either counts first.
  const planks = `${banked.log.replace(/_log$/, '')}_planks`;
  const heldOf = name => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  const short = Math.ceil(batch / FUEL_SMELT_YIELD.planks) - heldOf(planks);
  if (short <= 0) return planks;
  const logs = Math.ceil(short / PLANKS_PER_LOG);
  const fetch = Math.min(banked.count, logs - heldOf(banked.log));
  if (fetch > 0) {
    const got = await retrieveItems(bot, banked.log, fetch);
    if (got === undefined) return undefined;
  }
  const make = Math.min(logs, heldOf(banked.log));
  if (make === 0) return heldOf(planks) > 0 ? planks : null;
  const book = await require('@api/craft_handler').craftBatch(bot, [{ item: planks, quantity: make * PLANKS_PER_LOG }], payload);
  if (!book || !book.success) return undefined;
  return planks;
}

// selectFuel: first held fuel in FUEL_PREFERENCES order. Logs-only throws (Law 13).
function selectFuel(bot, preferred) {
  const order = preferred ? [preferred, ...FUEL_PREFERENCES.filter(f => f !== preferred)] : FUEL_PREFERENCES;
  for (const pref of order) {
    const item = resolveHeldItem(bot, pref);
    if (item) return { item, pref };
  }
  if (bot.inventory.items().some(i => /_log$/.test(i.name))) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): logs rejected as furnace fuel — a log and a plank smelt the same, so a log is 4× the waste; the planks standing-stock invariant was violated — craft planks first.`);
  }
  return null;
}

function _route(success, reason, extra = {}) {
  routeToJudge(TAG, {
    readable: `${TAG}: ${reason}`,
    [TAG]: { success, ...extra },
  });
}

// Abandonment (Law 15): locomotion could not deliver the bot to the furnace. Drop this line;
// the furnace state is untouched (load: nothing written yet; collect: order stays for next sweep).
function _abandon(reason) {
  watcher.warn(TAG, `Abandoning — ${reason}`);
  _route(false, reason);
}

// _reach — walks to the furnace's stance: goToStationStance resolves the blueprint anchor beside
// the furnace block, since a body cannot stand inside it. A furnace is always a blueprint voxel, so
// a failed resolve here is a real fault, surfaced to the caller's abandon path.
async function _reach(bot, pos) {
  const nav = await locomotion.goToStationStance({ x: pos.x, y: pos.y, z: pos.z });
  return !!nav.arrived;
}

// Registered chest ids — the furnace's counterpart fitting (see header). The surplus this bot
// doesn't keep goes into any one of these; a request is fleet-wide, so any chest can answer it.
function _registeredChestIds() {
  const ids = [];
  for (const [id, e] of Object.entries(stationRegistry.getStations())) {
    if (stationRegistry.isStorage(e)) ids.push(id);
  }
  return ids;
}

module.exports = {
  bankedFuel,
  receive: watcher.track(TAG, async function (signalType, payload) {
    if (signalType !== TAG) return;
    const bot = global.bot;

    const job = payload.job || {};
    const action = job.action || payload.action;

    const stationId = job.station_id;
    const where = job.where;
    if (!action || !stationId || !where) {
      // Coding violation (Law 13): job_board must post a fully-formed furnace job.
      throw new Error(`[${TAG}] CODING VIOLATION (Law 10/13): furnace job missing action/station_id/where — ${JSON.stringify({ action, stationId, where })}`);
    }

    // ── THE FURNACE/CHEST COUPLING, ASSERTED BEFORE THE WALK (Law 13) ───────────────────────────────
    // Checked only on collect: emptying a shared furnace with no registered chest to hand the batch
    // to declines loudly, `success:false`, so the judge counts the shortfall (Law 25).
    if (action === 'collect' && _registeredChestIds().length === 0) {
      const why = `declined to empty furnace ${stationId}: there is no registered chest in the fleet to hand the batch to. `
        + `Smelting is SHARED — one cook fills the whole fleet's order, so whoever empties the furnace is usually not whoever asked for the `
        + `output, and the output cannot go back into the furnace. Without a chest the emptier would walk away holding everyone's charcoal and `
        + `the next sweep would cook a second batch for it. Leaving the load in the furnace instead. `
        + `A chest needs building or rebuilding (the headframe carries one at anchor 0) — check whether one was broken.`;
      watcher.warn(TAG, why);
      return routeToJudge(TAG, {
        ...payload,
        readable: `${TAG}: ${why}`,
        [TAG]: { success: false, action, station_id: stationId, reason: 'no_registered_chest' },
        success: false,
      });
    }

    // ── FETCH THE INPUT FIRST ── before the walk, so the trip runs chest→furnace. Only when holding
    // none, never a top-up: retrieveItems abandons on a partial hold, so a short batch is left as a
    // legal outcome (qty is re-bounded by the held count below).
    // THE FUEL COMES BEFORE THE INPUT, so a log fetched to burn is planks before a log fetched to cook arrives.
    let fetchedFuel = null;
    // A load empties the furnace's three slots into the pocket, so the pocket goes to it with room for them.
    if (action === 'load' && bot.inventory.emptySlotCount() < FURNACE_SLOTS + 1) {
      const banked = await require('@api/inventory_swapper').dumpExcess(bot);
      if (banked && banked.abandoned) return;
      if (bot.inventory.emptySlotCount() < FURNACE_SLOTS) {
        _route(false, `pocket has ${bot.inventory.emptySlotCount()} free slot(s) after banking — a load needs ${FURNACE_SLOTS} to empty the furnace into`);
        return;
      }
    }
    if (action === 'load') {
      fetchedFuel = await fetchFuel(bot, job.batch_quantity || 1, payload);
      if (fetchedFuel === undefined) return;
    }
    if (action === 'load' && job.input && !_largestHeld(bot, smeltInputs(job.order))) {
      const got = await retrieveItems(bot, job.input, job.batch_quantity || 1, undefined, { only: smeltInputs(job.order) });
      // undefined means retrieveItems already routed a fresh signal to the judge (Law 15); returning
      // without routing again holds Law 4's one-signal invariant.
      if (got === undefined) return;
    }

    const pos = new Vec3(where.x, where.y, where.z);
    if (!(await _reach(bot, pos))) {
      _abandon(`locomotion could not reach furnace at (${where.x},${where.y},${where.z})`);
      return;
    }
    const block = bot.blockAt(pos);
    if (!block || block.name !== 'furnace') {
      // Environmental: the furnace was dug up between posting and arrival. Drop the stale
      // entry (Law 6 self-heal) and soft-fail so job_board re-plans from fresh world state.
      watcher.warn(TAG, `furnace gone at (${where.x},${where.y},${where.z}) — removing stale entry`);
      stationRegistry.removeStation(stationId);
      _route(false, `furnace gone at station ${stationId}`);
      return;
    }

    // ── LOAD ────────────────────────────────────────────────────────────────
    if (action === 'load') {
      const inputItem = _largestHeld(bot, smeltInputs(job.order));
      if (!inputItem) { _route(false, `none of ${smeltInputs(job.order).join('|')} on hand to smelt ${job.order}`); return; }

      const fuel = selectFuel(bot, fetchedFuel || job.fuel);   // throws on logs-only
      if (!fuel) { _route(false, `no fuel on hand to smelt ${job.order}`); return; }

      // Batch size bounded by input held, deficit, and fuel capacity (one open, walk away).
      const yieldPer = yieldOf(fuel.pref);
      const fuelUnitsForFull = Math.max(1, Math.ceil((job.batch_quantity || 1) / yieldPer));
      const fuelUnits = Math.min(fuelUnitsForFull, fuel.item.count);
      const qty = Math.max(1, Math.min(job.batch_quantity || 1, inputItem.count, Math.floor(fuelUnits * yieldPer)));

      let loadSettleMs = 0;   // how long the window took to surface the input (see awaitWindowItem)
      // Times openFurnace so rising open_ms surfaces connection/tick degradation; a timeout logs its duration.
      const openT0 = Date.now();
      let openMs = 0;
      // The whole window session is one boundary (Law 25): mineflayer's furnace object is valid only
      // between open and close, so a desync verdict is tracked separately from the guard's outcome.
      let desyncWaitedMs = null;
      const book = require('@kernel/item_book');
      await book.open();
      const loaded = await guardExternal(TAG, `furnace window (load) @ ${stationId}(${block.position.x},${block.position.y},${block.position.z})`, async () => {
        const furnace = await bot.openFurnace(block);
        openMs = Date.now() - openT0;
        // Ground truth is the window (Law 13), not the pre-open snapshot: settles for the input to
        // surface in the window's slots (mineflayer syncs a tick behind open), then loads by the
        // window's own item id — guards against a spurious not-found that job_board would respin
        // into a signal kill.
        const { item: winInput, waitedMs } = await awaitWindowItem(furnace, inputItem.name);
        if (!winInput) { furnace.close(); desyncWaitedMs = waitedMs; return; }
        // waitedMs>0 means the window lagged; 0 means it was already warm.
        loadSettleMs = waitedMs;
        // EVERY LOAD STARTS FROM AN EMPTY FURNACE: whatever the three slots hold — an earlier batch's input,
        // fuel of any kind, output nobody collected — comes out into the pocket first, and this load's own
        // input and fuel go into slots that hold nothing. What came out is the pocket's to use or bank.
        const emptied = [];
        for (const [slot, held, take] of [
          ['input', furnace.inputItem(), () => furnace.takeInput()],
          ['fuel', furnace.fuelItem(), () => furnace.takeFuel()],
          ['output', furnace.outputItem(), () => furnace.takeOutput()],
        ]) {
          if (!held) continue;
          emptied.push(`${slot}=${held.name}x${held.count}`);
          await take();
        }
        if (emptied.length) watcher.summary(TAG, `FURNACE EMPTIED before loading @ ${stationId}: ${emptied.join(' ')}`);
        await furnace.putInput(winInput.type, null, qty);
        await furnace.putFuel(fuel.item.type, null, Math.max(1, Math.ceil(qty / yieldPer)));
        furnace.close();
      });
      await sleep(FURNACE_BOOK_SETTLE_MS);
      await book.close('furnace_load', `furnace:${stationId}`);
      if (desyncWaitedMs !== null) {
        // The window never surfaced an item the bot holds — a true desync, having waited the full timeout.
        watcher.warn(TAG, `furnace window never surfaced ${inputItem.name} (held ${inputItem.count}) after ${desyncWaitedMs}ms — releasing to replan`);
        _route(false, `furnace window desync: ${inputItem.name} not visible after ${desyncWaitedMs}ms`);
        return;
      }
      if (!loaded.ok) {
        watcher.warn(TAG, `WINDOW furnace-load @ ${stationId} — the window session FAILED after ${Date.now() - openT0}ms`);
        _route(false, `furnace load failed: ${loaded.reason}`);
        return;
      }

      stationRegistry.setSmeltState(stationId, {
        order: job.order, qty, input: inputItem.name, fuel: fuel.item.name,
        started_at: new Date().toISOString(),
        locked_by: process.env.BOT_ID || 'default',
      });
      // window_settle=Nms: diagnostic for how long the window lagged.
      watcher.summary(TAG, `WINDOW furnace-load @ ${stationId}: ${qty}x ${job.order} — openFurnace OK in ${openMs}ms (input=${inputItem.name}, fuel=${fuel.item.name}, window_settle=${loadSettleMs}ms) — leaving`);
      _route(true, `loaded ${qty}x ${job.order} at furnace ${stationId}`, { order: job.order, qty });
      return;
    }

    // ── COLLECT ─────────────────────────────────────────────────────────────
    if (action === 'collect') {
      let taken = 0;
      const items = [];
      // Same window instrumentation as load: times openFurnace for collect-side visibility.
      const openT0 = Date.now();
      let openMs = 0;
      const book = require('@kernel/item_book');
      await book.open();
      const collected = await guardExternal(TAG, `furnace window (collect) @ ${stationId}(${block.position.x},${block.position.y},${block.position.z})`, async () => {
        const furnace = await bot.openFurnace(block);
        openMs = Date.now() - openT0;
        // Window = ground truth (Law 13): take whatever output is actually there, however much
        // the calculator predicted. Loop until the output slot is empty.
        while (true) {
          const out = typeof furnace.outputItem === 'function' ? furnace.outputItem() : null;
          if (!out) break;
          // A refused take ends the collect: the slot is still full, so the next pass finds the
          // same output and comes back for it.
          const got = await guardExternal(TAG, 'furnace takeOutput', () => furnace.takeOutput());
          if (!got.ok) break;
          taken += (got.value && got.value.count) ? got.value.count : 0;
          await sleep(60);
        }
        // Snapshot remaining input/fuel so the registry reflects reality after collect.
        const inp = typeof furnace.inputItem === 'function' ? furnace.inputItem() : null;
        const fue = typeof furnace.fuelItem === 'function' ? furnace.fuelItem() : null;
        if (inp) items.push({ name: inp.name, count: inp.count });
        if (fue) items.push({ name: fue.name, count: fue.count });
        furnace.close();
      });
      await sleep(FURNACE_BOOK_SETTLE_MS);
      await book.close('furnace_collect', `furnace:${stationId}`);
      if (!collected.ok) {
        watcher.warn(TAG, `WINDOW furnace-collect @ ${stationId} — the window session FAILED after ${Date.now() - openT0}ms`);
        _route(false, `furnace collect failed: ${collected.reason}`);
        return;
      }

      stationRegistry.clearSmeltState(stationId);
      stationRegistry.snapshotStation(stationId, items);

      // ── THE HANDOVER: KEEP THIS BOT'S SHARE, BANK THE REST ────────────────────────────────────────
      // The batch is the fleet's order, not this body's, so emptying it is only half the act: the
      // surplus must reach a chest before a peer can spend it.
      //
      // dropOffHaul is the one pathway (Law 16): owns what this bot keeps versus what goes to a
      // registered chest.
      //
      // Abandonment propagates (Law 15/Law 4): an undefined result means a signal is already routed,
      // so this line returns without routing a second one.
      if (taken > 0) {
        const dropped = await require('@api/inventory_swapper').dropOffHaul(bot);
        if (dropped?.abandoned) return;
      }

      watcher.summary(TAG, `WINDOW furnace-collect @ ${stationId}: ${taken}x ${job.order} — openFurnace OK in ${openMs}ms — order cleared, surplus banked`);
      _route(true, `collected ${taken}x ${job.order} from furnace ${stationId}`, { order: job.order, taken });
      return;
    }

    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): unknown furnace action '${action}'`);
  }),
};
