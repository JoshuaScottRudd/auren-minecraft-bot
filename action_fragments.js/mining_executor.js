// fragment: mining_executor (action / mining)
// purpose: Excavate (and repair) staircase copies + cells until the dispatch's need is
//          met or a segment cap is hit, then route to recursive_judge.
//
//   ANCHORED STATIONARY MODEL (Item 5 / D3): mining builds the SAME way building does —
//   blueprint + integrity diff → dig/place repair, driven by mining_integrity exactly as
//   building is driven by building_integrity. Per segment (processSegment) the bot stands at
//   each of the copy's anchor stand-spots (a staircase copy carries per-copy anchors from the
//   blueprinter; a cell has its single floor-center anchor) and dig-all (top-down) then
//   place-all (bottom-up) WITHIN REACH — the shared anchored_repair primitive (@api/anchored_
//   repair) owns that control flow. There is no anchorless descent, no one-Y-per-pass, no
//   reposition drain loop, no CHEAT_ADJACENCY hybrid — those were mining's second, bespoke
//   build pathway (Law 16 violation), now deleted. Enclosed corners cheat-place via the
//   primitive's findAttachable path, same as cells and building.
//
//   ONE PASS PER DISPATCH: the executor processes exactly one real segment (or one cell), collects
//   drops, diffs its inventory against the brain's outstanding deficiencies (job_board_room.
//   materials_needed_pull, or a targeted mine_material objective), and routes to recursive_judge. The
//   BATCH of passes per surface trip is owned by the MANAGER (mining_manager loops this executor
//   MINING_PASSES_PER_DISPATCH times back-to-back before surfacing — Architect 2026-07-12), so the
//   executor no longer descends multiple segments itself. It still surfaces the deficiency-met signal
//   in the capsule (exit_reason) so the manager can end the batch early once the need is satisfied.
//
//   FILL_PREFERENCE reseal (D2) stays: a cave still grazes a staircase wall, and mining_integrity
//   keeps the descent repaired exactly as building_integrity keeps a building repaired.

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');

const { sleep, normalizeBlockName, group_to_item, getBotInventory } = require('@utils/fragment_utils');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { performDig } = require('@utils/movement/dig_authority');
const { performPlace } = require('@utils/movement/place_authority');
const { microCenter } = require('@utils/movement/motion_primitives');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { isAir } = require('@utils/movement/terrain_predicates');
const { isGravityBlock } = require('@utils/gravity_utils');

const miningIntegrity = require('@perception/mining_integrity');
const { collectNearby } = require('@api/drop_collector.js');
// The stationary dig-all/place-all routine is shared with build_executor (Law 16 / D3 —
// one repair primitive under two separate executors). mining_executor supplies the mining-
// domain mechanics (FILL_PREFERENCE resolution, gravity-column dig) as callbacks; the
// primitive owns the anchor control flow (reach gate, corner cheat, retry, tally).
const anchoredRepair = require('@api/anchored_repair');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');

// ── Tuning ───────────────────────────────────────────────────────────────────
const STEP_WAIT_MS = 200;
const PLACE_MAX_ATTEMPTS = 3;
const CENTER_EPS = 0.18;
const CENTER_TAP_MS = 90;
const CENTER_MAX_ITERS = 20;

// MAX_SEGMENTS_PER_DISPATCH — the executor does exactly ONE real segment per dispatch; the
// BATCH of passes per surface trip is owned by the manager now (mining_manager runs this executor
// MINING_PASSES_PER_DISPATCH times back-to-back, then surfaces — Architect 2026-07-12). Keeping the
// executor to one pass makes shaft and cell dispatches the same atomic unit (one integrity pass) and
// lets the manager control the loop uniformly instead of the shaft batching here while cells batched
// through job_board. The bot still returns EARLIER the moment its deficiency is satisfied (deficiencyMet);
// this cap bounds the single-pass unit. Already-built frontiers are skipped WITHOUT counting against
// the cap (they mark-built and `continue`), so one dispatch still lands on one real segment.
const MAX_SEGMENTS_PER_DISPATCH = 1;

// Exit reasons that mean the dispatch DID what it was for, even with rock still standing: the goal was
// reached (deficiency/objective), the shaft is finished, or there was no work to begin with. Every other
// exit ('segment_cap') is a win only if the segment it worked came out clean — see the capsule below.
//
// This exists because capsule.success is the judge's loop input and NOTHING else reads it (verified
// round 41: recursive_judge:252 is the sole reader of the payload capsule). It was hardcoded `true`,
// which spent the field: the judge's signature is (from, success, readable), so a constant collapses it
// to (from, readable) and the trace records "Success: true" on a dead loop. Modelled on
// build_executor:714 (`success = exitReason === 'all_complete'`) — the honest pattern already in the
// codebase, not a new one.
const GOAL_EXITS = new Set(['no_work', 'no_steps', 'shaft_complete', 'objective_met', 'deficiency_met']);

// Hard ceiling on repeat-digs of a single gravity-affected position (D13 §2). A
// falling gravel/sand column N tall needs N successful digs to exhaust; underground
// pockets are short, so this bounds a pathological column without truncating a real
// one. Hitting the cap is a warn — the position is retried next scan pass.
const MAX_GRAVITY_DIGS = 64;

