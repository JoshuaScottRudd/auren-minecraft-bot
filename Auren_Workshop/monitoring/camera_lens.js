// Auren_Workshop/monitoring/camera_lens.js
// THE CAMERA'S RUN, READ BACK — what it scanned, where it decided to stand, and why it moved.
//
// ── THE RULING THAT BUILT THIS (Architect 2026-08-22) ────────────────────────────────────────────────
//   "i want a watcher log for everything the scout camera does on par with the bot watcher system. i want
//    to know what it scanned, how it decided where to put the cameras and when, and why it moved them.
//    everything the scout camera does needs to go on a parallel watcher trace besides the fleet one for
//    the bots."
//
// Three questions, and they are not the fleet's three. A bot trace is read to find what went WRONG in a
// run; a camera trace is read to find why the FOOTAGE looks the way it does — why a shot sat in leaves for
// forty seconds, why the lens jumped four times in ten, why a mining leg was filmed through rock. The
// existing lenses cannot answer any of that, and stretching one of them to try would give it two verbs.
//
// ── WHY THE CAMERA GETS ITS OWN VIEW AND NOT A FILTER ON THE FLEET'S ────────────────────────────────
// The director re-solves a vantage about once a second for as long as a shot holds, which puts more lines
// into an hour than four bots do. Merged, the fleet's own story is buried in camera work and every
// downstream fleet lens — signatures, wake policy, the digest — measures a run it did not mean to. So
// `trace_read.readCameraView` merges the camera streams and NOTHING else, and this lens reads that view.
// Same pairing rule as every other record here: one record, one reader.
//
// ── THE RECORD IT READS AND THE ONE WAY IT MAY READ IT ──────────────────────────────────────────────
// `fleet_logs/traces/watcher_camera_*.jsonl`, decoded through `custom_api/crew_log.parseAll` — the SAME module
// the rig emits through. It carries no regexes of its own for those lines: a second copy of the grammar
// drifts the first time a field is added (Law 26 — one interface, both ends importing it; Law 16).
//
// The camera trace carries no run boundary to segment on. The overseer's `start` broadcast is what splits
// a bot trace into runs, and no camera process hears it — but every start flushes `watcher_*.jsonl`
// wholesale, so a camera file already holds exactly one session. Inventing a boundary here would be this
// lens deciding something the record already answers.
//
// Usage:  node Auren_Bot/monitoring/trace_monitor.js --camera [--bot=AurenBot] [--all]

'use strict';

const path = require('path');

// THE ALIAS MAP IS ASKED OF THE WORKSHOP'S ONE ANSWER (Law 16). It reads the bot's own package.json
// and is idempotent, so it is safe whether or not a caller registered first — which is what the block
// that stood here was hand-rolling with `addAliases` and a comment explaining why
// `require('module-alias')(base)` could not be used. The reason that form is unsafe has not changed and
// is now recorded once, in workshop_paths.js, instead of in five lenses.
const paths = require('../workshop_paths');
paths.registerAliases();
const crewLog = require('@api/crew_log');
const { readCameraView } = require('../../monitoring/trace_read');
const { stat, oneDecimal, percent, padRight, padLeft, ABSENT } = require('../../monitoring/report_formatting');

// The records room, asked of the one module that answers it — never spelled here (Law 16).
const KERNEL_DIR = require(paths.bot('js_kernel/utils/record_homes')).TRACE_DIR;

// The rig tags one stream per bot as `cam_<botname>` and speaks for its two clients under `scout` and
// `gimbal`. Splitting on the prefix rather than on a list is what lets a fifth bot appear in the roster
// without this file being edited — the discovery rule is the whole reason it can shift with the codebase.
const isRigTag = (tag) => tag.startsWith('cam_');
const botOfTag = (tag) => tag.slice('cam_'.length);

// ── READING ──────────────────────────────────────────────────────────────────────────────────────
// cameraEvents(lines) → [{ at, tag, verb, fields }]. `at` is the line's absolute ISO in milliseconds;
// a line the watcher wrote without one is skipped rather than defaulted, because every ordering below
// is on that clock and a zero would sort a real decision to the head of the run (Law 13).
function cameraEvents(lines) {
  const out = [];
  for (const l of lines) {
    if (!l.iso) continue;
    const at = Date.parse(l.iso);
    if (Number.isNaN(at)) continue;
    for (const ev of crewLog.parseAll(l.raw)) out.push({ at, tag: ev.tag, verb: ev.verb, fields: ev.fields });
  }
  return out;
}

