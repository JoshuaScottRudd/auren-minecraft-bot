// The raw button presses and the settle gate. One verb apiece: release the controls, tap forward, tap
// jump, face a point, pulse, centre on a cell, wait until the body has stopped moving. No pathing, no
// terrain reasoning, no placing.
//
// A leaf, and it must stay one. Drive and scaffold compose these; a primitive that decides WHERE to press
// takes a caller's job, and the caller cannot be held to its own outcome (Invariant D).

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { sleep } = require('@utils/fragment_utils');
const { guardExternalSync, withCleanup } = require('@utils/external_library_guard');

// ── SECTION 4: Core Motion Primitives ──

// The explicit per-control releases go unguarded: bot.setControlState only throws on an invalid control
// name or a non-boolean state, both literals here, so a throw is a Law 13 coding violation that must
// surface. clearControlStates() keeps a boundary: it also touches 'sprint', which can throw once the bot
// is dead or despawned.
function clearMotion(bot) {
  const cleared = guardExternalSync('motion_primitives', 'clearControlStates',
    () => bot.clearControlStates && bot.clearControlStates());
  void cleared;   // the explicit releases below run regardless; the warn is what shows if it threw
  bot.setControlState('forward', false);
  bot.setControlState('jump', false);
  bot.setControlState('left', false);
  bot.setControlState('right', false);
  bot.setControlState('sneak', false);
}

async function tapForward(bot, pressMs = 150, settleMs = 0) {
  await withCleanup('motion_primitives', 'tap forward',
    async () => { bot.setControlState('forward', true); await sleep(pressMs); },
    () => bot.setControlState('forward', false));
  if (settleMs > 0) await sleep(settleMs);
}

// ── SECTION 4b: THE EIGHT-POINT PRESS — travel decoupled from facing ────────────────────────────────
//
// Forces the yaw onto a cardinal/ordinal grid, then drives with WSAD relative to that facing (at most
// two keys at once) instead of turning the body to steer, so the yaw stays free for whoever is aiming.
//
// `pathfinding_utils.CARDINAL` is the only neighbour set A* expands, four entries, and every edge type
// (walk, climb, swim, dig) is generated inside that one loop; no planned route contains a horizontal
// diagonal. A body that can travel the four cardinals plus the four 45° combinations can execute any
// plan this fleet produces, exactly.
//
// THE MATH IS THE ENGINE'S OWN (prismarine-physics). Physics builds `strafe = right - left`,
// `forward = forward - back`, then rotates that pair by the body's yaw. Substituting the engine's
// `yaw' = π - yaw` gives the world displacement directly:
//     Δx = strafe·cos(yaw) − forward·sin(yaw)
//     Δz = −forward·cos(yaw) − strafe·sin(yaw)
// which is the pair of unit axes below.
//
// DIAGONALS ARE NOT FASTER: applyHeading normalises (`speed = √(strafe²+forward²)`, then
// `multiplier / max(speed,1)`), so all eight combinations travel at one speed.
const HEADING_QUANTA = 8;
const QUANTUM_RAD = (2 * Math.PI) / HEADING_QUANTA;
// cos(67.5°) — the half-angle between adjacent 8-point directions. A component above this is nearer to
// pressed than to released, which makes the mapping the nearest of the eight directions.
const PRESS_THRESHOLD = Math.cos((3 * Math.PI) / 8);

// quantizeYaw(yaw) → the nearest of the 8 compass points, in the same convention faceTarget writes
// (`atan2(-dx, -dz)`, so 0 faces −Z). With both the facing and the heading on the 8-point grid,
// `headingKeys` below can only ever produce a component of 0, ±0.7071 or ±1 — never a value near the
// threshold, so no press is ever borderline.
function quantizeYaw(yaw) {
  return Math.round(yaw / QUANTUM_RAD) * QUANTUM_RAD;
}

// yawToward(from, to) → the quantized yaw that faces `to`, in faceTarget's un-quantized convention.
function yawToward(from, to) {
  return quantizeYaw(Math.atan2(-(to.x - from.x), -(to.z - from.z)));
}

// ── quantizeYawSticky — a hysteresis band around the yaw quantum, to stop stutter ───────────────────
//
// Holds the currently-held facing across a bearing near an octant boundary, so a mob circling the bot at
// a near-constant bearing does not flip the facing every pass. Hysteresis is a pure function of the
// bearing and the facing currently held — same inputs, same answer, forever (Invariant C).
//
// The margin is strictly bounded by the half-quantum (22.5°): at that ceiling the held facing could
// survive a bearing a full octant off, permanently.
const YAW_HYSTERESIS_RAD = (7.5 * Math.PI) / 180;

