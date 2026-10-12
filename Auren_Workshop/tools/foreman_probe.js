'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/foreman_probe.js');
// tool: foreman_probe — proves the foreman answers a HUMAN and refuses everything else, then drives the
// command and request systems end to end against a live fleet.
//
//   V1-V4   Answers a human on chat, by name, with an honest roster.
//   V5      CONTROL — a console /say must not command it (Law 16: authentication is on the wire).
//   V6-V15  The command system. Delivery is graded on the server's player list and the foreman's
//           registry (Law 26). V8 is the ownership control. V12/V13 are the species control and its
//           terminal override. V14/V15 are a contractor's arrival and its return home after dying.
//           V15b is the zombie case: a body killed and logged out must never register.
//   V16-V34 The request system — a verb that writes a FACT, not a command to a body, graded on a
//           postcondition outside the desk (Law 26). V20-V22 are the controls: a refused item stays
//           unfiled, a malformed order files no quantity, a second player cannot read or cancel the
//           first's requirements. V29-V33 are Law 13's correction category. V34 is the completion
//           watch: the run ends when the filed requests are MET, not when the fleet goes idle.
//
// Every verdict from V6 on is VOID, not failed, when the clerk has left the server before its answer
// was due.
//
// Run (server must be UP; the foreman, its hub and every bot are raised and torn down by this probe —
// Law 8. A foreman already on duty is reused and left standing):
//   . .\Auren_Workshop\scripts\_node.ps1 ; & (Get-AurenNode) Auren_Workshop\tools\foreman_probe.js --phase=1
//   . .\Auren_Workshop\scripts\_node.ps1 ; & (Get-AurenNode) Auren_Workshop\tools\foreman_probe.js --phase=2
//
// Phase 1 raises no foreman and no bots — a stand-in holds the in-game door — and answers everything the
// DESK said or put on the wire. Phase 2 raises the real fleet and answers only what a BODY can answer.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const paths = require('../workshop_paths');
const BOT_DIR = paths.BOT_ROOT;

// Where the modules live, asked of the one file that answers it (Law 16). `bootstrapModulePath`
// unshifts onto THIS module's own paths; it does not reach modules a required fleet file resolves on
// its own.
const moduleHomes = require(paths.bot('js_kernel/utils/node_module_homes'));
const MODULE_DIRS = moduleHomes.bootstrapModulePath();
if (MODULE_DIRS.length === 0) {
  console.error('foreman_probe: no module home found — mineflayer cannot resolve. Checked: '
    + moduleHomes.CANDIDATE_HOMES.join(', '));
  process.exit(1);
}
for (const d of MODULE_DIRS) module.paths.unshift(d);

// Module resolution for every child process this probe spawns.
const CHILD_ENV = {
  ...process.env,
  NODE_PATH: [process.env.NODE_PATH, moduleHomes.nodePathValue()].filter(Boolean).join(path.delimiter),
};

const mineflayer = moduleHomes.requireFromHomes('mineflayer');
const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));

// The roster, from the fleet's own table (Law 16).
const { BOT_SENIORITY, FOREMAN_NAME } = require(paths.bot('Thinking_fragments/architect_config.js'));
const ROSTER_LOWER = Object.keys(BOT_SENIORITY).map(n => n.toLowerCase());

// The verb list and the bot cap, read from the fleet (Law 16).
paths.registerAliases();
const { OPERATOR_VERBS, CREW_SIZE } = require(paths.bot('foreman/foreman_vocabulary'));
// The fleet's own door client (Law 16), used only to OBSERVE registration and species.
const door = require(paths.bot('foreman/foreman_door'));

const net = require('net');

