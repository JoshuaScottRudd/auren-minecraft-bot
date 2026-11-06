// module: blast_mender
// purpose: a creeper's blast on the base is mended, its top layer only: the ground surface the
//          blast took out of the spawn-proofed ground is laid again with a throwaway block, and the hole beneath it is left. Outside the
//          spawn-proofed ground a blast does little, and nothing is mended there. A structure the blast broke is its blueprint's to
//          repair (the integrity keeper), not this module's.
//
// THE SNAPSHOT IS TAKEN AS THE CREEPER SWELLS: the surface within MEND_RADIUS of a swelling creeper standing on the
// spawn-proofed ground is recorded (topmost solid cell of each column, open above), and refreshed while the swell lasts. When the
// server announces the blast at that creeper, every recorded cell that now holds no block is owed. The body that saw
// it lays them after its wave ends (battle_stations), rim first, so each block gives the next one its face.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const crewBoard = require('@api/crew_board');
const hq = require('@kernel/corporate_headquarters');
const { performPlace } = require('@utils/movement/place_authority');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');

const TAG = 'blast_mender';

// A power-3 blast breaks blocks out to about three blocks from its centre; one more covers a creeper that moved
// while its snapshot was refreshed.
const MEND_RADIUS = 4;
const SURFACE_UP = 2, SURFACE_DOWN = 4;    // the column read above and below the creeper's feet
const REFRESH_MS = 500;
const BLAST_MATCH_B = 2.5;                 // a blast centre this near a swelling creeper is that creeper's
const SETTLE_MS = 600;                     // the server's block updates land after the blast packet
const MAX_OWED = 64;
// Ground blocks first (they read as ground and none of them falls into the hole beneath), then the fleet's
// throwaway order.
const GROUND_PREFS = ['dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite',
  'granite', 'tuff', 'netherrack'];

let attached = false;
let tickHandler = null;
let snaps = new Map();     // creeper id → { at: Vec3, cells: Map 'x,z' column → {x,y,z,name}, readAt }
let owed = new Map();      // key → { x, y, z, name }

const key = (x, y, z) => `${x},${y},${z}`;

// The spawn proofing's rectangle (base_layout), or null while the base is not sited.
function proofingRect() {
  const { SPAWN_PROOFING } = require('@thinking/architect_config');
  const site = hq.readBuildingChair(SPAWN_PROOFING, 'set_buildspot');
  if (!site || !site.transpose_origin || !site.lights) return null;
  return require('@kernel/base_layout').proofingTorches(site).rect;
}

function solid(b) { return !!b && b.boundingBox === 'block'; }

// surfaceAround(bot, at, rect, into) — record each spawn-proofed column's top cell within MEND_RADIUS of `at`; a cell already
// recorded keeps its first reading (the ground before the swell), so a block set during the swell (the gunner's blast
// wall) is never read as ground.
function surfaceAround(bot, at, rect, into) {
  const cx = Math.floor(at.x), cy = Math.floor(at.y), cz = Math.floor(at.z);
  for (let dx = -MEND_RADIUS; dx <= MEND_RADIUS; dx++) {
    for (let dz = -MEND_RADIUS; dz <= MEND_RADIUS; dz++) {
      if (dx * dx + dz * dz > MEND_RADIUS * MEND_RADIUS) continue;
      const x = cx + dx, z = cz + dz;
      if (x < rect.minX || x > rect.maxX || z < rect.minZ || z > rect.maxZ) continue;
      for (let y = cy + SURFACE_UP; y >= cy - SURFACE_DOWN; y--) {
        if (into.has(`${x},${z}`)) break;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) break;
        if (!solid(b)) continue;
        if (solid(bot.blockAt(new Vec3(x, y + 1, z)))) break;   // roofed: not the open surface
        const col = `${x},${z}`;
        if (!into.has(col)) into.set(col, { x, y, z, name: b.name });
        break;
      }
    }
  }
}

function onPhysicsTick(bot) {
  const board = crewBoard.readCommander();
  const now = Date.now();
  const live = new Set();
  let rect;
  for (const h of board.hostiles || []) {
    if (h.name !== 'creeper' || !h.swelling || !h.entity || !h.entity.position) continue;
    live.add(h.id);
    const snap = snaps.get(h.id);
    if (snap && now - snap.readAt < REFRESH_MS) { snap.at = h.entity.position.clone(); continue; }
    if (rect === undefined) rect = proofingRect();
    if (!rect) return;
    const s = snap || { at: null, cells: new Map(), readAt: 0 };
    s.at = h.entity.position.clone();
    s.readAt = now;
    surfaceAround(bot, s.at, rect, s.cells);
    if (!snap && s.cells.size) snaps.set(h.id, s);
  }
  // A swell that unwound leaves its snapshot standing a moment, so a blast read late still finds it.
  for (const [id, s] of snaps) if (!live.has(id) && now - s.readAt > 3000) snaps.delete(id);
}

