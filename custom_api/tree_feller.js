// api: tree_feller
// purpose: Fell a single tree in place. Handles approach via locomotion, climb-and-fell
//          (clear every log connected to the base, pillaring up as reach requires so the
//          whole tree comes down and nothing is left hanging), descent cleanup, vegetation
//          clip, and drop collection. It does NOT replant — felling is canopy-clearing
//          (wild trees near base must not regrow, for camera shots); replanting is the
//          tree-farm system's job, at fixed farm spots away from base (Architect 2026-07-11).
//
// Two calling modes (Law 15 sub-loop):
//   await tree_feller.fell(bot)                  — scan for closest tree, approach, fell
//   await tree_feller.fell(bot, trunkPos)         — approach this trunk and fell it
//   await tree_feller.fell(bot, trunkPos, opts)   — approach, fell, with options
//
// opts.excludeTrees: string[] of "tree:x,y,z" keys to skip in self-scan mode — trees a
//   previous attempt in THIS signal chain reached but couldn't fell (harvest_executor
//   carries the list). Stops the bot re-selecting the same nearest trunk and stalling on it.
// opts.canopyZone: { mode:'inside'|'outside', center:{x,z}, radius } — scopes self-scan wild felling
//   to the base camera zone ('inside', clear the canopy) or beyond it ('outside', log supply that
//   never re-touches the cleared base). Omitted = no scoping (see applyCanopyZone).
// opts.preferNear: {x,y,z} — self-scan RANKING origin. Candidates are worked nearest-FIRST to this
//   coordinate instead of nearest-to-the-bot, so base clearing radiates outward from the blueprint
//   center (Architect 2026-07-12: "clear from closest to headframe"). Omitted = rank by bot position
//   (efficiency), the right default for far-off log supply. Only reorders selection; reach/approach
//   are unchanged.
//
// Returns: { success, minedCount, species, position }
// If locomotion cannot reach the tree, goTo abandons to recursive_judge (Law 15)
// and this invocation dies — the caller's promise never resolves.
//
// WHY climb-and-fell lives here (not in locomotion):
//   Locomotion's pillar-up moves are bounded single-cell corrections WHILE walking toward a
//   destination. Climbing a tree is an unbounded ascend-while-mining loop with NO destination —
//   it stops only when the trunk runs out. That is a harvesting technique, not a navigation
//   correction.

const watcher = require('@kernel/watcher');
const Vec3 = require('vec3');

// Entered through combatCheckpoint, never battleStations directly (Architect 2026-08-08: "remove it
// from the callers"). One process-wide 500 ms clock, shared with the dig and drive primitives that now
// carry the same gate, plus the engaging/escaping bypass so combat's own arms cannot re-enter it. The
// whole reasoning is in its header; a call a primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { performDig } = require('@utils/movement/dig_authority');
const { microCenter } = require('@utils/movement/motion_primitives');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { collectNearby } = require('@api/drop_collector.js');
const { HEADFRAME_SAFE_RADIUS } = require('@thinking/architect_config');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'tree_feller';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CONFIG = {
  digPause: 120,
  pillarRetry: 3,
  ascentPause: 160,
  cleanupPause: 110,
  vegetationClipRadius: 2
};

// Reachability sweep depth. The candidate list is sorted nearest-first, so a bot boxed into a
// pocket (dense forest, or a pit it felled itself into) finds its NEAREST trees unreachable while
// dozens further out stay reachable. A tight cap of 3 killed bots that had 50+ trees in range —
// it conceded after the 3 closest failed and never tried the rest (observed live 2026-07-03). Sweep
// deep before conceding; it's cheap now that a deterministic dead-end abandons after ONE locomotion
// attempt (locomotion_judge only retries on forward progress), so a boxed approach no longer burns a
// 4-attempt budget. A concede is a stable "no_reachable_free_tree"; before returning it, fell() makes
// ONE physical reposition to open ground and rescans (repositionToOpenGround) — a fresh A* from a
// clear cell reaches trees the boxed stance could not. Only a genuinely entombed/depleted bot
// exhausts both, and THEN the stable readable lets recursive_judge's identical-outcome counter kill
// the loop (Law 13). The varying "mined N" readables used to hide such a stall.
const MAX_UNREACHABLE_APPROACHES = 12;
const MAX_REPOSITION_ATTEMPTS = 6;   // goTo tries spent stepping out of a stuck pocket before conceding
const REPOSITION_RADII = [5, 7, 3];  // how far (cells) to step when repositioning

// A fell runs 8-30s (measured across a real run) with no natural summary between "Begin felling" and
// "Felled" — the bot stands at the base swinging, emitting nothing (per-block digs are unlogged by
// Law 5). That silent gap has TWO readers it misleads, which is why the cadence is now the navigator's,
// not a coarse anti-hang minimum:
//   1. a HUMAN reading the raw trace (Law 6/14) — a 25s gap is ambiguous: felling, or hung?
//   2. the footage motion classifier (monitoring/motion_classifier.js) — it splits moving-vs-doing by which
//      tag emits each second; a silent chop is only DOING by forward-filling the "Begin felling" vote
//      across the gap, i.e. by INFERENCE. A heartbeat every few seconds makes the chop STATE itself as
//      work instead (Law 23 — read it, don't infer it), and hardens the split if a MOVE line ever
//      intrudes mid-chop. This is the "reuse the debug trace for footage" dual-use, made legible here.
// The navigator narrates a long walk at PROGRESS_INTERVAL=3000; a chop is shorter and more localized,
// so 6s narrates it without doubling trace volume. Still one AGGREGATE line per interval (N down, M
// remaining), never per-log (Law 5). Well under the silence monitor's 120s — no regression there.
const FELL_PROGRESS_HEARTBEAT_MS = 6000;

const LOG_REGEX = /(.*_)?log$/;
const LEAF_REGEX = /(.*_)?leaves$/;
const CLIPPABLE_VEG_REGEX = /^(tall_grass|short_grass|fern)$/;

function isClippableVegetation(name) { return CLIPPABLE_VEG_REGEX.test(name); }

