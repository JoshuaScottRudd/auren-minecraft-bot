'use strict';
// foreman/utils/run_watch.js — the foreman watches its own run and states how it went at the end.
//
// The foreman holds every bot's live facts as they happen — every bot's error() reaches its hub the
// instant it fires — so it asks itself, in-process: no socket, no record, no second process (talk to the
// owner directly, Law 16).
//
//   start({ fleetState, wake, watch, onWake, build, onBuilt })   begin the watch once the crew is working (or the world is open)
//   startupFailed(step, why)                     the run never got past a startup step — the verdict says which
//   startupDone()                                every startup step was proved (a run stopped before this is not a PASS)
//   freeze()                                     keep the fleet's last answer BEFORE it is sent home
//   verdict(why) → exit code                     PASS / FAIL, written to fleet_logs/run_outcome.json and printed
//
// A WAKE ENDS THE RUN. The process watching the foreman's exit sees the run end through the one shutdown
// road, with the reason carried on it.

const outcome = require('./run_outcome');

const WATCH_POLL_MS = 6000;
const STARTED_AT = new Date().toISOString();

const state = { timer: null, woke: false, wokeOn: null, last: null, frozen: false, startup: null, startupDone: false, test: null, workingSince: null, crashed: null };

// wakeReason(fleet, wake) → a sentence, or null. A crash is an ABSENCE, so a bot that left and never came
// back always counts; its own last error line is carried through untouched, since it may say why.
// A bot the foreman itself sent home (a person's `stop` or `wipe`, a player leaving) carries `sent_home`
// on its departure and is an order obeyed, not a crash.
const lost = (fleet) => (fleet.departed || []).filter(d => !d.sent_home);
const sentAway = (d) => `${d.id} (sent home by ${d.sent_home.verb}${d.sent_home.asker ? ` from ${d.sent_home.asker}` : ''})`;

function wakeReason(fleet, wake) {
  for (const d of lost(fleet)) {
    return `${d.id} left the fleet at ${d.gone_at} and did not come back`
      + `${d.last_error ? `; its last error line: ${d.last_error}` : ' — it logged no error on the way out'}`;
  }
  for (const b of fleet.bots || []) {
    if (wake.includes('error') && (b.error || 0) > 0) return `${b.id} reported ${b.error} error(s); its own line: ${b.last_error || 'not carried'}`;
    if (wake.includes('death') && b.dead === true) return `${b.id} is dead`;
  }
  return null;
}

// `build` is the building whose standing ends the run (null: the run does not end on one). A body reads it
// built only with every cube and stand column in sight and standing, so one body's reading is the fact.
function start({ fleetState, wake, watch, onWake, build, onBuilt }) {
  state.workingSince = Date.now();
  state.last = fleetState();
  state.timer = require('../../js_kernel/utils/timeout_crash').every('run_watch', 'read the fleet for an error, a death or a lost body', () => {
    if (state.frozen) return;
    const fleet = fleetState();
    state.last = fleet;
    const reader = build ? (fleet.bots || []).find(b => b.built && b.built[build] === true) : null;
    if (reader) {
      require('../../js_kernel/utils/timeout_crash').stop(state.timer);
      onBuilt(reader.id);
      return;
    }
    if (!watch) return;
    const why = wakeReason(fleet, wake);
    if (!why) return;
    state.woke = true;
    state.wokeOn = why;
    require('../../js_kernel/utils/timeout_crash').stop(state.timer);
    onWake(why);
  }, WATCH_POLL_MS);
}

function startupFailed(step, why) { state.startup = { step, why }; }
function startupDone() { state.startupDone = true; }

// A TEST RUN IS JUDGED ON WHAT IT TESTED, NOT ON A CREW IT NEVER RAISED. The three crew checks below read
// a fleet — bots that worked their window, a clean error count, the crew that started still connected —
// and each would pass vacuously over zero bots, a PASS that means nothing (Law 25). A test replaces them
// with the one question it was run to answer, handed in by the test itself.
function testDone(name, found) { state.test = { name, ok: found.ok, lines: found.lines }; }

function freeze(fleetState) {
  if (state.frozen) return;
  if (state.timer && fleetState) state.last = fleetState();
  state.frozen = true;
  if (state.timer) require('../../js_kernel/utils/timeout_crash').stop(state.timer);
}

