// Auren_Workshop/tools/lanista_scenario.js
// The DECLARED shape of a lanista run: kit, wave count, mobs per wave, and the stall window. DATA and a
// VALIDATOR — no server, no rcon, no fight. A named scenario, not flags, so a run stays comparable
// across sessions (Invariant B). Holds no thresholds ABOUT THE BOT (Law 25); every number here sets the
// world or bounds the bench's wait. The wave table's own reasoning lives in `lanista_ladder.js` above
// WAVES (Law 14).

'use strict';

// ── The stall ────────────────────────────────────────────────────────────────────────────────────────
// A run tears down on death, wave completion, or a stall. ENGAGE times how long a summoned, in-range mob
// may go unswung-at; CEILING (mirrors lanista_ladder's WAVE_CEILING_SEC) times an engaged fight. A stall
// is a DEFECT READING, never a defeat, marked apart from a death in the conductor's exit code.
const DEFAULT_ENGAGE_STALL_SEC = 30;
const DEFAULT_WAVE_CEILING_SEC = 90;

// ── THE ESCALATING SWARM ────────────────────────────────────────────────────────────────────────────
// Generates the wave table for an escalating swarm: three single zombies, then one more added each wave
// (1, 1, 1, 2, 3, 4, 5 …), up to a backstop wave count — the run ends where the bot ends, not the table.
const ESCALATION_MAX_WAVES = 14;
const SINGLES_BEFORE_ESCALATION = 3;

function escalatingZombies(maxWaves = ESCALATION_MAX_WAVES, singles = SINGLES_BEFORE_ESCALATION) {
  const waves = [];
  for (let w = 1; w <= maxWaves; w++) {
    waves.push({ w, spec: `zombie:${w <= singles ? 1 : w - singles + 1}` });
  }
  return waves;
}

// The wave table `lanista_ladder` itself runs — kept identical so ledger rows stay comparable across
// runs.
const LADDER_WAVES = [
  { w: 1, spec: 'zombie:1' },
  { w: 2, spec: 'creeper:1' },
  { w: 3, spec: 'zombie:3' },
  { w: 4, spec: 'zombie:1,creeper:1' },
];

