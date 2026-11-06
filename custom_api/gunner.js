// The tank crew's gunner: owns the body's FACING and when it SWINGS, at tick rate. Decides nothing about
// where the body goes. start(bot) attaches a physicsTick handler; stop(bot) detaches it. While ENGAGED,
// re-reads the commander's target off crew_board every tick and snaps facing to one of eight compass
// points with a hysteresis band. ONLY writer of the yaw during an engagement (Invariant D). Never reads a
// plan, presses a movement key, sets sprint, or touches jump.
// NOTHING IN THIS FILE MAY AWAIT: an awaiting seat yields to the next tick and the crew rotation crosses
// itself; `combat_utils.equipBestWeapon` is a real server round trip, so SECTION 4b fires it un-awaited behind a
// pending latch. Knockback lives entirely in the driver: sprint is the driver's key, never this seat's.

'use strict';

const crewBoard = require('@api/crew_board');
const combatUtils = require('@utils/combat_utils');
const { quantizeYawSticky, YAW_HYSTERESIS_RAD } = require('@utils/movement/motion_primitives');
const { BOT_STRIKE_REACH } = require('@utils/combat_utils');
// Imports only each threat's time-to-land deadline, never the raw notch/swell decode (Law 16).
const { BOW_DRAW_MS, arrowFlightMs } = require('@utils/calculators/archer_calculator');
const { SWELL_TO_BLAST_MS } = require('@api/combat_counters/fuse_meter');
// The skeleton family, the mobs that keep their distance: guarded only at the notch, never on approach.
const { MOB_AGGRO_RANGE } = require('@thinking/architect_config');
const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');
const { guardExternalSync } = require('@utils/external_library_guard');
const Vec3 = require('vec3');
// The two terrain verbs, read from the modules that own them (Law 16); this seat supplies only facing/timing.
const { performDig } = require('@utils/movement/dig_authority');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { performPlace } = require('@utils/movement/place_authority');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');
const { isBlockSolid } = require('@utils/pathfinding_utils');
const { isReplaceable } = require('@utils/movement/terrain_predicates');

const TAG = 'gunner';

// ── WHO THIS ARM HAS ACTUALLY LANDED ON — mob id → count of released swings that connected ──────────
// The kill-attribution fact: `battle_stations.retireTarget` reads it at every retirement (Law 25). Keyed
// by mob and never cleared mid-run — an entity is the unit, not the engagement.
const _connected = new Map();

// connectedTo(mobId) → how many of this arm's released swings landed on that mob.
function connectedTo(mobId) { return _connected.get(mobId) || 0; }
const writeBoard = crewBoard.claimPen('gunner');

// ---------------------------------------------------------------------------
// SECTION 1: State
// ---------------------------------------------------------------------------
// Module-level: one gunner per process. Reset at every engagement boundary (Law 8).
let attached = false;
let tickHandler = null;
let engaged = false;

// Held facing (radians) — the `held` half of the hysteresis.
let heldYaw = null;
let targetId = null;

// Cooldown cached against held-item name (equips change the name; 20 inventory scans/s buys nothing).
let cachedWeaponName = null;
let cachedCooldownMs = 625;

// EQUIP LATCH (SECTION 4b). `equipPending` marks a swap IN FLIGHT (Invariant B). `armedThisEngagement` covers
// the first swing of a fight, which a per-swing-only check would miss.
let equipPending = false;
let armedThisEngagement = false;

// SHIELD LATCH. `shieldUp` = what was COMMANDED, not what the server did (Law 25).
let threatId = null;
let threatWhy = null;
let shieldUp = false;
let shieldUpAt = null;      // when the raise packet went out; the `held` half of the guard's cost
let shieldClearAt = null;   // when the threat stopped; the shield holds SHIELD_HOLD_MS past it
let resumingGuard = false;  // the approach guard was lowered for one swing and its next raise resumes it
let loweredAt = null;        // ms the shield last came down (THE LOWERING, lowerForSwing)
let lowerUnswung = false;    // lowered for a swing that has not been thrown yet
let kbSince = null;         // tick a knockback swing at a melee focus began waiting for sprint, or null
const KNOCKBACK_WAIT_TICKS = 3;
// A KNOCKBACK SWING ONCE BEGUN IS THROWN: the reach gate is read when the wait starts, and only an arrow, a friend in the
// sweep or the mob leaving strike reach calls it off. A wait re-judged every tick flaps the shield down and up on a mob
// whose distance jitters across the gate, and a shield raised for under 5 ticks blocks nothing. A called-off wait is
// not begun again for KNOCKBACK_RETRY_TICKS, so the re-raised shield stands long enough to block.
const KNOCKBACK_RETRY_TICKS = 10;
let kbRetryTick = 0;

let stats = null;
function _blankStats() {
  return {
    ticks: 0,            // ticks the gunner ran while engaged
    aimed: 0,            // ticks a facing was WRITTEN (a quantum boundary was crossed)
    heldSteady: 0,       // ticks the band kept the existing facing though the bearing had moved
    switches: 0,         // same as `aimed`, kept separate because `aimed` counts the first aim too
    noTarget: 0,         // ticks engaged with no hostile in the entity table
    inReach: 0,          // ticks the closest mob was inside the strike reach
    charged: 0,          // ticks inside reach AND the swing clock was full
    swings: 0,           // packets actually released — the BOARD reads this
    swingsHeld: 0,       // ticks the arm was withheld because the guard was up — the price of his premise
    equipChecks: 0,      // times the hand was examined (every swing, plus once at engage)
    equipFails: 0,       // swaps that came back empty-handed — no weapon anywhere in the pack
    barehandedSwings: 0, // swings released with an empty main hand
    sweepWithheldTicks: 0, // ticks in reach with a friend inside the sweep, so no swing was sent
    wallsTried: 0, wallsSet: 0, wallsFailed: 0, wallsStanding: 0, wallTicks: 0,   // THE BLAST WALL
    fleeTicks: 0,   // ticks the body faced its run (A RUNNING BODY FACES ITS RUN)
    // The terrain errand's counters (Law 6): accepted−(done+failed+dropped) is the number in flight.
    terrainAccepted: 0,  // asks this seat took on
    terrainRefused: 0,   // asks turned away because the yaw was spoken for
    terrainDone: 0,      // jobs the seat believes changed the world — a claim, verified by the asker
    terrainFailed: 0,    // jobs attempted and not achieved
    terrainDropped: 0,   // jobs abandoned mid-flight because the want changed or stopped
    fastSwitches: 0,     // switches < STUTTER_GAP_TICKS apart — a working band drives this to 0
    minSwitchGapTicks: null,
    guardTicks: 0,       // SHIELD AUDIT (SECTION 2b), ticks only — raise/lower events carry the counts
    settleTicks: 0,            // guard ticks spent in the 5-tick hold AFTER the threat cleared
    swingLowers: 0,            // approach guards lowered for one swing (lowerForSwing)
    knockbackSwings: 0,        // swings at a melee focus thrown with the driver's sprint held
    lowersUnswung: 0,          // shield lowered for a swing and raised again with none thrown
    knockbackAborted: 0,       // knockback waits called off before the swing (an arrow, a friend, the mob out of reach)
    knockbackUnsprinted: 0,    // knockback swings thrown at KNOCKBACK_WAIT_TICKS without sprint
    knockbackWaitTicks: 0,     // ticks a knockback swing waited, shield down, for sprint
    facedThreatOverClosest: 0, // ticks the facing was on something other than the nearest active mob
    guardArcTicks: 0,          // ticks the guard faced the middle of every blow's arc
    guardSplitTicks: 0,        // ticks the blows spread wider than one window and the most-covering window was faced
    swingsIntoArrow: 0,        // ticks a charged swing waited because a draw or an arrow would land in its window
    swingsInReach: 0,          // ticks a charged swing waited because a melee mob in its reach had not just swung
    lastSwingAt: null,
  };
}
let lastSwitchTick = null;
// The terrain job IN FLIGHT — never a queued request (see serveTerrain).
let _job = null;
// dropJob — a job dropped while its dig is still swinging stops that dig, so the next dig the body starts
// begins clean instead of cancelling a break nobody is waiting on (mineflayer aborts a dig a new one replaces).
function dropJob(bot) {
  if (_job && !_job.settled && _job.kind === 'dig' && bot && bot.targetDigBlock) {
    guardExternalSync(TAG, 'stopDigging for a dropped terrain job', () => bot.stopDigging());
  }
  _job = null;
}
const STUTTER_GAP_TICKS = 4;   // 200 ms — two switches closer together than this are the judder

