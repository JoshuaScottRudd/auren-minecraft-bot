// Auren_Workshop/tools/footage_clipper.js
// Turns a 45-minute unwatched recording into a folder of named candidate clips, so nobody scrubs a
// timeline looking for the moment the bot did something. The trace already knows what happened and
// when; the footage is stamped from the same wall clock; the only missing piece was the subtraction.
//
// WHY IT CAN WORK AT ALL — the two clocks are one clock. Every trace line is prefixed with an
// absolute ISO by watcher._record, and OBS names each per-camera file from the same OS clock
// (`Cam_AurenBot_2026-07-21_15-02-41.mp4`). Measured on the first real 45m take: filename start
// + ffprobe duration landed 1.1s from the file's own mtime. So video_seconds = log_utc -
// recording_start, and no clapperboard, no marker injection, and no change to the bot are needed.
//
// WHY THE FILENAME IS THE ANCHOR and not a start-time we log ourselves: OBS decides that name, so it
// is READ, not authored (Law 26 — anything the machine decides must be read). A start stamp we wrote
// beside it would be a second source for one fact (Law 16) and would drift the moment a take is
// re-encoded or a recording is started by hand from the OBS window.
//
// WHY IT REFUSES rather than guessing: a bad anchor produces clips that are confidently, silently
// wrong — every one off by the same minutes, all looking like plausible footage. That is the exact
// falsehood Law 25 forbids an outcome signal to carry, so the anchor is truth-checked against
// duration+mtime before a single frame is cut, and a failed check stops the run (Law 13).
//
// ── A TAKE IS A FOLDER ───────────────────────────────────────────────────────────────────────────
// `footage/<takeKey>/` holds everything one recording produced: every camera's mp4, every bot's trace,
// and the manifest tying them together. Loose files in `footage/` are what OBS just finished writing
// and nothing else — the moment a run ends they are wrapped, and after that a take is one thing you can
// point at, move, delete or open. The editing surface lists those folders and the operator picks one;
// with the files loose there was nothing to list but a pile of mp4s whose grouping had to be re-derived
// by timestamp clustering on every read.
//
// THREE VERBS, and the split is the point:
//   wrap  — folds a finished recording into its folder. Runs itself at teardown; decides nothing.
//   plan  — reads trace + footage, writes shot_list.{json,md}. Cuts nothing, needs no ffmpeg.
//   cut   — reads that shot list, runs ffmpeg. Decides nothing.
// `plan` is the collaboration surface: the markdown carries each arc's trace excerpt, so the AI
// developer can say which clips are worth the Architect's time WITHOUT either party opening a video.
// That is the burnout the tool exists to remove — not the cutting, the watching-to-find-out.
//
// Usage:
//   node footage_clipper.js wrap [--take=<prefix>]
//   node footage_clipper.js plan [--take=<prefix>] [--top=14] [--min=45] [--gap=180]
//   node footage_clipper.js cut  [--take=<prefix>] [--dry]
//
// `wrap` RUNS ITSELF at the end of every recorded run (record_overlay's teardown calls it once OBS has
// finalised the files), and the hand-run verb is the repair path for a run that closed some other way.
// It is the only time-critical step in the tool: every record a take depends on is overwritten by the
// next fleet run, so a take that is not wrapped before then is uncuttable forever. That is a lifecycle
// the run itself owns (Law 8) — leaving it as a verb an operator must remember made the record's
// survival depend on nobody forgetting, which is not a mechanism.
//
// Lives outside the fragment tree: a read-only observer of the record, joined to no signal bus.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readTrace, segmentRuns, buildEpisodes, jobToken } = require('../../monitoring/trace_read.js');

