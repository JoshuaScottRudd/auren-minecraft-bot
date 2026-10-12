// fragment: build_executor
// purpose: Stationary fractal build system. Preconstruction (separate fragment) prepares
//          materials before this fragment runs. Per anchor the bot stands ONCE at
//          anchor.y+1, digs ALL Y (top-down) then places ALL Y (bottom-up) from that spot —
//          every voxel of a 5×5×5 cell is within the 4.5 reach radius. High corners place
//          via the non-raycast findAttachable path (a "cheat place"), the same model the
//          mining cell executor uses. Valid on a vanilla server with no anti-cheat/LOS.
// invariants: job_board gates building until all materials are staged in inventory; all
//   digs at an anchor complete before any placing starts; zero vertical movement at an
//   anchor beyond placeOne under-feet; planner/manager decides, this executor only
//   executes; portable_judge (strict) routes a stall to recursive_judge; on exit,
//   cleanup/judge descends, collects drops, dumps excess inventory (INVENTORY_WHITELIST
//   from job_board) and composes the capsule. (Law 19): stands at the anchor and reaches
//   the whole cell without pillaring for a vantage point — the one vertical move left
//   is pillaring its own footing block.
const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');

const { group_to_item, groupToReference, normalizeBlockName, BLOCK_REACH, STATION_TYPES, WINDOWLESS_STATIONS } = require('@utils/fragment_utils');
// Entered through combatCheckpoint, never battleStations directly — one process-wide
// 500ms clock shared with dig/drive, with an engaging/escaping bypass for combat's own arms.
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
const jobExclusions = require('@thinking/job_exclusions');
const hq = require('@kernel/corporate_headquarters');
const portableJudge = require('@kernel/portable_judge');
const foremanLink = require('@kernel/foreman_link');
const blueprintRegistry = require('@kernel/blueprint_registry');
// The stationary dig-all/place-all routine is shared with mining_executor (Law 16); this
// file supplies build-domain mechanics as callbacks, the primitive owns anchor control flow.
const anchoredRepair = require('@api/anchored_repair');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternalSync, withCleanup } = require('@utils/external_library_guard');

// PLACE_MAX_ATTEMPTS — retries a place step before it defers/fails: covers a footing whose
// first attempt timed out, and an out-of-range drift that re-anchoring fixes.
const PLACE_MAX_ATTEMPTS = 3;
const sleep = ms => new Promise(res => setTimeout(res, ms));

// ── WHAT THE BODY CAN SEE AT A CELL THE SERVER JUST REFUSED ──────────────────
// refusalSurvey and occupantsOf read the world at the moment of a refusal (Invariant B,
// Law 26): whether the cell is actually empty, an entity's hitbox occupies it, or the
// support face is wrong. occupantsOf lists every entity whose AABB overlaps the target
// cell (Law 16). A player AABB is 0.6 wide, 1.8 tall, feet-anchored, so an entity occupies
// its own cell and the one above; overlap is measured per axis. Returns [] on an
// unreadable entity list.
const ENTITY_HALF_WIDTH = 0.3;
const ENTITY_HEIGHT = 1.8;
// The entity kinds that stand in a cell and must be waited out. mineflayer names the kind on
// `entity.type`, and it has changed spelling across versions, so every living spelling is listed
// and the set is the whole permission — an unknown kind is not waited for.
const BLOCKING_KINDS = new Set(['player', 'mob', 'hostile', 'animal', 'creature', 'living', 'npc']);
function occupantsOf(bot, pos) {
  // bot.entities is this body's own live view; the boardroom's relayed body cells can be
  // up to a second stale.
  const ents = guardExternalSync('build_executor', 'cell occupants', () => Object.values(bot.entities || {}));
  if (!ents.ok) return [];
  const out = [];
  for (const e of ents.value) {
    const p = e?.position;
    if (!p) continue;
    // An occupant is something a placement has to wait for, and that is a BODY — a player or a
    // living mob standing where the next block goes. A dropped item, an arrow or an orb is named
    // here by omission: the server places the block and pops the item out, so nothing is in the
    // way, and a thing that cannot walk off never satisfies a wait for it to move.
    if (!BLOCKING_KINDS.has(String(e.type || '').toLowerCase())) continue;
    // Cell AABB is [x, x+1) × [y, y+1) × [z, z+1); entity AABB is feet-anchored and half-width wide.
    if (p.x + ENTITY_HALF_WIDTH <= pos.x || p.x - ENTITY_HALF_WIDTH >= pos.x + 1) continue;
    if (p.z + ENTITY_HALF_WIDTH <= pos.z || p.z - ENTITY_HALF_WIDTH >= pos.z + 1) continue;
    if (p.y + ENTITY_HEIGHT <= pos.y || p.y >= pos.y + 1) continue;
    // Named SELF, not counted as a peer: a body standing in its own target is a footing
    // fault, not contention.
    const self = (e.id === bot.entity?.id);
    out.push({ self, who: self ? 'SELF' : (e.username || e.name || e.displayName || `#${e.id}`), p });
  }
  return out;
}

