// Auren_Bot/monitoring/tandem_lens.js
// --tandem: the night's guards and the workers they stand for. Guard seats claimed and held, workers declining on a guard's
// word, the mobs handed across (aggro via ward or contact), what those fights killed, and who was hurt in which role.
// Reads the dispatcher's claim line, BOT_MINUTES, combat_board's tandem line and the crew events. Inputs as ARGUMENTS, render,
// RETURN; no process.argv, no process.exit.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --tandem

'use strict';

const out = require('./data_out');
const crewLog = require('@api/crew_log');

const GUARD_CLAIM_RE = /Claimed \[[^\]]*\] guard\/tandem_guard/;
const GUARD_SPAN_RE = /span=\S+ job=guard\/tandem_guard held=([\d.]+)s/;
const GUARD_WALK_RE = /walk_share job=guard\/tandem_guard held=([\d.]+)s walk=([\d.]+)s/;
const OFF_DUTY_RE = /guard_manager: off duty after (\d+) walk\(s\) (.+)$/;
const TANDEM_RE = /tandem role=(\S+) state=(\S+)/;
const PROOF_SPAN_RE = /span=\S+ job=build\/spawn_proofing_execute held=([\d.]+)s/;
const KILLED_RE = /Engagement cleared — killed: ([^;]*);/;
const POST_RE = /POST_CLEAR posts=(\d+) felled=(\d+)/;

const inSpan = (spans, t) => spans.some(s => t >= s.from && t <= (s.to == null ? Infinity : s.to));
const min = (sec) => +(sec / 60).toFixed(1);

function reduceTandem({ seg = [] } = {}) {
  const bots = new Map();
  const B = (name) => {
    if (!bots.has(name)) bots.set(name, { guard: [], worker: [], claims: 0, heldSec: 0, walkSec: 0, offDuty: [] });
    return bots.get(name);
  };
  const seen = new Set();
  const lines = [];
  for (const l of seg) {
    const raw = l.raw || '';
    if (l.relSec == null || !l.bot) continue;
    const key = `${l.bot}|${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const b = B(l.bot);
    let m;
    if (GUARD_CLAIM_RE.test(raw)) {
      b.claims++;
      b.guard.push({ from: l.relSec, to: null });
    } else if ((m = GUARD_SPAN_RE.exec(raw))) {
      b.heldSec += +m[1];
      const open = b.guard.find(s => s.to == null);
      if (open) open.to = l.relSec;
    } else if ((m = GUARD_WALK_RE.exec(raw))) {
      b.walkSec += +m[2];
    } else if ((m = OFF_DUTY_RE.exec(raw))) {
      b.offDuty.push({ at: l.relSec, walks: +m[1], why: m[2] });
    } else if ((m = TANDEM_RE.exec(raw))) {
      if (m[1] === 'worker' && m[2] === 'declining') b.worker.push({ from: l.relSec, to: null });
      if (m[1] === 'worker' && m[2] === 'fighting') {
        const open = b.worker.find(s => s.to == null);
        if (open) open.to = l.relSec;
      }
    }
    lines.push({ l, raw, b });
  }
  const role = (b, t) => (inSpan(b.guard, t) ? 'guard' : inSpan(b.worker, t) ? 'worker' : 'other');
  const tally = {
    guard: { hurts: 0, lost: 0, kills: 0, fights: 0, declined: 0 },
    worker: { hurts: 0, lost: 0, kills: 0, fights: 0, declined: 0 },
    other: { hurts: 0, lost: 0, kills: 0, fights: 0, declined: 0 },
  };
  const via = {};
  const handed = [];
  let postsWhileDeclining = 0, felledWhileDeclining = 0, proofSecWhileDeclining = 0, deaths = 0;
  for (const { l, raw, b } of lines) {
    const r = role(b, l.relSec);
    let m;
    if ((m = KILLED_RE.exec(raw))) tally[r].kills += m[1].trim() === 'none' ? 0 : m[1].split(',').length;
    if (r === 'worker' && (m = POST_RE.exec(raw))) { postsWhileDeclining += +m[1]; felledWhileDeclining += +m[2]; }
    if (r === 'worker' && (m = PROOF_SPAN_RE.exec(raw))) proofSecWhileDeclining += +m[1];
    for (const ev of crewLog.parseAll(raw)) {
      if (ev.verb === 'hurt') { tally[r].hurts++; tally[r].lost += crewLog.num(ev.fields, 'lost') || 0; }
      if (ev.verb === 'declined') tally[r].declined++;
      if (ev.verb === 'death') deaths++;
      if (ev.verb === 'aggro') {
        tally[r].fights++;
        const door = ev.fields.via || '—';
        via[`${r}:${door}`] = (via[`${r}:${door}`] || 0) + 1;
        if (door === 'ward' || door === 'contact') {
          const s = ev.subject;
          const mob = s && typeof s === 'object' ? `${s.name}#${s.id}` : (s || '—');
          handed.push({ at: l.relSec, bot: l.bot, role: r, door, mob, killed: lines.some(o => o.l.bot === l.bot && o.l.relSec >= l.relSec && KILLED_RE.test(o.raw) && KILLED_RE.exec(o.raw)[1].includes(mob)) });
        }
      }
    }
  }
  // ── EVERY FIGHT A HANDED MOB WAS IN, BY ANYONE, AND EVERY FIGHT A GUARD BODY OPENED WHILE ON THE TANDEM ──
  const mobName = (ev) => {
    const s = ev.subject;
    return s && typeof s === 'object' ? `${s.name}#${s.id}` : (s || null);
  };
  const handedMobs = new Set(handed.map(h => h.mob));
  const guardBodies = new Set([...bots.entries()].filter(([, b]) => b.claims > 0).map(([name]) => name));
  const stamps = lines.filter(({ raw }) => TANDEM_RE.test(raw)).map(({ l }) => Date.parse(l.iso)).filter(Number.isFinite);
  const from = stamps.length ? Math.min(...stamps) : 0;
  const to = stamps.length ? Math.max(...stamps) + 60000 : 0;
  const fightLog = [];
  const fights = new Map();
  for (const { l, raw } of lines) {
    const at = Date.parse(l.iso);
    if (!Number.isFinite(at) || at < from || at > to) continue;
    for (const ev of crewLog.parseAll(raw)) {
      if (!['aggro', 'engage', 'end', 'unreachable', 'yield', 'hurt'].includes(ev.verb)) continue;
      const mob = mobName(ev);
      if (!mob || !(handedMobs.has(mob) || guardBodies.has(l.bot))) continue;
      const f = ev.fields || {};
      fightLog.push({ at: l.iso.slice(11, 19), bot: l.bot, role: role(bots.get(l.bot), l.relSec), verb: ev.verb, mob, d: f.d ?? null, via: f.via ?? null, outcome: f.outcome ?? null, hit: f.hit ?? null, why: f.why ?? null, to: f.to ?? null, lost: f.lost ?? null });
      if (ev.verb === 'end') {
        const o = fights.get(f.outcome || '—') || { ends: 0, hits: 0 };
        o.ends++;
        o.hits += crewLog.num(f, 'hit') || 0;
        fights.set(f.outcome || '—', o);
      }
    }
  }
  return { bots, tally, via, handed, postsWhileDeclining, felledWhileDeclining, proofSecWhileDeclining, deaths, fightLog, fights };
}

