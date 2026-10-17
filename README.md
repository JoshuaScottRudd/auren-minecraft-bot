# Auren

**Intelligence isn't magic. It can be built, one principle at a time.**

A crew of Minecraft bots that decide what to do on their own. It is not a macro and not a scripted
routine. Each bot looks at the world, works out the gap between what is there and what should be there,
picks one job, does it, and looks again. Started on an empty survival world, a crew digs a mine, cuts and
replants trees, smelts, crafts its own tools, and builds: a headframe and a farm, or a whole downloaded
building.

**There is no AI inside it.** The bots make **zero LLM calls at runtime**. Nothing here phones an API,
wants a key, or costs anything per decision. Every decision comes from the planners, judges and
perception nodes in this repository, running as plain code on your machine. The rules they were built
to obey are in `Auren_Structural_Laws.md`.

---

## How this repository is meant to be used: with an LLM

**This repository is built to be set up and worked on together with an LLM coding assistant.** That is
how it was made, and it is the only way I use it. Open this folder in one, have it read this README and
`Auren_Structural_Laws.md`, and let it set up your machine, start the runs, and read the traces with you.

**Without one, you are on your own.** You can run everything by hand, and the commands are below, but I
make no promise that it is easy. I can't make that promise honestly: I don't write code, so the only way I
could check whether this is easy by hand is to ask an LLM, which is the very thing I'd be checking it
without. If you download source code, I'm assuming you're a developer and can find your way.

---

## What you need

**Current Node.js, Java 25 or newer for your Minecraft server, and a Minecraft Java Edition 26.1 server on this computer.
Then, in this folder:**

```
npm install
```

That download is about 450 MB, nearly all of it the game's block, item and recipe tables. Nothing installs
outside this folder. On a Node older than 22 it stops and names the version it needs.

---

## How to run it

One command. The only thing it asks you to name is the folder your server runs in:

```
node start_auren.js --server-folder "C:\path\to\your\server"
```

(Put that folder in `serverFolder` in `foreman_config.js` and you never type it again.)

**The foreman starts your server for you, and stops it when you press Ctrl-C** — after the bots have gone
home and the world has saved. The server gets its own window, so you can watch it. If anything goes wrong
(no Java, the licence not accepted in `eula.txt`, the port already taken, the world locked by another
server), the foreman reads why from the server's own output and says it in plain words, with the file and
the field to change.

**It sets your server up for itself and prints every change it makes, and why.** It writes what the bots
need into your `server.properties` before the server starts:

- `online-mode=false` — the bots have no Minecraft accounts.
- `enable-rcon=true` — a crew is brought to where you stand through the server console.
- `rcon.password` — **a new random one every start.** You never see or type it.
- the fleet's own settings (spawn protection, difficulty, chunk saving) — each printed with its reason.

If people outside your home can reach your server, keep in mind that offline mode checks no accounts.

**Joining a server somebody else runs** is the other setting: `where: 'remote'` in `foreman_config.js`,
with that server's address and the console password its owner gives you. The foreman then only joins it —
it never starts or stops a world it did not start.

