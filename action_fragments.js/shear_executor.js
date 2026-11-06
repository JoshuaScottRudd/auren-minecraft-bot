// fragment: shear_executor (action / ranching) — a LIBRARY: shear_manager owns the job and calls shearPen().
// purpose: Shears the pen's woolly animals of one color and picks up the wool. One verb: shear the penned flock (Law 0).
//
// THE SHEARER IS A TENDER (@api/pen_gate owns the pen's geometry, the gate, the standby cell, the shepherd's post and
// the tending board). It walks to the standby cell, says it is standing by — the board then posts the urgent shepherd
// job — and waits until a shepherd holds the penned flock against the long side. Then it claims the gate, enters from
// the lineup cell straight along the axis and shuts the gate behind it (pen_gate.enterPen): it works inside a while, so
// the gate stays shut. With the shears in hand it asks the server which penned animals are woolly and their colors
// (pen_gate.askWool) and shears each woolly one of the color the job names (the wool the building asks for), nearest
// first, walking to an animal that is out of HERDING.shear_reach; the flock stands at the
// shepherd's fence, so the walks are short. Then it picks up the wool (drop_collector.collectNearby), asks the server
// again and remembers the pen's wool by color (pen_gate.noteWool). It ends inside the pen holding the gate and the
// standby cell; leaving is pen_gate.leavePen's, called by the manager, and the standby cell is given up after it.
//
// invariants:
//  - Every animal is re-sensed by entity id before each shearing (Invariant B); one gone is passed by, never a throw.
//  - Which animals carry wool is the server's word, never guessed from what the body sees.

'use strict';

const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { penGeometry, insidePen, penned, holdGate, releaseGate, enterPen, tendingCells, tryPark, releasePark, shepherdSeen, awaitShepherd, sayPhase, askWool, noteWool } = require('@api/pen_gate');
const { standOn } = require('@action/herd_executor');
const { HERDING } = require('@thinking/architect_config');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');

const TAG = 'shear_executor';
const TOOL = 'shears';
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const feetOf = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const woolHeld = bot => bot.inventory.items().filter(i => /_wool$/.test(i.name)).reduce((n, i) => n + i.count, 0);

// shearOne(bot, geo, id) → true once the animal was shorn: walked to while it stands out of HERDING.shear_reach (up to
// HERDING.shear_walks walks, each re-aimed at where it stands now), then the shears used on it.
async function shearOne(bot, geo, id) {
  for (let walks = 0; ; walks++) {
    const e = bot.entities[id];
    if (!e || e.isValid === false || !e.position || !insidePen(geo, e.position)) return false;
    if (flat(e.position, bot.entity.position) <= HERDING.shear_reach) {
      const r = await guardExternal(TAG, `shear ${geo.animal} ${id}`, () => bot.activateEntity(e));
      return r.ok;
    }
    if (walks >= HERDING.shear_walks) return false;
    await locomotion.goTo({ ...feetOf(e.position), spare_builds: true, leg: 'work' });
  }
}

