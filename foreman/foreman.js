'use strict';
// foreman.js — THE IN-GAME DESK. A human in the world says "foreman get bots" and a crew arrives.
//
// RENAMED FROM `valet` 2026-08-30. The first name was chosen when the job was fetching and dismissing:
// *"call it valet, its less ambigious, its job is to get a bot, stop a bot and etc."* The scope outgrew
// it — this desk now starts, stops, flushes and takes work orders — and the Architect renamed it for the
// reason the first name was picked, which is that the name should say what the thing does. His original
// sentence is kept verbatim above because it is his and the record does not rewrite it (Law 20); what
// changed is the job it was describing, not the sentence.
//
// It still does not plan, does not judge, and does not decide what a bot should do once it exists.
//
// IT IS NOT A BOT, and the distinction is structural rather than cosmetic. It holds a player slot and
// it has a body, but it has no BOT_ID, no mandate, no corporate_headquarters, no job board and no
// place in BOT_SENIORITY — the roster is bots, and the foreman is staff. It is the fourth process type
// in the fleet after the server, the overseer and the bots.
//
// EVERY BOT IT GETS IS A CONTRACTOR, by construction rather than by rule: there is no other way to
// spawn one, and the foreman passes `--mode=contractor` on the single launcher that exists. Homesteaders
// come from the terminal. The Architect's model is the one this file is built on —
//
//   "there should be no anti logic. meaning guarding against a homesteader to be a contractor.
//    contractor is an overrided homesteader. thats the main difference between the two."
//
// — so nothing here checks that a homesteader is not secretly a contractor. A contractor is the same
// program with the human channels mounted on top, and the mode decides how much of it mounts. The
// foreman's own listing shows both species because a human standing in the world should be able to see
// what is out there; it simply does not offer to command the ones that were never fetched for them.
//
// WHY IT SPAWNS `start_bot.js` RATHER THAN REQUIRING master_core ITSELF: `start_bot.js` is the ONE birth
// in this tree (Law 16) — it stamps the mandate, and every other caller including the Architect's own
// `fleet_control` goes through it. A second spawn path here would be a second place a bot can be born
// wrong. See `startBot()` below for what that inherited and what it did not.
//
// Run:  node start_contractor_bots.js        (raises the overseer and this desk together)

const path = require('path');
const { spawn } = require('child_process');

const moduleAlias = require('module-alias');
const BOT_DIR = path.resolve(__dirname, '..');
// HAND-REGISTERED AND DELIBERATELY SHORT. The foreman is not a bot and must not become one by accident:
// every alias added here is a layer of the fleet this process can suddenly reach into, and the clerk's
// whole scope is fetching and dismissing. These are the four it genuinely needs — the Architect's
// tables, the shared envelope contract, the mandate vocabulary, and the boundary guard the door uses.
// Values match package.json's `_moduleAliases` exactly; a second spelling of one of these paths is a
// second answer to where a layer lives (Law 16).
moduleAlias.addAliases({
  '@thinking': path.join(BOT_DIR, 'Thinking_fragments'),
  '@kernel':   path.join(BOT_DIR, 'js_kernel'),
  '@utils':    path.join(BOT_DIR, 'js_kernel', 'utils'),
  '@overseer': path.join(BOT_DIR, 'overseer'),
  // The event grammar the desk's record is written in. Added with the record itself: the alternative
  // was a second grammar spelled here, which is the drift crew_log's one-file design exists to stop.
  '@api':      path.join(BOT_DIR, 'custom_api'),
});

// ── THE DESK KEEPS A RECORD, AND IT IS THE FLEET'S OWN WRITER ────────────────────────────────────
// NAMING THE UNIT IS WHAT OPENS THE FILE, and it must precede the watcher require because the watcher
// resolves its filename once, at load. This is the CAMERA's arrangement exactly (`BOT_ID=camera_rig`):
// a non-bot process that needs its own parallel record names itself and inherits the whole discipline —
// the append-only writer, the index that only advances on a reported success, the sync flush at exit,
// and fleet_control's run-start sweep of `watcher_*.jsonl`, which is why the name has this shape.
//
// IT DOES NOT MAKE THE DESK A BOT. BOT_ID names a RECORD here, not a mandate: this process still has no
// mandate, no headquarters and no job board, and the overseer forward is a no-op because the desk never
// connects `overseer_link` — so the desk's record cannot leak into the fleet's merged stream (Law 26 —
// the camera's record is parallel for the same reason, and the reader keeps them apart by filename).
process.env.BOT_ID = process.env.BOT_ID || 'foreman';
const record = require('./foreman_record');

// ── WHERE THE THIRD-PARTY PACKAGES LIVE IS ASKED, NEVER ASSUMED ──────────────────────────────────
// The desk used to inherit a working `NODE_PATH` because `fleet_control` stamped one before spawning it,
// so the require below resolved without this line and nothing revealed the dependency. `foreman.js` is
// now started by `start_contractor_bots.js` as well, which stamps no path — and the first live run under
// that launcher died here with `Cannot find module 'mineflayer'`, having brought the overseer up first
// so the failure looked like a foreman fault rather than a resolution one.
//
// It is the same call `start_bot.js` makes for the same reason, and on a published copy it is a no-op:
// `npm install` puts the packages in `node_modules` beside this tree and Node finds them unaided. It
// matters on the Architect's machines, where they sit in a sibling directory — which is exactly the case
// a launcher-inherited path was quietly covering (Law 2 — a unit completes its own verb and leaves
// nothing to be arranged for it).
require('@utils/node_module_homes').bootstrapModulePath();

