// Auren_Bot/monitoring/trace_monitor.js
// Deterministic first-pass triage of a watcher trace — the detection half of the
// AI-monitor layering (raw trace → THIS SCRIPT → anomaly + context slice → LLM →
// clean problem → Architect). It exists so no reader ever greps a live trace by
// hand: same input, same flags, every time (Law 19 — detection must not inherit
// a reader's variance). Read-only observer of transparent state (Law 6); lives
// OUTSIDE the construct — not a fragment, touches no signal bus, decides nothing
// in the SPA loop.
//
// Signatures are conservative-by-design (flag liberally, tune down as trust
// builds — Architect's call, 2026-07-02). Thresholds were calibrated on real
// traces, not guessed: healthy max inter-line gap observed 47s (AurenBot
// mid-fell), the dead-bot gap 70s → SILENCE_GAP_SEC 60 splits them. A flagged
// anomaly is reported as the offending line + N lines above it, as finished
// text, so the next layer never parses JSON.
//
// Two channels, deliberately separate:
//   FLAGS   — the deterministic signatures below. In --watch --exit-on-flag they
//             are the ONLY thing that wakes the reader. Kept conservative.
//   CONTEXT — --activity (the decision spine: job-board posts, dispatcher picks,
//             manager outcomes as raw lines) and --story (those same lines grouped
//             into per-job episodes: plan → issues → verdict) are on-demand lenses;
//             --stream=<tag> is the LIVE form of the same channel — in --watch it
//             echoes each new tagged line (e.g. dispatcher picks) as it lands, so the
//             trace reads as running commentary. All three flag nothing, wake no one,
//             and invent no logging — the lines already exist in the trace (Law 5/14).
//
// Usage:
//   node trace_monitor.js [traceFile] [--context=80] [--quiet]
//   node trace_monitor.js --activity [--bot=AurenBot] [traceFile]
//   node trace_monitor.js --story [--bot=AurenBot] [--all] [traceFile]  (--all renders EVERY episode in
//                                                                      full, including the clean ones —
//                                                                      the only way to read the board a
//                                                                      bot was offered on a sweep that
//                                                                      went right, i.e. why it picked
//                                                                      the job it picked)
//   node trace_monitor.js --progress [--tail=10m] [traceFile]   (progressing-vs-looping ledger)
//   node trace_monitor.js --pathfinding [--bot=AurenBot] [traceFile]   (A* time/partial census per bot)
//   node trace_monitor.js --route-cost [--bot=AurenBot] [traceFile]    (what routes PRICED — the evidence
//                                                                      a cost tier is set from)
//   node trace_monitor.js --jumps [--bot=AurenBot] [traceFile]         (jump presses split by approach bearing)
//   node trace_monitor.js --jobs [--bot=AurenBot] [--all] [traceFile]  (every job claimed, in order:
//                                                                      start stamp, duration, verdict,
//                                                                      the gaps between jobs, then where
//                                                                      the run's time went by job type)
//   node trace_monitor.js --milestones [--bot=AurenBot] [--deadline=10m] [traceFile]
//                                                                      (when the base got established:
//                                                                       site lock → anchor gate → first
//                                                                       placement → anchor complete.
//                                                                       --deadline scores each anchor
//                                                                       MET/MISSED/PENDING against the
//                                                                       ASKER's number, from run start)
//   node trace_monitor.js --torch [--bot=AurenBot] [--deadline=10m] [traceFile]
//                                                                      (when the FIRST torch was crafted,
//                                                                       the order that asked for it, and
//                                                                       every gate that held it — with
//                                                                       the handoff when one gate opened
//                                                                       and another closed behind it)
//   node trace_monitor.js --compost [--bot=B] [--all]                  (the composter chain: claims,
//                                                                       COLLECT/FEED/WITHDRAW routes,
//                                                                       items fed vs BONE MEAL OUT)
//   node trace_monitor.js --inventory [--bot=B] [--all]                (where every item IS — last-known
//                                                                       contents of every chest and every
//                                                                       pocket, the fleet-wide total, and
//                                                                       a manifest of every container-to-
//                                                                       container move. Ground pickups are
//                                                                       absent by construction. Ends on
//                                                                       the four costs the chest layout
//                                                                       pays: contention, double handling,
//                                                                       fragmentation, small-transfer tax)
//   node trace_monitor.js --engagement [--bot=AurenBot] [--all]        (the fight as a STORY, one mob at
//                                                                       a time, joined out of the three
//                                                                       crew seats: who engaged from how
//                                                                       far, how long until the first
//                                                                       blow and at what range, every
//                                                                       strike, and the threats no guard
//                                                                       ever answered. --all adds every
//                                                                       strike and every change of tactic)
//   node trace_monitor.js --foreman [--bot=PlayerName] [--all]         (THE DESK's own run: every person
//                                                                       who spoke to the foreman, what they
//                                                                       were refused, what crossed the veil.
//                                                                       --bot names a PERSON here.)
//   node trace_monitor.js --camera [--bot=AurenBot] [--all]            (the CAMERA's own run, off its
//                                                                       parallel trace: what the scout
//                                                                       scanned, how each vantage was
//                                                                       chosen, why every cut fired and
//                                                                       why the ones that didn't, didn't.
//                                                                       --all adds every cut in order)
//   node trace_monitor.js --witness [--bot=AurenBot] [--all]           (the OUTSIDE observer's record of
//                                                                       the same fights, cross-read
//                                                                       against the bot's claims: fights
//                                                                       the bot never logged, blows it
//                                                                       never noticed, and how deaf the
//                                                                       camera was while it watched)
//   node trace_monitor.js --machine-load [--label=NAME]                (what the MACHINE was doing while a
//                                                                       run filmed: GPU/CPU/RAM percentiles
//                                                                       and how late a sample landed. Newest
//                                                                       record if no label is named)
//   node trace_monitor.js --watch [--interval=5] [--exit-on-flag[=error,halt]] [--max-minutes=15] [--stream=dispatcher]
//                                 [--errors-known=N]   re-arming after a handoff: the first N WAKING
//                                                      episodes (error/halt/death) already dealt with;
//                                                      the next one wakes.
//   node trace_monitor.js --around=<1m1s|ISO> [--lines=25 | --window=60 | --before=..|--after=..] [--tag=T] [--bot=B]
//   node trace_monitor.js --from=<4m> --to=<7m> [--bot=B] [--tag=T] [--grep=<regex>] [--level=error] [--run=latest|N|all]
//
// Default traceFile: fleet_logs/traces/watcher_overseer.jsonl (merged fleet stream).
// Per-bot files (watcher_<Id>.json) work too — bot id comes from the filename.
// Watch mode needs no flush verb: the overseer persists the combined story
// debounced at 250ms, so re-reading the file is always near-live.
// Exit codes: 0 clean · 2 flags found · 1 could not read trace.

'use strict';
require('../js_kernel/utils/developer_door').enter('monitoring/trace_monitor.js');

const fs = require('fs');
const path = require('path');

// ── What this file no longer owns, in two passes ─────────────────────────────────────────────────
//
// PASS ONE (Architect 2026-08-07). It was 3,185 lines carrying seventeen verbs. Four things came out,
// each because it had a consumer that had to load the whole triage CLI to reach it:
//   trace_read.js                 the substrate — parse, read, segment, episodes. FOUR tools imported
//                                 exactly this set from here (footage_clipper, motion_classifier,
//                                 dashboard, and run_report, since deleted).
//   combat_lens.js                the --combat lens, 842 lines that read a DIFFERENT file family and
//                                 touched none of the substrate above. That record and that fold are
//                                 both gone (2026-08-22); the file survives as the trace-fed reducer
//                                 lanista and the cutting room call.
//   report_formatting.js          the summary statistic + the renderers that put it on a line
//   command_line_arguments.js     the flag reader — re-typed in three tools, and only one copy of it
//                                 handled a value containing '='.
// The comments were NOT compacted, and that was measured rather than assumed: 0 duplicates, 0 TODOs,
// 0 status-rotted lines across 3,185. The size was the lens count, not the prose (Law 14 — "size is a
// review prompt, never a cut mandate; a long file of all-necessary WHY may stay long").
//
// PASS TWO (Architect 2026-08-08: "wana audit all files above 1k for me?"). Same finding, same measure
// — 0 TODOs and 0 status-rotted lines across the remaining 2,228, so again nothing was cut from the
// prose. What came out was the rest of the lens count: eight per-subsystem reducers that share nothing
// with the detection engine but `readTrace`, which now has its own home.
//   feature_metrics.js     DELETED 2026-08-31. It was the only instrument here that read a SERIES
//                          across runs and wrote its own record. The fleet changes between runs, so
//                          a series over them compares systems that were never the same one; what
//                          lasts is the write-up a person makes, not an accumulating file
//   chain_lenses.js        --compost. Reduces one chain across three or four owners and
//                          answers whether it closed.
//   build_lenses.js        --milestones, --torch. The establishment clocks — the build sites, and the
//                          fleet's first torch.
//   locomotion_lenses.js   --pathfinding, --route-cost, --jumps. All read the navigator's own lines;
//                          --route-cost reads the per-SEARCH path line (the only one carrying cost),
//                          the other two read the per-trip census.
//
// WHAT IS LEFT IS ONE VERB: find what went wrong in a run. The signatures, the per-bot digest, the
// wake policy, the watch, and the three read-only views over the SAME trace the signatures read
// (--activity, --story, --progress, and the --around/--from query slice). --progress stays because
// "is this run still advancing" is the triage engine's own question, not a subsystem's.
//
// THE SEAM every lens now takes (combat_lens set it): the lens receives the RUN'S LINES and its options
// as ARGUMENTS, renders, and RETURNS. It never reads process.argv and never calls process.exit. This
// file is the CLI — it owns the flags, reads the trace once, and hands the segment down.
const {
  DEFAULT_TRACE_FILE, botFromFilename, parseLine, readTrace, readCameraView, segmentRuns,
  afterMarker, relativeTime, buildEpisodes, renderEpisode, PASSIVE_LINE, OVERSEER_UNITS,
} = require('./trace_read');
const { makeArgs, parseDuration } = require('./command_line_arguments');
const chainLenses = require('./chain_lenses');
const buildLenses = require('./build_lenses');
const locomotionLenses = require('./locomotion_lenses');

// ── Thresholds (calibrated, see header) ──────────────────────────────────────
const SILENCE_GAP_SEC = 120;      // no line at all from an active bot
const WARN_BURST_COUNT = 5;      // ≥ this many warns...
const WARN_BURST_WINDOW_SEC = 60; //   ...within this window
const WARN_REPEAT_COUNT = 3;     // identical warn text repeated this often
const JUDGE_REPEAT_MIN = 3;      // judge's own Contiguous: N/5 escalation
// Integrity regression tolerance (voxels). A structure under active construction flickers ±1–2 as
// concurrent dig/place and two bots working one shared blueprint momentarily un-satisfy a voxel that
// the next place cycle restores (observed live: headframe 135→134→135 while a peer mined the shaft
// under it). A REAL regression — a bot mining its own wall, a collapse, griefing — drops far more and
// stays down against the running best. Only a drop EXCEEDING this tolerance wakes; smaller flicker is
// build noise, not intervention-worthy (Law 5 — the tracer surfaces real problems, not scan jitter).
const REGRESSION_TOLERANCE = 2;

