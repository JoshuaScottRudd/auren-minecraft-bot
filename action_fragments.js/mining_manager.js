// mining_manager.js
// Reads the mine job from the bot's magnet and dispatches to mining_executor, cell after cell on one
// descent while the body holds more than MINING_LAST_PICKAXE, then surfaces, dumps and releases.

'use strict';

const watcher         = require('@kernel/watcher');
const hq              = require('@kernel/corporate_headquarters');
const miningIntegrity = require('@perception/mining_integrity');
const blueprintSurvey = require('@perception/blueprint_survey');
const miningCellGraph = require('@perception/mining_cell_graph');
const locomotion      = require('@locomotion/locomotion_dispatcher');
const { dumpExcess, retrieveItems } = require('@api/inventory_swapper');
const { MINING_PASSES_PER_DISPATCH, MINING_LAST_PICKAXE } = require('@thinking/architect_config');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');

const TAG = 'mining_manager';

// Executor exit codes that end the batch without completing it — a required-block shortfall no
// further pass can fix. Surfacing lets job_board post the supply that unblocks it (Law 25).
const BATCH_BLOCKED_EXITS = new Set(['pocket_short']);

// Tool gate is count-based: mining is allowed as long as at least one pickaxe is in inventory.
// Exported so job_board's toolGate reads the same predicate (Law 16).
function hasPickaxe(bot) {
    if (!bot || !bot.inventory) return { ok: false, reason: 'bot/inventory not ready' };
    const count = bot.inventory.items().filter(i => i && i.name && i.name.endsWith('_pickaxe')).length;
    if (count === 0) return { ok: false, reason: 'no pickaxe in inventory' };
    return { ok: true, count };
}

// The trip's bound. A body below ground takes the next cell (or segment) only while it holds MORE than
// MINING_LAST_PICKAXE, so the last pickaxe is always in hand for finishing the piece it is on; at the
// last one it surfaces with its cell closed instead of leaving a half-dug room for a peer.
// The pickaxes are the trip's only bound of its own: a tunnel uncovers ore a block at a time, so the body stays on
// its line and brings up whatever the line gave.
function keepsDigging(bot) {
    const held = hasPickaxe(bot);
    if (!held.ok) return held;
    if (held.count > MINING_LAST_PICKAXE) return { ok: true, count: held.count };
    return { ok: false, count: held.count, reason: `down to the last pickaxe (${held.count}) — surfacing to restock` };
}

// A body enters the mine carrying the pocket's full pickaxe set — the `pickaxe` bot row's deficit_below of
// any tier, or its stone_level of stone-or-better — then digs on while hasPickaxe holds, down to the last
// one. Stone pickaxes on the shelf count, since the body takes them at dispatch (takeMiningPicks).
// Read by job_gates.toolGate for mining jobs.
function _pickaxeRow() {
    const { STOCK_THRESHOLDS } = require('@thinking/architect_config');
    return STOCK_THRESHOLDS.find(r => r.item === 'pickaxe' && r.holder === 'bot') || { deficit_below: 1 };
}
function _stonePicks(bot) {
    const { stoneOrBetter } = require('@thinking/assessors/shared');
    const inv = {};
    for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count;
    return stoneOrBetter('pickaxe', inv);
}
function canEnterMine(bot) {
    const row = _pickaxeRow();
    const count = hasPickaxe(bot).count || 0;
    const stone = _stonePicks(bot);
    const shelf = SHELF_PICKS.reduce((n, pick) => n + require('@kernel/inventory_lens').inChests(pick), 0);
    if (count >= row.deficit_below) return { ok: true, count };
    if (row.stone_level && stone + shelf >= row.stone_level) return { ok: true, count };
    return { ok: false, count, reason: `${count} pickaxe(s) carried (${stone} stone, ${shelf} on the shelf) — `
        + `the mine takes ${row.deficit_below}${row.stone_level ? ` or ${row.stone_level} stone` : ''}` };
}

// The shelf's mining pickaxes, best first.
const SHELF_PICKS = ['copper_pickaxe', 'stone_pickaxe'];

