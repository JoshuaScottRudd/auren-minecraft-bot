// foreman/integrity_keeper.js — THE INTEGRITY KEEPER: ONE PLACE HOLDS THE CREW'S PLAN-AGAINST-WORLD VERDICTS.
//
// Every body used to read the world against the plans for itself, each sweep: fifteen bodies repeating one
// comparison, and every repetition paid inside the planning gate. The keeper makes the comparison once, for the
// whole crew, and keeps it current from the changes the server pushes; a body reads the verdict from its own
// memory (keeper_verdicts), where the foreman's broadcast puts it. Bodies never ask the keeper anything.
//
// ── ONE BODY, TWO THREADS ─────────────────────────────────────────────────────────────────────────────
// A body is one connection to the server, held by one process. The foreman's body is that one body: it stands
// at the base once the crew is raised, so the server keeps sending it every chunk and every block change there.
// This file is the body's side: it copies the chunks the plans stand in to the keeper's own thread
// (integrity_keeper_worker.js), passes on every block change inside them, and hands the thread's verdicts to the
// broadcast. All the reading and lighting runs on that thread, so the foreman's thread and its planning gate
// never wait on a verdict.
//
// ── SCOPE ─────────────────────────────────────────────────────────────────────────────────────────────
// The keeper owns every comparison of a plan against the world at a fixed place. Light, structures (every sited
// blueprint the registry carries, the farm's fields among them), the pens (what each holds, every animal by its
// id in and out, the wolves near it: pen_keeper, on this thread, since entities reach only the body), the downloaded
// building (mansion_keeper) are kept today.
// The mine and the pens' tending ground follow, each deleting the body-side scan it
// replaces. A body's own food and health, searches for what no plan names yet, and the look a body takes at the one
// cell it is about to change stay with the body.
//
// ── WHAT A VERDICT PROMISES ───────────────────────────────────────────────────────────────────────────
// Each carries `generated_at`. A body treats a verdict older than keeper_verdicts.STALE_S as unknown, never as
// done or safe, so a keeper that stops leaves work held, never sent into the dark.

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const timeoutCrash = require('@utils/timeout_crash');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'integrity_keeper';
const PLANS_MS = 5000;           // how often the plans the hub holds are compared with the ones the thread has
const FEED_MS = 20;              // one chunk column copied per beat, so a large base never holds the thread
const BLOCKS_MS = 100;           // block changes passed on in batches
const DISK_MS = 10000;           // the kept verdict file is rewritten at most this often

let _worker = null;
let _bot = null;
let _hub = null;
let _log = () => {};
const _wanted = new Set();       // chunk columns the thread asked for, "cx,cz"
const _sent = new Set();         // chunk columns the thread holds
const _queue = [];
const _blocks = [];
let _lastPlans = '';
const _verdicts = new Map();     // subject → verdict
const _timers = [];

const colKey = (cx, cz) => `${cx},${cz}`;

function onBlockUpdate(_old, now) {
  if (!now || !now.position) return;
  const { x, y, z } = now.position;
  if (!_sent.has(colKey(x >> 4, z >> 4))) return;
  _blocks.push({ x, y, z, s: now.stateId });
}
function onColumnLoad(corner) {
  const k = colKey(corner.x >> 4, corner.z >> 4);
  if (_wanted.has(k) && !_queue.includes(k)) _queue.push(k);
}
function onColumnUnload(corner) {
  const cx = corner.x >> 4, cz = corner.z >> 4, k = colKey(cx, cz);
  if (!_sent.delete(k)) return;
  _worker.postMessage({ type: 'unload', cx, cz });
}

// attach(bot) — the body the keeper copies from, the foreman's one body for the whole run.
function attach(bot) {
  if (!_worker) return;
  if (_bot && _bot !== bot) {
    _bot.world.removeListener('blockUpdate', onBlockUpdate);
    _bot.world.removeListener('chunkColumnLoad', onColumnLoad);
    _bot.world.removeListener('chunkColumnUnload', onColumnUnload);
  }
  _bot = bot;
  _bot.world.on('blockUpdate', onBlockUpdate);
  _bot.world.on('chunkColumnLoad', onColumnLoad);
  _bot.world.on('chunkColumnUnload', onColumnUnload);
  for (const k of _wanted) if (!_queue.includes(k)) _queue.push(k);
  require('./pen_keeper').attach(bot);
}

// The latest verdict per subject, kept in the run's records as `integrity_keeper_<subject>.json` so a person or
// a lens can read what the keeper holds (Law 6). Written at most every DISK_MS: the file is a window, not a log.
const _diskAt = new Map();
function keepOnDisk(subject, verdict) {
  if (Date.now() - (_diskAt.get(subject) || 0) < DISK_MS) return;
  _diskAt.set(subject, Date.now());
  const file = path.join(require('@utils/record_homes').RECORDS_DIR, `integrity_keeper_${subject}.json`);
  const r = guardExternalSync(TAG, `write ${file}`, () => require('fs').writeFileSync(file, JSON.stringify(verdict)));
  if (!r.ok) _log(`integrity keeper: the ${subject} verdict could not be kept on disk — ${r.reason}`);
}

