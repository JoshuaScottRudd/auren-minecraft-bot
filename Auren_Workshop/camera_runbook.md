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

### 6b. Editing a take — the cutting room

**The editor lives at `Cutting_room/`, not inside `Auren_Bot/`.** It is not bot code, and `Auren_Bot/` is
the unit that gets extracted and shared. The dependency runs one way — the editor reads the bot's trace
and takes; nothing in the bot requires the editor. `Cutting_room/README.md` holds that rule and the
folder's contents.


```
.\Cutting_room\cutting_room.ps1
```

One command: it starts the server, opens the editor in the browser, and **stops the server when the page
closes**. Flags forward through — `--take=<key>` to skip the shelf, `--port=7831`, `--no-open`.

**It asks two questions before it will edit anything: WHICH CAPTURE, then WHICH CUT** — and each answer
navigates. The cutting room is **a page per surface**, not one page with a mode:

| served at | is |
|---|---|
| `/` | the entry — saved work first, then the two questions |
| `/letsplay?take=<key>` | the let's play surface |
| `/highlight?take=<key>` | the highlight surface |
| `/thumbnail?take=<key>&profile=<p>` | words onto captured frames |
| `/preview?take=<key>&profile=<p>` | the whole cut in one piece, and the music and voice that go on it |
| `/room_common.js`, `/room_common.css` | what they share — clock format, fault reporter, lifeline, model fetch, the teaser slider, the desk client, commit |

One page that built one of two surfaces and hid the other is a page whose every function has to ask which
mode it is in, and it went past a thousand lines on the way to being two editors in a trench coat. Split,
neither surface can render the other's controls, because the other's controls are not in its document. The
shared half is *served* rather than copied into both — a copy is the duplicate pathway Law 16 forbids, and
it is no less one for being HTML. Every page is checked at startup, so a missing surface is a refusal to
start rather than a 404 arriving in the middle of an edit.

**The two profiles are two different jobs, and only one of them is ever built.**

| | let's play | highlight reel |
|---|---|---|
| the operation | choosing a window of content | judging clips, then ordering them |
| the stage | **every camera at once, equal size**, tiles sized from how many cameras the take has | **empty until a clip is opened** — one clip at a time, at full size |
| reading the clips | a **vertical list of even-height rows** down the side — every clip gets the same room for its name | a **vertical numbered reel** down the side, in the order they render |
| moving through it | **one slider drives all of them** — they are locked to master time, so a single drag scrubs the whole take in unison | **review the next unjudged clip**, or click one in the reel — either opens the **inspector**, which loops inside that clip's own bounds |
| the verb | pick the IN/OUT window; camera changes are free inside it, and a slow stretch is **sped up** rather than removed | **approve or reject** each clip (`A` / `R`), which advances to the next unjudged one |
| the output | one contiguous window, refused by the server if it skips time | the **reel strip**: approved clips, numbered, dragged into the order they render in |

**The clip lists are vertical and evenly sized, and that replaced a lane diagram drawn to scale.** A
proportional timeline is the honest picture of a take and a useless one to read: a 40-second job inside a
25-minute capture is a three-pixel sliver, so the token — the one thing the decision is actually made on —
could never be drawn inside it. Equal-height rows give every clip the same room for its name whatever its
length, and the length is stated as a number instead, which is more precise than a width nobody can
measure by eye. What is still drawn to scale is one wordless strip under the transport (the window, the
camera assignment, the playhead), where the sliver problem does not apply because it carries no text.

Nothing is being cut in a let's play — that is why every camera is on screen at equal size rather than one
big monitor and two thumbnails. A big-plus-small layout answers "which one am I cutting to", which is not
the question being asked, and it makes two of the three cameras unwatchable. Tile size is *solved* against
the space available rather than tabulated, so a take filmed with six cameras needs no new rule written.

