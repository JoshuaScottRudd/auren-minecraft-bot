// lanista — the arena master: places both combatants, arms them, and reports what the server says
// happened (Law 23 — every authored input is read back).
//
// Makes no recording of its own; `monitoring/combat_lens` is the one reader of the combat journal
// (Law 16). Outside the construct (Law 19, Law 26): authors inputs, reads outputs. Proves the
// engagement, not the encounter (Law 25) — `trace_monitor --combat` says why.
//
// ── WHERE THE CODE LIVES ────────────────────────────────────────────────────────────────────────────
//   lanista_shared  NODE_PATH bootstrap, requires, config. Require it first from anywhere.
//   lanista_biome   find ground in a named biome.
//   lanista         (this file) stage one fight and say what the world did.
//   lanista_ladder  the tier × wave table and the run loop.
//
// Usage:
//   node lanista.js --bot=AurenBot                          # one zombie, ~12 blocks out
//   node lanista.js --bot=AurenBot --mob=creeper --rounds=3  # three fights, re-sited each time
//   node lanista.js --bot=AurenBot --mob=skeleton --hand=minecraft:bow --range=15
//   node lanista.js --bot=AurenBot --mob=zombie --count=3    # three at once, spread across bearings
//   node lanista.js --bot=AurenBot --wave=zombie:1,spider:1,skeleton:1@bow    # one MIXED wave
//   node lanista.js --bot=AurenBot --kit=wooden_sword,wooden_axe --at=-8,65,16 # author the body too
//   node lanista.js --cleanup                                # kill anything this tool left behind
// Then: node Auren_Bot/monitoring/trace_monitor.js --combat --bot=AurenBot
// Exit codes: 0 every round ran · 2 a round could not be run (terrain, arming, or the bot out of range)
//             1 could not run at all (no scout / no rcon).

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/lanista.js');

const {
  ARENA_TAG, SCOUT_NAME, SITING, WORLD, AGGRO_RANGE, AGGRO_VERTICAL_RANGE, aggroRangeFor,
  arena, createScout, fmt, log, pathfinding, rconLink, round2, sleep,
} = require('./lanista_shared');
// The bot's combat record has exactly one reader; this is it (Law 16).
const combatLens = require('../../monitoring/combat_lens');

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // `ceilingSeconds`: the point past which an unfinished fight stops counting as a fight (Law 7).
  // `lift: 2`: default mob elevation above the bot, in blocks — forces a sprint jump.
  const a = { bot: process.env.BOT_ID || 'AurenBot', mob: 'zombie', count: 1, range: 12, ceilingSeconds: 60, lift: 2, rounds: 1, cleanup: false };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'cleanup': a.cleanup = true; break;
      case 'bot': a.bot = v; break;
      case 'mob': a.mob = v; break;
      case 'hand': a.hand = v; break;          // what the mob carries in its main hand
      case 'count': a.count = parseInt(v, 10); break;
      case 'range': a.range = parseFloat(v); break;
      case 'ceiling': a.ceilingSeconds = parseInt(v, 10); break;
      case 'lift': a.lift = parseInt(v, 10); break;
      case 'rounds': a.rounds = parseInt(v, 10); break;
      case 'wave': a.wave = parseWave(v); break;
      case 'kit': a.kit = v.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'at': a.at = parseCell(v); break;
      case 'biome': a.biome = v; break;
      default: break;
    }
  }
  // A round is always a list of (mob, count, hand) groups (Law 16). --wave wins over the single-mob dials.
  if (!a.wave) a.wave = [{ mob: a.mob, count: a.count, hand: a.hand }];
  return a;
}

// A mob must be sited within the aggro range the bot honours for that species — `aggroRangeFor` /
// architect_config's per-species table is the one route for that number (Law 16). Checked at parse time,
// before any placement, purge, survey or summon is spent (Law 13).
//
// Siting band: `range ± 2` (`SITE_BAND_SLACK`).
const SITE_BAND_SLACK = 2;
// Gap between two summons landing on the same cell.
const STACKED_SUMMON_GAP_MS = 500;
// Margin between the cell filter (sited cell centre) and the presence gate (live position after landing).
const AGGRO_SITE_MARGIN = 1.0;

function rangeFitsAggro(wave, range) {
  if (!(range > 0)) return { ok: true };
  // The tightest species in the wave decides (Law 25).
  let worst = null;
  for (const g of wave) {
    const r = aggroRangeFor(g.mob);
    if (!worst || r < worst.r) worst = { r, mob: g.mob };
  }
  const max = worst.r - SITE_BAND_SLACK;
  if (range + SITE_BAND_SLACK <= worst.r) return { ok: true, max, tightest: worst };
  return {
    ok: false, max, tightest: worst,
    why: `--range=${range} does not fit inside the aggro radius. The siting band is ±${SITE_BAND_SLACK}b, so this asks for a `
      + `${worst.mob} as far out as ${range + SITE_BAND_SLACK}b, and the bot honours a ${worst.mob} to ${worst.r}b. `
      + `The most this wave can ask for and still be certain of a fight is --range=${max}.`,
  };
}

// parseWave — "zombie:1,spider:1,skeleton:1@bow" → the group list. `@item` rides on the GROUP, not the
// wave. A malformed group throws (Law 13).
function parseWave(spec) {
  const groups = [];
  for (const raw of String(spec || '').split(',')) {
    const s = raw.trim();
    if (!s) continue;
    const m = /^([a-z_]+)(?::(\d+))?(?:@([a-z_:]+))?$/i.exec(s);
    if (!m) throw new Error(`lanista: '${s}' is not a wave group — expected mob[:count][@item], e.g. skeleton:2@bow`);
    groups.push({ mob: m[1].toLowerCase(), count: m[2] ? parseInt(m[2], 10) : 1, hand: m[3] || undefined });
  }
  if (!groups.length) throw new Error('lanista: --wave was given but named no mobs');
  return groups;
}

function parseCell(text) {
  const p = String(text || '').split(',').map(Number);
  if (p.length !== 3 || p.some(n => !Number.isFinite(n))) throw new Error(`lanista: --at must be x,y,z (got '${text}')`);
  return { x: Math.floor(p[0]), y: Math.floor(p[1]), z: Math.floor(p[2]) };
}

// waveLabel — the one place a wave becomes prose (Law 16).
const waveLabel = wave => wave.map(g => `${g.count}×${g.mob}${g.hand ? `@${g.hand.replace(/^minecraft:/, '')}` : ''}`).join(' + ');

// ── Server reads (RCON, never the scout) ────────────────────────────────────────────────────────────
// The server's NBT is the authority on whether a body exists, where it is, and what it holds (Law 25) —
// the scout is a spectator client, and mineflayer gives a spectator no health for another player.

const NBT_VALUE = /entity data:\s*(.*)$/s;
const DEATH_OBJECTIVE = 'auren_lanista_deaths';

