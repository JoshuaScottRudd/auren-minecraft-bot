// fragment: idle_park — when the dispatcher has no job for this bot, moves it OUT of the build
// footprint and waits.
//
// Parks at a blueprint's FIRST anchor standing cell (anchor.y + 1) — the vantage the builder itself
// stands in, so that cell is never a block to be placed (Law 19: the placement constraint binds every
// agent). WHICH blueprint is decided by bot_mandate.homeBlueprint() — see SHELTER below.
//
// As its LAST act it arms the idle re-check heartbeat (idle_scheduler) and terminates the chain, routing
// nowhere. Arming AFTER goTo returns keeps Law 4 intact: no signal is live when the heartbeat later
// fires.
//
// Law 15: calls locomotion goTo (a sub-loop API that owns its own movement abandonment); adds no
// movement retry of its own, and arms the heartbeat regardless of whether the park succeeded, so a
// failed park never leaves the bot permanently asleep.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const buildingIntegrity = require('@perception/building_integrity');
const hq = require('@kernel/corporate_headquarters');
const idleScheduler = require('@kernel/idle_scheduler');
const { classifyFloor } = require('@utils/movement/terrain_predicates');

const TAG = 'idle_park';
// ── WHERE A BODY IDLES IS ITS SPECIES' OWN HOME ──
// The tuple is `architect_config.ALPHA_STRUCTURE`; `bot_mandate.homeBlueprint()` is the one call that
// reads it — the same call `fragment_utils.homeChest` uses to find the crew's own chest (Law 16).
function _homeBlueprint() { return require('@kernel/bot_mandate').homeBlueprint(); }

// THE PARK VANTAGE IS THE SAME ARITHMETIC FOR EVERY SPECIES: `anchor.y + 1` is the cell the builder
// itself stands in, so it is never a block to be placed. On a contractor's house that cell is inside an
// enclosed, lit room; on a headframe or a laydown yard it is open ground — the honest difference between
// the three homes.
//
// THE FLOOR IS THE ADMISSION TEST, NOT THE FINISHED BUILDING: the question is whether there is a cell of
// this house a body can stand in, not whether the building is complete. Anchor 0 lays the ground floor
// and its stations first, so a house minutes from complete already has a real floor with real air above
// it.
//
// A LOCKED CENTRE IS NOT ENOUGH: a reservation is a claim over ground that may be open air, and standing
// in an unbuilt footprint is the exact fault this fragment exists to prevent. The park depends on whether
// the world holds a body-sized cell here now.

// This body's park anchor, or null. SENSED EVERY TIME, never remembered: a building can be taken apart
// by the world between one idle tick and the next, and a remembered "yes" would park a body in a ruin
// (Invariant B).
//
// TWO BLOCK READS: this runs on the idle heartbeat, about once a second per idle bot, so answering "can a
// body stand on this one cell" stays cheap regardless of blueprint size.
//
// classifyFloor IS THE STANDABILITY DEFINITION (Law 16): the same predicate the navigator's goal test and
// the station placer use, so "a body can stand here" means one thing across files. Non-null = a safe
// surface with headroom above it — that IS the anchor being available to stand on. Air (an unbuilt floor)
// reads null with no separate check.
//
// Unsited reads as no shelter without provoking getWorldAnchors' coding violation: the chair is the same
// source getWorldAnchors reads, so this asks the question before calling it (Law 16).
function _homeAnchor(bot, home) {
  const spot = hq.readBuildingChair(home, 'set_buildspot');
  if (!spot?.transpose_origin || typeof spot.transpose_origin.x !== 'number') return null;
  const anchors = buildingIntegrity.getWorldAnchors(home, home);
  const anchor = anchors && anchors[0];
  if (!anchor) return null;
  // Home out of sight is still home: a body too far off to read the floor walks back to it.
  const floor = bot.blockAt(new Vec3(anchor.x, anchor.y, anchor.z));
  return (!floor || classifyFloor(bot, floor)) ? anchor : null;
}

