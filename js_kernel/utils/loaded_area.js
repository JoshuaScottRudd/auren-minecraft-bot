// loaded_area — THE LOADED AREA MUST HAVE ARRIVED BEFORE ANYTHING IS JUDGED FROM IT.
// One wait for every caller (Law 16). Arrived means every column in view is here — a quiet gap in chunk arrivals
// does not prove that, since the server also pauses while it generates terrain. The wait ends only when every chunk
// of the server's actual view around the body is loaded (inServerView), the whole shape and not an inner subset.

'use strict';

const Vec3 = require('vec3');

// inServerView — the vanilla server's membership test for a player's view (ChunkTrackingView.isWithinDistance
// with its neighbour margin on): each axis distance less 2, floored at 0, squared and summed, strictly under
// viewDistance². Measured against a connected client at view distance 10: 473 chunks held once settled, every
// one inside this shape and none outside it. A server that sends a smaller view meets the cap and says so.
function inServerView(cx, cz, viewDistance, x, z) {
  const dx = Math.max(0, Math.abs(x - cx) - 2), dz = Math.max(0, Math.abs(z - cz) - 2);
  return dx * dx + dz * dz < viewDistance * viewDistance;
}

const SETTLE_POLL_MS = 1000;
const SETTLE_MAX_MS = 120000;    // past this the shortfall is reported, not waited on
async function loadedAreaSettled(bot) {
  const t0 = Date.now();
  const vd = bot.game.serverViewDistance;
  if (!Number.isInteger(vd) || vd < 2) {
    throw new Error(`[loaded_area] CODING VIOLATION (Law 13): the server's view distance was not announced ` +
      `(bot.game.serverViewDistance=${vd}), so there is no way to know when the loaded area has arrived.`);
  }
  const r = vd + 2;
  const disc = [];
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (inServerView(0, 0, vd, dx, dz)) disc.push([dx, dz]);
  const missing = () => {
    const p = bot.entity.position;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    return disc.filter(([dx, dz]) => !bot.world.getColumnAt(new Vec3((cx + dx) * 16, 0, (cz + dz) * 16))).length;
  };
  let left = missing();
  while (left > 0 && Date.now() - t0 < SETTLE_MAX_MS) {
    await new Promise(res => setTimeout(res, SETTLE_POLL_MS));
    left = missing();
  }
  return {
    columns: bot.world.getColumns().length, secs: ((Date.now() - t0) / 1000).toFixed(0),
    settled: left === 0, missing: left, disc: disc.length, viewDistance: vd,
  };
}

module.exports = { inServerView, loadedAreaSettled, SETTLE_MAX_MS };
