'use strict';
// foreman_record — WHAT THE DESK WRITES DOWN, and the one place its event vocabulary is declared.
//
// ── WHY THE DESK NEEDS A RECORD AT ALL ────────────────────────────────────────────────────────────
// Every other unit in this fleet leaves a trace that outlives its window. The desk did not: it printed
// to its own console and that was the whole record, so the moment the window closed there was no way to
// answer who had spoken to it, what they were refused, or what crossed into the fleet on their word.
// That is the one boundary where the fleet meets a party it does not control, and it was the only one
// with no record — a black box in the exact place Law 6 forbids one.
//
// THE DEMAND IS RECONSTRUCTION, NOT COUNTING. A tally of refusals says the desk refused eleven things;
// it cannot say that one person was refused eleven times because the list they were pointed at omitted
// the word they kept typing. Only a per-person transcript answers that, so the unit of this record is a
// PERSON'S SESSION AT THE DESK, and every event carries who spoke.
//
// ── NOTHING HERE IS NEW (Law 16, and Law 22's reuse gate) ─────────────────────────────────────────
// Three established systems carry this whole record and not one of them was built for it:
//   · THE WRITER is `js_kernel/watcher` itself, reached the way the CAMERA reaches it — by naming the
//     unit in BOT_ID before the require. That is what makes this an identical implementation rather
//     than a similar one: the append-only writer, the write-through index that only advances on a
//     reported success, the sync flush for process exit, the self-fault channel that cannot recurse,
//     and the run-start sweep that clears `watcher_*.jsonl` are all inherited, not re-implemented.
//     A second copy of that discipline would be a second thing to keep correct, and the copy is always
//     the one that misses the next fix.
//   · THE GRAMMAR is `custom_api/crew_log` — `VERB subject key=value`, emitted and parsed by one file
//     so both ends of the interface move together. Nothing in it is about combat; it is the fleet's
//     form for "a machine-readable fact stated inside a human-readable trace".
//   · THE READER is a lens behind a `trace_monitor` flag, the same shape as `--camera` and `--witness`.
//
// ── THE ONE THING THIS FILE ADDS: A LOSSLESS TEXT FIELD ───────────────────────────────────────────
// `crew_log` guarantees its own form by replacing whitespace inside a value with `_`, because a space
// would split one event into two garbage tokens. That guarantee is right and must not be weakened —
// but it is LOSSY, and what this record exists to preserve is a person's sentence exactly as typed.
// `request 20 oak logs` and `request 20 oak_logs` are different sentences that matter differently here:
// the second is the refusal case the whole list-not-matcher ruling turns on, and a record that
// collapsed them would erase the distinction it was built to show.
//
// So text crosses percent-encoded. `clean()` then has nothing to do — an encoded value contains no
// whitespace by construction, so the emitter still cannot garble a line — and the decode is declared
// HERE, beside the encode, for the same reason crew_log keeps its own parser beside its renderer: two
// ends of one contract in one file, or they drift (Law 26 — both ends of the interface, or neither).
//
// ── WHAT IS RECORDED, AND WHAT IS DELIBERATELY NOT ───────────────────────────────────────────────
// RECORDED: every line addressed to the desk, what the desk made of it, every refusal with its code,
// every line the desk spoke back, everything that crossed the veil, and what the fleet answered.
// Together those replay a person's whole session.
//
// NOT RECORDED: ordinary conversation in the world. The desk stays silent on chat not addressed to it
// (that silence is a tested property), and recording it would put every remark anyone makes near the
// desk into a file — thousands of lines of other people's talk, none of it about the fleet, burying the
// sessions this record exists to hold. What a person says to the desk is the desk's business; what they
// say to each other is not.

const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');

// The stage every desk event is filed under. Read back by the lens off the watcher's own furniture
// (`[FOREMAN_DESK] 📊 …`), so it is the join between the two halves and is spelled once.
const TAG = 'foreman_desk';

