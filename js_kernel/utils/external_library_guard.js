// module: external_library_guard
// purpose: THE ONLY `try` IN THE FLEET. Every legal catch is this one, and no call site writes its own.
//
// ── WHY A MODULE AND NOT A RULE ASKING PEOPLE TO BE CAREFUL ───────────────────────────────────────
// Law 16 permits exactly one catch: a translator converting a third-party throw into an outcome, which
// must log and must never swallow silently. That is a rule about a SHAPE, and a rule about a shape is
// unenforceable while every call site writes the shape by hand — 260 hand-written try/catch blocks are
// 260 chances to write it slightly differently, and the differences are invisible because a catch that
// does the wrong thing looks exactly like a catch that does the right thing.
//
// A marker comment (`// LAW16-BOUNDARY`) was the obvious alternative and it does not work. A marker is a
// DECLARATION: anything can type it without having done what it claims, so a scan over markers verifies
// that a string is present, not that a boundary is correct. That is the simulation case in Law 26 — form
// survives, the guarantee behind it is deleted. This module is the other kind of answer. There is nothing
// to declare, because either the call goes through here or it does not, and an AST can see which.
//
// ── WHY THE NAME IS THIS LONG, WHICH IS NOT A STYLE CHOICE ────────────────────────────────────────
// A try/catch is the ambient idiom of nearly every codebase in existence, so writing one around a risky
// call is not a decision anyone makes — it is the completion that arrives first, and it looks correct
// because it looks like everything around it. A rule that fires afterwards does not touch that; it reports
// the reflex without slowing it. So the call site is built to be EXPENSIVE TO WRITE THOUGHTLESSLY, and two
// properties do that work:
//   THE NAME states the precondition. `guardExternal(TAG, 'mining_integrity.scan', …)` reads as a lie at
//   the moment it is typed, because mining_integrity is ours. A neutral name (`attempt`, `safely`, `tryIt`)
//   accepts our own code without protest and the wrapper becomes a general-purpose muffler.
//   THE ARITY forbids a reflex. Three arguments are required, one of them a phrase NAMING the call, which
//   is exactly the act of noticing what is being wrapped. A drop-in replacement for `catch` would be pasted
//   as thoughtlessly as a `catch`, so the cost of use is the mechanism and must not be optimised away.
// This raises the price of the wrong act and makes it legible on sight; it does not make it impossible.
// JavaScript cannot withhold the `catch` keyword, so a hand-written try remains writable — it is caught by
// the scan, not prevented by this file, and claiming otherwise would be the guarantee/catch confusion in
// Law 26.
//
// ── WHAT IT GUARANTEES, BY CONSTRUCTION RATHER THAN BY CONVENTION ─────────────────────────────────
// 1. A CODING VIOLATION IS NEVER SWALLOWED. A ReferenceError cannot be produced by any arrangement of
//    the world — no block, chunk or entity creates an unbound identifier — so Law 13's test ("could this
//    happen in a correctly-written system in a normal world?") answers no every time, and it is rethrown.
//    Hand-written catches got this right one file at a time and wrong everywhere else, and worse: an
//    enclosing hand-written catch would swallow the rethrow of an inner one, which is the author's own
//    intent defeated by the author's own code. One implementation cannot disagree with itself.
// 2. NOTHING IS SILENT. There is no empty-body option to write, so `catch (_) {}` cannot exist.
// 3. THE FAILURE IS AN OUTCOME, NOT CONTROL FLOW. The caller receives a value and branches on it with
//    ordinary code, so a catch is never the expected pathway (Law 16).
//
// ── WHAT DOES *NOT* BELONG HERE, AND THIS IS THE HALF THAT MATTERS ────────────────────────────────
// This wraps a call into a THIRD PARTY — mineflayer, prismarine, fs, the network. It must never wrap our
// own code. When one of our own fragments throws, that is a defect, and the correct response is to let it
// travel until it stops the bot (Law 13: default stopped). Wrapping our own call to "be safe" converts a
// bug into a quiet decline-to-act, which is the most expensive failure shape this system has: the fleet
// keeps running, logs a reason, and does nothing, for as long as nobody reads closely.
//
// THE THROW IS NOT WRAPPED, AND THAT ASYMMETRY IS DELIBERATE. A catch needs a single owner because a wrong
// catch is silent; a throw needs none because a throw is the correct default (Law 13) and cannot hide
// anything — routing throws through one file would invert the law it serves. What this module owns is the
// MINTING of a coding-violation error (`violation` below), because the marker that makes such an error
// unswallowable is a string, and a string typed by hand at every site is one typo away from a fragment
// that still throws but is quietly demoted to environmental at the next boundary it crosses.
//
// TYPEERROR IS DELIBERATELY NOT TREATED AS A CODING VIOLATION. It is the one error class that is genuinely
// ambiguous here: our own bug produces it, and so does a third-party library handed a null it did not
// expect — an unloaded chunk returning no block is a real world condition, and making it fatal would trade
// a quiet fault for a loud wrong one. Left environmental on purpose; a narrower rule would need to know
// whose null it was, which the throw does not carry.

'use strict';

// RELATIVE, NOT `@kernel/watcher`, AND IT MUST STAY RELATIVE. This module is required from processes
// that do NOT register module-alias — the overseer is launched with NODE_PATH only, and every require
// under `overseer/` is relative for exactly that reason. An alias here is unresolvable there, and the
// failure is a hard MODULE_NOT_FOUND at overseer startup: the port never binds, the bring-up times out
// after 20 s, and the message names the guard rather than the caller that dragged it across.
// This is the fleet's most widely-required module. It may not assume the alias table exists (Law 26 —
// the shared piece depends only on what BOTH sides can resolve). watcher itself takes only `fs`/`path`,
// so the relative chain is closed here and does not cascade.
const watcher = require('../watcher');

