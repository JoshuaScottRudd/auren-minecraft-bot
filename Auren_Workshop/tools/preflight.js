/*
============================================================
preflight.js — the one button: the code gate, and the session's write briefing
============================================================
NAMED FOR WHAT IT IS, and the old name is worth recording because a successor will find it in the
archives. It was `verify_graph_load.js`, which described its FIRST pass and nothing else — by the time it
held four passes and a write briefing the name was reporting a fraction of the file, which is the same
class of fault the passes themselves exist to catch (Law 7: the name describes the purpose; Law 25: a
label that understates what ran is not a smaller truth, it is a different claim). It is called preflight
because that is where it runs: both conductors press it before a JVM starts and before `raised` flips, so
a refusal costs nothing, and every code change presses it before the change is real.

TWO JOBS, AND THEY ARE ONE JOB. The passes below refuse code that would fail (a bad require, an unbound
name, a hand-written catch). The briefing above them tells the session where its written record goes.
Both exist because this is the single point every piece of work passes through — the only place a rule
reaches an AI developer AT THE MOMENT OF WORK rather than depending on it having read a document first.

Purpose: Load every fragment file in the graph in a headless process and
         report any that fail to `require()`. This closes the "wiring" tier of
         verification: bad requires, missing/renamed exports, broken module
         aliases, and load-time syntax/reference errors — the class of bug that
         otherwise survives all the way to a live server run and stalls the bot
         mid-session.

What this is NOT: it does not connect to a Minecraft server and does not run the
brain end-to-end. Real-world behaviour (pathfinding, timing, block interaction)
is still confirmed only by an actual `master_core.js` run against a live world.
This test proves the graph *loads and wires up*, not that it *behaves*.

Why it needs a bootstrap: mineflayer/vec3/prismarine live in whichever module
homes js_kernel/utils/node_module_homes names for this machine (Auren_Bot/node_modules
first, then the Architect's workstation file). We replicate that resolution here so
the whole graph can load exactly as it does at runtime, then register module-alias
for the @-aliases.

Four passes, all live and all built on ONE walk of the tree:
  1  every file the walk finds is require()d          (bad requires, renamed exports, syntax)
  2  every module's load-time throws fire during 1    (data integrity — free, not extra machinery)
  3  unbound identifiers + dead-zone reads            (a name read where nothing binds it, and a
                                                       let/const read before its own init completes)
  4  the catch shape                                  (a `try` outside external_library_guard.js)
Passes 3 and 4 need the vendored analyzer under tools/vendor/ and FAIL the run if it is missing.
Pass 3 covers the one code-level fault a loader cannot reach: loading a module executes only its top
level, so a bad reference inside a function body is invisible until the world reaches that line. It
presents QUIETLY — the ReferenceError lands in a catch written for a misbehaving world, so the system
reads as declining to act rather than as crashing.
An earlier pass (declared source scans) was deleted 2026-08-10 and another 2026-08-15; the numbering
closed up each time, so a number here names a position and never an identity.

Excluded on purpose: files with live side effects on require —
  - overseer/overseer_server.js  (binds a WebSocket port on load)
  - master_core.js               (connects to a live Minecraft server)
Loading those would bind ports / open sockets, which a smoke test must not do. Parsing has no side
effects, so a parser-based pass COULD sweep them; pass 3's census is deliberately scoped to the fragment
graph instead (see its header), so today nothing reads those two files.

THE WRONG TURN A SUCCESSOR WILL REACH FOR, named here because it was built, run for
five days, and deleted: a "forbidden token" source scan — a list of identifiers that
must appear nowhere in the tree, each with the ruling that deleted it. It looks like
it belongs beside these passes and it does not. The WALK shifts, but each RULE is an
anchor on one token, and what it pins is a DESIGN DECISION rather than a law. Every
design decision here may be legitimately reversed, and on the day one is, the scan
reports a violation for code that is now correct — an instrument emitting a false
verdict, which is worse than no instrument (Law 25). A pass earns its place here only
if it DISCOVERS what to check; a pass that carries a list is stale the day after the
next refactor and reports green the whole time. Every pass below discovers. If you
want a guarantee that some construction is the only pathway, it goes in the module
that owns it as a Law 13 throw, where it shifts with the code — not in a token list.
(The deleted rules and their rulings are preserved verbatim in
Documentation/Refurbishing planning/architect_scratchpad.md §15, as a record of
decisions and explicitly NOT as a checklist.)

It also prints the WRITE BRIEFING before the passes — for each of the three records a session writes:
which one this work belongs in, how close it is to its archive trigger, which archive volume is next, the
newest entry already there, the next entry's number, and the exact line to anchor an Edit on. It rides
this file because this is the one thing every code change already runs; the reasoning is at that block.

Run:  node preflight.js
Exit: 0 if every fragment loads, 1 if any fail (usable as a pre-handoff gate).
============================================================
*/
'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/preflight.js');

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Resolve mineflayer/vec3/prismarine/module-alias, then register the bot's @-aliases, so the graph
// loads here exactly as it does at runtime. Both are one call because both are one question — where the
// bot is — and `workshop_paths` is where the workshop answers it (Law 16).
//
// THE HAND-WRITTEN LIST THAT STOOD HERE IS GONE. It named node_env2 and MinecraftServer and was a
// fourth copy of `js_kernel/utils/node_module_homes`, which also carries `Auren_Bot/node_modules` as a
// last resort — so this file could refuse on a machine where the live launcher runs fine. The canonical
// list is now what preflight resolves against, which is the only way "the graph loads as it does at
// runtime" is a claim rather than a hope.
//
// AND THE BARE `require('module-alias')(base)` IS GONE WITH IT. It auto-discovers by walking up from the
// module-alias INSTALL dir when given no base, and on a portable-node machine that lands on
// MinecraftServer/package.json, which has no `_moduleAliases` and registers nothing. Passing the base
// fixed that and introduced a worse one on a second call — see the WHY block in `workshop_paths.js`.
const paths = require('../workshop_paths');
if (!paths.bootstrapModules().length) {
  console.error('WARN: no node_modules found - run npm install in Auren_Bot/ first; vec3/mineflayer may not resolve.');
}
paths.registerAliases();

