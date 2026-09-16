'use strict';
// server_settings — THE ONE PLACE that writes what this fleet needs into a server's `server.properties`
// (Law 16). Two callers, one verb: `start_auren.js` (a person's own server) and
// `Auren_Workshop/host_and_run.js` (a machine that hosts its own world).
//
// ── WHY THE BOT WRITES THEM INSTEAD OF ASKING (Architect 2026-09-14) ────────────────────────────────────
// *"if the bot cannot run without it then its a useless step to stop for human verification. it should
// instead report loudly what it did and why."* The fleet cannot place a single crew without these settings,
// so asking a person to type them is a step with exactly one correct answer — a step the machine takes, and
// then says it took (Law 6: the change and its reason are printed, never silent).
//
// ── WHAT IS REQUIRED, AND WHY EACH ONE ─────────────────────────────────────────────────────────────────
//   online-mode=false   the bots log in without Minecraft accounts; an online-mode server refuses every one.
//   enable-rcon=true    a crew is brought to where the person stands with one `tp` through the server
//                       console, and a bot that cannot be placed does not start.
//   rcon.password       Minecraft opens no console with a blank password ("No rcon password set in
//                       server.properties, rcon disabled!"), so blank is not an option — a random one is.
//
// ── THE PASSWORD IS ONE-TIME, AND THE SERVER DECIDES WHEN A NEW ONE CAN TAKE ───────────────────────────
// *"make a RNG and make the password one time use."* A server reads this file ONCE, at boot. So a fresh
// password is minted only when the caller says the server is DOWN: written now, read by the next boot,
// discarded by the one after. Minting under a server that is already UP would strand the running console
// behind a password this file no longer holds — measured 2026-09-10 in `host_and_run`, where it made the
// stop that preceded the mint fail auth and halted the run. With the server up, the file's current password
// IS the running server's, so it is read and used, and nothing is minted.
//
// It is `crypto.randomBytes`, not `Math.random`: the same code prepares a world other people can join, and
// a guessable console password on that machine is a console anyone who reaches the port can drive.
// base64url keeps it inside the ASCII that RCON's auth packet carries and needs no escaping in a properties file.
//
// ── IT NEVER PRINTS THE PASSWORD ───────────────────────────────────────────────────────────────────────
// The change list says the password was replaced and why; the value goes to the caller only, which hands it
// to its children through the environment (the one place the fleet learns a console password from).

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { parseServerProperties: readProps } = require('./rcon_link');

const REQUIRED = [
  { key: 'online-mode', value: 'false',
    why: 'the bots log in without Minecraft accounts, and a server in online mode refuses every one of them' },
  { key: 'enable-rcon', value: 'true',
    why: 'a crew is brought to where you stand through the server console, and a bot that cannot be placed does not start' },
];

function propertiesFile(serverDir) {
  const file = path.join(serverDir, 'server.properties');
  if (!fs.existsSync(file)) {
    throw new Error(`There is no server.properties in ${serverDir}. That file is written the first time a Minecraft `
      + `server starts in its folder — start your server there once, then run Auren again.`);
  }
  return file;
}

// serverPort(serverDir) → the port this server listens on for players, as its own file says.
function serverPort(serverDir) {
  return parseInt(readProps(fs.readFileSync(propertiesFile(serverDir), 'utf8'))['server-port'], 10) || 25565;
}

// serverAnswers(port) → Promise<boolean>: is something accepting connections on this machine's port NOW.
// The sensed fact `prepare` needs, and a cheap one to poll: a bare connect writes nothing to any record,
// where an RCON probe per poll would log a failed handshake every time it was early.
function serverAnswers(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

// Replace the key's line in place, or append it — the rest of the file is the owner's and stays byte-for-byte.
function setKey(text, key, value) {
  const line = new RegExp(`^${key.replace(/\./g, '\\.')}=.*$`, 'm');
  return line.test(text) ? text.replace(line, `${key}=${value}`) : `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
}

function mintPassword() {
  return `auren-${crypto.randomBytes(18).toString('base64url')}`;
}

// prepare(serverDir, { serverUp }) → { file, password, rconPort, serverPort, minted, changes: [{ key, why }] }
//
// `serverUp` is the caller's sensed fact about the world right now (Invariant B), never remembered: it is
// what decides whether a new password can take.
function prepare(serverDir, { serverUp }) {
  if (typeof serverUp !== 'boolean') throw new Error('server_settings.prepare: serverUp must be true or false — the caller senses whether the server is running');
  const file = propertiesFile(serverDir);
  let text = fs.readFileSync(file, 'utf8');
  const props = readProps(text);
  const changes = [];

  for (const req of REQUIRED) {
    if (props[req.key] === req.value) continue;
    text = setKey(text, req.key, req.value);
    changes.push({ key: `${req.key}=${req.value}`, why: req.why });
  }

  const current = props['rcon.password'] || '';
  const minted = !serverUp || !current;
  const password = minted ? mintPassword() : current;
  if (minted) {
    text = setKey(text, 'rcon.password', password);
    changes.push({
      key: 'rcon.password (a new random one)',
      why: serverUp
        ? 'there was none, and the console will not open without one'
        : 'a fresh one every time Auren starts before your server, so it is only ever good for one boot and cannot be guessed',
    });
  }

  if (changes.length) fs.writeFileSync(file, text);
  return {
    file,
    password,
    rconPort: parseInt(props['rcon.port'], 10) || 25575,
    serverPort: parseInt(props['server-port'], 10) || 25565,
    minted,
    changes,
  };
}

module.exports = { prepare, serverPort, serverAnswers, REQUIRED };