function onExplosion(bot, p) {
  const c = p.center || p;
  if (!Number.isFinite(c.x)) return;
  const at = `(${Math.floor(c.x)},${Math.floor(c.y)},${Math.floor(c.z)})`;
  // Every blast the body hears is stated once, so a mend that never came reads as off the spawn-proofed ground, unmatched, or no loss.
  let matched = false;
  for (const [id, s] of snaps) {
    if (!s.at || Math.hypot(s.at.x - c.x, s.at.y - c.y, s.at.z - c.z) > BLAST_MATCH_B) continue;
    snaps.delete(id);
    matched = true;
    setTimeout(() => {
      // A body the blast killed owes nothing: its death cleared the ledger, and a dead body lays no block.
      if (!bot.entity || !(bot.health > 0)) return;
      let n = 0;
      for (const cell of s.cells.values()) {
        if (solid(bot.blockAt(new Vec3(cell.x, cell.y, cell.z)))) continue;
        if (owed.size >= MAX_OWED) break;
        owed.set(key(cell.x, cell.y, cell.z), cell);
        n++;
      }
      watcher.summary(TAG, `BLAST_ON_PAD creeper#${id} at ${at}: ${n} surface cell(s) owed of ${s.cells.size} recorded.`);
    }, SETTLE_MS);
  }
  if (!matched) watcher.summary(TAG, `BLAST_OFF_PROOFING at ${at}: no spawn-proofing surface was recorded around a swell there (${proofingRect() ? 'spawn proofing sited' : 'no spawn proofing sited'}).`);
}

// anchorOf(bot, cell) → { block, face } for a solid neighbour to click (the rim beside it first, then below).
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
function anchorOf(bot, at) {
  for (const [dx, dy, dz] of DIRS) {
    const b = bot.blockAt(at.offset(dx, dy, dz));
    if (solid(b)) return { block: b, face: new Vec3(-dx, -dy, -dz) };
  }
  return null;
}

function fillItem(bot) {
  const items = bot.inventory.items();
  for (const name of [...GROUND_PREFS, ...BRIDGE_PREFS]) {
    const it = items.find((i) => i.name === name && i.count > 0);
    if (it) return it;
  }
  return null;
}

// owedCount() → cells this body owes the spawn-proofed ground.
function owedCount() { return owed.size; }

// mendable(bot) → the body owes the spawn-proofed ground and carries a block to lay: a mend with no block would discard the job it
// interrupts for nothing.
function mendable(bot) { return owed.size > 0 && !!fillItem(bot); }

// mend(bot) → { laid, failed, left } — lay every owed cell this body can, rim first. Each cell is tried once; one the
// world already filled is dropped.
async function mend(bot) {
  const out = { laid: 0, failed: 0, left: 0, why: null };
  if (!owed.size) return out;
  const locomotion = require('@locomotion/locomotion_dispatcher');
  const tried = new Set();
  while (owed.size) {
    for (const [k, c] of owed) if (solid(bot.blockAt(new Vec3(c.x, c.y, c.z)))) owed.delete(k);
    const me = bot.entity && bot.entity.position;
    if (!me) break;
    // The nearest cell with a face to click, among those not tried yet.
    let next = null;
    for (const [k, c] of owed) {
      if (tried.has(k)) continue;
      const at = new Vec3(c.x, c.y, c.z);
      const anchor = anchorOf(bot, at);
      if (!anchor) continue;
      const d = me.distanceTo(at);
      if (!next || d < next.d) next = { k, at, anchor, d };
    }
    if (!next) break;
    tried.add(next.k);
    const item = fillItem(bot);
    if (!item) { out.why = 'no_block'; break; }
    const nav = await locomotion.goTo({ x: next.at.x, y: next.at.y, z: next.at.z, require_los: true, purpose: 'blast_mend' });
    if (!nav || nav.arrived === false) { out.failed++; continue; }
    const anchor = anchorOf(bot, next.at);
    if (!anchor || solid(bot.blockAt(next.at))) { owed.delete(next.k); continue; }
    const r = await performPlace(bot, next.at, anchor.block, anchor.face, item.name, TAG);
    if (r && r.ok) { out.laid++; owed.delete(next.k); } else out.failed++;
  }
  out.left = owed.size;
  // What no face reaches, or no body could stand to lay, is left to the next blast's mend rather than held forever.
  if (out.left && !out.why) { out.why = 'unreached'; owed.clear(); }
  return out;
}

function start(bot) {
  if (attached) return;
  snaps = new Map();
  owed = new Map();
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  if (bot._client) bot._client.on('explosion', (p) => onExplosion(bot, p));
  bot.on('death', () => { snaps = new Map(); owed = new Map(); });
  attached = true;
}

module.exports = { start, mend, owedCount, mendable, MEND_RADIUS };
