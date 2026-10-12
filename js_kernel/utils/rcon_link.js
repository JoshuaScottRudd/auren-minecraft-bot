// The ONE Source-RCON implementation in this tree (Law 16). The framing, the auth handshake and the
// properties read all have one home; camera_rig, rcon_cmd and the arena director all point here.
//
// TWO SHAPES, ONE PROTOCOL — the same route with different lifetimes, and a caller that picks the wrong
// one leaks a socket or pays a handshake per command:
//   open()  — a persistent session. For anything issuing many commands over a run (the rig's tp/spectate
//             stream, the arena's summon/kill/give). Owns reconnect signalling via onDown.
//   once()  — connect, run a list, close. For a script whose whole life is a handful of commands.
//
// Law 8 (no zombies): every open() session must be close()d by whoever opened it. once() closes itself.
//
// The socket is 127.0.0.1 only: the password sits in plaintext in server.properties, so a link that
// could dial a remote host would turn a local operator convenience into a credential shipped over a
// wire. The server runs on this machine; there is no legitimate caller on another one.

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { withCleanup, guardExternal } = require('./external_library_guard');

// Where server.properties lives is the workstation resolver's answer — AUREN_SERVER_DIR, then the
// operator's workstation file — asked at the moment of reading, never computed at load (Law 16: one
// answer to which server folder in the tree).
//
// Bot infrastructure: body_recovery, death_manager and report_to_owner all require this module directly.
//
// A stranger usually never reaches this file: `credentials()` below reads `AUREN_RCON_PASSWORD` /
// `AUREN_RCON_PORT` first and only falls back to a properties file when no environment says otherwise,
// the same shape `SERVER_ENDPOINT` uses to tell the fleet whose world it is. The fallback is for when
// the fleet launched the world itself.
const workstation = require('./workstation');
function serverPropertiesFile() { return path.join(workstation.needServerDir(), 'server.properties'); }

// readServerProperties → { port, password, level }. Throws when RCON is disabled: a link that "succeeded" with
// a default port against a server that never opened one would fail later, somewhere less legible
// (Law 13 — prove safe to continue). Never hardcodes either value (Law 6 — one source of truth).
// parseServerProperties(text) → { key: value } — the ONE parser of the format (Law 16). Exported without the
// RCON gate below because `server_settings` has to read a file that is exactly the one this gate refuses: a
// server whose console is not switched on yet.
function parseServerProperties(text) {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) props[m[1].trim()] = m[2].trim();
  }
  return props;
}

function readServerProperties(file = serverPropertiesFile()) {
  const props = parseServerProperties(fs.readFileSync(file, 'utf8'));
  // Named so a stranger can fix it: which file, which lines to set, and that the server has to be
  // restarted afterwards for a properties change to take.
  if (props['enable-rcon'] !== 'true') {
    throw new Error(`RCON is switched off in ${file}, and the fleet drives the server through RCON. `
      + `Open that file and set:\n`
      + `    enable-rcon=true\n`
      + `    rcon.password=<pick anything>\n`
      + `    rcon.port=25575\n`
      + `then restart the server — a properties change does not take effect while it is running.`);
  }
  // `level` rides along because this is the ONE parser of server.properties (Law 16) and the world the
  // server is actually serving is a fact other callers need — a continue's preflight audits playerdata
  // under that directory, and a second parser would let the audited world drift from the served one.
  return {
    port: parseInt(props['rcon.port'], 10) || 25575,
    password: props['rcon.password'] || '',
    level: props['level-name'] || null,
  };
}

