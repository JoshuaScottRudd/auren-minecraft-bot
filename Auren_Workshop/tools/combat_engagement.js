// combat_engagement — the OBSERVER's answer to whether a fight is happening, between whom, right now.
//
// ── WHY THE OBSERVER OWNS THIS AND NOT battle_stations ──────────────────────────────────────────────
// The detector belongs to the auditor, not the subject it audits: a bot that decides when its own
// performance gets recorded cannot record the fight it failed to notice (Law 26).
//
// Reaches into nothing: a snapshot in, a line-of-sight function in, engagement events out. Decides
// nothing in any SPA loop and takes no action.
//
// ── THE ESCALATING PULSE ─────────────────────────────────────────────────────────────────────────────
// Entities are tracked at a low pulse to see whether they are within aggro range — one check of
// entities every second. Once something is inside aggro range, raycasting escalates to roughly twice a
// second, and once the raycast confirms line of sight the pair counts as an engagement.
//
// Proximity is arithmetic over a snapshot the observer already holds; a raycast walks blocks and is the
// expensive one, so it is paid for only on pairs already inside aggro range — the same order
// threat_scanner uses inside the construct.
//
// nextTickMs() exposes the escalation as data: the caller drives the clock, this file only says how soon
// it wants to be asked again, which keeps it testable against an authored sequence with no world and no
// wall clock.
//
// ── THE SAME CRITERION, A SEPARATE COPY ──────────────────────────────────────────────────────────────
// Same raycast criterion as battle_stations: camera_scout.aggroLineOfSight is a faithful transcription
// of terrain_predicates.hasLineOfSight, eye height, block centre and range clamp copied exactly, with
// its own header listing the three details that would silently break the assertion if they drift.
//
// A separate copy of that one criterion: the auditor must not evaluate the fight with the subject's own
// ruler (Law 26), and importing the construct's predicate would make any bug in its sightline invisible
// to the thing checking it.
//
// ── WHAT IT CANNOT KNOW, STATED UP FRONT (Law 25) ───────────────────────────────────────────────────
// It cannot read a mob's AI target. No vanilla packet carries it — threat_scanner notes the same gap in
// its own header and uses the same proxy this does: inside AGGRO_RANGE with a clear line. So when three
// hostiles are engaging two bots, what this reports is every (bot, hostile) PAIR that passes the test,
// with its distance and line verdict. Which bot a mob is "really" attacking is an INFERENCE the reducer
// may draw from those pairs; it is never recorded here as a fact, because the observer does not have it.

'use strict';

// Transcribed from Thinking_fragments/architect_config: the fleet's own aggro range (Law 16 — the bench
// must not carry a second opinion). Same transcription lanista_shared makes, for the same reason.
const AGGRO_RANGE = 15;

// Transcribed from architect_config's MOB_AGGRO_RANGE: skeletons and their kin get their own aggro range,
// matching the wider range the construct honours for the skeleton family (Law 25).
//
// A transcription, not an import: the observer must not inherit the thing it checks (Law 26). Keeping it
// in sync is a maintenance cost paid on purpose.
const MOB_AGGRO_RANGE = { skeleton: 18, stray: 18, bogged: 18, wither_skeleton: 18 };
const aggroRangeOf = (name, fallback) =>
  (name && MOB_AGGRO_RANGE[String(name).toLowerCase()]) || fallback;
// The construct's gate is a CYLINDER, not a sphere: the radius above is HORIZONTAL and altitude is
// judged on its own budget, transcribed with the same discipline as the table.
const AGGRO_VERTICAL_RANGE = 8;   // tracks architect_config's own vertical range
// Wider than AGGRO_RANGE: the fleet's own two-sided disengage. A fight ends when the pair has separated
// past the range at which either could re-acquire, not the instant the mob steps past AGGRO_RANGE.
const DISENGAGE_RANGE = 20;

// The two tiers. SCAN is the resting rate; CONFIRM is what it escalates to once anything is inside the
// aggro band and a ray is worth paying for.
const SCAN_MS = 1000;
const CONFIRM_MS = 500;

// How long a pair must stay disengaged (or unseen) before its fight is closed. Longer than one knockback
// and one re-approach, shorter than the gap between separate encounters.
const CLEAR_MS = 1500;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const round2 = n => (n == null ? null : Math.round(n * 100) / 100);

