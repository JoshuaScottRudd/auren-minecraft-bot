'use strict';
// foreman/utils/get_crew.js — the one way a crew is raised, and the read of a base a crew already holds.
//
//   bind({ door, hub, getBot })    the foreman's recorded door, its hub, and its body
//   getCrew(species, opts)          gates the landing's ground, sites the base, launches the crew;
//                                   → { ok: true } or { ok: false, code, why }
//   existingSite(buildings, key)    the base a crew already holds, exactly as it was locked
//
// One caller: the foreman raising its own crew, from the cell its body landed on (`at`).

const { BOT_SENIORITY, BASE_CLEAR_OF_SPAWN, SEA_LEVEL, LANDING_SURFACE_SLACK, LANDING_MAX_ABOVE_SEA,
        settles } = require('@thinking/architect_config');
const record = require('../foreman_record');
const { log } = require('./say');
const { startBot, firstMeaningfulLine } = require('./crew_launch');
// The crew the run page sizes, the one answer shared with the startup proof and the cameras (Law 16).
const CREW_COUNT = require('../../foreman_config').count;
// The ground test the foreman declines on, and the same one every base is sited with (Law 16).
const siteGeometry = require('@utils/site_geometry');
const { worldSpawnPoint, chebyshevFromWorldSpawn } = require('@perception/spawn_protection');
const { getBiomeName } = require('@perception/biome_scanner');      // the one biome read (Law 16)
// The body's own siter, run dry, so the foreman's answer and the crew's answer agree (Law 16).
const lockAllBuildspots = require('@action/lock_all_buildspots');
const { roomKeyName, roomKeyCrew } = require('@foreman/message_schema');
const { makeVoxelReader } = require('@utils/voxel_reader');

let door = null;
let hub = null;
let getBot = () => null;
function bind(c) { ({ door, hub, getBot } = c); }

// How long a crew gets to appear in the registry, matched to `fleet_control.waitForBotsOnline`'s 90s so
// the two answers cannot drift apart (Law 16).
const CREW_ARRIVAL_WAIT_MS = 90000;
// How often the registry is polled — a local socket, so the poll interval is nearly the whole wait.
const CREW_ARRIVAL_POLL_MS = 250;
// Per body, not per crew: half the total budget, so one missing body can't exhaust the next one's share.
const BODY_ARRIVAL_WAIT_MS = CREW_ARRIVAL_WAIT_MS / 2;
// ── THE GAP BETWEEN TWO LOGINS FROM ONE MACHINE ──────────────────────────────────────────────────────
// A server may rate-limit logins per source address, and the whole fleet is one address. Floor spacing,
// paid only when the previous body failed to register; a registered body already spaced the launches by
// its own arrival and first step.
const CREW_LAUNCH_GAP_MS = 5000;
// ── THE NEXT BODY WAITS FOR THE LAST ONE TO START WALKING ─────────────────────
// Each body is followed past its first route search (`first_move_at`, via navigator.announceFirstMove)
// before the next launches — planning blocks the event loop, so launching several at once starves them
// of CPU. A ceiling, not a pace: a body with nowhere to walk never posts the moment.
const FIRST_MOVE_CEILING_MS = 45000;

// How many bodies may stand on the spawn spot at once, each lane launching its next the moment its last
// body walks off; lanes open SPAWN_LANE_OFFSET_MS apart so two logins never land on one tick.
const SPAWN_LANES = 2;
const SPAWN_LANE_OFFSET_MS = 1000;

// How close "on the cell" means, matched to the body's own arrival tolerance so the foreman and body
// agree on the same cell (Law 25).
const CREW_PLACEMENT_RADIUS = 4;

// The names a crew is raised from: every roster name by seniority, or only the ones the run names (foreman_config.only).
const ONLY = require('../../foreman_config').only;
const ROSTER = Object.keys(BOT_SENIORITY).filter(id => !ONLY || ONLY.includes(id)).sort((a, b) => BOT_SENIORITY[a] - BOT_SENIORITY[b]);

// A refusal: recorded under its code, logged with its numbers, and handed back to the step that asked.
function refuse(code, why) {
  record.refused(code, why);
  log(`crew raise refused [${code}]: ${why}`);
  return { ok: false, code, why };
}

