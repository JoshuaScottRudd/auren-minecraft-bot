// overseer/overseer_brain.js
// Claim arbiter — the overseer's only decision-making role. Everything else the
// overseer does is pure relay (Law 3); arbitration is the sanctioned exception:
// it orders ACCESS to things, it never decides WHAT a bot should do.
//
// ── The de-confliction taxonomy (canonical — all site comments point here) ──
//
//   MAGNET (not this file — dispatcher.js writes it, boardroom chair carries it):
//     A soft, ADVISORY marker of "which job I am doing". Eventually consistent —
//     broadcast through the overseer, so a peer's view can lag. It de-conflicts
//     JOB IDENTITY only, and only reliably because the planning token (below)
//     guarantees no two bots ever plan against a stale peer view.
//
//   ARBITER (this file): a hard, ATOMIC grant of exclusive hold on a named
//   resource. Exactly one holder, synchronous decision. Two flavors:
//     (a) PHYSICAL WORLD OBJECT — 'tree:…', 'cell:…', 'anchor:…'. Chosen from
//         live perception at EXECUTION time, after the planning token has been
//         released, so the token cannot cover them. Both bots SHOULD run the
//         same job type; they must not touch the same block. The key names a
//         block, but what it EXCLUDES is per-prefix: 'cell:'/'anchor:' exclude
//         that block, 'tree:' excludes a 5x5 column around it at every height
//         (see TREE_FOOTPRINT_RADIUS — a felling bot occupies more than the
//         one voxel it named, so a block-exact hold does not de-conflict it).
//     (b) CRITICAL SECTION — the planning token. Not a task, not a location: a
//         mutex on the plan PHASE (job_board sweep → dispatcher magnet claim →
//         HQ sync). One bot plans at a time, so every planner sees every peer's
//         fresh magnet and flavor-(a)-free jobs dedup cleanly.
//   A task identity must never be modeled as an arbiter key (the retired
//   'buildspot:' prefix made that mistake) — tasks belong to the magnet.
//
// Grants are first-in; a same-bot re-request renews (heartbeat). TTL expiry is
// crash discipline (Law 13: default = available — a dead holder's claim decays
// instead of freezing the resource forever).

'use strict';

// Pure data, no aliases — safe to require in both the bot and overseer processes.
const { BOT_SENIORITY } = require('../Thinking_fragments/architect_config');

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Object claims (arbiter flavor a: physical-world exclusivity)
// Key format is owned by the claimant (executor); the arbiter only needs the
// prefix to know the key names a world object.
// ─────────────────────────────────────────────────────────────────────────────

// EVERY CLAIMANT'S NAMESPACE MUST BE LISTED HERE, and the list is a whitelist on purpose: an
// unrecognized key is a claimant-side coding violation and is rejected loudly rather than guessed at,
// because two bots spelling one object two ways would both be granted and the exclusivity would be
// silently gone. The cost is that a NEW claimant whose prefix is missing is refused every time — its
// object is permanently unclaimable, which reads at the executor as "a peer holds every candidate" and
// ends as a concede-reclaim loop nobody can diagnose from the executor's own line. That is why the
// rejection now carries `fault: 'claimant'` and overseer_link throws on it: the refusal must arrive as
// the coding violation it is, not as a world condition (Law 13).
// 'stone_column:' — stone_prospect_executor, one key per surface column it opens.
const OBJECT_KEY_PREFIXES = ['anchor:', 'tree:', 'cell:', 'stone_column:'];
const TREE_KEY_PREFIX = 'tree:';

// Object claims: object key → { bot_id, claimed_at, footprint }
// footprint is { x, z } for tree keys (see below) and null for every other key.
const _objectClaims = new Map();

const STALE_CLAIM_MS = 5 * 60 * 1000;

// ── A tree claim excludes a COLUMN, not a block (Invariant A: one occupant per scope) ──
// A tree key names one base block, but the scope a feller actually occupies is the column
// around that base: it stands on a skirt cell beside the trunk, pillars up through that cell,
// and mines the base out from under the logs above. Block-exact exclusivity leaves three holes
// a peer walks straight through, and all three widen as the fleet grows:
//   1. ONE TREE, SEVERAL BASES — the tree scan collapses logs per XZ COLUMN and keeps every
//      column bottoming out on solid ground, so a multi-column trunk yields more than one base
//      coordinate. A different coordinate is a different key, hence a second grant on one tree.
//   2. THE PILLAR READS AS A TREE — pillaring stock is timber-first, so a climbing feller leaves
//      a log column standing on solid ground, which the scan cannot tell from a trunk. A peer
//      claims it and mines the scaffold out from under the climber.
//   3. Y DRIFT — clearing the lower logs re-exposes the residual trunk as a fresh base at a
//      higher y, which is again a key nobody holds.
// Comparing X/Z only, at Chebyshev radius 2, closes all three: a 5x5 footprint unbounded in Y,
// so no coordinate anywhere in that column can be granted to a second bot while the feller works.
// Scoped to tree keys alone — 'cell:' and 'anchor:' name blocks peers work beside without
// interference, and a blanket radius would freeze mining cells against a fault never seen there.
const TREE_FOOTPRINT_RADIUS = 2;

