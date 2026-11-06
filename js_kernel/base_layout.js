// js_kernel/base_layout.js — THE BASE'S LIGHTS: TORCH POSTS OVER THE GROUND AS IT STANDS.
//
// Every crew lights its base with one generated blueprint, its spawn proofing (SPAWN_PROOFING): torches on posts standing on the
// ground round its structures, with no earthwork (architect_config.BASE_LIGHTS says why). The posts are painted once,
// when the base is sited, over the ground the survey read (paintLights), and ride on the spawn proofing's site row (`lights`);
// the blueprint is drawn from that row (proofingBuilding), so the posts the body builds, the posts the keeper checks and
// the posts the siting proved lit are one list (Law 16).
//
//   THE AREA      the box round every sited footprint, widened by BASE_LIGHTS.margin
//   STAND CELLS   the air over each land column of the area outside every footprint, its ground no more than
//                 BASE_LIGHTS.deep under the area's middle ground height: where a hostile could spawn on the base
//   THE POSTS     a post (`post_block`) one over the ground and a torch on it, on a land column with no trunk,
//                 BASE_LIGHTS.ring or more from every footprint and clear of every other post and its stand (two
//                 blocks for a grid post, one for a post set where the grid left dark),
//                 with a land column beside it or at its corner, a step up or down at most, that a body stands on to
//                 place it (its stand)
//   THE PAINT     a grid post every `every` blocks (the allowed column nearest each grid point), then a post at the
//                 allowed column nearest each stand cell the posts leave dark (within 4 blocks, else 8), nearest the
//                 area's middle first, until
//                 the game's light rule (light_calculator) lights every stand cell over TORCH_NETWORK.lit_above or
//                 `limit` posts stand; a footprint counts opaque (its build lights itself) and the ground's trees felled
//
// THE ROW. A spawn proofing's transpose origin is the area's north-west corner at the posts' middle ground height; its row's
// `lights` is { w, l, posts: [[x, y, z, sx, sy, sz], …] }, the area's size and each post cell with its stand's ground
// cell, relative to that origin.

'use strict';

const TAG = 'base_layout';
const K = (x, y, z) => `${x},${y},${z}`;
const STEP = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];   // the four sides first, then the corners
const BUILD_HEIGHT = 24;   // how far over its ground a footprint counts opaque to the paint's light

const cfg = () => require('@thinking/architect_config');

