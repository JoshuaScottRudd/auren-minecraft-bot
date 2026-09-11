// Auren_Workshop/tools/lanista_conductor.js
// ONE command that conducts a whole combat bench run: roll the world back, bring one bot up in sentry,
// stand it back up if it is a corpse, run a NAMED scenario's waves against it, read the ledger, tear
// everything down.
//
// The sequence is: full rollback, bring the bot online, respawn it if it is dead, teleport it to a
// battleground and spawn a monster in aggro range, wait for the battle to end, spawn the next wave, and
// when the bot dies, the waves complete, or the run stalls, tear everything down. The requirement behind
// that sequence is to replace manual, open-ended waiting on a server with a deterministic program — read
// the table below before adding anything here.
//
// ── LANISTA IS AN EXTENSION OF THE STANDARD TEST ────────────────────────────────────────────────────
// It rolls the world back the same way the standard test does, so it is built as an extension of that
// file rather than a parallel implementation of the same rollback.
//
// So this file is `test_conductor.js` with a different middle, and it deliberately shares that file's
// two constraints: it contains NO QUESTION (only an order and thresholds it was given) and it reaches
// NO VERDICT (it reports what each step returned; whether the bot fought well is the Architect's
// reading). Both are restated there at length and not re-argued here.
//
// ── WHO ALREADY OWNED WHAT, MEASURED BY READING THE FILES (Law 22 gate 2 — reuse, not invention) ────
// The eight steps in the sequence above, against what already existed before this file:
//
//   full rollback                → fleet_control `test arena` → fresh_start.ps1 step 1     EXISTED
//   bring bot online             → fresh_start.ps1 step 2, gated on each bot's own
//                                  "Online at (" line, not a timer                          EXISTED
//   respawn it if dead           → NOTHING. see below                                       BUILT
//   teleport to a battleground   → lanista.standBot + lanista_biome.huntBiome               EXISTED
//   spawn a monster in aggro range → lanista.runWave → siteMobCells + summonAt, refused up
//                                  front by rangeFitsAggro if the range cannot honour       EXISTED
//   wait for battle to end       → lanista.observeFight — three completions, none a timer   EXISTED
//   spawn next wave              → lanista_ladder.runTrial's wave loop                      EXISTED
//   tear down on death/complete/stall → the three ends existed; NOTHING joined them to a
//                                  teardown, and `stall` was not a word the bench had       BUILT
//
// Six of eight were already built and already event-gated. This file adds the two that were not, and
// holds the ORDER, which previously existed only as prose.
//
// ── THE RESPAWN, WHICH HAD NO OWNER AND HAD TWO FILES POINTING AT EACH OTHER ────────────────────────
// `master_core` runs `respawn: false` deliberately — a corpse cannot walk, mine or place, so a death is
// a hard stop by physics rather than by a check arriving in time. The only sender was `death_manager`,
// a FRAGMENT dispatched by the planning recursion — which is exactly what sentry mode turns off. So a
// bench bot that died stayed a corpse, and the two files nearest the problem each said the other owned
// it: `await_aggro` logs "the body is NOT respawned by this fragment", `lanista_ladder` refuses a trial
// with "'AurenBot' is dead. Let it respawn." Neither did, and no RCON command can — the respawn packet
// is the CLIENT's to send. The `respawn` operator verb (js_kernel/operator_commands) is the route that
// was missing; this file is its first caller.
//
// THE ROLLBACK IS THE OTHER HALF OF THAT ANSWER, and it is why the sequence starts where it does. A bot
// whose playerdata holds `Health: 0.0f` connects and mineflayer never emits `spawn`, so master_core
// never initialises and NO operator verb — including `respawn` — can reach it. The verb cannot fix that
// brick, because there is nothing running to receive it. A restored snapshot has the file alive again.
// So: rollback repairs the corpse that cannot be spoken to, the verb repairs the corpse that can.
//
// ── LAW 8 — the `raised` flag ───────────────────────────────────────────────────────────────────────
// Whatever a run RAISES, that run reaps, and NOTHING ELSE. A run invoked with no arguments that falls
// through into its own teardown would reap a fleet another session is using — reaping what someone else
// raised is the same violation as leaving a zombie, pointed the other way. Every refusal below therefore
// exits BEFORE the flag flips.
//
// Usage:
//   node tools/lanista_conductor.js ladder                       roll back, arm sentry, run the scenario
//   node tools/lanista_conductor.js swarm --trials=3 --keep-up
//   node tools/lanista_conductor.js ladder record                the same run, FILMED (tools/record_overlay.js)
//   node tools/lanista_conductor.js                              list the declared scenarios
//
// Exit codes: 0 every trial ran to a real end · 2 a trial was cut short (terrain — re-runnable)
//             3 a trial STALLED (the bench, not the bot — re-running proves the same thing again)
//             1 a step failed, the run is unproven.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scenarios = require('./lanista_scenario');
// The bench world, read from the ONE place it is declared. A second conductor carrying its own copy is
// the value-used-to-check drifting from the value-used-to-act (Law 16) — see that constant's header for
// why there is only one world now.
// THE WORLD AND ITS BASELINE COME OFF THE CONFIG PAGE NOW (2026-09-10). This read them from
// `test_conductor.js`, which was deleted when every start/test verb collapsed into `run_config.js` plus
// `run.js`. The two fields are the same two facts under their new names, and reading them from the page
// a person edits means the arena and an ordinary run cannot end up pointed at different worlds — which
// is what a second copy of this constant would guarantee the first time one of them was updated.
const runConfig = require('../run_config.js');
const BENCH_WORLD = { world: runConfig.worldName, snapshot: runConfig.snapshot };
// The filming overlay — the same word, the same crew, the same closer as a conducted soak. It attaches
// here for free because it knows nothing about what a run does: it raises lenses between a bring-up and
// the work, and reaps them before the fleet goes. See its header.
const overlay = require('./record_overlay.js');

