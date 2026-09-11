'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/water_pillar_probe.js');
// tool: water_pillar_probe â€” a fast, deterministic LIVE trigger for the phase-2 water bob-pillar-out
// (Architect 2026-07-18, bugsquash 51r). Waiting ~30 min for the fleet to organically wander into
// deep-enough water to exercise the pillar-out is the wrong loop â€” this drives it in seconds.
//
// WHAT IT DOES, per test: RCON-drives `testbot` (SURVIVAL) a stack of construction blocks, SEARCHES
// for a reachable water column (a solid floor within BLOCK_REACH below the surface â€” the case
// fillWaterColumnBelow can actually resolve; a bottomless channel is the too_deep negative), teleports
// the bot into it, then drives the REAL pillarStep() API â€” the exact phase-2 code path, Law 16, no
// reimplementation â€” until the bot stands OUT of the water, and reports the true outcome (Law 25).
// Between every test the bot is RCON-killed so each run starts from a fresh body (the Architect's ask).
//
// THE GOVERNING LINE (same as ghost_probe): anything MINECRAFT decides is READ, only the operator's
// choices are AUTHORED. World reads (blockAt) fall through to the live server; RCON is the OPERATOR
// (server console, op-4) issuing give/tp/kill/setblock â€” never the bot computing a made-up outcome.
// The pillar is a REAL world-transformation the real executor performs against the real server, which
// is exactly why this is a LIVE harness and not a headless one: no harness may compute an action's
// outcome and call it a result (READ DON'T SIMULATE, `Auren_Workshop/README.md`).
//
// SURVIVAL, not creative (Architect correction): survival is the regime the apex-bob physics were
// tuned against. The bot can drown/take fall damage â€” that is why every test ends in a kill+respawn,
// so accumulated air/damage never bleeds across runs. Blocks are handed out fresh each test (a kill
// drops the inventory).
//
// Run (fleet/server must be UP):
//   . .\Auren_Workshop\scripts\_node.ps1 ; & (Get-AurenNode) Auren_Workshop\tools\water_pillar_probe.js
//   env knobs: PROBE_TESTS (default 3), PROBE_RADIUS (default 48), PROBE_NAME (default testbot)

const path = require('path');
const fs = require('fs');
const net = require('net');
const paths = require('../workshop_paths');
paths.registerAliases();

// Isolated identity â€” a throwaway bot writing into its OWN record, never a fleet bot's (Law 6).
process.env.BOT_ID = process.env.PROBE_NAME || 'testbot';

// Route the executor's own diagnostics (pillarStep warns on every retry / terminal reason) to the
// console so this run narrates itself; suppress the disk/HQ writers a throwaway must not touch.
const watcher = require('@kernel/watcher');
watcher.summary = () => {};
watcher.warn = (tag, msg) => console.log(`   [warn] ${tag}: ${msg}`);
watcher.error = (tag, msg) => console.log(`   [ERROR] ${tag}: ${msg}`);

const mineflayer = require('mineflayer');
const Vec3 = require('vec3').Vec3;
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { BLOCK_REACH } = require('@utils/fragment_utils');

const HOST = process.env.PROBE_HOST || 'localhost';
const PORT = Number(process.env.PROBE_PORT || 25565);
const VERSION = process.env.PROBE_VERSION || '1.21.5';
const NAME = process.env.PROBE_NAME || 'testbot';
const TESTS = Number(process.env.PROBE_TESTS || 3);
const RADIUS = Number(process.env.PROBE_RADIUS || 48);
const SEA_LEVEL = 62;
const MAX_DOWN = Math.max(1, Math.floor(BLOCK_REACH));   // reachable fill depth (~4)
const BLOCK = 'cobblestone';

const SERVER_DIR = require(paths.bot('js_kernel/utils/workstation')).needServerDir();

function log(...a) { console.log('[water_pillar_probe]', ...a); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// â”€â”€ RCON (the operator pathway â€” reused shape from fleet_control.js:250-284) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function serverProperties() {
  const props = {};
  for (const line of fs.readFileSync(path.join(SERVER_DIR, 'server.properties'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) props[line.slice(0, i)] = line.slice(i + 1);
  }
  return props;
}
function rconPacket(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const pkt = Buffer.alloc(14 + b.length);
  pkt.writeInt32LE(10 + b.length, 0);
  pkt.writeInt32LE(id, 4);
  pkt.writeInt32LE(type, 8);
  b.copy(pkt, 12);
  return pkt;
}
function rcon(command) {
  const props = serverProperties();
  if (props['enable-rcon'] !== 'true') return Promise.reject(new Error('rcon disabled in server.properties'));
  const port = parseInt(props['rcon.port'], 10) || 25575;
  const password = props['rcon.password'] || '';
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 5000 });
    let stage = 'auth';
    sock.on('connect', () => sock.write(rconPacket(1, 3, password)));
    sock.on('data', (data) => {
      const id = data.readInt32LE(4);
      if (stage === 'auth') {
        if (id === -1) { sock.destroy(); reject(new Error('rcon auth failed')); return; }
        stage = 'cmd';
        sock.write(rconPacket(2, 2, command));
      } else {
        const body = data.slice(12, data.length - 2).toString('utf8');
        sock.destroy();
        resolve(body);
      }
    });
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('rcon timeout')); });
  });
}

