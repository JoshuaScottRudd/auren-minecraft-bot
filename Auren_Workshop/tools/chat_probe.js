'use strict';
// tool: chat_probe — the LIVE observation that settles whether a bot can HEAR a human in 1.21.5,
// which is the single fact the whole in-game control program rests on. Vol. 52 §18 resolved the
// doorman's shape on lifecycle grounds and then recorded the hole underneath it plainly:
// `bot.on('chat')` has NEVER been observed in this fleet. Everything downstream — spawn from chat,
// the contractor mandate, the order desk's acknowledgements — is paper until this runs.
//
// WHY A SECOND BOT IS THE HUMAN. The Architect cannot be in the game ("i cant go in game to do
// anything right now"), and the question is a WORLD-TRANSFORMATION — what does Minecraft DO with a
// player's chat — which no harness may answer by computing it (READ DON'T SIMULATE,
// `Auren_Workshop/README.md`; the rule predates the bench that used to carry it and outlived it).
// But the human is not being
// SIMULATED here: a second mineflayer client is a real connection holding a real player slot, and
// `bot.chat()` emits the same serverbound chat packet a keyboard does. The server cannot tell them
// apart, which is exactly why the proxy is legitimate. Nothing about the sender is authored.
//
// THE CONFOUND THIS PROBE EXISTS TO AVOID, stated before the results so it cannot be rationalised
// afterwards: 1.19 introduced SIGNED chat. On an offline-mode server the signature chain is absent
// or unverifiable, and libraries differ in whether they surface such a message, drop it, or route it
// down a different packet. So "the event did not fire" and "the fleet cannot hear humans" are NOT
// the same finding — the wire is tapped underneath the event for every question and both layers are
// reported. A negative with no wire trace beneath it would be an uncontrolled negative (Law 26).
//
// EVERY QUESTION CARRIES ITS CONTROL. C4 (console /say) exists so that my own RCON test instrument
// cannot be mistaken for a human: if a console announcement were indistinguishable from a player's
// chat, this probe would be manufacturing its own positive result.
//
// Run (server must be UP; fleet bots need not be):
//   node_portable\node-*\node.exe Auren_Workshop\tools\chat_probe.js
//   env knobs: PROBE_HOST, PROBE_PORT, PROBE_VERSION

const path = require('path');
const fs = require('fs');

const paths = require('../workshop_paths');
const moduleHomes = require(paths.bot('js_kernel/utils/node_module_homes'));
// WHERE THE PACKAGES LIVE IS ASKED OF THE ONE FILE THAT ANSWERS IT. A private constant stood here
// naming MinecraftServer/node_modules alone, so this probe ran on the workstation whose server happened
// to carry mineflayer and refused everywhere else — one more copy of the question
// `js_kernel/utils/node_module_homes` exists to end (its header records the first four).
for (const d of moduleHomes.bootstrapModulePath()) module.paths.unshift(d);

const mineflayer = moduleHomes.requireFromHomes('mineflayer');
const { Vec3 } = moduleHomes.requireFromHomes('vec3');
const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));

const HOST = process.env.PROBE_HOST || 'localhost';
const PORT = Number(process.env.PROBE_PORT || 25565);
const VERSION = process.env.PROBE_VERSION || '1.21.5';

const EAR = 'ChatProbe';       // stands for a contractor bot — the LISTENER
const HUMAN = 'ProxyHuman';    // stands for the Architect at a keyboard — the SPEAKER

const sleep = ms => new Promise(r => setTimeout(r, ms));

const findings = [];
function record(id, question, observed, verdict) {
  findings.push({ id, question, observed, verdict });
  console.log(`\n[${id}] ${question}`);
  console.log(`   observed: ${observed}`);
  console.log(`   verdict : ${verdict}`);
}

// Wire tap. Every chat-bearing packet 1.21.5 knows about, captured underneath the library so a
// missing EVENT can be told apart from a missing PACKET (see the confound note above).
const CHAT_PACKETS = ['player_chat', 'system_chat', 'profileless_chat', 'chat', 'disguised_chat'];

