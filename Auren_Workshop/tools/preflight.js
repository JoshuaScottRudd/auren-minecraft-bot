/*
============================================================
preflight.js — the code gate and the session's write briefing
============================================================
Loads every fragment file in the graph headlessly and reports any that fail to require() — bad
requires, missing/renamed exports, broken module aliases, load-time syntax/reference errors. Proves the
graph loads and wires up; it does not prove the bot behaves (only a live master_core run does that).

Bootstraps mineflayer/vec3/prismarine/module-alias exactly as js_kernel/utils/node_module_homes
resolves them for this machine, then registers the @-aliases, so the graph loads here as it does at
runtime.

Passes, all built on one walk of the tree:
  1  every file the walk finds is require()d          (bad requires, renamed exports, syntax)
  2  every module's load-time throws fire during 1     (data integrity)
  3  unbound identifiers + dead-zone reads              (a name read where nothing binds it, or a
                                                        let/const read before its own init completes)
  4  the catch shape                                    (a `try` outside external_library_guard.js)
Passes 3 and 4 need the vendored analyzer under tools/vendor/ and FAIL the run if it is missing.
A pass number names a position, not an identity.

Excluded from require() — files with live side effects on load:
  - foreman/foreman_hub.js  (binds a WebSocket port)
  - foreman/foreman.js      (joins the Minecraft server)
  - master_core.js          (connects to a live Minecraft server)
Parsing has no side effects, so the parser-based passes (3, 4) still cover these files.

Prints the write briefing before the passes — which record a session's work belongs in, how close it
is to its archive trigger, the next volume, the newest entry, and the exact anchor line for an Edit.

Run:  node preflight.js
Exit: 0 if every fragment loads, 1 if any fail.
============================================================
*/
'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/preflight.js');

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Resolves mineflayer/vec3/prismarine/module-alias and registers the bot's @-aliases through
// workshop_paths, the one place the workshop answers "where is the bot" (Law 16).
const paths = require('../workshop_paths');
if (!paths.bootstrapModules().length) {
  console.error('WARN: no node_modules found - run npm install in Auren_Bot/ first; vec3/mineflayer may not resolve.');
}
paths.registerAliases();

// ── THE WRITE BRIEFING (prints on every run, before any pass) ────────────────────────────────────
// Reaches a session at the moment of work (Invariant C). Prints before the passes so no exit path
// can drop it (a process.on('exit') hook would
// lose output on Windows, where a TTY write is asynchronous). Computed in record_keeper.js /
// record_briefing.js (Law 16); this file only calls it. Read-only — archiving is a separate command.
//
// The session board prints first: several sessions share one working tree, and a tree read during
// another session's write looks like destroyed work when it is not. See who else is here before
// trusting what follows.
const _sessionArg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
};
// Writes a STATUS that overwrites — "working on" now, "finished last" once session_sync closes the
// turn. Never a history; that lives in the commit message and the two records.
const _session = _sessionArg('--session');
// Sessions/ lives at the repo root, a sibling of the workshop, and does not ship — the published bot
// is Auren_Bot/ alone. Loaded by presence (existsSync), never by a catch (Law 13): this file must run
// as a plain code checker wherever the session layer is absent.
const _SESSIONS = paths.repo('Sessions');
const _hasSessions = fs.existsSync(_SESSIONS);
const _board = _hasSessions ? require(path.join(_SESSIONS, 'session_board.js')) : null;
if (_board) {
  if (_session) {
    const owns = (_sessionArg('--owns') || '').split(',').map((s) => s.trim()).filter(Boolean);
    _board.working(_session, _sessionArg('--doing'), owns);
  }
  _board.print(_session);

  // core.hooksPath is per-clone config no commit can carry, so a second workstation can silently lack
  // the pre-commit hook that refuses a hand commit. Checked every run since the failure is otherwise
  // invisible — everything still works, minus the guarantee.
  const _hooks = spawnSync('git', ['config', '--get', 'core.hooksPath'],
    { cwd: paths.REPO_ROOT, encoding: 'utf8' });
  if ((_hooks.stdout || '').trim() !== 'Sessions/hooks') {
    console.log('!!  HAND COMMITS ARE NOT BEING REFUSED ON THIS MACHINE');
    console.log('    `git commit` here skips the turn queue, this gate, the undo check, the board and the');
    console.log('    log. One command, once per clone, and the hook in the repo starts doing its job:');
    console.log('        git config core.hooksPath Sessions/hooks\n');
  }
}

// Fires while the session is still editing, the only moment acting on it is cheap. Flags a shared FILE
// another session claims — ordinary and resolved by the last-writer rule at commit — so the reader can
// catch the one case that rule does not cover: two sessions doing the same WORK.
const _sync = _hasSessions ? require(path.join(_SESSIONS, 'session_sync.js')) : null;
const _overlap = _sync ? _sync.overlapWarning(_session) : null;
if (_overlap && _overlap.size) {
  console.log('!!  YOU ARE EDITING ANOTHER SESSION\'S GROUND');
  for (const [owner, files] of _overlap) {
    console.log(`    ${owner} claims ${files.length} file(s) you have changed:`);
    for (const f of files.slice(0, 8)) console.log(`        ${f}`);
    if (files.length > 8) console.log(`        … and ${files.length - 8} more`);
  }
  console.log('    Incidental overlap is fine and resolves itself at commit — the last session in carries');
  console.log('    the tree forward. STOP only if this is the same WORK rather than the same file, which');
  console.log('    is a thing that should never happen and means a session drifted off its own subject.\n');
}

// ── HAS THE OTHER WORKSTATION MOVED? ─────────────────────────────────────────────────────────────────
// Fetches the trunk so a session's judgment is informed by the tree's current state (practice 5: the
// last session in carries the tree forward). A fetch under a minute old is reused. Only the run that opens
// a turn (--doing) merges; later runs in the same turn fetch and report without moving HEAD, since a
// rebase landing mid-edit is worse than a stale read. session_sync performs the second pull before push.
const _trunk = _sync ? _sync.pullFirst(60000, { merge: !!_sessionArg('--doing') }) : null;
if (_trunk && _trunk.merged > 0) {
  console.log(`=== THE TRUNK MOVED AND THIS CLONE HAS BEEN BROUGHT UP TO IT — ${_trunk.merged} commit(s) rebased in ===`);
  console.log(`  You are now measuring and editing ${_trunk.remote}/${_trunk.branch} as it actually stands.`);
  console.log(`      git log --oneline -${_trunk.merged}\n`);
} else if (_trunk && _trunk.mergeRefused) {
  console.log(`=== THE TRUNK HAS MOVED — ${_trunk.behind} commit(s), AND NOTHING WAS PULLED ===`);
  console.log(`  ${_trunk.mergeRefused}.`);
  for (const f of _trunk.collisions.slice(0, 8)) console.log(`      ${f}`);
  if (_trunk.collisions.length > 8) console.log(`      … and ${_trunk.collisions.length - 8} more`);
  console.log(`      git log --oneline HEAD..${_trunk.remote}/${_trunk.branch}\n`);
} else if (_trunk && _trunk.ok && _trunk.behind > 0) {
  console.log(`=== THE TRUNK HAS MOVED — ${_trunk.behind} commit(s) on ${_trunk.remote}/${_trunk.branch} this clone does not have ===`);
  if (_trunk.collisions.length) {
    console.log(`  ${_trunk.collisions.length} of them touch file(s) you have already changed:`);
    for (const f of _trunk.collisions.slice(0, 8)) console.log(`      ${f}`);
    if (_trunk.collisions.length > 8) console.log(`      … and ${_trunk.collisions.length - 8} more`);
    console.log('  Read the other workstation\'s version before you finish — it may have answered the same');
    console.log('  question, and adopting a better answer whole is cheaper than merging two.');
  } else {
    console.log('  None of them touch anything you have changed. Nothing to do; it rebases in at sync.');
  }
  console.log(`      git log --oneline HEAD..${_trunk.remote}/${_trunk.branch}\n`);
} else if (_trunk && _trunk.skipped) {
  console.log(`=== THE TRUNK WAS NOT CHECKED — ${_trunk.skipped}. The other workstation may have moved. ===\n`);
}

