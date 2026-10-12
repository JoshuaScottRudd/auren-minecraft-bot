// fragment: await_aggro
// purpose: Wait for a monster to aggro, then fight it. The bench's watch, and the whole of sentry mode.
//
// Not an SPA loop (Law 11): nothing here changes the world, so the watch takes its one signal once and
// holds it for a whole wave (Law 4), terminating at the judge only when the wave ends (Law 8). A wave is
// a chain — born when armed, dying at recursive_judge when a battle resolves, which dispatches a fresh
// chain back here (Law 12). battleStations is called inline (Law 15); source `'sentry'` keeps its outcome
// from reaching recursive_judge directly (battle_stations.js, branch S).
//
// No judge runs per pass — a watch is supposed to make no progress, so only the end of the watch reports.
// A death does not send the bot back to its post; repositioning belongs to the arena director over RCON.

'use strict';

const watcher = require('@kernel/watcher');
const { routeSignal, routeToJudge } = require('@utils/signal_utils');
const { sleep } = require('@utils/fragment_utils');
const { battleStations } = require('@api/battle_stations');
const { withCleanup } = require('@utils/external_library_guard');
const crewLog = require('@api/crew_log');

const TAG = 'await_aggro';

// 1000 ms: the combat gate's reaction budget. Tune here only.
const POLL_MS = 1000;

// A STATE (a corpse reads `died` every pass) counts once, on the pass it begins; an EVENT counts every pass (Law 25).
const DEAD_STATE = 'died';

// Law 5: one aggregated heartbeat per minute instead of a line per quiet pass; every engagement posts immediately.
const QUIET_LOG_EVERY = 60;

let _watching = false;

// Sentry is a state of the bot, not a message field — armed by `sentry`, disarmed only by an operator, and outliving `_watching` (true only mid-loop) (Law 4).
let _sentryArmed = false;

