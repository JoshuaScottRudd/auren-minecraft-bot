// js_kernel/keeper_verdicts.js — THIS BODY'S COPY OF THE INTEGRITY KEEPER'S VERDICTS.
//
// The integrity keeper (foreman/integrity_keeper.js) compares the crew's plans against the world once, for the
// whole crew, and the foreman sends each verdict to every body as it changes ('keeper_verdict'). This module
// holds them, so a body reads a verdict from its own memory, once the keeper's authority is verified (below).
//
// NO INTEGRITY DECISION WITHOUT THE KEEPER. A crew the foreman raises has its keeper up before its first body
// (startup_steps, "the integrity keeper holds every structure"). A body of such a crew never judges a structure for
// itself: a keeper it cannot verify, a verdict older than STALE_S, or a structure the keeper does not hold ends the
// whole run, said loudly first. A fragile run is reinforced by making the keeper durable, never by a body deciding
// blind (Law 13). A body with no foreman reads for itself: required() is false for it.
//
// Memory only, never written to HQ: a verdict is a reading of the world, not a fact to keep across a restart.

'use strict';

const STALE_S = 30;              // three of the keeper's 10 s renewals missed

const _verdicts = new Map();     // subject → { verdict, received_at }
const _waiting = [];             // { subject, since, resolve }

// ── EVERY VERDICT IS A CLAIM UNTIL THE KEEPER'S AUTHORITY IS VERIFIED (Law 23, Law 30) ───────────────────
// The keeper reads the world through the foreman's body, which hangs at one point: OBSERVER_LIFT over the alpha
// structure's cell (startup_steps, "the body hangs over the base"). Anywhere else it holds other chunks, and its
// verdicts describe a world it cannot see whole. So before each planning turn takes anything from the keeper,
// this body verifies it (verifyAuthority, called by job_board as it asks for the turn), and get() gives nothing
// until a verification passes.
//   THE CLAIM      the foreman is asked where the keeper's body is and where it belongs ('keeper_where'). An
//                  answer proves the keeper's side is there (Law 30: the ask is the check; silence ends the run).
//                  What it says is the foreman's own reading of itself, and a party's reading of itself shares
//                  every fault that party has, so it is checked, never taken.
//   THE AUTHORITY  the server's copy of the foreman's body (rcon_link.entityPos), held against this body's own
//                  reading of the station (its HQ, the same row the startup step placed it by). A spectator is never
//                  sent to a player who is not one, so no body can see the foreman's body; the server is the party
//                  that knows where it is.
//   OUTCOMES       server, claim and station agree within STATION_TOLERANCE: verified, verdicts are taken until the
//                  next turn's check decides otherwise. Anything else ends the whole run, named in a KEEPER_UNVERIFIED alarm first:
//                  no keeper raised, no base sited, the foreman's station differing from this body's, the body not in
//                  the world, a console that does not answer, the body off its station, or the claim disagreeing
//                  with the server.
const STATION_TOLERANCE = 2;     // blocks, the startup step's own proof
let _verified = false;
let _unverified = 'the integrity keeper has not been verified yet';

// required() → whether this body's integrity decisions must come from the keeper: it has a foreman, which raises a
// keeper for every crew.
function required() {
  return require('@kernel/foreman_link').hasForeman();
}

// fail(why) — the keeper cannot be relied on: said as an alarm, then the whole run ends.
// Said once: the run is already ending, and a reader that asks again on its way down adds nothing.
let _failed = false;
function fail(why) {
  _verified = false;
  if (_failed) return null;
  _failed = true;
  _unverified = why;
  require('@kernel/watcher').error('keeper_verdicts', `KEEPER_UNVERIFIED — ${why}. No body makes an integrity decision without the keeper; the run ends.`);
  require('@utils/timeout_crash').crashEverything('keeper_verdicts', `the integrity keeper cannot be relied on: ${why}`);
  return null;
}

function station() {
  const { ALPHA_STRUCTURE } = require('@thinking/architect_config');
  const alpha = ALPHA_STRUCTURE[require('@kernel/bot_mandate').currentMode()];
  if (!alpha) return null;
  const o = require('@kernel/corporate_headquarters').readBuildingChair(alpha, 'set_buildspot')?.transpose_origin;
  if (!o || !Number.isFinite(o.x)) return null;
  return { alpha, x: Math.floor(o.x), y: Math.floor(o.y) + require('@foreman/utils/observer').LIFT, z: Math.floor(o.z) };
}

const apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cell = (p) => `(${p.x},${p.y},${p.z})`;

