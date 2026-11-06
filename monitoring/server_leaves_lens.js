// Auren_Bot/monitoring/server_leaves_lens.js
// --leaves: every player the server let go, in the server's own words — who lost connection, left or was kicked,
// when, and the reason the server gave. Answers why a body's connection closed when the body's own trace ends
// mid-line (a crash, a kick, a timeout). Reads the run's server console. Inputs as ARGUMENTS, render, RETURN;
// no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --leaves [--bot=B [--tail=N]]   (--bot adds that body's console tail)

'use strict';

const fs = require('fs');
const out = require('./data_out');

// The server's lines for a player going (vanilla console):
//   [12:34:56] [Server thread/INFO]: FaroBot lost connection: Timed out
//   [12:34:56] [Server thread/INFO]: FaroBot left the game
//   [12:34:56] [Server thread/INFO]: Kicked FaroBot: Flying is not enabled on this server
const LOST_RE = /^\[([\d:]+)\].*?: (\w+) lost connection: (.*)$/;
const LEFT_RE = /^\[([\d:]+)\].*?: (\w+) left the game$/;
const KICKED_RE = /^\[([\d:]+)\].*?: Kicked (\w+): (.*)$/;

function runLeaves({ bot: botFilter = null, tail = 40 } = {}) {
  const file = require('path').join(require(require('./lens_paths').bot('js_kernel/utils/record_homes')).RECORDS_DIR, 'console_server.log');
  out.kv('lens', 'leaves');
  out.kv('record', 'console_server.log');
  if (!fs.existsSync(file)) { out.kv('found', false); return; }
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    let m = LOST_RE.exec(line);
    if (m) { rows.push([m[1], m[2], 'lost_connection', m[3]]); continue; }
    m = KICKED_RE.exec(line);
    if (m) { rows.push([m[1], m[2], 'kicked', m[3]]); continue; }
    m = LEFT_RE.exec(line);
    if (m) rows.push([m[1], m[2], 'left', null]);
  }
  const shown = botFilter ? rows.filter(r => r[1] === botFilter) : rows;
  out.kv('found', true);
  out.kv('leaves', shown.length);
  out.section('leaves');
  out.table(['server_time', 'player', 'how', 'reason'], shown);
  if (botFilter) consoleTail(botFilter, tail);
}

// The body's own console (record_homes.consoleLogFile), last `tail` lines: what the process printed outside its
// trace — an uncaught error, a stack, the runtime's out-of-memory report — when the trace ends mid-line.
function consoleTail(bot, tail) {
  const file = require(require('./lens_paths').bot('js_kernel/utils/record_homes')).consoleLogFile(bot);
  out.section('console_tail');
  out.kv('record', require('path').basename(file));
  if (!fs.existsSync(file)) { out.kv('found', false); return; }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
  out.kv('found', true);
  out.kv('lines_total', lines.length);
  out.list('line', lines.slice(-tail));
}

module.exports = { runLeaves };
