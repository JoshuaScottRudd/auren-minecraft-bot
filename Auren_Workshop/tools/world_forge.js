// Auren_Workshop/tools/world_forge.js
// Generate a candidate world, prove a bot can actually live in it, and report the measurements — so a
// test world is CHOSEN against stated criteria instead of accepted because it happened to generate.
//
// WHY (Architect 2026-08-08): the conductor and the lanista bench were sharing one world, so a standard
// test's rollback would destroy whatever the combat session was standing on. Separating them needs a
// second world, and a second world is only useful if the ground is usable: "some spawn the bots on a
// mountain in the ocean. best way to know is if the bots spawn close to world center and its a forest
// biome. or better yet, world center biome should be a forest or plain type."
//
// THE CRITERIA ARE HIS, AND THIS FILE ONLY COMPARES AGAINST THEM (Law 25). He set the biome test in
// words, so ACCEPTABLE_BIOMES below is his sentence made executable and is meant to be edited by him.
// He did NOT set a number for "close to world center" or for how high is too high, so this file does
// not quietly own one: both are flags with defaults, and the report SAYS the default was the tool's
// rather than presenting it as a measured fact. A performer that invents the threshold and then stamps
// PASS against it has usurped the one number only the asker can set.
//
// IT REUSES THE WHOLE EXISTING BRING-UP AND ADDS NO GATE (Law 22 gate 2). `fleet_control up --world=X`
// already repoints level-name, generates the world on first launch, starts the fleet, and waits on each
// bot's own "Online at (" line before returning. So "can the bots use it" is answered by the gate that
// already exists — this file spends no effort re-asking it, and a candidate that fails to bring a bot
// online has failed the most important criterion before a single measurement is taken.
//
// WHY THE SEED IS WRITTEN HERE AND NOT BY fleet_control: `level-name` says which world to point at and
// is fleet_control's; `level-seed` is a world-GENERATION input that only means anything at the moment a
// folder is created, and it is authored while the server is STOPPED (Law 26 — build while off, drive
// while on). Writing it into a live server would be authoring an internal of a running machine, and it
// would also do nothing, which is the worse half: a silent no-op that looks like a control.
//
// Usage:
//   node tools/world_forge.js try  --name=NAME [--seed=N] [--replace] [--down]
//   node tools/world_forge.js keep --name=NAME [--snapshot=NAME]   (server must be down)
//   node tools/world_forge.js                                       (this help)
//
// Exit codes: 0 the candidate MET his criteria · 2 it generated and was measured but MISSED · 1 the
//             attempt could not be completed (no bot, no rcon, refused precondition).
// 2 IS NOT AN ERROR — it is a candidate honestly reporting it is not the one. Try another seed.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('../workshop_paths');
const TOOLS_DIR = __dirname;
const REPO_ROOT = paths.REPO_ROOT;
const SERVER_DIR = paths.repo('MinecraftServer');
const SNAPSHOT_DIR = path.join(SERVER_DIR, 'world_snapshots');
const PROPS = path.join(SERVER_DIR, 'server.properties');
const FLEET = paths.workshop('fleet_control.js');

// His words — "world center biome should be a forest or plain type" — as an editable list. Grouped so
// the reasoning survives an edit: flat/walkable ground with trees or without, and nothing whose defining
// feature is that a body cannot cross it. Jungle, swamp, desert, badlands, any snowy/peak/ocean variant
// and the caves are excluded ON PURPOSE, not by oversight: they are the "mountain in the ocean" family
// he named, plus the ones whose terrain would confound a locomotion or combat measurement.
const ACCEPTABLE_BIOMES = [
  'minecraft:plains', 'minecraft:sunflower_plains', 'minecraft:meadow',
  'minecraft:forest', 'minecraft:birch_forest', 'minecraft:flower_forest',
  'minecraft:dark_forest', 'minecraft:old_growth_birch_forest', 'minecraft:taiga',
];