// What is actually moving on disk (mtimes), printed against what the board declares. The value is in
// the disagreement — ground changing while its owner reads cold, or changes nobody claimed. Information
// for the session's judgment, never an instruction.
const _churn = _sync ? _sync.recentChurn(_session) : { ok: false, rows: [], contradictions: [] };
if (_churn.ok && (_churn.rows.length || _churn.contradictions.length)) {
  const byOwner = new Map();
  for (const r of _churn.rows) byOwner.set(r.owner, [...(byOwner.get(r.owner) || []), r]);
  console.log(`=== WHAT IS MOVING ON DISK — last ${_churn.window} minutes, by mtime ===`);
  for (const [owner, files] of byOwner) {
    const label = owner === null
      ? 'UNATTRIBUTED — no session declared this ground'
      : (owner === _session ? 'yours — expected, you are editing it' : `${owner}'s declared ground`);
    console.log(`  ${label}   (${files.length} file(s))`);
    for (const f of files.slice(0, 6)) console.log(`      ${Math.round(f.minsAgo)}m  ${f.file}`);
    if (files.length > 6) console.log(`      … and ${files.length - 6} more`);
  }
  for (const c of _churn.contradictions) {
    // Logged, not just printed — a contradiction is the one finding here a session might act on and
    // never mention, so the record does not depend on it being reported.
    require(path.join(_SESSIONS, 'session_log.js')).write(_session, 'FLAG',
      `${c.owner} reads ${c.verdict} but its ground is changing: ${c.files.slice(0, 4).join(', ')}${c.files.length > 4 ? ` (+${c.files.length - 4})` : ''}`);
    console.log(`\n  !! CONTRADICTION: ${c.owner} reads ${c.verdict}, but its ground changed inside the window.`);
    console.log('     Either it is alive and not stamping, or something is writing on ground it declared.');
    console.log('     Treat anything you read from there as a claim about a moving target, not a fact.');
  }
  if (byOwner.has(null)) {
    console.log('\n  Changes nobody declared are the signal worth acting on: a session working outside what');
    console.log('  it said, or a session on this tree that never named itself. If none of it is yours,');
    console.log('  re-read before reporting anything drawn from those files.');
  }
  console.log('');
}

// The write briefing reads the worklog, which lives in `Documentation/` —
// outside the extract, same as the session layer. Printed only when the domain that owns them is present.
if (_hasSessions) require(path.join(_SESSIONS, 'record_briefing.js')).print();

// Layer ROOTS to sweep, walked recursively — a new subfolder is covered the moment it exists (Law 25).
// Order is irrelevant; each file loads independently.
const LAYERS = [
  'Thinking_fragments',
  'action_fragments.js',
  'perception_nodes.js',
  'custom_api',
  'js_kernel',
  'foreman',   // the hub also lives here
  // monitoring/ is deliberately absent — a read-only observer outside the construct, not a layer.
];

// Files with live side effects on require (bind ports / open sockets / connect).
const EXCLUDE = new Set([
  path.join('foreman', 'foreman_hub.js'),   // binds a WebSocket port at module scope
  path.join('foreman', 'foreman.js'),       // creates its mineflayer client at module scope — joins the server
  'master_core.js',                         // connects to a live Minecraft server
]);

const BOT_DIR = paths.BOT_ROOT;
const files = [];
// EXCLUDE is keyed on the path relative to Auren_Bot, so it keeps working at any depth.
function sweep(rel) {
  const dir = path.join(BOT_DIR, rel);
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = path.join(rel, ent.name);
    if (ent.isDirectory()) { sweep(childRel); continue; }
    if (!ent.name.endsWith('.js')) continue;
    if (EXCLUDE.has(childRel)) continue;
    files.push(path.join(BOT_DIR, childRel));
  }
}
for (const layer of LAYERS) sweep(layer);

// ── THE PARSE-TARGET LIST — `files` PLUS THE THREE EXCLUDED ONES ─────────────────────────────────
// EXCLUDE keeps requiring safe; it says nothing about parsing, which has no side effects. Every
// parser-based pass (3, 4) needs to see those files too, so this list is derived once and shared —
// one scope every parser pass uses.
const parseTargets = (() => {
  const t = [...files];
  for (const rel of EXCLUDE) {
    const abs = path.join(BOT_DIR, rel);
    if (fs.existsSync(abs) && !t.includes(abs)) t.push(abs);
  }
  return t;
})();

// ── PASS 3: UNBOUND IDENTIFIERS AND DEAD-ZONE READS ──────────────────────────────────────────────
// Closes a hole in pass 1: loading a file executes only its top level, so a name unbound inside a
// function body is invisible to a loader and throws only once the world reaches that line — quietly,
// because the ReferenceError lands in a catch written for a misbehaving world and reads as the system
// declining to act. Parses every static target and asks, via espree + eslint-scope
// (the analyzer behind eslint's no-undef), whether each identifier resolves in scope, and whether a
// let/const/class binding is read inside its own dead zone. Both questions share one parse and one walk.
// The allowed-globals set is read off the running runtime (globalThis), not typed out, so it tracks
// whatever this Node actually provides.
//
// Vendored in-tree under tools/vendor/ (not node_modules/, which is gitignored) so the analyzer is
// identical on both workstations. Re-vendor with `npm install` using tools/vendor as the prefix; espree,
// eslint-scope and eslint-visitor-keys ship their CommonJS entry as a build artefact (dist/), so vendor
// the published tarball, never the repository source — confirm dist/ exists under each before committing.
const ESPREE_DIR = path.join(__dirname, 'vendor', 'node_modules');
let espree = null, eslintScope = null, analyzerError = null;
try {
  espree = require(path.join(ESPREE_DIR, 'espree'));
  eslintScope = require(path.join(ESPREE_DIR, 'eslint-scope'));
} catch (e) {
  analyzerError = e && e.message ? e.message : String(e);
}

// Read off the runtime, not typed out (see above). The four CJS wrapper names are added because
// globalThis does not report them.
const ALLOWED_GLOBALS = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  'require', 'module', 'exports', '__dirname', '__filename', 'arguments', 'globalThis',
]);

// Walks out to the nearest enclosing function (or module top level). Two references share an
// evaluation moment only if this returns the same scope for both; otherwise a function body sits
// between them and runs later.
function enclosingFunction(scope) {
  let s = scope;
  while (s && s.type !== 'function' && s.type !== 'global' && s.type !== 'module') s = s.upper;
  return s;
}

// ── THE STATIC PASSES REACH FURTHER THAN THE LOADING ONES ───────────────────────────────────────────
// parseTargets is bounded to what pass 1 may safely require. Parsing executes nothing, so that bound
// does not apply here: staticTargets adds the workshop and the lenses, since an unbound name in a bench
// is a stranger's crash too. Pass 4 does not widen the same way — its one-try rule is about boundaries
// inside the construct (Law 29).
const staticTargets = (() => {
  const t = [...parseTargets];
  for (const root of ['Auren_Workshop', 'monitoring']) {
    (function sweep(rel) {
      const dir = path.join(BOT_DIR, rel);
      if (!fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === 'fleet_logs' || ent.name === 'vendor') continue;
        const childRel = path.join(rel, ent.name);
        if (ent.isDirectory()) { sweep(childRel); continue; }
        if (!ent.name.endsWith('.js')) continue;
        const abs = path.join(BOT_DIR, childRel);
        if (!t.includes(abs)) t.push(abs);
      }
    })(root);
  }
  return t;
})();

function scanReferences(targets) {
  const violations = [];
  const deadZone = [];
  for (const file of targets) {
    let ast;
    const rel = path.relative(BOT_DIR, file);
    try {
      ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', range: true, loc: true });
    } catch (e) {
      // Pass 1 already proved every swept file loads, so a parse failure here is an excluded file's
      // genuine syntax error, or a parser mismatch.
      violations.push({ file: rel, line: 0, name: '(parse failed)', text: e && e.message ? e.message : String(e) });
      continue;
    }
    const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: 'commonjs' });
    // `through` is every reference that escaped unresolved — the unbound-identifier question, answered
    // by the analyzer.
    for (const ref of scopeManager.globalScope.through) {
      const name = ref.identifier.name;
      if (ALLOWED_GLOBALS.has(name)) continue;
      violations.push({ file: rel, line: ref.identifier.loc.start.line, name });
    }
    // Every scope, not just global: a dead-zone read is resolved (it found its binding), so it never
    // appears in `through`.
    const scopes = [scopeManager.globalScope];
    while (scopes.length) {
      const scope = scopes.pop();
      scopes.push(...scope.childScopes);
      for (const ref of scope.references) {
        const variable = ref.resolved;
        if (!variable || !variable.defs.length) continue;
        const def = variable.defs[0];
        // Only let/const/class have a dead zone; var and function declarations are hoisted and
        // initialized.
        const kind = def.type === 'Variable' ? (def.parent && def.parent.kind) : def.type;
        if (kind !== 'let' && kind !== 'const' && kind !== 'ClassName') continue;
        // A function boundary between reference and declaration means the reference runs later —
        // keeps ordinary recursion out of the report.
        if (enclosingFunction(ref.from) !== enclosingFunction(variable.scope)) continue;
        const at = ref.identifier.range[0];
        const init = def.node && def.node.init;
        const inOwnInit = init && at >= init.range[0] && at <= init.range[1];
        const beforeDecl = at < def.name.range[0];
        if (!inOwnInit && !beforeDecl) continue;
        deadZone.push({
          file: rel,
          line: ref.identifier.loc.start.line,
          name: variable.name,
          declaredLine: def.name.loc.start.line,
          why: inOwnInit ? "its own initializer reads it — the local shadows what it meant to call"
                         : 'read before its declaration in the same scope',
        });
      }
    }
  }
  return { unbound: violations, deadZone };
}

