// fragment: idle_park
// purpose: When the dispatcher has no job for this bot (all claimed by peers, or board empty),
//   move the bot OUT of the build footprint and wait. It parks at a blueprint's FIRST anchor
//   standing cell (anchor.y + 1) — the vantage the builder itself stands in, so that cell
//   is never a block to be placed. Bots don't clip each other, but a bot standing where a block
//   belongs still blocks its placement (Law 19: the placement constraint binds every agent) — so
//   an idle bot left in a random cell silently stalls a peer's build. The anchor vantage is the
//   one cell guaranteed clear of the structure, and it sits in front of the staging chests.
//
//   WHICH blueprint is decided by one sensed question — see SHELTER below. The contractor's house
//   wins as soon as its first anchor holds a body; the headframe is what a homesteader falls back to.
//
//   As its LAST act it arms the idle re-check heartbeat (idle_scheduler) and terminates the chain
//   — it routes nowhere, exactly like the dispatcher's own idle exit. Arming AFTER goTo returns is
//   what keeps Law 4 intact: no signal is live when the heartbeat later fires.
//
// Law 15: calls locomotion goTo (a sub-loop API that owns its own movement abandonment). We add no
//   movement retry of our own, and we arm the heartbeat regardless of whether the park succeeded —
//   a failed park must never leave the bot permanently asleep.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const buildingIntegrity = require('@perception/building_integrity');
const hq = require('@kernel/corporate_headquarters');
const idleScheduler = require('@kernel/idle_scheduler');
const { classifyFloor } = require('@utils/movement/terrain_predicates');

const TAG = 'idle_park';
const HOME = 'headframe';   // the base blueprint every bot shares; its anchor 0 is the park vantage.

// The shelter a body waits inside when one has been built. PREFERRED OVER HOME, and the preference is the
// whole reason the building exists: the headframe vantage is open ground, so a body standing there
// overnight is a body fighting instead of waiting. This blueprint's anchor sits one below an enclosed,
// lit cell, so the same `anchor.y + 1` vantage that keeps a builder out of the headframe's footprint puts
// a body INSIDE this one — the two buildings are read by identical arithmetic and mean different things
// by their geometry alone.
//
// THE FLOOR IS THE ADMISSION TEST, NOT THE FINISHED BUILDING. What this fragment has to answer is one
// physical question — is there a cell of this house a body can stand in — and a finished-building scan
// answers a much larger one. The two diverge for most of a run: anchor 0 lays the ground floor and its
// stations first and the walls are anchor 1, so a house that is minutes from complete already has a real
// floor with real air above it, and a completeness test parks the body somewhere else for all of it.
//
// A LOCKED CENTRE IS STILL NOT ENOUGH, and that half of the old reasoning holds: a reservation is a claim
// over ground that may be open air, and standing in an unbuilt footprint is the exact fault this fragment
// exists to prevent. What changed is where the line sits — from "the scan says the building matches" to
// "the world says this cell holds a body", which is the smaller, truer question and the one the park
// actually depends on.
const SHELTER = 'contractor_house';

// The shelter's park anchor, or null. SENSED EVERY TIME, never remembered: a building can be taken apart
// by the world between one idle tick and the next, and a remembered "yes" would park a body in a ruin
// (Invariant B).
//
// TWO BLOCK READS, and the cost is the reason they are the right two. This runs on the idle heartbeat —
// about once a second per idle bot — and the completeness scan that used to stand here walked all 150
// voxels of the blueprint on every one of those ticks to answer a question about one cell.
//
// classifyFloor IS THE STANDABILITY DEFINITION (Law 16): the same predicate the navigator's goal test and
// the station placer use, so "a body can stand here" cannot come to mean two different things in two
// files. Non-null = a safe surface with the headroom above it; that IS the anchor being available to
// stand on. Air (an unbuilt floor) is not a walkable surface, so an unbuilt anchor reads null with no
// separate check.
//
// Unsited reads as no shelter without provoking getWorldAnchors' coding violation — the chair is the same
// source that throw consults, so this asks the question rather than catching the answer (Law 16).
function _shelterAnchor(bot) {
  const spot = hq.readBuildingChair(SHELTER, 'set_buildspot');
  if (!spot?.build_center || typeof spot.build_center.x !== 'number') return null;
  const anchors = buildingIntegrity.getWorldAnchors(SHELTER, SHELTER);
  const anchor = anchors && anchors[0];
  if (!anchor) return null;
  return classifyFloor(bot, bot.blockAt(new Vec3(anchor.x, anchor.y, anchor.z))) ? anchor : null;
}

