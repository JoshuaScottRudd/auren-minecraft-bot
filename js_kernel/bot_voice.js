// js_kernel/bot_voice.js
// A CONTRACTOR SAYS ONE THING AND ONE THING ONLY: WHETHER IT IS AVAILABLE.
//
// ── THE TWO RULINGS THAT BUILT THIS FILE, IN ORDER, BECAUSE THE SECOND IS NOT A REVERSAL ──────────
// 2026-09-06, morning: *"when they post to their owner. its way too much. it will block the players
// vision… reporting is off by default and a player should type foreman where."* The bots were narrating
// every job claim and every idle change. That file was deleted whole.
//
// 2026-09-06, same day: *"the bots should do a greeting. and they should tell the human if they are
// available or not. so if they are idle parked then they are waiting for a command. so when they go to
// idle park then they message once that they are idle. so a greeting, telling the player they are
// working. and then when they are parked and idle. we dont want to blast a player chat but thats useful
// to know."*
//
// THE TWO RULINGS AGREE, and reading them as a reversal is how this file gets rebuilt into the thing that
// was deleted. What was cut was **narration** — a running commentary on WHAT the bot is doing, which
// changes every job and is therefore unbounded. What is restored is **availability** — WHETHER the bot
// can take an order, which is a two-state fact that changes on the order of minutes and that nothing else
// in the world can tell a person. `foreman where` answers *what*; this answers *whether*, unasked,
// because the moment a crew becomes free is the moment a person needs to know and the one moment they
// have no reason to be asking.
//
// ── THE WHOLE VOCABULARY IS THREE SENTENCES ────────────────────────────────────────────────────────
//   greeting       said once, at birth, when the body has found its owner in the world
//   → idle         said when the bot parks with nothing it can start, and again about once a minute
//                  for as long as it stays parked
//   → working      said once, when it picks work back up
// There is no fourth, and adding one is how this becomes narration again. The test for a proposed line:
// **does it change whether this bot can take an order?** If not, it belongs in `foreman where`.
//
// ── WHY A STATE MACHINE AND NOT A REPEAT-SUPPRESSOR ────────────────────────────────────────────────
// The deleted file compared the last SENTENCE and dropped a duplicate. That is wrong for availability:
// a bot that goes idle, works for a minute, and goes idle again has said something NEW the second time,
// and identical text would have hidden it. So what is remembered is the last state SPOKEN, and a line is
// emitted only on a crossing.
//
// ── ONE STATE REPEATS AND ONE DOES NOT, AND THE ASYMMETRY IS THE POINT ─────────────────────────────
// `idle` is a STANDING condition and it repeats on the floor's cadence — about once a minute for as long
// as the bot is parked. `working` is a crossing and is said once.
//
// WHAT THE REPEAT IS FOR, and it is not the fleet's benefit: a body standing motionless in a world is
// read as broken, and one sentence eleven minutes ago does not survive that reading. The person needs to
// know the crew is well and merely unemployed at the moment they are looking at it, not at the moment it
// became true. `working again` needs no repeat for the same reason — a body that is visibly working is
// already answering the question the sentence answers.
//
// THE FLOOR IS WHAT MAKES THIS SAFE TO REPEAT: the interval and the anti-blast cap are one number, so a
// repeating line cannot outrun the guarantee stated below. Anything faster than the floor is the wall
// coming back.
//
// ── THE FLOOR, WHICH IS WHAT KEEPS A BUG FROM BECOMING A BLAST (his *"we dont want to blast a player
// chat"*) ──────────────────────────────────────────────────────────────────────────────────────────
// A crossing is real news, but a bot that claims a job which soft-fails immediately re-crosses every
// board re-scan — 10 s, `idle_scheduler.BOARD_RESCAN_MS` — and that is a fault state, not a fleet
// reporting itself. `MIN_GAP_MS` caps this bot at one availability line a minute, and the guarantee it
// buys is statable: **at most one line per bot per minute, and never wrong for longer than that.**
//
// IT NEEDS NO TIMER, and that is why it is a floor rather than a rate limiter with a queue. A suppressed
// crossing is not dropped and not remembered — `_spokenState` simply still disagrees with the world, so
// the next caller through offers it again. Both call sites re-offer on their own cadence (`_goIdle`
// every second while parked, the claim path on every claim), so the truth arrives on its own as soon as
// the floor lifts. A wobble that has resolved by then correctly says nothing at all: the state it would
// have announced is no longer the state.
//
// ── ONLY A CONTRACTOR SPEAKS ───────────────────────────────────────────────────────────────────────
// A homesteader answers to nobody by design (Law 19), nobody is standing beside it, and its availability
// is not a question anybody is asking. The species test is the whole gate; there is no per-run switch,
// because a switch is a second place the answer lives and the answer never varies by run.
//
// ── SPEECH IS NEVER THE WORK ───────────────────────────────────────────────────────────────────────
// Nothing here may stop, delay or fail a decision. The chat call goes through the external-library guard
// (Law 16's one legal catch — mineflayer is third-party and a socket can close under it), and a refused
// line is a warning on the diagnostic log, never a throw into the planner that called it. The trace
// remains the record; this is a courtesy to a person, and a courtesy that can halt a fleet is a defect.

