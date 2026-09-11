// lanista — the arena master. Named for the trainer who owned the school and chose the matchings.
//
// ── WHAT SHAPE OF SOAK ACTUALLY PRODUCES DATA ───────────────────────────────────────────────────────
// Moved here 2026-09-01 from the bugsquashing record's standing tail, because it is a fact about THIS
// TOOL and was being carried forward across volumes of a document that does not own it. Natural spawning
// gives roughly one fight per twenty minutes, which is not a sample — that is why this bench exists.
//
// TWO FACTS ANY SOAK PLAN HAS TO RESPECT, both measured rather than reasoned:
//   1. Zombies produce NO locomotion data. They walk to the bot, so the repel arm never calls
//      `closeToBand` and no leg ever runs. Only KITING targets (skeletons) generate movement.
//   2. Combat happens on flat ground by the base, which is why 25 minutes of it produced ONE jump press.
//      The jump geometry question cannot be answered from combat at all; it needs the ordinary navigator
//      over surface terrain that climbs.
//
// So the profile that exercises the rush arm, the chase, the jump trigger and the engagement queue at
// once is `--mob=skeleton --rounds=N` against a bot on the SURFACE, not underground on the staircase —
// and `--cleanup` afterwards, so the next run starts honest.
//
// ── ITS ONE JOB ─────────────────────────────────────────────────────────────────────────────────────
// The verb is STAGE THE FIGHT, and it is one verb: put BOTH combatants where the experiment says, arm
// both, get out of the way, report what the world did. Both the mob's placement and the bot's own are
// AUTHORED rather than sensed — the experiment decides where the body stands and what it holds, instead
// of fighting from wherever the bot happened to end up. That is a correction of who owns a control
// variable: a bench that reads the bot's position as given cannot repeat a trial, and repeating trials
// is the whole of what this tool is for.
//
// EVERYTHING AUTHORED IS READ BACK. Placement, kit, mob equipment, world and biome each go out as a
// command and come back as a server read, because every one of them is a command the server accepts and
// silently declines to honour (a tp into an unloaded chunk, an `item replace` with a bad id, `time set`
// under a running daylight cycle). An authored input nobody verified is a control in name (Law 23).
//
// ── WHAT IT USED TO BE, AND WHY THAT IS GONE ────────────────────────────────────────────────────────
// It used to be several modules: a siting A/B, a scenario table, per-mob "match cards" (creeper / archer
// / archer_shield) each with its own wave list, kit, rekit policy and world block, a bot-placement system
// that teleported the body onto surveyed terrain, and a per-tick recorder writing its own tape. Two
// separate forces killed that shape:
//
//   1. The RECORDER had no reader. The bot now journals its own combat and `trace_monitor --combat`
//      reads it. A record nothing reads is not a record (Law 16 — one capability, one route).
//   2. The MATCH CARDS were a second experiment design living beside the fleet's own run. Every question
//      they were built for (does the counter engage, does it clear, how much damage does it take, at what
//      range does it swing) is now answered by `--combat` over any run with monsters on — from real
//      fights rather than authored ones. Keeping the cards would keep two definitions of "a fight went
//      well", free to disagree, with nothing deciding which is right.
//
// What survives is the part nothing else can do: MAKE a fight happen, on demand, at a chosen range,
// against a chosen mob. That is a world-transformation, and no amount of reading answers it.
//
// ── STANDING (Law 19, Law 26) ───────────────────────────────────────────────────────────────────────
// OUTSIDE the construct, like trace_monitor and camera_rig. Not a fragment, no signal bus, decides
// nothing in any SPA loop. It is the translator machine at the boundary: it AUTHORS inputs (which mob
// arrives at what distance with what sightline, in what light) and READS outputs (what the world then
// did). It never computes what Minecraft would have done and never computes what the bot should have
// done — the first would be a simulator, the second would be grading the paper it set.
//
// ── WHAT IT CANNOT PROVE, stated up front (Law 25) ──────────────────────────────────────────────────
// A SUMMONED mob is not a SPAWNED mob: it arrives already aggro-eligible with no approach, which is the
// source of the determinism and also the limit. This proves the ENGAGEMENT. The ENCOUNTER is what
// monsters-on proves, and this file is not a substitute for that.
//
// It also does not say WHY the fight went the way it did. That is `trace_monitor --combat`, reading the
// bot's own journal, and the two are meant to be read together: this file makes the fight and names the
// outcome off the SERVER; the lens says what the bot decided inside it.
//
// AND IT DOES NOT ARM THE BOT'S ENGAGEMENT. battle_stations is awaited inside the fleet's own executor
// loops, so a bot running autonomy fights whatever lands next to it with no help from here. A PARKED bot
// does not, and the fix for that is the operator's own `sentry` verb (js_kernel/operator_commands) —
// a separate route, deliberately, because arming the body is the operator's decision about the fleet and
// not a side effect of summoning a mob (Law 16: this file has one verb).
//
// ── WHERE THE CODE LIVES ────────────────────────────────────────────────────────────────────────────
// Four files, one verb each — the sequencing lives outside so this file never grows a second experiment
// design back:
//   lanista_shared  the NODE_PATH bootstrap, every require, the config. REQUIRE IT FIRST from anywhere:
//                   the bootstrap must run before any @-alias resolves.
//   lanista_biome   find ground in a NAMED biome, hopping this tool's own scout to load chunks.
//   lanista         (this file) stage one fight and say what the world did.
//   lanista_ladder  the tier × wave table and the run loop. Sequences; decides nothing about a fight.
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

const {
  ARENA_TAG, SCOUT_NAME, SITING, WORLD, AGGRO_RANGE, AGGRO_VERTICAL_RANGE, aggroRangeFor,
  arena, createScout, fmt, log, pathfinding, rconLink, round2, sleep,
} = require('./lanista_shared');
// The bot's own combat record has exactly one reader, and this is it (CLAUDE.md's pairing rule). A bench
// that parsed `watcher_<bot>.jsonl` itself would be a second reader for one record — the
// defect the pairing exists to prevent — so the lens gained a machine-facing function instead.
const combatLens = require('../../monitoring/combat_lens');

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // ── `ceilingSeconds`, NOT `hold` ────────────────────────────────────────────────────────────────────
  // There is no wave timer — a wave ends when the battle ends. A wave ends when the battle ends — the
  // field empties or the bot dies, both of which observeFight breaks on — and this value is only the
  // point past which a fight that has not ended is no longer believed to be a fight. Naming a ceiling
  // after a duration invites the reading that a wave RUNS for it, which is exactly the Law 7 defect: the
  // name has to describe what the thing does.
  // `lift: 2` is the DEFAULT, not an opt-in, because it is a control rather than a mode: the mob stands
  // higher than the bot by at least one bot-height so the approach forces a sprint jump. Two blocks is
  // one bot. `--lift=0` turns it off for a deliberately flat comparison run.
  const a = { bot: process.env.BOT_ID || 'AurenBot', mob: 'zombie', count: 1, range: 12, ceilingSeconds: 60, lift: 2, rounds: 1, cleanup: false };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'cleanup': a.cleanup = true; break;
      case 'bot': a.bot = v; break;
      case 'mob': a.mob = v; break;
      case 'hand': a.hand = v; break;          // what the mob carries — see armedOrRefuse below
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
  // One shape downstream, always. A round is a LIST of (mob, count, hand) groups whether the operator
  // typed --wave or the three single-mob dials, so nothing below branches on which flag was used
  // (Law 16). --wave wins when both are given rather than merging: a silent merge would summon a wave
  // nobody wrote, and there is no reading of "both" that is obviously right.
  if (!a.wave) a.wave = [{ mob: a.mob, count: a.count, hand: a.hand }];
  return a;
}

// ── THE ASKED RANGE HAS TO FIT INSIDE THE AGGRO RADIUS, AND IT IS CHECKED BEFORE ANYTHING IS SUMMONED ──
// A mob must be sited within the aggro range the bot actually honours for that species — a flat 15b test
// is a FALSE refusal for a skeleton (honoured further, by architect_config's per-species table, which is
// the one route for that number rather than a second copy of it here). Refusing after summoning would
// also cost a placement, a purge, a survey and a summon before saying no, so the check runs before any of
// that is spent.
//
// The deeper point is why this gate exists rather than just the constant changing: asking for a range
// EQUAL to the radius is asking for a coin flip. The siting band is `range ± 2`, so a
// request for 15 legitimately places a mob at 17 — outside the radius for every species — and whether the
// round runs then depends on which cell the terrain happened to offer. A control that the ground decides
// is not a control. `SITE_BAND_SLACK` is that ±2, restated from siteMobCells' own band rather than
// imported because the two are the same fact in one file and the band is built inline there.
//
// Refused at parse time, not mid-wave: nothing has been summoned yet, so the operator gets a sentence and
// an intact world instead of a NOT RUN with a corpse in it (Law 13 — prove it can run before it runs).
const SITE_BAND_SLACK = 2;
// The pause between two summons onto the SAME cell, when a wave has more mobs than the ground has usable
// cells — long enough for the mob to move off the cell before the next one lands on it. A zombie walks
// ~2.8 b/s, so half a second is roughly 1.4 b — a body length and a half of separation, which is enough
// for the second summon to land on ground the first has left.
const STACKED_SUMMON_GAP_MS = 500;
// How much tighter the cell filter is than the presence gate it feeds. One block, because the two measure
// from different points (sited cell centre vs the bot's live position, read back after it stands), and a
// filter that matched the gate exactly could disagree with it by fractions of a block. Costs a block of
// the outermost ring; buys a filter whose answer the gate agrees with.
const AGGRO_SITE_MARGIN = 1.0;