// paintLights(g, boxes, keep) → { origin, lights, rect, stands, dark, grid, added }: the base's torch posts over the surface
// read `g` (footprint_survey.readSurface) round the footprint boxes, in world cells, and their row form. `keep`: ground
// cells { x, z } no post or stand may take (a pen's lane); they are still lit.
function paintLights(g, boxes, keep = []) {
  const kept = new Set(keep.map(c => `${c.x},${c.z}`));
  const { BASE_LIGHTS, TORCH_NETWORK } = cfg();
  const { lightField } = require('@utils/calculators/light_calculator');
  const { LAND } = require('@utils/footprint_survey');
  const m = BASE_LIGHTS.margin;
  const rect = {
    minX: Math.min(...boxes.map(b => b.minX)) - m, maxX: Math.max(...boxes.map(b => b.maxX)) + m,
    minZ: Math.min(...boxes.map(b => b.minZ)) - m, maxZ: Math.max(...boxes.map(b => b.maxZ)) + m,
  };
  const col = (x, z) => (x < g.x0 || z < g.z0 || x >= g.x0 + g.W || z >= g.z0 + g.D) ? -1 : (z - g.z0) * g.W + (x - g.x0);
  // A spawn-protected column (`g.masked`) is no ground: it reads as bedrock up to the build limit, and a post painted on
  // it stands at the ceiling, where no body can reach.
  const unseen = (i) => !!(g.masked && g.masked[i]);
  const land = (x, z) => { const i = col(x, z); return i >= 0 && g.kind[i] === LAND && !unseen(i); };
  const gapToBoxes = (x, z) => Math.min(...boxes.map(b => Math.max(b.minX - x, x - b.maxX, b.minZ - z, z - b.maxZ) - 1));
  const inside = (x, z) => gapToBoxes(x, z) < 0;
  const posts = new Map();   // "x,z" → { x, y, z, stand }
  const held = new Set();    // "x,z" of every post and stand column
  const nameAt = (x, y, z) => {
    const i = col(x, z);
    if (i < 0 || unseen(i)) return null;
    const p = posts.get(`${x},${z}`);
    if (p && y === p.y) return BASE_LIGHTS.post_block;
    if (p && y === p.y + 1) return 'torch';
    const h = g.height[i];
    if (inside(x, z)) return y <= h + BUILD_HEIGHT ? 'stone' : 'air';
    if (y <= h) return g.kind[i] === LAND ? 'stone' : 'water';
    return 'air';
  };
  const blockAt = (x, y, z) => { const n = nameAt(x, y, z); return n ? { name: n } : null; };
  const open = [];
  for (let x = rect.minX; x <= rect.maxX; x++) {
    for (let z = rect.minZ; z <= rect.maxZ; z++) if (land(x, z) && !inside(x, z)) open.push({ x, y: g.height[col(x, z)] + 1, z });
  }
  const heights = open.map(c => c.y).sort((a, b) => a - b);
  const floorY = heights.length ? heights[Math.floor((heights.length - 1) / 2)] - BASE_LIGHTS.deep : -Infinity;
  const stands = open.filter(c => c.y >= floorY);
  const want = new Set(stands.map(s => K(s.x, s.y, s.z)));
  const near = (x, z, r) => { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (held.has(`${x + dx},${z + dz}`)) return true; return false; };
  // standOf(x, z) → the ground cell beside the post column, or at its corner, a body stands on, or null.
  const standOf = (x, z) => {
    const h = g.height[col(x, z)];
    for (const [dx, dz] of STEP) {
      const sx = x + dx, sz = z + dz, i = col(sx, sz);
      if (i < 0 || g.kind[i] !== LAND || unseen(i) || g.trunk[i] || kept.has(`${sx},${sz}`) || gapToBoxes(sx, sz) < 1 || near(sx, sz, 1) || Math.abs(g.height[i] - h) > 1) continue;
      return { x: sx, y: g.height[i], z: sz };
    }
    return null;
  };
  const allowed = (x, z, apart) => {
    const i = col(x, z);
    return i >= 0 && g.kind[i] === LAND && !unseen(i) && !g.trunk[i] && !kept.has(`${x},${z}`) && g.height[i] + 1 >= floorY && gapToBoxes(x, z) >= BASE_LIGHTS.ring && !near(x, z, apart);
  };
  // place(x, z, r, apart) — a post at the allowed column with a stand nearest (x, z), within r and `apart` clear of every
  // other post and stand; false when there is none.
  const lit = new Set();
  const place = (x, z, r, apart) => {
    let best = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const px = x + dx, pz = z + dz;
        if (px < rect.minX || px > rect.maxX || pz < rect.minZ || pz > rect.maxZ || !allowed(px, pz, apart)) continue;
        const d = Math.hypot(dx, dz);
        if (best && d >= best.d) continue;
        const stand = standOf(px, pz);
        if (stand) best = { x: px, z: pz, d, stand };
      }
    }
    if (!best) return false;
    const p = { x: best.x, y: g.height[col(best.x, best.z)] + 1, z: best.z, stand: best.stand };
    posts.set(`${p.x},${p.z}`, p);
    held.add(`${p.x},${p.z}`); held.add(`${p.stand.x},${p.stand.z}`);
    for (const [k] of lightField(blockAt, { x: p.x, y: p.y + 1, z: p.z }, 14, TORCH_NETWORK.lit_above, K, want)) lit.add(k);
    return true;
  };
  const every = BASE_LIGHTS.every, half = Math.floor(every / 2);
  for (let z = rect.minZ + half; z <= rect.maxZ; z += every) for (let x = rect.minX + half; x <= rect.maxX; x += every) place(x, z, half, 2);
  const grid = posts.size;
  const mid = { x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 };
  const byMiddle = (a, b) => Math.hypot(a.x - mid.x, a.z - mid.z) - Math.hypot(b.x - mid.x, b.z - mid.z);
  const passed = new Set();   // dark cells no post could be found for
  while (posts.size < BASE_LIGHTS.limit) {
    const dark = stands.filter(s => !lit.has(K(s.x, s.y, s.z)) && !held.has(`${s.x},${s.z}`) && !passed.has(K(s.x, s.y, s.z))).sort(byMiddle);
    if (!dark.length) break;
    if (!place(dark[0].x, dark[0].z, 4, 1) && !place(dark[0].x, dark[0].z, 8, 1)) passed.add(K(dark[0].x, dark[0].y, dark[0].z));
  }
  // Every field again over the finished posts: a later post's block can shade a cell an earlier torch lit.
  lit.clear();
  for (const p of posts.values()) for (const [k] of lightField(blockAt, { x: p.x, y: p.y + 1, z: p.z }, 14, TORCH_NETWORK.lit_above, K, want)) lit.add(k);
  const dark = stands.filter(s => !lit.has(K(s.x, s.y, s.z)) && !held.has(`${s.x},${s.z}`));
  const list = [...posts.values()].sort((a, b) => a.z - b.z || a.x - b.x);
  const ys = list.map(p => p.y - 1).sort((a, b) => a - b);
  const origin = { x: rect.minX, y: ys.length ? ys[Math.floor((ys.length - 1) / 2)] : g.height[col(rect.minX, rect.minZ)] || 0, z: rect.minZ };
  const lights = {
    w: rect.maxX - rect.minX + 1, l: rect.maxZ - rect.minZ + 1,
    posts: list.map(p => [p.x - origin.x, p.y - origin.y, p.z - origin.z, p.stand.x - origin.x, p.stand.y - origin.y, p.stand.z - origin.z]),
  };
  return { origin, lights, rect, stands: stands.length, dark: dark.map(s => K(s.x, s.y, s.z)), grid, added: list.length - grid };
}

