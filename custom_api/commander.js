// module: commander — the tank crew's COMMANDER, the fleet's ONLY monster scanner. Every monster fact
// any seat acts on is read off the board this file writes. Touches no control state, sends no packet.
// contract: start/stop attach/detach a physicsTick handler; one synchronous sweep per tick, never
// awaits (§20.3 — an await lets the next tick overtake the rotation). Writes exactly one `crew_board`
// section, holds its pen for the process. Reads perception PREDICATES (threat_scanner.isHostile /
// confirmAggro, fuse_meter.swellDir, archer_calculator.bowDrawState) and owns the SWEEP: nothing else
// may walk bot.entities for hostiles or decode a monster's metadata.
// One main scanner: all monster data derives here only, redundant scans are Law 16 violations. A
// decode in a consumer is priced per consumer — a second reader forces a duplicate (Law 16) or a seat
// calling a seat (Law 1); on the board a monster fact has ONE producer, any readers. Aggro ruling:
// within 5 blocks aggro is assumed; outside, checked per mob.
// Consolidates what were previously separate hostile walks over bot.entities across scanner,
// battle_stations, combat_planner, and gunner — each an independent Law 16 violation, and divergent
// walks let two seats name different mobs in the same tick.
// 5 B BEATS THE RAYCAST INSIDE 5 B: raycast failures cluster at close range in clutter — eye-level
// adjacent geometry (foliage, logs) blocks the line test even when the mob is genuinely aggroed. False
// NEGATIVE costs damage, false POSITIVE costs seconds, so inside 5 b the line is never tested.
// Deliberate false positive: a mob 4 b away through a cave wall posts active — "is it a threat?" is
// this seat's question, "can I get to it?" is the DRIVER's (answered by failing to route). Never
// re-merge them into one raycast.
// Board rebuilt from the live entity table every tick. ONE remembered fact: a raycast once confirmed a
// mob's aggro — no decay, the thing recorded does not change. WRONG TURN — TRENDING (distance history,
// closing gap ⇒ aggro): the bot's own movement contaminates the derivative, and it would be the
// rotation's only seat with per-tick history, against its correctness argument that every decision is a
// pure function of fresh-this-tick state. Distance IS the trend, sampled when it matters.

'use strict';

const crewBoard = require('@api/crew_board');
const crewLog = require('@api/crew_log');
const threatScanner = require('@perception/threat_scanner');
const { swellDir, UP } = require('@api/combat_counters/fuse_meter');
const { bowDrawState } = require('@utils/calculators/archer_calculator');
const { hasEntityLineOfSight, lastSightlineBlock } = require('@utils/movement/terrain_predicates');
const { withinAggroRange, HEADFRAME_SAFE_RADIUS } = require('@thinking/architect_config');
const hq = require('@kernel/corporate_headquarters');
const watcher = require('@kernel/watcher');

const TAG = 'commander';

// Pen claimed at module scope: a second claimant throws at require time, which preflight runs
// on every change for free (Law 13 — the boot failure names the offender; a convention would not).
const writeBoard = crewBoard.claimPen('commander');

// ── SECTION 1: Constants ──

// ── THE MODEL IS REACTIVE, AND THAT IS THE WHOLE DESIGN ─────────────────────────────────────────────
// This seat does not open fights because something hostile is nearby. Proximity alone aggros NOTHING.
// A fight opens only when the world has already acted on this body — it was struck, or a creeper is
// swelling — and then everything inside strike reach becomes a target at once.
//
// WHAT THE OLD PROXIMITY RULE COST, so it is not reintroduced as an obvious improvement: a radius test
// cannot tell a mob that can reach the bot from one that cannot, because a wall is not a distance. A
// hostile standing on the far side of an enclosed shelter satisfied every proximity test there was, so
// the bot opened a fight it was in no danger from and walked out of the shelter to have it. Reactivity
// fixes that without any notion of walls, sky or shelter, and that is why it is the right shape rather
// than a gate bolted beside the old one: a mob that cannot reach the body cannot strike it, so it never
// trips the trigger, and the wall does the reasoning for free.
//
// A REACH, NOT A REACTION BUDGET — the inversion the reactive model makes correct. The old radius was
// deliberately wider than every reach constant in the tree, buying time to respond to something walking
// in. Under a reactive rule there is nothing to anticipate: the response is to a blow that has already
// landed, so the question is no longer "what might reach me soon" but "what is close enough to be part
// of this fight now". That is a reach, and it is why this number is smaller than what it replaced
// rather than larger.
const STRIKE_REACH = 2.9;

// How long a blow keeps the reactive door open. It re-arms on every hit, so a running fight holds it
// open continuously and this only ever governs the tail: how long after the last blow a mob newly
// walking into reach still joins the fight. Short, because its job is to bound a REACTION — long
// enough that a wave closing in one after another reads as one engagement, short enough that a bot
// hit once in passing does not spend the next minute treating the neighbourhood as hostile. Mobs
// already admitted are unaffected: `confirmed` holds them until they leave the world.
const REACTIVE_WINDOW_MS = 3000;

