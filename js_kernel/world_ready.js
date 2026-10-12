'use strict';
// world_ready — a body plans nothing until the world round it has arrived.
//
// The server sends a body its chunks over the seconds after it joins, and every perception node reads a
// chunk that has not arrived as "nothing there". A plan made in those seconds is made against a world
// that is mostly missing. Each body's chunks are its own — the server sends them to that client — so the
// wait is the body's, taken once between spawn and its first plan.
//
// awaitWorld(bot) resolves when every chunk column inside the server's view distance of the body has
// arrived, or when the count of arrived columns has stopped growing (a server sends a rounded area, so the
// corners of the square may never come). Returns { columns, of, waited_ms, whole }.
const watcher = require('@kernel/watcher');
const { sleep } = require('@utils/fragment_utils');

const POLL_MS = 250;
const SETTLED_MS = 3000;   // no new column for this long: what is coming has come

function arrived(bot, radius) {
  const p = bot.entity.position;
  const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
  let n = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (bot.world.getColumn(cx + dx, cz + dz)) n++;
    }
  }
  return n;
}

async function awaitWorld(bot) {
  const radius = bot.game.serverViewDistance;
  const of = (2 * radius + 1) ** 2;
  const began = Date.now();
  let columns = arrived(bot, radius), grewAt = began;
  while (columns < of && (columns === 0 || Date.now() - grewAt < SETTLED_MS)) {
    await sleep(POLL_MS);
    const now = arrived(bot, radius);
    if (now > columns) { columns = now; grewAt = Date.now(); }
  }
  const out = { columns, of, waited_ms: Date.now() - began, whole: columns === of };
  watcher.summary('world_ready', `WORLD_READY columns=${out.columns} of=${out.of} waited_ms=${out.waited_ms} whole=${out.whole}`);
  return out;
}

module.exports = { awaitWorld };
