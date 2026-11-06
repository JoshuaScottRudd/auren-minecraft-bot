// fragment: lighting_manager (action / lighting)
// Routing head of the lighting triad and owner of the visit loop (Law 11 SPA):
//   - Sense    = lighting_integrity.scan: the dug shaft's and the basement cells' missing torches, as their designs place them.
//   - Manager  = this loop: carry the torches, take the missing torches in turn, delegate, re-read.
//   - Executor = lighting_executor.placeTorch — one torch per call (Law 15 API).
//   - Judge    = the plan holds no torch this visit can place: the network is complete, the pocket is
//                empty, or every spot left refused.
// One signal lives for the whole visit (Law 4); combat preempts at every torch boundary.
//
// It also owns the one route a torch is made by (takeTorches): the mine's trip and a cube trip ask it for their own,
// and a body under its column hangs its basement cell's torch from where it stands (lightCell).

'use strict';

const watcher = require('@kernel/watcher');
const lightingIntegrity = require('@perception/lighting_integrity');
const { placeTorch, placeInReach } = require('@action/lighting_executor');
const { combatCheckpoint } = require('@api/battle_stations');
const { retrieveItems } = require('@api/inventory_swapper');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'lighting_manager';
const TORCH_FUELS = ['coal', 'charcoal'];
const TORCHES_PER_CRAFT = 4;

// Every placement a visit is given is a shaft torch (lighting_integrity.scan), so a visit is the same by day and night.
const visitPlan = (bot) => lightingIntegrity.scan(bot);

const torchesHeld = (bot) => bot.inventory.items().filter(i => i && i.name === 'torch').reduce((n, i) => n + (i.count || 0), 0);

// ── TORCHES ARE MADE WHOLE OR NOT AT ALL ────────────────────────────────────────────────────────────
// canMakeTorches(bot, need, opts) → { ok, crafts, fuel, wood, fuelShort }: whether this body holds `need`, or can craft all the
// rest now from the fuel in its pocket and the chests' unclaimed fuel, over wood for every stick (two planks make four
// sticks, a log eight). Cooking the difference is the furnace's work, so nobody walks to the chests for a part of a trip.
// A stick's recipe is read kind by kind: one oak and one birch plank make none.
function sticksFromPlanks(bot) {
  const kinds = new Map();
  for (const i of bot.inventory.items()) if (i && i.name.endsWith('_planks')) kinds.set(i.name, (kinds.get(i.name) || 0) + (i.count || 0));
  return [...kinds.values()].reduce((n, c) => n + Math.floor(c / 2) * 4, 0);
}
function canMakeTorches(bot, need, opts = {}) {
  const count = torchesHeld(bot);
  if (count >= need) return { ok: true, crafts: 0, fuel: 0, wood: true, fuelShort: 0 };
  const held = (test) => bot.inventory.items().filter(i => i && test(i.name)).reduce((n, i) => n + (i.count || 0), 0);
  const crafts = Math.ceil((need - count) / TORCHES_PER_CRAFT);
  const fuel = held(n => TORCH_FUELS.includes(n)) + require('@perception/chest_ledger').unclaimedOf(TORCH_FUELS);
  const log = opts.wood ? `${opts.wood}_log` : null;
  const logs = log ? held(n => n === log) + require('@kernel/inventory_lens').inChests(log) : 0;
  const sticks = held(n => n === 'stick') + sticksFromPlanks(bot) + logs * 8;
  const wood = sticks >= crafts;
  return { ok: fuel >= crafts && wood, crafts, fuel, wood, fuelShort: Math.max(0, crafts - fuel) };
}

// A body held back by fuel says how much it waits on; the furnace assessor reads it and empties a furnace mid-cook as soon as
// the clock says that much is there. A note lives one window: a body no longer asking stops holding a furnace to it.
const FUEL_WAIT_MS = 30000;
let fuelWait = null;
function noteFuelWait(crafts) {
  const now = Date.now();
  fuelWait = { crafts: fuelWait && now - fuelWait.at < FUEL_WAIT_MS ? Math.min(fuelWait.crafts, crafts) : crafts, at: now };
}
const fuelWaited = () => (fuelWait && Date.now() - fuelWait.at < FUEL_WAIT_MS ? fuelWait.crafts : 0);

