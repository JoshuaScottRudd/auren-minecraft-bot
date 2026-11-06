// fragment: herd_executor (action / ranching) — a LIBRARY: herd_manager owns the job and calls herdAnimal().
// purpose: Leads one animal into a pen by holding wheat. One verb: herd an animal into a pen (Law 0).
//          The animal is never pushed, leashed or carried; it follows the held wheat, and the executor
//          walks in short legs, each one a normal pathfinding call, waiting for the animal after every leg.
//
// THE EXECUTOR RULES, THE NAVIGATOR WALKS. The executor decides whether the animal is following, keeps the
// wheat in hand, and says how many steps the next leg may take. The navigator plans the whole route to
// the pen's lineup cell and walks only that many steps of it (goTo max_steps), knowing nothing of the
// animal. While the animal follows, the route is a `leading` one: it may dig and place like any walk,
// except the two straight-up-and-down moves (dig_down, pillar) the animal cannot follow; a dug tunnel or
// stair is a path it walks after the herder. The wheat is held in the off-hand (showLure), so a dig in
// the main hand never takes it out of the animal's sight. The walk out to an animal not yet following is an ordinary walk. Every herd walk
// spares the builds (spare_builds): a herder has no business in a field or a wall, so a cut is refused and the
// animal it would reach counts as unreached. After each leg the executor
// waits for the animal; one that fell out of tempt range is walked back to and re-tempted.
//
// THE BRINGER IS A TENDER (@api/pen_gate owns the pen's geometry, the gate, the standby cell, the shepherd's post and
// the tending board). With its animal following it takes the standby cell (one tender at a time; a held cell is waited
// for with the flock at heel), leads its flock onto it, and waits there with its wheat shown until a shepherd holds
// the penned flock from the post. Then, in one pass and without stopping to check: it claims the gate, leads its flock
// along the axis to the LINEUP cell (HERDING.gate_approach_blocks out, the way a walk enters a lane by its mouth first),
// steps to the outer cell and opens the gate (and a side gate beside it, pen.side_gate), walks straight in along the
// axis to the DEEP cell (a tempted animal stops 2.5 blocks short of the wheat, so the flock clears the doorway only
// with the wheat this far in), waits for its flock inside, carries it on to the FAR cell by the back fence, puts its
// wheat away so the flock turns to the shepherd's, walks back to the inner cell and shuts the gate from there. Leaving is pen_gate.leavePen's, called by the manager:
// through the gate one step at a time (pen_gate.passGate). An animal that missed the gate is wandering outside; the
// next herd fetches it.
// THE SHEPHERD (shepherdFor, the shepherd job): it never enters the pen. With the gate shut it shows its wheat at the
// gate's end of a long side and sweeps the flock to the back along the fence (pen_gate.sweepPath), to the post against
// the far fence opposite the gate, and holds there until the tender says it is out with the gate shut; then it leaves.
//
// invariants:
//  - The animal is re-sensed by entity id at every step (Invariant B); a despawned or unsensed animal
//    ends the herd as an environmental failure, never a throw (Law 13).
//  - A malformed pen record or a missing animal id is a coding violation and throws (Law 13).
//  - Returns its outcome to the manager; the readable names the outcome and changes only with progress, so a
//    herd that repeats without gaining ground trips the judge (Law 11).

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { combatCheckpoint } = require('@api/battle_stations');
const { penGeometry, insidePen, waitFor, stepInto, setGates, penned, holdGate, releaseGate, tendingCells, tryPark, releasePark, tryShepherd, releaseShepherd, parkedTender, shepherdOf, shepherdSeen, awaitShepherd, sayPhase, phaseOf, askBreeding, shepherdCellToward, animalsNear, foreignNear, clearAxis, lureLine } = require('@api/pen_gate');
const { HERDING } = require('@thinking/architect_config');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');
const { swingNow, swingDistance, BOT_STRIKE_REACH } = require('@utils/combat_utils');
const timeoutCrash = require('@utils/timeout_crash');

const TAG = 'herd_executor';
const LURE = 'wheat';
const LEAD_ARRIVE = 2;         // the lead ends this close to the lineup cell; a straight step covers the rest
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const centre = c => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function animalOf(bot, id) {
  const e = bot.entities[id];
  return e && e.isValid !== false && e.position ? e : null;
}

// THE WHEAT IS HELD IN THE OFF-HAND. A tempted animal follows wheat in either hand, whichever way the
// herder faces; wheat leaving both hands loses it. In the off-hand it stays shown while the main hand digs
// and places along a leading route. The off-hand's own item (a shield) is put back when the herd ends.
const offHand = bot => bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
const holdsLure = bot => offHand(bot)?.name === LURE;
// The carried wheat: the off-hand is not among inventory.items(), so a herder already holding it counts it there.
const carriesLure = bot => holdsLure(bot) || bot.inventory.items().some(it => it.name === LURE);

// showLure(bot, why): the wheat into the off-hand; said once each time it comes into the hand (pen_gate.lureLine).
async function showLure(bot, why = '-') {
  if (holdsLure(bot)) return true;
  const wheat = bot.inventory.items().find(it => it.name === LURE);
  if (!wheat) return false;
  const r = await guardExternal(TAG, 'equip wheat to the off-hand', () => bot.equip(wheat, 'off-hand'));
  const shown = r.ok && holdsLure(bot);
  if (shown) lureLine(bot, 'shown', why);
  return shown;
}

// THE WHEAT LEAVES THE HAND WHEN THE HERD ENDS: wheat still shown keeps the penned animal at the herder's heels, and it
// follows the herder out of the gate. With no item of its own to put back, the off-hand is emptied into the pocket.
async function restoreOffHand(bot, name) {
  if (holdsLure(bot) && (!name || name === LURE)) {
    const r = await guardExternal(TAG, 'take the wheat out of the off-hand', () => bot.unequip('off-hand'));
    if (!r.ok || holdsLure(bot)) watcher.warn(TAG, 'the wheat did not leave the off-hand after the herd.');
    else lureLine(bot, 'away', 'herd_end');
    return;
  }
  if (!name || name === LURE || offHand(bot)?.name === name) return;
  const item = bot.inventory.items().find(it => it.name === name);
  if (!item) return;
  const r = await guardExternal(TAG, `return ${name} to the off-hand`, () => bot.equip(item, 'off-hand'));
  if (!r.ok || offHand(bot)?.name !== name) watcher.warn(TAG, `${name} did not go back to the off-hand after the herd.`);
}

// awaitFollower: true when the animal reaches the herder. The wait renews while it is still closing,
// so a slow swimmer is waited for and a stationary one is not.
// `id` is one animal or a flock (an array): a flock has caught up when any animal of it has.
async function awaitFollower(bot, id, ms) {
  const ids = Array.isArray(id) ? id : [id];
  const nearest = () => Math.min(...ids.map(i => animalOf(bot, i)).filter(Boolean).map(a => flat(a.position, bot.entity.position)));
  let last = Infinity;
  return waitFor(
    () => nearest() <= HERDING.caught_up,
    ms,
    () => {
      const d = nearest();
      if (!Number.isFinite(d)) return false;
      const closing = d < last - 0.2;
      last = d; return closing;
    });
}

