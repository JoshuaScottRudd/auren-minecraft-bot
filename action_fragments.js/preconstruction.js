// preconstruction: one-time material prep before a build pass — scans the blueprint, withdraws raw
// from the building's staging chest(s), crafts finished materials on-site, then routes to
// build_executor with everything staged. Kept separate so each fragment holds one verb (Law 0).
//
// invariants:
//  - Stages only `buildable`, the affordable part of the lowest unfinished anchor; the withdraw and
//    pre-craft checks below verify it (Law 23).
//  - Idempotent: materials already in inventory make every step a no-op.
//  - inventory_swapper/craft_handler abandonment routes to recursive_judge and returns early.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { remainingRawForBuild, isRawMaterial } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { craftBatch } = require('@api/craft_handler');
const buildingIntegrity = require('@perception/building_integrity');
const inventorySwapper = require('@api/inventory_swapper');
const jobExclusions = require('@thinking/job_exclusions');
const { BLOCK_REACH, chestItemCounts, buildPoolChests } = require('@utils/fragment_utils');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const { performDig } = require('@utils/movement/dig_authority');
const { microCenter } = require('@utils/movement/motion_primitives');
const { isAir } = require('@utils/movement/terrain_predicates');
// Shares the process-wide combat-check clock the dig/drive primitives already pay for (Law 16); a
// call here costs nothing extra.
const { combatCheckpoint } = require('@api/battle_stations');
// The server-accurate reach metric (nearest-face from the microCentered stand-block eye), shared
// with anchored_repair so clear and build agree on "in reach" (Law 16).
const { reachFromStand } = require('@api/anchored_repair');

const TAG = 'preconstruction';

// Digs every reachable dig-step from the claimed anchor's stand, regardless of which anchor it
// belongs to; out-of-reach obstructions are left for whichever anchor can reach them.
// A pledge-approved plan digs through build_executor's cell pledges instead — one dig per body per pass —
// since the board counts each dig as its own seat.
async function clearReachableObstructions(bot, integrity, blueprintName, roomKey, anchorIndex) {
  if (require('@kernel/blueprint_registry').isPledgeApproved(blueprintName)) return 0;
  const digSteps = integrity.steps.filter(s => s.action === 'dig');
  if (digSteps.length === 0) return 0;

  const worldAnchors = buildingIntegrity.getWorldAnchors(blueprintName, roomKey);
  // Per-anchor gating: stand only on the claimed anchor; no claim sweeps every anchor.
  const anchorIdxs = (anchorIndex != null && worldAnchors[anchorIndex])
    ? [anchorIndex]
    : worldAnchors.map((_, i) => i);

  const remaining = new Set(digSteps.map(s => `${s.place.x},${s.place.y},${s.place.z}`));
  let cleared = 0, failed = 0;

  for (const ai of anchorIdxs) {
    if (remaining.size === 0) break;
    const a = worldAnchors[ai];
    const stand = { x: a.x, y: a.y + 1, z: a.z };   // feet cell kept for reachFromStand below
    // Must stand exactly on the anchor — reachFromStand measures from the stand-block eye. Skips
    // this anchor's clear on a failed exact arrival; build_executor still handles its own digs.
    const moved = await locomotion.goToStand(a);
    if (!moved || !moved.arrived) continue;
    await microCenter(bot);
    await combatCheckpoint(bot, 'preconstruction');

    // Dig top-down so gravity-affected debris falls into already-cleared space below.
    const reachHere = digSteps
      .filter(s => remaining.has(`${s.place.x},${s.place.y},${s.place.z}`))
      .filter(s => reachFromStand(bot, stand, new Vec3(s.place.x, s.place.y, s.place.z)) <= BLOCK_REACH)
      .sort((p, q) => q.place.y - p.place.y);

    for (const s of reachHere) {
      await combatCheckpoint(bot, 'preconstruction');
      const key = `${s.place.x},${s.place.y},${s.place.z}`;
      const pos = new Vec3(s.place.x, s.place.y, s.place.z);
      const block = bot.blockAt(pos);
      if (!block || isAir(block.name)) { remaining.delete(key); continue; }
      if (await performDig(bot, pos, block, TAG)) { cleared++; remaining.delete(key); }
      else failed++;
    }
  }

  if (cleared > 0 || failed > 0 || remaining.size > 0) {
    watcher.summary(TAG, `Site clearing: dug ${cleared} obstruction(s)${failed ? `, ${failed} failed` : ''}${remaining.size ? `, ${remaining.size} out of reach (left for build)` : ''} across ${anchorIdxs.length} anchor(s).`);
  }
  return cleared;
}

