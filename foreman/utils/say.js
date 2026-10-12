'use strict';
// foreman/utils/say.js — how the foreman speaks in its own window: a log line, and an alarm nobody can
// scroll past.
//
//   log(msg)       one line to the window and the same line to the foreman's record
//   alarm(lines)   a red block in the window, and the same words in the record

const record = require('../foreman_record');
const alarmBlock = require('@utils/alarm_block');

// ONE CALL, TWO DESTINATIONS, A LOGGER, NOT TWO PATHWAYS (Law 16). The console half is the desk's live
// window — the one a person watches while standing in the world, and the one the probe reads — written
// explicitly because naming the unit above would silence the watcher's own echo. The record half is what
// outlives the window.
function log(msg) {
  console.log(`[${new Date().toISOString()}] [FOREMAN] ${msg}`);
  record.note(msg);
}

// The one alarm shape: a red block a person cannot scroll past, plus the same words in the record.
//
// The block's rendering lives in `@utils/alarm_block`, shared with `start_auren.js`, which raises the
// identical block when the foreman dies without announcing an ending but has no foreman record to write
// into. So the RENDERING is shared and the RECORDING — what makes this the foreman's own alarm — stays here.
function alarm(lines) {
  alarmBlock.print(lines);
  record.note(`ALERT: ${lines.join(' ')}`);
}

module.exports = { log, alarm };
