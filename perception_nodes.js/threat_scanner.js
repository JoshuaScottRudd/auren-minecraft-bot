// fragment: threat_scanner (perception)
// The fleet's predicates about a monster — is this entity hostile, and what is it called. Two synchronous
// questions about one entity handed in, and nothing else.
// invariants:
//  - It answers about a mob it is given. It does not walk bot.entities and holds no opinion about which
//    mob matters — that is the commander's, and the commander is the only seat allowed to sweep.
//  - Pure reads. No signals, no file I/O, no side effects, and no logging: its caller owns the voice.
//
// All monster data derives from one place, the commander — no second walk of the entity table anywhere
// else in the fleet.
//
// The two predicates below live in perception because each is the fleet's one definition of what it
// answers — a second hostile list would drift the first time one is edited and the other is not. The
// commander is their only caller, which keeps them single-route.
//
// No cache here, and none belongs: these are pure functions of an entity handed in at the instant they are
// called. A memo keyed on entity id would be remembered state about a body that moves (Invariant B). The
// one fact that persists — that a raycast confirmed a mob's aggro — is remembered by the commander, which
// is also the seat that prunes it when the mob leaves the table (Law 8).

// Overworld surface hostiles the fleet meets. This set answers one question — is this thing a threat —
// which is distinct from what kind of threat, an answer combat_utils.MONSTER_TACTICS owns. The name is
// what the classification keys on (Law 16), so this is the fleet's one hostile list.
//
// The kind/category fallback in isHostile catches anything not enumerated, so this set is a fast path: a
// hostile not listed still gets scanned, and reaches a counter dispatch that reports it as UNCLASSIFIED.
const HOSTILE_NAMES = new Set([
  'creeper', 'zombie', 'zombie_villager', 'husk', 'drowned',
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'spider', 'cave_spider', 'witch', 'slime', 'silverfish',
  'enderman', 'pillager', 'vindicator', 'evoker', 'ravager', 'zoglin', 'phantom',
]);

// isHostile: category first (prismarine tags most hostiles 'Hostile mobs'/'hostile'), name set as the
// fast path. Players, dropped items, XP orbs, projectiles, and passive mobs all fall through to false.
function isHostile(e) {
  if (!e || !e.position) return false;
  const type = String(e.type || '').toLowerCase();
  if (type === 'player' || type === 'object' || type === 'orb' || type === 'projectile' || type === 'other') {
    // still allow name-set match below in case type is mislabeled, but drop obvious non-mobs
    if (type === 'orb' || type === 'projectile') return false;
  }
  const kind = String(e.kind || '').toLowerCase();
  if (kind.includes('hostile')) return true;
  const name = String(e.name || e.displayName || '').toLowerCase();
  return HOSTILE_NAMES.has(name);
}

// Animals that kill the fleet's livestock. Not hostile to the bot, so isHostile leaves them out; the commander
// admits one only where it threatens the herd (architect_config.PREDATOR_GUARD). A tamed one carries its owner on
// its metadata (`owneruuid`, indexed through the live registry) and belongs to a player, so it is never one.
const PREDATOR_NAMES = new Set(['wolf']);

function isPredator(e, bot) {
  if (!e || !e.position) return false;
  const name = String(e.name || '').toLowerCase();
  if (!PREDATOR_NAMES.has(name)) return false;
  const keys = bot && bot.registry && bot.registry.entitiesByName && bot.registry.entitiesByName[name]
    ? bot.registry.entitiesByName[name].metadataKeys : null;
  const idx = Array.isArray(keys) ? keys.indexOf('owneruuid') : -1;
  const owner = idx >= 0 && Array.isArray(e.metadata) ? e.metadata[idx] : null;
  return !owner;
}

function hostileName(e) {
  return String(e.name || e.displayName || 'unknown').toLowerCase();
}

module.exports = {
  isHostile,
  isPredator,
  hostileName,
};
