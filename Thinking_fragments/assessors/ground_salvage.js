// assessors/ground_salvage — a flat drop scan around this body's own work. See assessor_registry.

'use strict';

const watcher = require('@kernel/watcher');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE,
} = require('@thinking/architect_config');

const { TAG } = require('@thinking/assessors/shared');
// ── SECTION 4.9 — Ground salvage around THIS BODY'S OWN WORK ──
// A flat drop scan centred on the body, not triggered by a death: drops lying within a few blocks of
// where this bot stands — the scatter of what it just broke, plus a little. Centring on the body keeps
// many bodies from racing the same nearest-candidate list (`ground_drop_scanner`'s header carries the
// geometry).
//
// A live entity scan, not a ledger of recorded deaths: a scan reads what is actually still on the
// ground, so it cannot flap between posting and un-posting a job for a pile the world has already
// reaped.
//
// THE BOARD OWNS WHETHER, THE EXECUTOR OWNS WHETHER-THE-WALK-IS-AFFORDABLE. The split is forced: this
// board offers sensed work; the route price belongs to the executor after its claim.
//
// The ARMED gate is inherited, not restated: whatever killed a bot is standing on what it dropped, so
// this can be a combat approach, not a walk. `rung: 'fist'` from the fleet's one weapon ranking (Law
// 16) means nothing in the pocket qualifies and no job posts. A fleet with no armed bot offers no
// salvage at all, default-stopped (Law 13).
//
// scope:'shared', and the armed gate is what makes it mean anything: the bot that DIED respawns
// empty-handed and unarmed, so it is the worst candidate in the fleet for its own grave.
//
// ONE JOB PER SWEEP, NOT ONE PER DROP. A felled tree scatters a dozen stacks inside four blocks and the
// executor's local sweep collects all of them from one arrival, so a job each would be eleven claims
// for work already done, burying every other job on the board (Law 5). The nearest valuable drop is
// offered; the rest come up by themselves next sweep if this one missed them.
async function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.entity || !bot.entity.position) return { jobs };

    // No structure gate here: the scan centre is the body itself (`ground_drop_scanner.scan`), so a body
    // may be offered its own drops before any structure stands — a log felled at its feet in the first
    // minute is worth the two steps. Armed, room in the pocket, and the executor's despawn-clock timer
    // are what decide worth.
    const { pickBestWeapon } = require('@utils/combat_utils');
    if (pickBestWeapon(bot).rung === 'fist') return { jobs };

    // ── CAPABILITY IS A PRECONDITION, NOT A RANK ────────────────────────────────────────────────────
    // "Can I carry anything" is a precondition, not a priority: with room, the pile goes first, since
    // only the pile has a clock; with no room this posts nothing and the bot does other work, all of
    // which ends in a drop-off, so the pocket empties as a side effect and the pile is offered again on
    // the next sweep.
    // Guarded like every other emptySlotCount read in this file, and it FAILS OPEN: if the count cannot be
    // taken, the pile is still offered. An unreadable inventory is not evidence of a full one, and the
    // expiring job is the wrong one to suppress on a missing measurement (Law 23).
    const freeSlots = bot.inventory && typeof bot.inventory.emptySlotCount === 'function'
      ? bot.inventory.emptySlotCount()
      : null;
    if (freeSlots !== null && freeSlots <= 0) return { jobs };

    const scanner = require('@perception/ground_drop_scanner');
    const { isRefused } = require('@action/ground_salvage_executor');
    const seen = await scanner.scan(bot);
    const offerable = seen.drops.filter((d) => !isRefused(d.id));

    // The DENOMINATOR is on the line whenever anything was seen, and that is the difference between a
    // gate that is working and one that is broken (Law 6/25). "0 offered" alone reads identically for a
    // clean yard, a valuable gate rejecting everything, and a scanner returning nothing at all.
    if (seen.scanned > 0) {
        watcher.summary(TAG, `salvage scan: ${seen.scanned} drop(s) in sight → ${offerable.length} offerable ` +
            `(${seen.rejected.far} beyond ${scanner.SALVAGE_RADIUS}b of this body, ${seen.rejected.worthless} not wanted, ` +
            `${seen.rejected.airborne} off the ground, ${seen.rejected.in_pit} in the waste pit, ${seen.drops.length - offerable.length} already declined)`);
    }
    if (!offerable.length) return { jobs };

    const best = offerable[0];
    jobs.push({
        id: `ground_salvage_${best.id}`, type: 'ground_salvage', what: best.name,
        where: best.pos, drop_id: best.id,
        why: `${best.count}× ${best.name}, ${Math.round(best.distance)}b from this body` +
             `${offerable.length > 1 ? ` (+${offerable.length - 1} more within reach)` : ''}`,
        job_type: JOB_TYPE.ground_salvage,
        claimed_by: null, scope: 'shared',
    });
    return { jobs };
}

module.exports = { name: 'ground_salvage', assess };
