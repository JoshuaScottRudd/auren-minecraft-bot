'use strict';

// The @-aliases, registered here: this stand-in requires `@foreman/message_schema`, and leaving
// registration to a caller's habit is not something this file can check (Law 16 — one route, asked by
// everyone). Idempotent, so a caller that already booted pays nothing.
require('../workshop_paths').registerAliases();
// tool: foreman_door_standin — the far side of the foreman's door, with no fleet behind it.
//
// ── WHAT IT IS FOR ────────────────────────────────────────────────────────────────────────────────
// Most of the foreman probe's questions are about THE DESK — did it read the line, did it refuse the
// right things, did it form the right message — and a body cannot make those answers any truer. This
// stands where the foreman's in-game door stands, with nothing raised behind it. The desk runs its whole
// length: it hears an authenticated chat packet, parses, corrects, gates, and relays through
// `foreman_door` — the same socket, the same envelope, the same port.
//
// ── WHY THE CUT IS HERE AND NOT IN THE FOREMAN ────────────────────────────────────────────────────
// A test mode inside the desk itself would put a branch that only ever runs under test, so what the fast
// phase exercises would not be what serves a human (Law 16 — one capability, one pathway), and it would
// give the desk the power to treat one named speaker specially, which is precisely the power V5/V8/V12
// exist to prove it does not have.
//
// Cutting at the door needs no such branch, because the door is already the seam. `foreman_door`'s own
// header states the rule this relies on: the origin of a verb is decided by WHICH DOOR IS KNOCKED ON,
// never by a field the sender spells. A foreman talking to this module is byte-for-byte the foreman
// talking to the foreman.
//
// ── WHAT IT MAY AUTHOR, AND WHAT IT MUST CALL ─────────────────────────────────────────────────────
// Anything MINECRAFT decides must be READ, anything WE decide may be AUTHORED. The foreman is ours, so
// its answers may be authored — the roster it would report, the delivery verdict it would return. A rule
// the desk is under test against may not be authored, since authoring the answer deletes the question:
//
//   · THE REQUEST RULES ARE CALLED, NEVER RESTATED. `applyPost` / `applyCancel` / `rowsFor` are the exact
//     functions `foreman_hub` calls, from the exact module (Law 16). Whether a repeat replaces or
//     accumulates, whether a met row survives, which items may be asked for — every one of those is a
//     claim the request questions make, so a second implementation here would grade a ledger nobody runs.
//
//   · THE OWNERSHIP FILTER IS NOT IMPLEMENTED HERE AT ALL. Deciding which bots a verb reaches is
//     `broadcastCommand`'s, and it is the subject of its own control questions; a second copy here would
//     pass its own questions while the fleet's copy rotted. Ownership and species isolation are FOREMAN
//     claims and belong to the phase that runs one. Phase 1 does not report on them (Law 25).
//
// ── WHAT IT REPLIES TO AN OPERATOR VERB, AND WHY THAT IS NOT A LIE ────────────────────────────────
// `sent: 0, reason: 'no_bots'` — what the REAL foreman returns when its registry is empty, reached by the
// same branch, because the registry really is empty here too. Nothing here reports a delivery that did
// not happen, and no success flag is emitted that was not earned (Law 25).
//
// THE EVIDENCE IS THE ENVELOPE, NOT THE REPLY. What phase 1 asserts on is what actually crossed the wire
// — the verb, the args, and the `asker` the desk observed — read out of `envelopes`, a postcondition
// outside the desk. The delivery IS observable here, catching the class of fault a live run already
// produced: a field the desk was supposed to stamp arriving absent, invisible to a bench that authored it
// by hand.

const { createEnvelope, parseEnvelope, INGAME_DOOR_PORT_OFFSET } = require('@foreman/message_schema');
const requestLedger = require('@kernel/request_ledger');
const { requireFromHomes } = require('@utils/node_module_homes');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'door_standin';