// work(bot, geo, m, clock, botId): the shearer's part, standby to the wool picked up → fault or null.
async function work(bot, geo, m, clock, botId, color) {
  const cells = tendingCells(bot, geo);
  if (!cells) return 'no_tending_cells';
  m.park = cells.park;
  clock.to('walk');
  sayPhase(geo, botId, 'shearer', 'en_route');
  if (!(await tryPark(geo, botId))) return 'standby_held_by_a_peer';
  m.parkHeld = true;
  // The shearer is posted only to a body within sight of the pen: its walk is short, so the shepherd is called now.
  sayPhase(geo, botId, 'shearer', 'near');
  const nav = await locomotion.goTo({ x: cells.park.x, y: cells.park.y, z: cells.park.z, spare_builds: true, leg: 'work' });
  if (!nav || nav.arrived === false) return 'route_to_standby_failed';
  await standOn(bot, cells.park, m, 'standby');
  sayPhase(geo, botId, 'shearer', 'standby');
  clock.to('shepherd_wait');
  m.shepherd = await awaitShepherd(bot, geo, botId, HERDING.gate_wait_ms);
  if (!m.shepherd) {
    watcher.warn(TAG, `no shepherd held the flock within ${HERDING.gate_wait_ms / 1000}s: ${shepherdSeen(bot, geo, botId)}`);
    return 'no_shepherd';
  }
  clock.to('gate_wait');
  m.gateHeld = await holdGate(bot, geo);
  if (!m.gateHeld) return 'gate_held_by_a_peer';
  sayPhase(geo, botId, 'shearer', 'crossing');
  clock.to('enter');
  const toLineup = await locomotion.goTo({ x: geo.lineup.x, y: geo.lineup.y, z: geo.lineup.z, spare_builds: true, leg: 'work' });
  if (!toLineup || toLineup.arrived === false) return 'route_to_lineup_failed';
  m.entering = true;   // from the first gate click on, the gate is shut again only by leavePen
  const entered = await enterPen(bot, geo);
  if (entered) return entered;

  clock.to('shear');
  sayPhase(geo, botId, 'shearer', 'working');
  const shears = bot.inventory.items().find(i => i.name === TOOL);
  if (!shears) return 'no_shears';
  const inHand = await guardExternal(TAG, 'take the shears in hand', () => bot.equip(shears, 'hand'));
  if (!inHand.ok) return 'shears_not_in_hand';
  const asked = await askWool(penned(bot, geo, geo.animal));
  if (asked === null) return 'server_not_asked';
  // ONE COLOR: only the woolly animals of the color the building asks for are shorn; the rest keep their wool.
  const woolly = asked.filter(a => a.woolly && a.color === color).map(a => a.entity)
    .sort((a, b) => flat(a.position, bot.entity.position) - flat(b.position, bot.entity.position));
  m.penned = asked.length;
  m.woolly = woolly.length;
  const woolBefore = woolHeld(bot);
  for (const e of woolly) if (await shearOne(bot, geo, e.id)) m.shorn++;

  clock.to('collect');
  await require('@api/drop_collector').collectNearby(bot);
  m.woolGot = woolHeld(bot) - woolBefore;
  const after = await askWool(penned(bot, geo, geo.animal));
  if (after) { m.woollyLeft = after.filter(a => a.woolly && a.color === color).length; noteWool(geo, after); }
  watcher.summary(TAG, `sheared ${m.shorn} of ${m.woolly} woolly ${color} (${m.penned} penned), picked up ${m.woolGot} wool; ${m.woollyLeft ?? '?'} still woolly; ${m.shepherd} holding`);
  return null;
}

// shearPen(bot, pen, clock, color) → { success, result, readable, metrics }: the pen's woolly animals of one color shorn, timed by step on
// `clock` (pen_gate.tendClock). The body ends inside the pen holding the gate and the standby cell when it entered
// (metrics.gate_held, metrics.park_held); the manager's leavePen walks it out and shuts the gate, and gives the standby
// cell up after it.
async function shearPen(bot, pen, clock, color) {
  if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: shearPen called with no live body.`);
  if (!clock || typeof clock.to !== 'function') throw new Error(`[${TAG}] CODING VIOLATION: shearPen needs the job's clock (pen_gate.tendClock).`);
  if (!require('@thinking/architect_config').DYES[color]) throw new Error(`[${TAG}] CODING VIOLATION: shearPen needs the wool color to shear. Got: ${JSON.stringify(color)}`);
  const geo = penGeometry(pen);
  const botId = process.env.BOT_ID || 'default';
  const m = { shorn: 0 };
  const fault = await withCleanup(TAG, 'give up the pen gate and the standby cell after shearing', () => work(bot, geo, m, clock, botId, color), () => {
    if (m.gateHeld && !m.entering) releaseGate(geo);
    if (m.parkHeld && !m.entering) { releasePark(geo, botId); m.parkHeld = false; }
  });
  const metrics = {
    color, penned: m.penned ?? null, woolly: m.woolly ?? null, shorn: m.shorn, wool_got: m.woolGot ?? null, woolly_left: m.woollyLeft ?? null,
    shepherd: m.shepherd || null, park: m.park ? `${m.park.x},${m.park.y},${m.park.z}` : null, off_cell: m.offCell || null,
    gate_held: !!(m.gateHeld && m.entering), park_held: !!(m.parkHeld && m.entering),
  };
  if (fault) {
    const readable = `${TAG}: fail ${fault} (sheared ${m.shorn})`;
    watcher.warn(TAG, readable);
    return { success: false, result: fault, readable, metrics };
  }
  const readable = `${TAG}: sheared ${m.shorn} of ${m.woolly} woolly, ${m.woolGot} wool picked up`;
  return { success: true, result: m.shorn > 0 ? 'sheared' : 'none_shorn', readable, metrics };
}

module.exports = { shearPen };