// takeMiningPicks — the trip's stone pickaxes, withdrawn from the shelf by the body about to descend, up to
// the row's stone_level. Returns true, or null when the withdrawal already abandoned to the judge (Law 15).
async function takeMiningPicks(bot) {
    const row = _pickaxeRow();
    if (!row.stone_level) return true;
    let took = 0;
    for (const pick of SHELF_PICKS) {
        const onShelf = require('@kernel/inventory_lens').inChests(pick);
        const short = row.stone_level - _stonePicks(bot);
        if (short > 0 && pick === 'stone_pickaxe') require('@thinking/assessors/shared').noteShelfShort(pick, onShelf, short, 'mining_trip');
        const want = Math.min(onShelf, short);
        if (want <= 0) continue;
        const got = await retrieveItems(bot, pick, want);
        if (got === undefined) return null;
        took += want;
    }
    if (took === 0) return true;
    // The exchange: with the stone set in hand, the wooden pickaxes it replaces go to the waste pit.
    await require('@api/waste_pit').discardTrash(bot);
    return true;
}

// The torches one trip carries to place in passing: the shaft's torch cells that hold no torch now
// (mining_integrity.shaftTorchNeed), up to what a pocket keeps (the `torch` bot row). A lit shaft asks for
// none. Light is optional — a trip goes with whatever the body could craft, including none.
function miningTorchNeed(bot) {
    const { STOCK_THRESHOLDS } = require('@thinking/architect_config');
    const pocket = STOCK_THRESHOLDS.find(r => r.item === 'torch' && r.holder === 'bot').dump_threshold;
    return Math.min(pocket, miningIntegrity.shaftTorchNeed(bot));
}

function hasMiningLight(bot) {
    if (!bot || !bot.inventory) return { ok: false, reason: 'bot/inventory not ready' };
    const need = miningTorchNeed(bot);
    const count = bot.inventory.items()
        .filter(i => i && i.name === 'torch')
        .reduce((n, i) => n + (i.count || 0), 0);
    if (count < need) {
        return { ok: false, reason: `${count} torches, need ${need}`, count, need };
    }
    return { ok: true, count };
}

// takeMiningLight — the trip's torches, crafted by the body about to descend: coal first, then charcoal, from
// its pocket and then the chests, over a stick it holds or makes from its planks. It crafts the trip's need
// and no more; what a craft makes over that stays in the pocket (the `torch` bot row). Light is optional, so a
// body with no fuel or no wood goes without and the trip is never refused.
// Returns true, or null when a withdrawal or the craft already abandoned to the judge (Law 15).
const TORCH_FUELS = ['coal', 'charcoal'];
const TORCHES_PER_CRAFT = 4;
async function takeMiningLight(bot) {
    const light = hasMiningLight(bot);
    if (light.ok) return true;
    const held = (test) => bot.inventory.items().filter(i => i && test(i.name)).reduce((n, i) => n + (i.count || 0), 0);
    const crafts = Math.ceil((light.need - light.count) / TORCHES_PER_CRAFT);
    let fuel = held(n => TORCH_FUELS.includes(n));
    for (const source of TORCH_FUELS) {
        const want = Math.min(require('@kernel/inventory_lens').inChests(source), crafts - fuel);
        if (want <= 0) continue;
        if (await retrieveItems(bot, source, want) === undefined) return null;
        fuel = held(n => TORCH_FUELS.includes(n));
    }
    // A stick is two planks.
    const sticks = held(n => n === 'stick'), planks = held(n => n.endsWith('_planks'));
    if (fuel < 1 || (sticks < 1 && planks < 2)) {
        watcher.summary(TAG, `mining light: ${light.count}/${light.need} torches held and none crafted — ${fuel} coal or charcoal, ${sticks} stick(s), ${planks} planks in hand; descending without.`);
        return true;
    }
    const made = await require('@api/craft_handler').craftItems(bot, 'torch', light.need);
    return made === undefined ? null : true;
}