// ── Dig a single log or leaf block ─────────────────────────────────────────
// Unguarded, and the RETURN VALUE is now read. performDig REPORTS (false = cell not cleared), so the
// catch that stood here could only fire on a defect — while the actual refusal was discarded and this
// function answered `true` for a log still standing (Law 25).
async function digBlock(bot, block) {
  if (!block) return false;
  const isLeaf = LEAF_REGEX.test(block.name);
  const feet = bot.entity.position.floored();
  const isFootLevelBlock = block.position.x === feet.x && block.position.z === feet.z && block.position.y === feet.y - 1;
  const cleared = await performDig(bot, block.position, block, TAG);   // equips best tool internally (Law 16: one dig route)
  await sleep(isLeaf ? 10 : 50);
  if (isFootLevelBlock && !isLeaf) await sleep(100);
  return cleared;
}

// ── Reach + connected-tree model (Law 16: one definition of "the tree") ─────
// A fell removes EVERY log connected to the base, pillaring up as needed — a log left
// hanging in the air (with leaves clinging to it) is the immersion-breaker this exists
// to kill. Leaves are NOT stripped: once a tree's last log is gone its leaves decay on
// their own (vanilla), so mining the canopy is pure waste (~50 blocks/tree). We touch a
// leaf only when it blocks the line of sight to a log we are trying to dig.
const REACH = 4.5;                        // survival dig reach, measured from the eyes
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function eyeDist2(bot, p) {
  const e = bot.entity.position;
  const dx = (p.x + 0.5) - e.x, dy = (p.y + 0.5) - (e.y + 1.4), dz = (p.z + 0.5) - e.z;
  return dx * dx + dy * dy + dz * dz;
}
function withinReach(bot, p) { return eyeDist2(bot, p) <= REACH * REACH; }