// existingSite(buildings, crewKey) → { site, seat, unreadable } for the base this crew already holds, or
// null when it holds none — read from the fleet's memory (Invariant B), exactly as locked. `unreadable`
// names a buildspot with no blueprint record, a damaged row (`set_buildspot` writes both chairs at once).
function existingSite(buildings, crewKey) {
  const site = [];
  const unreadable = [];
  for (const [key, entry] of Object.entries(buildings || {})) {
    if (roomKeyCrew(key) !== crewKey) continue;
    const spot = entry && entry.set_buildspot;
    if (!spot || !spot.transpose_origin) continue;
    const blueprint = entry.blueprint_paster && entry.blueprint_paster.building_name;
    if (!blueprint) { unreadable.push(key); continue; }
    site.push({
      blueprint,
      roomKey: roomKeyName(key),
      candidate: { transpose_origin: spot.transpose_origin, footprint: spot.footprint || null, staircase: spot.staircase || null },
    });
  }
  if (site.length === 0 && unreadable.length === 0) return null;
  // A crew seats at its alpha structure (architect_config.ALPHA_STRUCTURE); every species' alpha is a
  // candidate since this reads a stored site, not a species.
  const alphas = Object.values(require('@thinking/architect_config').ALPHA_STRUCTURE);
  const seatRow = site.find(r => alphas.includes(r.roomKey)) || site[0];
  const c = seatRow && seatRow.candidate.transpose_origin;
  return { site, seat: c ? { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) } : null, unreadable };
}

// missingFromBase(species, site) → the structures this crew raises (STRUCTURE_PRIORITY; the mine's site is its
// SHAFT_HEAD; the wheat and cane field copies critical mass asks for) that the held base has no row for: a structure added to
// the crew after its base was sited.
function missingFromBase(species, site) {
  const { STRUCTURE_PRIORITY, SHAFT_HEAD } = require('@thinking/architect_config');
  const sited = new Set(site.map(r => r.roomKey));
  const fields = require('@utils/calculators/wheat_critical_mass').fieldKeysSited(species);
  return [...new Set([...(STRUCTURE_PRIORITY[species] || []), ...fields].map(s => (s === 'shallow_shaft' ? SHAFT_HEAD[species] : s)))]
    .filter(s => !sited.has(s));
}

