// assessors/hunger — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const healthIntegrity = require('@perception/health_integrity');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    HUNGER_FULL,
} = require('@thinking/architect_config');
// ── hunger — the survival job, and the reason it is not simply "eat when hungry" ──────────────────
// TWO-TIER gate: should-eat posts only when food is actually reachable, and only must-eat (the floor)
// posts with an empty pocket. Food is the eat job's material, so this is the same "don't post a job whose
// materials aren't ready" rule assessors/building and assessors/farming follow. Without it a hungry-but-unfed bot
// (farms still growing the first loaf) spins a top-priority survival job it cannot fill and gets
// judge-killed — the two-tier version keeps it WORKING, which is what buys the farms their runway to start
// producing. The availability read is shared with eat_manager's stand-down (Law 16).
function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || typeof bot.food !== 'number') return { jobs };
    const verdict = healthIntegrity.scan(bot);
    if (verdict.needs_to_eat) {
        const { hasAccessibleFood } = require('@action/eat_executor');   // lazy (cycle-safe, matches computeExcess use)
        if (verdict.must_eat || hasAccessibleFood(bot)) {
            jobs.push({
                id: 'eat_food', type: 'health', what: 'food',
                where: null,
                job_type: JOB_TYPE.eat_food,
                claimed_by: null,
                hunger_goal: HUNGER_FULL, hunger_now: verdict.food,
                category: 'health', scope: 'local',
            });
        }
    }
    return { jobs };
}

module.exports = { name: 'hunger', assess };