const HUMAN = 'ProxyHuman';
// The second person, for the ownership questions.
const HUMAN_B = 'ProxySecond';
// Version, read from architect_config (Law 16).
const VERSION = require(paths.bot('Thinking_fragments/architect_config.js')).SERVER_MINECRAFT_VERSION;
// The bot the HUMAN fetches (a contractor) and the one the OPERATOR starts from the terminal (a
// homesteader).
const CONTRACTOR_NAME = 'AurenBot';
const HOMESTEADER_NAME = 'TessaBot';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── THE PHASE ───────────────────────────────────────────────────────────────────────────────────
// PHASE 1 — THE DESK. No foreman, no bots. A stand-in sits on the foreman's in-game door
//   (`foreman_door_standin`); every question answerable from what the desk SAID or PUT ON THE WIRE.
// PHASE 2 — THE FLEET. The real foreman, a real crew, real work; the questions a BODY can answer.
//
// The cut is at the door (Law 16). Phase 1 asserts what the desk FORMED; phase 2 asserts who RECEIVED
// it — delivery, ownership and species isolation are phase-2 claims (Law 25).
//
// Default stopped (Law 13): no phase is assumed.
const PHASE_ARG = process.argv.find(a => a.startsWith('--phase='));
const PHASE = PHASE_ARG ? parseInt(PHASE_ARG.slice('--phase='.length), 10) : null;
// Phase 1 has no seam to stand in once the desk and the hub are one process (Law 25).
if (PHASE === 1) {
  console.error('foreman_probe: --phase=1 cannot run. The desk and the hub are one process, '
    + 'so there is no socket between them for the stand-in to sit on. Use --phase=2.');
  process.exit(1);
}
// Phase 2 raises the fleet through fleet_control verbs the fleet does not have. Refused until rebuilt on
// `bench_world.up`.
if (PHASE === 2) {
  console.error('foreman_probe: --phase=2 cannot run. It raises the fleet through fleet_control '
    + 'verbs that do not exist — the foreman owns startup; it has to be rebuilt on bench_world first.');
  process.exit(1);
}
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

// When this probe started (Invariant B — see V15's siting check).
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

// A fault in the probe's own mineflayer clients is a TERMINUS: it records what killed the run, writes
// every verdict already measured, and exits (Law 25). The catch is the boundary translator (Law 16).
//
// A TERMINUS IS STILL A TEARDOWN (Law 8): the sweep is the launcher's own `verb exit`, the route the
// successful path also uses (Law 16).
let RAISED = { foreman: null, hub: false, crew: false };
let dying = false;
async function dieHonestly(kind, err) {
  if (dying) return;   // a second fault does not restart the record
  dying = true;
  const detail = err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err);
  record('PROBE', `Did the probe's own instrument survive the run? (${kind})`, detail,
    'NO — the probe process was killed by a fault inside a third-party client library, not by anything '
    + 'the fleet did. Every verdict above was measured before this and stands; every question after it '
    + 'was never asked. Re-run to reach them.');
  writeFindings({ killedBy: { kind, detail } });   // written before the sweep, which can hang
  if (RAISED.crew) {
    console.log('teardown: sweeping the crew this run raised...');
    const swept = await Promise.race([runFleetControl(['verb', 'exit']).then(() => true), sleep(20000).then(() => false)]);
    console.log(swept ? 'teardown: crew swept.' : 'teardown: the sweep did not answer in 20s — check for bots left in the world.');
  }
  if (RAISED.foreman) { RAISED.foreman.kill(); console.log('teardown: foreman taken down (this run raised it).'); }
  if (RAISED.hub) { await runFleetControl(['down', '--keep-server']); }
  process.exit(1);
}
process.on('uncaughtException', e => dieHonestly('uncaughtException', e));
process.on('unhandledRejection', e => dieHonestly('unhandledRejection', e));