// takeShaftFill — the shaft's wall fill, withdrawn as cobblestone before the body descends: every fill block
// the staircase needs (mining_integrity.shaftFillNeed) less the fill already in the pocket, so a shaft beside a
// cave seals it in one trip. Takes what the shelf holds and never refuses the trip.
// Returns true, or null when the withdrawal already abandoned to the judge (Law 15).
async function takeShaftFill(bot) {
    const { group_to_item } = require('@utils/fragment_utils');
    const fill = new Set(group_to_item.structural_fill);
    const need = miningIntegrity.shaftFillNeed(bot);
    const held = bot.inventory.items().filter(i => i && fill.has(i.name)).reduce((n, i) => n + (i.count || 0), 0);
    const onShelf = require('@kernel/inventory_lens').inChests('cobblestone');
    const want = Math.min(onShelf, need - held);
    if (want <= 0) return true;
    watcher.summary(TAG, `shaft: ${need} wall cell(s) to fill, ${held} fill held — taking ${want} cobblestone`);
    const got = await retrieveItems(bot, 'cobblestone', want);
    return got === undefined ? null : true;
}

// ─────────────────────────────────────────────────────────────────────────────

// Releases to recursive_judge for pre-dispatch gate failures, before the bot has descended.
// Post-mining releases go through _exitMine instead, which surfaces and dumps first.
// The strip tunnel this body holds for its trip (foreman 'line:' key), released when the trip ends.
// ── A BODY WALKS THE MINE BY ITS TUNNELS ─────────────────────────────────────────────────────────────
// The tunnel a body works is entered and left by named points (mining_cell_graph.wayOut): the foot of the
// shaft's stairs where its trunk begins, then the mouth of its branch on that trunk. Each is its own walk, so
// the route between two of them is the tunnel that joins them. `_way` is the way out of the tunnel this body
// is in, nearest point first; empty on the surface.
let _way = [];
async function _walkWay(bot, points, direction) {
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const nav = await locomotion.goToStand(p, { exact: false, purpose: `mine:${direction}` });
        const arrived = !(!nav || nav.arrived === false);
        watcher.summary(TAG, `MINE WAY ${direction} leg=${i + 1} of=${points.length} to=(${p.x},${p.y + 1},${p.z}) arrived=${arrived}`);
        if (!arrived) return false;
    }
    return true;
}

let _heldLine = null;
function _releaseLine() {
    if (!_heldLine) return;
    require('@kernel/foreman_link').releaseClaim(_heldLine);
    _heldLine = null;
}

function _release(reason) {
    _releaseLine();
    watcher.summary(TAG, `Releasing: ${reason}`);
    routeToJudge(TAG, { readable: `${TAG}: ${reason}` });
}

// Re-dispatches the executor for the next pass of the same batch, without a replan. Bumps the pass
// counter and re-stamps the manager on the payload's existing job fields. Not used for the first
// dispatch, which routes to the shaft head first.
function _redispatch(payload, passesCompleted, readable) {
    routeSignal(TAG, 'mining_executor', {
        ...payload,
        manager: TAG,
        mining_pass: passesCompleted,
        readable,
    });
}

// Selects, hazard-gates, claims, and dispatches one buildable cell. Returns a verdict since the
// caller decides which release applies (fresh claim releases plainly; mid-batch surfaces first via
// _exitMine). Failed-selection side effects (markCellBlocked) live here with the selection.
async function _selectAndDispatchCell(payload, bot, miningPass) {
    const N = MINING_PASSES_PER_DISPATCH;
    // A peer-held cell is skipped, not waited on — replan instead of retry (Law 13).
    const heldByPeer = new Set();
    while (true) {
        const candidate = miningCellGraph.selectNextCell(bot, heldByPeer);
        if (!candidate) {
            return { dispatched: false, allHeld: heldByPeer.size > 0, reason: heldByPeer.size > 0
                ? `dig_cell: all ${heldByPeer.size} candidate cell(s) held by peers — replanning`
                : 'dig_cell: no buildable cell' };
        }

        const go = await _dispatchCandidate(payload, bot, candidate, miningPass);
        if (go.held) { heldByPeer.add(candidate.id); continue; }
        return go;
    }
}

