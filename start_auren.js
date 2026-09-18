#!/usr/bin/env node
// start_auren.js — THE ONE WAY IN. The desk opens, and you hire every bot from inside the game.
//
//   node start_auren.js
//   then, in Minecraft chat:   foreman get contractor
//                        or:   foreman get homesteader
//
// ── WHY THERE IS ONE LAUNCHER AND NOT TWO (Architect 2026-09-09) ─────────────────────────────────────
// *"there should be a command just like foreman get. i dont want the bots to just start, spawn
// themselves at world spawn and go to work. the player probably wants to place the bots somewhere…
// make identical start methods… now you can collaspe the two start methods into one."*
//
// This file replaces `start_homestead_bots.js` and `start_contractor_bots.js`. The homestead one raised
// two bots itself, which put them wherever the world's spawn point happened to be — a decision the person
// running it never got to make, and frequently a hillside or a cave mouth. The two species now arrive the
// same way: somebody standing in the world asks for them, and they are brought to where that person is
// standing. **Where the bots go is a thing a human decides by walking there**, which needs no flag, no
// coordinate and nothing to look up.
//
// ── WHAT THE ONE WORD CHOOSES ────────────────────────────────────────────────────────────────────────
// Identical in every respect but one, and the one is who they answer to:
//   contractor   yours. It hears you in chat and works what you ask for.
//   homesteader  nobody's. It mounts no ear at all and works its own agenda.
// Both are fetched by name from the desk, both are brought to you, both begin working on arrival.
//
// ── WHAT THE ONE PROCESS IS (one process since 2026-09-18, §32) ──────────────────────────────────────
//   foreman/foreman.js holds both halves that used to be two processes:
//     the referee (foreman) — hands out exclusive holds on world objects so two bots never claim one
//              tree, hands out the planning turn, and keeps the fleet's memory.
//     the desk  — a client that joins your world under its own name, listens for the handful of words
//              below, and fetches bodies. It is not a bot: no mandate, no jobs.
//
// ── IT IS NOT A SECOND BIRTH (Law 16) ────────────────────────────────────────────────────────────────
// `start_bot.js` remains the one birth. This file starts the foreman's process; the foreman spawns
// `start_bot.js` when somebody asks it to. Nothing here stamps a mandate, and no bot is started by this
// script.

'use strict';

// ── THE ALIAS TABLE, REGISTERED HERE BECAUSE THIS PROCESS NOW LOADS SHIPPED BOT CODE (2026-09-10) ────
// This launcher used to require exactly one relative module and needed no aliases. Proving the server
// console before opening the desk changed that: `rcon_link` → `external_library_guard` → `watcher`, and
// when watcher forwards a line it reaches `foreman_link`, which requires `@kernel/`, `@foreman/` and
// `@utils/`. Without the table those throw, and the shape of the failure is the argument for fixing it
// here — the refusal message still printed correctly, with a `[watcher:SELF-FAULT] Cannot find module
// '@kernel/watcher'` stack trace stapled to the front of it, on a stranger's very first run. Same one
// line and the same reasoning as `foreman/foreman_hub.js`; `master_core` and `foreman` register it
// too, so this is the entry-point convention rather than a new mechanism (Law 16).
//
// `path.resolve(__dirname)` rather than a bare `module-alias/register`: that walks up from the PACKAGE'S
// install directory, which is not this one. Called once in this process — the map corrupts if it is
// rebuilt in place twice (the reasoning is in `Auren_Workshop/workshop_paths.js`).
require('module-alias')(require('path').resolve(__dirname));

const fleet = require('./js_kernel/utils/child_fleet');

// NOT A FLAG, and that is the line his instruction draws: *"im not liking how they have to keep track of
// variables like their name."* The port is settled rather than offered. The environment override exists
// for a machine that already runs an foreman permanently — his does — and is invisible to everyone else.
const FOREMAN_PORT = Number(process.env.FOREMAN_PORT) || 3001;

