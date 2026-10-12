// module: bot_minutes
// purpose: EVERY SECOND OF A BODY'S LIFE IS ATTRIBUTED TO EXACTLY ONE SPAN, and this module is the
//   only place that arithmetic happens.
//
// ── DISPATCH-TO-DISPATCH, NOT DISPATCH-TO-JUDGE, AND THE REASON IS COVERAGE ──────────────────────────
//   A judge verdict is not reached on every ending — a job can be superseded by a replan, abandoned when
//   the body goes idle, or left open when the run stops. A ledger that closes on the NEXT state change
//   has no ending to miss, because there is always a next state change or an end of life.
//
//   So there is ONE open span at all times, and opening the next is what closes the last. `worked +
//   idle + startup == life` is therefore true BY CONSTRUCTION, and every line prints the residual so a
//   reader never has to take that on trust (Law 26 — read what the machine decided). A non-zero residual
//   is a defect in this file and says so in its own output.
//
// ── THE THREE SPANS ARE THE WHOLE LIST (Law 29) ──────────────────────────────────────────────────────
//   startup — from the planning loop opening to the body's first dispatch or first idle pass. Connecting,
//             loading the plan, arriving, the first board read.
//   working — a job is held. Labelled with the job token, so a per-task figure is the span's own length.
//   idle    — no job is held. Opened by the dispatcher's idle exit, closed by the next dispatch.
//   A body is in exactly one of them from `open()` to `close()`. There is no fourth.
//
// ── ONE LINE, ONE LOCATION ───────────────────────────────────────────────────────────────────────────
//   A line is emitted when a span CLOSES, never while one is open — so the idle exit, which runs about
//   once a second for as long as parking lasts, produces one line per idle PHASE and not per pass
//   (`idle()` is idempotent for exactly that reason). Two lines per job is the steady state, which is
//   the same order as the claim line already beside it.
//
//   The line's field set is fixed and flat so the lens reduces it without parsing prose (Law 6). Nothing
//   here authors a sentence about whether a number is good — that is the reader's, and a lens may not
//   do it either.

'use strict';

const TAG = 'bot_minutes';

// The one open span. `null` before open() and after close() — a ledger that was never opened records
// nothing.
let _span = null;         // { kind, label, atMs, walkMs }
let _openedAtMs = null;   // the body's life begins here
let _closedAtMs = null;
// Totals in milliseconds. Kept as ms and divided only at the print, so a run of short spans does not
// accumulate rounding into the residual the line exists to prove is zero.
const _total = { startup: 0, working: 0, idle: 0 };
let _jobs = 0;
// Per-token working time: how many bot minutes a given task takes, not derivable from a fleet total.
const _byToken = new Map();
// Walking done while a job was held, in milliseconds — the part of `working` spent getting to the work.
let _walkMs = 0;

const KINDS = Object.freeze(['startup', 'working', 'idle']);

function _now() { return Date.now(); }

function _fmt(ms) { return `${(ms / 1000).toFixed(1)}s`; }

// Close the open span into the totals and return what it was. The ONE place a span's length is
// computed — a second subtraction anywhere else is how two readers of one ledger start disagreeing.
function _closeSpan(atMs) {
    if (!_span) return null;
    const heldMs = Math.max(0, atMs - _span.atMs);
    _total[_span.kind] += heldMs;
    if (_span.kind === 'working' && _span.label) {
        const row = _byToken.get(_span.label) || { ms: 0, spans: 0 };
        row.ms += heldMs; row.spans++;
        _byToken.set(_span.label, row);
    }
    const closed = { kind: _span.kind, label: _span.label, heldMs, walkMs: _span.walkMs || 0 };
    _span = null;
    return closed;
}