function sendPlans() {
  const plans = _hub.keeperPlans();
  const shape = JSON.stringify(plans);
  if (shape === _lastPlans) return;
  _lastPlans = shape;
  _worker.postMessage({ type: 'plans', ...plans });
}

function feedOne() {
  if (!_bot || !_bot.world) return;
  const k = _queue.shift();
  if (!k) return;
  const [cx, cz] = k.split(',').map(Number);
  const column = _bot.world.getColumn(cx, cz);
  if (!column) return;                     // not loaded round the body; its load event queues it again
  _worker.postMessage({ type: 'column', cx, cz, json: column.toJson() });
  _sent.add(k);
}

// start({ bot, hub, mode, log }) — raise the keeper's thread for a crew of this mode. Every crew sites structures
// and lights them, so every crew has one, with both subjects.
function start({ bot, hub, mode, log }) {
  if (_worker) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): start() called twice.`);
  _hub = hub;
  _log = log;
  _worker = new Worker(path.join(__dirname, 'integrity_keeper_worker.js'), { workerData: { mode } });
  _worker.on('message', (m) => {
    if (m.type === 'want') {
      _wanted.clear();
      for (const [cx, cz] of m.columns) _wanted.add(colKey(cx, cz));
      for (const k of _wanted) if (!_sent.has(k) && !_queue.includes(k)) _queue.push(k);
      return;
    }
    if (m.type === 'verdict') {
      _verdicts.set(m.subject, m.verdict);
      _hub.publishVerdict(m.subject, m.verdict);
      keepOnDisk(m.subject, m.verdict);
      return;
    }
    if (m.type === 'log') { _log(`integrity keeper: ${m.line}`); return; }
  });
  // A keeper that throws is a coding fault: loud, and the run ends rather than carry on without its verdicts.
  _worker.on('error', (e) => timeoutCrash.crashEverything(TAG, `the integrity keeper's thread threw: ${e && e.stack ? e.stack : String(e)}`));
  // stop() removes this listener first, so any exit heard here is one the run did not order.
  _worker.on('exit', (code) => timeoutCrash.crashEverything(TAG, `the integrity keeper's thread exited with code ${code} while the run was going`));
  _timers.push(timeoutCrash.every(TAG, 'compare the plans the hub holds with the keeper thread\'s', sendPlans, PLANS_MS));
  _timers.push(timeoutCrash.every(TAG, 'copy one chunk column the keeper asked for to its thread', feedOne, FEED_MS));
  _timers.push(timeoutCrash.every(TAG, 'pass the block changes the body heard to the keeper thread', () => {
    if (_blocks.length) _worker.postMessage({ type: 'blocks', list: _blocks.splice(0) });
  }, BLOCKS_MS));
  attach(bot);
  sendPlans();
  // THE PENS ARE WATCHED ON THIS THREAD: what a pen holds is entities, which only the body hears (pen_keeper).
  // Whether a pen stands is the keeper's own structures reading of it: true built whole, false not, null not read.
  const whole = (structure) => {
    const { roomKeyName } = require('./message_schema');
    const read = Object.entries(_verdicts.get('structures')?.structures || {}).find(([k]) => roomKeyName(k) === structure);
    return read && read[1].held ? read[1].all_complete === true : null;
  };
  require('./pen_keeper').start({ bot, whole, plans: () => _hub.keeperPlans().buildings, publish: (subject, v) => {
    _verdicts.set(subject, v);
    _hub.publishVerdict(subject, v);
    keepOnDisk(subject, v);
  } });
  log(`integrity keeper: raised for the ${mode} crew — subjects: structures, fields, light, pens, mansion.`);
}

// stop() — the thread ends with the run (Law 8).
function stop() {
  if (!_worker) return;
  const w = _worker;
  _worker = null;
  for (const t of _timers.splice(0)) timeoutCrash.stop(t);
  require('./pen_keeper').stop();
  w.removeAllListeners('exit');
  guardExternalSync(TAG, 'end the keeper thread', () => w.terminate());
}

function verdict(subject) { return _verdicts.get(subject) || null; }
function raised() { return !!_worker; }

// where() → the keeper's own claim of where its body is: { raised, present, position } (a floored cell or null).
// A body asks for it before taking a verdict and holds it against the server's reading; it is a claim, not proof.
function where() {
  const p = _worker && _bot && _bot.entity ? _bot.entity.position.floored() : null;
  return { raised: !!_worker, present: !!p, position: p ? { x: p.x, y: p.y, z: p.z } : null };
}

module.exports = { start, attach, stop, verdict, where, raised };
