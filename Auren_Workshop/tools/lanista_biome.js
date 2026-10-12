// lanista_biome — find ground in a NAMED biome, and say exactly how it was found.
//
// The biome is a CONTROL VARIABLE: a ladder run in a forest and one on a plain are different
// experiments — different sightlines, footing, light under canopy — so a row that does not name its
// biome, or names one never verified, cannot be compared to any other (Law 25). Finding the biome is
// part of setting the experiment up, authored here and read back at the fight cell by lanista itself.
//
// ── THE HOP: A CLIENT, NOT THE SERVER ───────────────────────────────────────────────────────────────
// No server command answers what biome is at a cell — `execute if biome` only tests a guess already
// held. A client holding the chunk answers it in one lookup, so the hunt teleports the scout, waits for
// its chunks, reads, and repeats. The scout is a spectator: it cannot fall, be hit, or aggro anything
// (Law 26 — the bench moves its own instrument, never the thing being measured).
//
// ── THE SPIRAL IS DETERMINISTIC ─────────────────────────────────────────────────────────────────────
// Same origin + same target + same world ⇒ same hop sequence ⇒ same cell, which is what makes a trial
// repeatable.
//
// ── WHAT IT CANNOT PROVE (Law 25) ───────────────────────────────────────────────────────────────────
// The coarse sweep samples the biome at three fixed altitudes per column, not the real surface, so a
// column whose ground sits far above or below those altitudes can read as a cave biome and be passed
// over — a false NEGATIVE, never a false positive: every cell this file returns has had its biome
// re-read at the actual floor of an actual open box.
//
// ── A GROUP IS A TARGET TOO, AND `open` IS THE ONE THAT MATTERS ────────────────────────────────────
// Attack tuning isolates swing distance, not pathfinding, so the target may be a ranked GROUP: `open`
// means treeless ground, plains first, more findable than any single name while staying more controlled
// than 'any'. The row still records the one biome actually confirmed at the floor (Law 25). Every
// accepted biome at a hop is collected and the winner is (rank, then distance).
//
// Usage (normally driven by lanista_ladder, but standalone for a look around):
//   node lanista_biome.js --biome=open [--bot=AurenBot] [--hops=24] [--hop=96]
//   node lanista_biome.js --biome=plains,desert          an ad-hoc group, ranked left to right
//   node lanista_biome.js --biome=plains                 one name, exactly as before

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/lanista_biome.js');

const {
  SCOUT_NAME, SITING,
  arena, fmt, log, sleep,
} = require('./lanista_shared');
const lanista = require('./lanista');

// View-distance is 10 chunks (160b); the sweep stays inside 128 so a trial is never sited at the
// loaded frontier's edge.
const SWEEP_RADIUS = 128;
// Blocks between samples: biomes are stored at 4×4×4, so this reads one cell in four.
const SWEEP_STEP = 8;
// Altitudes sampled per column, spanning the surface relief a hop can land in.
const SWEEP_LIFTS = [0, 24, 48];
// Distance between hops, less than a full loaded diameter (256) so consecutive rings overlap.
const HOP_BLOCKS = 96;
const MAX_HOPS = 24;
// Eight bearings per ring: the four axes plus the four diagonals.
const BEARINGS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
// How many of a hop's nearest candidate cells get the expensive box test before the hunt moves on.
const CANDIDATES_PER_HOP = 6;

// ── THE `open` GROUP, IN PREFERENCE ORDER ───────────────────────────────────────────────────────────
// Ranked by how little stands between two bodies 12b apart. Plains and desert are flat and empty;
// savanna and meadow carry sparse trees and still beat a forest floor; snowy plains is last, findable
// almost anywhere. This list decides which biome the hunt flies to; `SITING.ground` decides which
// anchor inside it is acceptable — different jobs, different scopes.
const OPEN_GROUND = [
  'plains', 'sunflower_plains', 'desert',
  'savanna', 'savanna_plateau', 'meadow',
  'snowy_plains',
];

const BIOME_GROUPS = { open: OPEN_GROUND };

// resolveTargets — one name, a comma list, or a group name, all reduced to the same ranked map, decided
// once (Law 16) so every caller reads it instead of re-parsing the string. A bare string is still
// accepted at every consumer below.
function resolveTargets(target) {
  if (target instanceof Map) return target;
  const names = BIOME_GROUPS[target] || String(target).split(',').map(s => s.trim()).filter(Boolean);
  const ranked = new Map();
  names.forEach((n, i) => { if (!ranked.has(n)) ranked.set(n, i); });
  if (!ranked.size) {
    throw new Error(`[lanista_biome] CODING VIOLATION: target ${JSON.stringify(target)} resolves to no biome names. ` +
      `Use a name, a comma list, a group (${Object.keys(BIOME_GROUPS).join(', ')}), or 'any'.`);
  }
  return ranked;
}

