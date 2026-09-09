// js_kernel/monster_tactics_registry.js
// The ONE route to monster_tactics.json (Law 16). Built on the declared-data-file pattern —
// @kernel/snapshot_registry — after building_blueprints and crafting_blueprints. This file owns only
// the tactic-document shape and its accessors.
//
// ⚠ NOT A RUNTIME PATHWAY. The document is a DESIGN-TIME REFERENCE — the reasoning a human reads while
// writing a counter — and this registry exists to load, validate and query it from TESTS AND TOOLS ONLY.
// Nothing on a fight path may require it: a disk read, parse and snapshot are cost a fight cannot pay
// mid-swing, when the runtime table below already answers the same question for free.
//
// The runtime authority is `MONSTER_TACTICS` in @utils/combat_utils: a hardcoded object, no disk, no
// parse, no snapshot, no drift window. It answers the only question a fight asks — which of the two arms
// does this monster take — in a property lookup.
//
// THIS DOCUMENT IS THE ONLY HOME OF THE FIFTEEN GROUPS. The runtime code carries only the two tactics
// those fifteen groups fold into. The reasoning behind each assignment — why a splitter is not a swarm
// caller, why a caster is not an archer — survives HERE and nowhere else. That raises this file's value
// rather than lowering it: it is the page a successor reads before proposing a third counter.
//
// WHY TWO PLACES HOLD A CLASSIFICATION AND WHY THAT IS NOT A REDUNDANT ROUTE (Law 16). It would be, left
// alone: two tables over the same 42 monsters drift, and the drift is silent because a stale JSON group
// never reaches a fight to be disproved. The joint that guarded this was a test restating a validator
// this file already carries, over a document nothing on a fight path reads; it was retired
// (`tools/README.md`). **The joint is currently MISSING.** It is owed as a load-time throw here:
// the same 42 names in both directions, and every doc group resolving to the one tactic the code gives
// all its members (the fifteen-to-two map). Until that throw exists the drift is unguarded, which is the
// whole reason this paragraph is here. So there is one authority (the code) and one record (the JSON)
// with a failing test between them, rather than two authorities. Delete that assertion and this file
// becomes the second route it is written not to be.
//
// WHAT THE DOCUMENT IS. It answers ONE question — what does this monster DO — and deliberately does not
// answer "what should the bot do about it". Counters are the next layer, one per group. A `counter` field
// appearing in the JSON would be this file quietly becoming the interpreter.
//
// WHY IT IS A DECLARED DATA FILE AND NOT A JS MODULE. It is authored knowledge, not logic: it will be
// corrected repeatedly as the arena disproves individual numbers, and every one of those corrections
// should be an edit an operator can make and a validation failure they can see. The cost of that shape
// — a disk read and a parse — is now paid only by the test run, which is where it belongs.
//
// THE SHARPEST THING IN THE DOCUMENT, stated here because a successor will meet it before reading the
// JSON: monsters are gated on the bot's OWN behaviour more often than on position. Looking at an
// enderman starts a fight; looking at a creaking stops one. Attacking one silverfish summons every
// silverfish; attacking one zombified piglin summons a group larger than the scan radius. Opening a
// chest near piglins starts a war that gold armour would have prevented outright. An interpreter that
// only reads distance and health will get all of these wrong, and none of them will look like a
// targeting bug — they will look like the fight was simply lost.

'use strict';

const { createSnapshotRegistry } = require('@kernel/snapshot_registry');

const MONSTER_TACTICS_PATH = require.resolve('@kernel/monster_tactics.json');

// Required on every entry. Anything absent is a Law 13 coding violation rather than a default: a
// missing `group` silently becoming BRAWLER is exactly the confident wrong answer the form catch
// exists to prevent — and BRAWLER is the arm that says "stand still and trade hits", which is the
// worst possible default for the monster whose entry someone forgot to finish.
const REQUIRED_FIELDS = ['display', 'dimension', 'hostility', 'group', 'health', 'aggro', 'approach', 'attack', 'threat'];

