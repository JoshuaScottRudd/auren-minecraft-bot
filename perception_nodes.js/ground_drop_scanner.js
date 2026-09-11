// perception node: ground_drop_scanner — what worth-having is lying on the ground around the base.
//
// ── WHY A LIVE SCAN REPLACES THE DEATH-PILE LEDGER, structurally ───────────────────────────────────
// A flat scan gated on distance from the headframe replaces the old death-triggered pile ledger. The old
// system recorded a death, wrote the pile into HQ, and re-offered it from that record until a despawn
// timer reaped it. Every part of that is remembered state standing in for the world (Invariant B), and
// it failed in exactly the way remembered state fails: the ITEMS despawn on the server's clock while the
// RECORD lives on its own, so the board kept offering graves that were bare ground.
//
// An entity scan cannot produce a ghost. A drop that despawns leaves `bot.entities` and stops being
// offered on the very next sweep, with no timer, no reaper, no office and no merge across bots. That is
// the whole argument for the swap: it is not a cheaper version of the ledger, it is the same job done by
// re-sensing instead of remembering.
//
// ── AND IT IS NOT ABOUT DEATH ANY MORE ──────────────────────────────────────────────────────────────
// The old trigger was "a bot died here". This one is "something useful is on the ground near home",
// which catches the same graves plus every other way the fleet loses items around its own base — a
// fell whose logs rolled past the collection leash, a mob-dropped sword, a chest miss. The bots mill
// around the base, so this is ground they are already on.

'use strict';

const Vec3 = require('vec3');
const { STOCK_THRESHOLDS, HEADFRAME_SAFE_RADIUS } = require('@thinking/architect_config');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { group_to_item } = require('@utils/fragment_utils');
const { isWalkableSurface, isNotSafeSurface } = require('@utils/movement/terrain_predicates');

// The radius is the base's own guarded square, not a number of this node's own. HEADFRAME_SAFE_RADIUS is
// 32 and is already what "around the base" means to every other consumer (the commander's `inBase`, the
// animal scan); a second 32 here would be the drift architect_config's headers keep naming.
const SALVAGE_RADIUS = HEADFRAME_SAFE_RADIUS;

// ── WHAT COUNTS AS WORTH A WALK ─────────────────────────────────────────────────────────────────────
// The fleet already publishes what it wants, per item, in STOCK_THRESHOLDS: the `holder: 'bot'` rows ARE
// the bot inventory request (logs, planks, pickaxe, sword…) and the storage rows ARE the
// headframe chest's order (logs, bread, charcoal, iron, seeds, bone meal). Reading them is what makes
// this gate track a retune of the fleet's wants instead of drifting away from it, and it is the same
// argument the retired death_pile_executor made for pricing worth off the deficit rather than a
// hand-written value table.
//
// `deficit_below`, NEVER `dump_threshold`. A row with a min is something the fleet actively gathers toward; `dump_threshold` is the
// dump allowance, read on the way OUT. Reading it as a want sends a bot across the base for one gravel:
// cobblestone has a keep and no min, so a keep-reader would send a bot for rubble it would dump on
// arrival — or, wherever a keep sits at zero, refuse the walk instead. Wrong in either direction, and
// the same mistake.
//
// FOOD IS ADDED BY NAME because it is not carried by the thresholds: only `bread` appears there, as a
// storage row, while an apple or a cooked chop on the ground is worth the same walk and matches
// nothing. `food` is fragment_utils' existing group (Law 16 — the eat chain's own list), so a new cooked
// item joins this gate by being edible, not by being remembered here.
const FOOD = new Set(group_to_item.food || []);

// isValuable(name) → is this dropped item something the fleet is short of, or food.
//
// Matched through countInInventory rather than by string equality, because almost every interesting row
// is a GROUP token: a grave holds `oak_log` and `wooden_pickaxe` while the rows say `logs` and `pickaxe`,
// and an exact match scores every one of them zero — the gate would pass nothing and never say why.
// countInInventory is the fleet's one group-aware counter (Law 16).
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