// ── credentials() — WHOSE WORLD IS THIS, AND WHO SAYS SO ─────────────────────────────────────────────
//
// `readServerProperties` above answers what the fleet's OWN server was configured with, which is right
// only when the fleet launched the world it is talking to. It is wrong the moment the fleet is a guest on
// a world somebody else started: any other Minecraft server also listens for rcon on 25575 by default, so
// the socket connects and only the auth is refused, with a password belonging to a different server.
//
// SAME SHAPE AS `SERVER_ENDPOINT` (architect_config.js): the fleet stays ignorant of who owns the world
// and is simply told, by whoever pointed it at one. The `enable-rcon` gate is skipped when a password is
// supplied — that flag is a fact about the fleet's own properties file and says nothing about the server
// actually being addressed (Law 23).
//
// EXPLICIT CREDS STILL WIN. A caller that passes `opts.creds` has decided; the environment is the answer
// for callers that have not, and the properties file is the answer when nobody has said anything.
function credentials(file) {
  const envPw = process.env.AUREN_RCON_PASSWORD;
  if (!envPw) return readServerProperties(file);
  const envPort = parseInt(process.env.AUREN_RCON_PORT, 10);
  const port = (Number.isFinite(envPort) && envPort > 0 && envPort < 65536) ? envPort : 25575;
  return { port, password: envPw, level: null };
}

// packet: vanilla Source-RCON framing — int32LE payload length, request id, type, ascii body, two nulls.
// Length counts everything after itself (id + type + body + 2 terminators = 10 + body).
function packet(id, type, body) {
  const b = Buffer.from(body, 'ascii');
  const p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
}

// Wedge-breaker, not a latency budget: a normal reply on this loopback link is ~18 ms, and the slowest
// legitimate command here (`data get entity` on a mob) is far inside this. Anything past it is a lost
// reply, and waiting longer only makes the loss harder to see.
const COMMAND_TIMEOUT_MS = 10000;
const AUTH_ID = 1;          // the handshake's own request id — the auth reply is the session's "ready"
const TYPE_AUTH = 3;
const TYPE_EXEC = 2;

// open({port,password}, onDown) → Promise<{ command(cmd), close() }>
//
// Resolves on the AUTH reply, not on socket connect: a connected socket with a rejected password is not
// a usable link, and the id === -1 reject below is the server's only way to say so.
//
// onDown fires when the socket closes for any reason, and every in-flight command resolves to '' first.
// A pending promise that never settled would hang the caller's await forever with no failure anywhere —
// a server restart is a normal event here, so it must surface as an empty result plus a signal, never as
// silence.
//
// A reply can also simply not come back while the socket stays up, distinct from the socket closing:
// Minecraft's rcon gives no ordering guarantee across concurrent requests, and this link keys `pending`
// by request id, so one lost or mis-framed reply strands that id forever with nothing to clear it. Every
// command is bounded by a timeout. A timeout resolves EMPTY, never throws: that is already this link's
// contract for an unanswerable command (the close path above), and every caller is written against it.
// The timeout is generous — a wedge-breaker, not a latency budget, and a normal reply on this loopback
// link is far inside it.
function open({ port, password }, onDown) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let nextId = 10;                       // above AUTH_ID so a command reply can never be read as the handshake
    const pending = new Map();

    sock.on('close', () => {
      for (const res of pending.values()) res('');
      pending.clear();
      if (onDown) onDown();
    });

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      // A single TCP chunk may carry several replies, or half of one — drain whole packets only.
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const id = buf.readInt32LE(4);
        const body = buf.slice(12, 4 + len - 2).toString('ascii');
        buf = buf.slice(4 + len);
        if (id === -1) { reject(new Error('rcon auth failed — check rcon.password')); sock.destroy(); return; }
        if (pending.has(id)) { pending.get(id)(body); pending.delete(id); }
        else if (id === AUTH_ID) {
          resolve({
            command: cmd => new Promise(res => {
              const cid = nextId++;
              // The timer is cleared by whoever settles first, and `pending.delete` before resolving is
              // what makes a late reply harmless: it arrives, finds no entry, and is silently discarded,
              // never resolving a promise the caller already moved past.
              const timer = setTimeout(() => {
                if (!pending.has(cid)) return;
                pending.delete(cid);
                console.error(`[rcon_link] no reply to ${JSON.stringify(cmd)} within ${COMMAND_TIMEOUT_MS}ms — resolving EMPTY so the caller cannot hang. The link stays up.`);
                res('');
              }, COMMAND_TIMEOUT_MS);
              pending.set(cid, body => { clearTimeout(timer); res(body); });
              sock.write(packet(cid, TYPE_EXEC, cmd));
            }),
            close: () => sock.destroy(),
          });
        }
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => sock.write(packet(AUTH_ID, TYPE_AUTH, password)));
  });
}