async function readBotVitals(rcon, botName) {
  const reply = (await rcon.command(`data get entity ${botName} Health`) || '').trim();
  const hm = NBT_VALUE.exec(reply);
  const health = hm ? parseFloat(hm[1]) : NaN;
  // A miss stays a miss, never a defaulted 0 (Law 13).
  if (!Number.isFinite(health)) return { known: false, alive: false, health: null, position: null };
  const posReply = (await rcon.command(`data get entity ${botName} Pos`) || '').trim();
  const pm = NBT_VALUE.exec(posReply);
  const nums = pm ? pm[1].match(/-?\d+(\.\d+)?/g) : null;
  const position = nums && nums.length >= 3
    ? { x: parseFloat(nums[0]), y: parseFloat(nums[1]), z: parseFloat(nums[2]) }
    : null;
  // health > 0 is the SERVER's own definition of alive.
  return { known: true, alive: health > 0, health, position };
}

async function ensureDeathCounter(rcon) {
  // Idempotent: safe to call every run.
  await rcon.command(`scoreboard objectives add ${DEATH_OBJECTIVE} deathCount`);
}

// Three outcomes kept apart: a number, a confirmed ZERO (`none is set`), or genuinely UNREAD (null)
// (Law 25).
async function readDeaths(rcon, botName) {
  const reply = (await rcon.command(`scoreboard players get ${botName} ${DEATH_OBJECTIVE}`) || '').trim();
  const m = /has (-?\d+)/.exec(reply);
  if (m) return parseInt(m[1], 10);
  if (/none is set/i.test(reply)) return 0;
  return null;
}

// ── Authoring the BODY: where it stands and what it holds ───────────────────────────────────────────
// Position and kit are AUTHORED inputs (Law 26), each read back off the server before anything is measured.

// placeBot — teleport, then WAIT FOR THE BODY TO BE THERE (Law 23). Tolerance ±1 x/z, ±3 y matches
// fleet_control's `move`.
async function placeBot(rcon, botName, cell, { tries = 20, waitMs = 250 } = {}) {
  await rcon.command(`tp ${botName} ${cell.x + 0.5} ${cell.y} ${cell.z + 0.5}`);
  for (let i = 0; i < tries; i++) {
    await sleep(waitMs);
    const at = await readBotVitals(rcon, botName);
    if (!at.known || !at.position) continue;
    const p = { x: Math.floor(at.position.x), y: Math.floor(at.position.y), z: Math.floor(at.position.z) };
    if (Math.abs(p.x - cell.x) <= 1 && Math.abs(p.z - cell.z) <= 1 && Math.abs(p.y - cell.y) <= 3) {
      return { ok: true, at: p };
    }
  }
  return { ok: false, why: `'${botName}' never landed on ${fmt(cell)} — is it connected, and is that cell loaded?` };
}

// kitBot — the loadout, as an authored input, verified against the server's own inventory NBT.
// The inventory is wiped first (`clear`) so the kit is the body's whole loadout. Slot order is the
// kit's order: `hotbar.0`, `hotbar.1`, …; `shield` goes to the offhand, where the fleet's shield reflex
// reads it from. The verdict is always the server's Inventory NBT, never the command's reply (Law 23/25).
const OFFHAND_ITEMS = new Set(['shield']);
async function kitBot(rcon, botName, kit) {
  const items = kit.map(i => (i.startsWith('minecraft:') ? i : `minecraft:${i}`));
  await rcon.command(`clear ${botName}`);
  let hotbar = 0;
  for (const id of items) {
    const slot = OFFHAND_ITEMS.has(id.replace(/^minecraft:/, '')) ? 'weapon.offhand' : `hotbar.${hotbar++}`;
    await rcon.command(`item replace entity ${botName} ${slot} with ${id} 1`);
  }
  // Both halves of the body's carry: the 36 inventory slots and the offhand (a separate NBT compound).
  const inv = (await rcon.command(`data get entity ${botName} Inventory`) || '').trim();
  const off = (await rcon.command(`data get entity ${botName} equipment.offhand`) || '').trim();
  const seen = `${inv} ${off}`;
  const missing = items.filter(id => !seen.includes(id));

  // BARE FISTS IS A KIT, not the absence of one — the empty kit's assay is the OPPOSITE: the server must
  // show nothing held (Law 23).
  if (items.length === 0) {
    const holding = /id:\s*"/.test(seen);
    return {
      ok: !holding, items, missing: [], inventory: inv, offhand: off,
      bare: !holding,
      unclearedDetail: holding ? 'the body still holds items after `clear` — bare fists is UNVERIFIED' : null,
    };
  }
  return { ok: missing.length === 0, items, missing, inventory: inv, offhand: off, bare: false };
}

// ── HEAL THE BODY TO FULL, AND READ BACK THAT IT TOOK ────────────────────────────────────────────────
// `kitBot`'s sibling: opens every trial on a body at full health. Amplifier 20; read off the server
// (Law 23), never inferred from the command not erroring. Duration 1s, finished before wave 1 begins.
async function healBot(rcon, botName) {
  const before = await readBotVitals(rcon, botName);
  await rcon.command(`effect give ${botName} minecraft:instant_health 1 20 true`);
  // The effect applies on the next server tick.
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const v = await readBotVitals(rcon, botName);
    if (v.known && v.health >= 20) return { ok: true, health: v.health, was: before.known ? before.health : null };
  }
  const last = await readBotVitals(rcon, botName);
  return { ok: false, health: last.known ? last.health : null, was: before.known ? before.health : null };
}

// readBiome — the fight's biome, off the SCOUT's chunk cache. Returns null when the column is not
// loaded; null is never a biome name (Law 23).
function readBiome(scout, cell) {
  const r = scout.biomeAt(cell);
  return r && r.known ? r.biome : null;
}

// The field: every mob this tool put in the world (by `ARENA_TAG`), and its health.
async function readArenaMobs(rcon) {
  const reply = (await rcon.command(`execute as @e[tag=${ARENA_TAG}] run data get entity @s Health`) || '').trim();
  const healths = [...reply.matchAll(/entity data:\s*(-?\d+(?:\.\d+)?)f/g)].map(m => parseFloat(m[1]));
  return { count: healths.length, totalHealth: healths.reduce((a, b) => a + b, 0), healths };
}

// applyWorld — author the conditions, then READ THEM BACK (Law 23). The gamerule goes first, before time.
async function applyWorld(rcon, w) {
  await rcon.command(`gamerule advance_time ${w.daylightCycle}`);
  await rcon.command(`time set ${w.time}`);
  await rcon.command(`weather ${w.weather} 1000000`);
  await rcon.command(`difficulty ${w.difficulty}`);
  // mob_griefing is READ here, not set — authored once at server bring-up by fleet_control's
  // REQUIRED_GAMERULES (Law 16). `combat_lens.detonations` reads the server's `explosion` packet.
  return {
    time: ((await rcon.command('time query daytime')) || '').trim(),
    difficulty: ((await rcon.command('difficulty')) || '').trim(),
    cycle: ((await rcon.command('gamerule advance_time')) || '').trim(),
    griefing: ((await rcon.command('gamerule mob_griefing')) || '').trim(),
  };
}

