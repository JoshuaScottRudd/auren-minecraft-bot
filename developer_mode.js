'use strict';
// developer_mode — the one command that turns the workshop on or off for a download. Everything else at
// this level is about playing the game; this is the exception.
//
//     node developer_mode.js            shows whether it is open, and what opening it reveals
//     node developer_mode.js on         open it — stays open on this machine until closed
//     node developer_mode.js off        close it again
//
// A person who wants bots building a house meets exactly the play commands and nothing about a soak
// harness, a combat arena or a trace lens. A person changing the code needs all of it. This one door
// decides which of the two a session is, and the caller states which by the verb it passes.
//
// Whoever works on the code opens this same door to do it (Law 16): nothing here checks whose machine it
// runs on, only whether the command has been run on it.
//
// This file gates every other tool and is itself ungated — a gate that gated its own opening would have
// no handle on the inside. It sits at the top of the bot beside `start_auren.js` and `foreman_config.js`,
// the files a person is ever expected to open, and it is the only ungated file that names the workshop.

const fs = require('fs');
const path = require('path');
const door = require('./js_kernel/utils/developer_door');

const verb = (process.argv[2] || 'status').toLowerCase();

// Names each tool developer mode reveals, for a person deciding whether to open the door.
function whatIsBehindIt() {
  console.log('');
  console.log('  What developer mode turns on:');
  console.log('');
  console.log('    Auren_Workshop/tools/preflight.js  the one test: does the tree load and hold its own rules');
  console.log('    Auren_Workshop/fleet_control.js    the world and the fleet, verb by verb');
  console.log('    monitoring/trace_monitor.js        what a run actually did, through its lenses');
  console.log('    Auren_Workshop/tools/              the benches: combat, siting, pathfinding, seeds, latency');
  console.log('    Auren_Workshop/camera/             the camera crew (watch a run through it; nothing records)');
  console.log('');
  console.log('  It changes NOTHING about how the bots play. No bot process reads this setting, and');
  console.log('  `node start_auren.js` behaves identically either way.');
  console.log('');
}

if (verb === 'on') {
  // Records when and where the door opened, for a person who finds the marker file and wonders what it
  // is; the bot reads nothing from it.
  const stamp = `developer mode opened ${new Date().toISOString()} on ${require('os').hostname()}\n`
    + 'Delete this file, or run `node developer_mode.js off`, to close it again.\n'
    + 'It is untracked and per-machine: it cannot travel through git and is not in the published copy.\n';
  fs.writeFileSync(door.MARKER, stamp);
  console.log('\n  Developer mode is ON. The workshop is open on this machine.');
  whatIsBehindIt();
  console.log('  Start here:  node Auren_Workshop/tools/preflight.js');
  console.log('               Auren_Workshop/README.md   — the map of everything\n');
  process.exit(0);
}

if (verb === 'off') {
  if (!door.isOpen()) {
    console.log('\n  Developer mode was already off. Nothing changed.\n');
    process.exit(0);
  }
  fs.rmSync(door.MARKER);
  console.log('\n  Developer mode is OFF. Every tool, bench, lens and scripted run will refuse again.');
  console.log('  The bots are untouched — `node start_auren.js` works exactly as before.\n');
  process.exit(0);
}

if (verb === 'status' || verb === '--help' || verb === '-h' || verb === 'help') {
  if (door.isOpen()) {
    console.log(`\n  Developer mode is ON.`);
    console.log(`  ${path.relative(process.cwd(), door.MARKER)} says:`);
    for (const l of (door.whenOpened() || '').split('\n')) console.log(`      ${l}`);
    whatIsBehindIt();
    console.log('  Close it with:  node developer_mode.js off\n');
  } else {
    console.log('\n  Developer mode is OFF — this is an ordinary copy of Auren.');
    console.log('');
    console.log('  To play:   node start_auren.js      then say "foreman get" in chat');
    console.log('  To build:  node developer_mode.js on');
    whatIsBehindIt();
  }
  process.exit(0);
}

console.error(`\n  '${verb}' is not something this does. It takes 'on', 'off', or nothing at all.\n`);
process.exit(1);
