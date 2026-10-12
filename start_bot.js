#!/usr/bin/env node
// start_bot.js — THE ONE LAUNCHER OF A BOT BODY (Law 16).
//
// WHAT IT IS FOR: somebody who is not the operator, on a machine that is not one of the operator's own,
// who has a Minecraft server of their own and wants a bot in it. They type one line and a bot joins.
// Nothing about this file assumes Windows, PowerShell, a portable Node unpacked in a sibling folder, a
// `MinecraftServer/` directory next to the repo, or a fleet.
//
// ── WHAT THIS FILE OWNS, DISTINCT FROM fleet_control.js ───────────────────────────────────────────────
// `fleet_control.js` is a fleet tool, not a launcher: it starts a Minecraft server of its own, manages a
// roster of eight, writes a PID registry, and spawns minimized PowerShell windows. None of that belongs
// in a file meant to run on somebody else's machine with none of that infrastructure. This file starts
// exactly one bot with none of it.
//
// ── ONE LAUNCHER, NOT TWO (Law 16) ────────────────────────────────────────────────────────────────────
// This file stamps the mandate, and `fleet_control` spawns this instead of requiring master_core
// directly. The fleet keeps its roster, its PID registry, its windows and its server management; the act
// of birth lives in exactly one place, here.
//
// ── HOW THE TWO CALLERS BOTH WORK, WITH ONE RULE ───────────────────────────────────────────────────────
// A flag that is GIVEN wins. A flag that is ABSENT falls back to the environment variable it would have
// set. That single rule serves both callers without either knowing about the other:
//   · a person types flags, and the environment is empty, so the flags decide everything;
//   · `fleet_control` stamps the environment and passes no flags, so its stamp passes through untouched.
// Neither caller can be half-configured: the mandate is complete before master_core is required, and
// `bot_mandate.readMandate()` throws on anything missing (Law 13).
//
// ── HOW master_core IS STARTED ────────────────────────────────────────────────────────────────────────
// `master_core.js` has no `require.main` guard and exports nothing, so requiring it runs it, in this
// process, with the environment this file has just finished stamping. One process, one bot, and Ctrl-C
// ends it the way a person expects.

'use strict';

const path = require('path');

// ── The flags, and what each one becomes ───────────────────────────────────────────────────────────────
// Kept as a table so `--help` is generated from the same table the parser reads: a flag that is
// documented but not honoured, or honoured but not documented, cannot happen here.
// The address defaults come from `foreman_config.js`, the one page a downloader edits, so an edit there
// reaches a bot started directly by this door too (Law 16).
// A flag still wins, and the environment still wins over the file; this only settles what happens when
// nobody has said anything.
const WORLD = require('./foreman_config');
const FLAGS = [
  { flag: 'host',     env: 'AUREN_SERVER_HOST',        def: WORLD.host, help: 'server address the bot connects to' },
  { flag: 'port',     env: 'AUREN_SERVER_PORT',        def: String(WORLD.port), help: 'server port' },
  { flag: 'name',     env: 'BOT_ID',                   def: 'AurenBot',  help: "the bot's name in the world" },
  { flag: 'mode',     env: 'BOT_MODE',                 def: 'homesteader', help: 'homesteader | builder | contractor' },
  { flag: 'owner',    env: 'BOT_OWNER',                def: null,        help: 'your Minecraft name — REQUIRED for contractor, forbidden for homesteader' },
  { flag: 'near',     env: 'BOT_START_NEAR',           def: null,        help: 'a player in the world, or a cell written "x y z" — the bot is teleported there and confirmed before it starts working (a contractor uses its owner when this is absent)' },
  { flag: 'version',  env: 'AUREN_MINECRAFT_VERSION',  def: null,        help: "the server's Minecraft version (default: 26.1, set in architect_config)" },
  { flag: 'foreman', env: 'FOREMAN_URL',             def: null,        help: 'ws://host:port of a running foreman — omit it and the bot runs alone' },
  // BOT_AUTOSTART is not a flag here: `foreman.js` stamps it into a fetched body's environment, and
  // `bot_mandate` reads it once at birth. Standing in the world and asking the desk (`foreman get
  // homesteader`) is the one door to a working bot (Law 16).

  // Needed only when this bot has somebody to be placed beside (`--near`, or a contractor's owner):
  // reaching a server console is what a teleport costs. `start_auren.js` carries the same two flags and
  // proves the link before it opens the desk; here they are simply passed through, because a bot launched
  // by hand may legitimately have nobody to stand with and then never asks for a console at all.
  { flag: 'rcon-password', env: 'AUREN_RCON_PASSWORD', def: null,        help: "your server's rcon.password — required to place this bot beside a player" },
  { flag: 'rcon-port',     env: 'AUREN_RCON_PORT',     def: null,        help: "your server's rcon.port  (default: 25575)" },
];

