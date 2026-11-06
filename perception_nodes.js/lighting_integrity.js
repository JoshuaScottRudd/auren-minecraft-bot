// perception node: lighting_integrity
// The one node that says where the crew's torches stand and whether the ground they light is lit. No torch is
// placed, and no ground is judged lit, by a light reading: every torch stands where a design puts it.
//
//   THE MINE   its design's torches (mineLamps): the staircase's declared light point on every
//              TORCH_NETWORK.stair_every-th copy and the bottom one, a strip tunnel's doorway block and every
//              tunnel_every blocks after it, a cell's declared light point. The body digging a cell places its
//              torch in the same pass (mining_integrity reads mineLamps); a lighting visit takes the dug shaft's
//              missing ones.
//   THE BASE   the torches on posts the base's spawn proofing declares (base_layout), built with the spawn proofing like any other
//              voxel and repaired by its survey. The posts were proven to light the base's ground when it was sited
//              (base_layout.paintLights), so the base is lit when every one of its torches stands.
//
//   THE BASEMENT one wall torch per column's cell (downloaded_plan_registry.basementCell), on every crew. The body digging a cell hangs its torch; a lighting visit takes the missing ones.
//
// WHO READS THE WORLD. The integrity keeper (foreman/integrity_keeper_worker.js) compares these designs with the world
// once for the whole crew and sends its 'light' verdict to every body (keeper_verdicts). This node reads that verdict:
// a visit takes the shaft torches it names missing, and the night gate (litAtNight, read by job_gates.nightGate) opens
// on the base's ground once it names every spawn-proofing torch standing. A verdict older than keeper_verdicts.STALE_S is
// unknown, and unknown holds the work (Law 13). The digger's own torches stay on mineLamps, placed as it digs.
//
// Pure observation (Law 1 perception exception); the manager calls scan() and the assessor reads it.

'use strict';

const watcher = require('@kernel/watcher');
const keeperVerdicts = require('@kernel/keeper_verdicts');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { getBotInventory } = require('@utils/fragment_utils');

const TAG = 'lighting_integrity';
const TORCH = 'torch';
const STEP = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (x, y, z) => `${x},${y},${z}`;

// standBeside(world, c) → whether a body can stand beside the column of cell c: a standable cell one step across,
// level or one up or down (the cell lighting_executor.standBeside looks for). `world` answers standable(x,y,z).
function standBeside(world, c) {
  return STEP.some(([dx, dz]) => [0, 1, -1].some(dy => world.standable(c.x + dx, c.y + dy, c.z + dz)));
}

// ── THE MINE ──────────────────────────────────────────────────────────────────────────────────────────
let _mine = null;

// designLamps(site, units) → the mine's torches as its design places them, for a shaft site (its set_buildspot,
// with transpose_origin and staircase) and its registered units: each { x, y, z, paint: 'mine', mount: 'wall', source,
// attach, post: null, part } standing over the stand cell (x,y,z), part 'shaft' for the staircase's
// (mining_blueprinter.stairLamps), 'cell' for a unit's (mining_cell_graph.unitLamps) and 'door' for the shaft head's
// own declared light points (its door's torches, base_layout.lightPointsOf). The one definition the body and the
// integrity keeper both read (Law 16).
function designLamps(site, units) {
  const blueprinter = require('@perception/mining_blueprinter');
  const cellGraph = require('@perception/mining_cell_graph');
  const { segments } = blueprinter.projectStaircase({ headAWorld: blueprinter.shaftTop(site), ...blueprinter.siteDescent(site), turn: blueprinter.siteTurn(site) });
  const head = require('@kernel/blueprint_registry').tryGetBuilding(blueprinter.shaftStructure());   // a standalone shaft's site is no blueprint
  // A door torch hangs over the door's top, two above the floor a body stands on to place it; the rest one above.
  const lamp = (part, drop = 1) => (l) => ({ x: l.source.x, y: l.source.y - drop, z: l.source.z, paint: 'mine', mount: 'wall', source: l.source, attach: l.attach, post: null, part });
  return [
    ...blueprinter.stairLamps(segments, blueprinter.siteTurn(site)).map(lamp('shaft')),
    ...units.filter(u => u && u.anchor && !u.blocked).flatMap(u => cellGraph.unitLamps(u)).map(lamp('cell')),
    ...(head ? require('@kernel/base_layout').lightPointsOf(head, site.transpose_origin) : []).map(lamp('door', 2)),
  ];
}

