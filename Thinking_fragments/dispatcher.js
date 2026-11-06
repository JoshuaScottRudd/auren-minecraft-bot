// dispatcher.js
// Thinking fragment: reads job_board_room, picks the lowest unmet need this species may take,
// places the bot's magnet on the job, and dispatches to the correct manager.
// Magnet: written on claim, cleared when none remain. clearMagnet() also exported for disconnect
// handlers (master_core).

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { routeSignal } = require('@utils/signal_utils');
const jobRanking = require('@thinking/job_ranking');
const { BAND_POLICY } = require('@thinking/architect_config');
const { POOL_NAMES } = require('@utils/calculators/material_pool_calculator');

const TAG = 'dispatcher';

// Verifies BAND_POLICY's pool references against POOL_NAMES at load time — the one file that reads
// both, since architect_config may not import the calculator and the calculator has no business
// knowing about bands (Law 13).
for (const [band, policy] of Object.entries(BAND_POLICY)) {
    if (!POOL_NAMES.includes(policy.level_against)) {
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): BAND_POLICY['${band}'].level_against is `
            + `${JSON.stringify(policy.level_against)}, which is not a pool. The pools are `
            + `${POOL_NAMES.join(' | ')} — see @utils/calculators/material_pool_calculator.`);
    }
}

const MANAGER_MAP = {
    // A manager: spawn then teleport are each verified by sensing (same shape as eat_manager).
    respawn: 'death_manager',
    // TEMPORARY: the one job a body in running water holds (assessors/current).
    current: 'current_manager',
    supply:  'supply_manager',
    build:   'building_manager',
    mine:    'mining_manager',
    farm:    'farm_manager',
    // A managed job: re-senses to verify the bot is full before releasing (Law 17 / Invariant B).
    health:  'eat_manager',
    explore: 'exploration_executor',
    // One-shot; routes to recursive_judge with no manager stamp, so the next sweep re-plans fresh.
    furnace:   'furnace_executor',
    // One-shot; the executor remembers a declined drop's id so it is not re-offered (Invariant D).
    ground_salvage: 'ground_salvage_executor',
    // One-shot: a sector's scan, or one trip for stone open to the sky (assessors/survey).
    survey: 'survey_executor',
    // One-shot: withdraw the banked compostables, feed the composter, bank the bone meal.
    compost:   'compost_executor',
    // One-shot: withdraw a batch of banked farm saplings and plant them in the tree farm.
    plant:     'sapling_plant_executor',
    // One pass: take trash and scattered part stacks out of the chests, pit the trash, bank the rest whole.
    housekeeping: 'chest_housekeeping_executor',
    // One pass: walk to one anchor's stand in the standing home and register the fixtures it owns.
    home_stations: 'home_stations_executor',
    // A managed visit: carry torches, place the network's planned torches one at a time, re-planning after each.
    light:     'lighting_manager',
    // A managed hold: stand by a tandem worker through the night and take the mobs it declines.
    guard:     'guard_manager',
    // A managed herd: take one wheat, lead one animal into the crew's pen, leave it, bank the wheat.
    herd:      'herd_manager',
    // A managed hold: take one wheat, hold the penned flock at the long side while a tender works the pen, bank the wheat.
    shepherd:  'shepherd_manager',
    // A managed shearing: with a shepherd holding, shear the pen's woolly flock, leave, bank the wool.
    shear:     'shear_manager',
    // A managed cull: with a shepherd holding, slaughter a full meat pen's grown animals past its stock, leave, bank the produce.
    cull:      'cull_manager',
    // A managed feed: take two wheat, ask the server which penned animals can breed, feed one pair, bank the rest.
    breed:     'breed_manager',
    // A managed dyeing: take the dye and a wheat, dye the pen's white animals one color from outside the fence, bank the rest.
    dye:       'dye_manager',
    // One-shot: fell one wild tree on a structure's site before it is built.
    canopy:    'canopy_clear_executor',
    // One-shot: work one anchor cube from beneath, dig/place/return. No manager — the board
    // re-senses every sweep. Goes through preparation (places only from the pocket) first.
    column:    'column_preparation',
};

function _getBotId() {
    return process.env.BOT_ID || 'default';
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Job selection helpers
// ─────────────────────────────────────────────────────────────────────────────

// Fields a supply job must declare, finite and non-negative, to be fillable (job_board.supplyJob
// guarantees them) — checked here, the one place every job passes through (Law 13, Law 16).
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

// One read of the boardroom answers both which orders are claimed and how much of each is pledged —
// the magnet that carries the claim is the same magnet that carries the pledge (see `_claimJob`).
function _readPeerClaims(excludeBotId) {
    const boardroom = hq.getFullBoardroom({});
    const claimed = new Set();
    const pledges = [];
    const inbound = new Map();   // level_key → blocks peers have claimed work toward
    for (const [botId, chair] of Object.entries(boardroom)) {
        if (botId === excludeBotId) continue;
        const magnet = chair?.magnet;
        if (!magnet?.job_id) continue;
        claimed.add(magnet.job_id);
        if (magnet.pledge) pledges.push(magnet.pledge);
        // What this peer's claim is counted as bringing to the shelf its order levels against.
        const coming = magnet.pledge && Number.isFinite(magnet.pledge.amount) ? magnet.pledge.amount : magnet.seat_yield;
        if (magnet.level_key && coming > 0) inbound.set(magnet.level_key, (inbound.get(magnet.level_key) || 0) + coming);
    }
    return { claimed, pledges, inbound };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Magnet management
// ─────────────────────────────────────────────────────────────────────────────

// The magnet: advisory task-identity marker (taxonomy in foreman_brain.js), reliable because this
// write happens under the planning token — no peer is planning while it propagates.
function _claimJob(botId, job, pledge) {
    const existing = hq.readBoardroomChair(botId, {});
    existing.magnet = {
        job_id:      job.id,
        // When this claim was made: a claim's own budgets (sector_finder's scans) are counted against it.
        claimed_at:  Date.now(),
        type:        job.type,
        what:        job.what,
        where:       job.where || null,
        // The floor a deep seat digs nearest (assessors/mining, mining_manager).
        deep_y:      job.deep_y ?? null,
        // The crop a farm tend serves (assessors/farming ONE FARMER PER CROP).
        crop:        job.crop ?? null,
        // The other pens' animals a stranger cull kills, by entity id (assessors/ranching).
        strangers:   Array.isArray(job.strangers) ? job.strangers : null,
        // The three limits a breed round's pairs were the least of: half the pen, its room, the wheat (assessors/ranching).
        pairs_by:    job.pairs_by ?? null,
        // A level and an amount never share a name — magnet is a field whitelist (add here too).
        hold_goal:      job.hold_goal ?? null,
        // `hold_goal` is the destination total; `need` is the shortfall the pledge math uses
        // (supply_manager._anotherPledgeOpen).
        need:           job.need ?? null,
        // Who asked for each part of `hold_goal`, validated to sum to it (assessors/shared.supplyJob).
        goal_parts:     Array.isArray(job.parts) ? job.parts : null,
        // What this body pledges to bring back; peers subtract it from `need` (`_readPeerClaims`).
        pledge:        pledge || null,
        // Usable crafting stations at the claim, captured live so a mid-flight change reads as a moved
        // classification (release and replan), not a Law 13 throw (Law 16).
        stations_at_claim: require('@perception/station_registry').usableStationTypes(),
        at_destination: job.at_destination ?? null,
        batch_quantity: job.batch_quantity ?? null,
        hunger_goal:    job.hunger_goal ?? null,
        hunger_now:     job.hunger_now ?? null,
        destination: job.destination || null,
        // Which station row, by the registry's own key — avoids rebuilding it from `where` (Law 16).
        station_id:  job.station_id || null,
        // The shelf this order levels against and, for a seat with no pledge, what it is counted as bringing.
        level_key:   job.level_key || null,
        seat_yield:  job.seat_yield ?? null,
        source:      job.source || null,
        category:    job.category || null,
        tier:        job.tier || null,
        action:      job.action || null,
        anchor_index: job.anchor_index != null ? job.anchor_index : null,
        // A trip that only repairs its column's basement cell (assessors/downloaded_build.cellRepairs).
        cell_only:   !!job.cell_only,
        // `structure` names the building; `box` the site a felling clears. `line`/`column`+`anchor_index`
        // are site-claim identities, read off the world by the claiming executor (Invariant B).
        structure:   job.structure || null,
        box:         job.box || null,
        line:       job.line || null,
        column:      job.column != null ? job.column : null,
        // Which instance of a shared blueprint — farm_manager routes by it.
        conference_room_key: job.conference_room_key || null,
        // What the board decided, carried whole: job_type is identity, asker is the sweep's band
        // (Law 16), stage is distance-to-done. No `priority` field.
        job_type:    job.job_type || null,
        asker:       job.asker || null,
        stage:       job.stage || null,
        // What the board said the fleet could not get, frozen at the claim (same reason as
        // `stations_at_claim`) so a live re-read can't act on a list the board never saw.
        excluded:    job.excluded || null,
        chest_locks: [],
        // What this body has spoken for at a station (chest_ledger); clearMagnet() voids it with the
        // claim and every chest lock.
        bank_claim:  null,
        // Room this body has spoken for in the chests before walking to deposit (chest_ledger.claimRoom).
        deposit_claim: null,
        claimed_at:  new Date().toISOString(),
    };
    hq.writeBoardroomChair(botId, existing);
}

// ── A FIGHT HANDS THE JOB BACK, TWICE ───────────────────────────────────────────────────────────────
// A job a fight took from this body is taken up again at its next planning pass, while the board still offers it. The
// third fight in a row over one job replans, and so does a fight the body ran from or died in: its place is no longer safe or near.
const RESUMES_PER_JOB = 2;
let _fought = null;   // { id, times, armed }
function noteFightTookJob() {
    const id = hq.readBoardroomChair(_getBotId(), {}).magnet?.job_id;
    if (!id) { _fought = null; return; }
    const times = _fought && _fought.id === id ? _fought.times + 1 : 1;
    _fought = { id, times, armed: times <= RESUMES_PER_JOB };
}
function noteFightFled() { if (_fought) _fought.armed = false; }

function clearMagnet(botId) {
    if (!botId) botId = _getBotId();
    const existing = hq.readBoardroomChair(botId, {});
    if (existing.magnet) {
        existing.magnet = null;
        hq.writeBoardroomChair(botId, existing);
        watcher.summary(TAG, `Magnet cleared for bot ${botId}.`);
    }
    // No active task should let an object claim (anchor/tree/cell) survive it (Law 4 / Invariant D).
    // Real boundary: crosses the socket to the foreman, so a failure is the network's.
    const release = require('@utils/external_library_guard')
        .guardExternalSync(TAG, 'foreman releaseAllClaims', () => require('@kernel/foreman_link').releaseAllClaims());
    if (release.ok && release.value > 0) watcher.summary(TAG, `Released ${release.value} object claim(s) held by ${botId} on magnet clear.`);

    // Broadcast for the same reason the claim is: a peer reads this bot's chair only from the
    // foreman's relay (Law 4 / Invariant D, Invariant B).
    require('@utils/external_library_guard')
        .guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Main handler
// ─────────────────────────────────────────────────────────────────────────────

// Tells apart nothing outstanding (finished) from everything gated (waiting on daylight or stock),
// read from job_gates' own published flag (Law 16, Invariant D). Returns { reason, cause }: a
// sentence for a reader and a stable token for the park line and any instrument (Law 10).
function _emptyBoardReason() {
    const held = hq.readConfRoomFlag('job_board_room', 'jobs_held', null);
    if (!held || !(held.count > 0)) {
        return { reason: 'No jobs outstanding — nothing left to do.', cause: 'none_outstanding' };
    }
    // Named by gate and cause so a reader can act; `short_of` carries what arriving would release.
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
// footprint and arms the 10s re-check heartbeat so it wakes when a peer frees a job.
function _goIdle(botId, reason, cause) {
    // One log decision for the whole pass — this runs about once a second (Law 5 noise otherwise).
    const post = require('@kernel/idle_scheduler').shouldLogIdlePhase();
    if (post) watcher.summary(TAG, `${reason} (idle pass ${post.passes})`);
    // Opens the idle span in the minute ledger (idempotent across the once-a-second idle exit); the
    // cause travels with it so the trace line and ledger cannot disagree (Invariant D).
    require('@kernel/bot_minutes').idle(cause);
    clearMagnet(botId);
    routeSignal(TAG, 'idle_park', {
        readable: `${TAG}: ${reason} → idle_park`,
        log_idle_line: !!post,
        // The one bit for the park line (Law 5) — a reader still learns finished vs. waiting.
        idle_cause: cause,
    });
}

function _run() {
    const botId = _getBotId();
    // Clear any pending idle heartbeat so it can't fire a second signal (Law 4); idle_park re-arms.
    require('@kernel/idle_scheduler').cancel();
    // Same rule for the sentry watch — sets the preemption flag to release the scope (Law 4).
    require('@action/await_aggro.js').stop();
    const jobs = _readJobs();

    if (jobs.length === 0) {
        const verdict = _emptyBoardReason();
        _goIdle(botId, verdict.reason, verdict.cause);
        return;
    }

    const { claimed, pledges, inbound } = _readPeerClaims(botId);
    const unclaimed = jobs
        .filter(j => j.scope === 'local' || !claimed.has(j.id));

    // ── AN ORDER ALREADY PLEDGED IN FULL IS NOT WORK ───────────────────────
    // `scope: 'local'` orders are not exclusive, so this subtracts every live peer pledge from
    // `need` before the band walk (a filter, not a rank). Applies only where the quantity is the
    // fleet's (BAND_POLICY.goal) — a bot-band number is each body's own.
    const yieldPledge = require('@utils/calculators/yield_pledge_calculator');
    const fleetGoal = (j) => BAND_POLICY[j.asker]?.goal === 'fleet';
    const available = unclaimed.filter(j => !fleetGoal(j) || yieldPledge.stillOpen(j, pledges) > 0);

    if (available.length === 0) {
        const allPledged = unclaimed.length > 0;
        _goIdle(botId, allPledged
            ? `Every job this magnet attracts is already pledged in full by other bots — idle.`
            : `All jobs this magnet attracts are claimed by other bots — idle.`,
            allPledged ? 'pledged_by_peers' : 'claimed_by_peers');
        return;
    }

    // ── THE CHOICE ──────────────────────────────────────────────────────────────────────────────
    // `selectBand` returns one band's one rung; random spreads N bots over N equal jobs with no
    // arbiter (Law 4, Law 19). AMONG EQUALS, the one it has least of wins: one number per job, read
    // off the choosing body's own pocket, not a priority (never compares materials to each other).
    // The shelf it levels is the band's (BAND_POLICY), not always the pocket — a chest order means
    // "I want this in the chest"; a build order counts chest stock as available too.
    let equals = jobRanking.selectBand(available);
    // A build sequence is not a tie: `build_order` is each anchor cube's place in the building's
    // bottom-up rise (layer, then column); the lowest open number wins, arbiter settles races.
    const sequenced = equals.filter(j => Number.isFinite(j.build_order));
    if (sequenced.length === equals.length) {
        const first = Math.min(...sequenced.map(j => j.build_order));
        equals = sequenced.filter(j => j.build_order === first);
    }
    const levelPool = BAND_POLICY[equals[0].asker].level_against;
    const held = (j) => {
        // An order that states how full its material is (`level`, 0..1 — a downloaded building's orders and
        // the mine seats dug for it) is chosen by that. Every other order is read off the pool by its item.
        // No `what` (a descent) means no stock level to read — sits out at Infinity.
        // What peers have already claimed work toward counts as gathered: a shelf with twenty bodies on
        // their way to fill it is not the leanest shelf.
        if (Number.isFinite(j.level)) {
            const coming = j.level_key && j.level_need > 0 ? (inbound.get(j.level_key) || 0) / j.level_need : 0;
            return Math.min(1, j.level + coming);
        }
        if (typeof j.what !== 'string' || !j.what) return Infinity;
        return require('@utils/calculators/material_pool_calculator').countInPool(j.what, levelPool);
    };
    const stock = new Map(equals.map(j => [j, held(j)]));
    const lowest = Math.min(...stock.values());
    const leanest = equals.filter(j => stock.get(j) === lowest);
    // Among the leanest every open SEAT is one chance, so an order that can take many bodies and a job that
    // takes one are drawn in proportion to the bodies each can hold (yield_pledge_calculator's arithmetic).
    const seatsOpen = (j) => {
        if (!fleetGoal(j) || !yieldPledge.carriesPledge(j)) return 1;
        return Math.max(1, Math.ceil(yieldPledge.stillOpen(j, pledges) / yieldPledge.pledgeFor(j, pledges).amount));
    };
    const seats = leanest.map(seatsOpen);
    const leanestSeats = seats.reduce((n, s) => n + s, 0);
    let draw = Math.random() * leanestSeats;
    // A body's own survival, the preconditions band, comes before the job a fight took.
    const resumed = _fought && _fought.armed && equals[0].asker !== 'preconditions' ? available.find(j => j.id === _fought.id) : null;
    const job = resumed || leanest[seats.findIndex(s => (draw -= s) < 0)];
    if (resumed) watcher.summary(TAG, `FIGHT_RESUME job=${resumed.id} time=${_fought.times} of ${RESUMES_PER_JOB}`);
    if (_fought) { if (job.id === _fought.id) _fought.armed = false; else if (equals[0].asker !== 'preconditions') _fought = null; }
    const managerName = MANAGER_MAP[job.type];

    if (!managerName) {
        watcher.error(TAG, `Unknown job type '${job.type}' — no manager mapped.`);
        return;
    }

    // Sized once, here, so the magnet and the claim line can never disagree on it (Law 16).
    const pledge = fleetGoal(job) ? yieldPledge.pledgeFor(job, pledges) : null;

    // Ends the idle phase (if any), resetting the log gate for the next one.
    require('@kernel/idle_scheduler').noteDispatch();

    // Turns over the bot-minute ledger's span, labelled like the claim line and jobs lens (Law 16).
    require('@kernel/bot_minutes').dispatch(`${job.type}/${job.what}`);

    // A new magnet ends the task the old one named, so that task's object claims end with it — the
    // same sweep a cleared magnet runs.
    const prior = require('@utils/external_library_guard')
        .guardExternalSync(TAG, 'foreman releaseAllClaims', () => require('@kernel/foreman_link').releaseAllClaims());
    if (prior.ok && prior.value > 0) watcher.summary(TAG, `Released ${prior.value} object claim(s) held by ${botId} from its previous task.`);

    _claimJob(botId, job, pledge);

    const dest   = job.destination ? ` → ${job.destination}` : '';
    const src    = job.source      ? ` ← ${job.source}` : '';
    const act    = job.action === 'retrieve' ? ' RETRIEVE' : (job.action === 'deliver' ? ' DELIVER' : '');
    // Names the hold goal's askers on every claim (`parts` sums to `hold_goal`, assessors/shared.supplyJob).
    const breakdown = Array.isArray(job.parts) && job.parts.length > 1
        ? ` = ${job.parts.map(p => `${p.who} ${p.amount}`).join(' + ')}`
        : (Array.isArray(job.parts) && job.parts.length === 1 ? ` for ${job.parts[0].who}` : '');
    const qty    = job.need != null ? ` (need: ${job.need}, hold ${job.hold_goal}${breakdown})`
                 : job.batch_quantity != null ? ` (batch: ${job.batch_quantity})`
                 : '';
    // A random pick is inspectable only if the set it was made from is on the record (Law 6).
    const among = equals.length > 1
        ? ` · 1 of ${leanest.length} leanest (${levelPool} holds ${lowest}) of ${equals.length} equal · ${leanestSeats} seat(s) drawn from`
        : '';
    // What this claim takes off the board for its peers, next to what they had already pledged.
    const alreadyPledged = yieldPledge.pledgedAgainst(job, pledges);
    const pledged = pledge
        ? ` · pledges ${pledge.amount} ${pledge.what}${alreadyPledged ? ` (peers already pledged ${alreadyPledged} of ${job.need})` : ''}`
        : '';
    // Quotes the job's coordinates, matching the board line it was chosen from.
    watcher.summary(TAG,
        `Claimed [${jobRanking.describeBand(job)}] ${job.type}/${job.what}${act}${dest}${src}${qty} — dispatching to ${managerName}.${pledged}${among}`);

    // Real boundary — crosses a socket to the foreman, so a failure is the network's, not ours.
    require('@utils/external_library_guard')
        .guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());

    routeSignal(TAG, managerName, {
        job,
        readable: `${TAG}: [${jobRanking.describeBand(job)}] ${job.type}/${job.what} → ${managerName}`,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    noteFightTookJob,
    noteFightFled,
    // Releases the planning token on every exit path, only after _run() returns, so a claimed magnet
    // is rebroadcast before the token passes on (per-socket message order). Never reorder.
    receive(signalType, payload) {
        require('@utils/external_library_guard').withCleanupSync(
            TAG, 'planning pass',
            () => _run(),
            () => require('@kernel/foreman_link').releasePlanningToken());
    },
    clearMagnet,
    // supply_manager asks this mid-claim to decide whether another pledge is open on an order it is
    // already working — the same boardroom walk this module makes at claim time (Law 16).
    peerPledges(excludeBotId) { return _readPeerClaims(excludeBotId).pledges; },
    // Exported for fragment_registry's load-time completeness assert (see the note there). Nothing else
    // reads it — the dispatch path uses the module-local const directly.
    MANAGER_MAP,
};
