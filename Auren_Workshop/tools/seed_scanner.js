'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/seed_scanner.js');
// tool: seed_scanner — rolls world seeds until the ground inside the loaded area (the ~160-block radius
// the server streams around a body) matches the criteria below, and logs every seed tried to a
// permanent record.
//
// Reuses (Law 16, Law 22 gate 2): world_forge.ACCEPTABLE_BIOMES, the landing-biome list · @perception/
// biome_scanner, the fleet's own biome reader, so a world is vetted with the same eyes the bots use ·
// @utils/voxel_reader, block reads for the relief columns · @utils/site_geometry's isGround/isWater/
// isCanopy, the terrain vocabulary · bench_world, which brings a candidate world up and down with no
// crew · rcon_link, the seed read-back.
//
// world_forge.HARD_DENY and the snapshot check in guardCandidate gate which world folders this file may
// delete — a seed only takes effect on a freshly created folder, so hunting means deleting one.
//
// Logs one JSONL line per seed tried to `Long_term_memory/seed_scans.jsonl`, appended and never
// rewritten; read back with the `log` verb, the record's only reader.
//
// ── USAGE ───────────────────────────────────────────────────────────────────────────────────────────
//   node Auren_Workshop/tools/seed_scanner.js measure                     measure the RUNNING world. Reads
//                                                                    only — creates and deletes nothing.
//   node Auren_Workshop/tools/seed_scanner.js scan [--tries=12]            the hunt: roll seeds until one meets
//                                                                    every criterion, or the tries run out
//   node Auren_Workshop/tools/seed_scanner.js scan --seeds=123,456,789     try exactly these, in order
//   node Auren_Workshop/tools/seed_scanner.js keep [--world=seed_scan]     snapshot the world it found
//   node Auren_Workshop/tools/seed_scanner.js log [--met] [--last=N]       the permanent record, read back
//
// Exit codes: 0 a world MET every criterion (or the verb simply completed) · 2 every seed tried MISSED —
// not an error, an honest "none of these is the one" · 1 the run could not be completed.

const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();

// Puts mineflayer's module homes on NODE_PATH before the first live-client require — the one answer to
// where those modules live (Law 16).
paths.bootstrapModules();

const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const mineflayer = require('mineflayer');

const biomeScanner = require('@perception/biome_scanner');
const siteGeometry = require('@utils/site_geometry');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');
const { SERVER_ENDPOINT, SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');
const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));
const worldForge = require('./world_forge');
const benchWorld = require('../bench_world');

const TAG = 'seed_scanner';
const BOT_DIR = paths.BOT_ROOT;
const REPO_ROOT = paths.REPO_ROOT;
const SERVER_DIR = require(paths.bot('js_kernel/utils/workstation')).needServerDir();
const SNAPSHOT_DIR = path.join(SERVER_DIR, 'world_snapshots');
const DEV_PROPS = path.join(SERVER_DIR, 'server.properties');
const FLEET = path.join(BOT_DIR, 'fleet_control.js');
const LEDGER = path.join(REPO_ROOT, 'Long_term_memory', 'seed_scans.jsonl');

// ── THE CRITERIA ────────────────────────────────────────────────────────────────────────────────────
// Each threshold names whose number it is; the verdict block prints that ownership beside every check
// (Law 25). Re-derive the tool's numbers by pointing `measure` at a world already called good.

// HIS, via world_forge — one list, imported, never restated.
const LANDING_BIOMES = new Set(worldForge.ACCEPTABLE_BIOMES.map(b => b.replace('minecraft:', '')));

// Biome-map families, from biome_scanner's patches; ground-water is measured separately below.
const OCEAN_RE = /ocean/;                       // every ocean variant, deep/frozen/lukewarm included
const RIVER = new Set(['river', 'frozen_river']);

// THE TOOL'S NUMBERS — thresholds for criteria given in words, not numbers, calibrated against a world
// already called good (re-derive with `measure`).
const DEFAULT_MIN_WATER = 2;    // % of sampled ground columns standing under water, lower bound
const DEFAULT_MAX_WATER = 22;   // % of sampled ground columns standing under water, upper bound
const DEFAULT_MAX_OCEAN = 8;    // % of biome cells that are an ocean
const DEFAULT_MAX_RELIEF = 40;  // blocks between the 5th and 95th percentile ground height
// The loaded radius, not a tool threshold — the frame the fleet builds within.
const DEFAULT_MAX_RIVER_DIST = 160;

// Relief grid: 16-block spacing across the loaded radius, 441 columns — a percentile statistic over a
// 320-block square.
const RELIEF_RADIUS = 160;
const RELIEF_STEP = 16;
const RELIEF_UP = 120;   // ceiling of the column walk, above the bot — a peak inside the loaded area
const RELIEF_DOWN = 70;  // floor of the walk, below the bot — a ravine or a shore

