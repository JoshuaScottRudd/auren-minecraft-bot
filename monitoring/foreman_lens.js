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
const { padRight, padLeft, ABSENT } = require('./report_formatting');
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
        else turn.crossings.push({ door: ABSENT, action: 'answer with no crossing', detail: '', answer: { ok: e.fields.ok === 'yes', reason: e.fields.reason || null } });
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

function renderTurn(t, full) {
  const out = [];
  out.push(`    ${clock(t.at)}  « ${t.said}`);
  if (t.readAs) out.push(`              read as: ${t.readAs}`);
  if (t.refusal) out.push(`              ⛔ REFUSED [${t.refusal.code}]`);
  for (const c of t.crossings) {
    const a = c.answer
      ? (c.answer.ok ? `→ fleet: ok${c.answer.reason ? ` (${c.answer.reason})` : ''}`
                     : `→ fleet: NO${c.answer.reason ? ` (${c.answer.reason})` : ''}`)
      : '→ fleet: NO ANSWER RECORDED';
    out.push(`              ✂ crossed [${c.door}] ${c.action}${c.detail ? ` ${c.detail}` : ''} ${a}`);
  }
  // The desk's own words are the half a reader needs least often and most urgently — held behind --all
  // so the default stays a spine of decisions, exactly as the fleet lenses hold their detail back.
  if (full) for (const r of t.replies) out.push(`              » ${r}`);
  else if (t.replies.length) out.push(`              » ${t.replies.length} line(s) back${t.replies[0] ? `: ${t.replies[0].slice(0, 88)}` : ''}`);
  return out;
}

function runForeman(opts = {}) {
  const full = !!opts.verbose;
  const lines = readForemanTrace(opts.dir);
  // The banner NAMES ITS SOURCE, and asks for it rather than spelling it. The spelled version was false
  // within one edit of being written — it pointed readers at a directory the writer had left, which is
  // the exact failure the records-home module exists to end: one fact, one place, every caller asking
  // (Law 16).
  const source = path.relative(recordHomes.BOT_DIR, recordHomes.traceFile('foreman')).replace(/\\/g, '/');
  console.log(`\n══ FOREMAN DESK — ${source}${opts.bot ? ` · ${opts.bot}` : ''} ══`);

  if (!lines.length) {
    // ABSENCE IS NAMED, NOT REPORTED AS A QUIET RUN. The desk writes its first line at startup, so an
    // empty file is a desk that never came up — a different fact from a desk nobody spoke to, and the
    // one a reader would otherwise misread as "no visitors" (Law 25).
    console.log('  No record. The desk writes from its first line, so this is a foreman that never started —');
    console.log('  not a quiet one. Check the foreman window, or that a run start has not just cleared it.\n');
    return { people: [], orphans: [], eventCount: 0 };
  }

  const out = reduceForeman(lines, { person: opts.bot });
  if (out.people.length === 0) {
    console.log(opts.bot
      ? `  ${opts.bot} never spoke to the desk in this run.\n`
      : '  The desk ran and nobody spoke to it.\n');
    return out;
  }

  for (const p of out.people.sort((a, b) => a.firstAt - b.firstAt)) {
    const refused = [...p.refusals.values()].reduce((n, x) => n + x, 0);
    console.log(`\n  ${padRight(p.who, 18)} ${padLeft(p.turns.length, 3)} turn(s) · ${mins(p.firstAt, p.lastAt)} at the desk · `
      + `${refused} refused · ${p.crossings} crossed the veil`);
    console.log('  ' + '─'.repeat(96));
    for (const t of p.turns) for (const l of renderTurn(t, full)) console.log(l);

    // THE FINDING THIS LENS EXISTS FOR, stated rather than left for the reader to count. One person
    // meeting one refusal repeatedly is the desk failing to GUIDE — the doctrine's second half — and it
    // is invisible in a fleet-wide tally, which is exactly why it is computed per person.
    const repeated = [...p.refusals].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    if (repeated.length) {
      console.log(`\n    ⚠ repeated refusals: ${repeated.map(([c, n]) => `${c} ×${n}`).join(', ')}`);
      console.log('      A person meeting one refusal more than once was not guided out of it the first time —');
      console.log('      the correction is a guard AND a guide, and this is the half that failed.');
    }
  }

  console.log(`\n  ${out.people.length} speaker(s), ${out.eventCount} recorded event(s).`);
  if (out.orphans.length) {
    // Never silently absorbed: an orphan means either the desk emitted before anyone spoke, or it emitted
    // a verb its own vocabulary file does not declare. Both are worth a reader's eye.
    console.log(`  ⚠ ${out.orphans.length} event(s) belonged to no turn or carried an undeclared verb: `
      + `${[...new Set(out.orphans.map(o => o.verb))].join(', ')}`);
  }
  if (!full) console.log('  (--all for the full transcript of every line either party said.)');
  console.log('');
  return out;
}

module.exports = { runForeman, reduceForeman, deskEvents, readForemanTrace };
