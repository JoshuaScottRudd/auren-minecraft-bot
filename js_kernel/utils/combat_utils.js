// module: combat_utils — the ONE home for every combat ACT primitive. Primitives
// MOVE THE BOT, never emit signals/route payloads; COMPOSITION (which mob/tactic/when to abandon) is
// battle_stations' — escalation has nothing to choose until the rungs are real primitives. Pure
// arithmetic lives in attack_cadence_calculator; facts there, policy here (§2 asks it to rank weapons).
//
// THE NON-OBVIOUS CORE: hit damage is a function of TIME SINCE LAST HIT, not aim. Java refills "charge"
// over 1/attackSpeed s, scales damage 0.2 + 0.8·charge²; a damaged mob is invulnerable 10 ticks,
// absorbing equal-or-weaker hits entirely. Immediate re-swing ⇒ ~20% damage, often none; nothing
// in-world reports either half (swing animates, log says landed). A bare sleep between swings can cut
// damage several-fold with no trace showing it. Every primitive is built around that clock. Before
// "simplifying" it away, see WRONG TURN in attack_cadence_calculator: the charge curve alone argues for
// spam-clicking; the invulnerability window settles it.

'use strict';

const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');
const { sleep } = require('@utils/fragment_utils');
const { weaponProfile, attackCharge, chargeDamageMultiplier, msUntilCharge, swingPeriodMs, CRIT_MIN_CHARGE, sustainedDamagePerSecond } = require('@utils/calculators/attack_cadence_calculator');
// ── THE TWO BODY CONSTANTS, AND WHY THEY LIVE IN THE PRIMITIVES FILE ───────────────────────────────
// They were `repel_calculator`'s, and that file is gone (2026-08-22). It held two things: a knockback
// MODEL — how far a blow shoves a mob, a measured constant, a band-sustains predicate and a
// strike/wait/too_close decision — and these two numbers. The whole model was deleted because nothing
// branched on it: every call site printed, none decided, and the meter and cross-run ledger that existed
// to keep the constant honest were grading a figure no behaviour read. The tactic is unchanged and
// always was: hit, let the knockback happen, hold the band.
//
// The numbers came HERE rather than to a smaller calculator because a calculator that is two constants
// is not a calculator (Law 7 — a name must describe what the file is). `BOT_STRIKE_REACH` is the reach
// `swingNow` gates on, so its one owner is the file that owns the swing; `BOT_WIDTH` is exported for the
// driver's vertical case, where "the mob's column overlaps mine" is the only derived statement of
// ARRIVED-BENEATH available, and a copy over there would drift from the reach figure it shares a
// derivation with (Law 16).
const BOT_STRIKE_REACH = 3.0;   // matches the `reach` battle_stations already passes canLandStrike
const BOT_WIDTH = 0.6;
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'combat_utils';

// ── 1. THE SWING CLOCK ───────────────────────────────────────────────────────
// Module-level per Law 9 (per-process transient, one owner); readers below, not a bare export, so
// nothing writes it out of step with a swing (Law 6). mineflayer tracks NO cooldown — `bot.attack` sends
// use_entity + swing_arm synchronously (entities.js:839) — so the clock is ours, and only an ESTIMATE
// stamped at packet send; latency makes it optimistic, hence wait helpers add margin vs firing at 1.0.

let _lastSwingAt = 0;      // epoch ms of the last swing THIS process fired
let _swings = 0;           // monotonic, for the trace only