// Hazard-gates, claims and dispatches ONE named cell. Returns { dispatched, cell } or { dispatched:false, reason },
// with held:true when a peer holds its claim (the fan selection above then tries the next one).
async function _dispatchCandidate(payload, bot, candidate, miningPass) {
    const N = MINING_PASSES_PER_DISPATCH;
    {
        // Re-scans before committing since the cell was registered buildable on a past scan. Unloaded
        // chunk defers (Law 13, environmental); a real hazard is blocked so selection skips it from now on.
        const scan = miningCellGraph.scanCell(bot, candidate.anchor, candidate);
        if (!scan.safe) {
            if (scan.halt_reason === 'unloaded') {
                return { dispatched: false, reason: `dig_cell: cell ${candidate.id} chunk unloaded — deferring` };
            }
            miningCellGraph.markCellBlocked(candidate.id, scan.halt_reason);
            return { dispatched: false, reason: `dig_cell: cell ${candidate.id} blocked (${scan.halt_reason}) — skipping` };
        }

        // Physical exclusivity on the cell, claimed at execution time from live perception (taxonomy
        // in foreman_brain.js). Required lazily, matching `receive` — require's cache makes the repeat free.
        const foremanLink = require('@kernel/foreman_link');
        // ONE BODY, ONE TUNNEL: a strip segment is worked only under its line's claim, taken (or renewed) here and held
        // until the trip ends, so no peer is handed the segment beyond a body still working the line. A repair of a
        // segment already dug takes the same claim: the stand for segment N is the far end of segment N-1, which the
        // line's holder closes to peers while it works there (cellWorkBox), so a second body has nowhere to stand.
        let freshLine = null;
        if (miningCellGraph.isStrip(candidate)) {
            const key = miningCellGraph.lineKey(candidate);
            const line = await foremanLink.requestClaim(key);
            if (!line.granted) return { dispatched: false, held: true, reason: `dig_cell: line ${key} worked by a peer` };
            if (_heldLine !== key) { _releaseLine(); _heldLine = key; freshLine = key; }
        }
        const claim = await foremanLink.requestClaim(`cell:${candidate.id}`);
        if (!claim.granted) {
            if (freshLine) _releaseLine();
            return { dispatched: false, held: true, reason: `dig_cell: cell ${candidate.id} held by a peer` };
        }

        // A tunnel this body is not already in is entered by the shaft and then by its way in.
        const way = miningCellGraph.wayOut(candidate);
        if (freshLine && way.length) {
            await _routeToShaftHead(bot);
            await _walkWay(bot, [...way].reverse(), 'in');
        }
        _way = way;

        const cell = candidate;
        watcher.summary(TAG, `Dispatching mining_executor for cell ${cell.id} @ (${cell.anchor.x},${cell.anchor.y},${cell.anchor.z}) — pass ${miningPass + 1}/${N} on this cell, ${hasPickaxe(bot).count} pickaxes in hand.`);
        routeSignal(TAG, 'mining_executor', {
            ...payload,
            manager: TAG,
            mining_pass: miningPass,
            dig_cell: { id: cell.id, anchor: cell.anchor, fan: cell.fan, maintenance: !!cell.maintenance, kind: cell.kind, dir: cell.dir, k0: cell.k0 },
            readable: `${TAG}: dig_cell ${cell.id}${cell.maintenance ? ' (maintain)' : ''} → mining_executor`,
        });
        return { dispatched: true, cell };
    }
}

// Ends the batch: returns to the shaft head, dumps excess into the headframe chests, then releases
// to recursive_judge. Returning first puts the bot at the chests and starts the next job from the
// surface. Reuses the one dump primitive dump_executor calls (Law 16).
async function _exitMine(bot, site, reason) {
    _releaseLine();
    const way = _way; _way = [];
    await _walkWay(bot, way, 'out');
    const back = await _returnToHeadframe(bot);
    if (!back.skipped && !back.arrived) {
        // A blocked exit is environmental (Law 13): logs and releases from the current position, so the
        // bot stays reachable by the next job.
        watcher.warn(TAG, 'could not surface to the headframe on batch exit — releasing from current position');
    }
    // An abandoned dump has already routed to the judge, so releasing after it would put two live
    // signals in one scope (Law 4). Skip the release when the dump abandons.
    const dumped = await dumpExcess(bot);
    if (dumped?.abandoned) return;
    _release(reason);
}

