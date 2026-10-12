// module: commander — the tank crew's COMMANDER, the fleet's ONLY monster scanner; every monster fact
// any seat acts on comes off the board this file writes (Law 16, Law 1). start/stop attach/detach a
// physicsTick handler; one synchronous sweep per tick, never awaits; holds the `crew_board` pen for the
// process. Aggro: struck/swelling admits everything in strike reach; beyond it only
// SIGHT_AGGRO_NAMES species are confirmed by raycast, held with no decay.

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

// Claims this module's crew_board pen at require time, so a second claimant throws immediately (Law 13).
const writeBoard = crewBoard.claimPen('commander');

// ── SECTION 1: Constants ──

// ── THE MODEL IS REACTIVE ───────────────────────────────────────────────────────────────────────────
// A fight opens only on evidence the body was struck or a creeper is swelling; proximity alone aggros
// nothing, so a wall between the bot and a mob does the reasoning for free.
const STRIKE_REACH = 2.9;  // how close a mob must be to join a fight once the reactive door is open

const REACTIVE_WINDOW_MS = 3000;  // ms the reactive door stays open after the last hit; re-arms per hit

// ── THE ONE PROACTIVE EXEMPTION ─────────────────────────────────────────────────────────────────────
// Species that can damage the body from outside strike reach, admitted on a raycast: seeing the body to
// shoot it is the same sightline that makes it engageable. Others are covered by attribution (`striker`).
const SIGHT_AGGRO_NAMES = new Set(['skeleton', 'stray', 'bogged']);

const AGGRO_RECHECK_MS = 500;  // re-cast interval for a hostile failing the line test, bounds cast budget

// ── SECTION 2: State ──
let attached = false;
let tickHandler = null;

let confirmed = new Set();  // raycast-confirmed aggro ids, pruned to ids seen this sweep (Law 8)
let castAt = new Map();     // last cast time per unconfirmed id, pruned the same way

let homeCenter = null;  // headframe centre on a slow clock, re-read at most every HOME_REREAD_MS
let homeReadAt = 0;
const HOME_REREAD_MS = 5000;

// ── EVENTS — kept only if a reader acts differently on it. aggro = opening fact (`via` names the door);
// lost = closes the lifecycle (Law 8); closest = nearest ACTIVE mob changed (what the world did, not
// battle_stations' `Target N`); swell/notch = on/off, since both are durations.
let stats = null;
function _blankStats() {
  return {
    sweeps: 0,   // ticks this process ran, the denominator for the counts below
    casts: 0,    // raycasts paid, including failed ones that produced no event
    // seenOutOfRange = envelope question (refused on distance); inRangeUnseen = terrain question (blocked).
    seenOutOfRange: 0,
    inRangeUnseen: 0,
    // drawUnread = decode FAILED (no metadata/registry/key); drawQuiet = decode succeeded, field unsent.
    drawUnread: 0,
    drawQuiet: 0,
    notchTicks: 0,   // sweeps that saw at least one aggroed hostile drawing a bow
  };
}

// ── ANNOUNCED STATE — one entry per fact currently true, so a sweep tells "still true" from "just
// became true" (Invariant B). Threat holders are maps id → name, latched on the on-edge.
let announced = _blankAnnounced();
function _blankAnnounced() {
  // `bearing`: id → last announced compass bucket, so only a change posts. Pruned with the sweep (Law 8).
  return { active: new Map(), closest: null, focus: null, swelling: new Map(), notching: new Map(), bearing: new Map() };
}

// ── SECTION 3: The sweep ──

function _home(now) {
  if (now - homeReadAt < HOME_REREAD_MS) return homeCenter;
  homeReadAt = now;
  // Unguarded (Law 13); `homeBlueprint()` names this crew's own home chair, not a fixed literal.
  const site = hq.readBuildingChair(require('@kernel/bot_mandate').homeBlueprint(), 'set_buildspot');
  homeCenter = (site && site.transpose_origin) || null;
  return homeCenter;
}

// aggroVerdict → { aggroed, blockedBy, cast }. Gates cheapest-first: contact radius, species cylinder,
// then raycast (Law 16 — `withinAggroRange`, same cylinder predicate as architect_config).
const SIGHT_CAST_RANGE = 32;  // confirming-raycast horizon, independent of the aggro cylinder

