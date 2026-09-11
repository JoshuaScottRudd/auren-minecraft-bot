'use strict';

// THE ALIASES ARE REGISTERED HERE rather than left to a caller. This stand-in requires
// `@overseer/message_schema` and used to work only when something upstream had already booted the map —
// which is a dependency on a caller's habit, not on anything this file can check (Law 16: one route,
// asked by everyone). Idempotent, so a caller that already booted pays nothing.
require('../workshop_paths').registerAliases();
// tool: foreman_door_standin — the far side of the foreman's door, with no fleet behind it.
//
// ── WHAT IT IS FOR ────────────────────────────────────────────────────────────────────────────────
// The foreman probe used to answer every question in one run that raised an overseer, a foreman, two
// humans, a crew and a homesteader, and then waited on bodies doing world work. Most of its questions
// are about THE DESK — did it read the line, did it refuse the right things, did it form the right
// message — and a body cannot make those answers any truer. Those questions were paying a fleet's
// startup and a fleet's latency for evidence a fleet does not supply.
//
// So this stands where the overseer's in-game door stands, and nothing is raised behind it. The desk
// runs its whole length: it hears an authenticated chat packet, parses, corrects, gates, and relays
// through `overseer_door` — the same socket, the same envelope, the same port.
//
// ── WHY THE CUT IS HERE AND NOT IN THE FOREMAN ────────────────────────────────────────────────────
// The alternative was a test mode inside the desk: teach it that one named player is a tester and have
// it acknowledge verbs without executing them. That fails twice. It puts a branch in the desk that only
// ever runs under test, so what the fast phase exercises is not what serves a human (Law 16 — one
// capability, one pathway); and it gives the desk the power to treat one named speaker specially, which
// is precisely the power V5/V8/V12 exist to prove it does not have. A probe cannot install the
// capability its own controls are built to disprove.
//
// Cutting at the door needs no such branch, because the door is already the seam. `overseer_door`'s own
// header states the rule this relies on: the origin of a verb is decided by WHICH DOOR IS KNOCKED ON,
// never by a field the sender spells. A foreman talking to this module is byte-for-byte the foreman
// talking to the overseer — it cannot tell, and nothing in it needed to be told.
//
// ── WHAT IT MAY AUTHOR, AND WHAT IT MUST CALL ─────────────────────────────────────────────────────
// The playground's governing line, applied one category over: anything MINECRAFT decides must be READ,
// anything WE decide may be AUTHORED. The overseer is ours, so its answers may be authored — the roster
// it would report, the delivery verdict it would return. What may NOT be authored is a rule the desk is
// under test against, because authoring the answer deletes the question:
//
//   · THE REQUEST RULES ARE CALLED, NEVER RESTATED. `applyPost` / `applyCancel` / `rowsFor` are the
//     exact functions `overseer_server` calls, from the exact module (Law 16). Whether a repeat replaces
//     or accumulates, whether a met row survives, which items may be asked for — every one of those is a
//     claim the request questions make, so a second implementation here would grade a ledger nobody
//     runs. This is the bench's own worst failure, already met once: a scenario passed 25/25 before and
//     after a live fix because it hand-authored the field the bug lived in.
//
//   · THE OWNERSHIP FILTER IS NOT IMPLEMENTED HERE AT ALL, and its absence is deliberate rather than
//     unfinished. Deciding which bots a verb reaches is `broadcastCommand`'s, and it is the subject of
//     its own control questions. Reimplementing it would put a second copy of the isolation rule in the
//     instrument that grades it — the copy would pass its own questions while the fleet's copy rotted.
//     So ownership and species isolation are OVERSEER claims and belong to the phase that runs one.
//     Phase 1 must not report on them, and says so rather than scoring them green (Law 25).
//
// ── WHAT IT REPLIES TO AN OPERATOR VERB, AND WHY THAT IS NOT A LIE ────────────────────────────────
// `sent: 0, reason: 'no_bots'` — which is what the REAL overseer returns when its registry is empty,
// reached by the same branch, because the registry really is empty: nothing was raised. The desk then
// tells the human its verb reached nobody, which is true. Nothing here reports a delivery that did not
// happen, and no success flag is emitted that was not earned (Law 25).
//
// THE EVIDENCE IS THE ENVELOPE, NOT THE REPLY. What phase 1 asserts on is what actually crossed the
// wire — the verb, the args, and the `asker` the desk observed — read out of `envelopes`. That is a
// postcondition OUTSIDE the desk, which is more than the probe has today: its own header concedes that
// `start` "has no such postcondition from outside the process, so it is graded on delivery". Here the
// delivery IS observable. The class of fault it catches is the one a live run already produced — a
// field the desk was supposed to stamp arriving absent, invisible to a bench that authored it by hand.

