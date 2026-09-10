// rcon_link — the ONE Source-RCON implementation in this tree (Law 16).
//
// WHY IT EXISTS: there were two. `camera_rig` carried a persistent session it did not export, and
// `rcon_cmd` carried a one-shot copy that re-derived the same framing from the same server.properties.
// The arena director needed a third, and three copies of a credentialed server link is the exact thing
// Law 16 forbids — the test is unambiguous ("delete one, does something else silently do the same
// job?"). Both callers now point here, so the framing, the auth handshake and the properties read have
// one home.
//
// TWO SHAPES, ONE PROTOCOL. They are not redundant routes — they are the same route with different
// lifetimes, and a caller that picks the wrong one leaks a socket or pays a handshake per command:
//   open()  — a persistent session. For anything issuing many commands over a run (the rig's tp/spectate
//             stream, the arena's summon/kill/give). Owns reconnect signalling via onDown.
//   once()  — connect, run a list, close. For a script whose whole life is a handful of commands.
//
// Law 8 (no zombies): every open() session must be close()d by whoever opened it. once() closes itself.
//
// The socket is 127.0.0.1 ONLY, and that is deliberate rather than incidental: the password sits in
// plaintext in server.properties, so a link that could dial a remote host would turn a local operator
// convenience into a credential shipped over a wire. The server runs on this machine; there is no
// legitimate caller on another one.

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
// The teardown primitive, required once the module moved into a SWEPT layer (2026-09-08). See `once()`.
const { withCleanup, guardExternal } = require('./external_library_guard');

// Where server.properties lives relative to this file. One definition — both former copies computed
// their own path and a repo re-layout would have broken them at different times.
//
// MOVED 2026-09-08 from `tools/` to here, which is why this walks up three rather than two. The move is
// the split plan's one inward step: three SHIPPED bot files require this module (`body_recovery`,
// `death_manager`, `report_to_owner`), so leaving the tree's only RCON implementation under `tools/` —
// which is going to the workshop — was the single edge that would have blocked the whole separation. It
// is bot infrastructure that happened to be filed with the benches.
//
// THE PATH IT COMPUTES DOES NOT EXIST FOR ANYBODY BUT THE ARCHITECT, and that is fine rather than broken.
// `MinecraftServer/` is his own server directory beside the repo; it does not travel in the extract. A
// stranger never reaches this constant, because `credentials()` below reads `AUREN_RCON_PASSWORD` /
// `AUREN_RCON_PORT` first and only falls back to a properties file when no environment says otherwise —
// the same "the fleet is TOLD whose world this is" shape as `SERVER_ENDPOINT`. The fallback is for the one
// case where the fleet launched the world itself, which is his case and only his.
const SERVER_PROPERTIES = path.resolve(__dirname, '..', '..', '..', 'MinecraftServer', 'server.properties');

// readServerProperties → { port, password, level }. Throws when RCON is disabled: a link that "succeeded" with
// a default port against a server that never opened one would fail later, somewhere less legible
// (Law 13 — prove safe to continue). Never hardcodes either value (Law 6 — one source of truth).
function readServerProperties(file = SERVER_PROPERTIES) {
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) props[m[1].trim()] = m[2].trim();
  }
  if (props['enable-rcon'] !== 'true') throw new Error('rcon disabled in server.properties');
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
// `readServerProperties` above answers "what did the fleet's OWN server get configured with", which is
// the right answer whenever the fleet launched the world it is talking to. It is the WRONG answer the
// moment the fleet is a guest on a world somebody else started — the public server — and it fails in the
// most confusing way available: that backend also listens for rcon on 25575, so the socket CONNECTS and
// only the auth is refused, with a password belonging to a different server entirely.
//
// MEASURED 2026-09-05, and this is the second time the same fault has been fixed. `fleet_control.js`
// gained `AUREN_RCON_PASSWORD` / `AUREN_RCON_PORT` for exactly this, with its reasoning written out at
// `rconCommand` — and this file, the tree's OTHER rcon path, did not get it. The visible symptom was the
// foreman's `tp` failing for every contractor it fetched (`rcon auth failed — check rcon.password`) while
// every other instrument read healthy, because the desk's teleport is the only thing in the live public
// stack that reaches the world through THIS module. Two implementations of one credential rule diverge
// the first time either is touched (Law 16); until they are one, they must at least read the same
// environment.
//
// SAME SHAPE AS `SERVER_ENDPOINT` (architect_config.js): the fleet stays ignorant of who owns the world
// and is simply TOLD, by whoever pointed it at one. The `enable-rcon` gate is deliberately skipped when a
// password is supplied — that flag is a fact about the fleet's own properties file and says nothing at
// all about the server actually being addressed (Law 23: it is a claim about the wrong world).
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
// onDown fires when the socket closes for ANY reason, and every in-flight command resolves to '' first.
// A pending promise that never settled would hang the caller's await forever with no failure anywhere —
// a server restart is a normal event here (the rig re-links, the arena re-links), so it must surface as
// an empty result plus a signal, never as silence.
//
// A reply can also simply not come back while the socket stays up — distinct from the socket closing,
// above: Minecraft's rcon gives no ordering guarantee across concurrent requests, and this link keys
// `pending` by request id, so one lost or mis-framed reply strands that id forever with nothing to clear
// it. So every command is bounded. A timeout resolves EMPTY rather than throwing, because that is already
// this link's contract for an unanswerable command (the close path above) and every caller is written
// against it — a reader that treats '' as "unread" stays correct, and one that treats it as data was
// already broken. The timeout is generous: it is a wedge-breaker, not a latency budget, and a normal
// reply on this loopback link is far inside it.
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
              // what makes a late reply harmless: it arrives, finds no entry, and is dropped rather than
              // resolving a promise the caller already moved past.
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
// THE TEARDOWN GOES THROUGH `withCleanup` RATHER THAN A BARE `try/finally` (2026-09-08). This was a hand
// written `finally { link.close(); }` for as long as the file lived under `tools/`, which `preflight` does
// not sweep — so the tree's one rule about where cleanup may be written had never been applied to it. The
// move into `js_kernel/utils/` put it under the check and preflight refused on the first run, which is the
// instrument doing exactly the job it is kept for: the fault was invisible while the file sat in an
// unswept folder and surfaced the moment it stopped.
//
// The semantics are unchanged — `withCleanup` does not catch, does not convert a throw into a value, and
// returns what its body returns; the only difference from the old shape is that a failure IN THE CLOSE is
// warned rather than allowed to replace the real outcome the caller is mid-way through receiving. That is
// strictly better here: a socket that fails to close must not mask the result of a teleport that worked.
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
// `bot.players[name].entity` only while that player is inside the bot's own loaded chunks, so a body that
// has just spawned across the world reads null and a body standing beside its owner reads a number — the
// same call answering two different questions depending on distance (Invariant B: what is not sensed is
// not known). The server holds every entity regardless of who has streamed it in, so this is the one
// reading that means the same thing at any range. Law 26's translator: a machine asked for a fact, its
// answer parsed by form, `null` when the form does not match rather than a guess.
//
// FLOORED TO A CELL, because every consumer of this is aiming a `tp`, which places FEET at the y it is
// given. Returning the raw doubles would leave each caller to floor them, which is where one of them
// eventually does not (Law 16 — the conversion belongs with the read).
const POS_REPLY = /\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\s*\]/;

