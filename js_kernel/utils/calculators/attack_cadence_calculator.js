/*
attack_cadence_calculator.js — the swing clock: charge, damage multiplier, and the real minimum period
between two hits that both land.

Pure and stateless. Leaf of the combat calculators — the creeper and repel counters both time against
this, and neither may re-derive it.
*/

'use strict';

// This section exists because a swing fired the instant the last one landed does ~20% of the weapon's
// damage. Java scales every hit by an "attack charge" that refills over 1/attackSpeed seconds, and the
// damage curve is quadratic — so spamming bot.attack() is not "fast attacking", it is a damage cut of
// roughly 3-5x that no log line would ever show. This section is the arithmetic that avoids it.
//
// The numbers are the Java Edition item table, hardcoded rather than read from the server. That is
// deliberate: mineflayer's registry does not carry attack speed, and a wrong-by-default fallback would
// silently mistime every swing. A name absent from the table falls to FIST_PROFILE and is logged by
// the caller, never guessed at.

// damage = half-hearts dealt at FULL charge, on the ground, no enchantments.
// attackSpeed = full-charge refills per second, i.e. cooldown seconds = 1 / attackSpeed.
const WEAPON_PROFILES = {
  // Axes — highest per-hit damage of any melee class, and already carried as a tool. The sword ranks
  // primary and the axe its backup; the ranking that implements this is combat_utils §2 and reads the
  // two fields below rather than the category name.
  wooden_axe:      { damage: 7,   attackSpeed: 0.8, category: 'axe' },
  stone_axe:       { damage: 9,   attackSpeed: 0.8, category: 'axe' },
  iron_axe:        { damage: 9,   attackSpeed: 0.9, category: 'axe' },
  golden_axe:      { damage: 7,   attackSpeed: 1.0, category: 'axe' },
  diamond_axe:     { damage: 9,   attackSpeed: 1.0, category: 'axe' },
  netherite_axe:   { damage: 10,  attackSpeed: 1.0, category: 'axe' },

  wooden_sword:    { damage: 4,   attackSpeed: 1.6, category: 'sword' },
  stone_sword:     { damage: 5,   attackSpeed: 1.6, category: 'sword' },
  iron_sword:      { damage: 6,   attackSpeed: 1.6, category: 'sword' },
  golden_sword:    { damage: 4,   attackSpeed: 1.6, category: 'sword' },
  diamond_sword:   { damage: 7,   attackSpeed: 1.6, category: 'sword' },
  netherite_sword: { damage: 8,   attackSpeed: 1.6, category: 'sword' },

  wooden_pickaxe:  { damage: 2,   attackSpeed: 1.2, category: 'pickaxe' },
  stone_pickaxe:   { damage: 3,   attackSpeed: 1.2, category: 'pickaxe' },
  iron_pickaxe:    { damage: 4,   attackSpeed: 1.2, category: 'pickaxe' },
  golden_pickaxe:  { damage: 2,   attackSpeed: 1.2, category: 'pickaxe' },
  diamond_pickaxe: { damage: 5,   attackSpeed: 1.2, category: 'pickaxe' },
  netherite_pickaxe:{ damage: 6,  attackSpeed: 1.2, category: 'pickaxe' },

  wooden_shovel:   { damage: 2.5, attackSpeed: 1.0, category: 'shovel' },
  stone_shovel:    { damage: 3.5, attackSpeed: 1.0, category: 'shovel' },
  iron_shovel:     { damage: 4.5, attackSpeed: 1.0, category: 'shovel' },
  golden_shovel:   { damage: 2.5, attackSpeed: 1.0, category: 'shovel' },
  diamond_shovel:  { damage: 5.5, attackSpeed: 1.0, category: 'shovel' },
  netherite_shovel:{ damage: 6.5, attackSpeed: 1.0, category: 'shovel' },

  // Hoes deal 1 damage at any tier — they are in the table so the equip ladder can RANK them last
  // rather than treating an unknown name as a fist, not because anyone should fight with one.
  wooden_hoe:      { damage: 1,   attackSpeed: 1.0, category: 'hoe' },
  stone_hoe:       { damage: 1,   attackSpeed: 2.0, category: 'hoe' },
  iron_hoe:        { damage: 1,   attackSpeed: 3.0, category: 'hoe' },
  golden_hoe:      { damage: 1,   attackSpeed: 1.0, category: 'hoe' },
  diamond_hoe:     { damage: 1,   attackSpeed: 4.0, category: 'hoe' },
  netherite_hoe:   { damage: 1,   attackSpeed: 4.0, category: 'hoe' },
};

const FIST_PROFILE = { damage: 1, attackSpeed: 4.0, category: 'fist' };

