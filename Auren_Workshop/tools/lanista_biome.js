// lanista_biome — find ground in a NAMED biome, and say exactly how it was found.
//
// ── WHY IT EXISTS ────────────────────────────────────────────────────────────────────────────────────
// Lanista is responsible for placing combatants together in the correct biome; when none is present
// nearby, it must teleport a client around to load new chunks until one is found.
//
// The biome is a CONTROL VARIABLE, and that is the whole reason this file is not a convenience. A ladder
// run in a forest and a ladder run on a plain are two different experiments — different sightlines,
// different footing, different light under canopy — so a row that does not name its biome cannot be
// compared to any other row, and a row that names one it never verified is worse than one that names
// none (Law 25). Finding the biome is therefore part of setting the experiment up, not part of reading
// it, which is why it is authored here and read back at the fight cell by lanista itself.
//
// ── THE HOP, AND WHY A CLIENT RATHER THAN THE SERVER ────────────────────────────────────────────────
// There is no server command that ANSWERS "what biome is at this cell" — `execute if biome` only tests a
// guess you already have, so finding an unknown biome over RCON would mean testing every biome id at
// every cell. A client holding the chunk answers it in one lookup. The bench already runs such a client
// for exactly this class of question (the scout, which reads terrain for the siting sweep), so the hunt
// is: teleport the scout, wait for its chunks, read, repeat. Nothing new joins the world.
//
// THE SCOUT IS THE RIGHT BODY AND THE BOT IS THE WRONG ONE. Teleporting the fleet's body around to
// look for ground would run the system under test through forty chunk loads, a fall, and possibly a
// death before the experiment started — and every one of those is state the trial then carries silently.
// The scout is a spectator: it cannot fall, cannot be hit, and cannot aggro anything (Law 26 — the bench
// moves its own instrument, never the thing being measured).
//
// ── THE SPIRAL IS DETERMINISTIC ON PURPOSE ──────────────────────────────────────────────────────────
// Same origin + same target + same world ⇒ same hop sequence ⇒ same cell. That is what makes a trial
// repeatable, which is the whole ask ("we should be able to replicate battles over and over"). A random
// walk would find a biome just as well and would make every row a one-off.
//
// ── WHAT IT CANNOT PROVE, stated up front (Law 25) ──────────────────────────────────────────────────
// The coarse sweep samples the biome at three FIXED altitudes per column, not at the real surface —
// resolving the true surface height would cost a downward block scan per cell and turn a millisecond
// lookup into tens of thousands of reads per hop. Minecraft 1.21 biomes are volumetric, so a column
// whose ground sits far above or below those altitudes can read as a CAVE biome and be passed over. The
// consequence is a false NEGATIVE (a hop skipped that did contain the target), never a false positive:
// every cell this file returns has had its biome re-read at the actual floor of an actual open box.
// So the hunt can take more hops than it needed to; it cannot hand back the wrong ground.
//
// ── A GROUP IS A TARGET TOO, AND `open` IS THE ONE THAT MATTERS ────────────────────────────────────
// Attack tuning is meant to isolate swing distance, not pathfinding — the biome should offer non-tree,
// open ground first (plains, desert, ...) so there are no obstacles to route around.
//
// A single biome NAME is the strictest control and it is also the one that fails most: the bench has one
// world, and a declared name that cannot be found at all silently becomes 'any' — which can put an entire
// tuning run inside a forest. A pathfinding/occlusion reading (declines for no_sightline, leaves stopping
// the cast) then contaminates what was meant to be a pure swing-distance experiment.
//
// So the target may now be a GROUP, and the group is ranked. `open` means "treeless ground, plains first",
// and it is strictly more findable than any single name while being strictly more controlled than 'any'.
// The row still records the ONE biome that was actually confirmed at the floor, so nothing about the
// experiment's legibility is traded for the findability (Law 25).
//
// WHY RANKED-WITHIN-A-HOP AND NOT PLAINS-EVERYWHERE-FIRST. Strict preference order means sweeping all 24
// hops for plains before ever looking at desert — 24× the teleports and chunk waits for a preference, not
// a control. Instead every accepted biome is collected at each hop and the winner is (rank, then distance),
// so a hop offering both plains and savanna always yields plains, and a hop offering only savanna yields
// it rather than costing another 23 hops. The cost is named because it is real: a plains 200 b away loses
// to a savanna 40 b away.
//
// Usage (normally driven by lanista_ladder, but standalone for a look around):
//   node lanista_biome.js --biome=open [--bot=AurenBot] [--hops=24] [--hop=96]
//   node lanista_biome.js --biome=plains,desert          an ad-hoc group, ranked left to right
//   node lanista_biome.js --biome=plains                 one name, exactly as before

