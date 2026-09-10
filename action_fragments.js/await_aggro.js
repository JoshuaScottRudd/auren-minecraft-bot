// fragment: await_aggro
// purpose: Wait for a monster to aggro, then fight it. The bench's watch, and the whole of sentry mode.
//
// ─── ONE FRAGMENT, AND WHY ───
//
// This replaces the pair `sentry_scheduler` (a kernel heartbeat) + `sentry_scan` (an action fragment).
// The rename is the diagnosis: the verb is not "scan" and it is not "schedule", it is WAIT FOR AGGRO.
// Naming it that is what makes the single-fragment shape obvious — waiting is one verb, and the timer
// and the check were two halves of it that had to hand back and forth to get anything done.
//
// NOT AN SPA LOOP, which is the load-bearing distinction. Law 11's loop re-enters from the top with
// FRESH SENSING because the planner must re-measure a gap that the last action changed. Nothing here
// changes the world: the watch is idle until a monster walks into range, so there is no gap to
// re-measure and no reason to re-originate a signal each pass. It is a wait, not a plan cycle.
//
// SO THE SIGNAL IS RECEIVED ONCE AND HELD FOR A WHOLE WAVE. The watch owns the bot's one signal from
// arming until a battle completes (Law 4 — one occupant per scope, and during sentry mode this IS the
// occupant), and terminates at the judge when it ends (Law 8). The old shape originated a fresh
// `sentry_scheduler → sentry_scan` hop every second, which is a chain re-entering a fragment it had
// already visited — the thing Law 12 forbids and the bus refuses. There is still no repeated hop to
// refuse: one hop in, one hop out, however long the WAIT runs. A per-pass shape would cost the judge a
// line on every poll; this fragment reports to it once per fight instead.
//
// ─── AND THE JUDGE HANDS IT BACK ───
//
// A WAVE IS A CHAIN. It is born when the watch is armed, it lives through the wait and the fight, and it
// dies at recursive_judge the moment a battle resolves — then the judge originates a FRESH one back to
// this fragment. That is Law 12 exactly ("chain born at the chain origin, terminates at the loop's judge;
// the judge dispatches fresh"), and it is why the loop is legal where a self-re-entry would not be: no
// fragment is visited twice within one chain, and nothing carries across the hop but the fact that a wave
// finished. The bench gets its repeatability from the judge, not from a timer.
//
// WHAT THIS BOUGHT, in one line: the wave boundary is now an EVENT the system judges, so waves are
// counted by the same instrument that counts everything else instead of by a clock nobody calibrated.
//
// BATTLE STATIONS IS CALLED INLINE, exactly as idle_scheduler calls it in its own heartbeat — the same
// Law 15 sub-loop API the fleet's other executor and locomotion boundaries await. This fragment adds NO
// combat logic: sentry must fight through the exact code the fleet fights through, or the bench proves
// something the fleet does not do (Law 16).
//
// The 'sentry' source argument is what makes the isolation work. battleStations returns its outcome to
// a sentry caller instead of abandoning it to recursive_judge (battle_stations.js, branch S). That one
// difference is the entire separation from the planning recursion — without it the arena bot would
// silently start taking jobs mid-match and the bench would be measuring the fleet again.
//
// What comes back is a REPORT, not a word: `{ outcome, killedEntityIds, disengagedEntityIds, entityNames,
// passes }`, one shape from every sentry exit including the quiet ones. The ids are what end a wave (see
// the wave block in the loop) — a verdict word cannot, because a bot that died fighting and a corpse
// polling one second later both say `died`.
//
// ─── WHY THERE IS NO JUDGE PER PASS, AND NO sentry_judge ───
// A judge's verb is to stop a loop that is not progressing. A watch is SUPPOSED to make no progress —
// that is what waiting is — so a judge over each pass would be counting the loop's correct behaviour as
// a stall. The one judge hop this fragment makes is at the END of the watch, reporting what the whole
// watch did. A dedicated sentry_judge was tried and removed: recursive_judge with `test: true` already
// halts without replanning, and a second judge bought false isolation anyway, since combat's movement
// reaches portable_judge which routes to recursive_judge regardless.
//
// ─── STOPPING ───
// `stop()` sets a flag the loop checks at ITERATION END — Law 4's own preemption mechanism: "looping
// fragments check a flag at iteration end, finish current iteration completely, drop the signal." It is
// not a Law 1 action-to-action dispatch; nothing is being asked to do work, a running occupant is being
// told to release the scope. The `start` verb and the dispatcher both set it, so the planning recursion
// can never co-own the body with a watch.
//
// ─── THE PASS IS ONE CALL AND NOTHING ELSE ───
// This fragment senses NOTHING. It does not scan, and it no longer checks the body or the health either
// — those two branches previously lived here and were a second implementation of a decision the gate
// already owns (Law 16), free to drift out of step because each looked right on its own page. Sensing
// at the moment of deciding is also just Invariant B: a caller's pre-check is by construction read
// before the decision it feeds. What the watch owns is the wait and the report; what may be fought, and
// whether the body can fight at all, is battle_stations' single decision.
//
// The bot does NOT walk back to its post after a death: repositioning and re-kitting belong to the
// arena director over RCON, because where the fight happens is an AUTHORED input to the bench, never
// something the system under test decides.
//
// This fragment is now validated by live runs rather than a bench scenario: a live test beats a bench
// test, and a bench scenario whose subject the fleet already exercises every run is upkeep with no
// yield. The claims above are what the live run checks.

