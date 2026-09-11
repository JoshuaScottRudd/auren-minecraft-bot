'use strict';
// tool: seed_scanner — roll world seeds until the ground the bots land on is the ground he asked for,
// and keep a permanent note of what every seed turned out to be.
//
// ── WHY IT EXISTS, in his words (2026-09-05) ────────────────────────────────────────────────────────
// *"right now the minecraft world i have now is ideal. landing biome is forest or plains. theres rivers
// and medium amount of water content and the ground is reletivley flat, no giant mountains or oceans
// spanning a large portion of the loaded chunk. so i plan the bots to construct within the loaded chunk
// area normally so i need to be able to reset the seed until its ideal again."*
//
// The constraint underneath the sentence is the important half: the fleet BUILDS INSIDE THE LOADED AREA.
// A base is sited within the ~160-block radius the server streams around a body, so a world is not judged
// by what is somewhere out there — it is judged by what is inside that one circle around the landing
// point. Every measurement below is taken from the bot's own spawn cell outward, and nothing is measured
// that the bots could not reach.
//
// ── WHAT IT REUSES, AND WHY NOTHING HERE IS A SECOND COPY (Law 16, Law 22 gate 2) ───────────────────
//   world_forge.ACCEPTABLE_BIOMES  the "forest or plains type" list, already his sentence made executable.
//                                  Imported, never restated — one list, so an edit there moves both tools.
//   @perception/biome_scanner      the fleet's OWN eyes. The bots read the biome map with this node, so a
//                                  world vetted with anything else would be vetted with a second opinion
//                                  the fleet does not hold. It reports patches and decides nothing; the
//                                  deciding is this file's, which is exactly the split it was built for.
//   @utils/voxel_reader            the declared-needs block reader, for the relief columns.
//   @utils/site_geometry           isGround / isWater / isCanopy — the terrain vocabulary, not re-derived.
//   fleet_control server-start/stop the one route to the JVM. This file never launches java itself.
//   rcon_link                      the one Source-RCON implementation.
//
// WHAT IT DOES NOT REUSE, deliberately: `site_geometry.surfaceY` is the topmost GROUND in a column, and
// leaves and logs pass its `isGround` test (the canopy rule lives at its caller, by design). In a forest
// — which is the world he is asking for — that reads the relief of the TREETOPS. So the column walk below
// applies `!isCanopy` on top of the same exported predicates: composed from that vocabulary, not a rival
// copy of it, and the difference is the whole measurement.
//
// ── WHY THE SERVER AND NOT THE FLEET ────────────────────────────────────────────────────────────────
// `fleet_control up` would bring the overseer and a working bot online, which is minutes of bring-up and
// a memory wipe to think about, per seed. The question here is only "what is the ground", and one
// spectator-weight mineflayer client answers it. So each attempt costs a JVM start and a client join —
// and a rejected seed costs no fleet at all. Nothing this file starts has autonomy, and nothing it starts
// is left holding a player slot.
//
// ── WHICH WORLDS IT MAY DESTROY, AND HOW THAT IS ENFORCED ───────────────────────────────────────────
// A seed only takes effect when a world folder is CREATED, so hunting seeds means deleting folders. The
// guard is world_forge's and it is a property test rather than a name list: ANY world someone bothered to
// SNAPSHOT is someone's world, and a candidate by definition has no snapshot yet — so having one is the
// proof it is not a candidate. `sub_agent_01`, the world he has now, is protected by that rule today.
// The candidate world defaults to its own name (`seed_scan`) so the live world is never even addressed.
//
// ── THE PERMANENT RECORD ────────────────────────────────────────────────────────────────────────────
// *"it should log what was found per seed in the permanent log section so i know what kind of seed to
// pick from another time."* — one JSONL line per seed tried, appended to
// `Long_term_memory/seed_scans.jsonl`, never rewritten. It passes that folder's two-part admission rule:
// LOW FREQUENCY (a handful of lines per hunt, and a hunt happens when a world is being chosen — it is a
// decision, not a stream) and REVIEW VALUE (the question "what does a good seed look like" cannot be
// answered from the world you are standing in; it needs the ones you rejected). Read it back with the
// `log` verb — that is this record's lens, and no other reader should open the file.
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

