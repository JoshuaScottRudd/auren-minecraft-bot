'use strict';
// architect_fleetrunbook_config.js — THE RUN, AUTHORED INSTEAD OF REMEMBERED.
//
// The Architect's ask, and it is the whole design:
//
//   "id rather it be a json so i dont have to remember terminal commands and i can do rounds of
//    testing on the same config as necessary... essentually we are extracting the config so i can
//    author it manually so that start commands arent given to the wrong bots... so a standard run
//    should ask me how long a soak is, how many bot to start if any. and so on."
//
//   "i want the config to be classified by the run instead. i need to see all the run types and
//    their configs. so standard, continue, watch, record, all need to be on my config with
//    approperiate settings... each of the 4 tests stay, we add a new config of homestead start with
//    autonomy or contractor."
//
// EVERY QUESTION HE NAMED IS A FIELD BELOW, and the file is now CLASSIFIED BY RUN: one entry per run
// type, each carrying every answer that run needs. He does not get asked at the prompt, because a
// prompt has to be re-answered every round and he explicitly wants "rounds of testing on the same
// config." The answers are written down once, read back before every run, and identical on round nine.
//
// ─── THE CONFIG IS THE ONLY WAY (Architect 2026-08-25) ──────────────────────────────────────────
// There is no CLI flag for anything on this page. `--count`, `--soak`, `--world`, `--snapshot`,
// `--no-restore`, `--keep-up` and the `record`/`watch` overlay words are GONE from the conductor.
// A run is named, and its answers are here.
//
// The cost, accepted deliberately: a one-off change means editing this file first. The thing bought
// is that "what ran" and "what is written down" cannot disagree — which is the entire reason a
// runbook exists rather than a command history (Invariant B: the same test must not mean the same
// recollection).
//
// ─── WHY .js AND NOT .json, since he asked for JSON ─────────────────────────────────────────────
// It exports a PLAIN DATA OBJECT — no logic, no computed values, nothing a JSON file could not hold.
// The only thing the extension buys is these comments, and authoring a field correctly requires
// knowing what it does. JSON has nowhere to say so, and a runbook whose fields explain themselves is
// the actual ask behind "so i dont have to remember."
//
// ─── THE BUG CLASS THIS FILE EXISTS TO CLOSE ────────────────────────────────────────────────────
// "so that start commands arent given to the wrong bots... i think that will resolve class of bugs
// that way." Two ways, worth naming separately:
//
//   1. AUTONOMY IS ADDRESSED, NEVER BROADCAST. With `start_automatically` on, the runner sends
//      `start` to each bot BY NAME, one addressed verb per bot it launched itself. A bot this run
//      did not start — a homesteader left over from other work, one the foreman fetched mid-run —
//      cannot be swept into someone else's experiment.
//
//   2. A MISSING ANSWER IS A FAULT, NOT A DEFAULT. Every field is REQUIRED and validated at load.
//      A profile that forgets `start_automatically` does not quietly get `false` — it refuses to run
//      and names the field (Law 13). A default is improvisation with a straight face.

