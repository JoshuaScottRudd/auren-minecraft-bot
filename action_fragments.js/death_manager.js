// fragment: death_manager (action / death recovery) — the MANAGER seat for coming back from a death.
//
// Law 11's Manager: takes the diff (no body, or the body is in the wrong place), produces an ordered
// action plan, and verifies each result — the same discipline eat_manager runs.
//   ACT 1  spawn    — click respawn, then sense whether a body came back.
//   ACT 2  teleport — put the body on the recovery point, then sense whether it actually moved.
// Neither act trusts its own command. A respawn packet accepted is not a body; an RCON `tp` returning
// cleanly is not an arrival (Law 26 — the outcome is read off the server, never assumed; Law 25 — the
// verdict is measured against where the bot is standing, not which commands were sent).
//
// Delegates to no executor: each act is a single command whose entire substance is the verification
// around it (Law 0 — an executor per packet would forward one string and report what it cannot check).
//
// Teleport goes through RCON (`js_kernel/utils/rcon_link`, the one shared implementation — Law 16), since
// a plain client has no console and cannot teleport itself. No walk fallback: a teleport that cannot
// happen is reported as a failure and the judge replans from where the body actually is.
//
// Only the destination is species-dependent; both acts are identical for every species, so the branch
// lives in recoveryPoint alone. A contractor's ladder is its own sited house, then the human who summoned
// it, then world spawn. The homesteader's ladder is the three tiers below, every one anchored on the
// headframe.
//
// ACT 1 is also callable on its own, as `reviveBody`: a body that died and was stopped comes back as a
// corpse whose spawn gate the client library consumes without firing, so the death signal never reaches
// it. The revive is therefore available at the login edge, before any signal or command exists.
//
// The homesteader's recovery point, three tiers:
//   1. Anchor 0 of the headframe. Safety is inherited: building_integrity already checks the blueprint
//      against the world, so an anchor 0 that owes no work is a floor that exists.
//   2. A `spawn_spot` site near the headframe, found (never built) by find_buildingspot.locate — the
//      fleet's one production site scan — from an origin at the headframe centre.
//   3. Nothing sited → the body stays where vanilla put it, unless that is inside the spawn-protected
//      square, in which case leaving the square is the recovery (`noHome` below).
//
// The feet land one block above the tier's floor block, applied once, here: an RCON `tp` places the
// entity's feet at the y it is given, and each tier's floor position is read live from the blueprint,
// never restated as a constant, so a moved anchor moves the recovery point with it.
//
// The destination belongs here: the board offers recovery while the bot is still a corpse,
// and every tier reads world state that only means
// something once there is a body to read it from (Invariant B). The board owns whether a recovery
// happens; this owns where and how.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'death_manager';

// How far from the headframe centre a spawn_spot may sit and still count as "around the area of the
// headframe". Past this the site stops being a recovery point and becomes a second base. locate() is
// uncapped by design (the loaded frontier is its only terminator), so the cap belongs here, at the policy
// layer that asked for the scan.
const SPAWN_SPOT_MAX_DISTANCE = 48;

// The two acts and the predicate are shared with every other place a body is stood up
// (`js_kernel/body_recovery`): a natural death (this file), a continue's preflight, a launch onto dead
// playerdata, and a human's `foreman get` landing on a corpse (Law 16 — one definition of standing a body
// up).
//
// What stays here is the policy: where a recovered body goes. That is two ladders, one per species.
const recovery = require('@kernel/body_recovery');
const { isDead, reviveBody, teleportTo, anchorZeroPoint, ARRIVAL_TOLERANCE } = recovery;

// ── THE THIRD TIER LEAVES THE SPAWN-PROTECTED SQUARE, NOT JUST "STAY PUT" ────────────────────────────
// A vanilla respawn with no bed lands at world spawn, the centre of the one square where this fleet can
// neither break nor place. The desk refuses to launch a crew within PERSON_CLEAR_OF_SPAWN of world spawn
// (foreman.js); this tier holds the same clearance on the way back from a death, measured by the same
// module.
//
// The site is found, never assumed: find_buildingspot.locate is the fleet's one site scan and already
// refuses a footprint touching the square, so whether somewhere a body fits, clear of spawn, is asked of
// the production scanner from an origin outside the square (Law 16). When it finds nothing the body stays
// put, and the verdict says it is standing in the square (Law 25), instead of reading like an ordinary
// fallthrough.
const { isSpawnProtectedAt, worldSpawnPoint, chebyshevFromWorldSpawn } = require('@perception/spawn_protection');
const { PERSON_CLEAR_OF_SPAWN } = require('@thinking/architect_config');

