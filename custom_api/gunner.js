// module: gunner — the tank crew's GUNNER. Owns exactly two things, at tick rate: where the body FACES
// and when it SWINGS. Decides nothing about where the body goes.
// contract: start(bot) attaches a physicsTick handler, stop(bot) detaches it and releases nothing else.
// While ENGAGED: re-reads the commander's target off crew_board every tick, facing snapped to one of
// eight compass points with a hysteresis band. Derives NO monster data of its own: no bot.entities walk,
// no aggro test, no say in who the fight is with. ONLY writer of the yaw during an engagement
// (Invariant D): nothing else in the combat path may call bot.look/lookAt/faceTarget while this runs.
// Never reads a plan, presses a movement key, sets sprint, or touches jump.
//
// The driver never touches the yaw, only responds to it; the gunner never decides where to go — yaw to
// the fight's target, re-checked as often as possible, 8 cardinal directions only. (Target source moved
// from closest to the commander's `focus` — see focusTarget.)
// NOT IN survival_instincts: that folder forbids project imports (stays exportable); this needs
// crew_board + the fleet's ONE swing clock (combat_utils). So: own module, own tick handler.
//
// NOTHING IN THIS FILE MAY AWAIT: an awaiting seat yields, the event loop can deliver the NEXT tick
// first, the crew rotation crosses itself — driver presses keys against last tick's facing.
// `combat_utils.equipBestWeapon` is a real server round-trip, so §4b FIRES it un-awaited behind a
// pending latch. Wrong turn: adding `await` there undoes the one thing keeping the three seats in
// their own ticks. Cost: 1-2 in-flight ticks swinging with whatever is in hand — bare fists at worst,
// strictly better than not swinging.
//
// KNOCKBACK NOT DECIDED HERE — implemented ENTIRELY IN THE DRIVER: Java awards the bonus from
// isSprinting() at attack resolve, and sprint is the driver's key — a movement decision wearing a
// combat name. Wrong turn: setControlState('sprint', …) here for "reliable knockback" reopens the
// two-owners fault (Invariant D), fighting the driver 20×/s invisibly to both seats. Cost of the split:
// no orchestrated sprint-armed hit (hold.js's deleted `sprintKnockbackStrike`); one emerges anyway —
// rotation commander→gunner→driver fires the gunner BEFORE the driver releases sprint on the
// band-crossing tick. One shove per approach, load-bearing on the start order in master_core.

'use strict';

const crewBoard = require('@api/crew_board');
const combatUtils = require('@utils/combat_utils');
const { quantizeYawSticky, YAW_HYSTERESIS_RAD } = require('@utils/movement/motion_primitives');
const { BOT_STRIKE_REACH } = require('@utils/combat_utils');
// TWO DEADLINES, NOT A DECODE: threat facts arrive as id lists on the commander's board; this imports
// only each threat's time-to-land. Importing bowDrawState/swellDir to re-read mobs = second owner of the
// decode (Law 16; a consumer-resident decode must be duplicated the moment a second seat wants it).
const { BOW_DRAW_MS } = require('@utils/calculators/archer_calculator');
const { SWELL_TO_BLAST_MS } = require('@api/combat_counters/fuse_meter');
const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');
const { guardExternalSync } = require('@utils/external_library_guard');
const Vec3 = require('vec3');
// The two terrain verbs, read from the modules that already own them rather than reimplemented here: dig
// authority holds the refuse-air/refuse-liquid preconditions and the dig clamp, pillarStep holds the whole
// pick-block/look-down/jump/place sequence. This seat supplies only the FACING and the timing (Law 16).
const { performDig } = require('@utils/movement/dig_authority');
const { pillarStep } = require('@utils/movement/scaffold_movement');

const TAG = 'gunner';

// ── WHO THIS ARM HAS ACTUALLY LANDED ON — mob id → count of released swings that connected ──────────
// The kill-attribution fact, held by the only seat that can state it. `battle_stations.retireTarget`
// asks at every retirement so a mob that burned, fell, or was killed by a peer is not credited as this
// bot's kill (Law 25); the `connect` line on the trace is the same fact for a reader.
//
// KEYED BY MOB AND NEVER CLEARED MID-RUN. A wave can retire a mob and meet the same id again — the
// entity is the unit, not the engagement — and clearing at `engage` would zero a count the next
// retirement is about to read. The map is bounded by distinct mobs fought in one process lifetime,
// which is the same bound every other per-entity structure in the crew carries.
const _connected = new Map();

