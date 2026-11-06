// fragment: cull_executor (action / ranching) — a LIBRARY: cull_manager owns the job and calls cullPen().
// purpose: Slaughters a full meat pen's grown animals past its breeding stock and picks up the meat and hide. One verb:
// cull the penned flock (Law 0).
//
// THE CULLER IS A TENDER (@api/pen_gate owns the pen's geometry, the gate, the standby cell, the shepherd's post and the
// tending board), entering as the shearer does (shear_executor): standby, a shepherd holding the flock, the gate
// claimed, in from the lineup cell with the gate shut behind it. Inside, with its best weapon in hand
// (combat_utils.equipBestWeapon), it asks the server which penned animals are grown (pen_gate.askBreeding: Age 0 or
// more; a lamb's is below 0) and strikes the nearest grown one until it is gone, then the next, up to the count the
// job names. Every swing goes through combat_utils.swingNow, so the reach and the weapon's charge are the combat
// code's. Then it sweeps the whole pen for the drops (sweepPen). It ends inside the pen holding the gate and the
// standby cell; leaving is pen_gate.leavePen's, called by the manager.
//
// invariants:
//  - Every animal is re-sensed by entity id before each swing (Invariant B); one gone is counted culled only once the
//    server no longer lists it, never guessed.
//  - Which animals are grown is the server's word; a lamb is never struck.
//  - A STRANGER CULL (assessors/ranching cull_stranger) names the other pens' animals inside this fence by id: those
//    are struck, grown or not, and none of the pen's own.

'use strict';

const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { penGeometry, insidePen, penned, holdGate, releaseGate, enterPen, tendingCells, tryPark, releasePark, shepherdSeen, awaitShepherd, sayPhase, askBreeding, writeStrangerMiss } = require('@api/pen_gate');
const { standOn } = require('@action/herd_executor');
const { HERDING } = require('@thinking/architect_config');
const combat = require('@utils/combat_utils');
const { withCleanup } = require('@utils/external_library_guard');

const TAG = 'cull_executor';
const POLL_MS = 50;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const feetOf = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const PRODUCE = /^(beef|cooked_beef|leather|mutton|cooked_mutton|porkchop|cooked_porkchop|.*_wool)$/;
const produceHeld = bot => bot.inventory.items().filter(i => PRODUCE.test(i.name)).reduce((n, i) => n + i.count, 0);
// The hide in the picked-up produce, counted apart: the leather a cow pen exists for.
const leatherHeld = bot => bot.inventory.items().filter(i => i.name === 'leather').reduce((n, i) => n + i.count, 0);

// cullOne(bot, geo, id, choice, { freeRange }) → true once the animal is gone from the pen: struck at the weapon's full
// charge while in reach, walked to while out of it (up to HERDING.strike_walks walks), passed by after
// HERDING.strikes_max strikes or HERDING.strike_ms_max. `freeRange`: the animal stands outside any pen (a herder's
// animal it could not lead, herd_executor), so leaving the pen does not end the strike.
async function cullOne(bot, geo, id, choice, { freeRange = false } = {}) {
  const started = Date.now();
  let walks = 0, strikes = 0, swingsRefused = 0;
  // A pass-by is said with its reason, the strikes landed and the distance it ended at, so a cull that kills nothing
  // says why (Law 13).
  const passed = (why, e) => {
    const d = e && e.position ? combat.swingDistance(bot, e) : null;
    watcher.warn(TAG, `CULL_PASSED id=${id} why=${why} strikes=${strikes} swings_refused=${swingsRefused} walks=${walks} dist=${d === null ? '-' : d.toFixed(1)} `
      + `at=${e && e.position ? `${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}` : '-'} body=${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)} s=${Math.round((Date.now() - started) / 1000)}`);
    return false;
  };
  let e = null;
  while (Date.now() - started < HERDING.strike_ms_max) {
    e = bot.entities[id];
    if (!e || e.isValid === false || !e.position) return true;
    if (!freeRange && !insidePen(geo, e.position)) return passed('left_the_pen', e);
    if (combat.swingDistance(bot, e) > combat.BOT_STRIKE_REACH) {
      if (walks++ >= HERDING.strike_walks) return passed('out_of_reach_after_walks', e);
      await locomotion.goTo({ ...feetOf(e.position), spare_builds: true, leg: 'work' });
      continue;
    }
    if (strikes >= HERDING.strikes_max) return passed('strikes_max', e);
    if (combat.chargeNow(choice.profile.cooldownMs) >= 1) {
      if (combat.swingNow(bot, e, TAG)) strikes++; else swingsRefused++;
    }
    await sleep(POLL_MS);
  }
  return passed('strike_ms_max', e);
}

