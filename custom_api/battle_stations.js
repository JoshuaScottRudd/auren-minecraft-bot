'use strict';

// fragment: battle_stations — inline emergency hook every executor and the navigator move loop
// `await` at loop boundaries (Law 15 API). Live job: the COMBAT gate (engageThreat). Also owns
// escapeWaterToLand — NOT a gate on this hook; performDig is its only caller.
//
// FOUR STAGES OF AN ENGAGEMENT — raycast only confirms aggro; once aggro is confirmed the rest is
// arithmetic:
//   1. TARGET_CONFIRMED — threat_scanner, the ONLY raycast in the pipeline (species aggro radius +
//      clear line), answered once per mob, never re-asked.
//   2. TARGET_ENGAGED — targetEngaged(): the engagement queue, ordered by live distance, closest
//      fought first, switching mid-fight.
//   3. TARGET_COMBAT — pure arithmetic on the live entity's position (distance/reach/band/charge),
//      no sightline.
//   4. TARGET_CLEARED — per target, then the wave; outcome returned to the sentry watch, every
//      other caller abandoned to the judge (Law 15).
//
// WHY 1 AND 3 ARE SPLIT (wrong turn): they were one call — the loop re-ran the FULL scan every
// pass, so range-plus-raycast silently re-gated every swing. A mob held inside striking range could
// take repeated damage with `engage: null` every pass because the sightline failed MORE as the mob
// closed, invisible in trace ("no threat found" and "no threat present" log the same). The raycast
// is a QUALIFIER — decides whether a fight starts, never whether a swing lands; mineflayer attacks
// through a wall as it places through one.
//
// DELIBERATELY ABSENT: a `target_search` stage (no route → replan/hop) — a pursuit planner with no
// caller; no arm wanted it.
//
// Inherited from the first combat prototype (code gone): decouple plan cadence from movement
// cadence; eyes on the enemy while the legs move; band constants per mob group; bound every
// search; every "no route" gets an explicit next state, never a retry loop.

const watcher = require('@kernel/watcher');
const Vec3 = require('vec3');
const { sleep } = require('@utils/fragment_utils');
const { routeToJudge } = require('@utils/signal_utils');
const { canLandStrike } = require('@utils/movement/combat_movement');
const { clearMotion } = require('@utils/movement/motion_primitives');
const combatUtils = require('@utils/combat_utils');
// Owns the PASS (the line boundary the three seats' events group by), so owns the flush — AND since
// 2026-08-22 it is an emitter too: the lifecycle beats that used to be machine rows in a sidecar file
// (engage / end / wave / death / blast) are posted here, on the bot's own trace, through `post` rather
// than `event` because a lifecycle beat has no pass to be grouped into.
const crewLog = require('@api/crew_log');
// ── ARMS GONE; THE SEATS REPLACED THEM — one tactic now, Law 16 governs the rest.
// hold/rush/counter_primitives/combat_navigator/band_keeper were per-species arms each owning the
// whole body for one mob's fight — deleted, not merged (two tactics = the same rule written
// twice). This file keeps only what an arm never owned: the wave, the queue, the record. NO combat
// CALCULATOR imports here: fuse arithmetic, repel band, archer calculator belong in driver/gunner —
// re-adding one leaks a tactical decision back into the lifecycle seat.
// PORTABLE JUDGE stays for the one wave-lifecycle judgment no arm could make — three consecutive
// waves retiring the same mob alive — now its only caller (Law 16, arrived at by deletion).
const portableJudge = require('@kernel/portable_judge');
const driver = require('@api/driver');

// Creeper's own fuse, read off `swell_dir` rather than modelled from the 3.0b crossing.
const fuseMeter = require('@api/combat_counters/fuse_meter');
const survival = require('@locomotion/survival_instincts');
const gunner = require('@api/gunner');
// Required for its VOICE only — never calls the sweep, never reads monster data through it (that
// arrives on the board). The engagement owner is the one who can say a span of sweeping is over.
const commander = require('@api/commander');
// Crew's shared board. READS the commander's section, writes none: all monster data comes from the
// one seat that owns it — replaced several separate bot.entities walks that used to live in this
// file.
const crewBoard = require('@api/crew_board');
const { withCleanup } = require('@utils/external_library_guard');
const {
  // BOT_SENIORITY left with the mob claim's tie-break — this seat no longer resolves anything
  // between bots.
  aggroRangeFor, withinAggroRange, AGGRO_VERTICAL_RANGE,
} = require('@thinking/architect_config');

// ─────────────────────────────────────────────────────────────────────────────
// WATER ESCAPE (dig-only, called by performDig — not a gate on battleStations)
// ─────────────────────────────────────────────────────────────────────────────
// Law 4: the escape reaches land via goTo (re-dispatches locomotion), so fired from inside an
// active navigator signal it is a duplicate the bus rejects — performDig skips it for its
// locomotion-tagged callers (LOCOMOTION_DIG_TAGS in dig_authority), at the dig where the tag is
// known. The `escaping` latch is a different guard: exactly one escape completes at a time.

let escaping = false;

const LAND_SCAN_RADIUS = 12; // shoreline beside a work site is 1-3 blocks; 12 covers a small pond

// findNearestLand: nearest dry stand cell, expanding rings. Water-filled feet fail
// classifyFloorInline, so only true shore returns. Returns goTo's stand/feet cell shape.
function findNearestLand(bot) {
  const { classifyFloorInline } = require('@utils/pathfinding_utils');
  const feet = bot.entity.position.floored();
  for (let r = 1; r <= LAND_SCAN_RADIUS; r++) {
    let best = null, bestD = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring perimeter only
        const x = feet.x + dx, z = feet.z + dz;
        // Topmost standable cell in the column — the shore surface, not a submerged ledge or
        // overhung cave floor the bot can't climb onto.
        for (let dy = 2; dy >= -4; dy--) {
          const floorBlock = bot.blockAt(new Vec3(x, feet.y + dy - 1, z));
          if (!classifyFloorInline(bot, floorBlock)) continue;
          const stand = { x, y: feet.y + dy, z };
          const d = (stand.x - feet.x) ** 2 + (stand.y - feet.y) ** 2 + (stand.z - feet.z) ** 2;
          if (d < bestD) { bestD = d; best = stand; }
          break;
        }
      }
    }
    if (best) return best; // nearest ring with any shore wins
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEATH — on death, drop the signal to recursive_judge and make a fresh plan; death handling lives
// here, at the gate.
// ─────────────────────────────────────────────────────────────────────────────
// Sits at the GATE, not the planner seat — a planner that routed a signal would be a second exit
// authority (Invariant D). Runs at the TOP, before the scan (Law 13: no point sensing a field for
// a body that is not in it).
//
// EVENT LATCH, NOT HEALTH POLL (Law 26 — a catch is not a guarantee): `bot.health <= 0` is a catch,
// cleared on respawn; a death-and-respawn between two gate polls (hundreds of ms apart) is
// invisible, and the bot calmly resumes a plan built for a body now naked at spawn (Invariant B).
// The `death` event is edge-triggered — the guarantee. The health read stays beside it: it answers
// "alive right now", the only question askable of a bot dead since the process started watching.
let _diedSince = false;

// ── WATCHDOG BEHIND THE LATCH ───────────────────────────────────────────────────────────────────
// The latch is consumed by the gate, which only runs when an executor calls it — a line stuck in
// `await bot.dig()`/placeBlock/activateBlock never does (mineflayer promises a corpse never
// settles; ~40 such awaits, no timeouts). A dead body's corpse can sit stale with a chest still
// locked by its magnet, blocking a peer bot until an unrelated timeout eventually clears it — the
// mechanism only worked when something else happened to time out first.
// WATCHDOG, NOT A TIMEOUT PER AWAIT: wrapping ~40 third-party calls is 40 chances to miss one (and
// the next added await arrives uncovered). One place, reusing routeToJudge — the gate's own route
// (Law 16).
// NOT a second exit authority: the body is DEAD, the in-flight line abandoned by physics, no live
// plan to race. Fires ONLY when the gate demonstrably did not.
// 5s: far above a healthy gate interval (hundreds of ms), far below the stall it replaces. Early
// fire costs nothing — the stale caller stays frozen either way (Law 15).
const DEATH_GATE_GRACE_MS = 5000;
let _deathWatchdog = null;
// Law 4 (one signal): whichever path routes first owns this death; the other freezes its caller.
let _deathRouted = false;

// ── LIFE LEDGER ─────────────────────────────────────────────────────────────────────────────────
// Accounting runs FORWARD per life; the death row is a running total, not a last-instant snapshot
// (one `gate {verdict:'died'}` row cannot answer "why"). Reset on spawn (Law 8) — a tally across
// lives makes the seventh death answer with the first death's numbers (Law 26 falsehood).
// `engagedIds` is a Set of ids, not a count: ids let a reducer tell "the same skeleton killed it
// three times" from "three skeletons killed it" — unrecoverable from a tally.
function _freshLife(bot) {
  return {
    startedAt: Date.now(),
    hpAtStart: bot && typeof bot.health === 'number' ? bot.health : null,
    hits: 0,
    damage: 0,
    hitsUnengaged: 0,
    engagedIds: new Set(),
    maxConcurrent: 0,
    lastBlow: null,        // { by, byId, kind, lost, at } — the blow that landed most recently
  };
}
let _life = _freshLife(null);

// ── THE STRIKE LATCH — this body's own "I was just hit", published for the aggro model ───────────
// { at, byId } or null. Written by the damage line (the only place the hp DROP is separated from the
// food and regen the same event carries), read by the commander through `struckWithin` below.
//
// CLEARED ON SPAWN with the rest of the life ledger, and that is not tidiness: a strike latched by
// the body that died would arm a freshly-respawned one that nothing has touched, so the first thing
// the new body did would be to open a fight on whatever happened to be standing near the bed
// (Invariant B — a remembered fact about a body that no longer exists).
let _struck = null;

// struckWithin(ms) → { at, byId } if this body took damage inside the window, else null.
//
// A READER, NOT A SUBSCRIPTION, deliberately: the commander sweeps on its own clock and asks when it
// is deciding, so the answer is always measured against the instant the decision is made rather than
// delivered at the instant of the blow and aged by however long the queue took (Invariant B). Returns
// the row rather than a boolean because `byId` is half the fact — see the trigger note in the damage
// line for why an unattributed reaction is not enough.
function struckWithin(ms) {
  if (!_struck) return null;
  return (Date.now() - _struck.at) <= ms ? _struck : null;
}

// ── WHO ACTUALLY HIT IT (replaces the nearest-hostile `suspect` guess) ──────────────────────────
// 1.21 sends `damage_event` carrying the real source — same wiring camera_scout already runs
// (lifted, not re-derived, Law 16). PREPENDED is load-bearing: mineflayer registers its
// own handler at createBot, so an appended listener fires after the `health` event that reads the
// stash. Raw `sourceDirectId` 0 = NO ENTITY (fall/drown/cactus/suffocation/fire; protocol offsets
// real ids by one) — must decode to null, never entity 0 (a real entity): "it drowned" vs "entity
// zero killed it".
let _lastDamageEvent = null;
// Counters split two causes of "0 attributed" that rows alone cannot: server never sent the packet
// (unfixable here) vs sent-and-read-missed (ordering bug). Ride to the journal at death (Law 23:
// absence of a claim is not evidence until you check it was made).
let _damageEventsSeen = 0;      // for THIS bot's body
let _damageEventsForOthers = 0; // any body — proves the packet arrives at all
function _armDamageAttribution(bot) {
  if (!bot || !bot._client || bot._aurenDamageAttribution) return;
  bot._aurenDamageAttribution = true;
  bot._client.prependListener('damage_event', (p) => {
    _damageEventsForOthers++;
    if (!bot.entity || p.entityId !== bot.entity.id) return;   // somebody else's blow
    _damageEventsSeen++;
    // DIRECT vs CAUSE, both kept: direct = what dealt the blow, cause = who is responsible. Melee:
    // same entity. PROJECTILE: direct is the arrow, removed from the entity table the instant it
    // lands, so it resolves to nothing — cause is the archer. Both stored: the choice needs the
    // entity table, read later at the blow; preferring cause outright is wrong for melee (direct is
    // the precise answer there).
    _lastDamageEvent = {
      at: Date.now(),
      kindId: p.sourceTypeId != null ? p.sourceTypeId : null,
      byId: p.sourceDirectId ? p.sourceDirectId - 1 : null,
      causeId: p.sourceCauseId ? p.sourceCauseId - 1 : null,
    };
  });
}

// _attributeBlow(bot) → { by, byId, kind } for the blow being processed now, or nulls.
// Stash trusted for ONE second: a `health` event with no fresh damage_event means the server sent
// none — null is the honest answer; a stale attacker carried forward reads as a measurement (Law 25).
const DAMAGE_EVENT_FRESH_MS = 1000;
function _attributeBlow(bot) {
  const ev = _lastDamageEvent;
  if (!ev || Date.now() - ev.at > DAMAGE_EVENT_FRESH_MS) return { by: null, byId: null, kind: null };
  // Direct first, then cause: melee resolves on direct; an arrow's direct id is a despawned body,
  // the archer behind it the only nameable answer. `byId` = whichever RESOLVED, so the row's id
  // always points at a body the reader can look up.
  let by = null;
  let byId = null;
  const resolve = (id) => (id != null && bot.entities && bot.entities[id]) ? bot.entities[id] : null;
  for (const id of [ev.byId, ev.causeId]) {
    const e = resolve(id);
    if (!e) continue;
    const n = e.name || e.mobType || e.username || null;
    if (!n) continue;
    by = n; byId = id;
    break;
  }
  // Nothing resolved: keep the DIRECT id — records that a packet arrived with an unresolvable
  // attacker; dropping it makes the ghost case indistinguishable from "no packet at all"
  // (different failures, different repairs — the reducer splits them).
  if (by === null) byId = ev.byId;
  // `byId === null` on a blow = the world did it (environmental) — a finding, not a gap.
  return { by, byId, kind: ev.kindId };
}

