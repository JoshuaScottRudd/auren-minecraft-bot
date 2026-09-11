// Auren_Bot/monitoring/job_timeline_lens.js
// WHAT THE FLEET DID, IN ORDER, AND WHAT EACH JOB COST.
//
// Architect 2026-08-13: *"i want to know everytime a bot picks a job, and how long it takes in order.
// so build a lense and modify watcher logs if needed, to give me a overall arching story of what the
// bots did and how long each job takes… so when you ask the lense, it should report everything the
// fleet did in order, timestamped by job and duration of job."*
//
// ── WHY NOTHING WAS ADDED TO THE WATCHER ────────────────────────────────────────────────────────────
// He offered the modification and it was not needed, which is worth stating rather than leaving as an
// absence. Both ends of a job are already summary lines the fleet writes on every lap:
//   START   dispatcher      `Claimed [blueprint/build] build/headframe (need: 3) — dispatching to building_manager.`
//   END     recursive_judge `… Routing to job_board …`  (the seat released — his own suggested terminus)
//   or      building_manager `… COMPLETE …`             (a managed job's own verdict, which lands first)
//   or      recursive_judge `⏸️ … PLANNER HALTED …`      (killed; the job ends and nothing replaces it)
// A new emit would have been a second record of a thing already recorded — the redundant pathway Law 16
// forbids, and one more line per job on a trace that already carries thousands. What was missing was a
// READER, which is the standing rule's own case: if the monitor cannot answer the question, the monitor
// is the defect. `trace_read.buildEpisodes` already paired claim→verdict for `--story`; it gained an
// `endRelSec` and a close on the judge's release, and this file is the arithmetic over the result.
//
// ── WHY THE JUDGE'S RELEASE AND NOT THE NEXT CLAIM ──────────────────────────────────────────────────
// Nine job types dispatch straight to a one-shot executor and never log a manager verdict (furnace,
// dump, torch, canopy, salvage, explore, the two startup locks, wood preference). Their episodes used
// to run on until the bot claimed something else, which folded the plan cycle AFTER the job into the
// job's own duration. Measuring to the judge separates the two, and the gap between them is reported on
// its own line as BETWEEN JOBS — it is a real cost (board assessment, the planning token, the walk to
// nothing) and hiding it inside the previous job would overstate every one-shot in the table.
//
// ── WHAT THIS LENS REFUSES TO DO ────────────────────────────────────────────────────────────────────
// It passes no verdict on a duration. There is no "too slow" threshold here and there must not be one:
// what counts as long for a job is the ASKER's number (Law 25), and he has not set one — he asked to
// SEE the run. `--milestones --deadline=10m` is where a criterion belongs, because he supplied it there.
// This reports elapsed time, share of the run, and the worst instance, and lets the reader judge.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --jobs [--bot=AurenBot] [--all]

'use strict';

const { relativeTime, padRight, padLeft, percent } = require('./report_formatting');
const { buildEpisodes, jobToken, OVERSEER_UNITS } = require('./trace_read');

// How many rows the by-type table prints before folding the tail into one counted line. A run claims a
// few dozen distinct tokens; the reader is looking for where the time went, and the bottom of that list
// is by definition where it did not. --all prints every row.
const TYPE_ROWS = 14;

// The idle span between one job's release and the next claim by the SAME bot. Millisecond clock when
// both ends carry one, whole seconds otherwise; null when the two cannot be compared at all, because a
// gap that could not be measured must not be reported as a gap of zero (Law 25).
function gapBefore(prevEnd, job) {
  if (!prevEnd) return null;
  if (prevEnd.ms != null && job.startMs != null) return Math.max(0, (job.startMs - prevEnd.ms) / 1000);
  if (prevEnd.sec != null && job.startSec != null) return Math.max(0, job.startSec - prevEnd.sec);
  return null;
}