// ---------------------------------------------------------------------------
// SECTION 2: The two acts
// ---------------------------------------------------------------------------

// focusTarget() → the crew's COMMITTED target (commander's `focus`), or null. Monster data is derived
// only by the commander, which owns it (Law 16).
function focusTarget() {
  return crewBoard.readCommander().focus;
}

// ---------------------------------------------------------------------------
// SECTION 2b: The shield
// ---------------------------------------------------------------------------
// Three shield cases, all needing a shield in the off-hand (combat_utils.holdsShield):
//   notched_arrow — a TIMER, not a toggle: raises just before the arrow lands and lowers 5 ticks after the threat
//     clears; swell raises on its first tick (raiseAtOf). A skeleton keeps its distance, so against the skeleton family
//     this is the only guard.
//   approach — every other aggroed mob closes to melee, so the guard is up the whole time it is active and comes down
//     only for the tick of a charged swing (onPhysicsTick). A creeper is tanked behind it, not run from (driver).
// Triggers are server-read, not modelled (Law 23): the commander posts id lists (`swelling`, `notching`, `active`),
// sole announcer of combat data (Law 16). Only a positive signal raises (Law 25).
const SHIELD_ACTIVE_MS = 250;   // 5 ticks between the raise and the first block

// How long before the threat's deadline the raise fires (MARGIN) and how long the shield holds after the
// threat clears (HOLD), covering the arrow still in flight. Neither floors at 0.
const SHIELD_MARGIN_MS = 150;
const SHIELD_HOLD_MS = 150;

// shieldOrder({ threats, now }) → { guard, why, against, againstName, since }. Pure decision, no
// bot/packets (Law 16). `threats` = [{ id, why, since }]. Picks the EARLIEST threat.
// A deadline threat (notch, swell) outranks an approach: it sets the raise's timing, and takes the facing only when no
// mob is in focus (onPhysicsTick); an approach alone guards at once and leaves the facing to the focus (`against: null`).
function shieldOrder({ threats, now }) {
  if (!threats || !threats.length) {
    return { guard: false, why: null, against: null, againstName: null, since: null };
  }
  const timed = threats.filter(t => t.why !== 'approach');
  const approach = threats.filter(t => t.why === 'approach');
  const approachOrder = () => ({
    guard: true, why: 'approach', against: null, againstName: null,
    since: approach.reduce((m, t) => Math.min(m, t.since), Infinity),
  });
  if (!timed.length) return approachOrder();
  let first = timed[0];
  for (const t of timed) if (t.since < first.since) first = t;
  const name = (first.entity && first.entity.name) || 'mob';
  // A deadline shorter than the raise cost has no late moment — guard at once (Law 13).
  const guard = raiseAtOf(first) <= 0 ? true : (!!first.inFlight || now - first.since >= raiseAtOf(first));
  // A draw not yet due never lowers the guard a melee mob already holds up.
  if (!guard && approach.length) return approachOrder();
  return { guard, why: first.why, against: first.id, againstName: name, since: first.since };
}

// A deadline threat's time to land from its start, and when its raise is due.
function deadlineOf(t) { return t.why === 'swell' ? SWELL_TO_BLAST_MS : BOW_DRAW_MS; }
// A swell is guarded from its first tick: the client sees it late (a 1382 ms fuse measured against the 1500 ms one), so
// a timed raise came up with less than SHIELD_ACTIVE_MS to spare, and a swing inside a fuse rarely kills the creeper.
function raiseAtOf(t) { return t.why === 'swell' ? 0 : deadlineOf(t) - (SHIELD_ACTIVE_MS + SHIELD_MARGIN_MS); }
// hot(t, now) → this draw's blow can land before a shield raised now would block, or its arrow is in the air.
function hot(t, now) { return t.why !== 'approach' && (!!t.inFlight || now - t.since >= raiseAtOf(t)); }

// ── NO SWING INTO AN ARROW ──────────────────────────────────────────────────────────────────────────
// A swing lowers the shield for up to SWING_EXPOSURE_MS: the wait for sprint, the swing tick, and the five ticks a
// re-raised shield takes to block again. No swing is thrown while any mob's draw would land inside that window or
// an arrow is in the air; the arm waits behind the shield and swings once the blow has been blocked.
const SWING_EXPOSURE_MS = 500;
// ── THE MELEE CADENCE: STRIKE FIRST ONLY OUT OF REACH, ELSE STRIKE BACK AFTER ITS BLOW ──────────────────────────
// A swing drops the shield, and the re-raised shield blocks only once it has been up 5 ticks: SHIELD_BACK_MS from the
// swing. A melee mob that can be inside MOB_REACH_B by then would land its blow on an open guard, so the swing waits:
// the mob's distance less what it closes in SHIELD_BACK_MS (commander `closing`) must stay outside its reach. A mob
// that has swung within SAFE_AFTER_SWING_MS has spent its blow on the shield and attacks again only after its 20-tick
// cooldown, so the swing back is open whatever its distance.
const MOB_REACH_B = 2.3;
const SHIELD_BACK_MS = 400;
const SAFE_AFTER_SWING_MS = 450;
function meleeOpen(board, now) {
  for (const h of board.active || []) {
    if (h.name in MOB_AGGRO_RANGE || combatUtils.combatTactic(h.name, h.entity) !== 'BRAWLER') continue;
    if (h.swungAt != null && now - h.swungAt <= SAFE_AFTER_SWING_MS) continue;
    const reachIn = h.distance - Math.max(0, h.closing || 0) * (SHIELD_BACK_MS / 1000);
    if (reachIn <= MOB_REACH_B) return h;
  }
  return null;
}

function swingBlocked(threats, now) {
  return threats.some((t) => t.why !== 'approach'
    && (!!t.inFlight || now - t.since >= deadlineOf(t) - SWING_EXPOSURE_MS - SHIELD_MARGIN_MS));
}

// ── THE GUARD FACES THE BLOWS, NOT ONLY THE FOCUS ───────────────────────────────────────────────────
// The shield blocks every blow whose source stands within 90° of the facing (BlocksAttacks: one reduction, angle 90),
// a 180° front half. While the guard is up the body faces the GUARD_COVER_RAD window that covers the most of what can
// hit it now: every due draw and arrow in the air, and every melee mob within MELEE_HIT_B, a melee mob within
// MELEE_CLOSE_B weighing double (its blow is the next one). It faces the middle of the covered mobs' own arc, so the
// margin to the cone's edge is the same on both sides. The window is held 20° inside the cone for the lag between
// the client's view of a mob and the server's. The swing turns back to the focus on its own tick (onPhysicsTick).
const MELEE_GUARD_B = 3.5;   // a melee mob this near is guarded against whether or not it is the focus
const MELEE_HIT_B = 2.5;     // a melee mob this near can land its blow in the next moment
const MELEE_CLOSE_B = 2.0;
const GUARD_COVER_RAD = (160 * Math.PI) / 180;
function bearingTo(me, pos) { return Math.atan2(-(pos.x - me.x), -(pos.z - me.z)); }
function guardBearing(bot, threats, now) {
  const me = bot.entity && bot.entity.position;
  if (!me) return null;
  const set = threats.filter((t) => t.entity && t.entity.position
    && (hot(t, now) || (t.why === 'approach' && t.distance <= MELEE_HIT_B)));
  if (!set.length) return null;
  const TWO_PI = 2 * Math.PI;
  const pts = set.map((t) => ({
    a: ((bearingTo(me, t.entity.position) % TWO_PI) + TWO_PI) % TWO_PI,
    w: t.why === 'approach' && t.distance <= MELEE_CLOSE_B ? 2 : 1,
  }));
  // Every window starts on some threat's bearing; the best one covers the most weight, then the narrowest arc.
  let best = null;
  for (const s0 of pts) {
    let w = 0, arc = 0;
    for (const p of pts) {
      const off = (p.a - s0.a + TWO_PI) % TWO_PI;
      if (off <= GUARD_COVER_RAD) { w += p.w; if (off > arc) arc = off; }
    }
    if (!best || w > best.w || (w === best.w && arc < best.arc)) best = { w, arc, from: s0.a };
  }
  if (best.w === pts.reduce((m, p) => m + p.w, 0)) stats.guardArcTicks++; else stats.guardSplitTicks++;
  return best.from + best.arc / 2;
}

