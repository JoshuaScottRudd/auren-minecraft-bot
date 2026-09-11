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
// ── WHAT THE TWO PROCESSES ARE ───────────────────────────────────────────────────────────────────────
//   overseer — the referee. Hands out exclusive holds on world objects so two bots never claim one tree,
//              and hands out the planning turn so two never plan at the same instant.
//   foreman  — the desk. A client that joins your world under its own name, listens for the handful of
//              words below, and fetches bodies. It is not a bot: no mandate, no headquarters, no jobs.
//
// ── IT IS NOT A SECOND BIRTH (Law 16) ────────────────────────────────────────────────────────────────
// `start_bot.js` remains the one birth and `start_overseer.js` the one referee. This file spawns the
// overseer and the foreman; the foreman spawns `start_bot.js` when somebody asks it to. Nothing here
// stamps a mandate, and no bot is started by this script.

'use strict';

// ── THE ALIAS TABLE, REGISTERED HERE BECAUSE THIS PROCESS NOW LOADS SHIPPED BOT CODE (2026-09-10) ────
// This launcher used to require exactly one relative module and needed no aliases. Proving the server
// console before opening the desk changed that: `rcon_link` → `external_library_guard` → `watcher`, and
// when watcher forwards a line it reaches `overseer_link`, which requires `@kernel/`, `@overseer/` and
// `@utils/`. Without the table those throw, and the shape of the failure is the argument for fixing it
// here — the refusal message still printed correctly, with a `[watcher:SELF-FAULT] Cannot find module
// '@kernel/watcher'` stack trace stapled to the front of it, on a stranger's very first run. Same one
// line and the same reasoning as `overseer/overseer_server.js`; `master_core` and `foreman` register it
// too, so this is the entry-point convention rather than a new mechanism (Law 16).
//
// `path.resolve(__dirname)` rather than a bare `module-alias/register`: that walks up from the PACKAGE'S
// install directory, which is not this one. Called once in this process — the map corrupts if it is
// rebuilt in place twice (the reasoning is in `Auren_Workshop/workshop_paths.js`).
require('module-alias')(require('path').resolve(__dirname));

const fleet = require('./js_kernel/utils/child_fleet');

// NOT A FLAG, and that is the line his instruction draws: *"im not liking how they have to keep track of
// variables like their name."* The port is settled rather than offered. The environment override exists
// for a machine that already runs an overseer permanently — his does — and is invisible to everyone else.
const OVERSEER_PORT = Number(process.env.OVERSEER_PORT) || 3001;

// ── THE CONSOLE PASSWORD IS A FLAG BECAUSE THE FLEET IS TOLD, NEVER GUESSES (2026-09-10) ────────────
// Placing a crew where a person stands needs a server console, and the only console a plain client can
// reach is RCON. The fleet used to find the password by walking up to a `MinecraftServer/` folder beside
// the repo — true for the Architect's own machine and for nobody else's, and the read simply threw on a
// download. Same shape as `--host`: whoever points the fleet at a world also tells it how to speak to
// that world's console. The environment variables stay the path a non-human caller uses (`start_bot.js`
// documents that convention and the foreman relies on it); these flags are how a PERSON says it.
//
// THE DEFAULTS COME FROM `your_server.js` RATHER THAN FROM LITERALS HERE (2026-09-11). That file is the
// one page a downloader is told to edit, and a literal `'localhost'` on this line would silently ignore
// their edit — they would change the address, run the one documented command, and watch the desk dial the
// old one. The flags still win over the file, which is what makes them a per-run override rather than a
// second answer (Law 16).
const WORLD = require('./your_server');
const FLAGS = [
  { flag: 'host', def: WORLD.host, help: 'server address the foreman connects to' },
  { flag: 'port', def: String(WORLD.port), help: 'server port' },
  { flag: 'rcon-password', env: 'AUREN_RCON_PASSWORD', help: "your server's rcon.password — how the crew gets brought to you" },
  { flag: 'rcon-port', env: 'AUREN_RCON_PORT', help: "your server's rcon.port  (default: 25575)" },
  // 'sweep' (default) empties fleet_logs/ because this door is the start of a run. 'keep' is for a
  // caller that IS the start and already swept — see the sweep site below for what the second sweep did.
  { flag: 'records', def: 'sweep', help: "'sweep' empties fleet_logs/ first (default) · 'keep' if your launcher already did" },
];