// Solid-fill candidates for a structural_fill (wall/stair) reseal. Reads the canonical structural
// order rather than a local copy (Law 16) — this was one of five independent definitions of "what is a
// construction block", and the only one anybody re-tuned.
//
// ORDER — Architect, 2026-07-20: "mineshaft placement uses cobblestone preferred then planks, then
// dirt." That INVERTS the old local order, which put natural stone and dirt first because they are free.
// WHY the inversion is worth the material: a resealed wall is only protectable if the bot can tell it
// placed it. Cobblestone does not generate in the shaft, so a cobblestone wall reads as OUR work and a
// second dig through it costs PROTECTED_VOXEL_DETOUR_BUDGET; a wall resealed in natural stone or dirt is indistinguishable
// from the rock around it, stays cheap to dig, and the bot can breach its own repair forever
// (fragment_utils' provenance note). Planks before logs: a log is 4 planks, so spending a plank wastes
// nothing while spending a log wastes three.
//
// THE FALLBACK IS NOT A GUARANTEE, and reading it as one is what cost a run. This list once carried the
// claim that the plank/log entries made a breach "always sealable" and a deadlock impossible. That was
// true only while the bot actually CARRIED one of these, which is a stock-table property, not a property
// of this list — the moment cobblestone's keep went to zero the pocket emptied on every dump, planks ran
// to their floor, and a seven-breach cave grazing the shaft left a segment that could neither seal nor
// stand down. What holds the guarantee up is the cobblestone keep in architect_config plus the
// material_short exit below, which reports the shortfall instead of retrying into it. A member list
// cannot promise availability.
// No `||` fallback: the group is a module constant in this repo, so an absent one is a coding violation
// and not an environmental failure. The literal that stood here was a fourth hand-maintained fill order
// that would have substituted itself silently on a boot nobody was told about (Law 13, Law 16).
const FILL_PREFERENCE = group_to_item.structural_fill;
const SOLID_FILL_TOKENS = new Set(['structural_fill']);

// Place steps the bot may DEFER when the item is not in inventory (needs upstream crafting/smelting) —
// torches, furnace. structural_fill is deliberately absent: a breach is real damage and deferring it
// would let a half-walled segment register as built. When the fill is genuinely absent the segment does
// not defer, it exits material_short (below) — a reported shortfall rather than a silent skip. Names are
// normalized before lookup (the primitive maps wall_torch→torch).
const MINING_OPTIONAL = new Set(['torch', 'soul_torch', 'furnace']);
const EMPTY_STATION_SET = new Set();  // mining places no stations — the primitive's station gate never fires

// Same rendering as anchored_repair's own short line, so a reader following one shortfall from the
// primitive's log up through the exit reason and into the judge's kill sees one shape, not three.
function describeShort(shortMaterials) {
  return Object.entries(shortMaterials || {}).map(([m, c]) => `${c}×${m}`).join(', ') || 'nothing';
}


function resolveItemName(bot, token) {
  const items = bot.inventory?.items?.() || [];
  const has = name => items.some(i => i.name === name && i.count > 0);
  const normalized = normalizeBlockName(token);
  if (normalized === 'torch') return has('torch') ? 'torch' : null;
  if (SOLID_FILL_TOKENS.has(token)) return FILL_PREFERENCE.find(has) || null;
  return has(token) ? token : null;
}

// ── Decision transparency (Law 6) ──────────────────────────────────────────────
// REASON_WHY — plain-English rationale for each step reason mining_integrity stamps on a
// dig/place step. Surfaced in the per-segment decision manifest so a watcher reader sees WHY
// each block was chosen, not just an opaque code. Keys mirror the reason strings emitted by
// mining_integrity.scanSegment EXACTLY — keep the two in sync if either changes.
const REASON_WHY = {
  carve_walkway: 'blueprint wants open air here but rock is present — dig it out (this voxel is part of the walkway/room being excavated)',
  wall_breach:   'blueprint wants a solid wall here but found AIR (a cave grazed the shaft) — seal the hole so the shaft stays enclosed',
  torch_missing: 'blueprint wants a torch here for lighting and none is present — place one',
  torch_blocked: 'a torch belongs here but a solid block occupies the slot — clear it, then place the torch',
  gravity_wall:  'a gravity block (sand/gravel) sits in a wall slot (cave-in risk) — dig it out and reseal with stable fill',
  ore_wall:      'ore is exposed in a wall slot — mine it out for the deficiency, then reseal the wall',
  missing:       'blueprint wants a specific block here and the slot is empty — place it',
  mismatch:      'the wrong block occupies this slot — clear it, then place the blueprint block',
};

// Cap on how many individual coordinates a single reason group prints in the manifest. A
// frontier's first dig can be ~50 carve_walkway voxels; listing all 50 is noise, so print a
// sample plus a "+N more" tail. Small repair passes (the common case) list every block.
const MANIFEST_COORD_CAP = 12;

// Enumerate a still-damaged segment's residual steps as a WARNING — what block, where, and why it
// wasn't cleared (Architect 2026-07-10: "explain why it failed, what it tried, and where the block
// is"). Reuses REASON_WHY so the human-facing why matches the scanner's own reason codes (Law 16),
// and flags gravity_affected explicitly because that is the dominant cause: the bot digs the cell,
// a gravel/sand column above cascades straight back in, and the re-diff re-flags it.
const RESIDUAL_LOG_CAP = 8;
function warnResidualSteps(segId, post) {
  const steps = Array.isArray(post?.steps) ? post.steps : [];
  watcher.warn('mining_executor', `Segment ${segId} still damaged after its repair pass — ${steps.length} step(s) unresolved (gravity is exhausted at dig time, so this is a genuine residual):`);
  for (const s of steps.slice(0, RESIDUAL_LOG_CAP)) {
    const p = s.place || {};
    const why = REASON_WHY[s.reason] || s.reason;
    const grav = s.gravity_affected ? ' [gravity-cascade: a column above keeps refilling this cell]' : '';
    watcher.warn('mining_executor', `  ${s.action} ${s.type} at (${p.x},${p.y},${p.z}) — ${s.reason}: ${why}${grav}`);
  }
  if (steps.length > RESIDUAL_LOG_CAP) watcher.warn('mining_executor', `  …and ${steps.length - RESIDUAL_LOG_CAP} more`);
}