// Java resets attack cooldown on held-item change — the stamp stops the next swing believing full charge.
// DO NOT DELETE: LAW 19 CONSTRAINT, not a correctness bet — weapon-swap instant hits (rapid full-damage
// strikes by switching weapons every swing) is cheating humans would rightly see as unfair. Treating the
// stamp as a mere server-prediction optimization misses this: server resets the cooldown ⇒ stamp
// accurate; doesn't ⇒ construct declines a trivially-available exemption (Invariant E, Rogue Machine).
// Cost accepted: one cooldown at fight start; hold.js pays it while the mob walks in, not at the strike gate.
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
// Sword primary, axe backup on break, no durability care — one logic drives both, aware of the stats:
// attack speed and cooldown. No category rungs: ONE score, sustainedDamagePerSecond (full-charge damage
// over the real minimum time between two landing hits). Sword-primary is the OUTPUT — the sword's 1.6
// attack speed beats the axe at every tier (stone 8.0 vs 7.2 dps, diamond 11.2 vs 9.0, netherite 12.8 vs
// 10.0). Backup is emergent: a broken sword leaves the inventory, next-best score IS the axe. Old code
// stacked a category branch (`endsWith('_axe')`) over a damage-only score — two logics a successor had
// to find. One consequence flagged not special-cased: a high-tier axe outranks a junk sword (diamond axe
// 9.0 > stone sword 8.0) — a stats-aware score, not a category preference; fix, if ever wanted, is one
// predicate.
// WRONG TURN (the deleted comment argued it well): axe-first on per-hit damage because strike-and-fade
// lands one hit per approach. Still true FOR THE CREEPER ARM; lost because the BRAWLER repel is
// stand-and-repeat, where cycle rate is the whole tactic (sword: repel cycle 20 → 12.5 ticks). One
// ladder serves both arms by ruling; sustained DPS contains per-hit damage instead of discarding cooldown.

// _score(itemName) → sustained dps; null (not 0) for non-weapons so callers tell "scored badly" from
// "not a weapon" — unrecognised items are fought with fists, not swung at fist cadence unknowingly.
function _score(itemName) {
  const p = weaponProfile(itemName);
  if (!p.known) return null;
  return sustainedDamagePerSecond(itemName);
}

// Tie-break for identical scores (golden and wooden sword both read 6.4): a fixed category order, so the
// choice is deterministic rather than inventory-order dependent (Law 19).
const _CATEGORY_PREFERENCE = { sword: 0, axe: 1 };
function _prefers(candidate, incumbent) {
  const c = _CATEGORY_PREFERENCE[candidate.category] ?? 2;
  const i = _CATEGORY_PREFERENCE[incumbent.category] ?? 2;
  if (c !== i) return c < i;
  return false;   // same category and same score — keep the incumbent, so the scan is order-stable
}

// heldWeaponName(bot) → what is ACTUALLY in hand, 'fist' when nothing. NOT pickBestWeapon: they disagree
// exactly when it matters (durability break, failed swap, never-equipped arm) — a measurement tagged with
// the intended weapon, not the one that swung, is an inexplicable outlier. 'fist' not null/'none' so
// tallies group it as a weapon — a condition under test.
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

// equipBestWeapon(bot) → same shape after equipping. Already-held no-ops WITHOUT stamping the clock: no
// item change is sent, and stamping would dump charge on every pass of an engagement loop.
async function equipBestWeapon(bot) {
  const choice = pickBestWeapon(bot);
  if (!choice.item) return choice;
  if (bot.heldItem && bot.heldItem.name === choice.item.name) return choice;
  // A real boundary: mineflayer equip losing a race with an inventory update is environmental. Degrade to
  // the rung below rather than dropping the fight — and the degraded rung is REPORTED as the rung, so a
  // caller reading `rung` never sees the weapon it asked for when the bot is holding fists.
  if (!(await guardExternal(TAG, `equip ${choice.item.name}`, () => bot.equip(choice.item, 'hand'))).ok) {
    return { item: bot.heldItem || null, profile: weaponProfile(bot.heldItem ? bot.heldItem.name : null), rung: 'fist' };
  }
  noteEquip();
  return choice;
}

// swingNow(bot, entity, tag) — raw hit + clock stamp, in that order, never separated. EVERY swing goes
// through here or the clock lies and confidently waits the wrong amount (Law 25).
// PER-SWING ANNOUNCE, against Law 5's aggregation rule: an aggregate line can post "cycle HOLDS" while an
// outside observer's tape shows the bot pinned taking a hit a second — both true, neither says WHO or
// from how far. Self-limiting anyway: 625ms cooldown ⇒ ~1.6 lines/s, target-only — a fight is a dozen
// lines. Range is the payload, not decoration: an out-of-reach swing can't land yet spends the cooldown,
// invisible in the human channel if left out.
// CALLER HANDS DOWN ITS TAG: one route, and the ORDERER owns it — the strike is the ordering seat's act;
// under [COMBAT_UTILS] the gunner's trace filter loses its swings. Wrong turn: per-caller emission after
// the call = two emitters on one fact (Law 16 drift), re-measuring a distance the gate never saw.

