// foreman/pen_keeper.js — THE KEEPER'S WATCH OVER THE PENS: EVERY PENNED ANIMAL BY ITS ID, IN AND OUT.
//
// A pen is a plan at a fixed place, and what it holds is the keeper's to keep (integrity_keeper.js, SCOPE): one
// census of every pen for the whole crew, read off the keeper's own body, which hangs over the base and hears every
// entity there. A body never counts a pen for itself while a keeper stands (pen_gate.keptPen).
//
// ── WHAT IT KEEPS ─────────────────────────────────────────────────────────────────────────────────────
// A PEN IS WATCHED ONCE IT STANDS. Until the keeper's own structures reading first finds the pen built whole, its
// ground is open field: an animal crossing it is wild, never penned, never escaped. From that reading on the pen is
// watched for the rest of the run, whole or broken: an animal out through a broken fence is an escape like any
// other, and its line says whether the pen read whole (`whole=`).
// Per pen: the ids of the animals of its kind inside the fence, the gate's state, and how many have entered, left
// and been lost since the keeper first saw the pen. Each change is said as it happens, in the keeper's record:
//   PEN_STANDS    the keeper's structures reading first found the pen built whole: the watch begins.
//   PEN_KEPT      the pen first seen: what it holds, adopted as penned.
//   PEN_ENTERED   an animal came in (led in, or a lamb born inside); PEN_RETURNED when it had left before.
//   PEN_ESCAPED   a penned animal stands outside the fence. Never meant to happen, so it is said loudly (🚨): the line
//                 names the gate's state and how long it had stood open, the animal's distance from the gate, every
//                 body within HERDING.keeper_near_blocks of it with its distance and what is in its two hands, and every
//                 body standing inside the fence, so the one who let it out is named. Its `cause` is read from those
//                 (escapeCause) and a suggestion of where to look follows the fields.
//   PEN_LOST      a penned animal is gone from the world: died (a cull, a wolf) or vanished; the same bodies named.
//   PEN_STRANGER  an animal another pen keeps (a cow in the sheep pen) first seen inside the fence, said loudly (warn)
//                 with the gate's state and every body near it and inside, so the way it came in is named.
//   WOLF_NEAR_PEN a wolf within HERDING.wolf_alert_blocks of a fence, once per wolf per HERDING.wolf_warn_ms.
//   PEN_SIGHT     the pen came into or went out of the keeper's sight (HERDING.keeper_sight_blocks): out of sight it
//                 is unknown, never empty, and its ids are adopted again when it is seen.
//
// ── THE VERDICT ───────────────────────────────────────────────────────────────────────────────────────
// Subject `pens`: { generated_at, pens: { [structure]: { animal, stood, seen, count, ids, gate_open, entered, escaped,
// lost, out, strangers } } }, `strangers` the ids of other pens' animals inside the fence, `out` the ids of escaped animals still in the world and not back inside (ranching herds them back) (seen is false until the pen stands), posted when it changes, at most every POST_MS, and renewed every RENEW_MS unchanged. A crew with no
// pen still gets the verdict, with no pens in it.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const timeoutCrash = require('@utils/timeout_crash');
const { HERDING } = require('@thinking/architect_config');
const { roomKeyName, isBuildingTombstone } = require('./message_schema');

const TAG = 'pen_keeper';
const POST_MS = 1000;
const RENEW_MS = 10000;
const DEAD_KEEP_MS = 10000;      // an entity's death is remembered this long, to name a lost animal's cause

let _bot = null;
let _plans = () => ({});
let _whole = () => null;
let _publish = () => {};
let _timer = null;
const _pens = new Map();         // structure → pen state (below)
const _dead = new Map();         // entity id → when the server said it died
const _wolfSaid = new Map();     // wolf id → when it was last said
let _dirty = true;
let _postedAt = 0;

const cell = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const onDead = (e) => { if (e && e.id != null) _dead.set(e.id, Date.now()); };