// mineflayer and its prismarine stack are not installed beside this file, and which directory carries
// them differs per machine — so an entry point that requires a live client must put the module homes on
// NODE_PATH before its first such require. Every other client entry point in the tree does this through
// the same call; this one did not, which made it silently dependent on a package sitting in the bot's own
// node_modules without being declared there. An install that prunes undeclared packages removes it and
// the tool stops resolving mineflayer at all (Law 16 — one answer to where the modules live).
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

const TAG = 'seed_scanner';
const BOT_DIR = paths.BOT_ROOT;
// From `paths` rather than `path.resolve(BOT_DIR, '..')`, which computed the same answer to a question
// `workshop_paths` already answers — the second copy is exactly the defect that file was written to end,
// and it survived the 2026-09-10 move only because the arithmetic happened to still be right.
const REPO_ROOT = paths.REPO_ROOT;
const SERVER_DIR = require(paths.bot('js_kernel/utils/workstation')).needServerDir();
const SNAPSHOT_DIR = path.join(SERVER_DIR, 'world_snapshots');
const DEV_PROPS = path.join(SERVER_DIR, 'server.properties');
const FLEET = path.join(BOT_DIR, 'fleet_control.js');
const LEDGER = path.join(REPO_ROOT, 'Long_term_memory', 'seed_scans.jsonl');

// ── THE CRITERIA ────────────────────────────────────────────────────────────────────────────────────
// Every threshold below says WHOSE number it is, and the verdict block prints that ownership beside each
// line. He stated four things in words and no numbers; encoding a number and then reporting PASS against
// it as if it were measured fact is how a tool quietly takes a decision that was never delegated to it
// (Law 25). The tool's numbers were calibrated against the world he currently calls ideal — see the
// `measure` verb, which is how anyone re-derives them rather than trusting this comment.

// HIS, via world_forge — one list, imported, never restated.
const LANDING_BIOMES = new Set(worldForge.ACCEPTABLE_BIOMES.map(b => b.replace('minecraft:', '')));

// Biome families. Named here because these are questions about the biome MAP, and the map is what
// biome_scanner returns; the surface-water measure below answers a different question and is not this.
const OCEAN_RE = /ocean/;                       // every ocean variant, deep/frozen/lukewarm included
const RIVER = new Set(['river', 'frozen_river']);

// THE TOOL'S NUMBERS, AND WHERE THEY CAME FROM (measured 2026-09-05, not invented).
//
// `sub_agent_01` — the world he pointed at and called ideal — was measured with the `measure` verb
// before any of these were fixed, and it reads:
//     landing forest · 12.4% of ground under water · 0% ocean · nearest river 107b
//     ground y32–y94, median y64, p5–p95 spread 32b
// So the reference world is the calibration, and any threshold that rejects IT is the threshold being
// wrong rather than the world. The first draft of the relief number was 30 and it failed sub_agent_01 by
// two blocks — that is the whole reason this comment names a measurement instead of a preference.
const DEFAULT_MIN_WATER = 2;    // % of sampled ground columns standing under water — "theres rivers"
const DEFAULT_MAX_WATER = 22;   // "medium amount of water content"; the reference sits at 12.4%, mid-band
const DEFAULT_MAX_OCEAN = 8;    // % of biome cells that are an ocean — "no oceans spanning a large portion".
                                // The reference has none; this is the point where an ocean stops being a
                                // feature of the coastline and starts being a portion of the build area.
const DEFAULT_MAX_RELIEF = 40;  // blocks between the 5th and 95th percentile ground height — "relatively
                                // flat, no giant mountains". The reference measures 32b, so this carries
                                // 8b of headroom: one world is a calibration, not a distribution, and the
                                // permanent record's rejection table is what will tighten it honestly.