// ── getCrew — the one way a crew is raised ──────────────────────────────────────────────
// Gates the landing's ground, sites the base into the fleet's memory, launches the crew one body at a time
// (Law 16). `at` is the cell the foreman's body landed on; `build` is builder.build or null; `resume` is a
// continued run, whose crew goes back to the base in memory with nobody placed; `siteOnly` stops once the
// base is in memory.
async function getCrew(species, { at = null, build = null, siteOnly = false, resume = false, held = false }) {
  const bot = getBot();
  const size = CREW_COUNT;

  const state = await door.query();
  if (!state.ok) return refuse('fleet_unreachable', `door.query failed: ${state.error}`);
  // A half crew is completed, not treated as full: every connected body counts toward whether the crew is
  // staffed (Invariant B).
  const standingNow = state.bots;
  if (!siteOnly && standingNow.length >= size) {
    return refuse('crew_full', `crew full: ${standingNow.map(b => b.id).join(', ')} of ${size}`);
  }
  const needed = size - standingNow.length;

  // A name is not invented — the roster is the ceiling, so a short house is reported as short (Law 13).
  const free = ROSTER.filter(id => !state.bots.some(b => b.id === id));
  if (!siteOnly && free.length < needed) {
    return refuse('roster_short', `only ${free.length} of ${ROSTER.length} roster names free and ${needed} are needed`);
  }
  const crew = free.slice(0, Math.max(needed, 0));

  // ── A CONTINUED RUN PUTS NOBODY ANYWHERE ──────────────────────────────────
  // Its base is the one in memory and each body starts where the last run left it standing, so there is
  // no ground to measure and no cell to place a body on: the crew is launched with no placement at all.
  const heldBase = existingSite(state.buildings, species);
  if (resume && !heldBase) {
    return refuse('nothing_to_continue', `start is 'continue' and the fleet's memory holds no base under '${species}' — a `
      + `continued run carries on from a base an earlier run sited; start: 'rollback' sites one`);
  }
  let feet = null;
  let reader = null;
  let placeAt = '';
  if (!resume) {
    const ground = await landingGround(bot, at);
    if (!ground.ok) return ground;
    ({ feet, reader, placeAt } = ground);
  }

  // ── AND THE WHOLE BASE IS SITED BEFORE ANYBODY IS SPAWNED ─────────────────
  // The same siter the body uses, run dry (Law 16), written into the fleet's memory before any body
  // exists, surveyed from the landing. A crew that already has a base is sent to it — the survey below is
  // blind to the fleet's memory, so without this read it would hand a second site and the hub would refuse
  // it against the crew's lock.
  let site;
  let seat;
  if (heldBase && heldBase.unreadable.length) {
    return refuse('base_record_damaged', `building row(s) with a site but no blueprint record: ${heldBase.unreadable.join(', ')} — `
      + 'a rollback start clears them');
  }
  if (heldBase) {
    site = heldBase.site;
    seat = heldBase.seat;
    // A STRUCTURE THE CREW GAINED SINCE ITS BASE WAS SITED is sited now, around the base it holds: the survey keeps every
    // held structure where it stands (lock_all_buildspots `held`) and the hub locks only the rows it adds.
    const gained = missingFromBase(species, site);
    if (gained.length) {
      const kept = new Map(site.map(r => [r.roomKey, r.candidate]));
      const layout = await lockAllBuildspots.run(bot, { dryRun: true, species, held: kept, origin: seat, build });
      const rows = layout.ok ? layout.site.filter(r => gained.includes(r.roomKey)) : [];
      if (layout.transient || !layout.ok || rows.length < gained.length) {
        return refuse('base_gain_unsited', `held base lacks [${gained.join(', ')}]; survey around (${seat.x},${seat.y},${seat.z}) `
          + (layout.transient ? 'hit unloaded chunks' : `gave [${rows.map(r => r.roomKey).join(', ')}]: ${(layout.problems || []).join('; ')}`)
          + `\n  survey:\n  ${(layout.report || []).join('\n  ')}`);
      }
      await hub.lockSite(rows, species);
      site = [...site, ...rows];
      record.note(`'${species}' base gained [${gained.join(', ')}] — sited beside the held base, the rest kept`);
    }
    record.note(`'${species}' already has a base — handing it back, no survey: ${site.map(r => r.roomKey).join(', ')}`);
  } else {
    const layout = await lockAllBuildspots.run(bot, { dryRun: true, species, unlockedWorld: true, origin: feet, build });
    if (layout.transient) return refuse('world_streaming', 'base-layout dry run hit unloaded chunks');
    if (!layout.ok) {
      return refuse('no_base_site', `base-layout dry run refused: ${layout.problems.join('; ')}\n  survey:\n  ${layout.report.join('\n  ')}`);
    }
    site = layout.site;
    seat = layout.anchor;
    // The foreman writes the site into memory before any body exists; an existing base above is not rewritten.
    await hub.lockSite(site, species);
    await scanHomeSector(bot, site, species);
  }

  // ── THE CREW IS PUT DOWN ON THE BUILD, NOT ON THE LANDING ──────
  // The landing was the only ground known before the base was sited; now it moves to where the work is.
  // Asks `hub.alphaSpot()`, the one answer to where the crew's home cell is (Law 16). The landing cell
  // stays as the fallback for a seat whose chunks haven't streamed in.
  const alpha = !resume ? hub.alphaSpot() : null;
  if (alpha) {
    const atAlpha = await siteGeometry.standingSpotNear(reader, { x: alpha.x, y: alpha.y, z: alpha.z },
      { radius: CREW_PLACEMENT_RADIUS });
    if (atAlpha.found) {
      placeAt = `${atAlpha.cell.x} ${atAlpha.cell.y} ${atAlpha.cell.z}`;
      record.note(`crew placed on the ${alpha.structure} anchor at ${placeAt}`);
    } else {
      record.note(`the ${alpha.structure} anchor has no readable standing cell (${atAlpha.why}) — crew placed on the landing at ${placeAt}`);
    }
  }
  if (seat) log(`${resume ? 'continuing at' : 'base at'} (${seat.x}, ${seat.y}, ${seat.z})`);

  // ── A CONTINUED CREW CARRIES ITS HOME CELL ──────
  // Nobody is placed, but a body the last rollback never raised logs in at world spawn; it is put on this cell
  // (start_injector), the same anchor a rollback places the crew on. Read from the foreman's own ground reader; an
  // unreadable anchor is noted and the crew goes without one.
  let homeCell = '';
  const home = resume ? hub.alphaSpot() : null;
  if (home) {
    const atHome = await siteGeometry.standingSpotNear(makeVoxelReader(bot), { x: home.x, y: home.y, z: home.z },
      { radius: CREW_PLACEMENT_RADIUS });
    if (atHome.found) {
      homeCell = `${atHome.cell.x} ${atHome.cell.y} ${atHome.cell.z}`;
      record.note(`continued crew's home cell on the ${home.structure} anchor at ${homeCell}`);
    } else {
      record.note(`the ${home.structure} anchor has no readable standing cell (${atHome.why}) — a continued body at world spawn has no home cell`);
    }
  }

  // The foreman's own startup sites and raises as two steps; this call stops here with the base in memory.
  if (siteOnly) return { ok: true };

  return launchCrew({ species, crew, size, placeAt, held, homeCell });
}