// createEngagementDetector({ losFn, botNames, ... })
//
// losFn(fromFeet, toBlock, maxDist) -> { known, clear, blockedBy }   — camera_scout.aggroLineOfSight's
// exact signature, so the live wiring is a pass-through and the test can author verdicts directly.
//
// botNames: the fleet's own players. Anything else with a username is a HUMAN. Passed in, not derived:
// whether a player is one of ours is a fact about the fleet roster, not a name pattern.
function createEngagementDetector({
  losFn,
  botNames = [],
  aggroRange = AGGRO_RANGE,
  disengageRange = DISENGAGE_RANGE,
  confirmMs = CONFIRM_MS,
  scanMs = SCAN_MS,
  clearMs = CLEAR_MS,
  isHostile,
} = {}) {
  if (typeof losFn !== 'function') throw new Error('createEngagementDetector: losFn is required');
  if (typeof isHostile !== 'function') throw new Error('createEngagementDetector: isHostile is required');

  const fleet = new Set(botNames);
  // Keyed by `${subject.username}|${other.id}`. One entry per PAIR, which is what makes three mobs on two
  // bots six independent little state machines instead of one ambiguous "a fight is happening".
  const pairs = new Map();
  let candidatesLastPass = 0;
  let opened = 0;

  const key = (subjectName, otherId) => `${subjectName}|${otherId}`;

  function pairState(k, seed) {
    let p = pairs.get(k);
    if (!p) { p = { ...seed, engaged: false, engagedAt: null, lastLosAt: -Infinity, los: null, lastNearAt: -Infinity, lastSeenAt: -Infinity, inBand: false }; pairs.set(k, p); }
    return p;
  }

  return {
    // How soon the caller should ask again. THE ESCALATION, as data: resting at the scan rate, dropping
    // to the confirm rate the moment anything is inside the band and a ray is worth paying for.
    nextTickMs: () => (candidatesLastPass > 0 ? confirmMs : scanMs),

    // Every pair with something inside the aggro band RIGHT NOW, confirmed or not.
    //
    // The RECORDING trigger, looser than `engagements()`: writing starts once something is within aggro
    // range, before the raycast confirms — the approach into the band is when the bot should first notice
    // a threat, and a fight whose line never confirms (a mob closing behind a wall) is still a fight the
    // bot is standing in. Proximity opens the tape; the ray decides what gets called an engagement on it.
    candidates: () => [...pairs.values()].filter(p => p.inBand).map(p => ({
      subject: p.subject, subjectKind: p.subjectKind, otherId: p.otherId, otherName: p.otherName,
      otherKind: p.otherKind, distance: round2(p.distance), engaged: p.engaged,
    })),

    // Every pair currently in a confirmed fight, newest state. This is the answer to "which bot is each
    // of the three monsters engaging" — as candidate pairs, never as a claim about the mob's target.
    engagements: () => [...pairs.values()].filter(p => p.engaged).map(p => ({
      subject: p.subject, subjectKind: p.subjectKind, otherId: p.otherId, otherName: p.otherName,
      otherKind: p.otherKind, distance: round2(p.distance), sinceMs: p.engagedAt,
    })),

    stats: () => ({ tracked: pairs.size, engaged: [...pairs.values()].filter(p => p.engaged).length, opened }),

    // update(snapshot, t) -> events[]
    //
    // snapshot is camera_scout.entitySnapshot()'s shape: { known, entities:[{id,name,username,position,...}] }.
    // An unknown snapshot changes NOTHING — no opens, no closes. A scout that is down or reconnecting must
    // not read as "every fight ended" (Law 23: an unread world is unknown, never empty).
    update(snapshot, t) {
      if (!snapshot || !snapshot.known) return [];
      const events = [];
      const entities = snapshot.entities || [];

      // SUBJECTS are players — fleet bots and humans alike. Both are recorded; which pairs are worth
      // WRITING is the recorder's predicate, not this file's. Detection of a pair costs one ray; writing
      // it is the expensive half, so the filter belongs where the cost is.
      const subjects = entities.filter(e => e.username && e.position);
      const others = entities.filter(e => e.position && (isHostile(e.name) || (e.username && e.username !== null)));

      // inBand is cleared for EVERY pair before the pass, not just the ones the loop reaches. A pair that
      // walked past the disengage band, or vanished from the snapshot entirely, is skipped by the loop
      // below and would otherwise keep last pass's `true` forever — leaving the recorder writing 20 Hz
      // telemetry about a fight that ended, with nothing to turn it off.
      for (const p of pairs.values()) p.inBand = false;

      let candidates = 0;
      for (const s of subjects) {
        const subjectKind = fleet.has(s.username) ? 'bot' : 'human';
        for (const o of others) {
          if (o.id === s.id) continue;
          // A human-vs-human pair is not combat and never becomes an engagement here.
          if (o.username && !isHostile(o.name)) {
            if (!fleet.has(s.username) && !fleet.has(o.username)) continue;
          }
          const d = dist(s.position, o.position);
          if (d > disengageRange) continue;              // too far to be either starting or continuing
          const playerPair = !!o.username;

          const k = key(s.username, o.id);
          const p = pairState(k, {
            subject: s.username, subjectKind, otherId: o.id,
            otherName: o.name || o.username || null,
            otherKind: o.username ? (fleet.has(o.username) ? 'bot' : 'human') : 'hostile',
          });
          p.distance = d;
          p.lastSeenAt = t;
          // Per species, matching the construct's own radius for THIS mob. A player pair has no species
          // entry and falls back to the flat range, which is what the bot's own gate does for it too.
          const range = aggroRangeOf(o.name, aggroRange);
          // The cylinder, both axes. `d` above stays 3-D because the DISENGAGE test genuinely is a
          // separation distance; only the band test is shaped.
          p.inBand = Math.abs(o.position.y - s.position.y) <= AGGRO_VERTICAL_RANGE &&
            Math.hypot(o.position.x - s.position.x, o.position.z - s.position.z) <= range;

          if (p.inBand) {
            p.lastNearAt = t;
            candidates++;
            // TIER TWO. The ray is paid for here and only here — inside the band, and no more often than
            // confirmMs. A pair already engaged keeps being re-checked: a wall going up between two
            // fighters ends the fight just as truly as walking away, and only the ray can see that.
            if (t - p.lastLosAt >= confirmMs) {
              p.lastLosAt = t;
              p.los = losFn(s.position, o.position, range);
            }
            // Law 23: an unknown line is not a clear one, so an unloaded endpoint leaves the pair exactly
            // where it was.
            //
            // Range plus line is the hostile proxy only: it is the construct's own aggro test, and a mob
            // inside that band with a clear line IS committed, which is what aggro means. It says nothing
            // about two PLAYERS: a human standing beside a bot passes range and line indefinitely without
            // fighting anybody. A player pair opens only on a BLOW (noteCombatEvent, fed from the
            // observed-packet channel of a swing or hurt the server announced). Until a blow arrives, the
            // pair is tracked and idle: seen near each other with no evidence they are fighting.
            if (p.los && p.los.known && p.los.clear && !p.engaged && !playerPair) {
              p.engaged = true;
              p.engagedAt = t;
              opened++;
              events.push({
                phase: 'start', subject: p.subject, subjectKind: p.subjectKind,
                otherId: p.otherId, otherName: p.otherName, otherKind: p.otherKind,
                distance: round2(d), blockedBy: null,
              });
            }
          }
        }
      }
      candidatesLastPass = candidates;

      // CLOSING. Separate pass, because a pair closes on ABSENCE — out of the disengage band, or gone
      // from the snapshot entirely (killed, despawned, walked out of the observer's loaded chunks). The
      // loop above only ever sees pairs that are still present, so absence is unrepresentable inside it.
      for (const [k, p] of pairs) {
        const gone = t - p.lastSeenAt;
        // `separated` is the load-bearing test and subsumes `gone`: a pair can only be near if it was
        // also seen, so lastNearAt <= lastSeenAt and separated >= gone always. The two are read apart
        // only to name the REASON below.
        const separated = t - p.lastNearAt;
        if (p.engaged && separated >= clearMs) {
          p.engaged = false;
          events.push({
            phase: 'end', subject: p.subject, subjectKind: p.subjectKind,
            otherId: p.otherId, otherName: p.otherName, otherKind: p.otherKind,
            durationMs: t - p.engagedAt,
            // Which of the two ways it ended. A fight that ended because the mob DIED and one that ended
            // because the observer lost sight of it are different facts, and a reader cannot tell them
            // apart from a duration (Law 25).
            reason: gone >= clearMs ? 'unseen' : 'separated',
          });
          p.engagedAt = null;
        }
        // Forgetting a pair is bounded by the same window: an entry nobody has seen for a full clear
        // window is not coming back with the same entity id, and keeping it would grow the map for the
        // life of the observer (Law 8 — nothing runs on invisibly past its own lifecycle).
        if (!p.engaged && gone >= clearMs) pairs.delete(k);
      }

      return events;
    },

    // noteCombatEvent(subjectName, otherId, t) -> event | null
    //
    // The player-pair opener, fed from the server's own swing/hurt announcements: between two players a
    // blow is the only thing that distinguishes a fight from standing next to someone. Returns the start
    // event if this opened one, so the caller records it on the same channel as every hostile engagement.
    //
    // Does not create a pair from nothing: the two must already be inside the tracked band this pass, so
    // an event about entities the observer cannot see never puts a fight in the file with no samples
    // behind it (Law 23).
    noteCombatEvent(subjectName, otherId, t) {
      const p = pairs.get(key(subjectName, otherId));
      if (!p || p.engaged) return null;
      p.engaged = true;
      p.engagedAt = t;
      p.lastNearAt = t;          // a blow landed, so they are engaged regardless of the range band
      opened++;
      return {
        phase: 'start', subject: p.subject, subjectKind: p.subjectKind,
        otherId: p.otherId, otherName: p.otherName, otherKind: p.otherKind,
        distance: round2(p.distance), openedBy: 'blow',
      };
    },

    // Called when the observer stops with fights still open, so no start is left unterminated (Law 8).
    closeOpen(t) {
      const events = [];
      for (const p of pairs.values()) {
        if (!p.engaged) continue;
        p.engaged = false;
        events.push({
          phase: 'end', subject: p.subject, subjectKind: p.subjectKind,
          otherId: p.otherId, otherName: p.otherName, otherKind: p.otherKind,
          durationMs: t - p.engagedAt, reason: 'truncated', truncated: true,
        });
        p.engagedAt = null;
      }
      return events;
    },
  };
}

module.exports = {
  createEngagementDetector,
  AGGRO_RANGE, MOB_AGGRO_RANGE, AGGRO_VERTICAL_RANGE, aggroRangeOf, DISENGAGE_RANGE, SCAN_MS, CONFIRM_MS, CLEAR_MS,
};