// NOT A THRESHOLD OF THE TOOL'S — it is the loaded radius, which is his own frame ("within the loaded
// chunk area"). "Theres rivers" means a river the bots can actually reach, and the edge of what they can
// reach is where the server stops streaming. The reference world's river sits at 107b, well inside it.
const DEFAULT_MAX_RIVER_DIST = 160;

// How the relief grid is sampled. 16-block spacing across the loaded radius gives 441 columns — enough
// for a percentile spread and cheap enough to run per seed. Denser sampling measures the same landscape
// more slowly; this is a statistic about a 320-block square, not a survey of it.
const RELIEF_RADIUS = 160;
const RELIEF_STEP = 16;
const RELIEF_UP = 120;   // ceiling of the column walk, above the bot — a peak inside the loaded area
const RELIEF_DOWN = 70;  // floor of the walk, below the bot — a ravine or a shore

// Chunk settle. The biome map is read out of mineflayer's own chunk cache, so it can only report ground
// the server has actually streamed — and on a world being generated for the first time that streaming is
// slow. A fixed sleep would sometimes measure a half-loaded world and call it a verdict (Law 23), so the
// wait is a GATE: poll the scan until its point count stops growing.
const SETTLE_POLL_MS = 2500;
const SETTLE_TIMEOUT_MS = 90000;
const FULL_GRID_POINTS = 81 * 81;          // biome_scanner: radius 160, step 4
// 100% is not reachable and that is geometry, not a fault: the server streams a SQUARE of 21×21 chunks
// centred on the body's chunk, and a ±160 sweep from the body's exact position reaches past two of its
// edges whenever the body is not standing dead centre of its chunk. A fully streamed world measures ~97%.
// (Those corners used to come back named `badlands` — biome id 0 — which is the defect this hunt found in
// biome_scanner and which is fixed there; they read as unloaded now, which is what makes this gate real.)
const DEFAULT_MIN_COVERAGE = 0.90;         // below this the world is UNJUDGED rather than failed

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
// The endpoint a scout dials is already answerable per-deployment through `SERVER_ENDPOINT`'s environment
// override, so the body can be aimed at any world on this machine without touching tracked code. Two
// facts about that world are NOT in the endpoint and are read out of a properties file: the world's NAME
// and the rcon credentials that answer `seed`. Left pointing at the fleet's own dev server while a body
// measures somebody else's world, the report would carry a true measurement under a false world name and
// a seed read off a server nobody asked about — a well-formed falsehood, which is the one thing an
// outcome signal may never be (Law 25). `--props` moves both facts together, so the properties file and
// the endpoint always describe the same server.
//
// It is a PATH ARGUMENT rather than a known location on purpose: this file must not learn the layout of
// any deployment, or the fleet starts depending on a layer that is supposed to depend on it.
const PROPS = path.resolve(opt('props', DEV_PROPS));

// The identity the scout joins under. Default when nothing else is asked for; a server whose door admits
// only a fixed set of names has no way to let an unknown one in, so the name has to be authorable by
// whoever is pointing the tool at that door.
const SCOUT_NAME = opt('as', 'Seed_Scout');