// leg: one budgeted walk toward `cell` → 'arrived', 'leg_walked' (budget spent short of it) or 'failed', the
// navigator's reason for a failed walk kept on m.lastNav for the fault survey.
async function leg(bot, cell, m) {
  const nav = await locomotion.goTo({ x: cell.x, y: cell.y, z: cell.z, leading: true, spare_builds: true, max_steps: HERDING.leg_steps, leg: 'work' });
  if (nav && nav.arrived) return 'arrived';
  if (nav && nav.step_budget_spent) return 'leg_walked';
  m.lastNav = (nav && nav.reason) || 'no_reason_given';
  return 'failed';
}

// kvLine: a machine line's fields, `k=v` in order; null/undefined/'' print as '-', whitespace in a value as '_'.
function kvLine(fields) {
  const v = x => (x === null || x === undefined || x === '' ? '-' : (typeof x === 'number' ? +x.toFixed(1) : String(x).replace(/\s+/g, '_')));
  return Object.entries(fields).map(([k, x]) => `${k}=${v(x)}`).join(' ');
}

// THE FAULT SURVEY: where the animal stands and what holds it, read by the herder the moment a herd fails, so a stuck
// animal reads as stuck and says how — in water, in a hole (sides two blocks high it cannot jump), behind a fence,
// inside closed ground no route may enter, or above or below the herder — beside the navigator's own reason for the
// last walk that failed. It is the record a dig or place to free the animal is chosen from.
function faultSurvey(bot, id, m) {
  const { isBlockPassable } = require('@utils/pathfinding_utils');
  const me = feetOf(bot.entity.position);
  const base = { herder_at: cellText(me), last_nav: m.lastNav || null };
  const a = animalOf(bot, id);
  if (!a) return { ...base, sensed: false };
  const p = feetOf(a.position);
  const at = (dx, dy, dz) => bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz));
  const open = b => !!b && isBlockPassable(b);
  let walls = 0, stepUps = 0, fenced = 0, drops = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const side = at(dx, 0, dz);
    if (side && /fence|wall|gate/.test(side.name)) fenced++;
    if (open(side)) { if (open(at(dx, -1, dz))) drops++; continue; }
    if (open(at(dx, 1, dz)) && open(at(dx, 2, dz))) stepUps++; else walls++;
  }
  const feet = at(0, 0, 0), floor = at(0, -1, 0);
  return {
    ...base, sensed: true, animal_now: cellText(p), dist: flat(a.position, bot.entity.position), dy: p.y - me.y,
    feet: feet?.name || null, floor: floor?.name || null, in_water: feet?.name === 'water' || a.isInWater === true,
    walls_2_high: walls, step_ups: stepUps, drops, fenced, closed_by: require('@locomotion/navigator').closedBy(p),
  };
}

const feetOf = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

// acquire: walk to the animal until it is within acquire_blocks, show the wheat, and wait for it to come.
// The animal is not following yet, so each approach is one whole walk to where it stands now, re-aimed
// at its fresh position until the herder is close. An animal a peer's flock took into the pen meanwhile is penned,
// and the walk ends there: a walk aimed at a cell inside the pen climbs the fence.
async function acquire(bot, id, m, geo) {
  for (let walks = 0; ; walks++) {
    const a = animalOf(bot, id);
    if (!a) return 'animal_not_sensed';
    if (insidePen(geo, a.position)) return 'penned_by_a_peer';
    if (flat(bot.entity.position, a.position) <= HERDING.acquire_blocks) break;
    if (walks >= HERDING.max_approach_walks) return 'animal_out_of_reach';
    const nav = await locomotion.goTo({ ...feetOf(a.position), spare_builds: true, leg: 'work' });
    if (!nav || nav.arrived === false) { m.lastNav = (nav && nav.reason) || 'no_reason_given'; return 'route_to_animal_failed'; }
  }
  if (!(await showLure(bot, 'tempt_animal'))) return 'no_wheat';
  const follows = await awaitFollower(bot, id, HERDING.tempt_wait_ms);
  const now = animalOf(bot, id);
  watcher.summary(TAG, `TEMPT animal=${id} result=${follows ? 'follows' : 'not_tempted'} dist=${now ? flat(now.position, bot.entity.position).toFixed(1) : '-'}`);
  return follows ? null : 'animal_not_tempted';
}

// leadTo: lead the animal to `cell`, one budgeted leg at a time, until the herder stands within `arrive` of it.
// The bound is three legs per leg of the straight line, so a route that gains no ground ends instead of repeating.
// `id` is the animal led, or the flock (an array) the bringer takes in, led while any of it follows.
// regain() answers an animal that fell out of tempt range → fault or null. → fault or null.
async function leadTo(bot, id, cell, m, arrive, regain, eachLeg = () => {}) {
  const ids = Array.isArray(id) ? id : [id];
  const maxLegs = m.legs + 3 * Math.ceil(flat(bot.entity.position, cell) / HERDING.leg_steps) + 6;
  while (flat(bot.entity.position, centre(cell)) > arrive) {
    eachLeg();
    if (m.legs >= maxLegs) return 'no_ground_gained_toward_pen';
    await combatCheckpoint(bot, 'herd');
    if (!ids.some(i => animalOf(bot, i))) return 'animal_not_sensed';
    const walked = await leg(bot, cell, m);
    m.legs++;
    if (walked === 'failed') return 'route_to_pen_failed';
    if (!(await showLure(bot, 'lead_leg'))) return 'no_wheat';
    if (await awaitFollower(bot, ids, HERDING.lag_wait_ms)) { if (walked === 'arrived') break; continue; }
    const trailing = ids.map(i => animalOf(bot, i)).some(a => a && flat(a.position, bot.entity.position) <= HERDING.tempt_range);
    if (trailing) continue;   // trailing, still held
    const lost = await regain();
    if (lost) return lost;
  }
  return null;
}

// standOn(bot, cell, m, what) → true once the body stands on `cell`: a step that ends short is walked again, then
// stepped. Where it stands instead, and how far off, is written ([HERD_STAND]) and kept on m.offCell.
async function standOn(bot, cell, m, what) {
  for (let tries = 0; flat(bot.entity.position, centre(cell)) > 1 && tries < 2; tries++) {
    if (!(await stepInto(bot, cell))) await locomotion.goTo({ x: cell.x, y: cell.y, z: cell.z, spare_builds: true, leg: 'work' });
  }
  const off = flat(bot.entity.position, centre(cell));
  if (off <= 1.5) return true;
  m.offCell = `${what}:${cellText(feetOf(bot.entity.position))}`;
  watcher.warn('herd_stand', `stand what=${what} cell=${cellText(cell)} at=${cellText(feetOf(bot.entity.position))} off_blocks=${off.toFixed(1)}`);
  return false;
}