// takeTorches(bot, need, purpose) — torches crafted by the body that will place them, `need` with what it already holds:
// coal first, then charcoal, from its pocket and then the chests (the charcoal row keeps the fuel), over a stick it
// holds or makes from the planks it carries. No torch is banked. A body that cannot make them all takes nothing from
// the chests, crafts nothing, goes with what it holds, and says so.
// `opts.wood`, a cube trip's site wood: a body holding no wood takes one log of it from the chests for the stick.
// Returns true, or null when a withdrawal or the craft already abandoned to the judge (Law 15).
async function takeTorches(bot, need, purpose, opts = {}) {
  const count = torchesHeld(bot);
  if (count >= need) return true;
  const can = canMakeTorches(bot, need, opts);
  if (!can.ok) {
    watcher.summary(TAG, `${purpose}: ${count}/${need} torches held and none crafted — ${can.crafts} craft(s) owed, ${can.fuel} coal or charcoal to hand${can.wood ? '' : ', too little wood for the sticks'}.`);
    return true;
  }
  const held = (test) => bot.inventory.items().filter(i => i && test(i.name)).reduce((n, i) => n + (i.count || 0), 0);
  const log = opts.wood ? `${opts.wood}_log` : null;
  if (log && held(n => n === 'stick') + sticksFromPlanks(bot) + held(n => n === log) * 8 < can.crafts) {
    if (await retrieveItems(bot, log, 1) === undefined) return null;
  }
  let fuel = held(n => TORCH_FUELS.includes(n));
  for (const source of TORCH_FUELS) {
    const want = Math.min(require('@kernel/inventory_lens').inChests(source), can.crafts - fuel);
    if (want <= 0) continue;
    if (await retrieveItems(bot, source, want) === undefined) return null;
    fuel = held(n => TORCH_FUELS.includes(n));
  }
  // A peer's take between the reading and the chest leaves a part: the fuel stays in the pocket for this body's next ask.
  if (fuel < can.crafts) {
    watcher.summary(TAG, `${purpose}: ${count}/${need} torches held and none crafted — the chests paid ${fuel} of ${can.crafts} fuel.`);
    return true;
  }
  const made = await require('@api/craft_handler').craftItems(bot, 'torch', need);
  return made === undefined ? null : true;
}

// lightCell(bot, lamps, keep) — hang a basement cell's torches (lighting_integrity.basementLamps' form) from where the
// body stands in the cell, keeping `keep` torches for the cube it is about to work. A spot that refuses is a lighting visit's.
async function lightCell(bot, lamps, keep = 0) {
  for (const p of lamps) {
    if (torchesHeld(bot) <= keep) return;
    const res = await placeInReach(bot, p);
    watcher.summary(TAG, `torch ${res.placed ? 'placed' : 'refused'} paint=${p.paint} mount=${p.mount}`
      + ` cell=(${p.x},${p.y},${p.z}) at=(${p.source.x},${p.source.y},${p.source.z}) part=${p.part}`
      + (res.placed ? '' : ` reason=${res.reason}`));
  }
}

function _finish(payload, success, readable, metrics) {
  watcher.summary(TAG, readable);
  routeToJudge(TAG, { ...payload, readable, [TAG]: { success, readable, metrics } });
}

module.exports = {
  takeTorches,
  canMakeTorches,
  noteFuelWait,
  fuelWaited,
  lightCell,
  receive: watcher.track(TAG, async function (signalType, payload = {}) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the lighting manager ran.`);
    }

    let plan = visitPlan(bot);
    if (!plan.located) return _finish(payload, false, `${TAG}: the crew has no shaft sited and no basement torch is missing`, {});
    if (plan.placements.length === 0) return _finish(payload, true, `${TAG}: nothing to light — every dug shaft torch and basement torch stands`, { placed: 0 });

    if (await takeTorches(bot, plan.placements.length, 'lighting visit') === null) return;   // abandoned to the judge
    if (torchesHeld(bot) === 0) return _finish(payload, false, `${TAG}: no torch could be made for the visit`, { planned: plan.placements.length });
    // ── THE VISIT ── The shaft's missing torches from the top down; after every torch the plan is read again from the
    // integrity keeper's verdict, so a torch a peer placed is never placed over. A torch this visit placed, or a spot
    // that refused, stays out for the rest of the visit: the keeper's verdict may not have read it yet. The plan is
    // read again after the torches are made, and a torch is looked for before the checkpoint, so a visit whose last
    // torch a digger or a peer placed meanwhile ends complete instead of being recalled by the night gate.
    plan = visitPlan(bot);
    const refused = new Map();
    const done = new Set();
    let placed = 0;
    while (torchesHeld(bot) > 0) {
      const next = plan.placements.find(p => !refused.has(`${p.x},${p.y},${p.z}`) && !done.has(`${p.x},${p.y},${p.z}`));
      if (!next) break;
      await combatCheckpoint(bot, 'light_torch');
      const res = await placeTorch(bot, next);
      // One line per planned torch, so a lens can set each torch against the paint it was planned for.
      watcher.summary(TAG, `torch ${res.placed ? 'placed' : 'refused'} paint=${next.paint} mount=${next.mount}`
        + ` cell=(${next.x},${next.y},${next.z}) at=(${next.source.x},${next.source.y},${next.source.z}) part=${next.part}`
        + (res.placed ? '' : ` reason=${res.reason}`));
      if (res.placed) { placed++; done.add(`${next.x},${next.y},${next.z}`); }
      else refused.set(`${next.x},${next.y},${next.z}`, res.reason);
      plan = visitPlan(bot);
    }

    const left = plan.placements.length;
    const why = [...refused].slice(0, 4).map(([k, r]) => `(${k}) ${r}`).join('; ');
    const readable = `${TAG}: placed=${placed} refused=${refused.size} still_planned=${left} torches_left=${torchesHeld(bot)}`
      + (why ? ` — ${why}` : '');
    // Success when the visit changed the world; a visit that placed nothing reports so, and the judge's count of
    // unchanged visits is what stops a network no body can extend.
    _finish(payload, placed > 0, readable, { placed, refused: refused.size, still_planned: left });
  }),
};
