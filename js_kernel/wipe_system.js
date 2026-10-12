// js_kernel/wipe_system.js
// The 'wipe' operator verb — forgets one owner's places, so the human accountable for a crew can move
// their base.
//
// Distinct from `flush`, which resets corporate_headquarters whole and clears the foreman's shared mirror
// alongside it — the correct radius for the terminal, where the whole fleet is one person's responsibility,
// but wrong for a human standing in the world, who is accountable for their own crew and nobody else's,
// matching the foreman's door promise that only their own bots hear it (Law 28: whoever raises a crew
// answers for what it does and therefore controls what it knows — reach is granted at exactly the scope of
// the answering and no wider).
//
// The scope is the key, not an argument (Law 27): nothing is passed in. The owner is read from this
// process's own mandate, exactly as station_registry reads it to write a row. The verb is delivered only
// to the asker's own bots (the foreman's owner filter), and each of those bots can form only its own
// owner's keys, so there is no argument in which to name somebody else's row.
//
// Tombstones, not deletes: a deleted key does not survive the HQ merge, since the merge loop reads incoming
// keys and treats a merely absent local key as no-news, leaving the remembered entry in place. Buildings
// are worse — every bot re-broadcasts its whole building room, including rooms it only adopted from a peer,
// so a homesteader that never belonged to this human would still hand back a copy of their old house on
// the next update. A tombstone is a fact that travels; an absence is not (Law 16 — one pathway for
// removal, owned by station_registry).
//
// usage:
//  - console/foreman: the 'wipe' verb via operator_commands (Law 16: one pathway)
//  - in-game: the foreman's `wipe`, which is the only reason it exists

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const botMandate = require('@kernel/bot_mandate');
const stationRegistry = require('@perception/station_registry');
const { roomKeyOwner, isBuildingTombstone } = require('@foreman/message_schema');

const TAG = 'wipe_system';

// wipeStations — strikes every station row stamped with this body's owner.
//
// Calls removeStation as the one removal pathway (Law 16): it already writes the tombstone in the shape
// the merge and the owner gate both read, refuses to re-stamp a row already struck, and reports each
// strike exactly once.
//
// An entry with no owner is the commons and is never taken: the owner axis postdates every station written
// before it, so an unstamped row belongs to nobody in particular and no human's wipe may claim it.
function wipeStations(ownerKey) {
  const stations = stationRegistry.getStations(null);   // raw map, tombstones already filtered out
  let struck = 0;
  for (const [id, entry] of Object.entries(stations)) {
    if (!entry || entry.owner !== ownerKey) continue;
    if (stationRegistry.removeStation(id)) struck++;
  }
  return struck;
}

// wipeBuildings — tombstones every building room keyed to this body's owner.
//
// The tombstone keeps nothing but its time: a building room key already carries its structure and its
// owner, so a reader can place the row from the key alone, unlike a station's tombstone, which keeps
// pos/type/owner because the merge and the owner gate key on them (Law 6 — one home per fact).
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
// Async only to keep the verb signature uniform with start/stop/flush, which operator_commands awaits;
// both halves are synchronous.
//
// A homesteader's wipe is the commons' wipe, and is legal: stationOwnerKey stamps the commons for one,
// and the estate is what a homesteader is accountable for. It can only be reached from the operator's own
// console, where the whole fleet is the operator's responsibility — no homesteader mounts the human
// channels.
//
// Does not touch standing requests: `cancel all` already withdraws orders (Law 16), and this verb's own
// scope is places, not orders.
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