// ── Siting: where the mob goes ──────────────────────────────────────────────────────────────────────
// Keeps an uncapped voxel sweep from pinning the event loop the scout's socket needs.
const PACE = () => new Promise(r => setImmediate(r));

// The sightline seam: camera_scout.aggroLineOfSight is the same predicate threat_scanner gates on (Law 16).
const sightlineFor = scout => ({ check: (from, to, maxDist) => scout.aggroLineOfSight(from, to, maxDist) });

// The reachability seam imports the body's own pathfinder (safe from outside the construct — see
// lanista_shared's require), unlike the sightline seam, which the scout copies. Returns `{ known,
// reachable }` (Law 23/25): a box needing more than the cap is declined and reported as unproven, never
// as impassable ground.
const REACH_MAX_NODES = 4000;

// Feet cell → the block stood ON.
const floorOf = c => ({ x: c.x, y: c.y - 1, z: c.z });

function reachabilityFor(scout, maxNodes = REACH_MAX_NODES) {
  return {
    async check(fromFeet, toFeet) {
      const from = floorOf(fromFeet), to = floorOf(toFeet);
      // Same four-field snapshot reader arena_sites hands the box sweep (Law 16).
      const view = { blockAt: p => scout.blockAt(p), entity: { position: from } };
      let res;
      try {
        res = await pathfinding.computeAStar(view, from, { type: 'position', pos: to },
          { maxNodes, allowDig: false, allowPlace: false });
      } catch (e) {
        // A throw is a CODING fault in this adapter, never terrain — reported as unknown (Law 25).
        return { known: false, reachable: false, why: `search threw: ${e.message}` };
      }
      // Empty path = already there.
      if (res && res.path && !res.partial) return { known: true, reachable: true, nodes: res.nodesVisited };
      const complete = !!(res && res.complete);
      if (!complete) return { known: false, reachable: false, why: `search incomplete (${res ? res.nodesVisited : 0}/${maxNodes} nodes)` };
      return { known: true, reachable: false, why: 'no world-preserving route' };
    },
  };
}

// siteMobCells — the whole of "place mob near bot", as one call. Range band ±2 (`SITE_BAND_SLACK`);
// asked and got are both returned (Law 25). The lift stands the mob one bot-height above the bot, a
// CONTROL, with a recorded fallback (`liftFellBack`). Does not choose the anchor — `botCell` arrives
// already decided (see siteArena). `cache` is a cost dial only.
async function siteMobCells(scout, botCell, want, range, lift = 0, cache = null) {
  const dials = { blueprint: SITING.blueprint, flatness: SITING.flatness };
  if (SITING.reachGate) dials.reach = reachabilityFor(scout);
  const band = range > 0 ? { minDistance: Math.max(2, range - 2), maxDistance: range + 2 } : {};
  const opts = { pace: PACE, ...dials, ...band, ...(cache ? { cache } : {}) };

  const opp = await arena.findOpponentSpawns(arena.readerFromScout(scout), botCell, opts);
  if (!opp.boxes.length) {
    // Names WHAT the ground refused on (Law 25).
    const why = arena.formatRejections(opp.scan.rejections);
    return { cells: [], band: 0, pool: 0, refused: 0,
      detail: `no opponent box in the ${Math.max(2, range - 2)}–${range + 2}b band on this ground (${opp.scan.checked} cell(s) checked: ${why})` };
  }

  const split = await arena.partitionByLineOfSight(opp.boxes, botCell, sightlineFor(scout), opts);
  const pool = SITING.requireSightline ? split.visible : [...split.visible, ...split.hidden];
  const refused = split.unreachable.length + split.unknownReach.length;
  if (!pool.length) {
    // The two walls (unfinished search vs proven impassable) are named apart (Law 25).
    const proven = split.unreachable.length, unproven = split.unknownReach.length;
    return {
      cells: [], band: opp.boxes.length, pool: 0, refused,
      detail: refused === opp.boxes.length
        ? `all ${opp.boxes.length} box(es) in the band failed the reach gate — ${proven} proven impassable, ${unproven} unproven (the search never finished)`
        : `${opp.boxes.length} box(es) in the band, ${refused} refused by the reach gate ` +
          `(${proven} impassable, ${unproven} unproven), none of the rest had a clear line`,
    };
  }

  // Nearest to the asked-for distance first; with no range, spread across DIFFERENT bearings. The lift
  // filter runs after both gates, so it only narrows an already-confirmed set.
  const lifted = lift > 0 ? pool.filter(box => (box.y - botCell.y) >= lift) : pool;
  const liftFellBack = lift > 0 && lifted.length === 0;
  const usable = liftFellBack ? pool : lifted;

  const cells = [];
  if (range > 0) {
    const byWanted = usable.slice().sort((a, b) => Math.abs(a.distance - range) - Math.abs(b.distance - range));
    for (let i = 0; i < want; i++) {
      const box = byWanted[i % byWanted.length];
      cells.push({ x: box.x, y: box.y, z: box.z, distance: box.distance });
    }
  } else {
    const stride = Math.max(1, Math.floor(usable.length / want));
    for (let i = 0; i < want; i++) {
      const box = usable[(i * stride) % usable.length];
      cells.push({ x: box.x, y: box.y, z: box.z, distance: box.distance });
    }
  }
  return {
    cells, band: opp.boxes.length, pool: pool.length, refused, detail: null,
    rangeAsked: range > 0 ? range : null,
    rangeGot: cells.length ? Math.round(cells[0].distance * 10) / 10 : null,
    liftAsked: lift > 0 ? lift : null,
    // Measured on the cells that were CHOSEN, not the pool.
    liftGot: cells.length ? Math.min(...cells.map(c => c.y - botCell.y)) : null,
    liftPool: lifted.length,
    liftFellBack,
  };
}

// ── siteArena — FIND THE ARENA FIRST; THE BODY IS MOVED TO IT, NOT ASKED ABOUT ────────────────────────
// Finds a spot without caring where the bot currently is, then moves the bot to spot 1 and the mob to
// spot 2. The body's current stand is not an input to the search (Law 25); built on
// `arena_sites.findArenaPairs` (Law 22 gate 2).
//
// Two passes: pass 1 finds the first proven partner near the origin; pass 2 re-probes that anchor for
// its whole band, on the same cache. The origin is a starting point, not a constraint.
async function siteArena(scout, origin, want, range, lift = 0) {
  const dials = { blueprint: SITING.blueprint, flatness: SITING.flatness };
  if (SITING.reachGate) dials.reach = reachabilityFor(scout);
  // The ground dial is passed here, not to `siteMobCells`: this pass chooses WHERE the arena is.
  if (SITING.ground) dials.ground = SITING.ground;
  const band = range > 0 ? { minDistance: Math.max(2, range - 2), maxDistance: range + 2 } : {};
  const cache = arena.createSiteCache();

  const found = await arena.findArenaPairs(
    arena.readerFromScout(scout), origin, sightlineFor(scout),
    { pace: PACE, cache, pairs: 1, ...dials, ...band });

  // A refusal here is a statement about the REGION.
  if (!found.ok) {
    return {
      cells: [], botCell: null, band: 0, pool: 0, refused: 0,
      detail: `no arena anywhere the sweep could reach from ${fmt(origin)} — ${found.detail}`,
    };
  }

  const anchor = found.pairs[0];
  const botCell = { x: anchor.bot.x, y: anchor.bot.y, z: anchor.bot.z };
  const sited = await siteMobCells(scout, botCell, want, range, lift, cache);

  // NOT AN ENVIRONMENTAL FAILURE — an instrument fault, never reported as terrain (Law 13).
  if (!sited.cells.length) {
    throw new Error(`[lanista] CODING VIOLATION: findArenaPairs proved a partner at the anchor ${fmt(botCell)} ` +
      `and the re-probe of the same anchor, on the same cache, found none — "${sited.detail}". ` +
      `The two passes cannot disagree; one of them is not asking what it says it asks.`);
  }

  return {
    ...sited,
    botCell,
    // Asked and got, for the anchor too (Law 25).
    originDistance: Math.round(anchor.originDistance * 10) / 10,
    arenaSite: anchor.site,
    anchorsTried: found.scan ? found.scan.checked : null,
  };
}

