'use strict';
// foreman/utils/test_modes.js — A RUN THAT EXERCISES THE FOREMAN AND STOPS BEFORE THE BOTS.
//
// A test run answers a siting question in about the time it takes a world to come up: siting a base reads
// real generated terrain, runs the water scan, picks the plots and writes the chairs, and every one of
// those is a calculation over a world nobody can fake (Invariant B — anything Minecraft decides is READ
// and never authored). Raising bodies after it proves nothing about the siting.
//
// NOT A SECOND PATHWAY (Law 16): `foremanSteps` is the same list, walked by the same runner, against the
// same server. A test run differs by subtraction only — the crew step, the soak step and the bot cameras (a
// window onto bodies that will not exist) do not apply to it. Everything before that point, a test run
// proves identically. A test whose row says `seat` keeps the one window a person flies.
//
// THE REPORT IS READ OFF THE FLEET, NEVER OFF A RECORD. The fleet is still up when a test finishes, so
// `door.query()` — the fleet's live door — is asked directly, and the base it returns is the base the crew
// would have been handed. Nothing here parses a log.
//
// ADDING A TEST is one row in TESTS. `upTo` is the step it stops after — the string must match a step's
// `name` in startup_steps exactly, and `check()` below proves that at load time.

const { ALPHA_STRUCTURE, FARM_FIELD } = require('@thinking/architect_config');

// ── scan ───────────────────────────────────────────────────────────────────────────────────────────
// What it exercises: the world comes up, the body joins and becomes a spectator, a standing spot clear of
// world spawn is found in an acceptable biome, the body is put on it, the loaded area is waited for, and
// the base is SITED — every structure the crew's layout places (lock_all_buildspots). Then it stops.
function scanReport(site, species) {
  const lines = site.map((r) => {
    const o = r.candidate.transpose_origin;
    return `  ${r.roomKey} — ${r.blueprint} at (${o.x},${o.y},${o.z})`;
  });
  // A base without its field is a failure this test exists to catch.
  const fieldSited = site.some(r => r.roomKey === FARM_FIELD.structure);
  if (!fieldSited) lines.push(`  WRONG: the wheat field '${FARM_FIELD.structure}' is not in the site.`);
  const alpha = Object.values(ALPHA_STRUCTURE);
  const seat = site.find(r => alpha.includes(r.roomKey));
  if (!seat) lines.push(`  WRONG: no alpha structure (${alpha.join(' / ')}) is in the site, so a crew would have nowhere to sit.`);

  return { ok: fieldSited && !!seat, lines };
}

// ── inspect ────────────────────────────────────────────────────────────────────────────────────────
// What it is for: a person looking over what a finished run built. The world comes up as that run left it,
// the base is read back from the fleet's memory, the seat a person flies is raised and put at the base's
// alpha structure (a builder's laydown yard, a homesteader's headframe), and the run then stays open with
// no body raised until it is stopped.
function inspectReport(site) {
  const lines = site.map((r) => {
    const o = r.candidate.transpose_origin;
    return `  ${r.roomKey} — ${r.blueprint} at (${o.x},${o.y},${o.z})`;
  });
  const alpha = Object.values(ALPHA_STRUCTURE);
  const seat = site.find(r => alpha.includes(r.roomKey));
  if (!seat) lines.push(`  WRONG: no alpha structure (${alpha.join(' / ')}) is in the site, so there is nowhere to put the person looking.`);
  return { ok: !!seat, lines };
}

// ── world ──────────────────────────────────────────────────────────────────────────────────────────
// What it is for: a bench that needs a world and a foreman and no crew (seed_scanner, voxel_snapshot,
// world_forge, through bench_world). The world comes up, the body joins and reads world spawn (published on the
// door as `run.spawn`), and the run stays open with no body raised until it is stopped. It sites nothing, so it
// is judged on nothing but its steps.
function worldReport() {
  return { ok: true, lines: ['  the world is up and its spawn is known; nothing is sited and nobody is raised.'] };
}

// A row may also carry:
//   start  the one `start` the test makes sense on; any other is refused before anything is touched
//   seat   the one camera window a person flies, by name, and no bot window: it raises in place of camera_configure's
//          seats, and being in none of its fixed spots it is put at the base's alpha structure
//   open   true: the test stays up until stopped once its steps are proved, in place of shutting down
//   sites  false: the test sites nothing, so its verdict asks the fleet's memory for no base
const TESTS = {
  scan: {
    what: 'the world comes up, the body finds a spot, and the base is sited — every structure of the crew layout',
    upTo: 'the base is sited and in memory',
    report: scanReport,
  },
  inspect: {
    what: 'the world comes up as the last run left it, a seat to fly is put at the base, and it stays open until stopped',
    upTo: 'the camera is at the build',
    start: 'continue',
    seat: 'Cam_Inspector',
    open: true,
    report: inspectReport,
  },
  world: {
    what: 'the world comes up and its spawn is known; nobody is raised, and it stays open until stopped',
    upTo: 'the world spawn is known',
    open: true,
    sites: false,
    report: worldReport,
  },
};

const NAMES = Object.keys(TESTS);

// What a named test asks of the run around it; each answers "nothing" for 'off' and for an unknown name.
const startFor = (name) => (TESTS[name] && TESTS[name].start) || null;
const keepsSeat = (name) => !!(TESTS[name] && TESTS[name].seat);
const seatOf = (name) => (TESTS[name] && TESTS[name].seat) || null;
const staysOpen = (name) => !!(TESTS[name] && TESTS[name].open);

// check(name) → { ok, why } — whether this is a test the foreman knows. Called by foreman_plan's whole-config
// check so a misspelt test is refused in the same breath as every other config fault.
function check(name) {
  if (name === 'off') return { ok: true };
  if (!TESTS[name]) return { ok: false, why: `'${name}' is not a test the foreman knows. Known: ${NAMES.map(n => `'${n}'`).join(' | ')}.` };
  return { ok: true };
}

// stepsFor(name, steps) — the step list a test run walks: everything up to and including its `upTo` step.
// Refuses a name it cannot find in `steps` (Law 13).
function stepsFor(name, steps) {
  if (name === 'off') return steps;
  const upTo = TESTS[name].upTo;
  const i = steps.findIndex(s => s.name === upTo);
  if (i === -1) {
    throw new Error(`[test_modes] CODING VIOLATION (Law 13): test '${name}' stops after the step "${upTo}", `
      + `and no step in the foreman's startup has that name. The names it does have: ${steps.map(s => `"${s.name}"`).join(', ')}. `
      + `A renamed step must be renamed here too.`);
  }
  return steps.slice(0, i + 1);
}

// verdict(name, { site, species }) → { ok, lines } — what the test found, in the words of the thing it tested.
// `site` is `existingSite(door.query().buildings, species)`.site — the fleet's own answer, live.
function verdict(name, { site, species }) {
  const t = TESTS[name];
  if (t.sites === false) return t.report();
  if (!site || site.length === 0) {
    return { ok: false, lines: ['  nothing is in the fleet\'s memory — the base was not sited.'] };
  }
  return t.report(site, species);
}

const describe = (name) => (name === 'off' ? null : `test ${name}: ${TESTS[name].what}`);

module.exports = { TESTS, NAMES, check, stepsFor, verdict, describe, startFor, keepsSeat, seatOf, staysOpen };