// shepherdPost: THE SHEPHERD. Claim the post, walk to the sweep's first stand (the gate's end of a long side, the gate
// shut), show the wheat, sweep the flock to the back of the pen along the fence (sweepFlock) to the post opposite the
// gate, count the penned flock in tempt reach of it (reachOf), say it is holding (pen_gate.sayPhase), and hold until
// the tender says it is out → null, or a fault. The shepherd never enters the pen. The post is given up whatever the
// outcome. m.heldFor names the tender held for; m.sweep and m.reach are the sweep's and the reach's counts.
async function shepherdPost(bot, geo, botId, sweep, m, clock) {
  if (!(await tryShepherd(geo, botId))) return 'post_held_by_a_peer';
  return withCleanup(TAG, 'give up the shepherd post', async () => {
    sayPhase(geo, botId, 'shepherd', 'en_route');
    clock.to('walk');
    const start = sweep[0], post = sweep[sweep.length - 1];
    const nav = await locomotion.goTo({ x: start.x, y: start.y, z: start.z, spare_builds: true, leg: 'work' });
    if (!nav || nav.arrived === false) { m.lastNav = (nav && nav.reason) || 'no_reason_given'; return 'route_to_post_failed'; }
    // AT THE STAND, NOT NEAR IT: a walk that ends short (a corner, a bump on the apron) is walked again, then stepped.
    if (!(await standOn(bot, start, m, 'sweep_start'))) return 'post_not_reached';
    if (!(await showLure(bot, 'shepherd_sweep'))) return 'no_wheat';
    clock.to('place');
    m.sweep = await sweepFlock(bot, sweep);
    if (!(await standOn(bot, post, m, 'post'))) return 'post_not_reached';
    m.reach = reachOf(bot, geo);
    const tender = parkedTender(bot, geo, botId);
    m.heldFor = tender ? tender.id : null;
    sayPhase(geo, botId, 'shepherd', 'holding');
    const r = m.reach;
    const said = `holding at (${r.shepherd_at}) for ${m.heldFor || 'no tender'}: ${r.in_reach} of ${r.penned} penned in tempt reach after a sweep of ${m.sweep.stands} stand(s), ${m.sweep.missed} missed`;
    if (r.out_of_reach) watcher.warn(TAG, `${said}; NOT TEMPTED: ${r.out_of_reach} at ${r.out_at}`); else watcher.summary(TAG, said);
    if (!tender) return null;   // the tender finished or gave up before the shepherd came
    clock.to('hold');
    // Held until the tender says it is out (its word wakes this wait). A tender that leaves without a word (killed,
    // disconnected) has its standby cell freed with its magnet: that, read free for HERDING.shepherd_release_ms on end,
    // ends the hold as well. Every HERDING.wait_say_ms the shepherd writes the tender's word ([HERD_WAIT]).
    let freeSince = null, saidAt = Date.now();
    const started = Date.now();
    // THE HOLD IS A STANDING BODY'S WAIT, SO IT CALLS THE COMBAT GATE ITSELF: nothing else does while it stands. A zombie killed a holding shepherd in 6s, unengaged.
    const holdOver = () => {
      if (Date.now() - saidAt >= HERDING.wait_say_ms) {
        saidAt = Date.now();
        watcher.summary('herd_wait', `wait for=tender waited_s=${((saidAt - started) / 1000).toFixed(1)} tender=${m.heldFor} word=${phaseOf(geo, m.heldFor) || '-'}`);
      }
      if (phaseOf(geo, m.heldFor) === 'out') return true;
      if (parkedTender(bot, geo, botId)) { freeSince = null; return false; }
      freeSince = freeSince || Date.now();
      return Date.now() - freeSince >= HERDING.shepherd_release_ms;
    };
    let freed = false;
    while (!freed && Date.now() - started < HERDING.shepherd_wait_ms) {
      await combatCheckpoint(bot, 'herd');
      freed = await waitFor(holdOver, HERDING.shoo_tick_ms);
    }
    if (!freed) watcher.warn(TAG, `shepherd gave up waiting for ${m.heldFor} to say it is out after ${HERDING.shepherd_wait_ms / 1000}s`);
    return freed ? null : 'tender_did_not_finish';
  }, () => releaseShepherd(geo, botId));
}

// sweepFlock(bot, sweep): THE MAGNET SWEEP. The wheat shown, the body walks the sweep's stands one at a time (a straight
// step, a route where the step falls short), resting HERDING.sweep_step_ms on each so the tempted flock keeps pace
// along the inside of the fence → { stands, missed }: a stand neither reaches is passed over.
async function sweepFlock(bot, sweep) {
  let missed = 0;
  for (const cell of sweep.slice(1)) {
    if (!(await stepInto(bot, cell))) {
      const nav = await locomotion.goTo({ x: cell.x, y: cell.y, z: cell.z, spare_builds: true, leg: 'work' });
      if (!nav || nav.arrived === false) { missed++; continue; }
    }
    await sleep(HERDING.sweep_step_ms);
  }
  return { stands: sweep.length, missed };
}

// reachOf: EVERY PENNED ANIMAL IN THE SHEPHERD'S TEMPT REACH, counted at the post → { penned, in_reach, out_of_reach,
// out_at, shepherd_at }. Those out of reach (the sweep did not draw them) are named, never hidden: the shepherd holds
// all the same.
function reachOf(bot, geo) {
  const all = penned(bot, geo, geo.animal);
  const left = all.filter(a => flat(a.position, bot.entity.position) > HERDING.tempt_range);
  return { penned: all.length, in_reach: all.length - left.length, out_of_reach: left.length, shepherd_at: cellText(feetOf(bot.entity.position)),
    out_at: left.map(a => cellText(feetOf(a.position))).join('/') || null };
}

// shepherdFor(bot, pen, clock) → { held, fault, held_for, reach }: THE SHEPHERD JOB (shepherd_manager). A body holds the
// penned flock for the tender standing by at the pen. held is false (fault null) when no tender stands by or a peer
// already holds the post.
async function shepherdFor(bot, pen, clock) {
  const geo = penGeometry(pen);
  const botId = process.env.BOT_ID || 'default';
  const none = { held: false, fault: null, held_for: null, reach: null };
  if (!parkedTender(bot, geo, botId) || shepherdOf(bot, geo, botId)) return none;
  const cells = tendingCells(bot, geo);
  if (!cells) return { ...none, fault: 'no_tending_cells' };
  const m = {};
  const offHandBefore = offHand(bot)?.name || null;
  const guard = shooGuard(bot, geo, m, 'shepherd');
  const fault = await withCleanup(TAG, 'stop hitting animals away from the shepherd', () => shepherdPost(bot, geo, botId, cells.sweep, m, clock),
    () => timeoutCrash.stop(guard));
  await restoreOffHand(bot, offHandBefore);
  if (fault === 'post_held_by_a_peer') return none;
  return { held: true, fault, held_for: m.heldFor || null, reach: m.reach || null, sweep: m.sweep || null, off_cell: m.offCell || null, shooed: m.shooed || 0, foreign: m.foreign || null };
}

