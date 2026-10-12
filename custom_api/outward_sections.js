// api: outward_sections
// purpose: walks a body out of ground that holds none of a product, to the middle of the next section of
//          the world that product is still open in. The caller searches once, where the walk ended.
//          Nothing here remembers where a tree or a block is (Invariant B).
//
// THE GRID. Every point is arithmetic from one reference: the anchor of the crew's home structure (the
// laydown yard for a builder crew, where its idle bodies stand). A section is a square two view-distances
// wide — what one body has loaded round itself — and section 0|0 is centred on that anchor. Sections are
// taken ring by ring, each ring clockwise from due north.
//
// THE WALK. The section's centre is a reference point, and the line to it a bearing: the body goes toward
// it in hops, each landing on dry ground it can stand on, on the line or up to 48 blocks to either side.
// The walk ends at the centre, or where two hops running gained no ground toward it.
//
// WHAT A SECTION IS COUNTED AS, per product for `empty`, for every product for `impassable`:
//   empty[product] — a body ended its walk inside the section, searched there and found none.
//   impassable     — a body's walk ended before it got inside the section.
//
// SHARED through each body's own boardroom chair (field `outward_sections`), merged across every chair
// on read, so it rides the ordinary chair broadcast.
//
// Returns from advance(): { exhausted:true } when every section inside MAX_RINGS is counted out, else
// { section, ring, search } — `search` true when the body stands inside the section to search from.

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const { classifyFloor } = require('@utils/movement/terrain_predicates');
const { readTransposeOrigin } = require('@utils/fragment_utils');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'outward_sections';
const CHAIR_FIELD = 'outward_sections';

const MAX_RINGS = 4;        // rings of sections searched before a product is called exhausted
const HOP_REACHES = [96, 64, 32, 16];   // blocks per hop, longest first; every one is inside loaded ground
const SIDESTEPS = [0, 16, -16, 32, -32, 48, -48];   // how far off the line a hop may land, nearest the line first
const ARRIVE = 32;         // flat distance at which a body counts as standing at a point
const MIN_GAIN = 8;         // ground a hop must gain toward the centre to count as progress
const STALLS_TO_END = 2;
const COLUMN_REACH = 40;    // how far above and below the body's own level a stand cell is looked for
const NEARBY = [0, 2, -2, 4, -4, 6, -6];

// Where this body's last walk ended, so the search made from there can count the section.
let _walked = null;

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function ringOf(r) {
  const out = [];
  for (let i = 0; i <= r; i++) out.push([i, -r]);         // north side, eastward from due north
  for (let j = -r + 1; j <= r; j++) out.push([r, j]);     // east side, southward
  for (let i = r - 1; i >= -r; i--) out.push([i, r]);     // south side, westward
  for (let j = r - 1; j >= -r; j--) out.push([-r, j]);    // west side, northward
  for (let i = -r + 1; i <= -1; i++) out.push([i, -r]);   // north side, back to due north
  return out;
}

function grid(bot) {
  const home = readTransposeOrigin(require('@kernel/bot_mandate').homeBlueprint());
  if (!home) return null;
  const vd = bot.game?.serverViewDistance;
  if (!Number.isFinite(vd) || vd <= 0) {
    throw new Error(`[${TAG}] CODING VIOLATION: the server stated no view distance (got ${vd}), so a section has no size.`);
  }
  const size = vd * 16 * 2;
  return {
    keyAt: p => `${Math.round((p.x - home.x) / size)}|${Math.round((p.z - home.z) / size)}`,
    centre: (i, j) => ({ x: home.x + i * size, z: home.z + j * size }),
  };
}

function notes() {
  const merged = {};
  for (const chair of Object.values(hq.getFullBoardroom({}) || {})) {
    for (const [key, n] of Object.entries(chair?.[CHAIR_FIELD] || {})) {
      const m = merged[key] || (merged[key] = { impassable: false, empty: {} });
      if (n.impassable) m.impassable = true;
      for (const product of Object.keys(n.empty || {})) m.empty[product] = true;
    }
  }
  return merged;
}

function note(key, change) {
  const botId = process.env.BOT_ID || 'default';
  const chair = hq.readBoardroomChair(botId, {}) || {};
  const mine = chair[CHAIR_FIELD] || (chair[CHAIR_FIELD] = {});
  change(mine[key] || (mine[key] = { empty: {} }));
  hq.writeBoardroomChair(botId, chair);
  guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());
}

