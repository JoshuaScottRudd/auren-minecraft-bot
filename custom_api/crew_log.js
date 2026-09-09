// module: crew_log
// purpose: The ONE grammar the three crew seats report in, and the ONE parser that reads it back.
//          Emitting and parsing live in the same file on purpose — they are two halves of one contract.
//
// contract:
//  - event(tag, verb, fields) posts one state-change line through watcher.summary.
//  - parse(text) turns such a line back into { verb, fields } — or null if it is not one of ours.
//  - Nothing here decides anything. It formats and it reads; the seats own what is worth saying.
//
// ── WHY EACH SEAT REPORTS, AND WHY A SEPARATE LENS ASSEMBLES THE STORY ─────────────────────────────
// Three seats are independently accountable, so each must speak into the trace directly rather than
// routing through one recorder — a shared reporter would make every seat's record depend on a piece it
// does not own. Reporting only state changes keeps every posted line informative: output not tied to a
// decision is noise, not information. The commander does not need to reconstruct the story of a fight in
// real time; a lens built later can compose it from the trace, which is what `parseAll` below is for.
//
// ── WHY A GRAMMAR AND NOT PROSE ────────────────────────────────────────────────────────────────────
// The lens described above is what forces this file. A lens rebuilding the fight AFTER the run has to read
// these lines, and a machine reading a human sentence is the joint Law 26 forbids: it works until someone
// rewords the sentence, and then it fails silently or — worse — half-matches. Two machines need only a
// shared FORM (Law 10), so the form is declared once, here, and both ends import it.
//
// The line is `VERB subject key=value key=value`. It is deliberately readable as English by a person
// scanning the trace, so the fleet does not pay for two renderings of one fact — which would itself be the
// redundancy this design avoids, and the pair would drift the first time either was edited.
//
// ── WHY STATE CHANGES ARE NOT THE PER-STEP LOGGING LAW 5 DELETED ───────────────────────────────────
// Law 5 removed fine-grained per-step logs as noise and made the summary line the primary channel. This
// does not reopen that: a per-step log emits once per TICK (20 Hz, unbounded in a long fight, and mostly
// restating the last line), while a state-change emits once per DECISION. A wave where the bot approaches,
// holds, guards once and kills produces single figures either way. The count is bounded by how often the
// crew changes its mind, which is exactly the quantity a reader wants and the one an aggregate destroys.
//
// The seats still post ONE aggregate line each at the engagement boundary — but only for quantities that
// cannot be events, because they are true of the ticks that emitted nothing (percentage of ticks inside
// the band, blocks per second achieved, ticks spent in reach). Anything derivable from the stream was
// deleted from those lines rather than printed twice.
//
// ── ONE LINE PER SEAT PER PASS, NOT ONE LINE PER EVENT ──────────────────────────────────────────────
// The state-change ruling above is unchanged and still right — what was wrong was the RENDERING. A single
// driver decision could emit a mode line and a sprint-toggle line as two separate trace lines a moment
// apart, and a commander sweep emitted a `bearing` line per re-aim — one decision spread across several
// one-fact lines, so a reader scrolling the trace could not see a decision, only its fragments.
//
// So events BUFFER and are flushed by the seat's own caller at the end of each combat pass: one line per
// tag, its events joined by EVENT_SEP. Nothing about what is recorded changed — same verbs, same fields,
// same count — only how many lines carry them. That is why the aggregates above are still owed: they hold
// what no event can, and coalescing does not create a single one of those facts.
//
// THE PARSER MOVED WITH IT, in the same edit, which is the whole reason both halves live in this file. A
// line may now hold several events, so `parseAll` returns an ARRAY and is the only entry point. There is
// deliberately no single-event `parse` left to reach for: it would return the first event of a coalesced
// line and silently drop the rest — a well-formed falsehood handed to a machine (Law 26), and the exact
// failure this file's shared-form design exists to prevent.

'use strict';

// ── THE WATCHER IS REQUIRED LAZILY, AND THAT IS NOT A MICRO-OPTIMISATION ───────────────────────────
// This file has two ends and they run in DIFFERENT PROCESSES: the seats emit inside the live bot, the
// engagement lens parses inside a monitor with no bot at all. A top-level require would drag the whole
// logging stack — a Watcher instance bound to its unit's trace file — into every reader that
// only wanted `parse`. A monitor must be able to read the grammar without instantiating the thing that
// writes it (Law 26: build the translator, never become it).
let _watcher = null;
function watcher() {
  if (!_watcher) _watcher = require('@kernel/watcher');
  return _watcher;
}

// A subject is `name#id` — the one shape every crew event names a mob in. Kept positional rather than as
// `id=619 name=skeleton` because it is the field a human's eye searches for, and two keys for one subject
// is the redundancy this file exists to avoid.
function subject(entity) {
  if (!entity) return null;
  const name = entity.name || entity.displayName || 'unknown';
  const id = entity.id != null ? entity.id : (entity.entity && entity.entity.id);
  return id == null ? null : `${name}#${id}`;
}