// aggroVerdict → { aggroed, seen, inRange, blockedBy, cast }. `seen`/`inRange` are independent, always
// produced when a cast runs; engagement is their conjunction (Law 6). `seen` is null, never false, on a
// throttled sweep (Law 25); `reaction` is the sweep-level trigger, computed once and passed in.
function aggroVerdict(bot, entity, name, distance, self, now, reaction) {
  if (confirmed.has(entity.id)) return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'held' };

  // ── THE ATTRIBUTED STRIKER — admitted at any distance ─────────────────────────────────────────
  // The measured source of a blow already landed — the case a radius-scoped reaction cannot answer.
  if (reaction.struckById != null && entity.id === reaction.struckById) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'striker' };
  }

  const withinReach = distance <= STRIKE_REACH;

  // ── THE REACTIVE DOOR ─────────────────────────────────────────────────────────────────────────
  // Struck or swelling arms it; anything within strike reach is then admitted as a threat.
  if (reaction.armed && withinReach) {
    confirmed.add(entity.id);
    return { aggroed: true, seen: true, inRange: true, blockedBy: null, cast: false, via: 'reaction' };
  }

  // ── THE SIGHT DOOR — archers only (see SIGHT_AGGRO_NAMES) ─────────────────────────────────────
  // Every other species falls through to a decline regardless of distance or visibility.
  if (!SIGHT_AGGRO_NAMES.has(name)) {
    // Fields match a cast's shape minus the cast: `seen: null` since nothing was measured (Law 25).
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
  // Read immediately after the cast, only when one happened (see lastSightlineBlock's header).
  return { aggroed: false, seen, inRange, blockedBy: seen ? null : lastSightlineBlock(), cast: true, via: null };
}

// announce — the diff between what is true and what has been said. Runs after the sort (`closest`
// needs `active` ordered); a distance rides on `aggro` only, taken when the fight opened (Law 25).
function announce(active, swelling, notching, focus, focusWhy) {
  const seen = new Set();
  for (const h of active) {
    seen.add(h.id);
    if (announced.active.has(h.id)) continue;
    announced.active.set(h.id, h.name);
    crewLog.event(TAG, 'aggro', {
      subject: `${h.name}#${h.id}`,
      d: h.distance.toFixed(1),
      via: h.via,       // which door this mob came through: striker/reaction/sight/held (Law 6)
      dir: h.bearing,   // side the mob is on, carried on the opening row too (see bearingOf)
    });
  }
  for (const [id, name] of announced.active) {
    if (seen.has(id)) continue;
    announced.active.delete(id);
    // Cause of departure is not this seat's to say (Law 25); the lens joins the strike stream.
    crewLog.event(TAG, 'lost', { subject: `${name}#${id}` });
  }

  const closest = active.length ? active[0] : null;
  const closestKey = closest ? closest.id : null;
  if (closestKey !== announced.closest) {
    announced.closest = closestKey;
    if (closest) crewLog.event(TAG, 'closest', { subject: `${closest.name}#${closest.id}`, d: closest.distance.toFixed(1) });
  }

  // The commitment, announced on change: driver drives on it, gunner faces/strikes it (`why`: archer/closest).
  const focusKey = focus ? focus.id : null;
  if (focusKey !== announced.focus) {
    announced.focus = focusKey;
    if (focus) {
      crewLog.event(TAG, 'focus', {
        subject: `${focus.name}#${focus.id}`, d: focus.distance.toFixed(1), why: focusWhy,
      });
    }
  }

  // ── BEARING EDGE — cardinal direction per entity, announced on change only (signals orbiting/circling).
  const seenBearing = new Set();
  for (const h of active) {
    seenBearing.add(h.id);
    if (announced.bearing.get(h.id) === h.bearing) continue;
    announced.bearing.set(h.id, h.bearing);
    crewLog.event(TAG, 'bearing', { subject: `${h.name}#${h.id}`, dir: h.bearing, d: h.distance.toFixed(1) });
  }
  for (const id of announced.bearing.keys()) if (!seenBearing.has(id)) announced.bearing.delete(id);

  // Threat edges are on/off, not "happening" lines: every question about them is a duration (two ends).
  announceEdges('swell', swelling, active, announced.swelling);
  announceEdges('notch', notching, active, announced.notching);
}

