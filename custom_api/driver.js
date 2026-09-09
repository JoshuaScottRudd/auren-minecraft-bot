// module: driver — the crew's lower body. Owns WSAD/sprint everywhere a fight is open; reads the
// commander's board and the gunner's yaw; writes no yaw, sends no attack, derives no monster data.
// contract: start(bot)/stop(bot) attach/detach a physicsTick handler. One decision per tick, synchronous
// end to end — never awaits (an await lets the next tick overtake; two ticks then hold the body).
// engage()/disengage() bracket a wave, as the gunner's do. Writes exactly one crew_board section (holds
// that pen); reads crew_board.readCommander() for every mob fact and bot.entity.yaw for facing — both
// READS. Only seat that may write forward/back/left/right/sprint/jump.
//
// ONE universal tactic, no hold/rush split (Law 16 — one capability, one implementation). Close on the
// closest aggroed monster; sole exception: a creeper the commander reports swelling → back off.
// Otherwise hold the 2.9–1.9 band — highest DPS (a strike every cooldown) and the anti-swarm argument:
// maximum time dealing damage without receiving it.
//
// REPLACED: hold, rush, combat_navigator, counter_primitives — two tactics each decided face+go, so one
// fight had two body-owners by species and every rule was written twice (the two band copies disagreed
// — why band_keeper existed). The arms' POLICIES (rush: close now, never retreat; hold: wait 5 s) are
// DELETED, not relocated — no wait, cooldown, or per-species flag; closeWaitMs / rushCooldownMs /
// PROFILES were knobs of arms that no longer exist.
//
// ONE CONTROLLED VARIABLE: distance to the CLOSEST ACTIVE MOB, held inside a BAND, moved only by a
// swelling creeper. Everything else is a CONSTRAINT on retreat DIRECTION, never a second setpoint:
// holding 2.9 from four mobs is over-determined (no solution when surrounded) — hold the band vs the
// nearest, pick the heading maximising the gap to its WORST-case mob. A second setpoint gives a body
// oscillating between two mobs, satisfying neither.
//
// RETREAT DIRECTION IS A SCORED SEARCH (§4b), NOT A VECTOR SUM. The old retreatFromSwarm aimed away from
// the pack CENTROID — an admitted approximation of maximise-the-minimum that walks a bot between two
// mobs straight down the line between them. chooseStep scores nine candidate steps by their WORST
// hostile and takes the best; reused whole.
//
// EFFORT RAMP BUILT AND WITHDRAWN: linear ramp (0 at 2.9, full at 1.9), approach taper, Bresenham duty
// cycle for fractional effort from boolean keys — all deleted. The band IS the dead zone: a correction
// only re-enters it, and at walk speed one block is ~4 ticks, faster than the controller could grade.
// With effort only 0/1, effortToThrottle and the dither went too (Law 16); the unverified duty→speed
// transfer function was deleted rather than answered.
//
// THE APPROACH WALKS; SPRINT IS A KNOCKBACK TOOL. The §5 BRAKE (closing meter, coast calculator, species
// branch) is deleted — ruling and pricing at the sprint decision below: a braked sprint measured slower
// than a flat walk. Sprint arms on a brawler approach (isSprinting()-at-the-swing is the one thing a
// walk cannot buy); partially superseded by the kiter closing sprint — see the sprint block in the tick.
//
// NOT HANDLED: a retreat from 1.8 b releases at 1.9 and coasts to ~2.4 — inside the band, not chatter.
// Low `inBandTicks` with `approaching` AND `retreating` both high = the retreat half oscillating — the
// one case this design has no answer for yet.

'use strict';

const Vec3 = require('vec3');
const crewBoard = require('@api/crew_board');
const combatUtils = require('@utils/combat_utils');
const { headingKeys } = require('@utils/movement/motion_primitives');
// Read, never restated: the band below is derived FROM this reach, so a local copy would let the two
// drift apart silently and the derivation in SECTION 1 would stop being true (Law 16).
const { BOT_STRIKE_REACH, BOT_WIDTH } = require('@utils/combat_utils');
const { classifyFloor } = require('@utils/movement/terrain_predicates');
const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');

const writeBoard = crewBoard.claimPen('driver');

const TAG = 'driver';

// ── SECTION 1: The numbers ─────────────────────────────────────────────────

// THE BAND. From counter_primitives.BAND_INNER/OUTER with their WHY: a ground mob's attack reach is
// ~1.43 b and the bot's is 3.0 b (BOT_STRIKE_REACH) — 1.9 because one tick of closing eats the 1.43;
// 2.9 because a swing at exactly 3.0 is one jitter packet from out of reach and spends the cooldown
// anyway. EDGES, NOT SETPOINTS: a controller shape (ramp/taper) read into this pair is a reversion to a
// tried and abandoned design. Inside the band the mob is within the bot's 3.0 reach while the bot is
// outside the mob's 1.43 — every cooldown spent striking; the band is the whole free gap, not a margin
// inside it.
const BAND_INNER = 1.9;
const BAND_OUTER = 2.9;

// SWELL STANDOFF: 7.5 not 7.0 (from band_keeper, counter-intuitive) — 7.0 is the vanilla UN-FUSE line,
// not blast radius. CreeperSwellGoal sets swellDir = -1 at distanceToSqr > 49 STRICTLY, so stopping AT
// 7.0 sits exactly on 49, the unwind never fires, and the creeper detonates (harmlessly, but the kill is
// lost).
const SWELL_CLEAR = 7.5;


// Vanilla ground speeds, b/s. Nothing branches on them — report context only ('2.1 b/s' reads instantly
// as a body not getting what it asked for).
const WALK_SPEED = 4.317;
const SPRINT_SPEED = 5.612;

// Stall jump, relocated from combat_navigator with the seat that owns the feet. Auto-step is 0.6 b, so
// this only fires on a full block or fence — and it is a TAP: holding jump while sprinting adds a
// 0.2 b/tick forward impulse toward the mob being backed away from (combat_utils Trap 2).
const STALL_EPS = 0.02;        // per-tick travel below this is the body not moving
const STALL_TICKS = 6;         // ~300 ms of pressing a key and going nowhere
const JUMP_TICKS = 4;          // ~200 ms of jump held: long enough to leave the ground

// ── SECTION 2: State ───────────────────────────────────────────────────────

// Module-level, cleared on every engage(): a tally that outlives its fight gets reprinted for the next
// one (Law 25).
let attached = false;
let engaged = false;
let stats = null;
let tickHandler = null;

