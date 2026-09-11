'use strict';
// developer_door — the ONE answer to "is this a developer session?" (Law 16). Every tool, bench, lens,
// camera and scripted run asks here before it does anything, and refuses by name when the answer is no.
//
// ── WHY A DOOR AND NOT A DELETION (Architect 2026-09-11) ────────────────────────────────────────────
// *"i want there to be a complete void between what i use and the user uses but at the same time i can
// use it and it doesent prevent me from using my tools according to my machine and the user who runs it
// wont have to reconfigure for their machine by removing anything… a user who is just running the bots
// shall not know that the tools are there and should not start for any of their processes… if you want to
// work on the code then you go into debug mode or developer mode and must enter through the architects
// door."*
//
// The 2026-09-10 ruling stands and is not in tension with this one: *"the tools need to live with the bot
// to read the bot and i should just ship the whole thing as one piece."* Everything still ships. What
// changes is that shipping is no longer the same act as OFFERING. The whole workshop is on disk in every
// copy; none of it runs, prints, or is advertised until somebody deliberately becomes a developer.
//
// ── THE SAME DOOR FOR BOTH, AND THAT IS THE WHOLE POINT (Law 16) ────────────────────────────────────
// *"a user may only use my tools going through my method of troubleshooting. meaning when they attempt to
// fix things and use my tools then they are now the architect and must enter through the system the same
// way i do."*
//
// So this is NOT "open automatically on the Architect's machines". An auto-open would be a second door,
// which is exactly the fault the run/host split was made to remove: his path and a stranger's path
// diverging, with only one of them ever exercised. There is one door, one command, and his machines are
// simply machines where somebody has already opened it.
//
// ── WHY A FILE ON DISK RATHER THAN AN ENVIRONMENT VARIABLE (Law 13, and his constraint) ─────────────
// He asked that the separation *"doesent prevent me from using my tools according to my machine"*. An
// environment variable is per-shell: he would set it in every terminal, or write it into a profile, which
// is per-machine configuration — the thing this arrangement exists to abolish. A marker file is opened
// ONCE per machine and stays. It is untracked and gitignored, so it is the same species of per-machine
// state as the toolchain in `Architect_workstation/`: real, local, and unable to travel through git.
//
// It also cannot ride out in the published snapshot, because that snapshot is built from tracked files.
// A downloaded copy therefore has a closed door by construction, not by a default somebody could change.

const fs = require('fs');
const path = require('path');

const BOT_ROOT = path.resolve(__dirname, '..', '..');
const MARKER = path.join(BOT_ROOT, '.developer_mode');
const DOOR_CMD = 'node developer_mode.js on';

// isOpen() → boolean. The whole question, asked one way.
function isOpen() {
  return fs.existsSync(MARKER);
}

// whenOpened() → the marker's own text, or null. Read rather than parsed: the file is written by
// `developer_mode.js` for a person to read, and nothing decides anything from its contents (Law 26).
function whenOpened() {
  if (!isOpen()) return null;
  return fs.readFileSync(MARKER, 'utf8').trim();
}

// ── enter(tool) — THE ONE CALL EVERY TOOL MAKES, AS ITS FIRST ACT ───────────────────────────────────
// Default state is STOPPED (Law 13): a tool does not decide whether it is "harmless enough" to run. It
// asks, and a closed door ends the process before anything is spawned, connected to, or written.
//
// THE REFUSAL IS A DOOR, NOT A WALL. A person who reached this line typed the name of a tool, so they are
// already trying to do the thing the door is for — the message names what they found and the one command
// that opens it, and does not lecture them about whether they should.
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