// ── THE ARITHMETIC (machine-facing: returns, prints nothing, exits nothing) ──────────────────────────
// Exported beside the renderer under this folder's two rules — a lens that a program calls RETURNS, a
// lens a person calls renders, and neither is the other wearing a flag.
function reduceJobTimeline({ seg = [], bot: botFilter = null } = {}) {
  const episodes = buildEpisodes(seg)
    .filter(ep => !botFilter || ep.bot === botFilter)
    .filter(ep => ep.relSec != null);

  // Prefer the ISO delta: the relative `[Nm Ss]` stamp is whole seconds, so a 400ms job and a 1.4s job
  // both read as "1s" and a table of forty of them is wrong by up to forty seconds. Fall back to the
  // relative stamps when a line carried no parseable ISO, and mark the row so the fallback is visible
  // rather than silently mixed in (Law 25 — a measurement and an estimate must not print alike).
  const jobs = episodes.map(ep => {
    const startMs = ep.iso ? Date.parse(ep.iso) : NaN;
    const endMs = ep.endIso ? Date.parse(ep.endIso) : NaN;
    const exact = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
    const durationSec = exact
      ? (endMs - startMs) / 1000
      : (ep.endRelSec != null ? Math.max(0, ep.endRelSec - ep.relSec) : null);
    const fails = ep.events.filter(e => e.kind === 'fail').length;
    const warns = ep.events.filter(e => e.kind === 'warn').length;
    const errs = ep.events.filter(e => e.kind === 'err').length;
    return {
      bot: ep.bot,
      token: jobToken(ep.claimed),
      claimed: ep.claimed,
      // The rank AS THE BOARD STATED IT — `[bot/craft]` today, `P14` in a run recorded before the board
      // began publishing its coordinates. Both are read because both are on disk and a lens that
      // understands only the current shape reports `?` for every job in an older run while looking like
      // it worked (Law 25 — a monitor's own output is an outcome signal).
      rank: (ep.claimed.match(/^\[([^\]]*)\]/) || [])[1]
         ?? (ep.claimed.match(/^(P\d+)/) || [])[1]
         ?? null,
      manager: ep.manager,
      startSec: ep.relSec,
      endSec: ep.endRelSec,
      // Carried alongside the relative stamps so the GAP between two jobs is measured on the same clock
      // as the jobs themselves. Mixing them made every gap print as a flat 1.0s/2.0s — the whole-second
      // stamps rounding a sub-second plan cycle up to a full one, on a row whose entire purpose is to
      // show how much of the run was not work.
      startMs: Number.isFinite(startMs) ? startMs : null,
      endMs: Number.isFinite(endMs) ? endMs : null,
      durationSec,
      exact,
      verdict: ep.verdict,
      steps: ep.events.filter(e => e.kind === 'ok').length,
      fails, warns, errs,
    };
  }).sort((a, b) => a.startSec - b.startSec || a.bot.localeCompare(b.bot));

  // Per bot: working time, the gaps between jobs, and the run span it all sits in. The gap is computed
  // from THIS bot's own consecutive jobs — a fleet-wide gap would be meaningless with two bots working
  // in parallel, and a gap measured against the run's end would call a bot that finished early idle.
  const byBot = new Map();
  for (const j of jobs) {
    let b = byBot.get(j.bot);
    if (!b) { b = { bot: j.bot, jobs: 0, workingSec: 0, gapSec: 0, firstSec: j.startSec, lastSec: null, prevEnd: null, longest: null, killed: 0 }; byBot.set(j.bot, b); }
    b.jobs++;
    if (j.durationSec != null) b.workingSec += j.durationSec;
    j.gapBeforeSec = gapBefore(b.prevEnd, j);
    if (j.gapBeforeSec != null) b.gapSec += j.gapBeforeSec;
    if (j.endSec != null) { b.prevEnd = { sec: j.endSec, ms: j.endMs }; b.lastSec = j.endSec; }
    if (j.durationSec != null && (!b.longest || j.durationSec > b.longest.durationSec)) b.longest = j;
    if (j.verdict && /KILLED/.test(j.verdict.text)) b.killed++;
  }

  // Per job token: the answer to "where did the run go".
  //
  // ── KEYED ON RANK *AND* TOKEN, BECAUSE ONE VERB AT TWO RANKS IS TWO DECISIONS ────────────────────
  // `jobToken` strips the rank prefix, so `supply/logs` claimed as the headframe's own gather would
  // otherwise merge with `supply/logs` claimed for the standing shelf — and which of the two ate the run
  // is precisely what a reader opens this lens to find out. Merging them would turn a real answer into a
  // coarser one silently (Law 25).
  //
  // THE KEY IS THE COORDINATES, NOT THE INTEGER, and that is a gain rather than a translation. The rank
  // is composed per sweep now, so the same decision can carry different integers on two consecutive
  // boards — keying on the number would split one job's history into several rows for no reason a reader
  // could see. `bot/craft` is the decision itself and is stable across the sweeps that made it.
  const byType = new Map();
  for (const j of jobs) {
    const key = `${j.rank ?? '?'} ${j.token}`;
    let t = byType.get(key);
    if (!t) { t = { token: key, claims: 0, totalSec: 0, worst: null, complete: 0, killed: 0, unfinished: 0 }; byType.set(key, t); }
    t.claims++;
    if (j.durationSec != null) t.totalSec += j.durationSec;
    if (j.durationSec != null && (!t.worst || j.durationSec > t.worst.durationSec)) t.worst = j;
    if (j.verdict?.ok === true) t.complete++;
    else if (j.verdict && /KILLED/.test(j.verdict.text)) t.killed++;
    else if (j.verdict && /still running/.test(j.verdict.text)) t.unfinished++;
  }

  const workedSec = jobs.reduce((s, j) => s + (j.durationSec || 0), 0);
  return {
    jobs,
    byBot: [...byBot.values()],
    byType: [...byType.values()].sort((a, b) => b.totalSec - a.totalSec),
    workedSec,
    spanSec: jobs.length ? Math.max(...jobs.map(j => j.endSec ?? j.startSec)) : 0,
    inexact: jobs.filter(j => !j.exact && j.durationSec != null).length,
  };
}