// Steps out of the footprint before crafting: a boxed-in bot cannot walk to the home table. Re-senses position each call (Invariant B); only corrects the starting position (Law 16).
async function stepOutOfFootprint(bot, integrity) {
  const fp = integrity && integrity.footprint;
  if (!fp || !bot.entity?.position) return;
  const bp = bot.entity.position.floored();
  const inside = bp.x >= fp.minX && bp.x <= fp.maxX && bp.z >= fp.minZ && bp.z <= fp.maxZ
              && bp.y >= fp.minY && bp.y <= fp.maxY + 1;
  if (!inside) return;
  // A body in a blueprint's lane is not boxed in: the lane is the building's way out, and every walk
  // from it leaves by the lane's exit (locomotion_dispatcher.goTo).
  const survey = require('@perception/blueprint_survey');
  if (survey.laneLegs(survey.getWorldLanes(), bp, null).length > 0) return;

  const MARGIN = 3;   // clear of the outermost voxels + placement reach
  // Exit via the nearest cardinal edge whose stand belongs to no building — shortest walk out, least
  // chance of clipping the build. A stand on another building's cell would be dug out to stand there and
  // then repaired by that building's crew.
  const spokenFor = survey.getAllFootprintCells() || new Set();
  const free = c => [fp.minY, fp.minY + 1].every(y => !spokenFor.has(`${c.x},${y},${c.z}`));
  const target = [
    { d: bp.x - fp.minX, x: fp.minX - MARGIN, z: bp.z },
    { d: fp.maxX - bp.x, x: fp.maxX + MARGIN, z: bp.z },
    { d: bp.z - fp.minZ, x: bp.x, z: fp.minZ - MARGIN },
    { d: fp.maxZ - bp.z, x: bp.x, z: fp.maxZ + MARGIN },
  ].sort((a, b) => a.d - b.d).find(free);
  if (!target) {
    watcher.warn(TAG, `Bot is inside the footprint @(${bp.x},${bp.y},${bp.z}) and every edge stand belongs to a building — crafting from current spot, craft_handler walks to the home table from here.`);
    return;
  }

  watcher.summary(TAG, `Bot is inside the footprint @(${bp.x},${bp.y},${bp.z}) — relocating to open ground @(${target.x},~,${target.z}) before crafting.`);
  // goTo places the feet at the named cell; fp.minY is the footprint's floor block, not a stance, so
  // the target y must be fp.minY + 1 or the navigator digs the cell out to stand there (Law 25).
  const nav = await locomotion.goTo({ x: target.x, y: fp.minY + 1, z: target.z });
  if (!nav || nav.arrived === false) {
    watcher.warn(TAG, `Could not step out of footprint to (${target.x},${target.z}) — crafting from current spot, craft_handler walks to the home table from here.`);
  }
}

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload) => {
    if (signalType !== TAG) return;
    const bot = global.bot;

    const blueprintName = payload?.blueprint_name || 'headframe';
    const roomKey = payload?.conference_room_key || blueprintName;
    const anchorIndex = payload?.anchor_index;   // per-anchor gating: prep only this anchor

    // ── SENSE: scan integrity for what the build still needs ────────
    const integrity = await buildingIntegrity.scan(bot, blueprintName, roomKey);

    // ── ORDER: CRAFT → DIG → BUILD ── craft/withdraw touch inventory only, so the dig-steps this scan
    // produced stay valid when the clearing pass runs at the bottom, ending on-anchor for build_executor.
    const hasDigSteps = !!(integrity && Array.isArray(integrity.steps) && integrity.steps.some(s => s.action === 'dig'));

    if (!integrity || integrity.all_complete || Object.keys(integrity.materials_needed).length === 0) {
      // A dig-only build (nothing to place) still has to clear.
      if (hasDigSteps) await clearReachableObstructions(bot, integrity, blueprintName, roomKey, anchorIndex);
      const readable = `${TAG}: no materials needed — forwarding to build_executor`;
      watcher.summary(TAG, readable);
      routeSignal(TAG, 'build_executor', { ...payload, readable });
      return;
    }

    // Scopes prep to the claimed anchor when named, so prepping the whole building doesn't over-withdraw.
    const anchorNeed = (anchorIndex != null)
      ? buildingIntegrity.materialsForAnchor(integrity, anchorIndex)
      : integrity.materials_needed;
    // `buildable` is the affordable part of this anchor; a block outside it waits for a later pass.
    const buildable = payload?.buildable || null;
    // The exclusion list job_exclusions owns; this reader states what it drops (job_board doesn't).
    const excluded = payload?.excluded || null;
    const materialsNeeded = {};
    for (const [type, n] of Object.entries(anchorNeed || {})) {
      const take = (!buildable || jobExclusions.excludes(excluded, type)) ? n : Math.min(n, buildable[type] || 0);
      if (take > 0) materialsNeeded[type] = take;
    }
    // ── ON A PLEDGE-APPROVED PLAN, EACH CRAFTED UNIT IS PREPARED BY ONE BODY ──────────────────────────
    // Every body works the same anchor at once, so each would otherwise prepare the anchor's whole need.
    // A crafted block is taken one unit per pass through the foreman's `prep:` claim (unit i of the
    // remaining n); the claim is held until the job ends (dispatcher releases every claim on a cleared
    // magnet). A block no unit of which is free is left to the peers holding it.
    if (require('@kernel/blueprint_registry').isPledgeApproved(blueprintName)) {
      const link = require('@kernel/foreman_link');
      for (const [type, n] of Object.entries(materialsNeeded)) {
        if (isRawMaterial(type)) continue;
        let unit = -1;
        for (let i = 0; i < n && unit < 0; i++) {
          if ((await link.requestClaim(`prep:${roomKey}:${anchorIndex}:${type}:${i}`)).granted) unit = i;
        }
        if (unit < 0) delete materialsNeeded[type];
        else materialsNeeded[type] = 1;
      }
    }
    watcher.summary(TAG, `Material prep${anchorIndex != null ? ` (anchor ${anchorIndex})` : ''}: ${JSON.stringify(materialsNeeded)}`);
    // Names only what this anchor wanted and was denied, once per prep, not per voxel.
    const skippedHere = Object.keys(anchorNeed || {}).filter(t => jobExclusions.excludes(excluded, t));
    if (skippedHere.length) {
      watcher.summary(TAG, `⤳ not staging ${skippedHere.map(t => `${t} (${anchorNeed[t]})`).join(', ')} — `
        + skippedHere.map(t => jobExclusions.why(excluded, t)).join('; ')
        + `. The board excluded ${skippedHere.length === 1 ? 'it' : 'them'}; this anchor builds without and closes again when the material lands.`);
    }

    // ── Find the build's material-pool chest station(s) ───────────────
    // The pool is this building's own chests plus the shared headframe chest, the same set
    // job_board's gate credits (Law 16); each raw is pulled from whichever chest holds it.
    const stagingChests = buildPoolChests(roomKey);

    // ── Step 1: Withdraw raw materials from the staging chest(s) ──────
    const botInv = {};
    for (const it of bot.inventory.items()) botInv[it.name] = (botInv[it.name] || 0) + it.count;

    // Raw still needed, crediting what the bot already holds including intermediates — the same calc
    // job_board's gate used (Law 16); a log BLOCK requirement is satisfied only by a real log.
    const fullNeed = {};
    for (const [type, needed] of Object.entries(materialsNeeded)) {
      // An optional block (torch) stages once the pool holds enough to place it (Law 16).
      if (jobExclusions.excludes(excluded, type)) {
        const inPool = countInInventory(type, botInv)
          + stagingChests.reduce((n, { station }) => n + countInInventory(type, chestItemCounts(station)), 0);
        if (inPool < needed) continue;
      }
      fullNeed[type] = needed;
    }

    if (Object.keys(fullNeed).length > 0 && stagingChests.length > 0) {
      // ── TAKE THE FINISHED BLOCK BEFORE ITS INGREDIENTS ─────────────────────────────────────────
      // Two passes: take a chest's finished block first (cheaper than re-making from raw, and
      // matches what job_board's gate already credited, Law 16), capped per type at one chest.
      const needAfterChestTakes = { ...fullNeed };
      const toWithdraw = {};
      for (const [type, needed] of Object.entries(fullNeed)) {
        const gap = needed - countInInventory(type, botInv);
        // A covered type is still recorded as 0 — the raw pass below only nets planks/stick.
        if (gap <= 0) { needAfterChestTakes[type] = 0; continue; }
        // Summed across the whole pool, not the fullest chest (matches job_board's gate).
        const inChests = stagingChests.reduce(
          (sum, { station }) => sum + countInInventory(type, chestItemCounts(station)), 0);
        const take = Math.min(gap, inChests);
        if (take <= 0) continue;
        toWithdraw[type] = take;
        needAfterChestTakes[type] = needed - take;   // the raw pass below owes only the remainder
      }
      // Raw for whatever the chests couldn't hand over finished, credited as job_board's gate credits it.
      for (const [raw, count] of Object.entries(remainingRawForBuild(needAfterChestTakes, botInv))) {
        toWithdraw[raw] = (toWithdraw[raw] || 0) + count;
      }
      const rawToWithdraw = toWithdraw;
      watcher.summary(TAG, `Materials to withdraw: ${JSON.stringify(rawToWithdraw)}`);

      // A shortfall means the pool drained since dispatch; a part-load is worse than none, since
      // Step 2 would craft against it and overcraft consumers past what the blueprint needs.
      const shortNoted = [];
      for (const [raw, toWithdraw] of Object.entries(rawToWithdraw)) {
        if (toWithdraw <= 0) continue;

        // retrieveItems moves from one chest per call (Law 15), so the pool arithmetic across
        // chests lives here, keeping the API at one verb (Law 0).
        const sources = [];
        let available = 0;
        for (const { id, station } of stagingChests) {
          const avail = countInInventory(raw, chestItemCounts(station));
          if (avail > 0) { sources.push({ id, avail }); available += avail; }
        }

        // Measured against the pool, not one chest — never build through a shortfall.
        if (available < toWithdraw) {
          shortNoted.push(`${raw} ${available}/${toWithdraw}`);
          continue;
        }

        // Fullest first: fewest chest-openings.
        sources.sort((a, b) => b.avail - a.avail);
        let remaining = toWithdraw;
        for (const { id, avail } of sources) {
          if (remaining <= 0) break;
          const take = Math.min(avail, remaining);
          watcher.summary(TAG, `Withdrawing ${take}x ${raw} from staging chest ${id} (${toWithdraw - remaining + take}/${toWithdraw} of the need)`);
          const result = await inventorySwapper.retrieveItems(bot, raw, take, id);
          if (!result) return;   // abandoned to the judge (Law 15) — this line is dead, never route again
          remaining -= (result.transferred || 0);
        }

        // Counted from what actually moved, not asked for (Law 25).
        if (remaining > 0) shortNoted.push(`${raw} ${toWithdraw - remaining}/${toWithdraw}`);
      }

      // A shortfall ends the pass, soft-routed to recursive_judge (Law 13) as environmental — the
      // numbers on the readable so a shrinking shortfall doesn't read as a repeat and get killed.
      if (shortNoted.length) {
        const list = shortNoted.join(', ');
        watcher.warn(TAG, `Staging chest short of ${list}. Deferring to recursive_judge for restock + replan.`);
        routeToJudge(TAG, {
          ...payload,
          result: 'materials_not_staged', success: false,
          readable: `${TAG}: anchor not fully staged — short ${list} -> recursive_judge`,
        });
        return;
      }
    }

    // ── Step 2: Craft finished materials — craft_handler treats quantity as a target total.
    // Order matters: craft plank/stick CONSUMERS before the base intermediates, so a consumer
    // can't eat one back below its own target.
    const BASE_INTERMEDIATES = new Set(['planks', 'plank', 'stick', 'sticks']);
    // A block whose recipe needs a workbench that does not stand yet waits for a later pass: the home
    // blueprint places its own table, so its first anchor lays the table and the next pass crafts the rest.
    // The same station question every build gate asks through affordableNow (Law 16).
    const { stationUsable } = require('@perception/station_registry');
    const { waitsOnStation: waitsOnStationFor } = require('@utils/calculators/build_material_calculator');
    const heldNow = {};
    for (const it of bot.inventory.items()) heldNow[it.name] = (heldNow[it.name] || 0) + it.count;
    const waitsOnStation = (type) => waitsOnStationFor(type, heldNow, stationUsable);
    const craftOrder = Object.entries(materialsNeeded)
      .filter(([type]) => !isRawMaterial(type) && !jobExclusions.excludes(excluded, type) && !waitsOnStation(type))
      .sort((a, b) => (BASE_INTERMEDIATES.has(a[0]) ? 1 : 0) - (BASE_INTERMEDIATES.has(b[0]) ? 1 : 0));

    // A craft needs a placed table; skipped when inventory already covers every craft.
    const startInv = {};
    for (const it of bot.inventory.items()) startInv[it.name] = (startInv[it.name] || 0) + it.count;
    if (craftOrder.some(([type, needed]) => countInInventory(type, startInv) < needed)) {
      await stepOutOfFootprint(bot, integrity);
    }

    // Checks ingredients for the whole craft order before any of it runs — the loop below only checks
    // each OUTPUT, never the inputs — matching the all-or-nothing withdraw above (Law 16).
    const preCraftInv = {};
    for (const it of bot.inventory.items()) preCraftInv[it.name] = (preCraftInv[it.name] || 0) + it.count;
    const craftNeed = {};
    for (const [type, needed] of craftOrder) {
      const still = needed - countInInventory(type, preCraftInv);
      if (still > 0) craftNeed[type] = still;
    }
    const craftShort = remainingRawForBuild(craftNeed, preCraftInv);
    if (Object.keys(craftShort).length > 0) {
      const list = Object.entries(craftShort).map(([r, n]) => `${r}:${n}`).join(', ');
      watcher.warn(TAG, `Ingredients missing for ${Object.keys(craftNeed).join(', ')} — short ${list}. ` +
        `Crafting nothing; deferring to recursive_judge so job_board posts the order.`);
      routeToJudge(TAG, {
        ...payload,
        result: 'materials_not_staged', success: false,
        readable: `${TAG}: cannot craft ${Object.keys(craftNeed).join(', ')} — short ${list} -> recursive_judge`,
      });
      return;
    }

    // The whole order goes to craft_handler as one book, so one walk to the table serves all of it.
    // `craftBatch` doesn't merge the orders' dependency plans, so the consumers-before-intermediates
    // order above still holds; a book short on output falls through and builds with what it made —
    // the ingredient guard above already refused the whole book if raw wasn't staged.
    const craftOrders = [];
    for (const [type, needed] of craftOrder) {
      if (countInInventory(type, preCraftInv) >= needed) continue;
      craftOrders.push({ item: type, quantity: needed });
    }
    if (craftOrders.length > 0) {
      watcher.summary(TAG, `Crafting book: ${craftOrders.map(o => `${o.item} x${o.quantity}`).join(', ')}`);
      const book = await craftBatch(bot, craftOrders, payload);
      // Only a book that produced nothing abandons; the caller replans (Law 15).
      if (!book || !book.success) return;
      if (!book.all_filled) {
        const short = book.results.filter(r => !r.success)
          .map(r => `${r.item} ${r.finalCount}/${r.requiredFinal}`).join(', ');
        watcher.summary(TAG, `Crafted short — ${short} — building with what was made rather than abandoning it`);
      }
    }

    // ── SITE CLEARING, LAST: dig obstructions in reach, regardless of anchor ─────────────────────
    // Ends with the bot standing on the anchor with the site clear — the stance build_executor starts from.
    if (hasDigSteps) await clearReachableObstructions(bot, integrity, blueprintName, roomKey, anchorIndex);

    watcher.summary(TAG, 'Material preparation complete — routing to build_executor');

    // ── ACT: route to build_executor with materials ready ───────────
    routeSignal(TAG, 'build_executor', {
      ...payload,
      readable: `${TAG}: materials ready → build_executor`,
    });
  }),
};
