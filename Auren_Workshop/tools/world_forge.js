// Auren_Workshop/tools/world_forge.js
// Generates a candidate world, proves a bot can live in it, and reports the measurements against stated
// criteria.
//
// THE CRITERIA ARE HIS, AND THIS FILE ONLY COMPARES AGAINST THEM (Law 25). ACCEPTABLE_BIOMES below is
// his biome criterion made executable and is his to edit. "Close to world center" and "too high" carry
// no number from him, so those are flags with defaults, and the report names each default as the tool's
// own, not a measured fact.
//
// THE FOREMAN BRINGS THE CANDIDATE UP, the one way every world comes up. This file writes level-name and
// level-seed while nothing runs, then asks the foreman for that world with no crew; the foreman's own
// proved steps generate it, start the server, join its body and read the world spawn, which it publishes
// on its door (`run.spawn`). Where bodies land IS the world spawn, so the spawn checks read that. A
// candidate the foreman cannot bring up has failed before a single measurement is taken.
//
// `level-name` says which world to point at and is fleet_control's; `level-seed` is a world-generation
// input that only means anything at the moment a folder is created, so it is authored here while the
// server is STOPPED (Law 26 — build while off, drive while on). A live server reads both exactly once,
// at JVM start.
//
// Usage:
//   node tools/world_forge.js try  --name=NAME [--seed=N] [--replace] [--down]
//   node tools/world_forge.js keep --name=NAME [--snapshot=NAME]   (server must be down)
//   node tools/world_forge.js                                       (this help)
//
// Exit codes: 0 the candidate met every criterion · 2 it generated and was measured but missed · 1 the
//             attempt could not be completed (no bot, no rcon, refused precondition). 2 is not an
//             error — a candidate honestly reporting it is not the one.

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/world_forge.js');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const benchWorld = require('../bench_world');

const paths = require('../workshop_paths');
const TOOLS_DIR = __dirname;
const REPO_ROOT = paths.REPO_ROOT;
const SERVER_DIR = require(paths.bot('js_kernel/utils/workstation')).needServerDir();
const SNAPSHOT_DIR = path.join(SERVER_DIR, 'world_snapshots');
const PROPS = path.join(SERVER_DIR, 'server.properties');
const FLEET = paths.workshop('fleet_control.js');

// The operator's biome criterion for world center, as an editable list: flat, walkable ground, forested
// or open. Jungle, swamp, desert, badlands, snowy/peak/ocean variants and caves are excluded — terrain
// that would confound a locomotion or combat measurement.
const ACCEPTABLE_BIOMES = [
  'minecraft:plains', 'minecraft:sunflower_plains', 'minecraft:meadow',
  'minecraft:forest', 'minecraft:birch_forest', 'minecraft:flower_forest',
  'minecraft:dark_forest', 'minecraft:old_growth_birch_forest', 'minecraft:taiga',
];

// Worlds this tool may never delete, whatever the flags read. A snapshot existing for a world is proof
// someone means to keep it; a forge candidate by definition has none yet.
const HARD_DENY = new Set(['Test world', 'work world']);

