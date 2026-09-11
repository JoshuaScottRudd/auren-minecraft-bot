// combat_recorder — the locomotion course's instrument. Maximal per-tick telemetry, written by an
// OUTSIDE OBSERVER, into a stream the watcher never sees.
//
// ── ITS ONE CALLER ──────────────────────────────────────────────────────────────────────────────────
// `tools/locomotion_course` uses this to sample a MOVEMENT leg at 20 Hz and reduces its own output
// (`reduceLeg`), so the record and the reader are paired in one file and this module has exactly one
// caller. The combat rationale below still holds — it is why 20 Hz does not belong in the watcher — but
// read "combat" as "any sub-second question": the argument is not about mobs, it is about a sample rate
// the trace cannot carry.
//
// ── WHY IT IS NOT THE WATCHER, AND NOT trace_monitor ────────────────────────────────────────────────
// Three reasons, each landing on a different law:
//
//   1. VOLUME. Combat correctness is decided in ~200 ms windows, so calibrating it needs ~20 samples a
//      second. Law 5 permits exactly three persisted levels and per-step logging was deleted as noise;
//      pushing 20 Hz into the watcher would bury every line the trace exists to carry. So this is not a
//      fourth log level and must never become one — it is an INSTRUMENT READING, a separate stream with
//      its caller's own reducer and a separate lifetime.
//   2. OWNERSHIP. The construct records nothing new. Law 26: the thing under test must not produce the
//      evidence of its own performance — a simulated guarantee is a deleted guarantee, and a bot that
//      reports its own swing timings is grading its own paper. Every number here is read off the shared
//      world by the scout, an observer with no vote in any SPA loop (Law 19).
//   3. LIFETIME. Held until the next start command, exactly like the watcher trace. Law 8 is satisfied
//      by the overwrite, not by the delete — the directory never grows without bound because a start
//      command replaces it, so nothing is a zombie and nothing is released because a finding was taken
//      from it. Scrubbing at the end of each piece was tried and deliberately removed (there is no
//      --scrub flag left to reintroduce): releasing the raw as soon as a summary existed answered only
//      the first question, and every later question about that same fight had to be answered by running
//      again — a different world, defeating the calibration the instrument exists to serve.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────────────
// It decides nothing, flags nothing, and asserts nothing. It does not compute what Minecraft would have
// done — every field is a value the server sent. The derived numbers (distance, hp delta, closing speed)
// are arithmetic over two observed positions, which is why they are safe; anything requiring a model of
// Minecraft's rules is left to the caller's reducer, where it can be read against the raw beside it.
//
// ── FORMAT ──────────────────────────────────────────────────────────────────────────────────────────
// `fleet_logs/arena/<runId>.jsonl`, one JSON object per line. Two record kinds, distinguished by `k`:
//   k:'s'  SAMPLE — one observation tick. High volume; this is the maximal data.
//   k:'o'  OBSERVED — a server-sent packet the sampler cannot see (a swing, a hit, a death). The
//                   INSTANTS. See the block above scout.onObserved for why this is a separate kind.
//   k:'e'  EVENT  — an authored mark from the caller (leg start, dispatch, arrival). Low volume; this is
//                   the spine the reducer walks along.
// jsonl rather than one JSON document: a run that crashes mid-fight still leaves every completed line
// readable, and the reducer streams instead of loading a whole run into memory.

'use strict';

const fs = require('fs');
const path = require('path');
// The fleet's own name→group table, not a copy of it (Law 16 — the bench must not carry a second
// opinion about what a monster is). Required LAZILY, inside createRecorder, and that is not stylistic:
// a caller may import this module for ARENA_LOG_DIR alone without running the NODE_PATH bootstrap, and a
// top-level @-alias require here would break it outright. Every caller that actually records has
// bootstrapped by the time it calls createRecorder.
let _combatTactic = null;
const combatTactic = name => (_combatTactic || (_combatTactic = require('@utils/combat_utils').combatTactic))(name);

