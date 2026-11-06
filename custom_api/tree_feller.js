// api: tree_feller
// purpose: Fells a single tree in place — approach, climb-and-fell (clears every connected log),
//   descent cleanup, vegetation clip, drop collection. Does not replant.
//
// Two calling modes (Law 15 sub-loop):
//   await tree_feller.fell(bot)                  — scan for closest tree, approach, fell
//   await tree_feller.fell(bot, trunkPos)         — approach this trunk and fell it
//   await tree_feller.fell(bot, trunkPos, opts)   — approach, fell, with options
//
// opts.excludeTrees: string[] of "tree:x,y,z" to skip in self-scan mode (reached-but-unfellable
//   trees this signal chain already tried; harvest_executor carries the list).
// opts.canopyZone: { mode:'inside'|'outside', center:{x,z}, radius } — scopes self-scan felling to
//   the base camera zone or beyond it. Omitted = no scoping.
// opts.species: '<wood>_log' — self-scan fells only trees of that species (an order that names one); absent, any.
// opts.preferNear: {x,y,z} — self-scan ring origin: the nearest ring to it with a tree is searched first, and inside
//   that ring the tree nearest the body. Omitted = rings from the bot.
//   Omitted or null = any tree.
// opts.leg: 'work' — every walk of this felling is the work leg (the body is already out on its ground: a walk tree
//   to tree is the task, not travel). Omitted = each walk keeps its own leg (travel).
//
// Returns: { success, minedCount, species, position }. If locomotion cannot reach the tree, goTo
// abandons to recursive_judge (Law 15) and this invocation dies unresolved.
//
// Climb-and-fell lives here, not in locomotion: locomotion's pillar-up is a bounded correction
// while walking; climbing a tree is an unbounded ascend-while-mining loop with no destination.

const watcher = require('@kernel/watcher');
const Vec3 = require('vec3');

// Entered through combatCheckpoint, never battleStations directly — the gate shared with the dig
// and drive primitives, asked on every call, with an engaging/escaping bypass for combat's own arms.
const { combatCheckpoint } = require('@api/battle_stations');
const { performDig } = require('@utils/movement/dig_authority');
const { microCenter } = require('@utils/movement/motion_primitives');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { collectNearby } = require('@api/drop_collector.js');
const { HEADFRAME_SAFE_RADIUS } = require('@thinking/architect_config');
const { guardExternal } = require('@utils/external_library_guard');
const { claimFirst, releaseTarget } = require('@utils/target_claims');
// The fleet's one answer to "can a body stand on this" (Law 16).
const { classifyFloor } = require('@utils/movement/terrain_predicates');

const TAG = 'tree_feller';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CONFIG = {
  digPause: 120,
  pillarRetry: 3,
  ascentPause: 160,
  cleanupPause: 110,
  vegetationClipRadius: 2
};

const REPOSITION_CLUSTER = 12;       // the nearest trunks whose middle a stuck body steps away from
const MAX_REPOSITION_ATTEMPTS = 6;   // goTo tries spent stepping out of a stuck pocket before conceding
const REPOSITION_RADII = [5, 7, 3];  // how far (cells) to step when repositioning

// Aggregate progress line during a fell, since per-block digs are unlogged (Law 5) and a silent chop
// reads as a hang to a human or the footage motion classifier.
const FELL_PROGRESS_HEARTBEAT_MS = 6000;

// A stripped log is no tree's: it stands only in a built structure, and its wood makes no planks a body can craft.
const LOG_REGEX = /^(?!stripped_)(.*_)?log$/;
const LEAF_REGEX = /(.*_)?leaves$/;
const CLIPPABLE_VEG_REGEX = /^(tall_grass|short_grass|fern)$/;

function isClippableVegetation(name) { return CLIPPABLE_VEG_REGEX.test(name); }

// ── Dig a single log or leaf block ─────────────────────────────────────────
// Unguarded; performDig's return value reports whether the cell actually cleared (Law 25).
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
// Removes every log connected to the base, pillaring up as needed. Leaves are not stripped (they
// decay once the last connected log is gone) except when one blocks line of sight to a log.
const REACH = 4.5;                        // survival dig reach, measured from the eyes
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function eyeDist2(bot, p) {
  const e = bot.entity.position;
  const dx = (p.x + 0.5) - e.x, dy = (p.y + 0.5) - (e.y + 1.4), dz = (p.z + 0.5) - e.z;
  return dx * dx + dy * dy + dz * dz;
}
function withinReach(bot, p) { return eyeDist2(bot, p) <= REACH * REACH; }

// Flood-fills every log connected to the base through 26-neighbour adjacency — this is what defines
// "the tree", so a neighbouring unconnected tree is never touched. Bounded against a mega-canopy.
const MAX_TREE_LOGS = 512;
function collectTreeLogs(bot, base, inObjective, isBuildWood = () => false) {
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
    if (isBuildWood(p)) continue;                        // the building's log beside a tree is not the tree
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
  const faces = SIX.map(([dx, dy, dz]) => new Vec3(logPos.x + dx, logPos.y + dy, logPos.z + dz));
  for (const lp of faces) {
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
  const cells = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 2; dy++) cells.push(new Vec3(feet.x + dx, feet.y + dy, feet.z + dz));
    }
  }
  for (const p of cells) {
    const b = bot.blockAt(p);
    if (!b || b.name === 'air') continue;
    if (!isClippableVegetation(b.name)) continue;
    if (await performDig(bot, p, b, TAG)) { clipped++; await sleep(30); }   // only count vegetation that actually went
  }
  return clipped;
}

