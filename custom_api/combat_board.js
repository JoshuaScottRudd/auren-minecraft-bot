// api: combat_board
// purpose: The fleet's fast combat road. Each body sends one small note (foreman_link.sendCombatNote) the moment its
//          claim changes and every NOTE_RENEW_MS while it holds one. The foreman relays a note at once, with no batch
//          and none of the shared HQ. A claim is a lease: a peer's claim not renewed for LEASE_MS is gone, so a body
//          holds a mob only by keeping on claiming it.
//
// Every body uses the claims (mob_claims). A squad (AUREN_SQUAD, a comma-separated list of bot ids) also shares its radar
// and its melee blobs: a mob one member sees, another may take; melee mobs standing together are one claim.
//
// THE TANDEM: one guard to one worker, paired by sorted id. A guard (guard_manager) says it is on duty on this road and stands between
// its ward and the dark, fighting as any body does. A worker on tandem work (job_gates.tandemWork) runs the commander's gate as any body does; a mob the gate confirms is
// named on this road instead of fought, unless it struck the worker, stands within CONTACT_B, or is a fuse in its blast reach. The
// guard takes those mobs past any claim (commander's WARD DOOR), prefers them while nothing is in its reach, chases a mob until it
// is past LEASH_B of the ward, then returns. When the guard's duty lapses the worker fights for
// itself again and the night gate shuts on its job.

'use strict';

const crewLog = require('@api/crew_log');

const TAG = 'combat_board';

const NOTE_RENEW_MS = 250;
const LEASE_MS = 600;
const COMMS_REPORT_MS = 30000;
// A squad member's radar reaches this far from the body that uses it.
const RADAR_REACH_B = 32;
// Melee mobs within this of one another are one blob, and a blob spans at most BLOB_SPAN_B from the mob it grew from, so a
// long line of mobs is not one claim.
const BLOB_LINK_B = 4;
const BLOB_SPAN_B = 12;
const AIM_CONE_RAD = 40 * Math.PI / 180;
// A fight takes the guard off its job: its duty stands this long past the last stamp, so the worker keeps working through it.
const DUTY_HOLD_MS = 60000;
// A guard not heard from for this long is gone. Longer than a claim's lease: its lapse recalls the worker home.
const DUTY_LEASE_MS = 3000;
// A mob inside this of a worker is the worker's own fight: with three zombies on it a body striking only the last biter
// took 13 health in 7 s from the two it had declined.
const CONTACT_B = 5;
// A guard leaves a mob this far from its ward: one chased a skeleton 47 b and left its worker alone.
const LEASH_B = 24;
const WORKED_HOLD_MS = 15000;

const SQUAD = (process.env.AUREN_SQUAD || '').split(',').map((s) => s.trim()).filter(Boolean);
const _me = () => process.env.BOT_ID || 'default';

// The arena's standing roles: AUREN_TANDEM=worker:AurenBot,guard:IrisBot. No job runs under a sentry's watch.
const benchRole = () => {
  const row = (process.env.AUREN_TANDEM || '').split(',').map((s) => s.trim().split(':')).find(([, id]) => id === _me());
  return row ? row[0] : null;
};

const inSquad = () => SQUAD.includes(_me());
const isSquadmate = (id) => id !== _me() && SQUAD.includes(id);

let _claim = null;      // { id, at, blob: [ids] }
let _seen = [];         // ids this squad body has in its fight
let _helping = false;   // on a peer's blob: this body strikes it without claiming it
let _pos = null;
let _dutyAt = 0;        // when this body last said it guards; 0 off duty
let _working = false;   // declining on a guard's word
let _workedAt = 0;      // when this body last worked under a guard
let _ward = [];         // the mobs this worker hands its guard
let _sentAt = 0;
let _sentKey = '';
const _peers = new Map();   // botId → { claim, seen, pos, receivedAt }
let _comms = { notes: 0, total: 0, max: 0, since: 0 };

