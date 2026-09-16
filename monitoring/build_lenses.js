// Auren_Bot/monitoring/build_lenses.js
// WHEN THE BASE GOT ESTABLISHED — the first-occurrence clocks, one per establishment event.
//
// TWO CLOCKS, TWO FLAGS, ONE VERB. `--milestones` (runMilestones) times the build sites; `--torch`
// (runTorchClock, at the foot of this file) times the fleet's first torch. Both answer "when did this
// first happen, and what was it waiting on" and neither passes a verdict it was not handed, which is
// what makes them one file — the same shape locomotion_lenses uses for its three.
//
// Architect 2026-08-05: "log how long it takes for headframe to start building. so completion of
// anchor zero."
//
// WHY A LENS AND NOT A GREP. That question was answerable only by reading the trace by hand and adding
// up timestamps — which is the one thing the standing rule forbids, and for the reason it gives: the
// answer dies with the session and nobody can reproduce it. The number is also about to be quoted
// (a recording run), so it needs an instrument behind it rather than a reading somebody did once.
//
// WHY IT IS NOT A FLAG ON --progress. --progress answers "is anything still advancing" — a rate
// question, tail-windowed, verdict-bearing, and it stays in trace_monitor because that IS the triage
// engine's own question about a run's health. This answers "when did each stage of establishment first
// happen" — a one-shot clock per event, no verdict, and it must report an event that has NOT happened
// as not-happened rather than as zero (Law 25). Merging them would put a stalled-vs-rising judgement on
// a timeline whose whole content is first-occurrence times.
//
// ── WHY IT IS ITS OWN FILE (Architect 2026-08-08) ───────────────────────────────────────────────────
// It left trace_monitor with the other feature lenses. Its verb is not triage: it never flags, never
// wakes, and shares no signature or threshold with the detection engine. The seam is combat_lens's —
// inputs as ARGUMENTS, render, RETURN. It never reads process.argv and never calls process.exit.
//
// THE FOUR EVENTS, and the line each is read from. Every one is a summary line the fleet already
// writes; nothing was added to the construct for this (the record was complete, the reader was not):
//   SITE LOCKED        set_buildspot        — the site exists, so the clock for this structure starts
//   ANCHOR N GATED     job_board            — materials-blocked, with WHAT it is short of. The waiting
//                                             is the answer to "why did it take that long", so the
//                                             shortfall list is carried, not just the count.
//   FIRST PLACEMENT    building_integrity   — the first scan reporting a placed count ABOVE zero. This
//                                             is "started building": the integrity scan is the server's
//                                             reading of the world, not the bot's claim to have placed.
//   ANCHOR N COMPLETE  building_manager     — the anchor released to the next one, which is the only
//                                             line that states an anchor is done rather than implying it.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --milestones [--bot=B] [--deadline=10m] [--all]

'use strict';

const { relativeTime, PASSIVE_LINE } = require('./trace_read');
// Every byte this file puts on stdout goes through data_out: field names and values, no grammar. Nothing
// here calls console.log any more — see data_out.js's header for the ask and the shape.
const out = require('./data_out');

const MS_LOCK_RE = /Locked (\S+) build site — build_center \(([^)]+)\)/;
const MS_GATE_RE = /"([^"]+)" anchor (\d+) gated — order \(short\): (.+)$/;
const MS_PLACED_RE = /"([^"]+)" — (\d+)\/(\d+) structure placed/;
const MS_ANCHOR_DONE_RE = /'([^']+)' anchor (\d+) has no gating work left/;
// ONE STRUCTURE, TWO NAMES — and that mismatch is why this lens has advertised an `ANCHOR N COMPLETE` row
// since it was written and never once printed one (found 2026-09-16).
//   the GATE line names the BLUEPRINT : assessors/building writes `"headframe" anchor 0 gated — order (short)`
//   the DONE line names the JOB KEY   : building_manager writes `'headframe_execute' anchor 2 has no gating work left`
// Keyed on the raw capture, those file under two different sites, so the anchors that gated and the anchors
// that finished never met and every anchor read COMPLETE: NOT YET while the structure demonstrably stood.
// The job key is the structure plus the stage that builds it; stripping that suffix is what makes the two
// lines talk about the same thing. Normalised HERE, once, so the clock and the milestone rows cannot drift
// apart on it (Law 16).
const JOB_KEY_STAGE_RE = /_execute$/;
const structureOfJobKey = (key) => String(key).replace(JOB_KEY_STAGE_RE, '');
const MS_BUILT_RE = /🏁 STRUCTURE BUILT: '([^']+)'/;
const MS_STANDING_RE = /🏠 STRUCTURE STANDING AT FIRST SWEEP: '([^']+)'/;
const MS_START_RE = /🧪 Injected autonomous start signal/;

