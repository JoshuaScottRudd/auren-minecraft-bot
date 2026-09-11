# Auren

A Minecraft bot that decides what to do on its own.

It is not a macro and not a scripted routine. It looks at the world, works out the gap between what is
there and what should be there, picks one job, does it, and looks again. Left alone on a fresh world it
will find a place to live, chop wood, build a house, farm, mine, and defend itself — because it decided
to, not because a list told it to in that order.

---

## AI built it. AI doesn't run it.

**I wrote none of this code. I don't read code. I direct an AI and I judge what comes back.**

That is the whole method and I'd rather state it than let you discover it: this is prompt engineering.
I decide what should exist and how it should behave, an AI writes it, and my job is telling it when the
result is wrong — which is a different skill from programming and the only one I brought. Every design
rule it works under is in `Auren_Structural_Laws.md`, because that is the actual artifact I author.

**And there is no AI inside it.** The bot makes **zero LLM calls at runtime**. Nothing here phones an API,
wants a key, or costs a fraction of a cent per decision. Everything it does comes from the planners,
judges and perception nodes in this repository, running as plain code on your machine.

Two verbs, and they are the whole argument: **AI as the developer, not the pilot.**

---

## What you need

- **Node.js 22 or newer** — `node --version` to check.
- **Minecraft Java Edition 1.21.5**, and a server you can reach. Nearby 1.21 versions usually work; the
  further you drift the more likely the bot reaches for a block that got renamed. **Bedrock will not work.**
- **Offline mode, or a real account for the bot.** By default it logs in without authenticating, which a
  server accepts only when `online-mode=false` in `server.properties`.
- **The server console switched on** — two more lines in the same `server.properties`:

  ```
  enable-rcon=true
  rcon.password=pick-anything
  ```

  **This is not optional and here is why.** A bot starts working from where *you* are standing, and
  getting it there means one `tp` issued through the server's own console. A bot that cannot be placed
  does not start at all — so without these two lines you would get a bot standing still and nothing to
  read. `start_auren.js` checks the console before it opens and tells you if it cannot reach it.

```
npm install
```

**That download is about 450 MB**, nearly all of it `minecraft-data` — the block, item and recipe tables
the bot reads constantly. There is no smaller version of it. Nothing installs outside this folder.

---

## How to run it

One command, and it mirrors how I run it myself. The only thing it asks you to name is the console
password you just set.

```
node start_auren.js --rcon-password pick-anything
```

That starts a **foreman** — a clerk that joins your world and waits. **No bots yet.** Walk to where you
want them, and ask in chat:

```
foreman get contractor     a crew of 2 that works for you
foreman get homesteader    a crew of 2 that answers to nobody
foreman help               the words it knows
foreman stop               send your contractors home
```

The crew is brought to **where you are standing** and starts working when it arrives. You place them by
walking somewhere, which is the only part of this a person should have to decide.

The one word chooses who they answer to, and it is the only difference:

- **contractors** belong to you. They hear you in chat — say a bot's name and then what you want.
- **homesteaders** answer to nobody. They have no ear at all: the chat listener is not mounted, so
  talking to one does nothing. Run these if you want to watch the thing work on its own.

**Everything is hired from inside the game, and that is the only way.** A contractor exists because
somebody in the world asked for it — the owner is stamped into the bot at birth and every order is
filtered on it. There is no terminal flag for that, because there is no owner to name from a terminal,
and no coordinate to type because you are standing on it.

**If your server is not on `localhost:25565`, there is one file to edit: `your_server.js`,** at the top
level beside this README. It holds the address, the port, and the server console's port and password, and
everything in this project reads it — the bots, the foreman, the camera rig, the tools. Nothing probes for
a server or falls back to a second address: if nothing answers where that file says, the run stops and
prints that file and the exact field to change. (`--host` and `--port` still work on the command above when
you want to point one run somewhere else without editing anything.)

**You start your Minecraft server and you stop it. The bots only join it.** Nothing here will start,
stop or reconfigure a world it did not create. Every part of this project that touches a world asks it one
question — *are you there* — and gets the answer by speaking to the server, never by being told.

**Ctrl-C stops everything, including the bots the foreman fetched.** That is the whole interface.

> A homesteader answers to nobody, and that includes you: `foreman stop` will not reach one. Ctrl-C is
> what ends them. The homestead is the world's rather than any one player's, so it tops up to a crew of
> two and a second person asking gets told it already exists.

---

## When something goes wrong — read this part

**Every bot writes down what it decided and why**, not just what happened to it:

```
fleet_logs/traces/watcher_<botname>.jsonl
```

One line per event, plain JSON, English sentences inside. **A bot replaces its own trace every time it
starts**, so a restart destroys the evidence — copy the file before you try again.

**Send it to me — that is the fastest route to a fix and it costs you one copy-paste.** Open an issue,
attach the file, say what you expected to happen. A trace tells me in thirty seconds what would cost you
an evening, and it is the single most useful thing anybody can hand me.

**If you would rather read it yourself, you can — it is your machine and the readers are in your
download.** They are not on this page because reading a trace is a different job from running a bot, and
mixing the two is how a one-command project turns into a manual. One command hands you the whole
workbench:

```
node developer_mode.js on
```

It prints what it turned on and where to start. Nothing above this line changes: the bots run exactly the
same either way, and `node developer_mode.js off` puts it back.

**Common ones:**

- **Connects then immediately kicked** — the server is in online mode and the bot has no account. Set
  `online-mode=false`, or give the bot a paid account.
- **`Cannot find module 'mineflayer'`** — `npm install` wasn't run, or was run in the wrong folder.
- **"something is already using port 3001"** — an overseer is still running from last time. Close it.
- **"Auren cannot reach your server's console"** — `enable-rcon=true` and `rcon.password=` are not both
  set in `server.properties`, the server was not restarted after setting them, or the password you passed
  to `--rcon-password` is not the one in the file. Nothing launched, so there is nothing to clean up.