const paths = require('../workshop_paths');
const REPO = paths.REPO_ROOT;
const FOOTAGE_DIR = path.join(REPO, 'footage');
// WHERE THE WATCHER WRITES. Not `js_kernel/` — that is where this constant pointed until 2026-09-07,
// and the traces had moved to `fleet_logs/traces/` some time before. Nothing failed loudly: the copy
// step found no source file, filed every bot under "absent (not an error)" — the wording that exists
// for the Architect's own human-flown seat, which genuinely has no trace — and printed a take that read
// as complete. Two filmed takes were wrapped with `"records": []` before anyone noticed. Resolved from
// the watcher's own directory rather than re-typed, so a future move breaks the require instead of
// silently emptying the take again (Law 16 — one pathway).
const TRACES = paths.fleetLogs('traces');
// The canonical roster, from the same table the fleet, the rig and OBS all read. A hand-mirrored array
// here would go stale the first time a bot was added, and its staleness would take the form of a take
// quietly missing one crew member's record.
const { BOT_SENIORITY, FOREMAN_NAME } = require(paths.bot('Thinking_fragments/architect_config.js'));
const FFMPEG = path.join(REPO, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(REPO, 'tools', 'ffmpeg', 'bin', 'ffprobe.exe');
// Directories under footage/ that are outputs rather than takes. A take is identified by its manifest,
// so this list is belt-and-braces for readability rather than the actual test — a folder without a
// take.json is not a take however it is named.
const NOT_A_TAKE = new Set(['_trigger', 'edit', 'music', 'clips', 'records']);

// ── Tuning ───────────────────────────────────────────────────────────────────
// Anchor tolerance. The measured drift on a real 45m take was 1.1s; 90s is two orders of margin,
// wide enough to absorb a slow OBS finalise but far narrower than any real mis-anchoring, which
// misses by minutes (wrong take, wrong timezone, wrong run).
const ANCHOR_TOLERANCE_SEC = 90;
const PRE_ROLL_SEC = 8;    // the claim lands before the bot is in position; start early or the clip opens on a walk
const TAIL_SEC = 6;
const DEFAULT_MIN_ARC_SEC = 45;   // below this a job is a fetch, not a sequence — bad footage regardless of what it did
const DEFAULT_GAP_SEC = 180;      // same job re-claimed within this = one continuing arc, not two clips
const MIN_COVERAGE = 0.5;         // an arc must be mostly its own job, or the clip's name lies about it
const DEFAULT_TOP = 14;

const args = process.argv.slice(2);
const VERB = args.find(a => !a.startsWith('--')) || 'plan';
const opt = (n, d) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = n => args.includes(`--${n}`);
const TOP = +opt('top', DEFAULT_TOP);
const MIN_ARC_SEC = +opt('min', DEFAULT_MIN_ARC_SEC);
const GAP_SEC = +opt('gap', DEFAULT_GAP_SEC);

function die(msg) { console.error(`footage_clipper: ${msg}`); process.exit(1); }
const mmss = s => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
const hhmmss = s => [s / 3600, (s % 3600) / 60, s % 60].map(v => String(Math.floor(v)).padStart(2, '0')).join(':');

// ── The anchor ───────────────────────────────────────────────────────────────
// `Cam_AurenBot_2026-07-21_15-02-41.mp4` → { bot, takeKey, startMs }. Date components are fed to the
// local-time Date constructor because OBS names in local time while the trace stamps in UTC; letting
// the OS convert is the one place that difference is allowed to be resolved.
const TAKE_RE = /^Cam_(\w+)_((\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2}))\.mp4$/;

function parseTakeFile(name) {
  const m = name.match(TAKE_RE);
  if (!m) return null;
  const [, bot, takeKey, y, mo, d, hh, mi, ss] = m;
  return { bot, takeKey, file: name, startMs: new Date(+y, +mo - 1, +d, +hh, +mi, +ss).getTime() };
}

function probeDurationSec(file) {
  if (!fs.existsSync(FFPROBE)) die(`ffprobe not found at ${FFPROBE}`);
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const sec = parseFloat(out.trim());
  if (!Number.isFinite(sec)) die(`ffprobe returned no duration for ${path.basename(file)}`);
  return sec;
}

// The truth-check (Law 25). Nothing downstream re-verifies the anchor — every clip timestamp trusts
// it as settled fact — so it is proven here against a measure that comes from somewhere else
// entirely: the filesystem's own mtime, written when OBS finalised the file.
function verifyAnchor(dir, take) {
  const full = path.join(dir, take.file);
  take.durationSec = probeDurationSec(full);
  const endByName = take.startMs + take.durationSec * 1000;
  const endByFs = fs.statSync(full).mtimeMs;
  take.driftSec = (endByFs - endByName) / 1000;
  take.anchorOk = Math.abs(take.driftSec) <= ANCHOR_TOLERANCE_SEC;
  return take;
}