// The pens the plans site, each built once per locked origin (pen_gate.penAt).
function refreshPens() {
  const { penAt, penGeometry } = require('@api/pen_gate');
  const seen = new Set();
  for (const [roomKey, entry] of Object.entries(_plans() || {})) {
    const name = roomKeyName(roomKey);
    if (!HERDING.pens[name] || !entry || isBuildingTombstone(entry)) continue;
    const o = entry.set_buildspot && entry.set_buildspot.transpose_origin;
    if (!o || typeof o.x !== 'number') continue;
    seen.add(name);
    const at = `${o.x},${o.y},${o.z}`;
    if (_pens.get(name)?.at === at) continue;
    const geo = penGeometry(penAt(name, o));
    const i = geo.interior;
    _pens.set(name, {
      at, geo, mid: { x: (i.x1 + i.x2 + 1) / 2, z: (i.z1 + i.z2 + 1) / 2 },
      stood: false, seen: null, adopted: false, inside: new Map(), left: new Map(), strangers: new Map(), entered: 0, escaped: 0, lost: 0, gate: 'unknown', gateOpenAt: null,
    });
    _dirty = true;
  }
  for (const name of [..._pens.keys()]) if (!seen.has(name)) { _pens.delete(name); _dirty = true; }
}

// Inside the fence: within its posts (pen_gate.insidePen) and on its floor (an animal under or over the pen is outside).
function inside(geo, p) {
  const i = geo.interior;
  return require('@api/pen_gate').insidePen(geo, p) && p.y >= i.floor_y - 1 && p.y < i.floor_y + 3;
}

// The gate's state as the keeper's world holds it: open (any of its gates), shut, or unknown (not loaded).
function gateState(geo) {
  let any = false;
  for (const g of geo.gates) {
    const b = _bot.blockAt(new Vec3(g.x, g.y, g.z));
    if (!b || !/_fence_gate$/.test(b.name)) return 'unknown';
    if (b.getProperties().open) any = true;
  }
  return any ? 'open' : 'shut';
}

// Whether the pen read whole at this moment: yes, no (a fence or gate missing), or unknown (not read).
const wholeText = (name) => { const w = _whole(name); return w === true ? 'yes' : w === false ? 'no' : 'unknown'; };

// The bodies within keeper_near_blocks of `p`, nearest first: `name:dist:hands=main/off`, or '-'.
function nearText(bodies, p) {
  const near = bodies.map(b => ({ b, d: Math.hypot(b.position.x - p.x, b.position.y - p.y, b.position.z - p.z) }))
    .filter(r => r.d <= HERDING.keeper_near_blocks).sort((a, b) => a.d - b.d);
  if (!near.length) return '-';
  return near.map(({ b, d }) => `${b.username}:${d.toFixed(1)}b:hands=${b.equipment?.[0]?.name || '-'}/${b.equipment?.[1]?.name || '-'}`).join(',');
}

// escapeCause(gate, openFor, whole, inPen, bodies, at) → { cause, suggest }: the likeliest way out, read in this order,
// and where to look next.
//   gate_open      the gate stood open as it left
//   fence_broken   the pen did not read whole (a fence or gate cell missing)
//   body_in_pen    the gate shut and the pen whole, with a body inside the fence: its wheat draws the flock to it
//   unexplained    none of these
function escapeCause(gate, openFor, whole, inPen, bodies, at) {
  const nearest = bodies.map(b => ({ b, d: flat(b.position, at) })).sort((a, b) => a.d - b.d)[0]?.b?.username || 'no body near';
  if (gate === 'open') return { cause: 'gate_open', suggest: `the gate stood open ${openFor === null ? 'an unknown time' : openFor.toFixed(1) + 's'}; ${nearest} is nearest. A crossing opens, steps through and shuts within one step (pen_gate.passGate): read that body's GATE and HERD_STEP lines for the step it held the gate open over.` };
  if (whole === 'no') return { cause: 'fence_broken', suggest: `the pen does not read whole: find the missing cell in the BUILDING_INTEGRITY anchors line and who stood beside it last (navigator 'dig refused', a step dig, a creeper); ${nearest} is nearest.` };
  if (inPen.length) return { cause: 'body_in_pen', suggest: `${inPen.join(', ')} stood inside the fence with the gate shut: a body leading from inside walks the flock to the fence. Check why it was in this pen (animal_finder takes no animal from any crew pen).` };
  return { cause: 'unexplained', suggest: `gate shut, pen whole, no body inside: look at the fence beside ${cell(at)} for a corner or a raised block the animal stepped over, and at server lag (a rubber-banded animal).` };
}

