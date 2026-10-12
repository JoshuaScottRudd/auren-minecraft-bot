// fragment: mining_executor (action / mining)
// purpose: Excavate (and repair) staircase copies and cells until the dispatch's need is met or a
//          segment cap is hit, then route to recursive_judge.
//
// ANCHORED STATIONARY MODEL (Item 5 / D3): mining builds the same way building does — blueprint +
// integrity diff drives dig/place repair via mining_integrity, as building_integrity drives building.
// The bot stands at each segment's anchor stand-spots and dig-alls then place-alls within reach
// through the shared anchored_repair primitive (Law 16).
//
// A SEGMENT IS WORKED UNTIL IT SETTLES: rescan → dig all → place all, repeated (anchored_repair.settle), so a
// gravel column a dig sets loose is dug out and the hole it leaves sealed before the segment is left.
//
// ONE SEGMENT PER DISPATCH: works one segment or cell and routes to recursive_judge; the manager batches
// passes per surface trip. The SHAFT is a blueprint built to get to the bottom: it collects no drops and
// never stops for material. A CELL is dug for material, so a cell pass collects its drops.

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
// The stationary dig-all/place-all routine is shared with build_executor (Law 16 / D3). This
// executor supplies mining-domain mechanics as callbacks; the primitive owns anchor control flow.
const anchoredRepair = require('@api/anchored_repair');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');

// ── VEINS: THE ORE A STRIP SEGMENT UNCOVERS ──────────────────────────────────────────────────────────
// mineVeins(bot, seg) — the ore in the tunnel's walls, floor and ceiling and the ore joined to it face to face,
// out to VEIN_MAX blocks, one block at a time: dig one, walk to what fell, dig the next from where the body
// now stands. A block is mined only when it is in reach of the feet, is not the block the body stands on,
// touches no water or lava, carries no falling block on top, and a pickaxe the body holds can harvest it.
// The spot the vein was started from is kept, and the body returns to it once, when the vein is done, by the
// navigator's ordinary route. The walls it opens are part of the tunnel, so the segment's next settle
// refills them (structural_fill) with the stone the body carries.
const ORE = /_ore$/;
const VEIN_MAX = 16;
async function mineVeins(bot, seg) {
  const Vec3 = require('vec3');
  const { isFluid } = require('@utils/gravity_utils');
  const { BLOCK_REACH } = require('@utils/fragment_utils');
  const locomotion = require('@locomotion/locomotion_dispatcher');
  const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const keyOf = (p) => `${p.x},${p.y},${p.z}`;
  const open = new Map(seg.voxels.filter(v => v[3] !== 'air').map(v => [`${v[0]},${v[1]},${v[2]}`, new Vec3(v[0], v[1], v[2])]));
  const seen = new Set(open.keys());
  const home = bot.entity.position.floored();
  const mined = {};
  let passed = {};
  const drops = { picked: 0, seen: 0, no_route: 0, long_walk: 0 };
  let dug = 0, digFailed = 0;
  while (dug < VEIN_MAX) {
    // The next ore the body can work from where it stands NOW; what it cannot is read again after the next move.
    const feet = bot.entity.position.floored();
    const round = {};
    let pick = null;
    for (const [k, p] of open) {
      const b = bot.blockAt(p);
      if (!b || !ORE.test(b.name)) { open.delete(k); continue; }
      let why = null;
      if (p.x === feet.x && p.z === feet.z && p.y < feet.y) why = 'underfoot';
      else if (anchoredRepair.reachFromStand(bot, feet, p) > BLOCK_REACH) why = 'reach';
      else if (SIX.some(([dx, dy, dz]) => { const n = bot.blockAt(p.offset(dx, dy, dz)); return !!n && isFluid(n.name); })) why = 'fluid';
      else if ((() => { const up = bot.blockAt(p.offset(0, 1, 0)); return !!up && isGravityBlock(up.name); })()) why = 'gravity';
      else if (!bot.inventory.items().some(i => b.canHarvest(i.type))) why = 'tool';
      if (why) { round[why] = (round[why] || 0) + 1; continue; }
      pick = { k, p, b };
      break;
    }
    if (!pick) { passed = round; break; }
    open.delete(pick.k);
    const name = pick.b.name;
    if (!(await performDig(bot, pick.p, pick.b, 'mining_executor'))) { digFailed++; continue; }
    dug++;
    mined[name] = (mined[name] || 0) + 1;
    for (const [dx, dy, dz] of SIX) {
      const n = pick.p.offset(dx, dy, dz);
      if (!seen.has(keyOf(n))) { seen.add(keyOf(n)); open.set(keyOf(n), n); }
    }
    const got = await collectNearby(bot);
    drops.picked += got.picked_up; drops.seen += got.total_found; drops.no_route += got.no_route; drops.long_walk += got.long_walk;
  }
  if (digFailed) passed.dig_failed = digFailed;
  // BACK TO WHERE THE VEIN WAS STARTED FROM, once: the seal that follows is worked from that stand.
  let back = true;
  const end = bot.entity.position.floored();
  if (end.x !== home.x || end.y !== home.y || end.z !== home.z) {
    const went = await locomotion.goTo({ x: home.x, y: home.y, z: home.z, exact: true, leg: 'work' });
    back = !!went?.arrived;
    if (!back) watcher.warn('mining_executor', `Vein ${seg.id}: could not get back to (${home.x},${home.y},${home.z}) after the pickups (${went?.reason || 'no reason given'}) — the walls stay open for the next pass.`);
  }
  const list = (o) => Object.entries(o).map(([n, c]) => `${n}=${c}`).join(' ') || 'none';
  watcher.summary('mining_executor', `VEINS ${seg.id} dug=${dug} | mined ${list(mined)} | passed ${list(passed)}`);
  if (dug > 0) watcher.summary('mining_executor', `VEIN_DROPS ${seg.id} ore=${dug} picked=${drops.picked}/${drops.seen} no_route=${drops.no_route} long_walk=${drops.long_walk}`);
  return { dug, mined, back };
}