// Which signatures WAKE a watcher (--exit-on-flag → stop + hand off). Policy tightened by the
// Architect (2026-07-10) to ERRORS ONLY: a ❌ error, or a `halt` (a bot parked inert for human
// inspection — the same episode also emits ❌ error lines, so this is error-class, not a warning).
// Every other signature still PRINTS for visibility (and feeds the live tracer) but never trips a
// handoff — notably `regression` (a bot legitimately mining its own shaft lowers the carve/build
// correct-count; that dip is expected work, not damage — the false wake that prompted this tune),
// `judge-repeat` (progress-shaped; when the judge actually kills the signal it raises a ❌ error,
// which wakes), and `silence` (a halted bot goes quiet BY DESIGN, so it double-fired with the halt).
// A whole-fleet wall-clock freeze still wakes via the independent FLEET FROZEN detector below — that
// arm is NOT gated by this set, so errors-only here never reopens the silent-dead-fleet gap.
// `death` joined the set on 2026-08-06 when combat_observer_monitor (which owned the death wake) was
// deleted. It is error-class by the same test the halt passes: a terminal event the fleet does not
// otherwise raise, that a human must see. See sigDeath for why health cannot answer it.
const WAKE_SIGS = new Set(['error', 'halt', 'death']);

// ── CLI ──────────────────────────────────────────────────────────────────────
// Flag parsing comes from command_line_arguments (one implementation — it was written three times across the
// monitoring tools and only this copy handled a value containing '='). This file is the CLI, so it is
// the one place allowed to read process.argv; the lenses it calls take arguments.
const { args, opt, has } = makeArgs();

// ── `--ascii`: THE SAME REPORT WITH NOTHING ABOVE ASCII IN IT (Architect 2026-09-10) ────────────────
// *"the symbols like the backpack and other signs dont work in a raw powershell. its all mojebake. so
// either remove them or make part of the dependancies something you need to install to read those
// items on the watcher trace."*
//
// NEITHER OF THOSE, because neither is the fault. The lens writes UTF-8 correctly and the console
// decodes it with the machine's ANSI codepage, so the bytes are right and the renderer is wrong. Every
// window the fleet OPENS is fixed at the source — `trace.ps1` and `console_window` set the codepage
// before a character is printed — and removing the symbols would have paid for a broken console with a
// thinner report for every reader who has a working one.
//
// THIS FLAG IS FOR A TERMINAL THE FLEET DOES NOT OWN: his own raw PowerShell, an SSH session, a pipe
// into a file that something else will read. It is offered rather than detected because there is no
// honest way to ask a Windows console what codepage it is in from inside node, and a wrong guess would
// either mangle a good terminal's output or silently keep mangling a bad one.
//
// ONE INTERCEPTION POINT, NOT A TABLE PER CALL SITE. There are 45 print sites in this file alone, and
// the symbols also arrive INSIDE the trace's own text from 25 bot source files — so substituting at
// each site would cover neither completely. Wrapping stdout catches this file, every lens it calls, and
// the bots' own words, in one place (Law 16).
const ASCII = has('ascii');
if (ASCII) {
  // Ordered: the two-codepoint sequences (an emoji plus VARIATION SELECTOR-16) must be replaced before
  // the bare emoji, or the selector is left behind as a stray character — which is mojibake by a
  // different route and would make the flag look broken.
  const FOLD = [
    ['⚠️', '[warn]'], ['❌', '[ERR]'], ['✅', '[ok]'], ['⛔', '[STOP]'], ['🚨', '[ALERT]'],
    ['📊', '[i]'], ['📍', '[at]'], ['🎒', '[bag]'], ['🌍', '[world]'], ['⛏', '[dig]'],
    ['🚧', '[gated]'], ['🧪', '[test]'], ['⚠', '[warn]'], ['✔', 'v'], ['✗', 'x'],
    ['▸', '>'], ['·', '.'], ['⋯', '...'], ['──', '--'], ['─', '-'], ['—', '-'], ['’', "'"],
  ];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return write(chunk, ...rest);
    let s = chunk;
    for (const [from, to] of FOLD) s = s.split(from).join(to);
    // Anything still outside ASCII is a character this table has not met. Replaced with '?' rather than
    // passed through, because the promise of this flag is that NOTHING above ASCII reaches the terminal
    // — a half-kept promise here is the original complaint with extra steps.
    return write(s.replace(/[^\x00-\x7F]/g, '?'), ...rest);
  };
}

const TRACE_FILE = args.find(a => !a.startsWith('--')) || DEFAULT_TRACE_FILE;
const CONTEXT = parseInt(opt('context', '80'), 10);
const QUIET = has('quiet');
// --follow implies --watch: following IS watching with the echo filter removed, and a `--follow` that
// silently fell through to the one-shot digest would print a snapshot and exit, which reads exactly like
// a fleet that has nothing to say.
const WATCH = has('watch') || has('follow');
// 2s under --follow rather than 5: a console a human is reading over the fleet's shoulder is a different
// instrument from a wake-on-error watch, and three seconds of lag is the difference between watching and
// reviewing. Still cheap - a re-read of the trace, no per-line cost.
const WATCH_INTERVAL_SEC = parseInt(opt('interval', has('follow') ? '2' : '5'), 10);
// --exit-on-flag [=sig,sig] — end the watch the moment a wake-worthy signature fires. Bare, the whole
// of WAKE_SIGS may end it. With a list, only the named signatures may — everything else still PRINTS
// and still sets `flagged`, it simply does not shorten the window.
//
// THE LIST EXISTS BECAUSE `death` IS IN WAKE_SIGS AND IS NOT ALWAYS AN ABORT. A corpse is worth waking
// a human for; it is not worth ending a soak over, because a soak measures whether the fleet RECOVERS
// and a run cut at the first death throws away the only evidence that could show it. A caller that
// wants to stop on a crash but ride out a death has no way to say so without this, and would otherwise
// have to re-implement the whole watch to get it (Law 16).
const EXIT_ON_LIST = opt('exit-on-flag', null);
const EXIT_ON_FLAG = has('exit-on-flag') || EXIT_ON_LIST !== null;
// A named signature that is not wake-worthy would be a criterion this file cannot honour — it never
// reaches the exit branch — so the intersection is taken rather than the caller's list trusted whole.
const EXIT_ON_SIGS = EXIT_ON_LIST
  ? new Set(EXIT_ON_LIST.split(',').map(x => x.trim()).filter(x => WAKE_SIGS.has(x)))
  : WAKE_SIGS;

// ENDING EARLY IS A DIFFERENT OUTCOME FROM RUNNING OUT WITH FLAGS, so it gets its own code. Since the
// window became the only terminator (2026-08-16) exit 2 has meant "the full window ran and something
// was seen" — reusing it for a watch that stopped at minute two would tell a caller the window ran
// when it did not, which is a well-formed falsehood about the one fact the caller is measuring
// (Law 25). 0 clean · 1 the trace could not be read · 2 the window ran, flags raised · 3 ended early.
const EXIT_EARLY_CODE = 3;
// 15 minutes is right for a wake-on-error watch, which is a bounded job with a question to answer. It is
// wrong for --follow, which is a CONSOLE: a window that quietly closes itself after a quarter of an hour
// looks exactly like a fleet that died. A console ends when the operator closes it (Law 8 - it dies with
// the window that raised it), so --follow defaults to a week and --max-minutes still overrides.
const MAX_MINUTES = parseFloat(opt('max-minutes', has('follow') ? '10080' : '15'));
// --errors-known=N — the twin of combat_observer_monitor's --deaths-known=N, and for the identical
// reason. Errors wake at ANY index (see the baseline block) so that a watch launched into an
// already-crashed fleet fires instead of baselining the damage away. The cost of that policy: once ANY
// error is in the trace, EVERY re-armed watch exits within one poll, forever. Measured 2026-08-05 — the
// first bot death of a soak permanently disabled this watch, and the run's remaining 18 minutes had no
// error channel at all. N says "the first N error episodes are already handed off"; anything after
// still wakes. Zero (the default) keeps the original behaviour exactly.
const ERRORS_KNOWN = parseInt(opt('errors-known', '0'), 10) || 0;
const ACTIVITY = has('activity');
const STORY = has('story');
const PROGRESS = has('progress');
const PATHFINDING = has('pathfinding');
const ROUTECOST = has('route-cost');
const JUMPS = has('jumps');
const MILESTONES = has('milestones');
// --torch — when the first torch was crafted, and what held it when it was not. A flag of its own
// rather than a row on --milestones because that lens keys everything by build site and a torch is
// stock, not a site. It shares --deadline with --milestones: one criterion flag, whichever clock is
// being asked (Law 16 — a second spelling of the asker's number is a second place for it to differ).
const TORCH = has('torch');
// --jobs — the run as a sequence of claimed jobs with what each one cost (Architect 2026-08-13: "i want
// to know everytime a bot picks a job, and how long it takes in order"). It is a lens rather than a
// signature for the same reason --story is: it flags nothing and wakes nobody. --story renders the same
// episodes as prose for reading ONE job; this renders them as a clock for comparing all of them.
const JOBS = has('jobs');
// ── --combat, --entities AND --knockback ARE GONE, AND SO IS THE RECORD THEY READ (2026-08-22) ─────
// All three folded `fleet_logs/combat_journal/` — a per-decision sidecar the seats wrote in parallel
// with the trace. The Architect deleted the record (*"the data i want is always going to be bot centered
// so the bot holds the key to all the logs not the combat journal"*), and a lens whose record does not
// exist is a door onto an empty room (Law 16). Do not rebuild them against the trace: the facts they
// folded were per-swing and per-pass, which is the cadence Law 5 keeps OFF a trace. --engagement is the
// live successor and always read the trace, never the journal.
// --witness — the OTHER combat record: what an outside observer SAW. It gets a flag here rather than a
// reader of its own beside the file, for the pairing rule's reason (one record, one door).
const WITNESS = has('witness');
// --machine-load — the record of the BOX rather than of the bots, written by tools/machine_load_sampler.js
// while a filmed run is up. A flag here for the pairing rule's reason and no other: it is a record, so it
// gets a door in the monitor rather than a reader beside the file. It answers a question none of the other
// lenses can be made to answer — every one of them reads what the fleet decided, and none of them can see
// the machine the fleet is decided ON, which is the constraint when camera windows scale with bot count.
const MACHINE_LOAD = has('machine-load');
// --narration --bot=<unit> — a unit's own words, in order. Every other lens here is a FOLD, and a fold
// discards whatever it does not measure; a unit whose output is prose rather than events (a director
// narrating its cuts, a preflight narrating what it verified) therefore had no door at all — the merged
// view could count its lines and nothing could show them. --full widens the window past the last `start`
// broadcast, which anything that comes up BEFORE the fleet is told to think needs (its whole bring-up
// lands in the previous segment).
const NARRATION = has('narration');
const NARRATION_FULL = has('full');
const COMPOST = has('compost');
// --inventory — where every item IS, and every move between containers. A flag rather than a reader beside
// the trace, for the pairing rule's reason: one record, one door, however many lenses.
const INVENTORY = has('inventory');
// --engagement — the fight told back as a story, joined out of the three crew seats' event streams.
// It reads the SAME trace as the default view (it is not a second record), so it takes `seg` like every
// other extracted lens; what makes it a lens rather than a --tag filter is the JOIN, which no seat in
// the running fleet is allowed to make (Invariant D).
const ENGAGEMENT = has('engagement');
// --camera — the CAMERA's run, off its own parallel trace. Unlike every lens above it, this one does NOT
// read the fleet view: `trace_read` keeps the camera streams out of it deliberately (a director re-solving
// a vantage once a second would bury four bots' story in camera work). So the flag hands the question
// straight to the lens, which opens the record it is paired with — the same shape as --witness.
const CAMERA = has('camera');