// swingDistance(bot, entity) → live centre-to-centre gap, null when a body is unreadable. Split out so
// the REFUSAL gate and the journal never disagree — one measurement, two readers (Law 16); a recorder
// re-sampling ms later prints a distance the gate never saw and makes the gate look leaky.
// Unguarded: the two null checks ARE the guard. "No body to measure from" is a state to read, not an
// exception to catch, and distanceTo on two live Vec3s cannot fail. null here means unreadable, never a
// guessed number.
function swingDistance(bot, entity) {
  if (!bot.entity?.position || !entity?.position) return null;
  return bot.entity.position.distanceTo(entity.position);
}

function swingNow(bot, entity, tag) {
  // Law 13 coding violation, not a default: a silent fallback to this module's tag would reintroduce the
  // unattributable-strike ambiguity, quietly, at the one call site a successor forgot to update.
  if (!tag) throw new Error('[combat_utils] swingNow requires the ordering seat\'s tag — a strike belongs to whoever ordered it, not to this utility.');
  // REACH GATE — PRECONDITION, not warning: a swing beyond reach cannot land, so it is refused before the
  // packet is sent rather than reported after. Old code measured AFTER the packet — a true "OUT OF
  // REACH, cooldown spent" about a swing already thrown away, mob free for 625ms. Gate here, not per-arm:
  // every melee swing funnels through this function; a gate in one arm leaves the others open (Law 16).
  // A REFUSAL IS NOT A FAILURE and does not stamp the clock — nothing spent, the next pass may swing the
  // instant the mob is in reach. That is the difference from an abort.
  const d = swingDistance(bot, entity);
  if (d != null && d > BOT_STRIKE_REACH) {
    watcher.warn(TAG,
      `🚫 swing REFUSED at ${d.toFixed(2)}b — beyond the ${BOT_STRIKE_REACH}b reach, so it could not land and would ` +
      `spend the cooldown for nothing. No packet sent and the swing clock is untouched; the arm may swing again ` +
      `the moment the body is inside reach.`);
    return false;
  }
  // The one real boundary in the swing: mineflayer refuses an attack on an entity that left the table
  // between the gate above and this line. A refused swing spends nothing, so the clock below is NOT
  // stamped — same rule as the reach refusal (Law 25: the clock records swings that happened).
  if (!guardExternalSync(TAG, `attack ${entity && entity.name}`, () => bot.attack(entity)).ok) return false;
  _lastSwingAt = Date.now();
  _swings++;
  // `hp` is the TARGET's — the line's subject and the fleet's only view of mob health. Bot's own health
  // deliberately absent: changes on the mob's schedule, not the swing's (wrong clock); belongs to a
  // future own-condition seat. Field is regularly absent — mineflayer does not reliably populate
  // `entity.health`. Kept: free when absent (crew_log drops nulls); if it arrives it is the damage curve.
  // Chase it in the synched-entity-data mapping, not here. WRONG TURN: deriving hp from damage tables =
  // inventing a number the server owns (Law 25).
  crewLog.event(tag, 'strike', {
    subject: crewLog.subject(entity),
    d: d == null ? null : d.toFixed(2),
    with: (bot.heldItem && bot.heldItem.name) || 'fists',
    hp: entity && typeof entity.health === 'number' ? entity.health.toFixed(1) : null,
  });
  return true;
}

// ── THE SPRINT FLAG — what survives of the strike primitives ─────────────────
// All users deleted (see module.exports); these survive because the DRIVER arms sprint every approach
// tick, and the trap below is why one setControlState('sprint', true) cannot be trusted.
// SPRINT DESYNC AFTER A HIT, SILENT: Java's Player.attack() ends a sprint attack with
// setSprinting(false); server flag drops, mineflayer's controlState.sprint stays true (bot.attack only
// writes use_entity), so setControlState short-circuits on equal state and sends NOTHING. The body
// sprints until the gunner's first swing then WALKS the rest with the flag reading true — symptom: bot
// stops keeping up mid-engagement. `armSprint` forces false-then-true: the redundant-looking `false` IS
// the fix. SYNCHRONOUS by contract — an await between sprint and attack packets breaks the ordering
// Java's knockback check depends on; both go down one TCP stream in call order.
// SECOND TRAP (now the DRIVER's stall jump): prismarine-physics adds a 0.2 b/tick horizontal impulse in
// the FACING direction when a jump starts under sprint; the gunner faces the mob, so a sprint-jump
// shoves the bot INTO it — driver.js taps jump only on a measured stall, never holds it.

