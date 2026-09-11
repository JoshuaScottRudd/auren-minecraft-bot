# Fleet Runbook — operating, testing, and inspecting the live Auren fleet

> Operative procedure. It answers *"cold-start, how do I run the system and see what it did?"*
> Read on demand; CLAUDE.md points here.
>
> **Procedure lives here. Reasoning and current state live in
> `Documentation/Refurbishing planning/architect_bugsquashing.md`** (Law 14, Law 29). Every command the
> Architect copies to a terminal is in `Auren_Workshop/Architect_Commands.txt`.

---

## 1. What the fleet is

A run is a set of real, detached, windowless OS processes:

- **Minecraft server** (`java … server.jar`) on port 25565.
- **Overseer** (`overseer/overseer_server.js`) on port 3001 — the one coordinator. Holds the planning
  token, merges every bot's trace into one stream, and carries every operator verb (Law 16).
- **One bot process per roster entry** (`master_core.js`, `BOT_ID=AurenBot|TessaBot|IrisBot|…`). The
  roster is `BOT_SENIORITY` in `Thinking_fragments/architect_config.js`; `node fleet_control.js roster`
  prints it. Adding a bot is one edit there — launcher, cameras and peer-order follow. A run brings up
  the whole roster; `-Count N` runs the first N.
- **Live tracer** (`trace_monitor.js --watch --stream=dispatcher`) — read-only, launched beside the
  fleet, streaming every task-pick to `fleet_logs/trace.log`. The sequence of picks is the fleet's status.

Processes are spawned `detached` with stdio redirected to files, then `unref()`'d, so **nothing opens a
console.** Find them in Task Manager or through `status`. Each process's output mirrors to
`Auren_Bot/fleet_logs/<name>.log`.

**Every `up` starts a clean run:** it clears `fleet_logs/traces/watcher_*.jsonl`, truncates
`fleet_logs/*.log`, and releases the arena tapes.

`fleet_control.js` is the single implementation of launch + command + teardown.
`Auren_Workshop/run.js` is the one way a RUN is started, and it composes those verbs (§3).

---

## 2. Machine differences — the node chain resolves itself; server config does not

| | Home (primary) | Work | Bot runner / server box (§2b) |
|---|---|---|---|
| machine | Ryzen 7 7700X, 31 GB | — | **i7-4790, 32 GB, `DESKTOP-RNLN7UR`** |
| node.exe | `node_env2/node.exe` (v22.17.1) | `node_portable/node-v22.13.1-win-x64/node.exe` | `node_portable/node-v22.23.2-win-x64/node.exe` |
| node_modules | `node_env2/node_modules` | `MinecraftServer/node_modules` | `MinecraftServer/node_modules` + `Auren_Bot/node_modules` |
| java | PATH | PATH | `jdk-25.0.3+9/` (Temurin) — the literal path `fleet_control.js` looks for |

**Resolve the toolchain through these two, every time.** A bare `node`/`npm` may find a toolchain
belonging to something else, and it fails silently:

```
. .\Auren_Workshop\scripts\_node.ps1 ; Get-AurenNode      # -> node.exe for THIS machine
.\Auren_Workshop\scripts\npm.ps1 <args>                   # npm, resolved; prints which one it picked
cd Auren_Bot; .\scripts\npm.ps1 install              # the bot's declared packages
```

`fleet_control.js`, `run.js` and `preflight.js` try portable → node_env2 → PATH, and put both
`node_env2/node_modules` and `MinecraftServer/node_modules` on `NODE_PATH`. The `@`-aliases (`@kernel`,
`@perception`, …) come from `Auren_Bot/package.json` `_moduleAliases`, registered against `Auren_Bot/`
explicitly.

**On a box with no node on PATH, `npm install` in `Auren_Bot/` exits 1** — `ffmpeg-static`'s postinstall
shells out to a bare `node`. Prepend the resolved node for that one invocation:

```
. .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; $env:PATH = (Split-Path $n) + ';' + $env:PATH
.\Auren_Workshop\scripts\npm.ps1 install
```

The resolver RUNS each candidate rather than testing for the file: a distribution's `npm.cmd` can exist
as a stub after `npm install` pruned `node_modules/npm` as extraneous. Its refusal names the repair.

**On `DESKTOP-RNLN7UR` a bare `node` also works** — that box's user PATH holds
`C:\Auren_Minecraft\node_portable\node-v22.23.2-win-x64`, the same directory `Get-AurenNode` returns and
the only `node.exe` on the machine. **Scripts, documents and instructions still use the resolver**: PATH
is per-machine state git does not carry, so a `node` line works on one workstation and fails on the other.

### 2a-pre. Putting Paper on a workstation's dev world (do this on every machine)

The public server runs Paper. Paper changes entity activation ranges, mob spawning and chunk behaviour —
the layer a pathfinding bot sits on — so test what you run (Law 16). `MinecraftServer/` is gitignored, so
each machine converts itself:

```
# newest 1.21.5 build; EVERY 1.21.5 Paper build is channel ALPHA, so pick the highest id, not STABLE
$b = Invoke-RestMethod 'https://fill.papermc.io/v3/projects/paper/versions/1.21.5/builds' -Headers @{'User-Agent'='auren'}
$dl = ($b | Sort-Object id -Descending | Select-Object -First 1).downloads.'server:default'
Copy-Item MinecraftServer\server.jar MinecraftServer\server-vanilla.jar        # keep the way back
Invoke-WebRequest $dl.url -OutFile MinecraftServer\server.jar
```

`fleet_control.js` launches `server.jar` by filename, so reverting is a `Copy-Item` back. Paper's extra
configs land inside the already-ignored `MinecraftServer/`. PaperMC's v2 API is sunset — use v3 as above;
its builds array is descending and the artifact key is `server:default`.

### 2a. `MinecraftServer/` is gitignored — server config does not travel

`server.properties`, `ops.json` and `world_snapshots/` are untracked on every machine. **When a bot
misbehaves on ONE machine only, suspect untracked server config first.**

**Nothing to do by hand.** `fleet_control.js` holds `REQUIRED_PROPS` and writes each one into
`server.properties` before launch, on every machine, every run. Add new must-have settings there, never
to a table in a document. A server already running cannot be re-configured (these load at JVM start), so
`fleet_control` reports the mismatch and tells you to restart.

**Currently asserted: `spawn-protection` = `SPAWN_PROTECTION_RADIUS` from `architect_config.js` (16, the
vanilla default).** The launcher reads the same constant the bots gate their decisions on, so the square
the server enforces and the square the fleet avoids cannot drift.

**What the setting does.** Inside a Chebyshev square of that radius around world spawn — X/Z only, full
height, so 16 means a 33×33 column bedrock to sky — the server refuses block breaks *and* placements by
non-op players, **silently**: no revert, no error, nothing the client can see. mineflayer writes AIR into
its own world model anyway (`finishDigging` → local `_updateBlockState`), so the bot believes it dug a
hole that does not exist, hovers over phantom air, collects nothing, and strands itself.

**The fleet holds the rule itself.** `perception_nodes.js/spawn_protection` latches world spawn off the
server's own `spawn_position` packet and gates target selection, the route search, and both
world-altering verbs. A protected cell is refused before the swing, with a named cause.

**The gate ignores op status**, so an op'd bot is refused exactly like a non-op one (Law 19,
Invariant E). `ops.json` lists AurenBot (level 4) and not TessaBot; that asymmetry no longer changes
behaviour.

