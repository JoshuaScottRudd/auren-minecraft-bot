// js_kernel/durable_write.js
// THE ONE WAY THIS FLEET REPLACES A FILE IT CANNOT AFFORD TO LOSE.
//
// A crash between a write and its data reaching disk is not a torn write, it is the gap between two
// kinds of durability. `writeFileSync` returns as soon as the bytes reach the OS page cache — RAM. A
// rename is a METADATA operation, and NTFS journals metadata but not file data. So a crash replay can
// restore a directory entry and a file's length while the data blocks it points at were never flushed;
// NTFS may not hand back another file's old contents, so the file reads back as zeros. The file is
// reported written and was never on the disk.
//
// WHAT THIS DOES, AND WHY IT IS ENOUGH: tmp → write → **fsync** → close → rename. The fsync is the whole
// point — it does not return until the bytes are on the platter, so the rename that follows can only
// ever promote a COMPLETE file. Whatever happens after that, the target holds either the new content or
// the previous content, both intact.
//
// DELIBERATELY NOT INCLUDED, so this stays a guard and not a filesystem:
//   · NO .bak generation. Once the target is always a complete file, a backup guards a case that can no
//     longer occur. It would add a second candidate for "which one is real" and buy nothing.
//   · NO write-ahead log, no journal, no rotation. Those exist to make a MID-write state recoverable;
//     here the mid-write state lives in a tmp file nothing reads, and is simply discarded.
//   · NO fsync of the DIRECTORY. On POSIX that would also harden the rename itself; Node cannot portably
//     fsync a directory handle on Windows, and losing the rename is the SAFE loss — the target keeps its
//     previous complete content. Hardening the write is what turns a fatal loss into a survivable one;
//     hardening the rename would only narrow a window that already fails safe.
//
// COST: one fsync per flush. Affordable when callers write on a debounce rather than continuously; NOT
// affordable for a file rewritten dozens of times a second — which is why the watcher's story file
// solves the same problem the other way, by appending instead of replacing (see js_kernel/watcher.js).
// Two shapes of file, two mechanisms, one guarantee: nothing this fleet cannot rebuild is ever left
// depending on the page cache.

'use strict';

const fs = require('fs');
const { withCleanupSync } = require('@utils/external_library_guard');

// durableWrite(filePath, text) → replaces filePath with text, or throws having changed nothing.
//
// IT THROWS RATHER THAN REPORTING (Law 13, and Law 25 at the boundary): every caller is replacing state
// it cannot rebuild, so a write that did not happen must never be reported as one that did. The tmp file
// is cleaned up on the way out so a failed flush cannot leave litter that a later reader mistakes for
// real state.
// withCleanupSync, NOT a guard: the fs throw is the deliverable here and must travel untouched. All the
// shape buys is that the tmp file and the descriptor are dropped on the way out — and the cleanup's own
// failures are reported rather than allowed to replace the error that caused them.
function durableWrite(filePath, text) {
  const tmp = `${filePath}.tmp`;
  let fd = null;
  let renamed = false;
  withCleanupSync('durable_write', `replace ${filePath}`, () => {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text, 'utf-8');
    fs.fsyncSync(fd);          // the one line the whole file exists for
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
    renamed = true;
  }, () => {
    if (renamed) return;       // the rename consumed the tmp; there is nothing left to clean
    if (fd !== null) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  });
}

module.exports = { durableWrite };
