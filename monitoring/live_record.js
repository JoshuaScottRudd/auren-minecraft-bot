// Auren_Bot/monitoring/live_record.js
// Says when a lens was read off a record a running fleet is still adding to.
//
// A lens reads a record at any time. Every read is taken under the record's claim
// (js_kernel/utils/record_claims): the writer holds its lines while the read is in progress and the read
// waits for an append already in flight, so what a lens parses is always whole lines up to one moment.
//
// A record a fleet is still adding to ends at that moment and not at the end of the run. The reader is
// told so on stderr, with the moment; stdout is the answer channel and carries only the answer.

'use strict';

const fs = require('fs');

// A record appended to within this long has a writer still running.
const LIVE_WITHIN_MS = 5000;

// Milliseconds since the last append to this record; null when there is no record.
function quietFor(file) {
  if (!file || !fs.existsSync(file)) return null;
  return Date.now() - fs.statSync(file).mtimeMs;
}

function isLive(file) {
  const quiet = quietFor(file);
  return quiet !== null && quiet < LIVE_WITHIN_MS;
}

// noteIfLive(file) — one stderr line when the record is still being added to.
function noteIfLive(file) {
  if (!isLive(file)) return;
  process.stderr.write(`live_record: the run is still going — this read covers it up to ${new Date().toISOString()} (taken under the record claim).\n`);
}

module.exports = { noteIfLive, isLive, quietFor, LIVE_WITHIN_MS };