// ── THE CREW ARRIVES TO A BOOK WITH ITS HOME PAGE ────────────────────────────────────────────────────
// The home sector is sector 0,0, the one the alpha structure stands in (assessors/survey.home reads the same chair).
// Scanned on the foreman's own body from what it has loaded; when the home sector's ground is not loaded here the page
// is left for the crew's own home-sector job, and the note says so.
async function scanHomeSector(bot, site, species) {
  const head = require('@thinking/architect_config').ALPHA_STRUCTURE[species];
  const row = site.find(r => r.roomKey === head);
  const home = row && row.candidate && row.candidate.transpose_origin;
  if (!home) { record.note(`home sector: no '${head}' row in the sited base, so no home scan from the foreman`); return; }
  const scan = await require('@perception/sector_scan').foremanScan(bot, home);
  if (!scan) { record.note(`home sector of (${home.x},${home.y},${home.z}) is not loaded ground for the foreman — the crew scans it`); return; }
  hub.recordSurvey(scan.pages);
  record.note(`home sector ${scan.sector} scanned by the foreman from (${scan.stand.x},${scan.stand.y},${scan.stand.z}): `
    + `${scan.categories} categories`);
}

// landingGround(bot, at) → { ok: true, feet, reader, placeAt }, or a refusal.
// ── NOTHING IS LAUNCHED UNTIL THE LANDING'S GROUND WILL HOLD A BODY ─────────────────────
// The foreman declines before spawning when the landing cannot hold a crew — the last moment a refusal is
// free (Law 13, Law 16).
async function landingGround(bot, at) {
  if (!at) return refuse('no_landing', 'no landing cell to measure ground against');
  const feet = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };

  // ── AND NOT AT WORLD SPAWN ───────────────────
  // Refuses a landing inside the spawn-protected square (Law 16), where every break and placement is
  // blocked. Clearance is read from config, measured Chebyshev; an unknown centre refuses too (Law 13).
  const spawnAt = worldSpawnPoint(bot);
  if (!spawnAt) return refuse('world_spawn_unknown', 'no spawn_position packet latched for the foreman — cannot measure the landing\'s clearance');
  const outFromSpawn = chebyshevFromWorldSpawn(bot, feet);
  if (outFromSpawn < BASE_CLEAR_OF_SPAWN) {
    return refuse('too_close_to_world_spawn', `the landing (${feet.x},${feet.y},${feet.z}) is ${outFromSpawn}b Chebyshev from world spawn `
      + `(${spawnAt.x},${spawnAt.z}), inside the ${BASE_CLEAR_OF_SPAWN}b clearance`);
  }

  // ── ON THE OVERWORLD SURFACE, NEAR SEA LEVEL ───────────────────────────────
  // This fleet sites bases on the overworld surface near sea level (the headframe and the shallow shaft sink from
  // the surface).
  const reader = makeVoxelReader(bot);
  const ground = siteGeometry.surfaceY(reader, feet.x, feet.z, feet.y);
  if (!ground) return refuse('ground_unreadable', `surfaceY found no ground in the window at (${feet.x},${feet.z}) ref y=${feet.y}`);
  if (feet.y < ground.y - LANDING_SURFACE_SLACK) {
    return refuse('underground', `the landing is at y=${feet.y}, and the surface of that column is y=${ground.y} (${ground.name})`);
  }
  if (feet.y > SEA_LEVEL + LANDING_MAX_ABOVE_SEA) {
    return refuse('too_high', `the landing is at y=${feet.y}, and the ceiling is SEA_LEVEL+${LANDING_MAX_ABOVE_SEA}=${SEA_LEVEL + LANDING_MAX_ABOVE_SEA}`);
  }
  // The biome at the feet, judged against the same banned-biome list the siter gates on (Law 16).
  const biome = getBiomeName(bot, feet.x, feet.y, feet.z);
  if (!settles(biome)) return refuse('biome', `the landing stands in '${biome}', in BANNED_BIOMES`);

  const room = await siteGeometry.standingSpotNear(reader, feet, { radius: CREW_PLACEMENT_RADIUS });
  // ── THE CREW IS PLACED ON THE CELL MEASURED HERE ─────────────────
  // One placement for every crew (Law 16), handed to each body as "x y z". Re-pointed at the alpha anchor
  // once the base is sited; this is the fallback for a seat whose chunks haven't streamed in.
  if (!room.found) return refuse('no_standing_room', room.why);
  return { ok: true, feet, reader, placeAt: `${room.cell.x} ${room.cell.y} ${room.cell.z}` };
}

