// assessors/ground_salvage — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const watcher = require('@kernel/watcher');
const { readBuildCenter } = require('@utils/fragment_utils');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
} = require('@thinking/architect_config');

const { TAG } = require('@thinking/assessors/shared');
// ── SECTION 4.9 — Ground salvage around the base ──
// A flat drop scan based on the headframe's location: not triggered by a death, but by drops sitting
// within range of the headframe — bots normally mill around there, so a base-centered scan reaches more
// value than a death-triggered one.
//
// THIS REPLACED DEATH-PILE RETRIEVAL WHOLE. The old section read a ledger of recorded deaths;
// ground_drop_scanner reads the entity table. Its header carries why that is a structural improvement and
// not a simplification — a record of a grave outlives the grave, a scan cannot. A ledger-based approach
// can flap between posting and un-posting a job for a pile the world has already reaped, because the
// ledger has no way to know the pile is gone until something checks it; a live scan never has this
// problem.
//
// THE BOARD OWNS WHETHER, THE EXECUTOR OWNS WHETHER-THE-WALK-IS-AFFORDABLE. The split is forced, not
// stylistic: this sweep is SYNCHRONOUS and pricing a route is async (the same constraint death_manager's
// header records). So every gate here is cheap and synchronous, and the route price waits for a claim.
//
// The ARMED gate is the one that is not obvious, and it is INHERITED rather than restated: whatever killed
// a bot is standing on what it dropped, so this can be a combat approach and not a walk. `rung: 'fist'`
// from the fleet's one weapon ranking (Law 16) means nothing in the pocket qualifies and no job posts. A
// fleet with no armed bot offers no salvage at all, which is default-stopped and correct (Law 13).
//
// scope:'shared', and the armed gate is what makes it mean anything: the bot that DIED respawns
// empty-handed and unarmed, so it is the worst candidate in the fleet for its own grave.
//
// ONE JOB PER SWEEP, NOT ONE PER DROP. A felled tree scatters a dozen stacks inside four blocks and the
// executor's local sweep collects all of them from one arrival, so a job each would be eleven claims for
// work already done — and eleven rows on the board burying every other job (Law 5). The nearest valuable
// drop is offered; the rest come up by themselves next sweep if the sweep missed them.
function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.entity || !bot.entity.position) return { jobs };

    const buildCenter = readBuildCenter('headframe');
    if (!buildCenter || typeof buildCenter.x !== 'number') return { jobs };

    const { pickBestWeapon } = require('@utils/combat_utils');
    if (pickBestWeapon(bot).rung === 'fist') return { jobs };

    // ── CAPABILITY IS A PRECONDITION, NOT A RANK ────────────────────────────────────────────────────────
    // This job once outranked a now-deleted dump JOB, and the reason the old order existed has to survive
    // that job's deletion. That reason was sound — a bot with no free slots walks to the drops and leaves
    // them there — but it was expressed as a RANK, and a rank cannot say it: priority means *how urgent*,
    // and "can I carry anything" means *am I able at all*. Conflating them produces a live failure mode: a
    // coarse "am I full" rank check can read a bot as unable to carry more when it still has ample free
    // slots, letting it claim the dump over an expiring salvage pile — the dump threshold was about
    // comfort, and it was outranking the only job in the fleet with an expiry.
    //
    // The precondition OUTLIVED the rank contest that motivated it, and that is the point worth keeping:
    // with room, the pile goes first because only the pile has a clock; with NO room this posts nothing
    // and the bot does other work, every piece of which now ends in a drop-off — so the pocket empties as
    // a side effect and the pile is offered again on the next sweep.
    //
    // IT ALSO CLOSES A LOOP THE BARE SWAP WOULD HAVE OPENED — the wrong turn worth naming: at a higher
    // rank with no free-slot test, a full bot claims the pile, collects nothing, returns, and claims it
    // again forever, with nothing able to intervene.
    // Guarded like every other emptySlotCount read in this file, and it FAILS OPEN: if the count cannot be
    // taken, the pile is still offered. An unreadable inventory is not evidence of a full one, and the
    // expiring job is the wrong one to suppress on a missing measurement (Law 23).
    const freeSlots = bot.inventory && typeof bot.inventory.emptySlotCount === 'function'
      ? bot.inventory.emptySlotCount()
      : null;
    if (freeSlots !== null && freeSlots <= 0) return { jobs };

    const scanner = require('@perception/ground_drop_scanner');
    const { isRefused } = require('@action/ground_salvage_executor');
    const seen = scanner.scan(bot, buildCenter);
    const offerable = seen.drops.filter((d) => !isRefused(d.id));

    // The DENOMINATOR is on the line whenever anything was seen, and that is the difference between a
    // gate that is working and one that is broken (Law 6/25). "0 offered" alone reads identically for a
    // clean yard, a valuable gate rejecting everything, and a scanner returning nothing at all.
    if (seen.scanned > 0) {
        watcher.summary(TAG, `salvage scan: ${seen.scanned} drop(s) in sight → ${offerable.length} offerable ` +
            `(${seen.rejected.far} outside ${scanner.SALVAGE_RADIUS}b, ${seen.rejected.worthless} not wanted, ` +
            `${seen.rejected.airborne} off the ground, ${seen.drops.length - offerable.length} already declined)`);
    }
    if (!offerable.length) return { jobs };

    const best = offerable[0];
    jobs.push({
        id: `ground_salvage_${best.id}`, type: 'ground_salvage', what: best.name,
        where: best.pos, drop_id: best.id,
        why: `${best.count}× ${best.name}, ${Math.round(best.distance)}b from home` +
             `${offerable.length > 1 ? ` (+${offerable.length - 1} more in the yard)` : ''}`,
        job_type: JOB_TYPE.ground_salvage,
        claimed_by: null, scope: 'shared',
    });
    return { jobs };
}

module.exports = { name: 'ground_salvage', assess };