// A hit only crits when the charge is above this. NOT a tuning knob — it is Java's own threshold, and
// it is why the jump-crit and the swing clock are one feature and not two: a perfectly timed jump onto
// the falling edge lands NO crit if the cooldown has not refilled, and nothing in-world says so.
const CRIT_MIN_CHARGE = 0.9;

// The floor of the damage curve: an instant re-swing still does this fraction, not zero.
const MIN_CHARGE_MULTIPLIER = 0.2;

// THE WRONG TURN, named because the arithmetic genuinely points at it (Law 14). Run the DPS on the
// charge curve alone — D·(0.2+0.8c²) damage every c·T seconds — and it MINIMISES at c=0.5 and rises
// without bound as c→0. On that math, spam-clicking beats any timed swing, and a successor who
// re-derives it will "fix" the swing clock back out of existence.
//
// What the charge curve leaves out is the receiving end: a damaged mob is invulnerable for 10 ticks,
// and during that window a new hit of equal-or-lower damage is absorbed ENTIRELY. So swings landing
// faster than every 500 ms are mostly free hits that deal literally nothing, and the honest comparison
// per real 500 ms slot is ~22% damage (spam) against 100% (timed) or 150% (timed + jump-crit).
// That is where the 3-5x actually comes from — not from the charge curve, which argues the other way.
//
// It is also a hard floor on the repeat timer: no weapon benefits from swinging faster than this, and
// fists (250 ms cooldown) would otherwise waste every second hit.
const MOB_INVULNERABILITY_MS = 500;

// weaponProfile(itemName) → { name, damage, attackSpeed, cooldownMs, category, known }.
// null/unknown → fists. `known:false` is what lets a caller warn about an unrecognised item instead
// of silently fighting at fist cadence with a real weapon in hand.
function weaponProfile(itemName) {
  const name = itemName || null;
  const base = (name && WEAPON_PROFILES[name]) || null;
  const p = base || FIST_PROFILE;
  return {
    name: base ? name : null,
    damage: p.damage,
    attackSpeed: p.attackSpeed,
    cooldownMs: Math.round(1000 / p.attackSpeed),
    category: p.category,
    known: !!base,
  };
}

// attackCharge(msSinceLastSwing, cooldownMs) → 0..1. Clamped at both ends: a negative elapsed (clock
// skew, or a swing recorded in the future by a caller bug) reads 0 rather than a nonsense charge.
function attackCharge(msSinceLastSwing, cooldownMs) {
  if (!(cooldownMs > 0)) return 1;
  const t = typeof msSinceLastSwing === 'number' && Number.isFinite(msSinceLastSwing) ? msSinceLastSwing : 0;
  if (t <= 0) return 0;
  return Math.min(1, t / cooldownMs);
}

// chargeDamageMultiplier(charge) → the fraction of full damage a hit at this charge deals.
// Java's curve: 0.2 + 0.8·charge². Quadratic, which is the whole reason the swing clock is worth
// building — at half charge a hit does 40%, not 50%.
function chargeDamageMultiplier(charge) {
  const c = Math.max(0, Math.min(1, typeof charge === 'number' && Number.isFinite(charge) ? charge : 0));
  return MIN_CHARGE_MULTIPLIER + (1 - MIN_CHARGE_MULTIPLIER) * c * c;
}

// swingPeriodMs(cooldownMs, minCharge) → the real minimum time between two hits that BOTH land.
//
// The LATER of the two gates: our own charge refill, and the target's invulnerability window. One
// function so the wait and the weapon ranking cannot disagree about what a weapon's cadence is — the
// ranking below divides by this exact number, and a second copy of the `Math.max` would be a redundant
// route (Law 16) whose two halves could drift apart silently.
//
// This floor is why "attack speed" alone cannot rank a weapon: an iron hoe swings at 3.0/s and every
// second hit of that would land inside the 10-tick window and deal literally nothing.
function swingPeriodMs(cooldownMs, minCharge) {
  const want = minCharge != null ? minCharge : 1;
  return Math.max(cooldownMs > 0 ? want * cooldownMs : 0, MOB_INVULNERABILITY_MS);
}

// sustainedDamagePerSecond(itemName) → damage per second a weapon actually delivers, cycling it as fast
// as the server allows a hit to count. Full-charge damage over swingPeriodMs — the weapon ladder's
// measure of each weapon's attack speed and cooldown, not just its raw damage stat.
//
// Why THIS metric and not per-hit damage: per-hit damage is what a one-hit-per-approach tactic cares
// about (the creeper fade), sustained DPS is what a stand-and-repeat tactic cares about (the BRAWLER
// repel), and one ladder serves both. Sustained is the honest single
// answer because it contains the other — a slow heavy weapon's per-hit advantage is already priced in
// by dividing it over its longer cycle, whereas ranking by per-hit damage alone discards the cooldown
// entirely and cannot see the sword at all.
function sustainedDamagePerSecond(itemName) {
  const p = weaponProfile(itemName);
  return p.damage / (swingPeriodMs(p.cooldownMs) / 1000);
}

