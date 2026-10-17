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

const { FARM_ROOM_KEYS, FARM_ROW_BLUEPRINTS, ALPHA_STRUCTURE } = require('@thinking/architect_config');

// The four tine-row blueprints, by the direction each one reaches. Inverted from the config's offset->name
// table, so a fifth direction is named in one place only (Law 16).
const ROW_DIRECTION = Object.fromEntries(
  Object.values(FARM_ROW_BLUEPRINTS).map(name => [name, name.slice('wheat_tine_row_'.length)]),
);

// ── scan ───────────────────────────────────────────────────────────────────────────────────────────
// What it exercises: the world comes up, the body joins and becomes a spectator, a standing spot clear of
// world spawn is found in an acceptable biome, the body is put on it, the loaded area is waited for, and
// the base is SITED — which for a homesteader is the wheat field (the trident scan over every sea-level
// water body in view) plus the headframe fitted around it. Then it stops.
function scanReport(site, species) {
  const lines = [];
  const rows = site.filter(r => FARM_ROOM_KEYS.includes(r.roomKey));
  const others = site.filter(r => !FARM_ROOM_KEYS.includes(r.roomKey));

  for (const r of others) {
    const o = r.candidate.transpose_origin;
    lines.push(`  ${r.roomKey} — ${r.blueprint} at (${o.x},${o.y},${o.z})`);
  }

  if (rows.length === 0) {
    lines.push(`  the wheat field: NO ROWS SITED — ${FARM_ROOM_KEYS.length} row(s) were asked for and none is in the`
      + ` fleet's memory. Either no sea-level water was in view, or every row the scan found was refused.`);
    // A homesteader base without its field is the failure this test exists to catch; a species that does not
    // farm is not judged on one.
    return { ok: species !== 'homesteader', lines };
  }

  // EVERY ROW'S DIRECTION IS NAMED, because that is the half the four-blueprint split can break silently.
  // A row locked as the wrong direction blueprint still reads as a locked row; what would give it away is
  // the blueprint NAME against the water, and the name is what this prints.
  const tally = {};
  const unknown = [];
  for (const r of rows) {
    const dir = ROW_DIRECTION[r.blueprint];
    if (!dir) { unknown.push(`${r.roomKey} is locked as '${r.blueprint}', which is not one of the four tine rows`); continue; }
    tally[dir] = (tally[dir] || 0) + 1;
  }
  const spread = Object.entries(tally).map(([d, n]) => `${n} ${d}`).join(', ');
  lines.push(`  the wheat field: ${rows.length} of ${FARM_ROOM_KEYS.length} row(s) sited — ${spread || 'none readable'}.`);
  for (const r of rows.slice(0, 4)) {
    const o = r.candidate.transpose_origin;
    lines.push(`    ${r.roomKey} stands at (${o.x},${o.y},${o.z}) and reaches ${ROW_DIRECTION[r.blueprint] || '?'}`);
  }
  if (rows.length > 4) lines.push(`    …and ${rows.length - 4} more.`);
  for (const u of unknown) lines.push(`  WRONG: ${u}`);

  const alpha = Object.values(ALPHA_STRUCTURE);
  const seat = site.find(r => alpha.includes(r.roomKey));
  if (!seat) lines.push(`  WRONG: no alpha structure (${alpha.join(' / ')}) is in the site, so a crew would have nowhere to sit.`);

  return { ok: unknown.length === 0 && !!seat, lines };
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

// A row may also carry:
//   start  the one `start` the test makes sense on; any other is refused before anything is touched
//   seat   true: the test keeps the one camera window a person flies, and no bot window
//   open   true: the test stays up until stopped once its steps are proved, in place of shutting down
const TESTS = {
  scan: {
    what: 'the world comes up, the body finds a spot, and the base is sited — the wheat field and the headframe',
    upTo: 'the base is sited and in memory',
    report: scanReport,
  },
  inspect: {
    what: 'the world comes up as the last run left it, a seat to fly is put at the base, and it stays open until stopped',
    upTo: 'the camera is at the build',
    start: 'continue',
    seat: true,
    open: true,
    report: inspectReport,
  },
};

const NAMES = Object.keys(TESTS);

// What a named test asks of the run around it; each answers "nothing" for 'off' and for an unknown name.
const startFor = (name) => (TESTS[name] && TESTS[name].start) || null;
const keepsSeat = (name) => !!(TESTS[name] && TESTS[name].seat);
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
// `site` is `existingSite(door.query().buildings, ownerKey)`.site — the fleet's own answer, live.
function verdict(name, { site, species }) {
  const t = TESTS[name];
  if (!site || site.length === 0) {
    return { ok: false, lines: ['  nothing is in the fleet\'s memory — the base was not sited.'] };
  }
  return t.report(site, species);
}

const describe = (name) => (name === 'off' ? null : `test ${name}: ${TESTS[name].what}`);

module.exports = { TESTS, NAMES, check, stepsFor, verdict, describe, startFor, keepsSeat, staysOpen };