// ── THE ONE PROACTIVE EXEMPTION, AND WHY IT IS NOT A HOLE IN THE MODEL ──────────────────────────────
// A reactive rule assumes the only way to be hurt is to be reached. An archer breaks that assumption:
// it damages the body from far outside strike reach, so a purely reactive bot stands and is shot, and
// everything the reaction admits is out of range of the thing doing the shooting.
//
// The exemption is sound rather than a special case because the archer's own requirement supplies the
// condition: it must SEE the body to shoot it, and sight is mutual. So the sightline that makes it
// dangerous is the same sightline that makes it legitimately engageable, and admitting it proactively
// on a raycast admits exactly the archers that could already have opened fire — never one behind a
// wall, which is the case the reactive model exists to refuse.
//
// SCOPED TO THE FAMILIES THAT SHOOT ON SIGHT. A ranged attacker outside this set is still covered, by
// attribution rather than by species: a blow is latched with the id of whatever dealt it, and a source
// standing beyond strike reach is admitted on that evidence (see aggroVerdict). So the list being
// incomplete costs the first hit, never the fight — which is the safe direction for a list that has to
// be maintained by hand.
const SIGHT_AGGRO_NAMES = new Set(['skeleton', 'stray', 'bogged']);

// Re-cast interval for a hostile inside its species radius but failing the line test. Carried unchanged
// from battle_stations' admission pass: at 500 ms a walled mob costs two casts/s and is admitted within
// 0.5 s of stepping into view — inside a creeper's 1350 ms fuse. Without it a 20 Hz sweep casts every
// unconfirmed mob 20×/s, the one way this seat can starve the tick budget (§20.6).
const AGGRO_RECHECK_MS = 500;

// ── SECTION 2: State — deliberately very little of it ──
let attached = false;
let tickHandler = null;

// The one remembered fact (see header): raycast-confirmed ids, plus last cast time per unconfirmed id.
// Both PRUNED to ids seen this sweep — an unbounded id map in an hours-long process is a leak that
// reads only as a slow memory climb (Law 8).
let confirmed = new Set();
let castAt = new Map();

// Headframe centre on a slow clock: it changes roughly once per run, so a 20 Hz re-read would spend
// tick budget re-answering a settled question.
let homeCenter = null;
let homeReadAt = 0;
const HOME_REREAD_MS = 5000;

// ── EVENTS — kept only if a reader acts differently on it, and this seat is the only one that can say
// it.
//   aggro — mob became a threat: the OPENING FACT (lens has no start time/distance without it). `via`
//           says which of the design's two doors admitted THIS mob (contact rule vs paid raycast).
//   lost  — threat gone; closes the lifecycle (Law 8) — else a cleared wave reads like an abandoned one.
//   closest — nearest ACTIVE mob changed identity. Not the gunner's target nor battle_stations'
//           `Target N`: those are what the crew DID, this is what the world DID —
//           disagreement is the only place a target-selection fault is visible.
//   swell/notch — the fuse the driver flees / the draw the shield times. On/off: their quality
//           measures are durations, and a duration needs both ends.
// DELETED: the engage verdict — battle_stations already announces its opening mob; the same choice one
// tick earlier here is two voices for one decision.
let stats = null;
function _blankStats() {
  return {
    // Aggregate keeps ONLY what the event stream cannot recover (derivables deleted, never printed
    // twice: maxActive = aggro/lost counted, swellTicks/notchTicks = those events, contactPasses =
    // via=contact tallied). Survivors are true of ticks that emitted NOTHING: `sweeps` — the
    // denominator ("2 raycasts" alone: cheap run or dead handler?); `casts` — raycasts PAID, including
    // failed ones that produced no event, the number the 5 b ruling is judged by.
    sweeps: 0,
    casts: 0,
    // The two halves of a decline, split because they point at different repairs. seenOutOfRange is the
    // ENVELOPE question — the bot had a clear line and refused on a number, which is the population a
    // wider cylinder would recover. inRangeUnseen is the TERRAIN question — close enough and behind
    // something, which no number can fix. Before the cast moved above the range gate the first of these
    // could not be counted at all, because the mobs it describes were never cast at.
    seenOutOfRange: 0,
    inRangeUnseen: 0,
    // Two empty notch-decode outcomes, kept apart — they indict different things: `drawUnread` =
    // decode FAILED (no metadata array/registry entry/key; the number that says a version bump moved
    // the index); `drawQuiet` = decode SUCCEEDED, field never sent — 1.21.5 does this for any
    // default-valued field (mob never used an item). Folded, the second drowns the first. Printed only
    // inside the warning, where quiet is the denominator giving unread meaning.
    drawUnread: 0,
    drawQuiet: 0,
  };
}

// ── ANNOUNCED STATE — one entry per fact currently true, so a sweep tells "still true" from "just
// became true". Remembered state, legal here because nothing is ever ACTED on it: it only decides
// whether to SPEAK — a wrong entry costs a duplicate/missing line, never a wrong decision (Invariant B
// binds what a seat acts on). Threat holders are MAPS id → name, not sets: a mob leaving the entity
// table is already gone from `active` when its threat window closes, so the name must be latched at the
// on-edge, the only moment it is guaranteed to exist.
let announced = _blankAnnounced();
function _blankAnnounced() {
  // `bearing`: id → last announced compass bucket, so only a change posts. Pruned with the sweep (Law 8).
  return { active: new Map(), closest: null, focus: null, swelling: new Map(), notching: new Map(), bearing: new Map() };
}