**What it costs, so a run is read correctly.** Ground within 16 of world spawn is off-limits for mining,
building, farming, lighting and bridging — trees there are not candidates, patches there are not
prospects, and a build site straddling the edge is rejected whole. Walking, standing, fighting and
collecting drops inside the square stay legal. Both real build sites (headframe `(32,68,-1)`, farm
`(18,62,43)`) sit outside the radius. **A scan reporting `held by spawn protection` is this rule
working.**

---

## 2b. The dedicated bot runner — bringing a third machine up

A machine whose only job is holding bot processes against a world that lives somewhere else.

**Measured capacity on this box** (`public_server_plan.md` §9):

> **11.5% of one core and 248 MB per bot. Server ≈ 40% of one core flat + ~1.9% per client.**
> **8 humans / 16 bots sustained; 10 / 20 is the hard ceiling — the server's single-threaded main tick
> hits it first, not the box.** Without the server here, ~12 humans / 24 bots.

RAM is nowhere near binding (16 bots + server ≈ 5.5 GB of 32). **Re-measure after pre-generating the
world** — the 40% constant was taken on terrain generating as the bots walked into it.

**Install, in order:**

1. **OS settings first.** Never sleep, never hibernate, automatic restart for updates OFF.
2. **Tailscale**, signed into the same tailnet. This is how the box reaches the rented server, how a
   session elsewhere reaches this one, and what the gate plugin's allowlist keys on.
3. **OpenSSH Server** (a Windows optional feature).
4. **Node**, the repo cloned, then `cd Auren_Bot; .\scripts\npm.ps1 install`. **Add this box to §2's
   table** — the next cold-start session reads that table first.
5. **A JDK at `jdk-25.0.3+9/` in the repo root**, and four npm trees: `MinecraftServer/` (mineflayer
   lives there), `Auren_Bot/`, and `Auren_Workshop/tools/vendor/`.
6. **The server jar and its properties — the step that blocks bring-up.** `MinecraftServer/` is
   gitignored whole, so a new box has no `server.properties`, and `fleet_control server-start` dies on
   `ENOENT`: it asserts settings into that file and can correct one but never create one. Let the binary
   write its own defaults:
   ```
   # 1.21.5, SHA1-checked against Mojang's manifest, into MinecraftServer/server.jar
   #    then, from MinecraftServer/ :
   'eula=true' > eula.txt
   & ..\jdk-25.0.3+9\bin\java.exe -Xmx1024M -jar server.jar nogui   # writes server.properties, generates a world (~9 s), then stop it
   ```
   Then set the four values that are decisions: `online-mode=false` (the bots hold no Mojang accounts),
   `enable-rcon=true` **and a non-empty `rcon.password`** (RCON is how the fleet stops the server cleanly
   and applies every gamerule), and `level-name=sub_agent_01`. `fleet_control` asserts the rest.
7. **Git identity and the commit hook.** `session_sync` fails at the commit step without the first
   (`Author identity unknown`, *after* taking the trunk lock). `preflight` prints the second when missing:
   ```
   git config user.name "<your name>" ; git config user.email "<your email>"
   git config core.hooksPath Sessions/hooks     # without it, hand `git commit` is NOT refused
   ```
8. **Nothing else.** Bots are headless; a game client belongs on the Architect's desktop.

**Verify before believing it works:**

```
. .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; & $n Auren_Workshop\tools\preflight.js
& $n Auren_Workshop\tools\bot_cost_probe.js --seconds=300
```

### Measuring this box's real ceiling

The fleet is embarrassingly parallel — one single-threaded process per bot. **Paper's main tick is
single-threaded, so the world is capped by ONE core** however many the machine has. Raise the bot count
in steps and watch the **server's** `% of 1 core`:

```
node Auren_Workshop/fleet_control.js up --count=8            # 2, then 4, then 8, then 12 …
node Auren_Workshop/fleet_control.js verb start
. .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode
& $n Auren_Workshop\tools\bot_cost_probe.js --seconds=300 --note="8 bots"
```

**Stop at the run where the server passes roughly 70% of a single core** — past that the tick has no
headroom for spikes. That bot count divided by two is the humans this machine holds, and it sets
`capacity.maxWhitelisted` in `Public_server/whitelist/`.

**To grow the box, buy single-core speed.** More cores help the fleet and do nothing for the world.

### Pointing the fleet at a world on another machine

`SERVER_ENDPOINT` in `Thinking_fragments/architect_config.js` is the single source (Law 16). **Override
it by environment** — an edit travels through git and is wrong everywhere but one machine:

```
$env:AUREN_SERVER_HOST = '100.x.y.z'      # the server's TAILNET address
$env:AUREN_SERVER_PORT = '25565'
```

`fleet_control` spawns bots with `{...process.env}`, so a value set in the launching shell reaches every
body. A malformed port falls back to 25565.

**Use the tailnet address.** The public entrance is an authenticating proxy that demands a Mojang login
the bots do not have.

### Testing latency without a server: `tools/latency_shim.js`

A TCP relay that holds every byte for a set delay:

```
node Auren_Workshop/tools/latency_shim.js --listen=25567 --target=127.0.0.1:25565 --delay-ms=60 --jitter-ms=15
$env:AUREN_SERVER_HOST='127.0.0.1'; $env:AUREN_SERVER_PORT='25567'
node Auren_Workshop/run.js                                  # with host/port set on the config page
```

`--delay-ms` is the ROUND TRIP; each direction is held for half. At 60 ms the fleet holds, and the
friction it adds concentrates in inventory acknowledgement waits.

---

## 2c. The seed scanner — getting a world worth starting a fleet on

The fleet sites its base inside the ~160-block radius the server streams around the landing point, so a
world is judged by what is in that one circle.

> *"landing biome is forest or plains. theres rivers and medium amount of water content and the ground is
> reletivley flat, no giant mountains or oceans spanning a large portion of the loaded chunk."*
> — Architect, 2026-09-05

```powershell
# HUNT — roll seeds until one is ideal. Unattended; ~20 s per seed. Stops at the first world that passes.
node Auren_Workshop/tools/seed_scanner.js scan --tries=14

# MEASURE — score the world the server is running right now. Creates nothing, deletes nothing.
node Auren_Workshop/tools/seed_scanner.js measure

# THE RECORD — every seed ever scanned, and which criterion did the rejecting.
node Auren_Workshop/tools/seed_scanner.js log
```

Per seed the hunt stops the JVM, deletes the candidate world folder, writes `level-seed`, starts the
server, joins one spectator-weight client (`Seed_Scout`), reads the biome map with the fleet's own
`biome_scanner`, walks a 441-column relief grid, judges, records, and rolls on. No fleet, no overseer, no
autonomy.

| criterion | default | owner |
|---|---|---|
| landing biome is a forest/plains type | `world_forge.ACCEPTABLE_BIOMES` | **his** — one list, imported |
| a river body inside the loaded area | 160 b | **his** |
| share of ground standing under water | 2–22 % | the tool's |
| share of the loaded area that is ocean | ≤ 8 % | the tool's |
| ground-height spread, 5th to 95th percentile | ≤ 40 b | the tool's |

Override with `--max-relief=`, `--max-ocean=`, `--min-water=`, `--max-water=`, `--max-river-dist=`. Every
verdict line prints **who owns the number it judged against**.

**The thresholds were calibrated against `sub_agent_01`** — the world he called ideal: *forest landing ·
12.4 % of ground under water · 0 % ocean · nearest river 107 b · ground y32–y94, median y64, p5–p95
spread 32 b*. Re-derive any time with `measure`.

