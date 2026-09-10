// mining_manager.js
// Manager. Reads the mine job from the bot's magnet, dispatches to mining_executor one integrity
// pass at a time, and OWNS the batch loop: it runs the executor MINING_PASSES_PER_DISPATCH times
// back-to-back — repair-or-dig one staircase segment, or one cell pass, each time — then returns the
// bot to the headframe, dumps excess, and releases to recursive_judge so job_board can replan.
//
// WHY the manager owns the loop: the executor used to batch shaft segments
// itself while cells replanned through job_board every pass — two mechanisms for the same "do it a
// few times before surfacing" need (Law 16 smell). Now the manager plays job_board's dispatch role N
// times locally for BOTH shaft and cell: after each executor pass it either RE-DISPATCHES the same
// executor (no replan) or, when the work is done / stuck / the batch cap is hit, ENDS the batch by
// surfacing + dumping + releasing. A cell re-passes the SAME cell (holding its claim) until its diff
// is clean or it stops shrinking; the shaft advances one segment per pass.
//
// WHY surface on every batch end: each hand-back is a fork where the brain may pick a SURFACE job
// (wheat farm, build). A bot handing back deep in the shaft makes the next task's pathfinder carve a
// fresh diagonal toward its target (cheaper than climbing the staircase), scarring the ground. So the
// manager climbs back to the shaft head before releasing; the storage chests live there, so dumping
// excess rides free on a trip already being made (return FIRST, dump SECOND — the walk stands on its
// own because a pass may have nothing over-keep to dump yet still be deep).

'use strict';

const watcher         = require('@kernel/watcher');
const hq              = require('@kernel/corporate_headquarters');
const miningIntegrity = require('@perception/mining_integrity');
const blueprintSurvey = require('@perception/blueprint_survey');
const miningCellGraph = require('@perception/mining_cell_graph');
const locomotion      = require('@locomotion/locomotion_dispatcher');
const { dumpExcess }  = require('@api/inventory_swapper');
const { MINING_PASSES_PER_DISPATCH } = require('@thinking/architect_config');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');

const TAG = 'mining_manager';

// Executor stop codes that END THE BATCH WITHOUT COMPLETING IT. A third category beside "done" and
// "keep going": the pass is unfinished and says why, and the reason is one no further pass can change —
// the bot is short a REQUIRED block, so descending again runs the identical pass against the identical
// empty pocket. Batching past it is how an honest shortfall still becomes a loop: the executor reports
// material_short, the manager re-passes to the cap, the job releases, the board re-derives the same
// segment, and the judge is once again the only party that notices. Ending here surfaces the bot so
// job_board can post the supply that unblocks it (Law 25 — the outcome is carried, not retried past).
const BATCH_BLOCKED_EXITS = new Set(['material_short']);

// Tool gate is COUNT-based, not durability-based: the bot
// maintains 2 pickaxes per tier (job_board crafting targets) and consumes the most-
// worn one first (fragment_utils tool selection). Mining is allowed as long as at
// least ONE pickaxe is in inventory — when down to its last it finishes on that one
// while job_board crafts a replacement back up to 2. Only a count of ZERO blocks
// dispatch, so the bot never strip-mines with bare hands. No durability math needed.
//
// EXPORTED because job_board must gate the mining POST on it. The board and the manager have to agree on
// "may this bot mine" or the disagreement becomes a loop: the board posts, the dispatcher claims, this
// manager releases on the gate, the board posts the same job again — five identical outcomes and
// recursive_judge kills the bot. Whether that loop is REACHABLE depends on the shaft's rank relative to
// crafting_tool (6): under it a pickaxe-less bot always crafts one first and the two cannot disagree
// in practice; over it they can. One predicate, one answer (Law 16) — held on both sides so the next
// renumber is merely wrong rather than fatal. Same pairing the staircase-lock gate already uses.
function hasPickaxe(bot) {
    if (!bot || !bot.inventory) return { ok: false, reason: 'bot/inventory not ready' };
    const count = bot.inventory.items().filter(i => i && i.name && i.name.endsWith('_pickaxe')).length;
    if (count === 0) return { ok: false, reason: 'no pickaxe in inventory' };
    return { ok: true, count };
}

