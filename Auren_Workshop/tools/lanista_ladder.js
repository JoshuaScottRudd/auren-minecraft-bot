// lanista_ladder — the tier × wave table, and the loop that runs it. The bench's MANAGER (Law 11).
//
// ── WHY IT IS A SEPARATE FILE FROM lanista ──────────────────────────────────────────────────────────
// A scenario table, match cards and a per-tick recorder used to live inside lanista as A SECOND
// EXPERIMENT DESIGN, free to disagree with the fleet's own run about what "a fight went well" means.
// This file is not that returning. It owns SEQUENCING and nothing else — which tier, which waves, in
// which order, when to stop — and it holds no opinion whatever about how a fight goes. Every verdict on
// this page is read off lanista's own outcome, which is read off the server. The manager delegates to
// executors and verifies results; it does not decide them (Law 11).
//
// ── THE EXPERIMENT ───────────────────────────────────────────────────────────────────────────────────
// Tier is minimum bot equipment against an escalating wave ladder, run back to back until the bot dies,
// so the trial always produces combat data rather than stopping the moment it gets interesting.
//
// The kit ladder: wooden sword with wooden axe as backup, then stone sword with stone axe, then stone
// sword with shield.
//
// ── THE CONTROLS, NAMED, BECAUSE THAT IS WHAT MAKES THIS AN EXPERIMENT ──────────────────────────────
// Held fixed across every trial, and every one of them written onto the row:
//   the KIT       authored and read back off the server's inventory NBT (lanista.kitBot)
//   the BIOME     hunted for, and re-verified at the fight cell before every wave (lanista_biome)
//   the GROUND    one cell, re-placed before every wave, so wave 4 is fought where wave 1 was
//   the RANGE     one band, asked for and reported with what the terrain actually gave
//   the WORLD     midnight, hard, clear, daylight cycle OFF (lanista_shared.WORLD), read back
//   the SPAWNS    natural monster spawning OFF, so the only mobs in the trial are the wave's
//
// ── THE STOP RULE, AND THE QUESTION IT DISSOLVES ────────────────────────────────────────────────────
// It runs to DEATH and records the wave that first drew blood. Stopping at first blood would throw away
// every wave after it — and wave 3 is the one expected to draw blood, so a first-blood stop would mean
// waves 4 and 5 essentially never ran. Both numbers come off one trial, so the choice was not needed:
// `blood` is the sharper measure for a low-equipped body, `died` is the one that ranks the tiers.
//
// ── WHAT THIS BENCH CANNOT PROVE, up front (Law 25) ─────────────────────────────────────────────────
// A SUMMONED mob is not a SPAWNED mob: it arrives already aggro-eligible with no approach, so this
// proves the ENGAGEMENT and never the ENCOUNTER. It cannot tell you whether the fleet would have SEEN
// the skeleton coming. Monsters-on is what proves that, and this is not a substitute for it.
// It also does not say WHY a wave went the way it did — that is `trace_monitor --combat`, reading the
// bot's own journal. The two are meant to be read together: this file names the outcome off the SERVER,
// the lens says what the bot decided inside it.
//
// ── THE BOT MUST BE IN SENTRY MODE, AND THIS FILE DOES NOT ARM IT ───────────────────────────────────
// A parked bot does not fight, and a bot running autonomy walks off to take jobs between waves — which
// destroys the ground control this whole file exists to hold. Sentry is the isolated state (one signal,
// held for its life, no job board, no dispatcher). Arming it is the OPERATOR's decision about the fleet
// and travels the operator's own pathway, so the ladder REFUSES to start rather than reaching across and
// arming the body itself (Law 16 — one capability, one invocation route):
//     node Auren_Workshop/fleet_control.js verb sentry
//
// Usage:
//   node lanista_ladder.js --tier=1 --biome=plains          one trial, waves 1-5, to the death
//   node lanista_ladder.js --tier=2 --biome=any --trials=3  three trials where the bot already stands
//   node lanista_ladder.js --tiers                          print the tier and wave tables, run nothing
//   node lanista_ladder.js --scenario=swarm                 run a NAMED run definition (tools/lanista_scenario.js)
// Then: node Auren_Bot/monitoring/trace_monitor.js --combat --bot=AurenBot
//       node Auren_Bot/monitoring/trace_monitor.js --combat --bot=AurenBot
// Exit codes — one per OWNER, because each sends the operator somewhere different:
//             0 every trial ran to a real end
//             2 cut by the GROUND (a biome that could not be hunted, a wave that could not be sited)
//             3 a trial STALLED — the body stood beside a mob and never exchanged damage
//             4 the body would not stand — dead after the respawn verb; only a rollback repairs that
//             5 cut by the BODY — the watch never stood down, or it was unreachable. Read the fleet.
//             6 cut by the BENCH — the server or the summon itself refused
//             1 could not run at all (no scout / no rcon / no bot / a malformed scenario).

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { WORLD, fmt, log, round2, sleep } = require('./lanista_shared');
const lanista = require('./lanista');
const biomeHunt = require('./lanista_biome');
const scenarios = require('./lanista_scenario');