let sprintArmed = false;
// lastGap/lastGapMob (prev-tick distance feeding the brake's closing meter) died with the brake. The
// pair cost two bugs — a gap surviving an engagement boundary, then a control-mob SWITCH, both caught as
// unit throws — so a reintroduced closing rate must reintroduce that identity or repeat both. lastPos
// stays: it measures the BODY'S OWN travel, a different question still asked.
let lastPos = null;
let stallTicks = 0;
let jumpTicks = 0;
// Consecutive stall-jumps with no travel in between. `stallTicks` resets on every jump, so it can never
// say the jump DIDN'T WORK — and that is the only thing that separates a lip the tap clears from a wall it
// cannot. This is the counter that earns a dig request (see terrainWant).
let stallJumps = 0;
// Peer-yield standoff (see bandOrder). Set by battle_stations when a closer bot wins the mob claim,
// cleared by it — never by this seat, which cannot know why it was told to stand off.
let standoff = null;

const NO_KEYS = { forward: false, back: false, left: false, right: false };

// State-change filter: the 20 Hz decision is usually the same one, so a line goes out only when the
// answer differs from the last. Not in `stats` — these are what the trace has been TOLD; resetting them
// means "say it again", exactly what an engagement boundary means (Invariant B).
let saidMode = null;
let saidOn = null;      // control mob when saidMode posted — a mode held across a mob SWITCH is a
                        // different decision wearing the same word
let saidSprint = false;

function _blankStats() {
  return {
    // Mode counters and stalls/jumps were removed: `mode`/`stall` events carry their own timestamps and
    // the jump result, so time-in-mode is the lens's to compute.
    ticks: 0, engagedTicks: 0, noTarget: 0,
    sprintTicks: 0, pressedTicks: 0,
    sprintAskedLastTick: 0, sprintHeld: 0, speedPeak: 0, sprintBlockedByShield: 0,
    standoffTicks: 0, standoffErrSum: 0,
    // Band audit. inBandTicks is the headline (with a dead zone the question is what fraction of the
    // fight was spent in striking distance at all); worstBreach = deepest incursion inside 1.9 b — a
    // correction that started late shows there.
    errSum: 0, errTicks: 0, worstBreach: 0, inBandTicks: 0,
    speedGotSum: 0, speedTicks: 0,
    // Ticks the feet were placed and the arm still could not reach — the fight that cannot be won from
    // the ground, kept apart from the band's error so it never reads as a steering failure.
    verticalGapTicks: 0, verticalGapSum: 0,
    // Ticks a terrain want stood, split by what it asked for. The ASK is this seat's whole half of the
    // protocol — the doing belongs to the gunner — so a driver that never asked and one whose asks were
    // all refused must not read the same in a report (Law 25).
    terrainAskTicks: 0, terrainAskDig: 0, terrainAskPlace: 0, terrainRefusedTicks: 0,
  };
}

// ── SECTION 3: The decision — pure, no bot, no world ───────────────────────

// bandOrder({ horizontal, dy, distance, swelling, standoff }) → { mode, setpoint, error } — the whole
// tactic, pure.
// No effort field: every mode moves at full effort or not at all, so `mode` alone says it; a numeric
// twin would be a value two readers could disagree about (Law 16). `error` = signed distance OUTSIDE
// the band, measured to the edge the bot is outside of (positive = too close / owes ground, negative =
// too far, 0 = inside) — there is no midpoint any more; re-entering the band is the whole goal.
//
// ── THE BAND IS A SHELL, AND THE FEET STEER ITS SHADOW ON THE FLOOR (Law 10) ───────────────────────
// BAND_INNER/OUTER are 3-D facts — both are derived from reaches, the bot's 3.0 and the mob's ~1.43,
// and a reach is a sphere. The tactic gated them on the 3-D separation, which is the right QUANTITY and
// the wrong VARIABLE: every act that can change it is flat (chooseStep scores hypot(x,z), the bearing is
// atan2(dx,dz), headingKeys resolves a heading into WSAD). So a mob three blocks straight up read as
// `approach` forever and no key closed it — the setpoint sat on an axis the feet cannot move along.
//
// The repair is the projection, not a special case: for a rise `dy` the flat distance that puts the mob
// at 3-D range D is sqrt(D² − dy²), so the band's shadow on the floor is
//   [sqrt(BAND_INNER² − dy²), sqrt(BAND_OUTER² − dy²)]
// and the feet steer THAT. At dy = 0 it collapses to 1.9–2.9 exactly, so every coplanar fight decides
// bit-for-bit as before — the change is additive, never a second dialect.
//
// WHY A PROJECTION RATHER THAN A HEIGHT THRESHOLD: a threshold ("over 2.3 b of rise is hopeless") is a
// number with no derivation that also gets the middle wrong. A mob 1 b up at 2.9 b across is 3.07 b
// away — out of reach, and the feet fix it by closing to 2.7. Only the projection knows that; a
// threshold reads it as in-band and stands there.
//
// REACH IS STILL 3-D AND MUST STAY SO. The arm reaches through the vertical; only the feet cannot.
// Gating the gunner's strike on the flat distance would claim a hit on a mob directly overhead.
//
// `vertical_gap` IS A FEET VERDICT, NOT AN ENGAGEMENT ONE. Once |dy| reaches BAND_OUTER the shadow is
// empty — no floor position achieves the band, whatever the feet do. It says this seat has put the body
// where it can and the rest is not the feet's to close; it does not drop, refuse or re-open the
// engagement, which is admitted elsewhere and by raycast. Without it the seat reports `hold` while
// standing somewhere it cannot strike from, and `hold` is what a working fight looks like.
function bandOrder(opts = {}) {
  // The flat gap is the controlled variable; `dy` sets which band it is held against. A caller with only
  // a flat distance is a coplanar caller and reads the unprojected band — not a defaulted field, a
  // narrower question (Law 13 forbids inventing a value, not accepting a simpler shape).
  const d = Number.isFinite(opts.horizontal) ? opts.horizontal : opts.distance;
  const dy = Number.isFinite(opts.dy) ? opts.dy : 0;
  if (!Number.isFinite(d)) return { mode: 'no_target', setpoint: null, error: null };

  // A standoff is a setpoint that OUTRANKS the band; exactly two: the swell (the creeper exception, 7.5)
  // and the peer yield (a claim lost to a closer bot, DISENGAGE_RANGE). One branch — both mean "get
  // clear and stay clear" vs the band's "hold striking distance"; folding them stops a second retreat
  // pathway (Law 16); only the number and setter differ. A THIRD (4.0 b guard standoff while anything
  // was drawing) was tried and deleted: the band rule with extra conditions, and the band is now held
  // against every mob. Do not reinstate — see controlMob.
  const standoff = opts.swelling ? SWELL_CLEAR : (Number.isFinite(opts.standoff) ? opts.standoff : null);
  if (standoff !== null) {
    const mode = opts.swelling ? 'swell' : 'standoff';
    const err = standoff - d;
    if (err > 0) return { mode: `${mode}_flee`, setpoint: standoff, error: err };
    // Clear — NOT handed back to the band: closing on a winding-down creeper re-ignites it; closing on
    // a peer-owned mob undoes the yield. The order is released by whoever set it, never by arriving.
    return { mode: `${mode}_clear`, setpoint: standoff, error: 0 };
  }

  // The shell's shadow on the floor. Asked BEFORE the edges because an empty shadow means the edges have
  // no floor position to name — a setpoint computed from it would be a number the feet cannot stand on.
  const rise = Math.abs(dy);
  if (rise >= BAND_OUTER) {
    // The shadow is empty, but that does NOT make the feet idle: the 3-D separation is still minimised
    // at flat zero, and getting beneath the mob is where any climb would have to begin. So the feet keep
    // closing, and only give the vertical verdict once the two columns overlap — BOT_WIDTH is the one
    // derived statement of "beneath it" available, and an invented arrival tolerance here would be a
    // taste number deciding when a fight is abandoned.
    if (d > BOT_WIDTH) return { mode: 'approach', setpoint: 0, error: -d, dy };
    // Reported, never acted on: closing the rest needs verbs this seat does not own (a climb, a pillar,
    // a route), and pressing a key at it is what produced the ten-second dead wait.
    return { mode: 'vertical_gap', setpoint: null, error: 0, verticalOnly: true, dy };
  }
  const outer = Math.sqrt(BAND_OUTER * BAND_OUTER - dy * dy);
  // Inside BAND_INNER of rise the mob is already closer than the inner edge however far the feet stand
  // back, so the inner edge has no shadow either and the floor band opens to the bot's own column.
  const inner = rise >= BAND_INNER ? 0 : Math.sqrt(BAND_INNER * BAND_INNER - dy * dy);

  // The band is a dead zone and these three lines are the whole tactic, ordered outside-in so a reader
  // sees standing still is what happens when neither edge is crossed — not a rule of its own.
  if (d > outer) return { mode: 'approach', setpoint: outer, error: outer - d };
  if (d < inner) return { mode: 'retreat', setpoint: inner, error: inner - d };
  return { mode: 'hold', setpoint: null, error: 0 };
}

