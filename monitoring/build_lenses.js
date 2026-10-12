// Auren_Bot/monitoring/build_lenses.js
// First-occurrence clocks for the base's establishment events: `--milestones` (runMilestones) times each
// build site, `--torch` (runTorchClock) times the fleet's first torch. Both answer when an event first
// happened and what it was waiting on, passing no verdict beyond what the caller supplies (Law 25).
// Kept out of trace_monitor: never flags, never wakes, shares no signature or threshold with the
// detection engine. Seam is combat_lens's — inputs as ARGUMENTS, render, RETURN.
// THE FOUR EVENTS, and the line each is read from:
//   SITE LOCKED        set_buildspot        — the site exists, clock starts
//   ANCHOR N GATED     job_board            — materials-blocked, with what it is short of
//   FIRST PLACEMENT    building_integrity   — first scan reporting a placed count above zero
//   ANCHOR N COMPLETE  building_manager     — the anchor released to the next one
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --milestones [--bot=B] [--deadline=10m] [--all]

'use strict';

const { relativeTime, PASSIVE_LINE } = require('./trace_read');
// All stdout goes through data_out: field names and values, no grammar (see data_out.js).
const out = require('./data_out');

const MS_LOCK_RE = /Locked (\S+) build site — transpose_origin \(([^)]+)\)/;
const MS_GATE_RE = /"([^"]+)" anchor (\d+) gated — order \(short\): (.+)$/;
const MS_PLACED_RE = /"([^"]+)" — (\d+)\/(\d+) structure placed/;
const MS_ANCHOR_DONE_RE = /'([^']+)' anchor (\d+) has no gating work left/;
// The GATE line names the BLUEPRINT (assessors/building: `"headframe" anchor 0 gated`); the DONE line
// names the JOB KEY (building_manager: `'headframe_execute' anchor 2 has no gating work left`). The job
// key is the structure plus the stage that builds it, so stripping that suffix gives the same structure
// name the gate line uses — normalised here once so the clock and the milestone rows agree (Law 16).
const JOB_KEY_STAGE_RE = /_execute$/;
const structureOfJobKey = (key) => String(key).replace(JOB_KEY_STAGE_RE, '');
const MS_BUILT_RE = /🏁 STRUCTURE BUILT: '([^']+)'/;
const MS_STANDING_RE = /🏠 STRUCTURE STANDING AT FIRST SWEEP: '([^']+)'/;
const MS_START_RE = /🧪 Injected autonomous start signal/;

// ── THE HEADFRAME CLOCK ───────────────────────────────────────────────────────────────
// Grades the headframe build against the bands in architect_config.HEADFRAME_CLOCK — the asker's own
// criterion, read here, not invented (Law 25).
// START: earliest `🧪 Injected autonomous start signal` from any ROSTER bot (start_injector's line),
// wall-clock ISO, since the [Nm Ss] tag instead counts from each bot's own birth.
// END: earliest `'headframe' anchor <graded_anchor> has no gating work left` — building_manager's
// release line, the only line that states an anchor is DONE instead of implying it (graded_anchor is
// authored in architect_config.HEADFRAME_CLOCK).
// Whole-build time is also tracked: earliest `🏁 STRUCTURE BUILT: 'headframe'` from any bot, kept as
// `fullSec` and reported beside the grade, never graded itself. A headframe already standing at a bot's
// first sweep is a continued world and reported untimed. A grade only: no caller may turn it into a
// check or a wake.
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
  // A continued world (already standing) is reported untimed even when a release line appears during a
  // later repair.
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

// ── THE CLOCK AS FIELDS ──────────────────────────────────────────────────────
// Emits the grade through data_out: `rating` plus every threshold measured against it, so a reader can
// re-derive the band without trusting the word. Shell and whole-structure time keep separate field names
// (`shell_*` vs `whole_structure_*`) so the graded number is never read as the ungraded one.
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