// The ONE operator pathway (Law 16), reached the way an operator reaches it. `fleet_control.js` runs its
// dispatch in a bare async IIFE with no `require.main` guard, so it CANNOT be required — requiring it
// executes it. Spawning it as a child process is therefore not a stylistic choice; it is the only way to
// call it at all, and it is also the honest one: this file gets exactly the operator's own route, no more.
// ── THE TRIAL ROW, BUILT AND SPENT INSIDE ONE RUN ───────────────────────────────────────────────────
// These two functions used to live in `monitoring/ladder_ledger.js`, which appended every row to a file
// that outlived the run and grew forever. That record was DELETED (Architect 2026-08-31):
//
//   "fresh state is better than remembered. after every run changes are made so using the stale data
//    from a legacy repo has no use... longterm data is extrated and written down into markdowns. thats
//    the long term memory, we dont keep raw data we keep the interpetation and usefulness of it."
//
// A row measures a fleet that no longer exists by the time it is compared against — the code moves
// between runs, so a wave-4 death last week and one today are not two samples of one thing (Invariant B).
// What lasts is the CONCLUSION a person draws from a session, written into a markdown; the rows are the
// working material that produced it and they are spent when the run ends.
//
// So the row lives in memory here, is reported as each trial closes, and is gone with the process. It
// stays a structured object rather than a string because the wave fold below derives the summary
// figures once, where they cannot disagree with each other (Law 16).
//
//   CONTROLS   at/tier/kit/biome/at_/range/world   what was held fixed, carried in full so the line
//                                                  stays legible after the tier table is re-tuned
//   OUTCOMES   reached  deepest wave that STARTED       cleared  waves the bot cleared itself
//              blood    wave that first drew blood      died     the wave that killed it
//              hp/sec   health at the end, wall-clock   waves[]  one entry per wave
//              cut      why the ladder stopped short — a wave the terrain could not host is NOT a wave
//                       the bot failed, and folding the two corrupts every rate read off it (Law 25)
function newTrialRow(controls) {
  return {
    at: new Date().toISOString().replace('T', ' ').slice(0, 16),
    tier: controls.tier, kit: controls.kit, biome: controls.biome,
    at_: controls.cell, range: controls.range, got: null,
    world: controls.world,
    reached: 0, cleared: 0, blood: null, died: null, hp: null, sec: 0,
    waves: [], cut: null,
    // stalled — the body stood beside a mob it never touched. Its own field beside `cut`, because the
    // two exclude a trial for opposite reasons: a cut trial was stopped by the GROUND and a re-run
    // elsewhere may work; a stalled trial was stopped by the BENCH and a re-run proves it again.
    stalled: null,
    label: controls.label || null,
  };
}

// FIRST BLOOD IS THE WAVE, NOT THE HIT. A trial runs to death AND records the wave that first drew
// blood, so one row answers both whether the bot survived and when it first took damage. Recorded on the
// first wave with any health loss at all, including a wave the bot went on to clear.
function addWave(row, wave) {
  row.waves.push(wave);
  row.reached = Math.max(row.reached, wave.w);
  if (wave.o === 'cleared') row.cleared++;
  if (row.blood === null && wave.lost > 0) row.blood = wave.w;
  if (wave.o === 'died') row.died = wave.w;
  row.hp = wave.hp;
  row.sec += wave.s;
  return row;
}

const paths = require('../workshop_paths');
const REPO_ROOT = paths.REPO_ROOT;
const FLEET_CONTROL = paths.workshop('fleet_control.js');

// ── The kit ladder ──────────────────────────────────────────────────────────────────────────────────
//
// Includes the confound, named rather than silently corrected (Law 21 — the governor cites, it does not
// overrule): tier 2 → tier 3 changes TWO things at once, losing the backup axe and gaining the shield,
// so a tier-3 improvement cannot be attributed to the shield alone. Isolating it needs a fourth rung
// (stone sword + stone axe + shield), which is a design decision and not this file's to make —
// `--kit=` exists so the isolating variant can be run without editing the table.
//
// The axe is a BACKUP, not a second weapon the bot switches to tactically: the fleet's weapon picker
// takes the best thing it holds, so what the axe actually buys is a working weapon after the sword
// breaks. That is what makes it a fair rung of a low-equipment ladder and not a hidden upgrade.
//
// ── TIER 0 IS BARE FISTS ────────────────────────────────────────────────────────────────────────────
// It is a rung, not a control group. Every tier above it changes what the bot HOLDS, so a ladder whose
// lowest rung already holds something cannot say what the first weapon was worth — tier 1's advantage
// was being measured against tier 1. It is also the only rung where the body's damage is fixed by the
// game rather than by the loadout, which makes it the reference the others are read against.
//
// An empty kit still runs the full kitBot path: the inventory is WIPED and the emptiness is then read
// back off the server (see kitBot — an empty list gets the opposite assay, "the body holds nothing",
// because "nothing is missing" is vacuously true for a kit with nothing in it).
const TIERS = {
  0: { name: 'bare fists', kit: [] },
  1: { name: 'wooden sword + wooden axe', kit: ['wooden_sword', 'wooden_axe'] },
  2: { name: 'stone sword + stone axe', kit: ['stone_sword', 'stone_axe'] },
  3: { name: 'stone sword + shield', kit: ['stone_sword', 'shield'] },
};