// launchCrew — brings the named bodies up one lane at a time and says what actually arrived. `placeAt` is
// the cell every body is put on, "x y z", or '' for a crew that starts where each body stands.
async function launchCrew({ species, crew, size, placeAt, held = false, homeCell = '' }) {
  log(`raising ${crew.join(' and ')}`);
  // The crew list is fixed above, so the lanes below never race the free-bot list.
  // ── AT MOST SPAWN_LANES BODIES ON THE SPAWN SPOT ──────────────────────────────────────────────────
  // Each lane launches a body, waits for it to register, and waits for it to walk off before launching its
  // next, so the spot never holds more than SPAWN_LANES bodies and a fast walker frees its lane at once.
  // Sequenced on registration, not the launcher's return (Law 26). No retry — a shortfall is reported, not
  // relaunched.
  const said = [];
  const standing = [];
  let reach = null;                       // the last fleet error, when the registry could not be read
  const queue = crew.slice();
  const bringOne = async (target) => {
    const r = await startBot(target, species, placeAt, held, homeCell);
    said.push(firstMeaningfulLine(r.out) || `${target}: the launcher exited ${r.code}`);

    // Polled, not slept-then-checked, so a fast registration is brought over fast.
    const deadline = Date.now() + BODY_ARRIVAL_WAIT_MS;
    let seen = false;
    for (;;) {
      const state2 = await door.query();
      if (!state2.ok) { reach = state2.error; break; }
      reach = null;
      if (state2.bots.some(b => b.id === target)) { seen = true; break; }
      if (Date.now() >= deadline) break;
      await new Promise(r2 => setTimeout(r2, CREW_ARRIVAL_POLL_MS));
    }
    if (!seen) {
      log(`${target} did not register within ${BODY_ARRIVAL_WAIT_MS}ms`);
      await new Promise(r => setTimeout(r, CREW_LAUNCH_GAP_MS));   // the lane's spacing, since no arrival gave it
      return;
    }
    standing.push(target);

    // Off the spot before this lane launches again (FIRST_MOVE_CEILING_MS); nothing waits on a body with
    // no successor, nor on a held body, which stands still until the operator's `start`.
    if (!queue.length || held) return;
    const t0 = Date.now();
    let moved = false;
    for (;;) {
      const state3 = await door.query();
      if (state3.ok && state3.bots.some(b => b.id === target && b.first_move_at)) { moved = true; break; }
      if (Date.now() - t0 >= FIRST_MOVE_CEILING_MS) break;
      await new Promise(r3 => setTimeout(r3, CREW_ARRIVAL_POLL_MS));
    }
    log(moved
      ? `${target} is walking ${((Date.now() - t0) / 1000).toFixed(1)}s after registering — its lane launches the next body`
      : `${target} did not start walking within ${FIRST_MOVE_CEILING_MS / 1000}s — its lane launches the next body anyway (the ceiling, not the pace)`);
    // The body places itself and confirms it (`body_recovery.arriveAtCell`); one place a crew is put (Law 16).
  };
  const lane = async (k) => {
    if (k > 0) await new Promise(r => setTimeout(r, SPAWN_LANE_OFFSET_MS * k));
    while (queue.length) await bringOne(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(SPAWN_LANES, crew.length) }, (_, k) => lane(k)));
  log(`raised ${crew.join(', ')} -> ${said.join(' | ')} | stood: ${standing.join(', ') || 'none'}`);

  // ── WHAT ARRIVED IS ASKED OF THE FLEET, NEVER QUOTED FROM THE LAUNCHER ─────────────────────────
  // A launcher says whether it started a process; the registry says whether a body is standing (Law 26).
  // Registry unreachable is a third answer, not a failure — the foreman truthfully doesn't know (Law 25).
  if (reach && standing.length === 0) {
    return { ok: false, code: 'crew_unconfirmed', why: `door.query failed: ${reach} | launcher said: ${said.join(' | ')}` };
  }
  if (standing.length >= crew.length) {
    log(`${standing.join(' and ')} ${standing.length === 1 ? 'is' : 'are'} ${held ? 'waiting for start' : 'working'}`);
    return { ok: true };
  }
  const missing = crew.filter(id => !standing.includes(id));
  return refuse('crew_short', `${standing.length} of ${size} stood; missing ${missing.join(', ')}; launcher said: ${said.join(' | ')}`);
}

module.exports = { bind, getCrew, existingSite };