// ── SECTION 3: The sweep ──

function _home(now) {
  if (now - homeReadAt < HOME_REREAD_MS) return homeCenter;
  homeReadAt = now;
  // Unguarded: the chair read is our own shared state and already answers null for an unset home — the
  // case this was written for. Anything else escaping it is a defect in HQ, and swallowing it here made
  // every bot conclude `inBase: false` from a broken reader instead of from a missing home (Law 13).
  const site = hq.readBuildingChair('headframe', 'set_buildspot');
  homeCenter = (site && site.build_center) || null;
  return homeCenter;
}

// aggroVerdict → { aggroed, blockedBy, cast }. Gates cheapest-first: contact radius, species cylinder,
// then raycast — a mob outside its aggro range or inside 5 b never costs a cast, which is what makes a
// 20 Hz sweep affordable. `withinAggroRange`, NOT a compare against `distance`: `distance` is 3-D, the
// gate is a cylinder — comparing them spends horizontal reach on altitude, the exact defect
// architect_config's cylinder section was written against, and what this line used to be.
// SIGHT_CAST_RANGE — the OBSERVATION horizon, deliberately not derived from the aggro cylinder
// (Architect 2026-08-15: "raycast doesent have a range on it… even if a mob is 32 blocks away i want
// raycast to see it"). A cast clamped to the gate can only ever confirm what the gate already admitted, so
// it answers one question twice and the second question — can the bot SEE it — never gets asked outside
// the gate's own reach. That is the answer `out_of_aggro_range` cannot give and most needs: a mob 12 b out
// on flat open ground and one 12 b out through solid rock are the same decline today, and they mean
// opposite things about whether the envelope is sized right. Not unbounded, because a voxel walk costs one
// block read per step and an unbounded cast against a mob in a far loaded chunk would walk hundreds.
const SIGHT_CAST_RANGE = 32;

// aggroVerdict → { aggroed, seen, inRange, blockedBy, cast }. TWO INDEPENDENT ANSWERS, BOTH ALWAYS
// PRODUCED, and engagement is their conjunction — never one standing in for the other.
//
// THE ORDER IS INVERTED FROM WHAT IT WAS, deliberately. The old gate returned on range BEFORE casting, so
// an out-of-range mob cost nothing and told nothing: the record could not distinguish "far away across open
// ground" from "eight blocks below through bedrock", and those two demand opposite changes to the envelope.
// Now the cast runs first and the range decides afterwards, so a decline always carries the sightline
// answer with it (Law 6 — the decision inspectable after the fact).
//
// WHAT IT COSTS, since the old order existed to save exactly this. One cast is a voxel walk: about one
// block read per block stepped, tens of reads at this horizon — cheap. The expense was never one cast, it
// was N casts every sweep at 20 Hz, and that is why AGGRO_RECHECK_MS NOW SITS ABOVE THE CAST INSTEAD OF
// BELOW THE RANGE GATE: the throttle is what bounds the bill, so it must cover every mob rather than only
// the ones the range already admitted. Cost is then hostiles ÷ recheck period, not hostiles × tick rate.
//
// `seen` is null, never false, on a throttled sweep: "not cast this time" is not "cannot be seen", and
// defaulting it to false would publish a refusal nothing measured (Law 25).
// `reaction` is the sweep-level trigger state, computed once per sweep and passed in rather than
// re-derived per mob: it is a fact about THIS BODY (was it struck, is anything swelling), so deriving
// it inside a per-entity function would answer the same question once per hostile and could answer it
// differently within one sweep as entities are walked.
function aggroVerdict(bot, entity, name, distance, self, now, reaction) {
  if (confirmed.has(entity.id)) return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'held' };

  // ── THE ATTRIBUTED STRIKER, ADMITTED AT ANY DISTANCE ──────────────────────────────────────────
  // Ahead of the reach test on purpose: this mob is not a candidate that happens to be close, it is
  // the measured source of a blow that already landed. Distance is not evidence against it — a source
  // beyond strike reach is precisely the case a radius-scoped reaction cannot answer, and refusing it
  // here leaves the bot taking fire with nothing admitted to answer for it.
  if (reaction.struckById != null && entity.id === reaction.struckById) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'striker' };
  }

  const withinReach = distance <= STRIKE_REACH;

  // ── THE REACTIVE DOOR ─────────────────────────────────────────────────────────────────────────
  // "I got struck, so anything within strikable radius is aggressive." The swell counts as a strike
  // for this purpose because a creeper's whole attack IS the thing about to happen — waiting for the
  // blow that proves it hostile is waiting for the blow that ends the engagement.
  if (reaction.armed && withinReach) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'reaction' };
  }

  // ── THE SIGHT DOOR — archers only (see SIGHT_AGGRO_NAMES) ─────────────────────────────────────
  // Every other species falls through to a decline no matter how close it is or how clearly it is
  // seen. That fall-through IS the reactive model; it is not a missing branch.
  if (!SIGHT_AGGRO_NAMES.has(name)) {
    // Reported with the same fields a cast would have produced, minus the cast: `seen: null` because
    // nothing was measured, which is the file's standing rule for an unmeasured sightline (Law 25 —
    // never publish a refusal nothing looked at). `inRange` is still answered honestly, because it
    // costs nothing and it is what says whether a decline was about reach or about the rule.
    return { aggroed: false, seen: null, inRange: withinReach, blockedBy: null, cast: false, via: null };
  }

  const inRange = withinAggroRange(self, entity.position, name);
  if (now - (castAt.get(entity.id) || 0) < AGGRO_RECHECK_MS) {
    return { aggroed: false, seen: null, inRange, blockedBy: null, cast: false, via: null };
  }
  castAt.set(entity.id, now);
  const seen = hasEntityLineOfSight(bot, entity, SIGHT_CAST_RANGE);
  if (seen && inRange) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: true, via: 'sight' };
  }
  // Read IMMEDIATELY after the cast, only when it happened — it describes the LAST cast this process
  // made; one more mob scanned would attribute this decline to the next one (see lastSightlineBlock's
  // header). Makes "no_sightline" checkable at no second cast.
  return { aggroed: false, seen, inRange, blockedBy: seen ? null : lastSightlineBlock(), cast: true, via: null };
}

