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

`--outcome` copies the foreman's finished verdict, checks, cause, and start/end timestamps.
`--machine-load --label=NAME --run-only` restricts samples to that finished run's timestamps,
including startup and shutdown; the default reports the whole capture. Free RAM includes its minimum.

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
| `--accounting` | **What did this run buy?** The first question asked of every finished run, answered in ONE call. Nine blocks: LABOUR (fleet bot-minutes, worked / idle / startup, occupancy) · LABOUR_BY_JOB (every job by bot-minutes and share, with complete / killed / unfinished) · LABOUR_BY_BOT with `--all` · MATERIAL_TOTALS and MATERIAL_BY_ITEM (every item, pockets vs containers) · STRUCTURES (structure blocks placed of total, **no-work cells shown separately**, when complete and by whom) · TREES (per site: most trunks ever seen, the last count **in fleet-clock order**, whether the phase latch closed and when) · TERRAFORM (line passes, distinct lines, layers, cells walked vs cells that were already air, blocks dug) · MINE (shaft centre, collar, deepest y, levels descended, segments, and every segment settle by stop reason) · STONE_HELD and STONE_SOURCES (**the four verbs that can put stone in a pocket, each carrying its dispatch count — including a zero**, so "did any job dig stone open to the sky" is answered standing still). **IRON_TO_STONE** (added 2026-10-01): raw_iron and cobblestone gathered, their ratio, and the building's own target ratio from its plan's `material_ratio` (logged by js_kernel/item_book as `ratio target …`). **IRON_WAIT** (added 2026-10-01): how long the castle had a cube held back for want of iron and how long it posted no cube at all because of it, per body, from downloaded_build's IRON_WAIT line. **MINE_REQUEST** (added 2026-10-02): what the surface asked the mine for against what the mine took out — the stone short when first asked, at its peak and at the end, the seats that opened, how long the mine stayed open, every item that was on the pull, beside the cobblestone taken out (assessors/mining's `MINE_REQUEST` line; a run recorded before that date reads `not_recorded`). **IRON_FLOW** (added 2026-10-01): raw iron loaded into furnaces, ingots taken out, first of each, and every craft of an iron item, with when each was first made (`first_bucket_run_sec`, added 2026-10-20). **STRIP_TRIPS**, STRIP_TRIP_ENDS and STRIP_TRIPS_IN_ORDER (added 2026-10-01): each strip descent — the segment the fan started it on, segments dug, moves along its own line, trips that left their line, vein ore mined and passed, drops picked, and why it came up. **ANCHOR_CUBE_TRIPS_BY_LAYER** (added 2026-10-14): per layer, cubes and trips, the first minute any body named it the open layer, its first, median and last trip, and trips made while a lower layer still had a trip to come (a lower layer's late rework counts against every layer above it, so read it beside the first-trip column; read one segment at a time with `--run=N`, since each segment has its own clock). **WASTE_PIT_AND_GRAVITY_REFLEX** (added 2026-10-01; pit time added 2026-10-14: walk bot-minutes and seconds per visit from `purpose=waste_pit` legs, the stand at the pit from arrival to the toss line with median, p90 and max, visits by items thrown, walk by the job the body was on): visits to the waste pit, items thrown in by kind, failed visits, and how often the dig's gravity reflex took over or refused a dig; a strip trip that surfaced on a strip trip no longer surfaces on iron (2026-10-02); **ANCHOR_CUBES_WORKED_MORE_THAN_ONCE** and **ANCHOR_CUBES_FOUND_WRONG** (added 2026-10-02): each reworked cube with its trips in order, and what the trips found standing wrong (build_column_executor `CUBE_FOUND`), first trip against returns; **WASTE** and WASTE_BY_JOB (added 2026-10-02): idle time plus the time in jobs that failed, as a share of fleet bot time, with the time in jobs that stated no result beside it (an executor `JOB_RESULT produced=` line rules; otherwise the judge fragments and manager verdict). **TOOL_SHELF** (added 2026-10-01): shelf-short events and pickaxes crafted by tier. **GATHERED** and GATHERED_BY_ITEM (added 2026-10-01): every item the bodies took from the world (the foreman's item book, read through `--items`'s reducer — the server's own pickup counts, with pickups of the fleet's own thrown, placed or dropped items taken out), beside what was still held at the end, so what was crafted, placed or lost reads as the difference. **MINE_CELLS** (added 2026-09-30): every cell one by one — started, complete, complete with digging, stuck, left open for want of a pickaxe, chained in one trip, surfaced at the last pickaxe — and **the fan read off the record**: each floor's primes (cells dispatched before that floor's first completion), each cell's ring from its nearest prime, `out_of_ring_starts` (a cell begun while a lower ring on its floor was open — a peer holding it is the expected cause), MINE_CELLS_BY_RING, MINE_CELLS_BY_SIDE of each floor's fan centre (the middle of its primes — the staircase walks sideways as it descends, so the collar is not a floor's centre), and MINE_CELLS_IN_ORDER. It COMPOSES the reducers behind `--jobs`, `--toolkit` and `--census` rather than re-deriving them; only the site readings are its own. **Two counting rules it states rather than hides:** a producing executor logs its result line twice (once itself, once through the judge hand-off), so event counters dedupe on bot + exact text; and every "last seen" is the newest reading on the FLEET clock, never the last line in file order — twenty per-bot files concatenated are not a timeline, and reading them as one is how a stale sweep gets reported as the end state. **ANCHOR_CUBES_FALLING_LIFT** (added 2026-10-28): every falling block (an anvil, sand) a column trip lifted off a cell it was about to dig, whether its item came back to the pocket, and every dig left standing because one still stood on it (build_column_executor `FALLING_LIFT` / `FALLING_LIFTED` / `FALLING_NOT_LIFTED`), the last 24. |
| *(none)* | **The digest + anomalies.** One line per bot, then every problem detected — errors, stuck loops, silences, warn bursts — each with the offending line and its context. Exit `0` = clean, `2` = problems found, `1` = the trace could not be read at all. |
| `--warnings` | **Every warning, folded.** WARNINGS (total, units raising, distinct shapes) · WARNINGS_BY_UNIT (count, share, bots, shapes per tag) · WARNINGS_BY_SHAPE (the top three shapes per tag — the sentence with every number written as N; `--all` lists every shape). Takes `--run=latest|N|all`. |
| `--jobs` | **The whole run in order, with durations.** Three blocks: THE FLEET IN ORDER (every claim in sequence with duration, verdict, and `(between jobs)` gaps), WHERE THE TIME WENT (per job type: claims, total, mean, worst, share), **JOB_ENDINGS** (added 2026-10-22: per job type, each ending — complete, released, night_recall, superseded, killed, open — with the reason its closing line gave: a manager's readable, the judge's loop readable, or battle_stations' recall reason; numbers fold to `#`), PER BOT (working vs idle, longest single job). The build-speed view. Also carries the bot-minute ledger, the idle join, and **`build_supply`** (below). |
| `--toolkit` | **The run priced in BOT-MINUTES, and what the bots' own kit cost of it.** Four blocks: TOOLKIT_FILL (per bot — when it stopped working for itself and what it left the band for), FILL_TOTALS (bot-minutes to equip the whole fleet, and that as a share of the fleet's budget), RECURRING (the kit's whole-run cost, and how much of it is re-equipping after the first fill), BY_ITEM (which piece of kit ate it). The optimisation view. |
| `--census` | **Everything the fleet authored, counted once, at the end of the run.** Four blocks: CENSUS_TOTALS (items in pockets + items in containers + blocks standing in blueprints, and that total per bot-minute), BY_ITEM (every item, split pockets vs containers), BLUEPRINTS (placed of total), CONTAINERS (every barrel and furnace with its item count; `--all` adds three more: per-bot pocket totals, EVERY item in EVERY pocket, and EVERY item in EVERY container). **The production view, and the most accurate one this project has** — a run starts with an empty world, so at the end every item anywhere in the fleet was put there by the fleet. Nothing is inferred and nothing is subtracted. The three sources are disjoint by construction (an item in a pocket is not in a barrel; a placed block is in no inventory), so nothing is counted twice. **Read `census_read_at_oldest` before trusting a row** — a container the registry did not re-print after its last change reads at its last printed contents, and every row carries the timestamp it was read at. |

```
node .\Auren_Bot\monitoring\trace_monitor.js
node .\Auren_Bot\monitoring\trace_monitor.js --jobs
node .\Auren_Bot\monitoring\trace_monitor.js --jobs --bot=AurenBot
node .\Auren_Bot\monitoring\trace_monitor.js --jobs --all       # every type, not the top 14
node .\Auren_Bot\monitoring\trace_monitor.js --toolkit          # the same run, priced in bot-minutes
node .\Auren_Bot\monitoring\trace_monitor.js --census           # everything the fleet made, counted once
node .\Auren_Bot\monitoring\trace_monitor.js --census --all     # …plus every item in every pocket and container
```

### TWO CLOCKS, AND PICKING THE WRONG ONE IS SILENT (added 2026-09-21)

**Bodies are raised one at a time.** Run 37 spawned twenty of them ten seconds apart — the last body's
life began **3m 24s** after the first's. Every line carries two times and they are not interchangeable:

| clock | what it measures | use it for |
|---|---|---|
| **bot age** (`[Nm Ss]` on the line) | the writing process's own elapsed time, re-based when that body's run begins | *how long did this take this body* — durations, kit times, anything comparing one body against another |
| **fleet time** (from the line's absolute stamp) | seconds since the first line of the run segment | *when in the run did this happen* — per-minute tables, concurrency, ordering two bodies' events |

**A lens that puts two bodies' BOT AGE in one column is reporting twenty overlaid timelines as if they
were one, and nothing errors.** That fault was live in three tables until 2026-09-21. `--jobs` now prints
`claimed_at`/`released_at` in fleet time and `bot_age` beside them; `--toolkit` prints `woke_at_fleet`,
`kit_full_at_fleet` and `kit_took` as three separately-named columns for the same reason.

### `build_supply` — how many jobs the BUILD offered, every minute (added 2026-09-21)

Two sections at the foot of `--jobs`, answering *"exactly how many jobs are available for the laydown
yard from the beginning"* (Architect 2026-09-21).

| section | what it settles |
|---|---|
| `build_supply` | One row per FLEET minute: `job_rows` (how many claimable postings served the structure at once), `pledge_seats` (how many BODIES those rows could hold — see below), `distinct_ids` (rows with re-posts of one order folded together), `bootstrap_orders` (build orders that fill a pocket and so name no destination), `bodies_on_it`, `peak_at_once`, and the postings themselves. **This is the supply question asked at every minute, idle or not** — `idle_by_minute` above asks it only where somebody was standing still, so a minute where nineteen bodies were busy on their own toolkits while the build offered one job is invisible there and visible here. |
| `build_supply_held` | Per build job id: which gate held it, what it was short of, when it started and stopped being held, and over how many sweeps. **A posted job that is held is not supply** — this is what stops a board reading wider than it is. Run 37's top row was `build_chest_natural_block · craft_station · short of: furnace · 1,521 sweeps`. |

The structure is read off the board (the `build/<name>_execute` seat and `→<name>` delivery addresses),
never configured. The fold across bodies is **max**, which is a floor: every body renders its own board,
so a fleet-wide posting appearing on any one of them proves it existed.

**A JOB IS NOT A SEAT** (Architect 2026-09-21: *"if it has 1 gather job of 90 logs then its 1 job with 10
bot spots"*). The board prints both on every row — `(need:90) (seats:10)` — and its header carries the
totals: `──── JOB BOARD: 3 job(s), 22 seat(s), 4 per_body row(s) ────`. A seat is one pledge's worth of
the order, computed by `yield_pledge_calculator.seatsFor`, which is the same division the dispatcher
admits bodies by, so advertised capacity and enforced capacity cannot drift. **A row reading `seats:1`
means exactly one body may hold it** — either the job is exclusive, or its material is made rather than
gathered and therefore pledges whole. That second case used to be invisible and is the reason the token
exists.

**`seats:per_body` IS A WORD, NOT A NUMBER, AND NO LENS MAY COERCE IT.** A per-body order — every body's
own toolkit, its own hunger, its own death — carries one job id across the whole fleet and no total to
divide, so there is no seat count and BOTH numbers a reader might expect are false: `1` says nineteen
bodies are locked out when none is, and `N` says the order admits N when it admits everyone. The board
prints the word so the absence is visible rather than defaulted (Law 13). `pledge_seats` excludes these
rows entirely; `job_rows` still counts them, which is where a per-body row honestly belongs.

`pledge_seats` reads `—` on a run recorded before 2026-09-21: the board did not print the token, and a
missing measurement must not be reported as a measurement of one.

**`--jobs` and `--toolkit` are the same run in two units, and the unit is the whole difference**
(Architect 2026-09-20: *"20 bots for 15 minutes. That's 300 minutes or 5 hours of one bot working. Every
minute is equal to 20 bot minutes."*). `--jobs` prices a job in wall-clock seconds, which answers *what
took longest*; `--toolkit` prices the fleet in LABOUR, which answers *what the fleet spent*. Twenty
bodies make those differ twentyfold — nine minutes of every body equipping itself is three bot-HOURS, and
read off the `--jobs` clock as nine minutes it looks like a rounding error.

**`--toolkit` defines "full kit" as LEAVING THE BOT BAND, and reports a FLOOR rather than a point.** The
board picks the first non-empty band in authored order, so a claim outside `preconditions`/`bot` proves
the body's own band held nothing. A bot-band job that is GATED also empties the band, so a body short of
a tool it cannot obtain is counted as filled — which makes every fill time an under-estimate and never an
over-estimate. The lens prints `measure  floor (...)` beside the totals so a reader cannot mistake it.

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
| `--items` | **The fleet's one item book** (added 2026-10-01). Reads `fleet_logs/item_book.json`, which the foreman writes from every body's reported pocket changes (`foreman/item_book.js`); it parses no trace line. ITEM_BOOK (entries, moves, pocket and container checks and how many disagreed) · TAKEN_FROM_WORLD (pickups of drops the fleet did not make, by item) · PICKED_BACK_UP (thrown stacks, fleet-placed blocks dug back out, dead-body piles) · WHERE_IT_IS (items by kind of place) · MOVED_BY_CAUSE · UNATTRIBUTED (pocket changes no authority named) · WASTE_PIT (stacks and items thrown, in the pit, outside it, picked back up, by last sight) · WASTE_PIT_STACKS_OUTSIDE_OR_PICKED_UP (one row per such stack, with its entity id) · DEATHS. `--all` adds every thrown stack, every pocket item, every place item, every cause by item, and every mismatch. `--bot=B` narrows to one body. Pockets in `--census`, `--accounting` and `--inventory` come from this book. MOVED_BY_JOB (added 2026-10-29): every move by cause, the job the body held when its clerk wrote it, and item — which work took an item from the world, banked it, drew it, placed it or threw it; `--item=X` narrows to one item, 40 rows, `--all` for every row; a book written before the stamp reads `not_recorded`. DUG_IN_BOX (added 2026-10-29, `--dug=x0,y0,z0,x1,y1,z1`): every cell in the box a body opened, with the first digger, its job and the second it dug, so a hole nobody planned has a named digger; a book written before reads `not_recorded`. |
| `--throughput` | **Every material as a flow** (added 2026-10-12). Six blocks, numbers only. Placed blocks are not counted: a placed block is a crafted thing, so material is compared where it is still material. THROUGHPUT (run minutes, stretch length). MATERIAL_FLOW, one row per item from the item book: gathered, put into chests and taken out, each with its per-minute rate, net used and net made on the crafting grid, the furnaces' net intake and net yield, and what stands in chests and pockets at the end. CUBE_DRAW: what the build's cube trips drew, from `column_preparation`'s `CUBE_BILL` line (one per trip, in the tokens the bill is withdrawn under) — trips, total, per minute, per trip. CHEST_COVER, least cover first: chest in and out per minute, the net, and `cover_min` — how long the chest stock standing at the end lasts at the whole-run draw rate with nothing more coming in. CHEST_FLOW_BY_TIME: the same in, out, stock and cover per stretch of the fleet clock (`--bucket=N` minutes, 10 by default), read from the chests' own consecutive pictures so a draw named by its group counts under the item that left; the eight most-drawn items, `--all` for every one. OPEN_ORDER_BY_TIME: the build's last posted order in each stretch, in the bill's own tokens (`order_stone` is a group, so it is never joined to an item row). Read it to see which material the chests run out of first and whether gathering or drawing is the faster side. |
| `--inventory` | **Where every item IS, where it CAME FROM, and how fast the barrel moves it** — last-known location per item, every move between containers, plus the material account, station throughput and the banking queue (below). CHEST_FILL: per barrel, the most slots any snapshot showed and when, how many times it reached all 27 slots, the minutes it stood full, and its slots at the end; with how many barrels were ever full and how many are full at the end. |

Both `--activity` and `--story` take `--bot=<name>`.

### What `--inventory` answers about the shared barrel (added 2026-09-20)

Three sections, each answering a question the lens had no reducer for. They sit beside the four cost blocks
and the transfer manifest, which are unchanged.

| section | fields | what it settles |
|---|---|---|
| `material_account` | `fellings`, and per item `gathered_from_world`, `held_now`, `gone_consumed_or_lost` | **Where the material went.** The one section that reads the harvest — the manifest still excludes it by construction and always will, because a ground pickup is not a transfer between containers. The third column is ONE figure on purpose: crafting, smelting, fuel burn and death-drops have no common line in the record, so splitting it would be inventing the number the reader most wants. |
| `station_throughput` | `run_min`, and per chest `deposits`, `retrieves`, `items_in`, `items_out`, `items_per_min`, `window_open_sec`, `open_share_of_run` | **Whether a chest is saturated or merely contended**, which are different problems with different fixes. A chest whose window is open 8% of the run is not the bottleneck however long the queue is; one at 80% is, whatever else the run says. The 2026-09-19 run's single barrel read **80.9%**. |
| `banking_queue` | `declarations`, `queue_depth_max`, `queue_depth_mean`, `trips_skipped` (+ a per-trip table under `--all`) | **Whether the projection changed any decision.** `trips_skipped` is the only field here with no counterpart anywhere else in the record: a trip NOT taken writes no transfer line, no queue line and no walk, so without this the banking queue could work perfectly and be invisible. |

---

## Building and the clock

| flag | question |
|---|---|
| `--milestones` | **When things were established.** Opens with the **HEADFRAME CLOCK**: the start command (first crew `🧪 Injected autonomous start signal`) → first `🏁 STRUCTURE BUILT: 'headframe'`, graded GREEN / OK / LATE / ALERT against his dawn-to-dusk bands in `architect_config.HEADFRAME_CLOCK` (with the reason printed beside it). Read it after a run for the grade — a grade only, never a pass/fail (the deleted `run.js` used to print it). Then the first-occurrence clock per site: sited, locked, shell closed, farm planted. **Takes a criterion** — `--deadline=10m` is the asker's number, so it is allowed to say pass/fail. |
| `--farm` | **How the wheat field went, as one structure** (also printed at the end of `--milestones`). Rows sited → every gate that held a farm job → headframe built → first farm claim → first block placed → **each row laid, in order, with the gap between rows** → first ground tilled → first crop in the ground → first mature → first harvest → **FARM BUILT** (or NOT YET with the latest count) → any UN-BUILT. Then the latest census (rows laid, structure placed/total, crop cells growing/mature/tilled unsown/untilled/blocked, peaks), a per-row table, work done (placed, dug, cleared, tilled, planted, harvested, bonemealed, refused; per bot; per row with `--all`), cluster visits (worked, refused, STUCK), jobs claimed, seed trips (seeds per punch, outcomes, chest pulls, latest order), the dirt order and the hoe. Reads farming_integrity's `farm census` + `rows:` lines and farm_executor's per-row tend line. One fleet clock (wall time), so gaps between two bots' events are true. |
| `--herding` | **Every herd, one row each: the animal, its result, and the journey there and back.** THE KEEPER'S PEN WATCH first (added 2026-10-24), from the foreman's stream, this run's span: [pen_watch_counts] (each pen's PEN_STANDS — the watch begins once the keeper reads the pen built whole — / PEN_KEPT / ENTERED / RETURNED / ESCAPED / LOST / SIGHT / WOLF_NEAR_PEN), [pen_escapes] (every escape and loss: the animal's id and cell, the gate, its distance from it, and every body within 8 b with its distance and both hands, and whether the pen read whole), [pen_strangers] (added 2026-10-27: another pen's animal first seen inside this fence, PEN_STRANGER — a cow in the sheep pen — with its cell, distance from the gate, the gate, whether the pen read whole, the bodies inside the fence and the bodies near it), [pen_sources] (added 2026-10-29: per pen, animals first seen inside with the gate open — led in — against those first seen with it shut — born inside, or crossed the fence — beside returned, escaped, lost and the last count), [pen_births] (each burst of gate-shut arrivals within 30 s: when, which pen, how many, the count after), [breed_rounds] (added 2026-10-29: each breed round's `[BREED_ROUND]` line — penned, grown, young, ready, cooling and in love as the server read them before the feed, seconds to the next cooling animal ready and waited, pairs possible (ready / 2) against asked, fed (fed_a from the shepherd's long side, fed_b from the far long side, side_b `fed_from` / `route_failed` / empty when the far side was not needed or has no stand), refused, ready left unfed, in love after, calves expected (in love / 2) — beside calves_born, the keeper's gate-shut entries in that pen within 60 s of the line, and why the feed stopped), THE SHEARS BOOK ([shears_book_counts], [shears_book]: both banked pairs on one clock, every lending of the leaf pair and the shearing pair from out to in with its holder and seconds held, a lending still out, ended by a fleet start (run_ended), or lent while a peer held the same pair, and every pair crafted as a made row), [pen_wolves], and [herd_hands_counts] (the bodies' LURE shown/away by why, GATE open/shut, TEMPT follows/not_tempted); `--all` adds every keeper event ([pen_watch]) and every hand line ([herd_hands]). Read with `--run=all`; runs are numbered by the foreman starting, because the trace's segments cut at every `start` broadcast and a herd straddles them. A herd runs from the dispatcher's claim to herd_manager's closing line, split by the executor's own seconds into BEFORE (wheat from the chest, the search), HERD (out to the animal, the lead, the gate) and AFTER (out of the pen, wheat banked). `[herding]` totals · `[herding_by_run]` herds, distinct animals into the pen, span from first claim to last animal in, animals per bot-hour, walk blocks, escapes · `[herding_by_result]` · `[herds_into_pen]` per animal: seconds and walk blocks per phase, `out_blocks` (herder to animal) and `lead_blocks` (animal to where the herd ended), legs, reacquires, gate asks refused (one a second since 2026-10-21, so seconds queued), exit wait, escaped, wheat banked, where the animal stood. `--all` adds `[herds_not_into_pen]` and `[herding_by_bot]`. Walk blocks are each walk's straight line, summed — the least ground, never the route; steps inside the pen are not walks. HERD_CULLS: one row per cull of a full meat pen (cull_manager): grown animals the server named, wanted, culled, left, meat and hide picked up, weapon, shepherd. |
| `--torch` | **When the first torch was crafted** — and when none was, what held it: the order on the board (priority and size), every gate that named a torch job with its shortfall, and the **handoff** when one gate opened and a different one closed behind it. Takes the same `--deadline`. |
| `--light` | **Where the torch network's torches went, and what it left dark** (added 2026-10-22). Reads lighting_integrity's verdict line, lighting_manager's per-torch line (`torch placed|refused paint= mount= cell= at= lights= reason=`) and the mine's torch lines. LIGHT_NOW (the last verdict: ring and inside cells, ground dark, ground the keeper does not hold, dark after the plan, cells no spot reaches, mine cells and mine dark, sources standing, torches planned) · LIGHT_BY_WINDOW (the last verdict in each 2-minute window, with torches placed in it) · TORCHES (placed and refused by paint and mount, cells each lit on average, by bot; the mine's torches set while digging and by the after-dig segment pass) · REFUSALS (by the executor's reason) · TORCH_LIST (each torch: the painted cell it was planned for and the cell it stands in; 40 rows, `--all` for every row and the mine's). |
| `--foreman` | **What the foreman announced and refused, and the keeper's fields** (keeper_fields and keeper_mansion added 2026-10-25). Reads the foreman's own record: [announced] (each structure finished, each layer released), [refused] (each withheld ask by code; detail behind `--all`), and [keeper_fields] (the integrity keeper's fields verdict, logged on a change: per field room, held, growing / mature / untilled / unsown / blocked cells and stranded; the last 12, every one behind `--all`), and [keeper_mansion] (added 2026-10-25: the keeper's mansion lines — the plan kept, then cubes ok / open / unheld on each change; the last 12, every one behind `--all`), and [keeper_nursery] (added 2026-10-26: the keeper's cane nursery readings; with [keeper_plans], each plans reading and the chunk columns the thread asked for, foreman/nursery_keeper — standing cane, stalks, ripe, open tiles, pier cells, columns unheld of the zone's, on each change; the last 12, every one behind `--all`). |
| `--site` | **Where the base was sited, and what every landing refused** (added 2026-10-23). Reads the foreman's own stream: each random landing rolled and its refusal (startup_steps) and the base-layout survey's report (lock_all_buildspots): each structure found, sited beside another than the one it serves, or not found, and the base's lights (siteLights). BASE_SITE (landing kept, its spot and biome, structures sited and how many loose, the lights' pad, area, origin corner, stand cells, torch posts on the grid and where it left dark) · STRUCTURES (each structure's origin and, when sited loose, the structure it stands beside) · NOT_FOUND (each structure the survey could not site and why) · LANDINGS (each landing rolled and why it was refused). |
| `--night` | **What the night did to the crew** (added 2026-10-22). NIGHT_RECALLS (battle_stations' `NIGHT_RECALL job= why= source=`: each active job the inline check sent home to the idle spot, by job, first and last) · DUSK_STOPS (supply_manager's and survey_executor's `DUSK_STOP job= why= after=`: each claim ended at dusk on its next natural boundary, after how many pledges or blocks) · DEATHS (each death, what killed it, hits and damage taken) · SEED_PICKS (seed_picker's picks: seeds, punches, the most punches in one pick against the cap, claims ended) · PUNCH_CAPPED_CLAIMS (forest runs that ended on harvest_executor's punch cap). 40 rows, `--all` for every row. |
| `--finder` | **What the fleet could not find, and what it did about it** (added 2026-10-22). FINDER_BY_ITEM (per item: book walks, walks stopped short, misses at a stand, frontier scans, frontier all held) · FINDER_ERRORS (the loud ones: NO_CATEGORY, a thing on no scan list; BACKSTOP, every sector within 4 rings scanned without it) · FINDER_STEPS (every escalation step in order, with sector and ring) · BOOK_PAGES (every sector scan written to the survey book, with its stand and category count) · INK_TRIPS (squid_hunt: trips, ink got, dives, how each trip ended, then every start, look, water entry, dive and end). 40 rows, `--all` for every row. |

```
node .\Auren_Bot\monitoring\trace_monitor.js --milestones --deadline=10m
node .\Auren_Bot\monitoring\trace_monitor.js --torch
node .\Auren_Bot\monitoring\trace_monitor.js --torch --deadline=10m
```

**Why the torch gets a clock and no other item does.** The torch chain is the one supply chain that can
close a circle on itself — a torch needs charcoal, charcoal comes off the furnace chain, and the furnace
waits on stone. Light is optional work, so a run where no torch is ever crafted raises nothing: no error, no stall, just a board row that is gated every sweep. **The gate
handoff is the line to read** — one gate opening and another closing behind it is what separates "the
fix did nothing" from "the fix worked and something else stopped it", and a gate count cannot tell those
apart. Neither the craft target (`have=4/12`) nor the order size (`need:12`) is judged; both are printed
verbatim, because what they *should* be is the asker's question (Law 25).

---

## Walking

| flag | question |
|---|---|
| `--walking` | **Commuting against working.** Every walk (locomotion_dispatcher's `[WALK_LEDGER]` line, one per walk at its verdict) tallied these ways: WALK_AGAINST_WORK, first (walking as a percentage of time on jobs against the 50% limit, whether it is over, the working time it was short by and how many times longer the working half must be, for the fleet and per job, from the bot's own `walk_share_calculator`; only walks on the `travel` leg count — to the site, to a station, home — and moves made inside the work, the `work` leg, are shown beside them as `moves_inside_work_bot_min`) · WALKING (walks, walk bot-minutes, share of fleet and of worked time, arrived / failed / abandoned) · WALKING_BY_JOB (each job token's walk bot-minutes beside the bot-minutes it held the body, and its walk share) · WALKING_BY_DESTINATION (`station:<type>` for a walk to a chest, furnace or table; `lane:entry` / `lane:exit` for the leg a walk makes by a blueprint lane's mouth before its own goal; `move` for open ground). **Where the walks happen** (added 2026-09-30, read off the ledger's `from=`/`to=` ends): WALKING_BY_DISTANCE (straight-line bands 0-2 · 2-8 · 8-24 · 24-64 · 64+, so shuffling inside the work and commuting read as two numbers) · WALKING_BY_JOB_DISTANCE (per job, average blocks and bot-minutes by band) · WALKING_BY_PLACE (the 20 destination tiles, 16×16 blocks by 8 tall, that took the most walk time, with the job that spent most arriving there). `--all` adds WALKING_BY_BOT. Chest walks are walking here and are taken OUT of `--inventory`'s chest wait. |
| `--pathfinding` | **What walking cost.** A* calls, nodes searched, time spent, slow-nav tripwires. Read this when a run feels slow and `--jobs` blames travel. |
| `--trees` | **How far out the tree search had to look.** One row per search from `tree_feller`'s `tree_search` ledger line. The search opens 16-block rings outward and takes the first tree it can stand beside, so the ring a tree was taken in is the distance to the nearest usable wood. TREE_SEARCHES (searches, picked, and the four ways a search ends empty: `none_seen` no tree in any loaded ring · `none_in_zone` trees seen, none the zone admits · `all_claimed` every tree held by a peer · `none_reached` a walk to a tree failed) · TREE_SEARCH_COST (`scan_ms` is the reading alone, `search_sec` adds the walks to trees tried; rings and sections read) · TREE_SEARCH_REJECTIONS (peer-held, no stand cell, failed path, already tried) · PICKED_BY_RING · SEARCHES_BY_ZONE (`inside:*` clears a site, `outside:*` is log supply) · SEARCHES_BY_WINDOW (5-minute windows: the picked ring climbing through the run is the forest receding) · SLOWEST_SEARCHES · UNREACHED_TREES and UNREACHED_BY_TREE (from the feller's `unreached` line, one per walk to a tree that did not arrive: locomotion's own reason, whose closed ground the stand cell lay in — `building` / `waste_pit` / `lane` / `peer` / `open` — how far the body got, and the blocks at the stand cell; a stand cell in closed ground is refused before any route is searched). `--all` adds SEARCHES_BY_BOT. `--trees --watch` takes the same read of a run that is still moving, every number interim. · TREE_FARM (from `sapling_planter`'s `PLANTED` line: harvests that could plant and that did, saplings planted, distinct cells, saplings still standing at the end, what planting cost in bot-minutes, seconds per sapling and blocks walked per sapling, failed walks, cells passed because no body can stand beside them, cells refused because a peer held them, then the return: a pick is a `farm` pick when its trunk stands on a column a sapling went into earlier in the run, every other pick is `wild`; farm share of picks, farm trees per sapling planted, minutes from sapling to pick, and farm against wild on distance and search time) · TREE_FARM_BY_WINDOW (the same split in five-minute windows). |
| `--furnace` | **What a furnace's time went on.** BATCHES (loads, collected, items in and out) · DONE_UNTIL_EMPTIED and EMPTIED_UNTIL_LOADED_AGAIN (count, median, mean, longest, total) · BY_ORDER · BY_FURNACE · BATCHES_IN_ORDER. Reads `WINDOW furnace-load` and `WINDOW furnace-collect`. `--all` lists every batch. |
| `--tandem` | **Were the night's guards used, and what did they do.** DUTY (seats, held and walking minutes, workers declining, posts and trees finished meanwhile, deaths) · BY_ROLE (fights, kills, hurts, health lost, mobs declined for guard, worker, other) · FIGHTS_BY_DOOR · MOBS_HANDED_ACROSS · GUARDS · WORKERS. |
| `--gate` | **Did one body plan at a time, and how long was each inside.** PLANNING_GATE (entries issued, closed by exit token, closed by disconnect, still open at the end, two planning entries open at once, most inside at once, exits not matching their entry, crash report lines) · TIME_INSIDE (average, median, longest, counts over 2 s and 10 s, against timeout_crash's 30 s limit) · THE_LINE (requests that waited, most and average ahead) · LONGEST_INSIDE. `--all` lists every entry. |
| `--steps` | **What stopped a step the body had planned.** One row per failed step from the navigator's `step_fail` ledger line, written the moment the step ends and before any recovery moves the body. `stopped_by` is the first of these the readings show: `server_set_back` (the server corrected the body's position during the step) · `no_floor` · `solid_feet:<block>` / `solid_head:<block>` (the destination holds a block with a collision box) · `rise_over_step` (the destination floor's top is more than a walking step above the body) · `wall_contact` (pressed against something, gained under a fifth of a block) · `no_motion` (gained under a fifth of a block, pressed against nothing) · `out_of_time` (still moving when the step's time ran out). STEP_FAILURES (totals, bodies in the air, another body at the cell, server set-backs) · STOPPED_BY · STOPPED_BY_EDGE · FAILED_CELLS (the cells failed into most, each with its last readings: both cells, the body's position to the hundredth, the blocks at the destination's floor, feet and head and at the body's floor, head and above, who else stood there, the item held) · STEP_FAILURES_BY_WINDOW · STEP_FAILURES_BY_BOT. `--all` lists every cell. |
| `--lag` | **Why the server fell behind.** DISK (the foreman's own readings while the fleet ran, from `foreman/machine_pulse.js`: slow probes of one small write and the worst, machine-wide megabytes written per second, lowest free memory, and which programs wrote the most between readings; **those per-program figures are every write Windows counts, files, pipes between a program's own processes and network together, not the disk alone**: Discord's renderer feeding its own GPU process read as 50 GB while its files grew 27 MB) · DISK_HEAVIEST_READINGS · **MACHINE_AT_LAG** (added 2026-10-14: one row per lag the foreman read, at most one a minute, from `machine_pulse.atLag`: the six programs taking the most processor and the most disk at that moment, available memory, pages per second, commit share, the disk's write latency, queue length and busy share, and how many Windows events fell in the stretch) · **WINDOWS_EVENTS_AT_LAG** (each Windows event from the lag's stretch plus two minutes before it, once each: system warnings and errors, Windows Update, servicing, Defender) · SERVER_LAG (times the console said `Can't keep up`, total and worst milliseconds behind, silences the bots saw and the longest, times a bot held still, milliseconds the server's main thread spent blocked, collector pauses) · SERVER_THREAD_WAITS_BY_CAUSE (the part of the tick that asked, what it waited on — file write, file sync, file read, lock — the kind of file, events, total and worst milliseconds) · EACH_LAG (one row per lag: how much of the stretch behind was main-thread waiting, how much was collector pause, and the top cause) · SERVER_THREAD_WAITS_BY_MINUTE (so a wait on a fixed beat reads as evenly spaced rows). Read from `console_server.log`, the bots' `SERVER BACK` lines and Java's flight record `server.jfr`, decoded by the JDK's own `jfr print`. The flight record exists only after the server has stopped. |
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
| `--activities` | **Every activity span the bodies reported, to the second** (added 2026-11-04). One row per span from the bodies' `[ACTIVITY] 📊 start\|end` lines (`custom_api/activity_log.js`): fight, squid_hunt, herding, pen_crossing, shepherd, shearing, culling — its start and end as run age and wall clock (hh:mm:ss UTC, the clock every camera file is stamped in), seconds, bot, subject (`zombie#77`), where (`at`) and `ended`: `line` is the body's own end line; `next_job`, `restarted`, `timeout` and `trace_end` are ends the board inferred. [activities_by_kind] totals each kind; [activities_overlapping] lists the stretches two bots' spans ran together, which is where the scout seat had to choose. The board is the same one the rig's scout seat reads live, so the lens and the live camera agree on every span. `--kind=K` narrows to one kind, `--bot=B` to one body, `--all` lifts the 60-row cut. The scout seat's own picks are `[CAM_SCOUT] 📊 focus` lines on the camera record (`--narration --bot=camera_rig`). |

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

## How long is the walk back? — `--jobs`, `[return_legs]`

Architect 2026-09-21: *"can we measure how much time is taken to return?"* — the question the whole
throughput thread opened with (*"its not the trees its the bots walking all the way back"*). A job's
duration folds the walk out, the work and the walk back into one number that cannot be argued with; this
separates the last of the three.

**`measured_from` and `measured_to` are the bounds, and they are two lines `supply_manager` already
writes** — the moment a delivery load is made up, and the moment it is banked at the destination. Nothing
is sensed for this and no motion is inferred.

| field | means |
|---|---|
| `legs_measured` | delivery legs that opened AND closed |
| `legs_never_closed` | opened and never banked — counted, never matched to the wrong end |
| `worst` / `worst_bot` / `worst_item` | the single longest leg in the run |
| the table | per item: total, legs, mean, worst |

**THE SPAN IS THE WALK BACK PLUS THE CHEST HANDLING AT THE FAR END, and nothing here separates them** —
there is no third line to separate them with. Read the `destination` spread in the table to tell a long
walk from a busy barrel. A prototype, and named as one.

**A LEG IS PAIRED PER BOT AND PER ITEM, OLDEST OPEN FIRST.** A second load of the same item opening
before the first closes means the first never did; those land in `legs_never_closed` rather than being
matched across and printing a duration that is two trips added together (Law 25 — an unmatched leg is
not a long leg).

---

## After a filmed run

| flag | question |
|---|---|
| `--machine-load` | **Was the box struggling?** GPU use / memory / temperature / power, CPU, free RAM — as p50, p95 and MAX, because a spike is by definition the tail and an average hides it. Plus how late a sample landed. Written automatically during every filmed run; nothing to start. |
| `--narration` | **What one unit SAID, in order.** The only lens here that is not a fold — every other one measures something and discards the rest, so a unit whose output is prose (a director narrating cuts, a preflight narrating what it verified) is counted by the merged view and shown by nothing. |

```
node .\Auren_Bot\monitoring\trace_monitor.js --machine-load
node .\Auren_Bot\monitoring\trace_monitor.js --machine-load --label=rollback
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
--records=<dir>                   another fleet's fleet_logs (any lens)
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
