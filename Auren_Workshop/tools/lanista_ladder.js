// lanista_ladder — the tier × wave table, and the loop that runs it. The bench's MANAGER (Law 11): owns
// SEQUENCING only — which tier, which waves, in which order, when to stop. Every verdict is read off
// lanista's own outcome, read off the server; the manager delegates and verifies, never decides.
//
// Tier is minimum bot equipment against an escalating wave ladder, run back to back until the bot dies.
// Kit ladder: wooden sword + wooden axe, then stone sword + stone axe, then stone sword + shield.
//
// CONTROLS held fixed every trial, each written onto the row:
//   the KIT       authored and read back off the server's inventory NBT (lanista.kitBot)
//   the BIOME     hunted for, and re-verified at the fight cell before every wave (lanista_biome)
//   the GROUND    one cell, re-placed before every wave
//   the RANGE     one band, reported with what the terrain actually gave
//   the WORLD     midnight, hard, clear, daylight cycle OFF (lanista_shared.WORLD), read back
//   the SPAWNS    natural monster spawning OFF
//
// Runs to DEATH and records the wave that first drew blood: `blood` is the sharper measure for a
// low-equipped body, `died` ranks the tiers.
//
// CANNOT PROVE (Law 25): a SUMMONED mob arrives already aggro-eligible with no approach, so this proves
// the ENGAGEMENT and never the ENCOUNTER. It does not say WHY a wave went the way it did — read
// `trace_monitor --combat` for the bot's own account alongside the server outcome named here.
//
// THE BOT MUST BE IN SENTRY MODE; THIS FILE DOES NOT ARM IT. Arming it is the OPERATOR's decision,
// reached only through its own route (Law 16):
//     node Auren_Workshop/fleet_control.js verb sentry
//
// Usage:
//   node lanista_ladder.js --tier=1 --biome=plains          one trial, waves 1-5, to the death
//   node lanista_ladder.js --tier=2 --biome=any --trials=3  three trials where the bot already stands
//   node lanista_ladder.js --tiers                          print the tier and wave tables, run nothing
//   node lanista_ladder.js --scenario=swarm                 run a NAMED run definition (tools/lanista_scenario.js)
// Then: node Auren_Bot/monitoring/trace_monitor.js --combat --bot=AurenBot
// Exit codes — one per OWNER:
//             0 every trial ran to a real end
//             2 cut by the GROUND (a biome that could not be hunted, a wave that could not be sited)
//             3 a trial STALLED — the body stood beside a mob and never exchanged damage
//             4 the body would not stand — dead after the respawn verb; only a rollback repairs that
//             5 cut by the BODY — the watch never stood down, or it was unreachable
//             6 cut by the BENCH — the server or the summon itself refused
//             1 could not run at all (no scout / no rcon / no bot / a malformed scenario)

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/lanista_ladder.js');

const { spawnSync } = require('child_process');
const { WORLD, fmt, log, round2, sleep } = require('./lanista_shared');
const lanista = require('./lanista');
const biomeHunt = require('./lanista_biome');
const scenarios = require('./lanista_scenario');

// The ONE operator pathway (Law 16): fleet_control.js runs in a bare async IIFE with no require.main
// guard, so it cannot be required — spawning it as a child process is the only way to call it.
// THE TRIAL ROW is built and spent inside one run: it lives in memory, is reported as each trial
// closes, and is gone with the process (Invariant B). Kept as a structured object so the wave fold
// below derives the summary figures once (Law 16).
//
//   CONTROLS   at/tier/kit/biome/at_/range/world   what was held fixed
//   OUTCOMES   reached  deepest wave that STARTED       cleared  waves the bot cleared itself
//              blood    wave that first drew blood      died     the wave that killed it
//              hp/sec   health at the end, wall-clock   waves[]  one entry per wave
//              cut      why the ladder stopped short, excluded from every rate (Law 25)
function newTrialRow(controls) {
  return {
    at: new Date().toISOString().replace('T', ' ').slice(0, 16),
    tier: controls.tier, kit: controls.kit, biome: controls.biome,
    at_: controls.cell, range: controls.range, got: null,
    world: controls.world,
    reached: 0, cleared: 0, blood: null, died: null, hp: null, sec: 0,
    waves: [], cut: null,
    // stalled — the body stood beside a mob it never touched. Distinct from `cut`: a cut trial was
    // stopped by the GROUND, a stalled trial by the BENCH.
    stalled: null,
    label: controls.label || null,
  };
}

// FIRST BLOOD IS THE WAVE, NOT THE HIT. Recorded on the first wave with any health loss at all,
// including a wave the bot went on to clear.
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

