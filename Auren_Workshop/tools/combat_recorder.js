// combat_recorder — the locomotion course's instrument. Maximal per-tick telemetry, written by an
// OUTSIDE OBSERVER, into a stream the watcher never sees.
//
// ── ITS ONE CALLER ──────────────────────────────────────────────────────────────────────────────────
// `tools/locomotion_course` samples a MOVEMENT leg at 20 Hz here and reduces its own output (`reduceLeg`),
// so the record and the reader are paired in one file with exactly one caller. Read "combat" below as
// "any sub-second question" — a sample rate the trace cannot carry.
//
// ── WHY IT IS NOT THE WATCHER, AND NOT trace_monitor ────────────────────────────────────────────────
//   1. VOLUME. Combat correctness needs ~20 samples a second; Law 5's three persisted levels cannot carry
//      that without burying every trace line. This is an INSTRUMENT READING with its own reducer and
//      lifetime, never a fourth log level.
//   2. OWNERSHIP. The construct records nothing new (Law 26). Every number is read off the shared world
//      by the scout, an observer with no vote in any SPA loop (Law 19).
//   3. LIFETIME. Held until the next start command, like the watcher trace — Law 8 by overwrite, not
//      delete. The raw stays held past the first summary, so a later question about the same fight reads
//      the same capture.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────────────
// Decides nothing, flags nothing, asserts nothing. Every field is a value the server sent; the derived
// numbers (distance, hp delta, closing speed) are arithmetic over two observed positions. A model of
// Minecraft's rules lives in the caller's reducer, read against the raw beside it.
//
// ── FORMAT ──────────────────────────────────────────────────────────────────────────────────────────
// `fleet_logs/arena/<runId>.jsonl`, one JSON object per line. Three record kinds, by `k`:
//   k:'s'  SAMPLE   — one observation tick, high volume, the maximal data.
//   k:'o'  OBSERVED — a server-sent packet the sampler cannot see (a swing, a hit, a death).
//   k:'e'  EVENT    — an authored mark from the caller (leg start, dispatch, arrival), low volume, the
//                   spine the reducer walks along.
// jsonl, not one JSON document: a crash mid-fight still leaves every completed line readable, and the
// reducer streams instead of loading a whole run into memory.

'use strict';

const fs = require('fs');
const path = require('path');
// The fleet's own name→group table, not a copy (Law 16). Required lazily, inside createRecorder: a
// caller may import this module for ARENA_LOG_DIR alone without the NODE_PATH bootstrap, which a
// top-level @-alias require here would break.
let _combatTactic = null;
const combatTactic = name => (_combatTactic || (_combatTactic = require('@utils/combat_utils').combatTactic))(name);

// The observer's engagement detector, the ONE implementation of whether a fight is happening and between
// whom (Law 16). Kept in its own file: the standing fleet observer runs it on its own escalating pulse
// with no recorder attached.
const { createEngagementDetector } = require('./combat_engagement');

const ARENA_LOG_DIR = require('../workshop_paths').fleetLogs('arena');

// 50 ms = one Minecraft tick — the bench's headline questions are sub-second, and a coarser sampler
// cannot answer them. The one place the sample rate is set.
const SAMPLE_MS = 50;

// A hard ceiling on one run's samples — a runaway guard, not a quality knob (Law 25: hitting it is
// reported, never silent).
const MAX_SAMPLES = 200000;

// The projectiles worth recording, named explicitly: mineflayer types each as a bare object, so the type
// field alone cannot tell an arrow from a boat.
const PROJECTILE_NAMES = new Set(['arrow', 'spectral_arrow', 'trident']);

function ensureDir() {
  if (!fs.existsSync(ARENA_LOG_DIR)) fs.mkdirSync(ARENA_LOG_DIR, { recursive: true });
}

// ── THE OVERWRITE ───────────────────────────────────────────────────────────────────────────────────
// The held raw of the PREVIOUS start command, released here and only here, not left as a caller
// obligation: an overwrite someone has to remember is one that eventually does not happen. First
// createRecorder of the process clears; later ones in the same process append to the same generation,
// since the unit is the START COMMAND, not the arena.
//
// Fires on the first RECORDER, not process start, so a run that dies before any data exists leaves the
// previous capture intact.
//
// summaries/ is untouched — the reduced artifact outlives every raw generation.
let _clearedThisProcess = false;