// once(cmds, opts) → Promise<[{ cmd, body }]>. Opens, runs the list IN ORDER, closes.
// Sequential on purpose: RCON has no ordering guarantee across concurrent ids, and every caller of this
// shape is issuing a setup sequence where order is the point (gamemode before tp before spectate).
//
// THE TEARDOWN GOES THROUGH `withCleanup`, NOT A BARE `try/finally` (the swept-layer convention this
// folder holds to). `withCleanup` does not catch and does not convert a throw into a value; it returns
// what its body returns. Its one difference from a bare finally: a failure in the close is warned, not
// allowed to replace the real outcome the caller is mid-way through receiving — a socket that fails to
// close must not mask the result of a teleport that worked.
async function once(cmds, opts = {}) {
  const link = await open(opts.creds || credentials(opts.file));
  const out = [];
  await withCleanup('rcon_link', `once(${cmds.length} command(s))`,
    async () => { for (const cmd of cmds) out.push({ cmd, body: (await link.command(cmd) || '').trim() }); },
    () => link.close());
  return out;
}

// entityPos(name, opts) → { x, y, z } | null — where the server says an entity is standing.
//
// THE SERVER IS ASKED BECAUSE THE BOT CANNOT SEE THIS. A player's position is readable off
// `bot.players[name].entity` only while that player is inside the bot's own loaded chunks, so the same
// call answers two different questions depending on distance (Invariant B: what is not sensed is not
// known). The server holds every entity regardless of who has streamed it in, so this reading means the
// same thing at any range. The answer is parsed by form; `null` when the form does not match, never a
// guess (Law 26).
//
// FLOORED TO A CELL, because every consumer of this is aiming a `tp`, which places FEET at the y it is
// given. The conversion belongs with the read (Law 16).
const POS_REPLY = /\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\s*\]/;

async function entityPos(name, opts = {}) {
  const [reply] = await once([`data get entity ${name} Pos`], opts);
  const m = POS_REPLY.exec(reply ? reply.body : '');
  if (!m) return null;              // not logged in, not an entity, or the server refused — all "no position"
  return { x: Math.floor(Number(m[1])), y: Math.floor(Number(m[2])), z: Math.floor(Number(m[3])) };
}

// ── probe(opts) → { ok, reason } — IS THIS LINK USABLE AT ALL, ASKED WITHOUT THROWING ──────────────
//
// WHY IT HAS TO EXIST SEPARATELY FROM `once()`. Every other entry here answers a specific request, and
// each fails in its own caller's context, late, one body at a time. The question a person needs answered
// is different and comes earlier: can this fleet place a crew at all on this machine. A body refuses to
// plan until it has confirmed it is standing with the person who raised it
// (`body_recovery.arriveAtPlayer`), so a fleet with no reachable console is not degraded, it is inert.
//
// REPORTS, NEVER THROWS — the whole point of a separate verb. `credentials()` throws on a missing
// properties file and on rcon being switched off, which is right for a caller mid-teleport and useless to
// a launcher deciding whether to open the desk. The throw is converted here, once, through the boundary
// guard — the fs read and the socket are both outside code (Law 16: one pathway to the outside).
//
// THE REASON IS RAW ON PURPOSE. It says what the machine found; it does not say `pass --rcon-password`,
// because this module has no idea a command line exists. The instruction belongs to the layer that owns
// the vocabulary a person types — `start_auren.js` composes it from this reason (Law 25).
//
// `list` is the command because it is the cheapest one every server answers and it changes nothing. A
// probe with a side effect would be a test that alters what it measures.
async function probe(opts = {}) {
  const r = await guardExternal('rcon_link', 'rcon probe (list)', () => once(['list'], opts));
  return r.ok ? { ok: true, reason: null } : { ok: false, reason: r.reason };
}

// `credentials` is exported so an `open()` caller can reach the same rule `once()` uses. The benches and
// probes in this directory call `readServerProperties()` directly on purpose: a bench needs a dev world
// it drives itself, and being pointed at a foreign server by a stray environment variable would be a
// bench measuring something nobody asked about.
module.exports = { parseServerProperties, readServerProperties, credentials, open, once, probe, entityPos };
