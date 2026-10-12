// Durable replacements leave the previous complete file intact until synced bytes can be promoted.
// One ordered writer per path keeps its temporary file exclusive while disk I/O runs off the event loop.
'use strict';

const fs = require('fs').promises;
const path = require('path');
const { withCleanup } = require('@utils/external_library_guard');
const writers = new Map();

function durableWrite(filePath, text) {
  const file = path.resolve(filePath);
  const previous = writers.get(file) || Promise.resolve();
  const replace = async () => {
    const tmp = `${file}.tmp`;
    let handle = null;
    let opened = false;
    let renamed = false;
    return withCleanup('durable_write', `replace ${file}`, async () => {
      handle = await fs.open(tmp, 'w');
      opened = true;
      await handle.writeFile(text, 'utf-8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tmp, file);
      renamed = true;
    }, async () => {
      if (handle) await handle.close();
      if (opened && !renamed) await fs.unlink(tmp);
    });
  };
  // A failed predecessor releases the path; its error remains the predecessor's caller's outcome.
  const write = previous.then(replace, replace);
  writers.set(file, write);
  const release = () => { if (writers.get(file) === write) writers.delete(file); };
  write.then(release, release);
  return write;
}

module.exports = { durableWrite };
