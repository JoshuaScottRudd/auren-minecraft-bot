// Auren_Bot/monitoring/chain_lenses.js
// THE SUPPLY-AND-CONSEQUENCE CHAINS, each read end to end.
//
// ── WHY THESE THREE ARE ONE FILE, AND WHY THEY LEFT trace_monitor ────────────────────────────────────
// Each one reduces a chain that spans three or four owners — job_board posts, a manager routes, an
// executor works the block — and answers ONE question about it: did the chain close. That is a different
// verb from trace_monitor's own (find what went wrong in a run), and it is the verb all three share.
// They flag nothing, wake nobody, and never touch a signature or the watch policy.
//
// The split follows the combat_lens precedent exactly: a lens takes its inputs as ARGUMENTS, RENDERS,
// and RETURNS. It never reads process.argv and never calls process.exit — a library that exits kills its
// caller mid-run, which is the trap the old shape set. trace_monitor is the CLI; it reads the trace once,
// segments it, and hands the run's lines down.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --compost [--bot=B] [--all]

'use strict';

const { relativeTime } = require('./trace_read');

// ── --compost : did the composter chain actually run? ────────────────────────────────────────────
//
// WHY A LENS. Compost has no job, no claim and no dispatch — it happens inside inventory_swapper's dump,
// which means it leaves no trace of its own on the board and cannot be seen in a job tally at all. The
// reducer that says whether the chain CLOSED — compostables in, bone meal out — is the only way to ask
// whether the feature worked. Reading it by hand is the thing the standing rule forbids, and the answer
// would die with the session.
//
// COMPOSTING HAS NO JOB OF ITS OWN, so no claim, route, or per-decline verdict can describe it — a counter
// built for a pathway that can never fire would read as a fault on every single run. The only per-visit
// facts are the pair that decides everything: FED (the dump got there) and HELD (it could not, and the
// material rode along). A run with high HELD and zero FED is the composter missing or permanently locked —
// which a job-shaped tally could never show, because the errand is never claimed in the first place.
//
// THE PRECONDITION IS THE HEADLINE, and it is why this lens leads with it rather than with a tally.
// The composter is voxel [-5,2,1] of headframe ANCHOR 1 (114 voxels), not anchor 0. Until anchor 1 is
// built there is no block, the dump holds everything, and the whole subsystem is correctly invisible. A
// run that reports "0 compost activity" is therefore ambiguous between *the chain is broken* and *the
// chain was never reachable* — so this lens states which, and never lets a silent zero read as a verdict
// (Law 25). Cross-read with --milestones for when anchor 1 landed.
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
    const touch = (b, what) => {
      if (b.firstAt === null) b.firstAt = l.relSec;
      b.lastAt = l.relSec;
      if (what) b.timeline.push({ t: l.relSec, what });
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
      touch(b, `fed ${m[1]}, ${m[3]}→${m[4]}${m[2] ? `, +${m[2]} bone_meal` : ''}`);
    } else if ((m = l.raw.match(CP_D_HELD_RE))) {
      // The dump reports the WHOLE held pocket every time, not a delta, so summing across cycles would
      // overcount the same held items repeatedly — a falsehood that looks like runaway accumulation
      // (Law 25). Last and peak, never a sum.
      const b = B(l.bot); b.held = +m[1]; b.heldPeak = Math.max(b.heldPeak, +m[1]); b.heldEvents++;
      b.heldReasons.set(m[2], (b.heldReasons.get(m[2]) || 0) + 1);
      touch(b, `⚠️ held ${m[1]} — ${m[2]}`);
    } else if ((m = l.raw.match(CP_X_QUEUE_RE))) {
      const b = B(l.bot); b.queued++; touch(b, `queued behind ${m[1]}`);
    } else if ((m = l.raw.match(CP_X_FREED_RE))) {
      const b = B(l.bot); b.queueWaitSec += +m[1]; touch(b, null);
    }
  }

  console.log(`trace_monitor · compost · ${traceName} · latest run · span [${relativeTime(maxRel)}]${botFilter ? ` · bot=${botFilter}` : ''}`);
  console.log('(context only — never flags, never wakes)\n');

  const totalHarvest = [...bots.values()].reduce((n, b) => n + b.harvested, 0);
  const totalFed = [...bots.values()].reduce((n, b) => n + b.fed, 0);

  if (!bots.size) {
    // The honest zero (Law 25). Not "the chain failed" — the chain was never reached, and the reader is
    // told which precondition to check rather than left to infer a verdict from an empty table.
    console.log('NO COMPOST ACTIVITY IN THIS RUN — nothing fed, nothing harvested, nothing held back.');
    console.log('  Composting is a side-errand of inventory_swapper.dumpExcess, so an empty section means');
    console.log('  NO SURPLUS COMPOSTABLE WAS EVER DUMPED — not that the composter was skipped. A bot');
    console.log('  holding saplings it could not place would appear here as HELD.');
    console.log('  The composter itself is voxel [-5,2,1] of headframe ANCHOR 1 (114 voxels), not anchor 0.');
    console.log('  Check the two preconditions in order:');
    console.log('    trace.ps1 --milestones          ← did headframe anchor 1 complete?');
    console.log('    trace.ps1 --story               ← did any dumpExcess run carry a COMPOST_INPUTS item?');
    console.log('  If both hold and this is still empty, the fault is in inventory_swapper.dumpExcess —');
    console.log('  its compost.isCompostable filter, or a chest deficit still absorbing the item first.');
    return;
  }

  const totalHeld = [...bots.values()].reduce((n, b) => n + b.held, 0);
  // Three verdicts, not two. NEVER REACHED is the one the old lens could not say: material existed, the
  // dump tried, and the block turned it away every time — which reads identically to "nothing to compost"
  // in any tally that only counts what got fed (Law 25).
  console.log(`VERDICT: ${totalHarvest > 0
    ? `CHAIN CLOSED — ${totalFed} item(s) in, ${totalHarvest} bone_meal out`
    : totalFed > 0
      ? `NOT CLOSED — ${totalFed} item(s) fed, 0 bone_meal harvested`
      : `NEVER REACHED — 0 item(s) fed, ${totalHeld} compostable(s) still in pockets (see HELD below for why)`}`);
  console.log('  (~30% of fed items raise a level; 8 levels = 1 bone meal, so a low harvest at low fed');
  console.log('   count is expected variance, not a defect. Bone meal out is the only success measure.)\n');

  for (const [id, b] of bots) {
    console.log(`${id}  ·  active [${relativeTime(b.firstAt)}] → [${relativeTime(b.lastAt)}]`);
    console.log(`  WORK        ${b.visits} visit(s), ${b.fed} item(s) fed, ⭑ ${b.harvested} bone_meal harvested`);
    // HELD is the row that replaced the unclaimed-errand tally, and it is the one to read first on a
    // disappointing run: material the dump wanted to compost and could not place. The reason is carried
    // verbatim from feedFromPocket, because the reasons demand opposite responses and would be
    // indistinguishable as a count: `composter_not_built_yet` is the build order working (the bin is a
    // later anchor than the chests, so a fresh world has a window with chests and no bin — expected, and
    // it ends by itself), `no_composter_in_blueprint` is a blueprint defect, and
    // `composter_lock_lost_to_peer` is contention that self-corrects. Only the middle one is anyone's to
    // act on, and a run where the first one persists past the base being finished is the real signal.
    if (b.heldEvents) {
      console.log(`  ⚠️ HELD      ${b.held} compostable(s) still held (peak ${b.heldPeak}) over ${b.heldEvents} dump(s) — ` +
        `${[...b.heldReasons].map(([r, n]) => `${r} ×${n}`).join(' · ')}`);
    }
    if (b.queued) console.log(`  QUEUE       waited behind a peer ${b.queued}× · ${b.queueWaitSec}s total`);
    if (b.level.last !== null) console.log(`  LEVEL       last ${b.level.last}/8 · seen ${b.level.min}–${b.level.max}`);
    const dec = Object.entries(b.declines).filter(([, n]) => n > 0);
    if (dec.length) console.log(`  DECLINED    ${dec.map(([k, n]) => `${k} ×${n}`).join(' · ')}`);
    if (verbose && b.timeline.length) {
      console.log('  timeline (--all):');
      for (const e of b.timeline) console.log(`    [${relativeTime(e.t)}]  ${e.what}`);
    }
    console.log('');
  }
  if (!verbose) console.log('(--all prints the per-event timeline)');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// --deaths WAS HERE AND IS DELETED. It reduced the death-pile chain: `☠️ Pile recorded` from
// death_pile_recorder, the board's `death_pile/retrieve` offers, and death_pile_executor's despawn
// timeouts — all three fragments deleted when salvage became a live ground scan
// (perception/ground_drop_scanner), so none of its patterns can ever match again.
//
// IT WAS DELETED RATHER THAN LEFT TO GO QUIET: a lens whose source vanished must not report nothing,
// since silence here reads as a false all-clear on a run that actually had deaths — worse than no
// instrument at all (Law 25), and a failure mode `preflight` cannot catch because the code still
// runs.
//
// WHERE THE QUESTION GOES NOW: `--combat` owns deaths and always did — it reads the combat journal, which
// no part of this change touched. What is genuinely lost is WHAT A DEATH COST (the item list), because
// nothing records a dying bot's inventory any more. That is a real gap, named here rather than papered
// over; the place to close it, if it is ever wanted, is the combat journal's own death row.
//
// --hunt WENT THE SAME WAY — the bed left the blueprint and the whole hunt chain was deleted.


module.exports = { runCompost };
