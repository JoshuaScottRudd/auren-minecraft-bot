'use strict';
// Writes the server.properties and gamerules this fleet needs into a server's own file (Law 16),
// reporting every change instead of asking first (Law 6). The password it mints goes to the caller only, never printed.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { parseServerProperties: readProps } = require('./rcon_link');
const { SPAWN_PROTECTION_RADIUS, BOT_SENIORITY } = require('../../Thinking_fragments/architect_config');

const REQUIRED = [
  { key: 'online-mode', value: 'false',
    why: 'the bots log in without Minecraft accounts, and a server in online mode refuses every one of them' },
  { key: 'enable-rcon', value: 'true',
    why: 'a crew is brought to where you stand through the server console, and a bot that cannot be placed does not start' },
];

// max-players is computed from the roster, so adding a bot stays one edit (Law 16): a seat for every bot
// and one for a camera on each, plus four — the Foreman's own body, the camera rig's scout, the seat a
// person flies, and the seat a person plays from.
const ROSTER_SIZE = Object.keys(BOT_SENIORITY).length;
const FLEET_SLOTS = ROSTER_SIZE * 2 + 4;

// Settings the fleet cannot run correctly without, asserted at every launch instead of trusted to a
// server's own file — each entry's `why` names what it protects. spawn-protection matches
// SPAWN_PROTECTION_RADIUS, the same square `perception_nodes.js/spawn_protection` keeps the bots out of
// (Law 16). difficulty is temporarily 'peaceful' while a separate subsystem is under construction;
// spawn-monsters stays 'true' so restoring 'hard' is one word. All four load once at JVM start, so a live
// server holding the wrong value can only be reported and restarted, never hot-corrected.
const FLEET_PROPS = [
  { key: 'max-players', value: String(FLEET_SLOTS),
    why: `the roster is ${ROSTER_SIZE} bots and each may have a camera, the foreman and the camera scout hold a slot each, and two are left for a person` },
  { key: 'spawn-protection', value: String(SPAWN_PROTECTION_RADIUS),
    why: 'the bots avoid exactly this square around world spawn, so the server must protect the same one' },
  { key: 'difficulty', value: 'peaceful',
    why: 'peaceful while the builder is under construction (Architect 2026-08-30)' },
  { key: 'spawn-monsters', value: 'true', why: 'left on so restoring hard difficulty is one word' },
  { key: 'spawn-animals', value: 'true', why: 'the crews farm and hunt' },
  { key: 'sync-chunk-writes', value: 'false',
    why: 'with it on, a chunk save blocks the game thread for minutes and every client times out' },
];

// Gamerules, not properties: settable over rcon at any time instead of only at JVM start, so this applies
// to both a fresh server and one already running, and is re-asserted every launch because a snapshot
// rollback restores whatever value it held in level.dat. mob_griefing is off so build terrain stays the
// same between trials; spawn_phantoms is off since death_manager already returns a body, so no bed is needed.
// advance_weather is off and the weather is cleared with it (foreman_world), so no run films or works in rain.
// show_advancement_messages is off so the chat carries the foreman's announcements and nothing else.
//
// Names match `architect_config.SERVER_MINECRAFT_VERSION` (Law 16): 26.1 renamed every gamerule from
// camelCase to snake_case, so an older server rejects these — the read-back below turns that into a named
// warning instead of a silent no-op.
const REQUIRED_GAMERULES = { mob_griefing: 'false', spawn_phantoms: 'false', advance_weather: 'false', show_advancement_messages: 'false' };

// Every property a world needs, in one list: the two a person's own server must have for the bots to join at
// all, then the fleet's own. `prepare` writes all of them; `REQUIRED_PROPS` is the same list as a lookup,
// for fleet_control's check of a server it finds already running.
REQUIRED.push(...FLEET_PROPS);
const REQUIRED_PROPS = Object.fromEntries(REQUIRED.map(r => [r.key, r.value]));

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

// levelName(serverDir) → the world folder's name (`level-name`), as the server's own file says.
function levelName(serverDir) {
  return readProps(fs.readFileSync(propertiesFile(serverDir), 'utf8'))['level-name'] || 'world';
}

// serverAnswers(port) → Promise<boolean>: is something accepting connections on this machine's port NOW,
// sensed with a bare connect so polling early writes nothing to any record.
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

// base64url keeps the password inside RCON auth's ASCII, no escaping needed in a properties file.
function mintPassword() {
  return `auren-${crypto.randomBytes(18).toString('base64url')}`;
}

// prepare(serverDir, { serverUp }) → { file, password, rconPort, serverPort, minted, changes: [{ key, why }] }
// `serverUp` is the caller's sensed fact about the world right now (Invariant B); it decides whether a new password can take.
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

  // Properties load once, at boot: a password minted while the server is down is read by the next boot and
  // good for one only; a server already up keeps its current password, since minting would strand its open console.
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

// A run's clock states a time AND whether the cycle advances from it: `advance_time` persists in
// level.dat, so a pinned run would leave every later 'dawn' run frozen at sunrise. 'held' (no row here)
// leaves the world's current time alone. Midday instead of day 1000: the flattest shadows on a build.
const CLOCKS = {
  dawn: { time: '0',    cycle: 'true',  said: 'set to DAWN, and the day runs on from there' },
  day:  { time: '6000', cycle: 'false', said: 'PINNED AT MIDDAY — the daylight cycle frozen, so it stays light for the whole run' },
};

module.exports = { prepare, serverPort, levelName, serverAnswers, REQUIRED, REQUIRED_PROPS, REQUIRED_GAMERULES, CLOCKS };
