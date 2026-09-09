'use strict';
// requested_work — WHICH REQUIREMENTS ARE LIVE FOR THIS BODY, and the whole difference between the two
// species in one place.
//
// ── THE SPECIES DIFFER IN THEIR TRIGGER, NOT IN THEIR ABILITIES ──────────────────────────────────
// A homesteader's needs are STATIC: the base it maintains is written in config, so its assessors walk
// the same tables every pass and decide for themselves that a headframe is missing. A contractor's
// needs are DYNAMIC: it exists because a person asked for something, so nothing is due until somebody
// asks. Past that trigger the two are identical — the same requirement rows, the same assessors, the
// same jobs, the same executors, the same blueprint pasted the same way.
//
// WITH ONE THING THAT WAS NEVER A TRIGGER AND IS NOT WITHHELD: a body's OWN KIT. The dynamic/static
// distinction is about work done on somebody's land, and a pickaxe in a bot's own pocket is not that.
// Every body carries the same kit requirement, unasked, both species — see activeStockRows.
//
// THIS IS WHY THE CONTRACTOR MAGNET COULD WIDEN. The categories were withheld because they name work a
// homesteader STARTS BY ITSELF, and a contractor claiming those jobs would be doing unasked-for work on
// somebody's land. Gating the claim was a regulation with an enforcer; generating the requirement is a
// constitution (Law 27) — a contractor is never offered unasked work because no assessor can produce it
// for one, so there is nothing left to refuse.
//
// ── WHY NOT A SECOND SET OF TABLES ───────────────────────────────────────────────────────────────
// A contractor-shaped copy of BUILDING_REQUIREMENTS and STOCK_THRESHOLDS would be Law 16's forbidden
// parallel route: two tables describing one kind of work, drifting apart at the first edit to either,
// with the divergence invisible until a contractor built something subtly unlike what a homesteader
// builds. The rows here are the config's OWN rows, selected — never restated.
const { BUILDING_REQUIREMENTS, STOCK_THRESHOLDS } = require('@thinking/architect_config');

function _mandate() { return require('@kernel/bot_mandate'); }
function _ledger() { return require('@kernel/request_ledger'); }

// ── A REQUEST NAMES ONE OF TWO NAMESPACES, AND THEY ARE MEASURED BY DIFFERENT ORGANS ─────────────
// `20 oak_log` is a good, counted in chests by the supply assessor. `1 headframe` is a STRUCTURE, and
// nothing can ever put one in a chest — it is satisfied by the building ladder instead. The catalogue
// admits both because a person should not have to know which is which (Law 26: the small interface),
// so the split has to happen here, once, where the rows are generated.
//
// THE FAILURE THIS CLOSES: an unsplit list sent every request to BOTH assessors. The building side
// ignored the goods harmlessly, but the supply side accepted `headframe` as a storage row and posted a
// gather order for an item no recipe and no block drop can produce — a job that can never succeed and
// never stops being re-posted, which is the shape that reaches the judge as a stall rather than an error.
function _isStructure(item) { return require('@kernel/requestable_catalogue').isBlueprint(item); }