function verdict() {
  const pens = {};
  for (const [name, p] of _pens) {
    pens[name] = {
      animal: p.geo.animal, stood: p.stood, seen: p.stood && p.seen === true, count: p.stood && p.seen ? p.inside.size : null, ids: p.stood && p.seen ? [...p.inside.keys()] : [],
      gate_open: p.gate === 'open' ? true : p.gate === 'shut' ? false : null, entered: p.entered, escaped: p.escaped, lost: p.lost,
      strangers: p.stood && p.seen ? [...p.strangers.keys()] : [],
      out: [...p.left.keys()].filter(id => { const e = _bot && _bot.entities[id]; return !!e && e.isValid !== false; }),
    };
  }
  return { generated_at: new Date().toISOString(), pens };
}

function watchPen(name, p, ents, bodies, wolves, now) {
  if (!p.stood) {
    if (_whole(name) !== true) return;
    p.stood = true;
    _dirty = true;
    watcher.summary(TAG, `PEN_STANDS pen=${name} animal=${p.geo.animal} gate=${cell(p.geo.gate)} whole=yes`);
  }
  const me = _bot.entity.position;
  const seen = flat(me, p.mid) <= HERDING.keeper_sight_blocks;
  if (seen !== p.seen) {
    p.seen = seen;
    _dirty = true;
    const line = `PEN_SIGHT pen=${name} seen=${seen} keeper_at=${cell(me)} dist=${flat(me, p.mid).toFixed(0)}`;
    if (seen) watcher.summary(TAG, line); else watcher.warn(TAG, line);
    if (!seen) { p.inside.clear(); p.left.clear(); p.strangers.clear(); p.adopted = false; }
  }
  if (!seen) return;
  const gate = gateState(p.geo);
  if (gate !== p.gate) { p.gate = gate; p.gateOpenAt = gate === 'open' ? now : null; _dirty = true; }
  const now_in = new Map(ents.filter(e => e.name === p.geo.animal && inside(p.geo, e.position)).map(e => [e.id, e]));
  if (!p.adopted) {
    for (const [id, e] of now_in) p.inside.set(id, { since: now, at: e.position.clone() });
    p.adopted = true;
    _dirty = true;
    watcher.summary(TAG, `PEN_KEPT pen=${name} animal=${p.geo.animal} count=${p.inside.size} ids=${[...p.inside.keys()].join('/') || '-'} gate=${gate}`);
    return;
  }
  for (const [id, e] of now_in) {
    const rec = p.inside.get(id);
    if (rec) { rec.at = e.position.clone(); continue; }
    p.inside.set(id, { since: now, at: e.position.clone() });
    p.entered++;
    _dirty = true;
    const back = p.left.delete(id);
    watcher.summary(TAG, `PEN_${back ? 'RETURNED' : 'ENTERED'} pen=${name} animal=${p.geo.animal} id=${id} at=${cell(e.position)} count=${p.inside.size} gate=${gate} near=${nearText(bodies, e.position)}`);
  }
  for (const [id, rec] of [...p.inside]) {
    if (now_in.has(id)) continue;
    p.inside.delete(id);
    _dirty = true;
    const e = _bot.entities[id];
    const held = rec.at ? `${((now - rec.since) / 1000).toFixed(0)}s` : '-';
    if (e && e.isValid !== false && e.position) {
      p.escaped++;
      p.left.set(id, now);
      const openFor = p.gateOpenAt === null ? null : (now - p.gateOpenAt) / 1000;
      const inPen = bodies.filter(b => inside(p.geo, b.position)).map(b => b.username);
      const why = escapeCause(gate, openFor, wholeText(name), inPen, bodies, e.position);
      watcher.warn(TAG, `🚨 ANIMAL ESCAPED 🚨 PEN_ESCAPED pen=${name} animal=${p.geo.animal} id=${id} at=${cell(e.position)} from_gate=${flat(e.position, p.geo.gate).toFixed(1)}b gate=${gate} gate_open_s=${openFor === null ? '-' : openFor.toFixed(1)} penned_for=${held} count=${p.inside.size} whole=${wholeText(name)} cause=${why.cause} in_pen=${inPen.join('/') || '-'} near=${nearText(bodies, e.position)} — suggest: ${why.suggest}`);
    } else {
      p.lost++;
      const died = _dead.has(id);
      watcher.warn(TAG, `PEN_LOST pen=${name} animal=${p.geo.animal} id=${id} cause=${died ? 'died' : 'vanished'} last_at=${cell(rec.at)} penned_for=${held} count=${p.inside.size} whole=${wholeText(name)} near=${nearText(bodies, rec.at)}`);
    }
  }
  // ANOTHER PEN'S ANIMAL INSIDE THIS FENCE: said once per animal while it stays, and again if it comes back.
  const kept = new Set(Object.values(HERDING.pens).map(r => r.animal));
  const strangers = new Map(ents.filter(e => e.name !== p.geo.animal && kept.has(e.name) && inside(p.geo, e.position)).map(e => [e.id, e]));
  for (const [id, e] of strangers) {
    if (p.strangers.has(id)) continue;
    p.strangers.set(id, now);
    _dirty = true;
    const inPen = bodies.filter(b => inside(p.geo, b.position)).map(b => b.username);
    watcher.warn(TAG, `PEN_STRANGER pen=${name} animal=${e.name} id=${id} at=${cell(e.position)} from_gate=${flat(e.position, p.geo.gate).toFixed(1)}b gate=${gate} `
      + `whole=${wholeText(name)} in_pen=${inPen.join('/') || '-'} near=${nearText(bodies, e.position)}`);
  }
  for (const id of [...p.strangers.keys()]) if (!strangers.has(id)) { p.strangers.delete(id); _dirty = true; }
  const i = p.geo.interior;
  for (const w of wolves) {
    const dx = Math.max(i.x1 - 1 - w.position.x, 0, w.position.x - (i.x2 + 2));
    const dz = Math.max(i.z1 - 1 - w.position.z, 0, w.position.z - (i.z2 + 2));
    const d = Math.hypot(dx, dz);
    if (d > HERDING.wolf_alert_blocks || now - (_wolfSaid.get(w.id) || 0) < HERDING.wolf_warn_ms) continue;
    _wolfSaid.set(w.id, now);
    watcher.warn(TAG, `WOLF_NEAR_PEN pen=${name} wolf=${w.id} at=${cell(w.position)} from_fence=${d.toFixed(1)}b penned=${p.inside.size} gate=${gate} near=${nearText(bodies, w.position)}`);
  }
}

