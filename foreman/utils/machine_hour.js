// module: machine_hour
// purpose: THE MACHINE'S HOUR — one hour a day the computer has to itself, and the rest of the day it is
//          the fleet's.
//
// WHY THIS FILE EXISTS. Windows runs its upkeep (virus scans, drive care, disk checks, cleanup) whenever
// nobody has touched the keyboard or mouse for a while. A fleet working by itself looks like an empty
// desk all day, so that upkeep lands in the middle of a run, dozens of jobs in one second on the drive
// the world is saving to, and the server stops answering. The upkeep is wanted; its timing is the fault.
//
// WHAT IT DOES. `foreman_config.machineHour` names when the hour opens and closes ('00:00-01:00'). Three parts:
//   the machine   `ensure()` switches off Windows' own starting of upkeep and gives Windows two daily
//                 jobs: start all upkeep when the hour opens, stop it when the hour closes. Those jobs
//                 belong to Windows and fire every day, whether a fleet is running or not.
//   the foreman   `armPause()` ends the run on the one shutdown road when the hour opens, having left a
//                 note saying when the hour closes and how much soak was left.
//   the launcher  `start_auren.js` finds the note, waits the hour out, and raises the foreman again as a
//                 continue start with the soak that was left.
//
// Every call that reaches Windows goes through `external_library_guard` and is read back.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { guardExternalSync } = require('../../js_kernel/utils/external_library_guard');
const { RECORDS_DIR } = require('../../js_kernel/utils/record_homes');

const TAG = 'machine_hour';
const OFF = 'off';
const MAINTENANCE_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance';
const HELD_OFF = 'MaintenanceDisabled';
const UPKEEP = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'MSchedExe.exe');
const JOB_OPEN = 'Auren machine hour - open';
const JOB_CLOSE = 'Auren machine hour - close';
const NOTE = path.join(RECORDS_DIR, 'machine_hour.json');

// parse('00:00-01:00') → { hour, minute, minutes } · parse('off') → null · anything else → undefined (the
// page is wrong). The hour may cross midnight; it is longer than nothing and shorter than a day.
function parse(value) {
  if (value === OFF) return null;
  const m = typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return undefined;
  const minutes = ((Number(m[3]) * 60 + Number(m[4])) - (Number(m[1]) * 60 + Number(m[2])) + 1440) % 1440;
  return minutes > 0 ? { hour: Number(m[1]), minute: Number(m[2]), minutes } : undefined;
}

const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// The next moment the hour opens, strictly after `now`.
function nextOpening(at, now = new Date()) {
  const opens = new Date(now);
  opens.setHours(at.hour, at.minute, 0, 0);
  if (opens <= now) opens.setDate(opens.getDate() + 1);
  return opens;
}

function run(what, file, args) {
  const r = guardExternalSync(TAG, what, () => spawnSync(file, args, { encoding: 'utf8', windowsHide: true }));
  if (!r.ok) return { ok: false, why: r.reason };
  if (r.value.error) return { ok: false, why: r.value.error.message };
  return { ok: r.value.status === 0, why: `${(r.value.stderr || r.value.stdout || '').trim().split(/\r?\n/)[0] || `exit code ${r.value.status}`}`, out: r.value.stdout || '' };
}

const heldOff = () => /MaintenanceDisabled\s+REG_DWORD\s+0x1\b/.test(run('reading whether Windows starts its own upkeep', 'reg.exe', ['query', MAINTENANCE_KEY, '/v', HELD_OFF]).out || '');
const jobAt = (name) => {
  const m = /Start Time:\s+(\d{1,2}):(\d{2}):\d{2}\s*(AM|PM)?/i.exec(run(`reading the Windows job '${name}'`, 'schtasks.exe', ['/Query', '/TN', name, '/V', '/FO', 'LIST']).out || '');
  if (!m) return null;
  const hour = m[3] ? (Number(m[1]) % 12) + (/pm/i.test(m[3]) ? 12 : 0) : Number(m[1]);
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
};

// ensure(value) → { ok, applies, why }. Makes the machine keep the hour, and proves it by reading back.
function ensure(value) {
  const at = parse(value);
  if (at === null) return { ok: true, applies: false, why: `machineHour is 'off' — the computer chooses its own time for upkeep` };
  if (process.platform !== 'win32') return { ok: true, applies: false, why: 'machineHour is a Windows arrangement, and this is not Windows — the run is not paused for it' };
  const closes = new Date(2000, 0, 1, at.hour, at.minute + at.minutes);
  const want = { [JOB_OPEN]: [clock(new Date(2000, 0, 1, at.hour, at.minute)), 'Start'], [JOB_CLOSE]: [clock(closes), 'Stop'] };
  const standing = () => heldOff() && Object.entries(want).every(([name, [time]]) => jobAt(name) === time);
  if (standing()) return { ok: true, applies: true, why: `Windows keeps its upkeep to ${want[JOB_OPEN][0]}–${want[JOB_CLOSE][0]} every day` };

  const steps = [run('switching off Windows\' own starting of upkeep', 'reg.exe', ['add', MAINTENANCE_KEY, '/v', HELD_OFF, '/t', 'REG_DWORD', '/d', '1', '/f'])];
  for (const [name, [time, verb]] of Object.entries(want)) {
    steps.push(run(`giving Windows the daily job '${name}'`, 'schtasks.exe',
      ['/Create', '/TN', name, '/TR', `"${UPKEEP}" ${verb}`, '/SC', 'DAILY', '/ST', time, '/RL', 'HIGHEST', '/F']));
  }
  if (standing()) return { ok: true, applies: true, why: `Windows now keeps its upkeep to ${want[JOB_OPEN][0]}–${want[JOB_CLOSE][0]} every day (set up just now)` };
  const failed = steps.find(s => !s.ok);
  return { ok: false, applies: true, why: `Windows could not be given the hour${failed ? `: ${failed.why}` : ''}. `
    + `Setting it up needs an administrator terminal, once per computer. Start Auren from one, or set machineHour: 'off' in foreman_config.js.` };
}

// armPause(value, { soakEndsAt, shutdown, log }) — the foreman's half: end the run when the hour opens.
function armPause(value, { soakEndsAt, shutdown, log }) {
  const at = parse(value);
  if (!at || process.platform !== 'win32') return;
  const opens = nextOpening(at);
  const closes = new Date(opens.getTime() + at.minutes * 60000);
  log(`the machine's hour: ${clock(opens)}–${clock(closes)} — the run stops for it and carries on after.`);
  require('../../js_kernel/utils/timeout_crash').later(TAG, 'end the run when the machine\'s hour opens', () => {
    const ends = soakEndsAt();
    const left = ends ? Math.max(1, Math.round((new Date(ends).getTime() - Date.now()) / 60000)) : 0;
    fs.writeFileSync(NOTE, JSON.stringify({ opened_at: new Date().toISOString(), closes_at: closes.toISOString(), soak_left_min: left }));
    shutdown(`the machine's hour opened — the run carries on at ${clock(closes)}`, 0);
  }, opens.getTime() - Date.now());
}

// takeNote() → { closes_at, soak_left_min } | null. Read once: taking it removes it.
function takeNote() {
  if (!fs.existsSync(NOTE)) return null;
  const read = guardExternalSync(TAG, 'reading the note the foreman left for the machine\'s hour', () => JSON.parse(fs.readFileSync(NOTE, 'utf8')));
  fs.rmSync(NOTE, { force: true });
  return read.ok ? read.value : null;
}

module.exports = { OFF, parse, nextOpening, ensure, armPause, takeNote, clock };