// WHY THE PARK LINE NAMES WHICH IDLE CAUSE THIS IS. Every reason a bot idles produces the same picture —
// a body standing at the vantage with no magnet — but a fleet out of work is FINISHED while a fleet held
// at the gates is WAITING and will move again on its own. This is the line a reader stops at, so a park
// that says only "idle" loses the one bit that distinguishes done from stuck (Law 25).
//
// READ FROM THE PAYLOAD, NEVER RE-DERIVED: the dispatcher owns this pass's decision (Invariant D);
// re-reading the board here would be a second answer free to disagree with the line already printed, and
// it would read a board that may have been swept again since (Law 16).
//
// A ROUTE THAT NAMES NO CAUSE STILL PARKS. harvest_executor and canopy_clear_executor concede a futile
// pass straight into this fragment with no dispatcher board read, so they have no verdict to carry — the
// honest sentence is that no cause was stated, never a guessed one (Law 23).
const IDLE_CAUSE_TEXT = {
  none_outstanding: 'no work outstanding — the board is empty',
  all_gated:        'work outstanding but ALL of it held at the gates — waiting, not finished',
  none_for_species: 'nothing on the board this species may claim',
  claimed_by_peers: 'every job this magnet attracts is claimed by a peer',
  // NOT THE SAME STATE AS `claimed_by_peers`: orders are OPEN and several bodies may still take them, but
  // every unit of what they ask for is already pledged by a peer out fetching it.
  pledged_by_peers: 'every job this magnet attracts is already pledged in full by peers out working',
};

function _standing(payload) {
  const cause = payload?.idle_cause;
  if (!cause) return 'conceded this pass (no board verdict carried)';
  return IDLE_CAUSE_TEXT[cause] || `unrecognised idle cause '${cause}'`;
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType, payload) {
    if (signalType !== TAG) return;
    const bot = global.bot;

    // Resolve the park spot: first anchor's standing cell. Checks whether home is locked before asking
    // where its anchors are, since getWorldAnchors throws a coding violation on an unlocked site —
    // correct for its own callers, but idling before the base layout exists is an ordinary early-run
    // state (Law 16, Law 13). The chair is the same source getWorldAnchors reads.
    //
    // ONE LOOKUP, BECAUSE THERE IS ONE HOME: the species decides which structure that is, and the mandate
    // states it. A body whose home is not yet sited or not yet floored gets `null` and idles where it
    // stopped.
    const parkKey = _homeBlueprint();
    const parkAnchor = _homeAnchor(bot, parkKey);
    const park = parkAnchor ? { x: parkAnchor.x, y: parkAnchor.y + 1, z: parkAnchor.z } : null;

    if (park) {
      const p = bot.entity.position;
      const near = Math.abs(Math.floor(p.x) - park.x) + Math.abs(Math.floor(p.z) - park.z) <= 1
                && Math.abs(Math.floor(p.y) - park.y) <= 1;
      if (!near) {
        // A body coming home with nothing to do banks what it carries first. An abandoned drop-off has
        // already routed to the judge, so this chain ends here without arming (Law 15, Law 4).
        const drop = await require('@api/inventory_swapper').dropOffHaul(bot);
        if (drop?.abandoned) return;
        watcher.summary(TAG, `parking at ${parkKey} anchor (${park.x},${park.y},${park.z}) — clear of the build footprint`);
        await locomotion.goToStand(parkAnchor, { exact: false });   // park ON the anchor's stand cell, tolerant (not exact); goTo owns its own abandonment (Law 15)
      }
    }

    // Arm the re-check LAST — bot is parked, chain is ending, heartbeat owns re-entry (Law 4).
    idleScheduler.arm();

    // Law 5 rate limit: the heartbeat fires often enough that one line per pass adds up fast. The
    // dispatcher already made the decision for this whole pass and put it in the payload — this
    // fragment does NOT re-derive it, or the two lines describing one pass would drift out of phase
    // (see idle_scheduler's gate).
    //
    // Absent field ⇒ post. The dispatcher always sets it explicitly; the other routes into idle_park
    // (harvest_executor / canopy_clear_executor conceding a futile pass) are one-shot concessions, not
    // a heartbeat, and each one is worth a line.
    if (!payload || payload.log_idle_line !== false) {
      watcher.summary(TAG, `idle — ${_standing(payload)}; parked, re-checking the board every ${idleScheduler.RECHECK_MS / 1000}s.`);
    }
  }),
};
