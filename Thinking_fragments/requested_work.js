'use strict';
// requested_work — the structure, stock and upkeep requirements selected for this crew.
//
// A homesteader's needs are STATIC: its base is written in config, so its assessors walk the same tables
// every pass and decide for themselves that a headframe is missing. A contractor's needs are DYNAMIC:
// nothing is due until a person asks for it. Past that trigger the two are identical — the same
// requirement rows, the same assessors, the same jobs, the same executors, the same blueprint pasted the
// same way.
//
// A body's OWN KIT is neither static nor withheld: a pickaxe in a bot's own pocket is not work done on
// somebody's land, so every body carries the same kit requirement, unasked, both species (see
// activeStockRows). A withheld category is withheld by generating no requirement for it (Law 27) — a
// contractor is never offered unasked work because no assessor produces it for one.
//
// THE ROWS ARE THE CONFIG'S OWN ROWS, SELECTED — never restated in a second table, which would drift from
// the first at the next edit to either (Law 16).
const { BUILDING_REQUIREMENTS, STOCK_THRESHOLDS, REQUIREMENT_CATEGORIES } = require('@thinking/architect_config');

function _mandate() { return require('@kernel/bot_mandate'); }
function _ledger() { return require('@kernel/request_ledger'); }

// ── A REQUEST NAMES ONE OF TWO NAMESPACES, MEASURED BY DIFFERENT ORGANS ─────────────────────────────
// `20 oak_log` is a good, counted in chests by the supply assessor. `1 headframe` is a STRUCTURE and is
// satisfied by the building ladder — nothing can ever put one in a chest. The catalogue admits both
// because a person should not have to know which is which (Law 26: the small interface), so the split
// happens here, once, where the rows are generated.
function _isStructure(item) { return require('@kernel/requestable_catalogue').isBlueprint(item); }

// activeBuildingRequirements() → the requirement rows this body should walk.
//
// A homesteader gets the table whole: its requirements are the estate's standing programme, and nobody
// waits on them in an order. A contractor gets only the rows whose `field` a person has actually asked
// for — an empty list when nothing was asked, the identical site/paste/build rows a homesteader walks
// once a headframe is asked for.
//
// Rows are matched by `field`, the name a structure carries in every other table (the blueprint key, the
// conference-room chair, the execute key), so a request naming a structure needs no translation to reach
// them.
//
// ── ONE BUILDING AT A TIME, FULLY, IN THE ORDER ASKED ───────────────────────────────────────────────
// A person may have several structures outstanding; the crew works ONE. Handing back only the oldest
// unfinished one makes the queue a queue by construction (Law 27: settle it where the fact is produced).
//
// ORDERED BY `first_asked_at`. The ledger keeps the original timestamp when a request is restated, so
// repeating a want does not push it to the back of the queue.
//
// A HOMESTEADER AND A BUILDER each walk the ladders of their own structures (architect_config.STRUCTURE_PRIORITY):
// the headframe for one; the laydown yard and then the waste pit for the other. The table holds every ladder,
// in the order they are walked; the species picks its own.
function activeBuildingRequirements() {
  if (!_mandate().isContractor()) {
    const own = new Set(require('@thinking/architect_config').STRUCTURE_PRIORITY[_mandate().currentMode()]);
    return BUILDING_REQUIREMENTS.filter(req => own.has(req.field));
  }
  // A FIELD IS A LADDER, NOT A ROW. Each structure carries several requirement rungs — site, paste,
  // build — and narrowing to one building means narrowing to one FIELD while keeping every rung of it,
  // in the table's own order. Keying a map by field would silently keep only the last rung and hand the
  // crew a build step with no site step above it.
  const fields = new Set(BUILDING_REQUIREMENTS.map(req => req.field));
  const queued = _ledger().outstanding()
    .filter(row => fields.has(row.item))
    .sort((a, b) => (a.first_asked_at || 0) - (b.first_asked_at || 0));
  // The stage is the crew's OWN record of the structure, so "done" is asked of the world's state rather
  // than of the ledger — a row stays outstanding until the person withdraws it, and finishing the
  // building is what releases the next one, not tidying up the request (Invariant B).
  const next = queued.find(row => _structureStage(row.item) !== 'built');
  return next ? BUILDING_REQUIREMENTS.filter(req => req.field === next.item) : [];
}

