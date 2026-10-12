// Auren_Workshop/tools/lanista_conductor.js
// Conducts one combat bench run end to end: rolls the world back, brings one bot up in sentry, respawns
// it if it is a corpse, runs a named scenario's waves against it, then tears everything down.
//
// Extends test_conductor's rollback (Law 22 gate 2). Like that file it carries no question and reaches
// no verdict — it reports what each step returned.
//
// ── LAW 8 — the `raised` flag ───────────────────────────────────────────────────────────────────────
// Whatever a run raises, that run reaps, and nothing else. Every refusal below exits before the flag flips.
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
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/lanista_conductor.js');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scenarios = require('./lanista_scenario');
// The bench world and its snapshot, read off the same page an ordinary run uses (foreman_plan.freshWorld)
// so this bench and a run can never disagree about which world it is (Law 16). Asked when a bench needs
// it, and registers the aliases it resolves through first (a no-op once registered).
function benchWorld() {
  paths.registerAliases();
  const w = require(paths.bot('foreman', 'foreman_plan.js')).freshWorld(require(paths.bot('js_kernel', 'utils', 'workstation.js')).needServerDir());
  return { world: w.worldName, snapshot: w.snapshot };
}
// The filming overlay: raises lenses between a bring-up and the work, reaps them before the fleet goes.
// See its own header.
const overlay = require('./record_overlay.js');

// The workshop (fleet_control, scripts, lenses, camera, playground) and the shipped bot (js_kernel,
// foreman, Thinking_fragments) are separate roots; each is asked of workshop_paths by name (Law 7).
const paths       = require('../workshop_paths');
const TOOLS_DIR   = __dirname;
const REPO_ROOT   = paths.REPO_ROOT;
const FLEET       = paths.workshop('fleet_control.js');
const LADDER      = path.join(TOOLS_DIR, 'lanista_ladder.js');
const VERIFY      = path.join(TOOLS_DIR, 'preflight.js');

const argv = process.argv.slice(2);
const opt = (n, d) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const has = (n) => argv.includes(`--${n}`);

// One-off overrides of a named scenario, forwarded to the one place the ladder assembles its args. Must
// list every flag the ladder's `take()` table honours (Law 16).
const PASSTHROUGH = ['bot', 'trials', 'world', 'snapshot', 'port', 'label', 'stall', 'ceiling', 'biome',
                     'range', 'lift', 'elevation-spread'];
// Overlay flags are admitted here, not re-parsed — the overlay reads them itself (Law 16), but the
// unknown-flag gate below would refuse them without this admission.
const OWN_FLAGS = ['keep-up', 'no-restore', ...overlay.OVERLAY_FLAGS];

function stamp() { return new Date().toTimeString().slice(0, 8); }
function banner(t) { console.log(`\n${'─'.repeat(78)}\n${stamp()}  ${t}\n${'─'.repeat(78)}`); }

// The scout the ladder runs needs mineflayer, resolved off NODE_PATH through the one shared
// implementation node_module_homes owns (Law 16).
const nodePathEnv = () => require(paths.bot('js_kernel/utils/node_module_homes')).nodePathValue();

function snapshotDir(world, snap) {
  return path.join(require(paths.bot('js_kernel/utils/workstation')).needServerDir(), 'world_snapshots', world, snap);
}

// ── What the ladder's exit code MEANS ───────────────────────────────────────────────────────────────
// Total by construction — an unrecognised code is reported, never treated as success (Law 25).
// `proven` says whether the run is evidence about the kit: a stall measures the bench, a cut measures
// the terrain, and neither is a statement about the bot.
function ladderOutcome(code) {
  if (code === 0) return { key: 'ran',    proven: true,  rerun: false, say: 'every trial ran to a real end — a clear, a death, or a completed ladder' };
  if (code === 2) return { key: 'cut',    proven: true,  rerun: true,  say: 'a trial was CUT SHORT by the ground (a biome that could not be hunted, or a wave that could not be sited). This measures the TERRAIN — a re-run on different ground may well work' };
  if (code === 3) return { key: 'stall',  proven: true,  rerun: false, say: 'a trial STALLED — the body stood beside a mob and never exchanged damage. This measures the BENCH, not the bot, and re-running it proves the same thing again' };
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
  console.log(`  The world is '${benchWorld().world}' — the one bench world (only one server can be live).\n`);
}

