// Auren_Bot/monitoring/combat_lens.js
// THE FLEET'S COMBAT RECORD IS THE BOT'S OWN WATCHER TRACE, AND THIS IS WHAT READS IT BACK.
//
// Three questions, all answered off the trace, none of them rendered here:
//   fightSpansFromTrace   WHEN a fight ran (wall-clock extent) — the cutting room draws a lane from it
//   watchState            is the body on watch RIGHT NOW — lanista refuses to summon into a busy body
//   completedBattlesSince did a wave finish since this instant — lanista's third wave completion
//
// ── WHAT THIS FILE USED TO BE, AND WHY IT IS NOT THAT ANY MORE (2026-08-22) ─────────────────────────
// It was 2,115 lines reducing `fleet_logs/combat_journal/battle_stations_<bot>.jsonl` — a per-decision
// sidecar record the seats wrote in parallel with the trace: every swing with both bodies' positions,
// every blow taken, every gate decline with its cylinder geometry, the knockback and fuse populations.
// The record was deleted, so the reducer went with it. There is no gap where it stood: a reader with no
// record is not a capability held in reserve, it is a pathway that reports nothing (Law 16), and the
// three functions above never read the journal in the first place.
//
// THE RULING THAT MOVED IT (Architect, in his own words): *"the data i want is always going to be bot
// centered so the bot holds the key to all the logs not the combat journal."* A second file written by
// the same party is a second place to look for one party's account of itself. What survived the move
// onto the trace are the BEATS — a fight opening, a mob retiring with a verdict, a wave closing, a blow
// landing on the body, a detonation, a death, the watch arming — because each is a STATE CHANGE and
// that is the cadence a trace can carry (Law 5: the summary is the primary channel, one aggregated line
// per phase, never one line per tick).
//
// WHAT DID NOT SURVIVE, NAMED RATHER THAN QUIETLY ABSENT (Law 25). Per-swing resolution — range at each
// release, decide-to-swing latency, the approach leg between taking a target and first landing on it —
// and the per-pass decline census that priced the aggro cylinder. Those are per-tick facts, and per-tick
// lines on the trace are exactly what Law 5 removed. They cannot come back by relaxing this file; they
// would need a record, which is the thing that was deleted.
//
// ── ONE RECORD, ONE READER, AND THE READER MAY BE A MACHINE ─────────────────────────────────────────
// Every function here RETURNS and never renders, never exits (CLAUDE.md's monitor-is-the-interface
// clause, Law 26). A tool that needs a fact out of a run calls one of these; it does not open a trace
// file itself, and it does not carry a regex for the bot's own grammar — `crew_log.parseAll` is that
// grammar's only parser, imported here exactly as the seats import its emitter.

'use strict';

const fs = require('fs');
const path = require('path');
// THE WRONG WAY IN, kept because this file has been bitten by it: a plain relative require of an
// @-aliased module resolves the file and then dies on ITS OWN imports — a monitor is the one context
// with no aliases set. So the map is registered first, through the workshop's one answer to it, which is
// idempotent and therefore safe whether or not a caller (lanista, its bench) got here first.
const paths = require('./lens_paths');
paths.registerAliases();
const crewLog = require('@api/crew_log');
const { readTrace, segmentRuns } = require('./trace_read');

const KERNEL_DIR = require(paths.bot('js_kernel/utils/record_homes')).TRACE_DIR;

// The verdicts `retireTarget` writes. Named here because two functions below compare against them and a
// second literal is the pair that drifts (Law 16).
const KILL_VERDICT = 'cleared';
const DETONATED_VERDICT = 'detonated';