// Seconds → the trace's own `Nm Ns`, but sub-minute durations keep one decimal. A job table is mostly
// short rows, and `0m 1s` against `0m 1s` hides the difference between a 600ms claim and a 1.4s one —
// which is exactly the comparison the reader is making when he scans this column.
function duration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return relativeTime(Math.round(sec));
}

// ── THE WOOD LEDGER ─────────────────────────────────────────────────────────────────────────────────
// Architect 2026-08-13: *"if you need another lens to see total gathered wood or add it to the jobs lens
// that would be great."* Added HERE rather than as its own lens because the question it exists to answer
// is a jobs question — the shell costs ~56 logs and one run spent 27% of itself delivering them, so the
// wood has to sit beside the time it cost. A second lens would make the reader correlate two outputs by
// hand to ask one question.
//
// WHAT IT CANNOT SAY, and says so rather than estimating (Law 25): **the trace never states a harvest's
// YIELD.** `Tree path: gathering 25x logs` is the ASK, and tree_feller's claim line is one tree taken,
// not the number of logs it produced. So "gathered" is reported as trees felled and as wood ARRIVING IN
// CHESTS — both directly observed — and never as a total invented by multiplying trees by an assumed
// yield. A number that looks like a measurement and is actually a guess is the failure this lens is for.
//
// The craft column is labelled "steps posted" for the same reason: `→ craft 4x planks` is a plan step
// announced by supply_manager, and a job that re-enters after a replan announces it again. It is a
// faithful count of what was ANNOUNCED, which is not the same as what was made.
const WOOD_ITEM  = /^(oak_log|logs?|planks?|sticks?)$/;
const TREE_CLAIM = /\[TREE_FELLER\].*Claimed logs at \(-?\d+,-?\d+,-?\d+\) of (\d+)/;
const DEPOSIT    = /deposit (\d+)x (\w+)\s*→/;
const WITHDRAW_B = /withdrew (\d+)x (\w+) from storage/;
const WITHDRAW_S = /Withdrawing (\d+)x (\w+) from staging chest/;
const CRAFT_STEP = /→ craft (\d+)x (\w+)/;
const POCKET     = /planks=(\d+) logs=(\d+)/;