// ── WHICH LIGHTS THIS PROCESS BUILDS ──────────────────────────────────────────────────────────────────
// A process writing the site learns the spawn proofing's lights from the row (site_chairs), the integrity keeper from each site it
// reads; a body reads them from its own locked spawn-proofing chair.
let _learned = null;   // { id, origin, lights }
function learnProofing(name, site) {
  if (name !== cfg().SPAWN_PROOFING || !site || !site.transpose_origin || !site.lights) return;
  const id = JSON.stringify([site.transpose_origin, site.lights]);
  if (_learned && _learned.id !== id) throw new Error(`[${TAG}] CODING VIOLATION: the spawn proofing was drawn from one site in this process and is now named another; one process builds one base.`);
  _learned = { id, origin: site.transpose_origin, lights: site.lights };
}
function lightsOf() {
  if (_learned) return _learned;
  const site = require('@kernel/corporate_headquarters').readBuildingChair(cfg().SPAWN_PROOFING, 'set_buildspot');
  if (!site || !site.lights) throw new Error(`[${TAG}] CODING VIOLATION: the spawn proofing was asked for before its site carries its lights; spawn proofing is built only once it is sited.`);
  learnProofing(cfg().SPAWN_PROOFING, site);
  return _learned;
}

// proofingTorches(site) → { rect, torches } in world cells for a spawn-proofing site: the area's box and every torch cell.
function proofingTorches(site) {
  const o = site.transpose_origin, L = site.lights;
  return {
    rect: { minX: o.x, maxX: o.x + L.w - 1, minZ: o.z, maxZ: o.z + L.l - 1 },
    torches: L.posts.map(([x, y, z]) => ({ x: o.x + x, y: o.y + y + 1, z: o.z + z })),
  };
}