// verifyAuthority() → resolves once this turn's verification has been decided; ends the run on an impossible state.
// THE LAST VERIFICATION STANDS UNTIL THIS ONE IS DECIDED. A reader outside the planning turn (an executor's timer, as a
// herder's shoo guard reading the pens every second) reads while the turn waits on the server, and is served by the
// last check that passed. A check that fails ends the run itself (fail), so nothing is taken from a keeper this turn
// finds wrong.
async function verifyAuthority() {
  const { FOREMAN_NAME } = require('@thinking/architect_config');
  if (!required()) return;
  const where = () => require('@utils/external_library_guard').guardExternal('keeper_verdicts', `read where ${FOREMAN_NAME} is`,
    () => require('@utils/rcon_link').entityPos(FOREMAN_NAME));
  let [claim, server] = await Promise.all([require('@kernel/foreman_link').askKeeperWhere(), where()]);
  // A console that missed one reply (a loaded server drops some) is asked once more before its silence ends the run.
  if (!server.ok) server = await where();
  const at = station();
  if (!claim.raised) return fail('the foreman says no integrity keeper is raised');
  if (!at) return fail(`this body's memory has no sited alpha structure to hold the keeper's station against`);
  if (!claim.station || apart(claim.station, at) > 0) {
    return fail(`the foreman places the station at ${claim.station ? cell(claim.station) : 'nowhere'}, this body at ${cell(at)}`);
  }
  if (!server.ok) return fail(`the server console did not answer (${server.reason}), so the foreman's claim cannot be checked`);
  if (!server.value) return fail(`the server has no ${FOREMAN_NAME} in the world`);
  const p = server.value;
  if (apart(p, at) > STATION_TOLERANCE) {
    return fail(`the keeper is out of position: the server reads ${FOREMAN_NAME} at ${cell(p)}, ${apart(p, at).toFixed(1)} blocks from its station ${cell(at)} over the ${at.alpha}`);
  }
  if (!claim.position || apart(claim.position, p) > STATION_TOLERANCE) {
    return fail(`the foreman's claim of its body (${claim.position ? cell(claim.position) : 'none'}) disagrees with the server's reading ${cell(p)}`);
  }
  _verified = true;
  _unverified = null;
  // EVERY VERIFICATION IS ACCOUNTED FOR: the first, each change of where the keeper was read, and a count every
  // VERIFIED_SAY_MS, so the record shows the body checked before it trusted (the three readings that agreed).
  _passes++;
  const said = `station=${cell(at)} claim=${cell(claim.position)} server=${cell({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })}`;
  if (said !== _verifiedSaid || Date.now() - _verifiedSaidAt >= VERIFIED_SAY_MS) {
    require('@kernel/watcher').summary('keeper_verdicts', `KEEPER_VERIFIED ${said} passes=${_passes}`);
    _verifiedSaid = said;
    _verifiedSaidAt = Date.now();
  }
}
const VERIFIED_SAY_MS = 300000;
let _passes = 0;
let _verifiedSaid = null;
let _verifiedSaidAt = 0;

function receive(subject, verdict) {
  if (typeof subject !== 'string' || !verdict || typeof verdict.generated_at !== 'string') {
    throw new Error(`[keeper_verdicts] CODING VIOLATION: a keeper verdict needs a subject and a generated_at. Got subject=${subject}.`);
  }
  _verdicts.set(subject, { verdict, received_at: Date.now() });
  const read = Date.parse(verdict.generated_at);
  for (let i = _waiting.length - 1; i >= 0; i--) {
    const w = _waiting[i];
    if (w.subject === subject && read > w.since) { _waiting.splice(i, 1); w.resolve(true); }
  }
}

// readAfter(subject, since, ms) → resolves true when a verdict read after `since` (epoch ms) arrives, false
// when none does within `ms`. A body that just changed the world waits on it before planning from the verdict
// again, so it never plans a second time over a change the keeper has not read yet.
function readAfter(subject, since, ms) {
  const held = _verdicts.get(subject);
  if (held && Date.parse(held.verdict.generated_at) > since) return Promise.resolve(true);
  return new Promise((resolve) => {
    const w = { subject, since, resolve };
    _waiting.push(w);
    setTimeout(() => { const i = _waiting.indexOf(w); if (i >= 0) { _waiting.splice(i, 1); resolve(false); } }, ms);
  });
}

// get(subject) → the verdict. For a body that requires the keeper, an unverified keeper, no verdict, or one older
// than STALE_S ends the run (fail). For a body that does not, null. The age runs from receipt: the keeper sends a
// changed verdict at once and renews an unchanged one.
function get(subject) {
  if (!required()) return null;
  if (!_verified) return fail(`an integrity verdict on ${subject} was asked for before the keeper was verified (${_unverified})`);
  const held = _verdicts.get(subject);
  if (!held) return fail(`the integrity keeper has sent no ${subject} verdict`);
  const age = (Date.now() - held.received_at) / 1000;
  if (age > STALE_S) return fail(`the integrity keeper's ${subject} verdict is ${Math.round(age)} s old (over ${STALE_S} s): the keeper has gone silent`);
  return held.verdict;
}

// keptEntry(subject, roomKey) → the keeper's entry for one sited room in a per-room verdict (`<subject>s` keyed by the
// full room key, `held` true), or null for a body that does not require the keeper. A room the keeper keeps no entry
// for, or does not hold whole from its station, ends the run: no body judges a site from its own chunks instead.
function keptEntry(subject, roomKey) {
  if (!required()) return null;
  const verdict = get(subject);
  if (!verdict) return null;
  const full = roomKey.includes('|') ? roomKey : require('@kernel/bot_mandate').buildingRoomKey(roomKey);
  const entry = verdict[subject] && verdict[subject][full];
  if (!entry) return fail(`the keeper keeps no ${full} in its ${subject} verdict`);
  if (entry.held !== true) return fail(`the keeper does not hold ${full} whole from its station`);
  return entry;
}

// why(subject) → a sentence naming why get() returned null, for a gate's reason.
function why(subject) {
  if (!_verified) return _unverified;
  const held = _verdicts.get(subject);
  if (!held) return `the integrity keeper has sent no ${subject} verdict`;
  return `the integrity keeper's ${subject} verdict is ${Math.round((Date.now() - held.received_at) / 1000)} s old (over ${STALE_S} s)`;
}

module.exports = { STALE_S, receive, get, keptEntry, why, readAfter, verifyAuthority, required, fail };
