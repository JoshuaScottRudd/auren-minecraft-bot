'use strict';

// ── narration_lens ────────────────────────────────────────────────────────────────────────────────
// WHAT A SINGLE UNIT SAID, IN ORDER. The plainest possible lens over the trace, and it exists because
// every other lens is a fold and none of them is a transcript.
//
// WHY IT WAS MISSING FOR SO LONG, AND WHY THAT IS THE INTERESTING PART. Every lens here answers a
// question ABOUT the run — which jobs ran (--jobs), what a fight cost (--combat), where the items went
// (--inventory). Each of those is a reduction, and a reduction throws away everything it does not
// measure. So a unit whose value IS its prose — a director narrating what it framed and why, a preflight
// narrating what it verified — had no door at all: the merged view could COUNT its lines and nothing
// could SHOW them. That gap is not specific to any one unit; it opens for every non-bot unit that will
// ever post to this trace, which is why the fix is a lens rather than a flag on some other lens.
//
// THE RULE IT SERVES: if the monitor cannot answer the question, the monitor is what changes — a reader
// built beside the record would be the raw-record habit wearing a CLI (Law 16, and the pairing rule in
// this directory's README). Reading a watcher file by hand to recover a unit's own words is exactly the
// act this door removes.
//
// THE WINDOW IS REPORTED, NEVER SILENTLY APPLIED. The trace is segmented on the overseer's `start`
// broadcast, which is the right window for a bot (a bot has nothing to say before it is told to think)
// and the WRONG one for anything that comes up beforehand — a camera director publishes its whole
// bring-up before `start` is ever sent, so the latest segment would show none of it and would look
// complete while doing so. So this counts what falls outside the window and says so on every render.
// A lens that quietly shows a subset is a Law 25 failure wearing a clean exit.
//
// Machine-facing `reduceNarration` returns; human-facing `runNarration` renders; neither exits (a lens
// that exited would kill any caller that imports it).

const { afterMarker } = require('./trace_read');

const MARK = { error: '❌', warn: '⚠️ ', summary: '📊', infra: '·' };

function stamp(relSec) {
  if (relSec === null || relSec === undefined) return '   —   ';
  const m = Math.floor(relSec / 60), s = relSec % 60;
  return `${String(m).padStart(2, ' ')}m ${String(s).padStart(2, '0')}s`;
}

// The roster of units that actually posted, so `--narration` with no --bot answers "who is there" rather
// than dumping every unit's transcript at once. Naming what can be asked for beats guessing which unit
// the reader meant.
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

// LEVELS, NOT EVERY LINE. `infra` is the trace's own plumbing (segment markers, forwarding headers), not
// anything a unit chose to say, so including it would bury the narration in the transport that carried
// it. --all is the escape hatch for a reader who wants the raw stream.
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
  const window = full ? 'whole trace' : 'latest run';

  if (!r.unit) {
    console.log(`trace_monitor · narration · ${traceName} · ${window}`);
    console.log('(pick a unit with --bot=<name>; these posted)\n');
    for (const u of r.units) {
      console.log(`  ${u.unit.padEnd(16)} ${String(u.total).padStart(5)} line(s)  ` +
        `📊 ${u.summary} · ⚠️ ${u.warn} · ❌ ${u.error}`);
    }
    console.log('\n  --all includes the trace\'s own infra lines; --full reads past the last `start` broadcast.');
    return r;
  }

  console.log(`trace_monitor · narration · ${traceName} · ${r.unit} · ${window} · ${r.inWindow} line(s)`);
  console.log('(context only — this view never flags and never wakes a watcher)\n');

  if (!r.lines.length) {
    console.log(`  ${r.unit} posted nothing in the ${window}.`);
  } else {
    for (const l of r.lines) console.log(`  [${stamp(l.relSec)}] ${MARK[l.level]} ${l.text}`);
  }

  // The whole reason this lens states its window: a unit that came up before the run started has its
  // bring-up in an earlier segment, and a reader who does not know that reads an empty view as silence.
  if (r.outsideWindow > 0) {
    console.log(`\n  ${r.outsideWindow} more line(s) from ${r.unit} sit outside the ${window} — ` +
      `everything it said before the last \`start\` broadcast. Add --full to include them.`);
  }
  return r;
}

module.exports = { reduceNarration, runNarration, unitsIn };