// ── THE PAD AS A BLUEPRINT ────────────────────────────────────────────────────────────────────────────
// proofingBuilding() → the base's spawn proofing as a blueprint entry (SPAWN_PROOFING names it), built, surveyed and repaired like any
// hand-authored one. One anchor per post, standing on the post's stand: the ground under the post, the post, its
// torch, the stand's ground and the two cells of air a body fills there. The anchors are built in sections of
// BASE_LIGHTS.trip posts (proofingSections), so one claim stages and places a trip's worth instead of one post.
const _pads = new Map();

// proofingSections(posts, trip) → the anchor indices in sections of `trip`: a walk from the first post to the nearest
// unbuilt post after it, by its stand, cut into the fewest even runs of at most `trip`, so each trip's posts lie
// along one short walk.
function proofingSections(posts, trip) {
  const left = new Set(posts.map((_, i) => i));
  const walk = [];
  let at = 0;
  while (left.size) {
    left.delete(at);
    walk.push(at);
    let next = null, best = Infinity;
    for (const i of left) {
      const d = Math.hypot(posts[i][3] - posts[at][3], posts[i][5] - posts[at][5]);
      if (d < best) { best = d; next = i; }
    }
    if (next === null) break;
    at = next;
  }
  const runs = Math.ceil(walk.length / trip), size = Math.ceil(walk.length / runs);
  const sections = [];
  for (let i = 0; i < walk.length; i += size) sections.push(walk.slice(i, i + size));
  return sections;
}
function proofingBuilding() {
  const { id, lights } = lightsOf();
  if (_pads.has(id)) return _pads.get(id);
  const { SPAWN_PROOFING: name, BASE_LIGHTS } = cfg();
  if (!lights.posts.length) throw new Error(`[${TAG}] CODING VIOLATION: the spawn proofing holds no post.`);
  const declared = new Map();
  const anchors = lights.posts.map(([x, y, z, sx, sy, sz]) => {
    const voxels = [[x, y - 1, z, 'natural_block'], [x, y, z, BASE_LIGHTS.post_block], [x, y + 1, z, 'torch'],
      [sx, sy, sz, 'natural_block'], [sx, sy + 1, sz, 'air'], [sx, sy + 2, sz, 'air']];
    for (const [vx, vy, vz, t] of voxels) {
      const k = K(vx, vy, vz);
      if (declared.has(k) && declared.get(k) !== t) throw new Error(`[${TAG}] CODING VIOLATION: the spawn proofing declares (${k}) as both ${declared.get(k)} and ${t}.`);
      declared.set(k, t);
    }
    return { position: [sx, sy, sz], voxels };
  });
  const ys = [...declared.keys()].map(k => Number(k.split(',')[1]));
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const entry = {
    name, generated: true,
    description: `The base's lights (base_layout): ${lights.posts.length} torch(es) on ${BASE_LIGHTS.post_block} posts over the ground of a ${lights.w}×${lights.l} area round its structures.`,
    dimensions: { w: lights.w, h: yMax - yMin + 1, l: lights.l, yMin, yMax },
    transpose_origin: { x: 0, y: 0, z: 0 }, transpose_origin_cell: { x: 0, y: 0, z: 0 },
    default_facing: 'north', anchors, unassigned_voxels: [],
    sections: proofingSections(lights.posts, BASE_LIGHTS.trip),
    parallel_sections: true,   // sections stand apart: assessors/building posts a seat for each one the pool pays for
  };
  _pads.set(id, entry);
  return entry;
}

// lightPointsOf(building, origin) → the blueprint's declared wall torches { source, attach } placed at `origin`.
function lightPointsOf(building, origin) {
  const { placeOffset } = require('@perception/blueprint_survey');
  const c = building.transpose_origin || { x: 0, y: 0, z: 0 };
  return (building.light_points || []).map(p => ({ source: placeOffset(origin, c, p.position), attach: placeOffset(origin, c, p.wall) }));
}

module.exports = { paintLights, learnProofing, proofingTorches, proofingBuilding, lightPointsOf };
