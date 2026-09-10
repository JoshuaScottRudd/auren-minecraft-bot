// fragment: furnace_executor
// purpose: The one pathway for smelting (Law 16). Two one-shot actions, chosen by the job:
//   action='load'    — walk to a registered furnace, put an order-sized batch of input + fuel in,
//                      stamp { order, qty, input, fuel, started_at } onto the furnace's station entry,
//                      and LEAVE. The bot does not wait out the cook.
//   action='collect' — walk to a furnace whose batch the cook-time calculator says is done
//                      (job_board posted this), take the output, clear the order, and bank the surplus.
//
// A FURNACE AND A CHEST ARE ONE FITTING, NOT TWO — the coupling this file's Law 13 assertion enforces.
// The furnace is a BATCH producer and a SHARED one: two bots wanting twelve torches each want six
// charcoal between them, and one cook makes all six because the station's cost is paid per cycle, not
// per item. That only works if the emptier can put down what is not its own — output cannot go back in
// the furnace, and a bot that must hold a peer's half of the batch would have to hoard it until the peer
// found the body, which is not a handover any part of this system performs. THE CHEST IS THE HANDOVER,
// and it needs no handover machinery because banking and withdrawing already exist. Remove the chest and
// the batch has nowhere to land: the emptier walks away holding six charcoal, the asker's demand still
// reads unmet, and the next sweep sizes another cook for material already in a pocket. So a furnace with
// no registered chest anywhere in the fleet is not a degraded configuration to work around — it is a
// broken one, and this fragment throws on it rather than performing half of a two-part act.
//
// THERE IS NO POCKET FURNACE AND NO FIELD FURNACE. A bot may not set a spare furnace down on the ground
// to smelt beside; the only furnace this fleet uses is one standing in a placed blueprint that also
// carries a chest (headframe anchor 0: chest, crafting table, furnace). That is the same rule read from
// the other end — a furnace on open ground has no chest coupled to it, so every batch it cooks is
// unshareable by construction, and the `place`/field-recovery route that used to exist here could only
// ever produce that state. Deleted rather than gated: a route that is illegal in every case is not a
// route with a condition on it (Law 16).
//
// WHY load-and-leave (Architect rev-4): standing at a furnace for a 10s/item cook is idle time,
// and a crash mid-wait strands the bot. Here the furnace's `smelt` state on its HQ station entry
// is the reservation AND the crash-safe record (on disk) — no live timer, no magnet lock. The
// window is still ground truth on collect (Law 13): whatever is actually in the furnace is taken,
// the calculator only decided WHEN to come back.
//
// NESTED API (Law 15): calls locomotion (goTo) to reach the furnace, and inventory_swapper
// (retrieveItems) to fetch the input. Both own their own abandonment; this fragment adds no retry of
// either (Law 15 failure ownership — an outer API must not duplicate an inner one's handling).
//
// THE INPUT IS FETCHED FROM STORAGE, NEVER ASSUMED TO BE IN THE POCKET. On hard difficulty a body is
// transient: anything a bot carries is lost on a death that may come at any moment, and recovering it
// means finding a death pile. A chest is not transient. So the smelt chain keeps its prerequisite in
// the fleet's storage and the executor collects it on the way, which is why a load walks chest→furnace
// rather than straight to the block. The alternative — a standing pocket reserve of input — makes the
// chain's readiness a property of one body's luck, and re-creates the failure where deleting the stock
// row that kept that reserve silently disables smelting from two files away.
//
// Fuel (Law 13): fuel preference is coal → charcoal → planks, never logs (a log and a plank smelt
// the same, so a log is 4× the waste). job_board only posts a load once a preferred fuel is on
// hand, so a logs-only state never reaches here; if it somehow does, selectFuel throws.

'use strict';

const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const stationRegistry = require('@perception/station_registry');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { retrieveItems } = require('@api/inventory_swapper');
const { group_to_item: OBJECT_GROUPS } = require('@utils/fragment_utils');
const { FUEL_PREFERENCES, FUEL_SMELT_YIELD } = require('@thinking/architect_config');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'furnace_executor';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Resolve a token (concrete name or group like 'logs'/'planks') to the held mineflayer item
// with the most count, or null if none held.
function resolveHeldItem(bot, token) {
  const members = OBJECT_GROUPS[token] || [token];
  let best = null;
  for (const it of bot.inventory.items()) {
    if (!members.includes(it.name)) continue;
    if (!best || it.count > best.count) best = it;
  }
  return best;
}