// ── THE HEADFRAME CLOCK (Architect 2026-09-15) ───────────────────────────────────────────────────────────────
// *"there should be an 11.5 minute timer when the bots start from nothing. and there should be a rating given to
// the construction so when i return later, i remember why its important."* The bands and the reason are HIS,
// authored in architect_config.HEADFRAME_CLOCK, so this lens may grade against them (Law 25 — a criterion the
// asker supplied, read rather than invented here).
//
// START = THE START COMMAND (Architect 2026-09-15: *"it starts at a start command. once the bots begin then the
// timer starts"*): the earliest `🧪 Injected autonomous start signal` any ROSTER bot wrote — start_injector's
// line, reached the same way whether a body is born started or an operator types `start`. Wall-clock ISO, not
// the [Nm Ss] tag, because that tag counts from each bot's own birth.
// END = THE SHELL, NOT THE WHOLE STRUCTURE (Architect 2026-09-16: *"the last anchor doesent count as
// finished. its the shelll thats the most important. so anchor 2 should lap the clock"*). What stops the
// clock is the earliest `'headframe' anchor <graded_anchor> has no gating work left` — building_manager's
// release line, the only line that states an anchor is DONE rather than implying it. The anchor index is
// his, authored in architect_config.HEADFRAME_CLOCK.graded_anchor.
//
// THE WHOLE BUILD IS STILL MEASURED (*"i still want to know how long the entire thing takes"*): the earliest
// `🏁 STRUCTURE BUILT: 'headframe'` from any bot is kept as `fullSec` and printed beside the grade. It is
// reported and never graded — two numbers, and the renderer names which is which so the shell time can
// never be read as the whole time (Law 25).
// A headframe found standing at a bot's first sweep is a continued world and is reported untimed.
// IT IS A GRADE AND NOTHING ELSE (*"its just a grade. it shouldnt pass or fail the run"*): no caller may turn it
// into a check or a wake.
// Returns { rating, elapsedSec, fullSec, spanSec, by, fullBy } — rating is GREEN | OK | LATE | ALERT |
// PENDING | STANDING | NOT_STARTED, and elapsedSec is always the GRADED (shell) time.
function headframeClock(seg) {
  const cfg = require(require('./lens_paths').bot('Thinking_fragments/architect_config.js'));
  const { HEADFRAME_CLOCK: clock, BOT_SENIORITY: roster } = cfg;
  let startMs = null, lastMs = null, builtMs = null, builtBy = null, standing = false;
  let shellMs = null, shellBy = null;
  for (const l of seg) {
    if (!l.iso || !l.bot || !(l.bot in roster)) continue;
    const t = Date.parse(l.iso);
    if (Number.isNaN(t)) continue;
    if (lastMs === null || t > lastMs) lastMs = t;
    let m;
    if (MS_START_RE.test(l.raw) && (startMs === null || t < startMs)) startMs = t;
    else if ((m = l.raw.match(MS_ANCHOR_DONE_RE)) && structureOfJobKey(m[1]) === clock.structure && +m[2] === clock.graded_anchor
             && (shellMs === null || t < shellMs)) { shellMs = t; shellBy = l.bot; }
    else if ((m = l.raw.match(MS_BUILT_RE)) && m[1] === clock.structure && (builtMs === null || t < builtMs)) { builtMs = t; builtBy = l.bot; }
    else if ((m = l.raw.match(MS_STANDING_RE)) && m[1] === clock.structure) standing = true;
  }
  if (startMs === null) return { rating: 'NOT_STARTED', elapsedSec: null, fullSec: null, spanSec: null, by: null, fullBy: null, clock };
  const spanSec = Math.max(0, Math.round((lastMs - startMs) / 1000));
  const fullSec = builtMs === null ? null : Math.round((builtMs - startMs) / 1000);
  // A CONTINUED WORLD IS UNTIMED WHETHER OR NOT AN ANCHOR LINE APPEARS. The standing test comes before the
  // shell test because a headframe already up can still emit a release line during a repair, and timing
  // that from the start command would report a repair as a build.
  if (standing && builtMs === null) return { rating: 'STANDING', elapsedSec: null, fullSec: null, spanSec, by: null, fullBy: null, clock };
  if (shellMs === null) {
    return { rating: spanSec >= clock.alert_from_sec ? 'ALERT' : 'PENDING', elapsedSec: null, fullSec, spanSec, by: null, fullBy: builtBy, clock };
  }
  const elapsedSec = Math.round((shellMs - startMs) / 1000);
  const rating = elapsedSec <= clock.green_within_sec ? 'GREEN'
    : elapsedSec <= clock.ok_within_sec ? 'OK'
    : elapsedSec < clock.alert_from_sec ? 'LATE' : 'ALERT';
  return { rating, elapsedSec, fullSec, spanSec, by: shellBy, fullBy: builtBy, clock };
}

