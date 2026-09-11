// Auren_Workshop/tools/lanista_scenario.js
// The DECLARED shape of a lanista run: what the bot holds, how many waves it faces, what is in each one,
// and how long a wave may go unengaged before the run is called a stall.
//
// The scenario declares exactly three things — kit, wave count, and mobs per wave — and everything else
// about a run is automatic. That constraint shapes everything this file refuses to hold. It is DATA and
// a VALIDATOR — no server, no rcon, no fight. It answers "what was asked for", never "what happened".
//
// ── WHY A RECORD AND NOT FLAGS ──────────────────────────────────────────────────────────────────────
// `lanista_ladder` already takes `--tier`, `--kit`, `--range`, `--ceiling`, `--lift`, `--trials` and
// `--elevation-spread`. Seven flags is a run definition that exists only in whoever typed it, and two
// runs are then comparable only if the same hands remembered the same seven — the recollection-as-record
// failure Invariant B names. A named scenario is the same information with an owner and a spelling, so
// "run the creeper gauntlet again" is a sentence a machine can execute.
//
// ── WHAT THIS FILE MAY NOT GROW ─────────────────────────────────────────────────────────────────────
// It holds no thresholds ABOUT THE BOT — nothing that says how much damage is acceptable, how deep a
// tier should get, or what counts as a good run. Those are verdicts and their criterion is the
// Architect's alone (Law 25). Every number below is an INPUT the world is set to, or a ceiling past
// which the bench stops waiting; not one of them is a standard the bot is measured against.
//
// The wave table's own reasoning — why zombies and creepers, why wave 4 is the selection test, what was
// lost when the archer wave went — lives in `lanista_ladder.js` above WAVES and is not restated here
// (Law 14: one home per WHY). What lives here is which of those waves a given scenario runs.

'use strict';

// ── The stall ────────────────────────────────────────────────────────────────────────────────────────
//
// A run tears down on death, wave completion, or a stall — a stall being the bot failing to engage a
// mob within a bounded window. That single requirement splits into TWO DIFFERENT SILENCES, and folding
// them into one number would make the run's report a lie:
//
//   ENGAGE — the mob is summoned and standing in aggro range, and the bot never swings. That is the
//     condition that means the bench is broken rather than the fight is hard.
//     30 s because a mob summoned inside its own aggro range is honoured on the tick it exists and the
//     bot's watch polls sub-second; a body that has not reacted in thirty seconds is not deciding
//     slowly, it is not deciding.
//
//   CEILING — the fight started and has not finished. That number already exists and already has an
//     owner (`lanista_ladder`'s WAVE_CEILING_SEC, 90 s, sitting just past battle_stations' own 60 s
//     per-target guard). It is carried here so a scenario can raise it for a wave with more bodies in
//     it, never so this file can re-decide what it means.
//
// A stall is a DEFECT READING, never a defeat. The run that hits one proves nothing about the kit, and
// the conductor's exit code says so separately from a death.
const DEFAULT_ENGAGE_STALL_SEC = 30;
const DEFAULT_WAVE_CEILING_SEC = 90;

// ── THE ESCALATING SWARM ────────────────────────────────────────────────────────────────────────────
//
// Three waves of one zombie, then every wave after adds one more: 1, 1, 1, 2, 3, 4, 5 … and the run
// ends where the bot ends, not where the table does.
//
// WHY THREE SINGLES AND NOT ONE. A single zombie is the tuning wave — one body, one approach curve, no
// target switching — and swing distance is the thing being measured. One sample of it is a reading; three
// is a spread, and the spread is what says whether a good median came from consistency or from luck. The
// escalation then starts from a floor that has already been characterised, so a wave-4 miss is about the
// second body and cannot be about the first.
//
// GENERATED, NOT TYPED OUT. Fourteen hand-written rows would be fourteen chances to typo a count into a
// table whose whole meaning is that the count goes up by exactly one (the validator checks the FORM of a
// spec and cannot know that `zombie:7` was meant to be `zombie:6`). The generator makes the rule itself
// the declaration.
//
// THE 14 IS A BACKSTOP, NOT A DESIGN. "until the bot loses" is the real stop rule and `lanista_ladder`
// already enforces it (`if (r.botDied) break`). This number only bounds the case where the bot never
// loses, and 12 zombies against one body is far past where that stops being a question about the kit.
// A run that ever REACHES wave 14 is a result worth reading on its own, not a table that needs extending.
const ESCALATION_MAX_WAVES = 14;
const SINGLES_BEFORE_ESCALATION = 3;