function reduceWoodLedger({ seg = [], bot: botFilter = null } = {}) {
  const perBot = new Map();
  const seat = b => {
    if (!perBot.has(b)) perBot.set(b, { bot: b, trees: 0, into: {}, outOfStorage: {}, outOfStaging: {}, craftSteps: {}, peakLogs: 0 });
    return perBot.get(b);
  };
  // The fleet writes one material under two names — inventory_swapper deposits `oak_log` (the block id)
  // while supply_manager and preconstruction speak in `logs` (the recipe root). Unmerged, the ledger
  // prints "80x oak_log, 14x logs" and every reader adds 94 by hand, every time.
  const canon = item => (/^(oak_log|logs?)$/.test(item) ? 'logs' : /^planks?$/.test(item) ? 'planks' : /^sticks?$/.test(item) ? 'stick' : item);
  const add = (o, k, n) => { const c = canon(k); o[c] = (o[c] || 0) + n; };
  let censusFirst = null, censusLast = null;

  for (const l of seg) {
    if (!l.bot || OVERSEER_UNITS.has(l.bot)) continue;
    if (botFilter && l.bot !== botFilter) continue;
    const s = seat(l.bot);
    let m;
    // Read the pocket BEFORE the match chain, never inside it: supply_manager prints `planks=0 logs=3`
    // on the SAME line as `→ craft 4x planks`, so a chain that continues on the craft match reports
    // every bot as having peaked at zero logs. It did, on the first run of this lens.
    if ((m = POCKET.exec(l.raw))) s.peakLogs = Math.max(s.peakLogs, Number(m[2]));
    if ((m = TREE_CLAIM.exec(l.raw))) {
      s.trees++;
      if (censusFirst == null) censusFirst = Number(m[1]);
      censusLast = Number(m[1]);
      continue;
    }
    if ((m = DEPOSIT.exec(l.raw)))    { if (WOOD_ITEM.test(m[2])) add(s.into, m[2], Number(m[1])); continue; }
    if ((m = WITHDRAW_B.exec(l.raw))) { if (WOOD_ITEM.test(m[2])) add(s.outOfStorage, m[2], Number(m[1])); continue; }
    if ((m = WITHDRAW_S.exec(l.raw))) { if (WOOD_ITEM.test(m[2])) add(s.outOfStaging, m[2], Number(m[1])); continue; }
    if ((m = CRAFT_STEP.exec(l.raw))) { if (WOOD_ITEM.test(m[2])) add(s.craftSteps, m[2], Number(m[1])); continue; }
  }

  const bots = [...perBot.values()].sort((a, b) => a.bot.localeCompare(b.bot));
  const sum = pick => bots.reduce((acc, s) => {
    for (const [k, v] of Object.entries(pick(s))) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});
  return {
    bots,
    trees: bots.reduce((n, s) => n + s.trees, 0),
    censusFirst, censusLast,
    into: sum(s => s.into),
    outOfStorage: sum(s => s.outOfStorage),
    outOfStaging: sum(s => s.outOfStaging),
    craftSteps: sum(s => s.craftSteps),
  };
}