// ── READING ONE BOT'S TRACE ─────────────────────────────────────────────────────────────────────────
// The per-bot story file, not the merged fleet view: every question here is about ONE body, and the
// merge would fold three bots' waves into one stream for a caller that named a bot.
//
// LAST RUN ONLY. The story file outlives runs (the overseer's `start` broadcast is what segments them),
// so a bench asking "has a wave finished since I summoned" must not be able to match one from an hour
// ago. `segmentRuns` is the fleet's own segmentation and is reused rather than re-derived.
function readBotTrace(botId) {
  const file = path.join(KERNEL_DIR, `watcher_${botId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const segments = segmentRuns(readTrace(file));
  return segments.length ? segments[segments.length - 1] : [];
}

// crewEvents(lines, tag) -> [{ at, verb, subject, fields, bot }] in trace order.
//
// `at` is the line's own absolute ISO stamp turned to epoch ms. Lines without one are SKIPPED rather
// than given the previous line's time: every consumer here compares against a wall-clock instant a
// caller supplied, and an invented stamp is a false comparison rather than a missing one (Law 25).
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
// (Architect 2026-08-08: "thats not a control. update lanista to only spawn a monster when the bot is
// in sentry mode.")
//
// THREE FLAGS, NOT ONE. `armed` = the operator mode: the watch EXISTS, not that the body is free
// (2026-08-08: armed the whole trial, still took wave 3's skeleton mid-43-block errand — shot four
// times, no fight opened). `engaged` = an `engage` with no matching `end` — a wave summoned on top of
// one is a two-mob fight wearing a one-mob label. `standing` = the strict fact that actually caught
// wave 3: `engaged` drops at the last `end`, but battle_stations then runs the SPOILS errand (where the
// skeleton found the body), so `standing` means a watch was RE-ARMED since combat last opened —
// await_aggro posts `sentry state=standing` atop each fresh watch loop, any `engage` retires it, so the
// whole span from first target to judge handoff (spoils included) reads NOT STANDING = "the body is
// inside something else".
//
// Not a settle timer: that would refuse on the bench's patience rather than the bot's state — the
// substituted criterion Law 25 forbids. This refuses on a transition the bot itself published.
function watchStateFromEvents(events) {
  let armed = false, armedAt = null, standing = false, standingAt = null;
  const open = new Map();
  for (const ev of events) {
    if (ev.verb === 'sentry') {
      const st = ev.fields.state;
      if (st === 'armed') { armed = true; armedAt = ev.at; }
      else if (st === 'disarmed') { armed = false; standing = false; armedAt = ev.at; }
      // `standing` implies armed: the watch loop only turns inside an armed session, and a bench reading
      // one without the other would refuse a body that is demonstrably on watch.
      else if (st === 'standing') { armed = true; standing = true; standingAt = ev.at; }
    }
    // Combat opening is what retires `standing` — see above.
    else if (ev.verb === 'engage' && ev.subject) { open.set(ev.subject.id, ev.subject.name); standing = false; }
    else if (ev.verb === 'end' && ev.subject) open.delete(ev.subject.id);
    // A death closes every open fight, else an `engage` whose `end` never arrived (the ordinary shape of
    // dying mid-fight) reads permanently engaged and refuses every later wave.
    else if (ev.verb === 'death') { open.clear(); standing = false; }
  }
  return { armed, armedAt, standing, standingAt, engaged: open.size > 0, openMobs: [...open.keys()] };
}

// null = no trace for that bot at all — a DIFFERENT answer from "not armed" (the process never started
// versus a disarmed watch); conflating them sends the operator to the wrong verb (Law 25).
//
// TWO TAGS MERGED BY TIME. The watch arms in `await_aggro` and combat opens in `battle_stations`, so the
// state machine above spans two emitters and the interleaving is what it reads — a concatenation in tag
// order would put every `sentry` line before every `engage` and report a standing watch through the
// middle of a fight.
function watchState(botId) {
  const lines = readBotTrace(botId);
  if (!lines) return null;
  const events = [...crewEvents(lines, 'battle_stations'), ...crewEvents(lines, 'await_aggro')]
    .sort((a, b) => a.at - b.at);
  return { bot: botId, ...watchStateFromEvents(events) };
}

// ── completedBattlesSince — the wave completion only the bot can report ─────────────────────────────
// lanista's third break, and the one covering the case the server structurally cannot see: a mob that
// walks out of the bot's tracking range is ALIVE and STILL TAGGED, so the arena never empties and the
// wave burns its whole ceiling. Only the bot knows it disengaged.
//
// THE DIVISION OF LABOUR IS EXACT AND MUST STAY THAT WAY (Law 26): the bot's lines are CLAIMS about what
// it decided; the server is the contradicting voice. So the claim may end the WAITING — the bot is the
// only witness to a disengage — and it may not decide the OUTCOME. A version that let `outcome` here
// become the wave's verdict would be the counter grading its own paper.
//
// `killed` vs `untouched` is the one split that needs a second fact: a mob that burned, fell, or was
// killed by a peer must not be credited to this bot. The gunner states it once per mob (`connect`) and
// the `end` line carries the count, so the split is a field read rather than a join across per-swing
// rows — which is what let those rows be deleted.
function battlesFromEvents(events, sinceEpochMs) {
  const battles = [];
  let closed = [];
  for (const ev of events) {
    if (ev.verb === 'end') { closed.push(ev); continue; }
    if (ev.verb !== 'wave') continue;
    const ends = closed;
    closed = [];
    // Reset BEFORE the cutoff test: an old wave still consumes its own `end` lines, else a previous
    // wave's targets attach to the next one reported.
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
      // Walked away, or taken off the board by something else — NOT a kill and NOT a detonation. A caller
      // that cannot tell these three apart is back to the ambiguity this break exists to remove.
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

// Every bot with a story file, for the no-filter case. The camera and overseer streams are excluded BY
// NAME: they are not bodies, they have no waves, and reducing them would cost a file read per call for a
// guaranteed empty result.
function traceBots() {
  let files;
  try { files = fs.readdirSync(KERNEL_DIR); } catch { return []; }
  return files
    .filter(f => /^watcher_.+\.jsonl$/.test(f))
    .map(f => f.replace(/^watcher_/, '').replace(/\.jsonl$/, ''))
    .filter(id => id !== 'overseer' && !id.startsWith('camera_'));
}

// ── fightSpansFromTrace — a fight's WALL-CLOCK EXTENT ───────────────────────────────────────────────
// A camera is asking WHEN a fight starts and stops, so a lane can be drawn and a clip cut with nothing
// missing off either end. That is the standing rule's own case — a question the monitor could not answer
// is a defect in the monitor, closed by adding a lens rather than by a consumer reaching into a record.
//
// It takes PARSED LINES rather than a filename so it stays a reducer and needs no dependency on the
// trace reader; the caller already has the segment.
//
// THE GRAMMAR IS THE BOT'S OWN PROSE, matched on its two announcements and nothing else:
//   open   `Engaging <mob> [hp?] — …`         (several may fire inside one fight — see below)
//   close  `Engagement cleared — killed: …`   (the seat handing back to the judge)
// A fight OPENS on the first Engaging with none open and CLOSES on the clear, rather than pairing each
// Engaging with a close. Measured on the first take: `Engaging creeper` … `Engaging spider` … one
// `Engagement cleared` — the bot re-targets inside a live fight, and pairing them would invent a second
// block over footage where nothing new began.
//
// PROSE AND NOT THE `engage`/`wave` CREW LINES, deliberately. Those are the machine grammar and they are
// right for the two functions above, which need fields. This one needs only two instants, and the prose
// lines have carried them since before the crew grammar existed — so every archived take on disk stays
// clippable, which a switch to the newer lines would silently end.
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
      // comma-separated roster. Counted rather than re-derived, because the emitter already decided it
      // (Law 23 — this reads the record's verdict, it does not re-judge the fight).
      cur.kills = /^none\b/.test(m[1].trim()) ? 0 : m[1].split(',').length;
      spans.push(cur);
      cur = null;
    }
  }
  // A fight still open at the trace's end is REPORTED, not dropped: the run was cut off mid-fight (the
  // recording stopped, the bot died, the fleet came down), and that footage exists and is the good kind.
  // It ends at the last line that carried a stamp — the honest bound rather than an invented one.
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
