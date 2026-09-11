# `Auren_Bot/Auren_Workshop/` — the equipment that reads the bot, shipped with the bot it reads

**66 files, plus one vendored parser. All of them travel in the extract, and that is the point of the
layout rather than a leak in it.**

`Auren_Bot/` is the construct. This is the shop it was built in: the test that gates every commit, the
benches that drive a live world, the cameras that film it, and the launchers that raise the whole stack
with one word.

---

## The one idea this folder exists to hold

**THE EQUIPMENT LIVES WITH THE THING IT MEASURES.** This was a sibling of `Auren_Bot/` for two days and
it did not survive contact with a real run (Architect 2026-09-10):

> *"theres 2 way of running the bot and i only want one. every time i try to do more than one i have these
> issues… i cant fix things that are wrong without my tools and the tools need to live with the bot to read
> the bot and i should just ship the whole thing as one piece and hand people scripts to run the thing
> instead of hiding it from them."*

A wall between the tools and the bot bought two ways to run the fleet: `run.js` copied the tracked subset
out to a sibling folder and ran the copy, or you ran in place and were testing something a stranger could
not have. **Now there is one way** (Law 16) — the tree in place *is* the shipped tree, so a run that works
here is a run that works for a downloader, with nothing left to keep in step.

**What a person is handed is a SMALL SURFACE over a whole stack, not a smaller stack.** A beginner runs
one script. Somebody who wants to read their own 90,000-line trace has every lens and every bench sitting
right there. Hiding them only ever meant a stranger with a frozen fleet had to mail the file to him.

**The dependency still runs exactly one way. The workshop reads the bot; the bot never reads the
workshop.** That is the invariant the carve was really protecting, and it is unchanged: no file under
`Auren_Bot/` outside this folder requires anything inside it. If you find yourself adding a `require`
pointing from shipped bot code into here, the change is wrong before it is finished — the thing you are
reaching for belongs in the bot, or the code doing the reaching belongs in the workshop.

**The line that replaced "does it ship" is CODE versus DOCUMENTS, drawn at `Auren_Bot/`.** What stays
private is the root-level material: `Cognitive_documents/`, `Documentation/`, `Privacy/`, `Sessions/`,
`Cutting_room/`, `Public_server/`, `Long_term_memory/`, `MinecraftServer/`, `CLAUDE.md`. Placement is the
whole control, and `preflight`'s shipped-tree pass proves the other direction on every run by refusing any
`require` under `Auren_Bot/` that reaches one of them.

Full reasoning, the direction audit that got it wrong once, and the measurements:
`Documentation/Refurbishing planning/auren_bot_user_split_plan.md` (read its 2026-09-10 SUPERSEDED block
first), and the current scratchpad volume §5–§6.

---

## What is here

| | files | what it is |
|---|---:|---|
| `tools/` | 116 | **The benches — things that DRIVE.** `preflight.js` is the fleet's entire test surface. The rest are named benches and probes that need a live world: the lanista family, the conductors, combat recording, camera calibration, the seed scanner, the world forge. Read `tools/README.md` before writing, keeping or running any of it. |
| `monitoring/` | 21 | **The instruments — things that READ.** 20 lenses plus the trace reader and dashboard. A run record is read only through its lens, machines included. `monitoring/LENSES.md` maps every question to the flag that answers it. |
| `camera/` | 8 | **The camera crew.** Rig, follow, gimbal, scout, sightline, combat witness, configure, and the OBS bridge. |
| `scripts/` | 9 | **The one-button PowerShell.** `_node.ps1` and `npm.ps1` resolve this machine's toolchain and say which one they picked; the rest raise the cameras and the dashboard, and `world_rollback.ps1` snapshots and restores a world folder it is always told the path of. The three fleet launchers are gone — a run is started by `run.js` (2026-09-10). |
| `run_config.js` | 1 | **THE ONE PAGE.** Every choice a run has — world, clock, person, crew, soak, watch, wake rules, record, teardown, server — authored before anything starts. Every field is a whitelist and nothing is defaulted for you. |
| `run.js` | 1 | **THE ONE SCRIPT.** Reads the page once and performs the whole run: builds the stranger download from the working tree, launches it in a stripped environment, seats a person, has that PERSON ask the desk for a crew, measures placement off the server, soaks it watched, reads the trace through the lens, tears down. No flags. |
| `fleet_control.js` | 1 | **The world's lifecycle, and the fleet's vocabulary.** Server up/down, snapshots and restores, the clock, teardown, status, rcon, operator verbs. `run.js` composes these verbs rather than reimplementing them, so this stays the one owner (Law 16). It *operates* the construct and is not part of it: no fragment, no signal bus, no decision inside the SPA loop. |
| `workshop_paths.js` | 1 | **The one crossing point of the boundary** — see below. |
| `fleet_runbook.md` · `camera_runbook.md` | 2 | The procedure documents. Running the fleet; filming and editing a run. |
| `Architect_Commands.txt` | 1 | Copy-paste command sheet, written for him rather than for a machine. |

---

## `workshop_paths.js` — read this before writing anything in here

The workshop and the bot are **sibling directories**, so every file here that reaches a bot file crosses a
boundary. Before this file existed, each one answered *"where is the bot?"* for itself as
`path.join(__dirname, '..')` — a sentence that was true only while these tools lived inside `Auren_Bot/`.
**Fifty-five copies of one assumption, all of them silently wrong the moment the layout moved.**

So the boundary gets one crossing point:

