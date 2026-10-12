/*
attack_cadence_calculator.js — the swing clock: charge, damage multiplier, and the real minimum period
between two hits that both land.

Pure and stateless. Leaf of the combat calculators; the creeper and repel counters both time against it.
*/

'use strict';

// Java scales every hit by an "attack charge" that refills over 1/attackSpeed seconds on a quadratic
// curve, so a swing fired before the charge refills deals well under full damage. This section is the
// arithmetic that keeps a swing timed to the charge.
//
// The numbers are Java Edition's item table; mineflayer's registry does not carry attack speed. A name
// absent from the table falls to FIST_PROFILE and is logged by the caller.

// damage = half-hearts dealt at FULL charge, on the ground, no enchantments.
// attackSpeed = full-charge refills per second, i.e. cooldown seconds = 1 / attackSpeed.
const WEAPON_PROFILES = {
  // Axes carry the highest per-hit damage of any melee class and are already carried as a tool; the
  // sword ranks primary in combat_utils, which reads the damage and attackSpeed fields directly.
  wooden_axe:      { damage: 7,   attackSpeed: 0.8, category: 'axe' },
  stone_axe:       { damage: 9,   attackSpeed: 0.8, category: 'axe' },
  // Copper (1.21.9+): vanilla's stated values, not measured here.
  copper_axe:      { damage: 9,   attackSpeed: 0.8, category: 'axe' },
  iron_axe:        { damage: 9,   attackSpeed: 0.9, category: 'axe' },
  golden_axe:      { damage: 7,   attackSpeed: 1.0, category: 'axe' },
  diamond_axe:     { damage: 9,   attackSpeed: 1.0, category: 'axe' },
  netherite_axe:   { damage: 10,  attackSpeed: 1.0, category: 'axe' },

  wooden_sword:    { damage: 4,   attackSpeed: 1.6, category: 'sword' },
  stone_sword:     { damage: 5,   attackSpeed: 1.6, category: 'sword' },
  copper_sword:    { damage: 5,   attackSpeed: 1.6, category: 'sword' },
  iron_sword:      { damage: 6,   attackSpeed: 1.6, category: 'sword' },
  golden_sword:    { damage: 4,   attackSpeed: 1.6, category: 'sword' },
  diamond_sword:   { damage: 7,   attackSpeed: 1.6, category: 'sword' },
  netherite_sword: { damage: 8,   attackSpeed: 1.6, category: 'sword' },

  wooden_pickaxe:  { damage: 2,   attackSpeed: 1.2, category: 'pickaxe' },
  stone_pickaxe:   { damage: 3,   attackSpeed: 1.2, category: 'pickaxe' },
  copper_pickaxe:  { damage: 3,   attackSpeed: 1.2, category: 'pickaxe' },
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

  // Hoes deal 1 damage at any tier; kept in the table so the equip ladder ranks them as a known, weak
  // weapon.
  wooden_hoe:      { damage: 1,   attackSpeed: 1.0, category: 'hoe' },
  stone_hoe:       { damage: 1,   attackSpeed: 2.0, category: 'hoe' },
  iron_hoe:        { damage: 1,   attackSpeed: 3.0, category: 'hoe' },
  golden_hoe:      { damage: 1,   attackSpeed: 1.0, category: 'hoe' },
  diamond_hoe:     { damage: 1,   attackSpeed: 4.0, category: 'hoe' },
  netherite_hoe:   { damage: 1,   attackSpeed: 4.0, category: 'hoe' },
};

const FIST_PROFILE = { damage: 1, attackSpeed: 4.0, category: 'fist' };

// Charge threshold above which a hit crits — Java's own value, and the reason a perfectly timed jump
// lands no crit unless the swing charge has also refilled.
const CRIT_MIN_CHARGE = 0.9;

// The floor of the damage curve: an instant re-swing still does this fraction, not zero.
const MIN_CHARGE_MULTIPLIER = 0.2;

// A damaged mob is invulnerable for this window; a swing landing inside it deals nothing. Sets a floor
// under the repeat timer no weapon benefits from swinging faster than (Law 14).
const MOB_INVULNERABILITY_MS = 500;

// weaponProfile(itemName) → { name, damage, attackSpeed, cooldownMs, category, known }.
// null/unknown falls to fists; `known:false` lets a caller warn about an unrecognised item.
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

