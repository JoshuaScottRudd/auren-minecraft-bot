// Auren_Bot/monitoring/engagement_lens.js
// THE FIGHT, TOLD BACK AS A STORY — one mob at a time, joined out of the three seats' event streams.
//
// ── THE RULING THAT BUILT THIS (Architect 2026-08-12) ────────────────────────────────────────────────
// He began by asking the COMMANDER to build the narrative live:
//
//   "commander has a special job to gather engagement data. so commander tracks where the aggroed
//    monsters are and builds a post mortiem report. so an example would be 'zombie ID# engaged AurenBot
//    12 blocks away. Auren locked on and engaged, zombie was attacked 2 seconds later once auren came
//    within range of 2.9 blocks. it captures every strike.... wait... hold on... lets do this instead.
//    well just add a lens that captures that data from the reports and builds it. therefore the commander
//    does have to build it real time it can be build after with a program that combines trace data"
//
// He withdrew it mid-sentence, and the withdrawal is the design. A commander assembling a narrative
// while it fights would be holding a growing per-mob history in a seat whose whole job is one sweep of
// the current world (Invariant B), and it would be paying for that history on every tick of every fight
// including the ones nobody ever reads. The story is a QUESTION ASKED AFTERWARD, so it is answered
// afterward, by a reducer that costs nothing until someone asks.
//
// ── WHY A LENS CAN SAY THINGS NO SEAT CAN ───────────────────────────────────────────────────────────
// Each seat owns one fact and may not speak for another (Invariant D), so nothing in the running fleet
// is allowed to JOIN them — and every interesting question about a fight is a join:
//   - aggro → first strike is the commander's fact and the gunner's fact, and the gap between them is
//     the number that says whether the feet got there.
//   - `notch state=on` with no `shield state=up` before it goes off is an arrow the guard never
//     answered. The commander knows about the arrow, the gunner knows about the guard, and NEITHER can
//     see the miss.
//   - `swell state=on` → the driver's `mode=swell_flee` is the fuse's reaction latency, and it is the
//     one number that says whether the creeper rule is actually protecting the body.
// A seat that computed any of these would be a second owner of somebody else's data. A lens computing
// them after the run is not — it owns nothing, changes nothing, and is read only when asked.
//
// ── THE RECORD IT READS AND THE ONE WAY IT MAY READ IT ──────────────────────────────────────────────
// It takes the trace's already-parsed lines from trace_monitor (the CLI is the only thing that touches
// process.argv or a filename) and decodes each one through `crew_log.parseAll` — the SAME module the seats
// emit through. It must never carry regexes of its own for these lines: that would be a second copy of
// the grammar, and the two would drift the first time a field was added (Law 26 — one interface, both
// ends importing it; Law 16 — one pathway).
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --engagement [--bot=AurenBot] [--all]

'use strict';

// The SAME grammar module the seats emit through.
// THE ALIAS MAP IS ASKED OF THE WORKSHOP'S ONE ANSWER (Law 16). It reads the bot's own package.json
// and is idempotent, so it is safe whether or not a caller registered first — which is what the block
// that stood here was hand-rolling with `addAliases` and a comment explaining why
// `require('module-alias')(base)` could not be used. The reason that form is unsafe has not changed and
// is now recorded once, in monitoring/lens_paths.js, instead of in five lenses.
require('./lens_paths').registerAliases();
const crewLog = require('@api/crew_log');
const { stat, oneDecimal, twoDecimals, padRight, ABSENT } = require('./report_formatting');

// `report_formatting.relativeTime` is not used here and the difference is the whole reason this lens has
// its own two: that one renders WHOLE seconds because it exists to match the trace's own eye-index stamp
// exactly. These render tenths, because a fight is decided in tenths and rounding a 0.4s reaction to
// "0s" is the measurement being deleted by its own formatter.
const stamp = (t) => `${Math.floor(t / 60)}m ${(t % 60).toFixed(1)}s`;
const seconds = (t) => `${t.toFixed(1)}s`;

