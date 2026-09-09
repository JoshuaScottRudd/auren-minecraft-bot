#!/usr/bin/env node
// start_overseer.js — the coordinator, started on its own, for somebody running more than one bot.
//
// WHAT THE OVERSEER IS: bots that share a world have to divide it. Two bots that both decide to fell the
// same tree, claim the same building anchor or mine the same cell do not fail loudly — they quietly undo
// each other's work. The overseer is the referee: bots ask it for an exclusive hold on a world object, it
// grants or refuses, and it hands out the planning turn so two bots never plan at the same instant. It
// also collects every bot's log into one stream, which is the only comfortable way to watch a crew.
//
// WHEN IT IS NOT NEEDED: one bot has nobody to collide with. `overseer_link.connect()` treats an absent
// URL as a supported state and says so — "running in local-brain mode" — rather than failing, so a single
// bot started with no `--overseer` is a complete, correct configuration and not a degraded one.
//
// WHY IT IS A SEPARATE SCRIPT RATHER THAN SOMETHING start_bot.js STARTS FOR YOU (Architect 2026-09-08:
// *"we give them their own scripts to do each piece individually… the script is to start the bot not the
// server and the bot"*). A script that quietly starts a second long-lived process leaves the person with a
// thing they did not ask for, cannot see, and will not know to stop. One piece per script means what is
// running is always what somebody typed.
//
// THE ORDER: start this first, then start each bot with `--overseer ws://localhost:3001`. Bots started
// before it are not lost — `overseer_link` schedules its own reconnect and joins when the port answers.

'use strict';

const path = require('path');

const DEFAULT_PORT = 3001;

function usage() {
  console.log(`
  Start the overseer — the referee that keeps several bots from colliding.

    node start_overseer.js [--port <n>]

    --port <n>   port to listen on  (default: ${DEFAULT_PORT})
    --help       this text

  Then start each bot pointed at it:

    node start_overseer.js
    node start_bot.js --name AurenBot --overseer ws://localhost:${DEFAULT_PORT}
    node start_bot.js --name TessaBot --overseer ws://localhost:${DEFAULT_PORT}

  Running one bot only? You do not need this. Start the bot with no
  --overseer and it plans alone, which is a supported way to run.
`);
}

const argv = process.argv.slice(2);

// FLAG WINS, THEN THE ENVIRONMENT, THEN THE DEFAULT — the same rule `start_bot.js` states, and it is
// here because this file was the one entry point that did not follow it. `OVERSEER_PORT` is read by
// `foreman/overseer_door.js` to find the in-game door, so the variable already decided where half the
// system looked while this half ignored it and bound 3001 regardless. A launcher stamping the
// environment (`start_auren.js`) was therefore silently overruled,
// and the symptom was an EADDRINUSE crash on a machine that already had an overseer (Law 16 — one fact,
// one place it is read from).
const ENV_PORT = process.env.OVERSEER_PORT;
let port = (ENV_PORT !== undefined && ENV_PORT !== '') ? ENV_PORT : DEFAULT_PORT;

for (let i = 0; i < argv.length; i++) {
  const raw = argv[i];
  if (raw === '--help' || raw === '-h') { usage(); process.exit(0); }
  const eq = raw.indexOf('=');
  const name = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).toLowerCase();
  if (!raw.startsWith('--') || name !== 'port') {
    console.error(`\n  '${raw}' is not an option — the only one is --port. Try --help.\n`);
    process.exit(1);
  }
  port = eq === -1 ? argv[++i] : raw.slice(eq + 1);
}

// Validated here rather than left to the server, because a port that is not a number reaches `listen()`
// as a string and fails with a message about the socket instead of about what was typed (Law 13 — the
// error should name the thing that is actually wrong).
const parsed = parseInt(port, 10);
if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 65536) {
  console.error(`\n  --port must be a number between 1 and 65535 (got '${port}').\n`);
  process.exit(1);
}

console.log(`\n  Auren — starting the overseer on port ${parsed}`
  + `\n  point bots at it with:  --overseer ws://localhost:${parsed}\n`);

// `overseer_server.js` reads its port from argv[2] and bootstraps its own module resolution, so the whole
// job here is to put a validated number in the place it looks and hand over. Rewriting argv rather than
// spawning keeps this to one process, which is what makes Ctrl-C behave the way a person expects.
process.argv = [process.argv[0], path.join(__dirname, 'overseer', 'overseer_server.js'), String(parsed)];
require('./overseer/overseer_server.js');