// onGround(bot, pos) → is this drop standing on real footing, or is it in a tree.
//
// ── THE PILLAR REFUSAL, AND IT IS LAW 17 BEFORE IT IS ECONOMICS ─────────────────────────────────────
// A drop resting on canopy is a trap with a delay on it: the bot pillars or climbs to reach it, the
// decaying leaves take the floor out from under it, and it falls. drop_collector's `isCanopyDrop` refuses
// on the same two signals for the same reason. This asks the question from a DIFFERENT anchor (the
// headframe, from a board sweep that may be hundreds of blocks from the drop) so it cannot use that
// function's "how far above the bot's own feet" proxy, but the leaf test and the intent are the same one.
//
// THE SUPPORT MUST BE STANDABLE, not merely present. `isWalkableSurface` is the navigator's own predicate,
// so a drop whose only footing is a fence top or a slab edge — ground the walker will refuse to route
// onto — is declined here rather than offered and then abandoned. And `isNotSafeSurface` drops the item
// floating on water or beside lava: reachable, and not worth a bot.
function onGround(bot, pos) {
  const at = (dy) => bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) + dy, Math.floor(pos.z)));
  const here = at(0);
  const below = at(-1);
  // A null read is UNLOADED CHUNK, not open sky, and the two want opposite answers. Default-stopped
  // (Law 13): an item this bot cannot see the floor under is not offered, and the next sweep — from
  // wherever the fleet has walked by then — asks again.
  if (!below) return false;
  if (here && String(here.name).includes('leaves')) return false;
  if (String(below.name).includes('leaves')) return false;
  if (isNotSafeSurface(below)) return false;
  return isWalkableSurface(below);
}

// scan(bot, center) → { drops: [{ id, name, count, pos, distance }], scanned, rejected: {…} }
//
// Synchronous and cheap on purpose: job_board's sweep cannot await, which is the same constraint that
// shaped the retired death-pile board gate. Nothing here prices a route or decides worth-vs-cost — that
// is the executor's, after a claim, where an async price is legal.
//
// THE REJECTION COUNTS ARE RETURNED, not logged here. A node that logs is a node with an opinion about
// who is asking; the board posts one line and the reader gets "14 drops seen, 9 worthless, 3 in trees"
// instead of a bare "1 offered", which is the difference between a gate that is working and one that is
// broken (Law 6).
function scan(bot, center) {
  const out = { drops: [], scanned: 0, rejected: { far: 0, worthless: 0, airborne: 0 } };
  if (!bot || !center || typeof center.x !== 'number') return out;

  for (const e of Object.values(bot.entities || {})) {
    // `displayName`/`name` both carry 'item' depending on client version and how the entity arrived;
    // asking for the metadata-decoded item would be a second decode of a fact the entity name states.
    //
    // `displayName` AND NOT `objectType`, WHICH COST 4,560 STACK TRACES IN TEN MINUTES (2026-09-10).
    // prismarine-entity deprecated `objectType` and reports it with `console.trace` — an eight-line stack
    // dump per read, on a getter this loop touches for EVERY entity on EVERY sweep. Measured off the
    // captured bot console: 4,560 traces in one soak, which is the bulk of the 1.6 MB that console holds.
    // It was invisible in two ways at once: the trace goes to stdout rather than through the watcher, so
    // every lens scored the run `❌ 0` while it happened, and until this turn the bots' stdout was
    // discarded unread by the foreman. `displayName` is the substitute the library's own message names,
    // so this is a translation of the field and not a change to what counts as a drop.
    if (!e || !e.position) continue;
    const isItem = e.name === 'item' || e.displayName === 'Item' || e.entityType === 'item';
    if (!isItem) continue;
    out.scanned++;

    // HORIZONTAL, matching every other "in base" test in the fleet. A 3-D radius would spend the base's
    // 32 blocks on a drop's altitude — the same defect the aggro gate's cylinder was cut to fix, and for
    // the same reason: a drop 30 b out and 10 b down a slope is still in the yard.
    const distance = Math.hypot(e.position.x - center.x, e.position.z - center.z);
    if (distance > SALVAGE_RADIUS) { out.rejected.far++; continue; }

    const stack = e.metadata && e.metadata.find && e.metadata.find((m) => m && m.itemId !== undefined);
    const name = (stack && stack.itemId !== undefined && bot.registry && bot.registry.items[stack.itemId]
      ? bot.registry.items[stack.itemId].name
      : null);
    const count = (stack && stack.itemCount) || 1;
    // An undecodable stack is NOT waved through as "might be valuable": the whole gate is that a walk is
    // only spent on something wanted, and an unknown item cannot clear that bar (Law 23 — unverifiable
    // input is discarded, never promoted).
    if (!name || !isValuable(name)) { out.rejected.worthless++; continue; }
    if (!onGround(bot, e.position)) { out.rejected.airborne++; continue; }

    out.drops.push({ id: e.id, name, count, pos: { x: e.position.x, y: e.position.y, z: e.position.z }, distance });
  }

  // Nearest first, so the board offers the cheapest one and the executor's local sweep picks up whatever
  // clumps with it. Sorted here rather than by the caller for the reason the commander sorts its own
  // lists: one ordering, decided by the seat that produced the data (Law 16).
  out.drops.sort((a, b) => a.distance - b.distance);
  return out;
}

module.exports = { scan, isValuable, onGround, SALVAGE_RADIUS };
