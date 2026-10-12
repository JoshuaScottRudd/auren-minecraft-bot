'use strict';
// developer_door — the one answer to whether this is a developer session (Law 16). Every tool, bench,
// lens, camera and scripted run asks here before it does anything, and refuses by name when the answer
// is no.
//
// A closed door, not a deletion: the whole workshop ships on disk in every copy; none of it runs,
// prints, or is advertised until somebody deliberately opens developer mode.
//
// One door, one command, for every user (Law 16): opening it is what makes a session a developer
// session. There is no separate automatic path for any machine — a second door is exactly the fault a
// single shared entry point removes.
//
// A file on disk, not an environment variable (Law 13): an environment variable is per-shell and would
// need setting in every terminal or a profile edit, per-machine configuration this arrangement exists to
// avoid. A marker file is opened once per machine and stays; it is untracked and gitignored, so it is
// real, local state that cannot travel through git, and cannot ride out in a published snapshot built
// from tracked files — a downloaded copy has a closed door by construction.

const fs = require('fs');
const path = require('path');

const BOT_ROOT = path.resolve(__dirname, '..', '..');
const MARKER = path.join(BOT_ROOT, '.developer_mode');
const DOOR_CMD = 'node developer_mode.js on';

// isOpen() → boolean. The whole question, asked one way.
function isOpen() {
  return fs.existsSync(MARKER);
}

// whenOpened() → the marker's own text, or null. Reads the text without parsing it: the file is written
// by `developer_mode.js` for a person to read, and nothing here decides anything from its contents
// (Law 26).
function whenOpened() {
  if (!isOpen()) return null;
  return fs.readFileSync(MARKER, 'utf8').trim();
}

// enter(tool) — the one call every tool makes, as its first act. Default state is stopped (Law 13): a
// tool does not decide whether it is harmless enough to run, it asks, and a closed door ends the process
// before anything is spawned, connected to, or written. The message names what was found and the one
// command that opens the door.
function enter(tool) {
  if (isOpen()) return true;
  console.error('');
  console.error(`  ${tool} is a developer tool, and this copy is not in developer mode.`);
  console.error('');
  console.error('  Auren has two doors. The one you want depends on what you are doing:');
  console.error('');
  console.error('    PLAYING          node start_auren.js        then say "foreman get" in chat');
  console.error('    BUILDING ON IT   ' + DOOR_CMD + '     once, then every tool works');
  console.error('');
  console.error('  Developer mode turns on the workshop: the scripted runs, the benches, the combat');
  console.error('  arena, the cameras, and the lenses that read a run record. It changes nothing about');
  console.error('  how the bots play — it is a door, not a setting, and you can close it again with');
  console.error('  `node developer_mode.js off`.');
  console.error('');
  process.exit(1);
}

module.exports = { isOpen, whenOpened, enter, MARKER, DOOR_CMD };
