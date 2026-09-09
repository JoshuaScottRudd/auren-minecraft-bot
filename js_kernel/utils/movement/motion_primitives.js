// module: movement/motion_primitives — the raw button presses and the settle gate.
// One verb apiece: release the controls, tap forward, tap jump, face a point, pulse, centre on a cell,
// wait until the body has stopped moving. No pathing, no terrain reasoning, no placing.
//
// A leaf, and it must stay one. Everything above it (drive, scaffold) composes these; if a primitive
// ever starts deciding WHERE to press, it has taken a caller's job and the caller can no longer be
// held to its own outcome (Invariant D).

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { sleep } = require('@utils/fragment_utils');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');

// ── SECTION 4: Core Motion Primitives ──

// The explicit per-control releases are NOT wrapped: bot.setControlState only throws on
// `assert.ok(control in controlState)` / `assert.ok(typeof state === 'boolean')` (mineflayer
// physics.js:245-247) — both assertions on OUR arguments, and every one below is a hardcoded literal.
// A throw here is therefore a typo, i.e. a Law 13 coding violation that must surface, not be swallowed
// forever. clearControlStates() DOES keep a boundary: it loops every control including 'sprint', which
// writes entity_action off bot.entity.id and genuinely throws when the bot is dead/despawned.
function clearMotion(bot) {
  const cleared = guardExternalSync('motion_primitives', 'clearControlStates',
    () => bot.clearControlStates && bot.clearControlStates());
  void cleared;   // the explicit releases below run either way; the warn is the record that it threw
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
// The plan: force the yaw onto a cardinal/ordinal grid, then drive with WSAD relative to that facing
// (at most two keys at once) instead of turning the body to steer.
//
// The plan is exact for this tree: `pathfinding_utils.CARDINAL` is the ONLY neighbour set A* expands,
// four entries, and every edge type (walk, climb, swim, dig) is generated inside that one loop. No
// planned route contains a horizontal diagonal. So a body that can travel the four cardinals plus the
// four 45° combinations can execute any plan this fleet produces, exactly, with the yaw free.
//
// WHY THIS EXISTS AT ALL: `tapForward` is the only press the tree has ever made — a tree-wide search
// for setControlState('back'|'left'|'right', …) returns two hits, both `false`, both inside
// clearMotion, and 'back' appears nowhere. Steering has therefore always been done by turning the body,
// which makes the yaw carry two jobs (where to look, where to go) with two writers. Combat symptoms
// that trace back to a contested yaw — an orbiting facing that stalls kill time, a look-then-walk that
// leaves the bot's back to the mob it is fighting — are downstream of that one overload. Pressing the
// other three keys is what separates the jobs.
//
// THE MATH IS NOT A MODEL OF MINECRAFT, IT IS THE ENGINE'S OWN (prismarine-physics/index.js:743 and
// applyHeading:420). Physics builds `strafe = right - left`, `forward = forward - back`, then rotates
// that pair by the body's yaw. Substituting the engine's `yaw' = π - yaw` gives the world displacement
// directly:
//     Δx = strafe·cos(yaw) − forward·sin(yaw)
//     Δz = −forward·cos(yaw) − strafe·sin(yaw)
// which is the pair of unit axes below. Derived rather than assumed, because a sign error here is
// silent and would look like a pathing bug for a week.
//
// DIAGONALS ARE NOT FASTER: applyHeading normalises (`speed = √(strafe²+forward²)`, then
// `multiplier / max(speed,1)`), so all eight combinations travel at one speed. Nothing to calibrate.
const HEADING_QUANTA = 8;
const QUANTUM_RAD = (2 * Math.PI) / HEADING_QUANTA;
// cos(67.5°) — the half-angle between adjacent 8-point directions. A component above this is nearer to
// pressed than to released, which is what makes the mapping the NEAREST of the eight rather than a
// threshold anyone tuned.
const PRESS_THRESHOLD = Math.cos((3 * Math.PI) / 8);

// quantizeYaw(yaw) → the nearest of the 8 compass points, in the same convention faceTarget writes
// (`atan2(-dx, -dz)`, so 0 faces −Z). Snapping is deliberate and it is what makes the key mapping exact:
// with both the facing and the heading on the 8-point grid, `headingKeys` below can only ever produce a
// component of 0, ±0.7071 or ±1 — never a value near the threshold, so no press is ever borderline.
function quantizeYaw(yaw) {
  return Math.round(yaw / QUANTUM_RAD) * QUANTUM_RAD;
}

// yawToward(from, to) → the quantized yaw that faces `to`. The un-quantized form is faceTarget's, kept
// identical on purpose: two facing conventions in one tree is the sign error above waiting to happen.
function yawToward(from, to) {
  return quantizeYaw(Math.atan2(-(to.x - from.x), -(to.z - from.z)));
}

// ── quantizeYawSticky — a hysteresis band around the yaw quantum, to stop stutter ───────────────────
//
// A plain `round(bearing / 45°)` snaps at the midpoint, so a mob sitting ON a boundary — circling the bot
// at a near-constant bearing, which is exactly what a mob pathing around a tree does — flips the facing
// every pass. A cooldown would fix the symptom by refusing to move a facing that has genuinely gone
// stale, but it makes correctness depend on WHEN the last switch happened, so the same geometry gives
// different answers on different passes and a wrong facing cannot be reproduced. A band avoids that:
// hysteresis is a pure function of the bearing and the facing currently held — same inputs, same answer,
// forever (Invariant C).
//
// THE MARGIN HAS A HARD CEILING AND IT IS ARITHMETIC, not taste. Snapping alone already costs the
// half-quantum (22.5°), which the 8-point ruling accepts. The margin adds to it, so the worst facing
// error is 22.5° + margin — and at margin = 22.5° the held facing survives a bearing sitting exactly on
// the NEXT octant's centre, i.e. a full octant wrong, permanently. So the margin is strictly bounded by
// the half-quantum, and anything approaching it converts stutter-suppression into a stuck facing.
// 7.5° is a third of that ceiling: worst case 30°, which trims the oscillation band to ±7.5° of the
// boundary while leaving 15° of headroom before the pathology.
//
// What would falsify the choice: a fight where the journal shows the facing switching on consecutive
// passes with the bearing moving less than 15°. That is the stutter this is sized against, and it is
// visible in the record rather than a matter of opinion.
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
// The sibling of `tapForward`, and the reason it is a sibling rather than a flag on it: tapForward's
// contract is "press the key I have already aimed at", which is the coupling this removes. Same release
// discipline — the `finally` is what stops a throw mid-step leaving the body walking (Law 8).
//
// IT CANNOT WRITE THE YAW, AND THAT IS THE POINT: the driver (combat navigation) never touches the yaw,
// only responds to it. An earlier build took an `opts.faceYaw` and called `bot.look` when given one —
// still a driver writing the facing, once per leg instead of once per poll. There is no longer a
// parameter to pass: the ONLY way to steer the body is to aim it first, through the gunner, and this
// reads whatever the gunner left.
//
// A GUARANTEE, NOT A CHECK (Law 26). A rule saying "the driver must not pass faceYaw" is a catch — it
// depends on every future call site obeying it, and the failure is silent. Deleting the parameter makes
// the mistake unrepresentable, which is the stronger form and the reason it was deleted rather than
// defaulted.
//
// THE YAW IS READ RAW, NOT QUANTIZED. Snapping the read to the nearest octant would be this function
// asserting where the body is facing instead of asking, and if anything ever leaves the yaw off-axis the
// snapped answer sends the body off at up to 22.5° from the heading requested — a drift that looks like
// a pathing fault. The trig below is exact for any yaw; the 8-point discipline is the GUNNER's promise
// about what it writes, never an assumption the driver is entitled to make about what it finds.
async function pressHeading(bot, heading, ms = 150) {
  const yaw = bot.entity.yaw;                     // fresh every call — Invariant B, and the whole contract
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
  // Centering is purely X/Z — it aligns the bot to the center of the cell it stands IN and never
  // touches Y (a floor is a floor whatever its height). The one place that assumption breaks is a
  // tall non-full block (fence/wall/gate): its 1.5-block collision leaves a narrow off-grid top the
  // bot slides across, so every forward-tap overshoots and the loop burns to max_iters. Bail on
  // sight instead — the real fix is not standing there (isWalkableSurface now rejects fences), this
  // is the belt-and-suspenders so a stray call is a fast diagnostic, not a 4-second spin.
  const groundBelow = bot.blockAt(new Vec3(anchorX, anchorY - 1, anchorZ));
  const groundName = groundBelow && groundBelow.name;
  if (groundName && (/_fence$/.test(groundName) || /_fence_gate$/.test(groundName) || /_wall$/.test(groundName))) {
    watcher.warn('motion_primitives', `microCenter skipped — standing on ${groundName} at (${anchorX},${anchorY - 1},${anchorZ}); a fence/wall top has no centerable cell.`);
    return false;
  }
  let prevDist = Infinity;
  for (let i = 0; i < CENTER_MAX_ITERS; i++) {
    const pos = bot.entity.position;
    const dx = (anchorX + 0.5) - pos.x;
    const dz = (anchorZ + 0.5) - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < CENTER_EPS) {
      await guardExternal('motion_primitives', 'lookAt centre anchor', () => bot.lookAt(new Vec3(anchorX + 0.5, pos.y + 0.2, anchorZ + 0.5), true));
      return true;
    }
    let tapMs;
    if (dist > 0.9)       tapMs = BASE_TAP_MS;
    else if (dist > 0.6)  tapMs = BASE_TAP_MS * 0.7;
    else if (dist > 0.35) tapMs = BASE_TAP_MS * 0.5;
    else if (dist > 0.2)  tapMs = BASE_TAP_MS * 0.35;
    else                  tapMs = BASE_TAP_MS * 0.25;
    if (dist > prevDist + 0.02) tapMs = Math.max(15, tapMs * 0.4);
    prevDist = dist;
    tapMs = Math.max(12, Math.min(tapMs, BASE_TAP_MS));
    await guardExternal('motion_primitives', 'lookAt centre anchor', () => bot.lookAt(new Vec3(anchorX + 0.5, pos.y + 0.2, anchorZ + 0.5), true));
    bot.setControlState('forward', true);
    await sleep(tapMs);
    bot.setControlState('forward', false);
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

// ── Apex placement ────────────────────────────────────────────────────────────────────────────
// A block can only be placed in water at the absolute apex of the water bob. The apex was DETECTED
// correctly by the old waitForApex, and then three separate latencies fired the packet long after it,
// at an interval that varied per call — which is what made a correctly-detected apex behave like a
// random timer:
//   1. `bot.placeBlock` re-aims internally with a NON-forced lookAt (place_block.js → generic_place.js
//      passes no forceLook), and a non-forced look slews the rotation a few degrees per tick and
//      AWAITS arrival. The place packet therefore left an unbounded number of ticks after the crest —
//      by which time the body had bobbed back down INTO the target cell and the server rejected it.
//   2. The caller's own `await bot.lookAt(..., true)` before the place aimed at a DIFFERENT point than
//      the one placeBlock computes, so it guaranteed a non-zero delta for (1) to slew rather than
//      pre-satisfying it.
//   3. On a miss, `bot.placeBlock` waits up to 5 s for a blockUpdate that never comes — longer than the
//      whole hold duration — so the "re-fire on the NEXT crest" retry never actually got a second crest.
//      One shot per attempt, dressed as a retry loop.
// Fix: aim ONCE at the exact face point mineflayer would compute, keep it forced-current every tick,
// detect the crest ON the physics tick, and fire the raw `_genericPlace` packet from the 'move'
// handler with NO await between detection and the write. 'move' is emitted from inside the position
// packet send, so the apex position reaches the server immediately before the place — the ordering
// the server needs to see the feet clear of the cell. Confirmation is then polled off the world
// (Law 23: verify against sensed reality) instead of blocking on placeBlock's round trip, so a miss
// costs one tick and the next crest gets a real shot.

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