const mineflayer = require('mineflayer');
const { FOREMAN_NAME, FOREMAN_PREFIX, FOREMAN_CHANNEL, BOT_SENIORITY,
        SERVER_ENDPOINT, SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');
const channel = require('./foreman_channel');
// THE ONE TELEPORT, in its address-a-person form. The desk brings a new crew to whoever hired it, and it
// reaches for the fleet's existing implementation rather than opening its own rcon session — a second
// `tp` spelled here would be the second route Law 16 exists to prevent, and it is the kind that only
// diverges once somebody fixes a bug in one of them.
const recovery = require('@kernel/body_recovery');

// HOW LONG A CREW GETS TO APPEAR IN THE OVERSEER'S REGISTRY after its processes are launched. Matched to
// `fleet_control.waitForBotsOnline`'s own 90s rather than picked, because it is the same wait for the same
// thing — a cold JVM, a chunk load and a spawn — and two different answers to one question is the drift
// Law 16 exists to prevent. Measured on the local server: a warm box registers a crew in a few seconds,
// so this is the ceiling, not the cost.
const CREW_ARRIVAL_WAIT_MS = 90000;
const CREW_ARRIVAL_POLL_MS = 2000;
// PER BODY, NOT PER CREW. The wait above is the budget for the whole crew and it is spent one member at
// a time (see the launch loop), so a member that is never coming must not be able to eat the budget the
// next one needs. Half the total, so the worst case is unchanged from the single deadline it replaced.
const BODY_ARRIVAL_WAIT_MS = CREW_ARRIVAL_WAIT_MS / 2;
// ── THE GAP BETWEEN TWO LOGINS FROM ONE MACHINE ──────────────────────────────────────────────────────
// A SERVER MAY RATE-LIMIT LOGINS PER SOURCE ADDRESS, AND THE WHOLE FLEET IS ONE SOURCE ADDRESS. Two
// contractors launched back to back reach the door about a second apart from the same IP, and a server
// that throttles logins drops the second one — before it is authenticated, so before anything logs a
// reason. From the bot's side it is `socketClosed` at zero seconds and from the desk's side it is a crew
// that half arrived.
//
// MEASURED 2026-09-05, and it is the reason `get` behaves differently on the two worlds. On the dedicated
// server AurenBot connected and TessaBot's socket closed 0.9s later with no entry of any kind in the
// proxy's log — a connection refused before it was worth logging. On the local server there is nothing in
// front of the world, so the same two launches both land and the fault is invisible.
//
// THE FLEET DOES NOT KNOW WHAT IS IN FRONT OF IT AND MUST NOT LEARN. This constant is not a proxy setting
// copied over — it is the fleet's own statement that connecting politely is its job, true against a bare
// world, a proxy, or whatever comes next. The real spacing usually comes free, because the loop waits for
// each body to register before launching the next; this is the FLOOR that still applies when a body fails
// instantly and there is nothing to wait for.
const CREW_LAUNCH_GAP_MS = 5000;

// ── SAYING `wipe` TWICE IS WHAT MAKES IT A DECISION (Architect 2026-09-05) ───────────────────────────
// *"make them have to type foreman wipe twice. first time says a warning. second time does the wipe. do
// not be verbouse with the warning."*
//
// IT IS THE ONE IRREVERSIBLE WORD A PLAYER HAS. Every other in-game verb is undoable by saying another
// one — `stop` is answered by `get`, a request is answered by `cancel`. A wipe destroys the only durable
// record of where that person's base is, and nothing in the world can reconstruct it. A confirmation is
// the whole safety mechanism, so it is the only place the desk deliberately refuses a well-formed order.
//
// THE WINDOW EXPIRES, and that is the safety rather than a convenience. A pending confirmation that
// lasted forever would mean a `wipe` said and forgotten an hour ago is armed when the word is typed
// again for an unrelated reason — the confirmation would then be protecting nothing while appearing to.
// One minute is long enough to read a line and answer it and short enough that the arming is a fact
// about this moment (Law 13: the safe side of a stale claim is the one that does not act).
const WIPE_CONFIRM_MS = 60000;
// player -> the moment their armed wipe stops counting. Keyed per person because the desk serves
// everyone at once, and one player's confirmation must never arm another's word.
const wipeArmed = new Map();
// ── THE VEIL, RECORDED AT THE CROSSING ITSELF ───────────────────────────────────────────────────
// Wrapped ONCE here rather than reported at each of the call sites below, and the reason is the reason
// `correct()` is one function: a record kept by call sites is a record that a new call site silently
// omits itself from, and the omission looks exactly like nothing having crossed (Law 16).
//
// `send` and `request` ARE the crossings — the two roads a person's word takes into the fleet, and both
// carry the asker, so both events can say whose session they belong to. `query` is deliberately NOT
// recorded: it is the desk reading the roster to answer its own gate, not something crossing on
// anybody's instruction, and it fires on every `get` and `list`. Recording a read the desk makes for
// itself would put the desk's housekeeping into a person's transcript (Invariant D — the record is
// grouped by whose session it is, and that read belongs to no one's).
const _door = require('./overseer_door');
const door = {
  query: (...a) => _door.query(...a),
  doorPort: (...a) => _door.doorPort(...a),
  async send(verb, args, asker, ...rest) {
    record.relayed(asker, 'command', verb, args && args.bot ? args.bot : null);
    const r = await _door.send(verb, args, asker, ...rest);
    // THE FLEET'S OWN VERDICT, NOT THE SENTENCE THE PERSON HEARD. That sentence is recorded separately
    // by `said`, and keeping the two apart is what lets a reader watch the desk translate — a report
    // that only held the rendering could not show a true verdict rendered wrongly (Law 25).
    record.fleet_said(asker, r.ok && r.sent > 0, r.ok ? (r.reason || `sent=${r.sent}`) : r.error);
    return r;
  },
  async request(action, args, asker, ...rest) {
    const detail = args && args.item ? `${args.quantity == null ? '' : args.quantity + ' '}${args.item}` : null;
    record.relayed(asker, 'request', action, detail);
    const r = await _door.request(action, args, asker, ...rest);
    record.fleet_said(asker, !!r.ok, r.ok ? (r.reason || null) : (r.reason || r.error));
    return r;
  },
};

// The desk reaches the world through the SAME endpoint every body uses (Law 16). It previously carried
// its own FOREMAN_HOST/PORT/VERSION env trio — a second route to one setting, and its version literal had
// already drifted into a hand-copied '1.21.5' that nothing kept in step with the fleet's.
const HOST = SERVER_ENDPOINT.host;
const PORT = SERVER_ENDPOINT.port;
const VERSION = SERVER_MINECRAFT_VERSION;

const ROSTER = Object.keys(BOT_SENIORITY).sort((a, b) => BOT_SENIORITY[a] - BOT_SENIORITY[b]);

// ONE CALL, TWO DESTINATIONS, AND THAT IS A LOGGER RATHER THAN TWO PATHWAYS (Law 16). The console half
// is the desk's live window — the one a person watches while standing in the world, and the one the
// probe reads — and it is written explicitly because naming the unit above silences the watcher's own
// echo (a named unit normally has the overseer carrying its lines, and this one does not). The record
// half is what outlives the window. Same sentence, one emitter, two places it lands.
function log(msg) {
  console.log(`[${new Date().toISOString()}] [FOREMAN] ${msg}`);
  record.note(msg);
}

(function banner() {
  const C = '\x1b[95m\x1b[1m', R = '\x1b[0m';
  const bar = '═'.repeat(56);
  console.log(`${C}${bar}${R}`);
  console.log(`${C}  🛎️   FOREMAN  ·  ${FOREMAN_NAME}${R}`);
  console.log(`${C}      the in-game desk — gets a crew, commands it, takes orders${R}`);
  console.log(`${C}      channel: ${FOREMAN_CHANNEL}   ·   say "${FOREMAN_PREFIX} help" in game${R}`);
  console.log(`${C}      every bot it gets is a CONTRACTOR${R}`);
  console.log(`${C}${bar}${R}`);
})();

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fetching a body — through start_bot.js, the one birth
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Launches ONE contractor body and hands back what happened.
//
// ── IT SPAWNS `start_bot.js`, WHICH IS THE TREE'S ONE BIRTH (Law 16) ─────────────────────────────────
// It used to spawn `fleet_control.js`, and that had been BROKEN since the workshop carve (commit
// 4296854) moved the file to `Auren_Workshop/` without repointing this line — the path resolved under
// `Auren_Bot/`, where no such file exists, so every `get` reached a human as "could not run
// fleet_control". The carve is also why pointing it back would be wrong rather than merely awkward:
// `fleet_control` is the Architect's own equipment and does not ship, so a desk that needs it is a desk
// that only works on his machine. `start_bot.js` is the file the whole split was built around — it
// stamps the mandate, it is what `fleet_control` itself spawns, and it exists in every copy.
//
// ── WHAT MOVED HERE WITH IT, AND WHAT DID NOT ────────────────────────────────────────────────────────
// `fleet_control.botStart` owned three things this file deliberately does not re-derive: the roster
// ceiling, the already-running check, and a visible console window per process. The first two are
// answered upstream — the caller picks from bots the overseer reports FREE, so a name that is already
// working is never passed here. The third is workshop behaviour: it exists because his fleet is twenty
// windows he watches, and a published copy has one terminal that everything streams into.
//
// ── IT RESOLVES ON LAUNCH, NOT ON EXIT, AND THAT IS THE REAL CHANGE ──────────────────────────────────
// `bot-start` was a command that returned; `start_bot.js` REQUIRES master_core in its own process, so it
// does not return until the bot dies. Awaiting `close` here would hang the desk for the life of the bot.
// Resolving on launch is also more honest: a launcher returning was never evidence a body stood up, and
// the caller already polls the overseer's registry for the arrival, which is the world's fact rather than
// the launcher's (Law 26). An exit inside the grace window is the one thing that IS evidence — of
// failure — so it is reported with whatever the child managed to say.
const BOT_LAUNCH_GRACE_MS = 3000;

// Bodies this desk fetched, so they leave when it does (Law 8 — whatever raised a process terminates it).
// Without this, Ctrl-C on the desk leaves a crew running under roster names nothing can hand out again.
const fetched = [];

function startBot(botId, owner) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BOT_DIR, 'start_bot.js')], {
      cwd: BOT_DIR,
      // The mandate, stamped as environment because that is the path `start_bot.js` documents for a
      // non-human caller: an absent flag falls back to the variable it would have set, so this passes
      // through whole. BOT_ID is overridden explicitly — this process carries `foreman` in it for its
      // own record, and inheriting that would file the bot's log under the desk.
      env: { ...process.env, BOT_ID: botId, BOT_MODE: 'contractor', BOT_OWNER: owner },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fetched.push(child);

    let out = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('error', e => finish({ code: -1, out: `could not start ${botId}: ${e.message}` }));
    child.on('exit', code => finish({
      code,
      out: out.trim() || `${botId}: stopped immediately (exit ${code}) — nothing was said about why`,
    }));
    setTimeout(() => finish({ code: 0, out: `${botId}: launched` }), BOT_LAUNCH_GRACE_MS);
  });
}

