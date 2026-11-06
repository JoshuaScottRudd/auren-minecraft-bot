// foreman/integrity_keeper_worker.js — THE INTEGRITY KEEPER'S OWN THREAD.
//
// The keeper holds the crew's plan-against-world verdicts for the whole fleet (integrity_keeper.js says why it
// is one place). This thread does the work, so no verdict ever holds the foreman's own thread or its planning
// gate. It has no body: the foreman's body feeds it a copy of the chunks the plans stand in and every block
// change inside them, and it keeps its own world from those.
//
// ── THE SUBJECT IT KEEPS TODAY: LIGHT, AS DESIGNED TORCHES ────────────────────────────────────────────
// No light level is read. Every torch stands where a design puts it, and the design is proven lit at load, so
// "is it lit" is "does every designed torch stand", one cell each:
//   THE BASE   the torch on every post the crew's spawn proofing declares (lighting_integrity.baseTorches, base_layout).
//   THE MINE   the torches the shaft's staircase and every registered unit design (lighting_integrity.designLamps).
// Each torch cell reads one of: standing (a torch is there), missing (open, no torch), undug (a mine torch still
// in rock: its digger places it), blocked (a base torch cell holds another block), or unknown (not held).
// A missing shaft torch carries `stand`: whether a body can stand beside it as the world stands now, and `mountable`:
// whether its wall is a full solid block a torch hangs on, so a visit is sent only to the ones it can place.
//
// ── HOW IT STAYS CURRENT ──────────────────────────────────────────────────────────────────────────────
//   1. New plans: the torch cells are worked out again and the columns holding them asked for.
//   2. A block change inside the held chunks: the copy follows it and the verdict is read again.
//   3. The verdict is posted when it changes, at most every POST_MS, and renewed every RENEW_MS unchanged. The
//      structures verdict is posted after every read a block change caused, changed or not: its generated_at is
//      the proof a body holds a heard change against (blueprint_survey.keptReading).
//
// ── THE SECOND SUBJECT: STRUCTURES, EVERY SITED BLUEPRINT AGAINST THE WORLD ───────────────────────────
// Every locked building room in the plans (the farm's fields among them) is diffed against this thread's world
// by the same diff a body runs (blueprint_survey.scanBuilding), so every body reads one verdict per structure
// instead of each judging from whatever chunks it happens to hold. Per room key: `held` (every column the
// structure stands in is held here), `all_complete`, and the diff's `steps` and `stats`. A structure not wholly
// held is posted with held false and no diff: unknown, never built.
//
// ── THE TREE FARM: THE HOME BAND'S MAP ────────────────────────────────────────────────────────────────
// Every grid cell of the tree farm's home band (perception_nodes/tree_farm_ground) kept treed, open, blocked or
// unknown, and the band's saturation, so the crew plants the band to TREE_FARM.saturation and no further, read once
// for every body.
//
//
// Messages in:  plans {buildings, mine_cells}, column {cx, cz, json}, unload {cx, cz}, blocks {list}
// Messages out: want {columns}, verdict {subject, verdict}, log {line}

'use strict';

const path = require('path');
const { parentPort, workerData, isMainThread } = require('worker_threads');

