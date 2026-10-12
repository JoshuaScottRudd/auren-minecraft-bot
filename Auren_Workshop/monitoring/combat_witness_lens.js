// combat_witness_lens — the ONE reader of fleet_logs/combat_witness/combat_witness.jsonl (Law 16: a
// recorded run is read only through its monitor).
//
// The record is written by camera/combat_witness.js: the server's own account of every fight the fleet
// had, from an observer outside the bot's own combat decisions.
//
// ── THE JOIN ─────────────────────────────────────────────────────────────────────────────────────────
// The witness's record and the bot's own journal are written blind to each other and meet for the first
// time in this reducer, so a disagreement between the two is a finding, not a bug. The join keys are both
// the server's:
//   · the MOB'S ENTITY ID — `mob`/`otherId` are the same server-assigned integer for the same mob on
//     both sides, not a name match or a nearest-in-time guess.
//   · the ABSOLUTE CLOCK — both records carry `t0` (an epoch millisecond) in their header and stamp every
//     row `t` relative to it, so `t0 + t` puts both on one timeline.
//
// It does not decide who was right: when the bot claims a fight the observer never saw, or the observer
// records blows the bot's journal has no row for, both are printed and the disagreement is named (Law 25).
//
// It does not decode mob metadata: samples carry raw `md` frames and this prints the FRAME COUNT only,
// never a decoded value (Law 23).
//
// Machine-facing verbs RETURN and never exit (readWitness, reduceWitness, witnessEngagementsSince);
// runWitness renders. Neither exits — trace_monitor owns the exit code, this owns the answer.

'use strict';

const fs = require('fs');
const path = require('path');
const combatLens = require('../../monitoring/combat_lens');

const WITNESS_DIR = require('../workshop_paths').fleetLogs('combat_witness');
const WITNESS_FILE = path.join(WITNESS_DIR, 'combat_witness.jsonl');

// How close two records' timestamps must be to count as the same moment — a measurement window, not a
// tolerance: the observer's pulse rests at 1 Hz, so it can be up to a second late noticing a fight the
// bot opened instantly.
const JOIN_WINDOW_MS = 1500;

const fmtSec = ms => `${(ms / 1000).toFixed(1)}s`;
const fmtClock = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const pct = (n, d) => (d > 0 ? `${(100 * n / d).toFixed(1)}%` : 'n/a');

// readWitness() -> { available, reason, rows }
//
// A missing file is the ordinary state of a fleet that has never run with mode.witness on, and it reads
// as that state, not as a broken instrument (Law 25). The reason string says which case applies.
function readWitness() {
  let text;
  try { text = fs.readFileSync(WITNESS_FILE, 'utf8'); }
  catch (e) {
    return { available: false, rows: [],
             reason: e.code === 'ENOENT'
               ? 'no witness record — the camera has not run with mode.witness on'
               : `cannot read ${WITNESS_FILE}: ${e.message}` };
  }
  const rows = [];
  let torn = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    // A torn last line is the cost of reading a file still being written; skipping it is the correct
    // read of a partial row, not a swallow (Law 13).
    try { rows.push(JSON.parse(s)); } catch { torn++; }
  }
  if (!rows.length) return { available: false, rows: [], reason: 'witness record is empty' };
  return { available: true, rows, torn, reason: null };
}

