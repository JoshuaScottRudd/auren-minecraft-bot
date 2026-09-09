// js_kernel/operator_commands.js
// The operator verbs — start / stop / flush / wipe and the bench verbs — as ONE implementation
// shared by both invocation surfaces: the per-bot readline console and the
// overseer's broadcast `command` message (Law 16: two transports, one pathway).
// These are the only verbs the operator uses to run a fleet; anything else
// (inject/see/teleport/kill) is a single-bot debug tool and stays local-only.

'use strict';

const watcher = require('@kernel/watcher');
const botMandate = require('@kernel/bot_mandate');

const { OPERATOR_VERBS: VERBS } = require('@overseer/message_schema');   // one vocabulary, three processes (Law 16)
const { guardExternalSync } = require('@utils/external_library_guard');

// Unknown verbs are a coding violation — both surfaces validate against VERBS
// before calling, so an unknown verb here means a caller bug (Law 13: throw).
// `args` is the operator's authored data for verbs that take some (only `move` today). It travels
// the same one pathway as the verb itself rather than a second channel (Law 16), and it is the
// operator's input — never sensed, never defaulted (Law 23: the fragment validates it).
//
// `origin` says WHERE the command entered the fleet — the operator's terminal, or a human speaking
// inside the world. It is RECORDED, never used to refuse anything.
//
// It is not a permission, and an earlier revision of this file wrongly made it one. The operator
// verbs mean the same thing to both species: `stop` ends a homesteader and a contractor alike, and
// the operator must be able to send it from the console either way. What separates the two is that a
// contractor ADDITIONALLY mounts the foreman's ear and the sign desk — capability added, not capability
// withheld — so there is nothing here to gate. The stamp exists so the watcher trace can say
// truthfully where a verb came from (Law 25), and so a future multi-human fleet has a seam to tell
// one human's request from another's.
async function execute(verb, args = {}, origin) {
  botMandate.validateOrigin(verb, origin);   // must SAY where it came from; nothing is refused on it

  switch (verb) {
    case 'start': {
      // Ending sentry mode is part of starting autonomy, not a separate step (Law 4: one occupant).
      // The dispatcher cancels it too, but that only fires once a plan cycle actually reaches it —
      // this closes the window between the start signal and the first dispatch.
      require('@action/await_aggro.js').stop();      // one occupant per scope (Law 4)
      require('@action/start_injector.js').inject();
      watcher.summary('operator_commands', 'start — injected autonomous start signal.');
      return;
    }
    case 'sentry': {
      // Combat in isolation: arm the WATCH instead of the planning recursion, so the bot waits for a
      // monster to aggro, fights it through the ordinary battleStations gate, and does nothing else.
      // No job board and no dispatcher.
      //
      // The verb keeps the name `sentry` while the fragment is now `await_aggro`, deliberately: the
      // verb is the operator's vocabulary, whereas the fragment name has to state its one verb (Law
      // 0/7). Renaming the verb would break external usage for no gain; renaming the fragment is what
      // made the single-fragment shape obvious.
      //
      // Deliberately NOT a start_injector-style watcher flush: the arena is often armed on a bot that
      // has already been running, and wiping the trace would delete the evidence of how it got here.
      //
      // The bot stays exactly where it is. Positioning it (and re-kitting it after a death — a death
      // drops the inventory, so fight two is bare-handed otherwise) belongs to the arena director over
      // RCON: where the fight happens is an AUTHORED input to the bench, never a decision made by the
      // system under test (Law 26 / the playground's governing line).
      const bot = global.bot;
      if (!bot || !bot.entity || !bot.entity.position) {
        watcher.warn('operator_commands', 'sentry — bot not spawned/positioned yet; wait for chunks and retry.');
        return;
      }
      require('@kernel/idle_scheduler').cancel();      // the planning recursion's heartbeat must not co-run (Law 4)
      const at = bot.entity.position.floored();
      require('@action/await_aggro.js').arm();
      watcher.summary('operator_commands',
        `sentry — watch armed at (${at.x},${at.y},${at.z}). It holds one signal until a monster aggros ` +
        `or 'start' stops it; isolated from the planning recursion.`);
      return;
    }
    case 'respawn': {
      // THE BODY COMES BACK, AND THIS IS THE ONLY WAY IN FROM OUTSIDE.
      //
      // WHY IT HAD NO OWNER UNTIL NOW, because the gap is not obvious from any one file: `master_core`
      // runs with `respawn: false`, so the client never sends the packet on its own — that gating is
      // deliberate and load-bearing (death_manager's ACT 1 header has the reason: a corpse cannot walk,
      // mine or place, so a death is a hard stop by physics rather than by a check arriving in time).
      // The single sender is `death_manager`, which is a FRAGMENT dispatched by the planning recursion.
      // A bench bot is in SENTRY mode, where the recursion is off — so nothing dispatches death_manager
      // and the body stays a corpse until the world is rolled back. Neither `await_aggro` nor
      // `lanista_ladder` sends the packet themselves, and RCON cannot — the respawn packet is the
      // CLIENT's to send, so no server-side command can stand a corpse up.
      //
      // NOT A SECOND DEATH RECOVERY (Law 16). death_manager does three acts — respawn, teleport to a
      // recovery point, re-kit — and owns death recovery under autonomy, unchanged. This verb does ACT 1
      // ONLY and stops: the arena director already owns where a bench body stands and what it holds (the
      // sentry verb's own header says so), so teleport and kit here would be a second answer to a
      // question that already has one. Both call `bot.respawn()` because that is mineflayer's API, not a
      // system being reimplemented.
      //
      // A LIVE BOT IS A NO-OP, NOT AN ERROR. A caller running an unconditional "respawn if dead" step
      // cannot know the answer without asking — so asking must be free. The response states which of the
      // two happened, because "already alive" and "stood back up" demand different readings of the run
      // that follows (Law 25).
      const bot = global.bot;
      if (!bot || !bot.entity) {
        watcher.warn('operator_commands', 'respawn — no body to speak for yet (not spawned). Nothing sent.');
        return;
      }
      // `isDead` is not exported anywhere shared, and its whole content is this one flag — mirroring the
      // predicate is cheaper and clearer than reaching into a fragment for it.
      if (bot.entity.health !== undefined && bot.entity.health > 0) {
        watcher.summary('operator_commands', 'respawn — the body is already ALIVE. Nothing sent.');
        return;
      }
      // Environmental: mineflayer refuses the click when the client is mid-transition. The caller is
      // told rather than retried — it re-asks, and its own ceiling is the judge.
      const sent = guardExternalSync('operator_commands', 'respawn click', () => bot.respawn());
      if (!sent.ok) {
        watcher.warn('operator_commands', `respawn — the click was refused (${sent.reason}). The body is still down.`);
        return;
      }
      watcher.summary('operator_commands',
        'respawn — respawn packet SENT to a dead body. Whether it took is read off the SERVER by whoever ' +
        'asked (this process cannot certify its own recovery — Law 26).');
      return;
    }
    case 'move': {
      // Live locomotion test, one leg, no recursion. The operator authors the destination and has
      // already put the body at the start over RCON — where a test walk begins and ends is an AUTHORED
      // input to the bench, never something the system under test decides (same rule the sentry verb
      // states above). All this verb does is hand the coordinate to the injector.
      require('@action/move_injector.js').inject(args.to, { lookahead: args.lookahead, prejump: args.prejump }).catch((e) => {
        watcher.error('operator_commands', `move — injector failed: ${e && e.stack ? e.stack : String(e)}`);
      });
      watcher.summary('operator_commands',
        `move — injected a locomotion test toward (${args.to ? `${args.to.x},${args.to.y},${args.to.z}` : 'MISSING'}), ` +
        `lookahead ${args.lookahead || 1}, prejump ${args.prejump === false ? 'off' : 'on'}.`);
      return;
    }
    case 'flush': {
      const { flush } = require('@kernel/flush_system.js');
      await flush();
      watcher.summary('operator_commands', 'flush — reset corporate HQ to empty (bot is fresh).');
      return;
    }
    case 'wipe': {
      // THE SCOPED TWIN OF flush, AND THE ONLY DESTRUCTIVE VERB A HUMAN IN THE WORLD MAY SAY.
      //
      // flush erases every owner's memory and the overseer's shared mirror with it; wipe strikes only the
      // rows stamped with THIS body's owner. The scope is not an argument and is not checked — it is read
      // from this process's own mandate, so the verb cannot address a foreign row because there is no way
      // to spell one (Law 27). See wipe_system.js for why the removal is a tombstone rather than a delete.
      const { wipe } = require('@kernel/wipe_system.js');
      await wipe();
      return;
    }
    case 'surveylayout': {
      // Fire lock_all_buildspots' DRY-RUN base-layout survey at the live fleet WITHOUT starting
      // autonomy: it surveys every blueprint's nearest spot and logs the full "WHY HERE" report to
      // watcher_<BotId>.json (under 'lock_all_buildspots'), LOCKING/BUILDING NOTHING. This is the
      // pre-flight for site selection — every blueprint must lock in at the start, so whenever a new
      // blueprint is added this verb re-surveys the whole layout to confirm each spot still sites and
      // to read WHERE/WHY before committing. Exposed on the operator-command path (not the readline
      // test verb test_locklayout) because a windowed/detached bot has no writable stdin. The survey
      // report is emitted BEFORE the verdict, so a bad/too-strict layout still logs its "where would
      // this go / why not". Unguarded: run() already REPORTS the environmental verdict in `ok`/`transient`
      // — a throw out of it is the coding-violation path, and catching it here turned a defect into a
      // warn line on the one verb an operator runs to find defects (Law 13).
      const bot = global.bot;
      if (!bot || !bot.entity || !bot.entity.position) {
        watcher.warn('operator_commands', 'surveylayout — bot not spawned/positioned yet; wait for chunks and retry.');
        return;
      }
      const r = await require('@action/lock_all_buildspots').run(bot, { dryRun: true });
      watcher.summary('operator_commands', `surveylayout — dry-run survey done: ok=${r.ok} transient=${!!r.transient}. See the 'lock_all_buildspots' Base-layout survey above for WHERE each spot sited and WHY.`);
      return;
    }
    case 'stop': {
      // RENAMED FROM `exit` 2026-09-01 (Architect: *"stop and exit become one. if you want the bots to
      // stop immediatley you type stop and the bots exit. that is the only way to interrrupt the bots."*).
      // One word, one act — there was only ever one command here, and `exit` named the mechanism (the
      // process leaves) where `stop` names what the person wants (the work ends now).
      //
      // NO SOFTER INTERRUPT EXISTS, AND THAT IS THE RULING RATHER THAN A GAP. A "park" verb was designed
      // and dropped in the same breath that raised it: *"i was thinking of adding parking so you stop the
      // bots and they go back home and wait but the bots are designed to be autonomous. if you intervene
      // with the bots then it should be drastic."* A parked bot is still a bot with a planner, and the
      // only reason a human reaches for an interrupt is that autonomy is doing something they want ended.
      //
      // Deliberate shutdown gets the same care as a crash: drop the magnet so
      // peers don't see a ghost worker, and persist in-memory state (the 2s HQ
      // debounce and watcher buffer would otherwise lose the tail).
      // All three are ours, and a throw out of any of them is a defect the operator needs to see rather
      // than a hazard of shutting down (Law 13). The guards were also self-defeating: a flush that threw
      // left the operator believing the state had been written.
      require('@thinking/dispatcher.js').clearMagnet();
      watcher.flushNow();
      require('@kernel/corporate_headquarters').flushNow();
      process.exit(0);
      return;
    }
    default:
      throw new Error(`operator_commands: unknown verb '${verb}'`);
  }
}

module.exports = { execute, VERBS };