// ── THE CLOCK AS FIELDS (Architect 2026-09-16) ──────────────────────────────────────────────────────
// This used to return prose lines (`HEADFRAME CLOCK: OK 🟡 shell closed at 11m 36s — at the edge of dusk`)
// for runMilestones to print and for run.js to grep by that prefix. It now emits through data_out, so:
//   · the GRADE survives as the `rating` value, and every threshold it was measured against is its own
//     field beside it — a reader can re-derive the band without trusting the word.
//   · the glyphs, the band sentence, the dusk/ALERT-LEVEL wording and `clock.why` are DELETED, not
//     renamed. They said what the number MEANT, which is the reader's job; `why` is still authored in
//     architect_config.HEADFRAME_CLOCK.why for anyone who wants the reason.
//   · the prefixed `HEADFRAME CLOCK:` line is gone with the prose, so run.js's `startsWith` pick-up no
//     longer matches. The grade is `rating` inside the `headframe_clock` section; run.js is another
//     file's to re-point.
// Shell time and whole-structure time keep SEPARATE field names (`shell_*` vs `whole_structure_*`) so
// the graded number can never be read as the ungraded one — the job the old two-line split did.
function emitHeadframeClock(hc) {
  const { clock } = hc;
  out.section('headframe_clock');
  out.kv('structure', clock.structure);
  out.kv('rating', hc.rating);
  out.kv('graded_anchor', clock.graded_anchor);
  out.kv('threshold_green_sec', clock.green_within_sec);
  out.kv('threshold_ok_sec', clock.ok_within_sec);
  out.kv('threshold_alert_sec', clock.alert_from_sec);
  out.kv('shell_closed', hc.elapsedSec === null ? null : relativeTime(hc.elapsedSec));
  out.kv('shell_closed_sec', hc.elapsedSec);
  out.kv('shell_closed_by', hc.by);
  out.kv('span', hc.spanSec === null ? null : relativeTime(hc.spanSec));
  out.kv('span_sec', hc.spanSec);
  if (hc.elapsedSec === null && hc.spanSec !== null) {
    out.kv('green_remaining_sec', Math.max(0, clock.green_within_sec - hc.spanSec));
  }
  out.kv('standing_at_first_sweep', hc.rating === 'STANDING');
  out.kv('start_command_seen', hc.rating !== 'NOT_STARTED');
  out.kv('whole_structure_built', hc.fullSec !== null);
  out.kv('whole_structure', hc.fullSec === null ? null : relativeTime(hc.fullSec));
  out.kv('whole_structure_sec', hc.fullSec);
  out.kv('whole_structure_by', hc.fullBy);
  // Field names stay inside data_out's 28-column key gutter, or the padder clips them onto their own value.
  out.kv('shell_to_whole_sec', hc.fullSec === null || hc.elapsedSec === null ? null : hc.fullSec - hc.elapsedSec);
  out.kv('whole_structure_graded', false);
}