// ── Delivery: putting the mob there ─────────────────────────────────────────────────────────────────
// PersistenceRequired stops the summoned mob despawning mid-fight. NoAI is not set: real approach
// behaviour is the point.

function equipmentNbt(hand) {
  const id = hand.startsWith('minecraft:') ? hand : `minecraft:${hand}`;
  return `,equipment:{mainhand:{id:"${id}",count:1}}`;
}

// ── A SUMMONED MOB ARRIVES WITH NOTHING ─────────────────────────────────────────────────────────────
// `/summon` produces a mob with NO equipment. `--hand` is READ BACK, never trusted (Law 23).
async function summonAt(rcon, mob, cell, hand) {
  const nbt = `{PersistenceRequired:1b,Tags:["${ARENA_TAG}"]${hand ? equipmentNbt(hand) : ''}}`;
  const reply = (await rcon.command(`summon minecraft:${mob} ${cell.x + 0.5} ${cell.y} ${cell.z + 0.5} ${nbt}`) || '').trim();
  const ok = !/failed|error|unknown|incorrect/i.test(reply);

  let armed = null, held = null;
  if (ok && hand) {
    // Matched on the mob nearest this cell, since every arena mob shares one tag.
    held = (await rcon.command(`data get entity @e[tag=${ARENA_TAG},type=${mob},limit=1,sort=nearest,x=${cell.x + 0.5},y=${cell.y},z=${cell.z + 0.5}] equipment`) || '').trim();
    armed = held.includes(hand.replace(/^minecraft:/, ''));
  }
  return { ok, reply, armed, held };
}

async function clearArena(rcon) {
  return rcon.command(`kill @e[tag=${ARENA_TAG}]`);
}

// ── THE WORLD'S OWN HOSTILES ────────────────────────────────────────────────────────────────────────
// `gamerule spawn_mobs false` stops new spawns only; existing hostiles in loaded chunks are purged here
// (Law 25). Purged by explicit type, never `type=!player`: animals, villagers, item frames, armour
// stands and drops are left standing. `tag=!ARENA_TAG` excludes this tool's own mobs.
const AMBIENT_HOSTILES = [
  'zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin', 'zoglin',
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'silverfish', 'endermite',
  'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'breeze',
  'pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'vex',
  'piglin', 'piglin_brute', 'hoglin', 'blaze', 'ghast', 'guardian', 'elder_guardian', 'shulker',
];
// Wider than AGGRO_RANGE on purpose, so nothing the world owns can walk in mid-wave.
const PURGE_RADIUS = AGGRO_RANGE * 2;

// Returns how many were standing there (Law 6).
async function purgeAmbientHostiles(rcon, cell) {
  const at = cell ? `,x=${cell.x + 0.5},y=${cell.y},z=${cell.z + 0.5},distance=..${PURGE_RADIUS}` : '';
  let killed = 0;
  for (const type of AMBIENT_HOSTILES) {
    const reply = (await rcon.command(`kill @e[type=${type},tag=!${ARENA_TAG}${at}]`) || '');
    const m = /Killed (\d+)/.exec(reply);
    if (m) killed += parseInt(m[1], 10);
    else if (/^Killed /.test(reply)) killed += 1;   // the server says "Killed <name>" for exactly one
  }
  return killed;
}

// ── THE SUMMON IS GATED ON THE BOT'S OWN WATCH ──────────────────────────────────────────────────────
// A monster is only spawned when the bot is in sentry mode. A wave the watch was not holding is refused,
// never scored (Law 25), read through the lens, never off the file (Law 26). Three facts: `armed` is the
// operator's mode; `engaged` goes false when the last mob resolves; `standing` is true only while a
// fresh watch loop is turning with no combat opened since.
const WATCH_WAIT_MS = 90000;
const WATCH_POLL_MS = 500;

const SCOUT_SEE_MS = 15000;
const SCOUT_POLL_MS = 400;

// awaitScoutSees — move the scout onto the fight cell, then prove it can READ that cell (Law 23).
// `y + 40`: a spectator vantage above the ground.
// A null (unloaded chunk or void) means this client cannot answer questions about this place.
async function awaitScoutSees(scout, rcon, cell, waitMs = SCOUT_SEE_MS) {
  await rcon.command(`tp ${SCOUT_NAME} ${cell.x + 0.5} ${cell.y + 40} ${cell.z + 0.5}`);
  const until = Date.now() + waitMs;
  for (;;) {
    if (scout.blockAt({ x: cell.x, y: cell.y - 1, z: cell.z })) return true;
    if (Date.now() > until) return false;
    await sleep(SCOUT_POLL_MS);
  }
}

// Returns { ok } or { ok: false, reason } — the reason is written to be printed verbatim as a NOT RUN.
async function awaitStandingWatch(botName, waitMs = WATCH_WAIT_MS) {
  const t0 = Date.now();
  let announced = false;
  let last = null;
  for (;;) {
    last = combatLens.watchState(botName);
    // No journal at all is NOT "not armed" (Law 25).
    if (!last) return { ok: false, reason: `no combat journal for '${botName}' — the bot is not running under that name, so its watch cannot be read (nothing was summoned)` };
    if (!last.armed) return { ok: false, reason: `the bot is NOT IN SENTRY MODE — nothing was summoned. Arm the watch (\`verb sentry\`) before running a ladder` };
    if (last.standing && !last.engaged) return { ok: true, waitedMs: Date.now() - t0 };
    if (!announced) {
      announced = true;
      log('round', `  waiting for the watch to stand — ${last.engaged ? `still fighting ${last.openMobs.length} mob(s)` : 'the body is inside something else (spoils, errand, or a fight that has not reported)'}. Nothing is summoned onto a busy bot.`);
    }
    if (Date.now() - t0 > waitMs) {
      return { ok: false, reason: `the watch never stood down within ${Math.round(waitMs / 1000)}s — ` +
        `${last.engaged ? `a fight is still open on mob(s) ${last.openMobs.join(', ')}` : 'armed but never re-armed a watch loop'}. ` +
        `That is a STALL in the bot, not a slow wave — nothing was summoned` };
    }
    await sleep(WATCH_POLL_MS);
  }
}

