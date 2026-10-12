'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/wheat_site_probe.js');
// tool: wheat_site_probe — joins one body, sites the wheat field the way a crew sites it, prints the
// report, and leaves. Answers a siting question without a soak; siting_scan_bench answers the same
// question for the headframe's box sweep.
//
// Runs the fleet's own siting code and authors nothing but where the body stands (--at): loadedAreaSettled,
// scanWheatPlots, and describeScan, in lock_all_buildspots' own order, against a real server — so the
// printed lines match what a crew's survey would carry (Auren_Workshop/README.md: read, don't simulate).
//
// Scope: the headframe and the house are sited by find_buildingspot against a conference room this body
// does not have, and nothing here builds anything. The printed field is what a crew standing on the same
// cell would lock; whether a crew then builds it is a separate question.
//
// Starts its own server, rolled back to the hosting snapshot unless --continue, and stops it on exit.
// Refuses to start while any terminal is already open or a world already answers (console_window's
// ledger), and closes every terminal it opened before exiting, reporting what remains.
//
// Log lines the fleet's modules emit land in watcher_wheat_site_probe.jsonl and are swept at the next
// bring-up (proxy_human's arrangement). The scan itself logs nothing.
//
// Usage (developer mode):
//   node Auren_Workshop/tools/wheat_site_probe.js [--at=X,Z] [--continue]
//     --at=X,Z    stand on the surface of that column first (/tp above it, then fall). Without it the body scans from
//                 where the server puts a new player — world spawn, which is never where a crew scans from.
//     --continue  leave the world as the last run left it (no rollback)
// Exit: 0 at least one plot · 2 the scan ran and no sea-level water bank in view holds one · 1 it could not scan.

const net = require('net');

const paths = require('../workshop_paths');
paths.registerAliases();
process.env.BOT_ID = process.env.BOT_ID || 'wheat_site_probe';

// Where mineflayer lives is asked, never assumed (proxy_human).
const moduleHomes = require('@utils/node_module_homes');
const MODULE_DIRS = moduleHomes.bootstrapModulePath();
if (MODULE_DIRS.length === 0) {
  console.error('wheat_site_probe: no module home found — mineflayer cannot resolve. Checked: '
    + moduleHomes.CANDIDATE_HOMES.join(', '));
  process.exit(1);
}
for (const d of MODULE_DIRS) module.paths.unshift(d);
const mineflayer = moduleHomes.requireFromHomes('mineflayer');

const rcon = require('@utils/rcon_link');
const { openWindows, closeWindows, describeWindows } = require('@utils/console_window');
const { loadedAreaSettled, settleLine, scanWheatPlots, describeScan } = require('@utils/wheat_plot_scanner');
const { FARM_PLOT_COUNT, SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');
// The world a rollback start puts back, named by the foreman's one rule (foreman_plan.freshWorld).
const HOSTING = require(paths.bot('foreman', 'foreman_plan.js')).freshWorld(require(paths.bot('js_kernel', 'utils', 'workstation.js')).needServerDir());

const args = process.argv.slice(2);
const has = k => args.includes(`--${k}`);
const opt = (k, fallback) => {
  const hit = args.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : fallback;
};
const HOST = 'localhost';
const PORT = Number(opt('port', '25565'));
const NAME = 'SiteProbe';
const PLACE_WAIT_MS = 15000;

const say = m => console.log(`wheat_site_probe: ${m}`);
const where = bot => { const p = bot.entity.position; return `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`; };

function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: HOST, port });
    s.setTimeout(2000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

// The foreman is the one owner of the world's lifecycle and of the world restore (Law 16); this asks it.
const benchWorld = require('../bench_world');

async function until(test, ms, every = 250) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (test()) return true;
    await new Promise(r => setTimeout(r, every));
  }
  return test();
}