// ── THE TEXT CODEC ────────────────────────────────────────────────────────────────────────────────
// encodeURIComponent rather than a hand-rolled escape: it is reversible for every character a chat
// packet can carry, it emits no whitespace, and both halves are standard library — so there is no
// escaping table here to fall out of step with a decoder.
function encodeText(s) { return encodeURIComponent(String(s == null ? '' : s)); }

// NO CATCH HERE, AND THE ONE IT LOST WAS GUARDING A CASE THAT CANNOT REACH IT. The obvious build wraps
// this in a try and hands back the raw token on a bad escape, reasoning that a truncated file is
// environmental. That reasoning is wrong twice. A torn final line is already dropped by the JSONL
// reader before any value reaches here — that is what the .jsonl contract buys — so the damage case is
// handled upstream. What is left is a value this file's own encoder produced, and if THAT will not
// decode, the encoder is broken: a coding violation, which must surface rather than become a mangled
// transcript nobody can tell from a real one (Law 13 — default stopped; Law 16 — a catch that guards
// our own code is deleted, and the defect travels to the crash handler).
function decodeText(s) {
  if (s == null) return '';
  return decodeURIComponent(String(s));
}

// ── THE VERBS ─────────────────────────────────────────────────────────────────────────────────────
// One function per thing worth recording, rather than a general `event(verb, fields)` the call sites
// fill in. The seats own what is worth saying (crew_log's own rule), and naming them here means a
// reader can audit the whole vocabulary of this record in one screen — and the lens cannot be surprised
// by a verb nobody declared.
//
// EVERY EVENT CARRIES `who`. The record is grouped by person and nothing else, so an event that could
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

// A correction fired: nothing crossed. The CODE travels rather than the sentence, because the code is
// the stable name of the refusal and the sentence is free to be reworded — a reader counting how often
// one refusal is met must not be counting a phrasing (Law 26: a machine never keys on prose).
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

// What came back from the fleet. `ok` plus the fleet's own reason, never the desk's rendering of it —
// the sentence the person heard is recorded separately by `said`, and keeping the two apart is what
// lets a reader see the desk translating rather than only its output (Law 25).
function fleet_said(who, ok, reason) {
  crewLog.event(TAG, 'fleet_said', { who, ok: ok ? 'yes' : 'no', reason: reason == null ? null : reason });
  crewLog.flush();
}

// A line the desk spoke to a person. Recorded per line rather than per turn because the help is eight
// lines and a correction is two, and a transcript that merged them would lose the shape of the answer.
function said(who, text) {
  crewLog.event(TAG, 'said', { who, text: encodeText(text) });
  crewLog.flush();
}

// ── THERE IS NO `ignored_origin` EVENT, AND ITS ABSENCE IS THE POINT ─────────────────────────────
// A console impersonation refused by the desk looks like the most valuable thing this record could
// hold, and it cannot be held here because it never happens: the channel subscribes to the PLAYER chat
// packet and never to the console's, so a console line is not filtered at the desk — it never arrives.
// Nothing rejects it, so there is no rejection to record.
//
// Writing the event anyway would be worse than leaving it out. A verb that can never fire reads, to
// anyone auditing this vocabulary, as a filter standing guard — and a reader who finds no such events
// in a run would conclude the desk was never tested rather than that nothing was ever offered. That is
// a false picture of where the safety lives (Law 27: the property is constitutional here, so there is
// no enforcer to report on; Law 25: a record must not imply a check that does not exist).

// ── THE PROSE HALF ────────────────────────────────────────────────────────────────────────────────
// The desk's own window line, kept as prose and NOT as an event. The two registers are deliberate and
// they are the camera's arrangement exactly: a person scrolling the record wants sentences, a lens
// wants fields, and neither is derivable from the other cheaply. This one goes through the watcher so
// it lands in the same file at the same offset ordering — one record, two registers, never two files.
function note(message) {
  watcher.summary('foreman', message);
}

module.exports = {
  TAG,
  heard, read_as, refused, relayed, fleet_said, said, note,
  encodeText, decodeText,
};
