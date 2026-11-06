// js_kernel/producer_hooks.js — the producers a downloaded building's blocks wait on beyond the five base
// materials (blueprint_material_rule), one row per producer: which blocks it makes, and whether it stands yet.
//
// A block one of these producers makes is KEPT in the plan (the material rule's `awaiting` family) and set
// aside at load (downloaded_plan_registry) while its producer is not ready: its cell is built as air and
// nothing orders it, so a building is never held up by a producer that does not exist yet. When a producer is
// built, its `ready` answers true and its blocks are built and ordered like any other.
//
// A block no row makes, and that no base family builds, is an extreme rarity and is left out of the plan:
// brewing_stand (a blaze rod from the nether), cobweb (an abandoned mineshaft), potted_cherry_sapling and
// potted_dead_bush (one biome each). Absence from these rows is that exclusion. The enchanting table is built as
// planks (blueprint_material_rule).
//
// `empty`, where a row has it, names the states that describe what is put into a block after it stands (a book on a
// lectern, books in a chiseled bookshelf's slots): the fleet places the block empty, and no placement rule sets them, so
// they are taken off the plan's voxels at load (emptied).
//
// `yields`, where a row has it, is what the producer hands over with no recipe (wool off a shorn sheep): the game
// may also craft it (wool from string), but the producer is its chain, so the recipe book does not owe it a
// recipe (crafting_blueprint_registry.mustCarryRecipe).
//
// A `ready` that answers true is a producer every crew building downloaded plans has: the sheep and the cattle
// read the pens (architect_config FARM_PENS, HERDING.pens), the library the cow pen and the cane field
// (architect_config FARM_FIELD). Every other `ready` is a stub: no producer is built yet. Nothing that
// needs deepslate or the nether is turned on: the enchanting table stays planks.

'use strict';

// crewsHavePen(test) → whether the crews' pens hold one whose HERDING.pens row passes `test`.
function crewsHavePen(test) {
    const { FARM_PENS, HERDING } = require('@thinking/architect_config');
    return FARM_PENS.some(pen => test(HERDING.pens[pen]));
}

// crewsHaveField(field) → whether the crews tend the crop field `field`.
function crewsHaveField(field) {
    return require('@thinking/architect_config').FARM_FIELD.keys.includes(field);
}

const PRODUCERS = Object.freeze({
    // Wool from shorn sheep, and what is woven from it.
    sheep:    { makes: /^(\w+_wool|\w+_carpet|\w+_bed|\w+_banner|\w+_wall_banner)$/, yields: /^\w+_wool$/, ready: () => crewsHavePen(row => row.wool) },
    // Wheat from a farm, and what is baled from it.
    farm:     { makes: /^(wheat|farmland|hay_block)$/, ready: () => false },
    // Milk, eggs, sugar and wheat.
    kitchen:  { makes: /^cake$/, ready: () => false },
    // Sand, gravel and a dye, set in water.
    concrete: { makes: /^\w+_concrete$/, ready: () => false },
    // Flowers, grasses and berries picked from the surface, and the pots they stand in.
    flora:    { makes: /^(flower_pot|potted_(?!cherry_sapling$|dead_bush$)\w+|fern|large_fern|short_grass|tall_grass|sweet_berry_bush|azure_bluet|allium|lily_of_the_valley|poppy|dandelion|blue_orchid|oxeye_daisy|cornflower|\w+_tulip)$/, ready: () => false },
    // Books, from leather (a culled cow) and paper (sugar cane off the cane field).
    library:  { makes: /^(bookshelf|lectern|chiseled_bookshelf)$/, empty: /^(has_book|powered|slot_\d_occupied)$/,
        ready: () => crewsHavePen(row => row.cull_keep !== null) && crewsHaveField('cane_field') },
    // Leather off a culled cow (cull_executor): the cull is leather's chain, and an order for it waits for the chests to
    // hold some (job_gates.chainGate over hunt_items), so its rabbit-hide recipe is never walked.
    cattle:   { makes: /(?!)/, yields: /^leather$/, ready: () => crewsHavePen(row => row.cull_keep !== null) },
});

// producerOf(block) → the name of the producer that makes `block`, or null.
function producerOf(block) {
    for (const [name, row] of Object.entries(PRODUCERS)) if (row.makes.test(block)) return name;
    return null;
}

// awaits(block) → whether `block` is made by a producer that is not ready yet: kept in the plan, set aside now.
function awaits(block) {
    const name = producerOf(block);
    return !!name && !PRODUCERS[name].ready();
}

// emptied(voxel) → the voxel with the states its producer's `empty` names taken off: the block as the fleet places it.
function emptied(v) {
    const name = producerOf(v[3]);
    const empty = name && PRODUCERS[name].empty;
    if (!empty || !v[4]) return v;
    const state = Object.fromEntries(Object.entries(v[4]).filter(([k]) => !empty.test(k)));
    return Object.keys(state).length ? [v[0], v[1], v[2], v[3], state] : [v[0], v[1], v[2], v[3]];
}

// yieldedByProducer(item) → whether a producer hands `item` over without a recipe.
function yieldedByProducer(item) {
    return Object.values(PRODUCERS).some(row => row.yields && row.yields.test(item));
}

module.exports = { PRODUCERS, producerOf, awaits, emptied, yieldedByProducer };
