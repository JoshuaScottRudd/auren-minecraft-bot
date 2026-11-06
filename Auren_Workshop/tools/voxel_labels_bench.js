'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/voxel_labels_bench.js');
// tool: voxel_labels_bench — what keeping labels (js_kernel/utils/voxel_labels) is worth to one body, measured on a
// captured world with no server.
//
// ONE BODY, MINEFLAYER'S OWN WORLD. A saved snapshot (voxel_snapshot_store) is loaded into a body built from
// mineflayer's own blocks plugin: its bot.world, blockAt and findBlocks, and the 'blockUpdate' / 'chunkColumnLoad'
// events that plugin emits. The labels listen to that world exactly as they would on a live body.
//
// FOUR PARTS, each against today's way of reading the same thing:
//   floor    every cell in a box: voxel_reader.classifyFloor against labels.floorAt, cold (labels built on the way)
//            and warm (built already).
//   route    the real computeAStar between the body and goals all round it, through the voxelReader seam, once with
//            the shipped reader and once with the same reader whose classifyFloorAt is the labels'.
//   logs     every log within reach: mineflayer's findBlocks against labels.cellsOfKind over the same columns, and
//            against ring_scan.blockRings, the fleet's own search for a kind of block.
//   changes  random block changes written through bot.world.setBlockStateId (the call a server packet ends in): the
//            listener's cost per change, then every kept label read again against a fresh classification.
//
// EVERY ANSWER IS THE GATE. Each floor verdict, each route (every cell and edge) and each log set must match today's
// way exactly; one difference voids the timing beside it (Law 25). A label that could differ from a fresh read is the
// remembered state Law 11 forbids.
//
// WHAT IT CANNOT PROVE (Law 25): one body, one captured area, no server traffic and no peers. It measures reads and
// searches, not a planning sweep; the ratio is the finding, not the milliseconds.
//
// Usage (developer mode, no server):
//   node Auren_Workshop/tools/voxel_labels_bench.js [--snapshot=latest|name] [--radius=48] [--height=16]
//        [--dist=40] [--nodes=20000] [--changes=2000]

const paths = require('../workshop_paths');
paths.registerAliases();
process.env.BOT_ID = process.env.BOT_ID || 'voxel_labels_bench';
const moduleHomes = require('@utils/node_module_homes');
for (const d of moduleHomes.bootstrapModulePath()) module.paths.unshift(d);

const EventEmitter = require('events');
const Vec3 = require('vec3');
const store = require('./voxel_snapshot_store');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { makeVoxelLabels } = require('@utils/voxel_labels');
const pathfinding = require('@utils/pathfinding_utils');
const { group_to_item } = require('@utils/fragment_utils');

const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const SNAPSHOT = arg('snapshot', 'latest');
const RADIUS = Number(arg('radius', 48));
const HEIGHT = Number(arg('height', 16));
const DIST = Number(arg('dist', 40));
const NODES = Number(arg('nodes', 20000));
const CHANGES = Number(arg('changes', 2000));

const say = (tag, line) => console.log(`[${tag}] ${line}`);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const now = () => process.hrtime.bigint();

// A body over the snapshot, made by mineflayer's own blocks plugin.
function bodyFrom(snap) {
  const bot = new EventEmitter();
  bot.setMaxListeners(0);
  bot.registry = snap.registry;
  bot.version = snap.version;
  bot.supportFeature = snap.registry.supportFeature;
  bot._client = new EventEmitter();
  bot.game = { minY: snap.game.minY, height: snap.game.height };
  const p = snap.snapshot.person;
  bot.entity = { position: new Vec3(p.x + 0.5, p.y, p.z + 0.5), height: 1.8 };
  bot.inventory = { items: () => [], slots: [] };
  require('mineflayer/lib/plugins/blocks')(bot, { version: snap.version });
  bot._client.emit('login', { worldState: { dimension: 'minecraft:overworld', name: 'minecraft:overworld' }, dimension: 'minecraft:overworld', worldName: 'minecraft:overworld' });
  for (const { chunkX, chunkZ, column } of snap.world.getColumns()) bot.world.setColumn(chunkX, chunkZ, column);
  return bot;
}

