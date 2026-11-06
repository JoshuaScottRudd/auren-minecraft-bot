// fragment: guard_manager — one body stands by one worker through the night (assessors/tandem).
//   - Sense    = its ward on the combat road (combat_board.wardOf).
//   - Act      = say on duty, stand KEEP_B from its ward on the dark side, answer the combat gate. Standing there it is the first body a
//                mob out of the dark meets, and it fights as any body does. A mob its ward names reaches it through commander's WARD DOOR
//                as the backup. The fight takes the body at the gate; its seat is its own again after, and this loop walks it back.
//   - Exit     = dawn, no worker for NO_WORKER_MS, or the weapon or shield gone. A fight ends the chain at the judge; the duty stands meanwhile.
// One signal lives for the whole hold (Law 4) and it ends at recursive_judge.

'use strict';

const watcher = require('@kernel/watcher');
const combatBoard = require('@api/combat_board');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { routeToJudge } = require('@utils/signal_utils');
const { sleep } = require('@utils/fragment_utils');
const { isNightTime, isDuskTime } = require('@thinking/architect_config');
const { Vec3 } = require('vec3');

const TAG = 'guard_manager';
const POLL_MS = 500;
// Far enough off the worker to stay out of its way.
const KEEP_B = 5;
// How far off its post a guard stands before it walks: a worker's small steps do not move it.
const POST_SLACK_B = 3;
// Where the dark is read around a ward: mobs spawn at block light 0.
const DARK_RADII_B = [8, 16];
const DARK_RAYS = 16;
const FLOOR_SEARCH_B = 6;
const MIN_LIT_CELLS = 3;
const SIDE_HOLD = 0.5;   // the cosine of 60 degrees
const POST_TURNS = [0, 1, -1, 2, -2, 3, -3, 4].map((n) => n * Math.PI / 4);
const NO_WORKER_MS = 120000;
const UNREACHED_WAIT_MS = 10000;

// standingCell(bot, x, y, z) → the air cell over solid ground nearest height y in this column, or null in an unloaded or groundless one.
function standingCell(bot, x, y, z) {
  for (let i = 0; i <= FLOOR_SEARCH_B * 2; i++) {
    const cy = y + (i % 2 ? (i + 1) / 2 : -i / 2);
    const air = bot.blockAt(new Vec3(x, cy, z));
    const under = bot.blockAt(new Vec3(x, cy - 1, z));
    if (air && under && air.boundingBox === 'empty' && under.boundingBox === 'block') return air;
  }
  return null;
}

// darkSide(bot, at, home, last) → { x, z, dark, lit, from }: the unit direction from `at` away from the lit ground. Only lit ground votes: dark is
// everywhere at night, and counting it reads the columns that failed to answer as a side. With too little lit ground to say, it points
// away from home, and at home it holds the last side. A side within SIDE_HOLD of the last one keeps the last one, so a guard does not pace.
function darkSide(bot, at, home, last) {
  let x = 0, z = 0, dark = 0, lit = 0;
  for (let i = 0; i < DARK_RAYS; i++) {
    const a = (i / DARK_RAYS) * 2 * Math.PI;
    const ux = Math.cos(a), uz = Math.sin(a);
    for (const r of DARK_RADII_B) {
      const cell = standingCell(bot, Math.floor(at.x + ux * r), Math.floor(at.y), Math.floor(at.z + uz * r));
      if (!cell || !Number.isFinite(cell.light)) continue;
      if (cell.light === 0) dark++;
      else { lit++; x -= ux; z -= uz; }
    }
  }
  let from = 'light';
  let len = Math.hypot(x, z);
  if (lit < MIN_LIT_CELLS || len < 1) {
    from = 'home';
    x = home ? at.x - home.x : 0;
    z = home ? at.z - home.z : 0;
    len = Math.hypot(x, z);
    if (len < 1) return { ...(last || { x: 1, z: 0 }), dark, lit, from: 'held' };
  }
  x /= len;
  z /= len;
  if (last && x * last.x + z * last.z >= SIDE_HOLD) return { x: last.x, z: last.z, dark, lit, from };
  return { x, z, dark, lit, from };
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the guard manager ran.`);
    const { combatCheckpoint } = require('@api/battle_stations');
    let lastWorker = Date.now();
    let walks = 0;
    let side = null;
    let turn = 0;
    while ((isNightTime() || isDuskTime()) && Date.now() - lastWorker <= NO_WORKER_MS && combatBoard.guardKitted(bot)) {
      const now = Date.now();
      combatBoard.standDuty(now);
      await combatCheckpoint(bot, TAG);
      const self = bot.entity.position;
      const worker = combatBoard.wardOf(now);
      if (worker) lastWorker = now;
      if (worker) {
        const site = require('@kernel/corporate_headquarters').readBuildingChair(require('@kernel/bot_mandate').homeBlueprint(), 'set_buildspot');
        side = darkSide(bot, worker.pos, (site && site.transpose_origin) || null, side);
        // The dark side first, then the sides nearest it: water or a wall on one side leaves the guard the next one round.
        let postX = 0, postZ = 0, cell = null;
        for (let i = 0; i < POST_TURNS.length && !cell; i++) {
          const a = POST_TURNS[(turn + i) % POST_TURNS.length];
          postX = worker.pos.x + (side.x * Math.cos(a) - side.z * Math.sin(a)) * KEEP_B;
          postZ = worker.pos.z + (side.x * Math.sin(a) + side.z * Math.cos(a)) * KEEP_B;
          cell = standingCell(bot, Math.floor(postX), Math.floor(worker.pos.y), Math.floor(postZ));
          if (cell) turn = (turn + i) % POST_TURNS.length;
        }
        if (!cell) { await sleep(POLL_MS); continue; }
        if (Math.hypot(postX - self.x, postZ - self.z) > POST_SLACK_B) {
          walks++;
          watcher.summary(TAG, `to post by ${worker.botId}: side ${side.x.toFixed(2)},${side.z.toFixed(2)} from ${side.from}, ${side.dark} dark and ${side.lit} lit`);
          const went = await locomotion.goTo({ x: Math.floor(postX), y: cell.position.y, z: Math.floor(postZ), exact: false, leg: 'travel', purpose: 'guard' });
          if (went.arrived) turn = 0;
          else { turn = (turn + 1) % POST_TURNS.length; await sleep(UNREACHED_WAIT_MS); }
          continue;
        }
      }
      await sleep(POLL_MS);
    }
    combatBoard.endDuty();
    const why = !combatBoard.guardKitted(bot) ? 'without a weapon and a shield' : (isNightTime() || isDuskTime() ? 'with no worker to guard' : 'at dawn');
    const readable = `${TAG}: off duty after ${walks} walk(s) ${why}`;
    watcher.summary(TAG, readable);
    routeToJudge(TAG, { readable, [TAG]: { success: true, readable } });
  }),
};