// `deadlineSec` is the ASKER'S CRITERION and it arrives as an argument for that reason (Law 25): the
// Architect asks "was anchor 0 built within 10 minutes", so the number comes from him and the lens
// reports MET / MISSED / NOT YET against it. Baking 10m in would be the monitor substituting its own
// standard for his — the exact usurpation Law 25 names. With no deadline the lens reports elapsed time
// and passes no verdict at all.
function runMilestones({ seg = [], traceName = '?', bot: botFilter = null, deadlineSec = null, verbose = false } = {}) {
  const sites = new Map();   // blueprint → { locked, center, anchors:Map, first, last, total }
  const site = name => {
    let s = sites.get(name);
    if (!s) { s = { locked: null, center: null, by: null, gates: 0, firstGate: null, lastGate: null, first: null, last: null, total: null, anchors: new Map() }; sites.set(name, s); }
    return s;
  };
  // The farm's row sites are measured by farm_lens as ONE structure, printed after the buildings, so their lock
  // lines are left out of this site map rather than printed twice.
  const farmLens = require('./farm_lens');
  const { FARM_BLUEPRINT_NAME: farmRowPrefix, FARM_STRUCTURE: farmStructure } = require(require('./lens_paths').bot('Thinking_fragments/architect_config.js'));
  let maxRel = 0;
  for (const l of seg) {
    if (l.relSec == null) continue;
    if (botFilter && l.bot !== botFilter) continue;
    if (PASSIVE_LINE.test(l.raw)) continue;
    maxRel = Math.max(maxRel, l.relSec);
    let m;
    if ((m = l.raw.match(MS_LOCK_RE))) {
      if (m[1].startsWith(farmRowPrefix)) continue;
      const s = site(m[1]);
      if (s.locked === null) { s.locked = l.relSec; s.center = m[2]; s.by = l.bot; }
    } else if ((m = l.raw.match(MS_GATE_RE))) {
      const s = site(m[1]);
      const a = s.anchors.get(+m[2]) || { gates: 0, firstGate: null, lastGate: null, shortFirst: null, shortLast: null, done: null, doneBy: null };
      a.gates++;
      if (a.firstGate === null) { a.firstGate = l.relSec; a.shortFirst = m[3]; }
      a.lastGate = l.relSec; a.shortLast = m[3];
      s.anchors.set(+m[2], a);
    } else if ((m = l.raw.match(MS_PLACED_RE))) {
      const s = site(m[1]);
      s.total = +m[3];
      s.last = { t: l.relSec, c: +m[2] };
      // FIRST PLACEMENT is the first count above zero, and a scan of exactly zero is deliberately not
      // it: the integrity scan runs from the moment the site is locked, so treating its first appearance
      // as the start would report the build beginning before a single block was placed.
      if (s.first === null && +m[2] > 0) s.first = { t: l.relSec, c: +m[2], by: l.bot };
    } else if ((m = l.raw.match(MS_BUILT_RE)) && m[1] !== farmStructure) {
      // job_board's false→true edge — the one line that says the whole structure stands, not one anchor of it.
      const s = site(m[1]);
      if (!s.built) s.built = { t: l.relSec, by: l.bot };
    } else if ((m = l.raw.match(MS_ANCHOR_DONE_RE))) {
      // The job key ('headframe_execute'), not the blueprint name — matched by prefix so the row lands on
      // the structure a reader is asking about. An unmatched key is kept under its own name rather than
      // guessed at (Law 13: never default a missing field).
      const key = m[1];
      const name = [...sites.keys()].find(n => key.startsWith(n)) || key;
      const s = site(name);
      const a = s.anchors.get(+m[2]) || { gates: 0, firstGate: null, lastGate: null, shortFirst: null, shortLast: null, done: null, doneBy: null };
      if (a.done === null) { a.done = l.relSec; a.doneBy = l.bot; }
      s.anchors.set(+m[2], a);
    }
  }

  // The header's `(context only — never flags, never wakes …)` line is DELETED rather than given a field:
  // it described what the lens is FOR, which is a claim about the output and not a measurement in it.
  out.section('milestones');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('span_sec', maxRel);
  out.kv('bot_filter', botFilter);
  out.kv('build_sites', sites.size);
  // The fleet's clock, not one bot's — so it ignores --bot and reads every roster bot in the run.
  emitHeadframeClock(headframeClock(seg));
  // THE FARM BLOCK IS PRINTED BY ITS OWN LENS. This used to take renderFarm's lines and console.log them
  // here; with stdout owned by data_out there is no line-printer left in this file, and farm_lens is the
  // file that owns how the farm answers. Its reducer runs twice on a --milestones call, which costs one
  // pass over the segment and keeps the two lenses from drifting apart on rendering (Law 16).
  const emitFarm = () => farmLens.runFarm({ seg, traceName, bot: botFilter, verbose });
  if (!sites.size) { emitFarm(); return; }

  // A base layout locks all 32 wheat plots in the first second, and printing five lines for each buries
  // the one structure anybody is asking about under thirty-two identical "locked, nothing since" blocks.
  // A site with no gate post and no integrity scan has had NOTHING happen to it beyond the lock, so it
  // collapses to one counted line — counted rather than dropped, because "32 sites are waiting" is itself
  // the answer to why the fleet is not on them (Law 25: a summarised row is still a reported row).
  const idle = [...sites].filter(([, s]) => !s.anchors.size && !s.last);
  const active = [...sites].filter(([, s]) => s.anchors.size || s.last);
  if (idle.length && !verbose) {
    // The `(--all prints them in full)` hint is deleted — it was instruction to the reader, not data. The
    // truncation itself survives as a count, so nothing is silently dropped.
    out.section('idle_sites');
    out.kv('idle_sites', idle.length);
    out.list('idle_site', idle.slice(0, 4).map(([n]) => n));
    out.kv('idle_sites_not_listed', Math.max(0, idle.length - 4));
  }
  for (const [name, s] of (verbose ? [...sites] : active)) {
    out.section('build_site');
    out.kv('site', name);
    out.kv('structure_cells', s.total);
    out.kv('site_locked', s.locked === null ? null : relativeTime(s.locked));
    out.kv('site_locked_sec', s.locked);
    out.kv('site_locked_center', s.center);
    out.kv('site_locked_by', s.by);
    out.kv('anchors', s.anchors.size);

    // ONE ROW PER ANCHOR, replacing the four prose lines each anchor used to print. Every number those
    // lines carried has a column: the gate count, both gate times, both shortfall strings verbatim from
    // the record, the completion time and bot, the lock→done span, and how long an unfinished anchor has
    // been sitting gated. What is gone is the wording around them (`released to the next anchor`,
    // `still gated … ago`), which asserted what the times meant.
    const anchorRows = [];
    const deadlineRows = [];
    for (const [idx, a] of [...s.anchors].sort((x, y) => x[0] - y[0])) {
      anchorRows.push([
        idx, a.gates,
        a.firstGate === null ? null : relativeTime(a.firstGate), a.shortFirst,
        a.lastGate === null ? null : relativeTime(a.lastGate), a.shortLast,
        a.done !== null,
        a.done === null ? null : relativeTime(a.done), a.doneBy,
        a.done !== null && s.locked !== null ? relativeTime(a.done - s.locked) : null,
        a.done === null && a.lastGate !== null ? maxRel - a.lastGate : null,
      ]);
      // The asker's criterion, measured from RUN START (relSec resets on each `start`) — not from site
      // lock, because "built within ten minutes" is a question about the run, and lock time is one of the
      // costs it is asking about. MISSED is asserted only when it can no longer change: an unfinished
      // anchor past the deadline is already over it, while an unfinished one inside it is PENDING and
      // must not be scored (Law 25 — never a verdict the evidence has not earned).
      if (deadlineSec !== null) deadlineRows.push(deadlineRow(idx, a.done, maxRel, deadlineSec, a.gates + (a.done === null ? 0 : 1)));
    }
    if (anchorRows.length) {
      out.table(['anchor', 'gates', 'first_gate', 'short_first', 'last_gate', 'short_last',
        'complete', 'complete_at', 'complete_by', 'lock_to_complete', 'gated_for_sec'], anchorRows);
    }
    // An anchor that never posted a gate AND never completed leaves no row above, so a deadline asked
    // about it would silently print nothing — a missing verdict reading exactly like a passing one.
    // `anchor_lines` 0 is what says the verdict was reached on no evidence at all.
    if (deadlineSec !== null && !s.anchors.has(0)) deadlineRows.unshift(deadlineRow(0, null, maxRel, deadlineSec, 0));
    if (deadlineRows.length) {
      out.section('anchor_deadlines');
      out.kv('deadline', relativeTime(deadlineSec));
      out.kv('deadline_sec', deadlineSec);
      out.table(['anchor', 'verdict', 'complete', 'measured_at', 'margin_sec', 'anchor_lines'], deadlineRows);
    }

    out.kv('first_placement', s.first ? relativeTime(s.first.t) : null);
    out.kv('first_placement_sec', s.first ? s.first.t : null);
    out.kv('first_placement_placed', s.first ? s.first.c : null);
    out.kv('first_placement_by', s.first ? s.first.by : null);
    out.kv('lock_to_first_placement', s.first ? relativeTime(s.first.t - (s.locked || 0)) : null);
    out.kv('integrity_scan_seen', !!s.last);
    out.kv('latest_scan', s.last ? relativeTime(s.last.t) : null);
    out.kv('latest_scan_placed', s.last ? s.last.c : null);
    out.kv('structure_built', !!s.built);
    out.kv('built_at', s.built ? relativeTime(s.built.t) : null);
    out.kv('built_by', s.built ? s.built.by : null);
    out.kv('lock_to_built', s.built && s.locked !== null ? relativeTime(s.built.t - s.locked) : null);
  }
  emitFarm();
}