// THE SPLIT RUNS THROUGH THIS BLOCK. What used to be one `BOT_DIR` is now two places: the WORKSHOP holds
// fleet_control, the scripts, the lenses, the camera and the playground; the shipped BOT holds js_kernel,
// foreman and Thinking_fragments. Both are asked of workshop_paths by name, because a single constant
// covering both is the assumption the split just falsified (Law 7).
const paths       = require('../workshop_paths');
const TOOLS_DIR   = __dirname;
const REPO_ROOT   = paths.REPO_ROOT;
const FLEET       = paths.workshop('fleet_control.js');
const LADDER      = path.join(TOOLS_DIR, 'lanista_ladder.js');
const VERIFY      = path.join(TOOLS_DIR, 'preflight.js');

const argv = process.argv.slice(2);
const opt = (n, d) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const has = (n) => argv.includes(`--${n}`);

// `biome` and `range` are here for the same reason `trials` is: they are one-off overrides of a named
// run, forwarded to the one place the ladder assembles its args. Without a command-line override, probing
// a scenario cut short by terrain on the only bench world means editing the declaration itself, which
// loses the record of what the scenario is supposed to be.
// EVERY OVERRIDE THE LADDER HONOURS BELONGS HERE. The ladder's `take()` table re-applies exactly seven
// flags over a scenario; a conductor that forwards only some of them makes the other overrides reachable
// solely by bypassing the conductor, which is the second pathway Law 16 forbids. `lift` and
// `elevation-spread` belong here for the same reason — an unforwarded lift can push a scenario's spawn
// band into terrain the rollback happened to place the bot near.
const PASSTHROUGH = ['bot', 'trials', 'world', 'snapshot', 'port', 'label', 'stall', 'ceiling', 'biome',
                     'range', 'lift', 'elevation-spread'];
// The overlay's own flags are ADMITTED here, never re-parsed here: the overlay runs in this process and
// reads them itself (Law 16 — one declaration). Admission is still required because an unknown flag is
// refused before anything runs, so a name only the overlay knows would sink the run at the door.
const OWN_FLAGS = ['keep-up', 'no-restore', ...overlay.OVERLAY_FLAGS];

function stamp() { return new Date().toTimeString().slice(0, 8); }
function banner(t) { console.log(`\n${'─'.repeat(78)}\n${stamp()}  ${t}\n${'─'.repeat(78)}`); }

// The scout the ladder runs needs mineflayer, and it resolves it off NODE_PATH.
//
// THE FOUR LINES OF PATH ARITHMETIC THAT STOOD HERE ARE GONE, and the comment above them is worth
// keeping as a record of why they were tolerated: they were copied from `fleet_control.nodePathEnv`
// because fleet_control is a CLI with no `require.main` guard, so requiring it from here would EXECUTE
// it — read this process's argv, match no command, and exit. That reasoning was sound and the conclusion
// was still one machine's list of node_modules written a third time. `node_module_homes.nodePathValue()`
// is the one implementation, it belongs to neither CLI, and requiring it executes nothing (Law 16).
const nodePathEnv = () => require(paths.bot('js_kernel/utils/node_module_homes')).nodePathValue();