function announceEdges(verb, ids, active, held) {
  for (const id of ids) {
    if (held.has(id)) continue;
    const h = active.find((a) => a.id === id);
    // A threat id absent from `active` cannot happen (Law 13).
    if (!h) throw new Error(`[commander] CODING VIOLATION: ${verb} on entity ${id}, which is not in this sweep's active list.`);
    held.set(id, h.name);
    crewLog.event(TAG, verb, { subject: `${h.name}#${id}`, state: 'on' });
  }
  for (const [id, name] of Array.from(held)) {
    if (ids.includes(id)) continue;
    held.delete(id);
    // Name from the latch, not `active`: on the death sweep the body is already out of the entity table.
    crewLog.event(TAG, verb, { subject: `${name}#${id}`, state: 'off' });
  }
}

// ── FOCUS — what is worth swinging at, given it is safe to swing. Defence is unconditional; this
// answers only the NEAREST UNTHREATENING body, never the mob the feet retreat from; all-threatening
// resolves to null (Law 25). Species is a consequence of the threat signal (Law 17 creeper override).
function chooseFocus(active, threatenedIds) {
  if (!active.length) { focusId = null; return { focus: null, why: null }; }
  // Held until the body leaves the world: a choice re-made every tick oscillates with draw state.
  // Release is the mob leaving the entity table, a fact, not a threshold.
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

// ── POST-MORTEM FROM THIS SEAT — tracks who had notched or swelled before death, pricing the
// third-party witness client. Cause of death off metadata is a SUSPICION — field `suspect`, never
// `killer` (Law 25). `lastThreat` is a rolling latch since the death-tick entity table is tearing down
// (Invariant B); focusId is cleared in start()/stop() since entity ids recycle.
let focusId = null;

let lastThreat = new Map();     // id → { name, why, at } — the last tick this mob was drawing or swelling
let peakActive = 0;             // most hostiles active at once since the last death, for "how many"
let deathHandler = null;

// A death is a perception event: subscribes to the bot's own 'death' emit (Law 1).
function onDeath() {
  const now = Date.now();
  const SUSPECT_WINDOW_MS = 1000;  // a bow draw is ~1000 ms; anything off the string longer is no candidate
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

// ── Compass bucket per entity, world-axis not bot-facing (yaw changes independent of the mob); eight
// buckets not degrees (Law 16). +X = EAST, +Z = SOUTH, so atan2(dx, -dz) puts 0 at north, clockwise.
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearingOf(self, pos) {
  const dx = pos.x - self.x;
  const dz = pos.z - self.z;
  if (dx === 0 && dz === 0) return null;  // exactly on the bot has no direction; never fabricate one (Law 13)
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
  // The reactive trigger is a fact about the whole sweep, so every mob is decoded before any verdict.
  const scanned = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue;
    if (e.isValid === false) continue;
    if (!threatScanner.isHostile(e)) continue;

    seenIds.add(e.id);
    tracked++;
    const name = threatScanner.hostileName(e);
    const distance = self.distanceTo(e.position);

    // Read for every hostile, unfiltered by species: fuse_meter owns the decode (Law 16).
    const isSwelling = swellDir(bot, e) === UP;

    // Notch likewise species-free: bit 0 of `living_entity_flags` is "using an item". Only 'drawing' is
    // positive evidence; both empty answers fall through to "not notching".
    const draw = bowDrawState(bot, e);
    const isNotching = draw === 'drawing';
    if (draw === 'unreadable') stats.drawUnread++;
    else if (draw === 'quiet') stats.drawQuiet++;

    scanned.push({ e, name, distance, isSwelling, isNotching });
  }

  // ── THE TRIGGER, computed once ────────────────────────────────────────────────────────────────
  // Lazy-required to avoid a require cycle with battle_stations, which reads this seat's board.
  const struck = require('@api/battle_stations').struckWithin(REACTIVE_WINDOW_MS);
  const anySwelling = scanned.some((s) => s.isSwelling);  // arms the door for every mob in reach
  const reaction = {
    armed: !!struck || anySwelling,
    struckById: struck && struck.byId != null ? struck.byId : null,  // null, not undefined: a real "no source" answer (Law 13)
  };

  for (const { e, name, distance, isSwelling, isNotching } of scanned) {
    const verdict = aggroVerdict(bot, e, name, distance, self, now, reaction);
    if (verdict.cast) stats.casts++;
    // Both answers carried: seen-but-out-of-range is envelope, in-range-but-unseen is terrain (Law 6).
    if (verdict.cast) {
      if (verdict.seen && !verdict.inRange) stats.seenOutOfRange++;
      else if (!verdict.seen && verdict.inRange) stats.inRangeUnseen++;
    }

    // Aggroed mobs only: a non-aggroed hostile drawing far away must not reach announceEdges' Law 13
    // throw; gated here since consumers already intersect with `active`.
    if (verdict.aggroed && isSwelling) swelling.push(e.id);
    if (verdict.aggroed && isNotching) notching.push(e.id);

    const inBase = center ? Math.hypot(e.position.x - center.x, e.position.z - center.z) <= HEADFRAME_SAFE_RADIUS : false;

    // Shape matches threat_scanner.scanThreats' fields plus `swelling`, unchanged so consumers need no edit (Law 16).
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

  // Sorted here, once, not per reader: entity iteration order is not distance order (Law 16).
  hostiles.sort((a, b) => a.distance - b.distance);
  active.sort((a, b) => a.distance - b.distance);

  // Engagement verdict: both regimes require real aggro; in-base outranks field for priority only.
  let engage = null, engageReason = null;
  const inBaseFirst = active.find((h) => h.inBase);
  if (inBaseFirst) { engage = inBaseFirst; engageReason = 'in_base_seek'; }
  else if (active.length) { engage = active[0]; engageReason = 'aggro'; }

  // After the sort, before the announce, so board and record never disagree (Law 6). Threat set built
  // here, not re-derived in chooseFocus (Law 16).
  const threatenedIds = new Set([...swelling, ...notching]);
  const { focus, why: focusWhy } = chooseFocus(active, threatenedIds);

  // Post-mortem latches stamped here — the one place both facts are in hand.
  for (const h of active) {
    if (!threatenedIds.has(h.id)) continue;
    lastThreat.set(h.id, { name: h.name, why: swelling.includes(h.id) ? 'swell' : 'notch', at: now });
  }
  if (active.length > peakActive) peakActive = active.length;

  stats.sweeps++;
  if (notching.length) stats.notchTicks++;
  announce(active, swelling, notching, focus, focusWhy);

  writeBoard({
    sweptAt: now,
    hostiles,
    active,
    tracked,
    closest: active.length ? active[0] : null,  // nearest active mob, the field the gunner faces (Law 25)
    focus,  // the one the crew is killing; closest is the one the world put nearest — they often disagree
    nearest: hostiles.length ? hostiles[0] : null,
    engage,
    engageReason,
    swelling,
    notching,
  });
}

// ── SECTION 4: Lifecycle ──

// Attached for the process (Law 8): sweeps whether or not a fight is open, so it never starves the gunner.
function start(bot) {
  if (attached) return;
  stats = _blankStats();
  // Cleared with the rest: a fresh process re-announces every still-true fact (Law 8, not on `report`).
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
  (bot || global.bot).removeListener('physicsTick', tickHandler);  // EventEmitter bookkeeping, cannot fail (Law 13)
  // Both listeners off: a raised lifecycle terminates with its owner (Law 8).
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
// this is the residue of ticks that produced no event.
function report() {
  if (!stats || !stats.sweeps) return;
  const s = stats;
  // Both always printed: seen-but-out-of-range is the envelope population, in-range-unseen is terrain.
  watcher.summary(TAG, `Commander: ${s.sweeps} sweep(s), ${s.casts} raycast(s) paid — ` +
    `${s.seenOutOfRange} mob(s) SEEN but outside the aggro cylinder (envelope question), ` +
    `${s.inRangeUnseen} inside it but with no sightline (terrain question).`);
  // Said out loud, not inferred from a shield that never rises: a moved index reads as calm (Law 25).
  if (s.drawUnread > 0) {
    watcher.warn(TAG,
      `${s.drawUnread} pass(es) could not DECODE living_entity_flags on a hostile — no metadata array, no ` +
      `registry entry, or no such key. That is the notched-arrow signal the shield runs on, and a failed ` +
      `decode is NOT a skeleton that was not drawing. Beside ${s.notchTicks} notched sweep(s), suspect the ` +
      `metadata index rather than the fight.`);
  }
  // Reset here and nowhere else — this seat has no engage/disengage boundary.
  stats = _blankStats();
}

function state() {
  return { attached, confirmed: confirmed.size, board: crewBoard.readCommander(), stats: stats ? { ...stats } : null };
}

module.exports = { start, stop, report, state, STRIKE_REACH, REACTIVE_WINDOW_MS, AGGRO_RECHECK_MS };
