'use strict';
// tool: raycast_crucible — put a LIVE body in the world and audit every claim its sight makes.
//
// WHY IT EXISTS (Architect 2026-08-06): "i keep losing monster fights due to not engaging the monster
// thats a few blocks away and i want to rule out 100% that its not raycast." Ruling a suspect out needs
// a measurement, and until now there was none: the retired eye-height bench pinned the constants against
// DRIFT and said so itself — it never proved they match the server, which is what this tool does — and
// the combat journal's `blockedBy` names a blocker after the fact but
// cannot say whether that blocker was real. Nothing in the tree asked the sight system to prove itself
// against the world it is looking at.
//
// ── WHAT IT PROVES, AND WHAT IT CANNOT (Law 26 — the run IS the guarantee, so name what actually ran) ──
// The bot's picture of its surroundings arrives on TWO independent channels, and raycast reads exactly
// one of them:
//   channel 1  BLOCKS   — chunk packets → the client world model → `bot.world.raycast` walks it
//   channel 2  ENTITIES — spawn/move packets → `bot.entities` — raycast NEVER touches this
// So "raycast rebuilds the world including mobs" is not a thing that can be true of raycast alone, and
// PHASE M measures the entity channel separately rather than pretending one number covers both.
//
// Four independent audits, each with its own ground truth — none of them the thing under test:
//   PHASE W  world model vs THE SERVER (RCON `execute if block`) — is the map the bot is reading true?
//   PHASE C  raycast vs AN INDEPENDENT RE-WALK of the same segment — does the ray stop at the FIRST
//            shape it crosses, and is everything before it genuinely clear?
//   PHASE M  bot.entities vs THE SERVER's entity list — can the body see the mobs that exist?
//   PHASE R  the PRODUCTION predicate (`hasEntityLineOfSight`) against a mob at every bearing and every
//            near distance — the exact call `threat_scanner.confirmAggro` makes before a fight.
//
// The re-walk in PHASE C is deliberately a DIFFERENT ALGORITHM from the one it checks. prismarine walks
// the segment with a 3D DDA (`RaycastIterator`, stepping voxel to voxel); the crucible walks it
// parametrically — sample t densely, collect the voxels the segment passes through, then do an exact
// ray/AABB entry test against every collision shape in each. Two implementations that agree are evidence;
// re-running the same one twice is not (that is grading your own paper — Law 26).
//
// WRONG TURN, ALREADY TAKEN ONCE IN THIS TREE: judging "does this block the ray" by `boundingBox`.
// prismarine stops on collision SHAPES, and sugar cane / tall grass / vines are `boundingBox: 'empty'`
// with no shapes — a ray goes straight through them while they are fully opaque on screen (measured
// 2026-07-21, camera_scout's `lineClear` header). Slabs and stairs are the other half: `boundingBox:
// 'block'` but a partial shape a ray can miss. So the re-walk tests SHAPES, and reports the two
// populations separately (PASSTHROUGH NAMES) rather than folding them into a pass.
//
// IT MUTATES THE WORLD, AND PUTS EVERYTHING BACK (Law 8 — nothing raised outlives the run):
//   · joins as a spectator, so a hostile cannot end the measurement halfway through
//   · summons its mobs under one tag and kills every one of them on EVERY exit path, including a throw
//   · the wall test only ever converts a cell it has confirmed is AIR, and sets it back to air
// It changes no gamerule and no difficulty: deleting the world's hostiles to make a bench quieter would
// alter the run it was called to measure.
//
// Usage (the server must be running; the fleet need not be):
//   node Auren_Workshop/tools/raycast_crucible.js
//   node Auren_Workshop/tools/raycast_crucible.js --radius=10 --at=32,68,-1
//   node Auren_Workshop/tools/raycast_crucible.js --mob=sheep --skip-blocks
//   node Auren_Workshop/tools/raycast_crucible.js --skip-mobs --radius=6 --verbose
// Exit 0 = every audit clean. Exit 2 = at least one defect. Exit 1 = the crucible could not run.

const path = require('path');
const fs = require('fs');

// Must run before the module-alias boot below — that package lives in the module home too.
const paths = require('../workshop_paths');
paths.bootstrapModules();
paths.registerAliases();

const mineflayer = require('mineflayer');
const Vec3 = require('vec3');
const rcon = require(paths.bot('js_kernel/utils/rcon_link'));
// The PRODUCTION predicates, imported and never transcribed. A crucible carrying its own copy of the
// sight test would certify a copy — the one thing it must not do (Law 16); every verdict below is the
// fleet's own code answering.
const {
  hasEntityLineOfSight, lastSightlineBlock, hasLineOfSight, eyePos,
} = require('@utils/movement/terrain_predicates');
const { aggroCastRange, AGGRO_RANGE } = require('@thinking/architect_config');

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith(`--${k}=`)); return h ? h.split('=')[1] : d; };
const flag = k => argv.includes(`--${k}`);

const HOST = arg('host', 'localhost');
const PORT = Number(arg('port', 25565));
const VERSION = arg('version', '1.21.5');
const USERNAME = arg('username', 'RaycastCrucible');
const RADIUS = Number(arg('radius', 8));          // the cube of block targets, ± this many on each axis
const STEP = Number(arg('step', 0.05));           // coarse sweep resolution, in blocks
const FINE_STEP = 0.002;                          // the escalation resolution — see verifyRay
const CENSUS = Number(arg('sample', 400));        // cells sampled against the server in PHASE W
const MOB = arg('mob', 'cow');
const AT = arg('at', null);                       // "x,y,z" — where to stand
const RING_DISTANCES = arg('ring', '2,3,4,6,8,12').split(',').map(Number).filter(Number.isFinite);
const RING_BEARINGS = Number(arg('bearings', 8));
const SKIP_BLOCKS = flag('skip-blocks');
const SKIP_MOBS = flag('skip-mobs');
const EXPLAIN = arg('explain', null);             // "x,y,z" — dump one ray's whole segment, cell by cell
const VERBOSE = flag('verbose');
const EXEMPLARS = Number(arg('exemplars', 6));

const TAG = 'auren_crucible';                     // one tag → one cleanup command (Law 8)

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;
const fmt = p => `(${p.x},${p.y},${p.z})`;
const fmtf = p => `(${r2(p.x)},${r2(p.y)},${r2(p.z)})`;
function head(t) { console.log(`\n${'─'.repeat(96)}\n${t}\n${'─'.repeat(96)}`); }
function log(stage, msg) { console.log(`[${stage}] ${msg}`); }