// --foreman — THE DESK's own record: who spoke to the fleet's one human-facing unit, what they were
// refused, and what crossed on their word. A third parallel stream on the same footing as --camera and
// --witness, and kept out of the fleet view by `trace_read` for the same reason: it answers a different
// question and its lines are conversations rather than fleet decisions, so merging them would have every
// fleet lens measuring a person's chat as the fleet's own reasoning.
//
// `--bot` NAMES A PERSON UNDER THIS FLAG, which is the one place the monitor's vocabulary bends. The flag
// means "narrow to one speaker" everywhere, and at the desk a speaker is a human — so the meaning is
// preserved and only the species of the speaker changes. A second flag spelled `--person` would be a
// second way to say the same thing (Law 16).
const FOREMAN = has('foreman');
// --deaths is GONE (2026-08-12), deleted with the death-pile chain it reduced. An unknown flag falls
// through to the default view rather than erroring, which is the right behaviour here: the reader typed a
// flag that used to work, and the default trace is a useful answer where a false "no deaths" was not.
// chain_lenses carries the full reasoning and where the question moved (`--combat`).
// --deadline=<Nm|Ns> — the anchor-0 criterion, passed down to build_lenses.runMilestones (which carries
// why the number is the asker's and not the lens's). Both duration flags parse the same `<Nm><Ns>` token
// through command_line_arguments.parseDuration, but they FAIL differently on purpose: a --deadline is the
// asker's criterion (Law 25 — nothing downstream may invent one, so a malformed value is fatal), while
// --tail has a stated default and falls back to it.
const MS_DEADLINE_SEC = (() => {
  const p = opt('deadline', null);
  if (!p) return null;
  const sec = parseDuration(p);
  if (sec === null) fail(`--deadline must look like 10m, 90s or 1m30s (got '${p}')`);
  return sec;
})();
// --progress tail window (seconds): net-new work must land inside this trailing slice of the run to
// count as "still rising". Beyond it, a structure whose peak hasn't advanced is STALLED — the loop
// fingerprint. Default 10m; override with --tail=<Nm|Ns>.
const PROGRESS_TAIL_SEC = parseDuration(opt('tail', '10m')) ?? 600;
const BOT_FILTER = opt('bot', null);
// --stream=<tag>[,<tag>…] : in --watch, echo every NEW line carrying one of these fragment tags as
// it lands — a live decision play-by-play, not just the once-a-minute heartbeat. The live tracer runs
// with --stream=dispatcher so trace.log shows which bot claimed which task over time (the system's
// status IS the sequence of task-picks — Architect, 2026-07-07). Tags are matched as the bracketed
// fragment tag ([DISPATCHER]); comma-separated, case-insensitive. Empty → no stream (the wake-on-error
// watch stays terse). This forwards lines that already exist in the story (Law 5/14) — invents none.
const STREAM_TAGS = (opt('stream', '') || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
// --follow : --stream with no tag list — echo EVERY new line as it lands. Added 2026-09-03 for the
// Architect's one-window fleet console: he asked for the fleet's twelve separate consoles collapsed into
// a single scrolling view, and what he wants to watch scroll is the merged overseer story. That is
// exactly --stream with the filter removed, so it is the same code path rather than a second one
// (Law 16) — `--follow` sets the predicate to "always true" and nothing else about watch mode changes.
// --bot= still narrows it, so `--follow --bot=AurenBot` is one bot's console without a window of its own.
const FOLLOW = has('follow');
const streamMatch = raw => FOLLOW
  ? (!BOT_FILTER || raw.includes(`[${BOT_FILTER}]`))
  : STREAM_TAGS.some(tag => raw.includes(`[${tag}]`));
const STREAMING = FOLLOW || STREAM_TAGS.length > 0;
// --- Query mode: any addressable-slice flag present routes to runQuery (below). It is a post-hoc
// lens over the persisted trace — the mode the AI monitor uses after a flag wakes it to pull the
// window around the incident (before AND after), so --watch (a live future has no "after") wins if
// both are somehow passed. See runQuery for the flag vocabulary.
const QUERY = args.some(a => /^--(around|from|to|tag|grep|level)=/.test(a));
// --last : print one greppable LASTPOST line per bot, read from each bot's OWN watcher file, and exit.
const LASTPOST = has('last');


// ── Signatures ───────────────────────────────────────────────────────────────
// Each returns flags: { sig, bot, idx, reason }. idx anchors the context slice.
// All of them dedupe into one flag per EPISODE, not one per line — the reader
// gets each distinct problem once.

// (a) Any ❌ error. The watcher error dump is multi-line; consecutive error
// lines from one bot collapse into a single flag anchored at the first.
function sigErrors(lines) {
  const flags = [];
  let open = null;   // { bot, lastIdx }
  for (const l of lines) {
    if (l.level !== 'error') continue;
    if (open && open.bot === l.bot && l.idx - open.lastIdx <= 2) {
      open.lastIdx = l.idx;
      continue;
    }
    flags.push({ sig: 'error', bot: l.bot, idx: l.idx, reason: afterMarker(l.raw) });
    open = { bot: l.bot, lastIdx: l.idx };
  }
  return flags;
}

// (b) The judge's own escalation: Contiguous: N/M with N ≥ JUDGE_REPEAT_MIN.
// A rising run (3/5 → 4/5 → 5/5 for one bot+fragment) is one episode — flag
// anchored at the PEAK line so the slice contains the whole climb.
function sigJudgeRepeat(lines) {
  const RE = /Fragment: (\S+) \| Success: (\S+) \| Readable: "(.*)" \| Contiguous: (\d+)\/(\d+)/;
  const episodes = new Map();   // bot:fragment → { peak, idx, readable }
  const flags = [];
  const close = (key) => {
    const e = episodes.get(key);
    if (e && e.peak >= JUDGE_REPEAT_MIN) {
      flags.push({
        sig: 'judge-repeat', bot: e.bot, idx: e.idx,
        reason: `${e.fragment} repeated ${e.peak}x without progress — "${e.readable}"`,
      });
    }
    episodes.delete(key);
  };
  for (const l of lines) {
    const m = l.raw.match(RE);
    if (!m) continue;
    const [, fragment, , readable, nStr] = m;
    const n = +nStr;
    const key = `${l.bot}:${fragment}`;
    if (n === 1) close(key);
    const e = episodes.get(key) || { bot: l.bot, fragment, peak: 0 };
    if (n >= e.peak) { e.peak = n; e.idx = l.idx; e.readable = readable; }
    episodes.set(key, e);
  }
  for (const key of [...episodes.keys()]) close(key);
  return flags;
}

// (c) Identical warn text repeated — catches loops that never reach the judge
// (each iteration "succeeds" enough to reset Contiguous). Normalized to the
// text after the ⚠️ so differing timestamps don't hide the repetition.
function sigWarnRepeat(lines) {
  const seen = new Map();   // bot|text → count
  const flags = [];
  for (const l of lines) {
    if (l.level !== 'warn') continue;
    const key = `${l.bot}|${afterMarker(l.raw)}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n === WARN_REPEAT_COUNT) {
      flags.push({
        sig: 'warn-repeat', bot: l.bot, idx: l.idx,
        reason: `same warn ${WARN_REPEAT_COUNT}x: ${afterMarker(l.raw)}`,
      });
    }
  }
  return flags;
}

// (d) Warn burst: many warns (any text) from one bot in a short window —
// degraded operation even when no single message repeats. One flag per burst;
// a burst ends when the window goes quiet.
function sigWarnBurst(lines) {
  const byBot = new Map();
  for (const l of lines) {
    if (l.level === 'warn' && l.relSec !== null) {
      if (!byBot.has(l.bot)) byBot.set(l.bot, []);
      byBot.get(l.bot).push(l);
    }
  }
  const flags = [];
  for (const [bot, warns] of byBot) {
    let suppressUntil = -1;
    for (let i = 0; i + WARN_BURST_COUNT <= warns.length; i++) {
      const first = warns[i];
      const kth = warns[i + WARN_BURST_COUNT - 1];
      if (first.relSec < suppressUntil) continue;
      if (kth.relSec - first.relSec <= WARN_BURST_WINDOW_SEC) {
        flags.push({
          sig: 'warn-burst', bot, idx: kth.idx,
          reason: `${WARN_BURST_COUNT}+ warns within ${kth.relSec - first.relSec}s`,
        });
        suppressUntil = kth.relSec + WARN_BURST_WINDOW_SEC;
      }
    }
  }
  return flags;
}

// (e) Silence gap: an active bot did no WORK for > SILENCE_GAP_SEC. Two forms:
// a mid-trace gap (flag at the line that broke the silence, so the slice shows
// what preceded the stall) and a trailing gap (bot went quiet while the rest of
// the fleet kept logging — the dead-bot fingerprint; no later line exists, so
// the flag anchors at the bot's last line). A logged disconnect ends activity.
// Passive relay lines are NOT life signs — PASSIVE_LINE (imported from trace_read, which carries the
// two corpses that put each pattern in it) is what keeps this signature from reading a dead bot's link
// thread as work. This is the signature that FOUND the failure, so the filter is load-bearing here and
// removing it re-blinds exactly this check.

// A finished structure stops reporting numbers — building_integrity switches from "N/285 voxels
// correct" to a wordless "matches the blueprint — nothing to fix". Every reader that keys on the
// numeric form alone goes blind at exactly the moment the work succeeds, so completion is matched
// here once and shared (Law 16) rather than re-derived per call site.
const BUILD_DONE_RE = /"([^"]+)" matches the blueprint/;

function sigSilence(lines) {
  const lastByBot = new Map();
  const disconnected = new Set();
  const flags = [];
  let maxRel = 0;
  for (const l of lines) {
    const dm = l.raw.match(/Bot '(\w+)' disconnected/);
    if (dm) disconnected.add(dm[1]);
    if (l.relSec === null || !l.bot || OVERSEER_UNITS.has(l.bot)) continue;
    maxRel = Math.max(maxRel, l.relSec);
    if (PASSIVE_LINE.test(l.raw)) continue;
    const prev = lastByBot.get(l.bot);
    if (prev && l.relSec - prev.relSec > SILENCE_GAP_SEC) {
      flags.push({
        sig: 'silence', bot: l.bot, idx: l.idx,
        reason: `no output for ${l.relSec - prev.relSec}s (silent since [${relativeTime(prev.relSec)}])`,
      });
    }
    lastByBot.set(l.bot, l);
  }
  for (const [bot, last] of lastByBot) {
    if (disconnected.has(bot)) continue;
    if (maxRel - last.relSec > SILENCE_GAP_SEC) {
      flags.push({
        sig: 'silence', bot, idx: last.idx,
        reason: `silent for ${maxRel - last.relSec}s while the fleet kept running (last line shown)`,
      });
    }
  }
  return flags;
}

// (f) Integrity regression: a structure's correct-count went DOWN. Tracked per
// structure across the whole stream (shared world — a regression is real no
// matter which bot scanned it). Covers building ("X/Y voxels correct") and
// mining (excavate frontier correct=N).
function sigRegression(lines) {
  const BUILD_RE = /"([^"]+)" is (\d+)\/\d+ voxels correct/;
  // Key on the FULL segment identity ("staircase -35|34|6"), not just the word "staircase":
  // \S+ captured only "staircase", so every segment shared one key and a normal frontier advance
  // (finish segment A at correct=65 → open fresh segment B at correct=40) read as a 65→40 regression.
  // Each segment carves monotonically 40→67 on its own; a real regression is a DROP within one segment.
  const MINE_RE = /excavate frontier: (.+?) y=.*?\bcorrect=(\d+)/;
  const best = new Map();
  const flags = [];
  const check = (l, key, val) => {
    const prev = best.get(key);
    if (prev !== undefined && val < prev - REGRESSION_TOLERANCE) {
      flags.push({
        sig: 'regression', bot: l.bot, idx: l.idx,
        reason: `${key} correct-count fell ${prev} → ${val} (drop ${prev - val} > tolerance ${REGRESSION_TOLERANCE})`,
      });
    }
    best.set(key, Math.max(prev ?? val, val));
  };
  for (const l of lines) {
    let m;
    if ((m = l.raw.match(BUILD_RE))) check(l, `build:${m[1]}`, +m[2]);
    else if ((m = l.raw.match(MINE_RE))) check(l, `mine:${m[1]}`, +m[2]);
  }
  return flags;
}

// (g) Judge halt: recursive_judge parked a bot for inspection (haltForInspection). It killed a
// signal, routed nothing, and the bot is now inert BY DESIGN (Law 13, default stopped) — the judge's
// own "engineering problem, human needed" verdict after its retries were spent. This must WAKE, and it
// rides a SUMMARY line, so nothing else here would catch it directly: the kill's ❌ error can scroll
// off on a bounce or ride the peer bot, and the resulting silence is only inferred 120s later by
// sigSilence — a window that may never run before a fix/soak-exit intervenes (observed 2026-07-09:
// AurenBot halted in a fix's blind gap, never flagged). The "silence below is expected" disambiguator
// on the halt line tells a HUMAN reader the quiet is intended; it must never let the terminal state
// itself pass unflagged. Fires on the halt line, once per halt. Like errors, it is exempt from the
// watch baseline (wakes at any idx) so a watcher launched INTO an already-halted fleet fires at once.
const HALT_RE = /HALTED for inspection after killing "([^"]*)"/;
function sigJudgeHalt(lines) {
  const flags = [];
  for (const l of lines) {
    const m = l.raw.match(HALT_RE);
    if (m) flags.push({
      sig: 'halt', bot: l.bot, idx: l.idx,
      reason: `judge halted the bot for inspection after killing "${m[1]}" — inert, needs a code fix`,
    });
  }
  return flags;
}

// (h) Death: a bot died. This signature exists because the construct does NOT log its own death as an
// ❌ — it respawns and carries on — so every other signature here sleeps straight through it. The wake
// used to belong to combat_observer_monitor, which polled a `deathCount` scoreboard over RCON from a
// second client; that whole stack was deleted 2026-08-06 (Architect: "i want the watcher trace to be the
// one source of truth"), and deleting a capability silently would be the Law 25 fault, so the wake moves
// here rather than disappearing. The fleet already announces it: job_board posts a ⚠️ the moment the
// board is built for a corpse, because a dead bot's board legitimately holds ONE job.
//
// THE WRONG TURN, already taken: reading death from HEALTH. It cannot work — the death window is a few
// ticks wide, the bot respawns at full health before the next sample, and most deaths (fall, lava,
// drowning) leave no hostile nearby to have logged anything. A board line is emitted by the bot itself,
// on its own clock, and cannot be sampled past.
//
// DEDUPED PER CORPSE, not per line: that warn re-posts on every board build while the bot is down, so a
// single death yields a burst. A death line within DEATH_EPISODE_SEC of the last one from the same bot
// is the SAME corpse — the flag counts deaths, not board rebuilds. Exempt from the watch baseline like
// `error`/`halt` (a watcher armed into an already-dead fleet must fire on its first read).
const DEATH_RE = /☠️ Bot is DEAD/;
const DEATH_EPISODE_SEC = 60;

// ── ONE DEATH RAISES TWO WAKING EPISODES, AND THIS IS WHERE THEY ARE RECOGNISED AS ONE ──────────────
// A death emits both a `death` flag (job_board's ☠️ Bot is DEAD) and an `error` flag (battle_stations'
// ☠️ DIED, an error-level line, so sigErrors takes it too). Both SHOULD wake — they are two true reports
// of a terminal event — but a consumer deciding "was this waking episode a death?" must be able to see
// that they are one corpse, or it counts one death as two unrelated faults.
//
// It lives HERE rather than in the consumer because this file owns what a signature MEANS: the two
// markers above are the definition, and a second copy of them in a tool would be free to drift out of
// step with the emitters it is reading (Law 16). Consumers ask; they never re-derive.
const DEATH_ERROR_RE = /☠️ DIED/;
function isDeathClass(flag) {
  if (!flag) return false;
  if (flag.sig === 'death') return true;
  return flag.sig === 'error' && DEATH_ERROR_RE.test(flag.reason || '');
}
function sigDeath(lines) {
  const flags = [];
  const lastPerBot = new Map();
  for (const l of lines) {
    if (!DEATH_RE.test(l.raw)) continue;
    const t = l.relSec == null ? 0 : l.relSec;
    const prev = lastPerBot.get(l.bot);
    lastPerBot.set(l.bot, t);
    if (prev !== undefined && t - prev <= DEATH_EPISODE_SEC) continue;
    flags.push({
      sig: 'death', bot: l.bot, idx: l.idx,
      reason: `bot DIED at [${relativeTime(t)}] — it respawns on its own, so read the fight it died in: ` +
              `trace_monitor.js --engagement --bot=${l.bot}`,
    });
  }
  return flags;
}

const SIGNATURES = [sigErrors, sigJudgeRepeat, sigWarnRepeat, sigWarnBurst, sigSilence, sigRegression, sigJudgeHalt, sigDeath];

function detect(lines) {
  const flags = segmentRuns(lines).flatMap(seg => SIGNATURES.flatMap(sig => sig(seg)));
  flags.sort((a, b) => a.idx - b.idx);
  return flags;
}

// ── Digest ───────────────────────────────────────────────────────────────────
// Counts describe the LATEST run only — mixing runs would report a fleet that
// never existed at any single moment. computeBotStats is the single source of the
// per-bot aggregation (Law 16): digest formats it into lines, and the dashboard
// (monitoring/dashboard.js) consumes the same Map — neither re-implements the count.
// ── Authoritative per-bot liveness (the anti-ambiguity read) ─────────────────────────────────────
// WHY THIS EXISTS. Every other "is this bot alive" number in this tool is derived from ONE trace file —
// by default the MERGED watcher_overseer.json. The merge can lag a single bot while that bot is running
// perfectly, and when it does, `last activity [Nm Ss]` for that bot silently freezes and the bot reads as
// dead. That is not hypothetical: on 2026-07-20 the watch heartbeat reported TessaBot's last activity at
// [28m 3s] and its counters frozen for ~3 minutes, and the AI developer escalated it as a wedged bot. Her
// OWN watcher file said lastStoryAt = now, to the second — she was current, and in fact AHEAD of the peer
// the merge was keeping up with. The report was wrong, and nothing in the output could have revealed it.
//
// The fix is to stop deriving liveness from the merge at all: read each bot's OWN story file and take
// the wall-clock age of its LAST LINE. That is ground truth for "is this bot posting RIGHT NOW", and it
// is immune to how the merge is doing.
//
// IT READS THE LAST LINE'S OWN STAMP, not a `lastStoryAt` field and not the file's mtime. The field
// existed until 2026-08-12 and was deleted with the whole-file rewrite that carried it — every line has
// always led with its ISO, so the field was a second copy of a fact the story already held (Law 16).
// mtime was never usable while the old writer re-persisted the file every 100ms on a timer, which made
// it advance straight through a hang (runbook §6 states this and the merged-stream trap outright). The
// append-only writer removed that timer, so mtime now moves only when a line lands — but the last line's
// own stamp is still the better answer, because it survives a file copied, synced or restored.
//
// Reported ALONGSIDE the merged view rather than replacing it, and any disagreement between the two is
// printed as MERGE-LAG. The disagreement is itself the diagnosis — it means the bot is fine and the
// OVERSEER STREAM is behind, which is a different fault with a different fix, and the old output
// collapsed those two into one indistinguishable symptom (Law 6: a number that cannot be checked against
// its source is a hidden variable).
// ── THE HEARTBEATS COME FROM THE TRACE THAT WAS HANDED IN, NOT FROM THIS REPOSITORY (2026-09-10) ────
// This was `record_homes.TRACE_DIR` unconditionally, which is the REPOSITORY's trace folder. Correct
// whenever the file being read is also the repository's, and silently wrong the moment it is not — the
// lens then watches one fleet's overseer stream while measuring a different fleet's liveness.
//
// MEASURED: `run.js` points this at a stranger download's `watcher_overseer.jsonl`. Ten seconds into a
// two-minute window the freeze arm fired `FLEET FROZEN — no bot has logged for 5708s`, while the digest
// over the very same file reported `last activity [0m 7s]`. Two irreconcilable answers about one fleet,
// because the heartbeats were this repository's leftovers from earlier in the day and the stream was the
// download's. The run was ended for handoff on a fleet that was working perfectly.
//
// A trace file names its own folder, so when one is given explicitly its directory IS the answer, and
// the lens becomes self-consistent with its own argument. The default is unchanged for every caller that
// passes no file. `combat_lens.js` here and `camera_lens.js` in the workshop both compute the same
// constant the old way and are exposed to the same fault; neither is reached by `run.js`, so neither is
// changed here (not this file's to own — noted rather than fixed).
const KERNEL_DIR = args.some(a => !a.startsWith('--'))
  ? path.dirname(path.resolve(TRACE_FILE))
  : require(require('./lens_paths').bot('js_kernel/utils/record_homes')).TRACE_DIR;

// ── THREE FLAGS READ EQUIPMENT THAT IS NOT IN THIS DOWNLOAD ─────────────────────────────────────────
// `--camera`, `--witness` and `--machine-load` read the camera stack's own records, and the camera
// stack is the Architect's equipment (`Auren_Workshop/`) rather than bot material. When the lenses moved
// in here on 2026-09-10 those three stayed behind — the split is the RECORD each lens reads, not a
// judgement about which are useful: shipping a reader for `fleet_logs/machine_load/` to somebody who
// owns no camera ships a flag that can only ever report an empty directory.
//
// So they are resolved at the moment the flag is used, and their absence is ANSWERED rather than
// thrown. `MODULE_NOT_FOUND` naming a path two directories above the download is the wrong sentence to
// hand a stranger who typed a flag the help text offered them (Law 13 — a missing thing is named, never
// guessed at, and never dressed up as a crash in the caller).
function recordingLens(name, flag) {
  const dir = require('./lens_paths').recordingLensDir();
  if (dir) return require(path.join(dir, name));
  console.log(`${flag} reads the CAMERA STACK's records, and the camera stack is not part of this `
    + `download — it lives in the Architect's workshop beside the bot. Every other flag reads this `
    + `bot's own trace and works here.`);
  process.exit(0);
}

function readBotHeartbeats() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(KERNEL_DIR); } catch (_) { return out; }
  for (const f of files) {
    const m = /^watcher_(.+)\.jsonl$/.exec(f);
    if (!m || m[1] === 'overseer') continue;
    const bot = m[1];
    try {
      // Walk BACKWARD to the newest line carrying a readable stamp. A torn final line (the process died
      // mid-append) and the infrastructure chatter that leads with no ISO are both simply skipped —
      // this is a liveness probe, so it wants the freshest STAMPED line, not the last byte in the file.
      const rows = fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8').split('\n');
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!rows[i]) continue;
        let raw;
        try { raw = JSON.parse(rows[i]); } catch (_) { continue; }
        const lead = raw[0] === '[' ? raw.slice(1, raw.indexOf(']')) : null;
        const ms = lead ? Date.parse(lead) : NaN;
        if (Number.isNaN(ms)) continue;
        out.set(bot, { at: new Date(ms), iso: lead, ageSec: Math.max(0, Math.round((Date.now() - ms) / 1000)), story: raw });
        break;
      }
    } catch (_) { /* a file being appended to on this pass is not a fault — the next pass reads it */ }
  }
  return out;
}

