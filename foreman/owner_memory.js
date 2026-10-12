// foreman/owner_memory.js
// THE PLAYER'S OWN MEMORY, AND THE ONLY THING IN THIS FLEET THAT OUTLIVES THE BODIES THAT MADE IT.
//
// Buildings are keyed `<structure>|<owner>` and stations carry the owner in the row key; `wipe_system`
// strikes one owner's rows and cannot spell another's. What this module adds is the floor those keys
// needed: a disk store filed under the OWNER, so a player's places survive a body being retired or
// handed to someone new.
//
// ── WHY THE FOREMAN OWNS IT AND THE BOTS DO NOT (Invariant D) ──────────────────────────────────────
// Renaming the HQ file after the owner so a crew shares one document would put TWO bot processes on ONE
// json — exactly what the per-bot naming exists to prevent: two writers on one file means last-writer-
// wins, and a lost buildspot is not recoverable from the world.
//
// The foreman is already the merge authority for these two rooms — every bot sends them up in
// `hq_delta` and receives the merged result back — and it is the only long-lived process that sees all
// of them. Giving that mirror a disk leaves the bots' own flush path untouched: one writer, by
// construction.
//
// The bot-side half needs no code: a fresh contractor receives its owner's buildings and stations in the
// first `hq_broadcast` after it registers, because the foreman now starts with them already loaded.
//
// ── WHAT IS DURABLE AND WHAT IS EPHEMERAL, IN ONE FILE ──────────────────────────────────────────────
//   · PLACES (buildings, stations) — durable. Written by whoever built them, kept until deleted by hand.
//   · CHAIRS (a bot's inventory, position, magnet) — ephemeral, rewritten from the LIVE client list on
//     every save. A body that has gone leaves no chair behind; this module can only see connected clients.
//
// ── DELETION IS THE OPERATOR'S, AND NOTHING RE-CREATES WHAT IS DELETED ─────────────────────────────
// A deleted file must stay deleted. `fleet_control.botStart` clears a CONTRACTOR's working HQ before
// launch, so a body handed to a new person starts with no memory of the last one. Homesteaders keep
// theirs; they are the operator's own persistent fleet, not a seat that changes hands.

'use strict';

const fs = require('fs');
const path = require('path');
const { durableWrite } = require('@kernel/durable_write');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');
const { roomKeyOwner } = require('./message_schema');

const TAG = 'owner_memory';

// ── ONE STORE, AND IT IS INSIDE THE BOT ─────────────────────────────────────────────────────────────
//
//   every deployment  →  Auren_Bot/player_memory/   untracked, like every other thing the fleet writes
//
// ONE PATH, SO THERE IS NOTHING TO CHOOSE AND NOTHING TO DECLARE (Law 16, Law 27): a single path cannot
// be pointed at the wrong folder.
//
// WHY IT LIVES UNDER THE BOT AND NOWHERE ELSE. These coordinates are true about ONE world on ONE disk,
// so they are per-machine live state: carrying them to another machine delivers facts about a world
// that is not there (Invariant B). A downloaded copy has only this path anyway —
// everything above `Auren_Bot/` is absent by construction — so the store cannot be pointed elsewhere.
//
// Not under `fleet_logs/`: a run start empties that folder whole, and this is the one thing the fleet
// keeps that must survive a run (see `resetRunArtifacts`).
const MEMORY_DIR = path.join(__dirname, '..', 'player_memory');

// A username is 3-16 of [A-Za-z0-9_], and `homesteader` (the commons key) is the one other legal value.
// Anything else is refused: an owner key reaching here is derived from a bot's own mandate and can never
// legitimately be strange, so a strange one is a coding fault, and rewriting it into something safe
// would file a player's memory under a name nobody can find again (Law 13).
const OWNER = /^[A-Za-z0-9_]{3,16}$/;

// The debounce. Chairs restamp every few seconds while a crew works, so an unthrottled save would rewrite
// every active player's file continuously for data worthless the moment they log off. Ten times the
// bots' own 2s flush: a place is written once and then read for the rest of its life.
const SAVE_INTERVAL_MS = 20000;

let _timer = null;
let _pending = null;
let _saving = null;
// A run's first change must not wait for the debounce window.
let _lastWrite = 0;

function fileFor(owner) { return path.join(MEMORY_DIR, `player_hq.${owner}.json`); }

// ownerOf(key) — whose row is this? Buildings are `<structure>|<owner>`, stations are `<posId>|<owner>`.
// One parser for both, since it is one key shape, defined in `message_schema.roomKeyOwner` (Law 16).
//
// Null is the commons and is never filed under anybody: a row written before the owner axis existed
// reads the same way in both stores and belongs to nobody in particular.
function ownerOf(key) {
  const o = roomKeyOwner(key);
  return o && OWNER.test(o) ? o : null;
}

