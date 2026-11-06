'use strict';
// foreman_door.js — the read door: who is connected, what each body is doing, and what the world and the run are.
//
// It asks one question, `query`, and carries no verb: a verb reaches the fleet through the terminal socket
// (fleet_control). The tools that read a live fleet (bench_world, camera_warden, fleet_control) and the foreman's
// own crew raise ask it here.
//
// ONE SHOT PER QUESTION, NEVER A HELD CONNECTION: the fleet answers and the socket closes (Law 8).

const { createEnvelope, parseEnvelope, READ_DOOR_PORT_OFFSET } = require('@foreman/message_schema');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'foreman_door';

// WHERE THE THIRD-PARTY MODULES LIVE HAS EXACTLY ONE ANSWER IN THIS TREE, and this file is not it — a
// private copy of where modules live would drift out of step with the machine layouts it is meant to
// track (Law 16).
//
// Probing by existence is kept, and it is the resolver's rule too: a catch around `require` swallows a
// genuine load-time fault inside the package and reports it as not installed here, sending the reader to
// the wrong machine.
const { requireFromHomes } = require('@utils/node_module_homes');

function requireWs() { return requireFromHomes('ws'); }

const FOREMAN_PORT_DEFAULT = 3001;

// The pair the run up in this copy took (port_book, on its run lock), unless FOREMAN_PORT names one.
function doorPort() {
  const base = parseInt(process.env.FOREMAN_PORT, 10) || require('@utils/port_book').runForemanPort() || FOREMAN_PORT_DEFAULT;
  return base + READ_DOOR_PORT_OFFSET;
}

// ── ONE SOCKET, ONE QUESTION ─────────────────────────────────────────────────────────────────────
// The connect / timeout / close / never-throw machinery, handed what to put on the wire and what to read back.
function _ask(outgoing, wantType, readPayload, timeoutMs) {
  const WebSocket = requireWs();
  const port = doorPort();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    // Closing a socket that is already gone is the library's business, not a decision this module makes.
    const closeQuietly = (ws) => guardExternalSync(TAG, `closing the door socket on ${port}`, () => ws.close());

    const opened = guardExternalSync(TAG, `opening the read door on ${port}`,
      () => new WebSocket(`ws://127.0.0.1:${port}`));
    if (!opened.ok) {
      finish({ ok: false, error: `could not open the fleet door on ${port}: ${opened.reason}` });
      return;
    }
    const ws = opened.value;

    const timer = setTimeout(() => {
      closeQuietly(ws);
      finish({ ok: false, error: `the fleet did not answer within ${timeoutMs / 1000}s` });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    ws.on('open', () => { ws.send(JSON.stringify(outgoing)); });

    ws.on('message', (raw) => {
      const parsed = parseEnvelope(raw.toString());
      clearTimeout(timer);
      closeQuietly(ws);
      if (!parsed.ok || parsed.msg.type !== wantType) {
        finish({ ok: false, error: 'the fleet answered with something unreadable' });
        return;
      }
      finish({ ok: true, ...readPayload(parsed.msg.payload || {}) });
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: `no fleet door on port ${port} (${e.message}) — is the foreman up?` });
    });
  });
}

// `departed` is bots that registered and then left, kept out of `bots`: every caller of that array acts
// on its members (raise, film, send a verb), and a departed bot among them is a ghost.
// `buildings` is every live base the fleet holds, `<structure>|<crew>` → its site chairs. Read-only; the
// foreman asks it before siting, so a crew's existing base is handed back.
function readFleetState(p) {
  return {
    bots: Array.isArray(p.bots) ? p.bots : [],
    departed: Array.isArray(p.departed) ? p.departed : [],
    buildings: p.buildings && typeof p.buildings === 'object' ? p.buildings : {},
    // Every warning the fleet has raised this run, folded: [{ unit, shape, count, bots, first_at, last_at, sample }].
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
    workspace: p.workspace && typeof p.workspace === 'object' ? p.workspace : null,
    // What the world is doing, from the foreman that owns it: { where, state, reason, host, port, ours, ... }.
    world: p.world && typeof p.world === 'object' ? p.world : null,
    // Where the configured run has got to (foreman_plan.progressNow): { sentence, crew, soakEndsAt, closing }.
    run: p.run && typeof p.run === 'object' ? p.run : null,
  };
}

// query() — who is connected right now.
//
// Answered fresh from the foreman's own registry each time (Invariant B): a cached tally would go wrong
// the first time the operator stops one from the console. The registry's fact is CONNECTION, not life —
// a bot that LEFT is not in it, a bot that merely DIED still is, holding its crew slot until it comes
// back (death_manager's job).
function query(timeoutMs = 5000) {
  return _ask(
    createEnvelope('fleet_query', 'foreman', {}),
    'fleet_state',
    readFleetState,
    timeoutMs,
  );
}

// local(hub) — the same question, answered by the foreman living in THIS process.
//
// The foreman's body and the hub share one process and one memory space, so this calls `hub` directly,
// with no socket in between: the same projection and the same always-resolving promise as the socket road.
// The socket road above stays for readers that are other processes (bench_world, the camera warden).
function local(hub) {
  return {
    query: () => Promise.resolve({ ok: true, ...readFleetState(hub.fleetState()) }),
    doorPort,
  };
}

module.exports = { query, doorPort, local };