module.exports = {
  POLL_MS,                              // exported so the bench times itself off the real cadence (Law 16)

  // arm — the `sentry` operator verb's entry and chain origin, originating the one signal the watch holds.
  arm: function () {
    _sentryArmed = true;                // opens the mode here; closes only in `stop`, never at a death
    // Published to the trace since lanista runs outside this process; an unheld wave must be refused, not scored (Law 25).
    crewLog.post(TAG, 'sentry', { state: 'armed' });
    routeSignal('operator_commands', TAG, {
      test: true,                       // halt, no replan — this watch never enters the planning recursion
      readable: `${TAG}: watch armed — holding the signal until a monster aggros or the watch is stopped`,
    });
  },

  // Law 4's preemption flag, idempotent when no watch runs; also the one place sentry may end (a death must not).
  stop: function () {
    if (_sentryArmed) crewLog.post(TAG, 'sentry', { state: 'disarmed' }); // records only the transition
    _watching = false; _sentryArmed = false;
  },

  // Read by recursive_judge to refuse the planning recursion; a predicate so there is one writer (Law 6).
  inSentry: function () { return _sentryArmed; },

  receive: watcher.track(TAG, async function (signalType, payload) {
    if (signalType !== TAG) return;

    if (_watching) {
      watcher.warn(TAG, 'Watch already running — refusing to start a second one (Law 4: one occupant).');
      return;
    }

    _watching = true;
    // The stricter fact lanista summons against: a fresh watch is turning and combat hasn't opened since (retired on the next `engage`). Posted here since a re-arm bypasses `arm`.
    crewLog.post(TAG, 'sentry', { state: 'standing' });
    let passes = 0, quietPasses = 0, engagements = 0, deaths = 0;
    let previous = null;                // last pass's outcome — tells a persisting STATE from a new one
    const outcomes = new Map();
    const startedAt = Date.now();
    let completedBattle = null;         // the battle this watch ended on, or null if the operator stopped it

    // A death ends the watch outright with no respawn here; kept apart from `completedBattle` (re-arms) and from an operator stop, so the report says which happened (Law 25).
    let diedOut = false;

    // Releases `_watching` on every exit (Law 8); nothing here is caught, so a throw travels unchanged.
    await withCleanup(TAG, 'aggro watch', async () => {
      while (_watching) {
        let report;
        // One call and nothing else (Law 16); not guarded, since a throw here is a defect the watch ends on (Law 13), not a report to fabricate.
        report = await battleStations(global.bot, 'sentry');

        const outcome = report.outcome;
        passes++;
        outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1);

        // A wave ends when an entity resolves (killed/disengaged), not on a timer or the outcome word — a dying body and a corpse polling later both say `died` (Law 25).
        const resolvedEntityIds = [...report.killedEntityIds, ...report.disengagedEntityIds];
        const nameEntities = (ids) =>
          (ids.length ? ids.map(id => `${report.entityNames[id] || 'entity'}#${id}`).join(', ') : 'none');

        if (resolvedEntityIds.length) {
          quietPasses = 0;
          engagements++;
          completedBattle = report;
          _watching = false;            // Law 4's own preemption flag; the `while` finishes its lap whole
          // A death that also resolves a mob still lands here: entity resolution, not the outcome word, decides this branch.
          if (outcome === DEAD_STATE) diedOut = true;
          watcher.summary(TAG,
            `⚔️ Battle complete: ${outcome} — killed: ${nameEntities(report.killedEntityIds)}; ` +
            `disengaged: ${nameEntities(report.disengagedEntityIds)}. ` +
            (diedOut
              ? `The BODY DIED, so the trial ends here — reporting to the judge and NOT re-arming.`
              : `Ending the watch and reporting to the judge, which re-arms it for the next wave.`));
        } else if (outcome === DEAD_STATE) {
          if (previous !== DEAD_STATE) {
            deaths++;
            quietPasses = 0;
            diedOut = true;
            // Ends the watch here (Law 8); releases the scope for a fresh judge decision (Law 12), without `sentry: true`.
            _watching = false;
            watcher.summary(TAG, `💀 DIED (death ${deaths} of this watch) — the trial ends here. Ending the watch and releasing the signal; the body is NOT respawned by this fragment.`);
          }
        } else {
          // No entity resolved — differs to the trace reader, not to the watch, which is still waiting.
          if (++quietPasses % QUIET_LOG_EVERY === 0) {
            watcher.summary(TAG, `👁️ Standing watch — ${quietPasses} quiet pass(es), no aggro (last: ${outcome}).`);
          }
        }
        previous = outcome;

        await sleep(POLL_MS);
      }
    }, () => { _watching = false; });

    // Law 8: one hop at the end of the watch, reporting the whole watch, not one pass (Law 25).
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const histogram = [...outcomes.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o}×${n}`).join(', ');
    watcher.summary(TAG, `Watch ended — ${passes} pass(es) over ${seconds}s, ${engagements} engagement(s), ${deaths} death(s). Outcomes: ${histogram || 'none'}.`);

    // `sentry: true` rides beside `test: true` so recursive_judge re-arms the next wave without routing through the operator or the planning recursion; set only on a completed battle, never a stop (Law 4).
    // The entity ids ride in the readable too: recursive_judge keys its contiguous-loop count on that string, and the mob just fought keeps each repeating wave's sentence distinct (Law 12).
    const battleText = completedBattle
      ? (() => {
          const named = (ids) => (ids.length ? ids.map(id => `${completedBattle.entityNames[id] || 'entity'}#${id}`).join(', ') : 'none');
          return `battle ${completedBattle.outcome} — killed: ${named(completedBattle.killedEntityIds)}; disengaged: ${named(completedBattle.disengagedEntityIds)}`;
        })()
      : diedOut
        ? `the body DIED — the trial ends here, no respawn from this fragment (${deaths} death(s) this watch)`
        : 'stopped by operator, no battle';

    routeToJudge(TAG, {
      test: true,                       // stay out of the planning recursion — no replan, no job_board
      ...(completedBattle && !diedOut ? { sentry: true } : {}), // re-armed unless the body died
      readable: `${TAG}: ${battleText} (after ${passes} pass(es), ${seconds}s)`,
      await_aggro: {
        passes, engagements, deaths, seconds, outcomes: Object.fromEntries(outcomes),
        died: diedOut,                  // whether the watch ended because of a death (Law 25)
        battle: completedBattle && {    // wave result as data, for lanista's ladder (Law 24)
          outcome: completedBattle.outcome,
          killedEntityIds: completedBattle.killedEntityIds,
          disengagedEntityIds: completedBattle.disengagedEntityIds,
          entityNames: completedBattle.entityNames,
        },
      },
    });
  }),
};