// herd: a string of animals from where they stand into the pen, as the tender of the pair (pen_gate):
//   out to the string's far end → back along the string, each animal tied on as the flock is led past it → the standby
//   cell (waited for while a peer tender holds it) → a shepherd holding → the gate claimed → the flock led to the lineup
//   cell → the gate opened from the outer cell → in along the axis to the deep cell → the flock in, the wheat put away → back to the inner cell, the gate shut.
// `string` is animal_finder.stringOf's ids, nearest first; `id` is the nearest. It ends inside the pen with the gate shut
// and its claim held, and the standby cell held; leavePen and the manager give both up.
async function herd(bot, id, geo, m, clock, botId, string) {
  // THE TENDING CELLS ARE READ AT THE PEN, BEFORE THE WALK OUT: an animal far out stands past the loaded chunks of the
  // pen's ground, where every stand there reads null.
  const cells = tendingCells(bot, geo);
  if (!cells) return 'no_tending_cells';
  m.park = cells.park;
  clock.to('out');
  sayPhase(geo, botId, 'bringer', 'en_route');
  // THE FAR END FIRST: the walk out goes to the last animal tied. One that cannot be reached or tempted is let go, and
  // the next one in becomes the end, down to the nearest, whose fault ends the herd.
  const tied = [...string];
  let lost = null;
  while (tied.length) {
    lost = await acquire(bot, tied[tied.length - 1], m, geo);
    if (!lost || tied.length === 1 || lost === 'no_wheat') break;
    watcher.warn(TAG, `string end ${tied[tied.length - 1]} let go (${lost}); ${tied.length - 1} left on the string`);
    tied.pop();
  }
  if (lost) return lost;
  // THE FLOCK so far: the animals tied on and tempted, the string's end first.
  const collected = [tied[tied.length - 1]];
  // regain: walk back to the nearest animal of the flock that fell out of tempt range and tempt it again → fault or
  // null. An animal that followed a peer's wheat into the pen is penned: the count is what the pen needs, not whose herd.
  const regain = async () => {
    const flockNow = collected.map(i => animalOf(bot, i)).filter(Boolean);
    if (flockNow.some(an => insidePen(geo, an.position))) return 'penned_by_a_peer';
    if (++m.reacquires > HERDING.max_reacquires) return 'animal_lost';
    const nearest = flockNow.sort((a, b) => flat(a.position, bot.entity.position) - flat(b.position, bot.entity.position))[0];
    if (!nearest) return 'animal_not_sensed';
    watcher.warn(TAG, `animal ${nearest.id} fell out of tempt range on leg ${m.legs}; walking back (reacquire ${m.reacquires}/${HERDING.max_reacquires}).`);
    return acquire(bot, nearest.id, m, geo);
  };
  // BACK ALONG THE STRING: the flock is led to each animal tied nearer home, until the herder stands within
  // HERDING.acquire_blocks of it with its wheat shown, and waits for it to come (awaitFollower, HERDING.tempt_wait_ms):
  // one that comes joins the flock, one that does not is left for a later herd. One gone or penned meanwhile is passed.
  clock.to('gather');
  for (let k = tied.length - 2; k >= 0; k--) {
    const a = animalOf(bot, tied[k]);
    if (!a || insidePen(geo, a.position)) continue;
    if (flat(bot.entity.position, a.position) > HERDING.acquire_blocks) {
      lost = await leadTo(bot, collected, feetOf(a.position), m, HERDING.acquire_blocks, regain);
      if (lost) return lost;
    }
    if (await awaitFollower(bot, tied[k], HERDING.tempt_wait_ms)) collected.push(tied[k]);
    else watcher.warn(TAG, `string animal ${tied[k]} did not come to the wheat; left for a later herd`);
  }
  m.gathered = collected.filter(i => { const a = animalOf(bot, i); return a && flat(a.position, bot.entity.position) <= HERDING.tempt_range; }).length;
  watcher.summary(TAG, `string gathered: ${m.gathered} of ${string.length} tied within tempt range (animals ${collected.join(',')})`);
  const party = () => [...new Set([...collected, ...animalsNear(bot, geo, geo.animal, bot.entity.position, HERDING.flock_blocks).map(e => e.id)])];

  // THE STANDBY CELL, ONE TENDER AT A TIME: claimed as the animal follows, so no peer tender takes the pen meanwhile. A
  // peer tender holding it is waited for with the wheat shown and the animal at heel. The shepherd is called when the
  // bringer comes within HERDING.call_shepherd_blocks of it (`near`), so a long lead keeps no shepherd standing.
  clock.to('lead');
  if (!(await tryPark(geo, botId))) {
    clock.to('standby_queue');
    const until = Date.now() + HERDING.gate_wait_ms;
    let held = false;
    while (!held && Date.now() < until) {
      await waitFor(() => !parkedTender(bot, geo, botId), HERDING.wait_say_ms);
      await showLure(bot, 'standby_queue');
      held = await tryPark(geo, botId);
      if (!held) watcher.summary('herd_wait', `wait for=standby_cell holder=${parkedTender(bot, geo, botId)?.id || '-'}`);
    }
    if (!held) return 'standby_held_by_a_peer';
    clock.to('lead');
  }
  m.parkHeld = true;
  let called = false;
  const callNear = () => {
    if (called || flat(bot.entity.position, centre(cells.park)) > HERDING.call_shepherd_blocks) return;
    called = true;
    sayPhase(geo, botId, 'bringer', 'near');
  };
  lost = await leadTo(bot, party(), cells.park, m, LEAD_ARRIVE, regain, callNear);
  if (lost) return lost;
  await standOn(bot, cells.park, m, 'standby');
  sayPhase(geo, botId, 'bringer', 'standby');
  watcher.summary(TAG, `standing by at (${cellText(feetOf(bot.entity.position))}) for the standby cell (${cellText(cells.park)}) with animal ${id}, waiting for a shepherd at (${cellText(cells.post)})`);
  clock.to('shepherd_wait');
  // While it waits, the bringer digs out every spike on the axis it can reach (pen_gate.clearAxis), so the flock's
  // way to the gate has no wall in it.
  m.axis = await clearAxis(bot, geo, HERDING.gate_approach_blocks, cells.park.k);
  if (!(await showLure(bot, 'standby'))) return 'no_wheat';
  m.shepherd = await awaitShepherd(bot, geo, botId, HERDING.gate_wait_ms, () => showLure(bot, 'shepherd_wait'));
  if (!m.shepherd) {
    watcher.warn(TAG, `no shepherd held the flock within ${HERDING.gate_wait_ms / 1000}s: ${shepherdSeen(bot, geo, botId)}`);
    return 'no_shepherd';
  }
  // ONE KIND TO A PEN: the herd's guard (shooGuard) hits an animal of another kind at heel; the bringer waits only
  // the one hit out for it to bolt (heelClear), then takes its flock on.
  await heelClear(bot, geo, m, 'standby');
  clock.to('gate_wait');
  m.gateHeld = await holdGate(bot, geo, () => showLure(bot, 'gate_wait'));
  if (!m.gateHeld) return 'gate_held_by_a_peer';
  sayPhase(geo, botId, 'bringer', 'crossing');

  // THE FLOCK: every animal at the bringer's heels as it leaves the standby cell. On the way in the herder does not
  // chase: the flock is the animals that follow it.
  clock.to('cross');
  const flock = party();
  m.flock = flock.length;
  watcher.summary(TAG, `crossing in from the standby cell with a flock of ${flock.length} (animals ${flock.join(',')}), ${m.shepherd} holding`);
  lost = await leadTo(bot, flock, geo.lineup, m, LEAD_ARRIVE, async () => 'flock_lost_on_the_way_in');
  if (lost) return lost;
  if (!(await stepInto(bot, geo.lineup))) return 'lineup_cell_blocked';
  if (!(await showLure(bot, 'cross_in'))) return 'no_wheat';
  if (!(await awaitFollower(bot, flock, HERDING.lag_wait_ms))) return 'flock_lost_at_gate';
  await heelClear(bot, geo, m, 'lineup');

  // THE GATE IS OPEN ONLY WHILE THE FLOCK COMES THROUGH: opened from the outer cell, the body walks in along the axis to
  // the deep cell and waits there for its flock inside (renewed while an animal still closes), puts the wheat away so the
  // flock turns to the shepherd's, steps back to the inner cell and shuts the gate from there, an animal still in the
  // doorway waited out first. No step back for an animal still outside: it wanders, and the next herd fetches it.
  if (!(await stepInto(bot, geo.outer))) return `pen_cell_blocked_at_${geo.outer.x}_${geo.outer.y}_${geo.outer.z}`;
  const gateFault = await setGates(bot, geo, true);
  if (gateFault) return gateFault;
  m.keepGate = true;   // from here the body holds the gate's claim: only leavePen, walking out under this hold, gives it up
  for (const cell of [geo.gate, geo.inner, geo.deep]) {
    if (!(await stepInto(bot, cell))) {
      await setGates(bot, geo, false);
      return `pen_cell_blocked_at_${cell.x}_${cell.y}_${cell.z}`;
    }
  }
  const outside = () => flock.map(fid => animalOf(bot, fid)).filter(a => a && !insidePen(geo, a.position));
  let left = Infinity;
  await waitFor(() => outside().length === 0, HERDING.lag_wait_ms, () => { const n = outside().length; const closing = n < left; left = n; return closing; });
  // ON TO THE BACK ROW: the shepherd holds the penned flock at the far fence, past tempt reach of the deep cell, so the
  // bringer carries its flock on to the far cell (pen.far, the row before the far fence) and the flock is at the
  // shepherd's wheat when its own goes away; dropped at the deep cell it would stand untempted by the doorway.
  if (geo.far && await stepInto(bot, geo.far)) await awaitFollower(bot, flock, HERDING.lag_wait_ms);

  // THE DROP-OFF: the wheat put away so the flock turns to the shepherd's, back to the inner cell, the gate shut.
  clock.to('drop');
  sayPhase(geo, botId, 'bringer', 'working');
  await hideLure(bot);
  if (!(await stepInto(bot, geo.inner))) {
    await setGates(bot, geo, false);
    return `pen_cell_blocked_at_${geo.inner.x}_${geo.inner.y}_${geo.inner.z}`;
  }
  // An animal standing in a gate cell is waited out (at most drop_hold_ms) before the gate shuts on it.
  const inDoorway = () => animalsNear(bot, geo, geo.animal, geo.gate, 3)
    .some(e => geo.gates.some(g => Math.floor(e.position.x) === g.x && Math.floor(e.position.z) === g.z));
  await waitFor(() => !inDoorway(), HERDING.drop_hold_ms);
  const shutFault = await setGates(bot, geo, false);
  if (shutFault) return shutFault;
  const flockNow = flock.map(fid => animalOf(bot, fid)).filter(Boolean);
  m.flockIn = flockNow.filter(a => insidePen(geo, a.position)).length;
  m.missed = flockNow.length - m.flockIn;
  const strays = HERDING.wheat_followers.filter(k => k !== geo.animal).flatMap(k => penned(bot, geo, k));
  m.foreignPenned = strays.length;
  if (strays.length) watcher.warn(TAG, `${strays.map(e => e.name).join('/')} inside the pen: one kind to a pen, and it came in with the flock`);
  m.penCount = penned(bot, geo, geo.animal).length;   // the whole pen as this body senses it at the drop-off
  watcher.summary(TAG, `dropped off: ${m.flockIn} of the flock of ${flock.length} in, ${m.missed} outside; pen holds ${m.penCount}; ${m.shepherd} holding`);
  if (m.flockIn === 0) return 'flock_did_not_enter';
  m.keepPark = true;
  return null;
}

