// module: crew_log
// purpose: the one grammar the three crew seats report in, and the one parser that reads it back.
//          Emitting and parsing live in the same file so the two halves of the contract cannot drift
//          apart (Law 10).
//
// contract:
//  - event(tag, verb, fields) buffers one state-change line, flushed at the pass boundary.
//  - post(tag, verb, fields) posts one line immediately, through watcher.summary.
//  - parseAll(text) turns a rendered line back into every event on it — [] if it is not one of ours.
//  - Nothing here decides anything. It formats and it reads; the seats own what is worth saying.
//
// Each seat speaks into the trace directly (Law 10), so no seat's record depends on a piece it does not
// own. Only state changes are posted; a lens assembled later (`parseAll`) composes the fight's story
// from the trace.
//
// The line is `VERB subject key=value key=value` — one shared FORM (Law 10) both ends import, readable
// as English by a person scanning the trace and machine-parseable by `parseAll` without matching prose
// (Law 26).
//
// Only a state change is posted (Law 5): once per decision, not once per tick. The seats also post one
// aggregate line each at the engagement boundary, for quantities true of ticks that emitted nothing
// (percentage of ticks inside the band, blocks per second achieved, ticks spent in reach) — anything
// derivable from the event stream is left out of that line.
//
// Events from one pass BUFFER (`event`) and are flushed together (`flush`) as one line per tag, its
// events joined by EVENT_SEP, so a reader sees a whole decision. `parseAll` returns an ARRAY for this
// reason and is the only entry point: a coalesced line can hold several events, and a single-event
// reader would silently drop the rest (Law 26).

'use strict';

// This file's two ends run in different processes: the seats emit inside the live bot, the engagement
// lens parses inside a monitor with no bot at all. Requiring the watcher lazily lets a monitor read the
// grammar without instantiating the thing that writes it (Law 26).
let _watcher = null;
function watcher() {
  if (!_watcher) _watcher = require('@kernel/watcher');
  return _watcher;
}

// A subject is `name#id` — the one shape every crew event names a mob in, positional because it is the
// field a human's eye searches for.
function subject(entity) {
  if (!entity) return null;
  const name = entity.name || entity.displayName || 'unknown';
  const id = entity.id != null ? entity.id : (entity.entity && entity.entity.id);
  return id == null ? null : `${name}#${id}`;
}

// Separates events sharing one line. Made of a character no token (`verb`, `name#id`, `key=value`) can
// contain, since every token is matched on whitespace. The parser splits on exactly this string.
const EVENT_SEP = ' · ';

// tag → rendered events awaiting a flush. One map for the whole process, one flush call for all three
// seats (Law 16).
const _pending = new Map();

// Every token is whitespace-separated, so a space inside a value would turn one event into garbage
// tokens and, under the all-or-nothing rule below, discard the whole line. Sanitising here guarantees by
// construction that the emitter cannot emit a garbled value (Law 26). A value may carry a space because
// it is partly world-sourced (a server-renamed mob puts a space in `entity.name`), which makes it
// environmental (Law 13); a malformed VERB is a literal from our own source, so a bad one throws.
const clean = (v) => String(v).replace(/\s+/g, '_');

// event(tag, verb, fields) — one state change, buffered until the next flush.
//
// Numbers arrive already rounded by the caller: the caller knows how much precision the fact deserves
// (a distance wants two decimals, a duration wants none).
function render(verb, fields = {}) {
  if (!/^[a-z_]+$/.test(String(verb))) {
    throw new Error(`crew_log: verb "${verb}" is not [a-z_]+ — the parser keys on the verb, so this event ` +
      `would be unreadable by the engagement lens (Law 26: both ends of the interface, or neither)`);
  }
  const parts = [verb];
  if (fields.subject) parts.push(clean(fields.subject));
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'subject' || v === null || v === undefined) continue;
    parts.push(`${k}=${clean(v)}`);
  }
  return parts.join(' ');
}

function event(tag, verb, fields = {}) {
  const line = render(verb, fields);
  const list = _pending.get(tag);
  if (list) list.push(line);
  else _pending.set(tag, [line]);
}

// post(tag, verb, fields) — the same event, rendered by the same function (Law 16), posted as its own
// line now. For an emitter with no pass boundary of its own (a watch arming, a camera choosing a
// vantage): `flush` drains every tag, so routing such an emitter through it would post other seats'
// half-built pass lines early.
function post(tag, verb, fields = {}) {
  watcher().summary(tag, render(verb, fields));
}

// flush() — post every buffered seat's line and empty the buffer. Called at the top of each combat pass
// (battle_stations) and once more when the wave ends, so the last pass is never left in the buffer.
// Idempotent and safe to over-call: an empty buffer posts nothing.
//
// No timer: the caller knows where a pass ends, and flushing on a timer could land a coalesced event
// line after the summary that closes the engagement it belongs to.
function flush() {
  if (_pending.size === 0) return;
  // Drained before anything is posted, never during, so a re-entrant call into `event` merely buffers
  // for the next flush.
  const batch = [..._pending];
  _pending.clear();
  for (const [tag, events] of batch) {
    if (events.length) watcher().summary(tag, events.join(EVENT_SEP));
  }
}

// parseAll(text) → [{ tag, verb, subject, fields }, …]
//
// Reads one rendered line back into every event on it. Returns an empty array for anything that is not a
// crew line, which is most of the trace — the lens walks every line and takes what it recognises, so a
// non-match is the normal case and never a fault.
//
// One unparseable segment discards the whole line: a half-decoded line is a partial record wearing a
// complete one's shape, and the lens counting it would understate a fight without any way to notice
// (Law 25).
function parseAll(text) {
  if (typeof text !== 'string') return [];
  // Strip the watcher's own furniture: timestamp, bot name, [TAG] and the level glyph. What is left is
  // exactly what `event` wrote. The tag is returned because WHICH SEAT SPOKE is half of every fact here.
  const m = text.match(/\[([A-Z_]+)\]\s*📊\s*(.+)$/);
  if (!m) return [];
  const tag = m[1].toLowerCase();
  const out = [];
  for (const segment of m[2].trim().split(EVENT_SEP)) {
    const tokens = segment.trim().split(/\s+/);
    const verb = tokens.shift();
    if (!verb || !/^[a-z_]+$/.test(verb)) return [];   // an aggregate line, not an event
    const ev = { tag, verb, subject: null, fields: {} };
    let ok = true;
    for (const t of tokens) {
      const kv = t.match(/^([a-z_]+)=(.*)$/);
      if (kv) { ev.fields[kv[1]] = kv[2]; continue; }
      const subj = t.match(/^([a-z_]+)#(\d+)$/);
      if (subj) { ev.subject = { name: subj[1], id: Number(subj[2]) }; continue; }
      ok = false; break;    // a word that is neither — this is prose, not one of ours
    }
    if (!ok) return [];
    out.push(ev);
  }
  return out;
}

// num(fields, key) → Number | null. Shared here so both ends of the contract agree on what an
// unparseable value means: null, never NaN — a NaN propagates into a median and poisons a whole report
// before anyone notices (Law 13).
function num(fields, key) {
  if (!fields || fields[key] === undefined) return null;
  const n = Number(String(fields[key]).replace(/[a-z%]+$/i, ''));
  return Number.isFinite(n) ? n : null;
}

module.exports = { event, post, flush, parseAll, subject, num, EVENT_SEP };