// ── THE WRITE BRIEFING (prints on every run, before any pass) ────────────────────────────────────
//
// WHY A BRIEFING RIDES A GATE. Every code change in this fleet runs this file — it is the one button,
// and both conductors press it in preflight before anything is raised. That makes it the only channel
// that reaches an AI developer AT THE MOMENT OF WORK instead of depending on it having read a document
// first. A rule that must be remembered is followed by whoever happened to read it; a rule that arrives
// with the tool reaches everyone who works (Invariant C: reasoning reaches whoever depends on it).
//
// THE LOGIC LIVES IN record_keeper.js / record_briefing.js, NOT HERE, and it was moved out on the
// Architect's ask (2026-09-01: *"maybe we could extract the logic into a utility and import it"*). It had
// two callers the moment archiving became a command of its own, and one capability gets one
// implementation (Law 16). What remains here is the CALL — this file's job is to be the place the
// briefing happens, not the place it is computed.
//
// IT PRINTS FIRST, NOT LAST, and that is deliberate. The obvious shape is a `process.on('exit')` hook so
// the briefing lands beneath the verdict on all seven exit paths below. On Windows a write to a TTY is
// ASYNCHRONOUS, so output emitted from an exit handler is truncated or dropped — the briefing would
// vanish on exactly the platform this fleet runs on. Printing before the passes needs no hook, cannot be
// missed by an exit path added later, and survives a hard crash mid-run.
//
// IT READS AND NEVER WRITES. Archiving is a verb and lives behind its own command; a gate that quietly
// rewrote two large documents while the reader was studying its output would be a surprise, and it runs
// inside conducted runs where a document rewrite has no business happening at all.
// THE SESSION BOARD PRINTS FIRST, because it changes how everything under it should be read. Several
// sessions now share one working tree, and a session that does not know another is writing will report a
// half-written file as a finding. That is not hypothetical — it happened on 2026-09-01, when this session
// read the tree during another's reset-and-restore and reported two turns of work as destroyed. Nothing
// was destroyed. The board is the fix for the class: see who else is here BEFORE trusting what you read.
const _sessionArg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
};
// WHAT IT WRITES IS A STATUS THAT OVERWRITES, NOT A RECORD — "this is what i'm currently working on".
// `session_sync` overwrites it with "this is what i finished doing last" when the turn closes. The
// history of the work lives in the commit message and the two records, never here. See the status block
// at the top of `session_board.js`.
const _session = _sessionArg('--session');
// THE SESSION LAYER LIVES OUTSIDE THE BOT (Architect 2026-09-01): *"lets move all the session logging
// systems outside of auren_bot into a different domain."* It is in `Sessions/` at the repo root, alongside
// `Cutting_room/` — machinery about AI-developer sessions, not about the fleet.
//
// IT IS LOADED BY PRESENCE, not by a catch. The session domain is a SIBLING of the workshop at the repo
// root, not a part of it, and neither one ships: the published bot is a snapshot of `Auren_Bot/` alone.
// So this file has to run as a plain code checker wherever the session layer is absent — a bare checkout
// of the workshop, or a machine set up to run the fleet and not to develop it. A directory either exists
// or it does not, and asking is a decision with an answer; a `try` around the require would be an error
// swallowed on contact (Law 13) and would hide a genuinely broken module behind the same silence.
const _SESSIONS = paths.repo('Sessions');
const _hasSessions = fs.existsSync(_SESSIONS);
const _board = _hasSessions ? require(path.join(_SESSIONS, 'session_board.js')) : null;
if (_board) {
  if (_session) {
    const owns = (_sessionArg('--owns') || '').split(',').map((s) => s.trim()).filter(Boolean);
    _board.working(_session, _sessionArg('--doing'), owns);
  }
  _board.print(_session);

  // IS THE ONE ROUTE TO THE TRUNK ACTUALLY THE ONLY ROUTE? `Sessions/hooks/pre-commit` refuses a commit
  // that did not come through `session_sync`, but a hook only runs if git has been pointed at it, and
  // `core.hooksPath` is per-CLONE config that no commit can carry — so the second workstation gets the
  // hook file and none of its protection until this is set there too. Checked on every run because the
  // failure is silent by nature: everything works exactly as before, minus the guarantee.
  const _hooks = spawnSync('git', ['config', '--get', 'core.hooksPath'],
    { cwd: paths.REPO_ROOT, encoding: 'utf8' });
  if ((_hooks.stdout || '').trim() !== 'Sessions/hooks') {
    console.log('!!  HAND COMMITS ARE NOT BEING REFUSED ON THIS MACHINE');
    console.log('    `git commit` here skips the turn queue, this gate, the undo check, the board and the');
    console.log('    log. One command, once per clone, and the hook in the repo starts doing its job:');
    console.log('        git config core.hooksPath Sessions/hooks\n');
  }
}

// THE OVERLAP FLAG. It fires while the session is still EDITING, which is the only moment it is cheap to
// act on — at commit time the work is already done. It is aimed at the session, never at the Architect:
// he guarantees that no two sessions are given the same work, so an overlap here is a shared FILE rather
// than shared WORK, and shared files are exactly what the last-writer rule resolves. What it is for is
// the case that guarantee does not cover — a session that has quietly wandered off its own subject.
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