// ── Finding a take, before and after it is wrapped ────────────────────────────
// TWO FINDERS, and they are not a duplicate pathway: they answer different questions about different
// sets. `findLooseCameras` asks what OBS has just left in footage/ and is used by `wrap` alone;
// `listTakes` asks what takes exist and is used by everything downstream. Once a run is wrapped the
// first set is empty, which is the point.

// A "take" is one recording session across ALL cameras, but OBS starts each camera's Source Record
// filter a beat apart, so the per-camera filenames do NOT share a timestamp — measured 3s apart on the
// 2356 run (AurenBot 18:56:49, TessaBot 18:56:46). Grouping by an EXACT timestamp string therefore
// split one two-camera take into two, and the newest-wins pick silently dropped the other bot's footage
// entirely (Law 25: "10 clips planned" read as complete while TessaBot — the run's most productive bot —
// was omitted). So cameras are CLUSTERED by start time within a tolerance: any two within this window are
// the same take. Each file keeps its OWN startMs for its OWN anchor projection (they really did start 3s
// apart). The window is wide enough to absorb a slow second-camera bind, far narrower than the gap
// between two separate runs (tens of minutes).
const TAKE_CLUSTER_TOLERANCE_MS = 120000;

function findLooseCameras() {
  if (!fs.existsSync(FOOTAGE_DIR)) die(`no footage directory at ${FOOTAGE_DIR}`);
  const all = fs.readdirSync(FOOTAGE_DIR).map(parseTakeFile).filter(Boolean).sort((a, b) => a.startMs - b.startMs);
  if (!all.length) return null;
  const clusters = [];
  for (const t of all) {
    const c = clusters[clusters.length - 1];
    if (c && t.startMs - c.startMs <= TAKE_CLUSTER_TOLERANCE_MS) c.members.push(t);
    else clusters.push({ takeKey: t.takeKey, startMs: t.startMs, members: [t] });
  }
  const named = opt('take', null);
  const cluster = named
    ? clusters.find(c => c.members.some(m => m.takeKey === named))
    : clusters[clusters.length - 1];
  if (!cluster) die(`no loose camera files matching '${named}'`);
  return { takeKey: cluster.takeKey, takes: cluster.members.map(t => verifyAnchor(FOOTAGE_DIR, t)) };
}

// The one owner of "where takes live and what they are called" (Law 16). cutting_room imports this rather
// than scanning footage/ itself, so a change to the layout is a change in one file instead of a silent
// disagreement between the clipper and the editor about which folders count.
function listTakes() {
  if (!fs.existsSync(FOOTAGE_DIR)) return [];
  return fs.readdirSync(FOOTAGE_DIR)
    .filter(d => !NOT_A_TAKE.has(d))
    .filter(d => fs.existsSync(path.join(FOOTAGE_DIR, d, 'take.json')))
    .sort();
}

function loadTake(key) {
  const keys = listTakes();
  if (!keys.length) {
    die(`no wrapped takes in ${path.relative(REPO, FOOTAGE_DIR)} — a recording is wrapped into its own ` +
      `folder when the run tears down. For a run that closed some other way:\n` +
      `  node Auren_Workshop/tools/footage_clipper.js wrap`);
  }
  const want = key || opt('take', null);
  const takeKey = want ? keys.find(k => k === want || k.startsWith(want)) : keys[keys.length - 1];
  if (!takeKey) die(`no take matching '${want}' (have: ${keys.join(', ')})`);
  const dir = path.join(FOOTAGE_DIR, takeKey);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'take.json'), 'utf8'));
  // Law 13: a manifest with no cameras is a malformed record, not a take. Continuing would produce a
  // shot list of nothing that reads identically to a quiet run.
  if (!Array.isArray(manifest.cameras) || !manifest.cameras.length) {
    throw new Error(`footage_clipper: ${takeKey}/take.json carries no cameras — the manifest is malformed`);
  }
  // A camera whose file has since been deleted is NAMED and dropped, never silently skipped: absent
  // footage and a camera that was never in the take are indistinguishable downstream otherwise.
  const cameras = [], missing = [];
  for (const c of manifest.cameras) {
    if (fs.existsSync(path.join(dir, c.file))) cameras.push(c); else missing.push(c.file);
  }
  return { takeKey, dir, cameras, missing, manifest };
}