async function probe(at) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: SERVER_MINECRAFT_VERSION, auth: 'offline' });
  bot.on('error', e => say(`socket error: ${e.message}`));
  const joined = await new Promise(resolve => {
    bot.once('spawn', () => resolve(true));
    bot.once('kicked', r => { say(`kicked: ${JSON.stringify(r)}`); resolve(false); });
    bot.once('end', () => resolve(false));
  });
  if (!joined) return 1;

  // Creative, so nothing kills the body mid-scan: a death respawns it at world spawn, and the scan would read
  // a different place from the one it reports standing on. The bench reads the dev world's own console
  // credentials (rcon_link's note on benches).
  const cmds = [`gamemode creative ${NAME}`];
  // Drops the body in from above so it falls to whatever surface the column holds.
  if (at) cmds.push(`tp ${NAME} ${at.x + 0.5} 120 ${at.z + 0.5}`);
  for (const { cmd, body } of await rcon.once(cmds, { creds: rcon.readServerProperties() })) say(`> ${cmd} — ${body || '(ok)'}`);
  if (at) {
    const landed = await until(() => {
      const p = bot.entity.position;
      return Math.max(Math.abs(p.x - (at.x + 0.5)), Math.abs(p.z - (at.z + 0.5))) <= 3 && bot.entity.onGround;
    }, PLACE_WAIT_MS);
    if (!landed) {
      say(`the body did not reach (${at.x},${at.z}) within ${PLACE_WAIT_MS / 1000}s — it is at ${where(bot)}. Nothing was scanned.`);
      bot.quit();
      return 1;
    }
  }

  const p = bot.entity.position;
  const origin = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  say(`standing at ${where(bot)} — waiting for the loaded area to arrive, then scanning once.`);
  const settled = await loadedAreaSettled(bot);
  const scan = await scanWheatPlots(bot, { origin, target: FARM_PLOT_COUNT, combatGate: false });
  console.log(`\n${settleLine(settled)}\n${describeScan(scan, FARM_PLOT_COUNT)}`);
  if (scan.field.length) {
    const a = scan.field[0].stand;
    console.log(`      ↳ instance 0 stand (${a.x},${a.y},${a.z}) would be the base anchor, ` +
      `${Math.round(Math.hypot(a.x - origin.x, a.z - origin.z))} blocks from where the body stood.`);
  }
  bot.quit();
  return scan.field.length ? 0 : 2;
}

async function main() {
  let at = null;
  const atArg = opt('at', null);
  if (atArg) {
    const [x, z] = atArg.split(',').map(Number);
    if (!Number.isInteger(x) || !Number.isInteger(z)) { say(`--at takes two whole numbers, X,Z — got '${atArg}'.`); return 1; }
    at = { x, z };
  }

  // Every terminal must be closed before anything starts here — checked, never closed by this step. A
  // world already answering counts, since this starts its own and a second one beside it would hang.
  const open = openWindows();
  const worldUp = await portOpen(PORT);
  if (open.length || worldUp) {
    say(`NOTHING WAS STARTED — ${describeWindows(open)}${worldUp ? `, and a server is already answering on ${PORT}` : ''}.`);
    say('Nothing was closed. Close them, then run this again:  node Auren_Workshop/fleet_control.js down');
    return 1;
  }
  say('no terminals open, and no world answering.');

  if (!has('continue')) say(`a rollback start: the foreman puts '${HOSTING.worldName}' back to '${HOSTING.snapshot}' first (--continue skips this).`);
  const world = await benchWorld.up({ start: has('continue') ? 'continue' : 'rollback', say });
  try {
    if (!world.ok) { say(`the world did not come up; nothing was scanned — ${world.why}`); return 1; }
    return await probe(at);
  } finally {
    // The end of the run checks and closes every terminal. The foreman stops and saves the world it started,
    // and is waited for; then everything else this opened is closed and the ledger is read again.
    say((await benchWorld.down(world.foreman, { say })).why);
    say(`${describeWindows(closeWindows().stillOpen)}.`);
  }
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
