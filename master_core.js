// master_core.js — the bot process's entry point: wires identity, world connection, the tick seats, and
// the shutdown/crash paths into one process.
const moduleAlias = require('module-alias');
moduleAlias.addAliases({
  '@perception': __dirname + '/perception_nodes.js',
  '@action': __dirname + '/action_fragments.js',
  '@api': __dirname + '/custom_api',
  '@locomotion': __dirname + '/custom_api/locomotion',
  '@kernel': __dirname + '/js_kernel',
  '@js_kernel': __dirname + '/js_kernel',
  '@utils': __dirname + '/js_kernel/utils',
  '@thinking': __dirname + '/Thinking_fragments',
  '@foreman': __dirname + '/foreman'
});

// A body's console is a pipe to the foreman, and a pipe write on Windows waits on this process's own loop
// for its reader; the lane hands each line to the thread pool so a paused reader never holds the body
// (js_kernel/utils/console_lane). Installed before the first line is printed.
require('@utils/console_lane').install();

// Read before anything else can act: readMandate() throws on an absent or unknown BOT_MODE, never
// assumes one, so a process that cannot say which species it is never starts behaving like one (Law 13).
const botMandate = require('@kernel/bot_mandate');
const MANDATE = botMandate.readMandate();

const mineflayer = require('mineflayer');
const readline = require('readline');
const { pathfinder } = require('mineflayer-pathfinder');
const { inject: runPerceptionFragmentTester } = require('@perception/perception_fragment_tester.js');
const foremanLink = require('@kernel/foreman_link.js');
// Same protocol version the virtual playground reads out of the block registry (Law 16 — one authored
// answer).
const { SERVER_MINECRAFT_VERSION, SERVER_ENDPOINT } = require('@thinking/architect_config');


function delayedChat(bot, message, delay = 1) {
  setTimeout(() => {
    bot.chat(message);
    console.log(`💬 Delayed chat: "${message}"`);
  }, delay);
}
global.delayedChat = delayedChat;

// Marks a bot window as itself: its own log stream is silenced to the foreman, so this banner is nearly
// all it ever prints. Cyan is reserved so warning/error colors elsewhere stay meaningful. Carries the
// species because that decides whether the bot in this window answers a human at all.
(function botBanner() {
  const C = '\x1b[96m\x1b[1m', R = '\x1b[0m';
  const bar = '═'.repeat(50);
  console.log(`${C}${bar}${R}`);
  console.log(`${C}  🤖  BOT WINDOW  ·  ${MANDATE.botId}${R}`);
  console.log(`${C}      ${botMandate.describeMandate()}${R}`);
  console.log(`${C}      logs stream to the FOREMAN terminal — this window`);
  console.log(`${C}      is just to run the bot (type: start | stop | flush | wipe)${R}`);
  console.log(`${C}${bar}${R}`);
})();

console.log('🧐 Launching unified master core...');

// ── RESPAWN IS A COMMAND, NOT A REFLEX ────────────────────────────────────────────────────────────
// `respawn: false` overrides mineflayer's default so a death does not hand a stale chain a fresh live
// body at world spawn (Invariant B) — DEAD is the serialization point, since a corpse cannot act.
// respawn_executor is the only caller of `bot.respawn()` in the fleet (Law 16).
const bot = mineflayer.createBot({
  host: SERVER_ENDPOINT.host,
  port: SERVER_ENDPOINT.port,
  username: process.env.BOT_ID || 'AurenBot',
  version: SERVER_MINECRAFT_VERSION,
  respawn: false,
});

bot.loadPlugin(pathfinder);

// ── THE SPAWN-PROTECTED SQUARE IS LATCHED BEFORE LOGIN FINISHES, NOT AT SPAWN ────────────────────
// `spawn_position` is a login packet sent before `spawn` fires, so the listener must exist here,
// immediately after createBot, to catch it. `bot.spawnPoint` starts at (0,0,0), which this fleet's
// worlds also spawn at, so reading it before the packet lands would be a well-formed falsehood (Law 26).
require('@perception/spawn_protection').armSpawnProtection(bot);

// Every change to this body's pocket, sent to the foreman's item book (item_book says how it is read).
require('@kernel/item_book').arm(bot);
// Every position the server sets for this body, said as it happens (server_account says how it is read).
require('@kernel/server_account').arm(bot);
// A body flush against a block face is kept on the open side of it (block_face_seat says why).
require('@kernel/block_face_seat').arm(bot);
// The server's tick, heard once a second; a frozen server ends the body (server_pulse says why).
require('@kernel/server_pulse').arm(bot);