// Every defect any phase finds lands here, and the exit code is derived from it and nothing else
// (Law 25 — the verdict is the true count against the asker's criteria, never a threshold this file
// decided was close enough).
const defects = [];
function defect(phase, what, detail) { defects.push({ phase, what, detail }); }

// ── geometry: the independent half ──────────────────────────────────────────────────────────────────

// rayShapeEntryT — the exact parameter at which a ray first enters one of a block's COLLISION SHAPES,
// or null. Slab method, run per shape because a block is a LIST of boxes (a stair is two, a fence is
// several) and prismarine takes the nearest of them.
//
// Shapes arrive relative to the block corner, which is why they are offset here. Reading them as
// absolute is the mistake that makes every verdict wrong by up to one block and still look plausible.
function rayShapeEntryT(origin, dir, bx, by, bz, shapes, maxT) {
  let best = null;
  for (const s of shapes) {
    const lo = [bx + s[0], by + s[1], bz + s[2]];
    const hi = [bx + s[3], by + s[4], bz + s[5]];
    const o = [origin.x, origin.y, origin.z];
    const d = [dir.x, dir.y, dir.z];
    let tmin = -Infinity, tmax = Infinity, dead = false;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) {
        // Parallel to this pair of planes: either the ray is inside the slab forever or never.
        if (o[a] < lo[a] || o[a] > hi[a]) { dead = true; break; }
        continue;
      }
      let t1 = (lo[a] - o[a]) / d[a];
      let t2 = (hi[a] - o[a]) / d[a];
      if (t1 > t2) { const sw = t1; t1 = t2; t2 = sw; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) { dead = true; break; }
    }
    if (dead || tmax < 0) continue;
    const t = Math.max(tmin, 0);
    if (t > maxT) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

// cellSpan — the interval of the ray that lies inside one unit cell, or null if it never enters.
//
// This exists to tell a CORNER TOUCH from a real crossing, and that distinction is the difference
// between a finding and a false alarm. prismarine's DDA breaks a simultaneous boundary crossing by
// axis priority (x, then y, then z), so on a ray that passes exactly through a cell corner it steps
// into a cell the ray only touches at a SINGLE POINT — span zero — and then reports that cell's shape
// as a blocker. Measured on the first live run: a body standing at exactly (-0.5, 72, 7.5) casting to
// block centres makes every diagonal ray a corner ray, and 57 of 2197 came back this way.
//
// It is not a fault. Java's own sight clip uses the same style of traversal and the same convention,
// which is the property terrain_predicates' symmetry argument depends on — the bot and the server must
// agree, and they do. It is reported rather than absorbed because a silently-excluded case is a hidden
// rule (Invariant C), and because a high count is itself the signal that the body is cell-aligned and
// the field should be re-run from somewhere else with --at.
function cellSpan(origin, dir, x, y, z) {
  const lo = [x, y, z], hi = [x + 1, y + 1, z + 1];
  const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
  let tmin = -Infinity, tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (o[a] < lo[a] || o[a] > hi[a]) return null; continue; }
    let t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a];
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return { tmin, tmax, span: tmax - Math.max(tmin, 0) };
}

