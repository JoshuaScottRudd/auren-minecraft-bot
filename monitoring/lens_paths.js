// lens_paths — WHERE A LENS FINDS THE BOT IT IS READING, AND HOW IT MAKES THE BOT'S @-ALIASES RESOLVE.
//
// ── IT NEVER GUESSES ────────────────────────────────────────────────────────────────────────────────
// `BOT_ROOT` is computed from this file's own location and nothing else. There is no environment
// override and no search: a lens that cannot find the bot one directory above it is a broken checkout,
// and it should fail on the missing file with Node's own message naming the path it wanted (Law 13 —
// never default a missing field into a plausible wrong answer).
//
// ── WHY THE ALIAS MAP IS REBUILT INSTEAD OF `require('module-alias')(BOT_ROOT)` ─────────────────────
// That one-liner is the documented way to load a package.json's `_moduleAliases`, and calling it twice
// in one process CORRUPTS the map on Windows. It resolves each relative target in place, in the object
// Node has cached for that package.json, and its "already absolute" test is `value[0] !== '/'` — which
// is false for `C:\...`. A second call therefore joins the base onto an already-joined path and every
// alias points at `C:\Auren_Bot\C:\Auren_Bot\js_kernel`. Reading the map and joining into a FRESH object
// avoids that, however many callers ask. The idempotence flag below is still kept, because repeating the
// work is waste even when it is harmless.
//
// ── THE ALIASES ARE THE BOT'S OWN DECLARATION ───────────────────────────────────────────────────────
// The map is read from `Auren_Bot/package.json._moduleAliases` every time, never copied here: the
// aliases are the BOT'S statement of its internal layout, and a second copy in this file would be a
// staler answer to a question already answered (Law 16 — one source).
'use strict';

const path = require('path');
const fs = require('fs');

const MONITORING_ROOT = __dirname;
const BOT_ROOT = path.resolve(__dirname, '..');

// Absolute path to something inside the bot. `bot()` with no argument is the bot root.
function bot(...rel) {
  return rel.length ? path.join(BOT_ROOT, ...rel) : BOT_ROOT;
}

let _aliasesRegistered = false;

// registerAliases() — make the bot's @-aliases resolve in this process, so bot modules load. A lens that
// reads a record written by a bot module often needs that module's decoder (`@api/crew_log`,
// `foreman/foreman_record`); Law 26 says the reader calls the writer's own translator, never
// re-implementing the format.
function registerAliases() {
  if (_aliasesRegistered) return;
  const declared = require(bot('package.json'))._moduleAliases || {};
  const resolved = {};
  // module-alias rewrites the cached package.json's values to absolute paths when trace_monitor
  // registers them first, so a value is joined to the bot root only while it is still relative.
  for (const alias of Object.keys(declared)) resolved[alias] = path.isAbsolute(declared[alias]) ? declared[alias] : bot(declared[alias]);
  require('module-alias').addAliases(resolved);
  _aliasesRegistered = true;
}

// ── THE RECORDING LENSES LIVE IN THE WORKSHOP, WHICH IS NOW INSIDE THIS FOLDER'S PARENT ─────────────
// Three lenses sit apart from the rest: `camera_lens`, `combat_witness_lens` and `machine_load_lens`.
// The line between them and this folder is WHICH RECORD each one reads — a lens that reads a BOT'S OWN
// trace is here; a lens that reads the CAMERA STACK'S records (`fleet_logs/combat_witness/`,
// `fleet_logs/machine_load/`, the rig's vantage events) is in `Auren_Workshop/monitoring/`.
//
// The split survives on its own merit — it keeps the readers of one record set together.
//
// THE ABSENT BRANCH IS KEPT ON PURPOSE. Nothing guarantees a copy of this folder still has its parent's
// workshop beside it: somebody may vendor `monitoring/` alone, or strip the camera stack. `trace_monitor`
// answers that in one sentence, never throwing MODULE_NOT_FOUND at a person who typed a flag the help
// text offered them (Law 13 — a missing thing is named, never dressed up as a crash in the caller).
function recordingLensDir() {
  const dir = path.join(BOT_ROOT, 'Auren_Workshop', 'monitoring');
  return fs.existsSync(dir) ? dir : null;
}

module.exports = { BOT_ROOT, MONITORING_ROOT, bot, registerAliases, recordingLensDir };