That starts a **foreman**: a clerk that runs the world, raises the crew, and ends the run. **What it runs
is one sentence at the top of `foreman_config.js`:** where (your world or someone else's), how it starts
(from a clean world or where the last run stopped), how long it lasts, and which crew. The foreman says
the sentence back before it starts.

**The crew** is the field you will change most:

- **`builder`** (the default): a crew of up to 20 that builds a downloaded building from nothing. The
  foreman sites the building and brings the crew in itself. **The building is not in this repository** —
  see the next section.
- **`homesteader`**: a crew of 2 that answers to nobody. It builds a headframe over its mineshaft and a
  farm. The foreman sites the base and brings them in, and anyone in the world can also ask for them with
  `foreman get homesteader`. They have no ear at all: talking to one does nothing.
- **`contractor`**: nobody is brought in. A person in the world asks in chat, and a crew of 2 that works
  for them is brought to where they stand:

```
foreman get contractor     a crew of 2 that works for you
foreman help               the words it knows
foreman stop               send your contractors home
```

  A contractor hears its owner in chat: say a bot's name and then what you want. The owner is stamped
  into the bot at birth and every order is filtered on it.

### Building a downloaded building

The builder crew builds from a **build plan** made once from a downloaded blueprint (a `.litematic`
file). **No blueprint ships with this repository, because each one is somebody else's work.** You
download it yourself, under the terms of the site you got it from, and turn it into a plan:

```
node developer_mode.js on
node Auren_Workshop/tools/import_blueprint.js "<path to the .litematic>" --name=<name>
node Auren_Workshop/tools/plan_blueprint.js "<folder of the .litematic>/downloaded_blueprints.json" --name=<name>
```

Then put `<name>` in `builder.build` in `foreman_config.js`, and the path of the
`<name>.build_plan.json` the last command wrote in `builder.plan`. The plan builds only from what a crew
can gather in survival: one kind of wood, stone, dirt, glass and a little iron. Other blocks are swapped
for the nearest of those or left out, and `<name>.build_plan.md` lists every swap.

The default names `overgrown_survival_castle`, which is
[BiggyDiggy7's "Overgrown Survival Castle"](https://abfielder.com/Products/ProductDetails.php?id=2159) on
abfielder.com. Without a plan, the foreman stops, says where it looked, and prints the plan command.

**Everything the foreman needs is in one file: `foreman_config.js`,** at the top level beside this
README — local or remote, your server folder, the address, the port. Everything in this project reads it.
Nothing probes for a server or falls back to a second address: if the world cannot be started or reached,
the foreman stops and prints that file and the exact field to change. (The same values work as flags on
the command above — `--where`, `--host`, `--port` — to point one run somewhere else.)

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

- **Connects then immediately kicked** — the server is still running on the settings it started with.
  Restart it; Auren already wrote `online-mode=false`.
- **`Cannot find module 'mineflayer'`** — `npm install` wasn't run, or was run in the wrong folder.
- **`npm error code EBADENGINE`** — your Node is older than 22. Install the current one and run
  `npm install` again.
- **"something is already using port 3001"** — a foreman is still running from last time. Close it.
- **"Auren cannot reach your server's console"** — the server was started before `server.properties`
  last changed. Restart the server and start Auren again. Nothing launched, so there is nothing to clean up.
- **A bot says it did not start because it is not standing with you** — it was raised, it could not be
  brought to you, and it refused to plan a base somewhere you did not choose. Usually the console: see the
  line above.
- **Joins and stands still** — usually ground it cannot work: no wood in reach, or spawn-protected. It
  re-plans and gets the same answer. The trace says which, and so will I if you send it.
- **Version mismatch** — pass `--version <your server's version>` to match your server exactly. The bot
  defaults to 26.1, which is the newest protocol its client library speaks.

---

## What is in this folder

| | |
|---|---|
| `start_auren.js` | the one way in — the desk and the referee |
| `foreman_config.js` | where your server is. The only file you might need to edit |
| `developer_mode.js` | the door to the workbench, if you ever want it. Off until you say otherwise |
| `start_bot.js` | one bot on its own — what the above is built from. The referee has no script of its own: it runs inside the foreman |
| `master_core.js` | what a bot runs once it has been told who it is |
| `Thinking_fragments/` | the deciding — planners, judges, and the config you'd edit to retune it |
| `action_fragments.js/` | the doing — one file per verb |
| `perception_nodes.js/` | the sensing |
| `js_kernel/` | shared machinery: state store, trace writer, calculators |
| `custom_api/` | the layer between the bot's vocabulary and Minecraft's |
| `foreman/` | the one process outside the bots: job arbitration, the fleet's memory, and the desk you hire from |
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

**My run is your run.** I start it with the same `node start_auren.js` and the same `foreman_config.js`
you do. The foreman sets the clock, raises the cameras if the page asks for them, watches for a bot that
errors, dies or leaves, and says PASS or FAIL at the end — for both of us, because there is one way to run it.

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

---

## How this was built

AI models wrote every line of this bot under my strict Structural Laws and prompt guidance. There is no
runtime LLM.
