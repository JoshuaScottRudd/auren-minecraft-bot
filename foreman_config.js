// module: foreman_config
// purpose: EVERYTHING THE FOREMAN IS GIVEN BEFORE IT STARTS — where the world is, and whether the foreman
//          starts that world itself. The one file to edit if the bots cannot find your world, and the only
//          file most people who download this bot will ever need to open.
//
//          Renamed from `your_server.js` on 2026-09-18, when the foreman took ownership of the world.
//
// ── THE FOREMAN OWNS THE PROCESS (Architect 2026-09-18) ─────────────────────────────────────────────
// *"You give everything you need to foreman. Foreman starts first before the server. Then if it says in its
// config a local server then it will start the server. If not and it's on a public one then you give it the
// address and it attempts to connect. If any part of the process fails then the Foreman is a live process
// that can troubleshoot… Who owns the process? Foreman does."*
//
// So `where` below decides one thing, and the foreman does the rest:
//   'local'   the foreman starts the Minecraft server in `serverFolder`, writes the settings the bots need
//             into it (and prints each one and why), watches it run, and stops it when the run ends. If
//             the server fails to start, the foreman reads why and says so in words.
//   'remote'  somebody else runs the world. The foreman connects to `host`/`port`, says plainly why it
//             could not if it cannot, and never starts or stops that world.
//
// THIS REVERSES TWO EARLIER RULINGS, and the record keeps them. On 2026-09-11 this file said *"You start your
// server and you stop it. The bots only ever JOIN it… There is no setting here to turn it on, because a config
// flag can be wrong"*, and starting a world belonged to a separate workshop script. Both are superseded by the
// ruling above: one owner of the whole run, told by this file. What survives from the old ruling is its
// safety: the foreman stops only a server it started itself, and refuses to start one where a server is
// already answering, because that one belongs to somebody else.
//
// ── ASSUMED PRESENT, AND A LOUD FAILURE IF IT IS NOT (Law 13) ───────────────────────────────────────
// Nothing here is guessed. If the world cannot be started or reached, the foreman STOPS and names this file
// and the field to change. It never falls back to another port or another address.
//
// ── WHY THESE ARE THE NUMBERS ───────────────────────────────────────────────────────────────────────
// 25565 is Minecraft's own default port and 25575 is the default for RCON, the server's remote console. In
// 'local' mode the foreman reads both off the server's own server.properties instead, which is what the
// server actually listens on.
//
// ── PER-COMPUTER ANSWERS GO IN THE ENVIRONMENT ──────────────────────────────────────────────────────
// Each value has an environment variable named beside it, and the environment wins over this file. Use it
// when the answer differs per computer, because an edit here travels through git to every machine.

'use strict';

// A port is validated rather than trusted: a malformed environment value would otherwise become NaN and
// travel all the way down to a socket error that names nothing (Law 13). A bad value falls back to the
// default below and the foreman's reachability check then says where to look.
function port(envName, fallback) {
  const raw = parseInt(process.env[envName], 10);
  return (Number.isFinite(raw) && raw > 0 && raw < 65536) ? raw : fallback;
}

module.exports = {

  // WHO RUNS THE WORLD: 'local' (the foreman starts it, from serverFolder) or 'remote' (somebody else does,
  // at host/port). Anything else is refused by the foreman at start.
  //                                                   environment override: AUREN_SERVER_WHERE
  where: process.env.AUREN_SERVER_WHERE || 'local',

  // WHERE THE WORLD IS, for 'remote'. A hostname or an IP address. In 'local' mode it is this computer.
  //                                                   environment override: AUREN_SERVER_HOST
  host: process.env.AUREN_SERVER_HOST || 'localhost',

  // The port players connect on — `server-port` in that server's server.properties. In 'local' mode the
  // foreman reads it off the file instead.
  //                                                   environment override: AUREN_SERVER_PORT
  port: port('AUREN_SERVER_PORT', 25565),

  // THE SERVER'S FOLDER, for 'local' — the folder holding server.jar and server.properties, on this computer.
  // This is the one value with no usual answer, so it is the one you fill in.
  //   example (Windows):  serverFolder: 'C:\\Users\\you\\Minecraft\\server',
  //                                                   environment override: AUREN_SERVER_DIR
  serverFolder: process.env.AUREN_SERVER_DIR || '',

  // ── THE SERVER CONSOLE (RCON) ─────────────────────────────────────────────────────────────────────
  // A crew is brought to where you stand through the console, so the bots do not start without it.
  // 'local': leave these alone. The foreman writes a new random password into server.properties each time it
  //          starts the server, and hands it to the bots itself.
  // 'remote': the owner of that world gives you its console port and password, and they go here.
  //                                                   environment override: AUREN_RCON_PORT
  rconPort: port('AUREN_RCON_PORT', 25575),

  //                                                   environment override: AUREN_RCON_PASSWORD
  rconPassword: process.env.AUREN_RCON_PASSWORD || '',
};
