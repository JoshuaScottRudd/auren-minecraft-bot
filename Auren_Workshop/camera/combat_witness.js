// combat_witness — the OTHER thing the camera client can do with its eyes.
//
// The scout joins the server to read the world. Framing is one question asked of it ("where can a lens
// stand"); this is the second ("what actually happened in that fight"). Two questions, one client, two
// independent switches — see camera_configure's `mode` block. Neither is on unless explicitly enabled
// (Law 13) — an always-on recorder would accumulate unbounded log growth across runs nobody asked it
// to capture.
//
// ── WHY THIS EXISTS AT ALL: THE THIRD VOICE HAS NO RECORD ───────────────────────────────────────────
// A fight has three voices and the fleet writes ONE of them down. The bot's narrative and its decisions
// are the same stream — prose and crew_log rows, both on the watcher trace. That is the SUBJECT
// speaking, and every row of it is a CLAIM. The third voice — what the server actually did — is the only
// one that can contradict it, and nothing writes it down outside a lanista arena run.
//
// This file is the second, independent source of truth about a fight, alongside the bot's own claims —
// combat data is rebuilt by combining the two. It is NOT joined to the first here — the
// bot's claims are matched against these observations in the READER (monitoring/combat_witness_lens),
// where the two records sit side by side and a disagreement between them is visible. A witness that
// read the bot's trace live would be a witness that had heard the defendant's story first.
//
// ── IT RECORDS FACTS, NEVER VERDICTS (Law 25, and it is the whole discipline) ────────────────────────
// `fuse = 12`, never "about to detonate". `distance = 3.7`, never "in reach". Mob metadata is carried
// RAW and UNDECODED for exactly the reason combat_recorder gives for the same field: whether 1.21.5's
// registry names the creeper's swell key the way we assume is UNVERIFIED, and a record that decoded it
// on an assumption would bake the assumption into every reading taken with it. The reader decodes,
// against real captured bytes, where the raw sits beside it and the guess can be checked.
//
// ── IT DOES NOT DECIDE WHEN IT RECORDS, AND THAT IS NOT NEGOTIABLE ─────────────────────────────────────
// A subject does not get to decide when it is audited — that defeats the purpose of an independent record.
//
// So the trigger is never the bot's own record and never battle_stations' engage signal. It is
// combat_engagement — the ONE implementation of "is a fight happening, between whom" (Law 16), the same
// detector the arena uses, driven off this observer's own snapshot. Trigger control is evidence control:
// a fight the bot failed to notice is the single most valuable thing this file can capture, and a
// bot-signalled trigger produces exactly zero record of it.
//
// ── THE NOSE AND THE EYES ───────────────────────────────────────────────────────────────────────────
// The client is the EYES: precise, event-level, and blind past its entity-tracking range. RCON is the
// NOSE: world-wide, needs no body, and coarse. They are used strictly where each is the only option —
// the nose fires ONLY at bots the scout currently cannot see, and its whole job is to say "point the
// eyes over there". It is not a detector: its selector cannot name a species (a Minecraft selector takes
// one positive `type=`, and the vanilla entity tags have no "hostile" set), so it excludes the obvious
// non-entities and accepts that a cow trips it. That costs one teleport and ZERO records — the detector
// above is what decides whether anything gets written, and it uses the fleet's own monster table. Every
// nose reading is written down (k:'n') so the reader can see how often it was wrong rather than trust
// this paragraph about it.
//
// ── FORMAT ──────────────────────────────────────────────────────────────────────────────────────────
// ONE file per start command: fleet_logs/combat_witness/combat_witness.jsonl, opened truncating. Same
// lifetime rule the watcher trace already keeps — raw data persists only until the
// next start command — and it is why there is no directory sweep here: the overwrite IS the release, so
// the record can never grow past one run.
//
// jsonl, one object per line, `k` names the kind:
//   k:'h'  HEADER    — what was armed, so the stream is self-describing after this process is gone.
//   k:'s'  SAMPLE    — one observation tick, written ONLY while a pair is inside the aggro band.
//   k:'o'  OBSERVED  — a server-sent instant (swing, hurt, death). Not in any snapshot; only a listener
//                      can catch these, which is why they are their own kind.
//   k:'e'  ENGAGEMENT— the detector's start/end for one (bot, hostile) pair.
//   k:'n'  NOSE      — one RCON wide-area reading for a bot the eyes could not reach.
//   k:'b'  BLIND     — a span the client spent inside its own ray loops. See below.
//   k:'f'  TRAILER   — the true cost of the run, including everything it FAILED to see.
//
// ── WHY 'b' IS A RECORD KIND AND NOT A LOG LINE ─────────────────────────────────────────────────────
// This client's raycasts block its own packet handlers, so a ray loop is a window in which it cannot
// hear. voxel_scan_throttle narrows those windows (camera_scout's header has the mechanism); it does not
// close them. A gap in this stream must therefore be readable as "the camera was thinking here" and never
// as "nothing happened here" — those are the same silence, and reading the second one off the first is a
// measurement the instrument did not take (Law 25). The stamp is what tells them apart, so it belongs in
// the record the reader walks, not in a diagnostic file the reader never opens.