// reduceWitness(rows) -> the run, as facts. Every number is counted off rows the server produced; nothing
// here models Minecraft's rules.
function reduceWitness(rows) {
  const header = rows.find(r => r.k === 'h') || null;
  const trailer = rows.find(r => r.k === 'f') || null;
  const t0 = header && typeof header.t0 === 'number' ? header.t0 : null;

  // One entry per (bot, mob) pair — the same unit the detector opens and closes, so a fight is never
  // collapsed with the one happening three blocks away.
  const fights = new Map();
  const key = (bot, id) => `${bot}|${id}`;
  const openFight = (bot, id, row) => {
    const k = key(bot, id);
    let f = fights.get(k);
    if (!f) {
      f = { bot, mobId: id, mobName: row.otherName || null, kind: row.otherKind || null,
            startT: row.t, endT: null, reason: null, truncated: false,
            openDist: row.distance != null ? row.distance : null, closestDist: null, endDist: null,
            samples: 0, metaFrames: 0, hpFirst: null, hpLast: null,
            blowsOnBot: [], blowsByBot: [], swingsByBot: 0, deaths: [],
            deafMs: 0, deafSpans: 0 };
      fights.set(k, f);
    }
    return f;
  };

  const blind = [];          // every deaf span, for the per-fight overlap below
  const nose = { readings: 0, hits: 0, errors: 0, byBot: new Map() };
  let samples = 0, observed = 0, capped = false;

  for (const r of rows) {
    if (r.k === 'b') { blind.push({ from: r.t, to: r.t + (r.ms || 0), what: r.what }); continue; }
    if (r.k === 'n') {
      nose.readings++;
      if (r.error) nose.errors++; else if (r.near) nose.hits++;
      const b = nose.byBot.get(r.bot) || { readings: 0, hits: 0 };
      b.readings++; if (r.near) b.hits++;
      nose.byBot.set(r.bot, b);
      continue;
    }
    if (r.k === 'e') {
      if (r.type === 'witness_capped') { capped = true; continue; }
      if (r.phase === 'start') { openFight(r.subject, r.otherId, r); continue; }
      if (r.phase === 'end') {
        const f = fights.get(key(r.subject, r.otherId));
        if (!f) continue;                       // an end with no start: the record began mid-fight
        f.endT = r.t; f.reason = r.reason || null; f.truncated = !!r.truncated;
        continue;
      }
      continue;
    }
    if (r.k === 's') {
      samples++;
      for (const [, f] of fights) {
        if (f.bot !== r.bot || f.endT != null) continue;
        const m = (r.mobs || []).find(x => x.id === f.mobId);
        if (!m) continue;
        f.samples++;
        if (m.md) f.metaFrames++;
        if (m.n && !f.mobName) f.mobName = m.n;
        if (f.closestDist == null || (m.d != null && m.d < f.closestDist)) f.closestDist = m.d;
        f.endDist = m.d;
        if (f.hpFirst == null) f.hpFirst = r.hp;
        f.hpLast = r.hp;
      }
      continue;
    }
    if (r.k === 'o') {
      observed++;
      // An instant is attributed to whichever OPEN fight it names. A blow that names no open fight still
      // counts in `observed`, keeping visible a hit the detector never opened a pair for.
      for (const [, f] of fights) {
        if (f.endT != null) continue;
        if (r.type === 'hurt') {
          if (r.n === f.bot && r.byId === f.mobId) f.blowsOnBot.push({ t: r.t, srcType: r.srcType, hp: r.hp });
          else if (r.id === f.mobId && r.byName === f.bot) f.blowsByBot.push({ t: r.t, hp: r.hp });
        } else if (r.type === 'swing_arm' && r.n === f.bot) f.swingsByBot++;
        else if (r.type === 'dead' && r.id === f.mobId) f.deaths.push({ t: r.t, who: 'mob' });
        else if (r.type === 'dead' && r.n === f.bot) f.deaths.push({ t: r.t, who: 'bot' });
      }
      continue;
    }
  }

  // Deaf overlap per fight — how much of each engagement the camera spent inside its own ray loops. This
  // is the honesty column: a fight with high deafness and a low blow count needs that read before the
  // count above it is trusted.
  for (const [, f] of fights) {
    const end = f.endT != null ? f.endT : (trailer ? trailer.t : f.startT);
    for (const b of blind) {
      const lo = Math.max(f.startT, b.from), hi = Math.min(end, b.to);
      if (hi > lo) { f.deafMs += hi - lo; f.deafSpans++; }
    }
  }

  const list = [...fights.values()].sort((a, b) => a.startT - b.startT);
  return {
    header, trailer, t0, capped: capped || !!(trailer && trailer.capped),
    samples, observed, nose,
    blindSpans: blind.length,
    blindMs: blind.reduce((s, b) => s + (b.to - b.from), 0),
    dropped: trailer ? trailer.dropped : null,
    durationMs: trailer ? trailer.t : (list.length ? list[list.length - 1].startT : 0),
    fights: list,
  };
}