// quantizeYawSticky(bearing, held, hystRad) → the yaw to hold now.
// PURE — the caller owns the `held` state, because the facing belongs to whoever is aiming (Invariant D)
// and a module-level latch here would be a second owner of it shared across every bot in the process.
function quantizeYawSticky(bearing, held, hystRad) {
  const want = quantizeYaw(bearing);
  if (held == null) return want;
  const margin = hystRad != null ? hystRad : YAW_HYSTERESIS_RAD;
  // Angular distance from the bearing to the facing already held, wrapped to ±π.
  let off = bearing - held;
  while (off > Math.PI) off -= 2 * Math.PI;
  while (off < -Math.PI) off += 2 * Math.PI;
  // Inside the half-quantum plus the margin, the held facing is still good enough — keep it, and the
  // boundary stops being a place the answer can oscillate.
  return Math.abs(off) <= QUANTUM_RAD / 2 + margin ? held : want;
}

// headingKeys(headingVec, yaw) → { forward, back, left, right } for travelling `headingVec` (world XZ,
// need not be normalised) while facing `yaw`. At most two are true — the eight-point grid admits no third.
function headingKeys(heading, yaw) {
  const len = Math.hypot(heading.x, heading.z);
  const keys = { forward: false, back: false, left: false, right: false };
  if (!(len > 1e-6)) return keys;                 // no direction asked for: release everything
  const hx = heading.x / len, hz = heading.z / len;
  const s = Math.sin(yaw), c = Math.cos(yaw);
  const f = -(hx * s + hz * c);                   // component along the facing  (−sin, −cos)
  const r = hx * c - hz * s;                      // component along its right   ( cos, −sin)
  if (f > PRESS_THRESHOLD) keys.forward = true; else if (f < -PRESS_THRESHOLD) keys.back = true;
  if (r > PRESS_THRESHOLD) keys.right = true;    else if (r < -PRESS_THRESHOLD) keys.left = true;
  return keys;
}

// pressHeading(bot, heading, ms) → { keys, yaw, travelled }
//
// Presses the WSAD keys nearest to `heading` given the yaw already held, decoupling travel from facing.
// `withCleanup` is what stops a throw mid-step leaving the body walking (Law 8).
//
// Takes no facing parameter: the driver never writes the yaw, only reads whatever the gunner has aimed.
// The missing parameter makes writing the yaw here unrepresentable, not merely disallowed (Law 26).
//
// The yaw is read raw, not quantized. This function asks where the body is facing; it never asserts it.
// The trig is exact for any yaw; the 8-point discipline is the gunner's contract for what it writes,
// never an assumption this driver makes about what it finds.
async function pressHeading(bot, heading, ms = 150) {
  const yaw = bot.entity.yaw;                     // read fresh every call (Invariant B)
  const keys = headingKeys(heading, yaw);
  const from = bot.entity.position.clone();
  await withCleanup('motion_primitives', 'press heading',
    async () => {
      for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, keys[k]);
      await sleep(ms);
    },
    () => { for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, false); });
  const to = bot.entity.position;
  return { keys, yaw, travelled: Math.hypot(to.x - from.x, to.z - from.z) };
}

async function jumpTap(bot, duration = 420) {
  bot.setControlState('jump', true);
  await sleep(duration);
  bot.setControlState('jump', false);
}

async function faceTarget(bot, from, to, faceDuration = 150) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const yaw = Math.atan2(-dx, -dz);
  bot.look(yaw, 0, true);
  await sleep(faceDuration);
}

async function performRandomPulse(bot, _watcher, { faceDuration = 150, pulseDuration = 150, postMoveDelay = 100 } = {}) {
  const randomYaw = Math.random() * 2 * Math.PI;
  bot.look(randomYaw, 0, true);
  await sleep(faceDuration);
  bot.setControlState('forward', true);
  await sleep(pulseDuration);
  bot.setControlState('forward', false);
  await sleep(postMoveDelay);
}

// ── SECTION 5: Precision Positioning ──

