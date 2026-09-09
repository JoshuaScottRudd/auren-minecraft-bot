// overseer/owner_memory.js
// THE PLAYER'S OWN MEMORY, AND THE ONLY THING IN THIS FLEET THAT OUTLIVES THE BODIES THAT MADE IT.
//
// THE ASK (Architect 2026-09-05): *"what i want is durable player keyed HQ that exists until i hand
// delete them… a bot logs on and reports its name and inventory and asks 'whos player am i working for?
// let me grab their hq and write my inventory on them and use that as my base'… so only the live bots
// inventory is on the hq?"*
//
// ── WHY THIS FILE HAD TO EXIST AT ALL, measured rather than assumed ─────────────────────────────────
// Nearly all of what he described was already built. Buildings are already keyed `<structure>|<owner>`
// and stations already carry the owner in the row key; `wipe_system` already strikes one owner's rows
// and cannot even SPELL another's; the connected roster is already broadcast every pass, so a chair for
// a bot that has gone is already dropped everywhere. What did not exist was a FLOOR. Three facts, all
// measured 2026-09-05:
//
//   1. `corporate_headquarters.<BOT_ID>.json` — the fleet's memory is filed under the BODY.
//   2. `mergedBuildings` and `mergedStations` in overseer_server are plain `let x = {}`: a live mirror,
//      empty on every overseer start, never loaded from anywhere.
//   3. The overseer wrote NOTHING to disk.
//
// So a player's house survived only inside files named after whichever bots happened to have built it,
// and the plan to hand a fresh pair of bodies to every visitor would have quietly destroyed every
// player's places. This module is the floor those three facts were missing.
//
// ── WHY THE OVERSEER OWNS IT AND THE BOTS DO NOT (Invariant D, and a documented hazard) ─────────────
// The literal shape — rename the HQ file after the owner so a crew shares one document — puts TWO bot
// processes on ONE json, which is precisely what the current naming exists to prevent. The line that
// does it says so: *"two bot processes on one host must never flush into the same JSON (2s debounce
// would silently stomp the other's state)."* Each bot flushes its WHOLE in-memory cache; two writers
// means last-writer-wins and a lost buildspot is not recoverable from the world.
//
// The overseer is already the merge authority for exactly these two rooms — every bot sends them up in
// `hq_delta` and receives the merged result back — and it is the only single long-lived process that
// sees all of them. Giving that mirror a disk is a smaller change than giving two writers a lock, and
// it leaves the bots' own flush path untouched. **One writer, by construction rather than by rule.**
//
// The bot-side half of his sentence needs no code: a fresh contractor receives its owner's buildings and
// stations in the first `hq_broadcast` after it registers, because the overseer now starts with them
// already loaded. "Grab their HQ and use it as my base" is what the broadcast already does — it simply
// had nothing to hand over across a restart until now.
//
// ── WHAT IS DURABLE AND WHAT IS EPHEMERAL, IN ONE FILE ──────────────────────────────────────────────
// Both, deliberately, because he opens this file to answer two different questions:
//   · PLACES (buildings, stations) — durable. Written by whoever built them, kept until he deletes them.
//   · CHAIRS (a bot's inventory, position, magnet) — ephemeral, and rewritten from the LIVE client list
//     on every save. A body that has gone leaves no chair behind. That is his *"only the live bots
//     inventory is on the hq"*, and it is free here: this module can only see connected clients.
//
// ── DELETION IS HIS, AND NOTHING RE-CREATES WHAT HE DELETES ─────────────────────────────────────────
// *"exists until i hand delete them."* A deleted file must stay deleted, and the thing that could undo
// that is a bot rejoining with a stale working copy of an old owner's rooms and broadcasting them back.
// That is why `fleet_control.botStart` clears a CONTRACTOR's working HQ before launch — a body handed to
// a new person starts with no memory of the last one. Homesteaders keep theirs; they are the Architect's
// own persistent fleet, not a seat that changes hands.

'use strict';

