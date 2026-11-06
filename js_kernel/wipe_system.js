// js_kernel/wipe_system.js
// The 'wipe' operator verb — forgets this crew's places, so the crew can be sited again.
//
// Distinct from `flush`, which resets corporate_headquarters whole and clears the foreman's shared mirror
// alongside it: a wipe reaches one crew's rows and no other's.
//
// The scope is the key, not an argument (Law 27): nothing is passed in. The crew is read from this
// process's own mandate, exactly as station_registry reads it to write a row, and a body can form only its
// own crew's keys, so there is no argument in which to name another crew's row.
//
// Tombstones, not deletes: a deleted key does not survive the HQ merge, since the merge loop reads incoming
// keys and treats a merely absent local key as no-news, leaving the remembered entry in place. Buildings
// are worse — every bot re-broadcasts its whole building room, including rooms it only adopted from a peer,
// so a peer would still hand back a copy of the old building on the next update. A tombstone is a fact
// that travels; an absence is not (Law 16 — one pathway for removal, owned by station_registry).
//
// usage: the 'wipe' verb via operator_commands, from the console or the foreman (Law 16: one pathway)

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const botMandate = require('@kernel/bot_mandate');
const stationRegistry = require('@perception/station_registry');
const { roomKeyCrew, isBuildingTombstone } = require('@foreman/message_schema');

const TAG = 'wipe_system';

// wipeStations — strikes every station row stamped with this body's crew.
//
// Calls removeStation as the one removal pathway (Law 16): it already writes the tombstone in the shape
// the merge and the owner gate both read, refuses to re-stamp a row already struck, and reports each
// strike exactly once.
function wipeStations(crew) {
  const stations = stationRegistry.getStations(null);   // raw map, tombstones already filtered out
  let struck = 0;
  for (const [id, entry] of Object.entries(stations)) {
    if (!entry || entry.owner !== crew) continue;
    if (stationRegistry.removeStation(id)) struck++;
  }
  return struck;
}

// wipeBuildings — tombstones every building room keyed to this body's crew.
//
// The tombstone keeps nothing but its time: a building room key already carries its structure and its
// crew, so a reader can place the row from the key alone, unlike a station's tombstone, which keeps
// pos/type/owner because the merge and the crew gate key on them (Law 6 — one home per fact).
//
// pickBuildingEntry decides tombstone-against-lock by which event happened later, so a base re-sited
// after a wipe establishes normally and is not held down by the strike that preceded it.
function wipeBuildings(crew) {
  const room = hq.readOffice('building_confrence_room', {}) || {};
  const now = Date.now();
  let struck = 0;
  for (const [key, entry] of Object.entries(room)) {
    if (roomKeyCrew(key) !== crew) continue;
    if (isBuildingTombstone(entry)) continue;
    room[key] = { removed_at: now };
    struck++;
  }
  if (struck > 0) hq.writeOffice('building_confrence_room', room);
  return struck;
}

// wipe() → { crew, stations, buildings }
//
// Async only to keep the verb signature uniform with start/stop/flush, which operator_commands awaits;
// both halves are synchronous.
async function wipe() {
  const crew = botMandate.currentMode();
  const stations = wipeStations(crew);
  const buildings = wipeBuildings(crew);
  watcher.summary(TAG,
    `wipe — struck ${stations} station(s) and ${buildings} building room(s) belonging to '${crew}'. ` +
    'Rows belonging to any other crew were not read and could not have been.');
  return { crew, stations, buildings };
}

module.exports = { wipe };