// One line per bot, deliberately flat and grep-friendly (`trace.ps1 --last | grep TessaBot`). Stale is
// stated as a word, not left to the reader to compute from a timestamp.
function lastPostLines() {
  const hb = readBotHeartbeats();
  if (!hb.size) return ['LASTPOST (no per-bot watcher files found — is the fleet up?)'];
  const out = [];
  for (const [bot, h] of [...hb.entries()].sort()) {
    const state = h.ageSec <= SILENCE_GAP_SEC ? 'POSTING' : 'STALE';
    out.push(`LASTPOST ${bot} ${state} age=${h.ageSec}s at=${h.iso} story=${JSON.stringify(afterMarker(h.story) || h.story)}`);
  }
  return out;
}

function computeBotStats(lines) {
  const segs = segmentRuns(lines);
  const bots = new Map();
  for (const l of (segs[segs.length - 1] || [])) {
    if (!l.bot || OVERSEER_UNITS.has(l.bot)) continue;
    if (!bots.has(l.bot)) bots.set(l.bot, { s: 0, w: 0, e: 0, lastRel: 0, lastIso: null, latestBuild: null, latestBuildT: 0, latestMine: null, latestMineT: 0, haltedAt: null, haltedOn: null });
    const b = bots.get(l.bot);
    if (l.level === 'summary') b.s++;
    else if (l.level === 'warn') b.w++;
    else if (l.level === 'error') b.e++;
    // last activity = last WORK line; passive merge echoes would mask a corpse
    if (l.relSec !== null && !PASSIVE_LINE.test(l.raw)) {
      b.lastRel = Math.max(b.lastRel, l.relSec);
      // Absolute, not relative: `lastRel` is measured from run start, so a merge that stopped updating
      // ENTIRELY leaves every bot's relative figure equally old and the staleness cancels out — the
      // comparison in digest() can only see it against a wall clock.
      if (l.iso) b.lastIso = l.iso;
      // A real work line means the bot is running NOW, so a halt recorded earlier no longer describes
      // the present (an operator re-tasked it — the one exit the halt line itself names). Cleared BEFORE
      // the halt match below, so the halt line — itself a work line — never clears its own flag.
      b.haltedAt = null;
    }
    // Both integrity lines carry their scan time: the header is a snapshot, and a snapshot that hides
    // its age lies by omission. AurenBot's build line was 21 minutes stale and read as live (Law 6).
    if (l.raw.includes('voxels correct') || BUILD_DONE_RE.test(l.raw)) { b.latestBuild = afterMarker(l.raw); b.latestBuildT = l.relSec ?? b.latestBuildT; }
    if (l.raw.includes('excavate frontier')) { b.latestMine = afterMarker(l.raw); b.latestMineT = l.relSec ?? b.latestMineT; }
    const hm = HALT_RE.exec(l.raw);
    if (hm) { b.haltedAt = l.relSec; b.haltedOn = hm[1]; }
  }
  return bots;
}

