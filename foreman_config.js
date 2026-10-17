// module: foreman_config
// purpose: everything the foreman is given before a run starts, as one ordered sentence, plus the address
//          of the world it runs in. The file most people who download this bot ever need to open.
//
// The first five fields below are that sentence, in order:
//
//     where    local · remote                        which world: the foreman starts yours, or joins one
//     start    rollback · continue                   from a clean start, or from where the last run stopped
//     soak     minutes                               how long it runs, then it shuts everything down
//     crew     contractor · homesteader · builder    what kind of bots
//     builder  { build }                             read only when crew is 'builder': what it builds
//
// so the default reads as a local world, a rollback start, 15 minutes, builders. The foreman reads all
// of it once at start and carries it out with nobody at the keyboard (foreman/foreman_plan.js checks it
// and says the sentence back). Everything after the sentence is the world's address, which most people
// never touch.
//
// After the sentence come the things the foreman adds around the run — the clock, the cameras, and the
// watch that ends the run on an error — and none of them change what the crew does.
//
// ── THE FOREMAN OWNS THE PROCESS ─────────────────────────────────────────────
// `where` decides one thing, and the foreman does the rest:
//   'local'   the foreman starts the Minecraft server in `serverFolder`, writes the settings the bots need
//             into it (and prints each one and why), watches it run, and stops it when the run ends. If
//             the server fails to start, the foreman reads why and says so in words.
//   'remote'  somebody else runs the world. The foreman connects to `host`/`port`, says plainly why it
//             could not if it cannot, and never starts or stops that world.
//
// The foreman stops only a server it started itself, and refuses to start one where a server is already
// answering, because that one belongs to somebody else.
//
// ── ASSUMED PRESENT, A LOUD FAILURE IF IT IS NOT (Law 13) ───────────────────────────────────────────
// Nothing here is guessed. If the world cannot be started or reached, the foreman STOPS and names this
// file and the field to change; it never falls back to another port or address.
//
// ── WHY THESE ARE THE NUMBERS ───────────────────────────────────────────────────────────────────────
// 25565 is Minecraft's own default port and 25575 is the default for RCON, the server's remote console.
// In 'local' mode the foreman reads both off the server's own server.properties instead.
//
// ── PER-COMPUTER ANSWERS GO IN THE ENVIRONMENT ──────────────────────────────────────────────────────
// Each value has an environment variable named beside it, and the environment wins over this file — use
// it when the answer differs per computer, since an edit here travels through git to every machine.

'use strict';

// Validates a port taken from the environment: a bad value falls back to the default below, so the
// foreman's reachability check names where to look (Law 13).
function port(envName, fallback) {
  const raw = parseInt(process.env[envName], 10);
  return (Number.isFinite(raw) && raw > 0 && raw < 65536) ? raw : fallback;
}