// connectedTo(mobId) → how many of this arm's released swings landed on that mob. Zero is a real
// answer ("never touched it"), never a missing one.
function connectedTo(mobId) { return _connected.get(mobId) || 0; }
const writeBoard = crewBoard.claimPen('gunner');

// ---------------------------------------------------------------------------
// SECTION 1: State
// ---------------------------------------------------------------------------
// Module-level: one gunner per process (like the one swing clock). Reset at every engagement boundary
// (Law 8) — a facing/target outliving its fight produces a stale-bearing defect.
let attached = false;
let tickHandler = null;
let engaged = false;

// Held facing (radians) — the `held` half of the hysteresis, and why the gunner has state at all: the
// band's answer depends on what is already faced (a band, not a fresh snap per tick).
let heldYaw = null;
let targetId = null;

// Cooldown cached against held-item name (equips change the name; 20 inventory scans/s buys nothing).
let cachedWeaponName = null;
let cachedCooldownMs = 625;

// EQUIP LATCH (§4b). `equipPending` marks a swap IN FLIGHT so following ticks don't fire a second one —
// legal cross-tick state: it describes an outstanding REQUEST, not a world fact (Invariant B).
// `armedThisEngagement`: a per-swing check alone leaves the FIRST swing unchecked — real once, when
// equipBestWeapon's other call sites (attack/jumpAttack/sprintKnockbackStrike) were deleted with the
// counter arms and the fleet equipped no weapon in any fight until this latch. The engage-top check makes
// the per-swing rule a replacement, not a narrowing.
let equipPending = false;
let armedThisEngagement = false;

// SHIELD LATCH. `threatStarts` (beside senseThreats) = when each current unbroken notch/swell was first
// sensed; the raise point counts forward from it, so a cleared-and-reopened threat starts fresh.
// `shieldUp` = what was COMMANDED, not what the server did (Law 25: activateItem is a packet, a packet
// is a claim).
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
    // The terrain errand, counted because the driver's side of this protocol is invisible from the trace
    // otherwise: a driver that keeps asking and a gunner that keeps refusing produce the same silence as a
    // driver that never asked. accepted−(done+failed+dropped) is the number in flight (Law 6).
    terrainAccepted: 0,  // asks this seat took on
    terrainRefused: 0,   // asks turned away because the yaw was spoken for
    terrainDone: 0,      // jobs the seat believes changed the world — a claim, verified by the asker
    terrainFailed: 0,    // jobs attempted and not achieved
    terrainDropped: 0,   // jobs abandoned mid-flight because the want changed or stopped
    // Stutter evidence, the number that judges the band: switches < STUTTER_GAP_TICKS apart. A working
    // band drives this to 0 without zeroing `switches` (that would be a facing that stopped tracking).
    fastSwitches: 0,
    minSwitchGapTicks: null,
    // SHIELD AUDIT (§2b) — TICKS ONLY. Raise counts/triggers moved to `shield state=up why=` events — a
    // counter beside the events that produce it is redundant and drifts on edit. Ticks survive because
    // events can't say how much of the fight the arm spent behind the guard. Metadata-decode counters
    // belong to the commander (owner of the decode), not here.
    guardTicks: 0,
    settleTicks: 0,            // guard ticks spent in the 5-tick hold AFTER the threat cleared
    facedThreatOverClosest: 0, // ticks the facing was on something other than the nearest active mob
    lastSwingAt: null,
  };
}
let lastSwitchTick = null;
// The terrain job IN FLIGHT — never a queued request. The want lives on the driver's board section and is
// re-read every tick; this holds only work already started, so there is no state here that can outlive the
// asker's intent (see serveTerrain). Cleared on engage/disengage with everything else.
let _job = null;
const STUTTER_GAP_TICKS = 4;   // 200 ms — two switches closer together than this are the judder

// ---------------------------------------------------------------------------
// SECTION 2: The two acts
// ---------------------------------------------------------------------------

// focusTarget() → the crew's COMMITTED target (commander's `focus`), or null.
//
// THE GUNNER NO LONGER SCANS: monster data is derived only by the commander, which owns it. Its old
// per-tick O(entities) hostile walk was one of six in the tree and why this seat and battle_stations
// could name different mobs in one tick. Still fresh: the commander sweeps at the head of the same
// rotation, so the field was written ms ago by its owner; re-deriving is the redundant route (Law 16)
// and the divergence (Invariant D) in one line.
//
// READS `focus`, NOT `closest`. Was closest-active. Wrong turn: reverting — `closest` is still on the
// board and looks like the same fact, but it re-answers on every step either body takes, so the gunner
// drops an archer at 40% health when a zombie walks nearer, then re-approaches it fully healed. The
// commitment IS the tactic.
function focusTarget() {
  return crewBoard.readCommander().focus;
}

