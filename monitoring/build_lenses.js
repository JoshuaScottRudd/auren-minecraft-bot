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

const MS_LOCK_RE = /Locked (\S+) build site — build_center \(([^)]+)\)/;
const MS_GATE_RE = /"([^"]+)" anchor (\d+) gated — order \(short\): (.+)$/;
const MS_PLACED_RE = /"([^"]+)" — (\d+)\/(\d+) structure placed/;
const MS_ANCHOR_DONE_RE = /'([^']+)' anchor (\d+) has no gating work left/;

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
  let maxRel = 0;
  for (const l of seg) {
    if (l.relSec == null) continue;
    if (botFilter && l.bot !== botFilter) continue;
    if (PASSIVE_LINE.test(l.raw)) continue;
    maxRel = Math.max(maxRel, l.relSec);
    let m;
    if ((m = l.raw.match(MS_LOCK_RE))) {
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

  console.log(`trace_monitor · milestones · ${traceName} · latest run · span [${relativeTime(maxRel)}]${botFilter ? ` · bot=${botFilter}` : ''}`);
  console.log('(context only — never flags, never wakes; first-occurrence clock per establishment event)\n');
  if (!sites.size) { console.log('(no build-site lines in the latest run yet)'); return; }

  // A base layout locks all 32 wheat plots in the first second, and printing five lines for each buries
  // the one structure anybody is asking about under thirty-two identical "locked, nothing since" blocks.
  // A site with no gate post and no integrity scan has had NOTHING happen to it beyond the lock, so it
  // collapses to one counted line — counted rather than dropped, because "32 sites are waiting" is itself
  // the answer to why the fleet is not on them (Law 25: a summarised row is still a reported row).
  const idle = [...sites].filter(([, s]) => !s.anchors.size && !s.last);
  const active = [...sites].filter(([, s]) => s.anchors.size || s.last);
  if (idle.length && !verbose) {
    console.log(`${idle.length} site(s) locked with nothing since — no anchor gate, no integrity scan: ` +
                `${idle.slice(0, 4).map(([n]) => n).join(', ')}${idle.length > 4 ? `, +${idle.length - 4} more` : ''}`);
    console.log('  (--all prints them in full)\n');
  }
  for (const [name, s] of (verbose ? [...sites] : active)) {
    console.log(`${name}${s.total ? `  ·  ${s.total} structure cell(s)` : ''}`);
    if (s.locked !== null) console.log(`  [${relativeTime(s.locked)}]  SITE LOCKED at (${s.center})  — ${s.by}`);
    else console.log('  ──        SITE LOCKED: no lock line in this run (the site was already locked before it started)');

    for (const [idx, a] of [...s.anchors].sort((x, y) => x[0] - y[0])) {
      if (a.firstGate !== null) {
        console.log(`  [${relativeTime(a.firstGate)}]  anchor ${idx} GATED on materials — short: ${a.shortFirst}`);
        if (a.gates > 1) console.log(`             …${a.gates} gate post(s), last at [${relativeTime(a.lastGate)}] still short: ${a.shortLast}`);
      }
      if (a.done !== null) {
        console.log(`  [${relativeTime(a.done)}]  ⭑ ANCHOR ${idx} COMPLETE — released to the next anchor  (${a.doneBy})`);
        if (s.locked !== null) console.log(`             ⇒ ${relativeTime(a.done - s.locked)} from site lock to anchor ${idx} done`);
      } else if (a.firstGate !== null) {
        console.log(`  ──        anchor ${idx} COMPLETE: NOT YET — still gated ${relativeTime(maxRel - a.lastGate)} ago at [${relativeTime(maxRel)}]`);
      }
      // The asker's criterion, measured from RUN START (relSec resets on each `start`) — not from site
      // lock, because "built within ten minutes" is a question about the run, and lock time is one of the
      // costs it is asking about. MISSED is asserted only when it can no longer change: an unfinished
      // anchor past the deadline is already over it, while an unfinished one inside it is PENDING and
      // must not be scored (Law 25 — never a verdict the evidence has not earned).
      if (deadlineSec !== null) {
        const verdict = a.done !== null
          ? (a.done <= deadlineSec ? `✅ MET — done at [${relativeTime(a.done)}], ${relativeTime(deadlineSec - a.done)} to spare`
                                   : `❌ MISSED — done at [${relativeTime(a.done)}], ${relativeTime(a.done - deadlineSec)} over`)
          : (maxRel > deadlineSec ? `❌ MISSED — not complete, and the run is already at [${relativeTime(maxRel)}]`
                                  : `⏳ PENDING — not complete, ${relativeTime(deadlineSec - maxRel)} of the budget left`);
        console.log(`             ⇒ deadline ${relativeTime(deadlineSec)} for anchor ${idx}: ${verdict}`);
      }
    }
    // An anchor that never posted a gate AND never completed leaves no row above, so a deadline asked
    // about it would silently print nothing — a missing verdict reading exactly like a passing one.
    if (deadlineSec !== null && !s.anchors.has(0)) {
      console.log(`             ⇒ deadline ${relativeTime(deadlineSec)} for anchor 0: ` +
        `${maxRel > deadlineSec ? '❌ MISSED' : '⏳ PENDING'} — NO anchor-0 line at all in this run ` +
        '(neither a materials gate nor a completion); the build never reached it');
    }

    if (s.first) {
      console.log(`  [${relativeTime(s.first.t)}]  ⭑ FIRST PLACEMENT — ${s.first.c}/${s.total} placed  (${s.first.by})`);
      console.log(`             ⇒ ${relativeTime(s.first.t - (s.locked || 0))} from site lock to the first block in the ground`);
    } else {
      console.log(`  ──        FIRST PLACEMENT: NOT YET — ${s.last ? `${s.last.c}/${s.total} at [${relativeTime(s.last.t)}]` : 'no integrity scan seen'} after ${relativeTime(maxRel)}`);
    }
    if (s.last && s.first) console.log(`  [${relativeTime(s.last.t)}]  latest scan — ${s.last.c}/${s.total} placed`);
    console.log('');
  }
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

const TORCH_OK_RE     = /\bcrafted (\S+) x(\d+) → (\S+) have=(\d+)\/(\d+)/;
const TORCH_BAD_RE    = /\bcraft (PARTIAL|FAILED) (\S+) x(\d+) → (\S+) have=(\d+)\/(\d+)/;
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
const TORCH_MADE_RE   = /\bcraft \d+→\d+\/\d+ \(\+(\d+)\)/;

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
    if ((m = l.raw.match(TORCH_OK_RE))) {
      // Either name may be the torch: the request is logged as asked for, the progress tag as the
      // recipe resolved it, and a rename on either side must not make the craft invisible.
      if (/torch/i.test(m[1]) || /torch/i.test(m[3])) {
        const d = l.raw.match(TORCH_MADE_RE);
        crafts.push({ t: l.relSec, bot: l.bot, outcome: 'CRAFTED', qty: +m[2], have: +m[4], target: +m[5], made: d ? +d[1] : +m[2] });
      }
    } else if ((m = l.raw.match(TORCH_BAD_RE))) {
      if (/torch/i.test(m[2]) || /torch/i.test(m[4])) {
        const d = l.raw.match(TORCH_MADE_RE);
        // A FAILED batch carries no delta because nothing was made; 0 is the read, not a defaulted
        // field (Law 13 — the absence here is the fact, and the line says so in words as well).
        crafts.push({ t: l.relSec, bot: l.bot, outcome: m[1], qty: +m[3], have: +m[5], target: +m[6], made: d ? +d[1] : 0 });
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

  console.log(`trace_monitor · torch clock · ${traceName} · latest run · span [${relativeTime(maxRel)}]${botFilter ? ` · bot=${botFilter}` : ''}`);
  console.log('(first-occurrence clock for the torch chain — reports what happened; the numbers are printed, not judged)\n');

  const productive = crafts.filter(c => c.made > 0);
  const first = productive[0];
  console.log('FIRST TORCH CRAFT');
  if (first) {
    // The batch outcome rides ALONGSIDE the time rather than deciding whether there is one to print. A
    // partial that made four torches answers "when was the first torch crafted" completely, and it also
    // has to say it was short — both facts, neither suppressing the other.
    const short = first.outcome === 'CRAFTED' ? '' : `  —  batch ${first.outcome}, asked ${first.qty}, ${first.target - first.have} still short`;
    console.log(`  [${relativeTime(first.t)}]  ⭑ FIRST TORCH — ${first.made} made → have=${first.have}/${first.target}  (${first.bot})${short}`);
    const total = productive.reduce((s, c) => s + c.made, 0);
    const last = productive[productive.length - 1];
    if (productive.length > 1) console.log(`             ⇒ ${productive.length} productive craft(s), ${total} torch(es); the last at [${relativeTime(last.t)}] → have=${last.have}/${last.target}`);
  } else {
    // NOT-YET is reported as not-happened rather than as a zero: a run that crafted no torch and a run
    // that crafted zero torches are the same number and completely different facts (Law 25).
    console.log(`  ──        NOT YET — no craft anywhere in this run produced a torch (span ${relativeTime(maxRel)})`);
  }
  // Every craft outcome that produced nothing, listed under the headline rather than in place of it.
  for (const f of crafts.filter(c => c.made === 0)) {
    console.log(`  [${relativeTime(f.t)}]  ⚠️ craft ${f.outcome} torch x${f.qty} — nothing made, have=${f.have}/${f.target}  (${f.bot})`);
  }
  if (deadlineSec !== null) {
    const verdict = first
      ? (first.t <= deadlineSec ? `✅ MET — crafted at [${relativeTime(first.t)}], ${relativeTime(deadlineSec - first.t)} to spare`
                                : `❌ MISSED — crafted at [${relativeTime(first.t)}], ${relativeTime(first.t - deadlineSec)} over`)
      // MISSED is asserted only once it can no longer change; inside the window it is PENDING and must
      // not be scored, exactly as runMilestones treats an unfinished anchor.
      : (maxRel > deadlineSec ? `❌ MISSED — no torch, and the run is already at [${relativeTime(maxRel)}]`
                              : `⏳ PENDING — no torch yet, ${relativeTime(deadlineSec - maxRel)} of the budget left`);
    console.log(`             ⇒ deadline ${relativeTime(deadlineSec)} for the first torch: ${verdict}`);
  }
  console.log('');

  console.log('THE ORDER ON THE BOARD');
  if (order) {
    console.log(`  [${relativeTime(order.firstT)}]  first posted — ${order.firstLane} supply/torch (need:${order.firstNeed})`);
    if (order.lastT !== order.firstT || order.lastNeed !== order.firstNeed || order.lastLane !== order.firstLane) {
      console.log(`  [${relativeTime(order.lastT)}]  last  posted — ${order.lastLane} supply/torch (need:${order.lastNeed})`);
    }
  } else {
    console.log('  ──        the torch job never reached the board in this run — no posting in any band');
    console.log('            (a job held by a gate is posted as GATED below, not as a board row)');
  }
  console.log('');

  console.log('GATES ON THE TORCH JOB — in order of first appearance');
  if (!gateOrder.length) {
    console.log('  ──        no gate post ever named a torch job in this run');
  } else {
    for (const key of gateOrder) {
      const g = gates.get(key);
      console.log(`  [${relativeTime(g.first)} → ${relativeTime(g.last)}]  x${g.n}  GATED ${g.reason} — ${g.why}  (${g.job})`);
      console.log(`             short: ${g.shortFirst}${g.shortLast !== g.shortFirst ? `  →  ${g.shortLast} (last)` : ''}`);
    }
    // THE HANDOFF IS THE POINT. One gate opening and a different one closing behind it is the single
    // fact a gate-count cannot show, and it is what separates "the fix did nothing" from "the fix
    // worked and something else stopped it" — the two readings a redesigned gate has to be told apart.
    const reasons = [...new Set(gateOrder.map(k => gates.get(k).reason))];
    if (reasons.length > 1) console.log(`  ⇒ the gate REASON changed ${reasons.length - 1} time(s): ${reasons.join(' → ')}`);
    else console.log(`  ⇒ one gate reason for the whole run: ${reasons[0]}`);
  }
  console.log('');
}

module.exports = { runMilestones, runTorchClock };
