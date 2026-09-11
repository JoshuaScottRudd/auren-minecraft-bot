// module: run_config
// purpose: THE ONE PAGE. Every choice a run has is made here, before anything starts.
//
//     1. edit this file
//     2. start your Minecraft server
//     3. . .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; & $n Auren_Workshop\run.js
//
//     ...or, if this machine is the one hosting the world, step 2 and step 3 in one pass:
//        & $n Auren_Workshop\host_and_run.js
//
// ── WHY A PAGE AND NOT A SCRIPT PER RUN (Architect 2026-09-10) ────────────────────────────────────────
// *"instead of different scripts to start the test. theres one way law 16 on how to do it. then theres
// one way to configure it. you make all the configurations before you start anything on one page then
// you click the same runscript and it runs according to the configure. so standar, continue, watch,
// record, soak, waking rules. everything that is througout all the runbook verbs are now all on a
// configuration page and the one script runs them after you configure them."*
//
// THE NAMED TESTS WERE NINE FROZEN POINTS IN A SPACE, AND THIS PAGE IS THE SPACE. `test standard`,
// `test continue`, `test scan`, `test record`, `test spawnzone`, the two foreman tests and the two
// let's-play runs were nine scripts whose only difference was a handful of settings — a fresh world or
// a carried one, one bot or two, a soak of sixty seconds or fifteen minutes, cameras up or down. Each
// one froze its combination in code, so asking for a combination nobody had frozen meant writing a
// tenth script. Every one of those settings is a FIELD below, and every one of those nine tests is now
// a set of values you can type.
//
// ── TWO SECTIONS, AND THE LINE BETWEEN THEM IS THE POINT (Architect 2026-09-11) ──────────────────────
// *"i want an architect and a user start to be identical. my commands should overlay ontop of strangers
// commands and there should be a clear seperation between what is architect and what is user."*
//
//   `run`      THE RUN ITSELF. Read by `run.js`, which is the SAME script for everybody. It joins a
//              world that is already there and never starts, stops or rolls back one.
//   `hosting`  ONLY IF THIS MACHINE IS THE ONE HOSTING THE WORLD. Read by `host_and_run.js` and by
//              nothing else — `run.js` cannot see this object at all.
//
// **`host_and_run.js` runs `run.js` as a child process**, so "the Architect's run is identical to a
// stranger's run" is a structural fact rather than a promise two scripts are trying to keep. Hosting is
// an overlay laid on top of an untouched run, in the same way `record` and `watch` are overlays laid on
// top of an untouched fleet.
//
// ── IT IS AUTHORED STOPPED, AND THAT IS THE WHOLE DISCIPLINE (Law 26) ────────────────────────────────
// *"you arent at the helm controlling the program, you configure it then it runs by itself."*
// Every field is read ONCE, before the world moves, and nothing takes further input — no prompt, no
// decision mid-run, no operator at a console steering it. A run that needed steering was a run whose
// question was not settled before it started, and the answer to that is another pass at this page.
//
// ── EVERY FIELD IS A WHITELIST (Law 29) ─────────────────────────────────────────────────────────────
// Each setting below names the values it permits and excludes everything else by omission. A value that
// is not on its list is REFUSED by name before anything is touched — never guessed at, never quietly
// defaulted (Law 13). A misspelled field is caught the same way, because each script checks the shape of
// its own object rather than reaching for keys and finding `undefined`.

'use strict';

