# Camera Runbook — filming the fleet (cameras + OBS)

> Operative procedure, not a law and not archival documentation. It answers one question:
> *"cold-start, how do I get footage of a live run?"* Read it when the task is to FILM; read
> `fleet_runbook.md` when the task is to start / test / inspect the fleet. Two questions, two files —
> the same split CLAUDE.md draws to `fleet_runbook.md`, applied one scope further out, and for the
> same reason: a terminal-only session should never carry the camera stack's weight.
>
> **Status does not live here** (Law 14 — a durable file records the persistent WHY, never the
> transient what-is). What is currently verified, what is unproven, and what is half-built lives in
> `Documentation/Refurbishing planning/architect_bugsquashing.md`, newest entry at the top. **A
> cold-start session picking this work up should read that entry's OPEN ITEMS first**, then use this
> file to drive the machinery.

---

## 1. What the camera system is (four parts, one job)

Filming is separate from the fleet and never touches it (Law 19 — the film crew observes, it does not
act in the shared world). Four parts:

- **Camera clients** — one Prism Launcher Minecraft instance per bot (`Cam_AurenBot`, `Cam_TessaBot`,
  `Cam_IrisBot`), joining the local server in spectator mode under made-up offline names. Built and
  launched by `scripts/start_cameras.ps1`.
- **The director** (`camera/camera_rig.js`) — flips each camera to spectator + night vision and moves
  it shot to shot. Its knobs are all in `camera/camera_configure.js`; the rig hardcodes no number.
  It is also **the only thing that knows the crew is really in the world**: it arms a client only after
  `data get entity <cam> Pos` came back with a position, which the server answers for a joined client and
  nothing else. When every expected client — the bot cameras, plus the Architect's eye on a run that asked
  for it — has cleared that, the
  rig writes `js_kernel/camera_rig_ready.json`, and that file is what the overlay waits on before OBS
  binds anything and before the fleet is told to start. The launcher cannot answer this: it returns when
  the process *starts*, tens of seconds before the world finishes loading.
- **The window titler** (`scripts/camera_window_titler.ps1`) — a background daemon that renames each
  camera's OS window to its cam name. **This is the load-bearing part of the whole recording setup**:
  every Minecraft window otherwise carries the identical title, class and exe, which is exactly what
  OBS uses to identify a window. Unique stable titles are the only reason ONE OBS can tell the
  cameras apart and re-bind correctly after a restart.
- **The OBS operator** (`camera/camera_obs.js`) — installs nothing, but configures, launches and
  drives a single portable OBS: one Window Capture per camera, each with a Source Record filter
  writing its own file. **One `start` records every camera.**

**One OBS, always.** Adding a camera is a config line, not another application to launch, arrange and
press record on. If you find yourself opening a second OBS, something is wrong — read §5.

### The two modes — and both start OFF

`camera/camera_configure.js` opens with a `mode` block. Nothing above runs until you set one:

```js
mode: {
  framing: false,   // the film crew: cameras, gimbals, cuts, OBS
  witness: false,   // the combat record: what the SERVER saw the fleet's fights do
},
```

They are independent. `framing` alone is the camera system as it always was. `witness` alone joins one
headless client to the server and writes a combat record with no camera anywhere — useful when you want
the data and not the footage. Both on is the same client doing both jobs. Both off and the rig announces
which key to flip and exits rather than idling on a game slot.

**The witness in one line:** the bot's own watcher trace is the defendant's story; this is a bystander's,
written blind to it, and the two are put side by side by `node monitoring/trace_monitor.js --witness`.
It samples only while a fight is actually open, so an idle fleet writes nothing. Its file is
`fleet_logs/combat_witness/combat_witness.jsonl`, overwritten each start — **never open it directly, read
it through the lens.**

---

## 2. One-time setup on a machine that has never filmed

Both steps are idempotent; re-running them is safe and is the repair path.