// senseThreats(board, now) → [{ id, why, since, entity }] for the commander's focus when it is notching, swelling
// or a melee mob closing, stamped with when ITS OWN current threat began. Decodes nothing (Law 16 — commander is
// sole announcer); turns a per-tick fact into a DURATION, which a stateless sweep can't hold.
// `drawStarts` dates every active mob's notch or swell, focus or not, so a draw begun while another mob held the
// focus keeps its true start when the focus moves onto it. `threatStarts` dates only the focus's approach. Both are
// per-MOB and pruned the moment the fact stops (Invariant B).
const drawStarts = new Map();
const threatStarts = new Map();
// Mobs seen active with no draw on them. A notch or swell on a mob never seen quiet began before this seat could see
// it (a skeleton drawing as the fight opens), so its start is unknown and it is dated at its deadline: the shield
// goes up at once rather than on a fresh draw's timing (Law 13).
const seenQuiet = new Set();
// When each active mob's last notch cleared: the arrow is released, not landed. A focus that moves onto an archer whose
// arrow is still in the air is guarded for that flight, as a guard already up is held for it (applyShield's holdMs).
const releasedAt = new Map();
// EVERY MOB THAT CAN HIT IS GUARDED, the focus or not: the body FIGHTS the closest mob (the commander's focus), but
// its shield answers every draw on the field and every melee mob within MELEE_GUARD_B, so a skeleton notching
// behind the zombie being fought is blocked while the zombie is killed.
function senseThreats(board, now, shielded) {
  const swellingIds = board.swelling || [];
  const notchingIds = board.notching || [];
  const drawOf = (id) => (swellingIds.includes(id) ? 'swell' : notchingIds.includes(id) ? 'notched_arrow' : null);
  const live = new Set();
  for (const h of board.active || []) {
    live.add(h.id);
    const draw = drawOf(h.id);
    if (!draw) {
      const ended = drawStarts.get(h.id);
      if (ended && ended.why === 'notched_arrow') releasedAt.set(h.id, now);
      seenQuiet.add(h.id); drawStarts.delete(h.id); continue;
    }
    const prior = drawStarts.get(h.id);
    if (prior && prior.why === draw) continue;
    const unseenStart = !seenQuiet.has(h.id);
    drawStarts.set(h.id, { why: draw, since: unseenStart ? now - (draw === 'swell' ? SWELL_TO_BLAST_MS : BOW_DRAW_MS) : now });
  }
  for (const id of drawStarts.keys()) if (!live.has(id)) drawStarts.delete(id);
  for (const id of seenQuiet) if (!live.has(id)) seenQuiet.delete(id);
  for (const id of releasedAt.keys()) if (!live.has(id)) releasedAt.delete(id);

  const out = [];
  const focusId = board.focus ? board.focus.id : null;
  for (const h of board.active || []) {
    // SWELL OUTRANKS NOTCH when a mob carries both — its deadline ends the fight, not costs 6 hp.
    const draw = drawStarts.get(h.id);
    if (draw) { out.push({ id: h.id, why: draw.why, since: draw.since, entity: h.entity, distance: h.distance }); continue; }
    if (releasedAt.has(h.id) && now - releasedAt.get(h.id) < SHIELD_HOLD_MS + arrowFlightMs(h.distance)) {
      out.push({ id: h.id, why: 'notched_arrow', since: now - BOW_DRAW_MS, entity: h.entity, distance: h.distance, inFlight: true });
      continue;
    }
    // A mob a squadmate reported across the field: a raised shield walks at a fifth of speed, so it comes up on arrival.
    if (shielded && !(h.name in MOB_AGGRO_RANGE) && ((h.id === focusId && !h.walkTo) || h.distance <= MELEE_GUARD_B)) {
      if (!threatStarts.has(h.id)) threatStarts.set(h.id, now);
      out.push({ id: h.id, why: 'approach', since: threatStarts.get(h.id), entity: h.entity, distance: h.distance });
    }
  }
  for (const id of threatStarts.keys()) if (!out.some((t) => t.id === id && t.why === 'approach')) threatStarts.delete(id);
  return out;
}

// The hold after a notch clears: the arrow was released, not landed, so the shield stays up for its flight over
// the gap it was drawn across (archer_calculator.arrowFlightMs), plus the settle.
let holdMs = SHIELD_HOLD_MS;

// applyShield(bot, order, now, gap) — the only place the shield is raised or lowered. Lower is latched, raise
// is not: threat clearing means the arrow was RELEASED not landed. activateItem(true) = offhand.
// `gap` is the threat's distance this tick, or null. `holdDown`: a knockback swing is pending, so a lowered
// shield is not raised again until it is thrown.
function applyShield(bot, order, now, gap, holdDown) {
  if (order.guard && holdDown && !shieldUp) return;
  if (order.guard) {
    shieldClearAt = null;
    holdMs = order.why === 'notched_arrow' && Number.isFinite(gap) ? SHIELD_HOLD_MS + arrowFlightMs(gap) : SHIELD_HOLD_MS;
    threatId = order.against;
    threatWhy = order.why;
    if (!shieldUp) {
      // A refused raise leaves the latch DOWN, so the next tick tries again (Law 25).
      if (!guardExternalSync(TAG, 'activateItem to raise the shield', () => bot.activateItem(true)).ok) return;
      shieldUp = true;
      if (lowerUnswung) { stats.lowersUnswung++; lowerUnswung = false; }
      // The guard resuming after a swing keeps the raise's original time and says nothing (lowerForSwing).
      if (resumingGuard) { resumingGuard = false; stats.guardTicks++; return; }
      shieldUpAt = now;
      // `waited` is how long the raise lagged behind the threat's start.
      crewLog.event(TAG, 'shield', {
        subject: order.against !== null ? `${order.againstName}#${order.against}` : null,
        state: 'up', why: order.why, waited: `${now - order.since}ms`,
      });
    }
    stats.guardTicks++;
    return;
  }
  if (!shieldUp) {
    // A guard that ended while lowered for a swing closes here, so every logged raise has its lower.
    if (resumingGuard) crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms`, by: 'swing' });
    threatId = null; threatWhy = null; resumingGuard = false;
    return;
  }
  if (shieldClearAt === null) { shieldClearAt = now; threatWhy = 'settling'; }
  if (now - shieldClearAt < holdMs) { stats.guardTicks++; stats.settleTicks++; return; }
  guardExternalSync(TAG, 'deactivateItem to lower the shield', () => bot.deactivateItem());
  loweredAt = now; lowerUnswung = false;
  // `held` is the cost side: ms the arm could not swing while the guard was up.
  crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms` });
  shieldUp = false;
  shieldUpAt = null;
  shieldClearAt = null;
  threatId = null;
  threatWhy = null;
}