// ── SECTION 4b: The retreat direction — nine candidates, scored by their worst mob ──

// Eight headings plus standing still, relative to the AWAY vector (index 0 = straight back).
// Deterministic order: identical scores must resolve the same way every run (Invariant C).
const HEADING_STEPS = 8;
// Scoring lookahead — how far the body would get in roughly one correction. NOT a leg length: the old
// fade walked exactly this far then stopped; this seat re-scores every tick.
const STEP_BLOCKS = 0.65;

// chooseStep(bot, hostiles) → { controls, score, gain, blocked, stood, candidates } | null
//
// Every heading is SCORED and the best wins, whatever the score. Standing still is an equal candidate
// (keeps "never gives up" from becoming "always moves"), and a losing-ground step can still win — least
// bad is the move. The replaced shape returned NULL when nothing validated: a bot with seven imperfect
// ways out reported none. SCORE = MINIMUM gap, not average — a candidate is worth its WORST hostile; the
// bot is killed by the nearest, not the mean (the centroid was an admitted approximation of
// maximise-the-minimum; nine candidates is small enough to just do it). Arrived whole from band_keeper
// under Law 16 (one capability, one implementation); nothing changed.
function chooseStep(bot, hostiles) {
  const self = bot && bot.entity && bot.entity.position;
  if (!self) return null;

  const points = (hostiles || [])
    .map((h) => (h && h.entity && h.entity.position) || (h && h.position) || null)
    .filter(Boolean);
  if (!points.length) return null;

  const minGapAt = (p) => {
    let m = Infinity;
    for (const q of points) {
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < m) m = d;
    }
    return m;
  };

  // Away vector from the WHOLE press, not the control mob: with three mobs on the bot, backing off one
  // walks into the other two. Straight-back is only the ORDERING (deterministic tiebreak), never the
  // choice — the choice is the score.
  let cx = 0, cz = 0;
  for (const q of points) { cx += q.x; cz += q.z; }
  cx /= points.length; cz /= points.length;
  const ax = self.x - cx, az = self.z - cz;
  const alen = Math.hypot(ax, az);
  // Mob exactly on the bot: no defined away vector — fall back to a fixed axis, not null. The contract
  // is an answer always, and "no defined direction" is precisely where any direction beats standing.
  const away = alen > 1e-6 ? { x: ax / alen, z: az / alen } : { x: 1, z: 0 };

  const here = minGapAt(self);
  const candidates = [{
    label: 'stand', controls: null, offAxisRad: 0, walkable: true, score: here,
  }];

  for (let i = 0; i < HEADING_STEPS; i++) {
    const theta = (i * 2 * Math.PI) / HEADING_STEPS;
    const dx = away.x * Math.cos(theta) - away.z * Math.sin(theta);
    const dz = away.x * Math.sin(theta) + away.z * Math.cos(theta);
    const p = { x: self.x + dx * STEP_BLOCKS, y: self.y, z: self.z + dz * STEP_BLOCKS };
    // Floor via the fleet's one floor predicate, so "walkable" means here what it means everywhere.
    // Unguarded: blockAt answers null for an unloaded column and classifyFloor is ours, so the catch
    // could only fire on a defect — and it answered "not walkable", quietly deleting escape headings.
    const stand = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const walkable = !!classifyFloor(bot, bot.blockAt(stand.offset(0, -1, 0)));
    candidates.push({
      label: `h${i}`, controls: { dx, dz },
      offAxisRad: Math.min(theta, 2 * Math.PI - theta),
      walkable,
      score: minGapAt(p),
    });
  }

  // Unwalkable candidates rank below every walkable one but stay listed — visible in the record, and a
  // fully-blocked bot still returns a ranked answer, not null. Ties break toward straight-back (fastest
  // separation, deterministic).
  const best = candidates.slice().sort((a, b) => {
    if (a.walkable !== b.walkable) return a.walkable ? -1 : 1;
    if (Math.abs(b.score - a.score) > 1e-6) return b.score - a.score;
    return a.offAxisRad - b.offAxisRad;
  })[0];

  return {
    controls: best.controls, label: best.label,
    score: best.score, gain: best.score - here, here,
    blocked: candidates.filter((c) => !c.walkable).length,
    stood: best.label === 'stand',
    candidates,
  };
}

