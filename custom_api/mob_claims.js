// api: mob_claims
// purpose: One body fights a mob. A body that takes a mob as its held target claims it on the combat road
//          (combat_board). Every other body leaves a claimed mob out of its fight: the commander does not admit it
//          (owners), so it is neither engaged, faced nor struck. A squad body's claim on a melee mob holds that mob's
//          whole blob.
//
// A CLAIM IS A LEASE: a peer that stops renewing loses it (combat_board.LEASE_MS). A body running from a fight drops its
// claim (battle_stations), so the mobs it held are free to the next body at once.
//
// TWO CLAIMS ON ONE MOB: both bodies may take it inside the road's latency. The earlier claim wins, a tie goes to
// the lower bot id, and both bodies read the same answer. The loser leaves the mob (battle_stations, `yielded`) and
// does not take it again while the winner's claim stands.

'use strict';

const combatBoard = require('@api/combat_board');

function _botId() { return process.env.BOT_ID || 'default'; }

// beats(a, b) → whether claim a outranks claim b on the same mob: earlier first, then the lower bot id.
function beats(a, b) {
  if (a.at !== b.at) return a.at < b.at;
  return a.botId < b.botId;
}

const _holds = (c, id) => c.id === id || (c.blob || []).includes(id);

// claim(mobId) — claim `mobId`, replacing any claim this body held. A mob inside the blob it already holds keeps the
// claim's age, so moving within a blob does not lose the blob to a later claim.
function claim(mobId) {
  const mine = combatBoard.claim();
  if (mine && _holds(mine, mobId)) { if (mine.id !== mobId) combatBoard.setClaim({ ...mine, id: mobId }); return; }
  combatBoard.setClaim({ id: mobId, at: Date.now(), blob: [mobId] });
}

// setBlob(ids) — the mobs this body's claim holds, re-read each sweep as the blob moves.
function setBlob(ids) {
  const mine = combatBoard.claim();
  if (mine) combatBoard.setClaim({ ...mine, blob: ids });
}

function release() { combatBoard.setClaim(null); }

// owners() → Map mobId → peer bot id, for every mob a peer's live claim holds against this body: a peer claim on
// a mob this body has not claimed, or one that beats this body's own claim on it.
function owners() {
  const raw = combatBoard.claim();
  const mine = raw ? { ...raw, botId: _botId() } : null;
  const best = new Map();
  for (const c of combatBoard.liveClaims()) {
    for (const id of new Set([c.id, ...(c.blob || [])])) {
      const held = best.get(id);
      if (!held || beats(c, held)) best.set(id, c);
    }
  }
  const out = new Map();
  for (const [id, c] of best) {
    if (mine && _holds(mine, id) && beats(mine, c)) continue;
    out.set(id, c.botId);
  }
  return out;
}

// ownerOf(mobId) → the peer bot id whose claim holds `mobId` against this body, or null.
function ownerOf(mobId) { return owners().get(mobId) || null; }

module.exports = { claim, setBlob, release, owners, ownerOf, beats };