// ── The fight: wait, and say what the world did ─────────────────────────────────────────────────────
// Both halves read off the server: bot health from NBT, the field from the tagged-entity count.
// `attributable`: the mobs' total health fell before they vanished (Law 25), counting only health lost
// while the field was still intact. `hpLostAfterClear` separates the bot killing it from it killing
// itself on the bot (Law 25).
//
// No wave timer. Three completions, none waiting for `ceilingMs`: the bot died (death counter), the
// field emptied (tagged-entity count), or the bot said so (`combat_lens.completedBattlesSince`, read
// through the lens, Law 26). The ceiling is a defect reading (`timeout`), not a result; the bot's claim
// may end the waiting and may not decide the outcome (Law 26). A fourth break, the stall: engagement is
// read as an exchange of damage off the server, never proximity or the bot's own claim (Law 26).
// `stallMs = 0` disables it.
async function observeFight(rcon, botName, ceilingMs, stallMs = 0) {
  // Counts deaths IN THIS ROUND.
  await ensureDeathCounter(rcon);
  await rcon.command(`scoreboard players set ${botName} ${DEATH_OBJECTIVE} 0`);
  const t0 = Date.now();
  const until = t0 + ceilingMs;
  let hpStart = null, hpEnd = null, minHp = Infinity;
  let mobsStart = null, mobsEnd = null, mobHpStart = null, mobHpLowIntact = Infinity;
  let botDied = false, fieldCleared = false, unreadable = 0, samples = 0, deaths = 0;
  // When damage was first exchanged either way, or null; `stalled` is that null still standing at the
  // stall window's close.
  let engagedAt = null, stalled = false;
  // The bot's own report of a finished battle, read through the lens.
  let reportedBattle = null;
  // Reads the bot's own watcher trace.
  const traceReadable = combatLens.readBotTrace(botName) !== null;
  if (!traceReadable) {
    log('round', `  ⚠ no watcher trace for '${botName}' — the bot's own disengage report is UNAVAILABLE this wave. ` +
      `A mob that walks away will run to the ${Math.round(ceilingMs / 1000)}s ceiling.`);
  }

  while (Date.now() < until) {
    const v = await readBotVitals(rcon, botName);
    const field = await readArenaMobs(rcon);
    samples++;
    if (mobsStart === null) { mobsStart = field.count; mobHpStart = field.totalHealth; }
    mobsEnd = field.count;
    if (field.count === mobsStart) mobHpLowIntact = Math.min(mobHpLowIntact, field.totalHealth);

    deaths = (await readDeaths(rcon, botName)) || 0;
    if (!v.known) { unreadable++; await sleep(400); continue; }
    if (hpStart === null) hpStart = v.health;
    hpEnd = v.health;
    minHp = Math.min(minHp, v.health);

    // Read BEFORE the three completion breaks.
    if (engagedAt === null
        && ((mobHpStart != null && field.totalHealth < mobHpStart) || v.health < hpStart)) {
      engagedAt = Date.now();
    }
    if (stallMs && engagedAt === null && Date.now() - t0 > stallMs) { stalled = true; break; }
    // Checked BEFORE the cleared test.
    if (deaths >= 1 || !v.alive) { botDied = true; break; }
    // 3s floor: a summoned mob takes a tick or two to exist.
    if (field.count === 0 && Date.now() - t0 > 3000) { fieldCleared = true; break; }
    // THE BOT'S OWN REPORT, checked LAST — the observation outranks the claim (Law 26).
    if (traceReadable) {
      const reported = combatLens.completedBattlesSince(t0, { bot: botName });
      if (reported.length) { reportedBattle = reported[reported.length - 1]; break; }
    }
    await sleep(400);
  }

  let hpAfterClear = null;
  if (fieldCleared) {
    await sleep(1200);
    const after = await readBotVitals(rcon, botName);
    if (after.known) hpAfterClear = after.health;
    // ── THE SERVER SAYS *THAT* THE FIELD EMPTIED; ONLY THE BOT SAYS *HOW* ─────────────────────────
    // Supplies `reportedBattle` for the case the server ended the wave itself. Read through the lens,
    // never inferred from health (Law 25). Does not re-decide `fieldCleared`.
    if (traceReadable && !reportedBattle) {
      const reported = combatLens.completedBattlesSince(t0, { bot: botName });
      if (reported.length) reportedBattle = reported[reported.length - 1];
    }
  }

  const damagedWhileIntact = mobHpStart != null && mobHpLowIntact !== Infinity
    ? round2(mobHpStart - mobHpLowIntact) : null;

  return {
    botDied, fieldCleared,
    // Carried BESIDE the other outcomes, never folded into one of them.
    stalled, engagedMs: engagedAt === null ? null : engagedAt - t0,
    hpStart, hpEnd, minHp: minHp === Infinity ? null : minHp,
    hpLost: hpStart != null && hpEnd != null ? round2(hpStart - hpEnd) : null,
    mobsStart, mobsEnd, mobHpStart,
    mobDamageDealt: damagedWhileIntact,
    attributable: damagedWhileIntact == null ? null : damagedWhileIntact > 0,
    hpAfterClear,
    hpLostAfterClear: hpAfterClear != null && hpEnd != null ? round2(hpEnd - hpAfterClear) : null,
    deaths, samples, unreadable, ms: Date.now() - t0,
    // The bot's side, carried BESIDE the server's numbers, never folded into them (Law 26).
    traceReadable,
    reportedBattle,
    reportedKilled: reportedBattle ? reportedBattle.killed.map(e => `${e.name}#${e.id}`) : [],
    reportedDisengaged: reportedBattle ? reportedBattle.disengaged.map(e => `${e.name}#${e.id}`) : [],
    // The server's own explosion packet, read through the lens.
    reportedDetonated: reportedBattle ? reportedBattle.detonated.map(e => `${e.name}#${e.id}`) : [],
    reportedUntouched: reportedBattle ? reportedBattle.untouched.map(e => `${e.name}#${e.id}`) : [],
  };
}

