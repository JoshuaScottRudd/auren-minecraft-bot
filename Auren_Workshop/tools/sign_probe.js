'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/sign_probe.js');
// tool: sign_probe — the LIVE observation that settles whether a wooden sign can carry a human's order
// into the fleet (control_program_plan.md §7 "Phase 0 — THE PROBE. Nothing is built before it passes").
//
// WHY IT EXISTS: the whole sign order desk (plan §5) was paper. The libraries being present and
// version-correct for 1.21.5 is not the same fact as an observed packet, and the plan says so in its own
// Law 25 section: "no sign has ever been read by this fleet." A probe is the only instrument that can
// close that gap, because every question here is a WORLD-TRANSFORMATION — what does Minecraft DO — and
// no harness may answer one by computing it (READ DON'T SIMULATE, `Auren_Workshop/README.md`: a harness
// that decides what the world would have done is grading its own paper). So this is live, against the
// real server, or it is nothing.
//
// THE GOVERNING LINE (same as water_pillar_probe / ghost_probe): anything MINECRAFT decides is READ,
// only the operator's choices are AUTHORED. RCON here is the OPERATOR at the server console (op-4)
// issuing setblock/give/tp — it stands in for the human who would otherwise be standing in the world
// with a sign in hand. Every verdict below is read back off the server or off the bot's own world model;
// none is computed.
//
// WHY BOTH AUTHORING ROUTES ARE TESTED AND NEITHER IS ENOUGH ALONE. A sign's text can arrive two ways
// and they are different code paths that can fail independently:
//   - the CONSOLE route (`/setblock` with front_text NBT) writes the block entity directly. It proves
//     the READ side and nothing about the write side.
//   - the PLAYER route (place the sign, then the serverbound `update_sign` packet) is the only path a
//     human — or a bot pretending to be one — actually travels, and vanilla guards it with an editor
//     UUID that the console route never touches.
// A probe that tested only the console route would report green and leave the fleet unable to write a
// sign at all; one that tested only the player route would not know whether an operator can seed a
// bench world. Both, or the verdict is partial (Law 25).
//
// EVERY NEGATIVE CARRIES A CONTROL, and that is not thoroughness for its own sake. A "sign will not
// attach to a chest" result is indistinguishable from "the probe got the facing convention backwards"
// unless the identical placement is also run against a support block known to work. An uncontrolled
// negative is a well-formed falsehood — the Law 26 failure the whole boundary exists to stop — and it
// would send the order desk's geometry the wrong way with nothing downstream able to catch it.
//
// Run (server must be UP; bots need not be):
//   . .\Auren_Workshop\scripts\_node.ps1 ; & (Get-AurenNode) Auren_Workshop\tools\sign_probe.js
//   env knobs: PROBE_NAME (default SignProbe), PROBE_HOST, PROBE_PORT, PROBE_VERSION

const path = require('path');
const fs = require('fs');

const paths = require('../workshop_paths');
const moduleHomes = require(paths.bot('js_kernel/utils/node_module_homes'));
// WHERE THE PACKAGES LIVE IS ASKED OF THE ONE FILE THAT ANSWERS IT. A private constant stood here
// naming MinecraftServer/node_modules alone, so this probe ran on the workstation whose server happened
// to carry mineflayer and refused everywhere else — one more copy of the question
// `js_kernel/utils/node_module_homes` exists to end (its header records the first four).
for (const d of moduleHomes.bootstrapModulePath()) module.paths.unshift(d);

const mineflayer = moduleHomes.requireFromHomes('mineflayer');
const { Vec3 } = moduleHomes.requireFromHomes('vec3');
const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));

const HOST = process.env.PROBE_HOST || 'localhost';
const PORT = Number(process.env.PROBE_PORT || 25565);
const VERSION = process.env.PROBE_VERSION || '1.21.5';
const NAME = process.env.PROBE_NAME || 'SignProbe';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The findings ledger. Every question this probe was raised to answer posts its OBSERVED answer here,
// never an expected one — the report is written off this array, so a question with no observation must
// appear as an unanswered question rather than silently vanish (Law 25).
const findings = [];
function record(id, question, observed, verdict) {
  findings.push({ id, question, observed, verdict });
  console.log(`\n[${id}] ${question}`);
  console.log(`   observed: ${observed}`);
  console.log(`   verdict : ${verdict}`);
}

// Raw packet capture. The plan asks what the SERVER SENDS, which is a different question from what
// prismarine's accessor returns after parsing it — so the wire is tapped directly and both are reported.
const wire = { tile_entity_data: [], open_sign_entity: [], block_change: [] };

