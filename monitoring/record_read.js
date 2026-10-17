// Auren_Bot/monitoring/record_read.js
// The reader's side of the record claim (js_kernel/utils/record_claims): every lens read of a run record
// goes through readUnderClaim, so no record is read while it is being appended to.

'use strict';

const path = require('path');
const claims = require(require('./lens_paths').bot('js_kernel/utils/record_claims'));

const READ_WAIT_MS = 10000;    // the longest a read waits for an append in flight
const POLL_MS = 20;

// readUnderClaim(file, read) → read()'s value, taken while no append to `file` is in flight and none can
// start. Throws when an append in flight does not end inside READ_WAIT_MS (Law 13: no read is taken of a
// record that could not be held).
function readUnderClaim(file, read) {
  const marked = claims.placeReadMark(file);
  try {
    const until = Date.now() + READ_WAIT_MS;
    while (marked && claims.writerStands(file)) {
      if (Date.now() >= until) {
        throw new Error(`[record_read] ${path.basename(file)}: an append was still in flight after ${READ_WAIT_MS} ms — the record was not read.`);
      }
      claims.sleepSync(POLL_MS);
    }
    return read();
  } finally {
    if (marked) claims.removeReadMark(file);
  }
}

module.exports = { readUnderClaim, READ_WAIT_MS };