// ── Core fell loop: clear the WHOLE connected tree ─────────────────────────
// Repeats { mine everything in reach → pillar up one if logs remain out of reach } until the
// connected set is empty or nothing residual can be reached or climbed to. Returns { minedCount }.
//
// The feller stands IN the trunk, not beside it: a log broken from directly overhead drops its item
// down the shaft, picked up on the spot.
// The two entry cells (base log and the one above) are dug to let the two-block-tall body in, and
// both count as mined. Fails soft — if entry does not clear or land, the loop still works from reach
// without the trunk stance.
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

  // exact:true — feet must land IN the column, not merely within tolerance of it.
  const dispatcher = require('@locomotion/locomotion_dispatcher');
  const res = await dispatcher.goTo({ x: base.x, y: base.y, z: base.z, exact: true, leg: 'work' });
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
  // Cells this climb pillared into are the bot's own scaffold, excluded from the log-set so a
  // scaffold block is never mined as a trunk (Invariant D: the tree's voxels have one owner).
  const placedKeys = new Set();
  let minedCount = 0;

  // The tree is flood-filled BEFORE the entry cuts into it, or the two cells the entry removes are never
  // members of the set and the count comes back two short of the tree that actually fell (Law 25).
  const treeLogs = collectTreeLogs(bot, base, inObjective, buildWoodTest(protectedSet));

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

    // A log below the bot's own feet is its support; digging it would drop the bot and trigger a
    // dig-underfoot/re-pillar bounce, so the support column is excluded (Law 16).
    const feet = bot.entity.position.floored();
    const isSupportColumn = (p) => p.x === feet.x && p.z === feet.z && p.y < feet.y;

    // Overhead logs are mined lowest-first, so the shaft opens from the bottom and every drop has a
    // clear fall to the bot. Non-overhead logs are ordered nearest-first for branches.
    const overhead = (p) => p.x === feet.x && p.z === feet.z && p.y > feet.y;
    const reachable = rem.filter(p => !isSupportColumn(p) && withinReach(bot, p)).sort((a, b) => {
      const oa = overhead(a), ob = overhead(b);
      if (oa !== ob) return oa ? -1 : 1;
      if (oa && ob) return a.y - b.y;
      return eyeDist2(bot, a) - eyeDist2(bot, b);
    });
    let minedThisCycle = 0;
    for (const p of reachable) {
      // Combat preemption checkpoint per log, not only at the outer loop's top, so a multi-log pass is
      // never one uninterruptible block (Law 4). battleStations discards this fell on a fight (Law 15).
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

    // Pillaring raises the reach envelope upward only, so it is worth a block only while a log above
    // also lies within reach sideways. Otherwise the climb ends here and the descent below takes what
    // comes into reach on the way down.
    const sideways = (p) => Math.hypot(p.x + 0.5 - (feet.x + 0.5), p.z + 0.5 - (feet.z + 0.5));
    const climbable = rem.some(p => p.y > feet.y && sideways(p) <= REACH);
    if (!climbable) {
      watcher.summary(TAG, `climb ends: residual_logs=${rem.length}, none above feet (y=${feet.y}) within ${REACH} blocks sideways — descending.`);
      break;
    }

    // Logs remain above but out of reach → pillar up. The placed block is normally a log, so
    // placedKeys guards this climb's own flood-fill from re-mining it; the peer case (another bot's
    // scan reading the scaffold as a trunk) is closed one level up by foreman_brain.js.
    await microCenter(bot);
    const res = await pillarStep(bot, { debug: true });
    if (res.success && res.placedPosition) {
      placedPillar.push(res.placedPosition);
      placedKeys.add(`${res.placedPosition.x},${res.placedPosition.y},${res.placedPosition.z}`);
      stuckPillars = 0; await sleep(CONFIG.ascentPause);
    }
    else if (++stuckPillars >= CONFIG.pillarRetry) {
      watcher.summary(TAG, `climb ends: residual_logs=${rem.length}, the pillar would not rise (reason=${res?.reason || 'unknown'}) — descending.`);
      break;
    } else {
      await sleep(120);
    }
  }

  // Descent: removes the placed pillar top-down, ungated — a combat preemption here would leave the
  // body standing mid-air on a column it is deleting, which Law 17 forbids. Each block is the one the
  // body stands on, so the dig lowers the body one block (lowerSelf). The descent ends at the first block
  // that stays, leaving the column beneath it whole for the body to stand on.
  let cleaned = 0;
  for (let i = placedPillar.length - 1; i >= 0; i--) {
    const b = bot.blockAt(placedPillar[i]);
    if (!b || b.name === 'air') continue;
    if (!await performDig(bot, b.position, b, TAG, { lowerSelf: true })) {
      watcher.warn(TAG, `pillar descent stopped at (${b.position.x},${b.position.y},${b.position.z}) — ${b.name} would not clear; `
        + `${i + 1} pillar block(s) left standing under the body.`);
      break;
    }
    cleaned++;
    await sleep(CONFIG.cleanupPause);
    // Each block lowered brings a new band of the tree into reach; what is in reach now is cut before the
    // next block comes out (the support column below stays).
    const low = bot.entity.position.floored();
    for (const p of present().filter(q => !(q.x === low.x && q.z === low.z && q.y < low.y) && withinReach(bot, q))) {
      const lb = bot.blockAt(p);
      if (!lb || !inObjective(lb.name)) continue;
      await guardExternal(TAG, 'lookAt log', () => bot.lookAt(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)));
      if (await digBlock(bot, lb)) { minedCount++; await sleep(CONFIG.digPause); }
    }
  }
  const left = present();
  if (placedPillar.length) watcher.summary(TAG, `Cleaned pillar blocks count=${cleaned} of ${placedPillar.length}`);

  return { minedCount, pillarCount: placedPillar.length, treeLogs: treeLogs.length, left };
}