// One deadline verdict as a ROW. `margin_sec` is the deadline minus the moment measured, so it is spare
// time when positive and overrun when negative — one signed column in place of the two phrases (`to
// spare` / `over`) the prose used to switch between. `measured_at` names what it was measured against:
// the completion time when there is one, the run's span when there is not.
function deadlineRow(anchor, doneSec, maxRel, deadlineSec, anchorLines) {
  const measured = doneSec === null ? maxRel : doneSec;
  const verdict = doneSec !== null
    ? (doneSec <= deadlineSec ? 'MET' : 'MISSED')
    : (maxRel > deadlineSec ? 'MISSED' : 'PENDING');
  return [anchor, verdict, doneSec !== null, relativeTime(measured), deadlineSec - measured, anchorLines];
}

// ── THE TORCH CLOCK (--torch) ───────────────────────────────────────────────────────────────────
// WHEN THE FIRST TORCH WAS CRAFTED — and, when it was not, what held it.
//
// WHY IT IS HERE AND NOT ITS OWN FILE. This file's verb is the first-occurrence clock, and a torch
// craft is a first occurrence: the moment the fleet's light supply comes into being. It is a second
// LENS rather than a section of runMilestones because that reducer's whole data model is a map of
// build SITES keyed by blueprint, and a torch is stock, not a site — folding it in would mean a row
// with no site to hang on. Same shape as locomotion_lenses, which holds three clocks behind three
// flags for the same reason.
//
// WHY THE FLEET'S LIGHT IS WORTH A CLOCK OF ITS OWN. The torch chain is the one supply chain that can
// close a circle on itself: a torch needs charcoal, charcoal comes off the furnace chain, and the
// descent that would fetch its fuel is itself gated on holding torches. So a run where no torch is
// ever crafted does not announce itself — nothing errors, nothing stalls, the board simply carries a
// job that is gated every single sweep. The only way to see it is to ask when the first one landed
// and get NOT YET as an answer.
//
// THE FOUR LINES IT READS, all of them summary lines the fleet already writes:
//   crafted <item> x<n> → <item> have=<a>/<b>   craft_handler  — the craft ITSELF, and its target
//   craft PARTIAL|FAILED <item> x<n> → …        craft_handler  — an attempt that did not deliver
//   [<band>/<rung>] supply/torch (need:<n>)     job_board      — the ORDER: which band asked, how many
//   🚧 GATED <reason> (<n>): <why> → <job> […]   job_board      — what is holding it, and short of what
//
// A FAILED ATTEMPT IS REPORTED BESIDE THE SUCCESSES, never filtered out. "The first torch was crafted
// at 6m" and "the first torch was crafted at 6m after failing twice" are different answers to the
// question, and showing only the successes is a subset wearing the whole set's clothes (Law 25).
//
// IT PASSES NO VERDICT ON THE NUMBERS IT PRINTS. The craft target (`have=4/12`) and the order size
// (`need:12`) are reported verbatim because what those numbers SHOULD be is the asker's question, not
// the lens's (Law 25 — the criterion belongs to whoever the answer is for). The one exception is the
// same one runMilestones carries: a `--deadline` that was supplied, which is the asker's own number
// handed in, so scoring against it reports his criterion rather than substituting one.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --torch [--bot=B] [--deadline=10m]

