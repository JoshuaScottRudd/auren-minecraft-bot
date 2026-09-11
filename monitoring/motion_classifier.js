// Auren_Bot/monitoring/motion_classifier.js
// PROTOTYPE (round 62 follow-on). Splits a run's timeline into MOVING and DOING spans, so footage can
// be sorted into "the bot travelled" vs "the bot worked" — the Architect's observation that travel is
// ~half the runtime and is what makes a raw take unwatchable.
//
// WHY TIME, NOT OWNERSHIP — the split the Architect first reached for was by fragment ownership
// (locomotion inside an executor = doing; locomotion outside = moving), and he correctly predicted it
// "won't work" because locomotion lives inside the executors. The trace resolves this: NAVIGATOR and
// LOCOMOTION_DISPATCHER are their OWN tag stream (the two largest in the whole trace), logged WHILE an
// executor owns the job. So the question a video editor actually asks — "is the world changing on
// screen right now, or is the bot just walking?" — is answered by WHICH TAG is emitting at each
// second, not by who called it. A run of NAVIGATOR lines is the bot visibly walking whoever requested
// the walk; a run of INVENTORY_SWAPPER/executor lines is the bot visibly acting.
//
// This is READ-ONLY analysis of the trace (Law 6) and reuses trace_read's parse (Law 16). It emits
// a segment list designed to feed footage_clipper's clip cutting next — this node decides the split,
// the clipper would act on it (the same plan/cut separation footage_clipper already draws).
//
// Usage:
//   node motion_classifier.js [--bot=AurenBot] [--min=8] [--json]
//
// --min is the smallest span (seconds) allowed to stand alone; a shorter blip of one class inside a
// long span of the other is absorbed into its neighbours (a 3s pathing wobble mid-dig is not a
// "moving" clip). --json prints the raw segment list; default prints the human breakdown.

'use strict';

const path = require('path');
const { readTrace, segmentRuns, buildEpisodes, jobToken } = require('./trace_read.js');

const paths = require('./lens_paths');
const KERNEL = paths.bot('js_kernel');

const args = process.argv.slice(2);
const opt = (n, d) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const BOT = opt('bot', 'AurenBot');
const MIN_SEG = +opt('min', 8);
const AS_JSON = args.includes('--json');

// ── Tag → screen action ──────────────────────────────────────────────────────
// MOVE: the bot is traversing the world. DO: a hand/world action is happening (a block changing, an
// item moving, a tree falling). NEUTRAL: bookkeeping and perception with no on-screen action — job
// board posts, integrity scans, the judge, managers. Neutral lines never OWN a second; they inherit
// whatever the bot was last visibly doing, so a burst of 20 integrity lines between two dig segments
// does not read as a third kind of moment. INVENTORY_SWAPPER is DO on the Architect's own call — an
// api a main task dips into still counts as doing.
const MOVE_TAGS = new Set(['NAVIGATOR', 'LOCOMOTION_DISPATCHER', 'LOCOMOTION_JUDGE']);
const DO_RE = /EXECUTOR|PRECONSTRUCTION|DROP_COLLECTOR|SEED_PICKER|TREE_FELLER|CRAFT_HANDLER|INVENTORY_SWAPPER|FARM/;

function classOf(tag) {
  if (MOVE_TAGS.has(tag)) return 'MOVE';
  if (DO_RE.test(tag)) return 'DO';
  return null;   // neutral — no vote
}

function tagOf(raw) {
  const m = raw.match(/\] \[([A-Z_]+)\]/);
  return m ? m[1] : null;
}

// CARVE-OWNER OVERRIDE — the one place ownership beats tag. Mining moves the bot BY digging: the bot
// paths downward THROUGH the rock it is removing, so NAVIGATOR fires densely during an active carve
// while MINING_EXECUTOR logs only a summary per completed segment (observed: 59s carving 28 blocks
// logged as one MINING line + dozens of NAVIGATOR `dig_through`/`PILLAR` lines). Tag alone therefore
// reads active shaft-digging as travel. So inside a mining arc, locomotion is reclassified DO — the
// Architect's "locomotion inside [mining] is doing." Preconstruction (digs the build pad) and
// farming land-prep (tills) are the same case; they are minor in this trace and NOT yet folded in —
// flagged as the identical follow-up rather than guessed at. Supply/delivery/canopy locomotion is
// genuine travel across finished world and stays MOVE.
const CARVE_ARC = /^mine\//;

