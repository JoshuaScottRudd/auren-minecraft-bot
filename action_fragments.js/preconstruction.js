// fragment: preconstruction
// purpose: One-time material preparation before a build pass. Scans the
//          blueprint for remaining work, withdraws raw materials from the
//          building's own staging chest(s), and crafts finished materials on-site.
//          Routes to build_executor with all materials in bot inventory.
//
// WHY this is separate from build_executor: build_executor's three-loop
// fractal runs many iterations per invocation. Material prep runs once
// before those loops. Separating keeps each fragment at one verb (Law 0):
// preconstruction = "prepare materials", build_executor = "build structure".
//
// invariants:
//  - job_board gates building until ALL raw materials are available in
//    bot inventory + chests, so by the time this fragment runs every raw
//    material needed should be present. SHOULD, not guaranteed: the pocket
//    is fluid between planning and arrival, so a gate proven true at plan
//    time can be false by the time this fragment runs. Both gates below
//    (the withdraw and the pre-craft ingredient check) verify it rather
//    than trust it (Law 23).
//  - Idempotent: if materials are already in inventory, all steps no-op.
//  - Caller abandonment from inventory_swapper or craft_handler causes
//    early return — their _abandon already routes to recursive_judge.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { remainingRawForBuild, isRawMaterial } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { craftBatch } = require('@api/craft_handler');
const buildingIntegrity = require('@perception/building_integrity');
const inventorySwapper = require('@api/inventory_swapper');
const { OPTIONAL_BUILD_MATERIALS } = require('@thinking/architect_config');
const { BLOCK_REACH, chestItemCounts, buildPoolChests } = require('@utils/fragment_utils');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const { performDig } = require('@utils/movement/dig_authority');
const { microCenter } = require('@utils/movement/motion_primitives');
const { isAir } = require('@utils/movement/terrain_predicates');
// Entered through combatCheckpoint, never battleStations directly. One process-wide 500 ms clock,
// shared with the dig and drive primitives that carry the same gate, plus the engaging/escaping
// bypass so combat's own arms cannot re-enter it. The whole reasoning is in its header; a call a
// primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
// reachFromStand: the ONE server-accurate reach metric (nearest-face from the microCentered
// stand-block eye), shared with anchored_repair so the clear pass agrees with the build pass on
// what "in reach" means (Law 16).
const { reachFromStand } = require('@api/anchored_repair');

const TAG = 'preconstruction';

