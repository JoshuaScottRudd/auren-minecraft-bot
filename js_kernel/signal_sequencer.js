// utility: signal_sequencer
// purpose: Detect two live signals in one bot's main planning loop, and name where the second one was
//          born. Called by recursive_judge — examine the payload arriving, stamp the payload departing.
//          Routes nothing, receives nothing, decides nothing about the work (Law 3 was the whole reason
//          this moved out of signal_bus).
//
// WHY IT EXISTS: two live signals in one bot's loop is a coding violation (Law 4), and it cannot be
// caught where it used to be checked. The guard used to live in signal_bus, which compared (source,
// target) against the last pair it routed. That is two faults in one line: a router that refuses is
// deciding (Law 3), and comparing the SOURCE means two different fragments routing to recursive_judge
// are never duplicates to it — the most common real duplicate shape (two independent fragments
// abandoning the same stalled work) sails straight through.
//
// WHY recursive_judge AND NOWHERE ELSE: every call site across the fleet routes to it, and every lap of
// the main loop passes through it exactly once. It is the only choke point that exists. Chosen as ONE
// GLOBAL CHECK rather than one guard per scope: immediate detection is not the requirement, detection
// WITHOUT FAIL is — two signals routing concurrently will eventually race regardless of where the check
// sits, so one check that nothing can bypass beats many checks that could each be skipped.
//
// THE ONE SHAPE THIS CANNOT SEE, recorded so a successor does not assume coverage it does not have: a
// stall where ZERO signals route. An arrival-checker cannot detect an absence of arrivals — nothing here
// fires when the bot simply goes quiet, and no flag added to this file would change that.
//
// A nested Law 15 sub-loop invocation (an abandoned call followed by a second, legitimate one) is
// survivable: the bus refuses nothing since the guard moved here, so the second invocation completes and
// the caller's tail routes a fresh chain. A run that goes quiet with no arrivals is still invisible to
// this instrument.

'use strict';

const watcher = require('@kernel/watcher');

// The id riding on the live chain. 0 = nothing issued yet (the run has not had its first arrival).
// MONOTONIC, NEVER REUSED and never reset to 1: recycling ids works as a detector but costs the two
// numbers that make a detection actionable — which lap of the run this was, and HOW FAR behind a stale
// arrival is. The gap is what narrows the search to a fragment.
let issued = 0;

// The trail the live chain departed with. Kept ONLY so a detection can print it beside the stale
// arrival's trail: the two share a prefix and diverge at exactly one fragment, and that fragment is
// where the second signal was born. Nothing reads it on the happy path.
let liveTrail = [];

// ── THE LATCH ────────────────────────────────────────────────────────────────────────────────────────
// A throw alone is NOT a stop: killing the one signal that looped says nothing about any others already
// in flight. Two chains can still be reaching for the same resource — exactly the nondeterminism this
// instrument exists to prevent — even after the offending signal has been killed and a halt reported.
//
// So detection sets a latch and signal_bus refuses EVERY route while it is set. Nothing clears it but a
// process restart (Law 13: default stopped — prove safe to continue, never prove unsafe to stop). This is
// not the guard moving back into the bus: the bus computes nothing and compares nothing, it reads one
// boolean owned by the fragment whose whole verb is deciding it (Law 3 — obeying a kill switch is not
// deciding; the old `_lastSignal` slot was the bus deriving a verdict of its own).
let tripped = null;   // null = live; otherwise { reason, at }

function isTripped() { return tripped; }

// Bounded because an abandoned-and-reborn chain would otherwise grow it without limit across a long run
// (Law 8 — the record terminates, it does not accumulate). 24 hops is several laps of the deepest chain
// the fleet runs (job_board → manager → executor → judge), so a divergence is still inside the window.
const TRAIL_LIMIT = 24;

// Appends one hop. Called from signal_utils' envelope builder, which is the single place every routed
// payload is constructed — so the trail is structural rather than something 39 call sites remember.
function appendTrail(trail, from) {
  const next = Array.isArray(trail) ? trail.concat(from) : [from];
  return next.length > TRAIL_LIMIT ? next.slice(next.length - TRAIL_LIMIT) : next;
}

// Where two trails stop agreeing. The fragment AT that index on the stale side is the one that routed a
// chain nobody was waiting for.
function divergence(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  return { index: i, shared: A.slice(0, i), staleAt: B[i] || '(nothing — the stale chain is a prefix)' };
}