const tally = o => {
  const parts = Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}x ${k}`);
  return parts.length ? parts.join(', ') : 'none';
};

const VERDICT_GLYPH = v => (!v ? '·' : v.ok === true ? '✔' : v.ok === false ? '✗' : /KILLED/.test(v.text) ? '⛔' : '⋯');

function runJobTimeline({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const r = reduceJobTimeline({ seg, bot: botFilter });

  console.log(`trace_monitor · jobs · ${traceName} · latest run · span [${relativeTime(r.spanSec)}]${botFilter ? ` · bot=${botFilter}` : ''}`);
  console.log('(context only — never flags, never wakes. Every job a bot claimed, in dispatch order, from the');
  console.log(' dispatcher\'s claim to the judge releasing the seat. No duration here is judged against any');
  console.log(' threshold — set a criterion with --milestones --deadline if you want one scored.)\n');

  if (!r.jobs.length) {
    console.log('(no dispatcher claim lines in the latest run — nothing has been picked up yet)');
    return r;
  }
  if (r.inexact) {
    console.log(`⚠ ${r.inexact} row(s) timed from the trace's whole-second stamps rather than its millisecond `
      + 'ones (a line arrived without a parseable ISO). Those durations are rounded, not exact.\n');
  }

  // ── The story, in order ──
  console.log('━━ THE FLEET IN ORDER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const j of r.jobs) {
    // The gap BEFORE this job, printed as its own row so it can never be mistaken for work. This is the
    // planning cycle (board assessment + the token + whatever the bot did while holding no job) — the
    // cost that used to hide inside the previous one-shot's duration. Computed in the reducer so the
    // rendered row and the per-bot total can never disagree about it (Law 16).
    if (j.gapBeforeSec != null && j.gapBeforeSec >= 0.5) {
      console.log(`  ${padRight('', 9)} ${padLeft(duration(j.gapBeforeSec), 7)}  ${padRight(j.bot, 10)} ·  (between jobs)`);
    }
    const tail = j.verdict ? j.verdict.text : 'no verdict line';
    const trouble = [j.fails && `${j.fails} failed step(s)`, j.warns && `${j.warns} warn`, j.errs && `${j.errs} error`]
      .filter(Boolean).join(', ');
    console.log(
      `  [${padRight(relativeTime(j.startSec), 7)}] ${padLeft(duration(j.durationSec), 7)}  ${padRight(j.bot, 10)} `
      + `${padRight(`${j.rank ?? '?'} ${j.token}`, 38)} ${VERDICT_GLYPH(j.verdict)} ${padRight(tail, 22)}`
      + `${j.steps ? ` ${j.steps} step(s)` : ''}${trouble ? `  ⚠ ${trouble}` : ''}`);
  }

  // ── Where the time went ──
  console.log('\n━━ WHERE THE TIME WENT — by job ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${padRight('job', 34)} ${padLeft('claims', 6)} ${padLeft('total', 8)} ${padLeft('mean', 8)} ${padLeft('worst', 8)} ${padLeft('share', 6)}  outcomes`);
  const rows = verbose ? r.byType : r.byType.slice(0, TYPE_ROWS);
  for (const t of rows) {
    const outcomes = [
      t.complete && `${t.complete} complete`,
      t.killed && `${t.killed} KILLED`,
      t.unfinished && `${t.unfinished} unfinished at trace end`,
    ].filter(Boolean).join(', ');
    console.log(
      `  ${padRight(t.token, 34)} ${padLeft(t.claims, 6)} ${padLeft(duration(t.totalSec), 8)} `
      + `${padLeft(duration(t.totalSec / t.claims), 8)} ${padLeft(duration(t.worst?.durationSec), 8)} `
      + `${padLeft(percent(t.totalSec, r.workedSec), 6)}  ${outcomes}`);
    if (t.worst) console.log(`  ${padRight('', 34)} ${padLeft('', 6)} worst at [${relativeTime(t.worst.startSec)}] — ${t.worst.bot}, ${t.worst.verdict?.text || 'no verdict'}`);
  }
  if (rows.length < r.byType.length) {
    const rest = r.byType.slice(rows.length);
    console.log(`  … +${rest.length} more job type(s) totalling ${duration(rest.reduce((s, t) => s + t.totalSec, 0))}  (--all prints them)`);
  }

  // ── Per bot ──
  console.log('\n━━ PER BOT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const b of r.byBot) {
    const covered = b.workingSec + b.gapSec;
    console.log(`  ${padRight(b.bot, 10)} ${padLeft(b.jobs, 4)} job(s)   working ${duration(b.workingSec)} (${percent(b.workingSec, covered)})`
      + `   between jobs ${duration(b.gapSec)} (${percent(b.gapSec, covered)})`
      + `   first claim [${relativeTime(b.firstSec)}]${b.killed ? `   ⛔ ${b.killed} KILLED` : ''}`);
    if (b.longest) console.log(`  ${padRight('', 10)} longest: ${b.longest.token} ${duration(b.longest.durationSec)} at [${relativeTime(b.longest.startSec)}] → ${b.longest.verdict?.text || 'no verdict'}`);
  }
  // ── The wood ledger ──
  const w = reduceWoodLedger({ seg, bot: botFilter });
  console.log('\n━━ THE WOOD LEDGER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  (observed movements only — the trace never states a harvest\'s YIELD, so nothing here is a');
  console.log('   tree count multiplied by an assumed logs-per-tree.)');
  console.log(`  TREES FELLED       ${w.trees}${w.censusFirst != null ? `   · standing census ${w.censusFirst} → ${w.censusLast}` : ''}`);
  console.log(`  INTO CHESTS        ${tally(w.into)}`);
  console.log(`  OUT OF STORAGE     ${tally(w.outOfStorage)}        (a bot taking wood back out to use it)`);
  console.log(`  OUT OF STAGING     ${tally(w.outOfStaging)}        (preconstruction pulling it to place)`);
  console.log(`  CRAFT STEPS POSTED ${tally(w.craftSteps)}        (announced, and re-announced on replan)`);
  for (const s of w.bots) {
    console.log(`    ${padRight(s.bot, 10)} ${padLeft(s.trees, 3)} tree(s) · in ${tally(s.into)} · out ${tally({ ...s.outOfStorage })} storage / ${tally({ ...s.outOfStaging })} staging · peak ${s.peakLogs} logs in pocket`);
  }

  console.log('');
  return { ...r, wood: w };
}

