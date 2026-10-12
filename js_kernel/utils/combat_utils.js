// module: combat_utils — the one home for every combat ACT primitive. Primitives move the bot, never
// emit signals or route payloads; composition (which mob/tactic/when to abandon) belongs to
// battle_stations. Pure arithmetic lives in attack_cadence_calculator; facts there, policy here.
//
// Hit damage is a function of time since last hit, not aim: Java refills "charge" over 1/attackSpeed s
// and scales damage 0.2 + 0.8·charge²; a damaged mob is invulnerable 10 ticks, absorbing equal-or-weaker
// hits entirely. An immediate re-swing does around 20% damage or often none, with nothing in-world
// reporting either half (the swing animates, the log says landed). Every primitive here is built around
// that clock.

'use strict';

const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');
const { sleep } = require('@utils/fragment_utils');
const { weaponProfile, attackCharge, chargeDamageMultiplier, msUntilCharge, swingPeriodMs, CRIT_MIN_CHARGE, sustainedDamagePerSecond } = require('@utils/calculators/attack_cadence_calculator');
// `BOT_STRIKE_REACH` is the reach `swingNow` gates on, so its one owner is the file that owns the swing.
// `BOT_WIDTH` is exported for the driver's vertical case, where a mob's column overlapping the bot's own
// is the only derived statement of arrived-beneath available, and a copy over there would drift from the
// reach figure it shares a derivation with (Law 16).
const BOT_STRIKE_REACH = 3.0;   // matches the `reach` battle_stations already passes canLandStrike
const BOT_WIDTH = 0.6;
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'combat_utils';

// ── 1. THE SWING CLOCK ───────────────────────────────────────────────────────
// Module-level (Law 9: per-process transient, one owner); read through the functions below, never a
// bare export, so nothing writes it out of step with a swing (Law 6). mineflayer tracks no cooldown
// itself — `bot.attack` sends its packets synchronously — so this clock is an estimate stamped at send
// time, and wait helpers add margin against latency making it optimistic.

let _lastSwingAt = 0;      // epoch ms of the last swing THIS process fired
let _swings = 0;           // monotonic, for the trace only

// Java resets attack cooldown on a held-item change; the stamp stops the next swing from reading full
// charge. Without it, switching weapons every swing would let the bot land repeated full-damage strikes
// it has not actually recovered for — a fairness constraint (Law 19), not a correctness optimisation
// (Invariant E, Rogue Machine).
function noteEquip() { _lastSwingAt = Date.now(); }

function msSinceLastSwing(now) {
  if (!_lastSwingAt) return Infinity;                 // never swung ⇒ fully charged
  return (now != null ? now : Date.now()) - _lastSwingAt;
}

// chargeNow(cooldownMs) → 0..1, this process's estimate of the server's attack charge.
function chargeNow(cooldownMs, now) {
  const since = msSinceLastSwing(now);
  if (since === Infinity) return 1;
  return attackCharge(since, cooldownMs);
}

// Inspection surface (Law 6). Read-only by construction — snapshot, not the variables.
function swingClock(cooldownMs) {
  const since = msSinceLastSwing();
  const charge = chargeNow(cooldownMs);
  return {
    swings: _swings,
    msSinceLastSwing: since === Infinity ? null : since,
    charge,
    damageFraction: chargeDamageMultiplier(charge),
    critEligible: charge > CRIT_MIN_CHARGE,
  };
}

// Test seam ONLY — clock is process-global, a swinging test would poison the next. A production fight
// needing to forget its own cadence is a bug in the fight.
function _resetSwingClock() { _lastSwingAt = 0; _swings = 0; }

// ── 2. EQUIP THE BEST WEAPON — one stat-aware ranking, sword-primary by arithmetic ───────────────────
// One score, sustainedDamagePerSecond (full-charge damage over the real minimum time between two
// landing hits), ranks every weapon; no category rungs. Sword-primary is the output of that score, not
// a rule, and backup on a broken sword is emergent: the next-best score becomes whichever item is left.
// A stats-aware score, not a category preference, so a high-tier axe can outrank a junk sword.

// _score(itemName) → sustained dps; null (not 0) for non-weapons, so a caller can tell "scored badly"
// from "not a weapon".
function _score(itemName) {
  const p = weaponProfile(itemName);
  if (!p.known) return null;
  return sustainedDamagePerSecond(itemName);
}