const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const flags = new Map(argv.filter(a => a.startsWith('--')).map(a => {
  const i = a.indexOf('=');
  return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const has = k => flags.has(k);
const opt = (k, d) => (flags.has(k) && flags.get(k) !== true ? String(flags.get(k)) : d);

// ── Defaults this tool owns, and says so ─────────────────────────────────────────────────────────
// Named so the report can print where each number came from. The operator set the biome criterion in
// words and set no number for these two; they are the tool's until he rules.
const DEFAULT_CENTER_RADIUS = 200;   // blocks from (0,0) — Minecraft's own spawn search fans out from center
const DEFAULT_MAX_Y = 100;           // above this is the "mountain" half of "a mountain in the ocean"
const DEFAULT_MIN_Y = 60;            // at/below sea level (63) is the "ocean" half

// A world can be flat, forested and centred and still have no water within reach of spawn, and the
// base-layout job anchors the run on a wheat plot pair. River proximity is the proxy for that — it is
// what `locate biome` can answer cheaply, and it is where the open water actually is.
//
// THIS THRESHOLD IS THE TOOL'S, a proxy for a criterion owned by the base-layout blueprint, not this
// file (Law 16: the authoritative check is running the fleet and seeing whether the base anchors). This
// only stops candidates that obviously cannot, before that costs a bring-up.
const DEFAULT_WATER_RADIUS = 120;

const t0 = Date.now();
const el = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
function banner(s) { console.log(`\n${'─'.repeat(94)}\n${el()} ${s}\n${'─'.repeat(94)}`); }

function node(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
}
function fleet(args, inherit = true) {
  return node([FLEET, ...args], inherit ? { stdio: 'inherit' } : {});
}

// ── RCON, read-only ──────────────────────────────────────────────────────────────────────────────
// Goes through fleet_control's one rcon route (Law 16). Prints `rcon: <reply>`; anything else is a
// failure to reach the server, not an answer.
function rcon(command) {
  const r = node([FLEET, 'rcon', command]);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /^rcon: ([\s\S]*)$/m.exec(out);
  if (r.status !== 0 || !m) return { ok: false, reply: out.trim() };
  return { ok: true, reply: m[1].trim() };
}

// `locate biome` answers from the command source's position; `execute positioned 0.0 64.0 0.0` makes it
// a question about world center.
// Reply on success: `The nearest minecraft:forest is at [120, ~, -8] (67 blocks away)`
// Reply on failure: `Could not find a biome of type "minecraft:forest" within reasonable distance`
function biomeDistanceFromCenter(biome) {
  const r = rcon(`execute positioned 0.0 64.0 0.0 run locate biome ${biome}`);
  if (!r.ok) return { found: false, unreachable: true, detail: r.reply };
  const m = /is at \[(-?\d+), *[^,]+, *(-?\d+)\] *\((\d+) blocks? away\)/.exec(r.reply);
  if (!m) return { found: false, unreachable: false, detail: r.reply };
  return { found: true, x: +m[1], z: +m[2], distance: +m[3] };
}


// ── server.properties ────────────────────────────────────────────────────────────────────────────
function setProperty(key, value) {
  const text = fs.readFileSync(PROPS, 'utf8');
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
  fs.writeFileSync(PROPS, re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`);
}
function getProperty(key) {
  const m = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.*)$`, 'm')
    .exec(fs.readFileSync(PROPS, 'utf8'));
  return m ? m[1].trim() : null;
}

// ── try ──────────────────────────────────────────────────────────────────────────────────────────
async function tryCandidate() {
  const name = opt('name', null);
  if (!name) { console.error('world_forge: --name=<world> is required.'); return 1; }

  const worldDir = path.join(SERVER_DIR, name);
  const exists = fs.existsSync(worldDir);

  if (exists && !has('replace')) {
    console.error(`\nworld_forge: '${name}' already exists at ${worldDir}.\n` +
      `  A seed only takes effect when a world folder is CREATED, so re-running against an existing\n` +
      `  folder would silently measure the OLD world while reporting the new seed — a result that\n` +
      `  looks like an answer and is not. Pass --replace to delete it first, or pick another name.`);
    return 1;
  }
  if (exists) {
    // Deleting a world is the one destructive act in this file; the guard runs before it. A snapshot is
    // proof somebody meant to keep this world.
    if (HARD_DENY.has(name) || fs.existsSync(path.join(SNAPSHOT_DIR, name))) {
      console.error(`\nworld_forge: REFUSING to replace '${name}' — it is a kept world (a snapshot exists ` +
        `for it, or it is on the protected list). Forge candidates have no snapshots; that is the test.`);
      return 1;
    }
    if (getProperty('level-name') === name) {
      // The server must be down for the delete to be safe; taking it down happens below. Reported so a
      // running fleet is never a surprise.
      console.log(`\nworld_forge: '${name}' is the world the server is currently pointed at — it will be ` +
        `taken down before the folder is removed.`);
    }
  }

  banner(`FORGE '${name}'${has('seed') ? ` from seed ${opt('seed', '')}` : ' from a random seed'}`);

  // Everything below is authored while the server is STOPPED (Law 26); a live server reads level-name
  // and level-seed once, at JVM start.
  console.log(`${el()} taking any running world down — level-name and level-seed are read at JVM start.`);
  const stopped = await benchWorld.stopRunning();
  if (!stopped.ok) { console.error(`\nworld_forge: ${stopped.why}. Nothing was changed.`); return 1; }

  if (exists) {
    console.log(`${el()} DELETING the previous '${name}' world folder (${worldDir}) — --replace was given.`);
    fs.rmSync(worldDir, { recursive: true, force: true });
  }

  setProperty('level-seed', has('seed') ? opt('seed', '') : '');
  setProperty('level-name', name);
  console.log(`${el()} level-name=${name}  level-seed=${getProperty('level-seed') || '(random)'}`);

  banner(`GENERATE — the foreman brings '${name}' up and proves each step`);
  const up = await benchWorld.up({ start: 'continue' });
  if (!up.ok) {
    console.error(`\n${el()} '${name}' FAILED the first criterion: ${up.why}`);
    await benchWorld.down(up.foreman);
    return 1;
  }
  const code = await vet(name);
  if (has('down')) { console.log(`\n${el()} --down: ${(await benchWorld.down(up.foreman)).why}.`); }
  return code;
}

// ── vet ──────────────────────────────────────────────────────────────────────────────────────────
async function vet(name) {
  const centerRadius = parseFloat(opt('center-radius', String(DEFAULT_CENTER_RADIUS)));
  const maxY = parseFloat(opt('max-y', String(DEFAULT_MAX_Y)));
  const minY = parseFloat(opt('min-y', String(DEFAULT_MIN_Y)));

  banner(`MEASURE '${name}'`);

  // 1. The biome at world center — the strongest of the three checks, since it is a property of the
  //    world itself, not of one spawn roll.
  const hits = [];
  let unreachable = null;
  for (const b of ACCEPTABLE_BIOMES) {
    const d = biomeDistanceFromCenter(b);
    if (d.unreachable) { unreachable = d.detail; break; }
    if (d.found) hits.push({ biome: b, distance: d.distance });
  }
  if (unreachable !== null) {
    console.error(`\n${el()} could not reach the server over rcon — ${unreachable}\n` +
      `  Nothing was measured, so this candidate is UNJUDGED rather than failed.`);
    return 1;
  }
  hits.sort((a, b) => a.distance - b.distance);
  const nearest = hits[0] || null;
  const centerIsAcceptable = !!nearest && nearest.distance === 0;

  // 2. Where bodies land — the world spawn, as the foreman read it off its own body.
  const pos = await benchWorld.spawnNow();
  if (!pos) {
    console.error(`\n${el()} the foreman's door did not report a world spawn (is a foreman running this world?)\n` +
      `  Nothing was measured, so this candidate is UNJUDGED rather than failed.`);
    return 1;
  }
  const fromCenter = Math.round(Math.hypot(pos.x, pos.z));

  // 3. Read out, then judge — kept separate so the numbers are visible even when the verdict is MISSED.
  console.log(`\n  world              : ${name}`);
  console.log(`  seed               : ${getProperty('level-seed') || '(random — the generated one is in level.dat)'}`);
  console.log(`  world spawn        : (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
  console.log(`  distance from 0,0  : ${fromCenter} blocks`);
  console.log(`  biome at 0,0       : ${centerIsAcceptable ? nearest.biome : (nearest ? `NOT an accepted type — nearest accepted is ${nearest.biome} at ${nearest.distance}b` : 'no accepted biome found within range')}`);
  if (hits.length) {
    console.log(`  accepted biomes nearby:`);
    for (const h of hits.slice(0, 5)) console.log(`      ${String(h.distance).padStart(5)}b  ${h.biome}`);
  }

  // 2b. Open water near centre — the base needs a wheat plot pair within reach of spawn.
  const waterRadius = parseFloat(opt('water-radius', String(DEFAULT_WATER_RADIUS)));
  const river = biomeDistanceFromCenter('minecraft:river');
  const waterDist = river.found ? river.distance : Infinity;
  console.log(`  nearest river      : ${river.found ? `${waterDist}b` : 'none within range'}`);

  const checks = [
    { name: 'world centre is a forest/plains type', pass: centerIsAcceptable, owner: 'HIS — stated in words, encoded in ACCEPTABLE_BIOMES' },
    { name: `open water within ${waterRadius}b of centre (the base needs a wheat plot pair)`, pass: waterDist <= waterRadius, owner: has('water-radius') ? 'HIS — given on the command line' : `THE TOOL'S default (${DEFAULT_WATER_RADIUS}b) — added after a world that passed everything else could not anchor a base` },
    { name: `the world spawn is within ${centerRadius}b of world centre`, pass: fromCenter <= centerRadius, owner: has('center-radius') ? 'HIS — given on the command line' : `THE TOOL'S default (${DEFAULT_CENTER_RADIUS}b) — he has not set this number` },
    { name: `the world spawn is between y=${minY} and y=${maxY}`, pass: pos.y >= minY && pos.y <= maxY, owner: (has('min-y') || has('max-y')) ? 'HIS — given on the command line' : `THE TOOL'S default (${DEFAULT_MIN_Y}–${DEFAULT_MAX_Y}) — stands in for "not a mountain, not the ocean"` },
  ];

  banner(`VERDICT for '${name}'`);
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    console.log(`       criterion owner: ${c.owner}`);
  }
  const met = checks.every(c => c.pass);
  console.log(`\n  ${met ? '✅ MET every criterion' : '❌ MISSED — this is not the world'}`);

  if (!has('down')) console.log(`\n${el()} the foreman is STILL RUNNING '${name}' (window 'auren desk') so the ground can be ` +
    `looked at. Stop it with: node Auren_Workshop/fleet_control.js verb shutdown`);

  if (met) {
    console.log(`\n  Keep it with:  node Auren_Workshop/tools/world_forge.js keep --name=${name}   (stops the world first)`);
  } else {
    console.log(`\n  Try another:   node Auren_Workshop/tools/world_forge.js try --name=${name} --replace [--seed=N]`);
  }
  return met ? 0 : 2;
}

// ── keep ─────────────────────────────────────────────────────────────────────────────────────────
// Delegates to fleet_control's snapshot, which delegates to rollback.ps1 — the one implementation, and
// the one that already refuses while the server is up (a snapshot of a live world is a torn copy).
async function keep() {
  const name = opt('name', null);
  if (!name) { console.error('world_forge: --name=<world> is required.'); return 1; }
  const snapshot = opt('snapshot', `${name}_fresh_start`);
  banner(`KEEP '${name}' as snapshot '${snapshot}'`);
  const stopped = await benchWorld.stopRunning();
  if (!stopped.ok) { console.error(`\nworld_forge: ${stopped.why}, so no clean copy can be taken.`); return 1; }
  const r = fleet(['snapshot', `--world=${name}`, `--name=${snapshot}`]);
  if (r.status !== 0) { console.error(`\nworld_forge: the snapshot did not complete.`); return 1; }
  // The hint names the fields to set, not a command line to type — a run's world is authored now (Law 16).
  console.log(`\n  '${name}' is now restorable. To run on it, make it the server's world (level-name '${name}'\n` +
    `  in server.properties) and start the foreman with start 'rollback' in foreman_config.js — it puts\n` +
    `  the world back to its fresh-start copy before the server starts:\n` +
    `    node start_auren.js`);
  return 0;
}

function usage() {
  console.error(`
world_forge — generate a candidate world, prove a bot can live in it, measure it against the criteria.

  node tools/world_forge.js try  --name=NAME [--seed=N] [--replace] [--down]
  node tools/world_forge.js vet  --name=NAME            (measure a world the fleet is ALREADY up on)
  node tools/world_forge.js keep --name=NAME [--snapshot=NAME]     (server must be down)

  --replace          delete an existing candidate folder first. Refused for any world that has a
                     snapshot — having one is the proof it is not a candidate.
  --center-radius=N  how close to (0,0) the bot must spawn. Default ${DEFAULT_CENTER_RADIUS}. THE TOOL'S NUMBER, not his.
  --min-y / --max-y  the "not the ocean / not a mountain" band. Default ${DEFAULT_MIN_Y}–${DEFAULT_MAX_Y}. THE TOOL'S NUMBERS.
  --down             tear the fleet down after measuring (default: leave it up to look at).

Exit: 0 met every criterion · 2 measured and MISSED (try another seed) · 1 could not be completed.
`);
}

if (require.main === module) {
  const verb = positional[0];
  const run = verb === 'try' ? tryCandidate : verb === 'vet' ? () => vet(opt('name', '')) : verb === 'keep' ? keep : async () => { usage(); return 1; };
  run().then(code => process.exit(code));
}

module.exports = { ACCEPTABLE_BIOMES, HARD_DENY, DEFAULT_CENTER_RADIUS, DEFAULT_MIN_Y, DEFAULT_MAX_Y };