// ── ANIMALS OF ANOTHER KIND ARE HIT AWAY THE WHOLE TIME A HERDER SHOWS ITS WHEAT ─────────────────────────────────────
// shooGuard(bot, geo, m, role) → a repeating timer (stop it with timeoutCrash.stop). Every HERDING.shoo_tick_ms, while
// the wheat is in the off-hand, each animal that follows wheat and is not the pen's kind (HERDING.wheat_followers),
// outside the pen and within tempt range is read: inside strike reach it is hit once, and again every
// HERDING.shoo_every_ms while it stays, since a hit animal flees and follows no wheat while it does; out of reach it
// is warned, once per HERDING.shoo_warn_ms for that animal, so a herd that keeps drawing one is seen. The herder never
// walks after it: the walk would drag the flock.
// THE HIT IS A BARE FIST. A shoo moves an animal on and never wounds it: a tool or weapon in the main hand (a stone
// axe kills a sheep in two hits) is put in the pocket first, and the swing waits for the next tick with the hand
// empty. A hand that will not empty is said, and nothing is struck.
function shooGuard(bot, geo, m, role) {
  const lastHit = new Map(), lastWarn = new Map();
  let emptying = false;
  const emptyHand = async () => {
    emptying = true;
    const held = bot.heldItem?.name;
    const r = await guardExternal(TAG, `empty the main hand (${held}) to shoo with a fist`, () => bot.unequip('hand'));
    if (!r.ok || bot.heldItem) watcher.warn(TAG, `the main hand still holds ${bot.heldItem?.name || held}: no shoo is struck with a tool or weapon`);
    else watcher.summary(TAG, `FIST: ${held} pocketed to shoo with a bare hand`);
    emptying = false;
  };
  const tick = () => {
    if (!bot.entity?.position || !holdsLure(bot) || emptying) return;
    const now = Date.now();
    for (const e of foreignNear(bot, geo, bot.entity.position, HERDING.tempt_range)) {
      const d = swingDistance(bot, e);
      if (d != null && d <= BOT_STRIKE_REACH) {
        if (now - (lastHit.get(e.id) || 0) < HERDING.shoo_every_ms) continue;
        if (bot.heldItem) { emptyHand(); return; }
        lastHit.set(e.id, now);
        if (swingNow(bot, e, TAG)) {
          m.shooed = (m.shooed || 0) + 1;
          m.foreign = [...new Set([...(m.foreign ? m.foreign.split('/') : []), e.name])].join('/');
        }
      } else if (now - (lastWarn.get(e.id) || 0) >= HERDING.shoo_warn_ms) {
        lastWarn.set(e.id, now);
        watcher.warn(TAG, `${e.name} ${e.id} follows the ${role}'s wheat out of strike reach`);
      }
    }
  };
  return timeoutCrash.every(TAG, `hit animals of another kind away from the ${role}'s wheat`, tick, HERDING.shoo_tick_ms);
}

