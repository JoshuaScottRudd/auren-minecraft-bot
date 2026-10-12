// Auren_Bot/monitoring/report_formatting.js
// Turns a measurement into the cell a monitoring report prints: the summary statistic every lens
// computes, and the renderers that put it on a line. Pure functions over values — nothing here reads
// a file, a flag, or the clock.
//
// The summary and its rendering live together: every consumer does both in one breath — reduce a sample
// to n/min/max/median, then render it to a fixed width. `stat` exists to produce a formatted cell for
// this layer; it is not a general statistics library.
//
// Named in full — Law 7 admits no abbreviations, and a short name is exactly where a shared utility
// module tempts one.
//
// Centralising formatting here keeps every monitoring tool reading the same measurement to the same
// precision, from the same file.
//
// A formatter renders a value it was given; it never decides what the value means. `stat` returns null
// for an empty set: "no samples" and "measured zero" are different findings and only the caller knows
// which one matters (Law 25). Every renderer below prints an em-dash for an absent value.

'use strict';

// The em-dash is the layer's single symbol for "not measured". It must never be a 0, a blank, or an
// 'n/a' that a later reader mistakes for a value.
const ABSENT = '—';

// ── Numbers ──────────────────────────────────────────────────────────────────
// Keep only real numbers: a null in an average silently becomes a zero and drags the mean down.
const finiteNumbers = xs => xs.filter(x => typeof x === 'number' && Number.isFinite(x));

// n/min/max/med/mean over a sample, or null when there is nothing to describe. Median is the lower
// mid-element of the sorted sample — every consumer here reports values a run actually produced.
function stat(xs) {
  const v = finiteNumbers(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  return {
    n: v.length,
    min: v[0],
    max: v[v.length - 1],
    med: v[Math.floor(v.length / 2)],
    mean: v.reduce((s, x) => s + x, 0) / v.length,
  };
}

// Median alone, for callers that want the one number without the shape.
const median = xs => { const s = stat(xs); return s ? s.med : null; };

const oneDecimal = x => (x == null ? ABSENT : x.toFixed(1));
const twoDecimals = x => (x == null ? ABSENT : x.toFixed(2));
const percent = (x, total) => (!total ? ABSENT : `${Math.round((x / total) * 100)}%`);

// ── Time ─────────────────────────────────────────────────────────────────────
// Seconds → `12m 46s`. This is the trace's own stamp format, and matching it exactly is the point:
// a finding in a lens has to be findable in the trace by eye, without arithmetic.
const relativeTime = sec => `${Math.floor(sec / 60)}m ${sec % 60}s`;

// Milliseconds → the same `12m 46s` shape. Journal `t` is ms since the journal opened, so it reads as
// run-elapsed and lines up with the trace stamps above.
const elapsed = t => (typeof t !== 'number' ? '?' : `${Math.floor(t / 60000)}m ${Math.round((t % 60000) / 1000)}s`);

// Milliseconds → `1.4s`, for durations short enough that minutes are noise.
const secondsFromMillis = v => (v == null ? ABSENT : `${(v / 1000).toFixed(1)}s`);

// ── Tables ───────────────────────────────────────────────────────────────────
// Pad and truncate, so one long cell can never shift a column and turn an aligned table into an
// unreadable one. A monitoring table is scanned; truncation keeps each row exactly one line.
const padRight = (s, n) => String(s == null ? ABSENT : s).padEnd(n).slice(0, n);
const padLeft = (s, n) => String(s == null ? ABSENT : s).padStart(n).slice(0, n);

module.exports = {
  ABSENT, finiteNumbers, stat, median,
  oneDecimal, twoDecimals, percent,
  relativeTime, elapsed, secondsFromMillis,
  padRight, padLeft,
};