// ── Second-by-second classification ──────────────────────────────────────────
// One vote per MOVE/DO line into its second's bin; a second's class is its majority vote. Empty
// seconds forward-fill from the last classified second (the bot is still doing whatever it last did
// during the silence between log lines); leading empties backfill from the first. This turns a sparse
// event log into a continuous occupancy of the run.
function classifyTimeline(seg, inCarve) {
  const lines = seg.filter(l => l.relSec != null && (MOVE_TAGS.has(tagOf(l.raw)) || DO_RE.test(tagOf(l.raw) || '')));
  if (!lines.length) return { bins: [], start: 0 };
  // BOUNDS COME FROM `lines`, NEVER FROM `seg`. The bins are indexed by `l.relSec - start` for the lines
  // above, so any bound derived from a different set can be wrong in two ways at once: a segment whose
  // first or last row carries no relSec makes `end - start` NaN and `new Array(NaN)` throws RangeError,
  // and a segment not ordered by relSec sizes the array shorter than the largest index written into it.
  // min/max rather than first/last for the same reason — the order of the rows is not this function's to
  // assume (Law 13: validate the precondition here, where the array is sized, rather than trusting a
  // caller's ordering). The RangeError this replaces killed the whole run report, so a run too short to
  // classify lost its capture entirely instead of reporting an empty timeline.
  const stamps = lines.map(l => l.relSec);
  const start = Math.min(...stamps), end = Math.max(...stamps);
  const move = new Array(end - start + 1).fill(0);
  const doo = new Array(end - start + 1).fill(0);
  for (const l of lines) {
    const i = l.relSec - start;
    // Carve override: a MOVE line inside a mining arc votes DO (the bot is carving, not travelling).
    const cls = classOf(tagOf(l.raw)) === 'MOVE' && !inCarve(l.relSec) ? 'MOVE' : 'DO';
    if (cls === 'MOVE') move[i]++; else doo[i]++;
  }
  const bins = new Array(end - start + 1).fill(null);
  for (let i = 0; i < bins.length; i++) {
    if (move[i] || doo[i]) bins[i] = move[i] >= doo[i] ? 'MOVE' : 'DO';
  }
  // forward-fill then backfill
  let last = null;
  for (let i = 0; i < bins.length; i++) { if (bins[i]) last = bins[i]; else bins[i] = last; }
  const first = bins.find(Boolean);
  for (let i = 0; i < bins.length && !bins[i]; i++) bins[i] = first;
  return { bins, start };
}

// Coalesce equal-class runs, then dissolve any run shorter than MIN_SEG into the longer neighbour and
// re-coalesce. Iterated because absorbing a short island can create a longer run that merges with a
// same-class run on the far side. Islands at the very ends have only one neighbour to fall into.
function segmentsFromBins(bins, start) {
  let segs = [];
  for (let i = 0; i < bins.length; i++) {
    const last = segs[segs.length - 1];
    if (last && last.cls === bins[i]) last.end = start + i;
    else segs.push({ cls: bins[i], begin: start + i, end: start + i });
  }
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const dur = segs[i].end - segs[i].begin + 1;
      if (dur >= MIN_SEG) continue;
      const L = segs[i - 1], R = segs[i + 1];
      const into = !L ? R : !R ? L : (L.end - L.begin) >= (R.end - R.begin) ? L : R;
      into.begin = Math.min(into.begin, segs[i].begin);
      into.end = Math.max(into.end, segs[i].end);
      segs.splice(i, 1);
      changed = true;
      break;
    }
    // re-coalesce any now-adjacent same-class runs
    const merged = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && last.cls === s.cls && s.begin <= last.end + 1) last.end = Math.max(last.end, s.end);
      else merged.push({ ...s });
    }
    if (merged.length !== segs.length) changed = true;
    segs = merged;
  }
  return segs.map(s => ({ cls: s.cls, startSec: s.begin, endSec: s.end + 1, durSec: s.end - s.begin + 1 }));
}

// ── Report ───────────────────────────────────────────────────────────────────
const mmss = s => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;

