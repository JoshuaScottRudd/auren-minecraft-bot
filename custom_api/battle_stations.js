'use strict';

// fragment: battle_stations — inline emergency hook every executor and the navigator move loop
// awaits at loop boundaries (Law 15 API). Owns the COMBAT gate (engageThreat).
//
// Four stages: TARGET_CONFIRMED (threat_scanner's raycast) → TARGET_ENGAGED (the engagement queue)
// → TARGET_COMBAT (arithmetic on the live entity) → TARGET_CLEARED (per target, then the wave).

const watcher = require('@kernel/watcher');
const Vec3 = require('vec3');
const { sleep } = require('@utils/fragment_utils');
const { routeToJudge } = require('@utils/signal_utils');
const { canLandStrike } = require('@utils/movement/combat_movement');
const { clearMotion } = require('@utils/movement/motion_primitives');
const combatUtils = require('@utils/combat_utils');
// Owns the pass boundary events group by, and the flush.
const crewLog = require('@api/crew_log');
// Fuse arithmetic, repel band and archer calculator belong to driver/gunner (Law 16).
// PORTABLE JUDGE: the wave-lifecycle judgment.
const portableJudge = require('@kernel/portable_judge');
const driver = require('@api/driver');

// Creeper's own fuse, read off `swell_dir`.
const fuseMeter = require('@api/combat_counters/fuse_meter');
const survival = require('@locomotion/survival_instincts');
const gunner = require('@api/gunner');
// Voice only; monster data arrives on the board.
const commander = require('@api/commander');
// Reads the commander's section, writes none (Law 16).
const crewBoard = require('@api/crew_board');
const { withCleanup } = require('@utils/external_library_guard');
const {
  aggroRangeFor, withinAggroRange, AGGRO_VERTICAL_RANGE,
} = require('@thinking/architect_config');

// ─────────────────────────────────────────────────────────────────────────────
// DEATH — on death, drop the signal to recursive_judge and make a fresh plan.
// ─────────────────────────────────────────────────────────────────────────────
// Sits at the gate (Invariant D), runs before the scan (Law 13).
//
// Event latch, not health poll (Law 26, Invariant B).
let _diedSince = false;

// Watchdog for a death the gate never reaches. Routes through routeToJudge (Law 16).
const DEATH_GATE_GRACE_MS = 5000;
let _deathWatchdog = null;
// Law 4: whichever path routes first owns this death; the other freezes its caller.
let _deathRouted = false;

// LIFE LEDGER — running total for the current life, reset on spawn (Law 8, Law 26).
// `engagedIds` is a Set of ids (Law 25).
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

// STRIKE LATCH — this body's own "I was just hit", published for the aggro model. { at, byId } or
// null. Written by the damage line, read by the commander through `struckWithin`.
// Cleared on spawn with the rest of the life ledger (Invariant B).
let _struck = null;

// struckWithin(ms) → { at, byId } if this body took damage inside the window, else null.
// A reader, not a subscription (Invariant B). Returns the row, not a boolean — `byId` is half the fact.
function struckWithin(ms) {
  if (!_struck) return null;
  return (Date.now() - _struck.at) <= ms ? _struck : null;
}

// WHO ACTUALLY HIT IT — the server's own answer (Law 16). Raw `sourceDirectId` 0 = no entity.
let _lastDamageEvent = null;
// Distinguishes the server never sending the packet from the packet arriving and being missed (Law 23).
let _damageEventsSeen = 0;      // for THIS bot's body
let _damageEventsForOthers = 0; // any body
function _armDamageAttribution(bot) {
  if (!bot || !bot._client || bot._aurenDamageAttribution) return;
  bot._aurenDamageAttribution = true;
  bot._client.prependListener('damage_event', (p) => {
    _damageEventsForOthers++;
    if (!bot.entity || p.entityId !== bot.entity.id) return;   // somebody else's blow
    _damageEventsSeen++;
    // Direct = what dealt the blow; cause = who is responsible (an arrow's direct id despawns on landing).
    _lastDamageEvent = {
      at: Date.now(),
      kindId: p.sourceTypeId != null ? p.sourceTypeId : null,
      byId: p.sourceDirectId ? p.sourceDirectId - 1 : null,
      causeId: p.sourceCauseId ? p.sourceCauseId - 1 : null,
    };
  });
}

// _attributeBlow(bot) → { by, byId, kind } for the blow being processed now, or nulls.
// Stash trusted for one second (Law 25).
const DAMAGE_EVENT_FRESH_MS = 1000;
function _attributeBlow(bot) {
  const ev = _lastDamageEvent;
  if (!ev || Date.now() - ev.at > DAMAGE_EVENT_FRESH_MS) return { by: null, byId: null, kind: null };
  // Direct first, then cause.
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
  // Keep the direct id when nothing resolves — a packet with an unresolvable attacker (Law 25).
  if (by === null) byId = ev.byId;
  // `byId === null` on a blow = the world did it (environmental).
  return { by, byId, kind: ev.kindId };
}

