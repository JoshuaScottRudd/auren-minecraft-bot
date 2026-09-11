'use strict';
// developer_mode — THE ARCHITECT'S DOOR. The one command that turns the workshop on, and the only file
// at this level that is not about playing the game.
//
//     node developer_mode.js            is the door open, and what is behind it
//     node developer_mode.js on         open it — once per machine, it stays
//     node developer_mode.js off        close it again
//
// ── WHAT THIS IS FOR (Architect 2026-09-11) ─────────────────────────────────────────────────────────
// *"there is a difference between a regular person using my code, fewer knobs and tools. if you want to
// work on the code then you go into debug mode or developer mode and must enter through the architects
// door."*
//
// Auren ships as one piece — every tool the Architect uses is in this download, because a tool that
// cannot read the bot cannot fix the bot. But shipping something is not the same as putting it in front
// of somebody. A person who wants two bots building a house should meet exactly two commands and no
// mention of a soak harness, a combat arena or a trace lens. A person who wants to change the code needs
// all of it. **One door decides which of those two people you are, and you tell it which.**
//
// ── IT IS THE SAME DOOR THE ARCHITECT USES, DELIBERATELY ────────────────────────────────────────────
// *"a user may only use my tools going through my method of troubleshooting. meaning when they attempt to
// fix things and use my tools then they are now the architect and must enter through the system the same
// way i do."*
//
// Nothing here checks whose machine this is. His machines are machines where this command has been run,
// which is the only difference there is. That matters beyond tidiness: a door that opened itself for him
// would be a path only he ever walks, and the whole point of the arrangement is that there is no such
// path left (Law 16, and the same reasoning that split `run.js` from `host_and_run.js`).
//
// ── WHY THIS FILE IS NOT ITSELF BEHIND THE DOOR ─────────────────────────────────────────────────────
// It is the door. A gate that gated its own opening would be a room with no handle on the inside. It
// therefore sits at the top of the bot beside `start_auren.js` and `your_server.js` — the three files a
// person is ever expected to open — and it is the ONLY ungated thing that mentions the workshop exists.

const fs = require('fs');
const path = require('path');
const door = require('./js_kernel/utils/developer_door');

const verb = (process.argv[2] || 'status').toLowerCase();

// WHAT IS BEHIND THE DOOR, named rather than counted. A person deciding whether to open it needs to know
// what appears, and "34 tools" tells them nothing they can act on.
function whatIsBehindIt() {
  console.log('');
  console.log('  What developer mode turns on:');
  console.log('');
  console.log('    Auren_Workshop/run.js              a whole scripted run — a crew, a soak, read at the end');
  console.log('    Auren_Workshop/host_and_run.js     the same run, on a world it starts and stops for you');
  console.log('    Auren_Workshop/tools/preflight.js  the one test: does the tree load and hold its own rules');
  console.log('    Auren_Workshop/fleet_control.js    the world and the fleet, verb by verb');
  console.log('    monitoring/trace_monitor.js        what a run actually did, through its lenses');
  console.log('    Auren_Workshop/tools/              the benches: combat, siting, pathfinding, seeds, latency');
  console.log('    Auren_Workshop/camera/             the camera crew and the OBS bridge');
  console.log('');
  console.log('  It changes NOTHING about how the bots play. No bot process reads this setting, and');
  console.log('  `node start_auren.js` behaves identically either way.');
  console.log('');
}

if (verb === 'on') {
  // The stamp is for a person who finds this file in six months and wonders what it is. Nothing reads it.
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