```js
const paths = require('./workshop_paths');       // or ../workshop_paths from a subfolder
paths.registerAliases();                          // NODE_PATH + module-alias, in that order
require(paths.bot('js_kernel/utils/rcon_link'));  // the crossing, visible in the source
```

**Write the crossing out longhand. Do not reach for an `@`-alias to shorten it.** The aliases exist and
are registered here, but for the reason they were invented — the *bot's own* code says
`require('@utils/x')` internally and cannot load without them. A workshop file using one would make the
crossing invisible, and the entire value of the split is that *"this workshop file depends on shipped bot
code"* is a fact you can grep for in a single string. Two topics, one list each (Law 29).

`registerAliases()` puts the module homes on `NODE_PATH` **first**, then requires `module-alias` by name.
That order is load-bearing: inside `Auren_Bot/` Node found the package by walking up to
`Auren_Bot/node_modules`; from here that walk ends at the repo root and finds nothing.

---

## THERE ARE NO BENCH TESTS HERE (Architect 2026-09-10)

`virtual_playground/` — 18 files, 4,118 lines, 13 headless decision scenarios — was **deleted**, not
repaired, on the day six of the thirteen were found to have been failing long enough that nobody had
noticed.

**His ruling, and it is the whole reason:** *"we dont keep bench tests. the bot moves too fast. thats what
preflight is for. it can move with the system. a guard has to grow and flex with the system. not lock in
what is true right now."*

A scenario asserts what was true when it was written. The code moves out from under it and the scenario
either goes red for a reason nobody chases or, worse, stays green while measuring something that no longer
matters. `preflight` does not have that failure mode because it **discovers** what to check from the tree
itself — a fragment added tomorrow is checked tomorrow, with no edit.

This is the same ruling that deleted 41 test files on 2026-08-10, applied to the one folder that survived
it. **Before adding any test here, read `tools/README.md` — both the question that governs tests and the
four gates that govern guards.**

### THE ONE RULE THAT OUTLIVED THE BENCH — READ, DON'T SIMULATE

The bench is gone; its governing line is not, because it was never about the bench. **Anything MINECRAFT
decides is READ. Only the operator's choices are AUTHORED.** A harness may place the bot, hand it blocks,
set a standpoint, build a shape with RCON — those are an operator's choices and authoring them is honest.
It may never **compute an action's outcome** and call that a result. The moment a harness decides what the
world would have done, it is grading its own paper (Law 26) and its verdict means nothing.

**This is why the live probes in `tools/` are live.** `chat_probe`, `sign_probe`, `water_pillar_probe`,
`stone_column_probe` and `ghost_probe` each exist because their question is a world-transformation — what
does Minecraft DO — and the only honest answer to that is one read off a real server. Their headers used
to cite the bench for this rule; they cite this section now.

**It still decides where a new test belongs.** A question the fleet can answer from its own code goes to
`preflight`, which discovers its subject from the tree. A question Minecraft answers goes to a live probe,
written for that question and deleted with the turn that answered it.

---

## The line between `tools/` and `monitoring/`

**The test: could it run with no Minecraft installed?**

- **Yes → it is an instrument.** It reads a record that already exists. `monitoring/`.
- **No → it is a bench.** It needs a world, a server or a live bot. `tools/`.

The split collapses the moment an instrument starts driving something or a bench starts holding a reducer
of its own, and both folders' READMEs carry the rule that keeps it from collapsing. Read them.

---

## The two commands every session runs

```powershell
# resolve this machine's node — the answer differs per workstation
. .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode

# open the turn, and gate the code
& $n Auren_Workshop\tools\preflight.js --session <name> --doing "<one line>" --owns "<path>,<path>"
```

`preflight.js` is the one test in the fleet and it takes seconds. It proves every fragment loads, every
name resolves, every boundary to the outside world goes through `external_library_guard`, and every catch
in the watcher reports or rethrows. It also prints who else is in this working tree, what is moving on
disk, whether the trunk has moved, and where this turn's records are written. **Run it after each change,
as you go — not saved for the end of the turn.**

---

## What this folder does NOT do

- **It does not get REQUIRED by the bot.** It ships, and shipped code still may not reach into it: the
  dependency runs one way, so a fragment that requires a bench has inverted the relationship the whole
  layout rests on. **`preflight` refuses it** — the *Dependency direction* pass. This used to be enforced
  by absence (the require could not resolve in a download); now it resolves everywhere, so the mistake
  would work, and a mistake that works is one nothing reports on its own.
- **It does not decide anything inside the bot.** `fleet_control` and `fleet_runbook` operate the
  construct through its own operator verbs and its own chat; neither mounts a fragment or touches the
  signal bus. A bench that starts making the bot's decisions for it has stopped being a bench.
- **It does not hold a record that outlives a run.** A start empties `fleet_logs/` whole. Long-term
  memory is a markdown holding the interpretation, and `Long_term_memory/` is the only exception.
- **It does not hold anything naming a real person.** That is `Privacy/`, at the repo root, and placement
  is the control rather than an ignore rule.

---

## Where to read next

| you want to | read |
|---|---|
| start, test or inspect a live fleet | `fleet_runbook.md` |
| film or edit a run | `camera_runbook.md` (§1–5 film, §6 edit; the suite is `Cutting_room/` at the repo root) |
| write, keep or run a test | `tools/README.md` — what a test is here, and when it is allowed to exist |
| answer a question about a run | `monitoring/LENSES.md`, then `monitoring/README.md` |
| know the current state of any of it | the newest entry of `Documentation/Refurbishing planning/architect_bugsquashing.md` — a runbook holds procedure, the record holds state |