function snapshotDir(world, snap) {
  return path.join(require(paths.bot('js_kernel/utils/workstation')).needServerDir(), 'world_snapshots', world, snap);
}

// ── What the ladder's exit code MEANS ───────────────────────────────────────────────────────────────
//
// TOTAL by construction — every code lands somewhere, and the default is the UNREADABLE one rather than
// the clean one. An unrecognised code falling through to "fine" is the success flag nobody earned (Law
// 25), and it is silent: nothing downstream would ever catch it.
//
// `proven` is the load-bearing field and it is NOT the same as `clean`. A stalled run and a cut run both
// happened and both produced real evidence; what separates them is what the evidence is ABOUT. A stall
// measures the BENCH (the body stood beside a mob it never touched), a cut measures the TERRAIN. Neither
// is a statement about the kit, and a reader who treated either as one would be reading a fight that did
// not happen.
function ladderOutcome(code) {
  if (code === 0) return { key: 'ran',    proven: true,  rerun: false, say: 'every trial ran to a real end — a clear, a death, or a completed ladder' };
  if (code === 2) return { key: 'cut',    proven: true,  rerun: true,  say: 'a trial was CUT SHORT by the ground (a biome that could not be hunted, or a wave that could not be sited). This measures the TERRAIN — a re-run on different ground may well work' };
  if (code === 3) return { key: 'stall',  proven: true,  rerun: false, say: 'a trial STALLED — the body stood beside a mob and never exchanged damage. This measures the BENCH, not the bot, and re-running it proves the same thing again' };
  // 4 IS NOT 2, AND THE DIFFERENCE IS THE SENTENCE ABOVE IT. Code 2 tells the operator "try different
  // ground"; that advice is worthless to a corpse and would send it round the loop for nothing. A death
  // mid-ladder used to surface as code 2 and blame the terrain for it. The ladder now revives between
  // trials, so reaching 4 means the respawn verb itself did not bring the body back — the corpse-login
  // brick, which ONLY a rollback repairs.
  if (code === 5) return { key: 'unfit',  proven: false, rerun: false, say: 'a trial was cut short by the BODY, not the ground — the watch never stood down, or the server would not answer for the bot. Re-rolling terrain will not fix it and the run proves nothing about the kit; read the fleet trace' };
  if (code === 6) return { key: 'bench',  proven: false, rerun: true,  say: 'a trial was cut short by the BENCH — the server refused the summon itself. Neither the ground nor the bot is implicated, and a re-run is worth it once the server is answering' };
  if (code === 4) return { key: 'corpse', proven: false, rerun: false, say: 'the body would not stand — dead after the respawn verb, so the ladder had no bot to test. NOT the ground: a re-run on different terrain changes nothing. This is the corpse-login brick and only a full rollback repairs it; the next conducted run does that on its own' };
  if (code === 1) return { key: 'norun',  proven: false, rerun: false, say: 'the ladder could not run at all (no scout, no rcon, no bot, or a malformed scenario) — this run proves NOTHING either way' };
  return           { key: 'unreadable', proven: false, rerun: false, say: `the ladder exited ${code}, which is not a code it declares — this run proves NOTHING either way` };
}