// ── Tuning ───────────────────────────────────────────────────────────────────
const STEP_WAIT_MS = 200;
const PLACE_MAX_ATTEMPTS = 3;
const CENTER_EPS = 0.18;
const CENTER_TAP_MS = 90;
const CENTER_MAX_ITERS = 20;

// One real segment per dispatch; the manager batches multiple passes per surface trip. Already-built
// frontiers are skipped without counting against the cap, so one dispatch lands on one real segment.
const MAX_SEGMENTS_PER_DISPATCH = 1;

// Exit reasons meaning the dispatch did what it was for, even with rock left standing — shaft finished, or
// no work existed. Every other exit wins only if the worked segment came out clean
// (capsule.success below, the judge's loop input).
const GOAL_EXITS = new Set(['no_work', 'no_steps', 'shaft_complete']);

// Hard ceiling on repeat-digs of one gravity-affected position, bounding a pathological falling column
// without truncating a real one; hitting the cap warns and retries next scan pass.
const MAX_GRAVITY_DIGS = 64;

// Solid-fill candidates for a structural_fill reseal, preferring cobblestone then planks then dirt —
// cobblestone reads as the bot's own work and stays cheap to dig if breached again. Reads the
// canonical order (Law 16); no `||` fallback, since an absent group is a coding violation. A genuine
// shortage exits pocket_short (below), ending the retry.
const FILL_PREFERENCE = group_to_item.structural_fill;
const SOLID_FILL_TOKENS = new Set(['structural_fill']);

// Place steps the bot may defer for missing inventory (needs upstream crafting/smelting).
// structural_fill is excluded — a breach exits pocket_short (below) instead of deferring.
const MINING_OPTIONAL = new Set(['torch', 'soul_torch', 'furnace']);