// THE RESIDUAL IS THE PROOF. life is measured from the clock; the three totals are accumulated from the
// spans. They are the same quantity reached two different ways, so their difference is an audit of this
// module and nothing else. Printed on every line, so a hole opening halfway through a run is visible
// immediately.
function _residualMs(atMs) {
    if (_openedAtMs == null) return 0;
    const life = (_closedAtMs ?? atMs) - _openedAtMs;
    const open = _span ? Math.max(0, atMs - _span.atMs) : 0;
    return life - (_total.startup + _total.working + _total.idle + open);
}

function _emit(closed, atMs) {
    const watcher = require('@kernel/watcher');
    const life = (_closedAtMs ?? atMs) - _openedAtMs;
    const label = closed.label ? ` job=${closed.label}` : '';
    watcher.summary(TAG,
        `span=${closed.kind}${label} held=${_fmt(closed.heldMs)}`
        + ` | life=${_fmt(life)} startup=${_fmt(_total.startup)} worked=${_fmt(_total.working)}`
        + ` idle=${_fmt(_total.idle)} unaccounted=${_fmt(_residualMs(atMs))}`
        + ` | jobs=${_jobs}`);
}

// One line per finished job: how its time split between walking and working. The limit is judged once,
// at the end of the run, over every job of every body (the foreman's verdict, off each body's clock).
function _emitWalkShare(closed) {
    const watcher = require('@kernel/watcher');
    const { walkShare, WALK_LIMIT_PCT } = require('@utils/calculators/walk_share_calculator');
    const s = walkShare(closed.walkMs, closed.heldMs);
    const line = `walk_share job=${closed.label} held=${_fmt(closed.heldMs)} walk=${_fmt(s.walk_ms)} work=${_fmt(s.work_ms)}`
        + ` walk_pct=${s.walk_pct === null ? 'none' : s.walk_pct} limit_pct=${WALK_LIMIT_PCT} over=${s.over ? 1 : 0}`
        + ` work_owed=${_fmt(s.work_owed_ms)}`;
    watcher.summary('walk_share', line);
}

// The body's running clock, written to its chair so the foreman reads the fleet's walking from the
// bodies themselves while the fleet is up.
function _publishClock() {
    const link = require('@kernel/foreman_link');
    const botId = link.getBotId();
    if (!botId) return;
    const hq = require('@kernel/corporate_headquarters');
    const chair = hq.readBoardroomChair(botId, {}) || {};
    chair.work_clock = { working_ms: _total.working, walk_ms: _walkMs, updated_at: _now() };
    hq.writeBoardroomChair(botId, chair);
    link.sendUpdate();
}

// walked — a walk has ended. Charged to the open job when the walk was started for that same job; a walk
// made while idle or starting up belongs to no job and is left out.
function walked(ms, category) {
    if (!_span || _span.kind !== 'working' || _span.label !== category || !(ms > 0)) return;
    const inSpan = Math.min(ms, Math.max(0, _now() - _span.atMs));
    _span.walkMs = (_span.walkMs || 0) + inSpan;
    _walkMs += inSpan;
}

// open — the body's life starts counting. Called once, from the one place that starts the planning
// loop. Opening twice would restart the clock mid-run and silently discard everything before it, so a
// second call is a coding violation (Law 13).
function open() {
    if (_openedAtMs != null) {
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): open() called twice — the ledger's origin `
            + `may be set once per body. A second origin discards every span before it and makes the `
            + `residual meaningless. Fix the caller that opened it again.`);
    }
    _openedAtMs = _now();
    _span = { kind: 'startup', label: null, atMs: _openedAtMs };
}

// dispatch — a job has been claimed. Closes whatever was open and starts this job's span.
function dispatch(token) {
    if (_openedAtMs == null) return;          // never opened — record nothing
    const at = _now();
    const closed = _closeSpan(at);
    _span = { kind: 'working', label: token || 'unnamed', atMs: at };
    // EMIT BEFORE THE COUNTER MOVES, so `jobs` on a line means jobs finished as of this line, not jobs
    // finished plus the one that just started. A count that includes an event the line is not about
    // cannot be summed against anything.
    if (closed) _emit(closed, at);
    if (closed && closed.kind === 'working') { _emitWalkShare(closed); _publishClock(); }
    _jobs++;
}