- **A bot says it did not start because it is not standing with you** — it was raised, it could not be
  brought to you, and it refused to plan a base somewhere you did not choose. Usually the console
  password: see the line above.
- **Joins and stands still** — usually ground it cannot work: no wood in reach, or spawn-protected. It
  re-plans and gets the same answer. The trace says which, and so will I if you send it.
- **Version mismatch** — pass `--version 1.21.5` to match your server exactly.

---

## What is in this folder

| | |
|---|---|
| `start_auren.js` | the one way in — the desk and the referee |
| `your_server.js` | where your server is. The only file you might need to edit |
| `developer_mode.js` | the door to the workbench, if you ever want it. Off until you say otherwise |
| `start_bot.js` · `start_overseer.js` | one bot, or the referee, on their own — what the above is built from |
| `master_core.js` | what a bot runs once it has been told who it is |
| `Thinking_fragments/` | the deciding — planners, judges, and the config you'd edit to retune it |
| `action_fragments.js/` | the doing — one file per verb |
| `perception_nodes.js/` | the sensing |
| `js_kernel/` | shared machinery: state store, trace writer, calculators |
| `custom_api/` | the layer between the bot's vocabulary and Minecraft's |
| `overseer/` · `foreman/` | job arbitration, and the desk you hire from |
| `monitoring/` | the readers of what a run wrote. Behind the door; nothing the bot runs depends on it |
| `Auren_Workshop/` | my own equipment, all of it, behind the door — see the section below |
| `Auren_Structural_Laws.md` | the rules all of it obeys |
| `MECHANISM_REGISTRY.md` | every named mechanism, one line each — the index to read before assuming a thing isn't already here |

---

## If you want to work on it — the developer door

**Everything I use to build this thing is in your download, and one command turns it on.**

```
node developer_mode.js on
```

Until you run that, none of it will start. Every tool, bench, lens, camera and scripted run asks one
question first — *is this a workbench?* — and an ordinary copy answers no and says so in a sentence. That
is not a licence check and there is nothing to unlock: it is a marker file on your disk, you own it, and
`node developer_mode.js off` removes it.

**Why a door rather than a smaller download.** I tried keeping the tools back and it made the project
worse rather than safer. There were two ways to run the fleet — mine and yours — so every fault arrived
twice, and I could not point my own instruments at what a downloader actually had. **The tools have to
live with the bot in order to read the bot.** But shipping a thing and putting it in front of somebody are
different acts: a person who wants two bots to build a house should meet two commands, not a soak harness
and a combat arena. So all of it ships, and none of it is offered until you ask.

**And there is one door, not two.** I open it on my own machines with that exact command and there is no
other way in — no check for whose computer this is, no path that only I walk. When you open it you are
standing where I stand, running the same files I run.

What appears: the scripted runs, the readers that turn a trace into an answer, the benches that drive a
live world, the camera stack. The command prints the list and tells you where to start —
`Auren_Workshop/README.md` is the map of the folder and `Auren_Workshop/COMMANDS.txt` is every command on
one page.

**Two honest warnings for once you are inside.** The benches under `tools/` connect real clients and send
real console commands — they drive a world rather than reading a record, so point them at a world you do
not mind disturbing. And the camera stack expects an installation you almost certainly do not have; the
lenses that read its records say so in one sentence rather than failing.

**The one thing I have that you do not** is that my machine hosts the world, so I start and stop it in the
same pass with `Auren_Workshop/host_and_run.js` — which rolls the world back to a snapshot, starts the
server, and then runs `Auren_Workshop/run.js` **unchanged, as a child process**. That is the entire
difference between my run and yours: a separate file laid on top, never a branch inside the shared one. On
a machine without a server folder it refuses and points at `run.js`.

---

## The Structural Laws

Not documentation of the code — the design rules the code was built to obey, written before and alongside
it, and cited by number in comments throughout. They explain why a failure throws instead of returning
false, why there is exactly one way to do each thing, why the bot re-senses instead of remembering.

`_LLM.md` is the condensed version; `_Glossary.md` defines the terms. They ship because they are already
quoted on every other page of the code. **"The Architect" in those comments is me.**

---

## What this is not

- **Not a plugin or a mod.** Nothing is installed on the server; the bot connects as a player would.
- **Not multiplayer-safe by default.** It protects a 33×33 square around world spawn and nothing else.
- **Not finished.** Working system, one person, under active development.

---

## Where this is going

The bots are being built toward a **multiplayer world** where people live alongside them. **That does not
exist yet** and I won't pretend otherwise.

**None of the below is a prerequisite for anything else.** Running the bot from this repository and going
nowhere else is a perfectly good answer.

| | what's actually there |
|---|---|
| **[Discord](https://www.projectauren.com/discord)** | Dev runs, failures pulled apart, ask me things directly. Join for the conversation — not to unlock anything, because nothing here is locked. |
| **[YouTube](https://www.youtube.com/@ProjectAuren)** | The bots working, with me explaining what you're looking at. |
| **[projectauren.com](https://www.projectauren.com)** | The overview, if you found this repository first. |

**And there is a server**, where people live in a world alongside the bots. Not open to everyone yet, and
that is deliberate rather than exclusive: sessions get recorded and I keep data on who built what, so you
agree to that before walking in rather than after. The terms and the door are both in the Discord.

---

## Contributing

**Please don't send pull requests.** Single-author project with a design system that takes a while to hold
in your head; a patch written without it costs more to review than to rewrite.

**Do send problems.** An issue with a trace attached is the most useful thing you can give me, and it is
what this bot is written to produce.