// Tie-break for identical scores (golden and wooden sword both read 6.4): a fixed category order makes
// the choice deterministic (Law 19).
const _CATEGORY_PREFERENCE = { sword: 0, axe: 1 };
function _prefers(candidate, incumbent) {
  const c = _CATEGORY_PREFERENCE[candidate.category] ?? 2;
  const i = _CATEGORY_PREFERENCE[incumbent.category] ?? 2;
  if (c !== i) return c < i;
  return false;   // same category and same score — keep the incumbent, so the scan is order-stable
}

// heldWeaponName(bot) → what is actually in hand, 'fist' when nothing. Distinct from pickBestWeapon:
// they can disagree exactly when it matters (durability break, failed swap, never-equipped arm), so a
// measurement is tagged with the weapon that actually swung, not the one merely intended. Reads 'fist',
// not null or 'none', so tallies group it as a weapon — a condition under test.
function heldWeaponName(bot) {
  return (bot && bot.heldItem && bot.heldItem.name) || 'fist';
}

// pickBestWeapon(bot) → { item, profile, rung }; item null = bare hands. `rung` is the winning CATEGORY
// ('sword'|'axe'|'tool'|'fist'), not a ladder index — no ladder; the log says what the arithmetic chose.
function pickBestWeapon(bot) {
  const items = (bot && bot.inventory && bot.inventory.items()) || [];
  let best = null, bestScore = -1, bestProfile = null;
  for (const it of items) {
    if (!it || !it.name) continue;
    const score = _score(it.name);
    if (score == null) continue;
    const profile = weaponProfile(it.name);
    if (score > bestScore || (score === bestScore && bestProfile && _prefers(profile, bestProfile))) {
      bestScore = score; best = it; bestProfile = profile;
    }
  }
  if (!best) return { item: null, profile: weaponProfile(null), rung: 'fist' };
  const rung = bestProfile.category === 'sword' || bestProfile.category === 'axe' ? bestProfile.category : 'tool';
  return { item: best, profile: bestProfile, rung };
}

// equipBestWeapon(bot) → same shape after equipping. Already-held no-ops without stamping the clock: no
// item change is sent, and stamping would dump charge on every pass of an engagement loop.
async function equipBestWeapon(bot) {
  const choice = pickBestWeapon(bot);
  if (!choice.item) return choice;
  if (bot.heldItem && bot.heldItem.name === choice.item.name) return choice;
  // mineflayer's equip losing a race with an inventory update is environmental: degrade to the rung
  // below, and report the degraded rung as `rung`, so a caller reading it never sees the weapon it
  // asked for when the bot is actually holding fists.
  if (!(await guardExternal(TAG, `equip ${choice.item.name}`, () => bot.equip(choice.item, 'hand'))).ok) {
    return { item: bot.heldItem || null, profile: weaponProfile(bot.heldItem ? bot.heldItem.name : null), rung: 'fist' };
  }
  noteEquip();
  return choice;
}

// swingNow(bot, entity, tag) — raw hit + clock stamp, in that order, never separated. Every swing goes
// through here or the clock lies about how long it should wait (Law 25). Range travels with the swing
// record, since an out-of-reach swing cannot land yet still spends the cooldown. The caller hands down
// its own tag: the strike belongs to the ordering seat, so the gunner's trace filter can find its own
// swings under its own name.

// swingDistance(bot, entity) → live centre-to-centre gap, null when a body is unreadable. Split out so
// the refusal gate and the journal read the same measurement, not two samples taken moments apart
// (Law 16).
// Unguarded: the two null checks are the guard — an unreadable body is a state to read, not an
// exception to catch, and null here means unreadable, never a guessed number.
function swingDistance(bot, entity) {
  if (!bot.entity?.position || !entity?.position) return null;
  return bot.entity.position.distanceTo(entity.position);
}