// `deadlineSec` is the asker's own criterion (Law 25), reported as MET / MISSED / NOT YET, never baked
// in. With no deadline the lens reports elapsed time and passes no verdict.
function runMilestones({ seg = [], traceName = '?', bot: botFilter = null, deadlineSec = null, verbose = false } = {}) {
  const sites = new Map();   // blueprint → { locked, center, anchors:Map, first, last, total }
  const site = name => {
    let s = sites.get(name);
    if (!s) { s = { locked: null, center: null, by: null, gates: 0, firstGate: null, lastGate: null, first: null, last: null, total: null, anchors: new Map() }; sites.set(name, s); }
    return s;
  };
  // The farm's row sites are measured by farm_lens as ONE structure, printed after the buildings, so their lock
  // lines are left out of this site map instead of printed twice.
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
      // First placement is the first count above zero; a zero-count scan is not it, since the scan runs
      // from the moment the site locks.
      if (s.first === null && +m[2] > 0) s.first = { t: l.relSec, c: +m[2], by: l.bot };
    } else if ((m = l.raw.match(MS_BUILT_RE)) && m[1] !== farmStructure) {
      // job_board's false→true edge — the one line that says the whole structure stands, not one anchor of it.
      const s = site(m[1]);
      if (!s.built) s.built = { t: l.relSec, by: l.bot };
    } else if ((m = l.raw.match(MS_ANCHOR_DONE_RE))) {
      // The job key ('headframe_execute'), not the blueprint name — matched by prefix so the row lands on
      // the structure a reader is asking about. An unmatched key is kept under its own name instead of
      // guessed at (Law 13: never default a missing field).
      const key = m[1];
      const name = [...sites.keys()].find(n => key.startsWith(n)) || key;
      const s = site(name);
      const a = s.anchors.get(+m[2]) || { gates: 0, firstGate: null, lastGate: null, shortFirst: null, shortLast: null, done: null, doneBy: null };
      if (a.done === null) { a.done = l.relSec; a.doneBy = l.bot; }
      s.anchors.set(+m[2], a);
    }
  }

  out.section('milestones');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('span_sec', maxRel);
  out.kv('bot_filter', botFilter);
  out.kv('build_sites', sites.size);
  // The fleet's clock, not one bot's — so it ignores --bot and reads every roster bot in the run.
  emitHeadframeClock(headframeClock(seg));
  // The farm block is printed by its own lens (farm_lens owns how the farm answers); its reducer runs
  // again here, at the cost of one extra pass, so the two lenses cannot drift apart on rendering (Law 16).
  const emitFarm = () => farmLens.runFarm({ seg, traceName, bot: botFilter, verbose });
  if (!sites.size) { emitFarm(); return; }

  // A site with no gate post and no integrity scan has had nothing happen to it beyond the lock, so idle
  // sites collapse to one counted line instead of one block each (Law 25: a summarised row is still a
  // reported row).
  const idle = [...sites].filter(([, s]) => !s.anchors.size && !s.last);
  const active = [...sites].filter(([, s]) => s.anchors.size || s.last);
  if (idle.length && !verbose) {
    // Truncation survives as a count, so nothing is silently dropped.
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

    // One row per anchor: gate count, both gate times, both shortfall strings verbatim from the record,
    // completion time and bot, lock→done span, and how long an unfinished anchor has been gated.
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
      // Measured from run start (relSec resets on each `start`), not site lock, since the deadline
      // question is about the run as a whole. MISSED is asserted only once the outcome is fixed: an
      // unfinished anchor past the deadline is already over it, an unfinished one inside it is PENDING
      // (Law 25).
      if (deadlineSec !== null) deadlineRows.push(deadlineRow(idx, a.done, maxRel, deadlineSec, a.gates + (a.done === null ? 0 : 1)));
    }
    if (anchorRows.length) {
      out.table(['anchor', 'gates', 'first_gate', 'short_first', 'last_gate', 'short_last',
        'complete', 'complete_at', 'complete_by', 'lock_to_complete', 'gated_for_sec'], anchorRows);
    }
    // An anchor with no gate post and no completion leaves no row above; `anchor_lines` 0 on the row
    // added here says its verdict was reached on no evidence at all.
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

// One deadline verdict as a row. `margin_sec` is deadline minus the moment measured: spare time when
// positive, overrun when negative. `measured_at` is the completion time when there is one, else the
// run's span.
function deadlineRow(anchor, doneSec, maxRel, deadlineSec, anchorLines) {
  const measured = doneSec === null ? maxRel : doneSec;
  const verdict = doneSec !== null
    ? (doneSec <= deadlineSec ? 'MET' : 'MISSED')
    : (maxRel > deadlineSec ? 'MISSED' : 'PENDING');
  return [anchor, verdict, doneSec !== null, relativeTime(measured), deadlineSec - measured, anchorLines];
}