// attackCharge(msSinceLastSwing, cooldownMs) → 0..1, clamped at both ends; a negative elapsed reads 0.
function attackCharge(msSinceLastSwing, cooldownMs) {
  if (!(cooldownMs > 0)) return 1;
  const t = typeof msSinceLastSwing === 'number' && Number.isFinite(msSinceLastSwing) ? msSinceLastSwing : 0;
  if (t <= 0) return 0;
  return Math.min(1, t / cooldownMs);
}

// chargeDamageMultiplier(charge) → fraction of full damage a hit at this charge deals.
// Java's curve: 0.2 + 0.8·charge² — quadratic, so a half-charged hit does 40%, not 50%.
function chargeDamageMultiplier(charge) {
  const c = Math.max(0, Math.min(1, typeof charge === 'number' && Number.isFinite(charge) ? charge : 0));
  return MIN_CHARGE_MULTIPLIER + (1 - MIN_CHARGE_MULTIPLIER) * c * c;
}

// swingPeriodMs(cooldownMs, minCharge) → the real minimum time between two hits that both land: the
// later of the charge refill and the target's invulnerability window. The weapon ranking divides by
// this same number (Law 16), so cadence and ranking cannot disagree.
function swingPeriodMs(cooldownMs, minCharge) {
  const want = minCharge != null ? minCharge : 1;
  return Math.max(cooldownMs > 0 ? want * cooldownMs : 0, MOB_INVULNERABILITY_MS);
}

// sustainedDamagePerSecond(itemName) → damage per second a weapon delivers when swung as fast as the
// server allows a hit to count. Full-charge damage divided by swingPeriodMs — the weapon ladder's
// measure of a weapon's actual attack speed, not just its raw damage stat.
function sustainedDamagePerSecond(itemName) {
  const p = weaponProfile(itemName);
  return p.damage / (swingPeriodMs(p.cooldownMs) / 1000);
}

// msUntilCharge(msSinceLastSwing, cooldownMs, minCharge) → ms to wait before swinging, 0 if ready.
// Uses swingPeriodMs so a caller never swings faster than the mob's invulnerability window allows.
function msUntilCharge(msSinceLastSwing, cooldownMs, minCharge) {
  // Infinity means never swung and reads as ready; only NaN and non-numbers read as 0.
  const t = typeof msSinceLastSwing === 'number' && !Number.isNaN(msSinceLastSwing) ? msSinceLastSwing : 0;
  const need = swingPeriodMs(cooldownMs, minCharge);
  return t >= need ? 0 : Math.ceil(need - t);
}

// ── CHARGE LEAD ────────────────────────────────────────────────────────────────────────────────────
//
// chargeLeadDistance — arithmetic on two facts the fight already knows: how long the clock still needs,
// and how fast the gap is shrinking. Distance = speed × time, so this is the distance at which the
// clock must already be running: the reach plus whatever ground the mob covers while the cooldown
// finishes.
//
// Pure: takes no bot, entity, or clock read (Law 26), so the approach model can be tested against
// hand-worked numbers directly.
function chargeLeadDistance(reach, closingSpeed, msUntilReady) {
  const r = typeof reach === 'number' && Number.isFinite(reach) ? reach : 0;
  const wait = typeof msUntilReady === 'number' && Number.isFinite(msUntilReady) && msUntilReady > 0 ? msUntilReady : 0;
  // A mob that is not closing has no lead: the reach itself is returned, not an infinite lead.
  const v = typeof closingSpeed === 'number' && Number.isFinite(closingSpeed) && closingSpeed > 0 ? closingSpeed : 0;
  return r + v * (wait / 1000);
}

// swingReadiness — the whole approach question in one verdict, so a caller never assembles it twice.
//
// `slackMs`'s sign is the finding: positive means the clock finishes with time to spare (the swing
// lands at reach, fully charged); negative means the mob arrives first, and the swing waits while the
// mob keeps closing, so `landsAt` is where the blow actually falls.
//
// `landsAt` is floored at 0.
function swingReadiness({ distance, reach, closingSpeed, msUntilReady }) {
  const d = typeof distance === 'number' && Number.isFinite(distance) ? distance : 0;
  const wait = typeof msUntilReady === 'number' && Number.isFinite(msUntilReady) && msUntilReady > 0 ? msUntilReady : 0;
  const v = typeof closingSpeed === 'number' && Number.isFinite(closingSpeed) && closingSpeed > 0 ? closingSpeed : 0;
  const lead = chargeLeadDistance(reach, v, wait);

  // Not closing: reported as ready with a null arrival — no deadline, distinct from infinite slack.
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