// ---------------------------------------------------------------------------
// SECTION 2b: The shield
// ---------------------------------------------------------------------------
//
// A raise costs 5 ticks before block plus swing delay, so shields slow attack speed. ONLY 2 shield
// cases — skeleton's notched arrow and creeper swell; trading blows with zombies/spiders is pointless.
// Logic hooks directly to server signals; not a toggle (swell=shield) but a TIMER so blocking lands
// close to the arrow/blast and the bot keeps attacking meanwhile; shield lowers 5 ticks after the threat
// clears so the arrow still hits.
//
// TIMER NOT TOGGLE: a shield is TRADED ATTACK TIME. A toggle pays it for the WHOLE fuse; the timer pays
// once at the end and returns the intervening 500–1000 ms as swings. The machine's edge is knowing
// exactly when to flinch — flinching early spends it on nothing.
//
// REPLACED (deleted, Law 16 — not a fallback): `archer_calculator.shouldGuard` + `GUARD_WHILE_ENGAGED =
// true` (engaged with archer ⇒ blocking; only the swing lowers). Written under an old criterion of zero
// damage accepted; criterion is now attack speed with defence bought only where needed — an always-true
// predicate cannot express that. An always-guarding predicate can meet its own letter and still fail the
// fight against a kiting target it never catches.
//
// TRIGGERS SERVER-READ, NOT MODELLED (Law 23) — AND NOT READ HERE: commander decodes and posts id lists
// (`swelling`, `notching`); this seat only reads lists — the commander is the sole announcer of combat
// data, so a second reader can be added later at no cost.
//
// ONLY A POSITIVE SIGNAL RAISES — deliberate departure from shouldGuard, which also guarded on UNREADABLE
// (Law 13 default-stop) but ran inside a counter that knew it fought an archer. The board carries every
// ACTIVE hostile, so "unreadable ⇒ guard" would shield at a zombie with a late metadata array — a third
// case in a two-case ruling. The sensing failure is not swallowed: the commander counts unread/quiet
// passes in its own line, so a metadata index moved by a version bump surfaces as a number, not a shield
// that quietly stopped coming up (Law 25).
//
// DEADLINES: BOW_DRAW_MS=1000 is a measured constant, tight around 1.0 s (samples in archer_calculator's
// header). SWELL_TO_BLAST_MS=1500 is SOURCE-READ from Java `maxSwell=30` (fuse_meter says so at the
// constant).
const SHIELD_ACTIVE_MS = 250;   // 5 ticks between the raise and the first block

// SLACK NUMBERS, CUT ON MEASURED JITTER. Both started at 250 ms — round, pre-measurement. Timed raises
// land 0–62 ms late relative to a 500 ms target, never early — one physics tick of jitter; 250 ms was
// roughly 5× the worst case measured.
// MARGIN 250→150: raise at 1000−(250+150)=600 ms into a draw; worst lateness → live at 912 ms vs arrow
// at 1000 — 88 ms (~1.8 ticks) slack. Guard/draw ~500→~400 ms, all returned to the arm.
// HOLD 250→150: covers the arrow IN FLIGHT (threat clears at loose, not landing). Arrow ~3 b/tick; 150 ms
// covers ~9 b, and the band holds the bot at 2.9 b (~50 ms flight). Old 250 covered ~15 b — further than
// the bot ever stands.
// FLOOR IS NOT ZERO: at 0 the raise is simultaneous with the arrow and blocks nothing (toggle-in-reverse).
// Engagement lens prints `raised Nms into the threat` per raise; landings at/past 750 ms mean the margin
// was cut through the jitter and the guard fails silently — the one failure here that looks like success
// in every other number.
const SHIELD_MARGIN_MS = 150;
const SHIELD_HOLD_MS = 150;

