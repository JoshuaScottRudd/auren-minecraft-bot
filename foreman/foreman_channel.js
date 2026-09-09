'use strict';
// foreman_channel.js — WHERE THE FOREMAN LISTENS, and the only file that knows.
//
// The Architect's ruling: "for now build open chat but eventually it will be moved to whisper... so
// make it easy to switch over. leave some space stubbed." So the foreman never touches a mineflayer
// chat event directly. It asks this module for a stream of commands and a way to answer, and the
// swap is one constant in architect_config (FOREMAN_CHANNEL).
//
// WHY OPEN CHAT FIRST, recorded so the eventual switch is a decision rather than a drift: the videos
// are claim-and-proof, and a whispered instruction is one the viewer has to take on trust. Open chat
// puts the instruction in frame beside its outcome. Whisper wins later, when the server holds more
// than one human and every bot parsing every line stops being free.
//
// ─── WHAT THE CHAT PROBE FORCED INTO THIS FILE ──────────────────────────────────────────────────
// Two findings from `tools/chat_probe.js` are load-bearing here, and neither is obvious from reading
// mineflayer's API:
//
//   C4 — A CONSOLE /say ALSO RAISES 'chat', as the player `Rcon`. The high-level event cannot tell a
//        human from the server console, so anything able to reach the console could issue foreman
//        commands. One layer down they separate cleanly: a real player arrives on `player_chat`, the
//        console on `profileless_chat`. So this module reads the WIRE, not the event. A sender's name
//        is a claim; a packet type is not (Law 23).
//
//   C3 — THE BOT HEARS ITS OWN CHAT COME BACK. The foreman answers in chat, so without a self-filter
//        its own acknowledgement re-enters its own parser. Dropped by UUID rather than by name,
//        because a name is the very thing an impersonator would copy.