// announce — the diff between what is true and what has been said. Runs AFTER the sort (load-bearing):
// `closest` is only meaningful once `active` is ordered; mid-loop it would announce the first mob the
// client happened to store. A DISTANCE RIDES ON `aggro` ONLY — where the fight started, true at one
// instant, unrecoverable otherwise; on `closest`/`swell` it would print already stale, and a stale
// number in a machine contract is worse than absent (Law 25): the reader cannot tell it is old.
function announce(active, swelling, notching, focus, focusWhy) {
  const seen = new Set();
  for (const h of active) {
    seen.add(h.id);
    if (announced.active.has(h.id)) continue;
    announced.active.set(h.id, h.name);
    crewLog.event(TAG, 'aggro', {
      subject: `${h.name}#${h.id}`,
      d: h.distance.toFixed(1),
      // WHICH DOOR THIS MOB CAME THROUGH — carried on the verdict rather than re-derived from distance,
      // because under the reactive model distance no longer identifies the door: the same 2 b zombie is
      // admitted or refused depending on whether the body has been struck. `striker` = the measured
      // source of a blow; `reaction` = swept in by a strike or a swell; `sight` = an archer on a paid
      // raycast; `held` = already confirmed. A run with no `reaction` rows and plenty of damage means
      // the trigger is not reaching this seat, which is the one failure the counts alone would hide.
      via: h.via,
      // Side it came from — on the opening row as well as its own edge below: "one in front and one
      // behind" is usually decided the moment the second archer arrives, and a later change event
      // would need the first one's position still on screen.
      dir: h.bearing,
    });
  }
  for (const [id, name] of announced.active) {
    if (seen.has(id)) continue;
    announced.active.delete(id);
    // WHY it left is not this seat's to say: killed/despawned/unloaded are indistinguishable from the
    // entity table, and claiming one is an unearned verdict (Law 25) — the lens joins this against the
    // strike stream and the journal's end rows.
    crewLog.event(TAG, 'lost', { subject: `${name}#${id}` });
  }

  const closest = active.length ? active[0] : null;
  const closestKey = closest ? closest.id : null;
  if (closestKey !== announced.closest) {
    announced.closest = closestKey;
    if (closest) crewLog.event(TAG, 'closest', { subject: `${closest.name}#${closest.id}`, d: closest.distance.toFixed(1) });
  }

  // The commitment, announced on change — the seat's most important line: driver drives on it, gunner
  // faces/strikes it, guard spent only on ITS arrows. `why` separates `archer` (chosen over something
  // nearer) from `closest` (no archer present); their absence from a run says the tactic never engaged.
  const focusKey = focus ? focus.id : null;
  if (focusKey !== announced.focus) {
    announced.focus = focusKey;
    if (focus) {
      crewLog.event(TAG, 'focus', {
        subject: `${focus.name}#${focus.id}`, d: focus.distance.toFixed(1), why: focusWhy,
      });
    }
  }

  // ── BEARING EDGE — cardinal direction per entity from the bot. ON CHANGE like every other line —
  // per-tick bearings are 20 lines/s per hostile and would drown the trace; only state changes are
  // reported. Deliberately NOISIER than the other edges, and that IS the signal: a run of `bearing`
  // lines on one entity means the geometry is CHANGING (bot circling, kiter orbiting).
  const seenBearing = new Set();
  for (const h of active) {
    seenBearing.add(h.id);
    if (announced.bearing.get(h.id) === h.bearing) continue;
    announced.bearing.set(h.id, h.bearing);
    crewLog.event(TAG, 'bearing', { subject: `${h.name}#${h.id}`, dir: h.bearing, d: h.distance.toFixed(1) });
  }
  for (const id of announced.bearing.keys()) if (!seenBearing.has(id)) announced.bearing.delete(id);

  // Threat edges are on/off, not one "it is happening" line: every question asked of them is a
  // DURATION (fuse-to-flee, draw-to-guard), and a duration needs two ends.
  announceEdges('swell', swelling, active, announced.swelling);
  announceEdges('notch', notching, active, announced.notching);
}

