// hazard_zones — where a drowned has engaged a body, no body goes again in this world.
//
// A drowned throws a trident for 12 on Hard from about 20 b through a raised shield, and it spawns wherever water is
// dark, so the water it came from will hold more. Every drowned the commander admits as a threat (its aggro test, so
// one sensed through rock in a cave below is not one) marks a disc of radius ZONE_R around the place it stood, and the
// body runs from it (self_preservation). The disc is never re-checked and never lifted while the world lasts.
//
// THE MECHANISM IS spawn_protection's MASK (Law 16): a column inside a zone reads as bedrock to every reader the body
// has, so no route, no scan, no picker and no placement uses it, and no task carries its own check. Two doors, one
// answer: the body's `blockAt`/`findBlocks` (maskReads) and the pathfinder's fast read (voxel_reader, through
// `readerMask`).
//
// THE BASE WINS: a column within BASE_KEEP_B of any sited structure's origin is never masked.
//
// OUTWARD ONLY: a body standing inside a zone reads that zone's ground real only as far in as it stands (EXIT_SLACK_B
// short of its own distance from the centre); every column nearer the centre is masked. Every route and step it takes
// leads out, never deeper, and once it is out the whole disc holds it out.
//
// THE RUN IS NEVER WALLED: while the body runs (self_preservation `fleeing`), the zones it stands in read real, so
// every heading is open to it; the run is clear only once the body is out of every zone. A body standing in three
// zones from one arena had only one narrow heading outward from all three, and a bare drowned killed it pressing a
// masked wall.
//
// THE CREW SHARES IT through the boardroom: this body's own sightings ride its chair (`hazards`), the foreman's chair
// broadcast carries them to every peer, and each body keeps the union in its office `hazard_zones`. Both live in the
// body's headquarters file, so a continue start keeps every zone and a rollback start, which empties those files,
// starts a new world with none.

'use strict';

const hq = require('@kernel/corporate_headquarters');
const crewBoard = require('@api/crew_board');
const crewLog = require('@api/crew_log');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'HAZARD_ZONES';
const ZONE_R = 24;                 // b; beyond the 21 b trident hit measured in the arena
const ZONE_R2 = ZONE_R * ZONE_R;
// A sighting this close to a zone's centre is already covered by it.
const SAME_ZONE_B = ZONE_R / 2;
// A sited structure's origin keeps the columns within this reach unmasked.
const BASE_KEEP_B = 24;
const BASE_KEEP_R2 = BASE_KEEP_B * BASE_KEEP_B;
// The union with the peers' chairs, and this body's sightings, are taken this often.
const TICK_MS = 1000;
// A reader's snapshot is rebuilt at most this often when nothing changed, so a newly sited structure is kept.
const SNAPSHOT_MS = 5000;
// ...and whenever the body has moved this far, so its place in a zone (OUTWARD ONLY) is never a stale one.
const SNAPSHOT_MOVE_B = 1;
// How far nearer the centre than the body stands a column still reads real, for its own footprint and a step's sway.
const EXIT_SLACK_B = 1;
const OFFICE = 'hazard_zones';

let attached = false;
let tickHandler = null;
let lastTick = 0;
let version = 0;   // moves whenever the union changes
// The drowned already marked: one zone per drowned, where it engaged, never one for every place it walks chasing the
// body (a chase onto a base marked a second zone 14 b along the run).
const markedIds = new Set();

function office() {
  return hq.readOffice(OFFICE, { own: [], all: [] }) || { own: [], all: [] };
}

function zoneKey(z) { return `${z.x},${z.z}`; }

// zones() → every zone this body knows: its own and its peers'.
function zones() { return office().all || []; }

// keepDiscs() → the sited structures' origins, every crew's: no zone takes a base's ground.
function keepDiscs() {
  const room = hq.readOffice('building_confrence_room', {}) || {};
  const out = [];
  for (const entry of Object.values(room)) {
    const o = entry && entry.set_buildspot && entry.set_buildspot.transpose_origin;
    if (o && typeof o.x === 'number' && typeof o.z === 'number') out.push({ x: o.x, z: o.z });
  }
  return out;
}