// ── PASS 4: THE CATCH SHAPE (A GATE) ─────────────────────────────────────────────────────────────
// Law 13: a catch is a decision to continue, written before anyone knows what will arrive — a defect
// behind one reads as the system declining to act, which hides in this size of
// graph. Law 16 permits exactly one catch: a translator over a third-party throw that logs and never
// swallows, owned by external_library_guard.js. Enforced as a SHAPE: a wrong catch is textually
// identical to a right one, so one `try` in the fleet is legal and any other `try` is the violation.
//
// `--catch-detail` classifies each site on two axes: GUARDS (does the try body touch a third-party
// surface, or only our own code) and CATCH (empty / silent / logged / rethrow). guards=library calls the
// guard; guards=own is deleted, not wrapped; a finally-only try becomes withCleanup.
const BOUNDARY_OWNER = path.join('js_kernel', 'utils', 'external_library_guard.js');

// The watcher cannot route its own failures through the guard — the guard reports by calling the
// watcher, so a failure in the watcher's own log write would recurse. It carries its own translator,
// `_selfFault`, reporting to console.error, the one channel that does not depend on the failing one.
// A catch in this file must: call _selfFault, rethrow, or sit inside _selfFault itself (the terminal
// case: console.error itself throwing has nowhere left to report to). Anything else is a violation.
const WATCHER_OWNER = path.join('js_kernel', 'watcher.js');
const WATCHER_TRANSLATOR = '_selfFault';

// True when this catch is one of the three legal shapes above. `insideTranslator` is passed by the
// walk, since it is a fact about the path taken to reach this node.
function _watcherCatchIsLegal(node, insideTranslator) {
  if (insideTranslator) return true;
  const handler = node.handler;
  if (!handler) return true;   // try/finally raises nothing and swallows nothing
  let ok = false;
  _walkNode(handler.body, (n) => {
    if (n.type === 'ThrowStatement') ok = true;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === WATCHER_TRANSLATOR) ok = true;
  });
  return ok;
}

function scanWatcherCatchShape() {
  const file = path.join(BOT_DIR, WATCHER_OWNER);
  if (!fs.existsSync(file)) return [{ line: 0, why: `${WATCHER_OWNER} is exempt in this scan but does not exist` }];
  let ast;
  try { ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', loc: true }); }
  catch (e) { return [{ line: 0, why: `could not parse: ${e.message}` }]; }
  const offenders = [];
  const walk = (node, inTranslator) => {
    if (!node || typeof node.type !== 'string') return;
    const isTranslator = (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression')
      && node.id && node.id.name === WATCHER_TRANSLATOR;
    const inside = inTranslator || isTranslator;
    if (node.type === 'TryStatement' && !_watcherCatchIsLegal(node, inside)) {
      offenders.push({ line: node.loc.start.line, why: `catch neither calls ${WATCHER_TRANSLATOR}() nor rethrows` });
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'parent') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(c => walk(c, inside));
      else if (child && typeof child.type === 'string') walk(child, inside);
    }
  };
  walk(ast, false);
  return offenders;
}

function _walkNode(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => _walkNode(c, fn));
    else if (child && typeof child.type === 'string') _walkNode(child, fn);
  }
}

// Names bound to something outside our own source tree. A require starting with '@' is an alias into
// this fleet; anything else is a foreign surface whose throws we do not author.
function _foreignNames(ast) {
  const names = new Set(['bot', 'JSON', 'fs', 'path', 'process']);
  const bind = (id) => {
    if (id.type === 'Identifier') names.add(id.name);
    else if (id.type === 'ObjectPattern') {
      for (const p of id.properties) if (p.value && p.value.type === 'Identifier') names.add(p.value.name);
    }
  };
  // Runs to a fixpoint: a foreign object often lands in a local and is operated on for the rest of the
  // function (`const furnace = await bot.openFurnace(b)` then `furnace.takeOutput()`), so one hop would
  // undercount. Taint is deliberately over-inclusive — a false 'library' costs a wrapper, a false 'own'
  // costs an unguarded boundary.
  let grew = true;
  while (grew) {
    grew = false;
    _walkNode(ast, (n) => {
      if (n.type !== 'VariableDeclarator' || !n.init) return;
      let init = n.init;
      while (init && (init.type === 'AwaitExpression' || init.type === 'MemberExpression')) {
        init = init.type === 'AwaitExpression' ? init.argument : init.object;
      }
      if (!init || init.type !== 'CallExpression') return;
      const before = names.size;
      if (init.callee.type === 'Identifier' && init.callee.name === 'require') {
        const arg = init.arguments[0];
        if (arg && arg.type === 'Literal' && typeof arg.value === 'string'
          && !arg.value.startsWith('@') && !arg.value.startsWith('.')) bind(n.id);
      } else if (init.callee.type === 'MemberExpression' && names.has(_rootName(init.callee))) {
        bind(n.id);
      } else if (init.callee.type === 'Identifier' && names.has(init.callee.name)) {
        bind(n.id);
      }
      if (names.size !== before) grew = true;
    });
  }
  return names;
}

function _rootName(node) {
  let cur = node;
  while (cur && cur.type === 'MemberExpression') cur = cur.object;
  return cur && cur.type === 'Identifier' ? cur.name : null;
}

// Classifies a try's body as calling a foreign surface ('library'), only reading a property off one
// ('read' — e.g. bot.entity.position, where a null is a genuine world condition), or neither ('own',
// where a catch has nothing legitimate to translate).
function _classifyTry(node, foreign) {
  let calls = false, reads = false;
  _walkNode(node.block, (n) => {
    if (n.type === 'CallExpression') {
      if (n.callee.type === 'Identifier' && foreign.has(n.callee.name)) calls = true;
      // A require() is foreign only when the module is foreign — an @-alias require is our own code.
      if (n.callee.type === 'Identifier' && n.callee.name === 'require') {
        const a = n.arguments[0];
        if (!a || a.type !== 'Literal' || (typeof a.value === 'string' && !a.value.startsWith('@'))) calls = true;
      }
      if (n.callee.type === 'MemberExpression' && foreign.has(_rootName(n.callee))) calls = true;
    }
    if (n.type === 'MemberExpression' && foreign.has(_rootName(n))) reads = true;
  });
  const guards = calls ? 'library' : reads ? 'read' : 'own';
  const handler = node.handler;
  if (!handler) return { guards, shape: 'finally-only' };
  const body = handler.body.body || [];
  if (body.length === 0) return { guards, shape: 'empty' };
  let logged = false, rethrow = false;
  _walkNode(handler.body, (n) => {
    if (n.type === 'ThrowStatement') rethrow = true;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
      && n.callee.object.type === 'Identifier' && n.callee.object.name === 'watcher') logged = true;
  });
  if (rethrow) return { guards, shape: 'rethrow' };
  if (logged) return { guards, shape: 'logged' };
  return { guards, shape: 'silent' };
}

