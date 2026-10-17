'use strict';
// foreman/utils/get_crew.js — the one way a crew is raised, and the read of a base a crew already holds.
//
//   bind({ door, desk, getBot })   the foreman's recorded door, its hub, and its body
//   getCrew(from, species, opts)   gates the asker's ground, sites the base, launches the crew
//   existingSite(buildings, key)   the base an owner already holds, exactly as it was locked
//
// Two callers, one road (Law 16): a person's `foreman get <species>` and the foreman raising its own crew.

const { FOREMAN_PREFIX, BOT_SENIORITY, PERSON_CLEAR_OF_SPAWN, SEA_LEVEL, HUMAN_SURFACE_SLACK, HUMAN_MAX_ABOVE_SEA,
        ACCEPTABLE_BIOMES } = require('@thinking/architect_config');
const record = require('../foreman_record');
const { log } = require('./say');
const { startBot, firstMeaningfulLine } = require('./crew_launch');
const { crewSizeFor } = require('../foreman_vocabulary');
const correction = require('../correction');
// The ground test the desk declines on, and the same one every base is sited with (Law 16).
const siteGeometry = require('@utils/site_geometry');
const { worldSpawnPoint, chebyshevFromWorldSpawn } = require('@perception/spawn_protection');
const { getBiomeName } = require('@perception/biome_scanner');      // the one biome read (Law 16)
// The body's own siter, run dry, so the desk's answer and the crew's answer agree (Law 16).
const lockAllBuildspots = require('@action/lock_all_buildspots');
const { ownerKeyFor } = require('@kernel/bot_mandate');
const { roomKeyName, roomKeyOwner } = require('@foreman/message_schema');
const { makeVoxelReader } = require('@utils/voxel_reader');

let door = null;
let desk = null;
let getBot = () => null;
function bind(c) { ({ door, desk, getBot } = c); }

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

// How close "beside the human" means, matched to the body's own arrival tolerance so the desk and body
// agree on the same cell (Law 25).
const CREW_PLACEMENT_RADIUS = 4;

const ROSTER = Object.keys(BOT_SENIORITY).sort((a, b) => BOT_SENIORITY[a] - BOT_SENIORITY[b]);