// ── Law 8: whatever this run raises, this run reaps — and nothing else ──────────────────────────────
let raised = false;
let torn = false;
// True once the film crew is up; reaped before the fleet, by the overlay, because the overlay raised it (Law 8).
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
  // A second positional selects the overlay, e.g. `ladder record`. Refused, not ignored, when
  // unrecognised (Law 25).
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

  // A mistyped flag is refused, never silently dropped (Law 25).
  const known = new Set([...PASSTHROUGH, ...OWN_FLAGS]);
  const unknown = argv.filter(a => a.startsWith('--') && !known.has(a.replace(/^--/, '').split('=')[0]));
  if (unknown.length) {
    console.error(`\nlanista_conductor: unknown flag(s) ${unknown.join(' ')} — REFUSED before touching anything.`);
    console.error(`  Known: ${[...known].map(f => `--${f}`).join(' ')}`);
    return 1;
  }

  // Read from the same declaration the bring-up is built from, never a second copy of the default (Law 16).
  const world = opt('world', benchWorld().world);
  const snap = opt('snapshot', benchWorld().snapshot);
  if (!has('no-restore')) {
    const dir = snapshotDir(world, snap);
    if (!fs.existsSync(dir)) {
      console.error(`\nlanista_conductor: no snapshot at ${dir} — REFUSED before touching anything.`);
      console.error(`  Take one first:  node ${path.relative(REPO_ROOT, FLEET)} snapshot --world=${world} --name=${snap}`);
      return 1;
    }
  }

  // ── THE ONE BUTTON, AT THE HEAD OF THE RUN ────────────────────────────────────────────────────────
  // Same gate test_conductor runs (Law 16). Still preflight — `raised` is false, so a refusal here
  // reaps nothing.
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
    // `test arena` is the one bring-up route (fresh_start.ps1 -Verb sentry); its gates are trusted, not
    // re-checked (Law 25, Law 16).
    banner('1. ROLLBACK + BRING UP (sentry)');
    // Flips before the spawn — a bring-up that fails partway still leaves a server standing, ours to reap.
    raised = true;
    const upArgs = [FLEET, 'test', 'arena', '--count=1', `--world=${world}`, `--snapshot=${snap}`, `--port=${port}`];
    // NODE_PATH travels with this spawn too — fleet_control's require chain (combat_lens ← combat_ledger)
    // needs it resolved the same way as the ladder spawn (Law 16).
    const up = spawnSync(process.execPath, upArgs, {
      stdio: 'inherit', cwd: REPO_ROOT,
      env: { ...process.env, NODE_PATH: nodePathEnv() },
    });
    if (!note('rollback + bring-up', up.status === 0, `fleet_control test arena exited ${up.status}`)) {
      console.error(`\n${stamp()} the bring-up FAILED (exit ${up.status}). Nothing was fought. Tearing down.`);
      return 1;
    }

    // ── 2. RESPAWN IT IF IT IS DEAD ────────────────────────────────────────────────────────────────
    // Unconditional — a no-op on a live body, run so --no-restore and a repeat --keep-up run take the
    // same path. The verb's report is a claim, not a verdict; aliveness is read back off the server
    // below (Law 23, Law 26).
    banner('2. REVIVE (respawn if dead)');
    const rs = spawnSync(process.execPath, [FLEET, 'verb', 'respawn', `--port=${port}`],
      { stdio: 'inherit', cwd: REPO_ROOT });
    if (rs.status !== 0) {
      console.log(`${stamp()} ⚠ the respawn verb did not deliver (exit ${rs.status}). Reading the body off the server anyway.`);
    }
    const hp = spawnSync(process.execPath, [FLEET, 'rcon', `data get entity ${bot} Health`, `--port=${port}`],
      { encoding: 'utf8', cwd: REPO_ROOT });
    // Live read off the server, not a run record — same route world_forge uses.
    const m = /has the following entity data:\s*([\d.]+)f/.exec(`${hp.stdout || ''}`);
    const health = m ? parseFloat(m[1]) : null;
    if (health === null) {
      // A body the server won't answer for is the corpse-login signature, caught here with a specific
      // message.
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
    // Raised after the body stands, before step 3 — a crew pointed at a corpse films a refusal, and
    // nothing worth filming has started yet.
    if (filming) {
      banner(`2a. FILM CREW — ${overlayName}`);
      const r = overlay.raise({
        overlay: overlayName,
        count: parseInt(opt('count', '1'), 10),
        test: `lanista ${scenario.name}`,
        // No conductor pid — a ladder has no open window to read a stop request in; `stop` reaps the
        // crew itself instead (Law 25).
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
      note('film crew', true, `${overlayName} — cameras${overlay.architectEye() ? " + the Architect's eye" : ''}${r.records ? ', recording' : ', not recording'}`);
    }

    // ── 3. THE LADDER: battleground → summon in aggro range → wait → next wave ─────────────────────
    // One call covers battleground, summon, wait and next-wave — the conductor hands over the scenario
    // and reads the result.
    banner(`3. LADDER — ${scenario.waves.length} wave(s) × ${scenario.trials} trial(s)`);
    const ladderArgs = [LADDER, `--scenario=${scenario.name}`, `--bot=${bot}`];
    for (const f of PASSTHROUGH) {
      // Command-line flags override the scenario's own values; forwarded so the ladder resolves them
      // in the one place args are assembled.
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

    // ── 5. TEARDOWN ───────────────────────────────────────────────────────────────────────────────
    // Death, completion and stall all arrive here as the ladder's exit code, and all three tear down.
    // `--keep-up` is the operator's own override, and is announced.
    if (has('keep-up')) {
      banner('5. TEARDOWN — SKIPPED (--keep-up)');
      console.log(`  The fleet is STILL RUNNING and is yours to reap:  node ${path.relative(REPO_ROOT, FLEET)} down --port=${port}`);
      if (overlayRaised) {
        console.log(`  The cameras are STILL UP${overlay.OVERLAYS[overlayName].records ? ' and STILL RECORDING — every file is still open' : ''}.`);
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
    // Law 8 on every path, including a throw — no-op once torn or if nothing was raised.
    if (!has('keep-up')) teardown('the run ended');
  }
}

if (require.main === module) process.exit(main());

module.exports = { ladderOutcome, snapshotDir, PASSTHROUGH, OWN_FLAGS };