function isObjectKey(key) {
  return typeof key === 'string' && OBJECT_KEY_PREFIXES.some(p => key.startsWith(p));
}

// { x, z } of a tree key's base, or null if the key is malformed. Y is parsed only to validate
// the form; the footprint ignores height entirely.
function parseTreeFootprint(key) {
  const parts = key.slice(TREE_KEY_PREFIX.length).split(',');
  if (parts.length !== 3) return null;
  const [x, y, z] = parts.map(Number);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, z };
}

// The peer whose tree column contains this base, or null if the footprint is free. Stale holds
// are skipped on the same TTL as an exact key, so a dead feller's column decays instead of
// freezing a 5x5 of forest for good (Law 13: default = available).
function treeFootprintHolder(botId, footprint) {
  const now = Date.now();
  for (const claim of _objectClaims.values()) {
    if (!claim.footprint || claim.bot_id === botId) continue;
    if (now - claim.claimed_at > STALE_CLAIM_MS) continue;
    const spread = Math.max(
      Math.abs(claim.footprint.x - footprint.x),
      Math.abs(claim.footprint.z - footprint.z)
    );
    if (spread <= TREE_FOOTPRINT_RADIUS) return claim.bot_id;
  }
  return null;
}

function handleClaimRequest(botId, key) {
  if (!isObjectKey(key)) {
    // Law 13: an unrecognized key is a coding violation on the claimant's side —
    // reject loudly, never guess a category for it.
    log(`Claim rejected for '${botId}': unknown key '${key}' (object keys start with ${OBJECT_KEY_PREFIXES.join(' / ')}).`);
    return { granted: false, fault: 'claimant', reason: `unknown claim key '${key}'` };
  }

  // A tree key is admitted by FOOTPRINT; every other prefix stays exact-block. The exact-key
  // test below still runs for trees but can no longer reject one — a peer holding the same
  // coordinate is spread 0, so the column test above it answers first.
  let footprint = null;
  if (key.startsWith(TREE_KEY_PREFIX)) {
    footprint = parseTreeFootprint(key);
    if (!footprint) {
      // Same class as an unknown prefix: a claimant-side coding violation, rejected loudly
      // rather than guessed at (Law 13).
      log(`Claim rejected for '${botId}': malformed tree key '${key}' (expected 'tree:x,y,z').`);
      return { granted: false, fault: 'claimant', reason: `malformed tree key '${key}'` };
    }
    const columnHolder = treeFootprintHolder(botId, footprint);
    if (columnHolder) {
      log(`Tree claim rejected for '${botId}': '${key}' falls inside the column held by '${columnHolder}'.`);
      return { granted: false, reason: `'${key}' inside tree column held by '${columnHolder}'` };
    }
  }

  const current = _objectClaims.get(key);

  if (current && current.bot_id !== botId && Date.now() - current.claimed_at <= STALE_CLAIM_MS) {
    log(`Object claim rejected for '${botId}': '${key}' held by '${current.bot_id}'.`);
    return { granted: false, reason: `'${key}' held by '${current.bot_id}'` };
  }

  // Only a stale-expiry is logged: it means a holder crashed/leaked without releasing, which is
  // worth knowing. Routine grant/renew are silent — the tree-reachability sweep claims-then-releases
  // every candidate, so per-claim logging floods the console (Law 5 noise). Denials still log above.
  if (current && current.bot_id !== botId) {
    log(`Stale object claim on '${key}' by '${current.bot_id}' expired — granting to '${botId}'.`);
  }
  _objectClaims.set(key, { bot_id: botId, claimed_at: Date.now(), footprint });
  return { granted: true };
}

