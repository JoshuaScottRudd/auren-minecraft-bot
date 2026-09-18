'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/build_bench.js');
// build_bench — build ANY blueprint right now, with the fleet's own builder, and read back what stands.
//
// ── WHAT IT IS FOR ──────────────────────────────────────────────────────────────────────────────────
// A build question ("does the builder place this blueprint correctly?") used to cost a whole run: the
// crew gathers, crafts and stages for ~15 minutes before the first block of a structure goes down, and
// the structure it reaches is whichever one SETUP_ORDER reaches first. This bench skips everything that
// is not building. It hands one body the blueprint's materials, locks a site, and runs the REAL
// build_executor on it, then reads the world block by block against the blueprint.
//
// ── WHY THE MATERIALS ARE GIVEN AND NOTHING IS SIMULATED (Law 26) ───────────────────────────────────
// Three shapes were on the table. A CREATIVE-MODE bot changes the game the builder is tested in (instant
// break, longer reach, no item consumption), so a pass there says nothing about survival. A MOCK bot that
// "only builds" would have to answer, itself, what a placement produces, which is grading its own paper.
// What is left is the line every probe here keeps: the operator AUTHORS the scenario (a flat pad, an
// inventory, a site), Minecraft DECIDES every outcome, and the bench READS it. The body is a survival
// player holding exactly what the blueprint asks for, so the builder cannot tell it from a fleet bot
// that finished staging.
//
// ── WHY IT CALLS build_executor AND NOT anchored_repair ─────────────────────────────────────────────
// The per-block mechanics (item resolution, station registration, the under-feet pillar, anchor choice,
// the stand fallback, the portable judge) live inside build_executor's receive(). Driving the shared
// primitive directly would mean re-writing that half here, and the bench would then test its own copy
// (Law 16). So the bench is build_executor's CALLER, exactly as building_manager is in a run.
//
// ── THE TWO SEAMS, AND WHY EACH IS SAFE ──────────────────────────────────────────────────────────────
// 1. `test: true` rides the payload. build_executor routes to recursive_judge at every exit; the judge
//    HALTS on that flag instead of replanning (fragment_tester's recursion guard).
// 2. The bench stands in for recursive_judge in THIS process's fragment registry. portable_judge's
//    escalation builds a fresh payload that does not carry the flag, and a replan in a bench would start
//    the planning recursion (job_board, gathering) inside a process whose premise is that it does not.
//    Catching every judge-bound signal here is fragment_tester's interception without editing a fragment,
//    and it also hands the bench the executor's own readable verdict to print beside the world read.
//
// ── THE VERDICT IS READ OFF THE WORLD, NEVER OFF THE BUILDER ────────────────────────────────────────
// The judge below transposes each voxel itself and reads bot.blockAt — it does NOT ask
// building_integrity/blueprint_survey, because sharing the builder's reader would make a reader defect
// invisible (the stone_column_probe rule). It shares only the group vocabulary (group_to_item), which is
// a definition of what a token accepts, not a reader. A voxel's optional FIFTH element is the block state
// the finished cell must show. The builder places it through place_authority/facing_aim; this bench reads
// it back independently and reports a state that did not land as a failure (Law 25).
//
// ── WHAT IT DOES NOT CARRY ───────────────────────────────────────────────────────────────────────────
// No blueprint name, no expected count, no scenario. It is handed a blueprint and discovers the rest from
// the blueprint file and the world, so it moves with the codebase (tools/README.md, "discovers, never
// carries a list"). It asserts nothing about a particular building; it shows what stood.
//
// Run (server must be UP — `node Auren_Workshop/fleet_control.js server-start`):
//   node Auren_Workshop/tools/build_bench.js <blueprint> [--at=x,y,z] [--keep]
//     <blueprint>   a key in js_kernel/building_blueprints.json (run with no name to list them)
//     --at=x,y,z    the build_center in the world (default: 96 blocks east of world spawn, y=150,
//                   over a stone pad the bench lays, clear of spawn protection and of terrain)
//     --keep        leave the finished build standing for inspection (default: clear it)
// Exit: 0 every voxel right · 2 the build ran and some voxels are wrong · 1 could not run.