// msUntilCharge(msSinceLastSwing, cooldownMs, minCharge) → how long to wait before swinging, 0 if ready.
// A caller that only honoured its own charge would swing a fist every 250 ms into a mob that cannot be
// hurt again for 500.
function msUntilCharge(msSinceLastSwing, cooldownMs, minCharge) {
  // Infinity is the swing clock's "has never swung", and it must mean READY, not "swung just now".
  // Number.isFinite(Infinity) is false, so an isFinite guard here silently collapsed the never-swung
  // case to t=0 and made the bot wait a full cooldown before the first blow of the process — a swing
  // that never arrives late enough to look like a bug, just a bot that seems to hesitate once. Only NaN
  // and non-numbers deserve the zero.
  const t = typeof msSinceLastSwing === 'number' && !Number.isNaN(msSinceLastSwing) ? msSinceLastSwing : 0;
  const need = swingPeriodMs(cooldownMs, minCharge);
  return t >= need ? 0 : Math.ceil(need - t);
}

// ── THE LEAD: BE READY AS IT ARRIVES, RATHER THAN GUESSING HOW EARLY TO START ───────────────────────
//
// The lead is not a tuning constant, it is arithmetic on two things the fight already knows: how long
// the clock still needs, and how fast the gap is shrinking. Distance = speed × time, so the distance at
// which the clock must ALREADY be running is the reach plus whatever ground the mob covers while the
// remaining cooldown burns off. A hardcoded lead distance is that same product with both terms guessed.
//
// PURE, AND THAT IS DELIBERATE (Law 26). No bot, no entity, no clock read — the model of the approach
// lives here where it can be asserted against hand-worked numbers, and the fight supplies the two
// measurements. A predicate that reads the world cannot be tested without one.
function chargeLeadDistance(reach, closingSpeed, msUntilReady) {
  const r = typeof reach === 'number' && Number.isFinite(reach) ? reach : 0;
  const wait = typeof msUntilReady === 'number' && Number.isFinite(msUntilReady) && msUntilReady > 0 ? msUntilReady : 0;
  // A mob that is not closing (standing, circling, or walking away) has no lead: there is no arrival to
  // be early for. Returning the reach rather than Infinity is what keeps a caller from reading "charge
  // now, from any distance" out of a mob that is never going to cross the gate.
  const v = typeof closingSpeed === 'number' && Number.isFinite(closingSpeed) && closingSpeed > 0 ? closingSpeed : 0;
  return r + v * (wait / 1000);
}

// swingReadiness — the whole approach question in one verdict, so a caller never assembles it twice.
//
// `slackMs` is the number the ready/not-ready decision turns on, and its SIGN is the finding:
//   > 0  the clock finishes with time to spare — the swing lands AT the reach, fully charged.
//   < 0  the mob arrives first. The swing does not refuse, it WAITS, and the mob keeps closing while it
//        does — so `landsAt` is where the blow actually falls.
//
// `landsAt` is floored at 0: a wait long enough to be overrun by the mob's own body is a fight that has
// already gone wrong, and a negative distance would read as a very good one.
function swingReadiness({ distance, reach, closingSpeed, msUntilReady }) {
  const d = typeof distance === 'number' && Number.isFinite(distance) ? distance : 0;
  const wait = typeof msUntilReady === 'number' && Number.isFinite(msUntilReady) && msUntilReady > 0 ? msUntilReady : 0;
  const v = typeof closingSpeed === 'number' && Number.isFinite(closingSpeed) && closingSpeed > 0 ? closingSpeed : 0;
  const lead = chargeLeadDistance(reach, v, wait);

  // Not closing → the mob never arrives on its own, so there is no deadline to be late for. Reported as
  // ready with a null arrival rather than as infinite slack: "no deadline" and "an enormous amount of
  // time" are different facts, and only one of them survives being added to.
  if (v === 0) return { lead, msToReach: null, slackMs: null, ready: wait === 0, landsAt: d };

  const msToReach = Math.max(0, (d - reach) / v) * 1000;
  const slackMs = msToReach - wait;
  return {
    lead, msToReach, slackMs,
    ready: slackMs >= 0,
    landsAt: slackMs >= 0 ? reach : Math.max(0, reach - v * (-slackMs / 1000)),
  };
}

module.exports = {
  weaponProfile,
  attackCharge,
  chargeDamageMultiplier,
  msUntilCharge,
  swingPeriodMs,
  sustainedDamagePerSecond,
  chargeLeadDistance,
  swingReadiness,
  WEAPON_PROFILES,
  FIST_PROFILE,
  CRIT_MIN_CHARGE,
  MOB_INVULNERABILITY_MS,
};