// activeStockRows() → the stock rows this body measures against.
//
// A homesteader gets the table whole. A contractor gets ONLY rows built from its own requests, in the
// shape the supply assessor already understands: hold `quantity` in shared storage, actively.
//
// `deficit_below` AND `dump_threshold` are both the requested figure, so the request is the level from
// both directions: a threshold above it would keep gathering past what was asked for; one below it would
// dump material the request still needs.
//
// A CONFIG ROW FOR THE SAME ITEM IS NOT INHERITED. A contractor asked for logs is not also subject to the
// estate's standing log reserve — that reserve is the homestead's own housekeeping, and a crew working
// for a person has no share in it (Invariant D: one owner per requirement).
//
// ── THE SPLIT IS BY HOLDER, NOT BY SPECIES ───────────────────────────────────────────────────────────
// `holder:'storage'` rows are the ESTATE'S PROGRAMME — reserves a homestead keeps for itself, which a
// crew working on somebody's land has no business starting unasked. `holder:'bot'` rows are THIS BODY'S
// OWN KIT: a pickaxe, an axe, a crafting table, the planks and cobblestone it works out of. They are
// measured on its own pocket, held by nobody else, shared with nobody — not work done ON somebody's land,
// but what makes a body able to do any work at all.
//
// CONSTITUTION, NOT REGULATION (Law 27). The kit requirement simply EXISTS for every body, so there is no
// rule granting or checking permission to tool itself. The unasked-work guarantee stays structural: a
// contractor still generates no STORAGE row and no building row it was not asked for.
//
// ONE TABLE, SELECTED — never restated (Law 16). The kit rows handed back are the config's OWN row
// objects, identity-equal to the homesteader's, so the two species cannot drift apart at the next edit.
//
// Requirement categories stamp their crews onto each stock row; the same selection serves every consumer.
function forThisCrew(rows) {
  const mode = _mandate().currentMode();
  return rows.filter(row => !row.crews || row.crews.includes(mode));
}
// Upkeep is generated only for the crews that own its requirement category.
function activeWorkRequirements() {
  const mode = _mandate().currentMode();
  return Object.values(REQUIREMENT_CATEGORIES)
    .filter(category => category.crews.includes(mode))
    .flatMap(category => category.work);
}
function activeStockRows() {
  if (!_mandate().isContractor()) return forThisCrew(STOCK_THRESHOLDS);
  // The body's own kit: identical for both species, isolated per bot, shared with nobody.
  const ownKit = forThisCrew(STOCK_THRESHOLDS).filter(row => row.holder === 'bot');
  const requested = _ledger().outstanding()
    .filter(row => !_isStructure(row.item))
    .map(row => ({
      item: row.item,
      holder: 'storage',
      deficit_below: row.quantity,
      dump_threshold: row.quantity,
      mode: 'active',
    }));
  return [...ownKit, ...requested];
}

// requestProgress() → [{ item, asked, kind, have?, stage?, met }] — HOW FAR EACH REQUEST IS, measured
// now, by the crew, in the crew's own terms.
//
// ── WHY THIS CANNOT BE ANSWERED AT THE DESK ─────────────────────────────────────────────────────────
// The foreman has no mandate and no eyes: it can form no owner key, so it cannot see which chests belong
// to the crew it is speaking for. A figure invented at that distance is a confident lie about work in
// progress (Law 25). The measurement belongs to the party that owns the key, and that is a body.
//
// ── THE MEASURE MUST BE THE ONE THAT CLOSES THE REQUEST ─────────────────────────────────────────────
// `forChestRequest` is the exact figure the supply assessor stands down on, claims already subtracted. A
// raw chest count is strictly larger and would report MET while the crew is still gathering — a false
// success flag (Law 25). This reads the lens (Law 16: one owner per fact).
//
// ── A STRUCTURE IS A STAGE, NEVER A COUNT ───────────────────────────────────────────────────────────
// The building ladder writes its own progress down as it climbs — a buildspot chair, then a paster
// chair, then an integrity chair carrying `all_complete`. Those records already exist and are already
// what the building assessor reads to decide the same question, so the stage is READ, never re-derived
// or re-scanned (Invariant D).
function _structureStage(field) {
  const hq = require('@kernel/corporate_headquarters');
  const integrity = hq.readBuildingChair(field, 'building_integrity');
  if (integrity && integrity.all_complete === true) return 'built';
  const pasted = hq.readBuildingChair(field, 'blueprint_paster');
  if (pasted && typeof pasted === 'object') return 'pasted';
  const sited = hq.readBuildingChair(field, 'set_buildspot');
  if (sited && typeof sited.transpose_origin === 'object' && sited.transpose_origin !== null) return 'sited';
  return 'not started';
}

function requestProgress() {
  const rows = _ledger().outstanding();
  if (rows.length === 0) return [];
  const inventoryLens = require('@kernel/inventory_lens');
  return rows.map(row => {
    if (_isStructure(row.item)) {
      const stage = _structureStage(row.item);
      return { item: row.item, asked: row.quantity, kind: 'structure', stage, met: stage === 'built' };
    }
    const have = inventoryLens.forChestRequest(row.item);
    return { item: row.item, asked: row.quantity, kind: 'goods', have, met: have >= row.quantity };
  });
}

module.exports = { activeBuildingRequirements, activeStockRows, activeWorkRequirements, requestProgress };