// Wait for a freshly-opened furnace window to surface `name` in its inventory portion (the slots
// putInput/putFuel scan). WHY: bot.openFurnace resolves a tick before mineflayer syncs the window's
// inventory slots, so putInput can throw "Can't find <item> in slots [3-39]" for an item the bot
// plainly holds — a transient desync, not a missing item. Polling furnace.items() (the same slot
// range putInput scans) until it appears turns that race into a short settle. Returns { item, waitedMs }
// (item null if it never surfaces) — waitedMs is the diagnostic that PROVES the race: >0 means the
// window really did lag and this settle is what stopped the spurious load failure (Law 5 summary),
// 0 means the item was already visible (fix was a no-op this time). Verifying-this-worked telemetry.
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

// selectFuel: first held fuel in FUEL_PREFERENCES order. Logs-only is a Law 13 throw (the planks
// standing-stock invariant was broken — craft planks, 4× more efficient than a log).
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

// _reach — go and stand where this furnace is meant to be worked from.
//
// THIS FUNCTION IS WHERE THE ARCHITECT WATCHED A BOT JUMP AT A FURNACE (2026-08-31: *"wierd thing
// happening when the bot tries to use furnace and isnt on the same level it tried to jump to it and just
// jumps in place"*). The goal was a BARE COORDINATE, which locomotion reads as a STAND-HERE order — put
// your feet in that cell. The cell is the furnace. A body cannot stand in a furnace, so the walker pressed
// toward a cell it could never occupy and the auto-step fired against the block face: a bot hopping in
// place against the station it was already beside.
//
// NO DISTANCE TEST SURVIVES HERE, and its removal is the point rather than a tidy-up. An early return on
// "am I close enough" is a second opinion about the stance, and the whole ruling behind goToStationAnchor
// is that there is only one: the blueprint's anchor. A bot four blocks away with a clear line is NOT
// close enough — it may be outside the wall. When the body is already on the anchor the search returns an
// empty path and this costs nothing, so the check bought nothing either.
//
// A furnace is always a blueprint voxel (that is why nothing may dig one), so `no_anchor` here is a real
// fault and not a case to accommodate: false travels to the caller's abandon path with the reason logged
// by locomotion.
async function _reach(bot, pos) {
  const nav = await locomotion.goToStationAnchor({ x: pos.x, y: pos.y, z: pos.z });
  return !!nav.arrived;
}

// Every registered chest, as station ids. The furnace's counterpart fitting (see the header): the batch
// this bot does not keep goes into one of these, and the ASKER withdraws it from wherever it landed.
// A chest is a chest — there is no per-chest role or number to match an order against, because a request
// is a fleet-wide figure and the material answering it is countable in any chest.
function _registeredChestIds() {
  const ids = [];
  for (const [id, e] of Object.entries(stationRegistry.getStations())) {
    if (e && e.type === 'chest') ids.push(id);
  }
  return ids;
}

