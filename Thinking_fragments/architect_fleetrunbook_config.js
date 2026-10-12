'use strict';
// A run type names its answers here, never asked at a prompt or CLI flag, so a config round gives
// identical answers every time (Law 26). Plain data, not JSON, so each field's meaning sits beside its
// value. `start_automatically` addresses each bot it starts by name, never broadcast. Every field is
// required and validated at load — a missing answer refuses to run (Law 13).

module.exports = {

  // The run a bare command uses; change this line to change what "a run" means.
  active: 'rollback',

  profiles: {

    // Two fields make a run:
    //   rung — which preflight runs: 'rollback' (restore, known ground) or 'continue' (inherit last
    //          run's state, audit HQ, revive corpses).
    //   film — whether lenses come up: 'none' | 'watch' (cameras only) | 'record' (cameras + OBS).
    //          Not a separate preflight — each run just names the rung it films (Law 16).

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // ROLLBACK — the bench every other run type is measured against.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    rollback: {
      description: 'Known ground: restore, flush, dawn, two homesteaders thinking on a timed window.',

      rung: 'rollback',
      film: 'none',

      // Species stamped on the bots at spawn, fixed for that body's life.
      //   'homesteader' — pursues its own goals.
      //   'contractor'  — waits for orders authored at the foreman desk.
      mode: 'homesteader',

      world: {
        name: 'sub_agent_01',
        snapshot: 'sub_agent_01_fresh_start',
        // Restores the snapshot before the run (server is stopped for this). Only legal on the
        // 'rollback' rung — the loader refuses this combination on a continue.
        restore: true,

        // The world's light: 'dawn' (sunrise, runs on) | 'day' (pinned midday, for a repeated take)
        // | 'held' (whatever the world already holds). Legal on both rungs (Law 26).
        clock: 'dawn',
      },

      // The in-world desk a contractor is fetched from. Off for a run that starts its own bots by name.
      foreman: false,

      bots: {
        // 0 = start none. The roster is a ceiling — asking for more names than exist is refused,
        // not trimmed.
        count: 2,
      },

      autonomy: {
        // true  = the runner sends `start` to each bot it launched, by name, never broadcast.
        // false = the stack comes up and nothing is thinking until `start` is sent by hand.
        start_automatically: true,
        // At the end of a timed window: stop the fleet, or leave it standing.
        stop_at_end: true,
      },

      soak: {
        // Minutes the run is held open. Unless `abort_on_error` is on, this is the only terminator —
        // a crash mid-run still runs out the clock, since a soak measures whether the fleet recovers.
        // 0 = untimed; ends only when the operator ends it (`record_overlay.js stop`, or Ctrl-C).
        minutes: 25,

        // true ends the window early on a judge kill or MASTER_CORE error (reported at the error
        // level) and still runs the normal capture/triage/teardown (Law 8). Off by default so a
        // soak can measure fleet recovery.
        abort_on_error: true,
      },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // SMOKE — shortest run proving the stack still turns over: server up, bot connects, board posts,
    // dispatcher claims, executor acts, teardown reaps. Rollback measures whether it holds up over
    // time; this measures only that it turns over. Two bots — peer job claiming and dedup need a
    // peer (Law 25).
    smoke: {
      description: 'Shortest proof the stack still turns over: two homesteaders, two minutes, known ground.',

      rung: 'rollback',
      film: 'none',

      mode: 'homesteader',

      world: {
        name: 'sub_agent_01',
        snapshot: 'sub_agent_01_fresh_start',
        restore: true,
        clock: 'dawn',
      },

      foreman: false,

      bots: {
        count: 2,
      },

      autonomy: {
        start_automatically: true,
        stop_at_end: true,
      },

      soak: {
        // Every link this run checks fires within the first sweep cycle; a longer window buys nothing.
        minutes: 2,
        // A fault is the verdict this run asks for (see rollback.soak.abort_on_error).
        abort_on_error: true,
      },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // CONTINUE — picks the world up where the last run left it. A rollback snapshot carries a valid
    // HQ and a live body per playerdata file; a continue has neither guarantee, so its preflight
    // audits HQ and revives any corpse first. `restore: false` is what a continue is — the loader
    // refuses `restore: true` on this rung.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    continue: {
      description: 'Carry on from where the last run stopped — HQ audited, corpses revived, no restore.',
      rung: 'continue',
      film: 'none',
      mode: 'homesteader',
      // world.name is unread on this rung — server.properties names it, carried only so flipping
      // rung back to 'rollback' needs no re-typing.
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: false, clock: 'dawn' },
      foreman:     false,
      bots:      { count: 2 },
      autonomy:  { start_automatically: true, stop_at_end: true },
      // Aborts like `rollback`: a judge kill halts the planner by design (Law 13), so riding out the
      // window afterward would record a stopped sentry, not a recovery.
      soak:      { minutes: 25, abort_on_error: true },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // WATCH — a rollback run with cameras, nothing written to disk. Cameras go up between bring-up
    // and autonomy, so the run's opening is in frame.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    watch: {
      description: 'A rollback run with a camera on every bot — watched live, nothing recorded.',
      rung: 'rollback',
      film: 'watch',
      mode: 'homesteader',
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'dawn' },
      foreman:     false,
      bots:      { count: 2 },
      autonomy:  { start_automatically: true, stop_at_end: true },
      // Rides out a fault: a watched/filmed run wants the footage of the recovery (see rollback.soak).
      soak:      { minutes: 30, abort_on_error: false },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // RECORD — filmed: one .mp4 per camera plus the composite, into footage/. Three bots — footage
    // is the point, and one camera comes with each bot the overlay raises. The operator's own eye
    // (Cam_Architect) is answered once in camera_configure (Law 16).
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    record: {
      description: 'A rollback run, filmed — a camera per bot and OBS writing every one of them.',
      rung: 'rollback',
      film: 'record',
      mode: 'homesteader',
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'dawn' },
      foreman:     false,
      bots:      { count: 3 },
      autonomy:  { start_automatically: true, stop_at_end: true },
      // Rides out a fault: a watched/filmed run wants the footage of the recovery (see rollback.soak).
      soak:      { minutes: 30, abort_on_error: false },
    },

    // ═════════════════════════════════════════════════════════════════════════════════════════════
    // BENCHES — not run types: saved answers for work where the world, not the fleet, is the subject.
    // Each is expressible as one of the four run types above with fields changed; kept as its own
    // entry so a whole set of answers needn't be re-typed.
    // ═════════════════════════════════════════════════════════════════════════════════════════════

    // FOREMAN-ROLLBACK / FOREMAN-CONTINUE ask the rollback/continue pair addressed to the desk: whether
    // a person can raise and command a crew at all. Both start zero bots so the fetch itself is under
    // test (Law 25), and both are untimed since a person is present throughout (see rollback.soak).
    // Driven headless via `tools/proxy_human.js`.

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // FOREMAN-ROLLBACK — the full reset. Snapshot restored, HQ wiped cold, desk on duty, no crew.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    'foreman-rollback': {
      description: 'Foreman on known ground: restore, HQ wiped cold, dawn, desk on duty, no crew — you fetch it in chat.',
      rung: 'rollback',
      film: 'none',
      mode: 'contractor',
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'dawn' },
      foreman:     true,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: true },
      // Untimed — the operator is present throughout and owns the abort call (see rollback.soak).
      soak:      { minutes: 0, abort_on_error: false },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // FOREMAN-CONTINUE — the desk raised again over the world and crew memory the last session left.
    // No restore, no HQ wipe. Forced by `count: 0`, its continue preflight audits the whole roster,
    // since this run starts no bots (`fleet_control.js`). The server must already be serving the
    // world being continued.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    'foreman-continue': {
      description: 'Foreman over the world and crew memory the last session left — no restore, HQ audited, desk on duty, no crew pre-started.',
      rung: 'continue',
      film: 'none',
      mode: 'contractor',
      // world.name unread on this rung — same arrangement as `continue` above.
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: false, clock: 'dawn' },
      foreman:     true,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: true },
      // Untimed — the operator is present throughout and owns the abort call (see rollback.soak).
      soak:      { minutes: 0, abort_on_error: false },
    },

    // LETSPLAY-WATCH / LETSPLAY-RECORD are `foreman-rollback` with lenses on: same rung, restore,
    // cold HQ, desk on duty, zero pre-started crew. Filming is a `film` field, not a different
    // bring-up. The host seat and camera warden are declared in camera_configure (Law 16) —
    // `bots.count: 0` makes the warden the only source of a camera, so the crew filmed is the crew
    // hired in chat. Both untimed; closed with `record_overlay.js stop` from another terminal.

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // LETSPLAY-WATCH — the rehearsal. Everything the take has, writing nothing.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    'letsplay-watch': {
      description: "Let's play REHEARSAL: restore, desk on duty, your seat open, cameras follow each contractor — and nothing is written.",
      rung: 'rollback',
      film: 'watch',
      mode: 'contractor',
      // Clock pinned at midday: a take is repeated and light must match across attempts, and this
      // run is untimed, so dawn would hand a long episode's back half to the dark.
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'day' },
      foreman:     true,
      // Declares only that this run has a presenter seat; who it is lives in camera_configure (Law 16).
      host:        true,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: true },
      soak:      { minutes: 0, abort_on_error: false },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // LETSPLAY-RECORD — the take. One file per window, the presenter's voice on its own.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    'letsplay-record': {
      description: "Let's play TAKE: restore, desk on duty, your seat recorded with your microphone, and a recording camera on every contractor you hire.",
      rung: 'rollback',
      film: 'record',
      mode: 'contractor',
      // Clock pinned at midday — same reasoning as letsplay-watch above.
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'day' },
      foreman:     true,
      // Same seat, same declaration — see letsplay-watch above.
      host:        true,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: true },
      soak:      { minutes: 0, abort_on_error: false },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // BARE — server and foreman only, no restore. For work where the world itself is the subject:
    // seeding a build by console, checking a snapshot, running a probe with no participants.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    bare: {
      description: 'Server + foreman only (its body parked in spectator) — no bots, world left exactly as it is.',
      rung: 'rollback',
      film: 'none',
      mode: 'homesteader',
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: false, clock: 'dawn' },
      foreman:     false,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: false },
      // Untimed — the operator is present throughout and owns the abort call (see rollback.soak).
      soak:      { minutes: 0, abort_on_error: false },
    },
  },
};
