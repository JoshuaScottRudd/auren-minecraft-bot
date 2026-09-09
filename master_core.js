// master_core.js — Unified Core
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
  '@overseer': __dirname + '/overseer'
});

// THE MANDATE IS READ FIRST — before the banner, before mineflayer, before anything can act.
//
// This is the birth the Architect described: a bot is a species from its first instruction, and a
// process that cannot say which species it is does not become a bot. readMandate() THROWS on an
// absent or unknown BOT_MODE rather than assuming one, so a launcher that forgets to stamp the mode
// dies here — loudly, naming itself — instead of connecting and behaving like the wrong species for
// the rest of the run. Placed at the very top so there is no window in which a half-born bot exists.
const botMandate = require('@kernel/bot_mandate');
const MANDATE = botMandate.readMandate();

const mineflayer = require('mineflayer');
const readline = require('readline');
const { pathfinder } = require('mineflayer-pathfinder');
const { inject: runPerceptionFragmentTester } = require('@perception/perception_fragment_tester.js');
const overseerLink = require('@kernel/overseer_link.js');
// The protocol version is authored in the config, not here: the virtual playground reads the SAME value to
// pull block facts (material, harvestTools) out of the registry, and a bench on a different Minecraft than
// the body would grade this fleet against a game it is not playing (Law 16 — one authored answer).
const { SERVER_MINECRAFT_VERSION, SERVER_ENDPOINT } = require('@thinking/architect_config');


function delayedChat(bot, message, delay = 1) {
  setTimeout(() => {
    bot.chat(message);
    console.log(`💬 Delayed chat: "${message}"`);
  }, delay);
}
global.delayedChat = delayedChat;

// Startup banner (bright cyan, bold) — a bot window's own story is silenced (it streams to the
// overseer), so this banner is nearly all a bot terminal ever prints. It exists purely to make a bot
// window instantly distinguishable from the overseer's live log stream. Cyan, deliberately NOT
// warning-yellow or error-red so those stay meaningful.
//
// The SPECIES is on the banner because the two are indistinguishable at a glance otherwise, and the
// difference decides whether the bot in that window will answer a human at all. A recording session
// that discovers the wrong species by talking to a bot that cannot hear has already lost the take.
(function botBanner() {
  const C = '\x1b[96m\x1b[1m', R = '\x1b[0m';
  const bar = '═'.repeat(50);
  console.log(`${C}${bar}${R}`);
  console.log(`${C}  🤖  BOT WINDOW  ·  ${MANDATE.botId}${R}`);
  console.log(`${C}      ${botMandate.describeMandate()}${R}`);
  console.log(`${C}      logs stream to the OVERSEER terminal — this window`);
  console.log(`${C}      is just to run the bot (type: start | stop | flush | wipe)${R}`);
  console.log(`${C}${bar}${R}`);
})();

console.log('🧐 Launching unified master core...');

// ── RESPAWN IS A COMMAND, NOT A REFLEX ────────────────────────────────────────────────────────────
// `respawn: false` is mineflayer's own switch (lib/plugins/health.js): on death it emits `death` and then
// STOPS — the click is `bot.respawn()`, ours to make. Default true would send it the instant the health
// packet lands.
//
// WHY THE DEFAULT IS WRONG FOR THIS FLEET, and it is a Law 4 problem, not a preference. A death does not
// end the chain that was running: an executor parked in a walk to a tree a thousand blocks away is still
// parked there. Auto-respawn hands that line a LIVE body at the world spawn point, so it resumes intent
// built for a position, an inventory and a body that no longer exist (Invariant B) — while the death
// handler originates a fresh chain beside it. Two live signals, and the bus does not stop it: route()
// refuses only an immediate repeat of the same source→target pair, so there is no live-signal lock to
// catch this. The only thing that ends the old line is Law 15 abandonment, which needs the line to come
// back through the battle_stations gate first.
//
// Gating the respawn makes DEAD the serialization point. A corpse cannot walk, mine or place, so the
// stale line is inert by physics rather than by a check that has to arrive in time — Law 13's
// default-stopped, held by the world instead of by code.
//
// NOTHING IN THIS FILE CLICKS THE BUTTON. The battle_stations gate only CHECKS and routes to the judge;
// job_board's respawn planner then posts the one job a corpse can be given, and respawn_executor sends the
// packet. That fragment is the only place `bot.respawn()` appears in the fleet (Law 16) — and this one
// line is what makes it the only place that CAN matter. Flip `respawn` back to true and mineflayer starts
// clicking underneath all of it, silently, at the one moment the design depends on the body staying down.
const bot = mineflayer.createBot({
  host: SERVER_ENDPOINT.host,
  port: SERVER_ENDPOINT.port,
  username: process.env.BOT_ID || 'AurenBot',
  version: SERVER_MINECRAFT_VERSION,
  respawn: false,
});