// ── One wave ────────────────────────────────────────────────────────────────────────────────────────
// Place the body → gate on the biome → site → summon every group → check the bot can see the fight →
// wait → clear. Anything refused is reported as NOT RUN (Law 25). Re-placed per wave; does NOT heal or
// re-kit — attrition across waves is what is measured.
//
// ── standBot — GET THE BODY ONTO THE SPOT AND THE EYES ONTO THE BODY. Everything before a summon. ────
// Spawn, teleport to spot, spawn monster, in that order (Law 16). Returns `{ ok:false, reason }` in the
// vocabulary runWave reports NOT RUN in.
async function standBot(scout, rcon, args, label) {
  // FIRST, BEFORE ANYTHING TOUCHES THE BODY.
  const watch = await awaitStandingWatch(args.bot);
  if (!watch.ok) return { ok: false, reason: watch.reason, cause: 'bot' };
  if (watch.waitedMs > 1000) log(label, `  the watch is standing (waited ${Math.round(watch.waitedMs / 1000)}s for the body to come free).`);

  if (args.at) {
    const put = await placeBot(rcon, args.bot, args.at);
    if (!put.ok) return { ok: false, reason: put.why, cause: 'terrain' };
  }

  const at = await readBotVitals(rcon, args.bot);
  if (!at.known || !at.position) return { ok: false, reason: `the server will not answer for '${args.bot}' — is it connected?`, cause: 'bot' };
  if (!at.alive) return { ok: false, reason: 'the bot is dead — nothing to pit anything against', cause: 'bot' };
  const cell = { x: Math.floor(at.position.x), y: Math.floor(at.position.y), z: Math.floor(at.position.z) };

  // THE SCOUT HAS TO BE AT THE FIGHT, AND HAS TO PROVE IT CAN SEE IT (Law 23).
  if (!await awaitScoutSees(scout, rcon, cell)) {
    return { ok: false, reason: `the scout cannot see ${fmt(cell)} after ${Math.round(SCOUT_SEE_MS / 1000)}s — it was moved there and the chunk never arrived, so every terrain read would be a guess (nothing was summoned)` };
  }

  // THE BIOME GATE runs at the cell the fight actually happens on, not once at setup (Law 25).
  const biome = readBiome(scout, cell);
  if (args.biome && args.biome !== 'any') {
    if (biome === null) return { ok: false, reason: `the scout cannot read the biome at ${fmt(cell)} — the column is not loaded, so the control is unverified` };
    if (biome !== args.biome) return { ok: false, reason: `the fight cell is '${biome}', not the declared '${args.biome}' — the body has left its own experiment` };
  }

  // AFTER placement, BEFORE siting: placement is what loads the chunks around the stand.
  const ambient = await purgeAmbientHostiles(rcon, cell);
  if (ambient) log('purge', `${label}: ${ambient} hostile(s) the world owned were standing within ${PURGE_RADIUS}b of the fight cell — removed before the wave was placed.`);

  return { ok: true, cell, biome, ambient };
}

// ── sweepOrigin — WHERE THE SEARCH STARTS. Not where the fight is. ──────────────────────────────────
// The body's position is the SEED of a sweep, not the fight cell — only the scout needs to see it. The
// body is not moved here, even when `--at` is authored (Invariant B).
async function sweepOrigin(scout, rcon, args, label) {
  let cell;
  if (args.at) {
    cell = { x: Math.floor(args.at.x), y: Math.floor(args.at.y), z: Math.floor(args.at.z) };
  } else {
    const at = await readBotVitals(rcon, args.bot);
    if (!at.known || !at.position) return { ok: false, reason: `the server will not answer for '${args.bot}' — is it connected?`, cause: 'bot' };
    if (!at.alive) return { ok: false, reason: 'the bot is dead — nothing to pit anything against', cause: 'bot' };
    cell = { x: Math.floor(at.position.x), y: Math.floor(at.position.y), z: Math.floor(at.position.z) };
  }

  // Unread is not empty (Law 23).
  if (!await awaitScoutSees(scout, rcon, cell)) {
    return { ok: false, reason: `the scout cannot see ${fmt(cell)} after ${Math.round(SCOUT_SEE_MS / 1000)}s — the chunk never arrived, so the arena sweep would be reading nothing (nothing was summoned)`, cause: 'bench' };
  }
  return { ok: true, cell };
}