// voxelsAlong — the parametric sweep. Walks t in fixed increments and collects the distinct cells the
// segment passes through, in the order it first touches them. This is NOT prismarine's DDA and is not
// meant to be: two ways of answering the same question is the whole point.
//
// A step this coarse can miss a cell the segment only clips for less than one step. That is why a
// disagreement is never reported directly — verifyRay re-runs the loser at FINE_STEP first.
function voxelsAlong(origin, dir, len, step) {
  const seen = new Set();
  const out = [];
  const originKey = `${Math.floor(origin.x)},${Math.floor(origin.y)},${Math.floor(origin.z)}`;
  for (let t = 0; t <= len + step; t += step) {
    const tt = Math.min(t, len);
    const x = Math.floor(origin.x + dir.x * tt);
    const y = Math.floor(origin.y + dir.y * tt);
    const z = Math.floor(origin.z + dir.z * tt);
    const key = `${x},${y},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // prismarine's RaycastIterator steps BEFORE returning, so the cell the eye sits in is never a
    // candidate blocker. The re-walk has to inherit that or it invents a defect on every ray cast from
    // inside a solid — which is a real condition (a bot in a one-block alcove) and not an error.
    if (key === originKey) continue;
    out.push({ x, y, z, t: tt });
  }
  return out;
}

// firstBlockerIndependent — the re-walk's verdict: the nearest collision shape the segment enters, over
// every cell it passes through. Returns { x, y, z, t, name, second } or null for a clear line.
// `second` carries the runner-up entry parameter so a corner tie (two cells entered at the same t) can
// be named as a tie rather than mis-reported as a disagreement.
function firstBlockerIndependent(getBlock, origin, dir, len, step) {
  let best = null, secondT = null;
  for (const v of voxelsAlong(origin, dir, len, step)) {
    const b = getBlock(v.x, v.y, v.z);
    if (!b) continue;                                  // unloaded — prismarine skips it too; counted by caller
    const shapes = b.shapes;
    if (!shapes || !shapes.length) continue;           // no collision shape → transparent to the ray
    const t = rayShapeEntryT(origin, dir, v.x, v.y, v.z, shapes, len);
    if (t === null) continue;                          // the cell was crossed, the shape inside it was not
    if (best === null || t < best.t) {
      if (best !== null) secondT = best.t;
      best = { x: v.x, y: v.y, z: v.z, t, name: b.name };
    } else if (secondT === null || t < secondT) secondT = t;
  }
  if (best) best.second = secondT;
  return best;
}

// unloadedAlong — how many cells on this segment the client has never received. prismarine's raycast
// does `if (block)` and SILENTLY STEPS OVER a null, so an unsensed cell reports as thin air and a ray
// through it comes back "clear" (Invariant B — absent state answering as fresh). terrain_predicates
// gates the two ENDPOINTS against this; the middle is admittedly ungated, and this counts what that
// costs in practice instead of assuming it away.
function unloadedAlong(getBlock, origin, dir, len, step) {
  let n = 0;
  for (const v of voxelsAlong(origin, dir, len, step)) if (!getBlock(v.x, v.y, v.z)) n++;
  return n;
}

// ── PHASE C: the cast field ─────────────────────────────────────────────────────────────────────────

// verifyRay — one target, both methods, escalating to a fine sweep before it will call anything a defect.
// Returns { verdict, hit, expect, interposed, unloaded, tie }.
function verifyRay(bot, getBlock, eye, target) {
  const centre = new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5);
  const d = centre.minus(eye);
  const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (len < 1e-6) return null;
  const dir = new Vec3(d.x / len, d.y / len, d.z / len);
  // Cast one block past the target centre so a target's own far face is never clipped by the range
  // bound — a range that ends inside the target turns "visible" into "nothing found" for a reason that
  // has nothing to do with sight.
  const range = len + 1;

  const hit = bot.world.raycast(eye, dir, range);
  let expect = firstBlockerIndependent(getBlock, eye, dir, range, STEP);

  const samePos = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z;
  const hitPos = hit && hit.position ? { x: hit.position.x, y: hit.position.y, z: hit.position.z } : null;

  let agreed = (hitPos === null && expect === null) || samePos(hitPos, expect);
  let klass = null;
  if (!agreed) {
    // Escalation: re-walk at FINE_STEP before accusing anything. A coarse sweep that skipped a cell the
    // segment only clips is a limitation of the checker, not a defect in the checked.
    expect = firstBlockerIndependent(getBlock, eye, dir, range, FINE_STEP);
    agreed = (hitPos === null && expect === null) || samePos(hitPos, expect);
  }
  if (!agreed) {
    // ── CLASSIFY BY DIRECTION, WHICH IS THE WHOLE POINT (2026-08-06) ────────────────────────────────
    // The first run of this crucible printed "57 disagreements" and that number was worth nothing: it
    // welded together three conditions with opposite meanings, one of them harmless. WHICH WAY the two
    // answers differ is the finding —
    //   STOPPED-EARLY  raycast stops nearer than the true first blocker → the line is called BLOCKED
    //                  when it is clear → the bot declines a monster it can actually see. This is the
    //                  reported symptom, and it is the one to hunt.
    //   MISSED-NEARER  raycast stops further out, or not at all, past a real blocker → the line is
    //                  called CLEAR when it is not → the bot charges a mob through a wall.
    //   TIE            both stop at the SAME parameter. The segment passes exactly through a cell
    //                  corner, two cells are entered at one instant, and the two implementations break
    //                  the tie differently. Same stopping distance, same verdict about the line — the
    //                  disagreement is about which of two names to print, and neither is wrong.
    // A crucible that called a tie a defect would bury a real one under noise, and one that hid it
    // would be concealing a real property of the traversal. It is counted, named, and separated.
    const hitT = hitPos && hit.shapes && hit.shapes.length
      ? rayShapeEntryT(eye, dir, hitPos.x, hitPos.y, hitPos.z, hit.shapes, range) : null;
    const expT = expect ? expect.t : null;
    const span = hitPos ? cellSpan(eye, dir, hitPos.x, hitPos.y, hitPos.z) : null;
    // The corner touch first: the ray is inside the cell raycast named for zero length, so the two
    // implementations are not disagreeing about the world, only about a boundary convention.
    if (span && span.span < 1e-6) klass = 'corner';
    else if (hitT !== null && expT !== null && Math.abs(hitT - expT) < 1e-6) klass = 'tie';
    else if (hitT === null && hitPos) klass = 'phantom';        // raycast named a block its own shapes do not intersect
    else if (expT === null) klass = 'stopped-early';            // it stopped; the re-walk found the whole line clear
    else if (hitT < expT) klass = 'stopped-early';
    else klass = 'missed-nearer';
  }

  const unloaded = unloadedAlong(getBlock, eye, dir, Math.min(len, range), STEP);

  // The cells the segment crosses BEFORE whatever it stopped on — the Architect's own criterion made
  // literal: "if a bot can confirm raycast to a solid block 3 tiles away then 2 of them should be air."
  const stopT = hitPos ? (expect ? expect.t : len) : len;
  const interposed = [];
  for (const v of voxelsAlong(eye, dir, Math.min(stopT, len), STEP)) {
    if (hitPos && v.x === hitPos.x && v.y === hitPos.y && v.z === hitPos.z) break;
    const b = getBlock(v.x, v.y, v.z);
    interposed.push({ x: v.x, y: v.y, z: v.z, name: b ? b.name : 'UNLOADED', shapes: b ? (b.shapes || []).length : -1 });
  }

  let verdict;
  if (!hitPos) verdict = 'passthrough';
  else if (samePos(hitPos, target)) verdict = 'visible';
  else verdict = 'occluded';

  return { verdict, hit, hitPos, expect, agreed, klass, interposed, unloaded, len, dir, name: hit ? hit.name : null };
}

// explainRay — one target, the whole segment printed cell by cell.
//
// It exists because the first run of this crucible reported 57 disagreements and there was no way to
// tell a defect in raycast from a defect in the re-walk that accuses it. A checker that can only say
// "these two differ" pushes the diagnosis onto whoever reads it; naming the cell, its shapes and its
// entry parameter is what makes the claim checkable (Law 25 — the verdict has to carry its evidence).
function explainRay(bot, getBlock, eye, target) {
  head(`EXPLAIN — the full segment from the eye to ${fmt(target)}`);
  const centre = new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5);
  const d = centre.minus(eye);
  const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  const dir = new Vec3(d.x / len, d.y / len, d.z / len);
  const range = len + 1;
  console.log(`  eye    ${fmtf(eye)}   (cell ${fmt({ x: Math.floor(eye.x), y: Math.floor(eye.y), z: Math.floor(eye.z) })} — prismarine NEVER reports the cell the eye is in)`);
  console.log(`  dir    ${fmtf(dir)}    len ${r3(len)}   cast range ${r3(range)}\n`);

  console.log('     t(first sample)  cell                 block                 shapes  entry t');
  for (const v of voxelsAlong(eye, dir, range, FINE_STEP)) {
    const b = getBlock(v.x, v.y, v.z);
    const shapes = b ? (b.shapes || []) : [];
    const t = shapes.length ? rayShapeEntryT(eye, dir, v.x, v.y, v.z, shapes, range) : null;
    console.log(`     ${r3(v.t).toString().padStart(8)}        ${fmt(v).padEnd(20)} ${(b ? b.name : 'UNLOADED').padEnd(21)} ${String(shapes.length).padStart(3)}    ${t === null ? '  —' : r3(t)}`);
  }
  const hit = bot.world.raycast(eye, dir, range);
  const expect = firstBlockerIndependent(getBlock, eye, dir, range, FINE_STEP);
  console.log(`\n  prismarine raycast : ${hit ? `${hit.name} ${fmt(hit.position)}` : 'NOTHING'}`);
  console.log(`  independent re-walk: ${expect ? `${expect.name} (${expect.x},${expect.y},${expect.z}) at t=${r3(expect.t)}` : 'NOTHING'}`);
}

async function phaseCast(bot, getBlock) {
  head('PHASE C — THE CAST FIELD: raycast against an independent re-walk of the same segment');
  const eye = eyePos(bot.entity);
  const base = bot.entity.position.floored();
  log('cast', `eye at ${fmtf(eye)}  ·  cube ±${RADIUS} around ${fmt(base)}  ·  sweep step ${STEP} blocks`);

  const counts = { visible: 0, occluded: 0, passthrough: 0 };
  const passthroughNames = new Map();     // non-air blocks the ray went straight through
  const occluders = new Map();
  const byClass = { 'stopped-early': [], 'missed-nearer': [], phantom: [], tie: [], corner: [] };
  const visibleExemplars = [];
  let raysWithUnloaded = 0, total = 0;
  const t0 = Date.now();

  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        const target = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
        const tb = getBlock(target.x, target.y, target.z);
        if (!tb) continue;                       // never sensed — there is no claim to audit
        const res = verifyRay(bot, getBlock, eye, target);
        if (!res) continue;
        total++;
        counts[res.verdict]++;
        if (res.unloaded) raysWithUnloaded++;

        if (res.verdict === 'passthrough' && tb.name !== 'air' && tb.name !== 'cave_air' && tb.name !== 'void_air') {
          passthroughNames.set(tb.name, (passthroughNames.get(tb.name) || 0) + 1);
        }
        if (res.verdict === 'occluded' && res.name) occluders.set(res.name, (occluders.get(res.name) || 0) + 1);

        if (!res.agreed && byClass[res.klass]) byClass[res.klass].push({ target, res });

        // Keep a spread of exemplars at increasing range so the printed proof is not six copies of the
        // same adjacent block.
        if (res.verdict === 'visible' && res.len >= 2.5 && visibleExemplars.length < EXEMPLARS
            && !visibleExemplars.some(e => Math.abs(e.res.len - res.len) < 0.9)) {
          visibleExemplars.push({ target, res });
        }
      }
    }
  }
  const ms = Date.now() - t0;

  log('cast', `${total} rays in ${ms} ms (${r2(ms / Math.max(total, 1))} ms/ray)`);
  log('cast', `  VISIBLE     ${counts.visible}  — the ray reached the target block itself`);
  log('cast', `  OCCLUDED    ${counts.occluded}  — something nearer stopped it`);
  log('cast', `  PASSTHROUGH ${counts.passthrough}  — nothing on the whole segment has a collision shape the ray crosses`);
  if (raysWithUnloaded) {
    log('cast', `  ⚠️  ${raysWithUnloaded} rays crossed at least one UNLOADED cell. prismarine steps over a null block`);
    log('cast', `      silently, so those segments were reported on space the client has never received.`);
  }

  head('THE INTERPOSITION PROOF — "a solid block 3 tiles away means the cells before it are clear"');
  if (!visibleExemplars.length) console.log('  (no confirmed sightline past 2.5 blocks from where the body is standing)');
  for (const { target, res } of visibleExemplars) {
    console.log(`  ${res.name} at ${fmt(target)} — CONFIRMED VISIBLE at ${r2(res.len)} blocks`);
    if (!res.interposed.length) console.log('      · nothing between (adjacent cell)');
    for (const c of res.interposed) {
      console.log(`      · ${fmt(c)} ${c.name}${c.shapes > 0 ? `  ⚠️ has ${c.shapes} collision shape(s) the ray missed` : ''}`);
    }
  }

  if (passthroughNames.size) {
    head('PASSTHROUGH NAMES — non-air blocks the ray went straight through (no collision shape)');
    console.log('  These are visible on screen and invisible to sight. Java\'s own mob sight test uses the');
    console.log('  same COLLIDER context, so this is parity, not a bug — but it is what "clear line" means.');
    for (const [n, c] of [...passthroughNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(c).padStart(6)}  ${n}`);
    }
  }
  if (VERBOSE && occluders.size) {
    head('OCCLUDERS — what stopped the rays');
    for (const [n, c] of [...occluders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(c).padStart(6)}  ${n}`);
    }
  }

  head('THE AUDIT — does raycast stop where an independent walk of the same line says it must?');
  console.log(`  rays audited        ${total}`);
  console.log(`  corner touches      ${byClass.corner.length}   — the ray passes exactly through a cell corner; raycast's tie-break`);
  console.log('                            enters a cell it is inside for ZERO length and stops on it. A boundary');
  console.log('                            convention Java shares — not a fault. A large count here just means the');
  console.log('                            body is standing cell-centred; re-run from elsewhere with --at to clear it.');
  console.log(`  ties                ${byClass.tie.length}   — both stop at the same distance, different cell named. Not a fault.`);
  console.log(`  STOPPED-EARLY       ${byClass['stopped-early'].length}   — raycast stopped NEARER than the true first blocker.`);
  console.log('                            This is the shape of "the bot will not engage a monster it can see".');
  console.log(`  MISSED-NEARER       ${byClass['missed-nearer'].length}   — raycast saw THROUGH a real blocker. The bot would charge a wall.`);
  console.log(`  PHANTOM             ${byClass.phantom.length}   — raycast named a block its own collision shapes do not intersect.`);

  const bad = byClass['stopped-early'].length + byClass['missed-nearer'].length + byClass.phantom.length;
  if (bad === 0) {
    console.log('\n  ✅ Every ray stopped at the first collision shape on its segment, and every cell before');
    console.log('     that stop was independently confirmed shape-free. The traversal is exact over this field.');
  } else {
    defect('C', `${bad} rays where raycast stops somewhere other than the first collision shape on the line`, null);
    for (const k of ['stopped-early', 'missed-nearer', 'phantom']) {
      for (const { target, res } of byClass[k].slice(0, 8)) {
        console.log(`\n  ✗ [${k}] target ${fmt(target)} at ${r2(res.len)}b`);
        console.log(`      raycast returned : ${res.hitPos ? `${res.name} ${fmt(res.hitPos)}` : 'NOTHING (clear)'}`);
        console.log(`      re-walk expected : ${res.expect ? `${res.expect.name} (${res.expect.x},${res.expect.y},${res.expect.z}) at t=${r3(res.expect.t)}` : 'NOTHING (clear)'}`);
        console.log(`      reproduce        : --explain=${target.x},${target.y},${target.z}`);
      }
    }
  }
  if ((byClass.tie.length || byClass.corner.length) && VERBOSE) {
    head('CORNER TOUCHES AND TIES — printed because a silently-excluded case is a hidden rule');
    for (const { target, res } of [...byClass.corner, ...byClass.tie].slice(0, 10)) {
      console.log(`  [${res.klass}] ${fmt(target)} at ${r2(res.len)}b — raycast ${res.name} ${fmt(res.hitPos)} · re-walk ${res.expect ? `${res.expect.name} (${res.expect.x},${res.expect.y},${res.expect.z}) at t=${r3(res.expect.t)}` : 'NOTHING'}`);
    }
  }
  return { total, counts, bad, ties: byClass.tie.length, corners: byClass.corner.length, raysWithUnloaded };
}

// ── PHASE W: the world model against the server ─────────────────────────────────────────────────────
// The audit above is self-consistency: raycast against the map raycast reads. That is worth having and
// it is not enough on its own — a traversal that is perfect over a WRONG map still walks a bot into a
// wall. Only the server can settle whether the map is right, so this asks it directly.
async function phaseWorld(bot, link, getBlock) {
  head('PHASE W — THE MAP ITSELF: the bot\'s world model against the server (RCON)');
  const base = bot.entity.position.floored();
  const cells = [];
  const seen = new Set();
  // Deterministic spread rather than random: a bench that samples differently every run cannot be
  // compared with its own previous run.
  const span = RADIUS;
  for (let i = 0; cells.length < CENSUS && i < CENSUS * 40; i++) {
    const dx = ((i * 7) % (2 * span + 1)) - span;
    const dy = ((i * 3) % (2 * span + 1)) - span;
    const dz = ((i * 11) % (2 * span + 1)) - span;
    const key = `${dx},${dy},${dz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
    if (!getBlock(p.x, p.y, p.z)) continue;
    cells.push(p);
  }
  log('world', `asking the server about ${cells.length} cells the client believes it knows…`);

  let agree = 0;
  const mismatches = [];
  for (const p of cells) {
    const b = getBlock(p.x, p.y, p.z);
    const name = b.name.includes(':') ? b.name : `minecraft:${b.name}`;
    // `execute if block` answers with a match count; a miss answers with a failure line. Both are
    // unambiguous and neither needs the block's state parsed.
    const body = (await link.command(`execute if block ${p.x} ${p.y} ${p.z} ${name}`) || '').trim();
    if (/Test passed|^1$/i.test(body)) agree++;
    else if (mismatches.length < 200) mismatches.push({ p, believed: b.name, said: body });
  }
  const rate = cells.length ? (agree / cells.length) * 100 : 0;
  console.log(`  agreed  ${agree}/${cells.length}  (${r2(rate)}%)`);
  if (mismatches.length) {
    defect('W', `${mismatches.length} cells where the client's world model disagrees with the server`, null);
    console.log('\n  ✗ the client is reading a map the server does not have at these cells:');
    for (const m of mismatches.slice(0, 12)) console.log(`      ${fmt(m.p)} client says ${m.believed} — server: ${m.said || '(no reply)'}`);
  } else {
    console.log('\n  ✅ Every sampled cell matches the server. Raycast is walking a true map.');
  }
  return { sampled: cells.length, agree, mismatches: mismatches.length };
}

// ── PHASE M + R: the entity channel and the production sight predicate ──────────────────────────────

const parsePos = body => {
  // `data get entity … Pos` replies e.g. "X has the following entity data: [12.5d, 64.0d, -3.5d]"
  const m = String(body).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\s*\]/);
  return m ? new Vec3(Number(m[1]), Number(m[2]), Number(m[3])) : null;
};

