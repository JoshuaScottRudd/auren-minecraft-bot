/**
 * timeout_crash — THE ONE PLACE A CLOCK MAY SIT IN JUDGEMENT OVER WORK, AND THE ONE REPEATING TIMER.
 *
 * Everything in the fleet is deterministic and reports its own failures, so waiting needs no checking.
 * One fact remains that no party can report about itself: it never came back. This file owns that fact
 * for the whole fleet, at one number.
 *
 *   watch(tag, what, detail?) → { done() }
 *       Opened when a piece of work starts, closed with done() when it ends. LIMIT_MS later with no
 *       done() the work is stuck, and the WHOLE RUN ends: every bot, the foreman and the world, with a
 *       report of what was being waited on, how long, every other watch open at that moment, and the
 *       trail of what happened before it.
 *
 *   crashEverything(tag, what, detail?)
 *       The same end, reached at once, for a state the design makes impossible (an exit token that
 *       matches no entry, a second entry while one is open).
 *
 *   note(tag, text)
 *       One line onto the trail the report prints. The trail is a bounded ring.
 *
 *   every(tag, what, fn, ms) → timer      stop(timer)
 *       The one repeating timer. A repeating timer anywhere else in the construct is refused by
 *       preflight, so each one that exists is named here and is listed in a crash report.
 *
 *   later(tag, what, fn, ms) → timer      stop(timer)
 *       A loop's own next beat (a one-shot the loop re-arms), named and listed the same way.
 *
 *   onCrash(fn)
 *       How this process ends the run. The foreman registers its shutdown road; a bot registers "tell
 *       the foreman, then end this body". Registered once per process.
 *
 * Requires nothing at module scope, so every layer can reach it.
 */
'use strict';

const LIMIT_MS = 30000;
const TRAIL_LIMIT = 60;

const _open = new Map();        // id → { tag, what, detail, at, timer }
const _repeating = new Map();   // timer → { tag, what, ms, since }
const _trail = [];              // { at, tag, text }
let _nextId = 1;
let _crashRoad = null;
let _crashed = false;

const _detailOf = (detail) => (typeof detail === 'function' ? detail() : detail) || '';
const _ago = (at, now) => `${((now - at) / 1000).toFixed(1)} s before`;

function note(tag, text) {
  _trail.push({ at: Date.now(), tag, text });
  if (_trail.length > TRAIL_LIMIT) _trail.shift();
}

function onCrash(fn) {
  if (typeof fn !== 'function') throw new Error('timeout_crash.onCrash() needs a function');
  _crashRoad = fn;
}

function _report(headline, tag, what, detail) {
  const now = Date.now();
  const lines = [headline, `what: [${tag}] ${what}`];
  const d = _detailOf(detail);
  if (d) lines.push(`state: ${d}`);
  lines.push(`process: ${process.env.BOT_ID || 'foreman'} (pid ${process.pid})`);
  lines.push(`other work being waited on (${_open.size}):`);
  for (const w of _open.values()) lines.push(`  [${w.tag}] ${w.what} — open ${((now - w.at) / 1000).toFixed(1)} s`);
  lines.push(`repeating timers running (${_repeating.size}):`);
  for (const r of _repeating.values()) lines.push(`  [${r.tag}] ${r.what} — every ${r.ms} ms`);
  lines.push(`what led up to it (last ${_trail.length}, oldest first):`);
  for (const t of _trail) lines.push(`  ${_ago(t.at, now)}  [${t.tag}] ${t.text}`);
  return lines.join('\n');
}

function _end(report) {
  if (_crashed) return;      // the first cause is the cause; a second one is its consequence
  _crashed = true;
  for (const w of _open.values()) clearTimeout(w.timer);
  _open.clear();
  if (!_crashRoad) throw new Error(`timeout_crash: no crash road registered in this process.\n${report}`);
  _crashRoad(report);
}

function crashEverything(tag, what, detail) {
  _end(_report('IMPOSSIBLE STATE — THE WHOLE RUN IS ENDING.', tag, what, detail));
}

function watch(tag, what, detail) {
  if (!tag || !what) throw new Error('timeout_crash.watch(tag, what) needs both');
  const id = _nextId++;
  const at = Date.now();
  const timer = setTimeout(() => {
    _open.delete(id);
    _end(_report(`STUCK FOR ${LIMIT_MS / 1000} SECONDS — THE WHOLE RUN IS ENDING.`, tag, what, detail));
  }, LIMIT_MS);
  _open.set(id, { tag, what, detail, at, timer });
  note(tag, `began: ${what}`);
  return {
    done() {
      const w = _open.get(id);
      if (!w) return;
      clearTimeout(w.timer);
      _open.delete(id);
      note(tag, `ended after ${Date.now() - at} ms: ${what}`);
    },
  };
}

function every(tag, what, fn, ms) {
  if (!tag || !what || !(ms > 0) || typeof fn !== 'function') throw new Error('timeout_crash.every(tag, what, fn, ms) needs all four');
  const timer = setInterval(fn, ms);
  _repeating.set(timer, { tag, what, ms, since: Date.now() });
  return timer;
}

function stop(timer) {
  if (!timer) return;
  clearInterval(timer);
  clearTimeout(timer);
  _repeating.delete(timer);
}

// later — a loop's own next beat: a one-shot that the loop re-arms itself. Named and listed like a
// repeating timer, because a loop that beats by re-arming is one.
function later(tag, what, fn, ms) {
  if (!tag || !what || !(ms >= 0) || typeof fn !== 'function') throw new Error('timeout_crash.later(tag, what, fn, ms) needs all four');
  const timer = setTimeout(() => { _repeating.delete(timer); fn(); }, ms);
  _repeating.set(timer, { tag, what, ms, since: Date.now() });
  return timer;
}

module.exports = { LIMIT_MS, watch, crashEverything, note, every, later, stop, onCrash };