// ── SECTION 4c: The terrain ask ────────────────────────────────────────────
// THE ONE THING THIS SEAT MAY NOT DO IS THE ONE THING IT SOMETIMES NEEDS. Digging and placing require a
// facing, and this seat never writes yaw under any circumstance — so it does not lend the yaw out and it
// does not take it back, it ASKS the seat that already holds it (gunner.serveTerrain). One state keeps one
// owner including the awkward case, which is the whole of Invariant D.
//
// A WANT, NOT A MESSAGE. The return value is republished every tick it still holds and becomes null the
// instant it does not; silence IS the withdrawal, so there is no cancel to lose and nothing the gunner can
// still be serving after this seat changed its mind (Invariant B). Read the field's note in crew_board.
//
// PER-STEP, NEVER A ROUTE. This is a per-tick controller, not a planner: it asks for the one cell in its
// way. Every trigger below is read off state the tick already computed, and no search was added to find
// them — a short-horizon planner may earn its way in later, but two asks are what the geometry actually
// produces and an unbuilt planner cannot be wrong.
//
//   vertical_gap + target ABOVE → place: the feet cannot climb and no key helps; a pillar underfoot is
//     the only move that changes the reading.
//   vertical_gap + target BELOW → dig: same verdict, opposite direction — the floor is the obstruction.
//   pressing and jumping and still not moving → dig: the tap already answers a lip (auto-step is 0.6 b,
//     the jump covers a full block). A SECOND stall-jump with no travel between them is the evidence the
//     obstruction is not something a jump clears, and it is the only reading that separates a wall from a
//     kerb. Waiting for it costs ~600 ms and stops the bot asking for a dig every time it clips a fence.
const STALL_JUMPS_BEFORE_DIG = 2;

// ── THE LATCH — a want must be STABLE while the obstruction is ───────────────────────────────────────
// MEASURED FAULT (first live soak): every dig came back `Digging aborted`, ×23 on one cell inside one
// second — the trace saying the tick rate out loud. The cell was recomputed from `Math.round(heading/len)`
// every tick, the heading is a live float that drifts as the body settles, one flipped rounding named a
// different cell, and the gunner correctly dropped its in-flight job and started another. Twenty times a
// second, so no dig ever finished.
//
// Level-triggering is not the fault and is not relaxed: silence is still the withdrawal, and the gunner's
// cell-identity test is still exact — that test is the ONLY thing that can detect a withdrawal, so
// loosening it to stop the thrash would be repairing the predicate instead of the fault (Law 25). What
// was wrong is that the want was DERIVED FRESH from a moving number when it should have been re-VALIDATED.
// So: the cell is latched when first asked for and re-published unchanged for as long as its own reason
// still holds. The reason, not the geometry — a dug cell goes to air and a closed gap changes the mode,
// and each of those clears the latch on its own without anything having to notice a heading.
let wantLatch = null;

function latchHolds(bot, order, dy) {
  const L = wantLatch;
  if (!L) return false;
  if (L.kind === 'place') return order.mode === 'vertical_gap' && dy > 0;
  const b = bot.blockAt(new Vec3(L.at.x, L.at.y, L.at.z));
  if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return false;
  return L.why === 'target_below'
    ? (order.mode === 'vertical_gap' && dy < 0)
    : stallJumps >= STALL_JUMPS_BEFORE_DIG;
}

// PROTECTED VOXELS ARE READ, NEVER RESTATED. `navigator.loadProtectedBlocks` is the single inspection
// point for "what does the bot refuse to chew through" (its PROTECTED_SOURCES list says so in as many
// words), and a second copy of that question here would go out of date the first time an integrity node
// is added (Law 16). MEASURED FAULT from the same soak: with no gate at all the driver asked to dig its
// own oak_door — the "shouldn't dig through walls" case in miniature.
//
// THE GATE BELONGS ON THE ASK, NOT THE SERVE. A gunner that performs the verb it was handed is the
// correct shape; a seat that wants a protected cell is the defect, and refusing to want it is the repair.
//
// Required lazily and only on the compute path — navigator requires battle_stations which requires this
// file, so a top-level require closes the cycle; and building the Set walks three perception nodes, which
// is not a thing to do 20 times a second for a want that fires a handful of times an hour.
function isProtected(bot, cell) {
  const { loadProtectedBlocks } = require('@locomotion/navigator');
  const set = loadProtectedBlocks(bot);
  return !!set && set.has(`${cell.x},${cell.y},${cell.z}`);
}

function terrainWant(bot, self, order, dy, heading) {
  // A REFUSAL IS LATCHED TOO, and for the same reason the want is: `isProtected` walks three perception
  // nodes to build its Set, and a body stalled against its own wall would pay that 20 times a second
  // forever. The refusal is re-validated by the identical test — the block is still there and the reason
  // still holds — so it expires exactly when a fresh answer could differ.
  if (latchHolds(bot, order, dy)) return wantLatch.refused ? null : wantLatch;
  wantLatch = null;
  const feet = self.floored();
  if (order.mode === 'vertical_gap') {
    if (dy > 0) return (wantLatch = { kind: 'place', at: { x: feet.x, y: feet.y, z: feet.z }, why: 'target_above', refused: false });
    const floor = { x: feet.x, y: feet.y - 1, z: feet.z };
    wantLatch = { kind: 'dig', at: floor, why: 'target_below', refused: isProtected(bot, floor) };
    return wantLatch.refused ? null : wantLatch;
  }
  if (stallJumps < STALL_JUMPS_BEFORE_DIG || !heading) return null;
  // The cell the body is pressing into. Feet level first, then head: a fence or a slab blocks the lower
  // one and a jutting overhang the upper, and asking for the wrong one spends the gunner's window on a
  // block that was never in the way. Air at both means the stall is not an obstruction at all (ice, a
  // mob's push, a client-side desync) and no dig can fix it — so nothing is asked for (Law 25: an ask
  // this seat cannot justify is a false claim about what would help).
  const len = Math.hypot(heading.x, heading.z) || 1;
  const ahead = feet.offset(Math.round(heading.x / len), 0, Math.round(heading.z / len));
  for (const cell of [ahead, ahead.offset(0, 1, 0)]) {
    const b = bot.blockAt(cell);
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
      // A protected cell is not a smaller ask, it is NO ask: the body stops wanting what it may not have
      // and the tick's own retreat search keeps looking for a way round. Returning null rather than
      // trying the next cell is deliberate — the second cell of a protected wall is protected too, and
      // asking for it would be walking down the wall looking for a soft spot.
      wantLatch = { kind: 'dig', at: { x: cell.x, y: cell.y, z: cell.z }, why: 'stalled_against_it',
        refused: isProtected(bot, cell) };
      return wantLatch.refused ? null : wantLatch;
    }
  }
  return null;
}