// How far past the clearance the search ORIGIN is set. The scan grows outward from its origin, so an origin
// sitting exactly on the line returns candidates on both sides of it and half of them fail the clearance
// test below for the sake of a block or two.
const CLEAR_SEARCH_MARGIN = 8;

// anchorZeroBuilt(bot, blueprintName, field) → does anchor 0 owe any work?
// Safety is inherited, not re-derived: an anchor with nothing left to place and nothing left to dig is a
// floor that is actually there. An absent or unreadable anchor 0 returns false — default stopped (Law 13):
// drops to tier 2, never onto an unverified cell. Covers only a missing answer, never a broken scan:
// building_integrity is ours, so a throw out of it is a defect, not a tier fallthrough.
async function anchorZeroBuilt(bot, blueprintName, field) {
  const buildingIntegrity = require('@perception/building_integrity');
  const scan = await buildingIntegrity.scan(bot, blueprintName, field);
  if (scan.all_complete === true) return true;
  const a0 = Array.isArray(scan.anchor_status) ? scan.anchor_status.find((a) => a.anchor_index === 0) : null;
  if (!a0) return false;
  return a0.place_count === 0 && a0.dig_count === 0;
}

// noHome(bot, why) → the third tier, which is "leave the square" when the body is standing in it and
// "stay put" when it is not. EVERY world-spawn return in the ladder below goes through here, because every
// one of them means the same thing — this crew has nowhere to come back to — and the body's position is the
// only thing that decides whether that is a problem. Async because finding the site is a scan.
async function noHome(bot, why) {
  const here = bot?.entity?.position;
  if (!isSpawnProtectedAt(bot, here)) return { kind: 'world_spawn', at: null, why };

  const spawnAt = worldSpawnPoint(bot);
  if (!spawnAt) {
    return { kind: 'world_spawn', at: null, why: `${why} — and the body is at a world spawn this fleet cannot locate, so no clearance can be measured` };
  }
  const findSpot = require('@action/find_buildingspot.js');
  const { building, dims } = findSpot.loadBlueprintDims('spawn_spot');
  const reach = PERSON_CLEAR_OF_SPAWN + CLEAR_SEARCH_MARGIN;
  const result = await findSpot.locate(bot, {
    blueprintName: 'spawn_spot',
    building,
    dims,
    origin: { x: spawnAt.x + reach, y: Math.floor(here.y), z: spawnAt.z },
    requireShaft: false,
    requireDirtGround: false,
    existingFootprints: findSpot.getExistingFootprints(),
  });
  const c = result && result.found && result.candidate && result.candidate.transpose_origin;
  if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) {
    return { kind: 'world_spawn', at: null, why: `${why}, AND THE BODY IS STANDING IN THE SPAWN-PROTECTED SQUARE — no clear site was found to move it to (${result?.reason || 'no candidate'}), so every dig and placement it attempts from here will be refused` };
  }
  const out = chebyshevFromWorldSpawn(bot, c);
  if (out < PERSON_CLEAR_OF_SPAWN) {
    return { kind: 'world_spawn', at: null, why: `${why}, AND THE BODY IS STANDING IN THE SPAWN-PROTECTED SQUARE — the nearest site found is only ${out}b out, inside the ${PERSON_CLEAR_OF_SPAWN}b clearance` };
  }
  return {
    kind: 'clear_of_spawn',
    at: { x: c.x, y: c.y + 1, z: c.z },
    why: `${why}; the respawn put the body inside the spawn-protected square, so leaving it comes before any work — this site is ${out}b out, past the ${PERSON_CLEAR_OF_SPAWN}b clearance the desk requires of a person`,
  };
}