// The floor under the person spot, found by the reader: the start every part measures round.
function startOf(bot, reader) {
  const p = bot.entity.position.floored();
  for (let y = p.y + 2; y > p.y - 8; y--) if (reader.classifyFloor(p.x, y, p.z)) return new Vec3(p.x, y, p.z);
  throw new Error(`[voxel_labels_bench] CODING VIOLATION: no floor under the snapshot's person spot (${p.x},${p.y},${p.z}).`);
}

function boxCells(start, fn) {
  for (let x = start.x - RADIUS; x <= start.x + RADIUS; x++) for (let z = start.z - RADIUS; z <= start.z + RADIUS; z++)
    for (let y = start.y - HEIGHT; y <= start.y + HEIGHT; y++) fn(x, y, z);
}

// ── FLOOR ───────────────────────────────────────────────────────────────────────────────────────────
function floorPart(bot, reader, start) {
  let cells = 0;
  const t0 = now();
  const want = [];
  boxCells(start, (x, y, z) => { want.push(reader.classifyFloor(x, y, z)); cells++; });
  const readerMs = ms(t0);
  const labels = makeVoxelLabels(bot, { reader });
  let i = 0, diff = 0;
  const t1 = now();
  boxCells(start, (x, y, z) => { if (labels.floorAt(x, y, z) !== want[i++]) diff++; });
  const coldMs = ms(t1);
  i = 0;
  const t2 = now();
  boxCells(start, (x, y, z) => { if (labels.floorAt(x, y, z) !== want[i++]) diff++; });
  const warmMs = ms(t2);
  say('floor', `${cells} cells (${2 * RADIUS + 1}x${2 * RADIUS + 1}x${2 * HEIGHT + 1}) · reader ${readerMs.toFixed(1)} ms · labels cold ${coldMs.toFixed(1)} ms `
    + `(${labels.stats.floorSections} sections built) · labels warm ${warmMs.toFixed(1)} ms · ${(readerMs / warmMs).toFixed(1)}x warm · `
    + `${diff ? `*** ${diff} VERDICT(S) DIFFER — timing void ***` : 'every verdict identical'}`);
  labels.dispose();
  return diff === 0;
}

// ── ROUTE ───────────────────────────────────────────────────────────────────────────────────────────
function routeSignature(result) {
  if (!result) return 'NULL';
  const p = result.path || [];
  return `${result.partial ? 'PARTIAL' : 'FULL'}:${p.length}:` + p.map(s => `${s.type || s.action || 'move'}@${s.x ?? s.pos?.x},${s.y ?? s.pos?.y},${s.z ?? s.pos?.z}`).join('|');
}
async function routePart(bot, reader, start) {
  const adapter = { blockAt: (p) => bot.blockAt(p), inventory: bot.inventory, world: bot.world, version: bot.version, entity: bot.entity, game: bot.game, registry: bot.registry };
  const search = async (voxelReader, goal) => {
    const t0 = now();
    const result = await pathfinding.computeAStar(adapter, start, goal, { maxNodes: NODES, combatGate: false, voxelReader });
    return { ms: ms(t0), sig: routeSignature(result), len: result && result.path ? result.path.length : 0, partial: !!(result && result.partial) };
  };
  const labelled = (labels) => Object.assign({}, reader, { classifyFloorAt: labels.floorAt });
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const goalAt = (dx, dz) => ({ type: 'position', pos: new Vec3(start.x + dx * DIST, start.y, start.z + dz * DIST) });
  // JIT warm-up for both arms, discarded.
  const warmLabels = makeVoxelLabels(bot, { reader });
  await search(reader, goalAt(0.2, 0.2));
  await search(labelled(warmLabels), goalAt(0.2, 0.2));
  warmLabels.dispose();

  const kept = makeVoxelLabels(bot, { reader });   // one body's labels, kept across its searches
  let same = 0, totals = { shipped: 0, cold: 0, kept: 0 };
  for (const [dx, dz] of DIRS) {
    const goal = goalAt(dx, dz);
    const a = await search(reader, goal);
    const fresh = makeVoxelLabels(bot, { reader });
    const b = await search(labelled(fresh), goal);
    fresh.dispose();
    const c = await search(labelled(kept), goal);
    const ok = a.sig === b.sig && b.sig === c.sig;
    if (ok) same++;
    totals.shipped += a.ms; totals.cold += b.ms; totals.kept += c.ms;
    say('route', `goal (${dx * DIST},${dz * DIST}) · ${a.partial ? 'partial' : 'full'} ${a.len} steps · shipped ${a.ms.toFixed(0)} ms · labels new ${b.ms.toFixed(0)} ms · labels kept ${c.ms.toFixed(0)} ms · ${ok ? 'route identical' : '*** ROUTE DIFFERS ***'}`);
  }
  kept.dispose();
  say('route', `${same}/${DIRS.length} routes identical · total shipped ${totals.shipped.toFixed(0)} ms · labels new ${totals.cold.toFixed(0)} ms · labels kept ${totals.kept.toFixed(0)} ms `
    + `(${(totals.shipped / totals.kept).toFixed(2)}x kept)${same === DIRS.length ? '' : ' — timing void'}`);
  return same === DIRS.length;
}