function setClaim(claim) { _claim = claim; }
function claim() { return _claim; }
function setSeen(ids) { _seen = ids; }
function setHelping(on) { _helping = on; }
function onDuty(now = Date.now()) { return _dutyAt > 0 && now - _dutyAt <= DUTY_HOLD_MS; }
function standDuty(now = Date.now()) {
  if (!onDuty(now)) crewLog.post(TAG, 'tandem', { role: 'guard', state: 'on_duty' });
  _dutyAt = now;
}
function endDuty() {
  if (_dutyAt) crewLog.post(TAG, 'tandem', { role: 'guard', state: 'off_duty' });
  _dutyAt = 0;
}
function setWorking(on, ward) {
  if (on !== _working) crewLog.post(TAG, 'tandem', { role: 'worker', state: on ? 'declining' : 'fighting' });
  if (on) _workedAt = Date.now();
  _working = on;
  _ward = on ? ward : [];
}

function _send(now) {
  _sentAt = now;
  require('@utils/external_library_guard').guardExternalSync(TAG, 'send combat note', () => require('@kernel/foreman_link').sendCombatNote({
    sent_at: now,
    claim: _helping ? null : _claim,
    seen: _seen,
    pos: _pos,
    duty: onDuty(now),
    working: _working,
    ward: _ward,
  }));
}

// tick(bot, now) — once per commander sweep. A change goes the same sweep; a body holding nothing sends nothing.
function tick(bot, now) {
  const p = bot.entity && bot.entity.position;
  _pos = p ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 } : null;
  const held = !!_claim || _seen.length > 0 || onDuty(now) || _working;
  const key = `${_helping ? '' : _claim ? `${_claim.id}:${_claim.at}:${_claim.blob.join('+')}` : ''}|${_seen.join('+')}|${onDuty(now)}|${_working}|${_ward.join('+')}`;
  if (key !== _sentKey || (held && now - _sentAt >= NOTE_RENEW_MS)) {
    _sentKey = key;
    _send(now);
  }
}

// receive(botId, payload) — one peer's note, off the foreman's relay. The latency is the two clocks of one machine.
function receive(botId, payload, now = Date.now()) {
  _peers.set(botId, { claim: payload.claim || null, seen: payload.seen || [], pos: payload.pos || null, duty: payload.duty === true, working: payload.working === true, ward: payload.ward || [], receivedAt: now });
  const lag = Math.max(0, now - payload.sent_at);
  _comms.notes++;
  _comms.total += lag;
  if (lag > _comms.max) _comms.max = lag;
  if (!_comms.since) _comms.since = now;
  if (now - _comms.since >= COMMS_REPORT_MS) {
    crewLog.post(TAG, 'comms', { notes: _comms.notes, mean_ms: Math.round(_comms.total / _comms.notes), max_ms: _comms.max });
    _comms = { notes: 0, total: 0, max: 0, since: now };
  }
}

// liveClaims(now) → [{ botId, id, at, blob, pos }] for every peer whose lease stands.
function liveClaims(now = Date.now()) {
  const out = [];
  for (const [botId, n] of _peers) {
    if (n.claim && now - n.receivedAt <= LEASE_MS) out.push({ ...n.claim, botId, pos: n.pos });
  }
  return out;
}

// radar(now) → Set of mob ids a squadmate has in its fight.
function radar(now = Date.now()) {
  const out = new Set();
  if (!inSquad()) return out;
  for (const [botId, n] of _peers) {
    if (!isSquadmate(botId) || now - n.receivedAt > LEASE_MS) continue;
    for (const id of n.seen) out.add(id);
  }
  return out;
}

// guardOnDuty(now) → whether a guard's duty is heard on this road.
function guardOnDuty(now = Date.now()) {
  for (const n of _peers.values()) if (n.duty && now - n.receivedAt <= DUTY_LEASE_MS) return true;
  return false;
}

// workers(now) → [{ botId, pos }] for the peers declining on a guard's word.
function workers(now = Date.now()) {
  const out = [];
  for (const [botId, n] of _peers) if (n.working && n.pos && now - n.receivedAt <= DUTY_LEASE_MS) out.push({ botId, pos: n.pos });
  return out;
}

// guardKitted(bot) → whether this body carries the least a guard stands with: a sword or an axe, and a shield.
function guardKitted(bot) {
  return ['sword', 'axe'].includes(require('@utils/combat_utils').pickBestWeapon(bot).rung)
    && bot.inventory.items().some((i) => i.name === 'shield');
}

// ── ONE GUARD TO ONE WORKER ──
// Both sides sort the same two lists, so the i-th guard stands by the i-th worker with no message saying so.
function _guardIds(now) {
  const ids = [..._peers].filter(([, n]) => n.duty && now - n.receivedAt <= DUTY_LEASE_MS).map(([id]) => id);
  if (onDuty(now)) ids.push(_me());
  return ids.sort();
}
function _workerIds(now) {
  const ids = [..._peers].filter(([, n]) => n.working && now - n.receivedAt <= DUTY_LEASE_MS).map(([id]) => id);
  if (_working) ids.push(_me());
  return ids.sort();
}

