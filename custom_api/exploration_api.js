// api: exploration_api
// purpose: WALK the bot toward the biome that normally holds what a caller wants. Law 15 sub-loop
//          mover — the caller says "I want this and it isn't near me", seek() answers "that's normally
//          in these biomes, I'll walk you there", drives locomotion, and returns once the bot has
//          moved. The caller then re-senses (scans) from the new position. Shared by
//          exploration_executor (the `explore` job) and seed_picker (heading for grass when the local
//          surface district has none). One implementation, one place (Law 16).
//
// WHY the mover lives here (reversed from the brief decision-only split, Architect 2026-07-04):
// "decide + walk toward a biome" is one verb with its own internal Sense-Plan-Act; splitting the walk
// out to every caller just duplicated the goTo handling. seek() owns the walk; the caller owns only
// the re-sense afterward.
//
// NO retry / NO soft-loop (Law 13): seek() makes ONE move toward the chosen biome and returns. It is
// the CALLER's job to re-sense and decide — and a caller must NOT sit in a scan→seek→scan loop: if a
// re-sense after a real move still fails, the expectation is broken (seek keeps re-picking the biome
// it's already in and barely moves), which can only infinite-loop. That is a coding violation to
// surface (throw), not an environmental condition to retry.
//
// FAILURE (Law 15): movement is goTo's domain. goTo resolves arrived:false on a normal give-up (seek
// returns the give-up position) and never resolves only on a hard emergency (seek is abandoned with
// the chain, intentional). seek() adds no movement retry of its own.
//
// Returns: { mode, current_biome, current_rank, target_biome?, position?, distance?, for_item?, arrived_at? }.
//   mode 'none_detected' → nothing usable this cycle (no move made). Other modes → the bot walked.

const Vec3    = require('vec3');
const biomeScanner = require('@perception/biome_scanner');
const { guardExternalSync } = require('@utils/external_library_guard');
const TAG = 'exploration_api';

// ── BIOME_RANK — desirability for surface base building. Higher = better. Unlisted → DEFAULT_RANK.
// Reflects flatness, wood availability, mob threat, aesthetics. Key = name with 'minecraft:' stripped.
const DEFAULT_RANK = 3;
const BIOME_RANK = {
    plains: 10, sunflower_plains: 10, meadow: 9, forest: 9, birch_forest: 9,
    flower_forest: 8, old_growth_birch_forest: 7,
    taiga: 7, old_growth_pine_taiga: 6, old_growth_spruce_taiga: 6, dark_forest: 6, mushroom_fields: 6,
    savanna: 5, savanna_plateau: 5, sparse_jungle: 5, snowy_plains: 5, snowy_taiga: 5,
    jungle: 4, windswept_hills: 3, windswept_forest: 3, swamp: 3, grove: 3, cherry_grove: 7,
    bamboo_jungle: 3, desert: 2, beach: 2, windswept_gravelly_hills: 2, stony_peaks: 2, river: 2,
    frozen_river: 1, mangrove_swamp: 2, windswept_savanna: 4, snowy_slopes: 2, stony_shore: 1,
    jagged_peaks: 1, frozen_peaks: 1, ice_spikes: 1,
    ocean: 1, deep_ocean: 1, cold_ocean: 1, deep_cold_ocean: 1, lukewarm_ocean: 1,
    deep_lukewarm_ocean: 1, warm_ocean: 1, frozen_ocean: 1, deep_frozen_ocean: 1,
    // Cave biomes — should not appear at surface, but guard against it.
    dripstone_caves: 1, lush_caves: 1, deep_dark: 1,
};

// Stripped biome name at a position, or null if the chunk isn't loaded.
function getBiomeName(bot, x, y, z) {
    // null on refusal is the same reading an unloaded chunk gives, which every caller here already
    // handles as "not surveyed yet" — never as a scored biome (Law 25: no default wearing a verdict).
    const biome = guardExternalSync(TAG, `getBiome at (${x},${y},${z})`, () => bot.world.getBiome(new Vec3(x, y, z)));
    if (!biome.ok || biome.value == null) return null;
    const name = bot.registry?.biomes?.[biome.value]?.name || '';
    return name.replace('minecraft:', '').toLowerCase() || null;
}

