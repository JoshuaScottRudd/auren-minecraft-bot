// combat_witness — the camera client's second capability. The scout joins the server to read the world;
// framing is one question asked of it (where can a lens stand), this is the second (what actually
// happened in a fight). Two independent switches, see camera_configure's `mode` block; neither is on
// unless explicitly enabled (Law 13).
//
// The bot's own narrative and decisions are one stream — prose and crew_log rows on the watcher trace —
// and every row of it is a claim. This file is the second, independent source about the same fight. It
// is not joined to the bot's trace here; the two are matched in the reader
// (monitoring/combat_witness_lens), where a disagreement between them is visible.
//
// Records facts, never verdicts (Law 25): `fuse = 12`, never "about to detonate"; `distance = 3.7`, never
// "in reach". Mob metadata is carried raw and undecoded, the same discipline combat_recorder states for
// the same field, so an unverified guess about the registry never bakes into the reading; the reader
// decodes against captured bytes.
//
// The trigger is combat_engagement, the one implementation of whether a fight is happening and between
// whom (Law 16), the same detector the arena uses, driven off this observer's own snapshot, so a fight
// the bot failed to notice is still captured.
//
// ── THE NOSE AND THE EYES ───────────────────────────────────────────────────────────────────────────
// The client is the eyes: precise, event-level, blind past its entity-tracking range. RCON is the nose:
// world-wide, coarse, fired only at a bot the eyes currently cannot see, to say where to point. Its
// selector cannot name a species, so it excludes known non-entities and accepts that other mobs trip it —
// that costs one teleport and zero records, since the detector above decides what gets written, off the
// fleet's own monster table. Every nose reading is written down (k:'n') so the reader can judge its
// accuracy directly.
//
// ── FORMAT ──────────────────────────────────────────────────────────────────────────────────────────
// One file per start command: fleet_logs/combat_witness/combat_witness.jsonl, opened truncating — the
// overwrite is the release, so the record never grows past one run.
//
// jsonl, one object per line, `k` names the kind:
//   k:'h'  HEADER    — what was armed, so the stream is self-describing after this process is gone.
//   k:'s'  SAMPLE    — one observation tick, written only while a pair is inside the aggro band.
//   k:'o'  OBSERVED  — a server-sent instant (swing, hurt, death), caught only by a listener.
//   k:'e'  ENGAGEMENT— the detector's start/end for one (bot, hostile) pair.
//   k:'n'  NOSE      — one RCON wide-area reading for a bot the eyes could not reach.
//   k:'b'  BLIND     — a span the client spent inside its own ray loops.
//   k:'f'  TRAILER   — the run's totals, including everything it failed to see.
//
// A 'b' span marks a window where this client's own raycasts blocked its packet handlers, so it cannot
// hear. It belongs in this stream, not a diagnostic file the reader never opens, so a gap reads as "the
// camera was busy" and never as "nothing happened" (Law 25).

'use strict';

const fs = require('fs');
const path = require('path');

const { createEngagementDetector } = require('../tools/combat_engagement');

const paths = require('../workshop_paths');
const WITNESS_DIR = paths.fleetLogs('combat_witness');
const WITNESS_FILE = path.join(WITNESS_DIR, 'combat_witness.jsonl');

// 100 ms = two Minecraft ticks, half the arena recorder's rate: this samples continuously across the
// whole fleet while the camera is up, so the rate must stay bounded against file growth. It only runs
// this fast while a pair is inside the aggro band; at rest the clock is the detector's own 1 Hz pulse, so
// an idle fleet writes nothing.
const SAMPLE_MS = 100;

// How far around an engaged bot the sample records hostiles — wider than the aggro band (15-16 b) so the
// approach into the band is on the tape, not only the fight itself.
const SAMPLE_RADIUS = 24;

// The nose's reach and rate. 16 b covers the widest aggro range in the fleet's monster table (skeletons).
// 2 s matches the settle time of the camera it is aiming, not a measurement rate.
const NOSE_RADIUS = 16;
const NOSE_POLL_MS = 2000;