// logDecisionManifest — the heart of the Architect's transparency ask ("show more decisions
// about WHY it's mining the blocks it's mining"). Group the segment's pending steps by WHY
// (reason); for each group emit ONE line carrying the plain-English rationale, the action,
// the actual coordinates, and — for place steps — the resolved fill item. One accumulated
// line per reason keeps Law 5 intact (aggregated per phase, not per-step spam).
function logDecisionManifest(bot, steps) {
  const byReason = {};
  for (const s of steps) { const r = s.reason || 'n/a'; (byReason[r] = byReason[r] || []).push(s); }
  for (const [reason, group] of Object.entries(byReason)) {
    const why = REASON_WHY[reason] || 'no rationale recorded for this reason code';
    const verb = group[0].action; // a reason maps to a single action class (dig OR place)
    let fillStr = '';
    if (verb === 'place') {
      const fills = {};
      for (const s of group) {
        const item = resolveItemName(bot, s.type) || 'NONE-IN-INVENTORY';
        fills[item] = (fills[item] || 0) + 1;
      }
      fillStr = ` | will fill with: ${Object.entries(fills).map(([i, c]) => `${c}×${i}`).join(', ')}`;
    }
    const coords = group.slice(0, MANIFEST_COORD_CAP).map(s => `(${s.place.x},${s.place.y},${s.place.z})`).join(' ');
    const more = group.length > MANIFEST_COORD_CAP ? ` …+${group.length - MANIFEST_COORD_CAP} more` : '';
    watcher.summary('mining_executor', `WHY ${verb} ×${group.length} [${reason}] — ${why}${fillStr} → ${coords}${more}`);
  }
}