const { createEnvelope, parseEnvelope, INGAME_DOOR_PORT_OFFSET } = require('@overseer/message_schema');
const requestLedger = require('@kernel/request_ledger');
const { requireFromHomes } = require('@utils/node_module_homes');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'door_standin';

// start(opts) → handle
//
//   handle.port       the port it is listening on
//   handle.envelopes  every message that arrived, in order, whole — the phase-1 evidence
//   handle.rows       the standing request ledger, as the overseer would hold it
//   handle.setRoster  author who the overseer would say is in the world
//   handle.close()
//
// THE LEDGER IS THIS PROCESS'S, AND IT IS EMPTY AT THE START OF A RUN — deliberately, because a run
// that inherited yesterday's rows would answer a status question with work nobody asked for today and
// the reason would be invisible. Law 8: what is raised here is taken down with it.
function start(opts = {}) {
  const WebSocket = requireFromHomes('ws');
  const base = parseInt(opts.overseerPort || process.env.OVERSEER_PORT || '3001', 10);
  const port = base + INGAME_DOOR_PORT_OFFSET;
  const log = opts.quiet ? () => {} : (m) => console.log(`[${TAG}] ${m}`);

  const envelopes = [];
  // The roster the overseer would report. AUTHORED, and every question that reads it has to say so:
  // "given a roster of two, the desk refuses a third" is a claim about the DESK and is what phase 1 may
  // assert; "the roster is true" is a claim about the world and is not available here at all.
  let roster = Array.isArray(opts.roster) ? opts.roster.slice() : [];
  let rows = {};

  const wss = new WebSocket.Server({ port });
  const sockets = new Set();

  const answer = (ws, type, payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(createEnvelope(type, 'overseer', payload)));
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
      // it means the desk formed something the real overseer would have refused — and a door that
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
        // The anonymous-request refusal is the overseer's and is reproduced by CALLING the same guard
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
          // body against real chests; with no crew raised, nobody has looked. The overseer reports an
          // absent measurement as absent rather than as a zero, and so does this — "nothing gathered
          // yet" and "no bot has looked yet" are different facts and only one of them would be a
          // fabrication here (Law 25).
          answer(ws, 'request_result', { ok: true, rows: requestLedger.rowsFor(rows, asker), progress: {} });
          return;
        }
        answer(ws, 'request_result', { ok: false, reason: `unknown_action: ${action}` });
        return;
      }

      if (msg.type === 'operator_command') {
        // RECORDED, NOT PERFORMED, AND REPORTED AS SUCH. `no_bots` is the real overseer's own verdict
        // for an empty registry, and the registry really is empty — so this is the true outcome rather
        // than a stand-in's imitation of one. What the verb WOULD have reached is the ownership
        // filter's answer, and that question is not asked in this phase (see the header).
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

  log(`standing in for the overseer's in-game door on ${port} — nothing is raised behind it.`);

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
      // Closing a socket the far end already dropped is the library's business, not a decision made
      // here — routed through the one guard so it is a reported boundary rather than a bare swallow
      // (Law 16: `catch (_) {}` is never legal, and a catch must never be the expected pathway).
      for (const ws of sockets) guardExternalSync(TAG, 'closing a stand-in door socket', () => ws.close());
      return new Promise(res => wss.close(res));
    },
  };
}

module.exports = { start };
