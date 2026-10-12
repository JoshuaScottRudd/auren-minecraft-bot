// alarm_block — THE ONE RED BLOCK NOBODY CAN SCROLL PAST (Law 16).
//
// WHY IT EXISTS: whatever process kills the entire fleet must report visually on the screen. Two
// processes raise that report and they sit on opposite sides of a layer: the FOREMAN, when it catches
// its own crash, and `start_auren.js`, when the foreman dies without ever announcing an ending. One
// shape, one implementation, here.
//
// THIS FILE RENDERS AND NOTHING ELSE. `foreman/utils/say.js` wraps it to ALSO write the words into the
// foreman's record, because the foreman has a record and the launcher does not — that difference is the
// whole reason the record half could not live down here. A renderer that also filed a report would make
// `start_auren` write into a record it does not own.
//
// IT DELIBERATELY DOES NOT DECIDE WHETHER TO FIRE. Callers own the predicate; this owns the pixels.

'use strict';

const WIDTH = 80;
const WRAP = 76;

// blockLines(lines) → the rendered rows, so a caller that wants to send them somewhere other than the
// console (a record, a test) gets the same words without this file knowing about that destination.
function blockLines(lines) {
  const A = '\x1b[41m\x1b[97m\x1b[1m';
  const R = '\x1b[0m';
  const bar = '!'.repeat(WIDTH);
  const rows = [];
  for (const l of lines) {
    let row = '';
    for (const word of String(l).split(' ')) {
      if (row && (row + ' ' + word).length > WRAP) { rows.push(row); row = word; } else row = row ? `${row} ${word}` : word;
    }
    rows.push(row);
  }
  return [`${A}${bar}${R}`, ...rows.map(r => `${A}  ${r.padEnd(WIDTH - 2)}${R}`), `${A}${bar}${R}`];
}

// print(lines) → the block on stdout. Synchronous on purpose: every caller is on its way out of the
// process, and a buffered write that never flushed is the silence this whole module exists to end.
function print(lines) {
  for (const row of blockLines(lines)) console.log(row);
}

module.exports = { blockLines, print };