// heelClear(bot, geo, m, where): before the gate, the wait for an animal of another kind at heel (within
// HERDING.flock_blocks) to bolt from the guard's hit, at most one hit's interval; the bringer goes on either way, with
// a warning when one is still there.
async function heelClear(bot, geo, m, where) {
  const atHeel = () => foreignNear(bot, geo, bot.entity.position, HERDING.flock_blocks);
  if (!atHeel().length) return;
  if (await waitFor(() => atHeel().length === 0, HERDING.shoo_every_ms + HERDING.shoo_tick_ms)) return;
  m.foreignAtHeel = atHeel().map(e => e.name).join('/');
  watcher.warn(TAG, `crossing with ${m.foreignAtHeel} still at heel at the ${where} cell after the hit`);
}

// hideLure: the wheat out of the off-hand into the pocket, so the flock turns to the shepherd's.
async function hideLure(bot) {
  if (!holdsLure(bot)) return;
  const r = await guardExternal(TAG, 'put the wheat away for the drop-off', () => bot.unequip('off-hand'));
  if (!r.ok || holdsLure(bot)) watcher.warn(TAG, 'the wheat did not leave the off-hand for the drop-off.');
  else lureLine(bot, 'away', 'drop_off');
}

const cellText = c => (c ? `${c.x},${c.y},${c.z}` : null);

// herdAnimal(bot, id, pen, clock, string) → { success, result, readable, metrics }: a string of animals (nearest first,
// `id` the nearest; animal_finder.stringOf) brought into the pen by the
// bringer (ending inside the pen on the inner cell, the gate shut), timed by step on `clock` (pen_gate.tendClock). The wheat goes back out
// of the off-hand (restoreOffHand) whatever the outcome. A bringer that took its flock in returns still holding the
// gate and the standby cell (metrics.gate_held, metrics.park_held); the manager's leavePen gives the gate up, and the
// standby cell after it. `metrics` carries the herd ledger's fields.
async function herdAnimal(bot, id, pen, clock, string = [id]) {
  if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: herdAnimal called with no live body.`);
  if (!Number.isInteger(id)) throw new Error(`[${TAG}] CODING VIOLATION: the animal must be an entity id. Got: ${JSON.stringify(id)}`);
  if (!clock || typeof clock.to !== 'function') throw new Error(`[${TAG}] CODING VIOLATION: herdAnimal needs the herd's clock (pen_gate.tendClock).`);
  if (!Array.isArray(string) || string[0] !== id || !string.every(Number.isInteger)) throw new Error(`[${TAG}] CODING VIOLATION: the string must be entity ids starting with the animal. Got: ${JSON.stringify(string)}`);
  const geo = penGeometry(pen);
  const botId = process.env.BOT_ID || 'default';
  const m = { legs: 0, reacquires: 0 };
  const metrics = () => ({
    legs: m.legs, reacquires: m.reacquires, gathered: m.gathered ?? null,
    flock: m.flock || 0, flock_in: m.flockIn || 0, missed: m.missed ?? null, pen_count: m.penCount ?? null,
    shepherd: m.shepherd || null, foreign: m.foreign || null, shooed: m.shooed || null, foreign_at_heel: m.foreignAtHeel || null, foreign_penned: m.foreignPenned ?? null,
    animal_at: m.animalAt || null, park: cellText(m.park), off_cell: m.offCell || null, stuck: !!m.stuck, killed: m.killed ?? null,
    axis_spikes: m.axis ? m.axis.spikes.join('/') || null : null, axis_dug: m.axis ? m.axis.dug : null,
    axis_out_of_reach: m.axis ? m.axis.out_of_reach : null,
    gate_held: !!(m.gateHeld && m.keepGate),   // the bringer still holds the gate: leavePen walks out under it
    park_held: !!(m.parkHeld && m.keepPark),   // and the standby cell, given up by the manager once it is out
  });
  const done = (success, result, readable) => {
    if (success) watcher.summary(TAG, readable); else watcher.warn(TAG, readable);
    return { success, result, readable, metrics: metrics() };
  };

  const first = animalOf(bot, id);
  if (first && insidePen(geo, first.position)) return done(true, 'already_penned', `${TAG}: animal ${id} already penned`);
  if (!carriesLure(bot)) return done(false, 'no_wheat', `${TAG}: fail no wheat to lead with`);
  if (first) m.animalAt = cellText(feetOf(first.position));

  const offHandBefore = offHand(bot)?.name || null;
  const guard = shooGuard(bot, geo, m, 'bringer');
  const fault = await withCleanup(TAG, 'give up the pen gate and the standby cell after the herd', () => herd(bot, id, geo, m, clock, botId, string), () => {
    timeoutCrash.stop(guard);
    if (m.gateHeld && !m.keepGate) releaseGate(geo);
    if (m.parkHeld && !m.keepPark && !m.keepGate) { releasePark(geo, botId); m.parkHeld = false; }
  });
  // A fault after the gate opened leaves the body inside or at an open gate: leavePen walks it out and shuts the gate,
  // and the standby cell is given up after it, as on success.
  if (fault && m.keepGate) m.keepPark = true;
  await restoreOffHand(bot, offHandBefore);
  const end = bot.entity.position.floored();
  if (fault === 'penned_by_a_peer') {
    return done(true, fault, `${TAG}: animal ${id} followed a peer into the pen (legs=${m.legs}); herder outside at ${end.x},${end.y},${end.z}`);
  }
  if (fault) {
    const survey = faultSurvey(bot, id, m);
    // STUCK: the animal stands in the cell it was found in after every reacquire — wedged, not wandering. The manager
    // skips it as unreached, so the next herd picks another.
    m.stuck = fault === 'animal_lost' && !!survey.animal_now && survey.animal_now === m.animalAt;
    watcher.summary('herd_fault', `fault ${kvLine({ fault, animal: id, legs: m.legs, reacquires: m.reacquires, animal_at: m.animalAt || null, stuck: m.stuck, ...survey })}`);
    // AN ANIMAL THAT WILL NOT BE LED IS KILLED: after HERDING.max_reacquires walks back to it, the herder strikes it
    // with its best weapon where it stands (cull_executor.cullOne, free range) and picks up what it drops, so no herd
    // after this one is spent on the same animal.
    if (fault === 'animal_lost') m.killed = await killUnled(bot, geo, id);
    return done(false, fault, `${TAG}: fail ${fault} (animal ${id}, legs=${m.legs}, reacquires=${m.reacquires}${m.killed == null ? '' : `, killed=${m.killed}`}, herder at ${end.x},${end.y},${end.z})`);
  }
  return done(true, 'penned', `${TAG}: dropped off a flock of ${m.flockIn}/${m.flock} with animal ${id} (legs=${m.legs}, reacquires=${m.reacquires}); herder inside the pen at ${end.x},${end.y},${end.z}`);
}