// The thread's whole life. Loaded outside its thread (preflight loads every file) it is inert: nothing runs.
function runKeeperThread() {
  const BOT_ROOT = path.resolve(__dirname, '..');
  process.env.BOT_MODE = workerData.mode;
  process.env.BOT_ID = process.env.BOT_ID || 'Foreman';
  require('module-alias').addAliases({
    '@perception': BOT_ROOT + '/perception_nodes.js', '@action': BOT_ROOT + '/action_fragments.js',
    '@api': BOT_ROOT + '/custom_api', '@locomotion': BOT_ROOT + '/custom_api/locomotion',
    '@kernel': BOT_ROOT + '/js_kernel', '@js_kernel': BOT_ROOT + '/js_kernel', '@utils': BOT_ROOT + '/js_kernel/utils',
    '@thinking': BOT_ROOT + '/Thinking_fragments', '@foreman': BOT_ROOT + '/foreman',
  });
  require('@utils/node_module_homes').bootstrapModulePath();
  require('@utils/require_memo').install();

  const Vec3 = require('vec3');
  const timeoutCrash = require('@utils/timeout_crash');
  const { SPAWN_PROOFING, SHAFT_HEAD, SERVER_MINECRAFT_VERSION, FARM_FIELD, CREW_BUILD } = require('@thinking/architect_config');
  const registry = require('prismarine-registry')(SERVER_MINECRAFT_VERSION);
  const Chunk = require('prismarine-chunk')(registry);
  const World = require('prismarine-world')(registry);
  const { makeVoxelReader, FLAGS } = require('@utils/voxel_reader');
  const { designLamps, basementLamps, baseTorches, standBeside } = require('@perception/lighting_integrity');
  const { roomKeyName, isBuildingTombstone } = require('@foreman/message_schema');
  const blueprintRegistry = require('@kernel/blueprint_registry');
  const { scanBuilding, collectAllVoxels, transposeVoxel, transposeAnchorsForCandidate } = require('@perception/blueprint_survey');
  const { fieldCellsAt, censusAt } = require('@perception/farmland_site');
  const { resolveStandableAnchor } = require('@utils/stand_reach');

  const TAG = 'integrity_keeper';
  const POST_MS = 1000;
  const RENEW_MS = 10000;          // an unchanged verdict is sent again this often, so a body can tell a quiet keeper from a stopped one

  const K = (x, y, z) => `${x},${y},${z}`;
  const colKey = (cx, cz) => `${cx},${cz}`;
  const say = (line) => parentPort.postMessage({ type: 'log', line });
  const mode = workerData.mode;

  // ── THE WORLD THIS THREAD HOLDS ───────────────────────────────────────────────────────────────────────
  const world = new World(null).sync;
  const held = new Set();                                    // chunk columns held, "cx,cz"
  const reader = makeVoxelReader({ world, version: SERVER_MINECRAFT_VERSION }, { needs: ['type'] });
  const has = (f, bit) => f >= 0 && (f & bit) !== 0;
  const planWorld = {
    standable(x, y, z) {
      return has(reader.flagsAt(x, y, z), FLAGS.PASSABLE) && has(reader.flagsAt(x, y + 1, z), FLAGS.PASSABLE) && has(reader.flagsAt(x, y - 1, z), FLAGS.WALKABLE);
    },
  };
  const OPEN = new Set(['air', 'cave_air', 'void_air']);
  const isTorch = (n) => n === 'torch' || n === 'wall_torch';
  const SOLID = (c) => { const b = reader.blockAt(c.x, c.y, c.z); return !!b && !OPEN.has(b.name) && !isTorch(b.name); };
  // MOUNT: a wall a torch hangs on, judged as lighting_executor judges it (a full solid block); a wall dug away or
  // turned into a part block leaves the torch nothing to place on.
  const MOUNT = (c) => { const f = reader.flagsAt(c.x, c.y, c.z); return has(f, FLAGS.SOLID) && has(f, FLAGS.FULL_HEIGHT); };

  // ── THE TORCHES THE PLANS DESIGN ──────────────────────────────────────────────────────────────────────
  let base = null;                                           // { rect, torches } or null
  let mine = [];                                             // designLamps placements
  let basement = null;                                       // basementLamps placements, or null for a crew that owes none
  let basementKey = null;
  let dirty = false;

  function siteOf(buildings, name) {
    for (const [roomKey, entry] of Object.entries(buildings || {})) {
      if (roomKeyName(roomKey) !== name || !entry || isBuildingTombstone(entry)) continue;
      const site = entry.set_buildspot;
      if (site && site.transpose_origin && typeof site.transpose_origin.x === 'number') return site;
    }
    return null;
  }

  // A crew that builds a downloaded building lights its basement cells.
  function basementOf(buildings) {
    const name = CREW_BUILD[mode] || null;
    if (!name) return null;
    for (const [roomKey, entry] of Object.entries(buildings || {})) {
      if (roomKeyName(roomKey) !== name || !entry || isBuildingTombstone(entry)) continue;
      const site = entry.set_buildspot;
      if (!site || !site.footprint) continue;
      const k = JSON.stringify(site.footprint);
      if (k !== basementKey) { basementKey = k; basement = basementLamps(name, site); }
      return basement;
    }
    basementKey = null;
    return null;
  }

  // ── THE STRUCTURES THE PLANS SITE ─────────────────────────────────────────────────────────────────────
  // roomKey → { blueprint, pasted (the transposed voxels, as blueprint_survey.survey builds them), columns }
  let structures = new Map();
  let structuresDirty = false;

  function structuresOf(buildings) {
    const out = new Map();
    for (const roomKey of Object.keys(buildings || {}).sort()) {
      const entry = buildings[roomKey];
      if (!entry || isBuildingTombstone(entry) || !entry.blueprint_paster) continue;
      const site = entry.set_buildspot;
      if (!site || !site.transpose_origin || typeof site.transpose_origin.x !== 'number') continue;
      const name = entry.blueprint_paster.building_name || roomKeyName(roomKey);
      require('@kernel/base_layout').learnProofing(name, site);   // a spawn proofing is drawn from the lights its site carries
      const building = blueprintRegistry.tryGetBuilding(name);
      if (!building) { say(`structures: room ${roomKey} names blueprint ${name}, which no blueprint carries; not kept`); continue; }
      const center = building.transpose_origin || { x: 0, y: 0, z: 0 };
      const voxels = collectAllVoxels(building).map(({ raw, anchor_index }) => ({ ...transposeVoxel(site.transpose_origin, center, raw), anchor_index }));
      const pasted = { building_name: name, voxels, external_types: new Set(building.external_voxel_types || []), accepts: building.voxel_accepts || null };
      // A crop field also gets its cells, its anchors and its footprint laid out, for the fields verdict: stranded by
      // farm_executor.tendPlot's own rule, every anchor with no stand that keeps off the field's own cells.
      const field = FARM_FIELD.keys.includes(roomKeyName(roomKey))
        ? { cells: fieldCellsAt(name, site.transpose_origin), anchors: transposeAnchorsForCandidate(building, site.transpose_origin),
          footprint: new Set(voxels.map(v => `${v.x},${v.y},${v.z}`)), fallback: building.stand_fallback !== false } : null;
      out.set(roomKey, { blueprint: name, pasted, field, columns: [...new Set(voxels.map(v => colKey(v.x >> 4, v.z >> 4)))] });
    }
    return out;
  }

  function onPlans(m) {
    const proofing = siteOf(m.buildings, SPAWN_PROOFING);
    base = proofing && proofing.lights ? baseTorches(proofing) : null;
    const shaft = siteOf(m.buildings, SHAFT_HEAD[mode]);
    mine = shaft && shaft.staircase ? designLamps(shaft, Object.values(m.mine_cells || {})) : [];
    basement = basementOf(m.buildings);
    structures = structuresOf(m.buildings);
    const cells = [...(base ? base.torches : []), ...mine.map(p => p.source), ...(basement || []).map(p => p.source)];
    const keys = new Set(cells.map(c => colKey(c.x >> 4, c.z >> 4)));
    for (const st of structures.values()) for (const k of st.columns) keys.add(k);
    for (const k of mansionWatch.onPlans(m.buildings)) keys.add(k);
    for (const k of treeFarm.onPlans(m.buildings)) keys.add(k);
    const columns = [...keys].map(k => k.split(',').map(Number));
    parentPort.postMessage({ type: 'want', columns });
    dirty = true;
    structuresDirty = true;
    mansionDirty = true;
    say(`plans read:${base ? base.torches.length : 0} base torch(es), ${mine.length} mine torch(es), ${basement ? basement.length : 0} basement torch(es) on their designs, `
      + `${structures.size} sited structure(s), ${columns.length} column(s) asked for`);
  }

  // ── THE VERDICT ───────────────────────────────────────────────────────────────────────────────────────
  const stateOf = (c, inRock) => {
    if (!held.has(colKey(c.x >> 4, c.z >> 4))) return 'unknown';
    const b = reader.blockAt(c.x, c.y, c.z);
    if (!b) return 'unknown';
    if (isTorch(b.name)) return 'standing';
    if (OPEN.has(b.name)) return 'missing';
    return inRock;
  };
  function read() {
    const v = { base: null, mine: { torches: mine.length, standing: 0, missing: [], undug: 0, unknown: 0 }, basement: null };
    if (base) {
      v.base = { torches: base.torches.length, standing: 0, missing: [], blocked: [], unknown: 0, rect: base.rect };
      for (const t of base.torches) {
        const s = stateOf(t, 'blocked');
        if (s === 'standing') v.base.standing++;
        else if (s === 'unknown') v.base.unknown++;
        else v.base[s].push(K(t.x, t.y, t.z));
      }
    }
    for (const p of mine) {
      // A door torch hangs on the wall over the door: until that wall stands it is not yet a torch to place.
      const s = p.part === 'door' && !SOLID(p.attach) ? (held.has(colKey(p.source.x >> 4, p.source.z >> 4)) ? 'undug' : 'unknown') : stateOf(p.source, 'undug');
      if (s === 'standing') v.mine.standing++;
      else if (s === 'unknown') v.mine.unknown++;
      else if (s === 'undug') v.mine.undug++;
      else v.mine.missing.push({ ...p, stand: standBeside(planWorld, p), mountable: MOUNT(p.attach) });
    }
    if (basement) {
      v.basement = { torches: basement.length, standing: 0, missing: [], undug: 0, unknown: 0 };
      for (const p of basement) {
        const s = stateOf(p.source, 'undug');
        if (s === 'standing') v.basement.standing++;
        else if (s === 'unknown') v.basement.unknown++;
        else if (s === 'undug') v.basement.undug++;
        else v.basement.missing.push({ ...p, stand: standBeside(planWorld, p), mountable: MOUNT(p.attach) });
      }
    }
    return v;
  }

  let lastPosted = '';
  let lastPostAt = 0;
  timeoutCrash.every(TAG, 'post the light verdict when it changed, and renew it every RENEW_MS when it did not', () => {
    const renew = Date.now() - lastPostAt >= RENEW_MS;
    if (!dirty && !renew) return;
    dirty = false;
    const v = read();
    const shape = JSON.stringify(v);
    if (shape === lastPosted && !renew) return;
    if (shape !== lastPosted) {
      say(`light: base ${v.base ? `${v.base.standing}/${v.base.torches} standing, ${v.base.missing.length} missing, ${v.base.blocked.length} blocked, ${v.base.unknown} unknown` : 'no spawn proofing sited'}; `
        + `mine ${v.mine.standing}/${v.mine.torches} standing, ${v.mine.missing.length} missing, ${v.mine.undug} undug, ${v.mine.unknown} unknown`
        + (v.basement ? `; basement ${v.basement.standing}/${v.basement.torches} standing, ${v.basement.missing.length} missing, ${v.basement.undug} undug, ${v.basement.unknown} unknown` : ''));
    }
    lastPosted = shape;
    lastPostAt = Date.now();
    parentPort.postMessage({ type: 'verdict', subject: 'light', verdict: { schema: 'auren.integrity_keeper.light.v5', generated_at: new Date().toISOString(), ...v } });
  }, POST_MS);

  // ── THE STRUCTURES VERDICT ────────────────────────────────────────────────────────────────────────────
  // The thread's world, read as a body reads its own: a cell in a column not held is unloaded (null).
  const standIn = { blockAt: (p) => (held.has(colKey(p.x >> 4, p.z >> 4)) ? world.getBlock(p) : null) };
  let structuresBusy = false;

  // ── THE MANSION VERDICT (foreman/mansion_keeper): every cube and stand shaft of the downloaded building ───────
  // Read when a block in the thread's world changed, at most every MANSION_MS, and renewed every RENEW_MS.
  const MANSION_MS = 2000;
  const mansionWatch = require('@foreman/mansion_keeper').createMansionWatch({ mode, standIn, held, colKey, say });
  let mansionDirty = false, lastMansion = '', lastMansionAt = 0;
  timeoutCrash.every(TAG, 'post the mansion verdict when the world changed, and renew it every RENEW_MS when it did not', () => {
    const renew = Date.now() - lastMansionAt >= RENEW_MS;
    if (!mansionDirty && !renew) return;
    mansionDirty = false;
    const v = mansionWatch.read();
    const shape = JSON.stringify(v);
    if (shape !== lastMansion && v.plan) say(`mansion: ${v.ok} cube(s) ok, ${v.open} open, ${v.unheld} unheld`);
    lastMansion = shape;
    lastMansionAt = Date.now();
    parentPort.postMessage({ type: 'verdict', subject: 'mansion', verdict: { schema: 'auren.integrity_keeper.mansion.v1', generated_at: new Date().toISOString(), ...v } });
  }, MANSION_MS);

  // ── THE TREE FARM VERDICT: THE HOME BAND'S MAP (perception_nodes/tree_farm_ground) ──────────────────────────
  // Every grid cell of the home band is kept treed, open, blocked or unknown, read again only when a block within
  // its reach changed or its columns arrived, at most TREE_BATCH cells a beat so no read holds the thread. Posted
  // when the counts change and renewed every RENEW_MS: the band's saturation (treed over treed and open), whether
  // it is at TREE_FARM.saturation, and its open cells nearest home first (TREE_OPEN_LIST), which the chest job plants.
  const TREE_MS = 1000, TREE_BATCH = 100, TREE_OPEN_LIST = 64, TREE_SAY_MS = 60000;
  const treeFarm = (() => {
    const ground = require('@perception/tree_farm_ground');
    const { TREE_FARM, GATHER_KEEPOUT, GATHER_REACH, ALPHA_STRUCTURE } = require('@thinking/architect_config');
    const SKY = 24;                      // the column read runs this far over and under the home's origin
    let farm = null, originY = 0;
    let cells = new Map();               // "x,z" → { cell, state, y }
    let byColumn = new Map();            // chunk column → the band cells within ground.FLUID_REACH of it
    const dirtyCells = new Set();
    const at = (x, y, z) => (held.has(colKey(x >> 4, z >> 4)) ? reader.blockAt(x, y, z) : null);
    const reach = Math.max(ground.FLUID_REACH, TREE_FARM.spacing);
    const touch = (x, z) => {
      for (const key of byColumn.get(colKey(x >> 4, z >> 4)) || []) {
        const c = cells.get(key).cell;
        if (Math.abs(c.x - x) <= reach && Math.abs(c.z - z) <= reach) dirtyCells.add(key);
      }
    };
    // onPlans(buildings) → the chunk columns the band and its reach stand in.
    function onPlans(buildings) {
      const homeSite = siteOf(buildings, ALPHA_STRUCTURE[mode]);
      const boxes = require('@action/find_buildingspot').footprintsOf(buildings || {}, 0);
      const home = boxes.find(b => roomKeyName(b.key) === ALPHA_STRUCTURE[mode]);
      const was = farm ? JSON.stringify([farm.start, farm.band.length, originY]) : null;
      farm = homeSite && home ? ground.farmOf({ boxes, home, origin: homeSite.transpose_origin, row: TREE_FARM, keepout: GATHER_KEEPOUT, reach: GATHER_REACH }) : null;
      if (!farm) { cells = new Map(); byColumn = new Map(); dirtyCells.clear(); return []; }
      originY = Math.floor(homeSite.transpose_origin.y);
      const next = new Map(), cols = new Map();
      for (const c of farm.band) {
        const key = `${c.x},${c.z}`;
        next.set(key, cells.get(key) || { cell: c, state: 'unknown', y: null });
        for (let cx = (c.x - reach) >> 4; cx <= (c.x + reach) >> 4; cx++) {
          for (let cz = (c.z - reach) >> 4; cz <= (c.z + reach) >> 4; cz++) {
            const k = colKey(cx, cz);
            if (!cols.has(k)) cols.set(k, []);
            cols.get(k).push(key);
          }
        }
      }
      cells = next;
      byColumn = cols;
      if (JSON.stringify([farm.start, farm.band.length, originY]) !== was) for (const key of cells.keys()) dirtyCells.add(key);
      return [...cols.keys()];
    }
    const onColumn = (cx, cz) => { for (const key of byColumn.get(colKey(cx, cz)) || []) dirtyCells.add(key); };
    // readSome() → true when a cell's state changed.
    function readSome() {
      let changed = false, n = 0;
      for (const key of dirtyCells) {
        if (n++ >= TREE_BATCH) break;
        dirtyCells.delete(key);
        const e = cells.get(key);
        if (!e) continue;
        const r = ground.cellState(at, e.cell, originY + SKY, originY - SKY, TREE_FARM.spacing);
        if (r.state !== e.state || (r.y ?? null) !== e.y) changed = true;
        e.state = r.state;
        e.y = r.y ?? null;
      }
      return changed;
    }
    function verdict() {
      if (!farm) return { sited: false };
      const count = { treed: 0, open: 0, blocked: 0, unknown: 0 };
      const open = [];
      for (const e of cells.values()) {
        count[e.state]++;
        if (e.state === 'open') open.push(e);
      }
      open.sort((p, q) => p.cell.gap - q.cell.gap);
      const plantable = count.treed + count.open;
      const saturation = plantable ? Math.round((100 * count.treed) / plantable) : null;
      return {
        sited: true, start: farm.start, close: TREE_FARM.close, target: TREE_FARM.saturation,
        band: { cells: cells.size, ...count, pending: dirtyCells.size },
        saturation, full: count.open === 0 || saturation >= TREE_FARM.saturation,
        open_cells: open.slice(0, TREE_OPEN_LIST).map(e => ({ x: e.cell.x, y: e.y, z: e.cell.z, gap: e.cell.gap })),
      };
    }
    return { onPlans, onColumn, touch, readSome, verdict };
  })();
  let lastTree = '', lastTreeAt = 0, lastTreeSaid = '', lastTreeSaidAt = 0;
  timeoutCrash.every(TAG, 'read the tree farm cells that changed and post the tree farm verdict when it changed, and renew it every RENEW_MS', () => {
    const changed = treeFarm.readSome();
    const renew = Date.now() - lastTreeAt >= RENEW_MS;
    if (!changed && !renew && lastTree) return;
    const v = treeFarm.verdict();
    const shape = JSON.stringify(v);
    if (shape === lastTree && !renew) return;
    const said = v.sited ? `tree farm: home band ${v.band.treed} treed, ${v.band.open} open, ${v.band.blocked} blocked, ${v.band.unknown} unknown`
      + ` of ${v.band.cells}; saturation ${v.saturation === null ? 'none' : `${v.saturation}%`} of ${v.target}%${v.full ? ', FULL' : ''}` : 'tree farm: not sited';
    if (said !== lastTreeSaid && (Date.now() - lastTreeSaidAt >= TREE_SAY_MS || !lastTreeSaid)) { say(said); lastTreeSaid = said; lastTreeSaidAt = Date.now(); }
    lastTree = shape;
    lastTreeAt = Date.now();
    parentPort.postMessage({ type: 'verdict', subject: 'tree_farm', verdict: { schema: 'auren.integrity_keeper.tree_farm.v1', generated_at: new Date().toISOString(), ...v } });
  }, TREE_MS);

  let lastStructures = '';
  let lastStructuresAt = 0;
  // THE FIELDS VERDICT is read in the same pass, off the same world: each crop field's census (farmland_site.censusAt,
  // the classifier a body's farm visit acts on) each anchor's stand by the farm visit's own rule
  // (stand_reach; null where none keeps off the field's cells), and `stranded` when none has one. A body that cannot see
  // the field takes its stands from here (farm_executor.tendPlot). Posted just before the structures verdict with the same stamp, so a body holding a heard
  // change against a structures read (blueprint_survey.keptReading) holds the census against it too.
  async function readStructures() {
    const read = {}, fields = {};
    for (const [roomKey, st] of structures) {
      if (!st.columns.every(k => held.has(k))) {
        read[roomKey] = { blueprint: st.blueprint, held: false };
        if (st.field) fields[roomKey] = { blueprint: st.blueprint, held: false };
        continue;
      }
      const r = await scanBuilding(standIn, st.pasted);
      read[roomKey] = { blueprint: st.blueprint, held: true, all_complete: r === null, steps: r ? r.steps : [], stats: r ? r.stats : null, summary: r ? r.summary : null };
      if (st.field) {
        fields[roomKey] = { blueprint: st.blueprint, held: true, census: censusAt(standIn, st.field.cells),
          stands: st.field.anchors.map(a => resolveStandableAnchor(standIn, a, { fallback: st.field.fallback, footprint: st.field.footprint })) };
        fields[roomKey].stranded = fields[roomKey].stands.every(s => s === null);
      }
    }
    return { read, fields };
  }
  async function postStructures() {
    const renew = Date.now() - lastStructuresAt >= RENEW_MS;
    if (structuresBusy || (!structuresDirty && !renew)) return;
    structuresBusy = true;
    structuresDirty = false;
    // Stamped with the moment its read began: a block change heard after that may not be in it.
    const startedAt = new Date().toISOString();
    const { read, fields } = await readStructures();
    structuresBusy = false;
    const shape = JSON.stringify({ read, fields });
    if (shape !== lastStructures) {
      say(`structures: ${Object.entries(read).map(([k, r]) => `${k} ${!r.held ? 'not held' : r.all_complete ? 'built' : `${r.steps.length} step(s)`}`).join('; ') || 'none sited'}`);
      say(`fields: ${Object.entries(fields).map(([k, f]) => `${k} ${!f.held ? 'not held' : `${f.census.growing} growing, ${f.census.mature} mature, ${f.census.untilled} untilled, ${f.census.emptyTilled} unsown, ${f.census.blocked} blocked${f.stranded ? ', STRANDED' : ''}`}`).join('; ') || 'none sited'}`);
    }
    lastStructures = shape;
    lastStructuresAt = Date.now();
    parentPort.postMessage({ type: 'verdict', subject: 'fields', verdict: { schema: 'auren.integrity_keeper.fields.v1', generated_at: startedAt, fields } });
    parentPort.postMessage({ type: 'verdict', subject: 'structures', verdict: { schema: 'auren.integrity_keeper.structures.v1', generated_at: startedAt, structures: read } });
  }
  // A read that throws is a coding fault: thrown on the thread, which ends the run (integrity_keeper.js), so a
  // read left busy by a throw is never waited on.
  timeoutCrash.every(TAG, 'post the structures verdict when it changed, and renew it every RENEW_MS when it did not', () => {
    postStructures().catch((e) => { setImmediate(() => { throw e; }); });
  }, POST_MS);

  parentPort.on('message', (m) => {
    if (m.type === 'plans') { onPlans(m); return; }
    if (m.type === 'column') {
      world.setColumn(m.cx, m.cz, Chunk.fromJson(m.json), false);
      held.add(colKey(m.cx, m.cz));
      treeFarm.onColumn(m.cx, m.cz);
      dirty = true;
      structuresDirty = true;
      mansionDirty = true;
      return;
    }
    if (m.type === 'unload') {
      held.delete(colKey(m.cx, m.cz));
      world.unloadColumn(m.cx, m.cz);
      treeFarm.onColumn(m.cx, m.cz);
      dirty = true;
      structuresDirty = true;
      mansionDirty = true;
      return;
    }
    if (m.type === 'blocks') {
      for (const b of m.list) {
        const col = world.getColumn(b.x >> 4, b.z >> 4);
        if (col) col.setBlockStateId(new Vec3(b.x & 15, b.y, b.z & 15), b.s);
        treeFarm.touch(b.x, b.z);
      }
      dirty = true;
      structuresDirty = true;
      mansionDirty = true;
      return;
    }
    throw new Error(`[${TAG}] CODING VIOLATION: the keeper's thread was sent '${m.type}', which it does not know.`);
  });

  say('keeper thread up');
}

if (!isMainThread) runKeeperThread();