function announceEdges(verb, ids, active, held) {
  for (const id of ids) {
    if (held.has(id)) continue;
    const h = active.find((a) => a.id === id);
    // A threat id absent from `active` cannot happen — threat lists push only on the aggroed branch of
    // the same sweep (see gate in `sweep`). Law 13 coding violation, not an `unknown#` placeholder that
    // ships list-divergence as a cosmetic blemish. Do not soften to a skip — the repair was making the
    // invariant true, not un-asserting it.
    if (!h) throw new Error(`[commander] CODING VIOLATION: ${verb} on entity ${id}, which is not in this sweep's active list.`);
    held.set(id, h.name);
    crewLog.event(TAG, verb, { subject: `${h.name}#${id}`, state: 'on' });
  }
  for (const [id, name] of Array.from(held)) {
    if (ids.includes(id)) continue;
    held.delete(id);
    // Name from the LATCH, not `active`: on the death sweep the body is already out of the entity
    // table, so only the on-edge can answer.
    crewLog.event(TAG, verb, { subject: `${name}#${id}`, state: 'off' });
  }
}

// ── FOCUS — what is worth swinging at, given it is safe to swing. NOT "attack closest available" or a
// committed target: committing lets the arm chase one mob while a second, unanswered threat lands
// hits — the guard can only face what the arm has picked.
// WRONG TURN (do not rebuild target-commitment): an earlier version committed to and preferred a KITER
// over a nearer archer; the unanswered archer kept landing hits while the arm chased the committed
// target, and the bot died crossing the field to reach it.
// TARGETING IS NOT THE SENIOR QUESTION. Defence is unconditional (gunner answers every threat, driver
// stands off while one is live); this answers only what is left: the NEAREST UNTHREATENING body.
// NEAREST = no commitment (the hysteresis protected the rush; the arm now swings only in threat gaps,
// so the question is rare). UNTHREATENING = never aim the arm at the mob the feet retreat from (two
// seats disagreeing; the swing cannot land at standoff anyway). All threatening → null, NOT
// nearest-anyway — a fallback would restore an offensive stance on exactly the ticks it should not;
// null is the honest "nothing to swing at" the gunner already handles.
// `combatTactic` no longer read: KITER/BRAWLER answered "who must be rushed", a dead question; threat
// signals discriminate instead (archer notches, creeper swells, zombie nothing) — species is a
// consequence of the threat signal, not a branch of its own. Creepers: a swelling creeper takes the
// DRIVER's wheel via its own override — Law 17 self-preservation, not target selection.
function chooseFocus(active, threatenedIds) {
  if (!active.length) { focusId = null; return { focus: null, why: null }; }
  // HELD UNTIL THE BODY LEAVES THE WORLD. A choice re-made every tick is not a choice: the preference
  // flips with draw state (whichever mob is drawing right now looks most urgent), so an unheld pick
  // oscillates between threats and lands nothing; the hold makes the arm's output cumulative. Not the
  // offensive stance returning: the deleted focus committed to a species and drove feet and guard; this
  // holds only the ANSWER (guard still unconditional, feet still hold the band) — only the re-picking is
  // gone. NO timer/margin/hysteresis: a distance comparator with a switch margin oscillates the same way
  // an unheld focus does, and is not to be rebuilt. Release = the mob leaving the entity table — a
  // fact, not a threshold; an unreachable held mob shows in the driver's stall reporting.
  if (focusId !== null) {
    const held = active.find((h) => h.id === focusId);
    if (held) return { focus: held, why: 'held' };
  }
  // `active` is already nearest-first, so the first survivor of the filter is the nearest one.
  const safe = active.find((h) => !threatenedIds.has(h.id));
  const pick = safe || active[0];
  focusId = pick.id;
  if (!safe) return { focus: pick, why: 'all_threatening' };
  return { focus: pick, why: pick.id === active[0].id ? 'closest' : 'safest' };
}

// ── POST-MORTEM FROM THIS SEAT — tracks who had notched or swelled before death: engaged count, who,
// anything drawing. Exists to PRICE the third-party observer, not replace it on faith: the witness
// client's one advantage is reporting when the bot cannot, but a death is explained by the last sweep
// before it, taken 20×/s here. Both run and compare (camera_configure.mode.witness on); if this
// account answers, the second client is a pathway with no job (Law 16).
// Cause of death off metadata is a SUSPICION — field `suspect`, never `killer` (Law 25: overstated
// confidence gets trusted wrongly later).
// ROLLING LATCH, not the live sweep: on the death tick the entity table is tearing down, the killer
// may be gone — `active` there answers the wrong instant (Invariant B, the one direction fresher is
// worse); `lastThreat` carries each mob's last DRAWING moment, surviving its exit.
// focusId — held pick (see chooseFocus), CLEARED in start()/stop(): bench-caught — entity ids recycle,
// so a focus outliving its engagement can silently match a different mob in a later fight.
let focusId = null;