// ── LOAD ────────────────────────────────────────────────────────────────────────────────────────────
//
// loadAll() → { buildings, stations } — every player's places, merged into the two flat maps the
// foreman already keeps them in.
//
// A directory that is not there is a first run; a file that will not parse is a stop for that player
// only — the same split `corporate_headquarters._loadFromDisk` makes: absent means nothing to lose,
// present-but-unreadable means memory exists and cannot be reached. A bot refuses to boot because its
// own memory is the only memory it has; the foreman serving several players must not refuse all of them
// because one file is damaged, so a bad file is reported loudly and skipped, and that player's rows are
// then never saved over, because nothing was loaded to merge them with and the save only writes owners
// it has rows for. The damaged file is left exactly as it is for a human to look at.
function loadAll(report) {
  const out = { buildings: {}, stations: {} };

  // Said out loud on every start (Invariant C), so a reader diagnosing why nobody's places came back has
  // the absolute path in front of them.
  report(`${TAG}: store is ${MEMORY_DIR} — this machine only, untracked.`);

  // Presence asked first: a fresh install has never created this directory, and its absence is the
  // correct state of a machine with no players yet.
  if (!fs.existsSync(MEMORY_DIR)) return out;

  const listed = guardExternalSync(TAG, `list ${MEMORY_DIR}`, () => fs.readdirSync(MEMORY_DIR));
  if (!listed.ok) {
    // Existed a moment ago and would not read — news whatever the cause: player memory may be sitting
    // there and not being loaded.
    report(`${TAG}: could not read ${MEMORY_DIR} (${listed.reason}) — starting with no player memory.`);
    return out;
  }
  let players = 0, rooms = 0, stations = 0;
  for (const name of listed.value) {
    const m = /^player_hq\.(.+)\.json$/.exec(name);
    if (!m) continue;
    const read = guardExternalSync(TAG, `read ${name}`,
      () => JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, name), 'utf-8')));
    if (!read.ok) {
      report(`${TAG}: ${name} is present but unreadable (${read.reason}). SKIPPED — that player's places are `
           + `not loaded and will not be overwritten. Move or repair the file, then restart the foreman.`);
      continue;
    }
    const doc = read.value;
    if (!doc || typeof doc !== 'object') continue;
    for (const [k, v] of Object.entries(doc.buildings || {})) { out.buildings[k] = v; rooms++; }
    for (const [k, v] of Object.entries(doc.stations  || {})) { out.stations[k]  = v; stations++; }
    players++;
    // A chair on disk at load time is stale, always: nothing is connected yet, so any chair here belongs
    // to a body that stopped while the foreman was down. Chairs are never read back into the live mirror
    // (only places are, in the two loops above), so clearing the file states the truth the moment it is
    // opened. Cleared at load time, since a run nobody joins never saves and the stale chair would
    // otherwise outlive the run.
    const stale = Object.keys(doc.chairs || {}).length;
    if (stale) {
      doc.chairs = {};
      // Stamped because this write changed the file, so the field naming when it last moved stays correct.
      doc.updated_at = new Date().toISOString();
      const text = JSON.stringify(doc, null, 2);
      guardExternal(TAG, `clear stale chairs in ${name}`,
        () => durableWrite(path.join(MEMORY_DIR, name), text)).then(swept => {
        if (swept.ok) report(`${TAG}: ${name} carried ${stale} chair(s) from bodies that are gone — cleared.`);
        else report(`${TAG}: could not clear stale chair(s) in ${name} (${swept.reason}) — the places loaded `
                  + `fine; the chairs shown in that file are last run's and will be corrected on the next save.`);
      });
    }
  }
  if (players) report(`${TAG}: loaded ${players} player HQ file(s) — ${rooms} building(s), ${stations} station(s).`);
  return out;
}