'use strict';

const fs = require('fs');
const path = require('path');

const { createEngagementDetector } = require('../tools/combat_engagement');

const paths = require('../workshop_paths');
const WITNESS_DIR = paths.fleetLogs('combat_witness');
const WITNESS_FILE = path.join(WITNESS_DIR, 'combat_witness.jsonl');

// 100 ms = two Minecraft ticks, and it is HALF the arena recorder's rate on purpose. The arena samples a
// single bot for a bounded leg and can afford 20 Hz; this runs across the whole fleet for as long as the
// camera is up, so the rate must stay bounded against unattended file growth. It only ticks at this rate
// while a pair is actually inside the aggro band — resting, the clock is the detector's own 1 Hz pulse —
// so an idle fleet costs one snapshot a second and writes nothing at all.
const SAMPLE_MS = 100;

// How far around an engaged bot the sample records hostiles. Wider than the aggro band (15-16 b) so the
// approach INTO the band is on the tape — "when did the bot notice, and when should it have" is answered
// from the seconds before the fight, which a radius clamped to the band would have already dropped.
const SAMPLE_RADIUS = 24;

// The nose's reach and rate. 16 b is the widest aggro range the fleet's own table carries (skeletons),
// so a bot with nothing inside 16 b has nothing that could legally have acquired it. 2 s because the nose
// is not measuring anything — it is deciding where to point a camera that takes seconds to settle anyway.
const NOSE_RADIUS = 16;
const NOSE_POLL_MS = 2000;

// A runaway guard, not a quality knob — the same reasoning combat_recorder states for its own cap. At
// 10 Hz a fleet in a long fight writes ~36k sample lines an hour; this is the ceiling past which an
// unattended instrument becomes a disk problem. Hitting it is RECORDED, never silent (Law 25).
const MAX_RECORDS = 120000;

// The selector's exclusions. It cannot name what a monster IS (see the nose note in the header), so it
// names what obviously is not one. Deliberately short: every entry is a thing that can never be a threat
// and is common enough to trip the nose constantly. Passive MOBS are knowingly left in — a cow tripping
// the nose costs a teleport, and lengthening this list into a passive-mob census is how it would rot.
const NOSE_EXCLUDED = [
  'minecraft:player', 'minecraft:item', 'minecraft:experience_orb', 'minecraft:armor_stand',
  'minecraft:arrow', 'minecraft:interaction', 'minecraft:marker', 'minecraft:text_display',
  'minecraft:item_display', 'minecraft:block_display', 'minecraft:painting', 'minecraft:item_frame',
  'minecraft:glow_item_frame',
];

const round3 = p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, z: Math.round(p.z * 1000) / 1000 });
const round3n = n => (n == null ? null : Math.round(n * 1000) / 1000);

// The fleet's own name→group table, reached through the construct's alias space.
//
// GUARDED BOOT, copied from tools/arena_sites and for the reason its header gives: registering the same
// base twice makes module-alias resolve '@utils/x' to '<base>/<base>/…' and the require dies, and by
// convention a caller may already have booted it. Registering a path map is not joining the construct —
// no bus, no watcher, no fragment.
//
// WHY IT IS A LOOKUP AND NOT A LIST IN THIS FILE (Law 16). "What counts as a monster" is the fleet's
// answer, held in one place, and an observer carrying its own copy would report engagements the construct
// was never obliged to notice — the exact defect combat_engagement's own header records having already
// made once with a hardcoded aggro range.
//
// IF IT WILL NOT LOAD, THE WITNESS IS UNAVAILABLE — it does not fall back to a guess. A witness with a
// second opinion about what a monster is produces a record that disagrees with the fleet for reasons
// nobody can see afterwards, which is worse than no record (Law 23).
function loadCombatTactic() {
  // NODE_PATH first, then the aliases: `module-alias` is a third-party package and lives in whichever
  // node_modules this machine has, so on the secondary workstation the require below fails outright
  // without it. Both are one idempotent call, so the guarded `try/catch` that stood here — written when
  // a double registration corrupted the map — has nothing left to guard (Law 13).
  paths.registerAliases();
  return require('@utils/combat_utils').combatTactic;
}