// LIGHT GATE — the twin of the tool gate above, and it guards the fleet's oldest recorded death spiral
// rather than a slow dig. An unlit shaft spawns hostiles at depth; a bot that dies underground drops its
// whole pocket at the bottom, so the material the descent was FOR never surfaces, and the next descent
// starts poorer than the last. That loop cannot be broken from inside the mine.
//
// THE NUMBER IS READ FROM THE STOCK ROW, NEVER TYPED HERE. The supply system already defends a torch
// floor; a second constant would let the gate and the row disagree, and the failure that produces is
// silent in both directions — a gate above the row's floor holds the bot out of the mine forever while
// supply reports the pocket satisfied, and a gate below it authorises a descent supply never intended.
// One number, one owner (Law 16).
//
// EXPORTED for the same reason hasPickaxe is: assessors/mining posts the job and this releases it, and
// a board that posts what the manager refuses is a claim/release loop the judge ends in five sweeps.
//
// COVERS EVERY MINING JOB, not dig_shaft alone (Architect 2026-08-27: "we are law 16 the whole mining
// system"). The dispatch path below is the single door for shaft, cell and material alike, so the gate
// belongs on the door and not on one of the jobs coming through it — a per-job gate is the same rule
// written twice, and the second copy is the one that gets forgotten when a third mining verb arrives.
function hasMiningLight(bot) {
    if (!bot || !bot.inventory) return { ok: false, reason: 'bot/inventory not ready' };
    const { STOCK_THRESHOLDS } = require('@thinking/architect_config');
    const row = STOCK_THRESHOLDS.find(r => r.item === 'torch' && r.holder === 'bot');
    // Law 13 coding violation: the gate is meaningless without the row it reads, and defaulting to a
    // number here would be this file quietly authoring the floor the config owns.
    if (!row || typeof row.deficit_below !== 'number') {
        throw new Error('mining_manager: no bot torch row in STOCK_THRESHOLDS — the light gate has no floor to read');
    }
    const count = bot.inventory.items()
        .filter(i => i && i.name === 'torch')
        .reduce((n, i) => n + (i.count || 0), 0);
    if (count < row.deficit_below) return { ok: false, reason: `${count} torches, need ${row.deficit_below}`, count, need: row.deficit_below };
    return { ok: true, count };
}

// ─────────────────────────────────────────────────────────────────────────────

// Release back to recursive_judge (as a manager → the judge routes to job_board for a replan). This
// is the plain release used for pre-dispatch gate failures, where the bot has not descended. The
// batch-END release (after real mining) goes through _exitMine, which surfaces and dumps first.
function _release(reason) {
    watcher.summary(TAG, `Releasing: ${reason}`);
    routeToJudge(TAG, { readable: `${TAG}: ${reason}` });
}

// Re-dispatch the executor for the NEXT pass of the SAME batch: the manager
// plays job_board's dispatch role locally, so no replan happens between passes. The payload already
// carries the job-specific fields (dig_cell / mining_objective) from the first dispatch — they rode
// the round trip through recursive_judge — so this only bumps the pass counter and re-stamps the
// manager. NOT called on the first dispatch (that path routes to the shaft head first); mid-batch the
// bot is already deep and must stay there.
function _redispatch(payload, passesCompleted, readable) {
    routeSignal(TAG, 'mining_executor', {
        ...payload,
        manager: TAG,
        mining_pass: passesCompleted,
        readable,
    });
}