// Same rendering as anchored_repair's shortfall line, so a shortfall reads as one shape end to end (Law 16).
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
// REASON_WHY — plain-English rationale per step reason mining_integrity stamps, surfaced in the
// per-segment decision manifest. Keys mirror mining_integrity.scanSegment's reason strings exactly.
const REASON_WHY = {
  carve_walkway: 'blueprint wants open air here but rock is present — dig it out (this voxel is part of the walkway/room being excavated)',
  wall_breach:   'blueprint wants a solid wall here but found AIR (a cave grazed the shaft) — seal the hole so the shaft stays enclosed',
  torch_missing: 'blueprint wants a torch here for lighting and none is present — place one',
  torch_blocked: 'a torch belongs here but a solid block occupies the slot — clear it, then place the torch',
  gravity_wall:  'a gravity block (sand/gravel) sits in a wall slot (cave-in risk) — dig it out and reseal with stable fill',
  missing:       'blueprint wants a specific block here and the slot is empty — place it',
  mismatch:      'the wrong block occupies this slot — clear it, then place the blueprint block',
};

// Cap on coordinates a reason group prints in the manifest; a large dig gets a "+N more" tail.
const MANIFEST_COORD_CAP = 12;

// Enumerate a still-damaged segment's residual steps as a warning — block, location, and why,
// reusing REASON_WHY (Law 16); flags gravity_affected since a cascading column is the common cause.
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

// logDecisionManifest — groups pending steps by reason and emits one line per reason with the
// rationale, action, coordinates, and (for place steps) the resolved fill item (Law 6, Law 5).
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

