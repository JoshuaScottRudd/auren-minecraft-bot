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
const { stat, oneDecimal, twoDecimals } = require('./report_formatting');
// The one writer to stdout. `padRight` and `ABSENT` are no longer imported here: this lens no longer owns
// a column width, and an absent value is data_out's own em-dash rather than one this file pastes in.
const out = require('./data_out');

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

// The encirclement criterion, as a number rather than a word. It is DECLARED here and printed beside the
// measurement as its own field, so the reader checks the comparison instead of being handed its result.
const ENCIRCLE_THRESHOLD_DEG = 135;

// A stamp only when there is something to stamp. `stamp(null)` renders `0m 0.0s`, which is a real-looking
// instant that never happened — the exact falsehood Law 25 names.
const at = (t) => (t == null ? null : stamp(t));
const after = (t, from) => (t == null || from == null ? null : seconds(t - from));

// ── runEngagement(...) — the human-facing half ──────────────────────────────────────────────────────
// Renders and RETURNS the same object `reduceEngagements` produced, so a caller that wanted both gets
// both from one pass. It does not exit; the CLI owns the exit (the trap every extracted lens here was
// built to avoid).
//
// ── OUTPUT IS DATA, NOT PROSE (Architect 2026-09-16) ────────────────────────────────────────────────
// `narrate(f)` STOOD HERE AND IS DELETED — the whole point of it was to compose his example sentence
// ("zombie ID# engaged AurenBot 12 blocks away… attacked 2 seconds later once auren came within 2.9
// blocks"), and a sentence is the one thing this instrument may no longer form. Every measurement it
// carried is a column of `fights` below, in the same order it used to read: mob, opened_at,
// opened_distance, via, faced_after, first_strike_after, first_strike_distance, strikes, hp, closed_at.
// WHAT WAS DELETED RATHER THAN TRANSLATED:
//   · `NEVER STRUCK` → `struck` = false. · `still on the board when the run ended` →
//     `on_board_at_run_end` = true. · `with no aggro line for it` → `unannounced` = true.
//   · `— NO GUARD went up against it` → the `answered` column on every threat window, false.
//   · `held past the end of the run` → an absent `held_ms`.
//   · the CLOCK paragraph telling the reader to re-read the per-bot file for tenths. `clock` survives as
//     a field; where to go next is the reader's move, not the instrument's.
//   · `0 crew events parsed in this run.` → `crew_events` = 0.
//   · `Bearings: none posted` / `0 instants with two or more mobs engaged at once` → `bearing_changes`
//     and `encirclement_samples`, which are 0 in exactly those two cases.
//   · `declared threshold 135°, OVER` → `widest_spread_deg`, `threshold_deg` and `over_threshold` as
//     three fields, so the verdict and the number it was measured against are both on the page.
//   · `(--all for every strike and every change of tactic)`.
function runEngagement({ seg = [], traceName = '?', bot: botFilter = null, verbose = false } = {}) {
  const reduced = reduceEngagements({ seg, bot: botFilter });

  out.kv('lens', 'engagement');
  out.kv('record', traceName);
  if (botFilter) out.kv('bot_filter', botFilter);
  out.kv('bots', reduced.bots.size);
  // WHICH clock the durations were measured on, reported rather than assumed: `ms` from the ISO prefix,
  // `seconds` from the coarse relative tag, `mixed` when the segment carries both.
  out.kv('clock', reduced.clock);

  if (!reduced.bots.size) {
    // The two zeros a reader must be able to tell apart: a run with no fights, and a run whose seats are
    // not reporting at all. `bots` = 0 with `crew_events` = 0 is the second; `bots` > 0 with 0 fights is
    // the first (Law 25).
    out.zero('crew_events');
    return reduced;
  }

  for (const b of reduced.bots.values()) {
    // ── THE PER-BOT NUMBERS, and only the ones a single fight cannot show ────────────────────────────
    const engaged = b.fights.filter((f) => !f.unannounced);
    const reached = engaged.filter((f) => f.firstStrikeAt !== null);
    const d = stat(reached.map((f) => f.firstStrikeAt - f.openedAt));
    const opens = stat(engaged.map((f) => f.openedAtDistance));
    const strikeD = stat(b.fights.flatMap((f) => f.strikes.map((s) => s.d)));
    const waited = stat(b.guards.map((g) => g.waitedMs));
    const enc = b.encirclement || { worst: null, samples: 0 };

    out.section('bot_engagement');
    out.kv('bot', b.name);
    out.kv('crew_events', b.lines);
    out.kv('engagements', b.fights.length);
    out.kv('engaged_mobs', engaged.length);
    out.kv('mobs_struck', reached.length);
    // Every name here is kept under data_out's 28-column key width — a longer one is CLIPPED by the
    // emitter and its value runs straight onto the end of it.
    out.kv('aggro_to_strike_min', d && seconds(d.min));
    out.kv('aggro_to_strike_max', d && seconds(d.max));
    out.kv('aggro_to_strike_median', d && seconds(d.med));
    out.kv('opened_distance_min', opens && oneDecimal(opens.min));
    out.kv('opened_distance_max', opens && oneDecimal(opens.max));
    out.kv('opened_distance_median', opens && oneDecimal(opens.med));
    out.kv('strike_distance_min', strikeD && twoDecimals(strikeD.min));
    out.kv('strike_distance_max', strikeD && twoDecimals(strikeD.max));
    out.kv('strike_distance_median', strikeD && twoDecimals(strikeD.med));
    out.kv('guard_raises', b.guards.length);
    out.kv('guard_waited_ms_min', waited && waited.min);
    out.kv('guard_waited_ms_max', waited && waited.max);
    out.kv('guard_waited_ms_median', waited && waited.med);
    // ENCIRCLEMENT IS REPORTED EVEN WHEN IT NEVER HAPPENED, because "the mobs were never on opposite
    // sides" is the answer to his question just as much as "they were" — an omitted field reads as "no
    // data" and would leave the kiter-facing decision unmade (Law 25).
    out.kv('bearing_changes', b.bearings.length);
    out.kv('encirclement_samples', enc.samples);
    out.kv('widest_spread_deg', enc.worst ? enc.worst.spread : null);
    out.kv('threshold_deg', ENCIRCLE_THRESHOLD_DEG);
    out.kv('over_threshold', enc.worst ? enc.worst.spread >= ENCIRCLE_THRESHOLD_DEG : null);
    out.kv('widest_spread_at', enc.worst ? at(enc.worst.at) : null);
    out.kv('stalls', b.stalls.length);
    out.kv('stalls_without_jump', b.stalls.filter((s) => !s.jumped).length);
    out.kv('rearms', b.rearms.length);
    out.kv('sprints', b.sprints.length);

    // The reducer holds each live mob as `name#id dir`; split back into two columns here so no value cell
    // carries a space. The reducer itself is untouched — this is rendering.
    if (enc.worst) {
      out.section('widest_spread_mobs');
      out.table(['mob', 'dir'], enc.worst.mobs.map((s) => s.split(' ')));
    }

    out.section('fights');
    out.table(
      ['mob', 'unannounced', 'opened_at', 'opened_rel_sec', 'opened_distance', 'via', 'faced_after',
        'face_why', 'struck', 'first_strike_at', 'first_strike_after', 'first_strike_distance',
        'strikes', 'hp_first', 'hp_last', 'closed_at', 'fight_duration', 'on_board_at_run_end'],
      b.fights.map((f) => {
        const hp = f.strikes.map((s) => s.hp).filter((x) => x !== null);
        return [
          f.mob, f.unannounced === true, at(f.openedAt), f.openedRel, oneDecimal(f.openedAtDistance),
          f.via, after(f.firstFacedAt, f.openedAt), f.firstFaceWhy,
          // ABSOLUTE and RELATIVE both, because an unannounced fight has no aggro to measure from and the
          // instant it was struck is the only time it has. `narrate` printed that instant and dropping it
          // would delete a measurement (rule: nothing lost but the grammar).
          f.firstStrikeAt !== null, at(f.firstStrikeAt), after(f.firstStrikeAt, f.openedAt),
          twoDecimals(f.firstStrikeDistance), f.strikes.length,
          hp.length ? oneDecimal(hp[0]) : null, hp.length ? oneDecimal(hp[hp.length - 1]) : null,
          at(f.closedAt), f.closedAt === null ? null : seconds(f.closedAt - (f.openedAt ?? f.closedAt)),
          f.closedAt === null,
        ];
      }),
    );

    // Every guard raise the gunner made, including one raised with no fight open against it — the
    // superset of the per-fight list this used to print, and the `mob` column says which fight each
    // belongs to.
    out.section('guards');
    out.table(['mob', 'at', 'why', 'waited_ms', 'held_ms', 'lowered_by'],
      b.guards.map((g) => [g.mob, at(g.from), g.why, g.waitedMs, g.heldMs, g.by]));

    // ── THE JOIN THAT NO SEAT CAN MAKE ──────────────────────────────────────────────────────────────
    // A threat window and whether a guard was raised against it. The commander saw the draw and the
    // gunner either answered it or did not: `answered` false is the arrow nobody blocked — the timer
    // never reached its raise point (the mob loosed early, or fled) or the shield was not in the pack.
    // This is the whole reason the two threat edges are on/off. ALL windows are listed now, not only the
    // unanswered ones, so the reader has the denominator as well as the finding.
    out.section('threats');
    out.table(['mob', 'kind', 'from', 'to', 'span', 'answered', 'open_at_run_end'],
      b.fights.flatMap((f) => f.threats.map((th) => [
        f.mob, th.kind, at(th.from), at(th.to),
        th.to === null ? null : seconds(th.to - th.from), th.answered === true, th.to === null,
      ])));

    if (b.rearms.length) {
      out.section('rearms');
      out.table(['at', 'from', 'to', 'why'], b.rearms.map((r) => [at(r.at), r.from, r.to, r.why]));
    }

    if (b.stalls.length) {
      out.section('stalls');
      out.table(['at', 'mob', 'mode', 'distance', 'keys', 'jumped'],
        b.stalls.map((s) => [at(s.at), s.mob, s.mode, twoDecimals(s.d), s.keys, s.jumped === true]));
    }

    if (verbose) {
      out.section('strikes');
      out.table(['mob', 'at', 'distance', 'weapon', 'target_hp'],
        b.fights.flatMap((f) => f.strikes.map((s) => [f.mob, at(s.at), twoDecimals(s.d), s.with, oneDecimal(s.hp)])));

      out.section('bearings');
      out.table(['mob', 'dir', 'at', 'distance'],
        b.bearings.map((bear) => [bear.mob, bear.dir, at(bear.at), twoDecimals(bear.d)]));

      out.section('modes');
      out.table(['mob', 'mode', 'at', 'distance', 'setpoint'],
        b.modes.map((m) => [m.mob, m.to, at(m.at), twoDecimals(m.d), twoDecimals(m.setpoint)]));

      out.section('sprints');
      out.table(['at', 'state', 'why'], b.sprints.map((s) => [at(s.at), s.state, s.why]));
    }
  }

  out.blank();
  return reduced;
}

module.exports = { reduceEngagements, runEngagement };