// ── BLAST RECORDER — measures the distance a creeper detonation costs health at ────────────────
// Nothing in the fleet has ever measured the distance a detonation costs health at:
// CREEPER_FUSE_HOLD_DISTANCE (7.0b) is where JAVA UNWINDS THE SWELL and the detonator's fade
// clears at 8.0b — neither is a blast radius, so every retreat distance rests on an unverified
// number (Law 23).
// PACKET, NOT CRATER: block damage is inference from a side effect the `mobGriefing` gamerule
// (now false fleet-wide) switches off — a detector reading "no explosions" because griefing is off
// fails in the direction that reads as good news. The packet is the server stating the event
// (Law 23).
// The 1.21.5 `explosion` packet carries the blast CENTRE only (radius removed from the protocol).
// The one honest measurement: where the bot stood, and whether health moved. Enough hp-marked rows
// bound the damage radius from data instead of a wiki recollection.
// HEALTH DELTA DEFERRED — the whole correctness of the row: `explosion` arrives BEFORE the
// `health` packet, so an in-handler hp read is pre-blast and marks every detonation harmless. The
// row is written after a settle window; a blast that has not moved health within it did not damage
// this body.
// PREPENDED like the damage stash: master_core's explosion translator is prepended too; this must
// observe the packet whether or not that one rejects the knockback.
// NOT creeper-only: the packet names no source, and inferring from the nearest body is a guess
// dressed as measurement. `nearestCreeper` is the separate, labelled claim it is.
const BLAST_HEALTH_SETTLE_MS = 400;
// Counted like _damageEventsSeen: two detonations close together can produce one row and an
// unattributable health loss from a body already gone from the table — one row and two
// detonations look identical from the row alone; the count lets the lens say "N seen, M measured"
// (Law 23).
let _explosionPacketsSeen = 0;
// Set SYNCHRONOUSLY (unlike the journal row): the retirement verdict is decided the same pass the
// body leaves the entity table — a stamp arriving 400ms later would always be too late to read.
let _lastBlastAt = 0;
// ── ATTRIBUTION BY BODY AT THE CENTRE, NOT BY CLOCK ─────────────────────────────────────────────
// Wrong turn: a 250ms vanish-window. It measures blast → *the poll that noticed the body gone*,
// not blast → body gone — retirement is discovered in orderQueue on the loop's cadence, so the
// verdict depended on when the loop next looked, and could score a detonation as a `cleared` kill
// on a mob far from dead. Widening only changes which side usually wins, and every ms buys a new
// way to credit an unrelated blast for a sword kill. The untimed evidence: a detonating creeper
// stands AT the blast centre when the packet arrives, still in the entity table (measured:
// nearestCreeper matches blast distance exactly). So the recorder names the ids at the centre and
// retirement asks whether THIS body was one. Tolerance covers one tick of movement between the
// server's decision and the packet, not slop.
const BLAST_CENTRE_RADIUS = 1.5;
// The clock survives for ONE case the id-set structurally cannot cover: a point-blank detonation
// removes the body before the packet is handled — no id at the centre to name. A different case,
// not a fallback doing the primary's job (Law 16).
const DETONATION_ATTRIBUTION_MS = 250;
// Replaced whole on every explosion — bounded by replacement, not expiry: a set outliving its
// blast would mark a later sword kill as a detonation. Nothing else writes here.
let _lastBlastIds = new Set();
// Ceiling on how long a named id stays attributable — guards against a body that survived a nearby
// blast and died to the sword seconds later still carrying the mark.
const BLAST_ID_STALE_MS = 3000;
// Written by the death handler, read by the settle timer: a respawn inside the settle window
// restores full health, so without this stamp a FATAL blast reads as harmless.
let _lastDeathAt = 0;
function _armBlastRecorder(bot) {
  if (!bot || !bot._client || bot._aurenBlastRecorder) return;
  bot._aurenBlastRecorder = true;
  bot._client.prependListener('explosion', (p) => {
    _explosionPacketsSeen++;
    _lastBlastAt = Date.now();
    // WHO WAS STANDING IN IT — named FIRST, before anything below can throw and before the
    // deferred health read: only true this instant (a tick later the body is gone from the table).
    // Independent of the bot's OWN body being readable — the fatal case is exactly when one read is
    // missing and the other is not. See BLAST_CENTRE_RADIUS for why this replaced a timing window.
    _lastBlastIds = new Set();
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e === bot.entity) continue;
      if (Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) <= BLAST_CENTRE_RADIUS) {
        _lastBlastIds.add(e.id);
      }
    }
    // ── THE DETONATION IS A BEAT, NOT A MEASUREMENT ────────────────────────────────────────────────
    // What stood here was a geometry block feeding a machine row in a sidecar file: 3-D and horizontal
    // separation, a settle-delayed health read, the nearest creeper off the board, the server's own
    // knockback claim. All of it existed to grade a blast-damage model against measured falloff, and
    // that population had exactly one consumer — a lens over a record this fleet no longer keeps.
    //
    // A detonation is still one of the loudest things that can happen to the body, so it keeps a line;
    // what it loses is the apparatus for pricing it. The settle delay survives for the one field a
    // reader actually acts on: health read at the packet is the health BEFORE the blast resolves, so
    // an immediate read reports every detonation as harmless (Law 25).
    {
      const hpBefore = typeof bot.health === 'number' ? bot.health : null;
      const deathsBefore = _lastDeathAt;
      setTimeout(() => {
        // Death inside the settle window reads as ZERO, not bot.health: a died-and-respawned body
        // reads FULL health and the fatal blast would file as harmless. A dead body reads hp 0
        // legitimately; only a GONE body reads null.
        const diedToIt = _lastDeathAt !== deathsBefore;
        const hpAfter = diedToIt ? 0 : (typeof bot.health === 'number' ? bot.health : null);
        crewLog.post('battle_stations', 'blast', {
          lost: (hpBefore == null || hpAfter == null) ? null : Math.round((hpBefore - hpAfter) * 10) / 10,
          hp: hpAfter == null ? null : Math.round(hpAfter * 10) / 10,
          fatal: diedToIt || null,
          seen: _explosionPacketsSeen,
        });
      }, BLAST_HEALTH_SETTLE_MS);
    }
  });
}

// armDeathWatch(bot): install the edge. Called ONCE from master_core's spawn handler — listeners
// are process-lifetime state and belong with the other process-lifetime listeners (Law 8), not
// lazily inside a gate that runs thousands of times.
function armDeathWatch(bot) {
  if (!bot || bot._aurenDeathWatch) return;   // idempotent: a second install would double-count one death
  bot._aurenDeathWatch = true;
  _armDamageAttribution(bot);
  _armBlastRecorder(bot);
  _life = _freshLife(bot);
  bot.on('death', () => {
    _diedSince = true;
    _deathRouted = false;
    // Stamp for the blast recorder's deferred settle read — see _lastDeathAt.
    _lastDeathAt = Date.now();

    // ── THE DEATH BEAT — posted FIRST: everything below routes signals and arms timers, and a throw
    // there must not cost the one line explaining the run's worst event (a death that leaves no record
    // is unrecoverable — there is no second chance to record it).
    //
    // It was a machine row in a sidecar file carrying the whole life: every engaged id, both bodies'
    // positions to the centimetre, the damage-event counters that made "0 blows attributed" diagnosable.
    // Those existed for a reducer that differenced a position stream, and the stream is gone with the
    // record. What a reader still acts on is who killed it, how hard the last blow was, and how much the
    // body had already absorbed — so that is what crosses onto the trace.
    const blow = _attributeBlow(bot);
    crewLog.post('battle_stations', 'death', {
      // Real attacker off damage_event. No `by` with a `kind` = the world (fall/drown/fire) — a
      // finding, not a gap.
      by: blow.by || (_life.lastBlow && _life.lastBlow.by) || null,
      kind: blow.kind != null ? blow.kind : (_life.lastBlow ? _life.lastBlow.kind : null),
      final: _life.lastBlow ? Math.round(_life.lastBlow.lost * 10) / 10 : null,
      hits: _life.hits,
      dmg: Math.round(_life.damage * 10) / 10,
      unengaged: _life.hitsUnengaged,
      peak: _life.maxConcurrent,
      engaging: !!engaging,
      life: `${Math.round((Date.now() - _life.startedAt) / 1000)}s`,
    });

    watcher.error('battle_stations',
      '☠️ DIED — the plan in flight was built for a body that no longer exists (position, inventory and ' +
      'armour are all gone). Latched, and the body stays DEAD (master_core sets respawn:false): the next ' +
      'gate abandons its caller to recursive_judge, and the board dispatches respawn_executor to click.');

    if (_deathWatchdog) clearTimeout(_deathWatchdog);
    _deathWatchdog = setTimeout(() => {
      _deathWatchdog = null;
      if (_deathRouted || !_diedSince) return;   // a gate already consumed the latch — recovery is running
      _diedSince = false;
      _deathRouted = true;
      watcher.warn('battle_stations',
        `Death watchdog fired — no gate ran in the ${DEATH_GATE_GRACE_MS / 1000}s after death, so the line that ` +
        'held the body is stuck in an await a corpse will never settle. Routing to recursive_judge from here ' +
        'instead of waiting for a gate that is not coming; the frozen caller is discarded (Law 15) and the ' +
        'board dispatches respawn_executor. Without this the bot stays down for the rest of the run and keeps ' +
        'every chest lock its magnet holds.');
      const signalBus = require('@kernel/signal_bus');
      routeToJudge(signalBus, 'battle_stations', {
        readable: 'battle_stations: bot died and no gate ran — watchdog replanning from current state',
      });
    }, DEATH_GATE_GRACE_MS);
  });

  // Respawn edge ends this death's lifecycle (Law 8) — re-arms both flags; otherwise a second
  // death finds `_deathRouted` still true and neither path routes: the same stall in the fix's clothes.
  bot.on('spawn', () => {
    if (_deathWatchdog) { clearTimeout(_deathWatchdog); _deathWatchdog = null; }
    _deathRouted = false;
    // Life ledger's lifecycle is the body's (Law 8) — carried across respawn, every later death
    // would report the run's whole damage as its own.
    _life = _freshLife(bot);
    // Same lifecycle, and here it decides behaviour rather than accounting — see the latch's own note.
    _struck = null;
    // `lastHp` belongs to the dead body too: a respawn restores full health, so a stale low reading
    // makes the NEXT ordinary drop measure itself against a body that no longer exists.
    lastHp = typeof bot.health === 'number' ? bot.health : null;
  });

  // ── DAMAGE LINE — the bot announces every hp drop and what its hp is after. Cost of absence: a
  // run can go from full health to near death with not one trace word if damage isn't logged —
  // every line reads as ordinary work, engagement never shows, and the first evidence is the death
  // line itself.
  // `engaging` is THE discriminator: damage while engaged = counter losing a fight it knows about;
  // damage while closed = counter never called. Same hp number, different defects, previously
  // indistinguishable in every artifact.
  // Level warn per Law 5 (environmental/degraded, read first when diagnosing) — a run where this
  // fires often SHOULD look alarming.
  // `health` also fires on FOOD change and regen — the drop test is what makes this a damage line.
  let lastHp = typeof bot.health === 'number' ? bot.health : null;
  bot.on('health', () => {
    const hp = typeof bot.health === 'number' ? bot.health : null;
    if (hp == null) return;
    const prev = lastHp;
    lastHp = hp;
    if (prev == null || hp >= prev) return;              // regen, food, or first read — not damage
    const lost = prev - hp;

    // NO SCAN — this used to run threat_scanner's FULL sweep (raycast per hostile) on every blow,
    // in the hottest path this file has. Deleted once all monster data was consolidated onto the
    // commander: the board was swept this tick, sorted nearest-first.
    // `sweptAt: null` = "nobody has looked yet", NOT an empty list (looked, found nothing) — a
    // reader acts differently on the two (Law 25). Only possible before the commander's first tick.
    const board = crewBoard.readCommander();
    const list = board.hostiles;
    const scanFailed = board.sweptAt === null ? 'commander has not swept yet' : null;

    const near = scanFailed ? `no scan: ${scanFailed}`
      : list.length
        ? list.slice(0, 3).map(h => `${h.name}#${h.id != null ? h.id : '?'} ${h.distance.toFixed(1)}b${h.aggroed ? ' (aggro✓)' : ' (no line)'}`).join(', ')
        : 'nothing hostile in scan';

    const nearby = list.length;
    const suspect = list.length ? list[0].name : null;
    const suspectD = list.length ? Math.round(list[0].distance * 100) / 100 : null;
    const wasEngaged = !!engaging;   // captured with the blow, not with the write below

    // ── READ ONE MACROTASK LATE — the fix for attribution silently coming back empty. `health`
    // and `damage_event` are DIFFERENT packets in one server tick; prepending only orders
    // listeners of the SAME packet. When `update_health` parses first, a synchronous read finds an
    // empty stash every blow. `setImmediate` yields once so the tick's burst is parsed first.
    // Everything about the WORLD (scan, hp, engaged flag) is captured synchronously above — only
    // attribution may arrive late; deferring the scan would grade the wrong instant (Invariant B).
    // The 1s freshness window still governs — the yield cannot adopt a previous blow's attacker.
    setImmediate(() => {
    const blow = _attributeBlow(bot);
    const from = blow.by
      ? `by ${blow.by}#${blow.byId}`
      : blow.byId === null && blow.kind != null
        ? 'by the WORLD (fall/drown/fire — no entity on the blow)'
        : 'attacker UNATTRIBUTED (no damage_event)';

    watcher.warn('battle_stations',
      `💔 TOOK ${lost.toFixed(1)} DAMAGE ${from} → hp ${hp.toFixed(1)}/20` +
      ` · ${wasEngaged ? 'ENGAGED (the counter is running)' : '⚠️ NOT ENGAGED — no engagement was open'}` +
      ` · ${list.length} hostile(s) in scan: ${near}`);

    // ── MACHINE ROW FOR THE SAME EVENT — one event, two registers (prose for a human, row for the
    // reducer): NOT a Law 16 duplicate route, it is Invariant C's two audiences. Without a machine
    // row, a ledger can only count kills by re-reading prose, which is unreliable.
    // `by` is a measurement (damage_event); `suspect` (nearest hostile) KEPT beside it — different
    // questions that diverge usefully: divergence = shot from off-screen while something else
    // stands close, the archer failure this instrument exists to find. When `by` is null the
    // server sent no event and `suspect` is all that's left.
    // ── THE REACTIVE TRIGGER — the fact the commander's aggro model is built on ──────────────────
    // Recorded here rather than sensed again over there because this listener already owns the one
    // hard question in it: `health` fires on food and regen too, so "was the body STRUCK" is the drop
    // test above, not the event. A second module watching the same event would have to re-derive that
    // and would be a second owner of one fact (Law 16 / Invariant D).
    //
    // ATTRIBUTION IS PART OF THE TRIGGER, not decoration. A blow whose source stands beyond strike
    // reach — an arrow, a potion — proves a mob can hurt this body from outside the radius the
    // reactive rule watches. Without carrying the attacker's id, a purely radius-scoped reaction
    // leaves the bot standing under fire with nothing inside the radius to answer for it.
    _struck = { at: Date.now(), byId: blow.byId };

    _life.hits++;
    _life.damage += lost;
    if (!wasEngaged) _life.hitsUnengaged++;
    if (nearby > _life.maxConcurrent) _life.maxConcurrent = nearby;
    _life.lastBlow = { by: blow.by, byId: blow.byId, kind: blow.kind, lost, at: Date.now() };

    // ── A BLOW LANDING ON THE BODY IS A BEAT, and it is the one the fight is ultimately scored on ──
    // The two positions this row used to carry (both bodies, to the centimetre) were there to be
    // differenced against the adjacent per-swing rows — "who closed the gap" — and per-swing rows are
    // not a thing this fleet records any more. Without them the coordinates answer nothing, so they go
    // and the blow itself stays. `unengaged` is kept because a blow taken while NOT fighting is a
    // different fault from one taken mid-fight (something reached the body nothing was watching).
    crewLog.post('battle_stations', 'hurt', {
      subject: blow.by && blow.byId != null ? `${blow.by}#${blow.byId}` : null,
      lost: Math.round(lost * 10) / 10, hp: Math.round(hp * 10) / 10,
      kind: blow.kind, nearby,
      unengaged: wasEngaged ? null : true,
      no: _life.hits,
    });
    });
  });
}