const VIOLATION_MARKER = 'CODING VIOLATION';

// A throw that no correct program in a normal world can produce. Kept as a named predicate rather than
// inlined so the definition has one home: what counts as a coding violation is a Law 13 judgment, and a
// second copy of it is a second answer.
function isCodingViolation(error) {
    if (!error) return false;
    if (error instanceof ReferenceError) return true;
    if (error instanceof SyntaxError) return true;
    // Deliberate throws across the fleet carry this marker in their message (build_executor's station
    // registration is the worked example). Matching it keeps a hand-authored violation travelling through
    // a boundary that would otherwise translate it into an ordinary environmental outcome.
    return typeof error.message === 'string' && error.message.includes(VIOLATION_MARKER);
}

// violation(tag, what) → Error carrying the marker `isCodingViolation` matches.
// The predicate above and the minting below read the same constant, so a violation minted here is
// unswallowable by construction rather than by the author having spelled a phrase correctly.
function violation(tag, what) {
    return new Error(`[${tag}] ${VIOLATION_MARKER}: ${what}`);
}

function _describe(error) {
    return error && error.message ? error.message : String(error);
}

function _requireArgs(fname, tag, what, fn) {
    if (typeof tag !== 'string' || !tag) throw violation('external_library_guard', `${fname}() needs the caller's tag`);
    if (typeof what !== 'string' || !what) throw violation('external_library_guard', `${fname}() needs a description of the external call`);
    if (typeof fn !== 'function') throw violation('external_library_guard', `${fname}() needs a function to run`);
}

// guardExternal(tag, what, fn) → { ok, value } | { ok: false, error, reason }
//
// `what` is a short phrase naming the third-party call, and it is required rather than optional for two
// reasons: the warning line is the only artifact a failed boundary leaves, and "activateBlock at (x,y,z)
// failed" is the difference between a diagnosable run and a log full of anonymous failures — and naming
// the callee is the act that exposes a site where the callee is ours.
//
// Async by default because nearly every third-party call in this fleet is awaited. `guardExternalSync` is
// the same contract for the handful that are not — two functions rather than one that inspects its own
// return value, because a sync caller receiving a promise it forgets to await is a silent wrong answer.
async function guardExternal(tag, what, fn) {
    _requireArgs('guardExternal', tag, what, fn);
    try {
        return { ok: true, value: await fn() };
    } catch (error) {
        if (isCodingViolation(error)) throw error;
        watcher.warn(tag, `${what} failed: ${_describe(error)}`);
        return { ok: false, error, reason: _describe(error) };
    }
}

function guardExternalSync(tag, what, fn) {
    _requireArgs('guardExternalSync', tag, what, fn);
    try {
        return { ok: true, value: fn() };
    } catch (error) {
        if (isCodingViolation(error)) throw error;
        watcher.warn(tag, `${what} failed: ${_describe(error)}`);
        return { ok: false, error, reason: _describe(error) };
    }
}

// ── CLEANUP — `finally`, AND IT IS NOT A GUARD ───────────────────────────────────────────────────
// withCleanup(tag, what, fn, cleanup) → whatever fn returns; fn's throw TRAVELS.
//
// A `try/finally` with no catch swallows nothing — it is a teardown guarantee, not a guard, and the
// navigator's swim step is the worked example: control state must be released whether the step arrived,
// timed out, or threw. Banning `finally` outside this file leaves those sites with nowhere legal to go, so
// the primitive lives here with the rest of the vocabulary.
//
// THE ONE THING THIS MUST NEVER BECOME is a second muffler. It does not catch, does not convert a throw
// into a value, and returns fn's result unchanged — the ONLY difference from calling fn directly is that
// cleanup runs on the way out. A caller wanting a failure as a value calls guardExternal; a caller wanting
// a teardown calls this; nothing gives both, because the combination is a catch with extra steps.
//
// The cleanup itself is treated as a boundary because it usually is one (releasing a control state,
// closing a window). It is warned about rather than thrown from, since a teardown failure must not replace
// the real outcome the caller is in the middle of receiving — but a coding violation in the cleanup still
// travels, because default-stopped outranks tidiness (Law 13).
function _runCleanup(tag, what, cleanup) {
    try { cleanup(); }
    catch (error) {
        if (isCodingViolation(error)) throw error;
        watcher.warn(tag, `${what} cleanup failed: ${_describe(error)}`);
    }
}

async function withCleanup(tag, what, fn, cleanup) {
    _requireArgs('withCleanup', tag, what, fn);
    if (typeof cleanup !== 'function') throw violation('external_library_guard', 'withCleanup() needs a cleanup function');
    try { return await fn(); }
    finally { _runCleanup(tag, what, cleanup); }
}

function withCleanupSync(tag, what, fn, cleanup) {
    _requireArgs('withCleanupSync', tag, what, fn);
    if (typeof cleanup !== 'function') throw violation('external_library_guard', 'withCleanupSync() needs a cleanup function');
    try { return fn(); }
    finally { _runCleanup(tag, what, cleanup); }
}

module.exports = {
    guardExternal, guardExternalSync,
    withCleanup, withCleanupSync,
    violation, isCodingViolation,
};