// Worlds this tool may never delete, however the flags read. A mistyped `--name=sub_agent_01 --replace`
// would otherwise erase the world both sessions work in. The rule is deliberately broader than a deny
// list: ANY world someone bothered to snapshot is someone's, and a forge candidate by definition has no
// snapshot yet — so having one is the proof it is not a candidate.
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
// Named constants rather than inline numbers so the report can print WHERE each came from. The Architect
// set the biome criterion in words and set no number for these two; they are the tool's until he rules.
const DEFAULT_CENTER_RADIUS = 200;   // blocks from (0,0) — Minecraft's own spawn search fans out from center
const DEFAULT_MAX_Y = 100;           // above this is the "mountain" half of "a mountain in the ocean"
const DEFAULT_MIN_Y = 60;            // at/below sea level (63) is the "ocean" half

// MEASURED, not guessed (2026-08-08). The first world that met every criterion above still could not
// host a standard test: the conductor's own short soak surfaced
//     wheat_plot_pair: ✗ NOT FOUND — 0 plots (water 160, candidates 10). The base has no anchor.
// A world can be flat, forested, and centred and still have no water within reach of spawn, and the
// base-layout job anchors the whole run on a wheat plot pair. So "the bots can use it" needs a fourth
// measurement that the three above cannot see. River proximity is the proxy — it is what `locate biome`
// can answer cheaply, and it is where the open water actually is.
//
// THIS THRESHOLD IS THE TOOL'S, and it is a proxy for a criterion owned by the base-layout blueprint,
// not by this file. It is deliberately NOT a re-derivation of that blueprint's rule (which would be a
// second place the same question lives, Law 16): the authoritative check is still running the fleet and
// seeing whether the base anchors. This only stops candidates that obviously cannot, before that costs
// a bring-up.
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
// Goes through fleet_control's one rcon route rather than opening a second socket implementation
// (Law 16). It prints `rcon: <reply>`; anything else is a failure to reach the server, not an answer.
function rcon(command) {
  const r = node([FLEET, 'rcon', command]);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /^rcon: ([\s\S]*)$/m.exec(out);
  if (r.status !== 0 || !m) return { ok: false, reply: out.trim() };
  return { ok: true, reply: m[1].trim() };
}

// `locate biome` answers from the COMMAND SOURCE's position, so `execute positioned 0 ~ 0` is what makes
// this a question about world center rather than about wherever the console happens to be.
// Reply on success: `The nearest minecraft:forest is at [120, ~, -8] (67 blocks away)`
// Reply on failure: `Could not find a biome of type "minecraft:forest" within reasonable distance`
function biomeDistanceFromCenter(biome) {
  const r = rcon(`execute positioned 0.0 64.0 0.0 run locate biome ${biome}`);
  if (!r.ok) return { found: false, unreachable: true, detail: r.reply };
  const m = /is at \[(-?\d+), *[^,]+, *(-?\d+)\] *\((\d+) blocks? away\)/.exec(r.reply);
  if (!m) return { found: false, unreachable: false, detail: r.reply };
  return { found: true, x: +m[1], z: +m[2], distance: +m[3] };
}

