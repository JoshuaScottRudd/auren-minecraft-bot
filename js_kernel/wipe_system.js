// js_kernel/wipe_system.js
// The 'wipe' operator verb — forget ONE owner's PLACES, so the human accountable for a crew can move
// their base.
//
// ── WHY THIS IS NOT flush WITH AN ARGUMENT ────────────────────────────────────────────────────────────
// `flush` resets corporate_headquarters WHOLE and the overseer clears its shared mirror alongside it, so
// it erases every owner's stations, every owner's structures and every human's standing requests at once.
// That radius is correct for the terminal, where the whole fleet is one person's responsibility. It is
// wrong for a human standing in the world, who is accountable for their own crew and nobody else's — and
// the foreman's door promises exactly that ("only YOUR bots hear it"). One person saying `flush` in the
// world destroyed work other people answer for.
//
// LAW 28 is what this file enacts, and this case is what earned that law. Whoever raises a crew answers
// for what it does and therefore controls what it knows — memory decides the next act, so it is part of
// being able to stop the thing acting, never a separate power. Reach is granted at exactly the scope of
// the answering and no wider: this verb reaches the rows stamped with the speaker's own name and cannot
// reach any other. A clearing verb whose radius exceeds its caller's scope destroys work other parties
// answer for, and the question about that damage then arrives at a party that did not act.
//
// ── THE SCOPE IS THE KEY, NOT AN ARGUMENT (Law 27) ────────────────────────────────────────────────────
// NOTHING IS PASSED IN. The owner is read from this process's own mandate, exactly as station_registry
// reads it to WRITE a row. The verb is delivered only to the asker's own bots (the overseer's owner
// filter), and each of those bots can form only its own owner's keys — so "wipe my things" needs no
// argument saying whose, and no argument exists in which to name somebody else's. A wipe that took an
// owner would be a permission check waiting to be got wrong; this cannot address a foreign row because
// there is no way to spell one.
//
// ── WHY TOMBSTONES AND NOT DELETES ────────────────────────────────────────────────────────────────────
// A deleted key does not survive the HQ merge. mergeBroadcastStations records the same lesson against its
// own history: the merge loop reads INCOMING keys, so a key that is merely ABSENT locally is no-news and
// the remembered entry stays. Buildings are worse — every bot re-broadcasts its whole building room
// including rooms it only adopted from a peer, so a homesteader that never belonged to this human still
// holds a copy of their old house and hands it back on the next update. A tombstone is a fact that
// travels; an absence is not (Law 16 — one pathway for removal, and station_registry already owns it).
//
// usage:
//  - console/overseer: the 'wipe' verb via operator_commands (Law 16: one pathway)
//  - in-game: the foreman's `wipe`, which is the only reason it exists

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const botMandate = require('@kernel/bot_mandate');
const stationRegistry = require('@perception/station_registry');
const { roomKeyOwner, isBuildingTombstone } = require('@overseer/message_schema');

const TAG = 'wipe_system';

// wipeStations — strike every station row stamped with this body's owner.
//
// removeStation IS THE REMOVAL PATHWAY and is called rather than reimplemented: it already writes the
// tombstone in the shape the merge and the owner gate both read, already refuses to re-stamp one that is
// already struck, and already reports each strike exactly once. A second removal written here would be
// the redundant route Law 16 forbids, and it would be the one that forgets a field.
//
// AN ENTRY WITH NO OWNER IS THE COMMONS AND IS NEVER TAKEN. station_registry gives the identical reading
// where it gates reads: the owner axis postdates every station written before it, so an unstamped row
// belongs to nobody in particular and no human's wipe may claim it.
function wipeStations(ownerKey) {
  const stations = stationRegistry.getStations(null);   // raw map, tombstones already filtered out
  let struck = 0;
  for (const [id, entry] of Object.entries(stations)) {
    if (!entry || entry.owner !== ownerKey) continue;
    if (stationRegistry.removeStation(id)) struck++;
  }
  return struck;
}

// wipeBuildings — tombstone every building room keyed to this body's owner.
//
// THE TOMBSTONE KEEPS NOTHING BUT ITS TIME, and that is the difference from a station's. A station's
// tombstone keeps pos/type/owner because the merge and the owner gate key on them; a building room key
// already CARRIES its structure and its owner, so a reader can place the row from the key alone and a
// retained body would only be a copy of a fact the key states (Law 6 — one home per fact).
//
// pickBuildingEntry decides tombstone-against-lock by which event happened later, so a base re-sited
// after a wipe establishes normally and is not held down by the strike that preceded it.
function wipeBuildings(ownerKey) {
  const room = hq.readOffice('building_confrence_room', {}) || {};
  const now = Date.now();
  let struck = 0;
  for (const [key, entry] of Object.entries(room)) {
    if (roomKeyOwner(key) !== ownerKey) continue;
    if (isBuildingTombstone(entry)) continue;
    room[key] = { removed_at: now };
    struck++;
  }
  if (struck > 0) hq.writeOffice('building_confrence_room', room);
  return struck;
}

// wipe() → { owner, stations, buildings }
//
// ASYNC ONLY TO KEEP THE VERB SIGNATURE UNIFORM with start/stop/flush, which operator_commands awaits.
// Both halves are synchronous.
//
// A HOMESTEADER'S WIPE IS THE COMMONS' WIPE AND IS LEGAL, because stationOwnerKey stamps the commons for
// one and the estate is what a homesteader is accountable for. It cannot arrive from the world — no
// homesteader mounts the human channels — so the only way to reach this line as a homesteader is the
// operator's own console, where the whole fleet is the operator's responsibility.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH: standing requests. `cancel all` already withdraws orders and a
// second word doing the same thing is a redundant pathway (Law 16). It is also the honest scope — this
// verb exists to forget PLACES so a base can move, and an order for 20 logs is not a place.
async function wipe() {
  const ownerKey = botMandate.stationOwnerKey();
  const stations = wipeStations(ownerKey);
  const buildings = wipeBuildings(ownerKey);
  watcher.summary(TAG,
    `wipe — struck ${stations} station(s) and ${buildings} building room(s) belonging to '${ownerKey}'. ` +
    'Rows belonging to any other owner were not read and could not have been.');
  return { owner: ownerKey, stations, buildings };
}

module.exports = { wipe };