// Chunk settle: biome_scanner reads mineflayer's own chunk cache; the scan is polled until its point
// count stops growing before being judged (Law 23).
const SETTLE_POLL_MS = 2500;
const SETTLE_TIMEOUT_MS = 90000;
const FULL_GRID_POINTS = 81 * 81;          // biome_scanner: radius 160, step 4
// The server streams a square of 21x21 chunks centred on the body's chunk; a ±160 sweep from off-centre
// reaches past two edges of it, so a fully streamed world measures ~97%, not 100%.
const DEFAULT_MIN_COVERAGE = 0.90;         // below this the world is UNJUDGED, not failed

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith('--'));
const flags = new Map(argv.filter(a => a.startsWith('--')).map(a => {
  const i = a.indexOf('=');
  return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const has = k => flags.has(k);
const opt = (k, d) => (flags.has(k) && flags.get(k) !== true ? String(flags.get(k)) : d);
const num = (k, d) => { const v = parseFloat(opt(k, String(d))); return Number.isFinite(v) ? v : d; };

// ── WHICH SERVER IS BEING MEASURED ──────────────────────────────────────────────────────────────────
// `--props` moves the world's name and rcon credentials together with `SERVER_ENDPOINT`, so the
// properties file and the endpoint always describe the same server — a mismatch would report a true
// measurement under a false world name and seed, a well-formed falsehood (Law 25). A path argument, not
// a known location: this file must not learn the layout of any deployment.
const PROPS = path.resolve(opt('props', DEV_PROPS));

// The identity the scout joins under, authorable since a door admitting only a fixed set of names has no
// way to let an unknown one in.
const SCOUT_NAME = opt('as', 'Seed_Scout');

const t0 = Date.now();
const el = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const line = n => '─'.repeat(n);
function banner(s) { console.log(`\n${line(94)}\n${el()} ${s}\n${line(94)}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, b) => (b > 0 ? (100 * a / b) : 0);

// ── server.properties ───────────────────────────────────────────────────────────────────────────────
// Written only while the server is stopped: `level-seed` is read once at JVM start, so writing it into a
// live server is a silent no-op that looks like a control.
function setProperty(key, value) {
  const text = fs.readFileSync(PROPS, 'utf8');
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
  const l = `${key}=${value}`;
  fs.writeFileSync(PROPS, re.test(text) ? text.replace(re, l) : `${text.replace(/\n?$/, '\n')}${l}\n`);
}
function getProperty(key) {
  const m = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.*)$`, 'm')
    .exec(fs.readFileSync(PROPS, 'utf8'));
  return m ? m[1].trim() : null;
}

function fleet(args) {
  return spawnSync(process.execPath, [FLEET, ...args], { cwd: REPO_ROOT, stdio: 'inherit' });
}

// A 64-bit signed seed, Minecraft's generator input; cryptographically random so two hunts run a minute
// apart never walk the same sequence.
function randomSeed() {
  return crypto.randomBytes(8).readBigInt64BE().toString();
}

// ── THE MEASUREMENT ─────────────────────────────────────────────────────────────────────────────────

// biomeCensus — the biome map as counts, from biome_scanner's patch list. Patch `size` is sampled cells;
// their sum is `pointsScanned`, so fractions are of ground actually streamed.
function biomeCensus(scan) {
  const cells = new Map();
  for (const p of scan.patches) cells.set(p.biome, (cells.get(p.biome) || 0) + p.size);
  const total = scan.summary.pointsScanned;
  let ocean = 0, river = 0;
  for (const [biome, n] of cells) {
    if (OCEAN_RE.test(biome)) ocean += n;
    if (RIVER.has(biome)) river += n;
  }
  // The patch at distance 0 is the bot's own landing cell — exactly one, since dx=0,dz=0 is on the
  // sample grid.
  const home = scan.patches.find(p => p.dist === 0);
  const nearestRiver = scan.patches.filter(p => RIVER.has(p.biome)).sort((a, b) => a.dist - b.dist)[0] || null;
  const ranked = [...cells.entries()].sort((a, b) => b[1] - a[1]);
  return {
    total,
    landing: home ? home.biome : null,
    oceanCells: ocean,
    riverCells: river,
    nearestRiverDist: nearestRiver ? nearestRiver.dist : null,
    riverPatches: scan.patches.filter(p => RIVER.has(p.biome)).length,
    composition: ranked.map(([biome, n]) => ({ biome, cells: n, pct: +pct(n, total).toFixed(1) })),
  };
}

// groundColumn — the top of the terrain at (x,z): the highest ground block that is not canopy, using
// site_geometry's isGround/isCanopy/isWater vocabulary. Returns { y, name, submerged } or null when no
// terrain sits inside the window.
function groundColumn(reader, x, z, refY) {
  for (let y = refY + RELIEF_UP; y >= refY - RELIEF_DOWN; y--) {
    const b = reader.blockAt(x, y, z);
    if (b === null) continue;                       // unloaded cell — keep walking, do not call it sky
    if (!siteGeometry.isGround(b)) continue;
    if (siteGeometry.isCanopy(b.name)) continue;    // a tree is not the shape of the land
    const above = reader.blockAt(x, y + 1, z);
    return { y, name: b.name, submerged: !!(above && siteGeometry.isWater(above.name)) };
  }
  return null;
}

// reliefSurvey — the shape of the land and how much of the ground is under water: distinct from
// biomeCensus's ocean/river fractions of the map — a forest pond counts here and not there.
function reliefSurvey(bot) {
  const reader = makeVoxelReader(bot, { needs: ['type'] });
  const origin = bot.entity.position.floored();
  const heights = [];
  let submerged = 0, unresolved = 0, columns = 0;
  const started = Date.now();
  for (let dx = -RELIEF_RADIUS; dx <= RELIEF_RADIUS; dx += RELIEF_STEP) {
    for (let dz = -RELIEF_RADIUS; dz <= RELIEF_RADIUS; dz += RELIEF_STEP) {
      columns++;
      const g = groundColumn(reader, origin.x + dx, origin.z + dz, origin.y);
      if (!g) { unresolved++; continue; }
      heights.push(g.y);
      if (g.submerged) submerged++;
    }
  }
  heights.sort((a, b) => a - b);
  const at = q => (heights.length ? heights[Math.min(heights.length - 1, Math.floor(q * heights.length))] : null);
  const resolved = heights.length;
  return {
    columns, resolved, unresolved, submerged,
    waterPct: +pct(submerged, resolved).toFixed(1),
    min: heights[0] ?? null,
    max: heights[heights.length - 1] ?? null,
    p5: at(0.05), p50: at(0.50), p95: at(0.95),
    spread: (resolved ? at(0.95) - at(0.05) : null),        // the flatness number the criterion reads
    fullRange: (resolved ? heights[heights.length - 1] - heights[0] : null),
    reads: reader.stats.reads,
    ms: Date.now() - started,
  };
}

// settle — polls until the chunk stream's point count stops growing, then returns the final scan.
async function settle(bot) {
  let last = -1, stable = 0, scan = null;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    scan = biomeScanner.scanBiomes(bot);
    const n = scan.summary.pointsScanned;
    if (n === last) { stable++; if (stable >= 2) break; } else { stable = 0; }
    last = n;
  }
  return scan;
}

// measureWorld — everything above, on one client, against one world. Returns a plain object; the judging
// is a separate function, so the numbers are printable even when the verdict is MISSED.
async function measureWorld() {
  const created = guardExternalSync(TAG, 'mineflayer.createBot for the seed scout', () =>
    mineflayer.createBot({
      host: SERVER_ENDPOINT.host, port: SERVER_ENDPOINT.port,
      username: SCOUT_NAME, version: SERVER_MINECRAFT_VERSION, auth: 'offline',
    }));
  if (!created.ok) return { ok: false, why: `could not create the scout client: ${created.reason}` };
  const bot = created.value;

  const arrival = await guardExternal(TAG, 'the seed scout joining the world', () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no spawn within 120s')), 120000);
    bot.once('spawn', () => { clearTimeout(timer); resolve(true); });
    bot.once('kicked', r => { clearTimeout(timer); reject(new Error(`kicked: ${JSON.stringify(r)}`)); });
    bot.once('error', e => { clearTimeout(timer); reject(e); });
  }));
  if (!arrival.ok) { bot.quit(); return { ok: false, why: `the scout never reached the world: ${arrival.reason}` }; }

  const pos = bot.entity.position.floored();
  console.log(`${el()} ${SCOUT_NAME} landed at (${pos.x}, ${pos.y}, ${pos.z}) — waiting for the chunk stream to settle…`);

  const scan = await settle(bot);
  const coverage = scan ? scan.summary.pointsScanned / FULL_GRID_POINTS : 0;
  // The coverage gate: below it, ground still arriving would be judged as final (Law 23). A server that
  // streams fewer chunks than the full grid measures the whole of a smaller circle, still inside the
  // area the bots build in — every verdict prints the coverage it was reached at.
  const minCoverage = num('min-coverage', DEFAULT_MIN_COVERAGE);
  if (coverage < minCoverage) {
    bot.quit();
    return { ok: false, why: `only ${(coverage * 100).toFixed(0)}% of the loaded area ever streamed in ` +
      `(${scan ? scan.summary.pointsScanned : 0}/${FULL_GRID_POINTS} biome cells), against a gate of ` +
      `${(minCoverage * 100).toFixed(0)}%. Nothing was measured, so this world is UNJUDGED rather than ` +
      `failed.\n  If this server streams fewer chunks than the fleet's own (view-distance below 10), that ` +
      `ceiling is the server's and not a stalled scan — lower the gate with --min-coverage= to judge the ` +
      `smaller circle it does load.` };
  }

  const census = biomeCensus(scan);
  const relief = reliefSurvey(bot);
  bot.quit();

  return {
    ok: true,
    spawn: { x: pos.x, y: pos.y, z: pos.z },
    distanceFromCentre: Math.round(Math.hypot(pos.x, pos.z)),
    coverage: +(coverage * 100).toFixed(1),
    census, relief,
    biomeCount: scan.summary.detectedBiomes.length,
    patchCount: scan.summary.patchCount,
  };
}

