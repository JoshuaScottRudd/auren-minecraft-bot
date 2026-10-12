'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/proxy_human.js');
// Joins the server as an ordinary player and bridges it to this terminal: every line typed here goes to
// open chat, and everything the world says comes back up the same terminal.
//
// The foreman reads chat at the wire (`player_chat`), not the console-level event a `/say` also raises, so
// reaching it requires holding a player slot — which is what this does. The name it joins under decides
// whose crew it commands (every contractor belongs to the name that asked for it), so it is read from the
// server's ops list (Law 16), with bots and the desk filtered out by roster. A
// name holds one connection, so this refuses to join while that person is already in the game.
//
// It has no vocabulary of its own — every line goes to chat verbatim, since the foreman's vocabulary has
// exactly one owner (`foreman_vocabulary`, Law 16, Law 25). Ask the desk itself: type `foreman help`. A
// leading `/` is a server command, and under an op's name this is a full console as well as a mouth.
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

// Registers the alias table every fragment's requires resolve against (Law 16).
paths.registerAliases();

// Names this process's watcher trace so its warnings land in watcher_proxy_human.jsonl, separate from any
// roster bot's own trace.
process.env.BOT_ID = process.env.BOT_ID || 'proxy_human';

const { guardExternalSync } = require('@utils/external_library_guard');
const { BOT_SENIORITY, FOREMAN_NAME, FOREMAN_PREFIX } = require('@thinking/architect_config');

// `--stand=biome` reads ground with the same scanner the bots survey with, judged against the same
// acceptable-biome set the fleet gates on (Law 16); the scanner reports, this file chooses (placeInBiome).
const { getBiomeName } = require('@perception/biome_scanner');
const { personSpotTest, landingFloor } = require('@utils/person_spot');
const watcher = require('@kernel/watcher');
const { armSpawnProtection, spawnProtectionBox } = require('@perception/spawn_protection');

