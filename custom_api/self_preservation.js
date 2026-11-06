// module: self_preservation
// purpose: the crew's survival seat (crew_board `survival`). The body's life outranks the fight (Law 17): a body at
//          or under FLEE_HP breaks off and runs, and it seeks no fight until it has healed to RETURN_HP; a named monster
//          (a drowned in water, a witch met alone far from base, a NEVER_WINNABLE boss) is run from too. Either way the
//          body calls for backup: its boardroom chair carries a distress call naming its attackers, and an armed peer within
//          BACKUP_REACH_B takes them (commander, THE BACKUP DOOR).
//
// Read by every seat off the board, never called across (Law 1). The commander admits threats as it always does, so
// a mob walking up opens the fight the body runs in, and it opens the backup door on a peer's call. While `fleeing`
// the driver runs (`flee`) toward `goal` instead of closing on the mob, and the gunner drops the approach guard and
// holds no knockback, so the body can sprint; battle_stations ends the wave 'fled' once the body is `clear`, and eats.
//
// A death is still the run's error (battle_stations); this seat is what stands between a hard fight and that error.

'use strict';

const crewBoard = require('@api/crew_board');
const crewLog = require('@api/crew_log');
const hq = require('@kernel/corporate_headquarters');
const combatUtils = require('@utils/combat_utils');

const TAG = 'self_preservation';

const writeBoard = crewBoard.claimPen('survival');

// ── SECTION 1: The numbers ──

// The flee line and the return line: at 4 hearts the body runs; it fights again at 8.
// Two zombie blows on hard are 9 hp, so a body above the line survives the blow it did not see coming.
const FLEE_HP = 8;
const RETURN_HP = 16;

// The body is clear of a fight when no threat stands within its clear reach (clearReach: FLEE_CLEAR_B, or
// FLEE_CLEAR_RANGED_B for a mob that shoots) and none has struck it for FLEE_QUIET_MS. A shooter reaches the body from
// where it stands: a drowned's tridents landed at 10.8 and 16.6 b, so a run that stopped at 12 b was struck between runs.
const FLEE_CLEAR_B = 12;
const FLEE_CLEAR_RANGED_B = 24;
const FLEE_QUIET_MS = 3000;
// A run from a drowned goes past the 35 b a zombie-kind follows a player, not to the edge of its throw: a run that
// stopped at 24 b was struck by a throw 2 s later from the drowned still walking after it (arena, trident drowned).
const FLEE_CLEAR_DROWNED_B = 40;

// ── A RUN IS CONFIRMED OVER ──────────────────────────────────────────────────────────────────────────────
// The body keeps running from a mob until the mob has stopped coming: beyond its clear reach and walking toward the
// body at under PURSUIT_B b/s (the commander's `pursuit`, the mob's own walking, so a body outrunning it does not read
// as a mob giving up) for DISENGAGE_CONFIRM_MS, or gone from the board.
const PURSUIT_B = 0.5;
const DISENGAGE_CONFIRM_MS = 2000;
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'breeze', 'drowned_trident']);
// A witch's potions pass a shield (arena: 5 and 3.5 hp left): run from one when no peer stands in BACKUP_REACH_B and the
// body is past this from its base. Beside a peer, or at home, it is fought.
const WITCH_BASE_B = 48;
// No run escapes these: an enderman teleports to the body it hunts, so a run only turns the body's back to it (arena: struck
// at 2.8 b with the guard down and killed, the enderman on 5 of its 40). Against them the body stands and fights.
const UNFLEEABLE = new Set(['enderman']);
// An engaged drowned is run from at once, home first, until the body stands clear of it and out of every drowned zone
// (hazard_zones). In the arena a trident drowned killed a full-hp body through a shield and through a run in the open, and
// a bare drowned can pick a trident up. The exception: a drowned out of water and within DROWNED_RUSH_B is rushed and
// fought (rushes). One in water is cleared at the shooter's reach, since it is not following,
// so a body resting past that reach is not taken back into the fight every 40 b run (a flee loop stopped a fleet).
const RUN_FROM = new Set(['drowned', 'drowned_trident']);
const DROWNED_RUSH_B = 10;
// Threats weighed: aggroed mobs, and before a fight the hostiles that could be taken by sight, within this reach or a
// threat's clear reach when that is longer.
const THREAT_REACH_B = 16;

// Never a fight to seek or to stay in, whatever the kit.
const NEVER_WINNABLE = new Set(['warden', 'wither', 'ender_dragon', 'elder_guardian']);

// ── THE CALL FOR BACKUP ──────────────────────────────────────────────────────────────────────────────────
// Re-published while the call stands, so a peer can tell a live call from one a dead body left (DISTRESS_FRESH_MS).
const DISTRESS_REFRESH_MS = 2000;
const DISTRESS_FRESH_MS = 5000;
// Who answers: an armed peer within this reach.
const BACKUP_REACH_B = 32;