// ── Per-block mechanics (mining domain), injected into the shared anchored_repair primitive ──
// miningOps(bot) → the ops repairAtAnchor takes, for this body.
function miningOps(bot) {
  // digOne — dig one target; a gravity position is repeat-mined (dig, settle, re-check) until it
  // holds air. A dig that leaves the same non-gravity block is stuck (Law 13); MAX_GRAVITY_DIGS caps it.
  //
  // Triggers on the live block being gravel/sand, not the scan-time gravity_affected flag —
  // trusting the block in front of the bot is Invariant B.
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

  // placeOne — place one fill/torch block using the ev the primitive computed (ev.pos target,
  // ev.anchor/ev.face solid reference, ev.underFeet footing flag). Returns 'already' | true | false.
  // Under-feet pillarSteps onto the correct fill block; everything else places against the
  // primitive's chosen solid neighbour with no raycast.
  //
  // A refusal dumps the slot, neighbours, and item count so the cause is diagnosable from the warn
  // line alone (Law 5, Law 16). Success requires the slot to hold exactly the intended block, not
  // merely non-air, since a shaft seal must be the block meant (Law 25).
  async function placeOne(step, ev) {
    const pos = ev.pos;
    const itemName = resolveItemName(bot, step.type);
    if (!itemName) return false;

    if (ev.underFeet) {
      // Scaffolding footing, not structure — must not be laid in the cobblestone this shaft exists
      // to collect (Law 25).
      const res = await pillarStep(bot, { candidateItemNames: group_to_item.pillar_block });
      if (!res.success) watcher.warn('mining_executor', `pillarStep (footing) failed at (${pos.x},${pos.y},${pos.z}): ${res.reason}`);
      return res.success;
    }

    // The slot as the bot sees it right now, captured before anything touches it — a mismatch with
    // mining_integrity's wall_breach call means the scanner and placer disagree, not the placement.
    const before = bot.blockAt(pos);
    const beforeName = before && !isAir(before.name) ? before.name : 'air';
    if (before && !isAir(before.name)) {
      // normalizeBlockName so a torch standing as `wall_torch` reads as the held `torch` (Law 16).
      if (normalizeBlockName(before.name) === itemName) return 'already';
      // The scan's own wall rule: a block that satisfies the voxel stays. Digging it to lay the held
      // item instead can take the floor from under the body, when the block is its footing.
      if (miningIntegrity.wallSatisfied(step.type, before.name)) return 'already';
      const cleared = await performDig(bot, pos, before, 'mining_executor');
      if (!cleared) return false;
    }

    // Equip, the spawn-protection gate, combat checkpoint, aim, click and settle live in the place
    // route (Law 16). This executor's own criterion is stricter: a cell holding a different block
    // is a failure here even when the authority reports success (Law 25).
    const heldBefore = countInInventory(itemName, getBotInventory());
    const placed = await performPlace(bot, pos, ev.anchor, ev.face, itemName, 'mining_executor');

    const after = placed.after;
    const afterName = after && !isAir(after.name) ? after.name : 'air';
    if (placed.ok && normalizeBlockName(afterName) === itemName) {
      if (itemName === 'torch') watcher.summary('mining_executor', `torch placed at (${pos.x},${pos.y},${pos.z})`);
      return true;
    }

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

  return {
    digOne,
    placeOne,
    resolveItem: (type) => resolveItemName(bot, type),
    isOptional: (type) => MINING_OPTIONAL.has(type),
    tag: 'mining_executor',
    maxPlaceAttempts: PLACE_MAX_ATTEMPTS,
  };
}

module.exports = {
  receive: watcher.track('mining_executor', async (signalType, payload) => {
    if (signalType !== 'mining_executor') return;

    const bot = global.bot;
    const hq = require('@kernel/corporate_headquarters');
    // ── WHAT THE BOARD SAID THE FLEET CANNOT GET, READ OFF THE JOB ────────────
    // job_exclusions carries what job_board froze onto the magnet at the claim; this executor only
    // states what it is working without.
    const excluded = payload?.excluded || null;
    const jobExclusions = require('@thinking/job_exclusions');
    if (jobExclusions.names(excluded).length) {
      watcher.summary('mining_executor', `⤳ digging WITHOUT ${jobExclusions.names(excluded).join(', ')} — `
        + jobExclusions.names(excluded).map(t => `${t}: ${jobExclusions.why(excluded, t)}`).join(' · ')
        + `. A segment left dark is re-posted as maintenance once the material is reachable.`);
    }

    async function centerOnBlock() {
      if (microCenter && bot) {
        await microCenter(bot, { eps: CENTER_EPS, tapMs: CENTER_TAP_MS, maxIters: CENTER_MAX_ITERS, settleSleep: 50 });
      }
    }

    // ── processSegment: ONE cycle over a segment's steps via the anchored model. Stand at each anchor and
    //    dig-all/place-all within reach through the shared primitive. Returns the cycle's tally. ──
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

      // Anchor floors: a staircase copy's per-copy anchor stand-spots (from mining_blueprinter via
      // mining_integrity), or a cell's single floor-center anchor at world_position. The bot stands
      // at floor.y+1 and dig-all/place-all within reach — the same anchored model build_executor uses.
      const anchorFloors = isCell
        ? (seg.world_position ? [seg.world_position] : [])
        : (Array.isArray(seg.anchors) ? seg.anchors : []);
      if (anchorFloors.length === 0) {
        // A segment with no anchor stand-spots cannot be built by the anchored model; the blueprinter
        // guarantees anchors, so this is a coding violation (Law 13 — throw, never silently skip).
        throw new Error(`[mining_executor] CODING VIOLATION: segment ${seg.id} (${seg.type}) has no anchor stand-spots — cannot build via the anchored model.`);
      }
      const stands = anchorFloors.map(a => ({ x: a.x, y: a.y + 1, z: a.z }));

      // Nearest-anchor assignment: each step is worked from the anchor with the shortest server-
      // accurate reach (anchoredRepair.reachFromStand — the same metric the reach gate asserts, Law
      // 16), so each step runs at exactly one anchor and tallies never double-count.
      const groups = stands.map(() => []);
      for (const s of steps) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < stands.length; i++) {
          const d = anchoredRepair.reachFromStand(bot, stands[i], s.place);
          if (d < bestD) { bestD = d; best = i; }
        }
        groups[best].push(s);
      }

      const ops = miningOps(bot);

      let digOk = 0, digFail = 0, placeOk = 0, placeFail = 0, deferred = 0, cheatPlaced = 0;
      // A REQUIRED block the bot does not hold, in its own bucket from anchored_repair — the same
      // field build_executor turns into its pocket_short exit; mining is that pattern's second caller.
      let pocketShort = 0;
      const shortMaterials = {};
      for (let i = 0; i < stands.length; i++) {
        if (groups[i].length === 0) continue;
        // A wall cell that is also this stand's floor, owed a dig AND a place (loose gravel or sand under the
        // body), is swapped from the cell beside it: the body steps off, replaces it, and steps back
        // (anchored_repair.sidestepFooting), so the floor is never dug from on top of it (Law 17).
        const underStand = (s) => s.place.x === stands[i].x && s.place.y === stands[i].y - 1 && s.place.z === stands[i].z;
        const swapsFloor = groups[i].some(s => s.action === 'dig' && underStand(s)) && groups[i].some(s => s.action === 'place' && underStand(s));
        const r = await anchoredRepair.repairAtAnchor(bot, {
          stand: stands[i],
          steps: groups[i],
          label: `${seg.type} ${seg.id} anchor${i}`,
        }, swapsFloor ? { ...ops, footingSidestep: true } : ops);
        digOk += r.dig_ok; digFail += r.dig_fail;
        placeOk += r.place_ok; placeFail += r.place_fail;
        deferred += r.deferred; cheatPlaced += r.cheat_placed;
        pocketShort += r.pocket_short || 0;
        for (const [m, c] of Object.entries(r.short_materials || {})) shortMaterials[m] = (shortMaterials[m] || 0) + c;
      }

      const remaining = Math.max(steps.length - (digOk + placeOk), 0);
      const cheatStr = cheatPlaced > 0 ? ` (${cheatPlaced} corner/junction cheat-placed)` : '';

      // A pass that moved nothing while something deferred or failed loses its cause once the summary
      // below clears anchored_repair's buffered per-voxel WHY. Dump first — buffer.dump persists
      // without faking an error() (Law 13): a voxel waiting on a neighbour is environmental, not a crash.
      const madeProgress = (digOk + placeOk) > 0;
      if (!madeProgress && (deferred + digFail + placeFail) > 0) watcher.buffer.dump('mining_executor');

      watcher.summary('mining_executor', `Segment ${seg.id} pass: dig=${digOk}/${digOk + digFail} place=${placeOk}${cheatStr}/${placeOk + placeFail} deferred=${deferred} | ${remaining} steps remaining`);
      return { digOk, digFail, placeOk, placeFail, skipped: deferred, remaining, pocketShort, shortMaterials };
    }

    // ── settleSegment: work ONE segment (staircase copy or cell) cycle after cycle — rescan, dig all, place
    //    all — until it settles (anchored_repair.settle), so gravel a dig sets loose is dug and the hole it
    //    leaves is sealed before this segment is left. ──
    async function settleSegment(seg, opts = {}) {
      const s = await anchoredRepair.settle({
        label: `${seg.type} ${seg.id}`,
        tag: 'mining_executor',
        rescan: () => { const d = miningIntegrity.scanSegmentSteps(bot, seg, excluded); return d ? d.steps : []; },
        work: async (steps) => {
          const r = await processSegment({ ...seg, steps }, opts);
          return { dig_ok: r.digOk, dig_fail: r.digFail, place_ok: r.placeOk, place_fail: r.placeFail,
            skipped: r.skipped, pocket_short: r.pocketShort, short_materials: r.shortMaterials };
        },
      });
      return { digOk: s.dig_ok, digFail: s.dig_fail, placeOk: s.place_ok, placeFail: s.place_fail, skipped: s.skipped,
        remaining: s.remaining, pocketShort: s.pocket_short, shortMaterials: s.short_materials, settle: s.stop };
    }

    // ── Cell dispatch (Phase 5) ────────────────────────────────────────────────
    // The manager selects, hazard-scans, and stamps a cell on payload.dig_cell. Generate its
    // blueprint (Phase 4), diff it against the world (Phase 1), and dig it in one pass (D6), bypassing
    // the shaft scan + descent loop. The manager decides completion off progress, not steps_remaining.
    if (payload.dig_cell && payload.dig_cell.anchor) {
      const miningCellGraph = require('@perception/mining_cell_graph');
      const anchor = payload.dig_cell.anchor;
      // Unguarded: generateCell throws on stale HQ (Law 13 / D11) — a coding bug must stop the bot,
      // not end the chain silently (Law 8).
      const cellSeg = miningCellGraph.generateCell(anchor, payload.dig_cell);   // place blueprint (Phase 4); a strip segment by its shape
      let diff = miningIntegrity.scanSegmentSteps(bot, cellSeg, excluded);   // diff vs world (Phase 1)
      // A CELL IS JUDGED FROM WHERE IT CAN BE READ. A cell with blocks the body cannot sense from here is
      // walked to, then read again: a cell nobody has read holds no verdict.
      if (diff && diff.stats.unloaded > 0) {
        const nav = await require('@locomotion/locomotion_dispatcher').goToStand(anchor, { exact: false, purpose: 'mine:cell' });
        diff = miningIntegrity.scanSegmentSteps(bot, cellSeg, excluded);
        watcher.summary('mining_executor', `CELL OUT OF SIGHT ${cellSeg.id} — walked to it arrived=${!(!nav || nav.arrived === false)} unread_now=${diff ? diff.stats.unloaded : 0}`);
      }
      cellSeg.steps = diff ? diff.steps : [];
      cellSeg.y_bottom = diff ? diff.y_bottom : anchor.y;
      cellSeg.y_top = diff ? diff.y_top : anchor.y + 4;

      await centerOnBlock();
      let r;
      if (cellSeg.steps.length === 0) {
        r = { digOk: 0, placeOk: 0, digFail: 0, placeFail: 0, skipped: 0, remaining: 0 };
        watcher.summary('mining_executor', `Cell ${cellSeg.id} already matches the world — nothing to dig.`);
      } else {
        // A cell being made is closed to every peer's route and dig until its claim is released. A
        // finished cell under repair stays open: it is a corridor the field walks through.
        if (!payload.dig_cell.maintenance) {
          require('@kernel/foreman_link').closeClaimedArea(`cell:${cellSeg.id}`, miningCellGraph.cellWorkBox(anchor, payload.dig_cell));
        }
        r = await settleSegment(cellSeg, { isCell: true });
        // A STRIP MINES THE ORE IT UNCOVERS, then seals the walls it opened with the stone it took out.
        if (miningCellGraph.isStrip(payload.dig_cell) && !payload.dig_cell.maintenance) {
          const veins = await mineVeins(bot, cellSeg);
          if (veins.dug > 0 && veins.back) {
            const seal = await settleSegment(cellSeg, { isCell: true });
            r = { ...r, digOk: r.digOk + seal.digOk, digFail: r.digFail + seal.digFail, placeOk: r.placeOk + seal.placeOk, placeFail: r.placeFail + seal.placeFail };
          }
        }
      }

      // A cell is dug for material, so its drops are collected — the ones a short walk reaches (drop_collector).
      const cellDrops = await collectNearby(bot);
      watcher.summary('mining_executor', `drop_collector: ${cellDrops.result} picked=${cellDrops.picked_up}/${cellDrops.total_found}`);

      // Completion by integrity diff, not progress — a cell is a maintained blueprint, done iff its
      // diff is clean. Re-diff against the world and report clean plus remaining; the manager decides
      // complete / re-pass / stuck from these. Unguarded: a read-error branch here could only be a
      // defect (Law 25).
      const post = miningIntegrity.scanSegmentSteps(bot, cellSeg, excluded);
      // Clean is a cell read in full with nothing left to do; a cell with blocks still unread is not clean.
      const cellClean = !post || (post.steps.length === 0 && post.stats.unloaded === 0);
      const postRemaining = cellClean ? 0 : post.steps.length;
      const exitReason = cellClean ? 'cell_complete' : 'cell_incomplete';

      const capsule = payload.mining_executor || (payload.mining_executor = {});
      // Report the verdict computed above (Law 6, Law 13): a cell needing three dispatches reads
      // false, false, true, with `remaining` moving in the readable so a repeat isn't read as a stall.
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
      // No dumpExcess here: offloading is a job_board job (inventory_dump), fired only near-full.
      return routeToJudge('mining_executor', { ...payload, readable: capsule.readable });
    }

    // markSegmentBuilt — register a shaft segment in HQ as fully excavated; mining_executor owns the
    // built_segments section (Law 6). Add-only (Law 9), idempotent (skips ids already present).
    function markSegmentBuilt(id) {
      const reg = hq.readConfRoomFlag('mining_confrence_room', 'built_segments', {}) || {};
      if (reg[id]) return false;
      reg[id] = { built_at: new Date().toISOString(), writer: 'mining_executor' };
      hq.writeConfRoomFlag('mining_confrence_room', 'built_segments', reg);
      return true;
    }

    // ── Upkeep: once every segment is dug to the bottom, the shaft is ONE blueprint ─────────────────
    // Its voxels are every copy's voxels and its stand-spots every copy's anchors, top copy first, so
    // one settle works the whole shaft in one downward pass — each fix made from the stand nearest it,
    // in the order the staircase is walked — and the trip ends. No per-segment dispatch.
    await centerOnBlock();
    const shaftState = miningIntegrity.scan(bot, excluded);
    if (shaftState.shaft_excavated) {
      const copies = require('@perception/mining_blueprinter').generateStaircase().staircase_segments || [];
      const seen = new Set();
      const voxels = [];
      for (const c of copies) for (const v of c.voxels) {
        const k = `${v[0]},${v[1]},${v[2]}`;
        if (!seen.has(k)) { seen.add(k); voxels.push(v); }
      }
      const shaft = { id: 'mineshaft', type: 'staircase', world_position: copies[0] && copies[0].world_position,
        voxels, anchors: copies.flatMap(c => c.anchors || []) };
      const first = miningIntegrity.scanSegmentSteps(bot, shaft, excluded);
      const r = first
        ? await settleSegment({ ...shaft, steps: first.steps, y_top: first.y_top, y_bottom: first.y_bottom })
        : { digOk: 0, placeOk: 0, digFail: 0, placeFail: 0, skipped: 0, remaining: 0, settle: 'clean' };
      const capsule = payload.mining_executor || (payload.mining_executor = {});
      const exitReason = 'shaft_pass';
      capsule.success = r.remaining === 0;
      capsule.recursion_alert = true;
      capsule.result = 'shaft_pass';
      capsule.exit_reason = exitReason;
      capsule.segment_id = shaft.id;
      capsule.metrics = { dig_ok: r.digOk, place_ok: r.placeOk, fail: r.digFail + r.placeFail, skipped: r.skipped };
      capsule.steps_remaining = r.remaining;
      capsule.readable = `mining_executor: whole-shaft pass ${r.settle} dig=${r.digOk} place=${r.placeOk} fail=${r.digFail + r.placeFail} remaining=${r.remaining}`;
      watcher.summary('mining_executor', `WHOLE-SHAFT PASS: ${copies.length} copies as one blueprint (${voxels.length} voxels, ${shaft.anchors.length} stands) — settle ${r.settle}, dig=${r.digOk} place=${r.placeOk} fail=${r.digFail + r.placeFail}, ${r.remaining} step(s) left.`);
      return routeToJudge('mining_executor', { ...payload, readable: capsule.readable });
    }

    // ── Outer multi-segment loop (excavation, top down) ──────────────────────────

    let segmentsProcessed = 0;
    let totalDig = 0, totalPlace = 0, totalFail = 0, totalSkipped = 0;
    let lastRemaining = 0;
    let lastSegRange = '';
    let lastSegId = null;
    let exitReason = '';
    let lastShortMaterials = {};

    while (true) {
      const integrity = miningIntegrity.scan(bot, excluded);

      if (!integrity?.first_incomplete) {
        // No actionable segment surfaced. A fully excavated, intact shaft is done; otherwise the
        // frontier already matches the blueprint but isn't registered — claim it and re-scan. Bounded:
        // each mark advances the frontier.
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
      const r = await settleSegment(seg, { isCell });
      segmentsProcessed++;
      totalDig += r.digOk; totalPlace += r.placeOk;
      totalFail += r.digFail + r.placeFail; totalSkipped += r.skipped;
      const pocketShortThisPass = r.pocketShort || 0;
      if (pocketShortThisPass > 0) {
        lastShortMaterials = r.shortMaterials || {};
        watcher.warn('mining_executor', `Segment ${seg.id} short of ${describeShort(lastShortMaterials)} — required fill the bot is not carrying; a retry cannot conjure it.`);
      }
      lastRemaining = r.remaining;
      lastSegRange = `${seg.y_bottom}..${seg.y_top}`;
      lastSegId = seg.id;

      // Register the segment built the moment it diffs clean (fully dug, walls sealed — breaches are
      // never deferred). This flips mining_integrity from "excavate this" to "permanently maintain
      // this". Skipped for cells — owned by mining_cell_graph.
      if (!isCell) {
        {
          // Trust mining_integrity's null contract: null only when fully sensed and matching; a
          // non-null result means work remains or voxels are unsensed — not built yet (Invariant B, Law 13).
          const post = miningIntegrity.scanSegmentSteps(bot, seg, excluded);
          const clean = !post;
          if (clean && markSegmentBuilt(seg.id)) {
            watcher.summary('mining_executor', `Segment ${seg.id} fully excavated → registered built in HQ; now under permanent maintenance.`);
          } else if (!clean && wasDamagedBuilt) {
            // digOne repeat-mines the live block, so a still-damaged built segment is a genuine
            // residual, not gravity churn — name it for inspection (Law 13, Law 6).
            warnResidualSteps(seg.id, post);
          }
        }
      }

      // Material-short outranks the cap: the cap means "quota done", the shortfall means "blocked on
      // resupply" (Law 25). Requires zero progress this pass — a pass that placed something and ran
      // dry has genuinely advanced.
      if (pocketShortThisPass > 0 && (r.digOk + r.placeOk) === 0) {
        exitReason = 'pocket_short';
        break;
      }
      if (segmentsProcessed >= MAX_SEGMENTS_PER_DISPATCH) {
        exitReason = 'segment_cap';
        break;
      }
      watcher.summary('mining_executor', `Segment ${segmentsProcessed}/${MAX_SEGMENTS_PER_DISPATCH} done (y=${lastSegRange}) — descending to next segment.`);
      await centerOnBlock();
    }

    const capsule = payload.mining_executor || (payload.mining_executor = {});
    // A goal exit is a win even with rock left standing — the dispatch did what it was for. A
    // 'segment_cap' exit is a win only if the segment it worked came out clean (GOAL_EXITS above; Law 6).
    capsule.success = GOAL_EXITS.has(exitReason) || lastRemaining === 0;
    capsule.recursion_alert = true;

    if (segmentsProcessed === 0) {
      // No work existed this dispatch (shaft already complete / no steps).
      capsule.result = exitReason;
      capsule.steps_remaining = 0;
      capsule.readable = `mining_executor: ${exitReason}`;
      watcher.summary('mining_executor', `No segments processed (${exitReason}).`);
    } else {
      capsule.result = 'pass_complete';
      capsule.segment_id = lastSegId;
      capsule.segment_y_range = lastSegRange;
      capsule.segments_processed = segmentsProcessed;
      capsule.exit_reason = exitReason;
      capsule.metrics = { dig_ok: totalDig, place_ok: totalPlace, fail: totalFail, skipped: totalSkipped };
      capsule.steps_remaining = exitReason === 'shaft_complete' ? 0 : lastRemaining;
      // The worked segment's id must be in the readable: recursive_judge signatures on (from, success,
      // readable), so an id-less readable would collapse distinct segments into one signature — the id
      // partitions genuine progress from a real stall (same id repeating).
      const shortStr = exitReason === 'pocket_short' ? ` short=[${describeShort(lastShortMaterials)}]` : '';
      capsule.readable = `mining_executor: seg ${lastSegId} ${segmentsProcessed}x ${exitReason}${shortStr} dig=${totalDig} place=${totalPlace} fail=${totalFail}`;
      watcher.summary('mining_executor', `BATCH DONE: ${segmentsProcessed} segment(s), exit=${exitReason}${shortStr}, dig=${totalDig} place=${totalPlace} fail=${totalFail}.`);
      // No dumpExcess here: offloading is a job_board job (inventory_dump), fired only near-full.
    }

    routeToJudge('mining_executor', { ...payload, readable: capsule.readable });
  }),
};
