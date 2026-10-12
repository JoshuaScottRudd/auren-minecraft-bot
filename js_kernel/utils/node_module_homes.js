// The one answer to where the third-party node modules live on this machine.
//
// mineflayer, vec3, prismarine-*, ws and module-alias are not checked in beside the code that uses them.
// A stranger's copy has them in `Auren_Bot/node_modules`, installed by `npm install`. The operator's
// machines have additional homes, listed in his workstation file, that nothing in Node finds by itself —
// every entry point that touches a live client puts the list on NODE_PATH before its first require.
//
// ── WHY IT IS A FILE ────────────────────────────────────────────────────────────────────────────────
// One source of truth for this question (Law 16): every process that touches a live client boots this
// before requiring anything that needs it, so no caller carries its own copy of the workstation list.
//
// ── THE ORDER IS THE WORKSTATION RULE ────────────────────────────────────────
// The bot's own node_modules comes first — the stranger's home, and the one every require inside
// Auren_Bot/ reaches by walking up anyway — and the homes listed in
// `../Architect_workstation/workstation.json` follow, read through `workstation.js`, the one JS reader
// of that file. On a stranger's machine the list is one entry long. His folder names are written in that
// file and nowhere in this one.
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

// moduleHomes() — the candidates that actually exist here, in priority order. Read fresh on every call,
// never cached at load: a caller may run before an install and again after, and a cached empty list
// would outlive the condition that produced it (Invariant B).
function moduleHomes() {
  return CANDIDATE_HOMES.filter(fs.existsSync);
}

// bootstrapModulePath() — put every home on NODE_PATH and re-initialise Node's resolver. Returns the
// list it used, so a caller can report which machine it decided it was on.
//
// Idempotent: already-present entries are skipped, so a process that boots this from more than one entry
// point never grows NODE_PATH without bound, and none of them has to know who called first.
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

// requireFromHomes(name) — require a package from whichever home carries it, by absolute path. Resolves
// before any NODE_PATH manipulation has to have worked, for a caller that needs one package early without
// altering the process's resolver. Throws Node's own not-found if no home has it, naming every place that
// was checked.
function requireFromHomes(name) {
  for (const home of moduleHomes()) {
    const p = path.join(home, name);
    if (fs.existsSync(p)) return require(p);
  }
  // THE REMEDY, NOT ONLY THE FAULT. This is the first thing that breaks on a machine where
  // `npm install` has not been run, so the message states the fix, not only what is missing.
  throw new Error(`The package "${name}" is not installed. Run this once, from the folder holding `
    + `start_auren.js:\n    npm install\n`
    + `(looked for it in: ${CANDIDATE_HOMES.join(', ')})`);
}

module.exports = { moduleHomes, bootstrapModulePath, nodePathValue, requireFromHomes, CANDIDATE_HOMES };