// THE CRAFT OUTCOME IS READ OFF craft_handler's ONE `craft book` SUMMARY (craft_handler.js ~1324), the line
// that carries every order's verdict AND the delta. This lens keyed on `crafted <item> xN → <item> have=a/b`
// and `craft PARTIAL|FAILED …`, spellings no fragment writes any more, and on 2026-09-15 it printed
// "NOT YET — no craft produced a torch" over a run whose book read `torch x12 ✓ … torch craft 11→15/12 (+4)`
// twice. The book is: `craft book i/n order(s) — <order> | <order> | tables placed=… | crafts ok=… fail=… |
// <notes joined by ' · '>`, each order `<item> xN ✓` · `<item> xN partial +M short S` · `<item> xN FAILED a/b`.
const TORCH_BOOK_RE   = /craft book \d+\/\d+ order\(s\) — (.+?) \| tables placed=\d+ reused=\d+ \| crafts ok=\d+ fail=\d+ \| (.*)$/;
const TORCH_ORDER_SEG = /^(\S+) x(\d+) (?:(✓)|partial \+(\d+) short (\d+)|FAILED (\d+)\/(\d+))$/;
// The token before the job is CAPTURED rather than matched, and stays that way even though only one
// spelling is live. The board has written it as a priority (`P23 supply/torch`) and as a band/rung pair
// (`[bot/gather] supply/torch`), and a regex pinned to either reports "never ordered" on a run using the
// other — a false NOT-FOUND that reads exactly like a true one (Law 25). Old traces still carry the old
// spelling, and a lens that cannot read them is a lens that lies about history.
const TORCH_ORDER_RE  = /(\S+) supply\/torch \(need:(\d+)\)/;
const TORCH_GATE_RE   = /🚧 GATED (\S+) \(\d+\): (.+)$/;
// THE DELTA IS WHAT "CRAFTED" MEANS, not the word at the head of the line. Every craft outcome — the
// full success and the partial alike — ends in `<item> craft <a>→<b>/<c> (+<d>)`, and `d` is how many
// actually came into existence.
//
// THE WRONG TURN, because it is the obvious one: keying the first torch on the `crafted` success line
// alone. A batch of twelve that ran out of charcoal at four posts as `craft PARTIAL`, and the run that
// prompted this lens did exactly that — four torches in the bot's inventory and the lens saying NOT YET,
// which is a false negative that reads exactly like a true one (Law 25). The question is when a torch
// first existed, not whether the order that made it was filled in whole.
const TORCH_MADE_RE   = /\btorch craft (\d+)→(\d+)\/(\d+) \(\+(\d+)\)/;