// ── SECTION 5: The tick ────────────────────────────────────────────────────

// The mob this seat controls ON — not always the mob the gunner is hitting: a swelling creeper takes
// the wheel while the gunner keeps swinging at a zombie in reach (the intended reading of "with one
// exception, the creeper"). The seats disagreeing is not a bug; they answer different questions.
function controlMob(board) {
  const swelling = board.swelling || [];
  if (swelling.length) {
    // `active` is already nearest-first (commander sorts once) — first swelling found is the nearest.
    const creeper = (board.active || []).find((h) => swelling.includes(h.id));
    if (creeper) return { mob: creeper, swelling: true };
  }
  // BAND HELD AGAINST EVERY MOB, not just the one being fought: the driver is independent of the
  // gunner's target — any mob that gets within the band is retreated from. Replaced two narrower rules:
  // band vs the CONTROL mob only (a second zombie could stand at 1.2 b all fight unnoticed) and the
  // 4.0 b brawler GUARD_STANDOFF (this rule with two extra conditions) — Law 16, one rule where there
  // were three. Nearest is the right retreat TRIGGER: the DIRECTION was already scored against every mob
  // (§4b), only the trigger was parochial — the band question is now asked of the mob most able to hit
  // the bot. The swell branch above still outranks (Law 17): a fuse is a distance the band cannot
  // express.
  const nearestAny = (board.active || [])[0] || null;
  if (nearestAny && nearestAny.distance < BAND_INNER) {
    return { mob: nearestAny, swelling: false };
  }

  // Nothing inside the band → the feet go to work (vs a pure archer wave: every tick). `closest` is the
  // fallback, NOT the offensive stance returning: `focus` is null when every mob is drawing — that null
  // answers the ARM's question (what is safe to HIT); the feet are asked where the body should BE, which
  // is the band either way, already there when the gap between draws opens. Driving on `focus` alone
  // made a lone drawing skeleton read `no_target` and stop closing entirely. The gunner's gate keeps the
  // arm honest; the feet are not the arm.
  const stand = board.focus || board.closest;
  return stand ? { mob: stand, swelling: false } : { mob: null, swelling: false };
}

// announceMode(mode, distance, setpoint, mob) — one line when the feet's answer changes, nothing else.
// A CHANGE OF CONTROL MOB counts as a mode change even when the word is identical: the seat re-aimed
// the same tactic at a different body, and only naming the mob makes controlMob's deliberate
// disagreement with the gunner's target visible (the driver's half of the gunner's `face` distinction).
function announceMode(mode, distance, setpoint, mob, horizontal, dy) {
  const on = mob ? mob.id : null;
  if (mode === saidMode && on === saidOn) return;
  saidMode = mode;
  saidOn = on;
  crewLog.event(TAG, 'mode', {
    subject: mob ? crewLog.subject(mob.entity) : null,
    to: mode,
    d: distance === null || distance === undefined ? null : distance.toFixed(2),
    // The two halves ride WITH the mode, not in a second line: `approach` at d=3.0 is a fight opening
    // when the gap is flat and a fight that cannot open when it is vertical, and the word is identical.
    across: Number.isFinite(horizontal) ? horizontal.toFixed(2) : null,
    up: Number.isFinite(dy) ? dy.toFixed(2) : null,
    setpoint: setpoint === null || setpoint === undefined ? null : setpoint,
  });
}

// Unguarded: setControlState asserts only on a bad control name or a non-boolean state, both literals
// written right here, so it cannot fail for "body gone mid-tick" as the old catch claimed. Worse, that
// catch skipped the sprint and jump releases on the one path whose entire job is to drop every key.
function release(bot) {
  for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, false);
  if (sprintArmed) { bot.setControlState('sprint', false); sprintArmed = false; }
  if (jumpTicks > 0) { bot.setControlState('jump', false); jumpTicks = 0; }
  // Sprint retraction must live HERE, not the tick's latch: release() is where the key actually drops
  // (no target / body gone / disengage) and those paths return before the latch — else the trace's last
  // word on sprint is `on` while nothing presses, a state change that was never said (Law 25).
  if (saidSprint) {
    saidSprint = false;
    crewLog.event(TAG, 'sprint', { state: 'off', why: 'released' });
  }
  stallTicks = 0;
  stallJumps = 0;
  wantLatch = null;
  // The carried sample dies here: lastPos held across an engagement boundary reports the distance
  // between two different fights as one tick of travel.
  lastPos = null;
}