function usage() {
  const w = Math.max(...FLAGS.map(f => f.flag.length));
  console.log(`
  Start one Auren bot and connect it to a Minecraft server.

    node start_bot.js [options]

  Options:`);
  for (const f of FLAGS) {
    console.log(`    --${f.flag.padEnd(w)} <value>   ${f.help}${f.def ? `  (default: ${f.def})` : ''}`);
  }
  console.log(`    --${'help'.padEnd(w)}            this text

  Examples:
    node start_bot.js
        a homesteader named AurenBot, on a server at localhost:25565.

    node start_bot.js --host mc.example.com --name Iris
        a homesteader on somebody else's server.

    node start_bot.js --mode contractor --owner YourMinecraftName
        a contractor: it hears you in chat and works your orders.

  The two species:
    homesteader   answers to nobody and works its own agenda. It mounts no chat
                  listener at all, so it does not ignore you — it has no ear.
    contractor    the same bot with the human channels added. It hears you, takes
                  your orders, and belongs to the name you pass as --owner.

  Running more than one bot:
    Start the fleet once (node start_auren.js — the foreman runs inside
    the foreman), then give every bot --foreman ws://127.0.0.1:3001 so
    they can divide work instead of colliding. One bot on its own does not
    need it.
`);
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────
// Accepts `--flag value` and `--flag=value`. An unknown flag is a hard stop: somebody who typed
// `--server` meaning `--host` is better served by being told than by silently getting localhost.
function parse(argv) {
  const known = new Set(FLAGS.map(f => f.flag));
  const got = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--help' || raw === '-h') return null;
    if (!raw.startsWith('--')) die(`'${raw}' is not an option. Options start with --. Try --help.`);
    const eq = raw.indexOf('=');
    const name = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).toLowerCase();
    if (!known.has(name)) die(`'--${name}' is not an option. Try --help for the list.`);
    const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
    if (value === undefined || value.startsWith('--')) die(`'--${name}' needs a value after it.`);
    got[name] = value;
  }
  return got;
}

function die(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

const given = parse(process.argv.slice(2));
if (given === null) { usage(); process.exit(0); }

// ── Stamping ───────────────────────────────────────────────────────────────────────────────────────────
// Flag wins, then existing environment, then the default. `owner`, `version` and `foreman` have no
// default on purpose — an absent one must stay absent, because `bot_mandate` reads the difference between
// a homesteader with no owner set and a homesteader with an empty owner, and refuses the second.
for (const f of FLAGS) {
  const value = given[f.flag] !== undefined ? given[f.flag]
              : process.env[f.env] !== undefined ? process.env[f.env]
              : f.def;
  if (value === null || value === undefined || value === '') delete process.env[f.env];
  else process.env[f.env] = String(value);
}

// ── Two refusals worth catching here, before downstream ───────────────────────────────────────────────
// `bot_mandate.readMandate()` already refuses both of these, correctly and loudly, and it stays the one
// place the rule lives (Law 16). What it cannot do is tell a stranger what to type instead, because its
// error speaks to a process, not a person. These two messages exist purely to turn a correct throw into
// an actionable sentence; the rule itself is not restated or re-implemented.
const mode = (process.env.BOT_MODE || '').toLowerCase();
// The foreman raises a builder crew from foreman_config's `crew`, and this launcher is its one birth too.
if (mode !== 'homesteader' && mode !== 'contractor' && mode !== 'builder') {
  die(`--mode must be 'homesteader', 'builder' or 'contractor' (got '${process.env.BOT_MODE}').`);
}
if (mode === 'contractor' && !process.env.BOT_OWNER) {
  die("a contractor belongs to somebody: add --owner <YourMinecraftName>.\n"
    + "  Or start a homesteader instead, which answers to nobody: --mode homesteader");
}
if (mode === 'homesteader' && process.env.BOT_OWNER) {
  die(`a homesteader answers to nobody, so it cannot have --owner '${process.env.BOT_OWNER}'.\n`
    + "  Drop --owner, or start a contractor instead: --mode contractor");
}

// ── Third-party packages ───────────────────────────────────────────────────────────────────────────────
// Asked of the one file that knows where they live. On a normal installation this finds nothing and
// changes nothing — `npm install` puts them in `node_modules` right here, which Node resolves without
// help. It matters only on a machine where they sit in a sibling directory. It never throws and never
// invents a path: a machine with none of them falls through to Node's own error, which names the missing
// package (Law 13).
require('./js_kernel/utils/node_module_homes').bootstrapModulePath();

console.log(`\n  Auren — starting '${process.env.BOT_ID}' as a ${mode}`
  + `${process.env.BOT_OWNER ? ` for ${process.env.BOT_OWNER}` : ''}`
  + `\n  connecting to ${process.env.AUREN_SERVER_HOST}:${process.env.AUREN_SERVER_PORT}`
  + `${process.env.FOREMAN_URL ? `\n  foreman: ${process.env.FOREMAN_URL}` : '\n  no foreman — this bot plans alone'}`
  + `\n  everything it does is written to ${path.join(__dirname, 'fleet_logs', 'traces')}\n`);

// The mandate is complete. Requiring master_core IS starting the bot.
require('./master_core.js');
