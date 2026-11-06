'use strict';
// requested_work — the structure requirements selected for this crew, and the one kit every crew stocks.
//
// THE ROWS ARE THE CONFIG'S OWN ROWS, SELECTED — never restated in a second table, which would drift from
// the first at the next edit to either (Law 16).
const { BUILDING_REQUIREMENTS, STOCK_THRESHOLDS } = require('@thinking/architect_config');

function _mandate() { return require('@kernel/bot_mandate'); }

// activeBuildingRequirements() → the requirement rows this body should walk.
//
// A HOMESTEADER AND A BUILDER each walk the ladders of their own structures (architect_config.STRUCTURE_PRIORITY):
// the headframe for one; the laydown yard and then the waste pit for the other. The table holds every ladder,
// in the order they are walked; the species picks its own.
function activeBuildingRequirements() {
  const own = new Set(require('@thinking/architect_config').STRUCTURE_PRIORITY[_mandate().currentMode()]);
  return BUILDING_REQUIREMENTS.filter(req => own.has(req.field));
}

// THE CHESTS ASK FOR THE CREW'S KIT MATERIAL, NOT THE BODY: a storage row naming `for_kit` holds what the kit items
// still owed to the crew are made of — every connected body short of one, the item's recipe in that material — so
// the furnaces and the mine are pulled for all of it at once, and each body's own row crafts its piece from
// the chests. A row whose kit is all made asks for nothing.
function kitStock(row) {
  if (!row.for_kit) return row;
  const crew = Object.keys(require('@kernel/corporate_headquarters').getFullBoardroom({}) || {}).length;
  const held = require('@kernel/inventory_lens').fleetHoldings();
  const { requirementTree } = require('@utils/calculators/build_material_calculator');
  let need = 0;
  for (const item of row.for_kit) {
    const botRow = STOCK_THRESHOLDS.find(r => r.holder === 'bot' && r.item === item);
    const owed = Math.max(0, (botRow && botRow.per_crew != null ? botRow.per_crew : crew) - (held[item] || 0));
    if (owed > 0) need += requirementTree(item, owed, {})[row.item] || 0;
  }
  return { ...row, deficit_below: need, dump_threshold: need };
}
// A CREW ROW IS ASKED BY A BODY ONLY WHILE THE CREW IS SHORT OF IT: a body holding none, with the crew already
// holding the row's per_crew (pockets and chests alike), measures it as met.
function crewStock(row) {
  if (row.per_crew == null || row.holder !== 'bot') return row;
  const bot = global.bot;
  const mine = bot && bot.inventory ? bot.inventory.items().some(i => i.name === row.item) : false;
  if (mine || (require('@kernel/inventory_lens').fleetHoldings()[row.item] || 0) < row.per_crew) return row;
  return { ...row, deficit_below: 0 };
}
// THE BOOK ROW ASKS FOR THE BOOKS THE STOOD-IN BLOCKS STILL OWE (architect_config.STAND_INS): every stood-in cell
// not yet holding its real block, in books, less the books the fleet already reaches in books, bookshelves and
// lecterns (downloaded_plan_registry.standInsAtSite). No plan loaded, or nothing owed: the row asks for nothing.
function standInStock(row) {
  if (!row.for_stand_ins) return row;
  const s = require('@kernel/downloaded_plan_registry').standInsAtSite();
  const need = s ? Math.max(0, s.owed - (s.reached - require('@kernel/inventory_lens').reachableByFleet(row.item))) : 0;
  return { ...row, deficit_below: need, dump_threshold: need };
}
// THE DIAMOND PICKAXE IS ASKED FOR ONLY WHILE OBSIDIAN IS: an order the fleet is short of obsidian for is on the mining pull.
function obsidianStock(row) {
  if (row.item !== 'diamond_pickaxe') return row;
  const pull = require('@kernel/corporate_headquarters').readConfRoomFlag('job_board_room', 'materials_needed_pull', {}) || {};
  return pull.obsidian > 0 ? { ...row, deficit_below: Math.max(row.deficit_below, 1) } : row;
}
const minimumRows = () => STOCK_THRESHOLDS.map(kitStock).map(crewStock).map(standInStock).map(obsidianStock);
// THE PUSH SIDE OF A CHEST ROW: with its minimum met, one more is asked for while every material of its recipe lies spare in
// the chests past what the kit, the building and the structures owe (assessors/shared.spareInChests), up to `surplus_to`.
// The material is banked, so the ask is a craft: it opens no mine and no chain.
function surplusStock(row) {
  if (!row.surplus_to) return row;
  const lens = require('@kernel/inventory_lens');
  const held = lens.forChestRequest(row.item);
  const cap = row.surplus_to === 'crew' ? Object.keys(require('@kernel/corporate_headquarters').getFullBoardroom({}) || {}).length : row.surplus_to;
  if (held < row.deficit_below || held >= cap) return row;
  const { requirementTree } = require('@utils/calculators/build_material_calculator');
  const { spareInChests } = require('@thinking/assessors/shared');
  const tree = requirementTree(row.item, 1, {});
  const owedByKit = kitOwed();
  const spare = Object.entries(tree).every(([material, n]) => spareInChests(material) - (owedByKit[material] || 0) >= n);
  return spare ? { ...row, deficit_below: held + 1 } : row;
}
// activeStockRows() → the stock rows this body measures against: the one kit, its for_kit rows worked out this pass.
function activeStockRows() {
  return minimumRows().map(surplusStock);
}

// kitOwed() → { material: units } — what the crew's kit still costs in each for_kit material: the for_kit row's own
// figure, plus that material in every chest row the chests are short of (the bucket). {} when the crew has no kit row.
function kitOwed() {
  const rows = minimumRows();
  const owed = {};
  for (const row of rows) if (row.for_kit) owed[row.item] = (owed[row.item] || 0) + row.deficit_below;
  if (Object.keys(owed).length === 0) return owed;
  const lens = require('@kernel/inventory_lens');
  const { requirementTree } = require('@utils/calculators/build_material_calculator');
  for (const row of rows) {
    if (row.holder !== 'storage' || row.for_kit || !(row.deficit_below > 0)) continue;
    const short = row.deficit_below - lens.forChestRequest(row.item);
    if (short <= 0) continue;
    const tree = requirementTree(row.item, short, {});
    for (const material of Object.keys(owed)) owed[material] += tree[material] || 0;
  }
  return owed;
}

module.exports = { activeBuildingRequirements, activeStockRows, minimumRows, kitOwed };