// aim(bot, target) → true when a facing was written this tick.
// Bearing is continuous, facing is one of eight (`quantizeYawSticky`). The write is CONDITIONAL so the facing holds
// until the bearing leaves its hysteresis. `bot.look` sends nothing itself: mineflayer's physics tick sends at most one
// movement packet a tick, and a rotation only when it changed, so a repeated yaw costs the server nothing.
function aim(bot, target) {
  const me = bot.entity.position;
  const dx = target.position.x - me.x;
  const dz = target.position.z - me.z;
  if (Math.hypot(dx, dz) < 1e-3) return false;   // standing in the same column: no bearing to take
  const bearing = Math.atan2(-dx, -dz);          // the fleet's one facing convention (motion_primitives)
  const want = quantizeYawSticky(bearing, heldYaw, YAW_HYSTERESIS_RAD);
  if (heldYaw !== null && want === heldYaw) return false;
  // PITCH HELD LEVEL, decided not omitted: nothing reads it (server resolves the hit by entity id).
  // heldYaw is only advanced on a facing that was actually written (Law 25).
  if (!guardExternalSync(TAG, `look to yaw ${want.toFixed(3)}`, () => bot.look(want, 0, true)).ok) return false;
  heldYaw = want;
  return true;
}

// fire(bot, target, distance) → true when a packet left. Adds the reach test before `swingNow`'s own
// check and the charge gate. The swing packet is still sent in one place in this fleet (Law 16).
// cooldownInHand(bot) → the swing cooldown of the item IN HAND, not the best in pack. Name-keyed cache: an unchanged
// hand costs one string compare.
function cooldownInHand(bot) {
  const heldName = bot.heldItem && bot.heldItem.name;
  if (heldName !== cachedWeaponName) {
    cachedWeaponName = heldName;
    const choice = combatUtils.pickBestWeapon(bot);
    cachedCooldownMs = (choice && choice.profile && choice.profile.cooldownMs) || 625;
  }
  return cachedCooldownMs;
}

// swingReady(bot, distance) → true when fire() would send a swing this tick: the focus in reach and the arm charged.
// readyIn(bot) → ms until the weapon in hand is fully charged, 0 when it is (published for the driver's kite).
function readyIn(bot) {
  const since = combatUtils.msSinceLastSwing();
  return since === Infinity ? 0 : Math.max(0, Math.round(cooldownInHand(bot) - since));
}

function swingReady(bot, distance) {
  return distance <= BOT_STRIKE_REACH && combatUtils.chargeNow(cooldownInHand(bot)) >= 1;
}

// lowerForSwing(bot) — drops the approach guard for one swing. Counted, not logged: it happens on every swing of a
// shielded fight, and the raise that follows is the same guard resuming, so neither is a shield event of its own.
// Every lowering is stamped (`loweredAt`, published) and a lowering the raise follows with no swing thrown between is
// counted: the server restarts the 5-tick block delay on each raise, and a lower and raise inside one server tick never
// change the flag the client reads.
function lowerForSwing(bot) {
  guardExternalSync(TAG, 'deactivateItem to swing behind the shield', () => bot.deactivateItem());
  loweredAt = Date.now(); lowerUnswung = true;
  stats.swingLowers++;
  shieldUp = false;
  resumingGuard = true;
}

// aimBearing(bot, bearing) → true when a facing was written: the exact bearing, for the guard and the swing tick,
// where an eighth-of-a-turn quantum would leave a blow landing beside the shield. Written only past AIM_DEADBAND_RAD.
const AIM_DEADBAND_RAD = (4 * Math.PI) / 180;
function aimBearing(bot, bearing) {
  if (heldYaw !== null) {
    let off = bearing - heldYaw;
    while (off > Math.PI) off -= 2 * Math.PI;
    while (off < -Math.PI) off += 2 * Math.PI;
    if (Math.abs(off) < AIM_DEADBAND_RAD) return false;
  }
  if (!guardExternalSync(TAG, `look to yaw ${bearing.toFixed(3)}`, () => bot.look(bearing, 0, true)).ok) return false;
  heldYaw = bearing;
  return true;
}

function fire(bot, target, distance) {
  if (distance > BOT_STRIKE_REACH) return false;
  stats.inReach++;
  const heldName = bot.heldItem && bot.heldItem.name;
  if (combatUtils.chargeNow(cooldownInHand(bot)) < 1) return false;
  stats.charged++;
  const fired = combatUtils.swingNow(bot, target, TAG);
  if (fired) {
    stats.swings++;
    stats.lastSwingAt = Date.now();
    lowerUnswung = false;
    if (!bot.heldItem) stats.barehandedSwings++;
  }

  // ── THE FIRST LANDED BLOW ON A MOB, STATED ONCE ─────────────────────────────────────────────────
  // `retireTarget` must tell "the bot killed it" from "it died near the bot" (Law 25); recorded once per
  // mob, bounded by mobs fought, not swings thrown.
  if (fired) {
    const before = _connected.get(target.id) || 0;
    _connected.set(target.id, before + 1);
    if (!before) crewLog.event(TAG, 'connect', { subject: `${target.name || 'unknown'}#${target.id}`,
                                                 weapon: heldName || 'fist',
                                                 d: Math.round(distance * 100) / 100 });
  }
  return fired;
}

// ---------------------------------------------------------------------------
// SECTION 4b: The hand
// ---------------------------------------------------------------------------

// verifyWeapon(bot, why) — is there still a weapon in the hand; if not, start getting one. Checked after
// every swing (Invariant B). Delegates to `equipBestWeapon`, which owns best-vs-held (Law 16). Unawaited;
// `equipPending` stops a later tick firing a second swap into this one's round trip.
function verifyWeapon(bot, why) {
  if (equipPending) return;
  stats.equipChecks++;
  const before = bot.heldItem && bot.heldItem.name;
  equipPending = true;
  Promise.resolve(combatUtils.equipBestWeapon(bot))
    .then((choice) => {
      if (!choice || !choice.item) {
        // Empty pack = the world's answer, not a fault to retry: fight on with fists (Law 13).
        stats.equipFails++;
        return;
      }
      if (choice.item.name !== before) {
        // Held name changed under the name-keyed cooldown cache; clear now so the next swing times on
        // the new weapon's clock.
        cachedWeaponName = null;
        crewLog.event(TAG, 'rearm', { from: before || 'empty_hand', to: choice.item.name, why });
      }
    })
    .catch((e) => {
      // Boundary translator (Law 16's one legal catch): a lost equip swap is environmental, named aloud.
      watcher.warn(TAG, `weapon check failed (${e && e.message}) — swinging with whatever is in the hand.`);
    })
    .then(() => { equipPending = false; });
}

// ---------------------------------------------------------------------------
// SECTION 3: Tick
// ---------------------------------------------------------------------------

// ── THE BLAST WALL: ONE BLOCK AT THE CREEPER'S FEET ─────────────────────────────────────────────────────────
// A creeper's blast starts at its feet, and the server prices each body's share of it by the rays from that point to
// the body's box that reach it, before the blast breaks a single block. One block set on the ground in the cell beside
// the creeper, on its line to the body, stands across every one of those rays: the blast costs the body nothing, and
// the shield nothing. A swelling creeper stops walking, so it does not step round the block.
// It is the first answer to a swell within blast reach whenever the body carries a block. A shielded body lowers the
// shield only for the place and raises it behind the set block: a slope or a misplaced cell leaves rays the block
// does not cover. Without a block or a cell the shield guard stands alone.
const WALL_STEPS = [0.95, 1.25, 1.55];   // b from the creeper's centre along its line to the body
const WALL_LEVEL_DY = 0.6;               // a creeper further off the body's floor than this is guarded, not walled
const WALL_REACH = 4.5;                  // the place reach from the body's eye
// A creeper still sliding from a blow, or the body still carried by its last step, is where its velocity carries it
// this many ticks on: a cell either slides into refuses the block (two homestead walls refused so).
const WALL_SLIDE_TICKS = 6;
// A refused wall is set again, in another cell, from where the body stands now, this many times per creeper.
const WALL_TRIES = 3;
const CREEPER_HALF = 0.3, CREEPER_TALL = 1.7;
let wall = null;   // { creeperId, at: {x,y,z}, settled, ok, why, since, tries, refused } — one per swelling creeper