// WORLD DAMAGE STREAK — repeated blows of one world kind (suffocation, drowning, fire tick the body
// about twice a second) are one event. The first blow warns; the rest are counted here and the
// streak's total is one summary line when the blows stop. { kind, blows, lost, since, last, hp, timer }.
const WORLD_STREAK_GAP_MS = 2000;
let _worldStreak = null;
function _continuesWorldStreak(kind) {
  return !!_worldStreak && _worldStreak.kind === kind && Date.now() - _worldStreak.last <= WORLD_STREAK_GAP_MS;
}
function _armWorldStreakClose() {
  if (_worldStreak.timer) clearTimeout(_worldStreak.timer);
  _worldStreak.timer = setTimeout(_closeWorldStreak, WORLD_STREAK_GAP_MS);
}
function _openWorldStreak(kind, lost, hp) {
  _worldStreak = { kind, blows: 1, lost, since: Date.now(), last: Date.now(), hp, timer: null };
  _armWorldStreakClose();
}
function _countWorldBlow(lost, hp) {
  _worldStreak.blows++;
  _worldStreak.lost += lost;
  _worldStreak.last = Date.now();
  _worldStreak.hp = hp;
  _armWorldStreakClose();
}
function _closeWorldStreak() {
  const s = _worldStreak;
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  _worldStreak = null;
  if (s.blows < 2) return;
  watcher.summary('battle_stations',
    `WORLD_DAMAGE_STREAK kind=${s.kind} blows=${s.blows} lost=${s.lost.toFixed(1)}` +
    ` over ${((s.last - s.since) / 1000).toFixed(1)}s → hp ${s.hp.toFixed(1)}/20 · last blow ${s.where}`);
}

// _standingIn(bot) → where the body is and the blocks at its head, feet and under it, as the bot reads
// them now: the world's damage comes from one of those three cells.
function _standingIn(bot) {
  if (!bot.entity) return 'at=unknown';
  const p = bot.entity.position;
  const name = (dy) => { const b = bot.blockAt(p.offset(0, dy, 0)); return b ? b.name : 'unseen'; };
  return `at=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) head=${name(1)} feet=${name(0)} below=${name(-1)}`;
}

