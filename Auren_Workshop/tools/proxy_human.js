'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/proxy_human.js');
// tool: proxy_human — A PERSON IN THE WORLD, TYPING FROM THE TERMINAL.
//
//   "im not always at a computer so is it possible to make a proxy human that i can type commands into
//    the terminal and that goes straight into the chat so i can control bots and the foreman without
//    opening the game?"   — Architect, 2026-09-01
//
// It joins the server as an ordinary player, puts a prompt in the terminal, and sends every line typed
// there into open chat. Everything the world says comes back up the same terminal. Nothing about the
// fleet changes to accommodate it, and nothing needs to: from the server's side this IS a person.
//
// ── WHY RCON CANNOT DO THIS, WHICH IS THE WHOLE REASON THE FILE EXISTS ────────────────────────────
// `tools/rcon_cmd.js` already reaches the server console and `/say` already puts words in chat, so the
// obvious answer is that this is a duplicate of something we have. It is not, and the reason is a
// deliberate refusal built into the desk. `foreman_channel` reads the WIRE rather than the chat event,
// because chat_probe's C4 finding was that a console `/say` raises the same high-level event as a human
// and arrives as the player `Rcon` — so an event-level desk would take orders from anything that could
// reach the console. It reads `player_chat` and only `player_chat`; the console arrives as
// `profileless_chat` and is ignored without comment.
//
// That refusal is correct and stays. The consequence is that THE ONLY WAY TO SPEAK TO THE FOREMAN IS TO
// HOLD A PLAYER SLOT, and holding a player slot is exactly what this does. `bot.chat()` emits the same
// serverbound packet a keyboard does; the server cannot tell them apart, which is why the proxy is
// legitimate rather than a bypass. Nothing about the sender is authored (chat_probe's own header states
// this reasoning where it was first established, and this file is its operational form).
//
// ── WHOSE NAME IT WEARS, AND WHY THAT IS NOT COSMETIC ─────────────────────────────────────────────
// Every contractor belongs to the person who asked for it. `botStart` refuses an ownerless contractor
// outright, the delivery filter routes a verb only to the asker's own crew, and `wipe` reaches only the
// speaker's own places. All of that keys on the NAME the desk heard. So a proxy joining under some
// invented name raises a crew belonging to a stranger — and the moment the Architect walks in under his
// own name, `foreman stop` reaches nothing and the bots he is looking at are not his.
//
// The name is therefore READ from the server's own ops list rather than spelled here: the server already
// records who the human operator is, and a second spelling in tracked code would be a second answer to
// the same question (Law 16) — and one that would be wrong the day the name changes. Bots and the desk
// are filtered out by roster, because an op that is on the bot roster is not a person.
//
// A NAME HOLDS EXACTLY ONE CONNECTION, so this refuses to join while that human is already in the game,
// and says so in those words. That is the right outcome rather than a limitation: he is at the keyboard
// or he is at the terminal, and a second body wearing his name would be a second owner of his crew.
//
// ── WHAT IT DOES NOT DO, DELIBERATELY ─────────────────────────────────────────────────────────────
// It has NO VOCABULARY OF ITS OWN. It does not know what `foreman get` means, does not validate a verb,
// does not complete a command and does not print a help page for the desk. Every line goes to chat
// verbatim, because the foreman's vocabulary has exactly one owner (`foreman_vocabulary`) and a second
// copy in a terminal client would be a help page that drifts out of step with the desk it describes
// (Law 16, Law 25). Ask the desk itself: type `foreman help`.
//
// A LEADING `/` IS A SERVER COMMAND, and that comes free — mineflayer routes it as one. Joined under an
// op's name it is a full console as well as a mouth, which is what makes `/tp`, `/time set`, `/gamemode`
// available from the same prompt without a second tool.
//
// Run (the server must be UP; the fleet need not be):
//   . .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; & $n Auren_Workshop\tools\proxy_human.js
//   options:  --as=<name>   join under this name instead of the op the server names
//             --quiet       show only chat; drop the server's system lines (deaths, joins, /say)
//             --stand="<x> <y> <z>"  start the body at this cell instead of wherever the server spawns
//                           it; the ground test then runs FROM there and may still move it a few blocks
//   leave:    :quit, Ctrl-C, or Ctrl-D

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const paths = require('../workshop_paths');
const TOOLS_DIR = __dirname;

// The alias table every fragment is written against, registered the way master_core registers it rather
// than by rewriting requires to relative paths (contractor_standard_run's arrangement, same reason).
// Called directly since 2026-09-10 — see contractor_standard_run.js for why the wrapper went.
paths.registerAliases();

// NAMES A RECORD, NOT A MANDATE — the foreman's own arrangement, and for the same reason. The boundary
// guard below warns through the watcher, and the watcher resolves its filename once at load. Naming the
// unit here sends those warnings to `watcher_proxy_human.jsonl` instead of the unnamed `watcher.jsonl`,
// and above all keeps them out of a roster bot's live trace — the one thing alias_boot's header names as
// still harmful. It is swept with every other run artifact at the next bring-up, as it should be.
process.env.BOT_ID = process.env.BOT_ID || 'proxy_human';

const { guardExternalSync } = require('@utils/external_library_guard');
const { BOT_SENIORITY, FOREMAN_NAME, FOREMAN_PREFIX, ACCEPTABLE_BIOMES, PERSON_CLEAR_OF_SPAWN } = require('@thinking/architect_config');

