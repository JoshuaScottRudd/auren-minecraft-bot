// fragment: set_wood_preference (action)
// purpose: Decide, ONCE for the whole fleet, which log species construction should prefer — by counting
//          what is actually standing around the base — and publish it where every bot can read it.
//
// The job runs behind a magnet so only one bot executes it, and does the same surface scan a log search
// would do — but purely to fix the preference, not to gather. It is posted at high priority alongside
// blueprint-location setup, so on a fresh run it resolves before any gathering starts; once set, it never
// re-posts.
//
// THE PROBLEM IT SOLVES, and why a preference is worth a job of its own. `craft_handler.resolveGroupItem`
// picks the plank species the bot holds the most LOGS of. A pocket split across two species therefore tops
// out at whichever half is larger, and the larger half is not the total — a craft can starve while the
// combined pile would have covered it. Converging the log supply on one species is what fixes that, and it
// can only converge if the choice is made BEFORE the gathering starts — hence a startup one-shot ranked
// above every tier that touches wood.
//
// IT IS A SORT KEY, NOT A COMMITMENT, and that distinction is the whole reason this is allowed to exist.
// The fleet already tried a wood commitment once: a `wood_species` boardroom chair that meant "one species
// until it runs out" and FILTERED the candidate list, so a nearer birch was skipped to reach an oak the
// fleet had promised itself. Nothing here filters. tree_feller's ranking puts the preferred species ahead
// of the rest and breaks ties by distance; every other species stays in the list and gets felled the
// moment the preferred ones are exhausted or unreachable — it prefers and selects, never removes the
// possibility of harvesting any other type.
//
// WHY IT IS DECIDED ONCE AND NEVER RE-SENSED — the one place this system yields to remembered state on
// purpose (Invariant B). What is remembered is a CHOICE, not a world fact. Re-measuring every scan would
// flip the preference whenever a bot happened to stand in a different grove, which is precisely the churn
// a stable ordering exists to prevent; and the world fact underneath it is re-read every single scan
// anyway, by the candidate list this only re-orders. So the remembered value can never make the bot walk
// to a tree that is not there.
//
// WHY IT RIDES THE BOARDROOM CHAIR. One bot decides for the fleet, so the answer has to cross the overseer.
// Conference-room flags do not — they are local to each bot's HQ file. The overseer broadcasts exactly
// three things, and the chair is the right one: it already carries per-bot facts (magnet, claims, body
// cell, position), every writer read-modify-writes it rather than replacing it, and it has exactly one
// writer, so a merge conflict cannot arise (Invariant D). See architect_config.WOOD_PREFERENCE_CHAIR_FIELD
// for why the building conference was the other candidate and was rejected.
//
// This fragment operates ON the record only — it joins no build or gather pathway, places nothing, and
// walks nowhere. The scan is the same surface_filter log scan the feller runs, reused rather than
// re-implemented (Law 16); it is called for its CENSUS, not for a tree to cut.

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { routeToJudge } = require('@utils/signal_utils');
const { WOOD_PREFERENCE_CHAIR_FIELD } = require('@thinking/architect_config');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'set_wood_preference';

const LOG_NAME = /(.*_)?log$/;

// readWoodPreference — the fleet's decided species, or null before the job has ever run.
//
// Scans EVERY chair, not just this bot's: the job is scope:'shared', so the bot that ran it is usually the
// peer, and a bot reading only its own chair would see null forever and fall back to distance-only order
// (correct, but it would silently discard the whole feature).
//
// Deterministic on the collision that should not happen (Law 19): two bots can only both hold a preference
// if they wrote one either side of a disconnect, and then a tie must resolve the same way on both machines
// or their orderings diverge. Earliest decision wins — the same first-writer rule the building conference
// uses — with the species name as the final tie-break.
function readWoodPreference() {
  const board = hq.getFullBoardroom({}) || {};
  let best = null;
  for (const chair of Object.values(board)) {
    const pref = chair && chair[WOOD_PREFERENCE_CHAIR_FIELD];
    if (!pref || !pref.species) continue;
    if (!best) { best = pref; continue; }
    const a = Date.parse(pref.decided_at || '') || Infinity;
    const b = Date.parse(best.decided_at || '') || Infinity;
    if (a < b || (a === b && pref.species < best.species)) best = pref;
  }
  return best;
}