// mineLamps() → { placements, spots } for this body's own shaft and units (designLamps), `spots` keying each by the
// cell the torch stands in. Nothing while the shaft has no locked site. Kept while the site and the registered units
// are unchanged.
function mineLamps() {
  const site = require('@perception/mining_blueprinter').shaftChair();
  if (!site) return { placements: [], spots: new Map() };
  const cellGraph = require('@perception/mining_cell_graph');
  const version = JSON.stringify([site.transpose_origin, site.staircase.lowestSafeY, site.staircase.deep || null, cellGraph.cellsGeneration()]);
  if (_mine && _mine.version === version) return _mine;
  const placements = designLamps(site, Object.values(cellGraph.readCells()));
  _mine = { version, placements, spots: new Map(placements.map(p => [key(p.source.x, p.source.y, p.source.z), p])) };
  return _mine;
}

// ── THE BASE ──────────────────────────────────────────────────────────────────────────────────────────
// baseTorches(site) → { rect, torches } in world cells for the base's locked spawn-proofing site: the base's area (x and z) and the
// cell of every torch its spawn proofing declares (base_layout.proofingTorches). The one definition the body and the keeper both read.
function baseTorches(site) {
  return require('@kernel/base_layout').proofingTorches(site);
}

// baseLight() → baseTorches for this crew's own locked spawn proofing, or null while it has none.
function baseLight() {
  const site = require('@kernel/corporate_headquarters').readBuildingChair(require('@thinking/architect_config').SPAWN_PROOFING, 'set_buildspot');
  return site && site.transpose_origin && site.lights ? baseTorches(site) : null;
}

// ── THE BASEMENT ──────────────────────────────────────────────────────────────────────────────────────
// basementLamps(name, site) → the torches of the downloaded building's basement cells as designed, in the form
// designLamps gives, part 'basement'. The one definition the keeper and the navigator read.
function basementLamps(name, site) {
  const planRegistry = require('@kernel/downloaded_plan_registry');
  planRegistry.load(name);
  const frame = planRegistry.siteFrame(site);
  const world = (p) => frame.worldOf(p.x, p.y, p.z);
  return planRegistry.columns().flatMap(c => planRegistry.basementCell(c).lamps).map((l) => {
    const source = world(l.source);
    return { x: source.x, y: source.y - 1, z: source.z, paint: 'basement', mount: 'wall', source, attach: world(l.attach), post: null, part: 'basement' };
  });
}

// basementWalls() → the "x,y,z" keys of every solid block of this crew's basement cells, or null: the cells' twin of
// mining_cell_graph.getProtectedBlocks, so routes keep to the doors. The roof over a stand stays out: the climb cuts it.
let _walls = null;
function basementWalls() {
  const { CREW_BUILD } = require('@thinking/architect_config');
  const name = CREW_BUILD[require('@kernel/bot_mandate').currentMode()];
  if (!name) return null;
  const site = require('@kernel/corporate_headquarters').readBuildingChair(name, 'set_buildspot');
  if (!site || !site.footprint) return null;
  const version = JSON.stringify(site.footprint);
  if (!_walls || _walls.version !== version) {
    const planRegistry = require('@kernel/downloaded_plan_registry');
    planRegistry.load(name);
    const frame = planRegistry.siteFrame(site);
    const keys = new Set();
    for (const c of planRegistry.columns()) {
      const cell = planRegistry.basementCell(c);
      const roof = new Set(cell.roof.map(b => b.join()));
      for (const b of cell.fill) {
        if (roof.has(b.join())) continue;
        const w = frame.worldOf(b[0], b[1], b[2]);
        keys.add(key(w.x, w.y, w.z));
      }
    }
    _walls = { version, keys };
  }
  return _walls.keys;
}

// ── THE SCAN ──────────────────────────────────────────────────────────────────────────────────────────
let _lastScan = null;
let _lastLoggedKey = null;