const registry = createSnapshotRegistry({
  filePath: MONSTER_TACTICS_PATH,
  fileName: 'monster_tactics.json',
  tag: 'monster_tactics_registry',
  validate: (parsed) => {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'is not an object';
    if (!parsed._meta) return 'has no _meta block (the confidence and vocabulary contract)';
    const m = parsed.monsters;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return 'has no `monsters` object map';
    if (Object.keys(m).length === 0) return 'contains no monsters';

    const vocab = (parsed._meta.VOCABULARY) || {};
    for (const [name, entry] of Object.entries(m)) {
      if (typeof entry !== 'object' || entry === null) return `entry "${name}" is not an object`;
      for (const f of REQUIRED_FIELDS) {
        if (entry[f] === undefined) return `entry "${name}" is missing required field "${f}"`;
      }
      // Enum conformance, checked rather than trusted. The vocabulary exists so the counter layer can
      // switch on these values; a typo'd group would fall through every branch and the monster would be
      // handled by whatever the default arm happens to be.
      if (vocab.group && !vocab.group.includes(entry.group)) {
        return `entry "${name}" has group "${entry.group}", which is not in _meta.VOCABULARY.group`;
      }
      if (vocab['approach.style'] && entry.approach && !vocab['approach.style'].includes(entry.approach.style)) {
        return `entry "${name}" has approach.style "${entry.approach.style}", which is not in _meta.VOCABULARY`;
      }
      if (vocab['attack.kind'] && entry.attack && !vocab['attack.kind'].includes(entry.attack.kind)) {
        return `entry "${name}" has attack.kind "${entry.attack.kind}", which is not in _meta.VOCABULARY`;
      }
      if (vocab['threat.tier'] && entry.threat && !vocab['threat.tier'].includes(entry.threat.tier)) {
        return `entry "${name}" has threat.tier "${entry.threat.tier}", which is not in _meta.VOCABULARY`;
      }
      if (entry.aggro && !Array.isArray(entry.aggro.triggers)) {
        return `entry "${name}" has a non-array aggro.triggers`;
      }
      if (vocab['aggro.triggers'] && entry.aggro && Array.isArray(entry.aggro.triggers)) {
        for (const t of entry.aggro.triggers) {
          if (!vocab['aggro.triggers'].includes(t)) {
            return `entry "${name}" has aggro trigger "${t}", which is not in _meta.VOCABULARY`;
          }
        }
      }
    }
    return null;
  },
});

// ── Accessors — the only way in ───────────────────────────────────────────────────────────────────

// The whole monster map. Callers that iterate it (a report, a test, a future interpreter's dispatch
// table) use this.
function getAllTactics() {
  return registry.data().monsters;
}

// getTactics(entityName) → the entry, or null.
//
// NULL, NOT A THROW, and this is the one place this file deliberately breaks from
// crafting_blueprint_registry's "absent = coding violation". A recipe the code asks for and cannot find
// is a bug: the caller named it. A MONSTER the code asks about is named by the WORLD — a modded mob, a
// mob added in a game update, or a passive the scanner mislabelled. Killing a live bot because the
// world contained something this document has not been taught is a Law 13 misclassification: it is
// environmental, not a coding violation. The caller degrades to whatever it did before this file
// existed.
function getTactics(entityName) {
  if (!entityName) return null;
  return registry.data().monsters[String(entityName).toLowerCase()] || null;
}

// known(entityName) → boolean. Separate from getTactics so a caller can log "no tactic entry for X"
// once and take its fallback, rather than null-testing an object it also wants to use.
function known(entityName) {
  return getTactics(entityName) !== null;
}

// The confidence and vocabulary block. Exposed because anything REPORTING from this document must be
// able to say how much of it is measured (none of it, at time of writing) — Law 23/25: this document
// is a body of claims, and a consumer that presents it as sensed fact is laundering it into one.
function getMeta() {
  return registry.data()._meta;
}

// byGroup(group) → [name, ...]. Used by the test to compare this document's grouping against the
// runtime table in combat_utils, and by anything reporting on the document. NOT for dispatch — a fight
// asks combat_utils.combatTactic(), which needs no file.
function byGroup(group) {
  const out = [];
  for (const [name, entry] of Object.entries(registry.data().monsters)) {
    if (entry.group === group) out.push(name);
  }
  return out;
}

// aggroTriggeredBy(trigger) → [name, ...]. The lookup for the class of failure this document exists to
// surface: "which monsters does THIS ACTION provoke". Looking, attacking, opening a chest and making
// noise each have a non-obvious answer, and the bot performs all four as ordinary work.
function aggroTriggeredBy(trigger) {
  const out = [];
  for (const [name, entry] of Object.entries(registry.data().monsters)) {
    const t = entry.aggro && entry.aggro.triggers;
    if (Array.isArray(t) && t.includes(trigger)) out.push(name);
  }
  return out;
}

module.exports = {
  getAllTactics,
  getTactics,
  known,
  getMeta,
  byGroup,
  aggroTriggeredBy,
  bootHash: registry.bootHash,
  MONSTER_TACTICS_PATH,
};