bot.loadPlugin(pathfinder);

// ── THE SPAWN-PROTECTED SQUARE IS LATCHED BEFORE LOGIN FINISHES, NOT AT SPAWN ────────────────────
// `spawn_position` is a LOGIN packet: the server sends it while the body is still being brought into
// the world, so it has already come and gone by the time the `spawn` handler below runs. A listener
// registered there would be registered after the only packet it exists to catch, the world spawn would
// read as never-received for the whole session, and every dig and placement would be refused with a
// perfectly accurate message about a state that only the registration order created.
//
// Here, immediately after createBot and before anything can await, is the first moment a listener can
// exist at all — and it is the last moment before the packet can arrive.
//
// WHY THE FLEET LATCHES THIS ITSELF INSTEAD OF READING mineflayer's `bot.spawnPoint`: that field is
// initialised to (0,0,0) and overwritten when the packet lands, so a read before it arrives returns a
// well-formed falsehood — and worlds this fleet generates spawn at x=0,z=0, the one value that would
// make the gap invisible. The full argument lives on the module (Law 13, Law 26).
require('@perception/spawn_protection').armSpawnProtection(bot);

// ── A CORPSE CANNOT ANNOUNCE ITSELF ───────────────────────────────────────────────────────────────
// A body that died and was stopped is saved to playerdata dead, and on the next login mineflayer's
// health plugin consumes its one-shot spawn gate WITHOUT firing it — the gate only emits `spawn` for a
// living body. So every handler below hangs off an event that never arrives: the process joins the
// world, holds a socket, and never registers, never perceives, never takes a command. It looks like a
// hung bot and it is a bot waiting for an event that cannot come.
//
// THE CLICK MUST LAND ON `health`, NOT ON `spawn` OR ON `start`. `spawn` is the event this repairs, so
// hanging the repair there is circular; `start` is an operator verb that arrives through machinery this
// same registration installs, so nothing is listening for it yet. `health` is the first packet the
// server sends about the body either way, which makes it the only edge that fires for a corpse.
//
// Clicking respawn makes the server send a fresh body, and the health plugin's OTHER branch emits
// `spawn` for it — so this hands off to the normal path rather than duplicating it. Nothing here
// teleports: where a revived body belongs is already decided downstream (a contractor is carried to its
// owner by report_to_owner, a homesteader stays where vanilla put it), and deciding it twice would be
// two routes to one destination (Law 16).
//
// Gated on `global.bot` being unset, which is what makes this the LOGIN edge specifically: after the
// spawn handler runs, a death is the death signal's to own, and a second reviver racing it would be two
// occupants of one decision (Law 4).
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

  // STATE THE SQUARE ONCE PER RUN, whatever it says. A gate that only speaks when it refuses something
  // is indistinguishable from a gate that is dead, and this one refuses work — so a run needs the line
  // that says which ground was off-limits in order to read a "nothing to mine" as a keep-out rather
  // than as an empty world (Law 6). It also reports the not-known case at the one moment it is still
  // actionable: by spawn the login packets are all in, so an unknown world spawn here means every dig
  // and placement this session will be refused, and that is worth seeing at the top of the trace
  // instead of inferring it from a hundred refusals further down.
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

  // ── BOUNDARY TRANSLATOR: mineflayer's explosion handler crashes the process on 1.21.5 ──────────────
  // Law 16's one legal catch — a third-party fault converted into a Law 13 outcome at the seam, logged,
  // never silently swallowed. This is not a workaround for our code; it is upstream reading a field it
  // just proved absent.
  //
  // mineflayer/lib/plugins/physics.js:298-300 does:
  //     if (explosion.playerKnockback) {                     // the 1.21.3+ shape
  //       bot.entity.velocity.add(explosion.playerMotionX, …) // …then reads the PRE-1.21.3 fields
  //     }
  // On 1.21.3+ the per-axis playerMotion* fields no longer exist — playerKnockback replaced them — so
  // those are three `undefined`s into Vec3.add, which does `undefined.x` and throws INSIDE the packet
  // emitter. There is no call site of ours to wrap: it fires on a server packet, so the throw lands in
  // process.on('uncaughtException') and kills the bot.
  //
  // Every creeper detonation costs the PROCESS, not just the health, which makes any detonation-driven
  // counter unmeasurable: a counter whose failure mode deletes the instrument cannot be characterised.
  //
  // THE FIX REWRITES THE PACKET, IT DOES NOT REPLACE THE HANDLER. A prepended listener normalises the
  // 1.21.3+ shape into the pre-1.21.3 shape upstream's SECOND branch already handles correctly:
  // playerKnockback is spread into playerMotionX/Y/Z and then DELETED, so the broken branch is skipped
  // by its own guard. Knockback is still applied, by upstream, from the numbers the server actually sent.
  //
  // TWO WRONG TURNS, BOTH TAKEN, both recorded so a successor spends its round elsewhere:
  //   1. Installed beside bot.loadPlugin() — mineflayer had not injected physics yet, so there was
  //      nothing to find and the guard returned silently. Moving it to spawn was necessary, not enough.
  //   2. Then it removed `listeners('explosion')[0]` and installed a corrected copy. blocks.js:395
  //      registers an explosion listener BEFORE physics.js:295, so index 0 is BLOCKS — the crash was
  //      untouched and explosion block-updates were silently disabled instead. Never index a third-party
  //      listener array by position; there is no contract on the order.
  // Repairing the fields WITHOUT deleting playerKnockback is a third wrong turn: the broken branch would
  // then run `velocity.add(number, …)`, and Vec3.add reads `.x` off its argument — NaN velocity, silent.
  //
  // Prepending is also why this needs no "did I find it" guard at all: the translation is unconditional
  // and depends on no upstream listener existing, so there is no silent-decline path to warn about.
  // Delete this the day upstream fixes it.
  //
  // ─── AND IT MUST CATCH THE FALSEHOOD, NOT ONLY THE GARBLE (Law 26) ───
  // Stopping the throw is only half a translator. An extreme-but-finite velocity value (no throw,
  // Number.isFinite passes) can still stall prismarine-physics's swept-AABB scan (getSurroundingBBs ←
  // moveEntity), which walks the box a block at a time — a large enough sweep never returns, keep-alives
  // stop, and the server eventually kicks the bot while the match keeps reporting normally in the
  // meantime. Nothing throws; every value stays finite.
  //
  // That is the exact failure Law 26 names: a well-formed falsehood crossing into a machine that
  // faithfully acted on it. A form check (Number.isFinite) cannot see it — only a check against
  // physical reality can, so the bound below is the truth-catch this boundary was missing. The cap is
  // ~2.5× terminal velocity (3.92 b/tick), which is far above any real blast and far below anything
  // that can stall a swept-AABB scan. On a reject the knockback is DROPPED WHOLE rather than clamped:
  // a clamped vector is an invented physics event, and there is no honest number to substitute here.
  // The raw vector is logged because it is also the open question — whether the server sends f64 where
  // minecraft-data's 1.21.5 schema declares `["option","vec3f"]` is unverified, and these numbers are
  // the evidence that would settle it.
  const EXPLOSION_KNOCKBACK_MAX_BPT = 10;
  bot._client.prependListener('explosion', (explosion) => {
    try {
      const kb = explosion.playerKnockback;
      if (!kb) return;
      delete explosion.playerKnockback;      // FIRST — a return below must still leave the branch disarmed
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
    } catch (e) {
      // Reported, never swallowed (Law 16). Losing blast knockback is survivable; losing the process
      // is not, and the bot's own health/death handling is what should decide the outcome.
      try {
        require('@kernel/watcher').warn('master_core',
          `explosion translator threw (${e.message}) — knockback not applied, bot alive.`);
      } catch (_) {}
    }
  });

  // NO SPAWN GREETING. `👋 Hello players, I just spawned!` was said here by every body on every spawn —
  // two lines of open chat for a crew of two, plus two more from announceStartupPosition, before either
  // bot had done a thing. It told the world something the world could see. A person's crew is announced
  // once, by the foreman, in the reply to the `get` that asked for it (Law 16: one arrival, one voice).
  // See THE BOT DOES NOT SPEAK in Thinking_fragments/dispatcher.js.

  // A CONTRACTOR ARRIVES WHERE ITS OWNER IS STANDING. Fired here rather than posted as a job because
  // birth happens once and the process is its own lifecycle (Law 8); a job would re-post every time the
  // two bodies drifted apart and heel the bot to its owner forever. It is deliberately not awaited — the
  // seats below are process-lifetime listeners with no dependency on where the body is, and holding the
  // spawn handler on an RCON round-trip would delay every one of them for a teleport that is allowed to
  // fail. See report_to_owner for why the owner's exact cell needs no safety scan.
  require('@action/report_to_owner.js').announce(bot);

  const survivalInstincts = require('@locomotion/survival_instincts');
  survivalInstincts.start(bot);

  // ── THE CREW'S TWO TICK SEATS, IN THE ORDER THEY MUST RUN ────────────────────────────────────────
  // The COMMANDER first, and unconditionally. It is the fleet's only scanner of monsters, and it sweeps
  // whether or not a fight is open — deliberately with no engage switch, because a gunner that could be
  // starved by a commander waiting for an engagement would lose the one thing a tick-level upper body is
  // for: hitting the mob that wandered up mid-job instead of either ignoring it or abandoning the job.
  require('@api/commander').start(bot);

  // The gunner ATTACHES for the process and ENGAGES per wave, and the split is deliberate: attaching and
  // detaching a physicsTick listener at every engagement boundary is a lifecycle with an obvious leak
  // (Law 8), so the handler goes up once here beside the other tick-level reflexes and battle_stations
  // flips one boolean. Silent and inert until something arms it — the tick returns on its first line.
  //
  // REGISTERED AFTER THE COMMANDER, AND THAT ORDER IS LOAD-BEARING. mineflayer fires physicsTick handlers
  // in registration order, so the gunner reads a board the commander wrote THIS tick rather than one tick
  // stale. Two lines in one file is what makes the order visible and reviewable; two modules each
  // attaching their own listener wherever they happened to be required would leave the order to whichever
  // `require` ran first, which is exactly the hidden state Invariant C forbids.
  require('@api/gunner').start(bot);

  // THE DRIVER IS THIRD, AND THIS IS THE LAST LINK IN THE SAME CHAIN. The rotation is
  // commander → gunner → driver, and each seat consumes what the one before it wrote THIS tick: the
  // gunner reads the commander's board, and the driver reads BOTH the board and `bot.entity.yaw` — the
  // facing the gunner just wrote. Registered last so the keys it presses are computed against the
  // facing the body actually holds this tick, not the one it held last tick.
  //
  // A successor moving these three lines is not reordering log statements. Put the driver first and it
  // strafes relative to a facing one tick stale, which at a sprinting mob's 0.28 b/tick is a heading
  // error that looks exactly like a pathing bug.
  require('@api/driver').start(bot);

  // The death edge. Installed here beside the other process-lifetime listeners because that is what it
  // is (Law 8), but the DECISION it feeds lives at the battle_stations gate — see armDeathWatch's header
  // for why an edge-triggered latch and a health poll are not the same instrument.
  require('@api/battle_stations').armDeathWatch(bot);

  // WHAT USED TO BE THE SECOND LISTENER ON THIS EDGE, and why nothing replaced it: death_pile_recorder
  // captured where a body's things fell, because the retrieval system worked off a RECORD of the death.
  // Salvage now works off a live scan of the entity table (perception/ground_drop_scanner), so there is
  // nothing to capture at the moment of dying — the drops announce themselves for as long as they exist,
  // and a record of them could only outlive them. Deleted with the whole death-pile chain.

  // Connect to overseer if URL is configured (env var OVERSEER_URL).
  // If not set, the bot runs in local-brain mode — no change to behavior.
  const overseerUrl = process.env.OVERSEER_URL || null;
  const botId = process.env.BOT_ID || bot.username || 'AurenBot';

  // A BOOTING BOT HOLDS NOTHING — say so before registering (Law 8: a lifecycle terminates with the
  // owner that raised it). The magnet is written to disk, so a claim made by the PREVIOUS process
  // under this same id is read back as gospel by the new one and by every peer that merges the chair.
  // The exit paths already clear it ('end' handler, reportCrash), but a hard kill runs neither — and
  // that is the normal case, because relaunching the fleet kills the bots outright.
  //
  // releaseAbsentBotMagnets does NOT cover this: it is keyed on the holder being absent from the
  // overseer's roster, and a relaunched bot re-registers under the same id, so it is present and its
  // own ghost claim is skipped by both the connected-check and the self-check. Absent-holder and
  // reborn-holder are two different failures; that one owns the first, this owns the second.
  // Not a second release pathway (Law 16) — same clearMagnet(), a boundary it did not reach.
  try { require('@thinking/dispatcher.js').clearMagnet(botId); } catch (_) {}

  overseerLink.connect(overseerUrl, botId);
  overseerLink.startBodyCellPublisher(bot);

  // Startup only: after peer chairs have had a moment to arrive over the overseer, announce
  // our spawn position and the distance to the nearest other bot (if one is connected).
  setTimeout(() => overseerLink.recordStartupPosition(bot), 4000);

  // ── A CONTRACTOR IS BORN STARTED (Architect 2026-09-01) ──────────────────────────────────────────
  // *"getting the bots also starts them. theres no reason why they should be seperate commands."*
  //
  // A CONSTITUTION, NOT A SEQUENCE, and that is why it is here rather than in the foreman (Law 27). The
  // obvious build was to have the desk launch the crew, WAIT for both bodies to register, then send
  // `start` through the door — which needs a poll, a ceiling, a judge for the wait, and an honest report
  // for the case where the wait expires. All of that machinery exists only to police a gap between two
  // acts. Defining a contractor as a body that is already working closes the gap instead: there is no
  // un-started contractor to wait for because none can be constructed.
  //
  // A HOMESTEADER IS UNTOUCHED and still waits for the operator's `start`. The two species differ by what
  // a contractor ADDS (this file's own doctrine): a homesteader is started when the operator decides the
  // fleet is ready, whereas a contractor exists BECAUSE a person asked for one — being fetched is what
  // starting means for it, and there is no moment in its life when standing idle is the right state.
  //
  // AFTER THE SEATS AND THE OVERSEER LINK, deliberately. The planning recursion reads the job board and
  // claims through the overseer, so injecting before `connect` would run the first plan cycle against a
  // bot with no peer arbitration — every claim granted locally, which is exactly the split-brain the
  // planning token exists to prevent (Law 4).
  if (botMandate.isContractor()) {
    require('@action/start_injector.js').inject();
    console.log('🚀 Contractor — born started. Autonomous start signal injected.');
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
        // test_locklayout [lock] — drive the startup base-layout batch directly (no autonomous loop).
        // Default is a DRY RUN: survey the anchor (wheat farm) + all satellites, report each satellite's
        // closeness to the anchor, write nothing. Pass `lock` to actually lock them. The full survey
        // lands on watcher_<BotId>.json under 'lock_all_buildspots'.
        const dryRun = !args.includes('lock');
        require('@action/lock_all_buildspots').run(global.bot, { dryRun })
          .then(r => console.log(`🧪 lock_all_buildspots ${dryRun ? '(dry run)' : ''}: ok=${r.ok} transient=${!!r.transient} locked=[${(r.locked || []).join(', ')}]`))
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
        try {
          runPerceptionFragmentTester(args[1]);
        } catch (e) {
          console.error('❌ see command failed:', e.message);
        }
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

bot.on('end', (reason) => {
  // Emit a LOUD error first: a disconnect halts the signal loop mid-flight (any in-progress
  // fragment just stops), which is exactly as serious as a judge-kill and must be as visible.
  // The overseer websocket is separate from the Minecraft connection, so this still forwards to
  // the aggregated trace even when the game connection is what dropped — no more silent death
  // where the last navigator loop appears to run forever with no ❌ (the 'Timed out' case).
  try {
    require('@kernel/watcher').error('master_core',
      `⛔ Bot disconnected${reason ? ` (${reason})` : ''} — signal loop halted, world connection lost.`);
  } catch (_) { console.error('❌ Bot disconnected:', reason); }
  console.log(`⚠️ Bot disconnected${reason ? ` (${reason})` : ''}.`);
  try { require('@thinking/dispatcher.js').clearMagnet(); } catch (_) {}
  try { require('@kernel/watcher').flushNow(); } catch (_) {}
  try { require('@kernel/corporate_headquarters').flushNow(); } catch (_) {}

  // ── AND THEN IT ENDS. MEASURED 2026-09-03, and this is the most expensive bug found on the public
  // server so far (architect_bugsquashing.md round 225).
  //
  // Before this, `end` logged, flushed, and RETURNED — leaving the process alive with no world
  // connection. "Signal loop halted" was true of the loop and false of the process: every in-flight
  // async continuation kept running, and a disconnected bot was measured burning **33-82% of a CPU
  // core, indefinitely, doing nothing**. Ten bots were dropped from an eleven-bot fleet and the nine
  // corpses were consuming more of the machine than the nine living bots ever had.
  //
  // THAT IS A CASCADE, not an inconvenience. Bots are dropped because the box is too busy for them to
  // answer a keep-alive within 30s. A dropped bot that keeps burning a core makes the box BUSIER, which
  // drops the next one, which burns another core. The failure is self-feeding, and no amount of pacing
  // the STARTS can win against it — which is exactly what the first-movement scheduler proved when it
  // paced perfectly and still lost ten of eleven.
  //
  // It also closes a second gap (round 223 §5): `bot-start` refuses a bot whose process is alive, so a
  // disconnected bot could not be relaunched without finding and killing its pid by hand. A bot that
  // exits is a bot the launcher can simply start again.
  //
  // Exit is DEFERRED by a beat so the flushes above actually reach disk - they are the record of how the
  // bot died, and losing them to a faster exit would trade one invisible failure for another.
  setTimeout(() => {
    console.log('⚠️ No world connection — this body is finished. Exiting so it stops costing the machine.');
    process.exit(0);
  }, 2000).unref();
});

// A throw that reaches these process handlers is ALWAYS a coding violation (Law 13):
// environmental failures soft-fail to recursive_judge and never surface as an uncaught
// throw. This is the ONLY way a signal ends outside a judge — so it must be as LOUD as a
// judge-kill. The old handlers logged via console.error (raw local stderr), which the
// watcher does NOT forward to the overseer — so in the aggregated fleet trace the signal
// just vanished (only the magnet-clear summary showed) and the bot sat idle looking alive.
// Route through watcher.error instead: it forwards to the overseer AND dumps the buffered
// context, so a signal death is always visible and inspectable (Law 5, Law 13).
function reportCrash(kind, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  try {
    require('@kernel/watcher').error('master_core',
      `⛔ ${kind} — signal died OUTSIDE the judge (coding violation): ${detail}`);
  } catch (_) { console.error(`❌ ${kind}:`, err); }
  try { require('@thinking/dispatcher.js').clearMagnet(); } catch (_) {}
  try { require('@kernel/watcher').flushNow(); } catch (_) {}
  try { require('@kernel/corporate_headquarters').flushNow(); } catch (_) {}
}

process.on('uncaughtException', (err)   => reportCrash('Uncaught exception', err));
process.on('unhandledRejection', (reason) => reportCrash('Unhandled rejection', reason));