// The observer's engagement detector — the ONE implementation of "is a fight happening and between
// whom" (Law 16). It lives in its own file rather than here because the standing fleet observer runs it
// on its own escalating pulse with no recorder attached at all; a copy inside this file would be a
// second detector that could disagree with the one the fleet audits by.
const { createEngagementDetector } = require('./combat_engagement');

const ARENA_LOG_DIR = require('../workshop_paths').fleetLogs('arena');

// 50 ms = one Minecraft tick. The bench's headline questions are all sub-second — "ticks from
// jump-trigger to impact vs the modelled 7", "distance at the moment of the swing vs the 3.5-block
// reach" — and a sampler coarser than the thing it measures cannot answer them. This is the ONE place
// the volume is set, so the cost of the whole instrument is one number the Architect can move.
const SAMPLE_MS = 50;

// A hard ceiling on one run's samples. NOT a quality knob — a runaway guard. At 20 Hz a forgotten
// recorder writes ~72k lines an hour, and the failure mode of an unattended instrument is a disk, not a
// bad measurement. Hitting it is reported, never silent (Law 25 — a truncated run must not read as a
// complete one).
const MAX_SAMPLES = 200000;

// The projectiles worth recording. Named explicitly rather than derived from a type field, because
// mineflayer types every one of these as a bare object and the field cannot tell an arrow from a boat.
const PROJECTILE_NAMES = new Set(['arrow', 'spectral_arrow', 'trident']);

function ensureDir() {
  if (!fs.existsSync(ARENA_LOG_DIR)) fs.mkdirSync(ARENA_LOG_DIR, { recursive: true });
}