// Routes the bot to the shaft head (headframe ANCHOR 0) before the executor descends, so entry follows
// the existing staircase. Skipped once already below the entry.
// locomotion.goTo is a Law 15 sub-loop API that owns its own movement retries.
const SHAFT_ENTRY_SKIP_DEPTH = 2;   // blocks below the head: already in the mine, skip re-surfacing
const HEADFRAME_BLUEPRINT = 'headframe';

// transpose_origin is a geometry datum (the Y origin blueprint voxels are transposed around), not
// a place to stand — it lands inside the built structure. Read it for geometry only; navigate to
// an ANCHOR via goToStand(). Anchor 0 is the headframe's shaft head, resolved live since
// set_buildspot may re-site the base between batches.
function _shaftHeadAnchor() {
  // Checks whether the headframe is sited before calling getWorldAnchors, since an unsited headframe
  // is an ordinary early-run state, not a defect to catch (Law 13, Law 16).
  const blueprinter = require('@perception/mining_blueprinter');
  const site = blueprinter.shaftChair();
  if (!site) {
    watcher.warn(TAG, 'shaft-head anchor unavailable (shaft not sited yet) — skipping the shaft-head trip this batch.');
    return null;
  }
  // A standalone shaft (a builder's) has no headframe to stand on: the stand is the ground block
  // just west of the top joint, since the descent runs east from it. Unverified on a live run.
  if (blueprinter.shaftStructure() !== HEADFRAME_BLUEPRINT) {
    const a = blueprinter.shaftTop(site);
    return { x: a.x - 1, y: a.y, z: a.z };
  }
  const anchors = blueprintSurvey.getWorldAnchors(HEADFRAME_BLUEPRINT);
  return (anchors && anchors[0]) || null;
}
async function _routeToShaftHead(bot) {
    const head = _shaftHeadAnchor();
    if (!bot || !bot.entity || !bot.entity.position || !head) return { arrived: true, skipped: true };
    if (bot.entity.position.y < head.y - SHAFT_ENTRY_SKIP_DEPTH) return { arrived: true, skipped: true };
    // goToStand, not goTo: an ANCHOR names the block the feet rest ON (feet cell = anchor+(0,1,0)).
    const nav = await locomotion.goToStand(head);
    return { arrived: !(!nav || nav.arrived === false), skipped: false };
}

// Mirror of _routeToShaftHead, climbing out at batch end; skips when already at/above the head.
// locomotion.goTo (Law 15 sub-loop API) returns arrived=false; it does not route its own signal.
async function _returnToHeadframe(bot) {
    const head = _shaftHeadAnchor();
    if (!bot || !bot.entity || !bot.entity.position || !head) return { arrived: true, skipped: true };
    if (bot.entity.position.y >= head.y - SHAFT_ENTRY_SKIP_DEPTH) return { arrived: true, skipped: true };
    // Same anchor, same reason as _routeToShaftHead above — and the same transpose_origin trap avoided.
    const nav = await locomotion.goToStand(head);
    return { arrived: !(!nav || nav.arrived === false), skipped: false };
}