function boxHitsCell(p, half, tall, cell) {
  return p.x + half > cell.x && p.x - half < cell.x + 1 && p.z + half > cell.z && p.z - half < cell.z + 1
    && p.y + tall > cell.y && p.y < cell.y + 1;
}

// wallCell(bot, creeper) → { cell, standing } for the block between the creeper and the body, or null. `standing` is
// a solid block already in that cell: the wall is up without a place.
function wallCell(bot, creeper, refused) {
  const c = creeper.entity && creeper.entity.position, me = bot.entity && bot.entity.position;
  if (!c || !me || Math.abs(me.y - c.y) > WALL_LEVEL_DY) return null;
  const dx = me.x - c.x, dz = me.z - c.z, len = Math.hypot(dx, dz);
  if (len < 1.2) return null;
  const eye = me.offset(0, 1.62, 0);
  const botHalf = (bot.entity.width || 0.6) / 2, botTall = bot.entity.height || 1.8;
  const v = creeper.entity.velocity, mv = bot.entity.velocity;
  const slid = v ? c.offset(v.x * WALL_SLIDE_TICKS, 0, v.z * WALL_SLIDE_TICKS) : c;
  const meSlid = mv ? me.offset(mv.x * WALL_SLIDE_TICKS, 0, mv.z * WALL_SLIDE_TICKS) : me;
  for (const step of WALL_STEPS) {
    const cell = new Vec3(Math.floor(c.x + dx / len * step), Math.floor(c.y + 0.01), Math.floor(c.z + dz / len * step));
    if (refused && refused.has(`${cell.x},${cell.y},${cell.z}`)) continue;
    if (boxHitsCell(c, CREEPER_HALF, CREEPER_TALL, cell) || boxHitsCell(slid, CREEPER_HALF, CREEPER_TALL, cell)
      || boxHitsCell(me, botHalf, botTall, cell) || boxHitsCell(meSlid, botHalf, botTall, cell)) continue;
    const block = bot.blockAt(cell);
    if (!block) continue;
    if (block.boundingBox === 'block') return { cell, standing: true };
    // Only a cell a placed block takes over (air, grass, snow): a flower or a torch refuses the block.
    if (!isReplaceable(block)) continue;
    if (eye.distanceTo(cell.offset(0.5, 0.5, 0.5)) > WALL_REACH || !coverAnchor(bot, cell)) continue;
    return { cell, standing: false };
  }
  return null;
}

