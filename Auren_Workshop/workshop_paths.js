'use strict';
// workshop_paths — resolves the workshop, the bot and the repo root from one place, and registers the
// bot's @-aliases so workshop code can load bot fragments (Law 16: one crossing point, not one per file).
//
// ── THE BOUNDARY STAYS VISIBLE ──────────────────────────────────────────────────────────────────────
// A workshop file addressing a bot file writes `require(paths.bot('js_kernel/utils/rcon_link'))`, so
// that dependency is a fact anyone can grep for. The @-aliases are still registered here, for the
// reason they exist: the bot's own code says `require('@utils/x')` internally (Law 29).
//
// ── ORDER IS LOAD-BEARING IN registerAliases() ──────────────────────────────────────────────────────
// `module-alias` is a third-party package resolved through the bot's own node_modules, so the module
// homes go on NODE_PATH first, from the bot's own resolver, and only then is `module-alias` required.
//
// ── WHY THE MAP IS REBUILT INSTEAD OF `require('module-alias')(BOT_ROOT)` ───────────────────────────
// The alias map is read from the bot's package.json and joined into a fresh object on every call, so
// calling registerAliases() more than once in a process cannot double-join a path onto itself.
//
// ── IT NEVER GUESSES ────────────────────────────────────────────────────────────────────────────────
// `bot()` and `repo()` are computed from this file's own location and nothing else. A checkout that
// cannot find the bot beside it fails on the missing path Node names (Law 13).

const path = require('path');

// ── THE WORKSHOP IS A SUBDIRECTORY OF THE BOT ───────────────────────────────
// `bot()`, `repo()`, `workshop()` and `fleetLogs()` each name which side of that boundary a path is on.
//
// `repo()` reaches folders outside the shipped bot — the session layer and other operator-only data —
// that a download never has. Every caller checks existence first, and `preflight`'s shipped-tree pass
// refuses any `require` inside the bot that reaches private ground, so a missing folder there is a
// named refusal, never a silent failure. The Minecraft server folder, Java and the module homes are not
// reached through `repo()`: they are answered by `js_kernel/utils/workstation.js`, which tries a
// download's own layout first and the operator's workstation settings second.
const WORKSHOP_ROOT = __dirname;
const BOT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// bot(...parts) — a path inside the SHIPPED bot. The one crossing point of the split boundary.
function bot(...parts) { return path.join(BOT_ROOT, ...parts); }

// repo(...parts) — a path inside the repository root: Sessions, Privacy, Cutting_room. Everything that is
// neither the bot nor the workshop, except what `js_kernel/utils/workstation.js` answers.
function repo(...parts) { return path.join(REPO_ROOT, ...parts); }

// workshop(...parts) — a path inside the workshop itself, for a tool spawning a sibling tool.
function workshop(...parts) { return path.join(WORKSHOP_ROOT, ...parts); }

// fleetLogs(...parts) — where a run's records land. THIS IS INSIDE THE BOT, not the workshop, and that
// is not an accident of history: the bot writes the trace, the workshop only reads it. A user who never
// installs the workshop still gets a full trace, which is the entire support model of the shipped layer.
function fleetLogs(...parts) { return path.join(BOT_ROOT, 'fleet_logs', ...parts); }

// bootstrapModules() — put this machine's node_modules on NODE_PATH, using the bot's own resolver so
// there is still exactly one answer to that question in the tree (Law 16). Returns the homes it used.
function bootstrapModules() {
  return require(bot('js_kernel', 'utils', 'node_module_homes')).bootstrapModulePath();
}

let _aliasesRegistered = false;

// registerAliases() — make the bot's @-aliases resolve in this process, so bot fragments load. Reads
// the canonical map from the bot's own package.json: the aliases are the BOT'S declaration of its
// internal layout and a second copy here would be a staler answer to a question already answered.
function registerAliases() {
  if (_aliasesRegistered) return;
  bootstrapModules();
  const declared = require(bot('package.json'))._moduleAliases || {};
  const resolved = {};
  for (const alias of Object.keys(declared)) resolved[alias] = bot(declared[alias]);
  require('module-alias').addAliases(resolved);
  _aliasesRegistered = true;
}

module.exports = {
  WORKSHOP_ROOT, REPO_ROOT, BOT_ROOT,
  bot, repo, workshop, fleetLogs,
  bootstrapModules, registerAliases,
};
