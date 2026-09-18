// module: target_claims
// purpose: THE ONE WALK a body uses to take a world target no peer is working — claim it, reach it, and
//          hand it back if it cannot be reached. Trees, stone columns and grass tufts all go through here.
//
// ── WHY ONE WALK (Architect 2026-09-15) ────────────────────────────────────────────────────────────────
// *"every block a bot is moving to dig or place. that voxel is claimed the moment it picks it. every bot
// before they decide to move to a location to dig or place something checks the shared claim spot... there
// should be one for making a shaft to extract stone, one for trees and one for grass punching. so now theres
// 3, the method should be extracted to a utility."* The tree feller and the stone prospect each carried the
// same loop by hand — skip what this trip already spent, claim, walk, release on a failed walk, stop after
// so many failures — and grass had none, so two bots punched the same patch. Three copies of one loop drift
// apart at the first edit to any of them (Law 16).
//
// ── WHERE A CLAIM LIVES: THE FOREMAN, NOT A CHAIR ────────────────────────────────────────────────────────
// A claim must be answered by ONE party, one request at a time, or two bots asking in the same instant are
// both told yes. The foreman is that party (foreman_brain SECTION 1 decides each request synchronously).
// Corporate HQ is a file per bot with no lock, so a claim table there could double-grant (Architect's choice,
// 2026-09-15: the foreman). The key's prefix names the kind of target and must be on the foreman's
// OBJECT_KEY_PREFIXES whitelist — an unlisted prefix is refused as a coding violation, never as a peer.
//
// ── THE CONTRACT ──────────────────────────────────────────────────────────────────────────────────────
// claimFirst(candidates, { keyOf, skip?, approach?, maxUnreachable? })
//   candidates      ranked best-first by the caller; this walk never re-orders them.
//   keyOf(c)        the claim key, e.g. `tree:x,y,z`.
//   skip(c, key)    true for a target this trip already proved unworkable — skipped BEFORE the claim, so a
//                   peer whose approach might succeed is not locked out by this body's failure.
//   approach(c)     async → { ok, reason? }. Omit when the target is already in reach (a grass tuft): the
//                   first granted claim is the pick.
//   maxUnreachable  stop after this many claimed-but-unreached targets, so a boxed body does not churn the list.
// Returns { pick, key, peerHeld, peerHeldKeys, skipped, unreachable, failures } — `failures` counts each approach
// reason; `peerHeldKeys` lets a caller that re-walks the same neighbourhood skip what a peer is already working.
// The winner's claim is HELD on return; the caller releases it when the work on it ends (Law 8: whoever
// raised the lifecycle ends it). A killed signal skips that release, which foreman_link.releaseAllClaims
// sweeps when the magnet clears.

'use strict';

async function claimFirst(candidates, opts) {
  const { keyOf, skip = null, approach = null, maxUnreachable = Infinity } = opts || {};
  if (typeof keyOf !== 'function') {
    throw new Error('[target_claims] CODING VIOLATION (Law 13): claimFirst needs a keyOf(candidate) that names the claim key.');
  }
  const foremanLink = require('@kernel/foreman_link');
  let skipped = 0, unreachable = 0;
  const failures = {};
  const peerHeldKeys = [];
  const won = (candidate, key) => ({ pick: candidate, key, peerHeld: peerHeldKeys.length, peerHeldKeys, skipped, unreachable, failures });
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    if (skip && skip(candidate, key)) { skipped++; continue; }
    const claim = await foremanLink.requestClaim(key);
    if (!claim || !claim.granted) { peerHeldKeys.push(key); continue; }
    if (!approach) return won(candidate, key);
    const reached = await approach(candidate);
    if (reached && reached.ok) return won(candidate, key);
    // Claimed but not reached: free it now, so a peer standing nearer can take it. Holding it to the end of the
    // trip would make one body's bad route another body's outage.
    foremanLink.releaseClaim(key);
    unreachable++;
    const why = (reached && reached.reason) || 'unreachable';
    failures[why] = (failures[why] || 0) + 1;
    if (unreachable >= maxUnreachable) break;
  }
  return { pick: null, key: null, peerHeld: peerHeldKeys.length, peerHeldKeys, skipped, unreachable, failures };
}

// Release a claim this body holds. One door beside the walk that took it, so a caller never reaches past this
// module into foreman_link for half of one lifecycle.
function releaseTarget(key) {
  if (key) require('@kernel/foreman_link').releaseClaim(key);
}

module.exports = { claimFirst, releaseTarget };