// ── Arcs ─────────────────────────────────────────────────────────────────────
// An arc is what the Architect asked to be shown: "building the wheat farm", not "the 6th of 11
// dispatches that each placed part of it". Consecutive episodes of the SAME job token merge across
// unrelated interleaved work, because a long build is genuinely re-claimed many times with supply
// runs threaded between — rendering those as separate clips would recreate the scrubbing problem in
// a folder instead of a timeline.
const DIG_RE = /\bdig=(\d+)/g;
const PLACE_RE = /\bplace=(\d+)/g;

function sumMatches(text, re) {
  let n = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) n += +m[1];
  return n;
}

function episodesForBot(dir, bot) {
  const file = path.join(dir, `watcher_${bot}.jsonl`);
  // A camera with no trace is not a fault: the Architect's eye is a human-flown seat with no bot
  // behind it, so it has footage and no record by design.
  if (!fs.existsSync(file)) return [];
  const segs = segmentRuns(readTrace(file));
  return buildEpisodes(segs[segs.length - 1] || [])
    .filter(ep => ep.bot === bot && ep.iso && ep.endIso);
}

function buildArcs(episodes) {
  const arcs = [];
  const openByToken = new Map();
  for (const ep of episodes) {
    const token = jobToken(ep.claimed);
    const startMs = Date.parse(ep.iso);
    const endMs = Date.parse(ep.endIso);
    const prev = openByToken.get(token);
    // Merging is gated on COVERAGE, not just the gap. A bot alternates jobs, so two claims of the
    // same token 3 minutes apart may have 3 minutes of a DIFFERENT job between them — merging those
    // produces a clip labelled `build/headframe` that is mostly a mining trip, which is a clip whose
    // name is a falsehood (Law 25). Observed on the first take: a 302s "headframe" arc containing one
    // placed block, overlapping a 488s iron-mining arc for the same bot at the same wall time.
    if (prev && startMs - prev.endMs <= GAP_SEC * 1000) {
      const span = Math.max(prev.endMs, endMs) - prev.startMs;
      const active = prev.activeMs + (endMs - startMs);
      if (active / span >= MIN_COVERAGE) {
        prev.endMs = Math.max(prev.endMs, endMs);
        prev.activeMs = active;
        prev.episodes.push(ep);
        continue;
      }
    }
    const arc = { bot: ep.bot, token, startMs, endMs, activeMs: endMs - startMs, episodes: [ep] };
    openByToken.set(token, arc);
    arcs.push(arc);
  }
  for (const arc of arcs) {
    const text = arc.episodes.flatMap(e => e.events.map(v => v.text)).join('\n');
    arc.durationSec = (arc.endMs - arc.startMs) / 1000;
    arc.digs = sumMatches(text, DIG_RE);
    arc.places = sumMatches(text, PLACE_RE);
    arc.drama = arc.episodes.flatMap(e => e.events).filter(e => e.kind === 'warn' || e.kind === 'err' || e.kind === 'fail').length;
    arc.steps = arc.episodes.flatMap(e => e.events).filter(e => e.kind === 'ok').length;
    // Screen time is the primary term because "large goal" IS duration — a long arc is the thing he
    // named (a farm, a headframe, a shaft). World-transformation is a multiplier rather than a
    // separate rank so a 4-minute arc that only walked never outranks a 2-minute arc that built.
    arc.score = arc.durationSec * (1 + Math.min(arc.digs + arc.places, 400) / 200);
  }
  // A clip of a bot standing still is worthless however long it ran, so an arc must have moved a
  // voxel or completed an executor step to be a candidate at all.
  return arcs.filter(a => a.durationSec >= MIN_ARC_SEC && (a.digs + a.places > 0 || a.steps > 0));
}

