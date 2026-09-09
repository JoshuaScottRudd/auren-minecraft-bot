// job_board — the brain: one-pass world evaluation → ranked job list; dispatcher picks lowest unmet need.
// Chain: recursive_judge → job_board → dispatcher → manager.
//
// WHAT THIS FILE IS, NOW THAT THE ASSESSMENTS HAVE LEFT IT. It ran thirteen assessments and the sweep
// around them, in one place, at 1492 lines. The assessments are the half that GROWS — a new kind of work
// is a new assessment — and the sweep is the half that does not, so the split is along the axis that
// actually moves. Each assessment is now its own file under `assessors/`, carrying its own commentary
// beside its own code; `assessor_registry` is the manifest and owns the two orders. What is left here is
// everything that is true of the board as a whole and of no single assessment:
//
//   the dead-bot gate   a corpse is offered one job and no others
//   the sweep           run every assessor, once, in the evaluate order
//   the pull merge      one underground shortfall list out of every assessor that produces one
//   the gates           the ONE place a built job is refused (job_gates)
//   the ranking         what each surviving job is WORTH against the rest of the sweep (job_ranking)
//   the sort            rank order, which is authoritative over the assemble order
//   the report          the board line, the held-jobs report, the chest census
//
// RANKING IS THE BOARD'S, AND IT USED NOT TO BE. Each assessor wrote a rank onto its own job out of a
// hand-authored table, which made every assessor a co-author of fleet-wide scheduling policy while
// holding only its own corner of the world. An assessor knows what the work IS; only the board sees what
// else was offered in the same sweep, which is the entire content of "which job wins the bot". So an
// assessor now declares a `job_type` and nothing more, and job_ranking answers the rest (Invariant D —
// one owner per decision). This is also why adding a job still costs a file and a line: the new file
// names its kind of work, and nothing here or in any other assessor changes.
//
// ADDING A JOB IS NOW A FILE AND A LINE: write `assessors/<name>.js` exporting { name, assess }, then
// name it in assessor_registry's two orders. Nothing in THIS file changes. That was the point — the old
// sweep hand-maintained three lists that had to agree (the thirteen calls, the assembled spread, and the
// pull merge naming three assessors individually), and a job added to two of the three was a job that
// ran every sweep and was silently discarded.
//
// Law 18 drives the two orders and they are counter-directional: assessments EVALUATE stable→urgent,
// jobs DISPATCH urgent→stable. Both live in assessor_registry with the argument for each.

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
const inventoryLens = require('@kernel/inventory_lens');
const overseerLink = require('@kernel/overseer_link');
const registry = require('@thinking/assessor_registry');
const { TAG } = require('@thinking/assessors/shared');

// Architect-owned tunables (Law 16 — one source): import raw tables, derive views, never redefine a table.
const { STOCK_THRESHOLDS } = require('@thinking/architect_config');

// UNDERGROUND_ITEMS (fragment_utils, Law 16): the assessors' own gates. One downstream view survives:
// dumpExcess reads INVENTORY_WHITELIST [{item, dump_threshold}]. Tool families excluded — the single
// 'tools' threshold governs dumping; listing members would double-count and dump a spare tool.
//
// RESOURCE_REQUIREMENTS IS DELETED with the chest roles it fed. It projected the chest rows into
// [{blueprint, chest, type}] for `determineChestRole`, which stamped each chest a bot placed as either
// a requester or a buffer. There are no roles now — a request is a fleet-wide figure filled from any
// chest, and surplus is dumped into any chest — so there is nothing to assign and no table to assign it
// from. Do not rebuild it to "route deliveries": with one chest on the base's first anchor there is
// nothing to route between, and the pool measurement already ignored the address.
const INVENTORY_WHITELIST = STOCK_THRESHOLDS
    .filter(s => s.holder === 'bot' && s.kind !== 'tool')
    .map(s => ({ item: s.item, dump_threshold: s.dump_threshold }));

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