// ── Trunk approach: walk to a walkable skirt cell beside the trunk ──────────
// A cell the bot's body can occupy: feet clear, head clear, solid ground one below. Asked through
// `classifyFloor` (Law 16), not a hardcoded block-name list (Invariant B); null counts as
// blocked (Law 17).
function isStandCell(bot, x, y, z) {
  return classifyFloor(bot, bot.blockAt(new Vec3(x, y - 1, z))) !== null;
}

// Picks a real standable cell beside the solid trunk base (8 horizontal neighbours, base level or a
// step up/down) on open ground, nearest the bot and cardinal-preferred. Null = no such cell.
// groundUnder — where a log's stand is looked for: the log's own level when it rests on the ground, else the
// first cell over solid ground straight below it, so a log hanging in the air is cut from the ground beneath it
// (and from a pillar raised there when it hangs out of reach).
const HANG_SCAN_DOWN = 32;
function groundUnder(bot, base) {
  for (let y = base.y - 1; y >= base.y - HANG_SCAN_DOWN; y--) {
    const b = bot.blockAt(new Vec3(base.x, y, base.z));
    if (!b) return base;
    if (b.boundingBox === 'block' && !LEAF_REGEX.test(b.name) && !LOG_REGEX.test(b.name)) return { x: base.x, y: y + 1, z: base.z };
  }
  return base;
}

function findSkirtCell(bot, log) {
  const { closedBy } = require('@locomotion/navigator');
  const feet = bot.entity.position.floored();
  const base = groundUnder(bot, log);
  const hangs = base.y !== log.y;
  let best = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0 && !hangs) continue;   // under a hanging log the cell straight below is a stand
      const x = base.x + dx, z = base.z + dz;
      for (const dy of [0, -1, 1]) {   // level first, then step down/up
        const y = base.y + dy;
        if (!isStandCell(bot, x, y, z)) continue;
        // The stand is chosen from open ground: a cell inside closed ground (the building's box, the
        // waste pit, a lane, a peer's work) is one the route planner ends no walk on.
        if (closedBy({ x, y, z })) continue;
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

// A STAND REACHED AFLOAT HAS NOT REACHED THE TREE: no dig is made afloat (dig_authority.bobbing), so the body is
// walked onto the skirt cell's floor, and a skirt it cannot get its feet on is a tree this body did not reach and
// passes over, the same rule ground_shave keeps for its tiles.
async function aground(bot, dispatcher, skirt) {
  const { bobbing } = require('@utils/movement/dig_authority');
  if (!bobbing(bot)) return { arrived: true };
  const res = await dispatcher.goToStand(new Vec3(skirt.x, skirt.y - 1, skirt.z), { purpose: 'ground_stand' });
  if (res && res.arrived && !bobbing(bot)) return { arrived: true };
  return { arrived: false, reason: 'afloat_at_stand' };
}

// Gives the navigator the skirt cell as goal, not the solid trunk. Returns { arrived }; a boxed-in
// trunk (no skirt) reports not-arrived so the caller moves on.
async function standAtTreeBase(bot, dispatcher, base) {
  const skirt = findSkirtCell(bot, base);
  // reason distinguishes the two ways an approach fails (Law 5/6): 'no_skirt' = geometry; 'nav_failed'
  // = a stance exists but A* couldn't reach it.
  if (!skirt) return { arrived: false, reason: 'no_skirt' };
  const feet = bot.entity.position.floored();

  // Excluded from the trunk's own column: standing ON the base log would pass both tolerances, but
  // that is the one stance climbAndFell can never fell from (its own feet-column log is excluded as
  // support), so the shortcut is forced onto a genuine, horizontally-offset skirt cell (Law 25).
  const onTrunkColumn = feet.x === base.x && feet.z === base.z;
  const hDist = Math.hypot(feet.x - skirt.x, feet.z - skirt.z);
  if (!onTrunkColumn && hDist <= 1.5 && Math.abs(feet.y - skirt.y) <= 1) return aground(bot, dispatcher, skirt);
  const startedAt = Date.now();
  const res = await dispatcher.goTo({ x: skirt.x, y: skirt.y, z: skirt.z });
  if (res && res.arrived) return aground(bot, dispatcher, skirt);
  ledgerUnreached(bot, base, skirt, feet, res, Date.now() - startedAt);
  return { arrived: false, reason: 'nav_failed' };
}

// ── A TREE THE WALK DID NOT REACH: ONE LINE, WITH WHAT IS NEEDED TO SAY WHY ────────────────────────
// Written beside the tree-search ledger and read by the same lens (`--trees`).
//   tree / stand / from   the trunk base, the cell the body was sent to stand in, where it set off
//   reason                locomotion's own verdict for the walk, verbatim
//   stand_closed_by       building | waste_pit | lane | peer when that stand cell lies in closed ground
//                         (a route search refuses such a goal before it starts), else open
//   ended                 where the body stood when the walk ended; moved is how far that is from `from`
//   under / at / above    the blocks at the stand cell's floor, feet and head as the body reads them now
function ledgerUnreached(bot, base, skirt, from, res, heldMs) {
  const name = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b ? b.name : 'unloaded'; };
  const end = bot.entity.position.floored();
  const reason = String((res && res.reason) || 'no_reason_stated').replace(/\s+/g, '_');
  watcher.summary('tree_search',
    `unreached tree=(${base.x},${base.y},${base.z}) stand=(${skirt.x},${skirt.y},${skirt.z}) from=(${from.x},${from.y},${from.z})`
    + ` flat=${Math.round(Math.hypot(skirt.x - from.x, skirt.z - from.z))} rise=${skirt.y - from.y}`
    + ` reason=${reason} attempts=${(res && res.attempts) || '-'}`
    + ` stand_closed_by=${require('@locomotion/navigator').closedBy(skirt) || 'open'}`
    + ` ended=(${end.x},${end.y},${end.z}) moved=${Math.round(Math.hypot(end.x - from.x, end.z - from.z))} held_ms=${heldMs}`
    + ` under=${name(skirt.x, skirt.y - 1, skirt.z)} at=${name(skirt.x, skirt.y, skirt.z)} above=${name(skirt.x, skirt.y + 1, skirt.z)}`);
}