// BLAST RECORDER —where the body stood for a detonation, and whether health moved (Law 23). Packet,
// not crater. Health delta deferred, written after a settle window. Not creeper-only.
const BLAST_HEALTH_SETTLE_MS = 400;
// Counted like _damageEventsSeen (Law 23).
let _explosionPacketsSeen = 0;
// Set synchronously — read at retirement, the same pass.
let _lastBlastAt = 0;
// ATTRIBUTION BY BODY AT THE CENTRE, NOT BY CLOCK.
const BLAST_CENTRE_RADIUS = 1.5;
// Covers a point-blank detonation that removes the body before the packet is handled (Law 16).
const DETONATION_ATTRIBUTION_MS = 250;
// Replaced whole on every explosion.
let _lastBlastIds = new Set();
// Ceiling on how long a named id stays attributable.
const BLAST_ID_STALE_MS = 3000;
// Read by the settle timer, against a respawn inside the settle window.
let _lastDeathAt = 0;
function _armBlastRecorder(bot) {
  if (!bot || !bot._client || bot._aurenBlastRecorder) return;
  bot._aurenBlastRecorder = true;
  bot._client.prependListener('explosion', (p) => {
    _explosionPacketsSeen++;
    _lastBlastAt = Date.now();
    // Named first, true only this instant — a tick later the body is gone from the table.
    //
    // Both packet shapes are read: 26.1 carries a single `center` vector, 1.21.x carries `x`/`y`/`z`
    // as three loose f64s (Law 26).
    const centre = p.center || p;
    _lastBlastIds = new Set();
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e === bot.entity) continue;
      if (Math.hypot(e.position.x - centre.x, e.position.y - centre.y, e.position.z - centre.z) <= BLAST_CENTRE_RADIUS) {
        _lastBlastIds.add(e.id);
      }
    }
    // A detonation keeps a line; no blast-damage model.
    {
      const hpBefore = typeof bot.health === 'number' ? bot.health : null;
      const deathsBefore = _lastDeathAt;
      setTimeout(() => {
        // Death inside the settle window reads health as zero, not bot.health's last value.
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

// armDeathWatch(bot): install the edge. Called once from master_core's spawn handler (Law 8).
function armDeathWatch(bot) {
  if (!bot || bot._aurenDeathWatch) return;   // idempotent
  bot._aurenDeathWatch = true;
  _armDamageAttribution(bot);
  _armBlastRecorder(bot);
  _life = _freshLife(bot);
  bot.on('death', () => {
    _diedSince = true;
    _deathRouted = false;
    // Stamp for the blast recorder's deferred settle read.
    _lastDeathAt = Date.now();

    // Posted first, before anything below could throw. Who killed the body, how hard the last blow
    // was, how much it had already absorbed.
    const blow = _attributeBlow(bot);
    crewLog.post('battle_stations', 'death', {
      // A `kind` with no `by` is the world (fall/drown/fire).
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
      routeToJudge('battle_stations', {
        readable: 'battle_stations: bot died and no gate ran — watchdog replanning from current state',
      });
    }, DEATH_GATE_GRACE_MS);
  });

  // Respawn edge ends this death's lifecycle and re-arms both flags (Law 8).
  bot.on('spawn', () => {
    if (_deathWatchdog) { clearTimeout(_deathWatchdog); _deathWatchdog = null; }
    _deathRouted = false;
    _life = _freshLife(bot);
    _struck = null;
    _closeWorldStreak();
    lastHp =typeof bot.health === 'number' ? bot.health : null;
  });

  // DAMAGE LINE — announces every hp drop and the hp after it. `engaging` is the discriminator
  // between a fight the counter knows about and one it does not. Level warn (Law 5). `health` also
  // fires on food change and regen; the drop test below is what makes this a damage line.
  let lastHp = typeof bot.health === 'number' ? bot.health : null;
  bot.on('health', () => {
    const hp = typeof bot.health === 'number' ? bot.health : null;
    if (hp == null) return;
    const prev = lastHp;
    lastHp = hp;
    if (prev == null || hp >= prev) return;              // regen, food, or first read — not damage
    const lost = prev - hp;

    // NO SCAN — monster data is read off the commander's board, swept this tick and sorted
    // nearest-first. `sweptAt: null` = "nobody has looked yet" (Law 25).
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

    // READ ONE MACROTASK LATE: `health` and `damage_event` are different packets in one server tick.
    // World state (scan, hp, engaged flag) is captured synchronously above; only attribution is
    // deferred (Invariant B).
    setImmediate(() => {
    const blow = _attributeBlow(bot);
    const from = blow.by
      ? `by ${blow.by}#${blow.byId}`
      : blow.byId === null && blow.kind != null
        ? 'by the WORLD (fall/drown/fire — no entity on the blow)'
        : 'attacker UNATTRIBUTED (no damage_event)';

    // One cause, one warning: a world blow that continues an open streak of the same kind is counted
    // into the streak, and the streak's closing line carries the total. Every entity blow warns.
    const worldBlow = blow.by === null && blow.byId === null && blow.kind != null;
    if (worldBlow && _continuesWorldStreak(blow.kind)) {
      _countWorldBlow(lost, hp);
    } else {
      _closeWorldStreak();
      watcher.warn('battle_stations',
        `💔 TOOK ${lost.toFixed(1)} DAMAGE ${from}${worldBlow ? ` kind=${blow.kind} ${_standingIn(bot)}` : ''} → hp ${hp.toFixed(1)}/20` +
        ` · ${wasEngaged ? 'ENGAGED (the counter is running)' : '⚠️ NOT ENGAGED — no engagement was open'}` +
        ` · ${list.length} hostile(s) in scan: ${near}`);
      if (worldBlow) _openWorldStreak(blow.kind, lost, hp);
    }
    if (_worldStreak) _worldStreak.where = _standingIn(bot);

    // One event, two registers: prose for a human, a row for the reducer (Invariant C).
    //
    // THE REACTIVE TRIGGER the commander's aggro model is built on (Law 16).
    _struck = { at: Date.now(), byId: blow.byId };

    _life.hits++;
    _life.damage += lost;
    if (!wasEngaged) _life.hitsUnengaged++;
    if (nearby > _life.maxConcurrent) _life.maxConcurrent = nearby;
    _life.lastBlow = { by: blow.by, byId: blow.byId, kind: blow.kind, lost, at: Date.now() };

    // A blow landing on the body is a beat, the fight's own scoring row.
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

// THE GATE DOES NOT RESPAWN THE BOT. Checks whether the body is dead and routes to the judge; the
// click is `assessors/respawn` dispatching `respawn_executor` — the only `bot.respawn()` in the fleet.

// abandonToJudge: originate a fresh chain at recursive_judge (Law 15).
//
// releaseJobClaim: drop the magnet on entering combat, the replanning boundary (Invariant B). At the
// ENGAGE edge, not every call (Law 8). Sentry exempt (Law 26).
// nearestHostileDistance: closest hostile right now, or null. Reads the commander's consolidated
// sweep (Law 16, Invariant B).
function nearestHostileDistance() {
  const n = crewBoard.readCommander().nearest;
  return n ? n.distance : null;
}

// One shared tail for "distance to the monster" (Law 16).
function _dTail() {
  const d = nearestHostileDistance();
  return d == null ? 'Nearest hostile: none in range.' : `Nearest hostile ${d.toFixed(1)}b.`;
}

// Unguarded: the dispatcher is ours (Law 8).
function releaseJobClaim(source) {
  if (source === 'sentry') return;
  require('@kernel/foreman_link').abandonComputationWorkspace();
  require('@thinking/dispatcher.js').clearMagnet();
}

function abandonToJudge(readable) {
  require('@kernel/foreman_link').abandonComputationWorkspace();
  routeToJudge('battle_stations', { readable });
  return new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBAT — reactive counter-aggro engagement
// ─────────────────────────────────────────────────────────────────────────────
// Rides the inline hook above the water gate, fires for every caller. Self-contained Law 15 sub-loop:
// takes the body, fights re-sensing every pass (Invariant B), abandons the caller.
//
// Fight routes no signals — raw control state and direct calls (Law 4). THE SPOILS ARE THE
// EXCEPTION: the 'cleared' branch calls drop_collector.collectNearby, a nested goTo admitted by
// signal_bus (spoils branch below).

let engaging = false;

// The reason the gate last declined to fight, or null. Posted on change, cleared when a fight opens.
let _lastDeclineWhy = null;

// Wave-boundary buffer for the meters' summary lines (Law 4, one wave's lines in flight).
let _waveMeterLines = [];

// NO MOB CLAIM — bots gang up. A mob is not a TASK (Invariant D). Gates on attacking a mob are
// physical only: in reach, weapon charged. Task locks (foreman_link, dispatcher) are untouched.

// WHERE THE REST OF THE FIGHT LIVES. Weapon selection and the swing are combat_utils' (Law 16). This
// file holds composition — which mob, and when the wave is over. NO BREAK-OFF VERB (the driver's
// setpoint). NO COUNTER DISPATCH — one tactic for every mob. This loop is judge and recorder
// (Law 11), never executor.

// STAGE 2/3: TARGET_ENGAGED → TARGET_COMBAT. Bounded by TIME, not by passes (Law 13). Per target, not
// per wave — sized off one mob's health against one weapon's cooldown. Reset only by a kill (Law 11).
const ENGAGEMENT_MAX_MS = 60000;

// THE DEAD-WAIT CLOCK — a second clock with a different predicate. Fires only when nothing is
// happening: the bot did not move, the held mob did not move, the held mob took no damage (Law 25).
const IDLE_STALL_MS = 1000;
// Jitter tolerance while standing and swinging.
const IDLE_MOVE_EPSILON = 0.25;

// combatActivity — did anything happen between these two samples? Pure and exported so the claim can
// be tested. `prev` null is activity.
function combatActivity(prev, now) {
  if (!prev) return true;
  const moved = !prev.botAt || !now.botAt || now.botAt.distanceTo(prev.botAt) > IDLE_MOVE_EPSILON;
  const mobMoved = !prev.mobAt || !now.mobAt || now.mobAt.distanceTo(prev.mobAt) > IDLE_MOVE_EPSILON;
  const hurt = now.mobHp !== null && prev.mobHp !== null && now.mobHp < prev.mobHp;
  return moved || mobMoved || hurt;
}

// The distance inside which a vanished entity is reported CLEARED; mineflayer cannot distinguish a kill
// from the mob leaving tracking range, so beyond it the retirement is reported LOST (Law 25).
const KILL_CONFIDENCE_RANGE = 16;

// refreshTarget: the same descriptor threat_scanner produces, rebuilt from the live entity. Identity
// is the entity id; position is re-read every pass (Invariant B). Returns null when the entity is gone.
function refreshTarget(bot, id, name) {
  const e = bot.entities && bot.entities[id];
  if (!e || e.isValid === false || !e.position) return null;
  return {
    id, name, entity: e,
    distance: bot.entity.position.distanceTo(e.position),
    position: { x: e.position.x, y: e.position.y, z: e.position.z },
  };
}

// _bankMeterLine: hold one meter's line for the wave report instead of posting it now. Dedupe: the
// meters reset at the previous retirement. Capacity guard (Law 25).
const MAX_WAVE_METER_LINES = 12;
function _bankMeterLine(line) {
  if (_waveMeterLines.length >= MAX_WAVE_METER_LINES) return;
  if (_waveMeterLines.includes(line)) return;
  _waveMeterLines.push(line);
}

// bankFuseLine: the fuse meter's line for the mob whose fight just ended, banked for the wave
// boundary (see `_waveMeterLines`). Per retirement, not per wave (Law 25).
function bankFuseLine() {
  const fz = fuseMeter.summary();
  if (fz) _bankMeterLine(fz);
}

// ═══ THE ENGAGEMENT QUEUE ═══════════════════════════════════════════════════════════════════════
// Keeps the seat engaged through a whole wave: a confirmed-aggro mob joins the queue.
//
// THE ENGAGEMENT ENDS WHEN THE FIELD IS CLEAR, NOT WHEN ONE MOB IS.
//
// WHAT IS REMEMBERED AND WHAT IS RE-SENSED. The queue remembers one thing per mob — that a raycast
// confirmed its aggro. Everything else is re-read off the live entity every pass; the queue is a set
// of ids, never an ordering (Invariant B).

// enqueue: admit ONE confirmed-aggro mob. Tactic matched at admission. One classification per entry.
function enqueue(queue, id, name, distance) {
  if (queue.has(id)) return false;
  queue.set(id, {
    id, name,
    // Last distance SEEN — feeds KILL_CONFIDENCE_RANGE at retirement.
    lastDistance: distance,
  });
  return true;
}

// admitAggro: queue every mob the commander has posted as ACTIVE that is not already in the queue.
// No raycast here (Invariant D — the commander says who is a threat, this seat which it has taken on).
function admitAggro(bot, queue) {
  let admitted = 0;
  for (const h of crewBoard.readCommander().active) {
    if (queue.has(h.id)) continue;
    if (enqueue(queue, h.id, h.name, h.distance)) admitted++;
  }
  return admitted;
}

// orderQueue: the queue read as a fight order, rebuilt from live entities. Vanished entities are
// returned in `gone`, so the caller can retire them (Law 25).
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

// NO TARGET COMPARATOR AND NO REPICK GATE HERE (Law 16). The target is the commander's `focus`,
// committed by `chooseFocus` — hysteresis by identity, not distance.

// retirementVerdict(entry, wasHeld, now) → 'dequeued' | 'detonated' | 'cleared' | 'lost'.
// Named so a bench can drive the claim directly (Law 26).
function retirementVerdict(entry, wasHeld, now) {
  if (!wasHeld) return 'dequeued';
  const sinceBlast = _lastBlastAt ? now - _lastBlastAt : Infinity;
  const blasted = (_lastBlastIds.has(entry.id) && sinceBlast <= BLAST_ID_STALE_MS)
    || sinceBlast <= DETONATION_ATTRIBUTION_MS;
  if (blasted) return 'detonated';
  return entry.lastDistance <= KILL_CONFIDENCE_RANGE ? 'cleared' : 'lost';
}

// retireTarget: one mob's fight is over — record the verdict and, if this was the mob the counters
// were running against, print their reports and clear them. Per retirement, not per wave (Law 25).
function retireTarget(bot, choice, entry, verdict, wasHeld) {
  // Tells "the bot killed it" from "it died near the bot" (Law 25).
  crewLog.post('battle_stations', 'end', {
    subject: `${entry.name}#${entry.id}`,
    outcome: verdict, held: !!wasHeld,
    hit: gunner.connectedTo(entry.id),
    d: Math.round(entry.lastDistance * 100) / 100,
    hp: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
  });
  if (!wasHeld) return;
  bankFuseLine();
  fuseMeter.reset();
}

// targetEngaged: fight the field, closest first, until nothing confirmed is left standing. Not a
// re-scan loop — threat_scanner is not consulted again.
async function targetEngaged(bot, firstBoard, choice) {
  const queue = new Map();
  // Seeded from the commander's `active` list at the instant the fight opened (Law 16).
  for (const h of firstBoard.active || []) enqueue(queue, h.id, h.name, h.distance);
  if (!queue.size) enqueue(queue, firstBoard.engage.id, firstBoard.engage.name, firstBoard.engage.distance);

  const tally = { cleared: 0, lost: 0, dequeued: 0, taken: 0, detonated: 0 };

  // IS THE WAVE LOOP ACTUALLY FIGHTING THE COMMANDER'S FOCUS? Does the seat that decides the target
  // agree with the seat that executes it (Law 25). `offClosestB` prices the overhang.
  const focusAudit = { passes: 0, onFocus: 0, noFocus: 0, offClosestB: 0, switches: 0, switchedToFocus: 0 };
  // Every mob that left the queue alive this wave.
  const dequeuedIds = new Set();
  // WHICH ENTITY DIED, AND WHICH WALKED — the tally above counts, these name (Law 25).
  const killedEntityIds = new Set();
  const disengagedEntityIds = new Set();
  const entityNames = new Map();
  // Called from both retirement paths (Law 16).
  const bucketRetirement = (entry, verdict) => {
    entityNames.set(entry.id, entry.name);
    (verdict === 'cleared' ? killedEntityIds : disengagedEntityIds).add(entry.id);
  };
  let deadline = Date.now() + ENGAGEMENT_MAX_MS;
  // The dead-wait clock's three remembered readings (see IDLE_STALL_MS).
  let idleSince = 0, lastSample = null;
  let heldId = null;
  let outcome = null;
  let passes = 0;
  // Peak simultaneous live hostiles across this wave.
  let maxConcurrent = 0;

  // withCleanup, not a guard: nothing here is caught.
  await withCleanup('battle_stations', 'engagement loop', async () => {
    while (Date.now() < deadline) {
      // THE PASS BOUNDARY IS THE LINE BOUNDARY — driver, gunner and commander each post one line per
      // pass, flushed here at the top.
      crewLog.flush();
      passes++;
      // Death exit (sentry mode); catches the bot dying during a fight (Law 13).
      if (!bot.entity || (typeof bot.health === 'number' && bot.health <= 0)) { outcome = 'died'; break; }

      const now = Date.now();
      admitAggro(bot, queue);
      const { live, gone } = orderQueue(bot, queue);

      // STAGE 4, PER MOB. A kill only if it vanished close (KILL_CONFIDENCE_RANGE) and was the mob
      // being fought; anything else is `dequeued` (Law 25).
      for (const entry of gone) {
        fuseMeter.vanished(entry.id, entry.lastDistance);
        const wasHeld = entry.id === heldId;
        // A MOB THAT REMOVED ITSELF IS NOT A KILL (Law 25). Attribution never by species.
        const verdict = retirementVerdict(entry, wasHeld, Date.now());
        tally[verdict]++;
        if (verdict === 'dequeued') dequeuedIds.add(entry.id);
        bucketRetirement(entry, verdict);
        retireTarget(bot, choice, entry, verdict, wasHeld);
        queue.delete(entry.id);
        if (wasHeld) {
          heldId = null;
          // Progress resets the per-target clock (ENGAGEMENT_MAX_MS). Only a kill does.
          if (verdict === 'cleared') deadline = Date.now() + ENGAGEMENT_MAX_MS;
        }
      }

      if (!live.length) {
        // `detonated` tested before the fall-through (Law 25).
        outcome = tally.cleared ? 'cleared' : tally.detonated ? 'detonated' : tally.lost ? 'lost' : 'cleared';
        break;
      }

      // THE DEAD-WAIT CLOCK samples the CLOSEST live mob here, independent of which one is held.
      // THE FUSE METER'S ONE TICK rides the same pass (Law 16).
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
          // Split horizontal/vertical — the two have different repairs.
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
        // Cloned, not referenced: `entity.position` is a live Vec3 mineflayer mutates in place.
        lastSample = {
          botAt: sample.botAt ? sample.botAt.clone() : null,
          mobAt: sample.mobAt ? sample.mobAt.clone() : null,
          mobHp: sample.mobHp,
        };
      }

      // THE QUEUE FOLLOWS THE COMMANDER'S FOCUS (Invariant D). Fallback is the head of `live`, not null.
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
        // One `engage` row per target taken, paired with the `end` row retireTarget writes.
        _life.engagedIds.add(entry.id);
        if (live.length > _life.maxConcurrent) _life.maxConcurrent = live.length;
        if (live.length > maxConcurrent) maxConcurrent = live.length;
        if (live.length > 1) {
          focusAudit.switches++;
          if (focusInQueue !== null && focusInQueue === heldId) focusAudit.switchedToFocus++;
        }
        // `focus`: came from the commander's focus or the fallback. `closest`: prices the commitment.
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
        // NO PROSE TARGET LINE HERE — the seats report, not this file (Law 16, Invariant D).
      }

      const target = live.find((x) => x.id === heldId);
      const entry = queue.get(heldId);

      // The focus audit, counted only where the question exists (Law 25).
      if (live.length > 1 && target) {
        focusAudit.passes++;
        if (focusInQueue === null) focusAudit.noFocus++;
        else if (focusInQueue === heldId) focusAudit.onFocus++;
        if (live[0].id !== heldId) {
          const over = target.distance - live[0].distance;
          if (over > focusAudit.offClosestB) focusAudit.offClosestB = over;
        }
      }

      // THIS PASS DOES NOT FIGHT. IT WAITS ONE TICK AND LOOKS AGAIN — the fight runs on the physicsTick.
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
    // The held target's `engage` row must always find its `end` row (Law 8).
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

// THE SENTRY'S OUTCOME SIGNAL — one shape from every sentry exit (Law 10, Law 13). Sentry only (Law 16).
function sentryReport(outcome, result) {
  return {
    outcome,
    killedEntityIds: result ? result.killedEntityIds : [],
    disengagedEntityIds: result ? result.disengagedEntityIds : [],
    entityNames: result ? result.entityNames : {},
    passes: result ? result.passes : 0,
  };
}

// engageThreat: the HANDOVER, stage 1 → stage 2. Takes the body over, runs targetEngaged, releases
// every claim it raised, then abandons the caller to recursive_judge (Law 15).
// IT OWNS THE WAVE; targetEngaged OWNS EACH TARGET.
// `firstBoard` is the commander's section read at the gate.
async function engageThreat(bot, firstBoard, source) {
  engaging = true;
  _lastDeclineWhy = null;
  // Cleared where the wave begins, not where it ends (Law 8).
  _waveMeterLines = [];
  survival.disableReflex('autoTorch');
  // NO SHIELD GATE — shields are not in scope.
  //
  // THE GUNNER IS ARMED FOR THE WHOLE WAVE, AT THIS SEAT AND NOT PER TACTIC — the facing, the
  // approach no tactic owns (Invariant D).
  gunner.engage();
  // AND THE DRIVER, for the identical reason (Invariant D).
  driver.engage();
  const first = firstBoard.engage;
  const startAt = bot.entity.position.floored();
  const choice = combatUtils.pickBestWeapon(bot);
  const hp = typeof first.entity?.health === 'number' ? `${Math.round(first.entity.health)}hp` : 'hp?';
  const confirmed = (firstBoard.active || []).length;
  // Read once, here, never re-read at report time (Law 25).
  const waveHpAtStart = typeof bot.health === 'number' ? bot.health : null;
  watcher.summary('battle_stations',
    `⚔️ Engaging ${first.name} [${hp}] — (${firstBoard.engageReason}) at ${first.distance.toFixed(1)}b with ${choice.profile.name || 'fists'} (rung: ${choice.rung}, ${choice.profile.damage} dmg / ${choice.profile.cooldownMs}ms cooldown) — ${confirmed} confirmed of ${firstBoard.hostiles.length} hostile(s) tracked, from (${startAt.x},${startAt.y},${startAt.z}), source ${source || 'inline'}.`);
  let outcome = 'cleared';
  let result = null;
  // withCleanup, not a guard: nothing is caught (Law 25).
  await withCleanup('battle_stations', 'wave teardown', async () => {
    result = await targetEngaged(bot, firstBoard, choice);
    outcome = result.outcome;
  }, () => {
    // THE BODY IS HANDED BACK STOPPED (Law 8).
    clearMotion(bot); bot.setControlState('sprint', false);
    // The last pass's crew events, posted before the three aggregates below.
    crewLog.flush();
    // The gunner is stood down in the same finally that stops the body (Law 8).
    gunner.report();
    gunner.disengage(bot);
    // The driver is released last, the seat holding the keys (Law 8).
    driver.report();
    driver.disengage(bot);
    // THE THIRD SEAT SPEAKS HERE TOO (Law 6). Not disengaged with it — the commander sweeps whether
    // or not a fight is open.
    commander.report();
    survival.enableReflex('autoTorch');
    engaging = false;
    // Consumed here when the fight ran through the death (Law 16).
    _diedSince = false;
    // THE WAVE'S OWN LINE — not an `end` (those are per target). How many mobs one arrival dealt with.
    crewLog.post('battle_stations', 'wave', {
      outcome, source: source || null,
      taken: result ? result.tally.taken : 0,
      cleared: result ? result.tally.cleared : 0,
      lost: result ? result.tally.lost : 0,
      dequeued: result ? result.tally.dequeued : 0,
      queued: result ? result.queued : null,
      passes: result ? result.passes : 0,
      hp: typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null,
      // The wave's own entry health, captured at engageThreat's first line.
      hp_open: waveHpAtStart == null ? null : Math.round(waveHpAtStart * 10) / 10,
      // Peak simultaneous hostiles across the wave, beside the aggro-confirmed count it opened on — a
      // wave where they diverge is one the scanner opened too small.
      peak: result ? result.maxConcurrent : (firstBoard.active || []).length,
      confirmed,
    });
    if (result) {
      // `nearestHostileDistance` re-senses the current distance here (Invariant B).
      const dNow = nearestHostileDistance();
      watcher.summary('battle_stations',
        `🏁 Wave ${outcome}: ${result.tally.taken} target(s) taken, ${result.tally.cleared} cleared, ` +
        `${result.tally.lost} lost, ${result.tally.dequeued} dequeued, ` +
        `${result.queued} still queued over ${result.passes} pass(es). ` +
        `Nearest hostile now ${dNow == null ? 'none in range' : `${dNow.toFixed(1)}b`}. ` +
        // THE FOCUS AUDIT, PRINTED EVEN WHEN EMPTY (Law 25).
        (result.focusAudit.passes === 0
          ? 'Focus: never in question (one mob at a time all wave).'
          : `Focus: held the commander's pick on ${result.focusAudit.onFocus}/${result.focusAudit.passes} multi-mob pass(es)` +
            ` (${result.focusAudit.noFocus} with no focus in queue)` +
            `, worst overhang past the nearest ${result.focusAudit.offClosestB.toFixed(2)}b` +
            `; ${result.focusAudit.switchedToFocus}/${result.focusAudit.switches} switch(es) were handovers.`));
    }
    // The wave's meter lines, posted after the wave line (Law 24).
    for (const line of _waveMeterLines) watcher.summary('battle_stations', line);
    _waveMeterLines = [];
  });
  // THE SPOILS — battle_stations collects drops after winning a fight, the fleet's mob-drop supply
  // route. Gated on 'cleared'. After the finally (Law 8).
  //
  // THE ONE TURN OF THE CYCLE THAT COSTS NOTHING, AND ITS JUDGE. Portable judge's ping-pong
  // checkpoint on a `dequeued` mob (STALL_THRESHOLD 3, Law 15). Sentry exempt (Law 26).
  if (source !== 'sentry' && outcome === 'cleared' && result && result.tally.cleared === 0 && result.dequeuedIds.length) {
    const key = `mob ${result.dequeuedIds.slice().sort((a, b) => a - b).join(',')}`;
    if ((await portableJudge.checkpoint('mob_reengage', key)) === false) {
      watcher.warn('battle_stations',
        `Disengage/re-engage loop on ${key} — three waves running that retired it alive without a kill. ` +
        `Portable judge routed to recursive_judge; not collecting spoils and not routing again.`);
      return;
    }
  }
  // FROM EVERY CALLER, LOCOMOTION INCLUDED (signal_bus, Invariant B, Law 15).
  // EXCEPT FOR THE SENTRY — no job, no magnet, no chain.
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
      `${spoils.long_walk ? `, ${spoils.long_walk} too long a walk` : ''}` +
      `${spoils.left ? `, ${spoils.left} left (window closed)` : ''}. ` +
      `Nearest hostile ${dSpoils == null ? 'none in range' : `${dSpoils.toFixed(1)}b`}.`);
  }
  // WHICH ENTITY DIED, AND WHICH WALKED — ON EVERY EXIT, NOT ONLY FOR THE SENTRY. Loop detection off
  // the `readable` string (Law 11).
  const entityNames = result ? result.entityNames : {};
  const nameEntities = (ids) =>
    (ids && ids.length ? ids.map(id => `${entityNames[id] || 'entity'}#${id}`).join(', ') : 'none');
  const killedText = nameEntities(result && result.killedEntityIds);
  const disengagedText = nameEntities(result && result.disengagedEntityIds);
  const entitiesText = `killed: ${killedText}; disengaged: ${disengagedText}`;

  // Sentry = report the outcome UP, never abandon (Law 26). The sentry gets the ids as data (Law 25).
  if (source === 'sentry') {
    watcher.summary('battle_stations',
      `Engagement ${outcome} — ${entitiesText}. ` +
      `Returning to the sentry loop (its own judge owns the replan decision). ` + _dTail());
    return sentryReport(outcome, result);
  }
  // NO 'stuck' AND NO 'yield' BRANCH — nothing sets either outcome (Law 16).
  watcher.summary('battle_stations', `Engagement ${outcome} — ${entitiesText} — abandoning caller to recursive_judge for replan. ` + _dTail());
  // The ids ride in the readable (Law 11).
  return abandonToJudge(`battle_stations: engagement ${outcome} (${entitiesText}) — replanning from current state`);
}

// Law 15 API, called inline by executors and locomotion at loop boundaries. The combat gate.
//
// `source` is load-bearing: 'sentry' owns its own judge and gets the outcome returned. Every other
// caller abandons.
//
// THE WHOLE CAN-I-FIGHT-AND-SHOULD-I DECISION LIVES HERE (Law 16, Invariant B).
async function battleStations(bot, source) {
  // Re-entrancy guards (Law 13).
  if (engaging) return source === 'sentry' ? sentryReport('busy_engaging', null) : undefined;

  // DEATH, FIRST AND BEFORE THE BODY CHECK (mineflayer nulls bot.entity between death and respawn).
  //
  // IT DOES NOT RETURN 'died' (Law 25).
  if (_diedSince || (bot && typeof bot.health === 'number' && bot.health <= 0)) {
    const edge = _diedSince;
    _diedSince = false;
    // Sentry owns its own judge and does NOT respawn here.
    if (source === 'sentry') {
      return sentryReport('died', null);
    }

    // CHECK, THEN ROUTE — battle_stations only checks whether the bot is dead and routes to the judge
    // (Law 13, Law 4).

    // The watchdog may already own this death (Law 4).
    if (_deathRouted) {
      require('@kernel/foreman_link').abandonComputationWorkspace();
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

  // Law 25.
  if (!bot || !bot.entity || !bot.entity.position) {
    watcher.warn('battle_stations',
      'No body — the gate was called on a bot with no entity or no position, so nothing could be scanned. ' +
      'Returning `no_body` rather than falling through: an empty return reads as "nothing to fight", which ' +
      'is true about the field and false about the body (Law 25).');
    return source === 'sentry' ? sentryReport('no_body', null) : 'no_body';
  }

  // COMBAT gate — fires for every caller including locomotion. Law 4-safe. On a threat this takes
  // over and never returns; with nothing to fight it returns.
  // READ, NOT SCANNED — one main scanner for monsters (Law 16).
  const scan = crewBoard.readCommander();
  if (scan.engage) { releaseJobClaim(source); return engageThreat(bot, scan, source); }
  // A DECLINE IS RECORDED WHEN IT CHANGES, NOT WHEN IT REPEATS (Law 5).
  if (scan.hostiles && scan.hostiles.length) {
    const self = bot.entity.position;
    const inRange = scan.hostiles.filter(h => withinAggroRange(self, h.position, h.name));
    const why = !inRange.length ? 'out_of_aggro_range'
      : inRange.some(h => h.aggroed) ? 'aggroed_but_not_selected'
      : 'no_sightline';
    if (why !== _lastDeclineWhy) {
      _lastDeclineWhy = why;
      // The nearest hostile only. `dh`/`dy`: the gate judges the two axes separately (architect_config's cylinder).
      const h = scan.hostiles[0];
      crewLog.post('battle_stations', 'declined', {
        subject: `${h.name}#${h.id}`,
        why, source: source || null,
        d: Math.round(h.distance * 100) / 100,
        dh: Math.round(Math.hypot(h.position.x - self.x, h.position.z - self.z) * 100) / 100,
        dy: Math.round((h.position.y - self.y) * 10) / 10,
        // Carried on the line for the reader (Law 16).
        r: aggroRangeFor(h.name), ry: AGGRO_VERTICAL_RANGE,
        seen: scan.hostiles.length,
        ...(h.blockedBy ? { blocked_by: h.blockedBy.name } : {}),
      });
    }
  }
  // The quiet pass is stated explicitly (Law 13, Law 25).
  if (source === 'sentry') return sentryReport('clear', null);
}

// combatCheckpoint — THE GATE A PRIMITIVE CALLS. A bypass for when the gate is already inside
// battle_stations, and a clock that stops a primitive paying a full check per call. Bound to a STEP
// count, not wall time (Law 16). One clock for the whole process (Law 6). Never returns on a threat
// (Law 15, Invariant B).
const CHECKPOINT_MS = 500;
let _lastCheckpointAt = 0;

// `opts.before` — RELEASE WHAT THE CALLER IS HOLDING (Law 8).
async function combatCheckpoint(bot, source, opts) {
  // The bypass. Combat's own seats drive and dig through this same code.
  if (engaging) return;
  const now = Date.now();
  if (now - _lastCheckpointAt < CHECKPOINT_MS) return;
  _lastCheckpointAt = now;
  if (opts && opts.before) opts.before();
  return battleStations(bot, source);
}

module.exports = {
  battleStations, combatCheckpoint, CHECKPOINT_MS, armDeathWatch,
  combatActivity, IDLE_STALL_MS, IDLE_MOVE_EPSILON,
  // Strike latch read side, for the commander's reactive aggro model (Invariant D).
  struckWithin,
  // Queue internals are not exported (Invariant D).
  KILL_CONFIDENCE_RANGE, ENGAGEMENT_MAX_MS,
  BLAST_CENTRE_RADIUS, BLAST_ID_STALE_MS, DETONATION_ATTRIBUTION_MS,
};
