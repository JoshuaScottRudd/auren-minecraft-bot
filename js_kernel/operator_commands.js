// js_kernel/operator_commands.js
// The operator verbs — start / stop / flush / wipe and the bench verbs — as ONE implementation
// shared by both invocation surfaces: the per-bot readline console and the
// foreman's broadcast `command` message (Law 16: two transports, one pathway).
// These are the only verbs the operator uses to run a fleet; anything else
// (inject/see/teleport/kill) is a single-bot debug tool and stays local-only.

'use strict';

const watcher = require('@kernel/watcher');
const botMandate = require('@kernel/bot_mandate');

const { OPERATOR_VERBS: VERBS } = require('@foreman/message_schema');   // one vocabulary, three processes (Law 16)
const { guardExternalSync } = require('@utils/external_library_guard');

// Unknown verbs are a coding violation — both surfaces validate against VERBS
// before calling, so an unknown verb here means a caller bug (Law 13: throw).
// `args` is the operator's authored data for verbs that take some (only `move` today). It travels
// the same one pathway as the verb itself (Law 16), and it is the operator's input — never sensed,
// never defaulted (Law 23: the fragment validates it).
//
// `origin` says WHERE the command entered the fleet — the operator's terminal, or a human speaking
// inside the world. It is recorded only; nothing refuses on it.
//
// Not a permission: the operator verbs mean the same thing to both species — `stop` ends a homesteader
// and a contractor alike, and the operator can send it from the console either way. A contractor
// additionally mounts the foreman's ear and the sign desk (capability added, not withheld), so there is
// nothing here to gate. The stamp lets the watcher trace say truthfully where a verb came from (Law 25),
// and gives a future multi-human fleet a seam to tell one human's request from another's.
async function execute(verb, args = {}, origin) {
  botMandate.validateOrigin(verb, origin);   // must SAY where it came from; nothing is refused on it

  switch (verb) {
    case 'start': {
      // Ending sentry mode is part of starting autonomy, not a separate step (Law 4: one occupant).
      // The dispatcher cancels it too, but that only fires once a plan cycle actually reaches it —
      // this closes the window between the start signal and the first dispatch.
      require('@action/await_aggro.js').stop();      // one occupant per scope (Law 4)
      // AWAITED, AND REPORTED FROM THE OUTCOME. The injector carries a placement gate that
      // can refuse — a body must be standing with the person who raised it before it plans — so a line
      // printed beside the call would tell an operator their verb had taken effect when it had not
      // (Law 25). This is the operator's own verb, so the answer belongs to whoever typed it.
      const started = await require('@action/start_injector.js').inject();
      if (started && started.started) watcher.summary('operator_commands', 'start — injected autonomous start signal.');
      else watcher.error('operator_commands', `start — REFUSED, nothing was started: ${(started && started.why) || 'the start injector refused and said nothing'}.`);
      return;
    }
    case 'sentry': {
      // Combat in isolation: arm the WATCH instead of the planning recursion, so the bot waits for a
      // monster to aggro, fights it through the ordinary battleStations gate, and does nothing else.
      // No job board and no dispatcher.
      //
      // The verb keeps the name `sentry` while the fragment is `await_aggro`: the verb is the
      // operator's vocabulary, the fragment name states its one verb (Law 0/7). Renaming the verb would
      // break external usage for no gain.
      //
      // No watcher flush here, unlike start_injector: the arena is often armed on a bot that is already
      // running, and wiping the trace would delete the evidence of how it got here.
      //
      // The bot stays exactly where it is. Positioning it (and re-kitting it after a death, since a
      // death drops the inventory) belongs to the arena director over RCON: where the fight happens is
      // an AUTHORED input to the bench, not a decision the system under test makes (Law 26).
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
      // `master_core` runs with `respawn: false`, so the client never sends the packet on its own: a
      // corpse cannot walk, mine or place, so a death is a hard stop by physics (death_manager's ACT 1
      // header has the reason). The single sender is `death_manager`, a FRAGMENT dispatched by the
      // planning recursion. A bench bot in SENTRY mode has the recursion off, so nothing dispatches
      // death_manager and the body stays a corpse until the world is rolled back. Neither `await_aggro`
      // nor `lanista_ladder` sends the packet, and RCON cannot — the respawn packet is the CLIENT's to
      // send, so no server-side command can stand a corpse up.
      //
      // NOT A SECOND DEATH RECOVERY (Law 16). death_manager does three acts — respawn, teleport to a
      // recovery point, re-kit — and owns death recovery under autonomy. This verb does ACT 1 only and
      // stops: the arena director owns where a bench body stands and what it holds (see the sentry verb
      // above), so teleport and kit here would answer a question that already has one. Both call
      // `bot.respawn()` because that is mineflayer's API.
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
      // told, not retried — it re-asks, and its own ceiling is the judge.
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
      // flush erases every owner's memory and the foreman's shared mirror with it; wipe strikes only the
      // rows stamped with THIS body's owner. The scope is read from this process's own mandate, so the
      // verb cannot address a foreign row because there is no way to spell one (Law 27). See
      // wipe_system.js for why the removal is a tombstone.
      const { wipe } = require('@kernel/wipe_system.js');
      await wipe();
      return;
    }
    case 'surveylayout': {
      // Fires lock_all_buildspots' DRY-RUN base-layout survey at the live fleet WITHOUT starting
      // autonomy: it surveys every blueprint's nearest spot and logs the full "WHY HERE" report to
      // watcher_<BotId>.json (under 'lock_all_buildspots'), LOCKING/BUILDING NOTHING. The pre-flight for
      // site selection, so whenever a new blueprint is added this verb re-surveys the whole layout to
      // confirm each spot still sites and to read WHERE/WHY before committing. Exposed on the
      // operator-command path, not the readline test verb test_locklayout, because a windowed/detached
      // bot has no writable stdin. The survey report is emitted BEFORE the verdict, so a bad/too-strict
      // layout still logs where it would go and why not. Unguarded: run() already REPORTS the
      // environmental verdict in `ok`/`transient`, so catching a throw here would turn a defect into a
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
      // `stop` and `exit` are one command: `exit` named the mechanism (the process leaves), `stop`
      // names what the person wants (the work ends now).
      //
      // No softer interrupt exists. A parked bot is still a bot with a planner, and the only reason a
      // human reaches for an interrupt is that autonomy is doing something they want ended.
      //
      // Deliberate shutdown gets the same care as a crash: drop the magnet so peers don't see a ghost
      // worker, and persist in-memory state (the 2s HQ debounce and watcher buffer would otherwise lose
      // the tail). A throw out of any of these is a defect the operator needs to see, not a hazard of
      // shutting down (Law 13).
      //
      // Goes through the one shutdown path shared with the two death paths (`@utils/body_end`), so a
      // stop and a crash cannot disagree about what a body owes the disk on its way out.
      //
      // The operator's stop drains the record before exiting, without an additional deferred beat.
      // The cause is what the sender said it was, falling back to the verb's own name only when nobody
      // said (a person at a readline IS the cause, and has none to give). `args.why` is set when the
      // FOREMAN ends the fleet — a crash, a lost body, a soak that ran out — so those are attributed to
      // their real cause instead of an operator who typed nothing.
      const stopWhy = typeof args.why === 'string' && args.why ? `fleet stop — ${args.why}` : 'operator stop';
      await require('@utils/body_end').endBody(stopWhy, { immediate: true });
      return;
    }
    default:
      throw new Error(`operator_commands: unknown verb '${verb}'`);
  }
}

module.exports = { execute, VERBS };