// ── THE OVERWRITE ───────────────────────────────────────────────────────────────────────────────────
// The held raw of the PREVIOUS start command, released here and only here. Deliberately not a caller's
// obligation: an overwrite the caller has to remember is an overwrite that eventually does not happen,
// and the failure is silent growth. First createRecorder of the process clears; every later one in the
// same process appends to the same generation, because the unit is the START COMMAND, not the arena —
// one invocation that runs several legs produces several files that belong to one capture.
//
// It fires on the first RECORDER, not at process start, so a run that dies in the survey (before any
// data exists) leaves the previous capture intact. The operator cannot tell the difference; the case
// where the new record never arrives is the only one where it matters, and there the old one is still
// the only evidence there is.
//
// summaries/ is untouched — that is the reduced artifact and it outlives every raw generation.
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
// experiment log rather than a pile of hashes.
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
    // The detector is driven off THIS recorder's 20 Hz tick rather than its own escalating pulse: the
    // samples are already being taken, so the proximity pass is free and the events land on the finest
    // clock available. Its own confirmMs throttle is what keeps the ray at 2 Hz per pair regardless of
    // how often it is asked — the escalation exists for the standing observer, which has no 20 Hz tick.
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
  // about an INTERVAL ("ticks from jump to impact"), and a relative clock makes those readable without
  // subtracting ISO strings, while `startedAt` in the header keeps the absolute time recoverable.
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

    // Hostiles only, and only within `radius`. An unfiltered snapshot in a populated world is mostly
    // dropped items and passive mobs, which multiplies the volume without answering any question the
    // bench asks. A name-based filter that admitted any non-player entity would let a passive mob be
    // picked as a reducer's nearest-mob target, attributing the whole swing ledger and every distance to
    // something that was never in the fight. The predicate is combatTactic(), the fleet's own dispatch
    // table (Law 16 — the bench must not carry a second opinion about what a monster is), so an unlisted
    // name is excluded here exactly as it is undispatchable there.
    const mobs = snap.entities.filter(e =>
      e.id !== self.id && e.name && e.username == null && combatTactic(e.name) !== null &&
      Math.hypot(e.position.x - self.position.x, e.position.y - self.position.y, e.position.z - self.position.z) <= radius);

    // ── PROJECTILES, kept in their own array rather than by widening the mob predicate ────────────────
    // The predicate above is deliberately the fleet's own dispatch table and must stay that way (an
    // arrow is not a monster and must never reach a counter dispatch). But the question "could the bot
    // act on an arrow already in flight" is answerable only from what a mineflayer client can actually
    // SEE of one, and nothing in this repo had ever looked. So: a separate array, same snapshot, no
    // change to what counts as a threat.
    //
    // Recorded to settle a decision, not to feed one: nothing in the bot reads this. If the flight time
    // turns out to be shorter than the round trip needed to react, the honest answer is that no in-flight
    // system is buildable at combat range and the record says so in numbers (Law 25).
    const arrows = snap.entities.filter(e =>
      e.name && e.username == null && PROJECTILE_NAMES.has(e.name) &&
      Math.hypot(e.position.x - self.position.x, e.position.y - self.position.y, e.position.z - self.position.z) <= radius);

    const t = now();

    // The observer's own verdict on whether a fight is happening and between whom, emitted only when it
    // CHANGES. Two low-frequency events per engagement, on the same clock as everything else, so the
    // reducer can line them up against battle_stations' `engage`/`end` rows without either side carrying
    // a wall clock — which is what turns "did the bot notice in time" into a number.
    //
    // It is given the WHOLE snapshot, not the `mobs` array above: that array is already narrowed to one
    // subject inside `radius`, and the detector's whole point is that it is nobody's subject in
    // particular. Narrowing it here would rebuild the single-bot assumption the pair keying removes.
    for (const ev of state.engagement.update(snap, t)) {
      mark('engagement_observed', { ...ev, botHp: self.health });
    }

    const botRec = {
      p: round3(self.position),
      v: self.velocity ? round3(self.velocity) : null,
      hp: self.health, yaw: self.yaw, pitch: self.pitch,
      ground: self.onGround, held: self.heldItem, eq: self.equipment,
      // The bot's OWN living-entity flags, raw and undecoded, for the same reason the mobs' are carried:
      // bit 0 is 'hand active', which is what a raised shield IS on the server. The construct can only
      // report that it SENT the packet; this is the only place the fleet can see whether the server
      // agreed (Law 26 — the thing under test must not produce the evidence of its own performance).
      md: self.metadata,
    };

    // Deltas are computed HERE rather than in the reducer because they need the previous sample, and a
    // reducer that reconstructs them from a stream with dropped ticks would silently attribute a gap's
    // worth of change to one interval. dtMs travels with them so a delta across a gap is legible as one.
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
  //
  // A swing and a hit happen BETWEEN samples and are gone by the next one. No sampling rate fixes that:
  // they are announcements, not states, so the only way to record them is to listen. The scout listens
  // (camera_scout.onObserved) and hands them here unchanged.
  //
  // A THIRD RECORD KIND, and the distinction is Law 26's, not bookkeeping. `k:'e'` is AUTHORED — a mark
  // the director made because it decided something (summon this mob, start this wave). `k:'o'` is
  // OBSERVED — a packet the server sent because Minecraft decided something. Collapsing them into one
  // kind would make the reduced summary unable to say which of its facts the bench chose and which the
  // world produced, which is the one distinction the whole bench rests on.
  //
  // GEOMETRY IS DELIBERATELY ABSENT from these lines. An event carries what its packet carried plus the
  // entity's position at that instant; distance-at-swing, knockback travel and cycle time are all
  // computed by the monitor against the 20 Hz sample stream beside it. Same rule the header already sets
  // for the samples: this file stores what the server sent, and every model of what it MEANS lives in
  // the reducer where it can be read against the raw.
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
      // The trailer mirrors the header and carries the drop count. A run whose scout was down for half
      // its length must not read as a clean run with sparse combat (Law 25 — the verdict states the true
      // result, and "how much did we fail to see" is part of it).
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
