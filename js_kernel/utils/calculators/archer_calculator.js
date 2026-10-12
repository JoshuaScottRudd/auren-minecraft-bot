// calculator: archer_calculator — when a skeleton is drawing, and where to be when it lets go.
//
// Draw state is read from raw entity metadata since mineflayer exposes no `isCharging` field. Registry
// index 8 (`living_entity_flags`) carries the flag for a skeleton; bit 0x01 is "hand active", which for a
// skeleton with a bow means drawing (Law 23).
const BOW_DRAW_MS = 1000;
// Arrow speed used by arrowFlightMs to estimate remaining time-in-flight, in blocks per second.
const ARROW_SPEED_BPS = 30;

// arrowFlightMs(gap) — how long the arrow the skeleton just loosed is still in the air, for the seat that
// holds a shield up until the arrow clears. Clamped so a point-blank release cannot end the guard inside
// one poll, and a lost sightline at long range cannot pin it open.
function arrowFlightMs(gap) {
  const ms = (gap / ARROW_SPEED_BPS) * 1000;
  return Math.max(150, Math.min(800, Math.round(ms)));
}

// bowDrawState(bot, entity) → 'drawing' | 'idle' | 'quiet' | 'unreadable'.
//
// Not a boolean: an unreadable read and a calm skeleton are different facts, and only 'drawing' counts as
// positive evidence for a caller to act on (Law 25). 'quiet' means the field is absent because the mob has
// never raised a hand — a successful read reporting nothing — distinct from 'unreadable', where the index
// or the metadata array itself could not be resolved. Both read as not-drawing to callers.
//
// The metadata index is read from the live registry, since it is a per-version value.
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

// livingHealth(bot, entity) → the mob's health as the server reports it, or null when unread.
//
// `entity.health` is populated by mineflayer only for the bot's own body, so a hostile's health is read
// from metadata instead (same decode as bowDrawState); null means unread, never zero (Law 23).
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

// The shield-raise decision belongs to `gunner.shieldOrder`, the seat that reads bowDrawState,
// BOW_DRAW_MS, and arrowFlightMs to time it (Law 16).

module.exports = {
  BOW_DRAW_MS,
  ARROW_SPEED_BPS,
  arrowFlightMs,
  bowDrawState,
  livingHealth,
};