// The checks the workshop's run made, now made by the one who holds every fact they read.
function verdict(why) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  if (!state.startup && !state.startupDone) state.startup = { step: 'the startup', why: `it was stopped before it finished (${why})` };
  check('the startup was proved, step by step', !state.startup,
    state.startup ? `stopped at "${state.startup.step}": ${state.startup.why}` : 'every step proved');
  // ── A RUN THAT CRASHED IS NOT A RUN THAT PASSED ──────────────────────────────
  // Checked on its own: every other check below reads the FLEET, and a crash that tidies up behind itself
  // — bots sent home, world saved, verdict written — can leave a fleet that reads as a pass. This check
  // asks the one question none of the others do: did the foreman live to the end of its own run.
  if (state.crashed) {
    check('the foreman finished the run it started', false,
      `it did not — ${state.crashed.kind}: ${state.crashed.detail}`);
  }
  if (!state.startup && state.test) {
    check(`the ${state.test.name} test found what it was run to find`, state.test.ok,
      state.test.lines.map(l => l.trim()).join(' · '));
  }
  if (!state.startup && !state.test) {
    const fleet = state.last || { bots: [], departed: [] };
    const ranMin = state.workingSince ? (Date.now() - state.workingSince) / 60000 : 0;
    check('the crew worked its window out', !state.woke,
      state.woke ? `the watch woke after ${ranMin.toFixed(1)} min — ${state.wokeOn}` : `${ranMin.toFixed(1)} min, ended: ${why}`);
    const all = [...(fleet.bots || []), ...(fleet.departed || [])];
    const errBots = all.filter(b => (b.error || 0) > 0);
    check('the run record is clean (no errors)', errBots.length === 0,
      errBots.length ? errBots.map(b => `${b.id}: ${b.error} error(s), last: ${b.last_error || 'not carried'}`).join('; ') : `${all.length} bot(s), 0 errors`);
    const gone = lost(fleet);
    const home = (fleet.departed || []).filter(d => d.sent_home);
    check('the crew that started is the crew that finished', gone.length === 0,
      gone.length ? `${gone.map(d => `${d.id} at ${d.gone_at}`).join(', ')} left and did not come back`
        : `all ${(fleet.bots || []).length} bot(s) still connected${home.length ? `; ${home.map(sentAway).join(', ')}` : ''}`);
    // Walking against working, summed over every body's own clock: the crew may spend no more than the
    // limit of its time on jobs getting to them.
    const { fleetShare, WALK_LIMIT_PCT } = require('../../js_kernel/utils/calculators/walk_share_calculator');
    const share = fleetShare((fleet.bots || []).map(b => b.work_clock));
    const minutes = (ms) => (ms / 60000).toFixed(1);
    check(`the crew walked no more than ${WALK_LIMIT_PCT}% of its time on jobs`, share.walk_pct !== null && !share.over,
      share.walk_pct === null ? 'no bot reported time on a job'
        : `${share.walk_pct}% walking — ${minutes(share.walk_ms)} bot-min walking, ${minutes(share.work_ms)} bot-min working, ${share.bodies} bot(s)`
          + (share.over ? `; short by ${minutes(share.work_owed_ms)} bot-min of work` : ''));
    for (const b of fleet.bots || []) {
      console.log(`  ${b.id}: ${b.summary || 0} summary, ${b.warn || 0} warning(s), ${b.error || 0} error(s)${b.dead === true ? ', DEAD at the end' : ''}`);
    }
  }
  const failed = checks.filter(c => !c.ok);
  // The word on the screen is the word in the file: both are computed from the same state.crashed check.
  const word = state.crashed ? 'CRASHED' : (failed.length ? 'FAIL' : 'PASS');
  console.log(`\n══ ${word} — ${checks.length - failed.length}/${checks.length} check(s) · ${why} ══`);
  for (const f of failed) console.log(`  FAILED  ${f.name} — ${f.detail}`);
  return outcome.write({
    // CRASHED is its own word, distinct from FAIL: a FAIL is a run that finished and missed its checks;
    // CRASHED never finished. The failing check above already yields the right exit code with no
    // special case.
    outcome: state.crashed ? 'CRASHED' : (failed.length ? 'FAIL' : 'PASS'),
    stage: state.startup ? 'startup' : 'verdict',
    reason: why, checks, woke: state.woke, wokeOn: state.wokeOn, startedAt: STARTED_AT,
    ranMin: (Date.now() - Date.parse(STARTED_AT)) / 60000,
    exitCode: failed.length ? (state.startup ? 1 : 2) : 0,
  });
}

// crashed(kind, detail) — the foreman telling its own watch that it is not going to finish. Set once:
// a second throw while the first is being reported must not overwrite the cause that started it.
function crashed(kind, detail) {
  if (!state.crashed) state.crashed = { kind, detail };
}

module.exports = { start, startupFailed, startupDone, testDone, freeze, verdict, wakeReason, crashed };
