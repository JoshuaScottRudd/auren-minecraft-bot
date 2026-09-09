#!/usr/bin/env node
// start_bot.js — THE ONE LAUNCHER OF A BOT BODY (Law 16).
//
// WHAT IT IS FOR: somebody who is not the Architect, on a machine that is not one of his two, who has a
// Minecraft server of their own and wants a bot in it. They type one line and a bot joins. Nothing about
// this file assumes Windows, PowerShell, a portable Node unpacked in a sibling folder, a `MinecraftServer/`
// directory next to the repo, or a fleet.
//
// ── WHY IT EXISTS AT ALL ───────────────────────────────────────────────────────────────────────────────
// `fleet_control.js` used to be the only thing in this tree that could start a bot, and it is not a
// launcher — it is a repo-layout tool. It resolves a PROJECT_ROOT above the bot and expects siblings
// (`MinecraftServer/`, `node_env2/`, `node_portable/`, a JDK), starts the Architect's own world, manages a
// roster of eight, writes a PID registry, and spawns minimized PowerShell windows. Every one of those is
// correct for him and impossible for anybody else. Carving it away for a public copy would have left the
// shipped layer with no way to start at all, which is why this file is written BEFORE anything moves.
//
// ── IT IS THE ONE LAUNCHER, NOT A SECOND ONE (Law 16, and this is the load-bearing part) ───────────────
// `fleet_control.js` carried the comment "THE ONE LAUNCHER of master_core.js in the whole tree, and it
// stays that way". Adding a second entry point that also stamps a mandate and requires master_core would
// have been exactly the duplication that comment forbids — two places that birth a bot, drifting apart the
// first time one of them learns something the other does not. So the direction was inverted instead:
// **this file stamps the mandate, and `fleet_control` spawns THIS** rather than master_core. The fleet
// keeps its roster, its PID registry, its windows and its server management; what it no longer owns is the
// act of birth. There is still exactly one place a bot is born, and it is here.
//
// ── HOW THE TWO CALLERS BOTH WORK, WITH ONE RULE ───────────────────────────────────────────────────────
// A flag that is GIVEN wins. A flag that is ABSENT falls back to the environment variable it would have
// set. That single rule serves both callers without either knowing about the other:
//   · a person types flags, and the environment is empty, so the flags decide everything;
//   · `fleet_control` stamps the environment and passes no flags, so its stamp passes through untouched.
// It also means neither caller can be half-configured: whatever the source, the mandate is complete before
// master_core is required, and `bot_mandate.readMandate()` throws on anything missing rather than
// defaulting (Law 13).
//
// ── WHY IT REQUIRES master_core RATHER THAN SPAWNING IT ────────────────────────────────────────────────
// A spawn would need a Node path, a shell, and a platform decision — the three things this file exists to
// avoid. `master_core.js` has no `require.main` guard and exports nothing, so requiring it simply runs it,
// in this process, with the environment this file has just finished stamping. One process, one bot, and
// Ctrl-C ends it the way a person expects.

'use strict';

const path = require('path');

// ── The flags, and what each one becomes ───────────────────────────────────────────────────────────────
// Kept as a table rather than a parser full of if-statements so that `--help` is generated FROM the same
// table the parser reads. A flag that is documented but not honoured (or honoured but not documented) is
// not possible here, which is the failure this shape is chosen to prevent.
const FLAGS = [
  { flag: 'host',     env: 'AUREN_SERVER_HOST',        def: 'localhost', help: 'server address the bot connects to' },
  { flag: 'port',     env: 'AUREN_SERVER_PORT',        def: '25565',     help: 'server port' },
  { flag: 'name',     env: 'BOT_ID',                   def: 'AurenBot',  help: "the bot's name in the world" },
  { flag: 'mode',     env: 'BOT_MODE',                 def: 'homesteader', help: 'homesteader | contractor' },
  { flag: 'owner',    env: 'BOT_OWNER',                def: null,        help: 'your Minecraft name — REQUIRED for contractor, forbidden for homesteader' },
  { flag: 'version',  env: 'AUREN_MINECRAFT_VERSION',  def: null,        help: "the server's Minecraft version (default: 1.21.5, set in architect_config)" },
  { flag: 'overseer', env: 'OVERSEER_URL',             def: null,        help: 'ws://host:port of a running overseer — omit it and the bot runs alone' },
  { flag: 'work',     env: 'BOT_AUTOSTART',            def: null,        help: "pass 1 and a homesteader starts working on spawn instead of waiting for you to type 'start'" },
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
    Start the overseer once (node start_overseer.js), then give every bot
    --overseer ws://localhost:3001 so they can divide work instead of
    colliding. One bot on its own does not need it.
`);
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────
// Accepts `--flag value` and `--flag=value`. An unknown flag is a hard stop rather than a shrug: somebody
// who typed `--server` meaning `--host` is better served by being told than by silently getting localhost.
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
// Flag wins, then existing environment, then the default. `owner`, `version` and `overseer` have no
// default on purpose — an absent one must stay absent, because `bot_mandate` reads the DIFFERENCE between
// "homesteader with no owner" and "homesteader with an empty owner" and refuses the second.
for (const f of FLAGS) {
  const value = given[f.flag] !== undefined ? given[f.flag]
              : process.env[f.env] !== undefined ? process.env[f.env]
              : f.def;
  if (value === null || value === undefined || value === '') delete process.env[f.env];
  else process.env[f.env] = String(value);
}

// ── The two refusals that are worth making HERE rather than downstream ─────────────────────────────────
// `bot_mandate.readMandate()` already refuses both of these, correctly and loudly, and it stays the one
// place the rule lives (Law 16). What it cannot do is tell a stranger what to type instead, because it is
// speaking to a process rather than a person. These two messages exist purely to turn a correct throw into
// an actionable sentence; the rule itself is not restated or re-implemented.
const mode = (process.env.BOT_MODE || '').toLowerCase();
if (mode !== 'homesteader' && mode !== 'contractor') {
  die(`--mode must be 'homesteader' or 'contractor' (got '${process.env.BOT_MODE}').`);
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
// help. It matters only on the Architect's machines, where they sit in a sibling directory. It never
// throws and never invents a path: a machine with none of them falls through to Node's own error, which
// names the missing package (Law 13).
require('./js_kernel/utils/node_module_homes').bootstrapModulePath();

console.log(`\n  Auren — starting '${process.env.BOT_ID}' as a ${mode}`
  + `${process.env.BOT_OWNER ? ` for ${process.env.BOT_OWNER}` : ''}`
  + `\n  connecting to ${process.env.AUREN_SERVER_HOST}:${process.env.AUREN_SERVER_PORT}`
  + `${process.env.OVERSEER_URL ? `\n  overseer: ${process.env.OVERSEER_URL}` : '\n  no overseer — this bot plans alone'}`
  + `\n  everything it does is written to ${path.join(__dirname, 'fleet_logs', 'traces')}\n`);

// The mandate is complete. Requiring master_core IS starting the bot.
require('./master_core.js');
