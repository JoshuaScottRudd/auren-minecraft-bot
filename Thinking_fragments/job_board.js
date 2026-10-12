// job_board — one-pass world evaluation into a ranked job list; the dispatcher picks the lowest unmet need.
// Chain: recursive_judge → job_board → dispatcher → manager.
//
// Owns everything true of the board as a whole, not of one assessment: the dead-bot gate, the
// sweep over every assessor (its own file under `assessors/`, listed in assessor_registry's two
// counter-directional orders — Law 18), the pull-list merge, the gates (job_gates), the rank composed
// after gating (job_ranking), the display sort, and the board/held/census reports.
//
// An assessor declares only its `job_type`; job_ranking decides band and rung from the whole sweep, which
// no single assessor can see (Invariant D). Adding a job costs one file and one line in each order.

'use strict';

const watcher          = require('@kernel/watcher');
const hq               = require('@kernel/corporate_headquarters');
const { getBotInventory } = require('@utils/fragment_utils');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { requirementTree } = require('@utils/calculators/build_material_calculator');
const { routeSignal } = require('@utils/signal_utils');
const stationRegistry  = require('@perception/station_registry');
const { applyGates } = require('@thinking/job_gates');
const jobRanking = require('@thinking/job_ranking');
// The board advertises capacity; the dispatcher enforces it, both off this one table (Law 16).
const yieldPledge = require('@utils/calculators/yield_pledge_calculator');
const inventoryLens = require('@kernel/inventory_lens');
const foremanLink = require('@kernel/foreman_link');
const registry = require('@thinking/assessor_registry');
const jobExclusions = require('@thinking/job_exclusions');

// A sweep whose assessors took this long together reports which of them took it.
const SWEEP_SLOW_MS = 1000;
const { TAG } = require('@thinking/assessors/shared');

// The same crew-selected rows drive acquisition, retention and stock reporting.
const requestedWork = require('@thinking/requested_work');

// dumpExcess reads INVENTORY_WHITELIST [{item, dump_threshold}], derived from the assessors' own gate
// table (fragment_utils, Law 16).
// A TOOL FAMILY KEEPS ITS OWN NUMBER, BEST TIER FIRST. A tool takes a whole pocket slot, so each family's
// row (pickaxe, axe, shovel, sword) is the count a body carries and the rest goes back to the shelf;
// `keep_order` lists the family best tier first, so the ones banked are the worst. The 'tools' row after
// them is the allowance for every tool no family row names.
const { group_to_item: _families } = require('@utils/fragment_utils');
function inventoryWhitelist() {
    return requestedWork.activeStockRows()
        .filter(s => s.holder === 'bot')
        // Family allowances consume their own tools before the general tool allowance.
        .sort((a, b) => Number(a.item === 'tools') - Number(b.item === 'tools'))
        .map(s => (s.kind === 'tool'
            ? { item: s.item, dump_threshold: s.dump_threshold, keep_order: [..._families[s.item]].reverse() }
            : { item: s.item, dump_threshold: s.dump_threshold }));
}

// ── Inventory helper ──
function _readInventory() {
    const raw    = getBotInventory();
    const totals = {};
    for (const [name, count] of Object.entries(raw)) {
        const norm = name.replace('minecraft:', '').toLowerCase().trim();
        totals[norm] = (totals[norm] || 0) + count;
    }
    return totals;
}

// Offloading material is a step that ends the work which produced it — harvest/craft/salvage executors or
// mining_manager's _exitMine — never a job competing for the bot (Law 16). Composting is a job
// (assessors/compost): the banked batch is emptied into the bin by one body.