function rangeFitsAggro(wave, range) {
  if (!(range > 0)) return { ok: true };
  // The TIGHTEST species in the wave decides, because one mob outside the radius is a mob the bot never
  // fights while the round still reports itself as run (Law 25) — a mixed wave is only as valid as its
  // least-visible member.
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

// parseWave — "zombie:1,spider:1,skeleton:1@bow" → the group list.
//
// `@item` rides on the GROUP and not on the wave, because a mixed wave is exactly where the difference
// bites: wave 5 is a zombie, a spider and an ARMED skeleton, and a wave-level `--hand` would hand a bow
// to the spider. The count defaults to 1 so `zombie` alone is legal; a malformed group throws rather
// than being skipped, because a wave silently one mob short is a different experiment wearing this
// one's label (Law 13 — never default a missing field, and never drop one).
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

// waveLabel — the one place a wave becomes prose, so the console line, the refusal reason and the
// ledger row cannot describe the same wave three different ways.
const waveLabel = wave => wave.map(g => `${g.count}×${g.mob}${g.hand ? `@${g.hand.replace(/^minecraft:/, '')}` : ''}`).join(' + ');

// ── Server reads (RCON, never the scout) ────────────────────────────────────────────────────────────
//
// EVERY VITALS READ HERE IS OFF THE SERVER, and that is the one design decision in this section. The
// scout is the right instrument for GROUND (it holds the chunk data the siting sweep reads) and the
// wrong one for a BODY: mineflayer gives a spectator no health for another player, so every health guard
// written against it was silently dead. The first match ever run printed '✅ field cleared · hp
// null→null' for a bot that never swung at a zombie the sun had killed — every log line beneath it true
// (Law 25). The server's NBT is the authority on whether a body exists, where it is, and what it holds.

const NBT_VALUE = /entity data:\s*(.*)$/s;
const DEATH_OBJECTIVE = 'auren_lanista_deaths';

async function readBotVitals(rcon, botName) {
  const reply = (await rcon.command(`data get entity ${botName} Health`) || '').trim();
  const hm = NBT_VALUE.exec(reply);
  const health = hm ? parseFloat(hm[1]) : NaN;
  // A miss stays a miss. A parse that silently yielded 0 would read as "the bot is dead" and abort a
  // fight over a typo'd name (Law 13 — never default a missing field).
  if (!Number.isFinite(health)) return { known: false, alive: false, health: null, position: null };
  const posReply = (await rcon.command(`data get entity ${botName} Pos`) || '').trim();
  const pm = NBT_VALUE.exec(posReply);
  const nums = pm ? pm[1].match(/-?\d+(\.\d+)?/g) : null;
  const position = nums && nums.length >= 3
    ? { x: parseFloat(nums[0]), y: parseFloat(nums[1]), z: parseFloat(nums[2]) }
    : null;
  // health > 0 is the definition of alive the SERVER uses; a dead player still exists as an entity with
  // Health 0.0f until it respawns.
  return { known: true, alive: health > 0, health, position };
}

async function ensureDeathCounter(rcon) {
  // Idempotent: the server answers "An objective already exists by that name" on every run after the
  // first, which is the desired outcome and not an error worth reading.
  await rcon.command(`scoreboard objectives add ${DEATH_OBJECTIVE} deathCount`);
}

// THREE OUTCOMES AND THEY MUST STAY THREE. A deathCount objective has no entry for a player until that
// player dies once, so the server answers `none is set` — which an earlier version fell through to null,
// i.e. "could not read". A death watch built on that reported itself broken for every healthy fleet
// (Law 25: a signal saying "I cannot tell" when it can tell perfectly well is a false verdict). So: a
// number, a confirmed ZERO, or genuinely UNREAD (null) for an rcon failure or a missing objective.
async function readDeaths(rcon, botName) {
  const reply = (await rcon.command(`scoreboard players get ${botName} ${DEATH_OBJECTIVE}`) || '').trim();
  const m = /has (-?\d+)/.exec(reply);
  if (m) return parseInt(m[1], 10);
  if (/none is set/i.test(reply)) return 0;
  return null;
}

// ── Authoring the BODY: where it stands and what it holds ───────────────────────────────────────────
//
// Both of these were previously the fleet's own (the bot fought from where it was, with what it had),
// and moving them across the seam is the scientific reason rather than a convenience: a trial whose body
// starts somewhere different each time has no control at all, and the ladder's whole claim is that tier 1
// and tier 2 fought the same fight. Position and kit are now AUTHORED inputs (Law 26 — the mind may
// author what the machine does not decide), and each is read back off the server before anything is
// measured.

// placeBot — teleport, then WAIT FOR THE BODY TO BE THERE. Same two-voxel discipline fleet_control's
// `move` verb uses, and for the reason its header states: an RCON tp that silently missed (a bad name,
// an unloaded chunk) surfaces later as a mysteriously long walk or a mob sited around a body that is
// somewhere else entirely. The poll is what turns that into a refusal (Law 23).
//
// ±1 on x/z and ±3 on y is the same tolerance `move` settled on: the server lands a body on the column's
// real floor, which is not always the y that was asked for, and a body that arrived one block down did
// arrive.
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
//
// ── THE INVENTORY IS WIPED FIRST, AND THAT IS DESTRUCTIVE ───────────────────────────────────────────
// `clear` empties the body: whatever the fleet had earned is gone. That is deliberate and it is the only
// honest way to author a kit — an `item replace` onto a full inventory leaves the bot carrying a stone
// sword AND the iron one it found an hour ago, and the fleet's weapon picker takes the best of what it
// holds, so the trial would silently measure the iron sword under a label reading 'wooden'. A control
// that the body can quietly outrank is not a control. The caller is the one that must know this, which
// is why it is stated here and again at the ladder's own start line.
//
// SLOT ORDER IS THE KIT'S ORDER. `hotbar.0` gets the first item, then hotbar.1, and `shield` goes to the
// offhand wherever it appears in the list — the offhand is where the fleet's shield reflex reads it from,
// so putting a shield in the hotbar would give the bot a shield it can never raise.
//
// READ BACK, ALWAYS. `item replace entity` answers the same cheerful line for an item id the server does
// not know as for one it does; the summon path two functions down learned this the expensive way (a
// skeleton with no bow that charged and bashed, recorded as an archer match). The verdict here is the
// server's Inventory NBT, never the command's reply (Law 23/25).
const OFFHAND_ITEMS = new Set(['shield']);
async function kitBot(rcon, botName, kit) {
  const items = kit.map(i => (i.startsWith('minecraft:') ? i : `minecraft:${i}`));
  await rcon.command(`clear ${botName}`);
  let hotbar = 0;
  for (const id of items) {
    const slot = OFFHAND_ITEMS.has(id.replace(/^minecraft:/, '')) ? 'weapon.offhand' : `hotbar.${hotbar++}`;
    await rcon.command(`item replace entity ${botName} ${slot} with ${id} 1`);
  }
  // Both halves of the body's carry: the 36 inventory slots and the offhand, which the server keeps in a
  // separate compound. Asking only for `Inventory` reports a shield-carrying bot as unarmed.
  const inv = (await rcon.command(`data get entity ${botName} Inventory`) || '').trim();
  const off = (await rcon.command(`data get entity ${botName} equipment.offhand`) || '').trim();
  const seen = `${inv} ${off}`;
  const missing = items.filter(id => !seen.includes(id));

  // BARE FISTS IS A KIT, NOT THE ABSENCE OF ONE — it is the bottom tier of weapons, not an unset value.
  // An empty list has no item to look for, so `missing.length === 0` is
  // vacuously true and would pass for a body still carrying yesterday's iron sword if `clear` had been
  // declined — the exact shape of unverified control this function exists to refuse. So the empty kit
  // gets the OPPOSITE assay: the server must show nothing held. Same law as every other read-back here
  // (Law 23), pointed the other way.
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
//
// The sibling of `kitBot`, and it sits here for the same reason: a trial must open on a body carrying
// nothing from the last one. Health is carry-over exactly as a half-used sword is — an unhealed body
// opening its next trial below full is a control lost the same way an uncleared inventory is.
//
// AMPLIFIER 20, NOT 1. instant_health heals 2 hearts × 2^amplifier, so a low amplifier tops a nearly-dead
// body up part-way and reports success — the shortfall would then be invisible in the trial that followed
// (Law 25). The amplifier is set far past any reachable deficit so the effect cannot fall short, and the
// health is then READ OFF THE SERVER anyway rather than inferred from the command not erroring (Law 23:
// `effect give` returning quietly is a claim, not a fact — it says the packet was accepted, not that the
// body is whole). Duration 1 second: the heal must be over before wave 1 begins, or it subsidises the fight.
async function healBot(rcon, botName) {
  const before = await readBotVitals(rcon, botName);
  await rcon.command(`effect give ${botName} minecraft:instant_health 1 20 true`);
  // The effect applies on the next server tick, so a read fired immediately reports the OLD value.
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const v = await readBotVitals(rcon, botName);
    if (v.known && v.health >= 20) return { ok: true, health: v.health, was: before.known ? before.health : null };
  }
  const last = await readBotVitals(rcon, botName);
  return { ok: false, health: last.known ? last.health : null, was: before.known ? before.health : null };
}

// readBiome — the fight's biome, off the SCOUT's chunk cache rather than the server.
//
// There is no server command that ANSWERS this (`execute if biome` only tests a guess), so the read has
// to come from a client holding the chunk — which is what the scout already is. Returns null when the
// column is not loaded, and a null is never a biome name: the ladder gates a trial on this value, and
// "not loaded yet" answering as "not that biome" would abandon a correct site (Law 23).
function readBiome(scout, cell) {
  const r = scout.biomeAt(cell);
  return r && r.known ? r.biome : null;
}

// The field: every mob this tool put in the world, and its health. One tag is what makes this a single
// command and what keeps the world's own spawns out of the count.
async function readArenaMobs(rcon) {
  const reply = (await rcon.command(`execute as @e[tag=${ARENA_TAG}] run data get entity @s Health`) || '').trim();
  const healths = [...reply.matchAll(/entity data:\s*(-?\d+(?:\.\d+)?)f/g)].map(m => parseFloat(m[1]));
  return { count: healths.length, totalHealth: healths.reduce((a, b) => a + b, 0), healths };
}

// applyWorld — author the conditions, then READ THEM BACK. The read-back is the point: `difficulty` on a
// locked server and `time set` under a running daylight cycle both accept the command and change
// nothing, so the only honest record of what a fight happened in is what the server says afterwards
// (Law 23). The gamerule goes FIRST — setting the time while the cycle still runs is a value that starts
// drifting the same tick, which is how a 90-second fight that began at midnight can end in daylight.
async function applyWorld(rcon, w) {
  await rcon.command(`gamerule doDaylightCycle ${w.daylightCycle}`);
  await rcon.command(`time set ${w.time}`);
  await rcon.command(`weather ${w.weather} 1000000`);
  await rcon.command(`difficulty ${w.difficulty}`);
  // ── mobGriefing IS READ HERE, NOT SET ───────────────────────────────────────────────────────────────
  // It is authored ONCE, at server bring-up, by fleet_control's REQUIRED_GAMERULES — which is where the
  // full reasoning lives and where a rollback's reversion is handled. This file only VERIFIES, because
  // two authors of one condition is the redundant pathway Law 16 forbids and the failure would be silent:
  // whichever ran last would win and neither would look wrong.
  //
  // Verified rather than assumed because it changes what the ladder measured. A detonation craters the
  // ground the next wave is sited on, so a trial run with griefing ON was fought on terrain the previous
  // trial rearranged — a difference the ladder would otherwise credit to the bot. The bot still takes the
  // full blast damage either way; only the terrain is spared.
  //
  // It also settles a dependency the explosion witness was designed around: with griefing off there is no
  // crater to find, so a block-damage detector would report "no explosions" on every run in the flattering
  // direction. `combat_lens.detonations` reads the server's `explosion` packet instead and is unaffected —
  // a successor tempted to swap it for a cheaper crater test should read this line first.
  return {
    time: ((await rcon.command('time query daytime')) || '').trim(),
    difficulty: ((await rcon.command('difficulty')) || '').trim(),
    cycle: ((await rcon.command('gamerule doDaylightCycle')) || '').trim(),
    // Read back for applyWorld's stated reason: a rule that was accepted and not applied must not be
    // recorded as applied.
    griefing: ((await rcon.command('gamerule mobGriefing')) || '').trim(),
  };
}

// ── Siting: where the mob goes ──────────────────────────────────────────────────────────────────────

// The pacer keeps an uncapped voxel sweep from pinning the event loop the scout's own socket needs.
// Without it the scout stops receiving chunk updates mid-scan and the sweep reads its own starvation as
// a loaded frontier — a silent false negative, the worst kind for a siting scan.
const PACE = () => new Promise(r => setImmediate(r));

// The sightline seam. camera_scout.aggroLineOfSight is the observer's transcription of
// terrain_predicates.hasLineOfSight — the SAME predicate threat_scanner gates on. Any other
// implementation here (a name-based block walk is the tempting one) would disagree with the bot on what
// "can see" means, and the bench would report bot failures that were really bench failures.
const sightlineFor = scout => ({ check: (from, to, maxDist) => scout.aggroLineOfSight(from, to, maxDist) });

// The reachability seam, and it is the OPPOSITE call to the sightline one, deliberately. The scout copies
// the raycast because the bench must be able to author a situation independently of the code under test.
// Reachability is not that: it is not being tested, it is a siting criterion, so it imports the body's
// own pathfinder (see lanista_shared's require for why that is safe from outside the construct).
//
// ── THIS ADAPTER WAS WRONG ON FIVE COUNTS AND COULD NEVER HAVE RUN ────────────────────────────────────
// The bugs are named here rather than quietly corrected, because the shape they had is the shape a
// successor writing this adapter from scratch would reach for again, and because a broken gate of this
// kind is INVISIBLE from the outside: `SITING.reachGate` is on by default, so a broken adapter dies
// inside the first candidate box and the tool reports 'lanista failed', never 'the gate is broken'.
//   1. the method was `walkable`; arena_sites' memo calls `reachImpl.check(from, to)` — a TypeError on
//      the first candidate. The sightline seam beside it uses `check` and was always right, which is why
//      the mismatch survived review: the two seams look symmetrical and are not.
//   2. `scout.world()` does not exist and never did. The scout's world reader is `blockAt`, and
//      pathfinding_utils' own header names this exact caller — "lanista's four-field adapter" — as the
//      worldless path it supports.
//   3. `computeAStar` is ASYNC. The un-awaited Promise has no `.path`, so even with 1 and 2 fixed every
//      box would have been reported unreachable — the silent version of the same failure.
//   4. the goal was a bare cell. An untyped goal now THROWS (a coding violation added because a bare
//      Vec3 made the heuristic 0 and the goal test never-true).
//   5. BOTH ENDPOINTS WERE FEET CELLS handed to a FLOOR-indexed graph, which is the one with the widest
//      blast radius. pathfinding_utils' header states the contract in its first lines ("y is the block
//      stood ON, not the feet cell"), arena_sites' seam header states the consequence ("silently searches
//      from the cell above the floor, which on open ground is air and yields 'unreachable everywhere'"),
//      and this adapter honoured neither. EVERY other computeAStar caller in the fleet converts first —
//      drop_collector, navigator — so the raw pass here was the lone holdout, not a house style. The
//      goal cell is air, so it is never a node and the goal can never pop; the frontier then floods open
//      ground until the cap and returns complete:false, landing every box in `unknownReach` with "search
//      incomplete" — a search that never finished, misread as ground with no route. The wrong turn to
//      skip: the refusal blames sightline and scout blindness, and moving the scout onto the fight cell
//      (a real fix, kept) changed the biome read and not one refusal.
//
// THREE BUCKETS, NOT TWO, and that is the whole reason the contract is `{ known, reachable }` rather
// than a boolean: a search stopped by its budget did not prove the ground impassable, it proved nothing.
// probePartners keeps unreachable and unknown-reach apart so a bench never lets "could not tell" satisfy
// "there is an arena here" (Law 23/25) — a boolean here would collapse them at the source.
//
// THE CAP IS THE WHY pathfinding_utils ASKS FOR: it removed its own default budget and left `maxNodes`
// as an opt-in for a caller with a real reason (a bench pinning a comparison) — this is that caller and
// that is the reason: siting runs one search per candidate box, dozens per wave,
// and a bench whose arena depends on how fast the machine ran is not reproducible. A bound in NODES is
// deterministic where a deadline in milliseconds is not, which is the opposite of what a body in a fight
// wants and exactly what a bench wants. It is a refusal bound, never a route bound: a box that needs more
// than this is declined, and declined boxes are reported as unproven (above), never as impassable ground.
const REACH_MAX_NODES = 4000;

// Feet cell → the block stood ON. The single conversion the two headers above both assign to this seam.
const floorOf = c => ({ x: c.x, y: c.y - 1, z: c.z });

function reachabilityFor(scout, maxNodes = REACH_MAX_NODES) {
  return {
    async check(fromFeet, toFeet) {
      const from = floorOf(fromFeet), to = floorOf(toFeet);
      // The four-field snapshot reader, not the live world: the same adapter arena_sites hands the box
      // sweep, so the gate and the footprint test read one world model (Law 16).
      const view = { blockAt: p => scout.blockAt(p), entity: { position: from } };
      let res;
      try {
        res = await pathfinding.computeAStar(view, from, { type: 'position', pos: to },
          { maxNodes, allowDig: false, allowPlace: false });
      } catch (e) {
        // A throw from the search is a CODING fault in this adapter (a malformed goal, a reader missing a
        // field), never terrain. Reported as unknown so the sweep refuses the box instead of recording it
        // as ground a mob cannot walk — an instrument fault must not read as a finding about the world.
        return { known: false, reachable: false, why: `search threw: ${e.message}` };
      }
      // Empty path = already there (the goal cell satisfies from the start node), which is reachable.
      if (res && res.path && !res.partial) return { known: true, reachable: true, nodes: res.nodesVisited };
      // A partial or a null that ran the frontier dry is a proven 'no route'; one that hit the budget is
      // an unfinished search wearing the same shape.
      const complete = !!(res && res.complete);
      if (!complete) return { known: false, reachable: false, why: `search incomplete (${res ? res.nodesVisited : 0}/${maxNodes} nodes)` };
      return { known: true, reachable: false, why: 'no world-preserving route' };
    },
  };
}

// siteMobCells — the whole of "place mob near bot", as one call.
//
// A RANGE MOVES THE BAND; IT DOES NOT FILTER IT. arena_sites' default annulus is 10–15 blocks, so asking
// for 3 b and then picking the closest cell out of that band returns a 10-block mob wearing a 3-block
// label — a silent substitution nothing downstream could catch. Widening to ±2 around the asked range is
// what makes the operator's number the thing actually searched for. Floor of 2: a mob inside 2 blocks is
// standing in the bot's own box, which is not a range, it is a collision.
//
// Both the asked range and the one the ground actually offered are returned, and the caller prints BOTH.
// A fight that asked for 15 b and got 9 b is a valid measurement of 9 b and an invalid measurement of
// 15 b, and only saying so keeps it from being read as the range that was asked for (Law 25).
//
// ── THE LIFT: THE MOB STANDS ABOVE THE BOT ──────────────────────────────────────────────────────────
// The mob stands higher than the bot by at least one bot-height so the bot's approach has to sprint-jump
// rather than walk, falling back to a normal raycast-confirmed cell when that is not available.
//
// TWO BLOCKS, because that is one bot: a body is 2 blocks tall, and "higher by at least one bot" is the
// height that forces the approach to climb rather than walk. A flat approach never presses the jump, so a
// ladder run on flat ground measures the swing and nothing about the locomotion underneath it — which is
// why this is a CONTROL and not a preference.
//
// PREFERENCE, NOT REQUIREMENT: the lift may fall back when the ground does not offer it. The lifted boxes
// are drawn from the pool that already passed the reach gate and the sightline cast, so a lifted cell is
// never a less-confirmed cell — it is a subset of the same confirmed set. If the subset is empty the full
// pool is used exactly as before. A run that had to fall back is still a valid run; it is a valid run of
// something else, so
// `liftGot` and `liftFellBack` ride out beside `rangeGot` for the same reason (Law 25 — asked and got,
// always both, or the row is labelled with a condition that did not hold).
// ── IT DOES NOT CHOOSE THE ANCHOR, AND THAT IS THE POINT (see siteArena below) ──────────────────────
// `botCell` arrives already decided. Two callers decide it two different ways and both are legitimate:
// `siteArena` hands it an anchor PROVEN to host an arena, and `lanista_ladder` hands it a hunt cell it
// wants elevation candidates around. What this function must never again be is the whole of siting for a
// wave — a caller passing the body's current position turns "where is there an arena" into "is the body
// already standing in one", which is a strictly harder question with no recourse when the answer is no.
//
// `cache` is optional and is a COST dial, never a correctness one: passing the cycle's cache back in
// makes the re-probe of an already-swept anchor read memos instead of re-casting. Omitting it changes
// nothing about the answer, only how long it takes to get.
async function siteMobCells(scout, botCell, want, range, lift = 0, cache = null) {
  const dials = { blueprint: SITING.blueprint, flatness: SITING.flatness };
  if (SITING.reachGate) dials.reach = reachabilityFor(scout);
  const band = range > 0 ? { minDistance: Math.max(2, range - 2), maxDistance: range + 2 } : {};
  const opts = { pace: PACE, ...dials, ...band, ...(cache ? { cache } : {}) };

  const opp = await arena.findOpponentSpawns(arena.readerFromScout(scout), botCell, opts);
  if (!opp.boxes.length) {
    // WHAT THE GROUND REFUSED ON, not merely that it refused. A bare "NOT RUN" could equally mean "the
    // body is down a mine shaft", "the chunks are not loaded" or "every cell is water" — three different
    // operator actions, and a line naming none of them leaves the operator guessing. The tally was
    // already in `scan.rejections`; only the printing was missing (Law 25 — a refusal must say why).
    const why = arena.formatRejections(opp.scan.rejections);
    return { cells: [], band: 0, pool: 0, refused: 0,
      detail: `no opponent box in the ${Math.max(2, range - 2)}–${range + 2}b band on this ground (${opp.scan.checked} cell(s) checked: ${why})` };
  }

  const split = await arena.partitionByLineOfSight(opp.boxes, botCell, sightlineFor(scout), opts);
  const pool = SITING.requireSightline ? split.visible : [...split.visible, ...split.hidden];
  const refused = split.unreachable.length + split.unknownReach.length;
  if (!pool.length) {
    // THE TWO WALLS ARE NAMED APART, and the feet-vs-floor round is why. "no route, or none found within
    // its search budget" is true of both buckets and identifies neither, so four live rounds read a
    // 100% `unknownReach` (an INSTRUMENT that never finished) as terrain that offered no arena. Split,
    // the first run says "0 proven impassable, 195 unfinished" — which points at the gate, not the
    // ground. A refusal that cannot say which wall it hit sends the next round to the wrong file (Law 25).
    const proven = split.unreachable.length, unproven = split.unknownReach.length;
    return {
      cells: [], band: opp.boxes.length, pool: 0, refused,
      detail: refused === opp.boxes.length
        ? `all ${opp.boxes.length} box(es) in the band failed the reach gate — ${proven} proven impassable, ${unproven} unproven (the search never finished)`
        : `${opp.boxes.length} box(es) in the band, ${refused} refused by the reach gate ` +
          `(${proven} impassable, ${unproven} unproven), none of the rest had a clear line`,
    };
  }

  // Nearest to the asked-for distance first, so a two-mob fight at 15 b puts both near 15 b. With no
  // range asked, spread across DIFFERENT bearings rather than stacked on one: the claim rule (one bot per
  // mob) and threat_scanner's nearest-first pick are both bearing-sensitive, so a stack on one bearing
  // tests neither. The pool arrives sorted nearest-first, so the stride is what puts mobs AROUND the bot.
  // The lift is applied HERE, after both gates, so it can only ever narrow an already-confirmed set —
  // never admit a cell the raycast refused. Empty subset → the full pool, and the fallback is recorded.
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
    // The lift the ground actually gave, measured on the cells that were CHOSEN rather than on the pool
    // they came from — the pool's best is not the number the fight happened at.
    liftGot: cells.length ? Math.min(...cells.map(c => c.y - botCell.y)) : null,
    liftPool: lifted.length,
    liftFellBack,
  };
}