// examine: called by recursive_judge on every arrival, AFTER its Law 10 field checks so a malformed
// payload throws for its own reason first. Returns the id to stamp on departure.
//
// THE CHECK
//   incoming === issued    → the live chain returned. Advance.
//   incoming is absent     → a fresh chain. LEGAL, and frequent: Law 15 abandonment (battle_stations,
//                            portable_judge, every executor's give-up path) originates a new chain while
//                            the caller's promise hangs forever, and start_injector opens the run with
//                            one. Rebase, and LOG it — a rebase that should not have happened is then
//                            visible in the trace instead of silently moving the counter.
//   anything else          → a chain that was stamped before the live one returned while a newer chain
//                            is out. TWO SIGNALS.
//
// Throws rather than routing. Two reasons, and the second is the one that matters: two live signals is
// a coding violation, not an environmental failure, so Law 13 says throw and dump. And a checker that
// routed on detection would itself become a signal source — the exact Law 3 fault that moved this out
// of signal_bus, rebuilt in a new building.
function examine(payload) {
  const incoming = payload ? payload.signal_id : undefined;
  const arrivingTrail = (payload && payload.signal_trail) || [];
  const from = (payload && payload.from) || 'unknown';

  if (incoming === undefined || incoming === null) {
    // ── AN INJECTOR ON TOP OF A LIVE CHAIN IS TWO SIGNALS ──────────────────────────────────────────
    // A no-id arrival is normally a Law 15 abandonment: the fragment that WAS executing the live chain
    // gives up and originates a fresh one, so exactly one line of work survives. That is legal and
    // frequent, and it must stay legal.
    //
    // An INJECTOR is the opposite act. It originates a chain from OUTSIDE the loop — nothing was
    // abandoned, so the chain already running keeps running and now there are two. Distinguished by
    // name because that is what the name is for (Law 7): a fragment called `*_injector` injects, and
    // injecting into a loop that is already turning is the duplicate. `issued === 0` is the run's own
    // first start and is the one time it is correct.
    //
    // This rule exists because without it, repeated external starts rebase indefinitely and never trip:
    // each one looks like the run's legitimate first start, so the counter just advances while two
    // chains end up reaching for the same resource, undetected.
    if (/_injector$/.test(from) && issued > 0) {
      return trip(payload,
        `'${from}' opened a NEW chain while #${issued} is still live. An injector originates from ` +
        `outside the loop, so nothing was abandoned — the running chain is still running and this is a ` +
        `second one. (The run's first start is legal; this is not the first.)`,
        arrivingTrail);
    }

    issued++;
    // summary, not warn: on a healthy run this fires once per abandonment, and abandonment is a designed
    // act. It is here to be COUNTED against the run's laps, not to be alarming (Law 5).
    watcher.summary('signal_sequencer',
      `🔢 Fresh chain from '${from}' carried no id — stamping #${issued}. ` +
      `Any chain still holding #${issued - 1} is abandoned and must never return.`);
    return issued;
  }

  if (incoming === issued) {
    issued++;
    return issued;
  }

  const behind = issued - incoming;
  return trip(payload,
    `A chain stamped #${incoming} arrived while #${issued} is the live one ` +
    `(${behind > 0 ? `${behind} lap(s) behind` : `${-behind} lap(s) AHEAD — an id was stamped out of band`}).`,
    arrivingTrail);
}

// trip: set the latch, dump everything that names WHERE the second signal came from, then throw.
// Order matters — the latch is set FIRST, because the throw unwinds this fragment only and any chain
// already in flight keeps going; the latch is what stops those (see the latch's own header).
function trip(payload, why, arrivingTrail) {
  const d = divergence(liveTrail, arrivingTrail);
  const from = (payload && payload.from) || 'unknown';

  if (!tripped) tripped = { reason: why, from };

  watcher.error('signal_sequencer', `❌ TWO LIVE SIGNALS — ALL ROUTING STOPPED. ${why}`);
  watcher.error('signal_sequencer', `  live chain  #${issued}: ${liveTrail.join(' → ') || '(none)'}`);
  watcher.error('signal_sequencer', `  arrived from '${from}': ${arrivingTrail.join(' → ') || '(none)'}`);
  watcher.error('signal_sequencer', `  they agree through: ${d.shared.join(' → ') || '(nothing)'}`);
  watcher.error('signal_sequencer',
    `  ↳ THE SECOND SIGNAL WAS BORN AT: ${d.staleAt} — that fragment routed a chain nobody was awaiting.`);
  watcher.error('signal_sequencer', `  captured payload: ${capture(payload)}`);
  watcher.error('signal_sequencer',
    `  The bus now refuses EVERY route until this process restarts. A killed signal is not a stopped ` +
    `system — the others already in flight do not care that one died (Law 13, default stopped).`);

  throw new Error(`signal_sequencer: two live signals from '${from}' — ${why} ALL ROUTING STOPPED (Law 4 violation)`);
}

// The payload as evidence. Values are shortened rather than dropped — the field NAMES are usually enough
// to identify which chain this was, and a capsule can be megabytes.
function capture(payload) {
  if (!payload || typeof payload !== 'object') return String(payload);
  const parts = [];
  for (const [k, v] of Object.entries(payload)) {
    let s;
    if (v === null || v === undefined) s = String(v);
    else if (typeof v === 'object') s = Array.isArray(v) ? `[${v.length} item(s)]` : `{${Object.keys(v).join(',')}}`;
    else s = String(v);
    parts.push(`${k}=${s.length > 60 ? `${s.slice(0, 57)}…` : s}`);
  }
  return `{ ${parts.join(', ')} }`;
}

// stamp: called by recursive_judge on every departure. The id is the ONE thing the judge preserves
// across the hop — the chain it sends out must be identifiable when it comes back, and the outbound
// payload is otherwise rebuilt from scratch at most of its exits.
// The trail restarts at the judge: it exists to locate a divergence within ONE lap, and carrying the
// previous lap's hops would push the useful part out of the window.
function stamp(outPayload, id) {
  liveTrail = ['recursive_judge'];
  return { ...outPayload, signal_id: id, signal_trail: liveTrail.slice() };
}

module.exports = { examine, stamp, appendTrail, divergence, isTripped, TRAIL_LIMIT };