function swingNow(bot, entity, tag) {
  // A missing tag is a coding violation (Law 13): a silent fallback here would make a strike
  // unattributable at whichever call site forgot to pass one.
  if (!tag) throw new Error('[combat_utils] swingNow requires the ordering seat\'s tag — a strike belongs to whoever ordered it, not to this utility.');
  // Reach is a precondition, not a warning: a swing beyond reach cannot land, so it is refused before
  // the packet is sent. Gated here, not per-arm, since every melee swing funnels through this function
  // (Law 16). A refusal does not stamp the clock — nothing was spent, so the next pass may swing the
  // instant the mob is in reach.
  const d = swingDistance(bot, entity);
  if (d != null && d > BOT_STRIKE_REACH) {
    watcher.warn(TAG,
      `🚫 swing REFUSED at ${d.toFixed(2)}b — beyond the ${BOT_STRIKE_REACH}b reach, so it could not land and would ` +
      `spend the cooldown for nothing. No packet sent and the swing clock is untouched; the arm may swing again ` +
      `the moment the body is inside reach.`);
    return false;
  }
  // mineflayer can refuse an attack on an entity that left the table between the gate above and this
  // line. A refused swing spends nothing, so the clock is not stamped, same as a reach refusal (Law 25).
  if (!guardExternalSync(TAG, `attack ${entity && entity.name}`, () => bot.attack(entity)).ok) return false;
  _lastSwingAt = Date.now();
  _swings++;
  // `hp` is the target's health, the fleet's only view of it in this line. The bot's own health is
  // deliberately absent, since it changes on the mob's schedule, not the swing's. The field is often
  // absent — mineflayer does not reliably populate `entity.health` — and crew_log drops nulls for free.
  crewLog.event(tag, 'strike', {
    subject: crewLog.subject(entity),
    d: d == null ? null : d.toFixed(2),
    with: (bot.heldItem && bot.heldItem.name) || 'fists',
    hp: entity && typeof entity.health === 'number' ? entity.health.toFixed(1) : null,
  });
  return true;
}

// ── THE SPRINT FLAG ──────────────────────────────────────────────────────────
// The driver arms sprint every approach tick; a plain setControlState('sprint', true) cannot be trusted
// after a hit.
//
// Java's Player.attack() ends a sprint attack with setSprinting(false) server-side; mineflayer's
// controlState.sprint stays true (bot.attack only writes use_entity), so a plain setControlState
// short-circuits on equal state and sends nothing — the body then sprints until the first swing and
// walks the rest with the flag still reading true. `armSprint` forces false-then-true: the
// redundant-looking `false` is the fix. It is synchronous by contract, since an await between the sprint
// and attack packets breaks the ordering Java's knockback check depends on — both go down one TCP stream
// in call order.
//
// prismarine-physics also adds a horizontal impulse in the facing direction when a jump starts under
// sprint; the gunner faces the mob, so a sprint-jump shoves the bot into it — driver.js taps jump only
// on a measured stall, never holds it.

const KNOCKBACK_SETTLE_MS = 400;   // long enough for a shove to play out before measuring it

// armSprint(bot) → true once the start_sprinting packet is written.
// Unguarded: setControlState only asserts on a bad control name or a non-boolean state, both literals
// here, so a wrapped guard could only ever fire on a defect and must travel (Law 13).
function armSprint(bot) {
  bot.setControlState('sprint', false);
  bot.setControlState('sprint', true);
  return true;
}

function releaseSprint(bot) {
  // Unguarded: setControlState's only throw is an assert on a bad control name or non-boolean state,
  // which would be our defect and must travel (Law 13).
  bot.setControlState('sprint', false);
}

// ── 8. THE TWO TACTICS — the fleet's whole monster taxonomy ──────────────────
// Every monster resolves to exactly one of two counters (Law 16): stand still and knock back what
// approaches, or charge what kites — everything else is a special case of one of those two.
//
// The discriminator is one question: does it come to you? Walks/swims/flies/teleports into reach on its
// own ⇒ BRAWLER (standing still is free; the bot's own ground is the only verified ground). Holds range,
// retreats, or won't move ⇒ KITER (waiting is waiting forever, under fire).
//
// Hardcoded, not a file read: these are fixed strings. monster_tactics.json's `group` field is
// documentation only — a third counter reads the JSON, a fight reads this. Two monsters share a list
// only if the same counter, unmodified, works on both.
const COMBAT_TACTICS = {
  BRAWLER: 'BRAWLER',   // comes to the bot on its own. The driver sprints into it and keeps the shove.
  KITER:   'KITER',     // will not come, or backs away. A shove undoes the approach that earned it.
};