function scanCatchShape() {
  const offenders = [];
  const sites = [];
  let total = 0;
  for (const file of parseTargets) {
    const rel = path.relative(BOT_DIR, file);
    if (rel === BOUNDARY_OWNER || rel === WATCHER_OWNER) continue;
    let ast;
    try {
      ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', loc: true });
    } catch (e) { continue; }
    const foreign = _foreignNames(ast);
    let count = 0;
    _walkNode(ast, (node) => {
      if (node.type !== 'TryStatement') return;
      count++;
      const c = _classifyTry(node, foreign);
      sites.push({ rel, line: node.loc.start.line, guards: c.guards, shape: c.shape });
    });
    if (count > 0) { offenders.push({ rel, count }); total += count; }
  }
  offenders.sort((a, b) => b.count - a.count);
  return { offenders, total, sites };
}

let ok = 0;
const failures = [];
for (const file of files) {
  try {
    require(file);
    ok++;
  } catch (e) {
    failures.push([path.relative(BOT_DIR, file), (e && e.message ? e.message : String(e)).split('\n')[0]]);
  }
}

console.log(ok + ' loaded OK, ' + failures.length + ' failed, of ' + files.length + ' fragment files');
if (failures.length) {
  console.log('\n--- LOAD FAILURES ---');
  for (const [file, msg] of failures) console.log('  ' + file + '  ->  ' + msg);
  process.exit(1);
}
console.log('Graph wiring OK  (pass 1 loaded, pass 2 throws fired).');

// Pass 3 runs after the load: a tree that does not load is already refused, and an unbound-identifier
// report beside a load failure would bury the fix-first item.
//
// A missing analyzer is a FAILURE, not a skip (Law 25) — an instrument that cannot perform its check
// says so and refuses.
if (analyzerError) {
  console.log('\n--- PASS 3 CANNOT RUN ---');
  console.log('  The vendored parser did not load: ' + analyzerError);
  console.log('  Expected at Auren_Workshop/tools/vendor/node_modules (espree + eslint-scope, committed).');
  console.log('  This is a failure rather than a skip — a pass that cannot run has not passed.');
  process.exit(1);
}
const { unbound, deadZone } = scanReferences(staticTargets);
console.log(`Unbound identifiers: ${unbound.length} over ${staticTargets.length} files `
  + `(the construct, plus the workshop and the lenses — see staticTargets).`);
if (unbound.length) {
  console.log('\n--- IDENTIFIERS WITH NO BINDING IN SCOPE ---');
  console.log('  Each of these throws a ReferenceError the moment its line executes. It loads clean');
  console.log('  because the line never runs at load time. Usually a deleted local that still has a');
  console.log('  reader, or a function extracted away from the scope holding the binding it reads.');
  for (const v of unbound) {
    console.log(`      ${v.file}:${v.line}  ${v.name}${v.text ? '  ' + v.text : ''}`);
  }
  process.exit(1);
}
console.log('Unbound identifier scan OK.');

if (deadZone.length) {
  console.log('\n--- READS INSIDE THEIR OWN TEMPORAL DEAD ZONE ---');
  console.log('  Each of these throws "Cannot access X before initialization" the moment its line');
  console.log('  executes. The name IS bound — to the variable being declared — so the unbound scan');
  console.log('  above is correctly silent. Usually a local that shadows an import it meant to call.');
  for (const v of deadZone) {
    console.log(`      ${v.file}:${v.line}  ${v.name} (declared line ${v.declaredLine}) — ${v.why}`);
  }
  process.exit(1);
}
console.log('Dead-zone read scan OK.');

// Pass 4 runs last for the same ordering reason. The watcher's exemption is checked before the general
// census, since an exemption nobody checks is the hole the shape rule exists to avoid.
const watcherOffenders = scanWatcherCatchShape();
if (watcherOffenders.length) {
  console.error(`\n--- WATCHER CATCH SHAPE: ${watcherOffenders.length} illegal catch(es) in ${WATCHER_OWNER} ---`);
  console.error('  This file is exempt from the try rule because the guard reports THROUGH it — routing the');
  console.error('  watcher\'s own failures through the guard recurses on the exact failure being reported.');
  console.error(`  In exchange a catch here must call ${WATCHER_TRANSLATOR}(), rethrow, or sit inside`);
  console.error(`  ${WATCHER_TRANSLATOR} itself (the terminal case: console.error is the last channel).`);
  for (const o of watcherOffenders) console.error(`      ${WATCHER_OWNER}:${o.line}  ${o.why}`);
  process.exit(1);
}
console.log(`Watcher catch shape OK — every catch in ${WATCHER_OWNER} reports through ${WATCHER_TRANSLATOR}() or rethrows.`);

// ── PASS: NOTHING THAT SHIPS MAY `require` ANYTHING PRIVATE ─────────────────────────────────────────
// The public person is handed all the code and none of the documents (Auren_Bot/ ships whole, nothing
// outside it). A require reaching outside the shipped set is a load-time dependency — the caller dies on
// a machine without that folder — so this pass states that guarantee explicitly (Law 13). Only a
// `require` counts (Law 29): a private path mentioned in a comment
// or an existence-checked path is a different, legitimate thing — this file's own write briefing does
// exactly that.
const PRIVATE_DOMAINS = [
  'Cognitive_documents', 'Documentation', 'Privacy', 'Sessions',
  'Long_term_memory', 'MinecraftServer', 'Public_server', 'Cutting_room', 'Scratch_tools',
  'Architect_workstation',
];
const PRIVATE_REQUIRE = new RegExp(
  String.raw`require\s*\(\s*['"\`][^'"\`]*(?:` + PRIVATE_DOMAINS.join('|') + String.raw`)[\\/]`, 'g');

const shipped = [];
const shippedPowerShell = [];
(function sweepShipped(rel) {
  const dir = path.join(BOT_DIR, rel);
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'fleet_logs') continue;
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) { sweepShipped(childRel); continue; }
    if (ent.name.endsWith('.js')) shipped.push(childRel);
    if (ent.name.endsWith('.ps1')) shippedPowerShell.push(childRel);
  }
})('');

const leaks = [];
for (const rel of shipped) {
  const lines = fs.readFileSync(path.join(BOT_DIR, rel), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    PRIVATE_REQUIRE.lastIndex = 0;
    const m = PRIVATE_REQUIRE.exec(lines[i]);
    if (m) leaks.push({ rel, line: i + 1, text: lines[i].trim().slice(0, 140) });
  }
}
if (leaks.length) {
  console.error(`\nPRIVATE DEPENDENCY — ${leaks.length} require(s) in the shipped tree reach material that`);
  console.error('  never leaves this machine. On anybody else\'s copy these are MODULE_NOT_FOUND at load,');
  console.error(`  and every caller above them dies. Private domains: ${PRIVATE_DOMAINS.join(', ')}.`);
  console.error('  Move what is needed INTO the shipped tree, or reach it through an existence-checked');
  console.error('  path rather than a require — see this pass\'s header for why a require is the line.');
  for (const l of leaks) console.error(`      ${l.rel}:${l.line}   ${l.text}`);
  process.exit(1);
}
console.log(`Shipped tree is self-contained — ${shipped.length} file(s), no require reaches private ground.`);

// ── PASS: THE SHIPPED TREE MAY EXPLAIN THE LAYER ABOVE IT. IT MAY NOT TELL YOU TO USE IT ────────────
// Catches the quieter half of layer separation: not a require that fails to load, but a document in the
// shipped tree that tells a stranger to RUN something in a layer they do not have — nothing fails at
// load, so nothing else reports it. A mention is a leak only when it is an instruction (a line a person
// would copy: starts with a runner, or sits in a fenced code block); an explanation of why a folder is
// legitimately absent is not (Law 29). Warns, and does not refuse (Law 13) — the finding is misleading
// prose, not a broken build.
const DOC_EXT = /\.(md|txt)$/i;
// A markdown table row (`|`) is prose in a grid, not a bullet; a `$name = ...` assignment is code
// computing a path, not a command somebody types — neither counts as a runner line.
const RUNNER_LINE = /^\s*(?:[-*>]\s*)?(?:`{0,3})\s*(?:node|npm|npx|&|\.\\|\.\/|git)\s/;
const advertised = [];
(function sweepAdvertised(rel) {
  const dir = path.join(BOT_DIR, rel);
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'fleet_logs') continue;
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) { sweepAdvertised(childRel); continue; }
    if (!/\.(js|md|txt|ps1)$/i.test(ent.name)) continue;
    const lines = fs.readFileSync(path.join(BOT_DIR, childRel), 'utf8').split('\n');
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (DOC_EXT.test(ent.name) && /^\s*```/.test(line)) { fenced = !fenced; continue; }
      PRIVATE_REQUIRE.lastIndex = 0;
      const names = new RegExp(`(?:${PRIVATE_DOMAINS.join('|')})[\\\\/]`).test(line);
      if (!names) continue;
      // A line that RUNS something, or a line inside a code block, is a line somebody will copy.
      if (!fenced && !RUNNER_LINE.test(line)) continue;
      advertised.push({ rel: childRel, line: i + 1, text: line.trim().slice(0, 120) });
    }
  }
})('');
if (advertised.length) {
  console.log(`\nTHE LAYER ABOVE IS ADVERTISED — ${advertised.length} copyable line(s) in the shipped tree`);
  console.log('  name ground a downloaded copy does not have. Each one is a command somebody will type and');
  console.log('  a "cannot find" they did not cause. Explaining these folders is fine and expected; telling');
  console.log('  a stranger to RUN something in them is the leak. Move the command up a level — the private');
  console.log(`  side may read down into Auren_Bot/, never the reverse. Domains: ${PRIVATE_DOMAINS.join(', ')}.`);
  for (const a of advertised) console.log(`      ${a.rel}:${a.line}   ${a.text}`);
} else {
  console.log('Layer separation OK — nothing in the shipped tree tells a stranger to run anything they do not have.');
}