'use strict';

const watcher = require('@kernel/watcher');
const { routeSignal, routeToJudge } = require('@utils/signal_utils');
const { sleep } = require('@utils/fragment_utils');
const { battleStations } = require('@api/battle_stations');
const { withCleanup } = require('@utils/external_library_guard');
const crewLog = require('@api/crew_log');

const TAG = 'await_aggro';

// 1000 ms: the reaction budget, and it is the combat gate's number rather than a poll rate chosen for
// comfort. Combat_refurbish §3.2 models a creeper at ~0.25 blocks/tick (~5 b/s), so one second of
// latency costs ~5 blocks of approach — a mob detected at the 15-block aggro edge is at ~10 when the
// gate reacts, still outside the 4.75-block jump-trigger band that strike-and-fade opens on. At the idle
// loop's old 10 s it would already be inside the 3.0-block fuse. Tune here only.
const POLL_MS = 1000;

// Two kinds of outcome, and the difference is what the watch may count. A STATE persists across passes
// — a corpse reads `died` every second until mineflayer respawns it — so it is worth one line and one
// increment when it BEGINS, and counting it per pass would report twenty deaths for one. An EVENT is a
// fight that resolved on this pass, so two in a row are genuinely two fights and each earns its line.
// Law 25: the count in the report has to be the count of things that happened.
const DEAD_STATE = 'died';

// Law 5. At 1 Hz a line per quiet pass is ~60/min of "nothing here", which would bury the engagement
// lines this watch exists to produce. One aggregated heartbeat per minute instead; every ENGAGEMENT
// posts immediately, because that is the event.
const QUIET_LOG_EVERY = 60;

let _watching = false;

// SENTRY IS A STATE OF THE BOT, NOT A FIELD ON A MESSAGE.
//
// SEPARATE FROM `_watching` AND THAT SEPARATION IS THE WHOLE POINT. `_watching` means "a watch loop is
// turning right now" — it goes false between waves and again the moment the body dies. The MODE outlasts
// all of that: the bot is in sentry from the `sentry` verb until an operator takes it out, and nothing in
// that window may plan.
//
// Sentry used to be carried only as `source === 'sentry'` on a call and `payload.sentry` on a signal, so
// it was a property of individual MESSAGES. Any other door into combat therefore bypassed it entirely —
// confirmed by the locomotion layer's own inline combat gate, which could engage a creeper with `source
// locomotion`, let the body die inside that call, and hand battle_stations' abandon to the judge with no
// flags at all, so the judge routed to job_board and ran the planning recursion inside a sentry trial.
// Law 4 puts one occupant per decision-maker SCOPE; a mode expressed per-message is not a property of the
// scope, which is exactly why every non-watch caller leaked through.
let _sentryArmed = false;