function digest(lines) {
  const bots = computeBotStats(lines);
  const hb = readBotHeartbeats();   // ground truth, independent of the merge (see readBotHeartbeats)
  // Run end = the newest work line ANY bot logged; a halted bot's own clock stopped, so its inert
  // span can only be measured against a peer that kept working.
  let runEnd = 0;
  for (const b of bots.values()) runEnd = Math.max(runEnd, b.lastRel);
  const out = [];
  for (const [bot, b] of bots) {
    // A halt is the single most load-bearing fact in the header: the bot is inert by design and will
    // never recover on its own. Reporting only "last activity [t]" made a halted bot and a healthy one
    // render identically — the reader had to already suspect the death to find it. State first.
    const state = b.haltedAt !== null
      ? `⏸ HALTED [${relativeTime(b.haltedAt)}] on "${b.haltedOn}" — inert ${relativeTime(Math.max(0, runEnd - b.haltedAt))}, needs a code fix`
      : `last activity [${relativeTime(b.lastRel)}]`;
    out.push(`${bot}: 📊 ${b.s} · ⚠️ ${b.w} · ❌ ${b.e} · ${state}`);
    // The merge-derived number above can only ever be as fresh as the merge. The bot's own file is the
    // authority on whether it is posting, so print it beside — and when the two disagree, say so in the
    // one place the reader is standing, rather than leaving them to notice the discrepancy themselves.
    const h = hb.get(bot);
    if (h) {
      const mergeAgeSec = b.lastIso ? Math.max(0, Math.round((Date.now() - Date.parse(b.lastIso)) / 1000)) : null;
      const lag = h.ageSec <= SILENCE_GAP_SEC && mergeAgeSec !== null && mergeAgeSec > SILENCE_GAP_SEC;
      out.push(`  own file: ${h.ageSec <= SILENCE_GAP_SEC ? 'POSTING' : 'STALE'} age=${h.ageSec}s` +
        (lag ? `  ⚠️ MERGE-LAG — the merged view above is ${mergeAgeSec}s behind this bot's own watcher; TRUST THIS LINE, not the one above` : ''));
    }
    if (b.latestBuild) out.push(`  build: [${relativeTime(b.latestBuildT)}] ${b.latestBuild}`);
    if (b.latestMine) out.push(`  mine:  [${relativeTime(b.latestMineT)}] ${b.latestMine}`);
  }
  // A bot with a live watcher file but no line in the merge is invisible to every merge-derived stat —
  // the most misleading case of all, because absence reads as "not running".
  for (const [bot, h] of hb) {
    if (bots.has(bot)) continue;
    out.push(`${bot}: (absent from merged trace) own file: ${h.ageSec <= SILENCE_GAP_SEC ? 'POSTING' : 'STALE'} age=${h.ageSec}s — ${afterMarker(h.story) || h.story}`);
  }
  if (out.length === 0) out.push('(no bot lines in trace)');
  return out;
}

