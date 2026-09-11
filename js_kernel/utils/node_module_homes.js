// node_module_homes — the ONE answer to "where do the third-party node modules live on THIS machine".
//
// mineflayer, vec3, prismarine-*, ws and module-alias are not checked in beside the code that uses them.
// A stranger's copy has them in `Auren_Bot/node_modules`, put there by `npm install`. The Architect's
// machines have more homes than that — the ones his workstation file lists — and nothing in Node finds
// those by itself, so every entry point that touches a live client puts the list on NODE_PATH before its
// first require.
//
// ── WHY IT IS A FILE ────────────────────────────────────────────────────────────────────────────────
// It was copied, not shared — FOUR implementations of one question, and they had drifted apart:
//   camera/camera_scout.js      node_env2 ONLY. The narrowest, and the one every camera process runs.
//   tools/lanista_shared.js     node_env2 + MinecraftServer  ┐ three byte-identical IIFEs, each with a
//   tools/locomotion_course.js  node_env2 + MinecraftServer  │ comment explaining the same two machines
//   tools/raycast_crucible.js   node_env2 + MinecraftServer  ┘
//   fleet_control.js            node_env2 + MinecraftServer + Auren_Bot, twice (nodePathEnv, requireWs)
//
// The drift had a visible cost and it is why this exists. The three tools boot the WIDE list before
// requiring the scout, so the scout's narrow one never fires and they work on both machines. The camera
// requires the scout directly — so `camera_rig` was silently primary-workstation-only, and stayed that
// way for as long as the scout had only one job (filming, which only ever happened at home). Give the
// same client a second job that matters on the other machine and the defect surfaces immediately.
// That is Law 16's delete-test failing in the direction nobody checks: the redundant copies were not
// dead, they were each quietly doing the job the canonical one did worse.
//
// ── THE ORDER IS THE WORKSTATION RULE (Architect 2026-09-11) ────────────────────────────────────────
// *"if run then check stranger way, if fail then architect way."* The bot's own node_modules comes first
// — it is the stranger's home, and the one every require inside Auren_Bot/ reaches by walking up anyway —
// and the homes listed in `../Architect_workstation/workstation.json` follow, read through
// `workstation.js`, the one JS reader of that file. On a stranger's machine the list is one entry long.
// His folder names are written in that file and nowhere in this one.
//
// ── IT NEVER THROWS AND NEVER DEFAULTS ──────────────────────────────────────────────────────────────
// A machine with none of them is a real state (a laptop with no game installed running a lens), and the
// correct behaviour there is to change nothing and say so by returning an empty list — the caller then
// fails on its own `require('mineflayer')` with Node's own message, which names the missing package.
// Inventing a path here would replace that with a resolution error that names the wrong thing (Law 13:
// never default a missing field).

'use strict';

const path = require('path');
const fs = require('fs');
const { architectPaths } = require('./workstation');

const BOT_ROOT = path.resolve(__dirname, '..', '..');

// Every home this machine may have, in priority order: the stranger's first, then his.
const CANDIDATE_HOMES = [
  path.join(BOT_ROOT, 'node_modules'),
  ...architectPaths('node_modules'),
];

// moduleHomes() — the candidates that actually exist here, in priority order. Read fresh on every call
// rather than cached at load: a caller may run before an install and again after, and a cached empty
// list would outlive the condition that produced it (Invariant B).
function moduleHomes() {
  return CANDIDATE_HOMES.filter(fs.existsSync);
}

// bootstrapModulePath() — put every home on NODE_PATH and re-initialise Node's resolver. Returns the
// list it used, so a caller can report which machine it decided it was on.
//
// IDEMPOTENT, and that is load-bearing rather than tidy: the three tools boot this and then require the
// scout, which boots it again, and a process that appends the same directory on every require grows
// NODE_PATH without bound and re-walks it on every unresolved module. Already-present entries are
// skipped, so calling it from every entry point is free and none of them has to know who called first.
function bootstrapModulePath() {
  const homes = moduleHomes();
  const already = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  const added = homes.filter(h => !already.includes(h));
  if (!added.length) return homes;
  process.env.NODE_PATH = [...already, ...added].join(path.delimiter);
  require('module').Module._initPaths();
  return homes;
}

// nodePathValue() — the same list as a NODE_PATH string, for handing to a CHILD process. Separate verb
// because a spawn cannot inherit a resolver re-initialised in this process's memory; it needs the value
// in its environment (Law 0 — setting our own path and describing it to someone else are two verbs).
function nodePathValue() {
  return moduleHomes().join(path.delimiter);
}

// requireFromHomes(name) — require a package from whichever home carries it, by absolute path.
//
// NOT the same as bootstrapping and then requiring by name, and the difference is why fleet_control had
// its own copy: this resolves BEFORE any NODE_PATH manipulation has to have worked, so it is what a
// caller uses when it needs one package early and does not want to alter the process's resolver at all.
// Throws Node's own not-found if no home has it, naming every place that was checked.
function requireFromHomes(name) {
  for (const home of moduleHomes()) {
    const p = path.join(home, name);
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error(`${name} not found in any module home (checked: ${CANDIDATE_HOMES.join(', ')})`);
}

module.exports = { moduleHomes, bootstrapModulePath, nodePathValue, requireFromHomes, CANDIDATE_HOMES };
