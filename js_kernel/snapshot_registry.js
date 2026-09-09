// js_kernel/snapshot_registry.js
// The mechanism behind every "declared data file" registry (Law 16 — this exists so there is ONE
// implementation of it, not one per file). A declared data file is a STOPPED-STATE INPUT: snapshotted
// once at boot, used from that snapshot for the whole run, and never re-opened. Editing it is fully
// supported and is the intended way to change behaviour — the change takes effect on the NEXT START.
//
// WHY THIS FILE EXISTS AT ALL: every declared-file registry needs identical snapshot-and-warn-on-drift
// behaviour. Copying that logic per file would make one capability into multiple implementations of it —
// the thing Law 16 forbids, and the reason scattered fs.readFileSync call sites were dangerous in the
// first place. The mechanism is extracted here instead; the per-file registries are thin instances that
// own only their own shape validation and accessor names.
//
// WHAT IT DEFENDS AGAINST:
//   1. THE CRASH. A live re-read makes a missing file a Law 13 coding violation → throw. So the ordinary
//      way a human edits a file — delete it, then upload the new version — kills every bot that reads
//      inside that window. A snapshot is immune: the delete window cannot be observed.
//   2. THE SILENT CORRUPTION, which is worse because it does NOT crash. A mid-run swap leaves the bot
//      reasoning about work planned from document A against document B. Nothing is malformed, so nothing
//      throws — it simply reaches confident wrong conclusions. A well-formed falsehood the machine acts
//      on faithfully (Law 26 drift). The loud failure is the survivable one.
//
// WHY A HASH AND NOT JUST A SNAPSHOT: a snapshot alone is safe but silent — edit the file, see nothing,
// conclude the edit took effect, and build on that belief. Same unverified-belief failure, other
// direction. The drift check makes the disagreement between disk and running state SAID rather than
// inferred (Law 26: the boundary the mind and the machine both read). WARNING level, never error:
// nothing is broken, the run is correct on a valid snapshot, and it waits for timed inspection. It must
// NEVER throw — a disk edit during a run is a supported operator act, not a fault.
//
// LAW 13 STILL BINDS AT BOOT: missing/empty/corrupt/wrong-shape at startup throws, because that is the
// stopped→running transition where the form-catch belongs (Law 26: validated at startup, then trusted).

'use strict';

const fs     = require('fs');
const crypto = require('crypto');
const { guardExternalSync, violation } = require('@utils/external_library_guard');

// Accessors are called thousands of times per run, so the check must cost nothing in the common case:
// a stat() at most this often, and a re-hash only when mtime/size actually moved. 10s is far below any
// human edit-then-look cycle, so a change is always reported at the next check-in with room to spare.
const DRIFT_STAT_THROTTLE_MS = 10000;

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);

/**
 * @param filePath  absolute path (use require.resolve so a rename fails loudly at load)
 * @param fileName  bare filename, for operator-facing messages
 * @param tag       watcher tag for drift warnings
 * @param validate  (parsed) => string|null — a message describing the wrong shape, or null if fine.
 *                  Runs at BOOT ONLY; a bad shape there is a Law 13 throw.
 */
function createSnapshotRegistry({ filePath, fileName, tag, validate }) {
  // ── Boot snapshot (Law 13: throw here, and only here) ──────────────────────────────────────────
  // Both boundaries route through the guard and are then PROMOTED to a throw. A missing or malformed
  // document is environmental to fs and to JSON, but it is a coding violation to this fleet: nothing
  // downstream can run against a snapshot that was never taken (Law 13).
  const bootRead = guardExternalSync(tag, `read ${fileName} at startup`, () => fs.readFileSync(filePath, 'utf8'));
  if (!bootRead.ok) throw violation(tag, `${fileName} is missing or unreadable at startup. ${bootRead.reason}`);
  const raw = bootRead.value;
  if (!raw || !raw.trim().length) throw violation(tag, `${fileName} is empty at startup.`);

  const parsed = guardExternalSync(tag, `parse ${fileName} at startup`, () => JSON.parse(raw));
  if (!parsed.ok) throw violation(tag, `${fileName} is not valid JSON at startup. ${parsed.reason}`);
  const data = parsed.value;
  const shapeError = validate ? validate(data) : null;
  if (shapeError) throw violation(tag, `${fileName} ${shapeError} at startup.`);

  const BOOT_HASH = sha1(raw);

  // ── Drift detection (never throws — a disk edit mid-run is legal, just not live) ────────────────
  let _lastStatAt       = 0;
  let _lastSeenSig      = null;   // mtime:size of the last version we bothered to hash
  let _warnedUnreadable = false;
  const _warnedHashes   = new Set([BOOT_HASH]);

  // Lazily required so a registry can be pulled in by anything without a load-order dependency on the
  // watcher (and so a drift warn never becomes a require-time cycle).
  function warn(message) {
    require('@kernel/watcher').warn(tag, message);
  }

  function checkForDrift() {
    const now = Date.now();
    if (now - _lastStatAt < DRIFT_STAT_THROTTLE_MS) return;
    _lastStatAt = now;

    const statted = guardExternalSync(tag, `stat ${fileName} for drift`, () => fs.statSync(filePath));
    if (!statted.ok) {
      // The file is gone right now — almost certainly the delete half of a delete-then-upload. This is
      // precisely the window that used to kill the fleet; say so plainly and carry on.
      if (!_warnedUnreadable) {
        _warnedUnreadable = true;
        warn(`${fileName} is currently MISSING from disk. Nothing is broken — the fleet is running on the ` +
             'snapshot taken at boot and never re-reads the file. Finish the upload; the new version ' +
             'applies at the next start.');
      }
      return;
    }
    const stat = statted.value;

    // Clear the missing-file state BEFORE the signature gate below. A file that was moved away and put
    // back keeps its original mtime and size, so its signature is unchanged and the gate would return
    // early — leaving _warnedUnreadable stuck true, and the NEXT disappearance therefore silent. Caught
    // by the registry drift test's delete→restore case; the stat succeeding is itself proof it is back.
    if (_warnedUnreadable) {
      _warnedUnreadable = false;
      warn(`${fileName} is back on disk.`);
    }

    const sig = `${stat.mtimeMs}:${stat.size}`;
    if (sig === _lastSeenSig) return;
    _lastSeenSig = sig;

    const read = guardExternalSync(tag, `read ${fileName} for drift`, () => fs.readFileSync(filePath, 'utf8'));
    if (!read.ok) return;   // vanished between stat and read — the next pass reports it

    const hash = sha1(read.value);
    if (hash === BOOT_HASH) return;        // edited back to the running version — nothing to say
    if (_warnedHashes.has(hash)) return;   // already reported this exact version
    _warnedHashes.add(hash);

    warn(`${fileName} CHANGED ON DISK (boot ${BOOT_HASH} → disk ${hash}). Nothing is broken and nothing ` +
         'was lost: the fleet is deliberately still running against the boot snapshot, so work already ' +
         'planned stays consistent with the document it was planned from. THE EDIT IS NOT LIVE — restart ' +
         'the bots to apply it (runbook §3a continue test applies edits without rolling back the world).');
  }

  // `data()` is the only way in: it runs the drift check, so no caller can read the snapshot without
  // the disagreement between disk and running state getting a chance to be said.
  return {
    data() { checkForDrift(); return data; },
    bootHash() { return BOOT_HASH; },
    FILE_PATH: filePath,
  };
}

module.exports = { createSnapshotRegistry, DRIFT_STAT_THROTTLE_MS };