// ── The wave ladder ─────────────────────────────────────────────────────────────────────────────────
//
// TWO SPECIES, and the ladder still escalates along one axis at a time inside them:
//   1  one zombie          the floor — a brawler that walks in. Anything that fails here fails at rest.
//   2  one creeper         the same approach with a FUSE on it: the counter must break off, not trade.
//   3  three zombies       the first SWARM, on the mob the bot already beat alone — so a failure here is
//                          about the crowd and cannot be about the species.
//   4  one zombie,         the only wave that tests target SELECTION, now built from the two species
//      one creeper         under test: the queue must pick between a body it can trade with and a body
//                          it must never be next to when the clock runs out. That is a harder selection
//                          problem than the old mixed wave, not a weaker one.
//
// ── WHAT THIS REPLACED, AND WHY IT IS RECORDED RATHER THAN DELETED (Law 20) ────────────────────────
// The previous table carried a five-wave ladder ending in a skeletal archer and a mixed zombie/spider/
// skeleton wave, superseded by the two-species table below. Waves 3 and 5 carried `skeleton:1@bow` and
// wave 5 a spider. Two facts from that design are still true and a successor restoring an archer wave
// needs both:
//   · a skeleton summoned WITHOUT a bow has no ranged attack at all: Java falls through to the melee
//     goal, so it charges and bashes and reads as an archer match unless `@bow` is present. `@bow` is
//     load-bearing, and lanista reads it back off the server.
//   · a skeleton is honoured to 16 b, not the flat 15 (architect_config's per-species table) — so an
//     archer wave sited at `--range=15` asks for a mob as far out as 17 b and is refused by lanista's
//     `rangeFitsAggro` gate. 14 is the most an archer wave can ask for.
//
// THE COST THIS TABLE NOW CARRIES, stated so it is not rediscovered as a surprise: neither species
// produces locomotion data. Both walk to the bot, so the repel arm never chases and no rush leg ever
// runs. The archer wave was the only one that exercised the chase, the kite and the jump trigger, and
// with it gone this ladder answers NOTHING about the rush arm. That is a real narrowing of what the
// bench covers, not a simplification of it (Law 25) — the ladder must not be read as a full sweep while
// this table stands.
const WAVES = [
  { w: 1, spec: 'zombie:1' },
  { w: 2, spec: 'creeper:1' },
  { w: 3, spec: 'zombie:3' },
  { w: 4, spec: 'zombie:1,creeper:1' },
];

// ── A CEILING, NOT A WAVE LENGTH ────────────────────────────────────────────────────────────────────
// A wave ends when the battle ends — observeFight breaks on the bot's death and on the field emptying,
// and neither waits for this number. What this is: the point past which a wave that has not resolved is
// not a slow fight but a fight that is not happening. battle_stations' own per-target guard is 60 s and
// wave 5 has three targets, so it sits just past where the fleet's own judge would already have given up.
// A wave that reaches it is recorded `timeout`, which is a DEFECT reading and not an outcome the ladder
// treats as a result.
//
// Renamed from HOLD_SEC (Law 7): the old name described a duration to hold for, which is the wrong
// reading — nothing holds for it, and a wave that does is broken.
const WAVE_CEILING_SEC = 90;
// Seconds between waves. Long enough for the field kill to settle and the bot's own engagement to
// retire its target; short enough that natural regeneration is not what carries the bot to wave 5.
const BETWEEN_SEC = 3;

// ── THE BODY STANDS SOMEWHERE NEW EVERY TRIAL ───────────────────────────────────────────────────────
//
// The biome hunt is DETERMINISTIC — same target, same origin, same cell — which is exactly right for the
// biome and exactly wrong for elevation. Five trials from one hunt are five readings of one hillside, and
// a ladder that only ever fought on one slope would report the sprint-jump's cost as a property of the
// kit (Law 25: the number would be true and would answer a question nobody asked).
//
// HOW THE CANDIDATES ARE FOUND, and why nothing new was built for it: `siteMobCells` already returns
// cells around a point that passed the reach gate and the sightline cast — which is precisely "somewhere
// the body can legally stand near here". Asked with no range and no lift, it spreads across bearings, and
// terrain gives their `y` for free. Reusing it is Law 16; a second ground-finder beside it would be a
// second answer to one question.
//
// THE PICK IS FURTHEST-FROM-USED, not random: this is a control, so it must be reproducible. Trial 3 of a
// re-run visits the same cell trial 3 visited before, because the candidate order and the used-set are
// both deterministic.
//
// FALLS BACK TO THE HUNTED CELL, out loud. Flat ground has one elevation and no amount of searching
// invents a second; a trial on it is still a valid trial of flat ground, and the row says `spread: false`
// so no aggregate can quietly treat it as varied.
const ELEVATION_CANDIDATES = 8;

async function pickStand(scout, hunt, usedElevations, minSeparation) {
  if (minSeparation <= 0) return { cell: hunt.cell, spread: false, why: 'elevation spread disabled (--elevation-spread=0)' };
  let candidates;
  try {
    candidates = await lanista.siteMobCells(scout, hunt.cell, ELEVATION_CANDIDATES, 0, 0);
  } catch (e) {
    return { cell: hunt.cell, spread: false, why: `the ground search threw (${e.message}) — standing on the hunted cell` };
  }
  const cells = (candidates.cells || []).filter(c => Number.isFinite(c.y));
  if (!cells.length) return { cell: hunt.cell, spread: false, why: 'no confirmed stand cell near the hunted cell' };

  // Distance from the NEAREST already-used elevation, maximised. First trial has an empty used-set, so
  // every candidate scores Infinity and the deterministic tie-break (the first cell) wins.
  const separation = (c) => (usedElevations.length ? Math.min(...usedElevations.map(y => Math.abs(c.y - y))) : Infinity);
  const best = cells.reduce((a, b) => (separation(b) > separation(a) ? b : a), cells[0]);
  const got = separation(best);
  if (got < minSeparation) {
    return {
      cell: { x: best.x, y: best.y, z: best.z }, spread: false,
      why: `the best of ${cells.length} candidate(s) is only ${got === Infinity ? '∞' : got}b from an elevation already used ` +
        `(wanted ≥${minSeparation}b) — this ground is too flat to vary`,
    };
  }
  return { cell: { x: best.x, y: best.y, z: best.z }, spread: true, why: null };
}