// ── THE VERDICT ─────────────────────────────────────────────────────────────────────────────────────
// Judging is separate from measuring on purpose: the same numbers can be re-judged against different
// thresholds without touching a world, and a MISSED verdict still prints every number it judged.
function judge(m) {
  const minWater = num('min-water', DEFAULT_MIN_WATER);
  const maxWater = num('max-water', DEFAULT_MAX_WATER);
  const maxOcean = num('max-ocean', DEFAULT_MAX_OCEAN);
  const maxRelief = num('max-relief', DEFAULT_MAX_RELIEF);
  const maxRiver = num('max-river-dist', DEFAULT_MAX_RIVER_DIST);

  const oceanPct = +pct(m.census.oceanCells, m.census.total).toFixed(1);
  const riverDist = m.census.nearestRiverDist;
  const mine = (k, d, what) => (has(k) ? 'HIS — given on the command line' : `THE TOOL'S (${d}) — ${what}`);

  const checks = [
    {
      key: 'landing_biome',
      name: `the landing biome is a forest/plains type (it is ${m.census.landing || 'unreadable'})`,
      pass: !!m.census.landing && LANDING_BIOMES.has(m.census.landing),
      owner: 'HIS — "landing biome is forest or plains", the list world_forge already carries',
    },
    {
      key: 'river_present',
      name: `a river runs within ${maxRiver}b — the loaded area (nearest ${riverDist === null ? 'none in the loaded area' : `${riverDist}b`})`,
      pass: riverDist !== null && riverDist <= maxRiver,
      owner: has('max-river-dist') ? 'HIS — given on the command line'
        : `HIS — "theres rivers", inside the loaded area (${DEFAULT_MAX_RIVER_DIST}b) he builds in`,
    },
    {
      key: 'water_content',
      name: `${minWater}–${maxWater}% of the ground is under water (it is ${m.relief.waterPct}%)`,
      pass: m.relief.waterPct >= minWater && m.relief.waterPct <= maxWater,
      owner: (has('min-water') || has('max-water')) ? 'HIS — given on the command line'
        : `THE TOOL'S (${DEFAULT_MIN_WATER}–${DEFAULT_MAX_WATER}%) — "medium amount of water content" as a band`,
    },
    {
      key: 'no_ocean',
      name: `at most ${maxOcean}% of the loaded area is ocean (it is ${oceanPct}%)`,
      pass: oceanPct <= maxOcean,
      owner: mine('max-ocean', DEFAULT_MAX_OCEAN, '"no oceans spanning a large portion of the loaded chunk"'),
    },
    {
      key: 'flat_ground',
      name: `ground height spread is at most ${maxRelief}b (it is ${m.relief.spread}b, full range ${m.relief.fullRange}b)`,
      pass: m.relief.spread !== null && m.relief.spread <= maxRelief,
      owner: mine('max-relief', DEFAULT_MAX_RELIEF, '"relatively flat, no giant mountains" — 5th to 95th percentile'),
    },
  ];
  return { checks, met: checks.every(c => c.pass), oceanPct, thresholds: { minWater, maxWater, maxOcean, maxRelief, maxRiver } };
}

