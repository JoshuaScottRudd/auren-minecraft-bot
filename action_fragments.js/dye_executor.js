// fragment: dye_executor (action / ranching) — a LIBRARY: dye_manager owns the job and calls dyePen().
// purpose: Dyes white penned animals one color from outside the fence. One verb: dye the penned flock (Law 0).
//
// THE DYER STANDS WHERE THE BREEDER STANDS: it holds the shepherd post (pen_gate.tryShepherd), so no tender opens the
// gate while it works, and with a tender or shepherd already at the pen it dyes nothing. At the post it asks the server
// the pen's colors (pen_gate.askWool) and dyes the white animals nearest it, one dye each, up to the number the job
// names (`count`, assessors/ranching: the color's share of the flock still white). The wheat is shown in the off-hand
// so the penned flock comes to the fence, the dye is in the main hand, and an animal is dyed only within
// HERDING.dye_reach, the body stepping along its side level with it (pen_gate.shepherdCellToward). A dye counts once it
// is spent; one not spent is tried once more. After the dyeing the server is asked the colors again, and what it says
// is the pen's wool by color as this body knows it (pen_gate.noteWool).
//
// invariants:
//  - Every animal is re-sensed by entity id before it is dyed (Invariant B); one gone is passed by, never a throw.
//  - An animal's color is the server's word, never guessed from what the body sees.

'use strict';

const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { HERDING, DYES } = require('@thinking/architect_config');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');
const { penGeometry, penned, tendingCells, tryShepherd, releaseShepherd, parkedTender, shepherdOf, stepInto, waitFor, shepherdCellToward, askWool, noteWool, lureLine } = require('@api/pen_gate');

const TAG = 'dye_executor';
const LURE = 'wheat';
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const held = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);

// dyeOne(bot, animal, dye) → true once the dye in hand is spent on it; an unspent dye is tried once more.
async function dyeOne(bot, animal, dye) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = held(bot, dye);
    const r = await guardExternal(TAG, `dye ${animal.name} ${animal.id}`, () => bot.activateEntity(animal));
    if (r.ok && await waitFor(() => held(bot, dye) < before, HERDING.feed_take_ms)) return true;
    watcher.warn(TAG, `dye ${animal.name} ${animal.id} attempt=${attempt} dye_taken=false`);
  }
  return false;
}

// dyePen(bot, pen, color, count) → { result, asked, white, dyed, now_color, seconds }.
async function dyePen(bot, pen, color, count) {
  if (!DYES[color] || color === 'white') throw new Error(`[${TAG}] CODING VIOLATION: dyePen needs a dye color other than white. Got: ${JSON.stringify(color)}`);
  const geo = penGeometry(pen);
  const botId = process.env.BOT_ID || 'default';
  const dye = DYES[color].dye;
  const started = Date.now();
  const out = { result: null, asked: 0, white: 0, dyed: 0, now_color: null, seconds: 0 };
  const done = result => ({ ...out, result, seconds: Math.round((Date.now() - started) / 1000) });
  if (parkedTender(bot, geo, botId) || shepherdOf(bot, geo, botId)) return done('tending_at_the_pen');
  const cells = tendingCells(bot, geo);
  if (!cells) return done('no_tending_cells');
  if (!(await tryShepherd(geo, botId))) return done('post_held_by_a_peer');
  return withCleanup(TAG, 'give up the shepherd post and the off-hand after dyeing', async () => {
    const nav = await locomotion.goTo({ x: cells.post.x, y: cells.post.y, z: cells.post.z, spare_builds: true, leg: 'work' });
    if (!nav || nav.arrived === false) return done('route_to_post_failed');
    await stepInto(bot, cells.post);
    const asked = await askWool(penned(bot, geo, geo.animal));
    if (asked === null) return done('server_not_asked');
    noteWool(geo, asked);
    out.asked = asked.length;
    const white = asked.filter(a => a.color === 'white')
      .sort((a, b) => flat(a.entity.position, bot.entity.position) - flat(b.entity.position, bot.entity.position));
    out.white = white.length;
    if (!white.length) return done('no_white_animal');
    const wheat = bot.inventory.items().find(i => i.name === LURE);
    if (wheat && (await guardExternal(TAG, 'show the wheat in the off-hand', () => bot.equip(wheat, 'off-hand'))).ok) lureLine(bot, 'shown', 'dye_post');
    for (const { entity } of white.slice(0, count)) {
      const inPocket = bot.inventory.items().find(i => i.name === dye);
      if (!inPocket) break;
      const inHand = await guardExternal(TAG, `take ${dye} in hand`, () => bot.equip(inPocket, 'hand'));
      if (!inHand.ok) return done('dye_not_in_hand');
      const near = () => { const e = bot.entities[entity.id]; return e && e.position && flat(e.position, bot.entity.position) <= HERDING.dye_reach ? e : null; };
      if (!near()) {
        const e = bot.entities[entity.id];
        const cell = e && e.position && shepherdCellToward(bot, geo, cells.post, e.position);
        if (cell) { await locomotion.goTo({ x: cell.x, y: cell.y, z: cell.z, spare_builds: true, leg: 'work' }); await stepInto(bot, cell); }
        await waitFor(() => !!near(), HERDING.feed_wait_ms);
      }
      const e = near();
      if (!e) { watcher.warn(TAG, `${geo.animal} ${entity.id} did not come within ${HERDING.dye_reach} blocks of the fence to be dyed`); continue; }
      if (await dyeOne(bot, e, dye)) out.dyed++;
    }
    const after = await askWool(penned(bot, geo, geo.animal));
    if (after) { noteWool(geo, after); out.now_color = after.filter(a => a.color === color).length; }
    watcher.summary(TAG, `dyed ${out.dyed} of ${Math.min(count, white.length)} ${color} (${out.white} white of ${out.asked} penned); the pen holds ${out.now_color ?? '?'} ${color}`);
    return done(out.dyed > 0 ? 'dyed' : 'none_dyed');
  }, async () => {
    releaseShepherd(geo, botId);
    if (bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === LURE) {
      if ((await guardExternal(TAG, 'take the wheat out of the off-hand', () => bot.unequip('off-hand'))).ok) lureLine(bot, 'away', 'dye_end');
    }
  });
}

module.exports = { dyePen };