// THE WHOLE PEN IS SWEPT: a cull's drops lie wherever its animals fell, and drop_collector.collectNearby reaches 8 blocks
// from where the body stands, so the sweep walks to the nearest drop still inside the fence and collects around it, up to
// SWEEP_WALKS walks.
const SWEEP_WALKS = 8;
// sweepPen(bot, geo) → the dropped items still inside the fence when it ends.
async function sweepPen(bot, geo) {
  const collector = require('@api/drop_collector');
  const dropsIn = () => Object.values(bot.entities).filter(e => e && e.position && collector.isDroppedItemEntity(e) && insidePen(geo, e.position));
  for (let walks = 0; walks < SWEEP_WALKS; walks++) {
    await collector.collectNearby(bot);
    const left = dropsIn().sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (!left.length) return 0;
    await locomotion.goTo({ ...feetOf(left[0].position), spare_builds: true, leg: 'work' });
  }
  return dropsIn().length;
}

// work(bot, geo, m, clock, botId, count): the culler's part, standby to the drops picked up → fault or null.
async function work(bot, geo, m, clock, botId, count, strangers) {
  const cells = tendingCells(bot, geo);
  if (!cells) return 'no_tending_cells';
  m.park = cells.park;
  clock.to('walk');
  sayPhase(geo, botId, 'culler', 'en_route');
  if (!(await tryPark(geo, botId))) return 'standby_held_by_a_peer';
  m.parkHeld = true;
  // The culler is posted only to a body within sight of the pen: its walk is short, so the shepherd is called now.
  sayPhase(geo, botId, 'culler', 'near');
  const nav = await locomotion.goTo({ x: cells.park.x, y: cells.park.y, z: cells.park.z, spare_builds: true, leg: 'work' });
  if (!nav || nav.arrived === false) return 'route_to_standby_failed';
  await standOn(bot, cells.park, m, 'standby');
  sayPhase(geo, botId, 'culler', 'standby');
  clock.to('shepherd_wait');
  m.shepherd = await awaitShepherd(bot, geo, botId, HERDING.gate_wait_ms);
  if (!m.shepherd) {
    watcher.warn(TAG, `no shepherd held the flock within ${HERDING.gate_wait_ms / 1000}s: ${shepherdSeen(bot, geo, botId)}`);
    return 'no_shepherd';
  }
  clock.to('gate_wait');
  m.gateHeld = await holdGate(bot, geo);
  if (!m.gateHeld) return 'gate_held_by_a_peer';
  sayPhase(geo, botId, 'culler', 'crossing');
  clock.to('enter');
  const toLineup = await locomotion.goTo({ x: geo.lineup.x, y: geo.lineup.y, z: geo.lineup.z, spare_builds: true, leg: 'work' });
  if (!toLineup || toLineup.arrived === false) return 'route_to_lineup_failed';
  m.entering = true;   // from the first gate click on, the gate is shut again only by leavePen
  const entered = await enterPen(bot, geo);
  if (entered) return entered;

  clock.to('cull');
  sayPhase(geo, botId, 'culler', 'working');
  const choice = await combat.equipBestWeapon(bot);
  m.weapon = choice.item ? choice.item.name : 'fist';
  if (strangers) {
    m.penned = strangers.length;
    m.grown = strangers.length;
    const before = produceHeld(bot), leatherBefore = leatherHeld(bot);
    const missed = [];
    for (const id of strangers) { if (await cullOne(bot, geo, id, choice)) m.culled++; else missed.push(id); }
    // A stranger the cull could not kill is passed by for HERDING.unreachable_skip_ms by every body (pen_gate
    // strangersMissed), so the pen is not tended for it again and again while herding and breeding wait.
    if (missed.length) writeStrangerMiss(geo.structure, missed);
    clock.to('collect');
    m.dropsLeft = await sweepPen(bot, geo);
    m.produceGot = produceHeld(bot) - before;
    m.leatherGot = leatherHeld(bot) - leatherBefore;
    m.left = penned(bot, geo, geo.animal).length;
    watcher.summary(TAG, `culled ${m.culled} of ${strangers.length} stranger(s) in the ${geo.animal} pen (${strangers.join('/')}) with ${m.weapon}, picked up ${m.produceGot} meat and hide; ${m.shepherd} holding`);
    return null;
  }
  const asked = await askBreeding(penned(bot, geo, geo.animal));
  if (asked === null) return 'server_not_asked';
  // GROWN ANIMALS ONLY, nearest first: a lamb (Age below 0) is the pen's next stock.
  const grown = asked.filter(a => a.age >= 0).map(a => a.entity)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  m.penned = asked.length;
  m.grown = grown.length;
  const before = produceHeld(bot), leatherBefore = leatherHeld(bot);
  for (const e of grown.slice(0, count)) if (await cullOne(bot, geo, e.id, choice)) m.culled++;

  clock.to('collect');
  m.dropsLeft = await sweepPen(bot, geo);
  m.produceGot = produceHeld(bot) - before;
  m.leatherGot = leatherHeld(bot) - leatherBefore;
  m.left = penned(bot, geo, geo.animal).length;
  watcher.summary(TAG, `culled ${m.culled} of ${Math.min(count, m.grown)} grown ${geo.animal} (${m.penned} penned, ${m.left} left) with ${m.weapon}, picked up ${m.produceGot} meat and hide; ${m.shepherd} holding`);
  return null;
}

