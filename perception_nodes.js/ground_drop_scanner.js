// perception node: ground_drop_scanner — what worth-having is lying on the ground near the bot's own
// body. Centred on the body, radius bounded by drop scatter, answering whether a drop is the body's to
// collect (Law 29); a live entity scan stands in for a remembered pile ledger (Invariant B).

'use strict';

const Vec3 = require('vec3');
const { STOCK_THRESHOLDS } = require('@thinking/architect_config');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { group_to_item } = require('@utils/fragment_utils');
const { isWalkableSurface, isNotSafeSurface } = require('@utils/movement/terrain_predicates');

// Pop-scatter radius, read live from drop_collector so both files agree on one number (Law 16); no margin.
const SALVAGE_RADIUS = require('@api/drop_collector.js').CLUMP_RADIUS;

// Worth-a-walk set: STOCK_THRESHOLDS deficit rows (`deficit_below`, never `dump_threshold`) plus
// food, from fragment_utils' own group (Law 16).
const FOOD = new Set(group_to_item.food || []);

// isValuable(name) → is this dropped item something the fleet is short of, or food. Matched through
// countInInventory, the fleet's group-aware counter (Law 16), since most rows are group tokens.
function isValuable(name) {
  if (!name) return false;
  if (FOOD.has(name)) return true;
  const one = { [name]: 1 };
  for (const row of STOCK_THRESHOLDS) {
    if (!row.item || typeof row.deficit_below !== 'number' || row.deficit_below <= 0) continue;
    if (countInInventory(row.item, one) > 0) return true;
  }
  return false;
}

// onGround(bot, pos) → is this drop standing on real footing, or is it in a tree. Refuses canopy
// (Law 17); requires isWalkableSurface / isNotSafeSurface, the navigator's own predicates.
function onGround(bot, pos) {
  const at = (dy) => bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) + dy, Math.floor(pos.z)));
  const here = at(0);
  const below = at(-1);
  // Unloaded chunk, not open sky; default-stopped (Law 13).
  if (!below) return false;
  if (here && String(here.name).includes('leaves')) return false;
  if (String(below.name).includes('leaves')) return false;
  if (isNotSafeSurface(below)) return false;
  return isWalkableSurface(below);
}

// scan(bot) → { drops: [{ id, name, count, pos, distance }], scanned, rejected: {…} }. No centre
// parameter (Law 16). Synchronous, since job_board's sweep cannot await.
async function scan(bot) {
  const pace = require('@utils/execution_yield').makeExecutionPacer();
  const out = { drops: [], scanned: 0, rejected: { far: 0, worthless: 0, airborne: 0, in_pit: 0 } };
  // Live position (Invariant B); no entity, no work to be near — default-stopped (Law 13).
  const center = bot && bot.entity && bot.entity.position;
  if (!bot || !center || typeof center.x !== 'number') return out;

  for (const e of Object.values(bot.entities || {})) {
    await pace();
    // `displayName`/`name` carry 'item'; never `objectType`, which logs a stack trace on every read.
    if (!e || !e.position) continue;
    const isItem = e.name === 'item' || e.displayName === 'Item' || e.entityType === 'item';
    if (!isItem) continue;
    out.scanned++;

    // Horizontal only, matching every other proximity test in the fleet.
    const distance = Math.hypot(e.position.x - center.x, e.position.z - center.z);
    if (distance > SALVAGE_RADIUS) { out.rejected.far++; continue; }

    const stack = e.metadata && e.metadata.find && e.metadata.find((m) => m && m.itemId !== undefined);
    const name = (stack && stack.itemId !== undefined && bot.registry && bot.registry.items[stack.itemId]
      ? bot.registry.items[stack.itemId].name
      : null);
    const count = (stack && stack.itemCount) || 1;
    // Undecodable stack: discarded, never waved through (Law 23).
    if (!name || !isValuable(name)) { out.rejected.worthless++; continue; }
    if (!onGround(bot, e.position)) { out.rejected.airborne++; continue; }
    if (require('@api/waste_pit').holds(e.position)) { out.rejected.in_pit++; continue; }   // thrown away, never salvaged

    out.drops.push({ id: e.id, name, count, pos: { x: e.position.x, y: e.position.y, z: e.position.z }, distance });
  }

  // Nearest first, sorted here, not by the caller — one ordering (Law 16).
  out.drops.sort((a, b) => a.distance - b.distance);
  return out;
}

module.exports = { scan, isValuable, onGround, SALVAGE_RADIUS };