// ── reduceEngagements({ seg, bot }) → the machine-facing half ────────────────────────────────────────
//
// RETURNS, never renders and never exits — a deterministic consumer (a conductor deciding whether a
// ladder tier passed) is as legitimate a reader as a human, and it must not have to scrape a rendering
// to get here (Architect 2026-08-07: "if you can read what the trace monitor says then why cant a
// deterministic system like a javascript file").
//
// Shape: { bots: Map<botName, { fights: [fight], modes: [...], stalls: [...], unanswered: [...] }> }
// where a `fight` is one mob from the tick it aggroed to the tick it left the entity table.
function reduceEngagements({ seg = [], bot: botFilter = null } = {}) {
  const bots = new Map();
  const B = (name) => {
    const key = name || 'unknown';
    if (!bots.has(key)) {
      bots.set(key, {
        name: key,
        fights: [],            // closed and open, in the order they opened
        open: new Map(),       // subject key → fight, while the mob is still on the board
        modes: [],             // the driver's tactic changes, in order
        stalls: [],
        sprints: [],
        rearms: [],
        guards: [],            // shield up/down pairs
        openGuard: null,
        bearings: [],          // every compass change the commander posted, in order, across all mobs
        lines: 0,              // crew events seen — the honest denominator for "is this run wired up"
      });
    }
    return bots.get(key);
  };

  // A fight is keyed by `name#id` and NOT by id alone: Minecraft reuses entity ids across a session, and
  // two waves of the ladder routinely hand out the same number to a different species. Keying on the id
  // would silently weld two fights into one and report a first-strike delay measured across a wave gap.
  const keyOf = (ev) => (ev.subject ? `${ev.subject.name}#${ev.subject.id}` : null);

  // ── THE CLOCK IS THE ISO STAMP, NOT THE RELATIVE ONE, AND THAT IS NOT A PREFERENCE ─────────────────
  // MEASURED 2026-08-12 (kiters): every crew line in that run carried the relative tag `[0m 0s]` — a
  // whole three-wave ladder collapsed onto one second — and the first rendering of this lens duly
  // reported "first struck 0s later" for every mob. That is a true-looking falsehood of exactly the
  // shape Law 25 names: the reader would have concluded the bot struck instantly.
  //
  // The relative tag is coarse to the second BY DESIGN (it is a human's eye-index into the trace), and a
  // fight is decided in tenths. The ISO prefix `watcher._record` puts on every persisted line is the same
  // instant at millisecond resolution, so the durations here are measured from it and rendered as
  // seconds. `relSec` survives as the RETURN ADDRESS — the stamp that finds the line in the trace by eye,
  // which is the one thing the ISO is bad at.
  //
  // WHICH clock was used is REPORTED, not assumed. The merged overseer trace drops the ISO prefix when
  // it forwards a bot's line, so reading this lens against the fleet file gives whole seconds while the
  // per-bot file gives milliseconds — the same rendering, `0.0s`, meaning two different things. A reader
  // must be told which one they are holding (Law 25: a number carries its confidence).
  let firstMs = null;
  let msLines = 0;
  for (const l of seg) {
    if (l.relSec == null) continue;
    if (botFilter && l.bot !== botFilter) continue;
    // ONE LINE, SEVERAL EVENTS since the crew log started coalescing a whole combat pass onto one line
    // per seat (crew_log's header, Architect 2026-08-12). `parseAll` is the only decoder for that reason —
    // taking the first event of a coalesced line would drop the rest and understate every fight.
    const events = crewLog.parseAll(l.raw);
    if (!events.length) continue;
    const b = B(l.bot);
    const ms = l.iso ? Date.parse(l.iso) : null;
    if (ms !== null) msLines++;
    if (firstMs === null && ms !== null) firstMs = ms;
    // `t` is seconds since the first crew event of the run, as a real number. A line with no parseable
    // ISO falls back to the relative tag rather than being dropped — a missing stamp must not delete the
    // event, only coarsen it. Every event coalesced onto one line shares that line's stamp, which is true
    // rather than approximate: they were raised inside one pass, and the pass is the resolution the seats
    // decide at.
    const t = ms === null || firstMs === null ? l.relSec : (ms - firstMs) / 1000;

    for (const ev of events) {
    // Counted per EVENT and not per line, because this field is rendered as "N crew event(s)" and is
    // described above as the honest denominator. Leaving it on the line count would have quietly divided
    // it by however many events a pass happened to raise (Law 25).
    b.lines++;
    const key = keyOf(ev);

    switch (ev.verb) {
      case 'aggro': {
        if (!key) break;
        const fight = {
          mob: key, openedAt: t, openedRel: l.relSec, openedAtDistance: crewLog.num(ev.fields, 'd'), via: ev.fields.via || null,
          closedAt: null,
          firstFacedAt: null, firstFaceWhy: null,
          firstStrikeAt: null, firstStrikeDistance: null,
          strikes: [], threats: [], guardsAgainst: [], modes: [], bearings: [],
        };
        b.open.set(key, fight);
        b.fights.push(fight);
        break;
      }
      case 'lost': {
        const f = key && b.open.get(key);
        if (f) { f.closedAt = t; b.open.delete(key); }
        break;
      }
      case 'face': {
        const f = key && b.open.get(key);
        if (f && f.firstFacedAt === null) { f.firstFacedAt = t; f.firstFaceWhy = ev.fields.why || null; }
        break;
      }
      case 'strike': {
        const s = { at: t, d: crewLog.num(ev.fields, 'd'), with: ev.fields.with || null, hp: crewLog.num(ev.fields, 'hp'), tag: ev.tag };
        // A strike on a mob with no open fight is not dropped — it is the finding. It means the swing
        // route fired at something the commander never announced (a hunt's quarry, legitimately; or a
        // combat target that slipped the sweep, which is a defect). Filing it under a synthetic fight
        // would hide exactly that, so it is kept where a reader will see the missing `aggro`.
        const f = key && b.open.get(key);
        if (f) {
          if (f.firstStrikeAt === null) { f.firstStrikeAt = t; f.firstStrikeDistance = s.d; }
          f.strikes.push(s);
        } else {
          b.fights.push({
            mob: key || '?', openedAt: null, openedRel: l.relSec, openedAtDistance: null, via: null, closedAt: null,
            firstFacedAt: null, firstFaceWhy: null, firstStrikeAt: t, firstStrikeDistance: s.d,
            strikes: [s], threats: [], guardsAgainst: [], modes: [], bearings: [], unannounced: true,
          });
        }
        break;
      }
      case 'swell':
      case 'notch': {
        const f = key && b.open.get(key);
        if (!f) break;
        if (ev.fields.state === 'on') f.threats.push({ kind: ev.verb, from: t, to: null, answered: false });
        else {
          const last = [...f.threats].reverse().find((x) => x.kind === ev.verb && x.to === null);
          if (last) last.to = t;
        }
        break;
      }
      case 'shield': {
        if (ev.fields.state === 'up') {
          b.openGuard = { from: t, why: ev.fields.why || null, waitedMs: crewLog.num(ev.fields, 'waited'), mob: key, heldMs: null, by: null };
          b.guards.push(b.openGuard);
          const f = key && b.open.get(key);
          if (f) {
            f.guardsAgainst.push(b.openGuard);
            // The threat window this guard answered — matched by KIND, because a mob can only be
            // notching or swelling and the raise names which one it was raised against.
            const kind = ev.fields.why === 'swell' ? 'swell' : 'notch';
            const open = [...f.threats].reverse().find((x) => x.kind === kind && x.to === null);
            if (open) open.answered = true;
          }
        } else if (b.openGuard) {
          b.openGuard.heldMs = crewLog.num(ev.fields, 'held');
          b.openGuard.by = ev.fields.by || 'timer';
          b.openGuard = null;
        }
        break;
      }
      case 'mode': {
        const m = { at: t, to: ev.fields.to || null, d: crewLog.num(ev.fields, 'd'), setpoint: crewLog.num(ev.fields, 'setpoint'), mob: key };
        b.modes.push(m);
        const f = key && b.open.get(key);
        if (f) f.modes.push(m);
        break;
      }
      case 'bearing': {
        if (!key) break;
        const bear = { at: t, mob: key, dir: ev.fields.dir || null, d: crewLog.num(ev.fields, 'd') };
        b.bearings.push(bear);
        const f = b.open.get(key);
        if (f) f.bearings.push(bear);
        break;
      }
      case 'sprint':
        b.sprints.push({ at: t, state: ev.fields.state, why: ev.fields.why || null });
        break;
      case 'stall':
        b.stalls.push({ at: t, mob: key, mode: ev.fields.mode || null, d: crewLog.num(ev.fields, 'd'), keys: ev.fields.keys || null, jumped: ev.fields.jump === 'yes' });
        break;
      case 'rearm':
        b.rearms.push({ at: t, from: ev.fields.from || null, to: ev.fields.to || null, why: ev.fields.why || null });
        break;
      default:
        break;   // a verb this reducer does not model yet — counted in `lines`, never guessed at
    }
    }
  }

  // ── THE ENCIRCLEMENT PASS — the question the per-mob bearings were added to answer ─────────────────
  //   "i want cardinal direction from bot each entity id so i can determine if i need to add logic to make
  //    sure all kiters face the same way or not. so the bot would circle around the archer if one is in
  //    front and one behind."
  //
  // A LIST OF BEARINGS DOES NOT ANSWER THAT and printing one would be the lens declining the job: the
  // question is about mobs held AT THE SAME TIME, so the reduction has to re-walk the compass changes with
  // the open/closed window of every fight and ask what the widest angle between two live mobs ever was.
  // Spread is `360 - the largest empty arc`, which is the diameter of the set on a circle — the only form
  // that behaves for three or more mobs (a max of pairwise gaps reads 90° for mobs at N, E and S).
  const DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
  for (const b of bots.values()) {
    const current = new Map();
    let worst = null;
    let samples = 0;
    for (const ev of b.bearings) {
      current.set(ev.mob, ev.dir);
      const live = [];
      for (const f of b.fights) {
        if (f.unannounced || f.openedAt === null) continue;
        if (f.openedAt > ev.at) continue;
        if (f.closedAt !== null && f.closedAt < ev.at) continue;
        const dir = current.get(f.mob);
        if (dir != null && DEG[dir] != null) live.push({ mob: f.mob, deg: DEG[dir], dir });
      }
      if (live.length < 2) continue;
      samples++;
      const degs = live.map((x) => x.deg).sort((x, y) => x - y);
      let gap = 360 - degs[degs.length - 1] + degs[0];
      for (let i = 1; i < degs.length; i++) gap = Math.max(gap, degs[i] - degs[i - 1]);
      const spread = 360 - gap;
      if (!worst || spread > worst.spread) worst = { spread, at: ev.at, mobs: live.map((x) => `${x.mob} ${x.dir}`) };
    }
    b.encirclement = { worst, samples };
  }

  // `clock` travels with the data because a machine caller needs it as much as a human does: a
  // conductor comparing a 0.4s reaction against a threshold must know whether 0.4 was measured or
  // rounded to it.
  const total = [...bots.values()].reduce((n, b) => n + b.lines, 0);
  return { bots, clock: total && msLines === total ? 'ms' : (msLines ? 'mixed' : 'seconds') };
}