// ── THE TORCH CLOCK (--torch) ───────────────────────────────────────────────────────────────────
// When the first torch was crafted, and, when it was not, what held it.
// A second lens, not a runMilestones section: that reducer's data model is a map of build sites keyed by
// blueprint, and a torch is stock, not a site. Same shape as locomotion_lenses, which holds three clocks
// behind three flags for the same reason.
// The torch chain can close a circle on itself — a torch needs charcoal off the furnace chain, and the
// descent that fetches that fuel is itself gated on holding torches — so a run that never crafts one
// does not otherwise announce itself.
// THE FOUR LINES IT READS, all summary lines the fleet already writes:
//   crafted <item> x<n> → <item> have=<a>/<b>   craft_handler  — the craft itself, and its target
//   craft PARTIAL|FAILED <item> x<n> → …        craft_handler  — an attempt that did not deliver
//   [<band>/<rung>] supply/torch (need:<n>)     job_board      — the order: which band asked, how many
//   🚧 GATED <reason> (<n>): <why> → <job> […]   job_board      — what is holding it, and short of what
// Failed attempts are reported beside successes, never filtered out (Law 25). Craft targets and order
// sizes are reported verbatim, with no verdict on what they should be (Law 25), except a supplied
// `--deadline`, which is the asker's own number and is scored against.
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --torch [--bot=B] [--deadline=10m]

// Read off craft_handler's `craft book` summary line, which carries every order's verdict and delta:
// `craft book i/n order(s) — <order> | <order> | tables placed=… | crafts ok=… fail=… | <notes joined by
// ' · '>`, each order shaped `<item> xN ✓` · `<item> xN partial +M short S` · `<item> xN FAILED a/b`.
const TORCH_BOOK_RE   = /craft book \d+\/\d+ order\(s\) — (.+?) \| tables placed=\d+ reused=\d+ \| crafts ok=\d+ fail=\d+ \| (.*)$/;
const TORCH_ORDER_SEG = /^(\S+) x(\d+) (?:(✓)|partial \+(\d+) short (\d+)|FAILED (\d+)\/(\d+))$/;
// The token before the job is captured instead of matched to one spelling: the board has written it both
// as a priority (`P23 supply/torch`) and as a band/rung pair (`[bot/gather] supply/torch`), and both
// spellings must read as an order (Law 25).
const TORCH_ORDER_RE  = /(\S+) supply\/torch \(need:(\d+)\)/;
const TORCH_GATE_RE   = /🚧 GATED (\S+) \(\d+\): (.+)$/;
// The delta is what "crafted" means, not the word at the head of the line: every craft outcome ends in
// `<item> craft <a>→<b>/<c> (+<d>)`, and `d` is how many actually came into existence — keyed on that
// instead of the `crafted` word alone, so a partial batch that still produced a torch counts (Law 25).
const TORCH_MADE_RE   = /\btorch craft (\d+)→(\d+)\/(\d+) \(\+(\d+)\)/;

// The light chain, one event per line that moves it: a furnace crafted and stood, charcoal loaded and
// collected (with the batch), and a torch set in the shaft (mining_executor's `torch placed` line).
const LIGHT_EVENTS = [
  { event: 'furnace_crafted',   re: /craft book .*\bfurnace craft \d+→\d+\/\d+ \(\+(\d+)\)/ },
  { event: 'furnace_stood',     re: /registered furnace at \((-?\d+,-?\d+,-?\d+)\)/, where: true },
  { event: 'charcoal_loaded',   re: /WINDOW furnace-load @ (\S+): (\d+)x charcoal/, qtyAt: 2, whereAt: 1 },
  { event: 'charcoal_collected', re: /WINDOW furnace-collect @ (\S+): (\d+)x charcoal/, qtyAt: 2, whereAt: 1 },
  { event: 'coal_mined',        re: /\bcoal_ore\b.*\b(?:mined|dug|cleared)\b/ },
  { event: 'torch_placed_in_shaft', re: /torch placed at \((-?\d+,-?\d+,-?\d+)\)/, where: true },
];

function lightEvent(raw) {
  for (const e of LIGHT_EVENTS) {
    const m = raw.match(e.re);
    if (!m) continue;
    const qty = e.qtyAt ? +m[e.qtyAt] : (e.event === 'furnace_crafted' ? +m[1] : 1);
    const where = e.whereAt ? m[e.whereAt] : e.where ? m[1] : null;
    return { event: e.event, qty, where };
  }
  return null;
}

