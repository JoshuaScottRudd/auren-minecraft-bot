'use strict';
// request_ledger — WHAT A HUMAN HAS ASKED THIS CREW FOR, and how far it is from done.
//
// ── A REQUEST IS A STOCK ROW, NOT A JOB ──────────────────────────────────────────────────────────
// Nothing here queues, dispatches, or orders anything. A request raises a NUMBER that the supply
// assessor already measures against; the work that closes the gap is chosen by each crew's own planner
// from its own sensing, exactly as it is for a shortfall the fleet noticed by itself. That is why one
// human verb can cover gathering, crafting and building: the ledger states a requirement, and how deep
// the decomposition runs to satisfy it is the machine's business.
//
// Building a queue here instead would put a second planner outside the bots' loops — two decision-makers
// in one scope (Law 4), and a gap no single judge can see across.
//
// ── THE TARGET IS ABSOLUTE, NEVER CUMULATIVE ─────────────────────────────────────────────────────
// Saying "request 20 logs" twice asks for twenty, not forty. A requirement is a level to reach, so a
// repeat is a restatement of the same want — and a person who repeats themselves after chat lag, or
// because they were unsure the first line landed, must not silently buy double the work. "How far from
// done" also only means something against a fixed target; against a running total it can never be
// answered. Wanting more is said by naming the larger number.
//
// ── A MET REQUEST STAYS ON THE LEDGER ────────────────────────────────────────────────────────────
// It is marked met and remains until cancelled or restated. A row that deleted itself on completion
// would be indistinguishable from a row that was never accepted — the human would be unable to tell
// success from a dropped message, which is the one thing a status command exists to settle (Law 25:
// the signal has to carry the true outcome, and silence carries nothing).
//
// ── OWNER-STAMPED, LIKE EVERY OTHER SHELF ────────────────────────────────────────────────────────
// Rows are keyed by owner-then-item, so one crew's requirements are unreadable to another by the same
// mechanism their chests are: a bot can only form its own key (see station_registry.stationKey). The
// overseer keeps one ledger; a crew narrows it to its own.
// LAZY, unlike the two below it, and the asymmetry is the point. This module serves two processes: a bot,
// which owns a corporate_headquarters, and the OVERSEER, which must never acquire one — it has no BOT_ID,
// so the file it opened would carry a name no bot answers to and no reader could explain (Invariant D,
// Law 6). The overseer uses only the pure rules; requiring the HQ at load would hand it the one dependency
// its whole design excludes, just by loading the file. Required inside the storage wrapper instead, which
// no overseer path reaches. The normaliser and the catalogue stay at load because the PURE rules use them:
// they are part of what a request IS, not part of where one is kept.
const { normalizeItemName } = require('@utils/fragment_utils');
const { isRequestable } = require('@kernel/requestable_catalogue');

const ROOM = 'requests_confrence_room';
const CHAIR = 'standing';

// The ledger is one flag holding `{ "<owner>|<item>": row }`. Flat rather than nested per owner because
// the overseer's merge works on flat id→entry maps and a nested shape would need its own merge (Law 16).
function rowKey(ownerKey, item) { return `${ownerKey}|${normalizeItemName(item)}`; }

// WHOSE ROWS THESE ARE. A bot derives it from its own mandate and can form no other; the OVERSEER
// passes it explicitly, because it is not a bot, has no mandate, and is the one process that must write
// on behalf of whichever human spoke (§8.3 — the overseer owns the fact, the bot owns whether it cares).
// One implementation with the key as a parameter rather than two copies of the rules (Law 16).
function _ownerKey(explicit) {
  if (explicit) return explicit;
  return require('@kernel/bot_mandate').stationOwnerKey();
}
function _hq() { return require('@kernel/corporate_headquarters'); }
function _all() { return _hq().readConfRoomFlag(ROOM, CHAIR, {}) || {}; }
function _write(rows) { _hq().writeConfRoomFlag(ROOM, CHAIR, rows); }