// Authored tactic→[names] (the shape a human edits); consumed name→tactic below (the shape a fight looks up).
const MONSTER_TACTICS = {
  // Comes on its own — met where the bot already stands. The creeper counts as BRAWLER: the zombie pass
  // and a shield while it swells beats it, since no movement-based counter can outrun the fuse. Swoopers
  // are let in, then knocked back; splitters are stood among their children once closed. A few names
  // here have no answer that beats them; not walking toward them is the least bad one.
  BRAWLER: [
    'zombie', 'zombie_villager', 'husk', 'drowned', 'spider', 'cave_spider', 'endermite',
    'creeper',
    'wither_skeleton', 'vindicator', 'piglin_brute', 'hoglin', 'zoglin', 'zombified_piglin', 'piglin', 'polar_bear',
    'ravager', 'iron_golem',
    'silverfish', 'wolf', 'bee',
    'slime', 'magma_cube',
    'phantom',
    'vex',
    'enderman',
    'creaking',
    'warden', 'wither', 'ender_dragon',
  ],

  // Will not come; every second waiting is spent under fire. Archers and displacers are beaten by
  // closing the distance; casters spend the delay healing or summoning; turrets will not follow.
  KITER: [
    'skeleton', 'stray', 'bogged', 'pillager',
    'witch', 'evoker',
    'blaze', 'ghast', 'guardian', 'elder_guardian', 'shulker',
    'breeze',
  ],
};

// Reverse index, built once at load.
const _TACTIC_OF = {};
for (const [tactic, names] of Object.entries(MONSTER_TACTICS)) {
  // A malformed tactic key is caught here at load, before it can fall through battle_stations'
  // dispatch and read as a targeting bug (Law 13).
  if (!COMBAT_TACTICS[tactic]) throw new Error(`[${TAG}] MONSTER_TACTICS names "${tactic}", which is not one of the two built arms`);
  for (const n of names) {
    if (_TACTIC_OF[n]) {
      // A name in both lists ⇒ both arms claim it and key order decides — throw instead.
      throw new Error(`[${TAG}] "${n}" is listed under both ${_TACTIC_OF[n]} and ${tactic} — one monster, one tactic`);
    }
    _TACTIC_OF[n] = tactic;
  }
}

// combatTactic(entityName) → 'BRAWLER' | 'KITER', or null for an unclaimed name — never a default. An
// absent name is environmental (modded, game-update, mislabelled passive) (Law 13), and the policy
// belongs to the caller. The driver's null policy is to brake: withholding a shove costs one approach,
// while shoving something that flees costs the engagement.
//
// Also the roster of known hostiles: camera's combat_witness and tools/combat_recorder test `!== null`
// directly; a separate membership set would be a second route that could drift (Law 16).
function combatTactic(entityName) {
  if (!entityName) return null;
  return _TACTIC_OF[String(entityName).toLowerCase()] || null;
}

// The neutrals, separate from the tactic table: tactics answer how to fight something, this answers
// whether there is a fight at all (each is inert until the bot acts). An unprovoked iron golem and one
// already swinging want opposite behaviour, so the two questions cannot share one answer.
const NEVER_INITIATE = new Set([
  'enderman',            // provoked by the crosshair alone — the scanner's own aim starts this one
  'zombified_piglin',    // one hit aggros every piglin in a radius larger than the scan
  'piglin',              // and gold armour prevents it outright, which is a counter with no combat in it
  'iron_golem',          // village property; killing one is also a social act the fleet has not modelled
  'wolf', 'polar_bear', 'bee',
]);

// shouldInitiate(entityName) → false only for names the bot should never swing at first. Not wired into
// a fight path yet — declining to attack is a counter of its own. Exported so that counter does not
// invent a second list (Law 16).
function shouldInitiate(entityName) {
  if (!entityName) return true;
  return !NEVER_INITIATE.has(String(entityName).toLowerCase());
}

module.exports = {
  BOT_STRIKE_REACH, BOT_WIDTH,

  // The one live swing route is `swingNow`, called by `gunner.fire`; sprint stays armed through the
  // driver's approach, read by `swingNow` at resolve time.
  armSprint,
  releaseSprint,

  // The two tactics, and the roster of known hostiles built from them.
  COMBAT_TACTICS,
  MONSTER_TACTICS,
  combatTactic,
  NEVER_INITIATE,
  shouldInitiate,

  // Weapon selection
  pickBestWeapon,
  heldWeaponName,
  equipBestWeapon,

  // The swing clock — one clock, and `swingNow` is the one thing that stamps it
  swingClock,
  chargeNow,
  msSinceLastSwing,
  noteEquip,
  swingNow,
  // Exported so a journal row records the same sample the reach gate judged, not its own later one.
  swingDistance,

  // Exported so a caller taking the shove after the primitive waits the same interval, or it is
  // measuring a different quantity under the same name.
  KNOCKBACK_SETTLE_MS,

  // Test seam
  _resetSwingClock,
};
