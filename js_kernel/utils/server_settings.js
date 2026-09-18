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
const { SPAWN_PROTECTION_RADIUS } = require('../../Thinking_fragments/architect_config');

const REQUIRED = [
  { key: 'online-mode', value: 'false',
    why: 'the bots log in without Minecraft accounts, and a server in online mode refuses every one of them' },
  { key: 'enable-rcon', value: 'true',
    why: 'a crew is brought to where you stand through the server console, and a bot that cannot be placed does not start' },
];

// Settings the fleet cannot run correctly without, asserted at launch instead of trusted.
//
// spawn-protection: the vanilla default, ON, and the value comes from architect_config's
// SPAWN_PROTECTION_RADIUS rather than a literal here — the bots gate their own decisions on that same
// constant, so the square the launcher enforces and the square they avoid cannot drift apart (Law 16).
//
// WHAT THE SETTING DOES: inside a Chebyshev square of that radius around world spawn — X/Z only, full
// height — the server refuses block breaks and placements by non-op players. It refuses SILENTLY: no
// revert, no error, nothing the client can see. mineflayer writes AIR into its own world model anyway
// and reports the dig as done, so a bot inside the zone mines a phantom hole, walks into a block that
// never left, and strands itself with 0 items and no error anywhere in the trace.
//
// THE WRONG TURN, TAKEN ONCE AND WORTH NOT RETAKING: this was `0` — the rule deleted from the world —
// because the fleet had no way to see the refusal, and switching it off was the only thing that made the
// silence stop. That trade trained the fleet on a world with a rule missing from it, so nothing in the
// stack ever learned the rule exists; the moment a bot met a server that had it (any public or vanilla
// one — this is the DEFAULT setting), the same maroon returns with nothing changed. The fix is the fleet
// holding the rule itself: `perception_nodes.js/spawn_protection` gates target selection, route search
// and both world-altering verbs on the square, so a protected cell is refused BEFORE the swing rather
// than discovered as a phantom after it.
//
// Op-ing the bots would also silence it, and is the other wrong turn: exempting the construct from a
// limit every other agent obeys is the Rogue Machine error Law 19 forbids. The fleet's own gate
// therefore ignores op status entirely — an op'd bot is refused exactly like a non-op one, because a
// constraint honoured only where it cannot be defeated is not a constraint (Invariant E).
//
// difficulty=hard keeps the HUNGER system fully live — food drains with activity and a bot can starve to
// death at food 0 — which is what arms the eating subsystem (on peaceful, food never drains and the whole
// eat tier is dormant, so the system would never be exercised).
//
// spawn-monsters=TRUE since 2026-08-03 (Architect: "go ahead and do a standard test. we will enable
// monsters as well… every main feature added to the game now with combat"). It was FALSE from 2026-07-16
// so a test could isolate the survival loop from combat while combat did not exist — the bot faced hunger,
// not creepers. That reason has lapsed rather than been overruled: the counter arms, the engagement queue
// and the combat journal all shipped, and every one of them is now unexercised by a run with nothing hostile in
// it. Leaving the flag off would make the standard test quietly stop covering the feature the fleet spent
// four sessions building, which is the same silence in a new place (Law 25).
//
// What this costs, named so a bad run is read correctly: the survival loop is no longer isolated. A bot
// that starves during a monster-enabled run may have starved because combat interrupted the eat tier, and
// hunger and combat can no longer be told apart from the outcome alone — they have to be told apart from
// the record (trace_monitor's warnings; `--engagement` for the fights). Flip this back to 'false' for any run
// whose question is about hunger, farming or building alone.
//
// All four load at JVM start, so a live server carrying the wrong values can only be reported and
// restarted (handled below), never hot-corrected.
//
// Why here and not documentation: MinecraftServer/ is gitignored, so server.properties does NOT travel
// between the Architect's two machines. A hand-sync checklist is a constraint enforced by memory —
// exactly the defeatable kind (Invariant E), and it already failed once. The launcher touches every run
// on every machine and is the only place that can assert this rather than ask.
//
// ── DIFFICULTY IS PEACEFUL WHILE THE DESK IS BEING BUILT (Architect 2026-08-30: "also set the mode to
//    peaceful for now. while continuing to test") ─────────────────────────────────────────────────────
// A TEMPORARY VALUE WITH A PERMANENT REASON RECORDED BESIDE IT, because the paragraphs above are the
// argument FOR hard and they have not been overruled — they are being set aside while a different
// subsystem is under construction, and a successor who reads `peaceful` here without them will conclude
// the fleet was never meant to face hunger or combat at all.
//
// WHAT PEACEFUL COSTS, so a run is read correctly: food never drains, so the whole eat tier is dormant
// and unexercised; no hostile spawns, so the counter arms, the engagement queue and every combat path
// are unexercised too. A green run under peaceful says NOTHING about either. It also removes the one
// exposure that killed a probe run outright — a partial explosion packet crashing mineflayer's physics
// handler, three libraries down, under every client in the fleet — which is worth knowing when reading
// this as a testing choice rather than only as a difficulty one.
//
// TO RESTORE: `difficulty` back to 'hard'. Nothing else changes; `spawn-monsters` is deliberately LEFT
// TRUE so that restoring is one word rather than a hunt, and it costs nothing meanwhile — peaceful
// suppresses hostile spawns whatever that flag says.
// ── sync-chunk-writes=FALSE, AND THIS IS THE `FLEET FROZEN` FAULT (measured 2026-09-10) ────────────
// Vanilla ships this TRUE, which makes the server thread fsync every chunk as it saves it. On this
// machine that is the difference between a save and a stall, measured on the drive the world lives on:
//
//     8 KB write, no fsync :  25.5 ms
//     8 KB write, fsync    : 144.5 ms      → 6x
//
// A save of ~1000 resident chunks is therefore ~150 SECONDS of blocking disk I/O on the one thread that
// also runs the game. Observed directly, on a ONE-MINUTE run with four players:
//
//     [19:32:23] Saving chunks for level 'sub_agent_01'/minecraft:overworld
//     [19:34:57] Saving chunks for level 'sub_agent_01'/minecraft:the_end      ← 2m34s later
//
// AND A CPU SAMPLE ACROSS THAT WINDOW SETTLES WHAT THE RECORD COULD NOT. bugsquashing §14.9 left two
// candidates — the server doing heavy work, or the server starved of a core by the node fleet — and told
// the next session to accept neither without a sample. Through the stall java held 0-5% of ONE core of
// eight, node held 0%, and 22.6 GB of RAM was free: the tick thread was neither busy nor starved, it was
// BLOCKED. That is a third cause and it is the one that fits every symptom on record.
//
// What it retro-explains: every client dropping in the SAME INSTANT with a client-side timeout (a >30s
// block outlasts mineflayer's 30-second keep-alive, so the protocol is behaving correctly); no
// OutOfMemoryError ever appearing; and §14.8's heap theory failing the way it did — a 4 GB heap froze
// SOONER than 1 GB because more heap holds more chunks resident, and resident chunks are what a save has
// to write. It is intermittent for the same reason: how much terrain two ranging bots dirtied before the
// next autosave.
//
// THE COST, NAMED: an abruptly killed JVM can leave a torn chunk. This fleet restores its world from a
// snapshot at the start of every run, so the exposure lasts exactly one run and is never carried.
const FLEET_PROPS = [
  { key: 'spawn-protection', value: String(SPAWN_PROTECTION_RADIUS),
    why: 'the bots avoid exactly this square around world spawn, so the server must protect the same one' },
  { key: 'difficulty', value: 'peaceful',
    why: 'peaceful while the builder is under construction (Architect 2026-08-30)' },
  { key: 'spawn-monsters', value: 'true', why: 'left on so restoring hard difficulty is one word' },
  { key: 'spawn-animals', value: 'true', why: 'the crews farm and hunt' },
  { key: 'sync-chunk-writes', value: 'false',
    why: 'with it on, a chunk save blocks the game thread for minutes and every client times out' },
];