// ── THE CONSOLE PASSWORD IS A FLAG BECAUSE THE FLEET IS TOLD, NEVER GUESSES (2026-09-10) ────────────
// Placing a crew where a person stands needs a server console, and the only console a plain client can
// reach is RCON. The fleet used to find the password by walking up to a `MinecraftServer/` folder beside
// the repo — true for the Architect's own machine and for nobody else's, and the read simply threw on a
// download. Same shape as `--host`: whoever points the fleet at a world also tells it how to speak to
// that world's console. The environment variables stay the path a non-human caller uses (`start_bot.js`
// documents that convention and the foreman relies on it); these flags are how a PERSON says it.
//
// THE DEFAULTS COME FROM `foreman_config.js` RATHER THAN FROM LITERALS HERE (2026-09-11). That file is the
// one page a downloader is told to edit, and a literal `'localhost'` on this line would silently ignore
// their edit — they would change the address, run the one documented command, and watch the desk dial the
// old one. The flags still win over the file, which is what makes them a per-run override rather than a
// second answer (Law 16).
const WORLD = require('./foreman_config');
const FLAGS = [
  { flag: 'where', env: 'AUREN_SERVER_WHERE', help: "'local' (the foreman starts your server) or 'remote' (it joins one somebody else runs)" },
  { flag: 'server-folder', env: 'AUREN_SERVER_DIR', help: "the folder your Minecraft server runs in (the one holding server.properties)" },
  { flag: 'host', def: WORLD.host, help: 'server address the foreman connects to' },
  { flag: 'port', def: String(WORLD.port), help: 'server port' },
  // The console password and port are for a REMOTE world, whose owner gives them to you. For a local one
  // the foreman writes a fresh password into server.properties each start, and nobody types one.
  { flag: 'rcon-password', env: 'AUREN_RCON_PASSWORD', help: "a console password already set up by a launcher above this one" },
  { flag: 'rcon-port', env: 'AUREN_RCON_PORT', help: "that console's port  (default: 25575)" },
  // 'sweep' (default) empties fleet_logs/ because this door is the start of a run. 'keep' is for a
  // caller that IS the start and already swept — see the sweep site below for what the second sweep did.
  { flag: 'records', def: 'sweep', help: "'sweep' empties fleet_logs/ first (default) · 'keep' if your launcher already did" },
];

function usage() {
  console.log(`
  Start Auren: the foreman starts (or joins) your world, and you hire bots from inside it.

    node start_auren.js

    --where local|remote    who runs the world  (default: ${WORLD.where}, from foreman_config.js)
    --server-folder <dir>   local: the folder your Minecraft server runs in
    --host <address>        remote: the server's address  (default: ${WORLD.host})
    --port <n>              remote: the server's port  (default: ${WORLD.port})
    --rcon-password <pw>    remote: that server's console password, from its owner
    --rcon-port <n>         remote: that console's port  (default: ${WORLD.rconPort})
    --help                  this text

  Put these in foreman_config.js, beside this file, and you never type them again.

  local:  the foreman starts your server itself, and sets up what the bots need
          in its server.properties, printing every change and why:
              online-mode=false       the bots have no Minecraft accounts
              enable-rcon=true        the crew is brought to you through the server console
              rcon.password=<random>  a new one every start
          When you stop Auren, it stops the server too and waits for it to save.
  remote: the foreman joins the world at host:port. It never starts or stops it.

  If anything fails, the foreman says what and where to change it.

  What happens:
    A foreman joins your world. No bots start yet. Walk to where you want them
    and ask in chat:

      foreman get contractor    a crew of 2 that works for YOU and hears you
      foreman get homesteader   a crew of 2 that answers to nobody and builds
      foreman help              the words it knows
      foreman stop              send your contractors home

    Either way the crew is brought to where you are standing, and starts
    working when it arrives. Contractors take orders: say a bot's name and
    then what you want. Homesteaders have no ear at all — talking to one does
    nothing, by design.

    Ctrl-C stops everything: the bots, the foreman, and a server it started.
`);
}

function die(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
const given = {};
for (let i = 0; i < argv.length; i++) {
  const raw = argv[i];
  if (raw === '--help' || raw === '-h') { usage(); process.exit(0); }
  if (!raw.startsWith('--')) die(`'${raw}' is not an option. Options start with --. Try --help.`);
  const eq = raw.indexOf('=');
  const name = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).toLowerCase();
  if (!FLAGS.some(f => f.flag === name)) die(`'--${name}' is not an option. Try --help for the list.`);
  const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
  if (value === undefined || value.startsWith('--')) die(`'--${name}' needs a value after it.`);
  given[name] = value;
}

// EVERY FLAG BECOMES THE ENVIRONMENT, AND THE FOREMAN READS IT THROUGH `foreman_config.js` (Law 16). That
// file reads the environment before its own values, in the foreman's process and in every bot the foreman
// later spawns, so one assignment here reaches all of them and there is no second copy to disagree. A flag
// left off leaves the variable untouched, so a machine that already exports it is unchanged.
const FLAG_ENV = {
  where: 'AUREN_SERVER_WHERE', 'server-folder': 'AUREN_SERVER_DIR', host: 'AUREN_SERVER_HOST', port: 'AUREN_SERVER_PORT',
  'rcon-password': 'AUREN_RCON_PASSWORD', 'rcon-port': 'AUREN_RCON_PORT',
};
for (const [flag, env] of Object.entries(FLAG_ENV)) {
  if (given[flag] !== undefined) process.env[env] = given[flag];
}