// The ONE-LINE status the quiet watch shows between flags (Architect 2026-09-11: *"this is super noisy.
// explain what this is and remove it or shorten it"*).
//
// It used to be digest()'s per-bot header lines joined end to end: summary counts nobody reads live, the
// merge-derived clock, and — for every unit with its own watcher file but no line in the merge (the desk,
// the stand-in player) — that unit's latest story, URL-encoded. Three hundred characters, wider than any
// terminal, and `\r\x1b[2K` clears only the row the cursor is on, so every tick left the wrapped remainder
// on screen and the "live field" became a scroll of fragments.
//
// This line carries what the field is FOR and nothing else: is each crew bot alive (its OWN file's age,
// the ground truth readBotHeartbeats exists for), and is it piling up faults. The full header is still
// one `trace.ps1` away — digest() is unchanged and still owns that.
//
// ONLY THE ROSTER'S BOTS. The stand-in player writes into the same merge and stands still by design, so it
// read as a permanently SILENT unit on every tick. The roster (`architect_config.BOT_SENIORITY`, which
// requires nothing) is the one list of who a crew bot can be.
function watchStatus(lines, elapsedMin) {
  const roster = require(require('./lens_paths').bot('Thinking_fragments/architect_config.js')).BOT_SENIORITY;
  const bots = computeBotStats(lines);
  const hb = readBotHeartbeats();
  const ago = s => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`);
  const parts = [];
  for (const [bot, b] of bots) {
    if (!(bot in roster)) continue;
    if (b.haltedAt !== null) { parts.push(`${bot} HALTED`); continue; }
    const h = hb.get(bot);
    const alive = !h ? `last ${relativeTime(b.lastRel)}`
      : h.ageSec <= SILENCE_GAP_SEC ? `${ago(h.ageSec)} ago` : `SILENT ${ago(h.ageSec)}`;
    parts.push(`${bot} ${alive}, ${b.w} warn, ${b.e} err`);
  }
  return `[watch ${Math.floor(elapsedMin)}m] quiet · ${parts.length ? parts.join(' · ') : 'no bot lines yet'}`;
}

// Every warning in the latest run, deduped by bot+text with a repeat count and first-seen time.
// The flag signatures only surface a warn if it repeats/bursts; this lists ALL of them so a
// single one-off warn (which never flags) is still visible when the Architect checks the trace.
function warningsDigest(lines) {
  const segs = segmentRuns(lines);
  const latest = segs[segs.length - 1] || [];
  const groups = new Map();   // `${bot}\u0000${text}` → { bot, text, n, firstRel }
  const order = [];
  for (const l of latest) {
    if (l.level !== 'warn' || !l.bot || OVERSEER_UNITS.has(l.bot)) continue;
    const text = afterMarker(l.raw);
    const key = `${l.bot}\u0000${text}`;
    if (!groups.has(key)) { groups.set(key, { bot: l.bot, text, n: 0, firstRel: l.relSec }); order.push(key); }
    groups.get(key).n++;
  }
  return order.map(k => groups.get(k));
}


function fail(msg) { console.error(`trace_monitor: ${msg}`); process.exit(1); }

// Overlapping slices don't reprint: each flag's slice starts no earlier than
// one past the previously printed line, so a cluster of flags around one
// incident reads as one continuous excerpt with flag headers interleaved.
function printFlags(lines, flags) {
  let printedThrough = -1;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    console.log('');
    console.log(`── FLAG ${i + 1}/${flags.length} · ${f.sig} · ${f.bot || '?'} ─ ${f.reason}`);
    const start = Math.max(0, f.idx - CONTEXT, printedThrough + 1);
    if (f.idx <= printedThrough) {
      console.log(`   (line ${f.idx} already shown above)`);
      continue;
    }
    if (start > 0 && start === printedThrough + 1 && i > 0) console.log('   (continues from previous slice)');
    for (let j = start; j <= f.idx; j++) {
      console.log(`   ${j === f.idx ? '>>' : '  '} ${lines[j].raw}`);
    }
    printedThrough = f.idx;
  }
}

function runOnce() {
  let lines;
  try {
    lines = readTrace(TRACE_FILE);
  } catch (e) {
    console.error(`trace_monitor: cannot read trace — ${e.message}`);
    process.exit(1);
  }
  const flags = detect(lines);
  console.log(`trace_monitor · ${path.basename(TRACE_FILE)} · ${lines.length} lines`);
  for (const d of digest(lines)) console.log(d);

  // Full warning list (every ⚠️ in the latest run, not just the ones a signature flagged).
  const warns = warningsDigest(lines);
  if (warns.length) {
    const total = warns.reduce((a, w) => a + w.n, 0);
    console.log(`\n⚠️  warnings (${total} total, ${warns.length} distinct):`);
    for (const w of warns) {
      console.log(`   [${relativeTime(w.firstRel || 0)}] ${w.bot}: ${w.text}${w.n > 1 ? ` ×${w.n}` : ''}`);
    }
  }

  if (flags.length === 0) {
    console.log('\nNo anomalies. All signatures quiet.');
    process.exit(0);
  }
  console.log(`\n${flags.length} flag(s): ` + summarizeFlags(flags));
  if (!QUIET) printFlags(lines, flags);
  process.exit(2);
}

function summarizeFlags(flags) {
  const counts = {};
  for (const f of flags) counts[f.sig] = (counts[f.sig] || 0) + 1;
  return Object.entries(counts).map(([s, n]) => `${s}×${n}`).join(' · ');
}

// ── Activity view (context channel, never flags) ─────────────────────────────
// The decision spine, latest run only: for each bot, what the board offered,
// which job it picked, and how that job ended. Just a filter over lines already
// in the trace — the reader pulls it when curious about "what's going on", and
// it can be ignored with zero cost. One episode of the loop reads top-to-bottom:
//   JOB BOARD (options) → storage stock → Claimed (the pick) → COMPLETE/STUCK.
const ACTIVITY_PATTERNS = [
  /\[JOB_BOARD\].*JOB BOARD:/,        // "──── JOB BOARD: N job(s) ────"
  /\[JOB_BOARD\].*\bP\d+ \w+\//,       // the ranked job list (P10 supply/charcoal …)
  /\[JOB_BOARD\].*storage \w+:/,     // per-item storage stock (storage logs:25/25 ✓)
  /\[DISPATCHER\].*\bClaimed /,        // the job the bot picked
  /\[DISPATCHER\].*Magnet cleared/,    // bot went idle (board empty / killed)
  /_MANAGER\].*(COMPLETE|STUCK|RELEASE)/, // how the picked job ended
  /\[RECURSIVE_JUDGE\].*stopped an (infinite loop|AB)/, // a kill (the loud outcome)
];

function runActivity() {
  let lines;
  try {
    lines = readTrace(TRACE_FILE);
  } catch (e) {
    console.error(`trace_monitor: cannot read trace — ${e.message}`);
    process.exit(1);
  }
  const segs = segmentRuns(lines);
  const seg = segs[segs.length - 1] || [];
  const rows = seg.filter(l =>
    (!BOT_FILTER || l.bot === BOT_FILTER) &&
    ACTIVITY_PATTERNS.some(p => p.test(l.raw)));

  console.log(`trace_monitor · activity · ${path.basename(TRACE_FILE)}`
    + `${BOT_FILTER ? ` · ${BOT_FILTER}` : ''} · latest run · ${rows.length} decision line(s)`);
  console.log('(context only — this view never flags and never wakes a watcher)\n');
  for (const l of rows) console.log(l.raw);
  if (rows.length === 0) console.log('(no job-board / dispatch activity in the latest run yet)');
  process.exit(0);
}

// ── Story view (context channel, never flags) ────────────────────────────────
// The bot's own narrative, one block per dispatched job. A job runs from a
// dispatcher Claimed (JOB BOARD gave the options, dispatcher picked one) to the
// manager's COMPLETE/STUCK/RELEASE — everything the bot did to close that gap,
// with the problems it hit in the middle and the verdict at the end. Like
// --activity, it INVENTS no logging: every line already exists in the trace
// (Law 5/14); this is a lens that groups them into episodes. Never flags, always
// exits 0. Clean jobs (no warn/error) collapse to a single line so the ones that
// fought stand out; a job with any issue prints the full PLAN/DOING/VERDICT block.

function runStory() {
  let lines;
  try {
    lines = readTrace(TRACE_FILE);
  } catch (e) {
    console.error(`trace_monitor: cannot read trace — ${e.message}`);
    process.exit(1);
  }
  const segs = segmentRuns(lines);
  const seg = segs[segs.length - 1] || [];
  const episodes = buildEpisodes(seg).filter(ep => !BOT_FILTER || ep.bot === BOT_FILTER);

  console.log(`trace_monitor · story · ${path.basename(TRACE_FILE)}`
    + `${BOT_FILTER ? ` · ${BOT_FILTER}` : ''} · latest run · ${episodes.length} job episode(s)`);
  const full = has('all');
  console.log(full
    ? '(context only — never flags, never wakes a watcher; --all: every episode in full, board included)\n'
    : '(context only — never flags, never wakes a watcher; clean jobs shown as one line — --all shows every board)\n');
  for (const ep of episodes) console.log(renderEpisode(ep, full));
  if (episodes.length === 0) console.log('(no dispatched jobs in the latest run yet)');
  process.exit(0);
}

// ── Progress view (context channel, never flags) ─────────────────────────────
// Answers the Architect's standing question — "are we still progressing or just
// looping?" — from the integrity trace, latest run only. For each structure it
// walks the correct-count over wall-time and reports first → peak → last with the
// moment each was reached, then a verdict: COMPLETE (last == total), RISING (peak
// advanced inside the tail window), or STALLED (peak reached long ago, nothing new
// since — the loop fingerprint). The decisive line is the fleet-wide "last net-new
// progress at [t]": if the run kept logging for N minutes past that with no peak
// advance anywhere, those minutes were livelock, not work. A place/complete
// livelock (blocks placed that don't persist) evades the recursive judge because
// its outcome ALTERNATES (all_complete ↔ blocked_remainder) so the 5-strike counter
// never sees 5 identical — integrity, not the judge, is where it shows. So this also
// tallies, per structure, how many all_complete vs blocked outcomes landed AFTER the
// peak was first hit: both non-zero = an oscillating livelock the judge can't catch.
// Reuses the same BUILD/MINE regexes as sigRegression (Law 16).
function runProgress() {
  let lines;
  try { lines = readTrace(TRACE_FILE); }
  catch (e) { fail(`cannot read trace — ${e.message}`); }
  const segs = segmentRuns(lines);
  const seg = segs[segs.length - 1] || [];

  const BUILD_RE = /"([^"]+)" is (\d+)\/(\d+) voxels correct/;
  const MINE_RE = /excavate frontier:.*?\bbuilt (\d+)\/(\d+) shaft_center=\(([^)]+)\)/;
  const OUTCOME_RE = /build_executor: "([^"]+)" (all_complete|blocked_remainder|blocked)/;

  const struct = new Map();   // key → { total, first:{t,c}, peak:{t,c}, last:{t,c}, complete:0, blocked:0 }
  const note = (key, total, t, c) => {
    let s = struct.get(key);
    if (!s) { s = { total, first: { t, c }, peak: { t, c }, last: { t, c }, complete: 0, blocked: 0 }; struct.set(key, s); }
    if (c > s.peak.c) s.peak = { t, c };
    s.last = { t, c };
    s.total = total;
  };
  let maxRel = 0;
  for (const l of seg) {
    if (l.relSec == null) continue;
    // A halted/inert bot keeps echoing overseer HQ merges long after its own work stopped; those
    // passive relays must not inflate the run span (same corpse-filter sigSilence/computeBotStats use).
    if (PASSIVE_LINE.test(l.raw)) continue;
    maxRel = Math.max(maxRel, l.relSec);
    let m;
    if ((m = l.raw.match(BUILD_RE))) note(`build:${m[1]}`, +m[3], l.relSec, +m[2]);
    // Completion is progress — and it is the only progress that stops emitting a count. Keying this
    // ledger solely on the numeric line made SUCCESS look exactly like a freeze: last.c stuck at the
    // final partial scan, `done` never turned true, and a headframe finished at [6m 35s] reported
    // "■ STALLED 18m 47s ⚠ LIVELOCK" for the remaining 19 minutes of the run. The one detector built to
    // separate working from looping was accusing the finished build. Re-noting at the full total on the
    // completion line restores it (Law 6). Known limit: a structure already complete when the run began
    // logs no count at all, so its total is unknown and it stays absent from the ledger rather than
    // being reported at a size this tool would have to invent (Law 13 — never default a missing field).
    else if ((m = l.raw.match(BUILD_DONE_RE))) {
      const s = struct.get(`build:${m[1]}`);
      if (s) note(`build:${m[1]}`, s.total, l.relSec, s.total);
    }
    else if ((m = l.raw.match(MINE_RE))) note(`mine:${m[3]}`, +m[2], l.relSec, +m[1]);
    else if ((m = l.raw.match(OUTCOME_RE))) {
      const s = struct.get(`build:${m[1]}`);
      // Count outcomes only once the peak has been reached — churn after the structure
      // first hit its high-water mark is what distinguishes a livelock from normal building.
      if (s && s.last.t >= s.peak.t) { if (m[2] === 'all_complete') s.complete++; else s.blocked++; }
    }
  }

  console.log(`trace_monitor · progress · ${path.basename(TRACE_FILE)} · latest run · span [${relativeTime(maxRel)}] · tail window ${relativeTime(PROGRESS_TAIL_SEC)}`);
  console.log('(context only — never flags, never wakes; "progressing vs looping" ledger)\n');
  if (struct.size === 0) { console.log('(no build/mine integrity lines in the latest run yet)'); process.exit(0); }

  let lastProgressT = 0, lastProgressKey = null;
  const rows = [];
  for (const [key, s] of struct) {
    const done = s.last.c >= s.total;
    const rising = s.peak.t >= maxRel - PROGRESS_TAIL_SEC;
    const verdict = done ? '✔ COMPLETE'
      : rising ? '↑ RISING'
      : `■ STALLED ${relativeTime(maxRel - s.peak.t)} (peak at [${relativeTime(s.peak.t)}])`;
    const osc = (!done && s.complete > 0 && s.blocked > 0)
      ? `  ⚠ LIVELOCK: ${s.complete}× all_complete / ${s.blocked}× blocked after peak (judge-blind: outcome alternates)` : '';
    rows.push(`${key}  ${s.first.c}/${s.total} [${relativeTime(s.first.t)}] → peak ${s.peak.c} [${relativeTime(s.peak.t)}] → last ${s.last.c} [${relativeTime(s.last.t)}]  ${verdict}${osc}`);
    if (s.peak.t > lastProgressT) { lastProgressT = s.peak.t; lastProgressKey = key; }
  }
  for (const r of rows) console.log(r);

  const idle = maxRel - lastProgressT;
  console.log('');
  console.log(`▸ last net-new progress: [${relativeTime(lastProgressT)}] (${lastProgressKey})`);
  if (idle > PROGRESS_TAIL_SEC) {
    console.log(`▸ VERDICT: LOOPING — ${relativeTime(idle)} of the ${relativeTime(maxRel)} run produced zero net progress (${Math.round(100 * idle / (maxRel || 1))}% of the run spent not advancing any structure).`);
  } else {
    console.log(`▸ VERDICT: PROGRESSING — advanced within the last ${relativeTime(idle)}.`);
  }
  process.exit(0);
}

// ── Query mode (addressable slice — context channel, never flags) ──────────────
// Answers "show me the lines around THIS moment / carrying THIS tag / from THIS bot
// between minute X and Y" so a reader — or the AI monitor waking on a flag — pulls
// exactly the window it needs (before AND after) instead of loading the whole trace
// into context. Every filter is ANDed. Relative [Nm Ss] times reset on each 'start',
// so they are scoped to ONE run segment (default the latest run; --run=N|all widens).
// A read-only lens like --activity/--story: never flags, never wakes, exits 0.
//
//   --around=<time>   anchor; DEFAULT ±25 *matching* lines around it (count-bounded — safe with fast
//                     fleets). time = 1m1s | "1m 1s" | 90s | 90 | an ISO stamp. Narrow with --bot/--tag.
//   --lines=<N>       lines each side of the anchor in the default count mode (default 25).
//   --window=<sec> | --before=<sec> | --after=<sec>   opt INTO a time window instead of the count.
//   --from=<time> --to=<time>   an explicit range instead of --around (either bound omittable).
//   --tag=<T[,T…]>    only lines carrying [T] (STATION_REGISTRY, DISPATCHER, NAVIGATION…), case-insensitive.
//   --bot=<Bot>       only that bot's lines.        --level=<error|warn|summary|infra>   only that level.
//   --grep=<regex>    only lines matching (case-insensitive).   --run=<latest|N|all>   which run segment.

// "1m1s" | "1m 1s" | "90s" | "90" | "2m" → {relSec}; any ISO/Date-parseable string → {isoMs}.
function parseTimeToken(tok) {
  if (tok == null) return null;
  const t = String(tok).trim();
  const rel = t.match(/^(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i);
  if (rel && (rel[1] || rel[2])) return { relSec: (+(rel[1] || 0)) * 60 + (+(rel[2] || 0)) };
  if (/^\d+$/.test(t)) return { relSec: +t };            // bare number = seconds
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : { isoMs: ms };
}
function parseDurationSec(tok, dflt) {
  const p = parseTimeToken(tok);
  return p && p.relSec != null ? p.relSec : dflt;
}
function lineIsoMs(l) {
  return l.iso && !Number.isNaN(Date.parse(l.iso)) ? Date.parse(l.iso) : null;
}

function runQuery() {
  let lines;
  try { lines = readTrace(TRACE_FILE); }
  catch (e) { fail(`cannot read trace — ${e.message}`); }

  // Run scope: relative stamps reset per run, so a relative query must live inside one segment.
  const segs = segmentRuns(lines);
  const runSel = opt('run', 'latest');
  const scope = runSel === 'all' ? lines
    : /^\d+$/.test(runSel) ? (segs[+runSel - 1] || [])
    : (segs[segs.length - 1] || []);

  const preds = [];
  if (BOT_FILTER) preds.push(l => l.bot === BOT_FILTER);

  const tags = (opt('tag', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (tags.length) preds.push(l => tags.some(t => l.raw.toUpperCase().includes(`[${t}]`)));

  const level = opt('level', null);
  if (level) preds.push(l => l.level === level);

  const grep = opt('grep', null);
  if (grep) { const re = new RegExp(grep, 'i'); preds.push(l => re.test(l.raw)); }

  // Filter first (bot/tag/level/grep), THEN slice by time/anchor. Splitting them is what lets the
  // anchor window be a LINE COUNT rather than a duration: a time window explodes with a fast multi-bot
  // fleet (5 bots × ~10 lines/s × 60s ≈ 3000 lines), defeating the point. So the DEFAULT around a moment
  // is ±N *matching* lines — bounded no matter how fast the fleet logs (Architect, 2026-07-10). Pass
  // --window/--before/--after to opt into a real time window instead. Narrow with --bot/--tag to make
  // the anchor land on the exact line you care about when many share one second.
  const filtered = scope.filter(l => preds.every(p => p(l)));
  const aroundTok = opt('around', null), fromTok = opt('from', null), toTok = opt('to', null);
  const timeWindowGiven = args.some(a => /^--(window|before|after)=/.test(a));
  let rows, desc = '';

  if (aroundTok != null) {
    const a = parseTimeToken(aroundTok);
    if (!a) fail(`--around='${aroundTok}' is not a time (use 1m1s | "1m 1s" | 90s | an ISO stamp).`);
    const useIso = a.isoMs != null;
    const anchorVal = useIso ? a.isoMs : a.relSec;
    const pos = l => (useIso ? lineIsoMs(l) : l.relSec);     // this line's position on the chosen axis
    const anchorLabel = useIso ? new Date(anchorVal).toISOString() : `[${relativeTime(anchorVal)}]`;

    if (timeWindowGiven) {
      const before = parseDurationSec(opt('before', opt('window', null)), 60);
      const after = parseDurationSec(opt('after', opt('window', null)), 60);
      const lo = anchorVal - before * (useIso ? 1000 : 1);
      const hi = anchorVal + after * (useIso ? 1000 : 1);
      rows = filtered.filter(l => { const v = pos(l); return v != null && v >= lo && v <= hi; });
      desc = `around ${anchorLabel} (−${before}s / +${after}s of matches)`;
    } else {
      // Count window (default): N matching lines each side of the anchor LINE — the match closest to
      // the moment. Bounded regardless of fleet size/speed. Filters above pinpoint which line anchors.
      const N = parseInt(opt('lines', '25'), 10);
      let idx = -1, best = Infinity;
      for (let i = 0; i < filtered.length; i++) {
        const v = pos(filtered[i]);
        if (v == null) continue;
        const d = Math.abs(v - anchorVal);
        if (d < best) { best = d; idx = i; }
      }
      if (idx < 0) { rows = []; desc = `±${N} lines around ${anchorLabel} (no line carries that axis)`; }
      else {
        rows = filtered.slice(Math.max(0, idx - N), Math.min(filtered.length, idx + N + 1));
        const at = filtered[idx].relSec != null ? `[${relativeTime(filtered[idx].relSec)}]` : (filtered[idx].iso || '?');
        desc = `±${N} lines around ${anchorLabel} (anchor = match #${idx} at ${at})`;
      }
    }
  } else if (fromTok != null || toTok != null) {
    const f = fromTok != null ? parseTimeToken(fromTok) : null;
    const t = toTok != null ? parseTimeToken(toTok) : null;
    if (fromTok != null && !f) fail(`--from='${fromTok}' is not a time.`);
    if (toTok != null && !t) fail(`--to='${toTok}' is not a time.`);
    const useIso = (f && f.isoMs != null) || (t && t.isoMs != null);
    if (useIso) {
      const lo = f && f.isoMs != null ? f.isoMs : -Infinity;
      const hi = t && t.isoMs != null ? t.isoMs : Infinity;
      rows = filtered.filter(l => { const m = lineIsoMs(l); return m != null && m >= lo && m <= hi; });
      desc = `from ${fromTok || 'start'} to ${toTok || 'end'} (absolute)`;
    } else {
      const lo = f ? f.relSec : -Infinity, hi = t ? t.relSec : Infinity;
      rows = filtered.filter(l => l.relSec != null && l.relSec >= lo && l.relSec <= hi);
      desc = `from [${f ? relativeTime(f.relSec) : '0m 0s'}] to [${t ? relativeTime(t.relSec) : 'end'}]`;
    }
  } else {
    rows = filtered;
  }
  const filters = [
    BOT_FILTER && `bot=${BOT_FILTER}`,
    tags.length && `tag=${tags.join(',')}`,
    level && `level=${level}`,
    grep && `grep=/${grep}/i`,
    desc,
  ].filter(Boolean).join(' · ');
  console.log(`trace_monitor · query · ${path.basename(TRACE_FILE)} · run=${runSel} · ${filters || '(no filter)'} · ${rows.length} line(s)`);
  console.log('(read-only slice — never flags, never wakes)\n');
  for (const l of rows) console.log(l.raw);
  if (rows.length === 0) console.log('(no lines match — widen the window, check --run, or the tag/bot spelling)');
  process.exit(0);
}