// ── siteArena — FIND THE ARENA FIRST; THE BODY IS MOVED TO IT, NOT ASKED ABOUT ────────────────────────
// Siting works like a tuple: find a spot first without caring where the bot currently is, then teleport
// the bot to spot 1 and the monster to spot 2 — it should never fail to find a spot just because the
// body happens to be standing somewhere bad.
//
// WHAT THIS REPLACES AND WHY IT WAS WRONG. A wave used to be sited by calling `siteMobCells` with the
// body's CURRENT position as the anchor, so the bot's stand was an INPUT to the search. That makes the
// question "is the body already standing in an arena", and there is no recourse when the answer is no:
// the wave is refused and the trial is CUT. A body standing in dense forest canopy, for instance, can
// have every box in its band fail the reach gate — nothing wrong with the world, just treetop cells that
// cannot be walked between, and a sweep never allowed to look anywhere else. A CUT on those grounds
// measures where the bot happened to be, and reports it as a fact about the terrain (Law 25).
//
// NOTHING NEW IS BUILT HERE (Law 22 gate 2 — reuse, not invention). `arena_sites.findArenaPairs` is
// already the tuple cycle: an anchor is an ATTEMPT, a barren one ADVANCES the sweep instead of ending
// it, and the unit of success is the PAIR. It had tests and no production caller. This function is the
// call site it was missing.
//
// TWO PASSES, AND THE SECOND IS NOT A RE-SEARCH. Pass 1 asks the cheap question — is there an arena
// anywhere near the origin — and stops at the first partner it proves (`wantVisible: 1` inside the
// cycle). A wave of three mobs needs three boxes and a pool to sort them out of, so pass 2 re-probes the
// WINNING anchor for its whole band. The cycle's cache carries across, so every box, cast and route pass
// 1 already paid for is a memo hit: pass 2 costs the casts pass 1's early exit skipped and nothing else.
//
// THE ORIGIN IS A STARTING POINT, NOT A CONSTRAINT. It decides where the sweep begins and therefore which
// arena is found FIRST (nearest-first is ringScan's ordering, preserved through the cycle) — it does not
// decide where the fight is. That is what makes the operator's `--at` still meaningful without it being
// able to refuse a wave: authoring an origin steers the search, it no longer gates it.
async function siteArena(scout, origin, want, range, lift = 0) {
  const dials = { blueprint: SITING.blueprint, flatness: SITING.flatness };
  if (SITING.reachGate) dials.reach = reachabilityFor(scout);
  // THE GROUND DIAL IS PASSED HERE AND NOT TO `siteMobCells`. This is the pass that chooses WHERE the
  // arena is, so it is the only pass with anywhere else to go; the mob re-probe is anchored on a bot cell
  // already committed, and refusing its ground there would refuse a wave rather than move it.
  if (SITING.ground) dials.ground = SITING.ground;
  const band = range > 0 ? { minDistance: Math.max(2, range - 2), maxDistance: range + 2 } : {};
  const cache = arena.createSiteCache();

  const found = await arena.findArenaPairs(
    arena.readerFromScout(scout), origin, sightlineFor(scout),
    { pace: PACE, cache, pairs: 1, ...dials, ...band });

  // A refusal HERE is a statement about the REGION, which is the only kind of terrain refusal this bench
  // is now entitled to make. `describeShortfall` already names which wall the sweep hit — unusable
  // ground, walled bands or blocked sightlines — across every anchor it tried, not just one.
  if (!found.ok) {
    return {
      cells: [], botCell: null, band: 0, pool: 0, refused: 0,
      detail: `no arena anywhere the sweep could reach from ${fmt(origin)} — ${found.detail}`,
    };
  }

  const anchor = found.pairs[0];
  const botCell = { x: anchor.bot.x, y: anchor.bot.y, z: anchor.bot.z };
  const sited = await siteMobCells(scout, botCell, want, range, lift, cache);

  // NOT AN ENVIRONMENTAL FAILURE — the two passes ran against the same cache with the same dials, so pass
  // 2's pool is a superset of the partner pass 1 proved. An empty one means the two passes disagree about
  // the same ground, which is an instrument fault and must never be reported as terrain (Law 13).
  if (!sited.cells.length) {
    throw new Error(`[lanista] CODING VIOLATION: findArenaPairs proved a partner at the anchor ${fmt(botCell)} ` +
      `and the re-probe of the same anchor, on the same cache, found none — "${sited.detail}". ` +
      `The two passes cannot disagree; one of them is not asking what it says it asks.`);
  }

  return {
    ...sited,
    botCell,
    // Asked and got, for the anchor as well as the range (Law 25): how far the body had to be moved to
    // reach a fight, and how much ground the cycle had to try before it found one. A run whose arenas sit
    // 40 b out is a valid run of terrain nobody chose, and only these two numbers say so.
    originDistance: Math.round(anchor.originDistance * 10) / 10,
    arenaSite: anchor.site,
    anchorsTried: found.scan ? found.scan.checked : null,
  };
}