// Object lock (arbiter flavor a — physical exclusivity, foreman_brain.js taxonomy): claimed by base
// block and top log, through target_claims, the one claim-reach-release walk every resource shares (Law 16).
// The key holds the 5x5 column from the base to the top (@utils/resource_footprint).
// spotOf names a tree's place the way a failed-tree list does (opts.excludeTrees); it is not a claim key.
const spotOf = (pos) => `tree:${pos.x},${pos.y},${pos.z}`;

// treeRootOf — the lowest log of the tree a log belongs to (collectTreeLogs' flood fill). A tree is claimed
// under its root, so a hanging log a peer's felling is about to take is the same claim as that peer's trunk.
function treeRootOf(bot, pos) {
  const logs = collectTreeLogs(bot, pos, (name) => LOG_REGEX.test(name));
  return logs.reduce((low, l) => (!low || l.y < low.y ? l : low), null) || pos;
}
// treeKeyOf — the claim key of the tree a log belongs to: its root and the height of its top log.
function treeKeyOf(bot, pos) {
  const logs = collectTreeLogs(bot, pos, (name) => LOG_REGEX.test(name));
  const root = logs.reduce((low, l) => (!low || l.y < low.y ? l : low), null) || pos;
  const top = logs.reduce((high, l) => Math.max(high, l.y), root.y);
  return `tree:${root.x},${root.y},${root.z},${top}`;
}

// A SKY LOG IS CHASED: a log hanging in the air is cut from a pillar raised on the ground under it
// (groundUnder), so no stub of wood is left floating in its leaves. The one log not walked to is a log
// within reach of a tree a peer is felling right now, hanging or grounded: that peer's flood fill and its
// re-stands already hold it and cut it while this body would still be walking. A peer felling from the
// bottom up leaves its claim key on a trunk base that may already be gone, so the reach is wider than a
// claim's own footprint.
const PEER_FELLING_RADIUS = 8;   // blocks, sideways, from a peer's claimed trunk: a big oak's spread
const RESTAND_MAX = 3;           // new stands a fell takes under the logs its first stand could not reach
function isPeersLog(pos) {
  const { boxOfKey } = require('@utils/resource_footprint');
  for (const key of require('@kernel/foreman_link').peerClaimKeys()) {
    const box = key.startsWith('tree:') ? boxOfKey(key) : null;
    if (box && Math.hypot((box.min.x + box.max.x) / 2 - pos.x, (box.min.z + box.max.z) / 2 - pos.z) <= PEER_FELLING_RADIUS) return true;
  }
  return false;
}
// standAtTreeBase answers in its own shape; the walk reads { ok, reason }.
const approachTree = (bot, dispatcher) => async (pos) => {
  const approach = await standAtTreeBase(bot, dispatcher, pos);
  return { ok: !!(approach && approach.arrived), reason: approach && approach.reason === 'no_skirt' ? 'no_skirt' : 'path_failed' };
};

