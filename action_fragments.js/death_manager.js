// fragment: death_manager (action / death recovery) — the MANAGER seat for coming back from a death.
//
// ── THE SEAT ───────────────────────────────────────────────────────────────────────────────────────────
// Law 11's Manager: it takes the diff (there is no body / the body is in the wrong place), produces an
// ORDERED action plan, and VERIFIES each result. That verification is what makes this a manager and not a
// one-shot executor — it is the same discipline eat_manager runs, and it earns the name the same way:
//   ACT 1  spawn    — click respawn, then SENSE whether a body came back.
//   ACT 2  teleport — put the body on the recovery point, then SENSE whether it actually moved.
// Neither act trusts its own command. A respawn packet accepted is not a body; an RCON `tp` returning
// cleanly is not an arrival (Law 26 — a machine's truth guarantee holds only for what actually ran, and
// what ran here is the SERVER, so the outcome is read, never assumed; Law 25 — the verdict this fragment
// reports is measured against "is the bot standing where it was asked to be", not "did I send the two
// commands").
//
// It delegates to no executor, and that is deliberate rather than an omission: each act is a single
// command whose entire substance is the verification around it. An executor per packet would be a
// fragment that forwards one string and reports what it cannot check (Law 0 — that is not a second verb,
// it is half of this one).
//
// ── HOW IT TELEPORTS ────────────────────────────────────────────────────────────────────────────────────
// It is not a mineflayer client command — a plain client has no console. The fleet has RCON:
// `js_kernel/utils/rcon_link` is the ONE shared
// implementation (camera_rig, fleet_control, lanista and the probes all reach it — Law 16, consolidated
// from three copies), it reads the local `server.properties`, and any process on this box can open a
// session. So the bot cannot teleport ITSELF as a client, and the fleet can teleport it as an operator.
//
// NO WALK FALLBACK, on purpose. An earlier draft walked home with goToStand when the teleport was
// unavailable, and that is precisely the fallback Law 16 forbids: a second route that silently does the
// primary's job, reached exactly when nobody is watching. A teleport that cannot happen is reported as a
// failure and the judge replans from where the body actually is.
//
// ── THE RECOVERY POINT — TWO LADDERS, ONE PER SPECIES ─────────────────────────────────────────────────
// Only the DESTINATION is species-dependent. ACT 1 is identical (a corpse is a corpse, and master_core
// runs with respawn:false either way) and ACT 2 is identical (a cell goes in, an arrival is sensed), so
// the branch lives in recoveryPoint and nowhere else. A second death manager for contractors would be
// Law 16's forbidden parallel route: same two acts, same verification, a different table.
// A CONTRACTOR'S LADDER IS IN recoveryPoint ITSELF — its own sited house, then the human who summoned it,
// then world spawn. The estate's three tiers below are the HOMESTEADER'S, every one anchored on the
// headframe.
//
// ACT 1 IS ALSO CALLABLE ON ITS OWN, as `reviveBody`. A body that died and was stopped comes back as a
// corpse whose spawn gate the client library consumes without firing, so nothing hung off `spawn` runs
// and the process never registers — a state the death SIGNAL cannot reach, because reaching it requires
// the registration that did not happen. The revive therefore has to be available at the login edge,
// before any signal or command exists.
//
// ── THE HOMESTEADER'S RECOVERY POINT — THREE TIERS ────────────────────────────────────────────────────
//   1. ANCHOR 0 of the headframe. Safety is INHERITED, not re-derived: building_integrity already
//      checks the blueprint against the world, so an anchor 0 that owes no work is a floor that exists.
//      A second safety opinion here would be a redundant pathway (Law 16) that could disagree with the
//      one the builder trusts.
//   2. A `spawn_spot` site near the headframe. That blueprint is FOUND, NEVER BUILT — a one-column
//      predicate (a standable floor cell with three clear above), which is exactly "somewhere a body
//      fits". find_buildingspot.locate is the production scan engine for that question and was extracted
//      to run from an arbitrary origin, so the origin is the headframe centre. NOT lanista's arena_sites:
//      that is a tool reached over RCON, and a fragment reaching into it would cross the tool/production
//      boundary to get a scan production already owns.
//   3. Nothing sited → no teleport. Vanilla already puts the bot at world spawn.
//
// THE +1 IS APPLIED ONCE, HERE, AND IT IS THE SAME +1 FOR BOTH TIERS. Every tier returns the FLOOR block
// and the feet go one above it: the headframe's anchor 0 sits at relative [-4,1,0] with the voxel above it
// authored `air`, and spawn_spot declares one natural_block floor with three clear layers over it. An
// RCON `tp` places the entity's FEET at the y it is given, so the offset cannot be implicit the way it was
// when this walked with goToStand ("stand ON this anchor" carried it). Read from the blueprints rather
// than restated as a constant — an anchor that moves in the blueprint moves here with it.
//
// ── WHY THE DESTINATION IS DECIDED HERE AND NOT ON THE BOARD ─────────────────────────────────────────
// job_board's sweep is synchronous and runs while the bot is still a CORPSE. Tier 2's scan is async, and
// every tier reads world state that only means something once there is a body to read it from (Invariant B
// — a destination computed from the death position is remembered state by the time it is used). The board
// owns WHETHER a recovery happens and that it outranks everything; this owns WHERE and HOW.

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