// ── Delivery: putting the mob there ─────────────────────────────────────────────────────────────────
//
// PersistenceRequired stops the summoned mob despawning mid-fight, which would otherwise show up as a
// bot that mysteriously stopped fighting. NoAI is NOT set: the whole point is a mob's real approach
// behaviour, and a frozen mob would make the counter's premise untestable.

function equipmentNbt(hand) {
  const id = hand.startsWith('minecraft:') ? hand : `minecraft:${hand}`;
  return `,equipment:{mainhand:{id:"${id}",count:1}}`;
}

// ── A SUMMONED MOB ARRIVES WITH NOTHING, AND THAT SILENTLY CHANGES WHAT ONE OF THEM *IS* ────────────
// `/summon minecraft:skeleton` produces a skeleton with NO equipment — verified by reading one back off
// this server. Natural spawning arms it; the command does not. A skeleton with no bow has no ranged
// attack at all: Java falls through to the melee goal, so it charges and bashes — an unarmed skeleton
// summon walks to contact and fights like a zombie, with no arrow ever created, while still reading as
// an archer match to anyone not checking its equipment.
//
// So `--hand` is READ BACK, never trusted: the wrong NBT form is accepted silently and returns the same
// "Summoned new Skeleton".
async function summonAt(rcon, mob, cell, hand) {
  const nbt = `{PersistenceRequired:1b,Tags:["${ARENA_TAG}"]${hand ? equipmentNbt(hand) : ''}}`;
  const reply = (await rcon.command(`summon minecraft:${mob} ${cell.x + 0.5} ${cell.y} ${cell.z + 0.5} ${nbt}`) || '').trim();
  const ok = !/failed|error|unknown|incorrect/i.test(reply);

  let armed = null, held = null;
  if (ok && hand) {
    // Matched on the mob nearest this cell rather than by tag alone, because every arena mob shares one
    // tag (that is what makes cleanup a single command).
    held = (await rcon.command(`data get entity @e[tag=${ARENA_TAG},type=${mob},limit=1,sort=nearest,x=${cell.x + 0.5},y=${cell.y},z=${cell.z + 0.5}] equipment`) || '').trim();
    armed = held.includes(hand.replace(/^minecraft:/, ''));
  }
  return { ok, reply, armed, held };
}

async function clearArena(rcon) {
  return rcon.command(`kill @e[tag=${ARENA_TAG}]`);
}

// ── THE WORLD'S OWN HOSTILES ────────────────────────────────────────────────────────────────────────
//
// `gamerule doMobSpawning false` stops NEW spawns and says nothing whatever about the ones already
// saved in the chunks a trial is about to load. Those two are not the same fact, and the bench spent a
// run treating them as one.
//
// Unpurged, a wave declared as ONE zombie can be fought alongside a crowd of the world's own hostiles
// standing nearby — a trial whose own banner says "the only mobs in this trial are the ones the ladder
// summons" while the bot actually dies to a swarm. Every number that run produces — time to kill, damage
// taken, repel breaches, the wave the ladder says first drew blood — measures the swarm and gets filed
// under a single zombie. That is Law 25 exactly: not a shortfall, a false verdict, and one that gets
// quieter the further downstream it travels.
//
// PURGED BY EXPLICIT TYPE, never `type=!player`. The bench authors the *fight*; it does not get to
// rearrange the world it borrowed. Animals, villagers, item frames, armour stands and dropped items are
// deliberately left standing — the trial must change what can hit the bot and nothing else.
//
// `tag=!ARENA_TAG` is belt-and-braces: the purge runs before the summons in both call sites, so the
// ordering alone would do it. The exclusion is there so a future caller that reorders them cannot
// silently delete the wave it just placed and then report an instantly-cleared field.
const AMBIENT_HOSTILES = [
  'zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin', 'zoglin',
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'silverfish', 'endermite',
  'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'breeze',
  'pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'vex',
  'piglin', 'piglin_brute', 'hoglin', 'blaze', 'ghast', 'guardian', 'elder_guardian', 'shulker',
];
// Wider than AGGRO_RANGE on purpose. AGGRO_RANGE is what the bot will ENGAGE; a mob standing just
// outside it walks in mid-wave and joins a fight the row does not name. Double it so the nearest thing
// the world owns starts a wave further away than it can close inside one.
const PURGE_RADIUS = AGGRO_RANGE * 2;