const fs = require('fs');
const path = require('path');
const { durableWrite } = require('@kernel/durable_write');
const { guardExternalSync } = require('@utils/external_library_guard');
const { roomKeyOwner } = require('./message_schema');

const TAG = 'owner_memory';

// ── TWO STORES, AND WHAT DECIDES BETWEEN THEM (Architect 2026-09-08) ────────────────────────────────
//
//   the dedicated public server  →  <repo>/Privacy/player_memory/   TRACKED IN GIT
//   every other deployment       →  Auren_Bot/player_memory/        untracked, like every other log
//
//   *"its only supposed to hold data according to players on the public server only. thats why its
//    gittracked so i can work on it at multiple locations because you can only get player data once. if
//    its made for the user then it should save in the normal spot. so by default contractor bots should
//    save within auren bot… the unique spot is for the dedicated server only."*
//
// WHY THE PUBLIC SERVER'S HALF IS TRACKED, AND IT IS NOT PRIVACY. A stranger joins that world once,
// builds, and leaves. Nothing can collect that again. Git is the only mechanism in this project that
// carries a file to his second workstation and into history, so the one store that must survive a
// machine is the one store that is tracked, and `Privacy/` at the repo root is where a tracked file can
// live without riding out in the published copy of `Auren_Bot/`.
//
// WHY EVERY OTHER DEPLOYMENT'S HALF MUST NOT BE. A dev world's coordinates are true about one world on
// one disk; syncing them delivers to the other workstation a set of facts about a world that is not
// there. That is the repo's own worked example for what an ignore rule is for, and it is why the normal
// spot is untracked rather than merely elsewhere. A user of the published copy has no `Privacy/` beside
// them at all, so for them the normal spot is not a preference — it is the only path that exists.
//
// THE DEPLOYMENT DECLARES ITSELF AND THIS FILE DOES NOT GUESS (Law 23). `AUREN_PUBLIC_SERVER=1` is set
// by the two things that raise the public stack — `online.ps1` and the warden's own repair — and by
// nothing else. Inferring it from host, port or the presence of a folder would be a guess anybody could
// accidentally match, and the two ways of being wrong are both unacceptable and not symmetric: guessing
// INTO the tracked store publishes a stranger's data, and guessing OUT of it loses data that cannot be
// collected twice. A fact with that shape is stated, never derived.
//
// AN UNRECOGNISED VALUE THROWS RATHER THAN FALLING BACK. `AUREN_PUBLIC_SERVER=true` silently choosing the
// local store would be the losing failure above, arriving as a typo nothing reports (Law 13 — a value
// present but not legal is a coding violation, and the message carries the form that works).
//
// Still deliberately NOT under `fleet_logs/`, whichever store is chosen: a run start empties that folder
// whole, and this is the one thing the fleet keeps that must survive a run (see `resetRunArtifacts`).
const _publicFlag = process.env.AUREN_PUBLIC_SERVER;
if (_publicFlag !== undefined && _publicFlag !== '1' && _publicFlag !== '0') {
  throw new Error(
    `CODING VIOLATION (Law 13): AUREN_PUBLIC_SERVER='${_publicFlag}' is not a legal value — it is '1' on `
    + `the dedicated public server and unset everywhere else. It decides which player-memory store is `
    + `written, and player data cannot be collected a second time, so it is never guessed at.`
  );
}
const IS_PUBLIC_SERVER = _publicFlag === '1';

const PUBLIC_STORE = path.join(__dirname, '..', '..', 'Privacy', 'player_memory');
const LOCAL_STORE = path.join(__dirname, '..', 'player_memory');
const MEMORY_DIR = IS_PUBLIC_SERVER ? PUBLIC_STORE : LOCAL_STORE;

// A username is 3-16 of [A-Za-z0-9_], and `homesteader` (the commons key) is the one other legal value.
// ANYTHING ELSE IS REFUSED RATHER THAN SANITISED, because an owner key reaching here is derived from a
// bot's own mandate and can never legitimately be strange — so a strange one is a coding fault, and
// rewriting it into something safe would file a player's memory under a name nobody can find again
// (Law 13: never repair an input, and never default a field).
const OWNER = /^[A-Za-z0-9_]{3,16}$/;