const spanSec = (spans, end) => spans.reduce((n, s) => n + Math.max(0, (s.to == null ? end : s.to) - s.from), 0);

function runTandem({ seg = [], traceName = '?' } = {}) {
  const r = reduceTandem({ seg });
  const end = seg.reduce((n, l) => Math.max(n, l.relSec || 0), 0);
  const rows = [...r.bots.entries()];

  out.kv('lens', 'tandem');
  out.kv('record', traceName);

  out.section('duty');
  out.kv('guard_seats_claimed', rows.reduce((n, [, b]) => n + b.claims, 0));
  out.kv('guard_bodies', rows.filter(([, b]) => b.claims > 0).length);
  out.kv('guard_held_min', min(rows.reduce((n, [, b]) => n + b.heldSec, 0)));
  out.kv('guard_walking_min', min(rows.reduce((n, [, b]) => n + b.walkSec, 0)));
  out.kv('worker_bodies_declining', rows.filter(([, b]) => b.worker.length > 0).length);
  out.kv('worker_declining_min', min(rows.reduce((n, [, b]) => n + spanSec(b.worker, end), 0)));
  out.kv('proofing_min_finished_while_declining', min(r.proofSecWhileDeclining));
  out.kv('posts_finished_while_declining', r.postsWhileDeclining);
  out.kv('trees_felled_while_declining', r.felledWhileDeclining);
  out.kv('deaths', r.deaths);

  out.section('by_role');
  out.table(['role', 'fights_opened', 'kills', 'hurts', 'health_lost', 'mobs_declined'],
    Object.entries(r.tally).map(([role, t]) => [role, t.fights, t.kills, t.hurts, t.lost, t.declined]));

  out.section('fights_by_door');
  out.table(['role_and_door', 'fights'], Object.entries(r.via).sort((a, b) => b[1] - a[1]));

  out.section('mobs_handed_across');
  out.kv('handed', r.handed.length);
  out.kv('killed_by_the_body_handed_it', r.handed.filter(h => h.killed).length);
  out.table(['at_min', 'bot', 'role', 'door', 'mob', 'killed'], r.handed.map(h => [min(h.at), h.bot, h.role, h.door, h.mob, h.killed]));

  out.section('fight_ends');
  out.table(['outcome', 'ends', 'hits'], [...r.fights.entries()].map(([k, v]) => [k, v.ends, v.hits]));

  out.section('fight_log');
  out.table(['at', 'bot', 'role', 'verb', 'mob', 'd', 'via', 'outcome', 'hit', 'why', 'to', 'lost'],
    r.fightLog.map(e => [e.at, e.bot, e.role, e.verb, e.mob, e.d, e.via, e.outcome, e.hit, e.why, e.to, e.lost]));

  out.section('guards');
  out.table(['bot', 'claims', 'held_min', 'walk_min', 'off_duty'],
    rows.filter(([, b]) => b.claims > 0).map(([name, b]) => [name, b.claims, min(b.heldSec), min(b.walkSec), b.offDuty.map(o => `${min(o.at)}:${o.walks}:${o.why}`.replace(/ /g, '_')).join(',') || '—']));

  out.section('workers');
  out.table(['bot', 'spans', 'declining_min'], rows.filter(([, b]) => b.worker.length > 0).map(([name, b]) => [name, b.worker.length, min(spanSec(b.worker, end))]));
}

module.exports = { reduceTandem, runTandem };
