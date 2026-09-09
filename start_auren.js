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

const fleet = require('./js_kernel/utils/child_fleet');

// NOT A FLAG, and that is the line his instruction draws: *"im not liking how they have to keep track of
// variables like their name."* The port is settled rather than offered. The environment override exists
// for a machine that already runs an overseer permanently — his does — and is invisible to everyone else.
const OVERSEER_PORT = Number(process.env.OVERSEER_PORT) || 3001;

const FLAGS = [
  { flag: 'host', def: 'localhost', help: 'server address the foreman connects to' },
  { flag: 'port', def: '25565', help: 'server port' },
];

function usage() {
  console.log(`
  Start Auren: the desk you hire bots from, and the referee that keeps them apart.

    node start_auren.js [--host <address>] [--port <n>]

    --host <address>   server address the foreman connects to  (default: localhost)
    --port <n>         server port  (default: 25565)
    --help             this text

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

const host = given.host || 'localhost';
const port = given.port || '25565';

(async () => {
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