// ── Watch mode ───────────────────────────────────────────────────────────────
// Re-reads the trace on a cadence and reports only flags anchored in NEW lines
// (signatures still run over the full story — an episode needs its history).
// A shrinking story means the overseer restarted → treat as a fresh run.
// Heartbeats once a minute prove liveness without adding noise.
function runWatch() {
  const t0 = Date.now();
  let knownLines = null;      // null until the baseline read — history is never "new"
  let reported = new Set();   // `${sig}:${bot}:${idx}` already shown
  let flagged = false;
  console.log(`trace_monitor · watching ${path.basename(TRACE_FILE)} every ${WATCH_INTERVAL_SEC}s (max ${MAX_MINUTES}m)`);

  // Live status field: on a TTY (the Architect watches trace_monitor in its own terminal window)
  // the quiet heartbeat OVERWRITES one status line in place every tick — a live dashboard, not an
  // ever-growing log — and shows ALL bots, not just the first (the "where's Auren?" miss). Off a TTY
  // (fleet_logs/trace.log, no terminal) it stays an append-once-a-minute line so the file doesn't
  // fill with carriage returns. A flag or an exit ends the live line first so nothing clobbers it.
  const TTY = !!process.stdout.isTTY;
  let liveLine = false;
  const endLiveLine = () => { if (liveLine) { process.stdout.write('\n'); liveLine = false; } };

  let lastHeartbeat = Date.now();
  let freezeAt = null;   // newestBotMs already flagged as frozen; cleared when a newer line lands
  let streamedThrough = 0;   // idx up to which --stream lines have already been echoed (0 = none yet)
  const tick = () => {
    const elapsedMin = (Date.now() - t0) / 60000;
    if (elapsedMin >= MAX_MINUTES) {
      endLiveLine();
      console.log(`\nWatch window over (${MAX_MINUTES}m). ${flagged ? 'Flags were raised — see above.' : 'No anomalies.'}`);
      process.exit(flagged ? 2 : 0);
    }
    let lines;
    try {
      lines = readTrace(TRACE_FILE);
    } catch (_) {
      setTimeout(tick, WATCH_INTERVAL_SEC * 1000);   // mid-rename read — next tick wins
      return;
    }
    if (knownLines === null) {
      // Baseline: warnings and the other progress-shaped signatures that predate this
      // watch are old runs already handled — they only count from here on. Errors are the
      // exception (below): a ❌ anywhere in the trace, even below the baseline, wakes us,
      // so a watcher launched INTO an already-crashed fleet fires on its first read instead
      // of baselining the crash away (the Architect's policy, and the 2026-07-07 miss).
      knownLines = lines.length;
      streamedThrough = lines.length;   // stream FORWARD from launch — don't dump pre-watch history
      console.log(`[watch] baseline at line ${knownLines} — errors wake even if already present; other anomalies only from here.`);
      // Hand-off suppression works by seeding `reported` — the SAME dedupe that already stops one episode
      // firing twice — rather than a second counter beside it (Law 16). An episode the caller says it has
      // already seen is simply an episode already reported. Nothing downstream needs to know why.
      if (ERRORS_KNOWN > 0) {
        // FILTER ON WAKE_SIGS, never a restated list. It said `error || halt` until 2026-08-06, which was
        // the complete set on the day it was written — then `death` joined WAKE_SIGS when
        // combat_observer_monitor was deleted, and this line did not move with it. The result was the
        // exact failure this flag exists to prevent, one channel over: `death` is baseline-exempt by
        // design (§5a — a watch armed into an already-dead fleet must fire on its first read), so once
        // ANY death was in the trace every re-armed watch exited within one poll, forever, with the
        // hand-off flag set and doing nothing. Measured live during the 2026-08-06 soak: TessaBot died
        // at [16m 45s], and the re-arm carrying --errors-known=4 woke on that same corpse immediately.
        // Deriving the filter from WAKE_SIGS is what stops a future signature repeating this (Law 16:
        // one definition of "what wakes", read from where it lives, never copied to a second place).
        //
        // NAME vs COVERAGE, flagged rather than settled: the flag now suppresses every WAKING episode,
        // not only errors, so `--errors-known` under-describes it (Law 7). Renaming it touches the
        // runbook §5/§8 and is the Architect's table, not a bug fix — left as-is deliberately.
        const prior = detect(lines).filter(f => WAKE_SIGS.has(f.sig)).slice(0, ERRORS_KNOWN);
        const kinds = [...new Set(prior.map(f => f.sig))].join('/') || 'wake';
        for (const f of prior) reported.add(`${f.sig}:${f.bot}:${f.idx}`);
        console.log(`  the first ${prior.length} waking episode(s) of this trace (${kinds}) are already handed off`
          + `${prior.length < ERRORS_KNOWN ? ` (only ${prior.length} present; asked for ${ERRORS_KNOWN})` : ''}`
          + ' — waking on the next one.');
      }
    } else if (lines.length < knownLines) {
      console.log(`[watch] trace reset (${knownLines} → ${lines.length} lines) — overseer restarted, state cleared.`);
      reported = new Set();
      knownLines = 0;
      streamedThrough = 0;
    }

    // Live decision stream (watch-only): echo every NEW --stream-tagged line as it lands — the running
    // commentary the on-screen trace window used to give (runbook §1), which the heartbeat-only watch
    // had lost. With --stream=dispatcher this is the sequence of task-picks (which bot claimed what,
    // when) = the system's status over time. endLiveLine first so it never clobbers the TTY status
    // field; off a TTY (trace.log) it is the primary between-heartbeat progress signal.
    if (STREAMING && streamedThrough < lines.length) {
      const fresh = [];
      for (let i = streamedThrough; i < lines.length; i++) {
        if (streamMatch(lines[i].raw)) fresh.push(lines[i].raw);
      }
      streamedThrough = lines.length;
      if (fresh.length) { endLiveLine(); for (const r of fresh) console.log(r); }
    }
    // Total-freeze arm of the silence signature (wall-clock, watch-only). sigSilence is RELATIVE —
    // it needs SOME bot still logging to notice another went quiet, so a WHOLE-fleet freeze (every
    // bot hung at once — AurenBot's silent-hang fingerprint) advances nothing and slips past it
    // forever, leaving file mtime (which the watcher's timer-refresh keeps bumping) as the only,
    // lying, "alive" signal. Here we measure the newest bot line's ABSOLUTE time against the wall
    // clock. Fires once per episode (re-armed when a newer line lands); exempt before any bot logs.
    // Sourced from the PER-BOT files, not the merged trace. The merged stream writes bot lines as
    // `[Nm Ss] [Bot] ...` with NO absolute stamp (only the overseer's own lines carry an ISO), so
    // `l.iso` was null for every bot line here, botLines came out empty, and this whole detector was
    // unreachable against the default trace file. It never fired once. Proven 2026-07-20: the fleet
    // died at 13:13:33Z — server, overseer and both bots, no error logged — and the watch ran another
    // 4 minutes printing `quiet` and exited 0 with "No anomalies." A watch that reports clean over a
    // dead fleet is worse than no watch (Law 25: a success signal that can lie makes every honest one
    // worthless). readBotHeartbeats reads lastStoryAt, which is a real ISO, from each bot's own file.
    const hb = readBotHeartbeats();
    let newestBotMs = null;
    for (const h of hb.values()) newestBotMs = Math.max(newestBotMs ?? 0, h.at.getTime());
    if (newestBotMs === null) {
      const botLines = lines.filter(l => l.bot && !OVERSEER_UNITS.has(l.bot) && l.iso);
      newestBotMs = botLines.length ? botLines.reduce((mx, l) => Math.max(mx, Date.parse(l.iso)), 0) : null;
    }
    if (newestBotMs && Date.now() - newestBotMs > SILENCE_GAP_SEC * 1000) {
      if (freezeAt !== newestBotMs) {
        freezeAt = newestBotMs;
        const lagSec = Math.round((Date.now() - newestBotMs) / 1000);
        endLiveLine();
        console.log(`\n❌ [watch] FLEET FROZEN — no bot has logged for ${lagSec}s (last bot line ${new Date(newestBotMs).toISOString()}). No error was raised: this is the silent-hang fingerprint.`);
        flagged = true;
        // The freeze detector is not one of the `detect` signatures, so it has no `sig` to match. It
        // rides with `error`: the line it just printed IS a ❌, and a fleet that has stopped logging
        // entirely is the same class of thing as a crash to anyone deciding whether to keep running.
        if (EXIT_ON_FLAG && EXIT_ON_SIGS.has('error')) {
          console.log('[watch] wake-worthy anomaly (silence/total-freeze) — exiting for handoff.');
          process.exit(EXIT_EARLY_CODE);
        }
      }
    } else if (newestBotMs) {
      freezeAt = null;   // a fresh bot line landed — fleet is alive, re-arm
    }

    // Errors, judge-halts and deaths always wake (any idx) — a ❌ crash, a bot parked inert for
    // inspection, or a corpse is worth waking to even if it predates this watch (a watcher launched into
    // an already-broken fleet must fire, not baseline the damage away). Every other signature stays
    // baseline-relative (new lines only). `reported` still dedupes, so each distinct episode fires once.
    const news = detect(lines)
      .filter(f => f.sig === 'error' || f.sig === 'halt' || f.sig === 'death' || f.idx >= knownLines)
      .filter(f => !reported.has(`${f.sig}:${f.bot}:${f.idx}`));
    knownLines = lines.length;
    for (const f of news) reported.add(`${f.sig}:${f.bot}:${f.idx}`);
    if (news.length > 0) {
      // Print everything for visibility (this is also what the live tracer shows), but only a
      // WAKE-worthy signature trips a handoff. Warnings (warn-repeat/warn-burst) are OK to sleep
      // through per the Architect's policy (2026-07-07): they surface here but never wake. Errors
      // and the intervention-worthy inferred conditions do (see WAKE_SIGS).
      endLiveLine();
      // A --follow console suppresses the flag BLOCKS but not the flagging. Each block reprints up to
      // 80 lines of surrounding context, and under --follow every one of those lines is already
      // scrolling past on its own — so the blocks are pure duplication, and enough of them (19 in the
      // first thirty seconds of a live fleet) bury the story the window exists to show. `flagged`,
      // WAKE_SIGS and --exit-on-flag all still work below, unchanged: what is dropped is the redundant
      // rendering, never the detection (Law 25 - a quieter report must not become a less truthful one).
      // `--flags` restores them for anyone who wants both in one window.
      if (!FOLLOW || has('flags')) printFlags(lines, news);
      const wake = news.filter(f => WAKE_SIGS.has(f.sig));
      if (wake.length > 0) {
        // `flagged` is set by ANY wake signature, whether or not it may end the watch. A death that
        // rides out the window must still make the run report as flagged — the narrowing decides what
        // stops the watch, never what the watch admits it saw (Law 25).
        flagged = true;
        const enders = wake.filter(f => EXIT_ON_SIGS.has(f.sig));
        if (EXIT_ON_FLAG && enders.length > 0) {
          console.log(`\n[watch] wake-worthy anomaly (${[...new Set(enders.map(f => f.sig))].join(', ')}) — exiting for handoff.`);
          process.exit(EXIT_EARLY_CODE);
        }
      }
    } else {
      // Quiet: refresh the all-bots status field (watchStatus). TTY overwrites in place every tick; a
      // file appends at most once a minute. On a TTY it is CUT TO THE TERMINAL'S WIDTH, because the
      // overwrite clears only the row the cursor is on — a line that wraps leaves its tail behind.
      const status = watchStatus(lines, elapsedMin);
      if (TTY) {
        const width = process.stdout.columns || 0;
        const fit = width && status.length >= width ? `${status.slice(0, width - 2)}…` : status;
        process.stdout.write('\r\x1b[2K' + fit);
        liveLine = true;
      } else if (Date.now() - lastHeartbeat >= 60000) {
        lastHeartbeat = Date.now();
        console.log(status);
      }
    }
    setTimeout(tick, WATCH_INTERVAL_SEC * 1000);
  };
  tick();
}