// EVERY REFUSAL BELOW CARRIES A `cause` (Law 25):
//   terrain  the ground could not host it.
//   bot      the body was not fit to fight.
//   bench    the server or the summon itself refused.
async function runWave(scout, rcon, args, n) {
  const wave = args.wave;
  const want = wave.reduce((s, g) => s + g.count, 0);

  // Find the arena, THEN move the body into it.
  const origin = await sweepOrigin(scout, rcon, args, `wave ${n}`);
  if (!origin.ok) return { run: false, reason: origin.reason, cause: origin.cause };

  const sited = await siteArena(scout, origin.cell, want, args.range, args.lift);
  if (!sited.cells.length) return { run: false, reason: sited.detail, cause: 'terrain', band: sited.band, refused: sited.refused };

  // Every gate standBot owns runs at the cell the fight is on. `at` is overridden: the sweep's answer is
  // what the body is placed on (Law 16).
  const stand = await standBot(scout, rcon, { ...args, at: sited.botCell }, `wave ${n}`);
  if (!stand.ok) return { run: false, reason: stand.reason, cause: stand.cause || 'bench' };
  const { cell, biome, ambient } = stand;

  // The sited cells are spent IN ORDER across the groups, spread across the same bearings a single-species
  // wave would use.
  const placed = [];
  const unarmed = [];
  const stacked = new Map();   // cell key → how many mobs have already been summoned onto it
  let next = 0;
  for (const g of wave) {
    // ── ONLY CELLS THE BOT CAN ACTUALLY SEE THIS MOB FROM ───────────────────────────────────────────
    // Filtered per species: `aggroRangeFor` is architect_config's one route (Law 16). The filter measures
    // the same shape the gate does: the real 3-D drop from the cell the body stands on, not the flat x/z
    // distance, as a cylinder matching the gate's own shape (Law 16 — one measure of range).
    const dropTo = (c) => ((cell && typeof cell.y === 'number' && typeof c.y === 'number') ? (c.y - cell.y) : 0);
    const flatTo = (c) => (typeof c.distance === 'number' ? c.distance : Infinity);
    const gapTo = (c) => (Number.isFinite(flatTo(c)) ? Math.hypot(flatTo(c), dropTo(c)) : Infinity);
    const radius = aggroRangeFor(g.mob) - AGGRO_SITE_MARGIN;
    const inRange = sited.cells.filter(c =>
      flatTo(c) <= radius && Math.abs(dropTo(c)) <= AGGRO_VERTICAL_RANGE - AGGRO_SITE_MARGIN);
    // No cell inside the radius is a TERRAIN answer (Law 25) — falls through to the full list and lets
    // the presence gate refuse the round by name.
    const byGap = (a, b) => gapTo(a) - gapTo(b);
    const pool = (inRange.length ? inRange : sited.cells.slice()).sort(byGap);
    for (let i = 0; i < g.count; i++) {
      const c = pool[next++ % pool.length];
      const key = `${c.x},${c.y},${c.z}`;
      const already = stacked.get(key) || 0;
      // Lets the first mob WALK OFF the cell before the second arrives.
      if (already > 0) await sleep(STACKED_SUMMON_GAP_MS);
      stacked.set(key, already + 1);
      const r = await summonAt(rcon, g.mob, c, g.hand);
      // The 3-D gap, matching the presence gate's own measure.
      if (r.ok) placed.push({ mob: g.mob, cell: c, distance: round2(gapTo(c)), armed: r.armed });
      // A mob asked to carry something and not carrying it is a DIFFERENT OPPONENT (Law 25).
      if (r.ok && g.hand && r.armed === false) unarmed.push(`${g.mob}: ${r.held || '(nothing)'}`);
    }
  }
  if (unarmed.length) {
    await clearArena(rcon);
    return { run: false, cause: 'bench', reason: `${unarmed.length} mob(s) summoned UNARMED — server says: ${unarmed.join(' | ')}`, biome };
  }
  if (!placed.length) {
    return { run: false, cause: 'bench', reason: 'every summon was refused by the server', biome };
  }

  log('round', `${n}: ${waveLabel(wave)} in ${biome || 'an unread biome'} — ` +
    placed.map(p => `${p.distance}b ${fmt(p.cell)}`).join(', '));
  log('round', `  band ${sited.band} box(es), ${sited.refused} refused by the reach gate, ${sited.pool} usable` +
    // Asked-vs-got, always both (Law 25).
    (sited.rangeAsked ? ` — asked ${sited.rangeAsked}b, got ${sited.rangeGot}b${Math.abs(sited.rangeGot - sited.rangeAsked) > 1.5 ? ' ⚠ THE TERRAIN DID NOT HAVE THE RANGE' : ''}` : ''));
  // `arenaSite` is arena_sites.describeSite's object ({tags, relief, notes}), rendered in full for the log.
  const siteLabel = sited.arenaSite && sited.arenaSite.tags && sited.arenaSite.tags.length
    ? `${sited.arenaSite.tags.join('/')} — ${sited.arenaSite.notes}`
    : (sited.arenaSite && sited.arenaSite.notes) || 'unlabelled ground';
  log('round', `  arena ${fmt(sited.botCell)} on ${siteLabel} — ` +
    `${sited.originDistance}b from the sweep origin ${fmt(origin.cell)}, ${sited.anchorsTried == null ? 'an unrecorded number of' : sited.anchorsTried} anchor(s) tried`);
  // The lift is a control: a fallback is a different experiment, and it says which.
  if (sited.liftAsked) {
    log('round', sited.liftFellBack
      ? `  ⚠ LIFT FELL BACK — no confirmed box stood ≥${sited.liftAsked}b above the bot, so this wave is FLAT (mob ${sited.liftGot >= 0 ? '+' : ''}${sited.liftGot}b). The sprint-jump is not under test here.`
      : `  lift asked ≥${sited.liftAsked}b, got +${sited.liftGot}b — ${sited.liftPool} of ${sited.pool} confirmed box(es) stood high enough. The approach has to climb.`);
  }

  // PRESENCE, CHECKED AFTER THE SUMMON AND BEFORE THE CLOCK: is the bot close enough for a fight to be
  // possible at all. A round failing this is NOT RUN, not a timeout. Per species: `aggroRangeFor`,
  // architect_config's one route (Law 16), measured as a cylinder matching the gate's own shape.
  const atSummon = await readBotVitals(rcon, args.bot);
  const gapTo = p => Math.hypot(p.cell.x + 0.5 - atSummon.position.x, p.cell.y - atSummon.position.y, p.cell.z + 0.5 - atSummon.position.z);
  const seenBy = (p) => Math.abs(p.cell.y - atSummon.position.y) <= AGGRO_VERTICAL_RANGE &&
    Math.hypot(p.cell.x + 0.5 - atSummon.position.x, p.cell.z + 0.5 - atSummon.position.z) <= aggroRangeFor(p.mob);
  const unseen = atSummon.known && atSummon.position
    ? placed.map(p => ({ p, gap: gapTo(p), radius: aggroRangeFor(p.mob), seen: seenBy(p) })).filter(x => !x.seen)
    : placed.map(p => ({ p, gap: Infinity, radius: aggroRangeFor(p.mob), seen: false }));
  // ANY mob out of its own radius fails the round, not just the nearest one (Law 25).
  if (unseen.length) {
    await clearArena(rcon);
    const named = unseen.map(x => `${x.p.mob} ${x.gap === Infinity ? 'unreadable' : `${x.gap.toFixed(1)}b`} (honoured to ${x.radius}b)`).join(', ');
    return { run: false, cause: 'terrain', reason: `${unseen.length} of ${placed.length} mob(s) outside the radius the bot honours for them: ${named} — it would measure a fight the bot cannot see`, biome };
  }

  const outcome = await observeFight(rcon, args.bot, args.ceilingSeconds * 1000,
    (args.stallSeconds || 0) * 1000);
  await clearArena(rcon);
  return {
    run: true, placed: placed.length, biome, cell,
    wave: waveLabel(wave),
    ambientPurged: ambient,
    rangeAsked: sited.rangeAsked, rangeGot: sited.rangeGot,
    liftAsked: sited.liftAsked, liftGot: sited.liftGot, liftFellBack: sited.liftFellBack,
    // Read off the body at the moment the wave opened.
    standY: cell.y,
    ...outcome,
  };
}

// The headline states WHAT WAS MEASURED. A detonation is named for what it is, distinct from
// "field cleared BY THE BOT" (Law 25). One decider for how the wave ended, read by both the human
// sentence and the ledger's word (Law 16). The words are the ledger's vocabulary: `disengaged` and
// `unattributable` bucket under `timeout`.
function waveVerdict(r) {
  if (r.botDied) return 'died';
  if (r.stalled) return 'stalled';
  if (!r.fieldCleared) return r.reportedBattle ? 'disengaged' : 'timeout';
  // The server's own announcement first, the health inference second (Law 23).
  if (r.reportedDetonated.length || r.hpLostAfterClear > 0) return 'blown';
  if (r.attributable) return 'cleared';
  return 'unattributable';
}