// A runaway guard against unattended disk growth in a long fight, the same cap combat_recorder states for
// itself. Hitting it is recorded, never silent (Law 25).
const MAX_RECORDS = 120000;

// The selector's exclusions — it cannot name what a monster IS, so it names what obviously is not one.
// Kept short and literal; passive mobs are knowingly left in, since a cow tripping the nose only costs a
// teleport.
const NOSE_EXCLUDED = [
  'minecraft:player', 'minecraft:item', 'minecraft:experience_orb', 'minecraft:armor_stand',
  'minecraft:arrow', 'minecraft:interaction', 'minecraft:marker', 'minecraft:text_display',
  'minecraft:item_display', 'minecraft:block_display', 'minecraft:painting', 'minecraft:item_frame',
  'minecraft:glow_item_frame',
];

const round3 = p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, z: Math.round(p.z * 1000) / 1000 });
const round3n = n => (n == null ? null : Math.round(n * 1000) / 1000);

// The fleet's own name→group table, reached through the construct's alias space, so what counts as a
// monster is the fleet's one answer (Law 16) and never a private copy this file could disagree with it
// by. Registering a path map here is not joining the construct — no bus, no watcher, no fragment.
//
// If it will not load, the witness is unavailable — it never falls back to a guess (Law 23).
function loadCombatTactic() {
  // Registers NODE_PATH and the module aliases; both are one idempotent call, safe to repeat.
  paths.registerAliases();
  return require('@utils/combat_utils').combatTactic;
}

