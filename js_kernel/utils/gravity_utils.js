// util: gravity_utils
// purpose: Single source of truth for gravity-block / fluid identification, the
//          shared "gravel-to-fluid conduit" hazard scan used by both the shaft
//          site picker (find_buildingspot) and the cell hazard scan (scanCell),
//          and water source-vs-flow classification (used by find_buildingspot's
//          farmland site search — a river/ocean SOURCE is a valid attach point,
//          a flowing stream is not).
//
// WHY this exists (Law 16 — one pathway): find_buildingspot, mining_integrity and
//   the cell scanner all need the SAME notion of "what is a gravity block" and
//   "what is a fluid", and two of them need the SAME conduit-detection logic. Three
//   copies of the sets + two copies of the column walk would drift apart. They live
//   here once and are imported everywhere (Law 16).
//
// THE GRAVEL DOCTRINE: gravel/sand are NOT rejected on sight. A gravity block is
//   only a *hazard* if its column connects to a fluid — as the column falls into
//   the dug space, the fluid follows. Everything else is a benign runtime nuisance
//   the executor repeat-mines until the column is exhausted. So this module
//   distinguishes CONDUIT (hard reject) from BENIGN (buildable).

const { Vec3 } = require('vec3');
const { guardExternalSync } = require('@utils/external_library_guard');

// Blocks that fall under gravity. A gravity block in a mined space cascades: dig the
// bottom one and the column above drops into the vacated spot.
const GRAVITY_BLOCKS = new Set(['gravel', 'sand', 'red_sand', 'suspicious_sand', 'suspicious_gravel']);

// Blocks that flood or burn a dug space. The only material-based hard disqualifier
// underground — everything solid is fair game to dig.
const FLUID_HAZARDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column']);

// Safety cap on the upward column walk: no Minecraft column is taller than the build
// limit. Without it a pathological world read (or a bug) could spin forever.
const MAX_COLUMN_WALK = 384;

function isGravityBlock(name) { return GRAVITY_BLOCKS.has(name); }
function isFluid(name) { return FLUID_HAZARDS.has(name); }

// Unguarded: blockAt ANSWERS null for an unloaded column rather than throwing, and null is already
// the reading every caller of this handles.
function blockName(bot, x, y, z) {
  const b = bot.blockAt(new Vec3(x, y, z));
  return b ? b.name : null;
}

// isWaterSource — distinguishes a still water SOURCE block (river/ocean surface,
// safe to attach a farmland site to) from flowing water (a stream feed, drains
// dry over time). The "level" blockstate property is 0 only at a source; any
// other value (1-15) is a flow tier — a literal name check against FLUID_HAZARDS
// cannot make this distinction.
function isWaterSource(bot, x, y, z) {
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block || block.name !== 'water') return false;
  if (typeof block.getProperties === 'function') {
    const props = guardExternalSync('gravity_utils', 'block.getProperties() for water level', () => block.getProperties());
    if (props.ok && props.value && props.value.level !== undefined) return parseInt(props.value.level, 10) === 0;
  }
  // A plain property read on an object we already hold — nothing to guard.
  if (typeof block.metadata === 'number') return block.metadata === 0;
  return false;
}

// followGravityColumn — given a gravity block at (x,y,z), decide whether its column
// is a fluid conduit (hard hazard) or benign (the executor will repeat-mine it).
//
// Walks UP the contiguous gravity column to its top, then checks two ways a fluid can
// reach the dug space: (1) a fluid directly capping the top of the column (it drops in
// once the plug is removed), and (2) a fluid as a horizontal neighbor of any block in
// the column (it flows in sideways as the column falls). Returns 'CONDUIT' or 'BENIGN'.
//
// Bounded by column height + a constant 4-neighbor check per level — cheap. A null
// (unloaded) block is treated as non-fluid here; the CALLER is responsible for the
// separate "unloaded chunk → defer" decision (Law 13 environmental), because that is a
// different outcome (defer, not reject) than this function's hazard verdict.
function followGravityColumn(bot, x, y, z) {
  let cursor = y;
  let guard = MAX_COLUMN_WALK;
  while (guard-- > 0 && isGravityBlock(blockName(bot, x, cursor + 1, z))) cursor++;

  // (1) fluid capping the top of the column
  if (isFluid(blockName(bot, x, cursor + 1, z))) return 'CONDUIT';

  // (2) fluid flowing in from the side as the column falls
  const HNEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let cy = y; cy <= cursor; cy++) {
    for (const [ddx, ddz] of HNEIGHBORS) {
      if (isFluid(blockName(bot, x + ddx, cy, z + ddz))) return 'CONDUIT';
    }
  }
  return 'BENIGN';
}

module.exports = {
  GRAVITY_BLOCKS,
  FLUID_HAZARDS,
  isGravityBlock,
  isFluid,
  isWaterSource,
  followGravityColumn,
};