// ── REQUIRED GAMERULES (Architect 2026-08-09) ───────────────────────────────────────────────────────
//   "can you make sure you turn mob griefing off repo wide? so when i do a standard test as well?"
//
// Gamerules, not server properties, and that difference decides where this lives. Properties are read
// once at JVM start (serverStart can only WARN about a live one); a gamerule is world state settable over
// rcon at any time — so it is applied on BOTH paths here, including a reused server, and a live server no
// longer has to be restarted to be correct.
//
// It belongs at bring-up rather than in any one bench because it is a property of every run, and because
// ROLLBACK REVERTS IT: the gamerule persists in the world's level.dat, so a snapshot restore silently puts
// it back to whatever the snapshot held. Setting it once by hand would survive until the first rollback
// and then quietly stop being true — which is why it is re-asserted every time the server comes up rather
// than assumed. `lanista` used to author this itself; that copy is now a read-back check, so there is one
// author and one verifier (Law 16).
//
// WHY mob_griefing IS OFF: a creeper detonation craters the ground the next wave is sited on, so each trial
// was fought on terrain the previous trial had rearranged and the ladder was calling that difference the
// bot. Turning it off costs no difficulty — the bot still takes the full blast damage, measured at 20.0 hp
// from 2.3 b on 2026-08-09. Only the terrain is spared.
// WHY spawn_phantoms IS OFF: phantoms were the only reason the fleet needed a bed, and the bed was the only
// reason it needed wool. death_manager already returns a body to the headframe, so the bed bought nothing
// else. Rule off, bed and hunt chain deleted (Architect 2026-08-14).
//
// ── THESE ARE 26.1'S NAMES, AND 26.1 RENAMED EVERY GAMERULE THERE IS (2026-09-17) ─────────────────────
// `mobGriefing` was `mobGriefing` through 1.21.x and is `mob_griefing` from 26.1; `doInsomnia` became
// `spawn_phantoms`; `doDaylightCycle` (applyClock, below) became `advance_time`. The whole set moved from
// camelCase to snake_case at once, so this is one rename rather than three coincidences. The names here
// are the ones the version in `architect_config.SERVER_MINECRAFT_VERSION` answers to — the same single
// authored answer everything else about this server's version reads (Law 16). On an OLDER server every
// name below is rejected, and the read-back a few lines down is what turns that into a named warning
// instead of a silent no-op: it was exactly how this rename was found.
const REQUIRED_GAMERULES = { mob_griefing: 'false', spawn_phantoms: 'false' };

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

module.exports = { prepare, serverPort, serverAnswers, REQUIRED, REQUIRED_PROPS, REQUIRED_GAMERULES };