// Select → hazard-gate → claim → dispatch ONE buildable cell.
//
// EXTRACTED so a batch can run several DIFFERENT cells per descent, matching the shaft: without this a
// cell batch means three passes at the SAME cell, so a cell that comes out clean on pass one ends the
// trip — the shaft gets three segments per descent while cells get one, from the same cap. The
// completion branch now calls this again instead of exiting, which is also what makes the batch-end dump
// frequent enough to be the fleet's whole offload story — the trip ends at the chests every N cells, not
// every N passes at one cell.
//
// RETURNS a verdict instead of releasing itself, because the caller owns which release is correct and the
// two differ: on a fresh claim the bot has not descended (plain _release), mid-batch it is deep and must
// surface and dump first (_exitMine). Releasing in here would have picked one and been wrong half the
// time. Side effects of a failed selection (markCellBlocked) stay here — they belong to the selection.
async function _selectAndDispatchCell(payload, bot, miningPass) {
    const N = MINING_PASSES_PER_DISPATCH;
    // Selection loop with object locking: a peer-held cell is neither complete nor blocked — it is
    // someone else's object right now (lock the object, not the bot). Skip it and take the next nearest;
    // never wait on a peer (Law 13: replan, not a retry loop).
    const heldByPeer = new Set();
    while (true) {
        const candidate = miningCellGraph.selectNextCell(bot, heldByPeer);
        if (!candidate) {
            return { dispatched: false, reason: heldByPeer.size > 0
                ? `dig_cell: all ${heldByPeer.size} candidate cell(s) held by peers — replanning`
                : 'dig_cell: no buildable cell' };
        }

        // The cell was registered buildable on a PAST scan; re-scan before committing the bot. Unloaded
        // → defer (Law 13 environmental, not a reject). A real hazard → mark it blocked so selection
        // skips it from now on, then release to re-select.
        const scan = miningCellGraph.scanCell(bot, candidate.anchor);
        if (!scan.safe) {
            if (scan.halt_reason === 'unloaded') {
                return { dispatched: false, reason: `dig_cell: cell ${candidate.id} chunk unloaded — deferring` };
            }
            miningCellGraph.markCellBlocked(candidate.id, scan.halt_reason);
            return { dispatched: false, reason: `dig_cell: cell ${candidate.id} blocked (${scan.halt_reason}) — skipping` };
        }

        // Arbiter flavor (a) — physical exclusivity on the cell, chosen at execution time from live
        // perception (the planning token can't cover it; taxonomy in overseer_brain.js).
        // Lazily required here as well as in `receive` — the two are separate functions, and this helper
        // had been reading `receive`'s binding, which it never had. Every claim threw a ReferenceError, and
        // the guard that used to stand here reported it as an errored claim and returned undispatched, so no
        // cell was mined for a day while the log read like ordinary contention (Law 13, Law 16). Kept lazy to
        // match `receive`: require's cache makes the repeat free.
        const overseerLink = require('@kernel/overseer_link');
        const claim = await overseerLink.requestClaim(`cell:${candidate.id}`);
        if (!claim.granted) { heldByPeer.add(candidate.id); continue; }

        const cell = candidate;
        watcher.summary(TAG, `Dispatching mining_executor for cell ${cell.id} @ (${cell.anchor.x},${cell.anchor.y},${cell.anchor.z}) — cell ${miningPass + 1}/${N} of this trip.`);
        routeSignal(TAG, 'mining_executor', {
            ...payload,
            manager: TAG,
            mining_pass: miningPass,
            dig_cell: { id: cell.id, anchor: cell.anchor, fan: cell.fan, maintenance: !!cell.maintenance },
            readable: `${TAG}: dig_cell ${cell.id}${cell.maintenance ? ' (maintain)' : ''} → mining_executor`,
        });
        return { dispatched: true, cell };
    }
}

// End the batch: climb back to the shaft head, dump excess into the headframe chests, then release
// to recursive_judge. Return FIRST so the bot is standing at the chests (making the dump a reachable,
// zero-extra-travel offload) and so whatever job runs next starts from the surface, never from deep in
// the shaft. dumpExcess is a no-op when nothing is over-keep, so the surface walk is the load-bearing
// step; the dump rides along. Reuses the ONE dump primitive (Law 16), the same call dump_executor makes.
async function _exitMine(bot, site, reason) {
    const back = await _returnToHeadframe(bot);
    if (!back.skipped && !back.arrived) {
        // Caved/blocked access out is environmental (Law 13): log and release from where we are rather
        // than strand the bot underground. The next task degrades to whatever path it can find.
        watcher.warn(TAG, 'could not surface to the headframe on batch exit — releasing from current position');
    }
    // The batch exit carries the same latent double-route as the executors: a dump that abandons has
    // ALREADY routed to the judge, so releasing after it would put two live signals in one scope
    // (Law 4). It rarely fires here because mining is the only caller and the chests are rarely contested
    // at surfacing time — but an abandoned line is dead, and the release is what would revive it, so the
    // same guard applies: skip the release when the dump abandons.
    const dumped = await dumpExcess(bot);
    if (dumped?.abandoned) return;
    _release(reason);
}

