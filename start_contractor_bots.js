#!/usr/bin/env node
// start_contractor_bots.js — THE DESK OPENS, AND YOU HIRE YOUR CREW FROM INSIDE THE GAME.
//
// WHAT THIS IS FOR: the person who wants bots that work for them. It raises the referee and the foreman —
// a clerk that stands in your world and listens — and then stops. **No bot is started by this script, and
// that is the design rather than an omission.** You walk up to the foreman, ask for a crew, and it fetches
// one and brings it to you.
//
//   node start_contractor_bots.js        ← here
//   then, in Minecraft chat:  foreman get
//
// ── WHY THE BOTS COME FROM INSIDE THE GAME AND NOT FROM THIS SCRIPT (Law 16) ─────────────────────────
// (Architect 2026-09-09: *"i dont want someone who pulls my repo to use the project any different from
// how i do it or that its normally done. you call contractors from inside the game."*)
//
// A contractor exists because somebody in the world asked for it. That is not a formality — the OWNER is
// stamped into the body at launch, the bot declares it when it registers, and every delivery and every
// order is filtered on it. A script that started contractors from a terminal would have to invent an
// owner from a flag, which is a claim nobody in the world made. **The in-game request is not a nicer
// front end for the terminal path; it is the only path, and this file's job is to make it available.**
//
// ── WHAT THE TWO PROCESSES ARE ───────────────────────────────────────────────────────────────────────
//   overseer — the referee. Hands out exclusive holds on world objects so two bots never claim one tree,
//              and hands out the planning turn so two never plan at the same instant.
//   foreman  — the desk. A client that joins your world under its own name, listens for the handful of
//              words below, and fetches bodies. It is not a bot: no mandate, no headquarters, no jobs.
//
// ── IT IS NOT A SECOND LAUNCHER (Law 16) ─────────────────────────────────────────────────────────────
// `start_bot.js` remains the one birth and `start_overseer.js` the one referee. This file spawns the
// overseer and the foreman; the foreman spawns `start_bot.js` when somebody asks it to. Nothing here
// stamps a mandate.

'use strict';

const fleet = require('./js_kernel/utils/child_fleet');

// Not a flag — see the same constant in `start_homestead_bots.js` for why the port is settled rather than
// offered, and why the environment override exists for a machine that already has an overseer.
const OVERSEER_PORT = Number(process.env.OVERSEER_PORT) || 3001;

const FLAGS = [
  { flag: 'host', def: 'localhost', help: 'server address the foreman connects to' },
  { flag: 'port', def: '25565', help: 'server port' },
];

function usage() {
  console.log(`
  Start the desk you hire bots from, and the referee that keeps them apart.

    node start_contractor_bots.js [--host <address>] [--port <n>]

    --host <address>   server address the foreman connects to  (default: localhost)
    --port <n>         server port  (default: 25565)
    --help             this text

  What happens:
    A foreman joins your world. No bots start yet — you ask for them in chat:

      foreman get       fetch your crew of 2 and bring them to you
      foreman help      the words it knows
      foreman stop      send your crew home

    The bots it brings are contractors: they belong to you, they hear you in
    chat, and they work what you ask for. Say the bot's name and then what
    you want.

    Ctrl-C stops the desk, the referee, and any crew the foreman fetched.

  Want bots that ignore you and just build? That is the other way in:
    node start_homestead_bots.js
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
    + `\n  when the foreman has joined, type this in Minecraft chat:  foreman get`
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
