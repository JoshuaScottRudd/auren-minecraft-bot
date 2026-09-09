// fragment: build_executor
// purpose: Stationary fractal build system. Preconstruction (separate fragment)
//          prepares materials before this fragment runs. Per anchor the bot stands
//          ONCE at anchor.y+1 and digs ALL Y (top-down) then places ALL Y
//          (bottom-up) from that spot — every voxel of a 5×5×5 cell is within the
//          4.5 reach radius, so no pillaring/vantage movement is needed. High
//          corners place via the non-raycast findAttachable path (a "cheat place"),
//          the same model the mining cell executor uses. Valid on a vanilla server
//          with no anti-cheat / no LOS enforcement.
// invariants:
//  - job_board gates building until ALL materials are available. By the time
//    this fragment runs, every material needed is in bot inventory.
//  - Reads building state via building_integrity.scan(bot) (memory-primary, no file).
//  - All digs complete at an anchor before any placing starts. No interleaving.
//  - Zero vertical movement at an anchor — stand at anchor.y+1, reach the whole cell.
//  - Planner/manager makes all decisions. Executor is dumb — just executes the plan.
//  - portable_judge (strict) routes to recursive_judge on stall — executor exits, recursive_judge kills the signal.
//  - On exit: cleanup/judge descends, collects drops, dumps excess
//    inventory (INVENTORY_WHITELIST from job_board), composes capsule.
//
// NOTE (Law 19, Machine-Species Authenticity): the bot runs on a self-hosted server
// that accepts it as a deterministic construct, so it does not pillar to "earn" a
// human-style vantage point — it stands at the anchor and reaches the whole cell. The
// only vertical move left is pillaring the bot's OWN footing block (placeOne under-feet),
// because the anchor/floor must be the correct blueprint block. The old pillaring/vantage
// machinery for anti-cheat servers was removed (recoverable from git history).
const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');

const { group_to_item, groupToReference, normalizeBlockName, BLOCK_REACH, STATION_TYPES, WINDOWLESS_STATIONS } = require('@utils/fragment_utils');
// Entered through combatCheckpoint, never battleStations directly (Architect 2026-08-08: "remove it
// from the callers"). One process-wide 500 ms clock, shared with the dig and drive primitives that now
// carry the same gate, plus the engaging/escaping bypass so combat's own arms cannot re-enter it. The
// whole reasoning is in its header; a call a primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { ensureNoOpenWindow, performDig } = require('@utils/movement/dig_authority');
const { performPlace } = require('@utils/movement/place_authority');
const { microCenter } = require('@utils/movement/motion_primitives');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { isAir, dist3 } = require('@utils/movement/terrain_predicates');

const buildingIntegrity = require('@perception/building_integrity');
const { collectNearby } = require('@api/drop_collector.js');
const stationRegistry = require('@perception/station_registry');
const inventorySwapper = require('@api/inventory_swapper');
const { OPTIONAL_BUILD_MATERIALS } = require('@thinking/architect_config');
const hq = require('@kernel/corporate_headquarters');
const portableJudge = require('@kernel/portable_judge');
const overseerLink = require('@kernel/overseer_link');
// The stationary dig-all/place-all routine is shared with mining_executor (Law 16 / D3 —
// one repair primitive under two separate executors). build_executor supplies the
// build-domain mechanics (group resolution, station registration, pillarStep footing) as
// callbacks; the primitive owns the anchor control flow (reach gate, corner cheat, retry).
const anchoredRepair = require('@api/anchored_repair');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternalSync, withCleanup } = require('@utils/external_library_guard');

const STEP_WAIT_MS = 200;
// PLACE_MAX_ATTEMPTS — how many times a single place step is retried before it defers/fails.
// Two failure modes self-heal on retry (Architect): (1) a footing whose FIRST attempt went the
// normal-place route and timed out — by the next attempt the bot has fallen into the cell, the
// under-feet re-check fires, and it pillarSteps instead; (2) out_of_range because the bot drifted
// one block off the anchor — re-anchoring at the top of the retry restores reach. 3 attempts.
const PLACE_MAX_ATTEMPTS = 3;
const sleep = ms => new Promise(res => setTimeout(res, ms));

// "IS THIS BLOCK INTERACTABLE" LIVED HERE AND IN anchored_repair AS BYTE-IDENTICAL TWINS, and this copy
// is gone rather than kept. It had exactly one reader — the sneak decision at the place step — and that
// decision now belongs to movement/place_authority, which asks anchored_repair's copy. Two identical
// definitions of one predicate is the Law 16 delete-test failing in the direction nobody checks: both
// were live, both were right, and a block added to one list would have silently not been in the other.

// THE STATION-WINDOW PROOF MOVED TO station_registry (`openProofWindow`) when craft_handler became a
// second caller of it. It is the registry that DEMANDS an open window before it will write a row, so the
// routine that obtains one belongs beside that demand — and one definition means a fix reaches both
// callers (Law 16). Its whole reasoning, including the two defects it was built from, travelled with it.
//
// WHAT STAYS THIS FILE'S: what a FAILURE means here. Preconstruction crafts EXACTLY the required chest
// count, so wasting one starves the next chest slot — which is why a failed proof throws through
// registrationCrash below rather than digging and retrying.