// shieldOrder({ threats, now }) → { guard, why, against, againstName, since }
// Pure decision, no bot/packets — same split as driver's `bandOrder`, living in the acting seat (a
// separate arithmetic module is a second home for the answer, Law 16). `since` and `againstName` ride
// out so no caller re-runs this argmax (Law 16). `threats` = [{ id, why, since }].
// EARLIEST threat wins: its deadline lands first, and a shield facing the wrong archer blocks nothing —
// a body turned toward the wrong threat still eats every hit from the one it should have raised against.
function shieldOrder({ threats, now }) {
  if (!threats || !threats.length) {
    return { guard: false, why: null, against: null, againstName: null, since: null };
  }
  let first = threats[0];
  for (const t of threats) if (t.since < first.since) first = t;
  const name = (first.entity && first.entity.name) || 'mob';
  const deadline = first.why === 'swell' ? SWELL_TO_BLAST_MS : BOW_DRAW_MS;
  const raiseAt = deadline - (SHIELD_ACTIVE_MS + SHIELD_MARGIN_MS);
  // A deadline shorter than the raise cost has no late moment — guard at once; don't read a negative
  // wait as "not yet" (Law 13).
  const guard = raiseAt <= 0 ? true : now - first.since >= raiseAt;
  return { guard, why: first.why, against: first.id, againstName: name, since: first.since };
}

