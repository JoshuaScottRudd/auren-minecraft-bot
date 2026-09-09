// assessors/respawn — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
} = require('@thinking/architect_config');
// ── SECTION 4c — Respawn (the planner that acts FIRST) ──
//
// job_board is the planner that controls spawning: battle_stations only checks whether the bot is dead
// and, if so, routes to the judge.
//
// A GATE on the whole board, not one assessment among many, and the sweep below treats it that way: a dead
// bot posts this job and NOTHING else. Every other assessment answers "what work is worth doing" and a
// corpse can do none of it — a mine job posted over a dead body gets claimed, fails, and re-posts until the
// judge kills the bot for five identical outcomes (Law 13).
//
// `where` is null because death_manager owns the recovery point: its tiers need an async site scan and read
// world state that only means anything once there IS a body, and this sweep is synchronous over a corpse
// (Invariant B). The definition of "dead" is IMPORTED from that manager rather than restated, so the planner
// and the thing it dispatches can never disagree about it (Law 16). scope:'local' because no peer can
// respawn this bot's body — the one inherently un-shareable job on the board.
function assess() {
    const bot = global.bot;
    const { isDead } = require('@action/death_manager.js');
    if (!isDead(bot)) return { jobs: [] };
    return {
        jobs: [{
            id: 'respawn_recover', type: 'respawn', what: 'recover',
            where: null,
            job_type: JOB_TYPE.respawn_recover,
            claimed_by: null, scope: 'local',
        }],
    };
}

module.exports = { name: 'respawn', assess };
