// combat_engagement — the OBSERVER's answer to "is a fight happening, between whom, right now".
//
// ── WHY THE OBSERVER OWNS THIS AND NOT battle_stations ──────────────────────────────────────────────
// A subject does not get to decide when it is audited — that defeats the purpose of auditing it.
//
// The shortcut ruled out was letting battle_stations emit a signal that starts the recording. Trigger
// control is evidence control: a bot that decides when its own performance gets recorded cannot record
// the fight it failed to notice. A bot-signalled trigger produces no observation at all for exactly the
// fights most worth observing — the ones the bot's own loop never noticed it was in (Law 26).
//
// So this file is the auditor's own detector. It reaches into nothing: a snapshot in, a line-of-sight
// function in, engagement events out. It decides nothing in any SPA loop and takes no action.
//
// ── THE ESCALATING PULSE ─────────────────────────────────────────────────────────────────────────────
// Entities are tracked at a low pulse to see whether they are within aggro range — one check of
// entities every second. Once something is inside aggro range, raycasting escalates to roughly twice a
// second, and once the raycast confirms line of sight the pair counts as an engagement.
//
// Two tiers, because the two questions cost different amounts. Proximity is arithmetic over a snapshot
// the observer already holds; a raycast walks blocks and is the expensive one. So: scan everything
// cheaply at 1 Hz, and pay for the ray ONLY on pairs already inside aggro range — the same order
// threat_scanner uses inside the construct, which likewise skips the ray for any mob too far to be
// aggroed regardless.
//
// The escalation is exposed as nextTickMs() rather than owned by an internal timer: the caller drives
// the clock, this file only says how soon it wants to be asked again. That keeps it pure enough to test
// against an authored sequence with no world and no wall clock.
//
// ── THE SAME CRITERION, DELIBERATELY NOT THE SAME CODE ──────────────────────────────────────────────
// Same raycast criterion as battlestations, for consistency — but not the same code. Same CRITERION:
// yes, and that is already built — camera_scout.aggroLineOfSight is a faithful transcription of
// terrain_predicates.hasLineOfSight, eye height, block centre and range clamp copied exactly, with its
// own header listing the three details that silently break the assertion if they drift.
//
// Same CODE: no. Importing the construct's predicate would make the auditor evaluate the fight with the
// subject's own ruler — any bug in the construct's sightline becomes invisible, because the thing
// checking agrees by construction. That is the trigger argument one layer down (Law 26: the check must
// not inherit the thing it checks). Two copies of one criterion is the correct shape here and the only
// place in the fleet where it is.
//
// ── WHAT IT CANNOT KNOW, STATED UP FRONT (Law 25) ───────────────────────────────────────────────────
// It cannot read a mob's AI target. No vanilla packet carries it — threat_scanner notes the same gap in
// its own header and uses the same proxy this does: inside AGGRO_RANGE with a clear line. So when three
// hostiles are engaging two bots, what this reports is every (bot, hostile) PAIR that passes the test,
// with its distance and line verdict. Which bot a mob
// is "really" attacking is an INFERENCE the reducer may draw from those pairs; it is never recorded here
// as a fact, because the observer does not have it.

'use strict';

// Transcribed from Thinking_fragments/architect_config, NOT chosen. The fleet already owns these two
// numbers and an observer carrying its own opinion of aggro range would report engagements the construct
// never had, or miss ones it did (Law 16 — the bench must not carry a second opinion). Same transcription
// lanista_shared already makes, and for the same reason.
//
// WRONG TURN, already taken: an earlier version of this detector used one flat number for EVERY mob,
// picked from generic Minecraft knowledge about hostile acquisition range rather than read off the
// fleet's own table. A detector wider than the construct's gate manufactures engagements the bot was
// never obliged to notice, and they read as the bot missing them. The rule that survived is "transcribe
// the fleet's table", never a single fixed number — the fleet's table itself later stopped being one
// number, which the per-species table below now carries.
const AGGRO_RANGE = 15;

