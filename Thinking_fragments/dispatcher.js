// dispatcher.js
// Thinking fragment. Replaces the old sequencer.
// Reads job_board_room, picks the lowest unmet need THIS SPECIES MAY TAKE,
// places the bot's magnet on the job, dispatches to the correct manager.
//
// Magnet lifecycle:
//   - CONSULTED here before the claim — bot_mandate.magnetRefusal decides which of the board's jobs
//     this species is attracted to at all (SECTION 1). The board posts one identical list to every bot;
//     the species is a property of the reader, and this is where it is read.
//   - Written here on job claim
//   - Cleared here when no jobs remain
//   - clearMagnet() exported for disconnect handlers (master_core)

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const botMandate = require('@kernel/bot_mandate');
const { routeSignal } = require('@utils/signal_utils');
const jobRanking = require('@thinking/job_ranking');

const TAG = 'dispatcher';

const MANAGER_MAP = {
    // Death recovery — the only job on the board a CORPSE can be dispatched, and a MANAGER rather than a
    // one-shot: two ordered acts (spawn, then teleport), each verified by SENSING and not by the
    // command that caused it — a respawn packet accepted is not a body, and a `tp` returning cleanly is
    // not an arrival. That verify loop is what makes it a manager (same shape as eat_manager).
    respawn: 'death_manager',
    supply:  'supply_manager',
    build:   'building_manager',
    mine:    'mining_manager',
    farm:    'farm_manager',
    // Eating (self-preservation): a MANAGED job — eat_manager dispatches eat_executor, then re-senses to
    // VERIFY the bot is full before releasing to the judge (never trusts the executor's self-report). Not
    // one-shot: the verify step is the manager's own gap-closing check (Law 17 / Invariant B).
    health:  'eat_manager',
    explore: 'exploration_executor',
    // furnace load/collect and inventory dump are one-shot (do the thing and leave) — no
    // gap-closing loop to manage, so the job dispatches straight to its executor. The executor
    // routes to recursive_judge with no manager stamp, so the next sweep re-plans from fresh
    // world state (a leaner pocket, in the dump case).
    furnace:   'furnace_executor',
    // `inventory: 'dump_executor'` was deleted with the dump job itself — offloading is a step
    // at the end of every producing verb now, not a job that can be dispatched (job_board SECTION 4.5).
    // Ground salvage — one-shot, and deliberately NOT a manager despite having gates. A manager exists to
    // close a gap by re-sensing after each act; this either takes the drop in one trip or declines it, and
    // a decline is terminal for that item stack rather than a state to re-check. The board re-offers other
    // drops freely; this one stops being offered because the executor remembers its id (Invariant D — the
    // seat that declined owns the memory of it).
    ground_salvage: 'ground_salvage_executor',
    // NO `compost` ROUTE, and it is not an oversight. It was a manager (two ways to fill the
    // block), then briefly a one-shot (harvest only), and then neither: filling and emptying both moved
    // inside inventory_swapper.dumpExcess, which visits the block already. compost_executor is a LIBRARY
    // now — it has no `receive` to route to, and adding a job type back here would post an errand that
    // sits unclaimed. See compost_executor's header.
    // base-lighting is one-shot like furnace/inventory: walk the dark cells, place torches, leave.
    // No multi-phase routing decision, so the job goes straight to the executor (no manager hop).
    light:     'torch_executor',
    // proactive canopy clearing (camera framing) — one-shot: fell one wild tree in a blueprint's clear
    // ring and leave. Straight to its executor; no gap-closing loop to manage.
    canopy:    'canopy_clear_executor',
    // startup base-layout lock — one-shot: locate + lock EVERY base blueprint in one pass (headframe
    // first as the anchor, satellites within the spread gate), so a bad seed / too-strict criterion
    // surfaces early. Straight to its fragment; no gap-closing loop (it locks all-or-Law13 in one run).
    // Posted by `assessors/base_layout` at base_layout_lock priority (just under home_base) while any
    // base blueprint lacks a locked center, so the batch wins the locate race over the lazy find routes.
    base_layout: 'lock_all_buildspots',
    // startup wood-preference lock — one-shot: scan the surface for logs, publish the most abundant
    // species to the fleet's boardroom, leave. Straight to its fragment; it operates on the record only
    // (no walk, no dig, no place), so there is nothing for a manager to sequence.
    wood_preference: 'set_wood_preference',
};