// joinClaims(reduced, { bot }) -> the observer's fights with the bot's own record attached.
//
// The bot's side comes from combat_lens — this file never opens the bot's record itself, because that
// record has exactly one reader and it is not this one (Law 16).
//
// The bot's claims come from `engage` lines on its own watcher trace, each carrying an absolute ISO
// stamp, joined against the observer's `t0`-relative rows.
//
// The verdict field is three-valued and none of the values is a judgement:
//   'both'        — the bot opened a fight against this mob and the observer saw one, within the window.
//   'claim_only'  — the bot's journal has an engage the observer never saw; the observer may have been
//                   out of range, and its own coverage is printed beside it.
//   'witness_only'— the observer saw a fight the bot's journal has no engage for.
function joinClaims(reduced, { bot = null } = {}) {
  const claims = [];
  for (const id of (bot ? [bot] : combatLens.traceBots())) {
    const lines = combatLens.readBotTrace(id);
    if (!lines) continue;
    for (const ev of combatLens.crewEvents(lines, 'battle_stations')) {
      if (ev.verb !== 'engage' || !ev.subject) continue;
      claims.push({ bot: id, mobId: ev.subject.id, name: ev.subject.name, at: ev.at, matched: false });
    }
  }
  const t0 = reduced.t0;
  const out = reduced.fights.map(f => {
    if (t0 == null) return { ...f, claim: null, verdict: 'no_clock' };
    const abs = t0 + f.startT;
    const hit = claims.find(c => !c.matched && c.bot === f.bot && c.mobId === f.mobId && Math.abs(c.at - abs) <= JOIN_WINDOW_MS);
    if (hit) { hit.matched = true; return { ...f, claim: hit, noticedAfterMs: hit.at - abs, verdict: 'both' }; }
    return { ...f, claim: null, verdict: 'witness_only' };
  });
  const unmatched = claims.filter(c => !c.matched);
  return { fights: out, claimOnly: unmatched };
}

// witnessEngagementsSince(sinceEpochMs, { bot }) -> machine-facing. The observer's answer to "what fights
// happened after this instant", shaped like combat_lens.completedBattlesSince so a tool can compare the
// two sources' answers to the same question.
function witnessEngagementsSince(sinceEpochMs, { bot = null } = {}) {
  const read = readWitness();
  if (!read.available) return [];
  const red = reduceWitness(read.rows);
  if (red.t0 == null) return [];
  return red.fights
    .filter(f => (!bot || f.bot === bot) && red.t0 + f.startT >= sinceEpochMs)
    .map(f => ({
      bot: f.bot, mobId: f.mobId, mobName: f.mobName,
      at: red.t0 + f.startT,
      durationMs: f.endT != null ? f.endT - f.startT : null,
      reason: f.reason, truncated: f.truncated,
      blowsOnBot: f.blowsOnBot.length, blowsByBot: f.blowsByBot.length,
      closestDist: f.closestDist,
      deafMs: f.deafMs,
    }))
    .sort((a, b) => a.at - b.at);
}