module.exports = {

  // The run a bare command uses. Change this line to change what "a run" means today.
  active: 'standard',

  profiles: {

    // ═════════════════════════════════════════════════════════════════════════════════════════════
    // THE FOUR RUN TYPES
    //
    // Two decisions make a run, and they are separate fields because they are separate questions:
    //
    //   rung  — WHAT THE PRELIGHT DOES.  'standard' restores the snapshot and starts from known
    //           ground; 'continue' inherits whatever the last run ended in, audits HQ and revives a
    //           corpse. Only these two exist, because only these two preflights exist.
    //   film  — WHETHER LENSES COME UP.  'none' | 'watch' (cameras, nothing written) | 'record'
    //           (cameras + OBS writing a file per camera).
    //
    // `watch` and `record` are entries here so every run type is visible in one place, as asked. They
    // are NOT a third and fourth preflight — each names the rung it films, so `watch` filming a
    // continue is one word changed rather than a fifth entry (Law 16: the overlay stays one mechanism
    // no matter how many runs point at it).
    // ═════════════════════════════════════════════════════════════════════════════════════════════

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // STANDARD — known ground, bots thinking, timed. The bench everything else is measured against.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    standard: {
      description: 'Known ground: restore, flush, dawn, two homesteaders thinking on a timed window.',

      rung: 'standard',
      film: 'none',

      // WHICH SPECIES THE RUN STAMPS ON THE BOTS IT STARTS.
      //   'homesteader' — pursues its own goals. Start it and walk away.
      //   'contractor'  — waits for human-authored orders. Start it and go author some.
      // The species is stamped at spawn and never changes for that body's life, which is why it is a
      // run-level answer and not something sent later.
      mode: 'homesteader',

      world: {
        name: 'sub_agent_01',
        snapshot: 'sub_agent_01_fresh_start',
        // RESTORE THE SNAPSHOT BEFORE THE RUN. The server must be stopped to restore (a world
        // mid-write is not a snapshot) and the runner stops it for you.
        // Only legal on the 'standard' rung — a continue that restored would not be a continue, and
        // the loader refuses that combination by name rather than quietly picking one.
        restore: true,

        // WHAT THE WORLD'S LIGHT DOES FOR THE RUN. Three answers, and each one states the whole
        // clock — the time it starts at AND whether the day/night cycle then advances:
        //
        //   'dawn' — sunrise, and the day runs on from there. The ~10-minute daylight window in full.
        //   'day'  — PINNED at midday and held: the cycle is frozen, so the light in the last minute
        //            of the run is the light in its first. For a take you will repeat (two attempts
        //            are only comparable under the same light) and for a long untimed session that
        //            must not walk into a night nobody asked for.
        //   'held' — whatever time and cycle the world already holds. The deliberate night run, where
        //            the dark IS the subject.
        //
        // Legal on BOTH rungs, unlike `restore` — the clock is not part of the state a continue
        // exists to preserve. A continue carries the build, the stations, the chests and what each
        // bot knows; the hour of the day is none of those, and it is the variable that silently
        // decides whether a window is a farming test or a combat test.
        //
        // 'dawn' ON A CONTINUE IS DOING MORE WORK THAN IT LOOKS: a run ends one soak-length after it
        // begins, so an inherited clock is systematically LATER than the one that produced the state
        // being resumed, and a full window lands the resumed fleet in the dark by construction —
        // worse with every continue chained onto the last.
        //
        // Authored while the bots are still down: an input the operator writes before the machine
        // turns, never a value reached into while it runs (Law 26).
        clock: 'dawn',
      },

      // The foreman is how a contractor comes into being — it is the in-world desk you ask for a bot at.
      // Off for a run that starts its own bots by name.
      foreman: false,

      bots: {
        // 0 = start none. The roster is the ceiling; asking for more names than exist is refused
        // rather than silently trimmed, because a run that quietly gave you four when you asked for
        // six is a run whose result means something other than what you will think.
        count: 2,
      },

      autonomy: {
        // "start and stop automatically?" — his question, and this is the answer field.
        // true  = the runner sends `start` to each bot it launched, BY NAME, never broadcast.
        // false = the stack comes up and NOTHING is thinking until you send `start` yourself.
        start_automatically: true,
        // At the end of a timed window: stop the fleet, or leave it standing to walk around in.
        stop_at_end: true,
      },

      soak: {
        // HOW LONG THE RUN IS HELD OPEN, in minutes. The window is the DEFAULT terminator, and unless
        // `abort_on_error` below is on it is the ONLY one — not an error, not a death. A crash
        // mid-run still runs out the clock, because a soak measures stability and a run cut short at
        // the first corpse throws away the only evidence that could show whether the fleet recovers.
        //
        // 0 = UNTIMED. The run is held open FOREVER and ends only when you end it
        // (`record_overlay.js stop` from another terminal, or Ctrl-C).
        //
        //   "soak is optional. i could do a standard run unattended. so if theres no time on the soak
        //    length then it goes forever. soak was for homesteading bots running autonomous for
        //    testing. now i have to participate and i dont want it shutting down on me while im
        //    working."   (Architect 2026-08-25)
        //
        // That is why 0 is a first-class answer rather than an edge case: a run he is PARTICIPATING
        // in has no length he could have known in advance, and a timer on it is a stranger deciding
        // when his work is over.
        minutes: 25,

        // DOES A CRASH END THE RUN? Default NO, for the reason above: a soak measures whether the
        // fleet recovers, and a run that stops at the first fault deletes the evidence it was raised
        // to collect. So this stays off on every profile whose subject is a fleet that already works.
        //
        // true = a JUDGE KILL or a MASTER_CORE ERROR ends the window early, and the run then captures,
        // triages and tears down exactly as a completed one does — an abort is a SHORTER run, never a
        // skipped teardown (Law 8: whoever raises a lifecycle ends it).
        //
        // A DEATH IS IN THAT SET, and it reaches the predicate as an error rather than by name: the body
        // reports its own death at the error level, so `abort_on_error` catches it with nothing added.
        // This line used to claim the opposite — that a death was deliberately excluded so a soak could
        // measure the recovery — and the code never implemented the exclusion. Excluding it is also the
        // wrong trade while a shelter is what the run is testing: a bot that died is a bot that was
        // outside at nightfall, which is the FAILURE the run exists to detect, and the twenty minutes
        // after it are a corpse's twenty minutes. The recovery path has its own bench
        // (virtual_playground/scenario_respawn_recovery), so nothing is lost by ending here.
        //
        // Turn it on while a FEATURE IS BEING BUILT, which is the case it exists for: a run asking
        // "does this new chain work at all" learns nothing from the twenty minutes after it threw, and
        // the throw IS the answer. Turn it off again once the feature is the thing being soaked rather
        // than the thing being proved.
        abort_on_error: true,
      },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // SMOKE — the shortest run that still proves the whole stack turns over. Two bots, two minutes.
    //
    // WHY IT IS NOT `standard` WITH A SMALLER NUMBER ON IT. It asks a different question, and the
    // window is the only field that differs because the question is the only thing that differs.
    // `standard` asks whether the fleet is STABLE — whether a build progresses, whether a fault is
    // recovered from, whether two bots stay out of each other's way over a window long enough for
    // any of that to show. This asks only whether the fleet still RUNS after a change: does the
    // server come up, does a bot connect, does the board post, does the dispatcher claim, does an
    // executor act, does the teardown reap what it raised. That is answered in the first minutes or
    // not at all, so a longer window buys nothing and costs the time it takes to find out that a
    // require is broken. Reach for `standard` the moment the question is about behaviour over time.
    //
    // TWO BOTS, NOT ONE, and the reason is that the stack this run is proving INCLUDES the parts
    // that only exist when there is a peer: the planning token, peer job claiming, and job dedup.
    // A single bot comes up green through all three because none of them is ever exercised, which
    // makes a one-bot pass a narrower claim than it reads as (Law 25 — the verdict has to mean what
    // the reader will take it to mean).
    //
    // It restores the snapshot like `standard` does. A smoke test on unknown ground reports facts
    // about a world nobody chose, and a run whose starting state was not decided cannot be compared
    // to the last one.
    smoke: {
      description: 'Shortest proof the stack still turns over: two homesteaders, two minutes, known ground.',

      rung: 'standard',
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
        // The window is sized by what the question needs, not by what a run can hold. Every link
        // this run is asking about fires within the first sweep cycle: connect, post, claim, act,
        // tear down. Past that the run is repeating an answer it already gave, and a longer window
        // only delays a verdict that was available at minute two.
        minutes: 2,
        // A smoke test asks one question — did the stack come up and think — so a fault IS the verdict
        // and the remaining minute repeats an answer already given (standard.soak carries the full
        // reasoning for this field).
        abort_on_error: true,
      },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // CONTINUE — pick the world up where the last run left it.
    //
    // "continue has to verify that the corporate HQ is valid before starting else the fleet is
    //  bricked… it also has to make sure the bots are alive."  (Architect 2026-08-14)
    //
    // A standard run answers both questions by construction — the snapshot carries a valid HQ and
    // every playerdata file in it holds a live body. A continue answers neither, so its preflight
    // audits HQ and revives any corpse before anything starts.
    //
    // `restore: false` is not a preference here, it is what a continue IS. The loader refuses
    // `restore: true` on this rung.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    continue: {
      description: 'Carry on from where the last run stopped — HQ audited, corpses revived, no restore.',
      rung: 'continue',
      film: 'none',
      mode: 'homesteader',
      // The world is NOT this file's to choose on a continue — server.properties already recorded it,
      // and both the server-start preflight and fleet_revive read it back from there, so the served
      // world and the audited one cannot drift apart. The name below is carried so flipping the rung
      // back to 'standard' does not also require remembering it; it is not read while rung is continue.
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: false, clock: 'dawn' },
      foreman:     false,
      bots:      { count: 2 },
      autonomy:  { start_automatically: true, stop_at_end: true },
      // ABORTS LIKE `standard`, and the reason is stronger here than there. The soak argument for
      // riding out a fault — a run that stops at the first crash deletes the evidence of whether the
      // fleet RECOVERS — assumes there is a fleet still planning afterwards to recover. A judge kill
      // halts the planner by design (Law 13, default stopped): nothing plans again until an operator
      // re-tasks it, so the remaining window records a sentry standing still. That is not a measured
      // recovery, it is silence with a clock on it.
      //
      // A continue also inherits the state the LAST run ended in, so a fault seconds after bring-up is
      // usually the very condition being resumed to examine rather than a stumble on the way somewhere.
      // Holding the window open past it spends the operator's time to observe a halt that was fully
      // described the instant it fired.
      soak:      { minutes: 25, abort_on_error: true },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // WATCH — the same run, with lenses to watch it through and nothing written to disk.
    //
    // The cameras go up BETWEEN the bring-up and autonomy, so the opening of the run is in frame
    // rather than missed. That ordering is a consequence of filming, not a knob: a crew raised after
    // the first thought has already lost the thing worth watching.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    watch: {
      description: 'A standard run with a camera on every bot — watched live, nothing recorded.',
      rung: 'standard',
      film: 'watch',
      mode: 'homesteader',
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'dawn' },
      foreman:     false,
      bots:      { count: 2 },
      autonomy:  { start_automatically: true, stop_at_end: true },
      // Rides out a fault — a filmed/watched run wants the footage of the recovery, which is
      // exactly what an abort throws away (see standard.soak).
      soak:      { minutes: 30, abort_on_error: false },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // RECORD — the same run again, filmed. One .mp4 per camera plus the composite, into footage/.
    //
    // Three bots is the shipping default because footage is the point of this run and one camera per
    // bot is what the overlay raises — nothing is added on top, so a count of 3 means 3 windows.
    // The Architect's own eye (Cam_Architect) is NOT a field here: it is answered once in
    // camera_configure, which is the file that owns what the camera stack is (Law 16).
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    record: {
      description: 'A standard run, filmed — a camera per bot and OBS writing every one of them.',
      rung: 'standard',
      film: 'record',
      mode: 'homesteader',
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'dawn' },
      foreman:     false,
      bots:      { count: 3 },
      autonomy:  { start_automatically: true, stop_at_end: true },
      // Rides out a fault — a filmed/watched run wants the footage of the recovery, which is
      // exactly what an abort throws away (see standard.soak).
      soak:      { minutes: 30, abort_on_error: false },
    },

    // ═════════════════════════════════════════════════════════════════════════════════════════════
    // BENCHES — not run types. Saved answers for work where the world, not the fleet, is the subject.
    //
    // Both are expressible as one of the four above with fields changed; they are kept as their own
    // entries because each is a whole set of answers he would otherwise re-type, and because
    // `contractor` is what the in-world control work is currently being built against. Deleting
    // either is a block delete and changes nothing else.
    // ═════════════════════════════════════════════════════════════════════════════════════════════

    // ═════════════════════════════════════════════════════════════════════════════════════════════
    // THE TWO FOREMAN TESTS (Architect 2026-09-01)
    //
    //   "i need to add logic to the fleet runbook that does a foreman standard test which is a full
    //    reset and a forman continue test. so both of those start up the forman system and dont auto
    //    start any bots."
    //
    // THEY ARE THE SAME PAIR OF QUESTIONS `standard` AND `continue` ASK, ADDRESSED TO THE DESK INSTEAD
    // OF THE CREW. A homesteader run asks whether bots the terminal started can work a window; a
    // foreman run asks whether a person standing in the world can raise a crew and command it at all.
    // So the split between them is the same split, and for the same reason: one starts from ground
    // nobody has touched, the other picks up whatever the last session left standing.
    //
    // BOTH START ZERO BOTS, and that is not a setting — it is what makes them foreman tests. A
    // contractor comes into being by being ASKED for, in chat, at the desk (`foreman get auren`), and
    // that fetch is the pathway under test. A run that pre-started the crew would come up looking
    // identical and would have skipped the only thing it was raised to exercise (Law 25).
    //
    // BOTH ARE UNTIMED for the same reason: a person is inside them. A soak length is a stranger
    // deciding when his work is over (standard.soak carries his sentence on this).
    //
    // NOT AT A KEYBOARD IN THE GAME? `tools/proxy_human.js` joins as a real player and puts a prompt in
    // the terminal — every line typed goes into chat as a person, which is the only sender the desk
    // accepts (a console `/say` arrives as `profileless_chat` and is refused by design). That is how
    // either of these runs is driven without opening Minecraft.
    //
    // `foreman-standard` WAS NAMED `contractor` until 2026-09-01. Same run, renamed for the thing it
    // RAISES rather than the thing it eventually fetches — which is what makes it one of a pair with
    // the continue below rather than a bench standing on its own.
    // ═════════════════════════════════════════════════════════════════════════════════════════════

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // FOREMAN-STANDARD — the full reset. Snapshot restored, HQ wiped cold, desk on duty, world empty
    // of crew. Everything that happens after this happened because somebody said it in chat.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    'foreman-standard': {
      description: 'Foreman on known ground: restore, HQ wiped cold, dawn, desk on duty, no crew — you fetch it in chat.',
      rung: 'standard',
      film: 'none',
      mode: 'contractor',
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'dawn' },
      foreman:     true,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: true },
      // Untimed, so nothing auto-stops it and a fault does not either — the operator is present by
      // definition on an untimed run and owns that call (see standard.soak).
      soak:      { minutes: 0, abort_on_error: false },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // FOREMAN-CONTINUE — the desk raised again over the world and the crew memory the last session
    // left. No restore, no HQ wipe: the base that was built, the stations that were sited and every
    // place a contractor remembers are exactly what this run exists to walk back into.
    //
    // IT RUNS THE CONTINUE PRELIGHT LIKE ANY OTHER CONTINUE (Architect 2026-08-14: "continue has to
    // verify that the corporate HQ is valid before starting else the fleet is bricked… it also has to
    // make sure the bots are alive"), and there is one thing it does differently, forced by `count: 0`:
    // it audits the WHOLE ROSTER rather than the bots this run starts, because this run starts none and
    // will not know who the crew is until somebody asks for one. Auditing nobody would be a preflight
    // that passes by having no questions. `fleet_control.js` holds that rule and its reasoning.
    //
    // THE SERVER MUST ALREADY BE SERVING THE WORLD BEING CONTINUED, or be startable on the one
    // `server.properties` already names — picking a world is the single decision a continue may never
    // make silently, so nothing here names one.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    'foreman-continue': {
      description: 'Foreman over the world and crew memory the last session left — no restore, HQ audited, desk on duty, no crew pre-started.',
      rung: 'continue',
      film: 'none',
      mode: 'contractor',
      // Carried but not read while the rung is continue — server.properties already recorded the world,
      // and both the server-start preflight and fleet_revive read it back from there so the served world
      // and the audited one cannot drift apart. The name is here so flipping the rung back to 'standard'
      // does not also require remembering it (same arrangement as `continue` above).
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: false, clock: 'dawn' },
      foreman:     true,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: true },
      // Untimed, so nothing auto-stops it and a fault does not either — the operator is present by
      // definition on an untimed run and owns that call (see standard.soak).
      soak:      { minutes: 0, abort_on_error: false },
    },

    // ═════════════════════════════════════════════════════════════════════════════════════════════
    // THE TWO LET'S PLAY RUNS (Architect, 2026-09-06)
    // ═════════════════════════════════════════════════════════════════════════════════════════════
    //   *"local server standard record test… means you roll back the server, start it up, start up a
    //    client for me to control and have obs record it. it should also record my mic. so i can talk
    //    through a lets play but nothing else. just client window and microphone. then ill call foreman
    //    get and get 2 bots, they start up and with their start also starts cameras that are recording.
    //    i want two types. a watch where theres no recording so we can test and a record where you
    //    actually record everything."*
    //
    // THEY ARE `foreman-standard` WITH LENSES ON, AND THAT IS THE WHOLE OF THE DIFFERENCE. Same rung,
    // same restore, same cold HQ, same dawn, same desk, same zero crew, same untimed shape. Filming is
    // orthogonal to what a run IS (record_overlay's header carries the argument), so a filmed
    // contractor run is a `film` field and not a new kind of bring-up — which is what keeps the two of
    // them from drifting away from the unfilmed one they are supposed to be identical to.
    //
    // WHY THEY ARE SEPARATE ENTRIES AND NOT ONE. He asked for the pair by name: `watch` is the
    // rehearsal — every window and every camera exactly as the real thing, and not one byte written —
    // and `record` is the take. A single entry with the word typed after it was the shape that got
    // retired on 2026-08-25: the run's answers are authored, not typed at a prompt.
    //
    // WHAT MAKES THEM A LET'S PLAY RATHER THAN A FILMED TEST is two things neither of them states
    // here, because both are seats and seats are camera_configure's to declare (Law 16 — one owner):
    // the HOST SEAT (`host.enable`), the client he plays and the only file in a take carrying his
    // microphone, and the CAMERA WARDEN, which the overlay raises on every filmed run and which gives
    // a camera to each contractor as it stands up. `bots.count: 0` is what makes the warden the only
    // way a camera ever appears here — and that is the point, because a crew that was pre-started
    // would not be the crew he hired on camera.
    //
    // BOTH ARE UNTIMED. An episode is over when the presenter says it is; a soak length would be a
    // stranger deciding when his work is done. Closed with `record_overlay.js stop`, from any other
    // terminal, because he is in a game window rather than watching a console.
    // ═════════════════════════════════════════════════════════════════════════════════════════════

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // LETSPLAY-WATCH — the rehearsal. Everything the take has, writing nothing.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    'letsplay-watch': {
      description: "Let's play REHEARSAL: restore, desk on duty, your seat open, cameras follow each contractor — and nothing is written.",
      rung: 'standard',
      film: 'watch',
      mode: 'contractor',
      // CLOCK PINNED AT MIDDAY, unlike every other run on this page. A take gets repeated — the same
      // opening filmed three times until one of them is the one — and three attempts under three
      // different light levels cannot be cut together or compared. This run is also UNTIMED, so
      // 'dawn' would hand the back half of a two-hour episode to the dark. Frozen, the footage of
      // minute one and minute ninety match.
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'day' },
      foreman:     true,
      // The presenter. WHO that seat is — its window name, the player name it joins under, which
      // microphone and which mixer track — lives in camera/camera_configure.js. This says only that a
      // run of this kind HAS one, which is what makes it a let's play rather than a filmed test.
      host:        true,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: true },
      soak:      { minutes: 0, abort_on_error: false },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // LETSPLAY-RECORD — the take. One file per window, his voice on his own.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    'letsplay-record': {
      description: "Let's play TAKE: restore, desk on duty, your seat recorded with your microphone, and a recording camera on every contractor you hire.",
      rung: 'standard',
      film: 'record',
      mode: 'contractor',
      // CLOCK PINNED AT MIDDAY, unlike every other run on this page. A take gets repeated — the same
      // opening filmed three times until one of them is the one — and three attempts under three
      // different light levels cannot be cut together or compared. This run is also UNTIMED, so
      // 'dawn' would hand the back half of a two-hour episode to the dark. Frozen, the footage of
      // minute one and minute ninety match.
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: true, clock: 'day' },
      foreman:     true,
      // Same seat, same declaration — see letsplay-watch above.
      host:        true,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: true },
      soak:      { minutes: 0, abort_on_error: false },
    },

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // BARE — server and overseer only. Nothing else, and no restore.
    //
    // For the times the world itself is the subject: seeding a build by console, checking a snapshot,
    // running a probe that wants a server and no participants.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    bare: {
      description: 'Server + overseer only — no foreman, no bots, world left exactly as it is.',
      rung: 'standard',
      film: 'none',
      mode: 'homesteader',
      world:     { name: 'sub_agent_01', snapshot: 'sub_agent_01_fresh_start', restore: false, clock: 'dawn' },
      foreman:     false,
      bots:      { count: 0 },
      autonomy:  { start_automatically: false, stop_at_end: false },
      // Untimed, so nothing auto-stops it and a fault does not either — the operator is present by
      // definition on an untimed run and owns that call (see standard.soak).
      soak:      { minutes: 0, abort_on_error: false },
    },
  },
};