// senseThreats(board, now) → [{ id, why, since, entity }] for every ACTIVE hostile posted as notching or
// swelling, stamped with when ITS OWN current threat began.
//
// DECODES NOTHING — signals arrive as id lists; the commander is the sole announcer of combat data, this
// seat only reads it. Its one job is what the commander can't do: turn a per-tick fact ("drawing now")
// into a DURATION, which a stateless sweep has no place holding. Wrong turn: pulling the notch decode
// back into this seat (`h.entity` is right there, one `bowDrawState` call looks cheaper than a board
// field) makes a second owner of the decode (Law 16) and prices the NEXT reader at a duplicate or
// cross-seat call.
//
// `threatStarts` is per-MOB, not one clock: two skeletons on alternating cycles sharing one `since`
// would keep re-stamping it and the raise point never arrives — shield permanently five ticks away.
// Pruned the moment a mob stops threatening, so a re-opened draw starts a fresh count (Invariant B).
//
// EVERY THREAT ANSWERED, FROM ANY MOB. Wrong turn, killed by measurement: gating this on the focus —
// skipping non-focus notches, taking a second archer's arrows on purpose — starved defence of every
// threat but the kill target and cost fights to the unfocused mob before the focused one was ever
// reached. Do not re-add a focus gate here to protect the guard for the kill target; that was tried and
// lost fights to the threat it ignored.
// Defence is unconditional here; selection happens one layer up (shieldOrder picks the single threat the
// one shield faces — a 180° shield answering the earliest deadline is the only choice a single facing
// admits, not abandonment of the others).
const threatStarts = new Map();
function senseThreats(board, now) {
  const out = [];
  const seen = new Set();
  const swellingIds = board.swelling || [];
  const notchingIds = board.notching || [];
  for (const h of board.active || []) {
    // SWELL OUTRANKS NOTCH if one mob carries both — its deadline ends the fight, not costs 6 hp.
    // Vanilla never produces both on one entity; stated so the branch order doesn't read as arbitrary.
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

// applyShield(bot, order, now) — the only place the shield is raised or lowered.
// LOWER IS LATCHED, RAISE IS NOT — the asymmetry exists because threat clearing means the arrow was
// RELEASED, not landed (the flag drops at the loose), so dropping guard on that edge drops it mid-flight
// — the one moment the mechanism exists for. `shieldClearAt` starts a hold; the lower waits it out.
// activateItem(true) = offhand (a main-hand shield blocks the swing). Both calls re-entrancy guarded on
// `shieldUp`: activateItem is a packet, 20/s is a stream no vanilla client produces (Law 19, same
// argument as aim's identical-yaw rule).
function applyShield(bot, order, now) {
  if (order.guard) {
    shieldClearAt = null;
    threatId = order.against;
    threatWhy = order.why;
    if (!shieldUp) {
      // A refused raise leaves the latch DOWN, so the next tick tries again rather than the seat
      // believing in a shield that was never raised (Law 25).
      if (!guardExternalSync(TAG, 'activateItem to raise the shield', () => bot.activateItem(true)).ok) return;
      shieldUp = true;
      shieldUpAt = now;
      // `waited` proves the timer is a timer — the ruling in one number (a toggle raises at 0; this
      // should read ~500 vs a notch, ~1000 vs a swell). Only takeable here: the threat start lives in
      // this seat's latch. Without it a raise event can't show lateness.
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
  // `held` is the cost side: ms the arm could not swing in. `waited` + `held` are the two halves of
  // "what did the guard cost"; neither is recoverable from the other.
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
  // PITCH HELD LEVEL — decided, not omitted: nothing reads it (bot.attack sends no rotation; server
  // resolves the hit by entity id), and a tracking pitch is a second continuously-written aim axis the
  // ruling never asked for. If a shot ever needs elevation, its owner says so.
  // heldYaw is only advanced on a facing that was actually written — a refused look must not leave the
  // seat believing it is pointing somewhere it never turned to (Law 25).
  if (!guardExternalSync(TAG, `look to yaw ${want.toFixed(3)}`, () => bot.look(want, 0, true)).ok) return false;
  heldYaw = want;
  return true;
}

// fire(bot, target, distance) → true when a packet left.
// `swingNow` already refuses beyond BOT_STRIKE_REACH and stamps the shared clock; this adds only the
// reach test BEFORE the call (else 20 Hz prints refusal warnings at a mob at 6 b) and the charge gate.
// The swing packet is still sent in one place in this fleet (Law 16).
function fire(bot, target, distance) {
  if (distance > BOT_STRIKE_REACH) return false;
  stats.inReach++;
  // Cooldown belongs to the item IN HAND, not the best in pack — a shovel swung on a sword's clock
  // releases uncharged, damage silently a fraction. Name-keyed cache: unchanged hand = one string compare.
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
  // A per-swing row stood here, into a per-decision sidecar record where volume was the point. It is
  // gone with that record, and it is the one deletion that cost a real capability: swing-by-swing range
  // bands, the decide→swing latency, and both bodies' positions at every release cannot go on the trace
  // at all (Law 5's aggregation rule is exactly the rule against per-tick lines).
  //
  // ONE fact out of it is load-bearing elsewhere and survives as a state change. `retireTarget` has to
  // tell "the bot killed it" from "it died near the bot" — a mob that burned, fell, or was killed by a
  // peer must not be credited as this bot's kill (Law 25). That was derived by joining every strike row
  // for the mob and asking whether any connected; the arm knows it the instant it first lands, so it
  // records it once per mob and `end` reads the count. Bounded by mobs fought, not by swings thrown.
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

// verifyWeapon(bot, why) — is there still a weapon in the hand; if not, start getting one.
// Verified after every swing, not once per battle.
// PER SWING, NOT PER TICK: a sword breaks only on the swing that spends its last durability — the swing
// is the only event that can change the answer; 20 Hz would scan inventory 19 times to re-learn the
// twentieth's answer (Invariant B is re-sense before ACTING, not polling for its own sake).
// DELEGATES rather than comparing names: `equipBestWeapon` already owns best-vs-held, no-ops when the
// hand is right, and soft-handles a lost equip race (Law 16). This seat's contribution is WHEN to ask.
// UNAWAITED — see header. `equipPending` stops a swing three ticks later firing a second swap into the
// first one's round trip.
function verifyWeapon(bot, why) {
  if (equipPending) return;
  stats.equipChecks++;
  const before = bot.heldItem && bot.heldItem.name;
  equipPending = true;
  Promise.resolve(combatUtils.equipBestWeapon(bot))
    .then((choice) => {
      if (!choice || !choice.item) {
        // Empty pack = the world's answer, not a fault/retry: fight on with fists (Law 13
        // environmental). Counted so bare-handed fights read "brought no sword", not "broken equip path".
        stats.equipFails++;
        return;
      }
      if (choice.item.name !== before) {
        // Held name just changed under the name-keyed cooldown cache; clear now so the next swing times
        // on the new weapon's clock (netherite swung on a wooden one's 625 ms releases uncharged).
        cachedWeaponName = null;
        crewLog.event(TAG, 'rearm', { from: before || 'empty_hand', to: choice.item.name, why });
      }
    })
    .catch((e) => {
      // Boundary translator (Law 16's one legal catch): mineflayer crossing, lost swap is environmental.
      // Named aloud — a silent catch would present a fist-fight as a normal engagement.
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

  // Once per engagement, before the first swing (latch WHY in §1). Here, not in `engage()`: engage takes
  // no bot (battle_stations throws the switch), and giving it one just to reach inventory puts a server
  // round-trip on a boundary that cannot wait for it.
  if (!armedThisEngagement) {
    armedThisEngagement = true;
    verifyWeapon(bot, 'engagement_opened');
  }

  const board = crewBoard.readCommander();
  const now = Date.now();

  // SHIELD DECIDES BEFORE THE FACING because it can TAKE the facing — the normal rule is face the
  // closest target, except when a threat requires the shield: guard and aim are one decision, guard
  // senior. Aim-first-then-correct would write two rotation packets in one tick.
  const threats = senseThreats(board, now);
  const order = shieldOrder({ threats, now });
  applyShield(bot, order, now);

  const near = focusTarget();
  // THE THREAT TAKES THE YAW AT THE NOTCH, NOT THE RAISE — the shield takes over the facing as well.
  // `order.against` is set whenever a threat exists, even on "not yet" ticks. Wrong turn (was live):
  // `shieldUp && …` pointed at the archer only in the last ~500 ms of a 1000 ms draw. A shield blocks
  // what it FACES — arriving at the facing on the raise tick leaves no margin for a slow tick, and the
  // turn is free (a rotation packet the gunner sends anyway). Facing commits at SENSE.
  const guardFace = order.against !== null
    ? (board.active || []).find((h) => h.id === order.against) || null
    : null;
  const face = guardFace || near;
  // MEASURED AGAINST THE NEAREST BODY, NOT THE FOCUS. Old compare (guard face vs swing target) tracked
  // "off the nearest" under closest-wins, but once focus landed the two match on every tick but a
  // creeper swell — a counter compared against focus reads zero through a fight spent turned away from a
  // nearby zombie: a true count answering a question nobody asked (Law 25). Against `closest` it prices
  // the tactic like the wave loop's `offClosestB`: time the face was off the body most able to reach it.
  if (face && board.closest && face.id !== board.closest.id) stats.facedThreatOverClosest++;

  if (!face) {
    stats.noTarget++;
    // Facing LEFT WHERE IT IS: a neutral snap is an unasked write, and the last facing is the best guess
    // at where the next mob comes from. `targetId` cleared so the next mob reads as a change, not a hold.
    targetId = null;
    writeBoard({ heldYaw, targetId: null, lastSwingAt: null, swings: stats.swings, shield: shieldUp, shieldWhy: threatWhy, shieldAgainst: threatId });
    return;
  }

  if (face.entity.id !== targetId) {
    targetId = face.entity.id;
    // The gunner reports where it decided to face. NOT a copy of commander's `focus`: that is what the
    // crew picked to KILL, this is what the body was pointed at — under the defensive stance they part
    // for most of a fight. why: guard = a live threat took the facing; focus = nothing threatening. The
    // guard/focus ratio is the whole reading of the inversion (time bought vs spent) — treating this as
    // the same as focus deletes the measurement. NO distance field: that is the commander's `aggro` /
    // driver's `mode` fact; a third copy is stale a tick later.
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

  // AIM THEN FIRE, same tick — not for the swing (bot.attack carries an entity id, no rotation) but so
  // an observer/footage sees rotation before attack; forcing the facing exists so the bot never attacks
  // a mob while visibly facing the opposite direction.
  // Weapon check AFTER the swing, not before (§4b): a weapon breaks ON the swing, a pre-check re-answers
  // the previous swing's question and puts the equip round trip between aim and trigger.
  //
  // ARM HELD ONLY WHILE THE GUARD IS ACTUALLY UP. Stance NOT relaxed: shield still answers every threat,
  // still takes yaw at the notch. Only the ARM's gate moved: from "anything drawing" (~1000 ms window)
  // to "guard live" (~250 ms inside it).
  // Wrong turn, measured: gating the arm on `threats.length` — refusing to attack whenever anything was
  // drawing — cost the fight: a two-archer wave held the arm through nearly the whole engagement with
  // zero swings landed, because alternating draws never leave a gap the wide gate finds. A gate that
  // never opens is a disarmed bot, not a stance.
  // The narrow gate gives up nothing: block happens at the RAISE — the first ~600 ms of a draw the shield
  // is not up, so a swing there trades against nothing; the wide gate only protected a swing animation
  // still running at the raise, which is SHIELD_MARGIN_MS's job.
  // Removing the hold entirely was tried and measured against the same waves: fewer swings and no more
  // kills than with it. Arm is almost never in reach while the guard is live; the hold is free and holds
  // the stance intended. Do not re-run that experiment expecting free damage.
  // STILL UNVERIFIED (Law 23): whether a swing sent while `activateItem` is held lands — measurement only
  // bounds it, does not confirm either way.
  if (shieldUp) stats.swingsHeld++;
  else if (near && fire(bot, near.entity, near.distance)) verifyWeapon(bot, 'post-swing');

  // AFTER the swing decision, never before it: the fight outranks the errand ("ill just make sure im not
  // activley swinging at something then ill do it"). Nothing above this line can be delayed by it.
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
// WHY THIS SEAT AND NOT THE ASKER. Digging and placing need a facing, and the driver may never write yaw
// under any circumstance. Moving the work to the seat that already holds the heading is the only
// arrangement in which one state keeps one owner (Invariant D); the alternative — lending the yaw out for
// the duration of a dig — is two writers of one heading with a promise between them.
//
// THE WANT IS READ FRESH EVERY TICK AND NOTHING IS REMEMBERED ABOUT IT. `crew_board`'s driver section
// carries a standing want, re-published while it holds; this seat holds no request of its own, only a job
// already IN FLIGHT. When the want stops appearing the in-flight job is dropped and the swing resumes —
// "if you have a new plan then ill just stop and continue my origional plan" (Invariant B).
//
// SYNCHRONOUS SEAT, MULTI-TICK JOB. The tick contract forbids awaiting (an await lets the next tick
// overtake and two ticks then hold the body), and `performDig`/`pillarStep` are async. So the job is
// STARTED here and its completion is read on a later tick off `_job.settled` — the seat stays one
// synchronous decision, and the thing that spans ticks is the work, not the decision.
function serveTerrain(bot, near, shieldUp) {
  const want = crewBoard.readDriver().terrainRequest;

  // WITHDRAWAL IS SILENCE, so it is detected by comparing the live want against the job in flight rather
  // than by any message. A job whose cell no longer matches the current want is abandoned: the flag is
  // dropped here and the promise is left to settle into a job nobody reads (the body finishes the swing
  // it started, which is the safe half — an abort mid-dig has no packet to send anyway).
  if (_job && (!want || want.kind !== _job.kind || !sameCell(want.at, _job.at))) {
    stats.terrainDropped++;
    crewLog.event(TAG, 'terrain', { state: 'dropped', kind: _job.kind, why: want ? 'want_changed' : 'want_withdrawn' });
    _job = null;
  }
  if (!want) return null;

  // The job settled since the last tick. Reported ONCE from the job's own recorded outcome, not
  // re-derived from the world: this seat says what it DID, and whether the world now matches is the
  // asker's question to re-sense (Law 23/25 meet here — truthful report, untrusted by the reader).
  if (_job && _job.settled) {
    const out = { kind: _job.kind, at: _job.at, state: _job.ok ? 'done' : 'failed', why: _job.why };
    if (_job.ok) stats.terrainDone++; else stats.terrainFailed++;
    crewLog.event(TAG, 'terrain', { state: out.state, kind: out.kind, why: out.why });
    _job = null;
    return out;
  }
  if (_job) return { kind: _job.kind, at: _job.at, state: 'working', why: 'in_flight' };

  // THE REFUSAL, and it is measured against the same reach the swing gate enforces rather than a second
  // number: a mob the bot could hit is a mob the yaw is spoken for. A shield up is the same answer for a
  // different reason — the guard owns the facing at the notch, and turning to dig drops the block.
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

  // Deliberately not awaited — see the seat/job note above. `.then` on a guarded call, so a rejection
  // inside the third-party library lands as a settled FAILURE with a reason rather than an unhandled
  // rejection that kills the process four subsystems away (Law 16: the one legal catch is the boundary
  // translator, and both of these already run inside one).
  if (want.kind === 'dig') {
    const block = bot.blockAt(at);
    // Nothing to break is a finished errand, not an error: the driver asked for a cell to be passable and
    // it already is. Answering `done` here rather than swinging at air is the honest verdict (Law 25).
    if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
      job.settled = true; job.ok = true; job.why = 'already_clear';
    } else {
      performDig(bot, at, block, TAG).then(
        (r) => { job.settled = true; job.ok = !!(r && r.success); job.why = (r && r.reason) || (r && r.success ? 'dug' : 'dig_failed'); },
        (e) => { job.settled = true; job.ok = false; job.why = `dig_threw:${e && e.message}`; });
    }
  } else {
    // Placement is a PILLAR UNDERFOOT and only that. The driver's one placing ask is "get me up", and
    // `pillarStep` already owns the whole verb — pick a build block, look down, jump, place (Law 16).
    // A general place-a-block-anywhere errand has no asker, so it is not built.
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

// stop RUNS THE FIGHT'S TEARDOWN: it used to drop the listener leaving the guard RAISED and the item
// activated — a lifecycle outliving its owner (Law 8). Calls disengage(bot), not a copy of its body: one
// teardown per seat (Law 16). Found by the bench (two sections share a process; the second opened with
// the first's shield up); live equivalent is a stop mid-fight.
function stop(bot) {
  if (!attached || !tickHandler) return;
  disengage(bot);
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  tickHandler = null;
  attached = false;
}

// engage/disengage — the ONLY switch, separate from start/stop so the handler stays attached across a
// session (attach/detach per engagement is a leak-prone lifecycle, Law 8; the flag is one boolean read).
// Both ends clear facing+target: a carried facing makes the next fight's first tick a HOLD against a
// dead mob's bearing (Invariant B).
function engage() {
  engaged = true;
  heldYaw = null;
  targetId = null;
  lastSwitchTick = null;
  // A terrain job cannot outlive the wave that asked for it (Law 8). The want it served belongs to a
  // driver engagement that is over, so carrying it would serve a dead plan on a live fight.
  _job = null;
  // Hand re-verified at next tick top, never carried over: a weapon broken on the last wave's final
  // swing would otherwise go unnoticed until this wave's first hit (Invariant B).
  armedThisEngagement = false;
  cachedWeaponName = null;
  // Shield latch dies at both boundaries like the facing: a last-wave threat start would compute elapsed
  // against a dead creeper, raise point already past (Invariant B). `shieldUp` NOT forced false — the
  // BODY may still be blocking; lying to the latch leaves the shield up untracked. `disengage` lowers it
  // for real.
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
  // SHIELD COMES DOWN WITH THE FIGHT (Law 8): a guard left up outside an engagement walks the body home
  // at a third of its speed with nothing tracking why — same leak class as a driver holding `forward`.
  threatStarts.clear();
  threatId = null;
  threatWhy = null;
  shieldClearAt = null;
  if (shieldUp) {
    guardExternalSync(TAG, 'deactivateItem on disengage', () => (bot || global.bot).deactivateItem());
    // by=disengage, not the timer's lower: a guard still up at fight end is the one shield leak the
    // raise/lower pairing cannot show (the pair completes either way). The lens needs which hand closed it.
    crewLog.event(TAG, 'shield', { state: 'down', held: `${Date.now() - shieldUpAt}ms`, by: 'disengage' });
    shieldUp = false;
    shieldUpAt = null;
  }
  // `equipPending` NOT cleared: it guards an in-flight round trip that does not care the fight ended;
  // clearing it lets the next engagement fire a second equip into the first's reply. Its own `.then`
  // releases it (Law 8 — the lifecycle ends with its owner).
}

// report() — the gunner's own line, written by whoever owns the engagement boundary.
// SURVIVAL TEST: if the lens can count it from the event stream it was deleted here — a total beside its
// events is the same fact twice, drifting on edit. What survives is what events cannot carry: TICKS THAT
// EMITTED NOTHING (in-reach ticks with the clock filling, band holds). Deleted, read instead:
// swings/weapon → `strike`; re-arms → `rearm`; raises/triggers → `shield state=up why=`; target changes
// → `face`.
// BAND stays a ratio, never a raw switch count: 40 switches is correct tracking of a circling mob AND
// judder — opposite fixes; `fastSwitches` vs `switches` discriminates (Law 25). Neither is an event:
// a yaw write is far below a decision worth announcing.
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
    // Shield COST in ticks the arm could not swing in (events only bound wall-clock). `settleTicks`
    // split out: the only part spent AFTER the danger — if it dominates, the hold is sized wrong, not
    // the timer.
    `Shield: up for ${s.guardTicks} tick(s) of ${s.ticks}` +
    `${s.settleTicks ? ` (${s.settleTicks} settling after the threat cleared)` : ''}` +
    // Price of "when the shield is up, it cant attack", counted not assumed. Large fraction of
    // `charged` = the guard is eating the kill it was raised to enable.
    `${s.swingsHeld ? `, arm held on ${s.swingsHeld} tick(s)` : ''}` +
    `${s.facedThreatOverClosest ? `, facing off the nearest mob for ${s.facedThreatOverClosest} tick(s)` : ''}.`);
  // A fist-fight is not a judder: the pack held no weapon the table scores — a SUPPLY failure upstream
  // of combat, invisible in every other number (swings land, facing tracks, damage is a third) (Law 25).
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
  // Bench export, same terms as driver.bandOrder: the timer's whole value is WHEN it fires; a pin that
  // can only observe the raise end-to-end has to sleep through every case.
  shieldOrder, SHIELD_ACTIVE_MS, SHIELD_MARGIN_MS, SHIELD_HOLD_MS,
};
