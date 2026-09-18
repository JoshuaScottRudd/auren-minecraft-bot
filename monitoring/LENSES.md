# The lenses — every question this folder answers, and the flag that answers it

**Audience: whoever is diagnosing a run — the AI developer, or the person who downloaded this bot and
watched it stop.** This is the FLAG index. `README.md` beside it is the MODULE index (what each file is,
and the rules that keep the folder honest) — two lookups on the same instruments, kept apart because
"which file owns this" and "which flag answers my question" are different questions.

The Architect does not run lenses himself: *"those are technical tools for you to investigate problems.
i wont use them im an architect. ill ask you to investigate."* One-button scripts that MAKE a run are
his; this page holds the flags that READ one. When he asks a question about a run, the answer comes from
here.

Every lens is **one command**, **read-only**, and needs **no server running**:

```
node .\Auren_Bot\monitoring\trace_monitor.js <flag>
```

**WHY THE MONITOR AND NOT THE FILE.** A trace is tens of thousands of lines by design, because a
deterministic reader answers questions about it. Reading one by hand burns the context that was supposed
to hold the answer and produces a result nobody can reproduce. Each record has exactly one reader, and
the table in `README.md` beside this page is that pairing.

**IF A LENS CANNOT ANSWER THE QUESTION, THAT IS A DEFECT IN THE LENS.** Add the flag, fix the reducer,
ask again. Do not open the raw file and do not build a throwaway reader beside it (Law 16).

**No `--help`, and an unrecognised flag is not refused** — it falls through to the default digest. A
digest where a lens was expected means the flag was misspelled.

**THREE FLAGS READ THE CAMERA STACK'S RECORDS, NOT A BOT'S TRACE: `--camera`, `--witness`,
`--machine-load`.** Their lenses live in `Auren_Workshop/monitoring/`, which ships with everything else as
of 2026-09-10 — so these flags work here too, on a machine that actually films. What they cannot do is
report on a run nothing filmed, and there they answer with one sentence saying so rather than an empty
table. `trace_monitor` is the one way to reach them either way. Every other flag on this page reads a
record the bot wrote about itself and needs no camera at all.

---

## Start here — the two used most

| flag | question |
|---|---|
| *(none)* | **The digest + anomalies.** One line per bot, then every problem detected — errors, stuck loops, silences, warn bursts — each with the offending line and its context. Exit `0` = clean, `2` = problems found, `1` = the trace could not be read at all. |
| `--jobs` | **The whole run in order, with durations.** Three blocks: THE FLEET IN ORDER (every claim in sequence with duration, verdict, and `(between jobs)` gaps), WHERE THE TIME WENT (per job type: claims, total, mean, worst, share), PER BOT (working vs idle, longest single job). The build-speed view. |

```
node .\Auren_Bot\monitoring\trace_monitor.js
node .\Auren_Bot\monitoring\trace_monitor.js --jobs
node .\Auren_Bot\monitoring\trace_monitor.js --jobs --bot=AurenBot
node .\Auren_Bot\monitoring\trace_monitor.js --jobs --all       # every type, not the top 14
```

**`--jobs` will not say a job was too slow, and never will.** It carries no threshold. What counts as too
long is the asker's number, not the monitor's (Law 25 — the criterion belongs to whoever the answer is
for). A criterion is legal only where it was supplied — `--deadline=`, which `--milestones` and `--torch`
both read and neither invents.

---

## The run as a story

| flag | question |
|---|---|
| `--activity` | **The decision play-by-play.** Each bot's job board, the job it picked, how that job ended. No problem-hunting — just what happened, in order. |
| `--story` | **The narrated version, one block per job.** PLAN (the board + what the dispatcher claimed) → DOING (what it did, warns/errors included, repeats folded to `xN`) → VERDICT (COMPLETE / STUCK / KILLED). Clean jobs collapse to a line, so the ones that fought stand out. |
| `--progress` | **What the fleet has completed** — standing and cumulative, out of the bots' own records. |
| `--inventory` | **Where every item IS** — last-known location per item and every move between containers. |

Both `--activity` and `--story` take `--bot=<name>`.

---

## Building and the clock