// The debounce. Chairs restamp every few seconds while a crew works, so an unthrottled save would rewrite
// every active player's file continuously for data that is worthless the moment they log off. Ten times
// the bots' own 2s flush: places are what this file is FOR, and a place is written once and then read for
// the rest of its life.
const SAVE_INTERVAL_MS = 20000;

let _timer = null;
let _pending = null;
// 0 rather than Date.now(): the first change of a run is exactly the one that must not wait.
let _lastWrite = 0;

function fileFor(owner) { return path.join(MEMORY_DIR, `player_hq.${owner}.json`); }

// ownerOf(key) — whose row is this? Buildings are `<structure>|<owner>`, stations are `<posId>|<owner>`.
// ONE PARSER FOR BOTH because it is literally one key shape, and `message_schema.roomKeyOwner` is where
// that shape is defined (Law 16). A second `lastIndexOf('|')` spelled here is the copy that survives the
// day somebody changes the separator.
//
// NULL IS THE COMMONS AND IS NEVER FILED UNDER ANYBODY. Both stores give an unstamped row the same
// reading — the owner axis postdates rows written before it existed, so those belong to nobody in
// particular. Filing them under a player would hand one person the fleet's shared history.
function ownerOf(key) {
  const o = roomKeyOwner(key);
  return o && OWNER.test(o) ? o : null;
}