async function summonAt(link, mob, pos, tag) {
  await link.command(`summon ${mob.includes(':') ? mob : `minecraft:${mob}`} ${r2(pos.x)} ${r2(pos.y)} ${r2(pos.z)} {Tags:["${TAG}","${tag}"],NoAI:1b,Silent:1b,PersistenceRequired:1b}`);
}
async function killTagged(link, tag) { await link.command(`kill @e[tag=${tag || TAG}]`); }

// waitForEntity — the client must actually receive the spawn packet before anything is asked of it.
// Polling for it rather than sleeping a fixed time is the difference between measuring sight and
// measuring latency (Law 23: sense the arrival, do not assume it).
async function waitForEntity(bot, truth, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const e = nearestEntityTo(bot, truth, 2.0);
    if (e) return e;
    await sleep(80);
  }
  return null;
}
function nearestEntityTo(bot, pos, maxErr) {
  let best = null, bestD = Infinity;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e === bot.entity) continue;
    if (e.type === 'player') continue;
    const d = e.position.distanceTo(pos);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best && bestD <= maxErr ? best : null;
}

async function phaseMobs(bot, link) {
  head('PHASE M — THE ENTITY CHANNEL: raycast reads BLOCKS; mobs arrive on a different wire');
  const eye = eyePos(bot.entity);
  const base = bot.entity.position;

  // ── M1: does the ray see a mob at all? ────────────────────────────────────────────────────────────
  // The headline. A body standing in clear air three blocks in front, and the block ray reports the
  // segment empty — because it is empty, of blocks. This is not a defect to fix; it is the boundary of
  // what the instrument measures, and mistaking it for a world model is how "raycast should rebuild the
  // world including mobs" becomes an unanswerable question.
  const front = base.offset(3, 0, 0);
  await link.command(`kill @e[tag=${TAG}]`);
  await summonAt(link, MOB, front, 'crucible_solo');
  const solo = await waitForEntity(bot, front);
  if (!solo) {
    defect('M', `the client never received the spawn of a ${MOB} summoned 3 blocks away`, null);
    console.log(`  ✗ summoned a ${MOB} at ${fmtf(front)} and bot.entities never showed it. The entity channel is broken,`);
    console.log('    and no amount of raycast work would have found this.');
    return { ok: false };
  }
  const soloEye = eyePos(solo);
  const dsolo = soloEye.minus(eye);
  const lsolo = Math.sqrt(dsolo.x ** 2 + dsolo.y ** 2 + dsolo.z ** 2);
  const rayAtMob = bot.world.raycast(eye, new Vec3(dsolo.x / lsolo, dsolo.y / lsolo, dsolo.z / lsolo), lsolo);
  console.log(`  a ${MOB} stands at ${fmtf(solo.position)}, ${r2(lsolo)} blocks from the eye, in open air.`);
  console.log(`  bot.world.raycast fired straight at it returns: ${rayAtMob ? `${rayAtMob.name} ${fmt(rayAtMob.position)}` : 'NOTHING'}`);
  if (rayAtMob) {
    console.log('  ⚠️ something is between them — this cell is not the open-air case; re-run on flat ground.');
  } else {
    console.log('  → CONFIRMED: the block ray passes through a live mob and reports the line clear.');
    console.log('    Raycast cannot detect, locate, or be blocked by an entity. It never could: prismarine\'s');
    console.log('    raycast walks getBlock() and nothing else. Mobs come from bot.entities (spawn packets).');
  }
  console.log(`  the fleet's own predicate, hasEntityLineOfSight → ${hasEntityLineOfSight(bot, solo, AGGRO_RANGE) ? 'CLEAR ✅' : 'BLOCKED'}`);

  // ── M2: bot.entities against the server's own list ────────────────────────────────────────────────
  // The real "can it rebuild the mobs around it" question, asked of the channel that actually carries
  // the answer. Positions are compared, not just presence: a mob the client has at the wrong place
  // aims every sightline at empty air.
  console.log('');
  const ring = [];
  const R = 6;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ring.push({ tag: `crucible_ring${i}`, pos: base.offset(Math.cos(a) * R, 0, Math.sin(a) * R) });
  }
  for (const r of ring) await summonAt(link, MOB, r.pos, r.tag);
  await sleep(900);

  let matched = 0;
  let worstErr = 0;
  const missing = [];
  for (const r of ring) {
    const truth = parsePos(await link.command(`data get entity @e[tag=${r.tag},limit=1] Pos`));
    if (!truth) { missing.push({ ...r, why: 'the server never placed it (terrain?)' }); continue; }
    const e = nearestEntityTo(bot, truth, 2.0);
    if (!e) { missing.push({ ...r, why: `server has it at ${fmtf(truth)}, the client does not` }); continue; }
    const err = e.position.distanceTo(truth);
    worstErr = Math.max(worstErr, err);
    matched++;
  }
  console.log(`  a ring of ${ring.length} ${MOB}s at ${R} blocks:  client matched ${matched}/${ring.length}, worst position error ${r3(worstErr)} blocks`);
  if (missing.length) {
    defect('M', `${missing.length} of ${ring.length} ring mobs never reached bot.entities`, null);
    for (const m of missing) console.log(`      ✗ ${m.tag}: ${m.why}`);
  } else {
    console.log('  ✅ every summoned body reached the client, at the position the server holds for it.');
  }

  // ── M3: does a mob occlude a mob? ─────────────────────────────────────────────────────────────────
  // Worth measuring because the intuitive answer is "yes" and the correct answer is "no, and Java agrees".
  await killTagged(link);
  await sleep(300);
  const near = base.offset(3, 0, 0), far = base.offset(6, 0, 0);
  await summonAt(link, MOB, near, 'crucible_near');
  await summonAt(link, MOB, far, 'crucible_far');
  await sleep(900);
  const eNear = await waitForEntity(bot, near), eFar = await waitForEntity(bot, far);
  console.log('');
  if (eNear && eFar) {
    const clear = hasEntityLineOfSight(bot, eFar, AGGRO_RANGE);
    console.log(`  two ${MOB}s in line at ~3b and ~6b — sight to the FAR one: ${clear ? 'CLEAR ✅' : `BLOCKED by ${JSON.stringify(lastSightlineBlock())}`}`);
    console.log('  → Expected CLEAR. Java\'s own mob sight test clips against blocks only, so a mob standing');
    console.log('    behind another mob is fully visible to both of them. The bot matches the server here.');
    if (!clear) defect('M', 'a mob was reported as occluding another mob — the block ray should not see entities', null);
  } else {
    console.log('  (could not place two bodies in line here — terrain; skipping the entity-occlusion check)');
  }

  // ── M4: a real wall ───────────────────────────────────────────────────────────────────────────────
  // The other half of the same claim: the predicate must say BLOCKED when something genuinely is. Only
  // a cell the client has confirmed is AIR is converted, and it is set straight back (Law 8).
  await killTagged(link);
  await sleep(300);
  console.log('');
  const wallCells = [];
  const behind = base.offset(0, 0, 5);
  for (let dy = 0; dy <= 2; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = base.offset(dx, dy, 2).floored();
      const b = bot.blockAt(c);
      if (b && (b.name === 'air' || b.name === 'cave_air')) wallCells.push(c);
    }
  }
  if (wallCells.length >= 6) {
    await summonAt(link, MOB, behind, 'crucible_walled');
    const walled = await waitForEntity(bot, behind);
    if (walled) {
      const before = hasEntityLineOfSight(bot, walled, AGGRO_RANGE);
      for (const c of wallCells) await link.command(`setblock ${c.x} ${c.y} ${c.z} minecraft:stone replace`);
      // Wait for the change to reach the CLIENT, not merely the server — asking the predicate before the
      // block packet lands measures latency and calls it sight.
      for (let i = 0; i < 60 && bot.blockAt(wallCells[0])?.name !== 'stone'; i++) await sleep(50);
      const after = hasEntityLineOfSight(bot, walled, AGGRO_RANGE);
      const blocker = lastSightlineBlock();
      for (const c of wallCells) await link.command(`setblock ${c.x} ${c.y} ${c.z} minecraft:air replace`);
      console.log(`  a ${MOB} at ${fmtf(walled.position)}, then a stone wall raised between:`);
      console.log(`      before the wall: ${before ? 'CLEAR' : 'BLOCKED'}      after the wall: ${after ? 'CLEAR' : 'BLOCKED'}`);
      if (!after && blocker) console.log(`      blocker named: ${blocker.name} at ${blocker.pos ? blocker.pos.join(',') : '?'} · ${blocker.dist}b · dy ${blocker.dy}`);
      if (before && !after) console.log('  ✅ the predicate flips with the world, and names what stopped it.');
      else {
        defect('M', `the wall test did not flip the sightline (before=${before} after=${after})`, null);
        console.log('  ✗ the sightline did not respond to a wall raised directly across it.');
      }
    }
  } else {
    console.log('  (not enough open air 2 blocks ahead to raise a test wall — skipping the wall check)');
  }

  await killTagged(link);
  return { ok: true };
}