let lastThreat = new Map();     // id → { name, why, at } — the last tick this mob was drawing or swelling
let peakActive = 0;             // most hostiles active at once since the last death, for "how many"
let deathHandler = null;

// A death is a PERCEPTION EVENT: subscribe to the bot's own 'death' emit rather than be told by
// battle_stations (one action fragment reaching into another, Law 1). Two listeners on one event is
// not a Law 16 duplicate — different questions from different records, neither producible by the other.
function onDeath() {
  const now = Date.now();
  // Chosen, not measured: a bow draw is 1000 ms and arrow flight at these ranges well under it —
  // anything off the string longer is no candidate, and naming a stale one is the false confidence
  // the `suspect` label exists to avoid.
  const SUSPECT_WINDOW_MS = 1000;
  let suspect = null;
  for (const [id, t] of lastThreat) {
    if (now - t.at > SUSPECT_WINDOW_MS) continue;
    if (!suspect || t.at > suspect.at) suspect = { id, ...t };
  }
  crewLog.event(TAG, 'postmortem', {
    subject: suspect ? `${suspect.name}#${suspect.id}` : null,
    why: suspect ? suspect.why : 'nothing_drawing',
    engaged: peakActive,
    threatening: lastThreat.size,
  });
  lastThreat = new Map();
  peakActive = 0;
}

