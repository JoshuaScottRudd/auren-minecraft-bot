// Auren_Bot/monitoring/combat_lens.js
// Reads combat facts back out of the bot's own watcher trace (Law 16 — one record, one reader).
//
// Three questions, answered off the trace, none of them rendered here:
//   fightSpansFromTrace   WHEN a fight ran (wall-clock extent) — the cutting room draws a lane from it
//   watchState            is the body on watch RIGHT NOW — lanista refuses to summon into a busy body
//   completedBattlesSince did a wave finish since this instant — lanista's third wave completion
//
// Only the BEATS live on the trace — a fight opening, a mob retiring with a verdict, a wave closing, a
// blow landing on the body, a detonation, a death, the watch arming — each a state change (Law 5: one
// aggregated line per phase, never one line per tick). Per-swing resolution and a per-pass decline census
// are per-tick facts and are not on the trace; this file cannot report them.
//
// Every function here RETURNS and never renders, never exits (Law 26). A caller that needs a fact out of
// a run calls one of these; none of them open a trace file directly. `crew_log.parseAll` is the one
// parser for the bot's grammar, imported here exactly as the seats import its emitter.

'use strict';

const fs = require('fs');
const path = require('path');
// Registers @-aliased require paths before any @-aliased import below — a monitor process has none set
// by default, and a module resolved by plain relative require then fails on its own aliased imports.
// Idempotent, so this is safe whether or not a caller (lanista, its bench) already registered them.
const paths = require('./lens_paths');
paths.registerAliases();
const crewLog = require('@api/crew_log');
const { readTrace, segmentRuns } = require('./trace_read');

const KERNEL_DIR = require(paths.bot('js_kernel/utils/record_homes')).TRACE_DIR;

// The verdicts `retireTarget` writes, named once here so the two functions below compare against the
// same literal (Law 16).
const KILL_VERDICT = 'cleared';
const DETONATED_VERDICT = 'detonated';

