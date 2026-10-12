// foreman_gone — WHEN THE ARBITER DIES, ONE BODY STAYS UP AND SAYS SO.
//
// Each bot watches the foreman directly: a process whose whole job is to notice a death can itself be
// closed, and the only fix for that would be another process to watch it (Law 16). Each body already
// holds a socket to the arbiter and already ends itself when it closes; the witness is one of those
// bodies claiming the report, not a new process.
//
// The role is claimed atomically, since the arbiter is the thing that died: no process can arbitrate
// which body stays, so it is settled by the one primitive that needs no referee, an exclusive file
// create (`wx`). The OS makes exactly one of them succeed; the rest end as they always did.
//
// The witness stops being able to exit: the Minecraft server is the foreman's child and dies with it, so
// every body's `bot.on('end')` fires and would end the process too — by its own handler or a soak timer,
// whichever arrives first. `body_end` asks `isWitness()` before it exits, and one flag in one place is
// what keeps this process on screen: a process with a job left does not exit (Law 8).

'use strict';

const fs = require('fs');
const path = require('path');

const alarmBlock = require('@utils/alarm_block');
const recordHomes = require('@utils/record_homes');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'foreman_gone';

// The claim. It lives in `fleet_logs/`, which a start empties whole, so it cannot be a leftover that
// silences the next run's report (record_homes' standing rule).
const CLAIM_FILE = path.join(recordHomes.RECORDS_DIR, 'foreman_gone.claim');

let _witness = false;

// isWitness() → does this process still have a job to do. Read by `body_end` before every exit.
function isWitness() {
  return _witness;
}

// standAsWitness(botId) → true if THIS body is the one that stays up.
//
// `wx` is create-exclusive: the OS answers the race, once, with no coordinator. A body that loses is not
// failing — it is being told another body already has the floor — so the losing answer is an ordinary
// `false` and the caller ends itself the way it always did (Law 25).
function standAsWitness(botId) {
  if (_witness) return true;
  fs.mkdirSync(recordHomes.RECORDS_DIR, { recursive: true });
  const claim = guardExternalSync(TAG, `fs.openSync(${path.basename(CLAIM_FILE)}, 'wx') — claiming the report`,
    () => fs.openSync(CLAIM_FILE, 'wx'));
  if (!claim.ok) return false;
  fs.closeSync(claim.value);
  fs.writeFileSync(CLAIM_FILE, `${botId} at ${new Date().toISOString()}\n`);
  _witness = true;
  return true;
}

// The words: written for somebody who has just closed a window and does not yet know that is what they
// did, so it says what happened, what it means, and what to do — and says outright that the foreman is
// required.
function lines(botId) {
  return [
    'THE FOREMAN IS GONE, AND THE WHOLE FLEET STOPPED WITH IT.',
    '',
    `${botId} noticed and stayed online to tell you. Every other bot has ended.`,
    '',
    'THE FOREMAN IS REQUIRED FOR THE BOTS TO RUN.',
    'The bots ask it which tree, which chest, whose turn it is to think.',
    'Without it they have no arbiter, so they stop rather than work',
    'unsupervised and claim the same block as each other. This is by design.',
    '',
    'WHAT USUALLY CAUSES THIS:',
    'The foreman window was closed with the X button or Ctrl-C, or its',
    'process was ended from Task Manager. The Minecraft server is the',
    "foreman's own child, so it went down too.",
    '',
    'WHAT IT MEANS FOR THE WORLD:',
    'If the foreman was killed outright it never asked the world to save,',
    'so the last few moments of building may not be on disk.',
    '',
    'TO RUN AGAIN:',
    '    node Auren_Workshop/fleet_control.js down     (close leftovers)',
    '    node start_auren.js                           (start over)',
    '',
    'This window is safe to close. Nothing is running behind it.',
  ];
}

// announce(botId) — put the block where a person will actually see it.
//
// Goes to the file, not to stdout: this body's stdout is a pipe into the foreman, and the foreman is the
// corpse, so anything written there goes nowhere. What is still on screen is the follower window bearing
// this bot's name, a separate process tailing `console_<botId>.log` with `Get-Content -Wait`, and that
// window outlives a force-killed foreman. The body appends to the file its own window is reading, so the
// sentence arrives on screen through machinery that is already standing. stdout gets it too, for the
// case where a body was started by hand and owns its console.
function announce(botId) {
  const block = alarmBlock.blockLines(lines(botId)).join('\n');
  const text = `\n${block}\n`;
  const file = recordHomes.consoleLogFile(botId);
  const wrote = guardExternalSync(TAG, `fs.appendFileSync(${path.basename(file)}) — the report onto this body's window`,
    () => fs.appendFileSync(file, text));
  console.log(text);
  return wrote.ok;
}

// hold() — the process stays up because the report is the job. The interval stays ref'd: unref tells a
// timer not to keep the process alive, the opposite of this one's purpose.
function hold() {
  require('./timeout_crash').every('foreman_gone', 'keep the window of the witness body open', () => {}, 60000);
}

module.exports = { standAsWitness, isWitness, announce, hold, CLAIM_FILE };