// ── WAIT THE CELL OUT; DO NOT NEGOTIATE FOR IT ───────────────────────────────
// A refused placement is often a peer standing on the course it just laid, in the cell the
// next course goes into — usually clear within a second, so this polls for it. Returns the
// instant the cell is clear, so a queue of crossing bodies resolves as soon as any poll
// finds it empty. SELF is never waited out — that is a footing fault, not contention.
const CELL_WAIT_MS = 10000;
const CELL_POLL_MS = 50;         // one tick
async function waitForCellClear(bot, pos) {
  const first = occupantsOf(bot, pos);
  if (!first.length) return { clear: true, waitedMs: 0 };
  if (first.some(o => o.self)) return { clear: false, waitedMs: 0, reason: 'self' };
  const startedAt = Date.now();
  while (Date.now() - startedAt < CELL_WAIT_MS) {
    await sleep(CELL_POLL_MS);
    const now = occupantsOf(bot, pos);
    if (!now.length) {
      const waitedMs = Date.now() - startedAt;
      watcher.summary('build_executor', `cell (${pos.x},${pos.y},${pos.z}) cleared after ${(waitedMs / 1000).toFixed(1)}s `
        + `— placing; it was held by ${first.map(o => o.who).join(',')}.`);
      return { clear: true, waitedMs };
    }
    if (now.some(o => o.self)) return { clear: false, waitedMs: Date.now() - startedAt, reason: 'self' };
  }
  return { clear: false, waitedMs: Date.now() - startedAt, reason: 'timeout' };
}

function refusalSurvey(bot, pos) {
  const parts = [];
  const here = guardExternalSync('build_executor', 'refusal survey blockAt', () => bot.blockAt(new Vec3(pos.x, pos.y, pos.z)));
  const below = guardExternalSync('build_executor', 'refusal survey blockAt below', () => bot.blockAt(new Vec3(pos.x, pos.y - 1, pos.z)));
  parts.push(`cell=${here.ok ? (here.value?.name ?? 'unloaded') : `unreadable:${here.reason}`}`);
  parts.push(`below=${below.ok ? (below.value?.name ?? 'unloaded') : `unreadable:${below.reason}`}`);

  const overlaps = occupantsOf(bot, pos)
    .map(o => `${o.who}@(${o.p.x.toFixed(1)},${o.p.y.toFixed(1)},${o.p.z.toFixed(1)})`);
  parts.push(overlaps.length ? `blocked_by=${overlaps.join(',')}` : 'blocked_by=none');
  return parts.join(' ');
}

// registrationCrash — formats the Law 13 crash message for a block placed and re-sensed
// correct but that could not be registered as a station. Proven present, so the failure is
// a coding/blueprint fault, not a world condition: stops and names the cause. Preconstruction
// crafts exactly the needed chest count, so a wasted one starves the next slot. Only the
// confirmed lid-blocked cause (a solid block above a chest) is checked before the crash;
// every other case reports measured facts.
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