// ── Wrap ─────────────────────────────────────────────────────────────────────
// Every record a take depends on is overwritten by the next fleet run. That is correct for a
// debugging record and fatal for a filmed one: the footage outlives the record that says what is IN
// it, and a 25-minute take whose trace is gone cannot be planned by anything, ever. So the run's own
// teardown folds the two together, and the verb exists for the run that closed some other way.
//
// THE CAPTURES ARE MOVED, THE RECORDS ARE COPIED, and the asymmetry is deliberate. A capture has
// exactly one home and this is it — a rename inside one volume, so a 3 GB file costs nothing to
// relocate. A record's live copy belongs to the fleet's debugging loop, which has nothing to do with
// filming and must not change behaviour because a camera happened to be running; so it keeps being
// overwritten on its own schedule and the take gets its own copy. A recorded run therefore leaves two
// copies of each trace and that is the design, not duplication: one is working state with a lifetime of
// one run, the other is evidence with the lifetime of its footage.
//
// WHAT IS COPIED IS THE WATCHER TRACE AND NOTHING ELSE (Architect: *"i only want it to look at the
// watcher trace. the battlestations and cpu/gpu ones are all noise even the overseer"*). The combat
// journal was carried for one revision and is now redundant rather than merely unwanted: battle_stations
// posts its own engagements to the trace (`⚔️ Engaging <mob>` … `Engagement cleared`), so a fight's
// extent is already in the file the take must keep — and a second record of the same fact is the
// duplicate pathway Law 16 forbids, priced here in a record nobody reads. The machine-load sample, the
// witness and the overseer stream answer questions about a RUN, not about a take; they stay live where
// the diagnostics that want them already look.
//
// WHY A MANIFEST and not just the files: the anchor — filename, start time, duration — is what turns
// a log timestamp into a video timestamp, and it is otherwise re-derived by ffprobing the footage on
// every read. Writing it once at the moment the files are freshest makes it a fact the editing
// surface reads rather than a measurement each consumer repeats (Law 16).
const PER_BOT_RECORDS = [
  { dir: TRACES, name: b => `watcher_${b}.jsonl`, what: 'trace' },
];

// WHOSE TRACES A TAKE KEEPS: every bot on the roster, plus the foreman, plus whoever held a camera.
//
// It used to be only the bots that held a camera — `[...new Set(takes.map(t => t.bot))]` — and that was
// right exactly once, back when filming meant one camera per bot and the two sets were the same set.
// The let's play seat broke that identity: the Architect plays, ONE camera records HIS window, and the
// contractors work off-screen with no camera of their own. Under the old rule such a take asked for
// exactly one trace — `Architect_Control`, a human seat that by design has none — and kept nothing,
// while the crew's real records were overwritten by the next run's raise.
//
// The camera set is unioned in rather than replaced, because a bot may hold a camera without being on
// the roster (a bench run, a renamed seat), and a take must never keep less than it used to.
//
// THE FOREMAN IS IN, though it is staff rather than a bot (see foreman.js — it is deliberately absent
// from BOT_SENIORITY). In a let's play the Architect types `foreman get` in chat and a hire happens;
// that trace is the only record of what he asked for and who took it, and a take of a hiring run
// without it cannot be read. Being staff is a fact about the roster, not about what the footage needs.
//
// Everything else in fleet_logs/traces/ stays out and stays a whitelist (Law 29): the overseer stream,
// the rig, the OBS watcher and the playground answer questions about a RUN, not about a take, and they
// are still live where the diagnostics that want them already look.
function botsWithRecords(takes) {
  return [...new Set([
    ...Object.keys(BOT_SENIORITY),
    FOREMAN_NAME,
    ...takes.map(t => t.bot),
  ])].filter(Boolean).sort();
}