function onPhysicsTick(bot) {
  if (!engaged) return;
  stats.ticks++;

  const self = bot.entity && bot.entity.position;
  if (!self) return;                                        // dead or mid-respawn: nothing to drive

  const board = crewBoard.readCommander();
  const { mob, swelling } = controlMob(board);

  if (!mob) {
    stats.noTarget++;
    release(bot);
    announceMode('no_target', null, null, null);
    writeBoard({ mode: 'no_target', setpoint: null, error: null, keys: null, sprint: false, targetId: null, terrainRequest: null, at: Date.now() });
    return;                                                 // release() above dropped both carried samples
  }

  // FRESH, not the descriptor's cached `distance`: the board was written earlier this tick, but this
  // seat's whole job is a sub-block correction and one tick of a sprinting zombie is 0.14 b — a seventh
  // of the band. Commander owns WHICH mob; the metric this controller closes on is read at the instant
  // it is used (Invariant B).
  const mobPos = mob.entity && mob.entity.position;
  if (!mobPos) { release(bot); return; }                    // body left the table between sweep and now
  const distance = Math.hypot(self.x - mobPos.x, self.y - mobPos.y, self.z - mobPos.z);
  // The two halves the 3-D total cannot be taken apart into afterwards, and they drive different seats:
  // `horizontal` is the only one the feet can change, `dy` is the one that says why they cannot.
  const horizontal = Math.hypot(self.x - mobPos.x, self.z - mobPos.z);
  const dy = mobPos.y - self.y;

  // Sprint read-back, taken BEFORE this tick writes. A run can report every pressed tick 'sprinting' at
  // walking speed, which alone cannot say which of three happened (flag never survived to the physics
  // step / engine ignored it / mean diluted by acceleration and shoulder-to-shoulder ticks), and they
  // want different repairs. So read own control state back (Law 23 — never trust your own claim) and
  // record the PEAK as discriminator: a peak at sprint speed with a lower mean is dilution, fine; a peak
  // that never leaves walking speed never sprinted.
  if (sprintArmed) {
    stats.sprintAskedLastTick++;
    // A plain property read on mineflayer's own state object — optional chaining is the whole guard.
    if (bot.controlState?.sprint === true) stats.sprintHeld++;
  }

  const order = bandOrder({ horizontal, dy, distance, swelling, standoff });

  // Audit taken before any key is pressed, so it describes the state the decision was made in.
  // TWO accumulators, not one: swell_flee errs against 7.5 b, the band against 1.9/2.9 — averaged, a
  // standoff breach can print as a band breach on a wave whose band was never touched (a standoff number
  // wearing a band label; Law 25). The band statistic counts only ticks the band was held.
  if (order.mode === 'approach' || order.mode === 'retreat' || order.mode === 'hold' || order.mode === 'vertical_gap') {
    stats.errTicks++;
    stats.errSum += order.error;
    if (order.error > stats.worstBreach) stats.worstBreach = order.error;
  } else {
    stats.standoffTicks++;
    stats.standoffErrSum += order.error;
  }
  // Against the FLAT gap, the one the band now holds — scored on the 3-D total it counted a body that had
  // done everything asked of it as out of position, which is how a vertical stall read as a driver fault.
  if (horizontal >= BAND_INNER && horizontal <= BAND_OUTER) stats.inBandTicks++;
  // Counted apart so the report can say a fight was UNWINNABLE FROM THE GROUND rather than badly driven.
  if (order.mode === 'vertical_gap') { stats.verticalGapTicks++; stats.verticalGapSum += Math.abs(dy); }
  // The mode IS what the feet do, and it is a genuine decision: same mob at same distance gives
  // `approach` or `swell_flee` depending on the board. `d`/`setpoint` ride along — "retreat" is correct
  // at 1.4 b and a bug at 4 b, identical without the number.
  announceMode(order.mode, distance, order.setpoint, mob, horizontal, dy);

  // Direction: two cases, asymmetric on purpose. Backing off is a WHOLE-FIELD decision (the mob behind
  // kills) → the nine-candidate search. Closing is a ONE-mob decision — everything else is further by
  // construction, and if the approach walks inside 2.9 of something else, the next tick's board turns
  // this into a retreat. The loop IS the obstacle handling; there is no plan to invalidate.
  // `moving` is the whole throttle: full effort or none, which verb not how hard — no movement inside
  // the band, full press outside either edge.
  // `vertical_gap` joins `hold` as a standing mode: its whole content is that no key helps, so pressing
  // one is the behaviour it was added to stop.
  const moving = order.mode !== 'hold' && order.mode !== 'vertical_gap'
    && order.mode !== 'no_target' && !order.mode.endsWith('_clear');
  let heading = null;
  let stepInfo = null;
  if (moving && order.mode !== 'approach') {
    // Away from the press, not the control mob — chooseStep's worst-hostile score is the whole of
    // "careful not to get too close to other ones".
    stepInfo = chooseStep(bot, board.active);
    if (stepInfo && stepInfo.controls) heading = { x: stepInfo.controls.dx, z: stepInfo.controls.dz };
    else if (stepInfo && stepInfo.stood) heading = null;     // standing scored best: it is an answer
  } else if (moving) {
    heading = { x: mobPos.x - self.x, z: mobPos.z - self.z };
  }

  // ── SPRINT ─────────────────────────────────────────────────────────────────
  // KNOCKBACK ONLY: walking vs sprinting saves very little over a full engagement, so sprinting logic is
  // removed from everywhere but the knockback use. A BRAKE stood here (closing meter + coast calculator
  // + species branch, cutting the press at the stopping distance); measured against a flat walk, the
  // braked sprint was slower than never sprinting — the machinery that made sprint safe made it slower
  // than a walk. The sprint that stays buys what a walk cannot — Java reads isSprinting() at the instant
  // an attack resolves — so it arms on BRAWLER approach ticks; never on retreat, swell flee, in-band, or
  // (then) a kiter, whose shove pushes the archer out of reach. No brake needed now: sprint coast is
  // ~0.62 b, so a release at 2.9 lands ~2.28 — INSIDE the band; the brake's overshoot came from a
  // brawler HOLDING the press through the stopping distance (powered, not coasting), and that branch is
  // gone. `press` is in the condition so sprint never arms on a standing body: a stationary sprint is a
  // packet no vanilla client sends (Law 19).
  //
  // CLOSING sprint is also armed against kiters, superseding the knockback-only reasoning above on its
  // own terms: the slower-than-walk measurement was of the BRAKED sprint, and the brake is deleted. An
  // unbraked walk against archers measured well below walking speed on every approach leg, and several
  // skeletons were never struck at all.
  //
  // MECHANISM = THE BOT'S OWN SLOWNESS, NOT SKELETON SPEED. RECURRING AI-DEVELOPER ERROR, recorded for
  // that reason — the wrong sentence "a skeleton backs away at a walk, so the closing rate is the
  // difference of two walks and a walking bot can never arrive" regenerates from training-data kiting
  // intuition. A drawing archer is mostly STATIONARY and strafes (it cannot fire and flee at once); this
  // fleet has never measured a skeleton outrunning anything. The measurements hold; the corrected WHY is
  // the bot's half of the gap: the guard is up much of a fight's ticks and item-use costs most of the
  // body's speed, so a half-walk bot closes on a drifting target at nearly nothing — sprint pays back
  // what the shield costs, it does not beat a runner. An accumulated distance across several legs reads
  // as a large number but is not a speed; reading it as one produced the wrong sentence.
  //
  // The shove objection stays answered: the flag drops at 3.3 b — one sprinting tick (0.28 b) clear of
  // the arm's 3.0 b reach — so the release packet is out before a swing can resolve; it buys ground,
  // never a knockback. Releasing earlier is too early: approach runs from 2.9, so an early release
  // leaves a wide corridor crossed at SHIELDED speed, well under a walk — where skeletons go unstruck.
  // The number belongs as close to reach as the release packet allows.
  const SPRINT_RELEASE_B = 3.3;
  const shoves = order.mode === 'approach' && combatUtils.combatTactic(mob.name) === 'BRAWLER';
  const closing = order.mode === 'approach' && distance > SPRINT_RELEASE_B;

  // A press is a press — no fraction to realise, no dither. `heading` null is the only stop: the mode
  // does not move, or the step search scored standing best.
  const press = heading !== null;

  // Yaw is read RAW and FRESH, and this file may not write it (Law 21 — this seat never touches yaw, it
  // only responds to it). Read from the body, not the gunner's board section: the board says what the
  // gunner DECIDED, yaw says where the body actually points, and a failed bot.look makes them differ —
  // keys come from the body (Law 23).
  const keys = press && heading ? headingKeys(heading, bot.entity.yaw) : NO_KEYS;

  // Unguarded, same reason as release(): the only throw setControlState has is our own bad literal, and
  // the catch here answered by returning — abandoning the rest of the tick, sprint and jump included.
  for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, keys[k]);

  // SPRINT IS RE-ARMED, NOT SET — the inherited trap: Java's Player.attack() calls setSprinting(false)
  // after a sprint attack, so the SERVER's flag drops while mineflayer's local controlState.sprint stays
  // true — and setControlState short-circuits on `if (controlState[control] === state) return`, sending
  // nothing. Set-once would sprint until the gunner's first swing then walk with the flag reading true.
  // combatUtils.armSprint is the false-then-true fix, called EVERY tick sprint is wanted — the gunner
  // may have swung on any of them and the seats do not talk.
  // THE SHIELD EXCLUDES SPRINT, held every tick: a vanilla client cannot sprint and block (item-use
  // clears sprint), but mineflayer asserts sprint via its own entity-action packet and the server
  // honours it regardless. The Rogue Machine by name (Law 19). It lives HERE because this seat owns
  // sprint (Invariant D), re-read every tick because armSprint re-asserts every tick — a once-at-raise
  // exclusion is defeated by the next re-arm. The gunner PUBLISHES the guard; it never reaches in to
  // drop the key (Law 1).
  const guarding = crewBoard.readGunner().shield === true;
  if (guarding) stats.sprintBlockedByShield++;
  const wantSprint = press && (shoves || closing) && !guarding;
  if (wantSprint) {
    combatUtils.armSprint(bot);
    sprintArmed = true;
    stats.sprintTicks++;
  } else if (sprintArmed) {
    combatUtils.releaseSprint(bot);
    sprintArmed = false;
  }
  // Sprint is announced with its STOP REASON — the three want different repairs and the flag names
  // none: guard took it (Law 19 exclusion working), not a brawler (knockback useless), or no press.
  // The LATCH, not the call, makes this one line per change (armSprint re-asserts every tick).
  if (wantSprint !== saidSprint) {
    saidSprint = wantSprint;
    crewLog.event(TAG, 'sprint', {
      state: wantSprint ? 'on' : 'off',
      why: wantSprint ? 'knockback' : (guarding ? 'guarding' : (!shoves ? 'not_brawler' : 'no_press')),
    });
  }
  if (press) stats.pressedTicks++;

  // ── THE STALL TAP ──────────────────────────────────────────────────────────
  const travelled = lastPos ? Math.hypot(self.x - lastPos.x, self.z - lastPos.z) : null;
  if (travelled !== null) {
    // Sampled only on ticks the body was ASKED to move: averaging in stand ticks reports a bot holding
    // a perfect band as one that cannot walk (Law 25).
    if (press) {
      stats.speedTicks++;
      const bps = travelled * 20;
      stats.speedGotSum += bps;
      if (bps > stats.speedPeak) stats.speedPeak = bps;
    }
    if (press && travelled < STALL_EPS) stallTicks++; else { stallTicks = 0; stallJumps = 0; }
  }
  if (jumpTicks > 0) {
    jumpTicks--;
    if (jumpTicks === 0) bot.setControlState('jump', false);
  } else if (stallTicks >= STALL_TICKS) {
    let jumped = false;
    // setControlState asserts only on a bad control name or non-boolean state — our defect, never the
    // world's — so the press is unguarded and `jumped` is now simply true (Law 13).
    bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; jumped = true;
    stallTicks = 0;
    stallJumps++;
    // A stall is a discrete event with a cause (mode + keys at the moment the body stopped answering);
    // a count alone says N times and nothing about where or on what. `jump=no` is what a count could
    // never say: the tap is the RESPONSE, and a body whose setControlState throws stalls repeatedly
    // with nothing tried — formerly two counters whose difference carried that fact silently.
    crewLog.event(TAG, 'stall', {
      subject: crewLog.subject(mob.entity), mode: order.mode, d: distance.toFixed(2),
      keys: Object.keys(keys).filter((k) => keys[k]).join('+') || 'none',
      jump: jumped ? 'yes' : 'no',
    });
  }
  lastPos = { x: self.x, z: self.z };
  stats.engagedTicks++;

  // Counted before the write so the tally and the published want can never disagree.
  const want = terrainWant(bot, self, order, dy, heading);
  if (want) {
    stats.terrainAskTicks++;
    if (want.kind === 'dig') stats.terrainAskDig++; else stats.terrainAskPlace++;
    // The answer is READ, never assumed — this seat learns whether the yaw was available the same way it
    // learns everything else about the gunner: off the board (Law 1, Law 23).
    const ans = crewBoard.readGunner().terrainStatus;
    if (ans && ans.state === 'refused') stats.terrainRefusedTicks++;
  }

  writeBoard({
    mode: order.mode,
    setpoint: order.setpoint,
    error: order.error,
    // Recomputed from THIS tick's state and never carried: a want held over from a tick whose geometry has
    // moved is the remembered-intent defect the level-triggered design exists to make impossible.
    terrainRequest: want,
    distance,
    targetId: mob.id,
    swelling,
    keys: press ? keys : null,
    sprint: press,
    // Step search verdict posted, not re-derived: `blocked` = candidates with no floor, `gain` = chosen
    // vs standing. A fade that came out sideways vs backwards is told by reading these, not inference.
    stepGain: stepInfo ? stepInfo.gain : null,
    stepBlocked: stepInfo ? stepInfo.blocked : null,
    at: Date.now(),
  });
}