// ── PASS: COMMENTS STATE PURPOSE, NEVER STORY (LAW 14) ─────────────────────────────────────────────
// A session copies the comment style it reads, so a storytelling comment in the shipped tree is a
// template for the next one. This is the blacklist of storytelling triggers; a comment matching any of
// them is refused. The story itself belongs in the commit message and the records.
const STORY_TRIGGERS = [
  { kind: 'date',     re: /\b20\d\d-\d\d-\d\d\b/ },
  { kind: 'person',   re: /(?<![-`])\bArchitect\b/ },
  { kind: 'run',      re: /\b(?:run|round|volume)\s+#?\d+\b/i },
  { kind: 'history',  re: /\b(?:used to be|originally|formerly|was (?:deleted|removed|replaced|retired)|turned out|we (?:tried|found|saw)|(?:he|she|they) (?:said|ruled|asked)|his (?:ruling|call|words))\b/i },
  { kind: 'records',  re: /\b(?:bugsquashing|scratchpad)\b|§\s?\d/i },
  { kind: 'argument', re: /\b(?:deliberately not|do not reintroduce|the wrong turn|for two reasons)\b/i },
  { kind: 'history',  re: /\b(?:was hardcoded|was indistinguishable|supersedes\s+\S+\.(?:js|ps1)|now lives at a different|these were the workshop|only added noise|(?:replacement for|analogue of) the old|the old trace lacked|is the old API|all-or-nothing removed|since the .+ became|this whole design removed|before this existed|(?:it |\S+ )?was written (?:for|to)|until that day|the rejected alternative was|the first version of this|the two runs that got away|the filter was|the old default was|auto-deleting it here|was proposed as the fix|that one was already fixed)\b/i },
];
// PowerShell's own parser distinguishes comments from strings, here-strings and nested expressions.
// One batched read keeps every discovered script behind the same pattern gate as JavaScript.
function readPowerShellComments() {
  if (!shippedPowerShell.length) return [];
  const parser = String.raw`
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ProgressPreference = 'SilentlyContinue'
$sources = ConvertFrom-Json ([Console]::In.ReadToEnd())
$rows = New-Object System.Collections.Generic.List[object]
function Read-CommentTokens($tokens, $relative) {
  foreach ($token in $tokens) {
    if ($token.Kind -eq 'Comment') {
      $rows.Add(@{ rel = $relative; line = $token.Extent.StartLineNumber; value = $token.Text })
    }
    if ($token.PSObject.Properties['NestedTokens']) { Read-CommentTokens $token.NestedTokens $relative }
  }
}
foreach ($source in $sources) {
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseInput($source.text, [ref]$tokens, [ref]$errors)
  if ($errors.Count) {
    foreach ($failure in $errors) { [Console]::Error.WriteLine($source.rel + ':' + $failure.Extent.StartLineNumber + ': ' + $failure.Message) }
    exit 1
  }
  Read-CommentTokens $tokens $source.rel
}
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress -Depth 4
`;
  const command = process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';
  const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')], {
    input: JSON.stringify(shippedPowerShell.map(rel => ({ rel, text: fs.readFileSync(path.join(BOT_DIR, rel), 'utf8').replace(/^\uFEFF/, '') }))),
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 30000,
  });
  if (result.error) {
    console.error('PowerShell comments were not checked: ' + result.error.message);
    console.error('Run preflight with Windows PowerShell or PowerShell 7 (pwsh) available to parse the shipped scripts.');
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('PowerShell source could not be parsed: ' + result.stderr.trim());
    console.error('Fix the named script before rerunning preflight.');
    process.exit(1);
  }
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
if (espree) {
  const told = [];
  for (const rel of shipped) {
    const src = fs.readFileSync(path.join(BOT_DIR, rel), 'utf8').replace(/^#!.*/, '');
    const { comments } = espree.tokenize(src, { ecmaVersion: 'latest', comment: true, loc: true });
    for (const c of comments) {
      c.value.split('\n').forEach((text, i) => {
        const hit = STORY_TRIGGERS.find(t => t.re.test(text));
        if (hit) told.push({ rel, line: c.loc.start.line + i, kind: hit.kind, text: text.trim().slice(0, 110) });
      });
    }
  }
  for (const comment of readPowerShellComments()) {
    comment.value.split('\n').forEach((text, i) => {
      const hit = STORY_TRIGGERS.find(t => t.re.test(text));
      if (hit) told.push({ rel: comment.rel, line: comment.line + i, kind: hit.kind, text: text.trim().slice(0, 110) });
    });
  }
  if (told.length) {
    console.error(`\nSTORYTELLING PATTERN — ${told.length} comment line(s) in the shipped tree match the current history patterns (Law 14).`);
    console.error('  A comment states what the code beneath it is FOR, in the present tense. Dates, people, run');
    console.error('  numbers, what used to be, and record pointers go in the commit message and the records.');
    console.error('  Rewrite each line as purpose, or delete it:');
    for (const t of told) console.error(`      ${t.rel}:${t.line}   [${t.kind}]  ${t.text}`);
    process.exit(1);
  } else {
    console.log(`Comment patterns OK — no storytelling pattern matched comments in ${shipped.length} JavaScript and ${shippedPowerShell.length} PowerShell files. Narrative wording beyond these patterns needs review.`);
  }
}

// ── PASS: THE DEPENDENCY RUNS ONE WAY — THE WORKSHOP READS THE BOT, THE BOT NEVER READS THE WORKSHOP ──
// A direction question, not a disclosure one (Law 29): every stranger has the workshop too, since it
// ships inside the bot, so this checks that bot code never reaches into its own instruments. A fragment
// requiring a lens pulls a reader inside the construct it measures (Law 26); one requiring a bench can
// raise a live process (client connect, RCON) as a side effect of loading the bot. Shipping both inside
// one tree means such a require now resolves everywhere instead of failing on download, so the guarantee
// has to be checked directly (Law 13). Detected by name: no package.json alias points
// into the workshop, so every route in has to spell "Auren_Workshop" out loud.
const inward = [];
for (const rel of shipped) {
  if (rel.split(/[\\/]/)[0] === 'Auren_Workshop') continue;   // the workshop reading itself is its job
  const lines = fs.readFileSync(path.join(BOT_DIR, rel), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/require\s*\(\s*['"`][^'"`]*Auren_Workshop[\\/]/.test(lines[i])) {
      inward.push({ rel, line: i + 1, text: lines[i].trim().slice(0, 140) });
    }
  }
}
if (inward.length) {
  console.error(`\nINVERTED DEPENDENCY — ${inward.length} require(s) in the bot reach into the workshop.`);
  console.error('  The workshop reads the bot; the bot never reads the workshop. These resolve fine on');
  console.error('  every machine, which is why nothing else will ever report them: a lens pulled inside');
  console.error('  the construct is measuring itself, and a BENCH pulled inside can raise live processes');
  console.error('  as a side effect of loading a fragment.');
  console.error('  Move what is needed INTO the bot, or move the code doing the reaching into the workshop.');
  for (const l of inward) console.error(`      ${l.rel}:${l.line}   ${l.text}`);
  process.exit(1);
}
console.log('Dependency direction OK — no bot file requires the workshop.');

// ── PASS: ANYTHING IN THE WORKSHOP OR THE LENSES THAT RUNS MUST ASK THE DOOR FIRST ──────────────────
// A user running the bot must never see a developer tool start. A file under Auren_Workshop/ or
// monitoring/ that DOES SOMETHING when loaded must make developer_door.enter(...) its first executable
// statement, above anything that connects or spawns — checked from the parse tree, since an omission
// works fine for whoever already has the door open and is invisible until a stranger's copy runs it
// (the same shape as the dependency-direction pass above).
//
// A file built only from directives, declarations, module.exports/exports.x assignments, and the
// module-path bootstrap calls (registerAliases/bootstrapModules/bootstrapModulePath — they teach
// require where the kernel lives and start nothing) is a LIBRARY and needs no door; anything else is an
// act (Law 29).
{
  const DOOR_DIRS = new Set(['Auren_Workshop', 'monitoring']);
  const ungated = [];
  const misplaced = [];

  // The permitted-at-load set, as a predicate. Everything not matched here is an ACT.
  const PATH_BOOTSTRAP = /\b(?:registerAliases|bootstrapModules|bootstrapModulePath)\s*\(/;
  const isInert = (st, src) => {
    if (st.type === 'VariableDeclaration' || st.type === 'FunctionDeclaration'
      || st.type === 'ClassDeclaration' || st.type === 'EmptyStatement') return true;
    if (PATH_BOOTSTRAP.test(src.slice(st.range[0], st.range[1]))) return true;  // teaches require, acts not
    if (st.type === 'ExpressionStatement') {
      if (typeof st.directive === 'string') return true;                       // 'use strict'
      const e = st.expression;
      if (e.type === 'AssignmentExpression' && /^(?:module\.exports|exports\.)/.test(
        src.slice(e.left.range[0], e.left.range[1]))) return true;             // module.exports = …
    }
    return false;
  };

  for (const rel of shipped) {
    const top = rel.split(/[\\/]/)[0];
    if (!DOOR_DIRS.has(top)) continue;
    const src = fs.readFileSync(path.join(BOT_DIR, rel), 'utf8');
    let ast;
    try { ast = espree.parse(src, { ecmaVersion: 'latest', range: true }); } catch { continue; }

    const acts = ast.body.filter(st => !isInert(st, src));
    if (!acts.length) continue;                                                // a library: nothing to gate
    const callsDoor = st => /developer_door['"`]?\s*\)?\s*\.?[\s\S]{0,40}\.enter\s*\(/.test(
      src.slice(st.range[0], st.range[1]));
    if (!acts.some(callsDoor)) ungated.push(rel);
    else if (!callsDoor(acts[0])) misplaced.push(rel);
  }

  if (ungated.length || misplaced.length) {
    console.error('\nTHE DOOR IS NOT SHUT — a developer tool would run in an ordinary copy of Auren.');
    console.error('  Every file here acts when it is loaded, so it must ask the door before it acts:');
    console.error("      require('<path to>/js_kernel/utils/developer_door').enter('<its own name>');");
    console.error('  as the FIRST executable line. A file that only declares and exports needs nothing.');
    for (const rel of ungated) console.error(`      ${rel}   — never asks`);
    for (const rel of misplaced) console.error(`      ${rel}   — asks, but something already happened above it`);
    process.exit(1);
  }
  console.log('Developer door OK — nothing in the workshop or the lenses runs without it.');
}

// ── PASS: A LENS PRINTS FIELD NAMES AND VALUES. IT HAS NO GRAMMAR TO STATE A CONCLUSION WITH ────────
// A lens extracts data; it was not present for the decision it reports on, so it has no standing to say
// what the data means — the bot does, and a bot's own words copied into a VALUE are fine. Taking prose
// out of the instrument removes the grammar a claim would need, which is a whitelist and needs no list
// of forbidden words (Law 29).
//
// Two checks:
// A. ONE PATHWAY TO THE ANSWER (Law 16) — nothing under monitoring/ writes to stdout except data_out.js.
// B. NO AUTHORED PROSE — no string literal containing a space, outside the two files that own
//    presentation. A literal with no space is a field name, key, flag or bot name.
//
// Exemptions: data_out.js and report_formatting.js own every space and separator in the output, so no
// other file needs one. `throw` text and console.error/stderr report that the instrument could not
// read, never what a reading means, so they are not an answer about a run.
{
  const LENS_DIR = 'monitoring';
  const FORMATTING_LAYER = new Set(['data_out.js', 'report_formatting.js']);
  const stdoutOffenders = [];
  const proseOffenders = [];

  for (const rel of shipped) {
    const parts = rel.split(/[\\/]/);
    if (parts[0] !== LENS_DIR || !/\.js$/.test(rel)) continue;
    const base = parts[parts.length - 1];
    const src = fs.readFileSync(path.join(BOT_DIR, rel), 'utf8');
    let ast;
    try { ast = espree.parse(src, { ecmaVersion: 'latest', loc: true }); } catch { continue; }

    // ── CHECK A: who is allowed to write the answer ──────────────────────────────────────────────
    if (base !== 'data_out.js') {
      _walkNode(ast, (n) => {
        if (n.type !== 'CallExpression') return;
        const c = n.callee;
        if (c.type !== 'MemberExpression' || c.computed) return;
        const obj = c.object.name, prop = c.property.name;
        if (obj === 'console' && prop === 'log') stdoutOffenders.push({ rel, line: n.loc.start.line, what: 'console.log' });
        if (obj === 'stdout' && prop === 'write') stdoutOffenders.push({ rel, line: n.loc.start.line, what: 'stdout.write' });
        if (c.object.type === 'MemberExpression' && c.object.object.name === 'process'
          && c.object.property.name === 'stdout' && prop === 'write') {
          stdoutOffenders.push({ rel, line: n.loc.start.line, what: 'process.stdout.write' });
        }
      });
    }

    // ── CHECK B: did the lens author prose ───────────────────────────────────────────────────────
    if (FORMATTING_LAYER.has(base)) continue;

    // A crash message and an IO failure are not an answer about a run. Marked, then skipped.
    const exempt = new Set();
    const markSubtree = (node) => {
      if (!node || typeof node.type !== 'string') return;
      exempt.add(node);
      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'range') continue;
        const ch = node[k];
        if (Array.isArray(ch)) ch.forEach(markSubtree);
        else if (ch && typeof ch.type === 'string') markSubtree(ch);
      }
    };
    _walkNode(ast, (n) => {
      if (n.type === 'ThrowStatement') markSubtree(n.argument);
      if (n.type === 'NewExpression' && n.callee.name === 'Error') n.arguments.forEach(markSubtree);
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
        && n.callee.object.name === 'console'
        && (n.callee.property.name === 'error' || n.callee.property.name === 'warn')) {
        n.arguments.forEach(markSubtree);
      }
      // fail(...) is trace_monitor's own abort — prints to stderr and exits, so it is the error channel.
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'fail') {
        n.arguments.forEach(markSubtree);
      }
      // process.stderr.write is the same channel as console.error: it carries what the instrument
      // could not do, never what it read.
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
        && n.callee.property.name === 'write' && n.callee.object.type === 'MemberExpression'
        && n.callee.object.object.name === 'process' && n.callee.object.property.name === 'stderr') {
        n.arguments.forEach(markSubtree);
      }
    });

    // A space plus a run of two or more letters distinguishes prose from punctuation separators
    // (', ', ' · ', timestamp templates). 'use strict' is a directive, not output, and is exempted.
    const WORDED = /[A-Za-z]{2,}/;
    _walkNode(ast, (n) => {
      if (exempt.has(n)) return;
      let text = null;
      if (n.type === 'Literal' && typeof n.value === 'string') text = n.value;
      else if (n.type === 'TemplateElement') text = n.value.cooked || '';
      if (text === null || !/ /.test(text) || !WORDED.test(text)) return;
      if (text === 'use strict') return;
      proseOffenders.push({ rel, line: n.loc.start.line, text: text.trim().slice(0, 72) });
    });
  }

  if (stdoutOffenders.length || proseOffenders.length) {
    console.error('\nA LENS IS AUTHORING PROSE — the instrument can form a sentence, so it can state a conclusion.');
    console.error('  A lens EXTRACTS data; it did not participate in the decision it is reporting on, so it has');
    console.error('  no standing to say what the data means. The bot does, and a bot\'s own words copied into a');
    console.error('  VALUE are fine. What is not fine is the lens writing a sentence of its own.');
    if (stdoutOffenders.length) {
      console.error(`\n  ${stdoutOffenders.length} write(s) to stdout outside data_out.js — route them through it:`);
      console.error("      const out = require('./data_out');   out.section('...'); out.kv('field', value);");
      for (const o of stdoutOffenders) console.error(`      ${o.rel}:${o.line}   ${o.what}`);
    }
    if (proseOffenders.length) {
      console.error(`\n  ${proseOffenders.length} authored string(s) containing a space — a field name has none:`);
      for (const o of proseOffenders) console.error(`      ${o.rel}:${o.line}   "${o.text}"`);
    }
    process.exit(1);
  }
  console.log('Lens output OK — field names and values only; no lens can author a sentence.');
}

