// require_memo — each require's resolved file, worked out once per process.
//
// The construct requires inside functions on purpose: a lazy require breaks a load cycle, and a module is loaded only
// when its first caller needs it. Every such call still resolves its name to a file before Node's module cache is
// read. Through module-alias an aliased name costs about 0.6 µs a call, and a bare package name searches every module
// home on disk again, about 385 µs, so a require on a hot path (a physics tick, a route search's every node) costs
// more than the work around it.
//
// A name required from one file resolves to the same file for the whole life of a process: the aliases and the module
// homes are fixed before the first require of the construct runs. install() remembers each (requiring directory,
// name) → file the first time Node resolves it, and answers from that afterwards. A name that fails to resolve throws
// as before and is not remembered. A call that passes resolve options (require.resolve with paths) is never remembered.
//
// Installed once, after module-alias and the module homes are set, at the top of each process: a bot (master_core),
// the foreman, and the integrity keeper's thread.

'use strict';

const Module = require('module');

let _installed = false;

function install() {
  if (_installed) return;
  _installed = true;
  const resolve = Module._resolveFilename;
  const memo = new Map();
  Module._resolveFilename = function resolveOnce(request, parent, isMain, options) {
    if (options || isMain || !parent || !parent.path) return resolve.call(this, request, parent, isMain, options);
    const key = parent.path + '\0' + request;
    let file = memo.get(key);
    if (file === undefined) {
      file = resolve.call(this, request, parent, isMain, options);
      memo.set(key, file);
    }
    return file;
  };
}

module.exports = { install };
