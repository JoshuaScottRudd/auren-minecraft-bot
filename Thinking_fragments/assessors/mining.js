// assessors/mining — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const hq = require('@kernel/corporate_headquarters');
const miningCellGraph = require('@perception/mining_cell_graph');
const miningIntegrity = require('@perception/mining_integrity');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
} = require('@thinking/architect_config');
// ── SECTION 1 — Mining (evaluates FIRST, Law 18; no deps on other assessments) ──
function assess() {
    const jobs = [];

    const site        = hq.readBuildingChair('headframe', 'set_buildspot');
    const shaftCenter = site?.build_center || null;

    // No mining job until the staircase site is LOCATED and locked: mining_manager releases every dispatch
    // until then → claim→release loop → judge kill. Post nothing; the 10s idle heartbeat re-checks. Law 16:
    // gate on the SAME predicate mining_manager releases on.
    if (!site?.build_center || !site?.staircase) return { jobs };

    // The tool test lived here and is now `job_gates.toolGate`, which asks the same question of the same
    // predicate for every job that needs rock — a mining verb and a stone supply order alike. It moved
    // because a silent early return and a reported gate are not the same act: held here the job was never
    // built, so nothing on the board could say a pickaxe was what the fleet waited on, and a bot holding no
    // work looked identical to a bot correctly waiting (Invariant C, Law 6).
    //
    // Its old note argued for keeping this copy because "a rank is a number anyone may renumber". That
    // reasoning is spent: the tie it insured against was array position inside the `bot` band, and the gate
    // holds the job however anything is ordered — a stronger guarantee than the ordering it was insuring.

    // Light gate — mining_manager's THIRD release predicate, held here for the same reason as the tool
    // gate above: the board and the manager must agree on "may this bot mine" or the job claims and
    // releases until the judge kills it. Placed before BOTH job pushes on purpose, so shaft and cell
    // are covered by one test (Architect 2026-08-27: "we are law 16 the whole mining system").
    // STILL SILENT (Law 5, ~1s heartbeat): the missing torches are already legible as the posted supply
    // job one rung up. It is the last "may this bot mine" test outside job_gates, kept here only because
    // moving it is a separate decision from moving the tool test — it reads a stock row rather than the
    // pocket, so the gate would have to carry the row lookup with it.
    const { hasMiningLight } = require('@action/mining_manager.js');   // lazy (cycle-safe)
    if (!hasMiningLight(global.bot).ok) return { jobs };

    // Site is guaranteed present past the gate above, so scan integrity directly (no re-guard).
    let shaftComplete = false;
    let maintenanceNeeded = false;
    const bot = global.bot;
    // NO GUARD ON AN INTEGRITY SCAN, HERE OR ANYWHERE BELOW IN THIS FILE. The nodes are ours and each
    // absorbs its own environmental failures; a throw escaping one is a defect. Catching it here left the
    // verdict at its declared default — shaft not excavated, no maintenance, no farm work, no hunger —
    // and the board then posted a DIFFERENT and entirely plausible set of jobs for the rest of the run
    // (Law 13 default-stopped; Law 25: a default is not a measurement).
    if (bot && bot.blockAt) {
        const integrity = miningIntegrity.scan(bot);
        // shaft_excavated (NOT damage-gated) drives the cell-mining switch — cobble flows during
        // repairs. maintenance_needed = finished segment damaged (permanent, like building_integrity).
        shaftComplete = !!integrity.shaft_excavated;
        maintenanceNeeded = !!integrity.maintenance_needed;
    }

    // ── ONE WAY TO MINE, TWO SEQUENTIAL PHASES — `shaftComplete` picks the phase at POSTING; no downstream
    // arbiter (Law 16: delete the second route, don't guard it). The collision replaced: dig_shaft +
    // separate mine_<item> both dispatch mining_executor, which asks mining_integrity for ONE
    // `first_incomplete` — two jobs could dig the same rock past the id interlock, because first_incomplete
    // has no way to know two callers exist at once. mine_<item> is gone; the shaft's yield feeds the pull
    // list via the executor's deficiency check.
    // scope:'shared' = one owner — only ONE frontier segment ever exists; a second bot takes surface work.
    // The cell phase below is 'local' on purpose.
    if (!shaftComplete || maintenanceNeeded) {
        jobs.push({
            id: 'mine_dig_shaft', type: 'mine', what: 'dig_shaft',
            where: shaftCenter,
            job_type: JOB_TYPE.mining_dig_shaft,
            claimed_by: null, scope: 'shared',
        });
    }

    if (shaftComplete) {
        // Shaft done → fractal-cell strip mining. mine_material would loop on no_work (no segments left);
        // post dig_cell gated on a buildable cell. Ore needs met as byproduct.
        let buildable = false;
        if (bot && bot.blockAt) buildable = miningCellGraph.hasBuildableCell(bot);
        if (buildable) {
            // scope:'local' — UNLIKE the shaft: many buildable cells at once, so every bot claims
            // dig_cell concurrently and mining_manager fans them onto DIFFERENT cells. The fleet-wide
            // `cell:<id>` lock (overseer-arbitrated; selection skips heldByPeer) gives each cell one
            // owner. 'shared' capped the field at one miner and left the fan-out dormant. Law 4: one
            // cell per bot, one bot per cell — the cell lock, not the job magnet, is the exclusivity.
            jobs.push({
                id: 'mine_dig_cell', type: 'mine', what: 'dig_cell',
                where: shaftCenter,
                job_type: JOB_TYPE.mining_dig_cell,
                claimed_by: null, scope: 'local',
            });
        }
    }
    // NO `mine_<item>` JOB — it was the second route that collided with dig_shaft on `first_incomplete`.
    // The need still STEERS mining without posting it: the board writes the merged shortfall to
    // job_board_room.materials_needed_pull, and mining_executor reads it there for deficiencyMet and
    // its surface-early test. Descent: dig_shaft yields it; after: dig_cell. Do NOT re-add a material
    // job "to make sure the ore arrives" — that rebuilds the second route.
    //
    // AND THIS ASSESSOR CONTRIBUTES NOTHING TO THAT PULL, which is the non-obvious half. It used to read
    // materials_needed_pull back out of the conference room and return it, unused. Feeding that echo
    // into the board's merge is the wrong repair, and it is the one a reader reaches for: the merge takes
    // a Math.max, so a value that re-enters through its own reader can never fall — the pull would latch
    // at its high-water mark and the executor would stop surfacing. The pull is written by the assessors
    // that measure a shortfall; the miner is the party that ACTS on it, and a consumer that also feeds
    // the thing it consumes is a second route into it (Law 16).

    return { jobs };
}

module.exports = { name: 'mining', assess };