// The declaration as a reader sees it: 'open' is a promise about a set, and a row that only said 'open'
// would hide which of the nine the fight was actually in.
function describeTarget(target) {
  const t = resolveTargets(target);
  return t.size === 1 ? [...t.keys()][0] : `${target} [${[...t.keys()].join(' > ')}]`;
}

// hopCells — the spiral, as pure data, extracted from the hunt so the sequence can be asserted without a
// server (the file's one determinism claim, and the one thing a test can pin).
function hopCells(origin, { hops = MAX_HOPS, hop = HOP_BLOCKS } = {}) {
  const cells = [{ x: origin.x, y: origin.y, z: origin.z, ring: 0, bearing: 0 }];
  let ring = 1;
  while (cells.length < hops) {
    for (let b = 0; b < BEARINGS.length && cells.length < hops; b++) {
      const [dx, dz] = BEARINGS[b];
      cells.push({
        x: origin.x + dx * ring * hop,
        y: origin.y,
        z: origin.z + dz * ring * hop,
        ring, bearing: b,
      });
    }
    ring++;
  }
  return cells;
}

// waitForChunks — the scout has arrived only when it can ANSWER about the cell. Polling the biome read
// is the honest test, since that is the read the sweep is about to make; a fixed sleep would guess at
// the server's chunk-send latency, and a wrong guess produces an empty sweep indistinguishable from the
// target biome being absent (Law 23 — an unread cell is unknown, never a verdict).
async function waitForChunks(scout, cell, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (scout.biomeAt(cell).known && scout.blockAt(cell) !== null) return true;
    await sleep(400);
  }
  return false;
}

// sweepForBiome — every sampled column at this hop whose biome is in the target set, best first: rank
// then distance. Rank first because the group is a preference and the box test below is the expensive
// half, so the order decides which ground the trial actually lands on.
function sweepForBiome(scout, centre, target) {
  const targets = resolveTargets(target);
  const hits = [];
  let read = 0;
  for (let dx = -SWEEP_RADIUS; dx <= SWEEP_RADIUS; dx += SWEEP_STEP) {
    for (let dz = -SWEEP_RADIUS; dz <= SWEEP_RADIUS; dz += SWEEP_STEP) {
      for (const lift of SWEEP_LIFTS) {
        const at = { x: centre.x + dx, y: centre.y + lift, z: centre.z + dz };
        const r = scout.biomeAt(at);
        if (!r.known) continue;
        read++;
        if (!targets.has(r.biome)) continue;
        hits.push({ x: at.x, y: at.y, z: at.z, d: Math.hypot(dx, dz), biome: r.biome, rank: targets.get(r.biome) });
        break;                            // one hit per column is enough; the box test resolves the floor
      }
    }
  }
  hits.sort((a, b) => (a.rank - b.rank) || (a.d - b.d));
  return { hits, read };
}

// confirmGround — the promotion from claim to fact (Law 23). A biome sample says the region is right; it
// says nothing about whether a body can stand there. The open-box test is the construct's own siting
// criterion, imported (Law 16); the biome is re-read at the box's floor, since that is where the fight
// will happen.
async function confirmGround(scout, candidate, target) {
  const targets = resolveTargets(target);
  const dials = { blueprint: SITING.blueprint, flatness: SITING.flatness };
  const spawn = await arena.findBotSpawn(arena.readerFromScout(scout), candidate, dials);
  if (!spawn.found) return { ok: false, why: `no open box near ${fmt(candidate)} (${spawn.reason || 'terrain'})` };
  const cell = { x: spawn.box.x, y: spawn.box.y, z: spawn.box.z };
  const biome = lanista.readBiome(scout, cell);
  if (biome === null) return { ok: false, why: `the box at ${fmt(cell)} is not readable — its column is not loaded` };
  // The sample and the floor disagreeing is the normal case at a biome edge: the sample was taken at a
  // fixed altitude, the box resolved a real floor some blocks away, and only the floor's answer counts.
  // A group is checked as a set, never as the name the sample happened to hit — a floor of 'desert'
  // under a 'plains' sample is a perfectly good `open` arena.
  if (!targets.has(biome)) {
    return { ok: false, why: `the box at ${fmt(cell)} is '${biome}', not ${describeTarget(target)} — a biome edge` };
  }
  return { ok: true, cell, biome };
}

