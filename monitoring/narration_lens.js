'use strict';

// ── narration_lens ────────────────────────────────────────────────────────────────────────────────
// A transcript lens: shows what one unit said, in order, unfolded — the other lenses here fold the
// trace into counts. Any unit whose value is its own prose — a director narrating what it framed, a preflight narrating
// what it verified — needs a reader that shows its words (Law 16, this directory's README pairing rule).
//
// The trace segments on the foreman's `start` broadcast, the right window for a bot but not for a unit
// that posts beforehand (a camera director's whole bring-up). Lines outside that window are counted and
// reported on every render, never silently dropped (Law 25).
//
// Machine-facing `reduceNarration` returns; human-facing `runNarration` renders; neither exits — an exit
// here would kill any caller that imports it.

const { afterMarker } = require('./trace_read');
const out = require('./data_out');

const MARK = { error: '❌', warn: '⚠️ ', summary: '📊', infra: '·' };

function stamp(relSec) {
  if (relSec === null || relSec === undefined) return '   —   ';
  const m = Math.floor(relSec / 60), s = relSec % 60;
  return `${String(m).padStart(2, ' ')}m ${String(s).padStart(2, '0')}s`;
}

// Units that posted, so `--narration` with no --bot can list who is available before one is picked.
function unitsIn(lines) {
  const by = new Map();
  for (const l of lines) {
    if (!l.bot) continue;
    const u = by.get(l.bot) || { unit: l.bot, summary: 0, warn: 0, error: 0, total: 0 };
    if (u[l.level] !== undefined) u[l.level]++;
    u.total++;
    by.set(l.bot, u);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

// `infra` lines are the trace's own plumbing (segment markers, forwarding headers), not a unit's own
// words; verbose includes them for a reader who wants the raw stream.
function reduceNarration({ seg, allLines, bot, verbose = false }) {
  const wanted = verbose
    ? new Set(['error', 'warn', 'summary', 'infra'])
    : new Set(['error', 'warn', 'summary']);

  const units = unitsIn(allLines || seg);
  if (!bot) return { unit: null, units, lines: [], inWindow: 0, outsideWindow: 0 };

  const match = l => l.bot === bot && wanted.has(l.level);
  const inWindowLines = seg.filter(match);
  const everywhere = (allLines || seg).filter(match);

  return {
    unit: bot,
    units,
    lines: inWindowLines.map(l => ({
      relSec: l.relSec, level: l.level, text: afterMarker(l.raw), raw: l.raw,
    })),
    inWindow: inWindowLines.length,
    outsideWindow: Math.max(0, everywhere.length - inWindowLines.length),
  };
}

function runNarration({ seg, allLines, bot, traceName, verbose = false, full = false }) {
  const r = reduceNarration({ seg, allLines, bot, verbose });

  // `text` carries the unit's own sentence verbatim; this lens is the envelope, not the author.
  // `lines_outside_window` is the count of lines the window excluded (see header).
  out.kv('lens', 'narration');
  out.kv('record', traceName);
  out.kv('window', full ? 'whole_trace' : 'latest_run');

  if (!r.unit) {
    out.section('units_that_posted');
    out.table(['unit', 'lines', 'summary', 'warn', 'error'],
      r.units.map(u => [u.unit, u.total, u.summary, u.warn, u.error]));
    return r;
  }

  out.kv('unit', r.unit);
  out.kv('lines_in_window', r.inWindow);
  out.kv('lines_outside_window', r.outsideWindow);

  out.section('unit_lines');
  out.table(['at', 'level', 'text'],
    r.lines.map(l => [stamp(l.relSec), MARK[l.level], l.text]));
  return r;
}

module.exports = { reduceNarration, runNarration, unitsIn };
