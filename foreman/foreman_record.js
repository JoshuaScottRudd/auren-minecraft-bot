'use strict';
// foreman_record — what the desk writes down, and the one place its event vocabulary is declared.
//
// The unit of this record is a person's session at the desk: every event carries who spoke, so a reader
// can reconstruct one person's whole exchange with the desk (Law 6 — no black box at a boundary the fleet
// does not control).
//
// The writer is `js_kernel/watcher`, reached by naming the unit in BOT_ID before the require, so the
// append-only writer, its write-through index, its flush and its run-start sweep are inherited whole
// (Law 16, Law 22). The grammar is `custom_api/crew_log` — `VERB subject key=value`,
// emitted and parsed by one file. The reader is a lens behind the `trace_monitor` flag.
//
// crew_log guarantees its own form by replacing whitespace inside a value with `_`, which would collapse
// two different sentences typed at the desk into one. Text here crosses percent-encoded instead, so the
// desk can preserve a person's sentence exactly as typed. `encodeText`/`decodeText` are declared together,
// beside each other, the same way crew_log keeps its own parser beside its renderer (Law 26).
//
// RECORDED: every line addressed to the desk, what the desk made of it, every refusal with its code,
// every line the desk spoke back, everything that crossed the veil, and what the fleet answered — together
// they replay a person's whole session.
//
// NOT RECORDED: ordinary conversation in the world. The desk stays silent on chat not addressed to it, and
// recording it would bury the sessions this record exists to hold under everyone else's talk. What a
// person says to the desk is the desk's business; what they say to each other is not.

const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');

// The stage every desk event is filed under. Read back by the lens off the watcher's own furniture
// (`[FOREMAN_DESK] 📊 …`), so it is the join between the two halves and is spelled once.
const TAG = 'foreman_desk';

// ── the text codec ────────────────────────────────────────────────────────────────────────────────
// encodeURIComponent: reversible for every character a chat packet can carry, emits no whitespace, and
// both halves are standard library, so there is no escaping table here to drift out of step with a
// decoder.
function encodeText(s) { return encodeURIComponent(String(s == null ? '' : s)); }

// No catch here: a torn final line is already dropped by the JSONL reader before any value reaches this
// function, so the only input left is a value this file's own encoder produced. A decode failure on that
// value is a coding violation and must surface as a crash, not a mangled transcript (Law 13, Law 16).
function decodeText(s) {
  if (s == null) return '';
  return decodeURIComponent(String(s));
}

// ── the verbs ─────────────────────────────────────────────────────────────────────────────────────
// One function per thing worth recording. Naming them here lets a reader audit the whole vocabulary of
// this record in one screen, and keeps the lens from being surprised by an undeclared verb.
//
// Every event carries `who`. The record is grouped by person and nothing else, so an event that could
// not say whose session it belongs to would be a line the reader cannot place (Invariant D).

// A person addressed the desk. The verbatim line is the anchor of the whole record — everything after
// it is what the machine made of it, and only this says what was actually typed.
function heard(who, text) {
  crewLog.event(TAG, 'heard', { who, text: encodeText(text) });
  crewLog.flush();
}

// The desk read the line as a verb. Separate from `heard` because the gap between the two IS the
// question a reader is usually asking — what somebody typed versus what the desk made of it.
function read_as(who, verb) {
  crewLog.event(TAG, 'read_as', { who, verb });
  crewLog.flush();
}

// A correction fired: nothing crossed. The code travels, not the sentence: the code is the stable name
// of the refusal and the sentence is free to be reworded, so a reader counting how often one refusal is
// met is never counting a phrasing (Law 26: a machine never keys on prose).
function refused(who, code, said) {
  crewLog.event(TAG, 'refused', { who, code, said: encodeText(said) });
  crewLog.flush();
}

// Something crossed the veil. `door` says which of the two roads it took, because that distinction is
// the whole origin design: an operator verb and a requirement are not the same kind of crossing.
function relayed(who, door, action, detail) {
  crewLog.event(TAG, 'relayed', { who, door, action, detail: detail == null ? null : encodeText(detail) });
  crewLog.flush();
}

// What came back from the fleet: `ok` plus the fleet's own reason, never the desk's rendering of it.
// The sentence the person heard is recorded separately by `said`, so a reader can see the desk
// translating, not only its output (Law 25).
function fleet_said(who, ok, reason) {
  crewLog.event(TAG, 'fleet_said', { who, ok: ok ? 'yes' : 'no', reason: reason == null ? null : reason });
  crewLog.flush();
}

// A line the desk spoke to a person, recorded per line: the help is eight lines and a correction is
// two, and a transcript that merged them would lose the shape of the answer.
function said(who, text) {
  crewLog.event(TAG, 'said', { who, text: encodeText(text) });
  crewLog.flush();
}

// A line the foreman said to the whole world about the run: a structure finished or a layer released.
// Addressed to no person, so `who` is `all`. `kind` and its own fields carry the event for a reader that
// cuts on it (a timelapse switches cameras here); `text` is the sentence as it was said.
function announced(kind, fields, text) {
  crewLog.event(TAG, 'announced', { who: 'all', kind, ...fields, text: encodeText(text) });
  crewLog.flush();
}

// ── there is no `ignored_origin` event ───────────────────────────────────────────────────────────
// The channel subscribes to the player chat packet only, never the console's, so a console line never
// reaches the desk — there is nothing to refuse and nothing to record. A verb that can never fire would
// misstate where this safety lives (Law 27: constitutional here, so there is no enforcer to report on;
// Law 25: a record must not imply a check that does not exist).

// ── the prose half ────────────────────────────────────────────────────────────────────────────────
// The desk's own window line, kept as prose and not as an event: a person scrolling the record wants
// sentences, a lens wants fields, and neither is derivable from the other cheaply. Goes through the
// watcher so it lands in the same file at the same offset ordering — one record, two registers.
function note(message) {
  watcher.summary('foreman', message);
}

module.exports = {
  TAG,
  heard, read_as, refused, relayed, fleet_said, said, announced, note,
  encodeText, decodeText,
};