// lineCrossesCell(a, b, cell) → the flat segment a→b passes through the cell's column (slab test).
function lineCrossesCell(a, b, cell) {
  let t0 = 0, t1 = 1;
  for (const [p, d, lo] of [[a.x, b.x - a.x, cell.x], [a.z, b.z - a.z, cell.z]]) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > lo + 1) return false; continue; }
    let ta = (lo - p) / d, tb = (lo + 1 - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

// wallBetween(bot, creeper, at) → the creeper's line to the body still crosses the cell `at`, the body on its level.
function wallBetween(bot, creeper, at) {
  const c = creeper && creeper.entity && creeper.entity.position, me = bot.entity && bot.entity.position;
  if (!c || !me || Math.abs(me.y - c.y) > WALL_LEVEL_DY) return false;
  return lineCrossesCell(c, me, at);
}

// wallHolds(bot, board, creeperId) → a wall set for this creeper still stands, solid, between it and the body.
function wallHolds(bot, board, creeperId) {
  if (!wall || wall.creeperId !== creeperId || !wall.ok) return false;
  const b = bot.blockAt(new Vec3(wall.at.x, wall.at.y, wall.at.z));
  const creeper = (board.active || []).find((h) => h.id === creeperId);
  return !!b && b.boundingBox === 'block' && wallBetween(bot, creeper, wall.at);
}

// wallState() → the wall as the driver reads it: the body stands still behind it while it is placing or holds.
function wallState(bot, board) {
  if (!wall) return null;
  const state = !wall.settled ? 'placing' : wallHolds(bot, board, wall.creeperId) ? 'set' : wall.ok ? 'moved' : 'failed';
  return { creeperId: wall.creeperId, state };
}

// serveWall(bot, board, now) → true while a wall's place is in flight: the hand and the head are the place's, so this
// tick neither guards, aims nor swings.
function serveWall(bot, board, now) {
  const reach = require('@api/commander').CREEPER_BLAST_REACH;
  const swelling = board.swelling || [];
  const creeper = (board.active || []).find((h) => swelling.includes(h.id) && h.distance <= reach) || null;
  if (wall && wall.settled && !swelling.includes(wall.creeperId)) wall = null;
  if (wall && !wall.settled) return true;
  // A wall the body no longer stands behind is set again, from where the body stands now.
  if (wall && wall.ok && creeper && wall.creeperId === creeper.id && !wallHolds(bot, board, creeper.id)) wall = null;
  // A refused wall is set again in another cell while tries remain.
  const again = wall && creeper && wall.creeperId === creeper.id && wall.settled && !wall.ok && wall.tries < WALL_TRIES;
  if (!creeper || (wall && wall.creeperId === creeper.id && !again)) return false;
  const refused = again ? wall.refused : new Set();
  const tries = again ? wall.tries : 0;
  const spot = wallCell(bot, creeper, refused);
  if (!spot) return false;
  const at = { x: spot.cell.x, y: spot.cell.y, z: spot.cell.z };
  if (spot.standing) {
    wall = { creeperId: creeper.id, at, settled: true, ok: true, why: 'standing', since: now, tries, refused };
    crewLog.event(TAG, 'wall', { subject: `creeper#${creeper.id}`, state: 'standing', at: `${at.x},${at.y},${at.z}` });
    stats.wallsStanding++;
    return false;
  }
  const items = bot.inventory.items();
  const item = BRIDGE_PREFS.map((name) => items.find((i) => i.name === name && i.count > 0)).find(Boolean) || null;
  if (!item) return false;
  const anchor = coverAnchor(bot, spot.cell);
  refused.add(`${at.x},${at.y},${at.z}`);
  const job = { creeperId: creeper.id, at, settled: false, ok: false, why: null, since: now, tries: tries + 1, refused };
  wall = job;
  if (shieldUp) {
    guardExternalSync(TAG, 'deactivateItem to set the blast wall', () => bot.deactivateItem());
    crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms`, by: 'wall' });
    loweredAt = now; lowerUnswung = false;
    shieldUp = false; shieldUpAt = null; shieldClearAt = null; threatId = null; threatWhy = null; resumingGuard = false;
  }
  kbSince = null;
  stats.wallsTried++;
  crewLog.event(TAG, 'wall', { subject: `creeper#${creeper.id}`, state: 'placing', at: `${at.x},${at.y},${at.z}`, with: item.name, d: creeper.distance.toFixed(2), try: tries + 1 });
  performPlace(bot, spot.cell, anchor.block, anchor.face, item.name, TAG).then(
    (r) => { job.settled = true; job.ok = !!(r && r.ok); job.why = r && r.ok ? 'walled' : (r && r.reason) || 'place_failed'; },
    (e) => { job.settled = true; job.ok = false; job.why = `place_threw:${e && e.message}`; })
    .then(() => {
      if (job.ok) stats.wallsSet++; else stats.wallsFailed++;
      crewLog.event(TAG, 'wall', { subject: `creeper#${job.creeperId}`, state: job.ok ? 'set' : 'failed', why: job.why, took: `${Date.now() - job.since}ms` });
      heldYaw = null;
      if (engaged) verifyWeapon(bot, 'post-wall');
    });
  return true;
}

function onPhysicsTick(bot) {
  if (!engaged) return;
  // Survival owns facing during the return to air, so the interrupted fight emits no further swing.
  if (require('@locomotion/underwater_swimming').survivalHasControl(bot)) return;
  stats.ticks++;

  // Once per engagement, before the first swing. Not in `engage()`, which takes no bot.
  if (!armedThisEngagement) {
    armedThisEngagement = true;
    verifyWeapon(bot, 'engagement_opened');
  }

  const board = crewBoard.readCommander();
  const now = Date.now();

  // THE BLAST WALL comes first: while its place is in flight the tick is the place's.
  if (serveWall(bot, board, now)) {
    stats.wallTicks++;
    writeBoard({ heldYaw, targetId, lastSwingAt: stats.lastSwingAt || null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId, terrainStatus: null, sweepFriend: null, knockback: null, loweredAt, readyInMs: readyIn(bot), wall: wallState(bot, board) });
    return;
  }

  // Shield decides before facing: with no focus its threat is what the body faces. A body running for its life
  // (self_preservation) holds no approach guard: the guard would stop its sprint. A creeper behind a standing wall
  // keeps its swell guard (THE BLAST WALL): the shield goes up behind the block once it is set, for the rays a slope
  // or a misplaced cell leaves open; its swell still holds the arm.
  const shielded = combatUtils.holdsShield(bot);
  // Running is the driver pressing a flee heading; a cornered body, with no heading to run, keeps its guard.
  const drv = crewBoard.readDriver();
  const fleeing = crewBoard.readSurvival().fleeing === true && drv.mode === 'flee' && !!drv.keys;
  const threats = senseThreats(board, now, shielded && !fleeing);
  let order = shieldOrder({ threats, now });
  const near = focusTarget();
  // A RAISED SHIELD STAYS UP THROUGH AN OPEN DRAW: lowered and raised again for the same draw, its five-tick raise
  // starts over just as the arrow is due, and a release and a raise landing in one server tick restart it unseen.
  if (!order.guard && shieldUp && threats.some((t) => t.why !== 'approach')) order = { ...order, guard: true };
  const threatEntity = order.against != null ? (board.active || []).find((h) => h.id === order.against) : null;
  const gap = threatEntity && threatEntity.entity && threatEntity.entity.position && bot.entity
    ? threatEntity.entity.position.distanceTo(bot.entity.position) : null;
  // A FRIEND IN THE SWEEP: swingNow withholds the swing, and the friend is published for the driver, which backs
  // the body off to draw the mob away (driver RECENTER).
  const sweepFriend = near && near.distance <= BOT_STRIKE_REACH ? combatUtils.sweepFriend(bot, near.entity) : null;
  if (sweepFriend) stats.sweepWithheldTicks++;
  // A MELEE MOB GETS A KNOCKBACK SWING, an archer a plain one: with the arm charged and a melee focus in reach the
  // shield comes down and stays down until the driver reports sprint (THE KNOCKBACK SWING, driver), at most
  // KNOCKBACK_WAIT_TICKS, so the blow throws the mob back out of its own reach.
  const meleeFocus = !!near && combatUtils.combatTactic(near.name, near.entity) === 'BRAWLER';
  const reachOpen = shielded ? meleeOpen(board, now) : null;
  if (reachOpen && near && swingReady(bot, near.distance)) stats.swingsInReach++;
  const intoArrow = swingBlocked(threats, now) || !!reachOpen;
  if (near && intoArrow && swingReady(bot, near.distance)) stats.swingsIntoArrow++;
  // No knockback swing while running: its press is toward the mob. Nor at a swelling creeper in blast reach while a
  // shield is held: the swing lowers the swell guard (a homestead blast landed 120 ms after one).
  const swellFocus = shielded && !!near && (board.swelling || []).includes(near.id)
    && near.distance <= require('@api/commander').CREEPER_BLAST_REACH;
  const kbReady = meleeFocus && !sweepFriend && !fleeing && !swellFocus && swingReady(bot, near.distance);
  if (kbSince === null) {
    if (kbReady && !intoArrow && stats.ticks >= kbRetryTick) kbSince = stats.ticks;
  } else if (!kbReady || swingBlocked(threats, now)) {
    kbSince = null;
    stats.knockbackAborted++;
    kbRetryTick = stats.ticks + KNOCKBACK_RETRY_TICKS;
  }
  applyShield(bot, order, now, gap, kbSince !== null);

  // A RUNNING BODY FACES ITS RUN (driver THE RUN): sprint carries only the forward key, and a body that faces the mob
  // while it runs backpedals at a walk the mob keeps up with. No swing while it runs: a blow drops the sprint.
  if (fleeing && drv.heading) {
    stats.fleeTicks++;
    if (aimBearing(bot, Math.atan2(-drv.heading.x, -drv.heading.z))) stats.aimed++;
    writeBoard({ heldYaw, targetId, lastSwingAt: stats.lastSwingAt || null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId, terrainStatus: null, sweepFriend: null, knockback: null, loweredAt, readyInMs: readyIn(bot), wall: wallState(bot, board) });
    return;
  }

  // The body always faces the mob it is engaged with (the commander's focus); a threat takes the yaw only when
  // there is no focus. A shield raised for another mob's notch is held toward the focus: a fight turned away from
  // its own mob is a fight with no swings.
  const guardFace = order.against !== null
    ? (board.active || []).find((h) => h.id === order.against) || null
    : null;
  const face = near || guardFace;
  // Measured against the nearest body, not the focus — a count against focus would read zero through a
  // fight spent turned away from a nearby zombie (Law 25).
  if (face && board.closest && face.id !== board.closest.id) stats.facedThreatOverClosest++;

  if (!face) {
    stats.noTarget++;
    // Facing LEFT WHERE IT IS: a neutral snap is an unasked write. `targetId` cleared so the next mob
    // reads as a change, not a hold.
    targetId = null;
    writeBoard({ heldYaw, targetId: null, lastSwingAt: null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId, sweepFriend: null, knockback: null, loweredAt, readyInMs: readyIn(bot), wall: wallState(bot, board) });
    return;
  }

  if (face.entity.id !== targetId) {
    targetId = face.entity.id;
    // Reports where the gunner decided to face — not a copy of commander's `focus` (what the crew picked
    // to kill). why: focus = the engaged mob, guard = no focus and a live threat took the facing.
    crewLog.event(TAG, 'face', {
      subject: crewLog.subject(face.entity),
      why: near && near.id === face.entity.id ? 'focus' : 'guard',
    });
  }

  // The guard faces the blows; any other tick faces the engaged mob.
  const guardYaw = shieldUp && kbSince === null ? guardBearing(bot, threats, now) : null;
  if (guardYaw !== null ? aimBearing(bot, guardYaw) : aim(bot, face.entity)) {
    stats.aimed++;
    stats.switches++;
    if (lastSwitchTick !== null) {
      const gap = stats.ticks - lastSwitchTick;
      if (stats.minSwitchGapTicks === null || gap < stats.minSwitchGapTicks) stats.minSwitchGapTicks = gap;
      if (gap < STUTTER_GAP_TICKS) stats.fastSwitches++;
    }
    lastSwitchTick = stats.ticks;
  } else {
    stats.heldSteady++;
  }

  // Aim then fire, same tick. Weapon check AFTER the swing (SECTION 4b): a weapon breaks ON the swing.
  // Arm held only while the guard is actually up. STILL UNVERIFIED (Law 23): whether a swing sent while
  // `activateItem` is held actually lands.
  if (kbSince !== null) {
    // THE KNOCKBACK SWING: lowered for it (a blocking body cannot attack, nor sprint), thrown once sprint is held.
    if (shieldUp) lowerForSwing(bot);
    const sprinting = crewBoard.readDriver().sprinting === true;
    if (sprinting || stats.ticks - kbSince >= KNOCKBACK_WAIT_TICKS) {
      // Square to the mob on the swing tick: the knockback is thrown along the facing.
      aimBearing(bot, bearingTo(bot.entity.position, near.entity.position));
      if (fire(bot, near.entity, near.distance)) {
        verifyWeapon(bot, 'post-swing');
        if (sprinting) stats.knockbackSwings++; else stats.knockbackUnsprinted++;
      }
      kbSince = null;
    } else {
      stats.knockbackWaitTicks++;
    }
  } else {
    // AN APPROACH GUARD COMES DOWN FOR THE SWING: a blocking body cannot attack, so on the tick the arm is charged and
    // the focus in reach the shield is lowered, the swing sent, and the next tick's order raises it again. A deadline
    // guard (notch, swell) is never lowered to swing.
    if (shieldUp && threatWhy === 'approach' && near && !intoArrow && swingReady(bot, near.distance)) lowerForSwing(bot);
    if (shieldUp) stats.swingsHeld++;
    else if (near && !intoArrow && swingReady(bot, near.distance)) {
      aimBearing(bot, bearingTo(bot.entity.position, near.entity.position));
      if (fire(bot, near.entity, near.distance)) verifyWeapon(bot, 'post-swing');
    }
  }

  // After the swing decision, never before it — the fight outranks the errand.
  const terrainStatus = serveTerrain(bot, near, shieldUp);

  writeBoard({
    heldYaw,
    targetId,
    lastSwingAt: stats.lastSwingAt || null,
    swings: stats.swings,
    shield: shieldUp,
    shieldWhy: threatWhy,
    shieldAgainst: threatId,
    terrainStatus,
    sweepFriend,
    // The melee focus a knockback swing is held for, shield down, until the driver's sprint (THE KNOCKBACK SWING).
    knockback: kbSince !== null && near ? near.id : null,
    loweredAt,
    readyInMs: readyIn(bot),
    wall: wallState(bot, board),
  });
}

// ---------------------------------------------------------------------------
// SECTION 3b: The terrain errand — the driver's ask, served by the yaw's owner
// ---------------------------------------------------------------------------
// Digging and placing need a facing, and the driver may never write yaw (Invariant D) — this seat serves
// the errand because it already holds the heading. The want is read fresh every tick; this seat holds
// only a job already IN FLIGHT, dropped when the want stops appearing (Invariant B). `performDig`/
// `pillarStep` are async and unawaited, so the job is STARTED here and read on a later tick off `_job.settled`.
function serveTerrain(bot, near, shieldUp) {
  const want = crewBoard.readDriver().terrainRequest;

  // Reported ONCE from the job's own recorded outcome (Law 23/25) — this seat says what it DID. Read before the
  // withdrawal test: a job that finished is reported done or failed even when the want has since moved on (a route's
  // next cell is asked the tick its block lands), never counted as dropped.
  if (_job && _job.settled) {
    const out = { kind: _job.kind, at: _job.at, state: _job.ok ? 'done' : 'failed', why: _job.why };
    if (_job.ok) stats.terrainDone++; else stats.terrainFailed++;
    crewLog.event(TAG, 'terrain', { state: out.state, kind: out.kind, why: out.why });
    // The errand's own look moved the head off the held facing, so the next tick aims afresh (Law 23); a placed
    // block left the block in the hand, so the weapon is checked too.
    heldYaw = null;
    verifyWeapon(bot, 'post-terrain');
    _job = null;
    return out;
  }

  // Withdrawal is silence: detected by comparing the live want against the job in flight.
  if (_job && (!want || want.kind !== _job.kind || !sameCell(want.at, _job.at))) {
    stats.terrainDropped++;
    crewLog.event(TAG, 'terrain', { state: 'dropped', kind: _job.kind, why: want ? 'want_changed' : 'want_withdrawn' });
    dropJob(bot);
  }
  if (!want) return null;
  if (_job) return { kind: _job.kind, at: _job.at, state: 'working', why: 'in_flight' };

  // Refused at the same reach the swing gate enforces. A raised shield refuses too — it owns the facing.
  if (shieldUp) return { kind: want.kind, at: want.at, state: 'refused', why: 'shield_up' };
  if (near && near.distance <= BOT_STRIKE_REACH) {
    stats.terrainRefused++;
    return { kind: want.kind, at: want.at, state: 'refused', why: 'target_in_reach' };
  }

  const at = new Vec3(want.at.x, want.at.y, want.at.z);
  const job = { kind: want.kind, at: { x: at.x, y: at.y, z: at.z }, settled: false, ok: false, why: null };
  _job = job;
  stats.terrainAccepted++;
  crewLog.event(TAG, 'terrain', { state: 'accepted', kind: job.kind, at: `${job.at.x},${job.at.y},${job.at.z}` });

  // `.then` turns a third-party rejection into a settled FAILURE with a reason (Law 16).
  if (want.kind === 'dig') {
    const block = bot.blockAt(at);
    // Nothing to break is a finished errand, not an error (Law 25).
    if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
      job.settled = true; job.ok = true; job.why = 'already_clear';
    } else {
      performDig(bot, at, block, TAG).then(
        // performDig answers a bare boolean (true only when the cell re-senses passable), never { success }.
        (r) => { job.settled = true; job.ok = r === true; job.why = r === true ? 'dug' : 'dig_failed'; },
        (e) => { job.settled = true; job.ok = false; job.why = `dig_threw:${e && e.message}`; });
    }
  } else if (want.kind === 'bridge') {
    // A floor block on a route's bridge edge: against the first solid neighbour, from the scaffold blocks carried, through the one
    // place route (Law 16).
    const items = bot.inventory.items();
    const item = BRIDGE_PREFS.map((name) => items.find((i) => i.name === name && i.count > 0)).find(Boolean) || null;
    const anchor = coverAnchor(bot, at);
    if (!item) { job.settled = true; job.ok = false; job.why = 'no_block'; }
    else if (!anchor) { job.settled = true; job.ok = false; job.why = 'no_anchor'; }
    else {
      performPlace(bot, at, anchor.block, anchor.face, item.name, TAG).then(
        (r) => { job.settled = true; job.ok = !!(r && r.ok); job.why = r && r.ok ? 'bridged' : (r && r.reason) || 'place_failed'; },
        (e) => { job.settled = true; job.ok = false; job.why = `place_threw:${e && e.message}`; });
    }
  } else {
    // Placement is a PILLAR UNDERFOOT and only that — `pillarStep` owns the whole verb (Law 16).
    pillarStep(bot).then(
      (r) => { job.settled = true; job.ok = !!(r && r.success); job.why = (r && r.reason) || (r && r.success ? 'pillared' : 'place_failed'); },
      (e) => { job.settled = true; job.ok = false; job.why = `place_threw:${e && e.message}`; });
  }
  return { kind: job.kind, at: job.at, state: 'working', why: 'started' };
}

function sameCell(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
}

// coverAnchor(bot, at) → { block, face } for the first solid neighbour of `at` (below first, then the sides, then
// above), with the face that points from it into `at`; null when nothing solid touches the cell.
const ANCHOR_DIRS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
function coverAnchor(bot, at) {
  for (const [dx, dy, dz] of ANCHOR_DIRS) {
    const block = bot.blockAt(at.offset(dx, dy, dz));
    if (block && isBlockSolid(block)) return { block, face: new Vec3(-dx, -dy, -dz) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// SECTION 4: Public API
// ---------------------------------------------------------------------------

function start(bot) {
  if (attached) return;
  stats = _blankStats();
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
}

// stop RUNS THE FIGHT'S TEARDOWN, not just the listener drop — a bare unlisten would leave the guard
// raised (Law 8). Calls disengage(bot) to share its body (Law 16).
function stop(bot) {
  if (!attached || !tickHandler) return;
  disengage(bot);
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  tickHandler = null;
  attached = false;
}

// engage/disengage — the ONLY switch, separate from start/stop so the handler stays attached across a
// session (Law 8). Both ends clear facing+target (Invariant B).
function engage() {
  engaged = true;
  heldYaw = null;
  targetId = null;
  lastSwitchTick = null;
  // A terrain job cannot outlive the wave that asked for it (Law 8).
  dropJob(global.bot);
  // Hand re-verified at next tick top, never carried over (Invariant B).
  armedThisEngagement = false;
  cachedWeaponName = null;
  // Shield latch dies at both boundaries like the facing (Invariant B); `shieldUp` NOT forced false here.
  threatStarts.clear(); drawStarts.clear(); seenQuiet.clear(); releasedAt.clear();
  threatId = null;
  threatWhy = null;
  shieldClearAt = null;
  resumingGuard = false;
  kbSince = null;
  kbRetryTick = 0;
  wall = null;
  stats = _blankStats();
}

function disengage(bot) {
  engaged = false;
  heldYaw = null;
  targetId = null;
  lastSwitchTick = null;
  armedThisEngagement = false;
  dropJob(bot || global.bot);
  // SHIELD COMES DOWN WITH THE FIGHT (Law 8): a guard left up outside an engagement slows the body.
  threatStarts.clear(); drawStarts.clear(); seenQuiet.clear(); releasedAt.clear();
  threatId = null;
  threatWhy = null;
  shieldClearAt = null;
  if (resumingGuard && !shieldUp) {
    crewLog.event(TAG, 'shield', { state: 'down', held: `${Date.now() - shieldUpAt}ms`, by: 'disengage' });
    shieldUpAt = null;
  }
  resumingGuard = false;
  kbSince = null;
  kbRetryTick = 0;
  wall = null;
  if (shieldUp) {
    guardExternalSync(TAG, 'deactivateItem on disengage', () => (bot || global.bot).deactivateItem());
    // by=disengage, not the timer's lower — the lens needs which hand closed the shield.
    crewLog.event(TAG, 'shield', { state: 'down', held: `${Date.now() - shieldUpAt}ms`, by: 'disengage' });
    shieldUp = false;
    shieldUpAt = null;
  }
  // `equipPending` NOT cleared: its own `.then` releases it (Law 8).
}

// report() — the gunner's own line, written by whoever owns the engagement boundary. Keeps only what the
// event stream can't carry: ticks that emitted nothing. BAND stays a ratio, never a raw switch count:
// `fastSwitches` vs `switches` discriminates judder from correct tracking of a circling mob (Law 25).
function report() {
  if (!stats || !stats.ticks) return;
  const s = stats;
  if (stats.terrainAccepted || stats.terrainRefused) {
    watcher.summary(TAG,
      `🔫 terrain errands: ${stats.terrainAccepted} accepted, ${stats.terrainRefused} refused (yaw spoken for), ` +
      `${stats.terrainDone} done, ${stats.terrainFailed} failed, ${stats.terrainDropped} dropped mid-flight. ` +
      `'done' is this seat's CLAIM about the world; the driver re-senses the cell before it walks (Law 23).`);
  }
  watcher.summary(TAG,
    `Gunner: ${s.ticks} tick(s) engaged — ${s.switches} yaw write(s), held steady on ${s.heldSteady}, ` +
    `${s.noTarget} with nothing hostile loaded. ` +
    `Band: ${s.fastSwitches} switch(es) inside ${STUTTER_GAP_TICKS} ticks of the last` +
    `${s.minSwitchGapTicks === null ? '' : `, closest pair ${s.minSwitchGapTicks} tick(s) apart`}. ` +
    `Arm: ${s.charged} charged tick(s) of ${s.inReach} spent inside reach, ` +
    `${s.equipChecks} hand check(s)${s.equipFails ? `, ${s.equipFails} found no weapon in the pack` : ''}. ` +
    // Shield cost in ticks the arm could not swing. `settleTicks` is the part spent AFTER the danger.
    `Shield: up for ${s.guardTicks} tick(s) of ${s.ticks}` +
    `${s.settleTicks ? ` (${s.settleTicks} settling after the threat cleared)` : ''}` +
    // Price of the guard: how much of the arm's charged time it ate, counted directly.
    `${s.swingsHeld ? `, arm held on ${s.swingsHeld} tick(s)` : ''}` +
    `${s.swingLowers ? `, lowered for ${s.swingLowers} swing(s)` : ''}` +
    `${s.knockbackSwings || s.knockbackUnsprinted ? `, knockback swings ${s.knockbackSwings} sprinted / ` +
      `${s.knockbackUnsprinted} thrown without sprint after ${KNOCKBACK_WAIT_TICKS} tick(s), ${s.knockbackWaitTicks} tick(s) waited, ${s.knockbackAborted} called off` : ''}` +
    `${s.lowersUnswung ? `, ${s.lowersUnswung} lowering(s) raised again with no swing` : ''}` +
    `${s.facedThreatOverClosest ? `, facing off the nearest mob for ${s.facedThreatOverClosest} tick(s)` : ''}` +
    `${s.guardArcTicks || s.guardSplitTicks ? `, guard squared to the blows on ${s.guardArcTicks} tick(s) (split ${s.guardSplitTicks})` : ''}` +
    `${s.swingsIntoArrow ? `, ${s.swingsIntoArrow} charged tick(s) held behind the shield for a draw, an arrow or a mob in reach` : ''}` +
    `${s.swingsInReach ? ` (${s.swingsInReach} for a melee mob in reach that had not just swung)` : ''}` +
    `${s.sweepWithheldTicks ? `, swing withheld for a friend in the sweep on ${s.sweepWithheldTicks} tick(s)` : ''}` +
    `${s.wallsTried || s.wallsStanding ? `. Blast wall: ${s.wallsSet} set of ${s.wallsTried} tried (${s.wallsFailed} failed), ${s.wallsStanding} already standing, ${s.wallTicks} tick(s) placing` : ''}${s.fleeTicks ? `. Faced its run on ${s.fleeTicks} tick(s)` : ''}.`);
  // A fist-fight is a SUPPLY failure upstream of combat, invisible in every other number here (Law 25).
  if (s.barehandedSwings > 0) {
    watcher.warn(TAG,
      `${s.barehandedSwings} of ${s.swings} swing(s) were thrown with an empty hand. The weapon check ran ` +
      `${s.equipChecks} time(s) and found nothing to equip — this is an empty pack, not a broken equip.`);
  }
  if (s.fastSwitches > 0) {
    watcher.warn(TAG,
      `The facing switched ${s.fastSwitches} time(s) within ${STUTTER_GAP_TICKS} ticks of the previous switch. ` +
      `That is the judder the ${Math.round(YAW_HYSTERESIS_RAD * 180 / Math.PI)}° band is sized to remove — either the band is ` +
      `too narrow for this fight's geometry or two writers are on the yaw.`);
  }
}

// Inspection surface (Law 6). Snapshot, never the live variables — a caller could zero a counter the
// gunner is still accumulating into.
function state() {
  return {
    attached, engaged, targetId,
    heldYaw,
    heldDeg: heldYaw === null ? null : Math.round((heldYaw * 180 / Math.PI) * 10) / 10,
    stats: stats ? { ...stats } : null,
  };
}

module.exports = {
  start, stop, engage, disengage, report, state, STUTTER_GAP_TICKS,
  // Read by battle_stations at every retirement — see `connectedTo`.
  connectedTo,
  // Bench export, same terms as driver.bandOrder — the timer's value is WHEN it fires.
  shieldOrder, SHIELD_ACTIVE_MS, SHIELD_MARGIN_MS, SHIELD_HOLD_MS,
  // Read by self_preservation: a creeper further off the body's floor than this is not walled.
  WALL_LEVEL_DY,
};
