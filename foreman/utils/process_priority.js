'use strict';
// The foreman gives only its own runtime processes the configured Windows CPU scheduling class.
const os = require('os');
const CONFIG = require('../../foreman_config');
const { guardExternalSync, violation } = require('../../js_kernel/utils/external_library_guard');

const PRIORITIES = Object.freeze({
  normal: os.constants.priority.PRIORITY_NORMAL,
  high: os.constants.priority.PRIORITY_HIGH,
});

// Read back the actual class so a denied or changed request is visible in the run's record.
function apply(pid, role, log) {
  if (!Number.isInteger(pid) || pid <= 0) throw violation('process_priority', 'a positive owned process ID is required');
  const requested = CONFIG.windowsPriority;
  if (!Object.hasOwn(PRIORITIES, requested)) throw violation('process_priority', `unknown scheduling class '${requested}'`);
  if (process.platform !== 'win32') {
    log(`PROCESS PRIORITY role=${role} pid=${pid} platform=${process.platform} windows_setting=not_applicable`);
    return { ok: true, applicable: false };
  }
  const changed = guardExternalSync('process_priority', `os.setPriority for ${role} pid ${pid}`,
    () => os.setPriority(pid, PRIORITIES[requested]));
  if (!changed.ok) {
    log(`WARNING PROCESS PRIORITY role=${role} pid=${pid} requested=${requested} denied=${changed.reason}`);
    return changed;
  }
  const read = guardExternalSync('process_priority', `os.getPriority for ${role} pid ${pid}`,
    () => os.getPriority(pid));
  if (!read.ok) {
    log(`WARNING PROCESS PRIORITY role=${role} pid=${pid} requested=${requested} unread=${read.reason}`);
    return read;
  }
  const actual = Object.keys(PRIORITIES).find(name => PRIORITIES[name] === read.value) || String(read.value);
  const ok = read.value === PRIORITIES[requested];
  log(`${ok ? '' : 'WARNING '}PROCESS PRIORITY role=${role} pid=${pid} requested=${requested} actual=${actual}`);
  return { ok, actual, requested, applicable: true };
}

module.exports = { apply };