1. **Prism + the camera instances** (downloads Prism portable into `tools/PrismLauncher`, builds one
   plain-vanilla instance per bot and copies your main game's **resource** packs in):
   ```
   .\Auren_Workshop\scripts\start_cameras.ps1 -SetupOnly
   ```
   The **one** genuinely manual step in the entire system is inside this: Prism opens so you can add
   your Microsoft account once (Accounts → Manage Accounts → Add Microsoft). That single login proves
   ownership; the cameras then join the offline-mode local server under invented names forever after.
   No extra accounts, no extra purchases. Re-run the command after logging in.

   **No shaders, and no mod loader — this is settled, not a default to flip back.** A resource pack
   costs VRAM once at load; a shader pack costs GPU time on every frame and spikes hard whenever
   chunks build, and the fleet scales to 3–5 bots each with a camera, so that per-frame cost is
   multiplied by the number of windows. Textures survive the scaling, shaders do not. The instances
   are therefore bare vanilla: no Fabric, no Iris, no Sodium, nothing downloaded from Modrinth. An
   instance built by an older revision is **migrated** on the next run — the pack is rewritten to the
   single vanilla component and `mods/`, `shaderpacks/` and `config/iris.properties` are deleted, so
   the disk states one truth about what a camera runs.

2. **Portable OBS** into `tools/OBS` — the OBS release zip plus the Source Record plugin, with
   `portable_mode.txt` beside the exe. That last file is what puts OBS's config *inside* the repo
   tree instead of `%APPDATA%`, which is the only reason the config paths are deterministic enough to
   generate against. obs-websocket needs no install: it ships inside OBS.

   `tools/` is gitignored, so **neither the launcher nor OBS travels with the repo** — each machine
   owns its own copy, exactly like `MinecraftServer/`. What travels is `camera_obs.js` and the `obs:`
   block in `camera_configure.js`. Nothing is hand-synced, because the OBS config is *derived*.

---

## 3. Cold start: filming a live run

**The automated route is a FIELD on the config page — `fleet_runbook.md` §3, and it is what to reach
for.** A run with `record: 'film'` on `run_config.js` raises everything below in order —
`node Auren_Workshop/run.js` performs it, and `node Auren_Workshop/fleet_control.js down` closes
it — the recording, the cameras and the world together (2026-09-07; `record_overlay.js stop` is still the
owner of the film half and `down` delegates to it, but it is no longer a verb anyone has to remember). It turns framing on for its own run, so `mode.framing` below can stay off. The **Architect's eye** — the
seat a human flies — is NOT raised unless `camera_configure` says so (§8).

What follows is the same sequence **by hand** — for filming something the conductors do not cover, or for
diagnosing which step of the automated one failed. Order matters either way. The cameras need a server to
join, and OBS needs the camera windows to exist before it can bind to them.

```
# 1. A run on a clean world WITH the camera crew — set record: 'film' on run_config.js, then:
node Auren_Workshop/run.js

# 2. OBS: configure once, then bring it up and bind the windows
.\Auren_Workshop\scripts\camera_obs.ps1 configure --count=3
.\Auren_Workshop\scripts\camera_obs.ps1 up --count=3        # expect "3/3 camera window(s) bound"

# 3. Roll
.\Auren_Workshop\scripts\camera_obs.ps1 start               # expect "3/3 per-camera file(s) growing"

# 4. ...film... then
.\Auren_Workshop\scripts\camera_obs.ps1 stop
.\Auren_Workshop\scripts\camera_obs.ps1 down
node Auren_Workshop/fleet_control.js down
```

**`configure` requires OBS to be STOPPED and refuses to run otherwise** — see §4. Run it after any
change to the `obs:` block in `camera_configure.js`; skip it otherwise.

**Nametags are off, and nothing needs pressing.** `camera_rig` puts every player into a scoreboard team
with `nametagVisibility never` at bring-up. A nametag is drawn *into the frame* by the client rather
than onto the HUD, so it is part of the picture OBS captures — a team is the only server-side switch
for it, and the rig is the only thing in the stack holding an RCON connection. It covers the **bots**
(the names actually in shot) and the spectators alike, because a camera filming a bot can otherwise
catch another camera's name floating behind it. The team persists in the world's scoreboard and is
re-asserted every run rather than torn down.

**What that costs, and what replaces it.** Nametags render *through* terrain, so they used to be how
you found a bot behind a tree from the Architect's eye. That affordance is now `/tp <bot>` from the eye
itself, which keeps its chat and its operator rights for exactly this reason (§8).

**Do not press F1.** It buys almost nothing now: the cameras are spectators, so hotbar / hearts /
hunger / XP are already gone; chat is suppressed by `chatVisibility:2` on the **directed** cameras; and
the nametags are handled above. The Architect's eye deliberately keeps its chat (§8) — it is a seat,
not a shot. F1 also cannot be automated, so keeping it in the loop would break the unattended chain.

**Never minimize a camera window.** Occluded is fine — Window Capture uses WGC, which keeps a hidden
window rendering, so the cameras can be **stacked on one monitor** rather than tiled across three.
*Minimized* is not fine: a minimized window stops producing frames and OBS records nothing.

---

## 4. The OBS operator — commands, and the state rule that shapes them

```
.\Auren_Workshop\scripts\camera_obs.ps1 configure [--count=N]   # OBS STOPPED. Writes boot-time config.
.\Auren_Workshop\scripts\camera_obs.ps1 up        [--count=N]   # Launch OBS, create/verify scene+sources.
.\Auren_Workshop\scripts\camera_obs.ps1 start                   # Record every camera (one call).
.\Auren_Workshop\scripts\camera_obs.ps1 status                  # Recording state + per-camera file sizes.
.\Auren_Workshop\scripts\camera_obs.ps1 stop                    # End recording, finalise every file.
.\Auren_Workshop\scripts\camera_obs.ps1 down                    # Stop recording, then quit OBS.
.\Auren_Workshop\scripts\camera_obs.ps1 probe                   # Diagnostic dump; decides nothing.
```

Always use the `.ps1`, never `node camera_obs.js` directly: the wrapper resolves node *and* sets
`NODE_PATH`, and without the latter the bare call dies `Cannot find module 'ws'` on **both** machines
(the module tree is a sibling of the repo root, never an ancestor of `Auren_Workshop\camera\`).

**Why the commands split where they do (Law 26).** OBS is a deterministic machine; a generator may
not reach into it while it turns. So the boundary is *state-bound*:

- **OBS stopped** → `configure` authors boot-time internals (the profile, the websocket enable flag,
  `ConfirmOnExit`, the crash sentinel). Legal precisely and only because nothing is running to
  corrupt; OBS validates it at startup, which is the form catch.
- **OBS running** → everything else touches **nothing but obs-websocket**. Scenes, sources and
  filters are *created through it*, never by writing `basic/scenes/*.json`.

That is also why the scene collection is not generated on disk, though it easily could be: it carries
uuids and a canvas id OBS mints itself, so authoring it means deciding values that belong to OBS —
simulation, the deleted guarantee. Creating them through the interface lets OBS decide and this
system *read*, and it survives an OBS schema change instead of breaking on one.

**`up` is idempotent and is the repair path.** It converges on the configured state rather than
merely not-crashing-twice: existing sources have their settings re-asserted. Re-run it after a camera
client restart to re-bind windows.

---

## 5. Diagnosis — the traps, and what each looks like

Diagnostics route to `fleet_logs/traces/watcher_camera_obs.jsonl` (and `watcher_camera_rig.jsonl` for the
director), readable with `trace.ps1` like any other unit.

### 5a. The camera's own trace (`trace_monitor --camera`)

```
node Auren_Bot/monitoring/trace_monitor.js --camera [--bot=AurenBot] [--all]
```

**The camera writes a PARALLEL watcher trace and it is not part of the fleet view** (Architect
2026-08-22: *"everything the scout camera does needs to go on a parallel watcher trace besides the fleet
one for the bots"*). Both records live in `fleet_logs/traces/` under the same filename rule; `trace_read` keeps
the two views apart, because the director re-solves a vantage about once a second and a merged view
buries four bots' story in camera work. `--camera` is the camera view's one reader.

It answers the three questions the footage raises, in that order:

| section | the question it answers |
|---|---|
| the eyes | did the scout connect, where did it PARK to scan, and did the chunks ever stream — a park that timed out means the seeks that followed it were blind, so every figure below is about a world the seeker could not see. Also the deaf window: a raycast makes the client unable to hear the server while it runs |
| moved | every cut by CAUSE — `frame_exit`, `max_hold`, `sightline_lost`, `frame_spoiled`, `better_vantage`, `arrival`, `announcement`, `too_far`, `startup` — with the median shot length beside it |
| held | the decisions that did NOT move the camera: `no_better` (it looked and the standing shot won), `absorbed` (the event was already in frame), `min_hold`, `no_op`. Posted on a CHANGE of reason, never once per seek |
| SUBJECT | could the lens see the bot at all, per siting. Printed above the verdict on purpose: it is the question a reader arrives with, and it is not what the verdict answers |
| sited | where the search LANDED: `clear` (a direction passed the air box and the lens box) / `forced` (none did, the furthest-reaching was taken anyway) / `first_person` / `see_through` / `blind` |
| boxes | air-box and lens-box rejections before a direction was taken — the seeker's only quality bar, so this is the figure that says whether it is set right for the terrain |
| scanned | the cost and the reach: field casts, rays, milliseconds, how many directions came back open and how many were roomy enough to stand a camera in |
| `--all` | every cut in order, from → to, with its held time and the bot's job |

**Reading the canopy complaint with it.** A run whose footage is leaves shows one of three shapes, and
they have different fixes: `SUBJECT` low means the bot itself was behind blocks — the terrain is the
problem; `sited: forced` dominant while the `boxes` counts climb means the air box and the lens box are
too strict for that terrain and the seeker is being starved by its own guards; and `30° RELAXED` on most
sitings means consecutive shots are near-identical because no bearing differed enough. A run of
`first_person` verdicts is not a fault at all — it is a bot in a one-block corridor, or the thrash guard
holding the camera off a shot that keeps dying on arrival.

**Both registers are written for every decision, deliberately.** The prose line is for a person scrolling
the trace; the `crew_log` event beside it is for this lens. That is two renderings of one fact, which is
normally the redundancy Law 16 forbids — it is legal here for the reason Law 26 gives: one of the two
readers is a machine, and the alternative is a lens parsing English.

| Symptom | Cause | Fix |
|---|---|---|
| `up` hangs, never reaches the websocket | OBS found a stale `.sentinel` and is blocking on the **safe-mode dialog** before the websocket opens | `up` clears it automatically. If hand-launching OBS, delete `tools/OBS/config/obs-studio/.sentinel` first. `--disable-shutdown-check` does **not** suppress this — it is inert |
| `N/3 camera window(s) bound`, N < 3 | A camera client isn't running, or its window isn't titled yet | Confirm the titler is alive and the window title is exactly `Cam_<Bot>`, then re-run `up` |
| `start` reports fewer files than cameras | A Source Record filter isn't writing — almost always an unbound window | Re-run `up` with the camera windows open, then `start` |
| Footage is 30 or 10 FPS on every window except the focused one | Minecraft's `InactivityFpsLimiter` throttles a window with no input — and an unfocused window has none, by definition | `inactivityFpsLimit:minimized` in `options.txt`, asserted by `start_cameras.ps1` every run. **Distinct from `pauseOnLostFocus`**, which only governs the pause menu |
| Camera window records a frozen pause menu | `pauseOnLostFocus` | Also asserted every run by `start_cameras.ps1` |
| Wrong camera in a file / cameras appear to swap | Window titles not unique or not stable | The titler owns this. Titles are derived from bot identity, never launch order or screen position |

**A recording is never claimed on the strength of a command returning.** `start` polls the real files
on disk and reports how many are actually growing, because a `StartRecord` that succeeds while every
filter sits unbound would otherwise report a clean success and hand back black video (Law 25).

**`down` normally force-quits OBS, and that is not a fault.** OBS ignores a close request here; the
recording has already been stopped and every file finalised before the kill, the container survives
unclean death by design, and the sentinel clears on the next `up`. It is reported at summary level
deliberately — warning on every teardown would train the reader to skip the one that matters.

---

## 6. Where footage lands

`footage/` at the repo root, gitignored: footage is output, not source. OBS writes one file per camera
named `Cam_<Bot>_<date>_<time>` directly into it, and **loose files there are what OBS has just
finished writing and nothing else** — the run's teardown wraps them (§6a) and after that:

```
footage/
  2026-08-16_13-28-29/          <- A TAKE IS A FOLDER: one recording, entire
      Cam_AurenBot_….mp4        captures (moved here at teardown)
      Cam_TessaBot_….mp4
      Cam_Architect_….mp4
      watcher_AurenBot.jsonl    the record that explains them (copied)
      watcher_TessaBot.jsonl
      take.json                 the manifest: each camera's anchor
      clips/                    shot list + cut candidates
  edit/<project>/               edit plans and renders
  music/                        shared beds
  _trigger/                     OBS's own recording — not footage, see below
```

**A take is one thing you can point at, open, move or delete.** With the files loose there was nothing
to list but a pile of mp4s whose grouping had to be re-derived by timestamp clustering on every read,
and the editing surface had no way to ask *which recording*. `take.json` is the test: a folder without
one is not a take, whatever it is named.

**The main OBS recording is not in there, and is not footage.** It lands in `footage/_trigger/`, and
it exists only because the Source Record filters run in "Recording" mode: they write while OBS's own
recording is active, which is what makes one `start` enough for N cameras. Its picture is whichever
camera sits topmost in the scene, so at full quality it was an exact duplicate of one deliverable —
measured at 1.8 GB per 25-minute take. It now runs at a deliberately unwatchable bitrate (`trigger`
in `camera_configure.js`), because nothing reads it. Delete that folder's contents whenever you like;
nothing downstream refers to it.

Canvas, fps, bitrate, container and encoder are decisions, and they live in the `obs:` block of
`camera/camera_configure.js` — tracked, so they travel between machines. The encoder is `auto` by
default and is **measured** from OBS's own log (which encoder actually initialised on this machine),
never inferred from the GPU model.

### 6a. Wrapping — automatic, nothing to remember

**A recorded run wraps itself as the last step of its teardown.** There is no verb to remember, because
the deadline is not this run's end but the *next* run's start: every bot's trace is overwritten when the
fleet is raised again. The take survives that; the record of what is *in* it does not, and footage
nobody can index is footage nobody can cut. `record_overlay`'s teardown therefore closes that lifecycle
itself (Law 8) — it moves the captures into `footage/<takeKey>/`, copies each bot's trace in beside
them, and writes `take.json` holding every camera's anchor (filename, start, duration, drift).

**The captures are MOVED and the records are COPIED, and the asymmetry is deliberate.** A capture has
exactly one home and that is the take folder — a rename inside one volume, so a 3 GB file costs nothing
to relocate. A trace's live copy belongs to the fleet's debugging loop, which has nothing to do with
filming and must not change behaviour because a camera was running; it keeps being overwritten on its
own schedule and the take gets its own copy. A recorded run therefore leaves two copies of each trace
by design: one is working state with a lifetime of one run, the other is evidence with the lifetime of
its footage.

**Only the watcher trace is kept** (Architect 2026-08-17: *"i only want it to look at the watcher trace.
the battlestations and cpu/gpu ones are all noise even the overseer"*). The combat journal was redundant
rather than merely unwanted — battle_stations posts its own engagements to the trace, so a fight's
extent is already in the file a take must keep, and a second record of one fact is the duplicate pathway
Law 16 forbids. That argument was carried to its end on 2026-08-22: the journal is deleted fleet-wide,
and `combat_lens.fightSpansFromTrace` (which the cutting room already used) reads the trace's own lines. The machine-load sample, the witness and the overseer stream answer questions about a
RUN rather than about a take; they stay live where the diagnostics that want them already look.

**A take keeps the WHOLE crew's traces, not only the bots that held a camera** (Architect 2026-09-07:
*"make sure that the watcher trace for all bots are saved along with the run. it didnt happen this
time"*). The set is the roster from `architect_config.BOT_SENIORITY`, plus the foreman, plus whoever held
a camera — unioned, so a take can never keep less than it used to.

That was the camera set alone until 2026-09-07, and it was correct exactly as long as filming meant one
camera per bot. **The let's play seat ended that identity**: he plays, one camera records his own window,
and the contractors work off-screen. Such a take asked for exactly one trace — `Architect_Control`, a
human seat that by design has none — kept nothing, and printed the same calm `absent (not an error)` line
that exists for that seat. Two takes were wrapped with `"records": []` before it was noticed, and the
cutting room drew an empty *what happened* rail on thirteen minutes of contractor work. The other half of
the same fault: this tool was reading `js_kernel/` when the traces had moved to `fleet_logs/traces/`.
**A wrap that keeps nothing now says so loudly** rather than filing it under the absence that is normal.

The foreman is in, though it is staff rather than a bot and is deliberately absent from the roster: in a
let's play the hire *is* the episode, and its trace is the only record of what was asked and who took it.
A roster bot that never joined is not reported absent — absence is only interesting for a bot the footage
names, and listing the eighteen who were never hired would bury the one entry that means something.

A wrapped take is never rewritten — a second wrap refuses rather than overwriting it with a different
run's records, which is also what makes the automatic call safe to repeat. The repair path, for a run
that closed some other way (a crash, a hand-started crew, an OBS driven from its own window):

```
node Auren_Workshop/tools/footage_clipper.js wrap
```

**A take does not travel between the two workstations**, because `footage/` is gitignored. Records used
to live in a tracked `takes/` at the repo root precisely so one could — records are kilobytes, footage
is gigabytes. That property is now void rather than merely unused: the editing surface scrubs the actual
video, so a record arriving without its footage plans nothing. A take is edited on the machine that
filmed it.


### 6b. Editing a take — the editor is a separate tool, and it is not in this download

**Filming ends here.** Everything above is the camera stack, which ships with the bot: it raises the
clients, drives OBS, wraps the take and writes the manifest. Turning that take into a video is a
different tool with a different owner.

**That tool is `Cutting_room/`, and it is not part of the published bot.** If you downloaded Auren, you
have every camera command on this page and none of the editing ones — the take in `footage/<stamp>/` is a
finished, self-describing folder (captures, traces, `take.json`, `clips/`), so cut it with whatever editor
you already use. Nothing about the footage needs our editor to be readable.

**Its full operating procedure — 780 lines, §6b to §6m — moved to `Cutting_room/cutting_runbook.md`**
(2026-09-11). It stood here and told the reader to run `node Cutting_room/…` and
`.\Cutting_room\cutting_room.ps1`, commands that cannot work in a copy that has no such folder. The
dependency runs one way: the editor reads the bot, the bot never reads the editor, and **a document in the
bot should not send you into the editor either.** `preflight`'s layer-separation pass now holds that line.

## 7. Adding a bot

Nothing here needs editing. Add the bot to `BOT_SENIORITY` in `Thinking_fragments/architect_config.js`
— the single source (Law 16) — and its camera instance, its window title, its OBS source, its Source
Record filter and its output file all follow automatically. That is the whole point of the system:
**camera count is a parameter, not an operator cost.**

---

## 8. The Architect's eye — a camera nothing directs, raised only when asked for

**OFF BY DEFAULT. Turn it on in `camera_configure.js` — `architect.enable: true` — and every route reads
it.** The conductor's `--architect` flag was retired on 2026-08-25 with the rest of the run options: which
camera seats exist is this file's answer and always was, and a flag that overrode it was a second answer to
a one-owner question (Law 16). The routes below still take it because none of them has an authored run
behind it to read.

```
node Auren_Workshop/tools/lanista_conductor.js ladder record --architect
# the same, as a configured run: record: 'film' on run_config.js (the Architect's eye is a camera_configure setting)
node Auren_Workshop/run.js
.\Auren_Workshop\scripts\start_cameras.ps1 -Framing -Architect
```

To have it on **standing**, set `architect.enable: true` in `camera/camera_configure.js` — that is the one
declaration every consumer reads, and `--architect=off` still overrides it for a single run.

`Cam_Architect` is one more spectator client, built and launched exactly like a bot camera (same vanilla
instance and resource packs, same 1920×1080 pin, same unique window title, its own OBS capture and its own
file). What makes it
the Architect's is an **absence**: it is passed to the director as `--freecams`, never as `--bots`, so it
never enters the rig's shot list and no cut, teleport or gimbal bind can reach it. The rig sends it exactly
two commands, once — `gamemode spectator` and infinite night vision — and then nothing for the rest of the
run. A human flies it.

The exclusion is expressed as two separate lists in the launcher rather than as a rule inside the rig,
because a rule inside the rig is a promise a later edit can weaken, and a name that was never passed cannot
be commanded at all.

**It is EQUIPPED, not directed — and that is the difference between this seat and every other client.**
The rig grants it three capabilities once and then issues no instruction: **spectator** (it cannot fall,
die, or block a mob), **night vision** (a night flight is usable), and **operator** (the human flying it
can act). It is also the one camera whose **chat stays visible** — every directed camera runs
`chatVisibility:2` so no system message lands in a shot, but hiding it here removed the only input channel
a human in that window has. Architect, 2026-08-16: *"i need to be able to teleport to bots i want to look
at or maybe even change a setting like daytime, i could also spawn monsters if i want... its a free thing
for me to use as i see fit."* So from inside that window:

```
/tp @s AurenBot          fly to a bot you have lost sight of
/time set day            or  /time set night
/gamemode creative       stop spectating and build, place, break
/summon zombie ~ ~ ~     put something in front of a bot and watch what it does
```

`chatVisibility` is `0` (shown) rather than `1` (commands only), because "commands only" hides the
**response** — a refused teleport would look identical to one that worked. The `op` is re-issued on every
run rather than set once by hand: it persists in the server's `ops.json`, so re-arming is idempotent and
self-healing, and a grant lost to a server reinstall repairs itself instead of failing at the moment it is
needed (Invariant B — re-assert, never trust a remembered grant).

**WHY IT DEFAULTS OFF, and why the pairing ruling that preceded it was right at the time.** From
2026-08-16 the eye was welded to every crew: *"there will never be a time where there are cameras without
my controllable one. so pair it all together permanently."* — and while a filming session was a few
minutes of watching the director work, that was true. It stopped being true when runs became soaks:
**a 45-minute run needs 45 minutes of flying**, and the Architect is not the operator of his own record.
The seat is now the only one in the crew that produces nothing unless a human is in it for the whole run;
every other camera is directed and its footage exists whether anyone is watching or not. A cost with no
product is exactly what Law 13's default-stopped names, so the switch came back — and the constraint that
justified deleting it (a switch implies a legitimate off position) is satisfied rather than overruled,
because the off position is now the ordinary one. The re-tune happened at the table, not at the pedal
(Law 21).

**The switch has to reach BOTH raisers, and that is the trap this design exists to avoid.** The launcher
builds the window; `camera_obs` binds its capture and its Source Record filter. If only one of them hears
the switch, nothing throws and nothing warns: an unbound window renders beautifully and writes no file, and
a capture bound to a client that never launched reports a clean start over a black one. Both are only
discovered after the run. So `record_overlay` parses the flag once and passes the **same value** to
`start_cameras.ps1 -Architect` and to `camera_obs.ps1 --architect=on|off`; `up` then records the camera set
it actually bound, and `start`/`stop`/`status` read that record rather than re-deciding (Law 16).

```
.\Auren_Workshop\scripts\start_cameras.ps1                     # N bot cameras + director + titler, NO eye
.\Auren_Workshop\scripts\start_cameras.ps1 -Architect          # …and the seat you fly
.\Auren_Workshop\scripts\start_cameras.ps1 -Framing            # director with framing ON (config default is off)
.\Auren_Workshop\scripts\start_cameras.ps1 -Down               # reap the clients + director this script raised
.\Auren_Workshop\scripts\camera_obs.ps1 up --count=2 --architect=on   # bind the eye's capture too
```

`-Down` is the half of Law 8 that was missing: this script raises the camera clients, a director and a
titler, and `fleet_control down` knows about none of them — so before it existed every filmed run left
camera windows and a director standing. Matching is by **command line** (the instance path for a client,
`camera_rig.js` for the director), the same order-independent discriminator the titler uses. The titler is
deliberately **not** killed: it exits on its own the pass after the last window goes.

Its name is declared once, in `camera_configure.js` (`architect.camName`), and read from there by all three
consumers — the launcher, the rig and OBS (Law 16).

---

## 9. THE LET'S PLAY — a seat you PLAY, your voice on its file, and a camera per contractor

> *"local server standard record test… means you roll back the server, start it up, start up a client for
> me to control and have obs record it. it should also record my mic… just client window and microphone.
> then ill call foreman get and get 2 bots, they start up and with their start also starts cameras that are
> recording. i want two types. a watch where theres no recording so we can test and a record where you
> actually record everything."* — Architect, 2026-09-06

**Two commands, and nothing else to remember.**

```
node Auren_Workshop/fleet_control.js run letsplay-watch      # the REHEARSAL — every window, nothing written
node Auren_Workshop/fleet_control.js run letsplay-record     # the TAKE
node Auren_Workshop/fleet_control.js down                    # ends the take AND the world, one command
```

Each one rolls the world back to `sub_agent_01_fresh_start`, wipes HQ cold, sets dawn, raises the overseer
and the foreman with **no bots**, opens the seat you play, and starts the warden. Then you play, and you say
`foreman get` in chat when you want a crew. The run is **untimed** — nothing ends it but you.

### 9a. Three seats now, and they differ in one property each

| | directed camera | the Architect's eye | **the host seat** |
|---|---|---|---|
| passed to the rig as | `--bots` | `--freecams` | **`--present`** |
| what the rig does to it | places it, cuts it, binds a gimbal | spectator + night vision + op, once | **one read: "are you standing yet"** |
| gamemode | spectator | spectator | **whatever the server gave you — you PLAY** |
| chat | hidden (`chatVisibility:2`) | shown | **shown** |
| joins as | `Cam_<Bot>` | `Cam_Architect` | **your real name** (`host.playerName`) |
| its file carries | that window's own sound | that window's own sound | **that window + your microphone** |

**The host is not the eye with a flag, and the difference is the one property that decides whether a client
may act in the world.** The eye is a spectator on purpose — it cannot fall, die, block a mob or change the
world the run is measuring. A presenter must do all four: he mines, he builds, he dies, he hires a crew. So
it is a third declaration rather than a mode on the second.

**It joins under a real name, and that is load-bearing.** `foreman get` stamps the asker's name onto every
contractor it launches, so a seat joined under an invented name would hire a crew that answers to somebody
who is not you — and could not run `/time set day` from inside its own window either. The name is
`host.playerName` in `camera_configure.js` and it must be one the server ops
(`MinecraftServer/ops.json`). It is `KaptainKrispyjr`.

**Its settings are seeded from your real game, once, at creation.** `%APPDATA%\.minecraft\options.txt` is
copied into the instance the first time it is built — keybinds, sensitivity, FOV, GUI scale — so the seat
feels like your game rather than a bare install. **Never re-asserted afterwards**, unlike every other option
this launcher owns: those are footage settings nothing else owns, these are your preferences, and a launcher
that copied them back each run would silently undo whatever you changed last session.

### 9b. The microphone: how it travels, and the ONE command that proves it

**Your voice reaches your file on a mixer track, and it took two keys, not one.** Measured 2026-09-06
against the installed obs-source-record:

| filter settings | measured |
|---|---|
| `audio_track: 2` alone | **−91.0 dB — inert.** Digital silence, while a tone on that same track reached the main recording at −21.1 dB in the same pass |
| `different_audio: true` + `audio_track: 2` | **−21.1 dB — works.** The file carries the mixer track exactly |
| `different_audio: true` + `audio_source: <name>` | −21.1 dB — works, but carries ONE source; no good here, this file needs the window and the voice mixed |

So `up --host=on` asserts four things, and **all four fail silently**: the mic unmuted, the mic on track 2,
the host window on track 2, and the filter told to read track 2. Every bot camera is pinned to track 1 alone
so no other window can bleed under your commentary. **Desktop audio stays muted whether the host seat is up
or not** — "just the client window and the microphone" is a rule about what may reach a take, so the
machine's own output (a browser, a notification) is never in the set.

```
.\Auren_Workshop\scripts\camera_obs.ps1 status                 # reads all four back OFF OBS: "voice WIRED" or "BROKEN"
.\Auren_Workshop\scripts\camera_obs.ps1 miccheck --host=on     # records 8s, MEASURES the file, deletes it
```

**Run `miccheck` before a take you care about.** It is the only thing that can answer the question, because
a microphone that is present, unmuted, correctly routed and reported healthy by every call in the stack can
still be recording nothing. **This box carries several VIRTUAL microphones** — Steam Streaming Microphone,
Virtual Desktop Audio, an Oculus headset — devices that answer as a microphone and emit digital silence, and
any of them can be the Windows default. `−91.0 dB` is the signature: a live mic in a silent room sits well
above it. Name the right device in `camera_configure.js` → `host.micDevice` if the default is wrong.

> This project has already shipped this exact failure once: every take filmed before 2026-08-20 carries an
> AAC track measuring −91 dB mean *and* max. A real stream containing nothing, indistinguishable from a
> quiet one until something tried to duck under it.

### 9c. The camera warden — a camera for a bot that did not exist when the run started

`tools/camera_warden.js`, raised by the overlay on every filmed run and reaped with it.

**It watches the world, not the launcher.** It asks the overseer's registry who is standing, every 6
seconds, and gives a camera to anyone who has none. That covers `foreman get`, a hand `bot-start`, a revive,
and anything not yet written — because none of them is what it is watching.

**The obvious wiring — a hook in `foreman get` — is wrong twice.** `bot-start` returns when the PROCESS is
launched; a body enters the registry only after it connects, spawns and `master_core` initialises, seconds
later. A camera raised on the launcher's return is aimed at a bot that is not in the world yet — the exact
defect the foreman's own crew loop was rebuilt to fix. And it would put the film crew inside the fleet's
pathways, so a run's behaviour would depend on whether it was being filmed, which is the one thing filming
must never do (§1).

**Per attach, in this order, every step an existing owner:**

```
start_cameras.ps1 -Bots <every standing bot> -Add    build + launch what is missing, restart director + titler
camera_obs.ps1 up   --bots=<the same set>            create + bind the new capture and its filter
camera_obs.ps1 start                                 (record only) prove the new file is really writing
```

**A filter created mid-recording DOES write, and that was measured rather than assumed** (2026-09-06): a
Source Record filter created 7 seconds after `StartRecord` began writing immediately — 3.1 MB on disk 14s
later, while the already-running capture kept growing untouched. Had that gone the other way, every
contractor you hired would have split your own file in two.

**`-Add` converges rather than adds.** The caller passes the whole set it wants standing; the launcher
starts only what is missing and restarts the director and titler over all of it. That makes the call its own
repair path — a client that died in between is relaunched by the same pass that adds the new one. The
director and titler are **restarted, not extended**, because both take their roster once at launch and never
re-read it: a late camera would otherwise never be armed and never be titled, and an untitled window is
exactly what OBS cannot bind. The cost is a few seconds' gap in camera *movement* and nothing at all in the
recording — OBS holds the windows, not the director, so every file keeps writing across the restart.

**It attaches only. A camera is never taken down mid-take.** A dismissed contractor leaves the registry and
its camera goes on filming an empty vantage until the take ends: that costs disk and nothing else, whereas
reaping it would mean killing a client whose Source Record filter is mid-file, and a file no muxer closed is
the expensive failure — expensive because you find it after the episode. The whole crew comes down together,
in order, at teardown. The registry is the right sensor for this too: it holds CONNECTION, not life, so a
bot that merely **died** keeps its camera and only one that genuinely left drops out.

**There is a ceiling, and it counts WINDOWS.** `--max-cameras`, default 6, including the host seat and the
eye — they are on the same GPU. Past it the warden names the bots it is **not** filming and keeps going,
once each, rather than silently filming some of them.

### 9d. What to check when a let's play goes wrong

| Symptom | Where to look |
|---|---|
| the run says it is up and no window opened | `record_overlay.js status` — is the warden UP? Then `tools\camera_launch_logs\Cam_Architect_Control.*.log` |
| your window records, and has no voice | `camera_obs.ps1 status` → the `voice WIRED / BROKEN` line names which of the four facts failed |
| your voice is there and it is silence | `miccheck` — wrong device. `host.micDevice` in `camera_configure.js` |
| you said `foreman get`, bots came, no cameras | the warden's own window: it prints every attach and every refusal. A ceiling refusal says so by name |
| a contractor's camera is black | its window was bound before it finished loading — `camera_obs.ps1 up --bots=<all> --host=on` re-binds |
| the run refuses before anything opens | `AUREN_SERVER_HOST` points off this box. Every camera joins `127.0.0.1`, so the overlay refuses rather than filming an empty world |