// WHY THE PARK LINE NAMES WHICH STILL-FLEET THIS IS. Every reason a bot idles produces the same
// picture — a body standing at the vantage with no magnet — and they mean opposite things: a fleet
// that has run out of work is FINISHED, a fleet whose whole board is held at the gates is WAITING and
// will move again on its own at dawn or when stock lands. This is the line a reader (and anything
// waiting on this fleet) stops at, so a park that says only "idle" hands over the one picture without
// the one bit that distinguishes done from stuck (Law 25).
//
// READ FROM THE PAYLOAD, NEVER RE-DERIVED. The dispatcher decided it this pass and owns that decision
// (Invariant D); re-reading the board here would be a second answer free to disagree with the line
// already printed, and it would read a board that may have been swept again since (Law 16).
//
// A ROUTE THAT NAMES NO CAUSE STILL PARKS. harvest_executor and canopy_clear_executor concede a futile
// pass straight into this fragment without going through the dispatcher's board read, so they have no
// verdict to carry — the honest sentence is that no cause was stated, never a guessed one (Law 23).
const IDLE_CAUSE_TEXT = {
  none_outstanding: 'no work outstanding — the board is empty',
  all_gated:        'work outstanding but ALL of it held at the gates — waiting, not finished',
  none_for_species: 'nothing on the board this species may claim',
  claimed_by_peers: 'every job this magnet attracts is claimed by a peer',
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

    // Resolve the park spot: first anchor's standing cell — but ASK whether home is locked before asking
    // where its anchors are. getWorldAnchors throws a coding violation on an unlocked site, which is
    // correct for its own callers (a builder reaching that state IS a bug) and wrong for this one: idling
    // before the base layout exists is an ordinary early-run state, so catching that throw made a catch
    // the expected pathway and swallowed a violation class that must never be swallowed (Law 16, Law 13).
    // The chair is the same source getWorldAnchors reads, so this asks the question rather than provoking
    // the answer.
    // The shelter first, the open vantage as the fallback. Asked in this order rather than merged into one
    // lookup so a reader can see that home is what is left when there is no house yet, not a peer choice.
    //
    // A CONTRACTOR HAS NO HOME AND THIS IS THE ONLY BRANCH THAT REACHES IT. lock_all_buildspots sites the
    // headframe for a homesteader and ONE building — this house — for a contractor, so on a contractor the
    // fallback below finds no chair, parkAnchor stays null and the body idles where it stopped. That is the
    // honest end state and it is why the shelter test must open as early as it can: for a contractor, the
    // shelter is not a preference over home, it is the only park there will ever be.
    let parkAnchor = _shelterAnchor(bot);
    let parkKey = SHELTER;
    if (!parkAnchor) {
      parkKey = HOME;
      const homeSpot = hq.readBuildingChair(HOME, 'set_buildspot');
      if (homeSpot?.build_center && typeof homeSpot.build_center.x === 'number') {
        const anchors = buildingIntegrity.getWorldAnchors(HOME, HOME);
        if (anchors && anchors[0]) parkAnchor = anchors[0];
      }
    }
    const park = parkAnchor ? { x: parkAnchor.x, y: parkAnchor.y + 1, z: parkAnchor.z } : null;

    if (park) {
      const p = bot.entity.position;
      const near = Math.abs(Math.floor(p.x) - park.x) + Math.abs(Math.floor(p.z) - park.z) <= 1
                && Math.abs(Math.floor(p.y) - park.y) <= 1;
      if (!near) {
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