function report(world, seed, m, v) {
  banner(`WHAT IS INSIDE THE LOADED AREA — world '${world}'${seed ? `, seed ${seed}` : ''}`);
  console.log(`  landed at            : (${m.spawn.x}, ${m.spawn.y}, ${m.spawn.z})  ${m.distanceFromCentre}b from world centre`);
  console.log(`  chunk coverage       : ${m.coverage}% of the loaded area streamed in`);
  console.log(`  landing biome        : ${m.census.landing || '(unreadable)'}`);
  console.log(`  biomes in reach      : ${m.biomeCount} across ${m.patchCount} patches`);
  console.log(`  ground under water   : ${m.relief.waterPct}%  (${m.relief.submerged} of ${m.relief.resolved} columns)`);
  console.log(`  ocean                : ${v.oceanPct}%   river cells ${+pct(m.census.riverCells, m.census.total).toFixed(1)}% in ${m.census.riverPatches} bodies`);
  console.log(`  nearest river        : ${m.census.nearestRiverDist === null ? 'none in the loaded area' : `${m.census.nearestRiverDist}b`}`);
  console.log(`  ground height        : y${m.relief.min}–${m.relief.max}  median y${m.relief.p50}  p5–p95 spread ${m.relief.spread}b`);
  console.log(`  relief survey        : ${m.relief.resolved}/${m.relief.columns} columns resolved, ${m.relief.reads} block reads in ${m.relief.ms}ms`);
  console.log(`\n  biome composition (top 8 by area):`);
  for (const c of m.census.composition.slice(0, 8)) {
    console.log(`      ${String(c.pct).padStart(5)}%  ${c.biome}`);
  }

  banner(`VERDICT — world '${world}'`);
  for (const c of v.checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    console.log(`       criterion owner: ${c.owner}`);
  }
  console.log(`\n  ${v.met ? '✅ THIS WORLD IS THE ONE — it meets every criterion.' : '❌ MISSED — not this seed.'}`);
}