// masked(list, keep, x, z, inner) → this column lies in a zone, outside every base keep, and not on the outward side of
// a body standing in that zone. `inner` maps a zone key to the squared distance from its centre inside which the body's
// own zone stays masked (standingIn).
function masked(list, keep, x, z, inner) {
  let inZone = false;
  for (const zn of list) {
    const dx = x - zn.x, dz = z - zn.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > ZONE_R2) continue;
    const floor2 = inner ? inner.get(zoneKey(zn)) : undefined;
    if (floor2 !== undefined && d2 >= floor2) continue;
    inZone = true;
    break;
  }
  if (!inZone) return false;
  for (const k of keep) {
    const dx = x - k.x, dz = z - k.z;
    if (dx * dx + dz * dz <= BASE_KEEP_R2) return false;
  }
  return true;
}

// standingIn(bot, list, running) → Map of zone key → squared distance from the centre inside which the body's own
// zone stays masked: EXIT_SLACK_B short of where the body stands, or none while it runs.
function standingIn(bot, list, running) {
  const me = bot.entity && bot.entity.position;
  const out = new Map();
  if (!me) return out;
  for (const zn of list) {
    const d = Math.hypot(me.x - zn.x, me.z - zn.z);
    if (d <= ZONE_R) { const f = running ? 0 : Math.max(0, d - EXIT_SLACK_B); out.set(zoneKey(zn), f * f); }
  }
  return out;
}

// insideZone(bot) → the body stands on ground a zone holds (outside every base keep): it has not yet got out.
function insideZone(bot) {
  const me = bot.entity && bot.entity.position;
  if (!me) return false;
  const list = zones();
  return list.length > 0 && masked(list, keepDiscs(), Math.floor(me.x), Math.floor(me.z), null);
}

// isHazard(bot, x, z) → the body's own read of a column, as maskReads answers it: through one cached snapshot per body,
// the same one the fast reader builds, since the body's reads run in scans of thousands.
const _bodyMasks = new WeakMap();
function isHazard(bot, x, z) {
  let m = _bodyMasks.get(bot);
  if (!m) { m = readerMask(bot); _bodyMasks.set(bot, m); }
  m.refresh();
  const fx = Math.floor(x), fz = Math.floor(z);
  return m.on && fx >= m.minX && fx <= m.maxX && fz >= m.minZ && fz <= m.maxZ && m.masks(fx, fz);
}

// readerMask(bot) → the fast reader's view: { refresh(), on, stateId, minX, maxX, minZ, maxZ, masks(x, z) }. The zones,
// the base keeps and the body's place in the zones it stands in are copied at refresh, so a read is arithmetic. The
// snapshot is rebuilt at most every SNAPSHOT_MS, so a body walking out sees more of its zone real by that step.
function readerMask(bot) {
  const m = { on: false, enrolled: false, running: false, atX: NaN, atZ: NaN, stateId: -1, minX: 0, maxX: 0, minZ: 0, maxZ: 0, list: [], keep: [], inner: null, version: -1, builtAt: 0 };
  m.refresh = () => {
    const enrolled = !!bot._hazardMaskInstalled;
    const survival = crewBoard.readSurvival();
    const running = !!(survival && survival.fleeing);
    const now = Date.now();
    const me = bot.entity && bot.entity.position;
    const moved = me ? Math.hypot(me.x - m.atX, me.z - m.atZ) : 0;
    if (m.version === version && now - m.builtAt < SNAPSHOT_MS && enrolled === m.enrolled && running === m.running
      && !(moved >= SNAPSHOT_MOVE_B)) return;
    m.version = version; m.builtAt = now; m.enrolled = enrolled; m.running = running;
    if (me) { m.atX = me.x; m.atZ = me.z; }
    const list = enrolled ? zones() : [];
    m.on = enrolled && list.length > 0;
    if (!m.on) return;
    m.list = list.map((zn) => ({ x: zn.x, z: zn.z }));
    m.keep = keepDiscs();
    m.inner = standingIn(bot, list, running);
    m.minX = Math.min(...list.map((zn) => zn.x)) - ZONE_R; m.maxX = Math.max(...list.map((zn) => zn.x)) + ZONE_R;
    m.minZ = Math.min(...list.map((zn) => zn.z)) - ZONE_R; m.maxZ = Math.max(...list.map((zn) => zn.z)) + ZONE_R;
    m.stateId = require('@perception/spawn_protection').maskStateId(bot);
  };
  m.masks = (x, z) => masked(m.list, m.keep, x, z, m.inner);
  return m;
}

