'use strict';
// foreman_plan.js — the run as configured: foreman_config's fields, checked whole and said back in words.
//
// Read once, at the top of foreman.js, before the hub restores the fleet's memory: a 'rollback' start
// empties that memory, so this must check it before the hub loads it (Law 13). Every field names the
// values it permits (Law 29); anything else is refused by name and nothing starts.

const fs = require('fs');
const path = require('path');

const CONFIG = require('../foreman_config');
const { BOT_MODES, BUILDER_BUILDS, BOT_SENIORITY, CREW_DIFFICULTY, CREW_BUILD } = require('@thinking/architect_config');
const { guardExternalSync } = require('@utils/external_library_guard');
const testModes = require('./utils/test_modes');

const PERMITTED = {
  where: ['local', 'remote'],
  start: ['rollback', 'continue'],
  crew: [BOT_MODES.HOMESTEADER, BOT_MODES.BUILDER],
  clock: ['dawn', 'day', 'held'],
  record: ['off', 'cameras', 'film'],
  go: ['now', 'held'],
  ends: ['soak', 'built', 'real'],
  landing: ['usual', 'random'],
  windowsPriority: ['normal', 'high'],
  memoryWorkspace: ['adaptive', 'off'],
};
const WAKES = ['error', 'death'];

// check() → { ok, wrong: [sentence…] } — every fault at once, so one edit of the page fixes them all.
function check() {
  const wrong = [];
  for (const [key, allowed] of Object.entries(PERMITTED)) {
    if (!allowed.includes(CONFIG[key])) {
      wrong.push(`${key}: '${CONFIG[key]}' is not one of ${allowed.map(v => `'${v}'`).join(' | ')}.`);
    }
  }
  if (typeof CONFIG.soak !== 'number' || !Number.isFinite(CONFIG.soak) || CONFIG.soak < 0) {
    wrong.push(`soak: '${CONFIG.soak}' is not a number of minutes (0 runs until you stop it).`);
  }
  if (typeof CONFIG.watch !== 'boolean') wrong.push(`watch: '${CONFIG.watch}' is not true or false.`);
  if (!['crew', 'none'].includes(CONFIG.cameras)
      && !(Number.isInteger(CONFIG.cameras) && CONFIG.cameras > 0)) {
    wrong.push(`cameras: '${CONFIG.cameras}' is not 'crew', 'none', or a whole number of windows above zero.`);
  }
  const t = testModes.check(CONFIG.test);
  if (!t.ok) wrong.push(`test: ${t.why}`);
  const testStart = testModes.startFor(CONFIG.test);
  if (testStart && CONFIG.start !== testStart) {
    wrong.push(`start: test '${CONFIG.test}' looks at the world the last run left, so it needs start '${testStart}' — `
      + `'${CONFIG.start}' would put the world back to its clean copy and empty the fleet's memory first.`);
  }
  const wakes = Array.isArray(CONFIG.wake) ? CONFIG.wake : [];
  for (const w of wakes) if (!WAKES.includes(w)) wrong.push(`wake: '${w}' is not one of ${WAKES.map(v => `'${v}'`).join(' | ')}.`);
  if (!Array.isArray(CONFIG.wake)) wrong.push(`wake: must be a list, e.g. ['error', 'death'].`);
  if (CONFIG.crew === BOT_MODES.BUILDER || CONFIG.crew === BOT_MODES.HOMESTEADER) {
    const count = CONFIG.count;
    const available = Object.keys(BOT_SENIORITY).length;
    if (CONFIG.only) {
      const unknown = CONFIG.only.filter(name => !BOT_SENIORITY[name]);
      if (unknown.length) wrong.push(`only: ${unknown.map(v => `'${v}'`).join(', ')} not in the roster (BOT_SENIORITY).`);
    } else if (!Number.isInteger(count) || count < 2 || count > available) {
      wrong.push(`count: '${count}' must be a whole number from 2 to ${available}, the available roster.`);
    }
  }
  if (CONFIG.crew === BOT_MODES.BUILDER) {
    const build = CONFIG.builder && CONFIG.builder.build;
    if (!BUILDER_BUILDS[build]) {
      wrong.push(`builder.build: '${build}' is not a building a builder crew knows. Known: `
        + `${Object.keys(BUILDER_BUILDS).map(v => `'${v}'`).join(' | ')}.`);
    }
  }
  if (endsWhenBuilt() && !CREW_BUILD[CONFIG.crew]) {
    wrong.push(`ends: '${CONFIG.ends}' ends the run when the building stands, but this crew has no configured large build. Use 'soak'.`);
  }
  return { ok: wrong.length === 0, wrong };
}

