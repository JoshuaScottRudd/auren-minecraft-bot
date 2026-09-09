'use strict';
// overseer_door.js — the foreman's one way of reaching the fleet with an operator verb.
//
// WHY THE FOREMAN DOES NOT SHELL OUT TO fleet_control FOR THESE. It still does for `get`, and the
// difference between the two cases is the whole reason this file exists. `get` starts an OS PROCESS,
// which is fleet_control's job and nobody else's (Law 16 — one launcher). `start` and `exit` are
// OPERATOR VERBS, and routing those through fleet_control would stamp them TERMINAL, because that is
// what fleet_control's socket is: the operator's console by another name. The verb would arrive at
// every bot in the fleet carrying console authority — the exact promotion the origin table exists to
// prevent, performed by the one component built to serve strangers.
//
// SO THE ORIGIN IS DECIDED BY WHICH DOOR IS KNOCKED ON, NEVER BY A FIELD. This module knows only the
// in-game door's address. It cannot spell `terminal` because there is nowhere to spell it: the
// overseer stamps the origin from which of its own listeners accepted the socket, and this one only
// ever reaches the second. A foreman that could name its own origin could name the privileged one, and
// the species isolation would rest on this file's honesty rather than on the fleet's shape (Law 23).
//
// ONE SHOT PER COMMAND, NEVER A HELD CONNECTION. A human says a thing, the fleet answers, the socket
// closes. A long-lived socket would be a fourth kind of fleet client to keep alive, reconnect and
// reason about, in a process whose whole job is to relay single sentences (Law 8 — what is raised is
// taken down, and the cheapest way to honour that is to raise it for one message).

const { createEnvelope, parseEnvelope, INGAME_DOOR_PORT_OFFSET } = require('@overseer/message_schema');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'overseer_door';

// WHERE THE THIRD-PARTY MODULES LIVE HAS EXACTLY ONE ANSWER IN THIS TREE, and this file is not it.
// The candidate list was written out here a second time and was missing a home the canonical resolver
// already knew, so the door threw a coding violation naming two directories while `ws` sat in a third —
// and every verb the foreman offers a human died on it, `list` included. That is the failure mode
// node_module_homes was extracted to end: a private copy of "where do modules live" does not stay in
// step with the machine layouts, and it fails at the one moment nobody is watching a console (Law 16).
//
// Probing by existence rather than requiring-and-catching is kept, and it is the resolver's rule too: a
// catch around `require` swallows a genuine load-time fault inside the package and reports it as "not
// installed here", sending the reader to the wrong machine.
const { requireFromHomes } = require('@utils/node_module_homes');

function requireWs() { return requireFromHomes('ws'); }

const OVERSEER_PORT_DEFAULT = 3001;

function doorPort() {
  const base = parseInt(process.env.OVERSEER_PORT || String(OVERSEER_PORT_DEFAULT), 10);
  return base + INGAME_DOOR_PORT_OFFSET;
}

// send(verb, args) → { ok, sent, skippedSpecies, reason, error }
//
// IT ALWAYS RESOLVES AND NEVER THROWS, and that is a deliberate terminus rather than a swallow: the
// caller is a clerk answering a person standing in the world, so every failure has to become a sentence
// rather than an exception. Each one is named — a door that is not there, a socket that broke, a fleet
// that never answered — because "it didn't work" sends a human looking in the wrong place.
//
// THE TIMEOUT IS AN ANSWER, NOT A RETRY. A verb that was written to the socket and never acknowledged
// may well have landed; re-sending it would mean a human's single sentence dispatching two `exit`s. So
// the wait ends with an honest "no answer came back" and the human decides (Law 25).
// ── ONE SOCKET, TWO QUESTIONS ────────────────────────────────────────────────────────────────────
// `send` and `query` differ only in what they put on the wire and what they read back, so the
// connect / timeout / close / never-throw machinery is written once and handed the pair (Law 16). The
// alternative — two near-identical functions — is where one of them quietly stops closing its socket.
function _ask(outgoing, wantType, readPayload, timeoutMs) {
  const WebSocket = requireWs();
  const port = doorPort();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    // Closing a socket that is already gone is the library's business, not a decision this module makes.
    const closeQuietly = (ws) => guardExternalSync(TAG, `closing the door socket on ${port}`, () => ws.close());

    const opened = guardExternalSync(TAG, `opening the in-game door on ${port}`,
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
      finish({ ok: false, error: `no fleet door on port ${port} (${e.message}) — is the overseer up?` });
    });
  });
}

// send(verb, args, asker) — an operator verb, on behalf of the player who spoke it.
//
// THE ASKER IS NOT OPTIONAL AND IS NOT DEFAULTED. The overseer refuses an in-game verb that names
// nobody, because the unaddressed form means "all of MY bots" and an anonymous one would mean "all of
// everybody's" — so a forgotten asker fails loudly here rather than becoming the widest possible
// command (Law 13).
function send(verb, args = {}, asker = null, timeoutMs = 5000) {
  return _ask(
    createEnvelope('operator_command', 'foreman', { verb, args, asker }),
    'command_result',
    // `stopped` IS CARRIED BECAUSE A WIPE IS THE ONE VERB WHOSE OUTCOME IS NOT A DELIVERY COUNT. It is
    // performed by the overseer against the player's own file and reaches zero bots by design, so `sent`
    // cannot describe it; what the person needs to hear is how many of their crew were sent away. The
    // projection is explicit rather than a spread on purpose — this is the boundary where the fleet's
    // vocabulary becomes the desk's, and a field crosses it only when something in here reads it.
    (p) => ({ sent: p.sent || 0, skippedSpecies: p.skippedSpecies || 0, skippedOwner: p.skippedOwner || 0,
              reason: p.reason || null, stopped: p.stopped || 0 }),
    timeoutMs,
  );
}

// query() — who is connected right now, and whose they are.
//
// ASKED RATHER THAN REMEMBERED. The foreman could tally bots as it hands them out, and that counter would
// be wrong the first time the operator stops one from the console and every time the foreman itself
// restarts (Invariant B). The overseer's registry is the live fact, and the fact it holds is CONNECTION,
// not life: a bot that LEFT is not in it, a bot that merely DIED still is — it keeps its owner's slot
// because it is coming back, which is death_manager's job and not the roster's.
function query(timeoutMs = 5000) {
  return _ask(
    createEnvelope('fleet_query', 'foreman', {}),
    'fleet_state',
    (p) => ({ bots: Array.isArray(p.bots) ? p.bots : [] }),
    timeoutMs,
  );
}

// request(action, args, asker) — place, withdraw, or read back a standing requirement.
//
// A SEPARATE MESSAGE TYPE FROM `send`, not a new operator verb, because the two do different things to
// different places. An operator verb is a COMMAND delivered to bodies — it reaches every bot the asker
// owns and acts now. A request is a FACT written down — it reaches no body, changes no behaviour
// directly, and is answered by whichever crew next measures its own needs. Folding it into the verb
// path would put a fact through a machinery built to fan out commands (Law 0: one verb per thing).
//
// The asker travels for the same reason it does on `send`, and here it is load-bearing twice over: it
// is both who spoke and WHOSE REQUIREMENT THIS IS, so a missing one is not a defaulted field but a
// requirement belonging to nobody (Law 13).
function request(action, args = {}, asker = null, timeoutMs = 5000) {
  return _ask(
    createEnvelope('request_command', 'foreman', { action, ...args, asker }),
    'request_result',
    (p) => ({ ...p }),
    timeoutMs,
  );
}

module.exports = { send, query, request, doorPort };