// Module homes differ per machine and are git-ignored, so the node_modules location is looked up rather
// than assumed (Law 16).
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
// The default protocol version is read from architect_config, so it tracks the
// fleet (Law 16). --version stays, for pointing this at somebody else's world.
const { SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');
const VERSION = opt('version', SERVER_MINECRAFT_VERSION);
const QUIET = has('quiet');

// The chat protocol's own line-length cap, refused here with a reason (Law 25).
const MAX_CHAT_LINE = 240;

// Vanilla's chat spam limit kicks a client that outpaces this, which a pasted block of commands can do
// even though typing never would; foreman_channel paces its own outbound half separately.
const MS_BETWEEN_LINES = 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHOSE NAME
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Anyone on the ops list who is not a roster bot or the desk is a person, read off the list so a
// gamertag change needs no edit here.
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
  // The first human op is chosen and reported, since a second name on the
  // list would otherwise hand somebody else's crew to whoever ran this.
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

// Tracks whether the readline interface is still open, so a printed line can clear and redraw the prompt
// while it is, and fall back to a plain write once it is closed.
let terminalOpen = true;
// Placement decisions are written to the watcher trace as well as the terminal, since a lens reads the
// trace and never this console (Law 26).
function record(text) { say(`proxy_human: ${text}`); watcher.summary(TAG, text); }

function say(text) {
  if (!terminalOpen) { process.stdout.write(text + '\n'); return; }
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(text + '\n');
  rl.prompt(true);
}

// ── THE OUTBOUND QUEUE ──────────────────────────────────────────────────────────────────────────
// Holds any line typed or piped before the body has spawned, since bot.chat before spawn has no player
// behind it, and drains it at the pace below once spawned.
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

// Law 8: one reaper, reached from every exit — typed :quit, both signals, stdin closing, the server hanging up.
function leave(why, code = 0) {
  if (leaving) return;
  leaving = true;
  say(`proxy_human: leaving (${why}).`);
  if (bot) guardExternalSync(TAG, 'disconnecting the proxy client', () => bot.quit());
  if (terminalOpen) { terminalOpen = false; rl.close(); }
  // A short grace so the quit packet is written before the process ends — the socket closing is the
  // server's evidence the name is free again.
  setTimeout(() => process.exit(code), 400);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => leave(sig, 130));

// A closed terminal only records that nothing more will be typed (stdin ends the instant a piped line is
// read); the departure waits until everything typed has gone out AND the body has spawned.
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

// Armed before 'spawn' since spawn_position arrives during login — a listener registered from the spawn
// handler would miss the only packet it exists to catch (Law 26: the centre is read, never assumed).
armSpawnProtection(bot);

// A refused connection is named in plain words: node's AggregateError otherwise leaves .message empty.
bot.on('error', e => {
  const code = e && e.code ? e.code : (e && Array.isArray(e.errors) && e.errors[0] ? e.errors[0].code : null);
  if (code === 'ECONNREFUSED') {
    say(`proxy_human: nothing is listening on ${HOST}:${PORT} — there is no world to stand in yet. `
      + 'Bring a run up first (`fleet_control.js run foreman-rollback`), then start this.');
    return leave('no server', 1);
  }
  say(`proxy_human: connection error — ${e && e.message ? e.message : code || String(e)}`);
});
bot.on('end', () => { if (!leaving) leave('the server closed the connection', 1); });
bot.on('kicked', reason => {
  const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
  // The common kick reason is the name already in use, named in plain words for the person reading it.
  if (/already|logged in|duplicate/i.test(text)) {
    say(`proxy_human: ${USERNAME} is ALREADY IN THE GAME. A name holds one connection, so the proxy `
      + 'cannot join while you are at the keyboard — you are already able to say all of this in chat.');
  } else {
    say(`proxy_human: kicked — ${text}`);
  }
  leave('kicked', 1);
});

// ── STANDING SOMEWHERE A BODY CAN ACTUALLY BE PUT ───────────────────────────────────────────────────
// The body is placed on ground `standingSpotNear` accepts, the same test the desk uses for a crew (Law
// 16) — a crew is teleported to the person, so that cell seeds the run. It moves only when it must (search
// starts at radius 0), stays put and reports why on a failed search, and confirms every move by reading
// the body's actual position back (Law 25, Law 26).
const PLACEMENT_RADIUS = 12;
// The wait ends the instant the body lands, so this cap is only paid by a command that never lands —
// sized to outlast a lagging or freshly generating world.
const PLACEMENT_SETTLE_MS = 10000;
const PLACEMENT_POLL_MS = 100;
const PLACEMENT_RETRY_MS = 700;

// ── AN AUTHORED CELL IS APPLIED HERE, BEFORE THE GROUND TEST ───────────────────────────────────────
// `--stand=<x> <y> <z>` reads the cell; this file is the one writer that moves the body there and then
// still runs the ground test, since an authored coordinate is a guess about a world that gets regenerated.
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

// How long to let the destination's chunks arrive before reading the ground there.
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
// The spawn-protected square refuses every break and placement by a non-op with no report, so a person
// placed inside it stalls the crew silently. Clearance covers the base's footprint around the person, not
// just the square, measured Chebyshev since the protected region is a square (person_spot.landingFloor).

// ── WHERE THE PERSON MUST END ───────────────────────────────────────────────
// `floorFrom` is the minimum Chebyshev distance the body must end at (the larger of the spawn-clearance
// floor and the base footprint). `clearanceFrom` adds PLACEMENT_RADIUS for the one blind move
// (stepClearOfSpawn), whose landing ground is unread and may still be moved back toward spawn.
function floorFrom(box) { return landingFloor(box.radius); }
function clearanceFrom(box) { return floorFrom(box) + PLACEMENT_RADIUS; }
function fromSpawn(box, x, z) { return Math.max(Math.abs(x - box.centerX), Math.abs(z - box.centerZ)); }

// A scan that finds nothing acceptable reports which reason applied (Law 13); stepClearOfSpawn then
// runs regardless of how the body was placed.
// ── THE SURVEY WAITS FOR THE WORLD ────────────────────────────────────────────
// `getBiomeName` returns null for an unloaded column: its raw biome value is 0 (badlands), a real
// biome id — so a survey before the chunks arrive would score real names off nothing. Probed with five
// cheap chunk reads: centre plus four axis points, each SURVEY_PROBE_R blocks out.
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
  // A partial area is still surveyed — reported, never silent, so the choice below is made from whatever
  // ground did arrive.
  return { ready: false, loaded: loaded(), of: probes.length };
}