// THE TWO ACTS AND THE PREDICATE ARE NOT WRITTEN HERE. They are `js_kernel/body_recovery`, shared with
// every other place a body is stood up — a natural death (this file), a continue's preflight, a launch
// onto dead playerdata, and a human's `foreman get` landing on a corpse. They used to be written twice,
// and the two copies disagreed about whether a respawn click may be sent before the first health packet
// arrives; one of them was right and the difference was invisible from inside either (Law 16, and the
// Architect's ruling that every situation standing a body up runs identical logic).
//
// WHAT STAYS HERE IS THE POLICY: where a recovered body GOES. That is two ladders, one per species, and
// it is the part that is genuinely this seat's.
const recovery = require('@kernel/body_recovery');
const { isDead, reviveBody, teleportTo, anchorZeroPoint, ARRIVAL_TOLERANCE } = recovery;

// anchorZeroBuilt(bot, blueprintName, field) → does anchor 0 owe any work?
// Safety is inherited, not re-derived: an anchor with nothing left to place and
// nothing left to dig is a floor that is actually there. An absent or unreadable anchor 0 returns false —
// default stopped (Law 13), which drops to tier 2 rather than teleporting onto an unverified cell. That
// default covers a MISSING answer, never a BROKEN scan: building_integrity is ours, so a throw out of it is
// a defect, and translating it into "anchor 0 is unavailable" would send every death to world spawn while
// the log read like an ordinary tier fallthrough.
function anchorZeroBuilt(bot, blueprintName, field) {
  const buildingIntegrity = require('@perception/building_integrity');
  const scan = buildingIntegrity.scan(bot, blueprintName, field);
  if (scan.all_complete === true) return true;
  const a0 = Array.isArray(scan.anchor_status) ? scan.anchor_status.find((a) => a.anchor_index === 0) : null;
  if (!a0) return false;
  return a0.place_count === 0 && a0.dig_count === 0;
}