function readCameraTrace(dir) {
  return readCameraView(dir || KERNEL_DIR);
}

const num = (fields, key) => {
  const v = fields[key];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Count occurrences of one field's value, most common first. Every distribution below is this: a run's
// cuts by cause, its sitings by verdict, its holds by reason.
function tally(events, key) {
  const counts = new Map();
  for (const e of events) {
    const v = e.fields[key];
    if (v === undefined) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

const renderTally = (pairs, total) =>
  pairs.map(([k, n]) => `${k} ${n}${total ? ` (${percent(n, total)})` : ''}`).join(', ') || ABSENT;

// ── THE FOLD ─────────────────────────────────────────────────────────────────────────────────────
// reduceCamera(lines, { bot }) → the structured run, for a machine caller. Rendering lives below and
// takes this as its argument: a machine-facing lens RETURNS and a human-facing one renders, never the
// same function doing both (monitoring/README's first rule).
function reduceCamera(lines, opts = {}) {
  const events = cameraEvents(lines);
  const rigs = new Map();

  for (const e of events) {
    if (!isRigTag(e.tag)) continue;
    const bot = botOfTag(e.tag);
    if (opts.bot && bot.toLowerCase() !== String(opts.bot).toLowerCase()) continue;
    if (!rigs.has(bot)) {
      rigs.set(bot, { bot, scans: [], sites: [], cuts: [], holds: [], sights: [], los: [], session: null, events: 0 });
    }
    const r = rigs.get(bot);
    r.events++;
    if (e.verb === 'scan') r.scans.push(e);
    else if (e.verb === 'site') r.sites.push(e);
    else if (e.verb === 'cut') r.cuts.push(e);
    else if (e.verb === 'hold') r.holds.push(e);
    else if (e.verb === 'sight') r.sights.push(e);
    else if (e.verb === 'los') r.los.push(e);
    else if (e.verb === 'session') r.session = e;
  }

  const eyes = {
    links: events.filter(e => e.tag === 'scout' && e.verb === 'link'),
    parks: events.filter(e => e.tag === 'scout' && e.verb === 'park'),
    blind: events.filter(e => e.tag === 'scout' && e.verb === 'blind'),
    gimbal: events.filter(e => e.tag === 'gimbal' && e.verb === 'link'),
  };

  const span = events.length ? { from: events[0].at, to: events[events.length - 1].at } : null;
  return { rigs: [...rigs.values()], eyes, span, events: events.length, lines: lines.length };
}

// A cut's HELD field is the life of the shot it replaced, so the shot lengths of a run are the held
// values of its cuts — with the last shot missing, because nothing replaced it. Stated rather than
// silently dropped: a run of four long shots and a run of four long shots plus a two-minute final hold
// are different footage (Law 25 — a subset presented as the whole is a false verdict with a clean exit).
function shotLengths(cuts) {
  return stat(cuts.map(c => num(c.fields, 'held')).filter(v => v != null && v > 0));
}

function runCamera(opts = {}) {
  const { bot = null, verbose = false, dir = null } = opts;
  const lines = readCameraTrace(dir);
  const reduced = reduceCamera(lines, { bot });

  console.log(`\n══ CAMERA — ${path.basename(KERNEL_DIR)}/watcher_camera_*.jsonl${bot ? ` · ${bot}` : ''} ══`);
  if (!lines.length) {
    console.log('  no camera trace in js_kernel/ — either nothing filmed this run, or the rig never started.');
    console.log('  The rig writes watcher_camera_rig.jsonl from its first line; its absence is a launch failure,');
    console.log('  not an empty run. Check the camera window that scripts/start_cameras.ps1 opened.');
    return 0;
  }
  if (!reduced.events) {
    console.log(`  ${lines.length} camera line(s), but none of them are crew events — the rig is narrating in`);
    console.log('  prose only. That is what a trace written before 2026-08-22 looks like; a current rig posts a');
    console.log('  scan and a site for every seek. Read it with --narration --bot=camera_rig instead.');
    return 0;
  }

  // ── THE EYES ───────────────────────────────────────────────────────────────────────────────────
  // First, because every siting decision below is downstream of them: a scan through chunks that never
  // streamed produces a blind shot, and a blind shot is not a worse frame — it is no decision at all.
  const E = reduced.eyes;
  const parkFail = E.parks.filter(p => p.fields.loaded === 'no').length;
  console.log(`\n── the eyes ──`);
  console.log(`  scout: ${E.links.length ? E.links.map(l => `${l.fields.state}${l.fields.why ? `(${l.fields.why})` : ''}`).join(' → ') : 'no link event — it came up before the first line, or never'}`);
  if (E.parks.length) {
    const waited = stat(E.parks.map(p => num(p.fields, 'ms')));
    console.log(`  parks: ${E.parks.length}, ${parkFail} with chunks that never streamed` +
      `${parkFail ? ' → those seeks were BLIND, and every siting figure below excludes what they could not see' : ''}` +
      `${waited ? ` · settle ${Math.round(waited.med)}ms median, ${Math.round(waited.max)}ms worst` : ''}`);
  }
  for (const b of E.blind) {
    console.log(`  deaf: ${b.fields.spans} raycast span(s), ${((num(b.fields, 'ms') || 0) / 1000).toFixed(1)}s total —` +
      ' the client cannot hear the server while it casts, so this is the window the witness could have missed.');
  }
  for (const g of E.gimbal) console.log(`  gimbal: ${g.fields.state}${g.fields.why ? ` (${g.fields.why})` : ''} — frozen-aim tripod shots.`);

  // ── PER CAMERA ─────────────────────────────────────────────────────────────────────────────────
  for (const r of reduced.rigs) {
    console.log(`\n── ${r.bot} — ${r.cuts.length} cut(s) from ${r.sites.length} siting decision(s) ──`);

    // WHY IT MOVED. The first question, because it is the one a person watching the footage arrives with.
    console.log(`  moved:  ${renderTally(tally(r.cuts, 'why'), r.cuts.length)}`);
    const held = shotLengths(r.cuts);
    if (held) {
      console.log(`  shots:  ${held.med}s median, ${held.min}–${held.max}s` +
        `${r.session ? ' (the final shot is not counted — nothing replaced it)' : ''}`);
    }
    const kinds = tally(r.cuts, 'kind');
    if (kinds.length) console.log(`  framed: ${renderTally(kinds, r.cuts.length)}`);
    const absorbed = stat(r.cuts.map(c => num(c.fields, 'absorbed')));
    if (absorbed && absorbed.max > 0) {
      console.log(`  absorbed: ${Math.round(absorbed.mean * 10) / 10} announcement(s) per shot landed inside the standing frame` +
        ' — events that needed no cut because the camera was already looking at them.');
    }

    // WHY IT DIDN'T. The half a cut-only record cannot show, and the reason this file exists.
    if (r.holds.length) console.log(`  held:   ${renderTally(tally(r.holds, 'why'), r.holds.length)} (posted on a CHANGE of reason, not per seek)`);

    // HOW IT DECIDED WHERE. `clear` = a direction passed the air box and the lens box; `forced` = none did
    // and the seeker took the furthest-reaching one anyway; the rest are not placements at all.
    // SUBJECT VISIBILITY LEADS, ABOVE THE VERDICT, and the ordering is the correction it exists to make: a
    // verdict says what the SEARCH found, and a reader arrives asking whether you could see the bot. Those
    // came apart badly once — a frame-purity score was read as shot quality and the report inverted — so
    // the fact that answers the reader's question is printed first and the verdict beneath it.
    const seen = r.sites.filter(s => s.fields.subject === 'yes').length;
    const unseen = r.sites.filter(s => s.fields.subject === 'no').length;
    if (seen + unseen) {
      console.log(`  SUBJECT: visible in ${seen} of ${seen + unseen} siting(s) (${percent(seen, seen + unseen)})` +
        `${unseen ? ` · bot itself behind a block in ${unseen}` : ' · the bot was never hidden'}`);
    }
    const sited = tally(r.sites, 'verdict');
    const forced = r.sites.filter(s => s.fields.verdict === 'forced').length;
    console.log(`  sited:  ${renderTally(sited, r.sites.length)}` +
      `  ← where the search LANDED, not how the shot looks`);
    const airbox = r.sites.reduce((s, e) => s + (num(e.fields, 'airbox') || 0), 0);
    const lensbox = r.sites.reduce((s, e) => s + (num(e.fields, 'lensbox') || 0), 0);
    // THE BOXES ARE THE ONLY QUALITY BAR THE SEEKER HAS LEFT, so their rejection count is the one figure
    // that says whether it is set right for this terrain. A run where `forced` dominates while the boxes
    // reject in the thousands is a bar the world cannot meet — which is a tuning fault, not a report that
    // the shots were bad. Read the two together or neither means anything.
    if (airbox + lensbox > 0) {
      console.log(`  boxes:  ${airbox} air-box and ${lensbox} lens-box rejection(s) before a direction was taken` +
        `${forced ? ` — and ${forced} siting(s) took one anyway (nothing cleared)` : ''}`);
    }
    const relaxed = r.sites.filter(s => s.fields.relaxed === 'yes').length;
    if (relaxed) {
      console.log(`  30°:    RELAXED on ${relaxed} of ${r.sites.length} sitings (${percent(relaxed, r.sites.length)})` +
        ' — no bearing differed enough, so consecutive shots may look near-identical.');
    }
    const rung = tally(r.sites.filter(s => s.fields.el !== undefined), 'el');
    if (rung.length) console.log(`  rung:   ${renderTally(rung, null)} (elevation of the chosen vantage, degrees)`);
    const dist = stat(r.sites.map(s => num(s.fields, 'd')));
    const room = stat(r.sites.map(s => num(s.fields, 'room')));
    if (dist) console.log(`  range:  stood ${oneDecimal(dist.med)}b from the subject (${oneDecimal(dist.min)}–${oneDecimal(dist.max)}), in ${room ? `${oneDecimal(room.med)}b` : ABSENT} of open room`);
    const blockers = tally(r.sites.filter(s => s.fields.by), 'by');
    if (blockers.length) console.log(`  cost:   what stood between the lens and the bot — ${renderTally(blockers, null)}`);
    const depths = stat(r.sites.map(s => num(s.fields, 'depth')));
    if (depths) {
      console.log(`  depth:  ${r.sites.filter(s => s.fields.depth != null).length} see-through siting(s) at y${Math.round(depths.med)} median` +
        ` (${Math.round(depths.min)}–${Math.round(depths.max)}) — enclosed is decided by depth alone, so this is the whole test.`);
    }

    // WHAT IT SCANNED. Last, because it is the cost rather than the decision — but it is the number that
    // says whether the seeker is actually running or quietly returning blind shots.
    const scanMs = stat(r.scans.map(s => num(s.fields, 'ms')));
    const open = stat(r.scans.map(s => num(s.fields, 'open')));
    const roomy = stat(r.scans.map(s => num(s.fields, 'roomy')));
    const rays = r.scans.reduce((s, e) => s + (num(e.fields, 'rays') || 0), 0);
    console.log(`  scanned: ${r.scans.length} field cast(s), ${rays} ray(s) total` +
      `${scanMs ? `, ${Math.round(scanMs.med)}ms median (${Math.round(scanMs.max)}ms worst)` : ''}`);
    if (open) {
      console.log(`  reach:  ${open.med} ray(s) came back open of the field, ${roomy ? roomy.med : ABSENT} of them roomy enough to stand a camera in` +
        `${roomy && roomy.med === 0 ? ' — a run of zero here is first-person country, not a seeker fault' : ''}`);
    }

    // The sightline flips are the raw cause behind every `sightline_lost` cut above.
    const blocked = r.sights.filter(s => s.fields.state === 'blocked');
    if (blocked.length) {
      console.log(`  sight:  CAMERA→bot went blocked ${blocked.length} time(s): ${renderTally(tally(blocked, 'by'), blocked.length)}`);
    }
    // The scout's own line, kept separate from the camera's. A break here does not spoil footage — it
    // spoils the MEASUREMENT, so every figure above was taken through whatever this names.
    if (r.los.length) {
      const losBlocked = r.los.filter(l => l.fields.state === 'blocked');
      const losUnknown = r.los.filter(l => l.fields.state === 'unknown');
      console.log(`  los:    SCOUT→bot changed state ${r.los.length} time(s)` +
        `${losBlocked.length ? ` · blocked ${losBlocked.length}× (${renderTally(tally(losBlocked, 'by'), losBlocked.length)})` : ''}` +
        `${losUnknown.length ? ` · could not tell ${losUnknown.length}×` : ''}` +
        `${!losBlocked.length && !losUnknown.length ? ' — never lost the subject; the figures above were measured on a clear line' : ''}`);
    }

    if (verbose) {
      console.log('');
      for (const c of r.cuts) {
        console.log(`    cut #${padLeft(c.fields.no, 3)} ${padRight(c.fields.kind, 7)} ${padRight(c.fields.why, 16)}` +
          ` ${padRight(c.fields.from, 14)} → ${padRight(c.fields.cam, 14)} held ${padLeft(c.fields.held, 3)}s` +
          `${c.fields.job ? ` · ${c.fields.job}` : ''}`);
      }
    }
    if (!verbose && r.cuts.length) console.log('    (--all for every cut, in order)');
  }
  return reduced.rigs.length;
}

module.exports = { runCamera, reduceCamera, cameraEvents, readCameraTrace };