// ── LOGS ────────────────────────────────────────────────────────────────────────────────────────────
async function logsPart(bot, reader, start) {
  const logIds = group_to_item.logs.map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(id => id !== undefined);
  const point = new Vec3(start.x, start.y + 1, start.z);
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const viaFind = () => bot.findBlocks({ matching: logIds, maxDistance: RADIUS, count: 1e6, point }).map(key).sort();
  const labelsWay = (labels) => {
    const out = [];
    const c0x = point.x >> 4, c0z = point.z >> 4, reach = Math.ceil(RADIUS / 16) + 1;
    for (let cx = c0x - reach; cx <= c0x + reach; cx++) for (let cz = c0z - reach; cz <= c0z + reach; cz++) {
      for (const c of labels.cellsOfKind('log', cx, cz) || []) {
        if (Math.hypot(c.x - point.x, c.y - point.y, c.z - point.z) <= RADIUS) out.push(key(c));
      }
    }
    return out.sort();
  };
  viaFind();   // JIT warm-up
  const t0 = now();
  const want = viaFind();
  const findMs = ms(t0);
  const labels = makeVoxelLabels(bot, { reader });
  const t1 = now();
  const cold = labelsWay(labels);
  const coldMs = ms(t1);
  const t2 = now();
  const warm = labelsWay(labels);
  const warmMs = ms(t2);
  // The fleet's own search, every ring to the same reach, unpaced and uncollapsed.
  const rings = require('@utils/ring_scan').blockRings(bot, { names: group_to_item.logs, center: point, reach: RADIUS });
  const t3 = now();
  const viaRings = [];
  for (let r = await rings.next(); r; r = await rings.next()) {
    for (const o of r.objectives) if (Math.hypot(o.position.x - point.x, o.position.y - point.y, o.position.z - point.z) <= RADIUS) viaRings.push(key(o.position));
  }
  const ringMs = ms(t3);
  viaRings.sort();
  const ringOk = viaRings.join(';') === want.join(';');
  say('logs', `ring_scan ${ringMs.toFixed(1)} ms (${rings.cost().read} sections read, ${rings.cost().skipped} skipped) · ${ringOk ? 'same logs' : `*** LOGS DIFFER (${viaRings.length} vs ${want.length}) ***`}`);
  const ok = ringOk && want.join(';') === cold.join(';') && cold.join(';') === warm.join(';');
  say('logs', `${want.length} log(s) within ${RADIUS} · findBlocks ${findMs.toFixed(1)} ms · labels cold ${coldMs.toFixed(1)} ms (${labels.stats.kindSections} sections) · `
    + `labels warm ${warmMs.toFixed(2)} ms · ${(findMs / warmMs).toFixed(0)}x warm · ${ok ? 'same logs' : `*** LOGS DIFFER (${want.length} vs ${cold.length}) — timing void ***`}`);
  labels.dispose();
  return ok;
}