// A test run raises no bots and has no soak. The one place that knows what 'off' means (Law 16).
function isTest() { return CONFIG.test !== 'off'; }
function testName() { return CONFIG.test; }

// A test that keeps the one camera window a person flies, with no bot window beside it.
function seatOnly() { return isTest() && testModes.keepsSeat(CONFIG.test); }

// The cameras this run really has. A test raises no bodies, so it has no camera on one; a seat-only test
// has its seat whatever the page says, since the seat is what it is run for.
function record() {
  if (!isTest()) return CONFIG.record;
  if (!seatOnly()) return 'off';
  return CONFIG.record === 'off' ? 'cameras' : CONFIG.record;
}

// A continued run carries on from the last one: the base is the one in memory and every body starts where
// the last run left it standing. The one place that knows what 'continue' means for the crew (Law 16).
function continues() { return CONFIG.start === 'continue'; }

function build() { return CREW_BUILD[CONFIG.crew] || null; }

// Does the run end the moment the building stands? The one place that knows what 'built' means for the run (Law 16).
function endsWhenBuilt() { return CONFIG.ends === 'built' || CONFIG.ends === 'real'; }
// 'real' waits further: no cell of the building still stands as its planks (architect_config.STAND_INS).
function endsWhenReal() { return CONFIG.ends === 'real'; }
// A held crew is raised and placed, and waits for the operator's `start` before any body works.
function heldForGo() { return CONFIG.go === 'held'; }

// Does the foreman roll where a crew it raises lands? The one place that knows what 'random' means for the run (Law 16).
function landsAtRandom() { return CONFIG.landing === 'random'; }

// Builds the sentence from the fields; the sentence itself is never stored.
function sentence() {
  const difficulty = CREW_DIFFICULTY[CONFIG.crew];
  const species = `${CONFIG.count} ${CONFIG.crew === BOT_MODES.BUILDER ? 'builders' : 'homesteaders'}${build() ? ` making ${build().replace(/_/g, ' ')}` : ''} on ${difficulty}`;
  // The landing is said for a run that lands a crew: a rollback start of a crew the foreman raises itself.
  const crew = landsAtRandom() && !continues() ? `${species}, landing at random` : species;
  // A test states its own name in place of a soak length: a test raises no bots and keeps no soak.
  if (isTest()) return `${CONFIG.where} world · ${CONFIG.start} start · TEST ${CONFIG.test}, no bots raised · for ${crew}`;
  const length = CONFIG.soak > 0 ? `${CONFIG.soak} minutes` : 'until stopped';
  const soak = endsWhenBuilt() ? `until the building stands${endsWhenReal() ? ' with no planks standing in' : ''} (${CONFIG.soak > 0 ? `${CONFIG.soak} minutes at most` : 'no time limit'})` : length;
  return`${CONFIG.where} world · ${CONFIG.start} start · ${soak} · ${crew}`;
}
// The overlays, said after the sentence: the clock, the cameras, and whether the run is watched.
function overlays() {
  // A test has no bot cameras (no bodies to frame) and no watch (the watch reads a fleet). Both are stated
  // as absent, so the header never implies one is running.
  const eye = CONFIG.observer ? `watched by ${CONFIG.observer}` : null;
  if (isTest()) return [`clock ${CONFIG.clock}`, seatOnly() ? 'a seat to fly, no bot cameras' : 'no cameras', 'not watched', testModes.describe(CONFIG.test), eye].filter(Boolean).join(' · ');
  return [`clock ${CONFIG.clock}`, CONFIG.record === 'off' ? 'no cameras' : CONFIG.record,
    CONFIG.watch ? `watched (wakes on ${CONFIG.wake.join(', ')})` : 'not watched', heldForGo() ? 'crew held for start' : null, eye].filter(Boolean).join(' · ');
}