// ── BOUNDARY TRANSLATOR: difficulty packet carries a NAME on 26.1, upstream still indexes by ordinal ──
// Sits here, beside the spawn latch, since `difficulty` also arrives during login before `spawn` fires.
// mineflayer indexes `packet.difficulty` by ordinal; 26.1 sends a name instead, so the index is
// `undefined` and `isPeacefulWorld()` (Law 13, unknown-is-hostile) reads that as hostile forever (Law 26).
// Rewrites the difficulty back to the ordinal upstream's own line handles (Law 16); an ordinal already
// present, or an unknown name, passes through untouched.
const DIFFICULTY_NAMES = ['peaceful', 'easy', 'normal', 'hard'];
bot._client.prependListener('difficulty', (packet) => {
  if (typeof packet.difficulty !== 'string') return;      // already an ordinal — upstream is correct
  const ordinal = DIFFICULTY_NAMES.indexOf(packet.difficulty);
  if (ordinal !== -1) packet.difficulty = ordinal;
});


// ── A CORPSE CANNOT ANNOUNCE ITSELF ───────────────────────────────────────────────────────────────
// A body that reconnects dead consumes mineflayer's one-shot spawn gate without firing `spawn`, so every
// handler below would hang off an event that never arrives. `health` is the first packet sent about the
// body either way, so the revive clicks respawn here and lets health's own branch emit `spawn` (Law 16).
// Gated on `global.bot` unset so this owns login only; after spawn runs, death owns the signal (Law 4).
bot.on('health', () => {
  if (global.bot || bot.health > 0) return;
  require('@action/death_manager.js').reviveBody(bot).then(r => {
    console.log(`💀→🧍 joined dead: ${r.why}`);
  });
});