const fs = require('fs');
const paths = require('../workshop_paths');

// THE BODY'S IDENTITY IS SET BEFORE ANY KERNEL MODULE LOADS. corporate_headquarters and the watcher read
// BOT_ID at load time to pick their files, and bot_mandate refuses a process with no species. A bench
// body is a homesteader (answers to nobody) under its own name, so it never writes a fleet bot's record.
const BENCH_NAME = 'BuildBench';
process.env.BOT_ID = BENCH_NAME;
process.env.BOT_MODE = 'homesteader';
delete process.env.BOT_OWNER;

// A bench run starts with no memory. The previous run's site lock would make set_buildspot.lock throw
// (a center is already locked), and that throw is correct for a fleet bot, so the bench's own record is
// reset to an empty HQ instead — this body's record only, which is the scope this process answers for
// (Law 28). Written empty rather than deleted so the loader reads a record rather than warning on a miss.
const HQ_FILE = paths.bot('js_kernel', `corporate_headquarters.${BENCH_NAME}.json`);
fs.writeFileSync(HQ_FILE, JSON.stringify({ schema: 'auren.corporate_headquarters.v1' }));

paths.registerAliases();

const args = process.argv.slice(2);
const blueprintName = args.find(a => !a.startsWith('--'));
const atArg = (args.find(a => a.startsWith('--at=')) || '').slice(5);
const KEEP = args.includes('--keep');

const blueprintRegistry = require('@kernel/blueprint_registry');
const buildings = blueprintRegistry.getBuildings();
if (!blueprintName || !buildings[blueprintName]) {
  console.log(blueprintName
    ? `build_bench: there is no blueprint named "${blueprintName}".`
    : 'build_bench: name the blueprint to build.');
  console.log(`  blueprints: ${Object.keys(buildings).join(', ')}`);
  console.log('  form: node Auren_Workshop/tools/build_bench.js <blueprint> [--at=x,y,z] [--keep]');
  process.exit(1);
}
let atCenter = null;
if (atArg) {
  const n = atArg.split(',').map(Number);
  if (n.length !== 3 || n.some(v => !Number.isInteger(v))) {
    console.log(`build_bench: --at=${atArg} is not three whole numbers. form: --at=100,150,-40`);
    process.exit(1);
  }
  atCenter = { x: n[0], y: n[1], z: n[2] };
}

// The bench narrates on the console AND keeps the body's own trace file: a bot process is silent on its
// terminal by design, and a bench someone is watching is the one place that silence costs.
const watcher = require('@kernel/watcher');
for (const level of ['summary', 'warn', 'error']) {
  const original = watcher[level].bind(watcher);
  watcher[level] = (tag, msg) => { console.log(`  [${level}] ${tag}: ${String(msg).split('\n')[0]}`); return original(tag, msg); };
}

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const rconLink = require('@utils/rcon_link');
const { SERVER_MINECRAFT_VERSION, SERVER_ENDPOINT } = require('@thinking/architect_config');
const spawnProtection = require('@perception/spawn_protection');
const { group_to_item, normalizeBlockName } = require('@utils/fragment_utils');
const { footprintExtent } = require('@perception/blueprint_survey');
const { siteChairs } = require('@kernel/site_chairs');
const buildingIntegrity = require('@perception/building_integrity');
const fragmentRegistry = require('@kernel/fragment_registry');
const buildExecutor = require('@action/build_executor');

const PAD_Y = 150;
const SPAWN_OFFSET_X = 96;
const MARGIN = 3;
const GIVE_SPARE = 4;
// The bench's judge on the build itself (Law 11): the executor's own portable judge catches a stall, and
// this ceiling catches the one case it cannot — a line that never reports at all.
const BUILD_CEILING_MS = 20 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rcon = async (...cmds) => (await rconLink.once(cmds)).map(r => r.body).filter(Boolean).join(' | ');

function isAirName(name) { return name === 'air' || name === 'cave_air' || name === 'void_air'; }

// The item a token is placed with. A group token is given its first member; the builder resolves a group
// against whatever member the pocket holds, so any member is a fair test of the same path.
function itemForToken(token) {
  return group_to_item[token] ? group_to_item[token][0] : token;
}