// ── HAS THE OTHER WORKSTATION MOVED? (added 2026-09-06) ──────────────────────────────────────────────
// THE GAP THIS CLOSES, measured on 2026-09-06 rather than imagined: nothing in this tool had ever touched
// the remote. It could say everything about this machine and nothing about the other one, while the fetch
// that knows sat in `session_sync`, which runs at the END of a turn. So a session declared its work, did
// all of it, and only then discovered another workstation had done the same job — 2 minutes 39 seconds
// earlier, in the case that prompted this. The comment above `pullFirst` was already titled *"PULL BEFORE
// THE TURN, NOT ONLY BEFORE THE PUSH"*; the reasoning was written and living in the tool that runs last.
//
// IT NEVER BLOCKS. The last session in has the authority to carry the tree forward (CLAUDE.md practice 5),
// so this is information for the session's judgment in the same voice as the churn table below — never a
// door, and never an escalation to the Architect.
//
// A FETCH UNDER A MINUTE OLD IS REUSED, because this runs after every code change and the trunk does not
// move meaningfully inside a minute of editing. The first run of a turn pays a round trip; the rest are
// local. `session_sync` passes no age and therefore always fetches fresh, which is right there: it is
// about to push.
const _trunk = _sync ? _sync.pullFirst(60000) : null;
if (_trunk && _trunk.ok && _trunk.behind > 0) {
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

// WHAT IS ACTUALLY MOVING ON DISK, printed against what the board CLAIMS should be moving. The board is
// declarations; this is mtimes, which no session has to remember to write. The whole value is in the
// disagreement — ground that is changing while its owner reads cold, or changes belonging to nobody at
// all. It is information for THIS session's judgment, never an instruction: *"its a tool for you to
// reason… im empowering you with enough info to make informed reasonable decisions."*
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
    // Logged, not just printed. A contradiction is the one thing here that a session might see, act on,
    // and never mention — and it is exactly the kind of event he wants a record of independent of what
    // any session chose to report.
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

// The write briefing reads the three records, which live in `Documentation/` and `Cognitive_documents/` —
// outside the extract, same as the session layer. Printed only when the domain that owns them is present.
if (_hasSessions) require(path.join(_SESSIONS, 'record_briefing.js')).print();

// Layer ROOTS to sweep, walked RECURSIVELY. Order is irrelevant — each file is loaded independently.
//
// THE WALK USED TO BE ONE LEVEL DEEP PER LISTED PATH, and every subfolder split since has caught it:
// calculators/ dropped the count 88 → 86 with no error, movement/ and locomotion/ were each invisible
// until someone noticed and added a line, and combat_counters/ (2026-08-03) loaded 108 of 108 while
// three brand-new files sat unswept. That is a Law 25 fault in the instrument itself — "108 of 108
// fragment files" was true of the files this list happened to name and false of the fragments that
// exist, and the shape of the failure is silent shrinkage rather than a red line.
//
// The list is roots now, so a new subfolder is swept the moment it exists. Adding one to this array is
// only for a genuinely new TOP-LEVEL layer, which is a design act and not a refactor.
const LAYERS = [
  'Thinking_fragments',
  'action_fragments.js',
  'perception_nodes.js',
  'custom_api',
  'js_kernel',
  'overseer',
  // The foreman is a fleet process like the overseer and was missing from this list, so every file under
  // it loaded for the first time in front of a human standing in the world. That is the silent-shrinkage
  // fault this header describes, seen from the other side: the count was honest about the layers named
  // and quiet about a layer that exists (Law 25).
  'foreman',
  // `monitoring/` IS DELIBERATELY NOT A LAYER, and this is the one entry stating an omission because the
  // omission is the decision. The lens stack moved into the bot on 2026-09-10 so a stranger can diagnose
  // their own run; it is a READ-ONLY OBSERVER that lives outside the construct — no fragment, no signal
  // bus, decides nothing in the loop, and nothing in the fleet's runtime requires it. Every gate below
  // is scoped to the construct: pass 1 loading a lens would run a CLI that calls `process.exit`, and
  // pass 4's one-`try` rule exists because a boundary INSIDE the construct must report through
  // `external_library_guard` — a reader whose whole job is to survive a half-written file it did not
  // write is a different question with a different right answer. Adding this name would refuse sixteen
  // correct files.
];

// Files with live side effects on require (bind ports / open sockets / connect).
const EXCLUDE = new Set([
  path.join('overseer', 'overseer_server.js'),
  // Creates its mineflayer client at module scope, so requiring it JOINS THE SERVER — a load check that
  // takes a player slot is not a load check.
  path.join('foreman', 'foreman.js'),
  'master_core.js',
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
// EXCLUDE exists for ONE reason: requiring those files has live side effects (binds a port, joins the
// server, builds a bot). That reason is about LOADING and says nothing about READING, so every
// parser-based pass must see them — parsing has no side effects at all.
//
// WHY THIS IS A SHARED CONSTANT RATHER THAN A LOOP IN EACH PASS. Pass 3 carried its own copy of this
// re-add and closed the debt for itself; pass 4 did not, and nothing said so. `master_core.js` — what
// every bot runs — therefore held twelve hand-written `try` blocks, eight of them silent and none of them
// through the guard, and was never once seen by the gate whose whole purpose is that there is exactly ONE
// `try` in the fleet (found 2026-09-10 by scoring the guard-admission gates against the tree).
//
// One list, derived once, used by every parser pass. A fourth parser pass added tomorrow gets the right
// scope by using this name, which is the property two hand-written copies could not hold.
const parseTargets = (() => {
  const t = [...files];
  for (const rel of EXCLUDE) {
    const abs = path.join(BOT_DIR, rel);
    if (fs.existsSync(abs) && !t.includes(abs)) t.push(abs);
  }
  return t;
})();

// ── PASS 3: UNBOUND IDENTIFIERS AND DEAD-ZONE READS ──────────────────────────────────────────────
//
// TWO QUESTIONS, ONE PARSE, ONE WALK. Both ask what a name refers to at the moment its line executes,
// both are answered by the same scope analysis, and neither can be answered without one. They are the
// same pass because splitting them would parse every file twice to ask a question the analyzer has
// already answered.
//
// THE HOLE THIS CLOSES, and it is a hole in pass 1 specifically. Pass 1 proves a file LOADS, which
// executes only its top level: requires, constants, module.exports. An identifier referenced inside a
// function body is never evaluated until that function runs, so a reference to a binding that does not
// exist there is invisible to a loader — the file imports clean, wires clean, and throws the first time
// the world reaches that line. The two ways it gets written are both ordinary edits: a refactor deletes
// the statement that defined a local while a use of it survives further down, and a function extracted
// out of its parent keeps reading a binding that stayed behind in the parent's scope. Neither changes
// the top level, so neither is detectable by loading.
//
// WHY THE FAILURE IS QUIET RATHER THAN LOUD, which is what makes it worth an instrument. A ReferenceError
// raised deep in a manager lands in whatever catch is nearest, and the catches in this fleet are written
// for a world that misbehaves — they warn, skip the item, and return a not-done outcome. So the fault
// presents as the system deciding not to act, repeatedly and with an explanation, which reads as a
// gated or blocked condition rather than a crash. That is the most expensive shape a bug can have here.
//
// IT SHIFTS, IT DOES NOT ANCHOR, and that property is now the whole admission test for a pass here. It
// is built on pass 1's own walk and names no file, no function and no identifier — it DISCOVERS what to
// check rather than carrying a list, so it cannot cover less than pass 1 does and a file written tomorrow
// is covered the day it exists. The allowlist has the same property by construction: it is READ OFF THE
// RUNNING RUNTIME (`globalThis`) rather than typed out, so the globals it permits are exactly the ones
// this Node actually provides — a hand-written list would be an anchor in the one place an anchor would
// silently un-cover things as Node adds globals.
//
// WHY A REAL PARSER RATHER THAN A REGEX. Deciding whether an identifier is bound requires scope, and
// scope needs an AST: hoisting, block versus function scope, shadowing, parameters, catch bindings and
// closures all change the answer for identical text. A regex approximation of that emits well-formed
// falsehoods in both directions, and a scanner that cries wolf gets worked around instead of fixed
// (Law 25/26 — a check whose verdict cannot be trusted is worse than no check). espree + eslint-scope
// are the analyzer behind the standard `no-undef`; the analysis is theirs, not a local re-derivation.
//
// VENDORED IN-TREE ON PURPOSE (Auren_Workshop/tools/vendor/). `node_env2/` is gitignored, so a dependency
// installed there exists on one workstation and is missing on the other — the instrument would crash
// on one machine or, worse, be made optional and silently skip. Vendored under the tracked tree it
// travels with the repo and runs identically on both. `.gitignore` carries one negation for this path.
//
// VENDOR THE PUBLISHED TARBALL, NEVER THE REPOSITORY SOURCE. espree is `"type": "module"` and ships its
// CommonJS entry as a BUILD ARTEFACT — `dist/espree.cjs`, produced by rollup at publish time and absent
// from the source tree; `eslint-scope` and `eslint-visitor-keys` are built the same way. A vendoring
// that copies source only leaves `main` pointing at a file that never existed, and the pass cannot run
// at all. Re-vendor with `npm install` using `tools/vendor` as the prefix, then confirm `dist/` exists
// under espree, acorn, eslint-visitor-keys and eslint-scope before committing.
// ── THE SECOND QUESTION: A READ INSIDE ITS OWN DEAD ZONE ─────────────────────────────────────────
//
// WHY IT IS NOT COVERED BY THE FIRST, which is the whole reason it needs saying. `const x = x()` binds
// `x` perfectly well — to the very variable being declared — so the unbound scan is CORRECTLY silent.
// But a `let`/`const`/`class` binding is in a temporal dead zone until its initializer completes, so
// reading it inside that initializer throws `ReferenceError: Cannot access 'x' before initialization`
// the moment the line runs. Same symptom as an unbound name, opposite cause: too many bindings rather
// than none.
//
// HOW IT GETS WRITTEN, and it is a decomposition's signature failure. A helper and one of its callers'
// locals may share a name freely while they live in different scopes — a file-private `_x` beside a
// caller's local `x` is a normal, safe arrangement. Extracting the helper into its own module makes it
// an export, the leading underscore stops being true, and dropping it collapses two names into one:
// the local now shadows the import, and the initializer that meant to call the helper calls itself.
// Nothing about the top level changes, so the file loads clean and pass 1 is silent too.
//
// THE ONE DISTINCTION THAT MAKES THIS USABLE — and a version without it reports ordinary recursion as
// a fault, which is how a scanner earns the reputation that gets it worked around (Law 25/26). A
// reference inside an initializer is only in the dead zone if it is REACHED during that initializer.
// `const walk = (d) => { ... walk(sub) ... }` puts the reference inside a nested function body, which
// runs after the binding is initialized and is correct. The discriminator is therefore a function
// boundary between the reference and the declaration, not text position — which is exactly why this
// needs the analyzer and not a search.
//
// The same test covers the plainer shape: a read textually before its own `let`/`const`, in the same
// function, with no closure between them.
const ESPREE_DIR = path.join(__dirname, 'vendor', 'node_modules');
let espree = null, eslintScope = null, analyzerError = null;
try {
  espree = require(path.join(ESPREE_DIR, 'espree'));
  eslintScope = require(path.join(ESPREE_DIR, 'eslint-scope'));
} catch (e) {
  analyzerError = e && e.message ? e.message : String(e);
}

// Read off the runtime, never typed out — see above. The four CJS module-scope names are added because
// they are provided by the module wrapper rather than by globalThis, so the runtime cannot report them.
const ALLOWED_GLOBALS = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  'require', 'module', 'exports', '__dirname', '__filename', 'arguments', 'globalThis',
]);

// Parsing has NO side effects, so this pass sweeps the two files pass 1 must skip for their
// load behaviour. That closes the declared debt above for this pass rather than inheriting it: the
// reason those files are excluded is that requiring them binds a port or a socket, and nothing here
// requires anything.
// Walk out to the nearest enclosing function (or the module top level). Two references share an
// evaluation moment only when this returns the same scope for both; anything else means a function
// body sits between them and runs later.
function enclosingFunction(scope) {
  let s = scope;
  while (s && s.type !== 'function' && s.type !== 'global' && s.type !== 'module') s = s.upper;
  return s;
}

// ── THE STATIC PASSES CAN REACH FURTHER THAN THE LOADING ONES, AND NOW DO (2026-09-10) ──────────────
// `parseTargets` is the construct: the layers pass 1 can safely `require`. That bound is correct for
// LOADING — pass 1 requiring a lens or a bench would run a CLI that calls `process.exit`, which is why
// `LAYERS` states its omission of `monitoring/` as a decision. It was never a correct bound for a scan
// that only PARSES. espree reads a file without executing a line of it, so the reason to stop at the
// construct's edge simply does not apply here.
//
// WHAT THE GAP COST, measured the same day it was found: `fleet_control.stopAnyRecording()` branched on
// a bare `RECORD_OVERLAY_REQUESTED_NOT_REAPED` that was declared in no scope anywhere. It loaded clean,
// it passed every gate in this file, and it threw a ReferenceError out of `down` — so the FIRST thing
// that ever reported it was a live teardown crashing at the end of a real run. That is exactly the
// failure pass 3 exists to catch, one directory outside where pass 3 was looking.
//
// It matters more now than it did last week: the workshop ships as of 2026-09-10, so an unbound name in
// a bench is a stranger's crash rather than only the Architect's. Pass 4 deliberately does NOT widen —
// its one-`try` rule is about boundaries inside the construct, and a reader whose job is to survive a
// half-written file it did not write is a different question with a different right answer (Law 29).
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
      // A parse failure here is real: pass 1 already proved every swept file loads, so anything that
      // cannot be parsed is either an excluded file with a genuine syntax error or a parser mismatch.
      violations.push({ file: rel, line: 0, name: '(parse failed)', text: e && e.message ? e.message : String(e) });
      continue;
    }
    const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: 'commonjs' });
    // `through` is exactly the set of references that escaped every enclosing scope unresolved — the
    // question this pass asks, answered by the analyzer rather than reconstructed from it.
    for (const ref of scopeManager.globalScope.through) {
      const name = ref.identifier.name;
      if (ALLOWED_GLOBALS.has(name)) continue;
      violations.push({ file: rel, line: ref.identifier.loc.start.line, name });
    }
    // The second question. Every scope, not just the global one: a dead-zone read is resolved — it
    // found its binding — so it never appears in `through`.
    const scopes = [scopeManager.globalScope];
    while (scopes.length) {
      const scope = scopes.pop();
      scopes.push(...scope.childScopes);
      for (const ref of scope.references) {
        const variable = ref.resolved;
        if (!variable || !variable.defs.length) continue;
        const def = variable.defs[0];
        // Only let/const/class have a dead zone; var and function declarations are hoisted and
        // initialized, so reading one early yields undefined rather than a throw.
        const kind = def.type === 'Variable' ? (def.parent && def.parent.kind) : def.type;
        if (kind !== 'let' && kind !== 'const' && kind !== 'ClassName') continue;
        // A function boundary between the reference and the declaration means the reference runs
        // later — see the argument above; this is the line that keeps recursion out of the report.
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
//
// THIS IS A LAW 13 RULE BEFORE IT IS A LAW 16 ONE, and reading it the other way around is what makes a
// successor treat it as tidiness. The one-pathway reading — "the fleet already owns one boundary
// translator, so a second is a redundant route" — is true and it is the smaller half. The load-bearing
// half is default-stopped: a catch is a decision to CONTINUE, written before anyone knows what will
// arrive at it. Law 13 inverts that burden — code proves it is safe to proceed rather than proceeding
// until it cannot — and a hand-written catch proves nothing. It converts an unknown into a known-good
// path by assertion, at a place chosen for where the author expected trouble rather than for where the
// trouble is.
//
// WHY THAT MATTERS MORE HERE THAN IN A SMALLER SYSTEM. A defect that throws surfaces at its own line,
// with its stack, and travels to master_core's uncaughtException handler. The same defect behind a catch
// surfaces as a warn line and a not-done outcome — the system deciding not to act, repeatedly, with an
// explanation — which is indistinguishable from a gated or blocked world condition. Across a graph this
// size that is a bug with somewhere to hide: it is read as a plan problem, and the search starts in the
// wrong subsystem. The census's own findings are the demonstration — a catch answered "you can see it"
// on a line-of-sight predicate, another closed a build as FINISHED because the instrument that measures
// it broke, another returned an empty cell list that read as a completed field.
//
// Law 16 supplies the ONE exception and the shape it must take: a translator turning a third-party throw
// into an outcome, which logs and never swallows. Enforcing that by READING catches is not possible — a
// catch doing the wrong thing is textually identical to one doing the right thing, and the difference is
// what it wraps and what it does next, which is a judgment. So the rule moves off the catch and onto a
// SHAPE: one module owns the only `try` in the fleet, every boundary goes through it, and `try` appearing
// anywhere else is the violation. That question an AST answers with no judgment at all.
//
// WHY A SHAPE RATHER THAN A MARKER COMMENT. A marker (`// LAW16-BOUNDARY`) is a declaration, and anything
// can write a declaration without having done what it claims — a scan over markers proves a string is
// present, never that a boundary is correct. That is Law 26's simulation case: the form survives and the
// guarantee behind it is gone. A shape cannot be claimed, only performed.
//
// IT IS A GATE. It was a printed figure for exactly as long as the migration ran, because a rule nobody
// can satisfy is ignored drift while a number that must only ever go down is visible drift. The figure
// reached zero and the pass became what the figure existed to earn: one hand-written `try` fails the run.
// The reader who is about to add a guard is the audience — the failure arrives before the commit, which
// is the only place a default-stopped rule can be cheap to honour.
// `--catch-detail` CLASSIFIES EACH SITE, kept past the migration because a violation is worth more than
// its line number. Two mechanical axes decide what a site becomes, and neither needs judgment to read:
//   GUARDS — does the try body touch a third-party surface (the mineflayer bot, a module required from
//            outside the @-alias tree, JSON/fs) or only our own fragments? A third-party surface is the
//            only thing Law 16 lets a catch translate; a guard around our own code is a defect converted
//            into a decline-to-act, and its repair is DELETION, not a wrapper.
//   CATCH  — empty (silent swallow, explicitly named illegal), silent (does work but never logs),
//            logged (reaches watcher), rethrow (already Law 13 compliant).
// The pair is the whole verdict: library/* → call the guard; own/* → delete; a `finally` that catches
// nothing → withCleanup. Printing the matrix is what turns "you have a violation" into "here is which of
// three repairs it takes".
const BOUNDARY_OWNER = path.join('js_kernel', 'utils', 'external_library_guard.js');

// THE SECOND EXEMPT FILE, AND IT IS NARROWER THAN AN EXEMPTION. The watcher cannot route its own failures
// through the guard, because the guard reports by calling the watcher: on the exact failure the guard
// exists to translate — a log write that will not complete — the report re-enters the broken writer and
// recurses. That is structural, not a preference; no ordering of requires removes it.
//
// So the watcher carries its own translator, `_selfFault`, which reports to console.error — the one
// channel that does not depend on the channel that just failed. Its exemption is therefore not "logging is
// special" but "the log's own boundary must report somewhere the log is not", and it is checked rather
// than trusted: inside this file a catch must do one of three things, all of them AST-visible.
//   1. call _selfFault  — the watcher's guard, equivalent to guardExternal elsewhere
//   2. rethrow          — instrumentation that observes a failure and lets it travel (track())
//   3. sit inside _selfFault itself — the one terminal swallow in the fleet: if console.error throws
//      (closed/EPIPE stderr) there is no remaining channel to report a failure to report.
// A fourth shape in this file is a violation and fails the pass exactly as a stray try elsewhere does.
const WATCHER_OWNER = path.join('js_kernel', 'watcher.js');
const WATCHER_TRANSLATOR = '_selfFault';

// True when this catch is one of the three shapes above. `insideTranslator` is passed by the walk rather
// than recomputed, because "am I lexically inside _selfFault" is a fact about the path taken to get here.
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

// Names bound to something OUTSIDE our own source tree. A require whose argument starts with '@' is an
// alias into this fleet; anything else (bare package, node builtin, relative path into our own tree is
// rare and treated as ours) is a foreign surface whose throws we do not author.
function _foreignNames(ast) {
  const names = new Set(['bot', 'JSON', 'fs', 'path', 'process']);
  const bind = (id) => {
    if (id.type === 'Identifier') names.add(id.name);
    else if (id.type === 'ObjectPattern') {
      for (const p of id.properties) if (p.value && p.value.type === 'Identifier') names.add(p.value.name);
    }
  };
  // ONE HOP IS NOT ENOUGH, so this runs to a fixpoint. A foreign object routinely arrives in a local and is
  // then operated on for the rest of the function -- `const furnace = await bot.openFurnace(b)` followed by
  // `furnace.takeOutput()`. Reading only the direct `bot.` calls counts that whole block as our own code and
  // would recommend deleting a guard around a genuine third-party surface, which is the one way this census
  // can do harm. Taint is over-inclusive by design: a false 'library' costs a wrapper that was arguably
  // needed anyway, a false 'own' costs an unguarded boundary.
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

// Three-way, and the middle value is the one that matters. Passing `bot` to one of OUR functions is not a
// foreign call — the throw would come from our code — so the discriminator is whether the try body CALLS
// something foreign (`call`), only READS a property off one (`read`, e.g. bot.entity.position, where a null
// from an unloaded chunk is a genuine world condition), or neither (`own`, where a catch has nothing
// legitimate to translate).
function _classifyTry(node, foreign) {
  let calls = false, reads = false;
  _walkNode(node.block, (n) => {
    if (n.type === 'CallExpression') {
      if (n.callee.type === 'Identifier' && foreign.has(n.callee.name)) calls = true;
      // A require() is only a foreign act when the module is foreign. `require('@thinking/x').y()` inside a
      // try is OUR code throwing — counting it as a boundary would license a wrapper around our own defect.
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

// Pass 3 after the load, for the ordering reason every pass here follows: a tree that does not load is
// already refused, and an unbound identifier reported beside a load failure buries the one the reader
// must fix first.
//
// A MISSING ANALYZER IS A FAILURE, NOT A SKIP. The tempting shape is to run this pass when the vendored
// parser happens to resolve and pass silently when it does not — which turns the one instrument that
// runs on every change into something that reports OK while checking nothing, and does it on whichever
// machine is missing the install. An instrument that cannot perform its check says so and refuses
// (Law 25: the verdict states the true result, and "not run" is never "passed").
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

// Pass 4 last, for the same reason the others are ordered: a tree that does not load, or that reads an
// unbound name, is already refused, and a catch reported beside either buries the one the reader must
// fix first.
// The watcher's exemption is checked BEFORE the census, because it is the one place a catch is legal and
// an exemption nobody checks is the hole the shape rule was built to avoid — the three legal shapes are
// the exemption's whole content.
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

// ── THE LOOP RECORD HOLDS HIS WORDS AND NOTHING ELSE (Architect 2026-09-10) ──────────────────────
// A rule that bounds what the AI developer may write cannot be enforced by the AI developer — "did I
// write too much" is the self-judged question that record was founded to escape. It is a whitelist with
// no dial: below the archive boundary, a line is blank, a session heading, or a timestamped verbatim
// prompt. Checked here because `session_sync` gates on this file, so a violating passage cannot reach the
// trunk. Only runs where the session layer exists — the extracted bot repo has no such record.
if (_hasSessions) {
  const _keeper = require(path.join(_SESSIONS, 'record_keeper.js'));
  for (const _rec of _keeper.RECORDS) {
    const _pure = _keeper.auditPurity(_rec);
    if (!_pure.checked) continue;
    // ── ORDER IS A SEPARATE QUESTION FROM CONTENT, SO IT IS A SEPARATE PASS (Law 29) ────────────
    // The purity pass reads WHAT is in the file. This one reads WHAT ORDER it is in, and nothing did
    // until 2026-09-10 — when the renumber-plus-union combination put the newest entry in the wrong
    // place four times in one day, on both workstations, each time repaired by hand. It REFUSES and
    // never sorts: rewriting his record is his ruling to give, not this file's to take. Full reasoning,
    // including the four admission gates it is scored against, is in `record_keeper.auditOrder`.
    const _ord = _keeper.auditOrder(_rec);
    if (_ord.checked && !_ord.ok) {
      console.error(`\n--- LOOP RECORD IS OUT OF ORDER (${_ord.violations.length} heading(s)) ---`);
      console.error(`  ${_rec.file}`);
      console.error('  The record\'s own rule is "Newest session at the TOP, directly under this block."');
      console.error('  A renumber fixes which NUMBER a colliding entry gets; it never moves the block, and');
      console.error('  merge=union places blocks by hunk order. So a colliding turn gets a correct number in');
      console.error('  the wrong position. Move whole lines — never retype a prompt — and run this again.');
      for (const v of _ord.violations) {
        console.error(`      :${String(v.line).padStart(4)}  ${v.why}`);
        console.error(`             ${v.text}`);
      }
      if (_ord.unreadable.length) {
        console.error(`  ${_ord.unreadable.length} heading(s) whose ordinal words did not parse were SKIPPED, not failed:`);
        for (const u of _ord.unreadable) console.error(`      :${String(u.line).padStart(4)}  ${u.text}`);
      }
      process.exit(1);
    }
    if (_pure.ok) {
      console.log(`Loop record OK — ${_rec.file} holds his verbatim prompts and nothing else, newest first.`);
      continue;
    }
    console.error(`\n--- LOOP RECORD CARRIES THE AUDITOR'S OWN WORDS (${_pure.violations.length} line(s)) ---`);
    console.error(`  ${_rec.file}`);
    console.error('  The Architect struck the auditor\'s half on 2026-09-10: "keep only my verbatim prompts');
    console.error('  and metadata only." Below the archive boundary exactly four things are permitted —');
    console.error('  a blank line, a session heading, **HH:MM** *"his prompt"*, or **HH:MM** — a thread ran.');
    console.error('  Mechanism, outcomes and reasoning go to the scratchpad and the bugsquashing report,');
    console.error('  which is where they already go in the same turn. Full rules and the reasoning:');
    console.error('  Cognitive_documents/1_AUDITS/cognitive_self/Architect_Watcher_Story_RULES.md');
    for (const v of _pure.violations.slice(0, 20)) {
      console.error(`      :${String(v.line).padStart(4)}  ${v.why}`);
      console.error(`             ${v.text}`);
    }
    if (_pure.violations.length > 20) console.error(`      … and ${_pure.violations.length - 20} more line(s)`);
    process.exit(1);
  }
}

// ── PASS: NOTHING THAT SHIPS MAY `require` ANYTHING PRIVATE ─────────────────────────────────────────
//
// THE ASK (Architect 2026-09-10): *"the public person is handed all the code, none of the documents…
// we can just make sure everything outside of auren bot is never syned to open source place… i should
// just ship the whole thing as one piece."*
//
// This pass is what makes that safe to do, and it exists because a MECHANISM is being deleted to make
// room for it. Until now the stranger test built a copy of `Auren_Bot/` from `git ls-files` and ran the
// copy, and the copy PROVED — as a side effect, once per run — that nothing shipped reached outside the
// shipped set: a require that did would have failed as MODULE_NOT_FOUND in the download. Shipping the
// whole stack as one piece removes the copy, so that proof has to become something stated rather than
// something incidental (Law 13 — the guarantee cannot quietly leave with the thing that happened to
// provide it).
//
// IT IS STRICTLY BETTER THAN THE COPY WAS. It runs after every change instead of once per run, and it
// names the file, the line and the offending path instead of surfacing forty seconds into a live run as
// a module that is not there.
//
// ── ONLY A `require` COUNTS, AND THAT IS THE WHOLE RULE (Law 29) ────────────────────────────────────
// A require is a LOAD-TIME DEPENDENCY: on a machine without that folder the file cannot even parse into
// existence, and every caller above it dies. That is the one failure this pass is for.
//
// A private path MENTIONED in a comment, a help string, or a path computed and then existence-checked is
// a different thing with a different right answer — `preflight` itself reads the three records out of
// `Documentation/` and `Cognitive_documents/` and prints its briefing only when the domain that owns
// them is present, which is correct behaviour and must not be refused. Making this pass judge mentions
// too would need a whitelist of blessed files, and a whitelist of exceptions is how a guard becomes
// something people edit instead of obey.
const PRIVATE_DOMAINS = [
  'Cognitive_documents', 'Documentation', 'Privacy', 'Sessions',
  'Long_term_memory', 'MinecraftServer', 'Public_server', 'Cutting_room', 'Scratch_tools',
  'Architect_workstation',
];
const PRIVATE_REQUIRE = new RegExp(
  String.raw`require\s*\(\s*['"\`][^'"\`]*(?:` + PRIVATE_DOMAINS.join('|') + String.raw`)[\\/]`, 'g');

const shipped = [];
(function sweepShipped(rel) {
  const dir = path.join(BOT_DIR, rel);
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'fleet_logs') continue;
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) { sweepShipped(childRel); continue; }
    if (ent.name.endsWith('.js')) shipped.push(childRel);
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
//
// ── WHY THIS EXISTS (Architect 2026-09-11) ──────────────────────────────────────────────────────────
// *"look for other ways to separate architect from user. so ways we start and end is the biggest part.
// the second part is the troubleshooting tools. i want my run to be the same as a user run one level
// higher. a user run wont even know that theres a second layer above it."*
//
// The `require` pass above catches the layer above being DEPENDED ON — a load-time failure a stranger
// meets as MODULE_NOT_FOUND. This pass catches the quieter half: the layer above being ADVERTISED. A
// document in the shipped tree that says `node Cutting_room/photograph_page.js` costs a stranger nothing
// at load and everything at the moment they need it — they type the one command their troubleshooting
// guide gave them and get "cannot find module", from an instruction their own copy handed them. Nothing
// fails, so nothing reports it; that is the shape of thing this file exists to catch.
//
// ── THE RULE, AND WHY IT IS NOT A WHITELIST (Law 29) ────────────────────────────────────────────────
// A mention of private ground is a leak when it is an INSTRUCTION and fine when it is an EXPLANATION.
// `overseer/owner_memory.js` names `Privacy/` eight times to explain why that folder is legitimately
// absent on a published copy — that is the separation being documented, which is the opposite of the
// separation failing, and a pass that flagged it would be teaching people to delete their own reasons.
//
// The machine form of "instruction" is a line a person would COPY: it starts with a runner (`node`,
// `&`, `.\`, `./`, a `$`-prefixed shell line) or sits inside a fenced code block. That is a property of
// the line, not a list of blessed files — so there is nothing here to add yourself to, which is what
// keeps a guard something people obey rather than something they edit.
//
// ── IT WARNS, IT DOES NOT REFUSE, AND THAT ASYMMETRY IS DELIBERATE (Law 13) ─────────────────────────
// The require pass exits 1 because its finding is a stranger's copy that cannot load. This one's finding
// is a stranger's copy that loads perfectly and then misleads, which is a real fault and not a broken
// build — refusing every commit until the prose is rewritten would stop work on the fleet to fix a
// paragraph. It prints the file, the line and the text, every run, so the list is impossible to lose.
const DOC_EXT = /\.(md|txt)$/i;
// A markdown TABLE ROW is prose in a grid, so `|` is not a bullet here — `fleet_runbook.md`'s resolver
// table names `../Architect_workstation/workstation.json` as the thing a stranger does NOT have, which is
// this separation being documented. A `$name = ...` assignment is code computing a path, not a command
// somebody types; `scripts/_node.ps1` builds the manifest path and then existence-checks it, which is the
// resolver doing its job. Both were flagged on this pass's first run and both were the pass being wrong.
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

// ── PASS: THE DEPENDENCY RUNS ONE WAY — THE WORKSHOP READS THE BOT, THE BOT NEVER READS THE WORKSHOP ──
//
// A DIFFERENT QUESTION FROM THE PASS ABOVE, and it gets its own pass for that reason (Law 29). That one
// asks whether shipped code reaches material a stranger does not have. This one asks whether shipped bot
// code reaches its own INSTRUMENTS — which every stranger now does have, so it is not a disclosure
// question at all. It is about direction.
//
// WHY IT HAS TO BE CHECKED NOW, HAVING NEVER NEEDED CHECKING BEFORE (2026-09-10). Until the workshop
// moved inside the bot, this invariant was enforced by ABSENCE: a fragment requiring a bench simply could
// not resolve in the extract, so the failure announced itself the first time anybody downloaded. Shipping
// the whole stack as one piece makes that same require resolve perfectly everywhere — which is to say the
// mistake now WORKS, and a mistake that works is one nothing will ever report. That is exactly the shape
// of thing this file exists to catch (Law 13 — a guarantee must not quietly leave with the accident that
// happened to provide it).
//
// WHAT GOES WRONG IF IT INVERTS. The bot's fragments are loaded by the kernel in a fixed order and mount
// onto the signal bus; the benches drive a live world and the lenses read finished records. A fragment
// that requires a lens pulls a reader into the construct it is reading and makes the instrument part of
// what it measures (Law 26 — the translator machine must sit outside). A fragment that requires a BENCH
// is worse: benches connect clients and send RCON, so loading one as a side effect of loading the bot can
// raise processes nobody asked for. That is not hypothetical — earlier in this same turn, a require typed
// at a bench path started a live bench by accident.
//
// NAMING THE DIRECTORY IS SUFFICIENT DETECTION: no entry in `package.json._moduleAliases` points into the
// workshop, so every route from shipped code into this folder has to traverse it by name.
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
//
// THE ASK (Architect 2026-09-11): *"no tool for troubleshooting shall run for a user… a user who is just
// running the bots shall not know that the tools are there and should not start for any of their
// processes. if you want to work on the code then you go into debug mode or developer mode and must enter
// through the architects door."*
//
// ── WHY THIS NEEDS A MACHINE AND CANNOT BE A HABIT ──────────────────────────────────────────────────
// The door is one line at the top of thirty-odd files. A new bench written next month works perfectly
// without it — it runs, it does its job, and NOTHING is wrong from where its author is standing, because
// its author has the door open. The omission is invisible on every machine that could notice it and
// visible only on a stranger's, which is the exact shape of fault this file exists for and the same
// argument as the dependency-direction pass above: a mistake that works is a mistake nothing reports.
//
// ── THE RULE, STATED AS A WHITELIST (Law 29) ────────────────────────────────────────────────────────
// A file under `Auren_Workshop/` or `monitoring/` that DOES SOMETHING WHEN IT IS LOADED must make
// `developer_door.enter(...)` its FIRST executable statement.
//
// "Does something when it is loaded" is decided from the parse tree, and the permitted top-level
// statements are named here and nowhere else: a directive (`'use strict'`), a declaration (`const`,
// `let`, `function`, `class`), an assignment to `module.exports` or `exports.x`, and the MODULE-PATH
// BOOTSTRAP. A file built only from those is a LIBRARY — requiring it computes nothing and starts
// nothing, so the door has nothing to guard and the lens modules, `run_config.js` and
// `workshop_paths.js` are silently correct. Any other top-level statement means `node <file>` acts, and
// the first act must be the question.
//
// ── WHY THE PATH BOOTSTRAP IS ON THAT LIST, SAID OUT LOUD BECAUSE IT IS THE ONE JUDGEMENT CALL ──────
// `paths.registerAliases()`, `paths.bootstrapModules()` and `module.paths.unshift(bootstrapModulePath())`
// are how a file in this tree teaches `require` where the kernel lives. They are declarations wearing a
// call's clothing: nothing connects, nothing spawns, nothing prints, and a module that skipped them could
// not resolve its own next line. Eight lens and helper modules do exactly this and nothing else, and
// forcing a door into them would be WRONG rather than merely noisy — a library is loaded by a parent that
// has already asked, so the refusal would name the wrong file and the gate would fire twice.
//
// The cost of the exemption, named rather than hidden: a statement that CALLS one of those three and also
// does something else in the same breath reads as inert here. It is one line in a file whose whole top
// level is being read, so the exposure is a line somebody would have to write on purpose.
//
// FIRST, not merely present. A door call below a `mineflayer.createBot()` is a bot already connected; a
// door call below a `spawn()` is a process already raised. The gate is only a gate at the top (Law 13 —
// the default is STOPPED, so nothing may happen before the state is known).
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

const shape = scanCatchShape();
if (shape.total === 0) {
  console.log('Catch shape OK — every boundary goes through external_library_guard.');
  process.exit(0);
}
// The classification prints on a FAILURE now rather than behind a flag, because the reader here is
// someone who just wrote one try and needs to know which of three repairs it takes — not someone
// surveying a migration. `--catch-detail` still lists every site for a sweep.
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
