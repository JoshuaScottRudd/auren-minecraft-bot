// module: record_claims
// purpose: the one claim over a run record, so a record is never read while it is being appended to. A
//          record has one writer process (a body's watcher for its own story, the foreman for the fleet's)
//          and any number of readers (the lenses), all separate processes, so the claim is kept where
//          they all meet: beside the record on disk.
//
// ── THE CLAIM ─────────────────────────────────────────────────────────────────────────────────────────
// Two marks stand beside a record `F`:
//   F.writing          the writer's, placed before an append and removed when the append has landed
//   F.reading.<pid>    a reader's, placed before a read and removed after it
// Each side places its own mark FIRST and looks for the other's SECOND, so of a writer and a reader
// arriving together at least one sees the other:
//   the writer   places F.writing, and if a reader's mark stands it removes its own and keeps its lines
//                queued for its next flush — the writer waits until the reader is done;
//   the reader   (monitoring/record_read) places F.reading.<pid>, then waits until F.writing is gone — the reader waits until the
//                writer is done — and reads.
// Readers do not exclude each other.
//
// ── A MARK ITS OWNER NEVER REMOVED ────────────────────────────────────────────────────────────────────
// A process killed between placing and removing leaves its mark. A mark older than STALE_MS is no claim:
// the other side removes it and carries on, so a dead lens cannot stop a record and a dead writer cannot
// stop a lens.
//
// No catch here (the watcher requires this file and reports its own faults): every call below is one that
// answers a missing file without throwing.

'use strict';

const fs = require('fs');
const path = require('path');

const STALE_MS = 30000;        // a mark this old belongs to a process that is gone
const POLL_MS = 20;

const writingMark = (file) => `${file}.writing`;
const readingMark = (file) => `${file}.reading.${process.pid}`;

// True when the mark stands and is a live claim; a stale one is removed and reads as absent.
function stands(mark) {
  const st = fs.statSync(mark, { throwIfNoEntry: false });
  if (!st) return false;
  if (Date.now() - st.mtimeMs < STALE_MS) return true;
  fs.rmSync(mark, { force: true });
  return false;
}

function readerStands(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.reading.`;
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(name => name.startsWith(prefix) && stands(path.join(dir, name)));
}

// beginWrite(file) → true when the writer may append now (its mark is placed; endWrite removes it), false
// when a reader holds the record (no mark is left; the writer keeps its lines and asks again).
function beginWrite(file) {
  fs.writeFileSync(writingMark(file), '');
  if (!readerStands(file)) return true;
  fs.rmSync(writingMark(file), { force: true });
  return false;
}

function endWrite(file) {
  fs.rmSync(writingMark(file), { force: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The reader's half, driven by the lens side (monitoring/record_read): place the mark, wait while the
// writer's stands, read, remove the mark.
function placeReadMark(file) {
  if (!fs.existsSync(path.dirname(file))) return false;   // no record home, so no writer and no mark
  fs.writeFileSync(readingMark(file), '');
  return true;
}

function removeReadMark(file) {
  fs.rmSync(readingMark(file), { force: true });
}

const writerStands = (file) => stands(writingMark(file));

module.exports = { beginWrite, endWrite, placeReadMark, removeReadMark, writerStands, sleepSync, STALE_MS };
