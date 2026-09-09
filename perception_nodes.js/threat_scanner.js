// fragment: threat_scanner (perception)
// purpose: The fleet's PREDICATES about a monster — is this entity hostile, and what is it called. Two
//          synchronous questions about ONE entity handed in, and nothing else.
// invariants:
//  - It answers about a mob it is GIVEN. It does not walk bot.entities and it holds no opinion about
//    which mob matters — that is the commander's, and the commander is the only seat allowed to sweep.
//  - Pure reads. No signals, no file I/O, no side effects, and no logging: its caller owns the voice.
//
// ── THE SWEEP LEFT THIS FILE ─────────────────────────────────────────────────────────────────────────
// All monster data now derives from one place, the commander — no second walk of the entity table
// anywhere else in the fleet.
//
// `scanThreats` used to live here: it walked the entity table, classified every hostile, tested aggro and
// picked the mob to open with. It was one of several such walks scattered across the tree, and the most
// expensive — a raycast per hostile in range, run at every gate and again on every blow taken, just to
// fill a prose line. `custom_api/commander` now makes that walk once per tick for the whole crew and posts
// to `crew_board`.
//
// WHAT DID NOT MOVE, AND WHY THAT IS THE POINT. The two predicates below are unchanged and still live in
// perception, because each is the fleet's ONE definition of what it answers — a second hostile list would
// drift the first time one is edited and the other is not (this file has already lost one duplicate
// classification for exactly that reason — see HOSTILE_NAMES below). The commander is their only caller
// today; that makes them single-route, not redundant. Inlining `isHostile` into the commander because
// nothing else calls it would be the wrong turn — the next caller is the one that would then re-derive it.
//
// WHY THERE IS NO CACHE HERE AND MUST NEVER BE ONE: these are pure functions of an entity handed in at the
// instant they are called. A memo keyed on entity id would be remembered state about a body that moves
// (Invariant B). The one fact that legitimately persists — that a raycast once confirmed a mob's aggro —
// is remembered by the commander, which is also the seat that prunes it when the mob leaves the table
// (Law 8). Holding it here would be state with no owner watching its lifecycle.

// Overworld surface hostiles the fleet actually meets. This set answers ONE question — is this thing a
// threat — and deliberately not "what kind of threat", which is combat_utils.MONSTER_TACTICS. This node
// used to carry a `kind: 'creeper'|'melee'` field alongside the name; it was a second classification of
// the same monsters into two buckets, and it was deleted when the group table landed (Law 16 — the name is
// what the classification keys on, so a coarser copy of it is a redundant route that can only ever
// disagree). The objection was never the bucket count, it was the second table — a two-bucket shape
// arrived at some other way would not be a reason to bring this one back.
//
// The kind/category fallback in isHostile catches anything not enumerated, so this set is a fast path, not
// the sole authority — a hostile that is not listed still gets scanned, and then reaches a counter dispatch
// that will report it as UNCLASSIFIED rather than guessing.
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
  const name = String(e.name || e.mobType || '').toLowerCase();
  return HOSTILE_NAMES.has(name);
}

function hostileName(e) {
  return String(e.name || e.mobType || 'unknown').toLowerCase();
}

module.exports = {
  isHostile,
  hostileName,
};