// recoveryPoint(bot) → { kind, at, why }.
//
// `at` is the FEET cell (the floor block's y already +1) so the caller teleports to it verbatim, and it is
// null for the world-spawn tier — which is not a failure but the third tier arriving at "stay put". Named
// rather than returned as a bare null, because a tier that can only say "no" carries no information
// (Law 25).
async function recoveryPoint(bot) {
  const { readBuildCenter } = require('@utils/fragment_utils');

  // ── THE CONTRACTOR'S LADDER — ITS OWN HOUSE, FIRST AND ALWAYS ─────────────────────────────────
  // Two rungs, and the estate's three do not apply: a contractor may never see a headframe, and a
  // spawn_spot scan around one it has no relationship to would send it home to a stranger's base.
  //
  // THE LOCKED SITE IS THE HOME, NOT THE BUILT HOUSE. The Architect's ruling — *"as soon as it locks in
  // a place then it will always teleport there after death, weather its built or not."* The site is the
  // fact; the structure is work in progress on top of it. Waiting for `all_complete` would mean the
  // recovery point does not exist during exactly the stretch a contractor is most likely to die — out
  // gathering the material for its own walls — and would then flip from world spawn to the house on the
  // day the last block went in, which is a destination nobody could predict from the outside.
  //
  // AND ITS SAFETY IS INHERITED, not re-derived. A locked build_center passed find_buildingspot's siting
  // predicate: flat, clear, standable ground with nothing overhead. That is the same discipline the
  // headframe tier runs on (an anchor owing no work is a floor that exists), so no second opinion is
  // taken here — one would be a redundant pathway able to disagree with the siter (Law 16).
  //
  // THE HOUSE OUTRANKS THE OWNER, AND THE OWNER OUTRANKS NOTHING AT ALL. A person is a moving
  // destination: a death beside them and a death an hour later land in different worlds, so once a fixed
  // address exists the fixed address wins — the human can walk to it and the body can always find it.
  //
  // But BEFORE a house is sited there is no fixed address, and the rung below is not "nowhere". A
  // contractor exists because a particular person asked for one, so the person is the only home it has
  // yet; dropping it at vanilla world spawn strands a body the length of the map from the human who
  // summoned it, for the whole window between birth and the first completed layout survey. A moving
  // destination beats no destination — the objection above is an argument for ranking the house first,
  // never for leaving the gap beneath it empty.
  //
  // Read live rather than remembered: where the owner WAS at birth is exactly the stale answer this
  // ladder exists to avoid (Invariant B). An unreachable read falls to world spawn — a homing point that
  // cannot be sensed is not a homing point, and the bench runs with no server at all.
  if (require('@kernel/bot_mandate').isContractor()) {
    const house = readBuildCenter('contractor_house');
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
    return {
      kind: 'world_spawn',
      at: null,
      why: `no contractor house is sited yet and ${owner} could not be located (${read.ok ? 'not in the world' : read.reason}) — nothing to come back to`,
    };
  }

  const buildCenter = readBuildCenter('headframe');
  if (!buildCenter || typeof buildCenter.x !== 'number') {
    return { kind: 'world_spawn', at: null, why: 'no headframe centre is locked — nothing is sited yet, so vanilla world spawn is the plan' };
  }

  // ── TIER 1 ──
  if (anchorZeroBuilt(bot, 'headframe', 'headframe')) {
    const floor = anchorZeroPoint('headframe', buildCenter);
    if (floor) {
      return {
        kind: 'anchor_0',
        at: { x: floor.x, y: floor.y + 1, z: floor.z },
        why: `headframe anchor 0 owes no work, so its floor at (${floor.x},${floor.y},${floor.z}) exists — standing one above it`,
      };
    }
    watcher.warn(TAG, 'headframe anchor 0 is complete but the blueprint declares no anchor position — falling to the spawn_spot scan.');
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
      origin: buildCenter,
      requireShaft: false,
      requireDirtGround: false,
      existingFootprints: findSpot.getExistingFootprints(),
    });
    if (result && result.found && result.candidate) {
      const d = result.distFromOrigin;
      if (typeof d === 'number' && d > SPAWN_SPOT_MAX_DISTANCE) {
        return { kind: 'world_spawn', at: null, why: `nearest spawn_spot is ${Math.round(d)}b from the headframe, past the ${SPAWN_SPOT_MAX_DISTANCE}b recovery radius — that is a second base, not a way home` };
      }
      // A candidate's position is `build_center`, NOT bare x/y/z on the candidate itself — see
      // find_buildingspot.makeCandidate, which is the one place that shape is authored.
      //
      // A missing field here reads as undefined, and an offset applied to it reads as NaN — the fragment
      // would dutifully issue a `tp` with non-finite coordinates, which the server refuses, so the body
      // never moves and the failure surfaces as an arrival timeout, a message describing a slow teleport
      // rather than a malformed one. Law 13: a missing field is never defaulted — it is validated before
      // it is used.
      const c = result.candidate && result.candidate.build_center;
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) {
        // Not a throw: the scan is an environmental read and a candidate that cannot be expressed as a
        // cell is a world fact, not a coding fault. It drops to the tier below with the reason intact.
        watcher.warn(TAG, `spawn_spot scan returned a candidate with no usable build_center (${JSON.stringify(result.candidate)}) — falling to world spawn rather than teleporting to a cell that does not exist.`);
        return { kind: 'world_spawn', at: null, why: 'the spawn_spot candidate carried no usable position — staying where vanilla put the body' };
      }
      return {
        kind: 'spawn_spot',
        at: { x: c.x, y: c.y + 1, z: c.z },
        why: `headframe anchor 0 is not built, so the nearest spawn_spot${typeof d === 'number' ? ` (${Math.round(d)}b out)` : ''} is the recovery point`,
      };
    }
    return { kind: 'world_spawn', at: null, why: `no spawn_spot site found near the headframe (${result?.reason || 'unknown'}) — staying where vanilla put the body` };
  }
}