'use strict';

const {
  SCOUT_NAME, SITING,
  arena, fmt, log, sleep,
} = require('./lanista_shared');
const lanista = require('./lanista');

// The scout's own loaded radius. server.properties view-distance is 10 chunks → 160 blocks, and the
// sweep stays inside 128 so a column at the edge of the frontier (which may be mid-load) is never the
// one a trial is sited on.
const SWEEP_RADIUS = 128;
// 8 blocks between samples. Biomes are stored at 4×4×4, so this reads one cell in four — deliberately
// coarse, because the target is a REGION big enough to hold a 15-block arena, and a patch narrower than
// 8 blocks is not one. Halving it would quadruple the sweep for ground the ladder would refuse anyway.
const SWEEP_STEP = 8;
// Three altitudes per column, spanning the surface relief a hop can land in. One altitude misses a hop
// whose ground is a hill; a full column scan costs four orders of magnitude more (see the header).
const SWEEP_LIFTS = [0, 24, 48];
// How far apart two hops are. Slightly less than a full loaded diameter (256) so consecutive rings
// overlap rather than leaving unread seams between them — a seam is exactly where a small patch hides.
const HOP_BLOCKS = 96;
const MAX_HOPS = 24;
// Eight bearings per ring: the four axes plus the four diagonals. More bearings per ring would re-read
// ground the overlap already covers; fewer would leave the seams the overlap exists to close.
const BEARINGS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
// How many of a hop's nearest candidate cells get the expensive box test before the hunt moves on. The
// box test is a terrain sweep per candidate; a hop that offers 300 cells of the right biome and no open
// ground in the first six of them is ground the ladder does not want anyway.
const CANDIDATES_PER_HOP = 6;

// ── THE `open` GROUP, IN PREFERENCE ORDER ───────────────────────────────────────────────────────────
// Ranked by how little stands between two bodies 12 b apart, which is the only property this group is
// for. Plains and desert are flat and empty; savanna and meadow carry sparse trees and are here because a
// world that offers neither of the first two still offers a better swing-tuning floor than a forest. The
// beaches and the snowy variants are last: findable almost anywhere, and flat, but narrow — a beach strip
// can be too thin to hold a 15 b arena, and the box test will say so.
//
// EXCLUDED ON PURPOSE, so a successor does not "helpfully" add them back: every *_forest, taiga, jungle,
// grove, swamp, and windswept_forest (canopy — the thing this group exists to avoid); stony_shore and the
// peaks (treeless but so uneven that relief replaces canopy as the confound); rivers and oceans (the box
// test refuses water, so they only ever cost hops).
//
// ── THE BEACHES CAME OUT, and the reason is structural ──────────────────────────────────────────────
// Beaches were here as a last-resort filler — findable almost anywhere and flat — on the assumption that
// a strip too thin to hold the arena would simply fail the box test. That check was not enough: `beach`
// is by definition the seam between water and whatever rises behind it, so the strips that ARE wide
// enough are exactly the ones with a cliff at their back. A trial sited on such an anchor can take fall
// damage it never attributes to the fight, corrupting the combat result it was supposed to measure.
//
// TWO DEFENCES NOW, NOT ONE, AND THEY ARE NOT REDUNDANT (Law 16's test answered honestly): this list
// decides which biome the hunt FLIES TO, `SITING.ground` decides which anchor inside it is acceptable.
// Removing a biome cannot police the cliff at the edge of a plains; the ground dial cannot stop the hunt
// spending twenty hops on a coastline. Different jobs, different scopes.
const OPEN_GROUND = [
  'plains', 'sunflower_plains', 'desert',
  'savanna', 'savanna_plateau', 'meadow',
  'snowy_plains',
];

const BIOME_GROUPS = { open: OPEN_GROUND };

// resolveTargets — one name, a comma list, or a group name, all reduced to the same ranked map. Kept as
// its own function so the ranking is decided once and every caller below reads it rather than re-parsing
// the string (Law 16 — a second parse is a second answer waiting to disagree).
//
// A BARE STRING IS STILL ACCEPTED at every consumer below, because that is what the existing callers
// pass. Widening a signature is not licence to break the narrow case.
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

// hopCells — the spiral, as pure data. Extracted from the hunt so the sequence can be asserted without a
// server: a hunt that silently changed its own order would make two trials incomparable and nothing
// would say so (this is the file's one determinism claim, so it is the one thing a test can pin).
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