async function placeInBiome(reader, at) {
  const { ringScan, formatRejections } =
    require(path.join(paths.bot('js_kernel', 'utils'), 'site_geometry.js'));
  const box = spawnProtectionBox(bot);
  const area = await waitForSurveyArea(reader, at);
  if (!area.ready) {
    record(`only ${area.loaded} of ${area.of} survey probes had chunks after ${SURVEY_WAIT_MS}ms `
      + `— the biome choice below is made from the ground that did arrive.`);
  }
  // A null box means the spawn packet has not arrived yet; inventing a centre would risk placing the
  // person in the very square this exists to clear, so the search declines instead.
  if (!box) {
    record('--stand=biome found no spot — the world spawn is not known yet (no spawn_position packet received).');
    return false;
  }
  const from = floorFrom(box);

  // ── OUTWARD FROM THE LINE, AND THE FIRST SPOT THAT PASSES IS THE SPOT ──────
  // A spot is exactly three things: at least `from` blocks from world spawn (Chebyshev, minRadius), a 3x3
  // floor with 2 clear above every cell (evaluateOpenBox, the same test the desk and arena use — Law 16),
  // and an acceptable biome at the feet (biome_scanner.getBiomeName). `ringScan` walks outward nearest-first
  // and stops at the first match, using UNLOADED to mark the edge of the map; the move is a plain /tp to
  // the ground it read. `evaluateOpenBox` finds each floor nearest the reference height (surfaceY), so a
  // cave floor never beats grass above it. The spot test itself lives in person_spot, shared with
  // voxel_snapshot's scanner tests (Law 16), and carries the desk's own too-high ceiling.
  const isSpot = personSpotTest(reader, (x, y, z) => getBiomeName(bot, x, y, z), at.y);
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

// Sends one teleport, re-issued until it lands, since a /tp needs op granted by the harness at almost the
// same moment this runs — re-sending removes that ordering assumption.
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

// For a place whose X/Z is known and height is not. /spreadplayers with no spread and range 1 puts the
// body on the top block of that column, refusing liquid or fire under the feet.
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

// ── CLEAR OF WORLD SPAWN, WHATEVER CHOSE THE CELL ───────────────────────────
// Runs after every placement and moves the body out if still inside the clearance line — the biome search
// already starts past it, so this only catches an unplaced or blindly-placed body. /spreadplayers rather
// than /tp, since the target ground is unstreamed; the server picks the top block, refusing water and
// lava, and the eight aims run along the axes/diagonals in the order the body already leans.
async function stepClearOfSpawn() {
  const box = spawnProtectionBox(bot);
  const p = bot.entity && bot.entity.position;
  if (!p) return;
  if (!box) {
    record(`the world spawn is not known (no spawn_position packet received), so there is no centre `
      + `to step away from — the body stays at ${whereAmI()} and the run's distance check will refuse the crew.`);
    return;
  }
  // Block coordinates, as the server and run.js count them — a /tp puts the body at the block's centre,
  // so the float position is floored before measuring distance.
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

  // ── THE BIOME CHOICE IS MADE HERE, ONE WRITER, SAME AS THE AUTHORED CELL ───
  // Resolves to a column; the server puts the body on that column's surface (spreadTo), and the ground test
  // then runs from wherever it ended up — read before the choice, since the survey is centred on where the
  // body currently is.
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
  // ── THE BLIND STEP-OUT SERVES THE MODES THAT CHOOSE NO BIOME ────────────────────────────────────────
  // The biome search already starts at the clearance line, so a body it placed is clear by construction. A
  // body it did not place is stepped out blind instead, so the distance check names the real cause.
  if (!biomeMode) await stepClearOfSpawn();
  else if (!placedInBiome) {
    record(`--stand=biome did not place ${USERNAME}, so the body stays at ${whereAmI()} rather than being stepped `
      + `out blind into whatever biome lies ${clearanceFrom(spawnProtectionBox(bot) || { radius: 0 })} blocks away. The `
      + `run's distance check will refuse the crew; the reason is the line above.`);
  }
  const p = bot.entity && bot.entity.position;
  if (!p) { say('proxy_human: no body position yet — standing where the server put me.'); return; }
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };

  // ── THE GROUND TEST WAITS FOR THE GROUND TO ARRIVE ─────────────────────────────────────────────────
  // A teleported cell can land before its chunks stream in; voxel_reader answers UNLOADED (not air) for a
  // cell with no chunk behind it, which standingSpotNear would otherwise read as no ground nearby. Bounded,
  // and its expiry is reported plainly.
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
  // Placement runs before the prompt is released, so a line typed or piped on the first turn cannot be
  // sent from the cell the server happened to choose.
  standOnGround()
    .then(() => {
      if (terminalOpen) rl.prompt();
      pump();                   // release anything typed or piped before the body existed
      if (!outbound.length) drained();
    });
});

// ── HEARING ──────────────────────────────────────────────────────────────────────────────────────
// Read at the wire (player_chat), not the high-level event which cannot tell a player from the console —
// the same distinction foreman_channel makes, so fleet and instrument are never merged.
bot._client.on('player_chat', packet => {
  const raw = packet.plainMessage != null ? packet.plainMessage : packet.unsignedChatContent;
  if (typeof raw !== 'string' || raw.trim() === '') return;
  const who = senderName(packet);
  if (who === USERNAME) return;                       // the echo of what was just typed; already shown
  say(`${who}: ${raw}`);
});

// The server's own voice — deaths, joins, /say, command output. Shown by default, since a run driven from
// here has nowhere else to report them; --quiet is for when only the desk is worth reading.
if (!QUIET) {
  bot.on('messagestr', (text, position) => {
    if (position === 'chat') return;                  // already carried by player_chat above
    if (typeof text === 'string' && text.trim()) say(`· ${text}`);
  });
}

// Resolved by UUID via the player table, not the packet's claimed name; raw uuid when absent (Law 23).
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