// Site clearing (one-time, irregardless of anchor). Building integrity flags every wrong/should-be-air
// world block as a `dig` step stamped with the anchor that OWNS it; build_executor only digs an anchor's
// OWN steps, so a block a NEIGHBORING anchor needs cleared (e.g. a chest's required clearance voxel that
// belongs to the anchor above) never gets removed and blocks the multi-anchor build. Fix: before the
// build, stand on the claimed anchor and dig EVERY reachable dig-step regardless of anchor_index — from
// one stand the reach sphere spans multiple anchors, so cross-anchor blockers fall now, not mid-build.
// Best-effort: out-of-reach obstructions are left for whichever anchor can reach them. This lives in
// preconstruction because it is one-time site prep, not part of the build loop.
async function clearReachableObstructions(bot, integrity, blueprintName, roomKey, anchorIndex) {
  const digSteps = integrity.steps.filter(s => s.action === 'dig');
  if (digSteps.length === 0) return 0;

  const worldAnchors = buildingIntegrity.getWorldAnchors(blueprintName, roomKey);
  // Per-anchor gating: stand only on the claimed anchor. Whole-build (no claim): sweep
  // every anchor so the whole site is cleared in the one prep pass.
  const anchorIdxs = (anchorIndex != null && worldAnchors[anchorIndex])
    ? [anchorIndex]
    : worldAnchors.map((_, i) => i);

  const remaining = new Set(digSteps.map(s => `${s.place.x},${s.place.y},${s.place.z}`));
  let cleared = 0, failed = 0;

  for (const ai of anchorIdxs) {
    if (remaining.size === 0) break;
    const a = worldAnchors[ai];
    const stand = { x: a.x, y: a.y + 1, z: a.z };   // feet cell kept for reachFromStand below
    // Stand DIRECTLY on the anchor (goToStand is exact by default) — reachFromStand measures from the
    // stand-block eye, so an off-by-one arrival would mis-judge reach. If we can't stand exactly, skip
    // this anchor's clear (build_executor still handles its own anchor's digs).
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

// Crafting needs a crafting table placed nearby, and a boxed-in bot can't place one — every near cell
// is a blueprint voxel or too cramped, so bot.placeBlock times out (the "bot is INSIDE the footprint"
// fingerprint the integrity scan flags: repeated place-timeouts, craft FAILED, judge kill). So: re-sense
// our position and, if inside the footprint, walk OUT to open ground beyond the nearest edge before
// crafting. This only corrects the STARTING position; craft_handler still owns the air-only
// place/verify/relocate loop (Law 16). Best-effort: if locomotion can't reach the open spot we craft
// from where we are and let craft_handler's own ring scan take over.
//
// IT IS STILL NEEDED AFTER THE 2026-08-31 REORDER, and the reason CHANGED — which is why this note
// replaced the old one rather than being deleted with it. It used to say "the site-clearing pass ends
// with the bot standing ON an anchor inside the footprint", and that was the whole justification. Site
// clearing now runs AFTER crafting, so that is no longer true and the guard could look redundant. It is
// not: the bot arrives here from wherever the previous fragment left it, which for a re-entered build is
// frequently inside its own half-finished shell. Re-sensing rather than assuming is the point either way
// (Invariant B) — the assumption just used to be a true one.
async function stepOutOfFootprint(bot, integrity) {
  const fp = integrity && integrity.footprint;
  if (!fp || !bot.entity?.position) return;
  const bp = bot.entity.position.floored();
  const inside = bp.x >= fp.minX && bp.x <= fp.maxX && bp.z >= fp.minZ && bp.z <= fp.maxZ
              && bp.y >= fp.minY && bp.y <= fp.maxY + 1;
  if (!inside) return;

  const MARGIN = 3;   // clear of the outermost voxels + placement reach
  // Exit via the nearest cardinal edge — shortest walk out, least chance of clipping the build.
  const target = [
    { d: bp.x - fp.minX, x: fp.minX - MARGIN, z: bp.z },
    { d: fp.maxX - bp.x, x: fp.maxX + MARGIN, z: bp.z },
    { d: bp.z - fp.minZ, x: bp.x, z: fp.minZ - MARGIN },
    { d: fp.maxZ - bp.z, x: bp.x, z: fp.maxZ + MARGIN },
  ].sort((a, b) => a.d - b.d)[0];

  watcher.summary(TAG, `Bot is inside the footprint @(${bp.x},${bp.y},${bp.z}) — relocating to open ground @(${target.x},~,${target.z}) before crafting.`);
  // +1 IS NOT COSMETIC. A bare {x,y,z} to goTo is a STAND-HERE order: the navigator builds its A*
  // goal at y-1 and puts the FEET in the cell you named. fp.minY is the footprint's LOWEST VOXEL
  // LEVEL — a floor block, not a stance — so naming it ordered the bot to stand inside solid ground,
  // and the only way A* can make that cell occupiable is to DIG IT OUT. That is the "digs down to
  // place a chest" the Architect watched: not a mining decision, a stance the navigator had to
  // excavate. The stance is the top of that level, fp.minY + 1 (Law 25: the flag said arrived either
  // way — only the hole told the truth).
  const nav = await locomotion.goTo({ x: target.x, y: fp.minY + 1, z: target.z });
  if (!nav || nav.arrived === false) {
    watcher.warn(TAG, `Could not step out of footprint to (${target.x},${target.z}) — crafting from current spot, craft_handler will scan outward for a placeable cell.`);
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
    const integrity = buildingIntegrity.scan(bot, blueprintName, roomKey);

    // ── THE ORDER OF THIS FRAGMENT IS CRAFT → DIG → BUILD (Architect 2026-08-31) ──────────────────
    // It used to be DIG → CRAFT → BUILD, and he named the cost from watching it: *"it was literally in
    // the correct spot when it was digging, then it moves off to craft then has to move back to place."*
    // The clearing pass stands the bot exactly on the anchor build_executor is about to build from, and
    // crafting then walks it off that spot to set a table down, so the walk back was pure waste — and
    // the site sat cleared and open for the whole crafting phase for no reason.
    //
    // Crafting first is SAFE for the same reason the old comment here claimed the reverse: withdrawal
    // and crafting touch inventory only, never world blocks, so the dig-steps this scan produced are
    // still valid when the clearing pass runs at the bottom. Nothing re-scans in between, and nothing
    // needs to.
    //
    // `clearReachableObstructions` walks to the anchor itself, so it does not care where crafting left
    // the body — and it now hands build_executor a bot already standing on the anchor with the site
    // clear, which is the one arrangement where neither phase has to walk back.
    const hasDigSteps = !!(integrity && Array.isArray(integrity.steps) && integrity.steps.some(s => s.action === 'dig'));

    if (!integrity || integrity.all_complete || Object.keys(integrity.materials_needed).length === 0) {
      // A dig-only build (nothing to place) still has to clear. This is the branch that used to be the
      // reason the clearing pass ran before the materials check at all.
      if (hasDigSteps) await clearReachableObstructions(bot, integrity, blueprintName, roomKey, anchorIndex);
      const readable = `${TAG}: no materials needed — forwarding to build_executor`;
      watcher.summary(TAG, readable);
      routeSignal(TAG, 'build_executor', { ...payload, readable });
      return;
    }

    // Scope the prep to the claimed anchor when the job named one — the gate only
    // guaranteed THIS anchor's materials, so prepping the whole building would
    // over-withdraw (and stall waiting on later anchors not yet staged).
    const materialsNeeded = (anchorIndex != null)
      ? buildingIntegrity.materialsForAnchor(integrity, anchorIndex)
      : integrity.materials_needed;
    watcher.summary(TAG, `Material prep${anchorIndex != null ? ` (anchor ${anchorIndex})` : ''}: ${JSON.stringify(materialsNeeded)}`);

    // ── Find the build's material-pool chest station(s) ───────────────
    // The one pool: this building's own chests (tagged with its room key)
    // PLUS the headframe chest — the shared base pool. buildPoolChests is the SAME set
    // job_board's gate credits and posts the order against (Law 16), so what we try to withdraw
    // matches what the gate proved reachable. A chest-less build (the tree farm) withdraws its dirt
    // straight from the headframe chest here. Each raw is pulled from whichever chest actually
    // holds it, so we never target an empty chest just because it matched first.
    const stagingChests = buildPoolChests(roomKey);

    // ── Step 1: Withdraw raw materials from construction chest ──────
    // job_board guarantees all raw materials are available before
    // dispatching this fragment. Withdraw everything needed.
    const botInv = {};
    for (const it of bot.inventory.items()) botInv[it.name] = (botInv[it.name] || 0) + it.count;

    // The raw still to withdraw, crediting what the bot already holds — INCLUDING
    // intermediates (held planks offset the planks a chest/door will consume). This is
    // the SAME calc the job_board gate used to greenlight this build (Law 16), so what
    // we try to pull matches what the gate proved reachable. remainingRawForBuild's
    // direct-raw carve-out preserves the old shortfall guard: a log BLOCK is satisfied
    // only by a real log, never a plank — so crediting can't starve the plank-block
    // requirement (the bug the old over-withdraw was guarding against). Any surplus the
    // craft step doesn't consume is kept by the whitelist; over-supply is safe.
    const fullNeed = {};
    for (const [type, needed] of Object.entries(materialsNeeded)) {
      // An OPTIONAL block (torch) is now STAGED like any required material — but ONLY when the pool
      // (pocket + staging chests) actually holds enough to place, mirroring job_board's blocksCompletion
      // gate (Law 16). Once a torch is on hand it is required work, so it must reach the bot's inventory
      // for build_executor to place it; optional-and-absent is still skipped so a torch the bot can't
      // make yet never blocks the pass (the bootstrap the optional list exists for). Without this, the
      // "or in a chest" branch of the gate would post the torch job but leave the torch in the chest —
      // build_executor would run torchless, skip it, and the anchor would orphan again.
      if (OPTIONAL_BUILD_MATERIALS.has(type)) {
        const inPool = countInInventory(type, botInv)
          + stagingChests.reduce((n, { station }) => n + countInInventory(type, chestItemCounts(station)), 0);
        if (inPool < needed) continue;
      }
      fullNeed[type] = needed;
    }

    if (Object.keys(fullNeed).length > 0 && stagingChests.length > 0) {
      // ── TAKE THE FINISHED BLOCK BEFORE ITS INGREDIENTS ─────────────────────────────────────────
      // Two passes, and the ORDER is the whole point. A staging chest may hold the very block the
      // anchor needs — planks a peer crafted, a spare door, a chest — and asking only for RAW walks
      // straight past all of it to demand logs that are not there. job_board's gate credits the
      // pool's intermediates when it greenlights a job, so a withdraw that only asks for raw can
      // read a different pool than the gate that approved it — the Law 16 desync this file's own
      // header exists to prevent.
      //
      // Taking the finished block is also strictly cheaper than taking its raw: it consumes a craft
      // the fleet already paid for instead of re-making it.
      //
      // CAPPED AT ONE CHEST'S HOLDING, not the sum across chests, because the withdraw loop below
      // pulls each token from the single chest that holds the most of it. Promising a total that no
      // one chest can fill would report short at the very moment the material exists.
      const needAfterChestTakes = { ...fullNeed };
      const toWithdraw = {};
      for (const [type, needed] of Object.entries(fullNeed)) {
        const gap = needed - countInInventory(type, botInv);
        // THE POCKET ALREADY COVERS IT — and that credit must be WRITTEN DOWN, not just acted on.
        // Skipping without zeroing leaves the full need standing for the raw pass below, which then
        // re-derives material for a finished item the bot is carrying. The raw walk cannot rescue it:
        // it nets only planks and stick against inventory (a deliberate rule about group tokens
        // double-spending), so every other finished good in the pocket offsets nothing there. That is
        // how a bot holding four torches was told it was short the log to make one, one voxel from a
        // complete headframe, until the judge killed the signal. The credit is computed here, so it
        // has to be recorded here.
        if (gap <= 0) { needAfterChestTakes[type] = 0; continue; }
        // SUMMED ACROSS THE POOL, never the single fullest chest. Four finished planks here and four
        // there is eight planks the anchor can have; a `Math.max` reads that as four and sends the bot
        // to fell a tree it does not need. Same correction as the raw pass below, and the same reason:
        // job_board's gate sums the pool, so anything here that does not sum disagrees with the gate
        // that greenlit the anchor (Law 16).
        const inChests = stagingChests.reduce(
          (sum, { station }) => sum + countInInventory(type, chestItemCounts(station)), 0);
        const take = Math.min(gap, inChests);
        if (take <= 0) continue;
        toWithdraw[type] = take;
        needAfterChestTakes[type] = needed - take;   // the raw pass below owes only the remainder
      }
      // Raw for whatever the chests could not hand over finished. Credits the pocket (including its
      // own intermediates) exactly as job_board's gate does — the same calculator, the same crediting.
      for (const [raw, count] of Object.entries(remainingRawForBuild(needAfterChestTakes, botInv))) {
        toWithdraw[raw] = (toWithdraw[raw] || 0) + count;
      }
      const rawToWithdraw = toWithdraw;
      watcher.summary(TAG, `Materials to withdraw: ${JSON.stringify(rawToWithdraw)}`);

      // ── ALL OR NOTHING (reverting partial anchors) ────────────────────────────────────────────
      // The bots must have the full materials for an anchor before building. A "take what is there"
      // variant of this loop was tried and reverted: job_board and building_manager both refuse to
      // dispatch a short anchor again, so a shortfall HERE means the pocket or the chest drained
      // between planning and arrival — rare, and not something to build through. Withdrawing a
      // part-load is worse than withdrawing nothing, because Step 2 then crafts against it and
      // abandons mid-stage, overcrafting consumer items (doors, chests) far past what the blueprint
      // needs while the anchor it was staging for stays short on its base materials.
      const shortNoted = [];
      for (const [raw, toWithdraw] of Object.entries(rawToWithdraw)) {
        if (toWithdraw <= 0) continue;

        // ── ACROSS AS MANY CHESTS AS IT TAKES ────────────────────────────────────────────────────
        // Withdraw from as many chests as needed to cover the requirement — a single chest need not
        // hold the full amount on its own.
        //
        // THE CALLER OWNS THE SPLIT. retrieveItems takes a stationId and moves from THAT chest — one
        // call, one chest, one lock, one window — which is its whole queueing and locking design.
        // Teaching it to span chests would hand a single call several locks to hold and several points
        // to abandon from, and abandonment is per-caller (Law 15). So the pool arithmetic lives here,
        // where the pool is already in hand, and the API keeps its one verb (Law 0).
        //
        // A withdraw that compares the requirement against only the single fullest chest can report
        // short even when the pool as a whole covers it — a real shortfall in one chest masking a
        // false one, deferring and repeating without ever clearing. job_board's gate already sums the
        // POOL to greenlight the anchor; a gate that sums and a withdraw that does not is the Law 16
        // desync Step 1's header warns about, one level further down than the header looks.
        const sources = [];
        let available = 0;
        for (const { id, station } of stagingChests) {
          const avail = countInInventory(raw, chestItemCounts(station));
          if (avail > 0) { sources.push({ id, avail }); available += avail; }
        }

        // ALL OR NOTHING still holds — now measured against the POOL rather than one chest. The rule is
        // about never building through a shortfall, never about which chest the material came from.
        if (available < toWithdraw) {
          shortNoted.push(`${raw} ${available}/${toWithdraw}`);
          continue;
        }

        // Fullest first: fewest chest-openings, and a chest that can serve the whole need still does it in
        // exactly one call, as before.
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

        // Counted from what ACTUALLY moved, not from what was asked for (Law 25): a chest that drained
        // between the count above and the trip leaves a real shortfall, and reporting the request as if it
        // were the result is the success flag this fleet does not permit.
        if (remaining > 0) shortNoted.push(`${raw} ${toWithdraw - remaining}/${toWithdraw}`);
      }

      // Any shortfall ends the pass before a single craft runs. Soft-route, not a throw — an anchor
      // short a raw material is a legitimate transient, NOT a coding violation, so this is
      // environmental (Law 13) and defers to recursive_judge for a replan.
      //
      // THE NUMBERS ARE ON THE READABLE: the judge compares readables, so a shortfall that shrinks
      // between passes has to CHANGE the sentence or a build making real progress reads as a repeat
      // and gets killed.
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

    // ── Step 2: Craft finished materials ────────────────────────────
    // All raw materials are in inventory. craft_handler interprets quantity as "total I should
    // have" — its loop runs until inventory.count >= target.
    //
    // ORDER MATTERS (other half of the shortfall fix): craft the plank/stick CONSUMERS (door,
    // chest, crafting_table, …) BEFORE the base intermediates (planks, sticks). A base intermediate
    // crafted first would be eaten back below its target by the consumers; crafting it LAST tops it
    // up to exactly the block requirement. Consumers auto-resolve their own planks from the raw
    // logs we just withdrew, so crafting them first is safe.
    const BASE_INTERMEDIATES = new Set(['planks', 'plank', 'stick', 'sticks']);
    const craftOrder = Object.entries(materialsNeeded)
      .filter(([type]) => !isRawMaterial(type) && !OPTIONAL_BUILD_MATERIALS.has(type))
      .sort((a, b) => (BASE_INTERMEDIATES.has(a[0]) ? 1 : 0) - (BASE_INTERMEDIATES.has(b[0]) ? 1 : 0));

    // If anything actually needs crafting, a crafting table must be placed — so get OUT of the
    // footprint first (a boxed-in bot can't place it). Skip the relocate when inventory already
    // covers every craft (the loop below would no-op anyway).
    const startInv = {};
    for (const it of bot.inventory.items()) startInv[it.name] = (startInv[it.name] || 0) + it.count;
    if (craftOrder.some(([type, needed]) => countInInventory(type, startInv) < needed)) {
      await stepOutOfFootprint(bot, integrity);
    }

    // ── INGREDIENTS BEFORE THE FIRST CRAFT ─────────────────────────────────────────────────────
    // There should be an inventory check so that crafting isn't attempted on things it doesn't have
    // the items for — checked ACROSS THE WHOLE ORDER and BEFORE any of it runs, which is the part
    // that matters. The loop below only ever asks whether the OUTPUT is already held (`have >= needed`)
    // — never whether the INPUTS are — so without this check a craft late in the order can find its
    // ingredients missing and abandon mid-stage, with everything crafted earlier in the order already
    // spent. Per-item checking alone would not save that spend, because the failing step can be last
    // in the order and the earlier crafts already ran. An anchor is crafted whole or not at all,
    // matching the all-or-nothing withdraw above.
    //
    // `remainingRawForBuild` is the check, not a hand-rolled ingredient walk: it decomposes each block
    // token to raw and credits held intermediates cumulatively, so a door and a chest sharing one plank
    // supply are netted the way the crafts will actually consume it — and it is the same calculator
    // job_board's gate and the withdraw above use, so the three cannot disagree about what "have the
    // materials" means (Law 16).
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

    // ── ONE BOOK, ONE TABLE ────────────────────────────────────────────────────────────────────────
    // The whole order goes to craft_handler as a single book so the crafting table is set down once and
    // dug up once for all of it (Architect 2026-08-31: *"it should attempt to craft everything on the
    // list it can craft before cleaning up table"*). This loop used to call `craftItems` per type, and
    // each call owned a complete station lifecycle — five place-and-dig cycles for a `contractor_house`
    // anchor 0, to make nine blocks.
    //
    // THE SORT STILL MATTERS AND STILL BELONGS HERE. `craftBatch` deliberately does not merge the
    // orders' dependency plans (its header says why: a step's target is an absolute total, so merging
    // double-counts a shared ingredient), which means the consumers-before-base-intermediates order
    // established above is still what keeps a door from eating the wall's planks. The batch runs the
    // book in the order it is given.
    //
    // No `allowPartial`: this fragment stages an anchor all-or-nothing, and craft_handler abandons to
    // the judge on a shortfall exactly as it did per-item.
    const craftOrders = [];
    for (const [type, needed] of craftOrder) {
      if (countInInventory(type, preCraftInv) >= needed) continue;
      craftOrders.push({ item: type, quantity: needed });
    }
    if (craftOrders.length > 0) {
      watcher.summary(TAG, `Crafting book: ${craftOrders.map(o => `${o.item} x${o.quantity}`).join(', ')}`);
      const book = await craftBatch(bot, craftOrders, payload);
      if (!book || !book.success) return;   // abandoned to the judge (Law 15) — this line is dead
    }

    // ── SITE CLEARING, LAST: dig obstructions in reach, irregardless of anchor ─────────────────────
    // Moved here from the top of the fragment. It ends with the bot standing ON the anchor with the
    // site clear, and build_executor is the very next thing to run — so the stance the dig pass earned
    // is the stance the build starts from, instead of being thrown away by a walk to a crafting table.
    if (hasDigSteps) await clearReachableObstructions(bot, integrity, blueprintName, roomKey, anchorIndex);

    watcher.summary(TAG, 'Material preparation complete — routing to build_executor');

    // ── ACT: route to build_executor with materials ready ───────────
    routeSignal(TAG, 'build_executor', {
      ...payload,
      readable: `${TAG}: materials ready → build_executor`,
    });
  }),
};