module.exports = {
  receive: watcher.track('mining_executor', async (signalType, payload) => {
    if (signalType !== 'mining_executor') return;

    const bot = global.bot;
    const hq = require('@kernel/corporate_headquarters');

    async function centerOnBlock() {
      if (microCenter && bot) {
        await microCenter(bot, { eps: CENTER_EPS, tapMs: CENTER_TAP_MS, maxIters: CENTER_MAX_ITERS, settleSleep: 50 });
      }
    }

    // ── Deficiency tracking ────────────────────────────────────────────────────
    // The brain posts the outstanding underground material shortfall to
    // job_board_room.materials_needed_pull on every sweep; a targeted
    // mine_material job also carries its own {item,hold_goal} objective — a LEVEL compared against a
    // fresh count, never an amount to dig (job_board, THE QUANTITY CONTRACT). After each
    // segment we diff the bot's (post-collect) inventory against these goals.
    // Once met we surface early so the brain can switch to building/crafting
    // instead of over-mining. Read once at dispatch start — job_board does not
    // re-sweep mid-dispatch, so this is the snapshot of need we mine toward.
    const miningObjective = payload.mining_objective && payload.mining_objective.item
      ? payload.mining_objective
      : null;
    const pullList = hq.readConfRoomFlag('job_board_room', 'materials_needed_pull', {}) || {};
    const pullKeys = Object.keys(pullList).filter(k => typeof pullList[k] === 'number' && pullList[k] > 0);

    function currentInventory() {
      const acc = {};
      for (const it of (bot.inventory?.items?.() || [])) {
        if (it && it.name && it.count > 0) acc[it.name] = (acc[it.name] || 0) + it.count;
      }
      return acc;
    }

    // deficiencyMet — true when the reason this dispatch went mining is satisfied.
    // A targeted objective wins outright; otherwise every posted pull-list item
    // must be covered. With NO posted deficiency there is nothing to satisfy by
    // count, so only the segment cap stops us (caller just wanted depth).
    function deficiencyMet(inv) {
      if (miningObjective) {
        return countInInventory(miningObjective.item, inv) >= (miningObjective.hold_goal || 1);
      }
      if (pullKeys.length === 0) return false;
      return pullKeys.every(k => countInInventory(k, inv) >= pullList[k]);
    }

    function deficiencySnapshot(inv) {
      if (miningObjective) {
        return `${miningObjective.item} ${countInInventory(miningObjective.item, inv)}/${miningObjective.hold_goal || 1}`;
      }
      if (pullKeys.length === 0) return 'none posted';
      return pullKeys.map(k => `${k} ${countInInventory(k, inv)}/${pullList[k]}`).join(', ');
    }

    // ── Per-block mechanics (mining domain) injected into the shared primitive ──

    // digOne — dig one target. A plain block is one performDig; a gravity position is repeat-mined:
    // dig, let the column settle, re-check, re-dig while gravity blocks keep falling in — until the
    // position holds air. A dig that leaves the SAME non-gravity block is the stuck condition (Law
    // 13). MAX_GRAVITY_DIGS caps a pathological column; the position is retried next scan pass.
    //
    // The repeat-mine triggers on the LIVE block being gravel/sand/red_sand — NOT only the scan-time
    // gravity_affected flag (Architect 2026-07-10). The flag is computed from a possibly-unsensed
    // scan and misses a column that only begins cascading once the bot opens the cell; that miss was
    // the sole cause of a built segment re-diffing "damaged" forever (executor↔manager AB-halt).
    // Trusting the block in front of the bot instead of a remembered flag is Invariant B.
    async function digOne(step) {
      const pos = new Vec3(step.place.x, step.place.y, step.place.z);
      let block = bot.blockAt(pos);
      if (!block || isAir(block.name)) return true;
      if (!step.gravity_affected && !isGravityBlock(block.name)) {
        return performDig(bot, pos, block, 'mining_executor');
      }
      let digs = 0;
      while (digs < MAX_GRAVITY_DIGS) {
        block = bot.blockAt(pos);
        if (!block || isAir(block.name)) return true;
        const before = block.name;
        const ok = await performDig(bot, pos, block, 'mining_executor');
        if (!ok) return false;
        digs++;
        await sleep(STEP_WAIT_MS); // let any column above fall into the gap before re-reading
        const after = bot.blockAt(pos);
        if (after && !isAir(after.name) && after.name === before && !isGravityBlock(after.name)) {
          watcher.warn('mining_executor', `Gravity dig at (${pos.x},${pos.y},${pos.z}) unchanged (${before}) after dig — stuck.`);
          return false;
        }
      }
      watcher.warn('mining_executor', `Gravity column at (${pos.x},${pos.y},${pos.z}) hit ${MAX_GRAVITY_DIGS}-dig cap — leaving for next pass.`);
      const fin = bot.blockAt(pos);
      return !!fin && isAir(fin.name);
    }

    // placeOne — place one fill/torch block, consuming the ev the primitive computed
    // (ev.pos target, ev.anchor/ev.face solid reference, ev.underFeet footing flag). Returns
    // 'already' | true | false (the primitive already gated resolveItem/isOptional, so a null
    // resolve here is a hard fail). Under-feet (a breach directly beneath the anchor) pillarSteps
    // onto the correct fill block; everything else places against the primitive's chosen solid
    // neighbour with NO raycast — the corner cheat is intrinsic.
    //
    // WHY a refusal dumps the slot, the neighbours and the item count (Architect 2026-07-15, round
    // 36: "we have to find out why it doesnt place the block ... first we upgrade it to state what
    // is currently in the spot its trying to place and whats around it"). AurenBot re-sealed the
    // same voxel every ~2.5 min for 20 minutes — 54% of the run — reporting `placed 1, failed 0`
    // and a clean diff every single time, while (129,11,11) held AIR throughout and her cobblestone
    // went 62→63→62 (the matter never left her pocket). Nothing on disk said why, because this
    // function destroyed the answer twice per attempt:
    //   1. `catch (_) {}` swallowed mineflayer's throw — the one artifact naming the server's
    //      refusal. Law 16 names that exact form ("Must log to Watcher. No silent swallow").
    //   2. the success test was `!isAir(after.name)`: "something is there" is not "MY block is
    //      there". Any leftover, cascade-in, or wrong block scored as a placed one.
    // Both are the r31e class (an attempt counted as an outcome) that produced `[no seeds]` (r34)
    // and `tilled=22` (r35). WARN, not buffer: every buffered place record anchored_repair writes
    // reaches disk only if error() dumps it, so 25 consecutive refusals left zero forensics (Law 5 —
    // warn is the channel read first when diagnosing).
    // The rejected turn: calling the voxel `deferred`. Deferred means "a later drain-queue pass
    // places it" (a torch waiting on its wall). A structural fill block has no later pass — naming
    // it deferred swaps this lie for a quieter one (Architect: "no deferred, its not on the
    // qualified deferred list").
    // Open, NOT settled by this code: whether the block is refused by the server (client draws it
    // anyway, chunk round-trip to the surface later restores the truth) or placed and removed. The
    // `held N→N` count is the discriminator — a real placement decrements it.
    async function placeOne(step, ev) {
      const pos = ev.pos;
      const itemName = resolveItemName(bot, step.type);
      if (!itemName) return false;

      if (ev.underFeet) {
        // THE THROWAWAY ORDER, NOT THE FILL ORDER. This block is footing the bot stands on to reach the
        // voxel it is about to place — it is scaffolding, not structure, and it must not be laid in the
        // cobblestone this shaft exists to collect (Law 25: a verb that spends its own product and reports
        // success). The structural order above spends masonry first; the pillar order spends it last.
        const res = await pillarStep(bot, { candidateItemNames: group_to_item.pillar_block });
        if (!res.success) watcher.warn('mining_executor', `pillarStep (footing) failed at (${pos.x},${pos.y},${pos.z}): ${res.reason}`);
        return res.success;
      }

      // The slot as the bot sees it RIGHT NOW. mining_integrity called this voxel a wall_breach
      // (AIR) up to a minute ago; if it reads solid here, the scanner and the placer disagree about
      // one block and THAT is the fault, not the placement. Captured before anything touches it.
      const before = bot.blockAt(pos);
      const beforeName = before && !isAir(before.name) ? before.name : 'air';
      if (before && !isAir(before.name)) {
        // normalizeBlockName so a torch already standing as `wall_torch` reads as the `torch` we
        // hold (one normalizer, Law 16) instead of being dug and re-placed as a "wrong" block.
        if (normalizeBlockName(before.name) === itemName) return 'already';
        const cleared = await performDig(bot, pos, before, 'mining_executor');
        if (!cleared) return false;
      }

      // Equip, the spawn-protection gate, the combat checkpoint, the aim, the click and the settle all
      // live in the one place route (Law 16). What stays here is this executor's OWN criterion, which is
      // stricter than the authority's: a shaft seal must be the block we meant to lay, so a cell that
      // came back holding something ELSE is a failure even though the authority correctly reports a
      // block was placed (Law 25 — the asker owns the criterion, and the asker here is the mine).
      const heldBefore = countInInventory(itemName, getBotInventory());
      const placed = await performPlace(bot, pos, ev.anchor, ev.face, itemName, 'mining_executor');

      const after = placed.after;
      const afterName = after && !isAir(after.name) ? after.name : 'air';
      if (placed.ok && normalizeBlockName(afterName) === itemName) return true;

      const heldAfter = countInInventory(itemName, getBotInventory());
      const p = bot.entity.position;
      watcher.warn('mining_executor',
        `Place REFUSED at (${pos.x},${pos.y},${pos.z}) want=${itemName} (type=${step.type}${step.reason ? `/${step.reason}` : ''}) — ` +
        `slot before=${beforeName} after=${afterName} | ` +
        `ref=${ev.anchor.name}@(${ev.anchor.position.x},${ev.anchor.position.y},${ev.anchor.position.z}) face=(${ev.face.x},${ev.face.y},${ev.face.z}) | ` +
        `bot=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) held=${bot.heldItem?.name || 'none'} ${itemName} ${heldBefore}→${heldAfter} | ` +
        `nbrs [${anchoredRepair.describeNeighborhood(bot, pos)}] | ` +
        (placed.ok ? `place route returned, slot holds ${afterName}` : `place refused: ${placed.reason}`));
      return false;
    }

    // ── processSegment: repair ONE segment (staircase copy or cell) via the anchored model.
    //    Stand at each of the segment's anchors and dig-all/place-all within reach through the
    //    shared primitive. Returns a tally for the batch accumulator. ──
    async function processSegment(seg, opts = {}) {
      const isCell = !!opts.isCell;
      const steps = Array.isArray(seg.steps) ? seg.steps.slice() : [];

      const allDigs = steps.filter(s => s.action === 'dig');
      const allPlaces = steps.filter(s => s.action === 'place');
      const reasonCounts = {};
      for (const s of steps) { const r = s.reason || 'n/a'; reasonCounts[r] = (reasonCounts[r] || 0) + 1; }
      const reasonStr = Object.entries(reasonCounts).map(([r, c]) => `${r}:${c}`).join(' ');
      const feet0 = bot.entity.position.floored();
      watcher.summary('mining_executor', `Segment ${seg.id} y=${seg.y_bottom}..${seg.y_top} — ${allDigs.length} dig, ${allPlaces.length} place (${steps.length} total). Bot at (${feet0.x},${feet0.y},${feet0.z}). [${reasonStr}]`);
      // Itemize the WHY of every pending block before touching anything (Law 6 transparency).
      logDecisionManifest(bot, steps);

      // Anchor floors: a staircase copy carries per-copy anchor stand-spots (mining_blueprinter
      // transposes the blueprint anchors per copy, threaded through mining_integrity); a cell has
      // the single floor-center anchor at its world_position. The bot stands at floor.y+1 and
      // dig-all/place-all within reach — the SAME anchored model build_executor uses.
      const anchorFloors = isCell
        ? (seg.world_position ? [seg.world_position] : [])
        : (Array.isArray(seg.anchors) ? seg.anchors : []);
      if (anchorFloors.length === 0) {
        // A staircase copy with no anchors, or a cell with no world_position, cannot be built by
        // the anchored model. The blueprinter guarantees anchors, so this is a coding violation
        // (Law 13: throw, never silently skip).
        throw new Error(`[mining_executor] CODING VIOLATION: segment ${seg.id} (${seg.type}) has no anchor stand-spots — cannot build via the anchored model.`);
      }
      const stands = anchorFloors.map(a => ({ x: a.x, y: a.y + 1, z: a.z }));

      // Nearest-anchor assignment: each diff step is worked from the anchor with the shortest
      // server-accurate reach to it (anchoredRepair.reachFromStand — the SAME metric the reach
      // gate asserts, Law 16). Assigning by the gate's own metric guarantees each step lands at
      // the anchor that can actually reach it, so the primitive's Law 13 assert fires only on a
      // genuine coverage fault (a voxel no anchor can reach), never on a mis-route. Each step
      // runs at exactly ONE anchor, so tallies never double-count.
      const groups = stands.map(() => []);
      for (const s of steps) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < stands.length; i++) {
          const d = anchoredRepair.reachFromStand(bot, stands[i], s.place);
          if (d < bestD) { bestD = d; best = i; }
        }
        groups[best].push(s);
      }

      const miningOps = {
        digOne,
        placeOne,
        resolveItem: (type) => resolveItemName(bot, type),
        isOptional: (type) => MINING_OPTIONAL.has(type),
        stationTypes: EMPTY_STATION_SET,
        tag: 'mining_executor',
        maxPlaceAttempts: PLACE_MAX_ATTEMPTS,
      };

      let digOk = 0, digFail = 0, placeOk = 0, placeFail = 0, deferred = 0, cheatPlaced = 0;
      // A REQUIRED block the bot does not hold. anchored_repair has always returned this in its own
      // bucket, and this caller used to discard it — so a segment blocked on material reported the same
      // ordinary numbers as one that merely hit its work cap, and the only party that noticed was the
      // judge, five identical passes later. build_executor reads the same field from the same primitive
      // and turns it into an exit (build_executor's material_short branch); mining is that pattern's
      // second caller, not a new mechanism.
      let materialShort = 0;
      const shortMaterials = {};
      for (let i = 0; i < stands.length; i++) {
        if (groups[i].length === 0) continue;
        const r = await anchoredRepair.repairAtAnchor(bot, {
          stand: stands[i],
          steps: groups[i],
          label: `${seg.type} ${seg.id} anchor${i}`,
        }, miningOps);
        digOk += r.dig_ok; digFail += r.dig_fail;
        placeOk += r.place_ok; placeFail += r.place_fail;
        deferred += r.deferred; cheatPlaced += r.cheat_placed;
        materialShort += r.material_short || 0;
        for (const [m, c] of Object.entries(r.short_materials || {})) shortMaterials[m] = (shortMaterials[m] || 0) + c;
      }

      const remaining = Math.max(steps.length - (digOk + placeOk), 0);
      const cheatStr = cheatPlaced > 0 ? ` (${cheatPlaced} corner/junction cheat-placed)` : '';

      // A pass that moved NOTHING while something deferred or failed is the one state whose cause
      // cannot be reconstructed afterwards. anchored_repair buffers the per-voxel WHY — `defer (x,y,z):
      // no_attach_point [nbrs ...]` (anchored_repair:381) — under this SAME 'mining_executor' stage
      // (miningOps.tag), and the summary on the next line calls _bufferClear on exactly that stage.
      //
      // Round 40 paid 38 minutes for that clear: the three unplaceable ceiling voxels at 26|24|91 had
      // their reason computed and destroyed on all five passes, so the judge's kill printed a loop with
      // no cause attached and the diagnosis had to be rebuilt offline from scratch. Dump BEFORE the
      // summary — buffer.dump persists (writes the watcher file, forwards to the overseer) and does NOT
      // fake an error(): a voxel waiting on a neighbour is environmental (Law 13), not a crash, so
      // error() here would wake the fleet on ordinary work. This is the whole point of the buffer's
      // two exits — the happy path clears, a stalled pass keeps its evidence.
      const madeProgress = (digOk + placeOk) > 0;
      if (!madeProgress && (deferred + digFail + placeFail) > 0) watcher.buffer.dump('mining_executor');

      watcher.summary('mining_executor', `Segment ${seg.id} pass: dig=${digOk}/${digOk + digFail} place=${placeOk}${cheatStr}/${placeOk + placeFail} deferred=${deferred} | ${remaining} steps remaining`);
      return { digOk, digFail, placeOk, placeFail, skipped: deferred, remaining, materialShort, shortMaterials };
    }

    // ── Cell dispatch (Phase 5) ────────────────────────────────────────────────
    // The manager selected, hazard-scanned (scanCell), and stamped a cell on
    // payload.dig_cell. Generate its blueprint (Phase 4), diff it against the world
    // (Phase 1.4/1.5), and dig it in ONE pass — one cell per dispatch (D6). This bypasses
    // the shaft scan + descent loop entirely (cells are not in mining_integrity.scan()).
    // Completion is decided by the MANAGER on the recursive_judge return, by progress
    // (not steps_remaining — deferred corners keep that > 0, D12).
    if (payload.dig_cell && payload.dig_cell.anchor) {
      const miningCellGraph = require('@perception/mining_cell_graph');
      const anchor = payload.dig_cell.anchor;
      // Unguarded. generateCell throws on stale HQ (Law 13 / D11) — a coding/state bug, and the catch
      // that stood here answered it by RETURNING: no signal routed, no judge told, the chain simply
      // ended with one error line. Default-stopped means the bot stops, not that the chain stops
      // silently while the fleet waits on a signal that will never come (Law 8).
      const cellSeg = miningCellGraph.generateCell(anchor);          // place blueprint (Phase 4)
      const diff = miningIntegrity.scanSegmentSteps(bot, cellSeg);   // diff vs world (Phase 1)
      cellSeg.steps = diff ? diff.steps : [];
      cellSeg.y_bottom = diff ? diff.y_bottom : anchor.y;
      cellSeg.y_top = diff ? diff.y_top : anchor.y + 4;

      await centerOnBlock();
      let r;
      if (cellSeg.steps.length === 0) {
        r = { digOk: 0, placeOk: 0, digFail: 0, placeFail: 0, skipped: 0, remaining: 0 };
        watcher.summary('mining_executor', `Cell ${cellSeg.id} already matches the world — nothing to dig.`);
      } else {
        r = await processSegment(cellSeg, { isCell: true });
      }

      // Collect drops so mined ore/cobble counts toward the brain's deficiency next sweep.
      const cellDrops = await collectNearby(bot);
      watcher.summary('mining_executor', `drop_collector: ${cellDrops.result} picked=${cellDrops.picked_up}/${cellDrops.total_found}`);

      // COMPLETION BY INTEGRITY DIFF, not by progress (Architect 2026-07-04: a cell is a
      // maintained blueprint, exactly like a shaft segment — done ⇔ its diff is clean). Re-diff
      // the cell against the world (authoritative, same post-pass re-diff the shaft does before
      // registering a segment built) and report clean + the remaining count. The MANAGER decides
      // complete / re-pass / stuck from these — the old "no progress ⇒ complete" heuristic marked
      // un-carved cells complete because it couldn't tell "already done" from "couldn't reach it".
      // Unguarded: scanSegmentSteps is ours and already answers chunk churn with unsensed voxels rather
      // than a throw, so the "treat as not-clean on a read error" branch that stood here could only fire on
      // a defect — and it fired by fabricating a remaining count the capsule below reports as measured
      // (Law 25).
      const post = miningIntegrity.scanSegmentSteps(bot, cellSeg);
      const cellClean = !post || !Array.isArray(post.steps) || post.steps.length === 0;
      const postRemaining = cellClean ? 0 : post.steps.length;
      const exitReason = cellClean ? 'cell_complete' : 'cell_incomplete';

      const capsule = payload.mining_executor || (payload.mining_executor = {});
      // The verdict was already computed two lines up and then thrown away for a hardcoded `true`.
      // Report it: the cell is done or it is not (Law 6 — the record may not state a thing that is
      // false; Law 13 — never fabricate a field). A cell needing three dispatches now reads
      // false, false, true, and the judge does not mistake that for a stall because `remaining`
      // moves in the readable, which is what actually partitions the signature.
      capsule.success = cellClean;
      capsule.recursion_alert = true;
      capsule.result = 'cell_pass';
      capsule.cell_id = cellSeg.id;
      capsule.exit_reason = exitReason;
      capsule.cell_clean = cellClean;
      capsule.cell_remaining = postRemaining;
      capsule.steps_remaining = postRemaining;
      capsule.metrics = { dig_ok: r.digOk, place_ok: r.placeOk, fail: r.digFail + r.placeFail, skipped: r.skipped };
      capsule.readable = `mining_executor: cell ${cellSeg.id} ${exitReason} dig=${r.digOk} place=${r.placeOk} fail=${r.digFail + r.placeFail} remaining=${postRemaining}`;
      watcher.summary('mining_executor', `CELL DONE: ${cellSeg.id} exit=${exitReason} dig=${r.digOk} place=${r.placeOk} fail=${r.digFail + r.placeFail} remaining=${postRemaining}.`);
      // No dumpExcess here (Architect, 2026-07-04): offloading is a job_board job now
      // (inventory_dump), fired only when the pocket is nearly full — mine longer, dump once.
      return routeToJudge('mining_executor', { ...payload, readable: capsule.readable });
    }

    // markSegmentBuilt — register a shaft segment in HQ as fully excavated (Law 6:
    // mining_executor owns the built_segments section). This is the handoff the Architect
    // described: "dig out, then mining executor lets corporate hq know which segment is
    // done, then mining_integrity now maintains that segment." Add-only (Law 9 — never
    // deletes from this section), idempotent (skips ids already present).
    function markSegmentBuilt(id) {
      const reg = hq.readConfRoomFlag('mining_confrence_room', 'built_segments', {}) || {};
      if (reg[id]) return false;
      reg[id] = { built_at: new Date().toISOString(), writer: 'mining_executor' };
      hq.writeConfRoomFlag('mining_confrence_room', 'built_segments', reg);
      return true;
    }

    // ── Outer multi-segment loop ───────────────────────────────────────────────
    await centerOnBlock();

    let segmentsProcessed = 0;
    let totalDig = 0, totalPlace = 0, totalFail = 0, totalSkipped = 0;
    let lastRemaining = 0;
    let lastSegRange = '';
    let lastSegId = null;
    let exitReason = '';
    let lastShortMaterials = {};

    while (true) {
      const integrity = miningIntegrity.scan(bot);

      if (!integrity?.first_incomplete) {
        // No actionable segment surfaced. If the shaft is fully excavated + intact, we're
        // done. Otherwise the frontier already matches the blueprint (e.g. pre-carved, or a
        // registry that lost an entry) but isn't registered built yet — claim it so the
        // frontier advances, then re-scan. Bounded: each mark advances the frontier, so the
        // loop terminates once every segment is registered.
        if (!integrity?.all_segments_complete && integrity?.frontier_id) {
          if (markSegmentBuilt(integrity.frontier_id)) {
            watcher.summary('mining_executor', `Frontier ${integrity.frontier_id} already matches the blueprint → registered built; advancing.`);
            continue;
          }
        }
        exitReason = segmentsProcessed === 0 ? 'no_work' : 'shaft_complete';
        break;
      }
      const seg = integrity.first_incomplete;
      const steps = Array.isArray(seg.steps) ? seg.steps.slice() : [];
      if (steps.length === 0) {
        exitReason = segmentsProcessed === 0 ? 'no_steps' : 'shaft_complete';
        break;
      }

      const isCell = seg.type === 'cell';
      const wasDamagedBuilt = !!seg.built;  // a finished segment under repair vs. the frontier
      const r = await processSegment(seg, { isCell });
      segmentsProcessed++;
      totalDig += r.digOk; totalPlace += r.placeOk;
      totalFail += r.digFail + r.placeFail; totalSkipped += r.skipped;
      const materialShortThisPass = r.materialShort || 0;
      if (materialShortThisPass > 0) {
        lastShortMaterials = r.shortMaterials || {};
        watcher.warn('mining_executor', `Segment ${seg.id} short of ${describeShort(lastShortMaterials)} — required fill the bot is not carrying; a retry cannot conjure it.`);
      }
      lastRemaining = r.remaining;
      lastSegRange = `${seg.y_bottom}..${seg.y_top}`;
      lastSegId = seg.id;

      // Register the segment built the moment it diffs clean — i.e. fully dug AND its walls
      // sealed (breaches are never deferred now, so "clean" means genuinely finished). This
      // is what flips mining_integrity from "excavate this" to "permanently maintain this".
      // A damaged BUILT segment is already registered (idempotent skip); we still re-check
      // so a repaired segment that's now clean stays registered. Re-diff via scanSegmentSteps
      // (seg carries .voxels). Skipped for cells — their completion is owned by mining_cell_graph.
      if (!isCell) {
        {
          // Trust mining_integrity's null contract: it returns null ONLY when the segment is fully
          // sensed AND matches. A non-null result means work remains OR voxels are unsensed
          // (unloaded>0, 0 steps) — either way NOT built yet. Reading post.steps.length===0 as
          // "clean" would register unsensed rock as built (Invariant B / Law 13).
          const post = miningIntegrity.scanSegmentSteps(bot, seg);
          const clean = !post;
          if (clean && markSegmentBuilt(seg.id)) {
            watcher.summary('mining_executor', `Segment ${seg.id} fully excavated → registered built in HQ; now under permanent maintenance.`);
          } else if (!clean && wasDamagedBuilt) {
            // A gravity column is now exhausted at dig time (digOne repeat-mines the live block), so a
            // still-damaged built segment is no longer the gravel churn — it is a genuine residual (a
            // voxel no anchor reached, a breach, an unsensed chunk). Name it (what/where/why) so it
            // escalates for inspection instead of silently re-diffing next scan (Law 13, Law 6).
            warnResidualSteps(seg.id, post);
          }
        }
      }

      // Collect drops BEFORE diffing so freshly mined items count toward need.
      const dropResult = await collectNearby(bot);
      watcher.summary('mining_executor', `drop_collector: ${dropResult.result} picked=${dropResult.picked_up}/${dropResult.total_found}`);

      const inv = currentInventory();
      if (deficiencyMet(inv)) {
        exitReason = miningObjective ? 'objective_met' : 'deficiency_met';
        break;
      }
      // MATERIAL-SHORT OUTRANKS THE CAP, and the order is the whole point. Both exits are reached on the
      // same pass; reporting the cap means "I did my quota", reporting the shortfall means "I am blocked
      // on something only a resupply brings". A caller told the first re-dispatches the identical segment
      // — which is what the wall-breach loop was, five passes with an unchanged readable while the true
      // outcome sat unread in the tally (Law 25: the verdict must match sensed reality against the
      // asker's criteria, not the threshold this fragment happens to have crossed).
      //
      // Requires ZERO progress this pass, matching build_executor's branch: a pass that placed something
      // and ran dry has genuinely advanced, and the next pass — finding the same block still absent with
      // nothing placed — lands here. That is what keeps a partial reseal from being reported as a block.
      if (materialShortThisPass > 0 && (r.digOk + r.placeOk) === 0) {
        exitReason = 'material_short';
        break;
      }
      if (segmentsProcessed >= MAX_SEGMENTS_PER_DISPATCH) {
        exitReason = 'segment_cap';
        break;
      }
      watcher.summary('mining_executor', `Segment ${segmentsProcessed}/${MAX_SEGMENTS_PER_DISPATCH} done (y=${lastSegRange}); deficiency [${deficiencySnapshot(inv)}] not met — descending to next segment.`);
      await centerOnBlock();
    }

    const capsule = payload.mining_executor || (payload.mining_executor = {});
    // Architect's ruling (round 41): "wana give it a fail if it cant complete." A goal exit is a win
    // even with rock left standing — the dispatch did what it was for; a 'segment_cap' exit is a win
    // only if the segment it worked came out clean. This is the line that hid round 40: it reported
    // success on five consecutive passes that placed nothing, so the only field able to say "this
    // pass accomplished nothing" said the opposite (Law 6), and Law 5's buffer — which dumps only on
    // error() — could never fire. The judge still killed it at 5/5 off the readable alone, but 38
    // minutes later and with no reason attached. See GOAL_EXITS at the top.
    capsule.success = GOAL_EXITS.has(exitReason) || lastRemaining === 0;
    capsule.recursion_alert = true;

    if (segmentsProcessed === 0) {
      // No work existed this dispatch (shaft already complete / no steps).
      capsule.result = exitReason;
      capsule.steps_remaining = 0;
      capsule.readable = `mining_executor: ${exitReason}`;
      const dropResult = await collectNearby(bot);
      watcher.summary('mining_executor', `No segments processed (${exitReason}). drop_collector: ${dropResult.result} picked=${dropResult.picked_up}/${dropResult.total_found}`);
      capsule.drop_collector = dropResult;
    } else {
      const inv = currentInventory();
      capsule.result = 'pass_complete';
      capsule.segment_id = lastSegId;
      capsule.segment_y_range = lastSegRange;
      capsule.segments_processed = segmentsProcessed;
      capsule.exit_reason = exitReason;
      capsule.metrics = { dig_ok: totalDig, place_ok: totalPlace, fail: totalFail, skipped: totalSkipped };
      capsule.steps_remaining = exitReason === 'shaft_complete' ? 0 : lastRemaining;
      // The worked segment's id MUST be in the readable (mirrors the cell path ~L520). recursive_judge
      // signatures on (from, success, readable), so an id-less readable collapses N DISTINCT segments to a
      // single signature. Once carried torches became non-deferrable (blocksCompletion, 2026-07-19), the bot
      // lights successive shaft segments one torch per dispatch — genuine monotonic progress that read
      // IDENTICALLY ("1 seg segment_cap dig=0 place=1 …") and tripped the 5/5 loop-kill on a bot that was
      // advancing (live: TessaBot halted descending 16|63→19|60→22|57, each placing its torch). The id
      // partitions progress (a different segment each pass) from a real stall (the same id repeating).
      // The shortfall rides in the READABLE, not only in the log, because the readable is the judge's
      // identity key and the one line a reader sees on a kill. Naming it here does not weaken the judge —
      // an unresolved shortfall repeats the same string and still trips at five, which is correct: five
      // passes with no resupply IS the escalation. What changes is that the kill now arrives with its
      // cause attached instead of an unexplained cap.
      const shortStr = exitReason === 'material_short' ? ` short=[${describeShort(lastShortMaterials)}]` : '';
      capsule.readable = `mining_executor: seg ${lastSegId} ${segmentsProcessed}x ${exitReason}${shortStr} dig=${totalDig} place=${totalPlace} fail=${totalFail} | deficiency [${deficiencySnapshot(inv)}]`;
      watcher.summary('mining_executor', `BATCH DONE: ${segmentsProcessed} segment(s), exit=${exitReason}${shortStr}, dig=${totalDig} place=${totalPlace} fail=${totalFail}. Deficiency [${deficiencySnapshot(inv)}].`);
      // No dumpExcess here (Architect, 2026-07-04): offloading is a job_board job now
      // (inventory_dump), fired only when the pocket is nearly full — mine longer, dump once.
    }

    routeToJudge('mining_executor', { ...payload, readable: capsule.readable });
  })
};