// The kit ladder. Tier 2 → tier 3 is a confound (Law 21): it loses the backup axe and gains the shield in
// the same step; `--kit=` runs the isolating rung (stone sword + stone axe + shield).
//
// The axe is a BACKUP: the weapon picker takes the best thing it holds, so the axe buys a working weapon
// after the sword breaks.
//
// TIER 0 IS BARE FISTS, the reference rung: damage is fixed by the game, not the loadout. An empty kit
// still runs the full kitBot path — inventory WIPED, emptiness read back off the server.
const TIERS = {
  0: { name: 'bare fists', kit: [] },
  1: { name: 'wooden sword + wooden axe', kit: ['wooden_sword', 'wooden_axe'] },
  2: { name: 'stone sword + stone axe', kit: ['stone_sword', 'stone_axe'] },
  3: { name: 'stone sword + shield', kit: ['stone_sword', 'shield'] },
};

// The wave ladder. Two species, escalating one axis at a time:
//   1  one zombie          the floor — a brawler that walks in
//   2  one creeper         the same approach with a FUSE on it: the counter must break off, not trade
//   3  three zombies       the first SWARM, on the mob the bot already beat alone
//   4  one zombie,         tests target SELECTION: the queue must pick between a body it can trade
//      one creeper         with and one it must never be next to when the clock runs out
//
// Neither species produces locomotion data: both walk to the bot, so this ladder says nothing about the
// rush arm (Law 25).
const WAVES = [
  { w: 1, spec: 'zombie:1' },
  { w: 2, spec: 'creeper:1' },
  { w: 3, spec: 'zombie:3' },
  { w: 4, spec: 'zombie:1,creeper:1' },
];

// A CEILING, NOT A WAVE LENGTH: a wave ends when the battle ends. Past this point an unresolved wave is
// recorded `timeout` — a DEFECT reading, not an outcome.
const WAVE_CEILING_SEC = 90;
// Seconds between waves — long enough to settle, short enough that regeneration doesn't carry the bot.
const BETWEEN_SEC = 3;

// THE BODY STANDS SOMEWHERE NEW EVERY TRIAL. The biome hunt is deterministic, which is wrong for
// elevation (Law 25). Candidates come from `siteMobCells`, reused here (Law 16).
//
// THE PICK IS FURTHEST-FROM-USED, not random, so a re-run is reproducible.
//
// Falls back to the hunted cell, out loud, when the ground has no spread — the row then says `spread: false`.
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