// ── THE PERMANENT RECORD ────────────────────────────────────────────────────────────────────────────
// Appended, never rewritten. A torn write costs one seed's line and nothing earlier (Long_term_memory's
// rule, and the reason these files are JSONL).
function ledgerAppend(row) {
  if (has('no-log')) { console.log(`${el()} --no-log: this seed was NOT written to the permanent record.`); return; }
  const dir = path.dirname(LEDGER);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
  console.log(`${el()} recorded in Long_term_memory/seed_scans.jsonl`);
}

// rowFor — a seed's measurements, not just its verdict: thresholds are retuned, and every number here
// can be re-judged later regardless.
function rowFor(world, seed, seedReadBack, m, v) {
  return {
    at: new Date().toISOString(),
    world, seed, seed_confirmed: seedReadBack,
    verdict: v.met ? 'MET' : 'MISSED',
    failed: v.checks.filter(c => !c.pass).map(c => c.key),
    landing_biome: m.census.landing,
    spawn: m.spawn,
    from_centre_b: m.distanceFromCentre,
    ground_water_pct: m.relief.waterPct,
    ocean_pct: v.oceanPct,
    river_cells_pct: +pct(m.census.riverCells, m.census.total).toFixed(1),
    river_bodies: m.census.riverPatches,
    nearest_river_b: m.census.nearestRiverDist,
    height_min: m.relief.min, height_max: m.relief.max, height_median: m.relief.p50,
    relief_spread_b: m.relief.spread, relief_range_b: m.relief.fullRange,
    biomes: m.biomeCount,
    top_biomes: m.census.composition.slice(0, 5),
    coverage_pct: m.coverage,
    thresholds: v.thresholds,
  };
}

// ── VERBS ───────────────────────────────────────────────────────────────────────────────────────────

// measure — the RUNNING world, read-only; also how the tool's thresholds are re-derived, by pointing it
// at a world already called good.
async function measure() {
  const world = getProperty('level-name');
  banner(`MEASURE the running world '${world}' — nothing is created, nothing is deleted`);
  const m = await measureWorld();
  if (!m.ok) { console.error(`\nseed_scanner: ${m.why}`); return 1; }
  const v = judge(m);
  // The SERVER's own seed, not server.properties' — a standing world's folder was generated from
  // whatever level-seed held at creation, and the property is rewritten on every hunt attempt since.
  const seed = await seedReadBack();
  report(world, seed, m, v);
  if (has('log')) ledgerAppend(rowFor(world, null, seed, m, v));
  else console.log(`\n  (not written to the permanent record — a measurement of a standing world is not a ` +
    `seed trial. Pass --log to record it anyway, which is how the reference world gets a row.)`);
  return v.met ? 0 : 2;
}

// seedReadBack — the server's own answer to what seed a world is; server.properties can name a different
// seed than the one the world actually generated from (Law 23).
async function seedReadBack() {
  const r = await guardExternal(TAG, 'rcon `seed`', () => rconLink.once(['seed'], { file: PROPS }));
  if (!r.ok) return null;
  const m = /\[(-?\d+)\]/.exec(r.value[0] ? r.value[0].body : '');
  return m ? m[1] : null;
}

// guardCandidate — may this world folder be destroyed, per world_forge's rule: a snapshot is the proof
// somebody meant to keep it.
function guardCandidate(world) {
  if (worldForge.HARD_DENY.has(world)) {
    return `'${world}' is on the protected list — it is not a seed candidate.`;
  }
  if (fs.existsSync(path.join(SNAPSHOT_DIR, world))) {
    return `'${world}' has a snapshot at ${path.join(SNAPSHOT_DIR, world)} — having one is the proof it is ` +
      `somebody's kept world, not a candidate. Pick another --world name.`;
  }
  return null;
}