// ── LOAD ────────────────────────────────────────────────────────────────────────────────────────────
//
// loadAll() → { buildings, stations } — every player's places, merged into the two flat maps the
// overseer already keeps them in, so the caller needs no new shape and no new merge.
//
// A DIRECTORY THAT IS NOT THERE IS A FIRST RUN; A FILE THAT WILL NOT PARSE IS A STOP FOR THAT PLAYER
// ONLY. Same split `corporate_headquarters._loadFromDisk` makes, and for the same reason — absent means
// nothing to lose, present-but-unreadable means memory exists and cannot be reached. The difference is
// the RADIUS: a bot refuses to boot because its own memory is the only memory it has, while the overseer
// serving six players must not refuse every one of them because one file is damaged. So a bad file is
// reported loudly and skipped, and — this is the load-bearing half — that player's rows are then never
// SAVED over, because nothing was loaded to merge them with and the save only writes owners it has rows
// for. The damaged file is left exactly as it is for a human to look at.
function loadAll(report) {
  const out = { buildings: {}, stations: {} };

  // WHICH STORE, SAID OUT LOUD ON EVERY START (Invariant C). The choice is made by an environment
  // variable set two processes away, which is exactly the kind of decision that is invisible until it is
  // wrong — and the way it goes wrong is silent by nature: the overseer works perfectly against an empty
  // store and nobody's places come back.
  report(`${TAG}: store is ${MEMORY_DIR} — `
       + `${IS_PUBLIC_SERVER ? 'the DEDICATED PUBLIC SERVER store, tracked in git' : 'this machine only, untracked'}.`);

  // AND THE ONE CONTRADICTION WORTH SHOUTING ABOUT. The public stack raises the overseer twice — once from
  // `online.ps1` and again from the warden's repair every thirty seconds — and both have to stamp the flag.
  // If one of them ever stops, this process comes up on the LOCAL store while a tracked store full of real
  // players sits beside it, serving everybody an empty world and overwriting nothing, with no error
  // anywhere. Reported rather than corrected: a file count is evidence about the past, not authority to
  // override what the deployment just declared about itself (Law 23).
  //
  // ASKED BY PRESENCE FIRST, and that is not a style choice. On every machine that is not the dedicated
  // server — including every published copy, where `Privacy/` cannot exist by construction — this folder
  // is legitimately absent, and putting the boundary guard first made an ⚠️ warning about a missing
  // directory the normal state of a normal start. A directory either exists or it does not, which is a
  // decision with an answer; the guard belongs on the read that follows, where a failure IS news.
  if (!IS_PUBLIC_SERVER && fs.existsSync(PUBLIC_STORE)) {
    const stranded = guardExternalSync(TAG, `list ${PUBLIC_STORE}`, () => fs.readdirSync(PUBLIC_STORE));
    if (stranded.ok && stranded.value.some((n) => /^player_hq\..+\.json$/.test(n))) {
      report(`${TAG}: ${stranded.value.length} file(s) sit in the PUBLIC SERVER store at ${PUBLIC_STORE} `
           + `and this process is NOT reading them — AUREN_PUBLIC_SERVER is unset. If this machine is the `
           + `dedicated server, every player's places are invisible right now and new ones are being `
           + `written elsewhere. If it is not, that store holds data that belongs on the dedicated box.`);
    }
  }

  // ASKED BY PRESENCE FIRST, for the same reason the PUBLIC_STORE check above is — and this is where that
  // rule was written down and then not applied. On a fresh install this directory has never been created,
  // so the guarded read below fired `guardExternalSync`'s own ⚠️ line before the ENOENT branch could
  // decide it was not news: **the first thing a new person saw was the word "failed"**, about a folder
  // whose absence is the correct state of a machine nobody has hired a contractor on yet. The branch that
  // suppressed the REPORT could never suppress the guard's warning, because the guard logs at the moment
  // it catches. A directory either exists or it does not, which is a question with an answer.
  if (!fs.existsSync(MEMORY_DIR)) return out;

  const listed = guardExternalSync(TAG, `list ${MEMORY_DIR}`, () => fs.readdirSync(MEMORY_DIR));
  if (!listed.ok) {
    // IT EXISTED A MOMENT AGO AND WOULD NOT READ, which is news whatever the code: player memory may be
    // sitting there and not being loaded.
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
           + `not loaded and will not be overwritten. Move or repair the file, then restart the overseer.`);
      continue;
    }
    const doc = read.value;
    if (!doc || typeof doc !== 'object') continue;
    for (const [k, v] of Object.entries(doc.buildings || {})) { out.buildings[k] = v; rooms++; }
    for (const [k, v] of Object.entries(doc.stations  || {})) { out.stations[k]  = v; stations++; }
    players++;
    // A CHAIR ON DISK AT LOAD TIME IS A LIE, ALWAYS. Nothing is connected yet — this process has not
    // opened its socket — so any chair here belongs to a body that stopped while the last overseer was
    // down and could not prune it. Chairs are never read back into the live mirror (see the two loops
    // above: only places are), so this write is not about correctness of state; it is about the file
    // telling the truth to the Architect the moment he opens it, which is the whole reason chairs are
    // in this document at all. Cleared here rather than left for the first save because there may be
    // no first save: a run where nobody joins never writes, and the ghost would outlive the run.
    const stale = Object.keys(doc.chairs || {}).length;
    if (stale) {
      doc.chairs = {};
      // Stamped, because this write CHANGED the file. Leaving the old time would make the one field
      // he would use to ask "when did this last move?" quietly wrong.
      doc.updated_at = new Date().toISOString();
      const swept = guardExternalSync(TAG, `clear stale chairs in ${name}`,
        () => durableWrite(path.join(MEMORY_DIR, name), JSON.stringify(doc, null, 2)));
      if (swept.ok) report(`${TAG}: ${name} carried ${stale} chair(s) from bodies that are gone — cleared.`);
      else report(`${TAG}: could not clear stale chair(s) in ${name} (${swept.reason}) — the places loaded `
                + `fine; the chairs shown in that file are last run's and will be corrected on the next save.`);
    }
  }
  if (players) report(`${TAG}: loaded ${players} player HQ file(s) — ${rooms} building(s), ${stations} station(s).`);
  return out;
}