async function entityPos(name, opts = {}) {
  const [reply] = await once([`data get entity ${name} Pos`], opts);
  const m = POS_REPLY.exec(reply ? reply.body : '');
  if (!m) return null;              // not logged in, not an entity, or the server refused — all "no position"
  return { x: Math.floor(Number(m[1])), y: Math.floor(Number(m[2])), z: Math.floor(Number(m[3])) };
}

// ── probe(opts) → { ok, reason } — IS THIS LINK USABLE AT ALL, ASKED WITHOUT THROWING ──────────────
//
// THE ASK (Architect 2026-09-10): *"you fix the RCON as needed to run on a strangers computer."*
//
// WHY IT HAS TO EXIST SEPARATELY FROM `once()`. Every other entry here answers "do this thing", and each
// fails in its own caller's context, late, one body at a time. The question a person needs answered is
// different and comes earlier: *can this fleet place a crew at all on this machine.* Since 2026-09-10 the
// answer decides whether ANY bot can start — a body refuses to plan until it has confirmed it is standing
// with the person who raised it (`body_recovery.arriveAtPlayer`) — so a fleet with no reachable console is
// not degraded, it is inert. Discovered on a real download: vanilla ships `enable-rcon=false`, and the
// properties file the fallback reads does not exist beside an extract at all.
//
// IT REPORTS RATHER THAN THROWS, and that is the whole point of a separate verb. `credentials()` throws on
// a missing properties file and on rcon being switched off, which is right for a caller mid-teleport and
// useless to a launcher deciding whether to open the desk. The throw is converted here, once, through the
// boundary guard — the fs read and the socket are both outside code (Law 16: one pathway to the outside).
//
// THE REASON IS RAW ON PURPOSE, AND THIS IS NOT AN OVERSIGHT. It says what the machine found; it does not
// say `pass --rcon-password`, because this module has no idea a command line exists. The instruction
// belongs to the layer that owns the vocabulary a person types — `start_auren.js` composes it from this
// reason (Law 25: the message is written by whoever can name the fix, in the words its reader uses).
//
// `list` is the command because it is the cheapest one every server answers and it changes nothing. A
// probe with a side effect would be a test that alters what it measures.
async function probe(opts = {}) {
  const r = await guardExternal('rcon_link', 'rcon probe (list)', () => once(['list'], opts));
  return r.ok ? { ok: true, reason: null } : { ok: false, reason: r.reason };
}

// `credentials` is exported so an `open()` caller can reach the same rule `once()` uses. The benches and
// probes in this directory keep calling `readServerProperties()` directly and that is CORRECT rather than
// an oversight: a bench needs a dev world it drives itself, so being pointed at a foreign server by a
// stray environment variable would be a bench measuring something nobody asked about.
module.exports = { readServerProperties, credentials, open, once, probe, entityPos, SERVER_PROPERTIES };