function wrapTake() {
  const loose = findLooseCameras();
  if (!loose) {
    die(`no loose Cam_<Bot>_<date>_<time>.mp4 files in ${path.relative(REPO, FOOTAGE_DIR)} — ` +
      `nothing to wrap. ${listTakes().length} take(s) are already wrapped.`);
  }
  const { takeKey, takes } = loose;
  const bad = takes.filter(t => !t.anchorOk);
  if (bad.length) {
    for (const t of bad) console.error(`  ${t.file}: filename start + duration is ${t.driftSec.toFixed(1)}s from the file's mtime`);
    die(`anchor check FAILED for ${bad.length}/${takes.length} camera file(s) — wrapping an unverified anchor ` +
        `would immortalise a wrong one, which is worse than having none. Refusing.`);
  }

  const outDir = path.join(FOOTAGE_DIR, takeKey);
  // A wrapped take is immutable by construction. Re-running after the fleet has been raised again
  // would otherwise silently overwrite a real take's records with a different run's — the exact loss
  // the verb exists to prevent, committed by the tool meant to prevent it. It is also what makes the
  // automatic call safe to repeat: a teardown that runs twice reports "already wrapped" instead of
  // replacing yesterday's evidence with today's.
  if (fs.existsSync(outDir)) die(`already wrapped: ${path.relative(REPO, outDir)} — a take is never rewritten. ` +
    `Delete that directory by hand if you genuinely mean to replace it.`);
  fs.mkdirSync(outDir, { recursive: true });

  const copied = [];
  const missing = [];
  const stale = [];
  // A record's LAST write is what dates it, so anything last written before this take started
  // belongs to an earlier run. Copying it anyway is the dangerous case rather than the harmless one:
  // it lands in this take's directory under this take's name, and every later reader — human or
  // lens — would take it as this take's evidence. A record that is simply absent announces itself;
  // a stale one impersonates a real one (Law 25). So it is refused and named, never quietly filed.
  const takeStartMs = Math.min(...takes.map(t => t.startMs));
  const bots = botsWithRecords(takes);
  // A ROSTER SEAT THAT NEVER JOINED IS NOT AN ABSENCE, and saying so would drown the absences that
  // matter. The roster is twenty bots and a run hires two, so listing the eighteen who were never
  // asked to exist turns the `absent` line into a wall nobody reads — and the one entry in it that
  // means something ("this bot held a camera and left no trace") would be the hardest to find. So
  // absence is reported only for a bot the FOOTAGE names: that one was filmed, so its silence is a
  // fact about this take rather than about the roster.
  //
  // Staleness is reported for every candidate either way. A stale file is a positive claim — a record
  // exists and belongs to some other run — and one impersonating this take's evidence is worth a line
  // whoever it names (Law 25).
  const filmed = new Set(takes.map(t => t.bot));
  for (const bot of bots) {
    for (const rec of PER_BOT_RECORDS) {
      const src = path.join(rec.dir, rec.name(bot));
      if (!fs.existsSync(src)) {
        if (filmed.has(bot)) missing.push(`${bot} ${rec.what}`);
        continue;
      }
      const st = fs.statSync(src);
      if (st.mtimeMs < takeStartMs) {
        stale.push(`${bot} ${rec.what} (last written ${new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}, before this take)`);
        continue;
      }
      fs.copyFileSync(src, path.join(outDir, rec.name(bot)));
      copied.push({ name: rec.name(bot), bytes: st.size });
    }
  }

  // The captures last, so a failure above leaves the footage where the operator expects to find it
  // rather than half-moved into a folder that was abandoned mid-write.
  const moved = [];
  for (const t of takes) {
    fs.renameSync(path.join(FOOTAGE_DIR, t.file), path.join(outDir, t.file));
    moved.push(t.file);
  }

  const manifest = {
    takeKey,
    wrappedAt: new Date().toISOString(),
    cameras: takes.map(t => ({
      file: t.file, bot: t.bot,
      startIso: new Date(t.startMs).toISOString(),
      startMs: t.startMs,
      durationSec: +t.durationSec.toFixed(3),
      anchorDriftSec: +t.driftSec.toFixed(2),
    })),
    records: copied.map(c => c.name),
    absent: missing,
    staleAndExcluded: stale,
  };
  fs.writeFileSync(path.join(outDir, 'take.json'), JSON.stringify(manifest, null, 2));

  console.log(`footage_clipper · wrap · take ${takeKey}`);
  for (const t of takes) console.log(`  camera ${t.bot}: ${mmss(t.durationSec)}, anchor drift ${t.driftSec.toFixed(1)}s`);
  console.log(`  moved ${moved.length} capture(s) into the take folder`);
  for (const c of copied) console.log(`  kept ${c.name} (${(c.bytes / 1024).toFixed(0)} KB)`);
  // Law 25: what was NOT captured is stated. "Wrapped" must not read as "everything was there".
  //
  // ZERO RECORDS IS SHOUTED, and the whole of the 2026-09-07 loss is in why. "absent (not an error)"
  // is true of one bot that never joined and catastrophic of all of them at once, and the line read
  // identically in both cases — so a wrap that kept nothing printed the same calm sentence as a wrap
  // that kept everything. The distinction the reader needs is not which files are missing but whether
  // ANY survived, so that is the thing said first and said loudly.
  if (!copied.length) {
    console.log(`  ⚠ NO RECORDS WERE KEPT — this take is footage with nothing to index it, and every`);
    console.log(`    trace it would have kept dies at the next fleet raise. Expected them in`);
    console.log(`    ${path.relative(REPO, TRACES)}; if that directory is empty, the run wrote none.`);
  }
  if (missing.length) console.log(`  absent (not an error): ${missing.join(', ')}`);
  for (const s of stale) console.log(`  EXCLUDED as stale: ${s}`);
  console.log(`  → ${path.relative(REPO, outDir)}`);
  console.log(`  this take survives the next fleet run, and the editor can open it by name.`);
}