// cullPen(bot, pen, clock, count, { strangers }) → { success, result, readable, metrics }: up to `count` of the pen's grown
// animals slaughtered, or, given `strangers` (entity ids), those other pens' animals instead, timed by step on `clock` (pen_gate.tendClock). The body ends inside the pen holding the gate and the
// standby cell when it entered (metrics.gate_held, metrics.park_held); the manager's leavePen walks it out and shuts the
// gate, and gives the standby cell up after it.
async function cullPen(bot, pen, clock, count, { strangers = null } = {}) {
  if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: cullPen called with no live body.`);
  if (!clock || typeof clock.to !== 'function') throw new Error(`[${TAG}] CODING VIOLATION: cullPen needs the job's clock (pen_gate.tendClock).`);
  if (!Number.isInteger(count) || count < 1) throw new Error(`[${TAG}] CODING VIOLATION: cullPen needs a whole count of animals to cull. Got: ${JSON.stringify(count)}`);
  const geo = penGeometry(pen);
  const botId = process.env.BOT_ID || 'default';
  const m = { culled: 0 };
  const fault = await withCleanup(TAG, 'give up the pen gate and the standby cell after culling', () => work(bot, geo, m, clock, botId, count, strangers), () => {
    if (m.gateHeld && !m.entering) releaseGate(geo);
    if (m.parkHeld && !m.entering) { releasePark(geo, botId); m.parkHeld = false; }
  });
  const metrics = {
    animal: geo.animal, penned: m.penned ?? null, grown: m.grown ?? null, wanted: count, culled: m.culled, left: m.left ?? null,
    produce_got: m.produceGot ?? null, leather_got: m.leatherGot ?? null, drops_left: m.dropsLeft ?? null, weapon: m.weapon || null, shepherd: m.shepherd || null,
    park: m.park ? `${m.park.x},${m.park.y},${m.park.z}` : null, off_cell: m.offCell || null,
    gate_held: !!(m.gateHeld && m.entering), park_held: !!(m.parkHeld && m.entering),
  };
  if (fault) {
    const readable = `${TAG}: fail ${fault} (culled ${m.culled})`;
    watcher.warn(TAG, readable);
    return { success: false, result: fault, readable, metrics };
  }
  const readable = `${TAG}: culled ${m.culled} of ${Math.min(count, m.grown)} grown ${geo.animal}, ${m.produceGot} meat and hide picked up`;
  return { success: true, result: m.culled > 0 ? 'culled' : 'none_culled', readable, metrics };
}

module.exports = { cullPen, cullOne, PRODUCE };