bot.once('spawn', () => {
  console.log('✅ Bot spawned. Initializing perception and coldstart...');
  console.log(bot.version);
  console.log('Mineflayer version:', require('mineflayer/package.json').version);
  console.log('🔧 Native bot.craft available:', typeof bot.craft === 'function');

  global.bot = bot;

  // Masks the spawn square out of every scan, route and plan without a fragment asking. Done here rather
  // than beside the arm because `maskWorldReads` wraps `bot.blockAt`, which mineflayer has not attached
  // until the body is whole at spawn.
  require('@perception/spawn_protection').maskWorldReads(bot);

  // Logs the spawn square once per run regardless of outcome, so a later "nothing to mine" reads as a
  // keep-out, never an empty world (Law 6). An unknown square is reported here, while it is still
  // actionable, since every dig and placement this session will be refused otherwise.
  {
    const spawnProtection = require('@perception/spawn_protection');
    const line = spawnProtection.describeSpawnProtection(bot);
    if (spawnProtection.spawnProtectionBox(bot) || /is OFF/.test(line)) {
      require('@kernel/watcher').summary('master_core', line);
    } else {
      require('@kernel/watcher').warn('master_core', line);
    }
    console.log(`🛡  ${line}`);
  }

  // 🧪 This triggers the server to resend recipe information
  bot._client.write('client_command', { payload: 0 });

  // ── BOUNDARY TRANSLATOR: mineflayer's explosion handler crashes the process on 1.21.3 and later ────
  // Law 16's one legal catch — a third-party fault turned into a Law 13 outcome at the seam, logged, not
  // swallowed. On 1.21.3+ the server sends playerKnockback in place of the playerMotion* fields
  // mineflayer/lib/plugins/physics.js still reads, feeding `undefined`s into Vec3.add and crashing the
  // process on every detonation; a prepended listener spreads playerKnockback into those fields and
  // deletes it, so upstream's own correct branch runs unchanged (inert on the old packet shape).
  //
  // Also bounded against physical reality, not just shape (Law 26): a finite-but-extreme value can stall
  // prismarine-physics's swept-AABB scan and get the bot silently kicked. The cap is ~2.5× terminal
  // velocity; a reject drops the knockback whole — never clamped into an invented physics event.
  const EXPLOSION_KNOCKBACK_MAX_BPT = 10;
  // Unguarded on purpose: validation is the correct form here, and a throw from our own arithmetic must
  // reach reportCrash (Law 13: default stopped).
  bot._client.prependListener('explosion', (explosion) => {
    const kb = explosion.playerKnockback;
    if (!kb) return;
    delete explosion.playerKnockback;        // FIRST — a return below must still leave the branch disarmed
    const finite = Number.isFinite(kb.x) && Number.isFinite(kb.y) && Number.isFinite(kb.z);
    const sane = finite && Math.max(Math.abs(kb.x), Math.abs(kb.y), Math.abs(kb.z)) <= EXPLOSION_KNOCKBACK_MAX_BPT;
    if (sane) {
      explosion.playerMotionX = kb.x;
      explosion.playerMotionY = kb.y;
      explosion.playerMotionZ = kb.z;
    } else {
      require('@kernel/watcher').warn('master_core',
        `explosion knockback REJECTED at the boundary: {x:${kb.x}, y:${kb.y}, z:${kb.z}} — ` +
        `${finite ? `beyond the ${EXPLOSION_KNOCKBACK_MAX_BPT} b/tick physical bound` : 'not finite'}. ` +
        'Blast shove dropped, physics left sane, bot alive. These numbers are the evidence for whether ' +
        "the server's packet matches minecraft-data's vec3f schema — record them.");
    }
  });

  // A person's crew is announced once, by the foreman, in the reply to the `get` that asked for it — not
  // here (Law 16: one arrival, one voice). See THE BOT DOES NOT SPEAK in Thinking_fragments/dispatcher.js.

  // A contractor arrives where its owner is standing, fired once at birth, never posted as a job (Law 8)
  // — a job would re-post every time the two bodies drifted apart. Not awaited: the seats below are
  // process-lifetime listeners independent of body position, and a teleport here is allowed to fail.
  require('@action/report_to_owner.js').announce(bot);

  const survivalInstincts = require('@locomotion/survival_instincts');
  survivalInstincts.start(bot);

  // ── THE CREW'S TICK SEATS, IN THE ORDER THEY MUST RUN ────────────────────────────────────────────
  // Commander first and unconditionally: the fleet's only monster scanner, sweeping whether or not a
  // fight is open so the gunner is never starved waiting on an engagement.
  require('@api/commander').start(bot);

  // The gunner attaches once for the process and engages per wave via one boolean (Law 8), never by
  // attaching/detaching a physicsTick listener per engagement. Registered after the commander so it reads
  // the board the commander wrote this same tick (Invariant C).
  require('@api/gunner').start(bot);

  // Driver last in the same chain: it reads both the commander's board and `bot.entity.yaw`, the facing
  // the gunner just wrote, so its keys are computed against the facing the body holds this same tick.
  require('@api/driver').start(bot);

  // The death edge, installed beside the other process-lifetime listeners (Law 8). The decision it feeds
  // lives at the battle_stations gate — see armDeathWatch's header on why an edge latch and a health
  // poll differ.
  require('@api/battle_stations').armDeathWatch(bot);

  // Connect to foreman if URL is configured (env var FOREMAN_URL).
  // If not set, the bot runs in local-brain mode — no change to behavior.
  const foremanUrl = process.env.FOREMAN_URL || null;
  const botId = process.env.BOT_ID || bot.username || 'AurenBot';

  // Clears any magnet claim left by a previous process under this id before registering (Law 8) — a hard
  // kill skips both exit paths that would clear it, and a relaunch under the same id survives
  // `releaseAbsentBotMagnets` (catches only an absent holder). Same clearMagnet(), not a second pathway
  // (Law 16).
  require('@thinking/dispatcher.js').clearMagnet(botId);

  foremanLink.connect(foremanUrl, botId);
  foremanLink.startBodyCellPublisher(bot);

  // Startup only: after peer chairs have had a moment to arrive over the foreman, announce
  // our spawn position and the distance to the nearest other bot (if one is connected).
  setTimeout(() => foremanLink.recordStartupPosition(bot), 4000);

  // ── A CONTRACTOR IS BORN STARTED ──────────────────────────────────────────
  // A contractor is defined as a body already working, so there is no un-started contractor to poll or
  // wait on (Law 27); `beginsWorkAtBirth` on the mandate owns which species starts here. Placed after the
  // seats and the foreman link so the first plan cycle claims through peer arbitration (Law 4). Reported
  // from `inject()`'s outcome, since it can refuse; chained, not awaited, since this is `spawn`'s
  // synchronous listener.
  if (botMandate.beginsWorkAtBirth()) {
    // The first plan waits for the world round the body to arrive (world_ready).
    require('@kernel/world_ready').awaitWorld(bot).then(() => require('@action/start_injector.js').inject()).then((r) => {
      if (r && r.started) {
        console.log(`🚀 ${botMandate.isContractor() ? 'Contractor — born started' : botMandate.isBuilder() ? 'Builder — launched to work' : 'Homesteader — launched to work'}.`
          + ' Autonomous start signal injected.');
      } else {
        console.log(`⛔ ${botMandate.currentMode()} did not start — ${(r && r.why) || 'the start injector refused and said nothing'}.`
          + ' Nothing was surveyed and nothing was locked; the trace carries the detail.');
      }
    });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('line', (input) => {
    if (!input) return;

    const args = input.trim().split(' ');
    const command = args[0];

    switch (command) {
      case 'stop':
        rl.close();
        require('@kernel/operator_commands').execute('stop', {}, botMandate.ORIGIN.TERMINAL);
        break;
      case 'inject':
        const testInjector = require('@action/test_injector');
        testInjector.inject();
        break;
      case 'test_locklayout': {
        // Runs the base-layout survey from where this body stands and reports it only — nothing is
        // written. The full survey lands on watcher_<BotId>.json under 'lock_all_buildspots'. Siting a
        // base is the foreman's alone, before any body spawns, so this never commits the result.
        require('@action/lock_all_buildspots').run(global.bot, { dryRun: true })
          .then(r => console.log(`🧪 lock_all_buildspots (dry run): ok=${r.ok} transient=${!!r.transient} would lock=[${(r.site || []).map(s => s.roomKey).join(', ')}]`))
          .catch(e => console.log(`🧪 lock_all_buildspots threw (expected on a bad layout): ${e.message.split('\n')[0]}`));
        break;
      }
      case 'test_fragment':
        // Fire the fragment_tester's single-fragment isolation harness (edit TARGET/PAYLOAD
        // in fragment_tester.js + temporarily reroute the fragment under test back to it first).
        require('@action/fragment_tester').inject();
        break;
      case 'kill':
        delayedChat(bot, `/kill ${bot.username}`);
        console.log(`☠️ Sent /kill command for ${bot.username}`);
        break;
      case 'start':
        require('@kernel/operator_commands').execute('start', {}, botMandate.ORIGIN.TERMINAL);
        console.log('🚀 Injected autonomous start signal.');
        break;
      case 'sentry':
        require('@kernel/operator_commands').execute('sentry', {}, botMandate.ORIGIN.TERMINAL);
        console.log('🛡️ Sentry mode armed — threat scan only, isolated from the planning recursion.');
        break;
      case 'see':
        // Unguarded on purpose: perception_fragment_tester already answers every bad-input case with a
        // correction (Law 13), and a catch here would reduce a real stack to one message line.
        runPerceptionFragmentTester(args[1]);
        break;
      case 'teleport': {
        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(Number.isNaN)) {
          console.log('Usage: teleport <x> <y> <z>');
          break;
        }
        delayedChat(bot, `/tp ${bot.username} ${x} ${y} ${z}`);
        break; }
      case 'flush':
        require('@kernel/operator_commands').execute('flush', {}, botMandate.ORIGIN.TERMINAL)
          .then(() => console.log('🧹 Flushed configured kernel JSON files.'))
          .catch((e) => console.error('❌ Flush command failed:', e.message));
        break;
    }
  });
});