// Returns how many were standing there, because a purge that silently found 38 and a purge that found 0
// are different worlds and the row must be able to say which one it fought in (Law 6).
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
// A monster must only be spawned when the bot is in sentry mode — spawning immediately after a battle
// resolves is not a control, because the bot may still be mid-errand (spoils collection) rather than
// free to fight.
//
// WHAT IT COSTS TO NOT HAVE IT: a wave's mob can detonate or die, and the bot then runs its post-battle
// spoils errand while a bench that only watched the field empty calls the wave over and summons the next
// wave's mob onto a body that is not there to fight it. The next wave then opens on an unwatched body,
// takes damage with no engagement, and the ladder records a death on a wave that measured nothing —
// the mob never fought the bot at all (Law 25). A wave the watch was not holding must be REFUSED, never
// scored.
//
// IT WAITS BEFORE IT REFUSES, and that is the difference between a control and an obstacle. The watch
// becomes free on a transition this process cannot predict — the judge hands the signal back when the
// spoils finish — so a bench that asked once and gave up would refuse waves for its own timing. Waiting
// makes the ceiling the only failure: past it the bot is not busy, it is stuck, and that is a defect
// reading the round must report rather than absorb.
//
// READ THROUGH THE LENS, NEVER OFF THE FILE. Same discipline as observeFight's third completion, same
// reason: the journal has one reader, so the fact this bench needs became a function on the instrument
// (combat_lens.watchState) instead of a parser here (CLAUDE.md's monitor-is-the-interface clause, Law 26).
//
// THREE FACTS, NOT ONE, and the third is the one that catches wave 3 — see the lens's own header.
// `armed` is the operator's mode and stays true through every fight and errand; `engaged` goes false the
// moment the last mob resolves, which is BEFORE the spoils; `standing` is true only while a fresh watch
// loop is turning with no combat opened since, which is exactly "the body is free".
//
// 90s: long enough for drop_collector's whole collection window plus the walk home, so an ordinary spoils
// errand is waited out rather than called a fault.
const WATCH_WAIT_MS = 90000;
const WATCH_POLL_MS = 500;

const SCOUT_SEE_MS = 15000;
const SCOUT_POLL_MS = 400;

// awaitScoutSees — move the scout onto the fight cell, then prove it can READ that cell before anything
// downstream believes a terrain answer. Two acts, and both are required for a different reason.
//
// THE MOVE, because nothing else ever moved it: the scout joins at whatever position its playerdata
// holds and stays there for the whole run, while the bot is wherever autonomy left it. `y + 40` and not
// the cell itself — it is a spectator, so it cannot fall or suffocate, and a vantage above the ground
// loads the same column without ever standing inside a block the sweep is about to classify.
//
// THE PROOF, because `waitForScout`'s readiness is the wrong predicate for this question. It returns the
// scout's own spawn flag, which says a client exists; it says nothing about whether THIS column has
// arrived, and a chunk boundary is exactly what a teleport crosses. So the check is the read itself —
// ask for the block under the bot's feet and accept only a real answer (Law 23: verified against own
// perception, never inferred from a connection state that was true about somewhere else).
//
// A NULL here is genuinely ambiguous — unloaded chunk or void — and the ambiguity does not matter: both
// mean this client cannot answer questions about this place, which is the only thing the caller needs.
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
    // No journal at all is NOT "not armed", and the two demand opposite responses: one is a bot that has
    // not armed its watch, the other is a bot that is not running or is not the one named here (Law 25).
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
//
// Both halves are read off the SERVER: the bot's health from its NBT, the field from the tagged-entity
// count. `attributable` is the honest half of a cleared field — the mobs' total health FELL before they
// vanished. Without it, "the field is empty" and "the bot won" are the same sentence, and they are not.
//
// THAT FLAG WAS ITSELF WRONG UNTIL A CORRECTION, and the wrong turn is named because it reads correct: it
// compared the LAST total health against the first, and the last sample is the one where the field is
// empty — total health 0. So `mobHpEnd < mobHpStart` was true for every clearance including the ones it
// existed to catch. It now only counts health lost WHILE THE FIELD WAS STILL INTACT (count unchanged),
// the only window in which a drop can mean the bot landed a hit.
//
// `hpLostAfterClear` answers the creeper question the count alone cannot: a creeper that detonates dies,
// so the field empties and every earlier signal reads like a win. The blast lands AFTER the mob is gone,
// so one deliberate post-clear vitals read separates "the bot killed it" from "it killed itself on the
// bot" (Law 25).
// ── THE WAVE ENDS ON THE BATTLE, NOT ON THE CLOCK ───────────────────────────────────────────────────
// There is no wave timer — a wave ends upon completion of the battle, tracked directly rather than
// inferred from a clock.
//
// THREE completions, none of which waits for `ceilingMs`:
//   the bot died      — the death counter, checked first
//   the field emptied — the tagged-entity count reached zero
//   the bot said so   — `combat_lens.completedBattlesSince`, which is the case the first two cannot see
// The ceiling is the point past which a fight that has not completed is not a slow fight but a fight
// that is not happening — a DEFECT reading, which is why the ladder records it as `timeout`, not a result.
//
// ── THE THIRD ONE, AND WHY IT IS READ THROUGH A LENS ────────────────────────────────────────────────
// A deterministic reader like the trace monitor or combat monitor can answer this exactly as a human
// reading it would, so the fact is read the same way here rather than re-derived.
//
// The case it covers: a mob that walks out of the bot's tracking range is ALIVE and STILL TAGGED, so the
// field never empties and the wave burned the whole ceiling. Only the bot knows it disengaged.
//
// This process cannot ask the bot — separate process, and its report goes to the fleet's own judge. What
// it CAN do is read the bot's own record, and the standing rule is that a record has exactly one reader.
// So the lens gained a machine-facing function and this bench calls it. No throwaway parser was written
// here, and that is the whole discipline: if the monitor cannot answer, the monitor is what changes.
//
// THE DIVISION OF LABOUR IS EXACT AND MUST STAY THAT WAY (Law 26): the bot's lines are CLAIMS about what
// it decided; the server is the contradicting voice.
// So the claim may end the WAITING — the bot is the only witness to a disengage — and it may not decide
// the OUTCOME. Every number this function returns is still read off the server, exactly as before. A
// version that let the bot's `outcome` field become the wave's verdict would be the counter grading its
// own paper, which is the one thing that law forbids outright.
//
// DEGRADES TO THE OLD BEHAVIOUR, SAID OUT LOUD. No trace (bot not running, name mismatch, disk refused
// the file) means this completion is simply unavailable and the other two still work. It is announced
// once per wave rather than left silent, because "no battle was reported" and "nothing could report"
// look identical from here and demand opposite responses (Law 25).
// ── THE STALL, AND WHY IT IS A FOURTH BREAK RATHER THAN A SHORTER CEILING ──────────────────────────
// A stall means the bot does not engage the mob within a bounded timeframe, and it must tear the wave
// down rather than run it out to the ceiling.
//
// The ceiling above already catches a wave that never finishes; it cannot tell WHY. A fight that ran the
// full ceiling trading blows and a bot that stood still the whole time beside a zombie both land on
// `timeout`, and the two demand opposite responses — the first is a hard wave, the second is a bench that
// is not working. Folding them together is the same shape of fault the detonation correction fixed
// elsewhere: a true word attached to a fight it does not describe (Law 25).
//
// ENGAGEMENT IS READ AS AN EXCHANGE OF DAMAGE, off the server, on samples this loop already takes: the
// mobs' total health fell, or the bot's did. Nothing else counts — not proximity, not the bot's own
// claim, not a swing animation. That keeps the measurement on the same footing as every other number
// here (Law 26: the server is the voice that contradicts).
//
// WHY NOT ASK THE BOT, given the lens is already wired in one break below: the trace reports a
// COMPLETED battle, and a stall is the absence of one starting. The bot is also the party under test, so
// "did you engage" is the one question it must not be the witness for.
//
// stallMs = 0 DISABLES IT, and that is not a default — every caller that has a stall number passes it.
// The zero exists so `lanista.js` run directly (a single authored fight, an operator watching it) is
// unchanged: an operator staring at a fight does not need a machine to tell them nothing is happening.
async function observeFight(rcon, botName, ceilingMs, stallMs = 0) {
  // Zeroed here rather than trusted: this counts deaths IN THIS ROUND.
  await ensureDeathCounter(rcon);
  await rcon.command(`scoreboard players set ${botName} ${DEATH_OBJECTIVE} 0`);
  const t0 = Date.now();
  const until = t0 + ceilingMs;
  let hpStart = null, hpEnd = null, minHp = Infinity;
  let mobsStart = null, mobsEnd = null, mobHpStart = null, mobHpLowIntact = Infinity;
  let botDied = false, fieldCleared = false, unreadable = 0, samples = 0, deaths = 0;
  // When damage was first exchanged either way, or null if it never was. `stalled` is that null still
  // standing when the stall window closes — a wave that was set up and then did not happen.
  let engagedAt = null, stalled = false;
  // The bot's own report of a finished battle, or null if it never made one. Read through the lens, never
  // off the file — see the header.
  let reportedBattle = null;
  // Whether the bot's trace exists at all, checked once at the top rather than inferred from silence
  // later. It reads the trace and not a journal since 2026-08-22 — same lens, same function, and the
  // record it folds moved onto the bot's own watcher story with everything else the bot says about
  // itself.
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

    // Read BEFORE the three completion breaks, so a wave that engaged and finished inside one sample is
    // still recorded as having engaged. Ordered after `hpStart` is set, because the first sample is the
    // baseline and cannot be a drop from itself.
    if (engagedAt === null
        && ((mobHpStart != null && field.totalHealth < mobHpStart) || v.health < hpStart)) {
      engagedAt = Date.now();
    }
    // The stall break sits above the completions on purpose: none of them can fire while nothing is
    // happening, so ordering between them never arises — what the position buys is that a stalled wave
    // exits on the sample that proves it rather than waiting out the rest of the ceiling.
    if (stallMs && engagedAt === null && Date.now() - t0 > stallMs) { stalled = true; break; }
    // Checked BEFORE the cleared test: a bot that died to the last mob standing must not be reported as
    // having cleared the field on the tick the mob also despawned. `deaths` is what actually catches it;
    // `!v.alive` only catches the rare sample landing inside the death window.
    if (deaths >= 1 || !v.alive) { botDied = true; break; }
    // The 3s floor is not politeness — a summoned mob takes a tick or two to exist, and without it every
    // round would 'clear' on its first sample.
    if (field.count === 0 && Date.now() - t0 > 3000) { fieldCleared = true; break; }
    // THE BOT'S OWN REPORT, checked LAST of the three. Ordering is the ruling, not a preference: the two
    // server reads above are observations and this one is a claim, so a wave that both cleared the field
    // and got reported is recorded as the server saw it (Law 26 — the observation outranks the claim
    // where they overlap). This break exists for the case the server cannot see at all.
    if (traceReadable) {
      const reported = combatLens.completedBattlesSince(t0, { bot: botName });
      if (reported.length) { reportedBattle = reported[reported.length - 1]; break; }
    }
    await sleep(400);
  }

  // 1200 ms because a creeper's blast resolves on the tick it dies and the server's health NBT settles
  // within a few ticks; anything shorter races the damage this read exists to catch.
  let hpAfterClear = null;
  if (fieldCleared) {
    await sleep(1200);
    const after = await readBotVitals(rcon, botName);
    if (after.known) hpAfterClear = after.health;
    // ── THE SERVER SAYS *THAT* THE FIELD EMPTIED; ONLY THE BOT SAYS *HOW* ─────────────────────────
    // The loop above breaks on the server's field-empty read BEFORE the journal is ever polled, and that
    // ordering is correct — the observation outranks the claim about the OUTCOME. But it left
    // `reportedBattle` null on every wave the server ended, which is nearly all of them, so the
    // detonation guard in `headline` had no data and never fired once.
    //
    // A creeper that detonates close enough to be read as `detonated` and `killed 0` by the lens would
    // otherwise print as "✅ field cleared BY THE BOT" — every number underneath true, the verdict false,
    // and false in the flattering direction (Law 25).
    //
    // A detonation empties the field, so the blast lands BEFORE this read rather than after it — which
    // is why `hpLostAfterClear` cannot catch it and why nothing here can be inferred from health. Read
    // through the lens, never off the file. This does not re-decide `fieldCleared`; it only names which
    // bodies left and how.
    if (traceReadable && !reportedBattle) {
      const reported = combatLens.completedBattlesSince(t0, { bot: botName });
      if (reported.length) reportedBattle = reported[reported.length - 1];
    }
  }

  const damagedWhileIntact = mobHpStart != null && mobHpLowIntact !== Infinity
    ? round2(mobHpStart - mobHpLowIntact) : null;

  return {
    botDied, fieldCleared,
    // Carried BESIDE the other outcomes, never folded into one of them: a stalled wave is not a timeout
    // (the clock is not what ended it) and not a defeat (nothing was fought). `engagedMs` is on the row
    // so a wave that engaged slowly and one that engaged instantly are distinguishable after the fact —
    // the stall flag only says which side of the line it fell, and the line was authored, not measured.
    stalled, engagedMs: engagedAt === null ? null : engagedAt - t0,
    hpStart, hpEnd, minHp: minHp === Infinity ? null : minHp,
    hpLost: hpStart != null && hpEnd != null ? round2(hpStart - hpEnd) : null,
    mobsStart, mobsEnd, mobHpStart,
    mobDamageDealt: damagedWhileIntact,
    attributable: damagedWhileIntact == null ? null : damagedWhileIntact > 0,
    hpAfterClear,
    hpLostAfterClear: hpAfterClear != null && hpEnd != null ? round2(hpEnd - hpAfterClear) : null,
    deaths, samples, unreadable, ms: Date.now() - t0,
    // The bot's side, carried BESIDE the server's numbers and never folded into them. A reader can see
    // both voices on one row and tell a disagreement from an agreement, which is the entire reason the
    // outside voice matters (Law 26). `null` means the bot reported nothing, and `traceReadable: false`
    // means it could not have.
    traceReadable,
    reportedBattle,
    // Named here so the headline and the ladder do not each re-derive them from `reportedBattle`.
    reportedKilled: reportedBattle ? reportedBattle.killed.map(e => `${e.name}#${e.id}`) : [],
    reportedDisengaged: reportedBattle ? reportedBattle.disengaged.map(e => `${e.name}#${e.id}`) : [],
    // The server's own explosion packet, read through the lens. The headline used to catch a detonation
    // only via `hpLostAfterClear` — an inference that misses every blast the bot was standing far enough
    // away from to take no damage from, which is most of them at typical creeper detonation ranges.
    reportedDetonated: reportedBattle ? reportedBattle.detonated.map(e => `${e.name}#${e.id}`) : [],
    reportedUntouched: reportedBattle ? reportedBattle.untouched.map(e => `${e.name}#${e.id}`) : [],
  };
}