// ── The hunt ────────────────────────────────────────────────────────────────────────────────────────
// Returns { found, cell, biome, hops, scanned, why }; `hops` belongs on the result because it belongs in
// the trial row — a biome found on hop 0 and one found on hop 19 are the same control, but the reader is
// owed the distance from base.
//
// 'any' short-circuits to the origin and reports the biome it finds there, so the ladder is runnable
// without a biome control at all.
async function huntBiome(scout, rcon, { target, origin, hops = MAX_HOPS, hop = HOP_BLOCKS, quiet = false } = {}) {
  if (!target || target === 'any') {
    const biome = lanista.readBiome(scout, origin);
    return { found: true, cell: origin, biome, hops: 0, scanned: 0, declared: false };
  }

  const targets = resolveTargets(target);
  const label = describeTarget(target);
  const route = hopCells(origin, { hops, hop });
  let scanned = 0;
  const refusals = [];
  for (let i = 0; i < route.length; i++) {
    const stop = route[i];
    await rcon.command(`tp ${SCOUT_NAME} ${stop.x + 0.5} ${stop.y} ${stop.z + 0.5}`);
    if (!await waitForChunks(scout, stop)) {
      refusals.push(`hop ${i} ${fmt(stop)}: chunks never arrived`);
      continue;
    }
    const sweep = sweepForBiome(scout, stop, targets);
    scanned += sweep.read;
    if (!quiet) {
      // The BREAKDOWN, not just the total, because a group's total says nothing about which member it
      // found — and which member is the control the row will carry.
      const byName = {};
      for (const h of sweep.hits) byName[h.biome] = (byName[h.biome] || 0) + 1;
      const found = Object.entries(byName).map(([n, c]) => `${n}×${c}`).join(', ') || 'none';
      log('biome', `hop ${i}/${route.length - 1} ${fmt(stop)} — ${found} in ${sweep.read} sampled (want ${label})`);
    }
    for (const c of sweep.hits.slice(0, CANDIDATES_PER_HOP)) {
      const ground = await confirmGround(scout, c, targets);
      if (ground.ok) {
        // ── THE SCOUT FOLLOWS THE ANSWER ─────────────────────────────────────────────────────────────
        // Teleports the scout to the confirmed cell before returning it: everything the caller does next
        // reads through the scout's chunk cache, and left standing at the hop that cache would be ragged
        // or absent nearby, reading as terrain unfightable when it is the instrument's own blindness
        // (Law 23/25). Reuses the hunt's own tp and waitForChunks (Law 16); an unreachable cell is not
        // returned.
        await rcon.command(`tp ${SCOUT_NAME} ${ground.cell.x + 0.5} ${ground.cell.y} ${ground.cell.z + 0.5}`);
        if (!await waitForChunks(scout, ground.cell)) {
          refusals.push(`hop ${i}: ${fmt(ground.cell)} confirmed, but the scout's chunks never arrived there — cannot survey the fight`);
          continue;
        }
        return { found: true, cell: ground.cell, biome: ground.biome, hops: i, scanned, declared: true, refusals };
      }
      refusals.push(`hop ${i}: ${ground.why}`);
    }
  }

  // A shortfall is reported with what was actually looked at, never as proof no such biome exists
  // anywhere (this searched a spiral, not the world) and never as a silent fall back to wherever the
  // bot happened to be standing (Law 25).
  return {
    found: false, cell: null, biome: null, hops: route.length, scanned, declared: true, refusals,
    why: `${label} was not found with standable ground in ${route.length} hop(s) of ${hop}b `
      + `(${scanned} biome samples). Nearest refusals: ${refusals.slice(-3).join(' · ') || 'none recorded'}`,
  };
}

// ── Standalone ──────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
  const target = opt('biome', null);
  const botName = opt('bot', process.env.BOT_ID || 'AurenBot');
  if (!target) {
    console.error(`lanista_biome: --biome=<name|list|group> is required (or \`any\` to just read where the bot is).`);
    console.error(`  groups: ${Object.entries(BIOME_GROUPS).map(([g, n]) => `${g} = ${n.join(' > ')}`).join(' · ')}`);
    return 1;
  }

  const link = await lanista.openArena({ quiet: true });
  if (!link.ok) { console.error(`lanista_biome: ${link.why}`); return 1; }
  try {
    const at = await lanista.readBotVitals(link.rcon, botName);
    if (!at.known || !at.position) { console.error(`lanista_biome: the server will not answer for '${botName}'.`); return 1; }
    const origin = { x: Math.floor(at.position.x), y: Math.floor(at.position.y), z: Math.floor(at.position.z) };
    const r = await huntBiome(link.scout, link.rcon, {
      target, origin,
      hops: parseInt(opt('hops', String(MAX_HOPS)), 10),
      hop: parseInt(opt('hop', String(HOP_BLOCKS)), 10),
    });
    if (!r.found) { log('biome', `NOT FOUND — ${r.why}`); return 2; }
    log('biome', `'${r.biome}' at ${fmt(r.cell)} — hop ${r.hops}, ${r.scanned} sample(s) read.`);
    return 0;
  } finally {
    await link.close();
  }
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('lanista_biome:', e && e.stack || e); process.exit(1); });
}

module.exports = {
  huntBiome, hopCells, sweepForBiome, confirmGround, waitForChunks,
  resolveTargets, describeTarget, OPEN_GROUND, BIOME_GROUPS,
  SWEEP_RADIUS, SWEEP_STEP, SWEEP_LIFTS, HOP_BLOCKS, MAX_HOPS, BEARINGS, CANDIDATES_PER_HOP,
};