// `built` is recomputed every sweep; only its CHANGES are written (false→true is BUILT, true→false is
// damage). A structure already standing at the first sweep is written as found standing, never timed.
// Last sweep's verdicts are kept only to find that edge (Law 5).
let _builtLastSweep = null;
let _excludedLastSweep = null;
function _announceBuiltChanges(built, excludedNames) {
  for (const [name, isBuilt] of Object.entries(built)) {
    const was = _builtLastSweep ? _builtLastSweep[name] : undefined;
    if (was === undefined && isBuilt) watcher.summary(TAG, `🏠 STRUCTURE STANDING AT FIRST SWEEP: '${name}' — found built, not timed`);
    else if (was === false && isBuilt) watcher.summary(TAG, `🏁 STRUCTURE BUILT: '${name}'`);
    // A structure also re-opens when its exclusion list SHRINKS (material once unreachable becomes
    // reachable) — that is not damage. Told apart by the list, not the count: fewer exclusions than last
    // sweep means the world got richer; anything else is real damage (Law 25).
    else if (was === true && !isBuilt) {
        const lifted = (_excludedLastSweep || []).filter(t => !excludedNames.includes(t));
        if (lifted.length) watcher.summary(TAG, `🔓 STRUCTURE RE-OPENED: '${name}' — ${lifted.join(', ')} `
            + `became reachable, so voxels the board was excluding are required work again; it is not damaged`);
        else watcher.warn(TAG, `STRUCTURE UN-BUILT: '${name}' — damaged; structures waiting on it are held again`);
    }
  }
  _builtLastSweep = { ...built };
  _excludedLastSweep = excludedNames;
}