// ── A ROLLBACK START EMPTIES THE FLEET'S MEMORY ──────────────────────────────────────────────────────
// Both halves of what the bots know, together, as the workshop's run always did: the hub's per-crew memory
// (`player_memory/`, crew_memory) and each bot's own headquarters file. 'continue' touches neither.
const BOT_DIR = path.join(__dirname, '..');
function emptyMemory(log) {
  if (CONFIG.start !== 'rollback') { log('start: continue — the bots carry on with what they knew.'); return; }
  const kernel = path.join(BOT_DIR, 'js_kernel');
  const files = fs.existsSync(kernel) ? fs.readdirSync(kernel).filter(f => /^corporate_headquarters\..*\.json$/.test(f)) : [];
  const memory = path.join(BOT_DIR, 'player_memory');
  const r = guardExternalSync('foreman', 'empty the fleet memory', () => {
    for (const f of files) fs.rmSync(path.join(kernel, f));
    fs.rmSync(memory, { recursive: true, force: true });
  });
  log(r.ok
    ? `start: rollback — the bots start knowing nothing (${files.length} headquarters file(s) and the fleet's memory emptied).`
    : `WARNING start: rollback, but the fleet's memory could not be emptied — ${r.reason}. The bots may remember the last run.`);
}

// ── A ROLLBACK START PUTS A LOCAL WORLD BACK TO ITS CLEAN COPY, IF IT HAS ONE ─────────────────────────
// The copy is `world_snapshots/<world>/<world>_fresh_start` in the server folder. The current world is
// deleted and the copy is laid in its place: the foreman saves no world, and a world worth keeping is saved
// by a person before the run. Called by foreman_world with the server down: a world copied under a running
// server is files mid-write.
// freshWorld(serverDir) → { worldName, snapshot }: the world a rollback start puts back and the copy it uses —
// the one statement of the naming rule, which the workshop's benches read too (Law 16).
function freshWorld(serverDir) {
  const worldName = require('@utils/server_settings').levelName(serverDir);
  return { worldName, snapshot: `${worldName}_fresh_start` };
}
function restoreFreshWorld(serverDir, level, log) {
  if (CONFIG.start !== 'rollback') return { restored: false };
  const snaps = path.join(serverDir, 'world_snapshots');
  const fresh = path.join(snaps, level, freshWorld(serverDir).snapshot);
  if (!fs.existsSync(fresh)) {
    log(`start: rollback — this server has no clean copy of '${level}' (looked for ${fresh}), so the world is used as it is.`);
    return { restored: false };
  }
  const world = path.join(serverDir, level);
  const r = guardExternalSync('foreman', `restore '${level}' from its clean copy`, () => {
    fs.rmSync(world, { recursive: true, force: true });
    fs.cpSync(fresh, world, { recursive: true });
  });
  if (!r.ok) return { restored: false, error: `the world '${level}' could not be put back to its clean copy: ${r.reason}` };
  log(`start: rollback — the world '${level}' was put back to its clean copy; the world it replaced is deleted.`);
  return { restored: true };
}

// ── WHERE THE RUN HAS GOT TO, for anybody who asks the door (bench_world waits on it) ─────────────────
//   crew      'waiting' (nothing raised yet, or a test) · 'raising' · 'working' · 'failed'
//   soakEndsAt  when the soak ends, ISO, or null (not started, or 0 = until stopped)
//   closing   why the foreman is shutting down, once it is — the watch reads this as "the run is over"
const progress = { sentence: null, crew: 'waiting', soakEndsAt: null, closing: null };
function note(fields) { Object.assign(progress, fields); }
function progressNow() { return { ...progress, sentence: sentence() }; }

module.exports = { CONFIG, check, sentence, overlays, isTest, testName, seatOnly, record, continues, build, endsWhenBuilt, endsWhenReal, heldForGo, landsAtRandom, emptyMemory, freshWorld, restoreFreshWorld, note, progressNow };