// activeBuildingRequirements() → the requirement rows this body should walk.
//
// A homesteader gets the table whole. A contractor gets only the rows whose `field` a human has
// actually asked for — so a contractor with no requests walks an empty list and correctly finds nothing
// to build, and one asked for a headframe walks the identical three rows a homesteader walks: site it,
// paste it, build it, in that order.
//
// The rows are matched by `field` because that is the name a structure has in every other table too —
// the blueprint key, the conference-room chair, the execute key. A request naming a structure therefore
// needs no translation to reach them.
// ── ONE BUILDING AT A TIME, FULLY, IN THE ORDER THEY WERE ASKED FOR (Architect 2026-08-30) ───────────
// "it can queue multiple buildings but one at a time and fully before moving onto the next."
//
// A person may have several structures outstanding; the crew works ONE. Returning them all let the board
// post work for two at once, and a crew that splits between two half-built houses has two unusable
// buildings for as long as it takes to finish either — the same total work bought in the worst possible
// order. Handing back only the oldest unfinished one makes the queue a queue by construction rather than
// by a rule something has to enforce downstream (Law 27: settle it where the fact is produced).
//
// ORDERED BY `first_asked_at`, WHICH IS WHY THAT FIELD SURVIVES A RESTATEMENT. The ledger keeps the
// original timestamp when a request is restated, so saying a thing twice does not push it to the back of
// the queue — the want did not begin again because the person repeated it.
//
// A HOMESTEADER IS UNCHANGED and takes the table whole: its requirements are the estate's standing
// programme rather than a person's queue, and nobody is waiting on them in an order.
function activeBuildingRequirements() {
  if (!_mandate().isContractor()) return BUILDING_REQUIREMENTS;
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
// A homesteader gets the table whole. A contractor gets ONLY rows built from its own requests, and the
// shape of a generated row is the shape the supply assessor already understands: hold `quantity` in
// shared storage, actively.
//
// `deficit_below` AND `dump_threshold` are both the requested figure, which is what makes the request
// absolute rather than a floor to build on. A dump threshold above the target would have the crew keep
// gathering past what was asked for; one below it would have them dump material the request still
// needs. Asking for twenty means twenty is the level, from both directions.
//
// A CONFIG ROW FOR THE SAME ITEM IS NOT INHERITED. A contractor asked for logs is not also subject to
// the estate's standing log reserve — that reserve is the homestead's own housekeeping, and a crew
// working for a person has no share in it (Invariant D: one owner per requirement).
//
// ── THE SPLIT IS BY HOLDER, NOT BY SPECIES (Architect 2026-08-31) ────────────────────────────────
//
//   "the bots should work identical to homesteaders on the bot category… each bot is supposed to get its
//    own pickaxe through constitution instead of regulation. each bots gather their own toolkits in the
//    bot category. the bot category is the local category each bot does in isolation. no sharing."
//
// This function used to withhold the WHOLE table from a contractor, and that conflated two different
// things under one word. `holder:'storage'` rows are the ESTATE'S PROGRAMME — reserves a homestead keeps
// for itself, which a crew working on somebody's land has no business starting unasked. `holder:'bot'`
// rows are THIS BODY'S OWN KIT: a pickaxe, an axe, a crafting table, the planks and cobblestone it works
// out of. They are measured on its own pocket, held by nobody else, and shared with nobody. They are not
// work done ON somebody's land — they are what makes a body able to do any work at all.
//
// WHAT WITHHOLDING THEM COST, MEASURED: a contractor crew reached its house, found it needed 8 cobble,
// found cobble needs a pickaxe — and had no requirement anywhere that would ever produce one, because the
// `pickaxe` row it would have been generated from does not exist for its species. The tool job sat gated
// on *needing a pickaxe to get a pickaxe* and the crew stood there. A homesteader walks out of that on
// its first pass, from the same table, with the same assessors, because it can see the row.
//
// CONSTITUTION, NOT REGULATION (Law 27). Nothing here grants a contractor permission to tool itself and
// nothing checks whether it may: the requirement simply EXISTS for every body, so there is no rule to
// enforce and no case to get wrong. The unasked-work guarantee is untouched and still structural — a
// contractor still generates no STORAGE row and no building row it was not asked for, so there is still
// nothing unasked for it to claim.
//
// ONE TABLE, SELECTED — never restated (Law 16). The kit rows handed back are the config's OWN row
// objects, identity-equal to the homesteader's, so the two species cannot drift apart at the next edit.
function activeStockRows() {
  if (!_mandate().isContractor()) return STOCK_THRESHOLDS;
  // The body's own kit: identical for both species, isolated per bot, shared with nobody.
  const ownKit = STOCK_THRESHOLDS.filter(row => row.holder === 'bot');
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
// ── WHY THIS CANNOT BE ANSWERED AT THE DESK ──────────────────────────────────────────────────────
// The foreman has no mandate and no eyes: it can form no owner key, so it cannot even see which chests
// belong to the crew it is speaking for. A figure invented at that distance is a confident lie about
// work in progress (Law 25), which is why the status reply carried no progress at all until this
// existed. The measurement belongs to the party that owns the key, and that is a body.
//
// ── THE MEASURE MUST BE THE ONE THAT CLOSES THE REQUEST, NOT A RESEMBLING ONE ────────────────────
// `forChestRequest` is the exact figure the supply assessor stands down on, claims already subtracted.
// A raw chest count is the tempting substitute and it is strictly larger, so it reports MET while the
// crew is still gathering — a false success flag, and the precise failure Law 25 names. Two numbers for
// one question is also the parallel route Law 16 forbids; this reads the lens rather than counting again.
//
// ── A STRUCTURE IS A STAGE, NEVER A COUNT ────────────────────────────────────────────────────────
// The building ladder writes its own progress down as it climbs — a buildspot chair, then a paster
// chair, then an integrity chair carrying `all_complete`. Those records already exist and are already
// what the building assessor reads to decide the same question, so the stage is READ, never re-derived
// and never re-scanned: a second scan here would be a second opinion on a fact that already has an
// owner (Invariant D), paid for with a voxel sweep every pass.
function _structureStage(field) {
  const hq = require('@kernel/corporate_headquarters');
  const integrity = hq.readBuildingChair(field, 'building_integrity');
  if (integrity && integrity.all_complete === true) return 'built';
  const pasted = hq.readBuildingChair(field, 'blueprint_paster');
  if (pasted && typeof pasted === 'object') return 'pasted';
  const sited = hq.readBuildingChair(field, 'set_buildspot');
  if (sited && typeof sited.build_center === 'object' && sited.build_center !== null) return 'sited';
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

module.exports = { activeBuildingRequirements, activeStockRows, requestProgress };