// ── READING ONE BOT'S TRACE ─────────────────────────────────────────────────────────────────────────
// The per-bot story file, not the merged fleet view: every question here is about ONE body.
//
// Returns only the LAST run's segment. The story file outlives runs (the foreman's `start` broadcast is
// what segments them), so a caller asking whether a wave finished since some instant cannot match one
// from an earlier run. `segmentRuns` is the fleet's own segmentation (Law 16).
function readBotTrace(botId) {
  const file = path.join(KERNEL_DIR, `watcher_${botId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const segments = segmentRuns(readTrace(file));
  return segments.length ? segments[segments.length - 1] : [];
}

// crewEvents(lines, tag) -> [{ at, verb, subject, fields, bot }] in trace order.
//
// `at` is the line's own absolute ISO stamp turned to epoch ms. A line with no stamp is skipped rather
// than given the previous line's time (Law 25): every consumer here compares against a wall-clock
// instant the caller supplied.
function crewEvents(lines, tag) {
  const out = [];
  for (const l of lines) {
    if (!l.iso) continue;
    const at = Date.parse(l.iso);
    if (Number.isNaN(at)) continue;
    for (const ev of crewLog.parseAll(l.raw)) {
      if (tag && ev.tag !== tag) continue;
      out.push({ at, verb: ev.verb, subject: ev.subject, fields: ev.fields, bot: l.bot });
    }
  }
  return out;
}

// ── watchState — is the body actually on watch right now ────────────────────────────────────────────
// Machine-facing: returns, renders nothing, exits never.
//
// THREE FLAGS. `armed` is the operator mode — the watch exists, not that the body is free. `engaged` is
// an `engage` with no matching `end` — a wave summoned on top of one would be a two-mob fight wearing a
// one-mob label. `standing` is the stricter fact: a watch re-armed since combat last opened. `engaged`
// drops at the last `end`, but battle_stations then runs the spoils errand, so `standing` covers the
// whole span from first target to judge handoff — await_aggro posts `sentry state=standing` atop each
// fresh watch loop and any `engage` retires it.
//
// Refuses on a transition the bot itself published (Law 25), never on elapsed time.
function watchStateFromEvents(events) {
  let armed = false, armedAt = null, standing = false, standingAt = null;
  const open = new Map();
  for (const ev of events) {
    if (ev.verb === 'sentry') {
      const st = ev.fields.state;
      if (st === 'armed') { armed = true; armedAt = ev.at; }
      else if (st === 'disarmed') { armed = false; standing = false; armedAt = ev.at; }
      // `standing` implies armed — the watch loop only runs inside an armed session.
      else if (st === 'standing') { armed = true; standing = true; standingAt = ev.at; }
    }
    // Combat opening is what retires `standing` — see above.
    else if (ev.verb === 'engage' && ev.subject) { open.set(ev.subject.id, ev.subject.name); standing = false; }
    else if (ev.verb === 'end' && ev.subject) open.delete(ev.subject.id);
    // A death closes every open fight, so an `engage` whose `end` never arrived does not read as
    // permanently engaged.
    else if (ev.verb === 'death') { open.clear(); standing = false; }
  }
  return { armed, armedAt, standing, standingAt, engaged: open.size > 0, openMobs: [...open.keys()] };
}

// null = no trace for that bot at all — distinct from a disarmed watch: no process started, not simply
// armed=false (Law 25).
//
// Merges two tags by time. The watch arms in `await_aggro` and combat opens in `battle_stations`, so the
// state machine above needs the true interleaving of both emitters' lines, not one tag's lines entirely
// before the other's.
function watchState(botId) {
  const lines = readBotTrace(botId);
  if (!lines) return null;
  const events = [...crewEvents(lines, 'battle_stations'), ...crewEvents(lines, 'await_aggro')]
    .sort((a, b) => a.at - b.at);
  return { bot: botId, ...watchStateFromEvents(events) };
}

// ── completedBattlesSince — the wave completion only the bot can report ─────────────────────────────
// Covers the case the server cannot see: a mob that walks out of the bot's tracking range is alive and
// still tagged, so the arena never empties and the wave burns its whole ceiling. Only the bot knows it
// disengaged.
//
// The bot's lines are CLAIMS about what it decided; the server is the contradicting voice (Law 26). The
// claim may end the WAITING — the bot is the only witness to a disengage — and may not decide the
// OUTCOME.
//
// `killed` vs `untouched` needs a second fact: a mob that burned, fell, or was killed by a peer must not
// be credited to this bot. The gunner states it once per mob (`connect`) and the `end` line carries the
// count.
function battlesFromEvents(events, sinceEpochMs) {
  const battles = [];
  let closed = [];
  for (const ev of events) {
    if (ev.verb === 'end') { closed.push(ev); continue; }
    if (ev.verb !== 'wave') continue;
    const ends = closed;
    closed = [];
    // Reset BEFORE the cutoff test, so an old wave's own `end` lines are consumed here and never attach
    // to the next wave reported.
    if (ev.at < sinceEpochMs) continue;
    const named = (e) => ({ id: e.subject ? e.subject.id : null, name: e.subject ? e.subject.name : null });
    const outcomeOf = (e) => e.fields.outcome;
    const touched = (e) => (crewLog.num(e.fields, 'hit') || 0) > 0;
    const blew = ends.filter(e => outcomeOf(e) === DETONATED_VERDICT);
    const cleared = ends.filter(e => outcomeOf(e) === KILL_VERDICT);
    battles.push({
      bot: ev.bot,
      at: ev.at,
      outcome: ev.fields.outcome,
      source: ev.fields.source || null,
      killed: cleared.filter(touched).map(named),
      untouched: cleared.filter(e => !touched(e)).map(named),
      detonated: blew.map(named),
      // Walked away, or taken off the board by something else — not a kill and not a detonation.
      disengaged: ends.filter(e => outcomeOf(e) !== KILL_VERDICT && outcomeOf(e) !== DETONATED_VERDICT).map(named),
      passes: crewLog.num(ev.fields, 'passes') || 0,
    });
  }
  return battles;
}

function completedBattlesSince(sinceEpochMs, { bot = null } = {}) {
  const battles = [];
  for (const id of (bot ? [bot] : traceBots())) {
    const lines = readBotTrace(id);
    if (!lines) continue;
    const events = crewEvents(lines, 'battle_stations').map(e => ({ ...e, bot: e.bot || id }));
    battles.push(...battlesFromEvents(events, sinceEpochMs));
  }
  return battles.sort((a, b) => a.at - b.at);
}

// Every bot with a story file, for the no-filter case. The camera and foreman streams are excluded by
// name: they are not bodies and carry no waves.
function traceBots() {
  let files;
  try { files = fs.readdirSync(KERNEL_DIR); } catch { return []; }
  return files
    .filter(f => /^watcher_.+\.jsonl$/.test(f))
    .map(f => f.replace(/^watcher_/, '').replace(/\.jsonl$/, ''))
    .filter(id => id !== 'fleet' && !id.startsWith('camera_'));
}

// ── fightSpansFromTrace — a fight's WALL-CLOCK EXTENT ───────────────────────────────────────────────
// Answers WHEN a fight starts and stops, so a camera can draw a lane and cut a clip with nothing missing
// off either end.
//
// Takes parsed lines as input, staying a pure reducer with no dependency on the trace reader; the caller
// already has the segment.
//
// THE GRAMMAR IS THE BOT'S OWN PROSE, matched on its two announcements:
//   open   `Engaging <mob> [hp?] — …`         (several may fire inside one fight — see below)
//   close  `Engagement cleared — killed: …`   (the seat handing back to the judge)
// A fight OPENS on the first Engaging with none open and CLOSES on the clear. The bot may re-target
// inside a live fight, so pairing each Engaging with its own close would invent a second block over
// footage where nothing new began.
//
// Reads the prose lines, not the `engage`/`wave` crew lines: this needs only two instants, and the prose
// lines are present on every archived take.
const FIGHT_OPEN_RE = /\[BATTLE_STATIONS\].*Engaging (\w+)/;
const FIGHT_CLOSE_RE = /\[BATTLE_STATIONS\].*Engagement cleared — killed: ([^;]+);/;

function fightSpansFromTrace(seg, botName = null) {
  const spans = [];
  let cur = null;
  for (const l of seg) {
    if (!l.iso) continue;
    const ms = Date.parse(l.iso);
    let m;
    if ((m = l.raw.match(FIGHT_OPEN_RE))) {
      if (!cur) cur = { bot: botName || l.bot, startMs: ms, endMs: ms, mobs: [], kills: 0 };
      cur.mobs.push(m[1]);
      cur.endMs = ms;
    } else if (cur && (m = l.raw.match(FIGHT_CLOSE_RE))) {
      cur.endMs = ms;
      // `killed: none` is the bot's own word for a fight it walked away from; anything else is a
      // comma-separated roster (Law 23 — this reads the record's verdict, it does not re-judge the fight).
      cur.kills = /^none\b/.test(m[1].trim()) ? 0 : m[1].split(',').length;
      spans.push(cur);
      cur = null;
    }
  }
  // A fight still open at the trace's end is reported, not dropped — the run was cut off mid-fight and
  // that footage exists. Its end is the last line that carried a stamp.
  if (cur) {
    const last = [...seg].reverse().find(l => l.iso);
    if (last) cur.endMs = Math.max(cur.endMs, Date.parse(last.iso));
    cur.openAtEnd = true;
    spans.push(cur);
  }
  return spans;
}

module.exports = {
  fightSpansFromTrace,
  watchState, watchStateFromEvents,
  completedBattlesSince, battlesFromEvents,
  crewEvents, readBotTrace, traceBots,
  KILL_VERDICT, DETONATED_VERDICT,
};