// teleportTo(bot, at) → { moved, from, to, error }. ACT 2, command plus its verification.
//
// The `tp` goes through js_kernel/utils/rcon_link's `once` (open, run, close) rather than a held session: this fires
// at most once per death, so a persistent link would be a socket kept alive for an event that may not
// happen for an hour (Law 8 — nothing runs on past the lifecycle that raised it).
//
// THE VERIFY IS A POSITION READ, NEVER THE COMMAND'S REPLY. RCON answers with the server's own text, which
// says a command was executed, not that this bot's body is standing anywhere in particular — and the
// client learns its new position from a separate packet that arrives later. So the arrival is sensed off
// bot.entity.position, which is the only thing that can disagree with a lie (Law 26).
// reviveBody — CLICK RESPAWN AND SENSE WHETHER A BODY CAME BACK. Returns; never routes, never throws
// upward on a failed revive.
//
// EXTRACTED FROM THE DEATH SIGNAL SO A BODY CAN BE STOOD UP WITH NO SIGNAL IN FLIGHT. A bot that died
// and was stopped is written to disk as a corpse, and on the next login mineflayer's health plugin
// consumes the one-shot spawn gate without firing it — so every handler hung off `spawn` never runs and
// the process joins the world without registering. The death signal cannot fix that, because reaching
// the signal requires the registration that never happened. The revive therefore has to be callable
// from the login edge, before any command exists to carry it.
//
// RETURNS RATHER THAN ABANDONING (Law 15/Law 25). Inside the signal chain a failed revive belongs to the
// judge; on the login edge there is no chain to abandon and no judge listening yet, so the verdict goes
// back to whoever asked and they decide. Same act, two callers, one honest answer.
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
    // master_core runs with `respawn: false`, so NOTHING else sends this packet. That gating is what makes
    // a death a hard stop: a corpse cannot walk, mine or place, so the chain that was running when the bot
    // died is inert by physics rather than by a check arriving in time (Law 13, default-stopped).
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
    // (The out-loud voice used to forget its last sentence here, so the first thing said after a death
    // was news again. `bot_voice` is deleted — a contractor no longer narrates at all, and a human who
    // wants to know says `foreman where`. See THE BOT DOES NOT SPEAK in Thinking_fragments/dispatcher.js.)

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
