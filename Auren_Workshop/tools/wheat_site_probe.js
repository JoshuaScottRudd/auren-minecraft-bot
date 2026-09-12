'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/wheat_site_probe.js');
// tool: wheat_site_probe — one body joins, the wheat field is sited exactly the way a crew sites it, the
// report is printed, and everything leaves. The siting answer without a soak.
//
// Architect 2026-09-11: *"i think theres a tool for testing already, if not make a tool that loads in a bot,
// then runs the scan and gives you the report and stops so we dont have to do soaks."* There was not one:
// siting_scan_bench times the headframe's box sweep, and the wheat field is sited by a different module.
//
// IT RUNS THE FLEET'S OWN CODE AND AUTHORS ONE THING (the workshop README: READ, DON'T SIMULATE). The three
// calls are lock_all_buildspots' own, in its order — wheat_plot_scanner.loadedAreaSettled, scanWheatPlots
// from where the body stands, then describeScan, the formatter the crew's survey prints through — so the
// lines this prints are the lines that crew's trace would carry. The world is a real server's. The one
// authored choice is where the body stands (--at), which is an operator's choice.
//
// WHAT IT DOES NOT ANSWER. The headframe and the house are sited by find_buildingspot against a conference
// room this body does not have, and nothing is built. A field printed here is the field a crew standing on
// the same cell would lock; whether that crew then builds it is a live run's question.
//
// THE SERVER AND THE TERMINALS. This starts its own server through fleet_control — first rolled back to
// run_config's hosting snapshot, the world every comparable run starts from, unless --continue — and stops
// it on the way out. It refuses to start at all while any terminal a run opened is still open or a world
// already answers (console_window's LEDGER, Architect 2026-09-11: *"before every run, before starting
// anything… verify all terminals are closed fully"*), and it ends by closing every terminal it opened and
// saying what, if anything, is left.
//
// A line the fleet's modules log lands in watcher_wheat_site_probe.jsonl and is swept with every other record
// at the next bring-up (proxy_human's arrangement). The scan itself logs nothing.
//
// Usage (developer mode):
//   node Auren_Workshop/tools/wheat_site_probe.js [--at=X,Z] [--continue]
//     --at=X,Z    stand on the surface of that column first (/spreadplayers). Without it the body scans from
//                 where the server puts a new player — world spawn, which is never where a crew scans from.
//     --continue  leave the world as the last run left it (no rollback)
// Exit: 0 at least one plot · 2 the scan ran and no river or ocean bank in view holds one · 1 it could not scan.

const net = require('net');
const { spawnSync } = require('child_process');

const paths = require('../workshop_paths');
paths.registerAliases();
process.env.BOT_ID = process.env.BOT_ID || 'wheat_site_probe';

// Where mineflayer lives is asked, never assumed (proxy_human carries the full note).
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
const { FARM_PLOT_COUNT } = require('@thinking/architect_config');
const { hosting: HOSTING } = require('../run_config');

const FLEET = paths.workshop('fleet_control.js');
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
const SERVER_EXIT_WAIT_MS = 180000;   // fleet_control's own shutdown allowance: saving chunks is the slow part

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

// fleet_control is the one owner of the server's lifecycle and of the world restore (Law 16); this asks it.
function fleet(verbArgs) {
  return spawnSync(process.execPath, [FLEET, ...verbArgs], { stdio: 'inherit' }).status === 0;
}

async function until(test, ms, every = 250) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (test()) return true;
    await new Promise(r => setTimeout(r, every));
  }
  return test();
}

async function probe(at) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: '1.21.5', auth: 'offline' });
  bot.on('error', e => say(`socket error: ${e.message}`));
  const joined = await new Promise(resolve => {
    bot.once('spawn', () => resolve(true));
    bot.once('kicked', r => { say(`kicked: ${JSON.stringify(r)}`); resolve(false); });
    bot.once('end', () => resolve(false));
  });
  if (!joined) return 1;

  // CREATIVE, so nothing kills the body mid-scan: a death respawns it at world spawn, and the scan would read
  // a different place from the one it reports standing on. The bench reads the dev world's own console
  // credentials rather than the environment's (rcon_link's note on benches).
  const cmds = [`gamemode creative ${NAME}`];
  if (at) cmds.push(`spreadplayers ${at.x + 0.5} ${at.z + 0.5} 0 1 false ${NAME}`);
  for (const { cmd, body } of await rcon.once(cmds, { creds: rcon.readServerProperties() })) say(`> ${cmd} — ${body || '(ok)'}`);
  if (at) {
    const landed = await until(() => {
      const p = bot.entity.position;
      return Math.max(Math.abs(p.x - (at.x + 0.5)), Math.abs(p.z - (at.z + 0.5))) <= 3;
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

  // EVERY TERMINAL CLOSED BEFORE ANYTHING STARTS — checked, never closed here. A world already answering
  // counts: this starts its own, and a second one beside it is the hang being prevented.
  const open = openWindows();
  const worldUp = await portOpen(PORT);
  if (open.length || worldUp) {
    say(`NOTHING WAS STARTED — ${describeWindows(open)}${worldUp ? `, and a server is already answering on ${PORT}` : ''}.`);
    say('Nothing was closed. Close them, then run this again:  node Auren_Workshop/fleet_control.js down');
    return 1;
  }
  say('no terminals open, and no world answering.');

  try {
    if (!has('continue')) {
      say(`rolling '${HOSTING.worldName}' back to '${HOSTING.snapshot}' before starting it (--continue skips this).`);
      if (!fleet(['snapshot-restore', `--world=${HOSTING.worldName}`, `--snapshot=${HOSTING.snapshot}`])) return 1;
    }
    if (!fleet(['server-start'])) { say('the server did not come up; nothing was scanned.'); return 1; }
    return await probe(at);
  } finally {
    // THE END OF THE RUN CHECKS AND CLOSES EVERY TERMINAL. The server goes through its console and its
    // terminal closes when it has finished saving, which is waited for; then everything else this opened is
    // closed and the ledger is read again, so the last line is what is actually still open.
    fleet(['server-stop']);
    await until(() => !openWindows().some(e => e.label === 'server'), SERVER_EXIT_WAIT_MS, 2000);
    say(`${describeWindows(closeWindows().stillOpen)}.`);
  }
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