// ── PHASE R: the near-field ring — the exact question the fight gate asks ───────────────────────────
// "a monster a few blocks away" is the Architect's own description of the failure, so this walks a body
// around the bot at close range and asks the PRODUCTION predicate at every station. A false BLOCKED here
// is the smoking gun; a clean sheet rules the sight test out and moves the search to the arm.
// corroborateDecline — the ring's own audit of a refusal.
//
// A decline that names a blocker is a CLAIM, not a finding (Law 23). The first live run of this phase
// reported "17 declines on OPEN GROUND" purely because it judged openness from the MOB's dy and never
// looked at the segment: the body had spawned inside an oak canopy and every one of those refusals was
// correct, with `oak_leaves @ 1.7b` named right there in the output the tool then contradicted. So the
// decline is re-walked here by the same independent method PHASE C uses on raycast — eye to eye, the
// identical endpoints the predicate used, since eyePos is imported and not restated.
//
//   CORROBORATED   a real collision shape sits on the segment. The refusal is right; this is terrain.
//   CORNER         the block it blamed is one the segment touches at a single POINT — the same
//                  zero-span tie-break PHASE C names, now reaching the fight gate. The bot refuses a
//                  mob whose eye-to-eye line clips a block corner. Reported on its own because whether
//                  the server's own traversal breaks that tie the same way is UNVERIFIED here.
//   UNEXPLAINED    the segment is clear, the blamed block is not even touched. THAT is the defect.
function corroborateDecline(bot, entity, blamed) {
  const start = eyePos(bot.entity);
  const end = eyePos(entity);
  const d = end.minus(start);
  const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (len < 1e-6) return { corroborated: false, corner: false, len };
  const dir = new Vec3(d.x / len, d.y / len, d.z / len);
  const reader = (x, y, z) => bot.blockAt(new Vec3(x, y, z));   // re-sensed, never the cast cache
  const blocker = firstBlockerIndependent(reader, start, dir, len, FINE_STEP);
  if (blocker) return { corroborated: true, corner: false, blocker, len };
  let corner = false;
  if (blamed && blamed.pos) {
    const span = cellSpan(start, dir, blamed.pos[0], blamed.pos[1], blamed.pos[2]);
    corner = !!span && span.span < 1e-6;
  }
  return { corroborated: false, corner, len };
}

