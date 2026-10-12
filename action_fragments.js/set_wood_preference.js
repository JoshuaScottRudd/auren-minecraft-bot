// fragment: set_wood_preference (action)
// purpose: Decide, once for the whole fleet, which log species construction should prefer — by counting
//          what is standing around the base — and publish it where every bot can read it.
//
// Runs behind a magnet so only one bot executes it, using the same surface scan a log search would do,
// for a census. Posted at high priority alongside blueprint-location setup so it resolves before
// gathering starts; once set, it never re-posts.
//
// craft_handler.resolveGroupItem picks the plank species the bot holds the most logs of, so a pocket
// split across species tops out at whichever half is larger. Converging the log supply on one species
// before gathering starts is what this job exists to do.
//
// It is a sort key, not a commitment: tree_feller's ranking puts the preferred species ahead of the rest
// and breaks ties by distance, and every other species stays in the list and gets felled once the
// preferred ones are exhausted or unreachable.
//
// Decided once and never re-sensed (Invariant B): the chair holds a choice, not a world fact, and the
// candidate list beneath it re-reads the world on every scan, so the remembered value can never send a
// bot to a tree that is not there.
//
// Travels on the boardroom chair (WOOD_PREFERENCE_CHAIR_FIELD): one bot decides for the whole fleet, so
// the answer must cross the foreman. The chair already carries per-bot facts (magnet, claims, body cell,
// position), every writer read-modify-writes it, and it has exactly one writer, so a merge conflict
// cannot arise (Invariant D).
//
// Operates on the record only: joins no build or gather pathway, places nothing, walks nowhere. Reuses
// surface_filter's log scan for its census (Law 16).

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternalSync } = require('@utils/external_library_guard');

// The boardroom-chair field this fleet-wide choice travels in; both the writer and the reader live in
// this file.
const WOOD_PREFERENCE_CHAIR_FIELD = 'wood_preference';

const TAG = 'set_wood_preference';

const LOG_NAME = /(.*_)?log$/;

// readWoodPreference — the fleet's decided species, or null before the job has ever run.
//
// Scans every chair, not just this bot's: the job is scope:'shared', so the bot that ran it is usually a
// peer.
//
// Deterministic on the collision that should not happen (Law 19): if two bots each hold a preference, a
// tie must resolve the same way on both machines or their orderings diverge. Earliest decision wins — the
// same first-writer rule the building conference uses — with the species name as the final tie-break.
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

// woodPreferenceSet — the one definition of whether this job has nothing left to do (Law 16), exported so
// job_board's posting gate asks the performer instead of re-deriving its criterion, the same rule
// `lock_all_buildspots.baseLayoutComplete` enforces.
function woodPreferenceSet() {
  return readWoodPreference() !== null;
}

// run(bot) → { ok, species, census } | { ok:false, reason }
//
// A miss is environmental, never a throw (Law 13): a bot standing in a clearing, or with the world still
// streaming, legitimately sees no trees, so it leaves the preference unset and lets the job re-post next
// sweep from a different spot.
async function run(bot) {
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set (no bot.entity.position). The bot must be registered before this fragment runs.`);
  }

  const surfaceFilter = require('@perception/surface_filter');
  const scan = await surfaceFilter.scan(bot, { type: 'object_group_or_direct', targets: ['logs'] });

  // surface_filter collapses a log scan to one entry per trunk, so this counts trees, not blocks.
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

  // Pushes the preference to peers immediately, so it reaches them before gathering starts.
  guardExternalSync(TAG, 'foreman sendUpdate', () => require('@kernel/foreman_link').sendUpdate());

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