// ── SECTION 6: Public API ──────────────────────────────────────────────────

// Handler held so `stop` removes exactly its own: removeAllListeners('physicsTick') would take the
// commander and gunner down too — three seats share that event, and a teardown that cannot name its
// own listener is a Law 8 lifecycle with two other owners' work inside it.
function start(bot) {
  if (attached) return;
  stats = _blankStats();
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
}

function stop(bot) {
  if (!attached || !tickHandler) return;
  // removeListener is EventEmitter bookkeeping and cannot fail; a throw here would mean no bot, which is
  // a defect (Law 13).
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  tickHandler = null;
  attached = false;
  engaged = false;
}

// engage()/disengage() bracket a WAVE; the body is released on the way out rather than left where the
// last tick put it (Law 8 — the lifecycle that raised it terminates it; engageThreat's finally is the
// same stop at the caller).
function engage() {
  if (engaged) return;
  stats = _blankStats();
  lastPos = null;
  stallTicks = 0;
  stallJumps = 0;
  wantLatch = null;
  standoff = null;
  // The trace has been told nothing about THIS fight: carrying saidMode across the boundary suppresses
  // the new wave's first line whenever it opens in the mode the last one ended in — a fight starting
  // mid-sentence (Invariant B).
  saidMode = null;
  saidOn = null;
  saidSprint = false;
  engaged = true;
}