// ── THE FLEET'S OWN EYES, NOT A SECOND OPINION (Law 16, and seed_scanner's own rule) ────────────────
// `--stand=biome` reads the biome with `@perception/biome_scanner` — the same node the bots survey with
// — and judges it against `ACCEPTABLE_BIOMES`, the same set `find_buildingspot` gates on. A world vetted
// here with anything else would be vetted with an opinion the fleet does not hold. The scanner REPORTS
// and decides nothing (Law 0); the choosing is this file's and is written out in `placeInBiome`.
const { getBiomeName } = require('@perception/biome_scanner');
const watcher = require('@kernel/watcher');
const { armSpawnProtection, spawnProtectionBox } = require('@perception/spawn_protection');

// WHERE THE PACKAGES LIVE IS ASKED, NEVER ASSUMED. The portable node distribution differs per machine and
// is git-ignored, so a bare `require('mineflayer')` resolves on whichever workstation happened to write
// the line and nowhere else (foreman_probe's own scar; contractor_standard_run carries the full note).
const moduleHomes = require('@utils/node_module_homes');
const MODULE_DIRS = moduleHomes.bootstrapModulePath();
if (MODULE_DIRS.length === 0) {
  console.error('proxy_human: no module home found — mineflayer cannot resolve. Checked: '
    + moduleHomes.CANDIDATE_HOMES.join(', '));
  process.exit(1);
}
for (const d of MODULE_DIRS) module.paths.unshift(d);
const mineflayer = moduleHomes.requireFromHomes('mineflayer');

const TAG = 'proxy_human';
const SERVER_DIR = require(paths.bot('js_kernel/utils/workstation')).needServerDir();

const args = process.argv.slice(2);
const has = k => args.includes(`--${k}`);
const opt = (k, fallback) => {
  const hit = args.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : fallback;
};

const HOST = opt('host', 'localhost');
const PORT = Number(opt('port', '25565'));
const VERSION = opt('version', '1.21.5');
const QUIET = has('quiet');

// The protocol's own cap. A line over it is refused a layer down, so it is refused HERE, out loud, with
// the length named — the alternative is a line that vanishes with no reason given, which from a terminal
// is indistinguishable from the server having gone deaf (Law 25).
const MAX_CHAT_LINE = 240;

// One line per second. Vanilla charges 20 ticks of spam credit per chat packet and refunds 1 per tick,
// kicking above 200 — so eleven lines sent at once is a kick, not a slow answer. A person typing never
// approaches that; a PASTED block of orders does, and pasting is the whole reason to be at a terminal
// instead of a keyboard. Paced here, the balance is constant no matter how much is pasted at once.
// (`foreman_channel` paces its own outbound half for the identical reason and owns the arithmetic; this
// is the other end of the same wire, and neither can pace the other's packets.)
const MS_BETWEEN_LINES = 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHOSE NAME
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// The roster is bots and the desk is staff; anyone else on the ops list is a person. Read rather than
// spelled, so the day the Architect's gamertag changes this file is already correct.
function humanOps() {
  const file = path.join(SERVER_DIR, 'ops.json');
  if (!fs.existsSync(file)) return { ops: [], why: `${file} does not exist — the server has no ops list yet` };
  const read = guardExternalSync(TAG, `reading ${file}`, () => JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!read.ok) return { ops: [], why: `ops.json could not be read (${read.reason})` };
  if (!Array.isArray(read.value)) return { ops: [], why: 'ops.json is not a list — the server writes one; a malformed file means it did not stop cleanly' };
  const notPeople = new Set([...Object.keys(BOT_SENIORITY), FOREMAN_NAME]);
  const ops = read.value.map(e => e && e.name).filter(n => typeof n === 'string' && !notPeople.has(n));
  return { ops, why: ops.length ? null : 'every op on the list is a fleet process — no human is named' };
}