| flag | question |
|---|---|
| `--milestones` | **When things were established.** Opens with the **HEADFRAME CLOCK**: the start command (first crew `🧪 Injected autonomous start signal`) → first `🏁 STRUCTURE BUILT: 'headframe'`, graded GREEN / OK / LATE / ALERT against his dawn-to-dusk bands in `architect_config.HEADFRAME_CLOCK` (with the reason printed beside it). `run.js` prints the grade at the end — a grade only, never a pass/fail. Then the first-occurrence clock per site: sited, locked, shell closed, farm planted. **Takes a criterion** — `--deadline=10m` is the asker's number, so it is allowed to say pass/fail. |
| `--farm` | **How the wheat field went, as one structure** (also printed at the end of `--milestones`). Rows sited → every gate that held a farm job → headframe built → first farm claim → first block placed → **each row laid, in order, with the gap between rows** → first ground tilled → first crop in the ground → first mature → first harvest → **FARM BUILT** (or NOT YET with the latest count) → any UN-BUILT. Then the latest census (rows laid, structure placed/total, crop cells growing/mature/tilled unsown/untilled/blocked, peaks), a per-row table, work done (placed, dug, cleared, tilled, planted, harvested, bonemealed, refused; per bot; per row with `--all`), cluster visits (worked, refused, STUCK), jobs claimed, seed trips (seeds per punch, outcomes, chest pulls, latest order), the dirt order and the hoe. Reads farming_integrity's `farm census` + `rows:` lines and farm_executor's per-row tend line. One fleet clock (wall time), so gaps between two bots' events are true. |
| `--torch` | **When the first torch was crafted** — and when none was, what held it: the order on the board (priority and size), every gate that named a torch job with its shortfall, and the **handoff** when one gate opened and a different one closed behind it. Takes the same `--deadline`. |

```
node .\Auren_Bot\monitoring\trace_monitor.js --milestones --deadline=10m
node .\Auren_Bot\monitoring\trace_monitor.js --torch
node .\Auren_Bot\monitoring\trace_monitor.js --torch --deadline=10m
```

**Why the torch gets a clock and no other item does.** The torch chain is the one supply chain that can
close a circle on itself — a torch needs charcoal, charcoal comes off the furnace chain, and the descent
that would fetch the fuel is itself gated on holding torches. A run where no torch is ever crafted
therefore raises nothing: no error, no stall, just a board row that is gated every sweep. **The gate
handoff is the line to read** — one gate opening and another closing behind it is what separates "the
fix did nothing" from "the fix worked and something else stopped it", and a gate count cannot tell those
apart. Neither the craft target (`have=4/12`) nor the order size (`need:12`) is judged; both are printed
verbatim, because what they *should* be is the asker's question (Law 25).

---

## Walking

| flag | question |
|---|---|
| `--pathfinding` | **What walking cost.** A* calls, nodes searched, time spent, slow-nav tripwires. Read this when a run feels slow and `--jobs` blames travel. |
| `--route-cost` | **What routes PRICED** — the per-search path line, the only one carrying cost. |
| `--jumps` | **The jump clearance arithmetic** — whether the planned window matched the sensed speed. Needs climbing terrain to have anything to say, and reports NOT YET ANSWERABLE rather than inventing a verdict. |

---

## Eating

| flag | question |
|---|---|
| `--hunger` | **What the run cost in FOOD, and what feeding that pace forever takes.** Prices the run in Minecraft EXHAUSTION — blocks broken, jumps pressed, metres swum, damage taken, health regenerated — then converts the rate into loaves of bread and wheat plots. Every constant it multiplies by is printed as its own field, so the arithmetic is checkable rather than assertable. |

**Read this one knowing hunger is not a clock.** Minecraft charges for ACTS, never for elapsed time, and
**walking is priced at zero** — so the moving/doing split at the top of this lens's output (borrowed from
`motion_classifier`, which owns that definition) answers *where the run went* and says nothing about what
it cost. Measured on the 2026-09-16 green run: the fleet walked ~3,600 cells per bot for **0.00**
exhaustion while ~300 jump presses carried **91%** of the bill. A jump costs ten times a block break.

**The jump census is the number to check first if the answer ever looks wrong**, because it is almost all
of the total and it is assembled from three sources rather than one — the navigator publishes
`prejump(s)` per trip, but `scaffold_movement.pillarStep` holds jump for one crest per block it places,
so every pillar step and every shaft seal-climb is a press nothing else counts. Missing them undercounted
the first cut of this lens by a fifth. `jumps_by_source` is that split, and `jumps_uninstrumented` names
the presses no line publishes at all.

---

## Fighting