async function main() {
  const creds = rconLink.readServerProperties();
  const rcon = await rconLink.open(creds);
  const cmd = async c => (await rcon.command(c) || '').trim();
  console.log(`server: rcon up on ${creds.port}.`);

  // The clock is held at dawn for the whole run — no hostiles around the idle player clients (Law 19).
  await cmd('time set 0');
  await cmd('gamerule advance_time false');
  console.log('server: clock held at dawn, daylight cycle off — no hostiles for the length of the run.');

  // The foreman raised first. `foreman-launch` reuses a live one (Law 8).
  // Phase 1 puts a stand-in where the foreman's in-game door would be and raises nothing else, so this
  // phase measures the production desk (Law 25).
  let standin = null;
  let foremanProcessWasUp = false;
  if (PHASE === 1) {
    if (await portOpen(3001)) {
      console.error('phase 1 needs the foreman DOWN — its in-game door is the seam this phase stands in for.');
      console.error('Something is serving 3001. Take the fleet down, or run --phase=2 against it.');
      rcon.close(); process.exit(1);
    }
    standin = require('./foreman_door_standin').start({ foremanPort: 3001 });
    console.log(`phase 1: stand-in door up on ${standin.port} — no foreman, no bots behind it.`);
  } else {
    foremanProcessWasUp = await portOpen(3001);
    if (!foremanProcessWasUp) {
      await runFleetControl(['foreman-launch']);
      for (let i = 0; i < 20 && !(await portOpen(3001)); i++) await sleep(1000);
    }
    RAISED.hub = !foremanProcessWasUp;
    // The hub lives in the foreman's process, confirmed through the launcher's own step.
    if (!foremanProcessWasUp) await runFleetControl(['foreman-start']);
    const foremanUp = await portOpen(3001);
    console.log(`foreman: ${foremanUp ? (foremanProcessWasUp ? 'already up — reused.' : 'raised by this probe.') : 'DID NOT COME UP.'}`);
    if (!foremanUp) { rcon.close(); process.exit(1); }
  }

  // A foreman already standing is reused: it holds a fixed player slot. Its console cannot be read when
  // reused; V4 falls back to the fleet's own registry.
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

  // Two humans, for the ownership questions.
  async function joinHuman(name) {
    const b = mineflayer.createBot({ host: 'localhost', port: 25565, username: name, version: VERSION, auth: 'offline' });
    b.on('error', e => console.log(`${name} ERROR:`, e.message));
    const heard = [];
    b.on('messagestr', s => heard.push({ text: s, at: Date.now() }));
    await new Promise(res => b.once('spawn', res));
    await sleep(2500);

    // ── AND THEN OUT OF WORLD SPAWN, BEFORE ANYTHING IS SAID ──────────────────────────────────────
    // The desk refuses `get` within `PERSON_CLEAR_OF_SPAWN` of world spawn (foreman.js). This probe
    // meets that same real rule (Law 26).
    const clearOf = require(paths.bot('Thinking_fragments/architect_config.js')).PERSON_CLEAR_OF_SPAWN;
    const aim = clearOf * 2;
    await cmd(`/spreadplayers ${aim} ${aim} 8 ${aim + clearOf} false ${name}`);
    await sleep(1500);
    const landed = await rconLink.entityPos(name);
    console.log(`human: ${name} spawned and stepped clear of world spawn -> ${landed ? `(${landed.x},${landed.y},${landed.z})` : 'position unknown'}`
      + ` (the desk needs ${clearOf}b, or every crew question below reads as a refusal).`);
    // Replies addressed to this player, by name.
    const answersTo = lines => lines.filter(l => l.startsWith('<Foreman>') && l.includes(`${name}:`));

    // ── THE WINDOW IS A CAP, NOT A TARGET ─────────────────────────────────────────────────────────
    // Waits for QUIET, not the first line — the desk paces multi-line answers. A silence question
    // (V2, V5) still pays the full window (Law 25).
    const QUIET_MS = 1500;   // > the desk's ~1 line/sec pacing
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
  // An answer carrying a violation, a stack, or "that failed" is graded as the failure it is (Law 25).
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
  // Species witnessed by the launcher's console line, or the foreman's registry for a reused foreman
  // (Law 25).
  // ── PHASE 2 OPENS HERE. `get` starts an OS process (Law 16: fleet_control owns every launch).
  let ownerCrew = async () => [];
  let registeredContractors = [];   // [], never undefined: an unfilled phase reads as "none" (Law 13)
  if (PHASE === 2) {
  RAISED.crew = true;   // set BEFORE the words are said: a crash mid-fetch still leaves bots to sweep
  const v4 = await say('foreman get', 20000);
  await sleep(6000);
  const players = await cmd('list');
  const stampedContractor = /starting as CONTRACTOR/i.test(foremanSaid());
  // The probe's own door call is a boundary (Law 16). Retried: registration lags joining (Invariant B).
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
  // A name in the world that never registered is a zombie: alive, unreachable by any operator verb
  // (Law 25).
  const worldList = players.toLowerCase();
  const inWorldNotRegistered = Object.keys(BOT_SENIORITY)
    .filter(id => worldList.includes(id.toLowerCase()) && !registeredContractors.includes(id));
  record('V4', `Does \`foreman get\` fetch a WHOLE crew of ${CREW_SIZE}, every one of them a live CONTRACTOR?`,
    `world said: ${JSON.stringify(v4)} | launcher stamp in the foreman window: ${foreman ? stampedContractor : 'n/a (reused foreman — its console is its own window)'} `
    + `| registered with the foreman as ${HUMAN}'s contractors: ${JSON.stringify(registeredContractors)} `
    + `| in the world but NOT registered: ${JSON.stringify(inWorldNotRegistered)} | server player list: ${players}`,
    registeredContractors.length >= CREW_SIZE && inWorldNotRegistered.length === 0
      ? `YES — all ${CREW_SIZE} came up, and the foreman holds every one of them as this player's CONTRACTOR. Every bot the foreman gets is a contractor by construction; there is no other spawn path in it.`
      : inWorldNotRegistered.length
        ? `NO — ${JSON.stringify(inWorldNotRegistered)} holds a player slot and never registered. That is a bot that JOINED and never came up: its process is alive, it emitted no spawn, and no operator verb can reach it because delivery runs off the registry it is not in — so it cannot be exited, and its name cannot be handed to anyone else (Law 8). The usual cause is a login onto a corpse: a player whose last life ended dead never receives spawn, and \`tools/fleet_revive.js\` is the one thing that can repair it, from outside the process the corpse prevents from starting.`
        : `NO — only ${registeredContractors.length} of ${CREW_SIZE} registered and nothing else is holding a name. The crew is short, and a half crew cannot share the work a crew is defined by.`);

  // ── V4b — THE ONE VERB WHOSE CONSEQUENCE IS INVISIBLE FROM THE WORLD ─────────────────────────
  // `flush` deletes what the fleet knows (Law 25). It also puts this run on cold ground for V15's
  // siting check (Invariant B).
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
  // A console announcement raises the same `chat` event a player does (Law 16).
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
  // Who is in the world is asked of the server, never of the foreman (Law 26).
  const inWorld = async (name) => (await cmd('list')).toLowerCase().includes(name.toLowerCase());

  // A verdict that depends on a reply is VOID unless the clerk still holds its player slot (Law 25).
  const clerkAlive = async () => (await cmd('list')).includes(FOREMAN_NAME);
  async function recordAnswered(id, question, observed, verdict) {
    if (await clerkAlive()) { record(id, question, observed, verdict); return; }
    record(id, question, `${observed} | THE FOREMAN IS NO LONGER IN THE WORLD`,
      'VOID — the clerk had left the server before this question could be answered, so the silence here is '
      + 'the probe listening to nobody. Read the foreman window in the findings file for why it left. Every '
      + 'question from that point on is void, not failed — nothing about the fleet was measured.');
  }

  // ── V6-V15: THE COMMAND SYSTEM AND THE TWO ENDS OF A CONTRACTOR'S LIFE ──────────────────────
  // Fleet questions, every one — decided inside the foreman and a body, so phase 1 has nothing to
  // observe (Law 16, Law 25).
  if (PHASE === 1) {
    console.log('phase 1: V6-V15 are fleet questions — skipped. No crew is fetched; nothing is started.');
  } else {

  // ── V6 — does the help offer EVERY verb, and does it price the expensive one? ──────────────────
  // The verb set is read from the fleet (Law 16); the flush clause is checked on its own (Law 25).
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
  // No bot is named — one word reaches all of the speaker's bots.
  const v7 = await say('foreman start', 9000);
  const v7line = answersTo(v7).join(' ');
  await recordAnswered('V7', 'Does a bare `foreman start` reach the speaker\'s bots through the in-game door?',
    `world said: ${JSON.stringify(v7)}`,
    /sent to your \d+ bot/i.test(v7line)
      ? 'DELIVERED — one unaddressed word crossed the in-game door and the foreman reported how many of the SPEAKER\'S bots it reached. This is DELIVERY, not proof the bot began planning: nothing observable from outside the process says that, and the foreman\'s wording does not claim it.'
      : `NOT DELIVERED — ${v7line || 'no answer'}. Either the door is not listening, the bot never registered with the foreman, or the ownership filter matched nobody.`);

  // ── V8 — THE OWNERSHIP CONTROL. A second person must not command the first person's bot. ──────
  // The control that makes V7 mean anything. Graded on the server's player list as well as the reply.
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
          ? `CONTROL HOLDS — B said the identical words and was refused by ownership ("${v8line.slice(0, 120)}"). A's bot is still in the world. The filter is the foreman's delivery set, read off the owner each bot declared at birth — not anything the foreman decides.`
          : `PARTIAL — B's command did not touch A's bot, but the refusal did not name ownership ("${v8line.slice(0, 120)}"). The bot is safe for a reason this probe cannot identify.`);

  // ── V9 — the owner's own exit, graded on the SERVER'S player list ─────────────────────────────
  // Asked of the whole crew: the verb's promise is every one of the owner's bots, nothing else (Law 25).
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
  // A door that answers "done" when it reached nobody makes every success worthless (Law 25).
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
  // The cap is read from the fleet's own table (Law 16).
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
  // Started from the TERMINAL, then commanded from inside the world with the verb that worked on a
  // contractor.
  //
  // The speaker's own bots are sent home first, so the homesteader is the only thing the verb could
  // reach.
  await say('foreman exit', 12000);
  await sleep(6000);

  // The refusal must name the species for the control to hold (Law 25).
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
  // The console is outside the ownership model — the verb V12 just watched bounce must take the same
  // bot down.
  const beforeOverride = await inWorld(HOMESTEADER_NAME);
  await runFleetControl(['verb', 'exit']);
  for (let i = 0; i < 20 && (await inWorld(HOMESTEADER_NAME)); i++) await sleep(1000);
  const afterOverride = await inWorld(HOMESTEADER_NAME);
  record('V13', 'OVERRIDE — does the TERMINAL reach a bot no human in the world could command?',
    `homesteader present before: ${beforeOverride} | present after terminal exit: ${afterOverride} | server list: ${await cmd('list')}`,
    !beforeOverride
      ? 'INCONCLUSIVE — nothing was standing to be overridden. See V12.'
      : !afterOverride
        ? 'YES — the same word V12 watched a human say and be refused took the bot down from the console. The two are separated by WHICH DOOR the words arrived through, which the foreman observes; the operator is outside the ownership model rather than a bigger owner inside it.'
        : 'NO — the console said exit and the bot stayed. The operator has lost the one route that always reaches every species, and there is now no way to stop a homesteader from outside its own process.');

  // ═══ WHERE A CONTRACTOR STANDS — AT BIRTH, AND AFTER DYING ════════════════════════════════════
  // Asked of the SERVER's own entity data, never of the bot (Law 26).
  const v14 = await say('foreman get', 22000);
  await sleep(6000);
  // The subject is a bot that actually came up, not a name decided in advance (Law 25 — see V4).
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
  // transpose_origin exists, before any wall does.
  await say('foreman start', 8000);
  // The lock must be THIS RUN'S — `locked_at` tells it from a previous run's (Invariant B).
  const HQ_FILE = path.join(BOT_DIR, 'js_kernel', `corporate_headquarters.${SUBJECT}.json`);
  const sitedCentre = () => {
    if (!fs.existsSync(HQ_FILE)) return null;
    // The room key carries an owner (`contractor_house|<owner>`); matched by structure name here.
    const rooms = JSON.parse(fs.readFileSync(HQ_FILE, 'utf8'))?.building_confrence_room || {};
    const roomKey = Object.keys(rooms).find(k => k === 'contractor_house' || k.startsWith('contractor_house|'));
    const spot = roomKey ? rooms[roomKey]?.set_buildspot : null;
    const c = spot?.transpose_origin;
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
    // Long enough for the board to sweep, post the recovery job, click respawn and land the teleport
    // (Law 4).
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
  // A body killed and then LOGGED OUT never receives `spawn` on the next login, so it never registers
  // (Law 8).
  //
  // Graded on the registry, not the player list — a zombie IS in the world and never registers.
  await say('foreman exit', 10000);
  await sleep(3000);
  const corpseSubject = SUBJECT;
  await cmd(`kill ${corpseSubject}`);      // kills the BODY; the process is already gone
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

  // The replacement crew is put back to work: the request block downstream needs one already out.
  await say('foreman start', 9000);
  }

  // ═══ THE REQUEST SYSTEM ═══════════════════════════════════════════════════════════════════════
  // Asked with a crew already out and already working.

  // What the crew itself holds, read off each bot's own kernel file (Law 26). Parse is guarded and
  // retried: a living bot rewrites these files while this reads them (Law 16).
  async function crewLedger(owner) {
    // ── WHICH WITNESS ANSWERS "WAS IT FILED" DEPENDS ON WHAT IS STANDING ────────────────────────────
    // Phase 1 has no crew kernel files, so it reads the stand-in's ledger — a real postcondition, the
    // fleet's own `request_ledger` rules run by a separate process (Law 26). `measured` stays empty in
    // phase 1: only a crew holding an owner key can measure progress (Law 25).
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

  // A wait for the broadcast that only exists in phase 2.
  const propagate = (ms) => (PHASE === 1 ? Promise.resolve() : sleep(ms));

  // What a verdict may call the thing it read (Law 25, Law 24).
  const heldBy = () => (PHASE === 1 ? 'the fleet ledger behind the door' : "the crew's own kernel files");

  const ask = async (who, line, waitMs = 12000) => who.answersTo(await who.say(line, waitMs)).join(' ');
  const statusOf = who => ask(who, 'foreman request', 14000);

  // A known empty ledger before the first question (Invariant B).
  await ask(a, 'foreman cancel all', 8000);
  await ask(b, 'foreman cancel all', 8000);

  // ── V16 — is the catalogue the fleet's own, or a list the desk keeps? ─────────────────────────
  // Graded against the catalogue computed here from the same tables the fleet walks (Law 16).
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
  // The postcondition is the crew's kernel file, not the reply (Law 25).
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
  // The desk's whole forgiveness: the same word said singular or plural resolves, nothing else does.
  const v19a = await ask(a, 'foreman request 5 log', 9000);        // singular of a family token
  const v19b = await ask(a, 'foreman request 5 doors', 9000);      // plural of a singular token
  const v19c = await ask(a, 'foreman request 5 plank', 9000);      // singular of another family
  const singularTook = v19a.includes('5 logs');
  const pluralTook = v19b.includes('5 door');
  const plankTook = v19c.includes('5 planks');
  // A family is said to be a family: the fleet picks the species by abundance (Law 25).
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
  // The control that keeps V19 honest. The ledger is read as well as the reply (Law 25). Also checked
  // for pointing at the list (Law 24).
  const v19dBefore = await crewLedger(HUMAN);
  const v19d = await ask(a, 'foreman request 5 logdsf', 9000);
  const v19e = await ask(a, 'foreman request 5 cobblestne', 9000);
  await propagate(4000);
  const v19dAfter = await crewLedger(HUMAN);
  const refusedBoth = !v19d.includes('right — 5') && !v19e.includes('right — 5');
  // Measured by item name, never by row count: a ledger with living writers is always moving (Law 25).
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
  // Measured against computed sources — every good the fleet's walk admits, every family token the desk
  // takes — in both directions: an omitted accepted word, and a named refused one (Law 25).
  const v19f = (await say('foreman can i get', 12000)).join(' ');
  const catalogue = require(paths.bot('js_kernel/requestable_catalogue'));
  // Graded against the whitelist, not the requirement ladders (a different fact — Law 16).
  const { REQUESTABLE_STRUCTURES } = require(paths.bot('Thinking_fragments/architect_config'));
  const raisable = [...REQUESTABLE_STRUCTURES];
  const goods = catalogue.requestableItems().filter(i => !catalogue.isBlueprint(i));
  const { group_to_item } = require(paths.bot('js_kernel/utils/fragment_utils'));
  const listedGoods = new Set(goods);
  const families = Object.keys(group_to_item).filter(t => !listedGoods.has(t) && catalogue.isRequestable(t).ok);
  const missingGoods = goods.filter(i => !v19f.includes(i));
  const missingFamilies = families.filter(f => !v19f.includes(f));
  const missingBuildings = raisable.filter(f => !v19f.includes(f));
  // Names that must not appear come from the registry, not the catalogue under test (Law 26).
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
  // Two halves: the wording, and whether the catalogue's write gate actually held (Law 25).
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
  // Words reversed, a zero, a negative (Law 13: never default a field). Measured as a ledger difference,
  // never against a list of expected rows.
  const malformed = ['foreman request logs 20', 'foreman request 0 logs', 'foreman request -3 logs', 'foreman request 2.5 logs'];
  const led21Before = await crewLedger(HUMAN);
  const keyOf = r => `${r.bot}|${r.key}|${r.quantity}`;
  const beforeKeys = new Set(led21Before.rows.map(keyOf));
  const badReplies = [];
  for (const line of malformed) badReplies.push(await ask(a, line, 8000));
  await propagate(5000);
  const led21 = await crewLedger(HUMAN);
  const junk = led21.rows.filter(r => !beforeKeys.has(keyOf(r)));
  // Graded on the correction, not one usage line — each of the four is told its own working sentence
  // (Law 24).
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
  // Graded on whether A's rows SURVIVE. Void unless A actually holds a row when B speaks (Law 25).
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
  // The load-bearing half is the second: silence must be reported as silence, never a zero (Law 25).
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
  // Graded on the crew's OWN chair as well as the reply. Void in phase 1: no crew, no party to measure
  // the figure (Law 25).
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
        ? 'NO — the crew measured its requests and wrote them to its chair, and the desk still says nothing. The measurement exists and the relay is where it stops: the chair reaches the foreman, or the foreman picks the freshest per item, and one of those two is not happening.'
        : 'NO — no crew chair carries a measurement at all, so nothing was there to relay. The body never measured its own requests; the desk\'s silence is honest and the fault is upstream of it.');

  // ── V25 — a structure is a STAGE, never a count ───────────────────────────────────────────────
  // A building is a second namespace; the same verb is answered by a different organ. Asked with no
  // number, the only form a building takes (see V29).
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
  // A person's mistake is neither a throw nor a soft-fail: the desk CORRECTS — refuses, names the cause,
  // says what would have worked (Law 13).
  //
  // Each question below is graded on both halves — nothing filed (the crew's kernel files) and a working
  // sentence (the reply) — measured per item, never by row count (Law 25).
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
  // Only one headframe can ever exist.
  const v29 = await askBad('foreman request 10 headframe');
  const v29Explains = /isn't a quantity|one headframe/.test(v29.said);
  const v29Teaches = /foreman request headframe/.test(v29.said);
  // The postcondition is the number, not row presence (V25 legitimately left one standing).
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
  // Asked of the fleet, not a tally the desk keeps (Invariant B). Void unless the first headframe is
  // actually outstanding when the second is asked (Law 25).
  const v30Pre = await crewLedger(HUMAN);
  const headframeStanding = v30Pre.rows.some(r => r.item === 'headframe');
  const v30 = await askBad('foreman request headframe');
  const v30Stage = /(not started|sited|pasted)/.test(v30.said);
  const v30Already = /already on the/.test(v30.said);
  // A duplicate is counted within the item: the ledger keys a row by owner and item.
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
  // The mirror of V29.
  const v31 = await askBad('foreman request oak_log');
  const v31Explains = /material|how many/.test(v31.said);
  const v31Teaches = /foreman request 20 oak_log/.test(v31.said);
  // The postcondition is that the standing number (outstanding since V18) did not move.
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
  // Most structures ATTACH to another and cannot be raised alone (Law 25).
  // The target comes from the registry.
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
  // Asked across every refusal this run collected. The measure is one property: the remedy names a
  // COMMAND the person can type (Law 24).
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
  // The second half is the honest-zero (Law 25).
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
  // A request is a fact written down, not a command delivered.
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
  // The empty case, its own question (Invariant B). Doubles as this probe's cleanup (Law 8).
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
  // Phase 2 ends here, on the ledger, not the clock: whether a filed requirement is MET by work.
  //
  // The end condition is the REQUEST LEDGER (`requested_work.requestProgress`, Law 16), never fleet
  // idleness — a still board may simply be held at the gates until dawn (Law 25). The idle state is
  // read only to EXPLAIN an unmet run.
  //
  // The cap is a referee and is named as one (Law 27): a bounded wait with an honest report of what was
  // still outstanding.
  if (PHASE === 2) {
    const WATCH_MS = 25 * 60 * 1000;   // the bound, not a target — a run that needs it has already failed
    const POLL_MS = 15 * 1000;
    const started = Date.now();

    // WHAT THE FLEET SAYS IT IS DOING WHEN IT IS DOING NOTHING. `jobs_held` is written by every sweep
    // (job_board), so this reads the board's own verdict instead of inferring one from stillness.
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
      // A row with NO measurement is outstanding, not met (Law 25: an absent figure is never a zero).
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
  // `verb exit` from the TERMINAL reaches both species; idempotent with V13.
  await runFleetControl(['verb', 'exit']);
  // The foreman comes down only if this probe raised it (Law 8).
  if (!foremanProcessWasUp) {
    await runFleetControl(['down', '--keep-server']);
    console.log('foreman: taken down (this probe raised it).');
  } else {
    console.log('foreman: left up (it was already running before this probe).');
  }
  // The stand-in was raised by this run and is taken down by it (Law 8).
  if (standin) { await standin.close(); console.log('phase 1: stand-in door closed.'); }
  rcon.close();
  human.quit();
  b.bot.quit();
  // The clerk comes down only if this probe stood it up (Law 8).
  if (foreman) foreman.kill();
  else console.log('foreman: left standing (it was already in the world before this probe).');
  setTimeout(() => process.exit(0), 1500);
}

// The same terminus as an uncaught fault (Law 16, Law 8).
main().catch(e => dieHonestly('threw out of main', e));