function chooseName() {
  const asked = opt('as', null);
  if (asked) return { name: asked, source: '--as' };
  const { ops, why } = humanOps();
  if (!ops.length) {
    console.error(`proxy_human: cannot tell whose name to wear — ${why}.\n`
      + '  The name is not cosmetic: every contractor belongs to the person who asked for it, and a crew\n'
      + '  raised under the wrong name cannot be commanded by the right one. Say who you are:\n'
      + '    node Auren_Workshop/tools/proxy_human.js --as=<your minecraft name>\n');
    process.exit(1);
  }
  // The FIRST human op, and reported rather than chosen silently — a second person on the list is a real
  // possibility and picking one of them without saying so would hand somebody else's crew to whoever ran
  // this. `--as` is the answer when it picks wrong.
  if (ops.length > 1) {
    console.log(`proxy_human: ops.json names ${ops.length} people [${ops.join(', ')}] — joining as the first. `
      + 'Use --as=<name> for one of the others.');
  }
  return { name: ops[0], source: 'ops.json' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE TERMINAL
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

// Written so a printed line never lands on top of what is half-typed at the prompt: the line being
// composed is cleared, the message printed, the prompt redrawn with the composition restored. Without it
// a busy channel makes the prompt unusable, which is the difference between a tool and a demonstration.
// After the terminal is closed there is no prompt to redraw and no composition to protect, so it degrades
// to a plain write rather than reaching into a closed interface.
let terminalOpen = true;
// PLACEMENT DECISIONS GO INTO THE TRACE AS WELL AS THE TERMINAL (2026-09-11). `say` writes only this
// process's console, which no lens reads, so a run that failed on where the person stood could not say
// why: run four's survey ran, placed nobody, and the reason left with the console. Where the person was
// put, and why, is a fact about the run, so it is written where the lens reads (Law 26).
function record(text) { say(`proxy_human: ${text}`); watcher.summary(TAG, text); }

function say(text) {
  if (!terminalOpen) { process.stdout.write(text + '\n'); return; }
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(text + '\n');
  rl.prompt(true);
}

// ── THE OUTBOUND QUEUE, AND WHY IT IS GATED ON `spawn` RATHER THAN ON THE CONNECTION ─────────────
// A line typed (or piped) before the body is in the world has nowhere to go: `bot.chat` before spawn is
// a packet with no player behind it. So the queue holds until spawn and then drains at the pace below,
// which makes `echo "foreman get auren" | proxy_human` behave the same as typing it — the scripted case
// is the one that arrives before spawn every single time, and it is also the case a person not at a
// computer is most likely to reach for.
const outbound = [];
let pumping = false;
let spawned = false;
function pump() {
  if (!spawned) { pumping = false; return; }
  const next = outbound.shift();
  if (!next) { pumping = false; drained(); return; }
  pumping = true;
  next();
  const t = setTimeout(pump, MS_BETWEEN_LINES);
  if (t.unref) t.unref();   // Law 8: a pacing timer must never be the reason a process stays alive
}
function enqueue(send) {
  outbound.push(send);
  if (!pumping) pump();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE BODY
// ─────────────────────────────────────────────────────────────────────────────────────────────────

let bot = null;
let leaving = false;

// Law 8: one reaper, reached from every exit — the typed `:quit`, both signals, stdin closing, and the
// server hanging up.
function leave(why, code = 0) {
  if (leaving) return;
  leaving = true;
  say(`proxy_human: leaving (${why}).`);
  if (bot) guardExternalSync(TAG, 'disconnecting the proxy client', () => bot.quit());
  if (terminalOpen) { terminalOpen = false; rl.close(); }
  // A short grace so the quit packet is actually written before the process ends; the socket is the
  // server's evidence that the name is free again, and the next join is usually seconds away.
  setTimeout(() => process.exit(code), 400);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => leave(sig, 130));

// CLOSING THE TERMINAL IS NOT THE SAME ACT AS LEAVING THE WORLD, and conflating them is what made the
// piped case useless: stdin ends the instant a piped line is read, which is long before the body is in
// the world to say it. So a closed terminal only records that nothing more will be typed; the departure
// waits until everything typed has actually gone out.
// GATED ON `spawned` TOO, and that is not belt-and-braces: with stdin closed and nothing queued, the queue
// is trivially drained the instant it is asked, so an ungated check exits before the join has even
// resolved — and the process then reports "everything typed has been said" over a connection that was
// about to be refused. Waiting for the body means the exit reason is the true one either way.
let quitWhenDrained = false;
function drained() {
  if (quitWhenDrained && spawned && !leaving) leave('everything typed has been said');
}

const { name: USERNAME, source: NAME_SOURCE } = chooseName();

console.log(`\nproxy_human: joining ${HOST}:${PORT} as ${USERNAME} (${NAME_SOURCE}), version ${VERSION}.`);

const created = guardExternalSync(TAG, 'mineflayer.createBot for the proxy player', () =>
  mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION, auth: 'offline' }));
if (!created.ok) {
  console.error(`proxy_human: could not create the client — ${created.reason}`);
  process.exit(1);
}
bot = created.value;

// ARMED HERE AND NOWHERE LATER, because `spawn_position` arrives DURING login: a listener registered from
// the `spawn` handler is registered after the only packet it exists to catch, and the latch would read
// "unknown" for the whole run. That is `armSpawnProtection`'s own documented requirement, and this body
// needs the latch for the same reason a bot does — the square it must not be standing in is centred on a
// point only the server can name (Law 26: read the fact, never assume (0,0)).
armSpawnProtection(bot);

// THE REFUSED CONNECTION IS THE FIRST THING ANYONE MEETS, so it is named in words rather than left as
// the raw AggregateError node produces — which carries an empty `.message`, so the obvious handler prints
// nothing at all and the stack arrives instead. "There is no server" is an answer, not a crash, and it is
// the answer whenever this is reached before the run is up.
bot.on('error', e => {
  const code = e && e.code ? e.code : (e && Array.isArray(e.errors) && e.errors[0] ? e.errors[0].code : null);
  if (code === 'ECONNREFUSED') {
    say(`proxy_human: nothing is listening on ${HOST}:${PORT} — there is no world to stand in yet. `
      + 'Bring a run up first (`fleet_control.js run foreman-standard`), then start this.');
    return leave('no server', 1);
  }
  say(`proxy_human: connection error — ${e && e.message ? e.message : code || String(e)}`);
});
bot.on('end', () => { if (!leaving) leave('the server closed the connection', 1); });
bot.on('kicked', reason => {
  const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
  // The overwhelmingly common kick here is the name already being in use, and it is worth naming in
  // plain words rather than leaving as a raw server string: it means the person this proxy speaks for is
  // already standing in the world, which is not an error so much as an answer.
  if (/already|logged in|duplicate/i.test(text)) {
    say(`proxy_human: ${USERNAME} is ALREADY IN THE GAME. A name holds one connection, so the proxy `
      + 'cannot join while you are at the keyboard — you are already able to say all of this in chat.');
  } else {
    say(`proxy_human: kicked — ${text}`);
  }
  leave('kicked', 1);
});

// ── STANDING SOMEWHERE A BODY CAN ACTUALLY BE PUT ───────────────────────────────────────────────────
// (Architect 2026-09-10): *"the architect needs to be teleported to a valid standing spot. i think
// lanista does something like that we can reuse."*
//
// It does, and this is that reuse — one layer further in than lanista's own call. `lanista_biome` promotes
// a biome sample to a fact with `arena.findBotSpawn`, which is `site_geometry.evaluateOpenBox` at arena
// scale; the desk's new pre-launch refusal is the same test at BODY scale, `standingSpotNear`. This calls
// that one, so the ground this proxy stands on is judged by the identical code that decides whether a
// crew will be sent to it (Law 16).
//
// WHY IT MATTERS THAT THE PERSON IS PLACED WELL. A crew is teleported to the PERSON — the person's cell is
// the seed for the whole run, and the desk now refuses to launch when nothing beside them will hold a
// body. A faux person dropped at world spawn is dropped wherever the server chose: in water, on a
// one-block ledge, inside a tree. The refusal then fires correctly and the run dies with nothing built,
// which is a true report about ground nobody chose and a useless one about the fleet.
//
// IT MOVES ONLY WHEN IT HAS TO. `standingSpotNear` searches from radius 0 outward, so a proxy that landed
// on good ground gets its own cell back and no teleport is sent. Reported either way: a run whose person
// was moved 6 blocks is a different run from one whose person stood still, and the reader is owed which.
//
// A FAILED SEARCH IS NOT A FAILED PROXY. It says so and stays in the world, because the proxy's job is to
// hold a player slot and relay chat, and it does that standing in a lake. The refusal that matters
// belongs to the desk, which will decline the crew for the same reason in its own words — and letting
// that happen is the honest test of it, rather than this instrument pre-empting the thing under test.
//
// THE MOVE IS MEASURED, NOT ASSUMED. `/tp` from this prompt only carries if the name it joined under is
// an op, and nothing here can know that — `--as=architect` is a test harness's invention, not the server's
// op list. So the command is sent and then the body's OWN position is read back, and the report says
// which happened. Claiming a placement that a permissions check silently dropped would put the run's seed
// cell in a record that never matched the world (Law 25 / Law 26 — the client is the witness, not the
// command's return).
const PLACEMENT_RADIUS = 12;
// 10 s, not 2: the wait ends the instant the body lands, so the cap is only paid by a command that never
// lands. Run ten (2026-09-11) had its /tp to a correct biome spot miss a 2 s cap while the server logged
// "Can't keep up" on a freshly generating world — and the /spreadplayers right after it, which needs the
// same op, landed. A lagging server answers late; a 2 s cap read that lateness as a refusal.
const PLACEMENT_SETTLE_MS = 10000;
const PLACEMENT_POLL_MS = 100;
const PLACEMENT_RETRY_MS = 700;

// ── AN AUTHORED CELL IS APPLIED HERE, BEFORE THE GROUND TEST, AND NOT BY THE CALLER ─────────────────
// `--stand=<x> <y> <z>` exists because a caller teleporting the body ITSELF loses a race it cannot see
// (found 2026-09-10). `run.js` waits on `waitForPlayer`, which returns the instant the name appears in
// the server's player list — while this file's 'spawn' handler is still running `standOnGround`. So the
// caller's `tp` to the authored cell landed FIRST and this function's own `tp` landed second and won,
// silently discarding the `standing` field on the config page. Two writers, one body, no ordering.
//
// ONE WRITER NOW. The authored cell arrives as an argument, this function puts the body there, and only
// then asks whether that cell will hold a body. So `standing` is honoured, and it is still checked —
// which matters, because an authored coordinate is a guess about a world that gets rolled back and
// re-generated, and the whole point of the ground test is that nothing downstream can use a cell no body
// can stand in.
function authoredStand() {
  const raw = opt('stand', '').trim();
  if (!raw || raw.toLowerCase() === 'biome') return null;
  const n = raw.split(/[\s,]+/).map(Number);
  if (n.length !== 3 || n.some(v => !Number.isFinite(v))) {
    say(`proxy_human: --stand='${raw}' is not three numbers, so nothing was assumed — the body stays `
      + `where the server put it. Pass it as --stand="<x> <y> <z>", or --stand=biome to be placed `
      + `in the nearest good biome clear of world spawn.`);
    return null;
  }
  return { x: Math.floor(n[0]), y: Math.floor(n[1]), z: Math.floor(n[2]) };
}

const wantsBiomeStand = () => opt('stand', '').trim().toLowerCase() === 'biome';

// How long to let the destination's chunks arrive before reading the ground there. See the call site for
// why UNLOADED-read-as-ground is the failure this prevents.
const CHUNK_WAIT_MS = 8000;
const CHUNK_POLL_MS = 200;
async function waitForChunk(reader, cell) {
  for (const end = Date.now() + CHUNK_WAIT_MS; Date.now() < end;) {
    if (reader.flagsAt(cell.x, cell.y, cell.z) !== reader.UNLOADED) return true;
    await new Promise(r => setTimeout(r, CHUNK_POLL_MS));
  }
  return reader.flagsAt(cell.x, cell.y, cell.z) !== reader.UNLOADED;
}

// ── HOW FAR CLEAR OF WORLD SPAWN A LANDING CELL HAS TO BE ───────────────────────────────────────────
// Architect 2026-09-10: *"use biome scanner to place the architect bot away from world center into an
// ideal biome with teleport."*
//
// THE MEASUREMENT BEHIND THE NUMBER. Inside the spawn-protected square the server refuses every break
// and placement by a non-op and REPORTS NOTHING, so the fleet's own gate refuses before the swing and
// the crew makes no progress. Until this change, every cell this fleet ever started from was inside it:
// the six spawn-scattered cells on record in bugsquashing §14.10 and the (7,64,-9) pin used for the
// soak. That soak's warnings were dominated by it — `dig refused at (14,64,8)`, `(5,64,16)`, `(6,64,16)`
// — and TessaBot's stone work returned `0x cobblestone of 8 asked` twice.
//
// The base is sited AROUND the person and the crew digs around the base, so clearing the square by one
// block is not enough; the clearance has to cover the base's own footprint. The digs above reached ~16
// blocks from the person, so the margin is that again with room over. Chebyshev, because the protected
// region is a SQUARE — using Euclidean distance here would pass cells that sit inside a corner of it.
const BASE_MARGIN = 32;

// ── WHERE THE PERSON MUST END (Architect 2026-09-11) ────────────────────────────────────────────────
// *"it should be atleast 50 blocks away from world center"* — `floorFrom` is where the body must END,
// measured the same Chebyshev way as the square: PERSON_CLEAR_OF_SPAWN, or the base clearance above if
// that were ever the larger. A spot the biome search finds is already proven standable, so it is held to
// the floor itself. `clearanceFrom` adds PLACEMENT_RADIUS for the one BLIND move, `stepClearOfSpawn`:
// the ground there is unread, and the ground test that follows may still move the body that far back
// toward spawn.
function floorFrom(box) { return Math.max(PERSON_CLEAR_OF_SPAWN, box.radius + BASE_MARGIN); }
function clearanceFrom(box) { return floorFrom(box) + PLACEMENT_RADIUS; }
function fromSpawn(box, x, z) { return Math.max(Math.abs(x - box.centerX), Math.abs(z - box.centerZ)); }

// Reported honestly rather than defaulted (Law 13): a scan that finds nothing acceptable says which of
// the reasons applied, because "no good biome within reach" and "the world spawn is still unknown" are
// different worlds and want different responses. Either way the body is then stepped clear of spawn by
// `stepClearOfSpawn`, which runs after every kind of placement.
// ── THE SURVEY WAITS FOR THE WORLD, AND THE FIRST VERSION OF THIS DID NOT (measured 2026-09-10) ─────
// `biome_scanner.getBiomeName` returns null for a column `bot.world.getColumnAt` has never seen — a
// deliberate choice with its own note, because `getBiome` answers 0 for an unloaded column and biome 0
// in 1.21.5 is `badlands`, which is how a scan once reported four phantom badlands patches at the
// corners of its own sample square.
//
// So a survey run the instant the body spawns sees NOTHING: `--stand=biome found nowhere better than
// where the server put me — no acceptable biome in 0 patch(es). Found: nothing`, and the body stayed at
// (6,64,-6), inside the very square this exists to leave. The scan was correct and the world had not
// arrived yet.
//
// PROBED RATHER THAN RE-SCANNED. Polling `scanBiomes` until it returns something would work and would
// also write a `🌍 Biome scan` line into the trace every attempt, so the record would carry ten surveys
// for one decision. Five cheap reads answer the same question: the centre and four points out on the
// axes. ±120 rather than ±160 because the server streams a 21×21 chunk window (view-distance 10 = 160
// blocks), so the corners of the full sample square are past the edge of what will EVER load — waiting
// for them would always time out.
const SURVEY_PROBE_R = 120;
const SURVEY_WAIT_MS = 20000;
const SURVEY_POLL_MS = 500;
async function waitForSurveyArea(reader, at) {
  const probes = [
    { x: at.x, z: at.z },
    { x: at.x + SURVEY_PROBE_R, z: at.z }, { x: at.x - SURVEY_PROBE_R, z: at.z },
    { x: at.x, z: at.z + SURVEY_PROBE_R }, { x: at.x, z: at.z - SURVEY_PROBE_R },
  ];
  const loaded = () => probes.filter(p => reader.flagsAt(p.x, at.y, p.z) !== reader.UNLOADED).length;
  for (const end = Date.now() + SURVEY_WAIT_MS; Date.now() < end;) {
    if (loaded() === probes.length) return { ready: true, loaded: probes.length, of: probes.length };
    await new Promise(r => setTimeout(r, SURVEY_POLL_MS));
  }
  // A PARTIAL AREA IS STILL SURVEYED, and saying so is the point: the scan below reads whatever did
  // arrive, so the choice is made from less ground rather than from none. Reported, never silent.
  return { ready: false, loaded: loaded(), of: probes.length };
}

async function placeInBiome(reader, at) {
  const { ringScan, formatRejections, evaluateOpenBox, surfaceY, REASON } =
    require(path.join(paths.bot('js_kernel', 'utils'), 'site_geometry.js'));
  const box = spawnProtectionBox(bot);
  const area = await waitForSurveyArea(reader, at);
  if (!area.ready) {
    record(`only ${area.loaded} of ${area.of} survey probes had chunks after ${SURVEY_WAIT_MS}ms `
      + `— the biome choice below is made from the ground that did arrive.`);
  }
  // CLEARANCE IS MEASURED FROM THE REAL SQUARE, AND NO SQUARE MEANS NO CHOICE. A box of null means the
  // spawn packet has not arrived, and inventing a centre would put the person in the one place this is
  // trying to avoid — so the search declines and says why.
  if (!box) {
    record('--stand=biome found no spot — the world spawn is not known yet (no spawn_position packet received).');
    return false;
  }
  const from = floorFrom(box);

  // ── OUTWARD FROM THE LINE, AND THE FIRST SPOT THAT PASSES IS THE SPOT (Architect 2026-09-11) ──────
  // *"how about just search in a circle like you did and a spot only counts if the standing spot is in
  // the correct biome? with a 3 by 3 clearance centered around the bot"* — and just before it, *"as long
  // as its in the biome then its ok. edge of the biome is ok. as long as the bot can stand in the biome
  // with nothing blocking, and its not close to world spawn"*. So a spot is exactly three things:
  //   · at least `from` blocks from world spawn (Chebyshev, the protected square's own shape) — the
  //     sweep's `minRadius`;
  //   · a 3×3 floor centred on the person with 2 clear above every cell, read as-is — `evaluateOpenBox`,
  //     the same test the desk and the arena use (Law 16);
  //   · the biome AT THE FEET is acceptable — `biome_scanner.getBiomeName`, the one biome read.
  // `ringScan` walks outward from that line nearest-first and stops at the first spot, finishing only the
  // few rings that could still hold a closer one; a column with no chunk answers UNLOADED, which is how it
  // knows it has reached the edge of the map. The height comes from the ground it read, so the move is a
  // plain /tp to that block. It replaced a version that gathered every qualifying survey cell, sorted
  // them and took the first, and demanded 12 blocks of the same biome on every side (*"i dont know why
  // that 28 by 28 exists"*).
  //
  // THE SURFACE FIRST, THEN THE BOX. `evaluateOpenBox` finds each floor with `floorNearest`, the floor
  // nearest the reference height — and the only reference here is the body's height back at spawn, so a
  // cave floor at that level would beat grass 20 blocks above it. `surfaceY` (topmost ground) gives the
  // reference the box then reads from.
  const isSpot = (x, z) => {
    const top = surfaceY(reader, x, z, at.y);
    if (!top) return { valid: false, reason: reader.blockAt(x, at.y, z) === null ? REASON.UNLOADED : REASON.NO_FLOOR };
    const biome = getBiomeName(bot, x, top.y + 1, z);
    if (!ACCEPTABLE_BIOMES.has(biome)) return { valid: false, reason: 'wrong_biome' };
    const standing = evaluateOpenBox(reader, x, z, top.y, { size: 3, height: 2, occupancy: 'as-is' });
    return standing.valid ? { ...standing, biome } : standing;
  };
  const sweep = await ringScan(reader, { origin: { x: box.centerX, z: box.centerZ }, step: 1, minRadius: from }, isSpot);
  if (!sweep.found) {
    record(`--stand=biome found no spot ${from}+ blocks from world spawn in an acceptable biome with a clear `
      + `3x3 — ${formatRejections(sweep.rejections)} across ${sweep.checked} cell(s).`);
    return false;
  }
  const spot = { x: sweep.best.x, y: sweep.best.result.spawnY, z: sweep.best.z };
  if (await teleportTo(spot)) {
    record(`${USERNAME} was placed at (${spot.x},${spot.y},${spot.z}) — ${sweep.best.result.biome}, a clear 3x3, `
      + `${fromSpawn(box, spot.x, spot.z)} blocks from world spawn; the first spot out, after ${sweep.checked} cell(s).`);
    return true;
  }
  record(`the spot was found — (${spot.x},${spot.y},${spot.z}), ${sweep.best.result.biome} — but the /tp there, re-sent `
    + `every ${PLACEMENT_RETRY_MS}ms, had not moved the body after ${PLACEMENT_SETTLE_MS / 1000}s; it is still at ${whereAmI()}.`);
  return false;
}

// One teleport, re-issued while it has not landed, and the truth about whether it did.
//
// It is re-issued rather than sent once because `/tp` from a player prompt needs op, and the op is
// granted by the harness at almost the same moment this runs — a single command sent one tick early is
// refused with nothing to show for it. Re-sending costs a chat line and removes the ordering assumption.
async function commandUntilLanded(command, landed) {
  let next = 0;
  for (const end = Date.now() + PLACEMENT_SETTLE_MS; Date.now() < end;) {
    if (Date.now() >= next) {
      bot.chat(command);
      next = Date.now() + PLACEMENT_RETRY_MS;
    }
    await new Promise(r => setTimeout(r, PLACEMENT_POLL_MS));
    if (landed()) return true;
  }
  return landed();
}

async function teleportTo(cell) {
  return commandUntilLanded(`/tp ${USERNAME} ${cell.x + 0.5} ${cell.y} ${cell.z + 0.5}`, () => {
    const p = bot.entity && bot.entity.position;
    return !!p && Math.hypot(p.x - (cell.x + 0.5), p.z - (cell.z + 0.5)) <= 1.5;
  });
}

// THE SURFACE OF A COLUMN, CHOSEN BY THE SERVER — for a place whose X/Z is known and whose height is not
// (a surveyed biome column, a step out of spawn). `/spreadplayers` with no spread and a range of 1 puts
// the body on the top block of that column and refuses liquid or fire under the feet, so one command
// gives ground rather than a height guessed from somewhere else.
async function spreadTo(aim, landed = () => nearAim(aim)) {
  return commandUntilLanded(`/spreadplayers ${aim.x + 0.5} ${aim.z + 0.5} 0 1 false ${USERNAME}`, landed);
}
function nearAim(aim) {
  const q = bot.entity && bot.entity.position;
  return !!q && Math.max(Math.abs(q.x - (aim.x + 0.5)), Math.abs(q.z - (aim.z + 0.5))) <= 3;
}

function whereAmI() {
  const p = bot.entity && bot.entity.position;
  return p ? `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})` : '(?,?,?)';
}

// ── CLEAR OF WORLD SPAWN, WHATEVER CHOSE THE CELL (Architect 2026-09-11) ───────────────────────────
// *"you were supposed to have architect bot teleport away from world center before having it call
// foreman get… it should be atleast 50 blocks away from world center"*. The biome choice already aims
// past this, but when it found nothing the body was simply left where the server put it — world spawn —
// and that is what happened in BOTH runs of 2026-09-11: the crew was fetched to (-1,69,0) and the second
// run's soak died of `no_reachable_free_tree` inside the protected square. `standing: 'spawn'` and an
// authored cell near the centre land in the same place. So this runs after those two placements, and a
// body still inside the clearance is moved out. The biome placement does not use it: its search starts at
// the clearance line, and a blind step picks no biome (see standOnGround).
//
// `/spreadplayers` rather than `/tp`, because the target is ground this client has never streamed: the
// server picks the top block itself and refuses water and lava, so one command gives a surface to stand
// on. The eight aims are straight out along the axes and diagonals, tried in the order of the side the
// body already leans to (ties in list order), so the choice is the same every time for the same start.
async function stepClearOfSpawn() {
  const box = spawnProtectionBox(bot);
  const p = bot.entity && bot.entity.position;
  if (!p) return;
  if (!box) {
    record(`the world spawn is not known (no spawn_position packet received), so there is no centre `
      + `to step away from — the body stays at ${whereAmI()} and the run's distance check will refuse the crew.`);
    return;
  }
  // BLOCK coordinates, as the server and run.js count them. A /tp puts the body at the block's centre, so
  // at x = -50 the position reads -49.5 — 49.5 out as a float, 50 out as a block. Measuring the float made
  // this move a person the search had just placed exactly 50 out (run six: (-50,72,0) → (-65,69,64)).
  const was = fromSpawn(box, Math.floor(p.x), Math.floor(p.z));
  if (was >= floorFrom(box)) return;
  const need = clearanceFrom(box);
  const out = need + 2;                                      // spreadplayers lands within ~1.5 of its aim
  const ox = p.x - box.centerX, oz = p.z - box.centerZ;
  const aims = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    .map(([dx, dz], i) => ({ x: box.centerX + dx * out, z: box.centerZ + dz * out, lean: dx * ox + dz * oz, i }))
    .sort((a, b) => (b.lean - a.lean) || (a.i - b.i));
  for (const aim of aims) {
    const landed = () => nearAim(aim)
      && fromSpawn(box, Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.z)) >= need;
    if (await spreadTo(aim, landed)) {
      record(`${USERNAME} was ${was} blocks from world spawn (${box.centerX},${box.centerZ}) and must be ${need} out `
        + `before the ground test — moved straight out to ${whereAmI()}. The biome there was NOT chosen; only the `
        + `distance was.`);
      return;
    }
  }
  record(`none of ${aims.length} moves ${out} blocks out from world spawn landed — still at ${whereAmI()}, `
    + `${was} blocks out. Most likely '${USERNAME}' is not an op on this server, or every aimed spot was water or `
    + `lava (spreadplayers refuses both). The run's distance check will refuse the crew.`);
}

