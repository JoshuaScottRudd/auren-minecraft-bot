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
const { BOW_DRAW_MS } = require('@utils/calculators/archer_calculator');
const { SWELL_TO_BLAST_MS } = require('@api/combat_counters/fuse_meter');
const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');
const { guardExternalSync } = require('@utils/external_library_guard');
const Vec3 = require('vec3');
// The two terrain verbs, read from the modules that own them (Law 16); this seat supplies only facing/timing.
const { performDig } = require('@utils/movement/dig_authority');
const { pillarStep } = require('@utils/movement/scaffold_movement');

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
    facedThreatOverClosest: 0, // ticks the facing was on something other than the nearest active mob
    lastSwingAt: null,
  };
}
let lastSwitchTick = null;
// The terrain job IN FLIGHT — never a queued request (see serveTerrain).
let _job = null;
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
// Two shield cases only — skeleton's notched arrow and creeper swell. A TIMER, not a toggle: raises just
// before the arrow/blast lands and lowers 5 ticks after the threat clears.
// Triggers are server-read, not modelled (Law 23): the commander posts id lists (`swelling`, `notching`),
// sole announcer of combat data (Law 16). Only a positive signal raises (Law 25).
const SHIELD_ACTIVE_MS = 250;   // 5 ticks between the raise and the first block

// How long before the threat's deadline the raise fires (MARGIN) and how long the shield holds after the
// threat clears (HOLD), covering the arrow still in flight. Neither floors at 0.
const SHIELD_MARGIN_MS = 150;
const SHIELD_HOLD_MS = 150;

// shieldOrder({ threats, now }) → { guard, why, against, againstName, since }. Pure decision, no
// bot/packets (Law 16). `threats` = [{ id, why, since }]. Picks the EARLIEST threat.
function shieldOrder({ threats, now }) {
  if (!threats || !threats.length) {
    return { guard: false, why: null, against: null, againstName: null, since: null };
  }
  let first = threats[0];
  for (const t of threats) if (t.since < first.since) first = t;
  const name = (first.entity && first.entity.name) || 'mob';
  const deadline = first.why === 'swell' ? SWELL_TO_BLAST_MS : BOW_DRAW_MS;
  const raiseAt = deadline - (SHIELD_ACTIVE_MS + SHIELD_MARGIN_MS);
  // A deadline shorter than the raise cost has no late moment — guard at once (Law 13).
  const guard = raiseAt <= 0 ? true : now - first.since >= raiseAt;
  return { guard, why: first.why, against: first.id, againstName: name, since: first.since };
}

// senseThreats(board, now) → [{ id, why, since, entity }] for every ACTIVE hostile posted as notching or
// swelling, stamped with when ITS OWN current threat began. Decodes nothing (Law 16 — commander is sole
// announcer); turns a per-tick fact into a DURATION, which a stateless sweep can't hold.
// `threatStarts` is per-MOB, pruned the moment a mob stops threatening (Invariant B). Answers every
// threat from any mob; selection happens one layer up in shieldOrder.
const threatStarts = new Map();
function senseThreats(board, now) {
  const out = [];
  const seen = new Set();
  const swellingIds = board.swelling || [];
  const notchingIds = board.notching || [];
  for (const h of board.active || []) {
    // SWELL OUTRANKS NOTCH when a mob carries both — its deadline ends the fight, not costs 6 hp.
    let why = null;
    if (swellingIds.includes(h.id)) why = 'swell';
    else if (notchingIds.includes(h.id)) why = 'notched_arrow';
    if (!why) continue;
    seen.add(h.id);
    if (!threatStarts.has(h.id)) threatStarts.set(h.id, now);
    out.push({ id: h.id, why, since: threatStarts.get(h.id), entity: h.entity });
  }
  for (const id of threatStarts.keys()) if (!seen.has(id)) threatStarts.delete(id);
  return out;
}