// ── Which side of the bot each mob is on — cardinal direction per entity id, used to decide whether
// kiter-facing logic is needed ("one in front and one behind"). NOT degrees: the question has eight
// answers, and a float makes every reader re-derive the bucket differently (Law 16).
// WORLD AXES, not the bot's facing — yaw is written by the gunner several times a second, so a
// facing-relative direction changes every tick about a mob that never moved; N/S/E/W is the one shared
// frame. Minecraft axes: +X = EAST, +Z = SOUTH, so `atan2(dx, -dz)` puts 0 at north, clockwise through
// east — the table's order.
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearingOf(self, pos) {
  const dx = pos.x - self.x;
  const dz = pos.z - self.z;
  // A mob exactly on the bot has no direction; rounding atan2(0,0) to 'N' fabricates an answer
  // (Law 13 — never default a missing field).
  if (dx === 0 && dz === 0) return null;
  const deg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

function sweep(bot) {
  const self = bot.entity && bot.entity.position;
  if (!self) return;
  const now = Date.now();
  const center = _home(now);

  const hostiles = [];
  const active = [];
  const swelling = [];
  const notching = [];
  const seenIds = new Set();
  let tracked = 0;

  // ── PHASE 1: DECODE EVERY HOSTILE BEFORE JUDGING ANY OF THEM ──────────────────────────────────
  // Split from the verdict pass because the reactive trigger is a fact about the WHOLE sweep — "is
  // any creeper swelling" cannot be answered while still walking the entity table, and a verdict
  // taken before the answer exists would judge the first mobs under a different rule than the last.
  // The decodes themselves are unchanged and still run over every hostile; only the moment the
  // verdict is taken has moved.
  const scanned = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue;
    if (e.isValid === false) continue;
    if (!threatScanner.isHostile(e)) continue;

    seenIds.add(e.id);
    tracked++;
    const name = threatScanner.hostileName(e);
    const distance = self.distanceTo(e.position);

    // Swell read for EVERY hostile, unfiltered by species: no `swell_dir` key decodes to undefined,
    // and a creeper test here is a second place knowing which mobs have fuses (Law 16 — fuse_meter
    // owns the decode) and the `isFused` species-routing shape that was deleted fleet-wide.
    const isSwelling = swellDir(bot, e) === UP;

    // Notch likewise species-free: `living_entity_flags` bit 0 is "this mob is using an item", a fact
    // about any living entity; a species test is the same deleted shape.
    // Only 'drawing' is POSITIVE evidence — both empty answers fall through to "not notching": a guard
    // raised on a failed read shields against a zombie, and his ruling names two cases.
    const draw = bowDrawState(bot, e);
    const isNotching = draw === 'drawing';
    if (draw === 'unreadable') stats.drawUnread++;
    else if (draw === 'quiet') stats.drawQuiet++;

    scanned.push({ e, name, distance, isSwelling, isNotching });
  }

  // ── THE TRIGGER, computed once ────────────────────────────────────────────────────────────────
  // Lazy-required: battle_stations reads this seat's board every gate, so a top-level require here
  // would close a cycle between two modules that legitimately need each other's facts.
  const struck = require('@api/battle_stations').struckWithin(REACTIVE_WINDOW_MS);
  // A swell arms the door for EVERY mob in reach, not only the creeper — a creeper walks in with
  // company, and the moment its fuse is lit is the moment the bot can least afford to be deciding
  // about the zombie beside it one blow at a time.
  const anySwelling = scanned.some((s) => s.isSwelling);
  const reaction = {
    armed: !!struck || anySwelling,
    // null rather than undefined when nothing is attributed: the server sends no source for a fall or
    // a drown, and "no entity dealt this" is a real answer rather than a missing field (Law 13).
    struckById: struck && struck.byId != null ? struck.byId : null,
  };

  for (const { e, name, distance, isSwelling, isNotching } of scanned) {
    const verdict = aggroVerdict(bot, e, name, distance, self, now, reaction);
    if (verdict.cast) stats.casts++;
    // BOTH ANSWERS CARRIED, not just the conjunction. A decline that names only its winning reason cannot
    // say whether the other question would also have refused — and the pair is the whole diagnosis: seen
    // but out of range is an ENVELOPE question, in range but unseen is a TERRAIN one (Law 6).
    if (verdict.cast) {
      if (verdict.seen && !verdict.inRange) stats.seenOutOfRange++;
      else if (!verdict.seen && verdict.inRange) stats.inRangeUnseen++;
    }

    // ── AGGROED MOBS ONLY. These pushes previously sat beside the decodes, over EVERY hostile, behind
    // a false comment claiming the lists "cannot come apart": threat lists took every hostile, `active`
    // only aggroed ones, so any skeleton drawing at ANYTHING while not aggroed could arm announceEdges'
    // Law 13 throw. Arena testing never showed it (summoned waves aggro by construction) — a
    // non-aggroed hostile drawing far from the fight is only possible in the open world.
    // Gated HERE, not at the announce: consumers already intersect with `active` (driver's swell
    // branch, gunner's senseThreats), so non-aggroed ids were dead weight only the announce noticed.
    // Makes the throw's claim true instead of deleting the throw (Law 13 — guard stays, invariant real).
    if (verdict.aggroed && isSwelling) swelling.push(e.id);
    if (verdict.aggroed && isNotching) notching.push(e.id);

    const inBase = center ? Math.hypot(e.position.x - center.x, e.position.z - center.z) <= HEADFRAME_SAFE_RADIUS : false;

    // Descriptor shape = threat_scanner.scanThreats' old one field-for-field plus `swelling`, kept
    // identical ON PURPOSE: every consumer was written against it, so the transplant changes WHERE
    // data comes from, not what it looks like — a Law 16 consolidation, not a six-call-site rewrite.
    const descriptor = {
      id: e.id,
      name,
      distance,
      position: { x: e.position.x, y: e.position.y, z: e.position.z },
      inBase,
      aggroed: verdict.aggroed,
      via: verdict.via,
      blockedBy: verdict.blockedBy,
      swelling: isSwelling,
      notching: isNotching,
      // Side of the bot this mob is on — see `bearingOf`.
      bearing: bearingOf(self, e.position),
      entity: e,
    };

    hostiles.push(descriptor);
    if (verdict.aggroed) active.push(descriptor);
  }

  // Pruned to this sweep: a departed id never returns, so holding its confirmation is a pure leak (Law 8).
  if (confirmed.size) for (const id of confirmed) if (!seenIds.has(id)) confirmed.delete(id);
  if (castAt.size) for (const id of castAt.keys()) if (!seenIds.has(id)) castAt.delete(id);

  // Sorted HERE, once, not per reader: `Object.values(bot.entities)` is client insertion order, not
  // distance order — the mob that explains a decline is the closest one, so an unsorted read can name
  // the wrong culprit. Every consumer was re-doing this ordering (Law 16).
  hostiles.sort((a, b) => a.distance - b.distance);
  active.sort((a, b) => a.distance - b.distance);

  // Engagement verdict: both regimes require real aggro; in-base outranks field for PRIORITY only,
  // never lowers the bar to open a fight — a distant in-base seek can burn the whole engagement budget
  // on something unreachable if the bar is lowered. Nearest first per regime, so a closer peer can win
  // the mob claim downstream.
  let engage = null, engageReason = null;
  const inBaseFirst = active.find((h) => h.inBase);
  if (inBaseFirst) { engage = inBaseFirst; engageReason = 'in_base_seek'; }
  else if (active.length) { engage = active[0]; engageReason = 'aggro'; }

  // AFTER the sort ("nearest safe body" needs `active` ordered), BEFORE the announce (board and record
  // never disagree about what the crew swings at, Law 6). Threat set built HERE from the lists just
  // decoded, not re-derived in `chooseFocus`: same fact the gunner and driver read, and three
  // derivations are three chances to disagree about which mob is dangerous (Law 16).
  const threatenedIds = new Set([...swelling, ...notching]);
  const { focus, why: focusWhy } = chooseFocus(active, threatenedIds);

  // Post-mortem latches stamped here — the one place both facts are in hand. Written every sweep, read
  // only on a death: two map writes/tick to answer a maybe-never question is the cheap side of the
  // third-party-observer trade.
  for (const h of active) {
    if (!threatenedIds.has(h.id)) continue;
    lastThreat.set(h.id, { name: h.name, why: swelling.includes(h.id) ? 'swell' : 'notch', at: now });
  }
  if (active.length > peakActive) peakActive = active.length;

  stats.sweeps++;
  announce(active, swelling, notching, focus, focusWhy);

  writeBoard({
    sweptAt: now,
    hostiles,
    active,
    tracked,
    // closest = nearest ACTIVE mob, the field the gunner faces and swings at; `nearest` = nearest
    // hostile of any aggro state, only for "what is around the bot" report lines. Two questions, two
    // fields — not one field two readers disagree about (Law 25).
    closest: active.length ? active[0] : null,
    // focus = the one the crew is killing; closest = the one the world put nearest. Separate because
    // they legitimately disagree for most of a fight — that is the tactic working.
    focus,
    nearest: hostiles.length ? hostiles[0] : null,
    engage,
    engageReason,
    swelling,
    notching,
  });
}