const KNOCKBACK_SETTLE_MS = 400;   // long enough for a shove to play out before measuring it

// armSprint(bot) → true if the start_sprinting packet was written.
// Unguarded: setControlState asserts only on a bad control name or a non-boolean state — both literals
// written right here — so the guard that stood here could not fire on a dead body as its comment
// claimed, only on a defect, and it answered "sprint not armed" for one (Law 13).
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
// DISCRIMINATOR, one question: does it come to you? Walks/swims/flies/teleports into reach on its own ⇒
// BRAWLER (standing still is free; the bot's own ground is the only verified ground). Holds range,
// retreats, or won't move ⇒ KITER (waiting is waiting forever, under fire).
// WRONG TURN, retired: a middle layer of many named monster groups folded onto these two tactics —
// nothing ever used the intermediate grouping to decide anything, so it was pure indirection (Law 16's
// delete-the-middle-layer test). The named groups live on in monster_tactics.json (`group` per monster,
// full justification) as documentation only; the doc↔table agreement test that once enforced their
// alignment was retired, and the guarantee is owed as a load-time throw in `monster_tactics_registry`
// (DOES NOT CURRENTLY EXIST) — once written, a doc regroup that would flip a monster's arm throws at load
// instead of quietly changing a fight. A third counter reads the JSON; a fight reads this. Grouping rule
// still binds, applied once: two monsters share a list only if the SAME counter, unmodified, works on both.
// Hardcoded, not a file read: these are fixed strings; a file read buys a parse, snapshot, drift window
// and boot-order dependency for nothing.
// RENAMED FROM HOLD/RUSH, truth fix: those named the two counter ARMS, both deleted — the journal wrote
// `tactic: RUSH` about a tactic the fleet no longer has (Law 25 falsehood). Not one name moved lists in
// the rename — evidence "which arm fights this" and "does it come to me" were always one question.
const COMBAT_TACTICS = {
  BRAWLER: 'BRAWLER',   // comes to the bot on its own. The driver sprints into it and keeps the shove.
  KITER:   'KITER',     // will not come, or backs away. A shove undoes the approach that earned it.
};

// Authored tactic→[names] (the shape a human edits); consumed name→tactic below (the shape a fight looks up).
const MONSTER_TACTICS = {
  // Comes on its own — met where the bot already stands. Folded groups (reading order, reasoning kept):
  // BRAWLER walks in, trades softly · DETONATOR the creeper — NO LONGER SEPARATE: hold.js gives it the
  // zombie pass + a shield while it swells; that file's tombstone holds why every movement-based creeper
  // counter died · BRUISER out-trades (band problem, not range) · JUGGERNAUT closes AND out-reaches ·
  // SWARM_CALLER trivial and they come · SPLITTER closing = standing among the children · SWOOPER flier
  // ruling: let it swoop in, then knock it back · PHASER flies through walls · TELEPORTER closes
  // instantly · OBSERVER_LOCKED approaches exactly when unwatched · UNWINNABLE nothing beats these; not
  // walking toward them is the least bad answer
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

  // Will not come; every second waiting is spent under fire. ARCHER retreats to hold range, beaten by
  // closing the distance rather than waiting it out · CASTER spends the delay healing/summoning · TURRET
  // will not follow · DISPLACER hops away and shoots; the distance is the whole problem
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
  // Law 13 form catch at load, not at the mob: an armless tactic key would fall through
  // battle_stations' dispatch and read as a targeting bug rather than a missing counter.
  if (!COMBAT_TACTICS[tactic]) throw new Error(`[${TAG}] MONSTER_TACTICS names "${tactic}", which is not one of the two built arms`);
  for (const n of names) {
    if (_TACTIC_OF[n]) {
      // A name in both lists ⇒ both arms claim it and key order decides — throw instead.
      throw new Error(`[${TAG}] "${n}" is listed under both ${_TACTIC_OF[n]} and ${tactic} — one monster, one tactic`);
    }
    _TACTIC_OF[n] = tactic;
  }
}