function tapWire(bot, sink) {
  for (const name of CHAT_PACKETS) {
    bot._client.on(name, p => sink.push({ packet: name, at: Date.now(), raw: p }));
  }
}

// The high-level events mineflayer MIGHT route a message through. Listening to all of them at once
// is the point: the probe reports which one actually carried the traffic rather than assuming.
function tapEvents(bot, sink) {
  bot.on('chat', (username, message) => sink.push({ event: 'chat', username, message, at: Date.now() }));
  bot.on('whisper', (username, message) => sink.push({ event: 'whisper', username, message, at: Date.now() }));
  bot.on('message', (jsonMsg) => sink.push({ event: 'message', text: String(jsonMsg), at: Date.now() }));
  bot.on('messagestr', (str) => sink.push({ event: 'messagestr', text: str, at: Date.now() }));
}

function connect(username) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: HOST, port: PORT, username, version: VERSION, auth: 'offline' });
    bot.on('kicked', r => console.log(`KICKED ${username}:`, JSON.stringify(r)));
    bot.on('error', e => console.log(`ERROR ${username}:`, e.message));
    bot.once('spawn', () => resolve(bot));
    setTimeout(() => reject(new Error(`${username} never spawned`)), 30000);
  });
}

// Sign text as a plain 4-array, or a THREW marker. Never a default — an unreadable sign must look
// different from an empty one (Law 13).
function readFront(bot, v) {
  const b = bot.blockAt(v);
  if (!b) return { name: null, lines: null };
  try {
    const t = b.getSignText();
    return { name: b.name, lines: t && t[0] != null ? String(t[0]).split('\n') : null };
  } catch (e) {
    return { name: b.name, lines: `THREW: ${e.message}` };
  }
}

// Q1 settled that ONLY the compound form is faithful — the plain-string and json-string forms are
// accepted by the parser and then store their own punctuation AS SIGN TEXT. This builder is the one
// shape allowed to seed a sign anywhere in this fleet.
//
// The distinction is one layer of quoting and it is easy to get wrong in exactly the direction that
// LOOKS right: `messages:['{"text":"ORDER"}']` is a LIST OF STRINGS that happen to contain JSON —
// that is Q1's rejected B-json-string, and the sign then literally reads {"text":"ORDER"}. The
// faithful form is a list of SNBT COMPOUNDS: `messages:[{text:"ORDER"}]`, no surrounding quotes.
// The first revision of this probe made precisely that mistake and reported the transport as
// MANGLED — an instrument fault wearing a finding's clothes. Q1 caught it because the read-back is
// compared to what was written rather than merely being non-empty.
function compoundSnbt(lines) {
  const four = [0, 1, 2, 3].map(i => `{text:${JSON.stringify(lines[i] || '')}}`);
  return `{front_text:{messages:[${four.join(',')}]}}`;
}