// ── SAVE ────────────────────────────────────────────────────────────────────────────────────────────
//
// save(buildings, stations, chairsByOwner, report) — debounced. The caller hands the whole merged view
// and this splits it by owner; nothing here decides anything (Law 3 — the overseer's stores are a merge,
// and this is that merge reaching disk).
//
// EVERY SAVE REWRITES A PLAYER'S FILE WHOLE, which is correct here and is NOT the hazard the two-writer
// case had: there is exactly one writer, and the map it writes from is the overseer's merged view, which
// already contains everything any bot has ever sent up this run PLUS everything loaded at start. There is
// no other party whose rows could be lost.
//
// A PLAYER WITH NO ROWS IS NOT WRITTEN AND NOT DELETED. Writing an empty file for every name that ever
// connected would litter the store; deleting one because this run has nothing to say about it would be
// this process making his hand-deletion decision for him.
// LEADING EDGE, NOT TRAILING — the first change after a quiet spell reaches disk NOW, and only a BURST
// is coalesced. A pure trailing debounce means an idle overseer holds a brand-new buildspot in memory for
// twenty seconds, and this process has no exit path of its own: `down` terminates it by pid, so a signal
// handler that flushed on the way out is a handler a hard kill never runs. Bounding the exposure is worth
// more than a graceful-shutdown hook that only works on the shutdowns that were already gentle. The
// coalescing still does its job — a crew placing rooms in a burst writes once at the end of it.
// `forceOwners` — owners whose file must be written EVEN IF they now have nothing to say. It exists for
// exactly one caller, the wipe, and without it the wipe silently does nothing on disk: the rule below is
// that an owner with no rows is not written, so striking a player's LAST building leaves their old file
// standing with the house still in it, and the next overseer start loads it straight back. The emptiness
// is the news in that case, and this is how it gets told (Architect: *"that owner can wipe the memory"*).
function save(buildings, stations, chairsByOwner, report, forceOwners) {
  _pending = { buildings, stations, chairsByOwner, report, forceOwners };
  if (_timer) return;
  if (Date.now() - _lastWrite >= SAVE_INTERVAL_MS) { _saveNow(); return; }
  _timer = setTimeout(_saveNow, SAVE_INTERVAL_MS - (Date.now() - _lastWrite));
  if (_timer.unref) _timer.unref();
}

function _saveNow() {
  _timer = null;
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
  // CHAIRS ARE ADDED TO OWNERS THAT ALREADY HAVE A BUCKET **AND** TO OWNERS THAT DO NOT — a crew that has
  // built nothing yet is still a crew he may want to look at. This is the only place a file can come into
  // existence for a player with no places.
  for (const [o, chairs] of Object.entries(job.chairsByOwner || {})) {
    if (OWNER.test(o)) bucket(o).chairs = chairs;
  }
  // A WIPED OWNER GETS A BUCKET WHETHER OR NOT ANYTHING IS LEFT IN IT. Opening the bucket is the whole
  // job here — everything above has already filled it with whatever survived the strike, which for a
  // full wipe is nothing at all, and that empty file is the correct record of what the player asked for.
  for (const o of (job.forceOwners || [])) {
    if (OWNER.test(o)) bucket(o);
  }

  const made = guardExternalSync(TAG, `create ${MEMORY_DIR}`, () => fs.mkdirSync(MEMORY_DIR, { recursive: true }));
  if (!made.ok) { job.report(`${TAG}: could not create ${MEMORY_DIR} (${made.reason}) — player memory NOT saved.`); return; }

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
    // REPORTED, NEVER THROWN. A failed save must not take the overseer down — it is serving live bots,
    // and the merged view in memory is still authoritative and still gets another chance on the next
    // save. durableWrite is all-or-nothing, so a failure has changed nothing on disk.
    const wrote = guardExternalSync(TAG, `durable replace of ${fileFor(owner)}`,
      () => durableWrite(fileFor(owner), JSON.stringify(body, null, 2)));
    if (!wrote.ok) job.report(`${TAG}: could not save ${owner}'s HQ (${wrote.reason}) — it is still in memory and will retry.`);
  }
}

// flushNow — for a deliberate shutdown, so the last twenty seconds of work are not lost to the debounce.
function flushNow() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _saveNow();
}

module.exports = { loadAll, save, flushNow, MEMORY_DIR };