// Reply: `AurenBot has the following entity data: [123.5d, 68.0d, -45.2d]`
function botPosition(bot) {
  const r = rcon(`data get entity ${bot} Pos`);
  if (!r.ok) return { ok: false, detail: r.reply };
  const m = /\[(-?[\d.]+)d, *(-?[\d.]+)d, *(-?[\d.]+)d\]/.exec(r.reply);
  if (!m) return { ok: false, detail: r.reply };
  return { ok: true, x: +m[1], y: +m[2], z: +m[3] };
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
function tryCandidate() {
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
    // Deleting a world is the one destructive act in this file, so the guards are checked before it and
    // are broader than a name list: a snapshot is proof somebody meant to keep this world.
    if (HARD_DENY.has(name) || fs.existsSync(path.join(SNAPSHOT_DIR, name))) {
      console.error(`\nworld_forge: REFUSING to replace '${name}' — it is a kept world (a snapshot exists ` +
        `for it, or it is on the protected list). Forge candidates have no snapshots; that is the test.`);
      return 1;
    }
    if (getProperty('level-name') === name) {
      // Not fatal in principle, but the server must be down for the delete to be safe, and taking it
      // down is below. Report it so a running fleet is never a surprise.
      console.log(`\nworld_forge: '${name}' is the world the server is currently pointed at — it will be ` +
        `taken down before the folder is removed.`);
    }
  }

  banner(`FORGE '${name}'${has('seed') ? ` from seed ${opt('seed', '')}` : ' from a random seed'}`);

  // Everything below is authored while the server is STOPPED. A live server reads level-name and
  // level-seed exactly once, at JVM start, so writing them into a running one is a silent no-op.
  console.log(`${el()} taking any running fleet down — level-name and level-seed are read at JVM start.`);
  fleet(['down']);

  if (exists) {
    console.log(`${el()} DELETING the previous '${name}' world folder (${worldDir}) — --replace was given.`);
    fs.rmSync(worldDir, { recursive: true, force: true });
  }

  setProperty('level-seed', has('seed') ? opt('seed', '') : '');
  console.log(`${el()} level-seed=${getProperty('level-seed') || '(random)'}`);

  // ONE command generates the world, launches the fleet, and waits on the bot's own online marker. If
  // this fails, the candidate has failed the criterion that matters most and no measurement is needed.
  banner(`GENERATE + PROVE A BOT CAN LIVE IN IT — fleet_control up --count=1 --world=${name}`);
  const up = fleet(['up', '--count=1', `--world=${name}`]);
  if (up.status !== 0) {
    console.error(`\n${el()} '${name}' FAILED the first criterion: no bot reached ONLINE in it. ` +
      `The failing gate is named in the output above; this file does not diagnose it.`);
    return 1;
  }

  return vet(name);
}