function disengage(bot) {
  if (!engaged) return;
  engaged = false;
  if (bot) release(bot);
}

// One aggregated line per wave (Law 5 — accumulate then post; no per-tick logging in this seat, ever,
// at 20 Hz).
function report() {
  if (!stats) return;
  // A seat that ran and never got a target must say so LOUDLY. This used to silently return on
  // `!stats.errTicks` — silent in the one failure it exists to report: a bot standing in the open taking
  // fire with no driver line at all, so a seat doing nothing looked identical to one never asked. A
  // missing line reads "nothing to report" — the false verdict Law 25 is about; the failure must be
  // louder than the success. WARNING, not summary: a fight the feet sat out is environmental, read first
  // (Law 5).
  if (!stats.errTicks) {
    if (stats.ticks) {
      watcher.warn(TAG,
        `🚗 Driver: ${stats.ticks} tick(s) engaged and NOT ONE of them had a target — ` +
        `${stats.noTarget} tick(s) read an empty board. The feet sat out this entire fight. The commander ` +
        `owns which mob is on the board (aggro + sightline); this seat only reads it.`);
    }
    return;
  }
  const meanErr = stats.errSum / stats.errTicks;
  const inBand = (100 * stats.inBandTicks) / stats.errTicks;
  const got = stats.speedTicks ? stats.speedGotSum / stats.speedTicks : 0;
  // What survives this trim: every number here is measured on ticks that emitted NOTHING — the only
  // kind an event stream cannot reconstruct. A run whose `mode` events read perfectly can still spend
  // most of the fight outside 1.9–2.9 b; this line is the only place that shows. Anything the events
  // already carry was deleted (modes → `mode`, stalls and jump taps → `stall`).
  watcher.summary(TAG,
    `🚗 Driver: ${stats.errTicks} tick(s) on a target. Mean error ${meanErr >= 0 ? '+' : ''}${meanErr.toFixed(2)}b ` +
    `outside the band (positive = too close, 0 = in it), worst breach ${stats.worstBreach.toFixed(2)}b, ` +
    `${inBand.toFixed(0)}% of ticks inside ${BAND_INNER}–${BAND_OUTER}b. ` +
    `Body achieved ${got.toFixed(2)}b/s while moving (a sprint is ${SPRINT_SPEED}) over ${stats.pressedTicks} pressed tick(s). ` +
    // Sprint as a FRACTION of the press: the ratio IS the policy — sprintTicks well below pressedTicks
    // is the expected reading; equality means the knockback-only rule is lost. The read-back is the
    // only evidence the flag reached the physics step (Law 23); the peak tells a body that never
    // sprinted from one that sprinted in bursts.
    `Sprint (knockback only — brawler approaches): armed on ${stats.sprintTicks} of ${stats.pressedTicks} pressed tick(s), ` +
    `still set on the next tick ${stats.sprintHeld}/${stats.sprintAskedLastTick}, ` +
    `peak ${stats.speedPeak.toFixed(2)}b/s against a ${SPRINT_SPEED} sprint and a ${WALK_SPEED} walk` +
    `${stats.sprintBlockedByShield ? `, and the shield held sprint down on ${stats.sprintBlockedByShield} tick(s)` : ''}.` +
    `${stats.standoffTicks ? ` Standoff (counted apart from the band): ${stats.standoffTicks} tick(s), mean error ${(stats.standoffErrSum/stats.standoffTicks).toFixed(2)}b.` : ''}`);

  // WARNING, not a clause on the summary above: a fight the feet could not have won is an environmental
  // verdict about the ground, and reading it as poor steering sends the next repair to the wrong seat
  // (Law 5 — warnings are read first). The number that discriminates is the mean rise: a body pressed
  // against a ledge reads the same in every other statistic as one holding a perfect band.
  if (stats.terrainAskTicks) {
    watcher.summary(TAG,
      `🚗 asked the gunner for terrain on ${stats.terrainAskTicks} tick(s) — ${stats.terrainAskDig} dig, ` +
      `${stats.terrainAskPlace} pillar; the yaw was spoken for on ${stats.terrainRefusedTicks} of them. ` +
      `This seat never digs: it publishes a want and the gunner serves it or does not (see its own line).`);
  }
  if (stats.verticalGapTicks) {
    const meanRise = stats.verticalGapSum / stats.verticalGapTicks;
    watcher.warn(TAG,
      `🚗 UNWINNABLE FROM THE GROUND — ${stats.verticalGapTicks} of ${stats.errTicks} tick(s) had the feet correctly ` +
      `placed with the mob still out of the arm's ${BOT_STRIKE_REACH}b, mean ${meanRise.toFixed(2)}b of rise between them. ` +
      `The band is held across the ground because that is the only axis the feet move on, so this separation is ` +
      `not a steering fault and no key closes it — it needs a verb that changes the body's height. ` +
      `The engagement was never dropped: admitting a mob is the commander's (aggro + sightline), and this seat only ` +
      `reports that it has done all a pair of feet can.`);
  }
}

// setStandoff(range|null) — the ONE thing another seat may write to this driver, and it is a setpoint,
// not a command: the driver still decides heading and keys. A key-writing caller would be a second
// owner of the body (Invariant D).
function setStandoff(range) {
  standoff = Number.isFinite(range) ? range : null;
}

function state() {
  return { attached, engaged, stats: stats ? { ...stats } : null };
}

module.exports = {
  start, stop, engage, disengage, report, state, setStandoff,
  // Bench exports: both pure, both where this seat can be wrong arithmetically.
  bandOrder, chooseStep,
  BAND_INNER, BAND_OUTER, SWELL_CLEAR, WALK_SPEED, SPRINT_SPEED,
};