// ── THE SENTENCE ────────────────────────────────────────────────────────────────────────────────────
// His example is the template: who engaged, from how far, how long until the first blow landed and at
// what range, and then every strike. It reads as prose because a post-mortem is read once, start to
// finish, by a person deciding what to fix — the table shape the other lenses use is for scanning a
// repeated measurement, which this is not.
function narrate(f) {
  const who = f.mob;
  const parts = [];
  if (f.unannounced) {
    parts.push(`${who} was STRUCK at ${stamp(f.firstStrikeAt)} with no aggro line for it`);
  } else {
    parts.push(`${who} engaged at ${stamp(f.openedAt)} [${f.openedRel}s in the trace] from ${oneDecimal(f.openedAtDistance)}b (${f.via || '?'})`);
  }
  if (f.firstFacedAt !== null && !f.unannounced) {
    parts.push(`faced ${seconds(f.firstFacedAt - f.openedAt)} later${f.firstFaceWhy && f.firstFaceWhy !== 'closest' ? ` (${f.firstFaceWhy})` : ''}`);
  }
  if (f.firstStrikeAt !== null && !f.unannounced) {
    parts.push(`first struck ${seconds(f.firstStrikeAt - f.openedAt)} later at ${twoDecimals(f.firstStrikeDistance)}b`);
  } else if (!f.unannounced) {
    // NEVER SILENT ABOUT A MOB THAT WAS NEVER HIT. It is the single most diagnostic outcome in the whole
    // record — the fight the bot could not reach, or the mob another bot killed — and an omitted clause
    // reads as "nothing to report" (Law 25).
    parts.push('NEVER STRUCK');
  }
  if (f.strikes.length) {
    const hp = f.strikes.map((s) => s.hp).filter((x) => x !== null);
    parts.push(`${f.strikes.length} strike(s)${hp.length ? `, hp ${oneDecimal(hp[0])} → ${oneDecimal(hp[hp.length - 1])}` : ''}`);
  }
  if (f.closedAt !== null) parts.push(`off the board at ${stamp(f.closedAt)} — ${seconds(f.closedAt - (f.openedAt ?? f.closedAt))} of fight`);
  else parts.push('still on the board when the run ended');
  return parts.join(', ');
}