const { FOREMAN_CHANNELS, FOREMAN_CHANNEL, FOREMAN_PREFIX } = require('@thinking/architect_config');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// OPEN CHAT — built
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Every human line the foreman hears, authenticated at the packet layer, delivered as {from, text}.
// `onCommand` is called ONLY for lines addressed to the foreman; everything else in the world's
// conversation is ignored without comment, because a clerk that answers unaddressed remarks is noise
// in a recording.
function listenOpenChat(bot, onCommand, log) {
  bot._client.on('player_chat', (packet) => {
    // The message body. 1.21.5 signs chat, and a signed message carries its text in `plainMessage`;
    // `unsignedChatContent` is the fallback the protocol uses when a client sends unsigned. Reading
    // both rather than assuming one is the difference between a foreman that works and one that goes
    // deaf the first time a client is configured differently.
    const raw = packet.plainMessage != null ? packet.plainMessage : packet.unsignedChatContent;
    if (typeof raw !== 'string' || raw.trim() === '') return;

    const from = resolveSender(bot, packet);
    if (!from) {
      // A message whose sender cannot be named is not refused quietly — it is REPORTED and dropped.
      // Silently ignoring it would look identical to the foreman being deaf, which is the one failure
      // mode a human standing in the world cannot diagnose (Law 25).
      log(`heard a player message whose sender could not be resolved — ignoring. uuid=${packet.senderUuid}`);
      return;
    }
    if (from === bot.username) return;                       // C3: never re-parse its own answer

    const text = raw.trim();
    const parsed = parseAddressed(text);
    if (!parsed) return;                                     // not addressed to the foreman
    onCommand({ from, text: parsed, raw: text });
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE OUTBOUND QUEUE — one line at a time, paced, and nothing is ever cut
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// TWO WAYS TO SPEAK YOURSELF OFF A SERVER, and this file is the only place either can be prevented,
// because it is the only way the foreman can talk at all. A rule kept anywhere else would be a rule
// something could route around; here the property is enacted rather than enforced (Law 27).
//
// PACE. Vanilla charges a player 20 ticks of spam credit per chat packet and refunds 1 per tick,
// kicking above 200 — so eleven lines sent together is a kick, not a slow answer. One line per second
// is exactly the refund rate, so a queue running at this pace holds a constant balance of 20 no matter
// how long it runs and can never accumulate toward the limit.
//
// WIDTH. A line over the protocol's cap is refused a layer down, so an over-long answer used to be
// TRUNCATED to fit — which quietly deleted the end of the longest sentence in the help, and the
// longest sentence is the one carrying the consequence a person needed before speaking (Law 25: a
// criterion the asker never received). Wrapping preserves it; the name is repeated on every
// continuation so two humans reading one channel can still tell whose answer is whose.
const MAX_CHAT_LINE = 240;
const MS_BETWEEN_LINES = 1000;

const pending = [];
let pumping = false;

function pump() {
  const next = pending.shift();
  if (!next) { pumping = false; return; }
  pumping = true;
  next();
  const t = setTimeout(pump, MS_BETWEEN_LINES);
  if (t.unref) t.unref();   // Law 8: a pacing timer must never be the reason a process stays alive
}

function enqueue(send) {
  pending.push(send);
  if (!pumping) pump();
}

// Word-wrap, with a hard split for a single word longer than the whole width — otherwise a pasted
// coordinate blob would sit in the queue as a line that can never be placed.
function wrapLine(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') { line = word; continue; }
    if (line.length + 1 + word.length <= width) { line += ` ${word}`; continue; }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.flatMap(l => (l.length <= width ? [l] : l.match(new RegExp(`.{1,${width}}`, 'g'))));
}

function replyOpenChat(bot, to, text) {
  const prefix = `${to}: `;
  for (const chunk of wrapLine(text, MAX_CHAT_LINE - prefix.length)) {
    enqueue(() => bot.chat(prefix + chunk));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHISPER — declared, deliberately NOT built
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// The seam is real and the mechanism is already proven: probe C5 showed a player's /msg arrives on
// mineflayer's `whisper` event carrying the sender's name, so this is an afternoon's work when the
// Architect calls for it. What it is NOT is a silent fallback to open chat.
//
// A fallback here would be the worst available failure: flipping FOREMAN_CHANNEL to WHISPER would look
// like it worked — commands would still be obeyed, answers would still arrive — while every command
// and every reply went out to the whole server. The switch would appear to succeed at exactly the
// moment it stopped doing the one thing it was flipped for. So it throws (Law 13).

function listenWhisper() {
  throw new Error(
    `CODING VIOLATION (Law 13): FOREMAN_CHANNEL is '${FOREMAN_CHANNELS.WHISPER}' but the whisper channel is ` +
    'NOT BUILT. It is a declared seam, not a working option — see foreman_channel.js. Set FOREMAN_CHANNEL ' +
    `back to '${FOREMAN_CHANNELS.OPEN_CHAT}' in architect_config, or build listenWhisper/replyWhisper ` +
    "against mineflayer's `whisper` event (proven live by chat probe C5)."
  );
}

const replyWhisper = listenWhisper;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The switch
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const CHANNELS = {
  [FOREMAN_CHANNELS.OPEN_CHAT]: { listen: listenOpenChat, reply: replyOpenChat },
  [FOREMAN_CHANNELS.WHISPER]:   { listen: listenWhisper,  reply: replyWhisper  },
};

function active() {
  const ch = CHANNELS[FOREMAN_CHANNEL];
  if (!ch) {
    throw new Error(
      `CODING VIOLATION (Law 13): FOREMAN_CHANNEL='${FOREMAN_CHANNEL}' is not a channel — valid: ` +
      `${Object.keys(CHANNELS).join(' | ')}.`
    );
  }
  return ch;
}

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────

// The sender's NAME, resolved from the uuid the packet carries rather than from anything the message
// says about itself. `bot.players` is the server's own roster, so this is the server's answer to
// "who is that", not the sender's (Law 23).
function resolveSender(bot, packet) {
  const uuid = packet.senderUuid;
  if (!uuid) return null;
  const want = String(uuid).replace(/-/g, '').toLowerCase();
  for (const [name, p] of Object.entries(bot.players || {})) {
    if (p && p.uuid && String(p.uuid).replace(/-/g, '').toLowerCase() === want) return name;
  }
  return null;
}

// `foreman get auren` -> `get auren`. Anything not addressed to the foreman returns null.
// Case-insensitive on the prefix only: a human typing in a hurry should not have to hit shift.
function parseAddressed(text) {
  const t = text.trim();
  const p = FOREMAN_PREFIX.toLowerCase();
  const low = t.toLowerCase();
  if (low === p) return '';                                  // bare "foreman" -> the help case
  if (!low.startsWith(p + ' ')) return null;
  return t.slice(p.length + 1).trim();
}

module.exports = { active, parseAddressed, resolveSender, CHANNELS };
