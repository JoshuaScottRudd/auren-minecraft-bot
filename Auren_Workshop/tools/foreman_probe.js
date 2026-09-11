'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/foreman_probe.js');
// tool: foreman_probe — does the foreman actually answer a HUMAN, and does it refuse everything else?
//
// The foreman is the first thing in this fleet that takes instructions from outside the terminal, so
// "it works" is not a claim to make from reading it. Two questions have to be answered together and
// neither is sufficient alone:
//
//   V1-V4  IT ANSWERS A HUMAN. A second mineflayer client holds a real player slot and speaks; its
//          chat packet is indistinguishable from a keyboard's, which is what makes it a legitimate
//          stand-in rather than a simulation (same instrument as chat_probe).
//   V5     IT REFUSES THE CONSOLE. This is the control, and it is the half that can fail silently.
//          Chat probe C4 found that a console /say ALSO raises mineflayer's `chat` event, as the
//          player `Rcon` — so a foreman built on the convenient layer would take orders from anything
//          able to reach the server console. The foreman reads `player_chat` off the wire instead. V5
//          is what proves that distinction is real IN THE FOREMAN and not merely in the probe that
//          discovered it.
//
// WITHOUT V5 THIS PROBE WOULD BE WORTHLESS. A run where the foreman answers everything scores four
// green ticks on V1-V4 and is catastrophically wrong. An affirmative-only probe cannot tell a working
// authenticator from an absent one.
//
//   V6-V7,
//   V9-V11 THE COMMAND SYSTEM. A human spawns, starts and stops bots by speaking, is offered every
//          verb the fleet knows, and may hold at most two bots. Wherever the world can be asked
//          instead of the foreman, it is: `get` and `exit` are graded on the SERVER'S OWN player list,
//          not on what the foreman said about them, because the foreman is the thing under test and a
//          component's report on itself is not evidence (Law 26 — grading your own paper). `start` has
//          no such postcondition from outside the process, so it is graded on delivery and the verdict
//          says exactly that rather than claiming the bot began to think.
//   V8     THE OWNERSHIP CONTROL, and the reason V7 and V9 mean anything. A SECOND player says the
//          identical words in the same channel; the first player's bot must not move. A door that
//          delivers to everybody scores exactly the same as a working one on V7/V9 alone, so without
//          a second human in the world the ownership claim is untested rather than confirmed.
//   V12    THE SPECIES CONTROL. A homesteader is started from the TERMINAL and then commanded from
//          inside the world; it must not move. This is V5's argument one layer in — V5 proves the
//          foreman will not take orders from the console, V12 proves the fleet will not take a human's
//          orders on behalf of a species built to ignore humans.
//   V13    THE OVERRIDE, which is V12's other half: the same verb from the CONSOLE must take that
//          same bot down. V12 alone cannot tell a working origin filter from a bot that is simply
//          unreachable, and a fleet where nothing can stop a homesteader is not the goal either.
//   V14-V15 WHERE A CONTRACTOR STANDS — the two ends of its life. It is fetched to the exact cell its
//          owner occupies (no scan: a cell a living player stands in has floor, headroom and no lava
//          because somebody is standing in it), and after dying it returns to its OWN sited house
//          rather than the estate's headframe — built or not, because the LOCK is the home. Both are
//          read off the server's entity data, never off the fleet's own account of itself.
//
//   V16-V28 THE REQUEST SYSTEM — the one verb that writes a FACT instead of commanding a body, so it
//          is the one whose delivery nothing in the world demonstrates: a command that reached nobody
//          leaves a bot standing still, while a requirement that reached nobody looks exactly like one
//          that landed. Every question here is therefore graded on a postcondition OUTSIDE the desk
//          wherever one exists — the crew's own kernel file for whether a row arrived, the crew's own
//          measurement for whether the work is moving — because the desk relaying its own message back
//          is one component observed twice (Law 26).
//          V20-V22 are the controls and they carry the weight: a refused item must also be UNFILED
//          (accepting then refusing later strands a crew on work nothing can produce), a malformed
//          order must never become a quantity somebody did not say, and a second player must not be
//          able to read or cancel the first player's requirements. Without those three, V17-V19 score
//          identically against a ledger that accepts everything from everybody.
//          V24 is the round trip and the only question here that involves a body doing anything: a
//          figure measured inside a crew, posted to its chair, relayed by the overseer and spoken by
//          the desk. It is graded against the crew's own chair as well as the reply, so a silent desk
//          can be told from a crew that never looked.
//
// EVERY QUESTION FROM V6 ON IS VOID, NOT FAILED, IF THE CLERK IS NOT IN THE WORLD when its answer was
// due. A dead foreman is silent, and silence read as a refusal is a confident verdict about a system
// nobody asked — the fault this probe exists to catch, committed by the probe. It is checked against
// the server's player list before each of those verdicts is written.
//
// Run (server must be UP; the foreman, the overseer and every bot are raised BY this probe and taken
// down with it — Law 8. A foreman already on duty is REUSED and left standing, so this can be pointed
// at a live contractor bench instead of only at an empty server):
//   . .\Auren_Workshop\scripts\_node.ps1 ; & (Get-AurenNode) Auren_Workshop\tools\foreman_probe.js --phase=1
//   . .\Auren_Workshop\scripts\_node.ps1 ; & (Get-AurenNode) Auren_Workshop\tools\foreman_probe.js --phase=2
//
// THE RUN IS CUT IN TWO BY WHAT CAN ANSWER A QUESTION, not by subject — see THE PHASE below the
// requires for the full statement and for what phase 1 is not allowed to claim. In short: phase 1
// raises no overseer and no bots (a stand-in holds the in-game door), so it answers every question
// about what the DESK said or put on the wire in seconds; phase 2 raises the real fleet, answers only
// what a BODY can answer, and ends when the filed requests are MET rather than when the fleet goes
// quiet — a still fleet may simply be holding its whole board at the gates.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const paths = require('../workshop_paths');
const BOT_DIR = paths.BOT_ROOT;

// WHERE THE MODULES LIVE IS ASKED OF THE ONE FILE THAT ANSWERS IT. This was a private two-entry list,
// which is one directory short on this machine and does not survive a new layout — the same shape of
// defect this probe found in the foreman's own door on the run that produced this fix (Law 16).
//
// `bootstrapModulePath` rather than a `module.paths` push, and the difference is what broke here:
// unshifting onto THIS module's paths resolves what THIS FILE requires by name, and nothing else. A
// fleet module required from here (the requestable catalogue, which reaches vec3 four levels down) does
// its own resolution from its OWN directory and never sees this file's list — so the probe loaded fine
// and died halfway through a live run, inside a require it had no way to see coming.
const moduleHomes = require(paths.bot('js_kernel/utils/node_module_homes'));
const MODULE_DIRS = moduleHomes.bootstrapModulePath();
if (MODULE_DIRS.length === 0) {
  console.error('foreman_probe: no module home found — mineflayer cannot resolve. Checked: '
    + moduleHomes.CANDIDATE_HOMES.join(', '));
  process.exit(1);
}
for (const d of MODULE_DIRS) module.paths.unshift(d);

// Every child this probe spawns inherits it. The foreman is a fleet process and needs the same module
// resolution the launcher gives it; spawning it with a bare env is how it came up dead.
const CHILD_ENV = {
  ...process.env,
  NODE_PATH: [process.env.NODE_PATH, moduleHomes.nodePathValue()].filter(Boolean).join(path.delimiter),
};

const mineflayer = moduleHomes.requireFromHomes('mineflayer');
const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));

// The roster from the Architect's own table (Law 16) — the cap question counts how many roster names
// are in the world, which needs the set of names a `get` could legally have chosen.
const { BOT_SENIORITY, FOREMAN_NAME } = require(paths.bot('Thinking_fragments/architect_config.js'));
const ROSTER_LOWER = Object.keys(BOT_SENIORITY).map(n => n.toLowerCase());

// THE VERB LIST AND THE BOT CAP ARE READ FROM THE FLEET, never retyped here (Law 16). A probe carrying
// its own copy of either would keep passing on the day the fleet's number changed — the help question
// would report a complete help while a new verb went undescribed, and the cap question would measure a
// limit nobody enforces. The aliases are registered because foreman_vocabulary is written for a process
// that has them; this probe borrows the fleet's own table rather than a second spelling of it.
paths.registerAliases();
const { OPERATOR_VERBS, CREW_SIZE } = require(paths.bot('foreman/foreman_vocabulary'));
// THE FLEET'S OWN DOOR CLIENT, borrowed rather than re-spelled. Two questions here need a fact only the
// overseer holds — which bots are registered, and under whose name and species — and a second socket
// client written in this file would be a parallel route to it that drifts the day the envelope changes
// (Law 16). It is used to OBSERVE, never to command: every verb in this probe is spoken in the world.
const door = require(paths.bot('foreman/overseer_door'));

const net = require('net');

const HUMAN = 'ProxyHuman';
// The second person in the world. Every ownership question needs somebody who did NOT ask for the bot;
// with one player, "only the owner may command it" and "anyone may command it" produce identical runs.
const HUMAN_B = 'ProxySecond';
const VERSION = '1.21.5';
// The bot the HUMAN fetches (a contractor by construction) and the one the OPERATOR starts (a
// homesteader, because a terminal launch stamps one). Two different names so the species control is a
// question about what a bot IS and not about whichever bot happened to be up.
const CONTRACTOR_NAME = 'AurenBot';
const HOMESTEADER_NAME = 'TessaBot';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── THE PHASE, AND WHY THE RUN IS CUT IN TWO ───────────────────────────────────
// PHASE 1 — THE DESK. No overseer, no bots, no world work. A stand-in sits on the overseer's in-game
//   door (`foreman_door_standin`) and the foreman relays into it, unmodified: same socket, same
//   envelope, same port. Every question answerable from what the desk SAID or from what it PUT ON THE
//   WIRE lives here, and the phase ends when they are asked — there is nothing to wait for.
// PHASE 2 — THE FLEET. The real overseer, a real crew, real work. Only the questions a BODY can answer
//   live here: which bots a verb actually reached, where a contractor stands, whether a filed
//   requirement is met by work. It ends when the requests are FILLED (see the completion watch).
//
// WHY NOT A TEST MODE IN THE DESK. The alternative was to teach the foreman that one named player is a
// tester and have it acknowledge verbs without executing them. That installs a branch that only ever
// runs under test — so the fast phase would exercise a desk no human meets (Law 16) — and it gives the
// desk the power to treat one speaker specially, which is the power V5/V8/V12 exist to prove it does
// not have. Cutting at the DOOR needs no branch: `overseer_door`'s rule is that origin is decided by
// which door is knocked on, never by a field, so the desk cannot tell the difference and nothing in it
// had to be told.
//
// WHAT PHASE 1 MAY NOT CLAIM, stated here because a silent narrowing is how a question goes green
// against a world where its defect cannot occur (Law 25). The stand-in AUTHORS the roster and does not
// implement the ownership or species filter at all — that filter is `broadcastCommand`'s, and a second
// copy of it inside the instrument that grades it would pass its own questions while the fleet's copy
// rotted (Law 16). So delivery, ownership and species isolation are PHASE 2 claims. Phase 1 asserts
// what the desk FORMED; phase 2 asserts who RECEIVED it.
//
// DEFAULT STOPPED (Law 13): no phase is assumed. A run that picked one silently would measure something
// nobody asked for and report it under the other one's name.
//
// `--requests-only` WAS DELETED HERE and must not come back (Law 14 — the wrong turn, named). It cut at
// this same seam for the same reason (the questions ahead of the request set cost twenty minutes of
// world time per iteration), but it cut by SUBJECT while still raising the whole fleet, so it paid the
// startup and the latency it was trying to avoid and left the controls out of the run. The phase split
// cuts by WHAT CAN ANSWER THE QUESTION instead, which removes the cost at its source and keeps every
// control inside the phase that can honour it. Two flags selecting overlapping subsets of one sweep is
// a redundant route (Law 16); this is its one replacement.
const PHASE_ARG = process.argv.find(a => a.startsWith('--phase='));
const PHASE = PHASE_ARG ? parseInt(PHASE_ARG.slice('--phase='.length), 10) : null;
if (PHASE !== 1 && PHASE !== 2) {
  console.error([
    'foreman_probe: --phase=1 (the desk, no fleet) or --phase=2 (the fleet, run to completion) is required.',
    '  --phase=1  every question answerable from what the desk said or put on the wire. Seconds, no fleet.',
    '  --phase=2  only the questions a body can answer, then a watch that ends when the requests are filled.',
  ].join(String.fromCharCode(10)));
  process.exit(1);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

function runFleetControl(args) {
  return new Promise((resolve) => {
    let out = '';
    const c = spawn(process.execPath, [path.join(BOT_DIR, 'fleet_control.js'), ...args], {
      cwd: BOT_DIR, env: CHILD_ENV, windowsHide: true,
    });
    c.stdout.on('data', d => { out += d.toString(); });
    c.stderr.on('data', d => { out += d.toString(); });
    c.on('close', code => resolve({ code, out }));
    c.on('error', e => resolve({ code: -1, out: String(e.message) }));
  });
}

// When this probe started. Anything on disk stamped older than this belongs to a previous run and is a
// memory, not an observation — see the siting check in V15 for the run that taught this file the
// difference.
const RUN_STARTED_AT = Date.now();

const findings = [];
function record(id, question, observed, verdict) {
  findings.push({ id, question, observed, verdict });
  console.log(`\n[${id}] ${question}`);
  console.log(`   observed: ${observed}`);
  console.log(`   verdict : ${verdict}`);
}

const FINDINGS_FILE = path.resolve(BOT_DIR, 'fleet_logs', 'foreman_probe_findings.json');
function writeFindings(extra = {}) {
  fs.mkdirSync(path.dirname(FINDINGS_FILE), { recursive: true });
  fs.writeFileSync(FINDINGS_FILE, JSON.stringify({ version: VERSION, findings, ...extra }, null, 2));
  console.log(`findings written to ${FINDINGS_FILE}`);
}

// THE PROBE'S OWN CLIENTS ARE MINEFLAYER CLIENTS, AND A PACKET IT DID NOT ASK FOR CAN KILL THE PROCESS.
// A creeper detonating near a probe player raised a TypeError inside the physics plugin's explosion
// handler, three libraries down, on a packet the probe never touches — and the run died mid-question
// with twenty verdicts already measured and none of them written anywhere (Law 25: a run that reports
// nothing about what it had established is indistinguishable from a run that established nothing).
//
// THIS IS A TERMINUS, NOT A RESUMPTION. The library's state after a throw it did not expect is not
// something this file may reason about, so the run does not continue: it records what killed it as a
// finding, writes everything it had, and exits. The legal catch is the boundary translator (Law 16) —
// what it must never become is a swallow that lets the questions carry on against a broken client.
//
// A TERMINUS IS STILL A TEARDOWN (Law 8). The crew and the clerk this run raised are separate OS
// processes and are not this one's children — the clerk shells out to the launcher, so the bots are
// grandchildren and nothing about this process dying reaches them. Exiting on the fault path without
// the sweep left two bots holding roster names in a world nobody was driving, and the next run's `get`
// then landed on the slot they were sitting in. What a run raises it takes down on EVERY path out, and
// the sweep is the launcher's own `verb exit` rather than a kill: the same route the successful path
// uses, so there is one teardown and not a second one that only the crash reaches (Law 16).
let RAISED = { foreman: null, overseer: false, crew: false };
let dying = false;
async function dieHonestly(kind, err) {
  if (dying) return;   // a second fault while the first is being written must not restart the record
  dying = true;
  const detail = err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err);
  record('PROBE', `Did the probe's own instrument survive the run? (${kind})`, detail,
    'NO — the probe process was killed by a fault inside a third-party client library, not by anything '
    + 'the fleet did. Every verdict above was measured before this and stands; every question after it '
    + 'was never asked. Re-run to reach them.');
  // WRITTEN BEFORE THE SWEEP, because the sweep can hang and the verdicts are the deliverable.
  writeFindings({ killedBy: { kind, detail } });
  if (RAISED.crew) {
    console.log('teardown: sweeping the crew this run raised...');
    const swept = await Promise.race([runFleetControl(['verb', 'exit']).then(() => true), sleep(20000).then(() => false)]);
    console.log(swept ? 'teardown: crew swept.' : 'teardown: the sweep did not answer in 20s — check for bots left in the world.');
  }
  if (RAISED.foreman) { RAISED.foreman.kill(); console.log('teardown: foreman taken down (this run raised it).'); }
  if (RAISED.overseer) { await runFleetControl(['down', '--keep-server']); }
  process.exit(1);
}
process.on('uncaughtException', e => dieHonestly('uncaughtException', e));
process.on('unhandledRejection', e => dieHonestly('unhandledRejection', e));