// Flood-fill every log connected to the base through 26-neighbour adjacency: THIS is the
// tree. Branches connect log-to-log to the trunk so they're included; a neighbouring tree
// (not log-connected) is not, so felling never eats into the tree next door. Bounded so a
// pathological mega-canopy can't exhaust memory.
const MAX_TREE_LOGS = 512;
function collectTreeLogs(bot, base, inObjective) {
  const seen = new Set();
  const logs = [];
  const stack = [{ x: base.x, y: base.y, z: base.z }];
  while (stack.length && logs.length < MAX_TREE_LOGS) {
    const p = stack.pop();
    const key = `${p.x},${p.y},${p.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
    if (!b || !b.name || !inObjective(b.name)) continue;
    logs.push(new Vec3(p.x, p.y, p.z));
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          if (dx || dy || dz) stack.push({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
  }
  return logs;
}

// Open a line of sight to a log by clearing only the leaves on its faces that are in reach
// — enough for the dig to land, not a canopy strip.
async function clearBlockingLeaves(bot, logPos) {
  for (const [dx, dy, dz] of SIX) {
    const lp = new Vec3(logPos.x + dx, logPos.y + dy, logPos.z + dz);
    if (!withinReach(bot, lp)) continue;
    const b = bot.blockAt(lp);
    if (b && LEAF_REGEX.test(b.name)) await digBlock(bot, b);
  }
}

// ── Ground vegetation clipping (post-descent) ────────────────
async function clipGroundVegetation(bot) {
  const feet = bot.entity.position.floored();
  const r = CONFIG.vegetationClipRadius;
  let clipped = 0;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const p = new Vec3(feet.x + dx, feet.y + dy, feet.z + dz);
        const b = bot.blockAt(p);
        if (!b || b.name === 'air') continue;
        if (!isClippableVegetation(b.name)) continue;
        if (await performDig(bot, p, b, TAG)) { clipped++; await sleep(30); }   // only count vegetation that actually went
      }
    }
  }
  return clipped;
}

// ── Core fell loop: clear the WHOLE connected tree ─────────────────────────
// Flood-fill the tree's logs from the base, then repeat { mine everything in reach → if
// logs remain out of reach, pillar up one } until no log of the set survives. Pillaring
// raises the reach envelope, so a log 7 up is reached even though standing reach is ~4;
// the loop ends only when the connected set is empty (the whole-tree guarantee) or the
// bot can neither reach nor climb to the residual (rare awkward canopy — logged once, not
// spun on forever). Dirt pillars are removed on the way down. Returns { minedCount }.
// ── THE FELLER STANDS IN THE TRUNK, NOT BESIDE IT ────────────────────────────────────────────────
//
// Architect 2026-08-31: *"upgrade tree harvester to step into the trunk of the tree instead of to the
// side, it doesent collect efficently. if it mines directly above itself then drops land directly into
// its inventory. right now it stands off to the side and pillars sometimes. it should dig into center of
// tree and dig right above it and pill as much as it needs. to mine the tree."*
//
// WHAT THE BESIDE-STANCE COSTS, and it is collection rather than digging. A log broken from the side
// drops an item at the log's own cell, which then falls to the ground somewhere in the canopy's footprint
// — off a branch, into leaves, down a slope — and every one of them has to be walked to afterwards by
// drop_collector, which is the slowest verb the fleet owns. Broken from DIRECTLY OVERHEAD, the item falls
// down the shaft the bot is standing in and is picked up where it lands, for free, with no walk and no
// search. Same digs, same tool, the collection deleted.
//
// The stance also removes the pillar's worst case. From beside the trunk the bot pillars in open air
// next to the canopy and its reach envelope leans away from the logs; from inside, every pillar block
// goes into the column it has just emptied and the next log is always straight up.
//
// TWO CELLS ARE DUG TO GET IN — the base log and the one above it — because a body is two blocks tall and
// the trunk is solid. Both are objective logs and both are counted; this is the fell starting, not a
// clearing cost. The approach BEFORE this is unchanged and still lands the bot on a skirt cell beside the
// trunk (standAtTreeBase): a goTo aimed into solid logs is the search that exhausts its budget and stops
// short, which is the failure that stance exists to avoid. The bot walks up to the tree, then cuts in.
//
// FAILS SOFT, ON PURPOSE. If the two cells will not clear, or the step in does not land, the fell carries
// on from wherever the body is — the loop below works from reach and does not require the trunk stance,
// so a tree on a slope or against a cliff still comes down the old way rather than being conceded over a
// stance. Nothing here is allowed to turn an efficiency into a refusal.
async function enterTrunkColumn(bot, base, inObjective) {
  const feet0 = bot.entity.position.floored();
  if (feet0.x === base.x && feet0.z === base.z && feet0.y === base.y) return { entered: true, mined: 0 };

  let mined = 0;
  for (const dy of [0, 1]) {
    const p = new Vec3(base.x, base.y + dy, base.z);
    const b = bot.blockAt(p);
    if (!b || !inObjective(b.name)) continue;          // already air, or leaves — nothing owed here
    if (!withinReach(bot, p)) continue;                // out of reach from the skirt; the loop will get it
    await guardExternal(TAG, 'lookAt trunk entry', () => bot.lookAt(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)));
    if (await digBlock(bot, b)) mined++;
  }

  // A body cannot enter a column that is not two cells clear, and re-sensing is the only way to know —
  // a leaf, a vine or a second trunk cell can survive a dig that reported nothing (Invariant B).
  const clear = (dy) => {
    const b = bot.blockAt(new Vec3(base.x, base.y + dy, base.z));
    return !b || b.name === 'air' || b.boundingBox === 'empty';
  };
  if (!clear(0) || !clear(1)) {
    watcher.summary(TAG, `trunk entry skipped at (${base.x},${base.y},${base.z}) — column did not clear; felling from beside.`);
    return { entered: false, mined };
  }

  // exact:true — the feet must land IN the column, not within tolerance of it. A one-cell miss puts the
  // bot back beside the trunk with the entry already dug, which is the old stance minus two logs.
  const dispatcher = require('@locomotion/locomotion_dispatcher');
  const res = await dispatcher.goTo({ x: base.x, y: base.y, z: base.z, exact: true });
  const feet = bot.entity.position.floored();
  const entered = !!(res && res.arrived) && feet.x === base.x && feet.z === base.z;
  watcher.summary(TAG, entered
    ? `Standing IN the trunk at (${base.x},${base.y},${base.z}) — cutting straight up, drops fall to the body.`
    : `trunk entry did not land (feet ${feet.x},${feet.y},${feet.z}) — felling from beside.`);
  return { entered, mined };
}

async function climbAndFell(bot, base, objectiveList, protectedSet) {
  const inObjective = (name) => LOG_REGEX.test(name) && (!objectiveList.length || objectiveList.includes(name));
  const placedPillar = [];
  // Cells THIS climb pillared into are the bot's own scaffold, never the tree — exclude them from the
  // log-set so a scaffold block is never mined as a trunk (Invariant D: the tree's voxels have one
  // owner). Load-bearing rather than a belt: the throwaway pillar order is timber-first, so the
  // scaffold normally IS a log, standing 26-adjacent to the trunk it was placed beside.
  const placedKeys = new Set();
  let minedCount = 0;

  // The tree is flood-filled BEFORE the entry cuts into it, or the two cells the entry removes are never
  // members of the set and the count comes back two short of the tree that actually fell (Law 25).
  const treeLogs = collectTreeLogs(bot, base, inObjective);

  const entry = await enterTrunkColumn(bot, base, inObjective);
  minedCount += entry.mined;
  const inTrunk = entry.entered;

  const present = () => treeLogs.filter(p => {
    const key = `${p.x},${p.y},${p.z}`;
    if (placedKeys.has(key)) return false;
    if (protectedSet && protectedSet.has(key)) return false;
    const b = bot.blockAt(p);
    return b && inObjective(b.name);
  });

  let stuckPillars = 0;
  let safety = 0;
  let lastProgress = Date.now();
  while (safety++ < 800) {
    await combatCheckpoint(bot, 'fell');

    const rem = present();
    if (rem.length === 0) break;                       // whole tree cleared — done

    // Progress heartbeat (Law 5) — see FELL_PROGRESS_HEARTBEAT_MS. Throttled aggregate, not per-log.
    if (Date.now() - lastProgress > FELL_PROGRESS_HEARTBEAT_MS) {
      watcher.summary(TAG, `Felling ${inTrunk ? 'from INSIDE the trunk' : 'from beside the trunk'}: `
        + `${minedCount} log(s) down, ${rem.length} remaining (feet y=${bot.entity.position.floored().y}).`);
      lastProgress = Date.now();
    }

    // Anti-oscillation (Architect, 2026-07-03: bot bouncing at a treetop, digging underfoot then
    // re-pillaring forever). A log in the bot's OWN feet-column below its feet is its support —
    // digging it drops the bot into the hole, which then re-pillars back up onto a block placed in
    // that same cell: dig-underfoot ↔ pillar, net zero, forever. In an UPWARD fell the support is
    // never a trunk log the climb must clear (the bot approached at the base and rises BESIDE the
    // trunk), so excluding the support column costs nothing on a normal tree and removes the bounce
    // at its source (Law 16 — delete the bad pathway, don't detect-and-recover). Same-level and
    // higher logs are still dug; a residual that only ever sits under the feet is conceded below.
    const feet = bot.entity.position.floored();
    const isSupportColumn = (p) => p.x === feet.x && p.z === feet.z && p.y < feet.y;

    // OVERHEAD FIRST, LOWEST FIRST — the ordering is what makes the trunk stance pay. A log broken
    // directly above the body drops an item that falls down the emptied column and is picked up where the
    // bot stands; one broken off to the side drops into the canopy and becomes a walk for drop_collector.
    // Lowest-first within the column matters too: it opens the shaft from the bottom up, so every later
    // drop has a clear fall. Everything not overhead keeps the old nearest-first order, which is still
    // right for branches — and when the trunk stance was not taken, this reduces to exactly the old sort.
    const overhead = (p) => p.x === feet.x && p.z === feet.z && p.y > feet.y;
    const reachable = rem.filter(p => !isSupportColumn(p) && withinReach(bot, p)).sort((a, b) => {
      const oa = overhead(a), ob = overhead(b);
      if (oa !== ob) return oa ? -1 : 1;
      if (oa && ob) return a.y - b.y;
      return eyeDist2(bot, a) - eyeDist2(bot, b);
    });
    let minedThisCycle = 0;
    for (const p of reachable) {
      // ── THE GATE BELONGS ON THE LOG, NOT ON THE CYCLE (Architect soak 2026-08-06) ─────────────────
      // It used to sit only at the top of the outer `while`, which made a whole inner pass one
      // uninterruptible block of digging. A pass over 5-8 reachable logs runs 8-15 s, and the run of
      // 2026-08-06 spent exactly that inside one: felling began at [17m 18s], a spider opened at
      // [17m 26s], and the bot died at [17m 33s] having taken SEVEN blows from 1.2-2.4 b with aggro
      // confirmed on every one — and the gate was never reached, so no counter ever ran.
      //
      // Perception was never the fault and tuning the scanner cannot reach this: the hurt rows printed
      // `spider#4277 1.4b (aggro✓)` throughout, because that handler runs on a packet listener while
      // the gate runs only where a fragment awaits it. The bot could SEE it the whole time. What it
      // could not do was stop chopping — the preemption point Law 4 requires simply was not in the loop.
      //
      // Per-log is the same granularity farm_executor and torch_executor already use for their cells
      // (Law 16 — the pattern is reused, not re-invented). The abandonment path is unchanged:
      // battleStations owns Law 15, so a fight discards this whole fell rather than returning into it.
      //
      // The COST claim this comment used to carry ("one scan per log") is no longer true and was the
      // reason a per-block gate looked expensive: since 2026-08-08 the call is paced by one process-wide
      // clock and a log felled inside 500 ms of the last poll costs nothing at all. The dig underneath it
      // now polls on the same clock too, so this line is a floor, not the only cover.
      await combatCheckpoint(bot, 'fell');
      let b = bot.blockAt(p);
      if (!b || !inObjective(b.name)) continue;
      await guardExternal(TAG, 'lookAt log', () => bot.lookAt(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)));
      let ok = await digBlock(bot, b);
      if (!ok) {                                        // LOS likely blocked by leaves — open it and retry once
        await clearBlockingLeaves(bot, p);
        b = bot.blockAt(p);
        if (b && inObjective(b.name)) ok = await digBlock(bot, b);
      }
      if (ok) { minedCount++; minedThisCycle++; await sleep(CONFIG.digPause); }
    }
    if (minedThisCycle > 0) { stuckPillars = 0; continue; }   // clearing may bring more into reach

    // Nothing reachable. Pillaring only raises the reach envelope UPWARD, so it can bring HIGHER logs
    // into range but never one at or below the feet. If every residual log is at/below feet level,
    // climbing further just moves away from them (runaway-up, the other half of the oscillation) —
    // concede instead. Leaves decay on their own once the connected trunk above is gone.
    const anyAbove = rem.some(p => p.y > feet.y);
    if (!anyAbove) {
      watcher.warn(TAG, `fell_incomplete residual_logs=${rem.length} all at/below feet (y=${feet.y}) — pillaring cannot reach them, conceding (leaves decay).`);
      break;
    }

    // Logs remain ABOVE but out of reach → pillar up to raise the reach envelope, from the canonical
    // throwaway order (pillarConfig.defaultPriority). That order is timber-first, so the block placed
    // here is normally a LOG: 26-adjacent to the trunk and matching inObjective, i.e. indistinguishable
    // from the tree to this loop's own flood-fill. placedKeys (above) is what stops the feller mining
    // its own scaffold and re-erecting it next dispatch — an endless same-coord fell.
    // That guard is per-climb and LOCAL, so it cannot cover a peer: a placed log column resting on
    // solid ground reads as a ground-supported trunk base to any other bot's scan. The peer half is
    // closed one level up, by the arbiter's 5x5 tree column (overseer_brain.js), not here — a
    // scaffold-block swap would only move that hole, since any pillar sits beside a trunk regardless.
    await microCenter(bot);
    const res = await pillarStep(bot, { debug: true });
    if (res.success && res.placedPosition) {
      placedPillar.push(res.placedPosition);
      placedKeys.add(`${res.placedPosition.x},${res.placedPosition.y},${res.placedPosition.z}`);
      stuckPillars = 0; await sleep(CONFIG.ascentPause);
    }
    else if (++stuckPillars >= CONFIG.pillarRetry) {
      watcher.warn(TAG, `fell_incomplete residual_logs=${rem.length} — could not reach or pillar to them (reason=${res?.reason || 'unknown'}).`);
      break;
    } else {
      await sleep(120);
    }
  }

  // Descent: remove the dirt pillar we placed, top-down.
  //
  // DELIBERATELY NOT GATED, unlike the felling loop above — and this is the wrong turn to know about
  // before making it. The obvious symmetry ("the fell loop needed a gate, so this does too") trades a
  // known failure for a worse one: the bot is standing ON the pillar it is removing, so a counter that
  // opened here would move a body that is nine blocks up with nothing under it but the column it is
  // mid-way through deleting. That is predictable self-injury, which Law 17 forbids at the planning
  // layer, and it is not what killed anything — the 2026-08-06 death happened during FELLING, which
  // runs 8-15 s, where this runs ~5 s of throwaway dirt and ends with the body on the ground.
  //
  // The gate at the top of the next cycle catches the fight one descent later, at ground level, where a
  // counter can actually move. If this window ever does prove fatal, the fix is to ABANDON the pillar
  // and gate at the bottom — never to fight from the top of it.
  for (let i = placedPillar.length - 1; i >= 0; i--) {
    const b = bot.blockAt(placedPillar[i]);
    if (b && b.name !== 'air') { await digBlock(bot, b); await sleep(CONFIG.cleanupPause); }
  }
  if (placedPillar.length) watcher.summary(TAG, `Cleaned pillar blocks count=${placedPillar.length}`);

  return { minedCount, pillarCount: placedPillar.length };
}