function escalatingZombies(maxWaves = ESCALATION_MAX_WAVES, singles = SINGLES_BEFORE_ESCALATION) {
  const waves = [];
  for (let w = 1; w <= maxWaves; w++) {
    waves.push({ w, spec: `zombie:${w <= singles ? 1 : w - singles + 1}` });
  }
  return waves;
}

// The wave the ladder runs when a scenario names no other. Kept identical to `lanista_ladder`'s own
// WAVES table so the default scenario reproduces today's ladder exactly — a config that silently
// changed what `--tier=1` has always meant would make every ledger row before it incomparable.
const LADDER_WAVES = [
  { w: 1, spec: 'zombie:1' },
  { w: 2, spec: 'creeper:1' },
  { w: 3, spec: 'zombie:3' },
  { w: 4, spec: 'zombie:1,creeper:1' },
];

// ── The scenarios ───────────────────────────────────────────────────────────────────────────────────
//
// `kit` is a LIST OF ITEM IDS, not a tier number, because the tier is a rung of one particular ladder
// and a scenario is free not to be on it. A scenario that wants a rung names the rung's items; the
// ledger row then records what was actually worn (`lanista_ladder`'s --kit header has the reasoning).
// An EMPTY list is meaningful and is not the same as an absent one: it means bare fists, the ladder's
// tier 0, and the inventory is wiped and the emptiness read back off the server.
const SCENARIOS = {
  ladder: {
    blurb: 'the standing kit ladder — wooden sword + axe against the four-wave table, to the death.',
    kit: ['wooden_sword', 'wooden_axe'],
    tier: 1,                       // which rung this stands in for, recorded on the ledger row
    waves: LADDER_WAVES,
    biome: 'any',
    range: 12,
    lift: 2,
    trials: 1,
    elevationSpread: 3,
    ceilingSeconds: DEFAULT_WAVE_CEILING_SEC,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  fists: {
    blurb: 'tier 0 — bare fists against the same four waves. The reference every armed rung is read against.',
    kit: [],
    tier: 0,
    waves: LADDER_WAVES,
    biome: 'any',
    range: 12,
    lift: 2,
    trials: 1,
    elevationSpread: 3,
    ceilingSeconds: DEFAULT_WAVE_CEILING_SEC,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // A SINGLE SPECIES, ESCALATING COUNT — the shape his ask describes most directly ("control the wave
  // numbers and monsters per wave"). One axis moves, so a wave the bot fails is a statement about crowd
  // size and cannot be about which mob arrived.
  swarm: {
    blurb: 'stone sword + shield vs zombies. Wave N is N zombies, 1 up to 10, until the bot loses.',
    kit: ['stone_sword', 'shield'],
    tier: 3,
    // ── ONE SINGLE, THEN STRAIGHT UP ─────────────────────────────────────────────────────────────────
    // A single characterising wave, not three: the three-single repeat existed to give the swing
    // distance a spread rather than one sample, but once the single-zombie wave is characterised the
    // repeats buy nothing and cost run budget before the crowd is ever tested. Wave N is N zombies, so
    // the wave number IS the count and a failure names its own crowd size.
    waves: escalatingZombies(10, 1),
    // 'open' — TREELESS GROUND. This scenario measures attack, not pathfinding, so obstacles between bot
    // and mob are a confound rather than a variable under test. It declared 'plains' first, then fell to
    // 'any' when the hunt could not land it on the one bench world — which let swing tuning run through
    // forest canopy, with foliage repeatedly blocking the cast. A group is the repair: strictly more
    // findable than one name, strictly more controlled than 'any', and the row still records the one
    // biome the floor actually was (lanista_biome.OPEN_GROUND).
    biome: 'open',
    // ── LIFT 0, AND THAT IS A DELIBERATE LOSS ────────────────────────────────────────────────────────
    // The lift exists to make the approach climb, which exercises the sprint-jump (see lanista_ladder's
    // elevation control). It also puts the mob on a lip, and a shove off a lip travels a distance the
    // impulse did not buy — the same reason `creeper_basic` sits flat. This scenario is now the SWING
    // DISTANCE instrument, so the terrain confound loses to the measurement. The sprint-jump is no longer
    // covered here; it is covered by `ladder`, and that is the trade written down rather than discovered.
    lift: 0,
    range: 12,
    trials: 1,
    // Flat for the same reason lift is 0: a swing distance must be a decision, not a slope.
    elevationSpread: 0,
    // The ceiling is a "this is not happening" line, not an expected duration, and the late waves put
    // eight or more bodies in the field. Raised over the 90 s default so a genuinely long crowd wave is
    // not filed as a defect.
    ceilingSeconds: 120,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // ── THE STALL PROBE — a run built to END IN A STALL, on purpose ───────────────────────────────────
  //
  // Spawning no monster at all does not produce a stall, even though it looks like it should. WHY, both
  // gates, because a successor will try it too:
  //
  //   1. `runWave` refuses a wave nothing was placed for and returns NOT RUN. That is exit 2 (cut
  //      short), not exit 3 (stall). It never reaches the fight observer at all, so the stall clock
  //      never starts.
  //   2. Even past that gate, `observeFight` breaks on an EMPTY FIELD after a 3 s floor. A field that was
  //      never populated reads as "the field emptied" three seconds in — long before any stall window.
  //
  // Both of those are the bench working. A wave that summons nothing is a wave that did not happen, and
  // it is already reported as exactly that; the stall is a different fault — the wave DID happen and the
  // body did not answer it.
  //
  // SO THE PROBE SUMMONS A PASSIVE MOB. A chicken is placed at fighting distance, carries the arena tag,
  // and is counted by the field read — so the field never empties and the ceiling is the only other way
  // out. It never aggros, `battle_stations` never admits it, and a sentry bot has no planning recursion
  // to go and do anything else about it. Nothing exchanges damage, which is the exact condition a stall
  // is defined by: the mob is present and reachable and the bot never engages it.
  //
  // The bot is ARMED with a stone sword deliberately: an unarmed probe would leave "it never swung" and
  // "it had nothing to swing" as two live explanations for one result.
  //
  // 20 s and not 30 so the probe is quick, and it is still well under the 60 s ceiling — the ordering is
  // what makes the stall reachable at all, and the validator refuses the inversion.
  stall_probe: {
    blurb: 'DIAGNOSTIC — a passive mob at fighting distance. Proves the stall fires and the conductor tears down.',
    kit: ['stone_sword'],
    tier: 2,
    waves: [{ w: 1, spec: 'chicken:1' }],
    biome: 'any',
    range: 12,
    // Flat and unvaried: this probe measures the DETECTOR, so every control that exists to vary the
    // fight is turned off. A stall found on sloped ground would leave the terrain as an explanation.
    lift: 0,
    trials: 1,
    elevationSpread: 0,
    ceilingSeconds: 60,
    engageStallSeconds: 20,
  },

  // ── THE KNOCKBACK REPRODUCTION ──────────────────────────────────────────────────────────────────────
  //
  // A basic creeper test with a stone sword, isolating why creeper knockback is unreliable and lets a
  // detonation through.
  //
  // It sits BESIDE `creepers` rather than replacing it because the two ask different questions. `creepers`
  // escalates to a pair on wave 3, so its last wave confounds knockback-per-hit with target selection. This
  // one runs the SAME wave twice and changes nothing between them, so any difference between wave 1 and
  // wave 2 is the variance itself — which is precisely the thing under investigation. A scenario whose two
  // waves differ could not answer "is it unreliable"; it could only answer "is it worse against two".
  //
  // lift 0 and the widest range the creeper's aggro honours are both inherited from `creepers` for the
  // reasons stated there. Flat is load-bearing here and not merely inherited: knockback is a horizontal
  // impulse, and a mob shoved off a lip travels a distance the impulse did not buy (Law 25 — the
  // `--knockback` lens would report a true number about the wrong cause).
  creeper_basic: {
    blurb: 'stone sword vs ONE creeper, twice. Identical waves — the variance between them IS the reading.',
    kit: ['stone_sword'],
    tier: 2,
    waves: [
      { w: 1, spec: 'creeper:1' },
      { w: 2, spec: 'creeper:1' },
    ],
    biome: 'any',
    // 13, NOT the 14 `creepers` declares. The siting band is ±2b (lanista.SITE_BAND_SLACK) and a creeper
    // is honoured to 15b, so 14 asks for a body as far out as 16 and whether the round runs is decided by
    // which cell the terrain offered. `lanista.rangeFitsAggro` already holds that arithmetic and names 13
    // as the most this wave can ask for.
    range: 13,
    lift: 0,
    trials: 1,
    // Zero because one trial has nothing to vary against — `pickStand` would spend a siteMobCells sweep
    // to pick a cell whose separation from an empty used-set is Infinity by construction.
    elevationSpread: 0,
    ceilingSeconds: DEFAULT_WAVE_CEILING_SEC,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // ── FOUR IDENTICAL SINGLE-CREEPER WAVES ─────────────────────────────────────────────────────────────
  //
  // Verifies that nothing ever gates a swing — the bot should always be attacking any monster it can
  // reach — and measures the distance every swing happens at.
  //
  // `creeper_basic` is the same wave twice and is the KNOCKBACK question; this is the same wave FOUR
  // times and is the GATING question. Four and not two because the claim under test is "always" — a
  // gate that fires occasionally (a cooldown, a sightline refusal, a target reselect) is a per-wave coin
  // flip, and two waves cannot distinguish "never gated" from "not gated this time". Every parameter is
  // copied from `creeper_basic` rather than re-chosen so the two are read against each other: range 13
  // is the aggro-fit ceiling (see that scenario), lift 0 and spread 0 keep the ground flat so a swing
  // distance is a decision and not a slope.
  creeper_quad: {
    blurb: 'stone sword vs ONE creeper, four times. Identical waves — the swing-gating probe.',
    kit: ['stone_sword'],
    tier: 2,
    waves: [
      { w: 1, spec: 'creeper:1' },
      { w: 2, spec: 'creeper:1' },
      { w: 3, spec: 'creeper:1' },
      { w: 4, spec: 'creeper:1' },
    ],
    biome: 'any',
    range: 13,
    lift: 0,
    trials: 1,
    elevationSpread: 0,
    ceilingSeconds: DEFAULT_WAVE_CEILING_SEC,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // The fuse. Every wave demands the counter break off rather than trade, and nothing else varies.
  //
  // SHIELDED, and that is a second question layered on the first rather than a new scenario. The
  // guard's swell branch is the half that has never run against a server: the guard raises for two
  // reasons (a notched arrow, a swell), `kiters` exercises the arrow, and nothing summons a creeper but
  // this. The break-off is still the primary reading — a shield does not save a
  // bot that is standing in the blast — so what to watch for is the ORDER: the driver's flee is the
  // answer to a fuse, and the guard is what covers the tick it did not get away in.
  //
  // The swell raises LATER than an arrow (1000 ms into a 1500 ms fuse against 500 ms into a 1000 ms
  // draw), so on a wave where the bot breaks off cleanly the correct reading is ZERO raises. A run
  // reporting `[swell×N]` on every wave means the flee is late, not that the guard is working.
  creepers: {
    blurb: 'stone sword + shield vs creepers only, 1 → 1 → 2. Every wave is a break-off test, not a trade.',
    kit: ['stone_sword', 'shield'],
    tier: 3,
    waves: [
      { w: 1, spec: 'creeper:1' },
      { w: 2, spec: 'creeper:1' },
      { w: 3, spec: 'creeper:2' },
    ],
    // 'open'. It declared 'plains' first, until a live run was CUT by the terrain — the one bench world
    // spawns into birch_forest/stony_shore and a single-name hunt could not land, so it fell back to
    // 'any' on the rule that a scenario which cannot run on the only world there is is a declaration and
    // not a bench (Law 25). The group fixes the original problem without the fallback: seven names, and
    // `kiters` has landed it repeatedly.
    //
    // AND 'any' STOPPED BEING FREE when SITING.ground arrived. A fuse test fought on a cliff over water is
    // the confound that killed a `kiters` trial with fall damage before it reached the mob; with the dial
    // declared, 'any' means the sweep hunts an acceptable anchor inside unacceptable country and pays the
    // whole frontier for it. The biome name steers the hunt, the ground dial polices the anchor — two
    // scopes, and leaving the first one open makes the second one expensive.
    biome: 'open',
    // Wider than the ladder's 12: a creeper honoured at 15 b gives the bot approach distance to decide
    // in. Sited any closer and the first decision it makes is already inside blast radius, which tests
    // the blast rather than the decision.
    //
    // 13 AND NOT 14. 14 was the widest that "fits under 15" by eye, and it does not fit: the siting band
    // is ±2b, so it asks for a creeper as far out as 16 and the round then runs or not depending on the
    // cell the ground offered. `lanista.rangeFitsAggro` computes the ceiling (radius − band) and says 13.
    range: 13,
    lift: 0,
    trials: 1,
    elevationSpread: 3,
    ceilingSeconds: DEFAULT_WAVE_CEILING_SEC,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // ── THE ONLY SCENARIO THAT CAN RAISE THE SHIELD — no other one summons a thing worth blocking ──────
  //
  // The gunner guards for exactly two reasons: a creeper's swell and a skeleton's notched arrow. Trading
  // blows with a brawling mob is pointless — the raise costs 5 ticks before the block is live plus the
  // swings given up while the item is in use, and against a brawler that trade is a loss. `ladder`,
  // `swarm` and `fists` summon zombies only, so the ARROW half of the guard cannot run in any of them;
  // this is the one place it can.
  //
  // WHAT TO READ, AND WHY IT IS NOT THE RAISE COUNT. A toggle and a timer both end the wave with the
  // shield having been up, so "it blocked" proves nothing about the ruling. The claim is that the guard
  // comes up LATE — `raised N time(s) (notched_arrow N)` beside the gunner's swing count, and the swings
  // are the number that moves: a toggle spends the whole 1 s draw behind the shield, the timer spends
  // 500 ms of it swinging. Compare against a run with the shield out of the kit.
  //
  // THE THIRD WAVE IS THE POINT, not the first two. One skeleton proves the branch executes; a skeleton
  // and a zombie in the same field is the only place the FACING SPLIT is observable — the zombie is the
  // closest mob and the archer is the threat, so the guard must take the facing off the closest and the
  // gunner's `faced the threat over the closest on N tick(s)` must be non-zero on that wave alone.
  //
  // ARMED WITH A BOW ON PURPOSE. A skeleton summoned without one has no ranged attack at all — Java falls
  // through to melee — which would make it a brawler wearing a kiter's name, and with the guard keyed to
  // the notch rather than the species it would now test NOTHING AT ALL rather than merely testing less
  // (`lanista_ladder`'s header records that measurement). Open ground and lift 0 for the same reasons
  // `swarm` carries them: an arrow blocked by a birch trunk and a shove off a lip are both terrain
  // answering a question that was asked of the decision.
  //
  // WAVE 1 IS EXPECTED TO BE SURVIVABLE. On `hard` difficulty with no armour, a stone-sword bot needs
  // roughly 9 s to close and kill against roughly 3.5 s of arrows — the shield is the answer to that
  // arithmetic. If wave 1 still dies with the guard raising on time, the shortfall is armour and the
  // ladder has no armour tier to give it.
  kiters: {
    blurb: 'stone sword + shield vs bowed skeletons, 1 → 2 → 1 skeleton + 1 zombie. The only scenario that notches an arrow.',
    kit: ['stone_sword', 'shield'],
    tier: 3,
    waves: [
      { w: 1, spec: 'skeleton:1@bow' },
      { w: 2, spec: 'skeleton:2@bow' },
      { w: 3, spec: 'skeleton:1@bow,zombie:1' },
    ],
    biome: 'open',
    // A skeleton is honoured to 16 b rather than the flat 15 (architect_config's per-species table), so
    // the ceiling `lanista.rangeFitsAggro` computes is 14 — one wider than `creepers`. Sited at 13 anyway:
    // the extra block buys nothing the approach needs and the ±2 b siting band would put the far edge at
    // 15, where a round runs or not depending on the cell the ground offered.
    range: 13,
    lift: 0,
    trials: 1,
    elevationSpread: 0,
    // Wider than the default: a kiter that backs away turns every approach into a chase, and a wave that
    // takes longer BECAUSE the mob retreats is the scenario working, not a stall to be filed as a defect.
    ceilingSeconds: 120,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // ── THE CONTROL ARM FOR `kiters` — SAME WAVES, NO SHIELD ──────────────────────────────────────────
  // THIS EXISTS TO SETTLE A PREMISE THE FLEET HAS NEVER MEASURED, and it is a data row rather than a
  // code branch precisely so it settles it by OUTCOME (Law 26: the guarantee is the real run; a
  // simulated answer would be the removal of the only thing behind it).
  //
  // THE PREMISE: that raising a shield against a notched arrow is worth what it costs. The cost is not
  // theoretical — while an item is in use the body moves at a fraction of walking speed and cannot
  // sprint, so the guard suppresses sprint for a meaningful share of a wave against archers. Against a
  // mob that backs away, a bot that cannot move is a bot that cannot reach.
  //
  // A shieldless bot faces exactly the same waves at the same range with the same sword, so the
  // difference in skeletons killed is the shield's whole contribution, positive or negative. Identical
  // in every other field on purpose — a control arm that also changes the range or the biome measures
  // nothing.
  kiters_noshield: {
    blurb: 'the kiters control arm: stone sword ONLY vs the same bowed skeletons — prices the shield by its absence.',
    kit: ['stone_sword'],
    tier: 3,
    waves: [
      { w: 1, spec: 'skeleton:1@bow' },
      { w: 2, spec: 'skeleton:2@bow' },
      { w: 3, spec: 'skeleton:1@bow,zombie:1' },
    ],
    biome: 'open',
    range: 13,
    lift: 0,
    trials: 1,
    elevationSpread: 0,
    ceilingSeconds: 120,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },
};

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────
//
// Every one of these is a shape a human can write and a server will accept HALFWAY — a wave spec with a
// zero count summons nothing and reads as an instant clear; a negative stall never fires and the run
// hangs to the ceiling on every wave. Both produce a run that looks like it happened (Law 25), so the
// refusal has to land here, before a world is touched, and it names the field.
//
// It validates FORM, never worth. Whether `zombie:5` is a sensible wave is the Architect's question and
// this function must never grow an opinion about it (Law 26 — a machine enforces authored forms, it
// never authors them).
const WAVE_SPEC = /^[a-z_]+:[1-9][0-9]*(@[a-z_]+)?(,[a-z_]+:[1-9][0-9]*(@[a-z_]+)?)*$/;

function validate(name, s) {
  const bad = [];
  if (!s || typeof s !== 'object') return [`scenario '${name}' is not a record`];

  if (!Array.isArray(s.kit)) bad.push('`kit` must be an array of item ids (an EMPTY array means bare fists — that is legal and deliberate)');
  else if (s.kit.some(i => typeof i !== 'string' || !i.trim())) bad.push('`kit` holds a non-string or blank item id');

  if (!Array.isArray(s.waves) || !s.waves.length) bad.push('`waves` must be a non-empty array — a scenario with no waves is a run that cannot happen');
  else {
    s.waves.forEach((w, i) => {
      if (typeof w.spec !== 'string' || !WAVE_SPEC.test(w.spec)) {
        bad.push(`wave ${i + 1}: spec ${JSON.stringify(w.spec)} is not \`mob:count[@hand]\` with count ≥ 1 ` +
          `(a zero count summons nothing and the wave then reads as an instant clear)`);
      }
      if (!Number.isInteger(w.w) || w.w < 1) bad.push(`wave ${i + 1}: \`w\` must be its 1-based number`);
    });
    // The number is what the ledger and every downstream depth figure are keyed on, so a duplicate or a
    // gap silently makes two different waves the same row.
    const ns = s.waves.map(w => w.w);
    if (new Set(ns).size !== ns.length) bad.push(`\`waves\` has duplicate numbers (${ns.join(', ')}) — depth figures key on them`);
  }

  for (const [f, min] of [['range', 1], ['trials', 1], ['ceilingSeconds', 1], ['engageStallSeconds', 1]]) {
    if (!Number.isFinite(s[f]) || s[f] < min) bad.push(`\`${f}\` must be a number ≥ ${min} (got ${JSON.stringify(s[f])})`);
  }
  for (const f of ['lift', 'elevationSpread', 'tier']) {
    if (!Number.isInteger(s[f]) || s[f] < 0) bad.push(`\`${f}\` must be an integer ≥ 0 (got ${JSON.stringify(s[f])})`);
  }
  if (typeof s.biome !== 'string' || !s.biome.trim()) bad.push('`biome` must be a name or the string `any`');

  // A stall that outlasts the ceiling can never fire: the wave gives up first and every unengaged wave
  // is then recorded as a slow fight instead of a bench that is not working. The two numbers mean
  // different things and the ordering between them is what keeps both readable (Law 25).
  if (Number.isFinite(s.engageStallSeconds) && Number.isFinite(s.ceilingSeconds) && s.engageStallSeconds >= s.ceilingSeconds) {
    bad.push(`\`engageStallSeconds\` (${s.engageStallSeconds}) must be BELOW \`ceilingSeconds\` (${s.ceilingSeconds}) — ` +
      `a stall that outlasts the ceiling never fires, and every unengaged wave is then filed as a slow fight`);
  }
  return bad;
}

// Returns { ok, scenario, problems } — never throws and never exits. A machine-facing reader
// (CLAUDE.md standing rule: lenses RETURN, they do not process.exit), so the caller owns what a refusal
// costs: a conductor turns it into a refusal before bring-up, a bench turns it into a failed assertion.
function load(name) {
  const s = SCENARIOS[name];
  if (!s) return { ok: false, problems: [`no scenario '${name}'. Declared: ${Object.keys(SCENARIOS).join(', ')}`] };
  const problems = validate(name, s);
  return problems.length ? { ok: false, problems } : { ok: true, scenario: { name, ...s } };
}

// The one-line description of a run, composed rather than interpreted: it restates the declaration in a
// sentence, and states nothing the declaration does not already hold.
function describe(s) {
  const mobs = s.waves.map(w => w.spec).join(' → ');
  return `${s.name}: ${s.kit.length ? s.kit.join(' + ') : 'BARE FISTS'} · ${s.waves.length} wave(s) [${mobs}] · ` +
    `biome '${s.biome}' at ${s.range}b, lift ${s.lift} · ${s.trials} trial(s) · ` +
    `stall ${s.engageStallSeconds}s, ceiling ${s.ceilingSeconds}s`;
}

function list() {
  return Object.entries(SCENARIOS).map(([name, s]) => ({ name, blurb: s.blurb, waves: s.waves.length, kit: s.kit }));
}

module.exports = {
  SCENARIOS, LADDER_WAVES, WAVE_SPEC,
  DEFAULT_ENGAGE_STALL_SEC, DEFAULT_WAVE_CEILING_SEC,
  ESCALATION_MAX_WAVES, SINGLES_BEFORE_ESCALATION, escalatingZombies,
  load, validate, describe, list,
};