function handleClaimRelease(botId, key) {
  const current = _objectClaims.get(key);
  if (current && current.bot_id === botId) {
    _objectClaims.delete(key);   // routine release — silent (see handleClaimRequest)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Planning token (arbiter flavor b: plan-phase mutex)
// Queue-don't-reject: a losing claimant PARKS until the holder releases, then
// is granted automatically. Waiters are promoted seniority-first (the elder bot
// plans first when several wait), FIFO among equals. The TTL is deliberately
// short — a plan phase is ~100ms of work; 2s of silence means the holder died
// mid-plan and the fleet must not wait the 5-minute object TTL to think again.
// ─────────────────────────────────────────────────────────────────────────────

const PLANNING_TTL_MS = 2000;

let _planningHolder = null;        // { bot_id, granted_at } | null
const _planningQueue = [];         // bot_ids parked waiting for the token
let _onPlanningGrant = null;       // transport callback — the ONE grant pathway (Law 16)
let _ttlSweepTimer = null;

// The server registers how a grant reaches a bot. Every grant — immediate,
// on-release promotion, or TTL-expiry promotion — flows through this single
// callback so there is exactly one notification pathway (Law 16).
function onPlanningGrant(callback) {
  _onPlanningGrant = callback;
}

function _rank(botId) {
  const r = BOT_SENIORITY[botId];
  return typeof r === 'number' ? r : Infinity;
}

function _grantPlanning(botId) {
  _planningHolder = { bot_id: botId, granted_at: Date.now() };
  log(`Planning token granted to '${botId}'.`);
  if (_onPlanningGrant) _onPlanningGrant(botId);
}

function _promoteNextWaiter() {
  if (_planningQueue.length === 0) return;
  let bestIdx = 0;
  for (let i = 1; i < _planningQueue.length; i++) {
    if (_rank(_planningQueue[i]) < _rank(_planningQueue[bestIdx])) bestIdx = i;
  }
  const next = _planningQueue.splice(bestIdx, 1)[0];
  _grantPlanning(next);
}

function _expireStaleHolder() {
  if (_planningHolder && Date.now() - _planningHolder.granted_at > PLANNING_TTL_MS) {
    log(`Planning token held by '${_planningHolder.bot_id}' went stale (> ${PLANNING_TTL_MS}ms) — freeing.`);
    _planningHolder = null;
  }
}

// Waiters must not depend on the dead holder ever sending another message, so
// while anyone is parked a short sweep expires stale holders and promotes.
// Created lazily (no load-time side effects — preflight requires this
// module cold) and torn down as soon as the queue drains.
function _ensureTtlSweep() {
  if (_ttlSweepTimer) return;
  _ttlSweepTimer = setInterval(() => {
    _expireStaleHolder();
    if (!_planningHolder) _promoteNextWaiter();
    if (_planningQueue.length === 0) {
      clearInterval(_ttlSweepTimer);
      _ttlSweepTimer = null;
    }
  }, 250);
  if (_ttlSweepTimer.unref) _ttlSweepTimer.unref();
}

// Grants are delivered ONLY via the onPlanningGrant callback — this function
// intentionally returns nothing the transport should act on. A re-request from
// the current holder is a renewal heartbeat (no re-grant message needed).
function requestPlanningToken(botId) {
  _expireStaleHolder();

  if (_planningHolder && _planningHolder.bot_id === botId) {
    _planningHolder.granted_at = Date.now();
    return;
  }

  if (!_planningHolder && _planningQueue.length === 0) {
    _grantPlanning(botId);
    return;
  }

  if (!_planningQueue.includes(botId)) {
    _planningQueue.push(botId);
    log(`'${botId}' queued for planning token (${_planningQueue.length} waiting).`);
  }
  // Token free but a queue exists (holder just expired): promote by the same
  // seniority rule instead of letting the newcomer jump the line.
  if (!_planningHolder) _promoteNextWaiter();
  _ensureTtlSweep();
}

function releasePlanningToken(botId) {
  if (!_planningHolder || _planningHolder.bot_id !== botId) return;
  _planningHolder = null;
  log(`Bot '${botId}' released planning token.`);
  _promoteNextWaiter();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Disconnect cleanup
// A dead bot must free everything it holds AND leave any wait line, or the
// queue stalls behind a ghost (Law 13: default = available).
// ─────────────────────────────────────────────────────────────────────────────

function releaseForBot(botId) {
  for (const [key, claim] of _objectClaims) {
    if (claim.bot_id === botId) {
      _objectClaims.delete(key);
      log(`Released object '${key}' from disconnected bot '${botId}'.`);
    }
  }

  const qIdx = _planningQueue.indexOf(botId);
  if (qIdx >= 0) {
    _planningQueue.splice(qIdx, 1);
    log(`Removed disconnected bot '${botId}' from planning queue.`);
  }
  if (_planningHolder && _planningHolder.bot_id === botId) {
    _planningHolder = null;
    log(`Freed planning token from disconnected bot '${botId}'.`);
    _promoteNextWaiter();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Logging
// ─────────────────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [OVERSEER_BRAIN] ${msg}`);
}

module.exports = {
  handleClaimRequest,
  handleClaimRelease,
  requestPlanningToken,
  releasePlanningToken,
  onPlanningGrant,
  releaseForBot,
};
