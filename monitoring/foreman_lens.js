// Auren_Bot/monitoring/foreman_lens.js
// THE DESK'S RUN, READ BACK — who spoke to the foreman, what they were told, and what crossed on their word.
//
// ── THE QUESTION THIS ANSWERS, AND WHY NO EXISTING LENS COULD ────────────────────────────────────────
// Every other lens here reads the fleet reasoning about the world. This one reads the fleet's only
// conversation with a party it does not control. The questions are not the fleet's questions: did this
// person get what they asked for, what were they refused and how many times, did they give up, and did
// anything cross into the fleet that should not have. Stretching a fleet lens to answer those would give
// it two verbs (Law 0); the fleet lenses would also be reading a stream they are not meant to see.
//
// ── THE UNIT IS A PERSON'S SESSION, NOT A RUN ───────────────────────────────────────────────────────
// A tally says the desk refused eleven things. It cannot say that ONE person was refused eleven times,
// which is the finding that matters — a person meeting the same refusal repeatedly is the desk failing to
// guide, and that failure is invisible in any aggregate. So the fold groups by speaker and keeps every
// turn in order: the record's whole claim is that a session is RECONSTRUCTABLE, and a reconstruction that
// only reported totals would not be one.
//
// ── THE RECORD IT READS AND THE ONE WAY IT MAY READ IT ─────────────────────────────────────────────
// The desk's own trace in the records room, decoded through `custom_api/crew_log.parseAll` — the SAME module the
// desk emits through — and the verbatim text through `foreman/foreman_record.decodeText`, the same file
// that encoded it. No regex of its own for either: a second copy of a grammar drifts the first time a
// field is added, and a second copy of an escape table drifts sooner (Law 26 — both ends of the
// interface, or neither; Law 16 — one implementation).
//
// The desk's file holds exactly one session because every run start flushes `watcher_*.jsonl` wholesale,
// so there is no run boundary to segment on and inventing one would be this lens deciding something the
// record already answers. (Same reasoning as camera_lens, same reason.)
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --foreman [--bot=PlayerName] [--all]
//           --bot   narrow to one speaker (the flag is the monitor's, and here it names a PERSON)
//           --all   full transcript per person, every line either party said

'use strict';

const path = require('path');

// THE ALIAS MAP IS ASKED OF THE WORKSHOP'S ONE ANSWER (Law 16). It reads the bot's own package.json
// and is idempotent, so it is safe whether or not a caller registered first — which is what the block
// that stood here was hand-rolling with `addAliases` and a comment explaining why
// `require('module-alias')(base)` could not be used. The reason that form is unsafe has not changed and
// is now recorded once, in monitoring/lens_paths.js, instead of in five lenses.
const paths = require('./lens_paths');
paths.registerAliases();
const crewLog = require('@api/crew_log');

const { readForemanView } = require('./trace_read');
const { ABSENT } = require('./report_formatting');
// THE ONE WRITER TO STDOUT (Architect 2026-09-16). `padRight`/`padLeft` left this file with the prose
// they were padding: data_out owns every space and every column width now.
const out = require('./data_out');
// The DECODER FROM THE ENCODER'S OWN FILE. Requiring the desk's module from the monitoring side is the
// dependency running the legal direction — a reader may read the thing it reads; the desk must never
// require a lens (monitoring/README's one-way rule).
const { decodeText, TAG } = require(paths.bot('foreman/foreman_record'));

// The records room, asked of the one module that answers it — never spelled here (Law 16).
const recordHomes = require(paths.bot('js_kernel/utils/record_homes'));
const TRACE_DIR = recordHomes.TRACE_DIR;

// ── READING ──────────────────────────────────────────────────────────────────────────────────────
// deskEvents(lines) → [{ at, verb, fields }]. A line without a readable stamp is SKIPPED rather than
// defaulted: every ordering below is on that clock, and a zero would sort a real turn to the head of the
// session and put words in the wrong person's mouth (Law 13 — never default a missing field).
function deskEvents(lines) {
  const out = [];
  for (const l of lines) {
    if (!l.iso) continue;
    const at = Date.parse(l.iso);
    if (Number.isNaN(at)) continue;
    for (const ev of crewLog.parseAll(l.raw)) {
      if (ev.tag !== TAG) continue;
      out.push({ at, verb: ev.verb, fields: ev.fields });
    }
  }
  return out;
}

function readForemanTrace(dir) {
  return readForemanView(dir || TRACE_DIR);
}