// Enter the mine THROUGH the headframe, never by digging straight down. Before the executor takes
// over, walk the bot to the shaft head (the headframe's ANCHOR 0 — see the warning below) so descent
// follows the existing staircase access instead of a fresh vertical hole from wherever a prior
// surface task left it. The shaft-wall A* penalty
// (mining_integrity.getProtectedBlocks) already nudges door-entry, but a long straight-down
// shortcut out-competes that soft cost when the bot is far — routing to the head first makes
// entry-via-access a hard step, and it is a surface walk (head and bot both at surface), so it
// never itself digs down. SKIPPED when the bot is already below the entry (mid-descent, or working
// a cell underground) so underground work is never dragged back to the surface. locomotion.goTo is
// a Law 15 sub-loop API — a direct call that owns its own movement retries.
const SHAFT_ENTRY_SKIP_DEPTH = 2;   // blocks below the head ⇒ already in the mine, do not re-surface
const HEADFRAME_BLUEPRINT = 'headframe';

// ⚠ NEVER NAVIGATE TO `build_center`. IT IS NOT A PLACE — IT IS A DATUM.
// build_center is the origin the blueprint's voxels are transposed AROUND (blueprint_survey's
// transposeVoxel/transposeAnchorsForCandidate math). Nothing guarantees it is standable, and in
// practice it is the opposite: it lands inside the finished structure, so it is a BUILT, PROTECTED
// voxel. A* prices a protected voxel at PROTECTED_VOXEL_DETOUR_BUDGET and has no total-cost cap, so it must prove no
// route cheaper than that budget exists before returning one — which means expanding the entire reachable set.
// Targeting build_center burns the full node budget on every call — expanding the entire reachable set
// to prove no cheaper route exists — and still only returns PARTIAL at a residual the arrival tolerance
// accepts anyway, so the search cost buys nothing. Read build_center for GEOMETRY (a Y datum, a
// transposition origin); never hand it to
// locomotion. The place a bot may stand is an ANCHOR, and the way to stand on one is goToStand().
//
// Anchor 0 is the headframe's shaft head. Resolved live rather than cached because set_buildspot may
// re-site the base between batches, and a remembered anchor would walk the bot to the old shaft.
function _shaftHeadAnchor() {
  // ASKS whether the headframe is sited rather than provoking getWorldAnchors' coding violation and
  // catching it. Mining can be dispatched before the base locks, so an unsited headframe is an ordinary
  // early-run state and belongs in a predicate; a throw out of the transpose is a defect that must travel
  // (Law 13, Law 16 — a catch is never the expected pathway). Same chair getWorldAnchors reads.
  const site = hq.readBuildingChair(HEADFRAME_BLUEPRINT, 'set_buildspot');
  if (!site?.build_center || typeof site.build_center.x !== 'number') {
    watcher.warn(TAG, 'shaft-head anchor unavailable (headframe not sited yet) — skipping the headframe trip this batch.');
    return null;
  }
  const anchors = blueprintSurvey.getWorldAnchors(HEADFRAME_BLUEPRINT);
  return (anchors && anchors[0]) || null;
}
async function _routeToShaftHead(bot) {
    const head = _shaftHeadAnchor();
    if (!bot || !bot.entity || !bot.entity.position || !head) return { arrived: true, skipped: true };
    if (bot.entity.position.y < head.y - SHAFT_ENTRY_SKIP_DEPTH) return { arrived: true, skipped: true };
    // goToStand, never goTo: an ANCHOR names the block the feet rest ON, so the feet cell is anchor+(0,1,0),
    // and goToStand is the one home for that +1.
    const nav = await locomotion.goToStand(head);
    return { arrived: !(!nav || nav.arrived === false), skipped: false };
}

// Mirror image of _routeToShaftHead, used at batch END to climb OUT to the shaft head. Where the
// entry guard skips when the bot is deep (leave underground work alone), this exit skips when the bot
// is already at/above the head (nothing to climb). Going UP naturally prefers the existing staircase:
// the head sits at the top of it, so walking the stairs out-competes digging a parallel diagonal — the
// diagonal shortcut only wins for LATERAL moves to a distant surface target, which is exactly the scar
// this exit prevents by surfacing here first. locomotion.goTo is a Law 15 sub-loop API owning its own
// movement retries; it returns arrived=false (never routes its own signal) so _exitMine decides.
async function _returnToHeadframe(bot) {
    const head = _shaftHeadAnchor();
    if (!bot || !bot.entity || !bot.entity.position || !head) return { arrived: true, skipped: true };
    if (bot.entity.position.y >= head.y - SHAFT_ENTRY_SKIP_DEPTH) return { arrived: true, skipped: true };
    // Same anchor, same reason as _routeToShaftHead above — and the same build_center trap avoided.
    const nav = await locomotion.goToStand(head);
    return { arrived: !(!nav || nav.arrived === false), skipped: false };
}

