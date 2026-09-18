'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/voxel_snapshot.js');
// tool: voxel_snapshot — capture every voxel of a LIVE loaded area to disk, so any scanner can be run against it
// afterwards with no server and no rollback. Scanners only read, so a snapshot is exactly what they would have read.
//
// WHAT A CAPTURE DOES, per area asked for:
//   1. one creative body is /tp'd above the point asked for and falls to the surface;
//   2. it waits until the server's whole view around it has arrived (wheat_plot_scanner.loadedAreaSettled);
//   3. the PERSON SPOT is chosen by person_spot — the rule the harness stands its person on and the foreman's desk
//      accepts: an acceptable biome, not too high, a clear 3×3, and at least landingFloor from world spawn —
//      nearest first outward from the point asked for;
//   4. the body is moved onto that spot, the view settles again, and every column inside the server's view of
//      that chunk (inServerView) is saved with the seed, world, version and both positions.
// The store refuses a capture that shares a chunk with a snapshot of the same seed, and keeps the newest 10
// (voxel_snapshot_store). A view that never fully arrives is saved anyway and says how many chunks were missing.
//
// THE SERVER AND THE TERMINALS: as wheat_site_probe — refuses to start while any terminal a run opened is still open
// or a world answers; rolls the world back to run_config's hosting snapshot unless --continue; stops the server and
// closes what it opened on the way out. Several areas are captured in one server session.
//
// Usage (developer mode):
//   node Auren_Workshop/tools/voxel_snapshot.js capture --near=X,Z [--near=X,Z ...] [--label=name] [--continue]
//   node Auren_Workshop/tools/voxel_snapshot.js list
// Exit: 0 every area saved · 2 some area was refused (overlap / no person spot) · 1 could not capture.

const net = require('net');
const { spawnSync } = require('child_process');
const paths = require('../workshop_paths');
paths.registerAliases();
process.env.BOT_ID = process.env.BOT_ID || 'voxel_snapshot';

const moduleHomes = require('@utils/node_module_homes');
const MODULE_DIRS = moduleHomes.bootstrapModulePath();
for (const d of MODULE_DIRS) module.paths.unshift(d);