function nextOpen(all, product) {
  for (let r = 1; r <= MAX_RINGS; r++) {
    for (const [i, j] of ringOf(r)) {
      const n = all[`${i}|${j}`];
      if (n && (n.impassable || n.empty[product])) continue;
      return { i, j, ring: r, key: `${i}|${j}` };
    }
  }
  return null;
}

// A cell a body can stand in on dry ground: floor it can walk on, feet out of water.
function standCell(bot, x, y, z) {
  if (classifyFloor(bot, bot.blockAt(new Vec3(x, y - 1, z))) === null) return false;
  return bot.blockAt(new Vec3(x, y, z))?.name !== 'water';
}

function standNear(bot, x, z, refY) {
  for (const ox of NEARBY) {
    for (const oz of NEARBY) {
      for (let d = 0; d <= COLUMN_REACH; d++) {
        for (const y of d === 0 ? [refY] : [refY + d, refY - d]) {
          if (standCell(bot, x + ox, y, z + oz)) return { x: x + ox, y, z: z + oz };
        }
      }
    }
  }
  return null;
}

async function hopToward(bot, goal) {
  const feet = bot.entity.position.floored();
  const before = flat(feet, goal);
  const dispatcher = require('@locomotion/locomotion_dispatcher');
  const ux = before < 1 ? 0 : (goal.x - feet.x) / before, uz = before < 1 ? 0 : (goal.z - feet.z) / before;
  const cellFor = () => {
    for (const reach of before < 1 ? [] : HOP_REACHES) {
      const step = Math.min(reach, before);
      for (const side of SIDESTEPS) {
        const cell = standNear(bot, Math.round(feet.x + ux * step - uz * side), Math.round(feet.z + uz * step + ux * side), feet.y);
        if (cell) return cell;
      }
    }
    return null;
  };
  const cell = cellFor();
  if (cell) await dispatcher.goTo(cell);
  return Math.round(before - flat(bot.entity.position, goal));
}

// How long a body that walked out stays out is the walk calculator's (yield_pledge_calculator.walkOwed),
// asked by the caller that banks the trip.
//
// advance(bot, product) — called when a search where the body stands found none of `product`.
async function advance(bot, product) {
  const g = grid(bot);
  if (!g) return { exhausted: true, reason: 'no_home' };
  const start = bot.entity.position.floored();

  let target = nextOpen(notes(), product);
  if (target && _walked && _walked.key === target.key && flat(start, _walked.at) <= ARRIVE) {
    note(target.key, n => { n.empty[product] = true; });
    watcher.summary(TAG, `📊 OUTWARD_SECTION section=${target.key} ring=${target.ring} counted=empty product=${product} searched_from=(${start.x},${start.y},${start.z})`);
    target = nextOpen(notes(), product);
  }
  if (!target) return { exhausted: true, reason: 'every_section_counted_out' };

  const centre = g.centre(target.i, target.j);
  let hops = 0;
  for (let stalls = 0; flat(bot.entity.position, centre) > ARRIVE && stalls < STALLS_TO_END; hops++) {
    stalls = await hopToward(bot, centre) < MIN_GAIN ? stalls + 1 : 0;
  }
  const end = bot.entity.position.floored();
  const left = Math.round(flat(end, centre));
  const inside = g.keyAt(end) === target.key;
  watcher.summary(TAG, `📊 OUTWARD_WALK product=${product} section=${target.key} ring=${target.ring} centre=(${centre.x},${centre.z}) from=(${start.x},${start.y},${start.z}) to=(${end.x},${end.y},${end.z}) hops=${hops} left=${left} inside=${inside}`);

  if (!inside) {
    note(target.key, n => { n.impassable = true; });
    watcher.warn(TAG, `📊 OUTWARD_SECTION section=${target.key} ring=${target.ring} counted=impassable stopped_at=(${end.x},${end.y},${end.z}) left=${left}`);
    return { section: target.key, ring: target.ring, search: false };
  }
  _walked = { key: target.key, at: end };
  return { section: target.key, ring: target.ring, search: true };
}

module.exports = { advance, MAX_RINGS };