function allVoxels(building) {
  const out = [];
  (building.anchors || []).forEach((a, ai) => (a.voxels || []).forEach(v => out.push({ v, ai })));
  (building.unassigned_voxels || []).forEach(v => out.push({ v, ai: -1 }));
  return out;
}

// waitUntil — poll a world read until it holds, so a verdict is never taken off a chunk the server has
// not streamed yet. Returns whether it held; a false is reported, never assumed away.
async function waitUntil(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(200); }
  return pred();
}

// judgeWorld — every voxel, read off the world. Rotation is always 0 here: the bench locks rotation 0,
// so world = center + (voxel − blueprint centre).
function judgeWorld(bot, building, center) {
  const bc = building.build_center || { x: 0, y: 0, z: 0 };
  const rows = [];
  for (const { v, ai } of allVoxels(building)) {
    const pos = new Vec3(center.x + v[0] - bc.x, center.y + v[1] - bc.y, center.z + v[2] - bc.z);
    const block = bot.blockAt(pos);
    const token = v[3];
    const want = v[4] || null;
    let verdict;
    if (!block) verdict = 'unloaded';
    else {
      const name = normalizeBlockName(block.name);
      if (token === 'air') verdict = isAirName(block.name) ? 'right' : 'not_air';
      else if (isAirName(block.name)) verdict = 'missing';
      else if (group_to_item[token] ? !group_to_item[token].includes(name) : name !== token) verdict = 'wrong_block';
      else if (want) {
        const props = block.getProperties();
        verdict = Object.entries(want).every(([k, val]) => String(props[k]) === String(val)) ? 'right' : 'wrong_state';
      } else verdict = 'right';
    }
    rows.push({ ai, rel: v.slice(0, 3), token, want, got: block ? block.name : null, props: block ? block.getProperties() : null, verdict });
  }
  return rows;
}

