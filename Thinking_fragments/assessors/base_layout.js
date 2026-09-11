// assessors/base_layout — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const { baseLayoutComplete } = require('@action/lock_all_buildspots');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    ACCEPTABLE_BIOMES,
} = require('@thinking/architect_config');

const { currentBiome } = require('@thinking/assessors/shared');
// ── SECTION 4a — Base-layout lock (startup one-shot → lock_all_buildspots) ──
// "Done" asked of the batch via baseLayoutComplete(), never re-derived: a gate computing its own done can
// demand more than the performer delivers and re-post forever. Whole-base one-pass lock is deliberate: a
// bad seed surfaces early, not mid-build. Biome-gated: seek_biome (P0) moves the bot somewhere buildable
// first; without it a peer in a bad biome hard-stops the layout. Ranked just under home_base to WIN the
// locate race vs lazy per-blueprint finds. scope:'shared' — mutates shared HQ, one owner (Law 4). That the
// gate goes quiet on a SHORT field is UNGUARDED — no bench currently exercises this claim (`tools/README.md`),
// so a regression here would go uncaught.
function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.blockAt) return { jobs };

    if (baseLayoutComplete()) return { jobs };

    // THE BIOME GATE IS THE FARM'S, SO IT BINDS THE SPECIES THAT PLANTS ONE. ACCEPTABLE_BIOMES exists
    // because the wheat field needs water and plantable soil. A contractor sites one building — flat
    // clear ground — on a cell its owner chose to stand on, so the same gate would strand it beside a
    // human whose home is in a desert: it would refuse to site the house, idle forever, and never say
    // why the biome of a farm it will never plant was the reason (Law 6). Hence: homesteaders only.
    //
    // ── AN UNBUILDABLE BIOME NOW STOPS THE BOT AND SAYS SO. IT NO LONGER WALKS AWAY ────────────────
    // Ruled 2026-09-10: *"remove the biome exploring for setting build spots… i dont want the bots to
    // teleport to a player who lives in the desert and the bots just walk off to another loaded chunk to
    // make a base. it should just refuse and crash and tell the human that it cant find a place to build
    // the base. it should only biome hunt if searching for surface items like logs."*
    //
    // This gate used to `return { jobs }` in silence and rely on a `seek_biome` job (P0) to march the bot
    // somewhere buildable. That job is deleted — `assessors/exploration.js` went with it. The behaviour
    // it produced is the one thing a placed crew must never do: a person stands somewhere, asks for a
    // crew, and the crew wanders off to found its base in a chunk the person is not in. **Where the
    // person stands IS the instruction** (the whole point of the placement gate in `start_injector`), so
    // a base sited anywhere else is the bot overruling it.
    //
    // WHY A THROW RATHER THAN A REFUSAL THAT LOGS. The silent return was already a refusal, and it
    // produced a bot standing in a desert with an empty board, forever, saying nothing a reader could
    // act on. There is no correct action available: it may not walk away, and it cannot make the ground
    // plantable. Default-stopped is the answer to exactly that (Law 13), and the message is written for
    // the human because the human is the only party who can fix it — by standing somewhere else.
    //
    // UNKNOWN IS NOT UNACCEPTABLE, AND CONFLATING THEM WOULD BE A FALSE CRASH. `currentBiome()` returns
    // null for an unloaded column and for a refused read alike — a bot that cannot yet name where it
    // stands has not been told it is in a desert. That case still waits, exactly as before. Only a biome
    // the bot has successfully READ and found unacceptable is a hard stop, because only that reading is
    // evidence about the world (Law 23).
    if (!require('@kernel/bot_mandate').isContractor()) {
        const biome = currentBiome();
        if (!biome) return { jobs };
        if (!ACCEPTABLE_BIOMES.has(biome)) {
            throw new Error(`[base_layout] CODING VIOLATION (Law 13): NO PLACE TO BUILD — this `
                + `homesteader is standing in '${biome}', and a homestead needs water and plantable soil `
                + `for its wheat field. Buildable biomes are: ${[...ACCEPTABLE_BIOMES].join(', ')}. `
                + `It will NOT walk off to find better ground: it was brought to where a person was `
                + `standing, and that placement is the instruction. Stand somewhere buildable and ask the `
                + `desk for a crew again ("foreman get homesteader").`);
        }
    }

    jobs.push({
        id: 'lock_base_layout', type: 'base_layout', what: 'lock_base_layout',
        where: null,
        job_type: JOB_TYPE.base_layout_lock,
        claimed_by: null, scope: 'shared',
    });
    return { jobs };
}

module.exports = { name: 'base_layout', assess };