// ── THE FOLD ─────────────────────────────────────────────────────────────────────────────────────
// reduceForeman(lines, { person }) → the structured record, for a machine caller. Rendering lives below
// and takes this as its argument: a machine-facing lens RETURNS and a human-facing one renders, never one
// function doing both (monitoring/README's first rule).
//
// A TURN OPENS ON `heard` AND NOTHING ELSE. Everything the desk does is downstream of somebody speaking,
// so any event arriving before the first `heard` for a person belongs to no turn — it is recorded as
// `orphans` rather than folded into the next one, because attaching it to a turn it did not belong to
// would fabricate a cause-and-effect the record does not contain (Law 25).
function reduceForeman(lines, opts = {}) {
  const events = deskEvents(lines);
  const people = new Map();
  const orphans = [];

  const forPerson = (who) => {
    if (!people.has(who)) {
      people.set(who, { who, turns: [], firstAt: null, lastAt: null, refusals: new Map(), crossings: 0 });
    }
    return people.get(who);
  };

  for (const e of events) {
    const who = e.fields.who;
    if (!who) { orphans.push(e); continue; }
    if (opts.person && who.toLowerCase() !== String(opts.person).toLowerCase()) continue;

    const p = forPerson(who);
    if (p.firstAt === null) p.firstAt = e.at;
    p.lastAt = e.at;

    if (e.verb === 'heard') {
      p.turns.push({
        at: e.at,
        said: decodeText(e.fields.text),
        readAs: null, refusal: null, crossings: [], replies: [],
      });
      continue;
    }

    const turn = p.turns[p.turns.length - 1];
    if (!turn) { orphans.push(e); continue; }

    switch (e.verb) {
      case 'read_as':
        turn.readAs = e.fields.verb;
        break;
      case 'refused':
        turn.refusal = { code: e.fields.code, said: decodeText(e.fields.said) };
        p.refusals.set(e.fields.code, (p.refusals.get(e.fields.code) || 0) + 1);
        break;
      case 'relayed':
        turn.crossings.push({ door: e.fields.door, action: e.fields.action, detail: decodeText(e.fields.detail), answer: null });
        p.crossings += 1;
        break;
      case 'fleet_said': {
        // Attached to the crossing it answers — the LAST one still unanswered, because the desk awaits
        // each door call before making the next. A verdict with no crossing above it is a coding fault in
        // the desk's own wiring rather than something to hide, so it is kept where a reader will see it.
        const open = [...turn.crossings].reverse().find(c => c.answer === null);
        if (open) open.answer = { ok: e.fields.ok === 'yes', reason: e.fields.reason || null };
        // The action token is snake_case because it is PRINTED in the `crossings` table: a three-word
        // phrase in a value cell is the lens narrating again (2026-09-16). The fold is otherwise
        // untouched — same branch, same placement, same fields.
        else turn.crossings.push({ door: ABSENT, action: 'answer_with_no_crossing', detail: '', answer: { ok: e.fields.ok === 'yes', reason: e.fields.reason || null } });
        break;
      }
      case 'said':
        turn.replies.push(decodeText(e.fields.text));
        break;
      default:
        // A verb this lens does not know is REPORTED, never dropped. The desk's vocabulary is declared in
        // one file; a verb arriving here that is not in it means the two have parted company, and a
        // silent skip is how a reader is told a session was complete when it was not (Law 6).
        orphans.push(e);
    }
  }

  return { people: [...people.values()], orphans, eventCount: events.length };
}

// ── RENDERING ────────────────────────────────────────────────────────────────────────────────────
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
const mins = (a, b) => (!a || !b ? ABSENT : `${((b - a) / 60000).toFixed(1)}m`);

// ── OUTPUT IS DATA, NOT PROSE (Architect 2026-09-16) ─────────────────────────────────────────────
// The person's words and the desk's words are VALUES — copied verbatim out of the record into a cell,
// never summarised. The glyph grammar that used to carry them is gone: `«`, `»`, `✂ crossed`,
// `⛔ REFUSED`, `→ fleet: NO ANSWER RECORDED` and `crossed the veil` were this lens narrating a
// conversation it was not part of. What is DELETED rather than given a field name: the `══ FOREMAN DESK`
// banner rules, the `No record — the desk trace holds zero readable lines` sentence, the
// `never spoke to the desk` / `nobody spoke to it` sentences, the `(same refusal code, same speaker,
// more than once)` gloss under repeated refusals, the `belonged to no turn or carried an undeclared
// verb` sentence, and the `--all` pointer. Every COUNT they carried survives as a field below. The
// non-verbose preview of the desk's first reply line is gone with them — `replies` counts the lines and
// `--all` prints them, so no figure was lost, only a sentence fragment.