// ── THE BOT DOES NOT NARRATE. IT ANNOUNCES WHETHER IT IS FREE. (Architect 2026-09-06) ───────────────
// *"when they post to their owner its way too much. it will block the players vision… reporting is off by
// default and a player should type foreman where."*
//
// `SPOKEN_JOB` and `_describeJobAloud` lived here and are DELETED. They put one line in open chat on every
// claim and every idle change, from every body, unasked, naming the job. The intent was sound — a body
// walking a hundred blocks to a site it chose for reasons it never said is indistinguishable from a body
// wandering, and the failure that prevents is INTERVENTION, a human stopping a bot that was working. On
// one bot in a recording it worked. On a crew of two beside somebody trying to play, the chat window is
// drawn over the world, so the cure for *"I cannot tell what it is doing"* had become *"I cannot see"*.
//
// WHAT IT IS DOING IS A PULL, AND IT IS SOMEBODY ELSE'S: `foreman where` reads this bot's magnet straight
// out of its boardroom chair and answers in one line for the whole crew. That is the same fact this file
// used to shout, delivered when it is wanted — and it costs the planning recursion nothing, because the
// magnet was already being written for the fleet's own use (Law 3). The plain-English job words moved
// with the question, to `foreman/foreman_vocabulary.js`; adding a job type means adding its word THERE.
//
// WHETHER IT IS FREE IS STILL A PUSH, and that is the second ruling of the same day (*"they should tell
// the human if they are available or not… when they go to idle park then they message once that they are
// idle"*). The distinction is the whole design and losing it is how the wall comes back: **what** a bot is
// doing changes every job and only matters to somebody already wondering; **whether** it can take an order
// changes on the order of minutes and matters most to somebody who has no reason to be asking. Two call
// sites below, both crossings, both through `@kernel/bot_voice`, which holds the floor that stops a
// flapping job from becoming a flapping chat window.