// createWitness({ scout, rcon, botNames, botPosFn, cfg, log })
//
// `rcon` is the RIG's session, borrowed, never opened here — one RCON link per process (Law 16), and its
// lifecycle belongs to whoever opened it (Law 8). Passing null is legal and simply disarms the nose: the
// eyes still work, the record just carries no k:'n' lines and says so in the header.
//
// `botPosFn(name)` is the rig's RCON position poll. The scout's own entityPos is preferred and this is
// the fallback for a bot outside its range — which is precisely the bot the nose exists for, so without
// it a nose hit would have nowhere to point.
//
// Returns { available:false, reason } on any failure. Never throws: the camera must survive a missing
// witness exactly as it survives a missing scout or a missing gimbal.
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
    // Ticks on which the eyes had nothing to report. A run whose scout was down for half its length must
    // not read as a clean run with a quiet fleet (Law 25) — this is the number that says which it was.
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
    // `t0` is the epoch millisecond every row's relative `t` is measured from, and it is what makes this
    // record joinable to the bot's own: absolute = t0 + t here, an ISO stamp per line on the watcher
    // trace, so a claim and an observation land on one clock without this record carrying a wall clock
    // per row. Removing it does not degrade this
    // record; it deletes the entire reason the record exists — the two sources of truth could no longer
    // be rebuilt by combining them.
    t0: state.startedAt,
    bots: botNames, sampleMs, radius,
    nose: rcon ? { radius: noseRadius, pollMs: nosePollMs } : null,
    maxRecords,
  });

  // ── THE INSTANTS ────────────────────────────────────────────────────────────────────────────────────
  // Subscribed unconditionally rather than only while an engagement is open, and that is deliberate: a
  // blow landing on a bot the detector has not opened a pair for is the most interesting line this file
  // can carry — it is the fight nobody saw coming. Gating it on an open engagement would delete exactly
  // that case. It costs nothing when nothing is happening; these are announcements, not a poll.
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
      // Who the server says did it, and with what. `byId`/`byName` are mineflayer's resolution of the
      // causing entity; `sourceTypeId`/`directId` are the raw damage_event fields it drops — the damage
      // TYPE and the projectile that carried it. Raw, unresolved, for camera_scout's stated reason: the
      // damage-type registry is sent per server, so naming it here would be this file's guess.
      byId: rec.byId != null ? rec.byId : undefined,
      byName: rec.byName || undefined,
      srcType: rec.sourceTypeId != null ? rec.sourceTypeId : undefined,
      directId: rec.directId != null ? rec.directId : undefined,
    });
    // A blow is what opens a player-vs-player pair — proximity cannot, because two players standing
    // together pass range and line forever. The detector owns that rule; this only feeds it the blow.
    // BOTH DIRECTIONS, because the detector's pair is keyed (subject player, other entity) and a bot is
    // the subject whether it threw the blow or took it. Feeding only one direction would record a bot
    // attacking a human and miss a human attacking the bot, which is the half that matters more.
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

  // ── THE NOSE ────────────────────────────────────────────────────────────────────────────────────────
  // Fired at ONE bot per call, only when the eyes cannot see it, and never more often than nosePollMs.
  // It is a pure test — `execute if entity` reads the world and changes nothing, which is the only kind
  // of command an observer may send (Law 19: it shares this world, it does not act in it).
  async function sniff(botName) {
    if (!rcon) return;
    const last = state.lastNoseAt.get(botName) || 0;
    if (Date.now() - last < nosePollMs) return;
    state.lastNoseAt.set(botName, Date.now());
    const selector = `@e[distance=..${noseRadius}${NOSE_EXCLUDED.map(t => `,type=!${t}`).join('')}]`;
    let res;
    try { res = await rcon.command(`execute at ${botName} run execute if entity ${selector}`); }
    catch (e) {
      // A dead link is the rig's problem to re-establish; the nose just records that it could not smell.
      write({ k: 'n', t: now(), bot: botName, near: null, error: e.message });
      return;
    }
    // "Test passed, count: N" / "Test failed". The count is read when present and left null when it is
    // not — a shape that changes across versions must degrade to an absent field, never to a zero.
    const passed = /passed/i.test(String(res));
    const m = String(res).match(/count:\s*(\d+)/i);
    state.noseReadings++;
    write({ k: 'n', t: now(), bot: botName, near: passed, count: m ? +m[1] : null, radius: noseRadius });
    if (passed) state.noseHot.set(botName, { at: Date.now(), count: m ? +m[1] : null });
    else state.noseHot.delete(botName);
  }

  // ── THE PULSE ───────────────────────────────────────────────────────────────────────────────────────
  // ONE clock, self-escalating: entities are polled at a low pulse at rest, faster once anything is
  // inside aggro range. Resting it runs at the detector's scan rate and writes nothing; the moment a pair
  // enters the band it drops to sampleMs and the tape starts.
  //
  // A CHAINED setTimeout, not setInterval, because the interval is a value that changes every tick — and
  // because a slow tick must never be able to overlap itself. The nose awaits an RCON round trip (~18 ms
  // on loopback, unbounded if the link is sick), and an interval would stack those calls on top of each
  // other until the link came back.
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
      // Law 23: an unread world is unknown, never empty. The detector is given nothing (it would close
      // every fight), and the gap is counted so the trailer can state how much was never seen.
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

    // ── THE SAMPLE ────────────────────────────────────────────────────────────────────────────────────
    // One line per engaged bot per tick. Written only for bots with something in the band, which is what
    // keeps an idle fleet at zero bytes.
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
        // The bot's own living-entity flags, raw. Bit 0 is 'hand active', which is what a raised shield
        // IS on the server — the construct can only report that it SENT the packet, and this is the only
        // place the fleet can see whether the server agreed (Law 26).
        md: self.metadata,
        mobs: mobs.map(m => ({
          id: m.id, n: m.name,
          p: round3(m.position),
          v: m.velocity ? round3(m.velocity) : null,
          hp: m.health, yaw: m.yaw, ground: m.onGround,
          d: round3n(Math.hypot(m.position.x - self.position.x, m.position.y - self.position.y, m.position.z - self.position.z)),
          // RAW and UNDECODED — the creeper's swell and fuse live somewhere in here, and this file does
          // not claim to know where. See the header: the reader decodes against captured bytes.
          md: m.metadata,
        })),
      });
    }

    // ── WHERE THE EYES SHOULD POINT ───────────────────────────────────────────────────────────────────
    // A recommendation returned to the rig, never a teleport sent from here. The scout has ONE position
    // and therefore one owner, and that owner is the rig (Invariant D). Two writers of one camera's
    // anchor is the same fault as two writers of one state.
    let hottest = null, hottestCount = 0;
    for (const name of engagedBots) {
      const n = candidates.filter(c => c.subject === name).length;
      const pos = scout.entityPos(name) || (botPosFn ? botPosFn(name) : null);
      if (pos && n > hottestCount) { hottest = { bot: name, position: pos, pairs: n, from: 'eyes' }; hottestCount = n; }
    }

    // The nose fires only at bots the eyes could not find in this snapshot — that absence is the entire
    // justification for spending an RCON round trip, and it is why an all-visible fleet costs zero
    // commands. Not awaited: a sick link must slow the nose, never the sampler.
    for (const name of botNames) {
      if (snap.entities.some(e => e.username === name)) { state.noseHot.delete(name); continue; }
      sniff(name).catch(e => { if (log) log('warn', `combat_witness nose (${name}): ${e.message}`); });
    }
    // A nose hit only becomes the anchor when the eyes have nothing — the eyes are the better witness by
    // every measure, and a cow twenty blocks from an idle bot must never pull the camera off a live fight.
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

    // What the rig should anchor the scout over, or null for "no opinion, use your own midpoint".
    anchorTarget: () => (state.hottest ? { ...state.hottest.position, bot: state.hottest.bot, from: state.hottest.from } : null),

    stats: () => ({
      records: state.records, samples: state.samples, observed: state.observed,
      engagements: state.engagements, nose: state.noseReadings, blind: state.blind,
      dropped: state.droppedSnapshots, capped: state.capped,
    }),

    close() {
      if (state.closed) return;
      // Any fight still open is CLOSED HERE and marked truncated. An unterminated start row would make
      // the reader see a fight running past the end of the file (Law 8).
      for (const ev of detector.closeOpen(now())) write({ k: 'e', t: now(), type: 'engagement', ...ev });
      const blind = typeof scout.blindStats === 'function' ? scout.blindStats() : { spans: 0, blockedMs: 0 };
      // The trailer carries what the run FAILED to see, not only what it caught — the drop count and the
      // client's own deaf total. Without them a half-blind run reads as a quiet one (Law 25).
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