// ── PASS: THE FLEET NEVER REACHES FOR A LENS (STANDING) ────────────────────────
// A lens reads a run's record; live code asking one reads a description of its own past
// behaviour out of a file that the next start empties whole (Law 16 — the owning module is one call
// away). "Live" is a property of WHEN code runs, which a static scan cannot see, so this pass proves
// the structural half: everything under Auren_Bot/ that is not monitoring/ or Auren_Workshop/ exists
// only to be a running bot, so any require or spawn of a lens from there is wrong in every execution
// (Law 13). The workshop is not scanned here — a bench legitimately drives a fleet and reports on it,
// and its reads are taken under the record's claim (js_kernel/utils/record_claims).
{
  const lensOffenders = [];
  // The permitted readers, named positively: the lenses themselves, and the workshop, whose live reads
  // the gate governs instead. Everything not on this list is the construct.
  const LENS_READERS = ['monitoring', 'Auren_Workshop'];
  // A path is a lens reach when it names either lens directory. Matched on the require STRING rather
  // than resolved, because a resolver would follow `paths.bot(...)` into a computed value and the thing
  // being forbidden is the reach itself, however it is spelled.
  const REACHES_LENS = /(^|[\\/])(monitoring)[\\/]/;
  const SPAWNERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

  for (const rel of shipped) {
    const parts = rel.split(/[\\/]/);
    if (LENS_READERS.includes(parts[0]) || !/\.js$/.test(rel)) continue;
    const src = fs.readFileSync(path.join(BOT_DIR, rel), 'utf8');
    let ast;
    try { ast = espree.parse(src, { ecmaVersion: 'latest', loc: true }); } catch { continue; }

    // Every string literal that names a lens, wherever it sits in a call — this catches
    // `require('../monitoring/x')`, `spawnSync(node, [paths.bot('monitoring', 'trace_monitor.js')])`
    // and `paths.bot('monitoring/trace_read')` alike, because all three spell the reach out loud.
    _walkNode(ast, (n) => {
      if (n.type !== 'CallExpression') return;
      const c = n.callee;
      const name = c.type === 'Identifier' ? c.name
        : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
      const isReach = name === 'require' || SPAWNERS.has(name) || name === 'bot' || name === 'join';
      if (!isReach) return;
      for (const a of n.arguments) {
        if (a.type !== 'Literal' || typeof a.value !== 'string') continue;
        // `'monitoring'` as a bare segment counts too: `paths.bot('monitoring', 'trace_monitor.js')`
        // splits the reach across two arguments and would otherwise read as innocent.
        if (REACHES_LENS.test(a.value) || a.value === 'monitoring') {
          lensOffenders.push({ rel, line: n.loc.start.line, what: `${name}(… '${a.value}' …)` });
          return;
        }
      }
    });
  }

  if (lensOffenders.length) {
    console.error('\nTHE CONSTRUCT IS REACHING FOR A LENS — live code reading its own exhaust.');
    console.error('  A lens reconstructs a run that is OVER. A running bot asking one is reading a description');
    console.error('  of its own past behaviour out of a file, when the module that owns the fact is one call');
    console.error('  away (Law 16) — and that file is emptied whole by the next start, so it may vanish mid-read.');
    console.error('  Architect 2026-09-16: "Make sure no live code program uses a lens or monitor and talks');
    console.error('  directly to the system needed."');
    console.error(`\n  ${lensOffenders.length} reach(es) from inside the construct:`);
    for (const o of lensOffenders) console.error(`      ${o.rel}:${o.line}   ${o.what}`);
    console.error('\n  The repair is to ask the owner directly. Whoever WROTE the line you were going to read');
    console.error('  out of the record still has the fact in memory — take it from there, or have it state');
    console.error('  the fact as a field the way job_board now states `dead` on the boardroom chair.');
    process.exit(1);
  }
  console.log('Lens reach OK — nothing in the construct reads a run record; the fleet answers for itself.');
}

