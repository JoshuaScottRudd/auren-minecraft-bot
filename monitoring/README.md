# `Auren_Bot/monitoring/` — the instruments that READ

> *"lets move trace monitor out of tool folder into its own monitoring folder and split it up according to
> your recommendation. next move all monitoring files into the monitoring folder and tools are to be for
> bench testing the system."* — Architect, 2026-08-07

> *"either you take the watcher trace out and inspect it outside of the project or bring trace monitor in
> and just let it sit next to everything unused unless its necessary. i think we should bring
> troubleshooting items into the public repo so other people can use it. but keep the recording parts
> out."* — Architect, 2026-09-10

## WHY THIS FOLDER IS SEPARATE FROM THE WORKSHOP'S OTHER THREE LENSES

**The lens stack lives inside the bot so the person running the bot can diagnose their own run.** Before
2026-09-10 it sat in `Auren_Workshop/`, a sibling folder that never left the Architect's machine — meaning
a stranger whose fleet froze had a 90,000-line trace and no reader for it, and the only support channel
was sending the file to him. The instruments are the support channel now.

**SHIPPING IS NO LONGER WHAT THIS SPLIT IS ABOUT.** Later the same day the workshop itself moved inside
the bot (*"i should just ship the whole thing as one piece and hand people scripts to run the thing
instead of hiding it from them"*), so `Auren_Workshop/monitoring/` is in a download too. What survives is
the useful half of the rule: **WHICH RECORD each lens reads** — which is what keeps the readers of one
record set together, and it was always the mechanical test rather than a judgement about which lenses are
worth having.

| the record it reads | where the lens lives |
|---|---|
| a bot's own trace — `fleet_logs/traces/watcher_*.jsonl`, the foreman's record, the boardroom | **here** |
| the CAMERA STACK's records — `fleet_logs/combat_witness/`, `fleet_logs/machine_load/`, the rig's vantage events | `Auren_Workshop/monitoring/` |

Three lenses sit on the other side of that test — `camera_lens`, `combat_witness_lens`,
`machine_load_lens`. **`trace_monitor` is still the one entry point for all of them** (Law 16):
`--camera`, `--witness` and `--machine-load` resolve the workshop's folder at the moment the flag is used.
**The absent branch is kept even though the workshop now ships**, because nothing guarantees a copy of
this folder still has the workshop beside it — somebody may vendor `monitoring/` alone, or strip the
camera stack — and one sentence naming what is missing beats `MODULE_NOT_FOUND` thrown at a person who
typed a flag the help text offered them (Law 13). See `recordingLens()` in `trace_monitor.js` and
`recordingLensDir()` in `lens_paths.js`.

**Nothing in the fleet's runtime requires this folder, and nothing here may ever be required by it.** The
dependency runs one way — the lens reads the bot, the bot never reads the lens. That is what lets these
files carry ordinary hand-written `try` blocks: they are read-only observers outside the construct, so
`preflight`'s one-`try` gate does not scope to them, and `monitoring` is deliberately absent from its
`LAYERS` list (the reason is written there).

**Two indexes, and this is the MODULE one.** This page says what each file is and holds the rules that
keep the folder honest. **[`LENSES.md`](LENSES.md) is the FLAG index** — every question these instruments
answer and the flag that answers it, with copy-paste commands. Go there to investigate a run; stay here to
change an instrument. The catalogue lives in this folder rather than in `Architect_Commands.txt` because
the Architect does not run lenses — he asks, and the AI developer runs them (2026-08-22).

## A RECORD IS READ ONLY THROUGH ITS LENS (Architect 2026-08-02, STANDING)

**Never open a run record directly** — not with Read, `cat`, `grep`, or `JSON.parse`; not "just to check
the shape"; not because the question seems too small to justify a flag. These files are tens of thousands
of lines *by design*, precisely because a deterministic reader answers questions about them. Reading one
by hand burns the context that was supposed to hold the answer, and produces a result nobody can
reproduce. Each record has exactly one reader, and the table below is that pairing.

**If a lens cannot answer your question, that is a defect in the lens.** Add the flag, fix the reducer,
then ask again — do not bypass it, and do not build a throwaway reader beside it (Law 16: instruments are
kept and extended; grep is not rewritten per search). The instrument is the deliverable: a hand-read
answer dies with the session, while a flag is available to everyone after — including the Architect, who
does not read raw either. The same rule aimed at a machine caller is rule 2 of *The monitor is the
interface*, below.

**No reader spells a record's path.** `js_kernel/utils/record_homes` answers it, and every writer and lens
asks — so the day a directory moves, nothing that reads goes hunting.

## The line between this folder and a bench

**Monitoring READS a record and reports what happened. A bench DRIVES the system to make one.**

Nothing in here connects a bot, sends an RCON command, summons a mob, or changes a world. If a file needs
a live server to do its job, it is a bench and belongs in `Auren_Workshop/tools/`. If it needs only a file
that a run already wrote, it belongs here.

The test that settles a borderline case: **could it run on a laptop with no Minecraft installed?** Every
file in this folder can. Nothing in the `lanista*`, `raycast_crucible`, `locomotion_course` or
`*_bench`/`*_probe` family can. **Both folders ship as of 2026-09-10** — so this line decides which
folder a new file goes in, and it no longer decides who is allowed to see it.

## What is here

> **NO INSTRUMENT HERE KEEPS A RECORD ACROSS RUNS** (Architect 2026-08-31: *"all data is overwritten at
> the beginning of a run no exception"*). `feature_metrics.js` (an A/B series) and `ladder_ledger.js`
> (one row per ladder trial, kept forever) were both deleted on that ruling, and the reason is the same
> one twice: the fleet changes between runs, so two rows written a week apart did not measure the same
> system, and comparing them reads as evidence while being none (Invariant B). Long-term memory is a
> **markdown holding the interpretation** a person drew from a run — never the raw rows. An instrument
> that finds itself wanting to save a file for next time is asking for the write-up instead.
>
> `run_report.js` was the third and went the same way, with the `CAPTURE` step of `test_conductor`
> that ran it. It snapshotted a finished run so the NEXT one could diff against it — the same shape
> wearing a different name.

| file | reads | reports |
|---|---|---|
| `trace_monitor.js` | `fleet_logs/traces/watcher_*.jsonl` | **the triage CLI** — signatures, digest, wake policy, watch, query, story, progress. Owns the flags; reads the trace once and hands the run down to the lenses below |
| `trace_read.js` | — | **the substrate.** Parse a line, read a trace, split it into runs, group lines into job episodes. Judges nothing. |
| `combat_lens.js` | `fleet_logs/traces/watcher_*.jsonl` | **the fight's beats off the bot's own trace** — who is armed, who is engaged, which battles closed and whether the bot ever connected. Has no CLI door of its own: it exists for MACHINE callers (`watchState()` for `lanista`, `completedBattlesSince()`, `crewEvents()` for `combat_witness_lens`) and for the cutting room's fight spans. It was 1,998 lines reading a separate combat journal until 2026-08-22 |
| `engagement_lens.js` | a run's lines | **the fight as a story** — one mob from aggro to off-the-board, joined out of the three crew seats' event streams (`--engagement`). Decodes lines through `custom_api/crew_log.parse`, the same grammar module the seats emit through; it carries **no regexes of its own** for those lines, because a second copy of the grammar drifts the first time a field is added. Exports `reduceEngagements()` for machine callers beside the rendered `runEngagement()` |
| `chain_lenses.js` | a run's lines | did a multi-owner chain close — `--compost` |
| `build_lenses.js` | a run's lines | when establishment happened — the first-occurrence clocks. `--milestones` times the build sites (site lock → anchor gate → first placement → anchor complete); `--torch` times the fleet's first torch craft and, when there was none, the order that asked for it and every gate that held it. Two flags in one file because the verb is one: when did this first happen, and what was it waiting on |
| `job_timeline_lens.js` | a run's lines | **the run as a sequence of jobs** — every claim in order with its duration, the gaps between them, and where the run's time went by job type (`--jobs`). Added nothing to the watcher: both ends of a job were already summary lines, so it extended `buildEpisodes` and did the arithmetic. Exports `reduceJobTimeline()` for machine callers beside the rendered `runJobTimeline()` |
| `locomotion_lenses.js` | a run's lines | what walking cost — `--pathfinding`, `--route-cost`, `--jumps` |
| `narration_lens.js` | a run's lines | **what one unit SAID, in order** (`--narration --bot=<unit>`; no `--bot` lists who posted). The only lens here that is not a fold — every other one measures something and discards the rest, so a unit whose output is prose rather than events (a director narrating its cuts, a preflight narrating what it verified) could be *counted* by the merged view and *shown* by nothing. **It states its window instead of applying it silently:** the trace segments on the overseer's `start` broadcast, so anything that comes up before the fleet thinks has its whole bring-up in an earlier segment — the render reports how many lines fall outside and `--full` includes them (Law 25 — a subset presented as the whole is a false verdict with a clean exit) |

| `dashboard.js` | the trace + HQ | `fleet_logs/traces/dashboard.json`, overwritten live — the Architect's own panel |
| `progress_tracker.js` | `corporate_headquarters*.json` | what the bots have completed, standing and cumulative |
| `motion_classifier.js` | the trace | moving-vs-doing spans, consumed by the footage clipper |
| `report_formatting.js` | — | the summary statistic every lens computes, and the renderers that put it on a line |
| `command_line_arguments.js` | — | the flag reader. One implementation, taking argv as an argument rather than reading it |

## THE MONITOR IS THE INTERFACE (Architect 2026-08-07 — stamped)

> *"so now raw data is read through a monitor and interpreted by a deterministic system which then reports
> to you. i like it. stamp it. i didnt think of that. if you can read what the trace monitor or combat
> monitor says then why cant a deterministic system like a javascript file. that makes me excited making
> things recursive like that. its another layer of automation we can add."*

**A monitor's reader may be a machine, not only a mind. Same file, same lens, same pairing rule.**

Everything in this folder was written for a person triaging a run. Nothing about that was ever a
requirement — it was an assumption about who happened to be standing on the far side. `combat_lens.js`
now exports `completedBattlesSince()`, which `tools/lanista.js` calls to learn when the bot finished a
battle. The bench got an answer it could not otherwise have, and **no second reader was built.**

**Why this is Law 26 and not a new idea — the return address.** A raw record is machine output: valid
form, no interpretation. A consumer parsing it directly is the illegal joint — two systems with nothing
between them. The monitor *is* the translator machine that law calls for: it throws on bad form (a torn
row is skipped, never defaulted) and reads real recorded state rather than guessing. What changed is only
**who stands on the far side**. It used to be a mind. It can be a machine, and when it is, the interface
is already built and already the sanctioned one.

**What it buys, and why it compounds.** A lens is written once and answers for every consumer after —
human or program. The bench that wanted "did a battle finish" did not have to know the trace's line
format, its `crew_log` grammar, or which verdict counts as a kill. It asked. That is the layer of
automation he is pointing at: the interpretation is paid for once and reused, so each new consumer costs
a call instead of a parser.

**Two rules keep it honest:**

1. **A machine-facing lens RETURNS; a human-facing one renders.** `runEngagement({...})` prints and
   returns a count. `completedBattlesSince(...)` returns data and prints nothing. Never the same function doing both,
   and neither may `process.exit`.
2. **A caller that wants a different question answered ADDS A LENS HERE.** It does not read the record
   itself "just this once." Identical to the rule the human side has always had: *if the monitor cannot
   answer, that is a defect in the monitor.*

**The one cost, paid explicitly.** A lens reading a record written by another process restates that
process's vocabulary — `combat_lens.KILL_VERDICT` says what `battle_stations.bucketRetirement` decided.
They cannot share code (the gate needs the `@kernel` graph; this folder must run with no Minecraft
installed), so the rule exists twice. That is a Law 16 hazard, and as of **2026-08-10 it is unguarded**.
It used to be pinned by a bench that read both source files and failed if they stopped agreeing; that
bench is deleted with all the others, and nothing can cheaply replace it — a load-time throw cannot see
across the process boundary, and no pass of `preflight` can compare two strings in two files. **If you
edit `bucketRetirement` or `KILL_VERDICT`, edit the other in the same commit.** It is the fleet's one
live claim with no enforcement.

## The rule that keeps the split from collapsing back

**`trace_read.js` may not know what a problem is.** The moment a threshold, a signature or a wake policy
appears in it, it is a monitor with four importers again and the split has bought nothing. Judgment lives
in `trace_monitor.js`; formatting in `report_formatting.js`; flag parsing in `command_line_arguments.js`.

**A lens takes arguments; only a CLI reads `process.argv`.** `combat_lens.runCombat({ bot, verbose })` is
the shape. A module that reads argv on require poisons every importer — a bench that borrows one function
inherits the lens's flag vocabulary, and `--all` typed for the bench silently changes what the lens does.
That was the actual defect: `combat_ledger` had to load a 3,185-line triage CLI, argv block and all, to
obtain two functions about combat journals. *(Both that module and those journals were deleted 2026-08-22
— the example is kept because the coupling it names is the rule, not the incident.)*

**A library returns; it does not `process.exit`.** An exiting library kills its caller mid-run.

## Where this came from

`trace_monitor.js` was **3,185 lines carrying seventeen verbs**. The audit that preceded this split found
the comments were *not* the problem — 29% density, zero duplicates, zero TODOs, zero status-rotted lines —
so nothing was compacted (Law 14: *"size is a review prompt, never a cut mandate; a long file of
all-necessary WHY may stay long"*). The size was the lens count.

Three cuts, ranked by what they bought:

1. **`combat_lens.js` (842 lines)** — read a different file family entirely and touched none of the trace
   substrate. Two lines of real coupling.
2. **`trace_read.js` (~175 lines)** — four tools already imported exactly this set from the triage CLI.
   This was the real Law 16 violation: a substrate with four consumers and no home.
3. **`report_formatting.js` + `command_line_arguments.js`** — the same formatters and flag parser were
   re-typed in three tools apiece, and only one copy of `opt()` handled a value containing `=`.

*(Naming note: the last two were first written as `fmt.js` and `cli_args.js`. The Architect rejected both
on sight — Law 7 admits no abbreviations. Recorded because a shared utility module is exactly where a
short name feels harmless.)*

**The second pass (2026-08-08).** The Architect asked the same question a volume later — *"wana audit all
files above 1k for me?"* — and the answer had changed, because the first pass created the thing that made
the second one legal. `feature_metrics.js`'s own header had argued it must live inside `trace_monitor`
to avoid a second copy of `readTrace`; extracting `trace_read.js` the day before **expired that argument**,
and nothing noticed. Four more lens files came out on that seam (`feature_metrics`, `chain_lenses`,
`build_lenses`, `locomotion_lenses`), plus `--knockback` moving to sit beside the calibration it renders
(that flag and its meter are gone since 2026-08-22; the seam it moved along is the point here).

Again **no comment was cut** — a second measurement over the remaining 2,228 lines found zero TODOs and
zero status-rotted lines, same as the first. `trace_monitor.js` is now **1,222 lines / 729 of code**, and
what is left is one verb: *find what went wrong in a run.* No file in this folder exceeds 1,000 lines of
code.

**The lesson worth keeping:** a WHY that names its own condition (*"this lives here because the substrate
has no home"*) becomes a **standing invitation to re-audit** the moment that condition changes. The first
extraction did not just move code — it silently invalidated a justification four hundred lines away.
Nothing detects that but asking again.

## The 2026-08-22 deletion: three instruments, one record too many

**`combat_ledger.js` and `entity_dossier_lens.js` are gone, `combat_lens.js` was rewritten from 1,998
lines to 281, and `trace_monitor` lost `--combat`, `--knockback` and `--entities`.** What went with them
is the record they all read: `fleet_logs/combat_journal/*.jsonl`, `js_kernel/combat_ledger.json`, and the
`knockback_meter` / `repel_calculator` pair that fed the calibration.

**The reason is a rule about records, not about combat.** The bot was writing itself down twice — prose
and warnings to the watcher trace, decisions to a separate journal — and two accounts by the same author
are not two sources of truth. One record per author is the Law 16 form of it: one capability, one
implementation, one route. The beats that a reader actually acts on now ride the trace as `crew_log`
lines (`sentry`, `engage`, `end`, `wave`, `hurt`, `blast`, `death`, `declined`), read by `--engagement`.

**What a successor must NOT do is rebuild any of the three against the trace.** They were not lost for
want of a port — the resolution they carried is illegal on a trace by Law 5. A journal row per swing,
per pass and per gate is exactly the per-tick cadence the three persisted levels exclude, so a faithful
port would be a Law 5 violation with a familiar name on it. Cadence is the whole test: a STATE CHANGE
(the bot engaged, the wave closed) belongs on the trace; a per-blow sample does not, and a number that
needs many blows to mean anything has no home here at all.

**Named costs, so a gap is read as a decision rather than a defect:** per-swing resolution is gone
permanently (range bands, decide→swing latency, the approach leg from take to first blow); the per-pass
decline census and its cylinder geometry are gone — `declined` posts only when the REASON changes; the
cross-run TTK population and the knockback/fuse calibrations are retired, and `SWELL_RESET_DISTANCE`
stands on its source read alone. `--witness` still cross-reads, now at fight-span rather than per-strike
resolution.
