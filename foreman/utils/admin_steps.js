'use strict';
// foreman/utils/admin_steps.js — THE RUN'S ADMIN, AS STEPS THE FOREMAN PROVES LIKE ANY OTHER.
//
// *"run.js is to be removed … foreman should do all the critical stuff like checking no
// windows are open, start the cameras, watch for errors and wakes. so fold everything into foreman. its all now
// foremans job."* These were the workshop run script's opening moves; each is now a step in the shape
// `foreman_steps.runSteps` walks (act, then proof read from the world), so the foreman paces them with the rest.
//
//   terminalsStep()        no terminal from an earlier run is open — checked, never closed
//   clockStep(clock)       the world's time and daylight cycle are what the run asked for
//   camerasStep(opts)      the camera crew is up on the fleet (record: 'cameras' | 'film')
//   stopCameras(why, log)  the camera crew is taken down, recordings finalised first
//
// THE CAMERAS ARE REACHED AS A PROCESS, NOT A REQUIRE. The camera stack lives in the workshop, and no bot file
// requires the workshop (preflight's dependency pass). `record_overlay.js raise` and `stop` are run as children,
// awaited without blocking this process's loop, exactly as a person would run them.

const path = require('path');
const { spawn } = require('child_process');
const consoleWindow = require('@utils/console_window');
const { CLOCKS } = require('@utils/server_settings');
const { guardExternal } = require('@utils/external_library_guard');

const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
// A window opened this close before the foreman's own start is this run's (the launcher opens a window on the
// foreman's console in the same breath as it starts it); anything older is a leftover from an earlier run.
const SAME_RUN_SKEW_MS = 60000;

// ── NO TERMINAL FROM AN EARLIER RUN ──────────────────────────────────────────────────────────────────
// *"before startup it should also check but not close. just prevent another start from happening and say what
// terminals are open that prevents another start. thats our server hang problem"*.
function terminalsStep() {
  let left = [];
  return {
    name: 'no terminal from an earlier run is open',
    proof: async () => {
      left = consoleWindow.openWindows().filter(e => Date.parse(e.started_at) < PROCESS_STARTED_AT - SAME_RUN_SKEW_MS);
      return left.length
        ? { ok: false, final: true, why: `${consoleWindow.describeWindows(left)}. Nothing was closed; close them `
          + `(node Auren_Workshop/fleet_control.js down), then start again.` }
        : { ok: true };
    },
  };
}

// ── THE CLOCK ────────────────────────────────────────────────────────────────────────────────────────
// Set through the console and READ BACK: `advance_time` accepted and not applied would leave a run walking into
// the night it reported it had frozen out. 'held' is not this step's — the world keeps its own time.
function clockStep(clock) {
  const want = CLOCKS[clock];
  const rcon = () => require('@utils/rcon_link');
  return {
    name: `the clock is set (${clock})`,
    when: () => clock !== 'held',
    tries: 2,
    retryAfter: 2000,
    act: async () => {
      await guardExternal('foreman', 'set the clock', () => rcon().once([`gamerule advance_time ${want.cycle}`, `time set ${want.time}`]));
      return null;
    },
    proof: async () => {
      const r = await guardExternal('foreman', 'read the clock back', () => rcon().once(['gamerule advance_time']));
      const said = r.ok ? r.value[0].body : r.reason;
      return r.ok && said.includes(want.cycle) ? { ok: true, why: want.said } : { ok: false, why: `the server says "${said}"` };
    },
  };
}

// ── THE CAMERAS ──────────────────────────────────────────────────────────────────────────────────────
const OVERLAY = path.join(__dirname, '..', '..', 'Auren_Workshop', 'tools', 'record_overlay.js');

// run(args) → { code, out } — a child node process, its output kept for the reason it gives. Resolves on the
// child's EXIT: the camera windows it leaves standing inherit its output pipes, so those never close.
function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [OVERLAY, ...args], { cwd: path.join(__dirname, '..', '..'), windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('error', e => resolve({ code: -1, out: e.message }));
    child.on('exit', code => resolve({ code, out }));
  });
}
const tail = (out) => out.trim().split('\n').slice(-4).join(' | ');

// The config says 'cameras' / 'film'; the overlay's own words are 'watch' / 'record'. Translated here, once.
function camerasStep({ record, count, fill }) {
  let result = null;
  return {
    name: record === 'off' ? 'the cameras are up' : `the cameras are up (${record})`,
    when: () => record !== 'off',
    act: async () => {
      result = await run(['raise', `--overlay=${record === 'film' ? 'record' : 'watch'}`, `--count=${count}`,
        ...(fill ? [] : ['--fill=off'])]);
      return result.code === 0 ? null : { give: `the camera overlay did not come up: ${tail(result.out)}` };
    },
    proof: async () => ({ ok: result && result.code === 0, why: 'cameras are watching the fleet' }),
  };
}

async function stopCameras(why, log) {
  const r = await run(['stop', `--why=${why}`]);
  log(r.code === 0 ? 'cameras: down.' : `WARNING the camera overlay did not come down cleanly: ${tail(r.out)}`);
}

module.exports = { terminalsStep, clockStep, camerasStep, stopCameras };