// Ends every body this desk fetched. Registered for the ordinary exits and for Ctrl-C, because a desk
// killed at the keyboard is the common case rather than the exotic one.
function releaseFetched() {
  for (const child of fetched) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
process.on('exit', releaseFetched);
process.on('SIGINT', () => { releaseFetched(); process.exit(0); });
process.on('SIGTERM', () => { releaseFetched(); process.exit(0); });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The vocabulary
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// TWO KINDS OF WORD, AND THEY TAKE DIFFERENT ROADS FOR A REASON THAT IS NOT INCIDENTAL.
//
//   get / list / help — the CLERK's own words. `get` starts an OS process by spawning `start_bot.js`,
//           the one birth; the FREE-bot list read off the live fleet is what keeps it off a busy name
//           (Law 16). Nothing about a process launch is an operator verb.
//   every OPERATOR VERB — travels the in-game door instead. Sent through fleet_control they would be
//           stamped TERMINAL, because fleet_control's socket IS the operator's console, and a human in
//           the world would then be commanding homesteaders with console authority. Same words,
//           different road, and the road decides who hears them.
//
// THE VOCABULARY LIVES IN ITS OWN FILE, because the guarantee attached to it has to RUN. This file
// creates its mineflayer client at module scope, so the load sweep cannot open it — a Law 13 throw
// written here would fire for the first time in front of a human. See foreman_vocabulary.js.
const { INGAME_VERBS, CREW_SIZE, helpLines, parseRequest, parseCancel,
  pluralForms, describeAge, describeProgress, describeCrew } = require('./foreman_vocabulary');

// ── THERE IS NO FUZZY MATCHER, AND THERE MUST NOT BE ONE (Architect 2026-08-30) ─────────────────────
// "i dont like it. lets take fuzzy matcher out… i would rather a list of legal items to be given to the
//  human to chose from and its up to them to spell things right… we will list every legal command
//  instead of fuzzy accepting or guessing what the player wants."
//
// One was built and removed the same day. It resolved misspellings by edit distance, folded species into
// families, and announced every reading it made. Recording why it went, because it worked and a
// successor will otherwise rebuild it: THE DESK'S JOB IS NOT TO WORK OUT WHAT SOMEBODY MEANT. Guessing
// puts a reading between the person and the fleet that only the person can check, so every guess needs a
// confirmation step, and a desk full of confirmation steps is worse than one that simply says what the
// legal words are. The list is the answer to the problem the matcher was solving: publish the whole legal
// vocabulary, let the person pick from it, and refuse anything that is not in it (Law 13 — never default
// a field; the exact-name lookup below cannot produce a wrong item because it cannot produce any item
// that was not typed).
//
// PLURAL IS THE ONE FORGIVENESS, and it is not fuzzy: `logs`/`log` are tried as EXACT lookups against the
// catalogue and the first that is a real token wins. No scoring, no distance, no candidate ranking — a
// word either is a legal name or it is not, and being wrong about a plural is impossible rather than
// unlikely.
const { isRequestable, isBlueprint } = require('@kernel/requestable_catalogue');

// THE THIRD OUTCOME AT THE HUMAN BOUNDARY. Law 13 throws at a coding violation and soft-fails an
// environmental one; a person typing the wrong thing is neither, so it CORRECTS — nothing crosses, nothing
// crashes, and the reply says what would have worked. The doctrine and every named refusal live in that
// file; this one only decides which applies. See correction.js's header for why the boundary needs its
// own form at all (Law 26 — the desk is the translator machine between a generator and a machine).
const correction = require('./correction');

// resolveExact(spoken) → the legal token, or null. Literal first, then the plural/singular forms of the
// same word. Every candidate is checked against the catalogue itself, so nothing that is not already a
// legal name can come out of here.
function resolveExact(spoken) {
  for (const candidate of [spoken, ...pluralForms(spoken)]) {
    if (candidate && isRequestable(candidate).ok) return candidate;
  }
  return null;
}

// knownName(spoken) → the spelling the fleet recognises, or null. Membership only.
//
// SEPARATE FROM resolveExact BECAUSE THEY ANSWER DIFFERENT QUESTIONS, and welding them produced a wrong
// refusal. resolveExact asks "can the crew get this"; this asks "is this a word the fleet has an opinion
// about at all". `string` fails the first and passes the second — it is a real thing with no route to it —
// while `logdsf` fails both. One refusal for both told the person who spelled string perfectly that their
// spelling was wrong (Law 25 — the verdict has to be true about the question they asked).
//
// NOT A MATCHER. This is a set lookup over names the fleet already holds, with the same plural forms tried
// as further exact lookups. No distance, no ranking, no nearest-neighbour: a word is in the set or it is
// not, so this cannot substitute one item for another.
function knownName(spoken) {
  const { group_to_item } = require('@utils/fragment_utils');
  const catalogue = require('@kernel/requestable_catalogue');
  const known = new Set([
    ...catalogue.requestableItems(),
    ...Object.keys(group_to_item),
    ...catalogue.unreachableLeaves(),
    ...catalogue.unclassifiedLeaves(),
  ]);
  for (const candidate of [spoken, ...pluralForms(spoken)]) if (candidate && known.has(candidate)) return candidate;
  return null;
}

// groupMembers(token) → the family's members, or null if the token names one thing.
// The group table is the assessors' own, so "is this a family" is asked of the same fact the crew will
// resolve against rather than of a second list kept here (Law 16).
function groupMembers(token) {
  const { group_to_item } = require('@utils/fragment_utils');
  const members = group_to_item[token];
  return Array.isArray(members) && members.length ? members : null;
}

// raisableStructures() → the buildings a person may ask for, read from the Architect's whitelist.
//
// A READ, NOT A DERIVATION, and the difference is the whole point. Which structures can be raised ALONE is
// a fact about how they attach to each other — a mineshaft joins a headframe in a specific way — and no
// table in this tree records relations between structures, so it is authored in architect_config as
// REQUESTABLE_STRUCTURES. Deriving it from the requirement ladders was tried and is wrong in a way worth
// keeping: a ladder is NECESSARY to raise a structure and not SUFFICIENT to offer one, so an attached
// structure that eventually gets its own rows would silently start being promised standalone.
//
// THE DESK HOLDS NO GATE OF ITS OWN ANY MORE. A check stood here for one round, refusing structures the
// catalogue had offered — a referee between two lists that disagreed. With the whitelist authored, the
// catalogue's own definition of "requestable" excludes them, so an unoffered structure never resolves and
// the conflict cannot form (Law 27: where a constitution is available the referee was a symptom, and the
// repair belongs in the definition). This function survives only to SPEAK the list — the desk still has to
// tell a person which buildings exist when refusing one that does not.
function raisableStructures() {
  return [...require('@thinking/architect_config').REQUESTABLE_STRUCTURES].sort();
}

// (`legalFamilies()` stood here and is DELETED with the `list` verb that was its only caller, 2026-09-06.
// It computed the family tokens — `logs`, `sword`, `pillar_block` — that the goods list did not already
// name. Nothing reads them now: `resolveExact` accepts a family word without needing it enumerated.)

async function handle(from, text, reply) {
  const parts = text.split(/\s+/).filter(Boolean);
  const verb = (parts[0] || 'help').toLowerCase();
  const arg = parts[1];
  record.read_as(from, verb);

  // correct(c) — speak a correction and let nothing cross. The ONE way a refusal reaches a person, so a
  // refusal that skipped the doctrine is visible as a bare `reply(...)` at a call site rather than hiding
  // as a differently-worded sentence among the correct ones (Law 16 — one pathway).
  //
  // It also LOGS, because a person being refused repeatedly is the signal that the desk is failing to
  // guide, and that fact exists nowhere else: the fleet's trace never sees these — the whole point is
  // that they do not cross (Law 6 — the reasoning has to be recoverable by whoever depends on it, and
  // for this boundary that is whoever is reading the desk's window).
  const correct = (c) => {
    // EVERY refusal, at the one place refusals reach a person — so the record cannot miss one by a
    // call site forgetting to report it, for the same reason this function exists at all (Law 16).
    record.refused(from, c.code, c.said);
    log(`correction[${c.code}] to ${from}: ${c.said ? `'${c.said}' — ` : ''}${c.because}`);
    for (const line of correction.render(c)) reply(line);
  };

  // ── trouble(who, code, forThePerson, forTheLog) — THE DESK'S OWN FAULTS, AND WHERE THEY GO ────────
  //
  // THE RULING (Architect 2026-09-05): *"foreman should never spam chat with its problems."*
  //
  // WHY A THIRD FUNCTION RATHER THAN A CAREFULLY WORDED `reply`. This desk answers in OPEN chat, so every
  // sentence it says is said to everybody in the world at once. There are three kinds of thing it can
  // say and only two of them were ever built: an ANSWER (`reply` — the thing the person asked for), a
  // CORRECTION (`correct` — their word was wrong and here is the one that works), and this: the desk's
  // own machinery failed, which is neither. With nowhere for it to go it went out as an answer, so a
  // socket error, a launcher's exit line and an overseer port number were all broadcast to the server —
  // every one of them addressed to a maintainer who was not there, in front of players who could do
  // nothing with them and had not asked (Law 24: the audience decides the register; Invariant D: a
  // failure has one owner and it is not the bystander reading it).
  //
  // THE SPLIT IS THE WHOLE POINT. `forThePerson` is one plain sentence: what they have now and what to
  // say next — never a cause, never an error string, never a component name. `forTheLog` is the machine
  // half in full, and it goes to the desk's window and its record, which is where somebody diagnosing
  // this will actually look (Law 6 — the reasoning stays recoverable; it just stops being recovered by
  // the wrong reader). Nothing is suppressed and nothing is softened; the two halves are simply posted
  // to the two audiences that exist.
  //
  // IT IS NOT A CORRECTION AND MUST NOT BORROW ONE. A correction says the person's input was wrong; this
  // says the desk was. Sending these through `correct()` would teach somebody to change a word that was
  // never the problem, which is worse than saying nothing (Law 13's third category is for a generator's
  // malformed input, and a broken socket is not that).
  // `log` already writes through to the record, so the machine half reaches both destinations from one
  // call — the same reason `correct()` does not post its own copy.
  const trouble = (who, code, forThePerson, forTheLog) => {
    log(`trouble[${code}] serving ${who}: ${forTheLog}`);
    reply(forThePerson);
  };

  if (verb === 'help' || verb === '') {
    // ONE MESSAGE PER VERB rather than one packed block. The channel paces and wraps whatever it is
    // handed, so this is no longer about fitting — it is about a person finding the verb they want in
    // a wall of chat, which is the only reason the help exists.
    for (const line of helpLines()) reply(line);
    return;
  }

  if (verb === 'get') {
    // ONE `get` HANDS OUT A CREW, NOT A BOT, AND THE SIZE IS NOT NEGOTIABLE.
    //
    // The Architect's reasoning is a definition rather than a preference, which is why nothing here
    // offers a choice: bots are built to SHARE — tasks, resources, a house — and the smallest number
    // that can share anything is two. One bot cannot demonstrate the property the fleet exists to show;
    // three would be two plus a spare, and the spare proves nothing the pair does not. So CREW_SIZE is
    // what a person gets, and there is no argument that changes it (Law 16: one crew size, one door).
    //
    // NO BOT NAME IS ACCEPTED, and its absence is the ruling rather than a simplification. A human
    // cannot command an individual — every verb reaches all of the speaker's bots and nothing else —
    // so a name on `get` would let somebody choose a body they can never address, which is an
    // instruction the rest of the system has no way to honour.
    //
    // THE COUNT IS ASKED OF THE FLEET, NEVER TALLIED HERE. A counter kept in this process would be
    // wrong the first time the operator stopped one from the console and every time the foreman
    // restarted (Invariant B — re-sense, never remember).
    const state = await door.query();
    if (!state.ok) {
      trouble(from, 'fleet_unreachable', "can't check what you have right now — try again in a moment.",
              `door.query failed on get: ${state.error}`);
      return;
    }
    // ── A CREW IS TOPPED UP TO ITS SIZE, NOT REFUSED FOR BEING NON-EMPTY (fixed 2026-09-05) ────────
    // This gate read `mine.length > 0`, which made a HALF CREW a dead end: the only door out was `stop`,
    // which drops the bot you did have to get back the pair you were owed. That is the failing case the
    // crew-size ruling exists to prevent, reachable through the one verb meant to prevent it — and it is
    // exactly the state a launch failure leaves a person in, which is how it was found (he asked, one
    // bot came, and there was no word he could say to get the second).
    //
    // `>= CREW_SIZE` MAKES THE CONSTITUTION SELF-HEALING rather than merely declared (Law 27). The size is
    // still not negotiable and there is still no request that produces a third — `get` now means *bring me
    // up to a crew*, which is the same sentence for somebody with none and the repair for somebody with
    // one. Nothing new is offered: the only reachable outcomes remain 0 and CREW_SIZE.
    const mine = state.bots.filter(b => b.owner === from);
    if (mine.length >= CREW_SIZE) {
      correct(correction.crewFull(`${FOREMAN_PREFIX} get`, mine.map(b => b.id), CREW_SIZE));
      return;
    }
    const needed = CREW_SIZE - mine.length;

    // A NAME IS NOT INVENTED. The roster is the ceiling — "there can only be as many bots as there
    // are names" — so a short house is reported as a short house rather than answered with a bot that
    // does not exist (Law 13). Names go out in seniority order, eldest free first.
    //
    // A PARTIAL CREW IS REFUSED WHOLE, and this is the one place that decision is made: half a crew is
    // not a small crew, it is a bot that cannot do the thing a crew is for. Nothing is launched unless
    // the whole crew can be (Law 13, default-stopped — and Law 25: the shortfall is named, not filled).
    // COUNTED AGAINST WHAT IS STILL NEEDED, not against the whole crew size — otherwise somebody holding
    // one bot is told the house is full while a free name is standing right there.
    const free = ROSTER.filter(id => !state.bots.some(b => b.id === id));
    if (free.length < needed) {
      // THE ROSTER IS NOT PASTED. This line used to name all 22 bots — a wall in a window drawn over the
      // world, listing bodies the reader cannot ask for by name anyway (no verb takes one). Two numbers
      // say everything they can act on: how many are free, and how many a crew needs (Law 24).
      reply(`only ${free.length} of ${ROSTER.length} bots free and a crew is ${CREW_SIZE} — somebody has to let theirs go first.`);
      return;
    }
    const crew = free.slice(0, needed);

    reply(needed === CREW_SIZE
      ? `getting ${crew.join(' and ')} for you...`
      : `you have ${mine.map(b => b.id).join(' and ')} — getting ${crew.join(' and ')} to finish the crew...`);
    // THE OWNER IS STAMPED AT EACH LAUNCH, which is what makes it un-forgeable later: it becomes an
    // environment fact of that process, the bot declares it on register, and no message anywhere can
    // change whose it is. Launched in sequence rather than together because two concurrent launches
    // would race the FREE-bot list this crew was chosen from.
    // ── ONE BODY AT A TIME: LAUNCH IT, WAIT FOR IT TO STAND, BRING IT OVER, THEN THE NEXT ──────────
    // (Architect 2026-09-05, on the dedicated server: *"foreman only spawns one bot and doesent teleport
    // it to the player. it works when i do the local server but not on the dedicated."*)
    //
    // THE OLD SHAPE WAS THREE PHASES — launch them all, then wait for the crew, then teleport the crew —
    // and it produced both halves of that report at once.
    //
    // THE MISSING BOT. Both launches returned within a second of each other, so both bodies knocked on
    // the door within a second of each other from the same address. A world with a login rate limit in
    // front of it drops the second knock before authentication, so nothing anywhere logs a refusal: the
    // proxy has no entry for the bot at all and the bot records `socketClosed` at zero seconds. Waiting
    // for each body to REGISTER before launching the next spaces the knocks by however long a real join
    // takes, and `CREW_LAUNCH_GAP_MS` is the floor for when a body fails so fast there is nothing to wait
    // for. Sequencing on the launcher's RETURN was never sequencing at all — that is Law 26's line again:
    // the launcher returning is its own fact; a body registering is the world's.
    //
    // THE MISSING TELEPORT, and it is the same phase boundary from the other side. The teleport used to
    // run after the wait for the WHOLE crew, so one body arriving and one never coming meant the person
    // watched an unmoved bot for the full 90-second budget before anything was brought to them. He said
    // `stop` at 31 seconds, which is the correct response to a system that appears to be doing nothing —
    // and that killed the one body he had, so the pass that finally ran found zero and told him none of
    // his crew arrived. Every one of those sentences was true and the sequence they described was a lie
    // (Law 25). A body is now brought over the moment it stands, so a short crew is a person holding one
    // working bot beside them, not a person holding nothing.
    //
    // STILL NO RETRY. The desk reports the shortfall and does not relaunch: it cannot know a failure was
    // transient, and a silent retry turns a diagnosable fault into an intermittent one.
    const said = [];
    const standing = [];
    const stranded = [];
    let reach = null;                       // the last fleet error, when the registry could not be read
    for (let i = 0; i < crew.length; i++) {
      const target = crew[i];
      if (i > 0) await new Promise(r => setTimeout(r, CREW_LAUNCH_GAP_MS));
      const r = await startBot(target, from);
      said.push(firstMeaningfulLine(r.out) || `${target}: the launcher exited ${r.code}`);

      // POLLED, NEVER SLEPT-THEN-CHECKED: a body that registers in four seconds is brought over in four
      // seconds, and a fixed wait would make the fast case cost as much as the worst one.
      const deadline = Date.now() + BODY_ARRIVAL_WAIT_MS;
      let seen = false;
      for (;;) {
        const state2 = await door.query();
        if (!state2.ok) { reach = state2.error; break; }
        reach = null;
        if (state2.bots.some(b => b.id === target && b.owner === from)) { seen = true; break; }
        if (Date.now() >= deadline) break;
        await new Promise(r2 => setTimeout(r2, CREW_ARRIVAL_POLL_MS));
      }
      if (!seen) { log(`${target} did not register within ${BODY_ARRIVAL_WAIT_MS}ms for ${from}`); continue; }
      standing.push(target);

      // A contractor connects at the world spawn point, which is specifically not next to whoever hired
      // it — so a body that spawned perfectly two hundred blocks away has, from the only viewpoint that
      // matters, not arrived. Issued only after the registry confirms the body, because a `tp` aimed at a
      // client still connecting is dropped by the server in silence. A failed teleport does not fail the
      // `get`: the bot is theirs and working either way, so it is reported rather than treated as absence.
      const tp = await recovery.teleportToPlayer(target, from);
      if (!tp.sent) { stranded.push(target); log(`tp ${target} -> ${from} failed: ${tp.error}`); }
    }
    log(`get crew ${crew.join(', ')} for ${from} -> ${said.join(' | ')}`
        + ` | stood: ${standing.join(', ') || 'none'}`);

    // ── WHAT ARRIVED IS ASKED OF THE FLEET, NEVER QUOTED FROM THE LAUNCHER ─────────────────────────
    // A launcher says whether it STARTED a process; the overseer's registry says whether a body is
    // STANDING IN THE WORLD. Those are different facts and they diverge exactly when something has gone
    // wrong, so grading `get` on the launcher's own output is a component reporting on itself (Law 26).
    // `tools/foreman_probe.js` has always graded this on the server's player list for that reason; the
    // loop above is the live desk holding the same standard.
    //
    // THE REGISTRY UNREACHABLE IS A THIRD ANSWER, not a failure. The desk then genuinely does not know
    // what arrived, and saying that is the truthful verdict (Law 25) — a launcher line quoted in its place
    // would describe a world nobody checked.
    if (reach && standing.length === 0) {
      trouble(from, 'crew_unconfirmed', `I started ${crew.join(' and ')} but can't confirm they arrived.`,
              `door.query failed: ${reach} | launcher said: ${said.join(' | ')}`);
      return;
    }

    if (standing.length >= CREW_SIZE) {
      reply(stranded.length
        ? `${standing.join(' and ')} are yours and working — but I could not bring ${stranded.join(' and ')} to you. say "${FOREMAN_PREFIX} where" to find them.`
        : `${standing.join(' and ')} are yours, here, and working.`);
      return;
    }
    // THE SHORT CASE SAYS WHAT THEY HAVE AND WHAT TO DO — AND NOT ONE WORD OF MACHINE DETAIL.
    // It used to end by pasting `fleet_control`'s own output into open chat, one line per failed launch,
    // in front of everybody on the server. That is the desk's diagnostics wearing a player's reply, and
    // it is unreadable to the person it was aimed at and noise to everybody else (Law 24 — the audience
    // decides the register; a launcher line is machine-to-machine correspondence). The detail is not
    // lost: `trouble` puts it in the desk's own log and record, which is where a fault belongs.
    record.refused(from, 'crew_short', `${standing.length} of ${CREW_SIZE}`);
    const missing = crew.filter(id => !standing.includes(id));
    trouble(from, 'crew_short',
      standing.length
        ? `${standing.join(' and ')} is yours and working. ${missing.join(' and ')} didn't make it — say "${FOREMAN_PREFIX} get" to try for the rest.`
        : `couldn't get your crew up. say "${FOREMAN_PREFIX} get" to try again.`,
      `${standing.length} of ${CREW_SIZE} stood; missing ${missing.join(', ')}; launcher said: ${said.join(' | ')}`);
    return;
  }

  // ── WHERE: THE ASKER'S OWN BODIES, AND WHAT EACH IS DOING ───────────────────────────────────────
  // REPLACED `list` (Architect 2026-09-01). The roster listing answered "who is standing out here, and
  // whose" — which a person can also answer by looking around — while the thing they have no way to see
  // is where their own bots went and what work they are on. `list` is now the catalogue.
  //
  // IT IS SCOPED TO THE ASKER, and that is the difference from the listing it replaced. The old one
  // reported the whole fleet deliberately ("what is standing in the world with them"); this reports work
  // in progress, which is a fact about a crew and belongs to whoever that crew answers to.
  //
  // NOTHING IS SENSED FOR IT AND NOTHING IS COMPUTED ABOUT THE WORK (Law 3). Every field was already
  // travelling: the body's own `body_cell`, published on a timer into its boardroom chair, and the
  // dispatcher's `magnet` — the task-identity marker written when a job is claimed. The only things this
  // desk computes are the distance and the bearing, and only because they are the facts neither the bot
  // nor the overseer can know: they are relations between a body and a person, and the person is standing
  // in front of THIS process.
  //
  // IT IS ALSO THE ONLY WAY A CONTRACTOR'S WORK REACHES A HUMAN AT ALL, since 2026-09-06 — the bodies no
  // longer narrate. The reasoning, and what was deleted to get here, is in describeCrew.
  if (verb === 'where') {
    const state = await door.query();
    if (!state.ok) {
      trouble(from, 'fleet_unreachable', "can't reach your bots right now — try again in a moment.",
              `door.query failed on where: ${state.error}`);
      return;
    }
    const mine = state.bots.filter(b => b.owner === from);
    if (mine.length === 0) { correct(correction.noBotsOut(`${FOREMAN_PREFIX} where`)); return; }

    // THE SPEAKER'S POSITION IS READ, NEVER ASSUMED. The channel is open chat, which is server-wide, so
    // a person may say this from anywhere on the map — and mineflayer only carries an entity for a player
    // whose entity is actually loaded near this body. An absent one is passed through as null and
    // describeCrew falls back to coordinates, rather than measuring against a position the desk does
    // not have (Law 25 — an invented figure is the failure; the absence is not).
    const speaker = bot.players?.[from]?.entity?.position || null;
    const speakerPos = speaker ? { x: Math.floor(speaker.x), y: Math.floor(speaker.y), z: Math.floor(speaker.z) } : null;

    // ONE reply for the crew, never one per body — see describeCrew for why the channel's one-line-per-
    // second pacing makes a per-bot answer arrive in two places over two seconds.
    reply(describeCrew(mine, speakerPos));
    log(`where for ${from} -> ${mine.map(b => b.id).join(', ')}${speakerPos ? '' : ' (speaker not in view — no bearing)'}`);
    return;
  }

  // ── REQUEST: THE ONE VERB THAT IS NOT A COMMAND ─────────────────────────────────────────────────
  // Everything below this point tells bodies to DO something. This writes a fact down and tells nobody:
  // the crews find it when they next measure their own needs, exactly as they find a shortfall they
  // noticed themselves. That is why it takes its own door and not an operator verb.
  //
  // Gathering, crafting and building are one word here on purpose. Which of the three a thing needs is
  // a fact about the item, computable, and already computed — asking a person to classify it invites the
  // one mistake nothing downstream can catch, because "gather torch" is a perfectly well-formed sentence
  // meaning something impossible.
  if (verb === 'request') {
    const parsed = parseRequest(parts);
    if (parsed.kind === 'status') {
      const r = await door.request('status', {}, from);
      if (!r.ok) {
        trouble(from, 'fleet_unreachable', "can't read your list right now — try again in a moment.",
                `door.request status failed: ${r.error || r.reason}`);
        return;
      }
      const rows = Array.isArray(r.rows) ? r.rows : [];
      if (rows.length === 0) { reply(`you haven't asked for anything. try "${FOREMAN_PREFIX} request 20 logs".`); return; }
      reply(`you have asked for ${rows.length} thing(s):`);
      // THE PROGRESS FIGURE IS RELAYED, NEVER COMPUTED HERE. The desk holds no owner key and cannot tell
      // which chests belong to this crew, so every number below was measured inside a body by the same
      // lens its own supply assessor stands down on. A figure invented at this distance would be a
      // confident lie about work in progress (Law 25) — which is why this line said nothing at all until
      // the crews began reporting it.
      const progress = (r.progress && typeof r.progress === 'object') ? r.progress : {};
      for (const row of rows) {
        // A STRUCTURE IS READ BACK WITHOUT ITS QUANTITY, for the same reason it cannot be asked for with
        // one. The ledger stores 1 because rows carry quantities; printing it here would show a person the
        // number the desk refuses to take from them, and a desk that says "a building isn't a quantity" and
        // then reads back "1 headframe" has taught two rules for one thing.
        const named = isBlueprint(row.item) ? row.item : `${row.quantity} ${row.item}`;
        reply(`  ${named} — asked ${describeAge(row.first_asked_at)}${describeProgress(progress[row.item])}`);
      }
      return;
    }
    // ══ THE VEIL ══════════════════════════════════════════════════════════════════════════════════
    // EVERY GATE BELOW EITHER PASSES A TYPED VALUE OR CORRECTS, and nothing reaches `door.request` until
    // all of them have. That ordering is the doctrine's guard half: a malformed sentence stopped here
    // costs one reply, and the same sentence admitted becomes a row in a ledger, a job on a board and a
    // crew walking somewhere for a reason nobody can reconstruct (Law 26 — the desk is the translator
    // machine, and a translator that passes what it could not read is not one).
    //
    // The gates run cheapest-first and each answers ONE question, so the correction a person gets names
    // the single thing that was wrong rather than the first thing a combined check happened to notice.

    // GATE 1 — the shape of the sentence. Three different mistakes, three different corrections; they
    // used to be one usage line, so a person who reversed the word order and a person who typed a
    // fraction were told the same thing and only one of them was being helped.
    if (parsed.kind === 'reversed') {
      correct(correction.wrongFormat(`${FOREMAN_PREFIX} request ${parsed.item.replace(/_/g, ' ')} ${parsed.quantity}`,
        `"${FOREMAN_PREFIX} request ${parsed.quantity} ${parsed.item.replace(/_/g, ' ')}" — the number comes first, then the thing.`));
      return;
    }
    if (parsed.kind === 'bad_quantity') {
      correct(correction.wrongFormat(parsed.said,
        `"${FOREMAN_PREFIX} request 20 logs" — a whole number above zero, then the thing.`));
      return;
    }
    if (parsed.kind === 'no_item') {
      correct(correction.wrongFormat(`${FOREMAN_PREFIX} request`,
        `"${FOREMAN_PREFIX} request 20 logs" — a number, then what you want.`));
      return;
    }

    // GATE 2 — the name. An exact lookup with the plural forms tried as further exact lookups; nothing
    // here can substitute one item for another, so nothing it accepts needs a reading confirmed.
    const item = resolveExact(parsed.item);
    if (item === null) {
      // THREE DIFFERENT REFUSALS, KEPT APART, because one answer for all three is wrong for two of the
      // people who meet it (Law 13's third category — the correction states the TRUE cause, and Law 25 —
      // the verdict has to be true about the question they actually asked):
      //   · `spawn_box` is a real structure, spelled correctly, that cannot be raised on its own yet.
      //   · `string` is a real material the fleet has no route to.
      //   · `logdsf` is not a word.
      // The structure is asked FIRST because it is the only one of the three whose name IS right — telling
      // that person to check their spelling sends them looking in the one place the fault is not.
      if (isBlueprint(parsed.item)) {
        correct(correction.noPlanForThat(parsed.item, raisableStructures()));
        return;
      }
      const known = knownName(parsed.item);
      if (known === null) {
        correct(correction.notOnTheList(parsed.item));
        return;
      }
      // ONE VERDICT, READ ONCE. It was called inline for `blockedBy` alone; a species refusal carries
      // `askInstead` and NO `blockedBy`, so the old line would have told a person their crew "needs
      // undefined". The two refusals are different facts and are kept apart here rather than by making
      // one message cover both (Law 25).
      const verdict = isRequestable(known);
      correct(verdict.askInstead
        ? correction.askByFamily(parsed.item, verdict.askInstead)
        : correction.cannotObtain(parsed.item, verdict.blockedBy));
      return;
    }

    // GATE 3 — a building is not a countable thing (Architect 2026-08-30: "requesting buildings dont have
    // a number anymore. i dont want someone to accidentally request 10 headframes. it makes one building").
    // Both directions are corrected, because a person who has just learned the building form applies it to
    // a material next and deserves the same specific answer back.
    const building = isBlueprint(item);
    if (building && parsed.quantity !== null) {
      correct(correction.buildingTakesNoNumber(`${parsed.quantity} ${parsed.item.replace(/_/g, ' ')}`, item));
      return;
    }
    if (!building && parsed.quantity === null) {
      correct(correction.goodNeedsANumber(parsed.item, item));
      return;
    }

    // (A gate stood here refusing structures with no requirement ladder. It is DELETED, not moved: the
    // catalogue's definition of "requestable" now excludes an unoffered structure, so nothing that reaches
    // this line can fail that check. Law 27 — the referee was a symptom of two lists disagreeing, and the
    // repair was in the definition. The refusal it used to speak now fires at Gate 2, where the name fails
    // to resolve, which is also where the person finds out sooner.)

    // GATE 4 — the same building twice while the first is still going up. ASKED OF THE FLEET, not
    // remembered here: the desk keeps no tally of what it has filed, because that tally would be wrong
    // the first time the person cancels from another session and every time the desk restarts
    // (Invariant B). The ledger is the live fact and the crew's own stage is what says whether it is done.
    if (building) {
      const standing = await door.request('status', {}, from);
      if (standing.ok) {
        const already = (standing.rows || []).some(row => row.item === item);
        const stage = ((standing.progress || {})[item] || {}).stage || 'not started';
        if (already && stage !== 'built') {
          correct(correction.alreadyUnderway(parsed.item, item, stage));
          return;
        }
      }
    }

    // A BUILDING IS FILED AS ONE. The ledger's row shape carries a quantity because most rows are
    // materials; a structure's is always 1 and the read-back reports a STAGE rather than a count, so the
    // number is a storage detail the person is never shown and never has to say (Law 0 — the desk owns
    // the vocabulary, the ledger owns the row).
    const r = await door.request('post', { item, quantity: building ? 1 : parsed.quantity }, from);
    if (!r.ok) {
      if (r.reason === 'not_requestable') {
        correct(correction.cannotObtain(parsed.item, r.blockedBy));
      } else {
        // NOT A CORRECTION — the person did nothing wrong. A fleet that did not answer is the fleet's
        // fault and is reported as one, because telling somebody to rephrase a sentence that was fine
        // would be a false verdict about whose problem it is (Law 25).
        trouble(from, 'request_refused', "couldn't file that one — try again in a moment.",
                `door.request refused: ${r.reason || r.error}`);
      }
      return;
    }
    const note = r.replaced !== null && r.replaced !== undefined
      ? ` (was ${r.replaced} — a request is a target, not a tally, so this replaces it)` : '';
    // A FAMILY IS NOT ONE THING, and a person asking for one is owed that before they wonder why birch
    // arrived. The crew picks by abundance rather than by preference (set_wood_preference counts trunks
    // once and every later scan SORTS by the winner without filtering), so this sentence is the honest
    // description of what the assessors do rather than a caveat.
    const family = groupMembers(r.item)
      ? ` ${r.item} is a family, not one block — your crew takes whichever of them is most abundant around here.` : '';
    // A BUILDING IS CONFIRMED WITHOUT ITS NUMBER. The ledger stores 1 because rows carry quantities, and
    // echoing that back would teach the number this desk just refused to take — a person told "a building
    // isn't a quantity" and then told "right, 1 headframe" has been given two rules for one thing.
    reply(building
      ? `right — your crew will raise the ${r.item}. it goes up once, and "${FOREMAN_PREFIX} request" tells you how far along it is.`
      : `right — ${r.quantity} ${r.item}${note}. your crew will pick it up on its next pass.${family}`);
    return;
  }

  if (verb === 'cancel') {
    const parsed = parseCancel(parts);
    if (parsed === null) {
      reply(`name what to drop: "${FOREMAN_PREFIX} cancel logs" or "${FOREMAN_PREFIX} cancel all".`);
      return;
    }
    // CANCEL TAKES THE SAME PLURAL FORGIVENESS AND NOTHING MORE. `all` passes through untouched — it is
    // the one word here that names no item. An unrecognised word is NOT refused with a spelling lecture:
    // the ledger answers "nothing of yours matched", which is the true answer to withdrawing something
    // never asked for, and the person may simply be wrong about what they have outstanding rather than
    // about how it is spelled (Law 25 — the verdict has to be true about the question asked).
    const target = parsed.item === 'all' ? 'all' : (resolveExact(parsed.item) || parsed.item);
    const r = await door.request('cancel', { item: target }, from);
    if (!r.ok) {
      trouble(from, 'fleet_unreachable', "couldn't cancel that right now — try again in a moment.",
              `door.request cancel failed: ${r.error || r.reason}`);
      return;
    }
    reply(r.removed === 0
      ? `nothing of yours matched '${target}'.`
      : `dropped ${r.removed} request(s).`);
    return;
  }

  // `list` — the catalogue. It was `can i get` until 2026-09-01, which spent three words and a
  // question's grammar on a phrase nobody would guess; the roster listing that held this word moved to
  // `where`, which answers the question a person actually cannot see the answer to. The catalogue is computed
  // from what the fleet can actually reach, so this answer is never a list somebody forgot to update.
  // ── THE LIST IS THE ANSWER TO SPELLING (Architect 2026-08-30) ────────────────────────────────────
  // "i would rather a list of legal items to be given to the human to chose from and its up to them to
  //  spell things right. we could remind them to ensure correct spelling."
  //
  // This verb replaces the guessing that used to happen at the request. It has to be COMPLETE to do that
  // job: a list that omits names the desk accepts sends a person who read it carefully to a refusal, and
  // they have no way to know the list was the incomplete thing rather than their spelling. So the
  // families are listed alongside the goods — `logs` and `sword` are legal words a person may say, and
  // before this they were accepted while being absent from the only place that says what is accepted.
  //
  // Both halves are COMPUTED, never kept: the goods from the fleet's own walk of its recipe graph, the
  // families from the group table the assessors themselves resolve against. A capability gained tomorrow
  // is offerable tomorrow, with nothing edited here.
  // ── COMPLETENESS CUTS BOTH WAYS, and the second direction is the one that was wrong ──────────────
  // A list omitting a word the desk accepts strands the person who read it; a list NAMING a word the desk
  // refuses strands them worse, because they picked it out of the only place that claims to say what is
  // accepted and were still told no. The catalogue's structures were being printed among the goods —
  // eight buildings offered, one of them raisable — so seven names here were an invitation to a refusal.
  // The three groups are split because they take three different sentences (a number, no number, a number
  // plus a species the crew chooses), and a person cannot be expected to know which group a word is in.
  // (THE `list` BRANCH STOOD HERE AND IS DELETED — Architect 2026-09-06: *"foreman help is now the list.
  // so remove list."* It printed the whole catalogue in four messages over four seconds. `legalFamilies()`
  // went with it, being its only caller (Law 16). What the verb was FOR — spelling — is now bought
  // entirely by the refusals at Gate 2 of `request`, which name the form that works at the moment a person
  // gets one wrong. What is genuinely lost is BROWSING: there is no longer any way to read what the crew
  // can be asked for without asking and being corrected.)

  if (INGAME_VERBS.has(verb)) {
    // EVERY VERB HITS ALL OF THE ASKER'S BOTS AND NOTHING ELSE. No bot is named, and that is the ruling
    // rather than a simplification: the operator's verbs have always been fleet-wide, and in here a
    // person's "fleet" is the bots that are theirs. The delivery set is decided by the overseer from
    // the owner each bot declared at birth, so this call carries WHO SPOKE and never WHICH BOT.
    // NO IN-GAME VERB CARRIES A PAYLOAD ANY MORE. `move` was the only one, and it left the in-game
    // vocabulary with the other bench verbs — so the coordinate parser and its usage-line refusal went
    // with it (Law 16: nothing stays alive that nothing calls). `stop` and `wipe` are both bare words.
    // THE ONE VERB THE DESK HOLDS BACK ON ITS FIRST HEARING. Placed before the crossing, not after it:
    // an unconfirmed wipe must not reach the fleet at all, so there is nothing to undo and nothing that
    // half-happened. The word is short because he asked for it short, and because a person about to lose
    // their base reads one line and not a paragraph.
    if (verb === 'wipe') {
      const now = Date.now();
      const armed = wipeArmed.get(from);
      if (!armed || armed < now) {
        wipeArmed.set(from, now + WIPE_CONFIRM_MS);
        reply(`wipe forgets your base — your crew stops and resettles where you next stand. say wipe again to confirm.`);
        return;
      }
      // SPENT ON USE, so a third `wipe` is a fresh warning rather than a second silent wipe.
      wipeArmed.delete(from);
    }

    const r = await door.send(verb, {}, from);
    const said = describeDoorResult(verb, r);
    log(`${verb} for ${from} -> ${said}`);
    reply(said);
    return;
  }

  reply(`don't know '${verb}'. say "${FOREMAN_PREFIX} help".`);
}

// describeDoorResult — turn the fleet's verdict into a sentence for the person who asked.
//
// IT NEVER SAYS "DONE" FOR A DELIVERY. The door reports how many bots a verb reached, which is not the
// same as those bots having acted on it, and the gap matters most on the verb where it is easiest to
// paper over: a human told "started" who is watching a bot stand still has been handed a false verdict
// they can see through (Law 25). "sent to N" is the true statement and it is no longer to read.
//
// EACH REFUSAL NAMES ITS OWN CAUSE. "Nothing happened" has four causes here and they send a person to
// four different places: no bot fetched yet, the named bot is not one of theirs, the fleet is not up,
// or the word is not one the fleet knows.
function describeDoorResult(verb, r) {
  if (!r.ok) return `couldn't reach the fleet: ${r.error}`;
  // A WIPE REPORTS ON MEMORY, NOT ON DELIVERY, and it is the one verb here that succeeds while reaching
  // zero bots. Everything below counts bodies because every other verb IS a delivery; a wipe is now done
  // by the overseer against the player's own file, so `sent: 0` is its NORMAL result and the generic
  // "reached nobody" underneath would report a completed wipe as a failure.
  if (r.reason === 'wiped') {
    return r.stopped > 0
      ? `wiped. your ${r.stopped} bot${r.stopped === 1 ? '' : 's'} left — say "${FOREMAN_PREFIX} get" and a new crew settles where you are.`
      : `wiped. say "${FOREMAN_PREFIX} get" and your crew settles where you are.`;
  }
  if (r.sent > 0) return `${verb} sent to your ${r.sent} bot${r.sent === 1 ? '' : 's'}.`;
  switch (r.reason) {
    // ORDERED BY WHAT THE HUMAN SHOULD DO NEXT, and 'not_yours' comes first for a reason: a person who
    // owns no bots but is standing beside somebody else's needs to be told to fetch their own, not told
    // the fleet is empty when they can plainly see it is not.
    case 'not_yours':
      return `none of those are yours — every bot out here belongs to someone else. `
           + `say "${FOREMAN_PREFIX} get" and I'll fetch you one.`;
    case 'not_a_contractor':
      return `the bots out here answer to nobody — a homesteader takes no orders from in here. `
           + `say "${FOREMAN_PREFIX} get" and I'll fetch you one of your own.`;
    case 'no_bots':      return `no bots are up. say "${FOREMAN_PREFIX} get" and I'll fetch you one.`;
    case 'reached_nobody': return `you have no bots out. say "${FOREMAN_PREFIX} get" and I'll fetch you one.`;
    case 'unknown_verb': return `the fleet doesn't know '${verb}'.`;
    // THE VERB EXISTS AND IS NOT A HUMAN'S TO SAY. Distinct from unknown_verb because it sends a person
    // somewhere different: nothing is misspelled and nothing is broken — the word belongs to the console.
    // The desk should never produce this (its own gate is narrower), so seeing it means the desk and the
    // overseer have drifted, which is exactly why the overseer refuses rather than trusting the sender.
    case 'not_ingame_verb': return `'${verb}' isn't something you can ask for in here — it's an operator command.`;
    case 'no_asker':     return `I couldn't tell the fleet who you are, so it refused. that's my fault, not yours.`;
    default:             return `${verb} reached nobody.`;
  }
}

// DELETED 2026-08-30 — `matchRoster` and `nextFree`, both orphaned by the crew ruling (Law 16: nothing
// stays alive that nothing calls). `matchRoster` resolved a short bot name a human typed; `get` no
// longer accepts one, because a human cannot address an individual bot and a name would be an
// instruction nothing downstream can honour. `nextFree` picked the eldest free name for a single bot;
// the crew branch now takes the first CREW_SIZE free names in the same seniority order, in the one place
// that needs them. The rule those two carried and the crew branch still honours: the ROSTER is read off
// the LIVE fleet, never off the launcher's PID file, which remembers processes that died last week
// (Invariant B) — and a name reaches `startBot` only after the live fleet has reported it FREE.

function firstMeaningfulLine(out) {
  if (!out) return null;
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
    .filter(l => !/deprecat|warning|^\(node:/i.test(l));
  return lines.length ? lines[lines.length - 1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The body
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: FOREMAN_NAME, version: VERSION, auth: 'offline',
});

bot.on('error', e => log(`ERROR: ${e.message}`));
bot.on('kicked', r => log(`KICKED: ${JSON.stringify(r)}`));
bot.on('end', r => { log(`disconnected (${r}) — the foreman does not self-restart; start it again from the terminal.`); process.exit(1); });

bot.once('spawn', () => {
  log(`standing by at ${bot.entity.position.floored()} on the '${FOREMAN_CHANNEL}' channel.`);

  const ch = channel.active();
  const reply = (to, text) => ch.reply(bot, to, text);

  ch.listen(bot, ({ from, text }) => {
    // THE VERBATIM LINE, RECORDED BEFORE ANYTHING IS MADE OF IT. Everything after this event is the
    // machine's reading; only this is what the person actually typed, and the gap between the two is
    // what a reader is usually chasing (Law 20's rule for the other record, for the same reason).
    record.heard(from, text);
    log(`${from}: "${text}"`);
    // One human's command must not be able to take the foreman down for the next one, so the boundary
    // is caught HERE and reported to the person who asked. This is a Law 16 legal catch: a terminus
    // that turns a fault into an answer, never a swallow — the fault is logged in full to the foreman's
    // own window and the human is told plainly that it failed.
    Promise.resolve()
      .then(() => handle(from, text, (t) => { record.said(from, t); reply(from, t); }))
      .catch((e) => {
        log(`FAILED handling "${text}" from ${from}: ${e && e.stack ? e.stack : String(e)}`);
        // A fault is part of that person's session and belongs in their transcript, not only in the
        // window: a reader reconstructing why somebody gave up needs to see that the desk broke on them.
        record.refused(from, 'handler_threw', text);
        const line = `that failed: ${String(e.message || e).slice(0, 120)}`;
        record.said(from, line);
        reply(from, line);
      });
  }, log);

  // ── THE GREETING: TWO WORDS, SAID TO THE ONE PERSON WHO NEEDS THEM ──────────────────────────────
  // THE ASK (Architect 2026-09-05, after joining his own server for the first time): *"when someone logs
  // in they should get a message from foreman welcoming them and how to use it. 'hello <player> use
  // /foreman help for commands and foreman get to get bots. thats it."*
  //
  // WHY IT IS THE HIGHEST-VALUE LINE THE DESK SAYS. Every other sentence here answers a question somebody
  // asked. This one reaches the person who does not know there is a question — someone who has just
  // walked into a world with a bot standing in it and no reason to guess that it listens, or to what
  // word. The whole in-game surface is unreachable without it, and the on-duty broadcast above could not
  // do this job: it fires once when the FOREMAN starts, which is almost never the moment a player
  // arrives, and it is said to an empty world.
  //
  // IT TEACHES THE FORM, WHICH IS WHY THE HELP PAGE NO LONGER HAS TO. `foreman_vocabulary.helpLines()`
  // dropped its header line to fit the chat window, and this is where that line went — moved to the one
  // moment the `foreman <command>` shape is news rather than something the reader has already used.
  //
  // TWO VERBS, NOT NINE, AND THE ORDER IS HIS: `help` first because it is the one that leads everywhere
  // else, `get` second because it is the one they came to do.
  //
  // ONE LINE, ONE PERSON, ONCE. The outbound queue sends a line per second, so a greeting that ran to
  // three lines would spend three seconds of a shared channel per arrival — and on a server filling up
  // after a video, arrivals cluster. `thats it` is a specification.
  const greeted = new Set();
  bot.on('playerJoined', (player) => {
    const name = player && player.username;
    // NOT ITSELF, AND NOT A BOT. The foreman sees its own join and every contractor's, and a crew of two
    // arriving would otherwise produce two greetings addressed to bodies that cannot read them — noise on
    // the one channel a person is trying to read, at the exact moment they are reading it. The roster is
    // the fleet's own list of bot names (Law 16: BOT_SENIORITY is where that fact lives).
    if (!name || name === FOREMAN_NAME || Object.prototype.hasOwnProperty.call(BOT_SENIORITY, name)) return;
    // GREETED ONCE PER FOREMAN LIFETIME, not once per join. Someone whose connection drops and returns
    // three times in a minute is having a bad enough time without being introduced to the server on each
    // attempt. The set is in-process and deliberately not persisted: a foreman restart is rare, and
    // re-greeting after one is the harmless direction of that trade.
    if (greeted.has(name)) return;
    greeted.add(name);
    record.said(name, 'greeting');
    ch.reply(bot, name, `hello ${name} — say "${FOREMAN_PREFIX} help" for commands, "${FOREMAN_PREFIX} get" for bots`);
  });

  // ── A CREW BELONGS TO A PERSON, SO IT LEAVES WITH THEM ──────────────────────────────────────────
  //
  // (Architect 2026-09-05: *"the bots should leave when the player disconnects."*)
  //
  // WHY THE DESK IS THE RIGHT OWNER OF THIS AND NOT THE OVERSEER. A contractor's owner is a fact the
  // overseer holds, but *whether that owner is standing in the world* is a fact only something WITH A
  // BODY can observe — and the foreman is the fleet's only body that is always present. The overseer has
  // no client and cannot see a player leave. So this is not a convenience placed here; it is the one
  // process that can see the event at all (Invariant D — the owner of a fact is whoever can sense it).
  //
  // THE SAME `stop` A PERSON SAYS, through the same door (Law 16). It is not a new teardown path: the
  // relay resolves the delivery set from the owner each bot declared at birth, so this reaches exactly
  // the leaver's crew and nothing else, and a name nobody owns bots under is a no-op rather than an
  // error. Inventing a second way to end a contractor would be a second thing to keep in step with
  // whatever `stop` means next.
  //
  // NO GRACE PERIOD, AND THAT IS A DECISION RATHER THAN A SIMPLIFICATION. A held crew would have to be
  // released on a timer nobody watches, and during that window the bots are standing in the world owned
  // by somebody who is not there — unreachable by them and unavailable to anybody else, which is the
  // worst of both states. A person who drops and returns says `get` again and is served in seconds.
  //
  // IT SAYS NOTHING IN CHAT. The person it concerns has gone, and everybody else is being told about
  // somebody else's housekeeping.
  bot.on('playerLeft', (player) => {
    const name = player && player.username;
    // NOT ITSELF, NOT A BOT. A contractor's own departure raises this event, and the crew stopping is
    // exactly what produces those departures — so without this guard a `stop` would re-enter the door
    // once per body it had just ended, under a name that owns nothing.
    if (!name || name === FOREMAN_NAME || Object.prototype.hasOwnProperty.call(BOT_SENIORITY, name)) return;
    door.send('stop', {}, name).then((r) => {
      if (!r.ok) { log(`${name} left; could not reach the fleet to release their crew: ${r.error}`); return; }
      if (r.sent > 0) log(`${name} left — released their ${r.sent} bot(s)`);
    });
  });

  bot.chat(`${FOREMAN_NAME} on duty. say "${FOREMAN_PREFIX} help".`);
});
