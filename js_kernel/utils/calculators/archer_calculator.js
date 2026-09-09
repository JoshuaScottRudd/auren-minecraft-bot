// calculator: archer_calculator — when a skeleton is drawing, and where to be when it lets go.
//
// Draw state is read from raw entity metadata rather than a documented property, because mineflayer
// exposes no `isCharging` field. 1.21.5's registry names index 8 `living_entity_flags` for a skeleton;
// bit 0x01 is "hand active", which for a skeleton with a bow means drawing (Law 23 — verified against a
// decode of real metadata samples, not taken from documentation as given).
//
// MEASURED DRAW CYCLE: draw-held duration clusters tightly around 1.0s across recorded skeleton fights;
// release-to-next-draw is also ~1.0s, for a ~2.0s full cycle. Outlier long holds correlate with broken
// sightline (the skeleton only advances its draw while it can see its target), so a long hold is not a
// wider exploit window — it is an arrow that fires the instant sightline is regained.
const BOW_DRAW_MS = 1000;
// Vanilla arrow velocity is 1.6 b/tick (32 b/s) with ~1%/tick drag decay; 30 b/s is a conservative
// average over a short flight, chosen so under-estimating speed makes the bot weave too long rather than
// end the evade while the arrow is still in flight.
const ARROW_SPEED_BPS = 30;

// THE EVADE IS DELETED — kept here as the arithmetic that says do not rebuild it, since the constants
// above still derive from it.
//
// A 45°-off sidestep gives ~3.97 b/s of lateral speed at sprint. Clearing LATERAL_MISS_BLOCKS before the
// arrow arrives needs gap ≥ ARROW_SPEED_BPS × LATERAL_MISS_BLOCKS / lateral ≈ 30 × 0.6 / 3.97 ≈ 4.5b — so
// the dodge is physically impossible inside ~5 blocks, and the large majority of measured arrows in
// archer engagements are released from inside that range (the rush closes distance faster than the draw
// cycle allows a shot from farther out). Measured directly across a full engagement: zero arrows reached
// the lateral travel a miss requires — 0% observed success rate.
//
// It also cost something real: diverting the heading to evade pointed the SHIELD away from the archer,
// and a shield only blocks what it faces (Invariant A — two occupants of "which way the body faces").
// Not getting shot is the shield's job now (Law 16).

// arrowFlightMs(gap) — how long the arrow the skeleton just loosed is still in the air. Survives the
// evade's deletion because shouldGuard needs it for a different question: not "how long must the body
// keep moving" but "how long must the shield stay up after the bit clears". Clamped so a point-blank
// release cannot end the guard inside one poll, and a lost sightline at long range cannot pin it.
function arrowFlightMs(gap) {
  const ms = (gap / ARROW_SPEED_BPS) * 1000;
  return Math.max(150, Math.min(800, Math.round(ms)));
}

// bowDrawState(bot, entity) → 'drawing' | 'idle' | 'quiet' | 'unreadable'
//
// NOT A BOOLEAN, on purpose: an unreadable metadata array is not the same fact as "not drawing" — a
// sensing failure would otherwise behave exactly like a calm skeleton, hiding itself from anyone
// counting how often the read fails (Law 25 — the signal states what was actually established).
//
// 'quiet' is distinct from 'unreadable': 1.21.5 sends synched entity data only for fields that differ
// from their default, so a mob that has never used an item carries no `living_entity_flags` entry at
// all. That is not a failed read — the index resolved and the server is reporting, by omission, that
// this mob has never raised a hand. Collapsing 'quiet' into 'unreadable' produces false-positive warnings
// on every healthy fight against a mob that simply hasn't drawn yet, training the reader to ignore the
// one warning that would catch a real version bump.
//
// Both 'unreadable' and 'quiet' read as NOT DRAWING to a caller that decides — only 'drawing' is positive
// evidence, and callers raise on positive evidence alone.
//
// The metadata INDEX is resolved from the live registry rather than hardcoded, because it is a
// per-version fact mineflayer already carries; hardcoding it would go silently wrong on a protocol bump,
// in the direction that reads as "the skeleton never draws".
function bowDrawState(bot, entity) {
  if (!bot || !entity || !entity.name) return 'unreadable';
  const md = entity.metadata;
  if (!Array.isArray(md)) return 'unreadable';
  const keys = bot.registry && bot.registry.entitiesByName && bot.registry.entitiesByName[entity.name]
    ? bot.registry.entitiesByName[entity.name].metadataKeys : null;
  if (!Array.isArray(keys)) return 'unreadable';
  const idx = keys.indexOf('living_entity_flags');
  if (idx < 0) return 'unreadable';
  const v = md[idx];
  if (typeof v !== 'number') return 'quiet';
  return (v & 0x01) ? 'drawing' : 'idle';
}

// livingHealth(bot, entity) → the mob's health as the SERVER reports it, or null.
//
// Same decode as bowDrawState, for the same reason: `entity.health` is populated by mineflayer only for
// the bot's own body, so reading it off a hostile returns undefined — and defaulting that to a number
// would silently report every swing as dealing zero.
//
// This is the truth-catch under the crit claim: jumpAttack's `crit` flag is computed from the attacker's
// own onGround/sprinting state — a claim about the bot, not a measurement of damage dealt. Observed hits
// have read CRIT while the server-reported health delta matched a non-crit strike exactly, showing the
// flag can diverge from what actually happened. A health delta asks the world instead of asking
// ourselves (Law 23); null means UNREAD, never zero.
function livingHealth(bot, entity) {
  if (!bot || !entity || !entity.name || !Array.isArray(entity.metadata)) return null;
  const keys = bot.registry && bot.registry.entitiesByName && bot.registry.entitiesByName[entity.name]
    ? bot.registry.entitiesByName[entity.name].metadataKeys : null;
  if (!Array.isArray(keys)) return null;
  const idx = keys.indexOf('health');
  if (idx < 0) return null;
  const v = entity.metadata[idx];
  return typeof v === 'number' ? v : null;
}

// shouldGuard/GUARD_WHILE_ENGAGED are deleted: a rank-level "engaged with an archer ⇒ shield up" toggle
// cannot express a timed guard (block closer to the swing so the bot can land another attack first), so
// this is a replacement rather than a tuning. The decision now lives in `gunner.shieldOrder`, the seat
// that actually raises the shield — arithmetic a single seat acts on does not need a module the seat then
// keeps in sync (Law 16). What stayed here is what is genuinely about archers and is read by that seat:
// `bowDrawState`, `BOW_DRAW_MS`, `arrowFlightMs`.

module.exports = {
  BOW_DRAW_MS,
  ARROW_SPEED_BPS,
  arrowFlightMs,
  bowDrawState,
  livingHealth,
};