// ── vet ──────────────────────────────────────────────────────────────────────────────────────────
function vet(name) {
  const centerRadius = parseFloat(opt('center-radius', String(DEFAULT_CENTER_RADIUS)));
  const maxY = parseFloat(opt('max-y', String(DEFAULT_MAX_Y)));
  const minY = parseFloat(opt('min-y', String(DEFAULT_MIN_Y)));
  const bot = opt('bot', 'AurenBot');

  banner(`MEASURE '${name}'`);

  // 1. The biome AT WORLD CENTER — his "or better yet" criterion, and the strongest of the three,
  //    because it is a property of the world rather than of one spawn roll.
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

  // 2. Where the body actually landed.
  const pos = botPosition(bot);
  if (!pos.ok) {
    console.error(`\n${el()} the server did not report ${bot}'s position — ${pos.detail}\n` +
      `  Nothing was measured, so this candidate is UNJUDGED rather than failed.`);
    return 1;
  }
  const fromCenter = Math.round(Math.hypot(pos.x, pos.z));

  // 3. Read out, then judge — kept separate so the numbers are visible even when the verdict is MISSED.
  console.log(`\n  world              : ${name}`);
  console.log(`  seed               : ${getProperty('level-seed') || '(random — the generated one is in level.dat)'}`);
  console.log(`  ${bot} spawned at  : (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
  console.log(`  distance from 0,0  : ${fromCenter} blocks`);
  console.log(`  biome at 0,0       : ${centerIsAcceptable ? nearest.biome : (nearest ? `NOT an accepted type — nearest accepted is ${nearest.biome} at ${nearest.distance}b` : 'no accepted biome found within range')}`);
  if (hits.length) {
    console.log(`  accepted biomes nearby:`);
    for (const h of hits.slice(0, 5)) console.log(`      ${String(h.distance).padStart(5)}b  ${h.biome}`);
  }

  // 2b. Open water near centre — the criterion the first passing world taught us it was missing.
  const waterRadius = parseFloat(opt('water-radius', String(DEFAULT_WATER_RADIUS)));
  const river = biomeDistanceFromCenter('minecraft:river');
  const waterDist = river.found ? river.distance : Infinity;
  console.log(`  nearest river      : ${river.found ? `${waterDist}b` : 'none within range'}`);

  const checks = [
    { name: 'world centre is a forest/plains type', pass: centerIsAcceptable, owner: 'HIS — stated in words, encoded in ACCEPTABLE_BIOMES' },
    { name: `open water within ${waterRadius}b of centre (the base needs a wheat plot pair)`, pass: waterDist <= waterRadius, owner: has('water-radius') ? 'HIS — given on the command line' : `THE TOOL'S default (${DEFAULT_WATER_RADIUS}b) — added after a world that passed everything else could not anchor a base` },
    { name: `the bot spawned within ${centerRadius}b of world centre`, pass: fromCenter <= centerRadius, owner: has('center-radius') ? 'HIS — given on the command line' : `THE TOOL'S default (${DEFAULT_CENTER_RADIUS}b) — he has not set this number` },
    { name: `the bot is standing between y=${minY} and y=${maxY}`, pass: pos.y >= minY && pos.y <= maxY, owner: (has('min-y') || has('max-y')) ? 'HIS — given on the command line' : `THE TOOL'S default (${DEFAULT_MIN_Y}–${DEFAULT_MAX_Y}) — stands in for "not a mountain, not the ocean"` },
  ];

  banner(`VERDICT for '${name}'`);
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    console.log(`       criterion owner: ${c.owner}`);
  }
  const met = checks.every(c => c.pass);
  console.log(`\n  ${met ? '✅ MET every criterion' : '❌ MISSED — this is not the world'}`);

  if (has('down')) { console.log(`\n${el()} --down: taking the fleet down.`); fleet(['down']); }
  else console.log(`\n${el()} the fleet is STILL UP on '${name}' so the ground can be looked at. ` +
    `Take it down with: node Auren_Workshop/fleet_control.js down`);

  if (met) {
    console.log(`\n  Keep it with:  node Auren_Workshop/fleet_control.js down` +
      `\n                 node Auren_Workshop/tools/world_forge.js keep --name=${name}`);
  } else {
    console.log(`\n  Try another:   node Auren_Workshop/tools/world_forge.js try --name=${name} --replace [--seed=N]`);
  }
  return met ? 0 : 2;
}

// ── keep ─────────────────────────────────────────────────────────────────────────────────────────
// Delegates to fleet_control's snapshot, which delegates to rollback.ps1 — the one implementation, and
// the one that already refuses while the server is up (a snapshot of a live world is a torn copy).
function keep() {
  const name = opt('name', null);
  if (!name) { console.error('world_forge: --name=<world> is required.'); return 1; }
  const snapshot = opt('snapshot', `${name}_fresh_start`);
  banner(`KEEP '${name}' as snapshot '${snapshot}'`);
  const r = fleet(['snapshot', `--world=${name}`, `--name=${snapshot}`]);
  if (r.status !== 0) { console.error(`\nworld_forge: the snapshot did not complete.`); return 1; }
  // The hint names the FIELDS to set, not a command line to type: a run's world is authored now, and a
  // hint that handed back `--world=` would be pointing at a door that was deleted (Law 16).
  console.log(`\n  '${name}' is now restorable. To run on it, point the one page at it —\n` +
    `  Auren_Workshop/run_config.js:\n` +
    `    worldName   '${name}'\n` +
    `    snapshot    '${snapshot}'\n` +
    `    world       'fresh'      (so it rolls back to that snapshot)\n` +
    `  then:\n` +
    `    node Auren_Workshop/run.js`);
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
  let code = 1;
  if (verb === 'try') code = tryCandidate();
  else if (verb === 'vet') code = vet(opt('name', ''));
  else if (verb === 'keep') code = keep();
  else usage();
  process.exit(code);
}

module.exports = { ACCEPTABLE_BIOMES, HARD_DENY, DEFAULT_CENTER_RADIUS, DEFAULT_MIN_Y, DEFAULT_MAX_Y };