// registrationCrash — the Law 13 coding-violation message for a station that placed and confirmed and then
// could not be registered.
//
// A FAILED REGISTRATION IS A CRASH, NOT A RETRY (Architect 2026-08-31): *"upgrade a failed registration as
// a law 13 coding crash. the bot should immediatley crash and say that it cannot place a chest instead of
// digging and placing multiple times. it should crash and say as much information as possible."*
//
// WHY IT PASSES LAW 13's OWN TEST — "could this happen in a correctly-written system in a normal world?"
// No. The block is already proven present and correct: it was placed and then re-sensed. Everything
// registration adds is a fact about the BUILD rather than about the world's mood — the blueprint's
// geometry, the bot's own stand, the window contract. A world does not intermittently refuse to open a
// correctly placed container the way it destroys a path or empties a vein. So this is a coding or
// blueprint-authoring fault, and Law 13's answer to those is to throw at once and name the cause.
//
// WHAT IT REPLACES, and why both softer versions were worse. The ORIGINAL dug the block up so the next pass
// could place it again — an unbounded loop that destroyed correct work, which is what the Architect watched
// happen to his furnace. The version between them left the station standing and retried registration on a
// later pass: better, because nothing is destroyed, but it converts a structural fault into a permanent
// quiet degradation — a furnace standing in a finished build that the fleet reports as not existing,
// forever, behind one warning line. Default-stopped beats both.
//
// THE ONE CONFIRMED CAUSE IS CHECKED BEFORE THE CRASH, on his instruction. In vanilla the only thing that
// blocks a chest lid is a full solid block in the voxel directly above it, and a correctly authored
// blueprint never puts one there. The check is scoped to chest and trapped_chest because that is where the
// rule is VERIFIED — a barrel opens with a block above it and a furnace has no lid at all, so claiming the
// rule for those would be inventing a cause, which is the exact failure this thread has been about. Every
// other case reports its facts and says plainly that the cause is not yet known.
function registrationCrash(bot, pos, block, roomKey, reason, diag) {
  const p = bot?.entity?.position;
  const eye = p ? Math.hypot(pos.x + 0.5 - p.x, pos.y + 0.5 - (p.y + 1.62), pos.z + 0.5 - p.z) : null;
  const at = (dx, dy, dz) => {
    const b = bot.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
    return b ? `${b.name}${b.boundingBox === 'block' ? '(solid)' : ''}` : 'UNREADABLE';
  };
  const now = bot.blockAt(pos);
  const above = bot.blockAt(new Vec3(pos.x, pos.y + 1, pos.z));

  const isChest = block.name === 'chest' || block.name === 'trapped_chest';
  const lidBlocked = isChest && above && !isAir(above.name) && above.boundingBox === 'block';

  const diagnosis = lidBlocked
    ? `CAUSE FOUND — '${above.name}' fills the voxel directly above this ${block.name}. A full solid block `
      + `above a chest blocks its lid, so this chest can NEVER be opened or used, in this run or any other. `
      + `THE FIX: author the blueprint with air (or a non-full block) at (${pos.x},${pos.y + 1},${pos.z}).`
    : `CAUSE NOT KNOWN. The one confirmed cause — a solid block above a chest, blocking the lid — was `
      + `checked and does not apply here${isChest ? '' : `, and could not, because ${block.name} has no lid`}. `
      + `Everything below is measured at the moment of failure and nothing is inferred. Three theories about `
      + `this failure have been formed from the trace and all three were wrong, so do not build a fourth `
      + `from this message alone: what follows is evidence, not a conclusion.`;

  return [
    `[build_executor] CODING VIOLATION (Law 13): cannot register the ${block.name} at `
      + `(${pos.x},${pos.y},${pos.z}) for blueprint '${roomKey}'. It was PLACED and CONFIRMED and then could `
      + `not be opened, so the fleet can never use it. Stopping here rather than digging it up and placing `
      + `it again — that loop destroyed correct work and hid this fault.`,
    '',
    diagnosis,
    '',
    'WHAT WAS MEASURED:',
    `  registry reason   ${reason}`,
    `  block in the cell ${now ? now.name : 'UNREADABLE (chunk not loaded)'}   (expected ${block.name})`,
    `  bot standing at   ${p ? `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})` : 'UNKNOWN'}`,
    `  eye to block      ${eye != null ? eye.toFixed(2) : '?'} blocks   (reach limit ${BLOCK_REACH})`
      + `${eye != null && eye > BLOCK_REACH ? '   >>> OUT OF REACH' : ''}`,
    `  above             ${at(0, 1, 0)}`,
    `  below             ${at(0, -1, 0)}`,
    `  neighbours        x-1:${at(-1, 0, 0)}  x+1:${at(1, 0, 0)}  z-1:${at(0, 0, -1)}  z+1:${at(0, 0, 1)}`,
    `  activate attempts ${diag.activate_attempts ?? 0} of ${diag.window_tries ?? '?'}`
      + `   (each polled ${diag.window_polls ?? '?'} x ${diag.window_poll_ms ?? '?'}ms)`,
    `  window opened     ${diag.opened_on_attempt ? `yes, on attempt ${diag.opened_on_attempt}` : 'NO — never opened'}`,
    `  window type       ${diag.window_type || '(none returned)'}`,
    diag.pre_existing_window
      ? `  stale window      A window was ALREADY OPEN (${diag.pre_existing_window}) and was closed first`
      : '  stale window      none — nothing was open before this attempt',
    diag.stale_window_stuck
      ? '  >>> THE STALE WINDOW WOULD NOT CLOSE. That is the fault; this block is a bystander.'
      : null,
    diag.activate_error ? `  activate error    ${diag.activate_error}` : null,
    '',
    'Human inspection required (Law 13, default stopped).',
  ].filter(l => l !== null).join('\n');
}

function expandGroup(token) {
  if (!group_to_item) return [token];
  const members = group_to_item[token];
  if (!members) return [token];
  const result = [];
  for (const m of members) {
    const sub = group_to_item[m];
    if (sub) result.push(...sub);
    else result.push(m);
  }
  return result;
}

function resolveDesiredItemName(bot, token) {
  if (group_to_item && group_to_item[token]) {
    const ref = groupToReference ? groupToReference(token, { inventory: bot?.inventory, prefer: 'inventory' }) : null;
    let candidate = ref?.item || null;
    const items = bot?.inventory?.items?.() || [];
    if (candidate && items.some(i => i.name === candidate && i.count > 0)) return candidate;
    return expandGroup(token).find(n => items.some(i => i.name === n && i.count > 0)) || null;
  }
  const items = bot?.inventory?.items?.() || [];
  if (items.some(i => i.name === token && i.count > 0)) return token;
  return null;
}