// resolveAnchorStand — where the bot stands to build one anchor's cell. Default is the
// anchor column (anchor.y+1). When that column has no durable footing (air, or dug this
// pass), it steps to a solid cardinal neighbor from which every step is still within reach
// (reuses anchored_repair.reachFromStand). No reach-valid neighbor leaves it on the anchor
// cell, so an unstandable anchor surfaces as a stall.
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
// enclosed-corner test live in the shared anchored_repair primitive (Law 16).
// build_executor keeps only build-domain place mechanics (placeOne below).

module.exports = {
  receive: watcher.track('build_executor', async (signalType, payload) => {
    if (signalType !== 'build_executor') return;

    const bot = global.bot;
    const blueprintName = payload?.blueprint_name || 'headframe';
    const roomKey = payload?.conference_room_key || blueprintName;
    // ── WHAT THE BOARD SAID THE FLEET CANNOT GET, READ OFF THE JOB ────────────
    // Reads job_board's excluded-materials list via job_exclusions; decides nothing about it.
    // Absent means exclude nothing — a job with no field places every voxel.
    const excluded = payload?.excluded || null;
    const isExcluded = (type) => jobExclusions.excludes(excluded, type);
    // Announces only what it actually skips, one line per skipped cell (below).

    // ── One-time setup (outside the loops) ──────────────────────────────

    // ── IS THIS A PLAN EVERY BODY MAY BUILD AT ONCE? ────────────────────────
    // Read off the blueprint's own label (Law 16). False leaves one-builder-per-anchor
    // unchanged.
    const pledgedPlan = blueprintRegistry.isPledgeApproved(blueprintName);

    // Mutable, read by helpers via closure.
    let allSteps = [];

    // ── Helper functions ────────────────────────────────────────────────

    async function digOne(step) {
      const pos = new Vec3(step.place.x, step.place.y, step.place.z);
      const block = bot.blockAt(pos);
      if (!block || isAir(block.name)) return true;
      return performDig(bot, pos, block, 'build_executor');
    }

    // registerStandingStation — opens a station standing in its blueprint cell and writes it
    // to the registry. Returns only on success; a failure THROWS (Law 13 — registrationCrash).
    // Also called on an already-correct-but-unregistered block; gated on "not registered".
    async function registerStandingStation(pos, block) {
      // A windowless station (composter) is placed and left alone — no lid to poll for, so
      // its state is a public blockstate read off the world (WINDOWLESS_STATIONS) instead.
      if (WINDOWLESS_STATIONS.has(block.name)) {
        watcher.buffer.record('build_executor', `Windowless station: ${block.name} at (${pos.x},${pos.y},${pos.z}) — no registration (its blockstate is its record).`);
        return true;
      }
      if (stationRegistry.getStations()[stationRegistry.stationKey(pos)]) return true;

      // Unguarded: openProofWindow guards its own boundary and result.ok is the verdict, so a
      // catch here could only mask a defect (Law 13; Law 25). Re-sensed to catch a lagging
      // lid that a single 250ms read would misreport as no_window.
      const diag = {};
      const win = await stationRegistry.openProofWindow(bot, block, diag);
      if (win) diag.window_type = win.type || 'unknown';

      // No role is assigned to a chest — what it's for is decided by pool demand (any
      // request fills from any chest), never a tag written at placement time.
      const result = stationRegistry.registerStation(pos, block.name, win, roomKey);
      watcher.buffer.record('build_executor', `Station registered: ${block.name} at (${pos.x},${pos.y},${pos.z}) → ${result.ok ? 'ok' : result.reason} id=${result.id || 'n/a'}`);
      if (win) { guardExternalSync('build_executor', 'closeWindow after registration', () => bot.closeWindow(win)); await sleep(100); }
      if (bot.currentWindow) await ensureNoOpenWindow(bot, 'post-register');

      // A registration failure only ever throws (Law 13) — the block is proven present, so
      // the fault is in the build, not the world. The window is already closed above.
      if (!result.ok) throw new Error(registrationCrash(bot, pos, block, roomKey, result.reason, diag));
      return true;
    }

    async function placeOne(step, ev) {
      const pos = ev.pos;
      const desiredToken = normalizeBlockName(step.type);
      const current = bot.blockAt(pos);

      // A correct cell is still asked whether its station is registered — the block is
      // right, only the registry entry might still be missing.
      if (group_to_item && group_to_item[desiredToken] && current && expandGroup(desiredToken).includes(current.name)) {
        if (STATION_TYPES.has(current.name)) await registerStandingStation(pos, current);
        return 'already';
      }

      // Under-feet placement: the blueprint block is the bot's own footing, so it places
      // itself by pillaring onto the correct block (pillarStep, via candidateItemNames) — the
      // one place stationary build still moves vertically.
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
        // Names the specific skipped cell (dispatch names only the set). Warn, not summary —
        // nothing failed; the fleet returns once the board stops excluding the material.
        if (isExcluded(desiredToken)) {
          watcher.buffer.record('build_executor',
            `⤳ skipped ${desiredToken} at (${pos.x},${pos.y},${pos.z}) — ${jobExclusions.why(excluded, desiredToken)}`);
          return 'skipped';
        }
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

      // Equip, the spawn-protection gate, combat checkpoint, sneak decision and release,
      // face-centre aim, click and settle all live in the one place route (Law 16),
      // including the sneak-when-interactable rule (that authority's 'auto' default). The
      // cell is waited out before the click, not diagnosed after refusal — a peer's
      // one-second occupancy is indistinguishable from a real fault otherwise (Law 25).
      const held = await waitForCellClear(bot, pos);
      if (!held.clear) {
        watcher.warn('build_executor', `cell (${pos.x},${pos.y},${pos.z}) still occupied after `
          + `${(held.waitedMs / 1000).toFixed(1)}s (${held.reason}) — ${refusalSurvey(bot, pos)}`);
        return false;
      }
      const place = await performPlace(bot, pos, ev.anchor, ev.face, desiredName, 'build_executor', step.state ? { state: step.state } : {});
      if (place.state && place.ok && !place.state.ok) {
        watcher.warn('build_executor', `wrong state at (${pos.x},${pos.y},${pos.z}) ${desiredName}: wanted ${JSON.stringify(place.state.wanted)} got ${JSON.stringify(place.state.got)} [${place.aim}]`);
      }
      if (!place.ok) {
        const bp = bot.entity.position;
        watcher.warn('build_executor', `place refused at (${pos.x},${pos.y},${pos.z}) — ${place.reason} | bot at (${bp.x.toFixed(1)},${bp.y.toFixed(1)},${bp.z.toFixed(1)}) dist=${dist3({x:pos.x+0.5,y:pos.y+0.5,z:pos.z+0.5},{x:bp.x,y:bp.y,z:bp.z}).toFixed(1)} anchor=${ev.anchor.name}@(${ev.anchor.position.x},${ev.anchor.position.y},${ev.anchor.position.z}) | ${refusalSurvey(bot, pos)}`);
        return false;
      }

      // A placement may leave a window open (chests/furnaces/barrels open a UI on click);
      // closed here, specific to what this places, not in the shared authority.
      if (bot.currentWindow) await ensureNoOpenWindow(bot, 'post-place');

      // Same registration question as an already-correct cell (Law 16) — registers or
      // throws; nothing is ever dug up on a registration failure.
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

    // Per-anchor stuck tracker: zero progress on a whole-cell pass means it's genuinely
    // blocked this run — skip it so the build exits cleanly to cleanup (Law 12).
    const anchorStuck = new Set();

    // Object lock on the anchor being worked; one at a time, released on switch/exit.
    let heldAnchorClaimKey = null;

    // ── THE CELLS THIS BODY HOLDS RIGHT NOW, ON A PLEDGE-APPROVED PLAN ──────────────────────────────
    // The anchor lock's replacement, one level down — cleared and re-taken each pass.
    let heldCellKeys = [];
    const releaseHeldCells = () => {
      for (const k of heldCellKeys) foremanLink.releaseClaim(k);
      heldCellKeys = [];
    };

    // ── ONE PLEDGE IS ONE CELL, A FLOOR NOT A CEILING ──────
    // Claims as many cells as the pocket can pay for, in order (buildingIntegrity.placeableNow:
    // lowest course first, plan order within a course); two bodies arriving together reach
    // for adjacent cells, and the loser moves one down the list. Digs are claimed with their
    // cell. A body that can pay for nothing claims nothing (Law 25 — pool and pocket differ).
    //
    // The cell under the stand is swapped from a neighbour on the same level (anchored_repair's
    // sidestep), so it is claimable only while one stands: the pocket's blocks go to the cells beside
    // it first, and the swap follows on a later pass.
    async function claimCellsInOrder(steps, stand) {
      const footingKey = `${stand.x},${stand.y - 1},${stand.z}`;
      const sidestep = anchoredRepair.findStandableNeighbor(bot, stand);
      const footingSwappable = !!sidestep && sidestep.dy === 0;
      const digs   = steps.filter(s => s.action === 'dig');
      const places = buildingIntegrity.placeableNow(steps);
      const byCell = new Map();          // 'x,y,z' → every step at that position
      for (const s of steps) {
        const k = `${s.place.x},${s.place.y},${s.place.z}`;
        if (!byCell.has(k)) byCell.set(k, []);
        byCell.get(k).push(s);
      }
      const order = [];
      const seen = new Set();
      for (const s of [...digs, ...places]) {
        const k = `${s.place.x},${s.place.y},${s.place.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        order.push(k);
      }

      // What the pocket can pay for, spent down as cells are allocated. A dig costs nothing.
      const spent = {};
      const affordable = (cellSteps) => cellSteps.every(s => {
        if (s.action !== 'place') return true;
        const held = resolveDesiredItemName(bot, s.type);
        if (!held) return false;
        const have = bot.inventory.items().filter(i => i.name === held).reduce((n, i) => n + i.count, 0);
        return have - (spent[held] || 0) > 0;
      });
      const charge = (cellSteps) => {
        for (const s of cellSteps) {
          if (s.action !== 'place') continue;
          const held = resolveDesiredItemName(bot, s.type);
          if (held) spent[held] = (spent[held] || 0) + 1;
        }
      };

      const taken = [];
      let peerHeld = 0, unpayable = 0, digCells = 0, footingWaits = 0;
      for (const key of order) {
        const cellSteps = byCell.get(key);
        if (key === footingKey && !footingSwappable) { footingWaits++; continue; }
        // One dig per pass: the board seats one body per dig, so a body pledging every free dig would
        // empty the seats its peers were sent for.
        const isDig = cellSteps.some(s => s.action === 'dig');
        if (isDig && digCells >= 1) continue;
        if (!affordable(cellSteps)) { unpayable++; continue; }   // never claim what this pocket cannot place
        // Unguarded, exactly as the anchor claim below is: the claim is ours and answers in `granted`.
        const claim = await foremanLink.requestClaim(`cell:${blueprintName}@${key}`);
        if (!claim.granted) { peerHeld++; continue; }
        heldCellKeys.push(`cell:${blueprintName}@${key}`);
        taken.push(...cellSteps);
        charge(cellSteps);
        if (isDig) digCells++;
      }
      return { steps: taken, cells: heldCellKeys.length, peerHeld, unpayable, footingWaits, offered: order.length };
    }

    // ═══════════════════════════════════════════════════════════════════
    // LOOP 3: CLEANUP/JUDGE — runs after the planner/executor loop exits.
    //   1. Descend to anchor stand level
    //   2. Collect nearby drops
    //   3. Clearing pass — re-scan integrity, dig any incorrect block within reach regardless
    //      of scaffold classification, no movement or further drop collection.
    // ═══════════════════════════════════════════════════════════════════
    async function cleanup() {
      // Phase 1: descend to anchor stand level. Locomotion owns how — an exact-goTo lands
      // the feet on the stand, digging straight down (hardened dig_down, no fall) if above
      // it. One descent authority every caller inherits (Law 16).
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
      // Unguarded, here and everywhere below: the integrity scan absorbs its own
      // environmental failure, so a throw escaping it is a defect, not a condition to catch
      // and default around (Law 13; Law 25 — a default is not a measurement).
      const integrity = await buildingIntegrity.scan(bot, blueprintName, roomKey);
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
    // STATIONARY BUILD — planner + executor for the no-pillar model (see file header).
    // ═══════════════════════════════════════════════════════════════════

    async function setupStationary() {
      const worldAnchors = buildingIntegrity.getWorldAnchors(blueprintName, roomKey);

      // Unguarded (see the clearing pass above) — a caught throw here would read as `done:
      // true`, declaring the build finished because the measuring instrument broke (Law 25).
      const integrity = await buildingIntegrity.scan(bot, blueprintName, roomKey);

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
      // Stand on the anchor by default, stepping off to a reach-valid neighbor when the
      // column has no durable footing (see resolveAnchorStand); needs anchorSteps to know
      // what's dug this pass, so it is computed here, after the grouping.
      const standPositions = worldAnchors.map((a, i) => resolveAnchorStand(bot, a, anchorSteps[i]));
      // An anchor owing only optional steps (torches) is deferred, not done — its support
      // may be a wall a different anchor still owes, so it lights only once no anchor
      // anywhere still owes required work: structure completes before decoration.
      const anchorHasRequired = (ai) => anchorSteps[ai].some(s => !isExcluded(normalizeBlockName(s.type)));
      const anchorHasDig = (ai) => anchorSteps[ai].some(s => s.action === 'dig');
      const anyRequiredStructureLeft = () => worldAnchors.some((_, i) => !anchorStuck.has(i) && anchorHasRequired(i));
      const anchorActionable = (ai) => {
        if (!anchorSteps[ai] || anchorSteps[ai].length === 0 || anchorStuck.has(ai)) return false;
        if (anchorHasRequired(ai)) return true;          // structural work — always selectable
        return !anyRequiredStructureLeft();              // optional-only (torches) — only once the shell is done
      };
      // Fix-first: among actionable anchors, one carrying a dig (repair/mismatch clear)
      // outranks a place-only one. Used only on a fresh selection — an in-progress anchor
      // finishes before the next is picked.
      const findActionable = () => {
        const withDig = worldAnchors.findIndex((_, i) => anchorActionable(i) && anchorHasDig(i));
        return withDig >= 0 ? withDig : worldAnchors.findIndex((_, i) => anchorActionable(i));
      };

      // Anchor selection: a claimed anchor (per-anchor gating) builds only that one, since
      // only its materials were staged. No claim → stay on the current anchor while it has
      // work, else pick the first actionable one.
      const claimedAnchor = (payload && payload.anchor_index != null) ? payload.anchor_index : null;
      let chosen = -1;
      if (claimedAnchor != null) {
        chosen = anchorActionable(claimedAnchor) ? claimedAnchor : -1;
      } else if (lastAnchorIndex >= 0 && lastAnchorIndex < worldAnchors.length && anchorActionable(lastAnchorIndex)) {
        chosen = lastAnchorIndex;
      } else {
        chosen = findActionable();
      }

      // Object lock (arbiter flavor a — physical exclusivity, foreman_brain.js): a peer-held
      // anchor is skipped like a stuck one. A pledge-approved plan takes no anchor lock —
      // exclusivity moves to the cell instead (claimCellsInOrder).
      while (!pledgedPlan && chosen >= 0) {
        const a = worldAnchors[chosen];
        const claimKey = `anchor:${blueprintName}:${chosen}@${a.x},${a.y},${a.z}`;
        if (heldAnchorClaimKey === claimKey) break;

        // Unguarded: the claim answers in `granted`. A catch here would turn a defect into
        // `granted: false`, misread as "a peer holds this anchor".
        const claim = await foremanLink.requestClaim(claimKey);
        if (claim.granted) {
          if (heldAnchorClaimKey) foremanLink.releaseClaim(heldAnchorClaimKey);
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
          // Diagnostic (Law 6): per-anchor breakdown of why nothing is actionable — counts,
          // sample positions+reasons, required-step and stuck/peer-held state.
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

      // Move to the anchor stand position — goTo handles horizontal travel and descent
      // between cells; there is no pillar-up.
      const stand = standPositions[chosen];
      let feet = bot.entity.position.floored();
      const hDist = Math.sqrt((feet.x - stand.x) ** 2 + (feet.z - stand.z) ** 2);
      if (hDist > 1.5 || Math.abs(feet.y - stand.y) > 1) {
        await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, leg: 'work' });
        feet = bot.entity.position.floored();
      }
      // Stranded above the stand (feet directly over it): a self-excavated sunken floor
      // leaves no walkable edge down, so Locomotion's exact-goTo digs straight down onto the
      // stand instead (hardened dig_down, no fall). Only fires directly above the stand column.
      if (feet.x === stand.x && feet.z === stand.z && feet.y > stand.y) {
        await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, exact: true, leg: 'work' });
        if (Math.floor(bot.entity.position.y) > stand.y) {
          watcher.warn('build_executor', `A${chosen} stand (${stand.x},${stand.y},${stand.z}) still unreached from above — bot at y=${Math.floor(bot.entity.position.y)}; anchor will surface as a real stall if it cannot build from here.`);
        }
      }
      await microCenter(bot);
      lastAnchorIndex = chosen;

      // The pledge is taken after the walk: claiming a cell from across the site would deny
      // it to a peer standing beside it for however long this body takes to arrive.
      let mySteps = anchorSteps[chosen];
      if (pledgedPlan) {
        releaseHeldCells();
        const pledge = await claimCellsInOrder(anchorSteps[chosen], stand);
        mySteps = pledge.steps;
        if (mySteps.length === 0) {
          // Nothing here for this body, and not a fault: every cell held means the structure
          // is fully crewed; nothing payable means the material is what to go get. Either way
          // this exits clean — recursive_judge replans, no strike recorded. The reason string
          // carries a census (placeable/peer/unpaid) so repeated empty passes on a moving
          // site don't read as an identical stall (Law 25).
          const why = pledge.unpayable > 0 && pledge.peerHeld === 0 ? 'no_payable_cell'
            : pledge.peerHeld > 0 ? 'cells_held_by_peers' : 'footing_waits_for_a_neighbour';
          const census = `${why}(placeable=${pledge.offered},peer=${pledge.peerHeld},unpaid=${pledge.unpayable},footing_waits=${pledge.footingWaits})`;
          watcher.summary('build_executor', `A${chosen} pledged: 0 of ${pledge.offered} cell(s) — `
            + `${pledge.peerHeld} held by peers, ${pledge.unpayable} unaffordable, ${pledge.footingWaits} footing waiting for a neighbour → ${why}`);
          return { done: true, reason: census, remaining: anchorSteps[chosen].length };
        }
        watcher.summary('build_executor', `A${chosen} pledged ${pledge.cells} cell(s) of ${pledge.offered} placeable (${pledge.peerHeld} held by peers)`);
      }

      const digCount = mySteps.filter(s => s.action === 'dig').length;
      const placeCount = mySteps.filter(s => s.action === 'place').length;
      // ── PROGRESS IS WHAT THE FLEET STOOD UP, NOT WHAT THE GROUND ALREADY GAVE ────────────────────
      // stats.correct/expected counts a no-action-needed voxel as correct, so it counts open
      // air and untouched soil as built. integrity.progress is building_integrity's own split
      // and is the only figure here that moves when a bot actually places something.
      const p = integrity.progress;
      const placedOf = p ? `${p.structPlaced}/${p.structTotal} placed (${p.noWorkCells} no-work)` : '?/?';
      watcher.summary('build_executor', `📥 ${integrity.building_name} ${placedOf} | A${chosen} stationary (dig ${digCount}, place ${placeCount})`);

      return { done: false, job: { anchorIndex: chosen, anchor: worldAnchors[chosen], stand, steps: mySteps }, integrity };
    }

    // innerBuildStationary — one anchor's whole-cell pass, delegated to the shared
    // anchored_repair primitive (Law 16), which owns control flow (stand, dig-all top-down,
    // place-all bottom-up, reach gate, corner cheat, retry, tally). This wrapper injects
    // build_executor's domain mechanics — digOne, placeOne, item resolution, exclusion defer.
    async function innerBuildStationary(job) {
      const outcome = await anchoredRepair.repairAtAnchor(bot, {
        stand: job.stand,
        steps: job.steps,
        label: `A${job.anchorIndex} stationary`,
      }, {
        digOne,
        placeOne,
        resolveItem: (type) => resolveDesiredItemName(bot, type),
        isOptional: (type) => isExcluded(type),
        tag: 'build_executor',
        maxPlaceAttempts: PLACE_MAX_ATTEMPTS,
        // Replaces the block the bot stands on by sidestepping: dig+place from the side, step
        // back, so it never digs its own footing and falls in. Build-only — mining keeps its
        // own descent model (Law 16 per-domain op).
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

      // Stay on an anchor while it owes real work — a deferred block gets a fresh attempt
      // next pass, so deferral alone never abandons it. Give up only when a whole pass made
      // zero progress and nothing is deferred (portable_judge catches a repeated true stall).
      const madeProgress = (outcome.dig_ok + outcome.place_ok) > 0;

      // A required material ran short mid-pass — distinct from a defer, since retrying won't
      // make a held block reappear, so this releases to recursive_judge's shortfall→supply
      // loop, once a whole pass placed nothing.
      if (outcome.pocket_short > 0 && !madeProgress) {
        const shortList = Object.entries(outcome.short_materials || {}).map(([m, c]) => `${c}×${m}`).join(', ');
        watcher.warn('build_executor', `A${outcome.anchorIndex} material-short (${shortList}), zero progress — releasing to recursive_judge for resupply`);
        exitReason = 'pocket_short';
        break;
      }

      if (!madeProgress && outcome.deferred === 0 && (outcome.dig_fail + outcome.place_fail) > 0) {
        anchorStuck.add(outcome.anchorIndex);
        watcher.warn('build_executor', `Marking A${outcome.anchorIndex} blocked — zero progress, nothing deferred (fail=${outcome.dig_fail + outcome.place_fail}); skipping it for the rest of this run`);
      }

      // Optional-only residual: remaining work is all optional steps whose material is
      // absent — nothing failed, nothing deferred. Marked done for the run so the build
      // completes at the shell; re-derived once the material arrives (bounded by the
      // exclusion set being measured each sweep, job_exclusions).
      if (!madeProgress && outcome.deferred === 0 && (outcome.dig_fail + outcome.place_fail) === 0 && outcome.skipped > 0) {
        anchorStuck.add(outcome.anchorIndex);
        watcher.summary('build_executor', `A${outcome.anchorIndex} optional-only (${outcome.skipped} skipped, material absent) — done for this run; build proceeds without decoration`);
      }

      const iterSummary = `${lastBuildingName} A${outcome.anchorIndex} stationary: dig=${outcome.dig_ok} place=${outcome.place_ok} fail=${outcome.dig_fail + outcome.place_fail} deferred=${outcome.deferred} | ${allSteps.length} steps remaining`;
      watcher.summary('build_executor', iterSummary);

      const pjOk = await portableJudge.checkpoint('build_executor', iterSummary, 'strict');
      if (pjOk === false) {
        // Stall — dumps the buffered per-block trace (every dig/place decision, ref,
        // reach, outcome) so the trace reader sees exactly what the bot was attempting.
        watcher.error('build_executor', `portable_judge escalated on A${outcome.anchorIndex}: ${iterSummary}`);
        exitReason = 'portable_judge_escalated';
        break;
      }

      await combatCheckpoint(bot, 'build');
    }

    // Executor is leaving the anchor either way — release the object lock so
    // peers can enter/build it (a re-dispatch re-claims).
    if (heldAnchorClaimKey) {
      foremanLink.releaseClaim(heldAnchorClaimKey);
      heldAnchorClaimKey = null;
    }
    // Same act, one level down: a body leaving a pledge-approved plan hands its cells back
    // so peers can take them (Law 8). The foreman's magnet-clear sweep is the backstop.
    releaseHeldCells();

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
    // job_board dispatches partial anchors, so two passes that each place three blocks would
    // read identically on place_ok alone. The per-anchor voxel remainder separates them — it
    // falls on real progress and repeats only on a genuine stall. @lastscan names the instant
    // the count is taken, since a later exit's placements lag the scan by one pass.
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

    routeToJudge('build_executor', { ...payload, readable: capsule.readable });
  })
};
