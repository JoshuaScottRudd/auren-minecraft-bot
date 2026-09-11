// module: run_config
// purpose: THE ONE PAGE. Every choice a run has is made here, before anything starts. Then `run.js`.
//
//     1. edit this file
//     2. . .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; & $n Auren_Workshop\run.js
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
// a set of values you can type. That is what "more verbs" means here: more that can be ASKED FOR, out
// of strictly less machinery.
//
// ── IT IS AUTHORED STOPPED, AND THAT IS THE WHOLE DISCIPLINE (Law 26) ────────────────────────────────
// *"you arent at the helm controlling the program, you configure it then it runs by itself."*
// Every field is read ONCE, before the world moves, and `run.js` takes no further input — no prompt, no
// decision mid-run, no operator at a console steering it. A run that needed steering was a run whose
// question was not settled before it started, and the answer to that is another pass at this page.
//
// ── EVERY FIELD IS A WHITELIST (Law 29) ─────────────────────────────────────────────────────────────
// Each setting below names the values it permits and excludes everything else by omission. A value that
// is not on its list is REFUSED by name before the server is touched — never guessed at, never quietly
// defaulted (Law 13). A misspelled field is caught the same way, because `run.js` checks the shape of
// this object rather than reaching for keys and finding `undefined`.

'use strict';