// ── SECTION 2: State ──
let attached = false;
let tickHandler = null;
let recovering = false;     // latched at FLEE_HP, released at RETURN_HP
let outmatched = false;     // a named monster stands in the fight (witched, NEVER_WINNABLE)
const running = new Map();  // id → when the mob went quiet (0 while it is still coming), for each mob this run is from
let distress = null;        // { attackers, at } as last published
let saidState = null;
let homeReadAt = 0;
let home = null;

// ── SECTION 3: The pricing — pure ──

// threatName(h) → the name a hostile is priced by: a drowned holding a trident is priced as the thrower it is.
function threatName(h) {
  return combatUtils.throwsTrident(h.entity) ? 'drowned_trident' : h.name;
}

// standsInWater(bot, entity) → whether the mob's own cell holds water. An unread cell answers true: the run is the safe reading.
function standsInWater(bot, entity) {
  const block = entity && entity.position ? bot.blockAt(entity.position) : null;
  if (!block) return true;
  return block.name === 'water' || block.name === 'bubble_column' || (block.getProperties && block.getProperties().waterlogged === true);
}

// rushes(bot, h) → this hostile is a drowned the body closes on and fights: out of water and close.
function rushes(bot, h) {
  return RUN_FROM.has(threatName(h)) && h.distance <= DROWNED_RUSH_B && !standsInWater(bot, h.entity);
}

// clearReach(h, bot) → how far the body must be from this hostile to be clear of it.
function clearReach(h, bot) {
  const name = threatName(h);
  if (RUN_FROM.has(name)) return standsInWater(bot, h.entity) ? FLEE_CLEAR_RANGED_B : FLEE_CLEAR_DROWNED_B;
  return RANGED.has(name) ? FLEE_CLEAR_RANGED_B : FLEE_CLEAR_B;
}

// ── SECTION 4: The tick ──

function _home(now) {
  if (now - homeReadAt < 5000) return home;
  homeReadAt = now;
  const site = hq.readBuildingChair(require('@kernel/bot_mandate').homeBlueprint(), 'set_buildspot');
  home = (site && site.transpose_origin) || null;
  return home;
}

// The peer to run to: the nearest other body in sight within BACKUP_REACH_B that is not itself calling for help.
function _nearestPeer(bot, self, board) {
  let best = null;
  for (const [botId, chair] of Object.entries(board)) {
    if (botId === (process.env.BOT_ID || 'default')) continue;
    if (chair && chair.distress && Date.now() - chair.distress.at <= DISTRESS_FRESH_MS) continue;
    const e = bot.players && bot.players[botId] && bot.players[botId].entity;
    if (!e || !e.position) continue;
    const d = self.distanceTo(e.position);
    if (d <= BACKUP_REACH_B && (!best || d < best.d)) best = { d, name: botId, pos: e.position };
  }
  return best;
}

function _publishDistress(next) {
  const me = process.env.BOT_ID || 'default';
  const chair = hq.readBoardroomChair(me, {});
  const out = { ...chair };
  if (next) out.distress = next; else delete out.distress;
  hq.writeBoardroomChair(me, out);
  require('@utils/external_library_guard')
    .guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}