// existingSite(buildings, ownerKey) → { site, seat, unreadable } for the base this crew already holds, or
// null when it holds none — read from the fleet's memory (Invariant B), exactly as locked. `unreadable`
// names a buildspot with no blueprint record, a damaged row (`set_buildspot` writes both chairs at once).
function existingSite(buildings, ownerKey) {
  const site = [];
  const unreadable = [];
  for (const [key, entry] of Object.entries(buildings || {})) {
    if (roomKeyOwner(key) !== ownerKey) continue;
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

// ── getCrew — the one way a crew is raised ──────────────────────────────────────────────
// Gates the asker's ground, sites the base into the fleet's memory, launches the crew one body at a time
// (Law 16). `at` is the foreman's own position when raising its own crew; `build` is builder.build or null;
// `resume` is a continued run, whose crew goes back to the base in memory with nobody placed.
async function getCrew(from, species, { reply, correct, trouble, at = null, build = null, siteOnly = false, resume = false, held = false }) {
  const bot = getBot();
  const wantsContractors = species === 'contractor';
  const size = crewSizeFor(species);   // the one crew-size answer shared with startup proof and cameras

  const state = await door.query();
  if (!state.ok) {
    trouble(from, 'fleet_unreachable', "can't check what you have right now — try again in a moment.",
            `door.query failed on get: ${state.error}`);
    return;
  }
  // A half crew is completed, not treated as full (Law 27): `get` means "bring me up to a crew". A
  // contractor crew is counted against the asker; a homestead has no owner by constitution (`bot_mandate`),
  // so every ownerless body counts toward whether it is staffed (Invariant B) — one predicate, used both
  // here and to recognise each body as it registers below (Law 16).
  const isOurs = (b) => (wantsContractors ? b.owner === from : !b.owner);
  const mine = state.bots.filter(isOurs);
  if (mine.length >= size) {
    const said = `${FOREMAN_PREFIX} get ${species}`;
    const names = mine.map(b => b.id);
    correct(wantsContractors
      ? correction.crewFull(said, names, size)
      : correction.homesteadFull(said, names, size));
    return;
  }
  const needed = size - mine.length;

  // A name is not invented — the roster is the ceiling, so a short house is reported as short (Law 13).
  // A partial crew is refused whole (Law 13, default-stopped; Law 25), counted against what is still
  // needed so somebody holding one bot isn't told the house is full.
  const free = ROSTER.filter(id => !state.bots.some(b => b.id === id));
  if (free.length < needed) {
    // Two numbers only — how many are free, how many a crew needs (Law 24).
    reply(`only ${free.length} of ${ROSTER.length} bots free and a crew is ${size} — somebody has to let theirs go first.`);
    return;
  }
  const crew = free.slice(0, needed);

  // ── A CONTINUED RUN PUTS NOBODY ANYWHERE ──────────────────────────────────
  // Its base is the one in memory and each body starts where the last run left it standing, so there is
  // no ground to measure and no cell to place a body on: the crew is launched with no placement at all.
  const ownerKey = ownerKeyFor(species, wantsContractors ? from : '');
  const heldBase = existingSite(state.buildings, ownerKey);
  if (resume && !heldBase) {
    record.refused(from, 'nothing_to_continue', `${crew.length} launch(es) withheld`);
    trouble(from, 'nothing_to_continue',
      `there is no base to continue from. Nobody was sent.`,
      `start is 'continue' and the fleet's memory holds no base under '${ownerKey}' — a continued run carries on from `
      + `a base an earlier run sited; start: 'rollback' sites one | withheld ${crew.join(', ')}`);
    return;
  }
  const ground = resume ? { feet: null, reader: null, placeAt: '' } : await groundBesideAsker(bot, from, crew, at, trouble);
  if (!ground) return;
  const { feet, reader } = ground;
  let placeAt = ground.placeAt;

  // ── AND THE WHOLE BASE IS SITED BEFORE ANYBODY IS SPAWNED ─────────────────
  // The same siter the body uses, run dry (Law 16), written into the fleet's memory before any body
  // exists, surveyed from the person's feet.
  // A crew that already has a base is sent to it — the survey below is blind to the fleet's memory, so
  // without this read it would hand a second site and the hub would refuse it against the crew's lock.
  let site;
  let seat;
  if (heldBase && heldBase.unreadable.length) {
    record.refused(from, 'base_record_damaged', `${crew.length} launch(es) withheld`);
    trouble(from, 'base_record_damaged',
      `your saved base is damaged, so I won't send a crew into it. "${FOREMAN_PREFIX} wipe" clears it. Nobody was sent.`,
      `building row(s) with a site but no blueprint record: ${heldBase.unreadable.join(', ')} | withheld ${crew.join(', ')}`);
    return;
  }
  if (heldBase) {
    site = heldBase.site;
    seat = heldBase.seat;
    record.note(`${from}: '${ownerKey}' already has a base — handing it back, no survey: ${site.map(r => r.roomKey).join(', ')}`);
  } else {
    reply('checking the ground around you...');
    const layout = await lockAllBuildspots.run(bot, { dryRun: true, species, unlockedWorld: true, origin: feet, build });
    if (layout.transient) {
      record.refused(from, 'world_streaming', `${crew.length} launch(es) withheld`);
      trouble(from, 'world_streaming',
        `the world around you is still loading — try again in a few seconds. Nobody was sent.`,
        `base-layout dry run hit unloaded chunks | withheld ${crew.join(', ')}`);
      return;
    }
    if (!layout.ok) {
      record.refused(from, 'no_base_site', `${crew.length} launch(es) withheld`);
      // One problem in chat, all of them in the log — a full survey line is a wall of text, and the first
      // line is what they can act on (Law 24).
      const firstProblem = String(layout.problems[0] || 'the ground here will not hold it').slice(0, 90);
      trouble(from, 'no_base_site',
        `no room for a base here — ${firstProblem}. Try flatter ground near a river. Nobody was sent.`,
        `base-layout dry run refused: ${layout.problems.join('; ')}\n  survey:\n  ${layout.report.join('\n  ')}\n  withheld ${crew.join(', ')}`);
      return;
    }
    site = layout.site;
    seat = layout.anchor;
    // The desk writes the site into memory before any body exists; an existing base above is not rewritten.
    await desk.lockSite(site, ownerKey);
  }

  // Said before the crew is fetched, so the reason a body walks off arrives before it walks. A contractor's
  // house lands near the person; a homestead follows the water and can be far out.
  if (seat && resume) {
    reply(`continuing at the base at (${seat.x}, ${seat.y}, ${seat.z}) — each of the crew starts where it stood.`);
  } else if (seat) {
    const far = Math.round(Math.hypot(seat.x - feet.x, seat.z - feet.z));
    reply(heldBase
      ? `your base is already at (${seat.x}, ${seat.y}, ${seat.z}) — ${far}b away. sending the crew there.`
      : `base goes at (${seat.x}, ${seat.y}, ${seat.z}) — ${far}b ${far > 60 && species === 'homesteader' ? 'out, following the water' : 'away'}.`);
  }
  // ── THE CREW IS PUT DOWN ON THE BUILD, NOT BESIDE THE PERSON WHO ASKED ──────
  // The cell above was the only ground known before the base was sited; now it moves to where the work is.
  // Asks `desk.alphaSpot()`, the same function `foreman teleport` sends a person to (Law 16). The
  // asker's cell stays as the fallback for a seat whose chunks haven't streamed in.
  const alpha = (!resume && desk.alphaSpot) ? desk.alphaSpot() : null;
  if (alpha) {
    const atAlpha = await siteGeometry.standingSpotNear(reader, { x: alpha.x, y: alpha.y, z: alpha.z },
      { radius: CREW_PLACEMENT_RADIUS });
    if (atAlpha.found) {
      placeAt = `${atAlpha.cell.x} ${atAlpha.cell.y} ${atAlpha.cell.z}`;
      record.note(`${from}: crew placed on the ${alpha.structure} anchor at ${placeAt}`);
    } else {
      record.note(`${from}: the ${alpha.structure} anchor has no readable standing cell (${atAlpha.why}) — crew placed beside the asker at ${placeAt}`);
    }
  }

  // The foreman's own startup sites and raises as two steps; this call stops here with the base in memory.
  if (siteOnly) return;

  return launchCrew({ from, species, crew, mine, needed, size, wantsContractors, isOurs, placeAt, reply, trouble, held });
}

// groundBesideAsker(bot, from, crew, at, trouble) → { feet, reader, placeAt }, or null once it has refused.
// ── NOTHING IS LAUNCHED UNTIL THE GROUND BESIDE THE ASKER WILL HOLD A BODY ─────────────────────
// The desk declines before spawning when there's no standing spot beside the human — the last moment a
// refusal is free (Law 13, Law 16); no entity in the player table is "can't see", not "no room" (Law 23).
async function groundBesideAsker(bot, from, crew, at, trouble) {
  const asker = at ? { position: at } : (bot.players && bot.players[from] && bot.players[from].entity);
  if (!asker || !asker.position) {
    trouble(from, 'asker_unseen', `I can't see where you're standing, so I won't send anyone. Come back into view and say "${FOREMAN_PREFIX} get" again.`,
            `no entity for '${from}' in the desk's player table — nothing to measure ground against`);
    return null;
  }
  const feet = { x: Math.floor(asker.position.x), y: Math.floor(asker.position.y), z: Math.floor(asker.position.z) };

  // ── AND NOT AT WORLD SPAWN, WHICHEVER OF US IS ASKING ───────────────────
  // Refuses a launch inside the spawn-protected square (Law 16), where every break and placement is
  // blocked. Clearance is read from config, measured Chebyshev; an unknown centre refuses too (Law 13).
  const spawnAt = worldSpawnPoint(bot);
  if (!spawnAt) {
    record.refused(from, 'world_spawn_unknown', `${crew.length} launch(es) withheld`);
    trouble(from, 'world_spawn_unknown',
      `I don't know where world spawn is yet — try again in a moment. Nobody was sent.`,
      `no spawn_position packet latched for the desk — cannot measure ${from}'s clearance | withheld ${crew.join(', ')}`);
    return null;
  }
  const outFromSpawn = chebyshevFromWorldSpawn(bot, feet);
  if (outFromSpawn < PERSON_CLEAR_OF_SPAWN) {
    record.refused(from, 'too_close_to_world_spawn', `${crew.length} launch(es) withheld at ${outFromSpawn}b`);
    trouble(from, 'too_close_to_world_spawn',
      `too close to world spawn (${outFromSpawn}b, need ${PERSON_CLEAR_OF_SPAWN}) — building is blocked there. `
      + `Walk ${PERSON_CLEAR_OF_SPAWN - outFromSpawn} more blocks out. Nobody was sent.`,
      `${from} at (${feet.x},${feet.y},${feet.z}) is ${outFromSpawn}b Chebyshev from world spawn (${spawnAt.x},${spawnAt.z}), `
      + `inside the ${PERSON_CLEAR_OF_SPAWN}b clearance | withheld ${crew.join(', ')}`);
    return null;
  }

  // ── ON THE OVERWORLD SURFACE, NEAR SEA LEVEL ───────────────────────────────
  // This fleet sites bases on the overworld surface against sea-level water (the farm pins to the water
  // plane, the headframe sinks from the surface). No dimension check needed: `asker_unseen` above already
  // turns away the nether and the end (Law 16).
  const reader = makeVoxelReader(bot);
  const ground = siteGeometry.surfaceY(reader, feet.x, feet.z, feet.y);
  if (!ground) {
    record.refused(from, 'ground_unreadable', `${crew.length} launch(es) withheld`);
    trouble(from, 'ground_unreadable',
      `I can't read the ground where you are — move a little and try again. Nobody was sent.`,
      `surfaceY found no ground in the window at (${feet.x},${feet.z}) ref y=${feet.y} | withheld ${crew.join(', ')}`);
    return null;
  }
  if (feet.y < ground.y - HUMAN_SURFACE_SLACK) {
    record.refused(from, 'underground', `${crew.length} launch(es) withheld at y${feet.y}`);
    trouble(from, 'underground',
      `you're underground (${ground.y - feet.y}b below the surface) — come up top. Nobody was sent.`,
      `${from} at y=${feet.y}, surface of that column is y=${ground.y} (${ground.name}) | withheld ${crew.join(', ')}`);
    return null;
  }
  if (feet.y > SEA_LEVEL + HUMAN_MAX_ABOVE_SEA) {
    record.refused(from, 'too_high', `${crew.length} launch(es) withheld at y${feet.y}`);
    trouble(from, 'too_high',
      `you're too high up (y${feet.y}) — a base needs ground near sea level (y${SEA_LEVEL}). Head downhill. Nobody was sent.`,
      `${from} at y=${feet.y}, ceiling is SEA_LEVEL+${HUMAN_MAX_ABOVE_SEA}=${SEA_LEVEL + HUMAN_MAX_ABOVE_SEA} | withheld ${crew.join(', ')}`);
    return null;
  }
  // The biome at the feet, judged against the same set the siter gates on (Law 16).
  const biome = getBiomeName(bot, feet.x, feet.y, feet.z);
  if (!ACCEPTABLE_BIOMES.has(biome)) {
    record.refused(from, 'biome', `${crew.length} launch(es) withheld in ${biome}`);
    trouble(from, 'biome',
      `${String(biome).replace(/_/g, ' ')} won't work — find forest or plains. Nobody was sent.`,
      `${from} stands in '${biome}', not in ACCEPTABLE_BIOMES | withheld ${crew.join(', ')}`);
    return null;
  }

  const room = await siteGeometry.standingSpotNear(reader, feet, { radius: CREW_PLACEMENT_RADIUS });
  // ── THE CREW IS PLACED ON THE CELL MEASURED HERE, NOT ON THE ASKER'S NAME ─────────────────
  // One placement for every crew (Law 16), handed to each body as "x y z". Re-pointed at the alpha anchor
  // below once the base is sited; this is the fallback for a seat whose chunks haven't streamed in.
  if (!room.found) {
    record.refused(from, 'no_standing_room', `${crew.length} launch(es) withheld`);
    trouble(from, 'no_standing_room',
      `there's nowhere beside you for anyone to stand — try again on open ground. Nobody was sent.`,
      `${room.why} | withheld ${crew.join(', ')} before launch`);
    return null;
  }
  return { feet, reader, placeAt: `${room.cell.x} ${room.cell.y} ${room.cell.z}` };
}

// launchCrew — brings the named bodies up one lane at a time and says what actually arrived. `placeAt` is
// the cell every body is put on, "x y z", or '' for a crew that starts where each body stands.
async function launchCrew({ from, species, crew, mine, needed, size, wantsContractors, isOurs, placeAt, reply, trouble, held = false }) {
  // Said while they wait, not after — the two species look identical until a homesteader doesn't answer
  // (Law 25).
  const forWhom = wantsContractors ? 'for you' : 'for the homestead — they won\'t answer you';
  reply(needed === size
    ? `getting ${crew.join(' and ')} ${forWhom}...`
    : `you have ${mine.map(b => b.id).join(' and ')} — getting ${crew.join(' and ')} to finish the crew...`);
  // The owner is stamped at each launch, un-forgeable afterward. The crew list is fixed above, so the
  // lanes below never race the free-bot list.
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
    const r = await startBot(target, species, wantsContractors ? from : '', placeAt, held);
    said.push(firstMeaningfulLine(r.out) || `${target}: the launcher exited ${r.code}`);

    // Polled, not slept-then-checked, so a fast registration is brought over fast.
    const deadline = Date.now() + BODY_ARRIVAL_WAIT_MS;
    let seen = false;
    for (;;) {
      const state2 = await door.query();
      if (!state2.ok) { reach = state2.error; break; }
      reach = null;
      if (state2.bots.some(b => b.id === target && isOurs(b))) { seen = true; break; }
      if (Date.now() >= deadline) break;
      await new Promise(r2 => setTimeout(r2, CREW_ARRIVAL_POLL_MS));
    }
    if (!seen) {
      log(`${target} did not register within ${BODY_ARRIVAL_WAIT_MS}ms for ${from}`);
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
    // The body places itself and confirms it (`body_recovery.arriveAtPlayer`); one place a crew is put
    // where its person is standing (Law 16).
  };
  const lane = async (k) => {
    if (k > 0) await new Promise(r => setTimeout(r, SPAWN_LANE_OFFSET_MS * k));
    while (queue.length) await bringOne(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(SPAWN_LANES, crew.length) }, (_, k) => lane(k)));
  log(`get crew ${crew.join(', ')} for ${from} -> ${said.join(' | ')}`
      + ` | stood: ${standing.join(', ') || 'none'}`);

  // ── WHAT ARRIVED IS ASKED OF THE FLEET, NEVER QUOTED FROM THE LAUNCHER ─────────────────────────
  // A launcher says whether it started a process; the registry says whether a body is standing (Law 26).
  // Registry unreachable is a third answer, not a failure — the desk truthfully doesn't know (Law 25).
  if (reach && standing.length === 0) {
    trouble(from, 'crew_unconfirmed', `I started ${crew.join(' and ')} but can't confirm they arrived.`,
            `door.query failed: ${reach} | launcher said: ${said.join(' | ')}`);
    return;
  }

  if (standing.length >= size) {
    // "Yours" must be true — said to a homesteader's asker it would be the opposite of the fact (Law 25).
    // "Here" is proved, not reported: each body places itself and refuses to work unconfirmed, so working
    // means standing here (Law 27).
    const whose = wantsContractors ? 'yours' : 'the homestead\'s';
    reply(`${standing.join(' and ')} are ${whose}, here, and ${held ? 'waiting for start' : 'working'}.`);
    return;
  }
  // What they have and what to do, no machine detail — that belongs in the log and record, not open chat
  // in front of the server (Law 24).
  record.refused(from, 'crew_short', `${standing.length} of ${size}`);
  const missing = crew.filter(id => !standing.includes(id));
  trouble(from, 'crew_short',
    standing.length
      ? `${standing.join(' and ')} is yours and working. ${missing.join(' and ')} didn't make it — say "${FOREMAN_PREFIX} get" to try for the rest.`
      : `couldn't get your crew up. say "${FOREMAN_PREFIX} get" to try again.`,
    `${standing.length} of ${size} stood; missing ${missing.join(', ')}; launcher said: ${said.join(' | ')}`);
  return;
}

module.exports = { bind, getCrew, existingSite };