// scan — the hunt: per attempt, stop the JVM, delete the folder, write the seed, start the JVM, join,
// measure, judge, record. A MET world is left standing; a MISSED one rolls to the next seed.
// `level-seed` stays a landmine while any world folder exists — deleting one and restarting regenerates
// from the last candidate seed. withCleanup restores it on every exit path, including a throw.
async function scan() {
  const before = getProperty('level-seed') || '';
  return withCleanup(TAG, 'restoring level-seed after the hunt', () => runHunt(), () => {
    if ((getProperty('level-seed') || '') !== before) {
      setProperty('level-seed', before);
      console.log(`\n${el()} level-seed put back to ${before === '' ? '(random)' : before} — a candidate ` +
        `seed left in server.properties would silently regenerate the next world that gets deleted.`);
    }
  });
}

async function runHunt() {
  // The hunt is bound to the server it can drive: every destructive step — the folder it deletes, the
  // JVM it starts — goes through the fleet's own server directory and launcher, so `--props` cannot move
  // it. Measuring only reads and is portable; hunting is not, so --props is refused here.
  if (has('props')) {
    console.error(`\nseed_scanner: REFUSING — --props aims the MEASUREMENT at another server's world, and ` +
      `the hunt cannot follow it: it deletes world folders under ${SERVER_DIR} and starts the JVM through ` +
      `fleet_control, neither of which that file describes.\n` +
      `  Hunt here, then carry the seed across: run 'scan' with no --props, take the seed it reports, and ` +
      `write it into the other server's own level-seed before regenerating that world.`);
    return 1;
  }
  const world = opt('world', 'seed_scan');
  const refusal = guardCandidate(world);
  if (refusal) { console.error(`\nseed_scanner: REFUSING — ${refusal}`); return 1; }

  const seedList = has('seeds') ? opt('seeds', '').split(',').map(s => s.trim()).filter(Boolean) : null;
  const tries = seedList ? seedList.length : Math.max(1, Math.round(num('tries', 12)));
  const worldDir = path.join(SERVER_DIR, world);
  const startedProps = { level: getProperty('level-name'), seed: getProperty('level-seed') };

  banner(`SEED HUNT — up to ${tries} seed${tries === 1 ? '' : 's'} on candidate world '${world}'`);
  console.log(`  the server is currently pointed at '${startedProps.level}' — it will be repointed at ` +
    `'${world}' for the hunt and LEFT there, so put it back when you are done.`);

  // bench_world brings each candidate world up with no crew and shuts it down between seeds; this file
  // only writes level-name/level-seed while the server is stopped and asks for the next one.
  let foreman = null;
  const tried = [];
  for (let i = 1; i <= tries; i++) {
    const seed = seedList ? seedList[i - 1] : (i === 1 && has('seed') ? opt('seed', '') : randomSeed());
    banner(`SEED ${i}/${tries}: ${seed}`);

    // Everything up to the JVM start happens while the server is DOWN — level-name and level-seed are
    // read once, at start, so writing them into a running server is a no-op.
    console.log(`${el()} taking the server down — level-name and level-seed are read at JVM start.`);
    if (foreman) { console.log(`${el()} ${(await benchWorld.down(foreman)).why}`); foreman = null; }
    if (fs.existsSync(worldDir)) {
      console.log(`${el()} deleting the previous candidate world at ${worldDir}.`);
      const rm = guardExternalSync(TAG, `removing the candidate world folder ${world}`, () =>
        fs.rmSync(worldDir, { recursive: true, force: true }));
      if (!rm.ok) {
        console.error(`\nseed_scanner: could not delete '${world}' (${rm.reason}). The server may still be ` +
          `holding files open. Nothing further was attempted.`);
        return 1;
      }
    }
    setProperty('level-seed', seed);
    setProperty('level-name', world);

    console.log(`${el()} generating the world and starting the server on seed ${seed}…`);
    const up = await benchWorld.up({ start: 'continue' });
    foreman = up.foreman;
    if (!up.ok) {
      console.error(`\nseed_scanner: the world would not come up on seed ${seed} — ${up.why}. The hunt stops here — a ` +
        `world that cannot be served cannot be measured, and rolling past it would hide the reason.`);
      await benchWorld.down(foreman);
      return 1;
    }

    const confirmed = await seedReadBack();
    if (confirmed && confirmed !== seed) {
      console.log(`${el()} ⚠ the server reports seed ${confirmed}, not the ${seed} that was written. The ` +
        `RECORD keeps both; the server's answer is the true one.`);
    }

    const m = await measureWorld();
    if (!m.ok) {
      console.error(`\n${el()} seed ${seed} is UNJUDGED — ${m.why}`);
      tried.push({ seed, verdict: 'UNJUDGED' });
      continue;
    }
    const v = judge(m);
    report(world, seed, m, v);
    ledgerAppend(rowFor(world, seed, confirmed, m, v));
    tried.push({ seed, verdict: v.met ? 'MET' : 'MISSED', failed: v.checks.filter(c => !c.pass).map(c => c.key) });

    if (v.met) {
      banner(`FOUND IT on attempt ${i} of ${tries} — seed ${confirmed || seed}`);
      console.log(`  The server is UP on '${world}' and the ground is the ground you asked for.`);
      console.log(`\n  Keep it (so a rollback can always come back to it):`);
      console.log(`      node Auren_Workshop/tools/seed_scanner.js keep --world=${world}`);
      console.log(`  The foreman that started it is still running, in its window 'auren desk'.`);
      console.log(`  Or put the server back on the world it was on before the hunt: stop it with`);
      console.log(`      node Auren_Workshop/fleet_control.js verb shutdown`);
      console.log(`  then set level-name=${startedProps.level} in the server's server.properties.`);
      return 0;
    }
    console.log(`\n${el()} seed ${seed} MISSED (${tried[tried.length - 1].failed.join(', ')}) — rolling to the next one.`);
  }

  banner(`NO SEED MET THE CRITERIA in ${tries} attempt${tries === 1 ? '' : 's'}`);
  for (const t of tried) console.log(`  ${t.verdict.padEnd(8)} ${t.seed}${t.failed ? `   failed: ${t.failed.join(', ')}` : ''}`);
  console.log(`\n  Every attempt is in the permanent record — read it with:`);
  console.log(`      node Auren_Workshop/tools/seed_scanner.js log`);
  console.log(`  That is not a failure of the hunt. Run it again for more seeds, or loosen one threshold`);
  console.log(`  (--max-relief=, --max-ocean=, --max-water=) once the record shows which one is doing the`);
  console.log(`  rejecting.`);
  console.log(`\n  The server is UP on the last candidate '${world}', run by the foreman in its window 'auren desk'.`);
  console.log(`  Put it back: stop it with  node Auren_Workshop/fleet_control.js verb shutdown`);
  console.log(`  then set level-name=${startedProps.level} in the server's server.properties.`);
  return 2;
}