async function microCenter(bot, opts = {}) {
  if (!bot || !bot.entity || !bot.entity.position) return false;
  const CENTER_EPS = opts.eps ?? 0.08;
  const BASE_TAP_MS = opts.tapMs ?? 60;
  const CENTER_MAX_ITERS = opts.maxIters ?? 80;
  const SETTLE_SLEEP = opts.settleSleep ?? 50;
  const startPos = bot.entity.position;
  const anchorX = Math.floor(startPos.x);
  const anchorY = Math.floor(startPos.y);
  const anchorZ = Math.floor(startPos.z);
  // Centering is X/Z only — a floor is a floor whatever its height. A fence/wall/gate top has no
  // centerable cell: its 1.5-block collision leaves a narrow off-grid top the bot slides across, so
  // this bails immediately; otherwise every forward-tap overshoots and the loop burns to max_iters.
  const groundBelow = bot.blockAt(new Vec3(anchorX, anchorY - 1, anchorZ));
  const groundName = groundBelow && groundBelow.name;
  if (groundName && (/_fence$/.test(groundName) || /_fence_gate$/.test(groundName) || /_wall$/.test(groundName))) {
    watcher.warn('motion_primitives', `microCenter skipped — standing on ${groundName} at (${anchorX},${anchorY - 1},${anchorZ}); a fence/wall top has no centerable cell.`);
    return false;
  }
  // Centring targets the cell the centre is in now. A body held on a rim with its centre over a
  // cell that has no floor is walked off the rim by this press; that is named here as it starts.
  if (!groundBelow || groundBelow.name === 'air' || groundBelow.boundingBox === 'empty') {
    watcher.warn('motion_primitives', `microCenter over no floor: centring on (${anchorX},${anchorY},${anchorZ}) with ${groundName || 'unloaded'} under it, body at (${startPos.x.toFixed(2)},${startPos.y.toFixed(2)},${startPos.z.toFixed(2)}).`);
  }
  let prevDist = Infinity;
  for (let i = 0; i < CENTER_MAX_ITERS; i++) {
    const pos = bot.entity.position;
    const dx = (anchorX + 0.5) - pos.x;
    const dz = (anchorZ + 0.5) - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < CENTER_EPS) return true;
    let tapMs;
    if (dist > 0.9)       tapMs = BASE_TAP_MS;
    else if (dist > 0.6)  tapMs = BASE_TAP_MS * 0.7;
    else if (dist > 0.35) tapMs = BASE_TAP_MS * 0.5;
    else if (dist > 0.2)  tapMs = BASE_TAP_MS * 0.35;
    else                  tapMs = BASE_TAP_MS * 0.25;
    if (dist > prevDist + 0.02) tapMs = Math.max(15, tapMs * 0.4);
    prevDist = dist;
    tapMs = Math.max(12, Math.min(tapMs, BASE_TAP_MS));
    // ── THE LEGS STEER; THE TORSO IS LEFT ALONE ──────────────────────────────
    // pressHeading takes no facing parameter, so centring strafes toward the anchor while the body keeps
    // whatever yaw it already holds — centring is never a second writer of the yaw (Invariant D).
    await pressHeading(bot, { x: dx, z: dz }, tapMs);
    await sleep(SETTLE_SLEEP);
  }
  watcher.warn('motion_primitives', `microCenter ⛔ max_iters anchor=(${anchorX},${anchorY},${anchorZ})`);
  return false;
}

// Guards THE dominant pillar stall: a caller digs the block underfoot and asks to pillar while
// the bot is still falling, so the jump-place mistimes against a moving body. pillarStep decides
// WHEN to begin — only after landing/settling, or this timeout (→ not_settled, retry waits again).
const SETTLE_TIMEOUT_MS = 3000;
// onGround is the real fall gate; this eps only has to clear the residual STANDING drift. A bot
// idle on the ground reads ~0.078 blocks/tick (never true 0), so 0.05 never passes (spins on
// not_settled). 0.15 clears idle drift yet stays below walking (~0.21), so it still rejects mid-stride.
const SETTLE_SPEED_EPS = 0.15;
async function waitUntilSettled(bot, opts = {}) {
  const timeout = opts.settleTimeoutMs || SETTLE_TIMEOUT_MS;
  const eps = opts.settleSpeedEps || SETTLE_SPEED_EPS;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const e = bot.entity;
    if (e) {
      const v = e.velocity || { x: 0, y: 0, z: 0 };
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (e.onGround && speed < eps) return true;
    }
    await sleep(50);
  }
  return false;
}

module.exports = {
  clearMotion,
  tapForward,
  pressHeading,
  headingKeys,
  quantizeYaw,
  quantizeYawSticky,
  yawToward,
  YAW_HYSTERESIS_RAD,
  jumpTap,
  faceTarget,
  performRandomPulse,
  microCenter,
  waitUntilSettled,
};
