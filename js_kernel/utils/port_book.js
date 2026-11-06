/*
port_book.js — which of this machine's ports a run may take, asked of the machine at start.

Two runs on one machine, each from its own Auren_Bot copy, must not share a port: the foreman's pair (its hub and the
in-game door one above it), the Minecraft server's game port and its console (RCON) port. A run asks here for the
first free one at or after its usual number, so the second run to start takes the next free ones and says so, and
neither is refused for the other being up.

A port is FREE when nothing answers a connect on 127.0.0.1 and this process can open a listener on it; the two are
asked together because a server bound to one address can be missed by a listen on another.

runForemanPort() reads the port the run up in THIS copy took, from its run lock (start_auren.js), so the
operator's tools (foreman_door, fleet_control) address the foreman that is actually up.
*/

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { guardExternalSync } = require('./external_library_guard');

// How many ports past the usual one are tried before a start gives up and says so.
const PORT_TRIES = 50;
// The foreman's usual port; the in-game door is the one above it.
const FOREMAN_PORT_USUAL = 3001;

function answers(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function canListen(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

// portFree(port) → Promise<boolean>
async function portFree(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[port_book] CODING VIOLATION (Law 13): portFree needs a port number, got ${port}.`);
  }
  return !(await answers(port)) && canListen(port);
}

// firstFree({ from, width, step, avoid }) → Promise<number|null>: the first port p, starting at `from` and moving
// `step` at a time, with p .. p+width-1 all free and none of them in `avoid`; null after PORT_TRIES tries.
async function firstFree({ from, width = 1, step = 1, avoid = [] }) {
  for (let i = 0, p = from; i < PORT_TRIES; i++, p += step) {
    const span = Array.from({ length: width }, (_, k) => p + k);
    if (span.some(q => avoid.includes(q))) continue;
    let free = true;
    for (const q of span) if (!(await portFree(q))) { free = false; break; }
    if (free) return p;
  }
  return null;
}

// runForemanPort() → the foreman port the run up in this copy took (its run lock), or null when none is written.
function runForemanPort() {
  const lock = path.join(__dirname, '..', '..', 'run_lock.json');
  if (!fs.existsSync(lock)) return null;   // no run up in this copy: the caller uses its usual port
  const read = guardExternalSync('port_book', 'reading the run lock', () => JSON.parse(fs.readFileSync(lock, 'utf8')));
  const port = read.ok && read.value ? read.value.foreman_port : null;
  return Number.isInteger(port) ? port : null;
}

module.exports = { portFree, firstFree, runForemanPort, FOREMAN_PORT_USUAL, PORT_TRIES };
