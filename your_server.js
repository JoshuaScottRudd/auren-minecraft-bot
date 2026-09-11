// module: your_server
// purpose: WHERE YOUR MINECRAFT SERVER IS — the one file to edit if the bots cannot find your world,
//          and the only file most people who download this bot will ever need to open.
//
//          It is the public twin of the Architect's own machine file. His names exact paths that exist
//          on three computers and nobody else's; this one names the ordinary answer that is true for
//          everybody, including him. Same question, two files, and the shipped one is the default.
//
// ── EVERYTHING HERE IS ALREADY SET FOR THE USUAL CASE ───────────────────────────────────────────────
// The values below describe a Minecraft server running on THIS computer, on the ports a server uses
// when you start one and change nothing. If that is your setup — and it is the ordinary one — there is
// nothing in this file to edit. Start your server, then start the bots, and they will find it.
//
// ── WHO STARTS THE SERVER (Architect 2026-09-11) ────────────────────────────────────────────────────
// *"the difference between the architect scripts and stranger scripts is that the server is started and
// stopped automatically as part of the run. a stranger would start their server and stop it
// seperatley."*
//
// **You start your server and you stop it. The bots only ever JOIN it.** Nothing in this project will
// start, stop, reconfigure or roll back a world it did not create — that belongs to the person who owns
// the world, which is you. The automatic start-and-stop is a convenience that switches itself on only on
// a machine that has declared a server folder it owns, which a download never has. There is no setting
// here to turn it on, because a config flag can be wrong; the presence of a world this project created
// cannot.
//
// ── ASSUMED PRESENT, AND A LOUD FAILURE IF IT IS NOT (Law 13) ───────────────────────────────────────
// *"so assume the server is there, if not crash and report pointing to the spot where to change."*
//
// Nothing here is probed at load and nothing is guessed. The run simply tries to reach the address below
// and, if nothing answers, STOPS and names this file and the field to change. It does not fall back to
// another port, does not scan for a server, and does not start one for you. A bot that quietly connected
// somewhere else would be worse than one that stopped: the whole point of a fixed default is that when it
// is wrong, it is wrong in a way you can read.
//
// ── WHY THESE ARE THE NUMBERS ───────────────────────────────────────────────────────────────────────
// 25565 is Minecraft's own default port and is what `server.properties` says unless you changed it.
// 25575 is the default for RCON, the server's remote console. One server per computer can hold each of
// those, which is what makes them a safe assumption rather than a guess.
//
// ── IF YOUR SERVER IS SOMEWHERE ELSE ────────────────────────────────────────────────────────────────
// Edit the values below, OR set the environment variables named beside them — which is the better route
// when the answer differs per computer, because an edit here travels through git to every machine and
// would be right on one of them. The environment wins over this file when both are given.

'use strict';

// A port is validated rather than trusted: a malformed environment value would otherwise become NaN and
// travel all the way down to a socket error that names nothing (Law 13). A bad value falls back to the
// default below and the run then fails at the reachability check, which says where to look.
function port(envName, fallback) {
  const raw = parseInt(process.env[envName], 10);
  return (Number.isFinite(raw) && raw > 0 && raw < 65536) ? raw : fallback;
}

module.exports = {

  // WHERE THE WORLD IS. 'localhost' means "a server running on this same computer".
  // Put a hostname or an IP address here to send the bots somewhere else.
  //                                                   environment override: AUREN_SERVER_HOST
  host: process.env.AUREN_SERVER_HOST || 'localhost',

  // The port players connect on — `server-port` in your server.properties.
  //                                                   environment override: AUREN_SERVER_PORT
  port: port('AUREN_SERVER_PORT', 25565),

  // ── THE SERVER CONSOLE (RCON) — OPTIONAL, AND ONLY FOR THE EXTRAS ─────────────────────────────────
  // The bots play the game as players and need none of this to walk, build, farm or fight. The console
  // is what the workshop's tools use to set the time of day, place a test mob, or read the world back
  // when checking the bots' own account of themselves. Leave the password empty and those tools simply
  // say they cannot reach the console; nothing else changes.
  //
  // To switch it on, in your server.properties:  enable-rcon=true  and  rcon.password=<something>
  // A blank password is NOT the same as no password — the server answers "No rcon password set in
  // server.properties, rcon disabled!" and never opens the port at all.
  //                                                   environment override: AUREN_RCON_PORT
  rconPort: port('AUREN_RCON_PORT', 25575),

  //                                                   environment override: AUREN_RCON_PASSWORD
  rconPassword: process.env.AUREN_RCON_PASSWORD || '',
};