| flag | question |
|---|---|
| `--engagement` | **One fight as a story** — a single mob from aggro to off-the-board, joined out of the three crew seats' event streams on the bot's own trace. Since 2026-08-22 this is the primary combat lens. |
| `--witness` | **An outside observer's account of the same fights.** Written by the camera's scout client when `camera_configure.mode.witness` is on (OFF by default, and its join to the bot's record is currently broken — see the config note). Its purpose is to CONTRADICT the bot's own trace, never to replace it. |

**`--combat` and `--knockback` no longer exist.** They read `fleet_logs/combat_journal/`, which was
deleted 2026-08-22 along with `combat_ledger`, `entity_dossier_lens` and `repel_calculator` — two diaries
by the same author are not two sources of truth. The beats that survived are `crew_log` lines on the
bot's own trace, which is what `--engagement` reads. `monitoring/README.md` §"The 2026-08-22 deletion"
holds the ruling.

---

## The camera's own run

| flag | question |
|---|---|
| `--camera` | **What the camera did and why.** What the scout scanned, how each vantage was chosen (candidate pool, air-box and lens-box rejections, 30° relaxations, cone verdict, rung, range), why every cut fired — and the holds where it looked and stayed. |

```
node .\Auren_Bot\monitoring\trace_monitor.js --camera
node .\Auren_Bot\monitoring\trace_monitor.js --camera --all         # every section, not the headline
node .\Auren_Bot\monitoring\trace_monitor.js --narration --bot=camera_rig --full
```

**It reads a PARALLEL record, not part of the fleet view.** `watcher_camera_*.jsonl` is split out by
filename in `trace_read` — the director re-solves a vantage about once a second, so merging the two
buries four bots' story in camera work and every fleet signature then measures a run it did not mean to.
Naming a camera unit (`--bot=camera_rig`, `--bot=camera_obs`) opens the camera view for **any** flag, so
`--narration --bot=camera_rig` reaches the crew's bring-up rather than returning a clean empty report.

---

## Multi-owner chains

| flag | question |
|---|---|
| `--compost` | **Did the handoff close?** The composter chain: load → fill → collect bone meal. |

---

## After a filmed run

| flag | question |
|---|---|
| `--machine-load` | **Was the box struggling?** GPU use / memory / temperature / power, CPU, free RAM — as p50, p95 and MAX, because a spike is by definition the tail and an average hides it. Plus how late a sample landed. Written automatically during every filmed run; nothing to start. |
| `--narration` | **What one unit SAID, in order.** The only lens here that is not a fold — every other one measures something and discards the rest, so a unit whose output is prose (a director narrating cuts, a preflight narrating what it verified) is counted by the merged view and shown by nothing. |

```
node .\Auren_Bot\monitoring\trace_monitor.js --machine-load
node .\Auren_Bot\monitoring\trace_monitor.js --machine-load --label=standard
node .\Auren_Bot\monitoring\trace_monitor.js --narration                        # no --bot: lists who posted
node .\Auren_Bot\monitoring\trace_monitor.js --narration --bot=camera_rig --full
```

`--machine-load` reports **LOAD, never smoothness**: a hitch is a late frame and nothing outside the game
process can see one, so headroom here is evidence the card was not the limit — not proof no window
stuttered (Law 25).

`--full` matters on `--narration`: the trace segments on the foreman's `start` broadcast, and anything
that comes up before the fleet thinks has its whole bring-up in an earlier segment. The render states how
many lines fall outside rather than quietly showing a subset.

---

## Across runs

| flag | question |
|---|---|
| `--metrics` | **The A/B series** — the only instrument here that reads ACROSS runs and writes a record. `--history` for the full series. |

---

## Finding a specific moment (the query flags — they compose, AND)

Take a flagged, timestamped line and pull the window around it, before AND after, or filter by subsystem
/ bot / time / text.

```
--around="6m 39s"                 ±25 lines around it (COUNT-bounded, the default)
--around="6m 39s" --lines=50      ±50 lines instead
--around="6m 39s" --bot=TessaBot  narrow so the anchor lands on the intended line
--around="6m 39s" --window=60     opt into a TIME window (±60s) instead
--tag=STATION_REGISTRY            one subsystem, whole run
--from=4m --to=7m --bot=AurenBot  one bot, minutes 4 to 7
--grep="furnace_material"         every line matching text
--level=error                     errors only (also: warn)
--run=latest|N|all                which run segment — relative [Nm Ss] times reset on every `start`
```

**Why count-bounded and not time-bounded by default:** a time window explodes on a fast multi-bot fleet
(5 bots × ~10 lines/s × 60s ≈ 3000 lines).

---

## Watching a run as it happens

```
node .\Auren_Bot\monitoring\trace_monitor.js --watch --max-minutes=10
node .\Auren_Bot\monitoring\trace_monitor.js --watch --exit-on-flag --max-minutes=60
```

Re-reads on a cadence and prints ONLY on a problem. Also `--context=N` (history per problem, default 80)
and `--quiet` (digest only).

**Its EXIT is the wake signal** — run it in the background and it re-invokes the session on the first
error. The fleet STAYS UP on a flag, so the "after" is still there to inspect live.

---

## A different file

The default trace is `js_kernel\watcher_fleet.jsonl` (every bot, merged). To read one unit's own file,
pass the path:

```
node .\Auren_Bot\monitoring\trace_monitor.js .\Auren_Bot\js_kernel\watcher_TessaBot.jsonl
```

---

## The one record with a different reader

A locomotion-course leg is NOT read by `trace_monitor`. It has its own reducer, and that pairing is the
discipline. The course is a BENCH — it drives a live server rather than reading a finished record — so it
lives in the workshop rather than here:

```
node .\Auren_Workshop\tools\locomotion_course.js      # a bench: needs a live server
```