// Validates a minutes value taken from the environment; a malformed value is returned as-is so the
// foreman refuses it by name at start (Law 13).
function minutes(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

module.exports = {

  // ══ THE SENTENCE ═══════════════════════════════════════════════════════════════════════════════════

  // 1. WHERE — 'local': the foreman starts the server in `serverFolder` and stops it at the end.
  //            'remote': somebody else runs the world at `host`/`port`; the foreman only joins it.
  //                                                   environment override: AUREN_SERVER_WHERE
  where: process.env.AUREN_SERVER_WHERE || 'local',

  // 2. START — 'rollback': the bots start knowing nothing (the fleet's memory is emptied), and on a local
  //            world with a clean copy saved as world_snapshots/<world>/<world>_fresh_start inside the
  //            server folder, the world is put back to that copy first. Without one, the world is used as
  //            it is and the foreman says so.
  //            'continue': nothing is emptied or put back — the bots carry on from the last run.
  //                                                   environment override: AUREN_START
  start: process.env.AUREN_START || 'rollback',

  // 3. SOAK — minutes the run lasts, counted from the moment the crew is working (for contractors, from
  //           the moment the world is open). When it is up, the foreman sends the bots home and stops a
  //           world it started. 0 means it runs until stopped.
  //                                                   environment override: AUREN_SOAK
  soak: minutes('AUREN_SOAK', 15),

  //    ENDS — 'soak': the run lasts the soak.
  //           'built': a builder run ends the moment a bot reads the whole building standing as its plan
  //                    asks, and the soak is the longest it may take.
  //                                                   environment override: AUREN_ENDS
  ends: process.env.AUREN_ENDS || 'soak',

  // 4. CREW — 'homesteader': a crew of 2 that answers to nobody; builds a headframe with its mineshaft and
  //                          a farm. The foreman sites the base and brings them in itself.
  //           'builder':     a homesteader crew with a building in place of the farm (see `builder`). The
  //                          foreman sites the building and the headframe and brings them in itself.
  //           'contractor':  nobody is brought in; a person in the world says "foreman get contractor" and
  //                          gets a crew of 2 that works for them.
  //                                                   environment override: AUREN_CREW
  crew: process.env.AUREN_CREW || 'builder',

  // 5. BUILDER — read only when crew is 'builder'.
  //    build: the building the crew makes. The one there is: 'overgrown_survival_castle'.
  //    plan:  where that building's BUILD PLAN is. A downloaded building is built from a plan made out of
  //           it once, deciding what it may be made of, how the ground under it is scraped, and how it is
  //           split into the cubes a bot can reach from one stand. Leave blank and the crew looks where
  //           the workshop writes plans; fill in if the plan lives elsewhere. The command that makes one:
  //             node Auren_Bot/Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=<build>
  //                                                   environment override: AUREN_BUILD / AUREN_BUILD_PLAN
  builder: {
    build: process.env.AUREN_BUILD || 'overgrown_survival_castle',
    plan: process.env.AUREN_BUILD_PLAN || '',
    // Sizes the builder run to the machine while the roster remains the available pool.
    // Environment override: AUREN_BUILDER_COUNT; checked before the world or memory is touched.
    count: process.env.AUREN_BUILDER_COUNT === undefined ? 20 : Number(process.env.AUREN_BUILDER_COUNT),
  },

  //    LANDING — where a crew the foreman raises itself is put down, on a rollback start.
  //           'usual':  the nearest good ground to world spawn — the same spot every clean start of a world.
  //           'random': a spot rolled new each run, 2 to 4 loaded areas from the usual one (a loaded area
  //                     is what one bot has loaded round itself: 320 blocks across on an ordinary server,
  //                     so 640 to 1,280 blocks away). Ground that will not hold the base is rolled again,
  //                     up to 8 times, and the foreman says what was wrong with each.
  //                                                   environment override: AUREN_LANDING
  landing: process.env.AUREN_LANDING || 'usual',

  // 6. TEST — 'off': an ordinary run, the crew is raised and the soak runs.
  //           a test name: the foreman does everything up to that test's last step, shuts down without
  //           raising a single bot, and says what the test found — the ordinary startup with its tail left
  //           off, not a second way of starting (Law 16).
  //           'scan': the world comes up, the body finds a standing spot, and the base is sited — for a
  //                   homesteader that is the wheat field and the headframe. Answers "does siting still
  //                   work" in the time a world takes to come up.
  //           'inspect': for looking over what the last run built. Needs start 'continue'. The world comes
  //                   up as it was left, the one camera window a person flies is opened and put at the
  //                   base (a builder's laydown yard, a homesteader's headframe), and it stays up with no
  //                   bot raised until stopped. The short way: node start_auren.js inspect
  //                                                   environment override: AUREN_TEST
  test: process.env.AUREN_TEST || 'off',

  // ══ WHAT THE FOREMAN ADDS AROUND THE RUN ═══════════════════════════════════════════════════════════
  // None of these change what the crew does; they change what the world looks like and who is watching.

  // OBSERVER — a PERSON watching, by the name they log in under. Empty means nobody, the default. Named,
  //            the foreman puts that player in SPECTATOR and teleports them to the same spot as the crew.
  //            It does nothing else to them: they fly, cannot be hit, and cannot place a block, so
  //            watching a run never changes one. Joining late still moves them the moment they arrive; not
  //            logged in is not an error. The world must be in offline mode (the foreman sets that) for a
  //            chosen name to connect.
  //                                                   environment override: AUREN_OBSERVER
  observer: process.env.AUREN_OBSERVER || '',

  // CLOCK — 'dawn': sunrise, and the day runs on.  'day': pinned at midday for the whole run.
  //         'held': the world keeps whatever time it has (a deliberate night run).
  //                                                   environment override: AUREN_CLOCK
  clock: process.env.AUREN_CLOCK || 'dawn',

  // Windows gives fleet computation preference over ordinary desktop work; normal restores ordinary scheduling.
  windowsPriority: process.env.AUREN_WINDOWS_PRIORITY || 'high',
  // One gate owns planning and expensive route workspace; headroom determines the temporary allowance.
  memoryWorkspace: process.env.AUREN_MEMORY_WORKSPACE || 'adaptive',

  // RECORD — 'off': no cameras.  'cameras': a camera window on each bot, nothing written (any screen
  //          recorder can capture a window; each is titled Cam_<Bot>).  'film': cameras plus a recorder
  //          writing files, only on a machine that has one set up.
  //                                                   environment override: AUREN_RECORD
  record: process.env.AUREN_RECORD || 'off',

  // GO — 'now': each body starts work the moment it stands at the build.  'held': every body is raised
  //      and placed at the build first, doing nothing, so the cameras are set up while the crew arrives;
  //      once every body stands, the clock is set back to the run's start and the foreman releases them
  //      one at a time, spaced so the server is never asked to plan for the whole crew at once. The soak
  //      counts from that release. 'held' is the default.
  //                                                   environment override: AUREN_GO
  go: process.env.AUREN_GO || 'held',

  // CAMERAS — how many DIRECTED camera windows `record` raises, the ones the rig frames and cuts between.
  //           'crew': one per body, so every bot is on film.
  //           'none': not one, so the only windows are the seats a person flies (camera_configure's
  //                   `architect`) — watching a run rather than filming it.
  //           a number: that many, framed on the first bots in seniority order.
  //           Read only when `record` is not 'off'. Whichever it is, every window is up and PROVED
  //           before a single bot is raised, so a person is already watching when the crew arrives.
  //                                                   environment override: AUREN_CAMERAS
  cameras: process.env.AUREN_CAMERAS
    ? (['crew', 'none'].includes(process.env.AUREN_CAMERAS) ? process.env.AUREN_CAMERAS : Number(process.env.AUREN_CAMERAS))
    : 'none',

  // MACHINE HOUR — the one hour a day the computer has to itself, as when it opens and closes:
  //          '00:00-01:00' is midnight to 1 am. Windows does its upkeep (virus scans, drive care, cleanup) in that hour and
  //          at no other time; a run that is up when the hour opens stops for it and carries on by itself
  //          when it closes, the crew where it was. Setting it up needs an administrator terminal once
  //          per computer, and the foreman does the setting up.
  //          'off': the computer picks its own time, which is whenever nobody is at the keyboard — for a
  //                 fleet working alone, the middle of a run.
  //                                                   environment override: AUREN_MACHINE_HOUR
  machineHour: process.env.AUREN_MACHINE_HOUR || '00:00-01:00',

  // WATCH — true: the run ends the moment one of the things in `wake` happens, and says what it was.
  //         false: the run goes its whole length whatever happens, and the verdict at the end says it all.
  //                                                   environment override: AUREN_WATCH ('true' / 'false')
  watch: process.env.AUREN_WATCH ? process.env.AUREN_WATCH === 'true' : true,

  // WAKE — what ends a watched run: 'error' (a bot reports an error), 'death' (a bot is dead). A bot that
  //        leaves the fleet and does not come back always ends a watched run.
  //                                                   environment override: AUREN_WAKE ('error,death')
  wake: process.env.AUREN_WAKE ? process.env.AUREN_WAKE.split(',').map(s => s.trim()).filter(Boolean) : ['error', 'death'],

  // ══ WHERE THE WORLD IS ═════════════════════════════════════════════════════════════════════════════

  // WHERE THE WORLD IS, for 'remote'. A hostname or an IP address. In 'local' mode it is this computer.
  //                                                   environment override: AUREN_SERVER_HOST
  host: process.env.AUREN_SERVER_HOST || 'localhost',

  // The port players connect on — `server-port` in that server's server.properties. In 'local' mode the
  // foreman reads it off the file instead.
  //                                                   environment override: AUREN_SERVER_PORT
  port: port('AUREN_SERVER_PORT', 25565),

  // THE SERVER'S FOLDER, for 'local' — the folder holding server.jar and server.properties, on this computer.
  // This is the one value with no usual answer, so it is the one you fill in.
  //   example (Windows):  serverFolder: 'C:\\Users\\you\\Minecraft\\server',
  //                                                   environment override: AUREN_SERVER_DIR
  serverFolder: process.env.AUREN_SERVER_DIR || '',

  // ── THE SERVER CONSOLE (RCON) ─────────────────────────────────────────────────────────────────────
  // A crew is brought to where you stand through the console, so the bots do not start without it.
  // 'local': leave these alone. The foreman writes a new random password into server.properties each time it
  //          starts the server, and hands it to the bots itself.
  // 'remote': the owner of that world gives you its console port and password, and they go here.
  //                                                   environment override: AUREN_RCON_PORT
  rconPort: port('AUREN_RCON_PORT', 25575),

  //                                                   environment override: AUREN_RCON_PASSWORD
  rconPassword: process.env.AUREN_RCON_PASSWORD || '',
};