function listScenarios() {
  console.log('\nlanista_conductor — one command for a whole combat bench run.\n');
  console.log('  node tools/lanista_conductor.js <scenario> [flags]\n');
  console.log('DECLARED SCENARIOS (tools/lanista_scenario.js — edit that file to add one):\n');
  for (const s of scenarios.list()) {
    console.log(`  ${s.name.padEnd(10)} ${s.blurb}`);
    console.log(`  ${''.padEnd(10)}   ${s.waves} wave(s) · ${s.kit.length ? s.kit.join(' + ') : 'BARE FISTS'}`);
  }
  console.log(`\nOVERLAYS (a word after the scenario — films the run):\n`);
  for (const [k, v] of Object.entries(overlay.OVERLAYS)) console.log(`  ${k.padEnd(10)} ${v.blurb}`);
  console.log(`  ${''.padEnd(10)} e.g.  node tools/lanista_conductor.js ladder record`);
  console.log(`  ${''.padEnd(10)} --architect adds the seat you fly yourself (off unless asked for)`);
  console.log(`  ${''.padEnd(10)} It closes when the ladder does; to close it early or after --keep-up:`);
  console.log(`  ${''.padEnd(10)}   node Auren_Workshop/tools/record_overlay.js stop`);
  console.log(`\n  Flags: ${PASSTHROUGH.map(f => `--${f}=`).join(' ')} ${OWN_FLAGS.map(f => `--${f}`).join(' ')}`);
  console.log(`  --keep-up      leave the fleet standing after the ladder (for a second run or a look around)`);
  console.log(`  --no-restore   skip the rollback. READ THIS FIRST: the rollback is what repairs a bot whose`);
  console.log(`                 playerdata holds Health 0.0f — that body connects and never emits spawn, so`);
  console.log(`                 no operator verb can reach it. Skipping the rollback keeps that brick.\n`);
  console.log(`  The world is '${BENCH_WORLD.world}' — the one bench world (only one server can be live).\n`);
}

// ── Law 8: whatever this run raises, this run reaps — and nothing else ──────────────────────────────
let raised = false;
let torn = false;
// True once the film crew is up. The crew is reaped BEFORE the fleet for the same reason a recording is
// stopped before its subject disappears — and by the overlay, because the overlay raised it (Law 8).
let overlayRaised = false;
function teardown(why) {
  if (torn || !raised) return;
  torn = true;
  if (overlayRaised) { try { overlay.reap(why); } catch (e) { console.error(`\n${stamp()} ⚠ the overlay teardown threw: ${e.message}`); } }
  banner(`TEARDOWN — ${why}`);
  const r = spawnSync(process.execPath, [FLEET, 'down', `--port=${opt('port', '3001')}`],
    { stdio: 'inherit', cwd: REPO_ROOT });
  const left = spawnSync(process.execPath, [FLEET, 'status'], { stdio: 'inherit', cwd: REPO_ROOT });
  if (r.status !== 0 || left.status !== 0) {
    console.error(`\n${stamp()} ⚠ teardown did not report clean — read the status above. ` +
      `Force-kill route: node ${path.relative(REPO_ROOT, FLEET)} takeover`);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { teardown(`${sig} — the operator interrupted the run`); process.exit(1); });
}