// recoveryPoint(bot) → { kind, at, why }.
//
// `at` is the feet cell (the floor block's y already +1); null for the world-spawn tier, which is the
// third tier arriving at "stay put", not a failure. Named instead of a bare null so a tier that can only
// say "no" still carries a reason (Law 25).
async function recoveryPoint(bot) {
  const { readTransposeOrigin } = require('@utils/fragment_utils');

  // ── THE CONTRACTOR'S LADDER — ITS OWN HOUSE, FIRST AND ALWAYS ─────────────────────────────────
  // Two rungs; the estate's three do not apply, since a contractor may never see a headframe. The locked
  // site is the home, not the built house: the site is the fact, and the structure is work in progress on
  // top of it. Its safety is inherited from find_buildingspot's siting predicate (flat, clear, standable
  // ground with nothing overhead), the same discipline the headframe tier runs on, so no second opinion is
  // taken here (Law 16).
  //
  // The house outranks the owner, and the owner outranks nothing at all: once a fixed address exists it
  // wins, since a person is a moving destination and the house is not. Before a house is sited, the person
  // who asked for the contractor is its only home. Read live, not the position remembered from birth
  // (Invariant B — a stale owner position is exactly what this ladder avoids). An unreachable read falls
  // to world spawn.
  if (require('@kernel/bot_mandate').isContractor()) {
    const house = readTransposeOrigin('contractor_house');
    if (house && typeof house.x === 'number') {
      return {
        kind: 'contractor_house',
        at: { x: house.x, y: house.y + 1, z: house.z },
        why: `its own house is sited at (${house.x},${house.y},${house.z}) — home whether or not it is built yet`,
      };
    }
    const owner = require('@kernel/bot_mandate').currentOwner();
    const read = await guardExternal(TAG, `rcon read of ${owner}'s position`,
      () => require('../js_kernel/utils/rcon_link').entityPos(owner));
    if (read.ok && read.value) {
      return {
        kind: 'owner',
        at: read.value,
        why: `no house is sited yet, so home is ${owner} — standing where they stand, which is ground a person is already occupying`,
      };
    }
    return noHome(bot, `no contractor house is sited yet and ${owner} could not be located (${read.ok ? 'not in the world' : read.reason}) — nothing to come back to`);
  }

  // THIS CREW'S OWN HOME — 'headframe' was hardcoded here, and the branch above already peels off the
  // CONTRACTOR by species, so a BUILDER fell straight through to a structure it never raises: no centre
  // locked, no tier 1, `noHome` on every death for the whole run. `homeBlueprint()` answers for all three
  // species from the one tuple, and the message now names whichever home was actually missing (Law 16).
  const home = require('@kernel/bot_mandate').homeBlueprint();
  const transposeOrigin = readTransposeOrigin(home);
  if (!transposeOrigin || typeof transposeOrigin.x !== 'number') {
    return noHome(bot, `no ${home} centre is locked — nothing is sited yet`);
  }

  // ── TIER 1 ──
  if (await anchorZeroBuilt(bot, home, home)) {
    const floor = anchorZeroPoint(home, transposeOrigin);
    if (floor) {
      return {
        kind: 'anchor_0',
        at: { x: floor.x, y: floor.y + 1, z: floor.z },
        why: `${home} anchor 0 owes no work, so its floor at (${floor.x},${floor.y},${floor.z}) exists — standing one above it`,
      };
    }
    watcher.warn(TAG, `${home} anchor 0 is complete but the blueprint declares no anchor position — falling to the spawn_spot scan.`);
  }

  // ── TIER 2 ──
  // Unguarded: find_buildingspot is ours and already answers a fruitless search with `found: false`, which
  // the tail below turns into the world_spawn fallback. A throw on top of that is a defect, and catching it
  // would make every recovery land at world spawn while the reason read as an ordinary empty scan.
  {
    const findSpot = require('@action/find_buildingspot.js');
    const { building, dims } = findSpot.loadBlueprintDims('spawn_spot');
    const result = await findSpot.locate(bot, {
      blueprintName: 'spawn_spot',
      building,
      dims,
      origin: transposeOrigin,
      requireShaft: false,
      requireDirtGround: false,
      existingFootprints: findSpot.getExistingFootprints(),
    });
    if (result && result.found && result.candidate) {
      const d = result.distFromOrigin;
      if (typeof d === 'number' && d > SPAWN_SPOT_MAX_DISTANCE) {
        return noHome(bot, `nearest spawn_spot is ${Math.round(d)}b from the headframe, past the ${SPAWN_SPOT_MAX_DISTANCE}b recovery radius — that is a second base, not a way home`);
      }
      // A candidate's position is `transpose_origin`, not bare x/y/z on the candidate itself — see
      // find_buildingspot.makeCandidate, which is the one place that shape is authored.
      //
      // A missing field here reads as undefined, and an offset applied to it reads as NaN: the fragment
      // would issue a `tp` with non-finite coordinates, which the server refuses, so the failure surfaces
      // as an arrival timeout. Law 13: a missing field is never defaulted — it is validated before use.
      const c = result.candidate && result.candidate.transpose_origin;
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) {
        // Not a throw: the scan is an environmental read and a candidate that cannot be expressed as a
        // cell is a world fact, not a coding fault. It drops to the tier below with the reason intact.
        watcher.warn(TAG, `spawn_spot scan returned a candidate with no usable transpose_origin (${JSON.stringify(result.candidate)}) — falling to world spawn rather than teleporting to a cell that does not exist.`);
        return noHome(bot, 'the spawn_spot candidate carried no usable position');
      }
      return {
        kind: 'spawn_spot',
        at: { x: c.x, y: c.y + 1, z: c.z },
        why: `headframe anchor 0 is not built, so the nearest spawn_spot${typeof d === 'number' ? ` (${Math.round(d)}b out)` : ''} is the recovery point`,
      };
    }
    return noHome(bot, `no spawn_spot site found near the headframe (${result?.reason || 'unknown'})`);
  }
}