// ── CHANGES ─────────────────────────────────────────────────────────────────────────────────────────
function changesPart(bot, reader, start) {
  const states = ['air', 'stone', 'oak_log', 'dirt', 'iron_ore'].map(n => bot.registry.blocksByName[n].defaultState);
  let seed = 12345;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const changeList = () => Array.from({ length: CHANGES }, () => ({
    p: new Vec3(start.x - RADIUS + rand(2 * RADIUS + 1), start.y - HEIGHT + rand(2 * HEIGHT + 1), start.z - RADIUS + rand(2 * RADIUS + 1)),
    s: states[rand(states.length)],
  }));
  const apply = (list) => { const t0 = now(); for (const c of list) bot.world.setBlockStateId(c.p, c.s); return ms(t0); };

  const bare = apply(changeList());   // the world's own cost of writing a change, with no labels listening
  const labels = makeVoxelLabels(bot, { reader });
  boxCells(start, (x, y, z) => labels.floorAt(x, y, z));
  logsSeen(labels, start);
  const withLabels = apply(changeList());

  let diff = 0, cells = 0;
  boxCells(start, (x, y, z) => { cells++; if (labels.floorAt(x, y, z) !== reader.classifyFloor(x, y, z)) diff++; });
  const fresh = makeVoxelLabels(bot, { reader });
  let kindDiff = 0;
  const c0x = start.x >> 4, c0z = start.z >> 4, reach = Math.ceil(RADIUS / 16);
  for (let cx = c0x - reach; cx <= c0x + reach; cx++) for (let cz = c0z - reach; cz <= c0z + reach; cz++) {
    for (const kind of ['log', 'ore']) {
      const a = (labels.cellsOfKind(kind, cx, cz) || []).map(c => `${c.x},${c.y},${c.z}`).sort().join(';');
      const b = (fresh.cellsOfKind(kind, cx, cz) || []).map(c => `${c.x},${c.y},${c.z}`).sort().join(';');
      if (a !== b) kindDiff++;
    }
  }
  fresh.dispose();

  // A column re-sent: the world loads it again, and the labels must drop what they held for it.
  const cx = start.x >> 4, cz = start.z >> 4;
  const col = bot.world.getColumn(cx, cz);
  bot.world.unloadColumn(cx, cz);
  const goneOk = labels.floorAt(start.x, start.y, start.z) === null;
  bot.world.setColumn(cx, cz, col);
  const backOk = labels.floorAt(start.x, start.y, start.z) === reader.classifyFloor(start.x, start.y, start.z);

  const per = (withLabels - bare) / CHANGES;
  const ok = diff === 0 && kindDiff === 0 && goneOk && backOk;
  say('changes', `${CHANGES} changes · world alone ${bare.toFixed(1)} ms · with labels listening ${withLabels.toFixed(1)} ms · `
    + `≈${(per * 1000).toFixed(1)} µs per change for the labels · ${labels.stats.corrections} corrected`);
  say('changes', `after the changes: ${cells} floor labels ${diff ? `*** ${diff} STALE ***` : 'all equal to a fresh read'} · log/ore lists `
    + `${kindDiff ? `*** ${kindDiff} column(s) STALE ***` : 'equal to a fresh labelling'} · column unloaded → ${goneOk ? 'labels gone' : '*** STILL HELD ***'} · `
    + `reloaded → ${backOk ? 'labelled afresh' : '*** WRONG ***'}`);
  labels.dispose();
  return ok;
}
function logsSeen(labels, start) {
  const c0x = start.x >> 4, c0z = start.z >> 4, reach = Math.ceil(RADIUS / 16);
  for (let cx = c0x - reach; cx <= c0x + reach; cx++) for (let cz = c0z - reach; cz <= c0z + reach; cz++) labels.cellsOfKind('log', cx, cz);
}

async function main() {
  const snap = store.loadSnapshot(SNAPSHOT);
  const bot = bodyFrom(snap);
  const reader = makeVoxelReader(bot, { needs: ['type'] });
  const start = startOf(bot, reader);
  say('body', `snapshot '${snap.snapshot.label}' (${bot.world.getColumns().length} columns, ${snap.version}) · start floor (${start.x},${start.y},${start.z})`);
  const results = [floorPart(bot, reader, start), await routePart(bot, reader, start), await logsPart(bot, reader, start), changesPart(bot, reader, start)];
  reader.dispose();
  const ok = results.every(Boolean);
  say('verdict', ok ? 'every label matched a fresh read' : '*** a label differed from a fresh read — see the lines above ***');
  process.exit(ok ? 0 : 1);
}

main();