function main() {
  const positional = argv.filter(a => !a.startsWith('-'));
  const name = positional[0];
  if (!name) { listScenarios(); return 1; }

  // ── THE OVERLAY WORD ─────────────────────────────────────────────────────────────────────────────
  // A second positional, so a filmed combat run is typed the way it is said: `ladder record`. Refused
  // rather than ignored when unrecognised — a mistyped overlay that quietly ran an unfilmed ladder
  // produces a run that looks like the one that was asked for and is not (Law 25).
  const overlayName = positional[1] || null;
  if (overlayName && !overlay.OVERLAYS[overlayName]) {
    console.error(`\nlanista_conductor: '${overlayName}' is not an overlay. Say one of — ` +
      `${Object.keys(overlay.OVERLAYS).join(' | ')} — REFUSED before touching anything.\n`);
    return 1;
  }
  if (positional.length > 2) {
    console.error(`\nlanista_conductor: too many names — a run is '<scenario> [overlay]', got ` +
      `'${positional.join(' ')}' — REFUSED before touching anything.\n`);
    return 1;
  }
  const filming = !!overlayName;

  // ── PREFLIGHT — every refusal here costs nothing and reaps nothing ────────────────────────────────
  const loaded = scenarios.load(name);
  if (!loaded.ok) {
    console.error(`\nlanista_conductor: REFUSED before touching anything —`);
    for (const p of loaded.problems) console.error(`  · ${p}`);
    return 1;
  }
  const scenario = loaded.scenario;

  // A mistyped flag is REFUSED, never dropped: `--trails=3` silently ignored runs one trial and produces
  // a run that looks like the one that was asked for and is not (Law 25).
  const known = new Set([...PASSTHROUGH, ...OWN_FLAGS]);
  const unknown = argv.filter(a => a.startsWith('--') && !known.has(a.replace(/^--/, '').split('=')[0]));
  if (unknown.length) {
    console.error(`\nlanista_conductor: unknown flag(s) ${unknown.join(' ')} — REFUSED before touching anything.`);
    console.error(`  Known: ${[...known].map(f => `--${f}`).join(' ')}`);
    return 1;
  }

  // Read from the SAME declaration the bring-up is built from, never a second copy of the default —
  // a preflight gating on a world the run does not use is the drift this check exists to catch.
  const world = opt('world', BENCH_WORLD.world);
  const snap = opt('snapshot', BENCH_WORLD.snapshot);
  if (!has('no-restore')) {
    const dir = snapshotDir(world, snap);
    if (!fs.existsSync(dir)) {
      console.error(`\nlanista_conductor: no snapshot at ${dir} — REFUSED before touching anything.`);
      console.error(`  Take one first:  node ${path.relative(REPO_ROOT, FLEET)} snapshot --world=${world} --name=${snap}`);
      return 1;
    }
  }

  // ── THE ONE BUTTON, AT THE HEAD OF THE RUN ────────────────────────────────────────────────────────
  // Same gate `test_conductor` runs, for the same reason and stated once there at length: this is the
  // fleet's only permanent instrument, and the load faults it catches otherwise surface a rollback and
  // a login later, wearing the costume of a bot that will not come online. Still PREFLIGHT — `raised`
  // is false, so a refusal here reaps nothing because nothing has been raised.
  //
  // Lanista needs it MORE than the standard test does, not less: this bench exists to be run over and
  // over against combat code that is being edited between runs, so the load-time throws that fire for
  // free during this sweep are checked against the freshest edits in the fleet.
  banner('PREFLIGHT — preflight (the one button)');
  const graph = spawnSync(process.execPath, [VERIFY], { stdio: 'inherit', cwd: REPO_ROOT });
  if (graph.status !== 0) {
    console.error(`\nlanista_conductor: the graph does not load (exit ${graph.status}) — REFUSED before ` +
      `touching anything. The failing file and its message are named above.`);
    return 1;
  }

  const bot = opt('bot', 'AurenBot');
  const port = opt('port', '3001');
  const t0 = Date.now();

  banner(`LANISTA — ${scenario.name}${filming ? ` ${overlayName}` : ''}`);
  console.log(`  ${scenario.blurb}`);
  console.log(`  ${scenarios.describe(scenario)}`);
  console.log(`  world '${world}'${has('no-restore') ? ' (NOT rolled back)' : `, restored from '${snap}'`} · bot '${bot}'`);
  if (filming) {
    console.log(`  filming: ${overlay.OVERLAYS[overlayName].blurb}`);
    console.log(`           raised after the body is standing and BEFORE the first wave, so no fight is`);
    console.log(`           missed. It closes when the ladder does — a combat run has a real end.`);
  }

  const steps = [];
  const note = (label, ok, detail) => { steps.push({ label, ok, detail }); return ok; };

  try {
    // ── 1. FULL ROLLBACK + BRING ONE BOT UP IN SENTRY ──────────────────────────────────────────────
    // `test arena` is the one bring-up route (fresh_start.ps1 with -Verb sentry). Nothing here re-checks
    // its gates: it already waits on the server port answering, on each bot's own "Online at (" line,
    // and on HQ verified cold ON DISK. Consuming a predecessor's outcome as settled fact is the whole
    // of Law 25's trust contract — a re-verifying step is the redundant pathway Law 16 forbids.
    banner('1. ROLLBACK + BRING UP (sentry)');
    // Flips BEFORE the spawn, not after it returns: a bring-up that fails part-way has still left a
    // server and an overseer standing, and those are ours to reap.
    raised = true;
    const upArgs = [FLEET, 'test', 'arena', '--count=1', `--world=${world}`, `--snapshot=${snap}`, `--port=${port}`];
    // NODE_PATH TRAVELS WITH THIS SPAWN TOO. It used to be set only on the ladder spawn below, on the
    // reading that fleet_control is launched from the repo root and resolves its own modules — which is
    // true on a machine whose module home sits beside the repo and false on one that does not.
    // fleet_control requires monitoring/combat_lens ← combat_ledger, and that chain fails to resolve
    // without NODE_PATH set. Two spawns of the same tree needing the same resolution path is one fact,
    // not two, so both read `nodePathEnv()` (Law 16).
    const up = spawnSync(process.execPath, upArgs, {
      stdio: 'inherit', cwd: REPO_ROOT,
      env: { ...process.env, NODE_PATH: nodePathEnv() },
    });
    if (!note('rollback + bring-up', up.status === 0, `fleet_control test arena exited ${up.status}`)) {
      console.error(`\n${stamp()} the bring-up FAILED (exit ${up.status}). Nothing was fought. Tearing down.`);
      return 1;
    }

    // ── 2. RESPAWN IT IF IT IS DEAD ────────────────────────────────────────────────────────────────
    // Unconditional, because the conductor cannot know the answer without asking and the verb is a
    // no-op on a live body by design. After a rollback it should always be the no-op; it is run anyway
    // so that `--no-restore` and a second run under `--keep-up` take the same path as the first.
    //
    // The verb's own report is a CLAIM by the process that sent the packet, so it is not the verdict —
    // aliveness is read back off the SERVER below (Law 23, and Law 26's rule that a process may not
    // certify its own recovery).
    banner('2. REVIVE (respawn if dead)');
    const rs = spawnSync(process.execPath, [FLEET, 'verb', 'respawn', `--port=${port}`],
      { stdio: 'inherit', cwd: REPO_ROOT });
    if (rs.status !== 0) {
      console.log(`${stamp()} ⚠ the respawn verb did not deliver (exit ${rs.status}). Reading the body off the server anyway.`);
    }
    const hp = spawnSync(process.execPath, [FLEET, 'rcon', `data get entity ${bot} Health`, `--port=${port}`],
      { encoding: 'utf8', cwd: REPO_ROOT });
    // The reply is a LIVE READ off the server, not a run record — this is the same route `world_forge`
    // already uses, and the record/reader rule is untouched by it (no watcher file is opened here).
    const m = /has the following entity data:\s*([\d.]+)f/.exec(`${hp.stdout || ''}`);
    const health = m ? parseFloat(m[1]) : null;
    if (health === null) {
      // NOT a silent pass. A body the server will not answer for is the corpse-login brick's own
      // signature, and the ladder would refuse three steps later with a less specific sentence.
      console.error(`\n${stamp()} the server will not report Health for '${bot}'. That is the signature of a body ` +
        `that connected as a corpse: mineflayer never emits \`spawn\`, so master_core never initialises and ` +
        `no operator verb can reach it. A ROLLBACK is the only repair — re-run without --no-restore.`);
      note('revive', false, 'the server would not report the body');
      return 1;
    }
    if (!note('revive', health > 0, `Health ${health}`)) {
      console.error(`\n${stamp()} '${bot}' is still DEAD (Health ${health}) after the respawn verb. Nothing was fought.`);
      return 1;
    }
    console.log(`${stamp()} '${bot}' is ALIVE — Health ${health}, read off the server.`);

    // ── 2a. THE FILM CREW, BEFORE THE FIRST WAVE ──────────────────────────────────────────────────
    // Raised here rather than beside the bring-up because the body must be standing first: a crew
    // pointed at a corpse films a refusal. Everything worth filming on this bench happens in step 3,
    // and none of it has started yet — so nothing is missed, which is the whole reason the insertion
    // point is "after the bring-up, before the work" on every rung.
    if (filming) {
      banner(`2a. FILM CREW — ${overlayName}`);
      const r = overlay.raise({
        overlay: overlayName,
        count: parseInt(opt('count', '1'), 10),
        test: `lanista ${scenario.name}`,
        // NO CONDUCTOR PID, deliberately. A soak can be stopped mid-window because it is open-ended; a
        // ladder ends when the waves do, and there is no slice to read a request between. Recording
        // `stop` as a request here would hand the operator a command that silently never arrives.
        // With no pid on record, `stop` reaps the crew itself and says so — which is the honest
        // behaviour for a run whose conductor is not listening (Law 25).
        conductorPid: null,
      });
      overlayRaised = true;
      if (!r.ok) {
        console.error(`\n${stamp()} the film crew did not come up (${r.why}). NOTHING WAS FOUGHT — a ` +
          `combat run that was asked for on tape is not the same run untaped, and a ladder is expensive ` +
          `to re-run. Tearing down.`);
        note('film crew', false, r.why);
        return 1;
      }
      note('film crew', true, `${overlayName} — cameras${overlay.architectEye() ? " + the Architect's eye" : ''}${r.obs ? ', recording' : ', not recording'}`);
    }

    // ── 3. THE LADDER: battleground → summon in aggro range → wait → next wave ─────────────────────
    // Steps 4-7 of his sequence are ONE call, because they are one owner's job and always were. The
    // conductor does not re-site, re-summon or re-wait; it hands over the scenario and reads the code.
    banner(`3. LADDER — ${scenario.waves.length} wave(s) × ${scenario.trials} trial(s)`);
    const ladderArgs = [LADDER, `--scenario=${scenario.name}`, `--bot=${bot}`];
    for (const f of PASSTHROUGH) {
      // The scenario already carries these; a flag on the command line is a deliberate one-off override
      // of the named run and is forwarded so the ladder resolves it in the one place args are assembled.
      if (f === 'bot' || f === 'world' || f === 'snapshot' || f === 'port') continue;
      const v = opt(f, null);
      if (v !== null) ladderArgs.push(`--${f}=${v}`);
    }
    const ladder = spawnSync(process.execPath, ladderArgs, {
      stdio: 'inherit', cwd: REPO_ROOT,
      // The scout is a real mineflayer client; without this it cannot resolve the module and the ladder
      // refuses with "mineflayer unavailable to the scout" before anything is summoned.
      env: { ...process.env, NODE_PATH: nodePathEnv() },
    });
    const outcome = ladderOutcome(ladder.status);
    note(`ladder (${outcome.key})`, outcome.proven, outcome.say);

    // STEP 4 WAS THE LEDGER, AND IT IS GONE. It ran a reader over a file that accumulated one row
    // per trial across every run the bench had ever had. That record was deleted (Architect
    // 2026-08-31): the fleet changes between runs, so old rows measure a system that no longer
    // exists, and a comparison across them reads as data while being none (Invariant B). The
    // ladder now reports its own session before it exits, and the lasting artifact is the write-up
    // a person makes from it — not a file this step could read.

    // ── 5. TEARDOWN ───────────────────────────────────────────────────────────────────────────────
    // "when bot dies or waves are complete or if theres a stall then tear everything down" — all three
    // of those ends arrive here as the ladder's exit code, and all three tear down. `--keep-up` is the
    // operator's own override, announced rather than silent.
    if (has('keep-up')) {
      banner('5. TEARDOWN — SKIPPED (--keep-up)');
      console.log(`  The fleet is STILL RUNNING and is yours to reap:  node ${path.relative(REPO_ROOT, FLEET)} down --port=${port}`);
      if (overlayRaised) {
        console.log(`  The cameras are STILL UP${overlay.OVERLAYS[overlayName].obs ? ' and STILL RECORDING — every file is still open' : ''}.`);
        console.log(`  Close them FIRST, before the fleet:  node Auren_Workshop/tools/record_overlay.js stop`);
      }
    } else {
      teardown(`the ladder ${outcome.key === 'ran' ? 'completed' : `ended: ${outcome.key}`}`);
    }

    // ── 6. WHAT HAPPENED — facts, and no verdict ──────────────────────────────────────────────────
    banner('6. WHAT HAPPENED');
    console.log(`  ${scenarios.describe(scenario)}\n`);
    for (const s of steps) console.log(`  ${s.ok ? '✔' : '✘'} ${s.label.padEnd(22)} ${s.detail}`);
    console.log(`\n  THE LADDER: ${outcome.say}`);
    if (!outcome.proven) {
      console.log(`  ⚠ NOTHING IS PROVEN by this run — the fight either did not happen or could not be read.`);
    }
    if (outcome.rerun) {
      console.log(`  → A re-run is worth it: the ground, not the bot, is what ended this one.`);
    }
    console.log(`\n  Why a wave went the way it did:  node Auren_Bot/monitoring/trace_monitor.js --combat --bot=${bot}`);
    console.log(`\n  ${Math.round((Date.now() - t0) / 1000)}s total. No verdict is stated here: whether this run was`);
    console.log(`  good enough is measured against a criterion only the Architect owns (Law 25).\n`);

    return ladder.status === 0 ? 0 : (outcome.key === 'cut' ? 2 : outcome.key === 'stall' ? 3 : 1);
  } catch (e) {
    console.error(`\nlanista_conductor threw: ${e.stack || e.message}`);
    return 1;
  } finally {
    // Law 8 on every path including a throw and a `return` above. No-op when --keep-up already skipped
    // it (the `torn` guard) and no-op when nothing was raised.
    if (!has('keep-up')) teardown('the run ended');
  }
}

if (require.main === module) process.exit(main());

module.exports = { ladderOutcome, snapshotDir, PASSTHROUGH, OWN_FLAGS };