function onPhysicsTick(bot) {
  const self = bot.entity && bot.entity.position;
  const hp = typeof bot.health === 'number' ? bot.health : null;
  if (!self || hp === null || hp <= 0) return;
  const now = Date.now();
  const cmd = crewBoard.readCommander();

  if (!recovering && hp <= FLEE_HP) recovering = true;
  if (recovering && hp >= RETURN_HP) recovering = false;

  // The fight priced as it stands, or, with none open, the one the sight door would open.
  const active = cmd.active || [];
  // Mobs this run has not yet shaken: inside their clear reach, or still walking after the body, or quiet for too short a time.
  for (const id of running.keys()) if (!active.some((h) => h.id === id)) running.delete(id);
  for (const h of active) {
    if (!running.has(h.id)) continue;
    if (h.distance <= clearReach(h, bot) || h.pursuit > PURSUIT_B) running.set(h.id, 0);
    else if (!running.get(h.id)) running.set(h.id, now);
  }
  const unshaken = (h) => running.has(h.id) && (!running.get(h.id) || now - running.get(h.id) < DISENGAGE_CONFIRM_MS);
  const near = (list) => (list || []).filter((h) => h.distance <= Math.max(THREAT_REACH_B, clearReach(h, bot)));
  const open = active.filter((h) => h.distance <= Math.max(THREAT_REACH_B, clearReach(h, bot)) || unshaken(h));
  const candidates = open.length ? open : near(cmd.hostiles).filter((h) => h.seen !== false && !h.claimedBy);

  // A run is for low health and for the named monsters; every other fight is taken. The arena: one body in iron with a
  // shield cleared seven zombies in 9 of 9 rounds and never fell below 17.8.
  const lonely = !_nearestPeer(bot, self, hq.getFullBoardroom({}));
  const base = _home(now);
  const farOut = !base || Math.hypot(self.x - base.x, self.z - base.z) > WITCH_BASE_B;
  const witched = lonely && farOut && candidates.some((h) => threatName(h) === 'witch');
  outmatched = witched || candidates.some((h) => NEVER_WINNABLE.has(threatName(h)));

  // Every fight open while the body heals, one with a named monster, or one holding an engaged drowned (RUN_FROM) is a
  // run, unless it holds a mob no run escapes (UNFLEEABLE), which is fought out; the body is clear once it has shaken
  // every mob it ran from, nothing it fights stands within its clear reach and nothing has struck it for FLEE_QUIET_MS,
  // and a run from a drowned once the body also stands out of every drowned zone.
  const struck = require('@api/battle_stations').struckWithin(FLEE_QUIET_MS);
  const drowned = open.some((h) => RUN_FROM.has(threatName(h)) && !rushes(bot, h));
  const fleeing = (recovering || outmatched || drowned) && open.length > 0 && !open.some((h) => UNFLEEABLE.has(threatName(h)));
  if (fleeing) { for (const h of open) if (!running.has(h.id)) running.set(h.id, 0); } else running.clear();
  const clear = !open.some((h) => h.distance <= clearReach(h, bot) || unshaken(h)) && !struck
    && !(drowned && require('@api/hazard_zones').insideZone(bot));
  const why = !fleeing ? null : recovering ? 'low_hp' : outmatched ? 'named_monster' : 'drowned';

  // The call stands while the body runs, naming every mob pressing it.
  if (fleeing) {
    const attackers = open.map((h) => h.id).sort((a, b) => a - b);
    const same = distress && distress.attackers.join(',') === attackers.join(',');
    if (!same || now - distress.at >= DISTRESS_REFRESH_MS) {
      distress = { attackers, at: now, hp: Math.round(hp * 10) / 10, why };
      _publishDistress(distress);
    }
  } else if (distress) {
    distress = null;
    _publishDistress(null);
  }

  let goal = null;
  if (fleeing) {
    const peer = _nearestPeer(bot, self, hq.getFullBoardroom({}));
    // From a drowned the run goes home first: the base is never in a zone, and a peer may stand in the same water.
    const toHome = base && (drowned || !peer);
    goal = toHome ? { x: base.x, y: base.y, z: base.z, kind: 'home', name: null }
      : peer ? { x: peer.pos.x, y: peer.pos.y, z: peer.pos.z, kind: 'peer', name: peer.name } : null;
  }

  const state = `${recovering}|${outmatched}|${fleeing}|${why}`;
  if (state !== saidState) {
    saidState = state;
    crewLog.post(TAG, 'survival', {
      hp: Math.round(hp * 10) / 10, recovering, outmatched, fleeing, why, threats: candidates.length,
      goal: goal ? goal.kind : null, to: goal && goal.name ? goal.name : null,
    });
  }

  writeBoard({
    at: now,
    hp,
    recovering,
    outmatched,
    fleeing,
    clear,
    why,
    goal,
    calling: !!distress,
  });
}

// ── SECTION 5: Peers' calls, read by the commander ──

// calls(bot) → Set of mob ids this body answers: every attacker named by a live call from a peer within
// BACKUP_REACH_B, when this body is armed and not itself running or healing.
function calls(bot) {
  const out = new Set();
  const self = bot.entity && bot.entity.position;
  if (!self || recovering) return out;
  if (!['sword', 'axe'].includes(combatUtils.pickBestWeapon(bot).rung)) return out;
  const me = process.env.BOT_ID || 'default';
  const now = Date.now();
  for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}))) {
    if (botId === me || !chair || !chair.distress) continue;
    if (now - chair.distress.at > DISTRESS_FRESH_MS) continue;
    const e = bot.players && bot.players[botId] && bot.players[botId].entity;
    if (!e || !e.position || self.distanceTo(e.position) > BACKUP_REACH_B) continue;
    for (const id of chair.distress.attackers || []) out.add(id);
  }
  return out;
}

// ── SECTION 6: Lifecycle ──

// Attached for the process after the commander (it reads the commander's board) and before the gunner and the
// driver, which read this seat the same tick.
function start(bot) {
  if (attached) return;
  recovering = false;
  outmatched = false;
  running.clear();
  distress = null;
  saidState = null;
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
}

function stop(bot) {
  if (!attached || !tickHandler) return;
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  tickHandler = null;
  attached = false;
  if (distress) { distress = null; _publishDistress(null); }
}

module.exports = {
  start, stop, calls, clearReach,
  FLEE_HP, RETURN_HP, FLEE_CLEAR_B, BACKUP_REACH_B, DISTRESS_FRESH_MS,
};