async function main() {
  const building = buildings[blueprintName];
  const roomKey = blueprintName;
  const reachable = await rconLink.probe();
  if (!reachable.ok) {
    console.log(`build_bench: the server does not answer on RCON (${reachable.reason}). Start it first: node Auren_Workshop/fleet_control.js server-start`);
    process.exit(1);
  }

  const bot = mineflayer.createBot({ host: SERVER_ENDPOINT.host, port: SERVER_ENDPOINT.port, username: BENCH_NAME, version: SERVER_MINECRAFT_VERSION, respawn: false });
  bot.loadPlugin(pathfinder);
  spawnProtection.armSpawnProtection(bot);
  // A body saved dead never fires `spawn`, so the bench would wait forever on a corpse. The fleet's own
  // login-edge revive is used rather than a bench copy of it (Law 16) — the same edge master_core uses.
  let reviving = false;
  bot.on('health', () => {
    if (global.bot || bot.health > 0 || reviving) return;
    reviving = true;
    require('@action/death_manager.js').reviveBody(bot).then(r => console.log(`build_bench: the body joined dead and was revived (${r.why})`));
  });
  // Only a death after the build starts is the build's. A body that joined dead reports `death` at login
  // too, and counting that one would fail a clean build for its previous run's cause.
  let buildRunning = false;
  let diedDuringBuild = false;
  bot.on('death', () => { if (buildRunning) diedDuringBuild = true; });
  await new Promise((resolve, reject) => { bot.once('spawn', resolve); bot.once('kicked', reject); bot.once('error', reject); });
  global.bot = bot;
  spawnProtection.maskWorldReads(bot);

  // ── SITE (authored) ──
  const spawn = bot.spawnPoint;
  const center = atCenter || { x: Math.floor(spawn.x) + SPAWN_OFFSET_X, y: PAD_Y, z: Math.floor(spawn.z) };
  const ext = footprintExtent(building, 0);
  const height = (building.dimensions && building.dimensions.h) || 8;
  const box = {
    x1: center.x + ext.min_dx - MARGIN, x2: center.x + ext.max_dx + MARGIN,
    z1: center.z + ext.min_dz - MARGIN, z2: center.z + ext.max_dz + MARGIN,
  };
  const air = `fill ${box.x1} ${center.y + 1} ${box.z1} ${box.x2} ${center.y + height + 3} ${box.z2} air`;
  const pad = `fill ${box.x1} ${center.y} ${box.z1} ${box.x2} ${center.y} ${box.z2} stone`;
  console.log(`build_bench: ${blueprintName} at (${center.x},${center.y},${center.z})`);
  await rcon(`forceload add ${box.x1} ${box.z1} ${box.x2} ${box.z2}`);
  await sleep(2000);
  await rcon(`gamemode survival ${BENCH_NAME}`, `clear ${BENCH_NAME}`, `effect give ${BENCH_NAME} minecraft:saturation 3600 1 true`,
    air, pad, `tp ${BENCH_NAME} ${center.x + 0.5} ${center.y + 1} ${center.z + 0.5}`);
  const landed = await waitUntil(() => {
    const b = bot.blockAt(new Vec3(center.x, center.y, center.z));
    return b && b.name === 'stone' && bot.entity.position.distanceTo(new Vec3(center.x + 0.5, center.y + 1, center.z + 0.5)) < 1.5;
  }, 15000);
  if (!landed) {
    console.log('build_bench: the body did not arrive on the pad (chunk not streamed or tp refused). Nothing was built.');
    bot.quit(); process.exit(1);
  }

  // ── LOCK + MATERIALS (authored) ──
  // The material count comes from the builder's own scan, which counts only cells it can SEE. A column
  // the server has not streamed yet is left out of the count, so the pocket comes up short and the build
  // stops material_short on a voxel nobody was ever given (first live run: no door, 9 planks short).
  // Every voxel must read as loaded before anything is counted.
  const bpc = building.build_center || { x: 0, y: 0, z: 0 };
  const sensed = await waitUntil(() => allVoxels(building).every(({ v }) =>
    bot.blockAt(new Vec3(center.x + v[0] - bpc.x, center.y + v[1] - bpc.y, center.z + v[2] - bpc.z)) !== null), 20000);
  if (!sensed) {
    console.log('build_bench: part of the site never streamed to the body, so the materials cannot be counted. Nothing was built.');
    bot.quit(); process.exit(1);
  }
  // THE BENCH AUTHORS ITS SITE, as a bench authors every scenario. In a fleet only the foreman's hub writes a
  // location; this body runs alone with no foreman, so the bench writes the same chairs (`site_chairs`) into
  // this body's memory itself, below the bot's own writer, which refuses the location chair by design.
  {
    const chairs = siteChairs({ blueprint: blueprintName, roomKey, candidate: { build_center: center, rotation: 0 } }, 'build_bench');
    const hq = require('@kernel/corporate_headquarters');
    const key = require('@kernel/bot_mandate').buildingRoomKey(roomKey);
    hq.writeConferenceRoomChair('building_confrence_room', key, 'set_buildspot', chairs.set_buildspot);
    hq.writeConferenceRoomChair('building_confrence_room', key, 'blueprint_paster', chairs.blueprint_paster);
  }
  const needed = buildingIntegrity.scan(bot, blueprintName, roomKey).materials_needed;
  const give = {};
  for (const [token, count] of Object.entries(needed)) {
    const item = itemForToken(token);
    give[item] = (give[item] || 0) + count + GIVE_SPARE;
  }
  for (const [item, count] of Object.entries(give)) await rcon(`give ${BENCH_NAME} ${item} ${count}`);
  const stocked = await waitUntil(() => Object.entries(give).every(([item, count]) =>
    bot.inventory.items().filter(i => i.name === item).reduce((s, i) => s + i.count, 0) >= count), 10000);
  console.log(`build_bench: gave ${Object.entries(give).map(([i, c]) => `${c} ${i}`).join(', ')}${stocked ? '' : '  (NOT all arrived)'}`);

  // ── DRIVE the real builder; the bench is the judge it reports to ──
  const judged = [];
  fragmentRegistry.recursive_judge = { receive: (_type, payload) => judged.push(payload) };
  const startedAt = Date.now();
  // THE TERMINAL IS THE JUDGE-BOUND SIGNAL, NOT receive()'s PROMISE. Every exit of build_executor routes to
  // the judge, but a Law 15 abandonment (a death, a movement API giving up) routes from INSIDE a call that
  // then never resolves, so awaiting receive() hangs the bench on exactly the runs worth reading. A throw
  // is a coding violation and ends the wait too, reported as a crash rather than a verdict.
  let crash = null;
  buildRunning = true;
  buildExecutor.receive('build_executor', {
    from: 'build_bench', to: 'build_executor', task: 'build_executor', test: true,
    blueprint_name: blueprintName, conference_room_key: roomKey,
    readable: `build_bench: build ${blueprintName}`,
  }).then(null, (e) => { crash = e; });
  const finished = await waitUntil(() => judged.length > 0 || crash !== null, BUILD_CEILING_MS);
  buildRunning = false;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  // ── READ the world ──
  await sleep(1000);
  const rows = judgeWorld(bot, building, center);
  const count = (pred) => rows.filter(pred).length;
  const anchors = [...new Set(rows.map(r => r.ai))].sort((a, b) => a - b);
  console.log('');
  console.log(`build_bench verdict: ${blueprintName}  seconds=${seconds}  right=${count(r => r.verdict === 'right')}/${rows.length}`);
  for (const ai of anchors) {
    const mine = rows.filter(r => r.ai === ai);
    const by = (v) => mine.filter(r => r.verdict === v).length;
    console.log(`  A${ai}: right=${by('right')}/${mine.length} missing=${by('missing')} wrong_block=${by('wrong_block')} wrong_state=${by('wrong_state')} not_air=${by('not_air')} unloaded=${by('unloaded')}`);
  }
  const bad = rows.filter(r => r.verdict !== 'right');
  for (const r of bad.slice(0, 40)) {
    const stateGot = r.want && r.props ? JSON.stringify(Object.fromEntries(Object.keys(r.want).map(k => [k, r.props[k]]))) : '';
    console.log(`  ${r.verdict.padEnd(11)} A${r.ai} [${r.rel.join(',')}] want ${r.token}${r.want ? ' ' + JSON.stringify(r.want) : ''}  got ${r.got}${stateGot ? ' ' + stateGot : ''}`);
  }
  if (bad.length > 40) console.log(`  ... ${bad.length - 40} more`);
  for (const p of judged) console.log(`  executor: ${p.readable || '(no readable)'}`);
  if (diedDuringBuild) console.log('  THE BODY DIED during the build — read the server log for the cause.');
  if (crash) console.log(`  CRASH (coding violation) inside build_executor:\n${crash.stack || crash}`);
  if (!finished) console.log(`  NO TERMINAL SIGNAL within ${BUILD_CEILING_MS / 60000} minutes — the build did not end; the verdict above is a snapshot, not a result.`);

  // ── TEARDOWN ──
  // THE BODY IS SAVED WHERE IT LOGS OUT, AND THE NEXT RUN LOGS IN THERE. A body that logs out over the pad
  // and has the pad removed under it afterwards is saved in mid-air, and its next login falls ~90 blocks
  // before the bench can act (measured twice: "fell from a high place" seconds after the next login). So
  // before logging out it is set down on real terrain beside the site — `spreadplayers` lands a player on
  // the highest solid block, which outside the pad box is the ground — and only then is anything removed.
  // With --keep the body stays standing inside the build it just finished, which is solid.
  await rcon(`clear ${BENCH_NAME}`);
  if (!KEEP) {
    await rcon(`spreadplayers ${box.x2 + 8} ${center.z} 0 1 false ${BENCH_NAME}`);
    await sleep(1500);
  }
  watcher.flushNow();
  require('@kernel/corporate_headquarters').flushNow();
  bot.quit();
  await sleep(1500);
  if (!KEEP) await rcon(`fill ${box.x1} ${center.y} ${box.z1} ${box.x2} ${center.y + height + 3} ${box.z2} air`);
  await rcon(`forceload remove ${box.x1} ${box.z1} ${box.x2} ${box.z2}`);
  process.exit(bad.length === 0 && finished && !crash && !diedDuringBuild ? 0 : 2);
}

main().then(null, (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