// ── One wave ────────────────────────────────────────────────────────────────────────────────────────
//
// Place the body (if the caller authored a cell) → gate on the biome → site → summon every group →
// check the bot can actually see the fight → wait → clear. Anything this function refuses to run is
// reported as NOT RUN with its reason, never as a round that happened and went badly (Law 25) — the
// ladder above it depends on that distinction absolutely, because a wave the terrain could not host and
// a wave the bot lost look identical in any count that folds them together.
//
// THE BODY IS RE-PLACED PER WAVE WHEN A CELL IS AUTHORED, not once per trial. A bot that chased wave 3's
// skeleton forty blocks would fight wave 4 on ground nobody chose, at a range nobody asked for, in
// possibly a different biome — three controls lost to one chase. Re-placing costs a teleport and keeps
// every wave in the ladder comparable to every other. It does NOT heal or re-kit: attrition across the
// waves is the thing being measured.
// ── standBot — GET THE BODY ONTO THE SPOT AND THE EYES ONTO THE BODY. Everything before a summon. ────
//
// Spawning happens at the beginning of the trial, not the end: spawn, teleport to spot, spawn monster,
// in that order.
//
// This is the sequence, and extracting it is what lets it run at the BEGINNING. Left inline at the top of
// runWave and nowhere else, the first thing that ever stood the bot up would be wave one — and every gate
// in it (a watch that will not come free, a body the server will not answer for, a scout that cannot see
// the ground, a biome that is not the declared one) would fail AFTER the trial had announced itself and,
// in the archer case, after the summons had already been spent. `main` runs it once before the round
// loop, so a trial that cannot be set up says so before it is a trial.
//
// IT IS STILL RUN PER WAVE, and that is not redundancy (Law 16 — one implementation, two call sites, and
// the second is a control rather than a retry). The header on runWave has the reason: waves 2-5 are
// fought at the same cell only if nothing moved the body, and a bot that chased wave 3's mob forty blocks
// would otherwise fight wave 4 on ground nobody chose, at a range nobody asked for, possibly in another
// biome. When nothing has moved it, the re-run is a teleport to where it already stands and costs a
// round-trip. The OPENING call is what makes the sequence run in this order; the per-wave call is what
// keeps it true for the rest of the trial.
//
// Returns `{ ok:false, reason }` in the same vocabulary runWave reports NOT RUN in, so both callers hand
// the operator one sentence and neither has to invent phrasing for a failure it did not diagnose.
async function standBot(scout, rcon, args, label) {
  // FIRST, BEFORE ANYTHING TOUCHES THE BODY. Placement teleports the bot, and teleporting one that is
  // mid-errand is itself the disturbance this gate exists to prevent — so the watch is waited on before
  // anything is allowed to move it. See awaitStandingWatch's header for what it cost to summon without
  // this.
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

  // THE SCOUT HAS TO BE AT THE FIGHT, AND HAS TO PROVE IT CAN SEE IT. Every terrain read the bench makes
  // comes from the scout's client — the biome, the box sweep, the sightline casts — and a client that has
  // not received the chunk answers `null` for every cell, which Law 23 correctly refuses as "cannot
  // tell". The operator then reads a fully-working bench reporting terrain that does not exist.
  //
  // The scout otherwise joins wherever its own saved playerdata position happens to be, arbitrarily far
  // from the bot — every cell in a sweep then reads "chunk unloaded" for a scout that was never moved.
  // If the stale position happens to be inside view-distance, the chunks can eventually arrive on their
  // own timing, which is the worse failure mode: not a clean refusal but a race the bench sometimes wins,
  // on a survey whose answer changes with the latency.
  if (!await awaitScoutSees(scout, rcon, cell)) {
    return { ok: false, reason: `the scout cannot see ${fmt(cell)} after ${Math.round(SCOUT_SEE_MS / 1000)}s — it was moved there and the chunk never arrived, so every terrain read would be a guess (nothing was summoned)` };
  }

  // THE BIOME GATE. It runs at the cell the fight will actually happen on rather than once at setup — the
  // body may have been dragged out of the declared biome by an earlier wave's chase, and a row labelled
  // `plains` for a fight fought in a forest is the quiet kind of wrong that survives into every aggregate
  // built on it afterwards (Law 25).
  const biome = readBiome(scout, cell);
  if (args.biome && args.biome !== 'any') {
    if (biome === null) return { ok: false, reason: `the scout cannot read the biome at ${fmt(cell)} — the column is not loaded, so the control is unverified` };
    if (biome !== args.biome) return { ok: false, reason: `the fight cell is '${biome}', not the declared '${args.biome}' — the body has left its own experiment` };
  }

  // AFTER the placement and BEFORE the siting. The placement is what loads the chunks around the stand,
  // and a chunk loading is exactly when the hostiles saved inside it come back — so a purge done any
  // earlier clears a neighbourhood the fight was never in. Re-run every wave rather than once per trial:
  // waves 2-5 are fought at the same cell, but the bot's own chase drags the loaded frontier around and
  // a wave that starts clean can be joined by the world halfway through the ladder.
  const ambient = await purgeAmbientHostiles(rcon, cell);
  if (ambient) log('purge', `${label}: ${ambient} hostile(s) the world owned were standing within ${PURGE_RADIUS}b of the fight cell — removed before the wave was placed.`);

  return { ok: true, cell, biome, ambient };
}

// ── sweepOrigin — WHERE THE SEARCH STARTS. Not where the fight is. ──────────────────────────────────
//
// Everything that has to be true before `siteArena` can read ground, and nothing that has to be true
// before a fight. The distinction matters because the body's position used to BE the fight cell, so
// every gate on it was load-bearing; it is now the seed of a sweep, so the only requirement is that the
// scout can see the ground there.
//
// The BODY IS NOT MOVED HERE, even when `--at` is authored. The scout does the reading, so an authored
// origin only needs the scout at it — teleporting the bot to a cell the sweep may well reject would be a
// placement nothing asked for, and would put the watch gate a whole sweep away from the teleport it
// exists to protect (standBot re-takes it at the moment of the real placement, Invariant B).
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

  // Same reason standBot waits on this, one step earlier in the sequence: a scout that has not received
  // the chunk answers `null` for every cell, and a sweep run against that reports "no arena in the
  // region" about a region nobody looked at (Law 23 — unread is not empty).
  if (!await awaitScoutSees(scout, rcon, cell)) {
    return { ok: false, reason: `the scout cannot see ${fmt(cell)} after ${Math.round(SCOUT_SEE_MS / 1000)}s — the chunk never arrived, so the arena sweep would be reading nothing (nothing was summoned)`, cause: 'bench' };
  }
  return { ok: true, cell };
}