// ── SECTION 4.5 — DELETED. There is no inventory-dump JOB any more. ──
//
// The problem: inventory dump was ranked high so material wouldn't be lost, but a high-ranked job that
// preempts other work does so at the wrong moments. The fix is to make offloading a STEP inside the work
// that produces material — often enough to never need its own competing job — rather than a job.
//
// Offloading is now a STEP that ends the work which produced the material, never a job competing for the
// bot. Four seats own it, one per producing verb: harvest_executor after every gather, craft_executor
// after every craft, ground_salvage_executor after every pile, and mining_manager's _exitMine at the end
// of a batch (which now runs up to MINING_PASSES_PER_DISPATCH different cells per descent, so the trip
// ends at the chests often enough to make a separate job pointless).
//
// WHY THE JOB HAD TO GO RATHER THAN JUST DROP IN RANK: a job can preempt, and the whole failure was that
// it did. It outranked every supply job, so the moment a bot withdrew a material the board handed it a
// dump for the thing it had just fetched. Ranking it lower only moves which jobs it can steal from. A
// step cannot preempt anything — it runs inside the work that created the material, which is the property
// the rank could never buy.
//
// Deleted with it: _hasDumpableExcess, _nearestBufferDistance, _assessInventory, the idle-dump latch,
// dump_executor, and the INVENTORY_DUMP_* distance ramp in architect_config — all of them existed only to
// decide WHEN a trip was worth making, and a step that rides an already-required trip never asks.

// ── SECTION 4.95 — Composting posts NOTHING, and that is the whole design ──
// Compost items go directly into the bin now; filling and emptying the compost bin is part of inventory
// swapping, so collecting compost is part of the executor that uses the compost bin, not a separate job.
//
// Both halves were errands and both are gone. The composter carries no standing order — dumpExcess feeds it from
// the pocket — and it is not a chore either: the same visit that fills it empties it, because the bot is
// already standing at the block holding the lock. `compost_load`, `compost_collect`, `compost_manager` and
// `COMPOST_MIN_INPUT` all died with those routes (Law 16).
//
// DO NOT REINTRODUCE A COLLECT JOB when a bin is found sitting at a fillable level. That was tried: ranked
// at the bottom (it is waste disposal, so it can never preempt work) it posted and sat unclaimed for the
// length of a whole night while both bots ran at near-full occupancy on other work. An errand that must
// compete for a bot will always lose; the fix was to stop needing one, not to re-rank it. The bin waits for
// the next dump, which the fleet does constantly. See compost_executor's header.

