// module: activity_log
// purpose: one fact line where a notable stretch of a body's work begins and one where it ends, and the one reader
//          both consumers share: the camera rig's scout seat picks its subject from it while the run is live, and the
//          activities lens lists every span with its exact seconds after the run. Emitting, parsing and the rules for
//          when a span is open live in this one file, so the live camera and the lens cannot disagree (Law 10, Law 16).
//
// contract:
//  - start(kind, { subject, at }) posts `[ACTIVITY] 📊 start <subject> kind=<kind> at=x,y,z`.
//  - end(kind, { subject, why }) posts `[ACTIVITY] 📊 end <subject> kind=<kind> why=<token>` for a span this body
//    opened; an end with no subject closes every open span of that kind.
//  - parse(raw) → [{ verb, kind, subject, at, why }] for an ACTIVITY line, [] for anything else.
//  - createBoard() folds a body's trace lines into spans: { bot, kind, subject, at, start, end, ended, why }.
//
// A line states what a body is doing and where. It never says how worth watching that is: the rank belongs to the
// camera (camera/scout_focus.js) and the judging of footage to the Cutting Room, so nothing in the mind performs for
// an audience (the North Star). The grammar is crew_log's (`verb subject key=value`), parsed by crew_log.parseAll.
//
// A span the body never closed (a fault mid-trip, a death, a kill) is closed by the board, and says how: `line` (its
// end line), `next_job` (the body's next dispatcher claim), `restarted` (the same kind and subject opened again),
// `timeout` (open past its kind's maxSec) or `trace_end`. A reader can tell a measured end from an inferred one
// (Law 25).

'use strict';

const crewLog = require('./crew_log');

const TAG = 'activity';

// The kinds a body reports, each with the words the scout's focus page shows and the longest a span of it can run
// before the board closes it as `timeout`. Order here is only the page's order; the scout's rank is the operator's.
const KINDS = Object.freeze({
  fight:        { label: 'A fight (the body against a mob)', maxSec: 180 },
  squid_hunt:   { label: 'Squid hunting: diving for ink', maxSec: 900 },
  herding:      { label: 'Herding animals to the pen', maxSec: 900 },
  pen_crossing: { label: 'Animals going in through the pen gate', maxSec: 240 },
  shepherd:     { label: 'A shepherd holding the flock for a peer', maxSec: 600 },
  shearing:     { label: 'Shearing the flock', maxSec: 600 },
  culling:      { label: 'Culling the meat pen', maxSec: 600 },
});

// The dispatcher's claim of a new job (Thinking_fragments/dispatcher.js), the same shape monitoring/trace_read's
// STORY_CLAIMED reads. Group 1 is the whole claim, group 2 the manager. A new claim ends whatever the body was doing.
const CLAIM_RE = /\[DISPATCHER\].*Claimed (.+?) — dispatching to (\w+)/;

// This body's open spans, `kind|subject`, so an end is written once and only for a span that began.
const _open = new Set();

const cell = p => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;

function known(kind) {
  if (!KINDS[kind]) throw new Error(`[ACTIVITY] CODING VIOLATION: no activity kind '${kind}'. Kinds: ${Object.keys(KINDS).join(', ')}.`);
}

// start(kind, { subject, at }): `subject` is `name#id` (crew_log.subject), `at` a position. Both optional.
function start(kind, { subject = null, at = null } = {}) {
  known(kind);
  _open.add(`${kind}|${subject || ''}`);
  crewLog.post(TAG, 'start', { subject, kind, at: at ? cell(at) : null });
}

// end(kind, { subject, why }): closes this body's span of `kind` (with `subject`, or every one when none is named).
function end(kind, { subject = null, why = null } = {}) {
  known(kind);
  const keys = [..._open].filter(k => subject ? k === `${kind}|${subject}` : k.startsWith(`${kind}|`));
  if (!keys.length) return;
  for (const k of keys) _open.delete(k);
  crewLog.post(TAG, 'end', { subject, kind, why });
}

// parse(raw) → the ACTIVITY events on one rendered trace line.
function parse(raw) {
  if (typeof raw !== 'string' || !raw.includes('[ACTIVITY]')) return [];
  return crewLog.parseAll(raw)
    .filter(e => e.tag === TAG && (e.verb === 'start' || e.verb === 'end') && KINDS[e.fields.kind])
    .map(e => {
      const p = e.fields.at ? e.fields.at.split(',').map(Number) : null;
      return {
        verb: e.verb, kind: e.fields.kind,
        subject: e.subject ? `${e.subject.name}#${e.subject.id}` : null,
        at: p && p.length === 3 && p.every(Number.isFinite) ? { x: p[0], y: p[1], z: p[2] } : null,
        why: e.fields.why || null,
      };
    });
}

// createBoard() → { feed(bot, raw, tMs) → spans opened or closed, expire(tMs), finish(tMs), open(), closed() }.
// `tMs` is the line's own time: the rig passes the time it read the line, the lens the line's stamp.
function createBoard() {
  const open = new Map();
  const closed = [];
  const close = (s, how, t) => { s.end = t; s.ended = how; open.delete(s.key); closed.push(s); return s; };
  return {
    feed(bot, raw, t) {
      const changed = [];
      if (CLAIM_RE.test(raw)) {
        for (const s of [...open.values()]) if (s.bot === bot) changed.push(close(s, 'next_job', t));
        return changed;
      }
      for (const e of parse(raw)) {
        if (e.verb === 'start') {
          const key = `${bot}|${e.kind}|${e.subject || ''}`;
          if (open.has(key)) changed.push(close(open.get(key), 'restarted', t));
          const s = { key, bot, kind: e.kind, subject: e.subject, at: e.at, start: t, end: null, ended: null, why: null };
          open.set(key, s);
          changed.push(s);
          continue;
        }
        for (const s of [...open.values()]) {
          if (s.bot !== bot || s.kind !== e.kind || (e.subject && s.subject !== e.subject)) continue;
          s.why = e.why;
          changed.push(close(s, 'line', t));
        }
      }
      return changed;
    },
    expire(t) {
      const gone = [];
      for (const s of [...open.values()]) if (t - s.start > KINDS[s.kind].maxSec * 1000) gone.push(close(s, 'timeout', t));
      return gone;
    },
    finish(t) { for (const s of [...open.values()]) close(s, 'trace_end', t); },
    open: () => [...open.values()],
    closed: () => closed,
  };
}

module.exports = { KINDS, CLAIM_RE, start, end, parse, createBoard };