// THE GATE DOES NOT RESPAWN THE BOT — it checks whether the bot is dead and routes to the judge if
// so. WHERE a bot comes back is a planning decision; the click is `assessors/respawn`
// dispatching `respawn_executor` — the only `bot.respawn()` in the fleet. What survives here is the
// CHECK.

// abandonToJudge: originate a fresh chain at recursive_judge (→ job_board → new plan); the
// returned promise never resolves, so the caller's await hangs and its line is discarded (Law 15).
// Only one signal exists, so nothing is left mid-flight.
// releaseJobClaim — drop the magnet on entering combat: the judge only cleared magnets on
// `haltForInspection`, so every ordinary fight left a claim
// on a job whose line was already discarded — the board could not re-decide, a peer could not take
// it, and the chest locks INSIDE the magnet (corporate_headquarters: one clearMagnet releases the
// claim and every lock) stayed held for the fight; the bot then resumed a pre-attack plan from a
// position it no longer occupied (Invariant B). Clearing makes the fight a real replanning boundary.
// At the ENGAGE edge, not every call: the gate is polled every loop iteration (seed_picker,
// seed_picker, navigator), and clearing on an empty poll deletes a peacefully-working bot's
// magnet (Law 8).
// Sentry exempt: the arena bench's watch loop holds no job and never had a magnet; reaching into a
// bench body from fleet code is the boundary Law 26 keeps shut.
// nearestHostileDistance: closest hostile RIGHT NOW, or null. Exists so every major line can carry
// distance to the nearest threat. Answers from the commander's board — its own entity walk is the
// one consolidated sweep (Law 16). Board is rewritten every tick, so a wave-end report gets the
// range NOW, not the range the fight opened at (Invariant B). `nearest`, not closest-aggroed: a
// report wants every hostile, including those that failed the aggro test.
function nearestHostileDistance() {
  const n = crewBoard.readCommander().nearest;
  return n ? n.distance : null;
}

// One shared tail so "distance to the monster" is not four near-identical strings that drift (Law 16).
function _dTail() {
  const d = nearestHostileDistance();
  return d == null ? 'Nearest hostile: none in range.' : `Nearest hostile ${d.toFixed(1)}b.`;
}

// Unguarded: the dispatcher is ours. A swallowed clear leaves the magnet latched on a job the bot has
// just abandoned to fight, so it walks back to that job after the wave regardless of what the board
// says — a stale claim outliving the work it was for (Law 8).
function releaseJobClaim(source) {
  if (source === 'sentry') return;
  require('@thinking/dispatcher.js').clearMagnet();
}

function abandonToJudge(readable) {
  const signalBus = require('@kernel/signal_bus');
  routeToJudge(signalBus, 'battle_stations', { readable });
  return new Promise(() => {});
}