// resolveAnchorStand — WHERE the bot stands to build one anchor's cell. Default is ON the anchor
// column (anchor.y+1), reaching the whole 5×5×5 cell. But when that stand cell has no DURABLE footing
// — the block at (a.x,a.y,a.z) is air, OR a dig step THIS pass removes it (the blueprint wants that
// cell empty) — standing there makes the bot pillar onto the void and then drop the instant its floor
// is dug, so goTo-exact re-fires the same target and the portable judge strict-kills it (observed:
// headframe A2 stall at 204/285, BOTH bots). Per the Architect's directive ("move off the spot to
// place blocks at the anchor, where it stands so it doesn't drop") — the same principle sidestepFooting
// already uses for the footing-REPLACE case, now extended to the no-footing anchor case: stand on a
// solid cardinal NEIGHBOR instead. But only one from which EVERY step is still within reach — the reach
// envelope shrinks off the anchor (Architect's own note: the 4.5 radius is a circle that narrows a Y
// level down), so an unchecked sidestep would push a far voxel past BLOCK_REACH and trip the Law-13
// reach gate. No reach-valid neighbor → keep the on-anchor cell (behavior unchanged; a genuinely
// unstandable anchor then surfaces as a real stall, not a silently-wrong stance). Reuses the ONE reach
// metric (anchored_repair.reachFromStand) so this agrees with the primitive's gate and never throws.
function resolveAnchorStand(bot, a, steps) {
  const onAnchor = { x: a.x, y: a.y + 1, z: a.z };
  const footing = bot.blockAt(new Vec3(a.x, a.y, a.z));
  const footingDugThisPass = (steps || []).some(s => s.action === 'dig'
    && s.place.x === a.x && s.place.y === a.y && s.place.z === a.z);
  const footingDurable = footing && footing.boundingBox === 'block' && !footingDugThisPass;
  if (footingDurable) return onAnchor;

  const reachAll = (stand) => (steps || []).every(s =>
    anchoredRepair.reachFromStand(bot, stand, new Vec3(s.place.x, s.place.y, s.place.z)) <= BLOCK_REACH);
  for (const { dx, dz } of [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }]) {
    const cand = { x: a.x + dx, y: a.y + 1, z: a.z + dz };
    const support = bot.blockAt(new Vec3(cand.x, cand.y - 1, cand.z));
    const feetB   = bot.blockAt(new Vec3(cand.x, cand.y, cand.z));
    const headB   = bot.blockAt(new Vec3(cand.x, cand.y + 1, cand.z));
    const standable = support && support.boundingBox === 'block'
      && (!feetB || isAir(feetB.name)) && (!headB || isAir(headB.name));
    if (standable && reachAll(cand)) return cand;
  }
  return onAnchor;
}

// Placement geometry (evaluatePlacement / findAttachable / botOccupiesCell) and the
// enclosed-corner test now live in the shared anchored_repair primitive — one definition
// used by both executors (Law 16). build_executor keeps only the build-domain place
// mechanics (placeOne below), which consume the ev the primitive hands them.