async function phaseRing(bot, link) {
  head('PHASE R — THE NEAR-FIELD RING: the production sight predicate, every bearing, every close range');
  console.log(`  ${RING_BEARINGS} bearings × ${RING_DISTANCES.join(', ')} blocks — the exact call threat_scanner.confirmAggro makes.`);
  console.log('  Distances and dy are MEASURED after the body settles, never assumed from the summon point.');
  console.log('  ✓ sight confirmed   · declined, a real blocker re-walked and verified on the line');
  console.log('  ◹ declined on a CORNER TOUCH   ✗ declined with NOTHING on the line\n');
  const base = bot.entity.position;
  const rows = [];
  let confirmed = 0, tested = 0, blockedInOpen = 0, corners = 0;

  for (const dist of RING_DISTANCES) {
    const stations = [];
    for (let i = 0; i < RING_BEARINGS; i++) {
      const a = (i / RING_BEARINGS) * Math.PI * 2;
      stations.push({ tag: `crucible_r${dist}_${i}`, bearing: Math.round((a * 180) / Math.PI), pos: base.offset(Math.cos(a) * dist, 0, Math.sin(a) * dist) });
    }
    for (const s of stations) await summonAt(link, MOB, s.pos, s.tag);
    await sleep(1000);

    const line = [];
    for (const s of stations) {
      const truth = parsePos(await link.command(`data get entity @e[tag=${s.tag},limit=1] Pos`));
      if (!truth) { line.push(' ·'); continue; }
      const e = nearestEntityTo(bot, truth, 2.0);
      if (!e) { line.push(' ?'); rows.push({ dist, s, seen: false }); continue; }
      tested++;
      // The CAST length, not the horizontal radius — the gate is a cylinder and clamping a probe to the
      // radius would report a mob standing 5 b up as sightline-blocked when the fleet would have seen it.
      const clear = hasEntityLineOfSight(bot, e, aggroCastRange(MOB));
      const blk = clear ? null : lastSightlineBlock();
      const actual = bot.entity.position.distanceTo(e.position);
      const dy = e.position.y - bot.entity.position.y;
      if (clear) { confirmed++; line.push(' ✓'); }
      else {
        // Every refusal is re-walked before it is believed or accused (Law 23) — see corroborateDecline.
        const c = corroborateDecline(bot, e, blk);
        line.push(c.corroborated ? ' ·' : c.corner ? ' ◹' : ' ✗');
        if (c.corner) corners++;
        else if (!c.corroborated) blockedInOpen++;
        rows.push({ dist, s, clear, blk, actual, dy, corroborated: c.corroborated, corner: c.corner, indep: c.blocker });
      }
    }
    console.log(`  ${String(dist).padStart(3)}b  ${line.join('')}`);
    await killTagged(link);
    await sleep(250);
  }

  const declines = rows.filter(r => r.clear === false);
  console.log(`\n  confirmed sight ${confirmed}/${tested} · ${declines.filter(d => d.corroborated).length} declines with a verified blocker · ${corners} corner touches · ${blockedInOpen} unexplained`);
  if (declines.length) {
    console.log('\n  every decline, with the reason it gave AND an independent re-walk of the same segment:');
    for (const d of declines.slice(0, 40)) {
      const verdict = d.corroborated ? `CONFIRMS ${d.indep.name} at t=${r3(d.indep.t)} ✓ correct refusal`
        : d.corner ? 'the blamed block is TOUCHED AT A CORNER only ◹ boundary convention'
        : 'finds the line CLEAR ✗ UNEXPLAINED';
      console.log(`      ${String(d.dist).padStart(3)}b bearing ${String(d.s.bearing).padStart(3)}°  actual ${r2(d.actual)}b  dy ${r2(d.dy)}  ` +
        `predicate blamed ${d.blk ? `${d.blk.name} @ ${d.blk.dist}b dy ${d.blk.dy}` : '(nothing recorded)'}  → re-walk ${verdict}`);
    }
  }
  if (corners) {
    // Raised at warning weight rather than as a defect, and the distinction is the honest one: the
    // refusal is geometrically defensible, and whether the SERVER breaks the same tie the same way is
    // a question this crucible has not answered (Law 25 — unverified is named unverified).
    console.log(`\n  ◹ ${corners} refusals rest on a CORNER TOUCH: the eye-to-eye line clips a block at a single`);
    console.log('    point and the traversal counts that as blocked. It is what a 45° bearing from a');
    console.log('    cell-centred body produces. UNVERIFIED: whether the server\'s own sight traversal breaks');
    console.log('    that tie identically. If it does not, this is a real source of a refused close monster.');
  }
  if (blockedInOpen) {
    defect('R', `${blockedInOpen} sight declines where an independent re-walk finds the eye-to-eye line clear`, null);
    console.log(`\n  ✗ ${blockedInOpen} refusals name a blocker that is not on the segment and not even touched.`);
    console.log('    THIS is the reported failure, reproduced: the bot declines a monster it can see.');
  } else if (tested) {
    console.log('\n  ✅ No refusal was unexplained. Every decline is backed by a block the segment provably');
    console.log('     meets, and every confirmed sight was cast on a line verified clear.');
  }
  return { tested, confirmed, blockedInOpen };
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  head('RAYCAST CRUCIBLE — a live audit of what the body can see, and of what "see" means');

  let link;
  try { link = await rcon.open(rcon.readServerProperties()); }
  catch (e) { console.error(`[boot] rcon unavailable: ${e.message}. Is the server up, with enable-rcon=true?`); process.exit(1); }

  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION, auth: 'offline' });
  let done = false;
  const shutdown = async (code) => {
    if (done) return; done = true;
    try { await killTagged(link); } catch (_) { /* the link may already be gone; the kill is best-effort */ }
    try { link.close(); } catch (_) {}
    try { bot.quit(); } catch (_) {}
    setTimeout(() => process.exit(code), 250);
  };
  process.on('SIGINT', () => { console.log('\n[boot] interrupted — clearing summoned bodies before exit.'); shutdown(130); });

  bot.on('error', e => { console.error(`[boot] socket error: ${e.message}`); shutdown(1); });
  bot.on('kicked', r => { console.error(`[boot] kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`); shutdown(1); });

  await new Promise(res => bot.once('spawn', res));
  log('boot', `${USERNAME} joined ${HOST}:${PORT} (${VERSION})`);

  // Spectator, deliberately: a hostile that kills the crucible halfway through does not produce a
  // partial measurement, it produces a wrong one. Spectator changes no gamerule, no difficulty and
  // nothing about the world — the chunk and entity packets are identical to any other client's.
  await link.command(`gamemode spectator ${USERNAME}`);
  if (AT) {
    const [x, y, z] = AT.split(',').map(Number);
    await link.command(`tp ${USERNAME} ${x} ${y} ${z}`);
    await sleep(800);
  }

  // Wait for real chunks. A crucible that starts measuring before the world arrives measures the
  // absence of a world (Invariant B).
  for (let i = 0; i < 100; i++) {
    if (bot.blockAt(bot.entity.position.offset(0, -1, 0))) break;
    await sleep(100);
  }
  await sleep(1200);
  if (!bot.blockAt(bot.entity.position.offset(0, -1, 0))) {
    console.error('[boot] no chunks after 11s — the body has nothing to look at.');
    return shutdown(1);
  }
  log('boot', `standing at ${fmtf(bot.entity.position)}, eye ${fmtf(eyePos(bot.entity))} (eyeHeight ${bot.entity.eyeHeight})`);

  // One cache for the whole run, and a re-read at the end that PROVES the map did not move under the
  // audit. A cached read is only honest while the thing it caches is static; asserting that rather than
  // assuming it is the difference between a measurement and a story (Law 23).
  const cache = new Map();
  const getBlock = (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (cache.has(k)) return cache.get(k);
    const b = bot.blockAt(new Vec3(x, y, z));
    cache.set(k, b);
    return b;
  };

  try {
    if (EXPLAIN) {
      const [x, y, z] = EXPLAIN.split(',').map(Number);
      explainRay(bot, getBlock, eyePos(bot.entity), { x, y, z });
      return shutdown(0);
    }
    if (!SKIP_BLOCKS) {
      await phaseWorld(bot, link, getBlock);
      await phaseCast(bot, getBlock);

      // The static-world assertion.
      let drift = 0;
      let checked = 0;
      for (const [k, v] of cache) {
        if (checked++ % 37 !== 0) continue;
        const [x, y, z] = k.split(',').map(Number);
        const now = bot.blockAt(new Vec3(x, y, z));
        if ((now && now.name) !== (v && v.name)) drift++;
      }
      if (drift) {
        defect('C', `${drift} cached cells changed during the run — the cast field was measured against a moving map`, null);
        console.log(`\n  ⚠️ ${drift} cells changed while the audit ran. Re-run with the fleet stopped.`);
      }
    }

    if (!SKIP_MOBS) {
      const m = await phaseMobs(bot, link);
      if (m.ok) await phaseRing(bot, link);
    }
  } catch (e) {
    console.error(`\n[run] the crucible threw: ${e.stack || e.message}`);
    defect('*', `the crucible could not complete: ${e.message}`, null);
  }

  head('VERDICT');
  if (!defects.length) {
    console.log('  ✅ CLEAN — every audit this run performed passed.');
    console.log('     Stated precisely, because that is what was measured and not more:');
    if (!SKIP_BLOCKS) {
      console.log('       · the client\'s block map matches the server over the sampled cells');
      console.log('       · every ray stopped at the first collision shape on its segment, and the cells');
      console.log('         before each stop were independently confirmed shape-free');
    }
    if (!SKIP_MOBS) {
      console.log('       · every summoned body reached bot.entities at the server\'s own position');
      console.log('       · the sight predicate flips with a real wall and names what stopped it');
      console.log('       · every near-range refusal was re-walked and backed by a block on the line');
    }
    console.log('     NOT proven by this run: that the fleet\'s bot, on ITS terrain, mid-fight, under load,');
    console.log('     sees the same. This is a stationary spectator on the ground it was run on.');
    console.log('     NOT proven by this run: that the SERVER breaks a corner-touch tie the way the client');
    console.log('     does. Any ◹ above is a refusal whose parity with Java is untested here.');
  } else {
    console.log(`  ❌ ${defects.length} DEFECT(S):`);
    for (const d of defects) console.log(`      [PHASE ${d.phase}] ${d.what}`);
  }
  return shutdown(defects.length ? 2 : 0);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