function _getBotId() {
    return process.env.BOT_ID || 'default';
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Job selection helpers
// ─────────────────────────────────────────────────────────────────────────────

// THE ONE PLACE EVERY JOB PASSES THROUGH, which is why the quantity check lives here rather than at the
// four posting sites or in a source scan.
//
// The failure it stops: a supply job whose `need` / `hold_goal` / `at_destination` is missing or negative
// is an order nothing can fill. It soft-fails, the board re-posts it unchanged, the same bot re-claims it,
// and five identical outcomes kill the signal — the fleet spins on one unfillable row and reports each
// pass as a normal refusal. `job_board.supplyJob` is the ONE constructor and it already throws on those
// three fields; this is the check that a job assembled some other way cannot slip past it.
//
// WHY NOT A GUARD AT EACH POSTING SITE: that was tried, four times, and the fifth site shipped without it
// looking correct — a guarantee installed at N sites is N guarantees and the N+1th is the bug (Law 16).
// WHY NOT A SOURCE SCAN FOR THE BYPASS TOKEN: that was also tried, and deleted 2026-08-15. A scan for
// `type: 'supply'` written literally pins the shape the code has today; the quantity contract may be
// renamed or restructured, and on that day the scan reports a violation against correct code while
// catching nothing (Law 25). A throw at the consumption boundary shifts with the codebase instead — it
// reads whatever job actually arrives, from whatever producer, and it cannot be bypassed by writing the
// object a different way, because there is no other way IN.
//
// The read is inbound from another process's write (Law 23 — the board is a claim, verified here before
// anything acts on it), and default-stopped: an unfillable job stops the dispatcher rather than being
// dispatched and discovered five refusals later (Law 13).
const SUPPLY_QUANTITY_FIELDS = ['need', 'hold_goal', 'at_destination'];

function _readJobs() {
    const jobs = hq.readConfRoomFlag('job_board_room', 'jobs', []) || [];
    for (const job of jobs) {
        if (!job || job.type !== 'supply') continue;
        for (const field of SUPPLY_QUANTITY_FIELDS) {
            if (!Number.isFinite(job[field]) || job[field] < 0) {
                throw new Error(`[${TAG}] CODING VIOLATION (Law 13): supply job id=${job.id} what=${job.what} `
                    + `reached the dispatcher with \`${field}\`=${job[field]}. A supply job must declare all `
                    + `three of ${SUPPLY_QUANTITY_FIELDS.join(', ')} as finite, non-negative numbers — see `
                    + 'THE QUANTITY CONTRACT in job_board. This job was NOT built through job_board.supplyJob, '
                    + 'which is the only legal way to build one; posting it as an object literal bypasses the '
                    + 'constructor that guarantees these fields and posts an order nothing can fill.');
            }
        }
    }
    return jobs;
}

function _getClaimedJobIds(excludeBotId) {
    const boardroom = hq.getFullBoardroom({});
    const claimed = new Set();
    for (const [botId, chair] of Object.entries(boardroom)) {
        if (botId === excludeBotId) continue;
        if (chair?.magnet?.job_id) claimed.add(chair.magnet.job_id);
    }
    return claimed;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Magnet management
// ─────────────────────────────────────────────────────────────────────────────

// The MAGNET: advisory task-identity marker (see the taxonomy in overseer_brain.js).
// Reliable only because this write happens under the planning token — no peer is
// planning while it propagates.
function _claimJob(botId, job) {
    const existing = hq.readBoardroomChair(botId, {});
    existing.magnet = {
        job_id:      job.id,
        type:        job.type,
        what:        job.what,
        where:       job.where || null,
        // THE QUANTITY CONTRACT (job_board): a LEVEL and an AMOUNT never share a name, so each is
        // whitelisted under its own. The magnet is a field WHITELIST — a name missing here does not exist
        // downstream, which is why adding a job-quantity field means adding it in this list too.
        hold_goal:      job.hold_goal ?? null,
        need:           job.need ?? null,
        at_destination: job.at_destination ?? null,
        batch_quantity: job.batch_quantity ?? null,
        hunger_goal:    job.hunger_goal ?? null,
        hunger_now:     job.hunger_now ?? null,
        destination: job.destination || null,
        // WHICH STATION ROW, by the registry's own key. Added 2026-09-10 because its absence from this
        // whitelist is what made the delivery bug possible: the assessor knew the chest's key, this list
        // dropped it, and `supply_manager` rebuilt it from `where` — missing the owner half that
        // `station_registry.stationKey` appends, so every storage delivery abandoned with
        // `no_deposit_target_for_<item>`. A rebuild is a second minting of a key (Law 16); carrying it is
        // the whole reason this list exists.
        station_id:  job.station_id || null,
        source:      job.source || null,
        category:    job.category || null,
        tier:        job.tier || null,
        action:      job.action || null,
        anchor_index: job.anchor_index != null ? job.anchor_index : null,
        // Which INSTANCE of a multi-instance blueprint this job targets (the two wheat farms share a
        // blueprint but have distinct conference-room keys). The magnet is a field WHITELIST, not a job
        // copy, so a per-instance job would lose its key here without this line — farm_manager reads it
        // off the magnet to route to the right farm's chair.
        conference_room_key: job.conference_room_key || null,
        // ── WHAT THE BOARD DECIDED ABOUT THIS JOB, CARRIED WHOLE ────────────────────────────────────
        // The magnet is a field WHITELIST, not a job copy, so a field absent here does not exist
        // downstream at all. All four travel because they answer different questions and only one of them
        // is derivable from another:
        //   job_type  the KIND of work — the job's identity, and the only field that is stable across
        //             sweeps. Every downstream question keyed on "which kind of job is this" reads it.
        //   asker     the band the sweep stamped on this job. Carried rather than looked up from
        //             job_type, because the sweep is the one place a band is decided (Law 16) and a
        //             consumer that re-derives it is a second answer waiting to disagree with the first.
        //   stage     how far from done the board measured it, likewise unrecoverable after the sweep.
        // NO `priority` FIELD. It carried a composed integer "for the record", and a saved run's monitors
        // sorted by it — so the trace kept a number the live fleet had stopped deciding with, which is the
        // worst of both (a reader trusts it, nothing maintains it). The three answers above are the whole
        // position; a monitor orders by them or does not order at all.
        job_type:    job.job_type || null,
        asker:       job.asker || null,
        stage:       job.stage || null,
        chest_locks: [],
        claimed_at:  new Date().toISOString(),
    };
    hq.writeBoardroomChair(botId, existing);
}

function clearMagnet(botId) {
    if (!botId) botId = _getBotId();
    const existing = hq.readBoardroomChair(botId, {});
    if (existing.magnet) {
        existing.magnet = null;
        hq.writeBoardroomChair(botId, existing);
        watcher.summary(TAG, `Magnet cleared for bot ${botId}.`);
    }
    // A cleared magnet = no active task, so no object claim (anchor/tree/cell) should survive it.
    // On a KILLED signal the executor's own end-of-run releaseClaim never runs — the promise is
    // abandoned mid-await (Law 15) — leaving its anchor claim held for the full 5-min
    // STALE_CLAIM_MS TTL, long enough to starve a peer into an infinite-loop kill. Release here so
    // a dead/idle holder never squats a claim the survivor needs — one task, one LIVE owner (Law 4 / Invariant D).
    // A REAL BOUNDARY — releaseAllClaims crosses the socket to the overseer, so a failure is the
    // network's and not ours.
    const release = require('@utils/external_library_guard')
        .guardExternalSync(TAG, 'overseer releaseAllClaims', () => require('@kernel/overseer_link').releaseAllClaims());
    if (release.ok && release.value > 0) watcher.summary(TAG, `Released ${release.value} object claim(s) held by ${botId} on magnet clear.`);

    // THE CLEAR MUST BE BROADCAST, FOR THE SAME REASON THE CLAIM IS. A peer never reads this bot's chair
    // off disk — it reads the copy the overseer relayed (mergeBroadcastChairs replaces a chair wholesale),
    // so a magnet cleared only in local HQ is still held everywhere it is consulted. _claimJob is followed
    // by sendUpdate() and this path was not, which made the release depend on an unrelated event: the
    // releaseClaim above reaches _dropClaimFromChair, which sends an update as a side effect — so the
    // clear propagated ONLY when the bot happened to hold an object claim, and silently did not when it
    // held none. One task, one LIVE owner (Law 4 / Invariant D) requires the release to be a fact this bot
    // authors, never an absence a peer is left to infer (Invariant B — the peer re-senses from the relay).
    //
    // THE FAILURE THIS CLOSES, structurally: the judge's haltForInspection calls clearMagnet, so a halted
    // planner held nothing locally and everything remotely. Its partner read the board, found the one job
    // still carrying a dead bot's job_id, and idled `claimed_by_peers` for the rest of the run — one halt
    // stranding a whole crew. The disconnect sweep (releaseAbsentBotMagnets) does not cover it and must
    // not be extended to: a halted bot is connected and correctly on the roster.
    //
    // A REAL BOUNDARY — crosses the socket, so a failure is the network's and not ours, and the clear must
    // not be undone by it (the magnet is already gone locally; the update is what tells everyone else).
    require('@utils/external_library_guard')
        .guardExternalSync(TAG, 'overseer sendUpdate', () => require('@kernel/overseer_link').sendUpdate());
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Main handler
// ─────────────────────────────────────────────────────────────────────────────

// WHY AN EMPTY BOARD IS TWO DIFFERENT EVENTS. Nothing outstanding and everything gated produce the
// identical picture here — zero postable jobs — and they are opposite conditions: one is a fleet that
// has finished, the other is a fleet waiting on daylight or on stock that has not landed. Reporting
// the first sentence over the second state is a readable falsehood in the one line a reader consults
// to decide whether a still fleet is done or stuck (Law 25).
//
// THE GATES ARE THE ONLY PARTY THAT KNOWS, so the fact is read from where they publish it rather than
// re-derived here: this dispatcher cannot re-run the gates without becoming a second decider of what
// may be offered (Law 16, Invariant D — job_gates owns that verdict).
//
// ABSENT CHAIR ⇒ NOTHING HELD, and it is not a defect: the flag is written by every sweep, so a bot
// that has not swept yet has an empty board for the ordinary reason. It states the plain sentence
// rather than claiming a hold it has no evidence for (Law 23 — unverified is not asserted).
// Returns { reason, cause }. `reason` is the sentence for a reader; `cause` is the same verdict as a
// stable token, because the park line and any instrument waiting on this fleet need the one bit —
// finished, or holding — and must not get it by matching prose that is free to be reworded (Law 10:
// the field is declared, never parsed out of a message).
function _emptyBoardReason() {
    const held = hq.readConfRoomFlag('job_board_room', 'jobs_held', null);
    if (!held || !(held.count > 0)) {
        return { reason: 'No jobs outstanding — nothing left to do.', cause: 'none_outstanding' };
    }
    // Named by gate and cause, because "6 held" cannot be acted on and "6 held by night → waiting for
    // dawn" can. `short_of` is carried where a gate named items, since that is the list that says what
    // arriving would release the work.
    const causes = Object.entries(held.by_gate).map(([gate, byWhy]) =>
        Object.entries(byWhy).map(([why, row]) =>
            `${row.count}× ${gate} → ${why}${row.short_of.length ? ` (short of: ${row.short_of.join(', ')})` : ''}`
        ).join('; ')
    ).join(' · ');
    return {
        reason: `No jobs CLAIMABLE — all ${held.count} held at the gates: ${causes}`,
        cause: 'all_gated',
    };
}

// Idle exit: drop the magnet and hand off to idle_park, which moves the bot clear of the build
// footprint and arms the 10s re-check heartbeat so a bot that ran out of work wakes back up when a
// peer frees a job (instead of sitting idle forever). Routing to a park fragment (not a bare
// return) is what lets the bot both get out of the way AND schedule its own re-entry.
function _goIdle(botId, reason, cause) {
    // One log decision for the whole pass. At the 1s heartbeat this runs about
    // once a second; posting the reason every time is Law 5 noise. The verdict is carried to idle_park
    // so both lines of one pass appear together or not at all — see idle_scheduler's gate for why the
    // two fragments must not each keep their own limiter.
    const post = require('@kernel/idle_scheduler').shouldLogIdlePhase();
    if (post) watcher.summary(TAG, `${reason} (idle pass ${post.passes})`);
    // ONE THING IS SAID IN THE WORLD HERE, AND IT IS NOT THE REASON (Architect 2026-09-06: *"when they go
    // to idle park then they message once that they are idle"*). A standing body is the one most likely to
    // be read as broken, and a crew that has become available is the one fact a person cannot see and has
    // no reason to be asking about at the moment it becomes true.
    //
    // THE CAUSE IS DELIBERATELY NOT CARRIED. All four idle causes mean the same thing to the person —
    // this bot can take an order — and the differences between them ("6 held at the gates short of
    // iron_ingot") are the vocabulary that made the last version a wall. They are on the trace line above
    // and in `foreman where`; what crosses into the world is the one bit.
    //
    // CALLED ON EVERY IDLE PASS, roughly once a second, and bot_voice decides which of those becomes a
    // sentence: idle is a standing condition and repeats on its own floor, about once a minute for as long
    // as the parking lasts. Gating it on `post` instead would tie a person's sentence to the trace's own
    // pacing window (Law 16 — one owner per decision), and the two cadences answer to different readers.
    require('@kernel/bot_voice').goneIdle();
    clearMagnet(botId);
    routeSignal(TAG, 'idle_park', {
        readable: `${TAG}: ${reason} → idle_park`,
        log_idle_line: !!post,
        // The park states WHICH still-fleet this is. The dispatcher owns the decision and keeps the
        // detailed sentence; the park gets the one bit, so the two lines of a pass do not print the
        // same prose twice (Law 5) and a reader stopping at the park line still learns whether the
        // fleet is finished or waiting.
        idle_cause: cause,
    });
}

function _run() {
    const botId = _getBotId();
    // A real plan cycle is running — clear any pending idle heartbeat so it can't fire a second
    // signal on top of this one (Law 4). idle_park re-arms it if we end up idle again.
    require('@kernel/idle_scheduler').cancel();
    // Same rule for the sentry watch (Law 4: one occupant per scope). The watch never routes here — it
    // terminates at its own judge — so reaching the dispatcher means the planning recursion is taking
    // the body back, and a watch still holding its signal would be a second occupant. The `sentry` verb
    // is the only thing that arms it, so this is a one-way handover: `start` ends sentry mode.
    //
    // NOT a Law 1 action-to-action dispatch, though await_aggro is a fragment: nothing is being asked
    // to do work. This sets the preemption flag Law 4 requires — a looping fragment finishes its
    // current iteration before dropping the signal — which is the ratified way to tell a running
    // occupant to release the scope.
    require('@action/await_aggro.js').stop();
    const jobs = _readJobs();

    if (jobs.length === 0) {
        const verdict = _emptyBoardReason();
        _goIdle(botId, verdict.reason, verdict.cause);
        return;
    }

    // ── THE MAGNET FILTER ───────────────────────────────────────────────────────────────────────
    // WHERE THE SPECIES ENTERS, and the only place it does. `jobs` is the whole board — job_board posts
    // every job it can see and never asks who is reading (bot_mandate's THE BOARD IS ONE BOARD). What a
    // homesteader and a contractor share is the picture; what differs is which parts of it pull.
    //
    // BEFORE THE PEER-CLAIM FILTER, and the order is for the REPORT rather than for correctness — the
    // two filters commute. Species first means a bot that can take nothing says so as a fact about
    // ITSELF ("nothing on this board is mine to take") instead of as a fact about the race ("everything
    // is claimed"), which would be a true sentence about the wrong cause and would send the next reader
    // hunting for a peer that is not there.
    //
    // WHAT IT PASSED OVER IS COUNTED, NOT DROPPED (Law 6). A filter that removes jobs silently looks
    // identical whether it is working or dead, and this one removes most of the board for a contractor —
    // the state it produces is a bot standing still, which is the single hardest condition in this fleet
    // to tell apart from a broken one. Counted BY REASON so eleven passed-over jobs read as one clause
    // with a number rather than eleven lines (job_gates' held-report split, same argument).
    const attracted = [];
    const passedOver = new Map();
    for (const job of jobs) {
        const refusal = botMandate.magnetRefusal(job);
        if (!refusal) { attracted.push(job); continue; }
        passedOver.set(refusal, (passedOver.get(refusal) || 0) + 1);
    }
    const passedOverCount = jobs.length - attracted.length;
    const magnetNote = passedOverCount === 0 ? ''
        : ` (magnet passed over ${passedOverCount}: ${[...passedOver].map(([why, n]) => `${n}× ${why}`).join('; ')})`;

    if (attracted.length === 0) {
        _goIdle(botId, `Nothing on the board this species may claim${magnetNote}`, 'none_for_species');
        return;
    }

    const claimed = _getClaimedJobIds(botId);
    const available = attracted
        .filter(j => j.scope === 'local' || !claimed.has(j.id));

    if (available.length === 0) {
        _goIdle(botId, `All jobs this magnet attracts are claimed by other bots — idle.${magnetNote}`, 'claimed_by_peers');
        return;
    }

    // ── THE CHOICE ──────────────────────────────────────────────────────────────────────────────
    // `selectBand` returns the whole group of jobs at the front of the board — one band, one rung, no
    // further discrimination — and this picks one of them AT RANDOM. Nothing here sorts, and nothing may
    // be added that does: a third fact used to break this tie and it was a line number in a config file.
    //
    // RANDOM IS THE FLEET-CORRECT CHOICE, NOT A COIN FLIP STANDING IN FOR A DECISION. Four bots sweeping
    // the same board and each taking the deterministic head all reach for the SAME job, and three of them
    // lose the claim and re-plan — the arbitration cost scales with fleet size and produces nothing.
    // Random spreads N bots over N equal jobs with no arbiter at all (Law 4: one bot per task, reached by
    // the cheapest route). It is not manufactured variance either (Law 19): the bot is not imitating a
    // human's inconsistency, it is declining to invent a preference between things it has measured as
    // equal — inventing one is what the deleted tiebreak did.
    const equals = jobRanking.selectBand(available);
    const job = equals[Math.floor(Math.random() * equals.length)];
    const managerName = MANAGER_MAP[job.type];

    if (!managerName) {
        watcher.error(TAG, `Unknown job type '${job.type}' — no manager mapped.`);
        return;
    }

    // The idle phase (if any) ends here. Closing it resets the log gate so the NEXT idle phase posts on
    // its first pass instead of inheriting a window left over from this one.
    require('@kernel/idle_scheduler').noteDispatch();

    _claimJob(botId, job);

    const dest   = job.destination ? ` → ${job.destination}` : '';
    const src    = job.source      ? ` ← ${job.source}` : '';
    const act    = job.action === 'retrieve' ? ' RETRIEVE' : (job.action === 'deliver' ? ' DELIVER' : '');
    const qty    = job.need != null ? ` (need: ${job.need}, hold ${job.hold_goal})`
                 : job.batch_quantity != null ? ` (batch: ${job.batch_quantity})`
                 : '';
    // The passed-over COUNT rides the dispatch line — the per-reason breakdown does not, because this
    // line fires on every claim and the breakdown does not change between them. The number is what a
    // reader needs here: it distinguishes a bot choosing from the whole board from one choosing out of
    // the two categories its species can see, which the rank alone cannot show (Law 6, cheaply).
    const skipped = passedOverCount ? ` · magnet passed over ${passedOverCount}` : '';
    // HOW MANY IT CHOSE FROM, said out loud. A random pick is inspectable only if the SET it was made
    // from is on the record — otherwise a reader watching one bot take a different job each sweep cannot
    // tell a working tie from a thrashing board (Law 6).
    const among = equals.length > 1 ? ` · 1 of ${equals.length} equal` : '';
    // The claim line quotes the job's COORDINATES, matching the board line it was chosen from. A claim is
    // the moment a reader most needs to know why THIS job beat the rest — and with the tie broken at
    // random the honest answer is "its band and rung beat theirs, and among its equals nothing did", which
    // is exactly what the two names plus the `1 of N equal` clause say.
    watcher.summary(TAG,
        `Claimed [${jobRanking.describeBand(job)}] ${job.type}/${job.what}${act}${dest}${src}${qty} — dispatching to ${managerName}.${among}${skipped}`);

    // WHAT THE CLAIM IS IS NOT ANNOUNCED IN THE WORLD — only THAT there is one. This was the loudest line
    // in the fleet: one chat message per body per claim, all day, naming the job. `_claimJob` above has
    // already written the magnet, so what the job IS stands in the boardroom for `foreman where` to read
    // the moment somebody asks (Law 3 — relayed, never re-sensed).
    //
    // The one bit that does cross is availability, and only as a CROSSING: a bot that was already working
    // says nothing, so this is silent on every claim but the first after an idle phase. It is the closing
    // half of the sentence `_goIdle` opened — a person told a crew went idle is owed the moment it stopped
    // being true, and nothing else in the world tells them.
    require('@kernel/bot_voice').backToWork();

    // A REAL BOUNDARY — this crosses a socket to the overseer, so a failure here is the network's and not
    // ours, and the dispatch must not be undone by it (the claim already happened; the update is telemetry
    // riding along). It goes through the guard because the previous form swallowed silently: a fleet that
    // had stopped reporting its dispatches looked identical to one that had stopped dispatching.
    require('@utils/external_library_guard')
        .guardExternalSync(TAG, 'overseer sendUpdate', () => require('@kernel/overseer_link').sendUpdate());

    routeSignal(TAG, managerName, {
        job,
        readable: `${TAG}: [${jobRanking.describeBand(job)}] ${job.type}/${job.what} → ${managerName}`,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    // End of the plan phase: the planning token (acquired by job_board) is
    // released on EVERY exit path, but only after _run() returns — on the
    // dispatch path _run has already claimed the magnet AND sendUpdate()'d it,
    // so the overseer rebroadcasts this magnet BEFORE it grants the token to
    // the next planner (per-socket message order guarantees the sequencing).
    // Release-before-sync would hand the next bot a stale view — never reorder.
    receive(signalType, payload) {
        require('@utils/external_library_guard').withCleanupSync(
            TAG, 'planning pass',
            () => _run(),
            () => require('@kernel/overseer_link').releasePlanningToken());
    },
    clearMagnet,
    // Exported for fragment_registry's load-time completeness assert (see the note there). Nothing else
    // reads it — the dispatch path uses the module-local const directly.
    MANAGER_MAP,
};
