// module: external_library_guard
// purpose: the only `try` in the fleet. Every legal catch is this one, and no call site writes its own.
//
// Law 16 permits exactly one catch: a translator converting a third-party throw into an outcome, which
// must log and must never swallow silently. A rule about a shape is unenforceable while every call site
// writes the shape by hand, since a catch that does the wrong thing looks exactly like one that does the
// right thing. A marker comment does not fix this: anything can type it without having done what it
// claims, so a scan over markers verifies that a string is present, not that a boundary is correct. This
// module is the other kind of answer — either a call goes through here or it does not, and an AST can
// see which.
//
// The name is deliberately long and the arity deliberately strict, so the call site is expensive to
// write thoughtlessly: the name states the precondition (`guardExternal(TAG, 'mining_integrity.scan', …)`
// reads as a lie the moment it names our own code), and the required third argument naming the call is
// the act of noticing what is being wrapped. JavaScript cannot withhold the `catch` keyword, so a
// hand-written try remains writable — it is caught by the scan, not prevented by this file.
//
// What it guarantees, by construction:
// 1. A coding violation is never swallowed. A ReferenceError cannot be produced by any arrangement of
//    the world, so Law 13's test — could this happen in a correctly-written system in a normal world —
//    answers no every time, and it is rethrown.
// 2. Nothing is silent — there is no empty-body option to write.
// 3. The failure is an outcome, not control flow: the caller receives a value and branches on it with
//    ordinary code, so a catch is never the expected pathway (Law 16).
//
// What does not belong here: this wraps a call into a third party — mineflayer, prismarine, fs, the
// network — and must never wrap our own code. When one of our own fragments throws, that is a defect,
// and the correct response is to let it travel until it stops the bot (Law 13: default stopped).
// Wrapping our own call to "be safe" converts a bug into a quiet decline-to-act.
//
// The throw itself is not wrapped: a catch needs a single owner because a wrong catch is silent, while a
// throw needs none, since a throw is the correct default (Law 13) and cannot hide anything. What this
// module owns is minting a coding-violation error (`violation` below), so the marker that makes such an
// error unswallowable is not a string retyped by hand at every site.
//
// TypeError is not treated as a coding violation: it is genuinely ambiguous, since our own bug produces
// it and so does a third-party library handed a null it did not expect (an unloaded chunk returning no
// block is a real world condition). Left environmental on purpose.

'use strict';

// Relative, not `@kernel/watcher`, and it must stay relative. This module is required from processes
// that do not register module-alias — the foreman is launched with NODE_PATH only, and every require
// under `foreman/` is relative for exactly that reason. An alias here is unresolvable there, and the
// failure is a hard MODULE_NOT_FOUND at foreman startup, and the message names the guard, not the caller
// that dragged it across. This is the fleet's most widely-required module; it may not assume the alias table
// exists (Law 26 — the shared piece depends only on what both sides can resolve).
//
// The alias dependency is not fully closed by watcher's own module scope: `watcher.js` lazily requires
// `./foreman_link` to forward a line, and `foreman_link` opens with `@kernel/watcher`,
// `@foreman/message_schema` and `@utils/external_library_guard`. Every entry point registers the alias
// table today; a future alias-less process that logs would still cross this dependency, and the fix
// belongs to `foreman_link`, not here.
const watcher = require('../watcher');

const VIOLATION_MARKER = 'CODING VIOLATION';

// A throw that no correct program in a normal world can produce. Named as a predicate so the definition
// has one home: what counts as a coding violation is a Law 13 judgment, and a second copy of it would be
// a second answer.
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
// unswallowable by construction, not by the author having spelled a phrase correctly.
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
// `what` is a short phrase naming the third-party call, required because the warning line is the only
// artifact a failed boundary leaves: a line like activateBlock at (x,y,z) failed is the difference
// between a diagnosable run and a log full of anonymous failures, and naming the callee is what exposes
// a site where the callee is ours.
//
// Async by default, since nearly every third-party call in this fleet is awaited. `guardExternalSync` is
// the same contract for the ones that are not: a separate function, since a sync caller receiving a
// promise it forgets to await is a silent wrong answer.
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
// withCleanup(tag, what, fn, cleanup) → whatever fn returns; fn's throw travels.
//
// A `try/finally` with no catch swallows nothing — it is a teardown guarantee, not a guard, and the
// navigator's swim step is the worked example: control state must be released whether the step arrived,
// timed out, or threw. `finally` is banned outside this file, so the primitive lives here with the rest
// of the vocabulary.
//
// This must never become a second muffler: it does not catch, does not convert a throw into a value, and
// returns fn's result unchanged. A caller wanting a failure as a value calls guardExternal; a caller
// wanting a teardown calls this; nothing gives both, since the combination is a catch with extra steps.
//
// The cleanup is itself treated as a boundary, since it usually is one (releasing a control state,
// closing a window). It is warned about, not thrown from, since a teardown failure must not replace the
// real outcome the caller is already receiving — but a coding violation in the cleanup still travels,
// since default-stopped outranks tidiness (Law 13).
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
    finally {
        try { await cleanup(); }
        catch (error) {
            if (isCodingViolation(error)) throw error;
            watcher.warn(tag, `${what} cleanup failed: ${_describe(error)}`);
        }
    }
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