function headline(r) {
  // A RENDERER over `waveVerdict`, never a second decider.
  switch (waveVerdict(r)) {
    case 'died':
      return `💀 BOT DIED (${r.deaths}× this round)`;
    case 'stalled':
      return `🚫 STALL — no damage exchanged either way in ${Math.round(r.ms / 1000)}s. The wave was set up and never happened; this measures the BENCH, not the bot`;
    case 'disengaged':
      return `🚶 DISENGAGED — the bot reports the battle over with the field still standing` +
        `${r.reportedDisengaged.length ? ` (${r.reportedDisengaged.join(', ')} walked)` : ''}` +
        `${r.reportedKilled.length ? `, ${r.reportedKilled.join(', ')} killed` : ''}`;
    case 'timeout':
      return '⏱️  timed out';
    case 'blown':
      return r.reportedDetonated.length
        ? `💥 MOB DETONATED — the server announced the blast; the bot did not kill it ` +
          `(${r.reportedDetonated.join(', ')}${r.reportedKilled.length ? `, ${r.reportedKilled.join(', ')} killed` : ''})`
        : `💥 MOB DETONATED — the bot did not kill it (${r.mobDamageDealt} of its ${r.mobHpStart} hp taken off first)`;
    case 'cleared':
      return '✅ field cleared BY THE BOT';
    default:
      return '⚠️  field emptied — NOT the bot (no damage dealt)';
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────

// waitForScout: proves the scout SPAWNED, and nothing more. IT DOES NOT PROVE CHUNKS — that question
// belongs to `awaitScoutSees`.
async function waitForScout(scout, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (scout.isReady()) return true;
    await sleep(500);
  }
  return false;
}

// cleanupOnly — the one verb that must work when everything else is broken (Law 8). It needs no scout.
async function cleanupOnly() {
  let link;
  try { link = await rconLink.open(rconLink.readServerProperties()); }
  catch (e) {
    console.error(`Cannot reach the server over RCON (${e.code || e.message}). Nothing was cleaned up. ` +
      `Arena mobs are tagged '${ARENA_TAG}' and will still be there when it is back.`);
    return 1;
  }
  try { console.log((await link.command(`kill @e[tag=${ARENA_TAG}]`) || '').trim() || '(nothing tagged)'); }
  finally { link.close(); }
  return 0;
}

// openArena — connect the scout, open RCON, author the world, clear the field. One implementation
// (Law 16). Returns { ok:false, why }; never throws.
async function openArena({ quiet = false } = {}) {
  const scout = createScout({
    host: '127.0.0.1', port: 25565, version: require('@thinking/architect_config').SERVER_MINECRAFT_VERSION, username: SCOUT_NAME,
    onReady: () => log('scout', 'connected'),
    onEnd: why => log('scout', `down — ${why}`),
    log: (lvl, m) => log('scout', m),
  });
  if (!scout.available) {
    return { ok: false, why: `mineflayer unavailable to the scout (${scout.reason}). Install the bot's packages, from Auren_Bot\\:\n`
      + '  .\\Auren_Workshop\\scripts\\npm.ps1 install' };
  }
  if (!await waitForScout(scout)) { scout.end(); return { ok: false, why: 'the scout never spawned — is the server up?' }; }

  let rcon;
  try { rcon = await rconLink.open(rconLink.readServerProperties(), () => log('rcon', 'link lost')); }
  catch (e) { scout.end(); return { ok: false, why: `cannot reach the server over RCON (${e.code || e.message})` }; }

  // Park the scout in spectator: cannot fall, die, or take a mob's attention.
  await rcon.command(`gamemode spectator ${SCOUT_NAME}`);
  const world = await applyWorld(rcon, WORLD);
  if (!quiet) {
    log('world', `${world.time}, ${world.difficulty}, daylight cycle ${world.cycle} — ` +
      `asked for ${WORLD.time}/${WORLD.difficulty}. Skeletons and zombies do not burn here.`);
    // Named as a FAULT when griefing is on.
    log('world', /set to: false/.test(world.griefing)
      ? `${world.griefing} — creeper blasts leave the terrain intact, so every rung is fought on the same ` +
        `ground. The bot still takes the full damage; only the terrain is spared.`
      : `⚠ ${world.griefing} — blasts will CRATER the ground the next wave is sited on, so this trial is ` +
        `not comparable to one run with it off. fleet_control sets this at bring-up; a server started ` +
        `another way did not get it.`);
  }
  await clearArena(rcon);
  // Global (no cell): nobody knows yet where the fight will be. runWave re-purges around the actual stand.
  const ambient = await purgeAmbientHostiles(rcon, null);
  if (!quiet && ambient) {
    log('purge', `${ambient} hostile(s) the world already owned were removed from the loaded chunks. ` +
      `spawn_mobs=false stops new ones; it does not touch these.`);
  }

  return {
    ok: true, scout, rcon, world,
    // Terminates with whoever raised it (Law 8); runs even on a failure path.
    async close() {
      try { await rcon.command(`kill @e[tag=${ARENA_TAG}]`); } catch (_) {}
      rcon.close();
      scout.end();
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cleanup) return cleanupOnly();

  // BEFORE THE SERVER IS EVEN OPENED — arithmetic against the bot's own aggro table, nothing moved yet.
  const fit = rangeFitsAggro(args.wave, args.range);
  if (!fit.ok) { console.error(`Cannot run: ${fit.why}`); return 2; }

  const arenaLink = await openArena();
  if (!arenaLink.ok) { console.error(`Cannot run: ${arenaLink.why}`); return 1; }
  const { scout, rcon } = arenaLink;

  let exitCode = 0;
  try {
    if (args.kit) {
      const k = await kitBot(rcon, args.bot, args.kit);
      log('kit', k.ok
        ? `${args.bot} carries ${k.items.join(', ')} — inventory WIPED first, so nothing it earned is in this fight.`
        : `⚠ NOT RUN — ${args.bot} is missing ${k.missing.join(', ')} after the replace; the server says: ${k.inventory || '(empty)'}`);
      if (!k.ok) return 2;
    }

    // ── SPAWN → TELEPORT TO THE SPOT → SPAWN MONSTER, in that order and at the START ───────────────────
    // A failure here is exit 2 and NOT a round (Law 25).
    const opening = await standBot(scout, rcon, args, 'open');
    if (!opening.ok) { log('open', `NOT RUN — ${opening.reason}`); return 2; }
    log('open', `${args.bot} is standing at ${fmt(opening.cell)} in ${opening.biome || 'an unread biome'}, ` +
      `the scout can read the ground, and the field is clear. Monsters next.`);

    const rounds = [];
    for (let n = 1; n <= args.rounds; n++) {
      const r = await runWave(scout, rcon, args, n);
      rounds.push(r);
      if (!r.run) { log('round', `${n}: NOT RUN — ${r.reason}`); exitCode = 2; continue; }
      log('round', `  → ${headline(r)} · bot hp ${r.hpStart}→${r.hpEnd} (low ${r.minHp}) · ` +
        `mobs ${r.mobsStart}→${r.mobsEnd}, ${r.mobDamageDealt} damage dealt · ${(r.ms / 1000).toFixed(1)}s`);
      if (n < args.rounds) await sleep(2000);
    }

    const ran = rounds.filter(r => r.run);
    log('verdict', `${ran.length}/${args.rounds} round(s) run vs ${waveLabel(args.wave)} — ` +
      `${ran.filter(r => r.fieldCleared).length} cleared · ${ran.filter(r => r.botDied).length} death(s) · ` +
      `${ran.filter(r => r.run && !r.fieldCleared && !r.botDied).length} timed out`);
    // The bench says WHAT happened; the journal says why (Law 16).
    log('done', `Why it went that way: node Auren_Bot/monitoring/trace_monitor.js --combat --bot=${args.bot}`);
    return exitCode;
  } catch (e) {
    console.error(`lanista failed: ${e.stack || e.message}`);
    return 1;
  } finally {
    await arenaLink.close();
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  ARENA_TAG, DEATH_OBJECTIVE, REACH_MAX_NODES, SITING, WORLD,
  parseArgs, parseWave, parseCell, waveLabel, headline, waveVerdict,
  siteMobCells, siteArena, summonAt, equipmentNbt, reachabilityFor,
  readBotVitals, readDeaths, readArenaMobs, readBiome,
  placeBot, kitBot, healBot, clearArena, applyWorld, waitForScout,
  openArena, cleanupOnly, runWave,
  // The opening sequence and the gate in front of it, both testable without a server.
  standBot, rangeFitsAggro, SITE_BAND_SLACK,
};