// tandemSeatOpen(now) → whether a guard stands free for this body. Two bodies taking the last guard in one sweep sort it out:
// the one past the guards' count loses its seat on the next.
function tandemSeatOpen(now = Date.now()) {
  const guards = _guardIds(now).length;
  const workersNow = _workerIds(now);
  return _working ? workersNow.indexOf(_me()) < guards : workersNow.length < guards;
}

// guardSeatOpen(seat, now) → whether the seat'th guard's seat is open to this body: a guard's own seat, held through a fight, or one
// past the guards already on duty. A guard's fight drops its job, and its duty stands; no other body takes its place.
function guardSeatOpen(seat, now = Date.now()) {
  if (onDuty(now)) return true;
  return _guardIds(now).length < seat;
}

// wardOf(now) → { botId, pos } of the worker this guard stands by, or null.
function wardOf(now = Date.now()) {
  if (!onDuty(now)) return null;
  const id = _workerIds(now)[_guardIds(now).indexOf(_me())];
  const n = id ? _peers.get(id) : null;
  return n && n.pos ? { botId: id, pos: n.pos } : null;
}

const _fromWard = (ward, pos) => Math.hypot(ward.pos.x - pos.x, ward.pos.z - pos.z);

// beyondLeash(pos, now) → whether a guard has a ward and this point lies past LEASH_B of it.
function beyondLeash(pos, now = Date.now()) {
  const ward = wardOf(now);
  return !!ward && _fromWard(ward, pos) > LEASH_B;
}

// wards(now) → Set of the mob ids this guard's ward hands it. Off duty it is empty.
function wards(now = Date.now()) {
  const ward = wardOf(now);
  return new Set(ward ? (_peers.get(ward.botId).ward || []) : []);
}

// workedRecently(now) → whether this body worked under a guard this recently. A fight drops its job, so read off the job alone a
// worker's own fight would be yielded to a guard's claim at any distance.
function workedRecently(now = Date.now()) { return _workedAt > 0 && now - _workedAt <= WORKED_HOLD_MS; }

// blobOf(seed, melee) → the ids of `seed`'s blob, among `melee` ({ id, position }), seed included. Pure.
function blobOf(seed, melee) {
  const gap = (a, b) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
  const inBlob = [seed];
  const rest = melee.filter((m) => m.id !== seed.id && gap(m, seed) <= BLOB_SPAN_B);
  for (let grew = true; grew;) {
    grew = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (inBlob.some((m) => gap(m, rest[i]) <= BLOB_LINK_B)) { inBlob.push(rest[i]); rest.splice(i, 1); grew = true; }
    }
  }
  return inBlob.map((m) => m.id).sort((a, b) => a - b);
}

// aimsElsewhere(mob, self) → true when the server's reported head facing points away from this body by more than
// AIM_CONE_RAD. No facing read answers false: the shield stays on the draw alone.
function aimsElsewhere(mob, self) {
  const yaw = Number.isFinite(mob.headYaw) ? mob.headYaw : mob.yaw;
  if (!Number.isFinite(yaw)) return false;
  const toMe = Math.atan2(-(self.x - mob.position.x), -(self.z - mob.position.z));
  return Math.abs(Math.atan2(Math.sin(yaw - toMe), Math.cos(yaw - toMe))) > AIM_CONE_RAD;
}

function reset() {
  _claim = null; _seen = []; _helping = false; _pos = null; _dutyAt = 0; _working = false; _workedAt = 0; _ward = []; _sentAt = 0; _sentKey = '';
  _peers.clear();
  _comms = { notes: 0, total: 0, max: 0, since: 0 };
}

module.exports = {
  benchRole, onDuty, standDuty, endDuty, setWorking, guardKitted, guardOnDuty, tandemSeatOpen, guardSeatOpen, wardOf, workers, wards, beyondLeash, workedRecently, CONTACT_B,
  inSquad, isSquadmate, setClaim, claim, setSeen, setHelping, tick, receive, liveClaims, radar, blobOf, aimsElsewhere, reset,
  LEASE_MS, RADAR_REACH_B,
};