// maskReads(bot) — wraps the body's block reads, after spawn_protection's. Idempotent.
function maskReads(bot) {
  if (!bot || typeof bot.blockAt !== 'function') {
    throw new Error('[hazard_zones] CODING VIOLATION: maskReads called with no body to mask.');
  }
  if (bot._hazardMaskInstalled) return;
  bot._hazardMaskInstalled = true;
  const sp = require('@perception/spawn_protection');
  const innerBlockAt = bot.blockAt.bind(bot);
  bot.blockAt = (point, extraInfo) => {
    if (point && isHazard(bot, point.x, point.z)) return sp.maskBlockAt(point.x, point.y, point.z);
    return innerBlockAt(point, extraInfo);
  };
  const innerFindBlocks = bot.findBlocks.bind(bot);
  bot.findBlocks = (options) => {
    const want = (options && options.count) || 1;
    const found = innerFindBlocks({ ...(options || {}), count: want + 24 });
    const kept = found.filter((p) => !isHazard(bot, p.x, p.z));
    return kept.length > want ? kept.slice(0, want) : kept;
  };
  bot.findBlock = (options) => {
    const found = bot.findBlocks({ ...(options || {}), count: 1 });
    return found.length ? bot.blockAt(found[0]) : null;
  };
}

// note(bot, entity) — a drowned engaged: a new zone unless one already covers the place.
function note(bot, entity) {
  if (markedIds.has(entity.id)) return;
  markedIds.add(entity.id);
  const p = entity.position;
  const book = office();
  const all = book.all || [];
  if (all.some((zn) => Math.hypot(p.x - zn.x, p.z - zn.z) <= SAME_ZONE_B)) return;
  const zn = { x: Math.floor(p.x), z: Math.floor(p.z), y: Math.floor(p.y), r: ZONE_R, at: Date.now(), by: process.env.BOT_ID || 'default' };
  const own = [...(book.own || []), zn];
  hq.writeOffice(OFFICE, { own, all: [...all, zn] });
  version++;
  publish(own);
  crewLog.post(TAG, 'zone', { subject: `drowned#${entity.id}`, state: 'marked', at: `${zn.x},${zn.y},${zn.z}`, r: ZONE_R, zones: all.length + 1 });
}

function publish(own) {
  const me = process.env.BOT_ID || 'default';
  const chair = hq.readBoardroomChair(me, {}) || {};
  hq.writeBoardroomChair(me, { ...chair, hazards: own });
  guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}

// merge() — the peers' zones joined into this body's union.
function merge() {
  const book = office();
  const all = book.all || [];
  const known = new Set(all.map(zoneKey));
  const added = [];
  for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}))) {
    if (botId === (process.env.BOT_ID || 'default') || !chair || !Array.isArray(chair.hazards)) continue;
    for (const zn of chair.hazards) {
      if (!zn || typeof zn.x !== 'number' || typeof zn.z !== 'number' || known.has(zoneKey(zn))) continue;
      known.add(zoneKey(zn));
      added.push(zn);
    }
  }
  if (!added.length) return;
  hq.writeOffice(OFFICE, { own: book.own || [], all: [...all, ...added] });
  version++;
  crewLog.post(TAG, 'zone', { state: 'learned', from: added.map((zn) => zn.by).join('+'), count: added.length, zones: all.length + added.length });
}

function onPhysicsTick(bot) {
  const now = Date.now();
  if (now - lastTick < TICK_MS) return;
  lastTick = now;
  // The admitted threats only: a drowned that has engaged the body, never one merely loaded in a cave below.
  for (const h of crewBoard.readCommander().active || []) {
    if (h.name === 'drowned' && h.entity && h.entity.position) note(bot, h.entity);
  }
  merge();
}

function start(bot) {
  if (attached) return;
  // This body's sightings ride its chair from the first broadcast, so a peer raised later still learns them.
  const own = office().own || [];
  if (own.length) publish(own);
  markedIds.clear();
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
}

function stop(bot) {
  if (!attached || !tickHandler) return;
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  tickHandler = null;
  attached = false;
}

module.exports = { start, stop, maskReads, readerMask, isHazard, insideZone, zones, ZONE_R, BASE_KEEP_B };