// ── Candidate selection + unstick (self-scan mode) ───────────────────────────
const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// Ranks by distance only: every species is felled, and only the build's primary wood is replanted
// (sapling_planter), so the forest round the base turns to it over time.
function rankByProximity(candidates, origin) {
  return candidates
    .map(c => ({ c, d2: (c.position.x - origin.x) ** 2 + (c.position.y - origin.y) ** 2 + (c.position.z - origin.z) ** 2 }))
    .sort((a, b) => a.d2 - b.d2);
}

// isWetTree — a tree any of whose logs would let water flow when cut (pathfinding_utils.opensOntoWater, the
// prevent-flow rule). Every log of the tree is read (collectTreeLogs) when the scan offers it, before a claim
// or a walk, so felling never makes a flow and a body is never sent to a tree it may not finish: a search
// passes over it.
function isWetTree(bot, p) {
  const { opensOntoWater } = require('@utils/pathfinding_utils');
  return collectTreeLogs(bot, p, (name) => LOG_REGEX.test(name)).some(l => opensOntoWater(bot, l.x, l.y, l.z));
}

// passedOverWhy — why a search walks past a log without claiming it, or null when it would claim it:
//   peer_felling  within reach of a tree a peer is felling now (isPeersLog)
//   tried         on the caller's failed-tree list (opts.excludeTrees)
//   wet           cutting it would let water flow (isWetTree)
// The one answer to "would a fell take this tree", read by the search, so a felling never offers a tree
// it would not take.
function passedOverWhy(bot, pos, excludeTrees) {
  if (isPeersLog(pos)) return 'peer_felling';
  if (excludeTrees && (excludeTrees.has(spotOf(treeRootOf(bot, pos))) || excludeTrees.has(spotOf(pos)))) return 'tried';
  if (isWetTree(bot, pos)) return 'wet';
  return null;
}

// Walks the ranked trees nearest-first: claim each, try its skirt, stop at the first one reached. The
// walk ends on that tree or on the end of the list, whichever comes first.
// Claim-before-walk stops two bots converging on one tree. Returns { pick|null, peerHeld, spent, ... }.
async function selectReachableTree(bot, dispatcher, ranked, excludeTrees) {
  const approach = approachTree(bot, dispatcher);
  const passed = { peer_felling: 0, tried: 0, wet: 0 };
  const walk = await claimFirst(ranked.map(r => r.c), {
    keyOf: c => treeKeyOf(bot, c.position),
    skip: (c) => {
      const why = passedOverWhy(bot, c.position, excludeTrees);
      if (why) passed[why]++;
      return !!why;
    },
    approach: c => approach(c.position),
  });
  const boxed = walk.failures.no_skirt || 0;
  const tally = { peerHeld: walk.peerHeld, boxed, pathFailed: walk.unreachable - boxed, spent: walk.skipped,
    examined: walk.examined, passed };
  return walk.pick
    ? { pick: { chosenPos: walk.pick.position, chosenName: walk.pick.name, treeKey: walk.key }, ...tally }
    : { pick: null, ...tally };
}

function openStanceColumn(bot, x, z, yGuess) {
  for (const dy of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
    if (isStandCell(bot, x, yGuess + dy, z)) return { x, y: yGuess + dy, z };
  }
  return null;
}

