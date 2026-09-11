// Auren_Bot/monitoring/report_formatting.js
// Turns a measurement into the cell a monitoring report prints: the summary statistic every lens
// computes, and the renderers that put it on a line. Pure functions over values — nothing here reads
// a file, a flag, or the clock.
//
// ── WHY THE SUMMARY AND THE RENDERING LIVE TOGETHER ──────────────────────────────────────────────
// Every consumer does the pair in one breath — reduce a sample to n/min/max/median, then render it to
// a fixed width. Splitting them would put two halves of one act in two files and buy nothing, since
// neither half has a consumer that wants only the other. `stat` is here because a formatted cell is
// what a statistic is FOR in this layer; it is not a general statistics library and must not become one.
//
// ── ON THE NAME ───────────────────────────────────────────────────────────────────────────────────
// Not `fmt.js`: Law 7 admits no abbreviations, and a short name is exactly where a shared utility
// module tempts one — `fmt` tells a cold reader nothing about what the file does.
//
// ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────────────────────
// Formatting is the least interesting code in this layer and the easiest to silently duplicate — each
// monitoring tool tends to grow its own copy of the same handful of formatters. That is the failure
// this file exists to stop: two tools rendering the same measurement to different precision makes two
// reports disagree about a number they both read from the same file.
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────────────────────────────
// A formatter renders a value it was given; it never decides what the value MEANS. `stat` returns null
// for an empty set rather than zero, because "no samples" and "measured zero" are different findings
// and only the caller knows which one matters — a formatter that returned 0 here would be inventing a
// measurement (Law 25). Every renderer below prints an em-dash for absent rather than a number.

'use strict';

// The em-dash is the layer's single symbol for "not measured". It must never be a 0, a blank, or an
// 'n/a' that a later reader mistakes for a value.
const ABSENT = '—';

// ── Numbers ──────────────────────────────────────────────────────────────────
// Keep only real numbers. Journals and traces carry nulls for fields a row could not fill, and a null
// in an average silently becomes a zero and drags the mean down — the failure this exists to stop.
const finiteNumbers = xs => xs.filter(x => typeof x === 'number' && Number.isFinite(x));

// n/min/max/med/mean over a sample, or null when there is nothing to describe. Median by the lower
// mid-element rather than an interpolated mid-pair: every consumer here reports observed values, and
// an interpolated median is a number no run actually produced.
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
// run-elapsed and lines up with the trace stamps above — which is the whole reason both exist.
const elapsed = t => (typeof t !== 'number' ? '?' : `${Math.floor(t / 60000)}m ${Math.round((t % 60000) / 1000)}s`);

// Milliseconds → `1.4s`, for durations short enough that minutes are noise.
const secondsFromMillis = v => (v == null ? ABSENT : `${(v / 1000).toFixed(1)}s`);

// ── Tables ───────────────────────────────────────────────────────────────────
// Pad AND truncate, so one long cell can never shift a column and turn an aligned table into an
// unreadable one. Truncation is deliberate: a monitoring table is scanned, and a wrapped row is worse
// than a clipped one.
const padRight = (s, n) => String(s == null ? ABSENT : s).padEnd(n).slice(0, n);
const padLeft = (s, n) => String(s == null ? ABSENT : s).padStart(n).slice(0, n);

module.exports = {
  ABSENT, finiteNumbers, stat, median,
  oneDecimal, twoDecimals, percent,
  relativeTime, elapsed, secondsFromMillis,
  padRight, padLeft,
};