// ── SECTION 4: Lifecycle ──

// Attached for the process, like the gunner and survival reflexes: per-engagement listener churn is a
// lifecycle with an obvious leak (Law 8). Unlike the gunner, NO engage/disengage switch — it sweeps
// whether or not a fight is open; a gunner starved by a stopped commander loses the point of a
// tick-level upper body (§3.2: "a mob wandered up mid-dig" must not mean four unnoticed arrows or a
// discarded mining job).
function start(bot) {
  if (attached) return;
  stats = _blankStats();
  // Cleared with the rest: a fresh process has said nothing, so every still-true fact re-announces.
  // NOT cleared by `report` — announced tracks the WORLD, and a reporting boundary is not a world
  // change (Law 8: the lifecycle is the process's, not the line's).
  announced = _blankAnnounced();
  confirmed = new Set();
  castAt = new Map();
  homeCenter = null;
  homeReadAt = 0;
  lastThreat = new Map();
  peakActive = 0;
  focusId = null;
  tickHandler = () => sweep(bot);
  bot.on('physicsTick', tickHandler);
  deathHandler = () => onDeath();
  bot.on('death', deathHandler);
  attached = true;
}

function stop(bot) {
  if (!attached || !tickHandler) return;
  // removeListener is EventEmitter bookkeeping and cannot fail; a throw would mean no bot at all, which
  // is a defect rather than a teardown hazard (Law 13).
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  // Both listeners off — a raised lifecycle terminates with its owner (Law 8); a death handler left on
  // a stopped seat would post a post-mortem from latches nothing writes any more.
  if (deathHandler) (bot || global.bot).removeListener('death', deathHandler);
  deathHandler = null;
  tickHandler = null;
  focusId = null;
  attached = false;
  lastThreat = new Map();
  peakActive = 0;
  announced = _blankAnnounced();
  confirmed = new Set();
  castAt = new Map();
  crewBoard.reset();
}

// report() — written by whoever owns the engagement boundary. Decisions are events (see `announce`);
// this is the residue of ticks that produced no event. Read `casts` against `sweeps`: casts near zero
// means the 5 b rule carried the engagement and the old raycast bill is unpaid. Per-mob doors live on
// the `aggro` events, where they can be attributed.
function report() {
  if (!stats || !stats.sweeps) return;
  const s = stats;
  // TWO numbers — everything else this line carried is now an event; a fact printed twice invites
  // drift between the two copies. What is left is true of ticks that said nothing, so no lens can find
  // it elsewhere.
  // BOTH ANSWERS, ALWAYS PRINTED — the split is the whole reason the cast moved above the range gate, and
  // a run that reports only the total says exactly what the old order said. `seen but out of range` is the
  // population a wider envelope would recover; `in range but unseen` is terrain and no number reaches it.
  watcher.summary(TAG, `Commander: ${s.sweeps} sweep(s), ${s.casts} raycast(s) paid — ` +
    `${s.seenOutOfRange} mob(s) SEEN but outside the aggro cylinder (envelope question), ` +
    `${s.inRangeUnseen} inside it but with no sightline (terrain question).`);
  // The FAILED decode said out loud, not inferred from a shield that never rises: both guard triggers
  // are metadata decodes, and a moved index reads as a calm battlefield — the failure mode that
  // exonerates the tactic (Law 25). Genuine failures only; folding in quiet passes would make this fire
  // on a healthy run with a perfectly fine index.
  if (s.drawUnread > 0) {
    watcher.warn(TAG,
      `${s.drawUnread} pass(es) could not DECODE living_entity_flags on a hostile — no metadata array, no ` +
      `registry entry, or no such key. That is the notched-arrow signal the shield runs on, and a failed ` +
      `decode is NOT a skeleton that was not drawing. Beside ${s.notchTicks} notched sweep(s), suspect the ` +
      `metadata index rather than the fight.`);
  }
  // Reset HERE and nowhere else — this seat has no engage/disengage boundary. Without it the counts
  // are cumulative and every line restates the last fight plus this one, a worsening trend that is
  // just addition (Law 25). Each line covers the span since the last line — the caller's boundary.
  stats = _blankStats();
}

function state() {
  return { attached, confirmed: confirmed.size, board: crewBoard.readCommander(), stats: stats ? { ...stats } : null };
}

module.exports = { start, stop, report, state, STRIKE_REACH, REACTIVE_WINDOW_MS, AGGRO_RECHECK_MS };
