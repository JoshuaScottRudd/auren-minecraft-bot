'use strict';
// foreman_record — what the foreman writes down about its run, and the one place its event vocabulary is declared.
//
// The writer is `js_kernel/watcher`, reached by naming the unit in BOT_ID before the require, so the
// append-only writer, its write-through index, its flush and its run-start sweep are inherited whole
// (Law 16, Law 22). The grammar is `custom_api/crew_log` — `VERB subject key=value`,
// emitted and parsed by one file. The reader is `monitoring/foreman_lens`, behind the `trace_monitor` flag.
//
// crew_log guarantees its own form by replacing whitespace inside a value with `_`, which would collapse a
// sentence's spacing. Text here crosses percent-encoded instead, so a line is kept exactly as it was said.
// `encodeText`/`decodeText` are declared together, the same way crew_log keeps its own parser beside its
// renderer (Law 26).
//
// RECORDED: every crew raise the foreman withheld, with its code, and every line it said to the world about
// the run. Together they are the run's beats and the reasons a crew did not stand.

const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');

// The stage every record event is filed under. Read back by the lens off the watcher's own furniture
// (`[FOREMAN_RECORD] 📊 …`), so it is the join between the two halves and is spelled once.
const TAG = 'foreman_record';

// ── the text codec ────────────────────────────────────────────────────────────────────────────────
// encodeURIComponent: reversible for every character a chat packet can carry, emits no whitespace, and
// both halves are standard library, so there is no escaping table here to drift out of step with a
// decoder.
function encodeText(s) { return encodeURIComponent(String(s == null ? '' : s)); }

// No catch here: a torn final line is already dropped by the JSONL reader before any value reaches this
// function, so the only input left is a value this file's own encoder produced. A decode failure on that
// value is a coding violation and must surface as a crash, not a mangled record (Law 13, Law 16).
function decodeText(s) {
  if (s == null) return '';
  return decodeURIComponent(String(s));
}

// ── the verbs ─────────────────────────────────────────────────────────────────────────────────────
// One function per thing worth recording, so a reader audits the whole vocabulary in one screen and the
// lens is never surprised by an undeclared verb.

// A crew raise was withheld. The code travels, not a sentence: the code is the stable name of the refusal,
// so a reader counting how often one refusal is met is never counting a phrasing (Law 26: a machine never
// keys on prose). `detail` is the numbers behind the code.
function refused(code, detail) {
  crewLog.event(TAG, 'refused', { code, detail: encodeText(detail) });
  crewLog.flush();
}

// A line the foreman said to the whole world about the run: a structure finished or a layer released.
// `kind` and its own fields carry the event for a reader that cuts on it (a timelapse switches cameras
// here); `text` is the sentence as it was said.
function announced(kind, fields, text) {
  crewLog.event(TAG, 'announced', { kind, ...fields, text: encodeText(text) });
  crewLog.flush();
}

// ── the prose half ────────────────────────────────────────────────────────────────────────────────
// The foreman's own window line, kept as prose and not as an event: a person scrolling the record wants
// sentences, a lens wants fields, and neither is derivable from the other cheaply. Goes through the
// watcher so it lands in the same file at the same offset ordering — one record, two registers.
function note(message) {
  watcher.summary('foreman', message);
}

module.exports = {
  TAG,
  refused, announced, note,
  encodeText, decodeText,
};