// Last resort before conceding no_reachable_free_tree: steps to open ground away from the tree
// cluster's centroid so the next rescan's A* starts from a clear cell. Returns true iff it moved.
async function repositionToOpenGround(bot, dispatcher, ranked) {
  const feet = bot.entity.position.floored();
  const cluster = ranked.slice(0, REPOSITION_CLUSTER);
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

// Self-protection: a blueprint can contain LOG voxels stacked like a trunk, and the mine's walls take logs
// as fill, so either would otherwise read as fellable. Every locked blueprint's solid voxels and every
// voxel the navigator protects (buildings, the mine staircase, the mine cells) go into one Set (Law 16);
// null = nothing protected. Unguarded — a swallowed throw would read as "nothing protected" and let the
// feller mine the base (Law 13).
function loadBlueprintProtected(bot) {
  const set = new Set(require('@perception/blueprint_survey').getAllProtectedBlocks() || []);
  for (const key of require('@locomotion/navigator').loadProtectedBlocks(bot) || []) set.add(key);
  return set.size ? set : null;
}

// buildWoodTest — (position) => true for a log that is the fleet's own wood and never a tree: a cell in
// the downloaded building's box (no route enters the box), or a locked blueprint's block. Handed to the
// scan as its `exclude`, so the scan's count of usable trees is a count of trees (Law 25).
function buildWoodTest(protectedSet) {
  const planRegistry = require('@kernel/downloaded_plan_registry');
  const box = planRegistry.closedBox();
  // The plan's own log cells answer before the box closes and for a body whose tree latch never closed.
  const planned = planRegistry.buildWoodCells();
  return (p) => (!!box && p.x >= box.min.x && p.x <= box.max.x && p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z)
    || (!!planned && planned.has(`${p.x},${p.y},${p.z}`))
    || (!!protectedSet && protectedSet.has(`${p.x},${p.y},${p.z}`));
}

// Scopes wild felling to the base's camera zone — the same "inside base" boundary
// threat_scanner uses (Law 16). zone.mode:
//   'inside'  → keep only trees within the zone (clear the canopy).
//   'outside' → keep only trees beyond it (log supply that never re-touches the cleared base).
// No zone / no locked base center → no scoping.
function applyCanopyZone(objectives, zone) {
  if (!zone || (zone.mode !== 'inside' && zone.mode !== 'outside')) return objectives;
  const c = zone.center;
  if (!c || typeof c.x !== 'number') return objectives;
  // Two shapes: `box` states the region as offsets from the transpose origin (a building site's own
  // footprint); `radius` is a Chebyshev ring (the camera zone). Box is checked first when present.
  const b = zone.box;
  const within = b
    ? (p) => (p.x - c.x) >= b.min_dx && (p.x - c.x) <= b.max_dx
          && (p.z - c.z) >= b.min_dz && (p.z - c.z) <= b.max_dz
    : (() => {
        const r = typeof zone.radius === 'number' ? zone.radius : HEADFRAME_SAFE_RADIUS;
        return (p) => Math.max(Math.abs(p.x - c.x), Math.abs(p.z - c.z)) <= r;
      })();
  return objectives.filter(o => (zone.mode === 'inside' ? within(o.position) : !within(o.position)));
}

// How far from `origin` an 'inside' zone can hold a tree, in flat blocks — the rings stop there, since
// a bounded region gains no tree from a wider horizon. Every other zone has no such bound.
function zoneReach(zone, origin) {
  if (!zone || zone.mode !== 'inside') return Infinity;
  const c = zone.center;
  if (!c || typeof c.x !== 'number') return Infinity;
  const b = zone.box;
  const r = typeof zone.radius === 'number' ? zone.radius : HEADFRAME_SAFE_RADIUS;
  const xs = b ? [c.x + b.min_dx, c.x + b.max_dx] : [c.x - r, c.x + r];
  const zs = b ? [c.z + b.min_dz, c.z + b.max_dz] : [c.z - r, c.z + r];
  let far = 0;
  for (const x of xs) for (const z of zs) far = Math.max(far, Math.hypot(x - origin.x, z - origin.z));
  return Math.ceil(far) + 1;
}

const zoneLabel = (zone) => {
  if (!zone || (zone.mode !== 'inside' && zone.mode !== 'outside')) return 'none';
  return `${zone.mode}:${zone.box ? 'box' : `r${typeof zone.radius === 'number' ? zone.radius : HEADFRAME_SAFE_RADIUS}`}`;
};

// ── THE TREE SEARCH: ONE RING, CHECK IT, THEN THE NEXT ─────────────────────────────────────────────
// Rings 16 blocks wide open outward from `origin`. Each ring's trees are tried nearest-first — claim,
// walk, stand beside — and the search ends on the first tree stood beside or on the last ring the body
// has loaded. A ring is read only when every ring inside it gave no tree, so a body beside a forest
// reads one ring and a body in a clearing reads as far as the clearing goes.
// Returns the pick (or null) and the tally the ledger line and the caller's verdict are read from.
async function searchRings(bot, dispatcher, o) {
  const { protectedSet, zone, origin, excludeTrees, species } = o;
  const surfaceFilter = require('@perception/surface_filter');
  // Unguarded: a swallowed throw here would read as "no trees" and not "cannot see" (Law 13).
  const rings = surfaceFilter.openRings(bot, {
    type: 'object_group_or_direct',
    targets: [species || 'logs'],
    exclude: buildWoodTest(protectedSet),
    center: origin,
    reach: zoneReach(zone, origin),
  });
  const t = { pick: null, ring: null, seen: 0, inZone: 0, examined: 0, peerHeld: 0, boxed: 0, pathFailed: 0, spent: 0, nearest: [],
    passed: { peer_felling: 0, tried: 0, wet: 0 } };
  for (let ring = await rings.next(); ring; ring = await rings.next()) {
    const trees = ring.objectives.filter(
      c => c && c.position && ['x', 'y', 'z'].every(k => typeof c.position[k] === 'number'));
    t.seen += trees.length;
    const candidates = applyCanopyZone(trees, zone);
    t.inZone += candidates.length;
    if (!candidates.length) continue;
    // THE RING IS THE ORIGIN'S, THE ORDER INSIDE IT THE BODY'S: rings open outward from the origin, so the
    // ground nearest it clears first; within the open ring the tree beside the body comes first, so one body's
    // fells follow each other round the ring instead of crossing the yard between them.
    const ranked = rankByProximity(candidates, bot.entity.position);
    if (t.nearest.length < REPOSITION_CLUSTER) t.nearest.push(...ranked.slice(0, REPOSITION_CLUSTER - t.nearest.length));
    const sel = await selectReachableTree(bot, dispatcher, ranked, excludeTrees);
    t.examined += sel.examined; t.peerHeld += sel.peerHeld; t.boxed += sel.boxed;
    t.pathFailed += sel.pathFailed; t.spent += sel.spent;
    for (const why of Object.keys(t.passed)) t.passed[why] += sel.passed[why];
    if (sel.pick) { t.pick = sel.pick; t.ring = ring; break; }
  }
  t.cost = rings.cost();
  return t;
}

// ── THE TREE-SEARCH LEDGER: ONE LINE PER SEARCH ────────────────────────────────────────────────────
// What one search read, what it found and how it ended, as fields a lens tallies (`--trees`).
//   outcome   picked | none_seen | none_in_zone | all_claimed | none_reached
//   ring      the ring the picked tree was in; dist is the flat distance from the body to that tree
//   rings / sections / scan_ms   what was read to get there
//   seen / in_zone / examined    trees read, trees the zone admits, trees put the claim-and-walk question
//   spent     trees passed over without a claim; peer_felling / tried / wet split it by passedOverWhy
//   all_claimed   every tree in the zone was a peer's: held by its claim or beside a tree it is felling
//   search_ms includes the walks to trees that were tried
function ledgerSearch(t, zone, from, startedAt) {
  const outcome = t.pick ? 'picked'
    : t.seen === 0 ? 'none_seen'
    : t.inZone === 0 ? 'none_in_zone'
    : (contended(t) && t.boxed + t.pathFailed + t.passed.tried + t.passed.wet === 0) ? 'all_claimed' : 'none_reached';
  const p = t.pick && t.pick.chosenPos;
  watcher.summary('tree_search',
    `search outcome=${outcome} zone=${zoneLabel(zone)} ring=${t.ring ? t.ring.index : '-'}`
    + ` dist=${p ? Math.round(Math.hypot(p.x - from.x, p.z - from.z)) : '-'}`
    + ` rings=${t.cost.rings} sections=${t.cost.read} scan_ms=${t.cost.ms}`
    + ` seen=${t.seen} in_zone=${t.inZone} examined=${t.examined} peer_held=${t.peerHeld} boxed=${t.boxed}`
    + ` path_failed=${t.pathFailed} spent=${t.spent} search_ms=${Date.now() - startedAt}`
    + ` tree=${p ? `(${p.x},${p.y},${p.z})` : '-'} species=${t.pick ? t.pick.chosenName : '-'}`
    + ` peer_felling=${t.passed.peer_felling} tried=${t.passed.tried} wet=${t.passed.wet}`);
}
// A tree a peer holds or is felling is contention, not failure: this body is surplus to the work available.
const contended = (t) => t.peerHeld + t.passed.peer_felling > 0;

// ── Main API ───────────────────────────────────────────────────────────────
// fell(bot)              — search for the closest tree, approach, fell
// fell(bot, target)      — approach this trunk position and fell
//
// AN ORDER THAT NAMES A SPECIES FELLS THAT SPECIES (opts.species): it is paid only by the logs it names, so another
// species' tree is a walk and a felling for nothing. With none in reach the caller escalates by that species
// (sector_finder). An order for any log takes the nearest tree whatever its species.

// fell(bot, target, opts) — approach, fell, with options
// De-confliction is claim-before-walk: the tree is locked at selection, not on arrival.
async function fell(bot, target, opts = {}) {
  const protectedSet = opts.protectedBlocks || loadBlueprintProtected(bot);
  const excludeTrees = (Array.isArray(opts.excludeTrees) && opts.excludeTrees.length)
    ? new Set(opts.excludeTrees) : null;
  // opts.leg names every walk of this felling (the walk ledger's leg): 'work' once the body is out on its ground.
  const nav = require('@locomotion/locomotion_dispatcher');
  const dispatcher = opts.leg ? { ...nav, goTo: (g) => nav.goTo({ ...g, leg: g.leg || opts.leg }) } : nav;

  let chosenPos, chosenName, treeKey;

  if (target) {
    // ── Specific target mode: claim this trunk, then go fell it ─────────
    const pos = target instanceof Vec3 ? target : new Vec3(target.x, target.y, target.z);
    if (buildWoodTest(protectedSet)(pos)) {
      watcher.summary(TAG, `Target (${pos.x},${pos.y},${pos.z}) is a blueprint block — refusing to fell the build.`);
      return { success: false, reason: 'target_is_blueprint', position: pos };
    }
    watcher.summary(TAG, `Claiming and approaching trunk at (${pos.x},${pos.y},${pos.z})`);
    const walk = await claimFirst([pos], { keyOf: c => treeKeyOf(bot, c), approach: approachTree(bot, dispatcher), maxUnreachable: 1 });
    if (walk.peerHeld) {
      watcher.summary(TAG, `Tree at (${pos.x},${pos.y},${pos.z}) held by a peer — abandoning target`);
      return { success: false, reason: 'tree_claimed_by_peer', position: pos };
    }
    if (!walk.pick) {   // claimed, not reached — the walk already handed the claim back
      watcher.warn(TAG, `Could not reach target (${pos.x},${pos.y},${pos.z})`);
      return { success: false, reason: 'approach_failed', position: pos };
    }
    treeKey = walk.key;

    const block = bot.blockAt(pos);
    chosenName = (block && LOG_REGEX.test(block.name)) ? block.name : 'unknown_log';
    chosenPos = pos;

  } else {
    // ── Self-scan mode: claim the closest FREE tree, then approach it ───
    // Ring origin: the caller's coordinate (opts.preferNear — the yard), so clearing works outward from it;
    // the bot when none is given. Inside a ring the tree nearest the body is taken (searchRings).
    const rankOrigin = (opts.preferNear && typeof opts.preferNear.x === 'number') ? opts.preferNear : bot.entity.position;

    // A body walks to a trunk in the nearest ring to the origin, whatever its species.
    const ask = { protectedSet, zone: opts.canopyZone, origin: rankOrigin, excludeTrees, species: opts.species || null };
    let from = bot.entity.position.floored();
    let startedAt = Date.now();
    let found = await searchRings(bot, dispatcher, ask);
    ledgerSearch(found, opts.canopyZone, from, startedAt);

    // Trees stood in the zone and every walk to one failed → likely boxed where the body stands. Steps
    // to open ground and searches once more before conceding (Law 13).
    if (!found.pick && found.boxed + found.pathFailed > 0) {
      const moved = await repositionToOpenGround(bot, dispatcher, found.nearest);
      if (moved) {
        from = bot.entity.position.floored();
        startedAt = Date.now();
        found = await searchRings(bot, dispatcher, ask);
        ledgerSearch(found, opts.canopyZone, from, startedAt);
      }
    }

    if (!found.pick) {
      if (found.inZone === 0) return { success: false, reason: 'no_trees_found' };
      // Contention is not failure: a peer-held tree means this body is surplus to the work available;
      // an entombed/depleted forest is a different event for the loop detector (Law 13).
      return { success: false, reason: contended(found) ? 'all_trees_claimed' : 'no_reachable_free_tree' };
    }
    chosenPos = found.pick.chosenPos; chosenName = found.pick.chosenName; treeKey = found.pick.treeKey;
  }

  // ── Settle on trunk center and fell (tree already claimed above) ─────
  await microCenter(bot);
  const objectiveList = [chosenName].filter(o => LOG_REGEX.test(o));
  watcher.summary(TAG, `Begin felling at (${chosenPos.x},${chosenPos.y},${chosenPos.z}) species=${chosenName}`);

  // Read before the fell: what stood at the picked cell is the cause a fell that cuts nothing states (Law 13).
  const baseBlock = bot.blockAt(new Vec3(chosenPos.x, chosenPos.y, chosenPos.z));
  let { minedCount, treeLogs, left } = await climbAndFell(bot, chosenPos, objectiveList, protectedSet);
  // WHAT THE FIRST STAND COULD NOT REACH IS CUT FROM A NEW ONE: the body walks under the nearest log left
  // and climbs again, so the tree comes down whole and no sky log is left in its leaves.
  for (let round = 1; left.length && round <= RESTAND_MAX; round++) {
    const me = bot.entity.position;
    const next = left.slice().sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0];
    const stood = await standAtTreeBase(bot, dispatcher, next);
    if (!stood.arrived) {
      watcher.summary(TAG, `re-stand ${round}: no stand reached under (${next.x},${next.y},${next.z}) (${stood.reason}); ${left.length} log(s) left.`);
      break;
    }
    const again = await climbAndFell(bot, next, objectiveList, protectedSet);
    watcher.summary(TAG, `re-stand ${round} under (${next.x},${next.y},${next.z}): mined ${again.minedCount}, ${again.left.length} log(s) left.`);
    minedCount += again.minedCount;
    if (again.minedCount === 0) { left = again.left; break; }
    left = again.left;
  }
  if (left.length) {
    watcher.warn(TAG, `fell_incomplete residual_logs=${left.length} of ${treeLogs} — no stand within ${RESTAND_MAX} re-stand(s) reached them (leaves decay).`);
  }

  // ── Post-fell: clip vegetation, collect drops ─────
  const clippedVegetation = await clipGroundVegetation(bot);
  if (clippedVegetation > 0) watcher.summary(TAG, `Ground vegetation clipped count=${clippedVegetation}`);

  const dropResult = await collectNearby(bot);
  watcher.summary(TAG, `drops: ${dropResult.picked_up} collected`);

  // Work at this tree is over either way — release the object lock.
  releaseTarget(treeKey);

  if (minedCount === 0) {
    watcher.warn(TAG, `No blocks mined at (${chosenPos.x},${chosenPos.y},${chosenPos.z}) picked_as=${chosenName} stood_there=${baseBlock ? baseBlock.name : 'unloaded'} tree_logs=${treeLogs}`);
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

// isBuildWoodFor(bot) → (position) => true for a log the search never offers (buildWoodTest over the protected
// set), for a caller that must exclude the same logs the search does.
function isBuildWoodFor(bot) {
  return buildWoodTest(loadBlueprintProtected(bot));
}

module.exports = { fell, passedOverWhy, isBuildWoodFor };
