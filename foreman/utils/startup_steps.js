'use strict';
// foreman/utils/startup_steps.js — THE FOREMAN'S OWN STARTUP AFTER THE WORLD IS UP, AS PROVED STEPS.
//
//   foremanSteps(ctx) → the list foreman_steps.runSteps walks, one act-then-proof at a time
//     ctx: { getBot, BODY, connectBody, door, desk, startSoak, shutdown } — handed in by foreman.js, which owns them
//

const { FOREMAN_NAME, SEA_LEVEL } = require('@thinking/architect_config');
const plan = require('../foreman_plan');
const { log, alarm } = require('./say');
const { getCrew, existingSite } = require('./get_crew');
const adminSteps = require('./admin_steps');
const runWatch = require('./run_watch');
const runAnnouncer = require('./run_announcer');
const { crewSizeFor } = require('../foreman_vocabulary');
const { guardExternal } = require('@utils/external_library_guard');
const { CLOCKS } = require('@utils/server_settings');
const siteGeometry = require('@utils/site_geometry');
const { makeExecutionPacer } = require('@utils/execution_yield');   // Startup shares the runtime's computation budget.
const { spawnProtectionBox } = require('@perception/spawn_protection');
const { getBiomeName } = require('@perception/biome_scanner');
const { ownerKeyFor } = require('@kernel/bot_mandate');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { personSpotTest, landingFloor } = require('@utils/person_spot');
const { loadedAreaSettled } = require('@utils/wheat_plot_scanner');
const { teleportTo } = require('@kernel/body_recovery');
const observer = require('./observer');

// ── THE FOREMAN'S STARTUP, AS PROVED STEPS ────────────────────────────────────
// Each step acts, then proves itself before the next one runs; a step that cannot be proved stops the run
// with its own sentence. After the world (foreman_world.bringUp, its own steps) come the body and the
// crew, each sensed, acted on and proved from the world by foreman_steps.runSteps. Which steps a run has
// is read off foreman_config's sentence:
//   every run            the body joins · the body is a spectator
//   homesteader, builder the world spawn is known · the ground there has arrived · a standing spot is found · the
//                        body stands on it · the ground there has arrived · the base is sited and in memory · the
//                        crew is working
//   landing: 'random'    after the standing spot is found: a random landing that holds the base is found, and
//                        the steps after it prove that landing in place of the usual spot
//   a continued run      the world spawn is known · the base is in memory · the crew is working, each body
//                        where the last run left it
//   then                 the soak is running (its end is the one shutdown road)
// The spot search is the person-spot rule a person is held to (`person_spot`), searched outward from the
// clearance around world spawn — the sweep the workshop's stand-in person makes (proxy_human --stand=biome).
const BODY_JOIN_LIMIT_MS = 120000;
const SPAWN_LATCH_WAIT_MS = 30000;
// HOW LONG THE CREW IS HELD FOR THE OBSERVER'S CAMERA to reach the world — a cold Minecraft client's JVM
// start, asset load, resource pack and login. A CEILING and never a requirement: the step's `onTimeout`
// proves anyway and says the camera was not there.
const OBSERVER_WAIT_MS = 120000;
// A held crew's release: each body is given ceiling HELD_RELEASE_CEILING_MS to make its first move before the
// next is started, and the whole crew HELD_GO_WAIT_MS after the last release to show it moved.
const HELD_RELEASE_CEILING_MS = 45000;
const HELD_RELEASE_GAP_MS = 3000;          // the least time between two releases, however fast the first moved
const HELD_GO_WAIT_MS = 120000;
const CREW_RAISE_TRIES = 3;
const CREW_RAISE_RETRY_MS = 15000;
const GROUND_ARRIVED_SHARE = 0.95;   // a view disc this full is ground enough to survey; the edge of a map never fills