// EVERY REFUSAL BELOW CARRIES A `cause`, AND THE THREE ARE NOT INTERCHANGEABLE. A refused wave returning
// only prose would fold every refusal into one exit code meaning "the ground ended it", which would tell
// the operator that a re-run on different ground may well work even for a wave whose own reason was a
// STALL in the bot — sending them round the loop re-rolling terrain to fix a body instead. Law 25 — the
// caller acts differently on each, so the caller must be able to tell them apart without parsing English.
//
//   terrain  the ground could not host it. Different ground may well work — a re-run is worth it.
//   bot      the body was not fit to fight (watch never stood down, dead, unreachable). Re-rolling
//            terrain changes nothing; the fleet is what needs looking at.
//   bench    the server or the summon itself refused. Neither the ground nor the bot is implicated.
async function runWave(scout, rcon, args, n) {
  const wave = args.wave;
  const want = wave.reduce((s, g) => s + g.count, 0);

  // THE ORDER IS THE FIX. Find the arena, THEN move the body into it. The old order stood the body first
  // and sited around it, which let one bad stand refuse a wave the world could host — see siteArena's
  // header for why.
  const origin = await sweepOrigin(scout, rcon, args, `wave ${n}`);
  if (!origin.ok) return { run: false, reason: origin.reason, cause: origin.cause };

  const sited = await siteArena(scout, origin.cell, want, args.range, args.lift);
  if (!sited.cells.length) return { run: false, reason: sited.detail, cause: 'terrain', band: sited.band, refused: sited.refused };

  // Spot 1. Every gate standBot owns — the watch, the landing, the scout's view, the biome, the purge —
  // now runs at the cell the fight is on rather than at the one the search started from. `at` is
  // overridden rather than passed through: an authored `--at` steered the sweep, and the sweep's answer
  // is what the body is placed on (Law 16 — one placement, and the arena decides it).
  const stand = await standBot(scout, rcon, { ...args, at: sited.botCell }, `wave ${n}`);
  if (!stand.ok) return { run: false, reason: stand.reason, cause: stand.cause || 'bench' };
  const { cell, biome, ambient } = stand;

  // The sited cells are spent IN ORDER across the groups, so a mixed wave arrives spread across the same
  // bearings a single-species wave of the same size would have used. Doing it per group instead would
  // hand every group the same nearest cell and stack the whole wave on one bearing — which tests neither
  // the claim rule nor threat_scanner's nearest-first pick.
  const placed = [];
  const unarmed = [];
  const stacked = new Map();   // cell key → how many mobs have already been summoned onto it
  let next = 0;
  for (const g of wave) {
    // ── ONLY CELLS THE BOT CAN ACTUALLY SEE THIS MOB FROM ───────────────────────────────────────────
    // A pool with no cell inside the bot's own radius should spawn multiple mobs on one spot rather than
    // reach for ground the bot cannot see — spaced apart so each has time to move before the next lands.
    //
    // The old `% sited.cells.length` wrap spent every sited cell in order, including ones outside the
    // radius the bot honours for that species — so a wave with four mobs and one distant cell was REFUSED
    // by the presence gate below rather than run, even though the ground had room and the bench was just
    // insisting on using all of it.
    //
    // So the pool is filtered to what the bot can see FIRST, and a short pool is reused rather than
    // widened. Per species, because the radius is: `aggroRangeFor` is architect_config's one route and a
    // skeleton is honoured further than a zombie.
    // ── THE FILTER MUST BE TIGHTER THAN THE GATE, AND THIS IS WHY ───────────────────────────────────
    // A filter using exactly the gate's own threshold can still pass a cell the gate then refuses. They
    // are not measuring the same thing: `c.distance` is cell-centre to the bot's SITED CELL, while the
    // gate measures the summoned mob to the bot's LIVE POSITION read back off the server after it stands.
    // Cell centring, the floor's y, and the body's own settle all sit between them. A filter that matches
    // the gate exactly therefore passes cells that land on the wrong side of it by centimetres.
    // ── AND IT MUST MEASURE THE SAME SHAPE THE GATE DOES ────────────────────────────────────────────
    // An earlier cut of this filter compared `c.distance` — which is FLAT, x/z only — against a gate that
    // measures the real 3D line from the bot to the mob. On flat ground the two agree and the bug is
    // invisible. On relief they do not: a cell that is, say, 12b across and 10b down is only 12b by the
    // flat measure but sqrt(12² + 10²) ≈ 15.6b to the gate — a drop the filter cannot see is a drop the
    // sort walks straight into, refusing a cell the filter and sort had both just called BEST. So the
    // drop is measured here, from the cell the body actually stands on, and the same figures drive both
    // the filter and the order (Law 16 — one measure of range, and it is the one the gate uses).
    // ── AND THE GATE IS A CYLINDER ───────────────────────────────────────────────────────────────────
    // A 3-D hypot is correct against a spherical gate and wrong against a cylindrical one, in the
    // direction that COSTS ROUNDS: it would refuse a cell far across but only modestly down that the bot
    // fights from perfectly well — the bench's own arithmetic overruling the construct's. Both axes are
    // checked the way the gate checks them, and the SORT still uses the 3-D figure because "nearest" is a
    // real distance whatever shape admitted it.
    const dropTo = (c) => ((cell && typeof cell.y === 'number' && typeof c.y === 'number') ? (c.y - cell.y) : 0);
    const flatTo = (c) => (typeof c.distance === 'number' ? c.distance : Infinity);
    const gapTo = (c) => (Number.isFinite(flatTo(c)) ? Math.hypot(flatTo(c), dropTo(c)) : Infinity);
    const radius = aggroRangeFor(g.mob) - AGGRO_SITE_MARGIN;
    const inRange = sited.cells.filter(c =>
      flatTo(c) <= radius && Math.abs(dropTo(c)) <= AGGRO_VERTICAL_RANGE - AGGRO_SITE_MARGIN);
    // No cell at all inside the radius is a TERRAIN answer, not something to paper over. Fall through to
    // the full list and let the presence gate refuse the round by name — silently summoning at 20 b would
    // produce a clean round measuring a fight that never happened (Law 25).
    // Nearest first, so a pool shorter than the wave spends its BEST cells and repeats those rather than
    // reaching for the outermost ring it was given. When `inRange` is empty the sort is what gives the
    // round its best remaining chance: the presence gate may still refuse it, but it will be refused on the
    // closest ground the terrain had rather than on an arbitrary one.
    const byGap = (a, b) => gapTo(a) - gapTo(b);
    const pool = (inRange.length ? inRange : sited.cells.slice()).sort(byGap);
    for (let i = 0; i < g.count; i++) {
      const c = pool[next++ % pool.length];
      const key = `${c.x},${c.y},${c.z}`;
      const already = stacked.get(key) || 0;
      // Two mobs summoned into one cell on the same tick is one mob and a rejected summon, or two bodies
      // resolving their overlap by shooting apart. The gap is what lets the first one WALK OFF the cell
      // before the second arrives, giving the monster time to move.
      if (already > 0) await sleep(STACKED_SUMMON_GAP_MS);
      stacked.set(key, already + 1);
      const r = await summonAt(rcon, g.mob, c, g.hand);
      // The 3D gap, not the flat one — this number is read next to the presence gate's refusal, and the
      // two must agree or a mismatched pair of figures sends the diagnosis down the wrong hole.
      if (r.ok) placed.push({ mob: g.mob, cell: c, distance: round2(gapTo(c)), armed: r.armed });
      // A mob asked to carry something and not carrying it is a DIFFERENT OPPONENT, and the round is then
      // measuring a fight it does not name. Collected rather than thrown so the round still records what it
      // saw — but it is not run, because a bow-less skeleton produces a clean, complete, entirely
      // misleading archer result (Law 25).
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
    // Asked-vs-got, always both. A round that asked for 15 b and got 9 b measured 9 b, and printing only
    // the asked number would label the reading with a range nobody stood at (Law 25).
    (sited.rangeAsked ? ` — asked ${sited.rangeAsked}b, got ${sited.rangeGot}b${Math.abs(sited.rangeGot - sited.rangeAsked) > 1.5 ? ' ⚠ THE TERRAIN DID NOT HAVE THE RANGE' : ''}` : ''));
  // WHERE THE ARENA CAME FROM, on its own line. The bot's stand is now chosen by the sweep rather than
  // inherited, so how far it was moved and how many anchors were tried to get there is the difference
  // between "the first cell worked" and "the region nearly had nothing" — invisible in any other row.
  // `arenaSite` is arena_sites.describeSite's OBJECT ({tags, relief, notes}), never a string — printed raw
  // it reads as "[object Object]" and silently throws away the one line that says whether the ground is
  // flat, forested or roofed. That matters because a ladder tunes attack, not pathfinding, so an open
  // biome with no obstacles in the way is the point of asking for one — hence rendering it in full.
  const siteLabel = sited.arenaSite && sited.arenaSite.tags && sited.arenaSite.tags.length
    ? `${sited.arenaSite.tags.join('/')} — ${sited.arenaSite.notes}`
    : (sited.arenaSite && sited.arenaSite.notes) || 'unlabelled ground';
  log('round', `  arena ${fmt(sited.botCell)} on ${siteLabel} — ` +
    `${sited.originDistance}b from the sweep origin ${fmt(origin.cell)}, ${sited.anchorsTried == null ? 'an unrecorded number of' : sited.anchorsTried} anchor(s) tried`);
  // The lift is a control, so it is stated on its own line whether it held or not. A fallback is not a
  // failure and is not printed as one — it is a different experiment, and it says which.
  if (sited.liftAsked) {
    log('round', sited.liftFellBack
      ? `  ⚠ LIFT FELL BACK — no confirmed box stood ≥${sited.liftAsked}b above the bot, so this wave is FLAT (mob ${sited.liftGot >= 0 ? '+' : ''}${sited.liftGot}b). The sprint-jump is not under test here.`
      : `  lift asked ≥${sited.liftAsked}b, got +${sited.liftGot}b — ${sited.liftPool} of ${sited.pool} confirmed box(es) stood high enough. The approach has to climb.`);
  }

  // PRESENCE, CHECKED AFTER THE SUMMON AND BEFORE THE CLOCK. The one question that must be answered
  // before an outcome means anything: is the bot close enough for a fight to be possible at all?
  // AGGRO_RANGE is the construct's own threshold, read from its config rather than restated, so the
  // bench and the bot cannot disagree about what "in range" means (Law 16). A round failing this is NOT
  // RUN — reporting it as a timeout would blame the counter for the director's bookkeeping.
  //
  // PER SPECIES, not against one flat radius. Each placed mob is measured against the radius the BOT
  // honours for that species — `aggroRangeFor`, architect_config's one route — so a skeleton at some
  // range passes because the bot genuinely sees it while a zombie at the same range does not because the
  // bot genuinely does not. A flat test would refuse both, which is a bench refusing rounds on its own
  // arithmetic rather than on the construct's.
  //
  // MEASURED AS A CYLINDER, matching the gate's own shape — a 3-D compare here would refuse a round the
  // bot would have fought, which is the same "bench refusing on its own arithmetic" fault the paragraph
  // above records, one axis further in.
  const atSummon = await readBotVitals(rcon, args.bot);
  const gapTo = p => Math.hypot(p.cell.x + 0.5 - atSummon.position.x, p.cell.y - atSummon.position.y, p.cell.z + 0.5 - atSummon.position.z);
  const seenBy = (p) => Math.abs(p.cell.y - atSummon.position.y) <= AGGRO_VERTICAL_RANGE &&
    Math.hypot(p.cell.x + 0.5 - atSummon.position.x, p.cell.z + 0.5 - atSummon.position.z) <= aggroRangeFor(p.mob);
  const unseen = atSummon.known && atSummon.position
    ? placed.map(p => ({ p, gap: gapTo(p), radius: aggroRangeFor(p.mob), seen: seenBy(p) })).filter(x => !x.seen)
    : placed.map(p => ({ p, gap: Infinity, radius: aggroRangeFor(p.mob), seen: false }));
  // ANY mob out of its own radius fails the round, not just the nearest one. A wave whose second zombie
  // stands at 17 b is a wave the bot fights one mob of, and reporting it as a two-mob round is the count
  // that quietly poisons every aggregate built on it (Law 25).
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
    // On the row because a wave that had to remove a crowd of the world's own hostiles and a wave that
    // removed none were fought in different worlds, and only one of them is comparable to the rest.
    ambientPurged: ambient,
    rangeAsked: sited.rangeAsked, rangeGot: sited.rangeGot,
    liftAsked: sited.liftAsked, liftGot: sited.liftGot, liftFellBack: sited.liftFellBack,
    // The bot's own standing elevation, carried on the row because it is the trial-level control that
    // the bot stands at a different elevation every time. Read off the body at the moment the wave
    // opened, never inferred from the cell the ladder asked for.
    standY: cell.y,
    ...outcome,
  };
}

