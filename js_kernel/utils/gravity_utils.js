// Identifies gravity blocks and fluids, classifies a gravity column as a fluid CONDUIT
// (hard hazard) or BENIGN (a runtime nuisance the executor repeat-mines), and tells a
// water source apart from flowing water. The one definition find_buildingspot,
// mining_integrity and the cell hazard scanner all share (Law 16).

const { Vec3 } = require('vec3');
const { guardExternalSync } = require('@utils/external_library_guard');

// Blocks that cascade when the block beneath is mined.
const GRAVITY_BLOCKS = new Set(['gravel', 'sand', 'red_sand', 'suspicious_sand', 'suspicious_gravel']);

// Blocks that flood or burn a dug space — the only material-based hard disqualifier underground.
const FLUID_HAZARDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column']);

// Bounds the upward column walk to the tallest possible Minecraft column.
const MAX_COLUMN_WALK = 384;

function isGravityBlock(name) { return GRAVITY_BLOCKS.has(name); }
function isFluid(name) { return FLUID_HAZARDS.has(name); }

// Reads a block's name; null for an unloaded column, the reading every caller here handles.
function blockName(bot, x, y, z) {
  const b = bot.blockAt(new Vec3(x, y, z));
  return b ? b.name : null;
}

// True for a still water SOURCE block (safe farmland attach point), false for flowing water.
// The "level" blockstate property is 0 only at a source; 1-15 is a flow tier.
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

// Walks up a gravity column from (x,y,z) to its top and checks whether a fluid reaches
// the dug space by capping the column or touching a horizontal neighbor at any level.
// Returns 'CONDUIT' (hard hazard) or 'BENIGN'. An unloaded block reads as non-fluid here;
// the caller owns the separate unloaded-chunk defer decision (Law 13).
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