// WAITS AS LONG AS THE GROUND IS STILL ARRIVING. A slow machine generating a fresh world streams the disc
// slowly, so each window is compared with the last: the step fails only on a window that brought NO new
// chunks (the ground has stopped arriving), and otherwise keeps going up to GROUND_WINDOWS windows.
const GROUND_WINDOWS = 8;
function groundStep(name, getBot) {
  const got = {};
  return {
    name,
    tries: GROUND_WINDOWS,
    act: async () => {
      const before = got.s ? got.s.missing : Infinity;
      got.s = await loadedAreaSettled(getBot());
      if (got.s.missing > 0 && got.s.missing >= before) {
        return { give: `no new chunks arrived in the last ${got.s.secs}s window — ${got.s.missing} of ${got.s.disc} still missing` };
      }
      return null;
    },
    proof: async () => {
      const s = got.s;
      const share = (s.disc - s.missing) / s.disc;
      return share >= GROUND_ARRIVED_SHARE
        ? { ok: true, why: `${s.disc - s.missing} of ${s.disc} chunks after ${s.secs}s` }
        : { ok: false, why: `${s.missing} of ${s.disc} chunks still missing after ${s.secs}s` };
    },
  };
}

// ── A RANDOM LANDING (foreman_config `landing: 'random'`) ─────────────────────────────────────────────
// A loaded area is the square one body has loaded round itself, two view-distances wide (the section
// outward_sections walks). The landing is rolled between LANDING_MIN_AREAS and LANDING_MAX_AREAS of them
// from the usual spot, so the new base shares no ground with the usual one. LANDING_ROLLS bounds the
// re-rolls (Law 27: the bound on repeated attempts); LANDING_SPOT_REACH is how far from the rolled point a
// standing spot is looked for, half a view radius, so a roll onto open sea is refused in one short sweep.
const LANDING_MIN_AREAS = 2;
const LANDING_MAX_AREAS = 4;
const LANDING_ROLLS = 8;
const CHUNK = 16;

// groundArrived(bot) → { ok, why } — the ground step's rule, run to its end inside one act: windows are
// taken while each brings new chunks, and the share that arrived is judged.
async function groundArrived(bot) {
  let s = null;
  for (let w = 0, before = Infinity; w < GROUND_WINDOWS; w++) {
    s = await loadedAreaSettled(bot);
    if (s.missing === 0 || s.missing >= before) break;
    before = s.missing;
  }
  const share = (s.disc - s.missing) / s.disc;
  return share >= GROUND_ARRIVED_SHARE ? { ok: true, why: `${s.disc - s.missing} of ${s.disc} chunks` }
    : { ok: false, why: `the ground stopped arriving with ${s.missing} of ${s.disc} chunks missing` };
}