// ── HAS THE CREW RUN OUT OF WORK? (machine-facing: returns, prints nothing, exits nothing) ──────────
//
// The one fact a run supervisor needs to know when a contractor test is OVER. A conducted run ends on
// its window (test_conductor's one terminator, and that is right for a soak — a soak measures how long
// a fleet stays up). A "does the standard procedure complete" run is asking the opposite question, and
// its answer is an EVENT rather than a duration: the crew took its work, finished it, and reports
// nothing outstanding. Nobody knows in advance how many minutes that is, and a window guessed at is
// either a false failure or a long wait after the answer arrived.
//
// TWO CLAUSES, AND THE FIRST ONE IS WHAT MAKES IT HONEST. A bot that never started is also "not
// working", and its trace is also free of any claim — so idleness alone would report a fleet that never
// woke up as one that finished everything, which is a false success flag on an unearned criterion
// (Law 25). A bot counts as finished only if it CLAIMED at least one job and its LAST dispatcher
// decision was the empty-board verdict. A supervisor that stops on this has watched work happen.
//
// It reads the dispatcher's own two lines and adds nothing to the fleet: the claim line the timeline
// above already pairs on, and the idle verdict `_goIdle` posts with its cause. A new emit for a
// supervisor to poll would be a second record of a decision already recorded (Law 16), and the standing
// rule points the other way — the reader is the thing that was missing.
// THE DISPATCHER HAS FOUR IDLE VERDICTS AND ONLY TWO OF THEM MEAN FINISHED. Reading one and calling it
// the answer is what a first version of this did, and it left a crew standing in a world with nothing
// left to do while the supervisor waited out its whole cap (Architect 2026-08-31: *"it says idle no
// jobs to run. so why hasnt the server shut down?"*).
//
//   nothing_outstanding  the board is empty                                      → FINISHED
//   none_for_species     the board's remainder is outside this species' magnet   → FINISHED for this bot:
//                        nothing on it can ever become claimable by standing here longer. A contractor
//                        left with only `busywork` is done and waiting to be asked for something.
//   all_gated            work EXISTS and a gate holds it (night, a missing item) → NOT finished; the gate
//                        opens on its own and the bot resumes. Ending here would report a crew that ran
//                        out of work when it was waiting for dawn.
//   claimed_by_peers     a partner holds everything this magnet attracts         → NOT finished, and the
//                        all-bots rule below already covers it: the partner's own last decision is a
//                        claim, so the crew reads as working, which it is.
const CLAIM_RE = /\[DISPATCHER\][^]*Claimed \[/i;

// A HALTED PLANNER IS THE OTHER WAY A RUN IS OVER, and it is not a kind of idle (Architect 2026-08-31:
// *"why isnt the conductor shutting the test down on a judge kill?"*). When the judge kills a fragment
// it drops the planning signal and the body holds a sentry watch — the recursive_judge's own words are
// "Nothing PLANS again until an operator re-tasks it." No gate opens for it, no peer frees anything, and
// no amount of waiting changes it. A run that keeps waiting through one burns its whole window on a bot
// that is definitionally finished; this happened, for twenty minutes, on the run that produced this.
//
// It is TERMINAL, NOT FINISHED, and the two must never collapse into one word. "Stood down" means the
// crew did its work and ran out; "halted" means a mind has to look. Reporting a halt as a stand-down
// would be the false success flag Law 25 exists to name — the run ends either way, and only the reason
// tells a reader whether anything was accomplished.
const HALT_RE = /\[RECURSIVE_JUDGE\][^]*PLANNER HALTED/i;

function reduceCrewStanding({ seg = [], bots = [] } = {}) {
  const perBot = {};
  for (const id of bots) perBot[id] = { bot: id, claims: 0, lastDecision: null, lastRelSec: null, halted: false, haltedAtRelSec: null };

  for (const line of seg) {
    const state = perBot[line.bot];
    if (!state) continue;                       // a bot this run did not fetch is not this run's business
    const text = line.raw || '';
    let decision = null;
    // The CAUSE is kept, not collapsed onto "finished". Two verdicts end a run and they are not the same
    // fact — an empty board and a board holding only work this species cannot take mean different things
    // to whoever reads the report, and printing one name for both is a report that is true about the
    // outcome and false about the reason (Law 25).
    // A halt is LATCHED, not a decision that a later line replaces. The body keeps a sentry watch after
    // one and goes on writing lines about quiet passes, so treating it as the newest verdict would let
    // ordinary watch chatter erase the one fact that ends the run.
    if (HALT_RE.test(text)) {
      state.halted = true;
      state.haltedAtRelSec = line.relSec ?? state.haltedAtRelSec;
      continue;
    }
    if (CLAIM_RE.test(text)) { state.claims++; decision = 'working'; }
    else if (/No jobs outstanding/i.test(text)) decision = 'nothing_outstanding';
    else if (/Nothing on the board this species may claim/i.test(text)) decision = 'none_for_species';
    else if (/No jobs CLAIMABLE/i.test(text)) decision = 'all_gated';
    else if (/All jobs this magnet attracts are claimed/i.test(text)) decision = 'claimed_by_peers';
    if (decision) { state.lastDecision = decision; state.lastRelSec = line.relSec ?? state.lastRelSec; }
  }

  const DONE = new Set(['nothing_outstanding', 'none_for_species']);
  const rows = bots.map(id => perBot[id]);
  const finished = rows.filter(r => r.claims > 0 && DONE.has(r.lastDecision));
  const halted = rows.filter(r => r.halted);
  return {
    bots: rows,
    // ANY of them, where finishing takes ALL of them — and the asymmetry is the point. A crew shares one
    // board, so one bot standing while its partner works is a crew mid-job; but one bot with its planner
    // dropped is a crew that can never finish, because nothing will re-task it and its share of the work
    // is simply never done. One is a reason to keep waiting, the other is a reason to stop.
    anyHalted: halted.length > 0,
    halted: halted.map(r => r.bot),
    // ALL of them, not any: a crew shares one board, so one bot standing while its partner is still
    // carrying logs is a crew mid-job, not a crew finished.
    allFinished: rows.length > 0 && finished.length === rows.length,
    finished: finished.map(r => r.bot),
    working:  rows.filter(r => !(r.claims > 0 && DONE.has(r.lastDecision))).map(r => r.bot),
  };
}

module.exports = { reduceJobTimeline, reduceWoodLedger, runJobTimeline, reduceCrewStanding };