// A gate post carries several clauses separated by ' · ', and one clause may name several jobs — both
// splits are read so a torch gated alongside another order is not missed (Law 25).
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
  const light = [];                  // the furnace → charcoal → torch → shaft chain, in fleet-clock order
  let maxRel = 0;

  for (const l of seg) {
    if (l.relSec == null) continue;
    if (botFilter && l.bot !== botFilter) continue;
    if (PASSIVE_LINE.test(l.raw)) continue;
    maxRel = Math.max(maxRel, l.relSec);
    const le = lightEvent(l.raw);
    if (le) light.push({ t: l.relSec, bot: l.bot, ...le });
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

  out.section('torch_clock');
  out.kv('trace', traceName);
  out.kv('span', relativeTime(maxRel));
  out.kv('span_sec', maxRel);
  out.kv('bot_filter', botFilter);

  const productive = crafts.filter(c => c.made > 0);
  const first = productive[0];
  out.section('first_torch');
  // NOT-YET is reported as not-happened, not as a zero (Law 25): the boolean carries that, and every
  // time field below it is absent instead of 0 when it is false.
  out.kv('first_torch_crafted', !!first);
  out.kv('first_torch_at', first ? relativeTime(first.t) : null);
  out.kv('first_torch_sec', first ? first.t : null);
  out.kv('first_torch_made', first ? first.made : null);
  out.kv('first_torch_have', first ? first.have : null);
  out.kv('first_torch_target', first ? first.target : null);
  out.kv('first_torch_bot', first ? first.bot : null);
  // The batch outcome rides alongside the time: a partial that produced torches reports both when and short.
  out.kv('first_torch_outcome', first ? first.outcome : null);
  out.kv('first_torch_asked', first ? first.qty : null);
  out.kv('first_torch_short', first && first.have !== null ? first.target - first.have : null);
  out.kv('productive_crafts', productive.length);
  out.kv('torches_made', productive.reduce((s, c) => s + c.made, 0));
  const last = productive[productive.length - 1];
  out.kv('last_productive_at', last ? relativeTime(last.t) : null);
  out.kv('last_productive_have', last ? last.have : null);
  out.kv('last_productive_target', last ? last.target : null);

  // Every craft outcome that produced nothing, as rows beside the headline, not in place of it.
  const barren = crafts.filter(c => c.made === 0);
  out.kv('crafts_that_made_nothing', barren.length);
  if (barren.length) {
    out.table(['craft_at', 'outcome', 'asked', 'have', 'target', 'bot'],
      barren.map(f => [relativeTime(f.t), f.outcome, f.qty, f.have, f.target, f.bot]));
  }
  if (deadlineSec !== null) {
    // MISSED is asserted only once the outcome is fixed; inside the window it is PENDING and must
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
    // One gate opening and a different one closing behind it is the fact a gate-count alone cannot show
    // — the handoff between reasons, kept as its own count.
    const reasons = [...new Set(gateOrder.map(k => gates.get(k).reason))];
    out.kv('gate_reasons', reasons.length);
    out.kv('gate_reason_changes', reasons.length - 1);
    out.list('gate_reason_in_order', reasons);
  }

  // ── THE LIGHT CHAIN ── firsts and totals per event, then every event in fleet-clock order.
  light.sort((a, b) => a.t - b.t);
  const torchEvents = productive.map(c => ({ t: c.t, bot: c.bot, event: 'torch_crafted', qty: c.made, where: null }));
  const chain = [...light, ...torchEvents].sort((a, b) => a.t - b.t);
  out.section('light_chain');
  const names = [...LIGHT_EVENTS.map(e => e.event), 'torch_crafted'];
  out.table(['event', 'first_at', 'first_qty', 'first_bot', 'count', 'qty_total', 'last_at'],
    names.map(name => {
      const rows = chain.filter(e => e.event === name);
      const f = rows[0], z = rows[rows.length - 1];
      return [name, f ? relativeTime(f.t) : null, f ? f.qty : null, f ? f.bot : null,
        rows.length, rows.reduce((s, e) => s + e.qty, 0), z ? relativeTime(z.t) : null];
    }));
  out.section('light_timeline');
  out.table(['at', 'event', 'qty', 'where', 'bot'],
    chain.map(e => [relativeTime(e.t), e.event, e.qty, e.where, e.bot]));
}

module.exports = { runMilestones, runTorchClock, headframeClock };