// keep — snapshots the found world so a rollback can return to it, via fleet_control's snapshot
// (rollback.ps1, the one implementation), which refuses while the server is up.
async function keep() {
  const world = opt('world', 'seed_scan');
  const name = opt('snapshot', `${world}_fresh_start`);
  banner(`KEEP '${world}' as snapshot '${name}'`);
  console.log(`${el()} the server must be down for a clean copy — asking the foreman that runs it to shut down.`);
  const stopped = await benchWorld.stopRunning();
  if (!stopped.ok) { console.error(`\nseed_scanner: ${stopped.why}, so no clean copy can be taken.`); return 1; }
  const r = fleet(['snapshot', `--world=${world}`, `--name=${name}`]);
  if (r.status !== 0) { console.error(`\nseed_scanner: the snapshot did not complete.`); return 1; }
  console.log(`\n  '${world}' is now restorable, and this tool will now REFUSE to overwrite it — having a`);
  console.log(`  snapshot is what makes a world somebody's rather than a candidate.`);
  console.log(`\n  To run the fleet on it: set level-name=${world} in server.properties; a rollback start then`);
  console.log(`  puts it back to this copy every run (foreman_config: start: 'rollback').`);
  return 0;
}

// log — the permanent record's lens: every question about a seed's measurements is answered from here,
// and nothing else opens the file.
function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
    const parsed = guardExternalSync(TAG, 'parsing a seed_scans.jsonl line', () => JSON.parse(l));
    return parsed.ok ? parsed.value : null;
  }).filter(Boolean);
}