async function standOnGround() {
  const utils = paths.bot('js_kernel', 'utils');
  const { standingSpotNear } = require(path.join(utils, 'site_geometry.js'));
  const { makeVoxelReader } = require(path.join(utils, 'voxel_reader.js'));
  const reader = makeVoxelReader(bot);

  // ── THE BIOME CHOICE IS MADE HERE, FOR THE SAME REASON THE AUTHORED CELL IS (one writer, above) ──
  // It resolves to a COLUMN, the server puts the body on that column's surface (`spreadTo`), and the
  // ground test then runs from wherever the body actually ended up. So a scanned place gets the same proof
  // an authored one does — which matters more here, not less, because it was chosen from a biome map
  // rather than by him. It used to take the authored path, a `/tp` to a full cell, with the height taken
  // from the survey — which is the body's OWN altitude, not the ground's: on 2026-09-11 that sent the body
  // to (34.5,76,-79.5), it fell to (34,48,-80), and the desk found nowhere beside it to stand.
  //
  // The body's position is read BEFORE the choice, because the survey is centred on where the body
  // currently is and its chunk probes need somewhere to probe from.
  const start = bot.entity && bot.entity.position;
  let authored = authoredStand();
  const biomeMode = !authored && wantsBiomeStand() && !!start;
  let placedInBiome = false;
  if (biomeMode) {
    const from = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
    placedInBiome = await placeInBiome(reader, from);
  }
  if (authored) {
    const put = await teleportTo(authored);
    say(put
      ? `proxy_human: ${USERNAME} was placed at the authored cell (${authored.x},${authored.y},${authored.z}) `
        + `— now checking whether a body can stand there.`
      : `proxy_human: ${USERNAME} was asked for the authored cell (${authored.x},${authored.y},${authored.z}) `
        + `and the /tp did not land within ${PLACEMENT_SETTLE_MS}ms — still at ${whereAmI()}. Most likely `
        + `'${USERNAME}' is not an op on this server, so the command was refused. The ground test below `
        + `runs from where the body actually is, so this run is seeded there and not at the authored cell.`);
  }
  // ── THE BLIND STEP-OUT SERVES THE MODES THAT CHOOSE NO BIOME (2026-09-11, run ten) ─────────────────
  // The biome search already starts at the clearance line, so a body it placed is clear by construction.
  // A body it did NOT place stays where it is: stepping it out blind is how run ten's person went from a
  // found birch-forest spot whose /tp missed its cap to (63,71,0), stony_shore, where both crew bots then
  // stopped on "NO PLACE TO BUILD" with a message blaming the person's choice of ground. Left near spawn,
  // the run's own distance check refuses the crew and names the real cause — the placement.
  if (!biomeMode) await stepClearOfSpawn();
  else if (!placedInBiome) {
    record(`--stand=biome did not place ${USERNAME}, so the body stays at ${whereAmI()} rather than being stepped `
      + `out blind into whatever biome lies ${clearanceFrom(spawnProtectionBox(bot) || { radius: 0 })} blocks away. The `
      + `run's distance check will refuse the crew; the reason is the line above.`);
  }
  const p = bot.entity && bot.entity.position;
  if (!p) { say('proxy_human: no body position yet — standing where the server put me.'); return; }
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };

  // ── THE GROUND TEST WAITS FOR THE GROUND TO ARRIVE ────────────────────────────────────────────────
  // A biome cell is tens of blocks away, so the teleport lands the body before the server has streamed
  // the chunks there. `voxel_reader` answers UNLOADED (not air) for a cell with no chunk behind it, and
  // `standingSpotNear` reading UNLOADED would correctly conclude that no body can stand anywhere nearby
  // — reporting a bad site for a world it simply had not received yet. Near spawn this never fired,
  // which is why it only becomes necessary once the body is placed somewhere.
  //
  // Bounded, and its expiry is REPORTED rather than treated as ground: the ground test still runs, and
  // its verdict is now about a world that may be half-arrived, which the caller is told.
  if (!(await waitForChunk(reader, feet))) {
    say(`proxy_human: the chunks at ${whereAmI()} had not arrived after ${CHUNK_WAIT_MS}ms — the ground `
      + `test below is reading a world that is still streaming in, so treat its verdict as provisional.`);
  }
  const spot = await standingSpotNear(reader, feet, { radius: PLACEMENT_RADIUS });
  if (!spot.found) {
    record(`${USERNAME} is on ground no body can stand on and nothing better is within `
      + `${PLACEMENT_RADIUS} blocks — staying put. ${spot.why}`);
    say('             the desk will refuse a crew here, and that refusal is the correct outcome.');
    return;
  }
  if (spot.distance === 0) {
    record(`${USERNAME} stands on valid ground at (${feet.x},${feet.y},${feet.z}) — not moved.`);
    return;
  }
  const to = spot.cell;
  if (await teleportTo(to)) {
    record(`${USERNAME} moved ${spot.distance.toFixed(1)} blocks to valid standing ground at `
      + `(${to.x},${to.y},${to.z}) — the cell a crew will be teleported to.`);
    return;
  }
  say(`proxy_human: ${USERNAME} needed valid ground at (${to.x},${to.y},${to.z}) and the /tp did not land `
    + `it there within ${PLACEMENT_SETTLE_MS}ms — still at ${whereAmI()}. `
    + `Most likely '${USERNAME}' is not an op on this server, so the command was refused.`);
}