function clearHeldRuns() {
  ensureDir();
  let files = 0, bytes = 0;
  for (const name of fs.readdirSync(ARENA_LOG_DIR)) {
    if (!name.endsWith('.jsonl')) continue;
    const p = path.join(ARENA_LOG_DIR, name);
    // Law 25: a failed release is reported, never counted as one. A locked file left behind is a
    // second generation in the directory, and the reader must be able to see that happened.
    try { bytes += fs.statSync(p).size; fs.unlinkSync(p); files++; }
    catch (e) { console.error(`combat_recorder: could not release held run ${name} — ${e.message}`); }
  }
  return { files, bytes };
}

// runId: sortable, filename-safe, and carrying the terrain class so a directory listing reads as an
// experiment log.
function makeRunId(label) {
  const t = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${t}__${String(label || 'run').replace(/[^a-z0-9_-]/gi, '-')}`;
}

// createRecorder({ scout, runId, botName, label, sampleMs })
//
// The recorder owns its file handle and its timer, and `close()` releases both. It is the caller's
// obligation to call it (Law 8) — the director does so in a finally.
function createRecorder({ scout, runId, botName, label, sampleMs = SAMPLE_MS, radius = 48 }) {
  ensureDir();
  if (!_clearedThisProcess) {
    _clearedThisProcess = true;
    const released = clearHeldRuns();
    if (released.files) {
      console.log(`combat_recorder: released ${released.files} held run(s), ` +
                  `${(released.bytes / 1e6).toFixed(1)} MB — overwritten by this start command.`);
    }
  }
  const id = runId || makeRunId(label);
  const file = path.join(ARENA_LOG_DIR, `${id}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a' });

  const state = {
    id, file, botName,
    startedAt: Date.now(),
    samples: 0, events: 0, dropped: 0, observed: 0,
    timer: null, closed: false,
    lastBot: null,                // previous sample's bot record — the source of every delta below
    lastMobs: new Map(),
    lastArrows: new Map(),
    capped: false,
    // Driven off THIS recorder's 20 Hz tick, not its own escalating pulse: the samples are already being
    // taken, so the proximity pass is free and the events land on the finest clock available. Its own
    // confirmMs throttle keeps the ray at 2 Hz per pair regardless of how often it is asked.
    engagement: createEngagementDetector({
      losFn: (from, to, maxDist) => scout.aggroLineOfSight(from, to, maxDist),
      // One name today because the arena runs one bot. The standing fleet observer passes the whole
      // roster, and the detector is already pair-keyed for it.
      botNames: [botName],
      isHostile: name => !!name && combatTactic(name) !== null,
    }),
  };

  function write(obj) {
    if (state.closed) return;
    stream.write(JSON.stringify(obj) + '\n');
  }

  // t: milliseconds since the run started, not wall clock. Every question this instrument answers is
  // about an INTERVAL, and a relative clock makes those readable without subtracting ISO strings, while
  // `startedAt` in the header keeps the absolute time recoverable.
  const now = () => Date.now() - state.startedAt;

  // The header is the first line of every run: what was authored, so the raw stream is self-describing
  // after the director that wrote it is gone (Law 6 — inspectable without the process that produced it).
  write({
    k: 'h', t: 0, runId: id, botName, label: label || null,
    startedAt: new Date(state.startedAt).toISOString(),
    sampleMs, radius, recorder: 'combat_recorder/1',
  });

  // mark(type, data) — an authored EVENT. The director calls this at every decision it makes, because
  // those are the only facts in the file that Minecraft did not produce and they are what the reducer
  // aligns the samples against. Kept small and low-frequency on purpose.
  function mark(type, data) {
    state.events++;
    write({ k: 'e', t: now(), type, ...data });
  }

  function sample() {
    if (state.closed) return;
    if (state.samples >= MAX_SAMPLES) {
      if (!state.capped) {
        state.capped = true;
        mark('recorder_capped', { maxSamples: MAX_SAMPLES, note: 'sampling stopped; run is TRUNCATED' });
      }
      return;
    }

    const snap = scout.entitySnapshot();
    if (!snap.known) { state.dropped++; return; }        // scout down or reconnecting — a gap, counted

    const self = snap.entities.find(e => e.username === botName);
    if (!self) { state.dropped++; return; }              // bot out of the scout's loaded range

    // Hostiles only, within `radius`. The predicate is combatTactic(), the fleet's own dispatch table
    // (Law 16 — the bench must not carry a second opinion about what a monster is), so an unlisted name
    // is excluded here exactly as it is undispatchable there.
    const mobs = snap.entities.filter(e =>
      e.id !== self.id && e.name && e.username == null && combatTactic(e.name) !== null &&
      Math.hypot(e.position.x - self.position.x, e.position.y - self.position.y, e.position.z - self.position.z) <= radius);

    // ── PROJECTILES, a separate array from the mob predicate ────────────────────────────────────────
    // The mob predicate stays the fleet's own dispatch table; an arrow must never reach a counter
    // dispatch. Whether the bot could act on an arrow in flight is answerable only from what mineflayer
    // exposes, so this is a separate array over the same snapshot. Recorded to settle a decision, not to
    // feed one: nothing in the bot reads this (Law 25).
    const arrows = snap.entities.filter(e =>
      e.name && e.username == null && PROJECTILE_NAMES.has(e.name) &&
      Math.hypot(e.position.x - self.position.x, e.position.y - self.position.y, e.position.z - self.position.z) <= radius);

    const t = now();

    // The observer's own verdict on whether a fight is happening and between whom, emitted only when it
    // CHANGES, on the same clock as everything else, so the reducer can line it up against
    // battle_stations' `engage`/`end` rows.
    //
    // Given the WHOLE snapshot, not the `mobs` array above: that array is already narrowed to one
    // subject inside `radius`, and the detector's point is that it is nobody's subject in particular.
    for (const ev of state.engagement.update(snap, t)) {
      mark('engagement_observed', { ...ev, botHp: self.health });
    }

    const botRec = {
      p: round3(self.position),
      v: self.velocity ? round3(self.velocity) : null,
      hp: self.health, yaw: self.yaw, pitch: self.pitch,
      ground: self.onGround, held: self.heldItem, eq: self.equipment,
      // The bot's own living-entity flags, raw and undecoded, same reason the mobs' are carried: bit 0 is
      // hand-active, what a raised shield is on the server — the only place the fleet can see whether the
      // server agreed (Law 26).
      md: self.metadata,
    };

    // Deltas computed here, not in the reducer, since they need the previous sample; a reducer
    // reconstructing them across dropped ticks would misattribute a gap's change to one interval. dtMs
    // travels with them so a delta across a gap reads as one.
    const prev = state.lastBot;
    const botDelta = prev ? {
      dHp: round2(botRec.hp - prev.hp),
      dtMs: t - prev.t,
    } : null;

    write({
      k: 's', t,
      bot: botRec,
      botDelta,
      mobs: mobs.map(m => {
        const p0 = state.lastMobs.get(m.id);
        const dist = Math.hypot(m.position.x - self.position.x, m.position.y - self.position.y, m.position.z - self.position.z);
        return {
          id: m.id, n: m.name,
          p: round3(m.position),
          v: m.velocity ? round3(m.velocity) : null,
          hp: m.health, yaw: m.yaw, ground: m.onGround,
          w: m.width, h: m.height,
          d: round3n(dist),
          dh: round3n(Math.hypot(m.position.x - self.position.x, m.position.z - self.position.z)),
          dHp: p0 && p0.hp != null && m.health != null ? round2(m.health - p0.hp) : null,
          // Closing speed in blocks/tick — the unit repelBrawler's own approach tracker uses, so a
          // measured value and the tactic's modelled one are directly comparable without conversion.
          cs: p0 ? round3n((p0.d - dist) / Math.max(1, (t - p0.t) / 50)) : null,
          md: m.metadata,        // raw, undecoded — see the entitySnapshot header on the fuse question
        };
      }),
      // Empty on all but a handful of samples per wave, so it costs nothing when nothing is in the air.
      arrows: arrows.length ? arrows.map(a => {
        const p0 = state.lastArrows.get(a.id);
        const dist = Math.hypot(a.position.x - self.position.x, a.position.y - self.position.y, a.position.z - self.position.z);
        return {
          id: a.id, n: a.name,
          p: round3(a.position),
          v: a.velocity ? round3(a.velocity) : null,
          d: round3n(dist),
          // Closing speed in b/s, measured from this observer's own two readings — the number that says
          // whether there is time to move, independent of any claim about Java's arrow speed.
          cs: p0 ? round3n((p0.d - dist) / Math.max(0.001, (t - p0.t) / 1000)) : null,
          age: p0 ? t - p0.first : 0,
        };
      }) : undefined,
    });
    const nextArrows = new Map();
    for (const a of arrows) {
      const p0 = state.lastArrows.get(a.id);
      nextArrows.set(a.id, {
        t, first: p0 ? p0.first : t,
        d: Math.hypot(a.position.x - self.position.x, a.position.y - self.position.y, a.position.z - self.position.z),
      });
    }
    state.lastArrows = nextArrows;

    state.lastBot = { ...botRec, t };
    state.lastMobs = new Map(mobs.map(m => [m.id, {
      t, hp: m.health,
      d: Math.hypot(m.position.x - self.position.x, m.position.y - self.position.y, m.position.z - self.position.z),
    }]));
    state.samples++;
  }

  // ── OBSERVED EVENTS (k:'o') — the instants the sampler structurally cannot see ────────────────────
  // A swing or a hit happens BETWEEN samples and is gone by the next one; the scout listens
  // (camera_scout.onObserved) and hands it here unchanged.
  //
  // A THIRD RECORD KIND by Law 26, not bookkeeping: `k:'e'` is AUTHORED, a mark the director made because
  // it decided something; `k:'o'` is OBSERVED, a packet the server sent because Minecraft decided
  // something. Collapsing them would leave the reduced summary unable to say which facts the bench chose
  // and which the world produced.
  //
  // GEOMETRY IS ABSENT from these lines: an event carries what its packet carried plus the entity's
  // position at that instant. Distance-at-swing, knockback travel and cycle time are computed by the
  // monitor against the 20 Hz sample stream beside it.
  scout.onObserved((rec) => {
    if (state.closed) return;
    state.observed++;
    write({
      k: 'o', t: now(),
      type: rec.type,
      id: rec.id,
      n: rec.username || rec.name || null,
      self: rec.username === botName || null,   // the bot under test, so the reducer needs no name table
      p: rec.position ? round3(rec.position) : null,
      v: rec.velocity ? round3(rec.velocity) : null,
      hp: rec.health,
    });
  });

  state.timer = setInterval(sample, sampleMs);

  return {
    runId: id,
    file,
    mark,
    stats: () => ({ samples: state.samples, events: state.events, observed: state.observed, dropped: state.dropped, capped: state.capped, engagements: state.engagement.stats().opened }),
    close() {
      if (state.closed) return;
      // An engagement still open when the run ends is CLOSED HERE and marked truncated, never left
      // dangling. An unterminated start row would make the reducer read the fight as running past the
      // end of the file (Law 8 — what is raised terminates with the owner that raised it).
      for (const ev of state.engagement.closeOpen(now())) mark('engagement_observed', ev);
      // The trailer mirrors the header and carries the drop count, so a run whose scout was down for half
      // its length does not read as a clean run with sparse combat (Law 25).
      state.events++;
      write({ k: 'f', t: now(), samples: state.samples, events: state.events, observed: state.observed, dropped: state.dropped, capped: state.capped });
      state.closed = true;
      clearInterval(state.timer);
      stream.end();
    },
  };
}

// Rounding: raw doubles trail 15 digits of noise the server never meant, and at 20 Hz that noise is most
// of the file. 3 places is under a millimetre — finer than any distance this bench asserts on.
const round3 = p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, z: Math.round(p.z * 1000) / 1000 });
const round3n = n => (n == null ? null : Math.round(n * 1000) / 1000);
const round2 = n => (n == null ? null : Math.round(n * 100) / 100);

module.exports = {
  createRecorder, makeRunId, clearHeldRuns,
  ARENA_LOG_DIR, SAMPLE_MS, MAX_SAMPLES,
};