// Separates events sharing one line. Space-padded and made of a character no field can contain — tokens
// are `verb`, `name#id` or `key=value`, all of which are matched on whitespace, so a bare delimiter would
// be indistinguishable from a value. The parser splits on exactly this string, never on a regex guess.
const EVENT_SEP = ' · ';

// tag → rendered events awaiting a flush. Module scope, one map for the whole process: the seats are three
// modules and the flush is one call, so a per-seat buffer would need three flush sites and would be three
// chances to leave one un-flushed (Law 16 — one mechanism).
const _pending = new Map();

// ── THE FORM IS GUARANTEED HERE, NOT HOPED FOR AT THE CALL SITES ───────────────────────────────────
// Every token is whitespace-separated, so a single space inside a VALUE turns one event into two garbage
// tokens and — under the all-or-nothing rule below — discards the whole line, every seat's events with it.
// A value with an embedded space is easy to introduce by accident at any call site, so sanitising here is
// the by-construction guarantee Law 26 asks for — the emitter CANNOT emit a garbled value — and it is the
// correct treatment rather than a throw because values are partly WORLD-SOURCED (a server-renamed mob puts
// a space in `entity.name`), which makes a space environmental, not a coding violation (Law 13). A
// malformed VERB is the opposite case: verbs are literals in our own source, never world data, so a bad
// one is a coding violation and throws.
const clean = (v) => String(v).replace(/\s+/g, '_');

// event(tag, verb, fields) — one state change, buffered until the next flush.
//
// Numbers should arrive already rounded by the caller, because the caller is the only one that knows how
// much precision the fact deserves (a distance wants two decimals, a duration wants none) and rounding
// here would be this file deciding something.
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

// post(tag, verb, fields) — the same event, rendered by the same function, posted as its own line NOW.
//
// ── WHY A SECOND ENTRY POINT IS NOT A SECOND PATHWAY (Law 16) ──────────────────────────────────────
// One grammar, one renderer, two CADENCES. `event`+`flush` exists because the combat seats emit several
// events inside one pass and a reader wants the pass, not its fragments. An emitter with no pass has no
// such boundary — a watch arming, a camera choosing a vantage — and making it call `flush` would be
// worse than redundant: `flush` drains EVERY tag, so an emitter outside the combat loop would post the
// seats' half-built pass line early and split one decision across two trace lines. The buffer is the
// thing that must not be shared across cadences; the renderer is the thing that must be.
function post(tag, verb, fields = {}) {
  watcher().summary(tag, render(verb, fields));
}

// flush() — post every buffered seat's line and empty the buffer. Called at the top of each combat pass
// (battle_stations) and once more when the wave ends, so the last pass is never left in the buffer.
//
// IDEMPOTENT AND SAFE TO OVER-CALL: an empty buffer posts nothing. That matters because the call sites are
// a loop head and a loop exit, and on a wave with one pass both of them run.
//
// NO TIMER, DELIBERATELY. An auto-flush on setImmediate would need no call sites at all, and was the
// obvious build — it is rejected because the flush would then race the seats' aggregate lines and a
// coalesced event line could land AFTER the summary that closes the engagement it belongs to. A reader
// cannot tell a late line from a late decision. The caller knows where a pass ends; a timer only knows
// when the stack emptied.
function flush() {
  if (_pending.size === 0) return;
  // Drained BEFORE anything is posted, never during. `watcher.summary` is tapped by three bench scenarios
  // and could in principle reach back into `event`, and mutating the map mid-iteration would either lose a
  // line or loop. Snapshot-then-clear makes the re-entrant case merely buffer for the next flush.
  const batch = [..._pending];
  _pending.clear();
  for (const [tag, events] of batch) {
    if (events.length) watcher().summary(tag, events.join(EVENT_SEP));
  }
}

// parseAll(text) → [{ tag, verb, subject, fields }, …]
//
// Reads one rendered line back into every event on it. Returns an EMPTY ARRAY for anything that is not a
// crew line, which is most of the trace — the lens walks every line and takes what it recognises, so a
// non-match is the normal case and never a fault.
//
// ALL-OR-NOTHING PER LINE: one unparseable segment discards the whole line rather than returning the
// segments that happened to read. A half-decoded line is a partial record wearing a complete one's shape,
// and the lens counting it would understate a fight without any way to notice (Law 25).
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

// num(fields, key) → Number | null. The lens's own convenience, here rather than there so the two ends
// of the contract agree on what an unparseable value means (null, never NaN — a NaN propagates into a
// median and poisons a whole report before anyone notices, Law 13).
function num(fields, key) {
  if (!fields || fields[key] === undefined) return null;
  const n = Number(String(fields[key]).replace(/[a-z%]+$/i, ''));
  return Number.isFinite(n) ? n : null;
}

module.exports = { event, post, flush, parseAll, subject, num, EVENT_SEP };