// â”€â”€ voxel predicates (READS, never authored) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function isWater(b) { return !!b && (b.name === 'water' || b.name === 'flowing_water'); }
function isSolid(b) { return !!b && b.boundingBox === 'block' && !isWater(b); }

// A reachable test column: water at (x,z) whose highest solid floor sits 2..MAX_DOWN below the
// surface. depth<2 is a puddle (one block ends it â€” not the interesting case); depth>MAX_DOWN is the
// too_deep negative the executor is designed to refuse. Returns { x, z, surfaceY, floorY, depth } | null.
function assessColumn(bot, x, z) {
  let surfaceY = null;
  for (let y = SEA_LEVEL + 2; y >= SEA_LEVEL - 6; y--) {
    if (isWater(bot.blockAt(new Vec3(x, y, z)))) { surfaceY = y; break; }
  }
  if (surfaceY == null) return null;
  // open sky above the surface (no canopy) so the bot bobs against air, matching the design case
  for (let y = surfaceY + 1; y <= surfaceY + 3; y++) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b || b.boundingBox === 'block') return null;
  }
  let floorY = null;
  for (let y = surfaceY - 1; y >= surfaceY - (MAX_DOWN + 3); y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return null;                       // unloaded â€” cannot trust the depth read
    if (isSolid(b)) { floorY = y; break; }
  }
  if (floorY == null) return null;
  const depth = surfaceY - floorY;             // water blocks between floor and surface, inclusive of surface
  return { x, z, surfaceY, floorY, depth };
}

// Nearest reachable column (spiral rings out from the bot). Prefers the deepest still-reachable
// column so the multi-block fill â€” the whole phase-2 point â€” actually gets exercised.
function findReachableColumn(bot) {
  const o = bot.entity.position.floored();
  let best = null;
  for (let r = 1; r <= RADIUS; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const c = assessColumn(bot, o.x + dx, o.z + dz);
        if (c && c.depth >= 2 && c.depth <= MAX_DOWN) {
          if (!best || c.depth > best.depth) best = c;
        }
      }
    }
    if (best && r >= 6) break;   // found one within a small ring â€” good enough, stop widening
  }
  return best;
}

// Deterministic fallback (Architect's ask: never "may or may not happen"). If no natural reachable
// column is in view range, the OPERATOR authors a 3-deep pool beside the bot via RCON setblock â€” this
// is not the bot computing an outcome, it is the console building a fixture. Returns the column spec.
async function buildTestPool(bot) {
  const o = bot.entity.position.floored();
  const x = o.x + 3, z = o.z, surfaceY = o.y - 1, floorY = surfaceY - 3;
  // solid floor, three water blocks above it, air overhead â€” a clean 3-deep reachable pool
  await rcon(`setblock ${x} ${floorY} ${z} minecraft:stone`);
  for (let y = floorY + 1; y <= surfaceY; y++) await rcon(`setblock ${x} ${y} ${z} minecraft:water`);
  await rcon(`setblock ${x} ${surfaceY + 1} ${z} minecraft:air`);
  await rcon(`setblock ${x} ${surfaceY + 2} ${z} minecraft:air`);
  await sleep(600);   // let the setblocks propagate to the bot's chunk cache
  return { x, z, surfaceY, floorY, depth: surfaceY - floorY, authored: true };
}