// teleportTo(bot, at) → { moved, from, to, error }. ACT 2, command plus its verification.
//
// The `tp` goes through js_kernel/utils/rcon_link's `once` (open, run, close), not a held session: this
// fires at most once per death, so a persistent link would be a socket kept alive for an event that may
// not happen for an hour (Law 8 — nothing runs on past the lifecycle that raised it).
//
// The verify is a position read, never the command's reply: RCON answers with the server's own text,
// which says a command was executed, not that this body is standing anywhere in particular, and the
// client learns its new position from a separate packet that arrives later. The arrival is sensed off
// bot.entity.position, the only thing that can disagree with a lie (Law 26).
// reviveBody — click respawn and sense whether a body came back. Returns; never routes, never throws
// upward on a failed revive.
//
// Extracted from the death signal so a body can be stood up with no signal in flight: a bot that died and
// was stopped is written to disk as a corpse, and on the next login mineflayer's health plugin consumes
// the one-shot spawn gate without firing it, so every handler hung off `spawn` never runs and the process
// joins the world without registering. The revive is callable from the login edge, before any command
// exists to carry it.
//
// Returns instead of routing (Law 15/Law 25): inside the signal chain a failed revive belongs to the
// judge; on the login edge there is no chain to abandon and no judge listening yet, so the verdict goes
// back to whoever asked. Same act, two callers, one honest answer.
module.exports = {
  // Exported so job_board's planner shares this fragment's definition of dead, and so a bench can drive
  // the decision without a death (Law 16 — one definition of "no body" and one of "where home is").
  isDead,
  reviveBody,
  recoveryPoint,
  anchorZeroPoint,
  anchorZeroBuilt,
  teleportTo,
  SPAWN_SPOT_MAX_DISTANCE,
  ARRIVAL_TOLERANCE,

  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before death recovery ran.`);

    const finish = (readable) => {
      watcher.summary(TAG, readable);
      const capsule = payload[TAG] || (payload[TAG] = {});
      capsule.readable = readable;
      return routeToJudge(TAG, { ...payload, readable });
    };

    // ── ACT 1: SPAWN ────────────────────────────────────────────────────────────────────────────────
    // master_core runs with `respawn: false`, so nothing else sends this packet. That gating is what makes
    // a death a hard stop: a corpse cannot walk, mine or place, so the chain that was running when the bot
    // died is inert by physics, not by a check arriving in time (Law 13, default-stopped).
    const revival = await reviveBody(bot);
    if (revival.wasDead && !revival.revived) {
      // The one state this design can strand the fleet in, and it gets the error level for that reason:
      // with respawn:false nothing else sends the packet, so a click that does not take leaves a bot
      // that will fail every job it is ever given. Routed to the judge anyway — the next board sweep
      // re-posts this same job, and that re-post is the only retry that exists.
      watcher.error(TAG, `ACT 1 FAILED: ${revival.why}. The next board sweep re-posts this job, which is the only retry there is.`);
      return finish(`${TAG}: respawn did not take — still dead, replanning`);
    }

    const spawnedAt = bot.entity.position.floored();
    watcher.summary(TAG, `ACT 1 ✓ body is back at (${spawnedAt.x},${spawnedAt.y},${spawnedAt.z}) — choosing a recovery point.`);

    // ── ACT 2: TELEPORT ─────────────────────────────────────────────────────────────────────────────
    const point = await recoveryPoint(bot);
    if (!point.at) return finish(`${TAG}: respawned at (${spawnedAt.x},${spawnedAt.y},${spawnedAt.z}) — ${point.why}`);

    watcher.summary(TAG, `ACT 2 → ${point.kind} at (${point.at.x},${point.at.y},${point.at.z}) — ${point.why}.`);
    const tp = await teleportTo(bot, point.at);
    if (!tp.moved) {
      // Environmental (Law 13) and reported as the shortfall it is (Law 25): the bot is ALIVE, which was
      // ACT 1's objective, and it is in the wrong place, which was ACT 2's. Both halves go in the verdict
      // — a manager that reported "recovered" here would be certifying an arrival it just failed to sense.
      const now = bot.entity.position.floored();
      return finish(`${TAG}: respawned but the teleport to ${point.kind} FAILED (${tp.error}) — alive at (${now.x},${now.y},${now.z}), replanning from there`);
    }

    const now = bot.entity.position.floored();
    return finish(`${TAG}: recovered to ${point.kind} at (${now.x},${now.y},${now.z}) — ${point.why}`);
  }),
};