// applyShield(bot, order, now) — the only place the shield is raised or lowered. Lower is latched, raise
// is not: threat clearing means the arrow was RELEASED not landed. activateItem(true) = offhand.
function applyShield(bot, order, now) {
  if (order.guard) {
    shieldClearAt = null;
    threatId = order.against;
    threatWhy = order.why;
    if (!shieldUp) {
      // A refused raise leaves the latch DOWN, so the next tick tries again (Law 25).
      if (!guardExternalSync(TAG, 'activateItem to raise the shield', () => bot.activateItem(true)).ok) return;
      shieldUp = true;
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
  if (!shieldUp) { threatId = null; threatWhy = null; return; }
  if (shieldClearAt === null) { shieldClearAt = now; threatWhy = 'settling'; }
  if (now - shieldClearAt < SHIELD_HOLD_MS) { stats.guardTicks++; stats.settleTicks++; return; }
  guardExternalSync(TAG, 'deactivateItem to lower the shield', () => bot.deactivateItem());
  // `held` is the cost side: ms the arm could not swing while the guard was up.
  crewLog.event(TAG, 'shield', { state: 'down', held: `${now - shieldUpAt}ms` });
  shieldUp = false;
  shieldUpAt = null;
  shieldClearAt = null;
  threatId = null;
  threatWhy = null;
}

// aim(bot, target) → true when a facing was written this tick.
// Bearing is continuous, facing is one of eight (`quantizeYawSticky`). The write is CONDITIONAL because
// `bot.look(…, force=true)` is a packet — 20 identical yaws/s is the Rogue Machine in miniature (Law 19).
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
function fire(bot, target, distance) {
  if (distance > BOT_STRIKE_REACH) return false;
  stats.inReach++;
  // Cooldown belongs to the item IN HAND, not the best in pack. Name-keyed cache: unchanged hand costs
  // one string compare.
  const heldName = bot.heldItem && bot.heldItem.name;
  if (heldName !== cachedWeaponName) {
    cachedWeaponName = heldName;
    const choice = combatUtils.pickBestWeapon(bot);
    cachedCooldownMs = (choice && choice.profile && choice.profile.cooldownMs) || 625;
  }
  if (combatUtils.chargeNow(cachedCooldownMs) < 1) return false;
  stats.charged++;
  const fired = combatUtils.swingNow(bot, target, TAG);
  if (fired) {
    stats.swings++;
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

function onPhysicsTick(bot) {
  if (!engaged) return;
  stats.ticks++;

  // Once per engagement, before the first swing. Not in `engage()`, which takes no bot.
  if (!armedThisEngagement) {
    armedThisEngagement = true;
    verifyWeapon(bot, 'engagement_opened');
  }

  const board = crewBoard.readCommander();
  const now = Date.now();

  // Shield decides before facing because it can TAKE the facing — guard and aim are one decision, guard
  // senior.
  const threats = senseThreats(board, now);
  const order = shieldOrder({ threats, now });
  applyShield(bot, order, now);

  const near = focusTarget();
  // The threat takes the yaw at the notch, not the raise: `order.against` is set whenever a threat
  // exists. A shield blocks what it FACES, so committing at sense leaves margin for a slow tick.
  const guardFace = order.against !== null
    ? (board.active || []).find((h) => h.id === order.against) || null
    : null;
  const face = guardFace || near;
  // Measured against the nearest body, not the focus — a count against focus would read zero through a
  // fight spent turned away from a nearby zombie (Law 25).
  if (face && board.closest && face.id !== board.closest.id) stats.facedThreatOverClosest++;

  if (!face) {
    stats.noTarget++;
    // Facing LEFT WHERE IT IS: a neutral snap is an unasked write. `targetId` cleared so the next mob
    // reads as a change, not a hold.
    targetId = null;
    writeBoard({ heldYaw, targetId: null, lastSwingAt: null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId });
    return;
  }

  if (face.entity.id !== targetId) {
    targetId = face.entity.id;
    // Reports where the gunner decided to face — not a copy of commander's `focus` (what the crew picked
    // to kill). why: guard = a live threat took the facing, focus = nothing threatening.
    crewLog.event(TAG, 'face', {
      subject: crewLog.subject(face.entity),
      why: guardFace && guardFace.id === face.entity.id ? 'guard' : 'focus',
    });
  }

  if (aim(bot, face.entity)) {
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
  if (shieldUp) stats.swingsHeld++;
  else if (near && fire(bot, near.entity, near.distance)) verifyWeapon(bot, 'post-swing');

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

  // Withdrawal is silence: detected by comparing the live want against the job in flight.
  if (_job && (!want || want.kind !== _job.kind || !sameCell(want.at, _job.at))) {
    stats.terrainDropped++;
    crewLog.event(TAG, 'terrain', { state: 'dropped', kind: _job.kind, why: want ? 'want_changed' : 'want_withdrawn' });
    _job = null;
  }
  if (!want) return null;

  // Reported ONCE from the job's own recorded outcome (Law 23/25) — this seat says what it DID.
  if (_job && _job.settled) {
    const out = { kind: _job.kind, at: _job.at, state: _job.ok ? 'done' : 'failed', why: _job.why };
    if (_job.ok) stats.terrainDone++; else stats.terrainFailed++;
    crewLog.event(TAG, 'terrain', { state: out.state, kind: out.kind, why: out.why });
    _job = null;
    return out;
  }
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
  crewLog.event(TAG, 'terrain', { state: 'accepted', kind: job.kind, at: job.at });

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
  _job = null;
  // Hand re-verified at next tick top, never carried over (Invariant B).
  armedThisEngagement = false;
  cachedWeaponName = null;
  // Shield latch dies at both boundaries like the facing (Invariant B); `shieldUp` NOT forced false here.
  threatStarts.clear();
  threatId = null;
  threatWhy = null;
  shieldClearAt = null;
  stats = _blankStats();
}

function disengage(bot) {
  engaged = false;
  heldYaw = null;
  targetId = null;
  lastSwitchTick = null;
  armedThisEngagement = false;
  _job = null;
  // SHIELD COMES DOWN WITH THE FIGHT (Law 8): a guard left up outside an engagement slows the body.
  threatStarts.clear();
  threatId = null;
  threatWhy = null;
  shieldClearAt = null;
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
    `${s.facedThreatOverClosest ? `, facing off the nearest mob for ${s.facedThreatOverClosest} tick(s)` : ''}.`);
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
};