**Two water numbers, two questions.** `ocean %` comes from the biome map (is this an ocean world);
`ground under water %` comes from the relief columns (how much buildable ground is flooded) and is what
the "medium water content" band judges — a pond inside a forest is invisible to the biome map.

**Which worlds it may destroy:** the guard is a property test — **any world that has a snapshot is
somebody's world and is refused.** The candidate world defaults to its own name, `seed_scan`.

```powershell
# once the hunt finds one, this makes it permanent AND makes the scanner refuse to overwrite it
node Auren_Workshop/tools/seed_scanner.js keep --world=seed_scan
```

**The hunt leaves the server pointed at the candidate** so you can look at the world it found. Put it
back when done:

```powershell
node Auren_Workshop/fleet_control.js server-stop
node Auren_Workshop/fleet_control.js server-start --world=sub_agent_01
```

`level-seed` is restored on every exit path including a crash.

**The permanent record** is `Long_term_memory/seed_scans.jsonl` — append-only, holding the measurements
rather than the verdict, so rows stay readable after a threshold moves. `seed_scanner.js log` is its lens.

**Measured over 18 seeds:** ocean and water content reject ~69 % of seeds each, landing biome 62 %,
flatness 31 %. A 14-seed hunt found one on attempt 11 in 4.4 minutes, unattended. **The seed of the world
he has now is `5584697676702229955`.**

---

## 3. Start a run — ONE PAGE, ONE SCRIPT

> *"instead of different scripts to start the test. theres one way law 16 on how to do it. then theres one
> way to configure it. you make all the configurations before you start anything on one page then you
> click the same runscript and it runs according to the configure. so standar, continue, watch, record,
> soak, waking rules. everything that is througout all the runbook verbs are now all on a configuration
> page and the one script runs them after you configure them."* — Architect, 2026-09-10

**Two files, and there is nothing else to learn.**

```
1.  edit    Auren_Workshop/run_config.js          every choice the run has
2.  run     . .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; & $n Auren_Workshop\run.js
```

`run.js` takes **no flags**. A flag would be a second place to say what the page already says, and the
two would disagree the first time anyone used both (Law 16). The page is read once, before the world
moves, and the run then performs itself start to teardown with nothing to steer.

### 3a. What is on the page

| field | permitted values | what it decides |
|---|---|---|
| `world` | `fresh` · `continue` · `as-is` | roll back to the snapshot and forget everything · carry the world AND the bots' memory forward · touch neither |
| `snapshot` | a snapshot name | what `fresh` rolls back to |
| `worldName` | the server's world folder | what it restores INTO |
| `clock` | `dawn` · `day` · `held` | sunrise and let it run · pin midday and FREEZE the cycle · leave it alone |
| `person` | a Minecraft name | who joins and asks for the crew |
| `standing` | `spawn` · `"<x> <y> <z>"` | where that person stands — **which is where the base gets sited** |
| `crew` | `homesteader` · `contractor` | answers to nobody · yours, and hears you |
| `soak` | minutes | how long it is left to work |
| `watch` | `true` · `false` | a wake-on-error watch that ENDS the run when something fires · soak blind |
| `wake` | `error` · `halt` · `death` | which signatures wake it. Nothing else can — his rule, as a value |
| `stream` | fragment tags | live commentary while watching. `[]` for silence |
| `record` | `off` · `cameras` · `film` | nothing · cameras only · cameras plus OBS writing files |
| `teardown` | `down` · `leave-up` | reap everything · leave it standing for you to poke at |
| `server` | `local` · `already-up` | this script owns the world · a world is up and it will not touch its lifecycle |
| `host` `port` `rconPassword` `rconPort` | | which world, and how to reach its console |
| `downloadRoot` | a path outside the repo | where the stranger download is built |

**Every field is a whitelist.** A value that is not on its list is refused BY NAME before the server is
touched, an unknown key is an error rather than something ignored, and nothing is defaulted for you
(Law 13). A typo in a key would otherwise read as "left at its default" and the run would quietly not be
the run that was asked for.

### 3b. Two rules the page enforces before anything moves

- **`world: 'fresh'` requires `server: 'local'`.** A snapshot cannot be restored under a running server —
  world files mid-write are not a world, and `rollback.ps1` refuses for that reason. Asking for both is
  asking for two things that cannot happen, and the honest moment to say so is before a rollback has
  half-happened to a world that was serving players.
- **`world: 'fresh'` requires the snapshot to EXIST.** Checked against
  `MinecraftServer/world_snapshots/<worldName>/` up front, because the alternative is discovering it
  after the world has already been taken down. If it is missing, the refusal names what IS there and the
  one command that makes the current world the baseline.

### 3c. The bots arrive the way a stranger's bots arrive, and there is no other door

> *"the process is a players joins their server, they start up the bots. starting up the bots only bring
> up foreman and overseer. in either case. a human must then call foreman get homesteader or foreman get
> contractor. that is the only way to get the bots. when i have you place a faux player called architect,
> you are doing that part on my behalf."* — Architect, 2026-09-10

Every run does this, in this order:

1. builds a fresh download from `git ls-files Auren_Bot` — the **working tree**, so uncommitted changes
   are what gets tested — into a folder with nothing above it;
2. `npm install`s it the way the README says to;
3. launches `start_auren.js` from that download **in a stripped environment**, with every `AUREN_/BOT_/
   OVERSEER_` variable removed, so the run cannot inherit this machine's configuration and certify a
   build that works on one box in the world;
4. seats `person` in the world through `proxy_human`;
5. **has that person type `foreman get <crew>`** down their own stdin;
6. measures where the crew ended up **off the server's entity data**, not off anything the fleet says
   about itself.

**There is no privileged entrance left.** The old named tests ran `start_bot.js` and handed it a mandate,
which is a door nobody who downloads this has. If the desk refuses, the run has failed — there is
nothing to fall back to, deliberately. *"i dont want to test in a way that a public user wont be using."*

**Why the download lives OUTSIDE the repository:** node resolves `node_modules` by walking UP the
directory tree, so a copy inside the tree satisfies itself from the repo's own install and proves
nothing. `downloadRoot` is a sibling of the repo, not a child.

**What is carried across rebuilds, and nothing else is:** `node_modules` always (460 MB the lockfile
pins exactly), and on `world: 'continue'` ONLY, the bots' `corporate_headquarters.<bot>.json` files and
`player_memory/`. Those are untracked runtime state, so wiping the folder wipes the very thing a continue
exists to preserve — which is why the world and what the bots know about it are one field and not two.

### 3d. Where the old verbs went

Nothing was lost; each was one frozen combination of the settings above.

| what you used to run | what to set now |
|---|---|
| `test standard` | `world: 'fresh'`, `soak: 15` |
| `test continue` | `world: 'continue'` |
| `test scan` | `soak: 1` |
| `test record` | `record: 'film'` |
| `test spawnzone` | `standing: "<coords inside the square>"` |
| the two foreman tests | the desk comes up in every run before any crew is asked for |
| the two let's-play runs | `record: 'cameras'`, `teardown: 'leave-up'` |
| `test arena` | `lanista` still owns the arena — it reads `worldName`/`snapshot` off the page |
| the conductors' soak / capture / triage | `soak`, `record`, `watch` |
| `run <profile>` / `runbook` | the page IS the profile; there is only one |
| `stranger_bench` | this is it — the method became the plumbing |