function foremanSteps({ getBot, BODY, connectBody, door, desk, startSoak, shutdown }) {
  const species = plan.CONFIG.crew;
  // Only a crew the foreman raises itself has an owner key here (ownerless: homesteader, builder). A contractor
  // crew belongs to whoever asks in chat; asking for its key with no person is a coding violation.
  const ownerKey = plan.raisesOwnCrew() ? ownerKeyFor(species, '') : null;
  const at = {};
  const self = () => plan.raisesOwnCrew();
  // The steps that put the foreman's body on new ground and survey a base from it. A continued run has its
  // base in memory and its crew standing where the last run ended, so it searches for nothing and moves nobody.
  const onNewGround = () => self() && !plan.continues();
  const randomLanding = () => onNewGround() && plan.landsAtRandom();
  const rolls = [];   // every landing rolled this run: { n, x, z, out, refused } — the last one is the landing kept
  let lastTrouble = null;
  const asItself = {
    reply: (t) => log(`(to itself) ${t}`),
    correct: (c) => { lastTrouble = c.code; log(`correction[${c.code}]: ${c.because}`); },
    trouble: (who, code, forThePerson, forTheLog) => { lastTrouble = code; log(`trouble[${code}]: ${forTheLog}`); },
  };
  const crewStanding = async () => {
    const state = await door.query();
    return state.ok ? state.bots.filter(b => !b.owner) : [];
  };
  return [
    {
      name: 'the body is in the world',
      holds: async () => BODY.present,
      act: async () => { connectBody(); return null; },
      within: BODY_JOIN_LIMIT_MS,
      every: 1000,
      proof: async () => (BODY.present ? { ok: true, why: `at ${getBot().entity.position.floored()}` }
        : { ok: false, why: `${FOREMAN_NAME} did not join within ${BODY_JOIN_LIMIT_MS / 1000}s${BODY.lastKick ? ` (kicked: ${BODY.lastKick})` : ''}` }),
    },
    {
      name: 'the body is a spectator',
      tries: 2,
      retryAfter: 2000,
      act: async () => {
        await guardExternal('foreman', 'set the body to spectator', () => require('@utils/rcon_link').once([`gamemode spectator ${FOREMAN_NAME}`]));
        return null;
      },
      proof: async () => {
        const r = await guardExternal('foreman', 'read the body\'s game mode', () =>
          require('@utils/rcon_link').once([`data get entity ${FOREMAN_NAME} playerGameType`]));
        const said = r.ok ? r.value[0].body : r.reason;
        return r.ok && /\b3\b/.test(said) ? { ok: true } : { ok: false, why: `the server says "${said}"` };
      },
    },
    adminSteps.clockStep(plan.CONFIG.clock),
    // `camerasStep` carries its own `when` (`record !== 'off'`). Test-awareness is folded into the
    // `record` value passed in here, so one condition governs whether cameras raise (Law 16). The count
    // is `cameras` on the config page: 'crew' means one window per body, a number means that many seats.
    // A seat-only test has the window a person flies and no bot window, whatever the page counts.
    adminSteps.camerasStep({
      record: plan.record(),
      count: plan.seatOnly() ? 0
        : plan.CONFIG.cameras === 'crew' ? crewSizeFor(species)
          : plan.CONFIG.cameras === 'none' ? 0
            : plan.CONFIG.cameras,
      // A run that names its bot seats has stated the whole answer, so a later body is not given one.
      fill: !plan.seatOnly() && plan.CONFIG.cameras === 'crew',
      // cameras 'none' is a run a person watches: the one window is the seat they fly.
      eye: plan.seatOnly() || plan.CONFIG.cameras === 'none',
      // The person flying a seat this run raised is placed at the build like a named observer.
      onSeats: (seats) => observer.seatsRaised(seats),
    }),
    {
      name: 'the world spawn is known',
      // Runs every time, not only for a self-raised crew: the spawn is published on the door (`run.spawn`)
      // for a world-judging bench (world_forge) to read.
      within: SPAWN_LATCH_WAIT_MS,
      every: 500,
      proof: async () => {
        at.box = spawnProtectionBox(getBot());
        if (at.box && getBot().spawnPoint) plan.note({ spawn: { x: getBot().spawnPoint.x, y: getBot().spawnPoint.y, z: getBot().spawnPoint.z } });
        return at.box ? { ok: true, why: `centre (${at.box.centerX},${at.box.centerZ})` }
          : { ok: false, why: 'no spawn position arrived, so there is no measuring a spot clear of it' };
      },
    },
    Object.assign(groundStep('the ground around world spawn has arrived', getBot), { when: onNewGround }),
    {
      name: 'a standing spot clear of world spawn is found',
      when: onNewGround,
      act: async () => {
        const reader = makeVoxelReader(getBot());
        const isSpot = personSpotTest(reader, (x, y, z) => getBiomeName(getBot(), x, y, z), Math.floor(getBot().entity.position.y));
        at.from = landingFloor(at.box.radius);
        const sweep = await siteGeometry.ringScan(reader, { origin: { x: at.box.centerX, z: at.box.centerZ }, step: 1, minRadius: at.from, pace: makeExecutionPacer() }, isSpot);
        if (!sweep.found) {
          return { give: `no spot ${at.from}+ blocks from world spawn in an acceptable biome with a clear 3x3 — `
            + `${siteGeometry.formatRejections(sweep.rejections)} across ${sweep.checked} cell(s).` };
        }
        at.cell = { x: sweep.best.x, y: sweep.best.result.spawnY, z: sweep.best.z };
        at.biome = sweep.best.result.biome;
        return null;
      },
      proof: async () => ({ ok: true, why: `(${at.cell.x},${at.cell.y},${at.cell.z}), ${at.biome}, ${at.from}+ blocks out` }),
    },
    {
      // ── THE LANDING IS ROLLED, AND A ROLL THE GROUND REFUSES IS ROLLED AGAIN ────────────────────────
      // One try is one landing taken to its end: a point is rolled from the usual spot, the body goes to
      // it, the ground arrives, a person-spot is found by the rule the usual spot is held to, the body
      // stands on it, and the base is sited there through the same `getCrew` the siting step below asks.
      // A landing is kept when the fleet's memory holds the base; each refusal is said with its own cause
      // and the next try rolls a new point. The steps after this one then prove the landing it kept.
      name: 'a random landing that holds the base is found',
      when: randomLanding,
      tries: LANDING_ROLLS,
      act: async () => {
        const bot = getBot();
        const area = 2 * bot.game.serverViewDistance * CHUNK;
        const usual = at.usual || (at.usual = at.cell);
        const near = LANDING_MIN_AREAS * area;
        const out = near + Math.random() * (LANDING_MAX_AREAS - LANDING_MIN_AREAS) * area;
        const bearing = Math.random() * 2 * Math.PI;
        const point = { x: Math.round(usual.x + out * Math.sin(bearing)), y: SEA_LEVEL, z: Math.round(usual.z - out * Math.cos(bearing)) };
        const roll = { n: rolls.length + 1, x: point.x, z: point.z, out: Math.round(out), refused: null };
        rolls.push(roll);
        plan.note({ landing: { usual, rolls } });
        log(`    landing ${roll.n} of ${LANDING_ROLLS}: rolled (${point.x},${point.z}), ${roll.out} blocks from the usual spot (${usual.x},${usual.z})`);

        const sent = await teleportTo(bot, point, { name: FOREMAN_NAME });
        if (!sent.moved) { roll.refused = `the body did not get there (${sent.error})`; return null; }
        const ground = await groundArrived(bot);
        if (!ground.ok) { roll.refused = ground.why; return null; }

        const reader = makeVoxelReader(bot);
        const isSpot = personSpotTest(reader, (x, y, z) => getBiomeName(bot, x, y, z), SEA_LEVEL);
        const sweep = await siteGeometry.ringScan(reader, {
          origin: point, step: 1, maxRadius: (bot.game.serverViewDistance * CHUNK) / 2, pace: makeExecutionPacer(),
          accept: (m) => Math.hypot(m.x - usual.x, m.z - usual.z) >= near,
        }, isSpot);
        if (!sweep.found) {
          roll.refused = `no standing spot there — ${siteGeometry.formatRejections(sweep.rejections)} across ${sweep.checked} cell(s)`;
          return null;
        }
        const cell = { x: sweep.best.x, y: sweep.best.result.spawnY, z: sweep.best.z };
        const stood = await teleportTo(bot, cell, { name: FOREMAN_NAME });
        if (!stood.moved) { roll.refused = `the body did not reach the spot (${cell.x},${cell.y},${cell.z}) (${stood.error})`; return null; }
        const settled = await groundArrived(bot);
        if (!settled.ok) { roll.refused = settled.why; return null; }

        lastTrouble = null;
        await getCrew(FOREMAN_NAME, species, { ...asItself, at: cell, build: plan.build(), siteOnly: true });
        if (lastTrouble) { roll.refused = `the base could not be sited from (${cell.x},${cell.y},${cell.z}) (${lastTrouble}) — the lines above say why`; return null; }
        at.cell = cell;
        at.biome = sweep.best.result.biome;
        return null;
      },
      proof: async () => {
        const roll = rolls[rolls.length - 1];
        if (roll.refused) {
          return { ok: false, why: rolls.length < LANDING_ROLLS ? `landing ${roll.n} refused: ${roll.refused}`
            : `all ${LANDING_ROLLS} landings were refused — ${rolls.map(r => `(${r.x},${r.z}) ${r.refused}`).join(' · ')}` };
        }
        const state = await door.query();
        const held = state.ok ? existingSite(state.buildings, ownerKey) : null;
        if (!held) { roll.refused = state.ok ? 'the siting said nothing was wrong and the fleet\'s memory holds no base' : `the fleet did not answer: ${state.error}`; return { ok: false, why: `landing ${roll.n} refused: ${roll.refused}` }; }
        return { ok: true, why: `(${at.cell.x},${at.cell.y},${at.cell.z}), ${at.biome}, ${Math.round(Math.hypot(at.cell.x - at.usual.x, at.cell.z - at.usual.z))} blocks from the usual spot `
          + `(${at.usual.x},${at.usual.z}), on roll ${roll.n} of ${LANDING_ROLLS}` };
      },
    },
    {
      name: 'the body stands on it',
      when: onNewGround,
      tries: 2,
      retryAfter: 2000,
      act: async () => { await teleportTo(getBot(), at.cell, { name: FOREMAN_NAME }); return null; },
      within: 5000,
      every: 500,
      proof: async () => {
        const p = getBot().entity.position;
        const d = Math.hypot(p.x - (at.cell.x + 0.5), p.y - at.cell.y, p.z - (at.cell.z + 0.5));
        return d <= 2 ? { ok: true, why: `${d.toFixed(1)} blocks off` } : { ok: false, why: `the body reads ${p.floored()}, ${d.toFixed(0)} blocks away` };
      },
    },
    Object.assign(groundStep('the ground there has arrived', getBot), { when: onNewGround }),
    {
      name: 'the base is sited and in memory',
      when: self,
      tries: CREW_RAISE_TRIES,
      retryAfter: CREW_RAISE_RETRY_MS,
      act: async () => {
        lastTrouble = null;
        await getCrew(FOREMAN_NAME, species, { ...asItself, at: at.cell, build: plan.build(), siteOnly: true, resume: plan.continues() });
        // Only ground that had not finished arriving is worth asking about again; every other refusal would say
        // the same thing on the next try.
        if (lastTrouble && lastTrouble !== 'world_streaming') return { give: `the ${species} base could not be sited (${lastTrouble}) — the lines above say why.` };
        return null;
      },
      proof: async () => {
        const state = await door.query();
        const held = state.ok ? existingSite(state.buildings, ownerKey) : null;
        return held ? { ok: true, why: held.site.map(r => r.roomKey).join(', ') }
          : { ok: false, why: state.ok ? `no base under '${ownerKey}' in the fleet's memory (${lastTrouble || 'no refusal given'})` : `the fleet did not answer: ${state.error}` };
      },
    },
    // ── ONE CHECK AT THE TOP, NOT TWENTY AT THE BOTTOM ────────────────────────
    // Every structure this crew must raise is proved sited, and a builder's plan is proved valid, in this
    // one place before any body spawns — the last moment a refusal is still free, sitting between the
    // siting step above and the crew-raising step below. The step before this one proves a base exists;
    // this one proves it is the WHOLE base: `existingSite` returns whatever rows happen to carry a
    // `transpose_origin`, so a crew whose second structure never got sited would otherwise pass that proof
    // and fail later, one executor at a time. `STRUCTURE_PRIORITY` is the list of what this species must
    // raise, so it is the list this step holds the siting to.
    {
      name: 'every structure this crew builds is sited, and its plan is proved',
      when: self,
      proof: async () => {
        // ── A STRUCTURE IS CHECKED THROUGH THE ROOM KEYS THAT REALIZE IT ───────────────
        // STRUCTURE_PRIORITY holds STRUCTURE names; the site holds ROOM KEYS. For every structure but one the
        // two coincide; the farm is the exception: `wheat_farm` is ONE structure realized by sixteen
        // `wheat_tine_row#N` instances and is itself never a room key. `roomKeysForStructure` is the one
        // place that mapping is stated. Read as a SET: this step asks "is every structure this crew raises
        // actually sited", a property of the list's MEMBERS and not of its order (the order is a rank,
        // owned by job_ranking).
        const { STRUCTURE_PRIORITY, roomKeysForStructure } = require('@thinking/architect_config');
        const wanted = STRUCTURE_PRIORITY[species] || [];
        const state = await door.query();
        if (!state.ok) return { ok: false, why: `the fleet did not answer: ${state.error}` };
        const sited = new Set((existingSite(state.buildings, ownerKey)?.site || []).map(r => r.roomKey));
        // A PARTLY-SITED STRUCTURE IS NOT SITED. The report names how much of a structure is missing, not
        // only its name, so a shortfall reads apart from a field that was never scanned without opening
        // the memory (Law 13: state the cause, not the category).
        const shortfalls = wanted
          .map((s) => {
            const keys = roomKeysForStructure(s);
            const absent = keys.filter((k) => !sited.has(k));
            return { structure: s, keys, absent };
          })
          .filter((row) => row.absent.length);
        if (shortfalls.length) {
          const named = shortfalls.map((row) => (row.keys.length === 1
            ? `"${row.structure}" is not sited`
            : `"${row.structure}" is short ${row.absent.length} of its ${row.keys.length} instances (${row.absent.slice(0, 6).join(', ')}${row.absent.length > 6 ? ', …' : ''})`));
          return { ok: false, why: `${named.join('; ')}. `
            + `This crew raises [${wanted.join(', ')}] and the fleet's memory holds [${[...sited].join(', ') || 'none'}]. `
            + `The foreman sites every one of them BEFORE a body is spawned — no body sets its own, and no body `
            + `should discover this twenty times over.` };
        }
        // A BUILDER'S PLAN IS A FILE, AND A FILE IS PROVED ONCE. `load` walks every stateful voxel through
        // facing_aim and checks schema, dimensions, ground floor, anchors and columns, refusing a block
        // family the fleet has never measured before any body exists to repeat that refusal.
        // `plan.build()`, not a fresh `require('foreman_config')`: the foreman already reads its own
        // sentence through foreman_plan, and the crew-raising step below hands that same value to getCrew.
        // One route to the build's name (Law 16).
        if (species === 'builder') {
          const buildName = plan.build();
          const p = require('@kernel/downloaded_plan_registry').load(buildName);
          return { ok: true, why: `${wanted.join(', ')} sited; "${buildName}" proved — `
            + `${p.dimensions.w}×${p.dimensions.l}, ${p.columns.length} columns, ${p.anchors.length} cubes` };
        }
        return { ok: true, why: `${wanted.join(', ')} sited` };
      },
    },
    {
      // ── THE CAMERA GOES TO THE ALPHA ANCHOR BEFORE THE CREW SPAWNS ────────────
      // The seat is read from the fleet's memory, not a local variable: `existingSite(...).seat` is the
      // same read the siting step above proves with, resolving to the ALPHA structure's transpose_origin
      // (its own helper prefers the alpha row). One answer to "where is the base" (Law 16) — the same one
      // `desk.alphaSpot()` gives `foreman teleport` and gives the crew's placement cell, so the human, the
      // bodies and this camera all arrive at one place.
      //
      // Holds the crew back while the camera's client reaches the world; bounded, and never fails the run
      // — a run nobody is watching is still a run (observer.js: absent is not a failure, ever).
      //
      // Off unless there is somebody to place, so a downloaded bot never waits for a camera that does not
      // exist: `when` reads `foreman_config.observer`, '' by default, and after it a seat the cameras step
      // raised for a person to fly.
      name: 'the camera is at the build',
      when: () => self() && observer.names().length > 0,
      act: async () => {
        const state = await door.query();
        const held = state.ok ? existingSite(state.buildings, ownerKey) : null;
        if (held && held.seat) observer.remember(held.seat);
        return null;
      },
      within: OBSERVER_WAIT_MS,
      every: 3000,
      proof: async () => {
        const r = await observer.atSite();
        if (r.ok) return { ok: true, why: r.why };
        return { ok: false, why: `${observer.names().join(', ')} not all placed yet — ${r.why}` };
      },
      // A ceiling, not a requirement: `onTimeout` makes this step unfailable, taking this verdict instead
      // of the last refusal, so a camera that never logs in costs only the wait, and the crew goes up.
      onTimeout: () => ({ ok: true, why: `${observer.names().join(', ')} did not all arrive within ${OBSERVER_WAIT_MS / 1000}s — raising the crew anyway; joining later still puts it on the build.` }),
    },
    {
      name: 'the crew is working',
      when: self,
      act: async () => {
        lastTrouble = null;
        await getCrew(FOREMAN_NAME, species, { ...asItself, at: at.cell, build: plan.build(), resume: plan.continues(), held: plan.heldForGo() });
        return null;
      },
      within: 10000,
      every: 2000,
      proof: async () => {
        const crew = await crewStanding();
        const size = crewSizeFor(species);
        return crew.length >= size ? { ok: true, why: crew.map(b => b.id).join(', ') }
          : { ok: false, why: `${crew.length} of ${size} bots standing${lastTrouble ? ` (${lastTrouble})` : ''} — the lines above say why` };
      },
    },
    {
      // ── A HELD CREW IS RELEASED ONCE EVERY BODY STANDS ─────────────────────
      // The whole crew is raised and placed before any of it works, so the cameras are set up while bodies
      // arrive. The step before proved every body standing; here the clock goes back to the run's start
      // (the hold spent some of the morning) and the bodies are released one at a time, each after the
      // one before it has made its first move — the operator's staggered start, given by the foreman.
      // Proved from each body's own first route search, so the soak counts from the go.
      name: 'the crew has its go',
      when: () => self() && plan.heldForGo(),
      act: async () => {
        const want = CLOCKS[plan.CONFIG.clock];
        if (want && !plan.continues()) await guardExternal('foreman', 'set the clock for the go', () => require('@utils/rcon_link').once([`time set ${want.time}`]));
        for (const b of await crewStanding()) {
          desk.startBody(b.id);
          const t0 = Date.now();
          for (;;) {
            const now = await crewStanding();
            if (now.some(x => x.id === b.id && x.first_move_at) || Date.now() - t0 >= HELD_RELEASE_CEILING_MS) break;
            await new Promise(r => setTimeout(r, 500));
          }
          const spent = Date.now() - t0;
          if (spent < HELD_RELEASE_GAP_MS) await new Promise(r => setTimeout(r, HELD_RELEASE_GAP_MS - spent));
          log(`  released ${b.id} — moving after ${(spent / 1000).toFixed(1)}s`);
        }
        return null;
      },
      within: HELD_GO_WAIT_MS,
      every: 3000,
      proof: async () => {
        const crew = await crewStanding();
        const going = crew.filter(b => b.first_move_at);
        return crew.length && going.length === crew.length ? { ok: true, why: `${going.length} bots started, one at a time` }
          : { ok: false, why: `${going.length} of ${crew.length} bots started` };
      },
    },
    {
      name: 'the soak is running',
      act: async () => {
        startSoak();
        runAnnouncer.start({
          fleetState: () => desk.fleetState(),
          say: (text) => require('../foreman_channel').active().announce(getBot(), text),
        });
        runWatch.start({
          fleetState: () => desk.fleetState(), wake: plan.CONFIG.wake, watch: plan.CONFIG.watch,
          onWake: (why) => { alarm(['THE WATCH WOKE — THE RUN IS ENDING', why]); shutdown(`the watch woke: ${why}`, 2); },
          build: plan.endsWhenBuilt() ? plan.build() : null,
          onBuilt: (who) => { runAnnouncer.now(); shutdown(`${plan.build()} stands as its plan asks (read by ${who})`, 0); },
        });
        return null;
      },
      proof: async () => ({ ok: true, why: `${plan.CONFIG.soak > 0 ? `${plan.CONFIG.soak} min` : 'until stopped (soak 0)'}`
        + `${plan.CONFIG.watch ? `, watched for ${plan.CONFIG.wake.join(', ')}` : ', not watched'}` }),
    },
  ];
}

module.exports = { foremanSteps };