async function main() {
  const creds = rconLink.readServerProperties();
  const rcon = await rconLink.open(creds);
  const cmd = async c => (await rcon.command(c) || '').trim();
  console.log(`server: rcon up on ${creds.port}.`);

  // THE CLOCK IS HELD AT DAWN FOR THE WHOLE RUN, and this is a measurement property rather than a
  // convenience. Every question here is about what the DESK does, and none of them is about surviving
  // the night — but a run that crosses into darkness spawns hostiles around two idle player clients,
  // and one of them detonating killed a run outright inside a third-party physics handler with twenty
  // verdicts already measured. A tester whose answer depends on whether a creeper wandered past is not
  // measuring the thing it names (Law 19 — determinism is a faculty this side owns; spending it here is
  // free). `doDaylightCycle` is turned off as well as the time set, because a set alone drifts back into
  // night across a twenty-five minute run, which is exactly the length these questions take.
  await cmd('time set 0');
  await cmd('gamerule doDaylightCycle false');
  console.log('server: clock held at dawn, daylight cycle off — no hostiles for the length of the run.');

  // THE OVERSEER FIRST, because the door the command questions test is one of its listeners and a bot
  // that comes up without one never registers — every verb would then reach nobody for a reason that
  // has nothing to do with what is being measured. `overseer-start` reuses a live one, so a probe run
  // inside an existing session does not raise a second (Law 8: only what this raises is taken down).
  // PHASE 1 PUTS A STAND-IN WHERE THE OVERSEER'S IN-GAME DOOR WOULD BE and raises nothing else. The
  // desk is unchanged and cannot tell — it opens the same port and writes the same envelope — so what
  // this phase measures is the production desk, not a desk that knows it is being watched.
  //
  // IT REFUSES TO RUN BESIDE A LIVE OVERSEER rather than binding a second door or quietly reusing the
  // real one. Both silent options are worse than stopping: binding fails on a port already held, and
  // reusing means phase 1 commands a live fleet while reporting that nothing was executed — a false
  // statement about the world made by the instrument built to catch exactly that (Law 25, Law 13).
  let standin = null;
  let overseerWasUp = false;
  if (PHASE === 1) {
    if (await portOpen(3001)) {
      console.error('phase 1 needs the overseer DOWN — its in-game door is the seam this phase stands in for.');
      console.error('Something is serving 3001. Take the fleet down, or run --phase=2 against it.');
      rcon.close(); process.exit(1);
    }
    standin = require('./foreman_door_standin').start({ overseerPort: 3001 });
    console.log(`phase 1: stand-in door up on ${standin.port} — no overseer, no bots behind it.`);
  } else {
    overseerWasUp = await portOpen(3001);
    if (!overseerWasUp) {
      await runFleetControl(['overseer-start']);
      for (let i = 0; i < 20 && !(await portOpen(3001)); i++) await sleep(1000);
    }
    RAISED.overseer = !overseerWasUp;
    const overseerUp = await portOpen(3001);
    console.log(`overseer: ${overseerUp ? (overseerWasUp ? 'already up — reused.' : 'raised by this probe.') : 'DID NOT COME UP.'}`);
    if (!overseerUp) { rcon.close(); process.exit(1); }
  }

  // THE FOREMAN IS REUSED IF ONE IS ALREADY STANDING, exactly as the overseer above is, and for a
  // reason that is not only tidiness: a foreman holds a PLAYER SLOT under a fixed name, so a second one
  // logs the first out and the probe would then be measuring the clerk it just displaced. Reusing also
  // makes this instrument runnable INSIDE the bench the Architect actually works in — the contractor
  // run raises a foreman and hands him the terminal, and a tester that could only run on an empty
  // server could never be pointed at the thing he is using.
  //
  // WHAT IS LOST BY REUSING is the clerk's console, which belongs to its own window: a foreman this
  // probe did not spawn cannot have its output read. The one question that used it says so and reads
  // the fleet's own registry instead (V4), rather than reporting a weaker answer as the same answer.
  const foremanWasUp = (await cmd('list')).includes(FOREMAN_NAME);
  const foremanLog = [];
  let foreman = null;
  if (!foremanWasUp) {
    foreman = spawn(process.execPath, [path.join(BOT_DIR, 'foreman', 'foreman.js')], {
      cwd: BOT_DIR, env: CHILD_ENV, windowsHide: true,
    });
    foreman.stdout.on('data', d => foremanLog.push(d.toString()));
    foreman.stderr.on('data', d => foremanLog.push(d.toString()));
  }
  const foremanSaid = () => foremanLog.join('');

  if (foreman) {
    for (let i = 0; i < 30 && !/standing by/.test(foremanSaid()); i++) await sleep(1000);
    if (!/standing by/.test(foremanSaid())) {
      console.error('FOREMAN NEVER CAME UP:\n' + foremanSaid());
      foreman.kill(); rcon.close(); process.exit(1);
    }
    RAISED.foreman = foreman;
    console.log('foreman: raised by this probe.');
  } else {
    console.log('foreman: already in the world — reused, and left standing at the end.');
  }

  // TWO HUMANS, because the ownership questions cannot be asked with one. A single player can only
  // demonstrate that commands work; whether they are CONFINED needs a second person who did not ask
  // for the bot, standing in the same world, saying the same words.
  async function joinHuman(name) {
    const b = mineflayer.createBot({ host: 'localhost', port: 25565, username: name, version: VERSION, auth: 'offline' });
    b.on('error', e => console.log(`${name} ERROR:`, e.message));
    const heard = [];
    b.on('messagestr', s => heard.push({ text: s, at: Date.now() }));
    await new Promise(res => b.once('spawn', res));
    await sleep(2500);
    console.log(`human: ${name} spawned.`);
    // The foreman names the person it is answering, which is what lets two humans share one channel and
    // still read only their own replies. A test that matched any `<Foreman>` line would credit player A
    // with an answer given to player B — the exact confusion these questions exist to detect.
    const answersTo = lines => lines.filter(l => l.startsWith('<Foreman>') && l.includes(`${name}:`));

    // ── THE WINDOW IS A CAP, NOT A TARGET (Architect 2026-08-31) ──────────────────────────────────
    //   "shorten the wait time for responses to go through. or make a way that fires when theres a return"
    //
    // Every utterance used to sleep its whole window whether or not the desk had already finished
    // answering. Measured on the last live run: 47 utterances, 552 seconds of fixed waiting, and roughly
    // nine of the fifteen minutes spent after the answer was already on screen. The repeats were never
    // the cost — most of them ask a different question at a different moment — the FIXED SLEEP was.
    //
    // WHY IT WAITS FOR QUIET RATHER THAN FOR THE FIRST LINE. An answer is not one message: the desk
    // paces itself at about a line a second so the server cannot kick it for spam, and `help` is eight
    // lines. Returning on the first line would cut every multi-line answer in half and leave its tail to
    // arrive inside the NEXT question's window — which is worse than waiting, because a question would
    // then be scored against the previous one's overflow. So it returns once the desk has spoken AND
    // stopped: the quiet period is longer than the pacing interval, which is what makes "stopped"
    // distinguishable from "between lines".
    //
    // A QUESTION EXPECTING SILENCE STILL PAYS THE FULL WINDOW, and that falls out rather than being
    // special-cased: nothing addressed ever arrives, so there is no quiet to detect and the cap expires.
    // That is exactly right — the controls (V2, V5) are the questions that must never be shortened,
    // because for them the passage of time IS the measurement (Law 25: shortening a silence check would
    // report a pass the run had not earned).
    const QUIET_MS = 1500;   // > the desk's ~1 line/sec pacing, so a gap between lines never reads as the end
    const POLL_MS = 100;
    const settle = async (from, capMs) => {
      const deadline = Date.now() + capMs;
      let seen = 0;
      let lastArrival = Date.now();
      while (Date.now() < deadline) {
        const n = answersTo(heard.slice(from).map(h => h.text)).length;
        if (n !== seen) { seen = n; lastArrival = Date.now(); }
        if (seen > 0 && Date.now() - lastArrival >= QUIET_MS) return;
        await sleep(POLL_MS);
      }
    };

    // Say one thing, return everything the world said back to THIS player.
    const say = async (line, capMs = 6000) => {
      const n = heard.length;
      b.chat(line);
      await settle(n, capMs);
      return heard.slice(n).map(h => h.text);
    };
    return { bot: b, say, answersTo };
  }

  const a = await joinHuman(HUMAN);
  const b = await joinHuman(HUMAN_B);
  const human = a.bot;
  const say = a.say;
  const answersTo = a.answersTo;
  // Everything the world said, regardless of who it was addressed to — for the console control, which
  // is about a line NOBODY should receive.
  const heard = [];
  human.on('messagestr', s => heard.push({ text: s, at: Date.now() }));

  // ── V1 — does it answer at all? ────────────────────────────────────────────────────────────────
  // LONG ENOUGH FOR THE WHOLE HELP TO DRAIN, which is a window sized by the channel's pace rather than
  // by taste: the clerk emits one line per second so it cannot be kicked for spam, and a window that
  // closes mid-answer would leave the tail of this reply arriving inside V2's silence check — scoring
  // the foreman as answering an unaddressed remark it never heard.
  const v1 = await say('foreman help', 16000);
  record('V1', 'Does the foreman answer a human speaking in open chat?',
    `world said: ${JSON.stringify(v1)}`,
    answersTo(v1).length > 0
      ? 'YES — the foreman heard a player, resolved their name, and answered them by name.'
      : 'NO — nothing came back. The foreman is deaf on this channel; nothing downstream can work.');

  // ── V2 — does it ignore ordinary conversation? ─────────────────────────────────────────────────
  const v2 = await say('just talking to myself about cobblestone', 4000);
  record('V2', 'Does the foreman stay silent on chat that is NOT addressed to it?',
    `world said: ${JSON.stringify(v2)}`,
    answersTo(v2).length === 0
      ? 'YES — unaddressed conversation passes without comment, so the foreman is not noise in a recording.'
      : 'NO — it answered a line that was not addressed to it. Every remark in the world would become a command attempt.');

  // ── V3 — does it report the roster honestly? ───────────────────────────────────────────────────
  // "IT ANSWERED" IS NOT A VERDICT, and this question used to stop there. A foreman whose door was
  // broken answered every `list` with the text of a Law 13 throw — a reply, addressed by name, that
  // told the probe nothing was working and was scored as a pass anyway. That is the fault this whole
  // instrument exists to catch, committed by the instrument (Law 25). An answer that carries a
  // violation, a stack, or "that failed" is now the failure it reports itself to be.
  const v3 = await say('foreman list');
  const v3line = answersTo(v3).join(' ');
  const v3broke = /CODING VIOLATION|that failed|couldn't reach the fleet|can't reach the fleet/i.test(v3line);
  record('V3', 'Does `foreman list` report what is actually running?',
    `world said: ${JSON.stringify(v3)}`,
    !v3line
      ? 'NO ANSWER — the clerk said nothing about who is in the world.'
      : v3broke
        ? `NO — the clerk answered with a failure, not a roster: "${v3line.slice(0, 200)}". Every verb that has to reach the fleet travels the same door, so nothing below this line can work either.`
        : `ANSWERED — it reported the roster: "${v3line.slice(0, 200)}"`);

  // ── V4 — the real job: get a crew, and is it CONTRACTOR? ──────────────────────────────────────
  // TWO WITNESSES TO THE SPECIES, and which one is available depends on who raised the clerk. The
  // LAUNCHER's own line in the foreman's console is the party that stamped it, so it is preferred; a
  // reused foreman writes that line into a window this process does not own, and the fallback is the
  // OVERSEER'S REGISTRY — the mode each bot declared when it registered, which is the same fact the
  // ownership filter runs on. Neither is inferred from the bot merely being present (Law 25), and the
  // verdict says which witness answered rather than flattening the two into one claim.
  // ── PHASE 2 OPENS HERE. `get` is the one verb that starts an OS PROCESS rather than crossing the door
  // (fleet_control owns every launch — see the foreman's header), so it is the one verb a stand-in
  // cannot stand in for: there is no socket to intercept. That makes it a fleet question by
  // construction. What phase 1 can still ask about `get` is every refusal that stops it BEFORE a
  // process is spawned — the cap, a malformed line, a speaker with no bots — and those are asked there,
  // where no body is needed to answer them.
  let ownerCrew = async () => [];
  // HOISTED OUT OF THE PHASE-2 BLOCK 2026-09-10. This was declared `const` inside `if (PHASE === 2)`
  // below, and V9 reads it from the sibling `else` block further down — a different scope, so that
  // read was an unbound identifier that would throw a ReferenceError the moment V9 ran. It loaded
  // clean and no gate saw it until `preflight`'s reference scan was widened to cover the workshop
  // the same day. `[]` rather than undefined so a phase that never fills it reads as "no contractors
  // registered", which is the true state, instead of throwing one level further on (Law 13).
  let registeredContractors = [];
  if (PHASE === 2) {
  RAISED.crew = true;   // set BEFORE the words are said: a crash mid-fetch still leaves bots to sweep
  const v4 = await say('foreman get', 20000);
  await sleep(6000);
  const players = await cmd('list');
  const stampedContractor = /starting as CONTRACTOR/i.test(foremanSaid());
  // THE PROBE'S OWN DOOR CALL IS A BOUNDARY AND IS TREATED AS ONE. `query` resolves its socket failures
  // into an answer, but a missing package throws before the socket exists — and an instrument that dies
  // on its second question reports nothing about the twenty-odd after it. A failed look is an
  // observation here, never the end of the run (Law 16: a terminus that names what it caught).
  // ASKED OF THE OVERSEER, AND ASKED AGAIN, because registration is a second event after joining and the
  // two are seconds apart — a single look taken at the wrong moment reports a healthy bot as missing.
  // What it must NOT do is give up and call the first answer the truth (Invariant B: re-sense).
  ownerCrew = async function (attempts = 6) {
    for (let i = 0; i < attempts; i++) {
      let r = { ok: false, bots: [] };
      try { r = await door.query(); } catch (e) { r = { ok: false, bots: [], error: String(e.message || e) }; }
      const mine = r.ok ? r.bots.filter(bt => bt.mode === 'contractor' && bt.owner === HUMAN).map(bt => bt.id) : [];
      if (mine.length >= CREW_SIZE || i === attempts - 1) return mine;
      await sleep(5000);
    }
    return [];
  };
  registeredContractors = await ownerCrew();
  // A NAME IN THE WORLD THAT NEVER REGISTERED IS THE ZOMBIE THIS QUESTION EXISTS TO CATCH, and it is the
  // reason "at least one arrived" is not an answer. A bot can hold a player slot, appear in the server's
  // own list, and never have come up at all: the process is alive, it never emitted spawn, it never
  // registered, and no operator verb can reach it — `exit` is delivered through the registry it is not
  // in. Scoring the crew on any single member passes that run green while half the crew is a corpse
  // holding a name nobody else can be given (Law 25).
  const worldList = players.toLowerCase();
  const inWorldNotRegistered = Object.keys(BOT_SENIORITY)
    .filter(id => worldList.includes(id.toLowerCase()) && !registeredContractors.includes(id));
  record('V4', `Does \`foreman get\` fetch a WHOLE crew of ${CREW_SIZE}, every one of them a live CONTRACTOR?`,
    `world said: ${JSON.stringify(v4)} | launcher stamp in the foreman window: ${foreman ? stampedContractor : 'n/a (reused foreman — its console is its own window)'} `
    + `| registered with the overseer as ${HUMAN}'s contractors: ${JSON.stringify(registeredContractors)} `
    + `| in the world but NOT registered: ${JSON.stringify(inWorldNotRegistered)} | server player list: ${players}`,
    registeredContractors.length >= CREW_SIZE && inWorldNotRegistered.length === 0
      ? `YES — all ${CREW_SIZE} came up, and the overseer holds every one of them as this player's CONTRACTOR. Every bot the foreman gets is a contractor by construction; there is no other spawn path in it.`
      : inWorldNotRegistered.length
        ? `NO — ${JSON.stringify(inWorldNotRegistered)} holds a player slot and never registered. That is a bot that JOINED and never came up: its process is alive, it emitted no spawn, and no operator verb can reach it because delivery runs off the registry it is not in — so it cannot be exited, and its name cannot be handed to anyone else (Law 8). The usual cause is a login onto a corpse: a player whose last life ended dead never receives spawn, and \`tools/fleet_revive.js\` is the one thing that can repair it, from outside the process the corpse prevents from starting.`
        : `NO — only ${registeredContractors.length} of ${CREW_SIZE} registered and nothing else is holding a name. The crew is short, and a half crew cannot share the work a crew is defined by.`);

  // ── V4b — THE ONE VERB WHOSE CONSEQUENCE IS INVISIBLE FROM THE WORLD ─────────────────────────
  // `flush` is offered to a human with a warning that it deletes what the fleet knows, and until now
  // nothing checked that it does anything at all. Every other verb has a visible postcondition — a bot
  // arrives, a bot leaves — while this one's whole effect is a file emptying, so a flush that silently
  // did nothing would read as a success on every other question in this run (Law 25).
  //
  // IT ALSO PUTS THIS RUN ON COLD GROUND, and that is not a side effect to hide: the kernel files
  // survive a world rollback, so a crew fetched into a restored world can still be carrying a home
  // anchor from a world that no longer exists — which is a REMEMBERED fact about a world that moved
  // (Invariant B), and it silently satisfies the siting question below with last run's answer.
  const HQ_OF = id => path.join(BOT_DIR, 'js_kernel', `corporate_headquarters.${id}.json`);
  const hqSections = (id) => {
    if (!fs.existsSync(HQ_OF(id))) return null;
    try { return Object.keys(JSON.parse(fs.readFileSync(HQ_OF(id), 'utf8')) || {}); }
    catch (e) { return ['<unreadable: ' + String(e.message).slice(0, 40) + '>']; }
  };
  const crewIds = registeredContractors.length ? registeredContractors : Object.keys(BOT_SENIORITY).slice(0, CREW_SIZE);
  const beforeFlush = Object.fromEntries(crewIds.map(id => [id, hqSections(id)]));
  const v4b = await say('foreman flush', 12000);
  await sleep(12000);
  const afterFlush = Object.fromEntries(crewIds.map(id => [id, hqSections(id)]));
  const shrank = crewIds.filter(id => (beforeFlush[id] || []).length > (afterFlush[id] || []).length);
  const hadAnything = crewIds.some(id => (beforeFlush[id] || []).length > 0);
  record('V4b', 'Does `foreman flush` actually empty what the crew knows?',
    `world said: ${JSON.stringify(answersTo(v4b).join(' ').slice(0, 160))} | HQ sections before: ${JSON.stringify(beforeFlush)} | after: ${JSON.stringify(afterFlush)}`,
    !hadAnything
      ? 'INCONCLUSIVE — the crew held nothing to forget, so an empty flush and a broken one look the same. Nothing below is qualified by this; the run simply started cold already.'
      : shrank.length === crewIds.length
        ? `YES — every crew member's kernel file lost sections it was carrying. The verb the help prices as a memory wipe is one, and this run stands on ground the crew has never seen.`
        : `NO — ${crewIds.length - shrank.length} of ${crewIds.length} crew member(s) kept everything they knew. A human told their bots would forget the base has been told something untrue, and every question below this line is being asked of a crew carrying a previous run's memory.`);

  } else {
    console.log('phase 1: V4/V4b fetch and flush a real crew — skipped. Nothing is spawned.');
  }

  // ── V5 — THE CONTROL. A console /say must NOT be able to command the foreman. ────────────────────
  // Chat probe C4: a console announcement raises the same `chat` event a player does. If the foreman
  // answers this, its authentication is decorative and anything reaching the console owns the fleet.
  const n5 = heard.length;
  await cmd('say foreman help');
  await sleep(6000);
  const v5 = heard.slice(n5).map(h => h.text);
  const foremanAnswered = v5.some(l => l.startsWith('<Foreman>'));
  record('V5', 'CONTROL — can a CONSOLE /say command the foreman? (it must not)',
    `world said: ${JSON.stringify(v5)} | foreman replied: ${foremanAnswered}`,
    !foremanAnswered
      ? 'CONTROL HOLDS — the console said the exact words that work from a player and the foreman did not move. It authenticates on the WIRE (player_chat vs profileless_chat), not on the chat event or the sender name.'
      : 'CONTROL FAILS — the foreman obeyed the CONSOLE. Its authentication is decorative: anything able to reach the server console can command the fleet. V1-V4 above prove nothing until this is fixed.');

  // ═══ THE COMMAND SYSTEM ═══════════════════════════════════════════════════════════════════════
  // WHO IS IN THE WORLD IS ASKED OF THE SERVER, never of the foreman. `list` is the server's own answer
  // about its own player slots, so a bot that left has left whatever any component says about it. The
  // foreman's reply is recorded too, but as a SECOND observation to be compared — the point of holding
  // both is that they can disagree, and a probe where they cannot is measuring one of them twice.
  const inWorld = async (name) => (await cmd('list')).toLowerCase().includes(name.toLowerCase());

  // EVERY QUESTION FROM HERE ON NEEDS THE CLERK ALIVE TO ANSWER IT, and a dead clerk answers nothing —
  // which from outside is indistinguishable from a fleet that refused. This probe's first run scored
  // seven confident verdicts off a foreman the server had already kicked, including "one person can take
  // the whole roster", measured against a clerk that never heard the question. That is the probe
  // committing Law 25's fault about the thing it was built to check for it. A verdict that depends on
  // a reply is now VOID unless the clerk still holds its player slot when the answer was due.
  const clerkAlive = async () => (await cmd('list')).includes(FOREMAN_NAME);
  async function recordAnswered(id, question, observed, verdict) {
    if (await clerkAlive()) { record(id, question, observed, verdict); return; }
    record(id, question, `${observed} | THE FOREMAN IS NO LONGER IN THE WORLD`,
      'VOID — the clerk had left the server before this question could be answered, so the silence here is '
      + 'the probe listening to nobody. Read the foreman window in the findings file for why it left. Every '
      + 'question from that point on is void, not failed — nothing about the fleet was measured.');
  }

  // ── V6-V15: THE COMMAND SYSTEM AND THE TWO ENDS OF A CONTRACTOR'S LIFE ──────────────────────
  // FLEET QUESTIONS, EVERY ONE. What they measure is which bots a verb REACHED — the ownership filter,
  // the species filter, the terminal override, where a body stands when it is fetched and when it dies.
  // All of that is decided inside the overseer and inside a body, so phase 1 has nothing to observe:
  // its stand-in deliberately implements no ownership filter, and a phase that scored these against an
  // authored one would be grading a copy of the rule living inside the instrument (Law 16, Law 25).
  //
  // NOTHING IS STARTED IN THEIR PLACE. The old flag that skipped this block started the crew anyway,
  // because the questions after it needed one; here the questions after it are the desk's and need no
  // body at all, so a skipped question takes no precondition with it.
  if (PHASE === 1) {
    console.log('phase 1: V6-V15 are fleet questions — skipped. No crew is fetched; nothing is started.');
  } else {

  // ── V6 — does the help offer EVERY verb, and does it price the expensive one? ──────────────────
  // The verb set is read from the fleet, so this question cannot go stale: a verb added tomorrow and
  // never described fails here rather than passing quietly. The flush clause is checked separately
  // because it is the one word whose consequence a person cannot infer from its name — help that lists
  // it without saying it deletes what the fleet knows is a criterion the asker was never given (Law 25).
  const v6 = await say('foreman help', 16000);
  const helpText = answersTo(v6).join(' ').toLowerCase();
  const missing = [...OPERATOR_VERBS].filter(v => !helpText.includes(v));
  const flushPriced = /wipes their memory/i.test(helpText) && /forget/i.test(helpText);
  await recordAnswered('V6', 'Does `foreman help` offer every verb the fleet knows, and say what flush costs?',
    `verbs the fleet knows: ${[...OPERATOR_VERBS].join(', ')} | missing from the help: ${missing.length ? missing.join(', ') : 'none'} | flush warning present: ${flushPriced} | world said: ${JSON.stringify(v6)}`,
    missing.length === 0 && flushPriced
      ? 'YES — every verb the fleet accepts is offered in the world, and flush is named as a memory wipe before anyone can say it.'
      : missing.length
        ? `NO — the fleet accepts ${missing.join(', ')} and the help never mentions it. A human cannot ask for what they were not offered.`
        : 'PARTIAL — every verb is listed, but flush is not priced. It reads like tidying up and it deletes the base map.');

  // ── V7 — an unaddressed verb reaches the asker's bots ─────────────────────────────────────────
  // No bot is named, and that is the ruling being tested rather than a convenience: one word, all of
  // the speaker's bots. A "no bots" answer here would be a live door reporting a fleet it cannot see,
  // which is a different fault from a door that is not listening — so it is asked while a bot is up.
  const v7 = await say('foreman start', 9000);
  const v7line = answersTo(v7).join(' ');
  await recordAnswered('V7', 'Does a bare `foreman start` reach the speaker\'s bots through the in-game door?',
    `world said: ${JSON.stringify(v7)}`,
    /sent to your \d+ bot/i.test(v7line)
      ? 'DELIVERED — one unaddressed word crossed the in-game door and the overseer reported how many of the SPEAKER\'S bots it reached. This is DELIVERY, not proof the bot began planning: nothing observable from outside the process says that, and the foreman\'s wording does not claim it.'
      : `NOT DELIVERED — ${v7line || 'no answer'}. Either the door is not listening, the bot never registered with the overseer, or the ownership filter matched nobody.`);

  // ── V8 — THE OWNERSHIP CONTROL. A second person must not command the first person's bot. ──────
  // THIS IS THE ONE THAT MAKES V7 MEAN ANYTHING. A door that delivers to everybody delivers to the
  // owner too, so V7 scores identically whether the filter exists or not. HUMAN_B says the exact words
  // HUMAN_A just said, in the same channel, in the same second — the runs differ in exactly one
  // property, who spoke, so anything that changes is caused by it. Graded on the SERVER'S player list
  // as well as the reply, because a refusal that is only wording is not a refusal.
  const beforeB = await inWorld(CONTRACTOR_NAME);
  const v8 = await b.say('foreman exit', 12000);
  await sleep(5000);
  const survivedB = await inWorld(CONTRACTOR_NAME);
  const v8line = b.answersTo(v8).join(' ');
  await recordAnswered('V8', `CONTROL — can ${HUMAN_B} exit a bot that belongs to ${HUMAN}? (they must not)`,
    `A's bot present before: ${beforeB} | B was told: ${JSON.stringify(v8line)} | present after: ${survivedB} | server list: ${await cmd('list')}`,
    !beforeB
      ? 'INCONCLUSIVE — A had no bot in the world, so there was nothing for B to take. The control never ran.'
      : !survivedB
        ? 'CONTROL FAILS — a second player spoke and another person\'s bot left the world. Ownership is decorative: anyone in the world commands everyone\'s bots, and V7 above is a demonstration of that rather than of a working command system.'
        : /none of those are yours|no bots out/i.test(v8line)
          ? `CONTROL HOLDS — B said the identical words and was refused by ownership ("${v8line.slice(0, 120)}"). A's bot is still in the world. The filter is the overseer's delivery set, read off the owner each bot declared at birth — not anything the foreman decides.`
          : `PARTIAL — B's command did not touch A's bot, but the refusal did not name ownership ("${v8line.slice(0, 120)}"). The bot is safe for a reason this probe cannot identify.`);

  // ── V9 — the owner's own exit, graded on the SERVER'S player list ─────────────────────────────
  // ASKED OF THE WHOLE CREW, because the verb's own promise is "all of your bots and nothing else". A
  // check on one name passes a run where one of two left, which is the shape a half-delivered fan-out
  // takes — and the surviving half then holds a roster name nobody can be given (Law 25: the reply says
  // how many it reached, and the question is whether that many actually went).
  const crewBefore = [];
  for (const id of registeredContractors) if (await inWorld(id)) crewBefore.push(id);
  const v9 = await say('foreman exit', 12000);
  await sleep(6000);
  const crewStill = [];
  for (const id of crewBefore) if (await inWorld(id)) crewStill.push(id);
  await recordAnswered('V9', "Does `foreman exit` from the OWNER remove EVERY one of their bots from the world?",
    `the owner's crew in the world before: ${JSON.stringify(crewBefore)} | world said: ${JSON.stringify(v9)} | still there after: ${JSON.stringify(crewStill)} | server list: ${await cmd('list')}`,
    crewBefore.length && crewStill.length === 0
      ? `YES — the owner spoke one unaddressed word and all ${crewBefore.length} of their bots left the server. The postcondition is the SERVER'S player list, so this is the verb working rather than the foreman reporting. Paired with V8 it is the whole claim: the same sentence works for the owner and is refused for everyone else.`
      : crewBefore.length
        ? `NO — ${JSON.stringify(crewStill)} was in the world before the command and is still there after it. The word reached some of the crew and not all of it, whatever the foreman replied.`
        : 'INCONCLUSIVE — none of the owner\'s crew was in the world to begin with, so nothing was tested. Check V4 and V8.');

  // ── V10 — a verb from somebody who has no bots ────────────────────────────────────────────────
  // The failure this catches is a cheerful lie: a door that answers "done" when it reached nobody is
  // worse than one that refuses, because nothing downstream can tell the two apart (Law 25).
  const v10 = await say('foreman exit', 9000);
  const v10line = answersTo(v10).join(' ');
  await recordAnswered('V10', 'Does a verb from a human with NO bots out report that, rather than claiming success?',
    `world said: ${JSON.stringify(v10)}`,
    /sent to your [1-9]/i.test(v10line)
      ? 'NO — it claimed delivery when the speaker had nothing out. Every success this system reports is now worthless, because it reports one either way.'
      : v10line
        ? `HONEST — it refused and named the cause: "${v10line.slice(0, 140)}"`
        : 'NO ANSWER — silence is the one reply a human cannot act on.');

  // ── V11 — the two-bot cap, and that it takes two separate asks ────────────────────────────────
  // The cap is read from the fleet's own table, so this question measures the rule rather than a number
  // typed twice. Each `get` is a separate sentence by design — one word must never produce a crowd.
  const capReplies = [];
  for (let i = 0; i < CREW_SIZE + 1; i++) {
    capReplies.push(answersTo(await say('foreman get', 22000)).join(' '));
    await sleep(4000);
  }
  const listAfterCap = (await cmd('list')).toLowerCase();
  const mineOut = ROSTER_LOWER.filter(n => listAfterCap.includes(n)).length;
  const lastRefused = /that's the limit|already have/i.test(capReplies[capReplies.length - 1]);
  await recordAnswered('V11', `Does one human get at most ${CREW_SIZE} bots, one \`get\` at a time?`,
    `${CREW_SIZE + 1} gets said | replies: ${JSON.stringify(capReplies.map(r => r.slice(0, 90)))} | roster names in the world after: ${mineOut} | server list: ${listAfterCap}`,
    lastRefused && mineOut <= CREW_SIZE
      ? `YES — ask number ${CREW_SIZE + 1} was refused naming the limit, and no more than ${CREW_SIZE} roster names are in the world. The count is asked of the live fleet each time, so a bot that LEAVES frees its slot — a bot that merely dies does not, because it is still connected and is coming back.`
      : !lastRefused
        ? `NO — \`get\` number ${CREW_SIZE + 1} was not refused ("${capReplies[capReplies.length - 1].slice(0, 120)}"). One person can take the whole roster.`
        : `PARTIAL — the cap answer was right but ${mineOut} roster names are in the world. Something is spawning bots the cap does not count (a homesteader from the terminal would do this legitimately — check the list).`);

  // ── V12 — THE SPECIES CONTROL. A homesteader must be deaf to a human in the world. ────────────
  // Started from the TERMINAL, which is the only thing that stamps a homesteader, then commanded from
  // inside the world with the identical verb that just worked on a contractor. The two runs differ in
  // exactly one property — the species — so anything that happens here is caused by it.
  //
  // THE SPEAKER'S OWN BOTS ARE SENT HOME FIRST, so the homesteader is the only thing the verb could
  // possibly reach. With contractors of their own still out, the same sentence would be answered "sent
  // to your 2 bots" and the homesteader's survival would prove only that the fleet reached the bots it
  // reached — a true sentence about the wrong question.
  await say('foreman exit', 12000);
  await sleep(6000);

  // THE REFUSAL MUST NAME THE SPECIES, AND NOTHING ELSE COUNTS AS THE CONTROL HOLDING. A bot that is in
  // the world has not necessarily registered with the overseer yet, and an unregistered bot is refused
  // as "nobody is out" — which looks identical from outside to being refused for what it IS. Reading
  // that as a pass would grade a startup race as a species test and report a guarantee nobody proved
  // (Law 25). So the probe retries until the fleet answers about the species, and says INCONCLUSIVE if
  // it never does. Retrying is safe here for the same reason the control exists: if the verb were ever
  // going to work on a homesteader, the retry is another chance for it to, and the bot leaving is
  // checked every pass.
  await runFleetControl(['bot-start', HOMESTEADER_NAME]);
  for (let i = 0; i < 25 && !(await inWorld(HOMESTEADER_NAME)); i++) await sleep(1000);
  const homesteaderPresent = await inWorld(HOMESTEADER_NAME);

  const SPECIES_REFUSAL = /answers? to nobody|takes no orders/i;
  const NOT_REGISTERED = /no bots are up|you have no bots out/i;
  let v12 = [], v12line = '', v12why = 'never_answered';
  for (let i = 0; i < 8 && homesteaderPresent; i++) {
    v12 = await say('foreman exit', 9000);
    v12line = answersTo(v12).join(' ');
    if (!(await inWorld(HOMESTEADER_NAME))) { v12why = 'bot_left'; break; }
    if (SPECIES_REFUSAL.test(v12line)) { v12why = 'refused_on_species'; break; }
    if (NOT_REGISTERED.test(v12line)) { v12why = 'not_registered_yet'; await sleep(4000); continue; }
    v12why = 'unrecognised_answer';
    break;
  }
  const homesteaderStillThere = await inWorld(HOMESTEADER_NAME);
  await recordAnswered('V12', 'CONTROL — can a human in the world stop a HOMESTEADER? (it must not)',
    `homesteader present before: ${homesteaderPresent} | last answer: ${JSON.stringify(v12line)} | why: ${v12why} | present after: ${homesteaderStillThere} | server list: ${await cmd('list')}`,
    !homesteaderPresent
      ? 'INCONCLUSIVE — the homesteader never joined, so the control never ran. Nothing in V6-V11 is qualified by this run.'
      : v12why === 'bot_left' || !homesteaderStillThere
        ? 'CONTROL FAILS — a human standing in the world stopped a bot built to ignore humans. The two species are one, and V6-V11 above are a demonstration of that rather than of a working command system.'
        : v12why === 'refused_on_species'
          ? `CONTROL HOLDS — the same words that removed a contractor were refused ON THE SPECIES: "${v12line.slice(0, 140)}". The bot stayed. The separation is the in-game door's delivery set, not anything the bot itself refuses.`
          : `INCONCLUSIVE — the bot stayed, but the refusal never named the species (${v12why}: "${v12line.slice(0, 100)}"). A bot nobody could reach is refused as "no bots are up", which proves nothing about what it IS. The control did not run.`);

  // ── V13 — THE ARCHITECT'S OVERRIDE. The terminal reaches what the world cannot. ────────────────
  // Every question above is about a limit; this is the one about a limit NOT applying. The console has
  // no owner and no species filter — it is outside the ownership model rather than privileged within
  // it — so the identical verb that V12 just watched bounce must take the same bot down. Run here
  // rather than left to the teardown because a step that happens anyway proves nothing unless it is
  // measured: this reads the server's player list before and after, and the teardown that follows is
  // then only cleanup.
  const beforeOverride = await inWorld(HOMESTEADER_NAME);
  await runFleetControl(['verb', 'exit']);
  for (let i = 0; i < 20 && (await inWorld(HOMESTEADER_NAME)); i++) await sleep(1000);
  const afterOverride = await inWorld(HOMESTEADER_NAME);
  record('V13', 'OVERRIDE — does the TERMINAL reach a bot no human in the world could command?',
    `homesteader present before: ${beforeOverride} | present after terminal exit: ${afterOverride} | server list: ${await cmd('list')}`,
    !beforeOverride
      ? 'INCONCLUSIVE — nothing was standing to be overridden. See V12.'
      : !afterOverride
        ? 'YES — the same word V12 watched a human say and be refused took the bot down from the console. The two are separated by WHICH DOOR the words arrived through, which the overseer observes; the operator is outside the ownership model rather than a bigger owner inside it.'
        : 'NO — the console said exit and the bot stayed. The operator has lost the one route that always reaches every species, and there is now no way to stop a homesteader from outside its own process.');

  // ═══ WHERE A CONTRACTOR STANDS — AT BIRTH, AND AFTER DYING ════════════════════════════════════
  // Both are asked of the SERVER's own entity data, never of the bot. A body's opinion of where it is
  // is the one thing a teleport bug leaves intact, so grading either of these on anything the fleet
  // reports would be reading the defendant's own account (Law 26).
  //
  // A FRESH BOT for both, because everything above has been exited by now. The birth question has to be
  // asked before the bot is started — an idle contractor does not move, so the position measured is the
  // one the arrival put it at and nothing else.
  const v14 = await say('foreman get', 22000);
  await sleep(6000);
  // THE SUBJECT IS A BOT THAT ACTUALLY CAME UP, not a name this file decided in advance. A bot that
  // joined and never spawned holds its name and stands wherever the world dropped it forever, so
  // measuring it answers "did the fetch place the bot" with a fact about a process that never started —
  // a confident verdict about the wrong thing (Law 25). It is named as VOID here and diagnosed at V4.
  const crewNow = await ownerCrew(3);
  const SUBJECT = crewNow[0] || null;
  const humanAt = await rconLink.entityPos(HUMAN);
  const botAt = SUBJECT ? await rconLink.entityPos(SUBJECT) : null;
  const gap = humanAt && botAt
    ? Math.hypot(botAt.x - humanAt.x, botAt.y - humanAt.y, botAt.z - humanAt.z) : null;
  await recordAnswered('V14', `Does a fetched contractor arrive where ${HUMAN} is standing?`,
    `${HUMAN} at ${JSON.stringify(humanAt)} | subject: ${SUBJECT || 'none registered'} at ${JSON.stringify(botAt)} | gap: ${gap === null ? 'n/a' : gap.toFixed(1)}b | world said: ${JSON.stringify(v14)}`,
    !SUBJECT
      ? 'VOID — no bot of this player came up, so there is no arrival to measure. See V4: a name in the world that never registered is a bot that never started, and this question is about placement, not about starting.'
      : gap === null
      ? 'INCONCLUSIVE — the server has no position for one of them, so nothing was compared.'
      : gap <= 3
        ? `YES — the bot came up ${gap.toFixed(1)}b from its owner. A cell a living player occupies needs no safety scan: it has floor, headroom and no lava because somebody is standing in it, and mineflayer clients do not collide.`
        : `NO — the bot is ${gap.toFixed(1)}b away. It was left wherever the world spawned it, and there is no verb for a human to call it over.`);

  // ── V15 — the house is the home, built or not ─────────────────────────────────────────────────
  // The site lock is the fact being tested, not the structure: the bot is killed as soon as a
  // build_center exists, long before any wall does. If this ever starts needing a finished house it
  // fails here, which is the whole reason the kill is timed off the chair rather than off a scan.
  await say('foreman start', 8000);
  // THE LOCK MUST BE THIS RUN'S, AND THE FIRST VERSION OF THIS QUESTION DID NOT CHECK. The HQ file
  // survives between runs, so a house sited an hour ago satisfied the wait instantly and the kill landed
  // eight seconds into a bot's life — the probe read a REMEMBERED fact as a sensed one and then reported
  // a verdict about a recovery that never had a chance to happen (Invariant B, and Law 25 in the
  // instrument). `locked_at` is the timestamp the siter writes, so it is the one field that can tell this
  // run's lock from last run's.
  const HQ_FILE = path.join(BOT_DIR, 'js_kernel', `corporate_headquarters.${SUBJECT}.json`);
  const sitedCentre = () => {
    if (!fs.existsSync(HQ_FILE)) return null;
    // The room key carries an owner (`contractor_house|<owner>`), so the literal lookup that stood here
    // matched nothing. The probe drives ONE subject bot, so any locked contractor_house in its own HQ is
    // that bot's — matched by structure name with the owner half ignored.
    const rooms = JSON.parse(fs.readFileSync(HQ_FILE, 'utf8'))?.building_confrence_room || {};
    const roomKey = Object.keys(rooms).find(k => k === 'contractor_house' || k.startsWith('contractor_house|'));
    const spot = roomKey ? rooms[roomKey]?.set_buildspot : null;
    const c = spot?.build_center;
    if (!c || !Number.isFinite(c.x)) return null;
    const at = spot.locked_at ? Date.parse(spot.locked_at) : NaN;
    return Number.isFinite(at) && at >= RUN_STARTED_AT ? c : null;
  };
  let centre = null;
  for (let i = 0; i < 60 && !(centre = sitedCentre()); i++) await sleep(3000);

  let diedAt = null, cameBackAt = null, gapHome = null;
  if (centre) {
    diedAt = await rconLink.entityPos(SUBJECT);
    await cmd(`kill ${SUBJECT}`);
    // Long enough for the board to sweep, post the recovery job, click respawn and land the teleport.
    // The bot may be mid-fragment when it dies, and the gate that abandons the caller only fires at the
    // next iteration boundary (Law 4), so this waits on a loop rather than on one sweep.
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      cameBackAt = await rconLink.entityPos(SUBJECT);
      if (cameBackAt) {
        gapHome = Math.hypot(cameBackAt.x - centre.x, cameBackAt.y - (centre.y + 1), cameBackAt.z - centre.z);
        if (gapHome <= 3) break;
      }
    }
  }
  await recordAnswered('V15', 'After dying, does a contractor come back to its OWN sited house?',
    `sited centre: ${JSON.stringify(centre)} | died at: ${JSON.stringify(diedAt)} | came back at: ${JSON.stringify(cameBackAt)} | gap from home: ${gapHome === null ? 'n/a' : gapHome.toFixed(1)}b`,
    !centre
      ? 'INCONCLUSIVE — no contractor house was sited within the wait, so there was no home to come back to. Either the start never reached the bot or the siting scan found no spot; read the bot window.'
      : !cameBackAt
        ? 'NO — the bot never reappeared in the server\'s entity data after the kill. It did not respawn at all, which is a failure of ACT 1 rather than of the destination.'
        : gapHome <= 3
          ? `YES — killed at ${JSON.stringify(diedAt)}, back at its own sited house ${gapHome.toFixed(1)}b from the locked centre. Nothing is built there yet, so the SITE is what it came home to — which is the ruling.`
          : `NO — it respawned but landed ${gapHome.toFixed(1)}b from its house. Either the ladder chose another tier or the teleport did not take; the bot window carries death_manager's own verdict.`);

  // ── V15b — the corpse a person is handed ──────────────────────────────────────────────────────
  // THE CASE THAT HAD NO IMPLEMENTATION AT ALL, and the only one of the four a human meets directly.
  // A body killed and then LOGGED OUT leaves playerdata reading dead. The next login onto that file never
  // receives `spawn`, so master_core never initialises, so the bot never registers — and delivery runs
  // off the registry, so no operator verb can reach it. It survives `exit`. The person is left holding a
  // roster name that cannot be used and cannot be given back (Law 8: a lifecycle with no terminator).
  //
  // GRADED ON THE REGISTRY, NOT ON THE PLAYER LIST, and that distinction is the whole question. A zombie
  // IS in the world — it joined, it holds the slot, `list` shows it. What it never does is register. So a
  // check that asks "did a bot appear" passes on exactly the failure this is looking for.
  await say('foreman exit', 10000);
  await sleep(3000);
  const corpseSubject = SUBJECT;
  await cmd(`kill ${corpseSubject}`);      // kills the BODY; the process is already gone, so the file stays dead
  await sleep(2000);
  const beforeGet = await ownerCrew(1);
  const v15bReply = await say('foreman get', 25000);
  const afterGet = await ownerCrew(8);
  const worldNow = (await cmd('list')).toLowerCase();
  const holdsSlot = worldNow.includes(corpseSubject.toLowerCase());
  const registered = afterGet.includes(corpseSubject);
  await recordAnswered('V15b', 'Is a bot whose body is DEAD stood up by `foreman get`, or handed over as a zombie?',
    `registered before: ${JSON.stringify(beforeGet)} | desk said: ${JSON.stringify(v15bReply.join(' ').slice(0, 200))} `
    + `| in the world after: ${holdsSlot} | REGISTERED after: ${registered} (${JSON.stringify(afterGet)})`,
    registered
      ? 'YES — the launcher stood the body up before it launched a process onto it, and the bot registered. '
        + 'The check lives in the one launcher, so it covers every route a bot is born on rather than only '
        + 'the conductor\'s (Law 16), and it runs the same two acts a natural death runs (body_recovery).'
      : holdsSlot
        ? 'NO — A ZOMBIE. The name is in the world and not in the registry: it joined, never spawned, never '
          + 'registered, and no operator verb can reach it. This is the exact state the preflight exists to '
          + 'prevent, and it is now reproducible from a sentence a person says.'
        : 'NO — nothing came up at all. The launcher refused, which is the default-stopped outcome rather '
          + 'than the repair; read the foreman window for the refusal it printed.');

  // THE REPLACEMENT CREW HAS TO BE PUT BACK TO WORK, and forgetting it silently wrecked four later
  // questions rather than this one. This question exits the crew and fetches a new one; a fetched bot
  // does nothing until it is started, so the request block downstream — which needs a crew already out
  // AND ALREADY WORKING to measure anything — inherited two idle bodies and reported that the fleet never
  // measures its own requests. The instrument broke the precondition of the questions after it and then
  // scored them, which is the fault this whole file exists to catch (Law 25).
  await say('foreman start', 9000);
  }

  // ═══ THE REQUEST SYSTEM ═══════════════════════════════════════════════════════════════════════
  // ASKED WITH A CREW ALREADY OUT AND ALREADY WORKING, which is what the questions above leave behind
  // and what these need: a requirement is answered by whichever crew next measures its own needs, so a
  // ledger with nobody to read it can be tested for filing and never for arriving.

  // WHAT THE CREW ITSELF HOLDS, read off each bot's own kernel file. "Filed" from the desk is the desk's
  // account of a message it sent; this is the far end of that message, written by a different process
  // that had to receive a broadcast to write it. The two can disagree, and that is the only reason to
  // look — a desk relaying its own claim back is one component observed twice (Law 26).
  //
  // THE PARSE IS GUARDED AND RETRIED because a living bot rewrites these files while this reads them,
  // so a half-written document is an ordinary condition here rather than a fault. The miss is reported
  // in the observed text, never swallowed (Law 16 — a catch is a terminus that names what it caught).
  async function crewLedger(owner) {
    // ── WHICH WITNESS ANSWERS "WAS IT FILED" DEPENDS ON WHAT IS STANDING ────────────────────────────
    // FOUND BY THE FIRST PHASE-1 RUN, and it is the fault this whole instrument exists to catch,
    // committed by the instrument again. Phase 1 raises no bots, so there are no crew kernel files —
    // and every question graded on them read that absence as its own answer. Six reported NO or VOID
    // against a world where their subject cannot exist, and worse, every control phrased as "and
    // nothing was written to the crew" reported CONTROL HOLDS on evidence that was vacuously true.
    // A control that cannot fail is not a control (Law 25 — the verdict must be true against the
    // criteria the asker set, and "nothing reached a crew" is not a claim a crewless run may make).
    //
    // THE STAND-IN'S LEDGER IS A REAL POSTCONDITION, not a substitute for one. It is a separate process
    // from the desk running the fleet's OWN `request_ledger` rules, so a row's presence there is
    // evidence the desk's message crossed the door and the real rules accepted it — the desk is still
    // not grading its own paper (Law 26).
    //
    // WHAT PHASE 1 THEREFORE MAY NOT CLAIM, and the reason `measured` stays empty rather than being
    // filled with something plausible: a row in the ledger says the requirement was FILED. It says
    // nothing about whether it reached a BODY, and nothing at all about progress — only a crew holding
    // an owner key can measure that. Those two are phase-2 claims and the questions that make them
    // void themselves here rather than answering from the wrong witness.
    if (PHASE === 1) {
      const rows = [];
      for (const [key, row] of Object.entries(standin ? standin.rows : {})) {
        if (row && row.owner === owner) rows.push({ bot: '(stand-in ledger)', key, item: row.item, quantity: row.quantity });
      }
      return { rows, measured: [], unreadable: [], witness: 'stand-in ledger (filed, not delivered)' };
    }
    const rows = [], measured = [], unreadable = [];
    for (const id of Object.keys(BOT_SENIORITY)) {
      const file = path.join(BOT_DIR, 'js_kernel', `corporate_headquarters.${id}.json`);
      if (!fs.existsSync(file)) continue;
      let hq = null;
      for (let attempt = 0; attempt < 3 && hq === null; attempt++) {
        try { hq = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) { hq = null; await sleep(700); }
      }
      if (hq === null) { unreadable.push(id); continue; }
      const standing = (hq.requests_confrence_room && hq.requests_confrence_room.standing) || {};
      for (const [key, row] of Object.entries(standing)) {
        if (row && row.owner === owner) rows.push({ bot: id, key, item: row.item, quantity: row.quantity });
      }
      const chair = (hq.bot_boardroom && hq.bot_boardroom[id]) || null;
      if (chair && Array.isArray(chair.request_progress)) {
        for (const m of chair.request_progress) measured.push({ bot: id, ...m });
      }
    }
    return { rows, measured, unreadable, witness: 'crew kernel files' };
  }

  // A WAIT FOR A BROADCAST THAT ONLY EXISTS IN PHASE 2. These pauses let the overseer's requirement map
  // reach the crew's own files before a question reads them. With no crew, there is nothing in flight:
  // the stand-in's ledger holds the row the moment the door call returns, so the wait buys nothing and
  // was most of what remained of the run's length after the reply windows were fixed.
  const propagate = (ms) => (PHASE === 1 ? Promise.resolve() : sleep(ms));

  // WHAT A VERDICT MAY CALL THE THING IT READ. The fix above made these questions read the right witness;
  // this makes them SAY the right one. A phase-1 verdict reporting a row "in 1 crew kernel file" is true
  // about the filing and false about who confirmed it — a readable falsehood in the one sentence a reader
  // trusts, and exactly the fault the phase-1 run had just caught in its own grading (Law 25, Law 24).
  const heldBy = () => (PHASE === 1 ? 'the fleet ledger behind the door' : "the crew's own kernel files");

  const ask = async (who, line, waitMs = 12000) => who.answersTo(await who.say(line, waitMs)).join(' ');
  const statusOf = who => ask(who, 'foreman request', 14000);

  // A KNOWN EMPTY LEDGER BEFORE THE FIRST QUESTION, and it is a setup step rather than a verdict: every
  // question below is about what one sentence CHANGED, and a leftover row from an earlier run answers
  // "is it filed" affirmatively without anyone having asked for anything this run (Invariant B).
  await ask(a, 'foreman cancel all', 8000);
  await ask(b, 'foreman cancel all', 8000);

  // ── V16 — is the catalogue the fleet's own, or a list the desk keeps? ─────────────────────────
  // Graded against the catalogue COMPUTED HERE from the same tables the fleet walks, so the question
  // survives every recipe change: a desk answering from a hand-kept list drifts from the fleet the day
  // a capability moves, and the drift is invisible from inside a single answer (Law 16).
  // THE MATERIALS HALF IS COMPUTED THE WAY THE DESK COMPUTES IT — the catalogue's walk minus the
  // structures, because a structure is asked for in a different sentence and is offered on its own line.
  // Grading the goods line against the whole catalogue would report a violation against correct behaviour
  // the moment the desk split the two, which is the direction an instrument must never be wrong in.
  const catalogue16 = require(paths.bot('js_kernel/requestable_catalogue'));
  const computed = catalogue16.requestableItems().filter(i => !catalogue16.isBlueprint(i));
  const v16 = await ask(a, 'foreman can i get', 20000);
  const missingFromDesk = computed.filter(i => !v16.includes(i));
  const countClaimed = (v16.match(/(\d+) materials/) || [])[1];
  await recordAnswered('V16', 'Does `can i get` answer from the fleet\'s COMPUTED catalogue?',
    `fleet computes ${computed.length} materials | desk claimed: ${countClaimed || 'no count'} | absent from the desk\'s answer: ${missingFromDesk.length ? missingFromDesk.slice(0, 12).join(', ') : 'none'} | world said: ${v16.slice(0, 300)}`,
    missingFromDesk.length === 0 && String(computed.length) === String(countClaimed)
      ? `YES — every one of the ${computed.length} materials the fleet's own walk admits was offered, and the count matches. The answer is derived, so a capability gained tomorrow is offerable tomorrow.`
      : missingFromDesk.length
        ? `NO — ${missingFromDesk.length} item(s) the fleet can reach were not offered (${missingFromDesk.slice(0, 8).join(', ')}). A human cannot ask for what they were not shown.`
        : `PARTIAL — every item appeared but the desk's own count (${countClaimed}) is not the fleet's (${computed.length}). One of the two is counting something the other is not.`);

  // ── V17 — a request is FILED, and it reaches the crew ─────────────────────────────────────────
  // The postcondition is the crew's kernel file, not the reply. "Filed" is a claim about a broadcast
  // this process cannot see; a row in a bot's own ledger is that broadcast having arrived (Law 25).
  const v17 = await ask(a, 'foreman request 20 oak_log', 9000);
  await propagate(8000);
  const led17 = await crewLedger(HUMAN);
  const rows17 = led17.rows.filter(r => r.item === 'oak_log');
  await recordAnswered('V17', 'Does `request 20 oak_log` file a requirement that REACHES the crew?',
    `desk said: ${JSON.stringify(v17.slice(0, 160))} | crew ledgers hold: ${JSON.stringify(rows17)} | unreadable kernel files: ${JSON.stringify(led17.unreadable)}`,
    /20 oak_log/.test(v17) && rows17.length > 0 && rows17.every(r => r.quantity === 20)
      ? `YES — the desk accepted it and the row is held by ${heldBy()} (${rows17.length}) at the number asked. `
        + `The desk writes it, the fleet's own ledger rules accept it, and nothing was commanded and no body named.`
        + (PHASE === 1 ? ' Phase 1 grades that it was FILED; that a BODY then adopts it is a phase-2 claim.' : '')
      : /20 oak_log/.test(v17)
        ? 'NO — the desk accepted the request and no crew ledger holds it. The requirement exists only at the desk, so the crew will never act on it and the human was told it was filed (Law 25).'
        : `NO — the desk did not accept it: ${v17.slice(0, 160) || 'no answer'}`);

  // ── V18 — a request is a TARGET, not a tally ──────────────────────────────────────────────────
  // The failure this catches is silent and expensive: a person who repeats themselves after chat lag
  // must not buy double the work, and "how far from done" can only be answered against a fixed level.
  const v18 = await ask(a, 'foreman request 30 oak_log', 9000);
  await propagate(8000);
  const led18 = await crewLedger(HUMAN);
  const oak18 = led18.rows.filter(r => r.item === 'oak_log');
  const perBot = new Set(oak18.map(r => r.bot));
  await recordAnswered('V18', 'Does restating a request REPLACE it rather than add to it?',
    `desk said: ${JSON.stringify(v18.slice(0, 200))} | crew rows now: ${JSON.stringify(oak18)}`,
    oak18.length > 0 && oak18.every(r => r.quantity === 30) && oak18.length === perBot.size
      ? `YES — one row at 30 in ${heldBy()}, and the desk named the number it replaced. Saying it twice asks for thirty, not fifty, so a repeated sentence costs nothing and the target stays answerable.`
      : `NO — the crew holds ${JSON.stringify(oak18)}. A restatement either accumulated or landed as a second row; either way "how far from done" now has no fixed level to measure against.`);

  // ── V19 — plural, and nothing else ────────────────────────────────────────────────────────────
  // THE DESK'S WHOLE FORGIVENESS, and this question exists to keep it that small. A fuzzy matcher was
  // built and removed the same day (Architect: "lets take fuzzy matcher out... i would rather a list of
  // legal items to be given to the human to chose from and its up to them to spell things right"), so
  // what is measured here is a NARROW contract rather than a capable one: the same word said singular or
  // plural resolves, and everything else is refused and pointed at the list.
  //
  // Both directions are said because the fleet and English disagree both ways — the fleet spells a family
  // `logs` and a single item `oak_log`, so "log" is under-pluralised and "doors" is over-pluralised, and
  // each takes a different branch of the same string rule.
  const v19a = await ask(a, 'foreman request 5 log', 9000);        // singular of a family token
  const v19b = await ask(a, 'foreman request 5 doors', 9000);      // plural of a singular token
  const v19c = await ask(a, 'foreman request 5 plank', 9000);      // singular of another family
  const singularTook = v19a.includes('5 logs');
  const pluralTook = v19b.includes('5 door');
  const plankTook = v19c.includes('5 planks');
  // A FAMILY IS SAID TO BE A FAMILY. The fleet picks the species by abundance — set_wood_preference counts
  // trunks once and every later scan SORTS by the winner without filtering — so a person who asked for
  // logs and receives birch has not been misled only if they were told that is how it works (Law 25).
  const familyExplained = v19a.includes('family') || v19a.includes('most abundant');
  await recordAnswered('V19', 'Does the desk take the same word said singular or plural — and only that?',
    `"5 log" -> ${JSON.stringify(v19a.slice(0, 190))} | "5 doors" -> ${JSON.stringify(v19b.slice(0, 150))} `
    + `| "5 plank" -> ${JSON.stringify(v19c.slice(0, 150))}`,
    singularTook && pluralTook && plankTook && familyExplained
      ? 'YES — the same word said either way resolves, in both directions, and a family is named as a '
        + 'family. This is an EXACT lookup with the plural forms tried as further exact lookups, not a '
        + 'match: a candidate that is not already a legal token is discarded, so no reading is ever '
        + 'produced that the person would have to check.'
      : `PARTIAL — singular:${singularTook} plural:${pluralTook} second-family:${plankTook} `
        + `family-explained:${familyExplained}. Each false is its own half of the string rule.`);

  // ── V19b — CONTROL. A misspelling is REFUSED, not repaired ────────────────────────────────────
  // THE CONTROL THAT KEEPS V19 HONEST, and the one that would have caught the desk that was removed. A
  // matcher scores identically to the plural rule on every sentence above and differs only here: `logdsf`
  // is one plausible repair away from `logs`, and repairing it puts a reading between the person and the
  // fleet that only the person can check. The ledger is read as well as the reply, because a desk that
  // says something cautious AND files a row has still guessed (Law 25).
  //
  // The refusal is also checked for POINTING AT THE LIST. Exact spelling is only a workable contract if
  // the legal vocabulary is published — refusing without saying where the names are is a wall (Law 24).
  const v19dBefore = await crewLedger(HUMAN);
  const v19d = await ask(a, 'foreman request 5 logdsf', 9000);
  const v19e = await ask(a, 'foreman request 5 cobblestne', 9000);
  await propagate(4000);
  const v19dAfter = await crewLedger(HUMAN);
  const refusedBoth = !v19d.includes('right — 5') && !v19e.includes('right — 5');
  // MEASURED BY ITEM NAME, NEVER BY ROW COUNT. A count grew here for a reason that had nothing to do with
  // this question: the three LEGITIMATE requests one question earlier were still propagating into the crew
  // kernel files while this snapshot was taken, so a correct desk was reported as repairing misspellings
  // into items. A ledger with living writers is always moving, and a count is not a claim about which rows
  // moved. The actual claim is narrow and stays true whatever else is in flight — no row is named by a word
  // that was refused (Law 25: an instrument that fails against correct behaviour is worse than a silent one).
  const misspellings = ['logdsf', 'cobblestne'];
  const repaired = v19dAfter.rows.filter(r => misspellings.includes(r.item));
  const filedAnyway = repaired.length > 0;
  const pointsAtList = v19d.includes('can i get');
  await recordAnswered('V19b', 'CONTROL — is a MISSPELLING refused rather than repaired, and pointed at the list?',
    `"5 logdsf" -> ${JSON.stringify(v19d.slice(0, 190))} | "5 cobblestne" -> ${JSON.stringify(v19e.slice(0, 150))} `
    + `| rows named by a refused word: ${JSON.stringify(repaired)} | ledger moved from ${v19dBefore.rows.length} `
    + `to ${v19dAfter.rows.length} rows, which is the earlier questions' work still arriving and is not this question`,
    refusedBoth && !filedAnyway && pointsAtList
      ? 'CONTROL HOLDS — neither misspelling became a requirement and neither was silently repaired into a '
        + 'neighbouring item; the refusal names where the legal words are. The desk does not work out what '
        + 'somebody meant, so nothing it accepts needs a reading confirmed afterwards.'
      : filedAnyway
        ? `CONTROL FAILS — a misspelling became a requirement: ${JSON.stringify(repaired)}. Something `
          + `is repairing words into items, which puts a guess between the person and their crew.`
        : !pointsAtList
          ? `PARTIAL — refused and filed nothing, but the refusal does not say where the legal names are: `
            + `${v19d.slice(0, 150)}. Exact spelling is only a workable rule if the list is one sentence away.`
          : `CONTROL FAILS — a misspelling was accepted: ${v19d.slice(0, 150)}`);

  // ── V19c — the list is COMPLETE, because it is now the whole answer to spelling ────────────────
  // WITH GUESSING GONE THE LIST CARRIES THE WEIGHT THE MATCHER USED TO. A list that omits a name the desk
  // ACCEPTS is not a shorter list, it is a wrong one — and a person who read it carefully has no way to
  // tell an incomplete list from their own bad spelling, which is the worst place to leave them. Measured
  // against BOTH computed sources rather than against a count: every good the fleet's own walk admits,
  // and every family token the desk would take.
  // COMPLETENESS IS MEASURED IN BOTH DIRECTIONS, and the second one is newer and sharper. A list that
  // omits an accepted word strands the person who read it; a list that NAMES a refused word strands them
  // worse, because they chose it out of the only place claiming to say what is accepted and were still
  // told no — there is nowhere left for them to look. The structures are the case: the catalogue admits
  // every blueprint the fleet can paste, and only the ones with a requirement ladder can be raised on
  // request, so a list printed straight from the catalogue advertises buildings the desk refuses.
  const v19f = (await say('foreman can i get', 12000)).join(' ');
  const catalogue = require(paths.bot('js_kernel/requestable_catalogue'));
  // GRADED AGAINST THE WHITELIST, which is the table that answers this question. The requirement ladders
  // were used here for one round and are the wrong source: a ladder says the crew CAN build a structure,
  // the whitelist says a person may ASK for one, and an attached structure will eventually have the first
  // without the second. Reading the ladders would report a violation the day mineshaft gets its rows.
  const { REQUESTABLE_STRUCTURES } = require(paths.bot('Thinking_fragments/architect_config'));
  const raisable = [...REQUESTABLE_STRUCTURES];
  const goods = catalogue.requestableItems().filter(i => !catalogue.isBlueprint(i));
  const { group_to_item } = require(paths.bot('js_kernel/utils/fragment_utils'));
  const listedGoods = new Set(goods);
  const families = Object.keys(group_to_item).filter(t => !listedGoods.has(t) && catalogue.isRequestable(t).ok);
  const missingGoods = goods.filter(i => !v19f.includes(i));
  const missingFamilies = families.filter(f => !v19f.includes(f));
  const missingBuildings = raisable.filter(f => !v19f.includes(f));
  // THE NAMES THAT MUST NOT APPEAR COME FROM THE REGISTRY, NOT THE CATALOGUE. The catalogue is the thing
  // under test here — it decides what is offered — so asking it which names are off-limits would let a
  // catalogue that offered everything score a clean sheet by declaring nothing off-limits. The registry is
  // the independent source: every shape the builder can paste, whitelisted or not.
  // Matched on the whole word so a name that is a substring of a listed one is not counted by accident.
  const everyBlueprint = Object.keys(require(paths.bot('js_kernel/blueprint_registry')).getBuildings() || {});
  const overPromised = everyBlueprint
    .filter(i => !raisable.includes(i))
    .filter(i => new RegExp(`(^|[^a-z_])${i}([^a-z_]|$)`).test(v19f));
  await recordAnswered('V19c', 'Does `can i get` name every word the desk accepts — and NOTHING it refuses?',
    `materials computed: ${goods.length}, absent: ${JSON.stringify(missingGoods)} | families computed: `
    + `${families.length} (${families.join(', ')}), absent: ${JSON.stringify(missingFamilies)} | raisable buildings: `
    + `${JSON.stringify(raisable)}, absent: ${JSON.stringify(missingBuildings)} | advertised but refused: ${JSON.stringify(overPromised)}`,
    missingGoods.length === 0 && missingFamilies.length === 0 && missingBuildings.length === 0 && overPromised.length === 0
      ? 'YES — every material, family and raisable building the desk accepts is named, and no name it would '
        + 'refuse is offered. All three groups are computed from the tables the fleet itself resolves '
        + 'against — the recipe walk, the group table, and the structure whitelist — so a capability gained '
        + 'tomorrow is listed tomorrow and one that never existed is never advertised.'
      : overPromised.length
        ? `NO — the list advertises ${overPromised.length} building(s) the desk refuses (${overPromised.join(', ')}). `
          + `A person picking one out of the list is told no by the same desk that offered it, which leaves them `
          + `nowhere to look — a worse place than an incomplete list puts them (Law 25).`
        : `NO — the desk accepts words its own list does not name: materials ${JSON.stringify(missingGoods)}, `
          + `families ${JSON.stringify(missingFamilies)}, buildings ${JSON.stringify(missingBuildings)}. A person who `
          + `read the list and spelled from it is refused, with no way to tell whose fault it was (Law 25).`);

  // ── V20 — CONTROL. An unrequestable item is refused AND left unfiled ──────────────────────────
  // Two halves and the second is the one that can rot quietly: a refusal wording is visible the moment
  // it is wrong, while a refused-but-filed row strands a crew on work nothing it does can produce, at
  // a moment nobody is watching. The catalogue gates the WRITE for that reason, and this checks it did.
  const v20 = await ask(a, 'foreman request 5 string', 9000);
  await propagate(6000);
  const led20 = await crewLedger(HUMAN);
  const stringFiled = led20.rows.some(r => r.item === 'string');
  const statusAfter20 = await statusOf(a);
  await recordAnswered('V20', 'CONTROL — is an item the fleet cannot obtain refused, and NOT filed?',
    `desk said: ${JSON.stringify(v20.slice(0, 200))} | in a crew ledger: ${stringFiled} | status lists string: ${/string/.test(statusAfter20)}`,
    /string/.test(v20) && /can't do that one|needs string/i.test(v20) && !stringFiled && !/string/.test(statusAfter20)
      ? 'CONTROL HOLDS — refused at the moment it was said, naming the leaf that stopped the walk, and nothing was written. Naming the leaf teaches the whole family above it, so the person stops asking for the things made of it.'
      : stringFiled || /string/.test(statusAfter20)
        ? 'CONTROL FAILS — the item was refused to the person and filed anyway. A crew now holds a requirement no fragment can close, and it will be re-posted forever.'
        : `PARTIAL — nothing was filed, but the refusal did not name the leaf: ${v20.slice(0, 160)}`);

  // ── V21 — CONTROL. A malformed order never becomes a quantity nobody said ─────────────────────
  // Every shape here is a sentence a person genuinely types: the words in the other order, a zero, a
  // negative. A half-parsed order is the failure that still runs — guessing the quantity buys work
  // nobody asked for and guessing the item delivers the wrong thing (Law 13: never default a field).
  //
  // MEASURED AS A DIFFERENCE, NOT AGAINST A LIST OF EXPECTED ROWS. This carried the two item names the
  // questions above happened to file, and the day a new question filed a third, this one reported that a
  // malformed sentence had bought work nobody asked for — naming a row that a perfectly well-formed
  // sentence had legitimately placed. An instrument that carries a list is stale the moment anything
  // around it changes, and it fails LOUDLY against correct behaviour, which is the worst direction to be
  // wrong in. The ledger before and after is the actual claim: these four sentences must add nothing.
  const malformed = ['foreman request logs 20', 'foreman request 0 logs', 'foreman request -3 logs', 'foreman request 2.5 logs'];
  const led21Before = await crewLedger(HUMAN);
  const keyOf = r => `${r.bot}|${r.key}|${r.quantity}`;
  const beforeKeys = new Set(led21Before.rows.map(keyOf));
  const badReplies = [];
  for (const line of malformed) badReplies.push(await ask(a, line, 8000));
  await propagate(5000);
  const led21 = await crewLedger(HUMAN);
  const junk = led21.rows.filter(r => !beforeKeys.has(keyOf(r)));
  // GRADED ON THE CORRECTION, NOT ON ONE USAGE LINE. These four used to be answered identically, and the
  // law's claim is precisely that they are four different mistakes: the reversed sentence is told the
  // number comes first, the three bad numbers are told what a number is. What every one of them must carry
  // is a sentence that WOULD have worked — a refusal without one is a wall, which is the half the correction category
  // added over "invalid input" (Law 24: the report lands on what to do).
  const allGuided = badReplies.every(r => /foreman request 20 logs/.test(r));
  const reversedNamed = /number comes first/.test(badReplies[0]);
  await recordAnswered('V21', 'CONTROL — do malformed orders get a CORRECTION that teaches, and file NOTHING?',
    `${JSON.stringify(malformed)} → ${JSON.stringify(badReplies.map(r => r.slice(0, 130)))} | rows that should not exist: ${JSON.stringify(junk)}`,
    allGuided && reversedNamed && junk.length === 0
      ? 'CONTROL HOLDS — none of the four wrote a row, every one came back with the sentence that would have '
        + 'worked, and the reversed order was told what was reversed rather than being lumped in with the bad '
        + 'numbers. The desk refuses to guess a quantity, which is the one guess nothing downstream could catch.'
      : junk.length
        ? `CONTROL FAILS — a malformed sentence became a requirement: ${JSON.stringify(junk)}. Work was bought that nobody asked for.`
        : !allGuided
          ? `PARTIAL — nothing was filed, but a refusal carried no working sentence: ${JSON.stringify(badReplies.map(r => r.slice(0, 90)))}. That is a guard without the guide half.`
          : `PARTIAL — nothing was filed and each refusal guided, but the reversed order was not named as such: ${badReplies[0].slice(0, 120)}`);

  // ── V22 — THE OWNERSHIP CONTROL, and the reason V17-V18 mean anything ────────────────────────
  // A ledger that reads and cancels for everybody scores identically to a working one on every
  // question above. The second player says the identical words in the same channel: read the rows,
  // then try to withdraw them. Graded on whether A's rows SURVIVE, in A's own status and in the crew
  // files, because a refusal that is only wording is not a refusal.
  // THE CONTROL IS VOID UNLESS A ACTUALLY HOLDS A ROW WHEN B SPEAKS, and that guard is the whole
  // difference between a finding and a fabrication. Grading only on "did A's rows survive" reads TRUE
  // for the destruction of rows that were never filed: on a run where the request wire was dead this
  // wrote CONTROL FAILS — anyone can withdraw anyone's work — against a system that had not been asked
  // a single question. A control measures a DIFFERENCE, so with nothing there to take, there is no
  // difference to measure and the honest verdict is that the question was never reached (Law 25).
  const led22Before = await crewLedger(HUMAN);
  const aHadRows = led22Before.rows.some(r => r.item === 'oak_log');
  const bStatus = await statusOf(b);
  const bCancel = await ask(b, 'foreman cancel all', 9000);
  await propagate(6000);
  const aAfter = await statusOf(a);
  const led22 = await crewLedger(HUMAN);
  const aRowsSurvive = led22.rows.some(r => r.item === 'oak_log');
  await recordAnswered('V22', `CONTROL — can ${HUMAN_B} read or cancel ${HUMAN}'s requirements? (they must not)`,
    `A held before B spoke: ${aHadRows} | B's status: ${JSON.stringify(bStatus.slice(0, 200))} | B's cancel all: ${JSON.stringify(bCancel.slice(0, 160))} | A's rows after: ${JSON.stringify(led22.rows)} | A's status after: ${JSON.stringify(aAfter.slice(0, 200))}`,
    !aHadRows
      ? 'VOID — the first player held no row when the second one spoke, so there was nothing for the control to protect. Whatever the second player was refused or allowed, this run did not measure it. Fix the questions above and ask again.'
      : !/oak_log/.test(bStatus) && aRowsSurvive && /oak_log/.test(aAfter)
      ? 'CONTROL HOLDS — the second player saw none of the first player\'s requirements and could not withdraw them; both rows survived their cancel-all. A row is keyed by the person who spoke it and the desk stamps that from who was heard, so one player cannot spell another\'s key.'
      : /oak_log/.test(bStatus)
        ? 'CONTROL FAILS — a second player read the first player\'s requirements. The ledger is one shared list and ownership is decorative.'
        : 'CONTROL FAILS — a second player\'s cancel took the first player\'s rows. Anyone in the world can withdraw anyone\'s work.');

  // ── V23 — the read-back: an age in words, and silence said as silence ────────────────────────
  // The load-bearing half is the second one. A crew that has gathered nothing and a crew that has not
  // yet looked both show an empty shelf, and printing a zero for the second tells a person their bots
  // are idle when they may be halfway up a hill (Law 25 — the invented figure is the failure).
  const v23 = await statusOf(a);
  const hasAge = /asked (just now|\d+ minute|\d+ hour)/.test(v23);
  const hasEpoch = /1[6-9]\d{11}/.test(v23);
  const saysSilence = /no word from your crew yet/.test(v23);
  const saysMeasured = /\d+ so far|done, \d+ on the shelf/.test(v23);
  await recordAnswered('V23', 'Does the read-back carry an age in words and report silence AS silence?',
    `world said: ${JSON.stringify(v23.slice(0, 400))} | age in words: ${hasAge} | raw epoch present: ${hasEpoch} | "no word yet": ${saysSilence} | a measured figure: ${saysMeasured}`,
    hasAge && !hasEpoch && (saysSilence || saysMeasured)
      ? `YES — every row carries when it was asked, in words, and its progress is either a measurement or an explicit "no word yet". The two are different facts and only one is news about the work.`
      : hasEpoch
        ? 'NO — a raw timestamp reached a person. The desk is speaking to a human in machine units.'
        : `PARTIAL — the read-back is missing one of its two parts (age in words: ${hasAge}, honest progress clause: ${saysSilence || saysMeasured}).`);

  // ── V24 — THE ROUND TRIP: a figure measured in a body reaches the person who asked ────────────
  // The only question in this block that needs a crew to DO something, and the whole pipeline is in it:
  // a body measures its own shelves with the same lens its supply assessor stands down on, posts it to
  // its chair, the overseer relays the freshest per item, the desk speaks it. Graded on the crew's OWN
  // chair as well as the reply, because those are two different failures — a crew that never looked
  // and a relay that lost what it measured send a reader to different places.
  // VOID IN PHASE 1 RATHER THAN RETRIED AGAINST NOTHING. The figure this asks for is measured INSIDE a
  // body against its own chests; with no crew there is no party that can produce one, so a red here
  // would report a broken relay where there is simply nobody at the far end (Law 25). It also spent
  // three minutes of the run discovering that — twelve passes waiting fifteen seconds each for a
  // measurement nothing could make.
  let progressReply = '', chairMeasured = [];
  if (PHASE === 1) progressReply = await statusOf(a);
  else for (let i = 0; i < 12; i++) {
    const led = await crewLedger(HUMAN);
    chairMeasured = led.measured;
    progressReply = await statusOf(a);
    if (/\d+ so far|done, \d+ on the shelf/.test(progressReply)) break;
    await sleep(15000);
  }
  await recordAnswered('V24', 'Does a figure MEASURED BY THE CREW reach the person who asked?',
    `desk said: ${JSON.stringify(progressReply.slice(0, 300))} | the crew's own chairs hold: ${JSON.stringify(chairMeasured.slice(0, 6))}`,
    PHASE === 1
      ? 'VOID (phase 1) — this figure is measured inside a body against its own chests, and no crew is raised in this phase. What phase 1 CAN see is that the desk said "no word from your crew yet" rather than inventing a zero, which V23 grades. The round trip itself is a phase-2 claim.'
      : /\d+ so far|done, \d+ on the shelf/.test(progressReply)
      ? 'YES — a number measured inside a body arrived at the desk and was spoken to the person who asked. The desk holds no owner key and cannot see which chests are the crew\'s, so this figure could only have come from a body.'
      : chairMeasured.length
        ? 'NO — the crew measured its requests and wrote them to its chair, and the desk still says nothing. The measurement exists and the relay is where it stops: the chair reaches the overseer, or the overseer picks the freshest per item, and one of those two is not happening.'
        : 'NO — no crew chair carries a measurement at all, so nothing was there to relay. The body never measured its own requests; the desk\'s silence is honest and the fault is upstream of it.');

  // ── V25 — a structure is a STAGE, never a count ───────────────────────────────────────────────
  // A building is a second namespace and nothing can ever put one in a chest, so the same verb has to
  // be answered by a different organ. The failure this catches is a request for a headframe read as a
  // storage row: a gather order for an item no recipe and no block drop produces, re-posted forever.
  // ASKED WITH NO NUMBER, which is now the only form that exists for a building — see V29. The number is
  // still what the ledger stores, and the person is never shown it and never has to say it.
  const v25post = await ask(a, 'foreman request headframe', 9000);
  await sleep(10000);
  const v25 = await statusOf(a);
  const stageWord = /(not started|sited|pasted|built)/.exec(v25);
  const countedStructure = /headframe[^|]*?(\d+ so far|done, \d+ on the shelf)/.test(v25);
  await recordAnswered('V25', 'Is a requested STRUCTURE reported as a stage rather than a count?',
    `post: ${JSON.stringify(v25post.slice(0, 160))} | status: ${JSON.stringify(v25.slice(0, 400))} | stage word: ${stageWord ? stageWord[1] : 'none'} | counted like goods: ${countedStructure}`,
    /headframe/.test(v25post) && !/could not|isn't|not on the list/.test(v25post) && stageWord && !countedStructure
      ? `YES — accepted, and read back as "${stageWord[1]}" — the rung its own building ladder writes down, not a share of blocks. A structure and a good are asked for in the same sentence and answered by different organs.`
      : /could not|isn't|not on the list/.test(v25post)
        ? `NO — a structure the fleet knows how to build was refused at the desk: ${v25post.slice(0, 160)}`
        : countedStructure
          ? 'NO — the structure is being counted like goods. Somewhere it is being measured against a shelf, which is the shape that posts a gather order nothing can ever satisfy.'
          : PHASE === 1
            ? 'VOID (phase 1) — the STAGE is written by the building ladder the crew walks as it works, so with '
              + 'no crew raised there is no rung to report and the desk correctly says "no word from your crew yet". '
              + 'What phase 1 proved is the half above this: the structure was ACCEPTED and was not counted like '
              + 'goods. Whether the stage then reaches the person is a phase-2 claim (Law 25 — a phase may not '
              + 'report on a witness it did not raise).'
            : `PARTIAL — filed, but the read-back names no stage: ${v25.slice(0, 200)}`);

  // ═══ LAW 13'S THIRD CATEGORY: CORRECTION ══════════════════════════════════════════════════════════════════
  // LAW 13'S THIRD CATEGORY, ASKED AT THE ONE BOUNDARY THAT HAS IT. A coding violation throws and an
  // environmental failure soft-fails to the judge; a person typing the wrong thing is neither, because
  // nothing is defective and nothing in the world moved. So the desk CORRECTS — it does not throw, it lets
  // nothing cross, it names the true cause, and it says what would have worked. The law's demand is the
  // same one the other two categories carry: every failure states exactly what caused it.
  //
  // EVERY QUESTION BELOW IS GRADED ON BOTH HALVES, and that is the point of asking them here rather than
  // on the bench. The guard half — nothing filed — is checked against the CREW's own kernel files, because
  // a desk that speaks a refusal and files a row anyway has refused only in wording, and that failure is
  // invisible from inside the reply. The guide half is checked against the reply, because a refusal that
  // teaches nothing is the wall the correction category exists to replace.
  // THE GUARD HALF IS MEASURED PER ITEM, NEVER BY ROW COUNT. A ledger with two living writers is always
  // moving — an earlier question's legitimate rows arrive during this one's snapshot — so "more rows than
  // before" is not a claim about which sentence put them there, and grading on it reports a correct desk as
  // a broken one. Each question below states its own postcondition against the rows for the word it said,
  // which is the thing it is actually asserting and stays true whatever else is in flight (Law 25).
  const doctrineReplies = [];
  const rowsFor = (led, item) => led.rows.filter(r => r.item === item);
  const askBad = async (line, waitMs = 9000) => {
    const before = await crewLedger(HUMAN);
    const said = await ask(a, line, waitMs);
    await propagate(4000);
    const after = await crewLedger(HUMAN);
    doctrineReplies.push({ line, said });
    return { said, before, after };
  };

  // ── V29 — CONTROL. A building takes no number ────────────────────────────────────────────────
  // "i dont want someone to accidentally request 10 headframes. it makes one building." The accident is
  // the whole reason: a person who has just learned `request 20 logs` applies that form to a building, and
  // the old desk would have taken it. Ten headframes is not an error the crew can survive discovering
  // later — the ledger would carry a target of ten and the building ladder can only ever report one.
  const v29 = await askBad('foreman request 10 headframe');
  const v29Explains = /isn't a quantity|one headframe/.test(v29.said);
  const v29Teaches = /foreman request headframe/.test(v29.said);
  // THE POSTCONDITION IS THE NUMBER, not the presence of a row: V25 legitimately left a headframe standing,
  // so "a headframe row exists" is the correct state and says nothing. What must not have happened is the
  // ten reaching the ledger — that is the value the building ladder can never satisfy.
  const v29Filed = rowsFor(v29.after, 'headframe').some(r => r.quantity !== 1);
  await recordAnswered('V29', 'CONTROL — is a NUMBER on a building refused, explained, and left unfiled?',
    `"10 headframe" -> ${JSON.stringify(v29.said.slice(0, 220))} | headframe rows after: ${JSON.stringify(rowsFor(v29.after, 'headframe'))}`,
    !v29Filed && v29Explains && v29Teaches
      ? 'CONTROL HOLDS — refused, nothing written, and the reply says both halves: that a building is not a '
        + 'quantity, and the exact sentence that works. The person learns the rule rather than the fact that '
        + 'they were wrong, which is the difference between a correction and a wall.'
      : v29Filed
        ? `CONTROL FAILS — a numbered building became a requirement: ${JSON.stringify(rowsFor(v29.after, 'headframe'))}. The veil `
          + `passed input the crew cannot act on, which is the contamination Law 13 exists to stop.`
        : `PARTIAL — nothing was filed but the reply is missing a half (explains: ${v29Explains}, teaches the `
          + `working form: ${v29Teaches}): ${v29.said.slice(0, 180)}`);

  // ── V30 — CONTROL. The same building twice while the first is going up ───────────────────────
  // "a human cannot request the same building more than once while its building." ASKED OF THE FLEET
  // rather than of a tally the desk keeps: a remembered count is wrong the first time the person cancels
  // from another session and every time the desk restarts (Invariant B). The stage is the load-bearing
  // part of the answer — "you already asked" invites "yes, and nothing is happening", and only the stage
  // answers that.
  // VOID UNLESS THE FIRST HEADFRAME IS ACTUALLY OUTSTANDING WHEN THE SECOND IS ASKED. Without the guard
  // this reads CONTROL FAILS against a correct desk on any run where V25's request never landed: with no
  // first row, the second is simply a first one and filing it is right. A control measures a difference,
  // and there is no difference to measure when the thing it protects was never there (Law 25).
  const v30Pre = await crewLedger(HUMAN);
  const headframeStanding = v30Pre.rows.some(r => r.item === 'headframe');
  const v30 = await askBad('foreman request headframe');
  const v30Stage = /(not started|sited|pasted)/.test(v30.said);
  const v30Already = /already on the/.test(v30.said);
  // A DUPLICATE IS COUNTED WITHIN THE ITEM. The ledger keys a row by owner and item, so a second accepted
  // request either overwrites the first (invisible in a count of headframe rows) or adds one (visible).
  // The row count is the half visible from outside a body. The other half — that a repeat does not reset
  // `first_asked_at` and push the building to the back of its own queue — is held down on the bench, where
  // the ledger's fields are readable (scenario_request_ledger).
  const v30Filed = rowsFor(v30.after, 'headframe').length > rowsFor(v30.before, 'headframe').length;
  await recordAnswered('V30', 'CONTROL — is the SAME building refused while it is still being built, with its stage?',
    `first headframe standing when asked again: ${headframeStanding} | "request headframe" (second time) -> ${JSON.stringify(v30.said.slice(0, 240))} | headframe rows before: ${rowsFor(v30.before, 'headframe').length}, after: ${JSON.stringify(rowsFor(v30.after, 'headframe'))}`,
    !headframeStanding
      ? 'VOID — no headframe was outstanding when the second request was made, so this run did not ask the '
        + 'question. Whatever the desk did with the second sentence, it was not a duplicate. Fix V25 and ask again.'
      : !v30Filed && v30Already && v30Stage
      ? 'CONTROL HOLDS — the repeat was refused with the stage the crew\'s own ladder wrote down, and no '
        + 'second row appeared. The desk asked the fleet what was outstanding rather than consulting a tally '
        + 'of its own, so the answer survives a restart and a cancel from anywhere else.'
      : v30Filed
        ? 'CONTROL FAILS — a second row for a building already underway. Two rows for one structure is a queue '
          + 'that never empties: finishing the building satisfies one of them and the other is outstanding forever.'
        : `PARTIAL — no second row, but the reply is missing a half (named as underway: ${v30Already}, carried `
          + `the stage: ${v30Stage}): ${v30.said.slice(0, 200)}`);

  // ── V31 — CONTROL. A material with NO number ─────────────────────────────────────────────────
  // THE MIRROR OF V29 AND IT IS ASKED BECAUSE THE MISTAKE IS SYMMETRIC: a person who has just learned that
  // a building takes no number tries a material the same way. The old parser returned nothing at all for
  // this line, so both mistakes arrived at the desk indistinguishable and the only reply available was one
  // usage line for two different confusions.
  const v31 = await askBad('foreman request oak_log');
  const v31Explains = /material|how many/.test(v31.said);
  const v31Teaches = /foreman request 20 oak_log/.test(v31.said);
  // THE POSTCONDITION IS THAT THE STANDING NUMBER DID NOT MOVE. oak_log has been outstanding since V18, so
  // an accepted no-number request would not add a row — it would REPLACE the target with whatever quantity
  // was defaulted, which is the silent form of this failure and the one a row count cannot see.
  const v31Before = new Set(rowsFor(v31.before, 'oak_log').map(r => r.quantity));
  const v31Filed = rowsFor(v31.after, 'oak_log').some(r => !v31Before.has(r.quantity));
  await recordAnswered('V31', 'CONTROL — is a MATERIAL with no number refused with the number form, and unfiled?',
    `"request oak_log" -> ${JSON.stringify(v31.said.slice(0, 220))} | oak_log quantities before: ${JSON.stringify([...v31Before])}, after: ${JSON.stringify(rowsFor(v31.after, 'oak_log').map(r => r.quantity))}`,
    !v31Filed && v31Explains && v31Teaches
      ? 'CONTROL HOLDS — refused, nothing written, and the reply names the item back inside the working '
        + 'sentence. The two forms are taught as two forms, so a person who confused them is corrected on '
        + 'the one they actually got wrong.'
      : v31Filed
        ? `CONTROL FAILS — a material with no quantity became a requirement: ${JSON.stringify(rowsFor(v31.after, 'oak_log'))}. `
          + `A number was defaulted somewhere, which buys work nobody asked for (Law 13).`
        : `PARTIAL — nothing filed but a half is missing (explains: ${v31Explains}, teaches: ${v31Teaches}): ${v31.said.slice(0, 180)}`);

  // ── V32 — CONTROL. A real structure that is NOT on the whitelist ─────────────────────────────
  // THE QUIETEST FAILURE IN THIS BLOCK. The blueprint registry holds a document for every shape the builder
  // can paste, and pasting is not the question a person is asking: most structures ATTACH to another in a
  // specific way and cannot be raised alone. A name offered on that basis is accepted, filed, broadcast,
  // adopted by every crew member, and then walked past by every assessor forever, with the read-back
  // honestly reporting "not started" because it never will be. Nothing throws and nothing warns.
  //
  // THE TARGET COMES FROM THE REGISTRY, DELIBERATELY. The whole point is to say a name the desk should NOT
  // take, so it has to be sourced from something other than the desk's own idea of what it takes — a
  // catalogue that wrongly offered everything would otherwise leave this question with no target and score
  // VOID, which is the failure hiding inside a clean sheet.
  const everyStructure = Object.keys(require(paths.bot('js_kernel/blueprint_registry')).getBuildings() || {});
  const unraisable = everyStructure.filter(i => !raisable.includes(i));
  if (unraisable.length === 0) {
    await recordAnswered('V32', 'CONTROL — is a structure off the whitelist refused rather than filed?',
      `every structure the registry holds (${everyStructure.join(', ')}) is on the whitelist`,
      'VOID — every structure the builder can paste is also offered, so there is no off-list name to say and '
      + 'this run did not ask the question. Not a pass: it becomes askable again the day a structure is added '
      + 'to the registry without being whitelisted (Law 25 — a control with nothing to catch measures nothing).');
  } else {
    const target = unraisable[0];
    const v32 = await askBad(`foreman request ${target}`);
    const v32Explains = /part of a larger build|attaches to another structure/.test(v32.said);
    const v32Teaches = raisable.every(f => v32.said.includes(f));
    // The narrowest postcondition of the four, because the word has never been outstanding: no row anywhere
    // may be named by it.
    const v32Filed = rowsFor(v32.after, target).length > 0;
    await recordAnswered('V32', 'CONTROL — is a structure off the whitelist refused rather than filed?',
      `"request ${target}" (a real structure the registry holds, not on the whitelist) -> ${JSON.stringify(v32.said.slice(0, 240))} `
      + `| filed anyway: ${v32Filed} | raisable: ${JSON.stringify(raisable)}`,
      !v32Filed && v32Explains && v32Teaches
        ? `CONTROL HOLDS — '${target}' is a real structure spelled correctly and the desk still refused it, `
          + `naming what CAN be raised alone and why this cannot. The refusal is not a spelling answer, which matters: the `
          + `person got the name right and being told to check their spelling would send them nowhere.`
        : v32Filed
          ? `CONTROL FAILS — '${target}' became a requirement no assessor will ever walk: ${JSON.stringify(rowsFor(v32.after, target))}. `
            + `The person waits on a crew that was never given the work, and the read-back says "not started" `
            + `truthfully forever (Law 25 — the acceptance was a success flag the fleet cannot earn).`
          : `PARTIAL — nothing filed but a half is missing (named the reason: ${v32Explains}, named what CAN be `
            + `raised: ${v32Teaches}): ${v32.said.slice(0, 200)}`);
  }

  // ── V33 — THE CATEGORY ITSELF: does every refusal a person can meet actually GUIDE? ─────────
  // THE ONLY QUESTION HERE THAT IS ABOUT THE DOCTRINE RATHER THAN ABOUT ONE RULE, and it is asked across
  // every refusal this run collected rather than about any single one. The law's claim here is not that
  // each refusal is correct — every question above measures that — it is that a refusal is never merely a
  // "no". A desk that guards perfectly and guides nowhere passes every control above and still leaves the
  // person guessing, which is the state that made a fuzzy matcher look like the fix.
  //
  // THE MEASURE IS ONE PROPERTY, NOT A LIST OF ACCEPTED PHRASES: the remedy must name a COMMAND the person
  // can type. Grading the wording would be an opinion about prose; grading whether a typeable sentence is
  // present is a fact about the reply, and it survives every rewording that keeps the property.
  //
  // A phrase list stood here and was wrong in both directions at once. It missed the one refusal that
  // genuinely was a dead end for a while — a remedy naming the buildings that can be raised and stopping,
  // leaving the person to compose the line themselves — while being ready to fail against any correction
  // that was merely reworded. The property is what was meant; the phrases were a proxy for it.
  const allRefusals = [
    ...doctrineReplies,
    { line: 'foreman request 5 logdsf', said: v19d },
    { line: 'foreman request 5 string', said: v20 },
    ...malformed.map((line, i) => ({ line, said: badReplies[i] })),
  ];
  // Matched lowercase and followed by a verb: the chat prefix the server prepends is `<Foreman>`, so the
  // capital is what separates a remedy quoting a command from a line that merely carries the desk's name.
  const unguided = allRefusals.filter(r => !/foreman [a-z]/.test(r.said));
  await recordAnswered('V33', 'Does EVERY refusal a person can meet carry somewhere to go next?',
    `${allRefusals.length} refusals collected this run | with no way forward: ${JSON.stringify(unguided.map(r => ({ line: r.line, said: r.said.slice(0, 90) })))}`,
    unguided.length === 0
      ? `YES — all ${allRefusals.length} refusals collected across this run hand back a line the person can type. `
        + `That is the correction's second half made measurable: the guard half is that nothing crossed, `
        + `and every question above checked it against the crew's own files; this is the guide half, and it is `
        + `the one that decides whether a person tries again or gives up on the desk.`
      : `NO — ${unguided.length} refusal(s) tell a person only that they were wrong: `
        + `${JSON.stringify(unguided.map(r => r.line))}. Each of those is a wall, and the law's whole claim here `
        + `is that this desk has none (Law 24 — a report lands on what to do, not only on what happened).`);

  // ── V26 — withdrawing: it goes from the crew, and an empty cancel says so ────────────────────
  // The second half is the honest-zero: a cancel that matched nothing must say it matched nothing,
  // because "done" either way makes every success this system reports worthless (Law 25).
  const v26 = await ask(a, 'foreman cancel oak_log', 9000);
  await propagate(8000);
  const led26 = await crewLedger(HUMAN);
  const oakGone = !led26.rows.some(r => r.item === 'oak_log');
  const v26again = await ask(a, 'foreman cancel oak_log', 9000);
  await recordAnswered('V26', 'Does `cancel` withdraw the requirement FROM THE CREW, and report an empty cancel honestly?',
    `desk said: ${JSON.stringify(v26.slice(0, 140))} | crew rows after: ${JSON.stringify(led26.rows)} | said again: ${JSON.stringify(v26again.slice(0, 140))}`,
    /dropped \d+ request/.test(v26) && oakGone && /nothing of yours matched/.test(v26again)
      ? 'YES — the row left the crew\'s own ledger, not merely the desk\'s, and saying it a second time was answered "nothing matched" rather than a second cheerful success.'
      : !oakGone
        ? 'NO — the desk reported the withdrawal and the crew still holds the requirement. The crew will keep working on something the person has called off.'
        : `PARTIAL — the row is gone but the second cancel did not report an empty match: ${v26again.slice(0, 140)}`);

  // ── V27 — a requirement needs no bodies ──────────────────────────────────────────────────────
  // A request is a fact written down, not a command delivered, so a person with no crew may still file
  // one — and the honest answer about it is "nobody has looked", never a zero and never a refusal.
  // This is the same distinction V23 tests, asked where the silence is structural rather than timing.
  const v27post = await ask(b, 'foreman request 10 cobblestone', 9000);
  const v27status = await statusOf(b);
  await recordAnswered('V27', 'Can a person with NO crew file a requirement, and is its silence honest?',
    `B owns no bots | post: ${JSON.stringify(v27post.slice(0, 160))} | B's status: ${JSON.stringify(v27status.slice(0, 240))}`,
    /10 cobblestone/.test(v27post) && /no word from your crew yet/.test(v27status)
      ? 'YES — filed without a body in the world and read back as "no word from your crew yet". The requirement waits for whoever is fetched next; nothing invented a zero to fill the gap.'
      : /10 cobblestone/.test(v27post)
        ? `PARTIAL — filed, but the read-back does not say the silence plainly: ${v27status.slice(0, 200)}`
        : `NO — a person with no crew could not file a requirement: ${v27post.slice(0, 160)}`);

  // ── V28 — withdrawing the LAST requirement ───────────────────────────────────────────────────
  // THE EMPTY CASE IS ITS OWN QUESTION and it is asked separately because it travels a different road:
  // V26 withdrew one row out of several, so the ledger the overseer broadcast was still non-empty and
  // a crew adopting it whole necessarily lost the row. Emptying the ledger has nothing left to carry
  // the news — and "no rows" is the state a person leaves behind every time they finish with the fleet,
  // so it is the state that outlives the session (Invariant B: the crew must re-sense, not remember).
  //
  // Doubles as this probe's cleanup, and cleanup is why it must be graded rather than merely performed:
  // a standing requirement outlives the run that wrote it — on disk in every crew member's kernel file —
  // so a probe that walked away leaves the next run's bots working for a player who logged off (Law 8).
  const v28 = await ask(a, 'foreman cancel all', 9000);
  await ask(b, 'foreman cancel all', 8000);
  let led28 = { rows: [], unreadable: [] };
  for (let i = 0; i < 6; i++) {
    await propagate(10000);
    led28 = await crewLedger(HUMAN);
    if (led28.rows.length === 0) break;
  }
  const statusAfter28 = await statusOf(a);
  await recordAnswered('V28', 'Does withdrawing the LAST requirement reach the crew, or only the desk?',
    `desk said: ${JSON.stringify(v28.slice(0, 140))} | desk's read-back after: ${JSON.stringify(statusAfter28.slice(0, 160))} | rows still in crew kernel files after 60s: ${JSON.stringify(led28.rows)}`,
    led28.rows.length === 0
      ? `YES — the desk reports nothing outstanding and no row survives in ${heldBy()}. The person is finished with the fleet and the fleet agrees.`
      : 'NO — the desk reports nothing outstanding while the crew still holds ' + led28.rows.length + ' row(s) on disk. '
        + 'The two disagree about what was asked for, and the desk is the one the human can see: the crew goes on '
        + 'working for a requirement that has been called off, and every later run inherits it. This is the empty '
        + 'ledger having no carrier — the broadcast omits the requirement map when it is empty, so the last '
        + 'non-empty version is what every bot keeps (Law 25: the read-back is a true statement about the desk and '
        + 'a false one about the fleet).');

  // ── V34 — THE COMPLETION WATCH: does the work actually GET DONE, and how do we know it stopped? ──
  // PHASE 2 ENDS HERE, AND IT ENDS ON THE LEDGER RATHER THAN ON THE CLOCK. Every question above asks
  // whether one sentence produced one correct reaction; this one asks the only thing left that a body
  // can answer — whether a requirement a person filed is MET by work. Nothing above can substitute for
  // it: a row that is filed, relayed, read back and measured is still a row nobody has filled.
  //
  // ── WHY "ALL BOTS IDLE" IS NOT THE END CONDITION ────────────────────────────────────────────────
  // A still fleet has two opposite causes and they look identical from outside: it has finished, or its
  // whole board is held at the gates and it will move again at dawn. Ending on stillness scores the
  // second as the first — a run that stopped at nightfall would report the work done, with a green
  // summary and empty chests (Law 25: the verdict must equal sensed reality against the asker's
  // criteria, and the criterion here is the person's requirement, not the fleet's posture).
  //
  // So the end condition is the REQUEST LEDGER, measured inside the bodies by the fleet's own lens
  // (`requested_work.requestProgress`, the same rows the desk quotes to a human — one measurement, one
  // owner, Law 16). `met` is computed against real chests by the party holding the owner key. The idle
  // state is read too, but only to EXPLAIN a run that ends without the rows being met — never to end it.
  //
  // ── THE CAP IS A REFEREE AND IS NAMED AS ONE (Law 27) ───────────────────────────────────────────
  // A watch with no bound is a loop with no judge. This one cannot be a constitution — whether the world
  // yields twenty logs is not a fact any unit here can be built to make impossible to miss — so it is a
  // regulation with a stated owner, a stated rule and an honest report: it waits a bounded time, and on
  // running out it reports what was still outstanding rather than a timeout with no content.
  if (PHASE === 2) {
    const WATCH_MS = 25 * 60 * 1000;   // the bound, not a target — a run that needs it has already failed
    const POLL_MS = 15 * 1000;
    const started = Date.now();

    // WHAT THE FLEET SAYS IT IS DOING WHEN IT IS DOING NOTHING. `jobs_held` is written by every sweep
    // (job_board), so this reads the board's own verdict rather than inferring one from stillness.
    const idleState = () => {
      const out = [];
      for (const id of Object.keys(BOT_SENIORITY)) {
        const file = path.join(BOT_DIR, 'js_kernel', `corporate_headquarters.${id}.json`);
        if (!fs.existsSync(file)) continue;
        let hq = null;
        try { hq = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
        const room = hq.job_board_room || {};
        const jobs = Array.isArray(room.jobs) ? room.jobs.length : null;
        const held = room.jobs_held || null;
        if (jobs === null) continue;
        out.push({ bot: id, postable: jobs, held: held ? held.count : 0, by_gate: held ? held.by_gate : {} });
      }
      return out;
    };

    const outstanding = (led) => {
      // A row with NO measurement is outstanding, not met. "Nobody has looked yet" and "it is done" are
      // different facts and only one of them ends a run (Law 25 — an absent figure is never a zero).
      const byItem = new Map();
      for (const m of led.measured) {
        const held = byItem.get(m.item);
        if (!held || (m.met && !held.met)) byItem.set(m.item, m);
      }
      return led.rows
        .map(r => ({ item: r.item, asked: r.quantity, measurement: byItem.get(r.item) || null }))
        .filter(r => !r.measurement || r.measurement.met !== true);
    };

    console.log(`
phase 2: watching until every filed request is MET (bound ${WATCH_MS / 60000} min).`);
    let led = await crewLedger(HUMAN);
    let left = outstanding(led);
    let lastIdle = idleState();
    if (led.rows.length === 0) {
      record('V34', 'Does the fleet carry a filed requirement through to MET, and does the run end on that?',
        `crew kernel files hold no rows for ${HUMAN} at the start of the watch`,
        'VOID — no requirement was standing when the watch opened, so there was nothing to carry to done. '
        + 'The questions above withdrew what they filed; a run that means to measure completion has to leave '
        + 'one standing. Nothing here is evidence either way (Law 25).');
    } else {
      while (left.length > 0 && Date.now() - started < WATCH_MS) {
        await sleep(POLL_MS);
        led = await crewLedger(HUMAN);
        left = outstanding(led);
        lastIdle = idleState();
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        console.log(`  ${mins}m — outstanding: ${JSON.stringify(left.map(r => `${r.item} ${r.measurement ? r.measurement.have : '?'}/${r.asked}`))}`
          + ` | board: ${JSON.stringify(lastIdle.map(b => `${b.bot} ${b.postable} postable, ${b.held} held`))}`);
      }
      const stillness = lastIdle.filter(b => b.postable === 0);
      const gated = stillness.filter(b => b.held > 0);
      record('V34', 'Does the fleet carry a filed requirement through to MET, and does the run end on that?',
        `filed: ${JSON.stringify(led.rows.map(r => `${r.item}×${r.quantity}`))} | outstanding at the end: `
        + `${JSON.stringify(left.map(r => `${r.item} ${r.measurement ? r.measurement.have : 'unmeasured'}/${r.asked}`))} `
        + `| board per bot: ${JSON.stringify(lastIdle)} | elapsed: ${((Date.now() - started) / 60000).toFixed(1)}m`,
        left.length === 0
          ? `YES — every requirement ${HUMAN} filed is measured MET inside a body against its own chests, and the `
            + 'run ended on that fact rather than on a clock or on the fleet going quiet. This is the one question '
            + 'in the phase that a body alone can answer.'
          : gated.length
            ? `NO — the watch ran out with ${left.length} requirement(s) short, and ${gated.length} bot(s) are idle `
              + `with work HELD at the gates: ${JSON.stringify(gated.map(b => b.by_gate))}. The fleet is waiting, not `
              + 'finished — read the gate causes before reading this as a failure of the request system, because a '
              + 'board held for daylight or for missing stock is a correct board.'
            : `NO — the watch ran out with ${left.length} requirement(s) short and NOTHING held at the gates: `
              + `${JSON.stringify(lastIdle)}. Work the fleet accepted was neither done nor refused, which is the `
              + 'condition a held board cannot explain away.');
    }
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────────────────────────
  console.log('\n\n══════════ FOREMAN PROBE SUMMARY ══════════');
  for (const f of findings) console.log(`${f.id.padEnd(4)} ${f.verdict.slice(0, 150)}`);
  console.log('═════════════════════════════════════════\n');

  writeFindings({ foremanWindow: foremanSaid().split('\n').slice(-25) });

  // ── Law 8 — down comes everything this raised, and NOTHING IT DID NOT ────────────────────────
  // `verb exit` from the TERMINAL is the one route that reaches both species, which is why the teardown
  // uses it and V12 could not. V13 already said it and measured the result; repeating it here is
  // deliberate and idempotent — it catches anything that came up between the two, and a teardown that
  // relies on a measurement step having run is a teardown that stops working the day the question moves.
  await runFleetControl(['verb', 'exit']);
  // The overseer comes down only if this probe was the thing that raised it. Killing one that was
  // already serving a live session would take the fleet with it — a teardown that reaches past what it
  // started is the same fault as one that stops short.
  if (!overseerWasUp) {
    await runFleetControl(['down', '--keep-server']);
    console.log('overseer: taken down (this probe raised it).');
  } else {
    console.log('overseer: left up (it was already running before this probe).');
  }
  // Law 8 — the stand-in was raised by this run and is taken down by it. Left up, it holds the port the
  // real overseer needs, and the next phase-2 run fails to raise a fleet for a reason nothing names.
  if (standin) { await standin.close(); console.log('phase 1: stand-in door closed.'); }
  rcon.close();
  human.quit();
  b.bot.quit();
  // The clerk comes down only if this probe stood it up. One that was already on duty belongs to the
  // session that raised it, and a teardown reaching past what it started is the same fault as one that
  // stops short (Law 8).
  if (foreman) foreman.kill();
  else console.log('foreman: left standing (it was already in the world before this probe).');
  setTimeout(() => process.exit(0), 1500);
}

// THE SAME TERMINUS AS AN UNCAUGHT FAULT, and for the same reason: a throw out of `main` used to print
// and exit, which wrote no findings and swept no crew — so a defect in one question threw away every
// verdict measured before it AND left two bots in a world nobody was driving. There is one way out of
// this process (Law 16), and it records what killed the run, writes what it had, and takes down what it
// raised (Law 8).
main().catch(e => dieHonestly('threw out of main', e));
