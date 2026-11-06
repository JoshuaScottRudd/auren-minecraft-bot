'use strict';
// body_recovery — click respawn and verify a body came back; teleport and verify it arrived. Shared by
// every path that can face a corpse (natural death, a continued run, a fresh spawn, the foreman's crew raise), so
// all four share one discipline (Law 16). Neither act trusts its own command: a respawn packet accepted
// is not a body, a `tp` that returned cleanly is not an arrival (Law 25). Each function takes a bot
// HANDLE and creates none; WHERE the body goes stays a policy the caller owns.
//
// mineflayer initialises `bot.isAlive` TRUE at plugin inject and only flips it on the first
// `update_health` packet, so `bot.respawn()` can no-op silently before that packet arrives — every click
// below is gated on a known health reading, not on `isAlive` alone.

const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'body_recovery';

// One set of timing constants for every caller, not a parameter each (Law 16).
const HEALTH_WAIT_MS = 10000;   // wait for the first update_health packet — see the isAlive note above
const RESPAWN_WAIT_MS = 15000;  // wait from the click to a body being back
const TELEPORT_WAIT_MS = 4000;  // wait for position to catch up once a tp crosses a chunk boundary
const VERIFY_POLL_MS = 100;

// A tp to integer coords lands the body at cell centre (+0.5); this absorbs settle drift, still failing a wrong block.
const ARRIVAL_TOLERANCE = 2.0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// isDead(bot) — the one predicate for whether a body needs recovery, shared by job_board's planner and
// the acts below (Law 16); `bot.isAlive` is the primary signal, the rest catch it reading true too early.
function isDead(bot) {
  if (!bot) return true;
  if (bot.isAlive === false) return true;
  if (!bot.entity || !bot.entity.position) return true;
  return typeof bot.health === 'number' && bot.health <= 0;
}

// awaitKnownHealth(bot) → number | null — the server's own health reading, or null on silence, kept
// separate from the click since not knowing a body's state is a different failure than a refused respawn (Law 25).
function awaitKnownHealth(bot, timeoutMs = HEALTH_WAIT_MS) {
  return new Promise((resolve) => {
    if (typeof bot.health === 'number') return resolve(bot.health);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    bot.once('health', () => done(typeof bot.health === 'number' ? bot.health : null));
  });
}

// ── ACT 1 ────────────────────────────────────────────────────────────────────────────────────────────
// reviveBody(bot) → { revived, wasDead, why, healthUnknown }
// Every fleet client runs with respawn:false, so this is the only sender — a death is a hard stop by
// physics, not a check (Law 13), and the outcome is sensed, not assumed.
async function reviveBody(bot) {
  const health = await awaitKnownHealth(bot);
  if (health === null) {
    return {
      revived: false,
      wasDead: null,
      healthUnknown: true,
      why: `the server sent no health packet within ${HEALTH_WAIT_MS}ms — this body's state is unknown, so nothing was clicked`,
    };
  }
  if (!isDead(bot)) return { revived: false, wasDead: false, healthUnknown: false, why: 'the body is already standing' };

  if (typeof bot.respawn === 'function') guardExternalSync(TAG, 'respawn click', () => bot.respawn());

  for (const end = Date.now() + RESPAWN_WAIT_MS; Date.now() < end;) {
    if (!isDead(bot)) return { revived: true, wasDead: true, healthUnknown: false, why: 'clicked respawn and a body came back' };
    await sleep(VERIFY_POLL_MS);
  }
  return {
    revived: false,
    wasDead: true,
    healthUnknown: false,
    why: `clicked respawn and no body came back within ${RESPAWN_WAIT_MS}ms — with respawn:false nothing else sends it`,
  };
}