// Transcribed from architect_config's MOB_AGGRO_RANGE — skeletons and their kin get their own aggro
// range rather than the flat fallback. The construct honours the wider range for the skeleton family, so
// a detector still holding the flat fallback would report every skeleton engagement opened in the gap
// between the two ranges as a fight the bot failed to notice — an instrument manufacturing the exact
// defect it exists to detect (Law 25).
//
// STILL A TRANSCRIPTION AND NOT AN IMPORT, for the reason this file's header gives: the observer must not
// inherit the thing it checks (Law 26). Keeping it in sync is a maintenance cost paid on purpose; the
// alternative is a bench that agrees with the fleet by construction and can never disagree with it.
const MOB_AGGRO_RANGE = { skeleton: 18, stray: 18, bogged: 18, wither_skeleton: 18 };
const aggroRangeOf = (name, fallback) =>
  (name && MOB_AGGRO_RANGE[String(name).toLowerCase()]) || fallback;
// The construct's gate is a CYLINDER, not a sphere: the radius above is HORIZONTAL and altitude is
// judged on its own budget. Transcribed with the same discipline as the table — an observer still
// measuring a 3-D distance would call a mob far across but only just above "out of band" while the
// construct was already fighting it, and report the fight as one the bot imagined.
const AGGRO_VERTICAL_RANGE = 8;   // tracks architect_config's own vertical range
// > AGGRO_RANGE on purpose: the fleet's own two-sided disengage. A fight is not over the instant the mob
// steps past 15 — it is over when the pair has separated past the range at which either could re-acquire.
// Using one number for both edges would split a single fight into a burst of starts and ends every time
// a knockback landed.
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
// botNames: the fleet's own players. Anything else with a username is a HUMAN. Passed in rather than
// derived, because "is this player one of ours" is a fact about the fleet roster and an observer that
// guessed it from a name pattern would silently reclassify a human who picked a bot-like name.
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
    // This is the RECORDING trigger and it is deliberately looser than `engagements()`: tracking runs
    // continuously, but writing only starts once something is within aggro range. Waiting for the
    // raycast to confirm would start the record after the interesting part: the approach into the band
    // is where "when did the bot notice, and when should it have" lives, and a fight whose line never
    // confirms — a mob closing behind a wall — is still a fight the bot is standing in.
    // Proximity opens the tape; the ray decides what gets called an engagement on it.
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
            // Law 23: an unknown line is not a clear one. An unloaded endpoint leaves the pair exactly
            // where it was rather than opening a fight nobody sensed.
            // RANGE + LINE IS THE HOSTILE PROXY ONLY. It is the construct's own aggro test, and it works
            // for a mob because a mob inside that band with a clear line IS committed — that is what
            // aggro means. It says nothing about two PLAYERS: a human standing beside a bot passes range
            // and line indefinitely and is not fighting anybody, so opening on proximity would leave an
            // engagement open for as long as they stand there and file it as combat data.
            //
            // A player pair opens on a BLOW instead — noteCombatEvent, fed from the observed-packet
            // channel (a swing or a hurt the server announced). Until that arrives the pair is tracked
            // and idle, which is the honest state: we can see them near each other and we have no
            // evidence they are fighting.
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
        // `separated` is the load-bearing one and it subsumes `gone`: a pair can only be near if it was
        // also seen, so lastNearAt <= lastSeenAt and separated >= gone always. Testing them jointly with
        // a min() — which an earlier version did — meant a mob standing in plain sight twenty blocks away
        // never closed its fight, because it was still visible and gone stayed at zero. The two are read
        // apart only to name the REASON below.
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
    // The player-pair opener. Fed from the server's own swing/hurt announcements rather than from
    // geometry, because between two players a blow is the only thing that distinguishes a fight from
    // standing next to someone. Returns the start event if this opened one, so the caller records it on
    // the same channel as every hostile engagement.
    //
    // It does NOT create a pair from nothing: the two must already be inside the tracked band this pass.
    // An event about entities the observer cannot see is a claim about a fight it has no record of, and
    // opening on it would put a fight in the file with no samples behind it (Law 23).
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