function usage() {
  console.log(`
  Start Auren: the desk you hire bots from, and the referee that keeps them apart.

    node start_auren.js --rcon-password <your server's rcon password>

    --host <address>        server address the foreman connects to  (default: ${WORLD.host})
    --port <n>              server port  (default: ${WORLD.port})
    --rcon-password <pw>    your server's rcon.password — REQUIRED, see below
    --rcon-port <n>         your server's rcon.port  (default: ${WORLD.rconPort})
    --help                  this text

  Those defaults are read from your_server.js, beside this file. Edit that once instead of typing
  --host and --port every time.

  Your server needs a console, and these two lines in server.properties turn it on:

      enable-rcon=true
      rcon.password=<pick anything>

  Then pass that same password with --rcon-password. This is how a bot gets
  brought to where you are standing, which is the only place it will start
  working from. Without it nothing can be placed, so nothing starts — and this
  script says so at once rather than leaving you with a bot standing still.

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

    Ctrl-C stops the desk, the referee, and every bot the foreman fetched.
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

const host = given.host || WORLD.host;
const port = given.port || String(WORLD.port);

// STAMPED INTO THIS PROCESS, not added to the child `env` literal below, and that is deliberate:
// `child_fleet.start` spreads `process.env` underneath whatever it is handed, so one assignment here
// reaches the overseer, the foreman, and every bot the foreman later spawns — and the probe below then
// reads the exact value the crew will use rather than a second copy of it (Law 16). A flag left off
// leaves the variable untouched, so a machine that already exports it is unchanged.
if (given['rcon-password'] !== undefined) process.env.AUREN_RCON_PASSWORD = given['rcon-password'];
if (given['rcon-port'] !== undefined) process.env.AUREN_RCON_PORT = given['rcon-port'];

// ── A CONSOLE PASSWORD WRITTEN IN `your_server.js` HAS TO REACH THE PROBE (2026-09-11) ──────────────
// Without this the file is a page you can fill in that does nothing: `rcon_link.credentials()` reads the
// environment and then a properties file, and never that page. Stamped here rather than read there so
// there is still exactly ONE place the fleet learns a console password from (the environment), and this
// is the door that puts it there — the same shape `--rcon-password` above already uses.
//
// ONLY WHEN IT IS NON-EMPTY, and the port travels with it rather than separately. An empty password is
// the shipped default and means "I have not said"; stamping it would shadow the properties-file fallback
// a local run depends on, replacing a working lookup with a blank (Law 13 — never default a missing field
// into an answer). The two move together because a port without its password would send the fallback to
// the right door with the wrong key.
if (!process.env.AUREN_RCON_PASSWORD && WORLD.rconPassword) {
  process.env.AUREN_RCON_PASSWORD = WORLD.rconPassword;
  process.env.AUREN_RCON_PORT = String(WORLD.rconPort);
}

(async () => {
  // ── THE CONSOLE IS PROVED BEFORE THE DESK OPENS (Law 13, default-stopped) ─────────────────────────
  // Every crew this desk will ever fetch has to be put where a person is standing, and since 2026-09-10 a
  // body refuses to plan until it has confirmed it is there. So a fleet that cannot reach the server
  // console cannot raise a working bot at all — and the failure without this check is the worst shape
  // available: the desk opens, greets the player, accepts `foreman get`, launches two processes, and each
  // one stands still. Four steps of apparent success and nothing to read.
  //
  // ASKED ONCE, HERE, because this is the one moment the answer is cheap and the person is still at the
  // keyboard expecting to configure something. The reason comes back raw from `rcon_link.probe` and the
  // sentence a person acts on is composed here, where the flag names actually live (Law 25).
  const reach = await require('./js_kernel/utils/rcon_link').probe();
  if (!reach.ok) {
    die(`Auren cannot reach your server's console, so it could not bring a crew to you — and a bot that\n`
      + `  cannot be placed does not start. Nothing was launched.\n\n`
      + `  What the console said: ${reach.reason}\n\n`
      + `  Two lines in your server's server.properties turn it on:\n\n`
      + `      enable-rcon=true\n`
      + `      rcon.password=<pick anything>\n\n`
      + `  Restart the server, then start Auren with that same password:\n\n`
      + `      node start_auren.js --rcon-password <that password>\n\n`
      + `  If your rcon.port is not ${WORLD.rconPort}, pass --rcon-port too.\n\n`
      + `  To stop typing it every time, put the password and port in your_server.js beside this file.`);
  }

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
  // `run.js` sweeps this same room itself — it reports the count as a check, in its own step 4 — and
  // THEN launches this door. So a run.js-driven run swept twice, and the second sweep landed after
  // run.js had already created `fleet_logs/console_desk.log` and handed the descriptor to this process.
  //
  // ON WINDOWS THAT DELETE SUCCEEDS AND IS SILENT. Node opens files with FILE_SHARE_DELETE, so the
  // directory entry went away while the write handle stayed valid: run.js kept writing the desk's whole
  // console into a file with no name, `keepConsoles()` found nothing to report, and the window following
  // it showed the first few lines and then nothing forever. The desk's console is the one that explains
  // a fleet that will not come up, and it was the only one being destroyed.
  //
  // The rule is one sweep per run owned by the thing that knows a run is beginning — so when something
  // upstream IS that thing, it says so and this door does not take a second bite.
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

  console.log(`\n  Auren — the desk is opening on ${host}:${port}`
    + `\n  when the foreman has joined, walk where you want your bots and type:`
    + `\n      foreman get contractor     works for you`
    + `\n      foreman get homesteader    answers to nobody`
    + `\n  Ctrl-C stops everything\n`);

  const env = {
    AUREN_SERVER_HOST: host,
    AUREN_SERVER_PORT: port,
    OVERSEER_PORT: String(OVERSEER_PORT),
    OVERSEER_URL: `ws://localhost:${OVERSEER_PORT}`,
  };

  // THE REFEREE BEFORE THE DESK, and this order is load-bearing rather than tidy. The foreman reaches the
  // fleet through the overseer's in-game door — a socket on the overseer's port plus an offset — and a
  // `get` arriving before that door is listening is refused with "is the overseer up?". The pause is for
  // the person, not the protocol: it makes the first `get` work instead of the second.
  fleet.start('overseer', 'start_overseer.js', env);
  await fleet.waitFor(2000);

  // The desk names its own record `foreman` rather than inheriting a bot's name — see foreman.js. Passing
  // BOT_ID here would file the desk's log under whatever this shell happened to be carrying.
  fleet.start('foreman', 'foreman/foreman.js', { ...env, BOT_ID: 'foreman' });

  fleet.installSignals();
})();
