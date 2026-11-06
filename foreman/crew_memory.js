// foreman/crew_memory.js
// THE CREW'S OWN MEMORY, AND THE ONLY THING IN THIS FLEET THAT OUTLIVES THE BODIES THAT MADE IT.
//
// Buildings are keyed `<structure>|<crew>` and stations carry the crew in the row key; `wipe_system`
// strikes one crew's rows and cannot spell another's. What this module adds is the floor those keys
// needed: a disk store filed under the CREW, so a crew's places survive its bodies being retired.
//
// ── WHY THE FOREMAN OWNS IT AND THE BOTS DO NOT (Invariant D) ──────────────────────────────────────
// Renaming the HQ file after the crew so its bodies share one document would put TWO bot processes on ONE
// json — exactly what the per-bot naming exists to prevent: two writers on one file means last-writer-
// wins, and a lost buildspot is not recoverable from the world.
//
// The foreman is already the merge authority for these two rooms — every bot sends them up in
// `hq_delta` and receives the merged result back — and it is the only long-lived process that sees all
// of them. Giving that mirror a disk leaves the bots' own flush path untouched: one writer, by
// construction.
//
// The bot-side half needs no code: a fresh body receives its crew's buildings and stations in the first
// `hq_broadcast` after it registers, because the foreman starts with them already loaded.
//
// ── PLACES ONLY ─────────────────────────────────────────────────────────────────────────────────────
// Buildings and stations are durable, written by whoever built them and kept until a rollback start
// empties the store (foreman_plan.emptyMemory). A body's chair is live state and is never written here.

'use strict';

const fs = require('fs');
const path = require('path');
const { durableWrite } = require('@kernel/durable_write');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');
const { roomKeyCrew } = require('./message_schema');
const { BOT_MODES } = require('@thinking/architect_config');

const TAG = 'crew_memory';

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

// A crew key is a species. Anything else is refused: a key reaching here is derived from a bot's own mandate
// and can never legitimately be strange, so a strange one is a coding fault, and rewriting it into something
// safe would file a crew's memory under a name nobody can find again (Law 13).
const CREWS = new Set(Object.values(BOT_MODES));

// The debounce: ten times the bots' own 2s flush, since a place is written once and then read for the rest
// of its life.
const SAVE_INTERVAL_MS = 20000;

let _timer = null;
let _pending = null;
let _saving = null;
// A run's first change must not wait for the debounce window.
let _lastWrite = 0;

function fileFor(crew) { return path.join(MEMORY_DIR, `player_hq.${crew}.json`); }

// crewOf(key) — whose row is this? Buildings are `<structure>|<crew>`, stations are `<posId>|<crew>`.
// One parser for both, since it is one key shape, defined in `message_schema.roomKeyCrew` (Law 16).
function crewOf(key) {
  const c = roomKeyCrew(key);
  return c && CREWS.has(c) ? c : null;
}

// ── LOAD ────────────────────────────────────────────────────────────────────────────────────────────
//
// loadAll() → { buildings, stations } — every crew's places, merged into the two flat maps the foreman
// already keeps them in.
//
// A directory that is not there is a first run; a file that will not parse is a stop for that crew
// only — the same split `corporate_headquarters._loadFromDisk` makes: absent means nothing to lose,
// present-but-unreadable means memory exists and cannot be reached. A bad file is reported loudly and
// skipped, and that crew's rows are then never saved over, because nothing was loaded to merge them with
// and the save only writes crews it has rows for. The damaged file is left exactly as it is for a human
// to look at.
function loadAll(report) {
  const out = { buildings: {}, stations: {} };

  // Said out loud on every start (Invariant C), so a reader diagnosing why no places came back has the
  // absolute path in front of them.
  report(`${TAG}: store is ${MEMORY_DIR} — this machine only, untracked.`);

  // Presence asked first: a fresh install has never created this directory.
  if (!fs.existsSync(MEMORY_DIR)) return out;

  const listed = guardExternalSync(TAG, `list ${MEMORY_DIR}`, () => fs.readdirSync(MEMORY_DIR));
  if (!listed.ok) {
    report(`${TAG}: could not read ${MEMORY_DIR} (${listed.reason}) — starting with no crew memory.`);
    return out;
  }
  let crews = 0, rooms = 0, stations = 0;
  for (const name of listed.value) {
    const m = /^player_hq\.(.+)\.json$/.exec(name);
    if (!m) continue;
    const read = guardExternalSync(TAG, `read ${name}`,
      () => JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, name), 'utf-8')));
    if (!read.ok) {
      report(`${TAG}: ${name} is present but unreadable (${read.reason}). SKIPPED — that crew's places are `
           + `not loaded and will not be overwritten. Move or repair the file, then restart the foreman.`);
      continue;
    }
    const doc = read.value;
    if (!doc || typeof doc !== 'object') continue;
    for (const [k, v] of Object.entries(doc.buildings || {})) { out.buildings[k] = v; rooms++; }
    for (const [k, v] of Object.entries(doc.stations  || {})) { out.stations[k]  = v; stations++; }
    crews++;
  }
  if (crews) report(`${TAG}: loaded ${crews} crew file(s) — ${rooms} building(s), ${stations} station(s).`);
  return out;
}