// The guard is load-bearing, not decorative: this file process.exit()s in every lens, so without it a
// require() from dashboard.js or footage_clipper.js would run a CLI pass and abort the caller.
// It lives OUTSIDE the fragment tree preflight scans — a read-only observer of the
// construct, not a part of it.
// Read the trace and hand back the LATEST run's lines. Every extracted lens used to do this itself, in
// eight identical copies with eight identical error strings; the seam moved it here because the lens now
// receives lines rather than a filename (Law 16 — one pathway for "which run are we looking at").
function latestSegment() {
  const segs = segmentRuns(wholeTrace());
  return segs[segs.length - 1] || [];
}

// The same read, unsegmented. Split out for --narration, which must be able to state how much of a unit's
// output falls OUTSIDE the run window rather than silently showing a subset — a unit that comes up before
// the `start` broadcast has its whole bring-up in an earlier segment.
// ── ASKING FOR A CAMERA BY NAME IS ASKING FOR THE OTHER VIEW ────────────────────────────────────
// `trace_read` keeps the camera streams out of the fleet view on purpose, so a reader typing
// `--narration --bot=camera_rig` against the default trace would get a clean, confident EMPTY report about
// a unit that spoke ten thousand lines (Law 25 — the falsehood is the empty answer, not the missing file).
// Naming a camera unit IS the statement of which record is wanted, so the CLI opens that one. It stays in
// the CLI because choosing the file is the CLI's job and no lens's; and it is keyed on the `camera_`
// filename prefix rather than a roster, so a new camera process needs no edit here.
//
// Overridden by a positional path, always: a reader who names a file has already answered this question.
const wantsCameraView = () => !args.some(a => !a.startsWith('--'))
  && !!BOT_FILTER && String(BOT_FILTER).toLowerCase().startsWith('camera_');

// What a rendered header must call the record it read. A lens that prints `watcher_overseer.jsonl` over
// lines that came out of the camera view has given the reader a return address that does not lead back
// to the material (Law 24 — the report is a translation, and a wrong source name breaks it).
const traceLabel = () => (wantsCameraView() ? 'watcher_camera_*.jsonl' : path.basename(TRACE_FILE));

function wholeTrace() {
  try {
    if (wantsCameraView()) return readCameraView(path.dirname(DEFAULT_TRACE_FILE));
    return readTrace(TRACE_FILE);
  } catch (e) {
    console.error(`trace_monitor: cannot read trace — ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  // The extracted lenses RETURN (they are libraries now), so the exit is the CLI's to make and each
  // branch below owns it. A lens that exited would kill any caller that ever imports it.
  const lensOpts = () => ({ seg: latestSegment(), traceName: traceLabel(), bot: BOT_FILTER });
  const runLens = (fn, extra = {}) => { fn({ ...lensOpts(), ...extra }); process.exit(0); };
  const verbose = has('all');

  // --last first: it reads only the per-bot watcher files, so it answers "is this bot alive?" even when
  // the merged trace is absent, empty, or lagging — precisely the conditions that make the question urgent.
  if (LASTPOST) { for (const l of lastPostLines()) console.log(l); process.exit(0); }
  else if (STORY) runStory();
  else if (PROGRESS) runProgress();
  else if (PATHFINDING) runLens(locomotionLenses.runPathfinding);
  else if (ROUTECOST) runLens(locomotionLenses.runRouteCost, { over: parseInt(opt('over', '60'), 10) || 60 });
  else if (JUMPS) runLens(locomotionLenses.runJumps);
  else if (MILESTONES) runLens(buildLenses.runMilestones, { deadlineSec: MS_DEADLINE_SEC, verbose });
  else if (TORCH) runLens(buildLenses.runTorchClock, { deadlineSec: MS_DEADLINE_SEC });
  else if (JOBS) runLens(require('./job_timeline_lens').runJobTimeline, { verbose });
  // The lens takes its inputs as arguments; reading --bot/--all is the CLI's job, not the lens's.
  else if (WITNESS) { recordingLens('combat_witness_lens', '--witness').runWitness({ bot: BOT_FILTER, verbose }); process.exit(0); }
  else if (CAMERA) { recordingLens('camera_lens', '--camera').runCamera({ bot: BOT_FILTER, verbose }); process.exit(0); }
  else if (FOREMAN) { require('./foreman_lens').runForeman({ bot: BOT_FILTER, verbose }); process.exit(0); }
  else if (MACHINE_LOAD) { recordingLens('machine_load_lens', '--machine-load').runMachineLoad({ label: opt('label', null) }); process.exit(0); }
  else if (NARRATION) {
    const all = wholeTrace();
    require('./narration_lens').runNarration({
      seg: NARRATION_FULL ? all : latestSegment(),
      allLines: all, bot: BOT_FILTER, traceName: traceLabel(),
      verbose, full: NARRATION_FULL,
    });
    process.exit(0);
  }
  else if (COMPOST) runLens(chainLenses.runCompost, { verbose });
  else if (INVENTORY) runLens(require('./inventory_lens').runInventory, { verbose });
  else if (ENGAGEMENT) runLens(require('./engagement_lens').runEngagement, { verbose });
  else if (ACTIVITY) runActivity();
  else if (WATCH) runWatch();       // live: a future has no "after", so watch wins over a query slice
  else if (QUERY) runQuery();
  else runOnce();
}


// Read-only observer surface for monitoring/dashboard.js (the merged human panel). Exporting these does
// NOT re-run the CLI — the require.main guard above keeps it inert when required. The dashboard reuses
// the SAME trace parse + per-bot count + halt signature rather than re-deriving them (Law 16).
// What this file exports is now only what this file OWNS: the signatures and the per-bot vitals. The
// substrate (readTrace/segmentRuns/buildEpisodes/jobToken) is required from ./trace_read directly and
// the combat reducer from ./combat_lens — re-exporting them here would rebuild the exact hub the split
// removed, and importers would still be loading a triage CLI to reach a parser (Law 16).
module.exports = { detect, computeBotStats, sigJudgeHalt, SIGNATURES, WAKE_SIGS, isDeathClass };