A highlight reel's clips are the blocks the server marked `candidate`. **Every mining, building and
farming block is offered whatever its length, and cut at full extent** (Architect 2026-08-18: *"those are
the exercutors that really pop and show stuff going on. so the entire capture of those executors plus 2
seconds on either side"*) — the 30-second floor is a filter against fetch errands, and a short mining block
is not a fetch errand. Everywhere else the walk to the job is still dropped and the cut opens at the
executor; for these three, and for fights, the walk is kept because the whole thing is watchable. Supply
and everything else keeps the floor. **Fights arrive already approved** and can still be rejected:
always-in survives as the default rather than as a lock. The reel's order is sent *as arranged* and the
server converts without sorting, so the list is the sequence that renders.

**Every clip has two angles, because every filmed moment had two seats** (Architect: *"a capture of one bot
is always 2 cameras. the bot and the architect"*). The inspector offers the bot's own camera and the
Architect's eye, and switching between them is a *seek* rather than a reload — both files share master
time, so the second angle opens on the same second the first was showing, which is the only way comparing
them is worth doing. A seat is identified by the **absence of a trace**, not by the name `Architect`: a
rule that matched the name would silently stop offering the angle the day a second seat is flown.

### 6b-bis. Speed: what a slow stretch gets in a let's play instead of a cut

> *"i want a speed up tool. so after i cut a section i should be able to speed it up and speeding things
> up cuts the mic audio and game audio. not the music overlay… in a lets play you dont remove parts, you
> speed up slow parts."* — Architect, 2026-09-07

**A let's play compresses a slow stretch; it never removes one.** That is what keeps the format's claim
true: the window is continuous footage, and a section run at 8x still occupies every second of master
time it spans. Thirteen minutes of capture becomes an eight-minute episode with nothing skipped, and the
server's contiguity check passes untouched — which is why speed was the right tool to add here rather
than the reel's `✂ cut out`.

**The gesture is two presses, deliberately the same shape as the reel's cut-out.** Park on the start of
the slow stretch, press **⏩** (or `S`); park on the end, press again. The button says what the *next*
press will do. `Esc` drops a half-made mark. Nothing is removed either way.

**The rate is chosen before or after.** The row of rate buttons — 1x, 1.5x, 2x, 3x, 4x, 6x, 8x, 12x, 16x
— arms the *next* span, and while the playhead is standing inside an existing span those same buttons
**retune that span**, so watching a stretch back and finding 4x too slow is one click rather than
re-marking both ends. **1x is how a span is put back**, and it is also what the `✕` on each row does.

**A sped-up span is SILENT, and that is a rule rather than a setting.** The camera's own track *is* the
two things being dropped — on your seat it carries the game window and your microphone together — so one
mute drops both. **The music bed plays straight over it**, because the bed is mixed in a separate pass
over the already-joined film and never knew the span was there. That is the montage convention, and it
fell out of the two-pass architecture rather than needing anything built. Sped-up speech was considered
and rejected: there is no rate at which it is something an audience wants to hear.

**Two numbers on the side panel, and they are different questions.** *Selected* is how much footage the
window holds. *Runtime* is how long the finished video is, with every span's compression already counted,
and the difference is shown beside it. They were the same number until speed existed.

**Measured, 2026-09-07**, on a plan carrying one 8x section: a 40-second window rendered as 5 seconds
exactly, the finished file's duration matched the plan's arithmetic, and `volumedetect` read −91.0 dB
mean *and* max across the sped span (digital silence) against −24 dB on the sections either side. With a
bed on the same cut, that span measured −36 dB — the bed alone, at its configured level, and nothing
else.

**The rates live in one place.** `Cutting_room/edit_tuning.js` declares `SPEEDS`; the page builds its
buttons from it, the commit refuses anything outside it, and the renderer refuses a hand-typed plan line
outside it. A rate offered by a button that no plan could carry would be a refused commit an hour later.

**In a hand-written plan** the key is `speed:` on a `[clip]` block — `speed: 8` or `speed: 8x`. Leave the
line off for normal speed.

### 6b-ter. Dead air at the two ends is REMOVED, and it always was

**The window's two marks are the trim.** Park on the moment the episode really starts and press **I**;
park on the moment it really ends and press **O**. Everything before IN and after OUT is dropped, and the
panel states what came off as `1m30s head · 1m53s tail` so both marks can be checked without scrubbing
back. `Whole take` puts it back.

This needed no new tool — it needed the panel to admit it had one. The hint used to read *"camera changes
are free, skipping time is not"*, which is true of the MIDDLE and reads as a rule about the whole take, so
the surface was asking to be given a cut verb it already had (Architect 2026-09-07: *"i need the cut out a
section for the start and end dead air. the middle meat is uninterrupted but before i start and after i
stop is all dead air"*). Proven on a 13m33s take: IN at 90s and OUT at 700s produced a plan body of
`00:01:30 -> 00:11:40` with no contiguity complaint, because one window is trivially contiguous.

**The middle is still not cuttable, and that is the format** (§6b-bis). Head and tail are outside the run
rather than inside it — nothing is being hidden from the viewer by declining to film the walk to the
chair. A slow stretch *within* the episode is sped up.

### 6b-quater. What happened lists the whole crew, camera or not

**The rail is every bot the take has a record for, not every bot with an angle.** In a let's play that is
mostly bots he cannot cut to — one camera, his own — and their rows are worth more here than on a reel,
not less: knowing a contractor was mining through a stretch is exactly what decides whether it gets sped
up, narrated over, or walked to. An off-camera bot's name carries a dashed underline, and clicking its row
moves the playhead without changing camera.

It drew only camera bots until 2026-09-07, so a let's play rail listed nothing at all. Fixing that exposed
a second fault underneath it: `.clips` is shared with the highlight page, where it is deliberately
`flex:1; min-height:0` because the reel absorbs the panel's slack — but on the let's play page it is the
seventh section of a panel that already overflows, so the slack is zero. Sixty-five rows rendered
correctly into a box **0 pixels tall**, invisible, with no error anywhere. It had been latent since the
page was written and could only surface on the day the rail first had something in it.

### 6c. What arrives in the reel, and the clipping tool

**The reel opens as a first draft, not an empty list.** Every fight and every mining / building / farming
executor is already in it, in take order; supply and the rest start unjudged. Offering those executors as
candidates to be added was the wrong reading of "include" — what MAY be used is not what IS being used. It is a default, not a lock: any of them can still be rejected. What it changes is the direction of
the work — *take out what does not belong* over a reel already shaped like the video, instead of *put in
twenty things* starting from four fights.

**The main window is empty until you open something.** It used to be a grid of every candidate in the
take — thirty-odd tiles, most of them a dark frame and a token, all of it on screen before a single
decision had been made. Nothing is chosen from a wall. Clips arrive one at a time now: **Review the next
unjudged clip** brings the next one, and clicking anything in the running order opens it again. The
resting stage says how many are left and how to get one, so an empty window is a starting point rather
than a question.

**Approved and Rejected are the two lists, and a yes lands visibly.** The side panel names both by the
verdict that fills them, both carry a count, and an approval scrolls its row into view and lights it for a
beat. That is not decoration: the seeded reel is two dozen rows inside a box that scrolls, so a yes is
appended below the fold and, without it, the only evidence of the click is a number changing elsewhere on
the panel. **Approving a clip that is already approved leaves it where it is** — appending is for a clip
approved *late*, and moving one that already had a place made the row he was watching disappear.

**Nothing is cut in the cutting room.** The clipping tool is a *selection*: drag on the strip under the player
(or `I` / `O` at the playhead) to mark what to keep, and the range is remembered against that clip.
Approving saves a decision, not a file. Every trim and every join happens once, at render, from the plan
(Architect 2026-08-18: *"i dont want it to be done right away ... all the clipping and stitching is done at
the end"*).

Each clip therefore carries **two ranges, and keeping them apart is what holds the edges uniform**:

- the **core** — what he is keeping. The whole block by default, his selection once he drags one.
- the **cut** — the core with the pad added *outside* it. This is what renders.

So trimming never eats into the transition margin, and retuning the pad never moves what he chose to keep.
The strip draws three nested things, so what renders and what he keeps are never the same picture: the
strip itself is the **frame** (the whole block plus pad, and it never moves), the hatched band inside it is
what **renders**, and the green band inside that is what he **keeps**. Playback loops the *selection* — what
he is judging is exactly what he is keeping — while the transport spans the frame, so he can always scrub
back out to check whether the cut landed in the right place. A trimmed clip is marked `✂` in the reel,
because a saved trim nobody can see is one nobody can undo.

**Each handle moves its own edge and nothing else.** The frame is fixed for exactly this reason: the strip
used to be drawn against the padded *cut*, which is recomputed from the selection — so every mousemove
edited the ruler it was being measured with, the anchored edge got re-projected onto a new scale, and
dragging one handle appeared to move both. A ruler derived from the thing it measures is not a ruler. The
far edge is now read from the live selection rather than carried as an anchor, and a handle dragged past
its neighbour **clamps** instead of swapping — a flip would hand the drag to the other edge mid-gesture,
which is the same complaint in a new costume.

### 6d. The edit's numbers live in one file, and there is a page for them

`Cutting_room/edit_tuning.js` owns the pad, the crossfade, the teaser length, the candidate floor, the
categories cut at full extent, the typeface, where titles sit and what colour they are.
`cutting_room.js`, `edit_renderer.js` and `edit_thumbnail.js` **import** them; nothing retypes a number.

```
node Cutting_room/edit_tuning.js     # prints the current set, and which of them you have changed
```

**The settings page is `/config`** — linked from the bottom of both editing panels. It reads and writes
`Cutting_room/edit_config.json`, which holds **only the values that differ from the defaults**; the
defaults and the reasoning behind them stay in `edit_tuning.js`, which is code the page never touches.
Delete the JSON file and everything returns to stock.

Anything you can set there is a decision the editing pass no longer asks you: the typeface, where titles
land, their colour and size, **how fast a title is read and the shortest it may stay**, the thumbnail's
default colours, the pad, the crossfade, the fade, the teaser length, the reel target and the candidate
floor. The pad and target used to be button rows on the reel's
side panel, re-answered every episode and answered the same way every time; the panel now **states** them
and asks nothing.

**Saving requires a restart of the cutting room to take effect** — the settings are loaded once, at
require-time, by every tool that reads them. The page says so when it saves. A value the module refuses
(a crossfade longer than the pad, a font file that is not on this machine) is **rejected at save time**,
with the module's own message, and the previous file is put back: the check is a real `require` of the
real module in a child process, not a second copy of its rules in the browser.

A pad typed as `2` in the cutting room and again as `2` in the renderer is not one number — it is two that agree
until one is edited, and the failure is the quiet kind: half the edges move, every clip still renders, and
the reel is unevenly paced in a way that reads as a bad export. The file also **refuses a crossfade longer
than the pad** at require-time, because that combination does not fail — it renders, with the fade eating
action instead of the margin the pad exists to give it.

The edge is never per clip. Uneven edges are the thing the uniformity rule exists to prevent, so there is
one number and it applies to every clip and both sides; `/config` is where it is changed.

### 6e. The teaser, and the gate on the commit

**Every cut opens on ONE 5-second teaser, and it is clipped by hand, inside the ordinary pass.** Both
profiles. It is the one place a let's play splices, which is why the contiguity check covers the body
alone.

**On the reel:** open any clip, press **🎬 teaser** (or `E`). The trim and sound rows step aside and a
5-second slider appears in their place, opened on the frame you were already watching. Drag it, or nudge
it a quarter-second at a time. The clip you opened chooses the camera, and the window **cannot leave that
clip** — the cold open is a promise the body keeps, so it comes out of material that is in the body. To
take it from elsewhere, open that clip.

**On a let's play:** park the playhead on the moment and press **🎬 teaser** in the transport row (or `E`).
There are no clips, so the window may come from anywhere in the capture — including material the window
itself excludes. Nothing is hidden by that; a cold open is announced by being one.

**Either way:** the picture loops the five seconds while the slider is up, so what is on screen is what is
being chosen. **Type the words that go over it** in the field under the slider — on a reel the tool will
not accept a cold open without them, and the commit refuses one too (§6f). They used to be filled in with
the clip's own job token, which put `build/headframe` over the first five seconds of the video.
**Use these 5 seconds** stores it in the saved desk. Nothing is cut, no frame is read, no
capture is touched. The **Teaser** panel on the right shows what you have as a frame plus its camera and
timecode, its button opens the slider (and picks a clip for you if none is open — the one the current
teaser came from, else the first fight in the reel), and **✕** clears it.

**The commit is REFUSED without one** — so it is never something to remember. The refusal comes from the
server, in one place, and names the button to press. **The thumbnail is gated the same way** (§6k): an
episode needs a cold open and a picture, both are hand-made, neither can be derived, and the moment either
is optional is the moment one of them is occasionally missing with nothing saying so until the upload.

Two things were deleted rather than kept, both for Law 16. The **derived** cold open — busiest fight plus
busiest executor, scored off the record — went when hand-clipping arrived: two pathways to one thing
disagree the first time you use the second. And the **standalone clipper page** went when the tool moved
inside the reel; the slider is one implementation in `room_common.js`, mounted by both surfaces, so the
reel and the let's play cannot measure a window differently.

### 6f. Words on a clip: required, and the only thing you type is the words

**Every clip in a reel carries a title, and the commit is refused without one.** The side panel counts
what is left under **still to caption**, the reel puts a red **✎?** on each clip that has none, and the
refusal names them clip by clip. The cold open is counted too — its words are typed in the teaser tool.

**On the reel:** open a clip, press **✎ text** (or `W`). The sound row steps aside for a words box, the
place selector, and two readouts: how long the words will be on screen, and what the clip is
(`this clip: build/headframe_execute` — useful for remembering what you are looking at, useless as a
caption, so it is shown and never offered). A band on the clip's strip shows the share of the clip the
words take. Done closes the row.

**You do not set when it starts or how long it stays. Neither number is yours.** It starts when the join
into the clip is over — half a second for a crossfade, a second for the fade from black on the very first
section — because words drawn during a dissolve are half-transparent over two pictures and read as a
fault. It stays for as long as the words take to read: **characters ÷ 15 per second, never under one
second.** A short caption still gets its second, because the eye has to find the words before it can read
them and that cost does not scale down. Both numbers are on `/config` (`titleReadCps`, `titleMinSec`).

The room used to caption an unopened clip with its **job token** — `build/headframe`, `mine/raw_iron` —
the trace's own name for a piece of work, burned into the picture for an audience that has never seen a
job token. That fallback is gone, which is what makes the gate necessary: with nothing standing in, a
clip nobody captioned would render silent, and a reel of correctly rendered wordless clips is a video
that is not what was asked for.

**A let's play is not gated.** It cuts on camera changes inside one continuous take, so its sections are
not separate moments and never carried words; a caption per camera change would be friction, not clarity.

Where they land is a **setting**, not a question: `/config` chooses top / middle / bottom centre once for
the whole channel, and the tool opens on it. The per-clip place selector is there for the shot where the
default sits on something — the plan records the override and nothing else changes.

In the plan this is `text: WORDS @ START-END` on a clip, seconds into that clip, plus ` at PLACE` when the
clip overrides the default. The room writes exactly one per clip, with both seconds already worked out —
the plan states the whole render, so reading it a month later needs nothing else. A hand-written plan may
still repeat the line and choose any span it likes; the format did not change, only who fills it in.

Minecraft gives us **no background to design against** — grass is mid-green on the surface, stone is
mid-grey underground, and the top of frame is often sky. Those are exactly the luminances that make white
type vanish, dark type vanish, and any single chosen colour vanish somewhere. There is no font colour that
survives all three, so the text does not try: it **brings its own background**, a translucent black plate
under white type, with a stroke for the frame where the plate edge lands on something bright. That is why
every broadcaster uses a plate, and it is the reason the style is background-independent by construction
rather than by luck.

One preset for every title in every episode. Colour, size and place come from `/config` and apply to all
of them; there is no per-line typeface, because a look re-decided per line is not a look. The **thumbnail
is set in the same face** for the same reason — a thumbnail in a different typeface than the film it
fronts reads as somebody else's video.

**Verified on rendered frames, both backgrounds:** legible over bright leaves and sky, and over grey stone
in a cave mouth.

### 6g. ffmpeg comes from npm

```
cd Auren_Bot; .\scripts\npm.ps1 install
```

**Not a bare `npm`.** It is on PATH on one machine and not the other, and where it is on PATH it may
belong to something else entirely. `scripts\npm.ps1` resolves the repo's own copy first and says which one
it used — see `scripts\_node.ps1` for the chain and for why a present `npm.cmd` is not a working npm.

`ffmpeg-static` and `ffprobe-static` put real binaries inside `node_modules` — the one install method that
works on a machine where nothing may be installed at the root. `edit_renderer` resolves them from there
first and falls back to a hand-dropped `tools/ffmpeg/bin/`, so a machine that already has one is not made
to re-download. When neither is present the refusal names the command to fix it rather than just the
missing path.

`footage_clipper`'s own `PRE_ROLL_SEC` / `TAIL_SEC` are deliberately *not* this number. They are margins on
the shot-list pathway, sized for a claim that lands before the bot is in position — a different question
from how much material a crossfade needs to consume.

**Do not open `cutting_room.html` from Explorer.** It looks like a page and is not one: loaded over
`file://` it can neither list a directory nor range-request an mp4 — and **video seeking IS range
requests**, so the shelf comes up empty and the player refuses to scrub. Opened that way the page now names
the mistake and the command to use instead, rather than showing the browser's own "Failed to fetch".

**Nothing is left running.** The page holds one connection open for as long as it is on screen; when it
closes the server stops on its own a few seconds later (a reload is well inside that window and does not
trip it).

> **If closing the editor does not stop the server, you have more than one tab.** Every launch opens a
> *new* tab and no launch closes an old one — and a browser reconnects a dropped page connection **by
> itself**. So a tab from three launches ago silently reattaches to whatever room next takes the port and
> holds it open, and the tab you just closed was never the only one. Measured 2026-08-19: a room started
> with `--no-open`, opening no window at all and with nobody touching anything, had **three** lifelines
> attached within six seconds.
>
> Each launch is now stamped with a boot id, and a page that finds itself talking to a *different* room
> than the one that opened it **drops the connection and says so** — "this page is from an editor that has
> already stopped. Close this tab and use the new window." A page whose room died and was not replaced
> says that too, after 12 seconds, instead of looking healthy until you click something.
>
> **One time only:** tabs already open from before this change are running the old page code and cannot
> know any of this. Close them by hand once. If a room is somehow still holding the port, the next launch identifies it, stops it, and takes
the port — only a process that answers as a `cutting_room` is ever stopped; anything else keeps the port
and gets named instead.

### 6h. Voice: the whole narration workflow

**Record at the desk in Windows Sound Recorder. One clip, one file, one button.** There is no timeline to
place it on and no waveform to line up.

1. Commit a plan from the cutting room. Every clip in it already carries the filename its narration should use:
   `# vo: vo_07.m4a`, commented out.
2. Look at the plan. **Under every `# vo:` line the bot has already written down what it did in that
   clip**, in its own words, with the numbers in it — where it felled the tree, how many logs came out,
   which anchor of the build it finished. Decide which clips you want to talk over, and for each one
   read those lines and record yourself saying them in your own words.
3. Save the recording into the *same folder as the plan* under the name written on that clip.
4. Delete the `#` in front of that `vo:` line.
5. Render.

**You never write a line from a blank page.** Every fragment reports to the judge with its variables in
the sentence, and the plan now prints those reports under the clip they belong to. So a narration slot
reads like this, and the comment lines under it are the raw material for the one spoken line:

```
# vo: vo_03.m4a
#   — harvest_executor: felled oak_log @-153,63,77, mined 17
#   — supply_manager: harvested 3x in a row for logs (still short of 12) — replan
```

Six facts maximum per clip; if there were more it says so (`... and N more report(s) in this window`)
rather than quietly showing you the first six. **Architect clips carry no facts** — a human-flown angle
has no record to quote, so its slots are empty by design, not by fault.

**Game audio ducks under your voice automatically**, and the music bed with it — measured on a probe: a
narration window sat 67 dB above the surrounding audio in the same band. `@ 6` after the filename starts
the line 6 seconds into the clip instead of at the top.

**A missing recording never becomes a silent film.** A draft renders without the lines you have not
recorded and *names each one*; a `--final` refuses outright. A recording longer than the clip it sits on is
refused rather than cut mid-sentence.

**Re-recording is cheap.** The segment cache is keyed on everything *except* the voice, so a retake
re-mixes the audio and re-uses every rendered frame. Getting a line wrong costs seconds, not a re-render.

> As of 2026-08-19 the captures in `Footage/` **have no game audio at all** — every camera measures −91 dB,
> which is digital silence. Until OBS is capturing desktop audio, your voice is the only sound the video
> has, and the ducking has nothing to duck.

### 6h-bis. Looking at a page without opening a browser

```
node Cutting_room/photograph_page.js /config
node Cutting_room/photograph_page.js "/thumbnail?take=<take>&profile=highlight"
```

Photographs any cutting-room page into `footage/_shots/` and prints anything the page threw or logged while
it loaded. `--do="<js>"` clicks something first, `--read="<js>"` asks the live page a question, `--size`
and `--port` are there when the defaults are wrong. The cutting room has to be running.

It exists because nothing else can see a rendering fault: a page whose imports resolve, whose elements all
exist and whose routes all answer can still draw nothing at all, and every other check in the repo reports
green while it does. `Auren_Workshop/tools/README.md` carries the reasoning.

### 6i. The editing tools, and the four that were deliberately left out

The reel is an **ordered list of clips**, not a track-based timeline. That is what makes most of a normal
NLE's toolbar unnecessary rather than missing:

| Tool | Where it is |
|---|---|
| Trim in / out | the strip in the inspector — drag either edge, or `I` / `O` at the playhead |
| Cut out (razor) | `✂ cut out` or `S` — press once to mark, again at the other end; what is between goes |
| Playhead | the transport, the strip, and the clock all read the same master time |
| Ripple | free — the reel is a list, so removing a clip closes the gap by definition |
| Cut / crossfade | chosen for you: instant inside one block, crossfade between blocks (§6i) |
| Fade from / to black | automatic on the first and last clip, picture and sound together |
| Audio gain | `off / quiet / normal / loud` per clip in the inspector |
| Words on a clip | `✎ text` or `W` — type them, then `[ start` / `end ]` at the playhead (§6f) |
| Ordering | drag a clip in the reel, or `▲` `▼` |

**Roll, Slip, Slide, Tracks, Transform and Keyframing are not here, on purpose.** Roll edits a boundary two
clips *share* — no two clips here share one. Slide holds a fixed total duration, which a highlight reel
does not have. Slip is the one real omission, and trim plus cut-out covers it. Tracks, transform and
keyframing are where this stops being a selection tool and becomes Premiere. The tool is built for
fundamentals, and a toolbar of things nobody uses is a cost paid on every pass.

**Cut out takes a section out of the MIDDLE of a clip, and it takes two presses.** Press `✂ cut out`
once at one end and a mark stands on the strip — nothing has happened yet. Find the other end, press
again, and everything between the two goes. `Esc` drops a standing mark. The first press is deliberately
consequence-free: both ends have to be *found*, and finding the second means scrubbing, which cannot be
done carefully if the first press already changed the clip underneath.

**What is left is two clips from the same block**, each with its own trim, verdict, sound and place in the
running order. Both keep the whole block as their scrubbing range, so what was removed can still be looked
at and dragged back in. `put it back` on the second one undoes the cut and restores the removed seconds.

**The edge is bounded at a cut, and only at a cut.** Everywhere else the 2s edge runs into footage the
clip was never going to use. At a cut it runs into what was just removed, so each side takes at most
*half the gap* — a 10s removal gives both sides their full 2s and 6s genuinely disappears; a 3s removal
gives each side 1.5s and the two parts meet exactly. Without that bound a short removal comes partly back
and the two parts overlap, playing the same seconds twice.

**To cut away an END, use `[ in` / `out ]` instead** — that is what trim is for, and cut-out refuses a
mark pair that would leave less than a second on either side rather than making a flicker.

**Joins are chosen for you, and there is nothing to set.** Two clips that came out of the same block —
the two halves of a cut-out, or a let's play changing camera — meet on an **instant cut**, like a camera
shift. Moving from one block to another is a **crossfade**. The cold open always dissolves into the body,
whatever the format.

The reason is what a dissolve *says*. Between two blocks it says "time passed here", which is true and is
the dissolve doing its job. Inside one block it is a lie about the same shot: both sides are the same
camera in the same place seconds apart, so cross-dissolving reads as a mistake rather than a transition —
you would be dissolving a scene into itself. An instant join is what an audience already understands as
"something was skipped".

The reel is what knows this: after the edge is trimmed back at a cut the two windows do not even touch, so
a server working from the numbers alone would call a ten-second removal a splice and dissolve across it.

### 6j. The desk saves itself, and the entry page opens it again

**How often it saves.** Every change asks for a save — a click, a drag step, a keystroke. The *write* is
then pushed 600 ms into the future, and each further change pushes it again. So a drag that fires sixty
times writes once, 600 ms after the mouse stops.

**…and never later than 2.5 s after the first unwritten change, however fast you are working.** A
debounce with no ceiling *starves*: while changes keep arriving closer together than the quiet period,
the write keeps being postponed, so working quickly meant working unsaved — and the faster you went, the
longer the desk went unwritten. It presented as the editor "desyncing" under hard use and behaving
perfectly when poked slowly. The ceiling makes the worst case a bounded 2.5 s instead of an unbounded
one.

**And a change still unwritten when the page goes away is flushed on the way out**, by beacon — the one
request a browser finishes after the document is gone. A normal save started during navigation is
cancelled with the page, which is how the last half-second of judging used to vanish when you clicked
through to the thumbnail page or *start over*, and how you could come back to a desk a few decisions older
than the one you left.

**How you can tell.** The line under *Commit* is the only evidence you have, so it says **when**, not just
whether, and the age ticks over on its own:

| The line reads | What is true |
|---|---|
| `saving your last change…` | a change is under the 600 ms timer, or the write is in flight |
| `all work saved · just now · closing this page loses nothing` | it is on disk |
| `all work saved · 8s ago · …` | on disk, and this number keeps climbing — a line that has stopped moving is itself the symptom |
| `NOT SAVED: …` | in red, with the reason, and the work is still on the page — do not close it |

There is no save button, and there is nothing to remember.

**What is saved.** Everything that is a decision, and nothing that can be worked out again from one. Written
to `footage/edit/_sessions/<take>__<profile>.json`.

| Highlight reel | Let's play |
|---|---|
| every approval and rejection | the window — where the keep starts and ends |
| the running order of the reel | every camera change, and where it falls |
| every trim (what you kept of each clip) | which camera is on the cut |
| every cut, and which clip each part came from | |
| the sound level on each clip | |
| the words on a clip, and when they appear | |
| the thumbnail frame, and the words on it | the same |
| which camera angle each clip is cut from | |

**What is not saved, because it is not a decision:** the playhead, which clip is open, scroll position, and
the plan itself. The reel's cut list is rebuilt from the trims and the order every time it is drawn; the
let's play's cut list is rebuilt from the window and the camera changes. A second stored copy of a derived
thing is where the page and the plan start to disagree.

**What is not touched, ever:** your footage, and any plan you have already written.

**"Carry on with saved work" is the first thing on the entry page** when anything is saved. Each row names
the cut, the capture, what is in it (*"22 approved · 9 still to judge · 23m56s of reel"*, or *"10m00s window
(40% of the take) · 1 camera change"*) and when you last touched it. Clicking one opens that page with
every decision back in place. `discard` throws one away — the footage is untouched.

The list is read from the **files themselves**, newest first, not from a remembered index: a session you
delete by hand is gone from it, and one you copy in is on it.

**Keyed by take AND cut.** They are two different jobs on the same footage, so a take can carry a let's play
desk and a highlight desk at once without either touching the other.

**Starting "something new" on a capture you have already worked on says so.** The cut button changes its own
words to *"↩ carrying on — …"* rather than warning beside them, because a screen that says start-new and
then silently reopens an hour-old desk is indistinguishable from a fresh one (Law 25).

A session that will not parse is **listed, marked damaged, and refuses to open** — and the cut it belongs to
is disabled on the next screen with the reason, rather than promising a fresh start the editing page will
not honour. Discard it from the shelf to start that cut over. A session whose capture has left `footage/` is
listed too, marked, and not openable. Both stay visible on purpose: an hour of work vanishing off the shelf
with nothing said is the same failure as never having saved it.

This is **not** the plan. The plan is a finished statement you write on purpose by pressing a button; the
session is the desk left as it was, and the renderer never reads it.

### 6k. The thumbnail: one frame from the cut, with words on it

The thumbnail is a real moment from the video. There is no upload and no generator — the picture can only
be a frame that exists in a camera file, so it cannot promise something the video does not deliver.

**There is exactly ONE, and capturing replaces it.** In either editing page, the picture on screen is a
live frame: press **📷 grab frame** (or `T`) and that instant becomes the thumbnail. Nothing is cut and
nothing is rendered — the server seeks the camera file, reads one frame at full size and writes a PNG
beside the session. Grabbing again overwrites the picture **and keeps the words**, so trying a second
frame does not cost you the headline you arranged.

**You can see it where the commit is.** The **Thumbnail** panel on the right of both editing panels shows
the frame you have, with its camera and timecode, and one click opens the editor. It sits with the Teaser
panel **above** the approved and rejected lists, so both gates stay in view however long those lists get.

**The commit is REFUSED without a frame** — the teaser gate's twin (§6e). The *words* are not gated: a
thumbnail with no headline is a legitimate choice; a video with no thumbnail is a video nobody clicks.

**Putting words on it.** The **Thumbnail** page shows the one picture, big, at the ratio it publishes at.

| Tool | How |
|---|---|
| Add a line of text | **+ add a line of text** — first is a headline, next a kicker, then as many as you want |
| Change the words | Click the block, type in the box |
| Move it | Drag it anywhere on the picture |
| Resize it | The size slider — measured against the frame's height, not in points |
| Fill colour | Six swatches; a new line opens on the channel default from `/config` |
| Outline colour | The same six, chosen separately, so light words on a light frame stay readable |
| Delete a line | **remove this line** on the block |

**Long words wrap, and every row is centred.** A headline too wide for the frame breaks onto a second row,
and a short second row sits under the middle of a long first one rather than under its first letter. The
break is decided **once**, in `Cutting_room/edit_textwrap.js`, and both the preview and the burn-in run
that same file — the page loads it from the tools folder rather than keeping a copy, so the two cannot
break at different columns.

That works because the typeface is monospace, which makes a line's width its length times one character
advance. The advance is **read out of the font file itself** (Consolas advances 0.55em per character,
Cascadia 0.59, Courier 0.60), so changing the typeface in settings moves the wrap with it. A proportional
font is **refused** by the settings page for the same reason: wrapping by character count is not
approximately right for one, it is wrong by whatever the line's letters differ from the average.

**A block stays inside the picture as it grows.** Words are anchored by the middle of the block, so a
headline dragged near the top and then typed into grows upward as well as downward — the position is held
at the edge rather than allowed to walk off it, and the preview and the file hold at the same place. Drag
it back down and it follows again; the anchor is only overridden while the words would leave the frame.

A block **bigger than the picture says so** under its controls — the one case holding cannot fix, and the
only way words can still leave the frame. It is not resized for you; how big a headline is remains your
call.

There is **no typeface control here** — it is one channel-wide setting on `/config` (§6d). Every position
and size is stored as a **fraction of the frame**, and the preview lays out in the same typeface the
burn-in uses at the same fractions, so the browser scaling the picture to fit your screen cannot move a
word relative to the picture. What the preview shows is what the file contains.

**There is no export button.** Committing the cut writes `thumbnail.png` into the same folder as the plan,
from exactly what you see, under the project name the commit already knows — one folder holding both
halves of the episode. A second button would need that name typed again, which is a second chance to type
it differently.

If the burn fails, the commit still reports the plan as written **and says the thumbnail failed and why**.
The plan is the expensive artefact and it is on disk and correct; the picture is one retry away.

The frame and its words are saved with the desk (§6j), keyed by capture **and** cut, by a server-side
merge that touches only the thumbnail field. Grabbing a frame can never disturb the approvals in the reel.

### 6k-bis. The workflow is two pages, and one button between them

**The editor decides what is in the cut. The preview decides what it sounds like and prints it.** There is
one way forward and no way to skip a step.

**On the editor:** name the project — **required**, and the name is the folder, so typing the same one
again is what overwrites the last pass instead of starting a second cut. Then press
**Stitch it → sound & preview**. It writes `edit_plan.md`, burns `thumbnail.png`, starts the stitch, and
**takes you to the preview page**. There is no *write the plan* button any more and no separate preview
link: two routes to one page, one of which re-stitched and one of which did not, is how you end up placing
sound against the previous cut.

If the plan or the thumbnail fails you **stay on the editor**, because that is the only page that can fix
either. Only the stitch is reported on the far side, because only the far side needs it.

**On the preview:** the page opens saying *Stitching the cut…* and starts playing the moment the file
exists. Place the music and voice, then press **🎞 Print the finished film**. That rewrites the plan from
the decisions the editor already made — so the sound goes in and nothing else moves — and renders at full
size with `--final`.

**The stitch carries no music and no voice, deliberately.** The preview page plays the bed itself, ducked
by the same numbers the render uses, so a bed baked into the stitch as well would be heard twice. The plan
still *states* the sound; `--final` is what renders it. It also makes the wait between changes as short as
it can be — no audio pass, no mux.

**`--final` is a harder verdict, not just a bigger one.** A voice line running past the end of the cut is
refused there; in a stitch the question never arises. That is why printing is the button at the end rather
than a tick-box on the one at the start.

**It survives a reload, and it survives closing the tab.** The render belongs to the room, not to the page,
so refreshing mid-render picks the progress back up where it was, and closing the editor does **not** kill
it — the room waits for the render to finish before it stops itself. Only one render runs at a time; a
commit made while one is going still writes its plan and picture, and says plainly that the render did not
start and why.

**Pressing it again overwrites — the same name is the same project.** The project name is part of the
saved desk now, so it comes back on its own when you reopen a cut; it used to be an empty box you retyped
from memory, and a name retyped one character differently is a second folder rather than a correction. A
second commit under the same name rewrites the plan and the thumbnail, re-renders the draft, and **sweeps
the cached segments that no longer belong to the cut** — so the folder describes the video as it is, never
as it has ever been. Nothing you recorded is touched: the audio lives with the take (§6l), not in there.

**Pressing it again asks first — a stitch you already have is not rebuilt for nothing.** The button
compares the decisions on the desk against the ones the last stitch was made from, and there are only three
answers. **Nothing changed** and a stitch exists: it goes straight to the preview and starts no render at
all. **Something changed**: it says so and offers *Re-stitch it* or *Open the old one*, and you choose —
picture edits need the re-stitch, a music decision you left half-made does not. **Never stitched**: it
renders, with nothing to ask about.

**The join is cached, and the join is the part that grows with the video.** Re-encoding one changed clip
costs the same on a twenty-five minute cut as on a five minute one, because only that clip is re-encoded
(§6k). Stitching nine clips into one file does not: it reads and rewrites the whole runtime, so it is the
step that turns a long cut into a long wait. The stitch therefore records what it was made from — which
segments, in which order, joined which way — and skips itself entirely when the answer is unchanged, which
is what leaves a re-run costing seconds instead of minutes. It still **measures the finished file** and
reports its real duration either way; a cached step is a skipped computation, never an assumed result.

**A failed render does not take the plan with it.** The plan and the picture are on disk first, and each of
the three reports its own outcome — a render that fails says so, in red, with the renderer's own words.

### 6l. Sound: game audio on, music off, and where a bed comes from

**Game audio.** Each camera's window capture now takes that window's own sound (`capture_audio`), and
keeps it on that source rather than merging it into desktop audio (`reroute_audio`). The consequence
worth knowing: **camera N records the world as heard at bot N**, matching the picture it is cut against.
Merged desktop audio would have given every camera the same mix of all N clients, which is not a
soundtrack, it is a crowd.

This was off until 2026-08-20, which is why every take filmed before then carries an AAC track measuring
−91 dB mean *and* max — a real stream containing digital silence. Nothing downstream could tell, because
a silent track is indistinguishable from a quiet one until something tries to duck under it.

**Minecraft's music is silenced at the source, and always was.** `start_cameras.ps1` forces
`soundCategory_music` and `soundCategory_record` to `0.0` on every camera, every launch. The soundtrack
and the music discs are licensed music and footage carrying them earns a copyright claim. It is done in
the client rather than in OBS or the editor because a camera that *cannot emit* the sound cannot leak it
into a take, whatever anything downstream is doing. Everything else — mobs, blocks, weather, footsteps —
carries no such claim and is what makes the footage worth listening to.

> Verified 2026-08-20: the setter rewrites both keys to `0.0` and leaves the other eight sound
> categories and all 143 lines of `options.txt` untouched.

**Music and voice files belong to the CAPTURE.** Drop them on the preview page (§6n) and they are saved
immediately into `footage/<take>/audio/music/` and `footage/<take>/audio/voice/` — beside the camera files
they belong to. They are a **permanent addition to that take**: start a second edit of the same night and
they are already there, listed, with nothing to find again. Storing them under the project would tie them
to a name you typed, so re-cutting under a different name would lose them.

`0.15`–`0.25` is the usable level for a bed. It ducks automatically under every voice line — no manual
dipping. **`footage/music/README.md` lists where to get music that will not earn a Content ID claim**
(start with the YouTube Audio Library), and `CREDITS.md` beside it is where the receipt goes; a claim
arriving four months later is impossible to dispute if you cannot say where the file came from.

> Verified end to end 2026-08-20: a bed at `@ 0.20` resolved from `footage/music/`, rendered, and
> measured **10.7 dB down** inside the narration window — the gain change from 0.20 to 0.06 predicts
> 10.5 dB. Duration truth-check passed.


### 6l-bis. The preview: the whole cut in one piece, with sound going on it

You arrive here by pressing **Stitch it → sound & preview** on the editor; there is no other way in and
nothing to type. It plays `render_draft.mp4` — the stitch that button just rendered (§6k-bis) — so what you
are watching is the cut, at a smaller size, and a second marked here is that second in the finished file.
The address is `/preview?take=<key>&profile=<p>` if you ever need it directly, but going there without
stitching first shows you the previous cut, which is exactly why the link under the button was removed.

**Why it plays the draft rather than chaining the clips.** A browser could play the source clips back to
back with no render at all, but the finished cut is *not* the clips back to back: a crossfade pulls every
later clip earlier, so a stitched preview and the file drift further apart with every join. Sound placed
against a timeline that lies lands somewhere else in the video. The cost is that the draft has to exist
first, which is why writing the plan renders one.

**Music.** Drop a file, press **use**, set the level. One bed for the whole video: it **loops if it is
shorter than the cut, is cut off if it is longer**, fades in and out, and drops under every voice line.

**Voice.** Drop the recordings, move the playhead to where a line should start, press **place**. Each one
becomes a block on the timeline you can drag; click a block and press `Delete` to take it out. `→` jumps
the playhead to a line.

**It plays the mix while you work** — bed and voice over the video, with the bed ducking by exactly the
amount the render will use. Space plays and pauses; clicking the ruler or a track moves the playhead.

**Sound saves as you place it, and it goes into the video when you print.** The mix is part of the desk,
not part of the stitch you are watching — the stitch is silent of it on purpose, or you would hear the bed
twice. **🎞 Print the finished film** is the last act: the server rewrites the plan from the editor's own
decisions plus the mix, and renders the whole thing at full size. Press it again after a change and it
overwrites, under the same name.

**Where voice used to live.** Narration was a `vo:` line under a clip, so it belonged to whichever clip sat
underneath it — reordering the reel moved the words, and rewriting the plan lost the record of what had
been recorded. A timecode into the assembled video is what was actually chosen, because it was chosen
while listening to that video.

### 6m. Undo

Both editing pages have **↶ Undo**, and **Ctrl+Z** does the same thing. The button counts what is behind
you — `↶ Undo (3)` — and greys out when there is nothing left to step back to. Sixty steps are kept.

It undoes **decisions**, which is everything the desk saves: approve, reject, reorder, drop, trim, cut,
gain, camera angle, on-screen text, the let's play window and its speed spans. It does *not* undo where you
are looking — playback position, which camera is previewing, and which clip the inspector has open stay
where they are. Those are not decisions.

Undo and autosave watch the same snapshot, so the rule is simple: **if it survives a reload, it can be
stepped back.**

---

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