// ── PASS: THE AUTHORED VERSION AGAINST WHAT THE INSTALLED LIBRARIES CAN ACTUALLY REACH ──────────────
// The fleet's Minecraft version ceiling is set by the CLIENT LIBRARY, not by Mojang's newest release:
// the highest version both minecraft-protocol.supportedVersions and mineflayer.testedVersions carry is
// the highest a bot here can join. That ceiling moves whenever a dependency is updated, silently, so
// this pass re-derives it directly from the two installed manifests (Law 26).
//
// Compares by PROTOCOL NUMBER, never by version string — Minecraft version names do not sort correctly
// as strings, but protocol numbers are monotonic by definition. A configured version ABOVE the ceiling
// fails the run (every connection dies at the handshake); a version BELOW it is an opportunity and only
// reports, so `npm update` never breaks a green tree (Law 13).
{
  const NM = path.join(BOT_DIR, 'node_modules');
  const manifestVersions = (pkg, field) => {
    try {
      const mod = require(path.join(NM, pkg));
      const list = mod && mod[field];
      return Array.isArray(list) && list.length ? list : null;
    } catch (e) { return null; }
  };
  // A version string is worth nothing here until it resolves to the number the handshake negotiates.
  const protocolOf = (v) => {
    try {
      const d = require(path.join(NM, 'minecraft-data'))(v);
      const n = d && d.version && d.version.version;
      return typeof n === 'number' ? n : null;
    } catch (e) { return null; }
  };

  const mcpList = manifestVersions('minecraft-protocol', 'supportedVersions');
  const mfList = manifestVersions('mineflayer', 'testedVersions');

  if (!mcpList || !mfList) {
    // Absence is reported as unread, never assumed fine (Law 26).
    console.log('Version ceiling UNREAD — minecraft-protocol/mineflayer manifests not resolvable from ' +
                'this tree, so no ceiling was computed. Nothing is claimed about the configured version.');
  } else {
    const authored = require('@thinking/architect_config').SERVER_MINECRAFT_VERSION;
    const authoredProto = protocolOf(authored);

    const highest = (list) => list
      .map(v => ({ v, p: protocolOf(v) }))
      .filter(x => x.p !== null)
      .sort((a, b) => a.p - b.p)
      .pop() || null;

    // The intersection is the ceiling: a version both libraries carry.
    const mfSet = new Set(mfList);
    const reachable = mcpList.filter(v => mfSet.has(v));
    const ceiling = highest(reachable);
    const mcpTop = highest(mcpList);
    const mfTop = highest(mfList);

    // Membership decides the refusal, never ordering alone: a version absent from both lists (one the
    // libraries have never heard of) is the strongest evidence the fleet cannot join, not an unknown to
    // report around. Ordering only decides which sentence a failure prints (Law 26).
    if (!ceiling) {
      console.log('Version ceiling UNREAD — the library lists did not resolve to protocol numbers on ' +
                  'this machine. Nothing is claimed about the configured version.');
    } else if (!reachable.includes(authored)) {
      const above = authoredProto !== null && authoredProto > ceiling.p;
      console.error(`\nVERSION UNREACHABLE — the fleet is configured for Minecraft ${authored}` +
                    `${authoredProto === null ? '' : ` (protocol ${authoredProto})`}, which is not a ` +
                    'version BOTH installed libraries carry.');
      console.error(above
        ? `  It is ABOVE the ceiling: they top out at ${ceiling.v} (protocol ${ceiling.p}).`
        : `  The libraries do not list it at all — the highest they both reach is ${ceiling.v} ` +
          `(protocol ${ceiling.p}).`);
      console.error('  Every run dies at the handshake, and it dies far from the line that caused it.');
      console.error(`      minecraft-protocol supports up to  ${mcpTop ? mcpTop.v : '?'}`);
      console.error(`      mineflayer has tested up to        ${mfTop ? mfTop.v : '?'}`);
      console.error('  The one authored answer is SERVER_MINECRAFT_VERSION in');
      console.error('  Auren_Bot/Thinking_fragments/architect_config.js — lower it to the ceiling, or');
      console.error('  raise the libraries (Auren_Bot/Auren_Workshop/scripts/npm.ps1 update) first.');
      process.exit(1);
    } else if (authoredProto === ceiling.p) {
      console.log(`Version ceiling OK — configured for ${authored} (protocol ${authoredProto}), which IS ` +
                  'the highest the installed libraries reach. Nothing to upgrade to.');
    } else {
      // Notifies that an upgrade became possible, at the moment the code is next touched.
      const binding = (mfTop && mcpTop && mfTop.p < mcpTop.p) ? 'mineflayer' : 'minecraft-protocol';
      console.log(`Version ceiling — AN UPGRADE IS AVAILABLE: configured for ${authored} ` +
                  `(protocol ${authoredProto}), libraries now reach ${ceiling.v} (protocol ${ceiling.p}).`);
      console.log(`      minecraft-protocol supports up to  ${mcpTop ? mcpTop.v : '?'}`);
      console.log(`      mineflayer has tested up to        ${mfTop ? mfTop.v : '?'}`);
      console.log(`      binding constraint                 ${binding}`);
      console.log('  This is not a failure — it is an opportunity, so the run stays green. Raising');
      console.log('  SERVER_MINECRAFT_VERSION in Auren_Bot/Thinking_fragments/architect_config.js is the');
      console.log('  whole config change; what costs time is the packet-shape sweep, and the population to');
      console.log('  re-check is every _client.on / _client.prependListener site in the construct.');
    }
  }
}