// ── runEngagement(...) — the human-facing half ──────────────────────────────────────────────────────
// Renders and RETURNS the same object `reduceEngagements` produced, so a caller that wanted both gets
// both from one pass. It does not exit; the CLI owns the exit (the trap every extracted lens here was
// built to avoid).
function runEngagement({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const reduced = reduceEngagements({ seg, bot: botFilter });
  console.log(`\n══ ENGAGEMENTS — ${traceName}${botFilter ? ` · ${botFilter}` : ''} ══`);

  if (!reduced.bots.size) {
    // The two zeros a reader must be able to tell apart: a run with no fights, and a run whose seats are
    // not reporting at all. Both print "nothing" unless the lens says which (Law 25).
    console.log('  no crew events in this run — either nothing fought, or the three seats are not wired to');
    console.log('  the trace. Cross-read with --tag=COMMANDER: an engagement always posts at least an aggro.');
    return reduced;
  }

  if (reduced.clock !== 'ms') {
    console.log(`  ⚠️ CLOCK: ${reduced.clock} — this trace carries no millisecond stamp on its crew lines, so every`);
    console.log('     duration below is rounded to the second. Re-read the PER-BOT file for tenths:');
    console.log('     node Auren_Bot/monitoring/trace_monitor.js Auren_Bot/fleet_logs/traces/watcher_<Bot>.jsonl --engagement');
  }

  for (const b of reduced.bots.values()) {
    console.log(`\n── ${b.name} — ${b.fights.length} engagement(s) from ${b.lines} crew event(s) ──`);

    for (const f of b.fights) {
      console.log(`  • ${narrate(f)}`);
      for (const g of f.guardsAgainst) {
        console.log(`      shield ${g.why} at ${stamp(g.from)} — raised ${g.waitedMs == null ? ABSENT : `${g.waitedMs}ms`} into the threat, held ${g.heldMs == null ? 'past the end of the run' : `${g.heldMs}ms`}${g.by && g.by !== 'timer' ? ` (lowered by ${g.by})` : ''}`);
      }
      // ── THE JOIN THAT NO SEAT CAN MAKE ────────────────────────────────────────────────────────────
      // A threat window with no guard raised against it. The commander saw the draw and the gunner never
      // answered it: either the timer never reached its raise point (the mob loosed early, or fled) or
      // the shield was not in the pack. This is the whole reason the two threat edges are on/off.
      for (const th of f.threats) {
        if (th.answered) continue;
        const span = th.to === null ? 'still open at the end of the run' : seconds(th.to - th.from);
        console.log(`      ⚠️ ${th.kind} from ${stamp(th.from)} (${span}) — NO GUARD went up against it`);
      }
      if (verbose) {
        for (const s of f.strikes) {
          console.log(`      strike ${stamp(s.at)} at ${twoDecimals(s.d)}b with ${s.with || '?'}${s.hp === null ? '' : ` (target hp ${oneDecimal(s.hp)})`}`);
        }
        for (const bear of f.bearings) {
          console.log(`      bearing ${padRight(bear.dir, 14)} ${stamp(bear.at)} at ${twoDecimals(bear.d)}b`);
        }
        for (const m of f.modes) {
          console.log(`      feet → ${padRight(m.to, 14)} ${stamp(m.at)} at ${twoDecimals(m.d)}b${m.setpoint === null ? '' : ` toward ${twoDecimals(m.setpoint)}b`}`);
        }
      }
    }

    // ── THE FLEET-LEVEL NUMBERS, and only the ones a single fight cannot show ────────────────────────
    const engaged = b.fights.filter((f) => !f.unannounced);
    const reached = engaged.filter((f) => f.firstStrikeAt !== null);
    const delays = reached.map((f) => f.firstStrikeAt - f.openedAt);
    const d = stat(delays);
    console.log(`\n    Reach: ${reached.length}/${engaged.length} engaged mob(s) were struck at all` +
      `${d ? `; aggro → first strike ${seconds(d.min)}–${seconds(d.max)} (median ${seconds(d.med)})` : ''}.`);
    const opens = stat(engaged.map((f) => f.openedAtDistance));
    if (opens) console.log(`    Opened at ${oneDecimal(opens.min)}–${oneDecimal(opens.max)}b (median ${oneDecimal(opens.med)}b).`);
    const strikeD = stat(b.fights.flatMap((f) => f.strikes.map((s) => s.d)));
    if (strikeD) console.log(`    Struck from ${twoDecimals(strikeD.min)}–${twoDecimals(strikeD.max)}b (median ${twoDecimals(strikeD.med)}b).`);

    const waited = stat(b.guards.map((g) => g.waitedMs));
    console.log(`    Guard: ${b.guards.length} raise(s)` +
      `${waited ? `, ${waited.min}–${waited.max}ms into the threat (median ${waited.med}ms)` : ''}` +
      `${b.guards.length ? ` — a median near zero means the timer has become a toggle` : ''}.`);

    // ENCIRCLEMENT IS REPORTED EVEN WHEN IT NEVER HAPPENED, because "the mobs were never on opposite
    // sides" is the answer to his question just as much as "they were" — a silent line reads as "no data"
    // and would leave the kiter-facing decision unmade (Law 25).
    const enc = b.encirclement || { worst: null, samples: 0 };
    if (!b.bearings.length) {
      console.log('    Bearings: none posted — the commander is not reporting compass direction in this run.');
    } else if (!enc.samples) {
      console.log(`    Encirclement: ${b.bearings.length} bearing change(s), but never two mobs engaged at once — nothing to circle.`);
    } else {
      console.log(`    Encirclement: widest angle between live mobs ${enc.worst.spread}° at ${stamp(enc.worst.at)} (${enc.worst.mobs.join(', ')}), over ${enc.samples} sample(s)` +
        `${enc.worst.spread >= 135 ? ' — mobs on opposing sides; one facing cannot cover both' : ' — every mob stayed within one quadrant of the others'}.`);
    }

    if (b.stalls.length) {
      const stuck = b.stalls.filter((s) => !s.jumped);
      console.log(`    Stalls: ${b.stalls.length}${stuck.length ? `, ${stuck.length} with NO jump tap — the body could not even try` : ''}.`);
    }
    if (b.rearms.length) console.log(`    Re-armed ${b.rearms.length} time(s): ${b.rearms.map((r) => `${r.from}→${r.to}`).join(', ')}.`);
    if (!verbose) console.log('    (--all for every strike and every change of tactic)');
  }

  return reduced;
}

module.exports = { reduceEngagements, runEngagement };