const rcon = require('@utils/rcon_link');
const { openWindows, closeWindows, describeWindows } = require('@utils/console_window');
const { loadedAreaSettled, inServerView } = require('@utils/wheat_plot_scanner');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { ringScan, formatRejections } = require('@utils/site_geometry');
const { getBiomeName } = require('@perception/biome_scanner');
const { SPAWN_PROTECTION_RADIUS, SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');
const { personSpotTest, landingFloor } = require('./person_spot');
const store = require('./voxel_snapshot_store');
const { hosting: HOSTING } = require('../run_config');

const FLEET = paths.workshop('fleet_control.js');
const args = process.argv.slice(2);
const verb = args[0];
const has = k => args.includes(`--${k}`);
const opts = k => args.filter(a => a.startsWith(`--${k}=`)).map(a => a.slice(k.length + 3));
const PORT = 25565;
const NAME = 'SnapProbe';
const SETTLE_ROUNDS = 3;              // loadedAreaSettled caps each wait at 120 s; fresh ground can need more than one
const PLACE_WAIT_MS = 20000;
const SERVER_EXIT_WAIT_MS = 180000;
const say = m => console.log(`voxel_snapshot: ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fleet = verbArgs => spawnSync(process.execPath, [FLEET, ...verbArgs], { stdio: 'inherit' }).status === 0;

function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: 'localhost', port });
    s.setTimeout(2000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}
async function until(test, ms, every = 250) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (test()) return true; await sleep(every); }
  return test();
}

async function moveTo(bot, x, y, z) {
  await rcon.once([`tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`], { creds: rcon.readServerProperties() });
  return until(() => {
    const p = bot.entity.position;
    // floating counts as arrived: a point over the sea never gives onGround, and the sweep that follows looks for land.
    return Math.max(Math.abs(p.x - (x + 0.5)), Math.abs(p.z - (z + 0.5))) <= 1 && (bot.entity.onGround || bot.entity.isInWater);
  }, PLACE_WAIT_MS);
}
async function settle(bot) {
  let s;
  for (let i = 0; i < SETTLE_ROUNDS; i++) { s = await loadedAreaSettled(bot); if (s.settled) break; }
  return s;
}

async function captureOne(bot, near, seed, label) {
  const t0 = Date.now();
  if (!await moveTo(bot, near.x, 120, near.z)) { say(`[${label}] the body never landed near (${near.x},${near.z}). Skipped.`); return false; }
  const first = await settle(bot);
  const spawn = bot.spawnPoint;
  const floor = landingFloor(SPAWN_PROTECTION_RADIUS);
  const reader = makeVoxelReader(bot, { needs: ['type', 'water'] });
  const refY = Math.floor(bot.entity.position.y);
  const isSpot = personSpotTest(reader, (x, y, z) => getBiomeName(bot, x, y, z), refY);
  const sweep = await ringScan(reader, {
    origin: near, step: 1,
    accept: ({ x, z }) => Math.max(Math.abs(x - spawn.x), Math.abs(z - spawn.z)) >= floor,
  }, isSpot);
  if (!sweep.found) {
    say(`[${label}] no person spot in the view around (${near.x},${near.z}) — ${formatRejections(sweep.rejections)}. Nothing saved; pick another point.`);
    reader.dispose();
    return false;
  }
  const spot = { x: sweep.best.x, y: sweep.best.result.spawnY, z: sweep.best.z, biome: sweep.best.result.biome };
  reader.dispose();
  if (!await moveTo(bot, spot.x, spot.y, spot.z)) { say(`[${label}] could not stand the body on the spot (${spot.x},${spot.y},${spot.z}). Skipped.`); return false; }
  const s = await settle(bot);
  const p = bot.entity.position;
  const body = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const cx = body.x >> 4, cz = body.z >> 4;
  const columns = [];
  for (const { chunkX, chunkZ, column } of bot.world.getColumns()) {
    const x = Number(chunkX), z = Number(chunkZ);
    if (!inServerView(cx, cz, s.viewDistance, x, z)) continue;   // a column left over from the last area is not this view
    columns.push({ x, z, json: column.toJson() });
    if (columns.length % 16 === 0) await sleep(0);               // keep the connection serviced
  }
  const header = {
    label, capturedAt: new Date().toISOString(), world: HOSTING.worldName, seed, mcVersion: bot.version,
    viewDistance: s.viewDistance, spawn: { x: spawn.x, y: spawn.y, z: spawn.z }, near, body,
    person: { ...spot, why: `first person spot out from (${near.x},${near.z}), ${floor}+ from spawn, after ${sweep.checked} cells` },
    viewChunks: s.disc, missingChunks: s.missing, settleSecs: [first.secs, s.secs], captureMs: Date.now() - t0,
  };
  const saved = store.saveSnapshot({ header, columns });
  if (!saved.ok) { say(`[${label}] REFUSED — ${saved.reason}`); return false; }
  say(`[${label}] saved '${saved.name}' — ${columns.length}/${s.disc} chunks${s.missing ? ` (${s.missing} never arrived)` : ''}, ` +
    `person at (${spot.x},${spot.y},${spot.z}) in ${spot.biome}, seed ${seed}, ${(saved.bytes / 1e6).toFixed(1)} MB, ` +
    `${((Date.now() - t0) / 1000).toFixed(0)}s.${saved.pruned.length ? ` Deleted oldest to stay at ${store.KEEP}: ${saved.pruned.join(', ')}.` : ''}`);
  return true;
}

async function capture() {
  const nears = opts('near').map(v => { const [x, z] = v.split(',').map(Number); return { x, z }; });
  if (!nears.length || nears.some(n => !Number.isInteger(n.x) || !Number.isInteger(n.z))) {
    say('capture needs at least one --near=X,Z with two whole numbers, e.g. --near=-50,0 --near=1600,0'); return 1;
  }
  const labelBase = opts('label')[0] || 'area';
  const open = openWindows();
  if (open.length || await portOpen(PORT)) {
    say(`NOTHING WAS STARTED — ${describeWindows(open)}${open.length ? '' : ', and a server is already answering'}. Close them first:  node Auren_Workshop/fleet_control.js down`);
    return 1;
  }
  const mineflayer = moduleHomes.requireFromHomes('mineflayer');
  let failures = 0;
  try {
    if (!has('continue') && !fleet(['snapshot-restore', `--world=${HOSTING.worldName}`, `--snapshot=${HOSTING.snapshot}`])) return 1;
    if (!fleet(['server-start'])) { say('the server did not come up; nothing captured.'); return 1; }
    const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: NAME, version: SERVER_MINECRAFT_VERSION, auth: 'offline' });
    bot.on('error', e => say(`socket error: ${e.message}`));
    if (!await new Promise(r => { bot.once('spawn', () => r(true)); bot.once('end', () => r(false)); })) return 1;
    const [{ body: seedLine }] = await rcon.once(['gamemode creative ' + NAME, 'seed'], { creds: rcon.readServerProperties() }).then(o => o.slice(1));
    const seed = (seedLine.match(/-?\d+/) || [null])[0];
    if (seed === null) { say(`the server's answer to 'seed' held no number ('${seedLine}'); a snapshot without its seed cannot be traced. Nothing captured.`); bot.quit(); return 1; }
    for (let i = 0; i < nears.length; i++) {
      if (!await captureOne(bot, nears[i], seed, `${labelBase}${nears.length > 1 ? i + 1 : ''}`)) failures++;
    }
    bot.quit();
  } finally {
    fleet(['server-stop']);
    await until(() => !openWindows().some(e => e.label === 'server'), SERVER_EXIT_WAIT_MS, 2000);
    say(`${describeWindows(closeWindows().stillOpen)}.`);
  }
  return failures ? 2 : 0;
}

function list() {
  const all = store.listSnapshots();
  if (!all.length) { say(`no snapshots in ${store.SNAPSHOT_DIR}.`); return 0; }
  for (const s of all) {
    const h = s.header;
    say(`${s.name} — seed ${h.seed}, ${h.chunkCount} chunks, person (${h.person.x},${h.person.y},${h.person.z}) ${h.person.biome}, captured ${h.capturedAt}`);
  }
  say(`${all.length}/${store.KEEP} kept.`);
  return 0;
}

(async () => {
  if (verb === 'capture') return capture();
  if (verb === 'list') return list();
  say("verbs: capture --near=X,Z [--near=X,Z ...] [--label=name] [--continue] · list");
  return 1;
})().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