// How each named arc breaks down, by intersecting the arc's wall-clock span with the MOVE/DO segments.
// This is the payoff view — it turns "travel is ~half the run" from a guess into a per-job number.
// Arc spans in run-relative seconds, so both the carve override and the per-job report speak the same
// clock as the classified bins. relSec of an arc's END is not stored on the episode; derived from the
// wall-clock delta between its start and end ISO.
function arcSpans(seg) {
  const arcs = buildEpisodes(seg).filter(a => a.iso && a.endIso);
  return arcs.map(a => ({
    token: jobToken(a.claimed),
    startSec: a.relSec,
    endSec: a.relSec + (Date.parse(a.endIso) - Date.parse(a.iso)) / 1000,
  }));
}

function arcBreakdown(spans, segments) {
  const rows = [];
  for (const a of spans) {
    const aStart = a.startSec, aEnd = a.endSec;
    if (aEnd - aStart < 20) continue;
    let move = 0, doo = 0;
    for (const s of segments) {
      const lo = Math.max(aStart, s.startSec), hi = Math.min(aEnd, s.endSec);
      if (hi <= lo) continue;
      if (s.cls === 'MOVE') move += hi - lo; else doo += hi - lo;
    }
    if (move + doo < 20) continue;
    rows.push({ token: a.token, aStart, dur: aEnd - aStart, move, doo });
  }
  return rows;
}

// The split for one bot's latest run, as data. Extracted so a consumer (the footage clipper)
// reuses the ONE definition of moving-vs-doing rather than re-deriving it (Law 16). Returns null when
// the run has no MOVE/DO activity, so a caller iterating bots can skip a bot that never ran.
//
// `traceFile` exists because a FILMED run's records are copied beside its footage and the live file is
// overwritten by the next fleet run — so an editing surface asking "where did this take travel" is
// asking about a trace that is no longer the live one. The parameter is the whole of that support: the
// classification is identical, only the file it reads differs, which is why this is one argument rather
// than a second entry point (Law 16).
function computeSplit(bot, minSeg = MIN_SEG, traceFile = null) {
  const seg = segmentRuns(readTrace(traceFile || path.join(KERNEL, `watcher_${bot}.jsonl`))).pop() || [];
  const spans = arcSpans(seg);
  const carve = spans.filter(a => CARVE_ARC.test(a.token));
  const inCarve = sec => carve.some(a => sec >= a.startSec && sec < a.endSec);
  const { bins, start } = classifyTimeline(seg, inCarve);
  if (!bins.length) return null;
  const segments = segmentsFromBins(bins, start);
  const totMove = segments.filter(s => s.cls === 'MOVE').reduce((n, s) => n + s.durSec, 0);
  const totDo = segments.filter(s => s.cls === 'DO').reduce((n, s) => n + s.durSec, 0);
  return { bot, seg, spans, segments, totMove, totDo, durSec: totMove + totDo };
}

function main() {
  const split = computeSplit(BOT);
  if (!split) { console.error(`motion_classifier: no MOVE/DO activity in ${BOT}'s latest run`); process.exit(1); }
  const { spans, segments, totMove, totDo } = split;

  if (AS_JSON) { console.log(JSON.stringify({ bot: BOT, minSeg: MIN_SEG, segments }, null, 2)); return; }

  const tot = totMove + totDo;
  console.log(`motion_classifier · ${BOT} · latest run · min-segment ${MIN_SEG}s`);
  console.log(`  MOVING ${mmss(totMove)} (${(100 * totMove / tot).toFixed(0)}%)  ·  DOING ${mmss(totDo)} (${(100 * totDo / tot).toFixed(0)}%)  ·  ${segments.length} segments\n`);

  console.log('  per-job split (moving vs doing within each arc):');
  for (const r of arcBreakdown(spans, segments)) {
    const mpct = Math.round(100 * r.move / (r.move + r.doo));
    console.log(`    [${mmss(r.aStart)}] ${r.token.padEnd(26).slice(0, 26)} ${mmss(r.dur).padStart(6)}  MOVE ${String(mpct).padStart(3)}% / DO ${100 - mpct}%`);
  }

  console.log('\n  segment list (feeds footage_clipper — cut MOVE→moving/, DO→doing/):');
  for (const s of segments) {
    if (s.durSec < MIN_SEG) continue;
    console.log(`    ${s.cls === 'MOVE' ? '🚶 MOVE' : '⛏️ DO  '} ${mmss(s.startSec)} → ${mmss(s.endSec)}  (${mmss(s.durSec)})`);
  }
}

if (require.main === module) main();

module.exports = { computeSplit };