module.exports = {
  receive: watcher.track('build_executor', async (signalType, payload) => {
    if (signalType !== 'build_executor') return;

    const bot = global.bot;
    const signalBus = require('@kernel/signal_bus');
    const blueprintName = payload?.blueprint_name || 'headframe';
    const roomKey = payload?.conference_room_key || blueprintName;

    // ── One-time setup (outside the loops) ──────────────────────────────

    // Mutable — updated each setup iteration, read by helpers via closure
    let allSteps = [];

    // ── Helper functions ────────────────────────────────────────────────

    async function digOne(step) {
      const pos = new Vec3(step.place.x, step.place.y, step.place.z);
      const block = bot.blockAt(pos);
      if (!block || isAir(block.name)) return true;
      return performDig(bot, pos, block, 'build_executor');
    }

    // registerStandingStation — open a station that is STANDING in its blueprint cell and write it to the
    // registry. **Returns only on success. A failure THROWS** (Law 13, and see registrationCrash for why a
    // registration failure is a coding violation rather than a world condition). Nothing is ever broken to
    // recover from one.
    //
    // ONE REGISTRATION ROUTE, TWO MOMENTS. It used to run only in the tail of a successful placement, so
    // registration had exactly one chance: the pass that put the block down. Every later pass sees the
    // correct block and returns 'already' before reaching any registration code, so a station that missed
    // its one chance was never registered again — a furnace standing in a finished build while the fleet
    // reported `NO furnace stands`. It is called from both moments now.
    //
    // THE SECOND MOMENT STILL EARNS ITS PLACE even though a failure now stops the run instead of waiting
    // for a retry: a station can stand UNREGISTERED with nothing wrong at all — a continue run whose HQ was
    // flushed meets a world full of correct stations and an empty registry. That is the case this path
    // serves. It is not a retry of a failure; a failure no longer survives to be retried.
    //
    // GATED ON "NOT ALREADY REGISTERED" so the already-correct path does not open every station on every
    // pass: an open/close is seconds of a build pass, and the registry answering yes is the whole question.
    async function registerStandingStation(pos, block) {
      // A windowless station (composter) is placed and then LEFT ALONE. It is a station in every
      // other sense — never dug by movement, PROTECTED_VOXEL_DETOUR_BUDGET to path through — but it has no
      // lid, so the registration path below would poll for a window, find none, read that as a
      // mis-placement and dig up a correct block. It needs no registry entry either: its state is a public
      // blockstate its executor reads off the world (fragment_utils' WINDOWLESS_STATIONS carries it).
      if (WINDOWLESS_STATIONS.has(block.name)) {
        watcher.buffer.record('build_executor', `Windowless station: ${block.name} at (${pos.x},${pos.y},${pos.z}) — no registration (its blockstate is its record).`);
        return true;
      }
      if (stationRegistry.getStations()[stationRegistry.stationKey(pos)]) return true;

      // NO GUARD ON THE REGISTRATION. Every call below is ours — openProofWindow guards its own
      // boundary, and the registry reports its verdict in `result.ok` — so the catch that stood here
      // could only fire on a defect, and it dug up a correctly-placed station on one. That is the
      // expensive direction: preconstruction crafts exactly the required chest count, so a wrongly
      // dug chest starves the next slot (Law 13; Law 25 — result.ok is the measurement, a throw is not).
      //
      // Re-sense the window (Invariant B) instead of trusting one 250ms read — a lagging
      // lid must not be mistaken for no_window and cost a correctly-placed, scarce chest.
      const diag = {};
      const win = await stationRegistry.openProofWindow(bot, block, diag);
      if (win) diag.window_type = win.type || 'unknown';

      // THE SEPARATE CHEST-LID THROW THAT STOOD HERE IS GONE, folded into the one crash below. It fired
      // only for a chest with a solid block above it and every other failure fell through to a dig; now
      // every failure throws and that check is the crash's leading DIAGNOSIS rather than a second exit.
      // One failure, one exit, one message — the lid case simply arrives with its cause already named.

      // NO ROLE IS ASSIGNED, because a chest has none. The `determineChestRole` call that stood
      // here stamped each chest 'requester' or 'buffer' from a table of chest numbers; both the
      // call and the table are deleted. A request is a fleet-wide figure filled from any chest and
      // surplus is dumped into any chest, so what a chest is FOR is decided by what is asked of the
      // pool, never by a tag written at the moment a block went down.
      const result = stationRegistry.registerStation(pos, block.name, win, roomKey);
      watcher.buffer.record('build_executor', `Station registered: ${block.name} at (${pos.x},${pos.y},${pos.z}) → ${result.ok ? 'ok' : result.reason} id=${result.id || 'n/a'}`);
      if (win) { guardExternalSync('build_executor', 'closeWindow after registration', () => bot.closeWindow(win)); await sleep(100); }
      if (bot.currentWindow) await ensureNoOpenWindow(bot, 'post-register');

      // THE ONLY EXIT FOR A FAILURE IS A THROW. The block is proven present and correct — placed, then
      // re-sensed by the caller — so a registration that still fails is a fault in the build rather than a
      // mood of the world, and Law 13 answers those by stopping and naming the cause. registrationCrash
      // carries the whole argument and the measurements; the window is closed above so the body is not
      // left holding one open on the way out.
      if (!result.ok) throw new Error(registrationCrash(bot, pos, block, roomKey, result.reason, diag));
      return true;
    }

    async function placeOne(step, ev) {
      const pos = ev.pos;
      const desiredToken = normalizeBlockName(step.type);
      const current = bot.blockAt(pos);

      // A CORRECT CELL IS STILL ASKED WHETHER ITS STATION IS ON THE BOOKS. Both 'already' returns below
      // are the retry moment described on registerStandingStation: the block is right, and the only thing
      // that may still be missing is the registry entry a previous pass could not reach.
      if (group_to_item && group_to_item[desiredToken] && current && expandGroup(desiredToken).includes(current.name)) {
        if (STATION_TYPES.has(current.name)) await registerStandingStation(pos, current);
        return 'already';
      }

      // Under-feet placement: the blueprint block IS the bot's own footing, so the
      // bot must place it under itself by pillaring up onto the correct block (the
      // anchor/floor must be the right block, not whatever it happened to stand on).
      // pillarStep takes candidateItemNames so it places the BLUEPRINT block, not a
      // generic filler. This is the one place stationary build still moves vertically.
      if (ev.underFeet) {
        if (STATION_TYPES.has(desiredToken)) {
          watcher.warn('build_executor', `Station type ${desiredToken} at anchor X,Z — cannot pillarStep onto a station. Skipping.`);
          return false;
        }
        const headClearPos = new Vec3(pos.x, pos.y + 2, pos.z);
        const headBlock = bot.blockAt(headClearPos);
        if (headBlock && headBlock.boundingBox !== 'empty' && !isAir(headBlock.name)) {
          watcher.buffer.record('build_executor', `Pre-dig head clearance at (${headClearPos.x},${headClearPos.y},${headClearPos.z}) before pillarStep`);
          const cleared = await performDig(bot, headClearPos, headBlock, 'build_executor');
          if (!cleared) {
            watcher.warn('build_executor', `Could not clear head space at (${headClearPos.x},${headClearPos.y},${headClearPos.z}) — skipping pillarStep.`);
            return false;
          }
        }
        const candidateNames = (group_to_item && group_to_item[desiredToken])
          ? group_to_item[desiredToken]
          : [resolveDesiredItemName(bot, desiredToken)].filter(Boolean);
        if (!candidateNames.length) {
          watcher.warn('build_executor', `No inventory match for '${desiredToken}' (pillarStep) at ${pos}`);
          return false;
        }
        const res = await pillarStep(bot, { candidateItemNames: candidateNames });
        if (res.success) watcher.buffer.record('build_executor', `pillarStep placed ${res.itemName} at (${pos.x},${pos.y},${pos.z})`);
        else watcher.warn('build_executor', `pillarStep failed at (${pos.x},${pos.y},${pos.z}): reason=${res.reason}`);
        return res.success;
      }

      const desiredName = resolveDesiredItemName(bot, desiredToken);
      if (!desiredName) {
        if (OPTIONAL_BUILD_MATERIALS.has(desiredToken)) return 'skipped';
        watcher.warn('build_executor', `Missing '${desiredToken}' at (${pos.x},${pos.y},${pos.z}) — not in inventory (materials gate should have prevented this)`);
        return false;
      }

      if (current && !isAir(current.name)) {
        const mismatch = group_to_item && group_to_item[desiredToken]
          ? !expandGroup(desiredToken).includes(current.name)
          : current.name !== desiredName;
        if (!mismatch) {
          if (STATION_TYPES.has(current.name)) await registerStandingStation(pos, current);
          return 'already';
        }
        const cleared = await performDig(bot, pos, current, 'build_executor');
        if (!cleared) watcher.warn('build_executor', `Pre-clear dig failed at (${pos.x},${pos.y},${pos.z})`);
      }

      // Equip (window-close included), the spawn-protection gate, the combat checkpoint, the sneak
      // decision and its guaranteed release, the face-centre aim, the click and the settle all live in
      // the one place route (Law 16). The sneak rule this file ORIGINATED — sneak when the anchor is
      // interactable, so a click on a chest places against it instead of opening it — is the authority's
      // 'auto' default, so nothing is passed for it here.
      const place = await performPlace(bot, pos, ev.anchor, ev.face, desiredName, 'build_executor');
      if (!place.ok) {
        const bp = bot.entity.position;
        watcher.warn('build_executor', `place refused at (${pos.x},${pos.y},${pos.z}) — ${place.reason} | bot at (${bp.x.toFixed(1)},${bp.y.toFixed(1)},${bp.z.toFixed(1)}) dist=${dist3({x:pos.x+0.5,y:pos.y+0.5,z:pos.z+0.5},{x:bp.x,y:bp.y,z:bp.z}).toFixed(1)} anchor=${ev.anchor.name}@(${ev.anchor.position.x},${ev.anchor.position.y},${ev.anchor.position.z})`);
        return false;
      }

      // A PLACEMENT MAY LEAVE A WINDOW OPEN, and the NEXT verb's equip is what pays for it. Kept in this
      // executor rather than pushed into the authority because it is a property of what THIS one places:
      // it is the only caller that lays chests, furnaces and barrels, whose click can still open a UI.
      if (bot.currentWindow) await ensureNoOpenWindow(bot, 'post-place');

      // The registry entry is the same question asked of an already-correct cell, at the other moment,
      // so it goes through the one route that answers it (Law 16). It either registers or THROWS — there
      // is no false verdict to branch on any more, and nothing is dug up over one. The dig that used to
      // stand on this branch is what destroyed a correct furnace over and over.
      if (STATION_TYPES.has(place.after.name)) {
        await registerStandingStation(pos, place.after);
      }
      return true;
    }


    // ── Loop state ──────────────────────────────────────────────────────
    let totalDigOk = 0, totalDigFail = 0, totalPlaceOk = 0, totalPlaceFail = 0;
    let totalAlreadyOk = 0;
    let iterations = 0;
    let lastBuildingName = 'unknown';
    let exitReason = 'unknown';
    let lastAnchorIndex = -1;
    let prevCorrect = -1;

    // Per-anchor stuck tracker. An anchor whose whole-cell pass
    // (dig-all + place-all) makes zero progress is genuinely blocked this run
    // (missing reference, occupied position) — skip it so the selector moves on
    // and the build exits cleanly to cleanup + fresh dispatch (Law 12).
    const anchorStuck = new Set();

    // Object lock currently held on an anchor (multi-bot). One at a time —
    // the executor works one anchor at a time; released on switch and on exit.
    let heldAnchorClaimKey = null;

    // ═══════════════════════════════════════════════════════════════════
    // LOOP 3: CLEANUP/JUDGE
    // Runs after the planner/executor loop exits. Three phases:
    //   1. Descend to anchor stand level
    //   2. Collect nearby drops
    //   3. Clearing pass — re-scan integrity, dig ANY incorrect block
    //      within reach regardless of scaffold classification. Catches
    //      Y-adjust pillar debris AND navigator pillar blocks placed
    //      during drop collection. No movement, no drop collection —
    //      just clear and exit.
    // ═══════════════════════════════════════════════════════════════════
    async function cleanup() {
      // Phase 1: descend to anchor stand level. Locomotion owns HOW — an exact-goTo lands the feet on
      // the stand, digging straight down (hardened dig_down, no fall) if the bot is above it. One
      // descent authority every caller inherits (Law 16; Architect 2026-07-14 — replaced the build-local
      // tryControlledDescent hack so strengthening locomotion strengthens this too).
      if (lastAnchorIndex >= 0) {
        const worldAnchors = buildingIntegrity.getWorldAnchors(blueprintName, roomKey);
        if (worldAnchors[lastAnchorIndex]) {
          const a = worldAnchors[lastAnchorIndex];
          if (Math.floor(bot.entity.position.y) > a.y + 1) {
            await locomotion.goToStand(a);   // stand ON the anchor (the +1 lives in goToStand now)
          }
        }
      }

      // Phase 2: collect drops (navigator may pillar during this)
      const drops = await collectNearby(bot);

      // Phase 3: clearing pass — dig any block the blueprint says should
      // be air. No scaffold classification, no movement, no further drop
      // collection. Just clear from current position within reach.
      let clearCount = 0;
      let clearSkipped = 0;
      // NO GUARD ON AN INTEGRITY SCAN, HERE OR ANYWHERE BELOW IN THIS FILE. The node is ours and absorbs
      // its own environmental failure, so a throw escaping it is a defect. Catching it left clearCount at
      // its declared 0 and the pass reported "nothing to clear" — a measurement nobody took, with the
      // blueprint's air voxels still full of blocks (Law 13; Law 25 — a default is not a measurement).
      const integrity = buildingIntegrity.scan(bot, blueprintName, roomKey);
      if (integrity && Array.isArray(integrity.steps) && integrity.steps.length > 0) {
        const digSteps = integrity.steps.filter(s => s.action === 'dig');
        for (const step of digSteps) {
          const pos = new Vec3(step.place.x, step.place.y, step.place.z);
          const block = bot.blockAt(pos);
          if (!block || isAir(block.name)) continue;

          const bp = bot.entity.position;
          const eyePos = new Vec3(bp.x, bp.y + bot.entity.height * 0.9, bp.z);
          const blockCenter = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
          if (eyePos.distanceTo(blockCenter) > BLOCK_REACH) { clearSkipped++; continue; }

          if (await performDig(bot, pos, block, 'build_executor')) clearCount++;
        }
      }

      if (clearCount > 0 || clearSkipped > 0) {
        watcher.summary('build_executor', `clearing pass: cleared=${clearCount} skipped=${clearSkipped} (out of reach)`);
      }

      drops.clear_count = clearCount;
      return drops;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STATIONARY BUILD — planner + executor for the no-pillar model. Per anchor:
    // stand once at anchor.y+1, dig ALL Y (top-down), then place ALL Y (bottom-up)
    // — every voxel is within the 4.5 reach radius of a 5×5×5 cell, and placement
    // uses the non-raycast findAttachable path, so high corners place from the
    // ground. No pillaring, no scaffold, no Y-adjust.
    // ═══════════════════════════════════════════════════════════════════

    async function setupStationary() {
      const worldAnchors = buildingIntegrity.getWorldAnchors(blueprintName, roomKey);

      // Unguarded (see the clearing pass above). This one answered `done: true` on a throw — the build
      // declared FINISHED because the instrument that measures finishedness broke (Law 25).
      const integrity = buildingIntegrity.scan(bot, blueprintName, roomKey);

      lastBuildingName = integrity?.building_name || lastBuildingName;
      if (integrity?.all_complete || !Array.isArray(integrity?.steps) || integrity.steps.length === 0) {
        return { done: true, reason: 'all_complete', remaining: 0 };
      }

      const curCorrect = integrity.stats?.correct ?? 0;
      if (prevCorrect >= 0 && curCorrect < prevCorrect) {
        watcher.warn('build_executor', `⚠️ Correct count regression: ${prevCorrect}→${curCorrect} (${prevCorrect - curCorrect} block(s) lost)`);
      }
      prevCorrect = curCorrect;

      allSteps = integrity.steps.slice();

      // Group every step (all Y, dig + place) under its anchor. No scaffold
      // classification — there is no pillaring, so nothing creates scaffold.
      const anchorSteps = worldAnchors.map(() => []);
      for (const step of allSteps) {
        const ai = step.anchor_index ?? -1;
        if (ai < 0 || ai >= worldAnchors.length) continue;
        anchorSteps[ai].push(step);
      }
      // Stand ON the anchor by default, but step OFF to a reach-valid neighbor when the anchor
      // column has no durable footing (see resolveAnchorStand) — needs anchorSteps to know which
      // cells get dug this pass, so it is computed here, not before the grouping.
      const standPositions = worldAnchors.map((a, i) => resolveAnchorStand(bot, a, anchorSteps[i]));
      // An anchor owes REQUIRED structural work (anything not an optional decoration) or only
      // OPTIONAL steps (torches). Required work always keeps an anchor selectable. Optional-only
      // anchors are DEFERRED — but not forever: a torch's support may be a wall a DIFFERENT anchor
      // still has to place, so it can only be lit once the whole shell stands. So "fix/build first,
      // decorate last" — an optional-only anchor becomes actionable again the moment NO anchor
      // anywhere still owes a required block, and its deferred torches get placed then (Architect,
      // 2026-07-04: earlier sections were never lit because an optional-only anchor was treated as
      // permanently done). A torch still unplaceable after the shell is up defers → identical pass →
      // portable_judge escalates (bounded, surfaced), never a silent forever-skip.
      const anchorHasRequired = (ai) => anchorSteps[ai].some(s => !OPTIONAL_BUILD_MATERIALS.has(normalizeBlockName(s.type)));
      const anchorHasDig = (ai) => anchorSteps[ai].some(s => s.action === 'dig');
      const anyRequiredStructureLeft = () => worldAnchors.some((_, i) => !anchorStuck.has(i) && anchorHasRequired(i));
      const anchorActionable = (ai) => {
        if (!anchorSteps[ai] || anchorSteps[ai].length === 0 || anchorStuck.has(ai)) return false;
        if (anchorHasRequired(ai)) return true;          // structural work — always selectable
        return !anyRequiredStructureLeft();              // optional-only (torches) — only once the shell is done
      };
      // Fix-first (Architect, 2026-07-04): among actionable anchors, one carrying a DIG (a repair/
      // mismatch clear) outranks a place-only one — repairs go before fresh placement. Used on a
      // fresh selection only; an in-progress anchor still finishes before the next is picked (no
      // mid-anchor thrashing).
      const findActionable = () => {
        const withDig = worldAnchors.findIndex((_, i) => anchorActionable(i) && anchorHasDig(i));
        return withDig >= 0 ? withDig : worldAnchors.findIndex((_, i) => anchorActionable(i));
      };

      // Anchor selection. When the job claimed a specific anchor (per-anchor gating),
      // build ONLY that one — the gate/preconstruction staged just its materials, so
      // running ahead into an unprepped anchor would stall. When the claimed anchor is
      // done this pass exits to cleanup and recursive_judge re-dispatches the next
      // anchor (separately gated). No claim (legacy/whole-build) → stay on the current
      // anchor while it has work, else the first actionable one.
      const claimedAnchor = (payload && payload.anchor_index != null) ? payload.anchor_index : null;
      let chosen = -1;
      if (claimedAnchor != null) {
        chosen = anchorActionable(claimedAnchor) ? claimedAnchor : -1;
      } else if (lastAnchorIndex >= 0 && lastAnchorIndex < worldAnchors.length && anchorActionable(lastAnchorIndex)) {
        chosen = lastAnchorIndex;
      } else {
        chosen = findActionable();
      }

      // Object lock (arbiter flavor a — physical exclusivity, taxonomy in
      // overseer_brain.js): the anchor is the claimed object — no other bot may
      // build it while held (lock the object, not the bot). Chosen at execution
      // time, so the planning token can't cover it. A peer-held anchor is treated
      // like a stuck one: skip it and select another. In per-anchor-gated mode
      // there is no "another" (materials were staged for exactly this anchor),
      // so a peer hold exits to cleanup for a fresh dispatch instead.
      while (chosen >= 0) {
        const a = worldAnchors[chosen];
        const claimKey = `anchor:${blueprintName}:${chosen}@${a.x},${a.y},${a.z}`;
        if (heldAnchorClaimKey === claimKey) break;

        // Unguarded: the claim is ours and answers in `granted`. The catch that stood here turned a
        // defect into `granted: false`, which reads as "a peer holds this anchor" — so the bot walked
        // away from an anchor nobody held, marked it stuck, and did that for every anchor in turn.
        const claim = await overseerLink.requestClaim(claimKey);
        if (claim.granted) {
          if (heldAnchorClaimKey) overseerLink.releaseClaim(heldAnchorClaimKey);
          heldAnchorClaimKey = claimKey;
          break;
        }

        watcher.summary('build_executor', `A${chosen} held by a peer — selecting another anchor`);
        anchorStuck.add(chosen);
        chosen = (claimedAnchor != null) ? -1 : findActionable();
      }

      if (chosen < 0) {
        const totalRemaining = anchorSteps.reduce((sum, s) => sum + s.length, 0);
        if (totalRemaining > 0) {
          // Diagnostic (Law 6): blocked_remainder loops when job_board keeps dispatching an anchor
          // build_executor treats as done. Dump per-anchor why: claimed anchor, and for each anchor
          // with steps left — dig/place counts, sample positions+reason, whether it has a REQUIRED
          // (non-optional) step, and if it's stuck/peer-held. Shows exactly which anchor's residual
          // keeps the build incomplete and why this pass won't touch it.
          const breakdown = anchorSteps.map((steps, ai) => {
            if (!steps.length) return null;
            const digs = steps.filter(s => s.action === 'dig');
            const places = steps.filter(s => s.action === 'place');
            const req = anchorHasRequired(ai);
            const sample = steps.slice(0, 3).map(s => `${s.action[0]}(${s.place.x},${s.place.y},${s.place.z})=${s.type}:${s.reason}`).join(' ');
            return `A${ai}[dig=${digs.length} place=${places.length} req=${req} stuck=${anchorStuck.has(ai)} | ${sample}]`;
          }).filter(Boolean).join('  ');
          watcher.warn('build_executor', `blocked_remainder: ${totalRemaining} step(s) remain, no actionable anchor (claimed=${claimedAnchor}). ${breakdown}`);
          return { done: true, reason: 'blocked_remainder', remaining: totalRemaining };
        }
        return { done: true, reason: 'all_complete', remaining: 0 };
      }

      // Move to the anchor stand position. goTo handles horizontal travel and
      // descent between cells; there is no pillar-up — the bot never leaves
      // ground/stand level.
      const stand = standPositions[chosen];
      let feet = bot.entity.position.floored();
      const hDist = Math.sqrt((feet.x - stand.x) ** 2 + (feet.z - stand.z) ** 2);
      if (hDist > 1.5 || Math.abs(feet.y - stand.y) > 1) {
        await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z });
        feet = bot.entity.position.floored();
      }
      // Stranded ABOVE the stand (feet directly over it): a self-excavated floor (a build that digs its
      // own sunken floor) leaves the anchor approach as a pit, so the horizontal goTo above finds no walkable edge DOWN.
      // Locomotion owns the descent — an exact-goTo digs straight down onto the stand (hardened
      // dig_down, no fall), landing feet === stand so repairAtAnchor's exact-goTo is a no-op. One
      // authority, no build-local descent primitive (Architect 2026-07-14). Fires only when directly
      // above the stand column; normal flat builds (feet already at stand.y) are untouched.
      if (feet.x === stand.x && feet.z === stand.z && feet.y > stand.y) {
        await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, exact: true });
        if (Math.floor(bot.entity.position.y) > stand.y) {
          watcher.warn('build_executor', `A${chosen} stand (${stand.x},${stand.y},${stand.z}) still unreached from above — bot at y=${Math.floor(bot.entity.position.y)}; anchor will surface as a real stall if it cannot build from here.`);
        }
      }
      await microCenter(bot);
      lastAnchorIndex = chosen;

      const digCount = anchorSteps[chosen].filter(s => s.action === 'dig').length;
      const placeCount = anchorSteps[chosen].filter(s => s.action === 'place').length;
      watcher.summary('build_executor', `📥 ${integrity.building_name} ${integrity.stats?.correct || '?'}/${integrity.stats?.expected || '?'} | A${chosen} stationary (dig ${digCount}, place ${placeCount})`);

      return { done: false, job: { anchorIndex: chosen, anchor: worldAnchors[chosen], stand, steps: anchorSteps[chosen] }, integrity };
    }

    // innerBuildStationary — one anchor's whole-cell pass, delegated to the SHARED anchored
    // repair primitive (Law 16 / D3). The primitive owns the control flow (stand, dig-all
    // top-down, place-all bottom-up, reach gate, corner cheat, per-step retry, tally). This
    // wrapper injects build_executor's domain mechanics: digOne (plain performDig), placeOne
    // (group resolution + station registration + pillarStep footing), item resolution via
    // resolveDesiredItemName, and the OPTIONAL_BUILD_MATERIALS defer policy.
    async function innerBuildStationary(job) {
      const outcome = await anchoredRepair.repairAtAnchor(bot, {
        stand: job.stand,
        steps: job.steps,
        label: `A${job.anchorIndex} stationary`,
      }, {
        digOne,
        placeOne,
        resolveItem: (type) => resolveDesiredItemName(bot, type),
        isOptional: (type) => OPTIONAL_BUILD_MATERIALS.has(type),
        stationTypes: STATION_TYPES,
        tag: 'build_executor',
        maxPlaceAttempts: PLACE_MAX_ATTEMPTS,
        // Replace the block the bot stands on by sidestepping (dig+place from the side, step back)
        // instead of digging its own footing and falling into the cell. Build-only; mining keeps its
        // own descent model (no footingSidestep), so this leaves mining untouched (Law 16 per-domain op).
        footingSidestep: true,
      });
      return { anchorIndex: job.anchorIndex, ...outcome };
    }

    // ═══════════════════════════════════════════════════════════════════
    // MAIN: planner/manager → executor loop → cleanup/judge → capsule → route
    // ═══════════════════════════════════════════════════════════════════
    while (true) {
      const result = await setupStationary();
      if (result.done) { exitReason = result.reason; break; }

      const outcome = await innerBuildStationary(result.job);
      totalDigOk += outcome.dig_ok;
      totalDigFail += outcome.dig_fail;
      totalPlaceOk += outcome.place_ok;
      totalPlaceFail += outcome.place_fail;
      totalAlreadyOk += outcome.already_ok;
      iterations++;

      // Stay on an anchor while it still owes real work. Deferred blocks (a course whose
      // support was not placed this pass — including the footing, which pillarStep now
      // retries) get a fresh attempt next pass, so deferral is NOT a reason to abandon the
      // anchor. Only give up when a whole pass made zero progress AND nothing is waiting on
      // a support (deferred==0) — i.e. the remaining work genuinely failed rather than being
      // "not yet placeable". A repeated true stall (footing actually unplaceable) is caught
      // by portable_judge below, which owns stall detection (one detector, Law 16).
      const madeProgress = (outcome.dig_ok + outcome.place_ok) > 0;

      // Required material ran short mid-pass (a block the bot doesn't hold — e.g. dual-role dirt burned
      // pillaring between tasks). Distinct from a defer (waiting on a support a later pass places): a fresh
      // block won't appear by retrying, so RELEASE to recursive_judge — that routes into the existing
      // shortfall → supply → re-stage → re-dispatch loop (job_board re-derives the need and posts the supply
      // job; building_manager re-gates staging on the next dispatch). Only release once a whole pass placed
      // NOTHING — a pass that used up what it had (madeProgress) keeps going; the next pass, finding the same
      // block still absent, hits this with zero progress and releases. This is the halt cure: before the
      // separate material_short bucket, a required-short folded into `deferred` and the executor spun the same
      // doomed pass until portable_judge strict-killed it (Architect 2026-07-13).
      if (outcome.material_short > 0 && !madeProgress) {
        const shortList = Object.entries(outcome.short_materials || {}).map(([m, c]) => `${c}×${m}`).join(', ');
        watcher.warn('build_executor', `A${outcome.anchorIndex} material-short (${shortList}), zero progress — releasing to recursive_judge for resupply`);
        exitReason = 'material_short';
        break;
      }

      if (!madeProgress && outcome.deferred === 0 && (outcome.dig_fail + outcome.place_fail) > 0) {
        anchorStuck.add(outcome.anchorIndex);
        watcher.warn('build_executor', `Marking A${outcome.anchorIndex} blocked — zero progress, nothing deferred (fail=${outcome.dig_fail + outcome.place_fail}); skipping it for the rest of this run`);
      }

      // Optional-only residual: the anchor's remaining work is all optional steps whose material is not
      // held — placeOne returns 'skipped', so nothing failed, nothing is deferred, and there is genuinely
      // no work this run can do here. Mark it done for the run so the build completes at the shell instead
      // of re-selecting a zero-progress pass into a portable_judge strict-kill; 'skipped' was an uncounted
      // no-op that could neither complete nor block the anchor. The step is re-derived on a future
      // dispatch once its material arrives.
      // UNREACHABLE while OPTIONAL_BUILD_MATERIALS is empty. Do not read this branch as licence to refill
      // that set: an anchor left open by an optional step is what held a shell "unfinished" long enough to
      // keep its night-gather exemption alive and send a bot outdoors after dusk.
      if (!madeProgress && outcome.deferred === 0 && (outcome.dig_fail + outcome.place_fail) === 0 && outcome.skipped > 0) {
        anchorStuck.add(outcome.anchorIndex);
        watcher.summary('build_executor', `A${outcome.anchorIndex} optional-only (${outcome.skipped} skipped, material absent) — done for this run; build proceeds without decoration`);
      }

      const iterSummary = `${lastBuildingName} A${outcome.anchorIndex} stationary: dig=${outcome.dig_ok} place=${outcome.place_ok} fail=${outcome.dig_fail + outcome.place_fail} deferred=${outcome.deferred} | ${allSteps.length} steps remaining`;
      watcher.summary('build_executor', iterSummary);

      const pjOk = await portableJudge.checkpoint('build_executor', iterSummary, 'strict');
      if (pjOk === false) {
        // Stall — dump the buffered per-block trace (every dig/place decision, ref,
        // reach, outcome) so the Architect sees exactly what the bot was attempting.
        watcher.error('build_executor', `portable_judge escalated on A${outcome.anchorIndex}: ${iterSummary}`);
        exitReason = 'portable_judge_escalated';
        break;
      }

      await combatCheckpoint(bot, 'build');
    }

    // Executor is leaving the anchor either way — release the object lock so
    // peers can enter/build it (a re-dispatch re-claims).
    if (heldAnchorClaimKey) {
      overseerLink.releaseClaim(heldAnchorClaimKey);
      heldAnchorClaimKey = null;
    }

    // ── CLEANUP/JUDGE ────────────────────────────────────────────────
    // If portable_judge escalated, it already routed to recursive_judge.
    // Don't route again — just stop. recursive_judge handles magnet/cleanup.
    if (exitReason === 'portable_judge_escalated') {
      watcher.summary('build_executor', `${lastBuildingName} stopped by portable judge after ${iterations} iteration(s)`);
      return;
    }

    portableJudge.done('build_executor');
    const finalDrops = await cleanup();

    const clearCount = finalDrops.clear_count || 0;
    totalDigOk += clearCount;
    const exitSummary = `${lastBuildingName} ${exitReason} after ${iterations} iteration(s): dig=${totalDigOk}/${totalDigOk + totalDigFail} place=${totalPlaceOk}/${totalPlaceOk + totalPlaceFail} drops=${finalDrops.picked_up} cleared=${clearCount}`;
    watcher.summary('build_executor', exitSummary);

    const capsule = payload.build_executor || (payload.build_executor = {});
    capsule.success = exitReason === 'all_complete';
    capsule.result = exitReason;
    capsule.building_name = lastBuildingName;
    capsule.iterations = iterations;
    capsule.metrics = { dig_ok: totalDigOk, dig_fail: totalDigFail, place_ok: totalPlaceOk, place_fail: totalPlaceFail, already_ok: totalAlreadyOk, cleared: clearCount };
    // ── THE READABLE IS WHAT THE JUDGE COMPARES, SO IT CARRIES THE REMAINDER ────────────────────────
    //   "if theres any variable in the report then judge can look at it. so it could be placed '3' blocks
    //    at anchor 1. and identify the blocks. or the voxels." (Architect 2026-08-12)
    //
    // job_board now dispatches PARTIAL anchors — a pass that places three of twelve blocks is the normal,
    // desired outcome and will happen several times in a row on one anchor. `place_ok` alone cannot carry
    // that: two passes that each place three read IDENTICALLY, three of those is a contiguous streak, and
    // recursive_judge kills a build that was working. The per-anchor voxel remainder is the variable that
    // separates them — 12, then 9, then 6 — so a build making progress never looks like a repeat, and one
    // that is genuinely stuck still reports the same number twice and is still caught.
    //
    // `@lastscan` is in the name and is not hedging: the count comes from the integrity scan at the top of
    // the final iteration, so on an exit that placed blocks after that scan it lags by one pass. Naming
    // the instant is what keeps the number honest instead of implying a post-pass measurement it is not
    // (Law 25). Every exit that matters here — `material_short`, `blocked_remainder` — is reached only
    // after a pass that placed nothing, where the scan and the truth agree exactly.
    const remainderByAnchor = allSteps.reduce((acc, s) => {
      const ai = s.anchor_index ?? -1;
      acc[ai] = (acc[ai] || 0) + 1;
      return acc;
    }, {});
    const remainderText = Object.entries(remainderByAnchor)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([ai, n]) => `A${ai}:${n}`).join(',') || 'none';
    capsule.voxels_left = remainderByAnchor;
    capsule.readable = `build_executor: "${lastBuildingName}" ${exitReason} A${lastAnchorIndex} ` +
      `dig_ok=${totalDigOk} place_ok=${totalPlaceOk} left@lastscan=${remainderText}`;
    capsule.recursion_alert = true;
    capsule.drop_collector = finalDrops;

    routeToJudge(signalBus, 'build_executor', { ...payload, readable: capsule.readable });
  })
};