// â”€â”€ one test â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runOneTest(bot, n) {
  log(`â”€â”€â”€â”€ test ${n}/${TESTS} â”€â”€â”€â”€`);

  // 1. fresh body already guaranteed by the caller (respawned). Hand it blocks (survival: kill dropped them).
  await rcon(`give ${NAME} minecraft:${BLOCK} 128`);
  await sleep(500);

  // 2. find water (search first â€” the Architect's literal ask); author a pool only if none is reachable.
  let col = findReachableColumn(bot);
  if (col) {
    log(`found reachable water at (${col.x},${col.surfaceY},${col.z}) depth=${col.depth} (floor y=${col.floorY})`);
  } else {
    log(`no reachable natural water within ${RADIUS} â€” OPERATOR authoring a 3-deep test pool via RCON.`);
    col = await buildTestPool(bot);
    log(`authored pool at (${col.x},${col.surfaceY},${col.z}) depth=${col.depth} (floor y=${col.floorY})`);
  }

  // 3. teleport the bot to STAND IN the surface water block (feet at surfaceY) â†’ it bobs there.
  await rcon(`tp ${NAME} ${col.x + 0.5} ${col.surfaceY} ${col.z + 0.5}`);
  await sleep(900);   // settle: let the body drop into the column and begin bobbing

  const before = bot.entity.position.clone();
  const startY = Math.floor(before.y);
  log(`bot at (${before.x.toFixed(1)},${before.y.toFixed(1)},${before.z.toFixed(1)}) inWater=${bot.entity.isInWater} â€” driving pillarStep()`);

  // 4. command "stand on a water block" = drive the REAL pillar-out until the bot is on solid ground
  //    or the executor returns a terminal verdict. Bounded so a stuck bob can never spin forever.
  let outcome = 'no_progress', detail = '', placed = 0;
  const MAX_STEPS = MAX_DOWN + 2;
  for (let step = 1; step <= MAX_STEPS; step++) {
    const feet = bot.entity.position.floored();
    const below = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
    if (isSolid(below) && !bot.entity.isInWater) { outcome = 'STOOD_OUT'; detail = `standing on ${below.name} at y=${feet.y}`; break; }

    const res = await pillarStep(bot, { candidateItemNames: [BLOCK], debug: true });
    log(`  step ${step}: pillarStep â†’ success=${res.success} reason=${res.reason || '-'} y ${res.oldY}â†’${res.newY}`);
    if (res.success) { placed++; continue; }
    // terminal reasons (scaffold_movement placeAtApex) â€” retrying cannot fix these
    if (res.reason === 'no_solid_support') { outcome = 'TOO_DEEP'; detail = `water deeper than reach (${MAX_DOWN}) below feet`; break; }
    if (res.reason === 'no_item') { outcome = 'NO_BLOCKS'; detail = 'inventory empty â€” give failed'; break; }
    if (res.reason === 'equip_fail') { outcome = 'EQUIP_FAIL'; detail = res.reason; break; }
    await sleep(200);
  }
  // final judge on the body, not the last return value (Law 23: verify against sensed reality)
  const feet = bot.entity.position.floored();
  const below = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
  const stoodOut = isSolid(below) && !bot.entity.isInWater;
  if (stoodOut && outcome !== 'STOOD_OUT') { outcome = 'STOOD_OUT'; detail = `standing on ${below.name} at y=${feet.y}`; }

  const endY = feet.y;
  log(`VERDICT test ${n}: ${outcome} â€” ${detail}. rose ${startY}â†’${endY} (${endY - startY} block${Math.abs(endY - startY) === 1 ? '' : 's'}), blocks placed=${placed}`);
  return { n, outcome, detail, startY, endY, placed, depth: col.depth, authored: !!col.authored };
}

// Kill and wait for the bot to come back with a fresh body (the Architect's per-test reset).
async function killAndRespawn(bot) {
  const before = bot.entity && bot.entity.id;
  await rcon(`kill ${NAME}`);
  // mineflayer auto-respawns; wait for a fresh spawn (new entity / restored health).
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (bot.entity && bot.health > 0 && bot.entity.id !== before) return true;
  }
  return !!(bot.entity && bot.health > 0);
}

// â”€â”€ run â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: VERSION });
let respawnResolve = null;
bot.on('death', () => log('   (died â€” awaiting respawn)'));
bot.on('spawn', () => { if (respawnResolve) { respawnResolve(); respawnResolve = null; } });
bot.on('error', (e) => log('BOT ERROR:', e.message));
bot.on('kicked', (r) => log('KICKED:', r));
bot.on('end', (r) => { log('disconnected:', r); process.exit(0); });

bot.once('spawn', async () => {
  log(`spawned as ${NAME} on ${HOST}:${PORT} (v${VERSION}); settling for chunksâ€¦`);
  await sleep(4000);
  const results = [];
  try {
    for (let n = 1; n <= TESTS; n++) {
      results.push(await runOneTest(bot, n));
      if (n < TESTS) {
        log('resetting body for next test (kill + respawn)â€¦');
        const ok = await killAndRespawn(bot);
        if (!ok) { log('respawn did not complete â€” aborting remaining tests.'); break; }
        await sleep(1500);   // let chunks re-resolve at spawn before the next search
      }
    }
  } catch (e) {
    log('HARNESS ERROR:', e.stack || e.message);
  }

  log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SUMMARY â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
  for (const r of results) {
    log(`  test ${r.n}: ${r.outcome.padEnd(11)} depth=${r.depth} rose ${r.startY}â†’${r.endY} placed=${r.placed}${r.authored ? ' [authored pool]' : ''} â€” ${r.detail}`);
  }
  const won = results.filter(r => r.outcome === 'STOOD_OUT').length;
  log(`  ${won}/${results.length} tests stood the bot OUT of the water via bob-pillar.`);
  log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
  await sleep(300);
  bot.quit('probe done');
  process.exit(0);
});