module.exports = {

  // ═══ THE WORLD IT RUNS ON ═════════════════════════════════════════════════════════════════════════

  // 'fresh'    roll the world back to `snapshot` and wipe what the bots remember. The old
  //            `test standard` — the baseline every comparable run starts from.
  // 'continue' leave the world and the bots' memory exactly as the last run left them. The old
  //            `test continue` — resuming a build, not restarting it.
  // 'as-is'    touch neither. For when the world is already staged by hand and a rollback would
  //            destroy the very thing being tested.
  world: 'fresh',

  // Which snapshot 'fresh' rolls back to. Ignored by 'continue' and 'as-is'.
  snapshot: 'sub_agent_01_fresh_start',

  // The server's world folder name — what `rollback.ps1` restores INTO.
  worldName: 'sub_agent_01',

  // 'dawn'  start at sunrise and let the day run. The daylight window is ~10 minutes, so this is the
  //         setting that gives a farming run its full window instead of half of one.
  // 'day'   pin midday and FREEZE the cycle. What makes two attempts at the same thing comparable.
  // 'held'  leave the clock wherever it is. The honest answer for 'as-is' worlds.
  clock: 'dawn',

  // ═══ THE PERSON WHO ASKS FOR THE CREW ═════════════════════════════════════════════════════════════
  //
  // A STANDARD RUN NOW SPAWNS A PLAYER FIRST, and this is the change that matters most on this page
  // (Architect 2026-09-10: *"a new standard run now spawns architect and you call in the bots"*).
  // Bots used to be started directly by the bench, which is a door no downloader has. They now arrive
  // the one way anybody else can get them: a person stands in the world and asks the desk. There is no
  // privileged entrance left, so a run that works here is a run that works for a stranger — which is
  // the entire point (*"i dont want to test in a way that a public user wont be using"*).

  // The name the faux player joins under. His standing name for the hand the test acts with.
  person: 'architect',

  // Where that person stands before asking — because where they stand is where the base gets sited.
  // 'biome'          the fleet's own biome scanner picks the best patch clear of world spawn, and the
  //                  person is teleported there. The crew then arrives beside them. THE DEFAULT.
  // 'spawn'          wherever the world drops them — which is INSIDE the spawn-protected square, where
  //                  the server silently refuses every dig. Use it to sample what a stranger gets.
  // '<x> <y> <z>'    teleported there first. Three whole numbers, space-separated.
  //
  // WHY 'biome' IS THE DEFAULT (Architect 2026-09-10: *"use biome scanner to place the architect bot
  // away from world center into an ideal biome with teleport then teleport the bots to the architect"*).
  // Every run before this started inside the protected square — the six scattered cells in
  // bugsquashing §14.10 and the (7,64,-9) soak pin alike — so the crew's own gate correctly refused
  // every dig near its base, and one soak logged 5,211 warnings from it. A whole class of run looked
  // "intermittent" because of where it stood.
  standing: 'biome',

  // ═══ WHAT CREW, AND HOW MUCH OF IT ════════════════════════════════════════════════════════════════

  // 'homesteader'  answers to nobody, works its own agenda. No ear mounted at all.
  // 'contractor'   yours; hears you in chat and works what you ask for.
  crew: 'homesteader',

  // ═══ HOW LONG IT RUNS UNATTENDED ══════════════════════════════════════════════════════════════════

  // Minutes the crew is left to work before teardown. This one number replaces three old tests:
  //   1   the old `test scan` — is the base sited at all, nothing more asked.
  //   15  the old `test standard` — a full daylight window.
  //   60+ the old soak profile — long enough for the second and third job to matter.
  soak: 15,

  // ═══ THE OVERLAYS — LAID ON TOP, NEVER A DIFFERENT RUN ════════════════════════════════════════════
  //
  // *"overlayed on top of it are the record and watch test."* Watching and filming are things done TO a
  // run, not species of run, so they are switches here rather than separate scripts. The run underneath
  // is byte-for-byte the same one either way.

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

  // ═══ WHAT HAPPENS WHEN IT ENDS ════════════════════════════════════════════════════════════════════

  // 'down'      reap the crew, the desk, the referee and any camera stack. The world is left running.
  // 'leave-up'  leave everything standing to be poked at by hand. YOU own the teardown.
  teardown: 'down',

  // ═══ THE SERVER IT POINTS AT ══════════════════════════════════════════════════════════════════════

  // 'local'       this script owns the world: it starts this machine's local server, and stops it at
  //               teardown. REQUIRED by world: 'fresh', because a snapshot cannot be restored under a
  //               running server — world files mid-write are not a world.
  // 'already-up'  a world is running and reachable, and this script will not touch its lifecycle. Only
  //               valid with world: 'continue' or 'as-is'. Refused if nothing is reachable, never
  //               started for you: a run that silently brings up the wrong world is worse than a stop.
  server: 'local',

  host: 'localhost',
  port: 25565,

  // THERE IS NO CONSOLE PASSWORD ON THIS PAGE ANY MORE (Architect 2026-09-10: *"no password at all for
  // local server. theres no ports open."*). With `server: 'local'` this script owns the world's whole
  // lifecycle, so it mints a fresh random console password every run and hands it to both ends. There is
  // nothing here to choose and nothing tracked for the extract to carry.
  //
  // A blank one is not the same thing and is not available: asked directly, the server answers *"No rcon
  // password set in server.properties, rcon disabled!"* and the port never opens — so blanking it removes
  // the console rather than the password, and the console is how a crew gets placed beside you.
  //
  // ONLY `server: 'already-up'` still needs one from you, because that world is not this script's to
  // reconfigure: set AUREN_RCON_PASSWORD to whatever it was started with. Typing `rconPassword` back onto
  // this page is REFUSED by name rather than ignored.
  rconPort: 25575,

  // ═══ WHERE THE BOT CODE COMES FROM ════════════════════════════════════════════════════════════════
  //
  // NOT A FIELD ANY MORE, AND THAT IS THE ANSWER RATHER THAN A GAP (Architect 2026-09-10: *"theres 2 way
  // of running the bot and i only want one"*). The code under test is the tree this file sits in.
  //
  // `downloadRoot` stood here, and the run began by copying every tracked file under `Auren_Bot/` to a
  // sibling folder outside the repository and running the copy. That existed for one reason: the tools
  // were NOT in the shipped set, so a run in place would have been a run of something a stranger could
  // not have. The workshop now lives inside the bot, so the tree in place IS the shipped tree, and the
  // copy was buying three faults for a proof it no longer provides — see `run.js`'s `clearMemory()`
  // header for what each one cost.
};