// ── One trial ───────────────────────────────────────────────────────────────────────────────────────
//
// Kit → hunt the biome → place the body → run the waves until it dies or the ladder ends.
//
// A REFUSED WAVE ENDS THE TRIAL AND MARKS IT CUT. It does not skip to the next wave and it is never
// counted as a defeat: a wave that could not be sited measures the terrain, not the bot, and a ladder
// that carried on past it would report a shallower depth than the body earned (Law 25). `cut` is on the
// row so every rate computed downstream can exclude it.
async function runTrial(link, args, usedElevations = []) {
  const tier = TIERS[args.tier];
  const { scout, rcon } = link;

  let at0 = await lanista.readBotVitals(rcon, args.bot);
  if (!at0.known || !at0.position) return { ok: false, why: `the server will not answer for '${args.bot}' — is it connected?` };

  // ── STAND THE BODY UP BETWEEN TRIALS ──────────────────────────────────────────────────────────────
  //
  // A dead bot never revives on its own between trials, and without this step every trial after the
  // first death is dead on arrival, which makes `--trials=N` useless for exactly the scenarios worth
  // repeating — the ones the bot loses.
  //
  // WHY THE LADDER MAY DO THIS WHEN IT REFUSES TO ARM SENTRY (the header above draws that line, and this
  // sits on the other side of it): sentry is a MODE — a decision about what the fleet is for, which is
  // the operator's. A corpse is not a mode; it is a PRECONDITION of the trial this file already authors.
  // This same function then teleports the body and WIPES ITS INVENTORY two steps below. Standing it up is
  // strictly less invasive than either, and refusing to do it while doing those would be an odd place to
  // hold the line.
  //
  // IT USES THE ONE ROUTE (Law 16) — the `respawn` operator verb, spawned exactly as an operator would
  // type it. No second mechanism, and nothing here knows how a respawn works.
  if (!at0.alive) {
    log('revive', `'${args.bot}' is a corpse. Sending the respawn verb — nothing else will (master_core runs respawn:false).`);
    const r = spawnSync(process.execPath, [FLEET_CONTROL, 'verb', 'respawn'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (r.status !== 0) log('revive', `⚠ the verb did not deliver (exit ${r.status}). Reading the body off the server anyway.`);
    // The verb's own report is a CLAIM by the process that sent the packet; aliveness is read back off
    // the SERVER, because a process may not certify its own recovery (Law 26).
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      at0 = await lanista.readBotVitals(rcon, args.bot);
      if (at0.known && at0.alive) break;
    }
    if (!at0.known || !at0.alive) {
      return { ok: false, dead: true, why: `'${args.bot}' is STILL dead after the respawn verb — the body did not come back. ` +
        `If it connected as a corpse, master_core never initialised and no verb can reach it; only a world rollback repairs that.` };
    }
    log('revive', `the body is back — Health ${at0.health}, read off the server. It respawned at world spawn; the trial places it next.`);

    // ── AND STAND THE WATCH BACK UP, OR THE BODY IS ALIVE AND STILL UNUSABLE ─────────────────────────
    //
    // The same fault as the corpse above with one more step: a respawn alone leaves the watch loop dead
    // even though the body is alive, so every subsequent trial refuses with "the watch never stood down"
    // and reads as a trial that never happened rather than the clean sheet it appears to be (Law 25).
    //
    // WHY THE RESPAWN ALONE CANNOT FIX IT. `await_aggro` treats death as TERMINAL for the watch, so the
    // loop exits and never writes another `standing` row; `combat_lens.watchStateFromRows` clears
    // `standing` on the death row to match. Both are correct and neither is the bug. The bug is that the
    // MODE survives (`armed` stays true) while the LOOP does not, so a revived body sits in sentry forever
    // without a watch turning, and `awaitStandingWatch` — correctly — refuses to summon onto it.
    //
    // WHY THE LADDER MAY DO THIS. The same argument the block above already makes and on the same side
    // of the line it draws: sentry is a MODE and the operator owns it, but this does not change the mode —
    // `armed` was already true and stays true. A retired watch loop is a PRECONDITION of the trial this
    // file authors, like the corpse, the teleport and the inventory wipe it performs three steps down.
    // Death is still terminal for the TRIAL; it is not terminal for the NEXT one.
    //
    // ONE ROUTE (Law 16) — the `sentry` operator verb, spawned exactly as an operator would type it, which
    // is also the repair `combat_lens` tells an operator to make by hand. Nothing here knows how a watch
    // arms. The result is deliberately NOT trusted: `awaitStandingWatch` reads the standing row off the
    // journal before any wave is summoned, so a verb that failed to deliver still refuses the wave rather
    // than being certified by the process that sent it (Law 26).
    const sr = spawnSync(process.execPath, [FLEET_CONTROL, 'verb', 'sentry'], { cwd: REPO_ROOT, encoding: 'utf8' });
    log('revive', sr.status === 0
      ? 'the watch was retired by the death — sentry re-sent so a fresh watch loop turns for this trial.'
      : `⚠ the sentry verb did not deliver (exit ${sr.status}). The wave gate reads the watch off the journal and will refuse if it never stood.`);
  }
  const origin = { x: Math.floor(at0.position.x), y: Math.floor(at0.position.y), z: Math.floor(at0.position.z) };

  // THE BIOME, FIRST, because it decides where everything else happens. A failed hunt aborts the trial
  // rather than falling back to the origin: a row labelled with a biome the fight was not in is the one
  // failure this control exists to prevent.
  const hunt = await biomeHunt.huntBiome(scout, rcon, { target: args.biome, origin });
  if (!hunt.found) return { ok: false, why: hunt.why };
  log('biome', hunt.declared
    ? `'${hunt.biome}' at ${fmt(hunt.cell)} — found on hop ${hunt.hops} after ${hunt.scanned} sample(s).`
    : `fighting where the bot stands, in '${hunt.biome || 'an unread biome'}' at ${fmt(hunt.cell)}.`);

  // THE KIT, and it WIPES the inventory (see lanista.kitBot). Said out loud here as well as there,
  // because this is the line the operator is actually reading when it happens.
  const kit = await lanista.kitBot(rcon, args.bot, tier.kit);
  if (!kit.ok) {
    return { ok: false, why: kit.unclearedDetail
      ? `${args.bot}: ${kit.unclearedDetail} — the server says: ${kit.inventory || '(empty)'}`
      : `${args.bot} is missing ${kit.missing.join(', ')} after the kit replace — the server says: ${kit.inventory || '(empty)'}` };
  }
  log('kit', kit.bare
    ? `tier ${args.tier} — ${tier.name}. ${args.bot}'s inventory was WIPED and left EMPTY, and the server was asked to confirm it holds nothing. Every hit this trial is an unarmed hit.`
    : `tier ${args.tier} — ${tier.name}. ${args.bot}'s inventory was WIPED and replaced; nothing it had earned is in this trial.`);

  // ── THE BODY IS RESET TOO, NOT ONLY WHAT IT CARRIES (Invariant B) ───────────────────────────────
  //
  // Without this, a trial that opens on whatever health the previous trial ended at reads as a
  // comparable rung to one that opened at full health, so `--tiers` would take a median across trials
  // that were never the same experiment (Law 25: the number answers a question about the KIT, and
  // health would be silently answering part of it).
  //
  // The line was already drawn in the right place and just one step short: this function already wipes
  // the inventory, re-kits it, and teleports the body precisely so nothing carries over between trials.
  // Health is the same category of carry-over as a half-used sword, and is reset in the same breath.
  //
  // instant_health rather than a food/regeneration effect, because a regeneration tick would still be
  // healing while wave 1 ran and would quietly subsidise the fight this bench exists to measure.
  const healed = await lanista.healBot(rcon, args.bot);
  if (!healed.ok) {
    return { ok: false, why: `${args.bot} would not heal to full before the trial — the server reports ${healed.health ?? 'nothing'}. ` +
      `A trial opened on a wounded body measures the wound, not the kit.` };
  }
  if (healed.was != null && healed.was < 20) log('heal', `topped the body up from ${round2(healed.was)} to ${healed.health} — every trial opens at full health or it does not open.`);

  // THE ELEVATION CONTROL, chosen before the row is opened so the row carries where the body actually
  // stood rather than where the biome hunt landed.
  const stand = await pickStand(scout, hunt, usedElevations, args.elevationSpread);
  log('stand', stand.spread
    ? `y=${stand.cell.y} at ${fmt(stand.cell)} — ${usedElevations.length ? `≥${args.elevationSpread}b from every elevation used so far (${usedElevations.join(', ')})` : 'first trial of this session'}.`
    : `y=${stand.cell.y} at ${fmt(stand.cell)} — ⚠ ELEVATION NOT VARIED: ${stand.why}`);
  usedElevations.push(stand.cell.y);

  const row = newTrialRow({
    tier: args.tier, kit: tier.name, biome: hunt.biome, cell: stand.cell,
    range: args.range, world: `${WORLD.time}/${WORLD.difficulty}`, label: args.label,
  });
  row.standY = stand.cell.y;
  row.spread = stand.spread;
  row.lift = args.lift;

  // `args.waves`, never the module table: a scenario replaces the ladder whole, and a loop reading the
  // const while the row reads the scenario would fight one table and record the other.
  const waves = args.waves;
  for (const wave of waves) {
    const r = await lanista.runWave(scout, rcon, {
      bot: args.bot,
      wave: lanista.parseWave(wave.spec),
      range: args.range,
      ceilingSeconds: args.ceilingSeconds,
      stallSeconds: args.stallSeconds,
      lift: args.lift,
      at: stand.cell,                      // re-placed every wave: the ground is a control, not a drift
      biome: hunt.declared ? hunt.biome : 'any',
    }, wave.w);

    if (!r.run) {
      row.cut = `wave ${wave.w}: ${r.reason}`;
      // The cause travels onto the row so the reported line and the exit code read one classification
      // rather than each re-deciding it from the prose (Law 16 — one place decides, everyone else reads).
      row.cutCause = r.cause || 'bench';
      log('wave', `${wave.w}: NOT RUN — ${r.reason}`);
      log('wave', row.cutCause === 'terrain'
        ? '  → trial CUT SHORT by the GROUND. Not a defeat, excluded from every depth figure — a re-run elsewhere may well work.'
        : row.cutCause === 'bot'
          ? '  → trial CUT SHORT by the BODY, not the ground. Not a defeat and excluded from every depth figure, but re-rolling terrain will not fix it — read the fleet.'
          : '  → trial CUT SHORT by the BENCH (the server or the summon refused). Not a defeat, and neither the ground nor the bot is implicated.');
      break;
    }
    if (row.got === null) row.got = r.rangeGot;

    // The outcome vocabulary comes from lanista's own reading of the server, never from a judgement made
    // here: this is a CALL, not a re-derivation.
    //
    // SEVEN WORDS NOW, AND THE SEVENTH CORRECTION WAS THE COPY ITSELF. This chain used to restate
    // lanista's ranking by hand — died / stalled / cleared / blown / timeout — and the two drifted the
    // moment `headline` learned to read the server's explosion packet and this did not: a wave could
    // print as detonated while the row still read `cleared`, both true to their own test and one of them
    // false about the fight. The old test inferred the blast from `hpLostAfterClear`, which is 0 whenever
    // the creeper goes off INSIDE the wave instead of after it, which is nearly always. Law 16 — one
    // capability, one implementation: the ranking lives in `lanista.waveVerdict` and nothing else may
    // hold a copy of it.
    //
    // What the words mean is unchanged and is worth keeping written down, because each was a correction:
    //   `stalled`  ranks second, under death only, because it is the one outcome that says the wave never
    //              happened. Once filed as `timeout` — true about the clock, false about the fight, and
    //              it put a broken BENCH in the bucket for hard waves.
    //   `blown`    is a wave that finished, took health off the bot, and left it holding nothing it
    //              earned. Also once folded into `timeout`. It is not a death and does not end the
    //              trial — the bot survived it. It is simply not a clear.
    // A stall does not end the trial by itself either; the CONDUCTOR decides what one costs the run,
    // because tearing down is a decision about the session and not about this wave.
    const outcome = lanista.waveVerdict(r);
    addWave(row, {
      w: wave.w,
      f: r.wave,
      o: outcome,
      hp: r.hpEnd,
      lost: round2((r.hpLost || 0) + (r.hpLostAfterClear > 0 ? r.hpLostAfterClear : 0)),
      s: Math.round(r.ms / 1000),
      // The lift the ground actually gave this wave. On the wave and not only on the trial, because the
      // ladder re-sites every wave and a five-wave trial can hold five different lifts — a trial-level
      // number would be an average nobody fought at (Law 25).
      lf: r.liftGot,
    });
    log('wave', `${wave.w}: ${lanista.headline(r)} · hp ${r.hpStart}→${r.hpEnd} · ${(r.ms / 1000).toFixed(1)}s`);

    if (r.botDied) break;
    // A STALL ENDS THE TRIAL. Every wave after it would be fought on the same unengaging body, so
    // carrying on spends the rest of the ladder proving the same defect four more times — and each of
    // those waves would be reported as real ones. `stalled` on the row is what the conductor
    // reads to decide the session.
    if (r.stalled) { row.stalled = `wave ${wave.w}: no damage exchanged in ${Math.round(r.ms / 1000)}s`; break; }
    if (wave.w < waves[waves.length - 1].w) await sleep(BETWEEN_SEC * 1000);
  }

  return { ok: true, row };
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opt = (n, d) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
  const a = {
    bot: opt('bot', process.env.BOT_ID || 'AurenBot'),
    tier: parseInt(opt('tier', '1'), 10),
    biome: opt('biome', 'any'),
    trials: parseInt(opt('trials', '1'), 10),
    range: parseFloat(opt('range', '12')),
    ceilingSeconds: parseInt(opt('ceiling', String(WAVE_CEILING_SEC)), 10),
    // Both halves of the elevation control. `lift` is per WAVE — the mob stands at least one bot above
    // the body, so the approach has to climb. `elevationSpread` is per TRIAL — consecutive trials stand
    // the body at DIFFERENT ground heights, so the ladder is not five readings of one hillside. Defaults,
    // not opt-ins: both are part of the control.
    lift: parseInt(opt('lift', '2'), 10),
    elevationSpread: parseInt(opt('elevation-spread', '3'), 10),
    label: opt('label', null),
    show: argv.includes('--tiers'),
    // ON BY DEFAULT, and that is a correction rather than a new behaviour: a wave where nothing engaged
    // already ran to the ceiling and was recorded `timeout`, a word that describes the clock and not the
    // fight (see observeFight's stall header). `--stall=0` restores the old silence for a run that wants
    // it. It does not change what any wave DOES — only what an unengaged one is called.
    stallSeconds: parseInt(opt('stall', String(scenarios.DEFAULT_ENGAGE_STALL_SEC)), 10),
    // Which waves this run fights. The module-level table is the default; a scenario replaces it whole.
    waves: WAVES,
  };
  // ── A NAMED SCENARIO OVERRIDES THE FLAGS, AND IS APPLIED BEFORE --kit ──────────────────────────────
  //
  // A named scenario authors the bot's equipment, wave numbers and monsters per wave as one definition,
  // with everything else automatic. The record is the run definition; the flags stay for one-off
  // probing. Applied here rather than in a parallel arg path so there is exactly one place a run's
  // inputs are assembled (Law 16).
  // row is then built from the same values the fight used, whichever route supplied them.
  //
  // --kit is read AFTER, so `--scenario=swarm --kit=stone_sword` is a legible one-item change to a named
  // run rather than a silent conflict between two sources.
  const scenarioName = opt('scenario', null);
  a.scenario = null;
  if (scenarioName) {
    const loaded = scenarios.load(scenarioName);
    // Returned, never thrown, and never swallowed: the caller (`main`) turns it into a refusal with the
    // field names in it, before a server is touched. A scenario that half-applied would run a fight
    // nobody authored (Law 13 — validate preconditions before proceeding).
    if (!loaded.ok) { a.scenarioProblems = loaded.problems; return a; }
    const s = loaded.scenario;
    a.scenario = s;
    a.tier = s.tier;
    a.biome = s.biome;
    a.range = s.range;
    a.lift = s.lift;
    a.trials = s.trials;
    a.elevationSpread = s.elevationSpread;
    a.ceilingSeconds = s.ceilingSeconds;
    a.stallSeconds = s.engageStallSeconds;
    a.waves = s.waves;

    // ── AN EXPLICIT FLAG OUTRANKS THE SCENARIO, AND THIS LINE IS WHY IT NEEDS SAYING ────────────────
    // The block above overwrites every field it owns, so before this existed a `--scenario=creepers
    // --range=12` would silently fight at the scenario's own range instead, and every number it produced
    // would be true and about a fight nobody asked for (Law 25 — the asker acts differently on the real
    // range).
    //
    // GIVEN, not truthy: `opt()` cannot tell an absent flag from one that resolved to its default, so
    // testing the VALUE would let a scenario's 12 be mistaken for a typed 12 and vice versa. The only
    // honest question is whether the operator wrote it, which is a question about argv (Invariant B —
    // re-sense the argument list rather than infer intent from a value someone else may have set).
    const given = (n) => argv.some(x => x.startsWith(`--${n}=`));
    const overrides = [];
    const take = (flag, field, cast) => {
      if (!given(flag)) return;
      const was = a[field];
      a[field] = cast(opt(flag));
      if (a[field] !== was) overrides.push(`${flag}: ${was} → ${a[field]}`);
    };
    take('biome', 'biome', v => v);
    take('range', 'range', parseFloat);
    take('trials', 'trials', v => parseInt(v, 10));
    take('lift', 'lift', v => parseInt(v, 10));
    take('elevation-spread', 'elevationSpread', v => parseInt(v, 10));
    take('ceiling', 'ceilingSeconds', v => parseInt(v, 10));
    take('stall', 'stallSeconds', v => parseInt(v, 10));
    // ANNOUNCED, never silent. A named run that was quietly altered is no longer the named run, and the
    // the row would carry the scenario's name over a different experiment.
    a.scenarioOverrides = overrides;
    // The scenario's kit stands in for the tier's, under the tier's number, exactly as --kit does — see
    // that flag's header for why the row records what was WORN beside which rung it stood in for.
    TIERS[s.tier] = { name: s.kit.length ? s.kit.join(' + ').replace(/minecraft:/g, '') : 'bare fists', kit: s.kit };
  }

  const kit = opt('kit', null);
  // --kit overrides the tier's loadout WITHOUT renaming the tier, so an ad-hoc rung is legible in the
  // the row's `kit` field carries what was actually worn, and the tier number carries which rung
  // it was standing in for. A row that said `tier 3` while wearing something else would be unreadable
  // six months out (Law 25 — the record states what happened, not what was scheduled).
  if (kit) TIERS[a.tier] = { name: kit.replace(/,/g, ' + ').replace(/minecraft:/g, ''), kit: kit.split(',').map(s => s.trim()).filter(Boolean) };
  return a;
}

function printTables() {
  console.log('\nTIERS — the kit ladder\n');
  for (const [n, t] of Object.entries(TIERS)) console.log(`  ${n}  ${t.name.padEnd(28)} ${t.kit.join(', ')}`);
  console.log('\n  ⚠ tier 2 → 3 changes TWO things (loses the axe, gains the shield), so a tier-3 gain cannot be');
  console.log('    attributed to the shield alone. Run the isolating rung with:');
  console.log('      --tier=3 --kit=stone_sword,stone_axe,shield\n');
  console.log('WAVES — run back to back until the bot dies\n');
  for (const w of WAVES) console.log(`  ${w.w}  ${w.spec}`);
  console.log(`\n  a wave ends when the battle ends — the field empties or the bot dies. ${WAVE_CEILING_SEC}s is the ceiling past which`);
  console.log(`  a wave is recorded as a timeout (a defect, not a result) · ${BETWEEN_SEC}s between · the body is re-placed on the trial's cell before every wave.`);
  console.log('  No healing and no re-kit between waves: attrition across the ladder is the thing being measured.\n');
  console.log('THE ELEVATION CONTROL (Architect 2026-08-07)\n');
  console.log('  --lift=2              the mob stands ≥2b (one bot) ABOVE the body, so the approach has to climb');
  console.log('                        and the sprint-jump is exercised. Falls back to a flat confirmed cell if');
  console.log('                        the ground has none, and the row says which.');
  console.log('  --elevation-spread=3  consecutive TRIALS stand the body ≥3b apart in y, so a ladder is not five');
  console.log('                        readings of one hillside. Deterministic: trial 3 of a re-run stands where');
  console.log('                        trial 3 stood before.\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.show) { printTables(); return 0; }
  // BEFORE the arena is opened and before anything is judged about tiers: a malformed scenario is a
  // usage error, and a usage error must cost nothing (Law 13 — default stopped, validate first). The
  // field names travel with it because "invalid scenario" sends the operator back to read the file.
  if (args.scenarioProblems) {
    console.error(`lanista_ladder: the scenario is REFUSED before touching anything —`);
    for (const p of args.scenarioProblems) console.error(`  · ${p}`);
    return 1;
  }
  if (args.scenario) {
    log('scenario', scenarios.describe(args.scenario));
    // Printed as a CHANGE (was → now), not as the final value: a reader comparing this run to another
    // under the same scenario name needs to see that they are not the same experiment.
    if (args.scenarioOverrides && args.scenarioOverrides.length) {
      log('scenario', `⚠ OVERRIDDEN on the command line — ${args.scenarioOverrides.join(' · ')}. ` +
        `This is NOT the declared '${args.scenario.name}' run.`);
    }
  }
  if (!TIERS[args.tier]) {
    console.error(`lanista_ladder: no tier ${args.tier}. Tiers are ${Object.keys(TIERS).join(', ')} — see --tiers.`);
    return 1;
  }

  // ── THE AGGRO-FIT GATE, WHICH THIS PATHWAY NEVER RAN ───────────────────────────────────────────────
  // `lanista.rangeFitsAggro` exists and is asked before the server is even opened — but only by
  // lanista's OWN cli main(). Every scenario run comes through here instead, so the check was reachable
  // from one of the two routes into the same fight (Law 16), and without it the ladder pays the full
  // price the gate was written to avoid: a rollback, a bring-up, a purge, a survey and a summon before
  // refusing post-placement.
  //
  // AND THE REFUSAL IT FELL THROUGH TO WAS MISLABELLED, which is the part that matters more than the
  // wasted time. runWave's post-summon check returns cause 'terrain' → exit 2 → the conductor prints
  // "a re-run on different ground may well work". No ground repairs a range that structurally cannot fit
  // inside the mob's aggro radius; the arithmetic refuses it everywhere (Law 25 — the caller acts on that
  // sentence, and it is false). Refused here it is exit 1: the run DEFINITION is what cannot run.
  for (const w of args.waves) {
    const fit = lanista.rangeFitsAggro(lanista.parseWave(w.spec), args.range);
    if (!fit.ok) {
      console.error(`lanista_ladder: wave ${w.w} (${w.spec}) cannot be sited — REFUSED before touching anything.`);
      console.error(`  · ${fit.why}`);
      return 1;
    }
  }

  const link = await lanista.openArena();
  if (!link.ok) { console.error(`lanista_ladder: ${link.why}`); return 1; }

  let exitCode = 0;
  try {
    // NATURAL SPAWNING OFF.
    // Without it a plains at midnight puts its own zombies into the field, and the trial then measures a
    // wave nobody wrote — the tag count would still read clean, because the world's spawns are untagged
    // and so are invisible to the field read but perfectly visible to the bot.
    await link.rcon.command('gamerule doMobSpawning false');
    const spawning = ((await link.rcon.command('gamerule doMobSpawning')) || '').trim();
    log('world', `${spawning} — the only mobs in this trial are the ones the ladder summons.`);

    // Carried ACROSS trials, which is what makes elevation a control rather than a coincidence — each
    // trial picks the stand cell furthest from every elevation already spent this session.
    const usedElevations = [];
    // Every trial that actually ran, this session only. Spent when the process exits.
    const done = [];

    for (let t = 1; t <= args.trials; t++) {
      log('trial', `${t}/${args.trials} — tier ${args.tier} (${TIERS[args.tier].name}) vs ${args.waves.length} wave(s), biome '${args.biome}'`);
      const r = await runTrial(link, args, usedElevations);
      if (!r.ok) {
        // A trial that never started is reported as never started and is not counted as a trial:
        // a session tally must not count experiments that did not happen (Law 25).
        log('trial', `${t}/${args.trials} — NOT RUN: ${r.why}`);
        // EXIT 4 WHEN THE BODY WOULD NOT COME BACK, not 2. Code 2 means the GROUND ended it, and the
        // conductor says so out loud — "a re-run on different ground may well work". That sentence is
        // FALSE of a corpse (Law 25: the caller acts differently on each, so the caller must be able to
        // tell them apart). A body that will not stand after the respawk verb is the bench being broken
        // in the one way a rollback repairs and a re-run does not (the respawn verb already ran and failed).
        exitCode = r.dead ? 4 : 2;
        continue;
      }
      // Reported as it closes and kept only in `done`, below: nothing is appended to a file, because
      // there is no file (see the row's own note above — the record was deleted, the conclusion is
      // written into a markdown by whoever read the session).
      done.push(r.row);
      log('trial', `${t}/${args.trials} - reached wave ${r.row.reached}, cleared ${r.row.cleared}, `
        + `first blood ${r.row.blood ?? 'never'}, ${r.row.died ? `died on ${r.row.died}` : 'survived the ladder'} `
        + `- ${Math.round(r.row.sec)}s - trial ${t} of ${args.trials} this session`)
      // ONE CODE PER OWNER (Invariant D). All three of these are "the wave never ran", but they send the
      // operator to three different places: terrain → roll different ground; bot → read the fleet; bench
      // → look at the server. Collapsing them into 2 would print "try different ground" at a body that
      // was never fit to fight in the first place, which is a wrong instruction wearing a true one's
      // clothes.
      if (r.row.cut) exitCode = r.row.cutCause === 'bot' ? 5 : r.row.cutCause === 'bench' ? 6 : 2;
      // EXIT 3, ITS OWN CODE, NOT FOLDED INTO 2. A cut trial measured the TERRAIN (a biome that could not
      // be hunted, ground that could not host a wave) and the next run on different ground may well work.
      // A stall measured the BENCH — the body was standing beside a mob it never touched — and re-running
      // it changes nothing. The conductor tears the session down on 3 and does not on 2, so the two must
      // be distinguishable from outside this process (Law 25: the caller acts differently on each).
      if (r.row.stalled) { log('trial', `${t}/${args.trials} — ⚠ STALLED: ${r.row.stalled}`); exitCode = 3; }
      if (t < args.trials) await sleep(5000);
    }

    // THE SESSION'S OWN SUMMARY, since nothing outlives the process to be compared later. One line per
    // trial that ran: the operator reads this, draws the conclusion, and writes THAT into a markdown.
    if (done.length) {
      log('done', `${done.length} trial(s) ran this session:`);
      for (const r of done) {
        log('done', `  tier ${r.tier} (${r.kit}) in ${r.biome} - reached ${r.reached}, cleared ${r.cleared}, `
          + `blood ${r.blood ?? 'never'}, ${r.died ? `died on ${r.died}` : 'survived'} - ${Math.round(r.sec)}s`);
      }
      log('done', 'Long-term memory is the WRITE-UP, not this output: put the conclusion in a markdown.');
    }
    log('done', `Why a wave went that way:  node Auren_Bot/monitoring/trace_monitor.js --combat --bot=${args.bot}`);
    return exitCode;
  } catch (e) {
    console.error(`lanista_ladder failed: ${e.stack || e.message}`);
    return 1;
  } finally {
    await link.close();
  }
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { TIERS, WAVES, WAVE_CEILING_SEC, BETWEEN_SEC, parseArgs, runTrial };