module.exports = {
    hasPickaxe,
    hasMiningLight,
    receive: watcher.track(TAG, async function (signalType, payload) {
        if (signalType !== TAG) return;
        const overseerLink = require('@kernel/overseer_link');

        const botId = process.env.BOT_ID || 'default';
        const magnet = hq.readBoardroomChair(botId, {})?.magnet;

        if (!magnet || !magnet.what) {
            _release('no active magnet');
            return;
        }

        // Verify shaft site is locked
        const site = hq.readBuildingChair('headframe', 'set_buildspot');
        if (!site?.build_center || !site?.staircase) {
            _release('staircase site not locked — building must find headframe first');
            return;
        }

        const jobWhat = magnet.what;

        // ── Return from recursive_judge: executor finished ONE pass ──────
        // The manager owns the batch loop: after each pass it either RE-
        // DISPATCHES the executor for the next pass of the same batch (no replan) or ENDS the batch —
        // surfacing, dumping, and releasing to job_board. A batch ends when the work is done/stuck OR
        // MINING_PASSES_PER_DISPATCH passes have run. `passesCompleted` counts passes done so far; it
        // rides the round trip on payload.mining_pass (recursive_judge preserves ...payload back to the
        // stamped manager, the same channel dig_cell/mining_objective ride).
        if (payload.from === 'recursive_judge') {
            const bot = global.bot;
            const passesCompleted = (payload.mining_pass || 0) + 1;
            const capReached = passesCompleted >= MINING_PASSES_PER_DISPATCH;
            const N = MINING_PASSES_PER_DISPATCH;

            if (jobWhat === 'dig_shaft') {
                // Re-scan to see whether the shaft still needs work. Complete or a scan failure ends the
                // batch; otherwise advance one more segment (up to the cap). The executor already
                // registered the segment it just dug (mining_executor owns built_segments), so the
                // re-scan naturally surfaces the NEXT incomplete segment for the following pass. The
                // executor also reports early satisfaction (deficiency_met) when this pass already
                // gathered everything the brain's pull-list needed — end the batch then, so a shaft dig
                // that was really about the cobble/ore it yields doesn't over-mine (preserves the
                // executor's original early-return; the batch cap never over-rides a met need).
                const er = (payload.mining_executor || {}).exit_reason;
                let complete = er === 'deficiency_met' || er === 'objective_met';
                let reason = complete ? `shaft pass ${passesCompleted}/${N}: ${er}` : '';
                if (BATCH_BLOCKED_EXITS.has(er)) {
                    complete = true;
                    reason = `shaft pass ${passesCompleted}/${N}: ${er} — ending the batch, a re-pass cannot supply it`;
                }
                if (!complete && bot && bot.blockAt) {
                    const integrity = miningIntegrity.scan(bot);
                    if (integrity.all_segments_complete) { complete = true; reason = 'shaft complete'; }
                    else { const seg = integrity.first_incomplete; reason = `segment pass ${passesCompleted}/${N} done — next: y=${seg?.world_position?.y || '?'}`; }
                } else if (!complete) { complete = true; reason = 'bot not ready after pass'; }

                if (complete || capReached) { await _exitMine(bot, site, reason); return; }
                _redispatch(payload, passesCompleted, `${TAG}: dig_shaft pass ${passesCompleted + 1}/${N} → mining_executor`);
                return;
            }

            // ── dig_cell return: the executor finished one cell pass ─────────
            // Completion is decided by the INTEGRITY DIFF the executor re-ran (capsule.cell_clean), NOT
            // by progress — a cell is a maintained blueprint, done ⇔ its diff is clean. Three outcomes
            // drive the batch:
            //   clean          → complete: mark + register the 3 outward neighbours (A* growth). END batch.
            //   still shrinking → re-pass the SAME cell (the bot carved deeper and can reach more next
            //                     pass) — RE-DISPATCH, up to the cap; the claim is HELD across the batch.
            //   NOT shrinking   → stuck: a voxel no reachable stand can carve. Block it (Law 13 —
            //                     surface for inspection, don't silently grow neighbours off a half-cell).
            //                     END batch.
            // The object claim is released only when the batch ENDS (complete / stuck / cap) — held
            // across re-passes so a peer can't take the cell mid-progress.
            if (jobWhat === 'dig_cell') {
                const cell = payload.dig_cell;
                const capsule = payload.mining_executor || {};
                if (!cell || !cell.id) { await _exitMine(bot, site, 'dig_cell return: no cell on payload'); return; }

                // maintenance:true = this dispatch was repairing an already-complete cell (a damaged
                // built cell surfaced by selectMaintenanceCell), not carving a new one. It stays
                // complete either way; a stuck repair must NOT un-complete or re-grow the field.
                const maintenance = !!cell.maintenance;

                if (capsule.cell_clean) {
                    overseerLink.releaseClaim(`cell:${cell.id}`);
                    miningCellGraph.markCellComplete(cell.id);
                    // Growth completion grows the A* frontier; a maintenance repair does not
                    // (its neighbours were registered when it first completed — idempotent, skip).
                    const rec = (!maintenance && bot && bot.blockAt) ? miningCellGraph.getCell(cell.id) : null;
                    const added = rec ? miningCellGraph.registerNeighbors(bot, rec) : 0;
                    const reason = maintenance
                        ? `cell ${cell.id} repaired (diff clean)`
                        : `cell ${cell.id} complete (diff clean) — ${added} neighbour(s) registered`;
                    // A CLEAN CELL NO LONGER ENDS THE TRIP. The claim is already released and the cell
                    // marked, so the batch may take the next one from where the bot stands — the descent
                    // is paid once for N cells, which is the whole point of the batch (and is what the
                    // shaft has always done with segments). Only when the cap is reached, or nothing is
                    // selectable, does the bot surface — and _exitMine dumps at the chests on the way
                    // out, which is why mining needs no dump JOB competing for the bot.
                    if (!capReached) {
                        const next = await _selectAndDispatchCell(payload, bot, passesCompleted);
                        if (next.dispatched) {
                            watcher.summary(TAG, `${reason} — continuing this trip at cell ${next.cell.id}.`);
                            return;
                        }
                        await _exitMine(bot, site, `${reason}; ${next.reason}`);
                        return;
                    }
                    await _exitMine(bot, site, `${reason} — batch cap (${N}) reached`);
                    return;
                }

                const remaining = capsule.cell_remaining ?? Infinity;
                const prev = miningCellGraph.recordCellRemaining(cell.id, remaining);

                if (!(remaining < prev)) {
                    // No shrink across passes: the remaining voxels are unreachable from any stand the
                    // bot can get to. Block for inspection rather than fake-complete (Law 13). A stuck
                    // REPAIR blocks as 'maint_stuck' so it's skipped (bounded) yet stays inspectable;
                    // the cell is still physically built, just can't finish this repair.
                    overseerLink.releaseClaim(`cell:${cell.id}`);
                    const stuck = maintenance ? 'maint_stuck' : 'stuck';
                    miningCellGraph.markCellBlocked(cell.id, stuck);
                    watcher.warn(TAG, `cell ${cell.id} ${maintenance ? 'repair ' : ''}stuck — ${remaining} step(s) unreachable after a no-progress pass; blocked (${stuck}) for inspection.`);
                    await _exitMine(bot, site, `cell ${cell.id} ${stuck} (${remaining} unreachable) — blocked`);
                    return;
                }

                // Shrinking — more progress possible. Re-pass the same cell up to the cap, then surface
                // (job_board may re-select it later for another batch; progress is recorded, so it resumes).
                if (capReached) {
                    overseerLink.releaseClaim(`cell:${cell.id}`);
                    await _exitMine(bot, site, `cell ${cell.id} ${maintenance ? 'repairing' : 'progressed'} — batch cap (${N}) reached, ${remaining} step(s) left`);
                    return;
                }
                _redispatch(payload, passesCompleted, `${TAG}: dig_cell ${cell.id} re-pass ${passesCompleted + 1}/${N} (${remaining} left) → mining_executor`);
                return;
            }

            // ── mine_material return: targeted dig for a specific item ───────
            // The executor stops early (exit_reason) once the objective is met or the shaft is
            // exhausted; otherwise batch more passes toward the target, up to the cap.
            // exit_reason is set on a real pass; a zero-work dispatch reports its stop code on
            // .result instead (executor's segmentsProcessed===0 branch), so read both.
            const capsule = payload.mining_executor || {};
            const er = capsule.exit_reason || capsule.result;
            const done = BATCH_BLOCKED_EXITS.has(er)
                || er === 'objective_met' || er === 'deficiency_met' || er === 'shaft_complete' || er === 'no_work' || er === 'no_steps';
            const reason = `${jobWhat} pass ${passesCompleted}/${N}: ${er || 'complete'}`;
            if (done || capReached) { await _exitMine(bot, site, reason); return; }
            _redispatch(payload, passesCompleted, `${TAG}: mine ${jobWhat} re-pass ${passesCompleted + 1}/${N} → mining_executor`);
            return;
        }

        // ── First dispatch from dispatcher ───────────────────────────────

        // Tool gate: every mining job (dig_shaft / dig_cell / mine_material) breaks
        // blocks, so require at least one pickaxe BEFORE dispatching. Without this the
        // executor strip-mines with bare hands when the pickaxe breaks — agonizingly
        // slow. Refusing here releases to recursive_judge → job_board, whose crafting
        // tiers will produce a fresh pickaxe (Law 13: environmental shortage, soft-fail).
        const pick = hasPickaxe(global.bot);
        if (!pick.ok) {
            _release(`mining blocked: ${pick.reason} — need a pickaxe before digging`);
            return;
        }

        // Light gate: see hasMiningLight. Same shape as the tool gate — release to the judge, which
        // replans; the torch row is active, so the board answers a released descent with the craft that
        // unblocks it (Law 13: environmental shortage, soft-fail).
        const light = hasMiningLight(global.bot);
        if (!light.ok) {
            _release(`mining blocked: ${light.reason} — no descent without torches`);
            return;
        }

        // Return to the headframe before the executor descends (covers every mining job — shaft,
        // cell, material). An unreachable headframe is environmental (a caved access or a stranded
        // bot), so soft-release to the judge with a stable readable it can count, rather than let
        // the executor dig straight down from a bad position.
        const head = await _routeToShaftHead(global.bot);
        if (!head.arrived) {
            _release('headframe access unreachable — cannot enter the mine via the shaft head');
            return;
        }

        // ── dig_shaft: check if shaft still needs work ───────────────────
        if (jobWhat === 'dig_shaft') {
            const bot = global.bot;
            if (bot && bot.blockAt) {
                const integrity = miningIntegrity.scan(bot);
                if (integrity.all_segments_complete) {
                    _release('shaft complete');
                    return;
                }
            }

            watcher.summary(TAG, 'Dispatching mining_executor for dig_shaft');
            routeSignal(TAG, 'mining_executor', {
                ...payload,
                manager: TAG,
                mining_pass: 0,   // batch pass counter — first pass of a fresh surface trip
                readable: `${TAG}: dig_shaft → mining_executor`,
            });
            return;
        }

        // ── dig_cell: strip-mine the nearest buildable fractal cell ──────
        // Select (D6) → fresh hazard gate (scanCell, Law 17) → dispatch the executor with
        // the cell stamped on the payload. The executor generates + diffs + digs it; the
        // recursive_judge-return branch above marks it complete + registers neighbours.
        if (jobWhat === 'dig_cell') {
            const bot = global.bot;
            if (!bot || !bot.blockAt) { _release('dig_cell: bot not ready'); return; }

            // Pass 0 — the first cell of a fresh surface trip. The bot has not descended yet, so a
            // failed selection takes the plain release rather than _exitMine's surface-and-dump.
            const picked = await _selectAndDispatchCell(payload, bot, 0);
            if (!picked.dispatched) _release(picked.reason);
            return;
        }

        // ── mine_material: dispatch mining_executor for a specific item ──
        watcher.summary(TAG, `Dispatching mining_executor for ${magnet.hold_goal || 1}x ${jobWhat}`);
        routeSignal(TAG, 'mining_executor', {
            ...payload,
            manager: TAG,
            mining_pass: 0,   // batch pass counter — first pass of a fresh surface trip
            mining_objective: { item: jobWhat, hold_goal: magnet.hold_goal || 1 },
            readable: `${TAG}: mine ${magnet.hold_goal || 1}x ${jobWhat} → mining_executor`,
        });
    }),
};