// combatTactic(entityName) → 'BRAWLER' | 'KITER', or NULL for an unclaimed name — never a default. The
// world names the monster (modded, game-update, mislabelled passive) ⇒ absence is environmental (Law 13)
// and the POLICY is the caller's. Driver's null policy: BRAKE — withholding a shove costs one approach;
// shoving something that flees costs the engagement.
// ALSO THE ROSTER OF KNOWN HOSTILES: camera's combat_witness and tools/combat_recorder asking `!== null`
// is legitimate; a separate membership set would be Law 16's redundant route, free to disagree the day a
// name lands in only one.
function combatTactic(entityName) {
  if (!entityName) return null;
  return _TACTIC_OF[String(entityName).toLowerCase()] || null;
}

// The neutrals — SEPARATE from the tactic table on purpose: tactics answer "how do I fight this", these
// the earlier "is there a fight at all" (each is inert until the bot acts). Folding them in would force
// one answer where two are needed: an unprovoked iron golem and one already swinging want opposite behaviour.
const NEVER_INITIATE = new Set([
  'enderman',            // provoked by the crosshair alone — the scanner's own aim starts this one
  'zombified_piglin',    // one hit aggros every piglin in a radius larger than the scan
  'piglin',              // and gold armour prevents it outright, which is a counter with no combat in it
  'iron_golem',          // village property; killing one is also a social act the fleet has not modelled
  'wolf', 'polar_bear', 'bee',
]);

// shouldInitiate(entityName) → false only for names the bot should never swing at first.
// NOT wired into a fight path yet — declining to attack is a COUNTER (the Architect's layer). Exported
// so the counter that wants it does not invent a second list (Law 16).
function shouldInitiate(entityName) {
  if (!entityName) return true;
  return !NEVER_INITIATE.has(String(entityName).toLowerCase());
}

module.exports = {
  BOT_STRIKE_REACH, BOT_WIDTH,
  // ── STRIKE PRIMITIVES GONE — hold.js and rush.js deleted ─────────────────────────
  // `sprintKnockbackStrike`, `attack`, `jumpAttack`, `strikeAtFallingEdge`, `waitForCharge`,
  // `createApproachTracker`: only callers were hold.js and rush.js, both deleted — an unused swing route
  // beside the live one is Law 16's second pathway, and the header names `bot.attack` in a combat path
  // as the regression to watch. The ONE swing route is `swingNow`, called by `gunner.fire`.
  // COST (behaviour change, not tidy-up): the fleet no longer ORCHESTRATES a sprint-armed hit. It still
  // GETS one — driver arms sprint each approach tick; Java reads `isSprinting()` at attack resolve — but
  // the shove is now a property of the body's approach position, not asked for by the swing. Whether
  // that is enough shove is for a run to say.
  armSprint,
  releaseSprint,

  // The two tactics (§8 — also the roster of known hostiles). With one tactic there is no dispatch left
  // to key on; `combatTactic` survives as the SPECIES LABEL the journal writes.
  COMBAT_TACTICS,
  MONSTER_TACTICS,
  combatTactic,
  NEVER_INITIATE,
  shouldInitiate,

  // Weapon selection (the axe-first ruling)
  pickBestWeapon,
  heldWeaponName,
  equipBestWeapon,

  // The swing clock — one clock, and `swingNow` is the one thing that stamps it
  swingClock,
  chargeNow,
  msSinceLastSwing,
  noteEquip,
  swingNow,
  // Exported so a journal row records the SAME sample the reach gate judged, never its own later one.
  swingDistance,

  // Exported because a caller opting out of the in-primitive shove reading must take it after the same
  // interval, or it is measuring a different quantity under the same name.
  KNOCKBACK_SETTLE_MS,

  // Test seam
  _resetSwingClock,
};