// escapeWaterToLand — take the body over, swim to land, abandon the caller to recursive_judge
// (Law 15). Fires only for a work-DIG in water: surface bobbing moves the body between look and
// swing (chop-the-tree-while-bouncing failure); a PLACE survives the bob (place at apex —
// pillarStep). The blanket "swimming ⇒ escape" gate this replaced yanked the bot to land for work
// it could do afloat — battle_stations only needs to take over when digging is required while
// bobbing; placing while bobbing is fine.
async function escapeWaterToLand(bot, readableCtx) {
  if (escaping) return new Promise(() => {});   // an escape already owns the body; freeze this caller too
  if (!bot?.entity?.position) return;
  const at = bot.entity.position.floored();
  escaping = true;
  let land;
  // withCleanup, not a guard: nothing is caught. The latch must drop on every exit or a single failed
  // escape freezes every later caller against a body no one is taking over (Law 8).
  await withCleanup('battle_stations', 'water escape latch', async () => {
    watcher.warn('battle_stations',
      `🌊 ${readableCtx} — swimming at (${at.x},${at.y},${at.z}); taking over to reach land (Law 15). Placing is allowed while bobbing; digging is not.`);
    land = findNearestLand(bot);
    if (land) {
      const { goTo } = require('@locomotion/locomotion_dispatcher');
      await goTo({ x: land.x, y: land.y, z: land.z });
    }
  }, () => { escaping = false; });
  const now = bot.entity.position.floored();
  const dry = !bot.entity.isInWater;
  watcher.summary('battle_stations',
    land
      ? `Water escape ${dry ? 'success' : 'incomplete'} — at (${now.x},${now.y},${now.z}). Abandoning caller to recursive_judge for replan from land.`
      : `No land within ${LAND_SCAN_RADIUS} blocks of (${at.x},${at.y},${at.z}) — abandoning caller; the brain must replan from open water.`);

  return abandonToJudge(dry
    ? 'battle_stations: water escape success — reached land, replanning'
    : 'battle_stations: water escape incomplete — replanning from water');
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBAT — reactive counter-aggro engagement (combat refurbish §2/§5)
// ─────────────────────────────────────────────────────────────────────────────
// Rides the inline hook ABOVE the water gate so it fires for every caller (executors AND
// locomotion — pursuit is a movement concern). Self-contained Law 15 sub-loop: takes the body,
// fights re-sensing every pass (Invariant B), abandons the caller.
//
// SAFE FROM THE NAVIGATOR because the FIGHT routes no signals (raw control state or direct calls)
// — cannot start a duplicate signal the way the water escape's goTo does; why navigator.js:959 may
// await this inside its step loop while the water gate may not.
// THE SPOILS ARE THE EXCEPTION: the 'cleared' branch calls drop_collector.collectNearby, which
// walks by goTo — a SECOND locomotion invocation inside the caller's live one. This once produced
// duplicate-signal refusals that left both bots inert with zero live signals — but signal_bus
// refuses nothing now; the inner walk completes and the tail abandons once. Full argument at the
// spoils branch; original sequence in Documentation/Refurbishing planning/battle_stations_how_it_works.md
// §9. Wrong turn: giving collectNearby its own walker (a second pathfinder, Law 16).

let engaging = false;

// The reason the gate last declined to fight, or null if it has not declined since the last engagement.
// A decline is posted on the CHANGE of this value, never on its repetition — see the decline block near
// the end of `battleStations` for why a per-pass record cannot live on the trace. Cleared when a fight
// actually opens, so the first decline after a wave is a fresh statement rather than a suppressed one.
let _lastDeclineWhy = null;

// ── WAVE'S METER LINES, HELD UNTIL THE WAVE ENDS ────────────────────────────────────────────────
// battle_stations does not post every turn — commander, gunner and driver each report their own
// seat; this file posts only normal signal passing and major actions.
// A trace can grow enormous when a per-retirement report posts on every one of thousands of
// targets over a long run, and a combat journal has a row-count truncation cap that turns a death
// count into a floor rather than a total when hit.
// BUFFER, NOT DEDUPE: dedupe cuts volume but leaves the report at the wrong BOUNDARY — a
// retirement is one mob's fight ending; the meters answer a wave question. Posting at wave end
// puts the report where its subject is; the dedupe falls out free (identical strings collapse on
// push). Per-mob attribution survives: each string composed at its own retirement off meters that
// reset there; only POSTING is deferred. Journal rows untouched, still per retirement.
// Module scope legal like `engaging`: one engagement per seat (Law 4), one wave's lines in flight.
let _waveMeterLines = [];

// ── MOB CLAIM DELETED. BOTS GANG UP — no monster claiming; nothing shall prevent a swing.
// Was here: `mob_claims[mobId]` on each boardroom chair, 3000ms freshness, 5-block hysteresis,
// seniority tie-break; tryClaimMob/releaseMobClaim and the wave loop's yield branch went with it.
// A mob is not a TASK: two bots on one job waste one (Invariant D's point); two bots on one zombie
// kill it twice as fast — the "waste" is the gang. The claim's cost: entitlement was asked AFTER
// the target was taken and recorded, so a refusal left the world unchanged and the next pass
// repeated it — a claim gate here produces unbounded unentitled-engagement churn with no kills to
// show for it (all well-formed, Law 25, but useless).
// DO NOT REINTRODUCE — nor a softer version: no "yield if a peer is closer", no per-mob cooldown
// between bots, no target-diversity steering. The ONLY gates on attacking a mob are physical: in
// reach, weapon charged.
// TASK locks untouched (overseer_link object claims, dispatcher job claims): a job is a task; a
// mob never was.

// ── WHAT THIS FILE NO LONGER DOES ───────────────────────────────────────────────────────────────
// Weapon selection + swing act → combat_utils: a second material-ranked picker is the redundant
// route (Law 16) — the weapon ruling has changed since, in one place each time.
// The two counter ARMS → combat_counters/hold.js and rush.js, shared acts in
// counter_primitives.js; each exposes exactly run/report/reset (rush adds stats for the journal's
// end record). Why they left (not a size cut): each carried module-level fight state (fuse phase,
// repel EMA, rush clock) in the SAME file as the engagement's own state — no structural owner per
// tally (Invariant D). Now each arm owns its own; the only way in is reset(), called at engagement
// start and every retirement.
// WHAT STAYS is composition: WHICH mob, WHICH counter, when to break off. A tactical decision on
// this side of that boundary must not come back — a gate here reading a mob NAME to choose
// behaviour is the two-keys break the fuse branch used to be.

// ── retreatToDisengage DELETED WITH THE CLAIM THAT CALLED IT. Its job was the evicted bot's
// back-off; no claim, no evicted bot. Deleted rather than parked (Law 16): an
// unreferenced retreat verb beside a fight loop is what a successor wires back in to "fix" a
// crowded engagement — the mimic of the removed yield rule. A deliberate break-off would be the
// DRIVER's setpoint, in the driver, where movement lives.

// ── COUNTER DISPATCH DELETED, NOTHING REPLACED IT HERE — the tactic is universal, one tactic for
// every mob. runCounter handed the whole body to an arm per fight; driver and gunner now run on their own ticks from the moment engageThreat
// armed them. The loop below still LOOKS like it drives the fight — it does not: it holds the wave
// open, watches the field, retires bodies, writes the record — judge and recorder (Law 11), never
// executor. It must not regrow a decision about where the body goes or what it swings at; both
// have owners, and a second one here is the two-owners-of-the-yaw shape this split exists to end.

// ── STAGE 2/3: TARGET_ENGAGED → TARGET_COMBAT ────────────────────────────────────────────────────
//
// A fight is bounded by TIME, not by passes. The old guard was 60 passes, and a `wait` pass costs 50 ms,
// so a brawler that walked in slowly could exhaust the whole allowance in three seconds and report
// 'stalled' while the fight was going exactly to plan. Wall-clock is the honest judge here (Law 13 —
// one judge, and it has to measure the thing that is supposed to end). A zombie is 20 hp against a 4-dmg
// sword: five charged hits, a few seconds. A minute is not a slow fight, it is a fight that is not
// happening.
//
// IT IS PER TARGET, NOT PER WAVE, and the reasoning above is why: every number in it is sized off ONE
// mob's health against one weapon's cooldown. Left as a wave clock over a queue of four it would measure
// something it was never sized for and fire on a fight going exactly to plan — the identical defect its
// own first paragraph describes about the 60-pass guard. So a KILL resets it (see targetEngaged). Only a
// kill: that is unambiguous progress, which makes this a judge that terminates when the gap stops
// shrinking (Law 11) rather than a clock that can be extended by the fight merely continuing.
const ENGAGEMENT_MAX_MS = 60000;

// ── THE DEAD-WAIT CLOCK ─────────────────────────────────────────────────────────────────────────
// The overall engagement ceiling is too long a wait for a fight that never opened, but it is NOT the
// ceiling above that has to move — the two numbers measure different things and collapsing them
// would break the fight that works: a bare-handed bot can kill a 20 hp zombie over dozens of
// seconds and swings — a fight going exactly to plan, which a flat short ceiling would abandon
// partway through. The rule is "only when nothing is happening", so this is a SECOND clock with a
// different predicate, not a smaller first.
//
// WHAT "NOTHING" MEANS HERE, and it is deliberately the strictest reading available: the bot did not
// move, the held mob did not move, and the held mob took no damage. Any real fight fails all three
// within a pass — a brawler is closing, a fading bot is walking, a mob being hit is losing health. The
// only state that satisfies all three is two bodies standing still looking at each other, which is
// precisely the shape a stalled fight with no swings and no movement produces.
//
// MEASURED, NOT INFERRED FROM EFFORT. Counting swings instead would have called a bot whiffing at air
// for ten seconds "busy"; positions and health are what actually changed (Law 25 — the verdict is
// sensed reality, not the work the bot believes it did).
//
// ONE SECOND, NOT TEN (Architect 2026-08-15: "everything must be fast in combat"). The predicate above is
// what makes so short a clock safe, and it is the whole argument: this does not measure a SLOW fight, it
// measures a fight in which the bot did not move, the mob did not move, and the mob took no damage. At
// 20 Hz that is twenty consecutive ticks of three separate things all failing to change — a real fight
// cannot produce one, because a brawler is closing, a fading bot is walking, and a mob being hit is
// losing health. A longer clock buys no extra certainty about the verdict; it only delays the response,
// and the response is the point. Ten seconds was a body standing in a fight doing nothing for nine of
// them before anything was allowed to notice.
const IDLE_STALL_MS = 1000;
// The bot jitters a little while standing and swinging, so a raw inequality would read as movement every
// pass and this clock would never fire. A quarter block is under one step and far over the jitter.
const IDLE_MOVE_EPSILON = 0.25;

// combatActivity — did ANYTHING happen between these two samples? Pure, exported and separate from the
// loop for one reason: the first version of this predicate was wrong in a way no live run announced (it
// read an unreadable mob health as "hurt", which reset the clock every pass and disabled it silently),
// and a claim about behaviour that can fail quietly belongs in a test rather than a comment (Law 14).
// `prev` null — the first sample of a fight — is activity: nothing can be stale before it exists.
function combatActivity(prev, now) {
  if (!prev) return true;
  const moved = !prev.botAt || !now.botAt || now.botAt.distanceTo(prev.botAt) > IDLE_MOVE_EPSILON;
  const mobMoved = !prev.mobAt || !now.mobAt || now.mobAt.distanceTo(prev.mobAt) > IDLE_MOVE_EPSILON;
  const hurt = now.mobHp !== null && prev.mobHp !== null && now.mobHp < prev.mobHp;
  return moved || mobMoved || hurt;
}

// The distance beyond which a vanished entity is reported as LOST rather than KILLED. Mineflayer drops
// an entity from `bot.entities` for two reasons it does not distinguish — the mob died, or it left the
// tracking range — so the honest answer comes from where it was last seen. Claiming a kill we cannot
// verify is exactly the unearned success flag Law 25 bars; 'lost' is the true verdict when we cannot
// tell. 16 blocks is comfortably outside any built counter's engagement band and well inside the
// server's entity-tracking radius, so a disappearance inside it is a death.
const KILL_CONFIDENCE_RANGE = 16;

// refreshTarget: the same descriptor threat_scanner produces, rebuilt from the LIVE entity. Identity is
// the entity id and never changes; position is re-read every pass (Invariant B — the handover snapshot
// is stale the instant it is taken). Returns null when the entity is gone from the world.
function refreshTarget(bot, id, name) {
  const e = bot.entities && bot.entities[id];
  if (!e || e.isValid === false || !e.position) return null;
  return {
    id, name, entity: e,
    distance: bot.entity.position.distanceTo(e.position),
    position: { x: e.position.x, y: e.position.y, z: e.position.z },
  };
}

// _bankMeterLine: hold one meter's line for the wave report instead of posting it now.
//
// DEDUPE IS NOT COSMETIC HERE. A repeated identical line carries no information by definition — the
// meters were reset at the previous retirement, so a string that comes back word-for-word describes a
// window in which nothing new was sampled. Dropping it is dropping a non-event, not a measurement. The
// capacity guard below is the other half: a wave that somehow produces thousands of DISTINCT lines is a
// fault in the loop, and the guard makes it report itself as one instead of re-flooding the trace.
const MAX_WAVE_METER_LINES = 12;
function _bankMeterLine(line) {
  if (_waveMeterLines.length >= MAX_WAVE_METER_LINES) return;
  if (_waveMeterLines.includes(line)) return;
  _waveMeterLines.push(line);
}

// bankFuseLine: the fuse meter's line for the mob whose fight just ended, BANKED for the wave boundary
// rather than posted now (see `_waveMeterLines`).
//
// PER RETIREMENT AND NOT PER WAVE, AND THAT IS A LAW 25 CONSTRAINT rather than a preference. The tally
// describes the fight against ONE mob, so posting it once at the end of a wave that fought four would
// file the last mob's numbers as the whole engagement's. `wasHeld` at the call site is the same fault
// from the other side — a queued mob that died to a peer or a fall was never fought by this meter, and
// its numbers under that mob's name would be a measurement of one fight filed against another.
//
// It takes nothing and returns nothing: the meter owns "did I measure anything" and answers with a null
// line when it did not (Invariant D — that question is the meter's, not this seat's). It was
// `reportCounters(bot, choice)` while a second meter beside it needed the body and the weapon; both
// arguments went with that meter, and a signature keeping parameters nothing reads is a comment that
// cannot rot into being wrong only because nobody looks at it.
function bankFuseLine() {
  const fz = fuseMeter.summary();
  if (fz) _bankMeterLine(fz);
}

// ═══ THE ENGAGEMENT QUEUE ═══════════════════════════════════════════════════════════════════════
//
// The design requirement: battle_stations must not drop out after one monster while another is
// attacking, leaving a gap of inactivity before it responds again. It keeps engaging; raycast
// happens once per mob that enters the aggro radius, and once confirmed-aggro a mob goes into an
// engagement queue ordered by distance — the bot always attacks the closest entity, re-checking on
// every inline pass whether it needs to switch targets.
//
// WHAT THE GAP WAS. targetEngaged held one entity id until it died and then RETURNED, so engageThreat
// ran its finally, printed its reports and abandoned the caller to recursive_judge for a full replan
// before battleStations could be re-entered. With a second mob already swinging, that whole round trip
// is time the bot spends standing still being hit. The fix is not a faster replan — the engagement now
// ends when the FIELD is clear, not when one mob is.
//
// WHAT IS REMEMBERED AND WHAT IS RE-SENSED, which is the whole design. The queue remembers exactly one
// thing per mob: that a raycast confirmed its aggro. That fact does not decay, it is paid for once, and
// it is the one thing the mid-fight gate is forbidden to re-derive (it may not raycast — combat_planner's
// header carries the ruling and the cost). Everything else — alive, distance, order — is
// re-read off the live entity every pass. So the queue is a SET OF IDS and never an ordering: the order
// is recomputed from live positions on every single pass (Invariant B).
//
// WHY IT IS NOT AN INVARIANT A VIOLATION. One bot still fights exactly one mob at a time; the queue is
// the list of fights it is entitled to take, not a second occupant of the scope. The claim (§6) is still
// per-mob and still held by one bot.

// AGGRO_RECHECK_MS moved to `commander` with the cast it bounds. It is stated here only to stop it
// growing back: this file no longer raycasts, so a re-check clock here would be a second bound on a
// cast that is not made here (Law 16).

// TARGET_SWITCH_MARGIN (0.5 b of spatial hysteresis) and REPICK_CEILING_MS (2000) went with the two
// functions they tuned — see the tombstone above `retirementVerdict`. Named here only to stop them
// growing back: this seat no longer chooses a target, so a switch margin here would be a damper on a
// decision made in another seat (Law 16). MOB_CLAIM_SWITCH_MARGIN above is a different constant for a
// different question (which BOT owns a mob) and is untouched.

// enqueue: admit ONE confirmed-aggro mob. The tactic is matched here, at admission, because that is the
// moment the mob becomes a fight this bot may take — target-to-tactic matching done per target instead
// of once per wave.
//
// THE ENTRY CARRIES ONE CLASSIFICATION, not two. It used to carry `group` beside `tactic`, and after
// the fifteen groups folded onto the two tactics those were the same string printed twice — the queue
// row, the journal row and the engage line all said "HOLD … HOLD".
//
// ── THE UNKNOWN-MONSTER POLICY IS GONE, WITH THE TACTIC IT CHOSE — there is one tactic now ─────────
//
// There is one tactic, so there is nothing left to be wrong about: an unclassified mob is approached
// to 2.9 b and held there exactly like a known one, and the safety a species-specific policy used to
// buy is now bought by the band itself. The WARNING went with the branch — a log line that says a mob
// is unclassified when the classification no longer changes any behaviour is noise about a distinction
// the code stopped drawing (Law 5).
function enqueue(queue, id, name, distance) {
  if (queue.has(id)) return false;
  queue.set(id, {
    id, name,
    // The last distance this mob was SEEN at — never a position. It exists for one question: when the
    // entity vanishes, was it close enough that the disappearance is a kill (KILL_CONFIDENCE_RANGE)?
    lastDistance: distance,
  });
  return true;
}

// admitAggro: queue every mob the commander has posted as ACTIVE that is not already in the queue.
//
// THE RAYCAST THAT USED TO BE HERE IS GONE — no monster data is derived anywhere but the commander.
// This function used to walk the entity table, test each mob's species radius, throttle a re-cast at
// AGGRO_RECHECK_MS and confirm the line itself — all of which the
// commander now does once per tick for the whole crew, including the throttle and the 5 b contact rule
// the raycast cannot beat at close range. What is left is the admission itself, which is a queue
// operation and genuinely this seat's: the commander says who is a threat, this seat says which threats
// it has taken on (Invariant D — two questions, two owners).
function admitAggro(bot, queue) {
  let admitted = 0;
  for (const h of crewBoard.readCommander().active) {
    if (queue.has(h.id)) continue;
    if (enqueue(queue, h.id, h.name, h.distance)) admitted++;
  }
  return admitted;
}

// orderQueue: the queue read as a fight order, rebuilt from live entities. Entries whose entity has left
// bot.entities come back in `gone` rather than being dropped — a vanished mob is a verdict to record and
// a claim to release, and silently forgetting it is how a kill gets miscounted (Law 25).
function orderQueue(bot, queue) {
  const live = [], gone = [];
  for (const entry of queue.values()) {
    const target = refreshTarget(bot, entry.id, entry.name);
    if (!target) { gone.push(entry); continue; }
    entry.lastDistance = target.distance;
    live.push(Object.assign(target, { entry }));
  }
  live.sort((a, b) => a.distance - b.distance);
  return { live, gone };
}

// ── `pickTarget` AND `mayRepick` WERE DELETED HERE, AND WHY THEY MUST NOT COME BACK ───────────────
// They were the nearest-first comparator (`TARGET_SWITCH_MARGIN`, 0.5 b of spatial hysteresis) and the
// gate that decided WHEN the target question could be re-asked (the weapon's cooldown plus a 2 s
// ceiling, `REPICK_CEILING_MS`). Both implemented "the bot always attacks the closest entity" — a rule
// replaced by the focus tactic (rush one mob and ignore everything else, then switch). The wave loop
// now reads `crewBoard.readCommander().focus`, so keeping these alive would be two answers to one
// question with only the call site saying which one wins (Law 16).
//
// THE FAULT THEY FIXED IS NOT GONE — IT MOVED SEATS, and a successor re-deriving a repick gate here is
// the wrong turn to avoid. The fault: the wave loop runs a pass roughly every 10 ms and re-decided the
// target on every one of them while a swing sat on a cooldown of hundreds of ms — dozens of decisions
// between two swings, with target changes far outrunning the weapon and mostly away from a mob still
// alive. The cost of a swap is a COUNTER RESET (the repel tracker's
// approach EMA, the fuse phase, the archer's rush clock all key on mob id), so thrashing destroys the
// timing state the next swing is computed from. What holds that line now is the commander's `chooseFocus`,
// which COMMITS to an id and returns it unchanged for as long as it is alive and active — hysteresis by
// identity instead of by distance, which cannot be crossed by two mobs converging. Re-adding a gate here
// would be a second damper on a decision this seat no longer makes.

// retirementVerdict(entry, wasHeld, now) → 'dequeued' | 'detonated' | 'cleared' | 'lost'.
//
// Pulled out of the loop for the same reason `pickTarget` and `mayRepick` were: it is the whole of a
// claim about outcomes, and inside a loop it can only be asserted by regex on this file's own source.
// This verdict has produced FALSE results in live runs (a detonation filed as a kill), so it is the
// decision in this file with the worst measured record and the least test coverage. It reads module
// state deliberately — a bench drives it by
// emitting a real `explosion` packet through the real recorder, which is a run rather than a simulation of
// one (Law 26: a machine's truth-guarantee only exists while it actually runs).
function retirementVerdict(entry, wasHeld, now) {
  if (!wasHeld) return 'dequeued';
  const sinceBlast = _lastBlastAt ? now - _lastBlastAt : Infinity;
  const blasted = (_lastBlastIds.has(entry.id) && sinceBlast <= BLAST_ID_STALE_MS)
    || sinceBlast <= DETONATION_ATTRIBUTION_MS;
  if (blasted) return 'detonated';
  return entry.lastDistance <= KILL_CONFIDENCE_RANGE ? 'cleared' : 'lost';
}

// retireTarget: one mob's fight is over — record the verdict and, if this was the mob the counters were
// actually running against, print their reports and clear them.
//
// THE REPORTS MOVED HERE FROM THE END OF THE ENGAGEMENT, and that is a Law 25 fix rather than a
// reshuffle: each arm's tallies describe the fight against ONE mob, so printing them once at the end of
// a four-mob wave would have attributed the last mob's numbers to the whole engagement. `wasHeld` is the
// guard on the same fault from the other side — a queued mob that dies to a peer or a fall was never
// fought by these counters, and printing their numbers under its name would be a measurement of one
// fight filed against another.
function retireTarget(bot, choice, entry, verdict, wasHeld) {
  // ── THE VERDICT LINE, AND `hit` IS THE FIELD THAT REPLACED A WHOLE ROW KIND ──────────────────────
  // A reader of this line has to be able to tell "the bot killed it" from "it died near the bot" — a mob
  // that burned, fell, or was killed by a peer must not be credited here (Law 25). That used to be
  // derived by joining every per-swing row for this mob and asking whether any of them connected, which
  // is a lot of record kept for one boolean. The gunner already knows the answer the moment it first
  // lands a blow, so it states it once per mob (`connect`) and the count arrives here.
  crewLog.post('battle_stations', 'end', {
    subject: `${entry.name}#${entry.id}`,
    outcome: verdict, held: !!wasHeld,
    hit: gunner.connectedTo(entry.id),
    d: Math.round(entry.lastDistance * 100) / 100,
    hp: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
  });
  if (!wasHeld) return;
  bankFuseLine();

  // AFTER the line is banked, and per retirement rather than per wave — the line describes the fight it
  // was measured on.
  fuseMeter.reset();
}

// targetEngaged: fight the field, closest first, until nothing confirmed is left standing. NOT a re-scan
// loop — threat_scanner is not consulted again (stage 1 did its job); the only perception added is the
// bounded admission cast above. Everything else is arithmetic on live entities.
//
// Took a `claimed` Set until the mob claim was deleted (see the tombstone above the wave loop). There is
// nothing per-mob left for the wave to raise and therefore nothing to release.
async function targetEngaged(bot, firstBoard, choice) {
  const queue = new Map();
  // Seeded from the commander's `active` list at the instant the fight opened — every descriptor in it
  // has already passed the aggro test, so there is nothing left to confirm here. The per-mob raycast
  // throttle (`castAt`) that used to live in this function is gone with the admission cast: the commander
  // owns that clock now, for the whole crew and at one rate (Law 16).
  for (const h of firstBoard.active || []) enqueue(queue, h.id, h.name, h.distance);
  if (!queue.size) enqueue(queue, firstBoard.engage.id, firstBoard.engage.name, firstBoard.engage.distance);

  const tally = { cleared: 0, lost: 0, dequeued: 0, taken: 0, detonated: 0 };

  // ── IS THE WAVE LOOP ACTUALLY FIGHTING THE COMMANDER'S FOCUS? ───────────────────────────────────
  // The tactic: rush one mob, kill it as fast as possible ignoring everything else, then switch to the
  // next.
  //
  // This audit was born measuring a DIFFERENT rule — "the bot always attacks the closest entity" —
  // because `pickTarget` was the whole of that rule and had no test. The tactic above replaced
  // that rule outright: the wave loop now takes `crewBoard.readCommander().focus`, so "held the nearest"
  // became a claim the code no longer makes, and a report still printing it would have read as a
  // regression every fight (Law 14 — the WHAT the code walked away from). The instrument is re-pointed
  // rather than deleted, because the question it answers is the same shape and still unasserted anywhere:
  // does the seat that decides the target agree with the seat that executes it?
  //
  // MEASURED PER PASS, NOT PER SWITCH, and that distinction survives the re-pointing intact. Counting
  // switches says how often the loop CHANGED its mind; it cannot say how long it spent on a body the
  // commander was not aiming at, which is the thing that gets a bot killed. One missed handover held for
  // several seconds is invisible in a switch count and obvious here.
  //
  // `offClosestB` is the OVERHANG — how much further the held mob is than the nearest one — and its
  // MEANING INVERTED with the tactic. Under closest-wins it was the fault; under the focus it is the
  // COST: the distance the crew deliberately walked past to commit to an archer. It is now the number
  // that prices the tactic, so it is kept and the `overMargin` counter beside it was dropped — that
  // counter compared the overhang to TARGET_SWITCH_MARGIN, a hysteresis band belonging to the comparator
  // that no longer decides anything.
  //
  // `noFocus` is the honest denominator: passes where the commander had no focus in this queue at all and
  // the loop fell back to its own held/nearest choice. Without it a wave the commander never spoke for
  // would report 100% agreement, which is a well-formed falsehood (Law 25).
  const focusAudit = { passes: 0, onFocus: 0, noFocus: 0, offClosestB: 0, switches: 0, switchedToFocus: 0 };
  // Every mob that left the queue ALIVE this wave. Reported up because a mob id is the only thing that
  // tells a re-engagement apart from a fresh one — see the disengage judge in engageThreat.
  const dequeuedIds = new Set();
  // ── WHICH ENTITY DIED, AND WHICH WALKED ─────────────────────────────────────────────────────────
  // The end of a wave must report entity ids killed or disengaged, not just counts.
  //
  // The tally above counts; these NAME. A counter cannot answer the question a wave asks — lanista holds
  // one mob per wave and completes the wave when THAT mob's battle completes, so `cleared: 1` is
  // ambiguous the moment a second hostile wanders in (Law 25: the count is true and still misleads the
  // asker, whose criterion is an identity). The ids are already written per target by retireTarget; this
  // is the same fact carried UP the return instead of only down to the journal, because the sentry loop
  // decides on it live and cannot read a file it has not flushed.
  //
  // Two buckets, not three, and the split is the verdict's: 'cleared' is the only verdict this bot earned
  // a kill for (see KILL_CONFIDENCE_RANGE). 'lost', 'dequeued', and the mid-fight exits ('died', 'stuck',
  // 'error') all mean the same thing to a wave judge — the engagement ended and that entity is not
  // confirmed dead — so folding them into one bucket is the honest translation, not a simplification.
  const killedEntityIds = new Set();
  const disengagedEntityIds = new Set();
  const entityNames = new Map();
  // Called from BOTH retirement paths — the `gone` sweep and the finally's held-target retirement — so a
  // bot that died holding a mob still reports that mob as disengaged. One retirement, one bucketing;
  // a second place deciding what a verdict means is the Law 16 split that lets the two disagree.
  const bucketRetirement = (entry, verdict) => {
    entityNames.set(entry.id, entry.name);
    (verdict === 'cleared' ? killedEntityIds : disengagedEntityIds).add(entry.id);
  };
  let deadline = Date.now() + ENGAGEMENT_MAX_MS;
  // The dead-wait clock's three remembered readings — see IDLE_STALL_MS. Nulls mean "not sampled yet",
  // which reads as activity on the first pass and is right: nothing can be stale before it exists.
  let idleSince = 0, lastSample = null;
  let heldId = null;
  let outcome = null;
  let passes = 0;
  // Peak simultaneous live hostiles across this wave. Raised beside every `engage` row, which is the one
  // place the queue is measured against the world rather than against itself.
  let maxConcurrent = 0;

  // withCleanup, not a guard: nothing here is caught, and a throw travels straight out. See the
  // retirement note in the cleanup — it is the reason this needs to run on every exit.
  await withCleanup('battle_stations', 'engagement loop', async () => {
    while (Date.now() < deadline) {
      // THE PASS BOUNDARY IS THE LINE BOUNDARY — driver, gunner and commander each post their
      // information as one line per pass. Every crew event raised during the previous pass is posted
      // here as one line per seat. Flushing at the TOP rather than the bottom is what makes it unskippable:
      // this loop body has several `continue` paths and a `break`, and a bottom flush would silently lose
      // whichever pass took one of them. The pass that ends the loop is flushed after it (see below).
      crewLog.flush();
      passes++;
      // Death exit (sentry mode). NOT the gate's check — that one asks whether a
      // fight may START, this catches the bot dying DURING the fight it already started, which is the
      // only case reachable from here. Without it the loop keeps facing, swinging at and driving a
      // corpse with `engaging` latched, which also blocks the next real engagement (Law 13).
      if (!bot.entity || (typeof bot.health === 'number' && bot.health <= 0)) { outcome = 'died'; break; }

      const now = Date.now();
      admitAggro(bot, queue);
      const { live, gone } = orderQueue(bot, queue);

      // ── STAGE 4, PER MOB. A vanished entity is a kill only if it vanished close (see
      // KILL_CONFIDENCE_RANGE) AND it was the mob being fought. Anything else is `dequeued`: recorded,
      // never counted as a kill, because a mob that died to a peer or a fall is not one this bot killed
      // and the spoils gate downstream reads that verdict (Law 25).
      for (const entry of gone) {
        // The last gap AND the last health travel with it: a creeper that leaves the world still winding
        // up is either a detonation or a mid-swell kill, and where it went plus what it had left are two
        // of the three things that tell those apart (the third is whether the bot bled at that instant,
        // which the lens joins from the `hurt` rows — see fuse_meter.vanished).
        // No health passed here on purpose: `gone` holds QUEUE entries, which never carried an entity —
        // the body is already out of `bot.entities`, which is what put it in this list. The meter's own
        // per-pass reading is the only health that can exist for a mob that has stopped existing.
        fuseMeter.vanished(entry.id, entry.lastDistance);
        const wasHeld = entry.id === heldId;
        // ── A MOB THAT REMOVED ITSELF IS NOT A KILL (Law 25) ────────────────────────────────────────
        // The verdict below used to have two branches — vanished near = killed, vanished far = lost —
        // and a DETONATION vanishes near. So every creeper that blew itself up was filed as a kill by
        // this bot. The accumulated ledger exposed it arithmetically: a weapon's blows-per-kill average
        // for creepers came out below what the weapon's damage and the creeper's health make possible —
        // a fist cannot kill a 20 hp creeper in one or two blows under any reading. Those are detonations
        // wearing a success flag, which is precisely the unearned outcome signal Law 25 bars, and it made
        // the fleet's headline metric say the opposite of the truth about the one mob the whole DETONATOR
        // arm exists to survive.
        //
        // The blast recorder is what makes the third branch possible: an explosion packet lands within a
        // tick or two of the body leaving the entity table, and nothing else does that. Attribution is
        // never by SPECIES — inferring "it was a creeper because a creeper is missing" is the guess this
        // branch exists to stop being.
        //
        // The two tests it runs, and why neither is a clock alone, are in `retirementVerdict`.
        const verdict = retirementVerdict(entry, wasHeld, Date.now());
        tally[verdict]++;
        if (verdict === 'dequeued') dequeuedIds.add(entry.id);
        bucketRetirement(entry, verdict);
        retireTarget(bot, choice, entry, verdict, wasHeld);
        queue.delete(entry.id);
        if (wasHeld) {
          heldId = null;
          // Progress resets the per-target clock — see ENGAGEMENT_MAX_MS. Only a kill does.
          if (verdict === 'cleared') deadline = Date.now() + ENGAGEMENT_MAX_MS;
        }
      }

      if (!live.length) {
        // `detonated` is tested BEFORE the fall-through, and that ordering is the whole fix: a wave whose
        // only mob blew itself up has cleared:0 and lost:0, so it used to land on the `|| 'cleared'`
        // default and report the field won. The field WAS empty — that is what made the lie so durable —
        // but empty because the creeper spent itself, which is the opposite of the outcome asked for.
        // Ranked below `cleared` so a wave where the bot killed one and a second detonated still reads as
        // the partial success it was, rather than either extreme (Law 25).
        outcome = tally.cleared ? 'cleared' : tally.detonated ? 'detonated' : tally.lost ? 'lost' : 'cleared';
        break;
      }

      // ── THE DEAD-WAIT CLOCK, sampled here because this is the pass's one point where both bodies are
      // known live and ordered (see IDLE_STALL_MS for what it measures and why it is not the ceiling).
      // Against the CLOSEST live mob rather than the held one: `heldId` is null for the whole opening
      // stretch of a wave, and a clock that only runs once a target is held cannot see the case where
      // nothing was ever held because nothing ever arrived.
      // THE INVISIBLE CLOCK'S ONE TICK. Every live mob is offered to the meter each pass, handed the
      // DISTANCE this loop already computed — the gap only means anything at the instant the sign flips,
      // and a distance re-read afterwards is a different number. The reading rides on a pass the arm was
      // going to run anyway, which is the rule that keeps a fuse instrument from costing fuse. Unfiltered by species on purpose: anything without a `swell_dir` key falls out as unread
      // inside the meter, and a species test here would be a second place that knows which mobs have
      // fuses (Law 16).
      for (const e of live) fuseMeter.sample(bot, e.id, e.entity, e.distance);

      {
        const watched = live[0];
        const sample = {
          botAt: (bot.entity && bot.entity.position) || null,
          mobAt: (watched.entity && watched.entity.position) || null,
          mobHp: typeof watched.entity.health === 'number' ? watched.entity.health : null,
        };
        if (combatActivity(lastSample, sample)) idleSince = now;
        else if (now - idleSince >= IDLE_STALL_MS) {
          // `watched` is a refreshTarget result (orderQueue: Object.assign(target, { entry })), so the
          // distance is its OWN field — `lastDistance` lives one level down on `.entry` and reading it
          // here yields undefined. A `|| 0` on that made every dead wait in the fleet's history report
          // "at 0b" and write d:0 into the journal, which is both a defaulted missing field (Law 13) and
          // a distance the line never measured (Law 25). Split into horizontal and vertical because the
          // two have different repairs and the 3-D total cannot tell them apart: a fight the feet can
          // still close looks identical to one three blocks straight up, which is the failure this
          // warning exists to name.
          const mobAt = sample.mobAt, botAt = sample.botAt;
          const horiz = mobAt && botAt ? Math.hypot(botAt.x - mobAt.x, botAt.z - mobAt.z) : null;
          const dy = mobAt && botAt ? mobAt.y - botAt.y : null;
          const r2 = (n) => (n === null ? '?' : Math.round(n * 100) / 100);
          watcher.warn('battle_stations',
            `Dead wait: ${IDLE_STALL_MS / 1000}s with neither body moving and ${watched.name}#${watched.id} ` +
            `taking no damage at ${r2(watched.distance)}b (${r2(horiz)}b across, ${r2(dy)}b up) — this is not a slow ` +
            `fight, it is a fight that never opened. Abandoning to judge rather than holding the signal to ` +
            `the ${ENGAGEMENT_MAX_MS / 1000}s ceiling.`);
          outcome = 'stalled';
          break;
        }
        // Cloned, not referenced: `entity.position` is a live Vec3 mineflayer mutates in place, so
        // holding the object would compare a position against itself and read as motionless forever.
        lastSample = {
          botAt: sample.botAt ? sample.botAt.clone() : null,
          mobAt: sample.mobAt ? sample.mobAt.clone() : null,
          mobHp: sample.mobHp,
        };
      }

      // ── THE RECURSIVE GATE — re-asked every pass, idempotent: scanning the same world twice gives
      // the same result, so re-asking costs nothing and buys freshness (Invariant B). ───────────────
      //
      // Carrying nothing between passes — still the recursive gate, now with nothing between it and the
      // answer. `combat_planner.sensePlan` stood here and was deleted with the file: its ranking rule
      // had already reduced to "sort by distance" when the fifteen groups folded onto two tactics, and
      // `live` above is that exact ordering, rebuilt from live positions this pass. The seat was running
      // a SECOND sweep of bot.entities to re-derive an order this loop already had — no monster data is
      // derived anywhere but the commander (Law 16).
      //
      // ── THE QUEUE FOLLOWS THE COMMANDER'S FOCUS — rush one mob and ignore everything else, then
      // switch to the next ─────────────────────────────────────────────────────────────────────────
      //
      // This block used to run `pickTarget(live, heldId, TARGET_SWITCH_MARGIN)` — its own nearest-first
      // comparator with half a block of hysteresis, gated to the swing moment. That was a SECOND owner of
      // "which mob is being fought" (Invariant D), and since the crew landed it has not been the one that
      // decides anything: the gunner swings at what the board says. All this loop's held id still drives
      // is the CLAIM, the retirement and the engage/end lines — so leaving it on a different rule meant
      // the record said the bot fought one mob while the arm swung at another.
      //
      // Taking the focus makes the two agree by construction, and it deletes the thrash problem rather
      // than damping it: `mayRepick`'s commit window and the 0.5 b margin existed to stop a target question
      // asked dozens of times per swing from flipping between converging mobs, costing every swing to a
      // target change instead of a landed hit. A committed focus changes only when its mob leaves the
      // world, so there is nothing left to damp — which is why both functions were deleted in the same
      // edit rather than left dark beside their replacement (Law 16; their tombstone is above
      // `retirementVerdict`).
      //
      // FALLBACK IS THE HEAD OF `live`, NOT null: the focus can legitimately be absent for a pass — the
      // commander sweeps on its own tick and a mob enqueued here may not have been swept yet — and a wave
      // loop that held nothing would release its claims and re-take them every pass.
      const focus = crewBoard.readCommander().focus;
      const focusInQueue = focus && live.find((x) => x.id === focus.id) ? focus.id : null;
      const wantId = focusInQueue !== null ? focusInQueue : (heldId !== null && live.find((x) => x.id === heldId) ? heldId : (live.length ? live[0].id : null));
      if (wantId !== heldId) {
        if (heldId !== null) {
          const prev = queue.get(heldId);
          if (prev) retireTarget(bot, choice, prev, 'switched', true);
        }
        heldId = wantId;
        const entry = queue.get(heldId);
        const at = live.find((x) => x.id === heldId);
        tally.taken++;
        // ONE `engage` row per target taken, paired with the `end` row retireTarget writes. Reusing the
        // existing two kinds rather than inventing a `switch` kind means the reducer already reads a
        // multi-mob wave correctly — as a run of engagements with no gap between them, which is exactly
        // the property this feature has to be checked on.
        // `queuedIds` beside `queued` — the count alone cannot tell a bot fighting three skeletons from a
        // bot that re-took the SAME skeleton three times after it kited out and came back — two very
        // different fights that produce an identical tally. The ids separate them, and every id here
        // joins to the `mob` field on the strike rows, so "which swing hit which entity" is a lookup
        // rather than an inference.
        _life.engagedIds.add(entry.id);
        if (live.length > _life.maxConcurrent) _life.maxConcurrent = live.length;
        if (live.length > maxConcurrent) maxConcurrent = live.length;
        // Was THIS switch a handover FROM the commander, or the loop's own fallback? Recorded on the row
        // rather than derived later, because `live` and the focus are the two orderings the decision was
        // actually taken from and neither survives the pass. `closestD` beside `d` is what lets a reader
        // price the commitment without trusting the seat that made it.
        if (live.length > 1) {
          focusAudit.switches++;
          if (focusInQueue !== null && focusInQueue === heldId) focusAudit.switchedToFocus++;
        }
        // ── THE FIGHT OPENS ON THIS MOB ──────────────────────────────────────────────────────────
        // `focus` is the verdict the audit above is counting: did this take come from the commander's
        // focus or from this loop's own nearest-first fallback. `closest` stayed and stopped being a
        // verdict — under the focus tactic a take that is NOT the closest is the tactic working (an
        // archer preferred over a nearer zombie), so the gap rides beside it to price the commitment
        // rather than to judge it.
        //
        // The two positions this row used to carry are gone with the per-swing rows they existed to be
        // differenced against: the take→first-blow approach leg was measured by subtracting this point
        // from the first strike's, and there are no strike rows to subtract from any more.
        crewLog.post('battle_stations', 'engage', {
          subject: `${entry.name}#${entry.id}`,
          d: Math.round(at.distance * 100) / 100,
          focus: focusInQueue !== null && focusInQueue === heldId,
          closest: live[0].id === heldId,
          closest_d: Math.round(live[0].distance * 100) / 100,
          queued: live.length,
          weapon: choice.profile.name || null,
          hp: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
        });
        // THE `🎯 Target N` LINE THAT STOOD HERE IS DELETED — the seats report, not this file. It was a
        // second voice on a fact the COMMANDER already announces — `focus <mob> d=… why=…` on every pick
        // and `lost <mob>` on every drop — so two seats were narrating one decision and only one of them
        // is accountable for it (Law 16, Invariant D). It also posted per TAKE, and a wave that re-takes
        // the same mob repeatedly is exactly the case that bloats a trace fastest.
        // The `engage` journal row above is the machine-facing record of the same event and is unchanged;
        // nothing was lost with the prose.
      }

      const target = live.find((x) => x.id === heldId);
      const entry = queue.get(heldId);

      // The focus audit (see the `focusAudit` declaration). Only counted where the question exists: with
      // one mob in the queue the held one IS both the focus and the closest by construction, and folding
      // those passes in would dilute the ratio toward 100% with passes that could not have failed (Law 25).
      if (live.length > 1 && target) {
        focusAudit.passes++;
        if (focusInQueue === null) focusAudit.noFocus++;
        else if (focusInQueue === heldId) focusAudit.onFocus++;
        // The overhang is measured on every pass the crew is off the nearest body, whether that came from
        // the focus or the fallback — it prices where the bot's back was turned, and a fallback that
        // wandered costs exactly what a commitment that wandered costs.
        if (live[0].id !== heldId) {
          const over = target.distance - live[0].distance;
          if (over > focusAudit.offClosestB) focusAudit.offClosestB = over;
        }
      }

      // NOTHING IS ASKED HERE ANY MORE. The claim check and its yield branch stood at this line until
      // the mob claim was deleted — see the tombstone where the claim helpers were. A target that has
      // been taken is now fought, full stop, and the only path out of a pass is the tick below.
      //
      // THE `continue` THAT THE YIELD BRANCH USED IS ALSO GONE, and it is worth naming because it was the
      // second half of the fault: it re-entered the loop WITHOUT the pass tick, so the one branch that
      // achieved nothing was also the one branch with no brake, and the system ran hardest exactly when
      // it accomplished least. Every path through this loop now reaches the sleep.

      // ── THIS PASS NO LONGER FIGHTS. IT WAITS ONE TICK AND LOOKS AGAIN ─────────────────────────────
      //
      // What stood here was `await runCounter(...)` — the call that handed the whole body to an arm and
      // did not come back until that mob was dead, yielded or stuck. The arms are deleted, so the fight
      // is happening on the physicsTick underneath this loop whether or not this line runs.
      //
      // THE SLEEP IS THE PACE OF OBSERVATION, NOT OF THE FIGHT, and that inversion is the point. A sleep
      // out this far used to double the reaction time of whichever arm was running, since the arm's own
      // loop was gated on it. That argument is dead with the arms: nothing about the bot`s reaction time
      // passes through this line any more. The
      // driver corrects every 50 ms and the gunner swings every 50 ms regardless of how often this loop
      // wakes. One tick is chosen so the retirement and stall clocks below sample at the rate the seats
      // act at — sampling slower would hide a kill for a few frames, sampling faster would burn passes
      // re-reading a world that has not ticked.
      const PASS_MS = 50;
      await sleep(PASS_MS);
    }

    if (outcome === null) {
      const entry = heldId !== null ? queue.get(heldId) : null;
      watcher.warn('battle_stations',
        `Engagement ran the full ${ENGAGEMENT_MAX_MS / 1000}s on ${entry ? `${entry.name}#${entry.id}` : 'no held target'} ` +
        `without killing it (${passes} pass(es), ${queue.size} still queued, ${tally.cleared} cleared so far) — ` +
        `abandoning to judge (Law 13 stall).`);
      outcome = 'stalled';
    }
  }, () => {
    // The held target's `engage` row must always find its `end` row, including on the paths that break
    // out mid-fight (death, judge stop, stall) — an unmatched pair is an engagement the monitor reads as
    // still running (Law 8).
    if (heldId !== null && queue.has(heldId)) {
      bucketRetirement(queue.get(heldId), outcome || 'error');
      retireTarget(bot, choice, queue.get(heldId), outcome || 'error', true);
    }
  });
  return {
    outcome, tally, focusAudit, passes, queued: queue.size, dequeuedIds: [...dequeuedIds], maxConcurrent,
    killedEntityIds: [...killedEntityIds],
    disengagedEntityIds: [...disengagedEntityIds],
    entityNames: Object.fromEntries(entityNames),
  };
}

// ── THE SENTRY'S OUTCOME SIGNAL — every sentry exit reports which entity was killed or disengaged ────
//
// ONE shape from every sentry exit, including the ones where nothing fought (Law 10 — no implicit fields;
// Law 13 — never default a missing field at the reader). The sentry loop and the wave judge above it read
// `killedEntityIds` on every pass, so a path that returned a bare string would make the reader write
// `report.killedEntityIds || []` — a default at the consumer, which is exactly where a missing field stops
// being visible. Absent here means the empty array, and it says so.
//
// SENTRY ONLY, deliberately. Every other caller ignores what this API returns — only await_aggro reads
// it — so widening the shape for them would buy nothing and change a contract nobody asked to change
// (Law 16 — one route, and this is the sentry's).
function sentryReport(outcome, result) {
  return {
    outcome,
    killedEntityIds: result ? result.killedEntityIds : [],
    disengagedEntityIds: result ? result.disengagedEntityIds : [],
    entityNames: result ? result.entityNames : {},
    passes: result ? result.passes : 0,
  };
}

// engageThreat: the HANDOVER, stage 1 → stage 2. It receives the confirmed scan, takes the body over,
// suppresses the auto-torch reflex for the fight (rule 1 — a torch never swaps out the weapon), runs
// targetEngaged, releases every claim it raised + re-enables torches, then abandons the caller to
// recursive_judge exactly as the water-escape path does (Law 15 caller abandonment).
//
// IT OWNS THE WAVE; targetEngaged OWNS EACH TARGET. Since the engagement queue landed, the
// per-mob `engage`/`end` journal pair is written inside targetEngaged, once per target taken — so this
// function writes no engage row of its own, or a two-mob wave would report three engagements. What is
// still this seat's is everything raised for the DURATION of the wave: the torch suppression, the
// shield, the claims, the `engaging` latch and the spoils.
//
// `firstBoard` is the commander's section READ AT THE GATE, used for two things: the opening report and
// the seed of the queue — its `active` array is already the aggro-confirmed set for the wave.
async function engageThreat(bot, firstBoard, source) {
  engaging = true;
  _lastDeclineWhy = null;
  // Cleared where the wave BEGINS, not where it ends, for the reason the tally reset one screen down
  // gives: a buffer emptied only on the way out is a buffer that survives every path which never reaches
  // the exit (a throw, a death mid-wave), and the next wave would open holding the last one's lines.
  _waveMeterLines = [];
  survival.disableReflex('autoTorch');
  // THE SHIELD GATE that stood here is gone with the shield itself — shields are not yet in scope.
  // survival_instincts no longer carries the reflex or the three direct entry points, so there is
  // nothing left to gate; battle_stations keeps ownership of the engagement, and whatever re-adds a
  // shield re-adds its gate here.
  //
  // ── THE GUNNER IS ARMED FOR THE WHOLE WAVE, AT THIS SEAT AND NOT IN AN ARM ────────────────────────
  // Same placement argument the shield gate used to make and it is stronger here, because the thing being
  // armed is the FACING: an arm-level engage would leave the approach — the part of the fight no arm owns
  // — with no owner of the yaw at all, which is the state this whole split was built to remove. From here
  // the gunner holds the facing on the closest mob from the first pass of the wave to the last.
  //
  // It is armed unconditionally, with no tactic read. Asking which arm is about to run would be this file
  // deriving a decision it has not made yet (Invariant D), and the gunner's rule is the same for every
  // species anyway: face the nearest, swing what is in reach.
  gunner.engage();
  // AND THE DRIVER, ONE LINE LATER AND FOR THE IDENTICAL ARGUMENT. The approach is the part of the fight
  // no arm ever owned — an arm was entered once a mob was picked, so the walk toward it belonged to
  // nobody. Arming both seats at the wave boundary is what gives the whole engagement, approach
  // included, exactly one owner of the feet and one of the facing (Invariant D).
  //
  // Order matters here in the same way it matters in master_core: the gunner is armed first so the first
  // tick the driver runs already has a facing to press keys against, rather than steering off whatever
  // yaw the last job left.
  driver.engage();
  const first = firstBoard.engage;
  const startAt = bot.entity.position.floored();
  const choice = combatUtils.pickBestWeapon(bot);
  const hp = typeof first.entity?.health === 'number' ? `${Math.round(first.entity.health)}hp` : 'hp?';
  // Cleared at the START of every engagement, not merely when the mob id changes. A tally that outlives
  // its fight is the shape that let a dead bot's stats be reprinted for the next wave; the reset belongs
  // where the fight begins. Both arms, unconditionally — asking which one is about to run would be this
  // file re-deriving a tactic it has not picked yet (Invariant D).

  const confirmed = (firstBoard.active || []).length;
  // Read ONCE, here, and never re-read at report time. The lesson is rush.js's `weapon` field: a bot that
  // died mid-wave has nothing left to measure by the time the summary prints, so a report-time read
  // describes the corpse instead of the fight (Law 25).
  const waveHpAtStart = typeof bot.health === 'number' ? bot.health : null;
  watcher.summary('battle_stations',
    `⚔️ Engaging ${first.name} [${hp}] — (${firstBoard.engageReason}) at ${first.distance.toFixed(1)}b with ${choice.profile.name || 'fists'} (rung: ${choice.rung}, ${choice.profile.damage} dmg / ${choice.profile.cooldownMs}ms cooldown) — ${confirmed} confirmed of ${firstBoard.hostiles.length} hostile(s) tracked, from (${startAt.x},${startAt.y},${startAt.z}), source ${source || 'inline'}.`);
  let outcome = 'cleared';
  let result = null;
  // withCleanup, not a guard. The catch that stood beside this cleanup set `outcome = 'error'` and let
  // the wave close normally — so a defect arrived downstream as a fought-and-reported wave, and every
  // tally, retirement bucket and journal counter consumed the fabricated verdict as a real one
  // (Law 25). The cleanup below is why the shape is kept at all; the catch was never part of it.
  await withCleanup('battle_stations', 'wave teardown', async () => {
    result = await targetEngaged(bot, firstBoard, choice);
    outcome = result.outcome;
  }, () => {
    // ── THE BODY IS HANDED BACK STOPPED (Law 8) ─────────────────────────────────────────────────────
    // driveRun runs with `keepMoving: true` (the sprint ramp is spent once per fight, not once per leg),
    // so it deliberately does NOT release the controls when a leg ends — and nothing released them when
    // the ENGAGEMENT ended either. Invisible in the usual exit because that path abandons to
    // recursive_judge, which takes the body over; the sentry loop RETURNS instead, so an unstopped body
    // kept sprinting away from its post at full speed while await_aggro logged quiet passes with no
    // aggro throughout. Every later wave was then summoned next to a bot that was not there.
    //
    // This function owns the engagement, so this function stops the body — not driveRun, whose contract
    // is explicitly to hold.
    clearMotion(bot); bot.setControlState('sprint', false);
    // The LAST pass's crew events, posted before the three aggregates below and not after them. The loop
    // flushes at its own head, so whichever pass ended the wave — a break, the deadline, a throw — still
    // has its events sitting in the buffer when control arrives here. Ordering is the point: an event line
    // landing after the summary that closes its own engagement reads as a decision made after the fight.
    crewLog.flush();
    // The gunner is stood down in the SAME finally that stops the body, and for the same law: a gunner
    // still engaged after the wave keeps writing the facing at tick rate on the walk home, which does not
    // merely look wrong — it is a tick-rate writer nothing downstream knows about (Law 8). Reported before
    // it is cleared, because `disengage` blanks the tally it would otherwise be reporting.
    gunner.report();
    gunner.disengage(bot);
    // Same finally, same law, and the driver is released LAST because it is the seat holding the keys: the
    // clearMotion above is belt-and-braces for the paths where the driver never engaged, and this is the
    // owner actually letting go. A driver still engaged after the wave keeps pressing WSAD at 20 Hz on
    // the walk home, which is the same tick-rate-writer-nobody-knows-about failure as the gunner (Law 8).
    driver.report();
    driver.disengage(bot);
    // ── THE THIRD SEAT SPEAKS HERE TOO, AND HAD NO VOICE AT ALL UNTIL NOW ───────────────────────────
    // `commander.report()` was written when the seat landed and NOTHING EVER CALLED IT. It is the seat
    // that decides who is a threat, grants aggro inside 5 b, and decodes both signals the shield runs
    // on — and none of that reached the record. It was found by the commander's tag returning zero
    // lines from a run that should have produced them; the unread-index warning it carries could never
    // have fired (Law 6 — a decision nothing can inspect after the fact is hidden state).
    //
    // NOT DISENGAGED WITH IT, and that is the difference from the two seats above. The commander has no
    // engage/disengage switch by design (it sweeps whether or not a fight is open, so a mob that wanders
    // up mid-dig is seen), so its tally is reset by `report` itself and each line covers the span since
    // the last one — the fight plus the quiet before it. Stopping the sweep here would blind the bot the
    // moment a wave ended.
    commander.report();
    survival.enableReflex('autoTorch');
    engaging = false;
    // The latch is CONSUMED here when the fight itself ran through the death, because this function
    // routes it below (outcome 'died' → abandonToJudge) exactly as the gate would. Leaving it set would
    // make the next gate abandon a second time for one death — two routes, one event (Law 16).
    _diedSince = false;
    // ── THE WAVE'S OWN LINE ────────────────────────────────────────────────────────────────────────
    // It is NOT an `end` — those are per target and already posted (see targetEngaged) — because a
    // second `end` here would pair with nothing and inflate every engagement count downstream. It
    // answers the question only the wave can answer: how many mobs one arrival of battle_stations
    // actually dealt with, which is the whole point of the queue.
    //
    // IT IS THE LINE THE BENCH BREAKS ON. lanista runs in another process and cannot ask this seat
    // anything; two of its three wave completions are read off the server, and this is the third — the
    // one covering the case the server structurally cannot see, a mob that walks out of tracking range
    // while alive and still tagged, so the field never empties and the wave burns its whole ceiling.
    // `combat_lens.completedBattlesSince` reads it back off the trace.
    //
    // The prose summary below carries the same tallies for a human. Two renderings of one fact is
    // normally the redundancy Law 16 forbids — it is admitted here because the audiences differ in kind
    // (Law 26): the machine needs a form it cannot misparse, the reader needs a sentence, and the
    // alternative is a bench regexing an English summary whose wording is free to change.
    crewLog.post('battle_stations', 'wave', {
      outcome, source: source || null,
      taken: result ? result.tally.taken : 0,
      cleared: result ? result.tally.cleared : 0,
      lost: result ? result.tally.lost : 0,
      dequeued: result ? result.tally.dequeued : 0,
      queued: result ? result.queued : null,
      passes: result ? result.passes : 0,
      hp: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
      // The wave's OWN entry health, so "what did this wave cost" is one subtraction rather than a join
      // across engage lines. Captured at engageThreat's first line, before a single pass has run, which
      // is the only reading that describes the bot that walked in.
      hp_open: waveHpAtStart == null ? null : Math.round(waveHpAtStart * 10) / 10,
      // Peak simultaneous hostiles across the wave, and the aggro-confirmed count it opened on. Two
      // different numbers: the second is what the gate decided from, the first is what actually showed
      // up, and a wave where they diverge is one the scanner opened too small.
      peak: result ? result.maxConcurrent : (firstBoard.active || []).length,
      confirmed,
    });
    if (result) {
      // Distance rides on every major line. `nearestHostileDistance` re-senses rather than replaying the
      // engage line's opening distance — a wave report that quoted the range the fight STARTED at would
      // answer a different question than the one the reader is asking at the end of it (Invariant B).
      const dNow = nearestHostileDistance();
      watcher.summary('battle_stations',
        `🏁 Wave ${outcome}: ${result.tally.taken} target(s) taken, ${result.tally.cleared} cleared, ` +
        `${result.tally.lost} lost, ${result.tally.dequeued} dequeued, ` +
        `${result.queued} still queued over ${result.passes} pass(es). ` +
        `Nearest hostile now ${dNow == null ? 'none in range' : `${dNow.toFixed(1)}b`}. ` +
        // ── THE FOCUS AUDIT, PRINTED EVEN WHEN IT IS EMPTY ─────────────────────────────────────────
        // A single-mob wave has no focus question in it, and saying so is the point: a silent line would
        // read as "the handover was checked and held" on exactly the waves where it was never exercised
        // (Law 25). Two numbers, two different findings: the RATIO is whether the commander and the wave
        // loop agreed about who is being killed, and the OVERHANG is what that agreement cost in distance
        // walked past a nearer body. A high overhang is not a fault under this tactic — it is the price
        // of committing to an archer, and the reader needs it to decide whether the price was worth it.
        (result.focusAudit.passes === 0
          ? 'Focus: never in question (one mob at a time all wave).'
          : `Focus: held the commander's pick on ${result.focusAudit.onFocus}/${result.focusAudit.passes} multi-mob pass(es)` +
            ` (${result.focusAudit.noFocus} with no focus in queue)` +
            `, worst overhang past the nearest ${result.focusAudit.offClosestB.toFixed(2)}b` +
            `; ${result.focusAudit.switchedToFocus}/${result.focusAudit.switches} switch(es) were handovers.`));
    }
    // ── AND THE WAVE'S METER LINES, HERE AND NOWHERE ELSE ─────────────────────────────────────────────
    // Posted AFTER the wave line so a reader meets the outcome first and the instrumentation under it
    // (Law 24: lead with the decision). Outside the `if (result)` because a wave that threw still
    // measured whatever it measured before it threw, and that is the wave most worth reading.
    for (const line of _waveMeterLines) watcher.summary('battle_stations', line);
    _waveMeterLines = [];
  });
  // ── THE SPOILS — battle_stations collects drops after winning a fight ───────────────────────────
  // Mob drops (string, bone, rotten flesh) arrive by fighting what comes at the fleet rather than by
  // hunting it (there is no active monster-hunting job). This line is the whole of that supply route.
  //
  // GATED ON 'cleared', AND ONLY THAT. The other outcomes are different events, not near-misses:
  //   died     — no body to collect with, and the corpse's own drops are not ours to chase.
  //   stalled/error — nothing is confirmed dead, and walking a leash around a live hostile is how a
  //              disengage becomes a second fight.
  //
  // AFTER the finally on purpose: claims released, shield down, controls cleared, `engaging` false — the
  // body collecting drops is a body at rest (Law 8). That also makes collectNearby's own battleStations
  // call a REAL gate: a hostile arriving mid-collection engages properly instead of being swallowed by
  // the re-entrancy guard. Interrupted collection is correct — the drop keeps, the fight does not.
  //
  // ── THE ONE TURN OF THE CYCLE THAT COSTS NOTHING, AND ITS JUDGE ────────────────────────────────────
  // The spoils close a cycle in the call graph: navigator → this gate → collectNearby → goTo → navigator
  // (Auren_Flow Part III). It cannot spin forever on its own, because every turn needs a fight and a
  // fight needs a mob, and a mob that dies is spent — the supply is finite and the cycle drains it.
  //
  // EXCEPT for one path, and it is the whole reason this judge exists. A mob that walks out of tracking
  // range is `dequeued` — retired ALIVE. When the last one leaves that way the wave still reports
  // 'cleared', because the outcome line ends `: 'cleared'` and a pure-dequeue wave falls
  // through to that default. So the spoils fire, the bot walks at drops it never reaches, the same mob
  // wanders back, and the cycle turns again having killed nothing. Nothing is consumed, so nothing stops
  // it — and nothing SEES it either: every engageThreat above the deepest one is parked forever awaiting
  // its orphaned collectNearby, so no signal reaches recursive_judge while the cycle spins. That is the
  // exact blind spot signal_sequencer names in its own header (it checks arrivals; here there are none).
  //
  // WHY THE COUNT SURVIVES, since it looks like it should not: portable_judge's history is wiped by
  // recursive_judge.reset() on every arrival — and during this loop there are no arrivals. The same
  // silence that blinds the sequencer is what lets this counter run.
  //
  // Gated on `tally.cleared === 0` so a wave that actually KILLED something never counts: that turn spent
  // a mob and the supply argument covers it. Only the free turn is judged.
  //
  // 'mob_reengage' joins SUBLOOP_BUCKETS for the oscillation exemption alone — alternating between two
  // mobs is fine. Two mobs trading the field A-B-A-B is a bot working a crowd, not a stall; three
  // consecutive waves that retire THE SAME id alive is the ping-pong, and STALL_THRESHOLD is
  // already 3. THE RETURN BELOW DOES NOT ABANDON, and that is this branch's whole contract now that it is
  // the only portable_judge caller left in the file: the checkpoint returning false means the judge has
  // ALREADY routed a fresh chain to recursive_judge, so abandoning here would put two live signals with
  // two plans on one event. signal_bus does not catch it — it compares source AND target, and the two
  // routes carry different sources. Nothing is dropped: the judge holds the signal and owns the replan,
  // and the caller's promise never resolving is ordinary Law 15 abandonment paid once instead of twice.
  // THE SENTRY IS EXEMPT, and it is not a courtesy: routing to recursive_judge is the one connection
  // sentry mode exists to remove (see the sentry branch below), so a watch that tripped this would be
  // wired into the planning recursion by the very instrument meant to protect it. It also cannot NEED it
  // — a sentry holds no spoils path, so the cycle this judges never turns for it. Same boundary
  // releaseJobClaim keeps shut for the same reason (Law 26).
  if (source !== 'sentry' && outcome === 'cleared' && result && result.tally.cleared === 0 && result.dequeuedIds.length) {
    const key = `mob ${result.dequeuedIds.slice().sort((a, b) => a - b).join(',')}`;
    if ((await portableJudge.checkpoint('mob_reengage', key)) === false) {
      watcher.warn('battle_stations',
        `Disengage/re-engage loop on ${key} — three waves running that retired it alive without a kill. ` +
        `Portable judge routed to recursive_judge; not collecting spoils and not routing again.`);
      return;
    }
  }
  // ── AND FROM EVERY CALLER, LOCOMOTION INCLUDED ────────────────────────────────────────────────────
  // A `source !== 'locomotion'` gate stood here and is gone. It was written against a refusal that no
  // longer exists: signal_bus once held a (source, target) duplicate slot that KILLED the second goTo, so
  // a nested invocation left the first abandoned and the second refused — zero live signals, and the bot
  // went inert until something else killed the stall. That slot moved to signal_sequencer as a monotonic
  // stamp on the main chain; the bus now refuses nothing.
  //
  // WHAT MAKES THE NESTING SURVIVABLE, in the order it happens — verify this before trusting it:
  //   1. `collectNearby` raises `goTo`. locomotion_dispatcher's single `pending` slot is held by the
  //      navigator invocation this gate fired from, so it warns "still pending — treating as abandoned
  //      and replacing" and takes the slot. The outer invocation's promise never resolves.
  //   2. The inner chain routes, walks, and resolves collectNearby's await. Nothing refuses it.
  //   3. This function's tail abandons the caller to recursive_judge — ONCE. The outer navigator's step
  //      loop is parked at its own `await battleStations(...)` inside this stack and never resumes, so it
  //      cannot walk a path it planned before the fight (Invariant B).
  // Exactly one live chain at the end, and the frozen outer line is the one being discarded: that is Law
  // 15 caller abandonment, not a Law 4 breach. It holds only because 'cleared' from a non-sentry caller
  // ALWAYS reaches abandonToJudge with no early return in between. That was pinned by a bench that is now
  // deleted, so it is unasserted; an early return added between those two points breaks Law 15 silently
  // and this comment is the only warning.
  //
  // THE WRONG TURN, and it is the obvious one: re-adding the gate because the dispatcher warns on every
  // won fight with drops. That warn is the designed abandonment announcing itself, not a symptom.
  //
  // The water escape stays gated for locomotion callers (performDig's LOCOMOTION_DIG_TAGS) and that is
  // not an inconsistency: escapeWaterToLand is raised to let a DIG proceed, and a walking bot has no dig
  // to protect — so there the nested goTo buys nothing. Here it buys the spoils, which are the fleet's
  // only source of mob drops (see the ruling above).
  //
  // ── EXCEPT FOR THE SENTRY, WHICH HAS NOTHING TO SPEND THEM ON — sentry mode skips drop collection so
  // arena runs stay fast ─────────────────────────────────────────────────────────────────────────────
  //
  // The reasoning above is an argument about the FLEET: spoils feed the crafting chains, so a won fight
  // that leaves its drops on the ground costs the economy. A sentry has no economy. It holds no job, no
  // magnet and no chain — this file already says so twice for two other decisions ("a sentry holds no
  // spoils path" at the re-engage judge, and releaseJobClaim's early return), so this branch is the code
  // catching up to a claim two of its own comments already made.
  //
  // WHAT IT COSTS THE BENCH TO KEEP: a walk per cleared wave, at the one moment the ladder is trying to
  // re-place the body on its control cell for the next wave. The collector's goTo moves the bot OFF that
  // cell, and the ladder then teleports it back — so the walk is not merely slow, it is undone.
  if (outcome === 'cleared' && source === 'sentry') {
    watcher.summary('battle_stations',
      `🧺 Spoils: SKIPPED — a sentry has no chain to feed them to, and the walk would move the body off ` +
      `the bench's control cell. ` + _dTail());
  } else if (outcome === 'cleared') {
    const { collectNearby } = require('@api/drop_collector.js');
    const spoils = await collectNearby(bot);
    const dSpoils = nearestHostileDistance();
    watcher.summary('battle_stations',
      `🧺 Spoils: picked up ${spoils.picked_up} of ${spoils.total_found} drop(s)` +
      `${spoils.out_of_reach ? `, ${spoils.out_of_reach} out of reach` : ''}` +
      `${spoils.no_route ? `, ${spoils.no_route} with no route` : ''}` +
      `${spoils.left ? `, ${spoils.left} left (window closed)` : ''}` +
      `${spoils.canopy_skipped ? `, ${spoils.canopy_skipped} perched` : ''}. ` +
      `Nearest hostile ${dSpoils == null ? 'none in range' : `${dSpoils.toFixed(1)}b`}.`);
  }
  // ── WHICH ENTITY DIED, AND WHICH WALKED — ON EVERY EXIT, NOT ONLY FOR THE SENTRY ────────────────────
  // Every path that drops to recursive_judge needs the same entity-identifying variables in its readable
  // string, or the judge eventually kills the bot for looping.
  //
  // THIS IS A LOOP-DETECTION FIX, not a logging nicety, and that is why it is built here rather than
  // inside the sentry branch. recursive_judge keys its contiguous count on the `readable` STRING
  // (addOutcome(from, success, readable)). The abandon line at this function's tail used to read
  // `battle_stations: engagement cleared — replanning from current state` — byte-identical for every
  // fight — so five consecutive WINS against five different mobs presented to the judge as one outcome
  // repeated five times, hit KILL_THRESHOLD, and halted a bot that was making perfect progress. The
  // entity id is the only thing in a fight that differs between two fights; without it the judge cannot
  // tell progress from a loop, which is its one verb (Law 11).
  //
  // Named, not counted: `cleared×1` twice in a row is still two identical strings. `zombie#42` and
  // `zombie#77` are not.
  const entityNames = result ? result.entityNames : {};
  const nameEntities = (ids) =>
    (ids && ids.length ? ids.map(id => `${entityNames[id] || 'entity'}#${id}`).join(', ') : 'none');
  const killedText = nameEntities(result && result.killedEntityIds);
  const disengagedText = nameEntities(result && result.disengagedEntityIds);
  const entitiesText = `killed: ${killedText}; disengaged: ${disengagedText}`;

  // (S) Sentry = report the outcome UP, never abandon. abandonToJudge is the one line that would wire the
  // sentry loop into the planning recursion — the exact connection sentry mode exists to remove.
  // Returning the report lets await_aggro read it and keep watching on its own terms. Checked before the
  // yield branch so a sentry yield also returns rather than silently resuming a task the sentry bot does
  // not have.
  //
  // The sentry gets the ids as DATA rather than prose, because it decides on them: a wave completes when
  // an entity resolves — there is no wave timer, only completion of the battle — and a judge that had to
  // parse the sentence above would be re-deriving a fact the performer already knew (Law 25). Same fact,
  // two registers — the string for the loop detector, the array for the caller.
  if (source === 'sentry') {
    watcher.summary('battle_stations',
      `Engagement ${outcome} — ${entitiesText}. ` +
      `Returning to the sentry loop (its own judge owns the replan decision). ` + _dTail());
    return sentryReport(outcome, result);
  }
  // ── THE 'stuck' OUTCOME WENT WITH THE ARMS ──────────────────────────────────────────────────────────
  // A branch stood here for the one outcome only a COUNTER could produce: an arm returning false, meaning
  // portable_judge had already routed a fresh chain and this seat must return rather than route a second
  // for the same event. There are no arms, nothing sets that outcome, and a branch on an unreachable
  // value is a route that can only ever mislead a reader about what this function can return (Law 16).
  //
  // THE RULE IT ENFORCED IS NOT LOST — it moved with its one remaining owner. `mob_reengage` above is now
  // the only portable_judge caller in this file, and it carries the same "judge already routed, return
  // without abandoning" clause inline. One judge exit, at the one place that can reach the judge.
  // (A) THE YIELD RETURN IS GONE WITH THE CLAIM IT SERVED. It existed so a bot that lost a mob to a peer
  // resumed its task instead of abandoning to the judge and looping back into the same yield. No outcome
  // can be a yield any more — nothing in this file can decline a mob — so the branch was a route that
  // could only ever mislead a reader about what this function returns (Law 16).
  watcher.summary('battle_stations', `Engagement ${outcome} — ${entitiesText} — abandoning caller to recursive_judge for replan. ` + _dTail());
  // The ids ride IN the readable, because the readable is what the judge counts on (see the block above
  // the sentry branch). Two consecutive wins now carry two different strings and the contiguous count
  // resets; two consecutive failures against the SAME mob still carry the same string and still climb to
  // the kill, which is the loop the threshold exists to catch (Law 11 — the judge detects a gap that
  // stops shrinking, and the entity id is what says whether it shrank).
  return abandonToJudge(`battle_stations: engagement ${outcome} (${entitiesText}) — replanning from current state`);
}

// Law 15 API, called inline by executors and locomotion at loop boundaries. Its ONE remaining job is
// the combat gate — the blanket water gate that used to live here was retired in favour of a precise
// dig-only escape at the dig primitive (performDig → escapeWaterToLand). Returns immediately when
// nothing is wrong; on a threat it takes over and never returns (abandons).
//
// `source` was vestigial after the water gate was removed; it is load-bearing again. 'sentry' means the
// caller is the sentry loop, which owns its own judge — so the engagement RETURNS its outcome instead of
// abandoning to recursive_judge. Every other caller (undefined, 'locomotion') keeps the abandon exactly
// as before, so no existing call site changed.
//
// THE WHOLE "CAN I FIGHT, AND SHOULD I" DECISION LIVES HERE — body checks included; the scanning logic
// belongs in battle_stations rather than standing alone or living in the sentry, and the inline gate
// scans for threats at the moment of deciding whether it can fight. A caller that pre-checks the body
// before calling is a SECOND implementation of this gate's own decision (Law 16), and it cannot stay in
// step — the sentry watch once carried exactly that duplicate. The gate is also where the checks belong
// on the merits — sensing at the moment of deciding is Invariant B, whereas a caller's pre-check is by
// definition read before the decision it feeds.
async function battleStations(bot, source) {
  // Re-entrancy guards. A sentry caller gets the report shape here too — not because the sentry loop can
  // reach them (it awaits each pass, so it never overlaps itself) but because these are the only two exits
  // that could hand it a bare `undefined`, and one `undefined` reaching a reader that indexes
  // `.killedEntityIds` is a crash in the one mode that has no judge above it to recover (Law 13).
  if (escaping) return source === 'sentry' ? sentryReport('busy_escaping', null) : undefined;
  if (engaging) return source === 'sentry' ? sentryReport('busy_engaging', null) : undefined;

  // ── DEATH, FIRST AND BEFORE THE BODY CHECK ────────────────────────────────────────────────────────
  // Ordered above the `no_body` return deliberately: mineflayer nulls bot.entity between death and
  // respawn, so a death caught inside that window would be reported as "no body" and the caller would
  // resume its task on the corpse's plan. The latch survives the window; a health read does not.
  //
  // The old line here RETURNED 'died', which is the bug this fixes: a bare return is what every gate does
  // when there is nothing to fight, so an executor read it as "field clear, carry on" and kept mining a
  // vein forty blocks from where the bot now stood (Law 25 — 'died' answered a different question
  // truthfully while misleading the caller completely).
  if (_diedSince || (bot && typeof bot.health === 'number' && bot.health <= 0)) {
    const edge = _diedSince;
    _diedSince = false;
    // Sentry owns its own judge (see engageThreat's sentry branch) and does NOT respawn here: the watch
    // loop decides what a death means for a watch, and clicking the button underneath it would move a
    // body the arena director placed. It gets the verdict; the decision stays its own.
    if (source === 'sentry') {
      return sentryReport('died', null);
    }

    // ── CHECK, THEN ROUTE — battle_stations only checks whether the bot is dead and routes to the judge;
    // the planner that acts first controls spawning ──────────────────────────────────────────────────
    //
    // Two things happen here and no third. The body is ALREADY STOPPED — master_core runs with
    // `respawn: false`, so the chain that was running is inert by physics rather than by a check arriving
    // in time (Law 13). And reaching this line means the stale line came back through the gate, the one
    // moment it can be ended: the abandon discards it and the fresh chain replaces it, so exactly ONE
    // signal exists across the transition (Law 4 — the reason auto-respawn was wrong).
    //
    // The longer path (judge → job_board's respawn planner → respawn_executor clicks) is the correct one:
    // the same planner→dispatcher→executor route every other job takes, so ONE place decides what a dead
    // bot does instead of two.

    // The watchdog may already own this death (see DEATH_GATE_GRACE_MS). If it does, this caller is a
    // straggler arriving after recovery started, and routing again would put two chains on one death
    // (Law 4). Freeze it exactly as abandonToJudge would, and say so rather than logging a second
    // "abandoning" line that reads like a second recovery.
    if (_deathRouted) {
      watcher.warn('battle_stations',
        'Died — a judge chain for this death already exists (the watchdog raised it), so this straggler line ' +
        'is discarded without routing again. One death, one signal.');
      return new Promise(() => {});
    }
    if (_deathWatchdog) { clearTimeout(_deathWatchdog); _deathWatchdog = null; }
    _deathRouted = true;

    watcher.warn('battle_stations',
      'Died — abandoning the caller to recursive_judge. The plan that got the bot killed dies with the line ' +
      'that held it (Law 15); the board decides what happens next, and the body stays down until it does.');
    return abandonToJudge('battle_stations: bot died — replanning from current state');
  }

  // Law 25, and a live falsehood before this line existed: a corpse with nothing nearby fell straight
  // past the scan and returned undefined, which every caller reads as "nothing to fight" — true about
  // the field and false about the body.
  if (!bot || !bot.entity || !bot.entity.position) {
    watcher.warn('battle_stations',
      'No body — the gate was called on a bot with no entity or no position, so nothing could be scanned. ' +
      'Returning `no_body` rather than falling through: an empty return reads as "nothing to fight", which ' +
      'is true about the field and false about the body (Law 25).');
    return source === 'sentry' ? sentryReport('no_body', null) : 'no_body';
  }

  // COMBAT gate — fires for EVERY caller including locomotion (pursuit is a movement concern). The fight
  // itself is Law 4-safe (raw control state, no goTo, no signal), which is what lets the navigator await
  // this from inside its own loop — but the SPOILS branch after a win is not; see the section header
  // above COMBAT. On a threat this takes over and never returns (abandons the caller to judge); with
  // nothing to fight it returns and the caller proceeds.
  // READ, NOT SCANNED — one main scanner for monsters; all monster data comes from the commander. This
  // line used to call threat_scanner's full sweep — raycast per hostile — on every gate call, which is
  // every checkpoint of every job in the fleet. The commander swept this same tick and the verdict is
  // already on its board.
  const scan = crewBoard.readCommander();
  if (scan.engage) { releaseJobClaim(source); return engageThreat(bot, scan, source); }
  // ── THE ROW FOR A PASS WHERE NOTHING HAPPENED — an ambiguous "not sure what happened" is not an
  // acceptable answer for why a gate declined to fight ─────────────────────────────────────────────
  // ── A DECLINE IS RECORDED WHEN IT CHANGES, NOT WHEN IT REPEATS ──────────────────────────────────
  // A gate that DECLINES to fight looks identical in every other artifact to a gate that was never
  // called — the arena stream shows a bot standing still either way. So the refusal has to name itself.
  //
  // IT USED TO NAME ITSELF ON EVERY PASS, into a per-decision sidecar record where volume was the point.
  // On the trace it cannot: this gate is called at every checkpoint of every job in the fleet, and one
  // soak logged 819 declines for a single bot. That is the per-step logging Law 5 removed, and it would
  // bury the three lines a reader is here for.
  //
  // A decline that repeats is ONE state, not eight hundred events. Posting on the CHANGE keeps the whole
  // of what a reader acts on — that the gate is refusing, and which of the three reasons is refusing it —
  // at a handful of lines per run. What is genuinely lost is the census: "how many times" and "against
  // how many distinct mobs" are no longer answerable, and the per-mob geometry that priced the aggro
  // cylinder (both axes, the radius each mob was judged against, the block a sightline stopped on) is
  // gone with the record that held it. That is a real measurement retired, not one relocated.
  if (scan.hostiles && scan.hostiles.length) {
    // `engageReason` is NULL whenever nothing was engaged — it names the regime that WON, so on a decline
    // it carries nothing. The reason is derived from the per-mob verdicts the commander already filled in.
    const self = bot.entity.position;
    const inRange = scan.hostiles.filter(h => withinAggroRange(self, h.position, h.name));
    const why = !inRange.length ? 'out_of_aggro_range'
      : inRange.some(h => h.aggroed) ? 'aggroed_but_not_selected'
      : 'no_sightline';
    if (why !== _lastDeclineWhy) {
      _lastDeclineWhy = why;
      // The nearest hostile only. The commander hands both its lists back nearest-first, and on a wave of
      // six the mob that explains the decline is the closest one. `dh`/`dy` because the gate judges the
      // two axes SEPARATELY (architect_config's cylinder) and a single 3-D distance cannot say which one
      // refused the mob: a skeleton far across and high up reads identically to one the same straight-line
      // distance away on flat ground, and those two demand opposite fixes.
      const h = scan.hostiles[0];
      crewLog.post('battle_stations', 'declined', {
        subject: `${h.name}#${h.id}`,
        why, source: source || null,
        d: Math.round(h.distance * 100) / 100,
        dh: Math.round(Math.hypot(h.position.x - self.x, h.position.z - self.z) * 100) / 100,
        dy: Math.round((h.position.y - self.y) * 10) / 10,
        // The radius this mob was actually judged against, carried ON the line rather than looked up by
        // the reader — a per-species table copied into a lens is the second definition of "15" that
        // architect_config's header names as the regression to watch (Law 16), and carrying it keeps an
        // old line readable after the table is retuned.
        r: aggroRangeFor(h.name), ry: AGGRO_VERTICAL_RANGE,
        seen: scan.hostiles.length,
        ...(h.blockedBy ? { blocked_by: h.blockedBy.name } : {}),
      });
    }
  }
  // The quiet pass, stated rather than implied. Every other caller still falls off the end into
  // `undefined` ("nothing to fight, carry on") — unchanged. The sentry gets the same shape it gets from
  // every other exit, because the alternative is `(await battleStations(...)) || 'clear'` at the reader,
  // and a caller that manufactures the outcome its API declined to state is the reader deciding what
  // silence meant (Law 13 — never default a missing field; Law 25 — the verdict is the performer's).
  if (source === 'sentry') return sentryReport('clear', null);
}

// ── combatCheckpoint — THE GATE A PRIMITIVE CALLS ───────────────────────────────────────────────────
// The concern with an inline gate inside primitives is recursion; the fix is to check whether the gate
// is already in battle_stations and bypass the inline check when it is — every movement and action
// primitive carries the inline check, and callers no longer need their own.
//
// The recursion guard was already here — `engaging`/`escaping` at the top of battleStations have
// returned early since the beginning. What was missing is the OTHER half: a primitive runs thousands of
// times where an executor runs once, so the same gate that costs nothing per plot boundary costs a full
// threat scan per block placed. This function is both halves in one door.
//
// WHY IT EXISTS AT ALL. The gate's lifecycle was bound to a STEP, not to TIME: navigator polls at the
// top of each path step, drop_collector at the top of each collection iteration. A `dig_through` step is
// seconds long and nothing polls inside one — a skeleton can close from well outside aggro range to
// point-blank over several arrows and several seconds while the body digs, every damage line reading
// `aggro✓`, and the gate never called once. The same failure shape is in voxel_scan_throttle's header;
// the fix built there (a 500 ms poll) covers searches and scans but not digs or drive legs. This is that
// same poll, moved to where the operation actually is (Law 16 — one mechanism, extended).
//
// ONE CLOCK FOR THE WHOLE PROCESS, and that is the part a per-call pacer cannot do. voxel_scan_throttle
// closes over `lastCombatAt` per instance, which is right for one long scan and wrong for a hundred short
// digs: each new pacer starts its clock fresh and none of them ever fires. Module scope here means an A*
// that just polled buys the first dig after it, and a hundred fast digs still poll ten times a second at
// most. One writer, no caller can set it (Law 6).
//
// IT STILL NEVER RETURNS ON A THREAT. battleStations abandons its caller to recursive_judge (Law 15), so
// a dig that meets a hostile has its promise dropped and the whole stack above it is discarded — that is
// the intended behaviour and it is now reachable from far deeper than before. The wrong turn is "fix" it
// with a timeout or a resolve-anyway: a dig that resumes after the body has been dragged into a fight is
// operating on a block the bot no longer stands next to (Invariant B).
const CHECKPOINT_MS = 500;
let _lastCheckpointAt = 0;

// `opts.before` — RELEASE WHAT THE CALLER IS HOLDING, and it is not optional decoration. A primitive that
// presses a control cannot clean up after this call: on a threat the promise never settles, so a
// `finally` in the caller NEVER RUNS and whatever it was holding stays held. driveRun presses `forward`;
// without this hook a bot dragged into a fight mid-leg would walk into it with the key still down, and the
// only thing releasing it would be the fight's own control management — an owner cleaning up someone
// else's state, which is the gap Law 8 names. Called only on the pass that actually polls, so a leg pays
// it twice a second rather than every tick.
async function combatCheckpoint(bot, source, opts) {
  // The bypass, and it is the whole reason a primitive may carry this. Combat's own arms drive, retreat
  // and dig through this same code; without it the first rush leg would re-enter the gate that raised it.
  // `escaping` covers the water escape for the same reason.
  if (engaging || escaping) return;
  const now = Date.now();
  if (now - _lastCheckpointAt < CHECKPOINT_MS) return;
  _lastCheckpointAt = now;
  if (opts && opts.before) opts.before();
  return battleStations(bot, source);
}

module.exports = {
  battleStations, combatCheckpoint, CHECKPOINT_MS, escapeWaterToLand, armDeathWatch,
  combatActivity, IDLE_STALL_MS, IDLE_MOVE_EPSILON,
  // The strike latch's read side. Exported for the commander's reactive aggro model and nothing else:
  // this seat owns the damage event, the aggro verdict is the commander's, and the fact has to cross
  // between them somehow. A reader is the narrow way to do it — it exposes the measurement without
  // exposing the state, so no second module can arm or clear the latch (Invariant D).
  struckWithin,
  // ── THE QUEUE INTERNALS ARE NO LONGER EXPORTED ─────────────────────────────────────────────────────
  // `enqueue, admitAggro, orderQueue, refreshTarget, retirementVerdict` were exported for one consumer —
  // the bench that asserted them — and that bench is deleted. (`pickTarget` and `mayRepick` were on that
  // list too and no longer exist at all; see their tombstone above.) They had no
  // production caller then and must not acquire one now: the queue is the engagement's state (Invariant
  // D), and a second module reaching into it would be a second owner of who the bot is fighting. An
  // export kept alive for a caller that no longer exists is a doorway nobody is watching.
  KILL_CONFIDENCE_RANGE, ENGAGEMENT_MAX_MS,
  BLAST_CENTRE_RADIUS, BLAST_ID_STALE_MS, DETONATION_ATTRIBUTION_MS,
};