// A gate post carries several clauses separated by ' · ', and ONE clause may name several jobs
// separated by ', ' — the night gate posts every job it stopped under a single reason. Both splits are
// needed: taking only the first job of a clause silently drops a torch that was gated alongside a log
// order, which reads as "the torch was never gated" (Law 25).
function torchGateClauses(body) {
  const found = [];
  for (const clause of body.split(' · ')) {
    const cut = clause.indexOf(' → ');
    if (cut < 0) continue;
    const why = clause.slice(0, cut).trim();
    const jobRe = /([A-Za-z0-9_]+) \[([^\]]*)\]/g;
    let m;
    while ((m = jobRe.exec(clause.slice(cut + 3)))) {
      if (/torch/i.test(m[1])) found.push({ why, job: m[1], short: m[2] });
    }
  }
  return found;
}

function runTorchClock({ seg = [], traceName = '?', bot: botFilter = null, deadlineSec = null } = {}) {
  const crafts = [];                 // every torch craft outcome, in order, successes and failures alike
  const gates = new Map();           // reason|why → the span it held over
  const gateOrder = [];              // reasons in order of FIRST appearance — the handoff between gates
  let order = null;                  // first/last board posting of the torch job
  let maxRel = 0;

  for (const l of seg) {
    if (l.relSec == null) continue;
    if (botFilter && l.bot !== botFilter) continue;
    if (PASSIVE_LINE.test(l.raw)) continue;
    maxRel = Math.max(maxRel, l.relSec);
    let m;
    if ((m = l.raw.match(TORCH_BOOK_RE))) {
      const d = m[2].match(TORCH_MADE_RE);
      for (const seg of m[1].split(' | ')) {
        const o = seg.match(TORCH_ORDER_SEG);
        if (!o || o[1] !== 'torch') continue;
        // The delta note is the count that came into existence. A batch with no torch note made nothing (a
        // FAILED order, or one already met on entry); 0 is the read, not a defaulted field (Law 13).
        const outcome = o[3] ? 'CRAFTED' : o[4] ? 'PARTIAL' : 'FAILED';
        const have = d ? +d[2] : o[6] != null ? +o[6] : null;
        const target = d ? +d[3] : o[7] != null ? +o[7] : +o[2];
        crafts.push({ t: l.relSec, bot: l.bot, outcome, qty: +o[2], have, target, made: d ? +d[4] : 0 });
      }
    } else if ((m = l.raw.match(TORCH_ORDER_RE))) {
      if (!order) order = { firstT: l.relSec, firstLane: m[1], firstNeed: +m[2] };
      order.lastT = l.relSec; order.lastLane = m[1]; order.lastNeed = +m[2];
    } else if ((m = l.raw.match(TORCH_GATE_RE))) {
      for (const c of torchGateClauses(m[2])) {
        const key = `${m[1]}|${c.why}`;
        let g = gates.get(key);
        if (!g) {
          g = { reason: m[1], why: c.why, job: c.job, n: 0, first: l.relSec, last: l.relSec, shortFirst: c.short, shortLast: c.short };
          gates.set(key, g); gateOrder.push(key);
        }
        g.n++; g.last = l.relSec; g.shortLast = c.short; g.job = c.job;
      }
    }
  }

  // The `(first-occurrence clock … the numbers are printed, not judged)` header line is deleted: it was a
  // promise about the output, which the output's shape now makes rather than states.
  out.section('torch_clock');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('span_sec', maxRel);
  out.kv('bot_filter', botFilter);

  const productive = crafts.filter(c => c.made > 0);
  const first = productive[0];
  out.section('first_torch');
  // NOT-YET is reported as not-happened rather than as a zero: a run that crafted no torch and a run
  // that crafted zero torches are the same number and completely different facts (Law 25). The boolean
  // carries that, and every time field below it is absent rather than 0 when it is false.
  out.kv('first_torch_crafted', !!first);
  out.kv('first_torch_at', first ? relativeTime(first.t) : null);
  out.kv('first_torch_sec', first ? first.t : null);
  out.kv('first_torch_made', first ? first.made : null);
  out.kv('first_torch_have', first ? first.have : null);
  out.kv('first_torch_target', first ? first.target : null);
  out.kv('first_torch_bot', first ? first.bot : null);
  // The batch outcome rides ALONGSIDE the time rather than deciding whether there is one to print. A
  // partial that made four torches answers "when was the first torch crafted" completely, and it also
  // has to say it was short — both facts, neither suppressing the other.
  out.kv('first_torch_outcome', first ? first.outcome : null);
  out.kv('first_torch_asked', first ? first.qty : null);
  out.kv('first_torch_short', first && first.have !== null ? first.target - first.have : null);
  out.kv('productive_crafts', productive.length);
  out.kv('torches_made', productive.reduce((s, c) => s + c.made, 0));
  const last = productive[productive.length - 1];
  out.kv('last_productive_at', last ? relativeTime(last.t) : null);
  out.kv('last_productive_have', last ? last.have : null);
  out.kv('last_productive_target', last ? last.target : null);

  // Every craft outcome that produced nothing, as rows beside the headline rather than in place of it.
  const barren = crafts.filter(c => c.made === 0);
  out.kv('crafts_that_made_nothing', barren.length);
  if (barren.length) {
    out.table(['craft_at', 'outcome', 'asked', 'have', 'target', 'bot'],
      barren.map(f => [relativeTime(f.t), f.outcome, f.qty, f.have, f.target, f.bot]));
  }
  if (deadlineSec !== null) {
    // MISSED is asserted only once it can no longer change; inside the window it is PENDING and must
    // not be scored, exactly as runMilestones treats an unfinished anchor. Same row shape as the anchor
    // deadlines, so one reading of `margin_sec` serves both.
    const [, verdict, met, measuredAt, marginSec] = deadlineRow(0, first ? first.t : null, maxRel, deadlineSec, crafts.length);
    out.section('torch_deadline');
    out.kv('deadline', relativeTime(deadlineSec));
    out.kv('deadline_sec', deadlineSec);
    out.kv('verdict', verdict);
    out.kv('crafted', met);
    out.kv('measured_at', measuredAt);
    out.kv('margin_sec', marginSec);
  }

  out.section('torch_order');
  // The parenthetical about a gated job being posted below is deleted — it told the reader how to read
  // the zero. The gate section beneath carries its own counts.
  out.kv('order_posted', !!order);
  out.kv('first_posted_at', order ? relativeTime(order.firstT) : null);
  out.kv('first_posted_lane', order ? order.firstLane : null);
  out.kv('first_posted_need', order ? order.firstNeed : null);
  out.kv('last_posted_at', order ? relativeTime(order.lastT) : null);
  out.kv('last_posted_lane', order ? order.lastLane : null);
  out.kv('last_posted_need', order ? order.lastNeed : null);

  out.section('torch_gates');
  out.kv('gate_posts', gateOrder.reduce((s, k) => s + gates.get(k).n, 0));
  out.kv('gate_rows', gateOrder.length);
  if (gateOrder.length) {
    // Rows in order of FIRST appearance, which is what makes the handoff legible.
    out.table(['first_at', 'last_at', 'posts', 'reason', 'why', 'job', 'short_first', 'short_last'],
      gateOrder.map(key => {
        const g = gates.get(key);
        return [relativeTime(g.first), relativeTime(g.last), g.n, g.reason, g.why, g.job, g.shortFirst, g.shortLast];
      }));
    // THE HANDOFF IS THE POINT. One gate opening and a different one closing behind it is the single
    // fact a gate-count cannot show, and it is what separates "the fix did nothing" from "the fix
    // worked and something else stopped it" — the two readings a redesigned gate has to be told apart.
    // The count of changes is the datum; the sentence that used to explain it is deleted.
    const reasons = [...new Set(gateOrder.map(k => gates.get(k).reason))];
    out.kv('gate_reasons', reasons.length);
    out.kv('gate_reason_changes', reasons.length - 1);
    out.list('gate_reason_in_order', reasons);
  }
}

module.exports = { runMilestones, runTorchClock, headframeClock };