// ── The scenarios ───────────────────────────────────────────────────────────────────────────────────
// `kit` is a list of item ids, not a tier number — a scenario need not sit on the ladder's rungs. An
// empty list means bare fists (tier 0), inventory wiped.
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

  // Single species, escalating count. One axis moves, so a failed wave is a statement about crowd size
  // alone.
  swarm: {
    blurb: 'stone sword + shield vs zombies. Wave N is N zombies, 1 up to 10, until the bot loses.',
    kit: ['stone_sword', 'shield'],
    tier: 3,
    // Wave N is N zombies, so the wave number IS the count.
    waves: escalatingZombies(10, 1),
    // Treeless ground: canopy between bot and mob would confound the swing distance under test.
    biome: 'open',
    // Flat: a shove off a lip travels a distance the impulse didn't buy. Sprint-jump lives in `ladder`.
    lift: 0,
    range: 12,
    trials: 1,
    elevationSpread: 0,
    // Raised over the default: late waves field eight-plus bodies; a long crowd wave is not a defect.
    ceilingSeconds: 120,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // ── THE STALL PROBE — built to end in a stall, on purpose ────────────────────────────────────────
  // Proves the stall detector fires: a passive chicken, present and reachable but never aggroing, so
  // only the ceiling can end the wave (a wave summoning nothing exits a different path before the stall
  // clock starts). The bot carries a sword so "never swung" can't be read as "had nothing to swing".
  stall_probe: {
    blurb: 'DIAGNOSTIC — a passive mob at fighting distance. Proves the stall fires and the conductor tears down.',
    kit: ['stone_sword'],
    tier: 2,
    waves: [{ w: 1, spec: 'chicken:1' }],
    biome: 'any',
    range: 12,
    // Flat: this probe measures the detector, so terrain cannot be the explanation for a stall.
    lift: 0,
    trials: 1,
    elevationSpread: 0,
    ceilingSeconds: 60,
    engageStallSeconds: 20,
  },

  // ── THE KNOCKBACK REPRODUCTION ──────────────────────────────────────────────────────────────────────
  // Isolates creeper knockback reliability: the same single-creeper wave run twice, unchanged, so any
  // difference between runs is the variance itself. Sits beside `creepers`, whose wave 3 pairs creepers
  // and would confound knockback-per-hit with target selection. Flat ground (Law 25).
  creeper_basic: {
    blurb: 'stone sword vs ONE creeper, twice. Identical waves — the variance between them IS the reading.',
    kit: ['stone_sword'],
    tier: 2,
    waves: [
      { w: 1, spec: 'creeper:1' },
      { w: 2, spec: 'creeper:1' },
    ],
    biome: 'any',
    // The widest range `lanista.rangeFitsAggro` allows a creeper (15b aggro, ±2b siting band).
    range: 13,
    lift: 0,
    trials: 1,
    elevationSpread: 0,
    ceilingSeconds: DEFAULT_WAVE_CEILING_SEC,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // ── FOUR IDENTICAL SINGLE-CREEPER WAVES ─────────────────────────────────────────────────────────────
  // The gating question, as `creeper_basic` is the knockback question: verifies the bot always swings at
  // a reachable mob. Four repeats, not two, so an occasional gate cannot pass as "never gated".
  // Parameters copied from `creeper_basic` so the two read against each other.
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

  // The fuse test: every wave demands the counter break off before the blast. Shielded, so the guard's
  // swell branch also runs, but break-off is the primary reading — a shield does not save a bot
  // standing in the blast. On a clean break-off the correct reading is ZERO swell raises; `[swell×N]`
  // on every wave means the flee is late, not the guard.
  creepers: {
    blurb: 'stone sword + shield vs creepers only, 1 → 1 → 2. Every wave is a break-off test, not a trade.',
    kit: ['stone_sword', 'shield'],
    tier: 3,
    waves: [
      { w: 1, spec: 'creeper:1' },
      { w: 2, spec: 'creeper:1' },
      { w: 3, spec: 'creeper:2' },
    ],
    // A biome group (not 'any'): the biome name steers the hunt, a separate ground dial polices the
    // anchor against fall-damage terrain.
    biome: 'open',
    // Wider than the ladder's 12, giving approach distance before the blast radius (rangeFitsAggro's ceiling).
    range: 13,
    lift: 0,
    trials: 1,
    elevationSpread: 3,
    ceilingSeconds: DEFAULT_WAVE_CEILING_SEC,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // ── THE ONLY SCENARIO THAT CAN RAISE THE SHIELD ON AN ARROW ───────────────────────────────────────
  // The only scenario summoning a notched-arrow threat, so it is the one place the guard's arrow branch
  // runs. Reads whether the shield raises LATE — `raised N time(s) (notched_arrow N)` beside the
  // gunner's swing count. Wave 3 pairs a skeleton with a zombie, the only place the facing split
  // (`faced the threat over the closest on N tick(s)`) is observable.
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
    // Under the aggro ceiling `rangeFitsAggro` computes for a skeleton's wider range.
    range: 13,
    lift: 0,
    trials: 1,
    elevationSpread: 0,
    // Raised over the default: a retreating kiter turns approach into a chase, not a stall.
    ceilingSeconds: 120,
    engageStallSeconds: DEFAULT_ENGAGE_STALL_SEC,
  },

  // ── THE CONTROL ARM FOR `kiters` — same waves, no shield ──────────────────────────────────────────
  // Prices the shield by its absence: identical waves, range and sword, shield removed. The guard
  // suppresses sprint while raised, costing mobility against a retreating mob, so the kill difference is
  // the shield's whole contribution, measured by outcome (Law 26).
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
// Refuses a scenario before a world is touched: a shape a human can write but the server accepts only
// halfway (a zero count, a negative stall). Validates FORM only — never whether a wave is sensible
// (Law 26).
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
    // Wave numbers key the ledger and every downstream depth figure; a duplicate silently merges rows.
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

  // A stall that outlasts the ceiling can never fire: the wave gives up first, so an unengaged wave
  // reads as a slow fight (Law 25).
  if (Number.isFinite(s.engageStallSeconds) && Number.isFinite(s.ceilingSeconds) && s.engageStallSeconds >= s.ceilingSeconds) {
    bad.push(`\`engageStallSeconds\` (${s.engageStallSeconds}) must be BELOW \`ceilingSeconds\` (${s.ceilingSeconds}) — ` +
      `a stall that outlasts the ceiling never fires, and every unengaged wave is then filed as a slow fight`);
  }
  return bad;
}

// Returns { ok, scenario, problems } — never throws and never exits (CLAUDE.md: lenses RETURN). The
// caller owns what a refusal costs.
function load(name) {
  const s = SCENARIOS[name];
  if (!s) return { ok: false, problems: [`no scenario '${name}'. Declared: ${Object.keys(SCENARIOS).join(', ')}`] };
  const problems = validate(name, s);
  return problems.length ? { ok: false, problems } : { ok: true, scenario: { name, ...s } };
}

// The one-line description of a run: it restates the declaration in a sentence, and states nothing the
// declaration does not already hold.
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