// Assessments run in the registry's evaluate order, which is not the order the board prints in — the
// sort at the end is for the reader (Law 18); both orders live in assessor_registry.
async function _sweep() {
    const pace = require('@utils/execution_yield').makeExecutionPacer();
    let inventory = _readInventory();

    const botId = process.env.BOT_ID || 'default';
    const _bot = global.bot;
    const _pos = _bot?.entity?.position;
    const now = new Date().toISOString();

    const boardroom = hq.readBoardroomChair(botId, {});
    boardroom.inventory = inventory;
    boardroom.inventory_at = now;
    // Position posted alongside inventory so a reader of the chair sees where the bot was.
    if (_pos) {
        boardroom.position = { x: _pos.x, y: _pos.y, z: _pos.z };
        boardroom.position_at = now;
    }
    // Request progress travels the boardroom chair, not a second sync: only the body holds the owner key
    // to measure it (Law 16). Carries its own timestamp (Invariant B); empty for a homesteader.
    const _progress = require('@thinking/requested_work').requestProgress();
    if (_progress.length > 0) {
        boardroom.request_progress = _progress;
        boardroom.request_progress_at = now;
    } else {
        delete boardroom.request_progress;
        delete boardroom.request_progress_at;
    }
    // Read by any supervisor off the chair, not a lens matching the ☠️ line below out of a live
    // trace file (Law 16). Written every sweep, not only when true — a flag only ever set would report a
    // bot dead for the rest of its window after it recovered (Invariant B).
    boardroom.dead = require('@kernel/body_recovery').isDead(global.bot);
    if (boardroom.dead) boardroom.dead_at = boardroom.dead_at || now;
    else delete boardroom.dead_at;
    // Which structures this body read as built on its last sweep, for the foreman to read off the chair.
    boardroom.built = _builtLastSweep || {};
    boardroom.cubes_finished = require('./assessors/downloaded_build').finishedCount();
    hq.writeBoardroomChair(botId, boardroom);


    // Dead-bot short circuit, ahead of every assessment: returns before anything is assessed, since the
    // assessments below scan integrity, the station registry and biomes through `global.bot`, all
    // meaningless against a corpse (Law 25). The registry's own gate, not an entry in either order.
    const gate = registry.GATE.assess({ inventory });
    if (gate.jobs.length) {
        // Ranked through the same orderSweep every other job uses, so its band comes from the one place
        // a band is decided (Law 16).
        hq.writeConfRoomFlag('job_board_room', 'jobs', jobRanking.orderSweep(gate.jobs));
        watcher.warn(TAG, '☠️ Bot is DEAD — the board holds ONE job (respawn_recover) and nothing else. Every other job needs a body to do it with.');
        await hq.flushNow();
        return gate.jobs;
    }

    // Drop dead station entries before assessments read them — a stale chest must not credit supply.
    stationRegistry.verifyAgainstWorld(global.bot);

    // Every assessor runs once, in the evaluate order, keyed by module, not name (Law 16). The
    // building layer's claim is dynamic and travels forward through that order, so each assessor sees
    // exactly the claims evaluated before it (Law 18), passed, not published, to stay fresh
    // (Invariant B).

    // What the fleet cannot get right now, decided once before anything is assessed; every entry carries
    // its own reason (job_exclusions' header), computed before the sweep since the assessors judge
    // "complete" against the same list the executors build against.
    const excluded = jobExclusions.current();

    const results = new Map();
    const buildClaim = {};
    const built = {};
    // What each assessor's turn took, so a slow sweep names the assessor that made it slow.
    const took = [];
    for (const assessor of registry.EVALUATE_ORDER) {
        await pace();
        inventory = _readInventory();
        const startedAt = Date.now();
        const result = await assessor.assess({ inventory, buildClaim, excluded });
        took.push({ name: assessor.name, ms: Date.now() - startedAt });
        results.set(assessor, result);
        // Two assessors reporting one structure differently is a wiring fault, not a tie to break.
        for (const [name, isBuilt] of Object.entries(result.built || {})) {
            if (name in built && built[name] !== (isBuilt === true)) {
                throw new Error(`[${TAG}] CODING VIOLATION (Law 13): two assessors disagree whether '${name}' is built.`);
            }
            built[name] = isBuilt === true;
        }
        for (const [item, count] of Object.entries(result.buildClaim || {})) {
            buildClaim[item] = (buildClaim[item] || 0) + count;
        }
    }
    const sweepMs = took.reduce((sum, t) => sum + t.ms, 0);
    if (sweepMs >= SWEEP_SLOW_MS) {
        took.sort((a, b) => b.ms - a.ms);
        watcher.summary(TAG, `SWEEP_TIMES total_ms=${sweepMs} slowest=${took.slice(0, 4).map(t => `${t.name}:${t.ms}`).join(',')}`);
    }
    _announceBuiltChanges(built, jobExclusions.names(excluded));

    // Law 18: assemble order runs most-urgent → most-stable, hunger leading (Law 17). It decides nothing
    // about what is claimed (band and rung do that); it decides what a reader sees first among equals.
    const assembled = registry.ASSEMBLE_ORDER.flatMap(assessor => results.get(assessor).jobs);

    // The gates: one pass over the assembled list, the only place a built job is refused (job_gates).
    // Pull list merged first, from every assessor: a gate that finds an underground shortfall writes
    // here so the descent knows what the surface work was waiting for.
    const mergedPull = {};
    // Every pull entry beside the order that asked for it ({ item, need, job_type, structure }): the tunnel
    // has no rank of its own, so each seat is placed where its asker stands (assessors/mining, job_ranking).
    const pullAskers = [];
    for (const assessor of registry.EVALUATE_ORDER) {
        const result = results.get(assessor);

        for (const [item, count] of Object.entries(result.pullNeeded || {})) {
            mergedPull[item] = Math.max(mergedPull[item] || 0, count);
            if (!(count > 0)) continue;
            if (!result.pullAsker || !result.pullAsker.job_type) {
                throw new Error(`[${TAG}] CODING VIOLATION (Law 13): assessor '${assessor.name}' pulls ${item} from the mine `
                    + 'and names no pullAsker { job_type, structure } — a tunnel seat has no position without one.');
            }
            pullAskers.push({ item, need: count, job_type: result.pullAsker.job_type, structure: result.pullAsker.structure || null });
        }
    }

    // Excluded list stamped onto every job (posted and held) before the gates see it: a job carries the
    // world it was posted against, the same guard `stone_is_mined` and `stations_at_claim` use at claim
    // time. Changes land on the next sweep.
    for (const job of assembled) job.excluded = excluded;

    const { posted, held } = applyGates(assembled, {
        inventory,
        allStations: stationRegistry.getStations(),
        pullNeeded: mergedPull,
        pullAskers,
        built,
    });

    // Rank composed here, after the gates, and only here: an assessor declares only `job_type`; band and
    // rung (job_ranking) need the whole sweep, which no single assessor has (Invariant D). For the
    // reader, not the dispatcher — it asks job_ranking.selectBand for the group of equals and picks at
    // random, so this display sort cannot become policy by being read as one (Law 16).
    const allJobs = jobRanking.orderSweep(posted).sort(jobRanking.compareForDisplay);

    // Held jobs reported per gate, grouped by cause: a merged "held" line would hide what releases each
    // one (a night-held job clears at dawn, a material-held one when stock lands — Law 6).
    if (held.length) {
        const byGate = new Map();
        for (const h of held) {
            if (!byGate.has(h.gate)) byGate.set(h.gate, new Map());
            const byWhy = byGate.get(h.gate);
            if (!byWhy.has(h.why)) byWhy.set(h.why, []);
            byWhy.get(h.why).push(h.detail ? `${h.job.id ?? h.job.what} [${h.detail}]` : `${h.job.id ?? h.job.what}`);
        }
        for (const [gate, byWhy] of byGate) {
            const count = [...byWhy.values()].reduce((n, list) => n + list.length, 0);
            const body = [...byWhy].map(([why, names]) => `${why} → ${names.join(', ')}`).join(' · ');
            // 🚧, never ⛔ — ⛔ is this fleet's kill/halt mark; a gate is work becoming postable, not a
            // failure (Law 5, Law 25).
            watcher.summary(TAG, `🚧 GATED ${gate} (${count}): ${body}`);
        }
    }

    // Materials wanted: gross demand from every live order including held, at every level of its recipe.
    // Gross, not net — each consumer nets it itself (Law 25). Published to the chair since production is
    // sized to the whole fleet and each bot's chair sums with its peers' (Invariant D). The dumper reads
    // the opposite figure on purpose (`heldOrderDemand`): whoever empties a shared furnace banks the rest.
    // An order whose asker already took the fleet's stock off its figure says so (`net_of_pool`), and its
    // tokens are published a second time as owed in full: a producer that netted stock again would make
    // less than the asker is waiting on.
    const wanted = {};
    const wantedNet = {};
    for (const job of [...allJobs, ...held.map(h => h.job)]) {
        if (job.type !== 'supply' || !(job.need > 0) || !job.what) continue;
        for (const [item, count] of Object.entries(requirementTree(job.what, job.need, {}))) {
            wanted[item] = (wanted[item] || 0) + count;
            if (job.net_of_pool) wantedNet[item] = (wantedNet[item] || 0) + count;
        }
    }
    // The mining pull is demand too: a building waiting on iron ingots asks the mine for the ore AND the
    // furnace for the smelt, so raw iron banked from a trip is cooked for the building that is waiting on it.
    for (const [item, count] of Object.entries(mergedPull)) {
        if (!(count > 0)) continue;
        for (const [part, n] of Object.entries(requirementTree(item, count, {}))) {
            wanted[part] = (wanted[part] || 0) + n;
        }
    }
    boardroom.materials_wanted = wanted;
    boardroom.materials_wanted_net = wantedNet;
    boardroom.materials_wanted_at = now;
    hq.writeBoardroomChair(botId, boardroom);
    foremanLink.sendUpdate();

    // Unguarded: hq is ours, and a warn-and-continue here would publish a summary no consumer received.
    hq.writeConfRoomFlag('job_board_room', 'jobs', allJobs);
    hq.writeConfRoomFlag('job_board_room', 'materials_needed_pull', mergedPull);
    hq.writeConfRoomFlag('job_board_room', 'materials_needed_pull_askers', pullAskers);
    // Published as evidence, not a route — inspectable after the fact (Law 6); nothing reads this to act.
    hq.writeConfRoomFlag('job_board_room', 'excluded_items', excluded);

    // What the gates held, published, not only printed to the console (Law 25, Law 6) — the same
    // `held` the console report used (Law 16), grouped by gate then cause.
    const heldByGate = {};
    for (const h of held) {
        const byWhy = heldByGate[h.gate] || (heldByGate[h.gate] = {});
        const row = byWhy[h.why] || (byWhy[h.why] = { count: 0, short_of: [] });
        row.count += 1;
        for (const item of h.shortOf || []) if (!row.short_of.includes(item)) row.short_of.push(item);
    }
    hq.writeConfRoomFlag('job_board_room', 'jobs_held', {
        count: held.length,
        by_gate: heldByGate,
        at: now,
    });

    if (allJobs.length > 0) {
        const jobSummaries = allJobs.map(j => {
            // `need` first: the figure the posting gate judged, so this line and the gate's hold-back
            // line quote the same number.
            const qty = j.need ?? j.hold_goal ?? j.batch_quantity;
            const detail = qty != null ? `(need:${qty})` : '';
            const dest = j.destination ? `→${j.destination}` : '';
            const tier = j.tier ? `[${j.tier}]` : '';
            // A dynamic build-order shares type/what with the standing STOCK restock — tagged so the two
            // are distinguishable (Law 6).
            const dyn = (typeof j.id === 'string' && (j.id.startsWith('build_chest_') || j.id.startsWith('build_supply_')))
                ? ' ⟨build-order⟩' : '';
            // `why` carries the sensed numbers that tripped the assessment (a slot count, a fill level) —
            // the only place they still exist once the sweep ends (Law 6).
            const why = j.why ? ` {${j.why}}` : '';
            // Rank printed as its coordinates (who is waiting, how far from done), never its bare integer
            // — a measured rank has no lookup table to explain a number (Law 6).
            // Seats: how many bodies this row can hold, from yield_pledge_calculator.seatsFor — the same
            // table and division the dispatcher admits bodies by (Law 16). `null` means per body, no
            // total to divide, so the word prints instead of a number.
            const seats = yieldPledge.seatsFor(j);
            return `[${jobRanking.describeBand(j)}] ${j.type}/${j.what}${tier}${dest ? ' ' + dest : ''}${detail ? ' ' + detail : ''} (seats:${seats === null ? 'per_body' : seats})${why}${dyn}`;
        });
        // Both totals under their own name (Law 7): `job(s)` is distinct pieces of work, `seat(s)` how
        // many bodies could be working this instant. Per-body rows are counted separately, not folded
        // into the seat total, since they are a different kind of capacity.
        const shared = allJobs.map(j => yieldPledge.seatsFor(j));
        const seatTotal = shared.reduce((t, s) => t + (s === null ? 0 : s), 0);
        const perBody = shared.filter(s => s === null).length;
        watcher.summary(TAG, `──── JOB BOARD: ${allJobs.length} job(s), ${seatTotal} seat(s)`
            + `${perBody ? `, ${perBody} per_body row(s)` : ''} ────`);
        watcher.summary(TAG, jobSummaries.join(' | '));
    } else {
        watcher.summary(TAG, 'No jobs posted — system idle.');
    }

    // Storage thresholds: a peer-locked chest counts like any other (wait-to-act lives in
    // inventory_swapper) and carries a 🔒 tag. One pool, one figure, no address — a `storage` row is a
    // request against the whole chest system, so what prints is the count of chests summed over.
    const summaryParts = [];
    const allStations = stationRegistry.getStations();
    const chestEntries = Object.values(allStations).filter(stationRegistry.isStorage);
    const lockedChests = chestEntries.filter(e => e.locked_by).length;
    for (const stock of requestedWork.activeStockRows()) {
        if (stock.deficit_below == null || stock.holder !== 'storage') continue;
        // Fleet-wide, the same figure the gate judged (Law 25).
        const fleetCount = inventoryLens.forChestRequest(stock.item, buildClaim);
        const status = fleetCount >= stock.deficit_below ? '✓' : `⚠ below ${stock.deficit_below}`;
        const lockTag = lockedChests ? ` 🔒${lockedChests} in use` : '';
        summaryParts.push(`storage ${stock.item}:${fleetCount}/${stock.deficit_below} ${status} `
            + (chestEntries.length
                ? `(across ${chestEntries.length} chest(s))${lockTag}`
                : '(no chest registered yet — nowhere to bank it)'));
    }
    // No inventory line here — a pocket is held in the foreman's item book (js_kernel/item_book.js, Law 16).
    //
    // This stock line restates every threshold row every sweep, so it carries its own stage name in
    // watcher's ROUTINE_QUIET table, separate from 🚧 GATED which two lenses still read. `AUREN_VERBOSE=
    // job_board_stock` restores it for one run.
    if (summaryParts.length > 0) {
        watcher.summary('job_board_stock', `📊 ${summaryParts.join(' | ')}`);
    }

    // Station census (every chest/furnace's contents) — the registry reports its own state.
    stationRegistry.logContents();

    await hq.flushNow();
    return allJobs;
}

// ── Singleton export ──
module.exports = {
    // The plan phase (this sweep → dispatcher's magnet claim → HQ sync) runs under the foreman's planning
    // token: exactly one bot plans at a time, so every sweep sees every peer's fresh magnet. Acquired
    // here (parks until granted — FIFO, seniority-tiebroken); released by the dispatcher after it has
    // synced its magnet, never before.
    async receive(signalType, payload) {
        const foremanLink = require('@kernel/foreman_link');
        await foremanLink.acquirePlanningToken();
        // The token is handed on to the dispatcher, which releases it. A sweep that throws never reaches
        // the dispatcher, so the token is released here on that path alone and the throw travels on.
        let swept = false;
        await require('@utils/external_library_guard').withCleanup(
            TAG, 'job board sweep',
            async () => { await _sweep(); swept = true; },
            () => { if (!swept) foremanLink.releasePlanningToken(); });
        routeSignal(TAG, 'dispatcher', {});
    },
    get INVENTORY_WHITELIST() { return inventoryWhitelist(); },
};
