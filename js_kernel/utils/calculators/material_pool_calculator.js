/*
material_pool_calculator.js — how many of an item are in which pool, and the one place that question is
answered.

Three different questions are asked here, each over a different set of places:

  POCKET               what this body is carrying. Right for a kit row — a pickaxe in a distant chest
                        does not stop this body needing one in its hand.
  STORAGE               what the fleet's chests hold, and nothing a body carries. Right for a chest
                        request, which wants an amount sitting in the chest; a body's own pocket
                        neither satisfies it nor competes with it.
  POCKET_AND_STORAGE    everything within the fleet's reach. Right for a build order: material in a
                        chest is available, so it counts, and a body already carrying some is not sent
                        out again.

A pool is a list of places, never a number. Nothing here decides what to do with the count; it says
where it was measured. The dispatcher's among-equals tie-break is the one consumer that turns a count
into a choice, and the band it is choosing for decides which pool it asks for — see BAND_POLICY in
architect_config.

`accessibleMaterialPool()` and `inventory_lens.reachableByFleet` both name the pocket-plus-chests pool
under names that do not say which pool it is; naming the pool at the call site lets a reader see which
of the three was meant without opening this file (Law 7).

Pure and stateless. Group-aware through `countInInventory`, the one counter (Law 16) — this module
builds the map and delegates the counting, it never counts anything itself.
*/

'use strict';

const { countInInventory } = require('@utils/calculators/inventory_calculator');

// The whole list of pools; a fourth is a decision about where material legitimately lives, added here
// and nowhere else.
const POOL = {
    POCKET: 'pocket',
    STORAGE: 'storage',
    POCKET_AND_STORAGE: 'pocket_and_storage',
};

const POOL_NAMES = Object.values(POOL);

// Every registered chest summed, and nothing any body carries — the half `accessibleMaterialPool` does
// not expose separately, and what a chest request is measured against.
//
// A live read (Invariant B): the station registry holds what was last seen in each chest, so a peer
// that drained a barrel seconds ago is already reflected. It cannot see material in flight in a peer's
// pocket, since a chest request asks what is in the chest, and a log in a peer's bag is not.
function storageCounts() {
    const { normalizeItemName } = require('@utils/fragment_utils');
    const stationRegistry = require('@perception/station_registry');
    const counts = {};
    for (const entry of Object.values(stationRegistry.getStations() || {})) {
        if (!stationRegistry.isStorage(entry) || !Array.isArray(entry.items)) continue;
        for (const it of entry.items) {
            if (!it || !it.name || !(it.count > 0)) continue;
            const n = normalizeItemName(it.name);
            counts[n] = (counts[n] || 0) + it.count;
        }
    }
    return counts;
}

// The token→count map for one named pool. Exposed so a caller reading several items out of the same
// pool builds the map once.
function poolCounts(pool) {
    const { getBotInventory, normalizeItemName } = require('@utils/fragment_utils');
    if (pool === POOL.POCKET) {
        // Normalised on the way in, so all three pools are the same namespace and a caller cannot get a
        // different answer for `minecraft:oak_log` depending on which pool it asked.
        const out = {};
        for (const [name, count] of Object.entries(getBotInventory() || {})) {
            if (!count) continue;
            out[normalizeItemName(name)] = (out[normalizeItemName(name)] || 0) + count;
        }
        return out;
    }
    if (pool === POOL.STORAGE) return storageCounts();
    if (pool === POOL.POCKET_AND_STORAGE) {
        const out = poolCounts(POOL.POCKET);
        for (const [name, count] of Object.entries(storageCounts())) out[name] = (out[name] || 0) + count;
        return out;
    }
    // An unrecognised pool name would otherwise fall through to an empty map and answer as a real zero —
    // the same trap `countInInventory` throws on for a malformed map (Law 13).
    throw new Error(`[material_pool_calculator] CODING VIOLATION (Law 13): unknown pool `
        + `${JSON.stringify(pool)}. The pools are ${POOL_NAMES.join(' | ')} — see POOL above.`);
}

// The single question this module exists to answer. Group-aware: 'planks' counts every plank species,
// because `countInInventory` owns that and nothing re-implements it here.
function countInPool(item, pool) {
    if (!item) {
        throw new Error(`[material_pool_calculator] CODING VIOLATION (Law 13): item is required, `
            + `got ${JSON.stringify(item)}.`);
    }
    return countInInventory(item, poolCounts(pool));
}

module.exports = { POOL, POOL_NAMES, countInPool, poolCounts };