// post(item, quantity, asker) → { ok, row } | { ok:false, reason, blockedBy? }
//
// THE CATALOGUE GATES THE WRITE, NOT THE READ. An unrequestable item is refused here, at the moment a
// person says it, while they are still present to be told why — rather than accepted and discovered
// later by a crew that cannot act on it. The refusal carries the leaf that stopped the walk, because
// "no" teaches nothing and "the walk stopped at string" teaches the whole family above it (Law 24).
// ── THE RULES ARE PURE; THE STORAGE IS A WRAPPER ─────────────────────────────────────────────────
// applyPost/applyCancel/rowsFor take a rows object and return one. They touch no disk and require no
// mandate, which is what lets TWO processes of different kinds share one implementation of the rules:
// a BOT keeps its rows in corporate_headquarters, and the OVERSEER keeps them in memory beside its
// station map — it has no HQ of its own and must not acquire one, because a second HQ writer with no
// BOT_ID would author a file no bot reads and no name explains (Invariant D, Law 6).
//
// The alternative was the overseer restating the rules over its own map, which is the parallel route
// that drifts (Law 16): the desk would come to disagree with the crews about what "asking twice" means,
// and nothing would report it.
function applyPost(rows, item, quantity, asker, ownerKey) {
  const name = normalizeItemName(item);
  if (!Number.isFinite(quantity) || quantity <= 0 || Math.floor(quantity) !== quantity) {
    return { ok: false, reason: 'quantity must be a whole number above zero' };
  }
  const legal = isRequestable(name);
  // `askInstead` travels with the refusal for the same reason `blockedBy` does: a caller rendering this
  // needs to tell "the fleet has no route to it" from "right material, wrong grain — say `logs`".
  if (!legal.ok) {
    return { ok: false, reason: 'not_requestable', blockedBy: legal.blockedBy, askInstead: legal.askInstead };
  }

  const owner = ownerKey;
  const key = rowKey(owner, name);
  // Absolute: the previous target is REPLACED. `first_asked_at` survives so a restated request keeps its
  // age — the human's want did not begin again just because they said it twice.
  const previous = rows[key];
  rows[key] = {
    item: name,
    quantity,
    owner,
    asker: asker || null,
    first_asked_at: (previous && previous.first_asked_at) || Date.now(),
    updated_at: Date.now(),
  };
  return { ok: true, rows, row: rows[key], replaced: previous ? previous.quantity : null };
}

function applyCancel(rows, item, ownerKey) {
  const wanted = item && item !== 'all' ? normalizeItemName(item) : null;
  let removed = 0;
  for (const [key, row] of Object.entries(rows)) {
    if (!row || row.owner !== ownerKey) continue;
    if (wanted && row.item !== wanted) continue;
    delete rows[key];
    removed++;
  }
  return { rows, removed };
}

function rowsFor(rows, ownerKey) {
  return Object.values(rows || {})
    .filter(row => row && row.owner === ownerKey)
    .sort((a, b) => (a.first_asked_at || 0) - (b.first_asked_at || 0));
}

// ── THE STORAGE SIDE — a bot's view, backed by corporate_headquarters ────────────────────────────
function post(item, quantity, asker, ownerKey) {
  const result = applyPost(_all(), item, quantity, asker, _ownerKey(ownerKey));
  if (result.ok) _write(result.rows);
  return result;
}

// cancel(item) → how many rows went. `null`/'all' clears every row this crew owns.
//
// Cancel is scoped to the caller's own key for the same reason reads are: the key is the only one this
// process can form, so cancelling another crew's requirement is not refused, it is unexpressible.
function cancel(item, ownerKey) {
  const { rows, removed } = applyCancel(_all(), item, _ownerKey(ownerKey));
  if (removed > 0) _write(rows);
  return removed;
}

// outstanding() → this crew's rows, oldest first. Contents are NOT read here and no row carries a
// "have" figure: how much is on hand is a fact about the world, read at the moment it is reported
// (Invariant B). A stored progress number would be the stale answer this whole design removed.
function outstanding(ownerKey) { return rowsFor(_all(), _ownerKey(ownerKey)); }

// status(haveOf) → [{ item, asked, have, met }], measured NOW against a caller-supplied count.
//
// THE COUNT IS PASSED IN RATHER THAN FETCHED, which is what keeps this file honest about its own
// category. The ledger knows what was wanted; only a reader of the world knows what is there, and that
// read costs a round trip the ledger has no business deciding to spend. The caller that is about to
// speak to a human pays for it at the moment it speaks (Law 26 — the ledger states, the world is
// sensed, and the join happens where someone is accountable for the answer).
function status(haveOf) {
  if (typeof haveOf !== 'function') {
    throw new Error('[request_ledger] CODING VIOLATION (Law 13): status() needs a haveOf(item) reader. '
      + 'A stored progress figure would be a remembered count of a world that moved (Invariant B).');
  }
  return outstanding().map(row => {
    const have = haveOf(row.item);
    const held = Number.isFinite(have) ? have : 0;
    return { item: row.item, asked: row.quantity, have: held, met: held >= row.quantity, asker: row.asker };
  });
}

// allRows() → the whole ledger, every owner. FOR THE OVERSEER ONLY, which is the one party entitled to
// see across crews because it is the one that must broadcast to all of them. A bot has no use for this
// and no reason to call it: its own rows come from outstanding(), narrowed by the only key it can form.
function allRows() { return _all(); }

// mergeBroadcast(rows) → adopt the overseer's ledger wholesale. Not a merge in the station sense: the
// overseer is the SOLE author of requests, so a bot's copy is a mirror rather than a contribution, and
// reconciling it against local state would be inventing a second author (Invariant D). Every broadcast
// restates the whole truth, so a missed one self-heals on the next.
function mergeBroadcast(rows) {
  if (!rows || typeof rows !== 'object') return;
  _write(rows);
}

module.exports = {
  applyPost, applyCancel, rowsFor,                 // pure rules — the overseer's side
  post, cancel, outstanding, status, allRows, mergeBroadcast,   // HQ-backed — a bot's side
  rowKey, ROOM, CHAIR,
};