// ── STALE BUILD PLAN — THE ONE CHANGE THAT PASSES EVERY OTHER CHECK AND STILL DOES NOTHING ─────────
// A downloaded building is not planned at runtime: plan_blueprint.js computes the plan once into
// <name>.build_plan.json, and downloaded_plan_registry.load reads that file for the whole run — so an
// edit to the planner is invisible to the fleet until the plan is regenerated, however clean the headless
// check of the planner reads. Compares each plan's own schema field against downloaded_plan_registry's
// own export (Law 16). Silent when there are no plans.
try {
  const planDir = paths.repo('html and json', 'Downloaded_Blueprints');
  if (fs.existsSync(planDir)) {
    const { SCHEMA } = require(paths.bot('js_kernel', 'downloaded_plan_registry.js'));
    const stale = [];
    let checked = 0;
    for (const f of fs.readdirSync(planDir).filter(n => n.endsWith('.build_plan.json'))) {
      const full = path.join(planDir, f);
      let plan;
      try { plan = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      if (!plan || typeof plan.schema !== 'string') continue;
      checked++;
      if (plan.schema !== SCHEMA) stale.push({ name: plan.name || f.replace('.build_plan.json', ''), f, schema: plan.schema });
    }
    if (stale.length === 0) {
      console.log(`Build plans OK — ${checked} plan(s) made by the current planner (${SCHEMA}).`);
    } else {
      console.error(`\n--- STALE BUILD PLAN: ${stale.length} plan(s) were made by a different planner ---`);
      console.error('  The fleet reads the PLAN FILE, not the planner. Until these are rebuilt the run refuses');
      console.error('  them at startup, and every other check here will still pass.');
      for (const s of stale) {
        console.error(`      ${s.name}: plan is ${s.schema}, the fleet reads ${SCHEMA}`);
      }
      console.error('  Rebuild each one with:');
      console.error('      node Auren_Bot/Auren_Workshop/tools/plan_blueprint.js "html and json/Downloaded_Blueprints/downloaded_blueprints.json" --name=<name>');
      process.exit(1);
    }
  }
} catch (e) {
  // Environmental — a shipped tree may carry no imports at all — so this is stated, not failed.
  console.log(`Build plans — not checked (${e.message}).`);
}

// ── THE TIMER SHAPE (A GATE) ─────────────────────────────────────────────────────────────────────
// A repeating timer is what a heartbeat is made of, and a heartbeat judges work by a clock set before
// anyone knew how long the work takes. The construct has one repeating timer and one clock that judges
// work, both in timeout_crash.js: `every()` names each repeating timer so a crash report can list it,
// and `watch()` ends the whole run at one limit. Enforced as a SHAPE, the way the catch is: a
// `setInterval` or `clearInterval` written anywhere else in the construct is the violation.
const TIMER_OWNER = path.join('js_kernel', 'utils', 'timeout_crash.js');
const REPEATING_TIMER_NAMES = new Set(['setInterval', 'clearInterval']);
function scanTimerShape() {
  const sites = [];
  for (const file of parseTargets) {
    const rel = path.relative(BOT_DIR, file);
    if (rel === TIMER_OWNER) continue;
    let ast;
    try {
      ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', loc: true });
    } catch (e) { continue; }
    _walkNode(ast, (node) => {
      if (node.type !== 'Identifier' || !REPEATING_TIMER_NAMES.has(node.name)) return;
      sites.push({ rel, line: node.loc.start.line, name: node.name });
    });
  }
  return sites;
}
const timerSites = scanTimerShape();
if (timerSites.length === 0) {
  console.log('Timer shape OK — every repeating timer in the construct is placed through timeout_crash.');
} else {
  console.error(`\n--- TIMER SHAPE: ${timerSites.length} repeating timer(s) written outside timeout_crash ---`);
  console.error('  A heartbeat judges work by a clock, and a clock is always too short or too long. Work');
  console.error('  that fails reports itself; work that never comes back is caught by ONE clock, at ONE');
  console.error('  number, and it ends the whole run with a report. Both live in');
  console.error('  js_kernel/utils/timeout_crash.js. The two repairs:');
  console.error('    a periodic job (a flush, a sample)   → timeoutCrash.every(tag, what, fn, ms) / .stop(timer)');
  console.error('    "is it still alive / did it answer"  → const w = timeoutCrash.watch(tag, what); … w.done()');
  for (const s of timerSites) console.error(`      ${s.rel}:${s.line}  ${s.name}`);
  process.exit(1);
}

const shape = scanCatchShape();
if (shape.total === 0) {
  console.log('Catch shape OK — every boundary goes through external_library_guard.');
  process.exit(0);
}
// Prints the classification on failure — the reader just wrote one try and needs to know which of the
// three repairs it takes. `--catch-detail` lists every site for a full sweep.
console.error(`\n--- CATCH SHAPE: ${shape.total} hand-written try block(s) outside external_library_guard ---`);
console.error('  Default state is stopped (Law 13). A catch is a decision to CONTINUE written before');
console.error('  anyone knows what will arrive at it, and it proves nothing about being safe to proceed —');
console.error('  it turns a defect into a warn line and a not-done outcome, which reads as a blocked world');
console.error('  rather than a bug, four subsystems away from where it happened. Bugs surface loudly here.');
console.error('  Law 16 permits exactly one catch — a third-party translator that logs and never swallows —');
console.error('  and it lives in js_kernel/utils/external_library_guard.js. The three repairs:');
console.error('    guards=library  → call guardExternal / guardExternalSync and READ the {ok, value, reason}');
console.error('    guards=own      → DELETE it; the defect must travel to master_core\'s crash handler');
console.error('    catch=finally-only → withCleanup / withCleanupSync (releases on every exit, catches nothing)');
const detail = process.argv.includes('--catch-detail');
for (const o of shape.offenders.slice(0, detail ? shape.offenders.length : 12)) {
  console.error(`      ${String(o.count).padStart(3)}  ${o.rel}`);
}
if (!detail && shape.offenders.length > 12) {
  console.error(`      … and ${shape.offenders.length - 12} more file(s)  (--catch-detail for all)`);
}
const matrix = new Map();
for (const s of shape.sites) {
  const key = `${s.guards}/${s.shape}`;
  matrix.set(key, (matrix.get(key) || 0) + 1);
}
console.error('\n  --- what each try GUARDS × what its catch DOES ---');
for (const [key, n] of [...matrix.entries()].sort((a, b) => b[1] - a[1])) {
  console.error(`      ${String(n).padStart(3)}  ${key}`);
}
console.error('\n  --- every site ---');
let current = null;
for (const s of shape.sites) {
  if (s.rel !== current) { current = s.rel; console.error(`    ${current}`); }
  console.error(`        :${String(s.line).padStart(4)}  guards=${s.guards.padEnd(7)} catch=${s.shape}`);
}
process.exit(1);