module.exports = {

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // THE RUN — read by `run.js`. IDENTICAL FOR EVERYBODY, including him.
  // It joins a world that is already running. It never starts one, stops one, or rolls one back.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  run: {

    // ═══ WHAT THE BOTS CARRY IN FROM LAST TIME ══════════════════════════════════════════════════════

    // 'clear'  the bots start knowing nothing: `corporate_headquarters.<bot>.json` and `player_memory/`
    //          are removed. The baseline every comparable run starts from.
    // 'keep'   the bots remember what they knew — resuming a build rather than restarting it.
    //
    // THIS IS NOT THE WORLD, AND THE TWO ARE DELIBERATELY SEPARATE FIELDS NOW (2026-09-11). They used to
    // be one `world: 'fresh'|'continue'` switch that rolled the world back AND wiped the bots' notes,
    // which fused an operation only a host can perform with one anybody can. Rolling the world back is
    // `hosting.world` below. Pair them as you like; the usual pairing is fresh world + cleared memory.
    memory: 'clear',

    // 'dawn'  start at sunrise and let the day run. The daylight window is ~10 minutes, so this is the
    //         setting that gives a farming run its full window instead of half of one.
    // 'day'   pin midday and FREEZE the cycle. What makes two attempts at the same thing comparable.
    // 'held'  leave the clock wherever it is. The honest answer for a world you did not stage.
    //
    // A RUN SETTING RATHER THAN A HOSTING ONE, because setting the time needs only the server's console,
    // which anybody pointing the fleet at a world already has. Owning the folder is not required.
    clock: 'dawn',

    // ═══ THE PERSON WHO ASKS FOR THE CREW ═══════════════════════════════════════════════════════════
    //
    // A STANDARD RUN SPAWNS A PLAYER FIRST (Architect 2026-09-10: *"a new standard run now spawns
    // architect and you call in the bots"*). Bots used to be started directly by the bench, which is a
    // door no downloader has. They now arrive the one way anybody else can get them: a person stands in
    // the world and asks the desk. There is no privileged entrance left, so a run that works here is a
    // run that works for a stranger (*"i dont want to test in a way that a public user wont be using"*).

    // The name the faux player joins under.
    person: 'architect',

    // Where that person stands before asking — because where they stand is where the base gets sited.
    // 'biome'          the fleet's own biome scanner picks the best patch clear of world spawn, and the
    //                  person is teleported there. The crew then arrives beside them. THE DEFAULT.
    // 'spawn'          wherever the world drops them, then stepped straight out of the centre.
    // '<x> <y> <z>'    teleported there first. Three whole numbers, space-separated.
    //
    // EVERY ONE OF THEM ENDS AT LEAST 50 BLOCKS FROM WORLD SPAWN (Architect 2026-09-11: *"it should be
    // atleast 50 blocks away from world center"*). The proxy moves the person out if the choice left them
    // closer, and the run refuses to type `foreman get` if they are still inside — the number is
    // PERSON_CLEAR_OF_SPAWN in architect_config.
    //
    // WHY 'biome' IS THE DEFAULT (Architect 2026-09-10: *"use biome scanner to place the architect bot
    // away from world center into an ideal biome with teleport then teleport the bots to the architect"*).
    // Every run before this started inside the protected square — the six scattered cells in
    // bugsquashing §14.10 and the (7,64,-9) soak pin alike — so the crew's own gate correctly refused
    // every dig near its base, and one soak logged 5,211 warnings from it. A whole class of run looked
    // "intermittent" because of where it stood.
    standing: 'biome',

    // ═══ WHAT CREW, AND HOW MUCH OF IT ══════════════════════════════════════════════════════════════

    // 'homesteader'  answers to nobody, works its own agenda. No ear mounted at all.
    // 'contractor'   yours; hears you in chat and works what you ask for.
    crew: 'homesteader',

    // ═══ HOW LONG IT RUNS UNATTENDED ════════════════════════════════════════════════════════════════

    // Minutes the crew is left to work before teardown. This one number replaces three old tests:
    //   1   the old `test scan` — is the base sited at all, nothing more asked.
    //   15  the old `test standard` — a full daylight window.
    //   60+ the old soak profile — long enough for the second and third job to matter.
    soak: 15,

    // ═══ THE OVERLAYS — LAID ON TOP, NEVER A DIFFERENT RUN ══════════════════════════════════════════
    //
    // *"overlayed on top of it are the record and watch test."* Watching and filming are things done TO a
    // run, not species of run, so they are switches here rather than separate scripts. The run underneath
    // is byte-for-byte the same one either way — which is the same reason hosting is a separate script
    // that runs this one rather than a branch inside it.

    // true  a wake-on-error watch runs for the length of the soak and ENDS THE RUN when something wakes
    //       it, so a failure is read at the moment it happens instead of an hour later.
    // false the run soaks blind and the trace is read once at the end.
    watch: true,

    // WHICH SIGNATURES WAKE. His standing rule is errors wake, warnings sleep, and this is that rule as
    // a value you can see. Permitted: 'error' (a ❌ line), 'halt' (a bot parked inert for inspection),
    // 'death'. Nothing else is wake-worthy; every other signature still PRINTS and wakes no one.
    // An empty list means nothing wakes it — a watch that only narrates.
    wake: ['error', 'halt', 'death'],

    // Fragment tags echoed live while watching, as running commentary. [] for a silent watch.
    // Example: ['dispatcher', 'siting']
    stream: [],

    // 'off'      no camera clients, no OBS. What almost every run wants.
    // 'cameras'  the camera clients join and follow the crew. Nothing is written to disk.
    // 'film'     cameras plus OBS recording. The old `test record`.
    record: 'off',

    // ═══ WHAT HAPPENS WHEN IT ENDS ══════════════════════════════════════════════════════════════════

    // 'down'      reap the crew, the desk, the referee and any camera stack.
    // 'leave-up'  leave everything standing to be poked at by hand. YOU own the teardown.
    //
    // EITHER WAY THE WORLD IS LEFT ALONE. `run.js` did not start the server and does not stop it.
    // `host_and_run.js` stops the world it started, after this script has finished and returned.
    teardown: 'down',
  },

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // HOSTING THE WORLD — read by `host_and_run.js` ONLY. `run.js` never sees this object.
  //
  // THIS IS THE OVERLAY, AND IT IS A DIFFERENT VERB (Architect 2026-09-11, Law 1 — decoupled):
  // *"my script autostarts server then foreman check to see if the server is there not if i started it
  // with the script."*
  //
  // Starting a world and joining a world are two jobs with two owners. The fleet asks the world one
  // question — ARE YOU THERE — and gets its answer from the world itself, never from whoever started it.
  // That is what lets the same `run.js` serve a stranger who started their server by hand and him with a
  // script doing it in the same pass: neither run can tell, because neither run asks.
  //
  // WHERE THE ADDRESS IS: `Auren_Bot/your_server.js`, not here. Hosting is about this machine's server
  // FOLDER — starting the JVM, restoring a snapshot, minting a console password. The address is about
  // where to dial, which everybody needs and this section's reader is only one of.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  hosting: {

    // 'fresh'     roll the world back to `snapshot` before starting it. The baseline every comparable
    //             run starts from. Requires the server to be STOPPED, which is why only the host can do
    //             it: world files mid-write are not a world.
    // 'continue'  start the world exactly as the last run left it, and roll nothing back.
    world: 'fresh',

    // Which snapshot 'fresh' rolls back to. Ignored by 'continue'.
    snapshot: 'sub_agent_01_fresh_start',

    // The server's world folder name — what `rollback.ps1` restores INTO.
    worldName: 'sub_agent_01',

    // THERE IS NO CONSOLE PASSWORD HERE (Architect 2026-09-10: *"no password at all for local server.
    // theres no ports open."*). This script owns the world's whole lifecycle, so it MINTS a fresh random
    // one every run, writes it to server.properties before the server boots, and hands it to `run.js`
    // through the environment. Nothing to choose, nothing to remember, and no credential in a tracked
    // file for the extract to carry.
    //
    // A blank one is not the same thing and is not available: asked directly, the server answers *"No
    // rcon password set in server.properties, rcon disabled!"* and the port never opens — so blanking it
    // removes the console rather than the password, and the console is how a crew gets placed beside you.
    //
    // A world you do NOT host still needs one from you, because that world is not this script's to
    // reconfigure: put it in `Auren_Bot/your_server.js`, or set AUREN_RCON_PASSWORD.
  },
};