// Biome at the bot's live position — try feet Y then ±1 (no surface scan; the bot is a live entity).
function currentBiomeFromBot(bot, refX, refY, refZ) {
    for (const tryY of [refY, refY - 1, refY + 1]) {
        const name = getBiomeName(bot, refX, tryY, refZ);
        if (name) return name;
    }
    return null;
}

// chooseTarget — which detected biome to head toward this cycle.
//   patches:      biome_scanner's flat, distance-SORTED patch list [{ biome, dist, seed, … }] (nearest first)
//   targetBiomes: { item: [biomeName, ...] } material-driven candidates (possibly {})
//   currentBiome: excluded from general_seek so we never "seek" the biome we're already in
// Returns { mode, biomeName, position, distance, forItem? } or null (nothing usable). The patch list is the
// biome_scanner upgrade (2026-07-18): the nearest PATCH of a biome is `patches.find(p => p.biome === name)`
// (already sorted), which is exactly the old "nearest point per biome" this used to read — same behaviour,
// richer source. `seed` is the patch's nearest cell = the walk target (the old `.position`).
function chooseTarget(patches, targetBiomes, currentBiome) {
    if (!patches || patches.length === 0) return null;

    if (targetBiomes && typeof targetBiomes === 'object' && Object.keys(targetBiomes).length > 0) {
        let best = null;
        for (const [item, candidates] of Object.entries(targetBiomes)) {
            if (!Array.isArray(candidates)) continue;
            for (const p of patches) {                       // dist-sorted, so the first match per candidate is nearest
                if (!candidates.includes(p.biome)) continue;
                if (!best || p.dist < best.distance) {
                    best = { mode: 'material_seek', biomeName: p.biome, position: p.seed, distance: p.dist, forItem: item };
                }
            }
        }
        if (best) return best;
        // none of the candidate biomes are visible — fall through to general_seek
    }

    let best = null;
    for (const p of patches) {
        if (p.biome === currentBiome) continue;
        const rank = BIOME_RANK[p.biome] ?? DEFAULT_RANK;
        if (!best || rank > best.rank || (rank === best.rank && p.dist < best.distance)) {
            best = { mode: 'general_seek', biomeName: p.biome, position: p.seed, distance: p.dist, rank };
        }
    }
    return best; // null if the only detected biome is the one we're already in
}

// ── Main API ─────────────────────────────────────────────────────────────────
// Decide a target biome from detections and WALK one step toward it. Returns after the move.
async function seek(bot, opts = {}) {
    bot = bot || global.bot;
    if (!bot?.entity?.position) {
        throw new Error('[exploration_api] CODING VIOLATION: seek called with no bot loaded.');
    }
    const refX = Math.floor(bot.entity.position.x);
    const refY = Math.floor(bot.entity.position.y);
    const refZ = Math.floor(bot.entity.position.z);

    const currentBiome = currentBiomeFromBot(bot, refX, refY, refZ);
    const currentRank  = BIOME_RANK[currentBiome] ?? DEFAULT_RANK;

    // Sense fresh, then plan (Law 11 / Invariant B). This is the ONLY populator of the biome scan on
    // the seek path — nothing else calls scanBiomes here (only the unrelated water-site overlay did),
    // so getState() used to read empty and seek always held. Scanning at the top of the one shared
    // mover brings the scanner online for BOTH callers — exploration_executor's build-site hunt and
    // seed_picker's grass hunt — in one place (Law 16). One scan per call = one SPA, not a loop.
    biomeScanner.scanBiomes(bot);
    const patches      = biomeScanner.getState()?.patches || [];
    const targetBiomes = opts.targetBiomes || {};

    const target = chooseTarget(patches, targetBiomes, currentBiome);
    if (!target) {
        return { mode: 'none_detected', current_biome: currentBiome, current_rank: currentRank, arrived_at: null };
    }

    // Walk toward the biome's sample point (closest reachable). goTo owns abandonment (Law 15).
    const locomotion = require('@locomotion/locomotion_dispatcher');
    const approach = await locomotion.goTo({ x: target.position.x, y: target.position.y, z: target.position.z });

    return {
        mode:            target.mode,
        current_biome:   currentBiome,
        current_rank:    currentRank,
        target_biome:    target.biomeName,
        target_position: target.position,
        target_distance: target.distance,
        for_item:        target.forItem || null,
        arrived_at:      approach?.position || null,
    };
}

module.exports = { seek, BIOME_RANK };