// scan(bot) → the verdict the assessor, the manager and the night gate read:
//   located          the crew's shaft is sited, or a basement torch is missing
//   placements       the basement's missing torches, then the dug shaft's, those a visit can stand beside, at most
//                    a trip's worth
//   mine_planned     the mine's torches on its design
//   torches_have     torches in the pocket
function scan(bot) {
  if (!bot || !bot.world) {
    throw new Error(`[${TAG}] CODING VIOLATION: bot must be initialized before scan(). Check caller.`);
  }
  const { TORCH_NETWORK } = require('@thinking/architect_config');
  const torchesHave = countInInventory(TORCH, getBotInventory() || {});
  const base = { schema: 'auren.lighting_integrity.v4', generated_at: new Date().toISOString(), torches_have: torchesHave };
  const mine = mineLamps();
  const verdict = keeperVerdicts.get('light');
  // A torch whose wall no longer holds one (the keeper's `mountable`) is not a torch any visit can place, so it is not offered.
  const placeable = (p) => p.stand && p.mountable;
  const basement = verdict && verdict.basement ? verdict.basement.missing.filter(placeable) : [];
  if (!require('@perception/mining_blueprinter').shaftChair()) {
    _lastScan = { ...base, located: basement.length > 0, placements: basement.slice(0, TORCH_NETWORK.torches_per_trip) };
    _log(`noshaft|${basement.length}`, `no shaft sited yet — no mine torch to place, ${basement.length} basement torch(es) missing`);
    return _lastScan;
  }
  // A shaft torch is missing where the keeper reads its cell dug and empty, a door torch where it reads the wall over
  // the door standing and the cell empty; a visit walks to it, so it takes only one the keeper read a stand beside.
  // A tunnel's torches are its digger's, placed as it digs.
  if (!verdict) {
    _lastScan = { ...base, located: true, placements: basement.slice(0, TORCH_NETWORK.torches_per_trip), mine_planned: mine.placements.length, shaft_planned: 0 };
    _log('nokeeper', `no shaft torch visit — ${keeperVerdicts.why('light')}`);
    return _lastScan;
  }
  const shaft = verdict.mine.missing.filter(p => (p.part === 'shaft' || p.part === 'door') && placeable(p));
  const placements = [...basement, ...shaft].slice(0, TORCH_NETWORK.torches_per_trip);
  _lastScan = { ...base, located: true, placements, mine_planned: mine.placements.length, shaft_planned: placements.length };
  _log(`${mine.placements.length}|${shaft.length}|${basement.length}`,
    `mine ${mine.placements.length} torch(es) on its design, ${shaft.length} of them in the dug shaft and missing (a visit takes these), ${basement.length} basement torch(es) missing`);
  return _lastScan;
}

// One summary per change of verdict (Law 5).
function _log(stateKey, line) {
  if (stateKey === _lastLoggedKey) return;
  _lastLoggedKey = stateKey;
  watcher.summary(TAG, line);
}

function getState() { return _lastScan; }

// litAtNight(job) → { ok, reason }: whether the job's `where` lies on the base's ground with every torch its spawn proofing
// declares standing, as the keeper's current light verdict reads it. job_gates.nightGate asks it for work that stays
// at its site.
function litAtNight(job) {
  const lightOf = baseLight();
  if (!lightOf) return { ok: false, reason: 'no spawn proofing is sited' };
  const at = job && job.where;
  if (!at || typeof at.x !== 'number' || typeof at.z !== 'number') return { ok: false, reason: 'the job names no place' };
  const x = Math.floor(at.x), z = Math.floor(at.z), r = lightOf.rect;
  if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) return { ok: false, reason: `(${x},${z}) is outside the base` };
  const verdict = keeperVerdicts.get('light');
  if (!verdict) return { ok: false, reason: keeperVerdicts.why('light') };
  const b = verdict.base;
  if (!b) return { ok: false, reason: 'the integrity keeper reads no spawn proofing yet' };
  if (b.standing !== lightOf.torches.length || b.torches !== lightOf.torches.length) {
    return { ok: false, reason: `${b.torches - b.standing} of the base's ${b.torches} torch(es) not standing (${b.missing.length} missing, ${b.blocked.length} blocked, ${b.unknown} unread)` };
  }
  return { ok: true, reason: 'on the base with every torch standing' };
}

module.exports = { scan, getState, litAtNight, designLamps, mineLamps, baseTorches, baseLight, standBeside, basementLamps, basementWalls };
