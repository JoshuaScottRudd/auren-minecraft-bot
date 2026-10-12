/**
 * fragment: start_injector
 * purpose: Bootstrap lever, for an operator or a newly-spawned body, that kicks the autonomous planning
 *          loop (task_delegator).
 * invariants:
 *   - The run record is appended to; a start begins a new segment of the same file.
 *   - A body carrying a placement player is standing beside them, confirmed, before anything is routed.
 *   - Emits exactly one routed signal (start_command -> task_delegator) per inject() call, and none at
 *     all when the placement gate refuses.
 */
const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');

// Whether 'start' also runs a full system flush beforehand.
const CONFIG = {
  alsoFlushOnStart: false
};

// How long a starting body waits to hear the foreman's memory (its base lives there). The hub broadcasts
// on every registration, so this is normally met in well under a second; the ceiling decides how long a
// body stands still before saying plainly that the foreman never answered.
const FIRST_BROADCAST_WAIT_MS = 30000;

module.exports = {
  handle: 'start_injector',

  inject: async function () {
    // Resets the runtime clock so all watcher timestamps count from this moment.
    watcher.resetRuntimeClock();

    if (CONFIG.alsoFlushOnStart) {
      // Unguarded: flush_system is ours, and starting a run on a flush that failed is how a run inherits
      // the previous one's state while the log says it was cleaned (Law 13, default-stopped).
      const { flush } = require('@kernel/flush_system.js');
      watcher.summary('start_injector', '🧹 Pre-start flush enabled; invoking flush_system...');
      await flush();
      watcher.summary('start_injector', '✅ flush_system complete. Proceeding with start.');
    }
    // The run record is appended to and never cleared here: a rollback start empties fleet_logs/ before any
    // body exists (start_auren.js), and that is the one thing that deletes a record.

    // Start the global runtimer so uptime is tracked in watcher.json
    const timer = watcher.timer.start('runtimer', { source: 'start_injector' });
    watcher.summary('start_injector', `⏱️ runtimer started (elapsed=${timer.elapsed})`);

    // ── the placement gate: stand beside your person before you plan ─────────
    // Gates both start routes — a body born started injects its own, and an operator's `start` verb
    // arrives here too — through this one function, so a start cannot happen without passing it (Law 16).
    // Placed before the route and after the flush: the flush above is what makes the run's record start
    // clean, so a refusal lands in the trace a reader will open, and routing is the start itself.
    //
    // A body nobody placed starts where it stands. `startNearPlayer()` returns null only when no person
    // was named, the hand-launched single-bot case `beginsWorkAtBirth` describes, and a body with no
    // named person is not walked to an invented one (Law 13).
    const placeBeside = require('@kernel/bot_mandate').startNearPlayer();
    if (placeBeside) {
      const recovery = require('@kernel/body_recovery');
      const placed = await recovery.arriveAtPlace(global.bot, placeBeside);
      const where = recovery.isCellPlace(placeBeside) ? `at (${placeBeside})` : `with ${placeBeside}`;
      if (!placed.arrived) {
        // Refused, not started anyway (Law 13, default-stopped): a base layout lock outlives the run and
        // is read by every later job, so standing still and saying why is recoverable and a base surveyed
        // from the wrong place is not.
        watcher.error('start_injector',
          `⛔ NOT STARTED — this body must be standing ${where} before it plans, and it is not: ${placed.error}. `
          + 'Nothing was surveyed and nothing was locked. Place it and start it again.');
        return { started: false, why: `it is not standing ${where}: ${placed.error}` };
      }
      watcher.summary('start_injector',
        `📍 Placed ${where} — ${placed.distance.toFixed(1)} blocks off. The base will be surveyed from here.`);
    }

    // ── if that place is the world centre, say so loudly ─────────────────────
    // The spawn-protected square refuses breaks and placements silently, so this names the condition
    // once, before the survey, instead of letting it surface as scattered per-cell dig refusals.
    //
    // A warning, not an error: `standing: 'spawn'` is a legitimate mode that samples what a stranger
    // gets, so refusing to start would delete the ability to test it. Named in every channel the operator
    // reads, and the decision stays his (Law 25 — name the shortfall, do not act on his behalf).
    const spawnGuard = require('@perception/spawn_protection');
    const here = global.bot && global.bot.entity && global.bot.entity.position;
    if (here && spawnGuard.isSpawnProtectedAt(global.bot, here)) {
      watcher.warn('start_injector',
        `🚨 THIS BODY IS STANDING IN THE WORLD CENTRE — the spawn-protected square. `
        + `${spawnGuard.describeSpawnProtection(global.bot)} `
        + `Inside it the server refuses every break and placement by a non-op and REPORTS NOTHING, so `
        + `every dig this crew attempts near its base will be refused and the jobs that need stone, `
        + `seeds or a cleared site will return nothing. The crew is about to start work from HERE. `
        + `The foreman sites a crew clear of this square; a crew here was placed by hand or by a `
        + `person who stood here and fetched it.`);
    }

    // ── a body with no base does not start, and it never sets one ────────────
    // The foreman writes every site into its memory before it spawns a body, and the hub broadcasts that
    // memory the moment the body registers, so the one thing to wait for is the first broadcast: before
    // it, an empty building room means "not heard yet", not "no base".
    //
    // Placed after placement and before the route, so the first sweep sees the base. A body with no
    // foreman at all (no FOREMAN_URL) has nobody to hear from and reads its own memory as it stands.
    // Either way a body with no base is refused: a bot has no job by which to find or set one.
    const link = require('@kernel/foreman_link');
    if (process.env.FOREMAN_URL && !(await link.awaitFirstBroadcast(FIRST_BROADCAST_WAIT_MS))) {
      watcher.error('start_injector',
        `⛔ NOT STARTED — the foreman's memory never reached this body (${FIRST_BROADCAST_WAIT_MS / 1000}s, no broadcast). `
        + 'Its base lives there, and a body does not set its own. Is the foreman up and did this body register?');
      return { started: false, why: "the foreman's memory never reached it, and a body does not set its own base" };
    }
    // ── who was accountable decides the severity ──────────────────────────────
    // The same missing base means two different things depending on whether anyone was supposed to have
    // set it, so this reads the same fact and reports it at the severity the situation earns:
    //
    //   a foreman raised this body  ->  the foreman proves every structure sited before it spawns
    //     anything, so a body arriving without one means that step passed on a base it should have
    //     refused. That is one party's job done wrong, so it crashes and names them (Law 13's one
    //     permitted second verification).
    //   nobody did (no FOREMAN_URL: a hand-launched single bot)  ->  nothing upstream ever claimed to
    //     have sited it, so a plain refusal is right: a bot cannot set its own site.
    const lockLayout = require('@action/lock_all_buildspots');
    if (!lockLayout.baseLayoutComplete()) {
      if (process.env.FOREMAN_URL) {
        throw new Error('[start_injector] CODING VIOLATION (Law 13): a foreman raised this body and its memory '
          + 'holds no base for this crew. The foreman proves every structure is sited before it spawns anything '
          + '(foreman/utils/startup_steps.js, step "every structure this crew builds is sited"), so reaching this '
          + 'line means that step passed on a base it should have refused. Fix the foreman step, not this call.');
      }
      watcher.error('start_injector',
        '⛔ NOT STARTED — this body has no base, and no foreman raised it. Only a foreman sets a site, before any '
        + 'body is spawned, and a body never sets its own. Raise the crew through the foreman.');
      return { started: false, why: 'it has no base and no foreman raised it: only a foreman sets a site' };
    }

    // ── a builder takes its plan in hand before it plans anything (Law 26) ────
    // The downloaded building's plan is a file, read once at the stopped -> running boundary, validated,
    // and trusted for the life of the run, the same contract every other snapshot registry in the fleet
    // holds. This is the one call site: `assessors/downloaded_build` and the site executors all read the
    // loaded snapshot and none of them loads it, so no sweep and no dispatch first opens the file.
    //
    // The load is not the check: the foreman proves the plan before it spawns anything, so `load` here
    // only puts it into this body's own process memory. It still throws on a plan it cannot prove, the
    // one kind of second verification permitted (Law 13) — a throw here says the foreman's step was
    // wrong.
    //
    // Only a builder, because only a builder has a downloaded building; a homesteader has no
    // `builder.build` it is answerable for.
    if (require('@kernel/bot_mandate').isBuilder()) {
      const buildName = require('../foreman_config').builder.build;
      const plan = require('@kernel/downloaded_plan_registry').load(buildName);
      watcher.summary('start_injector',
        `📐 Plan in hand for "${buildName}" — ${plan.dimensions.w}×${plan.dimensions.l}, `
        + `${plan.columns.length} columns, ${plan.anchors.length} cubes.`);
    }

    watcher.summary('start_injector', '🧪 Injected autonomous start signal to recursive_judge');
    // Resolved at call time, not module scope, to break a require cycle (signal_bus -> fragment_registry
    // -> start_injector -> signal_bus) that would otherwise capture signal_bus mid-load as `{}`.
    //
    // Opens the startup span here, at the one line every start route passes through, so the bot-minutes
    // ledger's worked + idle + startup == life covers everything that ran before it. The span closes at
    // the first dispatch or idle pass.
    require('@kernel/bot_minutes').open();
    routeToJudge('start_injector', {
      readable: 'start_injector: starting autonomous planning loop with clean state',
      start_injector: { success: true },
    });
    // The outcome is returned, not assumed, so a caller reports failure truthfully (Law 25): the
    // placement gate above makes refusal an ordinary outcome, and the console is the half a person
    // actually reads.
    return { started: true, why: null };
  }
};