// killUnled(bot, geo, id) → true once the animal is gone: struck where it stands with the body's best weapon
// (combat_utils.equipBestWeapon, the culler's strike), its drops picked up. Null when it is no longer sensed or already
// penned (nothing to kill). One HERD_KILL line.
async function killUnled(bot, geo, id) {
  const a = animalOf(bot, id);
  if (!a || insidePen(geo, a.position)) return null;
  const at = cellText(feetOf(a.position));
  const choice = await require('@utils/combat_utils').equipBestWeapon(bot);
  const killed = await require('@action/cull_executor').cullOne(bot, geo, id, choice, { freeRange: true });
  if (killed) await require('@api/drop_collector').collectNearby(bot);
  watcher.summary('herd_kill', `kill ${kvLine({ animal: id, kind: geo.animal, at, killed, weapon: choice.item ? choice.item.name : 'fist' })}`);
  return killed;
}

// feed(bot, animal) → true once the wheat in hand is taken: a feed the server accepts spends the wheat, an interaction
// it drops spends nothing. An untaken feed is tried once more.
async function feed(bot, animal) {
  const wheatHeld = () => bot.inventory.items().filter(it => it.name === LURE).reduce((n, it) => n + it.count, 0);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = wheatHeld();
    const r = await guardExternal(TAG, `feed ${animal.name} ${animal.id}`, () => bot.activateEntity(animal));
    if (r.ok && await waitFor(() => wheatHeld() < before, HERDING.feed_take_ms)) return true;
    watcher.warn(TAG, `feed ${animal.name} ${animal.id} attempt=${attempt} wheat_taken=false`);
  }
  return false;
}

// BREEDING ON THE CLOCK. breedRound(bot, pen, pairs): the pen's animals fed from outside the fence on the shepherd's
// long side, two wheat a pair, up to `pairs` pairs (assessors/ranching sizes it to the pen's room). The body holds the
// shepherd post while it feeds (pen_gate.tryShepherd), so no tender crosses with a second body's wheat shown; with a
// tender or shepherd already at the pen it breeds nothing. Nothing is asked of the server first: the round runs on the
// game's breeding cooldown (HERDING.breed_every_ms), so the grown stock is ready. With the wheat in the main hand the
// penned flock comes to the fence; the nearest penned animal not yet fed within HERDING.feed_reach is fed, the body
// stepping along its side level with the nearest unfed one when none is in reach (shepherdCellToward), until every
// feed is spent, the wheat is gone, or no unfed animal comes within HERDING.feed_wait_ms; the animals that side never
// reached are then fed from the far long side, the wheat put away for the walk round (pen_gate.tendingCells far).
// A feed the server refuses
// (an animal still on its cooldown) spends no wheat. Afterwards the server is asked once what the round did: the
// animals in love or newly bred (Age above 0) are the round's tally.
// → { result, penned, fed, refused, in_love, seconds }
async function breedRound(bot, pen, pairs, pairsBy = null) {
  const geo = penGeometry(pen);
  const botId = process.env.BOT_ID || 'default';
  const started = Date.now();
  const out = { result: null, penned: 0, fed: 0, refused: 0, in_love: null, seconds: 0 };
  const done = result => ({ ...out, result, seconds: Math.round((Date.now() - started) / 1000) });
  if (parkedTender(bot, geo, botId) || shepherdOf(bot, geo, botId)) return done('tending_at_the_pen');
  const cells = tendingCells(bot, geo);
  if (!cells) return done('no_tending_cells');
  if (!(await tryShepherd(geo, botId))) return done('post_held_by_a_peer');
  return withCleanup(TAG, 'give up the shepherd post after breeding', async () => {
    const nav = await locomotion.goTo({ x: cells.post.x, y: cells.post.y, z: cells.post.z, spare_builds: true, leg: 'work' });
    if (!nav || nav.arrived === false) return done('route_to_post_failed');
    await stepInto(bot, cells.post);
    out.penned = penned(bot, geo, geo.animal).length;
    // THE PEN READ FIRST: which penned animals are grown and ready, cooling, or young (HERDING breed_lead_ms). The
    // breeder waits at the fence for every cooling animal that comes ready within breed_ready_wait_ms (the last of
    // them), so they breed in this round instead of the next. With no answer from the server every penned animal is
    // offered, as before the read.
    const waitStart = Date.now();
    let census = await readBreeders(bot, geo);
    if (census && census.lastReadyMs !== null) {
      await sleep(census.lastReadyMs + 1000);
      census = await readBreeders(bot, geo);
    }
    out.waited_s = Math.round((Date.now() - waitStart) / 1000);
    const readyIds = census ? new Set(census.ready.map(a => a.entity.id)) : null;
    out.census = census;
    // Fed in pairs: an odd ready animal is left for the next round rather than fed alone.
    const feeds = Math.min(2 * pairs, readyIds ? readyIds.size - (readyIds.size % 2) : 2 * pairs);
    out.feeds_planned = feeds;
    const tried = new Set();
    const fedIds = [];
    let stop = feeds === 0 ? 'none_ready' : 'all_planned_fed';
    // ONE SIDE, THEN THE OTHER. The flock crowds the fence the wheat is shown at, so the ready animals behind it, up to
    // the pen's width from that fence, may never come within feed_reach. The ones the first side passed over are fed from
    // the far long side's stand: the wheat is put away before the walk round, so the crowd is not drawn along the inside
    // of the fence after the body, and shown again there. Fed per side and unreached per side are the ledger's.
    const sides = [{ name: 'a', post: cells.post }, ...(cells.far ? [{ name: 'b', post: cells.far }] : [])];
    out.sides = sides.length;
    for (const side of sides) {
      if (out.fed >= feeds) break;
      if (side.name === 'b') {
        if (!out.unreached_a) break;
        await guardExternal(TAG, 'put the wheat away before walking round the pen', () => bot.unequip('hand'));
        const nav = await locomotion.goTo({ x: side.post.x, y: side.post.y, z: side.post.z, spare_builds: true, leg: 'work' });
        if (!nav || nav.arrived === false) { out.side_b = 'route_failed'; break; }
        await stepInto(bot, side.post);
        out.side_b = 'fed_from';
      }
      const fault = await feedSide(side);
      if (fault) { stop = fault; return finish(fault); }
    }
    if (out.fed < feeds && stop === 'all_planned_fed') stop = unreachedLeft() ? 'ready_never_came_to_the_fence' : 'ready_not_seen';
    return finish(out.fed ? 'fed' : 'none_fed');

    // feedSide(side) → null, or why the round stops ('no_wheat' / 'wheat_not_in_hand'): the nearest ready animal not yet
    // tried within feed_reach is fed, the body stepping along this side level with the nearest one when none is in
    // reach; one that does not come within feed_reach after that walk is passed over for this side. The side is done
    // when every planned feed is spent or no ready animal is left untried on it.
    async function feedSide(side) {
      const passed = new Set();
      out['fed_' + side.name] = 0; out['unreached_' + side.name] = 0;
      while (out.fed < feeds) {
        const wheat = bot.inventory.items().find(it => it.name === LURE);
        if (!wheat) return 'no_wheat';
        const held = await guardExternal(TAG, 'take wheat in hand to feed', () => bot.equip(wheat, 'hand'));
        if (!held.ok) return 'wheat_not_in_hand';
        if (out.fed === 0 && tried.size === 0 && passed.size === 0) lureLine(bot, 'in_hand', 'breed_feed');
        const unfed = () => penned(bot, geo, geo.animal).filter(e => !tried.has(e.id) && !passed.has(e.id) && (!readyIds || readyIds.has(e.id)))
          .sort((x, y) => flat(x.position, bot.entity.position) - flat(y.position, bot.entity.position));
        const inReach = () => unfed().find(e => flat(e.position, bot.entity.position) <= HERDING.feed_reach) || null;
        let next = null;
        if (!inReach()) {
          next = unfed()[0];
          if (!next) return null;
          const cell = shepherdCellToward(bot, geo, side.post, next.position);
          if (cell) { await locomotion.goTo({ x: cell.x, y: cell.y, z: cell.z, spare_builds: true, leg: 'work' }); await stepInto(bot, cell); }
          await waitFor(() => !!inReach(), HERDING.feed_wait_ms);
        }
        const e = inReach();
        if (!e) { passed.add(next.id); out['unreached_' + side.name]++; continue; }
        tried.add(e.id);
        if (await feed(bot, e)) { if (!out.fed) out.first_fed_at = Date.now(); out.fed++; out['fed_' + side.name]++; fedIds.push(e); } else out.refused++;
      }
      return null;
    }

    // The ready animals no side reached: the last side fed from's passed-over count.
    function unreachedLeft() { return out['unreached_' + (out.side_b === 'fed_from' ? 'b' : 'a')] || 0; }

    async function finish(result) {
      out.unreached = unreachedLeft();
      const after = fedIds.length ? await askBreeding(fedIds) : [];
      out.in_love = after === null ? null : after.filter(a => a.in_love > 0 || a.age > 0).length;
      roundLine(geo, pairs, out, stop, pairsBy);
      return done(result);
    }
  }, () => releaseShepherd(geo, botId));
}