// runWitness — the human render. Renders, returns nothing, exits nothing.
function runWitness({ bot = null, verbose = false, claims = true } = {}) {
  const read = readWitness();
  if (!read.available) {
    console.log(`\n⛔ ${read.reason}`);
    console.log('   Turn it on: set mode.witness = true in Auren_Workshop/camera/camera_configure.js, then');
    console.log('   start the camera process. It records nothing while the fleet is idle.\n');
    return;
  }
  const red = reduceWitness(read.rows);
  const joined = claims ? joinClaims(red, { bot }) : { fights: red.fights.map(f => ({ ...f, claim: null, verdict: null })), claimOnly: [] };
  const fights = joined.fights.filter(f => !bot || f.bot === bot);

  console.log('\n══ COMBAT WITNESS — the server\'s own account ═════════════════════════════════════════');
  if (red.header) {
    console.log(`   run started  ${red.header.startedAt}   ·   bots: ${(red.header.bots || []).join(', ') || '(none named)'}`);
    console.log(`   sampling     ${red.header.sampleMs}ms while a fight is open, r=${red.header.radius}b   ·   nose: ${red.header.nose ? `${red.header.nose.radius}b every ${red.header.nose.pollMs}ms` : 'DISARMED (no rcon)'}`);
  }
  if (!red.trailer) console.log('   ⚠️  no trailer — this record is still being written, or the camera did not shut down cleanly.');

  // Coverage before findings, always. Every count below it is worth exactly what the coverage says.
  console.log(`\n   coverage     ${red.samples} samples · ${red.observed} server events · ${fights.length} engagements`);
  console.log(`                ${red.dropped == null ? '?' : red.dropped} ticks the eyes saw nothing` +
              `   ·   ${red.blindSpans} deaf spans, ${fmtSec(red.blindMs)} upper bound (${pct(red.blindMs, red.durationMs)} of the run)`);
  if (red.nose.readings) {
    console.log(`   nose         ${red.nose.readings} readings at bots out of sight · ${red.nose.hits} said "something near"` +
                `${red.nose.errors ? ` · ${red.nose.errors} could not reach rcon` : ''}`);
    console.log('                (coarse by construction — it cannot name a species. It points the eyes; it decides nothing.)');
  }
  if (red.capped) console.log('   ⚠️  RECORD TRUNCATED — the run hit its record cap. Everything after that point is missing.');
  if (read.torn) console.log(`   ⚠️  ${read.torn} unparseable line(s) — the file was being written while it was read.`);

  if (!fights.length) {
    console.log('\n   No engagement was observed.');
    if (joined.claimOnly.length) {
      console.log(`   ⚠️  …but the bots' own journals claim ${joined.claimOnly.length} engagement(s) in the same period.`);
      console.log('      Either the observer could not see them (check coverage above) or the claims are wrong.');
    }
    console.log('');
    return;
  }

  for (const f of fights) {
    const dur = f.endT != null ? f.endT - f.startT : null;
    const flag = f.verdict === 'witness_only' ? '  ⚑ THE BOT\'S JOURNAL HAS NO ENGAGE FOR THIS' : '';
    console.log(`\n▸ ${f.bot} vs ${f.mobName || '?'}#${f.mobId}   opened ${fmtClock(f.startT)}   ·   ` +
                `${dur != null ? fmtSec(dur) : 'still open at end of record'}   ·   ended: ${f.reason || (f.truncated ? 'truncated' : 'n/a')}${flag}`);
    console.log(`     distance   opened ${f.openDist != null ? f.openDist.toFixed(1) : '?'}b → closest ${f.closestDist != null ? f.closestDist.toFixed(1) : '?'}b → last seen ${f.endDist != null ? f.endDist.toFixed(1) : '?'}b`);
    console.log(`     the bot    hp ${f.hpFirst != null ? f.hpFirst.toFixed(1) : '?'} → ${f.hpLast != null ? f.hpLast.toFixed(1) : '?'}   ·   ` +
                `${f.swingsByBot} swings, ${f.blowsByBot.length} landed on the mob`);
    console.log(`     the mob    ${f.blowsOnBot.length} blows landed on the bot` +
                `${f.blowsOnBot.length ? `   (damage type ids: ${[...new Set(f.blowsOnBot.map(b => b.srcType).filter(v => v != null))].join(', ') || 'not sent'})` : ''}`);
    if (f.deaths.length) console.log(`     death      ${f.deaths.map(d => `${d.who} at ${fmtClock(d.t)}`).join(' · ')}`);
    console.log(`     samples    ${f.samples}   ·   ${f.metaFrames} raw metadata frames captured` +
                `${f.mobName === 'creeper' ? ' (the fuse is in here — undecoded, see the header)' : ''}`);
    if (f.deafMs > 0) {
      console.log(`     ⚠️ deaf     ${fmtSec(f.deafMs)} of ${dur != null ? fmtSec(dur) : 'this fight'} (${pct(f.deafMs, dur || 1)}) across ${f.deafSpans} span(s) — ` +
                  'the camera was in a ray loop. Counts above are floors, not totals.');
    }
    if (f.claim) {
      const lag = f.noticedAfterMs;
      console.log(`     the bot's own record: engaged this mob ${lag >= 0 ? `${lag}ms AFTER` : `${-lag}ms BEFORE`} the observer opened the pair.`);
    } else if (f.verdict === 'witness_only') {
      console.log('     the bot\'s own record: NOTHING. Either battle_stations never engaged, or its journal is off.');
    } else if (f.verdict === 'no_clock') {
      console.log('     the bot\'s own record: not joined — this witness record has no t0 in its header.');
    }
    if (verbose && f.blowsOnBot.length) {
      for (const b of f.blowsOnBot) console.log(`        hurt @ ${fmtClock(b.t)}  hp→${b.hp != null ? b.hp.toFixed(1) : '?'}  srcType=${b.srcType != null ? b.srcType : '—'}`);
    }
  }

  if (joined.claimOnly.length) {
    console.log(`\n── ${joined.claimOnly.length} engagement(s) the BOT claims and the observer never saw ──────────────`);
    console.log('   Not necessarily false: the observer has a range and the bot may have been outside it.');
    console.log('   Read them against the coverage line at the top before drawing anything from this.');
    for (const c of joined.claimOnly.slice(0, verbose ? 200 : 10)) {
      console.log(`   · ${c.bot} vs ${c.name || '?'}#${c.mobId} at ${new Date(c.at).toISOString().slice(11, 19)}`);
    }
    if (!verbose && joined.claimOnly.length > 10) console.log(`   … ${joined.claimOnly.length - 10} more (--all)`);
  }
  console.log('');
}

module.exports = {
  WITNESS_DIR, WITNESS_FILE, JOIN_WINDOW_MS,
  readWitness, reduceWitness, joinClaims, witnessEngagementsSince, runWitness,
};
