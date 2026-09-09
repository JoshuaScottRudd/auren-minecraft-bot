// node_module_homes — the ONE answer to "where do the third-party node modules live on THIS machine".
//
// mineflayer, vec3, prismarine-*, ws and module-alias are not checked in beside the code that uses them.
// They live in a `node_modules` that is in a DIFFERENT PLACE on each of the Architect's two workstations:
// `node_env2/` on the primary, `MinecraftServer/` on the secondary (the portable-node setup). Nothing in
// Node resolves that by itself, so every entry point that touches a live client has to put the right
// directory on NODE_PATH before its first require.
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
// ── THE ORDER IS NOT ARBITRARY ──────────────────────────────────────────────────────────────────────
// node_env2 first because it is the purpose-built environment for the fleet; the server's own
// node_modules is a co-tenant that happens to carry the same packages, and Auren_Bot's is the last
// resort. A machine with several of them gets the fleet's own copy, not whichever the server installed.
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

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const BOT_ROOT = path.resolve(__dirname, '..', '..');

// Every place a node_modules has ever been found on either workstation, in priority order. A new machine
// layout is one entry here, not a fifth copy of the loop.
const CANDIDATE_HOMES = [
  path.join(PROJECT_ROOT, 'node_env2', 'node_modules'),
  path.join(PROJECT_ROOT, 'MinecraftServer', 'node_modules'),
  path.join(BOT_ROOT, 'node_modules'),
  // Cutting_room's own install, added 2026-09-09 when the video toolchain's DECLARATION moved out of
  // Auren_Bot/package.json to the code that actually requires it. The bot requires neither ffmpeg-static
  // nor ffprobe-static — they are 414 MB, and declaring them in the published package.json made every
  // stranger download a video encoder for a Minecraft bot. Last in priority because it carries exactly
  // one domain's packages; the three above are general homes.
  //
  // A path outside the bot is not a leak of the workshop into shipped code — `moduleHomes()` filters by
  // existsSync, and the two entries above it already name directories no published copy has either. On a
  // stranger's machine this list collapses to the bot's own node_modules, which is the whole point.
  path.join(PROJECT_ROOT, 'Cutting_room', 'node_modules'),
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