// waitForChunks — the scout has arrived somewhere only when it can ANSWER about it. Polling the biome
// read is the honest test because it is the read the sweep is about to make; polling a fixed sleep would
// be a guess about the server's chunk-send latency, and a wrong guess produces an empty sweep that reads
// exactly like "the target biome is not here" (Law 23 — an unread cell is unknown, never a verdict).
async function waitForChunks(scout, cell, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (scout.biomeAt(cell).known && scout.blockAt(cell) !== null) return true;
    await sleep(400);
  }
  return false;
}

// sweepForBiome — every sampled column at this hop whose biome is in the target set, best first.
//
// BEST = (rank, then distance). Rank first because the group is a PREFERENCE and the box test below is
// the expensive half — only the first few candidates get one, so the order decides which ground the trial
// actually lands on. Distance second because within one rank there is nothing to choose between two
// columns except how far the fight ends up from where the bot started.
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

// confirmGround — the promotion from claim to fact (Law 23). A biome sample says the REGION is right; it
// says nothing about whether a body can stand there. The open-box test is the construct's own siting
// criterion, imported rather than restated (Law 16), and the biome is re-read AT THE BOX'S FLOOR because
// that — not the sampled altitude — is where the fight will happen.
async function confirmGround(scout, candidate, target) {
  const targets = resolveTargets(target);
  const dials = { blueprint: SITING.blueprint, flatness: SITING.flatness };
  const spawn = await arena.findBotSpawn(arena.readerFromScout(scout), candidate, dials);
  if (!spawn.found) return { ok: false, why: `no open box near ${fmt(candidate)} (${spawn.reason || 'terrain'})` };
  const cell = { x: spawn.box.x, y: spawn.box.y, z: spawn.box.z };
  const biome = lanista.readBiome(scout, cell);
  if (biome === null) return { ok: false, why: `the box at ${fmt(cell)} is not readable — its column is not loaded` };
  // The sample and the floor disagreeing is the NORMAL case at a biome edge, not a fault: the sample was
  // taken at a fixed altitude and the box resolved a real floor some blocks away. It is reported, not
  // repaired, because the only thing that matters is what the floor says.
  //
  // A GROUP IS CHECKED AS A SET, never as the name the SAMPLE happened to hit: the floor is what the fight
  // stands on, and a floor of 'desert' under a 'plains' sample is a perfectly good `open` arena. Falling
  // back to the sample's own name here would refuse it and cost a hop for nothing.
  if (!targets.has(biome)) {
    return { ok: false, why: `the box at ${fmt(cell)} is '${biome}', not ${describeTarget(target)} — a biome edge` };
  }
  return { ok: true, cell, biome };
}

// ── The hunt ────────────────────────────────────────────────────────────────────────────────────────
//
// Returns { found, cell, biome, hops, scanned, why } — and `hops` is on the result rather than in a log
// line because it belongs in the trial row: a biome found on hop 0 and a biome found on hop 19 are the
// same control, but the second one is 19 hops from the fleet's base and the reader is owed that.
//
// 'any' short-circuits to the origin and reports the biome it finds there. The ladder is meant to be
// runnable without a biome control at all — the first thing anyone does with a new bench is run it where
// they are standing — and forcing a declared biome to do that would make the honest cheap run impossible.
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
        // The hunt teleports the scout to each HOP, then reads a target column up to SWEEP_RADIUS (128b)
        // further out and hands that cell back. Without this move the scout is left standing at the hop
        // while the caller sites a fight 100+ blocks away — and everything the caller does next reads
        // through the scout: the reach gate's A* and the sightline partition both run on its chunk cache.
        // At that distance the cache is ragged or absent, so a box the terrain would have accepted is
        // refused for want of data.
        //
        // A reach-gate refusal produced from an absent chunk cache reads as terrain unfightable when it
        // is really the instrument reporting its own blindness — the Law 23 failure pointed inward: a
        // verification run on absent data is a claim wearing a fact's clothes (Law 25 — the refusal is
        // true about the search and false about the ground).
        //
        // Reuses the hunt's own two lines — the same tp and the same waitForChunks the hops already use
        // — rather than adding a second way to move the instrument (Law 16). A cell whose chunks never
        // arrive is NOT returned: it would hand the caller the same blindness one step later.
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

  // A shortfall is reported as a shortfall, with what was actually looked at — never as "no such biome"
  // (which this cannot know: it searched a spiral, not the world) and never as a silent fall back to
  // wherever the bot happened to be standing (Law 25).
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
