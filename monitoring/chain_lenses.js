// Auren_Bot/monitoring/chain_lenses.js
// The supply-and-consequence chains, each read end to end.
//
// Each reducer here spans three or four owners — job_board posts, a manager routes, an executor works the
// block — and answers one question about it: did the chain close. That is a different verb from
// trace_monitor's own (find what went wrong in a run), and it is the verb all three share. They flag
// nothing, wake nobody, and never touch a signature or the watch policy.
//
// Each lens takes its inputs as arguments, renders, and returns. It never reads process.argv and never
// calls process.exit — a library that exits would kill its caller mid-run. trace_monitor is the CLI; it
// reads the trace once, segments it, and hands the run's lines down.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --compost [--bot=B] [--all]

'use strict';

const { relativeTime } = require('./trace_read');
const out = require('./data_out');

// ── --compost : did the composter chain actually run? ────────────────────────────────────────────
//
// Compost has no job, no claim and no dispatch — it happens inside inventory_swapper's dump, so it leaves
// no trace of its own on the board and cannot be seen in a job tally at all. This reducer says whether the
// chain closed — compostables in, bone meal out — the only way to ask whether the feature worked.
//
// No claim, route, or per-decline verdict can describe it, since the errand is never claimed in the first
// place: the only per-visit facts are the pair that decides everything — FED (the dump got there) and
// HELD (it could not, and the material rode along). A run with high HELD and zero FED is the composter
// missing or permanently locked, which a job-shaped tally could never show.
//
// The precondition leads, ahead of any tally. The composter is voxel [-5,2,1] of headframe ANCHOR 1 (114
// voxels), not anchor 0. Until anchor 1 is built there is no block, the dump holds everything, and the
// whole subsystem is correctly invisible. A run that reports "0 compost activity" is ambiguous between
// the chain being broken and the chain never having been reachable, so this lens states which and never
// lets a silent zero read as a verdict (Law 25). Cross-read with --milestones for when anchor 1 landed.
//
// FED IS NOT PROGRESS; LEVEL IS. Each item has a ~30% chance of raising the composter one level, so a
// visit that fed 12 items for zero levels is normal (compost_executor's own verdict says so). The
// number that means the feature worked is BONE MEAL HARVESTED. Both are reported, never merged.
const CP_X_FED_RE      = /compost_executor: fed (\d+) item\(s\) into the composter(?:, harvested (\d+) bone_meal)?, level (\S+) → (\S+)/;
const CP_X_STOPPED_RE  = /compost_executor: fed .* \(stopped early/;
const CP_X_QUEUE_RE    = /compost_executor: composter \S+ is in use by (\S+)/;
const CP_X_FREED_RE    = /compost_executor: composter \S+ released after (\d+)s in queue/;
// The dump's own line, and the reason the lens reads a file outside the compost chain at all: it is the
// ONLY record that a compostable existed and did not reach the block. Without it a missing composter and
// an empty world produce the same silence.
const CP_D_HELD_RE     = /dumpExcess: holding (\d+) compostable\(s\) — (\S+)/;

function runCompost({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  // Per-bot so a chain that runs on one bot and never on the other is visible as that, not as a fleet
  // average — the same reason --combat splits by bot.
  const bots = new Map();
  const B = (id) => {
    let b = bots.get(id);
    if (!b) {
      b = { declines: { stoppedEarly: 0 },
            fed: 0, harvested: 0, visits: 0,
            held: 0, heldPeak: 0, heldEvents: 0, heldReasons: new Map(), queued: 0, queueWaitSec: 0,
            level: { min: null, max: null, last: null }, firstAt: null, lastAt: null, timeline: [] };
      bots.set(id, b);
    }
    return b;
  };
  let maxRel = 0;

  for (const l of seg) {
    if (l.relSec == null) continue;
    if (botFilter && l.bot !== botFilter) continue;
    maxRel = Math.max(maxRel, l.relSec);
    if (!/compost/i.test(l.raw)) continue;
    let m;
    // AN EVENT IS A TOKEN AND ITS FIELDS, NEVER A COMPOSED PHRASE: the four numbers travel as their own
    // cells, and `reason` below is the DUMP's own word carried through untouched.
    const touch = (b, kind, fields) => {
      if (b.firstAt === null) b.firstAt = l.relSec;
      b.lastAt = l.relSec;
      if (kind) b.timeline.push({ t: l.relSec, kind, ...fields });
    };
    // A level reading is worth carrying from wherever it appears: the fill curve over the run is what
    // says whether feeding outran harvesting or the block sat idle, and no single line owns it.
    const noteLevel = (b, v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      b.level.last = n;
      if (b.level.min === null || n < b.level.min) b.level.min = n;
      if (b.level.max === null || n > b.level.max) b.level.max = n;
    };

    if ((m = l.raw.match(CP_X_FED_RE))) {
      const b = B(l.bot); b.visits++; b.fed += +m[1]; b.harvested += m[2] ? +m[2] : 0;
      noteLevel(b, m[4]);
      if (CP_X_STOPPED_RE.test(l.raw)) b.declines.stoppedEarly++;
      touch(b, 'fed', { fed: +m[1], levelFrom: m[3], levelTo: m[4], boneMeal: m[2] ? +m[2] : 0 });
    } else if ((m = l.raw.match(CP_D_HELD_RE))) {
      // The dump reports the WHOLE held pocket every time, not a delta, so summing across cycles would
      // overcount the same held items repeatedly — a falsehood that looks like runaway accumulation
      // (Law 25). Last and peak, never a sum.
      const b = B(l.bot); b.held = +m[1]; b.heldPeak = Math.max(b.heldPeak, +m[1]); b.heldEvents++;
      b.heldReasons.set(m[2], (b.heldReasons.get(m[2]) || 0) + 1);
      touch(b, 'held', { held: +m[1], reason: m[2] });
    } else if ((m = l.raw.match(CP_X_QUEUE_RE))) {
      const b = B(l.bot); b.queued++; touch(b, 'queued', { behind: m[1] });
    } else if ((m = l.raw.match(CP_X_FREED_RE))) {
      const b = B(l.bot); b.queueWaitSec += +m[1]; touch(b, null);
    }
  }

  // ── OUTPUT IS DATA, NOT PROSE ──────────────────────────────────────────────
  // Field names and values only. Every reason string below is carried VERBATIM out of the bot's own line
  // (`composter_not_built_yet`, `no_composter_in_blueprint`, `composter_lock_lost_to_peer`) — the bot was
  // present for that decision and may name it; this lens was not and may only copy it.
  out.kv('lens', 'compost');
  out.kv('record', traceName);
  out.kv('span', relativeTime(maxRel));
  if (botFilter) out.kv('bot_filter', botFilter);

  const totalHarvest = [...bots.values()].reduce((n, b) => n + b.harvested, 0);
  const totalFed = [...bots.values()].reduce((n, b) => n + b.fed, 0);
  const totalHeld = [...bots.values()].reduce((n, b) => n + b.held, 0);

  out.section('compost_totals');
  out.kv('bots_with_compost_events', bots.size);
  out.kv('items_fed', totalFed);
  out.kv('bone_meal_harvested', totalHarvest);
  out.kv('compostables_held', totalHeld);

  if (!bots.size) return;

  out.section('compost_by_bot');
  out.table(
    ['bot', 'first_at', 'last_at', 'visits', 'fed', 'bone_meal', 'held', 'held_peak', 'held_dumps',
      'queued', 'queue_wait_sec', 'level_last', 'level_min', 'level_max'],
    [...bots].map(([id, b]) => [id, relativeTime(b.firstAt), relativeTime(b.lastAt), b.visits, b.fed,
      b.harvested, b.held, b.heldPeak, b.heldEvents, b.queued, b.queueWaitSec,
      b.level.last, b.level.min, b.level.max]),
  );

  // The held REASON is the field to read on a disappointing run, and it is the bot's own word for why the
  // dump could not place the item. Counted per reason, never merged into one "held" number.
  const heldRows = [];
  for (const [id, b] of bots) for (const [reason, n] of b.heldReasons) heldRows.push([id, reason, n]);
  if (heldRows.length) {
    out.section('compost_held_reasons');
    out.table(['bot', 'reason', 'count'], heldRows);
  }

  const decRows = [];
  for (const [id, b] of bots) {
    for (const [k, n] of Object.entries(b.declines)) if (n > 0) decRows.push([id, k, n]);
  }
  if (decRows.length) {
    out.section('compost_declines');
    out.table(['bot', 'decline', 'count'], decRows);
  }

  if (verbose) {
    const events = [];
    for (const [id, b] of bots) {
      for (const e of b.timeline) {
        events.push([relativeTime(e.t), id, e.kind, e.fed ?? null, e.boneMeal ?? null,
          e.levelFrom ?? null, e.levelTo ?? null, e.held ?? null, e.reason ?? null, e.behind ?? null]);
      }
    }
    out.section('compost_events');
    out.table(['at', 'bot', 'event', 'fed', 'bone_meal', 'level_from', 'level_to', 'held', 'reason', 'queued_behind'], events);
  }
}

// `--combat` owns deaths, reading the combat journal — a death's item cost is not recorded anywhere
// (Law 25: an unowned question is named, not left to be discovered by its absence).

module.exports = { runCompost };