module.exports = {
  POLL_MS,                              // exported so the bench times itself off the real cadence (Law 16)

  // arm — the `sentry` operator verb's entry, and the chain origin. It originates the ONE signal the
  // watch then holds. Kept on this fragment rather than in a separate injector, since an injector whose
  // only job is to route one signal to the fragment beside it would just be the same split in a new
  // place.
  arm: function () {
    // The mode opens HERE, at the operator's verb, and closes only in `stop` — not when a watch ends and
    // not when the body dies, both of which happen many times inside one armed session.
    _sentryArmed = true;
    // ── PUBLISHED, BECAUSE THE BENCH IS A DIFFERENT PROCESS ──────────────────────────────────────────
    // lanista runs outside this process and cannot call `inSentry()`, so the mode has to reach it through
    // a record. That record is the bot's OWN watcher trace, read back through `combat_lens.watchState`.
    //
    // WHY IT IS A CONTROL AND NOT A CONVENIENCE. A monster summoned while the body is mid-errand and away
    // from the watch can kill it without a fight ever opening, and that trial would record as a death on
    // a wave that measured nothing — the mob never fought the bot (Law 25). A wave the watch was not
    // holding must be REFUSED, not scored.
    crewLog.post(TAG, 'sentry', { state: 'armed' });
    routeSignal('operator_commands', TAG, {
      test: true,                       // halt, no replan — this watch never enters the planning recursion
      readable: `${TAG}: watch armed — holding the signal until a monster aggros or the watch is stopped`,
    });
  },

  // Law 4's preemption flag. Idempotent, and safe to call when no watch is running — both callers
  // (`start` and the dispatcher) fire it unconditionally as a guard, not as a known-state transition.
  //
  // DISARMS THE MODE TOO. `stop` is the operator leaving sentry (`start` and the dispatcher are its only
  // callers), so it is the one place the mode is allowed to end — a death must NOT end it, or the trial's
  // own terminal condition would silently hand the bot back to the planner.
  stop: function () {
    // Only record the TRANSITION. Both callers fire this unconditionally as a guard, so recording every
    // call would put a run of `disarmed` lines in front of a bench reading the last one and make an
    // operator's idempotent stop look like a mode that kept closing.
    if (_sentryArmed) crewLog.post(TAG, 'sentry', { state: 'disarmed' });
    _watching = false; _sentryArmed = false;
  },

  // Read by recursive_judge at call time to refuse the planning recursion outright. A predicate rather
  // than an exported flag so there is ONE writer and no caller can arm sentry by assignment (Law 6).
  inSentry: function () { return _sentryArmed; },

  receive: watcher.track(TAG, async function (signalType, payload) {
    if (signalType !== TAG) return;

    // Law 4, and a real case rather than defensive padding: the bus refuses a second identical hop, so
    // a double-arm normally never reaches here — but anything that routed in between would clear that
    // guard, and two watches would both drive the body.
    if (_watching) {
      watcher.warn(TAG, 'Watch already running — refusing to start a second one (Law 4: one occupant).');
      return;
    }

    _watching = true;
    // ── THE WATCH IS STANDING, AND THIS IS THE LINE LANISTA SUMMONS AGAINST ──────────────────────────
    // `armed` (posted by `arm` above) is the MODE and it stays true across every wave, every fight and
    // every spoils errand — so a bench gated on it alone would summon into a body that is between waves
    // and away from the watch. This line is the stricter fact: a FRESH watch loop is turning and combat
    // has not opened since. The lens retires it on the next `engage`, so the whole span from the first
    // target taken through the spoils to the judge's hand-back reads NOT STANDING.
    //
    // HERE RATHER THAN IN `arm`, because the re-arm between waves never touches `arm`: recursive_judge
    // routes a fresh `await_aggro` signal straight to this function (its re-arm block). A line written in
    // `arm` would mark the first wave of a session and nothing after it.
    crewLog.post(TAG, 'sentry', { state: 'standing' });
    let passes = 0, quietPasses = 0, engagements = 0, deaths = 0;
    let previous = null;                // the last pass's outcome — how a persisting STATE is told from a new one
    const outcomes = new Map();
    const startedAt = Date.now();
    // The battle this watch ended on, or null if the operator stopped it instead. It is what makes the
    // terminating hop below a WAVE RESULT rather than a shift summary — see the wave block in the loop.
    let completedBattle = null;

    // DEATH IS TERMINAL: a trial ends when the bot dies. Waves exist to see how long equipped gear lasts
    // against escalating monsters, and that measurement is void the moment the body is respawned or
    // re-kitted mid-trial — so death ends the watch outright, with no respawn from this fragment.
    //
    // Kept apart from `completedBattle` because the two must route DIFFERENTLY. A completed battle sets
    // `sentry: true` and comes back here re-armed; a death must NOT, or the judge re-arms a watch over a
    // corpse. Kept apart from "stopped by operator" for Law 25: reporting "stopped by operator, no
    // battle" for a body that died in the field would be a false account of the run.
    let diedOut = false;

    // The watch raised `_watching`, so releasing it on every exit — return, throw, operator stop — is
    // Law 8's termination clause rather than a guard: nothing is caught here and a throw travels exactly
    // as it would without it.
    await withCleanup(TAG, 'aggro watch', async () => {
      while (_watching) {
        let report;
        // ONE call, and the pass is nothing else. No body check, no health check, no scan: the gate
        // decides whether it can fight AT the moment it decides whether to, and this fragment only asks
        // and records. A prior version carried its own corpse and no-body branches — a second
        // implementation of the gate's own decision (Law 16) that could drift out of step silently
        // because both looked right in isolation. The watch's verb is to wait and to report; every
        // predicate about the body belongs to the thing that owns fighting.
        //
        // NOT GUARDED. battleStations is ours, so a throw out of it is a defect, and the guard that used
        // to stand here manufactured a report — outcome 'error', no entities, zero passes — which every
        // counter below then consumed as though a pass had happened (Law 25: a fabricated verdict is
        // worse than the stall it hides). The watch is not owed protection from its own gate breaking;
        // the watch ends because the bot stops (Law 13).
        report = await battleStations(global.bot, 'sentry');

        const outcome = report.outcome;
        passes++;
        outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1);

        // ── WHAT ENDS A WAVE ──────────────────────────────────────────────────────────────────────────
        // A wave ends when the monster completes a battle — not on a timer and not on a verdict word.
        //
        // The test is an ENTITY RESOLVING. battle_stations reports which entity ids it killed and which
        // disengaged, and a non-empty pair is the exact event "the monster completed a battle" — one
        // fact, measured by the thing that fought, read here without re-deriving it (Law 25).
        //
        // WHY THE WORD WOULD NOT DO: a bot that dies mid-fight and a corpse polling the gate one second
        // later BOTH report `died`. The first is a completed battle (its held mob retires through the
        // finally into `disengagedEntityIds`); the second resolved nothing and is a body waiting on the
        // arena director. A wave counter keyed on the word ends the wave twice for one death and again
        // every second after.
        //
        // A TIMER WAS THE WRONG SHAPE for the same reason a poll interval is not a fight: it measures
        // the observer's patience, not the combat. Two identical waves that differ only in how long the
        // approach took would report as different waves, which is precisely the noise a controlled bench
        // exists to remove.
        const resolvedEntityIds = [...report.killedEntityIds, ...report.disengagedEntityIds];
        const nameEntities = (ids) =>
          (ids.length ? ids.map(id => `${report.entityNames[id] || 'entity'}#${id}`).join(', ') : 'none');

        if (resolvedEntityIds.length) {
          quietPasses = 0;
          engagements++;
          completedBattle = report;
          // Law 4's preemption flag, set by this fragment on itself. The `while` reads it at the top of
          // the next lap, so the current iteration finishes whole — the same mechanism `stop()` uses,
          // because a watch ending itself and a watch being stopped are the same transition.
          _watching = false;
          // A DEATH IS STILL A DEATH WHEN IT RESOLVED A MOB, and this branch is the one that runs in the
          // ordinary case: a body that dies almost always leaves a disengaged opponent behind, so the
          // wave arrives here as a "completed battle" whose outcome happens to be `died`. Reading the
          // terminal condition off the ENTITY COUNT instead of off the outcome would put the common death
          // on the re-arm path — standing a fresh watch over a corpse and holding the signal live while
          // the operator's own `verb start` gets refused for finding two signals live. The capsule is
          // still reported (lanista reads the wave from it); only the re-arm is refused.
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
            // THE WATCH ENDS HERE. It used to hold, on the belief that the arena director owns the
            // respawn and the re-kit — an owner that never claimed it, so nothing ever revived the body
            // and the watch stood over a corpse for the rest of the process (Law 8: a lifecycle must
            // terminate with the owner that raised it; watching for a body that no longer exists is the
            // zombie state that law names). Worse, holding kept THE one signal live, so every later route
            // was refused — an operator's recovery verb becomes unavailable on exactly the runs that need
            // it. Ending releases the scope (Law 4) so the judge decides from a fresh world state
            // (Law 12) and the operator's verbs work again.
            //
            // ENDS WITHOUT `sentry: true` — see the terminate block. A death must not re-arm the watch:
            // the trial is over, and re-arming would stand a new watch over the corpse.
            _watching = false;
            watcher.summary(TAG, `💀 DIED (death ${deaths} of this watch) — the trial ends here. Ending the watch and releasing the signal; the body is NOT respawned by this fragment.`);
          }
        } else {
          // Every remaining outcome resolved no entity, so nothing happened worth a line of its own —
          // `clear`, `no_body`, a gate that declined, a peer's yield, an error. They differ to the
          // reader of the trace and not to the watch, which is still waiting either way.
          if (++quietPasses % QUIET_LOG_EVERY === 0) {
            watcher.summary(TAG, `👁️ Standing watch — ${quietPasses} quiet pass(es), no aggro (last: ${outcome}).`);
          }
        }
        previous = outcome;

        await sleep(POLL_MS);
      }
    }, () => { _watching = false; });

    // TERMINATE (Law 8). One hop, at the end of the watch, reporting what the WHOLE watch did rather
    // than what one pass did — which is the only honest unit here, because a single pass of a wait is
    // not an outcome anyone asked about (Law 25: the report answers the asker's question).
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const histogram = [...outcomes.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o}×${n}`).join(', ');
    watcher.summary(TAG, `Watch ended — ${passes} pass(es) over ${seconds}s, ${engagements} engagement(s), ${deaths} death(s). Outcomes: ${histogram || 'none'}.`);

    // ── THE ROUND TRIP ────────────────────────────────────────────────────────────────────────────────
    // `sentry: true` is what recursive_judge routes back on, setting the bot up for the next wave
    // without re-arming through the operator. It rides BESIDE `test: true`, not instead of it: the test
    // flag is what keeps this chain out of the planning recursion (no job_board, no
    // replan-from-world-state), and dropping it to get a route back would buy the round trip by wiring
    // the bench into the fleet — the one thing sentry mode exists to prevent.
    //
    // SET ONLY ON A COMPLETED BATTLE. An operator `stop` ends the watch too, and re-arming after that
    // would make the stop verb unable to stop anything (Law 4 — the flag releases the scope; a judge that
    // immediately re-occupied it would be a second occupant arriving by the back door).
    //
    // THE ENTITY IDS ARE IN THE READABLE, not only in the capsule, and that is load-bearing here above
    // everywhere else: recursive_judge keys its contiguous count on the readable string, and this chain
    // now REPEATS — wave after wave, same fragment, same sentence. Without a distinguishing detail every
    // wave would present as the same outcome text and the judge would halt the bench for looping while
    // it was working perfectly. The mob it just fought is what makes each wave's sentence distinct from
    // the last.
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
      // …but come back here, re-armed for the next wave — UNLESS the body died, which is the trial's
      // terminal condition: no respawn from this fragment. A death that also retired a mob still lands
      // in `completedBattle`, so the death check has to ride beside it.
      ...(completedBattle && !diedOut ? { sentry: true } : {}),
      readable: `${TAG}: ${battleText} (after ${passes} pass(es), ${seconds}s)`,
      await_aggro: {
        passes, engagements, deaths, seconds, outcomes: Object.fromEntries(outcomes),
        // WHY the watch ended, as data. `deaths` is a count and a count of 1 does not say whether the
        // watch stopped BECAUSE of it — a bench reading only the count cannot tell a trial that ended on
        // a death from one an operator stopped after a death (Law 25: the consumer's question is which).
        died: diedOut,
        // The wave result as DATA, for whatever reads waves (lanista's ladder). Same fact as the readable
        // above, in the register its consumer needs — the judge reads prose, a bench reads ids (Law 24).
        battle: completedBattle && {
          outcome: completedBattle.outcome,
          killedEntityIds: completedBattle.killedEntityIds,
          disengagedEntityIds: completedBattle.disengagedEntityIds,
          entityNames: completedBattle.entityNames,
        },
      },
    });
  }),
};