module.exports = {
    hasPickaxe,
    canEnterMine,
    miningTorchNeed,
    receive: watcher.track(TAG, async function (signalType, payload) {
        if (signalType !== TAG) return;
        const foremanLink = require('@kernel/foreman_link');

        const botId = process.env.BOT_ID || 'default';
        const magnet = hq.readBoardroomChair(botId, {})?.magnet;

        if (!magnet || !magnet.what) {
            _release('no active magnet');
            return;
        }

        // Verify shaft site is locked
        const site = require('@perception/mining_blueprinter').shaftChair();
        if (!site) {
            _release('staircase site not locked — the foreman sites the shaft first');
            return;
        }

        const jobWhat = magnet.what;

        // ── Return from recursive_judge: executor finished one pass ──────
        // Re-dispatches for the next pass of the same batch, or ends the batch (surface, dump,
        // release) when the work is done/stuck, the body is at its last pickaxe, or a cell/segment hit MINING_PASSES_PER_DISPATCH re-passes.
        // `passesCompleted` rides the round trip on payload.mining_pass.
        if (payload.from === 'recursive_judge') {
            const bot = global.bot;
            const passesCompleted = (payload.mining_pass || 0) + 1;
            const capReached = passesCompleted >= MINING_PASSES_PER_DISPATCH;
            const N = MINING_PASSES_PER_DISPATCH;

            if (jobWhat === 'dig_shaft') {
                // Re-scans to see whether the shaft still needs work; mining_executor owns built_segments,
                // so the re-scan surfaces the next incomplete segment.
                const er = (payload.mining_executor || {}).exit_reason;
                let complete = false;
                let reason = '';
                if (BATCH_BLOCKED_EXITS.has(er)) {
                    complete = true;
                    reason = `shaft pass ${passesCompleted}/${N}: ${er} — ending the batch, a re-pass cannot supply it`;
                }
                // The upkeep pass works the whole finished shaft once; the trip ends with it, and damage it
                // could not settle reposts the job.
                if (er === 'shaft_pass') {
                    complete = true;
                    reason = `whole-shaft upkeep pass done — ${(payload.mining_executor || {}).steps_remaining || 0} step(s) left`;
                }
                if (!complete && bot && bot.blockAt) {
                    const integrity = miningIntegrity.scan(bot, null);
                    if (integrity.all_segments_complete) { complete = true; reason = 'shaft complete'; }
                    else { const seg = integrity.first_incomplete; reason = `segment pass ${passesCompleted}/${N} done — next: y=${seg?.world_position?.y || '?'}`; }
                } else if (!complete) { complete = true; reason = 'bot not ready after pass'; }
                // The body starts the next segment only while it holds more than the last pickaxe (keepsDigging);
                // at the last one it surfaces, and the next trip down takes the shelf's stone pickaxes (takeMiningPicks).
                const tool = keepsDigging(bot);
                if (!complete && !tool.ok) { complete = true; reason = `shaft pass ${passesCompleted}: ${tool.reason}`; }

                // THE BODY THAT OWNS THE SHAFT STAYS DOWN while each pass moves a block: it works segment after
                // segment top down and carries the shaft's fill (takeShaftFill), so surfacing between segments
                // only spends the walk. Past the pass cap, a pass that moved nothing ends the trip, so a segment
                // the world will not let settle is left, and the reposted job brings a body back to try again.
                const m = (payload.mining_executor || {}).metrics || {};
                const keepsGoing = er === 'segment_cap' && ((m.dig_ok || 0) + (m.place_ok || 0)) > 0;
                if (complete || (capReached && !keepsGoing)) { await _exitMine(bot, site, reason); return; }
                _redispatch(payload, passesCompleted, `${TAG}: dig_shaft pass ${passesCompleted + 1}/${N} → mining_executor`);
                return;
            }

            // ── dig_cell return: the executor finished one cell pass ─────────
            // Completion is the integrity diff (capsule.cell_clean): clean → complete, register neighbours,
            // end batch; shrinking → re-pass up to the cap; not shrinking → stuck, block for inspection
            // (Law 13). The claim is held across re-passes, released only when the batch ends.
            if (jobWhat === 'dig_cell') {
                const cell = payload.dig_cell;
                const capsule = payload.mining_executor || {};
                if (!cell || !cell.id) { await _exitMine(bot, site, 'dig_cell return: no cell on payload'); return; }

                // maintenance:true means this dispatch is repairing an already-complete cell, not
                // carving a new one; a stuck repair stays marked complete, leaving the field untouched.
                const maintenance = !!cell.maintenance;

                if (capsule.cell_clean) {
                    foremanLink.releaseClaim(`cell:${cell.id}`);
                    miningCellGraph.markCellComplete(cell.id);
                    // Growth completion grows the A* frontier; a maintenance repair does not
                    // (its neighbours were registered when it first completed — idempotent, skip).
                    const rec = (!maintenance && bot && bot.blockAt) ? miningCellGraph.getCell(cell.id) : null;
                    const added = rec ? miningCellGraph.registerNeighbors(bot, rec) : 0;
                    const reason = maintenance
                        ? `cell ${cell.id} repaired (diff clean)`
                        : `cell ${cell.id} complete (diff clean) — ${added} neighbour(s) registered`;
                    // A clean cell does not end the trip: the batch takes the next selectable cell from
                    // where the bot stands, paying the descent once for as many cells as the pickaxes last.
                    // The trip is bounded by tools (keepsDigging) — a body at its last pickaxe surfaces here,
                    // with its cell closed; the re-pass count restarts at zero for the next cell.
                    // Surfaces otherwise only when nothing is selectable; _exitMine dumps on the way out.
                    const tool = keepsDigging(bot);
                    // A STRIP TRIP KEEPS TO ITS LINE: the fan chose where this trip began; from there the body digs
                    // the same tunnel straight on until its pickaxes run out or the line ends — a cave, a hazard,
                    // the staircase, or a peer already on it — and then carries the whole haul up at once.
                    if (tool.ok && rec && miningCellGraph.isStrip(rec)) {
                        const ahead = miningCellGraph.lineContinuation(rec);
                        const ends = !ahead ? 'nothing registered ahead' : ahead.blocked ? `blocked (${ahead.blocked})` : ahead.complete ? 'already dug' : null;
                        const go = ends ? null : await _dispatchCandidate(payload, bot, ahead, 0);
                        if (go && go.dispatched) {
                            watcher.summary(TAG, `STRIP LINE ${rec.kind} ${rec.dir} ${rec.id} -> ${ahead.id} — ${tool.count} pickaxes in hand, same line.`);
                            return;
                        }
                        const why = ends || go.reason;
                        watcher.summary(TAG, `STRIP LINE END ${rec.kind} ${rec.dir} at ${rec.id}: ${why} — surfacing with the haul.`);
                        await _exitMine(bot, site, `${reason} — line ends: ${why}`);
                        return;
                    }
                    // A REPAIR ENDS THE TRIP AT ITS OWN CELL. The next damaged cell can lie in the tunnel beside this
                    // one, and the short way there is through the wall this pass just sealed; the body surfaces by
                    // the tunnel it is in, and that cell is reached from the gallery on its own trip.
                    if (tool.ok && maintenance) {
                        await _exitMine(bot, site, `${reason} — a repair trip ends at its cell`);
                        return;
                    }
                    if (tool.ok) {
                        const next = await _selectAndDispatchCell(payload, bot, 0);
                        if (next.dispatched) {
                            watcher.summary(TAG, `${reason} — ${tool.count} pickaxes in hand, continuing this trip at cell ${next.cell.id}.`);
                            return;
                        }
                        await _exitMine(bot, site, `${reason}; ${next.reason}`);
                        return;
                    }
                    await _exitMine(bot, site, `${reason} — ${tool.reason}`);
                    return;
                }

                const remaining = capsule.cell_remaining ?? Infinity;
                const prev = miningCellGraph.recordCellRemaining(cell.id, remaining);

                // The last pickaxe worn out inside the cell: the room is unfinished for want of a tool, not
                // unreachable, so it keeps its progress and its buildable standing and the body surfaces to
                // restock; the board re-selects it. Only a no-shrink pass WITH a pickaxe is a stuck cell.
                if (!hasPickaxe(bot).ok) {
                    foremanLink.releaseClaim(`cell:${cell.id}`);
                    await _exitMine(bot, site, `cell ${cell.id} left open at ${remaining} step(s) — no pickaxe left to finish it, surfacing to restock`);
                    return;
                }

                if (!(remaining < prev)) {
                    // No shrink across passes means the remaining voxels are unreachable. Blocks for
                    // inspection (Law 13); a stuck repair blocks as 'maint_stuck' so it stays skipped
                    // but inspectable.
                    foremanLink.releaseClaim(`cell:${cell.id}`);
                    const stuck = maintenance ? 'maint_stuck' : 'stuck';
                    miningCellGraph.markCellBlocked(cell.id, stuck);
                    watcher.warn(TAG, `cell ${cell.id} ${maintenance ? 'repair ' : ''}stuck — ${remaining} step(s) unreachable after a no-progress pass; blocked (${stuck}) for inspection.`);
                    await _exitMine(bot, site, `cell ${cell.id} ${stuck} (${remaining} unreachable) — blocked`);
                    return;
                }

                // Shrinking: more progress is possible. Re-passes the same cell up to the cap, then
                // surfaces; job_board may re-select it later since progress is recorded.
                if (capReached) {
                    foremanLink.releaseClaim(`cell:${cell.id}`);
                    await _exitMine(bot, site, `cell ${cell.id} ${maintenance ? 'repairing' : 'progressed'} — re-pass cap (${N}) on this cell reached, ${remaining} step(s) left`);
                    return;
                }
                _redispatch(payload, passesCompleted, `${TAG}: dig_cell ${cell.id} re-pass ${passesCompleted + 1}/${N} (${remaining} left) → mining_executor`);
                return;
            }

            throw new Error(`[${TAG}] CODING VIOLATION (Law 13): a mining job returned with what="${jobWhat}"; `
                + 'assessors/mining posts only dig_shaft and dig_cell.');
        }

        // ── First dispatch from dispatcher ───────────────────────────────

        // Tool gating happens once, in job_board (toolGate). The light is the board's promise that the shelf
        // can light this trip (assessors/mining); the body collects it here, before it walks to the shaft.
        if (await takeMiningPicks(global.bot) === null) return;
        if (await takeMiningLight(global.bot) === null) return;
        if (jobWhat === 'dig_shaft' && await takeShaftFill(global.bot) === null) return;

        // Routes to the shaft head before any executor descends. An unreachable headframe is environmental
        // (caved access, a stranded bot), so this soft-releases to the judge.
        const head = await _routeToShaftHead(global.bot);
        if (!head.arrived) {
            _release('headframe access unreachable — cannot enter the mine via the shaft head');
            return;
        }

        // ── dig_shaft: check if shaft still needs work ───────────────────
        if (jobWhat === 'dig_shaft') {
            const bot = global.bot;
            if (bot && bot.blockAt) {
                const integrity = miningIntegrity.scan(bot, null);
                if (integrity.all_segments_complete) {
                    _release('shaft complete');
                    return;
                }
                // A frontier the body cannot read has no step to give an executor: the body stands out of sight
                // of the shaft. The claim goes back and the body goes to idle_park, which walks it home; the
                // board offers the shaft again from there.
                const frontier = integrity.first_incomplete;
                if (frontier && Array.isArray(frontier.steps) && frontier.steps.length === 0) {
                    const reason = `shaft frontier ${frontier.id || integrity.frontier_id} has no step to work yet (its cells are not loaded) — going home`;
                    _releaseLine();
                    const verdict = await require('@kernel/portable_judge').checkpoint(TAG, `idle: ${reason}`, 'forgiving');
                    if (verdict === false) return;
                    watcher.summary(TAG, reason);
                    require('@thinking/dispatcher.js').clearMagnet();
                    routeSignal(TAG, 'idle_park', { readable: `${TAG}: ${reason} → idle_park` });
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
        // Selects, hazard-gates (scanCell, Law 17), and dispatches the executor with the cell
        // stamped on the payload; the recursive_judge-return branch above completes it.
        if (jobWhat === 'dig_cell') {
            const bot = global.bot;
            if (!bot || !bot.blockAt) { _release('dig_cell: bot not ready'); return; }

            // Pass 0 — the first cell of a fresh surface trip. The bot has not descended yet, so a
            // failed selection takes the plain release; _exitMine's surface-and-dump applies once
            // underground.
            const picked = await _selectAndDispatchCell(payload, bot, 0);
            if (!picked.dispatched && picked.allHeld) miningCellGraph.noteAllHeldByPeers();
            if (!picked.dispatched) _release(picked.reason);
            return;
        }

        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): a mining job arrived with what="${jobWhat}"; `
            + 'assessors/mining posts only dig_shaft and dig_cell.');
    }),
};