function showLog() {
  const rows = readLedger();
  if (!rows.length) {
    console.log(`\nNo seeds have been scanned yet — Long_term_memory/seed_scans.jsonl is empty or absent.`);
    console.log(`Start a hunt with:  node Auren_Workshop/tools/seed_scanner.js scan --tries=8`);
    return 0;
  }
  const wanted = has('met') ? rows.filter(r => r.verdict === 'MET') : rows;
  const last = has('last') ? wanted.slice(-Math.max(1, Math.round(num('last', 20)))) : wanted;

  console.log(`\n${line(118)}`);
  console.log(`WHAT EVERY SEED TURNED OUT TO BE — ${rows.length} scanned, ${rows.filter(r => r.verdict === 'MET').length} met the criteria`);
  console.log(line(118));
  console.log(`${'when'.padEnd(11)} ${'verdict'.padEnd(7)} ${'seed'.padStart(21)} ${'landing biome'.padEnd(20)} ` +
    `${'wat%'.padStart(5)} ${'oce%'.padStart(5)} ${'river'.padStart(6)} ${'flat'.padStart(5)} ${'y-med'.padStart(6)}`);
  console.log(line(118));
  for (const r of last) {
    console.log(`${String(r.at).slice(0, 10).padEnd(11)} ${(r.verdict === 'MET' ? '✅ MET' : '❌ miss').padEnd(7)} ` +
      `${String(r.seed_confirmed || r.seed || '?').padStart(21)} ${String(r.landing_biome || '?').slice(0, 20).padEnd(20)} ` +
      `${String(r.ground_water_pct).padStart(5)} ${String(r.ocean_pct).padStart(5)} ` +
      `${String(r.nearest_river_b === null ? '—' : `${r.nearest_river_b}b`).padStart(6)} ` +
      `${String(r.relief_spread_b === null ? '—' : `${r.relief_spread_b}b`).padStart(5)} ${String(`y${r.height_median}`).padStart(6)}`);
  }
  console.log(line(118));

  // Which criterion is doing the rejecting — the one question the raw rows cannot be skimmed for.
  const misses = rows.filter(r => r.verdict === 'MISSED');
  if (misses.length) {
    const why = new Map();
    for (const r of misses) for (const f of (r.failed || [])) why.set(f, (why.get(f) || 0) + 1);
    console.log(`\nWHY SEEDS WERE REJECTED (${misses.length} rejections):`);
    for (const [k, n] of [...why.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)} × ${k}   (${pct(n, misses.length).toFixed(0)}% of rejections)`);
    }
  }
  const met = rows.filter(r => r.verdict === 'MET');
  if (met.length) {
    console.log(`\nSEEDS THAT MET EVERY CRITERION — these are the ones worth reusing:`);
    for (const r of met) {
      console.log(`  ${r.seed_confirmed || r.seed}  ${r.landing_biome}, ${r.ground_water_pct}% water, ` +
        `river ${r.nearest_river_b}b, spread ${r.relief_spread_b}b, spawn y${r.spawn ? r.spawn.y : '?'}`);
    }
  }
  console.log('');
  return 0;
}

function usage() {
  console.error(`
seed_scanner — roll world seeds until the ground inside the loaded area is the ground the bots need.

  node Auren_Workshop/tools/seed_scanner.js measure [--log] [--props=PATH] [--as=NAME]
      Measure the world the server is ALREADY running. Creates nothing, deletes nothing. This is how
      the thresholds below are re-derived: point it at a world that IS good and read the numbers.
      Another server's world is measured by aiming three things at it together — the body with
      AUREN_SERVER_HOST/AUREN_SERVER_PORT, the world name and rcon with --props, and the login name
      with --as where that door only admits names it already knows. The hunt refuses --props: it can
      only drive the server it can start.

  node Auren_Workshop/tools/seed_scanner.js scan [--tries=12] [--world=seed_scan] [--seed=N] [--seeds=a,b,c]
      The hunt. Per seed: stop the server, delete the candidate world, write the seed, start the server,
      join a scout, measure, judge, record. Stops at the first world that meets every criterion.

  node Auren_Workshop/tools/seed_scanner.js keep [--world=seed_scan] [--snapshot=NAME]
  node Auren_Workshop/tools/seed_scanner.js log [--met] [--last=N]

Thresholds — each defaults to a number THIS TOOL owns, and the verdict says so beside every line:
  --min-water=${DEFAULT_MIN_WATER} --max-water=${DEFAULT_MAX_WATER}     % of ground columns standing under water
  --max-ocean=${DEFAULT_MAX_OCEAN}                % of the loaded area that may be ocean
  --max-relief=${DEFAULT_MAX_RELIEF}              blocks between the 5th and 95th percentile ground height
  --max-river-dist=${DEFAULT_MAX_RIVER_DIST}        blocks to the nearest river body
  --no-log                    do not append to Long_term_memory/seed_scans.jsonl
  --props=PATH                the server.properties describing the world being MEASURED (name + rcon)
  --as=NAME                   the name the scout logs in under
  --min-coverage=${DEFAULT_MIN_COVERAGE}         fraction of the ${FULL_GRID_POINTS}-cell grid that must stream in before judging

Exit: 0 a world MET every criterion · 2 measured and MISSED (try more seeds) · 1 could not be completed.
`);
}

async function main() {
  const verb = positional[0];
  if (verb === 'measure') return measure();
  if (verb === 'scan') return scan();
  if (verb === 'keep') return keep();
  if (verb === 'log') return showLog();
  usage();
  return 1;
}

if (require.main === module) {
  main().then(code => process.exit(code), err => {
    console.error(`\nseed_scanner: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { biomeCensus, groundColumn, judge, rowFor, LANDING_BIOMES, LEDGER };