bot.on('recipesUpdated', () => {
  console.log('✅ Recipes unlocked. Found:', bot.recipes.length);
});

bot.on('error', (err) => {
  console.error('❌ Bot Error:', err);
});

// ── HOW THIS BODY ENDS: `@utils/body_end` OWNS IT ─────────────────────────────────────────────────
// The disk flush a dying process owes lives in a kernel module, not here, since `foreman_link` needs the
// same sequence and cannot reach a function defined inside master_core (Law 16). `endBody` flushes and
// exits; `flushRecord` flushes only, which is what `reportCrash` below wants.

bot.on('end', (reason) => {
  // A disconnect halts the signal loop mid-flight, as serious as a judge-kill, so it is reported through
  // watcher.error, not console alone — the foreman websocket is separate from the game connection, so
  // this still reaches the aggregated trace when the game connection is what dropped.
  require('@kernel/watcher').error('master_core',
    `⛔ Bot disconnected${reason ? ` (${reason})` : ''} — signal loop halted, world connection lost.`);
  console.log(`⚠️ Bot disconnected${reason ? ` (${reason})` : ''}.`);

  // A process that only logs and returns on disconnect keeps every async continuation running with no
  // world connection — a self-feeding cascade, since a dropped bot's idle CPU load helps drop the next
  // one. Exiting lets the launcher restart it; deferred by a beat so the flushes above reach disk first.
  require('@utils/body_end').endBody(`no world connection${reason ? ` (${reason})` : ''}`);
});

// A throw reaching these process handlers is always a coding violation (Law 13): environmental failures
// soft-fail to recursive_judge and never surface as an uncaught throw. Routed through watcher.error so it
// forwards to the foreman and dumps buffered context, keeping a signal death visible (Law 5).
function reportCrash(kind, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  require('@kernel/watcher').error('master_core',
    `⛔ ${kind} — signal died OUTSIDE the judge (coding violation): ${detail}`);
  // Out of the foreman's gate before the flush: this process stays alive and would otherwise keep its place.
  require('@kernel/foreman_link').standDown(`${kind.toLowerCase()} outside the judge`);
  // Flushes without exiting — see `flushRecord`'s header. Registering this handler keeps node alive;
  // whether the process should end is not decided here.
  require('@utils/body_end').flushRecord(`${kind.toLowerCase()} outside the judge`);
}

process.on('uncaughtException', (err)   => reportCrash('Uncaught exception', err));
process.on('unhandledRejection', (reason) => reportCrash('Unhandled rejection', reason));