bot.once('spawn', () => {
  spawned = true;
  say(`proxy_human: in the world as ${USERNAME}. Type and press enter — every line goes into open chat.`);
  say(`             say "${FOREMAN_PREFIX} help" to ask the desk what it answers to; ":quit" to leave.`);
  // Placement runs before the prompt is released, so a `foreman get` typed or piped in on the first line
  // cannot be sent from the cell the server happened to choose. The proxy's own chunks have to be there
  // for the ground test to read anything, and 'spawn' is where the client has them.
  standOnGround()
    .then(() => {
      if (terminalOpen) rl.prompt();
      pump();                   // release anything typed or piped before the body existed
      if (!outbound.length) drained();
    });
});

// ── HEARING ──────────────────────────────────────────────────────────────────────────────────────
// Read at the WIRE, not the high-level event, for the same reason `foreman_channel` does: the event
// cannot tell a player from the console, and this terminal is the one place where knowing which is which
// decides whether what you are reading came from the fleet or from your own instrument. So the packet
// type is shown, and the two are never merged (chat_probe C4).
bot._client.on('player_chat', packet => {
  const raw = packet.plainMessage != null ? packet.plainMessage : packet.unsignedChatContent;
  if (typeof raw !== 'string' || raw.trim() === '') return;
  const who = senderName(packet);
  if (who === USERNAME) return;                       // the echo of what was just typed; already shown
  say(`${who}: ${raw}`);
});