function tick() {
  const now = Date.now();
  for (const [id, at] of _dead) if (now - at > DEAD_KEEP_MS) _dead.delete(id);
  if (_bot && _bot.entity && _bot.entity.position) {
    refreshPens();
    const ents = Object.values(_bot.entities || {}).filter(e => e && e !== _bot.entity && e.isValid !== false && e.position);
    const bodies = ents.filter(e => e.type === 'player' && e.username && e.username !== _bot.username);
    const wolves = ents.filter(e => e.name === 'wolf');
    for (const [name, p] of _pens) watchPen(name, p, ents, bodies, wolves, now);
  }
  if ((_dirty && now - _postedAt >= POST_MS) || now - _postedAt >= RENEW_MS) {
    _dirty = false;
    _postedAt = now;
    _publish('pens', verdict());
  }
}

// attach(bot) — the keeper's body; its entity table is what the watch reads.
function attach(bot) {
  if (_bot === bot) return;
  if (_bot) _bot.removeListener('entityDead', onDead);
  _bot = bot;
  _bot.on('entityDead', onDead);
}

// start({ bot, whole, plans, publish }) — whole(structure) → the keeper's structures reading of a pen (true built
// whole, false not, null unread); plans() → the buildings the hub holds; publish(subject, verdict) sends it out.
function start({ bot, whole, plans, publish }) {
  if (_timer) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): start() called twice.`);
  _plans = plans;
  _whole = whole;
  _publish = publish;
  attach(bot);
  _timer = timeoutCrash.every(TAG, 'watch every pen\'s animals, gate and the bodies beside it', tick, HERDING.keeper_tick_ms);
  tick();
}

function stop() {
  if (_timer) timeoutCrash.stop(_timer);
  _timer = null;
  if (_bot) _bot.removeListener('entityDead', onDead);
}

module.exports = { start, attach, stop };