async function main() {
  const creds = rconLink.readServerProperties();
  const rcon = await rconLink.open(creds);
  const cmd = async c => (await rcon.command(c) || '').trim();
  console.log(`server: rcon up on ${creds.port}, world '${creds.level}'.`);

  const ear = await connect(EAR);
  const wire = [];
  const events = [];
  tapWire(ear, wire);
  tapEvents(ear, events);
  console.log(`ear: ${EAR} spawned at ${ear.entity.position.floored()}`);

  const human = await connect(HUMAN);
  console.log(`human proxy: ${HUMAN} spawned at ${human.entity.position.floored()}`);
  await sleep(2000);

  // Run one utterance in isolation and return everything BOTH layers saw for it.
  async function utterance(fn, waitMs = 2500) {
    const w0 = wire.length, e0 = events.length;
    await fn();
    await sleep(waitMs);
    return { wire: wire.slice(w0), events: events.slice(e0) };
  }
  const chatsIn = u => u.events.filter(e => e.event === 'chat');
  const packetsIn = u => [...new Set(u.wire.map(w => w.packet))];

  // ── C1 — THE GATE. Does another player's chat reach the bot at all, and with WHOSE name? ────────
  const MSG1 = 'auren spawn contractor';
  const c1 = await utterance(() => human.chat(MSG1));
  const c1heard = chatsIn(c1).find(e => e.message === MSG1);
  record('C1', "Does bot.on('chat') fire when ANOTHER PLAYER speaks on 1.21.5, and is the sender's username correct?",
    `packets: [${packetsIn(c1).join(', ') || 'none'}] | 'chat' events: ${JSON.stringify(chatsIn(c1).map(e => [e.username, e.message]))} | messagestr: ${JSON.stringify(c1.events.filter(e => e.event === 'messagestr').map(e => e.text))}`,
    !c1heard
      ? (c1.wire.length === 0
          ? 'NO — AND NOTHING REACHED THE WIRE. The message never left the server for this client; this is not a library problem and the doorman cannot be built on chat at all.'
          : `NO EVENT, BUT THE PACKET ARRIVED (${packetsIn(c1).join(', ')}). mineflayer did not route it to 'chat' — the doorman must tap the wire directly, exactly as Q10 forced for signs.`)
      : c1heard.username === HUMAN
        ? `YES — 'chat' fires with the correct sender username ('${c1heard.username}') and the verbatim message. The doorman has an ear and can tell WHO spoke.`
        : `PARTIAL — the text arrived but the username is '${c1heard.username}', not '${HUMAN}'. Addressing by sender is NOT reliable; any per-human authority would rest on a wrong name.`);

  // ── C2 — which packet actually carries it (so a wire tap is possible if the event is not) ───────
  const c1first = c1.wire[0];
  record('C2', 'Which wire packet carries a player-origin chat message on 1.21.5?',
    `distinct packets during C1: ${JSON.stringify(packetsIn(c1))} | first payload keys: ${JSON.stringify(c1first ? Object.keys(c1first.raw) : null)} | sender-ish fields: ${c1first ? JSON.stringify(Object.keys(c1first.raw).filter(k => /sender|uuid|name|account/i.test(k))) : 'n/a'}`,
    !c1first
      ? 'NOTHING ON THE WIRE — no packet-level fallback exists; C1 is final.'
      : `The traffic rides '${c1first.packet}'. A wire tap is available as a fallback route if the high-level event ever proves unreliable.`);

  // ── C3 — the echo question. A doorman that hears itself can loop. ───────────────────────────────
  const MSG3 = 'ear speaking to itself';
  const c3 = await utterance(() => ear.chat(MSG3));
  const c3self = chatsIn(c3).filter(e => e.message === MSG3);
  record('C3', 'Does the bot hear its OWN chat come back as a chat event?',
    `'chat' events for its own line: ${JSON.stringify(c3self.map(e => [e.username, e.message]))} | packets: [${packetsIn(c3).join(', ') || 'none'}]`,
    c3self.length === 0
      ? 'NO — the bot does not hear itself on the chat event. A doorman may answer in chat without any self-filter.'
      : `YES — the bot hears its own line back as '${c3self[0].username}'. ANY doorman that replies in chat MUST drop messages whose sender is its own username, or an acknowledgement can re-enter the parser as a command.`);

  // ── C4 — THE CONTROL. Console /say must NOT be confusable with a human. ─────────────────────────
  const c4 = await utterance(() => cmd('say CONSOLE ANNOUNCEMENT'));
  const c4pkts = packetsIn(c4);
  const c1pkts = packetsIn(c1);
  const separableOnWire = c4pkts.length > 0 && c1pkts.length > 0 && !c4pkts.some(p => c1pkts.includes(p));
  record('C4', 'CONTROL — does a CONSOLE /say arrive on the same event as a player chat (i.e. can a non-player fake a human)?',
    `'chat' events: ${JSON.stringify(chatsIn(c4).map(e => [e.username, e.message]))} | messagestr: ${JSON.stringify(c4.events.filter(e => e.event === 'messagestr').map(e => e.text))} | console packets: [${c4pkts.join(', ') || 'none'}] vs player packets: [${c1pkts.join(', ') || 'none'}]`,
    chatsIn(c4).length === 0
      ? "CONTROL HOLDS AT THE EVENT — a console announcement does not surface as a 'chat' event, so C1's positive is a genuine player message and a console operator cannot inject a bot command by accident."
      : separableOnWire
        ? `THE EVENT CANNOT TELL THEM APART BUT THE WIRE CAN. Console /say ALSO raises 'chat' (as '${chatsIn(c4)[0].username}'), so the event layer alone would let a non-player issue commands — but it arrives on [${c4pkts.join(', ')}] while a real player arrives on [${c1pkts.join(', ')}]. Origin is therefore decidable, and the doorman MUST decide it on the packet rather than on the event or on the sender's name (a name is claimable; a packet type is not). This is the same shape as Q10: the convenient layer is the wrong one.`
        : `CONTROL FAILS OUTRIGHT — console /say raises 'chat' (as '${chatsIn(c4)[0].username}') AND rides the same packets as a player [${c4pkts.join(', ')}]. Player origin is not decidable from the chat stream at all; the doorman needs a different channel entirely.`);

  // ── C5 — the addressed channel. A whisper is strictly better than open chat for commands. ───────
  const MSG5 = 'auren status';
  const c5 = await utterance(() => human.chat(`/msg ${EAR} ${MSG5}`));
  const c5w = c5.events.filter(e => e.event === 'whisper');
  record('C5', "Does a player's /msg reach the bot, and on 'whisper' or on 'chat'?",
    `'whisper' events: ${JSON.stringify(c5w.map(e => [e.username, e.message]))} | 'chat' events: ${JSON.stringify(chatsIn(c5).map(e => [e.username, e.message]))} | messagestr: ${JSON.stringify(c5.events.filter(e => e.event === 'messagestr').map(e => e.text))}`,
    c5w.length > 0
      ? `YES on 'whisper' — from '${c5w[0].username}'. A DIRECTED channel exists: a human can command ONE named bot without every other bot (or player) parsing the line.`
      : chatsIn(c5).length > 0
        ? "The whisper arrives but on 'chat', not 'whisper'. Directed addressing still works but the parser must read the tell format itself."
        : 'NO — a whisper does not reach the bot on either event. Commands must travel on open chat.');

  // ── C6 — is chat global, or must the doorman stand near the human? ─────────────────────────────
  // CARRIES ITS CONTROL, and the first revision of this probe shows why it must. That revision sent
  // `tp <human> ~ ~ ~2000`, which RCON resolves against the SERVER CONSOLE's position (world spawn),
  // not against the human — so the proxy landed somewhere arbitrary, possibly inside rock, and the
  // silence that followed was reported as "chat is not global". That is an uncontrolled negative:
  // "the channel is ranged" and "the probe broke its own speaker" are indistinguishable without a
  // liveness check. So the human's ABSOLUTE position is read first, the move is made from it, and a
  // control utterance after the return trip proves the speaker still works.
  const hp = human.entity.position.floored();
  await cmd(`forceload add ${hp.x + 1984} ${hp.z - 16} ${hp.x + 2016} ${hp.z + 16}`);
  await cmd(`tp ${HUMAN} ${hp.x + 2000} 120 ${hp.z}`);
  await sleep(4000);
  const MSG6 = 'shouting from two thousand blocks';
  const c6 = await utterance(() => human.chat(MSG6), 3500);
  const c6heard = chatsIn(c6).some(e => e.message === MSG6);
  const stillOn = (await cmd('list')).includes(HUMAN);
  const farPos = human.entity ? human.entity.position.floored() : null;
  const dist = farPos ? Math.round(Math.hypot(farPos.x - hp.x, farPos.z - hp.z)) : null;

  // The control: bring the speaker home and make it speak again. If THIS is heard, the speaker was
  // alive the whole time and a silence at range is the channel's answer, not the instrument's.
  await cmd(`tp ${HUMAN} ${hp.x} ${hp.y} ${hp.z}`);
  await sleep(3000);
  const MSG6C = 'back home and still talking';
  const c6ctl = await utterance(() => human.chat(MSG6C), 3000);
  const ctlHeard = chatsIn(c6ctl).some(e => e.message === MSG6C);
  await cmd(`forceload remove ${hp.x + 1984} ${hp.z - 16} ${hp.x + 2016} ${hp.z + 16}`);

  record('C6', 'Does chat reach the bot from 2000 blocks away (is the channel global)?',
    `moved to ${JSON.stringify(farPos)} (${dist} b from the ear's side of the world) | still on the player list: ${stillOn} | heard at range: ${c6heard} | CONTROL heard after returning home: ${ctlHeard}`,
    !ctlHeard
      ? 'INCONCLUSIVE — THE CONTROL FAILED. The proxy could not be heard even after returning home, so its silence at range says nothing about the channel. Do not read a range limit into this.'
      : c6heard
        ? `YES — chat is GLOBAL (heard from ${dist} b, and the control confirms the speaker was live throughout). The doorman may stand anywhere; it need not follow the human or load their chunks.`
        : `NO, AND THE CONTROL LOCALISES IT — the identical utterance is heard at home and not from ${dist} b away, with the speaker connected the whole time. Chat is RANGED on this server, and the doorman must remain within earshot of the human.`);

  // ── C7 — how long a command line can be ────────────────────────────────────────────────────────
  let at256 = null, at300 = null;
  try { human.chat('x'.repeat(256)); at256 = 'accepted locally'; } catch (e) { at256 = `refused locally: ${e.message}`; }
  await sleep(1500);
  try { human.chat('y'.repeat(300)); at300 = 'accepted locally'; } catch (e) { at300 = `refused locally: ${e.message}`; }
  await sleep(1500);
  record('C7', 'How long may a single chat command line be?',
    `256 chars: ${at256} | 300 chars: ${at300}`,
    'Vanilla caps a chat line at 256 characters. An in-game command line has far more room than a sign line does, so command length is not a design constraint — the sign is the only narrow channel.');

  // ── S1 — settle the confound Q9 left behind: a HUMAN-placed, UNWAXED sign. ─────────────────────
  // Q9 established only that a WAXED sign silently refuses a write. Whether a bot can write a sign it
  // did NOT place and that is NOT waxed was never actually asked, and the order desk turns on it.
  const p = ear.entity.position.floored();
  const SX = p.x + 3, SY = p.y, SZ = p.z + 3;
  const sv = new Vec3(SX, SY, SZ);
  await cmd(`forceload add ${SX - 16} ${SZ - 16} ${SX + 16} ${SZ + 16}`);
  await cmd(`setblock ${SX} ${SY - 1} ${SZ} stone`);
  await cmd(`setblock ${SX} ${SY} ${SZ} oak_sign${compoundSnbt(['ORDER', 'cobble 128', '', ''])}`);
  await sleep(1500);

  const before = readFront(ear, sv);
  let activateThrew = null, writeThrew = null;
  const signBlock = ear.blockAt(sv);
  if (signBlock && signBlock.name.includes('sign')) {
    try { await ear.activateBlock(signBlock); } catch (e) { activateThrew = e.message; }
    await sleep(800);
    try { ear.updateSign(signBlock, 'BOT WROTE\nTHIS\n\n'); } catch (e) { writeThrew = e.message; }
    await sleep(2000);
  }
  const after = readFront(ear, sv);
  const serverAfter = await cmd(`data get block ${SX} ${SY} ${SZ}`);
  const changed = JSON.stringify(before.lines) !== JSON.stringify(after.lines);
  record('S1', 'Can a bot ACTIVATE and WRITE a sign it never placed and that is NOT waxed? (Q9 tested only a WAXED sign, so its negative was confounded)',
    `sign block: ${before.name} | before: ${JSON.stringify(before.lines)} | activateBlock threw: ${activateThrew || 'no'} | updateSign threw: ${writeThrew || 'no'} | after: ${JSON.stringify(after.lines)} | server: ${serverAfter.slice(0, 220)}`,
    before.name == null || !String(before.name).includes('sign')
      ? 'INCONCLUSIVE — no sign block was present to write to; the placement itself failed and this question did not run.'
      : changed
        ? "YES — activateBlock re-grants the editor on a sign the bot did not place and the write LANDS. Q9's negative was the WAXING, not the ownership. The order desk can answer a human on their own sign."
        : "NO — the write was dropped on an UNWAXED sign the bot did not place, so the editor grant (not waxing) is what refuses it. The order desk must acknowledge somewhere other than the human's own sign.");

  // ── S2 — the line budget, round-tripped. The Architect's rule: everything fits on ONE line. ─────
  // The rendered-pixel limit cannot be observed headlessly (Q8) and is NOT being re-attempted here.
  // What IS observable — and is the part that can actually break — is whether the shortened
  // vocabulary survives the transport verbatim. Anything mangled here would never be read correctly.
  const CANDIDATES = ['ORDER', 'cobble 128', 'oak_log 64', 'plank 256', 'iron 32', 'torch 64', 'glass 128', 'stone 2304'];
  const roundTrip = [];
  for (let i = 0; i < CANDIDATES.length; i += 3) {
    const four = [CANDIDATES[i] || '', CANDIDATES[i + 1] || '', CANDIDATES[i + 2] || '', ''];
    await cmd(`setblock ${SX} ${SY} ${SZ} air`);
    await sleep(400);
    await cmd(`setblock ${SX} ${SY} ${SZ} oak_sign${compoundSnbt(four)}`);
    await sleep(1200);
    roundTrip.push({ wrote: four, read: readFront(ear, sv).lines });
  }
  const allFaithful = roundTrip.every(r => Array.isArray(r.read) && r.wrote.every((w, i) => (r.read[i] || '') === w));
  const longest = CANDIDATES.reduce((a, b) => (b.length > a.length ? b : a));
  record('S2', 'Does the SHORTENED one-line order vocabulary survive the sign transport verbatim?',
    `longest candidate: '${longest}' (${longest.length} chars) | round trips: ${JSON.stringify(roundTrip)}`,
    allFaithful
      ? `FAITHFUL — every candidate came back byte-for-byte, longest '${longest}' at ${longest.length} characters. The transport does not constrain the shortened vocabulary; only the human editor's rendered width does, and the character budget exists to stay clear of it.`
      : 'MANGLED — at least one candidate did not survive the round trip, so the vocabulary cannot be trusted as written. See the round-trip dump above.');

  // ── SUMMARY ────────────────────────────────────────────────────────────────────────────────────
  console.log('\n\n══════════ CHAT PROBE SUMMARY ══════════');
  for (const f of findings) console.log(`${f.id.padEnd(5)} ${f.verdict.slice(0, 160)}`);
  console.log('════════════════════════════════════════\n');

  const out = paths.fleetLogs('chat_probe_findings.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    version: VERSION, ear: EAR, human: HUMAN, site: { SX, SY, SZ }, findings,
    wirePacketsSeen: [...new Set(wire.map(w => w.packet))],
    eventsSeen: [...new Set(events.map(e => e.event))],
  }, null, 2));
  console.log(`findings written to ${out}`);

  // Law 8 — whatever this raised, it takes down.
  await cmd(`setblock ${SX} ${SY} ${SZ} air`);
  await cmd(`forceload remove ${SX - 16} ${SZ - 16} ${SX + 16} ${SZ + 16}`);
  rcon.close();
  human.quit();
  ear.quit();
  setTimeout(() => process.exit(0), 800);
}

main().catch(e => { console.error('PROBE FAILED:', e); process.exit(1); });