// readBreeders(bot, geo) → { grown, young, ready, cooling, inLove, nextReadyMs, lastReadyMs } of the penned animals by the server's Age
// and InLove, or null with no answer. Age 0 is grown; above 0 a grown animal's ticks until it can breed again; below 0 a
// young one's ticks until grown. InLove above 0 is an animal already fed and waiting for its mate.
async function readBreeders(bot, geo) {
  const rows = await askBreeding(penned(bot, geo, geo.animal));
  if (rows === null) return null;
  const grown = rows.filter(a => a.age >= 0);
  const cooling = grown.filter(a => a.age > 0);
  return {
    asked: rows.length, grown: grown.length, young: rows.length - grown.length, cooling: cooling.length,
    inLove: rows.filter(a => a.in_love > 0).length,
    ready: grown.filter(a => a.age === 0 && !(a.in_love > 0)),
    nextReadyMs: cooling.length ? Math.min(...cooling.map(a => a.age)) * 50 : null,
    // The longest wait that brings every cooling animal ready within breed_ready_wait_ms; null with none that close.
    lastReadyMs: (() => {
      const soon = cooling.map(a => a.age * 50).filter(ms => ms <= HERDING.breed_ready_wait_ms);
      return soon.length ? Math.max(...soon) : null;
    })(),
  };
}
// THE BREED ROUND'S LEDGER LINE, one per round: the pen as the server read it, the pairs it could make (ready / 2), what
// was asked and fed (and which of half the pen, its room or the wheat set the ask: asked_by), the animals in love after,
// the calves that makes (in love / 2), and why any ready animal was left.
// The keeper's PEN_ENTERED lines with the gate shut are the calves born; monitoring/herding_lens joins the two.
function roundLine(geo, pairs, out, stop, pairsBy) {
  const c = out.census;
  const possible = c ? Math.floor(c.ready.length / 2) : null;
  watcher.summary('breed_round', `round ${kvLine({
    pen: geo.structure, penned: out.penned, asked: c ? c.asked : null, grown: c ? c.grown : null, young: c ? c.young : null,
    ready: c ? c.ready.length : null, cooling: c ? c.cooling : null, in_love_before: c ? c.inLove : null,
    next_ready_s: c && c.nextReadyMs !== null ? Math.round(c.nextReadyMs / 1000) : null, waited_s: out.waited_s,
    pairs_possible: possible, pairs_asked: pairs, cap_half: pairsBy ? pairsBy.half : null, cap_room: pairsBy ? pairsBy.room : null,
    cap_wheat: pairsBy ? pairsBy.wheat : null,
    asked_by: pairsBy ? (['wheat', 'room', 'half'].find(k => pairsBy[k] === pairs) || 'wheat_held') : null, feeds_planned: out.feeds_planned, fed: out.fed, refused: out.refused,
    ready_left: c ? c.ready.length - out.fed : null, sides: out.sides ?? null, fed_a: out.fed_a ?? null, unreached_a: out.unreached_a ?? null,
    side_b: out.side_b || null, fed_b: out.fed_b ?? null, unreached: out.unreached || 0, in_love_after: out.in_love,
    calves_expected: out.in_love === null ? null : Math.floor(out.in_love / 2), stop,
  })}`);
}

module.exports = { herdAnimal, shepherdFor, breedRound, kvLine, standOn };
