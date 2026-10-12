// module: target_claims
// purpose: the one walk a body uses to take a world target no peer is working — claim it, reach it, and
//          hand it back if it cannot be reached. Trees, stone columns and grass tufts all go through here.
//
// A claim is answered by one party, one request at a time, so two bots asking in the same instant are
// never both told yes. The foreman is that party (foreman_brain SECTION 1 decides each request
// synchronously); a claim table kept per-bot on corporate HQ, with no lock, could double-grant. The key's
// prefix names the kind of target and must be on the foreman's OBJECT_KEY_PREFIXES whitelist — an
// unlisted prefix is refused as a coding violation, never as a peer.
//
// ── THE CONTRACT ──────────────────────────────────────────────────────────────────────────────────────
// claimFirst(candidates, { keyOf, skip?, approach?, maxUnreachable? })
//   candidates      ranked best-first by the caller; this walk never re-orders them.
//   keyOf(c)        the claim key, e.g. `tree:x,y,z`.
//   skip(c, key)    true for a target this trip already proved unworkable — skipped before the claim, so a
//                   peer whose approach might succeed is not locked out by this body's failure.
//   approach(c)     async → { ok, reason? }. Omit when the target is already in reach (a grass tuft): the
//                   first granted claim is the pick.
//   maxUnreachable  stop after this many claimed-but-unreached targets, so a boxed body does not churn the list.
//   costless(reason) true for a rejection decided without spending anything — it still counts in `failures`,
//                   but it does not draw on the budget above. Omit and every failure draws, which is what
//                   every caller that names no predicate keeps.
//
// `maxUnreachable` bounds the cost of a body walking at target after target and arriving at none. A
// rejection decided from blocks already in memory, with no route search and no step taken, costs nothing
// to reach; charging it to the same budget would stop the walk before the expensive thing it guards
// against has happened, leaving a caller's verdict resting on only a small prefix of a long list (Law 25).
//
// Returns { pick, key, peerHeld, peerHeldKeys, skipped, unreachable, failures } — `failures` counts each approach
// reason; `peerHeldKeys` lets a caller that re-walks the same neighbourhood skip what a peer is already working.
// The winner's claim is held on return; the caller releases it when the work on it ends (Law 8: whoever
// raised the lifecycle ends it). A killed signal skips that release, which foreman_link.releaseAllClaims
// sweeps when the magnet clears.

'use strict';

// ── A TARGET WITH A FOOTPRINT: ALL OF IT, OR NONE OF IT ─────────────────────────────────
//
// Some world objects are exclusive over ground, not just a block: a shaft pierce claims a 3x3 area with
// the shaft in the middle. A tree is its trunk, and two bots on one trunk collide on one key; a shaft is a
// hole, and two bots one block apart collide on nothing while undermining each other's walls. `footprintOf`
// names the extra cells an object reserves, and the grant is atomic: every key or the candidate is passed
// over. A partial hold leaves the peer blocked and this body still unable to work, so the taken half is
// released before the walk moves on.
//
// The primary key still names the object and is what `key` returns, because that is what a caller
// remembers, skips and reports. `keys` is the whole hold, and it is what gets released.
async function claimFirst(candidates, opts) {
  const { keyOf, footprintOf = null, skip = null, approach = null, maxUnreachable = Infinity, costless = null } = opts || {};
  if (typeof keyOf !== 'function') {
    throw new Error('[target_claims] CODING VIOLATION (Law 13): claimFirst needs a keyOf(candidate) that names the claim key.');
  }
  const foremanLink = require('@kernel/foreman_link');
  let skipped = 0, unreachable = 0;
  const failures = {};
  const peerHeldKeys = [];
  // `examined` is every candidate this walk actually put a question to, letting the caller report how much
  // of the list it got through (Law 25). `spent` is the part of that which drew on the budget.
  let examined = 0, spent = 0;
  const won = (candidate, key, keys) => ({ pick: candidate, key, keys, peerHeld: peerHeldKeys.length, peerHeldKeys, skipped, unreachable, examined, spent, failures });
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    if (skip && skip(candidate, key)) { skipped++; continue; }
    examined++;
    // The object first, then its footprint. Order matters only for readability — the grant is all-or-nothing
    // either way — but taking the named cell first means a log of held keys reads centre-out.
    const wanted = [key, ...(footprintOf ? footprintOf(candidate).filter(k => k !== key) : [])];
    const held = [];
    for (const k of wanted) {
      const c = await foremanLink.requestClaim(k);
      if (c && c.granted) { held.push(k); continue; }
      for (const back of held) foremanLink.releaseClaim(back);   // atomic: no half-held footprint
      held.length = 0;
      break;
    }
    if (!held.length) { peerHeldKeys.push(key); continue; }
    if (!approach) return won(candidate, key, held);
    const reached = await approach(candidate);
    if (reached && reached.ok) return won(candidate, key, held);
    // Claimed but not reached: free it now, so a peer standing nearer can take it. Holding it to the end of the
    // trip would make one body's bad route another body's outage.
    for (const k of held) foremanLink.releaseClaim(k);
    unreachable++;
    const why = (reached && reached.reason) || 'unreachable';
    failures[why] = (failures[why] || 0) + 1;
    if (costless && costless(why)) continue;
    spent++;
    if (spent >= maxUnreachable) break;
  }
  return { pick: null, key: null, keys: [], peerHeld: peerHeldKeys.length, peerHeldKeys, skipped, unreachable, examined, spent, failures };
}

// Releases a claim this body holds — one door beside the walk that took it, so a caller never reaches
// past this module into foreman_link for half of one lifecycle.
//
// Takes the whole hold or one key: `claimFirst` hands back `keys` for an object with a footprint and
// `key` for the object itself, and releasing only the name a caller remembers would strand the rest
// (Law 8: whoever raised the lifecycle ends all of it).
function releaseTarget(key) {
  if (!key) return;
  const link = require('@kernel/foreman_link');
  for (const k of (Array.isArray(key) ? key : [key])) { if (k) link.releaseClaim(k); }
}

module.exports = { claimFirst, releaseTarget };