// The server's own voice — deaths, joins, `/say`, command output. Shown by default because a run driven
// from here is a run whose deaths and refusals arrive nowhere else; `--quiet` is for when the desk is the
// only thing worth reading.
if (!QUIET) {
  bot.on('messagestr', (text, position) => {
    if (position === 'chat') return;                  // already carried by player_chat above
    if (typeof text === 'string' && text.trim()) say(`· ${text}`);
  });
}

// A UUID is what the server actually asserts about a sender; a name in the body is a claim anyone can
// type. Resolved through the player table, and left as the raw uuid rather than guessed at when the table
// has no entry — an unnamed sender said plainly beats a confident wrong name (Law 23).
function senderName(packet) {
  const uuid = packet.senderUuid;
  for (const p of Object.values(bot.players || {})) {
    if (p && p.uuid === uuid) return p.username;
  }
  return `<${uuid}>`;
}

// ── SPEAKING ─────────────────────────────────────────────────────────────────────────────────────
rl.on('line', line => {
  const text = line.trim();
  if (terminalOpen) rl.prompt();
  if (!text) return;
  if (text === ':quit') return leave('you asked to leave');
  if (text.length > MAX_CHAT_LINE) {
    say(`proxy_human: that line is ${text.length} characters and the protocol takes ${MAX_CHAT_LINE}. `
      + 'Not sent — split it rather than have the end of it disappear.');
    return;
  }
  enqueue(() => {
    const sent = guardExternalSync(TAG, 'bot.chat sending a typed line', () => bot.chat(text));
    if (!sent.ok) say(`proxy_human: that line did not go out — ${sent.reason}`);
    else say(`${USERNAME}: ${text}`);
  });
});

rl.on('close', () => {
  terminalOpen = false;
  quitWhenDrained = true;
  if (!pumping && !outbound.length) drained();     // nothing was ever queued — leave now
});