// ── SAVE ────────────────────────────────────────────────────────────────────────────────────────────
//
// save(buildings, stations, report, forceCrews) — debounced. The caller hands the whole merged view and
// this splits it by crew; nothing here decides anything (Law 3).
//
// Every save rewrites a crew's file whole: there is exactly one writer, and the map it writes from is the
// foreman's merged view, which already holds everything any bot has sent up this run plus everything loaded
// at start. A crew with no rows is not written and not deleted.
//
// Leading edge, not trailing — the first change after a quiet spell reaches disk now, and only a burst is
// coalesced. `down` terminates the process by pid with no exit path of its own, so a trailing-only
// debounce could hold a fresh buildspot in memory through a hard kill.
//
// `forceCrews` — crews whose file must be written even with nothing left to say, for the wipe: without it,
// striking a crew's last building would leave its old file standing with the building still in it, and the
// next foreman start would load it straight back.
function save(buildings, stations, report, forceCrews) {
  _pending = { buildings, stations, report, forceCrews };
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
  _saving = withCleanup(TAG, 'save crew memory', async () => {
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

  const byCrew = new Map();
  const bucket = (crew) => {
    if (!byCrew.has(crew)) byCrew.set(crew, { buildings: {}, stations: {} });
    return byCrew.get(crew);
  };
  for (const [k, v] of Object.entries(job.buildings || {})) {
    const c = crewOf(k); if (c) bucket(c).buildings[k] = v;
  }
  for (const [k, v] of Object.entries(job.stations || {})) {
    const c = crewOf(k); if (c) bucket(c).stations[k] = v;
  }
  // A wiped crew gets a bucket whether or not anything is left in it: for a full wipe that empty file is the
  // correct record of what was asked for.
  for (const c of (job.forceCrews || [])) {
    if (CREWS.has(c)) bucket(c);
  }

  const snapshots = [];
  for (const [crew, doc] of byCrew) {
    const body = {
      schema: 'auren.crew_hq.v1',
      crew,
      updated_at: new Date().toISOString(),
      buildings: doc.buildings,
      stations: doc.stations,
    };
    snapshots.push({ crew, text: JSON.stringify(body, null, 2) });
  }
  const made = await guardExternal(TAG, `create ${MEMORY_DIR}`, () => fs.promises.mkdir(MEMORY_DIR, { recursive: true }));
  if (!made.ok) { job.report(`${TAG}: could not create ${MEMORY_DIR} (${made.reason}) — crew memory NOT saved.`); return; }
  for (const { crew, text } of snapshots) {
    const wrote = await guardExternal(TAG, `durable replace of ${fileFor(crew)}`,
      () => durableWrite(fileFor(crew), text));
    if (!wrote.ok) job.report(`${TAG}: could not save ${crew}'s HQ (${wrote.reason}) — it is still in memory and will retry.`);
  }
}

// flushNow — for a deliberate shutdown, so the last twenty seconds of work are not lost to the debounce.
async function flushNow() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  while (_pending || _saving) await _saveNow();
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { loadAll, save, flushNow, MEMORY_DIR };