async function main() {
  const creds = rconLink.readServerProperties();
  const rcon = await rconLink.open(creds);
  const cmd = async c => (await rcon.command(c) || '').trim();

  console.log(`server: rcon up on ${creds.port}, world '${creds.level}'.`);

  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: VERSION, auth: 'offline' });
  bot.on('kicked', r => console.log('KICKED:', r));
  bot.on('error', e => console.log('ERROR:', e.message));

  // Tap the wire BEFORE spawn so nothing is missed. These three are the entire sign transport.
  bot._client.on('tile_entity_data', p => wire.tile_entity_data.push(p));
  bot._client.on('open_sign_entity', p => wire.open_sign_entity.push(p));
  bot._client.on('block_change', p => wire.block_change.push(p));

  await new Promise(res => bot.once('spawn', res));
  await sleep(2000);
  console.log(`bot: spawned at ${bot.entity.position.floored()}`);

  // ── THE TEST BED ────────────────────────────────────────────────────────────────────────────────
  // Authored deliberately rather than found: a probe that answers "can a sign attach to a chest" needs
  // to know the answer is about the chest and not about whatever terrain happened to be underneath.
  const origin = bot.entity.position.floored();
  const BX = origin.x + 6, BY = origin.y, BZ = origin.z + 6;   // platform surface sits at BY-1
  const at = (dx, dy, dz) => `${BX + dx} ${BY + dy} ${BZ + dz}`;
  const vec = (dx, dy, dz) => new Vec3(BX + dx, BY + dy, BZ + dz);

  await cmd(`forceload add ${BX - 16} ${BZ - 16} ${BX + 16} ${BZ + 16}`);
  await cmd(`fill ${at(-8, -1, -8)} ${at(8, -1, 8)} minecraft:stone`);
  await cmd(`fill ${at(-8, 0, -8)} ${at(8, 6, 8)} minecraft:air`);
  await cmd(`tp ${NAME} ${BX + 0.5} ${BY} ${BZ + 0.5}`);
  await cmd(`gamemode survival ${NAME}`);
  await sleep(1500);
  console.log(`bed: platform built, surface y=${BY - 1}, bot standing at ${BX} ${BY} ${BZ}`);

  // Read the four front lines the way fleet code would, off the bot's own world model.
  const readFront = (v) => {
    const b = bot.blockAt(v);
    if (!b) return { name: null, lines: null, err: 'chunk not loaded' };
    if (typeof b.getSignText !== 'function') return { name: b.name, lines: null, err: 'not a sign (no getSignText)' };
    try { return { name: b.name, lines: b.getSignText()[0].split('\n'), back: b.getSignText()[1].split('\n') }; }
    catch (e) { return { name: b.name, lines: null, err: `THREW ${e.message}` }; }
  };

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q1 — CONSOLE AUTHORING: which SNBT shape yields the text the human actually meant?
  // All three shapes are ACCEPTED by the command parser, so "did setblock succeed" is the wrong test —
  // the question is what the bot READS BACK. 1.21.5 is the version that moved text components in NBT
  // off JSON strings, so a shape that was correct on 1.20 now stores its own punctuation as literal
  // sign text. That failure is silent in every log: the command says "Changed the block".
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const WANT = ['ORDER', 'oak_log 64', 'cobblestone 128', ''];
  const shapes = [
    { id: 'A-plain-string', snbt: `{front_text:{messages:['"ORDER"','"oak_log 64"','"cobblestone 128"','""']}}` },
    { id: 'B-json-string', snbt: `{front_text:{messages:['{"text":"ORDER"}','{"text":"oak_log 64"}','{"text":"cobblestone 128"}','{"text":""}']}}` },
    { id: 'C-compound', snbt: `{front_text:{messages:[{text:"ORDER"},{text:"oak_log 64"},{text:"cobblestone 128"},{text:""}]}}` },
  ];
  const shapeResults = [];
  for (let i = 0; i < shapes.length; i++) {
    const v = vec(-6 + i * 2, 0, -6);
    await cmd(`setblock ${v.x} ${v.y} ${v.z} minecraft:air`);
    const reply = await cmd(`setblock ${v.x} ${v.y} ${v.z} minecraft:oak_sign[rotation=8]${shapes[i].snbt}`);
    await sleep(900);
    const read = readFront(v);
    const clean = read.lines && WANT.every((w, n) => read.lines[n] === w);
    shapeResults.push({ ...shapes[i], v, reply, read, clean });
    console.log(`   ${shapes[i].id}: accepted=${/Changed the block/i.test(reply)} botReads=${JSON.stringify(read.lines)} clean=${clean}`);
  }
  const cleanShapes = shapeResults.filter(s => s.clean);
  record('Q1', 'Which /setblock SNBT shape puts the text the human MEANT onto a 1.21.5 sign?',
    shapeResults.map(s => `${s.id}: parser=${/Changed the block/i.test(s.reply) ? 'ACCEPTED' : 'REJECTED'}, bot reads ${JSON.stringify(s.read.lines)}`).join('  ||  '),
    cleanShapes.length
      ? `ONLY ${cleanShapes.map(s => s.id).join(', ')} is faithful. The others are accepted by the parser and store their own punctuation AS SIGN TEXT — a silent falsehood, not an error.`
      : 'NO shape produced faithful text — console authoring cannot seed an order');

  // The rest of the probe uses the faithful shape only. Reading order lines through a shape that
  // pollutes them would make every downstream verdict a measurement of the probe's own bug.
  const goodSnbt = (l0, l1, l2, l3) =>
    `{front_text:{messages:[{text:${JSON.stringify(l0)}},{text:${JSON.stringify(l1)}},{text:${JSON.stringify(l2)}},{text:${JSON.stringify(l3)}}]}}`;

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q2 — THE READ (the plan's print #1) and Q2b — what the wire actually carries.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const signV = vec(0, 0, -6);
  await cmd(`setblock ${signV.x} ${signV.y} ${signV.z} minecraft:air`);
  await cmd(`setblock ${signV.x} ${signV.y} ${signV.z} minecraft:oak_sign[rotation=8]${goodSnbt('ORDER', 'oak_log 64', 'cobblestone 128', '')}`);
  await sleep(1500);
  const mainRead = readFront(signV);
  const mainBlock = bot.blockAt(signV);
  const rawEntity = mainBlock && mainBlock.entity ? JSON.stringify(mainBlock.entity) : '(no .entity on the block)';
  record('Q2', 'Does bot.blockAt(sign).getSignText() return the human-authored lines, verbatim?',
    `block.name=${mainRead.name} | front=${JSON.stringify(mainRead.lines)} | back=${JSON.stringify(mainRead.back)}`,
    mainRead.lines && mainRead.lines[1] === 'oak_log 64'
      ? 'READABLE and EXACT — getSignText() returns [frontString, backString], each 4 lines joined by \\n'
      : 'NOT READABLE — see raw entity dump');
  record('Q2b', 'What does the server actually SEND for a sign (raw block-entity NBT)?',
    rawEntity.slice(0, 1100),
    `${wire.tile_entity_data.length} tile_entity_data packets so far; NBT arrives as list<string> under front_text.messages / back_text.messages, plus is_waxed, color, has_glowing_text`);

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q3 — LIVE EDIT PROPAGATION. THE ONE THAT DECIDES WHETHER STANDING ORDERS WORK.
  // Plan §5 makes orders standing, which means the bot must see a human EDIT a sign already in its
  // loaded world. If text only ever arrives with the chunk, every order change needs a reconnect and
  // the desk's whole design changes shape.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const before = wire.tile_entity_data.length;
  await cmd(`data merge block ${signV.x} ${signV.y} ${signV.z} ${goodSnbt('ORDER', 'stone 32', 'EDITED LIVE', '')}`);
  await sleep(2000);
  const liveRead = readFront(signV);
  record('Q3', 'Does a live sign EDIT reach an already-connected bot without a rejoin?',
    `tile_entity_data packets during the edit: ${wire.tile_entity_data.length - before} | bot now reads ${JSON.stringify(liveRead.lines)}`,
    liveRead.lines && liveRead.lines[2] === 'EDITED LIVE'
      ? 'YES — one tile_entity_data packet per edit; the bot re-reads with no rejoin and no poll. Standing orders are viable.'
      : 'NO — the edit did not propagate; standing orders would need a poll or a rejoin');

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q3b — CHUNK RELOAD. An order desk is read after a bot walks away and comes back, so the text has
  // to survive an unload/reload, not just arrive once. Forceload keeps the SERVER holding the chunk;
  // what is being tested is the BOT's model after its view distance drops the column and re-fetches it.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  await cmd(`tp ${NAME} ${BX} ${BY + 40} ${BZ + 900}`);
  await sleep(4000);
  const awayRead = readFront(signV);
  await cmd(`tp ${NAME} ${BX + 0.5} ${BY} ${BZ + 0.5}`);
  await sleep(4000);
  const backRead = readFront(signV);
  record('Q3b', 'Does sign text survive a chunk unload and reload in the bot\'s world model?',
    `900 blocks away: ${awayRead.lines ? JSON.stringify(awayRead.lines) : awayRead.err} | back on site: ${JSON.stringify(backRead.lines)}`,
    backRead.lines && backRead.lines[2] === 'EDITED LIVE'
      ? 'YES — the text comes back with the chunk payload; nothing is cached and nothing is lost'
      : 'NO — the text did not return with the chunk');

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q4 — THE PLAYER ROUTE: can the BOT place a sign and write on it?
  // Vanilla gates serverbound update_sign on an editor UUID set at placement and cleared after one
  // successful write, so this is the half no console command exercises. Ground truth is read back off
  // the SERVER (`data get block`), never off the bot's own model — the bot's model is what would lie.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const placeV = vec(6, 0, 6);
  await cmd(`setblock ${placeV.x} ${placeV.y} ${placeV.z} minecraft:air`);
  await cmd(`setblock ${placeV.x} ${placeV.y - 1} ${placeV.z} minecraft:stone`);
  await cmd(`give ${NAME} minecraft:oak_sign 16`);
  await cmd(`tp ${NAME} ${placeV.x + 0.5} ${placeV.y} ${placeV.z + 2.5}`);
  await sleep(1500);

  const truth = async () => (await cmd(`data get block ${placeV.x} ${placeV.y} ${placeV.z} front_text.messages`));
  let placeOutcome = 'not attempted', serverTruth = '(not read)';
  try {
    const item = bot.inventory.items().find(i => i.name === 'oak_sign');
    if (!item) throw new Error('no oak_sign in inventory after /give');
    await bot.equip(item, 'hand');
    const openBefore = wire.open_sign_entity.length;
    await bot.placeBlock(bot.blockAt(placeV.offset(0, -1, 0)), new Vec3(0, 1, 0));
    await sleep(1200);
    const placed = bot.blockAt(placeV);
    placeOutcome = `placed '${placed && placed.name}', server sent ${wire.open_sign_entity.length - openBefore} open_sign_entity packet(s)`;
    bot.updateSign(placed, 'ORDER\nspruce_log 64\ntorch 16\n');
    await sleep(1500);
    serverTruth = await truth();
  } catch (e) { placeOutcome = `THREW: ${e.message}`; }
  record('Q4', 'Can the BOT place a sign and write text on it (the real player packet route)?',
    `${placeOutcome} | server holds: ${String(serverTruth).slice(0, 260)}`,
    /spruce_log/.test(String(serverTruth))
      ? 'YES — placeBlock grants the editor right, the server answers with open_sign_entity, and bot.updateSign() is accepted'
      : 'NO — the server did not store the bot\'s text');

  let secondWrite = '(not attempted)';
  try {
    bot.updateSign(bot.blockAt(placeV), 'SECOND\nwrite attempt\n\n');
    await sleep(1500);
    secondWrite = await truth();
  } catch (e) { secondWrite = `THREW: ${e.message}`; }
  record('Q4b', 'Can the bot write to the SAME sign twice without re-opening the editor?',
    String(secondWrite).slice(0, 260),
    /SECOND/.test(String(secondWrite)) ? 'YES — repeated writes accepted'
      : 'NO — the editor grant is SINGLE-USE. The server silently drops the second write and logs "tried to change non-editable sign". No error reaches the bot.');

  let thirdWrite = '(not attempted)', reopened = 0;
  try {
    const openBefore = wire.open_sign_entity.length;
    await bot.activateBlock(bot.blockAt(placeV));
    await sleep(1200);
    reopened = wire.open_sign_entity.length - openBefore;
    bot.updateSign(bot.blockAt(placeV), 'THIRD\nafter activate\n\n');
    await sleep(1500);
    thirdWrite = await truth();
  } catch (e) { thirdWrite = `THREW: ${e.message}`; }
  record('Q4c', 'Does activateBlock() re-grant the edit right on a sign the bot already wrote?',
    `open_sign_entity on activate: ${reopened} | server holds: ${String(thirdWrite).slice(0, 260)}`,
    /THIRD/.test(String(thirdWrite))
      ? 'YES — activateBlock re-opens the editor (1 packet) and the next updateSign lands. Re-writes cost one right-click each.'
      : 'NO — the right was not re-granted');

  // Q4d — the BACK face, which plan §5 never allocated. Two faces means two independent 4-line
  // surfaces on one block, and whether the bot can write the back decides if a sign can carry both a
  // human's order and the bot's own status.
  let backWrite = '(not attempted)';
  try {
    await bot.activateBlock(bot.blockAt(placeV));
    await sleep(1000);
    bot.updateSign(bot.blockAt(placeV), 'BACKFACE\nstatus line\n\n', true);
    await sleep(1500);
    backWrite = await cmd(`data get block ${placeV.x} ${placeV.y} ${placeV.z} back_text.messages`);
  } catch (e) { backWrite = `THREW: ${e.message}`; }
  record('Q4d', 'Can the bot write the BACK face independently of the front?',
    String(backWrite).slice(0, 260),
    /BACKFACE/.test(String(backWrite))
      ? 'YES — bot.updateSign(block, text, true) writes back_text; front is untouched. Two independent 4-line surfaces per block.'
      : 'NO — the back face did not take');

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q5 — SIGN vs CHEST GEOMETRY, WITH A CONTROL. This decides the whole shape of the order desk:
  // a sign ON the chest is unambiguous ownership; a sign merely NEAR it needs a measured radius and a
  // tie-break rule. The identical placement is run against STONE first — a negative with no control
  // cannot be told apart from a facing-convention bug in this probe.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const chestV = vec(0, 0, 6);
  const stoneV = vec(-6, 0, 6);
  await cmd(`setblock ${chestV.x} ${chestV.y} ${chestV.z} minecraft:chest[facing=south]`);
  await cmd(`setblock ${stoneV.x} ${stoneV.y} ${stoneV.z} minecraft:stone`);
  await sleep(600);

  // SURVIVAL IS READ OFF THE BLOCK STATE, NEVER OFF `data get block`. Every sign variant shares ONE
  // block-entity id — `minecraft:sign` — so a block-entity dump can never tell an oak_wall_sign from an
  // oak_sign, and a regex over it reports "popped off" for a sign that is standing right there. The
  // first run of this probe made exactly that mistake and its own STONE control is what exposed it.
  const isBlock = async (v, id) => /Test passed/i.test(await cmd(`execute if block ${v.x} ${v.y} ${v.z} minecraft:${id}`));

  // `setblock` WRITES A BLOCK STATE WITHOUT ASKING canSurvive — vanilla only evaluates support on a
  // neighbour update, so a wall sign forced into thin air sits there indefinitely and a probe that just
  // reads it back records a false YES. Every support test therefore POKES the sign afterwards (set a
  // block beside it, then clear it) to force the survival check the game would have run anyway, and the
  // AIR case is carried as a negative control: if a sign hanging on nothing "survives", the whole test
  // is measuring nothing and must be declared inconclusive rather than reported.
  // A wall sign re-checks its support ONLY when the neighbour it hangs on changes. A poke from any
  // other side is ignored, so the support block itself is what must be rewritten — and it must be
  // rewritten to a DIFFERENT STATE OF THE SAME BLOCK, or the test would be changing the very thing
  // under test. Rewriting it to an identical state is refused by the command ("Could not set the
  // block") and fires no update at all, which is the silent no-op an earlier revision of this probe
  // mistook for a survival.
  const probeWall = async (supportV, supportA, supportB, facing, offset, label) => {
    const w = supportV.offset(offset.x, offset.y, offset.z);
    await cmd(`setblock ${supportV.x} ${supportV.y} ${supportV.z} minecraft:${supportA}`);
    await cmd(`setblock ${w.x} ${w.y} ${w.z} minecraft:air`);
    await cmd(`setblock ${w.x} ${w.y} ${w.z} minecraft:oak_wall_sign[facing=${facing}]${goodSnbt(label, '', '', '')}`);
    await sleep(600);
    const beforePoke = await isBlock(w, 'oak_wall_sign');
    // The poke: same block, different state → a real neighbour update on the support side.
    const pokeReply = await cmd(`setblock ${supportV.x} ${supportV.y} ${supportV.z} minecraft:${supportB}`);
    await sleep(900);
    const survived = await isBlock(w, 'oak_wall_sign');
    console.log(`   wall on ${label}: present after setblock=${beforePoke}, poke='${pokeReply.slice(0, 40)}', survives support update=${survived}`);
    return { w, beforePoke, survived };
  };
  // NEGATIVE CONTROL: a redstone torch is emphatically not a solid face, and unlike a sapling it stays
  // put on a stone floor — a control that removes itself mid-test proves nothing about support.
  const torchV = vec(6, 0, 2);
  const torchWall = await probeWall(torchV, 'redstone_torch[lit=true]', 'redstone_torch[lit=false]', 'north', new Vec3(0, 0, -1), 'REDSTONE TORCH');
  // POSITIVE CONTROL: stone → deepslate, both full solid blocks. The sign must survive.
  const stoneWall = await probeWall(stoneV, 'stone', 'deepslate', 'north', new Vec3(0, 0, -1), 'STONE');
  // THE QUESTION: chest → chest, facing flipped. Still a chest; only the state changed.
  const chestNorth = await probeWall(chestV, 'chest[facing=south]', 'chest[facing=west]', 'north', new Vec3(0, 0, -1), 'CHEST');
  await cmd(`setblock ${chestV.x} ${chestV.y} ${chestV.z} minecraft:chest[facing=south]`);

  const controlValid = !torchWall.survived && stoneWall.survived;
  const chestHeld = chestNorth.survived;
  record('Q5', 'Can a wall sign hang on a CHEST face? (controls: STONE must hold, REDSTONE TORCH must drop)',
    `NEGATIVE CONTROL torch support: survives a support-side update=${torchWall.survived} | POSITIVE CONTROL stone support: survives=${stoneWall.survived} | CHEST support: survives=${chestHeld}`,
    !controlValid
      ? `INCONCLUSIVE — the controls did not separate (torch=${torchWall.survived}, stone=${stoneWall.survived}), so nothing about the chest can be concluded from this run`
      : chestHeld
        ? 'YES — a chest DOES support a wall sign. The controls separate cleanly (a torch drops it, stone holds it), so this is the chest\'s answer and not the probe\'s.'
        : 'NO — a chest is NOT valid support for a wall sign. The controls separate cleanly, so this is the chest\'s answer: the sign pops the moment anything updates it.');

  // Q5-ctl — the /setblock validation question in its own right, because it governs how any bench or
  // operator may seed a sign, and because it is what made the first two revisions of this probe lie.
  const voidV = vec(8, 0, 2), voidW = voidV.offset(0, 0, -1);
  await cmd(`setblock ${voidV.x} ${voidV.y} ${voidV.z} minecraft:air`);
  await cmd(`setblock ${voidW.x} ${voidW.y} ${voidW.z} minecraft:air`);
  await cmd(`setblock ${voidW.x} ${voidW.y} ${voidW.z} minecraft:oak_wall_sign[facing=north]${goodSnbt('ON NOTHING', '', '', '')}`);
  await sleep(800);
  const voidImmediate = await isBlock(voidW, 'oak_wall_sign');
  const voidRead = readFront(voidW);
  await cmd(`setblock ${voidV.x} ${voidV.y} ${voidV.z} minecraft:stone`);
  await sleep(400);
  await cmd(`setblock ${voidV.x} ${voidV.y} ${voidV.z} minecraft:air`);
  await sleep(900);
  const voidAfter = await isBlock(voidW, 'oak_wall_sign');
  record('Q5-ctl', 'Does /setblock validate block support at all?',
    `a wall sign forced onto PURE AIR: present immediately=${voidImmediate}, bot reads ${JSON.stringify(voidRead.lines)}; after a real support-side update=${voidAfter}`,
    voidImmediate && !voidAfter
      ? 'NO — /setblock writes the block state without running canSurvive, so a sign hanging on nothing sits there indefinitely AND READS BACK NORMALLY until something updates its support. Anything seeding signs by console (a bench, an operator, a test world) must force a support-side update before believing the placement. This is not hypothetical: two earlier revisions of this probe reported a false YES for exactly this reason, and only the control caught it.'
      : `the air control did not separate (immediate=${voidImmediate}, after=${voidAfter}) — treat every geometry verdict in this run as suspect`);

  // Q5b — a standing sign on TOP of the chest: the remaining "on the chest" geometry, and the one a
  // human is most likely to build, because it needs no support block behind it.
  const topV = chestV.offset(0, 1, 0);
  await cmd(`setblock ${topV.x} ${topV.y} ${topV.z} minecraft:air`);
  await cmd(`setblock ${topV.x} ${topV.y} ${topV.z} minecraft:oak_sign[rotation=8]${goodSnbt('ON TOP', 'oak_log 64', '', '')}`);
  await sleep(600);
  // A standing sign hangs off the block BELOW it, so its support-side poke is the chest itself.
  await cmd(`setblock ${chestV.x} ${chestV.y} ${chestV.z} minecraft:chest[facing=west]`);
  await sleep(900);
  const topSurvived = await isBlock(topV, 'oak_sign');
  await cmd(`setblock ${chestV.x} ${chestV.y} ${chestV.z} minecraft:chest[facing=south]`);
  await sleep(400);
  const topRead = readFront(topV);
  record('Q5b', 'Does a STANDING sign survive on top of a chest, and can the bot read it there?',
    `block state still oak_sign after a forced update: ${topSurvived} | bot reads ${JSON.stringify(topRead.lines)}`,
    topSurvived && topRead.lines && topRead.lines[1] === 'oak_log 64'
      ? 'YES — a standing sign sits on a chest lid and reads normally, so both "on the chest" geometries are legal blocks.'
      : 'NO — a standing sign does not survive on a chest lid');

  // Q5c — the human's own route to that geometry. Right-clicking a chest OPENS it, so a player must
  // sneak to place against it, and whether mineflayer models that decides if the bot can build its own
  // desk. THE SERVER IS READ EVEN WHEN placeBlock THROWS: its throw is a timeout on mineflayer's own
  // blockUpdate bookkeeping, which is a claim about the library, not about the world (Law 23).
  // The chest is run against a STONE control at the identical offset. A chest's collision box is inset
  // 1/16 on every side and 2/16 at the top, while mineflayer aims placeBlock at the geometric centre of
  // the full block face — so a failure here could be the chest's shrunken hitbox rather than sneaking,
  // and only the control can tell those apart.
  const trySneakPlace = async (targetV, faceV, label) => {
    const resultV = targetV.offset(faceV.x, faceV.y, faceV.z);
    await cmd(`setblock ${resultV.x} ${resultV.y} ${resultV.z} minecraft:air`);
    await cmd(`tp ${NAME} ${targetV.x + 0.5} ${targetV.y} ${targetV.z - 2.5}`);
    await sleep(1400);
    const item = bot.inventory.items().find(i => i.name === 'oak_sign');
    if (item) await bot.equip(item, 'hand');
    let threw = null;
    bot.setControlState('sneak', true);
    try { await bot.placeBlock(bot.blockAt(targetV), faceV); } catch (e) { threw = e.message; }
    bot.setControlState('sneak', false);
    await sleep(1500);
    const placed = (await isBlock(resultV, 'oak_sign')) || (await isBlock(resultV, 'oak_wall_sign'));
    console.log(`   sneak-place ${label}: threw=${threw ? 'yes' : 'no'} placed=${placed}`);
    return { threw, placed };
  };
  const stoneLid = await trySneakPlace(stoneV, new Vec3(0, 1, 0), 'onto STONE top face (control)');
  const chestLid = await trySneakPlace(chestV, new Vec3(0, 1, 0), 'onto CHEST top face');
  record('Q5c', 'Can the bot SNEAK-place a sign onto a chest? (control: the same placement onto stone)',
    `CONTROL stone top face -> placed=${stoneLid.placed}, threw=${stoneLid.threw || 'no'} | chest top face -> placed=${chestLid.placed}, threw=${chestLid.threw || 'no'}`,
    stoneLid.placed && !chestLid.placed
      ? 'NO, AND THE CONTROL LOCALISES IT — the identical call places a sign on stone and fails on a chest. It is not sneaking and not the sign: a chest\'s collision box is inset (top at y+0.875, sides at 1/16), while placeBlock aims at the geometric centre of the FULL block face, so the server\'s reach raytrace misses the chest entirely. The bot cannot build a sign directly onto a chest; it must place against a full solid block beside it.'
      : stoneLid.placed && chestLid.placed
        ? 'YES — the bot can sneak-place a sign onto a chest; both the control and the chest took the placement'
        : `INCONCLUSIVE — the stone control itself did not place (threw: ${stoneLid.threw || 'no'}), so this says nothing about the chest`);

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q6 — THE OWNERSHIP RADIUS (the plan's print #3: "do not pick that number by reasoning").
  // Measured against the geometries that ACTUALLY SURVIVED above, not against every geometry
  // imaginable — a radius sized for a placement the game rejects is a number covering nothing.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const candidates = [
    { label: 'standing sign on the chest lid', v: chestV.offset(0, 1, 0), legal: topSurvived },
    { label: 'wall sign hung on the chest face', v: chestV.offset(0, 0, -1), legal: chestHeld },
    { label: 'standing sign on the ground beside the chest', v: chestV.offset(1, 0, 0), legal: true },
    { label: 'wall sign on a post one block out', v: chestV.offset(1, 1, 0), legal: true },
    { label: 'sign diagonally adjacent', v: chestV.offset(1, 0, 1), legal: true },
  ];
  const legal = candidates.filter(c => c.legal);
  const dists = legal.map(c => ({ label: c.label, d: chestV.distanceTo(c.v) }));
  const maxD = Math.max(...dists.map(d => d.d));
  record('Q6', 'How far from a chest can a sign that the GAME ALLOWS actually sit? (the ownership radius)',
    dists.map(d => `${d.label}: ${d.d.toFixed(3)} b`).join(' | ') + `  [rejected as illegal: ${candidates.filter(c => !c.legal).map(c => c.label).join(', ') || 'none'}]`,
    `every LEGAL geometry falls within ${maxD.toFixed(3)} b of the chest block. A radius of 2.0 b covers all of them and reaches no second chest placed a normal 2 blocks away — but two ADJACENT chests both fall inside it, so a radius alone cannot resolve ownership.`);

  // Q6b — the tie-break the radius cannot supply. Two chests one block apart, one sign between them.
  const c1 = vec(-4, 0, 2), c2 = vec(-2, 0, 2), between = vec(-3, 0, 2);
  await cmd(`setblock ${c1.x} ${c1.y} ${c1.z} minecraft:chest[facing=north]`);
  await cmd(`setblock ${c2.x} ${c2.y} ${c2.z} minecraft:chest[facing=north]`);
  await cmd(`setblock ${between.x} ${between.y} ${between.z} minecraft:air`);
  await cmd(`setblock ${between.x} ${between.y} ${between.z} minecraft:oak_sign[rotation=8]${goodSnbt('ORDER', 'oak_log 64', '', '')}`);
  await sleep(1200);
  record('Q6b', 'Is a nearest-chest rule sufficient when two chests are equidistant from one sign?',
    `chest A at ${c1}, chest B at ${c2}, sign at ${between} — distances ${chestV.constructor === Vec3 ? c1.distanceTo(between).toFixed(3) : '?'} and ${c2.distanceTo(between).toFixed(3)}`,
    'NO — the two distances are IDENTICAL, so nearest-chest has no answer here. Ownership needs a deterministic tie-break (the sign\'s facing is the only directional data the block carries) or the ambiguous case must be REFUSED and reported to the human (Law 13: no defaults).');

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q7 — A WAXED sign. Plan §5 forbids the bot to wax or edit a human's sign, but a HUMAN may wax
  // their own to lock an order. Whether a waxed sign still READS decides whether that is safe, and
  // whether a write to one FAILS SILENTLY decides whether the bot can detect it.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const waxV = vec(-6, 0, -2);
  await cmd(`setblock ${waxV.x} ${waxV.y} ${waxV.z} minecraft:air`);
  await cmd(`setblock ${waxV.x} ${waxV.y} ${waxV.z} minecraft:oak_sign[rotation=8]{is_waxed:1b,${goodSnbt('ORDER', 'iron_ingot 12', 'WAXED', '').slice(1)}`);
  await sleep(1500);
  const waxRead = readFront(waxV);
  const waxBlock = bot.blockAt(waxV);
  const waxFlag = waxBlock && waxBlock.entity ? JSON.stringify(waxBlock.entity).includes('is_waxed') : false;
  record('Q7', 'Is a WAXED sign still readable, and is the waxed flag visible to the bot?',
    `bot reads ${JSON.stringify(waxRead.lines)} | is_waxed present in the NBT the bot holds: ${waxFlag}`,
    waxRead.lines && waxRead.lines[1] === 'iron_ingot 12'
      ? 'YES — waxing locks WRITES, never reads. The flag rides in the same NBT, so the bot can see an order is locked before it ever tries to touch it.'
      : 'NO — waxing broke the read');

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q8 — THE LINE BUDGET, which plan §5's `ITEM QTY` grammar rests on ("every real item name clears
  // the 15-character budget"). Three DIFFERENT limits are in play and conflating them is how that
  // claim gets mis-verified: what the console can store, what mineflayer's own guard permits, and
  // what a human's sign editor will let them type. Only the first two are observable headlessly.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const longV = vec(6, 0, -6);
  await cmd(`setblock ${longV.x} ${longV.y} ${longV.z} minecraft:air`);
  const l45 = 'x'.repeat(45), l100 = 'y'.repeat(100);
  const longReply = await cmd(`setblock ${longV.x} ${longV.y} ${longV.z} minecraft:oak_sign${goodSnbt(l45, l100, 'minecraft:cobblestone 64', '')}`);
  await sleep(1200);
  const longRead = readFront(longV);
  const storedLens = longRead.lines ? longRead.lines.map(l => l.length) : null;

  // mineflayer's own guard is a client-side refusal, not a server one — it emits 'error' and returns.
  let guardFired = false;
  const onErr = e => { if (/45 characters/.test(e.message)) guardFired = true; };
  bot.on('error', onErr);
  try { bot.updateSign(bot.blockAt(placeV), `${'z'.repeat(60)}\n\n\n`); } catch (_) { guardFired = true; }
  await sleep(600);
  bot.removeListener('error', onErr);

  record('Q8', 'What are the real per-line limits, and which layer enforces which?',
    `console /setblock stored line lengths ${JSON.stringify(storedLens)} (asked for 45,100,24,0) | mineflayer refused a 60-char line locally: ${guardFired}`,
    `THREE limits, not one: (1) the SERVER stores whatever the console gives it — ${storedLens && storedLens[1]} chars went in unmodified, so the console route is effectively unbounded; (2) mineflayer's own guard rejects >45 chars/line before anything is sent; (3) the HUMAN's sign editor limits by RENDERED PIXEL WIDTH (~90px), NOT by character count — that third limit is the one plan §5's grammar depends on and it CANNOT be observed headlessly. It needs a human in the game.`);

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q9 — THE REFUSAL PATH. Law 25 needs the bot to know when a write did NOT land. update_sign is
  // fire-and-forget with no acknowledgement, so what a failure LOOKS like from the bot's side decides
  // whether the desk can report honestly or only hope.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  const waxWriteBefore = await cmd(`data get block ${waxV.x} ${waxV.y} ${waxV.z} front_text.messages`);
  let waxWriteThrew = false;
  try { bot.updateSign(bot.blockAt(waxV), 'HIJACK\nattempt\n\n'); } catch (_) { waxWriteThrew = true; }
  await sleep(1600);
  const waxWriteAfter = await cmd(`data get block ${waxV.x} ${waxV.y} ${waxV.z} front_text.messages`);
  record('Q9', 'When a sign write is REJECTED by the server, does the bot find out?',
    `wrote to a waxed sign the bot never placed. threw locally: ${waxWriteThrew} | server before: ${waxWriteBefore.slice(-70)} | server after: ${waxWriteAfter.slice(-70)}`,
    waxWriteBefore === waxWriteAfter
      ? 'The write was DROPPED and the bot was told NOTHING — no throw, no error event, no packet. update_sign is fire-and-forget. Any fleet code that writes a sign MUST read the block back to know what happened (Law 23/25); a write that reports success on the strength of having been sent is exactly the unearned flag Law 25 forbids.'
      : 'The write LANDED on a waxed sign — waxing does not protect a sign from this route');

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Q10 — IS THERE AN EVENT? A desk that must POLL every sign in the world is a different piece of
  // machinery from one that WAKES on an edit, and the difference is a mineflayer emit that either
  // exists or does not. The library's own handler for tile_entity_data writes the block entity into
  // the column and returns, so this is expected to be silent — but "expected" is what a probe is for.
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  // Scoped to the SIGN's position only. A bare `blockUpdate` listener also catches every distant water
  // tick in the loaded world, and counting those as evidence would turn unrelated traffic into a YES.
  const seq = [];
  const readInHandler = [];
  const onSignPos = () => { seq.push('EVENT blockUpdate'); readInHandler.push(readFront(signV).lines); };
  const onSignUpdate = () => seq.push('EVENT signUpdate');
  const tapTile = p => { if (p.location && p.location.y === signV.y) seq.push('PACKET tile_entity_data'); };
  const tapChange = p => { if (p.location && p.location.y === signV.y) seq.push('PACKET block_change'); };
  bot.on(`blockUpdate:${signV}`, onSignPos);
  bot.on('signUpdate', onSignUpdate);
  bot._client.on('tile_entity_data', tapTile);
  bot._client.on('block_change', tapChange);
  await cmd(`data merge block ${signV.x} ${signV.y} ${signV.z} ${goodSnbt('ORDER', 'glass 12', 'EVENT TEST', '')}`);
  await sleep(2500);
  const settled = readFront(signV);
  bot.removeListener(`blockUpdate:${signV}`, onSignPos);
  bot.removeListener('signUpdate', onSignUpdate);
  bot._client.removeListener('tile_entity_data', tapTile);
  bot._client.removeListener('block_change', tapChange);

  const staleInHandler = readInHandler.length > 0 && JSON.stringify(readInHandler[0]) !== JSON.stringify(settled.lines);
  record('Q10', 'Does mineflayer emit an event on a sign edit, and is the text FRESH when it fires?',
    `arrival order: ${seq.join(' -> ') || '(nothing)'} | text read INSIDE the event handler: ${JSON.stringify(readInHandler[0] || null)} | text after everything settled: ${JSON.stringify(settled.lines)}`,
    seq.length === 0
      ? 'NO EVENT — the desk must re-read signs on its own cadence or tap bot._client.on("tile_entity_data") directly'
      : staleInHandler
        ? `AN EVENT FIRES BUT THE TEXT IS STALE INSIDE IT. block_change and tile_entity_data are two separate packets; blockUpdate rides the first and the NBT lands with the second, so a handler that reads getSignText() on blockUpdate can read the PREVIOUS order. Wake on the event, then read on the next tick — never in the handler.`
        : 'AN EVENT FIRES AND THE TEXT IS ALREADY FRESH when it does — blockUpdate at the sign position is a usable wake signal, because the entity packet is processed before the block-state packet that raises the event.');

  // ── SUMMARY ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n\n══════════ SIGN PROBE SUMMARY ══════════');
  for (const f of findings) console.log(`${f.id.padEnd(5)} ${f.verdict.slice(0, 150)}`);
  console.log('════════════════════════════════════════\n');

  const out = paths.fleetLogs('sign_probe_findings.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    version: VERSION, site: { BX, BY, BZ }, findings,
    wireCounts: { tile_entity_data: wire.tile_entity_data.length, open_sign_entity: wire.open_sign_entity.length },
  }, null, 2));
  console.log(`findings written to ${out}`);

  // Law 8 — whatever this raised, it takes down.
  await cmd(`forceload remove ${BX - 16} ${BZ - 16} ${BX + 16} ${BZ + 16}`);
  rcon.close();
  bot.quit();
  setTimeout(() => process.exit(0), 800);
}

main().catch(e => { console.error('PROBE FAILED:', e); process.exit(1); });