**Deleted on 2026-09-10:** `tools/stranger_bench.js`, `tools/test_conductor.js`,
`tools/contractor_standard_run.js`, `scripts/fresh_start.ps1`, `scripts/scan_test.ps1`,
`scripts/start_fleet.ps1`, `fleet_runbook.js`, and `fleet_control`'s `test`, `run` and `runbook` verbs.
Each of them started a fleet, and each carried its own bring-up order — which is how this repository came
to hold three separate answers to *"is the world restored before or after the bots come down"*.

### 3e. The plumbing that stayed, and why

> *"i still want the same type of plumbing. a configurable start that is deterministic."*

`fleet_control.js` remains the one owner of the world's lifecycle, and `run.js` **composes** its verbs
rather than reimplementing them:

```
node Auren_Workshop/fleet_control.js status | server-start | server-stop | snapshot
                                     snapshot-restore --snapshot=<name> [--world=<name>]
                                     clock dawn|day|held | up | down | bots-up | repair
                                     rcon "<command>" | verb <word> [--bot=X] | memory-wipe
```

`snapshot-restore` is new (2026-09-10): the function existed and had one caller, the deleted `run
--restore` profile, so a rollback was only reachable by asking for a whole authored run. `run.js` needs
the rollback without the bring-up welded to it.

### 3f. Publishing is a CONVERSATION, not a step in the run

> *"its not a determinitic process. we test a feature and then once its working you remind me to post it
> to public. its a manual process because it has to survive code changes. were never testing the same
> thing and errors will always be different. so the workflow is verbal not coded."* — Architect,
> 2026-09-10

A green run ends by saying the build is postable and **stops there**. There is no `--publish`, and there
was one for exactly one day: it gated a push on a passing bench, which measures the one feature that run
exercised and certifies the whole tree. Since no two runs test the same thing, that gate was an
inference the machine had no standing to make.

The order of a release is therefore: **change → run → look at what it says → say so out loud → he
posts.** The private trunk carries every iteration through `session_sync`; the open-source repository
gets a snapshot copy of `Auren_Bot/` with no history, the day a build works.

---

## 3g. `server start` and `server rollback` — the live server's vocabulary

> *"the server start according to this start method is always a continue start. its never a standard wipe.
> i will ask you to wipe servers and memory. that is one command to rollback servers without starting…
> now rollback is a seperate command in isolation and server start is always a continue test thats on all
> the time."* — Architect, 2026-09-05

| | `server start` | `server rollback` |
|---|---|---|
| command | `.\online.ps1` (its opposite is `.\offline.ps1`) | `.\Public_server\rollback.ps1 [name]` |
| what the word means | an OUTSIDE person can complete the Discord funnel and join — proved from outside | n/a |
| restore world snapshot | **never**, by construction | **yes** — that is the whole command |
| wipe HQ (bot memory) | **never** | **yes** — always with the world |
| starts things | **yes** — world, proxy, join gate, overseer, foreman, watchman | **no.** Roll back, look, then `start` |
| bots | **none** — on order, via `foreman get` | n/a |
| idempotent | **yes** — safe at any time, in any state | no; it asks for the word ROLLBACK first |

**`server start` is exactly a continue**: it carries the world *and* the HQ forward, and those two are
one decision — HQ holds coordinates for a particular world. `wipeMemory()` in `fleet_control.js` is the
single implementation of that wipe (`fleet_control.js memory-wipe`), shared by `run --restore` and the
public server's rollback.

**Snapshots first.** `.\Public_server\rollback.ps1 -Take [name]` takes the server down, copies the world,
and brings it back — including when the copy failed, because a failed backup must never be also an
outage. `MinecraftServer/rollback.ps1` is the one rollback engine for both servers (it grew a `-Root`).

**Neither command may certify itself** (Law 25). `online` ends by running `node Public_server/joinable.js`,
which walks the eight steps a stranger walks and ends **outside the machine** — a Minecraft status ping to
the public hostname whose reply must look like this server rather than TCPShield's edge placeholder. The
word ONLINE prints only on all eight; otherwise it names the shut step and its fix and leaves everything
running. `offline` sweeps every process whose executable, command line or working directory is inside the
repository, then measures again and names any survivor. Run the walk alone any time with
`node Public_server/joinable.js` (`--local` skips the two checks that leave the machine, and is
explicitly not a certification).

