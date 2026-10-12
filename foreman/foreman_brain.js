// foreman/foreman_brain.js
// Claim arbiter — the foreman's only decision-making role. Everything else the
// foreman does is pure relay (Law 3); arbitration is the sanctioned exception:
// it orders ACCESS to things, it never decides WHAT a bot should do.
//
// ── The de-confliction taxonomy (canonical — all site comments point here) ──
//
//   MAGNET (not this file — dispatcher.js writes it, boardroom chair carries it):
//     A soft, ADVISORY marker of "which job I am doing". Eventually consistent —
//     broadcast through the foreman, so a peer's view can lag. It de-conflicts
//     JOB IDENTITY only, and only reliably because the planning token (below)
//     guarantees no two bots ever plan against a stale peer view.
//
//   ARBITER (this file): a hard, ATOMIC grant of exclusive hold on a named
//   resource. Exactly one holder, synchronous decision. Two flavors:
//     (a) PHYSICAL WORLD OBJECT — 'tree:…', 'cell:…', 'anchor:…'. Chosen from
//         live perception at EXECUTION time, after the planning token has been
//         released, so the token cannot cover them. Both bots may run the
//         same job type; they must not touch the same block. The key names a
//         block, but what it EXCLUDES is per-prefix: 'cell:'/'anchor:' exclude
//         that block, 'tree:' excludes a 5x5 column around it at every height
//         (see @utils/tree_footprint — a felling bot occupies more than the
//         one voxel it named, so a block-exact hold does not de-conflict it).
//     (b) CRITICAL SECTION — one token for planning and temporary computation.
//         The plan phase covers job_board sweep → dispatcher magnet claim → HQ
//         sync; execution searches borrow that same gate. Planners see fresh peer
//         magnets one at a time, while the machine's free memory decides how many
//         heavy owned workspaces are inside together (Section 2).
//   A task identity must never be modeled as an arbiter key — tasks belong to the magnet.
//
// Object grants are first-in, and an object claim left by a body that never released it decays
// (STALE_CLAIM_MS). The shared gate closes on release, canceled request or loss of its holder;
// timeout_crash watches its active entry against the unchanged benchmark (Section 2).

'use strict';

// Pure data, no aliases — safe to require in both the bot and foreman processes.

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Object claims (arbiter flavor a: physical-world exclusivity)
// Key format is owned by the claimant (executor); the arbiter only needs the
// prefix to know the key names a world object.
// ─────────────────────────────────────────────────────────────────────────────

// EVERY CLAIMANT'S NAMESPACE MUST BE LISTED HERE, and the list is a whitelist: an unrecognized key is a
// claimant-side coding violation and is rejected loudly, because two bots spelling one object two ways
// would both be granted and the exclusivity would be silently gone. A claimant whose prefix is missing is
// refused every time, so its object reads at the executor as held by every peer and drives a
// concede-reclaim loop; the rejection carries `fault: 'claimant'` and foreman_link throws on it, so it
// arrives as the coding violation it is, not as a world condition (Law 13).
// 'stone_column:' — stone_prospect_executor, one key per surface column it opens.
// 'grass:' — seed_picker, one key per tuft, held for a single punch. Exact-block:
// peers punch neighbouring tufts of one patch without interfering, so no footprint.
// tree/stone_column/grass are taken through js_kernel/utils/target_claims, the one claim-reach-release walk.
// 'chest:' — inventory_swapper, one key per storage station id, held for one window, so exactly one body
// has a container open at a time.
// 'prep:' — preconstruction, one key per unit of a crafted block a pledge-approved anchor still needs, so
// each unit is crafted by one body.
// 'dirt:' — harvest_executor, one key per ground tile it shaves, so each patch of ground has one digger.
// 'column:' — build_column_executor, one key per building column, held for one trip up its stand shaft.
// 'line:' — mining_manager, one key per strip tunnel (its origin segment, kind and direction), held for a whole trip
// down it, so one body digs one tunnel and no peer is handed the segment beyond a body still working it.
// 'chest_forgiveness:' — inventory_swapper, one key per storage station id, and the one key that is SPENT
// rather than held (ONCE_KEY_PREFIX below).
// 'bill:' — column_preparation, one key per building, held while one body reads the chests against every
// claim and files its own (chest_ledger), so two bodies never price the same material before either has claimed it.
const OBJECT_KEY_PREFIXES = ['anchor:', 'tree:', 'cell:', 'stone_column:', 'grass:', 'chest:', 'prep:', 'dirt:', 'column:', 'line:', 'bill:', 'chest_forgiveness:'];
// The tree key and its footprint are `@utils/tree_footprint`, which a body choosing a trunk reads too (Law 16).
const { TREE_KEY_PREFIX, parseTreeFootprint, inFootprint } = require('@utils/tree_footprint');