// start(opts) → handle
//
//   handle.port       the port it is listening on
//   handle.envelopes  every message that arrived, in order, whole — the phase-1 evidence
//   handle.rows       the standing request ledger, as the foreman would hold it
//   handle.setRoster  author who the foreman would say is in the world
//   handle.close()
//
// THE LEDGER IS THIS PROCESS'S, AND IT IS EMPTY AT THE START OF A RUN: a run that inherited yesterday's
// rows would answer a status question with work nobody asked for today (Law 8 — what is raised here is
// taken down with it).
function start(opts = {}) {
  const WebSocket = requireFromHomes('ws');
  const base = parseInt(opts.foremanPort || process.env.FOREMAN_PORT || '3001', 10);
  const port = base + INGAME_DOOR_PORT_OFFSET;
  const log = opts.quiet ? () => {} : (m) => console.log(`[${TAG}] ${m}`);

  const envelopes = [];
  // The roster the foreman would report. AUTHORED, and every question that reads it has to say so: a
  // claim about the DESK's behavior given that roster is what phase 1 may assert; a claim about the
  // world's true roster is not available here at all.
  let roster = Array.isArray(opts.roster) ? opts.roster.slice() : [];
  let rows = {};

  const wss = new WebSocket.Server({ port });
  const sockets = new Set();

  const answer = (ws, type, payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(createEnvelope(type, 'foreman', payload)));
    }
  };

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    // A socket error here is the network's, and it must not take the run down: the probe still has
    // questions to ask and a dead instrument answers none of them (Law 16 — a terminus that names it).
    ws.on('error', (err) => log(`socket error: ${err.message}`));
    ws.on('message', (raw) => {
      const parsed = parseEnvelope(raw.toString());
      // REPORTED, NEVER SILENTLY DROPPED. A malformed message reaching this door is itself a finding —
      // it means the desk formed something the real foreman would have refused — and a door that
      // swallows it is indistinguishable from a deaf one (Law 6).
      if (!parsed.ok) {
        envelopes.push({ at: Date.now(), bad: true, reason: parsed.reason, raw: raw.toString().slice(0, 500) });
        log(`REFUSED a malformed message: ${parsed.reason}`);
        return;
      }
      const msg = parsed.msg;
      envelopes.push({ at: Date.now(), type: msg.type, bot_id: msg.bot_id, payload: msg.payload });

      if (msg.type === 'fleet_query') {
        answer(ws, 'fleet_state', { bots: roster.slice() });
        return;
      }

      if (msg.type === 'request_command') {
        const { action, item, quantity, asker } = msg.payload || {};
        // The anonymous-request refusal is the foreman's and is reproduced by CALLING the same guard
        // shape, not by re-deciding it: an unnamed request is a requirement belonging to nobody.
        if (!asker) { answer(ws, 'request_result', { ok: false, reason: 'no_asker' }); return; }
        if (action === 'post') {
          const result = requestLedger.applyPost(rows, item, quantity, asker, asker);
          if (result.ok) {
            rows = result.rows;
            answer(ws, 'request_result', { ok: true, item: result.row.item, quantity: result.row.quantity, replaced: result.replaced });
          } else {
            answer(ws, 'request_result', { ok: false, reason: result.reason, blockedBy: result.blockedBy || null });
          }
          return;
        }
        if (action === 'cancel') {
          const out = requestLedger.applyCancel(rows, item, asker);
          rows = out.rows;
          answer(ws, 'request_result', { ok: true, removed: out.removed });
          return;
        }
        if (action === 'status') {
          // NO PROGRESS FIGURES, AND THE EMPTY OBJECT IS THE HONEST ANSWER. Progress is measured inside a
          // body against real chests; with no crew raised, nobody has looked. The foreman reports an
          // absent measurement as absent, never as a zero, and so does this (Law 25).
          answer(ws, 'request_result', { ok: true, rows: requestLedger.rowsFor(rows, asker), progress: {} });
          return;
        }
        answer(ws, 'request_result', { ok: false, reason: `unknown_action: ${action}` });
        return;
      }

      if (msg.type === 'operator_command') {
        // RECORDED, NOT PERFORMED, AND REPORTED AS SUCH. `no_bots` is the real foreman's own verdict for
        // an empty registry, and the registry really is empty, so this is the true outcome. What the verb
        // would have reached is the ownership filter's answer, not asked in this phase (see the header).
        answer(ws, 'command_result', {
          verb: msg.payload && msg.payload.verb,
          origin: 'ingame',
          sent: 0, skippedSpecies: 0, skippedOwner: 0,
          reason: 'no_bots',
        });
        return;
      }

      log(`'${msg.type}' is not spoken at this door — recorded and dropped.`);
    });
  });

  log(`standing in for the foreman's in-game door on ${port} — nothing is raised behind it.`);

  return {
    port,
    envelopes,
    get rows() { return rows; },
    setRoster(next) { roster = next.slice(); },
    // Every envelope of one type, newest last — the shape nearly every phase-1 question wants.
    of(type) { return envelopes.filter(e => e.type === type); },
    // The last operator verb the desk relayed, or null. The single most-asked question of this record.
    lastVerb() {
      const all = envelopes.filter(e => e.type === 'operator_command');
      return all.length ? all[all.length - 1].payload : null;
    },
    close() {
      // Closing a socket the far end already dropped is the library's business, not a decision made here,
      // routed through the one guard so it is a reported boundary, never a bare swallow (Law 16: `catch
      // (_) {}` is never legal).
      for (const ws of sockets) guardExternalSync(TAG, 'closing a stand-in door socket', () => ws.close());
      return new Promise(res => wss.close(res));
    },
  };
}

module.exports = { start };