// ── Trunk approach: walk to a walkable skirt cell beside the trunk ──────────
// A cell the bot's body can occupy: air / non-colliding vegetation. Null (unloaded
// chunk) counts as BLOCKED — never plan a stance into a cell we can't see (Law 17).
const OCCUPIABLE_RE = /^(air|cave_air|void_air|tall_grass|short_grass|fern|large_fern|dead_bush|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|snow|.*_sapling)$/;
function cellOccupiable(bot, x, y, z) {
  const b = bot.blockAt(new Vec3(x, y, z));
  return !!(b && b.name && OCCUPIABLE_RE.test(b.name));
}
// Solid walkable support: a real block, not occupiable, not a liquid/hazard to stand over.
function cellSupport(bot, x, y, z) {
  const b = bot.blockAt(new Vec3(x, y, z));
  return !!(b && b.name && b.name !== 'air' && !OCCUPIABLE_RE.test(b.name) && !/water|lava/.test(b.name));
}
// A stance = feet clear, head clear, solid ground one below.
function isStandCell(bot, x, y, z) {
  return cellOccupiable(bot, x, y, z) && cellOccupiable(bot, x, y + 1, z) && cellSupport(bot, x, y - 1, z);
}

// The trunk base is a SOLID log — a goTo aimed at it hunts a goal A* can never stand in,
// so in dense forest the search exhausts its node budget and stops blocks short (observed
// live: 1500/1500 nodes, 2.8 short → astar_no_path, 2026-07-03). Instead pick a real
// standable cell next to the base — one of the 8 horizontal neighbours, at the base level
// or a step up/down for gentle slopes — nearest the bot, cardinal preferred so it faces the
// trunk squarely and climbAndFell's reach clears it. Null = trunk fully boxed in.
function findSkirtCell(bot, base) {
  const feet = bot.entity.position.floored();
  let best = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const x = base.x + dx, z = base.z + dz;
      for (const dy of [0, -1, 1]) {   // level first, then step down/up
        const y = base.y + dy;
        if (!isStandCell(bot, x, y, z)) continue;
        const d2 = (x - feet.x) ** 2 + (y - feet.y) ** 2 + (z - feet.z) ** 2;
        const penalty = (dx !== 0 && dz !== 0 ? 1 : 0) + Math.abs(dy) * 3;   // bias: near, cardinal, level
        const score = d2 + penalty;
        if (!best || score < best.score) best = { x, y, z, score };
        break;   // first standable Y for this column is enough
      }
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

// Give the navigator a reachable goal (the skirt cell), not the solid trunk. The bot lands
// within mining reach of the trunk — exactly the stance climbAndFell needs. Returns { arrived };
// a boxed-in trunk (no skirt) reports not-arrived so the caller moves to the next tree rather
// than burning a full locomotion retry budget on an unreachable stance.
async function standAtTreeBase(bot, dispatcher, base) {
  const skirt = findSkirtCell(bot, base);
  // reason distinguishes the two unlike ways an approach fails, so the caller's tally is not a
  // black box (Law 5/6): 'no_skirt' = geometry (no standable cell adjacent to the trunk — a boxed
  // pillar/dense pocket); 'nav_failed' = a stance EXISTS but A* couldn't reach it (a locomotion
  // problem — e.g. leaf-cost detours, stranding). Different diagnosis, different fix.
  if (!skirt) return { arrived: false, reason: 'no_skirt' };
  const feet = bot.entity.position.floored();

  // THE ALREADY-CLOSE SHORTCUT MAY NOT FIRE FROM THE TRUNK'S OWN COLUMN, and that exception is the
  // whole reason this branch is not a bare distance test. Standing ON the base log puts the bot one
  // block above it and one block horizontally from a skirt cell, which passes both tolerances — so
  // the shortcut answers `arrived: true` for the one stance from which the tree cannot be felled at
  // all: climbAndFell excludes the bot's own feet-column log as its support, and on a trunk with
  // nothing above that log it is the ONLY objective, so the fell mines zero and reports
  // no_blocks_mined. Nothing recovers from it either — the stance is re-derived identically on the
  // next chain, so the same trunk is re-picked and re-conceded for as long as it ranks nearest.
  // `arrived` is consumed as settled fact by a caller that does not re-check it (Law 16 forbids the
  // redundant pathway), so a stance this function knows is unworkable may not be certified reachable
  // (Law 25). Skirt cells are always horizontally offset (findSkirtCell skips dx=dz=0), so failing
  // the shortcut here costs one short walk off the trunk and restores an ordinary beside-stance.
  //
  // THE WRONG TURN: fixing this in climbAndFell instead, by letting the support column be dug when
  // no log is above it. That trades a stalled fell for an unbounded drop — the bot mines the block
  // holding it up at whatever height it stands — and re-opens the dig-underfoot ↔ re-pillar
  // oscillation the support exclusion exists to close. The stance is the fault; fix the stance.
  const onTrunkColumn = feet.x === base.x && feet.z === base.z;
  const hDist = Math.hypot(feet.x - skirt.x, feet.z - skirt.z);
  if (!onTrunkColumn && hDist <= 1.5 && Math.abs(feet.y - skirt.y) <= 1) return { arrived: true };
  const res = await dispatcher.goTo({ x: skirt.x, y: skirt.y, z: skirt.z });
  return (res && res.arrived) ? { arrived: true } : { arrived: false, reason: 'nav_failed' };
}

// Object lock (arbiter flavor a — physical exclusivity, see overseer_brain.js taxonomy):
// a felled tree is one object, claimed by its base block. Chosen at EXECUTION time from
// live perception, so the planning token can't cover it — this claim is what stops two
// bots working the same trunk. Returns true if this bot holds the tree. In single-bot
// mode requestClaim always grants, so this is a no-op gate.
// Unguarded: the claim is ours and answers in `granted`. A catch here reports "a peer holds this tree"
// for a defect, and the sweep above then walks past every tree in turn for the same non-reason.
async function _claimTree(overseerLink, key) {
  const res = await overseerLink.requestClaim(key);
  return !!(res && res.granted);
}

// ── Candidate selection + unstick (self-scan mode) ───────────────────────────
const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// preferSpecies (optional) sorts the preferred wood AHEAD of everything else, distance breaking ties
// within each half — a two-key sort, never a filter. Every non-preferred tree is still in the list and
// still gets felled once the preferred ones are exhausted or unreachable, which is the whole difference
// from the fleet-wide species LOCK removed on 2026-07-16 (see scanAllLogs). Pass nothing and the ranking
// is pure distance, unchanged — that is what canopy clearing gets, and why the two never mix.
function rankByProximity(candidates, origin, preferSpecies = null) {
  return candidates
    .map(c => ({ c, d2: (c.position.x - origin.x) ** 2 + (c.position.y - origin.y) ** 2 + (c.position.z - origin.z) ** 2 }))
    .sort((a, b) => {
      if (preferSpecies) {
        const ap = a.c.name === preferSpecies ? 0 : 1;
        const bp = b.c.name === preferSpecies ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      return a.d2 - b.d2;
    });
}

// Walk the ranked trees nearest-first: claim each, try to reach its skirt, stop at the first one
// the bot can stand beside. Claim-BEFORE-walk stops two bots converging on one tree; a claimed but
// unreachable tree is released and the sweep continues. Bounded by MAX_UNREACHABLE_APPROACHES so a
// truly boxed bot doesn't churn the whole list. Returns { pick|null, peerHeld, unreachable, spent }.
async function selectReachableTree(bot, dispatcher, overseerLink, ranked, excludeTrees) {
  let peerHeld = 0, boxed = 0, pathFailed = 0, spent = 0;
  for (const { c } of ranked) {
    const key = `tree:${c.position.x},${c.position.y},${c.position.z}`;
    if (excludeTrees && excludeTrees.has(key)) { spent++; continue; }
    if (!(await _claimTree(overseerLink, key))) { peerHeld++; continue; }
    const approach = await standAtTreeBase(bot, dispatcher, c.position);
    if (approach && approach.arrived) {
      return { pick: { chosenPos: c.position, chosenName: c.name, treeKey: key }, peerHeld, boxed, pathFailed, spent };
    }
    overseerLink.releaseClaim(key);   // claimed but couldn't reach — free it, try the next
    if (approach && approach.reason === 'no_skirt') boxed++; else pathFailed++;
    if (boxed + pathFailed >= MAX_UNREACHABLE_APPROACHES) break;
  }
  return { pick: null, peerHeld, boxed, pathFailed, spent };
}

function openStanceColumn(bot, x, z, yGuess) {
  for (const dy of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
    if (isStandCell(bot, x, yGuess + dy, z)) return { x, y: yGuess + dy, z };
  }
  return null;
}

// Last resort before conceding no_reachable_free_tree: the nearest trees are all blocked, which
// usually means WHERE the bot stands is the problem (boxed by dense trunks, or a pit it felled
// itself into), not that the trees are gone. Step to open ground AWAY from that pocket so the next
// rescan's A* starts from a clear cell. Picks a standable cell along the 8 compass steps, the one
// best aligned with the away-from-pocket vector first. Returns true only if the bot actually moved.
async function repositionToOpenGround(bot, dispatcher, ranked) {
  const feet = bot.entity.position.floored();
  const cluster = ranked.slice(0, Math.min(ranked.length, MAX_UNREACHABLE_APPROACHES));
  if (!cluster.length) return false;
  let cx = 0, cz = 0;
  for (const { c } of cluster) { cx += c.position.x; cz += c.position.z; }
  cx /= cluster.length; cz /= cluster.length;
  let ax = feet.x - cx, az = feet.z - cz;
  if (ax === 0 && az === 0) ax = 1;   // standing on the centroid: pick a fixed direction
  const dirs = DIRS8
    .map(([dx, dz]) => ({ dx, dz, dot: dx * ax + dz * az }))
    .sort((a, b) => b.dot - a.dot);
  let tried = 0;
  for (const { dx, dz } of dirs) {
    for (const R of REPOSITION_RADII) {
      const cell = openStanceColumn(bot, feet.x + dx * R, feet.z + dz * R, feet.y);
      if (!cell) continue;
      if (tried++ >= MAX_REPOSITION_ATTEMPTS) return false;
      const res = await dispatcher.goTo(cell);
      if (res && res.arrived) {
        watcher.summary(TAG, `Repositioned to open ground (${cell.x},${cell.y},${cell.z}) — rescanning for a reachable tree.`);
        return true;
      }
    }
  }
  return false;
}

// Blueprint self-protection: never fell the build. A blueprint can contain LOG voxels stacked
// like a trunk (Architect's design), so surface_filter sees them as a ground-supported tree and
// the feller would mine the structure. Load the locked-blueprint voxel set the navigator protects
// (Law 16) and drop any tree candidate sitting on it; the set is also handed to climbAndFell so a
// connected branch that dips into blueprint space is spared. null = nothing locked.
// No catch (r33/D9): getProtectedBlocks CANNOT throw for "no headframe locked yet" — worldVoxelKeys
// returns null for that by design (blueprint_survey.js:298). So the old swallow could only ever fire
// on a genuine bug (bad require, HQ read throwing) and it converted that bug into null → "nothing is
// protected" → dropProtectedCandidates filters nothing → THE FELLER MINES THE BASE. A coding
// violation must reach a human, not disarm self-protection silently (Law 13).
function loadBlueprintProtected() {
  const buildingIntegrity = require('@perception/building_integrity');
  return buildingIntegrity.getProtectedBlocks('headframe');
}

function dropProtectedCandidates(objectives, protectedSet) {
  if (!protectedSet || !protectedSet.size) return objectives;
  return objectives.filter(o => !protectedSet.has(`${o.position.x},${o.position.y},${o.position.z}`));
}

// Base-canopy scoping (Architect 2026-07-11). Wild felling clears the base's camera zone — the
// square of half-extent HEADFRAME_SAFE_RADIUS around the headframe's build_center, the SAME "inside
// base" boundary torch_integrity lights and threat_scanner guards (Law 16 — one base-zone definition,
// every subsystem agrees where "base" ends). zone.mode:
//   'inside'  → keep only trees within the zone (clear the canopy so cameras see the base).
//   'outside' → keep only trees beyond it (log supply that never re-touches the cleared base).
// The caller (job board) picks the mode: 'inside' while the base still holds trees, 'outside' once
// it is clear. No zone / no locked base center → no scoping (unchanged wild-fell behavior).
function applyCanopyZone(objectives, zone) {
  if (!zone || (zone.mode !== 'inside' && zone.mode !== 'outside')) return objectives;
  const c = zone.center;
  if (!c || typeof c.x !== 'number') return objectives;
  const r = typeof zone.radius === 'number' ? zone.radius : HEADFRAME_SAFE_RADIUS;
  return objectives.filter(o => {
    const within = Math.max(Math.abs(o.position.x - c.x), Math.abs(o.position.z - c.z)) <= r;
    return zone.mode === 'inside' ? within : !within;
  });
}

// Tree census (Architect 2026-07-16). The scan ALWAYS runs; this replaces the old repetitive
// "No fellable trees within scan range" warn with a one-line census so a clearing area reads its own
// progress — how many fellable trees stand inside the caller's clear ring vs. the total in scan range
// (outside = total - inside falls out). Emitted on every self-scan, whether trees remain or the ring is
// clear, so the count is visible as the fleet draws it down (the Architect wants the SCAN kept loud, not
// quieted). No ring active (pre-base wild fell, canopyZone null) → just the scan-range total. Reuses
// applyCanopyZone's Chebyshev test so "inside" here means exactly what the fell filter means (Law 16).
function emitTreeCensus(fellable, zone) {
  const total = fellable.length;
  const c = zone && zone.center;
  if (!c || typeof c.x !== 'number') {
    watcher.summary(TAG, `Tree census: ${total} fellable tree(s) in scan range (no clear ring active).`);
    return;
  }
  const r = typeof zone.radius === 'number' ? zone.radius : HEADFRAME_SAFE_RADIUS;
  const inside = applyCanopyZone(fellable, { mode: 'inside', center: c, radius: r }).length;
  watcher.summary(TAG, `Tree census: ${inside} inside clear ring (r=${r}), ${total} total, ${total - inside} outside.`);
}

// ── Main API ───────────────────────────────────────────────────────────────
// fell(bot)              — scan for closest tree, approach, fell
// fell(bot, target)      — approach this trunk position and fell
// scanAllLogs — every tree is a CANDIDATE, always, whatever its species. That much is unchanged since
// 2026-07-16 ("remove the tree preference; harvest any and all trees equally from closest to furthest"),
// and it is the half that must never come back: the removed design rode a fleet-wide `wood_species`
// boardroom chair meaning "one species until it runs out", which FILTERED — a nearer birch was skipped
// to reach a committed oak. Nothing below filters. The scan still returns every species collapsed to
// trunk bases; what 2026-08-13 adds is a SORT KEY on top of distance, opt-in per caller.
//
// It does NOT decide the preference. That is `action_fragments.js/set_wood_preference`, a dispatched job
// with its own rank and its own magnet (Architect 2026-08-13: *"lets make the tree preverence a whole job
// and uses a magnet so only one bot can do it"*). The first draft of this feature set the preference here,
// as a side effect of the first scan that happened to see a tree — which meant a decision for the whole
// fleet was made by whichever bot's felling loop ran first, at whatever moment it ran, with no owner and no
// claim. Two bots could decide it simultaneously and differently. A fleet-wide choice needs one owner
// (Invariant D) and one occupant (Invariant A), and a job is what this system already has for both.
function scanAllLogs(bot, surfaceFilter) {
  // ENOUGH: the felling loop's scan is the HOTTEST caller in the fleet — it re-scans every ~12s while
  // it is looking for something to cut — so what it declines to pay for matters more here than
  // anywhere else. Measured on the live server 2026-09-04, one scan's rings cost 48:~200ms,
  // 112:~1.5s, 256:~10.5s, and the full horizon bought exactly ONE more tree (5 -> 6). Ten seconds
  // for a sixth candidate is never the right trade for THIS caller, because everything below filters
  // the set down hard anyway (blueprint logs excluded, peer-held trees skipped, unreachable ones
  // dropped) — in the run that produced those numbers, 5 found became 1 usable, and a 6th would have
  // changed nothing except when the bot got to try it.
  //
  // WHY 3 AND NOT 1: the filtering is exactly why it cannot ask for one. A single candidate that turns
  // out to be peer-held or stanceless sends the whole loop around again at full price; three gives the
  // filters something to survive. And it is a floor, not a cap — a ring that holds more still returns
  // all of them, so the common case of standing in a forest is unaffected.
  //
  // IT IS SET HERE RATHER THAN IN THE SCAN NODE because the same node serves set_wood_preference,
  // which wants a CENSUS of every trunk to pick a species and would be corrupted by an early stop
  // (Law 25 — the asker owns the criterion).
  return surfaceFilter.scan(bot, { type: 'object_group_or_direct', targets: ['logs'], enough: 3 });
}

// The reader. Returns null until the wood_preference_lock job has run, which every caller treats as "no
// preference" — the pure nearest-first ordering this fleet ran on until now. The fragment owns both the
// storage location and the read, so there is exactly one definition of where this value lives (Law 16);
// this is a thin pass-through so callers do not have to know which fragment holds it. Lazy require — the
// fragment pulls in the config and HQ, and this API is loaded early by several action fragments.
function getPreferredWoodSpecies() {
  const pref = require('@action/set_wood_preference').readWoodPreference();
  return pref ? pref.species : null;
}

// fell(bot, target, opts) — approach, fell, with options
//
// De-confliction is claim-BEFORE-walk: the tree is locked at selection, not on arrival.
// Claiming only after the walk let two bots pick the same closest trunk and both travel to
// it before either discovered the conflict — the loser wasted the whole trip. Now a peer-held
// tree is skipped before we move, so the bots diverge onto different trees from the start.
async function fell(bot, target, opts = {}) {
  const protectedSet = opts.protectedBlocks || loadBlueprintProtected();
  const excludeTrees = (Array.isArray(opts.excludeTrees) && opts.excludeTrees.length)
    ? new Set(opts.excludeTrees) : null;
  const overseerLink = require('@kernel/overseer_link');
  const dispatcher = require('@locomotion/locomotion_dispatcher');

  let chosenPos, chosenName, treeKey;

  if (target) {
    // ── Specific target mode: claim this trunk, then go fell it ─────────
    const pos = target instanceof Vec3 ? target : new Vec3(target.x, target.y, target.z);
    if (protectedSet && protectedSet.has(`${pos.x},${pos.y},${pos.z}`)) {
      watcher.summary(TAG, `Target (${pos.x},${pos.y},${pos.z}) is a blueprint block — refusing to fell the build.`);
      return { success: false, reason: 'target_is_blueprint', position: pos };
    }
    treeKey = `tree:${pos.x},${pos.y},${pos.z}`;
    if (!(await _claimTree(overseerLink, treeKey))) {
      watcher.summary(TAG, `Tree at (${pos.x},${pos.y},${pos.z}) held by a peer — abandoning target`);
      return { success: false, reason: 'tree_claimed_by_peer', position: pos };
    }

    watcher.summary(TAG, `Approaching claimed trunk at (${pos.x},${pos.y},${pos.z})`);
    const approach = await standAtTreeBase(bot, dispatcher, pos);
    if (!approach || !approach.arrived) {
      overseerLink.releaseClaim(treeKey);   // don't hold a tree we never reached
      watcher.warn(TAG, `Could not reach target (${pos.x},${pos.y},${pos.z})`);
      return { success: false, reason: 'approach_failed', position: pos };
    }

    const block = bot.blockAt(pos);
    chosenName = (block && LOG_REGEX.test(block.name)) ? block.name : 'unknown_log';
    chosenPos = pos;

  } else {
    // ── Self-scan mode: claim the closest FREE tree, then approach it ───
    const surfaceFilter = require('@perception/surface_filter');
    // NO GUARD ON A SCAN, HERE OR BELOW. The surface filter is ours; a throw escaping it is a defect,
    // and answering `scan_error` sends the judge a felling that found no trees rather than a fleet that
    // cannot see (Law 13).
    const scanResult = scanAllLogs(bot, surfaceFilter);
    const scanned = (scanResult?.objectives || []).filter(
      o => o && o.position && ['x', 'y', 'z'].every(k => typeof o.position[k] === 'number')
    );
    const unprotected = dropProtectedCandidates(scanned, protectedSet);
    if (protectedSet && unprotected.length < scanned.length) {
      watcher.summary(TAG, `Excluded ${scanned.length - unprotected.length} blueprint log(s) from tree candidates.`);
    }
    // Canopy zone scopes wild felling to the base's camera ring or beyond it (Architect 2026-07-11).
    const candidates = applyCanopyZone(unprotected, opts.canopyZone);
    // Report the census BEFORE the empty-return so a clear ring still prints "0 inside, N total"
    // (the informative signal that the base is clear but wild trees remain), not silence.
    emitTreeCensus(unprotected, opts.canopyZone);
    if (!candidates.length) {
      return { success: false, reason: 'no_trees_found' };
    }
    const candidatesKind = scanResult?.summary?.target || candidates[0].name;

    // Ranking origin: prefer the caller's coordinate (opts.preferNear — e.g. the headframe center) so
    // clearing works outward from the build; fall back to the bot for efficient log supply (Architect 2026-07-12).
    const rankOrigin = (opts.preferNear && typeof opts.preferNear.x === 'number') ? opts.preferNear : bot.entity.position;

    // opts.preferWood is the CALLER's declaration that this felling is for a material supply, not for
    // clearing ground. Gathering logs to build with wants one species; canopy clearing wants whatever
    // stands in the camera ring, and asking it to prefer would leave the wrong-species trees standing in
    // a "cleared" zone forever. The two verbs are told apart HERE, by the caller, exactly as the base
    // keep-out is owned by the harvest verb rather than built into the scan (Architect 2026-08-13: "make
    // sure you dont mix the two").
    const preferSpecies = opts.preferWood ? getPreferredWoodSpecies() : null;

    // Sweep the candidates nearest-first for the closest one we can actually stand beside
    // (claim-before-walk; see selectReachableTree). Skip trees this chain already reached-but-
    // couldn't-fell (opts.excludeTrees).
    let ranked = rankByProximity(candidates, rankOrigin, preferSpecies);
    let sel = await selectReachableTree(bot, dispatcher, overseerLink, ranked, excludeTrees);

    // Nearest trees all blocked → we're probably boxed where we stand, not out of trees. Step to
    // open ground and rescan ONCE before conceding: a fresh A* from a clear cell reaches trees the
    // pocket could not. Still nothing after that = genuinely entombed/depleted, and the stable
    // no_reachable_free_tree readable lets recursive_judge kill the loop (Law 13).
    if (!sel.pick) {
      const moved = await repositionToOpenGround(bot, dispatcher, ranked);
      if (moved) {
        const rescan = scanAllLogs(bot, surfaceFilter);
        const freshUnprotected = dropProtectedCandidates((rescan?.objectives || []).filter(
          o => o && o.position && ['x', 'y', 'z'].every(k => typeof o.position[k] === 'number')
        ), protectedSet);
        const fresh = applyCanopyZone(freshUnprotected, opts.canopyZone);
        if (fresh.length) {
          ranked = rankByProximity(fresh, rankOrigin, preferSpecies);
          sel = await selectReachableTree(bot, dispatcher, overseerLink, ranked, excludeTrees);
        }
      }
    }

    if (!sel.pick) {
      watcher.summary(TAG, `No claimable, reachable tree among ${candidates.length} (${sel.peerHeld} peer-held, ${sel.boxed} boxed-no-stance, ${sel.pathFailed} path-failed, ${sel.spent} spent) — replanning.`);
      return { success: false, reason: 'no_reachable_free_tree' };
    }
    chosenPos = sel.pick.chosenPos; chosenName = sel.pick.chosenName; treeKey = sel.pick.treeKey;
    watcher.summary(TAG, `Claimed ${candidatesKind} at (${chosenPos.x},${chosenPos.y},${chosenPos.z}) of ${candidates.length} (skipped ${sel.peerHeld} peer-held, ${sel.boxed} boxed-no-stance, ${sel.pathFailed} path-failed, ${sel.spent} spent).`);
  }

  // ── Settle on trunk center and fell (tree already claimed above) ─────
  await microCenter(bot);
  const objectiveList = [chosenName].filter(o => LOG_REGEX.test(o));
  watcher.summary(TAG, `Begin felling at (${chosenPos.x},${chosenPos.y},${chosenPos.z}) species=${chosenName}`);

  const { minedCount } = await climbAndFell(bot, chosenPos, objectiveList, protectedSet);

  // ── Post-fell: clip vegetation, collect drops ─────
  const clippedVegetation = await clipGroundVegetation(bot);
  if (clippedVegetation > 0) watcher.summary(TAG, `Ground vegetation clipped count=${clippedVegetation}`);

  const dropResult = await collectNearby(bot);
  watcher.summary(TAG, `drops: ${dropResult.picked_up} collected`);

  // Work at this tree is over either way — release the object lock.
  overseerLink.releaseClaim(treeKey);

  if (minedCount === 0) {
    watcher.warn(TAG, `No blocks mined at (${chosenPos.x},${chosenPos.y},${chosenPos.z})`);
    return { success: false, reason: 'no_blocks_mined', position: chosenPos, species: chosenName };
  }

  const extras = [];
  if (clippedVegetation) extras.push(`clipped ${clippedVegetation} veg`);
  watcher.summary(TAG, `Felled ${chosenName}, mined ${minedCount}${extras.length ? ', ' + extras.join(', ') : ''}`);

  return {
    success: true,
    minedCount,
    species: chosenName,
    position: chosenPos,
    drops: dropResult
  };
}

module.exports = { fell, getPreferredWoodSpecies };