// One row per turn: the spine of decisions. `said` is the person's own text, copied.
function turnRow(t) {
  return [clock(t.at), t.readAs, t.refusal ? t.refusal.code : ABSENT,
    t.crossings.length, t.replies.length, t.said];
}

function runForeman(opts = {}) {
  const full = !!opts.verbose;
  const lines = readForemanTrace(opts.dir);
  // The header NAMES ITS SOURCE, and asks for it rather than spelling it. The spelled version was false
  // within one edit of being written — it pointed readers at a directory the writer had left, which is
  // the exact failure the records-home module exists to end: one fact, one place, every caller asking
  // (Law 16).
  const source = path.relative(recordHomes.BOT_DIR, recordHomes.traceFile('foreman')).replace(/\\/g, '/');
  out.kv('lens', 'foreman');
  out.kv('record', source);
  if (opts.bot) out.kv('person_filter', opts.bot);

  if (!lines.length) {
    // ABSENCE IS NAMED AS A COUNT, NOT AS A QUIET RUN. The desk writes its first line at startup, so
    // `lines 0` is a desk that never came up, and it is a different field from `speakers 0` below —
    // which is a desk that came up and nobody spoke to (Law 25).
    out.zero('lines');
    return { people: [], orphans: [], eventCount: 0 };
  }
  out.kv('lines', lines.length);

  const folded = reduceForeman(lines, { person: opts.bot });
  out.kv('speakers', folded.people.length);
  out.kv('events', folded.eventCount);
  if (folded.people.length === 0) return folded;

  for (const p of folded.people.sort((a, b) => a.firstAt - b.firstAt)) {
    const refused = [...p.refusals.values()].reduce((n, x) => n + x, 0);
    out.section('speaker');
    out.kv('who', p.who);
    out.kv('turns', p.turns.length);
    out.kv('at_desk', mins(p.firstAt, p.lastAt));
    out.kv('first_at', clock(p.firstAt));
    out.kv('last_at', clock(p.lastAt));
    out.kv('refused', refused);
    out.kv('crossings', p.crossings);

    out.table(['at', 'read_as', 'refusal_code', 'crossings', 'replies', 'said'], p.turns.map(turnRow));

    // The refusal CODE and the desk's refusal text are both the record's own words.
    const refusalRows = p.turns.filter(t => t.refusal)
      .map(t => [clock(t.at), t.refusal.code, t.refusal.said]);
    if (refusalRows.length) {
      out.section('refusals');
      out.table(['at', 'code', 'said'], refusalRows);
    }

    // A crossing with no verdict recorded is `fleet_ok` ABSENT — an unanswered door call, kept visible
    // as a missing value rather than described.
    const crossRows = [];
    for (const t of p.turns) {
      for (const c of t.crossings) {
        crossRows.push([clock(t.at), c.door, c.action, c.detail,
          c.answer ? c.answer.ok : null, c.answer ? c.answer.reason : null]);
      }
    }
    if (crossRows.length) {
      out.section('crossings');
      out.table(['at', 'door', 'action', 'detail', 'fleet_ok', 'fleet_reason'], crossRows);
    }

    // THE FINDING THIS LENS EXISTS FOR, counted per person: one person meeting one refusal repeatedly is
    // invisible in a fleet-wide tally, which is exactly why it is folded per speaker.
    const repeated = [...p.refusals].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    if (repeated.length) {
      out.section('repeated_refusals');
      out.table(['code', 'count'], repeated.map(([c, n]) => [c, n]));
    }

    // The desk's own words are the half a reader needs least often and most urgently — held behind --all
    // so the default stays a spine of decisions, exactly as the fleet lenses hold their detail back.
    if (full) {
      const transcript = [];
      for (const t of p.turns) {
        transcript.push([clock(t.at), p.who, t.said]);
        for (const r of t.replies) transcript.push([clock(t.at), 'foreman', r]);
      }
      out.section('transcript');
      out.table(['at', 'who', 'text'], transcript);
    }
  }

  // Never silently absorbed: an orphan means either the desk emitted before anyone spoke, or it emitted
  // a verb its own vocabulary file does not declare. Both are worth a reader's eye, so the count and the
  // verbs themselves are fields.
  out.section('orphan_events');
  out.kv('orphans', folded.orphans.length);
  if (folded.orphans.length) out.list('verb', [...new Set(folded.orphans.map(o => o.verb))]);
  return folded;
}

module.exports = { runForeman, reduceForeman, deskEvents, readForemanTrace };