// The headline states WHAT WAS MEASURED, not what would be nice to report. A field that emptied with no
// damage dealt is called out as unattributable rather than printed as a win. A DETONATION is the outcome
// that looks most like one: a creeper that explodes dies, so the count reaches zero and the bot has
// usually damaged it on the way there — which reads as '✅ field cleared BY THE BOT' with every underlying
// number true and the verdict false (Law 25), unless it is named for what it is.
// ONE DECIDER FOR "HOW DID THIS WAVE END", read by both the sentence a human sees and the word the
// ledger keeps. Two separate deciders can disagree — `headline` saying "MOB DETONATED" while the ledger's
// own mapper still infers the detonation from `hpLostAfterClear`, which reads 0 when the blast lands
// INSIDE the wave rather than after it, and prints "cleared" instead. Law 16: if I delete this, does
// something else silently do the same job? A second decider does, and being silent is what lets the two
// answers drift apart.
//
// The words are the LEDGER's vocabulary, not this file's, because the ledger is the one that has to
// still read them in a year. `disengaged` and `unattributable` are outcomes the ledger has no column
// for and buckets under `timeout` — that is unchanged behaviour and deliberate: they belong in the
// "neither a win nor a loss" bucket, and a true word in the row beats a convenient one, even where
// nothing yet counts it separately (Law 25).
function waveVerdict(r) {
  if (r.botDied) return 'died';
  // A stall says the wave never happened, so it outranks every reading of a fight.
  if (r.stalled) return 'stalled';
  if (!r.fieldCleared) return r.reportedBattle ? 'disengaged' : 'timeout';
  // The server's own announcement first, the health inference second — a blast the armour ate is
  // invisible to `hpLostAfterClear` and was reported as a clean win until the explosion witness landed
  // (Law 23: sensing outranks derived reading).
  if (r.reportedDetonated.length || r.hpLostAfterClear > 0) return 'blown';
  if (r.attributable) return 'cleared';
  return 'unattributable';
}

function headline(r) {
  // A RENDERER over `waveVerdict`, never a second decider. The ordering that used to live in this chain
  // is up there now; what is left here is one sentence per outcome and the two the ledger cannot tell
  // apart. Ranked-by-order was the shape that let it drift from the ledger — do not reintroduce a test
  // here that the verdict does not make.
  switch (waveVerdict(r)) {
    case 'died':
      return `💀 BOT DIED (${r.deaths}× this round)`;
    // Named a DEFECT out loud so no reader has to infer it from a zero.
    case 'stalled':
      return `🚫 STALL — no damage exchanged either way in ${Math.round(r.ms / 1000)}s. The wave was set up and never happened; this measures the BENCH, not the bot`;
    // The wave ended for a reason the server could not see: the mob left and the bot said so. It used to
    // run to the ceiling and print '⏱️ timed out' — true about the clock, false about the fight.
    case 'disengaged':
      return `🚶 DISENGAGED — the bot reports the battle over with the field still standing` +
        `${r.reportedDisengaged.length ? ` (${r.reportedDisengaged.join(', ')} walked)` : ''}` +
        `${r.reportedKilled.length ? `, ${r.reportedKilled.join(', ')} killed` : ''}`;
    case 'timeout':
      return '⏱️  timed out';
    // The only place the two detonation ROUTES still part company, and only in the wording: which body,
    // named by the server, versus how much of it the bot had taken off first. Same verdict either way.
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

// waitForScout: proves the scout SPAWNED, and nothing more. Polling beats a fixed sleep — a fixed sleep
// is a guess about someone else's latency, and when it is wrong the run dies on a connection that was
// not up yet.
//
// IT DOES NOT PROVE CHUNKS, and treating it as though it did lets a round survey a world the scout
// cannot actually see. `isReady()` is the scout's spawn flag; chunk arrival is a per-column fact that
// changes every time anything teleports. The place to ask it is the place that knows which column —
// `awaitScoutSees`, called by runWave once the fight cell is known.
async function waitForScout(scout, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (scout.isReady()) return true;
    await sleep(500);
  }
  return false;
}

// cleanupOnly — the one verb that must work when everything else is broken, because the state it removes
// is exactly what a broken run leaves behind (Law 8). It needs no scout.
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

// openArena — connect the scout, open RCON, author the world, clear the field. ONE implementation,
// because the ladder needs the identical setup and a second copy of it would be a second definition of
// "the world a fight happens in" (Law 16) — the exact drift `WORLD` was centralised to prevent.
//
// Returns { ok:false, why } rather than throwing: both callers are operator-facing commands that owe a
// sentence, and a stack trace for "the server is not up" is not one.
async function openArena({ quiet = false } = {}) {
  const scout = createScout({
    host: '127.0.0.1', port: 25565, version: '1.21.5', username: SCOUT_NAME,
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

  // Park the scout in spectator so it cannot fall, die, take a mob's attention, or appear in frame.
  await rcon.command(`gamemode spectator ${SCOUT_NAME}`);
  const world = await applyWorld(rcon, WORLD);
  if (!quiet) {
    log('world', `${world.time}, ${world.difficulty}, daylight cycle ${world.cycle} — ` +
      `asked for ${WORLD.time}/${WORLD.difficulty}. Skeletons and zombies do not burn here.`);
    // Printed rather than assumed: a reader comparing this rung to an older one needs to know the ground
    // stopped being destroyed between them, because that is a change to the arena and not to the bot.
    // Named as a FAULT when it is on, rather than printed flat. A rung fought on cratered ground is not
    // comparable to the rungs beside it, and a reader skimming a gamerule line will not notice that.
    log('world', /set to: false/.test(world.griefing)
      ? `${world.griefing} — creeper blasts leave the terrain intact, so every rung is fought on the same ` +
        `ground. The bot still takes the full damage; only the terrain is spared.`
      : `⚠ ${world.griefing} — blasts will CRATER the ground the next wave is sited on, so this trial is ` +
        `not comparable to one run with it off. fleet_control sets this at bring-up; a server started ` +
        `another way did not get it.`);
  }
  // Anything a previous run left behind would be counted as this run's field.
  await clearArena(rcon);
  // ...and anything the WORLD left behind would be counted as the bot's opponent. Global (no cell) at
  // setup, because at this point nobody knows yet where the fight will be; runWave re-purges around the
  // actual stand, which is the one that matters — see purgeAmbientHostiles.
  const ambient = await purgeAmbientHostiles(rcon, null);
  if (!quiet && ambient) {
    log('purge', `${ambient} hostile(s) the world already owned were removed from the loaded chunks. ` +
      `doMobSpawning=false stops new ones; it does not touch these.`);
  }

  return {
    ok: true, scout, rcon, world,
    // The lifecycle terminates with whoever raised it (Law 8), and the kill runs even when the close is
    // reached through a failure — a summoned mob is PersistenceRequired and outlives the process that
    // made it, so an unswept exit leaves the world's next run fighting this one's leftovers.
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

  // BEFORE THE SERVER IS EVEN OPENED. This one needs no world — it is arithmetic against the bot's own
  // per-species aggro table — so it is asked at the cheapest possible moment. An operator who mistyped a
  // range gets the sentence and the number that would work, with nothing summoned and nothing moved.
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
    // The body is stood up here, once, before any round announces itself. Wave one then finds it already
    // standing where it was asked to stand and with the scout already able to read the ground, so the
    // first thing that happens after the trial opens is the summon.
    //
    // A failure here is exit 2 and NOT a round: nothing was pitted against anything, so counting it as a
    // lost or timed-out round would be the bench blaming the counter for its own setup (Law 25).
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

    // The tally, printed here rather than left to a reader: the operator ran a bench and is owed its
    // result, and a round that was NOT RUN is reported as exactly that rather than folded into the count.
    const ran = rounds.filter(r => r.run);
    log('verdict', `${ran.length}/${args.rounds} round(s) run vs ${waveLabel(args.wave)} — ` +
      `${ran.filter(r => r.fieldCleared).length} cleared · ${ran.filter(r => r.botDied).length} death(s) · ` +
      `${ran.filter(r => r.run && !r.fieldCleared && !r.botDied).length} timed out`);
    // The bench says WHAT happened; the journal says why. Pointing at it here is the whole seam between
    // the two instruments (Law 16 — this file records nothing).
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
  // The opening sequence and the gate in front of it — both testable without a server, which is the
  // whole reason the range check is arithmetic against the aggro table rather than a live measurement.
  standBot, rangeFitsAggro, SITE_BAND_SLACK,
};