// ── THE MAIN SWEEP ──
// Assessments run in the registry's EVALUATE order, which is not the order the board prints in — the
// sort at the end is for the READER, and reordering the assessors to "match" it would silently break the
// phasing (Law 18). Both orders, and the argument for each, live in assessor_registry.
function _sweep() {
    const inventory = _readInventory();

    const botId = process.env.BOT_ID || 'default';
    const _bot = global.bot;
    const _pos = _bot?.entity?.position;
    const now = new Date().toISOString();

    const boardroom = hq.readBoardroomChair(botId, {});
    boardroom.inventory = inventory;
    boardroom.inventory_at = now;
    // Post position alongside inventory (same sweep, same boardroom area) so a peer or the
    // Architect reading the chair sees where the bot was when it last reported its goods.
    if (_pos) {
        boardroom.position = { x: _pos.x, y: _pos.y, z: _pos.z };
        boardroom.position_at = now;
    }
    // HOW FAR THIS CREW'S STANDING REQUESTS HAVE GOT, posted for the same reason and by the same route as
    // the inventory beside it: a body is the only party that can measure them (it alone holds the owner
    // key that says which chests are its own), and the chair is already the channel by which everything a
    // body knows reaches the overseer and the people reading it. A second sync for one more fact would be
    // the parallel route Law 16 exists to refuse.
    //
    // It carries its own timestamp because it is a MEASUREMENT rather than a stored target: whoever speaks
    // it to a human must be able to say how old it is, and a figure quoted without its age is the stale
    // read this whole design removed (Invariant B).
    //
    // Empty for a homesteader without a branch here — no human can file a request against the commons key,
    // so its ledger is empty and this costs one read. Naming the species instead would be a second place
    // that knows the difference, and the difference already lives in requested_work.
    const _progress = require('@thinking/requested_work').requestProgress();
    if (_progress.length > 0) {
        boardroom.request_progress = _progress;
        boardroom.request_progress_at = now;
    } else {
        delete boardroom.request_progress;
        delete boardroom.request_progress_at;
    }
    hq.writeBoardroomChair(botId, boardroom);

    const invList = Object.entries(inventory)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}:${count}`)
        .join(', ');
    const _posStr = _pos ? `(${Math.floor(_pos.x)},${Math.floor(_pos.y)},${Math.floor(_pos.z)})` : '(?,?,?)';
    watcher.summary(TAG, `🎒 ${botId} at ${_posStr} inventory: ${invList || 'empty'}`);

    // ── THE DEAD-BOT SHORT CIRCUIT, ahead of every other assessment ──────────────────────────────────
    // Returns before anything else is even ASSESSED, not merely before it is posted. The assessments
    // below scan integrity, walk the station registry and read biomes — all through `global.bot`, all
    // meaningless against a corpse, and several of them log a verdict while they do it. A board that
    // reports "no jobs — system idle" for a dead bot is reporting a world it never looked at (Law 25).
    //
    // IT IS THE REGISTRY'S GATE AND NOT AN ENTRY IN EITHER ORDER, which is what keeps this readable as a
    // gate rather than as one assessment that happens to be called early. The registry throws at load if
    // respawn ever appears among the ordinary assessors.
    const gate = registry.GATE.assess({ inventory });
    if (gate.jobs.length) {
        // STAMPED BY THE SAME SWEEP AS EVERY OTHER JOB, and skipping it is what made a dead bot stay
        // dead. A job's BAND is what the dispatcher's species magnet reads; `orderSweep` is the one
        // place a band is decided (Law 16), so a job posted around it reaches the magnet carrying
        // `undefined` — which is in no species' filter. The board then held exactly one job, the
        // dispatcher passed over it as unclaimable, and the corpse idled: a bot reporting "nothing here
        // I may claim" about the only work it had (Law 25). The stamper also owns the Law 13 throw for
        // an unrankable job, so a path around it loses the check as well as the field.
        hq.writeConfRoomFlag('job_board_room', 'jobs', jobRanking.orderSweep(gate.jobs));
        watcher.warn(TAG, '☠️ Bot is DEAD — the board holds ONE job (respawn_recover) and nothing else. Every other job needs a body to do it with.');
        hq.flushNow();
        return gate.jobs;
    }

    // Drop dead station entries BEFORE assessments read them (a stale chest must not credit
    // supply). The registry owns this — it mutates its own state; the brain only reads it.
    stationRegistry.verifyAgainstWorld(global.bot);

    // ── THE SWEEP ────────────────────────────────────────────────────────────────────────────────────
    // Every assessor, once, in the evaluate order, with its result kept against the module that produced
    // it. Keyed by the MODULE and not by its name because the assemble order is a list of modules too —
    // a name lookup would add a second way for the two orders to disagree, which is the fault the
    // registry's own checks exist to remove (Law 16).
    //
    // THE CLAIM TRAVELS FORWARD, AND THE EVALUATE ORDER IS WHAT MAKES THAT LEGAL. The material layers
    // (bot → building → storage) separate by subtraction: each counts everything less the claims
    // of the layers beneath it. The bot's claim is declared in config and inventory_lens reads it
    // directly; the building layer's is DYNAMIC — recomputed here every sweep — so it has to travel from
    // the assessor that measures it to the ones that must not count it. Accumulated as the sweep runs
    // rather than gathered afterwards, so an assessor sees exactly the claims of everything evaluated
    // before it and nothing evaluated after (Law 18: a planner that acts last announces first — this is
    // the announcement, and the evaluate order is the phasing).
    // Passed rather than published: a chair would make it remembered state read a sweep late, and the
    // one number that must be fresh is the one everything above it subtracts (Invariant B).
    const results = new Map();
    const buildClaim = {};
    for (const assessor of registry.EVALUATE_ORDER) {
        const result = assessor.assess({ inventory, buildClaim });
        results.set(assessor, result);
        for (const [item, count] of Object.entries(result.buildClaim || {})) {
            buildClaim[item] = (buildClaim[item] || 0) + count;
        }
    }

    // Law 18 counter-directional phasing: assemble order runs most-urgent → most-stable. Hunger (survival)
    // leads — a starving bot eats before anything (Law 17). It decides nothing about what is CLAIMED (the
    // band and the rung do that, and equals are picked at random); it decides what a reader sees first
    // among equals, which is where the phasing still reads as intent.
    const assembled = registry.ASSEMBLE_ORDER.flatMap(assessor => results.get(assessor).jobs);

    // ── SECTION 4.5b — THE GATES ─────────────────────────────────────────────────────────────────────
    // ONE pass over the assembled list, and it is the ONLY place a built job is refused. Every gate and
    // the argument for gating here rather than mid-assembly live in job_gates; this call site is
    // deliberately thin, because a gate that grows a special case here is a gate that has escaped the
    // module again.

    // THE PULL LIST IS MERGED FIRST, because one gate WRITES to it: an underground shortfall is routed to
    // the mining pull rather than dropped, so the descent knows what the surface work was waiting for.
    // Merging after the gates ran would discard exactly the shortfalls the gates just discovered.
    //
    // EVERY ASSESSOR IS ASKED, rather than the three that happen to answer today. The old merge named
    // building, supply and furnace individually, so a fourth assessor that produced a pull would have had
    // its shortfall dropped with nothing to say so. An assessor with no pull contributes an absent field
    // and merges to nothing, which is the same result the named list gave for the other ten — the
    // difference is only that the list can no longer go stale (Law 16).
    const mergedPull = {};
    for (const assessor of registry.EVALUATE_ORDER) {
        const src = results.get(assessor).pullNeeded;
        for (const [item, count] of Object.entries(src || {})) {
            mergedPull[item] = Math.max(mergedPull[item] || 0, count);
        }
    }

    const { posted, held } = applyGates(assembled, {
        inventory,
        allStations: stationRegistry.getStations(),
        pullNeeded: mergedPull,
    });

    // ── SECTION 4.5c — THE RANK IS COMPOSED HERE, AFTER THE GATES, AND ONLY HERE ─────────────────────
    // An assessor declares WHAT the work is (`job_type`) and nothing about its position; the band comes
    // from the table and the rung is measured against the fleet's whole material pool, which is knowledge
    // no single assessor has. job_ranking owns both — see its header.
    //
    // AFTER THE GATES, NOT BEFORE, AND THE ORDER IS LOAD-BEARING RATHER THAN TIDY: only jobs that survived
    // the gates have a position worth stating, so ordering a list the gates have not yet cut would print
    // positions for work nobody may claim. It also means a job's position can never influence whether it
    // was offered — gates refuse, the sweep orders, and neither reaches into the other (Invariant D).
    //
    // FOR THE READER, NOT FOR THE DISPATCHER. This sort orders the printed board by (band, rung); jobs
    // that agree on both compare equal and keep assemble order because Array.prototype.sort is stable.
    // The dispatcher does NOT take the head of this list — it asks job_ranking.selectBand for the whole
    // group of equals and picks one at random, so nothing about the printed order can become policy by
    // being read as one (Law 16: one place decides order, and it is not a sort).
    const allJobs = jobRanking.orderSweep(posted).sort(jobRanking.compareForDisplay);

    // REPORTED PER GATE, NOT AS ONE LIST, and the grouping is the point: two jobs held for different
    // reasons clear differently — a night-held verb waits for dawn and nothing else changes it, while a
    // material-held order clears the moment stock lands from the mine or a peer's deposit. One merged
    // line would say "held" without saying what would un-hold it. A gate that never announces its own
    // decision is not inspectable (Law 6): a silent filter looks identical whether it is working or dead,
    // so these lines are the evidence the gates actually ran.
    // ONE LINE PER GATE, THE SHARED CAUSE SAID ONCE. A gate holding six jobs holds them for one cause
    // with six particulars; repeating the cause per job buried the particular and made a board that was
    // correctly waiting for dawn look identical to a board in a loop (Architect, this round). The gate
    // name and its `why` are printed once, then the jobs, each carrying only its own `detail`.
    //
    // GROUPED BY `why` WITHIN A GATE, not assumed constant: `night` really does hold every job for the
    // same clause, but a gate is free to hold two jobs for different causes and printing one of them
    // over both would be a readable falsehood (Law 25 — this line is an outcome report).
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
            // 🚧, NEVER ⛔. ⛔ is this fleet's KILL/HALT mark and nothing else: a signal killed by the
            // judge, a router stopped, a planner parked, a bot disconnected. A gate is the OPPOSITE
            // event — nothing failed, and the board is holding work that becomes postable the moment
            // material or daylight arrives. Sharing one glyph makes the most-read line of a HEALTHY run
            // indistinguishable from the fleet's worst outcome, so an eye scanning for trouble stops on
            // a board that is working correctly. Law 5 — the levels exist to be told apart; Law 25 —
            // this line is an outcome report and must not read as a failure.
            watcher.summary(TAG, `🚧 GATED ${gate} (${count}): ${body}`);
        }
    }

    // The idle dump was deleted here with the rest of SECTION 4.5. A bot that runs out of
    // work no longer needs one: it cannot have reached idle without finishing a gather, a craft, a salvage
    // or a mining batch, and every one of those now ends at the chests on its own.

    // ── WHAT THE FLEET CURRENTLY WANTS ───────────────────────────────────────────────────────────────
    // Every material every live order still has to obtain, at every level of its recipe — not just the
    // roots. Written down because the demand is DYNAMIC and a demand nobody can read is not a demand:
    // the sweep used to work this out, hand it to the dispatcher and forget it, so nothing downstream
    // could ask "is anybody waiting on charcoal?" and every keep-or-dump ruling had to fall back on a
    // hand-authored stock row. A static keep-list cannot protect a dynamic request — that mismatch is
    // what let a bot bank the exact material its own next craft was waiting on.
    //
    // HELD JOBS COUNT, AND THEY ARE THE POINT. A job held short of an ingredient is precisely a job
    // waiting on it; leaving held work out would report zero demand for the one material the fleet is
    // most blocked on.
    //
    // GROSS, NOT NET, AND EVERY CONSUMER NETS IT ITSELF. `need` is already the outstanding amount at the
    // top of each order, and what counts as "already covered" differs per consumer — the smelter counts
    // chest stock plus what is mid-cook, a bot deciding whether to bank a stack counts only its own
    // pocket. Netting here would pick one of those meanings for all of them (Law 25: the criterion
    // belongs to whoever is asking).
    // PUBLISHED TO THE CHAIR, NOT TO A LOCAL ROOM, BECAUSE A PRODUCER SERVES THE WHOLE FLEET. Conference
    // rooms are local to one bot; the boardroom chair is the established cross-bot channel and the whole
    // chair rides the ordinary broadcast, so no second sync channel is needed. Two bots each wanting twelve
    // torches want six charcoal between them, and one furnace run should make all six — a smelter reading
    // only its own bot's demand would light the furnace twice for half a batch each, which is worse than
    // the authored row this replaced. Each bot writes only its own chair (Invariant D); the consumer sums.
    //
    // THE DUMPER IS THE OPPOSITE READ AND MUST STAY OPPOSITE. Production is sized to the FLEET; keeping is
    // decided by the bot's OWN held order (`heldOrderDemand`). That asymmetry is the whole shared-furnace
    // behaviour: whoever empties the furnace keeps only what its own order needs and banks the rest, and
    // the bot that wanted the remainder withdraws it. Reading fleet demand in the dumper would make the
    // emptier hoard a peer's charcoal indefinitely, and every bot would need a furnace of its own.
    const wanted = {};
    for (const job of [...allJobs, ...held.map(h => h.job)]) {
        if (job.type !== 'supply' || !(job.need > 0) || !job.what) continue;
        for (const [item, count] of Object.entries(requirementTree(job.what, job.need, {}))) {
            wanted[item] = (wanted[item] || 0) + count;
        }
    }
    boardroom.materials_wanted = wanted;
    boardroom.materials_wanted_at = now;
    hq.writeBoardroomChair(botId, boardroom);
    overseerLink.sendUpdate();

    // The board's writes are unguarded for the same reason the scans above are: hq is ours, and a
    // warn-and-continue here published a summary describing jobs no consumer ever received.
    hq.writeConfRoomFlag('job_board_room', 'jobs', allJobs);
    hq.writeConfRoomFlag('job_board_room', 'materials_needed_pull', mergedPull);

    // ── WHAT THE GATES HELD, PUBLISHED RATHER THAN ONLY PRINTED ──────────────────────────────────────
    // The 🚧 lines above are for an eye reading a console. Nothing downstream could read them, so the
    // dispatcher saw an empty `jobs` list and reported "no jobs on the board" over a board holding six
    // jobs for nightfall — a true sentence about the wrong cause, in the one line a reader consults to
    // decide whether a still fleet is finished or stuck (Law 25: an outcome signal states the true
    // result; Law 6: a filter whose decision cannot be read downstream is not inspectable).
    //
    // AN EMPTY BOARD AND A FULLY-HELD BOARD ARE THE SAME PICTURE FROM THE BOT'S SIDE, and that is the
    // whole failure this closes: both leave a bot standing at the park with nothing to claim. Only the
    // gates know which one happened, so the fact travels from the only place that holds it.
    // THE SAME `held` THE REPORT WAS BUILT FROM, not a second walk over the gates — one derivation, so
    // the console line and the chair can never come to disagree (Law 16).
    // Grouped by gate-then-cause because that is what "what would release this" is keyed on: a
    // night-held job clears at dawn and nothing else changes it, while a material-held one clears when
    // stock lands. A flat count would say "6 held" and leave the reader unable to tell those apart.
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
            // `need` first: it is the number the posting gate judged, so the board line and the gate's
            // hold-back line quote the same figure. Falls back for job types that have no `need`.
            const qty = j.need ?? j.hold_goal ?? j.batch_quantity;
            const detail = qty != null ? `(need:${qty})` : '';
            const dest = j.destination ? `→${j.destination}` : '';
            const tier = j.tier ? `[${j.tier}]` : '';
            // A dynamic build-order (a build's surface shortfall) shares type/what with the standing STOCK
            // restock — tag it so the two are distinguishable in the board line (Law 6).
            const dyn = (typeof j.id === 'string' && (j.id.startsWith('build_chest_') || j.id.startsWith('build_supply_')))
                ? ' ⟨build-order⟩' : '';
            // `why` carries the SENSED NUMBERS that tripped the assessment, because several jobs post on a
            // threshold the board computes and then discards — the dump's distance-scaled slot count, the
            // composter's fill level. Without it the board line is a verdict with no evidence: "dump_excess"
            // reads identically whether the ramp fired at 3 slots beside a chest or at 8 slots down a shaft,
            // so the ramp is untestable from a trace (Law 6 — the decision must be inspectable after the
            // fact, and this is the only place these numbers still exist).
            const why = j.why ? ` {${j.why}}` : '';
            // ── THE RANK IS PRINTED AS ITS COORDINATES, NEVER AS ITS INTEGER ─────────────────────────
            // Under an authored table a bare number was at least LOOKUP-ABLE: a reader could open the
            // table and find the row. A measured rank has no row to find, so the same number would be a
            // verdict with its entire reasoning discarded — strictly less inspectable than what it
            // replaced. The board states the two answers that decided the position (who is waiting, how
            // far from done), because that is the only place
            // those answers exist once the sweep ends (Law 6). A board that ranks dynamically and cannot
            // say why is worse than a static one, so this line is part of the mechanism rather than a
            // report of it.
            return `[${jobRanking.describeBand(j)}] ${j.type}/${j.what}${tier}${dest ? ' ' + dest : ''}${detail ? ' ' + detail : ''}${why}${dyn}`;
        });
        watcher.summary(TAG, `──── JOB BOARD: ${allJobs.length} job(s) ────`);
        watcher.summary(TAG, jobSummaries.join(' | '));
    } else {
        watcher.summary(TAG, 'No jobs posted — system idle.');
    }

    // ── Sweep summary: storage thresholds + inventory highlights ──────────
    // A peer-locked chest is counted like any other (its last snapshot is
    // countable state — the wait-to-act rule lives in inventory_swapper, not
    // here) and carries a 🔒 tag so the trace shows some of the stock was read
    // off a chest currently in use.
    //
    // ONE POOL, SO ONE FIGURE AND NO ADDRESS. This block used to resolve each row's named chest
    // (`blueprint#n`, matched by role) and render "delivers → headframe#1" beside the count. Both halves
    // are gone with the roles: a `storage` row is a request against the whole chest system, so there is
    // no destination to name and rendering one implied a routing decision nothing made. What replaces it
    // is the count of chests the figure was summed over — the same information a reader actually used the
    // address for ("is anything registered to hold this yet?").
    const summaryParts = [];
    const allStations = stationRegistry.getStations();
    const chestEntries = Object.values(allStations).filter(e => e && e.type === 'chest');
    const lockedChests = chestEntries.filter(e => e.locked_by).length;
    for (const stock of STOCK_THRESHOLDS) {
        if (stock.deficit_below == null || stock.holder !== 'storage') continue;
        // THE REPORTED FIGURE IS THE ONE THE GATE JUDGED, and that is fleet-wide. This line used to render
        // the count of ONE chest beside a threshold the assessment measured differently — a reader could
        // watch a stock read as below-threshold with no way to see matching material sitting in a chest
        // next door, because the board and its own render disagreed. Same number or neither (Law 25).
        const fleetCount = inventoryLens.forChestRequest(stock.item, buildClaim);
        const status = fleetCount >= stock.deficit_below ? '✓' : `⚠ below ${stock.deficit_below}`;
        const lockTag = lockedChests ? ` 🔒${lockedChests} in use` : '';
        summaryParts.push(`storage ${stock.item}:${fleetCount}/${stock.deficit_below} ${status} `
            + (chestEntries.length
                ? `(across ${chestEntries.length} chest(s))${lockTag}`
                : '(no chest registered yet — nowhere to bank it)'));
    }
    // The bot's OWN pocket (labelled 'pocket=' so it's never mistaken for a chest). This is a
    // curated highlight of build/furnace-relevant materials, NOT the full inventory — the complete
    // pocket contents are the separate 🎒 line above.
    const pocketHighlights = ['logs', 'planks', 'cobblestone', 'charcoal', 'coal', 'iron_ingot', 'diamond']
        .map(k => { const v = countInInventory(k, inventory); return v > 0 ? `${k}:${v}` : null; })
        .filter(Boolean);
    if (pocketHighlights.length > 0) summaryParts.push(`pocket=[${pocketHighlights.join(',')}]`);
    if (summaryParts.length > 0) {
        watcher.summary(TAG, `📊 ${summaryParts.join(' | ')}`);
    }

    // Station census (every chest/furnace's contents) — the registry reports its own state.
    stationRegistry.logContents();

    hq.flushNow();
    return allJobs;
}

// ── Singleton export ──
module.exports = {
    // The plan phase (this sweep → dispatcher's magnet claim → HQ sync) runs under
    // the overseer's planning token: exactly one bot plans at a time, so every
    // sweep sees every peer's FRESH magnet and job dedup cannot race. Acquired
    // here (parks until granted — FIFO, seniority-tiebroken); released by the
    // dispatcher AFTER it has synced its magnet, never before (releasing pre-sync
    // would hand the next planner a stale view — the exact bug this kills).
    async receive(signalType, payload) {
        const overseerLink = require('@kernel/overseer_link');
        await overseerLink.acquirePlanningToken();
        // Unguarded. The catch that stood here released the planning token before rethrowing, to spare a
        // peer the crash TTL — an optimisation on a path that only runs when the sweep has already failed
        // in a way that stops this bot. The TTL exists precisely for a holder that died, so the compensation
        // duplicated a recovery the overseer already owns (Law 16), and it had to be written as a catch
        // around our own code to do it.
        _sweep();
        routeSignal(require('@kernel/signal_bus'), TAG, 'dispatcher', {});
    },
    INVENTORY_WHITELIST,
};