// woodPreferenceSet — the ONE definition of "this job has nothing left to do" (Law 16), exported so
// job_board's posting gate asks the performer instead of re-deriving the performer's criterion. That is
// the same rule `lock_all_buildspots.baseLayoutComplete` exists to enforce: a gate that computes its own
// "done" can demand more than the performer will ever deliver and re-post forever.
function woodPreferenceSet() {
  return readWoodPreference() !== null;
}

// run(bot) → { ok, species, census } | { ok:false, reason }
//
// A miss is ENVIRONMENTAL, never a throw: a bot standing in a clearing (or with the world still streaming)
// legitimately sees no trees, and the correct response is to leave the preference unset and let the job
// re-post next sweep from a different spot. Law 13's test — could this happen in a correctly-written
// system in a normal world? Yes, so it soft-fails.
async function run(bot) {
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set (no bot.entity.position). The bot must be registered before this fragment runs.`);
  }

  const surfaceFilter = require('@perception/surface_filter');
  const scan = surfaceFilter.scan(bot, { type: 'object_group_or_direct', targets: ['logs'] });

  // surface_filter collapses a log scan to one entry per TRUNK, so this counts trees, not blocks — trees
  // are the deciding unit, not logs.
  const census = {};
  for (const o of (scan?.objectives || [])) {
    if (!o || !LOG_NAME.test(o.name || '')) continue;
    census[o.name] = (census[o.name] || 0) + 1;
  }

  const ranked = Object.entries(census).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  if (!ranked.length) {
    return { ok: false, reason: 'no_trees_in_scan', census };
  }
  const [species, trunks] = ranked[0];

  const botId = process.env.BOT_ID || 'default';
  const chair = hq.readBoardroomChair(botId, {}) || {};
  chair[WOOD_PREFERENCE_CHAIR_FIELD] = {
    species, trunks, census,
    decided_at: new Date().toISOString(),
    decided_by: botId,
  };
  hq.writeBoardroomChair(botId, chair);

  // Push it to the peers NOW rather than waiting for the next heartbeat. This job exists to run before the
  // gathering starts, so a preference that reaches the other bot a sweep late has already missed the logs
  // it was meant to steer.
  guardExternalSync(TAG, 'overseer sendUpdate', () => require('@kernel/overseer_link').sendUpdate());

  const censusStr = ranked.map(([n, c]) => `${n}:${c}`).join(' ');
  watcher.summary(TAG, `Wood preference set to ${species} (${trunks} trunks; census ${censusStr}). Construction now prefers it; every species stays fellable, and this job will not post again.`);
  return { ok: true, species, census };
}

module.exports = {
  run,
  readWoodPreference,
  woodPreferenceSet,
  receive: watcher.track(TAG, async function (signalType, payload) {
    if (signalType !== TAG) return; // strict contract

    const result = await run(global.bot);

    if (!result.ok) {
      // Soft-fail to the judge: the preference stays unset, the board re-posts, and the next attempt scans
      // from wherever the bot has moved to. Never a false success (Law 25) — a bot that saw no trees has
      // not set a preference, and the readable says so.
      routeToJudge(TAG, {
        ...payload,
        result: 'wood_preference_pending', success: false,
        readable: `${TAG}: no preference set (${result.reason}) — retry`,
      });
      return;
    }
    routeToJudge(TAG, {
      ...payload,
      result: 'wood_preference_set', success: true,
      set_wood_preference: { species: result.species },
      readable: `${TAG}: fleet wood preference = ${result.species} -> recursive_judge`,
    });
  }),
};