// ── SAVE ────────────────────────────────────────────────────────────────────────────────────────────
//
// save(buildings, stations, chairsByOwner, report) — debounced. The caller hands the whole merged view
// and this splits it by owner; nothing here decides anything (Law 3).
//
// Every save rewrites a player's file whole: there is exactly one writer, and the map it writes from is
// the foreman's merged view, which already holds everything any bot has sent up this run plus everything
// loaded at start.
//
// A player with no rows is not written and not deleted: writing an empty file for every name that ever
// connected would litter the store, and deleting one because this run has nothing to say about it would
// make this process the one deciding a hand-deletion.
//
// Leading edge, not trailing — the first change after a quiet spell reaches disk now, and only a burst is
// coalesced. `down` terminates the process by pid with no exit path of its own, so a trailing-only
// debounce could hold a fresh buildspot in memory through a hard kill; the coalescing still does its job,
// since a crew placing rooms in a burst writes once at the end of it.
//
// `forceOwners` — owners whose file must be written even with nothing left to say, for the wipe: without
// it, striking a player's last building would leave their old file standing with the house still in it,
// and the next foreman start would load it straight back. The emptiness itself is the news that must be
// told.
function save(buildings, stations, chairsByOwner, report, forceOwners) {
  _pending = { buildings, stations, chairsByOwner, report, forceOwners };
  if (_timer || _saving) return;
  if (Date.now() - _lastWrite >= SAVE_INTERVAL_MS) { _saveNow(); return; }
  _timer = setTimeout(_saveNow, SAVE_INTERVAL_MS - (Date.now() - _lastWrite));
  if (_timer.unref) _timer.unref();
}

function _saveNow() {
  _timer = null;
  if (_saving) return _saving;
  if (!_pending) return;
  // Bursts retain one latest pending view while a captured snapshot is on disk's worker thread.
  _saving = withCleanup(TAG, 'save player memory', async () => {
    while (_pending) await _writePending();
  }, () => {
    _saving = null;
    // A change arriving as the drain ends still owns a future save.
    if (_pending && !_timer) {
      _timer = setTimeout(_saveNow, Math.max(0, SAVE_INTERVAL_MS - (Date.now() - _lastWrite)));
      if (_timer.unref) _timer.unref();
    }
  });
  return _saving;
}

async function _writePending() {
  const job = _pending;
  _pending = null;
  if (!job) return;
  // Stamped before the writes, not after: it gates the debounce, and a slow disk must not become a
  // licence to write again immediately.
  _lastWrite = Date.now();

  const byOwner = new Map();
  const bucket = (owner) => {
    if (!byOwner.has(owner)) byOwner.set(owner, { buildings: {}, stations: {}, chairs: {} });
    return byOwner.get(owner);
  };
  for (const [k, v] of Object.entries(job.buildings || {})) {
    const o = ownerOf(k); if (o) bucket(o).buildings[k] = v;
  }
  for (const [k, v] of Object.entries(job.stations || {})) {
    const o = ownerOf(k); if (o) bucket(o).stations[k] = v;
  }
  // Chairs are added to owners that already have a bucket and to owners that do not — a crew that has
  // built nothing yet is still a crew worth seeing. This is the only place a file can come into existence
  // for a player with no places.
  for (const [o, chairs] of Object.entries(job.chairsByOwner || {})) {
    if (OWNER.test(o)) bucket(o).chairs = chairs;
  }
  // A wiped owner gets a bucket whether or not anything is left in it: opening the bucket is the whole
  // job here, and for a full wipe that empty file is the correct record of what was asked for.
  for (const o of (job.forceOwners || [])) {
    if (OWNER.test(o)) bucket(o);
  }

  const snapshots = [];
  for (const [owner, doc] of byOwner) {
    const body = {
      schema: 'auren.player_hq.v1',
      player: owner,
      updated_at: new Date().toISOString(),
      // The two halves, labelled in the file itself so a human opening it can see which half is forever.
      _note: 'buildings and stations are DURABLE and kept until this file is deleted by hand. '
           + 'chairs are the live crew and are rewritten from connected bots on every save.',
      buildings: doc.buildings,
      stations: doc.stations,
      chairs: doc.chairs,
    };
    snapshots.push({ owner, text: JSON.stringify(body, null, 2) });
  }
  const made = await guardExternal(TAG, `create ${MEMORY_DIR}`, () => fs.promises.mkdir(MEMORY_DIR, { recursive: true }));
  if (!made.ok) { job.report(`${TAG}: could not create ${MEMORY_DIR} (${made.reason}) — player memory NOT saved.`); return; }
  for (const { owner, text } of snapshots) {
    const wrote = await guardExternal(TAG, `durable replace of ${fileFor(owner)}`,
      () => durableWrite(fileFor(owner), text));
    if (!wrote.ok) job.report(`${TAG}: could not save ${owner}'s HQ (${wrote.reason}) — it is still in memory and will retry.`);
  }
}

// flushNow — for a deliberate shutdown, so the last twenty seconds of work are not lost to the debounce.
async function flushNow() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  while (_pending || _saving) await _saveNow();
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { loadAll, save, flushNow, MEMORY_DIR };
