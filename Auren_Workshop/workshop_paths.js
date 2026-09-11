'use strict';
// workshop_paths — the ONE answer to "where is the bot, and where is the repo, from inside the workshop".
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────────
// The workshop and the shipped bot are two sibling directories under one repo root. Every instrument,
// bench, probe, lens and launcher in here has to reach across that boundary — to load a fragment, to
// read a run record, to resolve a third-party package — and before this file existed each one answered
// "where is the bot" for itself, as `path.join(__dirname, '..')`. That sentence was true only while the
// tools lived INSIDE the bot directory. Fifty-five copies of one assumption, each silently wrong the
// moment the layout moved, is the exact shape of the defect `js_kernel/utils/node_module_homes` was
// written to end one layer down: four hand-written answers to "where do the node modules live" that had
// drifted apart, one of them making the camera rig single-machine for weeks with nothing to say so.
//
// So the boundary gets one crossing point. If the layout moves again it is this file, not fifty-five.
//
// ── THE BOUNDARY IS DELIBERATELY VISIBLE, NOT ALIASED AWAY ──────────────────────────────────────────
// A workshop file addressing a bot file writes `require(paths.bot('js_kernel/utils/rcon_link'))` rather
// than an `@utils/...` alias. The alias would be shorter and it would also make the crossing invisible:
// the whole point of the split is that "this workshop file depends on shipped bot code" is a fact
// somebody can grep for in one string. The @-aliases still exist and are still registered here — but
// for the reason they were invented, which is that the BOT'S OWN code says `require('@utils/x')`
// internally and cannot load without them (Law 29: two different topics, one list each).
//
// ── ORDER IS LOAD-BEARING IN registerAliases() ──────────────────────────────────────────────────────
// `module-alias` is a third-party package and it lives in a node_modules that is in a different place
// on every machine. Inside the bot directory Node found it by walking up to `Auren_Bot/node_modules`;
// from the workshop that walk now ends at the repo root and finds nothing. So the module homes go on
// NODE_PATH FIRST, from the bot's own resolver, and only then is `module-alias` required by name.
//
// ── WHY THE MAP IS REBUILT INSTEAD OF `require('module-alias')(BOT_ROOT)` ───────────────────────────
// That one-liner is the documented way to load a package.json's `_moduleAliases`, and calling it twice
// in one process CORRUPTS the map on Windows. It resolves each relative target in place, in the object
// Node has cached for that package.json, and its "already absolute" test is `value[0] !== '/'` — which
// is false for `C:\Auren\...`. A second call therefore joins the base onto an already-joined path and
// every alias points at `C:\Auren\Auren_Bot\C:\Auren\Auren_Bot\js_kernel`. Reading the map and joining
// into a FRESH object cannot do that, however many callers ask. The idempotence flag below is still
// kept, because repeating the work is waste even when it is harmless.
//
// ── IT NEVER GUESSES ────────────────────────────────────────────────────────────────────────────────
// `bot()` and `repo()` are computed from this file's own location and nothing else. There is no
// environment override and no search: a workshop that cannot find the bot beside it is a broken
// checkout, and it should fail on the missing file with Node's own message naming the path it wanted
// (Law 13 — never default a missing field into a plausible wrong answer).

const path = require('path');

// ── THE WORKSHOP LIVES INSIDE THE BOT NOW (Architect 2026-09-10) ────────────────────────────────────
// *"the tools need to live with the bot to read the bot and i should just ship the whole thing as one
// piece and hand people scripts to run the thing instead of hiding it from them."*
//
// It was a SIBLING of `Auren_Bot/`, and these three lines are the entire structural cost of the move:
// `bot()`, `repo()`, `workshop()`, `fleetLogs()` and `registerAliases()` all keep their signatures, so
// the other 142 files in this folder did not change. That is why the folder moved WHOLE rather than
// being flattened into `Auren_Bot/tools/` + `Auren_Bot/scripts/` — the flat version reads better and
// touches every path in the repository.
//
// `repo()` NOW POINTS AT SOMEBODY ELSE'S PARENT DIRECTORY ON A STRANGER'S MACHINE, and that is fine
// because of what it is used for: `Sessions/` (the AI-developer session layer) and the Architect's other
// private folders. All are absent from a download by design, all are asked for through an existence
// check, and `preflight`'s shipped-tree pass refuses any `require` that reaches private ground — so a
// wrong answer from `repo()` can only ever be a missing-directory refusal that names itself, never a
// silent load-time failure. THE MINECRAFT SERVER FOLDER, JAVA AND THE MODULE HOMES ARE NOT reached
// through `repo()` (2026-09-11): they are `js_kernel/utils/workstation.js`'s answers, which try the
// stranger's way first and the Architect's workstation file second.
const WORKSHOP_ROOT = __dirname;
const BOT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// bot(...parts) — a path inside the SHIPPED bot. The one crossing point of the split boundary.
function bot(...parts) { return path.join(BOT_ROOT, ...parts); }

// repo(...parts) — a path inside the repository root: Sessions, Privacy, Cutting_room. Everything that is
// neither the bot nor the workshop, except what `js_kernel/utils/workstation.js` answers.
function repo(...parts) { return path.join(REPO_ROOT, ...parts); }

// workshop(...parts) — a path inside the workshop itself. Present so a tool spawning a sibling tool
// states which side of the boundary it means rather than leaning on `__dirname` arithmetic.
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