module.exports = {
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
    // Checked here rather than at the window because the trip itself is already wasted by then, and
    // checked on the COLLECT because that is the act the missing chest makes impossible: a load puts
    // material IN, an empty takes a shared batch OUT and must be able to put down what is not its own.
    //
    // A CODING VIOLATION, NOT AN ENVIRONMENTAL ONE, and the distinction is the whole reason this throws
    // instead of soft-failing. Law 13's test is "could this happen in a correctly-written system in a
    // normal world?" — and it cannot: a furnace only exists in a placed blueprint that also carries a
    // chest, so a registered furnace with no registered chest anywhere means either the blueprint was
    // authored with a furnace and no chest, or the chest half of an anchor was registered and then lost
    // while its furnace was kept. Both are faults upstream of this fragment, and both are silent — the
    // emptier would walk away holding the whole batch, the asker's demand would still read unmet, and
    // the next sweep would size a second cook for charcoal already sitting in a pocket. Soft-failing
    // would hide exactly that, once per sweep, forever.
    if (action === 'collect' && _registeredChestIds().length === 0) {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): dispatched to EMPTY furnace ${stationId} with no registered chest in the fleet. `
        + `Smelting is a SHARED, BATCHED task: one cook fills the whole fleet's order (two bots wanting 12 torches each = 6 charcoal in one load), `
        + `so whoever empties the furnace is usually not whoever asked for the output. Output cannot go back into the furnace, so the emptier must be `
        + `able to keep its own share and DUMP the rest where a peer can withdraw it — the chest IS that handover. A furnace and a chest are one `
        + `fitting: the only furnace this fleet uses stands in a placed blueprint that also carries a chest (headframe anchor 0). Fix the blueprint or `
        + `the station registration, never this assertion.`);
    }

    // ── FETCH THE INPUT FIRST (see the storage note in the header) ──────────
    // Before the walk, so the trip is chest→furnace and not furnace→chest→furnace.
    //
    // ONLY WHEN HOLDING NONE — never a top-up to the full batch. retrieveItems abandons its caller when
    // no chest holds the item, so calling it on a partial hold would kill a line of work that could have
    // smelted what the bot already carries. A short batch is a legal outcome (qty is re-bounded by the
    // held count below, and the next sweep posts the remainder); a dead execution line is not.
    if (action === 'load' && job.input && !resolveHeldItem(bot, job.input)) {
      const got = await retrieveItems(bot, job.input, job.batch_quantity || 1);
      // undefined means retrieveItems has ALREADY routed a fresh signal to the judge (Law 15). Returning
      // without routing again is what holds Law 4's one-signal invariant — the swallow that let this fall
      // through is what produced a double-route and an `acquire already pending` throw elsewhere.
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
      const inputItem = resolveHeldItem(bot, job.input);
      if (!inputItem) { _route(false, `no ${job.input} on hand to smelt ${job.order}`); return; }

      const fuel = selectFuel(bot, job.fuel);   // throws on logs-only
      if (!fuel) { _route(false, `no fuel on hand to smelt ${job.order}`); return; }

      // Batch size bounded by input held, deficit, and fuel capacity (one open, walk away).
      const yieldPer = FUEL_SMELT_YIELD[fuel.pref] || 1;
      const fuelUnitsForFull = Math.max(1, Math.ceil((job.batch_quantity || 1) / yieldPer));
      const fuelUnits = Math.min(fuelUnitsForFull, fuel.item.count);
      const qty = Math.max(1, Math.min(job.batch_quantity || 1, inputItem.count, Math.floor(fuelUnits * yieldPer)));

      let loadSettleMs = 0;   // how long the window took to surface the input (see awaitWindowItem)
      // Station-window instrumentation (Architect, long-run kill hunt): time openFurnace so a rising
      // open_ms across a run exposes connection/tick degradation, and so a windowOpen timeout is
      // logged as exactly that (which event, how long) rather than a bare mineflayer message.
      const openT0 = Date.now();
      let openMs = 0;
      // The whole window session is one boundary: mineflayer's furnace object is valid only between open
      // and close, so open/putInput/putFuel/close either all reach the server or the session is lost. A
      // desync is NOT that failure — it is a verdict the session reached — so it leaves through its own
      // variable rather than being folded into the guard's outcome (Law 25).
      let desyncWaitedMs = null;
      const loaded = await guardExternal(TAG, `furnace window (load) @ ${stationId}(${block.position.x},${block.position.y},${block.position.z})`, async () => {
        const furnace = await bot.openFurnace(block);
        openMs = Date.now() - openT0;
        // Act on the window's ground truth, not the pre-open inventory snapshot: settle-wait for
        // the input to appear in the window's slots (mineflayer syncs them a tick behind open),
        // then load from the window's own item id. Without this the load throws a spurious
        // "Can't find <input> in slots [3-39]" that job_board respins into a 5-strike signal kill.
        const { item: winInput, waitedMs } = await awaitWindowItem(furnace, inputItem.name);
        if (!winInput) { furnace.close(); desyncWaitedMs = waitedMs; return; }
        // waitedMs>0 is the proof the sync race is real and this settle caught it; ==0 means the
        // window was already warm this time. Either way the load below now uses the window's own id.
        loadSettleMs = waitedMs;
        await furnace.putInput(winInput.type, null, qty);
        await furnace.putFuel(fuel.item.type, null, Math.max(1, Math.ceil(qty / yieldPer)));
        furnace.close();
      });
      if (desyncWaitedMs !== null) {
        // Distinguish the two desync outcomes so next run's trace says which one bit: the window
        // never surfaced an item the bot holds (true desync, waited the full timeout).
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
      // window_settle=Nms is the verification hook: on the next run, a non-zero value here (paired
      // with the ABSENCE of the old "Can't find … in slots" warn) is direct proof the sync-race fix
      // fired and caught the lag; a persistent 0 means the race isn't happening on this setup.
      watcher.summary(TAG, `WINDOW furnace-load @ ${stationId}: ${qty}x ${job.order} — openFurnace OK in ${openMs}ms (input=${inputItem.name}, fuel=${fuel.item.name}, window_settle=${loadSettleMs}ms) — leaving`);
      _route(true, `loaded ${qty}x ${job.order} at furnace ${stationId}`, { order: job.order, qty });
      return;
    }

    // ── COLLECT ─────────────────────────────────────────────────────────────
    if (action === 'collect') {
      let taken = 0;
      const items = [];
      // Same window instrumentation as load (Architect): time openFurnace so collect-side windowOpen
      // latency/timeouts are visible too — the degradation, if real, hits every furnace open.
      const openT0 = Date.now();
      let openMs = 0;
      const collected = await guardExternal(TAG, `furnace window (collect) @ ${stationId}(${block.position.x},${block.position.y},${block.position.z})`, async () => {
        const furnace = await bot.openFurnace(block);
        openMs = Date.now() - openT0;
        // Window = ground truth (Law 13): take whatever output is actually there, however much
        // the calculator predicted. Loop until the output slot is empty.
        while (true) {
          const out = typeof furnace.outputItem === 'function' ? furnace.outputItem() : null;
          if (!out) break;
          // A refused take ENDS the collect rather than retrying: the slot is still full, so the next
          // pass finds the same output and comes back for it.
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
      if (!collected.ok) {
        watcher.warn(TAG, `WINDOW furnace-collect @ ${stationId} — the window session FAILED after ${Date.now() - openT0}ms`);
        _route(false, `furnace collect failed: ${collected.reason}`);
        return;
      }

      stationRegistry.clearSmeltState(stationId);
      stationRegistry.snapshotStation(stationId, items);

      // ── THE HANDOVER: KEEP THIS BOT'S SHARE, BANK THE REST ────────────────────────────────────────
      // The batch is the FLEET's order, not this body's (assessors/furnace sizes a cook from every bot's
      // chair), so emptying it is only half the act — the surplus has to reach a chest before a peer can
      // spend it. This is the step that makes the shared furnace shared, and it is why this fragment
      // refuses to run at all with no chest registered (see the Law 13 assertion above).
      //
      // dropOffHaul IS THE ONE PATHWAY (Law 16), NOT A DEPOSIT WRITTEN HERE. It already owns exactly the
      // two decisions this needs and owns them for every producing verb: what this bot KEEPS (its own
      // held order's demand, never the fleet's — keeping the fleet's would make the emptier hoard a
      // peer's charcoal indefinitely) and WHICH CHEST takes the rest (any registered one with room —
      // a request is fleet-wide, so material answering it counts wherever it lands). A deposit routed at
      // a named chest here would be a second answer to both questions.
      //
      // WHAT THIS REPLACED, so the plausible fix is not re-tried: a per-chest station lookup
      // that matched the order's stock row against a chest by blueprint-and-number and deposited the
      // whole batch there. It routed iron to a named shelf and left charcoal in the pocket entirely —
      // two policies for one act, and the charcoal half never reached a peer at all.
      //
      // Abandonment propagates (Law 15/Law 4): an undefined-carrying result means a signal is already on
      // its way to the judge, so this line must return without routing a second one.
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