// One trial: kit → hunt the biome → place the body → run the waves until it dies or the ladder ends.
// A REFUSED WAVE ENDS THE TRIAL AND MARKS IT CUT, never counted as a defeat (Law 25).
async function runTrial(link, args, usedElevations = []) {
  const tier = TIERS[args.tier];
  const { scout, rcon } = link;

  let at0 = await lanista.readBotVitals(rcon, args.bot);
  if (!at0.known || !at0.position) return { ok: false, why: `the server will not answer for '${args.bot}' — is it connected?` };

  // STAND THE BODY UP BETWEEN TRIALS. Sentry is a MODE the operator owns; a corpse is a PRECONDITION of
  // the trial, cleared through the `respawn` operator verb (Law 16).
  if (!at0.alive) {
    log('revive', `'${args.bot}' is a corpse. Sending the respawn verb — nothing else will (master_core runs respawn:false).`);
    const r = spawnSync(process.execPath, [FLEET_CONTROL, 'verb', 'respawn'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (r.status !== 0) log('revive', `⚠ the verb did not deliver (exit ${r.status}). Reading the body off the server anyway.`);
    // Aliveness is read back off the SERVER, never certified by the process that sent the verb (Law 26).
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

    // STAND THE WATCH BACK UP: death is terminal for the watch loop, not the MODE, so a revived body
    // sits in sentry with nothing turning. Re-armed through the `sentry` verb (Law 16) and not trusted:
    // `awaitStandingWatch` reads the standing row off the journal (Law 26).
    const sr = spawnSync(process.execPath, [FLEET_CONTROL, 'verb', 'sentry'], { cwd: REPO_ROOT, encoding: 'utf8' });
    log('revive', sr.status === 0
      ? 'the watch was retired by the death — sentry re-sent so a fresh watch loop turns for this trial.'
      : `⚠ the sentry verb did not deliver (exit ${sr.status}). The wave gate reads the watch off the journal and will refuse if it never stood.`);
  }
  const origin = { x: Math.floor(at0.position.x), y: Math.floor(at0.position.y), z: Math.floor(at0.position.z) };

  // THE BIOME, FIRST, because it decides where everything else happens. A failed hunt aborts the trial,
  // so the row is never labelled with a biome the fight was not in.
  const hunt = await biomeHunt.huntBiome(scout, rcon, { target: args.biome, origin });
  if (!hunt.found) return { ok: false, why: hunt.why };
  log('biome', hunt.declared
    ? `'${hunt.biome}' at ${fmt(hunt.cell)} — found on hop ${hunt.hops} after ${hunt.scanned} sample(s).`
    : `fighting where the bot stands, in '${hunt.biome || 'an unread biome'}' at ${fmt(hunt.cell)}.`);

  // THE KIT, and it WIPES the inventory (see lanista.kitBot).
  const kit = await lanista.kitBot(rcon, args.bot, tier.kit);
  if (!kit.ok) {
    return { ok: false, why: kit.unclearedDetail
      ? `${args.bot}: ${kit.unclearedDetail} — the server says: ${kit.inventory || '(empty)'}`
      : `${args.bot} is missing ${kit.missing.join(', ')} after the kit replace — the server says: ${kit.inventory || '(empty)'}` };
  }
  log('kit', kit.bare
    ? `tier ${args.tier} — ${tier.name}. ${args.bot}'s inventory was WIPED and left EMPTY, and the server was asked to confirm it holds nothing. Every hit this trial is an unarmed hit.`
    : `tier ${args.tier} — ${tier.name}. ${args.bot}'s inventory was WIPED and replaced; nothing it had earned is in this trial.`);

  // THE BODY IS RESET TOO (Invariant B): health resets in the same breath as the inventory wipe and
  // teleport, via instant_health, so no regeneration tick subsidises the fight.
  const healed = await lanista.healBot(rcon, args.bot);
  if (!healed.ok) {
    return { ok: false, why: `${args.bot} would not heal to full before the trial — the server reports ${healed.health ?? 'nothing'}. ` +
      `A trial opened on a wounded body measures the wound, not the kit.` };
  }
  if (healed.was != null && healed.was < 20) log('heal', `topped the body up from ${round2(healed.was)} to ${healed.health} — every trial opens at full health or it does not open.`);

  // THE ELEVATION CONTROL, chosen before the row opens so the row carries where the body actually stood.
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

  // `args.waves`, never the module table: a scenario replaces the ladder whole.
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
      // Travels onto the row so the exit code reads one classification (Law 16).
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

    // Outcome vocabulary is lanista's own reading of the server (Law 16 — one implementation).
    //   `stalled`  ranks second, under death only: the one outcome that says the wave never happened.
    //   `blown`    finished, took health, left nothing earned — not a death, doesn't end the trial.
    // A stall does not end the trial by itself either; the CONDUCTOR decides what one costs the run.
    const outcome = lanista.waveVerdict(r);
    addWave(row, {
      w: wave.w,
      f: r.wave,
      o: outcome,
      hp: r.hpEnd,
      lost: round2((r.hpLost || 0) + (r.hpLostAfterClear > 0 ? r.hpLostAfterClear : 0)),
      s: Math.round(r.ms / 1000),
      // Lift the ground actually gave this wave, per wave not per trial (Law 25).
      lf: r.liftGot,
    });
    log('wave', `${wave.w}: ${lanista.headline(r)} · hp ${r.hpStart}→${r.hpEnd} · ${(r.ms / 1000).toFixed(1)}s`);

    if (r.botDied) break;
    // A STALL ENDS THE TRIAL: every wave after it would fight the same unengaging body and be reported
    // as a real one. `stalled` on the row is what the conductor reads to decide the session.
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
    // `lift` is per WAVE (the mob stands above the body). `elevationSpread` is per TRIAL (consecutive
    // trials stand at different heights). Both defaults are part of the control.
    lift: parseInt(opt('lift', '2'), 10),
    elevationSpread: parseInt(opt('elevation-spread', '3'), 10),
    label: opt('label', null),
    show: argv.includes('--tiers'),
    // ON BY DEFAULT: an unengaged wave still runs to the ceiling and reads `timeout`. `--stall=0`
    // silences the reading only.
    stallSeconds: parseInt(opt('stall', String(scenarios.DEFAULT_ENGAGE_STALL_SEC)), 10),
    // Which waves this run fights. The module-level table is the default; a scenario replaces it whole.
    waves: WAVES,
  };
  // A NAMED SCENARIO OVERRIDES THE FLAGS, applied before --kit, so there is exactly one place a run's
  // inputs are assembled (Law 16). --kit is read after, for a legible one-item change to a named run.
  const scenarioName = opt('scenario', null);
  a.scenario = null;
  if (scenarioName) {
    const loaded = scenarios.load(scenarioName);
    // Returned, never thrown: the caller turns it into a refusal before a server is touched (Law 13).
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

    // AN EXPLICIT FLAG OUTRANKS THE SCENARIO. GIVEN, not truthy: testing the value would mistake a
    // scenario's default for a typed one (Invariant B).
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
    // Announced, never silent: an altered named run must read as a different run from the declared one.
    a.scenarioOverrides = overrides;
    // The scenario's kit stands in for the tier's, under the tier's number, exactly as --kit does.
    TIERS[s.tier] = { name: s.kit.length ? s.kit.join(' + ').replace(/minecraft:/g, '') : 'bare fists', kit: s.kit };
  }

  const kit = opt('kit', null);
  // --kit overrides the tier's loadout WITHOUT renaming the tier (Law 25).
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
  // A malformed scenario is a usage error and must cost nothing (Law 13).
  if (args.scenarioProblems) {
    console.error(`lanista_ladder: the scenario is REFUSED before touching anything —`);
    for (const p of args.scenarioProblems) console.error(`  · ${p}`);
    return 1;
  }
  if (args.scenario) {
    log('scenario', scenarios.describe(args.scenario));
    // Printed as a CHANGE (was → now), so a reader sees this is not the same experiment.
    if (args.scenarioOverrides && args.scenarioOverrides.length) {
      log('scenario', `⚠ OVERRIDDEN on the command line — ${args.scenarioOverrides.join(' · ')}. ` +
        `This is NOT the declared '${args.scenario.name}' run.`);
    }
  }
  if (!TIERS[args.tier]) {
    console.error(`lanista_ladder: no tier ${args.tier}. Tiers are ${Object.keys(TIERS).join(', ')} — see --tiers.`);
    return 1;
  }

  // THE AGGRO-FIT GATE runs on both routes into a fight (Law 16). Refused here it is exit 1: the run
  // DEFINITION cannot run, not the terrain (Law 25).
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
    // NATURAL SPAWNING OFF, so the only mobs in the trial are the ones the ladder summons.
    await link.rcon.command('gamerule spawn_mobs false');
    const spawning = ((await link.rcon.command('gamerule spawn_mobs')) || '').trim();
    log('world', `${spawning} — the only mobs in this trial are the ones the ladder summons.`);

    // Carried ACROSS trials, which is what makes elevation a control.
    const usedElevations = [];
    // Every trial that actually ran, this session only. Spent when the process exits.
    const done = [];

    for (let t = 1; t <= args.trials; t++) {
      log('trial', `${t}/${args.trials} — tier ${args.tier} (${TIERS[args.tier].name}) vs ${args.waves.length} wave(s), biome '${args.biome}'`);
      const r = await runTrial(link, args, usedElevations);
      if (!r.ok) {
        // A trial that never started is not counted as one (Law 25).
        log('trial', `${t}/${args.trials} — NOT RUN: ${r.why}`);
        // EXIT 4 WHEN THE BODY WOULD NOT COME BACK, not 2: a re-run elsewhere is false of a corpse (Law 25).
        exitCode = r.dead ? 4 : 2;
        continue;
      }
      // Reported as it closes and kept only in `done`: no file outlives the run (Invariant B).
      done.push(r.row);
      log('trial', `${t}/${args.trials} - reached wave ${r.row.reached}, cleared ${r.row.cleared}, `
        + `first blood ${r.row.blood ?? 'never'}, ${r.row.died ? `died on ${r.row.died}` : 'survived the ladder'} `
        + `- ${Math.round(r.row.sec)}s - trial ${t} of ${args.trials} this session`)
      // ONE CODE PER OWNER (Invariant D): terrain → roll different ground; bot → read the fleet;
      // bench → look at the server.
      if (r.row.cut) exitCode = r.row.cutCause === 'bot' ? 5 : r.row.cutCause === 'bench' ? 6 : 2;
      // EXIT 3, ITS OWN CODE: a stall measured the BENCH, not the terrain, and re-running changes
      // nothing (Law 25).
      if (r.row.stalled) { log('trial', `${t}/${args.trials} — ⚠ STALLED: ${r.row.stalled}`); exitCode = 3; }
      if (t < args.trials) await sleep(5000);
    }

    // THE SESSION'S OWN SUMMARY: nothing outlives the process. The operator writes the conclusion into
    // a markdown.
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