const t0 = Date.now();
const el = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const line = n => '─'.repeat(n);
function banner(s) { console.log(`\n${line(94)}\n${el()} ${s}\n${line(94)}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, b) => (b > 0 ? (100 * a / b) : 0);

// ── server.properties ───────────────────────────────────────────────────────────────────────────────
// Written while the server is STOPPED, always. `level-seed` is a world-GENERATION input read once at JVM
// start; writing it into a live server is a silent no-op that looks like a control.
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

// A 64-bit signed seed, which is exactly what Minecraft's generator takes. Cryptographic randomness is
// not for secrecy here — it is so two hunts run a minute apart never walk the same seeds.
function randomSeed() {
  return crypto.randomBytes(8).readBigInt64BE().toString();
}

// ── THE MEASUREMENT ─────────────────────────────────────────────────────────────────────────────────

// biomeCensus — the biome map as counts, from the patch list biome_scanner already built. Its patches
// carry `size` in sampled CELLS and the sum of them is `pointsScanned`, so these are exact fractions of
// the ground actually streamed rather than of the ground hoped for.
function biomeCensus(scan) {
  const cells = new Map();
  for (const p of scan.patches) cells.set(p.biome, (cells.get(p.biome) || 0) + p.size);
  const total = scan.summary.pointsScanned;
  let ocean = 0, river = 0;
  for (const [biome, n] of cells) {
    if (OCEAN_RE.test(biome)) ocean += n;
    if (RIVER.has(biome)) river += n;
  }
  // The patch at distance 0 is the bot's own cell — the ground it landed on, which is the "landing
  // biome" he named. There is exactly one, because dx=0,dz=0 is on the sample grid.
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

// groundColumn — the top of the TERRAIN at (x,z): the highest block that is ground and is not a tree.
//
// Not site_geometry.surfaceY, and the header says why: its isGround accepts leaves and logs, so in the
// forest he is asking for it would return the canopy. Everything else here is that file's vocabulary —
// isGround decides what terrain is, isCanopy decides what a tree is, isWater decides what is flooded.
// Returns { y, name, submerged } or null when no terrain sits inside the window.
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

// reliefSurvey — the shape of the land, and how much of it is under water.
//
// TWO MEASURES OF WATER EXIST IN THIS FILE AND THEY ANSWER DIFFERENT QUESTIONS. The biome census above
// says how much of the map is named river or ocean; this says how much of the GROUND is flooded. A pond
// in the middle of a forest is invisible to the first and counted by the second, and a body of water is
// what the base anchors on — so "water content" is judged here and "is it an ocean" is judged there.
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

// settle — wait until the chunk stream has stopped growing, then hand back the final scan. The point
// count is the honest signal: it is how many cells the client actually holds, and a world still
// streaming grows it every poll.
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
  // HOW MUCH GROUND HAS TO BE THERE BEFORE A VERDICT IS HONEST. The full grid is the count a server
  // streaming ten chunks produces, so the default gate is that server's number and no other's. A server
  // that streams fewer chunks never reaches it, and on such a server the sweep is not half-finished — it
  // has measured the whole of a smaller circle, which is still the loaded area the bots would build in.
  // Every verdict prints the coverage it was reached at, so a smaller circle is stated rather than hidden;
  // what the gate prevents is judging ground that is still arriving (Law 23).
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

// rowFor — what one seed is worth remembering as. Deliberately the MEASUREMENTS and not the verdict
// alone: the thresholds are the tool's and they will be retuned, and a row holding only PASS/FAIL would
// be unreadable the moment they change. Every number here can be re-judged years later.
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

// measure — the RUNNING world, read-only. This is also how the tool's thresholds are re-derived: point it
// at a world he calls good and read the numbers off it.
async function measure() {
  const world = getProperty('level-name');
  banner(`MEASURE the running world '${world}' — nothing is created, nothing is deleted`);
  const m = await measureWorld();
  if (!m.ok) { console.error(`\nseed_scanner: ${m.why}`); return 1; }
  const v = judge(m);
  // The SERVER's seed, never server.properties'. A standing world was generated from whatever level-seed
  // held on the day its folder was created, and that property has been rewritten many times since — a
  // hunt rewrites it once per attempt. Printing it here would attach a stranger's seed to his world.
  const seed = await seedReadBack();
  report(world, seed, m, v);
  if (has('log')) ledgerAppend(rowFor(world, null, seed, m, v));
  else console.log(`\n  (not written to the permanent record — a measurement of a standing world is not a ` +
    `seed trial. Pass --log to record it anyway, which is how the reference world gets a row.)`);
  return v.met ? 0 : 2;
}

// seedReadBack — the server's own answer to "what seed is this world". Asked rather than assumed: a seed
// written to server.properties and a seed the world actually generated from are two different facts, and
// only the second one is worth recording (Law 23).
async function seedReadBack() {
  const r = await guardExternal(TAG, 'rcon `seed`', () => rconLink.once(['seed'], { file: PROPS }));
  if (!r.ok) return null;
  const m = /\[(-?\d+)\]/.exec(r.value[0] ? r.value[0].body : '');
  return m ? m[1] : null;
}

// guardCandidate — may this world folder be destroyed? world_forge's rule, applied here rather than
// re-decided: a snapshot is the proof somebody meant to keep it.
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

// scan — the hunt. Each attempt: stop the JVM, delete the folder, write the seed, start the JVM, join,
// measure, judge, record. A MET world is left standing; a MISSED one is rolled over.
// A hunt rewrites `level-seed` once per attempt, and that property is a LANDMINE left set: it does
// nothing while a world folder exists, and the moment anybody deletes one and restarts, the world
// silently regenerates from the last candidate seed instead of a fresh one. So the hunt puts it back on
// every exit path — a teardown guarantee, which is what withCleanup is for. It is not a guard: a throw
// inside the hunt still travels, it just travels over a properties file that has been put back.
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
  // THE HUNT IS BOUND TO THE SERVER IT CAN DRIVE, and `--props` does not move that binding. Every
  // destructive step here — the folder it deletes, the JVM it starts — is addressed through the fleet's
  // own server directory and launcher, so a properties file pointing elsewhere would write seeds into one
  // server's configuration while deleting another server's world. Measuring is portable because it only
  // reads; hunting is not, and the refusal is what keeps the difference from being discovered by damage.
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

  const tried = [];
  for (let i = 1; i <= tries; i++) {
    const seed = seedList ? seedList[i - 1] : (i === 1 && has('seed') ? opt('seed', '') : randomSeed());
    banner(`SEED ${i}/${tries}: ${seed}`);

    // Everything up to the JVM start is authored while the server is DOWN. A live server read level-name
    // and level-seed once, at start, so writing them into a running one changes nothing and says nothing.
    console.log(`${el()} taking the server down — level-name and level-seed are read at JVM start.`);
    fleet(['server-stop']);
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
    const up = fleet(['server-start', `--world=${world}`]);
    if (up.status !== 0) {
      console.error(`\nseed_scanner: the server would not come up on seed ${seed}. The hunt stops here — a ` +
        `world that cannot be served cannot be measured, and rolling past it would hide the reason.`);
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
      console.log(`  Or put the server back on the world it was on before the hunt:`);
      console.log(`      node Auren_Workshop/fleet_control.js server-stop`);
      console.log(`      node Auren_Workshop/fleet_control.js server-start --world=${startedProps.level}`);
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
  console.log(`\n  The server is UP on the last candidate '${world}'. Put it back with:`);
  console.log(`      node Auren_Workshop/fleet_control.js server-stop`);
  console.log(`      node Auren_Workshop/fleet_control.js server-start --world=${startedProps.level}`);
  return 2;
}

// keep — snapshot the found world so a rollback can always return to it. Delegates to fleet_control's
// snapshot, which delegates to rollback.ps1 — the one implementation, and the one that already refuses
// while the server is up (a snapshot of a live world is a torn copy).
function keep() {
  const world = opt('world', 'seed_scan');
  const name = opt('snapshot', `${world}_fresh_start`);
  banner(`KEEP '${world}' as snapshot '${name}'`);
  console.log(`${el()} the server must be down for a clean copy — stopping it.`);
  fleet(['server-stop']);
  const r = fleet(['snapshot', `--world=${world}`, `--name=${name}`]);
  if (r.status !== 0) { console.error(`\nseed_scanner: the snapshot did not complete.`); return 1; }
  console.log(`\n  '${world}' is now restorable, and this tool will now REFUSE to overwrite it — having a`);
  console.log(`  snapshot is what makes a world somebody's rather than a candidate.`);
  console.log(`\n  To run the fleet on it:  node Auren_Workshop/fleet_control.js up --world=${world}`);
  return 0;
}

// log — the permanent record's lens. Every question about what a seed turned out to be is answered
// here; nothing else opens the file.
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

  // WHICH CRITERION IS DOING THE REJECTING — the one question the raw rows cannot be skimmed for, and
  // the one that tells him whether a threshold is wrong or the world generator simply is like that.
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