// ── A CHEST IS FORGIVEN ONE MISMATCH PER RUN, AND THIS IS WHERE THE ONE IS COUNTED ─────────────────────
// A run can end while a body has a chest open, so the next run's picture of that chest and the world's
// chest differ. The first body to find a chest that way asks for this key; it is granted once for the
// life of this process, which is one run, and never again to anyone — a release does not give it back.
const ONCE_KEY_PREFIX = 'chest_forgiveness:';
const _spentOnce = new Map();   // key → { bot_id, spent_at }

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
function isObjectKey(key) {
  return typeof key === 'string' && OBJECT_KEY_PREFIXES.some(p => key.startsWith(p));
}

// The peer whose tree column contains this base, or null if the footprint is free. Stale holds
// are skipped on the same TTL as an exact key, so a dead feller's column decays instead of
// freezing a 5x5 of forest for good (Law 13: default = available).
function treeFootprintHolder(botId, footprint) {
  const now = Date.now();
  for (const claim of _objectClaims.values()) {
    if (!claim.footprint || claim.bot_id === botId) continue;
    if (now - claim.claimed_at > STALE_CLAIM_MS) continue;
    if (inFootprint(claim.footprint, footprint)) return claim.bot_id;
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

  if (key.startsWith(ONCE_KEY_PREFIX)) {
    const spent = _spentOnce.get(key);
    if (spent) {
      log(`Once-per-run key rejected for '${botId}': '${key}' was spent by '${spent.bot_id}' ${Date.now() - spent.spent_at} ms ago.`);
      return { granted: false, reason: `'${key}' was already spent this run by '${spent.bot_id}'` };
    }
    _spentOnce.set(key, { bot_id: botId, spent_at: Date.now() });
    log(`ONCE-PER-RUN KEY SPENT: '${key}' granted to '${botId}'. It is not granted again this run.`);
    return { granted: true };
  }

  // A tree key is admitted by FOOTPRINT; every other prefix stays exact-block. The exact-key
  // test below still runs for trees, but the column test above it always answers first for a
  // peer holding the same coordinate, since that coordinate has spread 0.
  let footprint = null;
  if (key.startsWith(TREE_KEY_PREFIX)) {
    footprint = parseTreeFootprint(key);
    if (!footprint) {
      // Same class as an unknown prefix: a claimant-side coding violation, rejected loudly (Law 13).
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
// SECTION 2 — The shared planning/computation gate (arbiter flavor b)
//
// ONE BODY PLANS AT A TIME, AND THE GATE IS WHAT MAKES THAT A FACT. A body enters on an ENTRY TOKEN and
// leaves on an EXIT TOKEN, and the two are one number: the entry the gate issued is the only exit it
// accepts. While a planning entry is open the gate issues no other planning entry, so a second body
// planning has no token to plan on.
//
// HOW MANY BODIES ARE INSIDE AT ONCE IS READ FROM THE MACHINE, EVERY TIME. The first body in always
// enters. A further body enters only while memory_workspace.measureGrant, taken after what the bodies
// inside were granted, still answers a full allowance. A machine with room lets every route search run
// beside the others and beside the one planner; a machine without it holds one body inside at a time,
// planner or searcher. With the workspace off only planning asks, and the planner rule is the whole gate.
//
//   planning_request { phase, requestId } → answered at once with a grant or a place in the line;
//                                          message_schema owns the resource payload fields.
//   planning_release { entry }  → the exit. It closes that entry and the line is served again.
//   planning_cancel { requestId } → abandons that exact queued or just-issued request.
//
// An entry closes on its exit token, matching cancellation, or holder removal
// (releaseForBot, Section 3). Entry numbers rise by one and are never reused.
//
// EVERYTHING ELSE IS AN IMPOSSIBLE STATE AND ENDS THE WHOLE RUN (timeout_crash.crashEverything), with the
// gate's own trail in the report: a request from a body that is inside, a request from a body already
// in the line, an exit from a body that is not inside, an exit carrying another entry's number, a second
// planning entry about to open.
//
// EACH ENTRY HAS ITS OWN CLOCK, timeout_crash's: opened when its body enters, closed when it exits. A body
// inside for timeout_crash.LIMIT_MS is stuck, and the whole run ends with the report.
//
// THE LINE IS SERVED IN THE ORDER IT WAS JOINED. A body waiting on memory holds everyone behind it, so no
// later request takes the room it is waiting for. A planner waiting only on the planner inside is passed
// by route searches, which never waited on a planner before the gate carried them.
// ─────────────────────────────────────────────────────────────────────────────

const timeoutCrash = require('../js_kernel/utils/timeout_crash');
const GATE = 'planning_gate';
const memoryWorkspace = require('../js_kernel/utils/memory_workspace');
const _requestedPhases = new Map();

const _holders = new Map();        // bot_id → the open entry: { bot_id, entry, phase, requestId, workspace, granted_at, watch }
let _entriesIssued = 0;            // the last entry number issued
const _planningQueue = [];         // bot_ids standing in line for an entry
let _onPlanningGrant = null;       // transport callback — the ONE grant pathway (Law 16)
let _onPlanningQueued = null;      // transport callback — the ONE queued-answer pathway

// The server registers how each answer reaches a bot. Every grant — immediate or on-exit promotion —
// flows through the one grant callback, every queued answer through the other (Law 16).
function onPlanningGrant(callback) {
  _onPlanningGrant = callback;
}
function onPlanningQueued(callback) {
  _onPlanningQueued = callback;
}

const _heldMs = (holder) => Date.now() - holder.granted_at;
const _planner = () => [..._holders.values()].find(h => h.phase === 'planning') || null;
// Holders are kept in the order they entered, so the first is the one inside longest.
const _longestInside = () => _holders.values().next().value || null;
const _reservedBytes = () => [..._holders.values()].reduce((sum, h) => sum + (h.workspace ? h.workspace.growthBytes : 0), 0);
const _gateState = () => `inside (${_holders.size}): ${[..._holders.values()].map(h => `'${h.bot_id}' ${h.phase} on entry #${h.entry} for ${_heldMs(h)} ms`).join(', ') || 'nobody'}; `
  + `in line (${_planningQueue.length}): ${_planningQueue.join(', ') || 'nobody'}; last entry issued: #${_entriesIssued}`;

function _said(text) {
  timeoutCrash.note(GATE, text);
  log(text);
}

// What keeps the body at the head of its request out, or the allowance it enters on.
//   { waitsOn: 'planner' } — it asks to plan and a planner is inside.
//   { waitsOn: 'memory' }  — bodies are inside and the machine cannot give one more a full allowance.
//   { workspace }          — it enters; workspace is its allowance, or null with the workspace off.
function _admission(botId) {
  if (_requestedPhases.get(botId).phase === 'planning' && _planner()) return { waitsOn: 'planner' };
  if (!memoryWorkspace.enabled()) return { workspace: null };
  const workspace = memoryWorkspace.measureGrant(_reservedBytes());
  if (_holders.size > 0 && !workspace.full) return { waitsOn: 'memory' };
  return { workspace };
}

// The only place an entry is issued. It reads the gate first: a planning entry issued over an open one
// would be two bodies planning, so that is refused here whatever asked for it.
function _enter(botId, workspace) {
  const request = _requestedPhases.get(botId);
  const phase = request.phase;
  const requestId = request.requestId;
  if (phase === 'planning' && _planner()) {
    timeoutCrash.crashEverything(GATE, `a planning entry was about to be issued to '${botId}' while another is open`, _gateState);
    return;
  }
  const entry = ++_entriesIssued;
  _requestedPhases.delete(botId);
  _holders.set(botId, {
    bot_id: botId, entry, phase, requestId, workspace, granted_at: Date.now(),
    watch: timeoutCrash.watch(GATE, `'${botId}' entered ${phase} on entry #${entry} and has not exited`, _gateState),
  });
  _said(`ENTRY #${entry} issued to '${botId}' for ${phase}, ${_holders.size} inside.`);
  if (workspace) _said(`WORKSPACE #${entry} bot=${botId} phase=${phase} growth_bytes=${workspace.growthBytes} available_bytes=${workspace.availableBytes} cache_cells=${workspace.cacheCells} reserved_bytes=${workspace.reservedBytes}.`);
  if (_onPlanningGrant) _onPlanningGrant(botId, entry, { phase, workspace, requestId });
}

function _closeEntry(botId) {
  _holders.get(botId).watch.done();
  _holders.delete(botId);
}

// Lets in every waiting body the machine and the planner rule allow, in the order they joined.
function _serveLine() {
  for (let i = 0; i < _planningQueue.length;) {
    const botId = _planningQueue[i];
    const admission = _admission(botId);
    if (admission.waitsOn === 'memory') return;
    if (admission.waitsOn === 'planner') { i++; continue; }
    _planningQueue.splice(i, 1);
    _enter(botId, admission.workspace);
  }
}

function requestPlanningToken(botId, phase = 'planning', requestId) {
  if (!['planning', 'workspace'].includes(phase)) throw new Error(`planning_gate: unknown phase '${phase}'`);
  if (!Number.isSafeInteger(requestId) || requestId < 1) throw new Error('planning_gate: requestId must be a positive whole number');
  if (_holders.has(botId)) {
    timeoutCrash.crashEverything(GATE, `'${botId}' asked to enter while it is inside on entry #${_holders.get(botId).entry}`, _gateState);
    return;
  }
  if (_planningQueue.includes(botId)) {
    timeoutCrash.crashEverything(GATE, `'${botId}' asked to enter while it already stands in the line`, _gateState);
    return;
  }

  _requestedPhases.set(botId, { phase, requestId });
  _planningQueue.push(botId);
  _serveLine();
  const place = _planningQueue.indexOf(botId);
  if (place < 0) return;

  // Every body served before this one: each one already in the line, and the one inside longest.
  const inside = _longestInside();
  const ahead = place + 1;
  _said(`'${botId}' in line for an entry — ${ahead} ahead, '${inside.bot_id}' inside on #${inside.entry} for ${_heldMs(inside)} ms.`);
  if (_onPlanningQueued) _onPlanningQueued(botId, { ahead, holder: inside.bot_id, held_ms: _heldMs(inside), requestId });
}

// An abandoned execution request leaves the same queue; its in-flight grant is identified by requestId.
function cancelWorkspaceRequest(botId, requestId) {
  const request = _requestedPhases.get(botId);
  if (request && request.requestId === requestId) {
    _requestedPhases.delete(botId);
    const index = _planningQueue.indexOf(botId);
    if (index >= 0) _planningQueue.splice(index, 1);
  }
  const holder = _holders.get(botId);
  if (holder && holder.requestId === requestId) {
    _said(`Entry #${holder.entry} closed: '${botId}' canceled while inside.`);
    _closeEntry(botId);
  }
  _serveLine();
}

function releasePlanningToken(botId, entry) {
  const holder = _holders.get(botId);
  if (!holder) {
    timeoutCrash.crashEverything(GATE, `'${botId}' sent exit token #${entry} and is not inside`, _gateState);
    return;
  }
  if (holder.entry !== entry) {
    timeoutCrash.crashEverything(GATE, `'${botId}' sent exit token #${entry} against its open entry #${holder.entry}`, _gateState);
    return;
  }
  _said(`EXIT #${entry} from '${botId}' after ${_heldMs(holder)} ms.`);
  _closeEntry(botId);
  _serveLine();
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Disconnect cleanup
// A dead bot must free everything it holds AND leave any wait line, or the
// queue stalls behind a ghost (Law 13: default = available).
// ─────────────────────────────────────────────────────────────────────────────

function releaseForBot(botId, why = 'disconnected') {
  _requestedPhases.delete(botId);
  for (const [key, claim] of _objectClaims) {
    if (claim.bot_id === botId) {
      _objectClaims.delete(key);
      log(`Released object '${key}' from ${why} bot '${botId}'.`);
    }
  }

  const qIdx = _planningQueue.indexOf(botId);
  if (qIdx >= 0) {
    _planningQueue.splice(qIdx, 1);
    log(`Removed ${why} bot '${botId}' from planning queue.`);
  }
  if (_holders.has(botId)) {
    _said(`Entry #${_holders.get(botId).entry} closed: '${botId}' ${why} while inside.`);
    _closeEntry(botId);
  }
  _serveLine();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Logging
//
// THE ARBITER'S DECISIONS BELONG IN THE RUN RECORD, NOT ONLY ON A CONSOLE. Writing to `console.log`
// alone leaves the one component that decides which bot may think absent from `watcher_fleet.jsonl`
// entirely — no grant, no queue entry, no slow hold, nothing a lens could read.
//
// `onLog` is the same registrar shape as `onPlanningGrant` above: this module must stay require-able COLD
// (preflight loads it with no server, no transport and no side effects), so it cannot reach for the
// server's writer itself. The server registers its persister at listen time; with nothing registered the
// lines still print, which is what a cold require and a bare `node foreman_brain.js` should do.
// ─────────────────────────────────────────────────────────────────────────────

let _logSink = null;

function onLog(callback) {
  _logSink = callback;
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [FOREMAN_BRAIN] ${msg}`;
  console.log(line);
  if (_logSink) _logSink(line);
}

module.exports = {
  workspaceState: () => ({ holders: [..._holders.values()].map(h => ({ bot_id: h.bot_id, entry: h.entry, phase: h.phase, workspace: h.workspace, held_ms: _heldMs(h) })), queued: _planningQueue.slice() }),
  handleClaimRequest,
  handleClaimRelease,
  requestPlanningToken,
  cancelWorkspaceRequest,
  releasePlanningToken,
  onPlanningGrant,
  onPlanningQueued,
  onLog,
  releaseForBot,
};