// createWitness({ scout, rcon, botNames, botPosFn, cfg, log })
//
// `rcon` is the rig's session, borrowed, never opened here — one RCON link per process (Law 16); its
// lifecycle belongs to whoever opened it (Law 8). Null legally disarms the nose: the eyes still work, and
// the header records that no k:'n' lines will follow.
//
// `botPosFn(name)` is the rig's RCON position poll, the fallback for a bot outside the scout's own
// entityPos range — the bot the nose exists to point at.
//
// Returns { available:false, reason } on any failure; never throws, so the camera survives a missing
// witness exactly as it survives a missing scout or gimbal.
function createWitness({ scout, rcon = null, botNames = [], botPosFn = null, cfg = {}, log = null } = {}) {
  if (!scout || scout.available === false || typeof scout.entitySnapshot !== 'function') {
    return { available: false, reason: 'no scout — the witness has no eyes' };
  }
  let combatTactic;
  try { combatTactic = loadCombatTactic(); }
  catch (e) { return { available: false, reason: `monster table unavailable (${e.message})` }; }

  const sampleMs = cfg.sampleMs || SAMPLE_MS;
  const radius = cfg.radius || SAMPLE_RADIUS;
  const noseRadius = cfg.noseRadius || NOSE_RADIUS;
  const nosePollMs = cfg.nosePollMs || NOSE_POLL_MS;
  const maxRecords = cfg.maxRecords || MAX_RECORDS;

  try { fs.mkdirSync(WITNESS_DIR, { recursive: true }); }
  catch (e) { return { available: false, reason: `cannot create ${WITNESS_DIR} (${e.message})` }; }

  // 'w', not 'a' — the overwrite IS the release. See the FORMAT block.
  let stream;
  try { stream = fs.createWriteStream(WITNESS_FILE, { flags: 'w' }); }
  catch (e) { return { available: false, reason: `cannot open ${WITNESS_FILE} (${e.message})` }; }

  const fleet = new Set(botNames);
  const state = {
    startedAt: Date.now(),
    closed: false,
    timer: null,
    records: 0, samples: 0, observed: 0, engagements: 0, noseReadings: 0, blind: 0,
    // Ticks on which the eyes had nothing to report — the count that shows a scout outage as an outage,
    // not as a quiet fleet (Law 25).
    droppedSnapshots: 0,
    capped: false,
    lastNoseAt: new Map(),      // bot name → when the nose last fired at it
    noseHot: new Map(),         // bot name → { at, count } for the newest hit; the anchor's fallback target
    hottest: null,              // { bot, position } — where the eyes should be pointed right now
  };

  const detector = createEngagementDetector({
    losFn: (from, to, maxDist) => scout.aggroLineOfSight(from, to, maxDist),
    botNames,
    isHostile: name => !!name && combatTactic(name) !== null,
  });

  const now = () => Date.now() - state.startedAt;

  function write(obj) {
    if (state.closed) return;
    if (state.records >= maxRecords) {
      if (!state.capped) {
        state.capped = true;
        state.records++;
        stream.write(JSON.stringify({ k: 'e', t: now(), type: 'witness_capped', maxRecords,
                                      note: 'recording stopped; run is TRUNCATED' }) + '\n');
      }
      return;
    }
    state.records++;
    stream.write(JSON.stringify(obj) + '\n');
  }

  write({
    k: 'h', t: 0, witness: 'combat_witness/1',
    startedAt: new Date(state.startedAt).toISOString(),
    // `t0` is the epoch millisecond every row's relative `t` is measured from, so this record and the
    // watcher trace's ISO-stamped rows share one clock and can be combined into one picture of a fight.
    t0: state.startedAt,
    bots: botNames, sampleMs, radius,
    nose: rcon ? { radius: noseRadius, pollMs: nosePollMs } : null,
    maxRecords,
  });

  // ── THE INSTANTS ──────────────────────────────────────────────────────────────────────────────────
  // Subscribed at all times, so a blow landing on a bot the detector has not yet opened a pair for is
  // still captured — the fight nobody saw coming. Costs nothing at rest; these are announcements, not a
  // poll.
  scout.onObserved((rec) => {
    if (state.closed) return;
    const involvesFleet = fleet.has(rec.username) || fleet.has(rec.byName);
    if (!involvesFleet && !(rec.name && combatTactic(rec.name))) return;   // somebody else's world
    state.observed++;
    write({
      k: 'o', t: now(),
      type: rec.type,
      id: rec.id,
      n: rec.username || rec.name || null,
      bot: fleet.has(rec.username) || null,
      p: rec.position ? round3(rec.position) : null,
      v: rec.velocity ? round3(rec.velocity) : null,
      hp: rec.health,
      // Who the server says did it: `byId`/`byName` are mineflayer's resolved causing entity;
      // `srcType`/`directId` are the raw damage_event fields (damage type and projectile), kept
      // undecoded since the damage-type registry is sent per server (Law 25).
      byId: rec.byId != null ? rec.byId : undefined,
      byName: rec.byName || undefined,
      srcType: rec.sourceTypeId != null ? rec.sourceTypeId : undefined,
      directId: rec.directId != null ? rec.directId : undefined,
    });
    // A blow is what opens a player-vs-player pair; proximity alone cannot, since two players standing
    // together would pass range and line forever. Both directions are fed, keyed to whichever side is the
    // fleet's own bot, so an attack on a bot is captured as surely as an attack by one.
    if (rec.type === 'hurt') {
      const pairs = [];
      if (fleet.has(rec.byName) && rec.id != null) pairs.push([rec.byName, rec.id]);          // bot struck it
      if (fleet.has(rec.username) && rec.byId != null) pairs.push([rec.username, rec.byId]);  // it struck the bot
      for (const [subject, otherId] of pairs) {
        const ev = detector.noteCombatEvent(subject, otherId, now());
        if (ev) { state.engagements++; write({ k: 'e', t: now(), type: 'engagement', ...ev }); }
      }
    }
  });

  // ── THE DEAF WINDOWS ────────────────────────────────────────────────────────────────────────────────
  scout.onBlindSpan((span) => {
    if (state.closed) return;
    state.blind++;
    write({ k: 'b', t: span.startedAt - state.startedAt, what: span.what, ms: span.ms, rays: span.rays });
  });

  // ── THE NOSE ──────────────────────────────────────────────────────────────────────────────────────
  // Fires at one bot per call, only when the eyes cannot see it, at most once per nosePollMs. A pure
  // read — `execute if entity` changes nothing in the world, the only kind of command an observer may
  // send (Law 19).
  async function sniff(botName) {
    if (!rcon) return;
    const last = state.lastNoseAt.get(botName) || 0;
    if (Date.now() - last < nosePollMs) return;
    state.lastNoseAt.set(botName, Date.now());
    const selector = `@e[distance=..${noseRadius}${NOSE_EXCLUDED.map(t => `,type=!${t}`).join('')}]`;
    let res;
    try { res = await rcon.command(`execute at ${botName} run execute if entity ${selector}`); }
    catch (e) {
      // A dead link is the rig's to re-establish; the nose only records that it could not smell.
      write({ k: 'n', t: now(), bot: botName, near: null, error: e.message });
      return;
    }
    // Reply is "Test passed, count: N" or "Test failed"; the count is read when present and left null
    // when absent, so a reply shape that changes across versions degrades to a missing field, never a
    // false zero.
    const passed = /passed/i.test(String(res));
    const m = String(res).match(/count:\s*(\d+)/i);
    state.noseReadings++;
    write({ k: 'n', t: now(), bot: botName, near: passed, count: m ? +m[1] : null, radius: noseRadius });
    if (passed) state.noseHot.set(botName, { at: Date.now(), count: m ? +m[1] : null });
    else state.noseHot.delete(botName);
  }

  // ── THE PULSE ─────────────────────────────────────────────────────────────────────────────────────
  // One self-escalating clock: entities are polled at the detector's scan rate at rest and write nothing;
  // the moment a pair enters the band it drops to sampleMs and the tape starts.
  //
  // A chained setTimeout, not setInterval, since the interval changes every tick and a slow tick must
  // never overlap itself — the nose awaits an RCON round trip that can run long when the link is sick.
  function schedule(ms) {
    if (state.closed) return;
    state.timer = setTimeout(() => { tick().catch(e => {
      if (log) log('warn', `combat_witness tick: ${e.message}`);
      schedule(detector.nextTickMs());
    }); }, ms);
  }

  async function tick() {
    if (state.closed) return;
    const t = now();
    const snap = scout.entitySnapshot();

    if (!snap.known) {
      // An unread world is unknown, never empty (Law 23): the detector gets nothing this tick, and the
      // gap is counted so the trailer can state how much went unseen.
      state.droppedSnapshots++;
      schedule(detector.nextTickMs());
      return;
    }

    for (const ev of detector.update(snap, t)) {
      state.engagements++;
      write({ k: 'e', t, type: 'engagement', ...ev });
    }

    const candidates = detector.candidates();
    const engagedBots = new Set(candidates.filter(c => c.subjectKind === 'bot').map(c => c.subject));

    // ── THE SAMPLE ──────────────────────────────────────────────────────────────────────────────────
    // One line per engaged bot per tick, written only for bots with something in the band — an idle
    // fleet costs zero bytes.
    for (const name of engagedBots) {
      const self = snap.entities.find(e => e.username === name);
      if (!self) continue;
      const mobs = snap.entities.filter(e =>
        e.id !== self.id && e.name && e.username == null && combatTactic(e.name) !== null &&
        Math.hypot(e.position.x - self.position.x, e.position.y - self.position.y, e.position.z - self.position.z) <= radius);
      state.samples++;
      write({
        k: 's', t, bot: name,
        p: round3(self.position),
        v: self.velocity ? round3(self.velocity) : null,
        hp: self.health, yaw: self.yaw, pitch: self.pitch, ground: self.onGround,
        held: self.heldItem,
        // The bot's own living-entity flags, raw. Bit 0 is 'hand active' — the only place the fleet can
        // confirm the server agreed a raised shield landed (Law 26).
        md: self.metadata,
        mobs: mobs.map(m => ({
          id: m.id, n: m.name,
          p: round3(m.position),
          v: m.velocity ? round3(m.velocity) : null,
          hp: m.health, yaw: m.yaw, ground: m.onGround,
          d: round3n(Math.hypot(m.position.x - self.position.x, m.position.y - self.position.y, m.position.z - self.position.z)),
          // Raw and undecoded — the creeper's swell and fuse live somewhere here; the reader decodes
          // against captured bytes.
          md: m.metadata,
        })),
      });
    }

    // ── WHERE THE EYES SHOULD POINT ─────────────────────────────────────────────────────────────────
    // A recommendation returned to the rig, never a teleport sent from here — the scout's position has
    // one owner, and that owner is the rig (Invariant D).
    let hottest = null, hottestCount = 0;
    for (const name of engagedBots) {
      const n = candidates.filter(c => c.subject === name).length;
      const pos = scout.entityPos(name) || (botPosFn ? botPosFn(name) : null);
      if (pos && n > hottestCount) { hottest = { bot: name, position: pos, pairs: n, from: 'eyes' }; hottestCount = n; }
    }

    // The nose fires only at bots the eyes could not find this snapshot, so an all-visible fleet costs
    // zero commands. Not awaited, so a sick link slows only the nose.
    for (const name of botNames) {
      if (snap.entities.some(e => e.username === name)) { state.noseHot.delete(name); continue; }
      sniff(name).catch(e => { if (log) log('warn', `combat_witness nose (${name}): ${e.message}`); });
    }
    // A nose hit becomes the anchor only when the eyes have nothing, so a distant idle mob never pulls
    // the camera off a live fight.
    if (!hottest) {
      for (const [name, hit] of state.noseHot) {
        if (Date.now() - hit.at > nosePollMs * 3) { state.noseHot.delete(name); continue; }
        const pos = botPosFn ? botPosFn(name) : null;
        if (pos) { hottest = { bot: name, position: pos, pairs: 0, from: 'nose' }; break; }
      }
    }
    state.hottest = hottest;

    schedule(engagedBots.size ? sampleMs : detector.nextTickMs());
  }

  schedule(detector.nextTickMs());

  return {
    available: true,
    file: WITNESS_FILE,

    // What the rig should anchor the scout over; null means the witness has no opinion and the rig
    // should use its own midpoint.
    anchorTarget: () => (state.hottest ? { ...state.hottest.position, bot: state.hottest.bot, from: state.hottest.from } : null),

    stats: () => ({
      records: state.records, samples: state.samples, observed: state.observed,
      engagements: state.engagements, nose: state.noseReadings, blind: state.blind,
      dropped: state.droppedSnapshots, capped: state.capped,
    }),

    close() {
      if (state.closed) return;
      // Any fight still open is closed here and marked truncated, so the reader never sees a fight
      // running past the end of the file (Law 8).
      for (const ev of detector.closeOpen(now())) write({ k: 'e', t: now(), type: 'engagement', ...ev });
      const blind = typeof scout.blindStats === 'function' ? scout.blindStats() : { spans: 0, blockedMs: 0 };
      // The trailer states what the run failed to see, not only what it caught, so a half-blind run
      // cannot read as a quiet one (Law 25).
      write({
        k: 'f', t: now(),
        records: state.records, samples: state.samples, observed: state.observed,
        engagements: state.engagements, nose: state.noseReadings,
        dropped: state.droppedSnapshots, capped: state.capped,
        blindSpans: blind.spans, blindMsUpperBound: blind.blockedMs,
      });
      state.closed = true;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      stream.end();
    },
  };
}

module.exports = {
  createWitness,
  WITNESS_DIR, WITNESS_FILE, SAMPLE_MS, SAMPLE_RADIUS, NOSE_RADIUS, NOSE_POLL_MS, MAX_RECORDS,
};