// ── Plan ─────────────────────────────────────────────────────────────────────
function planTake() {
  const take = loadTake();
  if (take.missing.length) console.log(`  footage missing for: ${take.missing.join(', ')} — not planned`);

  const clips = [];
  const coverage = [];
  for (const cam of take.cameras) {
    const arcs = buildArcs(episodesForBot(take.dir, cam.bot));
    const videoEndMs = cam.startMs + cam.durationSec * 1000;
    // An arc that began before the camera rolled or ended after it stopped is CLAMPED, never
    // dropped: the tail of a build that started pre-roll is still the footage of that build.
    const inFrame = arcs
      .filter(a => a.endMs > cam.startMs && a.startMs < videoEndMs)
      .map(a => {
        const inSec = Math.max(0, (a.startMs - cam.startMs) / 1000 - PRE_ROLL_SEC);
        const outSec = Math.min(cam.durationSec, (a.endMs - cam.startMs) / 1000 + TAIL_SEC);
        return { ...a, inSec, outSec, clipSec: outSec - inSec, clamped: a.startMs < cam.startMs || a.endMs > videoEndMs };
      })
      .filter(a => a.clipSec >= MIN_ARC_SEC);
    coverage.push({ bot: cam.bot, file: cam.file, durationSec: cam.durationSec, arcs: inFrame.length,
      driftSec: cam.anchorDriftSec });
    clips.push(...inFrame.map(a => ({ ...a, sourceFile: cam.file })));
  }

  clips.sort((a, b) => b.score - a.score);
  const kept = clips.slice(0, TOP);
  kept.sort((a, b) => a.inSec - b.inSec || a.bot.localeCompare(b.bot));
  kept.forEach((c, i) => {
    c.n = i + 1;
    // Job tokens carry arrows and spaces (`supply/wheat_seeds DELIVER → headframe`); a clip name has
    // to survive a filesystem, a drag into an editor, and a shell, so it keeps only safe characters.
    const slug = c.token.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
    c.name = `${String(i + 1).padStart(2, '0')}_${c.bot}_${slug}_${mmss(c.inSec)}.mp4`;
  });

  // Clips live INSIDE the take they came from, so a take folder is the whole of one recording — its
  // captures, its records, and everything cut from them. A sibling clips/ directory made a take two
  // places on disk that had to be deleted or moved together and never were.
  const outDir = path.join(take.dir, 'clips');
  fs.mkdirSync(outDir, { recursive: true });
  const shotList = { takeKey: take.takeKey, generatedFrom: 'watcher traces + OBS filename anchor', coverage, dropped: clips.length - kept.length, clips: kept };
  fs.writeFileSync(path.join(outDir, 'shot_list.json'), JSON.stringify(shotList, null, 2));
  fs.writeFileSync(path.join(outDir, 'shot_list.md'), renderShotList(shotList));

  console.log(`footage_clipper · plan · take ${take.takeKey}`);
  for (const c of coverage) console.log(`  ${c.bot}: ${mmss(c.durationSec)} of footage · anchor drift ${c.driftSec.toFixed(1)}s · ${c.arcs} candidate arc(s)`);
  // Law 25: the dropped count is stated, never silently truncated — "14 clips" must not read as
  // "everything worth keeping" when it was the top 14 of 30.
  console.log(`  ${kept.length} clip(s) planned, ${clips.length - kept.length} candidate(s) below the cut (raise --top to widen)`);
  console.log(`  → ${path.relative(REPO, path.join(outDir, 'shot_list.md'))}`);
  console.log(`  next: node ${path.relative(REPO, __filename)} cut`);
}