// ── THE WORLD IS NOT PROVED HERE ANY MORE (2026-09-18) ────────────────────────────────────────────────
// This door used to set the server's properties, mint the console password, wait for a person to start the
// server, and probe the console before opening the desk. All of it moved into the foreman
// (`foreman/foreman_world.js`), which now starts a local server itself or reaches a remote one, and says why
// in words when it cannot — *"Who owns the process? Foreman does."* This file sweeps the records and raises
// the foreman, and that is all.
(async () => {
  // ── NO RECORD SURVIVES A RUN (Architect 2026-08-31, STANDING) ───────────────────────────────────
  // Swept HERE and nowhere else in the shipped tree, because this is the one door that starts a whole
  // fleet before any bot exists. The watcher cannot do it — every bot imports the watcher, so the second
  // bot would delete the first bot's trace mid-run — and `start_bot.js` cannot, because a bot joining a
  // fleet that is already working is not the start of a run. One sweep per run, owned by the thing that
  // knows a run is beginning.
  //
  // WHY A STRANGER WANTS THIS AND NOT JUST THE ARCHITECT: the whole troubleshooting story here is "run
  // it, then read `monitoring/trace_monitor.js`". A records room holding three runs makes every one of
  // those lenses answer about a mixture, and the answer looks exactly as confident as a true one. That
  // is not hypothetical — it is how the run of 2026-09-10 came to be scored FAIL on an error a bench had
  // written an hour earlier under a bot name that was not even in the fleet.
  // ── AND EXACTLY ONCE PER RUN, WHICH IT WAS NOT (fixed 2026-09-10) ─────────────────────────────────
  // `run.js` sweeps this same room itself and THEN launches this door, so a run.js-driven run swept twice,
  // and on Windows the second sweep silently deleted `console_desk.log` from under run.js's open handle.
  // So when something upstream IS the start of the run, it says so and this door does not take a second bite.
  const records = given.records || 'sweep';
  if (records !== 'sweep' && records !== 'keep') {
    die(`'--records ${records}' is not a choice. Use 'sweep' (empty fleet_logs/ first) or 'keep' (your launcher already did).`);
  }
  if (records === 'sweep') {
    const sweep = require('./js_kernel/utils/record_homes').sweepRecords();
    if (sweep.swept && sweep.entries.length) {
      console.log(`\n  cleared ${sweep.entries.length} record(s) from the last run — everything in `
        + `fleet_logs/ now belongs to this one.`);
    }
  } else {
    console.log(`\n  fleet_logs/ left as it is — the launcher that started this desk already swept it.`);
  }

  const where = process.env.AUREN_SERVER_WHERE || WORLD.where;
  const joins = `joins the world at ${process.env.AUREN_SERVER_HOST || WORLD.host}:${process.env.AUREN_SERVER_PORT || WORLD.port}`;
  console.log(`\n  Auren — the foreman is starting, and it ${where === 'local' ? 'starts your server first' : joins}.`
    + `\n  when the foreman has joined, walk where you want your bots and type:`
    + `\n      foreman get contractor     works for you`
    + `\n      foreman get homesteader    answers to nobody`
    + `\n  Ctrl-C stops everything${where === 'local' ? ', and the foreman stops the server and waits for it to save' : ''}\n`);

  // ONE PROCESS: the hub opens inside the foreman before its world and its body (foreman.js requires it
  // first). The desk names its own record `foreman` rather than inheriting a bot's name — see foreman.js.
  // ONE WARNING IS SILENCED, BY NAME (Architect 2026-09-18, reading the foreman's first visible window).
  // DEP0040 is Node announcing that its built-in `punycode` is deprecated; a library below mineflayer loads
  // it. It is not a fault, nothing here can change it, and PowerShell dresses anything on the error channel
  // as a red NativeCommandError — so the first thing a person saw was an "error" that was not one. Every
  // other warning still prints. It rides NODE_OPTIONS, so the foreman and every bot it spawns inherit it.
  const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=DEP0040'].filter(Boolean).join(' ');
  const foreman = fleet.start('foreman', 'foreman/foreman.js', {
    NODE_OPTIONS: nodeOptions,
    FOREMAN_PORT: String(FOREMAN_PORT),
    FOREMAN_URL: `ws://localhost:${FOREMAN_PORT}`,
    BOT_ID: 'foreman',
  });

  // THE FOREMAN ENDS ITSELF, so this door waits for it rather than killing it: a killed foreman would leave
  // the server it started running, unsaved-on-purpose and holding the world folder.
  fleet.followOwner(foreman);
})();
