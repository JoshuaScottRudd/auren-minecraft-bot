#!/usr/bin/env node
// start_homestead_bots.js — TWO BOTS THAT ANSWER TO NOBODY, IN ONE COMMAND.
//
// WHAT THIS IS FOR: the person who wants to watch the thing work. It raises the referee and two
// homesteaders, and then nothing else happens because nothing else is supposed to — they look at the
// world, find it empty of the things that should be there, and start building. No command is given
// because a homesteader has no ear to give one to.
//
// ── WHY THIS FILE EXISTS AND `start_bot.js --mode homesteader --name X --overseer ws://...` DOES NOT ───
// (Architect 2026-09-09: *"i dont think the dynamic is stated properly… im not liking how they have to
// keep track of variables like their name."*)
//
// The flag form made a person hold four facts in their head — a name, a species, a port, a URL — and
// three of them have exactly one correct value. A name they invent is a name they must then remember to
// reuse, because a bot's memory of the world is filed under it. **The name is not a choice the system
// wanted from them; it was a parameter leaking out of the implementation.** This file makes the two
// choices that are real (which world, how many) and settles the rest.
//
// ── WHY TWO ──────────────────────────────────────────────────────────────────────────────────────────
// One bot cannot demonstrate the thing this project is about. The interesting behaviour is two bots
// dividing a world that neither of them owns — the tree one of them claimed, the anchor the other cannot
// have — and one bot has nobody to divide with. Two is also the crew size the foreman hands out, so the
// two ways in show the same shape.
//
// ── IT IS NOT A SECOND LAUNCHER (Law 16) ─────────────────────────────────────────────────────────────
// `start_bot.js` is still the one place a bot is born and `start_overseer.js` is still the one place the
// referee is raised. This file spawns THOSE. It stamps no mandate, requires no master_core and knows
// nothing about what a bot does — delete it and both pieces still start exactly as they did.

'use strict';

const fleet = require('./js_kernel/utils/child_fleet');

// NOT A FLAG, DELIBERATELY. The referee's port is not a decision anybody running this has to make, so it
// is not offered as one — it is settled here and threaded through to both halves so they cannot disagree.
// The environment override exists for the one case where it is not free: a machine already running an
// overseer (the Architect's own does, permanently), where a second fleet would otherwise die on
// EADDRINUSE. Invisible unless somebody needs it, which is the difference between an escape hatch and a
// knob (Architect 2026-09-09: *"im not liking how they have to keep track of variables"*).
const OVERSEER_PORT = Number(process.env.OVERSEER_PORT) || 3001;
const CREW = ['AurenBot', 'TessaBot'];

// The gap between one body knocking on the server's door and the next. A world behind a login rate limit
// drops the second knock before authentication and logs no refusal anywhere, so the bot records a socket
// closed at zero seconds and nothing says why. The foreman spaces its own launches for this reason.
const JOIN_GAP_MS = 4000;

const FLAGS = [
  { flag: 'host', def: 'localhost', help: 'server address the bots connect to' },
  { flag: 'port', def: '25565', help: 'server port' },
];

function usage() {
  console.log(`
  Start two homesteader bots and the referee that keeps them out of each other's way.

    node start_homestead_bots.js [--host <address>] [--port <n>]

    --host <address>   server address the bots connect to  (default: localhost)
    --port <n>         server port  (default: 25565)
    --help             this text

  What happens:
    ${CREW.join(' and ')} join your world and start working. They are homesteaders —
    they answer to nobody, so talking to them in chat does nothing. They decide what
    to do by looking at the world: find somewhere to live, chop wood, build, farm,
    mine, defend themselves, and keep going.

    Ctrl-C stops all three.

  Want bots that take your orders instead?
    node start_contractor_bots.js
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
  console.log(`\n  Auren — ${CREW.length} homesteaders on ${host}:${port}`
    + `\n  they answer to nobody and start working on their own`
    + `\n  Ctrl-C stops everything\n`);

  // THE REFEREE FIRST, AND THE BOTS DO NOT WAIT FOR IT. `overseer_link` treats a refused connection as a
  // state to retry rather than a failure, so a bot that starts before the port answers joins when it does.
  // Raising it first simply means that window is measured in milliseconds instead of being a race nobody
  // can see (Invariant B — the bot re-senses rather than being told once at birth).
  fleet.start('overseer', 'start_overseer.js', { OVERSEER_PORT: String(OVERSEER_PORT) });
  await fleet.waitFor(1500);

  for (const name of CREW) {
    // THE MANDATE IS STAMPED HERE AND `start_bot.js` READS IT. Passing environment rather than flags is
    // the path `start_bot.js` documents for a non-human caller: a flag that is absent falls back to the
    // variable it would have set, so a stamp passes through untouched and cannot be half-applied.
    fleet.start(name, 'start_bot.js', {
      BOT_ID: name,
      BOT_MODE: 'homesteader',
      AUREN_SERVER_HOST: host,
      AUREN_SERVER_PORT: port,
      OVERSEER_URL: `ws://localhost:${OVERSEER_PORT}`,
      // RUNNING THIS SCRIPT IS THE DECISION TO START THEM. A homesteader otherwise stands and waits for
      // an operator's `start`, which in a crew of two has no sender: `stdio` is inherited, so a line
      // typed at this terminal reaches whichever child reads it first. Stamped at birth instead — see
      // `bot_mandate.beginsWorkAtBirth` for the live run that found this and why the fix is the
      // contractor's own mechanism rather than a second one.
      BOT_AUTOSTART: '1',
      // A homesteader answers to nobody, and `bot_mandate` refuses one carrying an owner rather than
      // ignoring it. Inherited environment is the only way one could arrive here, so it is cleared
      // rather than trusted (Law 13 — the pairing cannot be got wrong if it cannot be spawned wrong).
      BOT_OWNER: '',
    });
    if (name !== CREW[CREW.length - 1]) await fleet.waitFor(JOIN_GAP_MS);
  }

  fleet.installSignals();
})();