function renderShotList(s) {
  const L = [];
  L.push(`# Shot list — take ${s.takeKey}`);
  L.push('');
  L.push('> Generated from the watcher traces and the OBS filename anchor. Every timecode below is an');
  L.push('> offset into that camera\'s own file. Nobody watched anything to produce this.');
  L.push('');
  for (const c of s.coverage) L.push(`- **${c.bot}** — \`${c.file}\`, ${mmss(c.durationSec)}, anchor drift ${c.driftSec.toFixed(1)}s, ${c.arcs} candidate arc(s)`);
  if (s.dropped) L.push(`- ${s.dropped} candidate arc(s) scored below the cut and are NOT in this list.`);
  L.push('');
  for (const c of s.clips) {
    L.push(`## ${String(c.n).padStart(2, '0')} · ${c.bot} · ${c.token}`);
    L.push(`**${hhmmss(c.inSec)} → ${hhmmss(c.outSec)}** (${mmss(c.clipSec)}) in \`${c.sourceFile}\``);
    L.push(`${c.digs} dug · ${c.places} placed · ${c.steps} executor step(s) · ${c.drama} problem line(s)`
      + `${c.clamped ? ' · **clamped to the recording window**' : ''}`);
    L.push('');
    for (const ep of c.episodes) {
      L.push(`- \`${ep.claimed}\` → ${ep.verdict.text}${ep.managerPlan ? ` — ${ep.managerPlan}` : ''}`);
      for (const e of ep.events.slice(0, 4)) L.push(`  - ${e.kind}: ${e.text.split('\n')[0].slice(0, 200)}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ── Cut ──────────────────────────────────────────────────────────────────────
// Stream copy, not re-encode: these are triage candidates, so a keyframe-aligned start (a second or
// two early at worst, which PRE_ROLL_SEC already covers) beats spending an hour of CPU on footage
// that has not yet been chosen. Re-encoding belongs in the editor, on the clips that survive.
function cutTake() {
  const take = loadTake();
  const outDir = path.join(take.dir, 'clips');
  const listFile = path.join(outDir, 'shot_list.json');
  if (!fs.existsSync(listFile)) die(`no shot list at ${path.relative(REPO, listFile)} — run 'plan' first`);
  if (!fs.existsSync(FFMPEG)) die(`ffmpeg not found at ${FFMPEG}`);
  const shotList = JSON.parse(fs.readFileSync(listFile, 'utf8'));

  console.log(`footage_clipper · cut · take ${take.takeKey} · ${shotList.clips.length} clip(s)`);
  let written = 0;
  for (const c of shotList.clips) {
    const src = path.join(take.dir, c.sourceFile);
    const dst = path.join(outDir, c.name);
    const line = `  ${c.name}  ${hhmmss(c.inSec)} +${mmss(c.clipSec)}`;
    if (flag('dry')) { console.log(`${line}  (dry)`); continue; }
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(c.inSec), '-i', src, '-t', String(c.clipSec),
      '-c', 'copy', '-avoid_negative_ts', 'make_zero', dst], { stdio: 'inherit' });
    // Trust nothing that only "returned without throwing" (Law 25) — a stream copy that produced no
    // playable output still exits 0. The file is measured before the clip is claimed.
    const sec = fs.existsSync(dst) ? probeDurationSec(dst) : 0;
    const ok = sec > 1;
    if (ok) written++;
    console.log(`${line}  → ${ok ? `${mmss(sec)} written` : 'FAILED (no playable output)'}`);
  }
  if (!flag('dry')) console.log(`  ${written}/${shotList.clips.length} clip(s) written to ${path.relative(REPO, outDir)}`);
}

// The CLI runs only when this file IS the program. cutting_room imports listTakes/loadTake, and without
// this guard that import would execute a verb — the module would plan a shot list as a side effect of
// being asked where the takes are.
if (require.main === module) {
  if (VERB === 'wrap') wrapTake();
  else if (VERB === 'plan') planTake();
  else if (VERB === 'cut') cutTake();
  else die(`unknown verb '${VERB}' — expected 'wrap', 'plan' or 'cut'`);
}

module.exports = { FOOTAGE_DIR, listTakes, loadTake };