// ── ACT 2 ────────────────────────────────────────────────────────────────────────────────────────────
// teleportTo(bot, at, { name }) → { moved, from, to, error }
// Moves a body to a CELL via RCON, since a plain client has no console command of its own
// (`js_kernel/utils/rcon_link`). No walk fallback: a teleport that cannot happen is reported (Law 16).
async function teleportTo(bot, at, { name = null } = {}) {
  const who = name || (bot && bot.username) || process.env.BOT_ID;
  // A name is never defaulted — a guessed username would move somebody else's body while reporting success (Law 13).
  if (!who) throw new Error(`[${TAG}] CODING VIOLATION: teleportTo has no username — the bot handle carries none and no name was passed.`);

  const from = bot && bot.entity && bot.entity.position ? bot.entity.position.floored() : null;
  // A non-finite cell here is a caller that skipped its own validation (Law 13).
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) {
    throw new Error(`[${TAG}] CODING VIOLATION: teleportTo was handed a cell that is not a position: ${JSON.stringify(at)}. The caller must validate before it returns one.`);
  }

  // The body's own account of where the server puts it is told this move was asked for.
  if (bot && bot.username === who) require('./server_account').expect(at, TELEPORT_WAIT_MS);
  // rcon_link owns the socket to the server; a throw here originates in the rcon package behind it.
  const sent = await guardExternal(TAG, `rcon tp ${who}`,
    () => require('./utils/rcon_link').once([`tp ${who} ${at.x} ${at.y} ${at.z}`]));
  if (!sent.ok) return { moved: false, from, to: at, error: `rcon: ${sent.reason}` };

  for (const end = Date.now() + TELEPORT_WAIT_MS; Date.now() < end;) {
    const p = bot && bot.entity && bot.entity.position;
    if (p && Math.hypot(p.x - (at.x + 0.5), p.y - at.y, p.z - (at.z + 0.5)) <= ARRIVAL_TOLERANCE) {
      return { moved: true, from, to: at, error: null };
    }
    await sleep(VERIFY_POLL_MS);
  }
  const now = bot && bot.entity && bot.entity.position ? bot.entity.position.floored() : null;
  return { moved: false, from, to: at, error: `no arrival within ${TELEPORT_WAIT_MS}ms — body reads ${now ? `(${now.x},${now.y},${now.z})` : 'nowhere'}` };
}

// ── ACT 2b ───────────────────────────────────────────────────────────────────────────────────────────
// arriveAtCell(bot, cell) → { arrived, error, distance }
// The one door a placement comes through: the measured cell the foreman hands a body it raises, "x y z"
// (Law 16). A cell in any other form is operator input from a hand launch, so it is answered, not thrown (Law 25).
const CELL_FORM = /^(-?\d+)\s+(-?\d+)\s+(-?\d+)$/;
async function arriveAtCell(bot, cell) {
  const m = CELL_FORM.exec(String(cell || '').trim());
  if (!m) return { arrived: false, distance: null, error: `'${cell}' is not a cell written "x y z"` };
  const at = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  const r = await teleportTo(bot, at);
  if (!r.moved) return { arrived: false, distance: null, error: r.error };
  const p = bot.entity.position;
  return { arrived: true, distance: Math.hypot(p.x - (at.x + 0.5), p.y - at.y, p.z - (at.z + 0.5)), error: null };
}

// anchorZeroPoint(blueprintName, transposeOrigin) → the world cell of anchor 0's floor, or null. Kept in
// one place so every caller derives the same home cell from the same blueprint (Law 16).
function anchorZeroPoint(blueprintName, transposeOrigin) {
  const building = require('@kernel/blueprint_registry').tryGetBuilding(blueprintName);
  const anchor = building && Array.isArray(building.anchors) ? building.anchors[0] : null;
  if (!anchor || !Array.isArray(anchor.position) || anchor.position.length < 3) return null;
  const [dx, dy, dz] = anchor.position;
  return { x: transposeOrigin.x + dx, y: transposeOrigin.y + dy, z: transposeOrigin.z + dz };
}

module.exports = {
  isDead, awaitKnownHealth, reviveBody, teleportTo, arriveAtCell, anchorZeroPoint,
  ARRIVAL_TOLERANCE, HEALTH_WAIT_MS, RESPAWN_WAIT_MS, TELEPORT_WAIT_MS,
};