**There are exactly two operator commands and rollback is not one of them** (Architect: *"you are allowed
exactly 2 scripts. either up or down… thats why we reperated the rollback so that can be done outside of
those 2 commands"*). `.\online.ps1` and `.\offline.ps1` ask nothing and destroy nothing, which is what
lets them run with no confirmation. `rollback.ps1` is the one command that erases and the one that asks.

---

## 3h. The two servers — dedicated and local

| | **DEDICATED SERVER** | **LOCAL SERVER** |
|---|---|---|
| What it is | the public world strangers join | this machine's world, for testing |
| Who reaches it | anyone whitelisted through Discord | this box only |
| Brought up by | `.\online.ps1` (repo root) | `node Auren_Workshop/fleet_control.js local` |
| Taken down by | `.\offline.ps1` (repo root) | `node Auren_Workshop/fleet_control.js down` |
| Proxy · join gate · warden | **yes** — Velocity, AurenGate, the watchman | none |
| The 8-step joinable check | **yes** — ONLINE means it passed | no |
| Address | the public one, through TCPShield | `localhost` |
| Standing bots | **zero** — on order, via `foreman get` | **zero**, the same |
| Lives in | `Public_server/` | `MinecraftServer/`, the fleet's dev world |

**The pair exists for downtime.** Work on the local one while the dedicated one stays up; restart the
dedicated one when the change is ready to ship. Nothing in the `local` path reads, writes, stops or
points at anything in `Public_server/`.

**`local` prints no ONLINE.** `joinable.js` is the definition of that word and its eight steps end
outside the machine; on a world only this box can reach, every step is meaningless or cannot fail.

**The hazard, and the guard.** `AUREN_SERVER_HOST`/`PORT` override where every body connects, and
`fleet_control` hands children `{...process.env}` — so a shell pointed at the public proxy earlier would
start a world on this box and send the bots, the foreman and every contractor into the **dedicated**
world. **`local` forces the endpoint to `localhost` before launching anything** and says so out loud when
it overrode something.

```
node Auren_Workshop/fleet_control.js local                  # world + overseer + foreman, NO bots
node Auren_Workshop/fleet_control.js down                   # world + overseer + foreman down
# there is no -Count any more: a crew is asked for in chat, or by a configured run (§3)
```

Then join in Minecraft at **`localhost`** (Java **1.21.5**) and say `foreman get` in ordinary chat.

**It comes up with zero bots on purpose**, exactly like the dedicated server: the thing under test is
`foreman get`, the path a real arrival walks. `-Count N` is for the other kind of test, where
homesteaders are the subject.

**`local` opens a RUN** — `teardownBotSide()` then `resetRunArtifacts()`, so `fleet_logs/` is emptied and
the run's records belong to it alone. Use `repair` to restart a piece without throwing the run away.

**A note the proving produced:** `fleet_control bot-start` returns when the PROCESS is launched, while a
body enters the overseer's registry only after it connects, spawns and `master_core` initialises — those
are seconds apart. The desk polls the registry for up to 90s rather than reading it once. **Only a real
player slot catches faults of this shape**: `preflight` passed throughout, every process window was
clean, and the only thing wrong was a sentence said to a human about a fact that had not happened yet.

---

## 3i. The filming overlay — one word films any conducted run

> *"i want an overlay that can attach deterministically to any known way to start the bots… controllable
> with a single command and everything else is automated."* — Architect, 2026-08-16

Filming attaches to a rung rather than becoming rungs of its own. Say the word after the run's name:
**standard record test** → `standard record`.

| | |
|---|---|
| `record` | cameras for every bot, and OBS recording every one to its own file |
| `watch` | the same cameras, **nothing written** |
| *(no word)* | today's run, unchanged byte for byte |

```
# a filmed run is a CONFIGURED run: set record: 'film' (or 'cameras') on run_config.js, then:
node Auren_Workshop/run.js
node Auren_Workshop/tools/lanista_conductor.js ladder record
node Auren_Workshop/tools/record_overlay.js    stop        # THE closer — from any other terminal
node Auren_Workshop/tools/record_overlay.js    status      # what is filming, and who is holding it
```

**The Architect's eye (`Cam_Architect`)** is one more spectator client, built and launched like a bot
camera, that the director **arms and then never commands**. It is absent from the rig's shot list, so
nothing can teleport it. It gets its own OBS capture and its own `footage/Cam_Architect_*` file. Its name
and on/off state are declared in `camera/camera_configure.js` (`architect.camName`, `architect.enable`).
It defaults off — it is the only seat producing nothing unless a human is in it for the whole run.
`lanista_conductor` still takes `--architect`, having no authored run to read. Full section:
`camera_runbook.md` §8.

**Every filmed run also records what the MACHINE did.** The overlay raises
`tools/machine_load_sampler.js` *before* the cameras — chunk streaming as N clients launch is the load
worth catching — and reaps it with the crew:

```
node Auren_Bot/monitoring/trace_monitor.js --machine-load            # newest record
node Auren_Bot/monitoring/trace_monitor.js --machine-load --label=standard
```

GPU utilisation, VRAM, temperature, power, clock, CPU and free RAM as **p50/p95/max**, plus **stalls**
(how late a sample landed). **It reports machine load, never smoothness** — a hitch is a late frame and
nothing outside the game process can see one, so headroom here is evidence the card was not the limit.

**Where it sits in a run:** after the bring-up, before the work — one insertion point on every rung. A
filmed conducted run brings its fleet up IDLE (`fleet_control test <name> --idle`) and the conductor
sends `verb start` once the lenses are watching.

---

## 4. Cold-start sequence (the wheat-farming prototype baseline)

**This is a CONFIGURED run, and §3 is how it is asked for.** The sequence — down → restore snapshot → up
→ clock → [cameras] → seat the person → `foreman get` → soak → read → teardown — is performed by
`run.js`, which composes each tool rather than owning any of them (Law 16). On the page:

```
world:     'fresh'                      down, restore, back up
snapshot:  'sub_agent_01_fresh_start'   the baseline
worldName: 'sub_agent_01'
clock:     'dawn'
crew:      'homesteader'
soak:      15
record:    'off'      | 'cameras' for a seat to watch from | 'film' for footage
```

Then `node Auren_Workshop/run.js`. There are no bring-up flags, and there is no `-Count`: two is what the
desk raises when a person asks it for a crew, which is the only way a crew is raised.

**`.\Auren_Workshop\scripts\fresh_start.ps1` used to be this command and is deleted** (2026-09-10). It
raised bots by running `start_bot.js` directly — a door nobody who downloads this repository has — so a
cold start proved through it was never evidence about the build a stranger gets.

**The clock has three answers, and each states the whole clock** — the time it starts at AND whether the
day/night cycle then advances. Written as `clock:` on the config page, and settable at any moment on a
live world with `node Auren_Workshop/fleet_control.js clock <name>`.

| | |
|---|---|
| `dawn` | sunrise, and the day runs on from there. The default, and what the fleet is normally exercised against |
| `day` | **pinned at midday, cycle frozen** — it never gets dark. For a take you will repeat, and for any untimed session that must not walk into a night nobody asked for |
| `held` | whatever time and cycle the world already holds. The deliberate night run |

`doDaylightCycle` lives in the world's `level.dat`, so it survives a run — which is why every answer
sets the cycle as well as the time rather than only the half it cares about.

The steps it composes, for running one in isolation:

1. **Restore the world snapshot** (destructive — backs up current first):
   `node Auren_Workshop/fleet_control.js snapshot-restore --world=sub_agent_01 --snapshot=sub_agent_01_fresh_start`
2. **Bring the desk and referee up:** `node Auren_Workshop/fleet_control.js local`
3. **Cold HQ:** `node Auren_Workshop/fleet_control.js memory-wipe`
4. **Wire check:** `node Auren_Workshop/tools/preflight.js` — every fragment must load before trusting a run.
5. **Raise a crew:** join at `localhost` and say `foreman get homesteader` in chat. There is no launcher verb for this — asking the desk is the only way (§3c).
6. **Watch for errors** (§5) and **inspect** (§6).

Rollback leaves HQ intact by design, which is why step 3 is separate.

**A standard test rolls the world back; a continue does not.** Without the rollback, prior-run cruft
accumulates — three headframes stacked up across carry-forward runs, and multiple tagged chests
(`[chest headframe]` at several sites) coexist, so the supply system can draw wheat and seeds from a chest
belonging to a *different* site's headframe. `rollback.ps1` copies the current world to
`world_snapshots/backup_before_restore_<ts>` first.

### Editing `building_blueprints.json` — a stopped-state input

**Edit the file freely at any time, including while the fleet is running, then restart the bots to apply
it.** A **continue test** applies a blueprint edit without rolling the world back.

The running fleet holds a snapshot taken at boot (`js_kernel/blueprint_registry.js`, the one route to the
file) and never re-opens it:

- **Deleting the file to upload a new version crashes nothing.** Nothing re-reads, so the delete window
  is invisible to the fleet.
- **A completed edit does not take effect mid-run, and that is the point.** The dangerous case is the
  swap that *succeeds*: bots then compare a world built to blueprint A against blueprint B, nothing is
  malformed so nothing throws, and the integrity scan concludes the structure is damaged and posts repair
  work that tears down correct blocks.
- **The mismatch is reported.** The registry hashes the file and warns at `⚠️` when disk differs from the
  running snapshot: `building_blueprints.json CHANGED ON DISK (boot <hash> → disk <hash>) … THE EDIT IS
  NOT LIVE`. Missing-file and file-returned are reported the same way.

A missing or corrupt blueprints file **at startup** throws — that is the boot validation (Law 13), and it
is what carries this claim now that the mid-read bench is retired.

---

## 4a. Self-cleaning starts and the mid-run recovery path

**`up`/`bots-up` self-clean every start.** A start tears down lingering processes from a prior run
(trace, bots, overseer) and flushes all logs — every `watcher_*.jsonl`, `fleet_logs/*.log` except
`server.log`, and every arena tape under `fleet_logs/arena/` — then launches fresh. A reused overseer
cannot replay a prior run's error into a fresh watch.

**HQ memory is never touched by a start** — only `verb flush` clears `corporate_headquarters*.json`. Logs
flush on every start; the memory does not.

**There is no cross-run combat memory of any kind, and that is the ruling** (Architect 2026-08-31): the
fleet changes between runs, so rows written a week apart never measured the same system. What lasts is
the write-up someone makes from a session.

**Recovery on a mid-run wake:** stop bots only — `verb stop` (persists tail state; overseer and server
stay up) — inspect, fix the code, then `bots-up` → `verb start`. **No `verb flush` on this path** —
flushing would discard the in-progress HQ the stall interrupted.

---

## 5. Wake on error (the watch contract: errors wake, warnings sleep)

**Any `❌` error stops the system for inspection; warnings sleep through — and are never left unread.**

### What a `⚠️` warning means

**A warning says: *look at this, but nothing is broken and it can wait until the regular timed
inspection.*** Both halves bind:

- **"Nothing is broken"** — the work completed, the plan was valid and used, the world is consistent, no
  state was lost. A warning is the level for a **degraded-but-correct** outcome: it cost more than it
  should have, or took a worse route to a right answer.
- **"But look at it"** — a real finding filed for scheduled review.

**If a thing is actually broken it is `❌` and it stops the run. If it merely cost more than it should
have it is `⚠️` and it waits.** **Emit a non-fatal condition at `warn()`**: a non-fatal error is permanent
in the trace and `--watch` wakes on errors at **any** index, so every re-arm re-wakes on the same
historical line, forever, with no new event. The SLOW-NAV tripwire did exactly that and broke the attended
loop inside 8 minutes.

**The level IS the interface, and the prose is not.** `trace_monitor` consumes a *level*; a sentence
reading "NON-FATAL, BOT CONTINUING" is addressed to a human and invisible to it. **Anything said only in
the message text has not been said.** Say it in the level.

### Inspecting warnings — on a schedule, always

**On EVERY wake — an error wake or a clean 15-minute timeout — read the run's warnings first:**

```
.\Auren_Workshop\scripts\trace.ps1 --level=warn --from=<last check-in>    # every warning since the previous inspection
.\Auren_Workshop\scripts\trace.ps1 --level=warn --from=<t> --bot=TessaBot # narrow when one bot is noisy
```

Of each warning ask:

1. **Is it new, or the same one I saw last check-in?** A warning recurring across several check-ins has
   become a chronic cost and has earned a decision.
2. **Is it growing?** Same warning, worse number is a trend, and a trend is a finding.
3. **Does it point at a structural fix nobody has made?** Most warnings name the candidate fix in their
   own text.

The sleep is a **deferral to the check-in**. A warning nobody ever read is the design failing.

**Two warning signatures wake immediately:** `warn-repeat` (3× identical warn text) and `warn-burst` (5+
warns within 60s from one bot). A warning storm is degradation happening now.

Two ways to run the watch:

- **Bare monitor:** `node Auren_Bot/monitoring/trace_monitor.js --watch --exit-on-flag --max-minutes=<N>`
  Exits `2` the instant it flags. It wakes on an error at **any** index, including one already in the
  trace when the watch began. Warnings and the progress-shaped signatures stay new-lines-only. Without
  `--watch` it is a one-shot scan (exit `0` clean / `2` flags / `1` read error).
- **Attended wake:** run the bare monitor **in the background** from the chat. A background task the
  session started re-invokes that session when it exits, so its **exit-on-flag IS the wake**. On wake the
  fleet stays up: query the trace's "after" (§6), diagnose, and only then stop bots by hand if a code
  edit is needed.

**The signatures:** `error` (any ❌ — always wakes), `death` (§5a — always wakes), `judge-repeat`
(recursive_judge Contiguous N/5), `warn-repeat`, `warn-burst`, `silence` (a bot went quiet while the fleet
ran — the dead-bot fingerprint), `regression` (a structure's correct-count fell), `halt` (recursive_judge
parked a bot). Thresholds are calibrated at the top of `trace_monitor.js`.

### 5a. Wake on death

**A bot dying is not an error in the trace** — the construct respawns and carries on. The death wake
lives in `trace_monitor` as the `death` signature, so there is one watch:

```
node Auren_Bot/monitoring/trace_monitor.js --watch --exit-on-flag --max-minutes=60
```

### 5b. Reading a fight — `trace_monitor --engagement`

The fight told back as a story, off the bot's own trace. Read it together with `lanista`, which names the
outcome off the server.

### 5b-bis. Making a fight happen — `lanista`, the arena bench

```
node Auren_Workshop/tools/lanista.js --bot=AurenBot                          # one zombie, ~12 blocks out
node Auren_Workshop/tools/lanista.js --bot=AurenBot --mob=creeper --rounds=3 # three fights, re-sited each time
node Auren_Workshop/tools/lanista.js --bot=AurenBot --mob=skeleton --hand=minecraft:bow --range=15
node Auren_Workshop/tools/lanista.js --bot=AurenBot --mob=zombie --count=3   # three at once, spread by bearing
node Auren_Workshop/tools/lanista.js --cleanup                               # kill anything it left behind
```

**It records nothing** — the bot writes its own combat onto its watcher trace and `--engagement` reads it.
Three things it does, each because a live run proved it had to:

- **Authors the world to midnight / hard / daylight-cycle off.** The first match ever run reported
  *"✅ field cleared in 30s"* against a bot that never swung — daytime was 3442 and the zombie burned.
- **Reads the mob's equipment back.** `/summon minecraft:skeleton` arrives with NO bow, and a bow-less
  skeleton has no ranged attack in Java — it charges and bashes. `--hand` is verified against the server;
  a mob that did not take it means the round is **NOT RUN**.
- **Refuses rather than mislabels.** Terrain that cannot supply the asked range reports asked-vs-got; a
  bot outside its own `AGGRO_RANGE` is NOT RUN rather than timed out; a cleared field with no damage
  dealt is not a win; a creeper that detonated is called a detonation.

It never moves, heals or re-kits the bot — it fights from where it is with what it has. **It does not arm
engagement**: a parked bot needs the operator's `sentry` verb.

**A wave ends when the battle ends, never on a clock** (Architect 2026-08-07: *"there is no wave timer,
its upon completion of battle"*). `--ceiling=<sec>` (default 90) is only the point past which an
unresolved wave is recorded as a **timeout — a defect reading, not a result**. On the fleet's side
`battle_stations` reports which entity ids it killed and which disengaged, the `sentry` watch ends its
wave on that report, and `recursive_judge` judges it and re-arms for the next.

**Run the one-wave smoke before you spend a ladder.** A ladder is many trials; a wiring fault costs the
whole run to discover. One wave costs under a minute on the identical path:

```
node Auren_Workshop/fleet_control.js up --count=1     # stack up
node Auren_Workshop/fleet_control.js verb start       # bot alive and thinking
node Auren_Workshop/fleet_control.js verb sentry      # ARM engagement — the ladder never does this for you
node Auren_Workshop/tools/lanista.js --bot=AurenBot --mob=zombie
```

**Four things in that output are the gate**, and any one missing means stop and fix: the siting line names
a real `asked vs got` range; the lift line shows the mob placed at or above `--lift` blocks over the bot,
or says it fell back to the confirmed pool; the headline is a **cleared** or a **disengaged**, never a
`⏱️ timed out` (a timeout on wave one is almost always `sentry` unarmed); and
`trace_monitor.js --engagement --bot=AurenBot` afterwards shows the fight.

### 5b-ter. Auditing sight — `raycast_crucible`

Answers *"was the bot right about what it could see?"* against ground truth that is never the thing under
test.

```
node Auren_Workshop/tools/raycast_crucible.js                              # where the body spawns
node Auren_Workshop/tools/raycast_crucible.js --at=32,70,-1 --radius=8     # a chosen stance, ±8 cube
node Auren_Workshop/tools/raycast_crucible.js --skip-blocks --ring=2,3,5,8 # just the fight-gate ring
node Auren_Workshop/tools/raycast_crucible.js --explain=25,66,-2           # ONE ray, printed cell by cell
```

It joins as a **spectator**, needs only the server, and kills every body it summoned on every exit path
including a throw. Four audits:

| phase | the question, and what answers it |
|---|---|
| **W** | is the client's block map TRUE? Every sampled cell put to the server over RCON |
| **C** | does the ray stop at the FIRST collision shape? Every cast re-walked by a **different algorithm** — prismarine steps a 3D DDA, the crucible sweeps the segment parametrically and does exact ray/AABB against every shape. Two implementations agreeing is evidence; running one twice is not |
| **M** | the ENTITY channel — summoned bodies vs the server's own list, position error included |
| **R** | the near-field ring: the production predicate at every bearing and close range, every refusal re-walked before it is believed |

**Read the classes, never the raw disagreement count** — which way the two answers differ *is* the
finding:

- **STOPPED-EARLY** — the ray stops nearer than the true first blocker: the line is called blocked when it
  is clear, and the bot refuses a monster it can see.
- **MISSED-NEARER** — it stops past a real blocker, or not at all: the bot charges a mob through a wall.
- **CORNER (◹)** — the segment passes exactly through a cell corner; prismarine's tie-break steps into a
  cell the ray is inside for zero length and stops on it. Same stopping distance, different cell named.
  Reported because **whether the SERVER breaks that tie identically is unverified** — the one open parity
  question the tool leaves on the table.

A high ◹ count means the stance is cell-aligned; re-run from `--at` elsewhere.

### 5b-quater. Testing one piece of a bot live — `testbot`

> *"read fleet runbook and use testbot. thats how you test individual pieces of bots live"* — Architect,
> 2026-08-11

**A `testbot` is a standalone mineflayer client that joins the running server and `require`s the REAL unit
under test.** It is not a roster entry and never boots `master_core`. **It needs the SERVER only** —
`fleet_control.js server-start` is the whole bring-up. That independence matters because a fleet bot's
login can be bricked by its own playerdata, and then every verb-driven bench is unavailable for a reason
unrelated to the thing being measured.

```
node Auren_Workshop/fleet_control.js server-start                 # the entire prerequisite
node Auren_Workshop/tools/water_pillar_probe.js                   # scaffold_movement.pillarStep, live
node Auren_Workshop/tools/combat_drive_probe.js                   # combat_navigator + gunner, live
node Auren_Workshop/tools/stone_column_probe.js                   # stone_column_scanner's verdict, live
```

**A probe that drives a SCANNER audits the verdict independently or it proves nothing.**
`stone_column_probe` re-derives every field of the returned column from `bot.blockAt` directly, never
through the scanner's own voxel reader — sharing the reader would make a reader defect invisible. It
teleports the body across a spread of terrain (`PROBE_SAMPLES`/`PROBE_SPREAD`, or `PROBE_AT="x,z;x,z"` to
aim at ocean, swamp or a mountain face) and reports find rate separately from soundness rate: **a high
find rate with one unsound column is a FAILING result.** It audits every column in the list and
re-derives the ranking from the rows, because the executor claims down the list until one is free.

**The four seams every probe has** (long form:
`Documentation/Refurbishing planning/live_test_bench_design_note.md`): **connect** the client · **author**
the scenario over `tools/rcon_link` · **call** the real unit, required and never reimplemented (Law 16) ·
**judge by reading the world back**, never by trusting the unit's own success flag (Law 26).

**The governing line:** *anything Minecraft decides is READ; only the operator's choices are AUTHORED.* A
probe that computes what an action should have done has become a simulator, and a simulator confirms the
bug you already believe.

**Which bench for which question:** `lanista` causes a FIGHT (outcome off the server) ·
`locomotion_course` drives the A* ladder over sited terrain through the `move` verb (needs a fleet) · a
`testbot` probe drives ONE unit in isolation (needs a server).

### 5c. Arena tapes are released every run

**Every `up`/`bots-up` deletes every arena tape** (`fleet_logs/arena/*.jsonl`), the same way it clears the
watcher traces. No combat record survives a run boundary.

Arena tapes are released but never folded: `tools/locomotion_course` is their only writer and only reader
— it samples a movement leg at 20 Hz and reduces its own output. **A tape that cannot be reduced is NOT
deleted**; it is left on disk and named loudly in the reset line.

**The costs, so a missing number reads as a decision:** there is no lifetime time-to-kill by mob and
weapon, no all-time blows-taken-by-species, and no run-over-run comparison. A question of that shape is
answered by RUNNING a ladder.

The two fight-quality reads that survive into `--engagement` are the ones the bot could answer about
itself: **blows thrown from beyond the bot's 3.0 reach** and **an engagement with no strike at all**.

---

## 6. Inspect a run (`trace_monitor` — read-only, never touches a bot)

> **Where the instruments live.** Everything that READS a record is in `Auren_Bot/monitoring/`;
> `Auren_Workshop/tools/` is bench-testing — anything that drives the system to *make* a record. The test:
> could it run with no Minecraft installed? Then it is monitoring. `monitoring/README.md` holds the split;
> `monitoring/LENSES.md` holds every question and the flag that answers it.

Default trace is `fleet_logs/traces/watcher_overseer.jsonl`, merged on read with every per-bot file. Run
from the repo root.

> **Node resolution.** The bare `node …` form works where `node` is on PATH. On a portable-node machine
> use `.\Auren_Workshop\scripts\trace.ps1 <same args>` — same resolver chain, every flag forwarded verbatim.

```
node Auren_Bot/monitoring/trace_monitor.js                    # digest + anomalies (exit 2 if problems)
node Auren_Bot/monitoring/trace_monitor.js --story            # one block per job: PLAN -> DOING -> VERDICT
node Auren_Bot/monitoring/trace_monitor.js --activity         # the decision play-by-play
node Auren_Bot/monitoring/trace_monitor.js --story --bot=AurenBot          # follow one bot
node Auren_Bot/monitoring/trace_monitor.js Auren_Bot/fleet_logs/traces/watcher_TessaBot.jsonl  # one bot's own file
```

**Query mode — the addressable slice.** Take one flagged, timestamped line and pull the window around it,
before AND after, or filter by subsystem tag / bot / time range. All filters compose (AND); it never flags
and never wakes (exit 0):

```
node Auren_Bot/monitoring/trace_monitor.js --around="1m 1s"                 # DEFAULT: ±25 lines around it
node Auren_Bot/monitoring/trace_monitor.js --around="1m 1s" --lines=50      # ±50 lines
node Auren_Bot/monitoring/trace_monitor.js --around="1m 1s" --bot=TessaBot  # narrow so the anchor is YOUR line
node Auren_Bot/monitoring/trace_monitor.js --around="1m 1s" --window=60     # opt into a TIME window (±60s)
node Auren_Bot/monitoring/trace_monitor.js --tag=STATION_REGISTRY           # one subsystem, whole run
node Auren_Bot/monitoring/trace_monitor.js --from=4m --to=7m --bot=AurenBot # a bot, minutes 4–7
node Auren_Bot/monitoring/trace_monitor.js --grep="goTo failed" --level=error
```

The anchor window defaults to a **line count** (±25 matching lines): a time window explodes with a fast
multi-bot fleet (5 bots × ~10 lines/s × 60s ≈ 3000 lines), so `--window`/`--before`/`--after` are opt-in.
Relative `[Nm Ss]` stamps reset on each `start`, so a relative query is scoped to one run segment
(`--run=<latest|N|all>` widens). An ISO stamp addresses across runs.

**Is a bot actually silent? Use `--last`.**

```
.\Auren_Workshop\scripts\trace.ps1 --last     # one greppable LASTPOST line per bot, from each bot's OWN file
```

```
LASTPOST AurenBot POSTING age=1s at=2026-07-20T12:57:26.281Z story="Progress: 22.6 blocks remaining ..."
LASTPOST TessaBot POSTING age=0s at=2026-07-20T12:57:27.231Z story="goTo reached 'goal' — at (59,63,-44) ..."
```

`--last` reads the per-bot watcher files and ignores the merged stream, so it answers the question even
when the merge is missing, empty or lagging — which is exactly when the question gets asked. The digest's
`last activity` is derived from the merge and freezes when the merge lags; it prints an `own file:` line
beside it and a `⚠️ MERGE-LAG` marker naming which line to trust.

**Cross-check liveness when a run looks stalled:** `node Auren_Workshop/fleet_control.js status` (are the PIDs alive?) and the
ISO stamp on the **last line** of `fleet_logs/traces/watcher_<Bot>.jsonl`. The append-only writer means
nothing rewrites the file, so mtime moves only when a line lands; the last line's own stamp is still the
better read, since it survives a file being copied or restored. `--watch` also flags a wall-clock **FLEET
FROZEN** when no bot has logged for >120s with no error raised.

**Watcher levels (Law 5):** `summary()` (📊, the primary channel), `warn()` (⚠️, read first when
diagnosing), `error()` (❌, auto-dumps buffered context). Nothing finer-grained exists by design.

---

## 7. Where things live

- **Operative static** (checked in, at `Auren_Bot/` root): the structural laws, this runbook, and
  `camera_runbook.md`. Must exist on both machines cold.
- **Live runtime exhaust** (`Auren_Bot/fleet_logs/`, gitignored): fleet consoles
  (`server/overseer/trace.log` + one `<BotId>.log` per roster entry), the arena tapes, and
  `fleet_control_runtime.json`. **The entire directory is emptied at the start of every `up`** — by
  clearing the room rather than matching filenames, so a record added by a future instrument cannot
  quietly outlive its run. Also gitignored: `corporate_headquarters*.json`, `find_buildingspot.json`, and
  the server's `usercache.json` / `server.properties` / `world_snapshots/`.
- **Cross-run memory is `js_kernel/corporate_headquarters*.json` and nothing else** (gitignored,
  per-machine, cleared only by `verb flush`) — where home is, which chests are whose, what has been
  sited. It survives a start because the fleet READS it in order to work; that is the whole test.
  **Long-term memory is a markdown holding the interpretation someone drew from a run**, tracked in
  `Documentation/` or `Cognitive_documents/`.
- **Documentation** (`Documentation/`): static reference and archive.

---

## 8. The attended hardening loop

### THE STANDING RULE: no LLM runs in an unattended loop

**An LLM may not be placed in a loop that acts on the system without a human present in it.** Not bounded
by attempts, not bounded by a budget, not bounded by a permission list. This has been built and removed
**twice** — `autofix_controller.js` / `launch_subagent.js` / `start_subagent.ps1` / a `claude -p` fixer
(deleted 2026-07-10), and `Public_server/waker.js`, a warden escalation that woke a headless session on a
fault (built and deleted 2026-09-05, the same day). *"I've tried this at different scopes and it just
never works."*

**The previous note recorded a *situation* — "it existed to run with nobody in the chat; that premise is
gone" — and a situation is exactly the kind of reason a later session argues past.** The premise came back
the day strangers could join a live server, so the note read as spent, and the second version was built by
a session that had read it. The reasons below are structural and none expires:

1. **It inverts Law 13.** Default state is stopped; a system must prove it is safe to CONTINUE. An
   unattended fixer is default-*running* — it acts on the fault and halts only after proving N failures.
   Attempt ceilings, watchdogs and budgets are stop-conditions bolted onto a thing already going.
2. **A generator cannot supply the proof Law 13 asks for.** It has no throw: it can complete while
   producing a well-formed falsehood, so it cannot certify its own safety to continue, and unattended
   there is nobody the certification could be checked against (Law 26).
3. **The dilemma that kills it on either horn.** If the repair is well-understood enough to be safe
   unsupervised, it is well-understood enough to be *deterministic code* — and the LLM is unnecessary. If
   it is not that well-understood, the LLM is unsafe. **Prefer a calculator that fails over a process that
   can run away.**
4. **It reaches into the engine while it turns** (Law 26). An LLM editing code and restarting services on
   a live server is authoring internals of a running machine.

**THE RELIABLE LOOP, and it is the Architect's (2026-09-05):**

> *"code shows problem, LLM interprets issue to me, i make a decision, LLM writes code, code runs without
> LLM."*

Four hops, and the human is a **link in the loop, not an escalation path off the end of it.**
Deterministic code detects and reports (it cannot lie while it runs); the LLM *translates* and later
*authors*, both while the system is stopped; the human *decides*; the code that ships runs alone.
**Automating the human hop is what both deleted systems were, and it is the hop that cannot be automated
— it is the only one where a decision is made by a party that can be held accountable for it** (Law 28).

**What IS legitimate:** deterministic self-repair with a named owner and a cause-naming alert.
`Public_server/warden.js` restarts components, backs off, gives up after five attempts and posts why. It
contains no generator, cannot invent an action it was not built with, and when it runs out of moves it
wakes a *person*. Extend that, and let the escalation end at him.

### The loop, one turn at a time

It runs *attended* — the AI Developer sits in the chat and IS the fixer — using the two tools that exist:
`fleet_control` (operate) and `trace_monitor` (observe).

**The wake mechanism.** A detached OS process cannot inject a turn into a live chat, but **a background
task the session itself launched re-invokes that session when it exits.** So the watch runs in the
background, watches the live trace, and exits on the first error; that exit is the wake. A long
`ScheduleWakeup` is a fallback heartbeat if the watcher ever hangs instead of exiting.

1. Bring the fleet up and start autonomy:
   ```
   node Auren_Workshop/fleet_control.js up --count=2 [--world=<name>]
   node Auren_Workshop/fleet_control.js verb start
   ```
2. Launch the watch **in the background**:
   ```
   node Auren_Bot/monitoring/trace_monitor.js --watch --exit-on-flag --max-minutes=60
   ```
3. On a flag it exits `2` → this session wakes, the flag's context in its output. **The fleet stays up.**
   Query the window around the flag (§6), diagnose against the laws. **Then read every warning since the
   last check-in (§5)** — on every wake, error or clean timeout.
4. If a code edit is needed, stop bots deliberately (`verb stop` — keeps the world and in-progress HQ),
   edit, `preflight`, then `bots-up --count=N` + `verb start`.
5. Re-arm the background watch. Repeat.

**The stop-tuple holds (Law 8).** A start binds server+bots as one unit; a stop binds bots+server. The
watch never tears the fleet down, so **teardown is yours** — `fleet_control down` or `takeover`. A server
is left running only if the session ends with the fleet up, and `status` + `takeover` from any shell
recover it.

**Multiple test worlds.** `fleet_control … --world=<name>` repoints the server to any world folder under
`MinecraftServer/` (it writes `level-name` before launch — a live server cannot be re-pointed). **An
unknown name makes Minecraft generate a fresh world of that name**, which is how a new test world is born;
each world keeps its own `rollback.ps1` snapshots. With no `--world`, `fleet_control` runs whatever world
is already selected.