// idle — the body has no job. IDEMPOTENT: the dispatcher's idle exit runs about once a second while
// parking lasts, and an idle phase is ONE span, not sixty. Re-entering idle while already idle is the
// normal case and must be free.
//
// ── THE CAUSE IS CARRIED, BECAUSE "IDLE" ALONE IS NOT AN ANSWER ──────────────
// The cause is computed one frame up: `dispatcher._goIdle` decides a `cause` on every idle pass and
// hands it to `idle_park`. A body idle because the board is EMPTY and a body idle because every job is
// HELD AT THE GATES are opposite findings — the first says the fleet has run out of work, the second
// says the work exists and something upstream is blocking it. So the cause rides the span and the lens
// groups by it; nothing new is derived here (Invariant D — the dispatcher owns that decision).
//
// A CHANGE OF CAUSE IS A NEW SPAN, not a relabel. A body that idles for four minutes waiting at the
// gates and then two more with an empty board spent its time on two different problems, and folding them
// into one six-minute span would report a cause that was true for a third of it.
function idle(cause) {
    const why = cause || 'unstated';
    if (_openedAtMs == null) return;
    if (_span?.kind === 'idle' && _span.label === why) return;
    const at = _now();
    const closed = _closeSpan(at);
    _span = { kind: 'idle', label: why, atMs: at };
    if (closed) _emit(closed, at);
    if (closed && closed.kind === 'working') { _emitWalkShare(closed); _publishClock(); }
}

// close — the body is stopping. Closes the last span so the tail has an owner. Idempotent: a second
// stop has nothing left to close.
function close(reason) {
    if (_openedAtMs == null || _closedAtMs != null) return;
    const at = _now();
    const closed = _closeSpan(at);
    _closedAtMs = at;
    if (closed) _emit(closed, at);
    if (closed && closed.kind === 'working') _emitWalkShare(closed);
    const watcher = require('@kernel/watcher');
    const life = _closedAtMs - _openedAtMs;
    const byToken = [..._byToken.entries()]
        .sort((a, b) => b[1].ms - a[1].ms)
        .map(([t, r]) => `${t} ${_fmt(r.ms)}/${r.spans}`)
        .join(' · ');
    watcher.summary(TAG,
        `span=final reason=${reason || 'stopped'} life=${_fmt(life)}`
        + ` startup=${_fmt(_total.startup)} worked=${_fmt(_total.working)} idle=${_fmt(_total.idle)}`
        + ` unaccounted=${_fmt(_residualMs(at))} | jobs=${_jobs}`
        + (byToken ? ` | by_token ${byToken}` : ''));
}

// snapshot — the live totals, for a caller that needs the numbers directly. The fleet is UP when this
// is asked, so this is the owner answering directly, never a record being re-read.
function snapshot() {
    const at = _now();
    return {
        opened_at_ms: _openedAtMs,
        closed_at_ms: _closedAtMs,
        life_ms: _openedAtMs == null ? 0 : (_closedAtMs ?? at) - _openedAtMs,
        startup_ms: _total.startup,
        working_ms: _total.working,
        idle_ms: _total.idle,
        walk_ms: _walkMs,
        open_span: _span ? { kind: _span.kind, label: _span.label, at_ms: _span.atMs, held_ms: at - _span.atMs, walk_ms: _span.walkMs || 0 } : null,
        unaccounted_ms: _residualMs(at),
        jobs: _jobs,
        by_token: Object.fromEntries([..._byToken].map(([t, r]) => [t, { ms: r.ms, spans: r.spans }])),
    };
}

module.exports = { open, dispatch, idle, close, walked, snapshot, KINDS, TAG };