'use strict';

const watcher = require('@kernel/watcher');
const botMandate = require('@kernel/bot_mandate');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'bot_voice';

// Minecraft refuses a chat message over 256 characters outright — an over-long line is not truncated by
// the server, it simply never appears. Every sentence here is far under it; the cut is a backstop for a
// future one, not a working limit.
const MAX_CHAT = 200;

// One availability line per bot per minute. See THE FLOOR above.
const MIN_GAP_MS = 60000;

// Module state is correct here for the same reason it is in the pathfinder: one decision-maker per
// process holds one body and one voice (Law 4), so there is exactly one availability state to remember.
let _spokenState = null;      // 'working' | 'idle' — the last state this bot has actually SAID
let _lastSpokenAt = 0;

// The three sentences, authored in one place so the desk's register and the bot's cannot drift apart.
//
// EACH ONE CARRIES THE STATE AND, WHERE THERE IS ONE, THE ACTION. `idle` without the sentence that fixes
// it is a bot reporting a problem to somebody it has not told how to solve — and this is the one moment
// the request form is information rather than notation, which is the same argument that took the glosses
// off the help page. `working again` needs no action: there is nothing for the person to do.
const GREETING = 'hi — yours now, and working.';
const IDLE     = 'idle — say "foreman request 20 logs".';
const WORKING  = 'working again.';

// _say(line) — put one sentence in open chat, addressed to the owner.
// Returns true if it went out. The return exists for a caller that wants to log the fact, not to retry on.
function _say(line) {
  if (!botMandate.isContractor()) return false;

  const bot = global.bot;
  if (!bot || typeof bot.chat !== 'function') return false;   // pre-spawn / headless: no world to speak into

  // ADDRESSED BY OWNER NAME so a second person in the world can tell whose bot is talking — the fleet is
  // designed to hold several contractors with different owners at once, and an unaddressed line makes
  // every one of them look like it is reporting to everybody. The bot's own name is already on the
  // message: Minecraft renders it as `<AurenBot> …`, so repeating it here would be a second copy.
  const owner = botMandate.currentOwner();
  const body = line.length > MAX_CHAT ? `${line.slice(0, MAX_CHAT - 1)}…` : line;
  const sent = guardExternalSync(TAG, 'bot.chat availability', () => bot.chat(owner ? `${owner}: ${body}` : body));
  return sent.ok;
}

// availability(state, line) — say `line` if this bot has not already said it is in `state` (or if `state`
// is one that repeats), and only if the floor has lifted. The one function every line goes through, so the
// floor cannot be bypassed by adding a call site (Law 16).
//
// `repeats` IS A PROPERTY OF THE STATE, DECLARED AT THE CALL SITE THAT OWNS IT, not a parameter a caller
// gets to choose per call. Two callers of one state passing different values would be two answers to
// "does this repeat", which is a fact about the state itself.
function _availability(state, line, repeats = false) {
  if (state === _spokenState && !repeats) return false;
  if (Date.now() - _lastSpokenAt < MIN_GAP_MS) return false;   // not dropped — the next pass re-offers it
  if (!_say(line)) return false;
  _spokenState = state;
  _lastSpokenAt = Date.now();
  return true;
}

// greet() — the birth line. Called by report_to_owner once the body has been put where its owner stands.
//
// IT SETS THE STATE TO `working` because that is what it says, and because a bot that greets and then
// immediately claims a job must not follow its greeting with `working again` — the greeting already
// carried that half. A bot that greets and finds nothing to do says `idle` on its next pass, correctly.
function greet() {
  if (_availability('working', GREETING)) watcher.summary(TAG, `greeted ${botMandate.currentOwner()}`);
}

// The two states. Named for the state rather than the event so a call site cannot mean one and say the
// other, and deliberately not given a `reason` parameter: a reason is what the bot is doing, which is
// `foreman where`'s question and the exact door narration came back through last time.
//
// goneIdle REPEATS (the `true`), backToWork does not — see ONE STATE REPEATS AND ONE DOES NOT above.
// `_goIdle` calls in here about once a second while parked, so the floor alone sets the cadence and the
// line lands about once a minute for as long as the standing still lasts.
function goneIdle()  { _availability('idle', IDLE, true); }
function backToWork() { _availability('working', WORKING); }

module.exports = { greet, goneIdle, backToWork, MIN_GAP_MS };
